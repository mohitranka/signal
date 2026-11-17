"""Regenerate the mockups: python3 docs/mockups/render.py (needs Python Playwright + Chromium; not a project dependency)."""
import json, pathlib, re
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
css = re.search(r"const CSS = `(.*?)`;", (here / '../../src/content/presenter.ts').read_text(), re.S).group(1)
(here / 'feed-repeats.html').write_text((here / 'feed-repeats.template.html').read_text().replace('__PRESENTER_CSS__', json.dumps(css)))
with sync_playwright() as p:
    b = p.chromium.launch()
    for scheme in ['light', 'dark']:
        pg = b.new_page(color_scheme=scheme, viewport={'width': 1320, 'height': 800})
        pg.goto((here / 'feed-repeats.html').as_uri()); pg.screenshot(path=str(here / f'feed-repeats-{scheme}.png'), full_page=True)
        pg = b.new_page(color_scheme=scheme, viewport={'width': 360, 'height': 600}, device_scale_factor=2)
        pg.goto((here / 'popup-repeats.html').as_uri()); pg.screenshot(path=str(here / f'popup-repeats-{scheme}.png'), full_page=True)
    b.close()
