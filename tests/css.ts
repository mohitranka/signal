/**
 * Finding G test helper: text contrast computed from the stylesheets themselves (jsdom does not cascade colours or
 * composite opacity). Deliberately small: it understands exactly what Signal's CSS uses (flat rules, one level of
 * `@media (prefers-color-scheme: dark)`, `var(--x[, fallback])`, hex / rgb() / rgba() / `transparent` colours, and
 * `opacity`). Selectors are matched literally against each rule's comma-separated selector list; the caller gives the
 * cascade order (later wins), so no specificity engine is needed.
 */
export type Scheme = 'light' | 'dark';
export interface Rgba { r: number; g: number; b: number; a: number }
interface Rule { dark: boolean; selectors: string[]; decls: Record<string, string> }

export function parseCss(source: string): Rule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const flat = (body: string, dark: boolean): void => {
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const d of m[2]!.split(';')) {
        const i = d.indexOf(':');
        if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
      }
      rules.push({ dark, selectors: m[1]!.split(',').map((s) => s.trim()), decls });
    }
  };
  // Split top level into @media blocks and the rest (Signal's CSS nests at most one level).
  let rest = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { rest += css.slice(i); break; }
    rest += css.slice(i, at);
    const open = css.indexOf('{', at);
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    const query = css.slice(at, open);
    const body = css.slice(open + 1, j - 1);
    if (/prefers-color-scheme:\s*dark/.test(query)) flat(body, true);
    i = j;
  }
  flat(rest, false);
  return rules;
}

/** Declarations for the selector cascade `chain` (later selectors win; dark-media rules win in the dark scheme). */
export function cascade(rules: Rule[], chain: string[], scheme: Scheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const sel of chain) {
    for (const pass of [false, true]) {
      if (pass && scheme === 'light') continue;
      for (const r of rules) if (r.dark === pass && r.selectors.includes(sel)) Object.assign(out, r.decls);
    }
  }
  return out;
}

export function tokens(rules: Rule[], root: string, scheme: Scheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cascade(rules, [root], scheme))) if (k.startsWith('--')) out[k] = v;
  return out;
}

export function resolve(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`var() cycle in ${value}`);
  const m = value.match(/var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
  if (!m) return value.trim();
  const v = vars[m[1]!];
  if (v !== undefined) return resolve(v, vars, depth + 1);
  if (m[2] !== undefined) return resolve(m[2], vars, depth + 1);
  throw new Error(`undefined token ${m[1]}`);
}

export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a] = m[1]!.split(',').map((s) => parseFloat(s));
    return { r: r!, g: g!, b: b!, a: a ?? 1 };
  }
  throw new Error(`unsupported colour "${value}"`);
}

/** `top` drawn with alpha `alpha` over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba, alpha = top.a): Rgba {
  const mix = (t: number, b: number) => t * alpha + b * (1 - alpha);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function contrast(a: Rgba, b: Rgba): number {
  const lum = (c: Rgba) => {
    const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * Contrast of the text of an element whose rules are `el` (cascade order), drawn on `under` (a cascade whose
 * `background` is used, or a literal colour). `inherit`: the ancestor cascade the colour comes from when `el` sets
 * none (backgrounds are not inherited). The element's own background and `opacity` are honoured: the element is
 * painted opaque over `under`, then composited at its opacity.
 */
export function textContrast(
  source: string, root: string, scheme: Scheme, el: string[], under: string[] | string, inherit: string[] = [],
): number {
  const rules = parseCss(source);
  const vars = tokens(rules, root, scheme);
  const d = cascade(rules, el, scheme);
  const bgValue = (decls: Record<string, string>) => decls['background'] ?? decls['background-color'];
  const base = typeof under === 'string'
    ? parseColor(resolve(under, vars))
    : parseColor(resolve(bgValue(cascade(rules, under, scheme)) ?? 'transparent', vars));
  if (base.a !== 1) throw new Error(`backdrop for ${el.join(' ')} is not opaque`);
  const ownBg = bgValue(d) ? parseColor(resolve(bgValue(d)!, vars)) : { r: 0, g: 0, b: 0, a: 0 };
  const boxBg = over(ownBg, base);
  const color = d['color'] ?? cascade(rules, inherit, scheme)['color'];
  if (color === undefined) throw new Error(`no colour for ${el.join(' ')}`);
  const fg = over(parseColor(resolve(color, vars)), boxBg);
  const alpha = d['opacity'] === undefined ? 1 : parseFloat(d['opacity']);
  return contrast(over(fg, base, alpha), over(boxBg, base, alpha));
}
