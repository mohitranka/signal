import { describe, expect, it, vi } from 'vitest';
import * as evalLib from '../eval/lib';
import * as scoring from '../src/scoring';
import { ParseError, coerceClassification, parseClassification, parseRecord } from '../src/classifier/parse';
import {
  MIN_PER_SIDE,
  correctionReport,
  feedbackToInputs,
  groupCorrections,
  partitionCorrections,
  rowsToInputs,
  type CorrectionInput,
} from '../src/corrections';
import type { FeedbackEntry } from '../src/shared/types';
import { cls, fpFor, gem, noise, record } from './helpers';

vi.mock('../src/scoring', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/scoring')>();
  return { ...real, score: vi.fn(real.score) };
});

const V = 'v1';
const target = { model: 'm', promptVersion: V };

/**
 * 3 "worth keeping" + 3 "low quality" scored items, plus one of each exclusion reason.
 * Expected outcomes (from src/policy.ts thresholds 0.95 / 0.85 / 0.70):
 *   keep  a noise(0.97): collapsed at every sensitivity           -> wrongly hidden R,B,S
 *   keep  b noise(0.90): collapsed at balanced and strict          -> wrongly hidden B,S
 *   keep  c cls():       kept everywhere
 *   low   d noise(0.97): collapsed everywhere                      -> caught
 *   low   e noise(0.80): collapsed only at strict                  -> missed R,B
 *   low   f gem():       highlighted                               -> missed R,B,S
 */
const items: CorrectionInput[] = [
  { id: 'a', label: 'keep', record: record(noise(0.97), 'm', V) },
  { id: 'b', label: 'keep', record: record(noise(0.9), 'm', V) },
  { id: 'c', label: 'keep', record: record(cls(), 'm', V) },
  { id: 'd', label: 'collapse', record: record(noise(0.97), 'm', V) },
  { id: 'e', label: 'collapse', record: record(noise(0.8), 'm', V) },
  { id: 'f', label: 'collapse', record: record(gem(), 'm', V) },
  { id: 'g', label: 'keep' },
  { id: 'h', label: 'collapse', record: record(noise(), 'other', V) },
  { id: 'i', label: 'keep', record: record(noise(), 'm', 'v0') },
];

describe('shared scoring module', () => {
  it('eval/lib re-exports the very same score() the extension uses (not a copy)', () => {
    expect(evalLib.score).toBe(scoring.score);
  });

  it('correctionReport() computes its numbers through score()', () => {
    const spy = vi.mocked(scoring.score);
    spy.mockClear();
    correctionReport(partitionCorrections(items, target).included);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.map((c) => c[1]).sort()).toEqual(['balanced', 'relaxed', 'strict']);
  });
});

