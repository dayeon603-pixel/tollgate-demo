/** Counterparty graph: direct counterparties of one address in this demo's synthetic payments. */
import { card, clear, copyButton, dataTable, empty, h, money, mono, shortAddr, svg } from './dom.js';
import { buildGraph, collectPayments, edgeWidth, GRAPH_MAX_NODES, layoutGraph, suggestedAddresses } from './graph.js';
import { CHAIN_LABEL } from './stream.js';

const W = 720;
const HEIGHT = 440;
const st = { address: '' };
export const GRAPH_CAPTION = "Direct counterparties in this demo's payments; exact list matches only; no risk scoring.";

export function renderGraph(ctx, root) {
  const { ws, live } = ctx;
  const params = ctx.takeParams('graph');
  const payments = collectPayments(ws, live.tape);
  const suggestions = suggestedAddresses(payments, ws.inForce, 10);
  if (params.address) st.address = params.address;
  if (!st.address) st.address = suggestions[0]?.address ?? '';
  clear(root);

  const input = h('input', { id: 'gr-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', value: st.address, placeholder: '0x... or T...' });
  const err = h('p', { class: 'field__hint field__hint--bad', role: 'alert' });
  const pivot = (address) => { st.address = address; ctx.refresh(); };
  const form = h('form', { class: 'graphform', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { err.textContent = 'Paste an address, or pick one below.'; return; }
    pivot(value);
  } } }, h('label', { for: 'gr-address', class: 'sr', text: 'Address' }), input, h('button', { type: 'submit', class: 'btn btn--primary', id: 'gr-go' }, 'Show counterparties'));

  const graph = buildGraph(payments, st.address, ws.inForce);
  const maxValue = Math.max(1, ...graph.nodes.map((n) => n.valueUsd));
  const pos = layoutGraph(graph, W, HEIGHT);
  const cx = W / 2;
  const cy = HEIGHT / 2;

  const root$ = svg('svg', { viewBox: `0 0 ${W} ${HEIGHT}`, class: 'graph', role: 'group', 'aria-label': `Counterparties of ${st.address}. ${GRAPH_CAPTION}`, id: 'gr-svg' });
  for (const { node, x, y } of pos) {
    root$.append(svg('line', { x1: cx, y1: cy, x2: x, y2: y, class: `gedge${node.listed ? ' gedge--listed' : ''}`, 'stroke-width': edgeWidth(node.valueUsd, maxValue).toFixed(2) }));
  }
  for (const { node, x, y } of pos) {
    const g = svg('g', { class: `gnode${node.listed ? ' gnode--listed' : ''}`, tabindex: 0, role: 'button', 'data-address': node.address,
      'aria-label': `${shortAddr(node.address)}${node.listed ? ', exact match on the list' : ''}, ${node.count} payments, ${money(node.valueUsd)}. Press Enter to pivot.` });
    const title = svg('title', {});
    title.textContent = `${node.address}\n${node.count} payments, ${money(node.valueUsd)} (sent to it ${money(node.receivedUsd)}, received from it ${money(node.sentUsd)})${node.listed ? `\nExact list match: ${node.entries.map((e) => e.name).join('; ')}` : ''}`;
    g.append(title, svg('rect', { x: x - 40, y: y - 22, width: 80, height: 50, class: 'ghit' }));
    if (node.listed) g.append(svg('rect', { x: x - 9, y: y - 9, width: 18, height: 18, transform: `rotate(45 ${x} ${y})`, class: 'gshape' }));
    else g.append(svg('circle', { cx: x, cy: y, r: 8, class: 'gshape' }));
    const label = svg('text', { x, y: y + 22, 'text-anchor': 'middle', class: 'glabel' });
    label.textContent = shortAddr(node.address);
    g.append(label);
    if (node.listed) { const tag = svg('text', { x, y: y - 14, 'text-anchor': 'middle', class: 'gtag' }); tag.textContent = 'ON LIST'; g.append(tag); }
    g.addEventListener('click', () => pivot(node.address));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pivot(node.address); } });
    root$.append(g);
  }
  const centre = svg('g', { class: `gnode gnode--centre${graph.center.listed ? ' gnode--listed' : ''}` });
  centre.append(graph.center.listed ? svg('rect', { x: cx - 14, y: cy - 14, width: 28, height: 28, transform: `rotate(45 ${cx} ${cy})`, class: 'gshape' }) : svg('circle', { cx, cy, r: 14, class: 'gshape' }));
  const ctext = svg('text', { x: cx, y: cy + 32, 'text-anchor': 'middle', class: 'glabel glabel--centre' });
  ctext.textContent = shortAddr(st.address);
  centre.append(ctext);
  root$.append(centre);

  const chips = h('ul', { class: 'chips' }, suggestions.map((s) => h('li', {}, h('button', { type: 'button', class: `chipbtn mono${s.listed ? ' chipbtn--listed' : ''}`, on: { click: () => pivot(s.address) } }, shortAddr(s.address), s.listed ? h('span', { class: 'chipbtn__tag', text: 'on list' }) : null))));

  const legend = h('ul', { class: 'legend legend--inline' },
    h('li', {}, svg('svg', { viewBox: '0 0 16 16', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('circle', { cx: 8, cy: 8, r: 6, class: 'gshape' })), 'Address not on the list'),
    h('li', {}, svg('svg', { viewBox: '0 0 16 16', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('rect', { x: 3, y: 3, width: 10, height: 10, transform: 'rotate(45 8 8)', class: 'gshape gshape--listed' })), 'Exact match on the list in force'),
    h('li', {}, 'Line thickness: total value of payments between the two addresses'));

  const body = graph.nodes.length
    ? h('div', { class: 'graphwrap' }, root$, legend)
    : empty('No payments for this address in the demo.', 'Pick a suggested address, or paste one that appears in the receipt explorer.');

  const table = graph.nodes.length ? dataTable({
    caption: 'Direct counterparties', rows: graph.nodes, rowKey: (n) => n.address,
    cols: [
      { label: 'Counterparty', render: (n) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => pivot(n.address) } }, shortAddr(n.address)) },
      { label: 'On list', render: (n) => (n.listed ? 'Yes, exact match' : 'No') },
      { label: 'Payments', num: true, render: (n) => String(n.count) },
      { label: 'Sent to selected', num: true, render: (n) => money(n.sentUsd) },
      { label: 'Received from selected', num: true, render: (n) => money(n.receivedUsd) },
    ],
  }) : null;

  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'Synthetic payments. ' }), GRAPH_CAPTION, ' Senders, chains and assets for the seeded history are assigned by the demo and are not part of the signed receipts. The stream adds its own.'),
    card('Counterparty graph', { id: 'gr-card', sub: 'Click a node to pivot' }, h('div', { class: 'cardbody' },
      form, err, h('p', { class: 'field__hint', text: 'Suggested starting points' }), chips,
      h('div', { class: 'graphhead' }, h('span', { class: 'mono', id: 'gr-selected', text: st.address }), copyButton(st.address, 'address'),
        graph.center.listed ? h('span', { class: 'chip chip--bad', text: `Exact list match: ${graph.center.entries.map((e) => e.name).join('; ').slice(0, 80)}` }) : h('span', { class: 'chip chip--neutral', text: 'Not on the list in force' })),
      h('p', { class: 'field__hint', id: 'gr-summary', text: `${graph.paymentCount} payments with ${graph.totalCounterparties} direct counterparties${graph.hidden ? `; showing the ${GRAPH_MAX_NODES} flagged or largest` : ''}.` }),
      body)),
    table ? card('Counterparties as a table', { id: 'gr-table' }, table) : null);
  void mono;
  void CHAIN_LABEL;
}
