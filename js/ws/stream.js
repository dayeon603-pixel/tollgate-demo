/**
 * Demo payment stream. Everything here is synthetic: the payments, amounts and counterparty
 * addresses come from a seeded generator and never happened. What is real is the work done on them:
 * each payment is screened with the workspace's own engine functions (exact list match, then the
 * auto-hold policy) and each decision is signed into a hash-chained receipt by the same code that
 * signs workspace receipts.
 *
 * Live receipts go to their own rolling ledger, never the workspace ledger, so a stream left
 * running cannot grow the workspace ledger or change what an evidence pack covers. The rolling
 * ledger is dropped and restarted when it reaches LIVE_MAX_RECEIPTS, and what remains always
 * verifies with the real verifier.
 */
import { evaluatePolicy } from './engine.js';
import { Ledger } from './ledger.js';
import { matchIn } from './lists.js';
import { between, fakeEthAddress, fakeTronAddress, HOUR_MS, pick, rng } from './util.js';

export const STREAM_SEED = 20261107;
export const STREAM_AGENT = 'tollgate.demo-stream';
export const SPEEDS = [1, 5, 20];
/** Payments per second at 1x. */
export const BASE_RATE = 2;
export const TICK_MS = 125;
export const MAX_PER_TICK = 10;
export const LIVE_MAX_RECEIPTS = 300;
export const LIVE_MAX_EVENTS = 2500;
export const LATENCY_SAMPLES = 2000;
export const BUCKET_KEEP_S = 3600;
const POOL_ETH = 70;
const POOL_TRON = 40;
const HIT_RATE = 0.03;
const NO_ORIGINATOR_RATE = 0.12;

export const CHAINS = [
  { id: 'ethereum', label: 'Ethereum', family: 'evm', weight: 0.46 },
  { id: 'tron', label: 'Tron', family: 'tron', weight: 0.36 },
  { id: 'arbitrum', label: 'Arbitrum', family: 'evm', weight: 0.1 },
  { id: 'bnb', label: 'BNB Chain', family: 'evm', weight: 0.08 },
];
export const CHAIN_LABEL = Object.fromEntries(CHAINS.map((c) => [c.id, c.label]));
export const ASSETS = ['USDC', 'USDT'];
const EVM_SHAPE = /^0x[0-9a-fA-F]{40}$/;
const TRON_SHAPE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

