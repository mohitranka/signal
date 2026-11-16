import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Presenter, shadowRootOf, type Actions, type View } from '../src/content/presenter';

let post: HTMLElement;
let presenter: Presenter;
const actions = (): Actions & Record<string, ReturnType<typeof vi.fn>> =>
  ({ show: vi.fn(), hide: vi.fn(), keep: vi.fn(), lowQuality: vi.fn(), undo: vi.fn() }) as any;
const root = () => {
  const host = document.querySelector<HTMLElement>('[data-signal-bar]');
  return host ? shadowRootOf(host) ?? null : null;
};
const bar = () => root()!.querySelector<HTMLElement>('.bar')!;
const buttons = () => Array.from(bar().querySelectorAll('button')).map((b) => b.textContent);

const view = (over: Partial<View>): View => ({ outcome: 'keep', source: 'model', reason: 'Ordinary post', confidence: 0.72, review: true, revealed: false, ...over });

beforeEach(() => {
  document.body.innerHTML = '<div id="feed"><article id="p">post</article></div>';
  post = document.getElementById('p')!;
  // jsdom can only synthesize untrusted clicks; the production default (isTrusted) is covered in tests/security.test.ts.
  presenter = new Presenter(document, { isTrusted: () => true });
});

describe('review mode: a post the model kept gets only a quiet "Low quality" button', () => {
  it('shows no label and no reason text, just the button', () => {
    presenter.apply(post, view({}), actions());
    expect(bar().classList.contains('quiet')).toBe(true);
    expect(buttons()).toEqual(['Low quality']);
    expect(bar().querySelector('.label, .reason')).toBeNull();
    expect(bar().textContent).toBe('Low quality');
  });

  it('puts the verdict, confidence and reason in the tooltip and accessible name', () => {
    presenter.apply(post, view({}), actions());
    const b = bar().querySelector('button')!;
    expect(b.title).toBe('Kept (model 72% confident): Ordinary post');
    expect(b.getAttribute('aria-label')).toBe('Mark low quality. Kept (model 72% confident): Ordinary post');
  });

  it('copes with a missing confidence or reason', () => {
    presenter.apply(post, view({ confidence: undefined }), actions());
    expect(bar().querySelector('button')!.title).toBe('Kept: Ordinary post');
    presenter.apply(post, view({ reason: '' }), actions());
    expect(bar().querySelector('button')!.title).toBe('Kept (model 72% confident)');
  });

  // F1: the percentage is the model's confidence in ITS decision, which may not be "keep".
  it('says so when the model leaned low quality but Signal kept the post', () => {
    presenter.apply(post, view({ modelDecision: 'collapse', confidence: 0.8, reason: 'Generic thought leadership' }), actions());
    const b = bar().querySelector('button')!;
    expect(b.title).toBe('Kept, although the model rated it low quality (80%): Generic thought leadership');
    expect(b.getAttribute('aria-label')).toBe('Mark low quality. Kept, although the model rated it low quality (80%): Generic thought leadership');
  });

  it('says so when the model rated it a standout but Signal did not highlight it', () => {
    presenter.apply(post, view({ modelDecision: 'highlight', confidence: 0.9, reason: 'Benchmarks with method' }), actions());
    expect(bar().querySelector('button')!.title).toBe('Kept, although the model rated it a standout (90%): Benchmarks with method');
  });

  it('an explicit "keep" from the model reads like the default, and a missing confidence drops the percentage', () => {
    presenter.apply(post, view({ modelDecision: 'keep', confidence: 0.9 }), actions());
    expect(bar().querySelector('button')!.title).toBe('Kept (model 90% confident): Ordinary post');
    presenter.apply(post, view({ modelDecision: 'collapse', confidence: undefined, reason: 'Bait' }), actions());
    expect(bar().querySelector('button')!.title).toBe('Kept, although the model rated it low quality: Bait');
  });

  it('clicking it marks the post low quality, without letting the click reach LinkedIn', () => {
    const a = actions();
    const outside = vi.fn();
    document.getElementById('feed')!.addEventListener('click', outside);
    presenter.apply(post, view({}), a);
    bar().querySelector('button')!.click();
    expect(a.lowQuality).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
  });

  it('never renders a model reason as HTML, even in the tooltip', () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    presenter.apply(post, view({ reason: evil }), actions());
    expect(root()!.querySelector('img')).toBeNull();
    expect(bar().querySelector('button')!.title).toBe(`Kept (model 72% confident): ${evil}`);
    expect((window as any).__pwned).toBeUndefined();
  });

  it('does not hide or mark the post', () => {
    presenter.apply(post, view({}), actions());
    expect(post.hasAttribute('data-signal-hidden')).toBe(false);
    expect(post.hasAttribute('data-signal')).toBe(false);
  });
});

describe('other bars are unchanged', () => {
  it('review "would collapse" and "highlight" keep their full annotation', () => {
    presenter.apply(post, view({ outcome: 'collapse', reason: 'Engagement bait', confidence: 0.93 }), actions());
    expect(bar().classList.contains('quiet')).toBe(false);
    expect(bar().querySelector('.label')!.textContent).toBe('Signal: would collapse 93%');
    expect(bar().querySelector('.reason')!.textContent).toBe('Engagement bait');
    expect(buttons()).toEqual(['Worth keeping']);

    presenter.apply(post, view({ outcome: 'highlight', reason: 'Benchmarks', confidence: 0.88 }), actions());
    expect(bar().querySelector('.label')!.textContent).toBe('Signal: highlight 88%');
    expect(buttons()).toEqual(['Low quality']);
  });

  it('a post you marked yourself keeps its full bar in review mode', () => {
    presenter.apply(post, view({ source: 'user', reason: 'You marked this worth keeping.' }), actions());
    expect(bar().classList.contains('quiet')).toBe(false);
    expect(bar().querySelector('.label')!.textContent).toBe('Marked worth keeping');
    expect(buttons()).toEqual(['Undo']);
  });

  it('active mode: a collapsed post shows the collapsed bar; a kept post gets no bar at all', () => {
    presenter.apply(post, view({ outcome: 'collapse', review: false, reason: 'Bait' }), actions());
    expect(post.hasAttribute('data-signal-hidden')).toBe(true);
    expect(bar().querySelector('.label')!.textContent).toBe('Post collapsed');
    expect(buttons()).toEqual(['Show post', 'Worth keeping']);

    presenter.apply(post, view({ review: false }), actions());
    expect(root()).toBeNull();
    expect(post.hasAttribute('data-signal-hidden')).toBe(false);
  });
});

describe('content.css', () => {
  const css = readFileSync('public/content.css', 'utf8');
  it('still hides collapsed posts and marks highlighted ones via the same attributes', () => {
    expect(css).toMatch(/\[data-signal-hidden\]\s*\{[^}]*display:\s*none\s*!important/);
    expect(css).toMatch(/\[data-signal="highlight"\]\s*\{[^}]*box-shadow/);
  });
});
