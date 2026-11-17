/**
 * Re-judging a post when "…more" reveals the rest of its text.
 * Growth of a pending/classified (or too-short) post's extracted text triggers exactly one classification of the
 * longer text; unchanged or shorter text triggers nothing; a late result for the old text is dropped (and its request
 * cancelled when nothing else waits for it); revealed, expanded or marked posts are never hidden behind your back;
 * failures leave the post as LinkedIn drew it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkedinAdapter } from '../src/adapter/linkedin';
import { FeedController } from '../src/content/controller';
import { Presenter, shadowRootOf } from '../src/content/presenter';
import { PROMPT_VERSION } from '../src/classifier/prompt';
import { fingerprint, prepareInput } from '../src/shared/post';
import type { BackgroundMessage, Classification, ClassifyResult, PublicSettings, Verdict } from '../src/shared/types';
import { classicPost, feed } from './fixtures/feed';
import { cls, gem, noise } from './helpers';

const SETTLE_MS = 30;
const settings = (over: Partial<PublicSettings> = {}): PublicSettings => ({
  enabled: true, mode: 'active', sensitivity: 'balanced', highlight: true, endpoint: 'https://x/v1', model: 'm',
  concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: null, outputPricePerM: null, hasApiKey: true, repeats: true, ...over,
});

// Cut-off and full texts. The fake model judges by content, like the real one.
const GEM = { short: 'Unpopular opinion: your migration plan is wrong. Agree?', rest: ' Here is why, with numbers: 1.2B rows, three pitfalls, and the runbook we used.' };
const BAIT = { short: 'We closed our Q3 numbers last week, some lessons below.', rest: ' Lesson one: mindset. Comment GROWTH and I will DM you my framework!' };
const PLAIN = { short: 'The Fed held rates again; services inflation is sticky.', rest: ' I think the next move depends more on rents than on jobs numbers.' };
const model = (t: string): Classification | 'fail' | 'auth' => {
  if (t.includes('FAIL')) return 'fail';
  if (t.includes('Here is why')) return gem();
  if (t.includes('Unpopular opinion')) return noise(0.95);
  if (t.includes('Comment GROWTH')) return noise(0.93);
  return cls();
};

const live: FeedController[] = [];
const nextTask = () => new Promise((r) => setTimeout(r, 0));

/** Wait until every controller is idle, including growth checks (settle timers) and re-classifications. */
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

