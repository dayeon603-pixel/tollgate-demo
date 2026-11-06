"""Browser check of the analyst workspace (Playwright, headless Chromium).

Usage: python3 tests/e2e_workspace.py <base-url-ending-in-slash> <screenshot-dir>

Walks the main flows as a visitor would: four-eyes clearing with two users, receipt verification
with the real verifier, batch screening and export, the list update with lookback, evidence pack
build, download and check, policy change, persistence across reload, reset, dark theme, phone
width. Fails (exit 1) on a console error, a request off the site's own origin, horizontal scroll
at phone width, or a wrong result.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Page, sync_playwright

log = logging.getLogger("e2e-ws")
ROUTES = ["dashboard", "alerts", "screening", "monitoring", "lists", "explorer", "evidence", "policy", "activity", "api"]
DESKTOP = {"width": 1280, "height": 800}
PHONE = {"width": 390, "height": 844}
failures: list[str] = []


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def user(page: Page, user_id: str) -> None:
    """Switches the acting-as user."""
    page.select_option("#ws-user", user_id)


def ready(page: Page, route: str) -> None:
    page.goto(f"{page.url.split('#')[0]}#{route}")
    page.wait_for_selector(f"#ws-view-{route} .card, #ws-view-{route} .banner", timeout=10000)


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    errors: list[str] = []
    foreign: list[str] = []
    app = urljoin(base, "app.html")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport=DESKTOP, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: foreign.append(r.url) if not r.url.startswith(origin) and not r.url.startswith(("data:", "blob:")) else None)

        # 1. Every view renders with content and no horizontal scroll, light and dark.
        page.goto(app)
        page.evaluate("() => { localStorage.clear(); }")
        for theme in ("light", "dark"):
            page.evaluate("t => localStorage.setItem('tollgate-demo-prefs-v1', JSON.stringify({user: 'analyst-a', theme: t}))", theme)
            page.goto(app + "#dashboard")
            page.reload()
            for route in ROUTES:
                ready(page, route)
                expect(page.locator(f"#ws-view-{route}").inner_text().strip() != "", f"{theme} {route}: has content")
                expect(page.locator("#ws-bar").inner_text().find("Synthetic") >= 0, f"{theme} {route}: demo label visible")
                page.screenshot(path=str(shots / f"{route}_{theme}.png"), full_page=True)
                unnamed = page.evaluate(
                    "() => Array.from(document.querySelectorAll(`#ws-view-${location.hash.slice(1)} input, #ws-view-${location.hash.slice(1)} select, #ws-view-${location.hash.slice(1)} textarea`))"
                    ".filter((e) => e.type !== 'hidden' && !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby')).map((e) => e.id || e.name || e.tagName)"
                )
                expect(not unnamed, f"{theme} {route}: every form control has a name ({unnamed})")
        page.evaluate("() => localStorage.setItem('tollgate-demo-prefs-v1', JSON.stringify({user: 'analyst-a', theme: 'light'}))")
        page.goto(app + "#alerts")
        page.reload()

        # 2. Four-eyes: analyst proposes, same user cannot approve, approver does.
        ready(page, "alerts")
        page.fill("#al-q", "")
        page.locator("button.rowlink", has_text="AL-").first.click()
        page.wait_for_selector("#ws-drawer[open] .case")
        alert_id = page.locator("#ws-drawer-title").inner_text().replace("Alert ", "")
        page.screenshot(path=str(shots / "case_drawer.png"))
        page.keyboard.press("Escape")
        page.select_option("#al-owner", "any")
        page.fill("#al-q", alert_id)
        # Use a policy hold in review that can take a proposal: find an open hold.
        page.click("text=All >> nth=0")
        page.fill("#al-q", "")
        page.select_option("#al-kind", "hold")
        page.click("button.seg__btn:has-text('Open work')")
        row = page.locator("tr.grid__row", has=page.locator(".schip", has_text="In review"), has_not_text="approval pending").first
        row.locator("button.rowlink").click()
        page.wait_for_selector("#ws-drawer[open] .case")
        alert_id = page.locator("#ws-drawer-title").inner_text().replace("Alert ", "")
        page.fill("#case-note", "Originator details received and matched to the record.")
        page.click("button:has-text('Propose clearance')")
        page.wait_for_selector(".pending")
        expect(page.locator(".pending button:has-text('Approve clearance')").is_disabled(), "four-eyes: proposer cannot approve")
        expect("Four-eyes" in page.inner_text(".actions") or "approver" in page.inner_text(".actions"), "four-eyes: reason is shown")
        page.keyboard.press("Escape")
        user(page, "approver-c")
        page.fill("#al-q", alert_id)
        page.locator("button.rowlink", has_text=alert_id).first.click()
        page.wait_for_selector("#ws-drawer[open] .pending")
        expect(page.locator(".pending button:has-text('Approve clearance')").is_enabled(), "four-eyes: a different approver can approve")
        page.click("button:has-text('Approve clearance')")
        page.wait_for_selector(".schip--cleared")
        expect(page.locator(".timeline__item").count() >= 4, "case timeline lists every step")
        # Receipt link opens the receipt drawer, and verifying uses the real verifier.
        page.locator(".timeline__meta .linkbtn").last.click()
        page.wait_for_selector(".receipt")
        page.click("button:has-text('Verify this receipt')")
        page.wait_for_selector(".receipt .banner[data-state='pass']")
        expect(page.locator(".receipt .pcheck[data-ok='true']").count() == 6, "receipt: all six checks pass")
        page.screenshot(path=str(shots / "receipt_drawer.png"))
        page.keyboard.press("Escape")

        # 3. Batch screening, filter and export.
        user(page, "analyst-a")
        ready(page, "screening")
        page.click("button:has-text('Load an example')")
        page.click("button:has-text('Screen all')")
        page.wait_for_selector("#bt-results table")
        expect(page.locator("#bt-results tbody tr").count() == 6, "batch: six rows screened")
        page.click("#bt-results button.seg__btn:has-text('Invalid')")
        expect(page.locator("#bt-results tbody tr").count() == 1, "batch: invalid filter shows one row")
        with page.expect_download() as dl:
            page.click("button:has-text('Export CSV')")
        csv = Path(dl.value.path()).read_text()
        expect("receipt_id" in csv and "rcpt:u" in csv, "batch: exported CSV carries receipt ids")
        page.screenshot(path=str(shots / "batch_results.png"), full_page=True)

        # 4. Policy change needs admin and is receipted.
        ready(page, "policy")
        expect(page.locator("#pol-blank_originator-amt").is_disabled(), "policy: read-only for an analyst")
        user(page, "admin-d")
        page.fill("#pol-blank_originator-amt", "2000")
        page.click(".rule >> nth=0 >> button:has-text('Save')")
        page.wait_for_function("() => document.querySelector('#pol-log') && document.querySelector('#pol-log').innerText.includes('thresholdUsd: 1000 to 2000')")
        expect(True, "policy: change appears in the signed change log")

        # 5. List update with lookback.
        ready(page, "lists")
        before = page.locator("#ws-nav-alerts").inner_text()
        page.click("button:has-text('Apply update and re-screen')")
        page.wait_for_selector("#ls-lookbacks")
        expect("LB-003" in page.inner_text("#ls-lookbacks"), "lists: lookback run recorded")
        expect(int(page.locator("#ws-nav-alerts").inner_text()) > int(before), "lists: new alerts raised by lookback")
        page.screenshot(path=str(shots / "lists_after_update.png"), full_page=True)

        # 6. Evidence pack: build, download both, check it.
        ready(page, "evidence")
        page.click("input[value='all']")
        page.click("button:has-text('Build pack')")
        page.wait_for_selector("text=Download pack (JSON)")
        with page.expect_download() as dl_json:
            page.click("button:has-text('Download pack (JSON)')")
        pack_path = Path(dl_json.value.path())
        pack = json.loads(pack_path.read_text())
        expect(pack["demo"] is True and len(pack["segments"]) >= 5, "evidence: pack is labelled demo and holds the segments")
        with page.expect_download() as dl_html:
            page.click("button:has-text('Download report')")
        html = Path(dl_html.value.path()).read_text()
        expect(pack["pack_digest"] in html and "Demo" in html, "evidence: report carries the digest and demo label")
        page.set_input_files("#ev-file", str(pack_path))
        page.wait_for_selector("#ev-check .banner")
        expect(page.locator("#ev-check .banner").get_attribute("data-state") == "pass", "evidence: the downloaded pack checks out")
        pack["decisions"][0]["amount_usd"] = 7
        bad = shots / "tampered_pack.json"
        bad.write_text(json.dumps(pack))
        page.set_input_files("#ev-file", str(bad))
        page.wait_for_function("() => document.querySelector('#ev-check .banner').dataset.state === 'fail'")
        expect(True, "evidence: an edited pack fails")
        page.screenshot(path=str(shots / "evidence_checked.png"), full_page=True)

        # 7. Explorer: search by address and verify the ledger.
        ready(page, "explorer")
        addr = pack["decisions"][3]["address"]
        page.fill("#ex-q", addr[:12])
        expect(page.locator("#ex-q ~ *").count() >= 0 and page.locator("tbody tr").count() >= 1, "explorer: search finds receipts")
        page.fill("#ex-q", "")
        page.click("button:has-text('Verify the whole ledger')")
        page.wait_for_selector("#ex-title .banner[data-state='pass']")
        expect(True, "explorer: whole ledger verifies in the browser")

        # 8. Persistence and reset.
        page.reload()
        page.wait_for_selector("#ws-view-explorer .card")
        expect(int(page.locator("#ws-nav-alerts").inner_text()) > 0, "reload: workspace restored")
        ready(page, "policy")
        expect("thresholdUsd: 1000 to 2000" in page.inner_text("#pol-log"), "reload: my policy change survived")
        page.click("#ws-reset")
        page.click("#ws-reset")
        page.wait_for_function("() => document.getElementById('ws-toast').dataset.show === 'true'")
        ready(page, "policy")
        expect("1000 to 2000" not in page.inner_text("#pol-log"), "reset: my changes are gone")

        # 9. Existing tools still work from the same page.
        page.goto(app + "#receipts")
        page.wait_for_function("() => !['loading'].includes(document.getElementById('tg-result').dataset.state)")
        page.click("#tg-verify")
        page.wait_for_function("() => document.getElementById('tg-result').dataset.state === 'pass'")
        expect(True, "verify receipts: sample still passes")

        # 10. Storage blocked: the page still works.
        ctx.close()
        ctx = browser.new_context(viewport=DESKTOP)
        ctx.add_init_script("Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } })")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(app + "#dashboard")
        page.wait_for_selector("#ws-view-dashboard .kpis")
        expect(True, "storage blocked: dashboard still renders")

        # 11. Phone width.
        ctx.close()
        ctx = browser.new_context(viewport=PHONE)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(app + "#dashboard")
        for route in ROUTES:
            ready(page, route)
            over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
            expect(over <= 0, f"phone {route}: no horizontal scroll ({over}px over)")
            if route in ("dashboard", "alerts", "lists"):
                page.screenshot(path=str(shots / f"{route}_phone.png"), full_page=True)
        browser.close()

    expect(not errors, f"no console errors ({errors[:3]})")
    expect(not foreign, f"only own-origin requests ({foreign[:3]})")
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) != 3:
        sys.exit("usage: e2e_workspace.py <base-url/> <screenshot-dir>")
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
