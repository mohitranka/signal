import { FP_PATTERN, isVerdict } from '../shared/feedback';
import { toPublic } from '../shared/settings';
import { fingerprint, isPostInput, prepareInput } from '../shared/post';
import type { BackgroundMessage, ClassifyResult, Settings, StateResponse } from '../shared/types';
import type { ClassifyService } from './classifyService';
import type { RepeatIndex } from './repeatIndex';
import type { CacheStore, FeedbackStore, SettingsStore, StatsStore } from './store';

export interface HandlerDeps {
  service: ClassifyService;
  settings: SettingsStore;
  cache: CacheStore;
  feedback: FeedbackStore;
  stats: StatsStore;
  /** Signatures of judged posts (repeated templates). Cleared together with the cache. */
  repeats?: RepeatIndex;
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
        // Finding I: the cancel ticket is taken on arrival, before the await below, so a cancel that arrives while the
        // fingerprint is being checked still reaches this request.
        const ticket = d.service.ticket(waiter);
        // The content script already did this; redo it so a compromised content script cannot send oversized posts
        // (spending the user's API budget) or file one post's verdict under another post's fingerprint.
        if (typeof msg.fp !== 'string' || !FP_PATTERN.test(msg.fp)) return invalid('Malformed fingerprint.');
        if (!isPostInput(msg.input)) return invalid('Malformed post input.');
        const input = prepareInput(msg.input);
        if (typeof msg.fp !== 'string' || msg.fp !== (await fingerprint(input))) return invalid('Fingerprint does not match the post.');
        // Only a literal `true` opts out of copying; the background alone computes signatures and decides on copies.
        return d.service.classify(msg.fp, input, waiter, { noRepeat: msg.noRepeat === true, ticket });
      }
      case 'cancelAll':
        // From a content script: only the sender's own tab's work (security S7). The tab is taken from Chrome's sender
        // record (waiter), never from the message. The global cancel is for Clear cache and model changes.
        if (fromContent) d.service.cancelWaiter(waiter);
        else d.service.cancelAll();
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
        const patch: Partial<Settings> = { ...msg.patch };
        // A save that may change where posts are sent holds model calls from the moment it arrives (before the first
        // await) until it is written, then cancels everything prepared under the old settings if they changed
        // (docs/design-finding-a2-save-window.md). Toggles (mode, sensitivity, ...) hold nothing.
        const touchesModel = 'model' in patch || 'endpoint' in patch || 'apiKey' in patch;
        const release = touchesModel ? d.service.hold() : () => {};
        let after: Settings;
        try {
          const before = await d.settings.load();
          // An empty apiKey in a patch means "unchanged"; the popup never sees the stored key.
          if (!patch.apiKey) delete patch.apiKey;
          after = await d.settings.save(patch);
          if (before.model !== after.model || before.endpoint !== after.endpoint || before.apiKey !== after.apiKey) {
            d.service.cancelAll();
          }
        } finally {
          release(); // also when the save fails: the old settings are then still the stored ones
        }
        d.notifyTabs();
        return toPublic(after);
      }
      case 'testConnection':
        return d.service.testConnection();
      case 'getStats': {
        const s = await d.settings.load();
        return {
          stats: await d.stats.get(),
          cacheSize: await d.cache.size(),
          repeatIndexSize: (await d.repeats?.size()) ?? 0,
          prices: { input: s.inputPricePerM, output: s.outputPricePerM },
        };
      }
      case 'listFeedback':
        return d.feedback.all();
      case 'clearFeedback':
        await d.feedback.clear();
        d.notifyTabs();
        return { ok: true };
      case 'clearCache':
        await d.cache.clear();
        await d.repeats?.clear();
        d.service.cancelAll();
        d.notifyTabs();
        return { ok: true };
      default:
        return { error: 'unknown message' };
    }
  };
}
