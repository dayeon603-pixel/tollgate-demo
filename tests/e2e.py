"""End-to-end check of the static site in headless Chromium (Playwright).

Usage: python3 tests/e2e.py <base-url-ending-in-slash> <screenshot-dir>
Serve the folder on a subpath first, e.g. http://127.0.0.1:8765/tollgate-demo/.

Fails (exit 1) on: a console error, a request to anything but the site's own origin, horizontal
scroll at phone width, a broken internal link or anchor, or any wrong verifier result.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from urllib.parse import unquote, urljoin, urlparse

from playwright.sync_api import Page, sync_playwright

log = logging.getLogger("e2e")
PAGES = ["index.html", "app.html", "contact.html", "faq.html", "security.html", "privacy.html", "terms.html"]
DESKTOP = {"width": 1440, "height": 900}
PHONE = {"width": 390, "height": 844}
OK_ADDRESS = "0x000000000000000000000000000000000000c1ea"

failures: list[str] = []


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def watch(page: Page, origin: str, errors: list[str], foreign: list[str]) -> None:
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: foreign.append(r.url) if not r.url.startswith(origin) and not r.url.startswith(("data:", "blob:")) else None)


def banner(page: Page) -> str:
    page.wait_for_function("() => !['loading'].includes(document.getElementById('tg-result').dataset.state)")
    return page.locator("#tg-result").get_attribute("data-state") or ""


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    errors: list[str] = []
    foreign: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()

        # 1. Every page, desktop and phone: screenshots, no horizontal scroll.
        for size_name, size in (("desktop", DESKTOP), ("phone", PHONE)):
            ctx = browser.new_context(viewport=size, accept_downloads=True)
            page = ctx.new_page()
            watch(page, origin, errors, foreign)
            for name in PAGES:
                page.goto(urljoin(base, name))
                page.wait_for_load_state("networkidle")
                if name == "index.html":
                    page.wait_for_selector("#stat-live:not([hidden])", timeout=5000)
                over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                expect(over <= 0, f"{size_name} {name}: no horizontal scroll ({over}px over)")
                page.screenshot(path=str(shots / f"{name.removesuffix('.html')}_{size_name}.png"), full_page=True)
            ctx.close()

        ctx = browser.new_context(viewport=DESKTOP, accept_downloads=True)
        page = ctx.new_page()
        watch(page, origin, errors, foreign)

        # 2. Landing: live measurement and links.
        page.goto(base)
        page.wait_for_selector("#stat-live:not([hidden])")
        expect(page.locator("#hero-status").get_attribute("data-state") == "pass", "landing: hero chain verifies live")
        ms = page.locator("#stat-live-ms").inner_text()
        log.info("     live verify time on landing: %s ms", ms)
        expect(page.evaluate("() => document.activeElement === document.body"), "landing: focus starts on body")
        page.keyboard.press("Tab")
        expect(page.evaluate("() => document.activeElement.classList.contains('skip')"), "landing: first Tab reaches skip link")

        # 3. Links on every page resolve; anchors exist; mailto targets the right address.
        checked: set[str] = set()
        for name in PAGES:
            page.goto(urljoin(base, name))
            hrefs = page.eval_on_selector_all("a[href]", "els => els.map(e => e.getAttribute('href'))")
            for href in hrefs:
                if href.startswith("mailto:"):
                    expect(href.startswith("mailto:dayeon603@gmail.com"), f"{name}: mailto {href[:60]}")
                    continue
                if href.startswith("#") and name == "app.html":
                    continue  # app routes, tested below
                target = urljoin(urljoin(base, name), href)
                expect(target.startswith(base), f"{name}: link {href} stays on site")
                if target in checked:
                    continue
                checked.add(target)
                path, _, frag = target.partition("#")
                resp = page.request.get(path)
                expect(resp.status == 200, f"{name}: {href} -> {resp.status}")
                if frag:
                    sub = ctx.new_page()
                    sub.goto(path)
                    expect(sub.locator(f"[id='{frag}']").count() == 1, f"{name}: anchor #{frag} exists on {path.rsplit('/', 1)[-1] or 'index'}")
                    sub.close()

        # 4. App: sample verify, tamper, edited signature.
        page.goto(urljoin(base, "app.html#receipts"))
        page.wait_for_function("() => !document.getElementById('tg-verify').disabled")
        page.click("#tg-verify")
        expect(banner(page) == "pass", "app: sample verifies (pass)")
        page.select_option("#tg-scenario", "amount")
        page.click("#tg-tamper")
        expect(banner(page) == "fail", "app: tampered amount fails")
        page.click("#tg-restore")
        page.goto(urljoin(base, "app.html#raw"))
        page.wait_for_function("() => document.getElementById('tg-file').value.length > 0")
        text = page.input_value("#tg-file")
        sample = json.loads(text)
        sig = sample["receipts"][1]["verdict"]["signature"]
        page.fill("#tg-file", text.replace(sig, ("b" if sig[0] == "a" else "a") + sig[1:]))
        page.click("#tg-verify")
        expect(banner(page) == "fail", "app: edited signature fails")

        # 5. Get started: screen, sign, download, check package, verify, tamper.
        page.goto(urljoin(base, "app.html"))
        page.wait_for_function("() => !document.getElementById('st-screen').disabled")
        expect(page.locator("#tg-title").inner_text() == "Get started", "app: opens on Get started")
        expect("10/21/2026" in (page.locator("#st-prov").text_content() or ""), "start: list provenance shows the OFAC publish date")
        listed = page.locator("#st-example").inner_text()
        page.fill("#st-address", "")
        page.click("#st-screen")
        expect(page.locator("#st-error").inner_text() != "", "start: empty address gives an error")
        page.fill("#st-address", "0x12 34")
        page.click("#st-screen")
        expect("spaces" in page.locator("#st-error").inner_text(), "start: address with a space is refused")
        page.fill("#st-address", listed.upper().replace("0X", "0x"))
        page.fill("#st-amount", "1,500")
        page.click("#st-screen")
        expect(page.locator("#st-result").get_attribute("data-outcome") == "BLOCK", "start: listed address (other case) is BLOCK")
        page.click("#st-sign")
        page.wait_for_selector(".mini-receipt")
        expect("$1,500" in page.locator(".mini-receipt").inner_text(), "start: receipt shows the amount")
        page.fill("#st-address", OK_ADDRESS)
        page.fill("#st-amount", "")
        page.click("#st-screen")
        expect(page.locator("#st-result").get_attribute("data-outcome") == "ALLOW", "start: unlisted address is ALLOW")
        page.click("#st-sign")
        page.wait_for_function("() => document.querySelectorAll('.mini-chain li').length === 2")
        expect(True, "start: chain has 2 receipts")
        with page.expect_download() as info:
            page.click("#st-download")
        download = info.value
        pkg_path = shots / "downloaded_package.json"
        download.save_as(pkg_path)
        expect(download.suggested_filename.startswith("tollgate-receipts-"), f"start: download named {download.suggested_filename}")
        page.set_input_files("#st-file", str(pkg_path))
        page.wait_for_selector("#st-check .banner[data-state='pass']", timeout=5000)
        expect(True, "start: downloaded package passes Check a package")
        pkg = json.loads(pkg_path.read_text())
        pkg["receipts"][0]["action"]["params"]["outcome"] = "ALLOW"
        bad_path = shots / "tampered_package.json"
        bad_path.write_text(json.dumps(pkg))
        page.set_input_files("#st-file", str(bad_path))
        page.wait_for_selector("#st-check .banner[data-state='fail']", timeout=5000)
        expect(True, "start: tampered package fails Check a package")
        junk_path = shots / "not_a_package.json"
        junk_path.write_text("hello")
        page.set_input_files("#st-file", str(junk_path))
        page.wait_for_selector("#st-check .banner[data-state='fail']")
        expect("cannot be read" in page.locator("#st-check").inner_text(), "start: non-receipt upload is refused")
        page.screenshot(path=str(shots / "app_start_flow_desktop.png"), full_page=True)
        page.click("#st-open")
        expect(banner(page) == "pass", "start: Verify my receipts passes in the verifier")
        expect(page.locator("#tg-meta-file").inner_text() == "Your receipts, unchanged", "verifier: shows your receipts")
        page.select_option("#tg-scenario", "signature")
        page.click("#tg-tamper")
        expect(banner(page) == "fail", "verifier: tampered signature on your receipts fails")
        page.select_option("#tg-scenario", "outcome")
        page.click("#tg-tamper")
        expect(banner(page) == "fail", "verifier: flipped outcome on your receipts fails")
        page.click("#tg-restore")
        page.click("#tg-verify")
        expect(banner(page) == "pass", "verifier: restored receipts pass")
        page.screenshot(path=str(shots / "app_your_receipts_desktop.png"), full_page=True)
        page.click("#tg-use-sample")
        page.click("#tg-verify")
        expect(banner(page) == "pass" and page.locator("#tg-meta-file").inner_text() == "Sample, unchanged", "verifier: back to sample, passes")

        # 6. Report a problem builds a draft with error and browser details.
        page.select_option("#tg-scenario", "amount")
        page.click("#tg-tamper")
        banner(page)
        page.locator("#tg-report").focus()
        href = page.locator("#tg-report").get_attribute("href") or ""
        body = unquote(href)
        expect(href.startswith("mailto:dayeon603@gmail.com?subject=") and "Result: fail" in body and "Browser: Mozilla" in body, "app: Report a problem drafts error + browser info")

        # 7. Phone: start flow screenshot.
        ctx.close()
        ctx = browser.new_context(viewport=PHONE)
        page = ctx.new_page()
        watch(page, origin, errors, foreign)
        page.goto(urljoin(base, "app.html"))
        page.wait_for_function("() => !document.getElementById('st-screen').disabled")
        page.fill("#st-address", page.locator("#st-example").inner_text())
        page.click("#st-screen")
        page.click("#st-sign")
        page.wait_for_selector(".mini-receipt")
        over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
        expect(over <= 0, f"phone app start flow: no horizontal scroll ({over}px over)")
        page.screenshot(path=str(shots / "app_start_flow_phone.png"), full_page=True)

        # 8. Reduced motion turns animations off.
        ctx.close()
        ctx = browser.new_context(viewport=DESKTOP, reduced_motion="reduce")
        page = ctx.new_page()
        page.goto(base)
        anim = page.evaluate("() => getComputedStyle(document.querySelector('.hero__copy')).animationName")
        expect(anim == "none", f"reduced motion: hero animation off ({anim})")
        browser.close()

    expect(not errors, f"no console errors ({errors[:3]})")
    expect(not foreign, f"only own-origin requests ({sorted(set(foreign))[:3]})")
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
