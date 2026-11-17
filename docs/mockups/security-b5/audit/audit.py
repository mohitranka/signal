"""Browser audit of the B5 terminal mockup (headed Chromium): run  AXE=/path/axe.min.js xvfb-run -a python3 docs/mockups/security-b5/audit/audit.py"""
import json, re, html, sys
from playwright.sync_api import sync_playwright
import pathlib, os
HERE = pathlib.Path(__file__).resolve().parent
import sys
PAGE = (HERE.parent / (sys.argv[1] if len(sys.argv) > 1 else 'terminal.html')).as_uri()
AXE = open(os.environ['AXE']).read()  # path to axe.min.js (axe-core 4.x)
G = (HERE.parents[1] / 'finding-g' / 'contrast-check.py').read_text()
SCAN = G.split('SCAN = r"""')[1].split('"""')[0]
FONTS = {'DejaVu Sans Mono': "'DejaVu Sans Mono'", 'Liberation Mono': "'Liberation Mono'"}
MEASURE = r"""() => {
  const out = { boxes: [] };
  // per-glyph advance relative to 'x' (monospace alignment needs every glyph one cell wide)
  const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
  const t0 = document.querySelector('.t'); t0.appendChild(probe);
  const w = (s) => { probe.textContent = s.repeat(40); return probe.getBoundingClientRect().width / 40; };
  const cell = w('x'); const chars = new Set(); for (const t of document.querySelectorAll('.t')) for (const ch of t.textContent) if (ch.charCodeAt(0) > 126) chars.add(ch);
  out.glyphs = [...chars].map(ch => ({ ch, code: 'U+' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), ratio: +(w(ch) / cell).toFixed(3) }));
  probe.remove();
  out.cell = cell;
  for (const [i, t] of [...document.querySelectorAll('.t')].entries()) {
    const cs = getComputedStyle(t); const inner = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const lines = t.textContent.split('\n');
    // rendered width of each line, via a Range over its text
    const r = document.createRange(); const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    // value column: x of the first character after ". " in dotted lines
    const values = [];
    let offset = 0; const full = t.textContent;
    const locate = (idx) => { let n = 0; for (const node of nodes) { if (idx < n + node.length) return [node, idx - n]; n += node.length; } return null; };
    let pos = 0;
    for (const line of lines) {
      const m = /^ {2}\S.*? \.{2,} (\S)/.exec(line);
      if (m) { const at = locate(pos + m[0].length - 1); r.setStart(at[0], at[1]); r.setEnd(at[0], at[1] + 1); values.push({ line: line.trim().slice(0, 30), x: +(r.getBoundingClientRect().left - t.getBoundingClientRect().left).toFixed(1) }); }
      pos += line.length + 1;
    }
    out.boxes.push({ box: i + 1, overflow: t.scrollWidth - t.clientWidth, innerWidthCh: +(inner / cell).toFixed(2), maxCols: Math.max(...lines.map(l => [...l].length)), values });
  }
  return out; }"""
report = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    for fname, fam in FONTS.items():
        pg = b.new_page(viewport={'width': 1000, 'height': 900})
        pg.goto(PAGE); pg.add_style_tag(content=f".t {{ font-family: {fam} !important; }}"); pg.wait_for_timeout(300)
        m = pg.evaluate(MEASURE)
        scan = pg.evaluate(SCAN, None)
        pg.add_script_tag(content=AXE)
        axe = pg.evaluate("async () => { const r = await axe.run(document); return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map(n => n.target.join(' ') + ' :: ' + (n.any[0]||n.all[0]||{}).message) })), incomplete: r.incomplete.map(v => ({ id: v.id, n: v.nodes.length })) }; }")
        pg.screenshot(path=f"{HERE}/terminal-{fname.replace(' ', '-').lower()}.png", full_page=True)
        pg.close()
        report[fname] = {'measure': m, 'contrastScan': scan, 'axe': axe}
    b.close()
json.dump(report, open(HERE / 'report.json', 'w'), indent=1)
for fname, r in report.items():
    m = r['measure']
    print(f"== {fname}: cell {m['cell']:.2f}px")
    print('  glyph widths (cells):', ', '.join(f"{g['ch']} {g['code']} {g['ratio']}" for g in m['glyphs']))
    for bx in m['boxes']:
        xs = sorted(set(v['x'] for v in bx['values']))
        print(f"  box {bx['box']}: overflow {bx['overflow']}px, max {bx['maxCols']} cols, value column x={xs}")
    print('  own contrast scan:', len(r['contrastScan']), r['contrastScan'][:6])
    print('  axe violations:', [(v['id'], v['impact'], v['n']) for v in r['axe']['violations']])
    for v in r['axe']['violations']:
        for s in v['sample']: print('     ', v['id'], s[:150])
    print('  axe incomplete:', r['axe']['incomplete'])
