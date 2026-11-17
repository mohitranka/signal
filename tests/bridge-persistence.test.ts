// @vitest-environment node
/**
 * Security B3 (docs/design-security-b3.md, docs/implementation-plan-security-b3.md): what the CLIs keep of each post.
 * Layer 2: after every call the bridge removes only what carries the call's unique folder name. Layer 3's scan:
 * findMarker. The fakes keep files the way each CLI is described to (tests/fixtures/fake-cli.cjs).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTERS } from '../bridge/adapters';
import { CliRunner, findMarker, resolveCommand, scrubEnv } from '../bridge/runner';
import { POST, installFakes, type FakeBehaviour, type Fakes } from './bridge-helpers';

let fakes: Fakes;
let home = '';
beforeEach(() => {
  fakes = installFakes();
  home = mkdtempSync(join(tmpdir(), 'signal-b3-home-'));
});
afterEach(() => {
  fakes.cleanup();
  rmSync(home, { recursive: true, force: true });
});

async function run(cli: 'claude' | 'codex', b: FakeBehaviour, timeoutMs = 10_000) {
  fakes.set(b);
  const runner = new CliRunner(ADAPTERS[cli], {
    command: resolveCommand(cli, fakes.PATH)!,
    model: cli === 'claude' ? 'sonnet' : 'gpt-5',
    timeoutMs,
    help: cli === 'claude' ? '--no-session-persistence' : '-c, --config',
    env: scrubEnv({ PATH: fakes.PATH, HOME: home }),
  });
  return runner.run(POST, new AbortController().signal);
}
const lastCwd = () => fakes.calls().at(-1)!.cwd;
const write = (p: string, text: string) => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};

describe('Claude: the call\'s project folder is removed, nothing else (layer 2)', () => {
  const projects = () => join(home, '.claude', 'projects');
  const others = () => {
    write(join(projects(), '-tmp-signal-bridge-OTHER1', 'a.jsonl'), 'another bridge call, similar name'); // similar name
    write(join(projects(), '-home-u-work', 'b.jsonl'), 'your own project, changed just now');
  };

  for (const [label, b, timeout] of [
    ['after a classification', { persist: 'claude-project' }, 10_000],
    ['after a failure', { persist: 'claude-project', mode: 'exit1' }, 10_000],
    ['after a timeout', { persist: 'claude-project', mode: 'slow' }, 800],
  ] as [string, FakeBehaviour, number][]) {
    it(label, async () => {
      others();
      await run('claude', b, timeout);
      const kept = readdirSync(projects()).sort();
      expect(kept).toEqual(['-home-u-work', '-tmp-signal-bridge-OTHER1']);
      expect(kept.some((n) => n.includes(lastCwd().split('/').pop()!))).toBe(false);
      expect(readFileSync(join(projects(), '-home-u-work', 'b.jsonl'), 'utf8')).toBe('your own project, changed just now');
    });
  }

  it('uses CLAUDE_CONFIG_DIR when set', async () => {
    const state = join(home, 'custom-claude');
    fakes.set({ persist: 'claude-project' });
    const runner = new CliRunner(ADAPTERS.claude, { command: resolveCommand('claude', fakes.PATH)!, model: 'sonnet', timeoutMs: 10_000, help: '', env: scrubEnv({ PATH: fakes.PATH, HOME: home, CLAUDE_CONFIG_DIR: state }) });
    await runner.run(POST, new AbortController().signal);
    expect(readdirSync(join(state, 'projects'))).toEqual([]);
  });
});

describe('Codex: the call\'s session file is removed, nothing else (layer 2)', () => {
  const sessions = () => join(home, '.codex', 'sessions');
  const today = () => {
    const n = new Date();
    return join(sessions(), String(n.getFullYear()), String(n.getMonth() + 1).padStart(2, '0'), String(n.getDate()).padStart(2, '0'));
  };

  it('after a classification and after a failure; other sessions (same moment, older) untouched', async () => {
    const same = join(today(), 'rollout-other-now.jsonl');
    write(same, JSON.stringify({ type: 'session_meta', payload: { cwd: '/home/u/work' } }) + '\n');
    const old = join(sessions(), '2025', '01', '02', 'rollout-old.jsonl');
    write(old, JSON.stringify({ type: 'session_meta', payload: { cwd: '/tmp/signal-bridge-OLD123' } }) + '\n');
    utimesSync(old, new Date('2025-01-02'), new Date('2025-01-02'));
    await run('codex', { persist: 'codex-session' });
    await run('codex', { persist: 'codex-session', mode: 'exit1' });
    expect(readdirSync(today()).sort()).toEqual(['rollout-other-now.jsonl']);
    expect(existsSync(old)).toBe(true);
  });

  it('history.jsonl (shared by all your Codex use) is never modified by the bridge', async () => {
    const history = join(home, '.codex', 'history.jsonl');
    write(history, '{"text":"your own earlier prompt"}\n');
    await run('codex', { persist: 'codex-history' });
    const lines = readFileSync(history, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // yours, and the one the (fake) CLI added: left for the start-up check to report
    expect(lines[0]).toBe('{"text":"your own earlier prompt"}');
  });

  it('uses CODEX_HOME when set', async () => {
    const state = join(home, 'custom-codex');
    fakes.set({ persist: 'codex-session' });
    const runner = new CliRunner(ADAPTERS.codex, { command: resolveCommand('codex', fakes.PATH)!, model: 'gpt-5', timeoutMs: 10_000, help: '', env: scrubEnv({ PATH: fakes.PATH, HOME: home, CODEX_HOME: state }) });
    await runner.run(POST, new AbortController().signal);
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : files.push(e.name); };
    walk(join(state, 'sessions'));
    expect(files).toEqual([]);
  });
});

describe('findMarker: the start-up scan (layer 3)', () => {
  const MARK = 'b3marker-0123456789abcdef';
  const since = () => Date.now() - 1000;

  it('finds the marker in a nested file and in a single-file root', () => {
    const t = since();
    write(join(home, '.claude', 'a', 'b', 'c.log'), `x ${MARK} y`);
    expect(findMarker([join(home, '.claude')], MARK, t)).toEqual({ found: join(home, '.claude', 'a', 'b', 'c.log') });
    rmSync(join(home, '.claude'), { recursive: true });
    write(join(home, '.claude.json'), `{"last":"${MARK}"}`);
    expect(findMarker([join(home, '.claude'), join(home, '.claude.json')], MARK, t)).toEqual({ found: join(home, '.claude.json') });
  });

  it('nothing there, or missing roots → not found', () => {
    write(join(home, '.codex', 'config.toml'), 'model = "gpt-5"');
    expect(findMarker([join(home, '.codex'), join(home, 'missing')], MARK, since())).toEqual({ found: null });
  });

  it('ignores files not changed since the call started (2 s of clock slack)', () => {
    const f = join(home, '.codex', 'old.jsonl');
    write(f, MARK);
    const past = new Date(Date.now() - 60_000);
    utimesSync(f, past, past);
    expect(findMarker([join(home, '.codex')], MARK, Date.now() - 1000)).toEqual({ found: null });
    const recent = new Date(Date.now() - 1500);
    utimesSync(f, recent, recent);
    expect(findMarker([join(home, '.codex')], MARK, Date.now())).toEqual({ found: f });
  });

  it('does not follow symlinks (a link to a file with the marker elsewhere)', () => {
    const outside = join(home, 'outside.txt');
    write(outside, MARK);
    mkdirSync(join(home, '.claude'), { recursive: true });
    symlinkSync(outside, join(home, '.claude', 'link.txt'));
    symlinkSync(home, join(home, '.claude', 'loop'));
    expect(findMarker([join(home, '.claude')], MARK, since())).toEqual({ found: null });
  });

  it('limits: files over the size limit are skipped; too many files or entries → incomplete (fail closed)', () => {
    write(join(home, '.codex', 'big.log'), 'x'.repeat(100) + MARK);
    expect(findMarker([join(home, '.codex')], MARK, since(), { maxBytes: 50, maxFiles: 2000, maxEntries: 50_000 })).toEqual({ found: null });
    rmSync(join(home, '.codex', 'big.log')); // no marker anywhere now: only the limits can end the scan
    for (let i = 0; i < 5; i++) write(join(home, '.codex', `f${i}.log`), 'nothing');
    expect(findMarker([join(home, '.codex')], MARK, since(), { maxBytes: 5e6, maxFiles: 3, maxEntries: 50_000 })).toEqual({ incomplete: 'more than 3 changed files' }); // 5 changed files
    expect(findMarker([join(home, '.codex')], MARK, since(), { maxBytes: 5e6, maxFiles: 2000, maxEntries: 4 })).toEqual({ incomplete: 'more than 4 entries' }); // 5 entries
  });
});