function harness(over: Partial<PublicSettings> = {}, rules: (t: string) => Classification | 'fail' | 'auth' = model, opts: { trustClicks?: boolean } = {}) {
  const sent: BackgroundMessage[] = [];
  const feedback: Record<string, Verdict> = {};
  let current = settings(over);
  const gates: { match: (text: string) => boolean; release: () => void; gate: Promise<void> }[] = [];
  let clockOffset = 0;
  let r = rules;
  const send = vi.fn(async (m: BackgroundMessage) => {
    sent.push(m);
    if (m.type === 'getState') return { settings: current, feedback: { ...feedback } };
    if (m.type === 'classify') {
      const text = `${m.input.text}\n${m.input.quoted ?? ''}`;
      const g = gates.find((x) => x.match(text));
      if (g) await g.gate;
      const v = r(text);
      if (v === 'fail') return { ok: false, kind: 'server', message: 'down' } as ClassifyResult;
      if (v === 'auth') return { ok: false, kind: 'auth', message: 'bad key' } as ClassifyResult;
      return { ok: true, classification: v, cached: false, model: current.model, promptVersion: PROMPT_VERSION } as ClassifyResult;
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
    // jsdom can only synthesize untrusted clicks; production uses e.isTrusted (see the E1 tests below)
    isTrustedClick: opts.trustClicks === false ? undefined : () => true,
    now: () => Date.now() + clockOffset,
    observeVisible: (cb) => ({ observe: (el) => void queueMicrotask(() => cb(el)), unobserve() {}, disconnect() {} }),
  });
  live.push(controller);
  return {
    controller, send, sent, feedback,
    set: (o: Partial<PublicSettings>) => (current = { ...current, ...o }),
    /** Move the controller's clock forward (e.g. to age a click). */
    advance: (ms: number) => (clockOffset += ms),
    setRules: (nr: typeof rules) => (r = nr),
    /** Hold back the model's answer for texts containing `match` (or matching the predicate) until release(). */
    hold: (match: string | ((text: string) => boolean)) => {
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      gates.push({ match: typeof match === 'string' ? (t) => t.includes(match) : match, release, gate });
      return release;
    },
    calls: () => sent.filter((m): m is Extract<BackgroundMessage, { type: 'classify' }> => m.type === 'classify'),
    cancels: () => sent.filter((m): m is Extract<BackgroundMessage, { type: 'cancel' }> => m.type === 'cancel'),
  };
}

const post = (urn: string) => document.querySelector<HTMLElement>(`[data-urn="urn:li:activity:${urn}"]`)!;
const textSpan = (urn: string) => post(urn).querySelector<HTMLElement>('.update-components-text span')!;
/** The user clicks the post's "…more" control (in the fixture markup, the button next to the text). */
const clickMore = (urn: string) => post(urn).querySelector<HTMLElement>('.update-components-text button')!.click();
/** User expands; LinkedIn variant A: the text element is re-rendered with the full text (childList). */
const expandReplace = (urn: string, t: { short: string; rest: string }) => {
  clickMore(urn);
  textSpan(urn).textContent = t.short + t.rest;
};
/** User expands; LinkedIn variant B: the existing text node is edited in place (characterData). */
const expandInPlace = (urn: string, t: { short: string; rest: string }) => {
  clickMore(urn);
  (textSpan(urn).firstChild as Text).data = t.short + t.rest;
};
/** The text grows without the user doing anything (a page script, or LinkedIn loading text in the background). */
const pageGrow = (urn: string, extra: string) => void textSpan(urn).append(document.createTextNode(extra));
const collapseText = (urn: string, t: { short: string }) => void (textSpan(urn).textContent = t.short);

const barOf = (urn: string) => {
  const host = post(urn).previousElementSibling as HTMLElement | null;
  return host?.hasAttribute('data-signal-bar') ? shadowRootOf(host)!.querySelector<HTMLElement>('.bar') : null;
};
const barButtons = (urn: string) => Array.from(barOf(urn)?.querySelectorAll('button') ?? []).map((b) => b.textContent);
const click = (urn: string, label: string) => {
  const b = Array.from(barOf(urn)!.querySelectorAll('button')).find((x) => x.textContent === label);
  expect(b, `button "${label}"`).toBeTruthy();
  b!.click();
};
const hidden = (urn: string) => post(urn).hasAttribute('data-signal-hidden');
const highlighted = (urn: string) => post(urn).getAttribute('data-signal') === 'highlight';
const fpOf = async (text: string, quoted?: string) => fingerprint(prepareInput({ text, ...(quoted ? { quoted } : {}) }));

beforeEach(() => {
  document.body.innerHTML = feed(classicPost('gem', GEM.short), classicPost('bait', BAIT.short), classicPost('plain', PLAIN.short));
});
afterEach(() => {
  for (const c of live.splice(0)) c.stop();
  vi.restoreAllMocks();
});

describe('noticing that a post grew', () => {
  it('judges the full text once when LinkedIn re-renders the text', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expect(h.calls()).toHaveLength(3);
    expandReplace('bait', BAIT);
    await settled();
    expect(h.calls()).toHaveLength(4);
    expect(h.calls()[3]!.input.text).toBe(BAIT.short + BAIT.rest);
    expect(h.calls()[3]!.fp).toBe(await fpOf(BAIT.short + BAIT.rest));
  });

  it('judges it when the text node is edited in place', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expandInPlace('plain', PLAIN);
    await settled();
    expect(h.calls().map((c) => c.input.text)).toContain(PLAIN.short + PLAIN.rest);
    expect(h.calls()).toHaveLength(4);
  });

  it('waits for text arriving in pieces and judges the final text once', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    const span = textSpan('plain');
    for (const piece of [' I think the next move', ' depends more on rents', ' than on jobs numbers.']) {
      span.append(document.createTextNode(piece));
      await new Promise((r) => setTimeout(r, SETTLE_MS / 3));
    }
    await settled();
    expect(h.calls()).toHaveLength(4);
    expect(h.calls()[3]!.input.text).toBe(PLAIN.short + PLAIN.rest);
  });

  it('counts growth of reshared text', async () => {
    document.body.innerHTML = feed(classicPost('re', 'Worth reading, especially the second half.',
      `<div class="update-components-mini-update-v2"><div class="update-components-text"><span dir="ltr">${PLAIN.short}</span></div></div>`));
    const h = harness();
    await h.controller.start();
    await settled();
    post('re').querySelector<HTMLElement>('.update-components-mini-update-v2 span')!.textContent = PLAIN.short + PLAIN.rest;
    await settled();
    expect(h.calls()).toHaveLength(2);
    expect(h.calls()[1]!.input.quoted).toBe(PLAIN.short + PLAIN.rest);
  });

  it('judges a post that was too short to judge once it grows past the minimum', async () => {
    document.body.innerHTML = feed(classicPost('tiny', 'Big news…'));
    const h = harness();
    await h.controller.start();
    await settled();
    expect(h.calls()).toHaveLength(0);
    textSpan('tiny').textContent = 'Big news… we are open-sourcing our incident review tooling, with the templates.';
    await settled();
    expect(h.calls()).toHaveLength(1);
  });
});

