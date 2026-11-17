// @vitest-environment node
/**
 * Finding F (docs/design-finding-f-popup-width.md, variant V7): CSS contract for the popup's width and session tiles.
 * jsdom has no layout engine, so the layout itself is measured in a real browser (docs/mockups/finding-f/layout-check.py);
 * these tests pin the rules that layout depends on, so none is dropped or changed by accident.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('public/popup.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations of every rule whose selector list contains exactly `selector` (later declarations win). */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2]!.split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
  }
  return out;
}

describe('popup width (finding F)', () => {
  it('the body keeps 360 px but never exceeds the popup, so a classic scrollbar cannot force a horizontal one', () => {
    expect(decls('body')).toMatchObject({ width: '360px', 'max-width': '100%' });
  });
});

describe('session tiles (finding F, V7)', () => {
  it('columns can never be wider than the card; the cost column is slightly wider', () => {
    expect(decls('.tiles')).toMatchObject({ 'grid-template-columns': 'repeat(4, minmax(0, 1fr)) minmax(0, 1.2fr)', gap: '4px' });
    expect(decls('.tile')).toMatchObject({ 'min-width': '0', padding: '6px 2px' });
  });

  it('values: 14 px, one line, ellipsis only as a last resort', () => {
    expect(decls('.tile b')).toMatchObject({ 'font-size': '14px', overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' });
  });

  it('labels: 10.5 px and allowed to wrap', () => {
    expect(decls('.tile span')).toMatchObject({ 'font-size': '10.5px', 'white-space': 'normal' });
  });
});

describe('session details control (finding J)', () => {
  it('the Details summary is at least 24 px tall (padding 4px 0 around 12 px text)', () => {
    expect(decls('.tile-details > summary')).toMatchObject({ padding: '4px 0', 'font-size': '12px' });
  });
});
