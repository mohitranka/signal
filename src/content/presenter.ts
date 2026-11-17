import type { Decision } from '../shared/types';

export interface View {
  outcome: Decision;
  source: 'model' | 'user';
  reason: string;
  /** What the model actually said, shown in review mode. */
  modelDecision?: Decision;
  confidence?: number;
  /** Review mode annotates but never hides model-decided posts. */
  review: boolean;
  /** User pressed "Show post" on a collapsed post, or (see visibleBecause) the post is kept visible for them. */
  revealed: boolean;
  /**
   * Why a collapse verdict is not hiding the post: the user revealed it ("Collapsed by Signal · Hide again"), or
   * expanded it to read and it was never hidden ("Signal would collapse this · Hide"). Defaults to 'revealed'.
   */
  visibleBecause?: 'revealed' | 'expanded';
  /**
   * The model verdict was copied from a similar post (docs/design-repeats.md). `judging`: the user asked for this
   * post's own verdict and it has not arrived yet.
   */
  repeat?: { similarity: number; judging: boolean };
}

export interface Actions {
  show(): void;
  hide(): void;
  keep(): void;
  lowQuality(): void;
  undo(): void;
  /** Ask the model about this post itself instead of using the verdict copied from a similar post. */
  judgeSeparately(): void;
}

const CSS = `
:host { all: initial; display: block; }
.bar {
  --fg: #5e6670; --strong: #1c1f23; --surface: #ffffff; --border: #e0e3e7; --hover: #f1f3f5;
  --accent: #2f7d6d; --danger: #c2413a; --neutral: #a4abb3; --focus: #0a66c2;
  font: 12.5px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: var(--fg);
  display: flex; align-items: center; gap: 10px; padding: 6px 4px;
}
.label { display: inline-flex; align-items: center; gap: 7px; font-weight: 600; color: var(--strong); white-space: nowrap; }
.label::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--dot, var(--neutral)); flex: none; }
.reason { flex: 1 1 auto; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
button {
  all: unset; cursor: pointer; white-space: nowrap; font-weight: 600; font-size: 12px; color: var(--strong);
  padding: 4px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface);
}
button:first-of-type { margin-left: auto; }
button:hover { background: var(--hover); }
button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.bar.collapsed { --dot: var(--danger); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px 10px 14px; margin: 0 0 8px; }
.review.highlight { --dot: var(--accent); }
.review.collapse { --dot: var(--danger); }
.bar.quiet { justify-content: flex-end; padding: 0 4px 4px; }
/* Quiet through size, weight and no border or fill at rest; never through opacity (finding G: text stays >= 4.5:1). */
.bar.quiet button { font-weight: 500; font-size: 11.5px; padding: 2px 10px; color: var(--fg); background: transparent; border-color: transparent; transition: color .12s, background-color .12s, border-color .12s; }
.bar.quiet button:hover, .bar.quiet button:focus-visible { color: var(--strong); background: var(--surface); border-color: var(--neutral); }
.bar.has-note { flex-wrap: wrap; row-gap: 2px; }
.bar.has-note .reason { flex: 1 1 0; }
.bar .note { flex: 1 0 100%; order: 10; font-size: 11.5px; color: var(--fg); padding-left: 15px; }
.bar .note::before { content: "≈"; font-weight: 700; margin-right: 5px; margin-left: -12px; }
.bar .note .link { all: unset; cursor: pointer; font-weight: 600; color: var(--strong); text-decoration: underline; text-decoration-color: var(--border); text-underline-offset: 2px; }
.bar .note .link:hover { text-decoration-color: currentColor; }
.bar .note .link:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; border-radius: 2px; }
.bar .note .busy { font-weight: 600; }
.bar.quiet.has-note { flex-wrap: nowrap; }
.bar.quiet .note { flex: 1 1 auto; order: 0; padding-left: 12px; font-size: 11px; }
@media (prefers-color-scheme: dark) {
  .bar { --fg: #a9b0b8; --strong: #e7e9ec; --surface: #1e2226; --border: #363b41; --hover: #2a2f34; --accent: #5cbfa8; --danger: #ff8a80; --neutral: #6f7680; --focus: #70b5f9; }
}
`;

/**
 * Tooltip for a post Signal kept in review mode. The confidence is the model's confidence in ITS decision,
 * which can be collapse or highlight even though the post was kept (below a threshold, vetoed by the policy,
 * or highlighting turned off). Say only what is known; never imply the model was confident the post was fine.
 */
