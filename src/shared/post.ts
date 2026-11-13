import type { PostInput } from './types';

export const LIMITS = { text: 3000, quoted: 1500, linkTitle: 200, linkDescription: 400 } as const;

const clean = (s: string | undefined, max: number): string | undefined => {
  if (!s) return undefined;
  const t = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) + '…' : t;
};

/** Normalize and truncate. What this returns is exactly what is fingerprinted and sent to the model. */
export function prepareInput(raw: PostInput): PostInput {
  const out: PostInput = { text: clean(raw.text, LIMITS.text) ?? '' };
  const quoted = clean(raw.quoted, LIMITS.quoted);
  const linkTitle = clean(raw.linkTitle, LIMITS.linkTitle);
  const linkDescription = clean(raw.linkDescription, LIMITS.linkDescription);
  if (quoted) out.quoted = quoted;
  if (linkTitle) out.linkTitle = linkTitle;
  if (linkDescription) out.linkDescription = linkDescription;
  return out;
}

const norm = (s: string | undefined) => (s ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Content fingerprint: identical content (e.g. the same post reshared) shares one cache entry. */
export async function fingerprint(input: PostInput): Promise<string> {
  const payload = JSON.stringify([norm(input.text), norm(input.quoted), norm(input.linkTitle), norm(input.linkDescription)]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
