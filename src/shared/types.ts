export type Decision = 'highlight' | 'keep' | 'collapse';
export const DECISIONS: readonly Decision[] = ['highlight', 'keep', 'collapse'];

export const SIGNAL_NAMES = [
  'originality',
  'evidence',
  'reasoning',
  'usefulness',
  'sensationalism',
  'engagement_bait',
] as const;
export type SignalName = (typeof SIGNAL_NAMES)[number];
export type Signals = Record<SignalName, number>;

/** Raw model verdict. Presentation (collapse/highlight/keep) is derived by policy.ts. */
export interface Classification {
  decision: Decision;
  /** Model's self-estimate. NOT a calibrated probability. */
  confidence: number;
  reason: string;
  signals: Signals;
}

/** A classification together with what produced it. Feedback keeps one so corrections can be re-scored offline. */
export interface ClassificationRecord {
  classification: Classification;
  model: string;
  promptVersion: string;
}

/** Everything about a post that is ever sent to the model. Untrusted third-party text. */
export interface PostInput {
  text: string;
  quoted?: string;
  linkTitle?: string;
  linkDescription?: string;
}

export type Sensitivity = 'relaxed' | 'balanced' | 'strict';
export type Mode = 'review' | 'active';

export interface Settings {
  enabled: boolean;
  mode: Mode;
  sensitivity: Sensitivity;
  highlight: boolean;
  endpoint: string;
  model: string;
  apiKey: string;
  concurrency: number;
  timeoutMs: number;
  /** Send response_format=json_object. Auto-disabled per request if the provider rejects it. */
  jsonMode: boolean;
  /** Optional USD per 1M tokens, used only for the cost estimate in the popup. */
  inputPricePerM: number | null;
  outputPricePerM: number | null;
}

/** Settings as exposed to content scripts and the popup: the API key never leaves the background. */
export type PublicSettings = Omit<Settings, 'apiKey'> & { hasApiKey: boolean };

export type ErrorKind =
  | 'config'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'parse'
  | 'aborted'
  /** Rejected by the background: malformed input, or a fingerprint that does not match it. */
  | 'invalid';

export type ClassifyResult =
  | { ok: true; classification: Classification; cached: boolean; model: string; promptVersion: string }
  | { ok: false; kind: ErrorKind; message: string };

export type Verdict = 'keep' | 'collapse';

export interface FeedbackEntry {
  verdict: Verdict;
  at: number;
  /** Local copy of the post text so feedback can be reviewed and exported as labeled data. */
  sample: string;
  modelDecision?: Decision;
  modelConfidence?: number;
  /** The full classification this entry corrected. Absent on entries saved by older versions. */
  classified?: ClassificationRecord;
}

export interface Stats {
  httpRequests: number;
  classified: number;
  cacheHits: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  totalLatencyMs: number;
}

export interface PageStats {
  tracked: number;
  classified: number;
  collapsed: number;
  highlighted: number;
  failed: number;
}

/** content script -> background */
export type ContentMessage =
  | { type: 'classify'; fp: string; input: PostInput }
  | { type: 'cancelAll' }
  /** The post's text grew: this fingerprint's request is no longer needed by this caller. */
  | { type: 'cancel'; fp: string }
  | { type: 'getState' }
  | {
      type: 'setFeedback';
      fp: string;
      verdict: Verdict | null;
      sample: string;
      modelDecision?: Decision;
      modelConfidence?: number;
      /** Validated by the background before it is stored. */
      classified?: ClassificationRecord;
    };

/** popup -> background (extension pages only) */
export type PopupMessage =
  | { type: 'getSettings' }
  | { type: 'saveSettings'; patch: Partial<Settings> }
  | { type: 'testConnection' }
  | { type: 'getStats' }
  | { type: 'listFeedback' }
  | { type: 'clearFeedback' }
  | { type: 'clearCache' };

export type BackgroundMessage = ContentMessage | PopupMessage;

/** background/popup -> content script */
export type TabMessage = { type: 'settingsChanged' } | { type: 'getPageStats' };

export interface StateResponse {
  settings: PublicSettings;
  feedback: Record<string, Verdict>;
}
