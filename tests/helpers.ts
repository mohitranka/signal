import type { Classification, Signals } from '../src/shared/types';
import type { KV } from '../src/background/store';

export const cls = (over: Omit<Partial<Classification>, 'signals'> & { signals?: Partial<Signals> } = {}): Classification => ({
  decision: 'keep',
  confidence: 0.9,
  reason: 'ok',
  ...over,
  signals: { originality: 0.5, evidence: 0.5, reasoning: 0.5, usefulness: 0.5, sensationalism: 0.1, engagement_bait: 0.1, ...over.signals },
});

export const noise = (confidence = 0.95) =>
  cls({ decision: 'collapse', confidence, reason: 'Generic motivation', signals: { originality: 0.1, evidence: 0.05, reasoning: 0.05, usefulness: 0.1, sensationalism: 0.5, engagement_bait: 0.7 } });

export const gem = (confidence = 0.9) =>
  cls({ decision: 'highlight', confidence, reason: 'Original measurements', signals: { originality: 0.9, evidence: 0.9, reasoning: 0.8, usefulness: 0.8, sensationalism: 0.05, engagement_bait: 0.05 } });

export const modelJson = (c: Classification) => JSON.stringify(c);

export function memoryKV(): KV & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (k) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async (items) => void Object.assign(data, structuredClone(items)),
    remove: async (k) => void delete data[k],
  };
}

export const chatResponse = (content: string, usage = { prompt_tokens: 100, completion_tokens: 40 }, init: ResponseInit = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, ...init });
