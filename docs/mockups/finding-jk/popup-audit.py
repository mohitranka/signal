"""
Findings J + K, extended popup audit of the "after" mockup (headed Chromium): what assistive technology gets (the
Details disclosure and its list, via Chromium's accessibility tree), keyboard operation of the disclosure, forced
colours, colour-blindness renders, and 200 % zoom.   Run: AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/finding-jk/popup-audit.py
"""
import json, pathlib
from playwright.sync_api import sync_playwright
HERE = pathlib.Path(__file__).resolve().parent
src = (HERE / 'popup-mock.py').read_text(); ns = {'__file__': str(HERE / 'popup-mock.py')}
exec(src.split('fails = []')[0], ns)
MOCK, AFTER, AFTER_CSS, POPUP, STATS = ns['MOCK'], ns['AFTER'], ns['AFTER_CSS'], ns['POPUP'], ns['STATS']
def page(b, scheme, **kw):
    pg = b.new_page(viewport=kw.get('viewport', {'width': 360, 'height': 600}), color_scheme=scheme)
    if kw.get('forced'): pg.emulate_media(forced_colors='active')
    pg.add_init_script(MOCK % (0.15, 0.6, json.dumps(STATS), 0.15, 0.6)); pg.goto(POPUP); pg.wait_for_timeout(300)
    pg.add_style_tag(content=AFTER_CSS); pg.evaluate(AFTER, {**STATS, 'pin': 0.15, 'pout': 0.6}); return pg
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for scheme in ['light', 'dark']:
        print(f'== {scheme}')
        pg = page(b, scheme); cdp = pg.context.new_cdp_session(pg)
        # keyboard: reach the Details summary with Tab, open it with Enter
        pg.mouse.click(5, 5)
        for i in range(40):
            pg.keyboard.press('Tab')
            if pg.evaluate("document.activeElement && document.activeElement.closest('#statsDetails') !== null"): break
        focused = pg.evaluate("document.activeElement.tagName + ' ' + document.activeElement.textContent")
        ring = pg.evaluate("(() => { const s = getComputedStyle(document.activeElement); return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0; })()")
        pg.keyboard.press('Enter'); pg.wait_for_timeout(100)
        opened = pg.evaluate("document.getElementById('statsDetails').open")
        nodes = cdp.send('Accessibility.getFullAXTree')['nodes']
        summary = next((n for n in nodes if (n.get('name', {}).get('value') or '') == 'Details' and n.get('role', {}).get('value') not in ('StaticText', 'InlineTextBox')), None)
        expanded = summary and next((pp['value'].get('value') for pp in summary.get('properties', []) if pp['name'] == 'expanded'), None)
        texts = [n['name']['value'] for n in nodes if n.get('role', {}).get('value') == 'StaticText' and any(k in n.get('name', {}).get('value', '') for k in ['posts ·', 'entries stored', 'copied from', ' in · ', 'from your configured'])]
        print(f"  keyboard: Tab reaches «{focused}» (visible focus ring: {ring}); Enter opens it: {opened}")
        costTile = [n['name']['value'] for n in nodes if n.get('role', {}).get('value') == 'StaticText' and ('cent' in n.get('name', {}).get('value', '') or '$0.01' in n.get('name', {}).get('value', ''))]
        print(f"  cost tile as read by a screen reader: {costTile}")
        print(f"  accessibility tree: summary role «{summary and summary['role']['value']}», expanded={expanded}; detail lines exposed: {len(texts)}/5")
        for t in texts: print('    ·', t)
        size = pg.evaluate("(() => { const r = document.querySelector('.tile-details > summary').getBoundingClientRect(); return [Math.round(r.width), +r.height.toFixed(1)]; })()")
        print('  Details summary size in CSS px (WCAG 2.5.8 wants >= 24 tall):', size)
        pg.evaluate("document.getElementById('llm').open = false")
        for vd in ['deuteranopia', 'protanopia']:
            cdp.send('Emulation.setEmulatedVisionDeficiency', {'type': vd}); pg.wait_for_timeout(80)
            pg.locator('#statsBox').screenshot(path=str(HERE / f'stats-{vd}-{scheme}.png'))
        pg.close()
        pg = page(b, scheme, forced=True); pg.evaluate("document.getElementById('statsDetails').open = true"); pg.wait_for_timeout(80)
        fc = pg.evaluate("() => ({ li: getComputedStyle(document.querySelector('.tile-details li')).color, summary: getComputedStyle(document.querySelector('.tile-details summary')).color, bg: getComputedStyle(document.body).backgroundColor })")
        pg.locator('#statsBox').screenshot(path=str(HERE / f'stats-forced-colors-{scheme}.png')); pg.close()
        print('  forced colours:', fc)
        pg = page(b, scheme, viewport={'width': 720, 'height': 600}); pg.evaluate("document.documentElement.style.zoom = '200%'; document.getElementById('statsDetails').open = true"); pg.wait_for_timeout(100)
        z = pg.evaluate("() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cut: [...document.querySelectorAll('.tile b, .tile span:not(.sr), .tile-details li')].filter(e => e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent) })")
        pg.close(); print('  zoom 200 %:', z)
    b.close()
