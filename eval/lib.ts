import { readFileSync } from 'node:fs';
import { coerceClassification } from '../src/classifier/parse';
import { FP_PATTERN } from '../src/shared/feedback';
import { REPEAT_THRESHOLD } from '../src/shared/similarity';
import type { PostInput } from '../src/shared/types';
import type { Metrics, Prediction, Row } from '../src/scoring';

// Scoring lives in src/scoring.ts so the extension popup runs the same code. Re-exported for eval/ callers.
export { score, type Metrics, type Prediction, type Row } from '../src/scoring';

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
      // Exported feedback carries the classification it corrected; validate it like live model output.
      if (r.classification !== undefined) {
        try {
          r.classification = coerceClassification(r.classification);
        } catch {
          throw new Error(`${path}:${i + 1}: bad classification`);
        }
      }
      if (r.family !== undefined && (typeof r.family !== 'string' || !r.family)) throw new Error(`${path}:${i + 1}: bad family`);
      // A correction on a copied verdict names the post it was copied from; both fields or neither.
      if (r.repeat_of !== undefined || r.repeat_similarity !== undefined) {
        if (typeof r.repeat_of !== 'string' || !FP_PATTERN.test(r.repeat_of)) throw new Error(`${path}:${i + 1}: bad repeat_of`);
        const s = r.repeat_similarity;
        if (typeof s !== 'number' || !Number.isFinite(s) || s < REPEAT_THRESHOLD || s > 1) throw new Error(`${path}:${i + 1}: bad repeat_similarity`);
      }
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
