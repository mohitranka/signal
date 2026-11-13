import { describe, expect, it } from 'vitest';
import { loadDataset, score, type Prediction, type Row } from '../eval/lib';
import { cls, gem, noise } from './helpers';

const dev = loadDataset('eval/dev.jsonl');
const test = loadDataset('eval/test.jsonl');

describe('evaluation datasets', () => {
  it('has at least 100 examples across separate dev and test splits', () => {
    expect(dev.length + test.length).toBeGreaterThanOrEqual(100);
    expect(dev.length).toBeGreaterThanOrEqual(50);
    expect(test.length).toBeGreaterThanOrEqual(50);
  });
  it('shares no ids or texts between dev and test', () => {
    const devTexts = new Set(dev.map((r) => r.text.toLowerCase()));
    expect(test.filter((r) => devTexts.has(r.text.toLowerCase()))).toEqual([]);
    expect(new Set([...dev, ...test].map((r) => r.id)).size).toBe(dev.length + test.length);
  });
  it('labels every synthetic row as synthetic and keeps all three labels well represented', () => {
    for (const set of [dev, test]) {
      expect(set.every((r) => r.source === 'synthetic')).toBe(true);
      for (const l of ['collapse', 'keep', 'highlight'] as const) expect(set.filter((r) => r.label === l).length).toBeGreaterThanOrEqual(10);
      expect(set.filter((r) => r.adversarial).length).toBeGreaterThanOrEqual(8);
    }
  });
  it('covers the required topic areas in each split', () => {
    const wanted = ['ai-hype', 'ai-doom', 'economics', 'politics', 'philosophy', 'science', 'management', 'career', 'motivational', 'engagement', 'product-announcement', 'promotional', 'short-insight', 'long-empty', 'incident|engineering', 'research'];
    for (const [name, set] of [['dev', dev], ['test', test]] as const) {
      const cats = set.map((r) => r.category ?? '').join(' ');
      for (const w of wanted) expect(new RegExp(w).test(cats), `${name} lacks ${w}`).toBe(true);
    }
  });
  it('rejects malformed rows', () => {
    expect(() => loadDataset('eval/__missing__.jsonl')).toThrow();
  });
});

describe('metrics', () => {
  const row = (id: string, label: Row['label'], also_ok?: Row['also_ok']): Row => ({ id, source: 'synthetic', label, text: id, ...(also_ok ? { also_ok } : {}) });
  const preds: Prediction[] = [
    { row: row('a', 'collapse'), classification: noise() }, // TP
    { row: row('b', 'collapse'), classification: cls() }, // FN
    { row: row('c', 'keep'), classification: noise() }, // FP
    { row: row('d', 'highlight'), classification: gem() }, // TP highlight
    { row: row('e', 'keep', ['highlight']), classification: gem() }, // lenient highlight
    { row: row('f', 'keep'), classification: null }, // failure => keep
  ];
  it('computes precision, recall, false-positive rate, and highlight precision', () => {
    const m = score(preds, 'balanced');
    expect(m.collapsePrecision).toBeCloseTo(1 / 2);
    expect(m.collapseRecall).toBeCloseTo(1 / 2);
    expect(m.falsePositiveRate).toBeCloseTo(1 / 4);
    expect(m.falsePositives).toEqual(['c']);
    expect(m.highlightPrecisionStrict).toBeCloseTo(1 / 2);
    expect(m.highlightPrecisionLenient).toBeCloseTo(1);
    expect(m.failures).toBe(1);
  });
  it('responds to sensitivity', () => {
    const p = [{ row: row('x', 'collapse'), classification: noise(0.8) }];
    expect(score(p, 'relaxed').collapsedCount).toBe(0);
    expect(score(p, 'strict').collapsedCount).toBe(1);
  });
});
