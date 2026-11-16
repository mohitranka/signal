import { decide } from './policy';
import type { Classification, Decision, Sensitivity } from './shared/types';

/**
 * Scoring shared by the evaluator (eval/) and the popup's "Your corrections" panel.
 * Pure and browser-safe: no Node imports, so the extension bundles the same code eval/ runs.
 */

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
  /** Exported feedback only: the classification the user corrected, and what produced it. */
  classification?: Classification;
  model?: string;
  prompt_version?: string;
  model_decision?: Decision;
  model_confidence?: number;
  at?: string;
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
