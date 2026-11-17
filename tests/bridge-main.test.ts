// @vitest-environment node
/**
 * Bridge T5 (terminal output, I9) and T6 (entry point, arguments, npm script, smoke test), and the T8 README check.
 * docs/implementation-plan-bridge.md.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../bridge/config';
import { startBridge, type BridgeIO } from '../bridge/main';
import { fitLine } from '../bridge/log';
import { selfTest } from '../bridge/selftest';
import { POST, eventually, installFakes, send, signalBody, type FakeBehaviour, type Fakes } from './bridge-helpers';

describe('arguments (D7)', () => {
  it('defaults: claude, sonnet, port 8791, 1 at a time, queue 8, 60 s', () => {
    expect(parseArgs(['--cli', 'claude'])).toEqual({ ok: true, config: { cli: 'claude', model: 'sonnet', port: 8791, concurrency: 1, queue: 8, timeoutS: 60, newToken: false, keepSessionFiles: false } });
  });

  it('all options, both spellings (--x v and --x=v)', () => {
    expect(parseArgs(['--cli=codex', '--model', 'gpt-5', '--port=9000', '--concurrency', '2', '--queue', '16', '--timeout', '120', '--new-token'])).toEqual({ ok: true, config: { cli: 'codex', model: 'gpt-5', port: 9000, concurrency: 2, queue: 16, timeoutS: 120, newToken: true, keepSessionFiles: false } });
    expect(parseArgs(['--cli', 'claude', '--port', '0'])).toMatchObject({ ok: true, config: { port: 0 } }); // any free port (tests)
    expect(parseArgs(['--cli', 'codex', '--model', 'gpt-5', '--keep-session-files'])).toMatchObject({ ok: true, config: { keepSessionFiles: true } }); // security B3
    expect(parseArgs(['--cli', 'claude', '--keep-session-files=yes'])).toMatchObject({ ok: false });
  });

  it('rejects: no --cli, another CLI, codex without --model, out-of-range numbers, bad model names, unknown flags', () => {
    const bad: string[][] = [
      [], ['--cli', 'gemini'], ['--cli', 'codex'], ['--cli', 'claude', '--port', '70000'], ['--cli', 'claude', '--port', 'x'],
      ['--cli', 'claude', '--concurrency', '0'], ['--cli', 'claude', '--concurrency', '5'], ['--cli', 'claude', '--queue', '65'], ['--cli', 'claude', '--queue', '-1'],
      ['--cli', 'claude', '--timeout', '4'], ['--cli', 'claude', '--timeout', '301'], ['--cli', 'claude', '--timeout', '1.5'],
      ['--cli', 'claude', '--model', ''], ['--cli', 'claude', '--model', 'a b'], ['--cli', 'claude', '--model', '$(id)'], ['--cli', 'claude', '--model', '-p'],
      ['--cli', 'claude', '--model', 'x'.repeat(65)], ['--cli', 'claude', '--model', 'sonnet\u202e'], ['--cli', 'claude', '--verbose'], ['--cli', 'claude', 'extra'],
    ];
    for (const argv of bad) {
      const r = parseArgs(argv);
      expect(r.ok, argv.join(' ')).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/usage: npm run bridge -- --cli claude\|codex/i);
    }
    expect(parseArgs(['--cli', 'claude', '--model', 'claude-sonnet-4-5-20250929'])).toMatchObject({ ok: true });
    expect(parseArgs(['--cli', 'claude', '--model', 'opus[1m]'])).toMatchObject({ ok: true });
  });
});

let fakes: Fakes;
let home = '';
let stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  fakes = installFakes();
  home = mkdtempSync(join(tmpdir(), 'signal-bridge-home-'));
});
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
  fakes.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function start(argv: string[], b: FakeBehaviour = {}, env: Record<string, string> = {}, hooks: Pick<BridgeIO, 'selfTest'> = {}) {
  fakes.set(b);
  const lines: string[] = [];
  const r = await startBridge(argv.includes('--port') ? argv : ['--port', '0', ...argv], { env: { ...process.env, PATH: fakes.PATH, XDG_CONFIG_HOME: join(home, 'cfg'), HOME: home, ...env }, out: (l) => lines.push(l), ...hooks });
  if (r.ok) stops.push(r.stop);
  return { r, lines, text: () => lines.join('\n') };
}
const tokenFrom = (text: string) => /Bridge token {2}([A-Za-z0-9_-]{43})/.exec(text)?.[1];

describe('start-up output (T5, mockup terminal)', () => {
  it('a passing start prints the self-test, where it listens, the model id and limits, and the token once', async () => {
    const { r, lines, text } = await start(['--cli', 'claude']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(lines[0]).toBe('Signal bridge · local CLI bridge · classification only');
    expect(text()).toContain(`Listening on http://127.0.0.1:${r.port}/v1`);
    expect(text()).toMatch(/^ {2}model {4}claude-code\/sonnet$/m);
    expect(text()).toMatch(/^ {2}limits {3}1 at a time · queue 8 · timeout 60 s$/m);
    expect(text()).toContain('In Signal → Model, choose “Local CLI bridge”, then set:');
    expect(tokenFrom(text())).toBeDefined();
    expect(text()).toContain('(shown once; kept in ~/cfg/signal-bridge/token, only you can read it)');
    expect(text()).toContain('Logs never contain post text. Ctrl-C to stop.');
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(78);
  });

  it('later starts do not print the token again, only where it is kept; --new-token prints the new one', async () => {
    const first = await start(['--cli', 'claude']);
    const token = tokenFrom(first.text())!;
    await stops.pop()!();
    const second = await start(['--cli', 'claude']);
    expect(second.text()).not.toContain(token);
    expect(tokenFrom(second.text())).toBeUndefined();
    expect(second.text()).toContain('Bridge token  (saved in ~/cfg/signal-bridge/token)');
    await stops.pop()!();
    const third = await start(['--cli', 'claude', '--new-token']);
    const rotated = tokenFrom(third.text());
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(token);
  });

  it('a failed self-test: does not listen, exit code 1', async () => {
    const { r, text } = await start(['--cli', 'codex', '--model', 'gpt-5'], { tools: 'read' });
    expect(r).toEqual({ ok: false, code: 1 });
    expect(text()).toMatch(/FAILED/);
    expect(text()).not.toMatch(/Listening on/);
  });

  it('CLI not on PATH: says so, exit code 1', async () => {
    fakes.set({});
    const lines: string[] = [];
    const r = await startBridge(['--cli', 'claude', '--port', '0'], { env: { PATH: home, HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') }, out: (l) => lines.push(l) });
    expect(r).toEqual({ ok: false, code: 1 });
    expect(lines.join('\n')).toMatch(/claude \.+ not found/);
  });

  it('bad arguments: usage, exit code 2', async () => {
    const lines: string[] = [];
    expect(await startBridge(['--cli', 'gemini'], { env: {}, out: (l) => lines.push(l) })).toEqual({ ok: false, code: 2 });
    expect(lines.join('\n')).toMatch(/usage/i);
  });

  it('port already in use: says so, exit code 1', async () => {
    const a = await start(['--cli', 'claude']);
    if (!a.r.ok) throw new Error('first start failed');
    const b = await start(['--cli', 'claude', '--port', String(a.r.port)]);
    expect(b.r).toEqual({ ok: false, code: 1 });
    expect(b.text()).toMatch(new RegExp(`Port ${a.r.port} is in use`));
  });
});

describe('logs never contain post text (I9)', () => {
  it('served requests, a failing CLI and a timing-out CLI: the post marker appears nowhere in the output', async () => {
    const marker = 'PRIVATE-POST-MARKER-91c2';
    const { r, text } = await start(['--cli', 'claude', '--timeout', '5']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    const post = { text: `My private post ${marker} with enough words in it.` };
    const req = () => send(r.port, { token, body: JSON.stringify(signalBody(post)) });
    fakes.set({ echoStderr: true, marker });
    expect((await req()).status).toBe(200);
    fakes.set({ echoStderr: true, mode: 'exit1' });
    expect((await req()).status).toBe(502);
    fakes.set({ echoStderr: true, mode: 'garbage' });
    expect((await req()).status).toBe(502);
    fakes.set({ echoStderr: true, mode: 'slow' });
    expect((await req()).status).toBe(504);
    expect(text()).not.toContain(marker);
    expect(text()).not.toContain('private post');
  }, 20_000);
});

describe('npm run bridge (T6 smoke test)', () => {
  it('package.json has the script, built the same way as eval and check-lock', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts.bridge).toBe('esbuild bridge/main.ts --bundle --platform=node --format=esm --outfile=.eval-build/bridge.mjs --log-level=warning && node .eval-build/bridge.mjs');
    expect(JSON.parse(readFileSync('tsconfig.json', 'utf8')).include).toContain('bridge');
  });

  it('the built bundle starts, serves one classification, and exits 0 on Ctrl-C leaving no temp folders', async () => {
    const out = join(home, 'bridge.mjs');
    await build({ entryPoints: ['bridge/main.ts'], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' });
    const child = spawn(process.execPath, [out, '--cli', 'claude', '--port', '0'], { env: { PATH: fakes.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    const exited = new Promise<number | null>((res) => child.on('exit', (code) => res(code)));
    try {
      await eventually(() => /Listening on http:\/\/127\.0\.0\.1:\d+\/v1/.test(stdout) && stdout.includes('Ctrl-C to stop'), 15_000, 'bridge to listen');
      const port = Number(/127\.0\.0\.1:(\d+)\/v1/.exec(stdout)![1]);
      const res = await send(port, { token: tokenFrom(stdout)!, body: JSON.stringify(signalBody(POST)) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.json.choices[0].message.content).decision).toBe('keep');
    } finally {
      child.kill('SIGINT');
    }
    expect(await exited).toBe(0);
    for (const c of fakes.calls()) expect(existsSync(c.cwd), c.cwd).toBe(false);
  }, 30_000);
});

describe('README (T8)', () => {
  it('documents the start command, the terms-of-service note and the limits', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toContain('npm run bridge -- --cli claude');
    expect(readme).toMatch(/terms/i);
    expect(readme).toMatch(/canary/i);
    expect(readme).toMatch(/Windows/);
  });
});

describe('which CLI runs (security B1)', () => {
  const npmFolder = () => {
    const bin = join(home, 'parent', 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync('tests/fixtures/fake-cli.cjs', join(bin, 'claude'));
    chmodSync(join(bin, 'claude'), 0o755);
    return bin;
  };

  it('a claude in an npm folder is ignored with a note; yours is used', async () => {
    const bin = npmFolder();
    const { r, lines } = await start(['--cli', 'claude'], {}, { PATH: `${bin}:${fakes.PATH}` });
    expect(r.ok).toBe(true);
    const note = lines.findIndex((l) => l.startsWith('  note: ignored '));
    expect(lines[note]).toBe('  note: ignored ~/parent/node_modules/.bin/claude (npm folder)');
    expect(lines[note + 1]).toMatch(/^ {2}claude 2\.1\.4 \.+ found$/);
    expect(lines[note + 2]).toBe(fitLine('    ', join(fakes.dir, 'claude'))); // shortened from the left if the temp folder is long (macOS)
  });

  it('only an npm-folder claude: the note, "not found", why, exit 1', async () => {
    const bin = npmFolder();
    const { r, lines } = await start(['--cli', 'claude'], {}, { PATH: bin });
    expect(r).toEqual({ ok: false, code: 1 });
    expect(lines.slice(1)).toEqual([
      '  note: ignored ~/parent/node_modules/.bin/claude (npm folder)',
      '  claude ............................. not found',
      'Not starting. Install Claude Code, or put claude on PATH.',
      "(npm's node_modules/.bin folders are not searched, on purpose.)",
    ]);
  });
});

describe('the CLI changes while the bridge runs (security B2)', () => {
  const changeCli = () => appendFileSync(join(fakes.dir, 'claude'), '\n// updated\n');
  const classifyReq = (port: number, token: string) => send(port, { token, body: JSON.stringify(signalBody(POST)) });

  it('no change: no re-check, however many requests', async () => {
    const { r, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    for (let i = 0; i < 3; i++) expect((await classifyReq(r.port, token)).status).toBe(200);
    expect(fakes.calls()).toHaveLength(2 + 3); // the self-test's two, then one per request
    expect(text()).not.toMatch(/changed/);
  });

  it('a change: one re-check (new requests meanwhile get 429, Retry-After 15), then serving resumes', async () => {
    const { r, lines, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    changeCli();
    fakes.set({ version: '2.1.5', delayMs: 600 }); // a slower re-check, so a request can arrive during it
    const first = classifyReq(r.port, token); // notices the change, waits for the re-check, then runs
    await eventually(() => /claude changed \(update\?\) · pausing, re-checking/.test(text()), 5000, 're-check to start');
    const during = await classifyReq(r.port, token);
    expect(during.status).toBe(429);
    expect(during.headers['retry-after']).toBe('15');
    expect(during.json.error.message).toBe('The CLI changed; the bridge is re-checking it. Signal retries automatically.');
    expect((await first).status).toBe(200);
    expect(text()).toMatch(/^\d\d:\d\d:\d\d {2}re-check passed · serving with claude 2\.1\.5$/m);
    const start2 = lines.findIndex((l) => /claude changed/.test(l));
    // The start-up checks follow (request log lines from the same moment may interleave, e.g. the 429 above).
    expect(lines.slice(start2 + 1).find((l) => / found$/.test(l))).toMatch(/^ {2}claude 2\.1\.5 \.+ found$/);
    expect(fakes.calls()).toHaveLength(2 + 2 + 1); // start, re-check, the first request
    expect((await classifyReq(r.port, token)).status).toBe(200); // no second re-check
    expect(fakes.calls()).toHaveLength(6);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(78);
  }, 20_000);

  it('a change that fails the re-check: stops serving; later requests get 503 and never reach the CLI', async () => {
    const { r, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    changeCli();
    fakes.set({ version: '2.2.0', helpMissing: ['--tools'] });
    const first = await classifyReq(r.port, token);
    expect(first.status).toBe(503);
    expect(first.json.error.message).toBe("The CLI changed and failed the bridge's checks; see the bridge's terminal.");
    expect(text()).toMatch(/^ {2}required flags \.+ missing --tools$/m);
    expect(text()).toMatch(/^\d\d:\d\d:\d\d {2}re-check failed · not serving any more$/m);
    expect(text()).toContain('Stopped serving. The new claude did not pass the checks above.');
    expect(text()).toContain('Requests get 503. Fix the cause, then restart the bridge (Ctrl-C).');
    const calls = fakes.calls().length;
    fakes.set({});
    expect((await classifyReq(r.port, token)).status).toBe(503);
    expect(fakes.calls()).toHaveLength(calls);
  }, 20_000);
});

describe('post text kept by the CLI (security B3)', () => {
  it('--keep-session-files: the "kept" line appears on every start', async () => {
    for (let i = 0; i < 2; i++) {
      const { r, text } = await start(['--cli', 'codex', '--model', 'gpt-5', '--keep-session-files'], { persist: 'codex-history' });
      expect(r.ok).toBe(true);
      expect(text()).toContain('  post text not kept on disk ......... kept (--keep-session-files)');
      if (r.ok) await stops.pop()!();
    }
  });

  it('without it: refused, exit 1', async () => {
    const { r, text } = await start(['--cli', 'codex', '--model', 'gpt-5'], { persist: 'codex-history' });
    expect(r).toEqual({ ok: false, code: 1 });
    expect(text()).toContain('start with --keep-session-files.');
  });

  it('a B2 re-check runs the check again', async () => {
    const { r, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    appendFileSync(join(fakes.dir, 'claude'), '\n// updated\n');
    expect((await send(r.port, { token, body: JSON.stringify(signalBody(POST)) })).status).toBe(200);
    expect(text().match(/post text not kept on disk \.+ ok/g)).toHaveLength(2);
  }, 20_000);
});

describe('a failed request does not crash the bridge (security B5)', () => {
  const realTmp = process.env.TMPDIR;
  afterEach(() => {
    if (realTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmp;
  });
  /** Temporary folders become impossible to create (as with a full disk or a removed /tmp). */
  const breakTmp = () => {
    process.env.TMPDIR = join(home, 'no-such-tmp');
  };
  const fixTmp = () => {
    if (realTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = realTmp;
  };
  const classifyReq = (port: number, token: string) => send(port, { token, body: JSON.stringify(signalBody(POST)) });
  const STOPPED = ['Stopped serving. The new claude did not pass the checks above.', 'Requests get 503. Fix the cause, then restart the bridge (Ctrl-C).'];

  it('the step-8 reproduction: 502 with the reason, no unhandled rejection, and the bridge keeps serving', async () => {
    const unhandled: unknown[] = [];
    const count = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', count);
    try {
      const { r, lines, text } = await start(['--cli', 'claude']);
      if (!r.ok) throw new Error('start failed');
      const token = tokenFrom(text())!;
      breakTmp();
      const failed = await classifyReq(r.port, token);
      expect(failed.status).toBe(502);
      expect(failed.json.error.message).toBe('The CLI failed (could not prepare the CLI call (ENOENT)).');
      await new Promise((res) => setTimeout(res, 100)); // give an unhandled rejection time to surface
      expect(unhandled).toEqual([]);
      expect(lines.some((l) => /^\d\d:\d\d:\d\d {2}classify {2}502 +[\d.]+ s {2}not prepared \(ENOENT\) {2}queue 0$/.test(l))).toBe(true);
      fixTmp();
      expect((await classifyReq(r.port, token)).status).toBe(200);
    } finally {
      process.off('unhandledRejection', count);
    }
  });

  it('start with no usable temporary folder: the banner and one sentence, exit 1', async () => {
    breakTmp();
    const { r, lines } = await start(['--cli', 'claude']);
    expect(r).toEqual({ ok: false, code: 1 });
    expect(lines).toEqual(['Signal bridge · local CLI bridge · classification only', 'Not starting. Could not prepare a temporary folder (ENOENT).']);
  });

  it('a re-check with no usable temporary folder: 503 and the reason, in the mockup\'s order', async () => {
    const { r, lines, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    const token = tokenFrom(text())!;
    appendFileSync(join(fakes.dir, 'claude'), '\n// updated\n');
    breakTmp();
    expect((await classifyReq(r.port, token)).status).toBe(503);
    const from = lines.findIndex((l) => /claude changed \(update\?\) · pausing, re-checking$/.test(l));
    const after = lines.slice(from + 1).filter((l) => !/ classify | rejected /.test(l));
    expect(after[0]).toMatch(/^\d\d:\d\d:\d\d {2}re-check failed · not serving any more$/);
    expect(after.slice(1, 4)).toEqual(['  could not prepare a temporary folder (ENOENT)', ...STOPPED]);
    fixTmp();
    expect((await classifyReq(r.port, token)).status).toBe(503); // stays stopped until a restart
  });

  it('a check that throws: at start a sentence and exit 1; during a re-check the bridge stops serving', async () => {
    const boom = () => { throw Object.assign(new Error('boom'), { code: 'EBOOM' }); };
    const atStart = await start(['--cli', 'claude'], {}, {}, { selfTest: async () => boom() });
    expect(atStart.r).toEqual({ ok: false, code: 1 });
    expect(atStart.lines.at(-1)).toBe('Not starting. The start-up check failed unexpectedly (EBOOM).');

    let calls = 0;
    const { r, lines, text } = await start(['--cli', 'claude'], {}, {}, { selfTest: async (o) => (++calls === 1 ? selfTest(o) : boom()) });
    if (!r.ok) throw new Error('start failed');
    appendFileSync(join(fakes.dir, 'claude'), '\n// updated\n');
    // The first (refused) start created the token, so this start does not print it: read it from its file.
    const token = tokenFrom(text()) ?? readFileSync(join(home, 'cfg', 'signal-bridge', 'token'), 'utf8').trim();
    expect((await classifyReq(r.port, token)).status).toBe(503);
    const i = lines.findIndex((l) => / re-check failed · not serving any more$/.test(l));
    expect(lines.slice(i + 1, i + 4)).toEqual(['  the check failed unexpectedly (EBOOM)', ...STOPPED]);
    for (const l of [...atStart.lines, ...lines]) expect(l.length, l).toBeLessThanOrEqual(78);
  });
});

