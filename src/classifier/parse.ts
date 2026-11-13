import { DECISIONS, SIGNAL_NAMES, type Classification, type Decision, type Signals } from '../shared/types';

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
  const obj = extractJson(raw);
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
