import type { Classification, PostInput } from '../src/shared/types';

/**
 * Deliberately simple keyword/shape scorer, used only as a comparison point against the LLM.
 * Written once from general knowledge of LinkedIn noise; NOT tuned against eval/test.jsonl.
 * (The author had read eval/dev.jsonl, so dev numbers are optimistic for it; use test numbers.)
 */
const NOISE = [
  /\bagree\??/i, /comment (below|yes|'?\w+'?)/i, /\bshare if\b/i, /\btag (someone|your)/i, /drop a/i, /\bdm me\b/i,
  /game.?changer/i, /changes everything/i, /\bbreaking\b/i, /don't miss/i, /left behind/i, /\bnow\b[.!]/i, /\bobsolete\b/i,
  /will (blow|shock)/i, /\bhustle\b/i, /\b10x\b/i, /\bunpopular opinion\b/i, /hot take/i, /stay tuned/i, /are you ready/i,
  /\bwake up\b/i, /thrilled to announce/i, /revolutionary|groundbreaking/i, /mindset|grit/i, /everyone knows/i, /nobody (is )?talking/i,
];
const SUBSTANCE = [/\d/, /\bbecause\b/i, /\bhowever\b|\bbut\b/i, /\bwe (measured|found|saw|ran|moved)/i, /\bcaveat|limitation/i, /\bfix(ed)?\b/i, /\b(p99|p50|latency|benchmark|n=)/i];

export function baselineClassify(input: PostInput): Classification {
  const t = input.text;
  const noise = NOISE.filter((r) => r.test(t)).length + (t.match(/!/g)?.length ?? 0) * 0.5 + (/[\u{1F300}-\u{1FAFF}]/u.test(t) ? 1 : 0);
  const substance = SUBSTANCE.filter((r) => r.test(t)).length;
  const signals = { originality: 0.5, evidence: Math.min(1, substance / 4), reasoning: Math.min(1, substance / 4), usefulness: 0.5, sensationalism: Math.min(1, noise / 4), engagement_bait: Math.min(1, noise / 4) };
  if (noise >= 2 && substance <= 1) return { decision: 'collapse', confidence: 0.9, reason: 'keyword baseline: noise cues', signals };
  if (substance >= 4 && noise < 1) return { decision: 'highlight', confidence: 0.85, reason: 'keyword baseline: substance cues', signals };
  return { decision: 'keep', confidence: 0.5, reason: 'keyword baseline', signals };
}
