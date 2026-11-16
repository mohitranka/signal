/**
 * Step 7 fixes: S1 verdict validation, S2 classify input re-validation, S3 closed shadow root + trusted clicks,
 * S4 fingerprint format + feedback cap, S5 control/bidi characters, S7 export with a bad timestamp.
 */
import { describe, expect, it, vi } from 'vitest';
import { ClassifyService } from '../src/background/classifyService';
import { isExtensionPage } from '../src/background/sender';
import { createHandler } from '../src/background/handlers';
import { CacheStore, FeedbackStore, SettingsStore, StatsStore } from '../src/background/store';
import { parseRecord } from '../src/classifier/parse';
import { correctionReport, feedbackToInputs, partitionCorrections } from '../src/corrections';
import { Presenter, shadowRootOf, type View } from '../src/content/presenter';
import { FP_PATTERN, MAX_FEEDBACK_ENTRIES, isVerdict } from '../src/shared/feedback';
import { LIMITS, fingerprint, prepareInput } from '../src/shared/post';
import { chatResponse, cls, fpFor, gem, memoryKV, modelJson, noise, record } from './helpers';

function setup() {
  const kv = memoryKV();
  const settings = new SettingsStore(kv);
  const cache = new CacheStore(kv, 2000, 10);
  const stats = new StatsStore(memoryKV());
  const bodies: string[] = [];
  const fetchImpl = vi.fn(async (_u: string, init: any) => { bodies.push(init.body); return chatResponse(modelJson(gem())); });
  const service = new ClassifyService({ loadSettings: () => settings.load(), cache, stats, http: { fetchImpl: fetchImpl as any, sleep: async () => {}, maxRetries: 0 } });
  const feedback = new FeedbackStore(kv);
  const handle = createHandler({ service, settings, cache, feedback, stats, notifyTabs: vi.fn() });
  const ready = settings.save({ model: 'm', apiKey: 'k', endpoint: 'https://api.example.com/v1' });
  return { kv, feedback, handle, fetchImpl, bodies, ready };
}
const A = fpFor('a');

describe('S1: verdicts are validated', () => {
  it('shared rule accepts only keep and collapse', () => {
    expect(isVerdict('keep')).toBe(true);
    expect(isVerdict('collapse')).toBe(true);
    for (const bad of ['highlight', 'evil', '', null, undefined, 1, {}]) expect(isVerdict(bad)).toBe(false);
  });

  it('the handler rejects an invalid verdict from a content script and stores nothing', async () => {
    const t = setup();
    const r = await t.handle({ type: 'setFeedback', fp: A, verdict: 'evil' as any, sample: 's', classified: record(noise()) }, true);
    expect(r).toEqual({ error: 'bad verdict' });
    expect(await t.feedback.all()).toEqual({});
  });

  it('FeedbackStore.all() drops malformed entries and keys, keeping well-formed (incl. older) ones', async () => {
    const t = setup();
    const legacy = { verdict: 'keep', at: 5, sample: 'old post', modelDecision: 'collapse', modelConfidence: 0.88 };
    t.kv.data.feedback = {
      [A]: legacy,
      [fpFor('b')]: { verdict: 'evil', at: 1, sample: 's' },
      [fpFor('c')]: 'not an object',
      [fpFor('d')]: null,
      'not-a-fingerprint': { verdict: 'keep', at: 1, sample: 's' },
    };
    expect(await t.feedback.all()).toEqual({ [A]: legacy });
    expect(((await t.handle({ type: 'getState' }, true)) as any).feedback).toEqual({ [A]: 'keep' });
  });

  it('the corrections report ignores entries with an invalid verdict instead of crashing', () => {
    const all: any = { x: { verdict: 'evil', at: 1, sample: 's', classified: record(noise()) }, y: { verdict: 'keep', at: 2, sample: 's', classified: record(cls()) } };
    const inputs = feedbackToInputs(all);
    expect(inputs.map((i) => i.id)).toEqual(['y']);
    expect(() => correctionReport(partitionCorrections(inputs, { model: 'm', promptVersion: 'v1' }).included)).not.toThrow();
  });
});

