/**
 * Saved records for the Live chain: what the page screens survives a reload.
 *
 * Three kinds of record, in IndexedDB (database "tollgate-demo-records"):
 *   1. Coverage and counts. One bucket per minute in which the page was recording: { t, blocks,
 *      transfers, allow, hits, usd, firstBlock, lastBlock }. A bucket existing means that minute was
 *      recorded; a minute with no bucket was not (the history chart draws it as "not recording", not
 *      as zero transfers). Minute buckets older than 7 days are compacted into hour buckets, which
 *      keep the number of minutes that were recorded.
 *   2. Every hit (a BLOCK decision) with its full signed receipt, and every issuer freeze and unfreeze
 *      event, kept indefinitely. A freeze is something the issuer did, not a Tollgate decision, so it
 *      has no receipt of its own (receipt: null).
 *   3. The most recent 20,000 full transfer records (a ring), deduplicated by `${tx}:${logIndex}`.
 *
 * Time precision. `block_time` is the chain's own timestamp: ISO, one-second resolution, no invented
 * milliseconds. `screened_at` is this page's clock at the moment of the decision, with milliseconds.
 * Buckets are keyed by the minute of `screened_at` (when the page was recording), not the block time.
 *
 * Writes are batched, one IndexedDB transaction per ingest, queued so they never run concurrently and
 * never block the caller. Every IndexedDB call is wrapped. If IndexedDB is missing or blocked (private
 * mode) the store runs from memory and says so (`notice`); if a write fails (quota) it keeps running,
 * keeps the unsaved batch to retry, and says so. Replayed historical records are stored with their
 * `historical_replay` source and are left out of every live count.
 *
 * Several tabs recording at once would overwrite each other's buckets (last write wins); the page
 * records from the tab that is open.
 */
import { createLogger } from './log.js';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './timerange.js';
import { toCsv } from './util.js';

const log = createLogger('records');

export const DB_NAME = 'tollgate-demo-records';
export const DB_VERSION = 1;
export const MAX_RECORDS = 20_000;
export const COMPACT_AFTER_MS = 7 * DAY_MS;
export const COMPACT_EVERY_MS = MINUTE_MS;
export const OPEN_TIMEOUT_MS = 4000;
export const MAX_PENDING_RECORDS = 5000;
export const SOURCE_LIVE = 'ethereum_mainnet';
export const SOURCE_REPLAY = 'historical_replay';
const STORE_NAMES = ['minutes', 'hours', 'hits', 'freezes', 'records', 'meta'];

export const NOTICES = Object.freeze({
  unavailable: 'This browser blocks saved records (IndexedDB is unavailable, as in a private window). Records are kept in memory only and are lost when this page closes or reloads.',
  quota: 'Browser storage is full. Recording continues, but new records are not saved until space is freed. Export or clear saved records to make room.',
  error: 'Saving records failed. Recording continues and the next block retries the save.',
});

/** Raised by the storage backends. kind: 'unavailable' | 'quota' | 'error'. */
export class StoreError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'StoreError';
    this.kind = kind;
  }
}

const isQuota = (error) => error?.name === 'QuotaExceededError' || error?.code === 22 || /quota/i.test(String(error?.message ?? ''));
const asStoreError = (error) => (error instanceof StoreError ? error : new StoreError(isQuota(error) ? 'quota' : 'error', String(error?.message ?? error?.name ?? 'storage error')));

// ---- IndexedDB plumbing ---------------------------------------------------------------------

const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error ?? new Error('request failed')); });
const txDone = (tx) => {
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => { /* the abort that follows carries the error */ };
  });
  done.catch(() => {}); // the caller awaits it; this keeps an early failure from being reported as unhandled
  return done;
};

function openDb(factory, name, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => finish(reject, new StoreError('unavailable', 'opening the database timed out')), timeoutMs);
    let req;
    try {
      req = factory.open(name, DB_VERSION);
    } catch (error) {
      finish(reject, new StoreError('unavailable', String(error?.message ?? error?.name)));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of ['minutes', 'hours']) db.createObjectStore(store, { keyPath: 't' });
      for (const store of ['hits', 'freezes']) db.createObjectStore(store, { keyPath: 'key' });
      db.createObjectStore('records', { keyPath: 'key' }).createIndex('seq', 'seq');
      db.createObjectStore('meta', { keyPath: 'k' });
    };
    req.onsuccess = () => finish(resolve, req.result);
    req.onerror = () => finish(reject, new StoreError('unavailable', String(req.error?.message ?? req.error?.name ?? 'open failed')));
    req.onblocked = () => finish(reject, new StoreError('unavailable', 'the database is blocked by another tab'));
  });
}