/** 32-bit mix of a seed and an index, so event i never depends on the events before it. */
export function mixSeed(seed, i) {
  let x = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** 32-bit FNV-1a of a string. */
export function hashString(text) {
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return x;
}

export const isTronAddress = (a) => TRON_SHAPE.test(a);

/**
 * Address pools for the generator.
 *
 * Args: listVersion, the newest list version (listed targets are drawn from it); seed; extra,
 *   addresses the workspace already knows (they join the clean pools so the graph connects).
 * Returns: { eth, tron, listedEth, listedTron }, all sorted or seed-generated, hence reproducible.
 */
export function buildPools(listVersion, seed = STREAM_SEED, extra = []) {
  const rand = rng(seed ^ 0x5bd1e995);
  const listed = new Set();
  const listedEth = [];
  const listedTron = [];
  for (const entries of listVersion.byAddress.values()) {
    const e = entries[0];
    if (e.synthetic) continue;
    if (EVM_SHAPE.test(e.address)) listedEth.push(e.address);
    else if (TRON_SHAPE.test(e.address)) listedTron.push(e.address);
    listed.add(e.address.toLowerCase());
  }
  listedEth.sort();
  listedTron.sort();
  const eth = Array.from({ length: POOL_ETH }, () => fakeEthAddress(rand));
  const tron = Array.from({ length: POOL_TRON }, () => fakeTronAddress(rand));
  for (const address of [...extra].sort()) {
    if (listed.has(address.toLowerCase())) continue;
    if (EVM_SHAPE.test(address) && !eth.includes(address)) eth.push(address);
    else if (TRON_SHAPE.test(address) && !tron.includes(address)) tron.push(address);
  }
  return { eth, tron, listedEth, listedTron };
}

function amountFor(rand) {
  const r = rand();
  if (r < 0.55) return between(rand, 50, 999);
  if (r < 0.85) return between(rand, 1000, 9999);
  if (r < 0.97) return between(rand, 10_000, 49_999);
  return between(rand, 50_000, 250_000);
}

function pickChain(rand) {
  let r = rand();
  for (const c of CHAINS) {
    if (r < c.weight) return c;
    r -= c.weight;
  }
  return CHAINS[0];
}

function pickAsset(rand, chain) {
  const usdt = chain.id === 'tron' ? 0.8 : chain.id === 'bnb' ? 0.6 : 0.4;
  return rand() < usdt ? 'USDT' : 'USDC';
}

/**
 * Event number i of the stream. A pure function of (seed, i, pools): same inputs, same payment.
 * The decision is not part of the event; the engine makes it.
 */
export function makeEvent(i, pools, seed = STREAM_SEED) {
  const rand = rng(mixSeed(seed, i));
  const hit = rand() < HIT_RATE;
  let chain = pickChain(rand);
  const asset = pickAsset(rand, chain);
  const amountUsd = amountFor(rand);
  const originator = rand() >= NO_ORIGINATOR_RATE;
  let family = chain.family;
  let to;
  if (hit) {
    const tron = pools.listedTron.length && (family === 'tron' || !pools.listedEth.length);
    const source = tron ? pools.listedTron : pools.listedEth;
    to = pick(rand, source);
    family = tron ? 'tron' : 'evm';
    if (chain.family !== family) chain = CHAINS.find((c) => c.family === family);
  }
  const pool = family === 'tron' ? pools.tron : pools.eth;
  if (!hit) to = pool[Math.floor(rand() ** 1.6 * pool.length)];
  let from = pool[Math.floor(rand() ** 1.3 * pool.length)];
  if (from === to) from = pool[(pool.indexOf(from) + 1) % pool.length];
  return { i, chain: chain.id, asset, amountUsd, originator, from, to };
}

/**
 * Chain, asset and sender for a payment in the seeded workspace history. The workspace payments
 * carry only a beneficiary and an amount, so the demo assigns these three, reproducibly, from the
 * payment id. They are not in the signed receipt and the UI says so.
 */
export function seededMeta(tx, pools) {
  const rand = rng(hashString(tx.id));
  const tron = isTronAddress(tx.address);
  const chain = tron ? CHAINS[1] : pick(rand, [CHAINS[0], CHAINS[0], CHAINS[0], CHAINS[2], CHAINS[3]]);
  const pool = tron ? pools.tron : pools.eth;
  let from = pool[Math.floor(rand() ** 1.3 * pool.length)];
  if (from.toLowerCase() === tx.address.toLowerCase()) from = pool[(pool.indexOf(from) + 1) % pool.length];
  return { chain: chain.id, asset: pickAsset(rand, chain), from };
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const rank = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[rank];
}

const emptyBucket = () => ({ allow: 0, hold: 0, block: 0, usd: 0 });

/** Screens the synthetic stream and keeps rolling statistics. No DOM, no timers. */
export class LiveTape {
  /**
   * Args: ws, the workspace (list in force and policy are read from it at every payment);
   *   seed; clock, () => epoch ms; perf, () => high resolution ms (for latency); maxReceipts, the
   *   size at which the rolling ledger restarts.
   */
  constructor({ ws, seed = STREAM_SEED, clock = Date.now, perf = (typeof performance !== 'undefined' ? () => performance.now() : Date.now), maxReceipts = LIVE_MAX_RECEIPTS, maxEvents = LIVE_MAX_EVENTS }) {
    this.ws = ws;
    this.seed = seed;
    this.clock = clock;
    this.perf = perf;
    this.maxReceipts = maxReceipts;
    this.maxEvents = maxEvents;
    const known = ws.txs.map((t) => t.address);
    this.pools = buildPools(ws.versions.at(-1), seed, known);
    this.reset();
  }

  reset() {
    this.index = 0;
    this.epoch = 1;
    this.ledger = new Ledger({ idPrefix: 'd' });
    this.priorHead = null;
    this.events = [];
    this.buckets = new Map();
    this.latency = [];
    this.issued = 0;
    this.totals = { allow: 0, hold: 0, block: 0, usd: 0 };
    this.byChainAsset = new Map();
    this.flagsByHour = new Map();
    this.holdsByCell = new Map();
  }

  /** Screens the next `count` payments. Returns their records, oldest first. */
  async step(count) {
    const out = [];
    for (let k = 0; k < count; k++) out.push(await this.#one());
    return out;
  }

  async #one() {
    const { ws } = this;
    const version = ws.inForce;
    if (!version) throw new Error('No list version is in force, so the stream cannot screen.');
    const event = makeEvent(this.index++, this.pools, this.seed);
    const nowMs = this.clock();
    const t0 = this.perf();
    // The engine's own functions: exact, case-insensitive address match, then the hold policy.
    const matches = matchIn(version, event.to);
    const rule = matches.length ? null : evaluatePolicy(ws.policy, { amountUsd: event.amountUsd, originator: event.originator });
    const outcome = matches.length ? 'BLOCK' : rule ? 'HOLD' : 'ALLOW';
    const params = {
      payment_id: `LV-${String(event.i + 1).padStart(6, '0')}`, outcome, beneficiary_address: event.to, from_address: event.from,
      chain: event.chain, asset: event.asset, amount_usd: event.amountUsd, originator_info_present: event.originator,
      source: 'demo_stream', synthetic: true,
    };
    if (rule) params.policy_rule = rule.id;
    const reasons = matches.length ? matches.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}`) : rule ? [`policy_rule=${rule.id}`, `threshold_usd=${rule.thresholdUsd}`] : ['clean'];
    if (this.ledger.size >= this.maxReceipts) this.#roll();
    const entry = await this.ledger.append({
      type: 'stablecoin_payment_screen', params, decision: outcome === 'BLOCK' ? 'DENY' : outcome === 'HOLD' ? 'HOLD' : 'ALLOW', outcome, reasons, agentId: STREAM_AGENT,
    }, version, new Date(nowMs));
    const ms = this.perf() - t0;
    const record = {
      ...event, t: nowMs, outcome, rule: rule?.id ?? null, entries: matches, receiptId: entry.receipt.receipt_id, ms,
      versionId: version.id, epoch: this.epoch,
    };
    this.#account(record);
    return record;
  }

  #roll() {
    this.priorHead = this.ledger.head();
    this.epoch++;
    this.ledger = new Ledger({ idPrefix: 'd' });
  }

  #account(r) {
    this.issued++;
    this.events.push(r);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    const key = r.outcome.toLowerCase();
    const sec = Math.floor(r.t / 1000);
    const bucket = this.buckets.get(sec) ?? emptyBucket();
    bucket[key]++;
    bucket.usd += r.amountUsd;
    this.buckets.set(sec, bucket);
    if (this.buckets.size > BUCKET_KEEP_S + 5) for (const k of this.buckets.keys()) if (k < sec - BUCKET_KEEP_S) this.buckets.delete(k);
    this.latency.push({ t: r.t, ms: r.ms });
    if (this.latency.length > LATENCY_SAMPLES) this.latency.splice(0, this.latency.length - LATENCY_SAMPLES);
    this.totals[key]++;
    this.totals.usd += r.amountUsd;
    const ca = `${r.chain}|${r.asset}`;
    const row = this.byChainAsset.get(ca) ?? { chain: r.chain, asset: r.asset, n: 0, usd: 0, hold: 0, block: 0 };
    row.n++;
    row.usd += r.amountUsd;
    if (key !== 'allow') row[key]++;
    this.byChainAsset.set(ca, row);
    if (key !== 'allow') {
      const hour = Math.floor(r.t / HOUR_MS);
      const flags = this.flagsByHour.get(hour) ?? { hold: 0, block: 0 };
      flags[key]++;
      this.flagsByHour.set(hour, flags);
    }
    if (key === 'hold') {
      const d = new Date(r.t);
      const cell = d.getUTCDay() * 24 + d.getUTCHours();
      this.holdsByCell.set(cell, (this.holdsByCell.get(cell) ?? 0) + 1);
    }
  }

  /** Per-bucket counts for the last `count` buckets of `bucketS` seconds ending at endMs. Oldest first. */
  series(endMs, bucketS, count) {
    const endSec = Math.floor(endMs / 1000);
    const out = [];
    for (let b = count - 1; b >= 0; b--) {
      const from = endSec - (b + 1) * bucketS + 1;
      const row = { t: (from + bucketS - 1) * 1000, ...emptyBucket(), total: 0 };
      for (let s = from; s < from + bucketS; s++) {
        const bucket = this.buckets.get(s);
        if (!bucket) continue;
        row.allow += bucket.allow; row.hold += bucket.hold; row.block += bucket.block; row.usd += bucket.usd;
      }
      row.total = row.allow + row.hold + row.block;
      out.push(row);
    }
    return out;
  }

  /** p50 and p95 screening latency per window of `bucketS` seconds. null where a window has no samples. */
  latencySeries(endMs, bucketS, count) {
    const span = bucketS * 1000;
    const out = [];
    for (let b = count - 1; b >= 0; b--) {
      const to = endMs - b * span;
      const sample = this.latency.filter((s) => s.t > to - span && s.t <= to).map((s) => s.ms).sort((a, c) => a - c);
      out.push({ t: to, n: sample.length, p50: percentile(sample, 50), p95: percentile(sample, 95) });
    }
    return out;
  }

  /** p50 and p95 over everything still held. */
  latencySummary() {
    const sample = this.latency.map((s) => s.ms).sort((a, b) => a - b);
    return { n: sample.length, p50: percentile(sample, 50), p95: percentile(sample, 95) };
  }

  /** Screenings per second over the last `windowS` seconds. */
  rate(endMs, windowS = 5) {
    return this.series(endMs, 1, windowS).reduce((s, r) => s + r.total, 0) / windowS;
  }

  /** Live flags (holds and hits) per UTC hour for the last `hours` hours ending at endMs. */
  flagsPerHour(endMs, hours) {
    const end = Math.floor(endMs / HOUR_MS);
    return Array.from({ length: hours }, (_, k) => {
      const hour = end - (hours - 1 - k);
      const f = this.flagsByHour.get(hour) ?? { hold: 0, block: 0 };
      return { t: hour * HOUR_MS, hold: f.hold, block: f.block };
    });
  }

  /** Checks the rolling ledger with the real verifier. */
  verify() {
    return this.ledger.verifyAll();
  }
}

/** Drives a LiveTape on a timer. States: off, live, paused. Browser use only. */
export class LiveRunner {
  constructor(tape, { onTick = () => {}, onState = () => {}, schedule = setTimeout, cancel = clearTimeout, now = () => performance.now() } = {}) {
    this.tape = tape;
    this.onTick = onTick;
    this.onState = onState;
    this.schedule = schedule;
    this.cancel = cancel;
    this.now = now;
    this.state = 'off';
    this.speed = 1;
    this.carry = 0;
    this.last = 0;
    this.timer = null;
    this.busy = false;
  }

  #set(state) {
    this.state = state;
    this.onState(state);
  }

  start() {
    if (this.state === 'live') return;
    this.carry = 0;
    this.last = this.now();
    this.#set('live');
    this.#loop();
  }

  pause() {
    if (this.state !== 'live') return;
    this.cancel(this.timer);
    this.timer = null;
    this.#set('paused');
  }

  resume() { this.start(); }

  stop() {
    this.cancel(this.timer);
    this.timer = null;
    if (this.state !== 'off') this.#set('off');
  }

  setSpeed(speed) {
    if (!SPEEDS.includes(speed)) throw new RangeError(`Speed must be one of ${SPEEDS.join(', ')}.`);
    this.speed = speed;
    this.onState(this.state);
  }

  #loop() {
    this.timer = this.schedule(async () => {
      if (this.state !== 'live') return;
      const t = this.now();
      this.carry = Math.min(this.carry + ((t - this.last) / 1000) * BASE_RATE * this.speed, MAX_PER_TICK * 2);
      this.last = t;
      const n = Math.min(Math.floor(this.carry), MAX_PER_TICK);
      this.carry -= n;
      if (n > 0 && !this.busy) {
        this.busy = true;
        try {
          const records = await this.tape.step(n);
          this.onTick(records, this.now() - t);
        } finally {
          this.busy = false;
        }
      }
      if (this.state === 'live') this.#loop();
    }, TICK_MS);
  }
}