describe('S2: the background re-validates classify input', () => {
  it('prepareInput is idempotent, so re-applying it in the background changes nothing for honest input', async () => {
    const raw = { text: 'x '.repeat(5000) + '\n\n\n\n end', quoted: 'q'.repeat(2000), linkTitle: 't'.repeat(300), linkDescription: '  d  ' };
    const once = prepareInput(raw);
    expect(prepareInput(once)).toEqual(once);
    expect(await fingerprint(prepareInput(once))).toBe(await fingerprint(once));
  });

  it('truncates oversized input before it reaches the LLM (and still classifies)', async () => {
    const t = setup();
    await t.ready;
    const input = { text: 'A'.repeat(200_000), quoted: 'Q'.repeat(50_000) };
    const fp = await fingerprint(prepareInput(input));
    expect(await t.handle({ type: 'classify', fp, input }, true)).toMatchObject({ ok: true });
    expect(t.bodies).toHaveLength(1);
    expect(t.bodies[0]!.length).toBeLessThan(LIMITS.text + LIMITS.quoted + 8_000);
  });

  it('rejects a fingerprint that does not match the input, without any network call', async () => {
    const t = setup();
    await t.ready;
    const r = await t.handle({ type: 'classify', fp: fpFor('some other post'), input: { text: 'x' } }, true);
    expect(r).toMatchObject({ ok: false, kind: 'invalid' });
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed input shapes without throwing', async () => {
    const t = setup();
    await t.ready;
    for (const input of [null, 'text', { text: 42 }, { text: 'ok', quoted: {} }, []] as any[]) {
      expect(await t.handle({ type: 'classify', fp: A, input }, true)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('S3: page scripts cannot reach or drive Signal bars', () => {
  const view: View = { outcome: 'keep', source: 'model', reason: 'r', confidence: 0.9, review: true, revealed: false };
  const make = () => {
    document.body.innerHTML = '<article id="p">post</article>';
    const post = document.getElementById('p')!;
    const lowQuality = vi.fn();
    return { post, lowQuality, actions: { show() {}, hide() {}, keep() {}, undo() {}, lowQuality } };
  };

  it('uses a closed shadow root: the page sees no shadowRoot, Signal keeps its own reference', () => {
    const { post, actions } = make();
    new Presenter(document).apply(post, view, actions);
    const host = document.querySelector<HTMLElement>('[data-signal-bar]')!;
    expect(host.shadowRoot).toBeNull();
    expect(shadowRootOf(host)!.querySelector('button')!.textContent).toBe('Low quality');
  });

  it('ignores synthetic (untrusted) clicks by default', () => {
    const { post, lowQuality, actions } = make();
    new Presenter(document).apply(post, view, actions);
    const b = shadowRootOf(document.querySelector<HTMLElement>('[data-signal-bar]')!)!.querySelector('button')!;
    b.click(); // jsdom: isTrusted === false, like a page script calling click()
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(lowQuality).not.toHaveBeenCalled();
  });

  it('acts on clicks the trust check accepts (real user input in a browser)', () => {
    const { post, lowQuality, actions } = make();
    new Presenter(document, { isTrusted: () => true }).apply(post, view, actions);
    shadowRootOf(document.querySelector<HTMLElement>('[data-signal-bar]')!)!.querySelector('button')!.click();
    expect(lowQuality).toHaveBeenCalledTimes(1);
  });
});

describe('S4: fingerprint format and feedback cap', () => {
  it('fingerprints are 32 lowercase hex characters', async () => {
    expect(FP_PATTERN.test(await fingerprint({ text: 'x' }))).toBe(true);
    for (const bad of ['a', '__proto__', 'x'.repeat(100_000), 'A'.repeat(32), `${A}\n`, 'ansi\u001b[31m']) expect(FP_PATTERN.test(bad)).toBe(false);
  });

  it('setFeedback and classify reject malformed fingerprints', async () => {
    const t = setup();
    await t.ready;
    for (const fp of ['__proto__', 'x'.repeat(100_000), 'ansi\u001b[31mRED']) {
      expect(await t.handle({ type: 'setFeedback', fp, verdict: 'keep', sample: 's' }, true)).toEqual({ error: 'bad fingerprint' });
      expect(await t.handle({ type: 'classify', fp, input: { text: 'x' } }, true)).toMatchObject({ ok: false, kind: 'invalid' });
    }
    expect(await t.feedback.all()).toEqual({});
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it(`caps feedback at ${MAX_FEEDBACK_ENTRIES} entries: new ones are refused, existing ones can still change or be undone`, async () => {
    expect(MAX_FEEDBACK_ENTRIES).toBe(2000);
    const t = setup();
    const full: Record<string, unknown> = {};
    for (let i = 0; i < MAX_FEEDBACK_ENTRIES; i++) full[fpFor(`p${i}`)] = { verdict: 'keep', at: i, sample: 's' };
    t.kv.data.feedback = full;

    expect(await t.handle({ type: 'setFeedback', fp: fpFor('one too many'), verdict: 'keep', sample: 's' }, true)).toEqual({ error: 'feedback-full' });
    expect(Object.keys(await t.feedback.all())).toHaveLength(MAX_FEEDBACK_ENTRIES);

    expect(await t.handle({ type: 'setFeedback', fp: fpFor('p0'), verdict: 'collapse', sample: 's' }, true)).toEqual({ ok: true });
    expect((await t.feedback.all())[fpFor('p0')]!.verdict).toBe('collapse');
    expect(await t.handle({ type: 'setFeedback', fp: fpFor('p1'), verdict: null, sample: '' }, true)).toEqual({ ok: true });
    expect(await t.handle({ type: 'setFeedback', fp: fpFor('now there is room'), verdict: 'keep', sample: 's' }, true)).toEqual({ ok: true });
  });
});

describe('S5: no control or bidi characters in stored model names and prompt versions', () => {
  it('parseRecord rejects them', () => {
    for (const model of ['gpt\u202Eevil', 'bell\u0007', 'esc\u001b[2J', 'nul\u0000', 'c1\u0085', 'iso\u2066x\u2069', 'lrm\u200E']) {
      expect(parseRecord(record(noise(), model)), JSON.stringify(model)).toBeNull();
    }
    expect(parseRecord(record(noise(), 'm', 'v1\u001b[2J'))).toBeNull();
    expect(parseRecord(record(noise(), 'openai/gpt-4o-mini:free (2024-07-18)'))).not.toBeNull();
  });
});

describe('F2: extension pages are recognised by URL/origin, not by "has a tab"', () => {
  const BASE = 'chrome-extension://me/';
  const cases: [string, chrome.runtime.MessageSender, boolean][] = [
    ['the action popup', { id: 'me', url: `${BASE}popup.html`, origin: 'chrome-extension://me' }, true],
    ['popup.html opened in a tab', { id: 'me', tab: { id: 3 } as chrome.tabs.Tab, url: `${BASE}popup.html`, origin: 'chrome-extension://me' }, true],
    ['an extension page without an origin field (older Chrome)', { id: 'me', url: `${BASE}popup.html` }, true],
    ['the content script on LinkedIn', { id: 'me', tab: { id: 3 } as chrome.tabs.Tab, url: 'https://www.linkedin.com/feed/', origin: 'https://www.linkedin.com' }, false],
    ['origin wins over url', { id: 'me', url: `${BASE}popup.html`, origin: 'https://www.linkedin.com' }, false],
    ['no url and no origin', { id: 'me' }, false],
    ['a look-alike extension id (prefix)', { id: 'me', url: 'chrome-extension://me.evil/popup.html', origin: 'chrome-extension://me.evil' }, false],
    ['a look-alike extension id without origin', { id: 'me', url: 'chrome-extension://meevil/popup.html' }, false],
    ['another extension', { id: 'other', url: 'chrome-extension://other/popup.html', origin: 'chrome-extension://other' }, false],
  ];
  for (const [name, sender, expected] of cases) {
    it(`${name} -> ${expected ? 'extension page' : 'treated as content script'}`, () => {
      expect(isExtensionPage(sender, BASE)).toBe(expected);
    });
  }
});
