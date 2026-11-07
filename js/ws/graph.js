/**
 * Counterparty graph for one address, built only from this demo's synthetic payments. Nodes are
 * addresses that sent to or received from the selected address (one hop) or from one of those
 * (two hops); a node is flagged when its address is an exact match on the list in force. Every
 * edge is a payment that exists in the demo. There is no scoring of any kind.
 */
import { matchIn } from './lists.js';
import { hashString, isTronAddress, seededMeta } from './stream.js';
import { between, rng } from './util.js';

export const GRAPH_MAX_NODES = 60;
export const GRAPH_HOPS = [1, 2];
/** Share of the node budget that one-hop nodes may use when two hops are shown. */
const HOP1_SHARE = 0.45;
export const GRAPH_SOURCES = { history: 'Seeded history', live: 'Demo stream', background: 'Synthetic background' };

const BG_LISTED_RANGE = [4, 9];
const BG_ORDINARY_RANGE = [2, 5];
const BG_ORDINARY_SHARE = 0.4;
const BG_PEER_PAIRS = 70;
const BG_SALT = 'graph-background-v1';

/**
 * Extra synthetic payments so the graph has structure. The seeded history gives every address one
 * or two payments, which is too thin to look at. These are generated from the address itself
 * (listed addresses get four to nine senders, some ordinary ones two to five), plus payments
 * between ordinary addresses. They are not screened and have no receipt: the UI labels them
 * "Synthetic background". Pure and deterministic.
 *
 * Args: txs, the seeded workspace payments; pools, the stream's address pools; version, the list
 *   version in force.
 * Returns: [{ from, to, usd, chain, asset, t, outcome: null, source: 'background', id }]
 */
export function backgroundPayments(txs, pools, version) {
  if (!txs.length) return [];
  const times = txs.map((tx) => Date.parse(tx.ts));
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const out = [];
  const make = (rand, from, to, n) => {
    const tron = isTronAddress(to);
    out.push({ from, to, usd: Math.round(10 ** (1.8 + rand() * 3.4)), chain: tron ? 'tron' : 'ethereum', asset: rand() < 0.6 ? 'USDT' : 'USDC', t: Math.round(lo + rand() * (hi - lo)), outcome: null, source: 'background', id: `BG-${hashString(`${BG_SALT}|${to}|${from}|${n}`).toString(16).padStart(8, '0')}` });
  };
  const senderFor = (rand, address) => {
    const pool = isTronAddress(address) ? pools.tron : pools.eth;
    let from = pool[Math.floor(rand() ** 1.3 * pool.length)];
    if (from.toLowerCase() === address.toLowerCase()) from = pool[(pool.indexOf(from) + 1) % pool.length];
    return from;
  };
  const seen = new Set();
  for (const tx of txs) {
    const key = tx.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rand = rng(hashString(`${BG_SALT}|${key}`));
    const listed = matchIn(version, tx.address).length > 0;
    const [min, max] = listed ? BG_LISTED_RANGE : BG_ORDINARY_RANGE;
    const count = listed || rand() < BG_ORDINARY_SHARE ? between(rand, min, max) : 0;
    for (let n = 0; n < count; n++) make(rand, senderFor(rand, tx.address), tx.address, n);
  }
  const rand = rng(hashString(`${BG_SALT}|peers`));
  for (const pool of [pools.eth, pools.tron]) {
    const pairs = Math.round(BG_PEER_PAIRS * (pool.length / (pools.eth.length + pools.tron.length)));
    for (let n = 0; n < pairs; n++) {
      const to = pool[Math.floor(rand() ** 1.6 * pool.length)];
      const from = senderFor(rand, to);
      if (from.toLowerCase() !== to.toLowerCase()) make(rand, from, to, n);
    }
  }
  return out;
}

/**
 * Every synthetic payment the demo holds: the seeded workspace history (sender, chain and asset
 * are assigned by the demo), the payments still in the live window, and the synthetic background.
 *
 * Returns: [{ from, to, usd, chain, asset, t, outcome, source, id }]
 */
