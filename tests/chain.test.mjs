// Live chain: log decoding, screening, signing and the RPC loop, on mainnet logs recorded to
// tests/fixtures/eth_mainnet.json. No network. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspace } from '../js/ws/session.js';
import { ChainWatcher, decodeLog, ENDPOINTS, formatUnits, isoMillis, isoSeconds, receiptSpec, REPLAY, rpcCall, screenTransfer, storedFreeze, storedRecord, TOPICS } from '../js/ws/chain.js';
import { MemoryBackend, RecordStore } from '../js/ws/recordstore.js';
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
  // A hostile node controls every field: shapes outside the JSON-RPC spec are dropped, never signed.
  assert.equal(decodeLog({ ...t, transactionHash: '0x1234' }), null, 'short tx hash');
  assert.equal(decodeLog({ ...t, transactionHash: `${t.transactionHash.slice(0, -1)}"` }), null, 'tx hash with a quote');
  assert.equal(decodeLog({ ...t, blockNumber: 'latest' }), null, 'non-hex block');
  assert.equal(decodeLog({ ...t, logIndex: `0x${'f'.repeat(17)}` }), null, 'oversized log index');
  assert.equal(decodeLog({ ...t, topics: [...t.topics, t.topics[1], t.topics[1]] }), null, 'more than four topics');
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

// ---- time precision and saved records ----

const SCREENED_MS = Date.parse('2026-11-13T14:03:12.481Z');

test('chain: receiptSpec signs block_time (seconds, no milliseconds) and screened_at (milliseconds)', async () => {
  const version = await real();
  const transfer = decodeLog(fx.logs[0]);
  const screened = screenTransfer(version, transfer);
  const blockTime = isoSeconds(Date.parse('2026-11-13T14:03:00Z'));
  const spec = receiptSpec(transfer, screened, 'ethereum_mainnet', { blockTime, screenedAt: isoMillis(SCREENED_MS) });
  assert.equal(spec.params.block_time, '2026-11-13T14:03:00Z');
  assert.doesNotMatch(spec.params.block_time, /\.\d/, 'a block timestamp has one-second resolution: no invented milliseconds');
  assert.equal(spec.params.screened_at, '2026-11-13T14:03:12.481Z');
  assert.match(spec.params.screened_at, /\.\d{3}Z$/);
  assert.equal(isoSeconds(Date.parse('2026-11-13T14:03:12.999Z')), '2026-11-13T14:03:12Z', 'seconds are floored, never rounded up');
  assert.throws(() => receiptSpec(transfer, screened, 'ethereum_mainnet', { blockTime }), TypeError, 'no screened_at, no signature');
  assert.throws(() => receiptSpec(transfer, screened), TypeError);
  assert.equal(receiptSpec(transfer, screened, 'ethereum_mainnet', { screenedAt: isoMillis(SCREENED_MS) }).params.block_time, null, 'an unknown block time is null, not made up');
});

test('chain: every signed receipt carries both times, covered by the signature, and the window still verifies', async () => {
  const version = await real();
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, now: () => SCREENED_MS });
  await w.tick();
  const head = Number.parseInt(fx.transfer_window[1], 16);
  const headSeconds = Number.parseInt(fx.blocks[fx.transfer_window[1]].timestamp, 16);
  assert.ok(w.transfers.length > 50);
  for (const r of w.transfers) {
    assert.equal(r.screened_at, '2026-11-13T14:03:12.481Z');
    assert.equal(r.block_time, isoSeconds(headSeconds * 1000));
    assert.equal(r.receipt.action.params.screened_at, r.screened_at);
    assert.equal(r.receipt.action.params.block_time, r.block_time);
    assert.equal(r.block, head);
  }
  assert.ok((await w.verify()).ok);
  // Tamper with the decision time: the signature no longer matches.
  const text = w.ledger.segmentText(0).replace('2026-11-13T14:03:12.481Z', '2026-11-13T14:03:12.482Z');
  assert.notEqual((await verifyText(text)).kind, 'pass', 'screened_at is inside what the signature covers');
});

test('chain: screened_at comes from the injected clock at each decision', async () => {
  const version = await real();
  let t = SCREENED_MS;
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, now: () => t++ });
  await w.tick();
  const stamps = w.transfers.map((r) => Date.parse(r.screened_at));
  assert.ok(stamps.every((v, i) => i === 0 || v > stamps[i - 1]), 'each decision has its own millisecond');
});

test('chain: ingest saves to the record store, with live counts, hits, freezes and coverage', async () => {
  const version = await real();
  const store = new RecordStore({ backend: new MemoryBackend(), now: () => SCREENED_MS });
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, now: () => SCREENED_MS, store });
  await w.tick();
  await store.idle();
  const t = store.summary();
  assert.equal(t.transfers, w.totals.transfers);
  assert.equal(t.hits, w.totals.hits);
  assert.equal(t.allow, w.totals.transfers - w.totals.hits);
  assert.ok(Math.abs(t.usd - w.totals.usd) < 0.01);
  assert.equal(t.minutesRecorded, 1);
  assert.equal(t.records, Math.min(w.totals.transfers, 20_000));
  assert.equal(t.freezeRows, fx.freezes.length, 'the backfilled issuer events are saved');
  const all = await store.readAll();
  const sample = all.records[0];
  assert.deepEqual(Object.keys(sample).sort(), ['amount', 'block', 'block_time', 'from', 'key', 'log_index', 'outcome', 'receipt_hash', 'receipt_id', 'screened_at', 'seq', 'source', 'to', 'token', 'token_contract', 'tx'].sort());
  assert.match(sample.screened_at, /\.481Z$/);
  assert.doesNotMatch(sample.block_time, /\.\d/);
  assert.equal(sample.key, `${sample.tx}:${sample.log_index}`);
  // A second poll with no new block adds no transfers, but the minute was still recorded (a heartbeat).
  const later = new RecordStore({ backend: new MemoryBackend(), now: () => SCREENED_MS });
  const w2 = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, now: () => SCREENED_MS, store: later });
  await w2.tick();
  const n = w2.totals.transfers;
  w2.now = () => SCREENED_MS + 5 * 60_000;
  await w2.tick();
  await later.idle();
  assert.equal(later.summary().transfers, n);
  assert.equal(later.summary().minutesRecorded, 2, 'the quiet minute was recorded');
  // Stored shapes.
  const hitLog = fx.replay[0];
  const record = await w.replay();
  await store.idle();
  const stored = storedRecord(record);
  assert.equal(stored.source, 'historical_replay');
  assert.equal(stored.receipt.receipt_id, record.receipt.receipt_id);
  assert.match(stored.list_matches[0], /SEMENOV/);
  assert.equal(stored.log_index, decodeLog(hitLog).logIndex);
  assert.equal(store.summary().transfers, t.transfers, 'a replay is not a live transfer');
  assert.equal(store.summary().hits, t.hits);
  assert.equal(store.summary().replayRows, 1);
  assert.equal(store.summary().hitRows, t.hits + 1);
  const f = storedFreeze(w.freezes[0], SCREENED_MS);
  assert.equal(f.receipt, null);
  assert.equal(f.observed_at, '2026-11-13T14:03:12.481Z');
  assert.doesNotMatch(f.block_time, /\.\d/);
});

test('chain: a failing store never breaks polling', async () => {
  const version = await real();
  const bad = { ingest: () => Promise.resolve() };
  const w = new ChainWatcher({ version, fetchImpl: fixtureFetch(), schedule: () => 0, cancel: () => {}, store: bad });
  await w.tick();
  assert.equal(w.state, 'live');
});
