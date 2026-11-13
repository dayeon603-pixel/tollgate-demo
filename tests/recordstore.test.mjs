// Saved records: dedupe, the 20,000-record ring, minute-to-hour compaction, hits kept forever, the quota
// error path, the no-IndexedDB fallback, reload, and the CSV. Uses a small in-memory IndexedDB so the real
// transaction code runs. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, COMPACT_AFTER_MS, CSV_HEADER, MAX_RECORDS, MemoryBackend, NOTICES, RecordStore, SOURCE_LIVE, SOURCE_REPLAY } from '../js/ws/recordstore.js';
import { parseCsv } from '../js/ws/util.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '../js/ws/timerange.js';

// ---- a minimal IndexedDB: object stores with keyPath, one index, transactions that roll back on abort ----

function fakeIndexedDB({ openError = null } = {}) {
  const databases = new Map();
  const control = { quota: null, putCalls: 0 }; // quota: 'abort' | 'throw' | null
  const factory = {
    control,
    databases,
    open(name) {
      if (openError === 'throw') throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' });
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      setTimeout(() => {
        if (openError === 'error') { req.error = Object.assign(new Error('blocked'), { name: 'UnknownError' }); req.onerror?.(); return; }
        let db = databases.get(name);
        const fresh = !db;
        if (fresh) { db = makeDb(); databases.set(name, db); }
        req.result = db;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      }, 0);
      return req;
    },
  };

  function makeDb() {
    const stores = new Map();
    return {
      stores,
      createObjectStore(name, { keyPath }) {
        const store = { keyPath, rows: new Map(), indexes: new Map() };
        stores.set(name, store);
        return { createIndex: (index, path) => store.indexes.set(index, path) };
      },
      transaction(names, mode) {
        const snapshot = new Map(names.map((n) => [n, new Map(stores.get(n).rows)]));
        const tx = { oncomplete: null, onabort: null, onerror: null, error: null, aborted: false, finished: false };
        let pending = 0;
        const settle = () => {
          if (tx.finished) return;
          setTimeout(() => {
            if (tx.finished || pending > 0) return;
            tx.finished = true;
            tx.oncomplete?.();
          }, 0);
        };
        const abort = (error) => {
          if (tx.finished) return;
          tx.aborted = true; tx.finished = true; tx.error = error;
          for (const [n, rows] of snapshot) stores.get(n).rows = rows;
          setTimeout(() => tx.onabort?.(), 0);
        };
        tx.abort = () => abort(tx.error ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
        const request = (compute) => {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null };
          pending++;
          setTimeout(() => {
            if (tx.aborted) return;
            req.result = compute();
            pending--;
            req.onsuccess?.();
            settle();
          }, 0);
          return req;
        };
        const sorted = (store, path) => [...store.rows.values()].sort((a, b) => a[path] - b[path]);
        tx.objectStore = (name) => {
          const store = stores.get(name);
          const write = (fn) => {
            if (mode !== 'readwrite') throw Object.assign(new Error('read-only'), { name: 'ReadOnlyError' });
            control.putCalls++;
            if (control.quota === 'throw') throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
            if (control.quota === 'abort') {
              pending++;
              setTimeout(() => { pending--; abort(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })); }, 0);
              return { result: undefined };
            }
            return request(fn);
          };
          return {
            put: (value) => write(() => { store.rows.set(value[store.keyPath], structuredClone(value)); return value[store.keyPath]; }),
            delete: (key) => write(() => { store.rows.delete(key); }),
            clear: () => write(() => { store.rows.clear(); }),
            getAll: () => request(() => [...store.rows.values()].map((v) => structuredClone(v))),
            getAllKeys: () => request(() => [...store.rows.keys()]),
            index: (index) => {
              const path = store.indexes.get(index);
              return { getAll: () => request(() => sorted(store, path).map((v) => structuredClone(v))), getAllKeys: () => request(() => sorted(store, path).map((v) => v[store.keyPath])) };
            },
          };
        };
        settle();
        return tx;
      },
    };
  }
  return factory;
}

