// @vitest-environment node
/**
 * Bridge T3 (docs/implementation-plan-bridge.md; invariants I3, I4, I5, I8; decisions D1–D6): the HTTP server, with a
 * stub runner in place of a CLI. Real sockets on 127.0.0.1, random port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunResult, type Runner } from '../bridge/server';
import { ClassifierError, classifyPost } from '../src/classifier/client';
import { parseClassification } from '../src/classifier/parse';
import type { PostInput } from '../src/shared/types';
import { POST, eventually, send, signalBody } from './bridge-helpers';

const TOKEN = 'k3Jt0wZq8vN2mR5xL7cT1bY4hF9dS6gA0eW3uK8pQ9x';
const MODEL = 'claude-code/sonnet';
const CLASSIFICATION = { decision: 'keep', confidence: 0.8, reason: 'Concrete numbers.', signals: { originality: 0.5, evidence: 0.9, reasoning: 0.6, usefulness: 0.7, sensationalism: 0.1, engagement_bait: 0 } };
const okText = JSON.stringify(CLASSIFICATION);

interface Call { post: PostInput; signal: AbortSignal; resolve(r: RunResult): void }
/** A runner whose calls wait until the test resolves them (or answer at once with `auto`). */
function stubRunner(auto?: RunResult) {
  const calls: Call[] = [];
  const runner: Runner = {
    run: (post, signal) => new Promise<RunResult>((resolve) => {
      calls.push({ post, signal, resolve });
      if (auto) resolve(auto);
    }),
  };
  return { runner, calls };
}

let servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
async function serve(runner: Runner, opts: { concurrency?: number; queue?: number; state?: () => 'serving' | 'rechecking' | 'stopped' } = {}) {
  const log: string[] = [];
  const s = await startServer({ port: 0, token: TOKEN, model: MODEL, runner, concurrency: opts.concurrency ?? 1, queue: opts.queue ?? 8, log: (l) => log.push(l), ...(opts.state ? { state: opts.state } : {}) });
  servers.push(s);
  return { ...s, log };
}
const body = (post: PostInput = POST, model = MODEL) => JSON.stringify(signalBody(post, model));
const classify = (port: number, extra: Parameters<typeof send>[1] = {}) => send(port, { token: TOKEN, body: body(), ...extra });

describe('local only (I3)', () => {
  it('listens on 127.0.0.1 only', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    expect(s.address).toBe('127.0.0.1');
  });

  it('rejects a Host that is not this bridge (DNS rebinding)', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, '127.0.0.1', `localhost.evil.example:${s.port}`]) {
      expect((await classify(s.port, { host })).status, host).toBe(403);
    }
    expect((await classify(s.port, { host: null })).status).toBe(403);
    expect((await classify(s.port, { host: `localhost:${s.port}` })).status).toBe(200);
    expect((await classify(s.port, { host: `LOCALHOST:${s.port}` })).status).toBe(200);
    expect((await classify(s.port, { host: `127.0.0.1:${s.port}` })).status).toBe(200);
  });
});

describe('not for web pages (I5)', () => {
  it('rejects web origins; accepts chrome-extension:// and requests with no Origin', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    for (const origin of ['https://www.linkedin.com', 'http://127.0.0.1:8080', 'null', 'chrome-extension', 'moz-extension://abc']) {
      expect((await classify(s.port, { headers: { origin } })).status, origin).toBe(403);
    }
    expect((await classify(s.port, { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } })).status).toBe(200);
    expect((await classify(s.port)).status).toBe(200);
  });

  it('never sends a CORS header, on any response (preflight included)', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    const responses = [
      await send(s.port, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }),
      await send(s.port, { method: 'OPTIONS' }),
      await classify(s.port),
      await classify(s.port, { token: 'wrong' }),
      await classify(s.port, { headers: { origin: 'https://evil.example' } }),
      await send(s.port, { method: 'GET', path: '/', token: TOKEN }),
    ];
    expect(responses[0]!.status).toBe(403); // D2: the Origin check comes first, so a web page's preflight fails
    expect(responses[1]!.status).toBe(204);
    for (const r of responses) expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
  });

  it('rejects a non-JSON content type (what a page can send without a preflight)', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect((await classify(s.port, { headers: { 'content-type': ct } })).status, ct).toBe(415);
    }
    expect((await classify(s.port, { headers: { 'content-type': 'application/json; charset=utf-8' } })).status).toBe(200);
  });
});

