"""Browser check of the terminal layer and the site entry pages (Playwright, headless Chromium).

Usage: python3 tests/e2e_pro.py <base-url-ending-in-slash> <screenshot-dir>

Covers: header Sign in and Join the waitlist links on every page, no signup page, no password field
anywhere, demo sign in, waitlist form; the live stream (start, speed, pause, 20x for 30 seconds with
a frame-time sample, rolling window, workspace ledger untouched, reduced motion); the command
palette; bulk actions and keyboard triage on the alert queue; case summary and one-click evidence;
the counterparty graph; chains and hours; time and cost (measured table, calculator, before and
with steps); dark and light at desktop and phone width. Fails on a console error, a request off the
site's own origin, horizontal scroll at phone width, or a wrong result.
"""
from __future__ import annotations

import logging
import re
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse

from playwright.sync_api import Page, sync_playwright

log = logging.getLogger("e2e-pro")
PAGES = ["index.html", "contact.html", "report.html", "faq.html", "security.html", "privacy.html", "terms.html", "signin.html", "waitlist.html"]
ROUTES = ["dashboard", "live", "alerts", "screening", "monitoring", "graph", "flow", "lists", "explorer", "evidence", "value", "policy", "activity", "api"]
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
STREAM_SOAK_S = 30
FRAME_SAMPLE_JS = """
() => new Promise((resolve) => {
  const gaps = []; let last = performance.now(); const start = last;
  const tick = (t) => { gaps.push(t - last); last = t; if (t - start < 5000) requestAnimationFrame(tick); else resolve(gaps); };
  requestAnimationFrame(tick);
})
"""
failures: list[str] = []
PREFS = "tollgate-demo-prefs-v1"


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def route(page: Page, name: str) -> None:
    page.goto(f"{page.url.split('#')[0]}#{name}")
    page.wait_for_selector(f"#ws-view-{name} .card, #ws-view-{name} .banner", timeout=10000)


def fresh(page: Page, base: str, theme: str = "dark") -> None:
    """Opens the app with a clean demo and the given theme."""
    page.goto(urljoin(base, "app.html#dashboard"))
    page.evaluate("t => { localStorage.clear(); localStorage.setItem('tollgate-demo-prefs-v1', JSON.stringify({user: 'analyst-a', theme: t})); }", theme)
    page.reload()
    page.wait_for_selector("#ws-view-dashboard .kpis", timeout=15000)


