/** Counterparty graph: counterparties of one address (one or two hops) in this demo's synthetic payments. */
import { card, clear, copyButton, dataTable, empty, h, icon, kv, money, segmented, shortAddr, stamp } from './dom.js';
import { addressProfile, buildGraph, busiestAddress, collectPayments, GRAPH_HOPS, GRAPH_MAX_NODES, suggestedAddresses } from './graph.js';

const SUGGESTIONS = 14;
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

  // Ranked counterparties: who paid this address and who it paid, largest first --------------------
  const LIST_TOP = 10;
  const panel = h('aside', { class: 'graphside', id: 'gr-panel', 'aria-label': 'Selected address' });
  const directNodes = graph.nodes.filter((n) => n.hop !== 2);
  const sideRows = (key) => directNodes.filter((n) => n[key] > 0).map((n) => ({ ...n, usd: n[key] })).sort((a, b) => b.usd - a.usd || a.address.localeCompare(b.address));
  const ranked = (title, key, id) => {
    const rows = sideRows(key);
    const total = rows.reduce((t, r) => t + r.usd, 0);
    const max = rows[0]?.usd || 1;
    const open = Boolean(st.expanded[id]);
    const shown = open ? rows : rows.slice(0, LIST_TOP);
    const list = h('ol', { class: 'rank' }, shown.map((r, i) => {
      const sel = lower(st.selected) === lower(r.address);
      return h('li', { class: `rank__row${r.listed ? ' rank__row--bad' : ''}${sel ? ' is-selected' : ''}`, 'data-address': r.address },
        h('span', { class: 'rank__n', text: String(i + 1) }),
        h('button', { type: 'button', class: 'rank__addr mono', title: `${r.address}. Double-click to centre on it.`, on: { click: () => select(r.address), dblclick: () => pivot(r.address) } }, shortAddr(r.address)),
        r.listed ? h('span', { class: 'chip chip--bad rank__tag', text: 'On list' }) : h('span', { class: 'rank__tag' }),
        h('span', { class: 'rank__bar', 'aria-hidden': 'true' }, h('span', { class: 'rank__fill', style: undefined, 'data-w': String(Math.max(2, Math.round((100 * r.usd) / max))) })),
        h('span', { class: 'rank__usd', text: money(r.usd) }),
        h('span', { class: 'rank__pct', text: total ? `${((100 * r.usd) / total).toFixed(1)}%` : '' }));
    }));
    const toggle = rows.length > LIST_TOP
      ? h('button', { type: 'button', class: 'linkbtn rank__more', id: `${id}-more`, on: { click: () => { st.expanded = { ...st.expanded, [id]: !open }; ctx.refresh(); } } }, open ? `Show top ${LIST_TOP}` : `Show all ${rows.length}`)
      : null;
    return h('section', { class: `rankcard rankcard--${key === 'sentUsd' ? 'in' : 'out'}`, id, 'aria-label': title },
      h('header', { class: 'rankcard__head' }, h('h3', { text: title }), h('span', { class: 'rankcard__sum', text: `${money(total)} · ${rows.length} address${rows.length === 1 ? '' : 'es'}` })),
      rows.length ? list : h('p', { class: 'field__hint', text: 'None in the demo payments.' }), toggle);
  };
  const lists = h('div', { class: 'ranks', id: 'gr-chart', 'data-nodes': String(directNodes.length) },
    ranked('Money in, by sender', 'sentUsd', 'gr-in'),
    ranked('Money out, by receiver', 'receivedUsd', 'gr-out'));
  // Bar widths are set from data attributes so the page needs no inline style attribute (CSP).
  const sizeBars = () => lists.querySelectorAll('.rank__fill').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  const select = (address) => {
    st.selected = address;
    lists.querySelectorAll('.rank__row').forEach((row) => row.classList.toggle('is-selected', lower(row.dataset.address) === lower(address)));
    drawPanel();
  };

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
        ['Total value', money(profile.totalUsd)],
        ['First seen', profile.first === null ? 'none' : stamp(new Date(profile.first).toISOString())],
        ['Last seen', profile.last === null ? 'none' : stamp(new Date(profile.last).toISOString())],
        ['Counterparties', String(profile.counterparties)],
        ['Source', `${profile.screened} screened, ${profile.streamed} stream, ${profile.background} synthetic background`],
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
      { label: 'On list', render: (n) => (n.listed ? 'Yes, exact match' : 'No') },
      { label: 'Payments', num: true, render: (n) => String(n.count) },
      { label: 'Paid to linked address', num: true, render: (n) => money(n.sentUsd) },
      { label: 'Received from it', num: true, render: (n) => money(n.receivedUsd) },
    ],
  }) : null;

  const summary = st.hops === 2
    ? `${graph.nodes.length} of ${graph.totalCounterparties} addresses within 2 hops drawn; ${graph.paymentCount} payments touch the centre directly.`
    : `${graph.paymentCount} payments with ${graph.totalCounterparties} direct counterparties${graph.hidden ? `; ${graph.nodes.length} drawn` : ''}.`;

  // Flow metrics for the centre address, direct (one-hop) payments only.
  const cp = addressProfile(payments, st.address, ws.inForce);
  const direct = graph.nodes.filter((n) => n.hop === 1);
  const inflows = direct.map((n) => n.sentUsd).sort((x, y) => y - x);
  const top5 = inflows.slice(0, 5).reduce((t, v) => t + v, 0);
  const listedUsd = direct.filter((n) => n.listed).reduce((t, n) => t + n.sentUsd + n.receivedUsd, 0);
  const share = (v, of) => (of > 0 ? `${((100 * v) / of).toFixed(1)}%` : '0%');
  const metric = (label, value, sub) => h('div', { class: 'kpi' }, h('dt', {}, label), h('dd', { text: value }), h('p', { class: 'kpi__sub', text: sub }));
  const metrics = graph.nodes.length ? h('dl', { class: 'kpis kpis--flow', id: 'gr-metrics' },
    metric('Money in', money(cp.inUsd), `${cp.paymentsIn} payments`),
    metric('Money out', money(cp.outUsd), `${cp.paymentsOut} payments`),
    metric('Net flow', `${cp.inUsd - cp.outUsd >= 0 ? '+' : '−'}${money(Math.abs(cp.inUsd - cp.outUsd))}`, cp.inUsd >= cp.outUsd ? 'More in than out' : 'More out than in'),
    metric('Counterparties', String(cp.counterparties), `${direct.filter((n) => n.listed).length} on the list in force`),
    metric('Top 5 senders', share(top5, cp.inUsd), 'of money in'),
    metric('Exposure to listed', money(listedUsd), `${share(listedUsd, cp.totalUsd)} of total value`)) : null;

  root.append(...[
    card('Counterparties', { id: 'gr-card' }, h('div', { class: 'cardbody graphbody' },
      form, err,
      h('div', { class: 'graphpick' }, h('p', { class: 'field__hint', text: 'Suggested starting points (busiest first, number = direct counterparties)' }), chipScroll),
      h('div', { class: 'graphhead' },
        h('span', { class: 'graphhead__label', text: 'Centre' }), h('span', { class: 'mono graphhead__addr', id: 'gr-selected', text: st.address }),
        graph.center.listed ? h('span', { class: 'chip chip--bad', text: `Exact list match: ${graph.center.entries.map((e) => e.name).join('; ').slice(0, 80)}` }) : h('span', { class: 'chip chip--neutral', text: 'Not on the list in force' }),
        h('span', { class: 'graphhead__hops' }, h('span', { class: 'graphhead__label', text: 'Hops' }), hops)),
      metrics,
      h('p', { class: 'field__hint', id: 'gr-summary', text: `${summary} ${GRAPH_CAPTION}` }),
      body)),
    table ? card(st.hops === 2 ? 'All addresses within two hops' : 'All counterparties', { id: 'gr-table' }, table) : null].filter(Boolean));

  if (graph.nodes.length) {
    drawPanel();
    sizeBars();
  }
  fade();
  void icon;
}