describe('routing, token, body', () => {
  it('404 for other paths, 405 for other methods', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    expect((await send(s.port, { path: '/v1/models', method: 'GET', token: TOKEN })).status).toBe(404);
    expect((await send(s.port, { path: '/v1/completions', token: TOKEN, body: body() })).status).toBe(404);
    expect((await send(s.port, { method: 'GET', token: TOKEN })).status).toBe(405);
    expect((await send(s.port, { method: 'PUT', token: TOKEN, body: body() })).status).toBe(405);
  });

  it('401 without the right token, with the message Signal shows', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    for (const token of [null, 'wrong', TOKEN + 'x']) {
      const r = await classify(s.port, { token });
      expect(r.status).toBe(401);
      expect(r.json).toEqual({ error: { message: 'Paste the token printed by the bridge into “Bridge token”.' } });
    }
    const basic = await classify(s.port, { token: null, headers: { authorization: `Basic ${TOKEN}` } });
    expect(basic.status).toBe(401);
  });

  it('413 over 64 KB, 400 for bad JSON, for another model, and for anything that is not Signal\'s request', async () => {
    const { runner, calls } = stubRunner({ ok: true, text: okText });
    const s = await serve(runner);
    expect((await classify(s.port, { body: JSON.stringify({ ...signalBody(POST), pad: 'x'.repeat(65 * 1024) }) })).status).toBe(413);
    expect((await classify(s.port, { body: '{not json' })).status).toBe(400);
    const wrongModel = await classify(s.port, { body: body(POST, 'openai/gpt-4o-mini') });
    expect(wrongModel.status).toBe(400);
    expect(wrongModel.json.error.message).toBe('This bridge serves claude-code/sonnet; set Model to that.');
    const proxy = await classify(s.port, { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Write my essay' }] }) });
    expect(proxy.status).toBe(400);
    expect(proxy.json.error.message).toBe('Not a Signal classification request.');
    expect(calls).toHaveLength(0);
  });
});