/** What a commit changes. Later writes to the same key win, and a delete cancels an earlier put. */
export class OpSet {
  constructor() {
    this.putMinutes = new Map(); this.deleteMinutes = new Set();
    this.putHours = new Map();
    this.putHits = new Map(); this.putFreezes = new Map();
    this.putRecords = new Map(); this.deleteRecords = new Set();
    this.meta = new Map();
  }

  get empty() {
    return ![this.putMinutes, this.deleteMinutes, this.putHours, this.putHits, this.putFreezes, this.putRecords, this.deleteRecords, this.meta].some((c) => c.size);
  }

  putMinute(bucket) { this.deleteMinutes.delete(bucket.t); this.putMinutes.set(bucket.t, { ...bucket }); }
  deleteMinute(t) { this.putMinutes.delete(t); this.deleteMinutes.add(t); }
  putRecord(record) { this.deleteRecords.delete(record.key); this.putRecords.set(record.key, record); }
  deleteRecord(key) { this.putRecords.delete(key); this.deleteRecords.add(key); }

  /** Folds `other` (newer) into this set. */
  merge(other) {
    for (const b of other.putMinutes.values()) this.putMinute(b);
    for (const t of other.deleteMinutes) this.deleteMinute(t);
    for (const [t, b] of other.putHours) this.putHours.set(t, b);
    for (const [k, v] of other.putHits) this.putHits.set(k, v);
    for (const [k, v] of other.putFreezes) this.putFreezes.set(k, v);
    for (const r of other.putRecords.values()) this.putRecord(r);
    for (const k of other.deleteRecords) this.deleteRecord(k);
    for (const [k, v] of other.meta) this.meta.set(k, v);
    return this;
  }
}

/** Persistent backend: one transaction per commit. */
class IdbBackend {
  constructor(db) { this.db = db; this.kind = 'indexeddb'; }

  static async open(factory, name, timeoutMs) { return new IdbBackend(await openDb(factory, name, timeoutMs)); }

  async load() {
    const tx = this.db.transaction(STORE_NAMES, 'readonly');
    const done = txDone(tx);
    const [minutes, hours, hitKeys, freezeKeys, recordKeys, meta] = await Promise.all([
      request(tx.objectStore('minutes').getAll()), request(tx.objectStore('hours').getAll()),
      request(tx.objectStore('hits').getAllKeys()), request(tx.objectStore('freezes').getAllKeys()),
      request(tx.objectStore('records').index('seq').getAllKeys()), request(tx.objectStore('meta').getAll()),
    ]);
    await done;
    return { minutes, hours, hitKeys, freezeKeys, recordKeys, meta: Object.fromEntries(meta.map((m) => [m.k, m.v])) };
  }

  async commit(ops) {
    let tx;
    try {
      tx = this.db.transaction(STORE_NAMES, 'readwrite');
      const done = txDone(tx);
      const store = (name) => tx.objectStore(name);
      for (const b of ops.putMinutes.values()) store('minutes').put(b);
      for (const t of ops.deleteMinutes) store('minutes').delete(t);
      for (const b of ops.putHours.values()) store('hours').put(b);
      for (const r of ops.putHits.values()) store('hits').put(r);
      for (const r of ops.putFreezes.values()) store('freezes').put(r);
      for (const r of ops.putRecords.values()) store('records').put(r);
      for (const k of ops.deleteRecords) store('records').delete(k);
      for (const [k, v] of ops.meta) store('meta').put({ k, v });
      await done;
    } catch (error) {
      try { tx?.abort(); } catch { /* already finished */ }
      throw asStoreError(error);
    }
  }

