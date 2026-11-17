/**
 * The bridge's HTTP server (docs/design-bridge.md §5; invariants I3, I4, I5, I8, I9; decisions D1–D6 in
 * docs/implementation-plan-bridge.md). It speaks the part of the OpenAI chat-completions API that Signal uses.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ParseError, parseClassification } from '../src/classifier/parse';
import { AbortedError, TaskQueue } from '../src/classifier/queue';
import type { PostInput } from '../src/shared/types';
import { requestLine } from './log';
import { checkSignalRequest } from './request';
import { checkToken } from './token';

export type RunResult =
  | { ok: true; text: string; usage?: { input: number; output: number } }
  | { ok: false; cause: 'timeout' | 'login' | 'failed' | 'too-large' | 'aborted' | 'stopped' | 'unprepared'; detail: string };
export interface Runner { run(post: PostInput, signal: AbortSignal): Promise<RunResult> }
export interface ServerOptions {
  port: number; token: string; model: string; runner: Runner; concurrency: number; queue: number; log: (line: string) => void;
  /** Security B2: the CLI changed and is being re-checked (429, Signal waits), or failed the re-check (503). */
  state?: () => 'serving' | 'rechecking' | 'stopped';
}
export interface RunningServer { port: number; address: string; close(): Promise<void> }

export const PATH = '/v1/chat/completions';
export const MAX_BODY_BYTES = 64 * 1024;
/** Chrome extension ids are 32 letters a–p. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const TOKEN_HINT = 'Paste the token printed by the bridge into “Bridge token”.';
const RECHECKING = 'The CLI changed; the bridge is re-checking it. Signal retries automatically.';
const STOPPED = "The CLI changed and failed the bridge's checks; see the bridge's terminal.";
/** Long enough for a re-check (two CLI calls); Signal honours Retry-After up to 30 s. */
const RECHECK_RETRY_S = 15;

const FAILURE: Record<Exclude<RunResult, { ok: true }>['cause'], { status: number; what: string; message: (d: string) => string }> = {
  failed: { status: 502, what: 'CLI failed', message: (d) => `The CLI failed (${d}).` },
  login: { status: 502, what: 'not logged in', message: (d) => `The CLI is not logged in (${d}). Run it once and log in with your subscription.` },
  'too-large': { status: 502, what: 'output too large', message: (d) => `The CLI's output was too large (${d}).` },
  timeout: { status: 504, what: 'timed out', message: (d) => `The CLI did not answer in time (${d}).` },
  aborted: { status: 499, what: 'cancelled', message: () => 'Cancelled.' },
  stopped: { status: 503, what: 'stopped', message: () => STOPPED },
  unprepared: { status: 502, what: 'not prepared', message: (d) => `The CLI failed (could not prepare the CLI call (${d})).` },
};

class Reject extends Error {
  constructor(readonly status: number, message: string, readonly what: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function reply(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  // Never any Access-Control-* header (I5): a web page's preflight and reads both fail.
  const common = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers };
  if (body === undefined) {
    res.writeHead(status, common).end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { ...common, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) }).end(text);
}
const errorBody = (message: string) => ({ error: { message } });

