"""Browser check of the Integrations view and the API reference page (Playwright, headless Chromium).

Usage: python3 tests/e2e_integrations.py <base-url-ending-in-slash> <screenshot-dir>

Walks what an integrator would do: read-only for a non-admin, create a scoped key (shown once,
never saved), call POST /v1/screen from the API console, retry with an Idempotency-Key, read
usage and export it as CSV, revoke the key and see 401, add a webhook (http refused, https
accepted) and read its signed deliveries, export the audit log as JSON and CSV, and open the API
reference. Desktop and phone, light and dark. Fails (exit 1) on a console error, a request off the
site's own origin, horizontal scroll, or a wrong result.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import rpc_fixture
from playwright.sync_api import Page, sync_playwright

log = logging.getLogger("e2e-integrations")
DESKTOP = {"width": 1280, "height": 800}
PHONE = {"width": 390, "height": 844}
PREFS = "tollgate-demo-prefs-v1"
STATE = "tollgate-demo-workspace-v1"
failures: list[str] = []


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def open_view(page: Page, app: str) -> None:
    page.goto(app + "#integrations")
    page.wait_for_selector("#ws-view-integrations #in-keys", timeout=15000)


def console_send(page: Page) -> str:
    """Clicks Send in the API console and returns the response text once it changes."""
    before = page.inner_text("#in-con-out")
    page.click("#in-con-send")
    page.wait_for_function("b => document.getElementById('in-con-out').textContent !== b", arg=before, timeout=10000)
    return page.inner_text("#in-con-out")


def body_of(response: str) -> dict:
    return json.loads(response.split("\n\n", 1)[1])


def main(base: str, shots: Path) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    errors: list[str] = []
    foreign: list[str] = []
    app = urljoin(base, "app.html")
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        rpc_fixture.patch(browser)
        ctx = browser.new_context(viewport=DESKTOP, accept_downloads=True)
        page = ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: foreign.append(r.url) if not rpc_fixture.allowed(r.url, origin) else None)

        page.goto(app)
        page.evaluate(f"() => {{ localStorage.clear(); localStorage.setItem('{PREFS}', JSON.stringify({{user: 'analyst-a', theme: 'light', chainAutoConnect: false}})); }}")
        open_view(page, app)
        page.reload()
        page.wait_for_selector("#in-keys")

        # 1. Analysts see the view read-only.
        expect(page.locator("#in-readonly").is_visible(), "analyst: read-only note shown")
        expect(page.locator("#in-key-create").is_disabled() and page.locator("#in-hook-add").is_disabled(), "analyst: create buttons disabled")
        expect(page.locator(".navlink[data-route='integrations']").count() == 1, "nav: Integrations link present")

        # 2. Admin creates a key; the secret is shown once and never saved.
        page.select_option("#ws-user", "admin-d")
        page.wait_for_selector("#in-key-create:not([disabled])")
        page.click("#in-key-create")
        expect("Name the key" in page.inner_text("#in-key-error"), "key: a name is required")
        page.fill("#in-key-name", "Withdrawals service")
        page.click("#in-key-create")
        page.wait_for_selector("#in-secret")
        secret = page.locator("#in-secret .mono").inner_text().strip()
        expect(secret.startswith("tg_") and len(secret) == 46, f"key: secret shown once ({secret[:7]}...)")
        saved = page.evaluate(f"() => localStorage.getItem('{STATE}')") or ""
        expect(secret not in saved and "apiKeyCreate" in saved, "key: the op is saved without the secret")
        expect(page.locator("#in-keys tr.grid__row", has_text="Withdrawals service").count() == 1, "key: listed")
        expect(page.input_value("#in-con-key") == secret, "console: the new key is filled in")
        page.screenshot(path=str(shots / "integrations_key.png"), full_page=True)

        # 3. Screen a transfer from the console; it is a signed decision in the ledger.
        result = console_send(page)
        expect(result.startswith("HTTP 200"), f"console: screen returns 200 ({result[:40]})")
        first = body_of(result)
        expect(first["outcome"] == "BLOCK" and first["receipt"]["action"]["params"]["api_key_id"].startswith("key_"), "console: listed address is a hit signed with the key id")
        # Idempotent retry: same key, same body, same receipt.
        page.fill("#in-con-idem", "withdrawal-1001")
        a = body_of(console_send(page))
        retry = console_send(page)
        b = body_of(retry)
        expect("Idempotent-Replayed: true" in retry and a["receipt"]["receipt_id"] == b["receipt"]["receipt_id"], "console: idempotent retry returns the stored receipt")
        page.fill("#in-con-body", '{"chain": "ETH", "to_address": "nope"}')
        page.fill("#in-con-idem", "")
        bad = console_send(page)
        expect(bad.startswith("HTTP 422") and body_of(bad)["error"]["code"] == "bad_address", "console: bad address is a 422 with a code")
        page.fill("#in-con-key", "")
        page.fill("#in-con-body", '{"chain": "ETH", "to_address": "0x1111111111111111111111111111111111111111"}')
        expect(console_send(page).startswith("HTTP 401"), "console: no key is a 401")

        # 4. Usage: the key's screens are counted once each, and CSV downloads.
        usage = page.locator("#in-usage tr.grid__row", has_text="Withdrawals service")
        expect(usage.count() == 1, "usage: a row for the key")
        cells = usage.first.locator("td").all_inner_texts()
        expect(cells[3] == "2", f"usage: two signed decisions, the retry and the refused call not counted ({cells})")
        with page.expect_download() as dl:
            page.click("#in-use-csv")
        rows = list(csv.reader(io.StringIO(Path(dl.value.path()).read_text())))
        expect(rows[0] == ["period", "meter", "kind", "key_name", "screened", "allow", "hold", "block"] and any(r[3] == "Withdrawals service" for r in rows[1:]), "usage: CSV has the key row")
        page.fill("#in-use-from", "2026-12-31")
        page.fill("#in-use-to", "2026-01-01")
        page.dispatch_event("#in-use-to", "change")
        expect("on or before" in page.inner_text("#in-use-error"), "usage: a reversed range is refused with a message")

        # 5. Webhooks: http refused; https accepted; deliveries are signed and marked not sent.
        page.fill("#in-hook-url", "http://example.com/hook")
        page.click("#in-hook-add")
        expect("https" in page.inner_text("#in-hook-error"), "webhook: http is refused")
        page.fill("#in-hook-url", "https://example.com/tollgate")
        page.check("#in-ev-decision-created")
        page.click("#in-hook-add")
        page.wait_for_selector("#in-secret")
        expect(page.locator("#in-secret .mono").inner_text().startswith("whsec_"), "webhook: signing secret shown once")
        page.fill("#in-con-key", secret)
        page.fill("#in-con-body", '{"chain": "ETH", "to_address": "0x2222222222222222222222222222222222222222", "amount_usd": 10, "originator_info_present": true}')
        expect(console_send(page).startswith("HTTP 200"), "console: clean screen after the webhook")
        page.locator("#in-hooks button.rowlink").first.click()
        page.wait_for_selector("#in-deliveries tr.grid__row")
        text = page.inner_text("#in-deliveries")
        expect("decision.created" in text and "not sent" in text, "webhook: delivery listed as not sent")
        page.locator("#in-deliveries summary").first.click()
        expect("Tollgate-Signature: t=" in page.inner_text("#in-deliveries pre"), "webhook: delivery shows its signature header")
        page.screenshot(path=str(shots / "integrations_webhook.png"), full_page=True)

        # 6. Revoke the key: the next call is a 401; both changes are receipts in the activity log.
        page.locator("#in-keys button[data-revoke]").first.click()
        page.wait_for_selector("#in-keys tr.grid__row:has-text('Revoked')")
        expect(console_send(page).startswith("HTTP 401"), "revoked key: 401")
        page.goto(app + "#activity")
        page.wait_for_selector("#ac-export-json")
        log_text = page.inner_text("#ws-view-activity")
        expect("Created API key Withdrawals service" in log_text and "Revoked API key" in log_text and "Added webhook" in log_text, "activity: key and webhook changes are logged")
        expect("API key: Withdrawals service" in log_text, "activity: API screens name the key")

        # 7. Audit export: JSON carries the chain and the head hash; CSV has hash columns.
        with page.expect_download() as dl:
            page.click("#ac-export-json")
        doc = json.loads(Path(dl.value.path()).read_text())
        receipts = doc["receipts"]
        links_ok = all(r["prev_hash"] == receipts[i - 1]["this_hash"] for i, r in enumerate(receipts) if i and r["action"]["type"] != "segment_open")
        expect(doc["receipts_count"] == len(receipts) and doc["head_hash"] == receipts[-1]["this_hash"] and links_ok, f"audit JSON: {len(receipts)} receipts, chained, head hash matches")
        with page.expect_download() as dl:
            page.click("#ac-export-csv")
        header = next(csv.reader(io.StringIO(Path(dl.value.path()).read_text())))
        expect(header[-2:] == ["prev_hash", "this_hash"], "audit CSV: hash columns")

        # 8. Persistence: the key list and usage survive a reload.
        open_view(page, app)
        page.reload()
        page.wait_for_selector("#in-keys tr.grid__row")
        expect(page.locator("#in-keys tr.grid__row", has_text="Revoked").count() == 1, "reload: revoked key still listed")
        expect(page.locator("#in-secret").count() == 0, "reload: the secret is not shown again")

        # 9. Layout: no horizontal scroll at phone width, light and dark; the API reference page.
        for theme in ("light", "dark"):
            for name, size in (("desktop", DESKTOP), ("phone", PHONE)):
                page.set_viewport_size(size)
                page.evaluate(f"t => {{ const p = JSON.parse(localStorage.getItem('{PREFS}')); p.theme = t; localStorage.setItem('{PREFS}', JSON.stringify(p)); }}", theme)
                open_view(page, app)
                page.reload()
                page.wait_for_selector("#in-keys")
                over = page.evaluate("() => document.documentElement.scrollWidth - window.innerWidth")
                expect(over <= 0, f"{theme} {name}: no horizontal scroll ({over}px)")
                page.screenshot(path=str(shots / f"integrations_{theme}_{name}.png"), full_page=True)
        page.set_viewport_size(DESKTOP)
        page.goto(urljoin(base, "docs.html"))
        page.wait_for_selector("#s-hooks")
        doc_text = page.inner_text("main")
        for route in ("POST /v1/screen", "GET /v1/usage", "POST /v1/verify", "address.newly_listed", "Tollgate-Signature"):
            expect(route in doc_text, f"docs: mentions {route}")
        expect("Arbiter" not in doc_text and "—" not in doc_text and "–" not in doc_text, "docs: no company name, no dash sentence breaks")
        page.screenshot(path=str(shots / "docs.png"), full_page=True)
        ctx.close()
        browser.close()

    expect(not errors, f"no console errors ({errors[:3]})")
    expect(not foreign, f"only own-origin requests ({foreign[:3]})")
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) != 3:
        sys.exit("usage: e2e_integrations.py <base-url/> <screenshot-dir>")
    sys.exit(main(sys.argv[1], Path(sys.argv[2])))