// ---- fixtures ----

const T0 = Date.parse('2026-11-13T14:03:12.481Z');
let counter = 0;
const rec = (over = {}) => {
  counter++;
  const tx = `0x${counter.toString(16).padStart(64, '0')}`;
  return {
    key: `${tx}:${over.log_index ?? 0}`, source: SOURCE_LIVE, block: 24_000_000 + counter, tx, log_index: 0, token: 'USDC', token_contract: '0xa0b8', from: '0xfrom', to: '0xto',
    amount: '10.5', outcome: 'ALLOW', receipt_id: `rcpt:c${counter}`, receipt_hash: `h${counter}`, block_time: '2026-11-13T14:03:12Z', screened_at: '2026-11-13T14:03:12.481Z', ...over,
  };
};
const hit = (over = {}) => rec({ outcome: 'BLOCK', receipt: { receipt_id: 'x', this_hash: 'abc', action: { params: { screened_at: '2026-11-13T14:03:12.481Z' } } }, list_matches: ['SEMENOV (UID 1)'], ...over });
const freeze = (n, over = {}) => ({ key: `0xf${n}:0`, kind: 'freeze', source: 'live', token: 'USDC', token_contract: '0xa0b8', address: '0xaddr', block: 100 + n, tx: `0xf${n}`, log_index: 0, block_time: '2026-11-13T14:00:00Z', observed_at: '2026-11-13T14:03:12.481Z', listed: false, list_matches: [], receipt: null, ...over });
const batch = (records = [], over = {}) => ({ at: T0, cover: true, blocks: [{ block: 24_000_001, n: records.length, hits: 0, usd: 0 }], records, freezes: [], ...over });
const open = async (factory, extra = {}) => { const s = new RecordStore({ indexedDB: factory, now: () => T0, openTimeoutMs: 500, ...extra }); await s.ready; return s; };

test('store: records survive a reload (new store on the same database)', async () => {
  const idb = fakeIndexedDB();
  const a = await open(idb);
  assert.equal(a.state, 'indexeddb');
  assert.equal(a.notice, '');
  await a.ingest(batch([rec(), rec(), hit()], { blocks: [{ block: 24_000_001, n: 2, hits: 0, usd: 21 }, { block: 24_000_002, n: 1, hits: 1, usd: 10.5 }], freezes: [freeze(1)] }));
  const before = a.summary();
  assert.equal(before.transfers, 3);
  assert.equal(before.hits, 1);
  assert.equal(before.allow, 2);
  assert.equal(before.blocks, 2);
  assert.equal(before.minutesRecorded, 1);
  assert.equal(before.firstRecordAt, Math.floor(T0 / MINUTE_MS) * MINUTE_MS);
  assert.equal(before.records, 3);
  assert.equal(before.hitRows, 1);
  assert.equal(before.freezeRows, 1);
  const b = await open(idb);
  const after = b.summary();
  for (const key of ['transfers', 'hits', 'allow', 'blocks', 'minutesRecorded', 'firstRecordAt', 'records', 'hitRows', 'freezeRows']) assert.equal(after[key], before[key], key);
  assert.ok(Math.abs(after.usd - before.usd) < 1e-9);
  const all = await b.readAll();
  assert.equal(all.records.length, 3);
  assert.equal(all.hits[0].receipt.this_hash, 'abc', 'the hit keeps its full signed receipt');
  assert.equal(all.freezes[0].receipt, null);
  // The bucket's first and last block survive.
  const bucket = b.series().buckets[0];
  assert.equal(bucket.minutes, 1);
  assert.deepEqual(bucket.values, { clear: 2, hit: 1, usd: 31.5 });
});

