/**
 * Proof gap: the public measurement of how often public data cannot show that an OFAC listing came
 * before a stablecoin freeze, and what the live ordering run found. Figures are copied as the report
 * prints them (data/proofgap.json, built from results/proof_gap/REPORT.md and results/live_proof/
 * LIVE_PROOF.md), never rounded again. It is evidence of order, not of legality.
 */
import { card, clear, h } from './dom.js';
import { categoryAxis, esc, mount, seriesColour, tooltipBase, valueAxis } from './echart.js';
import { sourceRef } from './moat-ui.js';
import { loadMoatData } from './moat-data.js';

const ROW_H = 34;
const HEADLINE = { stream: 'USDC (Ethereum)', subset: 'after 2023 12 09' };
const INTERVAL = /^([\d.]+)% \[([\d.]+)%, ([\d.]+)%\]$/;
const SHARE_BARS = [['A', 'Provable: listed a calendar day before'], ['B', 'Same day: not provable'], ['C', 'Freeze dated before the listing']];

/** "93.4% [86.7%, 100.0%]" -> { point, lo, hi } as numbers 0 to 100. Raises on any other shape. */
export function parseInterval(text) {
  const m = INTERVAL.exec(String(text).trim());
  if (!m) throw new Error(`Not an interval: "${text}"`);
  return { point: Number(m[1]), lo: Number(m[2]), hi: Number(m[3]) };
}

const label = (r) => `${r.stream}, ${r.subset.replace(/(\d{4}) (\d{2}) (\d{2})/, '$1-$2-$3')}`;

/** Forest plot: the share as a dot, the 95 percent interval as a line with caps, the report's own text on the right. */
function forest(rows) {
  const host = h('div', { class: 'echost' });
  host.style.height = `${rows.length * ROW_H + 40}px`;
  const el = h('div', { class: 'blist', role: 'img', id: 'pg-forest-chart', 'aria-label': `Proof gap by stream, with 95 percent intervals: ${rows.map((r) => `${label(r)} ${r.gap}`).join('; ')}.` }, host);
  const parsed = rows.map((r) => ({ r, gap: parseInterval(r.gap), headline: r.stream === HEADLINE.stream && r.subset === HEADLINE.subset }));
  mount(host, (t) => {
    const ink = t.ink;
    const accent = seriesColour('block');
    return {
      grid: { left: 8, right: 8, top: 8, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p) => { const d = parsed[p.dataIndex]; return `<div class="ect__head">${esc(label(d.r))}</div><div class="ect__row"><span class="ect__k">Proof gap</span><span class="ect__v">${esc(d.r.gap)}</span></div><div class="ect__row"><span class="ect__k">Freezes</span><span class="ect__v">${d.r.n}</span></div><div class="ect__row"><span class="ect__k">Designations</span><span class="ect__v">${d.r.designations}</span></div>`; } },
      xAxis: valueAxis(t, (v) => `${v}%`, { min: 0, max: 100, interval: 25 }),
      yAxis: [
        categoryAxis(t, parsed.map((d) => label(d.r)), null, { inverse: true, axisLine: { show: false }, axisLabel: { color: ink, fontSize: 12, fontFamily: t.sans } }),
        categoryAxis(t, parsed.map((d) => d.r.gap), null, { inverse: true, position: 'right', axisLine: { show: false }, axisLabel: { color: t.dim, fontSize: 12, fontFamily: t.sans } }),
      ],
      series: [
        { type: 'custom', silent: true, data: parsed.map((d, i) => [d.gap.lo, d.gap.hi, i]), encode: { x: [0, 1], y: 2 },
          renderItem: (params, api) => {
            const lo = api.coord([api.value(0), api.value(2)]);
            const hi = api.coord([api.value(1), api.value(2)]);
            const cap = 5;
            const style = { stroke: t.dim, lineWidth: 1.5 };
            return { type: 'group', children: [
              { type: 'line', shape: { x1: lo[0], y1: lo[1], x2: hi[0], y2: hi[1] }, style },
              { type: 'line', shape: { x1: lo[0], y1: lo[1] - cap, x2: lo[0], y2: lo[1] + cap }, style },
              { type: 'line', shape: { x1: hi[0], y1: hi[1] - cap, x2: hi[0], y2: hi[1] + cap }, style },
            ] };
          } },
        { type: 'scatter', data: parsed.map((d, i) => ({ value: [d.gap.point, i], symbolSize: d.headline ? 13 : 9, itemStyle: { color: d.headline ? accent : ink, borderColor: t.surface, borderWidth: 1.5 } })), z: 3 },
      ],
    };
  }).render();
  return el;
}

