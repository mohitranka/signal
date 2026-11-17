"""
Security B4, extended browser audit of the POPUP mockup (headed Chromium, classic scrollbars), today vs after, light
and dark: full axe run (all rules), keyboard order and visible focus, what assistive technology gets for the changed
texts (Chromium's accessibility tree via CDP), colour-blindness renders, forced colours, and 200 % zoom.
Run after `npm run build`:   AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/security-b4/audit/popup-audit.py
"""
import json, os, pathlib
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
src = (HERE.parent / 'popup-mock.py').read_text()
ns = {'__file__': str(HERE.parent / 'popup-mock.py')}
exec(src.split('fails = []')[0], ns)
MOCK, AFTER, POPUP = ns['MOCK'], ns['AFTER'], ns['POPUP']
AXE = open(os.environ['AXE']).read()
FOCUS = r"""async () => {
  const out = [];
  for (let i = 0; i < 40; i++) {
    const el = document.activeElement; if (!el || el === document.body) { out.push(null); continue; }
    const s = getComputedStyle(el); const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 || s.boxShadow !== 'none';
    const sib = el.nextElementSibling; const ringSib = sib && sib.classList?.contains('track') ? getComputedStyle(sib).outlineStyle !== 'none' : false;
    out.push({ tag: el.tagName.toLowerCase(), id: el.id || el.name || el.textContent.trim().slice(0, 20), ring: ring || ringSib });
    await new Promise(r => setTimeout(r, 0));
    break; } return out; }"""

def ax_node(cdp, predicate):
    nodes = cdp.send('Accessibility.getFullAXTree')['nodes']
    for n in nodes:
        if predicate(n): return n
    return None
def prop(n, name):
    for p in n.get('properties', []):
        if p['name'] == name: return p['value'].get('value')
    return None

with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    report = {}
    for scheme in ['light', 'dark']:
        for state in ['today', 'after']:
            key = f'{state}-{scheme}'
            pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme)
            pg.add_init_script(MOCK); pg.goto(POPUP); pg.wait_for_timeout(300)
            pg.evaluate("document.getElementById('llm').open = true"); pg.click('#test'); pg.wait_for_timeout(300)
            if state == 'after': pg.evaluate(AFTER)
            # 1. full axe
            pg.add_script_tag(content=AXE)
            axe = pg.evaluate("async () => (await axe.run(document)).violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, targets: v.nodes.slice(0, 4).map(x => x.target.join(' ')) }))")
            # 2. keyboard: Tab order through the popup, visible focus on each stop
            pg.mouse.click(5, 5)
            stops = []
            for i in range(30):
                pg.keyboard.press('Tab'); pg.wait_for_timeout(20)
                stops.append(pg.evaluate("""() => { const el = document.activeElement; if (!el || el === document.body) return null;
                  const vis = (e) => { const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; };
                  const sib = el.nextElementSibling; const ring = vis(el) || (sib && (sib.classList.contains('track') || el.closest('.segmented')) && vis(sib));
                  return { what: el.id || el.getAttribute('name') + '=' + el.value || el.textContent.trim().slice(0, 18), ring }; }"""))
            # 3. accessibility tree: the Provider select's description; the status line; the cost tile
            cdp = pg.context.new_cdp_session(pg)
            sel = ax_node(cdp, lambda n: n.get('role', {}).get('value') == 'combobox' and (n.get('name', {}).get('value') or '').startswith('Provider'))
            status = ax_node(cdp, lambda n: n.get('role', {}).get('value') == 'status')
            tile = ax_node(cdp, lambda n: 'Plan' in json.dumps(n.get('name', {})) or 'Plan ·' in json.dumps(n.get('description', {})))
            tile_focusable = pg.evaluate("() => document.getElementById('stCost').parentElement.tabIndex >= 0")
            report[key] = {
                'axe': axe,
                'tab_stops_without_visible_focus': [s for s in stops if s and not s['ring']],
                'tab_order': [s['what'] for s in stops if s][:30],
                'provider_description': sel and sel.get('description', {}).get('value'),
                'status_name_or_text': status and (status.get('name', {}).get('value') or ''),
                'cost_tile_description': tile and (tile.get('description', {}).get('value') or tile.get('name', {}).get('value')),
                'cost_tile_focusable': tile_focusable,
            }
            # 4. colour-blindness renders and forced colours (after only), 5. zoom 200 %
            if state == 'after':
                for vd in ['deuteranopia', 'protanopia']:
                    cdp.send('Emulation.setEmulatedVisionDeficiency', {'type': vd}); pg.wait_for_timeout(100)
                    pg.locator('#llm').screenshot(path=str(HERE / f'popup-{vd}-{scheme}.png'))
                cdp.send('Emulation.setEmulatedVisionDeficiency', {'type': 'none'})
            pg.close()
            if state == 'after':
                pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme); pg.emulate_media(forced_colors='active')
                pg.add_init_script(MOCK); pg.goto(POPUP); pg.wait_for_timeout(300)
                pg.evaluate("document.getElementById('llm').open = true"); pg.click('#test'); pg.wait_for_timeout(300); pg.evaluate(AFTER)
                fc = pg.evaluate("() => ({ code: getComputedStyle(document.querySelector('#presetHelp code')).color, help: getComputedStyle(document.getElementById('presetHelp')).color, status: getComputedStyle(document.getElementById('llmStatus')).color, bg: getComputedStyle(document.body).backgroundColor })")
                pg.locator('#llm').screenshot(path=str(HERE / f'popup-forced-colors-{scheme}.png')); pg.close()
                report[key]['forced_colors'] = fc
                pg = b.new_page(viewport={'width': 720, 'height': 600}, color_scheme=scheme, device_scale_factor=1)
                pg.add_init_script(MOCK); pg.goto(POPUP); pg.wait_for_timeout(300)
                pg.evaluate("document.documentElement.style.zoom = '200%'; document.getElementById('llm').open = true"); pg.click('#test'); pg.wait_for_timeout(300); pg.evaluate(AFTER); pg.wait_for_timeout(100)
                report[key]['zoom200'] = pg.evaluate("() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cut: [...document.querySelectorAll('.chip, .tile b, .tile span, #presetHelp, #llmStatus')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.id || e.className) })")
                pg.close()
    b.close()
json.dump(report, open(HERE / 'popup-audit.json', 'w'), indent=1)
for k, r in report.items():
    print(f"== {k}")
    print('  axe violations:', [(v['id'], v['impact'], v['n']) for v in r['axe']] or 'none')
    print('  tab stops without a visible focus indicator:', r['tab_stops_without_visible_focus'] or 'none', f"(of {len(r['tab_order'])} stops)")
    print('  Provider select, accessible description:', repr(r['provider_description']))
    print('  status line (role=status):', repr(r['status_name_or_text']))
    print('  cost tile: accessible text', repr(r['cost_tile_description']), '· keyboard-focusable:', r['cost_tile_focusable'])
    if 'forced_colors' in r: print('  forced colours:', r['forced_colors'])
    if 'zoom200' in r: print('  zoom 200 %:', r['zoom200'])