describe('what does not trigger anything', () => {
  it('changes that leave the text as it was: reactions, comments, attributes', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expect(hidden('gem')).toBe(true);
    post('gem').insertAdjacentHTML('beforeend', '<span class="social-counts">7 reactions</span>');
    const p = post('plain');
    p.insertAdjacentHTML('beforeend', '<span class="social-counts">42 reactions</span>');
    p.querySelector('.comments-comments-list')!.insertAdjacentHTML('beforeend', '<article class="comments-comment-item"><div class="update-components-text">A new comment that is long enough to count as text.</div></article>');
    p.setAttribute('data-something', 'changed');
    (p.querySelector('.update-components-actor__sub-description span')!.firstChild as Text).data = '3h';
    await settled();
    expect(h.calls()).toHaveLength(3);
    expect(hidden('gem')).toBe(true); // not treated as "expanded to read"
  });

  it('shrinking ("…see less") keeps the full-text verdict', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    collapseText('bait', BAIT);
    await settled();
    expect(h.calls()).toHaveLength(4);
    expect(barOf('bait')!.textContent).toContain('would collapse');
  });

  it('expanding again after "…see less" costs no new call', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expandReplace('plain', PLAIN);
    await settled();
    collapseText('plain', PLAIN);
    await settled();
    expandReplace('plain', PLAIN);
    await settled();
    expect(h.calls()).toHaveLength(4);
  });

  it('a post whose first classification failed is not retried when it grows', async () => {
    document.body.innerHTML = feed(classicPost('f', 'FAIL: this first classification fails on purpose.'));
    const h = harness();
    await h.controller.start();
    await settled();
    textSpan('f').textContent = 'FAIL: this first classification fails on purpose. And now there is more text.';
    await settled();
    expect(h.calls()).toHaveLength(1);
  });

  it('nothing happens after the controller stops', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    h.controller.stop();
    expandReplace('bait', BAIT);
    await new Promise((r) => setTimeout(r, SETTLE_MS * 3));
    expect(h.calls()).toHaveLength(3);
  });
});

