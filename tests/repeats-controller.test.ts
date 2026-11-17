/**
 * T9: the feed side of repeated templates (docs/design-repeats.md §6–7, mockups states 1–8).
 * The fake background plays the approved rules: a post containing "COPIED" gets a verdict copied from ANCHOR, unless
 * the request says noRepeat (then it is judged on its own, like a real model call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedinAdapter } from '../src/adapter/linkedin';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { FeedController } from '../src/content/controller';
import { Presenter, shadowRootOf } from '../src/content/presenter';
import { fingerprint, prepareInput } from '../src/shared/post';
import type { BackgroundMessage, Classification, ClassifyResult, PublicSettings, Verdict } from '../src/shared/types';
import { classicPost, feed } from './fixtures/feed';
import { cls, fpFor, noise } from './helpers';

const SETTLE_MS = 30;
const ANCHOR = fpFor('anchor');
const NOTE = 'Same template as a post judged earlier';
const settings = (over: Partial<PublicSettings> = {}): PublicSettings => ({
  enabled: true, mode: 'active', sensitivity: 'balanced', highlight: true, endpoint: 'https://x/v1', model: 'm',
  concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: null, outputPricePerM: null, hasApiKey: true, repeats: true, ...over,
});

const TEXT = {
  copiedBait: 'COPIED template: thrilled to announce my new role at Northwind, agree? Repost and follow for more!',
  copiedBaitVariant: 'COPIED template: thrilled to announce my new role at Contoso, agree? Repost and follow for more!',
  copiedKeep: 'COPIED template: seven hiring lessons from last year, with a note on each one.',
  copiedKeepShort: { short: 'COPIED template: our quarter closed, some lessons below.', rest: ' Lesson one: mindset. Comment GROWTH and I will DM you my framework!' },
  own: { short: 'The Fed held rates again; services inflation is sticky.', rest: ' I think the next move depends more on rents than on jobs numbers.' },
};

type Rule = (text: string, own: boolean) => Classification | 'fail';
/** Content decides the verdict, as with the real model. "Repost" / "Comment GROWTH" are noise. */
const base: Rule = (t) => (t.includes('FAIL') ? 'fail' : t.includes('Repost') || t.includes('Comment GROWTH') ? noise(0.95) : cls());

const live: FeedController[] = [];
const nextTask = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 10; i++) await nextTask(); };

async function settled(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await nextTask();
  for (;;) {
    const busy = live.some((c) => {
      const x = c as any;
      if (x.scanTimer !== null || x.inflight.size > 0 || x.growTimers.size > 0) return true;
      for (const st of x.posts.values()) if (st.status === 'pending' || (st.status === 'new' && st.visible && !x.blocked)) return true;
      return false;
    });
    if (!busy) return void (await nextTask());
    if (Date.now() > deadline) throw new Error('controller did not settle');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function harness(over: Partial<PublicSettings> = {}, rule: Rule = base, initialFeedback: Record<string, Verdict> = {}) {
  const sent: BackgroundMessage[] = [];
  const feedback: Record<string, Verdict> = { ...initialFeedback };
  const current = settings(over);
  const gates: { match: (t: string) => boolean; gate: Promise<void> }[] = [];
  let r = rule;
  const send = vi.fn(async (m: BackgroundMessage) => {
    sent.push(m);
    if (m.type === 'getState') return { settings: current, feedback: { ...feedback } };
    if (m.type === 'classify') {
      const text = m.input.text;
      const g = gates.find((x) => x.match(text));
      if (g) await g.gate;
      const own = (m as { noRepeat?: boolean }).noRepeat === true;
      const v = r(text, own);
      if (v === 'fail') return { ok: false, kind: 'server', message: 'down' } as ClassifyResult;
      const copied = !own && text.includes('COPIED');
      return {
        ok: true, classification: v, cached: copied, model: current.model, promptVersion: PROMPT_VERSION,
        ...(copied ? { repeatOf: { fp: ANCHOR, similarity: 0.92 } } : {}),
      } as ClassifyResult;
    }
    if (m.type === 'setFeedback') {
      if (m.verdict) feedback[m.fp] = m.verdict;
      else delete feedback[m.fp];
    }
    return { ok: true };
  });
  const controller = new FeedController({
    doc: document,
    adapter: linkedinAdapter,
    presenter: new Presenter(document, { isTrusted: () => true }),
    send,
    scanDebounceMs: 0,
    growthSettleMs: SETTLE_MS,
    isTrustedClick: () => true,
    observeVisible: (cb) => ({ observe: (el) => void queueMicrotask(() => cb(el)), unobserve() {}, disconnect() {} }),
  });
  live.push(controller);
  return {
    controller, sent, feedback,
    setRule: (nr: Rule) => (r = nr),
    /** Hold back answers for texts containing `match` until release() (applies to requests made after this call). */
    hold: (match: string) => {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      gates.push({ match: (t) => t.includes(match), gate });
      return release;
    },
    calls: () => sent.filter((m): m is Extract<BackgroundMessage, { type: 'classify' }> => m.type === 'classify'),
    ownCalls: () => sent.filter((m) => m.type === 'classify' && (m as { noRepeat?: boolean }).noRepeat === true),
  };
}

const post = (urn: string) => document.querySelector<HTMLElement>(`[data-urn="urn:li:activity:${urn}"]`)!;
const textSpan = (urn: string) => post(urn).querySelector<HTMLElement>('.update-components-text span')!;
const clickMore = (urn: string) => post(urn).querySelector<HTMLElement>('.update-components-text button')!.click();
const expandReplace = (urn: string, t: { short: string; rest: string }) => {
  clickMore(urn);
  textSpan(urn).textContent = t.short + t.rest;
};
const barOf = (urn: string) => {
  const host = post(urn).previousElementSibling as HTMLElement | null;
  return host?.hasAttribute('data-signal-bar') ? shadowRootOf(host)!.querySelector<HTMLElement>('.bar') : null;
};
const noteOf = (urn: string) => barOf(urn)?.querySelector<HTMLElement>('.note') ?? null;
const buttonsOf = (urn: string) => Array.from(barOf(urn)?.querySelectorAll('button') ?? []).map((b) => b.textContent);
const click = (urn: string, label: string) => {
  const b = Array.from(barOf(urn)!.querySelectorAll('button')).find((x) => x.textContent === label);
  expect(b, `button "${label}" on post ${urn}`).toBeTruthy();
  b!.click();
};
const hidden = (urn: string) => post(urn).hasAttribute('data-signal-hidden');
const fpOf = (text: string) => fingerprint(prepareInput({ text }));

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const c of live.splice(0)) c.stop();
  vi.restoreAllMocks();
});

