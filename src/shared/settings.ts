import type { PublicSettings, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  // Review mode first: classify and annotate, but never hide anything until the user opts in.
  mode: 'review',
  sensitivity: 'balanced',
  highlight: true,
  endpoint: 'https://openrouter.ai/api/v1',
  // Deliberately empty: no hardcoded model dependency.
  model: '',
  apiKey: '',
  concurrency: 3,
  timeoutMs: 30_000,
  jsonMode: true,
  inputPricePerM: null,
  outputPricePerM: null,
};

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

const price = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** Coerce untrusted/stale stored data into a valid Settings object. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const str = (k: string, fb: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : fb);
  const bool = (k: string, fb: boolean) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : fb);
  const sens = r.sensitivity;
  const mode = r.mode;
  return {
    enabled: bool('enabled', d.enabled),
    mode: mode === 'active' || mode === 'review' ? mode : d.mode,
    sensitivity: sens === 'relaxed' || sens === 'balanced' || sens === 'strict' ? sens : d.sensitivity,
    highlight: bool('highlight', d.highlight),
    endpoint: str('endpoint', d.endpoint).replace(/\/+$/, ''),
    model: str('model', d.model),
    apiKey: str('apiKey', d.apiKey),
    concurrency: clampInt(r.concurrency, 1, 8, d.concurrency),
    timeoutMs: clampInt(r.timeoutMs, 5_000, 120_000, d.timeoutMs),
    jsonMode: bool('jsonMode', d.jsonMode),
    inputPricePerM: price(r.inputPricePerM),
    outputPricePerM: price(r.outputPricePerM),
  };
}

export function toPublic(s: Settings): PublicSettings {
  const { apiKey, ...rest } = s;
  return { ...rest, hasApiKey: apiKey.length > 0 };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Returns a human-readable problem, or null if the LLM settings are usable. */
export function configProblem(s: Pick<Settings, 'endpoint' | 'model' | 'apiKey'>): string | null {
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    return 'Endpoint is not a valid URL.';
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    return 'Endpoint must be https:// (plain http is allowed only for localhost).';
  }
  if (!s.model) return 'No model configured.';
  if (!s.apiKey && !LOCAL_HOSTS.has(url.hostname)) return 'No API key configured.';
  return null;
}