describe('the verdict follows the full text', () => {
  it('a revealed cut-off "bait" that turns out to be excellent gets highlighted, with no stale bar', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expect(hidden('gem')).toBe(true);
    click('gem', 'Show post');
    expandReplace('gem', GEM);
    await settled();
    expect(hidden('gem')).toBe(false);
    expect(highlighted('gem')).toBe(true);
    expect(barOf('gem')).toBeNull(); // "revealed" only matters for a collapse verdict
  });

  it('a highlight is removed when the full text no longer qualifies', async () => {
    document.body.innerHTML = feed(classicPost('hl', 'Here is why, with numbers: our p99 fell from 180 ms to 95 ms.'));
    const h = harness({}, (t) => (t.includes('but honestly') ? cls() : gem()));
    await h.controller.start();
    await settled();
    expect(highlighted('hl')).toBe(true);
    textSpan('hl').textContent += ' ...but honestly the rest is an ad for our consulting services.';
    await settled();
    expect(highlighted('hl')).toBe(false);
  });

  it('review mode: the annotation follows the full text', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expect(barOf('bait')!.classList.contains('quiet')).toBe(true);
    expandReplace('bait', BAIT);
    await settled();
    expect(barOf('bait')!.textContent).toContain('Signal: would collapse 93%');
  });
});

describe('never hidden behind your back', () => {
  it('a post you expanded to read is not hidden by a collapse verdict; it says so and offers Hide', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    expect(hidden('bait')).toBe(false);
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Signal would collapse this');
    expect(barButtons('bait')).toEqual(['Hide', 'Worth keeping']);
    click('bait', 'Hide');
    expect(hidden('bait')).toBe(true);
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Post collapsed');
  });

  it('a post you revealed stays revealed when the full text also rates collapse', async () => {
    const h = harness({}, (t) => (t.includes('Unpopular opinion') ? noise(0.95) : cls()));
    await h.controller.start();
    await settled();
    click('gem', 'Show post');
    expandReplace('gem', { short: GEM.short, rest: ' And another thing: everyone else is wrong too.' });
    await settled();
    expect(h.calls()).toHaveLength(4);
    expect(hidden('gem')).toBe(false);
    expect(barOf('gem')!.querySelector('.label')!.textContent).toBe('Collapsed by Signal');
    expect(barButtons('gem')).toEqual(['Hide again', 'Worth keeping']);
  });

  it('a marked post is not re-judged, and the mark still applies after expansion', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    click('gem', 'Worth keeping'); // collapsed cut-off post, marked worth keeping
    expandReplace('gem', GEM);
    await settled();
    expect(h.calls()).toHaveLength(3);
    expect(hidden('gem')).toBe(false);
    expect(barOf('gem')!.querySelector('.label')!.textContent).toBe('Marked worth keeping');
  });

  it('a mark made after expansion is saved under the first-seen text and applies after a reload', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    click('bait', 'Worth keeping');
    const fb = h.sent.filter((m) => m.type === 'setFeedback').pop() as any;
    expect(fb.fp).toBe(await fpOf(BAIT.short));
    expect(fb.sample).toBe(BAIT.short + BAIT.rest);
    expect(fb.classified.classification).toEqual(noise(0.93)); // the full-text verdict you corrected

    // reload: the post is cut off again; the mark applies without asking the model
    h.controller.stop();
    document.body.innerHTML = feed(classicPost('bait', BAIT.short));
    const again = harness({ mode: 'review' });
    again.feedback[fb.fp] = 'keep';
    await again.controller.start();
    await settled();
    expect(again.calls()).toHaveLength(0);
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Marked worth keeping');
  });

  it('an expanded, marked post keeps its mark when the model changes (same post, re-read)', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    click('bait', 'Worth keeping');
    const before = h.calls().length;
    h.set({ model: 'another-model' });
    await h.controller.onSettingsChanged();
    await settled();
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Marked worth keeping');
    expect(h.calls().slice(before).some((c) => c.input.text.includes('We closed our Q3'))).toBe(false);
  });

  it('regression guard: lowering the sensitivity after a reveal leaves no bar', async () => {
    document.body.innerHTML = feed(classicPost('n', 'Everyone says this, nobody does it. Agree? Comment below.'));
    const h = harness({ sensitivity: 'strict' }, () => noise(0.8)); // collapses at strict only
    await h.controller.start();
    await settled();
    click('n', 'Show post');
    expect(barOf('n')!.querySelector('.label')!.textContent).toBe('Collapsed by Signal');
    h.set({ sensitivity: 'relaxed' });
    await h.controller.onSettingsChanged();
    expect(hidden('n')).toBe(false);
    expect(barOf('n')).toBeNull();
  });
});

