// Live chain: log decoding, screening, signing and the RPC loop, on mainnet logs recorded to
// tests/fixtures/eth_mainnet.json. No network. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspace } from '../js/ws/session.js';
import { ChainWatcher, decodeLog, ENDPOINTS, formatUnits, REPLAY, rpcCall, screenTransfer, TOPICS } from '../js/ws/chain.js';
import { verifyText } from '../js/verifier.js';

const list = JSON.parse(await readFile(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8'));
const fx = JSON.parse(await readFile(new URL('./fixtures/eth_mainnet.json', import.meta.url), 'utf8'));
const ANCHOR = new Date('2026-11-09T18:00:00.000Z');
const real = async () => (await createWorkspace({ list, anchor: ANCHOR })).ws.versions.find((v) => v.real);

/** A fake fetch that answers JSON-RPC from the fixture, like the public endpoints do. */
function fixtureFetch({ fail = 0, status = 200 } = {}) {
  let failures = fail;
  const calls = [];
  const answer = (req) => {
    const p = req.params?.[0];
    if (req.method === 'eth_getBlockByNumber') {
      const key = req.params[0] === 'latest' ? fx.transfer_window[1] : req.params[0];
      const blk = fx.blocks[key];
      return blk ? { jsonrpc: '2.0', id: req.id, result: blk } : { jsonrpc: '2.0', id: req.id, result: null };
    }
    if (req.method === 'eth_getLogs') {
      const from = Number.parseInt(p.fromBlock, 16);
      const to = Number.parseInt(p.toBlock, 16);
      const freezeOnly = Array.isArray(p.topics[0]) && !p.topics[0].includes(TOPICS.transfer);
      const pool = Number.parseInt(p.fromBlock, 16) === REPLAY.block ? fx.replay : freezeOnly ? fx.freezes : [...fx.logs, ...fx.freezes];
      return { jsonrpc: '2.0', id: req.id, result: pool.filter((l) => { const b = Number.parseInt(l.blockNumber, 16); return b >= from && b <= to; }) };
    }
    return { jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } };
  };
  const impl = async (url, init) => {
    calls.push(url);
    if (failures > 0) { failures--; throw new TypeError('Failed to fetch'); }
    const body = JSON.parse(init.body);
    const out = Array.isArray(body) ? body.map(answer) : answer(body);
    return { ok: status === 200, status, json: async () => out };
  };
  impl.calls = calls;
  return impl;
}

test('chain: decodes every recorded USDC and USDT Transfer log, amounts exact', () => {
  const decoded = fx.logs.map(decodeLog);
  assert.equal(decoded.filter((d) => d?.kind === 'transfer').length, fx.logs.length, 'every recorded log is a transfer');
  for (const [i, d] of decoded.entries()) {
    assert.match(d.from, /^0x[0-9a-f]{40}$/);
    assert.match(d.to, /^0x[0-9a-f]{40}$/);
    assert.equal(d.raw, BigInt(fx.logs[i].data));
    assert.ok(['USDC', 'USDT'].includes(d.symbol));
    assert.equal(formatUnits(d.raw), (() => { const s = d.raw.toString().padStart(7, '0'); const f = s.slice(-6).replace(/0+$/, ''); return f ? `${BigInt(s.slice(0, -6))}.${f}` : String(BigInt(s.slice(0, -6))); })());
    assert.ok(Math.abs(d.amount - Number(formatUnits(d.raw))) < 1e-6);
  }
  assert.equal(formatUnits(1_000_000n), '1');
  assert.equal(formatUnits(1_500_000n), '1.5');
  assert.equal(formatUnits(1n), '0.000001');
});

test('chain: decodes freeze events from both issuers, USDT address from the data word', () => {
  const decoded = fx.freezes.map(decodeLog);
  assert.equal(decoded.length, fx.freezes.length);
  assert.ok(decoded.every((d) => d && ['freeze', 'unfreeze'].includes(d.kind) && /^0x[0-9a-f]{40}$/.test(d.address)));
  for (const [i, d] of decoded.entries()) {
    const log = fx.freezes[i];
    if (d.symbol === 'USDT') assert.equal(d.address, `0x${log.data.slice(-40)}`.toLowerCase());
    else assert.equal(d.address, `0x${log.topics[1].slice(-40)}`.toLowerCase());
  }
});

test('chain: rejects logs it does not follow or that are malformed', () => {
  const t = fx.logs[0];
  assert.equal(decodeLog({ ...t, address: '0x0000000000000000000000000000000000000001' }), null, 'other contract');
  assert.equal(decodeLog({ ...t, topics: [TOPICS.transfer, t.topics[1]] }), null, 'missing topic');
  assert.equal(decodeLog({ ...t, data: '0x12' }), null, 'short data');
  assert.equal(decodeLog({ ...t, removed: true }), null, 'reorged out');
  assert.equal(decodeLog({ ...t, topics: ['0xdeadbeef'] }), null, 'unknown event');
  assert.equal(decodeLog(null), null);
});

test('chain: screening is exact match on sender and receiver; the replay transfer is a real hit', async () => {
  const version = await real();
  const replay = decodeLog(fx.replay[0]);
  assert.equal(replay.to, REPLAY.to);
  assert.equal(replay.block, REPLAY.block);
  const hit = screenTransfer(version, replay);
  assert.equal(hit.outcome, 'BLOCK');
  assert.match(hit.toMatches[0].name, /SEMENOV/);
  assert.deepEqual(hit.reasons, [`sanctions_hit=SDN-${hit.toMatches[0].uid}-${hit.toMatches[0].chain}:to`]);
  const reversed = screenTransfer(version, { ...replay, from: replay.to, to: replay.from });
  assert.equal(reversed.outcome, 'BLOCK', 'a listed sender is a hit too');
  assert.equal(screenTransfer(version, { ...replay, to: replay.to.toUpperCase().replace('0X', '0x') }).outcome, 'BLOCK', 'case does not matter');
  const clean = fx.logs.map(decodeLog).map((d) => screenTransfer(version, d));
  assert.ok(clean.every((s) => s.reasons.length >= 1));
});

test('chain: a poll screens and signs every transfer in the window, and the window verifies', async () => {
  const version = await real();
  const fetchImpl = fixtureFetch();
  const w = new ChainWatcher({ version, fetchImpl, schedule: () => 0, cancel: () => {} });
  const wait = await w.tick();
  assert.equal(w.state, 'live');
  assert.ok(wait >= 10_000, 'next poll is rate limited');
  const head = Number.parseInt(fx.transfer_window[1], 16);
  assert.equal(w.head, head);
  // The first poll reads the head block only (it starts from the block before the head).
  const expected = fx.logs.filter((l) => Number.parseInt(l.blockNumber, 16) === head).length;
  assert.ok(expected > 50, `the recorded head block has ${expected} transfers`);
  assert.equal(w.totals.transfers, expected);
  assert.equal(w.transfers.length, expected);
  assert.ok(w.transfers.every((r) => r.receiptId.startsWith('rcpt:c') && r.receipt.action.params.tx_hash === r.tx));
  assert.equal(w.totals.hits, w.transfers.filter((r) => r.outcome === 'BLOCK').length);
  assert.equal(w.backfill.state, 'done');
  assert.equal(w.backfill.found, fx.freezes.length);
  assert.ok(w.freezes.every((f) => typeof f.listed === 'boolean' && f.t !== null));
  const result = await w.verify();
  assert.ok(result.ok, 'the rolling ledger verifies with the real verifier');
  // A second poll with no new block adds nothing.
  await w.tick();
  assert.equal(w.totals.transfers, expected);
  // Every segment is a receipts file the page verifier accepts.
  for (let i = 0; i < w.ledger.segments.length; i++) assert.equal((await verifyText(w.ledger.segmentText(i))).kind, 'pass');
});

test('chain: the ledger rolls at its cap and keeps verifying', async () => {
  const version = await real();
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, maxReceipts: 50 });
  await w.tick();
  assert.ok(w.ledger.size <= 50);
  assert.ok(w.epoch >= 2);
  assert.ok((await w.verify()).ok);
});