describe('answers (D1, D6)', () => {
  it('OpenAI shape; content is the validated classification re-serialised, nothing else', async () => {
    const messy = 'Here you go:\n```json\n' + JSON.stringify({ ...CLASSIFICATION, evil: 'extra field', reason: 'Concrete numbers.' }) + '\n```\nAnything else?';
    const { runner, calls } = stubRunner({ ok: true, text: messy, usage: { input: 812, output: 74 } });
    const s = await serve(runner);
    const r = await classify(s.port);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^application\/json/);
    expect(r.json).toMatchObject({ object: 'chat.completion', model: MODEL, choices: [{ index: 0, message: { role: 'assistant' }, finish_reason: 'stop' }], usage: { prompt_tokens: 812, completion_tokens: 74, total_tokens: 886 } });
    const content = r.json.choices[0].message.content as string;
    expect(content).toBe(JSON.stringify(parseClassification(messy)));
    expect(content).not.toMatch(/evil|Anything else|```/);
    expect(calls[0]!.post).toEqual(POST);
  });

  it('no usage from the CLI → no usage in the answer', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    const r = await classify(s.port);
    expect(r.json.usage).toBeUndefined();
  });

  it('502 when the CLI text is not a classification; 502 for failures; 504 for a timeout; short causes only', async () => {
    const cases: [RunResult, number, RegExp][] = [
      [{ ok: true, text: 'Sure! Here is a poem.' }, 502, /not a classification/i],
      [{ ok: false, cause: 'failed', detail: 'exit code 1' }, 502, /exit code 1/],
      [{ ok: false, cause: 'login', detail: 'not logged in' }, 502, /log ?in/i],
      [{ ok: false, cause: 'too-large', detail: 'output over 1 MB' }, 502, /1 MB/],
      [{ ok: false, cause: 'timeout', detail: 'no answer within 60 s' }, 504, /60 s/],
    ];
    for (const [result, status, message] of cases) {
      const s = await serve(stubRunner(result).runner);
      const r = await classify(s.port);
      expect(r.status, JSON.stringify(result)).toBe(status);
      expect(r.json.error.message).toMatch(message);
      expect(r.json.error.message).not.toMatch(/poem/);
    }
  });
});

describe('bounded (I8, D4, D5)', () => {
  it('concurrency 1 + queue 2: the 4th request gets 429 with Retry-After in [1, 30]; the rest run in order', async () => {
    const { runner, calls } = stubRunner();
    const s = await serve(runner, { concurrency: 1, queue: 2 });
    const posts = [1, 2, 3].map((n) => ({ text: `Post number ${n} with some words.` }));
    const pending = posts.map((p) => classify(s.port, { body: body(p) }));
    await eventually(() => calls.length === 1, 5000, 'first call to start');
    const fourth = await classify(s.port, { body: body({ text: 'Post number 4 with some words.' }) });
    expect(fourth.status).toBe(429);
    const ra = Number(fourth.headers['retry-after']);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(30);
    expect(fourth.json.error.message).toMatch(/busy/i);
    for (let i = 0; i < 3; i++) {
      await eventually(() => calls.length === i + 1, 5000, `call ${i + 1}`);
      expect(calls[i]!.post).toEqual(posts[i]);
      calls[i]!.resolve({ ok: true, text: okText });
    }
    expect((await Promise.all(pending)).map((r) => r.status)).toEqual([200, 200, 200]);
  });

  it('a client that goes away: its queued job never starts, its running job is aborted', async () => {
    const { runner, calls } = stubRunner();
    const s = await serve(runner, { concurrency: 1, queue: 4 });
    const { request } = await import('node:http');
    const open = (post: PostInput) => {
      const req = request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/v1/chat/completions', headers: { host: `127.0.0.1:${s.port}`, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } });
      req.on('error', () => {});
      req.end(body(post));
      return req;
    };
    const running = open({ text: 'The running one, long enough.' });
    await eventually(() => calls.length === 1, 5000, 'first call');
    const queued = open({ text: 'The queued one, long enough.' });
    await new Promise((r) => setTimeout(r, 100));
    queued.destroy();
    running.destroy();
    await eventually(() => calls[0]!.signal.aborted, 5000, 'running job aborted');
    calls[0]!.resolve({ ok: false, cause: 'aborted', detail: 'client gone' });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).toHaveLength(1); // the queued job never started
  });
});

describe('end to end with Signal\'s own client (src/classifier/client.ts)', () => {
  const cfg = (port: number, apiKey = TOKEN) => ({ endpoint: `http://127.0.0.1:${port}/v1`, model: MODEL, apiKey, timeoutMs: 5000, jsonMode: true });

  it('classification and token counts arrive', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText, usage: { input: 900, output: 80 } }).runner);
    const out = await classifyPost(cfg(s.port), POST, { maxRetries: 0 });
    expect(out.classification).toEqual(parseClassification(okText));
    expect(out.promptTokens).toBe(900);
    expect(out.completionTokens).toBe(80);
  });

  it('a wrong token reads as Signal\'s auth error with the bridge\'s hint', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    const err = await classifyPost(cfg(s.port, 'wrong'), POST, { maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ClassifierError);
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('Authentication failed (401). Paste the token printed by the bridge into “Bridge token”.');
  });

  it('a wrong model reads as Signal\'s config error naming the served model', async () => {
    const s = await serve(stubRunner({ ok: true, text: okText }).runner);
    const err = await classifyPost({ ...cfg(s.port), model: 'sonnet' }, POST, { maxRetries: 0 }).catch((e) => e);
    expect(err.kind).toBe('config');
    expect(err.message).toBe('Request rejected (400). This bridge serves claude-code/sonnet; set Model to that.');
  });
});