describe('old text, late results and cancellation', () => {
  it('a late result for the cut-off text is dropped, and its request is cancelled', async () => {
    const h = harness();
    const releaseShort = h.hold((t) => t.trim() === BAIT.short); // only the cut-off text's answer is held back
    await h.controller.start();
    await vi.waitFor(() => expect(h.send.mock.calls.some(([m]) => m.type === 'classify' && m.input.text === BAIT.short)).toBe(true));
    h.setRules((t) => (t.includes('Comment GROWTH') ? noise(0.93) : t.includes(BAIT.short) ? gem() : model(t)));
    expandReplace('bait', BAIT);
    // The full text's answer lands first. (Not settled(): the held cut-off request is deliberately still in flight.)
    await vi.waitFor(() => expect(barOf('bait')?.querySelector('.label')?.textContent).toBe('Signal would collapse this'), { timeout: 2000, interval: 5 });
    expect(h.cancels().map((c) => c.fp)).toEqual([await fpOf(BAIT.short)]);
    releaseShort(); // ...then the cut-off text's answer (highlight) arrives late and must be ignored
    await new Promise((r) => setTimeout(r, 20));
    await settled();
    expect(highlighted('bait')).toBe(false);
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Signal would collapse this');
  });

  it('does not cancel a cut-off request that another post is still waiting for', async () => {
    document.body.innerHTML = feed(classicPost('a', BAIT.short), classicPost('b', BAIT.short));
    const h = harness();
    const release = h.hold('We closed our Q3');
    await h.controller.start();
    await vi.waitFor(() => expect(h.send.mock.calls.some(([m]) => m.type === 'classify')).toBe(true));
    expandReplace('a', BAIT);
    await new Promise((r) => setTimeout(r, SETTLE_MS * 4));
    expect(h.cancels()).toHaveLength(0);
    release();
    await settled();
    expect(barOf('b')).toBeNull(); // b got its cut-off verdict: keep (no bar in active mode)
    expect(barOf('a')!.querySelector('.label')!.textContent).toBe('Signal would collapse this');
  });
});

describe('fails open', () => {
  it('if judging the full text fails, the post is left as LinkedIn drew it', async () => {
    const h = harness({ mode: 'review' }, (t) => (t.includes('Comment GROWTH') ? 'fail' : model(t)));
    await h.controller.start();
    await settled();
    expect(barOf('bait')).not.toBeNull();
    expandReplace('bait', BAIT);
    await settled();
    expect(barOf('bait')).toBeNull();
    expect(hidden('bait')).toBe(false);
    expect(highlighted('bait')).toBe(false);
  });

  it('if requests are paused after an auth error, growth sends nothing and leaves the post as LinkedIn drew it', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    h.setRules(() => 'auth');
    expandReplace('bait', BAIT);
    await settled();
    expect(barOf('bait')).toBeNull();
    const before = h.calls().length;
    expandReplace('plain', PLAIN); // paused now: nothing is sent
    await settled();
    expect(h.calls()).toHaveLength(before);
    expect(barOf('plain')).toBeNull();
  });
});

