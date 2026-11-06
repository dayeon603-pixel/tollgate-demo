/**
 * Direct counterparty graph for one address, built only from this demo's synthetic payments.
 * Nodes are the addresses that sent to or received from the selected address; a node is flagged
 * when its address is an exact match on the list in force. There is no multi-hop tracing and no
 * scoring of any kind.
 */
import { matchIn } from './lists.js';
import { seededMeta } from './stream.js';

export const GRAPH_MAX_NODES = 18;
export const GRAPH_SOURCES = { history: 'Seeded history', live: 'Demo stream' };

/**
 * Every synthetic payment the demo holds: the seeded workspace history (sender, chain and asset
 * are assigned by the demo) and the payments still in the live window.
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
  return out;
}

/**
 * Builds the graph around `address`.
 *
 * Args: payments from collectPayments; address; version, the list version in force (for flags);
 *   maxNodes, the most counterparties drawn (the rest are counted, not drawn).
 * Returns: { center, nodes, hidden, totalCounterparties, paymentCount } where each node is
 *   { address, sentUsd (counterparty to centre), receivedUsd (centre to counterparty), count,
 *     valueUsd, listed, entries }.
 */
export function buildGraph(payments, address, version, maxNodes = GRAPH_MAX_NODES) {
  const key = address.toLowerCase();
  const nodes = new Map();
  let paymentCount = 0;
  for (const p of payments) {
    const from = p.from.toLowerCase();
    const to = p.to.toLowerCase();
    if (from !== key && to !== key) continue;
    if (from === to) continue;
    paymentCount++;
    const otherAddress = from === key ? p.to : p.from;
    const k = otherAddress.toLowerCase();
    if (!nodes.has(k)) nodes.set(k, { address: otherAddress, sentUsd: 0, receivedUsd: 0, count: 0, valueUsd: 0, listed: false, entries: [] });
    const n = nodes.get(k);
    if (from === key) n.receivedUsd += p.usd; else n.sentUsd += p.usd;
    n.valueUsd += p.usd;
    n.count++;
  }
  const all = Array.from(nodes.values());
  for (const n of all) {
    n.entries = matchIn(version, n.address);
    n.listed = n.entries.length > 0;
  }
  all.sort((a, b) => Number(b.listed) - Number(a.listed) || b.valueUsd - a.valueUsd || a.address.localeCompare(b.address));
  const shown = all.slice(0, maxNodes);
  const entries = matchIn(version, address);
  return {
    center: { address, listed: entries.length > 0, entries }, nodes: shown, hidden: all.length - shown.length,
    totalCounterparties: all.length, paymentCount,
  };
}

/** Deterministic ring layout: the centre in the middle, counterparties evenly around it. */
export function layoutGraph(graph, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) / 2 - 46;
  const n = graph.nodes.length;
  return graph.nodes.map((node, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, n)) * Math.PI * 2;
    return { node, x: cx + Math.cos(angle) * r * (width > height ? 1.35 : 1), y: cy + Math.sin(angle) * r };
  });
}

/** Edge width in px, by value. */
export function edgeWidth(value, max, minPx = 1, maxPx = 7) {
  if (!max) return minPx;
  return minPx + (maxPx - minPx) * Math.sqrt(Math.min(1, value / max));
}

/** Addresses worth offering as a starting point: listed ones with payments, then the busiest. */
export function suggestedAddresses(payments, version, limit = 8) {
  const seen = new Map();
  for (const p of payments) {
    for (const a of [p.to, p.from]) {
      const k = a.toLowerCase();
      const row = seen.get(k) ?? { address: a, count: 0, listed: false };
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
  rows.sort((a, b) => a.rank - b.rank || b.count - a.count || a.address.localeCompare(b.address));
  return rows.slice(0, limit);
}