test('store: dedupes by tx:logIndex, in the ring, the counts and the hit rows', async () => {
  const s = await open(fakeIndexedDB());
  const r = rec();
  const h = hit();
  await s.ingest(batch([r, h]));
  await s.ingest(batch([r, h, { ...r }]));
  const t = s.summary();
  assert.equal(t.records, 2);
  assert.equal(t.transfers, 2, 'a transfer seen twice is counted once');
  assert.equal(t.hitRows, 1);
  // Same transaction, different log index, is a different transfer.
  await s.ingest(batch([rec({ tx: r.tx, key: `${r.tx}:1`, log_index: 1 })]));
  assert.equal(s.summary().records, 3);
  // Freeze events dedupe too, across a reload.
  const idb = fakeIndexedDB();
  const a = await open(idb);
  await a.ingest(batch([], { freezes: [freeze(1), freeze(1), freeze(2)] }));
  assert.equal(a.summary().freezeRows, 2);
  const b = await open(idb);
  await b.ingest(batch([], { freezes: [freeze(1)] }));
  assert.equal(b.summary().freezeRows, 2, 'a backfill that re-reads a saved freeze adds nothing');
});

test('store: the ring keeps the most recent maxRecords and evicts the oldest, in storage too', async () => {
  assert.equal(MAX_RECORDS, 20_000);
  const idb = fakeIndexedDB();
  const s = await open(idb, { maxRecords: 5 });
  const made = Array.from({ length: 8 }, () => rec());
  await s.ingest(batch(made.slice(0, 3)));
  await s.ingest(batch(made.slice(3)));
  assert.equal(s.summary().records, 5);
  assert.equal(s.summary().transfers, 8, 'the counts keep every transfer; only the full rows are capped');
  const stored = await s.readAll();
  assert.deepEqual(stored.records.map((r) => r.key), made.slice(3).map((r) => r.key), 'the newest five, oldest first');
  const again = await open(idb, { maxRecords: 5 });
  assert.equal(again.summary().records, 5);
  await again.ingest(batch([rec()]));
  assert.deepEqual((await again.readAll()).records.map((r) => r.key).slice(0, 4), made.slice(4).map((r) => r.key), 'eviction continues across a reload');
  assert.equal(again.summary().records, 5);
  // An evicted transfer seen again is not "new" while its key is still in the ring.
  await again.ingest(batch([made[7]]));
  assert.equal(again.summary().transfers, 9);
});

test('store: minute buckets older than 7 days become hour buckets that keep the minutes recorded', async () => {
  const idb = fakeIndexedDB();
  const s = await open(idb);
  const old = Date.parse('2026-11-01T10:00:00Z');
  for (const minute of [0, 1, 2, 30]) await s.ingest(batch([rec(), rec()], { at: old + minute * MINUTE_MS + 250 }));
  await s.ingest(batch([hit()], { at: old + 61 * MINUTE_MS })); // the next hour
  assert.equal(s.summary().minutesRecorded, 5);
  assert.equal(s.series().buckets.filter((b) => b.span === MINUTE_MS).length, 5, 'still minute buckets: not yet 7 days old');
  const now = old + 8 * DAY_MS;
  await s.ingest(batch([rec()], { at: now }));
  const { buckets } = s.series();
  const hours = buckets.filter((b) => b.span === HOUR_MS);
  assert.equal(hours.length, 2, 'both old hours were compacted');
  assert.equal(hours[0].t, old);
  assert.equal(hours[0].minutes, 4, 'four minutes of that hour were recorded');
  assert.deepEqual(hours[0].values, { clear: 8, hit: 0, usd: 8 * 10.5 });
  assert.equal(hours[1].minutes, 1);
  assert.equal(hours[1].values.hit, 1);
  assert.equal(buckets.filter((b) => b.span === MINUTE_MS).length, 1, 'only the recent minute is left');
  const t = s.summary();
  assert.equal(t.minutesRecorded, 6, 'coverage is kept as a count of minutes recorded');
  assert.equal(t.transfers, 10, 'four minutes of two, one hit, one new: totals unchanged by compaction');
  // Persisted: reopen and the same shape comes back, with the minute rows gone from storage.
  const again = await open(idb);
  assert.equal(again.series().buckets.filter((b) => b.span === HOUR_MS).length, 2);
  assert.equal(again.summary().minutesRecorded, 6);
  assert.equal([...idb.databases.values()][0].stores.get('minutes').rows.size, 1);
  assert.equal(again.summary().firstRecordAt, old, 'the first record time survives compaction');
  // Compaction waits for the whole hour to be old enough: a minute 6 days 23 hours old stays a minute.
  assert.equal(COMPACT_AFTER_MS, 7 * DAY_MS);
});