describe('F4: "revealed" only means something in Active mode', () => {
  const label = (urn: string) => barOf(urn)?.querySelector('.label')?.textContent;

  it('a post revealed in Active mode shows the normal Review annotation after switching to Review, and is still revealed back in Active', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    click('gem', 'Show post');
    expect(label('gem')).toBe('Collapsed by Signal');
    h.set({ mode: 'review' });
    await h.controller.onSettingsChanged();
    expect(label('gem')).toBe('Signal: would collapse 95%');
    expect(barButtons('gem')).toEqual(['Worth keeping']);
    expect(hidden('gem')).toBe(false);
    h.set({ mode: 'active' });
    await h.controller.onSettingsChanged();
    expect(hidden('gem')).toBe(false); // not re-hidden behind your back
    expect(label('gem')).toBe('Collapsed by Signal');
    expect(barButtons('gem')).toEqual(['Hide again', 'Worth keeping']);
  });

  it('the same for a post you expanded', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    expect(label('bait')).toBe('Signal would collapse this');
    h.set({ mode: 'review' });
    await h.controller.onSettingsChanged();
    expect(label('bait')).toBe('Signal: would collapse 93%');
    h.set({ mode: 'active' });
    await h.controller.onSettingsChanged();
    expect(hidden('bait')).toBe(false);
    expect(label('bait')).toBe('Signal would collapse this');
  });

  it('guard: a post you marked low quality and then showed keeps its wording in Review mode (your mark hides it there too)', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    click('bait', 'Low quality');
    expect(hidden('bait')).toBe(true);
    click('bait', 'Show post');
    expect(hidden('bait')).toBe(false);
    expect(label('bait')).toBe('Marked low quality');
    expect(barButtons('bait')).toEqual(['Hide again', 'Undo']);
  });
});

describe('tab count ("This tab: N collapsed, M highlighted") counts what is actually shown', () => {
  const stats = (h: ReturnType<typeof harness>) => {
    const s = h.controller.pageStats();
    return { collapsed: s.collapsed, highlighted: s.highlighted };
  };

  it('a revealed post is not counted as collapsed; hiding it again is', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expect(stats(h).collapsed).toBe(1); // gem
    click('gem', 'Show post');
    expect(stats(h).collapsed).toBe(0);
    click('gem', 'Hide again');
    expect(stats(h).collapsed).toBe(1);
  });

  it('a post kept visible because you expanded it is not counted; "Hide" counts it', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT);
    await settled();
    expect(stats(h).collapsed).toBe(1); // gem only; bait is visible ("Signal would collapse this")
    click('bait', 'Hide');
    expect(stats(h).collapsed).toBe(2);
  });

  it('your own "low quality" mark counts while it hides the post, not after "Show post"', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    expect(stats(h)).toEqual({ collapsed: 0, highlighted: 0 }); // review mode hides and highlights nothing by itself
    click('plain', 'Low quality');
    expect(stats(h).collapsed).toBe(1);
    click('plain', 'Show post');
    expect(stats(h).collapsed).toBe(0);
  });

  it('highlighted counts only posts actually highlighted (Active mode, highlighting on)', async () => {
    document.body.innerHTML = feed(classicPost('hl', 'Here is why, with numbers: our p99 fell from 180 ms to 95 ms.'));
    const h = harness({ mode: 'review' }, () => gem());
    await h.controller.start();
    await settled();
    expect(stats(h).highlighted).toBe(0);
    h.set({ mode: 'active' });
    await h.controller.onSettingsChanged();
    expect(stats(h).highlighted).toBe(1);
    expect(highlighted('hl')).toBe(true);
    h.set({ highlight: false });
    await h.controller.onSettingsChanged();
    expect(stats(h).highlighted).toBe(0);
  });
});

