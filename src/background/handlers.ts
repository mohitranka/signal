import { FP_PATTERN, isVerdict } from '../shared/feedback';
import { toPublic } from '../shared/settings';
import { fingerprint, isPostInput, prepareInput } from '../shared/post';
import type { BackgroundMessage, ClassifyResult, Settings, StateResponse } from '../shared/types';
import type { ClassifyService } from './classifyService';
import type { CacheStore, FeedbackStore, SettingsStore, StatsStore } from './store';

export interface HandlerDeps {
  service: ClassifyService;
  settings: SettingsStore;
  cache: CacheStore;
  feedback: FeedbackStore;
  stats: StatsStore;
  /** Tell open LinkedIn tabs that settings or feedback changed. */
  notifyTabs: () => void;
}

const CONTENT_TYPES = new Set(['classify', 'cancelAll', 'cancel', 'getState', 'setFeedback']);

const invalid = (message: string): ClassifyResult => ({ ok: false, kind: 'invalid', message });

/**
 * `fromContent` is true when the sender is a web-page content script. Content scripts run next to
 * third-party page code, so they may only use the narrow content API: never settings writes,
 * connection tests, or feedback export.
 */
export function createHandler(d: HandlerDeps) {
  /** `waiter` identifies the sender (see waiterIdOf) so `cancel` only releases that sender's own interest. */
  return async function handle(msg: BackgroundMessage, fromContent: boolean, waiter = 'unknown'): Promise<unknown> {
    if (fromContent && !CONTENT_TYPES.has(msg.type)) return { error: 'forbidden' };

    switch (msg.type) {
      case 'classify': {
        // The content script already did this; redo it so a compromised content script cannot send oversized posts
        // (spending the user's API budget) or file one post's verdict under another post's fingerprint.
        if (typeof msg.fp !== 'string' || !FP_PATTERN.test(msg.fp)) return invalid('Malformed fingerprint.');
        if (!isPostInput(msg.input)) return invalid('Malformed post input.');
        const input = prepareInput(msg.input);
        if (typeof msg.fp !== 'string' || msg.fp !== (await fingerprint(input))) return invalid('Fingerprint does not match the post.');
        return d.service.classify(msg.fp, input, waiter);
      }
      case 'cancelAll':
        d.service.cancelAll();
        return { ok: true };
      case 'cancel':
        if (typeof msg.fp !== 'string' || !FP_PATTERN.test(msg.fp)) return { error: 'bad fingerprint' };
        await d.service.cancel(msg.fp, waiter);
        return { ok: true };
      case 'getState': {
        // Feedback trouble (e.g. storage errors) must not stop the feed from working: fall back to no corrections.
        const feedback = await d.feedback.verdicts().catch(() => ({}));
        const state: StateResponse = { settings: toPublic(await d.settings.load()), feedback };
        return state;
      }
      case 'setFeedback': {
        if (typeof msg.fp !== 'string' || !FP_PATTERN.test(msg.fp)) return { error: 'bad fingerprint' };
        if (msg.verdict !== null && !isVerdict(msg.verdict)) return { error: 'bad verdict' };
        const saved = await d.feedback.set(msg.fp, msg.verdict, String(msg.sample ?? ''), {
          modelDecision: msg.modelDecision,
          modelConfidence: msg.modelConfidence,
          classified: msg.classified,
        });
        return saved ? { ok: true } : { error: 'feedback-full' };
      }

      case 'getSettings':
        return toPublic(await d.settings.load());
      case 'saveSettings': {
        const before = await d.settings.load();
        // An empty apiKey in a patch means "unchanged"; the popup never sees the stored key.
        const patch: Partial<Settings> = { ...msg.patch };
        if (!patch.apiKey) delete patch.apiKey;
        const after = await d.settings.save(patch);
        if (before.model !== after.model || before.endpoint !== after.endpoint || before.apiKey !== after.apiKey) {
          d.service.cancelAll();
        }
        d.notifyTabs();
        return toPublic(after);
      }
      case 'testConnection':
        return d.service.testConnection();
      case 'getStats': {
        const s = await d.settings.load();
        return { stats: await d.stats.get(), cacheSize: await d.cache.size(), prices: { input: s.inputPricePerM, output: s.outputPricePerM } };
      }
      case 'listFeedback':
        return d.feedback.all();
      case 'clearFeedback':
        await d.feedback.clear();
        d.notifyTabs();
        return { ok: true };
      case 'clearCache':
        await d.cache.clear();
        d.service.cancelAll();
        d.notifyTabs();
        return { ok: true };
      default:
        return { error: 'unknown message' };
    }
  };
}
