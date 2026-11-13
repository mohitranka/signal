import type { BackgroundMessage } from '../shared/types';
import { ClassifyService } from './classifyService';
import { createHandler } from './handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore, chromeKV } from './store';

// Keep the API key and feedback unreachable from content scripts, which share a process with the LinkedIn page.
void chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

const local = chromeKV(chrome.storage.local);
const settings = new SettingsStore(local);
const cache = new CacheStore(local);
const feedback = new FeedbackStore(local);
const stats = new StatsStore(chromeKV(chrome.storage.session));
const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats });

const handle = createHandler({
  service,
  settings,
  cache,
  feedback,
  stats,
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
  handle(msg, sender.tab !== undefined).then(sendResponse, (e: Error) => sendResponse({ error: e.message }));
  return true; // async response
});

// Flush the cache before the worker is suspended.
chrome.runtime.onSuspend?.addListener(() => void cache.flush());
