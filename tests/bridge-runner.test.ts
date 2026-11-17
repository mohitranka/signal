// @vitest-environment node
/**
 * Bridge T4 (docs/implementation-plan-bridge.md; invariants I1, I2, I7, I8; decision D9): running the CLI. Uses the
 * fake CLIs (tests/fixtures/fake-cli.cjs), which record exactly what they received.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../bridge/adapters';
import { CliRunner, resolveCommand, scrubEnv, searchDirs } from '../bridge/runner';
import { SYSTEM_PROMPT, buildMessages } from '../src/classifier/prompt';
import type { PostInput } from '../src/shared/types';
import { POST, alive, eventually, installFakes, type FakeBehaviour, type Fakes } from './bridge-helpers';

const POSIX = process.platform !== 'win32';
let fakes: Fakes;
beforeEach(() => {
  fakes = installFakes();
});
afterEach(() => fakes.cleanup());

const CLAUDE_HELP = '-p, --print\n--output-format\n--model\n--system-prompt\n--tools\n--strict-mcp-config\n--mcp-config\n--setting-sources\n--no-session-persistence';
const CODEX_HELP = '--json\n--model\n--sandbox\n--skip-git-repo-check\n--cd';

function runner(cli: 'claude' | 'codex', b: FakeBehaviour = {}, opts: { timeoutMs?: number; help?: string; extraEnv?: Record<string, string> } = {}) {
  fakes.set(b);
  return new CliRunner(ADAPTERS[cli], {
    command: resolveCommand(cli, fakes.PATH)!,
    model: cli === 'claude' ? 'sonnet' : 'gpt-5',
    timeoutMs: opts.timeoutMs ?? 10_000,
    help: opts.help ?? (cli === 'claude' ? CLAUDE_HELP : CODEX_HELP),
    env: scrubEnv({ ...process.env, PATH: fakes.PATH, ...(opts.extraEnv ?? {}) }),
  });
}
const run = (r: CliRunner, post: PostInput = POST) => r.run(post, new AbortController().signal);

describe('finding the CLI', () => {
  it('resolves the command on PATH to an absolute path, once; unknown → null', () => {
    expect(resolveCommand('claude', fakes.PATH)).toBe(join(fakes.dir, 'claude'));
    expect(resolveCommand('definitely-not-a-cli-xyz', fakes.PATH)).toBeNull();
  });

  it('on Windows only a .exe is accepted (running a .cmd shim needs a shell, which I7 forbids)', () => {
    const d = mkdtempSync(join(tmpdir(), 'signal-win-'));
    try {
      writeFileSync(join(d, 'claude.cmd'), '@echo off');
      expect(resolveCommand('claude', d, 'win32')).toBeNull();
      writeFileSync(join(d, 'claude.exe'), 'MZ');
      expect(resolveCommand('claude', d, 'win32')).toBe(join(d, 'claude.exe'));
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it.runIf(POSIX)('a file that is not executable is not a command', () => {
    chmodSync(join(fakes.dir, 'codex'), 0o644);
    expect(resolveCommand('codex', fakes.dir)).toBeNull();
  });
});

describe('arguments (I1, I7)', () => {
  it('Claude: exactly the design\'s flags; no-session flag when --help lists it', async () => {
    await run(runner('claude'));
    expect(fakes.calls()[0]!.argv).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet', '--system-prompt', SYSTEM_PROMPT, '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user', '--no-session-persistence']);
    // Security B3: always passed now (a version without it is refused at start, so it is never left out).
    await run(runner('claude', {}, { help: CLAUDE_HELP.replace('--no-session-persistence', '') }));
    expect(fakes.calls()[1]!.argv.at(-1)).toBe('--no-session-persistence');
  });

  it('Codex: -c history.persistence="none" only when --help lists -c/--config (security B3)', async () => {
    await run(runner('codex', {}, { help: CODEX_HELP + '\n-c, --config <key=value>' }));
    const withC = fakes.calls()[0]!.argv;
    expect(withC.slice(0, 4)).toEqual(['exec', '--json', '-c', 'history.persistence="none"']);
    await run(runner('codex', {}, { help: CODEX_HELP }));
    expect(fakes.calls()[1]!.argv).not.toContain('-c');
  });

  it('Codex: exec with JSON output, read-only sandbox, the temp folder, prompt from stdin', async () => {
    await run(runner('codex'));
    const call = fakes.calls()[0]!;
    expect(call.argv).toEqual(['exec', '--json', '--model', 'gpt-5', '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', call.argv[8], '-']);
    expect(basename(call.argv[8]!)).toMatch(/^signal-bridge-/);
  });

  it('post text never on the command line; stdin carries it (Claude: the user message; Codex: prompt then message)', async () => {
    const post = { text: 'Secret-ish post text $(touch pwned) ; touch pwned2 `touch pwned3` | tee pwned4' };
    const user = buildMessages(post)[1]!.content;
    await run(runner('claude'), post);
    await run(runner('codex'), post);
    const [c, x] = fakes.calls();
    expect(c!.stdin).toBe(user);
    expect(x!.stdin).toBe(`${SYSTEM_PROMPT}\n\n${user}`);
    for (const call of [c!, x!]) expect(call.argv.join(' ')).not.toContain('Secret-ish');
    for (const where of [fakes.dir, process.cwd()]) expect(readdirSync(where).filter((f) => f.startsWith('pwned'))).toEqual([]);
  });

  it('no shell anywhere in the bridge (spawn with an argument array only)', () => {
    for (const f of readdirSync('bridge').filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join('bridge', f), 'utf8');
      expect(src, f).not.toMatch(/shell:\s*true/);
      expect(src, f).not.toMatch(/require\(['"](node:)?child_process/);
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](node:)?child_process['"]/g)) {
        expect(m[1]!.split(',').map((x) => x.trim()).filter(Boolean), f).toEqual(['spawn']);
      }
      expect(src, f).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s*['"](node:)?child_process/);
    }
  });
});

describe('environment (I2, D9)', () => {
  it('API keys and everything not on the allow-list are removed; PATH and HOME are kept', async () => {
    const secrets = { ANTHROPIC_API_KEY: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://evil.example', OPENAI_API_KEY: 'sk-x', OPENAI_BASE_URL: 'https://evil.example', AWS_SECRET_ACCESS_KEY: 'a', GOOGLE_APPLICATION_CREDENTIALS: '/g', CLAUDE_CODE_USE_BEDROCK: '1', FOO: 'bar', NODE_OPTIONS: '--require /tmp/evil.js' };
    await run(runner('claude', {}, { extraEnv: { ...secrets, HOME: '/home/someone', LANG: 'en_GB.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128', CLAUDE_CONFIG_DIR: '/cfg' } }));
    const env = fakes.calls()[0]!.env;
    for (const k of Object.keys(secrets)) expect(env[k], k).toBeUndefined();
    expect(env.PATH).toBe(searchDirs(fakes.PATH).join(':')); // security B1: npm folders and relative entries removed
    expect(env.HOME).toBe('/home/someone');
    expect(env).toMatchObject({ LANG: 'en_GB.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy:3128', CLAUDE_CONFIG_DIR: '/cfg' });
  });

  it('scrubEnv is an allow-list: unknown names never pass, whatever they are called', () => {
    const out = scrubEnv({ PATH: '/bin', HOME: '/h', MY_TOKEN: 'x', anthropic_api_key: 'y', XDG_CONFIG_HOME: '/x', SOMETHING_ELSE: 'z' }, 'linux');
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', XDG_CONFIG_HOME: '/x' });
    expect(scrubEnv({ PATH: 'C:\\bin', USERPROFILE: 'C:\\u', APPDATA: 'C:\\a', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'k' }, 'win32')).toEqual({ PATH: 'C:\\bin', USERPROFILE: 'C:\\u', APPDATA: 'C:\\a', SystemRoot: 'C:\\Windows' });
  });
});

describe('working folder (I1)', () => {
  it('a fresh empty temp folder per call, different each time, deleted afterwards (also after failures)', async () => {
    await run(runner('claude'));
    await run(runner('claude'));
    await run(runner('claude', { mode: 'exit1' }));
    const calls = fakes.calls();
    expect(new Set(calls.map((c) => c.cwd)).size).toBe(3);
    for (const c of calls) {
      expect(basename(c.cwd)).toMatch(/^signal-bridge-/);
      expect(c.files).toEqual([]);
      expect(existsSync(c.cwd), c.cwd).toBe(false);
    }
  });
});

describe('bounded (I8)', () => {
  it.runIf(POSIX)('a timeout kills the whole process group (no grandchild left behind)', async () => {
    const r = await run(runner('claude', { mode: 'grandchild' }, { timeoutMs: 800 }));
    expect(r).toMatchObject({ ok: false, cause: 'timeout' });
    const pids = fakes.grandchildren();
    expect(pids).toHaveLength(1);
    await eventually(() => !alive(pids[0]!), 5000, 'grandchild to die');
    expect(existsSync(fakes.calls()[0]!.cwd)).toBe(false);
  });

  it('aborting (Signal cancelled) kills the CLI too', async () => {
    fakes.set({ mode: 'slow' });
    const r = runner('claude', { mode: 'slow' });
    const ctrl = new AbortController();
    const pending = r.run(POST, ctrl.signal);
    await eventually(() => fakes.calls().length === 1, 5000, 'CLI to start');
    ctrl.abort();
    expect(await pending).toMatchObject({ ok: false, cause: 'aborted' });
    await eventually(() => !alive(fakes.calls()[0]!.pid), 5000, 'CLI to die');
  });

  it('more than 1 MB on stdout or stderr: killed, "too large"', async () => {
    expect(await run(runner('claude', { mode: 'huge-stdout' }))).toMatchObject({ ok: false, cause: 'too-large' });
    expect(await run(runner('claude', { mode: 'huge-stderr' }))).toMatchObject({ ok: false, cause: 'too-large' });
  });
});

describe('reading the CLI\'s answer (formats unverified: design §2)', () => {
  it('Claude JSON: result text; prompt tokens include cache tokens', async () => {
    const r = await run(runner('claude'));
    expect(r).toMatchObject({ ok: true, usage: { input: 812, output: 70 } });
    expect(r.ok && JSON.parse(r.text).decision).toBe('keep');
  });

  it('Codex JSONL, current event shape and the older one', async () => {
    for (const codexShape of ['new', 'old'] as const) {
      const r = await run(runner('codex', { codexShape }));
      expect(r, codexShape).toMatchObject({ ok: true, usage: { input: 800, output: 70 } });
      expect(r.ok && JSON.parse(r.text).reason).toBe('Concrete, firsthand numbers.');
    }
  });

  it('not logged in → cause "login" (both CLIs)', async () => {
    expect(await run(runner('claude', { mode: 'not-logged-in' }))).toMatchObject({ ok: false, cause: 'login' });
    expect(await run(runner('codex', { mode: 'not-logged-in' }))).toMatchObject({ ok: false, cause: 'login' });
  });

  it('non-zero exit, garbled or empty output → "failed" with a short cause that never quotes the output', async () => {
    for (const mode of ['exit1', 'garbage', 'empty'] as const) {
      for (const cli of ['claude', 'codex'] as const) {
        const r = await run(runner(cli, { mode, echoStderr: true }));
        expect(r, `${cli} ${mode}`).toMatchObject({ ok: false, cause: 'failed' });
        if (!r.ok) {
          expect(r.detail.length).toBeLessThanOrEqual(60);
          expect(r.detail).not.toMatch(/not json|something broke|received|p99/);
        }
      }
    }
  });

  it('parsers are pure functions of (stdout, stderr, exit code)', () => {
    const c = ADAPTERS.claude.parse(JSON.stringify({ type: 'result', is_error: false, result: 'hello', usage: { input_tokens: 5, output_tokens: 2 } }), '', 0);
    expect(c).toEqual({ ok: true, text: 'hello', usage: { input: 5, output: 2 } });
    expect(ADAPTERS.claude.parse(JSON.stringify({ type: 'result', is_error: true, result: 'Please run /login' }), '', 1)).toMatchObject({ ok: false, cause: 'login' });
    const x = ADAPTERS.codex.parse('{"type":"item.completed","item":{"type":"agent_message","text":"a"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"b"}}\n', '', 0);
    expect(x).toEqual({ ok: true, text: 'b' }); // the last agent message; no usage reported → none
  });
});

describe('a call that cannot be prepared (security B5)', () => {
  it('no usable temporary folder: a failure result with the error code, never an exception', async () => {
    const real = process.env.TMPDIR;
    process.env.TMPDIR = '/nonexistent-signal-tmp';
    try {
      expect(await run(runner('claude'))).toEqual({ ok: false, cause: 'unprepared', detail: 'ENOENT' });
      expect(fakes.calls()).toHaveLength(0);
    } finally {
      if (real === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = real;
    }
  });
});
