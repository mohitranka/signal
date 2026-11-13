import type { Classification, ErrorKind, PostInput } from '../shared/types';
import { buildMessages } from './prompt';
import { ParseError, parseClassification } from './parse';

export class ClassifierError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export interface ClientConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  jsonMode: boolean;
}

export interface ClientDeps {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface ClassifyOutcome {
  classification: Classification;
  promptTokens: number;
  completionTokens: number;
  httpRequests: number;
  latencyMs: number;
}

const MAX_RETRY_AFTER_MS = 30_000;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thrown internally when a provider rejects response_format; handled by retrying without it. */
class JsonModeRejected extends Error {}

function chatUrl(endpoint: string): string {
  return endpoint.replace(/\/+$/, '') + '/chat/completions';
}

async function errorSnippet(res: Response): Promise<string> {
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body) as { error?: { message?: unknown } | string };
      const m = typeof j.error === 'string' ? j.error : j.error?.message;
      if (typeof m === 'string') return m.slice(0, 200);
    } catch {
      /* not JSON */
    }
    return body.slice(0, 200);
  } catch {
    return '';
  }
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) ? Math.max(0, secs * 1000) : undefined;
}

async function attempt(
  cfg: ClientConfig,
  input: PostInput,
  jsonMode: boolean,
  deps: ClientDeps,
): Promise<Omit<ClassifyOutcome, 'httpRequests' | 'latencyMs'>> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, cfg.timeoutMs);

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: buildMessages(input),
    temperature: 0,
    max_tokens: 600,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  try {
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(chatUrl(cfg.endpoint), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
        credentials: 'omit',
      });
      if (res.ok) text = await res.text();
      else text = '';
    } catch (e) {
      if (deps.signal?.aborted) throw new ClassifierError('aborted', 'Request cancelled.');
      if (timedOut) throw new ClassifierError('timeout', `No response within ${cfg.timeoutMs} ms.`, true);
      throw new ClassifierError('network', `Network error: ${(e as Error).message}`, true);
    }

    if (!res.ok) {
      const snippet = await errorSnippet(res);
      const s = res.status;
      if (s === 401 || s === 403) throw new ClassifierError('auth', `Authentication failed (${s}). ${snippet}`);
      if (s === 429) {
        const ra = retryAfterMs(res);
        throw new ClassifierError('rate_limit', 'Rate limited by provider.', ra === undefined || ra <= MAX_RETRY_AFTER_MS, ra);
      }
      if (s === 408) throw new ClassifierError('timeout', 'Provider timed out.', true);
      if (s >= 500) throw new ClassifierError('server', `Provider error ${s}. ${snippet}`, true);
      if (s === 400 && jsonMode) throw new JsonModeRejected();
      throw new ClassifierError('config', `Request rejected (${s}). ${snippet}`);
    }

    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ClassifierError('parse', 'Provider response was not JSON.', true);
    }
    if (payload?.error) {
      const code = Number(payload.error.code);
      if (code === 429) throw new ClassifierError('rate_limit', 'Rate limited by provider.', true);
      if (code === 401 || code === 403) throw new ClassifierError('auth', 'Authentication failed.');
      throw new ClassifierError('server', `Provider error: ${String(payload.error.message ?? '').slice(0, 200)}`, true);
    }
    const content = payload?.choices?.[0]?.message?.content;
    const raw =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
          : '';
    try {
      return {
        classification: parseClassification(raw),
        promptTokens: Number(payload?.usage?.prompt_tokens) || 0,
        completionTokens: Number(payload?.usage?.completion_tokens) || 0,
      };
    } catch (e) {
      if (e instanceof ParseError) throw new ClassifierError('parse', e.message, true);
      throw e;
    }
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Classify one post with bounded retries (exponential backoff + jitter, honouring Retry-After).
 * Never logs request payloads or credentials.
 */
export async function classifyPost(cfg: ClientConfig, input: PostInput, deps: ClientDeps = {}): Promise<ClassifyOutcome> {
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? 2;
  const started = Date.now();
  let jsonMode = cfg.jsonMode;
  let httpRequests = 0;

  for (let n = 0; ; n++) {
    httpRequests++;
    try {
      const r = await attempt(cfg, input, jsonMode, deps);
      return { ...r, httpRequests, latencyMs: Date.now() - started };
    } catch (e) {
      if (e instanceof JsonModeRejected) {
        jsonMode = false; // provider has no response_format support; retry once without it
        n--;
        continue;
      }
      if (!(e instanceof ClassifierError) || !e.retryable || n >= maxRetries) {
        if (e instanceof ClassifierError) throw e;
        throw new ClassifierError('network', (e as Error).message);
      }
      const backoff = Math.min(8000, 1000 * 2 ** n) + Math.floor(Math.random() * 250);
      await sleep(e.retryAfterMs ?? backoff);
      if (deps.signal?.aborted) throw new ClassifierError('aborted', 'Request cancelled.');
    }
  }
}
