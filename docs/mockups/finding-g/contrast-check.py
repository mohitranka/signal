"""
Finding G contrast check, in a real browser (headed Chromium on Xvfb).
Run after `npm run build`:   xvfb-run -a python3 docs/mockups/finding-g/contrast-check.py
Optional: AXE=/path/to/axe.min.js to run axe-core's color-contrast rule as well.
Needs Python Playwright + Chromium (not a project dependency). Exits 1 if any check fails.

Renders, in light and dark:
  - the BUILT popup (dist/popup.html, mocked chrome API), every section open, an error status line, Keep/Low pills, and
    the corrections table twice: few corrections ("too few" numbers, also in the current-sensitivity row) and enough
    corrections (wrongly-hidden numbers in the current-sensitivity row);
  - the REAL Presenter (feed-harness.ts, bundled with the project's esbuild) in all 8 bar states on a LinkedIn-like
    page; the quiet "Low quality" button is also checked hovered and keyboard-focused.
Own text scan: every element with text, its colour times inherited opacity, composited over its real background
(walking up through shadow roots), against 4.5:1. axe leaves one-character text such as "1" as "incomplete", hence the
own scan. The viewport is tall enough that nothing is off-screen (axe only measures what is in the viewport).
"""
import os, pathlib, subprocess, sys, tempfile
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
POPUP = (ROOT / 'dist' / 'popup.html').as_uri()
AXE = open(os.environ['AXE']).read() if os.environ.get('AXE') else None

RECORDS = """
const rec = (c) => ({ classification: c, model: 'openai/gpt-4o-mini', promptVersion: 'v1' });
const sig = (o) => ({ originality: o, evidence: o, reasoning: o, usefulness: o, sensationalism: 1 - o, engagement_bait: 1 - o });
const noise = { decision: 'collapse', confidence: 0.97, reason: 'bait', signals: sig(0.05) };
const keep = { decision: 'keep', confidence: 0.9, reason: 'ok', signals: sig(0.6) };
const feedback = (kept, low, wrong) => { const fb = {};
  for (let i = 0; i < kept; i++) fb['k' + i] = { verdict: 'keep', at: 100 + i, sample: 'kept post ' + i, classified: { ...rec(i < wrong ? noise : keep), ...(i === wrong ? { repeatOf: { fp: 'a'.repeat(32), similarity: 0.9 } } : {}) } };
  for (let i = 0; i < low; i++) fb['l' + i] = { verdict: 'collapse', at: i, sample: 'low post ' + i, classified: rec(i ? noise : keep) };
  fb.old = { verdict: 'keep', at: 1, sample: 'legacy post' }; return fb; };
"""
def mock(kept, low, wrong):
    return RECORDS + """
window.chrome = { runtime: { sendMessage: async (m) => ({ getSettings: { enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', hasApiKey: true, concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: 0.15, outputPricePerM: 0.6, repeats: true },
  getStats: { stats: { httpRequests: 12, classified: 10, cacheHits: 3, repeatHits: 2, failures: 1, promptTokens: 9000, completionTokens: 800, totalLatencyMs: 9000 }, cacheSize: 13, repeatIndexSize: 9, prices: { input: 0.15, output: 0.6 } },
  listFeedback: feedback(%d, %d, %d) })[m.type] }, permissions: { request: async () => true }, tabs: { query: async () => [] } };""" % (kept, low, wrong)

SCAN = r"""(scope) => {
  const parse = s => { const m = s.match(/[\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const over = (t, b, a = t.a) => ({ r: t.r * a + b.r * (1 - a), g: t.g * a + b.g * (1 - a), b: t.b * a + b.b * (1 - a), a: 1 });
  const up = e => e.parentElement || (e.getRootNode() instanceof ShadowRoot ? e.getRootNode().host : null);
  const chain = el => { const out = []; for (let e = el; e; e = up(e)) out.push(e); return out; };
  const out = [];
  const visit = root => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) visit(el.shadowRoot);
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
    if (!text || el.getClientRects().length === 0) continue; const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue;
    // Backgrounds painted top-down (root first). Opacity fades the whole subtree of the outermost translucent element
    // over what lies beneath it; Signal only uses opacity on the text element itself, so this is exact for its CSS.
    const layers = chain(el).reverse(); const white = { r: 255, g: 255, b: 255, a: 1 };
    const paint = es => es.reduce((acc, e) => over(parse(getComputedStyle(e).backgroundColor), acc), white);
    const box = paint(layers); const inside = over(parse(cs.color), box);
    const k = layers.findIndex(e => +getComputedStyle(e).opacity < 1);
    const alpha = layers.reduce((a, e) => a * +getComputedStyle(e).opacity, 1);
    const beneath = k === -1 ? box : paint(layers.slice(0, k));
    const fg = k === -1 ? inside : over(inside, beneath, alpha); const bgFinal = k === -1 ? box : over(box, beneath, alpha);
    const L1 = lum(fg), L2 = lum(bgFinal); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
    const size = parseFloat(cs.fontSize), w = +cs.fontWeight; const need = (size >= 24 || (size >= 18.66 && w >= 700)) ? 3 : 4.5;
    if (ratio < need) out.push(`${ratio.toFixed(2)}:1 "${text.slice(0, 40)}" <${el.tagName.toLowerCase()} class="${el.className}">`); } };
  visit(scope ? document.querySelector(scope) : document); return out; }"""