describe('token problems are printed as lines (security B6)', () => {
  it('"Not starting." then the lines; exit 1; at most 78 columns', async () => {
    mkdirSync(join(home, 'cfg', 'signal-bridge'), { recursive: true });
    chmodSync(join(home, 'cfg', 'signal-bridge'), 0o777);
    const { r, lines } = await start(['--cli', 'claude']);
    expect(r).toEqual({ ok: false, code: 1 });
    expect(lines.slice(1)).toEqual(['Not starting. The bridge token folder is writable by other users:', '  ~/cfg/signal-bridge', 'Fix it with:', '  chmod 700 ~/cfg/signal-bridge']);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(78);
  });
});

describe('billing, said as it is (security B4)', () => {
  const NOTICE = {
    claude: ['Billing: the bridge passes no API key. If claude is set up with one (an', 'apiKeyHelper or API key in ~/.claude/settings.json), that account is', 'billed, not your subscription.'],
    codex: ['Billing: the bridge passes no API key. If codex is logged in with an API', 'key rather than your ChatGPT account, that account is billed, not your', 'subscription.'],
  };

  for (const cli of ['claude', 'codex'] as const) {
    it(`${cli}: the three notice lines, right before "Listening", once`, async () => {
      const { r, lines } = await start(cli === 'claude' ? ['--cli', 'claude'] : ['--cli', 'codex', '--model', 'gpt-5']);
      expect(r.ok).toBe(true);
      const at = lines.findIndex((l) => l.startsWith('Listening on '));
      expect(lines.slice(at - 3, at)).toEqual(NOTICE[cli]);
      expect(lines.filter((l) => l.startsWith('Billing:'))).toHaveLength(1);
      for (const l of NOTICE[cli]) expect(l.length).toBeLessThanOrEqual(78);
    });
  }

  it('a B2 re-check does not print it again', async () => {
    const { r, lines, text } = await start(['--cli', 'claude']);
    if (!r.ok) throw new Error('start failed');
    appendFileSync(join(fakes.dir, 'claude'), '\n// updated\n');
    expect((await send(r.port, { token: tokenFrom(text())!, body: JSON.stringify(signalBody(POST)) })).status).toBe(200);
    expect(lines.some((l) => /re-check passed/.test(l))).toBe(true);
    expect(lines.filter((l) => l.startsWith('Billing:'))).toHaveLength(1);
  }, 20_000);

  it('README and the design no longer promise "never API billing"', () => {
    const readme = readFileSync('README.md', 'utf8');
    const design = readFileSync('docs/design-bridge.md', 'utf8');
    for (const doc of [readme, design]) {
      expect(doc).not.toMatch(/No API key, no API billing/);
      expect(doc).not.toMatch(/\*\*Subscription only\.\*\*/);
      expect(doc).not.toMatch(/never API billing/i);
    }
    expect(readme).toContain('The bridge never passes an API key');
    expect(readme).toMatch(/check how your CLI itself is logged in/i);
    expect(design).toMatch(/No API key from the bridge/);
  });
});
