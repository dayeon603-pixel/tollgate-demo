"""Browser check of the Live chain view (Playwright, headless Chromium).

Usage: python3 tests/e2e_chain.py <base-url-ending-in-slash> <screenshot-dir> [--live SECONDS]

1. Recorded mainnet data (tests/fixtures/eth_mainnet.json served in place of the RPC nodes): the view
   labels itself honestly, screens and signs every transfer in the head block, reports "0 hits in N",
   lists the issuers' recent freezes with the OFAC column, opens and verifies a receipt, replays the
   historical transfer to a listed address as a labelled hit that is not counted as live, and the
   dashboard hero shows the same numbers. Both themes, 1440 and 390 px, no horizontal scroll.
2. RPC blocked (every request to the nodes aborted): a clear status, no page error, the rest of the
   workspace still works.
3. With --live N: the real nodes, for N seconds, then a screenshot and the block numbers seen.
Fails on a page error, a console error (other than the aborted requests in part 2) or a request to any
origin other than the site and the two RPC nodes.
"""
from __future__ import annotations

import json
import logging
import re
import sys
from pathlib import Path
from urllib.parse import urljoin, urlparse

import rpc_fixture
from playwright.sync_api import Browser, Page, sync_playwright

log = logging.getLogger("e2e-chain")
failures: list[str] = []
PREFS = "tollgate-demo-prefs-v1"
SIZES = {"1440": {"width": 1440, "height": 900}, "390": {"width": 390, "height": 844}}
FX = rpc_fixture.FIXTURE
HEAD = int(FX["transfer_window"][1], 16)
HEAD_TRANSFERS = sum(1 for log_ in FX["logs"] if int(log_["blockNumber"], 16) == HEAD)
ABORT_NOISE = re.compile(r"Failed to load resource|net::ERR_FAILED|ERR_INTERNET_DISCONNECTED")


def expect(cond: bool, what: str) -> None:
    """Records a failed expectation without stopping the run."""
    if cond:
        log.info("ok   %s", what)
    else:
        log.error("FAIL %s", what)
        failures.append(what)


def open_app(browser: Browser, base: str, size: dict, theme: str, errors: list[str], foreign: list[str], hash_: str = "chain") -> Page:
    ctx = browser.new_context(viewport=size)
    page = ctx.new_page()
    origin = f"{urlparse(base).scheme}://{urlparse(base).netloc}"
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.on("request", lambda r: foreign.append(r.url) if not rpc_fixture.allowed(r.url, origin, page.url) else None)
    page.goto(urljoin(base, "app.html#dashboard"))
    page.evaluate("([k, t]) => { localStorage.clear(); localStorage.setItem(k, JSON.stringify({ user: 'analyst-a', theme: t })); }", [PREFS, theme])
    page.goto(urljoin(base, f"app.html#{hash_}"))
    page.reload()
    return page


