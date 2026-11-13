import { toPublic } from '../shared/settings';
import type { BackgroundMessage, Settings, StateResponse } from '../shared/types';
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

const CONTENT_TYPES = new Set(['classify', 'cancelAll', 'getState', 'setFeedback']);

/**
 * `fromContent` is true when the sender is a web-page content script. Content scripts run next to
 * third-party page code, so they may only use the narrow content API: never settings writes,
 * connection tests, or feedback export.
 */
export function createHandler(d: HandlerDeps) {
  return async function handle(msg: BackgroundMessage, fromContent: boolean): Promise<unknown> {
    if (fromContent && !CONTENT_TYPES.has(msg.type)) return { error: 'forbidden' };

    switch (msg.type) {
      case 'classify':
        return d.service.classify(msg.fp, msg.input);
      case 'cancelAll':
        d.service.cancelAll();
        return { ok: true };
      case 'getState': {
        const state: StateResponse = { settings: toPublic(await d.settings.load()), feedback: await d.feedback.verdicts() };
        return state;
      }
      case 'setFeedback':
        await d.feedback.set(msg.fp, msg.verdict, msg.sample, msg.modelDecision, msg.modelConfidence);
        return { ok: true };

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
