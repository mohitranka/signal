"""
Security B7 popup mockup (SDLC step 3): model `claude-code/sonnet` on a REMOTE endpoint (OpenRouter), today (the built
popup) vs after (the proposed behaviour injected into the real popup: no bridge wording), plus the normal bridge case
(unchanged), light and dark, a wide and a typical font, headed Chromium. Checks each render: no horizontal overflow,
nothing truncated, text contrast (own scan), axe (all rules, when AXE is set), a visible focus indicator on every tab stop.
Run after `npm run build`:   AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/security-b7/popup-mock.py
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
def mock(endpoint):
    return """const S = { enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: '%s', model: 'claude-code/sonnet', hasApiKey: true, concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: 0.15, outputPricePerM: 0.6, repeats: true };
window.chrome = { runtime: { sendMessage: async (m) => ({ getSettings: S, saveSettings: S,
  getStats: { stats: { httpRequests: 41, classified: 41, cacheHits: 12, repeatHits: 9, failures: 0, promptTokens: 35000, completionTokens: 3000, totalLatencyMs: 170000 }, cacheSize: 53, repeatIndexSize: 41, prices: { input: 0.15, output: 0.6 } },
  listFeedback: {}, testConnection: { ok: true, latencyMs: 812, decision: 'keep' } })[m.type] },
  permissions: { request: async () => true }, tabs: { query: async () => [] } };""" % endpoint
# What the popup would show without bridge wording (the general behaviour, as for any provider).
AFTER = r"""() => {
  document.getElementById('llmChip').textContent = 'sonnet';
  const cost = (35000 * 0.15 + 3000 * 0.6) / 1e6; const v = '$' + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2));
  const c = document.getElementById('stCost'); c.textContent = v; c.parentElement.title = v + ' · Estimated from your configured prices';
  document.getElementById('apiKeyLabel').textContent = 'API key';
  for (const [id, val] of [['inputPrice', '0.15'], ['outputPrice', '0.6']]) { const f = document.getElementById(id); f.disabled = false; f.value = val; f.placeholder = 'optional'; }
  const s = document.getElementById('llmStatus'); s.textContent = s.textContent.replace(' · via your Claude Code login', '');
}"""
MEASURE = r"""() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  cut: [...document.querySelectorAll('.chip, .tile b, .tile span, #presetHelp, #llmStatus')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 0.5).map(e => e.id || e.className),
  chip: document.getElementById('llmChip').textContent, cost: document.getElementById('stCost').textContent, label: document.getElementById('apiKeyLabel').textContent,
  prices: document.getElementById('inputPrice').disabled ? 'disabled' : 'editable', status: document.getElementById('llmStatus').textContent })"""
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for scheme in ['light', 'dark']:
        for fname, fcss in FONTS.items():
            for case, endpoint, inject in [('remote-today', 'https://openrouter.ai/api/v1', False), ('remote-after', 'https://openrouter.ai/api/v1', True), ('bridge-unchanged', 'http://127.0.0.1:8791/v1', False)]:
                pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2)
                pg.add_init_script(mock(endpoint)); pg.goto(POPUP); pg.wait_for_timeout(300)
                if fcss: pg.add_style_tag(content=fcss)
                pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true")
                pg.click('#test'); pg.wait_for_timeout(300)
                if inject: pg.evaluate(AFTER)
                pg.wait_for_timeout(100)
                m = pg.evaluate(MEASURE); scan = pg.evaluate(SCAN, None)
                pg.set_viewport_size({'width': 360, 'height': pg.evaluate('document.documentElement.scrollHeight')}); pg.wait_for_timeout(100)
                top = pg.evaluate("document.getElementById('llm').getBoundingClientRect().top") - 6
                bottom = pg.evaluate("document.getElementById('statsBox').getBoundingClientRect().bottom") + 6
                pg.screenshot(path=str(HERE / f'popup-{case}-{scheme}-{fname}.png'), clip={'x': 0, 'y': top, 'width': 360, 'height': bottom - top})
                pg.set_viewport_size({'width': 360, 'height': 600})
                pg.mouse.click(5, 5); noring = []
                for i in range(30):
                    pg.keyboard.press('Tab')
                    r = pg.evaluate("""() => { const el = document.activeElement; if (!el || el === document.body) return null; const vis = (e) => { const s = getComputedStyle(e); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; }; const sib = el.nextElementSibling; return { what: el.id || el.name, ring: vis(el) || !!(sib && vis(sib)) }; }""")
                    if r and not r['ring']: noring.append(r['what'])
                axe = None
                if AXE: pg.add_script_tag(content=AXE); axe = pg.evaluate("async () => (await axe.run(document)).violations.map(v => v.id + ' ×' + v.nodes.length)")
                pg.close()
                probs = ([f"overflow {m['overflow']}px"] if m['overflow'] > 0 else []) + ([f"cut {m['cut']}"] if m['cut'] else []) + [f'contrast {x}' for x in scan] + [f'axe {x}' for x in (axe or [])] + ([f'no visible focus: {noring}'] if noring else [])
                print(('FAIL ' if probs else 'ok   ') + f"{case:16} {scheme:5} {fname:10} chip «{m['chip']}» · cost «{m['cost']}» · key «{m['label']}» · prices {m['prices']} · status «…{m['status'][-32:]}»" + ('' if not probs else ' ' + '; '.join(probs)))
                fails += probs
    b.close()
sys.exit(1 if fails else 0)
