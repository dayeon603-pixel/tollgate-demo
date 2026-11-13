/**
 * Live chain: real Ethereum mainnet data, read in the visitor's browser from a free public JSON-RPC
 * endpoint (no API key). It follows USDC and USDT Transfer logs block by block, screens the sender and
 * the receiver of every transfer against the bundled OFAC snapshot with the same exact-match function
 * the workspace uses (matchIn), and signs each decision into a hash-chained receipt in its own rolling
 * ledger. Every decision is stamped with two times: `block_time`, the chain's own timestamp (ISO, one-second
 * resolution, never padded with milliseconds), and `screened_at`, this page's clock at the decision (ISO
 * with milliseconds); both are signed into the receipt. With a `store` (recordstore.js) each ingest is also
 * saved, so records survive a reload. It also reads the issuers' own freeze events (USDC Blacklisted / UnBlacklisted, USDT
 * AddedBlackList / RemovedBlackList), live and for a bounded window back.
 *
 * Nothing here is synthetic. A hit only appears when a real transfer touches an address on the list;
 * the one exception is replay(), which fetches one real historical transfer to a listed address from
 * the chain and is labelled as historical everywhere it shows.
 *
 * Limits measured on 2026-11-10 (see README): ethereum-rpc.publicnode.com answers eth_getLogs over up
 * to about 5,000 recent blocks and refuses older blocks without a token; eth.drpc.org answers small
 * ranges (100 blocks) including old blocks. Polling is one round trip every POLL_MS, paused while the
 * tab is hidden, with exponential backoff and a switch to the fallback endpoint on errors.
 */
import { matchIn } from './lists.js';
import { Ledger } from './ledger.js';

export const ENDPOINTS = [
  { url: 'https://ethereum-rpc.publicnode.com', host: 'ethereum-rpc.publicnode.com', backfillSpan: 5000, chunk: 5000 },
  { url: 'https://eth.drpc.org', host: 'eth.drpc.org', backfillSpan: 1000, chunk: 100 },
];
export const TOKENS = {
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6, issuer: 'Circle' },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, issuer: 'Tether' },
};
export const TOKEN_ADDRESSES = Object.keys(TOKENS);
/** keccak256 of the event signatures, checked against web3_sha3 on mainnet. */
export const TOPICS = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  usdcBlacklisted: '0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855',
  usdcUnBlacklisted: '0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e',
  usdtAddedBlackList: '0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc',
  usdtRemovedBlackList: '0xd7e9ec6e6ecd65492dce6bf513cd6867560d49544421d0783ddf06e76c24470c',
};
const FREEZE_TOPICS = [TOPICS.usdcBlacklisted, TOPICS.usdcUnBlacklisted, TOPICS.usdtAddedBlackList, TOPICS.usdtRemovedBlackList];
/**
 * A real historical transfer to an address on the bundled list, used by "Replay a known sanctioned
 * address". Found on 2026-11-10 by bisecting the address's USDC balance over blocks; the log itself is
 * fetched from the chain at click time, so this is only a pointer.
 */
