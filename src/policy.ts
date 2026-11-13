import type { Classification, Decision, Sensitivity } from './shared/types';

/**
 * Minimum model confidence required to act on a "collapse" verdict.
 * These are starting points, NOT calibrated probabilities: tune them with eval/ data
 * from the model you actually use.
 */
export const COLLAPSE_CONFIDENCE: Record<Sensitivity, number> = {
  relaxed: 0.95,
  balanced: 0.85,
  strict: 0.7,
};
export const HIGHLIGHT_CONFIDENCE = 0.8;

/** If the model itself scores reasoning/evidence at or above this, a collapse is treated as self-contradictory. */
const SUBSTANCE_VETO: Record<Sensitivity, number> = { relaxed: 0.5, balanced: 0.6, strict: 0.75 };

export interface PolicyOptions {
  sensitivity: Sensitivity;
  highlightEnabled: boolean;
}

export interface PolicyResult {
  outcome: Decision;
  /** What the model said, before thresholds/vetoes; shown in review mode. */
  modelDecision: Decision;
  reason: string;
}

export function decide(c: Classification, opts: PolicyOptions): PolicyResult {
  const base = { modelDecision: c.decision, reason: c.reason };
  const s = c.signals;

  if (c.decision === 'collapse') {
    const confident = c.confidence >= COLLAPSE_CONFIDENCE[opts.sensitivity];
    const hasSubstance = Math.max(s.evidence, s.reasoning) >= SUBSTANCE_VETO[opts.sensitivity];
    // Require positive evidence of noise, not merely absence of substance.
    const looksLikeNoise = Math.max(s.sensationalism, s.engagement_bait) >= 0.4 || s.originality <= 0.25;
    if (confident && !hasSubstance && looksLikeNoise) return { ...base, outcome: 'collapse' };
    return { ...base, outcome: 'keep' };
  }

  if (c.decision === 'highlight' && opts.highlightEnabled && c.confidence >= HIGHLIGHT_CONFIDENCE) {
    return { ...base, outcome: 'highlight' };
  }
  return { ...base, outcome: 'keep' };
}