export function collectPayments(ws, tape) {
  const out = [];
  for (const tx of ws.txs) {
    const m = seededMeta(tx, tape.pools);
    out.push({ from: m.from, to: tx.address, usd: tx.amountUsd ?? 0, chain: m.chain, asset: m.asset, t: Date.parse(tx.ts), outcome: tx.outcome, source: 'history', id: tx.id });
  }
  for (const e of tape.events) out.push({ from: e.from, to: e.to, usd: e.amountUsd, chain: e.chain, asset: e.asset, t: e.t, outcome: e.outcome, source: 'live', id: `LV-${String(e.i + 1).padStart(6, '0')}` });
  out.push(...backgroundPayments(ws.txs, tape.pools, ws.inForce));
  return out;
}

const lower = (a) => a.toLowerCase();

/** Map of lowercased address to the Set of its distinct counterparties. */
function adjacency(payments) {
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a).add(b);
  };
  for (const p of payments) {
    const from = lower(p.from);
    const to = lower(p.to);
    if (from === to) continue;
    link(from, to);
    link(to, from);
  }
  return adj;
}

/** The address with the most distinct direct counterparties (ties: the lower address). '' if none. */
export function busiestAddress(payments) {
  let best = '';
  let bestCount = 0;
  for (const [address, set] of adjacency(payments)) {
    if (set.size > bestCount || (set.size === bestCount && address < best)) { best = address; bestCount = set.size; }
  }
  if (!best) return '';
  const original = payments.find((p) => lower(p.from) === best)?.from ?? payments.find((p) => lower(p.to) === best)?.to;
  return original ?? best;
}

/**
 * Builds the graph around `address`.
 *
 * Args: payments from collectPayments; address; version, the list version in force (for flags);
 *   maxNodes, the most counterparties drawn (the rest are counted, not drawn); hops, 1 or 2.
 * Returns: { center, nodes, edges, hidden, totalCounterparties, paymentCount, hops } where each node is
 *   { address, hop, parent, sentUsd (node to its parent), receivedUsd (parent to node), count,
 *     valueUsd, listed, entries } and each edge is { from, to, count, usd } for one direction of
 *   payments between two drawn addresses. For hops = 1 the edges are the centre's own; for 2 they
 *   are every demo payment between two drawn addresses.
 */
export function buildGraph(payments, address, version, maxNodes = GRAPH_MAX_NODES, hops = 1) {
  const key = lower(address);
  const pairStats = (rows, self) => {
    const nodes = new Map();
    for (const p of rows) {
      const from = lower(p.from);
      const to = lower(p.to);
      if (from === to || (from !== self && to !== self)) continue;
      const otherAddress = from === self ? p.to : p.from;
      const k = lower(otherAddress);
      if (!nodes.has(k)) nodes.set(k, { address: otherAddress, sentUsd: 0, receivedUsd: 0, count: 0, valueUsd: 0, listed: false, entries: [] });
      const n = nodes.get(k);
      if (from === self) n.receivedUsd += p.usd; else n.sentUsd += p.usd;
      n.valueUsd += p.usd;
      n.count++;
    }
    return nodes;
  };
  const flag = (list) => {
    for (const n of list) {
      n.entries = matchIn(version, n.address);
      n.listed = n.entries.length > 0;
    }
    list.sort((a, b) => Number(b.listed) - Number(a.listed) || b.valueUsd - a.valueUsd || a.address.localeCompare(b.address));
    return list;
  };
  const direct = pairStats(payments, key);
  const paymentCount = Array.from(direct.values()).reduce((sum, n) => sum + n.count, 0);
  const all = flag(Array.from(direct.values()));
  const hop1Cap = hops === 2 ? Math.max(1, Math.ceil(maxNodes * HOP1_SHARE)) : maxNodes;
  const nodes = all.slice(0, hop1Cap).map((n) => ({ ...n, hop: 1, parent: address }));
  let hidden = all.length - nodes.length;
  let totalCounterparties = all.length;

  if (hops === 2 && nodes.length) {
    const shown = new Map([[key, true], ...nodes.map((n) => [lower(n.address), true])]);
    const candidates = new Map();
    for (const hop1 of nodes) {
      for (const n of flag(Array.from(pairStats(payments, lower(hop1.address)).values()))) {
        const k = lower(n.address);
        if (shown.has(k) || k === key) continue;
        const prev = candidates.get(k);
        if (!prev || n.valueUsd > prev.valueUsd) candidates.set(k, { ...n, hop: 2, parent: hop1.address });
      }
    }
    const ranked = flag(Array.from(candidates.values()));
    const take = ranked.slice(0, Math.max(0, maxNodes - nodes.length));
    nodes.push(...take);
    hidden += ranked.length - take.length;
    totalCounterparties += ranked.length;
  }

  const drawn = new Set([key, ...nodes.map((n) => lower(n.address))]);
  const edgeMap = new Map();
  for (const p of payments) {
    const from = lower(p.from);
    const to = lower(p.to);
    if (from === to || !drawn.has(from) || !drawn.has(to)) continue;
    if (hops === 1 && from !== key && to !== key) continue;
    const k = `${from}>${to}`;
    const e = edgeMap.get(k) ?? { from: p.from, to: p.to, count: 0, usd: 0 };
    e.count++;
    e.usd += p.usd;
    edgeMap.set(k, e);
  }
  const entries = matchIn(version, address);
  return {
    center: { address, listed: entries.length > 0, entries }, nodes, edges: Array.from(edgeMap.values()), hidden,
    totalCounterparties, paymentCount, hops,
  };
}