export const REPLAY = { block: 13_180_202, token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', to: '0x931546d9e66836abf687d2bc64b30407bac8c568' };

export const POLL_MS = 12_000;
export const MAX_CATCHUP_BLOCKS = 4;
export const MAX_TRANSFERS_KEPT = 400;
export const MAX_BLOCKS_KEPT = 60;
export const MAX_FREEZES_KEPT = 200;
export const CHAIN_MAX_RECEIPTS = 300;
export const RPC_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 3_000;
export const BACKOFF_MAX_MS = 60_000;
export const CHAIN_AGENT = 'tollgate.live-chain';
const UNIT = 10n ** 6n;

const hexToNumber = (h) => Number.parseInt(h, 16);

/** ISO time to the second, "2026-11-13T14:03:12Z": the resolution of a block timestamp. No milliseconds are invented. */
export const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** ISO time to the millisecond, "2026-11-13T14:03:12.481Z". */
export const isoMillis = (ms) => new Date(ms).toISOString();
const topicAddress = (topic) => `0x${topic.slice(-40)}`.toLowerCase();
const isAddressWord = (word) => /^0x0{24}[0-9a-fA-F]{40}$/.test(word);

/** Token units as a decimal string ("1234.56") from a raw integer, without floating point. */
export function formatUnits(raw, decimals = 6) {
  const unit = 10n ** BigInt(decimals);
  const whole = raw / unit;
  const frac = (raw % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Decodes one log from the two token contracts.
 *
 * Returns: { kind: 'transfer', token, symbol, from, to, raw (BigInt), amount (number, token units),
 *   block, tx, logIndex } or { kind: 'freeze' | 'unfreeze', token, symbol, address, block, tx, logIndex },
 *   or null for a log this view does not follow or that does not have the expected shape.
 */
export function decodeLog(log) {
  const token = String(log?.address ?? '').toLowerCase();
  const meta = TOKENS[token];
  if (!meta || !Array.isArray(log.topics) || !log.topics.length || log.removed) return null;
  const base = { token, symbol: meta.symbol, block: hexToNumber(log.blockNumber), tx: log.transactionHash, logIndex: hexToNumber(log.logIndex) };
  const [t0] = log.topics;
  if (t0 === TOPICS.transfer) {
    // ERC-20 Transfer: from and to are indexed; the value is the 32-byte data word.
    if (log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
    const raw = BigInt(log.data);
    return { kind: 'transfer', ...base, from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), raw, amount: Number(raw / UNIT) + Number(raw % UNIT) / 1e6 };
  }
  if (t0 === TOPICS.usdcBlacklisted || t0 === TOPICS.usdcUnBlacklisted) {
    // USDC: the account is indexed.
    if (log.topics.length !== 2) return null;
    return { kind: t0 === TOPICS.usdcBlacklisted ? 'freeze' : 'unfreeze', ...base, address: topicAddress(log.topics[1]) };
  }
  if (t0 === TOPICS.usdtAddedBlackList || t0 === TOPICS.usdtRemovedBlackList) {
    // USDT: the account is not indexed; it is the data word.
    if (!isAddressWord(log.data)) return null;
    return { kind: t0 === TOPICS.usdtAddedBlackList ? 'freeze' : 'unfreeze', ...base, address: topicAddress(log.data) };
  }
  return null;
}

/**
 * Screens a decoded transfer: exact, case-insensitive match of the sender and the receiver against
 * the list version (the engine's matchIn). A match on either side is a hit.
 *
 * Returns: { outcome: 'BLOCK' | 'ALLOW', fromMatches, toMatches, reasons }
 */
export function screenTransfer(version, transfer) {
  const fromMatches = matchIn(version, transfer.from);
  const toMatches = matchIn(version, transfer.to);
  const hits = [...toMatches.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}:to`), ...fromMatches.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}:from`)];
  return { outcome: hits.length ? 'BLOCK' : 'ALLOW', fromMatches, toMatches, reasons: hits.length ? hits : ['clean'] };
}

/**
 * The receipt spec for one screened transfer (what gets signed).
 *
 * Args: transfer (decoded); screened (screenTransfer result); source; times { blockTime, screenedAt }:
 *   blockTime is the chain's timestamp as ISO seconds (or null when the block time is unknown),
 *   screenedAt the page clock at the decision as ISO milliseconds. Both go into the signed params.
 * Raises: TypeError when screenedAt is missing, because a decision without its time must not be signed.
 */
export function receiptSpec(transfer, screened, source = 'ethereum_mainnet', { blockTime = null, screenedAt } = {}) {
  if (typeof screenedAt !== 'string') throw new TypeError('receiptSpec needs times.screenedAt (ISO with milliseconds)');
  return {
    type: 'stablecoin_transfer_screen',
    params: {
      payment_id: `${transfer.tx}:${transfer.logIndex}`, chain: 'ethereum', asset: transfer.symbol, token_contract: transfer.token,
      block_number: transfer.block, tx_hash: transfer.tx, log_index: transfer.logIndex,
      from_address: transfer.from, beneficiary_address: transfer.to, amount: formatUnits(transfer.raw), outcome: screened.outcome, source,
      block_time: blockTime, screened_at: screenedAt,
    },
    decision: screened.outcome === 'BLOCK' ? 'DENY' : 'ALLOW',
    outcome: screened.outcome,
    reasons: screened.reasons,
    agentId: CHAIN_AGENT,
  };
}

/**
 * A screened record in the shape the record store keeps (snake_case, ISO times, exact decimal amount).
 * A hit also carries its full signed receipt and the names it matched.
 */
export function storedRecord(record) {
  const base = {
    key: `${record.tx}:${record.logIndex}`, source: record.source, block: record.block, tx: record.tx, log_index: record.logIndex,
    token: record.symbol, token_contract: record.token, from: record.from, to: record.to, amount: formatUnits(record.raw),
    outcome: record.outcome, receipt_id: record.receiptId, receipt_hash: record.receipt.this_hash, block_time: record.block_time, screened_at: record.screened_at,
  };
  if (record.outcome !== 'BLOCK') return base;
  return { ...base, list_matches: [...record.toMatches, ...record.fromMatches].map((e) => `${e.name} (UID ${e.uid})`), receipt: record.receipt };
}

/** An issuer freeze or unfreeze event for the record store. `observedAt` is the page clock (ms). No receipt: the issuer acted, Tollgate did not decide. */
export function storedFreeze(f, observedAt) {
  return {
    key: `${f.tx}:${f.logIndex}`, kind: f.kind, source: f.how, token: f.symbol, token_contract: f.token, address: f.address, block: f.block, tx: f.tx, log_index: f.logIndex,
    block_time: f.t ? isoSeconds(f.t) : null, observed_at: isoMillis(observedAt), listed: f.listed, list_matches: f.entries.map((e) => e.name), receipt: null,
  };
}

/** JSON-RPC over fetch, one endpoint, with a timeout. Raises RpcError with a short reason. */
export class RpcError extends Error {
  constructor(message, { endpoint, code = null, rateLimited = false } = {}) {
    super(message);
    this.name = 'RpcError';
    this.endpoint = endpoint;
    this.code = code;
    this.rateLimited = rateLimited;
  }
}

export async function rpcCall(fetchImpl, endpoint, calls, timeoutMs = RPC_TIMEOUT_MS) {
  const batch = Array.isArray(calls);
  const list = batch ? calls : [calls];
  const body = list.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(endpoint.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch ? body : body[0]), signal: ctl?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch (error) {
    throw new RpcError(error?.name === 'AbortError' ? 'timed out' : 'could not connect', { endpoint });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (response.status === 429) throw new RpcError('rate limited', { endpoint, rateLimited: true });
  if (!response.ok) throw new RpcError(`HTTP ${response.status}`, { endpoint });
  let json;
  try { json = await response.json(); } catch { throw new RpcError('bad response', { endpoint }); }
  const answers = Array.isArray(json) ? json : [json];
  const byId = new Map(answers.map((a) => [a.id, a]));
  const results = body.map((b) => {
    const a = byId.get(b.id) ?? (answers.length === 1 ? answers[0] : null);
    if (!a) throw new RpcError('missing answer', { endpoint });
    if (a.error) throw new RpcError(String(a.error.message ?? 'error').slice(0, 120), { endpoint, code: a.error.code ?? null });
    return a.result;
  });
  return batch ? results : results[0];
}

const logFilter = (from, to, topics) => ({ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: TOKEN_ADDRESSES, topics });

/**
 * Follows the chain. One instance for the whole workspace (ctx.chain); views subscribe to updates.
 *
 * Args: version, the list version to screen against (the bundled real snapshot); fetchImpl; now,
 *   () => epoch ms (the clock that stamps `screened_at`); schedule(fn, ms), the timer (setTimeout by
 *   default); endpoints; store, an optional RecordStore that every ingest is saved to.
 */
export class ChainWatcher {
  constructor({ version, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancel = (t) => clearTimeout(t), endpoints = ENDPOINTS, maxReceipts = CHAIN_MAX_RECEIPTS, store = null }) {
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.endpoints = endpoints;
    this.maxReceipts = maxReceipts;
    this.store = store;
    this.listeners = new Set();
    this.endpointIndex = 0;
    this.timer = null;
    this.running = false;
    this.hidden = false;
    this.busy = false;
    this.ledger = new Ledger({ idPrefix: 'c' });
    this.epoch = 1;
    this.state = 'idle';
    this.message = '';
    this.failures = 0;
    this.lastBlock = null;
    this.head = null;
    this.headTime = null;
    this.transfers = [];
    this.blocks = [];
    this.freezes = [];
    this.freezeKeys = new Set();
    this.totals = { transfers: 0, hits: 0, usd: 0, blocks: 0, freezes: 0, unfreezes: 0, requests: 0, errors: 0 };
    this.firstBlock = null;
    this.backfill = { state: 'pending', from: null, to: null, found: 0, message: '' };
    this.replayed = [];
  }

  get endpoint() { return this.endpoints[this.endpointIndex]; }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #emit() { for (const fn of this.listeners) { try { fn(this); } catch { /* a view that left the page */ } } }

  #setState(state, message = '') { this.state = state; this.message = message; this.#emit(); }

  async #rpc(calls) {
    this.totals.requests++;
    return rpcCall(this.fetchImpl, this.endpoint, calls);
  }

  /** Starts following the chain (idempotent). */
  start() {
    if (this.running) return;
    this.running = true;
    this.#setState('connecting', `Connecting to ${this.endpoint.host}`);
    this.#loop(0);
  }

  stop() {
    this.running = false;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.#setState('idle', 'Stopped');
  }

  /** Pauses polling while the page is hidden and resumes when it is shown again. */
  setHidden(hidden) {
    this.hidden = hidden;
    if (!this.running) return;
    if (hidden) {
      if (this.timer) this.cancel(this.timer);
      this.timer = null;
      this.#setState('paused', 'Paused while this tab is hidden');
    } else if (!this.timer && !this.busy) {
      this.#loop(0);
    }
  }

  #loop(delay) {
    if (!this.running || this.hidden) return;
    if (this.timer) this.cancel(this.timer);
    this.timer = this.schedule(async () => {
      this.timer = null;
      const wait = await this.tick();
      this.#loop(wait);
    }, delay);
  }

  /** One poll. Returns the delay before the next one. */
  async tick() {
    if (this.busy) return POLL_MS;
    this.busy = true;
    try {
      const latest = await this.#rpc({ method: 'eth_getBlockByNumber', params: ['latest', false] });
      const head = hexToNumber(latest.number);
      this.head = head;
      this.headTime = hexToNumber(latest.timestamp) * 1000;
      if (this.backfill.state === 'pending') await this.#backfill(head);
      if (this.lastBlock === null) this.lastBlock = head - 1;
      const from = Math.max(this.lastBlock + 1, head - MAX_CATCHUP_BLOCKS + 1);
      if (from <= head) {
        const numbers = [];
        for (let b = from; b <= head; b++) numbers.push(b);
        const answers = await this.#rpc([
          { method: 'eth_getLogs', params: [logFilter(from, head, [[TOPICS.transfer, ...FREEZE_TOPICS]])] },
          ...numbers.filter((b) => b !== head).map((b) => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })),
        ]);
        const times = new Map([[head, this.headTime]]);
        answers.slice(1).forEach((blk) => { if (blk) times.set(hexToNumber(blk.number), hexToNumber(blk.timestamp) * 1000); });
        await this.ingest(answers[0], times, numbers);
        this.lastBlock = head;
      } else {
        this.#save({ at: this.now(), cover: true }); // no new block: the page was still recording this minute
      }
      this.failures = 0;
      this.#setState('live', `Block ${head.toLocaleString('en-US')}`);
      return POLL_MS;
    } catch (error) {
      return this.#fail(error);
    } finally {
      this.busy = false;
    }
  }

  #fail(error) {
    this.failures++;
    this.totals.errors++;
    const reason = error instanceof RpcError ? error.message : 'unexpected error';
    // Switch endpoint after the second failure in a row, and keep switching on later ones.
    if (this.failures >= 2 && this.endpoints.length > 1) this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
    this.#setState(this.failures >= 4 ? 'error' : 'retrying', `${reason}. Retrying in ${Math.round(wait / 1000)} s via ${this.endpoint.host}`);
    return wait;
  }

  /** Screens and signs every transfer in a batch of logs, and records freezes. Exposed for tests. */
  async ingest(logs, times, blockNumbers = []) {
    const at = this.now();
    const savedRecords = [];
    const savedFreezes = [];
    const perBlock = new Map(blockNumbers.map((b) => [b, { block: b, t: times.get(b) ?? null, n: 0, hits: 0, usd: 0 }]));
    const decoded = logs.map(decodeLog).filter(Boolean).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    for (const d of decoded) {
      const chainTime = times.get(d.block) ?? this.headTime ?? null;
      const t = chainTime ?? this.now();
      if (d.kind === 'transfer') {
        const record = await this.#sign(d, t, 'ethereum_mainnet', chainTime !== null);
        savedRecords.push(storedRecord(record));
        const row = perBlock.get(d.block) ?? { block: d.block, t, n: 0, hits: 0, usd: 0 };
        row.n++; row.usd += d.amount; if (record.outcome === 'BLOCK') row.hits++;
        perBlock.set(d.block, row);
        this.totals.transfers++;
        this.totals.usd += d.amount;
        if (record.outcome === 'BLOCK') this.totals.hits++;
        this.transfers.push(record);
      } else {
        const freeze = this.#addFreeze(d, t, 'live');
        if (freeze) savedFreezes.push(storedFreeze(freeze, at));
      }
    }
    if (this.transfers.length > MAX_TRANSFERS_KEPT) this.transfers.splice(0, this.transfers.length - MAX_TRANSFERS_KEPT);
    for (const row of [...perBlock.values()].sort((a, b) => a.block - b.block)) {
      if (this.firstBlock === null) this.firstBlock = row.block;
      this.blocks.push(row);
      this.totals.blocks++;
    }
    if (this.blocks.length > MAX_BLOCKS_KEPT) this.blocks.splice(0, this.blocks.length - MAX_BLOCKS_KEPT);
    this.#save({ at, cover: true, blocks: [...perBlock.values()].map((b) => ({ block: b.block, n: b.n, hits: b.hits, usd: b.usd })), records: savedRecords, freezes: savedFreezes });
    this.#emit();
  }

  /** Hands a batch to the record store without waiting for it (the store queues, saves and handles its own errors). */
  #save(batch) {
    if (!this.store) return;
    void this.store.ingest(batch);
  }

  /**
   * Screens and signs one transfer. `t` is the block time in ms; `chainTime` says whether it came from
   * the chain (block_time is null when it did not, rather than a time the chain never gave).
   */
  async #sign(transfer, t, source, chainTime = true) {
    const screened = screenTransfer(this.version, transfer);
    if (this.ledger.size >= this.maxReceipts) { this.ledger = new Ledger({ idPrefix: 'c' }); this.epoch++; }
    const block_time = chainTime ? isoSeconds(t) : null;
    const screened_at = isoMillis(this.now());
    const entry = await this.ledger.append(receiptSpec(transfer, screened, source, { blockTime: block_time, screenedAt: screened_at }), this.version, new Date(t));
    return { ...transfer, t, block_time, screened_at, outcome: screened.outcome, fromMatches: screened.fromMatches, toMatches: screened.toMatches, receiptId: entry.receipt.receipt_id, receipt: entry.receipt, source, epoch: this.epoch };
  }

  /** Records an issuer event once. Returns the event, or null when it was already known. */
  #addFreeze(d, t, how) {
    const key = `${d.tx}:${d.logIndex}`;
    if (this.freezeKeys.has(key)) return null;
    this.freezeKeys.add(key);
    const entries = matchIn(this.version, d.address);
    const freeze = { ...d, t, how, entries, listed: entries.length > 0 };
    this.freezes.push(freeze);
    this.freezes.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
    if (this.freezes.length > MAX_FREEZES_KEPT) this.freezes.length = MAX_FREEZES_KEPT;
    if (d.kind === 'freeze') this.totals.freezes++; else this.totals.unfreezes++;
    return freeze;
  }

  /** Reads the issuers' freeze events over a bounded window back from the head. */
  async #backfill(head) {
    const ep = this.endpoint;
    const span = ep.backfillSpan;
    const from = Math.max(0, head - span);
    this.backfill = { state: 'running', from, to: head, found: 0, message: '' };
    try {
      const logs = [];
      for (let a = from; a <= head; a += ep.chunk) {
        const b = Math.min(head, a + ep.chunk - 1);
        logs.push(...await this.#rpc({ method: 'eth_getLogs', params: [logFilter(a, b, [FREEZE_TOPICS])] }));
      }
      const decoded = logs.map(decodeLog).filter(Boolean);
      const blocks = [...new Set(decoded.map((d) => d.block))];
      const times = new Map();
      if (blocks.length) {
        const answers = await this.#rpc(blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [`0x${b.toString(16)}`, false] })));
        answers.forEach((blk) => { if (blk) times.set(hexToNumber(blk.number), hexToNumber(blk.timestamp) * 1000); });
      }
      const found = decoded.map((d) => this.#addFreeze(d, times.get(d.block) ?? null, 'backfill')).filter(Boolean);
      if (found.length) {
        const at = this.now();
        this.#save({ at, cover: false, freezes: found.map((f) => storedFreeze(f, at)) }); // events the page read, not minutes it recorded
      }
      this.backfill = { state: 'done', from, to: head, found: decoded.length, message: '' };
    } catch (error) {
      this.backfill = { state: 'failed', from, to: head, found: 0, message: error instanceof RpcError ? error.message : 'error' };
    }
    this.#emit();
  }

  /**
   * Fetches one real historical transfer to a listed address (REPLAY) from the chain, screens it and
   * signs it with source "historical_replay". Tries every endpoint, the one that serves old blocks first.
   *
   * Returns: the record, or raises RpcError.
   */
  async replay() {
    const order = [...this.endpoints].sort((a, b) => a.chunk - b.chunk);
    let last = null;
    for (const ep of order) {
      try {
        this.totals.requests++;
        const [logs, blk] = await rpcCall(this.fetchImpl, ep, [
          { method: 'eth_getLogs', params: [{ fromBlock: `0x${REPLAY.block.toString(16)}`, toBlock: `0x${REPLAY.block.toString(16)}`, address: REPLAY.token, topics: [TOPICS.transfer, null, `0x${REPLAY.to.slice(2).padStart(64, '0')}`] }] },
          { method: 'eth_getBlockByNumber', params: [`0x${REPLAY.block.toString(16)}`, false] },
        ]);
        const transfer = logs.map(decodeLog).find((d) => d?.kind === 'transfer');
        if (!transfer) throw new RpcError('the historical transfer was not returned', { endpoint: ep });
        const record = await this.#sign(transfer, hexToNumber(blk.timestamp) * 1000, 'historical_replay');
        record.endpoint = ep.host;
        this.replayed.push(record);
        this.#save({ at: this.now(), cover: false, records: [storedRecord(record)] });
        this.#emit();
        return record;
      } catch (error) {
        last = error;
      }
    }
    throw last ?? new RpcError('no endpoint');
  }

  /** Checks the rolling ledger with the real verifier. */
  verify() { return this.ledger.verifyAll(); }
}