def fixture_checks(browser: Browser, base: str, shots: Path) -> None:
    errors: list[str] = []
    foreign: list[str] = []
    for theme in ("light", "dark"):
        for label, size in SIZES.items():
            page = open_app(browser, base, size, theme, errors, foreign)
            page.wait_for_selector("#ch-state[data-state=live]", timeout=20000)
            page.wait_for_function("n => document.querySelectorAll('#ch-table tbody tr').length >= Math.min(n, 50)", arg=HEAD_TRANSFERS, timeout=20000)
            page.wait_for_selector("#ch-freezes tbody tr", timeout=20000)
            page.wait_for_timeout(900)
            over = page.evaluate("() => document.documentElement.scrollWidth - innerWidth")
            expect(over <= 0, f"chain {theme} {label}: no horizontal scroll ({over}px)")
            page.screenshot(path=str(shots / f"chain_fixture_{theme}_{label}.png"), full_page=True)
            page.context.close()

    page = open_app(browser, base, SIZES["1440"], "light", errors, foreign)
    page.wait_for_selector("#ch-state[data-state=live]", timeout=20000)
    page.wait_for_function("() => document.querySelectorAll('#ch-freezes tbody tr').length > 0", timeout=20000)
    head = page.inner_text("#ch-head")
    expect("Live Ethereum mainnet" in head and "real transfers" in head and "list snapshot dated 2026-10-21" in head, f"chain: honest label ({head!r})")
    expect("ethereum-rpc.publicnode.com" in page.inner_text("#ch-source"), "chain: says which host the browser reads from")
    n = int(page.inner_text("#ch-k-n dd").replace(",", ""))
    expect(n == HEAD_TRANSFERS, f"chain: every transfer in the head block screened ({n} of {HEAD_TRANSFERS})")
    hits = int(page.inner_text("#ch-k-hits dd").replace(",", ""))
    sub = page.inner_text("#ch-k-hits .kpi__sub")
    expect(sub == f"{hits} hit{'' if hits == 1 else 's'} in {n:,} transfers", f"chain: hits reported as a count of the transfers ({sub!r})")
    rows = page.locator("#ch-table tbody tr")
    expect(rows.count() == min(n, 50), f"chain: transfer table rows ({rows.count()})")
    blocked = page.locator("#ch-table tbody tr[data-outcome=BLOCK]").count()
    expect(blocked == hits, "chain: a hit row only for a real hit")
    links = page.locator("#ch-table a.extlink")
    expect(links.count() == rows.count() and all((links.nth(i).get_attribute("rel") or "").startswith("noopener") and links.nth(i).get_attribute("target") == "_blank" for i in range(3)), "chain: each row links to Etherscan in a new tab, noopener")
    expect((links.first.get_attribute("href") or "").startswith("https://etherscan.io/tx/0x"), "chain: Etherscan link is the transaction")
    freezes = page.locator("#ch-freezes tbody tr").count()
    expect(freezes == len(FX["freezes"]), f"chain: recent issuer freezes listed ({freezes})")
    expect("On OFAC list (2026-10-21)" in page.inner_text("#ch-freezes thead"), "chain: freeze table compares with the dated list")
    page.locator("#ch-table tbody tr button.linkbtn").first.click()
    page.wait_for_selector("#ws-drawer[open] #chr-verify")
    page.click("#chr-verify")
    page.wait_for_selector("#ws-drawer .banner[data-state=pass]")
    expect(True, "chain: a receipt opens and its segment verifies")
    page.keyboard.press("Escape")
    page.click("#ch-replay")
    page.wait_for_selector("#ch-replay-out .banner", timeout=20000)
    out = page.inner_text("#ch-replay-out")
    expect("Historical hit" in out and "SEMENOV" in out and "13,180,202" in out and "Not a live transfer" in out, f"chain: replay shows a labelled historical hit ({out[:120]!r})")
    page.wait_for_selector("#ch-table tr[data-source=historical_replay]")
    hist = page.locator("#ch-table tr[data-source=historical_replay]")
    expect(hist.count() == 1 and "Historical" in hist.inner_text() and hist.get_attribute("data-outcome") == "BLOCK", "chain: replayed row is marked Historical and is a hit")
    expect(int(page.inner_text("#ch-k-hits dd").replace(",", "")) == hits, "chain: the replay is not counted as a live hit")
    page.click("#ch-verify")
    page.wait_for_selector("#ch-verify-out .banner[data-state=pass]")
    expect(True, "chain: the rolling window verifies")
    page.screenshot(path=str(shots / "chain_fixture_replay_light_1440.png"), full_page=True)
    page.goto(urljoin(base, "app.html#dashboard"))
    page.wait_for_selector("#dash-chain #ch-state[data-state=live]", timeout=20000)
    expect(page.inner_text("#dash-chain-n").replace(",", "") == str(n), "dashboard: hero shows the same transfer count")
    expect(page.locator("nav a[data-route=chain]").first.evaluate("e => e === e.parentElement.firstElementChild"), "sidebar: Live chain is the first item")
    page.screenshot(path=str(shots / "chain_dashboard_light_1440.png"), full_page=True)
    page.context.close()
    expect(not errors, f"fixture: no console errors ({errors[:3]})")
    expect(not foreign, f"fixture: only the site and the two RPC nodes ({foreign[:3]})")


