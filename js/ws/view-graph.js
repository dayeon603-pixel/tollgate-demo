/** Counterparty graph: counterparties of one address (one or two hops) in this demo's synthetic payments. */
import { card, clear, copyButton, dataTable, empty, h, icon, kv, money, segmented, shortAddr, stamp } from './dom.js';
import { esc, mount, seriesColour, tooltipBase } from './echart.js';
import { addressProfile, buildGraph, busiestAddress, collectPayments, GRAPH_HOPS, GRAPH_MAX_NODES, suggestedAddresses } from './graph.js';

const SUGGESTIONS = 6;
const ALERT_LINKS = 3;
const st = { address: '', hops: 1, selected: '', expanded: {} };
export const GRAPH_CAPTION = 'Demo payments. Exact list matches only, no risk scoring.';

const lower = (a) => a.toLowerCase();

export function renderGraph(ctx, root) {
  const { ws, live } = ctx;
  const params = ctx.takeParams('graph');
  const payments = collectPayments(ws, live.tape);
  const suggestions = suggestedAddresses(payments, ws.inForce, SUGGESTIONS);
  if (params.address) { st.address = params.address; st.selected = ''; st.expanded = {}; }
  if (GRAPH_HOPS.includes(params.hops)) st.hops = params.hops;
  if (!st.address) st.address = busiestAddress(payments);
  if (!st.selected) st.selected = st.address;
  clear(root);

  const input = h('input', { id: 'gr-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', value: st.address, placeholder: '0x... or T...' });
  const err = h('p', { class: 'field__hint field__hint--bad', role: 'alert' });
  const pivot = (address) => { st.address = address; st.selected = address; st.expanded = {}; ctx.refresh(); };
  const form = h('form', { class: 'graphform', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { err.textContent = 'Paste an address, or pick one below.'; return; }
    pivot(value);
  } } }, h('label', { for: 'gr-address', class: 'sr', text: 'Address' }), input, h('button', { type: 'submit', class: 'btn btn--primary', id: 'gr-go' }, 'Show counterparties'));

  const graph = buildGraph(payments, st.address, ws.inForce, GRAPH_MAX_NODES, st.hops);
  if (!graph.nodes.length) st.selected = st.address;

  // Chips: a contained, scrollable row with a fade where more is hidden.
  const chipList = h('ul', { class: 'chips', id: 'gr-chips' }, suggestions.map((s) => h('li', {}, h('button', { type: 'button', class: `chipbtn mono${s.listed ? ' chipbtn--listed' : ''}`, title: `${s.address}, ${s.counterparties} direct counterparties`, on: { click: () => pivot(s.address) } },
    shortAddr(s.address), s.listed ? h('span', { class: 'chipbtn__tag', text: 'on list' }) : null, h('span', { class: 'chipbtn__n', text: String(s.counterparties) })))));
  const chipScroll = h('div', { class: 'chipscroll' }, chipList);
  const fade = () => {
    chipScroll.dataset.fadeLeft = String(chipList.scrollLeft > 2);
    chipScroll.dataset.fadeRight = String(chipList.scrollLeft + chipList.clientWidth < chipList.scrollWidth - 2);
  };
  chipList.addEventListener('scroll', fade, { passive: true });

  const hops = segmented({ label: 'Hops', value: st.hops, options: GRAPH_HOPS.map((v) => ({ value: v, label: String(v) })), onChange: (v) => { st.hops = v; ctx.refresh(); } });
  hops.id = 'gr-hops';
  hops.classList.add('seg--flat');

  // Figure: the ten largest direct counterparties by total value, money in and out as two series ------
  const FIG_TOP = 10;
  const direct1 = graph.nodes.filter((n) => n.hop !== 2);
  const figRows = direct1.map((n) => ({ ...n, total: n.sentUsd + n.receivedUsd }))
    .sort((a, b) => b.total - a.total || a.address.localeCompare(b.address)).slice(0, FIG_TOP);
  const allUsd = direct1.reduce((t, n) => t + n.sentUsd + n.receivedUsd, 0);
  const topUsd = figRows.reduce((t, n) => t + n.total, 0);
  const panel = h('aside', { class: 'graphside', id: 'gr-panel', 'aria-label': 'Selected address' });
  const host = h('div', { class: 'echost' });
  host.style.height = `${figRows.length * 34 + 78}px`;
  const axisUsd = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v}`);
  const ylab = (r) => `${r.listed ? '\u2020 ' : ''}${shortAddr(r.address)}`;
  const figure = h('figure', { class: 'figure', id: 'gr-chart', 'data-nodes': String(direct1.length), 'data-centre-listed': String(Boolean(graph.center.listed)) },
    h('div', { class: 'figure__plot', role: 'img', 'aria-label': `Bar chart of the ${figRows.length} largest counterparties of ${st.address} by value: ${figRows.map((r) => `${shortAddr(r.address)} ${money(r.sentUsd)} in, ${money(r.receivedUsd)} out${r.listed ? ', on the sanctions list' : ''}`).join('; ')}.` }, host),
    h('figcaption', { class: 'figure__cap' },
      h('strong', { text: `Figure. ` }),
      `The ${figRows.length} largest direct counterparties of ${shortAddr(st.address)}, by total value. `,
      `They account for ${allUsd ? ((100 * topUsd) / allUsd).toFixed(1) : '0.0'}% of the value exchanged with ${direct1.length} counterparties. `,
      '\u2020 on the sanctions list in force. Source: demo payments. Full list in the table below.'));
  let chart = null;
  const select = (address) => { st.selected = address; chart?.render(); drawPanel(); };
  chart = mount(host, (t) => {
    const grey = t.dark ? '#8a969e' : '#5f6b73';
    const sel = lower(st.selected);
    return {
      animation: false,
      grid: { left: 8, right: 24, top: 34, bottom: 34, containLabel: true },
      legend: { top: 0, left: 0, itemWidth: 12, itemHeight: 10, itemGap: 18, icon: 'rect', textStyle: { color: t.ink, fontSize: 12, fontFamily: t.sans } },
      tooltip: { ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: t.grid } },
        formatter: (ps) => { const r = figRows[ps[0].dataIndex]; return `<div class="ect__head">${esc(r.address)}</div>${r.listed ? '<div class="ect__row"><span class="ect__k">On the sanctions list</span></div>' : ''}<div class="ect__row"><span class="ect__k">Paid to this address</span><span class="ect__v">${esc(money(r.sentUsd))}</span></div><div class="ect__row"><span class="ect__k">Paid by this address</span><span class="ect__v">${esc(money(r.receivedUsd))}</span></div><div class="ect__row"><span class="ect__k">Payments</span><span class="ect__v">${r.count}</span></div>`; } },
      xAxis: { type: 'value', splitNumber: 4, name: 'Value (USD)', nameLocation: 'middle', nameGap: 24, nameTextStyle: { color: t.dim, fontSize: 12, fontFamily: t.sans },
        axisLine: { show: true, lineStyle: { color: t.ink } }, axisTick: { show: true, lineStyle: { color: t.ink } },
        splitLine: { lineStyle: { color: t.grid } }, axisLabel: { color: t.dim, fontSize: 11, formatter: axisUsd } },
      yAxis: { type: 'category', inverse: true, data: figRows.map(ylab), triggerEvent: true,
        axisLine: { show: true, lineStyle: { color: t.ink } }, axisTick: { show: true, alignWithLabel: true, lineStyle: { color: t.ink } },
        axisLabel: { fontFamily: t.mono, fontSize: 11.5, formatter: (v, i) => (lower(figRows[i]?.address || '') === sel ? `{s|${v}}` : `{n|${v}}`),
          rich: { n: { color: t.ink, fontFamily: t.mono, fontSize: 11.5 }, s: { color: t.ink, fontFamily: t.mono, fontSize: 11.5, fontWeight: 700, backgroundColor: t.sunken, padding: [2, 4] } } } },
      series: [
        { name: 'Paid to this address', type: 'bar', stack: 'total', barWidth: 14, data: figRows.map((r) => r.sentUsd), itemStyle: { color: seriesColour('allow') }, emphasis: { disabled: true } },
        { name: 'Paid by this address', type: 'bar', stack: 'total', barWidth: 14, data: figRows.map((r) => r.receivedUsd), itemStyle: { color: grey }, emphasis: { disabled: true } },
      ],
    };
  }, (inst) => {
    // Anywhere in a row (bar, gap or address label) picks that counterparty, not only the bar itself.
    const rowAt = (e) => {
      const [x, y] = [e.offsetX, e.offsetY];
      const g = inst.getModel().getComponent('grid', 0)?.coordinateSystem?.getRect();
      if (!g || y < g.y || y > g.y + g.height || x > g.x + g.width) return null;
      return figRows[Math.floor(((y - g.y) / g.height) * figRows.length)] ?? null;
    };
    inst.getZr().on('click', (e) => { const r = rowAt(e); if (r) select(r.address); });
    inst.getZr().on('dblclick', (e) => { const r = rowAt(e); if (r) pivot(r.address); });
    inst.getZr().on('mousemove', (e) => { inst.getZr().setCursorStyle(rowAt(e) ? 'pointer' : 'default'); });
  });
  const lists = figure;

  // Side panel --------------------------------------------------------------------------------
  function drawPanel() {
    const address = st.selected || st.address;
    const profile = addressProfile(payments, address, ws.inForce);
    const alerts = ws.alerts.filter((a) => lower(a.address) === lower(address));
    const isCentre = lower(address) === lower(st.address);
    clear(panel);
    panel.append(
      h('h3', { class: 'graphside__title', text: isCentre ? 'Centre address' : 'Selected address' }),
      h('div', { class: 'graphside__addr' }, h('span', { class: 'mono', id: 'gr-panel-address', text: address }), copyButton(address, 'address')),
      profile.listed
        ? h('p', { class: 'chip chip--bad', id: 'gr-panel-match', text: `On the list: ${profile.entries.map((e) => e.name).join('; ').slice(0, 90)}` })
        : h('p', { class: 'chip chip--neutral', id: 'gr-panel-match', text: 'Not on the list in force' }),
      kv([
        ['Payments in', `${profile.paymentsIn} (${money(profile.inUsd)})`],
        ['Payments out', `${profile.paymentsOut} (${money(profile.outUsd)})`],
        ['First seen', profile.first === null ? 'none' : stamp(new Date(profile.first).toISOString())],
        ['Last seen', profile.last === null ? 'none' : stamp(new Date(profile.last).toISOString())],
        ['Counterparties', String(profile.counterparties)],
        ['Data', `Demo payments (${profile.screened} screened)`],
      ]),
      h('div', { class: 'graphside__actions' },
        isCentre ? null : h('button', { type: 'button', class: 'btn btn--primary', id: 'gr-centre', on: { click: () => pivot(address) } }, 'Centre graph here'),
        profile.screened ? h('button', { type: 'button', class: 'btn', id: 'gr-receipts', on: { click: () => ctx.go('explorer', { q: address }) } }, `Receipts in the explorer (${profile.screened})`) : h('p', { class: 'field__hint', text: 'No screened payment to this address, so no receipt in the explorer.' }),
        ...alerts.slice(0, ALERT_LINKS).map((a) => h('button', { type: 'button', class: 'btn', 'data-alert': a.id, on: { click: () => ctx.openAlert(a.id) } }, `Open alert ${a.id}`)),
        alerts.length > ALERT_LINKS ? h('p', { class: 'field__hint', text: `and ${alerts.length - ALERT_LINKS} more alerts for this address` }) : null));
  }

  // Page --------------------------------------------------------------------------------------
  const body = graph.nodes.length
    ? h('div', { class: 'graphlayout' }, h('div', { class: 'graphmain' }, lists), panel)
    : empty('No payments for this address in the demo.', 'Pick a suggested address, or paste one that appears in the receipt explorer.');

  const table = graph.nodes.length ? dataTable({
    caption: 'Counterparties', rows: graph.nodes, rowKey: (n) => n.address,
    cols: [
      { label: 'Counterparty', render: (n) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => pivot(n.address) } }, shortAddr(n.address)) },
      ...(st.hops === 2 ? [{ label: 'Hop', num: true, render: (n) => String(n.hop) }, { label: 'Linked via', render: (n) => (n.hop === 2 ? h('span', { class: 'mono', text: shortAddr(n.parent) }) : 'Centre') }] : []),
      { label: 'On list', render: (n) => (n.listed ? h('span', { class: 'chip chip--bad', text: 'On list' }) : h('span', { class: 'muted', text: 'No' })) },
      { label: 'Payments', num: true, render: (n) => String(n.count) },
      { label: st.hops === 2 ? 'Sent to linked address' : 'Sent to centre', num: true, render: (n) => (n.sentUsd ? money(n.sentUsd) : '—') },
      { label: st.hops === 2 ? 'Received from it' : 'Received from centre', num: true, render: (n) => (n.receivedUsd ? money(n.receivedUsd) : '—') },
    ],
  }) : null;

  const summary = st.hops === 2
    ? `${graph.nodes.length} of ${graph.totalCounterparties} addresses within 2 hops drawn; ${graph.paymentCount} payments touch the centre directly.`
    : `${graph.paymentCount} payments with ${graph.totalCounterparties} direct counterparties${graph.hidden ? `; ${graph.nodes.length} drawn` : ''}.`;

  // Flow metrics for the centre address, direct (one-hop) payments only.
  const cp = addressProfile(payments, st.address, ws.inForce);
  const direct = graph.nodes.filter((n) => n.hop === 1);
  const listedUsd = direct.filter((n) => n.listed).reduce((t, n) => t + n.sentUsd + n.receivedUsd, 0);
  const share = (v, of) => (of > 0 ? `${((100 * v) / of).toFixed(1)}%` : '0%');
  const metric = (label, value, sub) => h('div', { class: 'kpi' }, h('dt', {}, label), h('dd', { text: value }), h('p', { class: 'kpi__sub', text: sub }));
  const metrics = graph.nodes.length ? h('dl', { class: 'kpis kpis--flow', id: 'gr-metrics' },
    metric('Money in', money(cp.inUsd), `${cp.paymentsIn} payments`),
    metric('Money out', money(cp.outUsd), `${cp.paymentsOut} payments · net ${cp.inUsd - cp.outUsd >= 0 ? '+' : '−'}${money(Math.abs(cp.inUsd - cp.outUsd))}`),
    metric('Counterparties', String(cp.counterparties), `${direct.filter((n) => n.listed).length} on the sanctions list`),
    metric('Sent to or from listed', money(listedUsd), `${share(listedUsd, cp.totalUsd)} of all value`)) : null;

  root.append(...[
    card('Counterparties', { id: 'gr-card' }, h('div', { class: 'cardbody graphbody' },
      form, err,
      h('div', { class: 'graphpick' }, h('span', { class: 'graphpick__label', text: 'Busiest addresses' }), chipScroll),
      h('div', { class: 'graphhead' },
        h('span', { class: 'graphhead__label', text: 'Showing' }), h('span', { class: 'mono graphhead__addr', id: 'gr-selected', text: st.address }),
        graph.center.listed ? h('span', { class: 'chip chip--bad', text: `On the list: ${graph.center.entries.map((e) => e.name).join('; ').slice(0, 80)}` }) : h('span', { class: 'chip chip--neutral', text: 'Not on the list' }),
        h('span', { class: 'graphhead__hops' }, h('span', { class: 'graphhead__label', text: 'Hops' }), hops)),
      metrics,
      h('p', { class: 'field__hint', id: 'gr-summary', text: `${summary} ${GRAPH_CAPTION}` }),
      body)),
    table ? card(st.hops === 2 ? 'All addresses within two hops' : 'All counterparties', { id: 'gr-table' }, table) : null].filter(Boolean));

  if (graph.nodes.length) {
    drawPanel();
    chart.render();
  }
  fade();
  void icon;
}