def overflow(page: Page) -> int:
    return page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    errors: list[str] = []
    foreign: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=DESKTOP, permissions=["clipboard-read", "clipboard-write"])
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: foreign.append(r.url) if not r.url.startswith(origin) and not r.url.startswith("data:") and not r.url.startswith("blob:") and not r.url.startswith("mailto:") else None)

        # 1. Site entry pages -------------------------------------------------------------
        for name in PAGES:
            page.goto(urljoin(base, name))
            expect(page.locator("header.nav a:text-is('Sign in')").get_attribute("href") == "signin.html", f"{name}: header Sign in goes to signin.html")
            expect(page.locator("header.nav a:text-is('Join the waitlist')").get_attribute("href") == "waitlist.html", f"{name}: header CTA is Join the waitlist")
            expect(page.locator("a[href*='signup']").count() == 0, f"{name}: no link to a sign-up page")
            expect(page.locator("a[href*='#sign-in']").count() == 0, f"{name}: no link to the old contact sign-in anchor")
            expect(page.locator("input[type=password]").count() == 0, f"{name}: no password field")
            expect(overflow(page) <= 0, f"{name}: no horizontal scroll at desktop")
        page.goto(urljoin(base, "app.html"))
        expect(page.locator("input[type=password]").count() == 0, "app.html: no password field")
        page.goto(urljoin(base, "index.html"))
        page.click("header.nav a:text-is('Sign in')")
        expect(page.url.endswith("signin.html"), "clicking Sign in lands on signin.html")
        expect("no password" in page.locator("main").inner_text().lower(), "signin: says there is no password")
        expect("single sign-on" in page.locator("main").inner_text(), "signin: real accounts use the customer's own SSO")
        page.screenshot(path=str(shots / "signin_desktop.png"), full_page=True)
        page.check("#su-admin-d")
        page.click("#signin-go")
        page.wait_for_selector("#ws-view-dashboard .kpis", timeout=15000)
        expect(page.url.endswith("app.html#dashboard"), "signin: opens the workspace")
        expect(page.input_value("#ws-user") == "admin-d", "signin: workspace acts as the chosen user")
        page.goto(urljoin(base, "index.html"))
        page.click("header.nav a:text-is('Join the waitlist')")
        expect(page.url.endswith("waitlist.html"), "clicking Join the waitlist lands on waitlist.html")
        txt = page.locator("main").inner_text()
        expect("early access" in txt and not re.search(r"spots|limited|\d+ (people|companies)|launch(es|ing)? (in|on)", txt, re.I), "waitlist: early-access copy, no urgency or counts")
        page.click("#waitlist-form button[type=submit]")
        errs = [page.locator(f"#wl-{n}-error").inner_text() for n in ("name", "email", "company", "role", "volume")]
        expect(all(errs), f"waitlist: required fields each get an error ({errs})")
        page.fill("#wl-name", "Test Person")
        page.fill("#wl-email", "test@example.com")
        page.fill("#wl-company", "Example Co")
        page.fill("#wl-role", "Compliance analyst")
        page.select_option("#wl-volume", "10k_100k")
        page.click("#waitlist-form button[type=submit]")
        page.wait_for_selector("#wl-done:not([hidden])")
        expect("You're on the list" in page.locator("#wl-done").inner_text(), "waitlist: success says You're on the list")
        expect(page.locator("#wl-open-demo").get_attribute("href") == "app.html#dashboard", "waitlist: success offers the demo workspace")
        mail = page.locator("#wl-done-mailto").get_attribute("href") or ""
        parts = parse_qs(urlparse(mail).query)
        expect(unquote(parts.get("subject", [""])[0]) == "Tollgate waitlist", "waitlist: own mailto subject")
        expect("10,000 to 100,000 a month" in unquote(parts.get("body", [""])[0]), "waitlist: body carries the volume band")
        page.screenshot(path=str(shots / "waitlist_done_desktop.png"), full_page=True)
        page.goto(urljoin(base, "contact.html"))
        expect("sign-in" not in (page.content()), "contact: sign-in block removed")

        # 2. Live stream ------------------------------------------------------------------
        fresh(page, base)
        head_before = page.locator("#ws-status .sb__cell:nth-child(2) .sb__val").inner_text()
        route(page, "live")
        expect(page.locator("#lv-pill").inner_text() == "OFF", "live: off by default")
        expect("OFF" in page.locator(".sb__streamtext").inner_text() and "synthetic" in page.locator(".sb__streamtext").inner_text(), "status bar: stream off and labelled synthetic")
        page.click("#lv-toggle")
        page.wait_for_function("() => document.querySelectorAll('#lv-tape tr').length >= 5", timeout=15000)
        expect(page.locator("#lv-pill").inner_text() == "LIVE", "live: indicator says LIVE")
        page.click("#lv-speed button:has-text('5x')")
        expect(page.locator("#lv-speed button[aria-pressed=true]").inner_text() == "5x", "live: speed control selects 5x")
        page.click("#lv-toggle")
        expect(page.locator("#lv-pill").inner_text() == "PAUSED", "live: pause")
        page.wait_for_timeout(600)
        n1 = page.locator("#lv-tape tr").count()
        page.wait_for_timeout(1200)
        expect(page.locator("#lv-tape tr").count() == n1, "live: paused stream adds no rows")
        page.click("#lv-toggle")
        page.click("#lv-speed button:has-text('20x')")
        gaps = page.evaluate(FRAME_SAMPLE_JS)
        gaps_sorted = sorted(gaps)
        mean = sum(gaps) / len(gaps)
        p95 = gaps_sorted[int(len(gaps) * 0.95)]
        log.info("frame time at 20x over 5s: mean %.1f ms, p95 %.1f ms, max %.1f ms, frames %d", mean, p95, max(gaps), len(gaps))
        expect(mean < 50 and max(gaps) < 600, f"live: page stays responsive at 20x (mean {mean:.1f} ms, max {max(gaps):.0f} ms)")
        page.wait_for_timeout((STREAM_SOAK_S - 5) * 1000)
        page.screenshot(path=str(shots / "live_20x_desktop.png"), full_page=True)
        expect(page.locator("#lv-tape tr").count() <= 60, "live: tape is capped at 60 rows")
        issued = int(page.locator(".kpis--live .kpi:nth-child(1) dd").inner_text())
        expect(issued > 600, f"live: screened {issued} payments in about {STREAM_SOAK_S + 8} seconds at mixed speeds")
        window = int(re.search(r"window: (\d+)", page.locator("#lv-info").inner_text()).group(1))
        expect(window <= 305, f"live: rolling window holds {window} receipts (cap 300)")
        page.click("#lv-verify-btn")
        page.wait_for_selector("#lv-verify .banner[data-state=pass]")
        expect(True, "live: rolling window verifies with the real verifier")
        page.click("#lv-tape tr:first-child button")
        page.wait_for_selector("#ws-drawer[open] #lr-verify")
        page.click("#lr-verify")
        page.wait_for_selector("#ws-drawer .banner[data-state=pass]")
        expect(True, "live: one stream receipt's segment verifies")
        page.keyboard.press("Escape")
        page.click("#lv-stop")
        expect(page.locator("#lv-pill").inner_text() == "OFF", "live: stop")
        head_after = page.locator("#ws-status .sb__cell:nth-child(2) .sb__val").inner_text()
        expect(head_before == head_after, f"live: workspace ledger head unchanged by the stream ({head_before})")
        route(page, "evidence")
        page.check("input[name=ev-type][value=all]")
        page.click("#ev-build-btn")
        page.wait_for_selector("text=Download pack (JSON)")
        page.click("text=Check this pack now")
        page.wait_for_selector("#ev-check .banner[data-state=pass]")
        expect(True, "evidence pack still builds and checks after streaming")

        # reduced motion: no flash class
        rm = browser.new_context(viewport=DESKTOP, reduced_motion="reduce")
        rp = rm.new_page()
        fresh(rp, base)
        route(rp, "live")
        rp.click("#lv-toggle")
        rp.click("#lv-speed button:has-text('20x')")
        rp.wait_for_function("() => document.querySelectorAll('#lv-tape tr[data-outcome=HOLD], #lv-tape tr[data-outcome=BLOCK]').length >= 1", timeout=30000)
        expect(rp.locator(".tape__row--flash").count() == 0, "reduced motion: flagged rows do not flash")
        expect(rp.locator("#lv-tape tr[data-outcome=HOLD], #lv-tape tr[data-outcome=BLOCK]").first.evaluate("e => getComputedStyle(e.firstElementChild).boxShadow") != "none", "reduced motion: flagged rows still marked")
        rm.close()

        # 3. Palette ----------------------------------------------------------------------
        fresh(page, base)
        page.keyboard.press("Control+k")
        page.wait_for_selector("#ws-palette[open]")
        page.keyboard.type("receipt exp")
        page.keyboard.press("Enter")
        page.wait_for_selector("#ws-view-explorer .card")
        expect(page.url.endswith("#explorer"), "palette: jumps to a view")
        page.keyboard.press("Control+k")
        page.keyboard.type("AL-0036")
        page.keyboard.press("Enter")
        page.wait_for_selector("#ws-drawer[open] .case")
        expect("AL-0036" in page.locator("#ws-drawer-title").inner_text(), "palette: opens an alert by id")
        page.keyboard.press("Escape")
        page.keyboard.press("Control+k")
        page.keyboard.type("0xdedede")
        page.keyboard.press("Enter")
        page.wait_for_selector("#ws-view-graph #gr-svg")
        expect(page.url.endswith("#graph"), "palette: an address opens the counterparty graph")
        page.screenshot(path=str(shots / "palette_graph_desktop.png"))

        # 4. Graph ------------------------------------------------------------------------
        route(page, "graph")
        expect("no risk scoring" in page.locator("#ws-view-graph .notice").inner_text(), "graph: honest caption")
        expect(page.locator("#gr-svg .gnode:not(.gnode--centre)").count() >= 1, "graph: counterparty nodes drawn")
        before = page.locator("#gr-selected").inner_text()
        page.locator("#gr-svg .gnode:not(.gnode--centre)").first.click()
        page.wait_for_function("b => document.getElementById('gr-selected').innerText !== b", arg=before)
        expect(True, "graph: clicking a node pivots")
        page.locator(".chipbtn--listed").first.click()
        expect(page.locator("#gr-svg .gnode--centre.gnode--listed").count() == 1, "graph: listed centre flagged")
        expect(page.locator("#ws-view-graph").inner_text().lower().count("risk score") == 0 or "no risk scoring" in page.locator("#ws-view-graph").inner_text(), "graph: no risk score claims")

        # 5. Alerts: bulk, keyboard, summary, evidence ------------------------------------
        fresh(page, base)
        route(page, "alerts")
        page.select_option("#al-owner", "none")
        rows = page.locator("tr.grid__row")
        count0 = rows.count()
        expect(count0 >= 2, f"alerts: unassigned rows ({count0})")
        expect(page.locator("tr[data-sla=overdue]").count() >= 1, "alerts: overdue rows highlighted")
        page.locator("tr.grid__row .selbox").nth(0).check()
        page.locator("tr.grid__row .selbox").nth(1).check()
        expect(page.locator("#al-bulk-count").inner_text() == "2 selected", "bulk: selection counted")
        page.select_option("#al-bulk-assignee", "analyst-b")
        page.click("#al-bulk-assign")
        page.wait_for_function("() => document.getElementById('al-bulk-msg')?.innerText.includes('2 done')")
        expect(True, "bulk: assigned two alerts")
        page.select_option("#al-owner", "analyst-b")
        page.locator("tr.grid__row", has=page.locator(".schip", has_text=re.compile(r"^Open$"))).first.locator(".selbox").check()
        page.click("#al-bulk-review")
        page.wait_for_function("() => document.getElementById('al-bulk-msg')?.innerText.includes('1 done')")
        expect(True, "bulk: start review applied")
        page.select_option("#al-owner", "analyst-b")
        page.locator("tr.grid__row", has=page.locator(".schip", has_text=re.compile(r"^In review$"))).first.locator(".selbox").check()
        page.fill("#al-bulk-note", "short")
        page.click("#al-bulk-clear")
        page.wait_for_function("() => document.getElementById('al-bulk-msg')?.innerText.includes('not applied')")
        expect(True, "bulk: clearance with a short note is refused")
        page.fill("#al-bulk-note", "Reviewed the payment record and the range.")
        page.click("#al-bulk-clear")
        page.wait_for_function("() => document.getElementById('al-bulk-msg')?.innerText.includes('done')")
        user_sel = page.locator("#ws-user")
        pending = page.locator(".schip", has_text="approval pending")
        expect(pending.count() >= 1, "bulk: proposed clearance waits for approval (four-eyes)")
        page.locator("tr.grid__row", has=page.locator(".schip", has_text="approval pending")).first.locator("button.rowlink").click()
        page.wait_for_selector("#ws-drawer[open] .pending")
        expect(page.locator("#case-approve_clear").is_disabled(), "four-eyes: proposer cannot approve after a bulk proposal")
        expect(page.locator(".sla").count() >= 1, "case: SLA shown")
        page.click("#case-evidence")
        page.wait_for_function("() => document.getElementById('ws-view-evidence').innerText.includes('Receipts in scope')", timeout=10000)
        expect(page.locator("#ws-view-evidence").inner_text().count("Receipts in scope") == 1, "case: one click builds the evidence pack for the case")
        del user_sel

        route(page, "alerts")
        page.locator("button.rowlink", has_text="AL-").first.focus()
        page.keyboard.press("x")
        expect(page.locator("#al-bulk-count").inner_text() == "1 selected", "keys: x selects the focused row")
        page.keyboard.press("e")
        page.wait_for_selector("#ws-drawer[open] .case")
        expect(len(page.input_value("#case-note")) > 20 and "List:" in page.input_value("#case-note"), "keys: e opens the case with the summary drafted")
        page.wait_for_timeout(200)
        expect(page.evaluate("document.activeElement.id") in ("case-escalate", "case-note"), "keys: focus lands on the action")
        page.click("#case-draft")
        expect("Signed screening receipt" in page.input_value("#case-note") or "List:" in page.input_value("#case-note"), "case: draft summary built from receipt data")
        page.screenshot(path=str(shots / "case_desktop.png"))
        page.keyboard.press("Escape")
        page.fill("#al-view-name", "Mine open")
        page.click("#al-view-save")
        expect(page.locator("#al-views option:text-is('Mine open')").count() == 1, "views: saved view listed")
        page.reload()
        page.wait_for_selector("#ws-view-alerts .card")
        expect(page.locator("#al-views option:text-is('Mine open')").count() == 1, "views: survives reload")

        # 6. Time and cost ----------------------------------------------------------------
        route(page, "value")
        page.click("#tc-measure")
        page.wait_for_selector("#tc-table tbody tr")
        expect(page.locator("#tc-table tbody tr").count() >= 4, "value: measured rows appear")
        expect("ms" in page.locator("#tc-table").inner_text(), "value: timings in ms")
        expect(page.locator("#tc-out").inner_text().startswith("Enter your numbers"), "value: calculator starts blank")
        for key, val in dict(alertsPerMonth="100", minutesNow="30", auditsPerYear="2", hoursNow="40", hourlyCost="50").items():
            page.fill(f"#tc-{key}", val)
        page.wait_for_selector("#tc-estimate")
        expect("34,000" in page.locator("#tc-estimate").inner_text(), "value: estimate follows the formula (34,000)")
        expect(page.locator("#tc-note").inner_text() == "Estimate from your inputs. Not a measured result.", "value: honesty line")
        expect(not re.search(r"\d+\s?%\s+(faster|saved|savings)|hours saved", page.locator("#ws-view-value").inner_text(), re.I), "value: no savings percentage claims")
        expect(page.locator(".compare__col").count() == 2, "value: before and with columns")
        page.screenshot(path=str(shots / "value_filled_desktop.png"), full_page=True)

        # 7. Reset demo -------------------------------------------------------------------
        page.click("#ws-reset")
        page.click("#ws-reset")
        page.wait_for_selector("#ws-toast[data-show=true]")
        expect("reset" in page.locator("#ws-toast").inner_text().lower(), "reset demo still works")

        # 8. Every route, both themes, desktop and phone ----------------------------------
        for theme in ("dark", "light"):
            for label, size in (("desktop", DESKTOP), ("phone", PHONE)):
                page.set_viewport_size(size)
                fresh(page, base, theme)
                for name in ROUTES:
                    route(page, name)
                    if name == "live":
                        page.click("#lv-toggle")
                        page.click("#lv-speed button:has-text('20x')")
                        page.wait_for_timeout(3500)
                    if name == "graph":
                        pass
                    page.wait_for_timeout(250)
                    over = overflow(page)
                    expect(over <= 0, f"{theme} {label} {name}: no horizontal scroll ({over}px)")
                    if name in ("dashboard", "live", "alerts", "graph", "flow", "value", "explorer"):
                        page.screenshot(path=str(shots / f"{name}_{theme}_{label}.png"), full_page=True)
                    if name == "live":
                        page.click("#lv-stop")
        browser.close()

    expect(not errors, f"no console errors ({errors[:3]})")
    expect(not foreign, f"only own-origin requests ({foreign[:3]})")
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) != 3:
        sys.exit("usage: e2e_pro.py <base-url> <screenshot-dir>")
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