test('chain: errors back off, switch to the fallback endpoint and recover', async () => {
  const version = await real();
  const fetchImpl = fixtureFetch({ fail: 2 });
  const w = new ChainWatcher({ version, fetchImpl, schedule: () => 0, cancel: () => {} });
  const first = await w.tick();
  assert.equal(w.state, 'retrying');
  assert.equal(first, 3000);
  const second = await w.tick();
  assert.equal(second, 6000, 'backoff doubles');
  assert.equal(w.endpoint.host, ENDPOINTS[1].host, 'switched to the fallback after two failures');
  await w.tick();
  assert.equal(w.state, 'live');
  assert.ok(fetchImpl.calls.at(-1).startsWith(ENDPOINTS[1].url));
  assert.equal(w.failures, 0);
});

test('chain: rate limits and RPC errors are reported, never thrown at the page', async () => {
  const version = await real();
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch({ status: 429 }), schedule: () => 0, cancel: () => {} });
  await w.tick();
  assert.equal(w.state, 'retrying');
  assert.match(w.message, /rate limited/);
  await assert.rejects(rpcCall(fixtureFetch(), ENDPOINTS[0], { method: 'eth_nothing', params: [] }), /method not found/);
});

test('chain: replay fetches the historical transfer, labels it and signs a hit', async () => {
  const version = await real();
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {} });
  const r = await w.replay();
  assert.equal(r.source, 'historical_replay');
  assert.equal(r.outcome, 'BLOCK');
  assert.equal(r.receipt.action.params.source, 'historical_replay');
  assert.equal(r.receipt.verdict.decision, 'DENY');
  assert.equal(w.totals.hits, 0, 'a replay is not counted as a live hit');
  assert.ok((await w.verify()).ok);
});

test('chain: hidden tab pauses polling, showing it resumes', async () => {
  const version = await real();
  const scheduled = [];
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: (fn, ms) => { scheduled.push(ms); return scheduled.length; }, cancel: () => {} });
  w.start();
  assert.equal(scheduled.length, 1);
  w.setHidden(true);
  assert.equal(w.state, 'paused');
  w.setHidden(false);
  assert.equal(scheduled.length, 2, 'resumes with a new poll');
  w.stop();
  assert.equal(w.state, 'idle');
});
