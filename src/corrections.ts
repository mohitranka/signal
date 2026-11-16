import { parseRecord } from './classifier/parse';
import { score, type Prediction, type Row } from './scoring';
import { isVerdict } from './shared/feedback';
import type { ClassificationRecord, Decision, FeedbackEntry, Sensitivity } from './shared/types';

/**
 * "Your corrections": replay the user's feedback through the feed's own policy (via score(), shared with eval/)
 * to see, per sensitivity, what would have been wrongly hidden or missed. Pure and browser-safe.
 */

/** Below this many corrections on a side, that side's count is reported as too few to mean anything. */
export const MIN_PER_SIDE = 10;

const SENSITIVITIES: readonly Sensitivity[] = ['relaxed', 'balanced', 'strict'];

export type ExclusionReason = 'no-classification' | 'different-model' | 'different-prompt';

/** One correction: the user's label and, if stored, the classification it corrected (validated here). */
export interface CorrectionInput {
  id: string;
  label: Decision;
  record?: unknown;
}

export interface Excluded {
  id: string;
  reason: ExclusionReason;
  model?: string;
  promptVersion?: string;
}

export interface Target {
  model: string;
  promptVersion: string;
}

const toPrediction = (id: string, label: Decision, rec: ClassificationRecord): Prediction => ({
  row: { id, source: 'user-feedback', label, text: '' },
  classification: rec.classification,
});

/** Keep corrections whose classification came from the target model and prompt version; say why the rest were left out. */
export function partitionCorrections(items: CorrectionInput[], target: Target): { included: Prediction[]; excluded: Excluded[] } {
  const included: Prediction[] = [];
  const excluded: Excluded[] = [];
  for (const item of items) {
    const rec = parseRecord(item.record);
    if (!rec) excluded.push({ id: item.id, reason: 'no-classification' });
    else if (rec.model !== target.model) excluded.push({ id: item.id, reason: 'different-model', model: rec.model, promptVersion: rec.promptVersion });
    else if (rec.promptVersion !== target.promptVersion) excluded.push({ id: item.id, reason: 'different-prompt', model: rec.model, promptVersion: rec.promptVersion });
    else included.push(toPrediction(item.id, item.label, rec));
  }
  return { included, excluded };
}

export interface CorrectionGroup extends Target {
  included: Prediction[];
}

/** For the evaluator: one group per (model, prompt version), largest first. Only unusable rows are left out. */
export function groupCorrections(items: CorrectionInput[]): { groups: CorrectionGroup[]; excluded: Excluded[] } {
  const byKey = new Map<string, CorrectionGroup>();
  const excluded: Excluded[] = [];
  for (const item of items) {
    const rec = parseRecord(item.record);
    if (!rec) {
      excluded.push({ id: item.id, reason: 'no-classification' });
      continue;
    }
    const key = JSON.stringify([rec.model, rec.promptVersion]);
    let g = byKey.get(key);
    if (!g) byKey.set(key, (g = { model: rec.model, promptVersion: rec.promptVersion, included: [] }));
    g.included.push(toPrediction(item.id, item.label, rec));
  }
  const groups = [...byKey.values()].sort(
    (a, b) => b.included.length - a.included.length || a.model.localeCompare(b.model) || a.promptVersion.localeCompare(b.promptVersion),
  );
  return { groups, excluded };
}

export interface SensitivityRow {
  sensitivity: Sensitivity;
  /** Marked worth keeping (or highlight), but this sensitivity would collapse it. */
  wronglyHidden: number;
  /** Marked low quality, but this sensitivity would keep or highlight it. */
  missed: number;
}

export interface CorrectionReport {
  rows: SensitivityRow[];
  keptTotal: number;
  lowQualityTotal: number;
  hiddenMeaningful: boolean;
  missedMeaningful: boolean;
}

export function correctionReport(included: Prediction[]): CorrectionReport {
  let keptTotal = 0;
  let lowQualityTotal = 0;
  for (const p of included) {
    if (p.row.label === 'collapse') lowQualityTotal++;
    else keptTotal++;
  }
  const rows = SENSITIVITIES.map((sensitivity): SensitivityRow => {
    const c = score(included, sensitivity).confusion;
    return {
      sensitivity,
      wronglyHidden: c.keep.collapse + c.highlight.collapse,
      missed: c.collapse.keep + c.collapse.highlight,
    };
  });
  return { rows, keptTotal, lowQualityTotal, hiddenMeaningful: keptTotal >= MIN_PER_SIDE, missedMeaningful: lowQualityTotal >= MIN_PER_SIDE };
}

/** Stored feedback (new and older entries) as correction inputs, keyed by content fingerprint. */
export function feedbackToInputs(all: Record<string, FeedbackEntry>): CorrectionInput[] {
  // Entries with an invalid verdict are not corrections; skip them rather than let one bad entry break the report.
  return Object.entries(all)
    .filter(([, e]) => e && isVerdict(e.verdict))
    .map(([id, e]) => ({ id, label: e.verdict, ...(e.classified !== undefined ? { record: e.classified } : {}) }));
}

/** Exported / eval rows as correction inputs. */
export function rowsToInputs(rows: Row[]): CorrectionInput[] {
  return rows.map((r) =>
    r.classification !== undefined
      ? { id: r.id, label: r.label, record: { classification: r.classification, model: r.model, promptVersion: r.prompt_version } }
      : { id: r.id, label: r.label },
  );
}
