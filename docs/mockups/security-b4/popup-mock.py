"""
Security B4 popup mockup (SDLC step 3): the BUILT popup with the bridge preset, today vs the proposed wording, in
headed Chromium (classic scrollbars), light and dark, a wide and a typical font. "After" = the proposed text injected
into the real popup (not a redraw). The cost tile's tooltip is drawn for the picture (the real one is the browser's).
Checks each render: no horizontal overflow, nothing truncated, text contrast (own scan; axe when AXE is set).
Run after `npm run build`:   xvfb-run -a python3 docs/mockups/security-b4/popup-mock.py
"""
import os, pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
POPUP = (ROOT / 'dist' / 'popup.html').as_uri()
base = (ROOT / 'docs' / 'mockups' / 'bridge' / 'as-built' / 'check.py').read_text()
ns = {}
exec(base.split('failures = []')[0].replace("HERE = pathlib.Path(__file__).resolve().parent", f"HERE = pathlib.Path({str(ROOT / 'docs/mockups/bridge/as-built')!r})"), ns)
MOCK, FONTS, SCAN, AXE = ns['MOCK'], ns['FONTS'], ns['SCAN'], ns['AXE']
AFTER = r"""() => {
  const help = document.getElementById('presetHelp');
  help.firstChild.textContent = 'Uses the Claude Code or Codex CLI you are logged in to, through a small server on this computer. Start it with ';
  const s = document.getElementById('llmStatus'); s.textContent = s.textContent.replace(' · via Claude Code subscription', ' · via your Claude Code login');
  document.getElementById('stCost').parentElement.title = 'Plan · Through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)';
}"""
TIP = r"""() => {
  const tile = document.getElementById('stCost').parentElement; const r = tile.getBoundingClientRect();
  const tip = document.createElement('div'); tip.id = 'mock-tip'; tip.textContent = tile.title;
  tip.style.cssText = `position:absolute;left:${Math.max(8, r.right - 250)}px;top:${r.bottom + window.scrollY + 6}px;width:240px;font:12px system-ui;background:#1c1f23;color:#fff;padding:6px 8px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25);z-index:9`;
  document.body.appendChild(tip); }"""
MEASURE = r"""() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  cut: [...document.querySelectorAll('.chip, .tile b, .tile span, #presetHelp, #llmStatus')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.id || e.className),
  help: document.getElementById('presetHelp').textContent, status: document.getElementById('llmStatus').textContent, title: document.getElementById('stCost').parentElement.title,
  helpLines: Math.round(document.getElementById('presetHelp').getBoundingClientRect().height / parseFloat(getComputedStyle(document.getElementById('presetHelp')).lineHeight)) })"""
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for scheme in ['light', 'dark']:
        for fname, fcss in FONTS.items():
            for state in ['today', 'after']:
                pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2)
                pg.add_init_script(MOCK); pg.goto(POPUP); pg.wait_for_timeout(300)
                if fcss: pg.add_style_tag(content=fcss)
                pg.evaluate("document.getElementById('llm').open = true")
                pg.click('#test'); pg.wait_for_timeout(300)
                if state == 'after': pg.evaluate(AFTER)
                pg.wait_for_timeout(100)
                m = pg.evaluate(MEASURE); scan = pg.evaluate(SCAN, None)
                axe = None
                if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate("async () => (await axe.run(document, { runOnly: ['color-contrast'] })).violations.flatMap(v => v.nodes.map(n => n.target.join(' ')))")
                pg.set_viewport_size({'width': 360, 'height': pg.evaluate('document.documentElement.scrollHeight') + 90}); pg.wait_for_timeout(100)
                pg.evaluate(TIP); pg.wait_for_timeout(50)
                top = pg.evaluate("document.getElementById('llm').getBoundingClientRect().top") - 6
                bottom = pg.evaluate("document.getElementById('mock-tip').getBoundingClientRect().bottom") + 8
                pg.screenshot(path=str(HERE / f'popup-{state}-{scheme}-{fname}.png'), clip={'x': 0, 'y': top, 'width': 360, 'height': bottom - top})
                pg.close()
                probs = ([f"overflow {m['overflow']}px"] if m['overflow'] > 0 else []) + ([f"cut {m['cut']}"] if m['cut'] else []) + [f'contrast {x}' for x in scan] + [f'axe {x}' for x in (axe or [])]
                print(('FAIL ' if probs else 'ok   ') + f"{state:5} {scheme:5} {fname:10} help {m['helpLines']} lines · status «{m['status'][:60]}…»" + ('' if not probs else ' ' + '; '.join(probs)))
                fails += probs
    b.close()
sys.exit(1 if fails else 0)
