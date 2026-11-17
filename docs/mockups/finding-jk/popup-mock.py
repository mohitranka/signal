"""
Findings J + K popup mockup (SDLC step 3): the BUILT popup, today vs after (K-a: a sub-cent cost shows "<$0.01";
J-b: a "Details" disclosure under the tiles listing the five details as text), injected into the real popup (not
redrawn). Headed Chromium (classic scrollbars), light and dark, DejaVu Sans (wide) and Liberation Sans (typical), with
a scrollbar (Model and Advanced open) and without (all closed), Details closed and open.
Checks per render: no horizontal overflow; no tile text cut (the realistic values include a sub-cent cost); text
contrast (own scan); axe, all rules (when AXE is set); every tab stop shows a visible focus indicator.
Run after `npm run build`:   AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/finding-jk/popup-mock.py
"""
import os, pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
POPUP = (ROOT / 'dist' / 'popup.html').as_uri()
G = (ROOT / 'docs' / 'mockups' / 'finding-g' / 'contrast-check.py').read_text()
SCAN = G.split('SCAN = r"""')[1].split('"""')[0]
AXE = open(os.environ['AXE']).read() if os.environ.get('AXE') else None
FONTS = {'dejavu': '', 'liberation': "body, button, input, select, code { font-family: 'Liberation Sans' !important; }"}
STATS = {'httpRequests': 41, 'classified': 41, 'cacheHits': 12, 'repeatHits': 9, 'failures': 0, 'promptTokens': 35000, 'completionTokens': 3000, 'totalLatencyMs': 170000}
MOCK = """const S = { enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', hasApiKey: true, concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: %s, outputPricePerM: %s, repeats: true };
window.chrome = { runtime: { sendMessage: async (m) => ({ getSettings: S, saveSettings: S, getStats: { stats: %s, cacheSize: 53, repeatIndexSize: 41, prices: { input: %s, output: %s } }, listFeedback: {} })[m.type] }, permissions: { request: async () => true }, tabs: { query: async () => [] } };"""
# The proposal, injected: K-a on the cost tile, J-b disclosure (built with textContent, as the implementation will).
AFTER_CSS = """.tile-details { margin-top: 8px; }
.tile-details > summary { cursor: pointer; font-size: 12px; color: var(--muted); padding: 4px 0; } /* >= 24 px tall (WCAG 2.5.8) */
.tile-details ul { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.tile-details li { font-size: 12px; line-height: 1.4; color: var(--text); }
.tile-details li b { font-weight: 600; }"""
AFTER = r"""(s) => {
  const cost = (s.promptTokens * s.pin + s.completionTokens * s.pout) / 1e6;
  const exact = '$' + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2));
  const shown = cost === 0 ? '$0.00' : cost < 0.01 ? '<$0.01' : exact;
  const c = document.getElementById('stCost'); c.textContent = shown; c.parentElement.title = shown + ' · ' + exact + ' estimated from your configured prices';
  // Screen readers: "<$0.01" is read inconsistently; the tile says it in words (visually the same).
  if (shown === '<$0.01') { c.setAttribute('aria-hidden', 'true'); const sr = document.createElement('span'); sr.className = 'sr'; sr.textContent = 'under 1 cent'; c.after(sr); }
  const d = document.createElement('details'); d.className = 'tile-details'; d.id = 'statsDetails';
  const sm = document.createElement('summary'); sm.textContent = 'Details'; d.append(sm);
  const ul = document.createElement('ul');
  const line = (label, text) => { const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = label + ': '; li.append(b, text); ul.append(li); };
  const n = (x) => x.toLocaleString('en-US');
  line('Classified', `${n(s.classified)} posts · ${n(s.httpRequests)} HTTP requests · avg latency ${n(Math.round(s.totalLatencyMs / s.classified))} ms`);
  line('Cache hits', `${n(s.cacheHits)} · 53 entries stored`);
  line('Repeats', `${n(s.repeatHits)} copied from a similar post · no model call · 41 stored`);
  line('Tokens', `${n(s.promptTokens)} in · ${n(s.completionTokens)} out`);
  line('Estimated cost', `${cost === 0 ? '$0.00' : exact} from your configured prices`);
  d.append(ul);
  const stats = document.getElementById('stats'); stats.after(d);
}"""
MEASURE = r"""() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  cut: [...document.querySelectorAll('.tile b, .tile span:not(.sr), .tile-details li, .tile-details summary')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent),
  cost: document.getElementById('stCost').textContent, scrollbar: innerWidth - document.documentElement.clientWidth > 0 })"""
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    # sub-cent: a cheap model (0.15 / 0.6 $ per 1M); dollars: finding F's realistic large session (218k tokens at 100 / 100).
    for stats_name, stats, (pin, pout) in [('sub-cent', STATS, (0.15, 0.6)), ('dollars', {**STATS, 'promptTokens': 198_400, 'completionTokens': 19_880}, (100, 100))]:
        for scheme in ['light', 'dark']:
            for fname, fcss in FONTS.items():
                for case in ['today', 'after-closed', 'after-open']:
                    for scroll in [False, True]:
                        import json
                        pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2)
                        pg.add_init_script(MOCK % (pin, pout, json.dumps(stats), pin, pout)); pg.goto(POPUP); pg.wait_for_timeout(300)
                        if fcss: pg.add_style_tag(content=fcss)
                        if case != 'today': pg.add_style_tag(content=AFTER_CSS); pg.evaluate(AFTER, {**stats, 'pin': pin, 'pout': pout})
                        if case == 'after-open': pg.evaluate("document.getElementById('statsDetails').open = true")
                        if scroll: pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true")
                        pg.wait_for_timeout(150)
                        m = pg.evaluate(MEASURE); scan = pg.evaluate(SCAN, None)
                        if stats_name == 'sub-cent' and fname == 'dejavu' and scroll:
                            pg.locator('#statsBox').scroll_into_view_if_needed(); pg.wait_for_timeout(80)
                            pg.locator('#statsBox').screenshot(path=str(HERE / f'stats-{case}-{scheme}.png'))
                        pg.mouse.click(5, 5); noring = []; stops = 0
                        for i in range(40):
                            pg.keyboard.press('Tab')
                            r = pg.evaluate("""() => { const el = document.activeElement; if (!el || el === document.body) return null; const vis = (e) => { const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; }; const sib = el.nextElementSibling; return { what: el.id || el.textContent.trim().slice(0, 14), ring: vis(el) || !!(sib && vis(sib)) }; }""")
                            if r: stops += 1
                            if r and not r['ring']: noring.append(r['what'])
                        axe = None
                        if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate("async () => (await axe.run(document)).violations.map(v => v.id + ' ×' + v.nodes.length)")
                        pg.close()
                        probs = ([f"overflow {m['overflow']}px"] if m['overflow'] > 0 else []) + ([f"cut {m['cut']}"] if m['cut'] else []) + [f'contrast {x}' for x in scan] + [f'axe {x}' for x in (axe or [])] + ([f'no visible focus: {noring}'] if noring else [])
                        tag = f"{stats_name:8} {case:12} {scheme:5} {fname:10} {'scrollbar' if m['scrollbar'] else 'no scrollbar':12}"
                        print(('FAIL ' if probs else 'ok   ') + f"{tag} cost «{m['cost']}»" + ('' if not probs else '  ' + '; '.join(probs)))
                        if case != 'today': fails += probs
    b.close()
print('\n(today is shown for comparison: its failures are findings J/K themselves, not counted)')
sys.exit(1 if fails else 0)
