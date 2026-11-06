/** Chain and asset breakdown and a heatmap of holds by hour of day. History is seeded and synthetic. */
import { card, clear, h, money, svg } from './dom.js';
import { CHAIN_LABEL, CHAINS, seededMeta } from './stream.js';

const CELL_W = 24;
const CELL_H = 22;
const LEFT = 36;
const TOP = 20;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEVELS = 4;

/** Rows { chain, asset, n, usd, hold, block } from the seeded history plus the stream. */
export function chainAssetRows(ws, tape) {
  const map = new Map();
  const add = (chain, asset, usd, outcome, n = 1) => {
    const key = `${chain}|${asset}`;
    const row = map.get(key) ?? { chain, asset, n: 0, usd: 0, hold: 0, block: 0 };
    row.n += n; row.usd += usd;
    if (outcome === 'HOLD') row.hold++;
    if (outcome === 'BLOCK') row.block++;
    map.set(key, row);
  };
  for (const tx of ws.txs) { const m = seededMeta(tx, tape.pools); add(m.chain, m.asset, tx.amountUsd ?? 0, tx.outcome); }
  for (const r of tape.byChainAsset.values()) {
    const key = `${r.chain}|${r.asset}`;
    const row = map.get(key) ?? { chain: r.chain, asset: r.asset, n: 0, usd: 0, hold: 0, block: 0 };
    row.n += r.n; row.usd += r.usd; row.hold += r.hold; row.block += r.block;
    map.set(key, row);
  }
  return Array.from(map.values()).sort((a, b) => b.usd - a.usd);
}

/** 7 x 24 counts of holds by UTC weekday and hour: seeded history plus the stream. */
export function holdGrid(ws, tape) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const tx of ws.txs) {
    if (tx.outcome !== 'HOLD') continue;
    const d = new Date(tx.ts);
    grid[d.getUTCDay()][d.getUTCHours()]++;
  }
  for (const [cell, n] of tape.holdsByCell) grid[Math.floor(cell / 24)][cell % 24] += n;
  return grid;
}

export function renderFlow(ctx, root) {
  const { ws, live } = ctx;
  clear(root);
  const rows = chainAssetRows(ws, live.tape);
  const total = rows.reduce((s, r) => s + r.usd, 0) || 1;
  const byChain = CHAINS.map((c) => {
    const mine = rows.filter((r) => r.chain === c.id);
    return { id: c.id, label: c.label, n: mine.reduce((s, r) => s + r.n, 0), usd: mine.reduce((s, r) => s + r.usd, 0), hold: mine.reduce((s, r) => s + r.hold, 0), block: mine.reduce((s, r) => s + r.block, 0) };
  }).filter((c) => c.n);
  const maxUsd = Math.max(1, ...byChain.map((c) => c.usd));

  const bars = h('div', { class: 'cbars', role: 'list' }, byChain.map((c) => h('div', { class: 'cbar', role: 'listitem' },
    h('span', { class: 'cbar__label', text: c.label }),
    svg('svg', { viewBox: '0 0 100 8', class: 'cbar__svg', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, svg('rect', { x: 0, y: 0, width: 100, height: 8, class: 'cbar__bg' }), svg('rect', { x: 0, y: 0, width: ((c.usd / maxUsd) * 100).toFixed(1), height: 8, class: 'bar bar--allow' })),
    h('span', { class: 'cbar__val mono', text: `${money(c.usd)} · ${((c.usd / total) * 100).toFixed(0)}%` }))));

  const table = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'fl-table' },
    h('caption', { class: 'sr', text: 'Chain and asset breakdown' }),
    h('thead', {}, h('tr', {}, ['Chain', 'Asset', 'Payments', 'Value', 'Holds', 'Hits'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : '' }, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', { 'data-label': 'Chain', text: CHAIN_LABEL[r.chain] }), h('td', { 'data-label': 'Asset', text: r.asset }),
      h('td', { 'data-label': 'Payments', class: 'num mono', text: String(r.n) }), h('td', { 'data-label': 'Value', class: 'num mono', text: money(r.usd) }),
      h('td', { 'data-label': 'Holds', class: 'num mono', text: String(r.hold) }), h('td', { 'data-label': 'Hits', class: 'num mono', text: String(r.block) }))))));

  const grid = holdGrid(ws, live.tape);
  const max = Math.max(1, ...grid.flat());
  const level = (n) => (n === 0 ? 0 : Math.min(LEVELS, 1 + Math.floor((n / max) * (LEVELS - 1 + 0.999))));
  const hm = svg('svg', { viewBox: `0 0 ${LEFT + 24 * CELL_W + 4} ${TOP + 7 * CELL_H + 4}`, class: 'heat', role: 'img', 'aria-label': `Holds by UTC weekday and hour. Darkest cell: ${max} holds.`, id: 'fl-heat' });
  for (let hour = 0; hour < 24; hour += 3) { const t = svg('text', { x: LEFT + hour * CELL_W + CELL_W / 2, y: 12, class: 'chart__axis', 'text-anchor': 'middle' }); t.textContent = String(hour).padStart(2, '0'); hm.append(t); }
  DAYS.forEach((day, d) => {
    const t = svg('text', { x: LEFT - 6, y: TOP + d * CELL_H + CELL_H / 2 + 4, class: 'chart__axis', 'text-anchor': 'end' });
    t.textContent = day; hm.append(t);
    for (let hour = 0; hour < 24; hour++) {
      const n = grid[d][hour];
      const x = LEFT + hour * CELL_W;
      const y = TOP + d * CELL_H;
      const cell = svg('rect', { x: x + 1, y: y + 1, width: CELL_W - 2, height: CELL_H - 2, rx: 2, class: `hcell hcell--${level(n)}` });
      const title = svg('title', {}); title.textContent = `${day} ${String(hour).padStart(2, '0')}:00 UTC: ${n} hold${n === 1 ? '' : 's'}`;
      cell.append(title); hm.append(cell);
      if (n) { const label = svg('text', { x: x + CELL_W / 2, y: y + CELL_H / 2 + 3.5, class: `hnum hnum--${level(n)}`, 'text-anchor': 'middle' }); label.textContent = String(n); hm.append(label); }
    }
  });
  const scale = h('ul', { class: 'legend legend--inline' }, [0, 1, 2, 3, 4].map((l) => h('li', {}, svg('svg', { viewBox: '0 0 14 14', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('rect', { width: 14, height: 14, rx: 2, class: `hcell hcell--${l}` })), l === 0 ? 'none' : l === 1 ? 'fewer' : l === LEVELS ? `more (up to ${max})` : '')));

  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'Synthetic payments. ' }), 'Chains and assets for the seeded history are assigned by the demo (the signed receipt does not carry them). Stream payments carry them in the receipt. Hold times come from the demo generator, which sends payments between 06:00 and 20:00 UTC, so the empty hours say nothing about real traffic.'),
    h('div', { class: 'cols' },
      card('Value by chain', { id: 'fl-chain', sub: 'Seeded history plus the stream, synthetic dollars' }, h('div', { class: 'cardbody' }, bars)),
      card('Chain and asset', { id: 'fl-asset' }, table)),
    card('Holds by hour of day', { id: 'fl-heat-card', sub: 'Held by policy, UTC weekday and hour. Counts are printed in the cells.' }, h('div', { class: 'cardbody' }, hm, scale)));
}
