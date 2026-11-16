import { DECISIONS, SIGNAL_NAMES, type Classification, type ClassificationRecord, type Decision, type Signals } from '../shared/types';

export class ParseError extends Error {}

function extractJson(raw: string): unknown {
  const text = raw.trim();
  const candidates = [text];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  throw new ParseError('Model output is not valid JSON.');
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Strictly validate model output. Anything malformed throws ParseError so the caller fails open. */
export function parseClassification(raw: string): Classification {
  return coerceClassification(extractJson(raw));
}

/**
 * Validate an already-parsed object with the same rules as model output, returning a clean copy
 * (unknown fields dropped). Used for live model replies, stored feedback records and exported files.
 */
export function coerceClassification(obj: unknown): Classification {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ParseError('Model output is not an object.');
  const o = obj as Record<string, unknown>;

  if (typeof o.decision !== 'string' || !DECISIONS.includes(o.decision as Decision)) {
    throw new ParseError('Invalid or missing "decision".');
  }
  if (!isNum(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    throw new ParseError('"confidence" must be a number in [0,1].');
  }
  const reason = typeof o.reason === 'string' ? o.reason.replace(/\s+/g, ' ').trim().slice(0, 200) : '';

  const rawSignals = o.signals && typeof o.signals === 'object' ? (o.signals as Record<string, unknown>) : {};
  const signals = {} as Signals;
  for (const name of SIGNAL_NAMES) {
    const v = rawSignals[name];
    // A missing signal is neutral (0.5) so it neither unlocks nor blocks a collapse by itself.
    signals[name] = isNum(v) ? clamp01(v) : 0.5;
  }
  return { decision: o.decision as Decision, confidence: o.confidence, reason, signals };
}

const MAX_MODEL_LENGTH = 200;
const MAX_PROMPT_VERSION_LENGTH = 32;
/**
 * C0/C1 control characters and bidi controls (LRM/RLM, embeddings/overrides, isolates). They have no place in a
 * model name or prompt version, and can spoof what is displayed or inject terminal escapes when printed.
 */
export const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, 'g');
/** Replace unsafe characters (see UNSAFE_TEXT) with "?" before printing untrusted text. */
export const printable = (s: string): string => s.replace(UNSAFE_TEXT_ALL, '?');

const shortString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !UNSAFE_TEXT.test(v);

/**
 * Validate a stored classification record ({classification, model, promptVersion}) from an untrusted source
 * (a content-script message, storage written by another version, an exported file).
 * Returns a clean copy, or null if anything is malformed.
 */
export function parseRecord(x: unknown): ClassificationRecord | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (!shortString(r.model, MAX_MODEL_LENGTH) || !shortString(r.promptVersion, MAX_PROMPT_VERSION_LENGTH)) return null;
  try {
    return { classification: coerceClassification(r.classification), model: r.model, promptVersion: r.promptVersion };
  } catch {
    return null;
  }
}