test('store: compaction never splits an hour that is only partly old', async () => {
  const s = await open(fakeIndexedDB());
  const hour = Date.parse('2026-11-01T10:00:00Z');
  await s.ingest(batch([], { at: hour + 5 * MINUTE_MS }));
  // 7 days and 30 minutes later the 10:00 hour is not wholly older than 7 days yet: it stays a minute bucket.
  await s.ingest(batch([], { at: hour + 7 * DAY_MS + 30 * MINUTE_MS }));
  assert.ok(s.series().buckets.some((b) => b.t === hour + 5 * MINUTE_MS && b.span === MINUTE_MS), 'the 10:05 minute is still a minute');
  await s.ingest(batch([], { at: hour + 7 * DAY_MS + HOUR_MS + 2 * MINUTE_MS }));
  const hours = s.series().buckets.filter((b) => b.span === HOUR_MS);
  assert.equal(hours.length, 1);
  assert.equal(hours[0].t, hour);
  assert.equal(hours[0].minutes, 1);
  assert.ok(!s.series().buckets.some((b) => b.t === hour + 5 * MINUTE_MS && b.span === MINUTE_MS), 'and now it is folded away');
});

test('store: every hit and every issuer event is kept after the ring has dropped its transfer', async () => {
  const idb = fakeIndexedDB();
  const s = await open(idb, { maxRecords: 3 });
  const h = hit();
  await s.ingest(batch([h], { freezes: [freeze(1), freeze(2, { kind: 'unfreeze' })] }));
  await s.ingest(batch(Array.from({ length: 6 }, () => rec())));
  const all = await s.readAll();
  assert.equal(all.records.length, 3);
  assert.ok(!all.records.some((r) => r.key === h.key), 'the hit left the ring');
  assert.equal(all.hits.length, 1, 'but it is still a saved hit');
  assert.equal(all.hits[0].receipt.this_hash, 'abc');
  assert.deepEqual(all.freezes.map((f) => f.kind).sort(), ['freeze', 'unfreeze']);
  const csv = parseCsv(await s.exportCsv());
  const col = Object.fromEntries(csv[0].map((name, i) => [name, i]));
  const rows = csv.slice(1);
  assert.ok(rows.some((r) => r[col.record_type] === 'hit' && r[col.tx_hash] === h.tx && JSON.parse(r[col.receipt_json]).this_hash === 'abc'), 'the export has the hit and its receipt');
  assert.equal(rows.filter((r) => r[col.record_type] === 'freeze' || r[col.record_type] === 'unfreeze').length, 2);
  // Reload: still there.
  const again = await open(idb, { maxRecords: 3 });
  assert.equal(again.summary().hitRows, 1);
  assert.equal(again.summary().freezeRows, 2);
});

