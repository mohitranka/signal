// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadDataset } from '../eval/lib';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { cls, fpFor, gem, noise } from './helpers';

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

describe('loadDataset: repeated-template fields (T10)', () => {
  const ANCHOR = fpFor('anchor');
  it('accepts and keeps repeat_of + repeat_similarity, and a family name', () => {
    const rows = loadDataset(write('rep-ok.jsonl', [
      row('a', 'keep', { ...stored(noise(0.97)), repeat_of: ANCHOR, repeat_similarity: 0.9 }),
      row('b', 'keep', { family: 'announce' }),
    ]));
    expect(rows[0]).toMatchObject({ repeat_of: ANCHOR, repeat_similarity: 0.9 });
    expect(rows[1]).toMatchObject({ family: 'announce' });
  });

  it('rejects malformed values with the line number', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ repeat_of: 'nope', repeat_similarity: 0.9 }, /rep-bad\.jsonl:2: bad repeat_of/],
      [{ repeat_of: ANCHOR, repeat_similarity: 0.5 }, /rep-bad\.jsonl:2: bad repeat_similarity/],
      [{ repeat_of: ANCHOR, repeat_similarity: '0.9' }, /rep-bad\.jsonl:2: bad repeat_similarity/],
      [{ repeat_of: ANCHOR }, /rep-bad\.jsonl:2: bad repeat_similarity/],
      [{ repeat_similarity: 0.9 }, /rep-bad\.jsonl:2: bad repeat_of/],
      [{ family: 5 }, /rep-bad\.jsonl:2: bad family/],
      [{ family: '' }, /rep-bad\.jsonl:2: bad family/],
    ];
    for (const [extra, msg] of cases) {
      const p = write('rep-bad.jsonl', [row('ok', 'keep'), row('x', 'keep', { ...stored(noise()), ...extra })]);
      expect(() => loadDataset(p), JSON.stringify(extra)).toThrow(msg);
    }
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

  it('prints corrections on copied verdicts separately (T10)', () => {
    const ANCHOR = fpFor('anchor');
    const copied = (c: unknown) => ({ ...stored(c), repeat_of: ANCHOR, repeat_similarity: 0.9 });
    const r = run('--file', write('copied.jsonl', [...exported, row('x', 'keep', copied(noise(0.97))), row('y', 'collapse', copied(cls()))]), '--mode', 'stored');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`group model=m prompt=${PROMPT_VERSION}: 8 rows`);
    expect(r.stdout).toContain('copied from a similar post (2): relaxed hidden 1 missed 1 | balanced hidden 1 missed 1 | strict hidden 1 missed 1');
  });

  it('prints no copied line when nothing was copied', () => {
    const r = run('--file', write('export2.jsonl', exported), '--mode', 'stored');
    expect(r.stdout).not.toContain('copied from a similar post');
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

  it('prints U+061C (Arabic letter mark, a bidi control) as "?" too (security S1)', () => {
    const r = run('--file', write('alm.jsonl', [{ ...row('a', 'keep', stored(noise(0.99))), id: 'user-\u061cx' }]), '--mode', 'stored');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('\u061c');
    expect(r.stdout).toContain('user-?x');
  });

  it('the keyword baseline still runs offline (regression guard)', () => {
    const r = run('--split', 'dev', '--mode', 'baseline');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('balanced');
  });
});