  async readAll() {
    try {
      const tx = this.db.transaction(['hits', 'freezes', 'records'], 'readonly');
      const done = txDone(tx);
      const [hits, freezes, records] = await Promise.all([
        request(tx.objectStore('hits').getAll()), request(tx.objectStore('freezes').getAll()), request(tx.objectStore('records').index('seq').getAll()),
      ]);
      await done;
      return { hits, freezes, records };
    } catch (error) {
      throw asStoreError(error);
    }
  }

  async clear() {
    try {
      const tx = this.db.transaction(STORE_NAMES, 'readwrite');
      const done = txDone(tx);
      for (const name of STORE_NAMES) tx.objectStore(name).clear();
      await done;
    } catch (error) {
      throw asStoreError(error);
    }
  }
}

/** Same contract, in memory. Used when IndexedDB is unavailable, and by tests. */
export class MemoryBackend {
  constructor() { this.kind = 'memory'; this.reset(); }

  reset() {
    this.minutes = new Map(); this.hours = new Map(); this.hits = new Map(); this.freezes = new Map(); this.records = new Map(); this.meta = new Map();
  }

  async load() {
    const bySeq = [...this.records.values()].sort((a, b) => a.seq - b.seq);
    return { minutes: [...this.minutes.values()], hours: [...this.hours.values()], hitKeys: [...this.hits.keys()], freezeKeys: [...this.freezes.keys()], recordKeys: bySeq.map((r) => r.key), meta: Object.fromEntries(this.meta) };
  }

  async commit(ops) {
    for (const b of ops.putMinutes.values()) this.minutes.set(b.t, { ...b });
    for (const t of ops.deleteMinutes) this.minutes.delete(t);
    for (const b of ops.putHours.values()) this.hours.set(b.t, { ...b });
    for (const r of ops.putHits.values()) this.hits.set(r.key, r);
    for (const r of ops.putFreezes.values()) this.freezes.set(r.key, r);
    for (const r of ops.putRecords.values()) this.records.set(r.key, r);
    for (const k of ops.deleteRecords) this.records.delete(k);
    for (const [k, v] of ops.meta) this.meta.set(k, v);
  }

  async readAll() {
    return { hits: [...this.hits.values()], freezes: [...this.freezes.values()], records: [...this.records.values()].sort((a, b) => a.seq - b.seq) };
  }

  async clear() { this.reset(); }
}

// ---- buckets --------------------------------------------------------------------------------

const floorTo = (ms, size) => ms - (((ms % size) + size) % size);
const emptyBucket = (t) => ({ t, blocks: 0, transfers: 0, allow: 0, hits: 0, usd: 0, firstBlock: null, lastBlock: null });
const minOf = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));
const maxOf = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));

function addInto(target, source) {
  target.blocks += source.blocks; target.transfers += source.transfers; target.allow += source.allow; target.hits += source.hits; target.usd += source.usd;
  target.firstBlock = minOf(target.firstBlock, source.firstBlock);
  target.lastBlock = maxOf(target.lastBlock, source.lastBlock);
}

/** The fields of a stored transfer record (the ring keeps these, not the receipt). */
const RING_FIELDS = ['key', 'source', 'block', 'tx', 'log_index', 'token', 'token_contract', 'from', 'to', 'amount', 'outcome', 'receipt_id', 'receipt_hash', 'block_time', 'screened_at'];

export class RecordStore {
  /**
   * Args: indexedDB (the factory; defaults to the page's, may be undefined), now () => ms, maxRecords,
   *   compactAfterMs, dbName, openTimeoutMs, backend (inject a backend instead of opening one; tests).
   */
  constructor({ indexedDB = globalThis.indexedDB, now = () => Date.now(), maxRecords = MAX_RECORDS, compactAfterMs = COMPACT_AFTER_MS, dbName = DB_NAME, openTimeoutMs = OPEN_TIMEOUT_MS, backend = null } = {}) {
    this.now = now;
    this.maxRecords = maxRecords;
    this.compactAfterMs = compactAfterMs;
    this.state = 'loading';
    this.notice = '';
    this.noticeKind = '';
    this.listeners = new Set();
    this.minutes = new Map();
    this.hours = new Map();
    this.ringKeys = new Set();
    this.ringQueue = [];
    this.ringHead = 0;
    this.hitKeys = new Set();
    this.freezeKeys = new Set();
    this.seq = 0;
    this.firstRecordAt = null;
    this.replayRows = 0;
    this.lastCompact = -Infinity;
    this.pending = new OpSet();
    this.queue = Promise.resolve();
    this.backend = null;
    this.ready = this.#init({ indexedDB, dbName, openTimeoutMs, backend });
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit() { for (const fn of this.listeners) { try { fn(this); } catch (error) { log('listener failed', error); } } }

  #fallToMemory(kind, error) {
    log(`falling back to memory: ${kind}`, error);
    this.backend = new MemoryBackend();
    this.state = 'memory';
    this.#setNotice('unavailable');
  }