/** For each stream, 100 percent of its freezes split into A, B and C. */
function shares(rows) {
  const host = h('div', { class: 'echost' });
  host.style.height = `${rows.length * 32 + 16}px`;
  const el = h('div', { class: 'blist', role: 'img', id: 'pg-shares-chart', 'aria-label': 'For each stream, the split between freezes whose order public data can prove (A), same-day freezes it cannot (B) and freezes dated before the listing (C). The table below has the numbers.' }, host);
  const keys = ['seg-a', 'seg-b', 'seg-c'];
  mount(host, (t) => ({
    grid: { left: 8, right: 16, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p) => `<div class="ect__head">${esc(label(rows[p.dataIndex]))}</div><div class="ect__row"><span class="ect__sw ect__sw--${keys[p.seriesIndex]}"></span><span class="ect__k">${esc(SHARE_BARS[p.seriesIndex][1])}</span><span class="ect__v">${esc(rows[p.dataIndex][SHARE_BARS[p.seriesIndex][0]])}</span></div>` },
    xAxis: { type: 'value', max: 100, show: false },
    yAxis: categoryAxis(t, rows.map(label), null, { inverse: true, axisLine: { show: false }, axisLabel: { color: t.ink, fontSize: 12, fontFamily: t.sans } }),
    series: SHARE_BARS.map(([key], k) => ({
      type: 'bar', stack: 'all', name: key, barWidth: 18,
      data: rows.map((r) => parseInterval(r[key]).point),
      itemStyle: { color: seriesColour(keys[k]), borderColor: t.surface, borderWidth: 1 },
      label: { show: true, position: 'inside', color: t.dark ? '#0b1217' : '#fff', fontSize: 11, fontFamily: t.sans, formatter: (p) => (p.value >= 9 ? `${p.value}%` : '') },
      emphasis: { disabled: true },
    })),
  })).render();
  return el;
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
      h('td', { 'data-label': 'n (designations)', class: 'num', text: `${r.n} (${r.designations})` }),
      h('td', { 'data-label': 'A', class: 'tnum', text: r.A }), h('td', { 'data-label': 'B', class: 'tnum', text: r.B }), h('td', { 'data-label': 'C', class: 'tnum', text: r.C }),
      h('td', { 'data-label': 'Proof gap', class: 'tnum' }, h('strong', { text: r.gap })), h('td', { 'data-label': 'M', class: 'tnum', text: r.M }))))));

  root.append(
    h('div', { class: 'proof-label', role: 'note' }, h('strong', { text: 'Measured from public data; evidence of order, not legality.' }), ' Nothing here says a freeze was lawful or unlawful.'),
    card('The gap, in one number', { id: 'pg-head', sub: '95% interval, cluster bootstrap over designations' },
      h('div', { class: 'cardbody' },
        h('div', { class: 'bigstat' },
          h('p', { class: 'bigstat__num', id: 'pg-num', text: head.gap.split(' ')[0] }),
          h('p', { class: 'bigstat__text' }, `of ${head.n} USDC freezes on Ethereum after 2023-12-09 (${head.designations} designations) have no order that official public data can prove. The interval is ${head.gap.slice(head.gap.indexOf('['))}.`)),
        h('p', { class: 'field__hint', text: `The official OFAC posting carries a date, a freeze carries a second. When they fall on the same New York date, public data cannot say which came first. Across all of USDC on Ethereum (${eth.n} addresses) the gap is ${eth.gap}; for USDT on Tron (${tron.n} addresses) it is ${tron.gap}.` }),
        h('p', { class: 'field__hint' }, 'Source: ', sourceRef(data.source.path, data.source.sha256), ' and ', sourceRef(data.source_json.path, data.source_json.sha256), `. Pre-registration: ${data.prereg}.`))),
    card('Proof gap by stream', { id: 'pg-forest', sub: '95% intervals' }, h('div', { class: 'cardbody lanebox' }, forest(data.rows))),
    card('What public data can and cannot order', { id: 'pg-shares' },
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
