/** Time and cost: what this browser measured, a calculator on the visitor's own numbers, and a procedural comparison. */
import { card, clear, field, h } from './dom.js';
import { formatClock, formatNumber } from './settings.js';
import { zoneName } from './dom.js';
import { buildPack, verifyPack } from './evidence.js';
import { matchIn } from './lists.js';
import { AUDIT_QUESTION, BEFORE_STEPS, ESTIMATE_NOTE, estimate, FORMULAS, formatMs, INPUTS, WITH_STEPS } from './timecost.js';

const st = { values: {} };
const BATCH_SIZE = 1000;

const fmt = (n) => formatNumber(Math.round(n));

export function renderValue(ctx, root) {
  const { ws } = ctx;
  clear(root);

  // ---- A. measured -------------------------------------------------------------------------
  const body = h('div', { id: 'tc-measured' });
  const drawMeasured = () => {
    const items = ctx.measure.latest();
    clear(body);
    if (!items.length) { body.append(h('p', { class: 'card__note', text: 'Nothing measured yet in this session. Press Measure now, or use the app and the timings will appear here.' })); return; }
    body.append(h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'tc-table' },
      h('caption', { class: 'sr', text: 'Timings measured in this browser' }),
      h('thead', {}, h('tr', {}, ['What', 'Took', 'Covering', `When (${zoneName()})`].map((t, i) => h('th', { scope: 'col', class: i === 1 ? 'num' : '' }, t)))),
      h('tbody', {}, items.map((m) => h('tr', {}, h('td', { 'data-label': 'What', text: m.label }), h('td', { 'data-label': 'Took', class: 'num mono', text: formatMs(m.ms) }),
        h('td', { 'data-label': 'Covering', text: Object.entries(m.detail).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ') }),
        h('td', { 'data-label': `When (${zoneName()})`, class: 'mono', text: formatClock(m.at) })))))));
  };
  const measureNow = async () => {
    const m = ctx.measure;
    await m.time('ledger_verify', 'Whole ledger verified', () => ws.ledger.verifyAll(), (r) => ({ receipts: ws.ledger.size, segments: r.segments.length }));
    const pack = await m.time('pack_build', 'Evidence pack built (whole ledger)', () => buildPack(ws, { type: 'all' }, { now: ctx.now(), actor: ctx.userId }), (p) => ({ receipts: p.selection.count }));
    await m.time('pack_verify', 'Evidence pack checked', () => verifyPack(pack), () => ({ receipts: pack.selection.count }));
    const addresses = Array.from(ws.inForce.byAddress.keys());
    await m.time('match_batch', `${BATCH_SIZE} exact matches against the list in force (no signing)`, async () => {
      let hits = 0;
      for (let i = 0; i < BATCH_SIZE; i++) hits += matchIn(ws.inForce, i % 2 ? addresses[i % addresses.length] : `0x${i.toString(16).padStart(40, '0')}`).length ? 1 : 0;
      return hits;
    }, { addresses: BATCH_SIZE });
    ctx.toast('Measured in your browser. The numbers are for this device and this moment.');
    drawMeasured();
  };
  drawMeasured();

  // ---- C. calculator -----------------------------------------------------------------------
  const out = h('div', { id: 'tc-out', role: 'status', 'aria-live': 'polite' });
  const drawEstimate = () => {
    const e = estimate(st.values);
    clear(out);
    if (!e.ready) { out.append(h('p', { class: 'card__note', text: `Enter your numbers to see an estimate. Still needed: ${e.missing.join('; ')}.` })); return; }
    const row = (label, now, withS, diff) => h('tr', {}, h('th', { scope: 'row', text: label }), h('td', { class: 'num mono', text: now }), h('td', { class: 'num mono', text: withS }), h('td', { class: 'num mono', text: diff }));
    out.append(...[h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'tc-estimate' }, h('thead', {}, h('tr', {}, ['', 'Today (your inputs)', 'With receipts (your assumption)', 'Difference'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : '' }, t)))),
      h('tbody', {},
        row('Alert hours per year', fmt(e.now.alertHours), e.with ? fmt(e.with.alertHours) : 'not entered', ''),
        row('Audit hours per year', fmt(e.now.auditHours), e.with ? fmt(e.with.auditHours) : 'not entered', ''),
        row('Total hours per year', fmt(e.now.hours), e.with ? fmt(e.with.hours) : 'not entered', e.difference ? fmt(e.difference.hours) : 'not entered'),
        row('Cost per year (your hourly cost)', fmt(e.now.cost), e.with ? fmt(e.with.cost) : 'not entered', e.difference ? fmt(e.difference.cost) : 'not entered')))),
    e.now.perAnalystHours != null ? h('p', { class: 'field__hint', text: `About ${fmt(e.now.perAnalystHours)} hours per analyst per year at today's numbers.` }) : null,
    h('p', { class: 'estimate__note', id: 'tc-note', text: ESTIMATE_NOTE })].filter(Boolean));
  };
  const inputs = INPUTS.map((i) => {
    const input = h('input', { id: `tc-${i.key}`, class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: 'your number', value: st.values[i.key] ?? '' });
    input.addEventListener('input', () => { st.values[i.key] = input.value; drawEstimate(); });
    return field(`${i.label}${i.required ? '' : ' (optional)'}`, input, `Unit: ${i.unit}`);
  });
  drawEstimate();

  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'What is measured and what is not. ' }), 'The first panel is timed by this browser on this device. The calculator uses only numbers you type in. Tollgate makes no claim about how much time or money it saves you, and none of the figures below are our data or industry data.'),
    card('Measured in your browser', { id: 'tc-a', sub: 'Real time this page took for the work, on this device. Timings vary.', actions: h('button', { type: 'button', class: 'btn btn--primary', id: 'tc-measure', on: { click: measureNow } }, 'Measure now') }, h('div', { class: 'cardbody' }, body)),
    card('One audit question, step by step', { id: 'tc-b', sub: AUDIT_QUESTION }, h('div', { class: 'cardbody' },
      h('div', { class: 'compare' },
        h('section', { class: 'compare__col', 'aria-labelledby': 'tc-before-h' }, h('h3', { id: 'tc-before-h', text: 'Without receipts' }), h('ol', { class: 'steps' }, BEFORE_STEPS.map((s) => h('li', { text: s })))),
        h('section', { class: 'compare__col compare__col--with', 'aria-labelledby': 'tc-with-h' }, h('h3', { id: 'tc-with-h', text: 'With Tollgate receipts' }), h('ol', { class: 'steps' }, WITH_STEPS.map((s) => h('li', { text: s }))))),
      h('p', { class: 'field__hint', text: 'Steps only. No durations are claimed for either side. The measured panel above shows what this app takes for its own steps.' }),
      h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', on: { click: () => ctx.go('explorer') } }, 'Open the receipt explorer'), h('button', { type: 'button', class: 'btn', on: { click: () => ctx.go('evidence') } }, 'Open evidence packs')))),
    card('Your own estimate', { id: 'tc-c', sub: 'Type your numbers. Nothing here is prefilled.' }, h('div', { class: 'cardbody' },
      h('div', { class: 'calc' }, inputs), out,
      h('details', { class: 'formulas' }, h('summary', { text: 'Formulas' }), h('ul', { class: 'plain' }, FORMULAS.map((f) => h('li', { class: 'mono', text: f })))))));
}
