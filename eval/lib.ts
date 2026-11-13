import { readFileSync } from 'node:fs';
import { decide } from '../src/policy';
import type { Classification, Decision, PostInput, Sensitivity } from '../src/shared/types';

export interface Row {
  id: string;
  source: 'synthetic' | 'user-feedback' | 'manual';
  category?: string;
  label: Decision;
  /** Other outcomes that are also acceptable (e.g. "keep or highlight"). */
  also_ok?: Decision[];
  adversarial?: boolean;
  text: string;
  quoted?: string;
  linkTitle?: string;
  linkDescription?: string;
}

export interface Prediction {
  row: Row;
  /** null when classification failed; scored as "keep" (fail open). */
  classification: Classification | null;
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  httpRequests?: number;
  error?: string;
}

export function loadDataset(path: string): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .forEach((line, i) => {
      const r = JSON.parse(line) as Row;
      if (!r.id || seen.has(r.id)) throw new Error(`${path}:${i + 1}: missing or duplicate id`);
      if (!['collapse', 'keep', 'highlight'].includes(r.label)) throw new Error(`${path}:${i + 1}: bad label`);
      if (!r.text || typeof r.text !== 'string') throw new Error(`${path}:${i + 1}: missing text`);
      if (!['synthetic', 'user-feedback', 'manual'].includes(r.source)) throw new Error(`${path}:${i + 1}: bad source`);
      seen.add(r.id);
      rows.push(r);
    });
  return rows;
}

export const toInput = (r: Row): PostInput => ({
  text: r.text,
  ...(r.quoted ? { quoted: r.quoted } : {}),
  ...(r.linkTitle ? { linkTitle: r.linkTitle } : {}),
  ...(r.linkDescription ? { linkDescription: r.linkDescription } : {}),
});

const ratio = (n: number, d: number) => (d === 0 ? null : n / d);

export interface Metrics {
  n: number;
  failures: number;
  collapsedCount: number;
  highlightedCount: number;
  /** Of posts Signal would collapse, fraction labeled collapse. */
  collapsePrecision: number | null;
  /** Of posts labeled collapse, fraction Signal would collapse. */
  collapseRecall: number | null;
  /** Of posts labeled keep/highlight (substantive), fraction wrongly collapsed. THE number to minimize. */
  falsePositiveRate: number | null;
  falsePositives: string[];
  highlightPrecisionStrict: number | null;
  highlightPrecisionLenient: number | null;
  highlightRecall: number | null;
  confusion: Record<Decision, Record<Decision, number>>; // [label][outcome]
}

export function score(preds: Prediction[], sensitivity: Sensitivity, highlightEnabled = true): Metrics {
  const confusion = {
    collapse: { collapse: 0, keep: 0, highlight: 0 },
    keep: { collapse: 0, keep: 0, highlight: 0 },
    highlight: { collapse: 0, keep: 0, highlight: 0 },
  } as Metrics['confusion'];
  const falsePositives: string[] = [];
  let failures = 0;

  for (const p of preds) {
    let outcome: Decision = 'keep';
    if (p.classification) outcome = decide(p.classification, { sensitivity, highlightEnabled }).outcome;
    else failures++;
    confusion[p.row.label][outcome]++;
    if (outcome === 'collapse' && p.row.label !== 'collapse') falsePositives.push(p.row.id);
  }

  const col = (o: Decision) => confusion.collapse[o] + confusion.keep[o] + confusion.highlight[o];
  const labeled = (l: Decision) => confusion[l].collapse + confusion[l].keep + confusion[l].highlight;

  // Lenient highlight precision also accepts rows whose also_ok lists "highlight".
  let hlLenient = 0;
  for (const p of preds) {
    if (!p.classification) continue;
    const o = decide(p.classification, { sensitivity, highlightEnabled }).outcome;
    if (o === 'highlight' && (p.row.label === 'highlight' || p.row.also_ok?.includes('highlight'))) hlLenient++;
  }

  return {
    n: preds.length,
    failures,
    collapsedCount: col('collapse'),
    highlightedCount: col('highlight'),
    collapsePrecision: ratio(confusion.collapse.collapse, col('collapse')),
    collapseRecall: ratio(confusion.collapse.collapse, labeled('collapse')),
    falsePositiveRate: ratio(confusion.keep.collapse + confusion.highlight.collapse, labeled('keep') + labeled('highlight')),
    falsePositives,
    highlightPrecisionStrict: ratio(confusion.highlight.highlight, col('highlight')),
    highlightPrecisionLenient: ratio(hlLenient, col('highlight')),
    highlightRecall: ratio(confusion.highlight.highlight, labeled('highlight')),
    confusion,
  };
}

const pct = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export function formatMetrics(name: string, m: Metrics): string {
  const c = m.confusion;
  return [
    `  ${name.padEnd(9)} collapse P=${pct(m.collapsePrecision)} R=${pct(m.collapseRecall)} | FPR(substantive)=${pct(m.falsePositiveRate)} (${m.falsePositives.length}) | highlight P=${pct(m.highlightPrecisionStrict)} (lenient ${pct(m.highlightPrecisionLenient)}) R=${pct(m.highlightRecall)}`,
    `            confusion label→outcome  collapse:[${c.collapse.collapse},${c.collapse.keep},${c.collapse.highlight}]  keep:[${c.keep.collapse},${c.keep.keep},${c.keep.highlight}]  highlight:[${c.highlight.collapse},${c.highlight.keep},${c.highlight.highlight}]  (cols: collapse,keep,highlight)`,
  ].join('\n');
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export function usageSummary(preds: Prediction[], inPricePerM?: number, outPricePerM?: number): string {
  const lat = preds.map((p) => p.latencyMs).filter((v): v is number => v !== undefined);
  const inTok = preds.reduce((a, p) => a + (p.promptTokens ?? 0), 0);
  const outTok = preds.reduce((a, p) => a + (p.completionTokens ?? 0), 0);
  const reqs = preds.reduce((a, p) => a + (p.httpRequests ?? 0), 0);
  const lines = [
    `  requests=${reqs} for ${preds.length} posts | tokens in=${inTok} out=${outTok} | per post: ${(inTok / Math.max(1, preds.length)).toFixed(0)} in / ${(outTok / Math.max(1, preds.length)).toFixed(0)} out`,
    `  latency p50=${percentile(lat, 50) ?? 'n/a'}ms p95=${percentile(lat, 95) ?? 'n/a'}ms`,
  ];
  if (inPricePerM !== undefined && outPricePerM !== undefined) {
    const cost = (inTok * inPricePerM + outTok * outPricePerM) / 1e6;
    lines.push(`  estimated cost: $${cost.toFixed(4)} total, $${((cost / Math.max(1, preds.length)) * 1000).toFixed(3)} per 1,000 posts (from supplied prices)`);
  }
  return lines.join('\n');
}
