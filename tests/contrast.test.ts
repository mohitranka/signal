// @vitest-environment node
/**
 * Finding G (docs/design-finding-g-contrast.md): every text colour pair in the popup and the in-feed bars meets WCAG AA
 * (4.5:1 for normal-size text; all of Signal's text is normal size), in light and dark. Computed from the stylesheets
 * themselves (tests/css.ts), so a later token or rule change that drops a pair below 4.5:1 fails here. The real-browser
 * check, including hover and focus states as rendered, is docs/mockups/finding-g/contrast-check.py.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cascade, contrast, parseColor, parseCss, resolve, textContrast, tokens, type Scheme } from './css';

const POPUP = readFileSync('public/popup.css', 'utf8');
const presenterSrc = readFileSync('src/content/presenter.ts', 'utf8');
const BAR = presenterSrc.slice(presenterSrc.indexOf('const CSS = `') + 13, presenterSrc.indexOf('`;', presenterSrc.indexOf('const CSS = `')));
const SCHEMES: Scheme[] = ['light', 'dark'];
const AA = 4.5;

describe('contrast helper (guards the tests below)', () => {
  it('computes known WCAG ratios', () => {
    expect(contrast(parseColor('#000'), parseColor('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(parseColor('#767676'), parseColor('#fff'))).toBeCloseTo(4.54, 2);
  });

  it('resolves tokens per scheme, with fallbacks, and composites opacity and own backgrounds', () => {
    const css = `:root { --a: #000000; --b: var(--a); } @media (prefers-color-scheme: dark) { :root { --a: #ffffff; } }
      body { background: #ffffff; color: var(--b); } .half { opacity: .5; } .boxed { background: var(--a); color: var(--missing, #808080); }`;
    const rules = parseCss(css);
    expect(resolve('var(--b)', tokens(rules, ':root', 'light'))).toBe('#000000');
    expect(resolve('var(--b)', tokens(rules, ':root', 'dark'))).toBe('#ffffff');
    expect(cascade(rules, ['body', '.half'], 'light')).toMatchObject({ color: 'var(--b)', opacity: '.5' });
    expect(textContrast(css, ':root', 'light', ['body'], ['body'])).toBeCloseTo(21, 5);
    // black text at 50% over white paints grey 127.5: between #808080 (3.95:1) and #7f7f7f (4.00:1)
    expect(textContrast(css, ':root', 'light', ['.half'], ['body'], ['body'])).toBeCloseTo(3.98, 2);
    // own background (black) under the text, then the whole box at full opacity over white
    expect(textContrast(css, ':root', 'light', ['.boxed'], ['body'])).toBeCloseTo(contrast(parseColor('#808080'), parseColor('#000')), 5);
  });
});

/** [where, element cascade, what it sits on, colour inherited from] */
type Pair = [string, string[], string[] | string, string[]?];
const BODY = ['body'];
const CARD = ['.card'];
const TD = ['.corr tbody td'];
const CUR = '.corr tr.current > *';

const POPUP_PAIRS: Pair[] = [
  ['body text on the page', ['body'], ['body']],
  ['list and card text', ['.items li'], CARD, BODY],
  ['inputs', ['input[type=text]'], CARD],
  ['header status line', ['.status'], ['body']],
  ['header status line, warning', ['.status', '.status.warn'], ['body']],
  ['field labels', ['.field-label'], CARD],
  ['help text', ['.help'], CARD],
  ['input labels', ['label.input'], CARD],
  ['setting help', ['.setting-help'], CARD],
  ['Advanced summary', ['.advanced > summary'], CARD],
  ['setting row', ['.toggle-row.setting'], CARD],
  ['section counts', ['.count'], CARD],
  ['section counts, summary hovered', ['.count'], ['details.card > summary:hover']],
  ['"Clear cache" link', ['.link'], CARD],
  ['"Clear cache" link, hovered', ['.link', '.link:hover'], CARD],
  ['session meta line', ['.meta'], CARD],
  ['"n failed"', ['.meta', '.bad'], CARD],
  ['empty-list text', ['.empty'], CARD],
  ['segmented, unselected', ['.segmented span'], ['.segmented']],
  ['segmented, unselected hovered', ['.segmented span', '.segmented input:hover:not(:checked) + span'], ['.segmented']],
  ['segmented, selected', ['.segmented span', '.segmented input:checked + span'], ['.segmented']],
  ['tile values', ['.tile b'], ['.tile'], BODY],
  ['tile labels', ['.tile span'], ['.tile']],
  ['button', ['.btn'], CARD],
  ['button, hovered', ['.btn', '.btn:hover'], CARD],
  ['primary button', ['.btn', '.btn.primary'], CARD],
  ['"Reset" button', ['.btn', '.btn.danger'], CARD],
  ['"Reset" button, hovered', ['.btn', '.btn:hover', '.btn.danger', '.btn.danger:hover'], CARD],
  ['status line (ok)', ['#llmStatus'], CARD],
  ['status line (error)', ['#llmStatus', '#llmStatus.err'], CARD],
  ['model chip', ['.chip'], CARD],
  ['model chip, warning', ['.chip', '.chip.warn'], CARD],
  ['"Keep" pill', ['.pill', '.pill.keep'], CARD],
  ['"Low" pill', ['.pill', '.pill.low'], CARD],
  ['"no classification" pill', ['.pill', '.pill.neutral'], CARD],
  ['corrections column heads', ['.corr th', '.corr thead th'], CARD],
  ['corrections sub-labels ("of 4 kept")', ['.corr .sub'], CARD],
  ['corrections row heads', ['.corr tbody th'], CARD, BODY],
  ['corrections row head, current sensitivity', ['.corr tbody th', CUR], CARD, BODY],
  ['corrections numbers', TD, CARD, BODY],
  ['corrections numbers, current sensitivity', [...TD, CUR], CARD, BODY],
  ['"too few" numbers', [...TD, '.corr td.weak'], CARD],
  ['"too few" numbers, current sensitivity', [...TD, CUR, '.corr td.weak'], CARD],
  ['wrongly-hidden numbers', [...TD, '.corr td.bad'], CARD],
  ['wrongly-hidden numbers, current sensitivity', [...TD, CUR, '.corr td.bad'], CARD],
  ['copied-verdicts line', ['.corr-copied'], CARD],
  ['copied-verdicts line, figures', ['.corr-copied b'], ['.corr-copied']],
  ['"too few" notice', ['.notice'], CARD],
  ['notes', ['.notes li'], CARD],
  ['"left out" summary', ['.leftout > summary'], CARD],
  ['session details summary (finding J)', ['.tile-details > summary'], CARD],
  ['session details lines (finding J)', ['.tile-details li'], CARD],
];