/** Read the body, at most MAX_BODY_BYTES; beyond that, stop keeping it (the rest is drained and discarded). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on('end', () => (tooLarge ? reject(new Reject(413, `Request body over ${MAX_BODY_BYTES / 1024} KB.`, 'too large')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const queue = new TaskQueue(opts.concurrency);
  let running = 0;
  let waiting = 0; // accepted, not yet started
  let avgMs = 5000; // recent CLI call time, for Retry-After (D5)
  let port = opts.port;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  function check(req: IncomingMessage): void {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!hosts().has(host)) throw new Reject(403, 'Forbidden.', 'bad Host');
    const origin = req.headers.origin;
    if (origin !== undefined && !EXTENSION_ORIGIN.test(origin)) throw new Reject(403, 'Forbidden.', 'web origin');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    check(req);
    if (req.method === 'OPTIONS') throw new Reject(204, '', 'preflight');
    const path = (req.url ?? '').split('?')[0];
    if (path !== PATH) throw new Reject(404, 'Not found.', 'not found');
    if (req.method !== 'POST') throw new Reject(405, 'Only POST.', 'method', { allow: 'POST' });
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!checkToken(auth?.[1], opts.token)) throw new Reject(401, TOKEN_HINT, 'bad or missing token');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'application/json') throw new Reject(415, 'Content-Type must be application/json.', 'not JSON');
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new Reject(400, 'Request body is not JSON.', 'bad JSON');
    }
    const checked = checkSignalRequest(body, opts.model);
    if (!checked.ok) throw new Reject(400, checked.reason, checked.reason.startsWith('This bridge serves') ? 'wrong model' : 'not a Signal request');

    const state = opts.state?.() ?? 'serving';
    if (state === 'rechecking') throw new Reject(429, RECHECKING, 're-checking CLI', { 'retry-after': String(RECHECK_RETRY_S) });
    if (state === 'stopped') throw new Reject(503, STOPPED, 'stopped');
    if (running + waiting >= opts.concurrency + opts.queue) {
      const waitMs = (avgMs * (waiting + 1)) / opts.concurrency;
      const retry = Math.min(30, Math.max(1, Math.ceil(waitMs / 1000)));
      throw new Reject(429, `The bridge is busy (${opts.concurrency} at a time, ${opts.queue} waiting); Signal retries automatically.`, 'busy', { 'retry-after': String(retry) });
    }

    const key = randomBytes(8).toString('hex');
    let started = 0;
    waiting++;
    const job = queue.run(key, async (signal) => {
      waiting--;
      running++;
      started = Date.now();
      try {
        return await opts.runner.run(checked.post, signal);
      } finally {
        running--;
        avgMs = avgMs * 0.7 + (Date.now() - started) * 0.3;
      }
    });
    // Signal gave up (cancel all, navigation): drop the job if queued, kill the CLI if running (D4).
    res.on('close', () => {
      if (!res.writableFinished) queue.release(key);
    });
    let result: RunResult;
    try {
      result = await job;
    } catch (e) {
      if (e instanceof AbortedError) {
        waiting--; // dropped before it started
        result = { ok: false, cause: 'aborted', detail: 'client gone' };
      }
      else throw e;
    }
    const ms = Date.now() - started;
    if (!result.ok) {
      const f = FAILURE[result.cause];
      // B5: for a call the bridge could not prepare, the system error code is shown (re-checked: a code, nothing else).
      const code = /^[A-Z0-9_]{1,20}$/.test(result.detail) ? result.detail : 'error';
      if (result.cause === 'unprepared') result.detail = code;
      opts.log(requestLine({ outcome: f.status, ms, what: result.cause === 'unprepared' ? `${f.what} (${code})` : f.what, queue: waiting }));
      if (result.cause === 'aborted') res.destroy();
      else reply(res, f.status, errorBody(f.message(result.detail)));
      return;
    }
    let content: string;
    try {
      // D1: only the validated classification goes back, re-serialised; nothing else the CLI wrote.
      content = JSON.stringify(parseClassification(result.text));
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      opts.log(requestLine({ outcome: 502, ms, what: 'no classification', queue: waiting }));
      reply(res, 502, errorBody("The CLI's answer was not a classification."));
      return;
    }
    opts.log(requestLine({ outcome: 'ok', ms, ...(result.usage ? { usage: result.usage } : {}), queue: waiting }));
    reply(res, 200, {
      id: `chatcmpl-bridge-${randomBytes(8).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: opts.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      ...(result.usage ? { usage: { prompt_tokens: result.usage.input, completion_tokens: result.usage.output, total_tokens: result.usage.input + result.usage.output } } : {}),
    });
  }

  const server = createServer({ requireHostHeader: false }, (req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof Reject) {
        if (e.status !== 204) opts.log(requestLine({ outcome: e.status, what: e.what }));
        // Drain whatever is left of the body so the client reads the answer (bounded: nothing is kept).
        req.resume();
        reply(res, e.status, e.status === 204 ? undefined : errorBody(e.message), e.headers);
      } else {
        opts.log(requestLine({ outcome: 500, what: 'internal error' }));
        reply(res, 500, errorBody('Internal error.'));
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000; // receiving the request; the CLI's own timeout is separate

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  return {
    port,
    address: address.address,
    close: () =>
      new Promise<void>((resolve) => {
        queue.cancelAll();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