describe('showing a copied verdict', () => {
  it('Active, copied collapse: collapsed bar plus the note row (state 1)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(hidden('1')).toBe(true);
    expect(noteOf('1')!.textContent).toBe(`${NOTE} · Judge separately`);
    expect(buttonsOf('1')).toEqual(['Show post', 'Worth keeping', 'Judge separately']);
  });

  it('Review, copied "would collapse": annotation plus the note, nothing hidden (state 5)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expect(hidden('1')).toBe(false);
    expect(barOf('1')!.querySelector('.label')!.textContent).toBe('Signal: would collapse 95%');
    expect(noteOf('1')!.textContent).toBe(`${NOTE} · Judge separately`);
  });

  it('Review, copied keep: the quiet row carries the note (state 6)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedKeep));
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expect(barOf('1')!.classList.contains('quiet')).toBe(true);
    expect(noteOf('1')!.textContent).toBe(`${NOTE} · Judge separately`);
    expect(buttonsOf('1')).toEqual(['Judge separately', 'Low quality']);
  });

  it('Active, copied keep: nothing shown, like any kept post', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedKeep));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(barOf('1')).toBeNull();
    expect(hidden('1')).toBe(false);
  });

  it('a post with its own verdict shows no note', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait.replace('COPIED', 'Original')));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(hidden('1')).toBe(true);
    expect(noteOf('1')).toBeNull();
  });
});