function keptSummary(view: View): string {
  const pct = view.confidence !== undefined ? `${Math.round(view.confidence * 100)}%` : '';
  const reason = view.reason ? `: ${view.reason}` : '';
  const copied = view.repeat ? ` · ${REPEAT_NOTE} (${similarPct(view.repeat.similarity)} similar)` : '';
  if (view.modelDecision === 'collapse') return `Kept, although the model rated it low quality${pct ? ` (${pct})` : ''}${reason}${copied}`;
  if (view.modelDecision === 'highlight') return `Kept, although the model rated it a standout${pct ? ` (${pct})` : ''}${reason}${copied}`;
  return `Kept${pct ? ` (model ${pct} confident)` : ''}${reason}${copied}`;
}

const REPEAT_NOTE = 'Same template as a post judged earlier';
const similarPct = (s: number) => `${Math.round(s * 100)}%`;

/** Is this view rendered as a hidden (collapsed) post? Shared with the controller's tab statistics. */
export const isCollapsedView = (view: View): boolean =>
  view.outcome === 'collapse' && !view.revealed && (view.source === 'user' || !view.review);

/** Is this view rendered with the highlight edge? (Review mode only annotates.) */
export const isHighlightedView = (view: View): boolean => view.outcome === 'highlight' && !view.review;

export const ATTR_HIDDEN = 'data-signal-hidden';

/**
 * Shadow roots are closed so LinkedIn's page scripts cannot read Signal's verdicts or reach its buttons.
 * Signal keeps its own references here. (Content-script module scope is not reachable from the page.)
 */
const roots = new WeakMap<Element, ShadowRoot>();
export const shadowRootOf = (host: Element): ShadowRoot | undefined => roots.get(host);

export interface PresenterOptions {
  /** Accept only clicks from real user input, so page scripts cannot press Signal's buttons. Injectable for jsdom tests. */
  isTrusted?: (e: Event) => boolean;
}
export const ATTR_STATE = 'data-signal';

export class Presenter {
  private hosts = new Map<HTMLElement, { host: HTMLElement; root: ShadowRoot }>();
  private sheet: CSSStyleSheet | null = null;

  private isTrusted: (e: Event) => boolean;

  constructor(
    private doc: Document,
    opts: PresenterOptions = {},
  ) {
    this.isTrusted = opts.isTrusted ?? ((e) => e.isTrusted);
  }

  /** Render a view, or remove every trace of Signal when view is null. */
  apply(post: HTMLElement, view: View | null, actions: Actions): void {
    if (!view) return this.clear(post);

    const collapsed = isCollapsedView(view);
    const highlighted = isHighlightedView(view);

    if (collapsed) post.setAttribute(ATTR_HIDDEN, '');
    else post.removeAttribute(ATTR_HIDDEN);

    if (highlighted) {
      post.setAttribute(ATTR_STATE, 'highlight');
      post.title = `Signal: ${view.reason}`;
    } else {
      post.removeAttribute(ATTR_STATE);
      if (post.title.startsWith('Signal: ')) post.removeAttribute('title');
    }

    const needsBar = collapsed || view.revealed || view.source === 'user' || view.review;
    if (!needsBar) return this.removeHost(post);

    const { root } = this.ensureHost(post);
    root.querySelector('.bar')?.remove();
    root.appendChild(this.buildBar(view, collapsed, actions));
  }

  clear(post: HTMLElement): void {
    post.removeAttribute(ATTR_HIDDEN);
    post.removeAttribute(ATTR_STATE);
    if (post.title.startsWith('Signal: ')) post.removeAttribute('title');
    this.removeHost(post);
  }

  /** Drop bars whose post LinkedIn removed from the DOM (virtualized feed). */
  prune(): void {
    for (const [post, { host }] of this.hosts) {
      if (!post.isConnected) {
        host.remove();
        this.hosts.delete(post);
      }
    }
  }

  private removeHost(post: HTMLElement): void {
    this.hosts.get(post)?.host.remove();
    this.hosts.delete(post);
  }

  private ensureHost(post: HTMLElement): { host: HTMLElement; root: ShadowRoot } {
    const existing = this.hosts.get(post);
    if (existing && existing.host.isConnected) return existing;
    const host = this.doc.createElement('div');
    host.setAttribute('data-signal-bar', '');
    const root = host.attachShadow({ mode: 'closed' });
    roots.set(host, root);
    this.attachStyles(root);
    post.insertAdjacentElement('beforebegin', host);
    const entry = { host, root };
    this.hosts.set(post, entry);
    return entry;
  }

