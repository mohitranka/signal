import type { BackgroundMessage } from '../shared/types';
import { ClassifyService } from './classifyService';
import { createHandler } from './handlers';
import { RepeatIndex } from './repeatIndex';
import { isExtensionPage, waiterIdOf } from './sender';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore, chromeKV } from './store';

// Keep the API key and feedback unreachable from content scripts, which share a process with the LinkedIn page.
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

const local = chromeKV(chrome.storage.local);
const settings = new SettingsStore(local);
const cache = new CacheStore(local);
const feedback = new FeedbackStore(local);
const stats = new StatsStore(chromeKV(chrome.storage.session));
const repeats = new RepeatIndex(local);
const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, repeats });

const handle = createHandler({
  service,
  settings,
  cache,
  feedback,
  stats,
  repeats,
  notifyTabs: () => {
    chrome.tabs
      .query({ url: ['https://www.linkedin.com/*'] })
      .then((tabs) => {
        for (const t of tabs) if (t.id !== undefined) chrome.tabs.sendMessage(t.id, { type: 'settingsChanged' }).catch(() => {});
      })
      .catch(() => {});
  },
});

chrome.runtime.onMessage.addListener((msg: BackgroundMessage, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  // Trust is decided by who sent it (our own extension page vs. anything else), not by whether it sits in a tab:
  // popup.html opened as a tab is still our page, and a content script always runs in a web page.
  const fromContent = !isExtensionPage(sender, chrome.runtime.getURL(''));
  handle(msg, fromContent, waiterIdOf(sender)).then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
  return true; // async response
});

// Flush the cache and the repeat index before the worker is suspended.
chrome.runtime.onSuspend?.addListener(() => {
  void cache.flush();
  void repeats.flush();
});