RANGE_KEYS = ["1D", "1W", "1M", "3M", "6M", "1Y", "3Y"]
MS_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
SEC_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")


def history_checks(browser: Browser, base: str, shots: Path) -> None:
    """History ranges, saved records, reload persistence and CSV export on the Live chain view."""
    errors: list[str] = []
    foreign: list[str] = []
    for theme in ("light", "dark"):
        for label, size in SIZES.items():
            page = open_app(browser, base, size, theme, errors, foreign)
            page.wait_for_selector("#ch-state[data-state=live]", timeout=20000)
            page.wait_for_function("() => document.querySelectorAll('#ch-table tbody tr').length > 0", timeout=20000)
            page.wait_for_function("() => /Saved in this browser/.test(document.querySelector('#ch-saved-storage')?.textContent || '')", timeout=10000)
            expect("Recording runs while this page is open. The self-hosted kit records around the clock." in page.inner_text("#ch-record-line"), f"history {theme} {label}: the recording line is shown")
            expect(page.get_attribute("#ch-range-1D", "aria-checked") == "true", f"history {theme} {label}: 1D is the default")
            for key in RANGE_KEYS:
                page.click(f"#ch-range-{key}")
                page.wait_for_function("k => document.querySelector(`#ch-range-${k}`)?.getAttribute('aria-checked') === 'true'", arg=key)
                over = page.evaluate("() => document.documentElement.scrollWidth - innerWidth")
                expect(over <= 0, f"history {theme} {label} {key}: no horizontal scroll ({over}px)")
                if key in ("1D", "1M", "3Y"):
                    page.wait_for_timeout(500)
                    page.locator("#ch-history").screenshot(path=str(shots / f"chain_history_{key}_{theme}_{label}.png"))
            note = page.inner_text("#ch-range-note")
            expect(note.startswith("Records start 20"), f"history {theme} {label} 3Y: note says where records start ({note!r})")
            page.context.close()

    page = open_app(browser, base, SIZES["1440"], "light", errors, foreign)
    page.wait_for_selector("#ch-state[data-state=live]", timeout=20000)
    page.wait_for_function("() => /Saved in this browser/.test(document.querySelector('#ch-saved-storage')?.textContent || '')", timeout=10000)
    page.wait_for_function("n => parseInt((document.querySelector('#ch-saved-transfers')?.textContent || '0').replace(/,/g, '')) >= n", arg=HEAD_TRANSFERS, timeout=10000)
    # Receipt detail shows full precision.
    page.wait_for_selector("#ch-table tbody tr button.linkbtn", timeout=20000)
    page.locator("#ch-table tbody tr button.linkbtn").first.click()
    page.wait_for_selector("#ws-drawer[open] #chr-verify")
    drawer = page.inner_text("#ws-drawer")
    expect(re.search(r"Screened at\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} UTC", drawer) is not None, "drawer: screened at shows milliseconds")
    expect(re.search(r"Block time\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC", drawer) is not None, "drawer: block time shows seconds, no invented milliseconds")
    page.keyboard.press("Escape")
    before = page.inner_text("#ch-saved-transfers")
    first_before = page.inner_text("#ch-saved-first")
    expect(first_before.startswith("20"), f"saved: first record shown ({first_before!r})")
    # Block the RPC nodes and reload: the saved records must come back from IndexedDB with no chain data.
    page.context.unroute_all()
    rpc_fixture.install(page.context, "abort")
    page.reload()
    page.wait_for_function("() => /Saved in this browser/.test(document.querySelector('#ch-saved-storage')?.textContent || '')", timeout=10000)
    page.wait_for_function("() => !/Nothing recorded|Opening/.test(document.querySelector('#ch-saved-first')?.textContent || 'Opening')", timeout=10000)
    after = page.inner_text("#ch-saved-transfers")
    expect(after.split(" in ")[0] == before.split(" in ")[0] and int(after.split(" in ")[0].replace(",", "")) >= HEAD_TRANSFERS, f"saved: records survive a reload ({before!r} then {after!r})")
    expect(page.inner_text("#ch-saved-first") == first_before, "saved: first-record date survives a reload")
    # CSV export.
    with page.expect_download() as dl:
        page.click("#ch-saved-export")
    text = Path(dl.value.path()).read_bytes().decode("utf-8")
    lines = text.strip().split("\r\n")
    header = lines[0].split(",")
    expect("screened_at" in header and "block_time" in header, "csv: has block_time and screened_at columns")
    rows = [dict(zip(header, line.split(","))) for line in lines[1:] if "receipt_json" not in line]
    sample = [r for r in rows if r.get("record_type") == "transfer"]
    expect(len(sample) >= 1 and all(MS_ISO.match(r["screened_at"]) for r in sample), "csv: screened_at has milliseconds (ISO, UTC)")
    expect(all(SEC_ISO.match(r["block_time"]) for r in sample), "csv: block_time is to the second, no milliseconds")
    expect(len(lines) - 1 >= HEAD_TRANSFERS, f"csv: every saved record exported ({len(lines) - 1} rows)")
    # Clear needs an in-page confirmation (no window.confirm dialog).
    dialogs: list[str] = []
    page.on("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
    page.click("#ch-saved-clear")
    page.wait_for_selector("#ch-saved-confirm")
    page.click("#ch-saved-cancel")
    expect(page.locator("#ch-saved-confirm").count() == 0 and "Nothing" not in page.inner_text("#ch-saved-first"), "clear: cancel keeps the records")
    page.click("#ch-saved-clear")
    page.click("#ch-saved-confirm")
    page.wait_for_function("() => /Saved records erased/.test(document.querySelector('#ch-saved-out')?.textContent || '')", timeout=10000)
    expect(not dialogs, "clear: confirmed in the page, no browser dialog")
    page.context.close()

    # IndexedDB blocked: the notice is visible and the page keeps recording from memory.
    ctx = browser.new_context(viewport=SIZES["1440"])
    ctx.add_init_script("Object.defineProperty(window, 'indexedDB', { get() { return undefined; } })")
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append(f"pageerror {e}"))
    page.goto(urljoin(base, "app.html#chain"))
    page.wait_for_selector("#ch-state[data-state=live]", timeout=20000)
    page.wait_for_selector("#ch-saved-notice:not([hidden])", timeout=10000)
    expect("memory only" in page.inner_text("#ch-saved-notice").lower(), f"no IndexedDB: visible notice ({page.inner_text('#ch-saved-notice')[:60]!r})")
    page.wait_for_function("() => parseInt((document.querySelector('#ch-saved-transfers')?.textContent || '0').replace(/,/g, '')) > 0", timeout=10000)
    expect("Memory only" in page.inner_text("#ch-saved-storage"), "no IndexedDB: storage state says memory only")
    page.screenshot(path=str(shots / "chain_no_indexeddb_light_1440.png"), full_page=True)
    ctx.close()
    real = [e for e in errors if not ABORT_NOISE.search(e)]  # the reload with the nodes blocked aborts requests on purpose
    expect(not real, f"history: no console errors ({real[:3]})")
    expect(not foreign, f"history: only the site and the two RPC nodes ({foreign[:3]})")


