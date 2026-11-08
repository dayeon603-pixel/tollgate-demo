/**
 * Proof gap: the public measurement of how often public data cannot show that an OFAC listing came
 * before a stablecoin freeze, and what the live ordering run found. Figures are copied as the report
 * prints them (data/proofgap.json, built from results/proof_gap/REPORT.md and results/live_proof/
 * LIVE_PROOF.md), never rounded again. It is evidence of order, not of legality.
 */
import { card, clear, h, svg } from './dom.js';
import { sourceRef } from './moat-ui.js';
import { loadMoatData } from './moat-data.js';
import { getSettings } from './settings.js';

const W = 960;
const ROW_H = 40;
const M = { left: 250, right: 190, top: 28, bottom: 30 };
const PLOT_W = W - M.left - M.right;
const HEADLINE = { stream: 'USDC (Ethereum)', subset: 'after 2023 12 09' };
const INTERVAL = /^([\d.]+)% \[([\d.]+)%, ([\d.]+)%\]$/;
const SHARE_BARS = [['A', 'Provable: listed a calendar day before'], ['B', 'Same day: not provable'], ['C', 'Freeze dated before the listing']];
const TOOLTIP_CHAR_W = 6.3;

/** "93.4% [86.7%, 100.0%]" -> { point, lo, hi } as numbers 0 to 100. Raises on any other shape. */
export function parseInterval(text) {
  const m = INTERVAL.exec(String(text).trim());
  if (!m) throw new Error(`Not an interval: "${text}"`);
  return { point: Number(m[1]), lo: Number(m[2]), hi: Number(m[3]) };
}

const label = (r) => `${r.stream}, ${r.subset.replace(/(\d{4}) (\d{2}) (\d{2})/, '$1-$2-$3')}`;