test('store: replayed records are stored labelled and left out of every live count', async () => {
  const s = await open(fakeIndexedDB());
  const replayed = hit({ source: SOURCE_REPLAY, block: 13_180_202 });
  await s.ingest({ at: T0, cover: false, records: [replayed] });
  let t = s.summary();
  assert.equal(t.transfers, 0);
  assert.equal(t.hits, 0);
  assert.equal(t.minutesRecorded, 0, 'a replay is not recording');
  assert.equal(t.firstRecordAt, null);
  assert.equal(t.replayRows, 1);
  assert.equal(t.records, 1);
  assert.equal(t.hitRows, 1);
  // Even inside a covered batch a replay does not count as live.
  await s.ingest(batch([rec(), hit({ source: SOURCE_REPLAY })]));
  t = s.summary();
  assert.equal(t.transfers, 1);
  assert.equal(t.hits, 0);
  assert.equal(t.minutesRecorded, 1);
  const all = await s.readAll();
  assert.equal(all.records.filter((r) => r.source === SOURCE_REPLAY).length, 2);
  assert.equal(all.hits.filter((x) => x.source === SOURCE_REPLAY).length, 2, 'replayed hits are labelled replay too');
  assert.equal(all.records.filter((r) => r.source === SOURCE_LIVE).length, 1);
});

test('store: coverage counts minutes the page recorded, with or without transfers; backfilled events are not coverage', async () => {
  const s = await open(fakeIndexedDB());
  await s.ingest({ at: T0, cover: true }); // a heartbeat: no new block this poll
  await s.ingest({ at: T0 + 5 * MINUTE_MS, cover: true, blocks: [{ block: 5, n: 0, hits: 0, usd: 0 }] });
  await s.ingest({ at: T0 + 10 * MINUTE_MS, cover: false, freezes: [freeze(9)] });
  const t = s.summary();
  assert.equal(t.minutesRecorded, 2);
  assert.equal(t.transfers, 0);
  assert.equal(t.freezeRows, 1);
  assert.deepEqual(s.series().buckets.map((b) => b.values.clear), [0, 0], 'a recorded minute with no transfers is a real zero');
});

test('store: a quota error keeps the page running, shows a notice, and retries the unsaved batch', async () => {
  const idb = fakeIndexedDB();
  const s = await open(idb);
  await s.ingest(batch([rec()]));
  idb.control.quota = 'abort';
  await s.ingest(batch([rec(), hit()], { at: T0 + 2 * MINUTE_MS }));
  assert.equal(s.noticeKind, 'quota');
  assert.equal(s.notice, NOTICES.quota);
  assert.equal(s.state, 'indexeddb', 'still trying to save');
  let t = s.summary();
  assert.equal(t.transfers, 3, 'the counts keep going from memory');
  assert.ok(t.unsaved >= 3, 'the unsaved rows are kept');
  const stillThere = await s.readAll();
  assert.equal(stillThere.records.length, 3, 'an export includes what could not be saved');
  assert.equal(stillThere.hits.length, 1);
  // A second failure (a thrown quota error, as some browsers do) is handled the same way.
  idb.control.quota = 'throw';
  await s.ingest(batch([rec()], { at: T0 + 3 * MINUTE_MS }));
  assert.equal(s.noticeKind, 'quota');
  // Space is freed: the next batch saves everything that was waiting.
  idb.control.quota = null;
  await s.ingest(batch([rec()], { at: T0 + 4 * MINUTE_MS }));
  assert.equal(s.noticeKind, '');
  assert.equal(s.notice, '');
  assert.equal(s.summary().unsaved, 0);
  const again = await open(idb);
  assert.equal(again.summary().records, 5);
  assert.equal(again.summary().hitRows, 1);
  assert.equal(again.summary().minutesRecorded, 4);
  // The failed transaction rolled back whole: no half-written batch.
  assert.equal(again.summary().transfers, 5);
});