def blocked_checks(browser: Browser, base: str, shots: Path) -> None:
    errors: list[str] = []
    foreign: list[str] = []
    page = open_app(browser, base, SIZES["1440"], "light", errors, foreign)
    page.wait_for_selector("#ch-state[data-state=retrying], #ch-state[data-state=error]", timeout=20000)
    expect("Retrying" in page.inner_text("#ch-source") or "could not connect" in page.inner_text("#ch-source"), f"blocked: the reason and the retry are shown ({page.inner_text('#ch-source')!r})")
    expect("node cannot be reached" in page.inner_text("#ws-view-chain") or "Waiting" in page.inner_text("#ws-view-chain"), "blocked: empty states say why")
    page.screenshot(path=str(shots / "chain_blocked_light_1440.png"), full_page=True)
    page.goto(urljoin(base, "app.html#alerts"))
    page.wait_for_selector("#ws-view-alerts tr.grid__row")
    expect(page.locator("#ws-view-alerts tr.grid__row").count() > 0, "blocked: the rest of the workspace still works")
    page.goto(urljoin(base, "app.html#dashboard"))
    page.wait_for_selector("#dash-chain")
    expect("Live chain" in page.inner_text("#dash-chain"), "blocked: dashboard hero still renders")
    page.context.close()
    real = [e for e in errors if not ABORT_NOISE.search(e)]
    expect(not real, f"blocked: no page errors ({real[:3]})")
    expect(not foreign, f"blocked: only the site and the two RPC nodes ({foreign[:3]})")