  private attachStyles(root: ShadowRoot): void {
    try {
      if (!this.sheet) {
        this.sheet = new CSSStyleSheet();
        this.sheet.replaceSync(CSS);
      }
      root.adoptedStyleSheets = [this.sheet];
    } catch {
      // Environments without constructable stylesheets.
      const style = this.doc.createElement('style');
      style.textContent = CSS;
      root.appendChild(style);
    }
  }

  private buildBar(view: View, collapsed: boolean, a: Actions): HTMLElement {
    const el = (tag: string, cls?: string, text?: string) => {
      const n = this.doc.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text; // textContent only: reasons are model output derived from untrusted posts
      return n;
    };
    const btn = (label: string, fn: () => void) => {
      const b = el('button', undefined, label);
      b.setAttribute('type', 'button');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!this.isTrusted(e)) return; // synthetic click from a page script
        fn();
      });
      return b;
    };

    const bar = el('div', 'bar');
    const reason = (t: string) => bar.appendChild(el('span', 'reason', t));
    /**
     * A model verdict copied from a similar post: a second row (outside the 2-line-clamped reason) saying so, with
     * "Judge separately" (or "Judging…" while that is under way). Never on a post you marked: your mark decides.
     */
    const repeat = view.source === 'model' ? view.repeat : undefined;
    const note = () => {
      if (!repeat) return;
      const pct = similarPct(repeat.similarity);
      const n = el('span', 'note', `${REPEAT_NOTE} · `);
      n.title = `Verdict copied from a post that is ${pct} similar. No model call was made for this post.`;
      if (repeat.judging) {
        n.appendChild(el('span', 'busy', 'Judging…'));
      } else {
        const b = btn('Judge separately', a.judgeSeparately);
        b.className = 'link';
        b.setAttribute('aria-label', `Judge separately. Verdict copied from a post that is ${pct} similar.`);
        n.appendChild(b);
      }
      bar.classList.add('has-note');
      bar.appendChild(n);
    };

    if (collapsed) {
      bar.classList.add('collapsed');
      bar.appendChild(el('span', 'label', 'Post collapsed'));
      reason(view.source === 'user' ? 'You marked this low quality.' : view.reason || 'Low-quality post.');
      bar.appendChild(btn('Show post', a.show));
      if (view.source === 'model') {
        bar.appendChild(btn('Worth keeping', a.keep));
      } else {
        bar.appendChild(btn('Undo', a.undo));
      }
      note();
      return bar;
    }

    if (view.source === 'user') {
      bar.appendChild(el('span', 'label', view.outcome === 'collapse' ? 'Marked low quality' : 'Marked worth keeping'));
      if (view.outcome === 'collapse') bar.appendChild(btn('Hide again', a.hide));
      bar.appendChild(btn('Undo', a.undo));
      return bar;
    }

    if (view.revealed) {
      const expanded = view.visibleBecause === 'expanded';
      bar.appendChild(el('span', 'label', expanded ? 'Signal would collapse this' : 'Collapsed by Signal'));
      reason(view.reason);
      bar.appendChild(btn(expanded ? 'Hide' : 'Hide again', a.hide));
      bar.appendChild(btn('Worth keeping', a.keep));
      note();
      return bar;
    }

    // Review mode, model kept the post: no annotation text, just a quiet way to mark it low quality.
    // The verdict and reason stay available on hover and to screen readers.
    if (view.outcome === 'keep') {
      bar.classList.add('quiet');
      note(); // on the left of the quiet row
      const summary = keptSummary(view);
      const b = btn('Low quality', a.lowQuality);
      b.title = summary; // attribute text, never parsed as HTML
      b.setAttribute('aria-label', `Mark low quality. ${summary}`);
      bar.appendChild(b);
      return bar;
    }

    // Review-mode annotation for a verdict Signal would act on.
    bar.classList.add('review', view.outcome);
    const pct = view.confidence !== undefined ? ` ${Math.round(view.confidence * 100)}%` : '';
    const verdict = view.outcome === 'collapse' ? 'would collapse' : view.outcome;
    bar.appendChild(el('span', 'label', `Signal: ${verdict}${pct}`));
    reason(view.reason);
    if (view.outcome === 'highlight') bar.appendChild(btn('Low quality', a.lowQuality));
    else bar.appendChild(btn('Worth keeping', a.keep));
    note();
    return bar;
  }
}
