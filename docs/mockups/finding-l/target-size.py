"""
Finding L: WCAG 2.2 SC 2.5.8 (Target Size, Minimum, AA) in a real browser: every interactive element of the built popup
(all sections open) and of the real in-feed bars (8 states). An element under 24 x 24 px passes if it is inline in a
sentence, or if a 24 px circle centred on it touches no other target and no other small target's circle.
Run after `npm run build`:   xvfb-run -a python3 docs/mockups/finding-l/target-size.py
"""
import json, pathlib, math
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[3]
g = (ROOT / 'docs/mockups/finding-g/contrast-check.py').read_text()
ns = {}; exec(g.split('failures = []')[0].replace("HERE = pathlib.Path(__file__).resolve().parent", f"HERE = pathlib.Path({str(ROOT / 'docs/mockups/finding-g')!r})"), ns)
MEASURE = r"""(root) => {
  const doc = root || document; const out = [];
  const walk = (r) => { for (const el of r.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot);
    const tag = el.tagName.toLowerCase(); const interactive = ['button', 'summary', 'select', 'a'].includes(tag) || (tag === 'input' && el.type !== 'hidden') || el.getAttribute('role') === 'button';
    if (!interactive) continue; const rs = el.getClientRects(); if (!rs.length) continue; const r = el.getBoundingClientRect(); if (r.width === 0) continue;
    // inline in a sentence? (WCAG exception): its parent has other text
    const p = el.parentElement; const inline = getComputedStyle(el).display.startsWith('inline') && p && [...p.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    out.push({ name: el.id || el.getAttribute('name') || el.textContent.trim().slice(0, 24) || tag, tag, x: r.left, y: r.top, w: r.width, h: r.height, inline }); } };
  walk(doc); return out; }"""
def spacing_ok(t, all_):
    # WCAG 2.5.8 spacing exception: a 24 px circle centred on each undersized target must not intersect another target
    # or the 24 px circle of another undersized target.
    cx, cy = t['x'] + t['w'] / 2, t['y'] + t['h'] / 2
    for o in all_:
        if o is t: continue
        # distance from centre to the other target's rectangle
        dx = max(o['x'] - cx, 0, cx - (o['x'] + o['w'])); dy = max(o['y'] - cy, 0, cy - (o['y'] + o['h']))
        if math.hypot(dx, dy) < 12: return False, o['name']
        if o['w'] < 24 or o['h'] < 24:
            ox, oy = o['x'] + o['w'] / 2, o['y'] + o['h'] / 2
            if math.hypot(ox - cx, oy - cy) < 24: return False, o['name']
    return True, None
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    pg = b.new_page(viewport={'width': 360, 'height': 2400}); pg.add_init_script(ns['mock'](12, 12, 2)); pg.goto(ns['POPUP']); pg.wait_for_timeout(300)
    pg.evaluate("() => { for (const d of document.querySelectorAll('details')) d.open = true; }"); pg.wait_for_timeout(200)
    ts = pg.evaluate(MEASURE, None)
    print('POPUP (all sections open)')
    for t in ts:
        if t['w'] >= 24 and t['h'] >= 24: continue
        ok, by = spacing_ok(t, ts)
        print(f"  {t['name'][:24]:24} {t['tag']:8} {t['w']:.0f}x{t['h']:.0f}  {'inline in text (exempt)' if t['inline'] else ('spacing exception holds' if ok else 'FAILS (too close to ' + by + ')')}")
    pg.close()
    pg = b.new_page(viewport={'width': 1320, 'height': 1400}); pg.add_init_script("const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (init) { return o.call(this, { ...init, mode: 'open' }); };")
    import subprocess, tempfile
    tmp = tempfile.mkdtemp(); subprocess.run([str(ROOT / 'node_modules/.bin/esbuild'), str(ROOT / 'docs/mockups/finding-g/feed-harness.ts'), '--bundle', '--log-level=warning', f'--outfile={tmp}/feed-harness.js'], check=True)
    pathlib.Path(tmp, 'feed.html').write_text(ns['HARNESS_HTML'] % (ROOT / 'public' / 'content.css').as_uri())
    pg.goto(pathlib.Path(tmp, 'feed.html').as_uri()); pg.wait_for_timeout(400)
    ts = pg.evaluate(MEASURE, None)
    print('FEED BARS (8 states)')
    seen = set()
    for t in ts:
        if t['w'] >= 24 and t['h'] >= 24: continue
        ok, by = spacing_ok(t, ts); key = (t['name'], round(t['h']), t['inline'], ok)
        if key in seen: continue
        seen.add(key)
        print(f"  {t['name'][:24]:24} {t['tag']:8} {t['w']:.0f}x{t['h']:.0f}  {'inline in text (exempt)' if t['inline'] else ('spacing exception holds' if ok else 'FAILS (too close to ' + by + ')')}")
    b.close()
