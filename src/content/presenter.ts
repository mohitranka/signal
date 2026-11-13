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
  /** User pressed "Show post" on a collapsed post. */
  revealed: boolean;
}

export interface Actions {
  show(): void;
  hide(): void;
  keep(): void;
  lowQuality(): void;
  undo(): void;
}

const CSS = `
:host { all: initial; display: block; }
.bar { font: 12px/1.4 -apple-system, system-ui, "Segoe UI", sans-serif; color: #5f6368; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 4px 8px; }
.bar.collapsed { background: #f3f2ef; border: 1px solid #e0dfdc; border-radius: 8px; padding: 10px 12px; margin: 4px 0; }
.label { font-weight: 600; color: #3c4043; }
.reason { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
button { all: unset; cursor: pointer; color: #0a66c2; font-weight: 600; padding: 2px 4px; border-radius: 4px; }
button:hover, button:focus-visible { background: rgba(10,102,194,.1); }
.review { border-left: 3px solid #bdbdbd; }
.review.highlight { border-left-color: #2f7d6d; }
.review.collapse { border-left-color: #c0504d; }
@media (prefers-color-scheme: dark) { .bar { color: #b0b0b0; } .label { color: #e0e0e0; } .bar.collapsed { background: #2b2b2b; border-color: #3a3a3a; } }
`;

export const ATTR_HIDDEN = 'data-signal-hidden';
export const ATTR_STATE = 'data-signal';

export class Presenter {
  private hosts = new Map<HTMLElement, { host: HTMLElement; root: ShadowRoot }>();
  private sheet: CSSStyleSheet | null = null;

  constructor(private doc: Document) {}

  /** Render a view, or remove every trace of Signal when view is null. */
  apply(post: HTMLElement, view: View | null, actions: Actions): void {
    if (!view) return this.clear(post);

    const collapsed = view.outcome === 'collapse' && !view.revealed && (view.source === 'user' || !view.review);
    const highlighted = view.outcome === 'highlight' && !view.review;

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
    const root = host.attachShadow({ mode: 'open' });
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
        fn();
      });
      return b;
    };

    const bar = el('div', 'bar');
    const reason = (t: string) => bar.appendChild(el('span', 'reason', t));

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
      return bar;
    }

    if (view.source === 'user') {
      bar.appendChild(el('span', 'label', view.outcome === 'collapse' ? 'Marked low quality' : 'Marked worth keeping'));
      if (view.outcome === 'collapse') bar.appendChild(btn('Hide again', a.hide));
      bar.appendChild(btn('Undo', a.undo));
      return bar;
    }

    if (view.revealed) {
      bar.appendChild(el('span', 'label', 'Collapsed by Signal'));
      reason(view.reason);
      bar.appendChild(btn('Hide again', a.hide));
      bar.appendChild(btn('Worth keeping', a.keep));
      return bar;
    }

    // Review-mode annotation.
    bar.classList.add('review', view.outcome);
    const pct = view.confidence !== undefined ? ` ${Math.round(view.confidence * 100)}%` : '';
    const verdict = view.outcome === 'collapse' ? 'would collapse' : view.outcome;
    bar.appendChild(el('span', 'label', `Signal: ${verdict}${pct}`));
    reason(view.reason);
    if (view.outcome !== 'collapse') bar.appendChild(btn('Low quality', a.lowQuality));
    else bar.appendChild(btn('Worth keeping', a.keep));
    return bar;
  }
}
