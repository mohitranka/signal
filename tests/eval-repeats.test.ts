// @vitest-environment node
/**
 * T10: `npm run eval -- --mode repeats`: offline report of which rows the signature treats as the same template.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { repeatReport } from '../eval/repeats';
import type { Row } from '../eval/lib';
import { announce, announceOpenerOnly, lessons, short, unrelated } from './fixtures/templates';

const r = (id: string, label: Row['label'], text: string, extra: Record<string, unknown> = {}): Row => ({ id, source: 'synthetic', label, text, ...extra }) as Row;

/** announce: 3 variants + 1 member that is not actually the template; lessons: 2 variants with different labels. */
const ROWS: Row[] = [
  r('an-1', 'collapse', announce('Northwind', 6, '🚀'), { family: 'announce' }),
  r('an-2', 'collapse', announce('Contoso', 9, '🔥'), { family: 'announce' }),
  r('an-3', 'collapse', announce('Fabrikam', 2, '💯'), { family: 'announce' }),
  r('an-x', 'collapse', unrelated[1]!, { family: 'announce' }),
  r('le-1', 'keep', lessons(12, 7), { family: 'lessons' }),
  r('le-2', 'collapse', lessons(30, 5), { family: 'lessons' }),
  r('neg-1', 'keep', announceOpenerOnly(), { category: 'repeat-negative' }),
  r('short-1', 'collapse', short('Priya'), { category: 'repeat-short' }),
  r('other', 'keep', unrelated[0]!),
];

describe('repeatReport()', () => {
  const rep = repeatReport(ROWS);

  it('states the rules it used', () => {
    expect(rep).toMatchObject({ threshold: 0.85, minWords: 40, version: 3, rows: 9, signed: 8 });
    expect(rep.unsigned).toEqual(['short-1']);
  });

  it('lists matched pairs, those with different labels first', () => {
    expect(rep.pairs).toHaveLength(4); // 3 inside announce + 1 inside lessons
    expect(rep.pairs[0]).toMatchObject({ a: 'le-1', b: 'le-2', sameLabel: false });
    expect(rep.pairs[0]!.similarity).toBe(1);
    expect(rep.pairs.slice(1).every((p) => p.sameLabel)).toBe(true);
    const sims = rep.pairs.slice(1).map((p) => p.similarity);
    expect([...sims].sort((x, y) => y - x)).toEqual(sims); // then most similar first
  });

  it('reports family coverage, naming members that matched nobody in their family with their best estimate', () => {
    expect(rep.families).toEqual([
      { family: 'announce', size: 4, matched: 3, missed: [{ id: 'an-x', best: expect.any(Number) }] },
      { family: 'lessons', size: 2, matched: 2, missed: [] },
    ]);
    expect(rep.families[0]!.missed[0]!.best).toBeLessThan(0.85);
  });

  it('reports hard negatives that matched anything (none here)', () => {
    expect(rep.negativesMatched).toEqual([]);
  });

  it('reports a hard negative that does match', () => {
    const bad = repeatReport([...ROWS, r('neg-2', 'keep', announce('Initech'), { category: 'repeat-negative' })]);
    expect(bad.negativesMatched.map((n) => n.id)).toEqual(['neg-2', 'neg-2', 'neg-2']);
  });
});

describe('npm run eval -- --mode repeats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'signal-rep-'));
  let bundle: string;
  beforeAll(() => {
    bundle = join(dir, 'run.mjs');
    buildSync({ entryPoints: ['eval/run.ts'], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  });
  const run = (...args: string[]) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SIGNAL_')));
    return spawnSync(process.execPath, ['--import', resolve('tests/fixtures/no-network.mjs'), bundle, ...args], { env, encoding: 'utf8', cwd: resolve('.') });
  };
  const write = (name: string, rows: unknown[]) => {
    const p = join(dir, name);
    writeFileSync(p, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
    return p;
  };

  it('runs offline on eval/repeats.jsonl and finds no pair with different labels', () => {
    const out = run('--file', 'eval/repeats.jsonl', '--mode', 'repeats');
    expect(out.stderr).not.toContain('NETWORK ACCESS ATTEMPTED');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('threshold 0.85 · minimum 40 words · signature v3');
    expect(out.stdout).toMatch(/different label:\s+0\b/);
    expect(out.stdout).toMatch(/hard negatives matched to anything: 0 of \d+/);
  });

  it('lists pairs with different labels before anything else, with previews', () => {
    const out = run('--file', write('mixed.jsonl', ROWS), '--mode', 'repeats');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/different label:\s+1\b/);
    const line = out.stdout.split('\n').find((l) => l.includes('le-1') && l.includes('le-2'))!;
    expect(line).toContain('keep ≠ collapse');
    expect(out.stdout.indexOf(line)).toBeLessThan(out.stdout.indexOf('template families'));
    expect(out.stdout).toContain('an-x');
    expect(out.stdout).toContain('signed 8 of 9 rows (1 under 40 words: exact match only)');
  });

  it('never prints control characters from the file', () => {
    const out = run('--file', write('ansi.jsonl', [r('x\u001b[31m', 'keep', announce()), r('y', 'collapse', announce('Contoso'))]), '--mode', 'repeats');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });
});
