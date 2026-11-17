"""Extended browser audit of the B5 terminal mockup: colour blindness (simulated contrast + Chromium emulation), copy/paste, accessibility text, font fallback, zoom/narrow window, forced colours.  Run: xvfb-run -a python3 docs/mockups/security-b5/audit/audit-extended.py"""
import json, re, html, pathlib
from playwright.sync_api import sync_playwright
ROOT = pathlib.Path(__file__).resolve().parents[1]
PAGE = (ROOT / 'terminal.html').as_uri()
OUT = ROOT / 'audit'
src = (ROOT / 'terminal.html').read_text()
EXPECTED = [[html.unescape(re.sub(r'<[^>]+>', '', l)) for l in b.split('\n')] for b in re.findall(r'<div class="t">(.*?)</div>', src, re.S)]

# Machado et al. 2009 simulation matrices (severity 1.0), applied in linear RGB
M = {
 'protanopia':   [[0.152286,1.052583,-0.204868],[0.114503,0.786281,0.099216],[-0.003882,-0.048116,1.051998]],
 'deuteranopia': [[0.367322,0.860646,-0.227968],[0.280085,0.672501,0.047413],[-0.011820,0.042940,0.968881]],
 'tritanopia':   [[1.255528,-0.076749,-0.178779],[-0.078411,0.930809,0.147602],[0.004733,0.691367,0.303900]],
}
def lin(c): c/=255; return c/12.92 if c<=0.04045 else ((c+0.055)/1.055)**2.4
def lum(rgb): r,g,b=[lin(x) for x in rgb]; return 0.2126*r+0.7152*g+0.0722*b
def sim(rgb, m):
    l=[lin(x) for x in rgb]; o=[max(0,min(1,sum(m[i][j]*l[j] for j in range(3)))) for i in range(3)]
    return o
def lum_lin(o): return 0.2126*o[0]+0.7152*o[1]+0.0722*o[2]
def ratio(a,b): a,b=max(a,b),min(a,b); return (a+0.05)/(b+0.05)
def hexrgb(h): h=h.lstrip('#'); return [int(h[i:i+2],16) for i in (0,2,4)]
BG = hexrgb('#15171a')
COLORS = {'text #d7dce2': '#d7dce2', 'ok #5cbfa8': '#5cbfa8', 'bad #ff8a80': '#ff8a80', 'warn #f2c46d': '#f2c46d', 'dim #7d8590': '#7d8590', 'bold #ffffff': '#ffffff', 'marker bar #f2c46d': '#f2c46d'}
print('Contrast on the terminal background, normal vision and simulated colour blindness (need 4.5:1 for text, 3:1 for the bar):')
print(f"  {'colour':22}{'normal':>8}{'protan.':>9}{'deutan.':>9}{'tritan.':>9}{'achrom.':>9}")
for name, h in COLORS.items():
    c = hexrgb(h); row = [ratio(lum(c), lum(BG))]
    for k in ['protanopia','deuteranopia','tritanopia']: row.append(ratio(lum_lin(sim(c,M[k])), lum_lin(sim(BG,M[k]))))
    row.append(ratio(lum(c), lum(BG)))  # achromatopsia keeps luminance
    print(f"  {name:22}" + ''.join(f"{r:8.2f} " for r in row))
# Can ok / bad / warn be told apart by colour alone under each deficiency? (ΔE-ish distance in simulated linear RGB)
print('Colour differences between the state colours under simulation (0 = identical; words carry the state anyway):')
import itertools, math
for k in ['protanopia','deuteranopia','tritanopia']:
    pairs = []
    for (a,ha),(b,hb) in itertools.combinations([('ok','#5cbfa8'),('bad','#ff8a80'),('warn','#f2c46d')],2):
        sa, sb = sim(hexrgb(ha),M[k]), sim(hexrgb(hb),M[k])
        pairs.append(f"{a}/{b} {math.dist(sa,sb):.2f}")
    print(f"  {k:13}", ', '.join(pairs))

with sync_playwright() as p:
    b = p.chromium.launch(headless=False)
    # 1. copy-paste and accessibility text
    pg = b.new_page(viewport={'width': 1000, 'height': 900}); pg.goto(PAGE); pg.wait_for_timeout(300)
    copied = pg.evaluate("""() => [...document.querySelectorAll('.t')].map(t => { const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r); const x = s.toString(); s.removeAllRanges(); return x; })""")
    bad_copy = [(i+1, j+1) for i,(c,e) in enumerate(zip(copied, EXPECTED)) for j,(x,y) in enumerate(zip(c.split('\n'), e)) if x != y]
    print('Copy/paste of every terminal (selection text == the plain lines):', 'ok' if not bad_copy and all(len(c.split('\n'))==len(e) for c,e in zip(copied,EXPECTED)) else f'MISMATCH at {bad_copy[:5]}')
    snap = pg.accessibility.snapshot()
    txt = json.dumps(snap)
    print('Accessibility tree: marker bars add no text:', 'ok' if '▌' not in txt and '|' not in txt.replace('\\u2502','') else 'CHECK')
    # 2. generic monospace fallback + 200% zoom + narrow window
    pg.add_style_tag(content=".t{font-family:monospace !important}"); pg.wait_for_timeout(150)
    fallback = pg.evaluate("() => ({ font: getComputedStyle(document.querySelector('.t')).fontFamily, overflow: [...document.querySelectorAll('.t')].map(t => t.scrollWidth - t.clientWidth) })")
    print('Generic monospace fallback:', fallback)
    pg.close()
    for w, zoom in [(1280, 2), (640, 1)]:
        pg = b.new_page(viewport={'width': w, 'height': 900}, device_scale_factor=zoom); pg.goto(PAGE); pg.wait_for_timeout(200)
        if zoom == 2: pg.evaluate("document.body.style.zoom = '200%'")
        pg.wait_for_timeout(150)
        r = pg.evaluate("() => ({ pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, boxOverflow: [...document.querySelectorAll('.t')].map(t => t.scrollWidth - t.clientWidth) })")
        print(f'Viewport {w}px, zoom {zoom*100 if zoom==2 else 100}%:', r)
        pg.close()
    # 3. colour-blindness rendering (Chromium's own emulation) + forced colours
    for vd in ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']:
        pg = b.new_page(viewport={'width': 1000, 'height': 900}, device_scale_factor=1); cdp = pg.context.new_cdp_session(pg)
        cdp.send('Emulation.setEmulatedVisionDeficiency', {'type': vd}); pg.goto(PAGE); pg.wait_for_timeout(300)
        pg.locator('.t').nth(1).screenshot(path=str(OUT / f'vision-{vd}-scenario2.png')); pg.close()
    pg = b.new_page(viewport={'width': 1000, 'height': 900}); pg.emulate_media(forced_colors='active'); pg.goto(PAGE); pg.wait_for_timeout(300)
    fc = pg.evaluate("() => { const s = getComputedStyle(document.querySelector('.bad')); const bar = getComputedStyle(document.querySelector('.new'), '::before'); return { badColor: s.color, background: getComputedStyle(document.querySelector('.t')).backgroundColor, barBackground: bar.backgroundColor, barVisible: bar.forcedColorAdjust } }")
    pg.locator('.t').nth(1).screenshot(path=str(OUT / 'forced-colors-scenario2.png'))
    print('Forced colours (Windows high contrast):', fc)
    pg.close(); b.close()