AXE_RUN = """async () => (await axe.run(document, { runOnly: ['color-contrast'], resultTypes: ['violations'] })).violations
  .flatMap(v => v.nodes.map(n => n.target.join(' ') + ': ' + n.any[0].message.split(' (foreground')[0]))"""
OPEN_SHADOW = "const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (init) { return o.call(this, { ...init, mode: 'open' }); };"
HARNESS_HTML = """<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="%s">
<style>body{margin:0;background:#f4f2ee;color:#191919;font:14px system-ui}.page{display:grid;grid-template-columns:600px 600px;gap:18px 36px;padding:24px 36px;width:max-content}
h3{margin:0 0 6px;font-size:13px}.post{background:#fff;border:1px solid #dfdeda;border-radius:8px;padding:12px 16px}
@media (prefers-color-scheme: dark){body{background:#000;color:#e8e8e8}.post{background:#1b1f23;border-color:#38434f}}</style>
<div class="page" id="page"></div><script src="feed-harness.js"></script>"""

failures = []
def report(case, scan, axe, must=None):
    problems = [f'own scan {s}' for s in scan] + [f'axe {s}' for s in (axe or [])]
    if must: problems.append(must)
    print(('FAIL ' if problems else 'ok   ') + case + ('' if problems else f" (own scan 0{'' if axe is None else ', axe 0'})"))
    for p in problems: print('       ' + p)
    failures.extend(problems)

with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
    esbuild = ROOT / 'node_modules' / '.bin' / 'esbuild'
    subprocess.run([str(esbuild), str(HERE / 'feed-harness.ts'), '--bundle', '--log-level=warning', f'--outfile={tmp}/feed-harness.js'], check=True)
    pathlib.Path(tmp, 'feed.html').write_text(HARNESS_HTML % (ROOT / 'public' / 'content.css').as_uri())
    b = p.chromium.launch(headless=False)
    for scheme in ['light', 'dark']:
        for label, (kept, low, wrong), probe in [('few corrections ("too few" numbers)', (4, 3, 1), '.corr tr.current td.weak'),
                                                  ('enough corrections (wrongly-hidden numbers)', (12, 12, 2), '.corr tr.current td.bad')]:
            pg = b.new_page(viewport={'width': 360, 'height': 2400}, color_scheme=scheme); pg.add_init_script(mock(kept, low, wrong))
            pg.goto(POPUP); pg.wait_for_timeout(300)
            pg.evaluate("""() => { for (const d of document.querySelectorAll('details')) d.open = true;
              const s = document.getElementById('llmStatus'); s.textContent = 'auth: Authentication failed (401).'; s.className = 'err'; }""")
            pg.wait_for_timeout(250)
            covered = pg.evaluate(f"() => !!document.querySelector('{probe}') && !!document.querySelector('.pill.keep') && !!document.querySelector('.pill.low')")
            axe = None
            if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate(AXE_RUN)
            report(f'popup {scheme}, {label}', pg.evaluate(SCAN, None), axe, None if covered else f'render lacks {probe} or the pills')
            pg.close()
        pg = b.new_page(viewport={'width': 1320, 'height': 1400}, color_scheme=scheme); pg.add_init_script(OPEN_SHADOW)
        pg.goto(pathlib.Path(tmp, 'feed.html').as_uri()); pg.wait_for_timeout(400)
        n = pg.locator('[data-signal-bar]').count()
        axe = None
        if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate(AXE_RUN)
        report(f'feed {scheme}, all 8 bar states at rest', pg.evaluate(SCAN, None), axe, None if n == 8 else f'{n} bars rendered, expected 8')
        quiet = pg.locator('.frame').nth(5).locator('[data-signal-bar]').locator('button', has_text='Low quality')
        quiet.hover(); pg.wait_for_timeout(300)
        hovered = quiet.evaluate("b => b.matches(':hover')")
        report(f'feed {scheme}, quiet button hovered', pg.evaluate(SCAN, None), None, None if hovered else 'hover did not register')
        pg.mouse.move(0, 0); pg.keyboard.press('Tab'); quiet.focus(); pg.wait_for_timeout(300)
        focused = quiet.evaluate("b => b.matches(':focus-visible')")
        report(f'feed {scheme}, quiet button keyboard-focused', pg.evaluate(SCAN, None), None, None if focused else 'focus-visible did not register')
        pg.close()
    b.close()
print(f"\n{len(failures)} failure(s)")
sys.exit(1 if failures else 0)
