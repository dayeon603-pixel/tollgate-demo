"""Browser check of the moat features (Playwright, headless Chromium).

Usage: python3 tests/e2e_moat.py <base-url-ending-in-slash> <screenshot-dir>

Covers the Network, List archive and Proof gap views and the dashboard strip at 1440 and 390 px in dark and
light: no console error, no request off the site's origin, no horizontal page overflow. Then drives the
features: receiving valid, edited and unregistered receipts, revoking a key, the gate, the live gate, chart
legend and zoom, and the read-only examiner. Exit code 1 on any failed expectation.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import rpc_fixture
from playwright.sync_api import Page, sync_playwright

log = logging.getLogger("e2e-moat")
SIZES = {"1440": {"width": 1440, "height": 900}, "390": {"width": 390, "height": 844}}
ROUTES = ["dashboard", "network", "archive", "proofgap", "live"]
failures: list[str] = []


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def open_view(page: Page, base: str, route: str) -> None:
    page.goto(f"{urljoin(base, 'app.html')}#{route}")
    page.wait_for_selector(f"#ws-view-{route} .card, #ws-view-{route} .compounds", timeout=15000)
    page.wait_for_timeout(900)


def overflow(page: Page) -> bool:
    return page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth + 1")


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    errors: list[str] = []
    foreign: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        rpc_fixture.patch(browser)
        for size_name, viewport in SIZES.items():
            for theme in ("dark", "light"):
                ctx = browser.new_context(viewport=viewport)
                page = ctx.new_page()
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("request", lambda r: foreign.append(r.url) if not rpc_fixture.allowed(r.url, origin) else None)
                page.goto(urljoin(base, "app.html#dashboard"))
                page.evaluate("t => localStorage.setItem('tollgate-demo-settings-v1', JSON.stringify({theme: t}))", theme)
                for route in ROUTES:
                    open_view(page, base, route)
                    if route == "live":
                        page.click("#lv-toggle")
                        page.wait_for_timeout(2500)
                    expect(not overflow(page), f"no page overflow: {route} {size_name} {theme}")
                    page.screenshot(path=str(shots / f"{route}_{theme}_{size_name}.png"), full_page=True)
                ctx.close()

        ctx = browser.new_context(viewport=SIZES["1440"], accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        open_view(page, base, "dashboard")
        expect(page.inner_text("#cp-network-v").strip().isdigit(), "dashboard shows re-screens avoided as a number")
        expect("Re-screens avoided via accepted receipts (demo)" in page.inner_text("#cp-network"), "dashboard tile has the required label")
        page.wait_for_selector("#cp-proof-v:has-text('93.4%')")
        expect("232 of 232" in page.inner_text("#cp-archive-s") or "232 of 232" in page.inner_text("#cp-archive"), "archive tile shows real anchored count")
        for tile, route in (("cp-network", "network"), ("cp-archive", "archive"), ("cp-proof", "proofgap")):
            page.click(f"#{tile}")
            page.wait_for_selector(f"#ws-view-{route} .card")
            expect(page.url.endswith(f"#{route}"), f"strip links to {route}")
            open_view(page, base, "dashboard")

        # chart: legend toggle and zoom
        btn = page.locator("#dash-volume .legend__btn").first
        btn.click()
        expect(btn.get_attribute("aria-pressed") == "false", "legend button switches a series off")
        btn.click()
        chart = page.locator("#dash-volume .tchart").first
        page.wait_for_function("() => { const el = document.querySelector('#dash-volume .tchart__canvas'); return el && window.echarts && echarts.getInstanceByDom(el); }")
        chart.focus()
        page.keyboard.press("+")
        expect(page.locator("#dash-volume .tchartbox__reset").first.is_visible(), "zooming with the keyboard offers Reset zoom")
        page.locator("#dash-volume .tchartbox__reset").first.click()
        expect(not page.locator("#dash-volume .tchartbox__reset").first.is_visible(), "Reset zoom restores the full range")
        box = page.locator("#dash-volume .tchart__canvas").first.bounding_box()
        page.mouse.move(box["x"] + box["width"] * 0.6, box["y"] + box["height"] * 0.5)
        page.wait_for_timeout(300)
        expect(page.locator("#dash-volume .tchart .ect").first.is_visible(), "tooltip shows on hover")
        expect(page.locator("#dash-volume .tchartbox__bar").count() >= 1 and page.locator("#dash-volume .tbrush").count() == 0, "no brush strip under the chart")

        # network
        open_view(page, base, "network")
        before = int(page.inner_text("#nw-k-avoided dd").replace(",", ""))
        page.click("#nw-receive")
        page.wait_for_selector("#nw-result .banner[data-state='pass']")
        expect("ISSUER'S WORD ONLY" in page.inner_text("#nw-result"), "valid receipt is accepted, issuer's word only")
        expect(int(page.inner_text("#nw-k-avoided dd").replace(",", "")) == before + 1, "re-screens avoided goes up by one")
        for kind, word in (("tampered", "Bad signature"), ("unknown", "Unknown key"), ("stale", "Stale list"), ("none", "No receipt")):
            page.select_option("#nw-scenario", kind)
            page.click("#nw-receive")
            page.wait_for_selector(f"#nw-result:has-text('{word}')")
            expect(True, f"{kind} receipt reported as {word}")
        page.screenshot(path=str(shots / "network_refused.png"), full_page=True)
        page.select_option("#ws-user", "admin-d")
        page.click("#nw-revoke-" + page.locator("[id^='nw-revoke-']:not(#nw-revoke-go):not(#nw-revoke-reason)").first.get_attribute("id").split("-")[-1])
        page.fill("#nw-revoke-reason", "Demo: key lost on a test laptop.")
        page.click("#nw-revoke-go")
        page.wait_for_selector("#nw-registry:has-text('Revoked')")
        expect(True, "revoking a key is recorded")
        page.select_option("#ws-user", "analyst-a")
        page.click("#gt-none")
        page.wait_for_selector("#gt-result .banner[data-state='fail']")
        expect("No receipt" in page.inner_text("#gt-result"), "gate blocks a transfer with no receipt and says why")
        page.click("#gt-screened")
        page.wait_for_selector("#gt-result .banner[data-state='pass']")
        expect("RELEASED" in page.inner_text("#gt-result"), "gate releases a transfer with a fresh receipt")
        page.reload()
        page.wait_for_selector("#ws-view-network .card")
        expect("Revoked" in page.inner_text("#nw-registry"), "network state survives a reload")

        # live gate
        open_view(page, base, "live")
        page.click("#lv-toggle")
        page.wait_for_function("() => document.querySelectorAll('#lv-tape tr').length >= 3")
        page.wait_for_timeout(4000)
        expect("Released" in page.inner_text("#lv-tape-card"), "live tape shows gate decisions")
        page.click("#lv-gate-none")
        page.wait_for_selector("#lv-gate-out .banner")
        page.click("#lv-verify-btn")
        page.wait_for_selector("#lv-verify .banner[data-state='pass']")
        expect(True, "live window with gate receipts verifies")

        # examiner
        page.select_option("#ws-user", "examiner-e")
        open_view(page, base, "network")
        expect(page.locator("#nw-receive").is_disabled(), "examiner cannot receive inbound payments")
        expect(page.locator("#nw-add").is_disabled(), "examiner cannot register members")
        open_view(page, base, "evidence")
        expect(page.locator("#ev-build-btn").is_enabled(), "examiner can build and open a pack")
        page.click("#ev-build-btn")
        page.wait_for_selector("#ev-dl-json")
        expect(page.locator("#ev-dl-json").is_disabled(), "examiner cannot download (it records an export)")
        page.click("text=Check this pack now")
        page.wait_for_selector("#ws-view-evidence .banner[data-state='pass']")
        expect(True, "examiner can verify a pack")
        open_view(page, base, "policy")
        expect("Examiner" in page.inner_text("#ws-view-policy") and "examiner" in page.inner_text("#ws-view-policy"), "permission matrix lists the examiner")
        page.screenshot(path=str(shots / "policy_examiner.png"), full_page=True)
        ctx.close()
        browser.close()
    expect(not errors, f"no console errors ({errors[:3]})")
    expect(not foreign, f"no request off the site's origin ({foreign[:3]})")
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    raise SystemExit(main(sys.argv[1], Path(sys.argv[2])))
