"""
Findings J + K, as built: the BUILT popup (no injection), the checks of popup-mock.py and popup-audit.py.
Sub-cent and large sessions; light and dark; DejaVu Sans and Liberation Sans; with and without a scrollbar; Details
closed and open. Per render: overflow, cut text, contrast (own scan), axe (all rules, when AXE is set), visible focus on
every tab stop. Once per scheme: screen-reader text of the cost tile, the disclosure in the accessibility tree, the
summary's size. Saves stats-as-built-<scheme>.png.   Run after `npm run build`:
    AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/finding-jk/as-built-check.py
"""
import json, os, pathlib, sys
from playwright.sync_api import sync_playwright
HERE = pathlib.Path(__file__).resolve().parent
src = (HERE / 'popup-mock.py').read_text(); ns = {'__file__': str(HERE / 'popup-mock.py')}
exec(src.split('fails = []')[0], ns)
MOCK, POPUP, STATS, SCAN, FONTS = ns['MOCK'], ns['POPUP'], ns['STATS'], ns['SCAN'], ns['FONTS']
AXE = open(os.environ['AXE']).read() if os.environ.get('AXE') else None
MEASURE = r"""() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  cut: [...document.querySelectorAll('.tile b, .tile span:not(.sr), .tile-details li, .tile-details summary')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent),
  cost: document.getElementById('stCost').textContent, scrollbar: innerWidth - document.documentElement.clientWidth > 0 })"""
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for name, stats, (pin, pout) in [('sub-cent', STATS, (0.15, 0.6)), ('dollars', {**STATS, 'promptTokens': 198_400, 'completionTokens': 19_880}, (100, 100))]:
        for scheme in ['light', 'dark']:
            for fname, fcss in FONTS.items():
                for open_details in [False, True]:
                    for scroll in [False, True]:
                        pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2)
                        pg.add_init_script(MOCK % (pin, pout, json.dumps(stats), pin, pout)); pg.goto(POPUP); pg.wait_for_timeout(300)
                        if fcss: pg.add_style_tag(content=fcss)
                        if open_details: pg.evaluate("document.getElementById('statsDetails').open = true")
                        if scroll: pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true")
                        pg.wait_for_timeout(150)
                        m = pg.evaluate(MEASURE); scan = pg.evaluate(SCAN, None)
                        if name == 'sub-cent' and fname == 'dejavu' and scroll and open_details:
                            pg.locator('#statsBox').scroll_into_view_if_needed(); pg.locator('#statsBox').screenshot(path=str(HERE / f'stats-as-built-{scheme}.png'))
                        if name == 'sub-cent' and fname == 'dejavu' and not scroll and not open_details:
                            cdp = pg.context.new_cdp_session(pg); nodes = cdp.send('Accessibility.getFullAXTree')['nodes']
                            spoken = [n['name']['value'] for n in nodes if n.get('role', {}).get('value') == 'StaticText' and ('cent' in n['name']['value'] or '$0.01' in n['name']['value'])]
                            disc = [n for n in nodes if n.get('role', {}).get('value') == 'DisclosureTriangle' and n.get('name', {}).get('value') == 'Details']  # the popup has other disclosures too
                            size = pg.evaluate("(() => { const r = document.querySelector('.tile-details > summary').getBoundingClientRect(); return +r.height.toFixed(1); })()")
                            print(f"  {scheme}: cost tile read as {spoken}; disclosure in the tree: {len(disc)}; Details summary height {size} px")
                            if spoken != ['under 1 cent'] or len(disc) != 1 or size < 24: fails.append(f'{scheme} accessibility')
                        pg.mouse.click(5, 5); noring = []
                        for i in range(40):
                            pg.keyboard.press('Tab')
                            r = pg.evaluate("""() => { const el = document.activeElement; if (!el || el === document.body) return null; const vis = (e) => { const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; }; const sib = el.nextElementSibling; return { what: el.id || el.textContent.trim().slice(0, 14), ring: vis(el) || !!(sib && vis(sib)) }; }""")
                            if r and not r['ring']: noring.append(r['what'])
                        axe = None
                        if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate("async () => (await axe.run(document)).violations.map(v => v.id + ' ×' + v.nodes.length)")
                        pg.close()
                        probs = ([f"overflow {m['overflow']}px"] if m['overflow'] > 0 else []) + ([f"cut {m['cut']}"] if m['cut'] else []) + [f'contrast {x}' for x in scan] + [f'axe {x}' for x in (axe or [])] + ([f'no visible focus: {noring}'] if noring else [])
                        print(('FAIL ' if probs else 'ok   ') + f"{name:8} {scheme:5} {fname:10} {'open' if open_details else 'closed':6} {'scrollbar' if m['scrollbar'] else 'no scrollbar':12} cost «{m['cost']}»" + ('' if not probs else '  ' + '; '.join(probs)))
                        fails += probs
    b.close()
sys.exit(1 if fails else 0)
