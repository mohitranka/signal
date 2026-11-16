/**
 * Is this message from one of Signal's own extension pages (the popup, possibly opened in a tab)?
 * Everything else, including a sender with no URL, is treated as a content script: content scripts share the
 * LinkedIn tab with LinkedIn's own scripts and only get the narrow content API.
 *
 * `extensionBase` is chrome.runtime.getURL(''), e.g. "chrome-extension://<id>/". The trailing slash matters:
 * it stops "chrome-extension://<id>.evil/..." from matching by prefix. `sender.origin` is authoritative when present.
 */
export function isExtensionPage(sender: chrome.runtime.MessageSender, extensionBase: string): boolean {
  const origin = extensionBase.replace(/\/+$/, '');
  if (sender.origin !== undefined) return sender.origin === origin;
  return typeof sender.url === 'string' && sender.url.startsWith(`${origin}/`);
}