function failures(source: string, root: string, scheme: Scheme, pairs: Pair[]): string[] {
  return pairs.flatMap(([where, el, under, inherit]) => {
    const r = textContrast(source, root, scheme, el, under, inherit);
    return r < AA ? [`${where}: ${r.toFixed(2)}:1`] : [];
  });
}

describe('popup text contrast (finding G)', () => {
  for (const scheme of SCHEMES) {
    it(`every text pair is at least 4.5:1 (${scheme})`, () => {
      expect(failures(POPUP, ':root', scheme, POPUP_PAIRS)).toEqual([]);
    });
  }

  it('--faint is gone: no text or decoration uses it', () => {
    expect(POPUP).not.toMatch(/--faint/);
  });

  it('disclosure chevrons use --muted and meet 3:1 against the card (non-text contrast)', () => {
    const rules = parseCss(POPUP);
    const chevron = cascade(rules, ['details.card > summary::after'], 'light');
    expect(chevron['border-right']).toContain('var(--muted)');
    expect(chevron['border-bottom']).toContain('var(--muted)');
    for (const scheme of SCHEMES) {
      const vars = tokens(rules, ':root', scheme);
      expect(contrast(parseColor(resolve('var(--muted)', vars)), parseColor(resolve('var(--surface)', vars)))).toBeGreaterThanOrEqual(3);
    }
  });
});

// The bar's host sits in LinkedIn's feed, before the post: on the page background. Also checked on the card colour.
const FEED: Record<Scheme, string[]> = { light: ['#f4f2ee', '#ffffff'], dark: ['#000000', '#1b1f23'] };
const QUIET = ['button', '.bar.quiet button'];
const BAR_PAIRS: [string, string[], string[]?][] = [
  ['reason text', ['.reason'], ['.bar']],
  ['review label', ['.label'], ['.bar']],
  ['collapsed bar text', ['.bar', '.bar.collapsed'], undefined],
  ['bar button', ['button'], undefined],
  ['bar button, hovered', ['button', 'button:hover'], undefined],
  ['quiet "Low quality" button', QUIET, undefined],
  ['quiet "Low quality" button, hovered', ['button', 'button:hover', ...QUIET.slice(1), '.bar.quiet button:hover'], undefined],
  ['quiet "Low quality" button, keyboard focus', ['button', 'button:focus-visible', ...QUIET.slice(1), '.bar.quiet button:focus-visible'], undefined],
  ['note row', ['.bar .note'], undefined],
  ['quiet note row', ['.bar .note', '.bar.quiet .note'], undefined],
  ['"Judge separately" link', ['.bar .note .link'], undefined],
];

describe('in-feed bar text contrast (finding G)', () => {
  for (const scheme of SCHEMES) {
    for (const page of FEED[scheme]) {
      it(`every text pair is at least 4.5:1 (${scheme}, on ${page})`, () => {
        const bad = BAR_PAIRS.flatMap(([where, el, inherit]) => {
          const r = textContrast(BAR, '.bar', scheme, el, page, inherit ?? ['.bar']);
          return r < AA ? [`${where}: ${r.toFixed(2)}:1`] : [];
        });
        expect(bad).toEqual([]);
      });
    }
  }

  it('quiet controls are quiet through size and weight, not opacity', () => {
    const rules = parseCss(BAR);
    for (const chain of [QUIET, ['.bar .note', '.bar.quiet .note']]) expect(cascade(rules, chain, 'light')['opacity']).toBeUndefined();
    expect(rules.some((r) => r.selectors.some((s) => s.startsWith('.bar.quiet .note:')))).toBe(false);
  });

  it('quiet button: no border or fill at rest; --surface fill and --neutral border on hover and focus; focus ring kept', () => {
    const rules = parseCss(BAR);
    expect(cascade(rules, QUIET, 'light')).toMatchObject({ background: 'transparent', 'border-color': 'transparent' });
    for (const state of [':hover', ':focus-visible']) {
      expect(cascade(rules, [...QUIET, `.bar.quiet button${state}`], 'light')).toMatchObject({
        color: 'var(--strong)', background: 'var(--surface)', 'border-color': 'var(--neutral)',
      });
    }
    expect(cascade(rules, ['button:focus-visible'], 'light')).toMatchObject({ outline: '2px solid var(--focus)' });
  });
});