describe('"Judge separately"', () => {
  it('asks the model for this post once, shows "Judging…" meanwhile, then shows the post\'s own verdict (states 3–4)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness();
    await h.controller.start();
    await settled();
    const release = h.hold('COPIED');
    click('1', 'Judge separately');
    await flush();
    expect(h.ownCalls()).toHaveLength(1);
    expect(h.ownCalls()[0]).toMatchObject({ type: 'classify', fp: await fpOf(TEXT.copiedBait), input: { text: TEXT.copiedBait }, noRepeat: true });
    expect(noteOf('1')!.textContent).toBe(`${NOTE} · Judging…`);
    expect(buttonsOf('1')).toEqual(['Show post', 'Worth keeping']);
    expect(hidden('1')).toBe(true); // the copied verdict stays until the answer arrives

    release();
    await settled();
    expect(h.ownCalls()).toHaveLength(1);
    expect(hidden('1')).toBe(true); // the model also says collapse
    expect(noteOf('1')).toBeNull();
    expect(buttonsOf('1')).toEqual(['Show post', 'Worth keeping']);
  });

  it('asks even though the page already knows a (copied) verdict for this text', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness();
    await h.controller.start();
    await settled();
    const before = h.calls().length;
    click('1', 'Judge separately');
    await settled();
    expect(h.calls().length).toBe(before + 1);
  });

  it('a post you revealed stays revealed, even when its own verdict is collapse (protection ii)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness();
    await h.controller.start();
    await settled();
    click('1', 'Show post');
    expect(hidden('1')).toBe(false);
    click('1', 'Judge separately');
    await settled();
    expect(hidden('1')).toBe(false);
    expect(barOf('1')!.querySelector('.label')!.textContent).toBe('Collapsed by Signal');
    expect(noteOf('1')).toBeNull();
  });

  it('if its own verdict is keep, the post is shown untouched', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness({}, (t, own) => (own ? cls() : base(t, own)));
    await h.controller.start();
    await settled();
    click('1', 'Judge separately');
    await settled();
    expect(hidden('1')).toBe(false);
    expect(barOf('1')).toBeNull();
  });

  it('if it fails, the post is left as LinkedIn drew it', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness({}, (t, own) => (own ? 'fail' : base(t, own)));
    await h.controller.start();
    await settled();
    click('1', 'Judge separately');
    await settled();
    expect(hidden('1')).toBe(false);
    expect(barOf('1')).toBeNull();
  });

  it('identical posts showing the same copied verdict follow; a similar (not identical) one does not', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait), classicPost('2', TEXT.copiedBait), classicPost('3', TEXT.copiedBaitVariant));
    const h = harness({}, (t, own) => (own ? cls() : base(t, own)));
    await h.controller.start();
    await settled();
    expect([hidden('1'), hidden('2'), hidden('3')]).toEqual([true, true, true]);
    click('1', 'Judge separately');
    await settled();
    expect(h.ownCalls()).toHaveLength(1);
    expect([hidden('1'), hidden('2')]).toEqual([false, false]);
    expect(hidden('3')).toBe(true);
    expect(noteOf('3')).not.toBeNull();
  });
});

describe('protecting what you did', () => {
  it('a post with its own verdict is re-judged by the model when it grows, never given a copy (protection iii)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.own.short));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(h.calls()).toHaveLength(1);
    expandReplace('1', TEXT.own);
    await settled();
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1]).toMatchObject({ input: { text: TEXT.own.short + TEXT.own.rest }, noRepeat: true });
  });

  it('a post showing a copied verdict may be matched again when it grows', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedKeepShort.short));
    const h = harness();
    await h.controller.start();
    await settled();
    expandReplace('1', TEXT.copiedKeepShort);
    await settled();
    expect(h.calls()).toHaveLength(2);
    expect('noRepeat' in h.calls()[1]!).toBe(false);
  });

  it('a post you expanded to read is never hidden by a copied collapse (protection iv, state 7)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedKeepShort.short));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(hidden('1')).toBe(false);
    expandReplace('1', TEXT.copiedKeepShort); // grows into bait; the copy says collapse
    await settled();
    expect(hidden('1')).toBe(false);
    expect(barOf('1')!.querySelector('.label')!.textContent).toBe('Signal would collapse this');
    expect(noteOf('1')!.textContent).toBe(`${NOTE} · Judge separately`);
  });

  it('a post you marked is never sent for matching and shows no note (protection i, state 8)', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait));
    const h = harness({}, base, { [await fpOf(TEXT.copiedBait)]: 'collapse' });
    await h.controller.start();
    await settled();
    expect(h.calls()).toHaveLength(0);
    expect(hidden('1')).toBe(true);
    expect(noteOf('1')).toBeNull();
    expect(buttonsOf('1')).toEqual(['Show post', 'Undo']);
  });

  it('marking a copied post records what it was copied from, and does not spread to similar posts', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait), classicPost('3', TEXT.copiedBaitVariant));
    const h = harness();
    await h.controller.start();
    await settled();
    click('1', 'Worth keeping');
    await flush();
    const fb = h.sent.find((m) => m.type === 'setFeedback') as Extract<BackgroundMessage, { type: 'setFeedback' }>;
    expect(fb.classified).toMatchObject({ classification: noise(0.95), model: 'm', promptVersion: PROMPT_VERSION, repeatOf: { fp: ANCHOR, similarity: 0.92 } });
    expect(hidden('1')).toBe(false);
    expect(hidden('3')).toBe(true);
    expect(noteOf('3')).not.toBeNull();
  });

  it('ordinary classify messages still carry only fp, input and type', async () => {
    document.body.innerHTML = feed(classicPost('1', TEXT.copiedBait), classicPost('2', TEXT.own.short));
    const h = harness();
    await h.controller.start();
    await settled();
    for (const m of h.calls()) expect(Object.keys(m).sort()).toEqual(['fp', 'input', 'type']);
  });
});
