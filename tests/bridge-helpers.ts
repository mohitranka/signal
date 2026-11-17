/**
 * Helpers for the bridge tests (docs/implementation-plan-bridge.md): fake CLIs on PATH, Signal's exact request body,
 * and raw HTTP requests (Host and Origin must be settable, which fetch forbids).
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildMessages } from '../src/classifier/prompt';
import type { PostInput } from '../src/shared/types';

export interface FakeBehaviour {
  mode?: 'ok' | 'not-logged-in' | 'exit1' | 'garbage' | 'empty' | 'not-a-classification' | 'huge-stdout' | 'huge-stderr' | 'grandchild' | 'slow';
  tools?: 'off' | 'read' | 'list' | 'read-all' | 'write';
  helpMissing?: string[];
  version?: string;
  decision?: 'keep' | 'collapse' | 'highlight';
  reason?: string;
  marker?: string;
  echoStderr?: boolean;
  delayMs?: number;
  codexShape?: 'new' | 'old';
  /** Security B3: keep what the CLI received (see tests/fixtures/fake-cli.cjs). */
  persist?: 'claude-project' | 'claude-elsewhere' | 'codex-session' | 'codex-history';
}

export interface FakeCall {
  name: string;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  files: string[];
  pid: number;
}

export interface Fakes {
  dir: string;
  /** PATH with the fakes first. */
  PATH: string;
  set(b: FakeBehaviour): void;
  calls(): FakeCall[];
  grandchildren(): number[];
  cleanup(): void;
}

export function installFakes(behaviour: FakeBehaviour = {}): Fakes {
  const dir = mkdtempSync(join(tmpdir(), 'signal-fake-cli-'));
  for (const name of ['claude', 'codex']) {
    copyFileSync('tests/fixtures/fake-cli.cjs', join(dir, name));
    chmodSync(join(dir, name), 0o755);
  }
  const set = (b: FakeBehaviour) => writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(b));
  set(behaviour);
  const lines = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean) : []);
  return {
    dir,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    set,
    calls: () => lines('calls.jsonl').map((l) => JSON.parse(l) as FakeCall),
    grandchildren: () => lines('grandchildren.txt').map(Number),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** True while a process with this pid exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The body Signal's client sends (src/classifier/client.ts), for a post already in Signal's normalised form. */
export function signalBody(post: PostInput, model = 'claude-code/sonnet', jsonMode = true): Record<string, unknown> {
  return {
    model,
    messages: buildMessages(post),
    temperature: 0,
    max_tokens: 600,
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
  };
}

export const POST: PostInput = { text: 'We cut p99 latency from 180 ms to 95 ms by removing an N+1 query. Here is how we measured it.' };

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: any;
}

/** One HTTP request with full control over headers. Defaults: Signal's request, right Host, no Origin. */
export function send(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; token?: string | null; host?: string | null } = {},
): Promise<RawResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.host !== null) headers.host = opts.host ?? `127.0.0.1:${port}`;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method ?? 'POST', path: opts.path ?? '/v1/chat/completions', headers, setHost: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Wait until `check` is true (polling), or fail after `ms`. */
export async function eventually(check: () => boolean, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