function forest(rows, reduced) {
  const H = M.top + rows.length * ROW_H + M.bottom;
  const x = (v) => M.left + (v / 100) * PLOT_W;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'forest', role: 'group', 'aria-roledescription': 'interval chart', 'aria-label': 'Proof gap by stream, with 95 percent intervals. The same numbers are in the table below.' });
  for (const v of [0, 25, 50, 75, 100]) {
    root.append(svg('line', { x1: x(v), x2: x(v), y1: M.top - 8, y2: M.top + rows.length * ROW_H, class: 'tchart__gl' }));
    const t = svg('text', { x: x(v), y: H - 10, class: 'tchart__ax', 'text-anchor': v === 0 ? 'start' : v === 100 ? 'end' : 'middle' });
    t.textContent = `${v}%`;
    root.append(t);
  }
  const tip = svg('g', { class: 'lane__tip', visibility: 'hidden' });
  const tipBg = svg('rect', { rx: 4, class: 'tchart__tipbg' });
  const tipText = svg('text', { class: 'tchart__tiptext' });
  tip.append(tipBg, tipText);
  const bars = [];
  rows.forEach((r, i) => {
    const y = M.top + i * ROW_H + ROW_H / 2;
    const gap = parseInterval(r.gap);
    const headline = r.stream === HEADLINE.stream && r.subset === HEADLINE.subset;
    const g = svg('g', { class: `forest__row${headline ? ' forest__row--head' : ''}`, tabindex: 0, role: 'img', 'aria-label': `${label(r)}: proof gap ${r.gap}, ${r.n} freezes from ${r.designations} designations.` });
    const name = svg('text', { x: M.left - 12, y: y + 4, class: 'forest__name', 'text-anchor': 'end' });
    name.textContent = label(r);
    const value = svg('text', { x: W - M.right + 14, y: y + 4, class: 'forest__value' });
    value.textContent = r.gap;
    const line = svg('line', { x1: x(gap.lo), x2: x(gap.hi), y1: y, y2: y, class: 'forest__ci' });
    const capL = svg('line', { x1: x(gap.lo), x2: x(gap.lo), y1: y - 6, y2: y + 6, class: 'forest__ci' });
    const capR = svg('line', { x1: x(gap.hi), x2: x(gap.hi), y1: y - 6, y2: y + 6, class: 'forest__ci' });
    const dot = svg('circle', { cx: x(gap.point), cy: y, r: headline ? 7 : 5.5, class: 'forest__dot' });
    g.append(svg('rect', { x: 0, y: y - ROW_H / 2, width: W, height: ROW_H, class: 'forest__hit' }), name, line, capL, capR, dot, value);
    const show = () => {
      while (tipText.firstChild) tipText.firstChild.remove();
      const lines = [label(r), `n = ${r.n} freezes, ${r.designations} designations`, `Proof gap ${r.gap}`];
      lines.forEach((l, k) => { const s = svg('tspan', { x: 10, y: 17 + k * 14, class: k === 0 ? 'tchart__tiphead' : '' }); s.textContent = l; tipText.append(s); });
      const w = Math.max(...lines.map((l) => l.length)) * TOOLTIP_CHAR_W + 20;
      tipBg.setAttribute('width', w); tipBg.setAttribute('height', lines.length * 14 + 10);
      tip.setAttribute('transform', `translate(${Math.min(W - w - 4, Math.max(M.left, x(gap.point) - w / 2)).toFixed(0)} ${Math.max(0, y - 60).toFixed(0)})`);
      tip.setAttribute('visibility', 'visible');
    };
    g.addEventListener('pointerenter', show); g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tip.setAttribute('visibility', 'hidden')); g.addEventListener('blur', () => tip.setAttribute('visibility', 'hidden'));
    bars.push({ line, capL, capR, dot, gap, x, y });
    root.append(g);
  });
  root.append(tip);
  // Intervals open from the point outward on first draw (skipped for reduced motion).
  if (!reduced) {
    const start = performance.now();
    const DUR = 600;
    const frame = (now) => {
      const k = Math.min(1, (now - start) / DUR);
      const e = 1 - (1 - k) ** 3;
      for (const b of bars) {
        const lo = b.gap.point + (b.gap.lo - b.gap.point) * e; const hi = b.gap.point + (b.gap.hi - b.gap.point) * e;
        b.line.setAttribute('x1', b.x(lo)); b.line.setAttribute('x2', b.x(hi));
        b.capL.setAttribute('x1', b.x(lo)); b.capL.setAttribute('x2', b.x(lo)); b.capR.setAttribute('x1', b.x(hi)); b.capR.setAttribute('x2', b.x(hi));
      }
      if (k < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  return root;
}

function shares(rows) {
  const sw = 560;
  const rowH = 34;
  const left = 250;
  const H = 12 + rows.length * rowH + 8;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'forest', role: 'img', 'aria-label': 'For each stream, the split between freezes whose order public data can prove (A), same-day freezes it cannot (B) and freezes dated before the listing (C). The table below has the numbers.' });
  rows.forEach((r, i) => {
    const y = 8 + i * rowH;
    const name = svg('text', { x: left - 12, y: y + 17, class: 'forest__name', 'text-anchor': 'end' });
    name.textContent = label(r);
    root.append(name);
    let cursor = left;
    for (const [key, text] of SHARE_BARS) {
      const { point } = parseInterval(r[key]);
      const width = (point / 100) * sw;
      const rect = svg('rect', { x: cursor, y, width: Math.max(0, width), height: 22, class: `shr shr--${key.toLowerCase()}`, tabindex: 0, role: 'img', 'aria-label': `${label(r)}: ${text} ${r[key]}` });
      const title = svg('title', {});
      title.textContent = `${text}: ${r[key]}`;
      rect.append(title);
      root.append(rect);
      if (width > 46) { const t = svg('text', { x: cursor + width / 2, y: y + 15, class: 'seg__text', 'text-anchor': 'middle' }); t.textContent = `${point}%`; root.append(t); }
      cursor += width;
    }
  });
  return root;
}