  #setNotice(kind) { this.noticeKind = kind; this.notice = kind ? NOTICES[kind] : ''; }

  async #init({ indexedDB, dbName, openTimeoutMs, backend }) {
    let loaded = null;
    if (backend) {
      this.backend = backend;
      this.state = backend.kind === 'memory' ? 'memory' : 'indexeddb';
    } else if (!indexedDB) {
      this.#fallToMemory('unavailable', null);
    } else {
      try {
        this.backend = await IdbBackend.open(indexedDB, dbName, openTimeoutMs);
        this.state = 'indexeddb';
      } catch (error) {
        this.#fallToMemory('unavailable', error);
      }
    }
    try {
      loaded = await this.backend.load();
    } catch (error) {
      if (this.backend.kind === 'memory') throw error;
      this.#fallToMemory('unavailable', error);
      loaded = await this.backend.load();
    }
    for (const m of loaded.minutes) this.minutes.set(m.t, m);
    for (const hb of loaded.hours) this.hours.set(hb.t, hb);
    this.ringQueue = [...loaded.recordKeys];
    this.ringKeys = new Set(loaded.recordKeys);
    this.hitKeys = new Set(loaded.hitKeys);
    this.freezeKeys = new Set(loaded.freezeKeys);
    this.seq = loaded.meta.seq ?? 0;
    this.replayRows = loaded.meta.replayRows ?? 0;
    this.firstRecordAt = loaded.meta.firstRecordAt ?? null;
    this.#emit();
  }

  /**
   * Saves one batch: screened transfers, issuer events and the coverage of the minute it happened in.
   * Never rejects and does not block: the work is queued behind earlier batches.
   *
   * Args: batch { at (ms, the page clock), cover (default true: this batch is the page recording),
   *   blocks: [{ block, n, hits, usd }] (live blocks), records: [stored transfer records, see
   *   chain.js storedRecord; hits carry `receipt` and `list_matches`], freezes: [stored freeze events] }.
   * Returns: a promise for when the batch has been handled (saved or kept for retry).
   */
  ingest(batch) {
    const run = () => this.#apply(batch).catch((error) => { log('ingest failed', error); });
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async #apply(batch) {
    await this.ready.catch(() => {});
    if (!this.backend) return;
    const ops = new OpSet();
    const at = batch.at ?? this.now();
    const minuteT = floorTo(at, MINUTE_MS);
    const cover = batch.cover !== false;
    const fresh = [];
    for (const r of batch.records ?? []) {
      if (this.ringKeys.has(r.key)) continue; // dedupe by `${tx}:${logIndex}`
      fresh.push(r);
    }
    const live = fresh.filter((r) => r.source === SOURCE_LIVE);
    if (cover) {
      const bucket = this.minutes.get(minuteT) ?? emptyBucket(minuteT);
      const blocks = batch.blocks ?? [];
      bucket.blocks += blocks.length;
      for (const b of blocks) { bucket.firstBlock = minOf(bucket.firstBlock, b.block); bucket.lastBlock = maxOf(bucket.lastBlock, b.block); }
      for (const r of live) {
        bucket.transfers++;
        if (r.outcome === 'BLOCK') bucket.hits++; else bucket.allow++;
        bucket.usd += Number(r.amount);
      }
      this.minutes.set(minuteT, bucket);
      ops.putMinute(bucket);
      if (this.firstRecordAt === null || minuteT < this.firstRecordAt) { this.firstRecordAt = minuteT; ops.meta.set('firstRecordAt', minuteT); }
    }
    for (const r of fresh) {
      this.seq++;
      const ring = { ...Object.fromEntries(RING_FIELDS.map((f) => [f, r[f] ?? null])), seq: this.seq };
      ops.putRecord(ring);
      this.ringKeys.add(r.key);
      this.ringQueue.push(r.key);
      if (r.source === SOURCE_REPLAY) this.replayRows++;
      if (r.outcome === 'BLOCK' && !this.hitKeys.has(r.key)) {
        this.hitKeys.add(r.key);
        ops.putHits.set(r.key, { ...r, seq: this.seq });
      }
    }
    while (this.ringKeys.size > this.maxRecords) {
      const oldest = this.ringQueue[this.ringHead++];
      this.ringKeys.delete(oldest);
      ops.deleteRecord(oldest);
    }
    if (this.ringHead > 1024 && this.ringHead * 2 > this.ringQueue.length) { this.ringQueue = this.ringQueue.slice(this.ringHead); this.ringHead = 0; }
    for (const f of batch.freezes ?? []) {
      if (this.freezeKeys.has(f.key)) continue;
      this.freezeKeys.add(f.key);
      ops.putFreezes.set(f.key, f);
    }
    if (at - this.lastCompact >= COMPACT_EVERY_MS) { this.lastCompact = at; this.#compact(at, ops); }
    ops.meta.set('seq', this.seq);
    ops.meta.set('replayRows', this.replayRows);
    await this.#persist(ops);
    this.#emit();
  }

  /** Folds minute buckets whose whole hour is older than `compactAfterMs` into hour buckets (the minutes recorded are kept). */
  #compact(nowMs, ops) {
    const cutoff = nowMs - this.compactAfterMs;
    const groups = new Map();
    for (const m of this.minutes.values()) {
      const hourT = floorTo(m.t, HOUR_MS);
      if (hourT + HOUR_MS > cutoff) continue;
      if (!groups.has(hourT)) groups.set(hourT, []);
      groups.get(hourT).push(m);
    }
    for (const [hourT, list] of groups) {
      const hour = this.hours.get(hourT) ?? { ...emptyBucket(hourT), minutes: 0 };
      for (const m of list) { addInto(hour, m); hour.minutes++; this.minutes.delete(m.t); ops.deleteMinute(m.t); }
      this.hours.set(hourT, hour);
      ops.putHours.set(hourT, { ...hour });
    }
  }

  async #persist(ops) {
    this.pending.merge(ops);
    if (this.pending.putRecords.size > MAX_PENDING_RECORDS) {
      // Storage keeps failing: keep every hit and bucket, drop the oldest unsaved ring rows.
      const drop = [...this.pending.putRecords.keys()].slice(0, this.pending.putRecords.size - MAX_PENDING_RECORDS);
      for (const k of drop) this.pending.putRecords.delete(k);
    }
    if (this.pending.empty) return;
    const sending = this.pending;
    try {
      await this.backend.commit(sending);
      this.pending = new OpSet();
      if (this.noticeKind === 'quota' || this.noticeKind === 'error') this.#setNotice('');
    } catch (error) {
      const failure = asStoreError(error);
      log(`save failed (${failure.kind})`, error);
      this.#setNotice(failure.kind === 'quota' ? 'quota' : 'error');
    }
  }

  /** Clears everything saved, in storage and in memory. Returns whether storage accepted it. */
  clear() {
    const run = async () => {
      await this.ready.catch(() => {});
      let ok = true;
      try { await this.backend.clear(); } catch (error) { ok = false; log('clear failed', error); this.#setNotice('error'); }
      this.minutes = new Map(); this.hours = new Map(); this.ringKeys = new Set(); this.ringQueue = []; this.ringHead = 0;
      this.hitKeys = new Set(); this.freezeKeys = new Set(); this.seq = 0; this.firstRecordAt = null; this.replayRows = 0; this.lastCompact = -Infinity;
      this.pending = new OpSet();
      if (ok && (this.noticeKind === 'quota' || this.noticeKind === 'error')) this.#setNotice('');
      this.#emit();
      return ok;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /** Resolves when every queued batch has been handled. */
  idle() { return this.queue.then(() => undefined); }

  /** Totals since the first record, live only (replays are counted separately). */
  summary() {
    const total = { blocks: 0, transfers: 0, allow: 0, hits: 0, usd: 0 };
    let minutesRecorded = 0;
    for (const m of this.minutes.values()) { addInto(total, m); minutesRecorded++; }
    for (const hb of this.hours.values()) { addInto(total, hb); minutesRecorded += hb.minutes; }
    return {
      state: this.state, notice: this.notice, noticeKind: this.noticeKind,
      firstRecordAt: this.firstRecordAt, minutesRecorded, ...total,
      records: this.ringKeys.size, maxRecords: this.maxRecords, hitRows: this.hitKeys.size, freezeRows: this.freezeKeys.size, replayRows: this.replayRows,
      unsaved: this.pending.empty ? 0 : this.pending.putRecords.size + this.pending.putHits.size + this.pending.putFreezes.size,
    };
  }

  /**
   * Buckets for the history chart, as timerange.js `pre` rows: [{ t, span, minutes, values: { clear, hit, usd } }]
   * (a minute bucket has minutes 1; an hour bucket the minutes recorded within it), and the first record time.
   */
  series() {
    const rows = [];
    for (const hb of this.hours.values()) rows.push({ t: hb.t, span: HOUR_MS, minutes: hb.minutes, values: { clear: hb.allow, hit: hb.hits, usd: hb.usd } });
    for (const m of this.minutes.values()) rows.push({ t: m.t, span: MINUTE_MS, minutes: 1, values: { clear: m.allow, hit: m.hits, usd: m.usd } });
    rows.sort((a, b) => a.t - b.t);
    return { firstRecordAt: this.firstRecordAt, buckets: rows };
  }

  /** Everything saved, for export: ring records (oldest first), hits and freezes, including batches not yet saved. */
  async readAll() {
    await this.idle();
    const stored = await this.backend.readAll();
    const merge = (list, puts, deletes = new Set()) => {
      const byKey = new Map(list.map((r) => [r.key, r]));
      for (const [k, v] of puts) byKey.set(k, v);
      for (const k of deletes) byKey.delete(k);
      return [...byKey.values()];
    };
    const records = merge(stored.records, this.pending.putRecords, this.pending.deleteRecords).sort((a, b) => a.seq - b.seq);
    return { records, hits: merge(stored.hits, this.pending.putHits), freezes: merge(stored.freezes, this.pending.putFreezes) };
  }

  /** CSV text of everything saved (see buildCsv). */
  async exportCsv() { return buildCsv(await this.readAll()); }
}

export const CSV_HEADER = ['record_type', 'source', 'block', 'tx_hash', 'log_index', 'token', 'from', 'to', 'amount', 'outcome', 'receipt_id', 'block_time', 'screened_at', 'address', 'on_list', 'list_matches', 'receipt_json'];

/**
 * CSV of saved records: one row per transfer (record_type "hit" for a hit, with its signed receipt in
 * receipt_json), then hits that have left the ring, then freeze and unfreeze events. Timestamps are UTC
 * ISO: block_time to the second (the chain's resolution), screened_at to the millisecond.
 */
export function buildCsv({ records, hits, freezes }) {
  const hitByKey = new Map(hits.map((h) => [h.key, h]));
  const rows = [];
  const transferRow = (r, hit) => [hit ? 'hit' : 'transfer', r.source, r.block, r.tx, r.log_index, r.token, r.from, r.to, r.amount, r.outcome, r.receipt_id, r.block_time, r.screened_at, '', '', hit ? (hit.list_matches ?? []).join('; ') : '', hit?.receipt ? JSON.stringify(hit.receipt) : ''];
  const seen = new Set();
  for (const r of records) { seen.add(r.key); rows.push(transferRow(r, hitByKey.get(r.key))); }
  for (const hit of hits) if (!seen.has(hit.key)) rows.push(transferRow(hit, hit));
  for (const f of freezes) rows.push([f.kind, f.source, f.block, f.tx, f.log_index, f.token, '', '', '', '', '', f.block_time, f.observed_at, f.address, f.listed ? 'yes' : 'no', (f.list_matches ?? []).join('; '), '']);
  rows.sort((a, b) => String(a[12]).localeCompare(String(b[12])));
  return toCsv([CSV_HEADER, ...rows]);
}