describe('E1: "you are reading it" must come from you', () => {
  it('a hidden post whose text grows without you (page script, background load) stays hidden if still collapse', async () => {
    const h = harness({}, (t) => (t.includes('Unpopular opinion') ? noise(0.95) : model(t)));
    await h.controller.start();
    await settled();
    expect(hidden('gem')).toBe(true);
    pageGrow('gem', ' And one more thing: everyone else is wrong too. Agree? Comment below!');
    await settled();
    expect(h.calls()).toHaveLength(4); // still re-judged on the longer text...
    expect(hidden('gem')).toBe(true); // ...but not un-hidden
    expect(barOf('gem')!.querySelector('.label')!.textContent).toBe('Post collapsed');
  });

  it('a hidden post whose full text turns out fine reappears (the model says so, not the growth)', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    pageGrow('gem', GEM.rest);
    await settled();
    expect(hidden('gem')).toBe(false);
    expect(highlighted('gem')).toBe(true);
  });

  it('a visible post that grows without a click is not protected from a collapse verdict', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    pageGrow('bait', BAIT.rest);
    await settled();
    expect(hidden('bait')).toBe(true);
    expect(barOf('bait')!.querySelector('.label')!.textContent).toBe('Post collapsed');
  });

  it('a scripted (untrusted) click does not count', async () => {
    const h = harness({}, model, { trustClicks: false }); // production default: e.isTrusted (false in jsdom)
    await h.controller.start();
    await settled();
    expandReplace('bait', BAIT); // the click is untrusted here
    await settled();
    expect(hidden('bait')).toBe(true);
  });

  it('a click more than 10 s before the text grows does not count', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    clickMore('bait');
    h.advance(10_001);
    pageGrow('bait', BAIT.rest);
    await settled();
    expect(hidden('bait')).toBe(true);
  });

  it('a click on a hidden post does not count (you cannot have expanded what you cannot see)', async () => {
    const h = harness({}, (t) => (t.includes('Unpopular opinion') ? noise(0.95) : model(t)));
    await h.controller.start();
    await settled();
    clickMore('gem'); // e.g. a scripted-but-trusted path, or a stale target: the post is hidden
    pageGrow('gem', ' And one more thing: everyone else is wrong too. Agree?');
    await settled();
    expect(hidden('gem')).toBe(true);
  });
});

describe('E2: at most 3 re-judgements per post per page load', () => {
  it('five growths cost three calls; the latest judged text stands', async () => {
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    for (let i = 1; i <= 5; i++) {
      pageGrow('plain', ` Extra sentence number ${i} with a few more words.`);
      await settled();
    }
    expect(h.calls()).toHaveLength(3 + 3);
    expect(h.calls()[5]!.input.text).toContain('number 3');
    expect(h.calls().some((c) => c.input.text.includes('number 4'))).toBe(false);
  });

  it('the count starts again when LinkedIn reuses the node for a different post', async () => {
    document.body.innerHTML = feed(classicPost('r1', PLAIN.short));
    const h = harness({ mode: 'review' });
    await h.controller.start();
    await settled();
    for (let i = 1; i <= 3; i++) {
      pageGrow('r1', ` More words, round ${i}.`);
      await settled();
    }
    expect(h.calls()).toHaveLength(4);
    const el = post('r1');
    el.setAttribute('data-urn', 'urn:li:activity:r2');
    textSpan('r2').textContent = BAIT.short;
    await settled();
    pageGrow('r2', ' And then some more text for the new post.');
    await settled();
    expect(h.calls()).toHaveLength(6); // the new post classified, then re-judged once
  });
});

describe('X1/X2: only changes to post text are looked at', () => {
  it('timestamps, reactions and comments schedule no growth check; a text change does', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    const spy = vi.spyOn(h.controller as any, 'scheduleGrowthCheck');
    const p = post('plain');
    (p.querySelector('.update-components-actor__sub-description span')!.firstChild as Text).data = '5m';
    p.insertAdjacentHTML('beforeend', '<span class="social-counts">42 reactions</span>');
    p.querySelector('.comments-comments-list')!.insertAdjacentHTML('beforeend', '<article class="comments-comment-item"><div class="update-components-text">A new comment that is long enough to count.</div></article>');
    await settled();
    expect(spy).not.toHaveBeenCalled();
    expandReplace('plain', PLAIN);
    await settled();
    expect(spy).toHaveBeenCalled();
    expect(h.calls()).toHaveLength(4);
  });

  it('LinkedIn replacing the whole text container is still noticed, and judged once', async () => {
    const h = harness();
    await h.controller.start();
    await settled();
    const p = post('plain');
    clickMore('plain');
    const fresh = document.createElement('div');
    fresh.className = 'feed-shared-update-v2__description';
    fresh.innerHTML = `<div class="update-components-text"><span dir="ltr">${PLAIN.short + PLAIN.rest}</span></div>`;
    p.replaceChild(fresh, p.querySelector('.feed-shared-update-v2__description')!);
    await settled();
    expect(h.calls()).toHaveLength(4);
    expect(h.calls()[3]!.input.text).toBe(PLAIN.short + PLAIN.rest);
  });
});
