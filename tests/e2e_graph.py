"""Browser check of the Counterparties view and the Settings view (Playwright, headless Chromium).

Usage: python3 tests/e2e_graph.py <base-url-ending-in-slash> <screenshot-dir>

Graph: at 2560, 1440 and 390 px wide, in both themes, nothing extends past either edge of the
viewport (except inside an intentional scroll container), the default is the busiest address, two
hops draw more nodes, the side panel shows. Settings: theme System follows the emulated colour
scheme, compact density shortens rows, the time zone changes a table timestamp, choices survive a
reload, and blocked storage still renders.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from urllib.parse import urljoin

import rpc_fixture
from playwright.sync_api import Browser, Page, sync_playwright

log = logging.getLogger("e2e-graph")
PREFS_KEY = "tollgate-demo-prefs-v1"
WIDTHS = {"2560": (2560, 1300), "1440": (1440, 900), "390": (390, 844)}
MIN_NODES = 10
failures: list[str] = []

# Elements whose box leaves [0, innerWidth] and that are not inside a scroll or clip container.
STRAY_JS = """() => {
  const root = document.getElementById('ws-view-graph');
  const out = [];
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
  for (const el of root.querySelectorAll('*')) {
    if ((el.closest('svg') && el.tagName !== 'svg') || el.closest('.echost > div')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if ((r.left < -0.5 || r.right > innerWidth + 0.5) && !clipped(el)) out.push(`${el.tagName}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out.slice(0, 8);
}"""


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def open_app(browser: Browser, base: str, size: tuple[int, int], prefs: dict | None = None, **ctx_args) -> Page:
    """Opens a clean demo at the given viewport."""
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]}, **ctx_args)
    page = ctx.new_page()
    page.on("pageerror", lambda e: failures.append(f"page error {e}"))
    page.goto(urljoin(base, "app.html#dashboard"))
    page.evaluate("p => { localStorage.clear(); localStorage.setItem(arguments[0], JSON.stringify(p)); }".replace("arguments[0]", json.dumps(PREFS_KEY)), {"user": "analyst-a", **(prefs or {})})
    page.reload()
    page.wait_for_selector("#ws-view-dashboard .kpis", timeout=15000)
    return page


BARS_JS = """() => { const el = document.querySelector('#gr-chart .echost'); const c = el && globalThis.echarts.getInstanceByDom(el); if (!c) return null; const o = c.getOption(); return { labels: o.yAxis[0].data, inn: o.series[0].data, out: o.series[1].data }; }"""


def graph_checks(browser: Browser, base: str, shots: Path) -> None:
    for theme in ("dark", "light"):
        for label, size in WIDTHS.items():
            page = open_app(browser, base, size, {"theme": theme})
            page.goto(urljoin(base, "app.html#graph"))
            page.wait_for_selector("#gr-chart .echost canvas", timeout=15000)
            page.wait_for_function("() => document.querySelector('#gr-chart .figure__cap')")
            stray = page.evaluate(STRAY_JS)
            expect(not stray, f"graph {theme} {label}: nothing outside the viewport ({stray})")
            over = page.evaluate("() => document.documentElement.scrollWidth - innerWidth")
            expect(over <= 0, f"graph {theme} {label}: no horizontal page scroll ({over}px)")
            chips = page.locator("#gr-chips .chipbtn")
            counts = [int(x) for x in chips.locator(".chipbtn__n").all_inner_texts()]
            expect(counts[0] == max(counts), f"graph {theme} {label}: first starting point is the busiest ({counts[:4]})")
            first_title = chips.first.get_attribute("title") or ""
            expect(first_title.startswith(page.locator("#gr-selected").inner_text()), f"graph {theme} {label}: default selection is the busiest address")
            nodes = int(page.locator("#gr-chart").get_attribute("data-nodes") or 0)
            expect(nodes >= MIN_NODES, f"graph {theme} {label}: {nodes} direct counterparties")
            bars = page.evaluate(BARS_JS)
            totals = [i + o for i, o in zip(bars["inn"], bars["out"])] if bars else []
            expect(bool(totals) and totals == sorted(totals, reverse=True), f"graph {theme} {label}: bars ranked by total value ({totals[:4]})")
            expect(0 < len(totals) <= 10, f"graph {theme} {label}: top 10 in the figure ({len(totals)})")
            expect("Figure." in page.locator("#gr-chart .figure__cap").inner_text(), f"graph {theme} {label}: figure has a caption")
            expect(page.locator("#gr-metrics .kpi").count() == 4, f"graph {theme} {label}: four flow metrics shown")
            expect(page.locator("#gr-panel").is_visible() and len(page.locator("#gr-panel-address").inner_text()) >= 40, f"graph {theme} {label}: side panel shows the full address")
            page.screenshot(path=str(shots / f"graph1_{theme}_{label}.png"), full_page=True)
            page.click("#gr-hops button:has-text('2')")
            page.wait_for_selector("#gr-table")
            expect(not page.evaluate(STRAY_JS), f"graph {theme} {label}: 2 hops stays inside the viewport")
            page.screenshot(path=str(shots / f"graph2_{theme}_{label}.png"), full_page=True)
            if label == "1440" and theme == "dark":
                page.click("#gr-hops button:has-text('1')")
                page.wait_for_selector("#gr-chart .echost canvas")
                page.wait_for_timeout(300)
                box = page.locator("#gr-chart .echost").bounding_box()
                labels = page.evaluate(BARS_JS)["labels"]
                n = len(labels)
                # Click the third bar group: plot rows are evenly spaced between grid top (34) and bottom (34).
                y = box["y"] + 34 + (box["height"] - 68) * (2.5 / n)
                x = box["x"] + box["width"] * 0.35
                page.mouse.click(x, y)
                want = labels[2].replace("\u2020 ", "")
                page.wait_for_function("a => document.getElementById('gr-panel-address').textContent.startsWith(a)", arg=want[:6])
                expect(True, "graph: clicking a bar selects that counterparty in the panel")
                expect(page.locator("#gr-receipts, #gr-panel [data-alert], #gr-centre").count() >= 1, "graph: panel offers actions for the selected address")
                page.mouse.dblclick(x, y)
                page.wait_for_function("a => document.getElementById('gr-selected').textContent.startsWith(a)", arg=want[:6])
                expect(True, "graph: double-click centres on the address")
            page.context.close()


def settings_checks(browser: Browser, base: str, shots: Path) -> None:
    desk = (1440, 900)
    # Theme System follows the emulated colour scheme, live.
    page = open_app(browser, base, desk, color_scheme="light")
    page.goto(urljoin(base, "app.html#settings"))
    page.wait_for_selector("#set-appearance")
    page.click("#set-appearance .seg[aria-label='Theme'] button:has-text('System')")
    theme = lambda: page.evaluate("() => document.documentElement.dataset.theme")  # noqa: E731
    expect(theme() == "light", "settings: System follows a light device")
    page.emulate_media(color_scheme="dark")
    page.wait_for_function("() => document.documentElement.dataset.theme === 'dark'")
    expect(theme() == "dark", "settings: System follows the device live when it changes")
    pressed = page.locator("#set-appearance .seg[aria-label='Theme'] button[aria-pressed='true']").inner_text()
    expect(pressed == "System", "settings: the theme control shows System")
    page.click("#ws-theme")
    page.wait_for_function("() => document.documentElement.dataset.theme === 'light'")
    expect(page.locator("#set-appearance .seg[aria-label='Theme'] button[aria-pressed='true']").inner_text() == "Light", "settings: the header toggle and the setting agree")

    # Density changes row height.
    page.goto(urljoin(base, "app.html#explorer"))
    page.wait_for_selector("#ws-view-explorer .grid tbody tr")
    row = lambda: page.locator("#ws-view-explorer .grid tbody tr").first.bounding_box()["height"]  # noqa: E731
    comfortable = row()
    page.goto(urljoin(base, "app.html#settings"))
    page.click("#set-appearance .seg[aria-label='Density'] button:has-text('Compact')")
    page.goto(urljoin(base, "app.html#explorer"))
    page.wait_for_selector("#ws-view-explorer .grid tbody tr")
    compact = row()
    expect(compact < comfortable, f"settings: compact rows are shorter ({comfortable} to {compact})")

    # Time zone changes a table timestamp.
    page.context.close()
    page = open_app(browser, base, desk, timezone_id="Asia/Seoul")
    page.goto(urljoin(base, "app.html#explorer"))
    page.wait_for_selector("#ws-view-explorer .grid tbody tr")
    cell = lambda: page.locator("#ws-view-explorer .grid tbody tr").first.locator("td[data-label^='Time (']").inner_text()  # noqa: E731
    utc_text = cell()
    page.goto(urljoin(base, "app.html#settings"))
    page.click("#set-regional .seg[aria-label='Time zone'] button:has-text('Local')")
    page.goto(urljoin(base, "app.html#explorer"))
    page.wait_for_selector("#ws-view-explorer .grid tbody tr")
    local_text = cell()
    expect(utc_text != local_text, f"settings: time zone Local changes a timestamp ({utc_text!r} to {local_text!r})")
    expect("local time" in page.locator("#ws-view-explorer .grid thead").inner_text().lower(), "settings: the column heading names the zone")
    page.goto(urljoin(base, "app.html#settings"))
    page.click("#set-regional .seg[aria-label='Date format'] button:has-text('Nov')")
    page.click("#set-regional .seg[aria-label='Currency display'] button:has-text('USD')")
    expect("USD" in page.locator("#set-preview").inner_text() and "," in page.locator("#set-preview").inner_text(), "settings: preview follows the formats")

    # Survive a reload.
    page.reload()
    page.wait_for_selector("#set-regional")
    expect(page.locator("#set-regional .seg[aria-label='Time zone'] button[aria-pressed='true']").inner_text() == "Local", "settings: choices survive a reload")
    page.screenshot(path=str(shots / "settings_dark_1440.png"), full_page=True)
    page.click("#set-restore")
    expect(page.locator("#set-regional .seg[aria-label='Time zone'] button[aria-pressed='true']").inner_text() == "UTC", "settings: restore defaults")
    page.click("#set-appearance .seg[aria-label='Theme'] button:has-text('Light')")
    page.screenshot(path=str(shots / "settings_light_1440.png"), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path=str(shots / "settings_light_390.png"), full_page=True)
    expect(page.evaluate("() => document.documentElement.scrollWidth - innerWidth") <= 0, "settings: no horizontal scroll at 390")
    page.context.close()

    # Export, then blocked storage still renders.
    page = open_app(browser, base, desk)
    page.goto(urljoin(base, "app.html#settings"))
    page.wait_for_selector("#set-data")
    with page.expect_download() as dl:
        page.click("#set-export")
    exported = json.loads(Path(dl.value.path()).read_text())
    expect(exported.get("kind") == "tollgate-demo-export" and "settings" in exported, "settings: export is a demo export")
    page.context.close()
    ctx = browser.new_context(viewport={"width": desk[0], "height": desk[1]})
    ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });")
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(urljoin(base, "app.html#settings"))
    page.wait_for_selector("#set-appearance", timeout=15000)
    page.click("#set-appearance .seg[aria-label='Density'] button:has-text('Compact')")
    expect(page.locator("#set-storage").count() == 1, "settings: blocked storage shows a notice and the page still renders")
    expect(page.evaluate("() => document.documentElement.dataset.density") == "compact", "settings: a change still applies with blocked storage")
    expect(not errors, f"settings: no page errors with blocked storage ({errors[:2]})")
    ctx.close()


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        rpc_fixture.patch(browser)
        graph_checks(browser, base, shots)
        settings_checks(browser, base, shots)
        browser.close()
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) != 3:
        sys.exit("usage: e2e_graph.py <base-url> <screenshot-dir>")
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