/**
 * Everything the demo's payments say about one address, for the side panel.
 *
 * Returns: { address, listed, entries, paymentsIn, paymentsOut, inUsd, outUsd, totalUsd, first, last,
 *   counterparties, screened (payments that have a receipt in the explorer), streamed, background }
 */
export function addressProfile(payments, address, version) {
  const key = lower(address);
  const out = { address, listed: false, entries: matchIn(version, address), paymentsIn: 0, paymentsOut: 0, inUsd: 0, outUsd: 0, totalUsd: 0, first: null, last: null, counterparties: 0, screened: 0, streamed: 0, background: 0 };
  out.listed = out.entries.length > 0;
  const others = new Set();
  for (const p of payments) {
    const from = lower(p.from);
    const to = lower(p.to);
    if (from === to || (from !== key && to !== key)) continue;
    if (to === key) { out.paymentsIn++; out.inUsd += p.usd; others.add(from); } else { out.paymentsOut++; out.outUsd += p.usd; others.add(to); }
    out.totalUsd += p.usd;
    if (out.first === null || p.t < out.first) out.first = p.t;
    if (out.last === null || p.t > out.last) out.last = p.t;
    if (p.source === 'history' && to === key) out.screened++;
    else if (p.source === 'live') out.streamed++;
    else if (p.source === 'background') out.background++;
  }
  out.counterparties = others.size;
  return out;
}

const MIN_RING_Y = 100;
const MAX_RING_Y = 270;
const RING_STEP_Y = 120;
const SIDE_PAD = 70;
const VERT_PAD = 56;
const COLLIDE_PX = 30;
const RELAX_ROUNDS = 60;
export const GRAPH_MIN_HEIGHT = 300;

/**
 * Deterministic radial layout, centre in the middle, one-hop nodes on an ellipse, two-hop nodes on
 * an outer ellipse inside their parent's angular sector, then a short pass that pushes apart nodes
 * closer than COLLIDE_PX.
 *
 * Returns: { width, height, cx, cy, pos: [{ node, x, y }] } with the canvas height fitted to the content.
 */
