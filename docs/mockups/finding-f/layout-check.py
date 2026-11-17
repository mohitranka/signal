"""
Finding F layout check, in a real browser (headed Chromium on Xvfb, so classic scrollbars, as on Windows and Linux).
Run after `npm run build`:   xvfb-run -a python3 docs/mockups/finding-f/layout-check.py
Needs Python Playwright + Chromium (not a project dependency). Exits 1 if any check fails.

Checks the BUILT popup (dist/popup.html), with a mocked chrome API, under two fonts (DejaVu Sans: wide; Liberation Sans:
Arial metrics ≈ Segoe UI / Helvetica), without and with a vertical scrollbar (Model + Advanced open):
  - no horizontal page overflow;
  - no session tile past the card's inner edge;
  - no truncated or spilling tile text with realistic values: a large session ($21.83) and a cheap model's small one
    (under one cent; added with findings J+K, after it was found missing);
  - an extreme value either fits or is ellipsised (nothing else cut), and its tooltip starts with the full value.
"""
import pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[3]
POPUP = (ROOT / 'dist' / 'popup.html').as_uri()
# Findings J+K: a cheap model's small session ($0.0070, under one cent) is the most common case and was missing here.
SESSIONS = {'large': (1300, 1234, 999, 218, 198400, 19880, 100), 'cheap': (41, 41, 12, 9, 35000, 3000, 0.15)}
MOCK_TEMPLATE = """window.chrome = { runtime: { sendMessage: async (m) => ({ getSettings: { enabled: true, mode: 'review', sensitivity: 'balanced', highlight: true, endpoint: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', hasApiKey: true, concurrency: 3, timeoutMs: 30000, jsonMode: true, inputPricePerM: %(price)s, outputPricePerM: %(price)s, repeats: true },
  getStats: { stats: { httpRequests: %(http)s, classified: %(cls)s, cacheHits: %(cache)s, repeatHits: %(rep)s, failures: 0, promptTokens: %(pin)s, completionTokens: %(pout)s, totalLatencyMs: 9000 }, cacheSize: 6, repeatIndexSize: 240, prices: { input: %(price)s, output: %(price)s } }, listFeedback: {} })[m.type] }, permissions: { request: async () => true }, tabs: { query: async () => [] } };"""
def mock(session):
    http, cls, cache, rep, pin, pout, price = SESSIONS[session]
    return MOCK_TEMPLATE % dict(http=http, cls=cls, cache=cache, rep=rep, pin=pin, pout=pout, price=price)
FONTS = {'DejaVu Sans (wide)': '', 'Liberation Sans (typical)': "body, button, input, select { font-family: 'Liberation Sans' !important; }"}
MEASURE = r"""() => { const W = document.documentElement.clientWidth; const g = document.querySelector('.tiles'); const card = g.closest('.card'); const cs = getComputedStyle(card);
  const inner = card.getBoundingClientRect().right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
  const cut = [...g.querySelectorAll('b, span:not(.sr)')].filter(e => e.scrollWidth > e.clientWidth + 0.5).map(e => e.textContent);
  return { overflow: document.documentElement.scrollWidth - W, pastEdge: +(g.lastElementChild.getBoundingClientRect().right - inner).toFixed(1), cut, scrollbar: window.innerWidth - W > 0,
    values: [...g.querySelectorAll('b')].map(b => b.textContent), costTitle: document.getElementById('stCost').parentElement.title }; }"""
failures = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for fname, fcss in FONTS.items():
        for opened in [False, True]:
            for session, extreme in [('large', False), ('cheap', False), ('large', True)]:
                pg = b.new_page(viewport={'width': 360, 'height': 600}); pg.add_init_script(mock(session)); pg.goto(POPUP); pg.wait_for_timeout(300)
                if fcss: pg.add_style_tag(content=fcss)
                if extreme:
                    pg.evaluate("() => { const e = document.getElementById('stCost'); e.textContent = '$1,234.56'; const t = e.parentElement.title; const i = t.indexOf(' · '); e.parentElement.title = '$1,234.56 · ' + (i === -1 ? t : t.slice(i + 3)); }")
                if opened: pg.evaluate("document.getElementById('llm').open = true; document.querySelector('details.advanced').open = true")
                pg.wait_for_timeout(150); r = pg.evaluate(MEASURE); pg.close()
                case = f"{fname}, {'scrollbar' if r['scrollbar'] else 'no scrollbar'}, {'extreme value' if extreme else 'realistic values ' + ' '.join(r['values'])}"
                problems = []
                if r['overflow'] > 0: problems.append(f"horizontal overflow {r['overflow']} px")
                if r['pastEdge'] > 0.5: problems.append(f"tile {r['pastEdge']} px past the card edge")
                if not extreme and r['cut']: problems.append(f"truncated/spilling: {r['cut']}")
                # An extreme value may fit (nothing cut) or be ellipsised (only the cost cut); either way, no overflow (checked
                # above) and the tooltip starts with the full value.
                if extreme and (r['cut'] not in ([], ['$1,234.56']) or not r['costTitle'].startswith('$1,234.56 · ')): problems.append(f"extreme value: other text cut or tooltip lacks the full value (cut={r['cut']}, title={r['costTitle']!r})")
                if extreme and r['cut']: case += ' (ellipsised)'
                elif extreme: case += ' (fits)'
                print(('FAIL ' if problems else 'ok   ') + case + (': ' + '; '.join(problems) if problems else ''))
                failures += problems
    b.close()
sys.exit(1 if failures else 0)
