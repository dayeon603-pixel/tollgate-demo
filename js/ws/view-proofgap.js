/**
 * Proof gap: the public measurement of how often public data cannot show that an OFAC listing came
 * before a stablecoin freeze, and what the live ordering run found. Figures are copied as the report
 * prints them (data/proofgap.json, built from results/proof_gap/REPORT.md and results/live_proof/
 * LIVE_PROOF.md), never rounded again. It is evidence of order, not of legality.
 */
import { card, clear, h } from './dom.js';
import { categoryAxis, esc, mount, seriesColour, tooltipBase } from './echart.js';
import { sourceRef } from './moat-ui.js';
import { loadMoatData } from './moat-data.js';

const HEADLINE = { stream: 'USDC (Ethereum)', subset: 'after 2023 12 09' };
const INTERVAL = /^([\d.]+)% \[([\d.]+)%, ([\d.]+)%\]$/;
const SHARE_BARS = [['A', 'Listing came first (a day or more before)'], ['B', 'Same day: can\'t tell which came first'], ['C', 'Freeze is dated before the listing']];

/** "93.4% [86.7%, 100.0%]" -> { point, lo, hi } as numbers 0 to 100. Raises on any other shape. */
export function parseInterval(text) {
  const m = INTERVAL.exec(String(text).trim());
  if (!m) throw new Error(`Not an interval: "${text}"`);
  return { point: Number(m[1]), lo: Number(m[2]), hi: Number(m[3]) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plainDate = (subset) => subset.replace(/(\d{4}) (\d{2}) (\d{2})/, (_, y, m, d) => `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`);
const coin = (r) => r.stream.replace(/ \((.+)\)$/, ' on $1');
const period = (r) => (r.subset === 'all' ? 'All freezes' : `Since ${plainDate(r.subset.replace(/^after /, ''))}`);
const label = (r) => `${coin(r)}, ${period(r).toLowerCase()}`;
const isoDay = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const plainIso = (text) => String(text).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, isoDay);
const range = (text) => { const g = parseInterval(text); return `${g.lo.toFixed(1)}% to ${g.hi.toFixed(1)}%`; };

/** For each stream, 100 percent of its freezes split into A, B and C, with the gap (B + C) printed on the right. */
function shares(rows) {
  const host = h('div', { class: 'echost' });
  host.style.height = `${rows.length * 44}px`;
  const el = h('div', { class: 'blist', role: 'img', id: 'pg-shares-chart', 'aria-label': `For each coin and period, the share of freezes where public records show the listing came first, the share on the same day, and the share where the freeze is dated first: ${rows.map((r) => `${label(r)}: ${r.A} first, ${r.B} same day, ${r.C} freeze first`).join('; ')}.` }, host);
  const keys = ['seg-a', 'seg-b', 'seg-c'];
  mount(host, (t) => ({
    grid: { left: 8, right: 8, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p) => `<div class="ect__head">${esc(label(rows[p.dataIndex]))}</div><div class="ect__row"><span class="ect__sw ect__sw--${keys[p.seriesIndex]}"></span><span class="ect__k">${esc(SHARE_BARS[p.seriesIndex][1])}</span><span class="ect__v">${esc(rows[p.dataIndex][SHARE_BARS[p.seriesIndex][0]])}</span></div><div class="ect__row"><span class="ect__k">Freezes</span><span class="ect__v">${rows[p.dataIndex].n}</span></div>` },
    xAxis: { type: 'value', max: 100, show: false },
    yAxis: [
      categoryAxis(t, rows.map((r) => `{c|${coin(r)}}\n{p|${period(r)}}`), null, { inverse: true, axisLine: { show: false },
        axisLabel: { lineHeight: 16, rich: { c: { color: t.ink, fontSize: 13, fontWeight: 600, fontFamily: t.sans, align: 'right' }, p: { color: t.faint, fontSize: 12, fontFamily: t.sans, align: 'right' } } } }),
      categoryAxis(t, rows.map((r) => `{g|${parseInterval(r.gap).point}%}\n{s|can't tell}`), null, { inverse: true, position: 'right', axisLine: { show: false },
        axisLabel: { lineHeight: 16, rich: { g: { color: t.ink, fontSize: 14, fontWeight: 700, fontFamily: t.sans }, s: { color: t.faint, fontSize: 11, fontFamily: t.sans } } } }),
    ],
    series: SHARE_BARS.map(([key], k) => ({
      type: 'bar', stack: 'all', name: key, barWidth: 22,
      data: rows.map((r) => parseInterval(r[key]).point),
      itemStyle: { color: seriesColour(keys[k]), borderColor: t.surface, borderWidth: 2, borderRadius: 2 },
      label: { show: true, position: 'inside', color: k === 1 ? (t.dark ? '#0b1217' : '#1c262c') : (t.dark ? '#0b1217' : '#fff'), fontSize: 12, fontWeight: 600, fontFamily: t.sans, formatter: (p) => (p.value >= 9 ? `${p.value}%` : '') },
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
    h('caption', { class: 'sr', text: 'Proof gap by coin and period, as the report prints it, with 95 percent intervals' }),
    h('thead', {}, h('tr', {}, ['Coin', 'Period', 'Freezes (listings)', 'Listing first', 'Same day', 'Freeze first', "Can't tell (gap)"].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', {}, data.rows.map((r) => {
      const cell = (key, text, strong = false) => { const g = parseInterval(text); const v = h(strong ? 'strong' : 'span', { text: `${g.point}%` }); return h('td', { 'data-label': key, class: 'tnum' }, v, h('span', { class: 'pg-ci', text: `${g.lo}–${g.hi}%` })); };
      return h('tr', { class: `grid__row${r === head ? ' grid__row--head' : ''}` },
        h('td', { 'data-label': 'Coin', text: coin(r) }), h('td', { 'data-label': 'Period', text: period(r) }),
        h('td', { 'data-label': 'Freezes (listings)', class: 'num', text: `${r.n} (${r.designations})` }),
        cell('Listing first', r.A), cell('Same day', r.B), cell('Freeze first', r.C), cell("Can't tell", r.gap, true));
    }))));

  root.append(
    h('div', { class: 'proof-label', role: 'note' }, h('strong', { text: 'Measured from public records.' }), ' It shows the order of events, not whether any freeze was lawful.'),
    card('The gap', { id: 'pg-head' },
      h('div', { class: 'cardbody' },
        h('div', { class: 'bigstat' },
          h('p', { class: 'bigstat__num', id: 'pg-num', text: head.gap.split(' ')[0] }),
          h('div', {},
            h('p', { class: 'bigstat__text pg-lead', text: `of ${head.n} USDC freezes on Ethereum since ${plainDate(HEADLINE.subset.replace(/^after /, ''))} cannot be shown, from public records, to come after the sanctions listing.` }),
            h('p', { class: 'field__hint', text: `Likely range ${range(head.gap)}. Public records give the listing a date and the freeze a time, so when both fall on the same day nobody can prove which came first.` }))))),
    card('Can public records show the listing came first?', { id: 'pg-shares', sub: 'Share of freezes, by coin' },
      h('div', { class: 'cardbody lanebox' },
        h('ul', { class: 'legend legend--inline pg-legend' }, SHARE_BARS.map(([key, text]) => h('li', {}, h('span', { class: `swatch swatch--${key.toLowerCase()}`, 'aria-hidden': 'true' }), text))),
        shares(data.rows))),
    card('What a receipt adds', { id: 'pg-adds' }, h('div', { class: 'cardbody' },
      h('p', { class: 'pg-lead', text: `A${data.adds.replace('What a Tollgate receipt adds: a', '').replace(/`/g, '').replace(/\s*For past freezes.*$/, '')}` }),
      h('p', { class: 'field__hint', text: data.not_checked.replace(/column B/g, 'the same-day share') }))),
    card('Live test: did the listing come first?', { id: 'pg-live', sub: `${isoDay(live.t0)} to ${isoDay(live.t1)}` }, h('div', { class: 'cardbody' },
      h('div', { class: 'bigstat' },
        h('p', { class: 'bigstat__num', id: 'pg-live-num', text: `${live.k} of ${live.N}` }),
        h('p', { class: 'bigstat__text pg-lead', text: plainIso(live.headline) })),
      h('div', { class: 'ratio', role: 'img', 'aria-label': `${live.k} of ${live.N} freezes of a newly listed address have a provable order` },
        Array.from({ length: live.N }, (_, i) => h('span', { class: `ratio__dot${i < live.k ? ' ratio__dot--yes' : ''}`, title: i < live.k ? 'Listing provably first' : 'Not provable' }))),
      h('p', { class: 'field__hint', text: `${live.k} provable, ${against} not. With ${live.N} freezes this is a plain count, so it has no range. It shows the order of events only, not whether any freeze was lawful.` }))),
    h('details', { class: 'card pg-method', id: 'pg-method' },
      h('summary', { class: 'card__head' }, h('span', { class: 'card__title', text: 'Full numbers, method and sources' })),
      h('div', { class: 'cardbody' },
        h('p', { class: 'field__hint', text: `Small grey numbers are 95% intervals (cluster bootstrap over listings). Across all USDC freezes on Ethereum (${eth.n}) the gap is ${eth.gap}; for USDT on Tron (${tron.n}) it is ${tron.gap}. "Freeze first" means the freeze carries an earlier date than the official posting.` }),
        table,
        h('p', { class: 'field__hint' }, 'Report: ', sourceRef(data.source.path, data.source.sha256), ' and ', sourceRef(data.source_json.path, data.source_json.sha256), `. Pre-registration: ${data.prereg}.`),
        h('p', { class: 'field__hint', text: 'Past freezes can only be checked against our copy of the list (column M in the report, via scripts/audit_freeze.py). Live test: the anchor time shows our copy of the posting existed by then; the posting may have been published earlier. Three freezes (obs:176, obs:178, obs:182) were not provable against posting obs:148. Pre-registered in docs/PREREG_LIVE_PROOF.md.' }),
        h('p', { class: 'field__hint' }, 'Live test data: ', sourceRef(live.source.path, live.source.sha256), '.'))),
  );
}
