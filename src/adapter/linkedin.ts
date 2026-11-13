import type { PostInput } from '../shared/types';

/**
 * ALL LinkedIn-specific DOM knowledge lives in this file. When LinkedIn changes its markup, repair
 * the selectors here; nothing else in the extension knows what a LinkedIn post looks like.
 *
 * Strategy: prefer semantic/attribute hooks (role, data-urn, data-testid) over hashed class names.
 * Two layouts are handled: the classic Ember feed (data-urn + .feed-shared-update-v2) and the
 * server-driven-UI feed (role="list" > role="listitem" with data-testid="expandable-text-box").
 * Selectors were taken from public reference implementations and are NOT verified against a live
 * session; see docs/architecture-decision.md.
 */

const SEL = {
  urnPost: '[data-urn^="urn:li:activity:"], [data-urn^="urn:li:share:"], [data-urn^="urn:li:ugcPost:"]',
  article: '[role="article"]',
  listItem: '[role="list"] [role="listitem"]',
  // Text bodies: SDUI first, then classic.
  textBox:
    '[data-testid="expandable-text-box"], .update-components-text, .feed-shared-update-v2__description, .feed-shared-inline-show-more-text',
  linkTitle: '.update-components-article__title, .update-components-entity__title, [data-testid="article-title"]',
  linkDescription: '.update-components-article__description, .update-components-entity__description',
  nestedPost: '[role="listitem"], [role="article"], [data-urn^="urn:li:activity:"], [data-urn^="urn:li:share:"], [data-urn^="urn:li:ugcPost:"]',
} as const;

export const MIN_TEXT_LENGTH = 20;

export interface ExtractedPost {
  /** LinkedIn's own identifier when present; used only to detect DOM-node reuse. */
  id: string | null;
  input: PostInput;
}

export interface FeedAdapter {
  findPosts(root: ParentNode): HTMLElement[];
  postId(el: HTMLElement): string | null;
  extract(el: HTMLElement): ExtractedPost | null;
}

/** Route check for "the main feed". Kept here because it is LinkedIn URL knowledge. */
export function isFeedRoute(loc: Pick<Location, 'pathname'>): boolean {
  return /^\/feed\/?$/.test(loc.pathname);
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'BUTTON', 'SVG', 'NOSCRIPT']);

/** textContent with line breaks preserved, skipping buttons ("…more") and scripts. Read-only. */
function textOf(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return '';
  if (el.tagName === 'BR') return '\n';
  let out = '';
  for (const child of Array.from(el.childNodes)) out += textOf(child);
  return BLOCK_TAGS.has(el.tagName) ? `\n${out}\n` : out;
}

const tidy = (s: string) =>
  s
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(?:…|\.\.\.)\s*(?:see\s+)?more\s*$/i, '')
    .trim();

function isPromoted(el: HTMLElement): boolean {
  for (const n of Array.from(el.querySelectorAll('span, p'))) {
    if (n.children.length === 0 && /^promoted$/i.test((n.textContent ?? '').trim())) return true;
  }
  return false;
}

/** Text bodies belonging to this post: not nested in another body, and not part of its comments. */
function ownTextBoxes(post: HTMLElement): HTMLElement[] {
  const all = Array.from(post.querySelectorAll<HTMLElement>(SEL.textBox));
  return all.filter((box) => {
    if (all.some((other) => other !== box && other.contains(box))) return false;
    const list = box.closest('[role="list"]');
    if (list && post.contains(list) && list !== post) return false; // inside a comments list
    return !box.closest('.comments-comments-list, .comments-comment-item');
  });
}

export const linkedinAdapter: FeedAdapter = {
  findPosts(root) {
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(`${SEL.urnPost}, ${SEL.article}, ${SEL.listItem}`));
    const posts = candidates.filter((el) => {
      // Outermost only: reshared originals and comments are nested inside their parent post.
      if (el.parentElement?.closest(SEL.nestedPost)) return false;
      return ownTextBoxes(el).length > 0;
    });
    return posts;
  },

  postId(el) {
    return el.getAttribute('data-urn') ?? el.querySelector('[data-urn]')?.getAttribute('data-urn') ?? el.getAttribute('componentkey');
  },

  extract(el) {
    if (isPromoted(el)) return null;
    const boxes = ownTextBoxes(el).map((b) => tidy(textOf(b))).filter(Boolean);
    const [main, ...rest] = boxes;
    if (!main || main.length < MIN_TEXT_LENGTH) return null;

    const input: PostInput = { text: main };
    if (rest.length) input.quoted = rest.join('\n---\n');
    const title = el.querySelector(SEL.linkTitle);
    const desc = el.querySelector(SEL.linkDescription);
    if (title) input.linkTitle = tidy(textOf(title));
    if (desc) input.linkDescription = tidy(textOf(desc));
    return { id: this.postId(el), input };
  },
};