export async function renderProofGap(ctx, root) {
  clear(root);
  root.append(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton__row' }), h('div', { class: 'skeleton__row' })));
  let data;
  try {
    data = await loadMoatData('proofgap');
  } catch (error) {
    clear(root).append(h('div', { class: 'banner', 'data-state': 'unsupported', role: 'alert' }, h('span', { class: 'banner__lead', text: 'The proof-gap data could not be read' }), h('span', { class: 'banner__detail', text: error.message })));
    return;
  }
  clear(root);
  const reduced = getSettings().reduceMotion || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const live = data.live;
  const head = data.rows.find((r) => r.stream === HEADLINE.stream && r.subset === HEADLINE.subset);
  const eth = data.rows.find((r) => r.stream === HEADLINE.stream && r.subset === 'all');
  const tron = data.rows.find((r) => r.stream === 'USDT (Tron)' && r.subset === 'all');
  const against = live.k !== undefined ? live.N - live.k : null;

  const table = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'pg-table' },
    h('caption', { class: 'sr', text: 'Proof gap by stream, as the report prints it' }),
    h('thead', {}, h('tr', {}, ['Stream', 'Subset', 'n (designations)', 'A: provable', 'B: same day', 'C: before listing', 'Proof gap B + C', 'M: mirror listed first'].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', {}, data.rows.map((r) => h('tr', { class: `grid__row${r === head ? ' grid__row--head' : ''}` },
      h('td', { 'data-label': 'Stream', text: r.stream }), h('td', { 'data-label': 'Subset', text: r.subset }),
      h('td', { 'data-label': 'n (designations)', class: 'num mono', text: `${r.n} (${r.designations})` }),
      h('td', { 'data-label': 'A', class: 'mono', text: r.A }), h('td', { 'data-label': 'B', class: 'mono', text: r.B }), h('td', { 'data-label': 'C', class: 'mono', text: r.C }),
      h('td', { 'data-label': 'Proof gap', class: 'mono' }, h('strong', { text: r.gap })), h('td', { 'data-label': 'M', class: 'mono', text: r.M }))))));

  root.append(
    h('div', { class: 'proof-label', role: 'note' }, h('strong', { text: 'Measured from public data; evidence of order, not legality.' }), ' Nothing here says a freeze was lawful or unlawful.'),
    card('The gap, in one number', { id: 'pg-head', sub: 'Pre-registered before the data was read. Intervals are 95 percent, cluster bootstrap over designations, B = 10000, seed 20261026.' },
      h('div', { class: 'cardbody' },
        h('div', { class: 'bigstat' },
          h('p', { class: 'bigstat__num', id: 'pg-num', text: head.gap.split(' ')[0] }),
          h('p', { class: 'bigstat__text' }, `of ${head.n} USDC freezes on Ethereum after 2023-12-09 (${head.designations} designations) have no order that official public data can prove. The interval is ${head.gap.slice(head.gap.indexOf('['))}.`)),
        h('p', { class: 'field__hint', text: `The official OFAC posting carries a date, a freeze carries a second. When they fall on the same New York date, public data cannot say which came first. Across all of USDC on Ethereum (${eth.n} addresses) the gap is ${eth.gap}; for USDT on Tron (${tron.n} addresses) it is ${tron.gap}.` }),
        h('p', { class: 'field__hint' }, 'Source: ', sourceRef(data.source.path, data.source.sha256), ' and ', sourceRef(data.source_json.path, data.source_json.sha256), `. Pre-registration: ${data.prereg}.`))),
    card('Proof gap by stream', { id: 'pg-forest', sub: 'Dot is the share, the line is the 95 percent interval, numbers on the right are the report\'s own text. Hover or focus a row.' }, h('div', { class: 'cardbody lanebox' }, forest(data.rows, reduced))),
    card('What public data can and cannot order', { id: 'pg-shares', sub: 'Each bar is 100 percent of that stream\'s freezes.' },
      h('div', { class: 'cardbody lanebox' }, shares(data.rows),
        h('ul', { class: 'legend legend--inline' }, SHARE_BARS.map(([key, text]) => h('li', {}, h('span', { class: `swatch swatch--${key.toLowerCase()}`, 'aria-hidden': 'true' }), `${key}: ${text}`))))),
    card('The report\'s table', { id: 'pg-tbl', sub: `Copied from ${data.source.path}. Percentages are the report's text.` }, table),
    card('What a receipt adds', { id: 'pg-adds' }, h('div', { class: 'cardbody' },
      h('p', { text: `A${data.adds.replace('What a Tollgate receipt adds: a', '').replace(/`/g, '')}` }), h('p', { class: 'field__hint', text: data.not_checked }))),
    card('Live ordering run', { id: 'pg-live', sub: `Window ${live.t0} to ${live.t1}. Pre-registered in docs/PREREG_LIVE_PROOF.md.` }, h('div', { class: 'cardbody' },
      h('div', { class: 'bigstat' },
        h('p', { class: 'bigstat__num', id: 'pg-live-num', text: `${live.k} of ${live.N}` }),
        h('p', { class: 'bigstat__text', text: live.headline })),
      h('div', { class: 'ratio', role: 'img', 'aria-label': `${live.k} of ${live.N} freezes of a newly listed address have a provable order` },
        Array.from({ length: live.N }, (_, i) => h('span', { class: `ratio__dot${i < live.k ? ' ratio__dot--yes' : ''}`, title: i < live.k ? 'Provable order' : 'Not provable' }))),
      h('p', { class: 'field__hint', text: `${live.k} provable, ${against} not provable. With ${live.N} freezes this is a count, not an estimate, and it comes with no interval. The anchor bound says our receipt of the posting existed by that time; the posting may have been published earlier. The proof is one-sided: listing before freeze. Evidence of ordering only, not a legal determination about any freeze.` }),
      h('p', { class: 'field__hint' }, 'Source: ', sourceRef(live.source.path, live.source.sha256), '. Counts against us are listed in that file; three freezes (obs:176, obs:178, obs:182) were not provable against posting obs:148.'))),
  );
}