def live_run(browser: Browser, base: str, shots: Path, seconds: int) -> None:
    errors: list[str] = []
    foreign: list[str] = []
    page = open_app(browser, base, SIZES["1440"], "light", errors, foreign)
    page.wait_for_selector("#ch-state[data-state=live]", timeout=30000)
    first = page.inner_text("#ch-k-block dd")
    page.wait_for_timeout(seconds * 1000)
    page.click("#ch-replay")
    page.wait_for_selector("#ch-replay-out .banner", timeout=30000)
    summary = page.evaluate("""() => { const t = (s) => document.querySelector(s)?.innerText ?? '';
      return { first_block_label: '', last_block: t('#ch-k-block dd'), transfers: t('#ch-k-n dd'), blocks: t('#ch-k-n .kpi__sub'), hits: t('#ch-k-hits .kpi__sub'),
        usd: t('#ch-k-usd dd'), freezes: t('#ch-k-freezes dd'), freezes_since: t('#ch-k-freezes .kpi__sub'), state: document.querySelector('#ch-state')?.dataset.state, source: t('#ch-source'), replay: t('#ch-replay-out') }; }""")
    summary["first_block_label"] = first
    log.info("live run: %s", json.dumps(summary))
    page.screenshot(path=str(shots / "chain_live_light_1440.png"), full_page=True)
    page.evaluate("() => document.querySelector('html').dataset.theme = 'dark'")
    page.wait_for_timeout(600)
    page.screenshot(path=str(shots / "chain_live_dark_1440.png"), full_page=True)
    page.context.close()
    expect(summary["state"] == "live", f"live: still live after {seconds} s")
    expect(not errors, f"live: no console errors ({errors[:3]})")
    expect(not foreign, f"live: only the site and the two RPC nodes ({foreign[:3]})")


def main(base: str, shots: Path, live_seconds: int) -> int:
    shots.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b1 = rpc_fixture.patch(pw.chromium.launch(), "fixture")
        fixture_checks(b1, base, shots)
        history_checks(b1, base, shots)
        b1.close()
        b2 = rpc_fixture.patch(pw.chromium.launch(), "abort")
        blocked_checks(b2, base, shots)
        b2.close()
        if live_seconds:
            b3 = pw.chromium.launch()
            live_run(b3, base, shots, live_seconds)
            b3.close()
    log.info("%d failure(s)", len(failures))
    return 1 if failures else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if len(sys.argv) < 3:
        sys.exit("usage: e2e_chain.py <base-url> <screenshot-dir> [--live SECONDS]")
    secs = int(sys.argv[sys.argv.index("--live") + 1]) if "--live" in sys.argv else 0
    sys.exit(main(sys.argv[1], Path(sys.argv[2]), secs))
