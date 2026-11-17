// @vitest-environment node
/**
 * Performance PB2 + PB3 (docs/design-performance-pb2-pb3.md, docs/implementation-plan-performance-pb2-pb3.md).
 * PB2: the Codex clean-up after each call lists only the call's day folders. PB3: the start-up scan allows 200,000
 * entries and skips node_modules. readdirSync is wrapped in a spy (its behaviour kept) to see what is listed.
 */
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, readdirSync: vi.fn(real.readdirSync) };
});

import { ADAPTERS, sessionDayFolders } from '../bridge/adapters';
import { SCAN_LIMITS, findMarker } from '../bridge/runner';

const listed = vi.mocked(fs.readdirSync);
let home = '';
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'signal-pb-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const two = (n: number) => String(n).padStart(2, '0');
const localDay = (t: number) => { const d = new Date(t); return `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`; };
const utcDay = (t: number) => { const d = new Date(t); return `${d.getUTCFullYear()}/${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())}`; };

describe('sessionDayFolders (PB2)', () => {
  it('the start and end dates, local and UTC, distinct; never more than four', () => {
    const t = Date.UTC(2026, 5, 15, 12, 0, 0);
    expect(sessionDayFolders(t, t + 5000).sort()).toEqual([...new Set([localDay(t), utcDay(t)])].sort());
    const beforeMidnight = new Date(2026, 5, 15, 23, 59, 50).getTime(); // local time
    const days = sessionDayFolders(beforeMidnight, beforeMidnight + 20_000);
    expect(days).toContain(localDay(beforeMidnight));
    expect(days).toContain(localDay(beforeMidnight + 20_000));
    expect(days.length).toBeLessThanOrEqual(4);
    expect(new Set(days).size).toBe(days.length);
  });
});

describe('Codex clean-up lists only the call\'s day folders (PB2)', () => {
  const sessions = () => join(home, '.codex', 'sessions');
  const UNIQUE = 'signal-bridge-ABC123';
  const session = (day: string, name: string, cwd: string) => {
    const dir = join(sessions(), ...day.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(join(dir, name), JSON.stringify({ type: 'session_meta', payload: { cwd } }) + '\n');
    return join(dir, name);
  };

  it('with 30 old date folders, only the call\'s day folders are listed; its session is removed', async () => {
    for (let d = 1; d <= 30; d++) session(`2025/01/${two(d)}`, 'rollout-old.jsonl', '/home/u/work');
    const startedAt = Date.now();
    const mine = session(localDay(startedAt), 'rollout-mine.jsonl', `/tmp/${UNIQUE}`);
    listed.mockClear();
    ADAPTERS.codex.cleanup({ unique: UNIQUE, startedAt, env: { HOME: home } });
    const dirs = listed.mock.calls.map((c) => String(c[0]));
    const allowed = sessionDayFolders(startedAt, Date.now()).map((d) => join(sessions(), ...d.split('/')));
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) expect(allowed, d).toContain(d);
    expect(fs.existsSync(mine)).toBe(false);
  });

  it('a file with the call\'s name in an old date folder is left alone (it cannot belong to this call)', () => {
    const stray = session('2025/01/02', 'rollout-stray.jsonl', `/tmp/${UNIQUE}`); // changed just now, name matches
    ADAPTERS.codex.cleanup({ unique: UNIQUE, startedAt: Date.now() - 1000, env: { HOME: home } });
    expect(fs.existsSync(stray)).toBe(true);
  });
});

describe('start-up scan limits (PB3)', () => {
  it('the default limits: 200,000 entries (was 50,000), 2,000 changed files, 5 MB each', () => {
    // A tree of 60,000+ entries takes tens of seconds to create here, so the limit is pinned; the measured behaviour
    // (60,100 entries: refused before, scanned in about 0.2 s after) is in the plan's results.
    expect(SCAN_LIMITS).toEqual({ maxBytes: 5 * 1024 * 1024, maxFiles: 2000, maxEntries: 200_000 });
  });

  it('node_modules folders are not entered and do not count towards the limit', () => {
    const nm = join(home, '.claude', 'local', 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    for (let i = 0; i < 40; i++) fs.writeFileSync(join(nm, `f${i}.js`), 'x');
    fs.writeFileSync(join(nm, 'readme.txt'), 'marker'); // changed just now: would be reported if entered
    fs.writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    const limits = { maxBytes: 5e6, maxFiles: 2000, maxEntries: 10 };
    expect(findMarker([join(home, '.claude')], 'marker', Date.now(), limits)).toEqual({ found: null });
    expect(listed.mock.calls.map((c) => String(c[0])).some((d) => d.split(sep).includes('node_modules') && d.endsWith('node_modules'))).toBe(false);
  });
});

describe('README: the pace (PB1)', () => {
  it('states the pace, the concurrency advice and the checklist step', () => {
    const readme = fs.readFileSync('README.md', 'utf8');
    expect(readme).toMatch(/one at a time by default/i);
    expect(readme).toContain('--concurrency 2');
    expect(readme).toMatch(/time a few posts/i);
  });
});