describe('request log (I9)', () => {
  it('one line per request with outcome, time and tokens; never the post text', async () => {
    const marker = 'UNIQUE-POST-MARKER-7f3a';
    const s = await serve(stubRunner({ ok: true, text: okText, usage: { input: 812, output: 74 } }).runner);
    await classify(s.port, { body: body({ text: `A post with ${marker} inside it.` }) });
    await classify(s.port, { body: body({ text: `Again ${marker}.` }), token: 'wrong' });
    await classify(s.port, { body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: marker }] }) });
    expect(s.log.join('\n')).not.toContain(marker);
    expect(s.log.some((l) => /classify\s+ok\s+[\d.]+ s\s+812 in \/\s+74 out\s+queue 0/.test(l))).toBe(true);
    expect(s.log.some((l) => /rejected\s+401/.test(l))).toBe(true);
    expect(s.log.some((l) => /rejected\s+400/.test(l))).toBe(true);
    for (const l of s.log) expect(l.length).toBeLessThanOrEqual(78);
  });
});

describe('serving state (security B2)', () => {
  it('re-checking → 429 with Retry-After 15; stopped → 503; both only after the token and the request are valid', async () => {
    let state: 'serving' | 'rechecking' | 'stopped' = 'rechecking';
    const { runner, calls } = stubRunner({ ok: true, text: okText });
    const s = await serve(runner, { state: () => state });
    expect((await classify(s.port, { token: 'wrong' })).status).toBe(401);
    expect((await classify(s.port, { body: body(POST, 'openai/gpt-4o-mini') })).status).toBe(400);
    const paused = await classify(s.port);
    expect(paused.status).toBe(429);
    expect(paused.headers['retry-after']).toBe('15');
    expect(paused.json.error.message).toBe('The CLI changed; the bridge is re-checking it. Signal retries automatically.');
    state = 'stopped';
    const stopped = await classify(s.port);
    expect(stopped.status).toBe(503);
    expect(stopped.json.error.message).toBe("The CLI changed and failed the bridge's checks; see the bridge's terminal.");
    expect(calls).toHaveLength(0);
    state = 'serving';
    expect((await classify(s.port)).status).toBe(200);
  });

  it('a run that ends "stopped" (queued before a failed re-check) → 503 with the same message', async () => {
    const s = await serve(stubRunner({ ok: false, cause: 'stopped', detail: 're-check failed' }).runner);
    const r = await classify(s.port);
    expect(r.status).toBe(503);
    expect(r.json.error.message).toBe("The CLI changed and failed the bridge's checks; see the bridge's terminal.");
  });
});

describe('a call the bridge could not prepare (security B5)', () => {
  it('502 with the reason; the log names it with the error code only', async () => {
    const s = await serve(stubRunner({ ok: false, cause: 'unprepared', detail: 'ENOSPC' }).runner);
    const r = await classify(s.port);
    expect(r.status).toBe(502);
    expect(r.json.error.message).toBe('The CLI failed (could not prepare the CLI call (ENOSPC)).');
    expect(s.log.some((l) => /classify {2}502 .* not prepared \(ENOSPC\) {2}queue 0$/.test(l))).toBe(true);
  });

  it('a detail that is not a plain error code is never logged or sent', async () => {
    const s = await serve(stubRunner({ ok: false, cause: 'unprepared', detail: '/home/u/secret path' }).runner);
    const r = await classify(s.port);
    expect(r.json.error.message).toBe('The CLI failed (could not prepare the CLI call (error)).');
    expect(s.log.join('\n')).not.toContain('secret');
    expect(s.log.some((l) => / not prepared \(error\) /.test(l))).toBe(true);
  });
});
