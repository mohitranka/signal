// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDataset } from '../eval/lib';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { cls, gem, noise } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'signal-eval-'));
const write = (name: string, rows: unknown[]) => {
  const p = join(dir, name);
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
};
const row = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id: `user-${id}`, source: 'user-feedback', label, text: `post ${id}`, ...extra });
const stored = (c: unknown, model = 'm', prompt_version = PROMPT_VERSION) => ({ classification: c, model, prompt_version, model_decision: (c as any).decision, model_confidence: (c as any).confidence });

/** What the popup exports: new entries carry their classification, older ones do not. */
const exported = [
  row('a', 'keep', stored(noise(0.97))),
  row('b', 'keep', stored(noise(0.9))),
  row('c', 'keep', stored(cls())),
  row('d', 'collapse', stored(noise(0.97))),
  row('e', 'collapse', stored(noise(0.8))),
  row('f', 'collapse', stored(gem())),
  row('g', 'keep', { model_decision: 'collapse', model_confidence: 0.9, at: '2026-01-01T00:00:00.000Z' }),
  row('h', 'collapse', stored(noise(), 'other')),
];

describe('loadDataset with exported feedback', () => {
  it('keeps classification, model and prompt_version, and still accepts rows without them', () => {
    const rows = loadDataset(write('ok.jsonl', exported));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ id: 'user-a', classification: noise(0.97), model: 'm', prompt_version: PROMPT_VERSION });
    expect(rows[6]!.classification).toBeUndefined();
  });

  it('rejects a malformed classification with the line number', () => {
    const p = write('bad.jsonl', [row('a', 'keep', stored(cls())), row('b', 'keep', { classification: { decision: 'hide', confidence: 3 }, model: 'm', prompt_version: 'v1' })]);
    expect(() => loadDataset(p)).toThrow(/bad\.jsonl:2: bad classification/);
  });
});

describe('npm run eval -- --mode stored', () => {
  let bundle: string;
  beforeAll(() => {
    bundle = join(dir, 'run.mjs');
    buildSync({ entryPoints: ['eval/run.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  });

  const run = (...args: string[]) => {
    // No SIGNAL_* credentials, and a preload that fails loudly on any network access.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SIGNAL_')));
    return spawnSync(process.execPath, ['--import', resolve('tests/fixtures/no-network.mjs'), bundle, ...args], { env, encoding: 'utf8', cwd: resolve('.') });
  };

  it('scores exported feedback from the stored classifications, with no API calls', () => {
    const r = run('--file', write('export.jsonl', exported), '--mode', 'stored');
    expect(r.stderr).not.toContain('NETWORK ACCESS ATTEMPTED');
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout;
    expect(out).toContain('stored classifications, no API calls');
    expect(out).toContain(`group model=m prompt=${PROMPT_VERSION}: 6 rows`);
    expect(out).toMatch(new RegExp(`group model=other prompt=${PROMPT_VERSION}: 1 rows?`));
    // Same numbers the popup shows (see tests/corrections.test.ts for the derivation).
    expect(out).toContain('relaxed hidden 1/3 missed 2/3');
    expect(out).toContain('balanced hidden 2/3 missed 2/3');
    expect(out).toContain('strict hidden 2/3 missed 1/3');
    expect(out).toMatch(/too few to judge/i);
    expect(out).toContain('left out (no stored classification): 1');
    expect(out).toContain('user-g');
    expect(out).not.toContain('raw predictions saved');
  });

  it('says so when nothing in the file has a stored classification', () => {
    const r = run('--file', write('legacy.jsonl', [row('x', 'keep'), row('y', 'collapse')]), '--mode', 'stored');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('no rows with stored classifications');
    expect(r.stdout).toContain('left out (no stored classification): 2');
  });

  it('never prints control characters from the file to the terminal (S5)', () => {
    const r = run('--file', write('ansi.jsonl', [
      { ...row('a', 'keep', stored(noise(0.99))), id: 'user-\u001b[31mred\u001b[0m' },
      { ...row('b', 'keep'), id: 'user-\u001b]0;pwned\u0007b' },
      row('c', 'collapse', stored(noise(0.99), 'evil\u001b[2Jmodel')),
    ]), '--mode', 'stored');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(r.stdout).toContain('user-?[31mred?[0m');
  });

  it('the keyword baseline still runs offline (regression guard)', () => {
    const r = run('--split', 'dev', '--mode', 'baseline');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('balanced');
  });
});
