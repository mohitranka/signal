"""
Bridge T7 check, in a real browser (headed Chromium on Xvfb: classic scrollbars). Run after `npm run build`:
    xvfb-run -a python3 docs/mockups/bridge/as-built/check.py        (optional: AXE=/path/to/axe.min.js)
Renders the BUILT popup with the bridge preset (mocked chrome API: model claude-code/sonnet, Model and Advanced open,
a successful Test connection), in light and dark, under a wide and a typical font, and checks:
  - no horizontal overflow, nothing truncated (chip, provider select, help line, "Plan" tile);
  - text contrast (the own scan from finding G's contrast-check.py; axe too when AXE is set);
  - the help line is the Provider select's accessible description.
Saves popup-bridge-<scheme>-<font>.png next to this script, to compare with the approved mockup (../popup-bridge-*.png).
Exits 1 on any failure.
"""
import os, pathlib, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[3]
POPUP = (ROOT / 'dist' / 'popup.html').as_uri()
G = (ROOT / 'docs' / 'mockups' / 'finding-g' / 'contrast-check.py').read_text()
SCAN = G.split('SCAN = r"""')[1].split('"""')[0]
AXE = open(os.environ['AXE']).read() if os.environ.get('AXE') else None
MOCK = """const S = { enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: 'http://127.0.0.1:8791/v1', model: 'claude-code/sonnet', hasApiKey: true, concurrency: 1, timeoutMs: 90000, jsonMode: true, inputPricePerM: 0.15, outputPricePerM: 0.6, repeats: true };
window.chrome = { runtime: { sendMessage: async (m) => ({ getSettings: S, saveSettings: S,
  getStats: { stats: { httpRequests: 41, classified: 41, cacheHits: 12, repeatHits: 9, failures: 0, promptTokens: 35000, completionTokens: 3000, totalLatencyMs: 170000 }, cacheSize: 53, repeatIndexSize: 41, prices: { input: 0.15, output: 0.6 } },
  listFeedback: {}, testConnection: { ok: true, latencyMs: 4210, decision: 'keep' } })[m.type] },
  permissions: { request: async () => true }, tabs: { query: async () => [] } };"""
FONTS = {'dejavu': '', 'liberation': "body, button, input, select, code { font-family: 'Liberation Sans' !important; }"}
MEASURE = r"""() => {
  const W = document.documentElement.clientWidth;
  const cut = [...document.querySelectorAll('.chip, .tile b, .tile span, #presetHelp, #llmStatus, label.input')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.id || e.className || e.tagName);
  const sel = document.getElementById('preset'); const selText = sel.options[sel.selectedIndex].text;
  const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(sel).font;
  const selFits = c.measureText(selText).width <= sel.clientWidth - 28; // room for padding and the arrow
  return { overflow: document.documentElement.scrollWidth - W, cut, selFits, selText, chip: document.getElementById('llmChip').textContent,
    cost: document.getElementById('stCost').textContent, label: document.getElementById('apiKeyLabel').textContent, status: document.getElementById('llmStatus').textContent }; }"""
failures = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for scheme in ['light', 'dark']:
        for fname, fcss in FONTS.items():
            pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2)
            pg.add_init_script(MOCK); pg.goto(POPUP); pg.wait_for_timeout(300)
            if fcss: pg.add_style_tag(content=fcss)
            pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true")
            pg.click('#test'); pg.wait_for_timeout(300)
            r = pg.evaluate(MEASURE)
            desc = pg.evaluate("() => { const s = document.getElementById('preset'); return (s.getAttribute('aria-describedby') || '').split(' ').map(id => document.getElementById(id)?.textContent).join(' '); }")
            scan = pg.evaluate(SCAN, None)
            axe = None
            if AXE:
                pg.add_script_tag(content=AXE)
                axe = pg.evaluate("async () => (await axe.run(document, { runOnly: ['color-contrast'] })).violations.flatMap(v => v.nodes.map(n => n.target.join(' ')))")
            # The real popup is at most 600 px tall (checked above, with its scrollbar); the picture shows it all at once.
            pg.set_viewport_size({'width': 360, 'height': pg.evaluate('document.documentElement.scrollHeight')})
            pg.wait_for_timeout(150)
            pg.screenshot(path=str(HERE / f'popup-bridge-{scheme}-{fname}.png'))
            pg.close()
            problems = []
            if r['overflow'] > 0: problems.append(f"horizontal overflow {r['overflow']} px")
            if r['cut']: problems.append(f"truncated: {r['cut']}")
            if not r['selFits']: problems.append(f"provider select text does not fit: {r['selText']}")
            if r['chip'] != 'claude-code · sonnet' or r['cost'] != 'Plan' or r['label'] != 'Bridge token': problems.append(f"content: {r}")
            if not r['status'].endswith('· via your Claude Code login'): problems.append(f"status: {r['status']}")
            if not desc.startswith('Uses the Claude Code or Codex CLI you are logged in to'): problems.append(f'accessible description: {desc!r}')
            problems += [f'contrast (own scan) {s}' for s in scan] + [f'contrast (axe) {s}' for s in (axe or [])]
            print(('FAIL ' if problems else 'ok   ') + f'{scheme}, {fname}' + ('' if problems else f" (chip, select, tiles fit; contrast 0{'' if axe is None else ', axe 0'})"))
            for x in problems: print('       ' + x)
            failures += problems
    b.close()
sys.exit(1 if failures else 0)