test('store: no IndexedDB (private mode) runs from memory with a visible notice; so does a blocked or failing open', async () => {
  for (const factory of [undefined, null, fakeIndexedDB({ openError: 'throw' }), fakeIndexedDB({ openError: 'error' })]) {
    const s = new RecordStore({ indexedDB: factory, now: () => T0, openTimeoutMs: 200 });
    await s.ready;
    assert.equal(s.state, 'memory');
    assert.equal(s.noticeKind, 'unavailable');
    assert.equal(s.notice, NOTICES.unavailable);
    await s.ingest(batch([rec(), hit()], { freezes: [freeze(1)] }));
    const t = s.summary();
    assert.equal(t.transfers, 2);
    assert.equal(t.hitRows, 1);
    assert.equal(t.state, 'memory');
    assert.equal((await s.readAll()).hits.length, 1, 'export still works');
    assert.ok(t.notice.length > 0);
  }
  // An open that never answers gives up after the timeout.
  const hang = { open: () => ({ result: null, onsuccess: null, onerror: null, onupgradeneeded: null }) };
  const s = new RecordStore({ indexedDB: hang, openTimeoutMs: 20 });
  await s.ready;
  assert.equal(s.state, 'memory');
});

test('store: clear erases storage and memory, and the page keeps recording afterwards', async () => {
  const idb = fakeIndexedDB();
  const s = await open(idb);
  await s.ingest(batch([rec(), hit()], { freezes: [freeze(1)] }));
  assert.equal(await s.clear(), true);
  const t = s.summary();
  assert.equal(t.transfers, 0);
  assert.equal(t.records, 0);
  assert.equal(t.hitRows, 0);
  assert.equal(t.firstRecordAt, null);
  const again = await open(idb);
  assert.equal(again.summary().records, 0);
  assert.equal(again.summary().minutesRecorded, 0);
  await s.ingest(batch([rec()]));
  assert.equal(s.summary().transfers, 1);
});

test('store: batches are queued in order and ingest never rejects', async () => {
  const s = new RecordStore({ backend: new MemoryBackend(), now: () => T0 });
  const order = [];
  const done = [1, 2, 3].map((n) => s.ingest(batch([rec()], { at: T0 + n * MINUTE_MS })).then(() => order.push(n)));
  await Promise.all(done);
  assert.deepEqual(order, [1, 2, 3]);
  await assert.doesNotReject(s.ingest({ at: T0, records: [null] }), 'a malformed batch is logged, not thrown');
  await assert.doesNotReject(s.ingest(undefined));
});

test('csv: block_time to the second, screened_at to the millisecond, UTC, one row per transfer, hits carry the receipt', async () => {
  const r = rec();
  const h = hit({ block_time: '2026-11-13T14:03:12Z', screened_at: '2026-11-13T14:03:12.481Z' });
  const text = buildCsv({ records: [{ ...r, seq: 1 }, { ...h, seq: 2 }], hits: [h], freezes: [freeze(1, { kind: 'unfreeze', listed: true, list_matches: ['A'] })] });
  const rows = parseCsv(text);
  assert.deepEqual(rows[0], CSV_HEADER);
  const col = Object.fromEntries(rows[0].map((name, i) => [name, i]));
  const body = rows.slice(1);
  assert.equal(body.length, 3, 'a hit still in the ring is one row, not two');
  for (const row of body.filter((x) => x[col.record_type] === 'transfer' || x[col.record_type] === 'hit')) {
    assert.match(row[col.block_time], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'block_time has seconds and no milliseconds');
    assert.match(row[col.screened_at], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'screened_at has milliseconds');
  }
  const hitRow = body.find((x) => x[col.record_type] === 'hit');
  assert.equal(JSON.parse(hitRow[col.receipt_json]).action.params.screened_at, '2026-11-13T14:03:12.481Z');
  assert.equal(hitRow[col.list_matches], 'SEMENOV (UID 1)');
  const freezeRow = body.find((x) => x[col.record_type] === 'unfreeze');
  assert.equal(freezeRow[col.on_list], 'yes');
  assert.equal(freezeRow[col.address], '0xaddr');
  assert.match(freezeRow[col.screened_at], /\.\d{3}Z$/, 'an issuer event is stamped with when this page saw it');
  // A spreadsheet must not read a cell as a formula.
  const evil = buildCsv({ records: [{ ...rec({ from: '=HYPERLINK("x")' }), seq: 1 }], hits: [], freezes: [] });
  assert.match(evil, /'=HYPERLINK/);
});