describe('classification validation', () => {
  it('coerceClassification validates an already-parsed object with the same rules as model output', () => {
    const c = noise(0.9);
    expect(coerceClassification(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(coerceClassification({ decision: 'keep', confidence: 0.5, reason: '  a \n b ', signals: {} })).toEqual({
      decision: 'keep', confidence: 0.5, reason: 'a b',
      signals: { originality: 0.5, evidence: 0.5, reasoning: 0.5, usefulness: 0.5, sensationalism: 0.5, engagement_bait: 0.5 },
    });
    for (const bad of [null, 'x', [], { decision: 'nope', confidence: 0.5 }, { decision: 'keep', confidence: 2 }, { decision: 'keep' }]) {
      expect(() => coerceClassification(bad)).toThrow(ParseError);
    }
  });

  it('parseClassification still accepts raw model text', () => {
    expect(parseClassification('```json\n' + JSON.stringify(gem()) + '\n```')).toEqual(gem());
  });

  it('parseRecord accepts a well-formed record and returns a clean copy', () => {
    const r = { ...record(noise(0.9), 'openai/gpt-4o-mini', V), extra: 'dropped' };
    (r.classification as any).injected = '<b>x</b>';
    const out = parseRecord(r);
    expect(out).toEqual({ classification: noise(0.9), model: 'openai/gpt-4o-mini', promptVersion: V });
    expect(Object.keys(out!).sort()).toEqual(['classification', 'model', 'promptVersion']);
  });

  it('parseRecord rejects anything malformed', () => {
    const ok = record(noise(), 'm', V);
    for (const bad of [
      undefined, null, 'x', 42, [],
      { ...ok, model: '' },
      { ...ok, model: 7 },
      { ...ok, model: 'x'.repeat(201) },
      { ...ok, promptVersion: '' },
      { ...ok, promptVersion: 'v'.repeat(33) },
      { ...ok, classification: { ...noise(), confidence: 1.5 } },
      { ...ok, classification: { ...noise(), decision: 'hide' } },
      { model: 'm', promptVersion: V },
    ]) {
      expect(parseRecord(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
  });
});

describe('partitionCorrections', () => {
  it('scores only corrections classified by the target model and prompt version, and says why the rest were left out', () => {
    const { included, excluded } = partitionCorrections(items, target);
    expect(included.map((p) => p.row.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(included.map((p) => p.row.label)).toEqual(['keep', 'keep', 'keep', 'collapse', 'collapse', 'collapse']);
    expect(included[0]!.classification).toEqual(noise(0.97));
    expect(excluded).toEqual([
      { id: 'g', reason: 'no-classification' },
      { id: 'h', reason: 'different-model', model: 'other', promptVersion: V },
      { id: 'i', reason: 'different-prompt', model: 'm', promptVersion: 'v0' },
    ]);
  });

  it('treats a malformed stored classification as missing', () => {
    const { included, excluded } = partitionCorrections([{ id: 'x', label: 'keep', record: { ...record(noise()), classification: { decision: 'bogus' } } }], target);
    expect(included).toEqual([]);
    expect(excluded).toEqual([{ id: 'x', reason: 'no-classification' }]);
  });

  it('reports a different model before a different prompt version', () => {
    const { excluded } = partitionCorrections([{ id: 'x', label: 'keep', record: record(noise(), 'other', 'v0') }], target);
    expect(excluded[0]!.reason).toBe('different-model');
  });

  it('handles no corrections at all', () => {
    expect(partitionCorrections([], target)).toEqual({ included: [], excluded: [] });
  });
});

describe('groupCorrections (evaluator: no target, one group per model and prompt version)', () => {
  it('groups by model and prompt version, largest first, and leaves out rows without a usable classification', () => {
    const { groups, excluded } = groupCorrections(items);
    expect(groups.map((g) => [g.model, g.promptVersion, g.included.length])).toEqual([
      ['m', V, 6],
      ['m', 'v0', 1],
      ['other', V, 1],
    ]);
    expect(excluded).toEqual([{ id: 'g', reason: 'no-classification' }]);
  });
});

describe('correctionReport', () => {
  it('counts, per sensitivity, worth-keeping posts that would be collapsed and low-quality posts that would stay', () => {
    const r = correctionReport(partitionCorrections(items, target).included);
    expect(r.rows).toEqual([
      { sensitivity: 'relaxed', wronglyHidden: 1, missed: 2 },
      { sensitivity: 'balanced', wronglyHidden: 2, missed: 2 },
      { sensitivity: 'strict', wronglyHidden: 2, missed: 1 },
    ]);
    expect(r.keptTotal).toBe(3);
    expect(r.lowQualityTotal).toBe(3);
  });

  it('counts a highlighted low-quality post as missed, and a "highlight" label as worth keeping', () => {
    const r = correctionReport(partitionCorrections([
      { id: 'x', label: 'collapse', record: record(gem()) },
      { id: 'y', label: 'highlight', record: record(noise(0.99)) },
    ], target).included);
    expect(r.rows.every((row) => row.missed === 1 && row.wronglyHidden === 1)).toBe(true);
    expect(r.keptTotal).toBe(1);
    expect(r.lowQualityTotal).toBe(1);
  });

  it(`flags each side as meaningful only from ${MIN_PER_SIDE} corrections`, () => {
    expect(MIN_PER_SIDE).toBe(10);
    const make = (keep: number, low: number) =>
      correctionReport(partitionCorrections([
        ...Array.from({ length: keep }, (_, i): CorrectionInput => ({ id: `k${i}`, label: 'keep', record: record(cls()) })),
        ...Array.from({ length: low }, (_, i): CorrectionInput => ({ id: `l${i}`, label: 'collapse', record: record(noise(0.99)) })),
      ], target).included);
    expect(make(9, 11)).toMatchObject({ hiddenMeaningful: false, missedMeaningful: true });
    expect(make(10, 10)).toMatchObject({ hiddenMeaningful: true, missedMeaningful: true });
    expect(make(11, 9)).toMatchObject({ hiddenMeaningful: true, missedMeaningful: false });
  });

  it('is all zeros, and not meaningful, with nothing to score', () => {
    const r = correctionReport([]);
    expect(r).toMatchObject({ keptTotal: 0, lowQualityTotal: 0, hiddenMeaningful: false, missedMeaningful: false });
    expect(r.rows.map((x) => x.sensitivity)).toEqual(['relaxed', 'balanced', 'strict']);
  });
});

describe('input adapters', () => {
  it('feedbackToInputs maps stored feedback (new and old entries) to correction inputs', () => {
    const all: Record<string, FeedbackEntry> = {
      fp1: { verdict: 'keep', at: 1, sample: 's', modelDecision: 'collapse', modelConfidence: 0.9, classified: record(noise(0.9)) },
      fp2: { verdict: 'collapse', at: 2, sample: 't', modelDecision: 'keep', modelConfidence: 0.5 },
    };
    expect(feedbackToInputs(all)).toEqual([
      { id: 'fp1', label: 'keep', record: record(noise(0.9)) },
      { id: 'fp2', label: 'collapse' },
    ]);
  });

  it('rowsToInputs maps exported/eval rows, using classification + model + prompt_version', () => {
    expect(rowsToInputs([
      { id: 'r1', source: 'user-feedback', label: 'keep', text: 't', classification: noise(), model: 'm', prompt_version: V },
      { id: 'r2', source: 'user-feedback', label: 'collapse', text: 't' },
    ])).toEqual([
      { id: 'r1', label: 'keep', record: { classification: noise(), model: 'm', promptVersion: V } },
      { id: 'r2', label: 'collapse' },
    ]);
  });
});

describe('corrections on copied verdicts are counted separately (T10)', () => {
  const ANCHOR = fpFor('anchor');
  const copiedRec = (c: ReturnType<typeof cls>) => ({ ...record(c, 'm', V), repeatOf: { fp: ANCHOR, similarity: 0.9 } });
  // x: worth keeping, copied collapse at 0.97 -> wrongly hidden at every sensitivity
  // y: low quality, copied keep                -> missed at every sensitivity
  const withCopied: CorrectionInput[] = [
    ...items,
    { id: 'x', label: 'keep', record: copiedRec(noise(0.97)) },
    { id: 'y', label: 'collapse', record: copiedRec(cls()) },
  ];

  it('partitionCorrections marks predictions whose classification was copied', () => {
    const { included } = partitionCorrections(withCopied, target);
    const byId = Object.fromEntries(included.map((p) => [p.row.id, p]));
    expect(byId.x!.copied).toBe(true);
    expect(byId.y!.copied).toBe(true);
    expect(byId.a!.copied ?? false).toBe(false);
  });

  it('the report counts copied corrections per sensitivity; the totals still include them', () => {
    const r = correctionReport(partitionCorrections(withCopied, target).included);
    expect(r.copiedTotal).toBe(2);
    expect(r.rows).toEqual([
      { sensitivity: 'relaxed', wronglyHidden: 2, missed: 3, copiedWronglyHidden: 1, copiedMissed: 1 },
      { sensitivity: 'balanced', wronglyHidden: 3, missed: 3, copiedWronglyHidden: 1, copiedMissed: 1 },
      { sensitivity: 'strict', wronglyHidden: 3, missed: 2, copiedWronglyHidden: 1, copiedMissed: 1 },
    ]);
    expect(r.keptTotal).toBe(4);
    expect(r.lowQualityTotal).toBe(4);
  });

  it('without copied corrections: copiedTotal is 0 and the rows keep their previous shape', () => {
    const r = correctionReport(partitionCorrections(items, target).included);
    expect(r.copiedTotal).toBe(0);
    for (const row of r.rows) expect(Object.keys(row).sort()).toEqual(['missed', 'sensitivity', 'wronglyHidden']);
  });

  it('feedbackToInputs keeps repeatOf; a malformed one counts as not copied', () => {
    const all: Record<string, FeedbackEntry> = {
      x: { verdict: 'keep', at: 1, sample: 's', classified: copiedRec(noise(0.97)) },
      z: { verdict: 'keep', at: 1, sample: 's', classified: { ...record(noise(0.97), 'm', V), repeatOf: { fp: 'bad', similarity: 0.9 } } as any },
    };
    const { included } = partitionCorrections(feedbackToInputs(all), target);
    const byId = Object.fromEntries(included.map((p) => [p.row.id, p]));
    expect(byId.x!.copied).toBe(true);
    expect(byId.z!.copied ?? false).toBe(false);
  });

  it('rowsToInputs reads repeat_of / repeat_similarity from exported rows', () => {
    const rows = [
      { id: 'r1', source: 'user-feedback', label: 'keep', text: 't', classification: noise(0.97), model: 'm', prompt_version: V, repeat_of: ANCHOR, repeat_similarity: 0.9 },
      { id: 'r2', source: 'user-feedback', label: 'keep', text: 't', classification: noise(0.97), model: 'm', prompt_version: V },
    ] as any;
    const inputs = rowsToInputs(rows);
    expect((inputs[0]!.record as any).repeatOf).toEqual({ fp: ANCHOR, similarity: 0.9 });
    expect('repeatOf' in (inputs[1]!.record as any)).toBe(false);
    const { included } = partitionCorrections(inputs, target);
    expect(included.map((p) => p.copied ?? false)).toEqual([true, false]);
  });
});
