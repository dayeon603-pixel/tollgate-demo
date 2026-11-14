"""Answers the Live chain's JSON-RPC calls in Playwright from recorded mainnet data.

The page may contact exactly two origins besides its own (app.html's connect-src): the public
Ethereum nodes in RPC_ORIGINS. The browser suites route those to this responder so they are
hermetic and never depend on a third-party node; tests/e2e_chain.py also checks the page against
the real nodes and against a blocked network.

Usage: rpc_fixture.patch(browser) after launch (mode "fixture" or "abort"), and
rpc_fixture.allowed(url, origin) in a suite's own-origin request check.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from playwright.sync_api import Browser, BrowserContext, Route

RPC_ORIGINS = ("https://ethereum-rpc.publicnode.com", "https://eth.drpc.org")
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "eth_mainnet.json").read_text())
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
REPLAY_BLOCK = 13_180_202


def allowed(url: str, origin: str, page_url: str = "app.html") -> bool:
    """True for a request a page may make: its own origin, data/blob URLs, and (from app.html only) the two RPC nodes."""
    if url.startswith(origin) or url.startswith(("data:", "blob:", "mailto:")):
        return True
    return url.startswith(RPC_ORIGINS) and "app.html" in page_url


def _answer(req: dict[str, Any]) -> dict[str, Any]:
    method, params, rid = req.get("method"), req.get("params") or [], req.get("id")
    if method == "eth_blockNumber":
        return {"jsonrpc": "2.0", "id": rid, "result": FIXTURE["transfer_window"][1]}
    if method == "eth_getBlockByNumber":
        key = FIXTURE["transfer_window"][1] if params[0] == "latest" else params[0]
        return {"jsonrpc": "2.0", "id": rid, "result": FIXTURE["blocks"].get(key)}
    if method == "eth_getLogs":
        f = params[0]
        lo, hi = int(f["fromBlock"], 16), int(f["toBlock"], 16)
        topics0 = f["topics"][0]
        freeze_only = isinstance(topics0, list) and TRANSFER not in topics0
        pool = FIXTURE["replay"] if lo == REPLAY_BLOCK else FIXTURE["freezes"] if freeze_only else FIXTURE["logs"] + FIXTURE["freezes"]
        return {"jsonrpc": "2.0", "id": rid, "result": [log for log in pool if lo <= int(log["blockNumber"], 16) <= hi]}
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "method not found"}}


def _handle(route: Route) -> None:
    req = route.request
    if req.method == "OPTIONS":
        route.fulfill(status=204, headers={"access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST"})
        return
    body = json.loads(req.post_data or "null")
    out = [_answer(r) for r in body] if isinstance(body, list) else _answer(body)
    route.fulfill(status=200, headers={"access-control-allow-origin": "*", "content-type": "application/json"}, body=json.dumps(out))


def install(ctx: BrowserContext, mode: str = "fixture") -> None:
    """Routes both RPC origins: "fixture" answers from the recording, "abort" fails every request."""
    for origin in RPC_ORIGINS:
        ctx.route(f"{origin}/**", _handle if mode == "fixture" else (lambda route: route.abort()))
        ctx.route(origin, _handle if mode == "fixture" else (lambda route: route.abort()))


def patch(browser: Browser, mode: str = "fixture") -> Browser:
    """Makes every context and page this browser opens use install(mode)."""
    new_context = browser.new_context

    def ctx_with_route(*args: Any, **kwargs: Any) -> BrowserContext:
        ctx = new_context(*args, **kwargs)
        install(ctx, mode)
        return ctx

    def page_with_route(*args: Any, **kwargs: Any):
        ctx = ctx_with_route(*args, **kwargs)
        return ctx.new_page()

    browser.new_context = ctx_with_route  # type: ignore[method-assign]
    browser.new_page = page_with_route  # type: ignore[method-assign]
    return browser