export function layoutGraph(graph, width, height = 0) {
  const hop1 = graph.nodes.filter((n) => n.hop !== 2);
  const hop2 = graph.nodes.filter((n) => n.hop === 2);
  const ry1 = Math.min(MAX_RING_Y, Math.max(MIN_RING_Y, 40 + hop1.length * 9));
  const ry2 = ry1 + RING_STEP_Y;
  const ryOuter = hop2.length ? Math.min(ry2, MAX_RING_Y + RING_STEP_Y) : ry1;
  const fitH = Math.max(GRAPH_MIN_HEIGHT, Math.round(2 * (ryOuter + VERT_PAD)));
  const H = height > 0 ? height : fitH;
  const cx = width / 2;
  const cy = H / 2;
  const maxRx = Math.max(60, width / 2 - SIDE_PAD);
  const rx1 = Math.min(maxRx * (hop2.length ? 0.62 : 1), ry1 * 1.9);
  const rx2 = Math.min(maxRx, ry2 * 1.9);
  const sector = new Map();
  const weights = hop1.map((n) => 1 + Math.sqrt(hop2.filter((m) => m.parent === n.address).length) * 1.4);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  const pos = [];
  const placed = new Map();
  hop1.forEach((node, i) => {
    const span = (weights[i] / total) * Math.PI * 2;
    const angle = -Math.PI / 2 + acc + span / 2;
    acc += span;
    sector.set(node.address, { angle, span });
    const p = { node, x: cx + Math.cos(angle) * rx1, y: cy + Math.sin(angle) * (hop2.length ? ry1 * 0.62 : ry1), angle };
    pos.push(p);
    placed.set(node.address, p);
  });
  const slots = new Map();
  hop2.forEach((node) => {
    const sec = sector.get(node.parent) ?? { angle: -Math.PI / 2, span: Math.PI / 4 };
    const idx = slots.get(node.parent) ?? 0;
    slots.set(node.parent, idx + 1);
    const kids = hop2.filter((m) => m.parent === node.parent).length;
    const frac = kids === 1 ? 0.5 : idx / (kids - 1);
    const angle = sec.angle + (frac - 0.5) * sec.span * 0.9;
    const tier = kids > 5 ? idx % 2 : 0;
    pos.push({ node, x: cx + Math.cos(angle) * (rx2 + tier * 26), y: cy + Math.sin(angle) * (ry2 + tier * 26) * (ryOuter / ry2), angle });
  });
  for (let round = 0; round < RELAX_ROUNDS; round++) {
    let moved = false;
    for (let a = 0; a < pos.length; a++) {
      for (let b = a + 1; b < pos.length; b++) {
        const dx = pos[b].x - pos[a].x;
        const dy = pos[b].y - pos[a].y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= COLLIDE_PX) continue;
        const push = (COLLIDE_PX - d) / 2;
        const ux = dx / d || 1;
        const uy = dy / d;
        pos[a].x -= ux * push; pos[a].y -= uy * push;
        pos[b].x += ux * push; pos[b].y += uy * push;
        moved = true;
      }
    }
    for (const p of pos) {
      p.x = Math.min(width - 24, Math.max(24, p.x));
      p.y = Math.min(H - 24, Math.max(24, p.y));
    }
    if (!moved) break;
  }
  return { width, height: H, cx, cy, pos: pos.map(({ node, x, y }) => ({ node, x, y })) };
}

/** Edge width in px, by value. */
export function edgeWidth(value, max, minPx = 1, maxPx = 7) {
  if (!max) return minPx;
  return minPx + (maxPx - minPx) * Math.sqrt(Math.min(1, value / max));
}

/**
 * Addresses worth offering as a starting point: the busiest first, then listed ones with payments,
 * then the busiest of the rest. Each row carries its number of direct counterparties.
 */
export function suggestedAddresses(payments, version, limit = 8) {
  const adj = adjacency(payments);
  const seen = new Map();
  for (const p of payments) {
    for (const a of [p.to, p.from]) {
      const k = lower(a);
      const row = seen.get(k) ?? { address: a, count: 0, listed: false, counterparties: adj.get(k)?.size ?? 0 };
      row.count++;
      seen.set(k, row);
    }
  }
  const rows = Array.from(seen.values());
  for (const r of rows) {
    const entries = matchIn(version, r.address);
    r.listed = entries.length > 0;
    r.rank = !r.listed ? 2 : entries[0].synthetic ? 1 : 0;
  }
  rows.sort((a, b) => a.rank - b.rank || b.counterparties - a.counterparties || b.count - a.count || a.address.localeCompare(b.address));
  const busiest = busiestAddress(payments);
  const head = rows.filter((r) => lower(r.address) === lower(busiest));
  return [...head, ...rows.filter((r) => lower(r.address) !== lower(busiest))].slice(0, limit);
}
