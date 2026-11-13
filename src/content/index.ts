import { isFeedRoute, linkedinAdapter } from '../adapter/linkedin';
import type { TabMessage } from '../shared/types';
import { FeedController } from './controller';
import { Presenter } from './presenter';

const controller = new FeedController({
  doc: document,
  adapter: linkedinAdapter,
  presenter: new Presenter(document),
  // async wrapper: a synchronous throw ("Extension context invalidated" after a reload) becomes a rejection the controller handles.
  send: async (msg) => chrome.runtime.sendMessage(msg),
  shouldRun: () => isFeedRoute(location),
});

let active = false;
async function syncRoute(): Promise<void> {
  const shouldRun = isFeedRoute(location);
  if (shouldRun && !active) {
    active = true;
    await controller.start();
  } else if (!shouldRun && active) {
    active = false;
    controller.stop();
  } else if (shouldRun && active) {
    // Client-side navigation back to the feed re-renders the list: drop stale work and rescan.
    controller.scan();
  }
}

// LinkedIn is a single-page app; detect route changes via the Navigation API with a polling fallback.
let lastHref = location.href;
const onNav = () => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  void syncRoute();
};
(globalThis as any).navigation?.addEventListener?.('navigatesuccess', onNav);
setInterval(onNav, 1000);

chrome.runtime.onMessage.addListener((msg: TabMessage, _sender, sendResponse) => {
  if (msg.type === 'settingsChanged') {
    void controller.onSettingsChanged();
  } else if (msg.type === 'getPageStats') {
    sendResponse(controller.pageStats());
  }
  return false;
});

void syncRoute();
