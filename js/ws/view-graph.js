/** Counterparty graph: counterparties of one address (one or two hops) in this demo's synthetic payments. */
import { card, clear, copyButton, dataTable, empty, h, icon, kv, money, segmented, shortAddr, stamp } from './dom.js';
import { addressProfile, buildGraph, busiestAddress, collectPayments, flowModel, GRAPH_HOPS, GRAPH_MAX_NODES, suggestedAddresses } from './graph.js';
import { esc, mount, seriesColour, tooltipBase } from './echart.js';

const FALLBACK_WIDTH = 900;
const NARROW_PX = 600;
const SUGGESTIONS = 14;
const ALERT_LINKS = 3;
const ROW_PX = 40;
const MIN_H = 300;
/** Room beside the outer columns for "0x1234…abcd · $12,345 On list". */
const LABEL_PX = 210;
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

  // Funds flow (Apache ECharts sankey): money in on the left, the centre, money out on the right --------
  const canvas = h('div', { class: 'graphcanvas', id: 'gr-canvas' });
  const host = h('div', { class: 'echost', id: 'gr-chart', tabindex: 0, role: 'group', 'aria-roledescription': 'funds flow',
    'aria-label': `Money in and out of ${st.address}, ${st.hops} hop${st.hops > 1 ? 's' : ''}. ${GRAPH_CAPTION} Arrow keys move between addresses, Enter selects.` });
  const announce = h('p', { class: 'sr', id: 'gr-tip', role: 'status', 'aria-live': 'polite' });
  const panel = h('aside', { class: 'graphside', id: 'gr-panel', 'aria-label': 'Selected address' });
  const model = flowModel(graph, { expanded: st.expanded });
  const order = model.nodes;
  let focusIdx = -1;
  const isNarrow = () => (canvas.clientWidth || FALLBACK_WIDTH) < NARROW_PX;
  const rows = Math.max(1, ...['L2', 'L1', 'C', 'R1', 'R2'].map((c) => model.nodes.filter((n) => n.col === c).length));
  const heightFor = () => Math.max(MIN_H, rows * ROW_PX + 24);

  const sideTotal = (col) => model.nodes.filter((n) => n.col === col).reduce((t, n) => t + n.usd, 0);
  const sharePct = (n) => { const tot = sideTotal(n.col === 'L1' || n.col === 'L2' ? 'L1' : 'R1'); return !isNarrow() && tot > 0 && (n.col === 'L1' || n.col === 'R1') ? `${Math.round((100 * n.usd) / tot)}%` : ''; };
  const nodeLabel = (n) => (n.more ? `+${n.more.n} more · ${money(n.usd)}` : `${shortAddr(n.address)} · ${money(n.usd)}`);
  const tipFor = (n) => {
    if (n.more) return `<div class="ect__head">${n.more.n} more addresses</div><div class="ect__row"><span class="ect__k">Value</span><span class="ect__v">${esc(money(n.usd))}</span></div><div class="ect__note">Click to show them.</div>`;
    const side = n.col === 'C' ? 'Centre' : n.col.startsWith('L') ? (n.col === 'L1' ? 'Paid the centre' : 'Paid a sender') : (n.col === 'R1' ? 'Paid by the centre' : 'Paid by a receiver');
    return `<div class="ect__head">${esc(side)}</div><div class="ect__mono">${esc(shortAddr(n.address))}</div>${n.col === 'C' ? '' : `<div class="ect__row"><span class="ect__k">Value</span><span class="ect__v">${esc(money(n.usd))}</span></div>`}<div class="ect__row"><span class="ect__k">Payments</span><span class="ect__v">${n.count}</span></div>${n.listed ? `<div class="ect__bad">On the list: ${esc(n.entries[0].name)}</div>` : ''}`;
  };

  function build(t) {
    const narrow = isNarrow();
    const bad = seriesColour('block');
    const plain = t.dark ? '#7d8a93' : '#76838c';
    const inC = seriesColour('allow');
    const outC = t.dark ? '#94a3b8' : '#64748b';
    const selKey = lower(st.selected || st.address);
    const focusId = order[focusIdx]?.id;
    const lastDepth = st.hops === 2 ? 4 : 2;
    // Two hops: the inner columns sit close to the centre, so their labels carry the address only (the amount is in the tooltip and the table).
    const terse = (n) => st.hops === 2 && (n.col === 'L1' || n.col === 'R1');
    const pads = Array.from({ length: lastDepth + 1 }, (_, d) => d).filter((d) => !model.nodes.some((n) => n.depth === d));
    const labelSide = (n) => {
      if (n.col === 'C') return 'bottom';
      const leftSide = n.depth < model.nodes[0].depth;
      // Outer columns label outward; inner columns of a two-hop view label towards the centre, so labels never sit on another column.
      const inner = st.hops === 2 && (n.col === 'L1' || n.col === 'R1');
      if (narrow || inner) return leftSide ? 'right' : 'left';
      return leftSide ? 'left' : 'right';
    };
    return {
      animation: false,
      tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p) => {
        if (p.dataType === 'edge') { const l = p.data; return `<div class="ect__row"><span class="ect__k">Payments</span><span class="ect__v">${l.count}</span></div><div class="ect__row"><span class="ect__k">Value</span><span class="ect__v">${esc(money(l.value))}</span></div>`; }
        return p.data?._n ? tipFor(p.data._n) : '';
      } },
      series: [{
        id: 'flow', type: 'sankey', layoutIterations: 0, nodeAlign: 'justify', draggable: false,
        left: narrow ? 6 : LABEL_PX, right: narrow ? 6 : LABEL_PX,
        top: 12, bottom: narrow ? 12 : 30,
        nodeWidth: 6, nodeGap: 14,
        data: [...model.nodes.map((n) => {
          const sel = n.address && lower(n.address) === selKey;
          const focused = n.id === focusId;
          return {
            name: n.id, depth: n.depth, _n: n,
            itemStyle: { color: n.listed ? bad : n.col === 'C' ? t.ink : n.more ? t.lineStrong : n.col.startsWith('L') ? inC : outC, borderColor: (sel && n.col !== 'C') || focused ? t.focus : 'transparent', borderWidth: (sel && n.col !== 'C') || focused ? 2 : 0 },
            label: {
              show: true, position: labelSide(n), distance: 6,
              formatter: () => (n.col === 'C' ? `{c|${shortAddr(n.address)}}${n.listed ? ' {tag|On list}' : ''}` : n.more ? `{more|${nodeLabel(n)}}` : `{a|${terse(n) ? `${n.address.slice(0, 6)}…${n.address.slice(-4)}` : shortAddr(n.address)}}${terse(n) ? '' : `  {v|${money(n.usd)}}${sharePct(n) ? `{p|${sharePct(n)}}` : ''}`}${n.listed ? ' {tag|On list}' : ''}`),
              rich: {
                a: { textBorderColor: t.surface, textBorderWidth: 3, fontFamily: t.mono, fontSize: narrow ? 10.5 : 11, color: n.listed ? bad : t.dim, fontWeight: n.listed ? 600 : 400 },
                c: { textBorderColor: t.surface, textBorderWidth: 3, fontFamily: t.mono, fontSize: 11.5, color: n.listed ? bad : t.ink, fontWeight: 600 },
                v: { textBorderColor: t.surface, textBorderWidth: 3, fontFamily: t.sans, fontSize: narrow ? 11 : 12, color: t.ink, fontWeight: 600 },
                p: { textBorderColor: t.surface, textBorderWidth: 3, fontFamily: t.sans, fontSize: narrow ? 10.5 : 11, color: t.dim, padding: [0, 0, 0, 6] },
                more: { textBorderColor: t.surface, textBorderWidth: 3, fontFamily: t.sans, fontSize: 11.5, color: t.link || t.focus, fontWeight: 600 },
                tag: { fontFamily: t.sans, fontSize: 10, fontWeight: 700, color: '#fff', backgroundColor: bad, borderRadius: 3, padding: [1, 4] },
              },
              backgroundColor: narrow ? t.surface : 'transparent', padding: narrow ? [1, 3] : 0, borderRadius: 2,
            },
          };
        }), ...pads.map((d) => ({ name: `pad-${d}`, depth: d, value: 0, itemStyle: { opacity: 0 }, label: { show: false }, tooltip: { show: false }, silent: true }))],
        // Empty columns keep their place, so the centre stays in the middle when one side has no payments.
        links: model.links.map((l) => ({ source: l.source, target: l.target, value: Math.max(l.usd, 1), count: l.count })),
        lineStyle: { color: 'source', opacity: t.dark ? 0.22 : 0.18, curveness: 0.5 },
        emphasis: { focus: 'adjacency', lineStyle: { opacity: 0.45 } },
        labelLayout: { hideOverlap: true },
      }],
    };
  }

  const chart = mount(host, build, (inst) => {
    inst.on('click', (p) => {
      const n = p.data?._n;
      if (!n || p.dataType !== 'node') return;
      if (n.more) { st.expanded = { ...st.expanded, [n.col]: true }; ctx.refresh(); return; }
      select(n.address);
    });
    inst.on('dblclick', (p) => { const n = p.data?._n; if (n && !n.more && n.col !== 'C') pivot(n.address); });
  });

  const select = (address) => {
    st.selected = address;
    host.dataset.selected = address;
    chart.render();
    drawPanel();
  };
  const sizeHost = () => { host.style.height = `${heightFor()}px`; };

  const focusNode = (i) => {
    focusIdx = (i + order.length) % order.length;
    const n = order[focusIdx];
    chart.render();
    chart.chart()?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: focusIdx });
    announce.textContent = n.more ? `${n.more.n} more addresses, ${money(n.usd)}. Press Enter to show them.` : `${n.col === 'C' ? 'Centre, ' : n.col.startsWith('L') ? 'Money in from ' : 'Money out to '}${shortAddr(n.address)}${n.listed ? ', exact match on the list' : ''}${n.col === 'C' ? '' : `, ${money(n.usd)}`}. Press Enter to inspect.`;
    host.dataset.focus = n.address ?? n.id;
  };
  host.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); focusNode(focusIdx + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); focusNode(focusIdx - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focusIdx >= 0) {
      e.preventDefault();
      const n = order[focusIdx];
      if (n.more) { st.expanded = { ...st.expanded, [n.col]: true }; ctx.refresh(); } else select(n.address);
    } else if (e.key === 'Escape') { focusIdx = -1; delete host.dataset.focus; chart.chart()?.dispatchAction({ type: 'hideTip' }); chart.render(); }
  });
  host.addEventListener('blur', () => { chart.chart()?.dispatchAction({ type: 'hideTip' }); });
  const heads = h('div', { class: 'flowheads', 'aria-hidden': 'true' },
    h('span', { text: `Money in${st.hops === 2 ? ' (2 hops)' : ''} · ${money(sideTotal('L1'))}` }), h('span', { text: `Money out${st.hops === 2 ? ' (2 hops)' : ''} · ${money(sideTotal('R1'))}` }));
  const anyMore = Object.values(st.expanded).some(Boolean);
  const collapse = anyMore ? h('button', { type: 'button', class: 'btn btn--ghost', id: 'gr-collapse', on: { click: () => { st.expanded = {}; ctx.refresh(); } } }, 'Show top 8 only') : null;
  const more = graph.hidden ? h('p', { class: 'gmore', id: 'gr-more', text: `${graph.hidden} more not loaded (at most ${GRAPH_MAX_NODES} addresses)` }) : null;

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
  const legend = h('ul', { class: 'legend legend--inline' },
    h('li', {}, h('span', { class: 'flowkey flowkey--in', 'aria-hidden': 'true' }), 'Sender'),
    h('li', {}, h('span', { class: 'flowkey', 'aria-hidden': 'true' }), 'Receiver'),
    h('li', {}, h('span', { class: 'flowkey flowkey--bad', 'aria-hidden': 'true' }), 'On the list in force'),
    h('li', { class: 'legend__note' }, 'Width = USD value'),
    collapse ? h('li', {}, collapse) : null);

  const body = graph.nodes.length
    ? h('div', { class: 'graphlayout' }, h('div', { class: 'graphmain' }, canvas, legend), panel)
    : empty('No payments for this address in the demo.', 'Pick a suggested address, or paste one that appears in the receipt explorer.');
  canvas.append(heads, host, announce);
  if (more) canvas.append(more);

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
    table ? card(st.hops === 2 ? 'Counterparties within two hops, as a table' : 'Counterparties as a table', { id: 'gr-table' }, table) : null].filter(Boolean));

  if (graph.nodes.length) {
    drawPanel();
    sizeHost();
    host.dataset.selected = st.selected;
    host.dataset.nodes = String(model.nodes.length);
    host.dataset.centreListed = String(Boolean(graph.center.listed));
    let narrowNow = null;
    new ResizeObserver(() => { const n = isNarrow(); if (n !== narrowNow) { narrowNow = n; chart.render(); } }).observe(canvas);
  }
  fade();
  void icon;
}
