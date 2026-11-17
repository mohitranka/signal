"""Findings J+K: the other cost cases (bridge "Plan", no prices "—", zero "$0.00") with the Details open; layout and contrast checked.  Run: xvfb-run -a python3 docs/mockups/finding-jk/cost-cases.py"""
import json, pathlib
from playwright.sync_api import sync_playwright
HERE = pathlib.Path(__file__).resolve().parent
src = (HERE / 'popup-mock.py').read_text(); ns = {'__file__': str(HERE / 'popup-mock.py')}
exec(src.split('fails = []')[0], ns)
AFTER_CSS, POPUP, STATS, SCAN = ns['AFTER_CSS'], ns['POPUP'], ns['STATS'], ns['SCAN']
def mock(endpoint, model, pin, pout, stats):
    pj = 'null' if pin is None else pin; po = 'null' if pout is None else pout
    return f"""const S = {{ enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: '{endpoint}', model: '{model}', hasApiKey: true, concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: {pj}, outputPricePerM: {po}, repeats: true }};
window.chrome = {{ runtime: {{ sendMessage: async (m) => ({{ getSettings: S, saveSettings: S, getStats: {{ stats: {json.dumps(stats)}, cacheSize: 53, repeatIndexSize: 41, prices: {{ input: {pj}, output: {po} }} }}, listFeedback: {{}} }})[m.type] }}, permissions: {{ request: async () => true }}, tabs: {{ query: async () => [] }} }};"""
# The design's texts for the other cost cases (design-finding-jk-session-tiles.md, J-b).
COST_LINE = {
  'bridge': ('Plan', 'Plan', 'through your Claude Code login via the local bridge · no per-token estimate (billed as your CLI is set up)'),
  'no-prices': ('—', 'Estimated cost', 'add $/1M token prices under Model › Advanced'),
  'zero': ('$0.00', 'Estimated cost', '$0.00 from your configured prices'),
}
INJECT = r"""([value, label, text, s]) => {
  const c = document.getElementById('stCost'); c.textContent = value;
  const d = document.createElement('details'); d.className = 'tile-details'; d.id = 'statsDetails'; d.open = true;
  const sm = document.createElement('summary'); sm.textContent = 'Details'; d.append(sm);
  const ul = document.createElement('ul'); const n = (x) => x.toLocaleString('en-US');
  const line = (l, t) => { const li = document.createElement('li'); const b = document.createElement('b'); b.textContent = l + ': '; li.append(b, t); ul.append(li); };
  line('Classified', `${n(s.classified)} posts · ${n(s.httpRequests)} HTTP requests` + (s.classified ? ` · avg latency ${n(Math.round(s.totalLatencyMs / s.classified))} ms` : ''));
  line('Cache hits', `${n(s.cacheHits)} · 53 entries stored`); line('Repeats', `${n(s.repeatHits)} copied from a similar post · no model call · 41 stored`);
  line('Tokens', `${n(s.promptTokens)} in · ${n(s.completionTokens)} out`); line(label, text);
  d.append(ul); document.getElementById('stats').after(d); }"""
ZERO = {'httpRequests': 0, 'classified': 0, 'cacheHits': 0, 'repeatHits': 0, 'failures': 0, 'promptTokens': 0, 'completionTokens': 0, 'totalLatencyMs': 0}
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for case, endpoint, model, pin, pout, stats in [('bridge', 'http://127.0.0.1:8791/v1', 'claude-code/sonnet', 0.15, 0.6, STATS), ('no-prices', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini', None, None, STATS), ('zero', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini', 0.15, 0.6, ZERO)]:
        for scheme in ['light', 'dark']:
            for fname, fcss in [('dejavu', ''), ('liberation', "body, button, input, select { font-family: 'Liberation Sans' !important; }")]:
                pg = b.new_page(viewport={'width': 360, 'height': 600}, color_scheme=scheme, device_scale_factor=2); pg.add_init_script(mock(endpoint, model, pin, pout, stats)); pg.goto(POPUP); pg.wait_for_timeout(300)
                if fcss: pg.add_style_tag(content=fcss)
                pg.add_style_tag(content=AFTER_CSS); v, l, t = COST_LINE[case]; pg.evaluate(INJECT, [v, l, t, stats])
                pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true"); pg.wait_for_timeout(120)
                m = pg.evaluate("() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, cut: [...document.querySelectorAll('.tile b, .tile span, .tile-details li')].filter(e => e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent) })")
                scan = pg.evaluate(SCAN, None)
                if fname == 'dejavu': pg.locator('#statsBox').scroll_into_view_if_needed(); pg.locator('#statsBox').screenshot(path=str(HERE / f'stats-{case}-{scheme}.png'))
                pg.close()
                probs = ([f"overflow {m['overflow']}"] if m['overflow'] > 0 else []) + ([f"cut {m['cut']}"] if m['cut'] else []) + scan
                print(('FAIL ' if probs else 'ok   ') + f'{case:9} {scheme:5} {fname:10}' + ('' if not probs else ' ' + str(probs)))
    b.close()
