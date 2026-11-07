/** Counterparty graph: counterparties of one address (one or two hops) in this demo's synthetic payments. */
import { card, clear, copyButton, dataTable, empty, h, icon, kv, money, segmented, shortAddr, stamp, svg } from './dom.js';
import { addressProfile, buildGraph, busiestAddress, collectPayments, edgeWidth, GRAPH_HOPS, GRAPH_MAX_NODES, layoutGraph, suggestedAddresses } from './graph.js';

const FALLBACK_WIDTH = 900;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.35;
const LABELS_AT_ZOOM = 2.2;
const LABEL_BUDGET = 14;
const HOP1_LABELS = 6;
const NARROW_PX = 600;
const NARROW_LABELS = 5;
const DRAG_PX = 4;
const SUGGESTIONS = 14;
const ALERT_LINKS = 3;
const NODE_MIN_R = 5;
const NODE_MAX_R = 13;
const CENTRE_R = 15;
const ARROW_PX = 9;
const CURVE_PX = 16;
const EDGE_MAX_PX = 5;
const st = { address: '', hops: 1, selected: '' };
export const GRAPH_CAPTION = "Direct counterparties in this demo's payments; exact list matches only; no risk scoring.";
const SOURCE_NOTE = 'Senders, chains and assets for the seeded history are assigned by the demo and are not part of the signed receipts. The stream adds its own, and a synthetic background fills out the graph; background payments are not screened and have no receipt.';

const lower = (a) => a.toLowerCase();

/** Point on the way from (x1,y1) towards (x2,y2), `gap` px short of the end. */
function shorten(x1, y1, x2, y2, gap) {
  const d = Math.hypot(x2 - x1, y2 - y1) || 1;
  return [x2 - ((x2 - x1) / d) * gap, y2 - ((y2 - y1) / d) * gap];
}

function nodeShape(listed, r, extra = {}) {
  return listed
    ? svg('rect', { x: -r, y: -r, width: r * 2, height: r * 2, transform: 'rotate(45)', class: 'gshape', ...extra })
    : svg('circle', { r, class: 'gshape', ...extra });
}

export function renderGraph(ctx, root) {
  const { ws, live } = ctx;
  const params = ctx.takeParams('graph');
  const payments = collectPayments(ws, live.tape);
  const suggestions = suggestedAddresses(payments, ws.inForce, SUGGESTIONS);
  if (params.address) { st.address = params.address; st.selected = ''; }
  if (GRAPH_HOPS.includes(params.hops)) st.hops = params.hops;
  if (!st.address) st.address = busiestAddress(payments);
  if (!st.selected) st.selected = st.address;
  clear(root);

  const input = h('input', { id: 'gr-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', value: st.address, placeholder: '0x... or T...' });
  const err = h('p', { class: 'field__hint field__hint--bad', role: 'alert' });
  const pivot = (address) => { st.address = address; st.selected = address; ctx.refresh(); };
  const form = h('form', { class: 'graphform', novalidate: true, on: { submit: (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (!value) { err.textContent = 'Paste an address, or pick one below.'; return; }
    pivot(value);
  } } }, h('label', { for: 'gr-address', class: 'sr', text: 'Address' }), input, h('button', { type: 'submit', class: 'btn btn--primary', id: 'gr-go' }, 'Show counterparties'));

  const graph = buildGraph(payments, st.address, ws.inForce, GRAPH_MAX_NODES, st.hops);
  const maxValue = Math.max(1, ...graph.nodes.map((n) => n.valueUsd));
  const maxEdge = Math.max(1, ...graph.edges.map((e) => e.usd));
  if (!graph.nodes.length) st.selected = st.address;
  const nodeByKey = new Map(graph.nodes.map((n) => [lower(n.address), n]));

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

  // Canvas ------------------------------------------------------------------------------------
  const canvas = h('div', { class: 'graphcanvas', id: 'gr-canvas' });
  const tip = h('div', { class: 'gtip', id: 'gr-tip', role: 'tooltip', hidden: true });
  const panel = h('aside', { class: 'graphside', id: 'gr-panel', 'aria-label': 'Selected address' });
  let svgRoot = null;
  let box = null;
  let base = { w: 0, h: 0 };
  let current = null;

  const showTip = (html, x, y) => {
    tip.replaceChildren(...html);
    tip.hidden = false;
    const w = canvas.clientWidth;
    tip.style.left = `${Math.max(4, Math.min(w - tip.offsetWidth - 4, x + 12))}px`;
    tip.style.top = `${Math.max(4, y + 12)}px`;
  };
  const hideTip = () => { tip.hidden = true; };
  const tipFor = (node) => [h('strong', { class: 'mono', text: shortAddr(node.address) }), h('span', { text: `${node.count} payments, ${money(node.valueUsd)}` }), h('span', { text: `Paid to ${node.hop === 2 ? 'its linked address' : 'the centre'} ${money(node.sentUsd)}, received ${money(node.receivedUsd)}` }), node.listed ? h('span', { class: 'gtip__bad', text: `On list: ${node.entries[0].name}` }) : null];

  const setZoomState = () => {
    if (!svgRoot) return;
    svgRoot.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    svgRoot.dataset.zoom = base.w / box.w >= LABELS_AT_ZOOM ? 'in' : 'out';
  };
  const resetView = () => { box = { x: 0, y: 0, w: base.w, h: base.h }; setZoomState(); };
  const zoomAt = (factor, fx = 0.5, fy = 0.5) => {
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (base.w / box.w) * factor));
    const w = base.w / k;
    const hgt = base.h / k;
    box = { x: box.x + (box.w - w) * fx, y: box.y + (box.h - hgt) * fy, w, h: hgt };
    setZoomState();
  };

  const select = (address) => {
    st.selected = address;
    svgRoot?.querySelectorAll('.gnode').forEach((g) => g.classList.toggle('is-selected', lower(g.dataset.address) === lower(address)));
    svgRoot?.querySelectorAll('.gedge').forEach((e) => e.classList.toggle('gedge--sel', lower(e.dataset.a) === lower(address) || lower(e.dataset.b) === lower(address)));
    drawPanel();
  };

  const drawCanvas = () => {
    const width = Math.max(260, Math.round(canvas.clientWidth) || FALLBACK_WIDTH);
    if (current === width) return;
    current = width;
    const lay = layoutGraph(graph, width);
    base = { w: lay.width, h: lay.height };
    const at = new Map(lay.pos.map((p) => [lower(p.node.address), p]));
    at.set(lower(st.address), { node: graph.center, x: lay.cx, y: lay.cy });
    const radius = (key) => (key === lower(st.address) ? CENTRE_R : NODE_MIN_R + (NODE_MAX_R - NODE_MIN_R) * Math.sqrt((nodeByKey.get(key)?.valueUsd ?? 0) / maxValue));
    const next = svg('svg', { class: 'graph', role: 'group', id: 'gr-svg', width: lay.width, height: lay.height, 'aria-label': `Counterparties of ${st.address}, ${st.hops} hop${st.hops > 1 ? 's' : ''}. ${GRAPH_CAPTION}` });
    next.style.height = `${lay.height}px`;
    const marker = (id, cls) => svg('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: ARROW_PX, markerHeight: ARROW_PX, markerUnits: 'userSpaceOnUse', orient: 'auto' }, svg('path', { d: 'M0 1 L10 5 L0 9 z', class: cls }));
    next.append(svg('defs', {}, marker('gr-arrow', 'garrow'), marker('gr-arrow-bad', 'garrow garrow--bad')));
    next.append(svg('rect', { x: -5000, y: -5000, width: 10000, height: 10000, class: 'gbg' }));

    const reverse = new Set(graph.edges.map((e) => `${lower(e.from)}>${lower(e.to)}`));
    const edgeLayer = svg('g', { class: 'gedges' });
    for (const e of graph.edges) {
      const a = at.get(lower(e.from));
      const b = at.get(lower(e.to));
      if (!a || !b) continue;
      const both = reverse.has(`${lower(e.to)}>${lower(e.from)}`);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const off = both ? CURVE_PX : 0;
      const mx = (a.x + b.x) / 2 + (-dy / d) * off;
      const my = (a.y + b.y) / 2 + (dx / d) * off;
      const [sx, sy] = shorten(mx, my, a.x, a.y, -(radius(lower(e.from)) + 2));
      const [ex, ey] = shorten(mx, my, b.x, b.y, radius(lower(e.to)) + ARROW_PX / 2 + 1);
      const listed = Boolean(nodeByKey.get(lower(e.from))?.listed || nodeByKey.get(lower(e.to))?.listed || (graph.center.listed && (lower(e.from) === lower(st.address) || lower(e.to) === lower(st.address))));
      const path = `M${sx.toFixed(1)} ${sy.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
      const line = svg('path', { d: path, class: `gedge${listed ? ' gedge--listed' : ''}${[lower(e.from), lower(e.to)].includes(lower(st.selected)) ? ' gedge--sel' : ''}${lower(e.from) === lower(st.address) || lower(e.to) === lower(st.address) ? '' : ' gedge--far'}`, 'data-a': e.from, 'data-b': e.to, 'stroke-width': edgeWidth(e.usd, maxEdge, 1, EDGE_MAX_PX).toFixed(2), 'marker-end': `url(#${listed ? 'gr-arrow-bad' : 'gr-arrow'})`, fill: 'none' });
      const hit = svg('path', { d: path, class: 'gedgehit', fill: 'none' });
      const text = [h('strong', { text: `${shortAddr(e.from)} to ${shortAddr(e.to)}` }), h('span', { text: `${e.count} payment${e.count === 1 ? '' : 's'}, ${money(e.usd)}` })];
      hit.addEventListener('pointermove', (ev) => { const r = canvas.getBoundingClientRect(); showTip(text, ev.clientX - r.left, ev.clientY - r.top); });
      hit.addEventListener('pointerleave', hideTip);
      edgeLayer.append(line, hit);
    }
    next.append(edgeLayer);

    let labels = 0;
    const budget = lay.width < NARROW_PX ? NARROW_LABELS : LABEL_BUDGET;
    const hop1Labels = lay.width < NARROW_PX ? 2 : HOP1_LABELS;
    let hop1Seen = 0;
    const nodeLayer = svg('g', { class: 'gnodes' });
    const drawNode = (node, x, y, isCentre) => {
      const key = lower(node.address);
      const r = isCentre ? CENTRE_R : radius(key);
      const alwaysLabel = isCentre || (labels < budget && (node.listed || (node.hop === 1 && hop1Seen++ < hop1Labels)));
      if (alwaysLabel && !isCentre) labels++;
      const g = svg('g', { class: `gnode${node.listed ? ' gnode--listed' : ''}${isCentre ? ' gnode--centre' : ''}${node.hop === 2 ? ' gnode--hop2' : ''}${lower(st.selected) === key ? ' is-selected' : ''}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, tabindex: 0, role: 'button', 'data-address': node.address,
        'aria-label': isCentre ? `Centre, ${shortAddr(node.address)}${node.listed ? ', exact match on the list' : ''}. Press Enter to inspect.` : `${shortAddr(node.address)}${node.listed ? ', exact match on the list' : ''}, ${node.count} payments, ${money(node.valueUsd)}. Press Enter to inspect.` });
      g.append(svg('circle', { r: r + 9, class: 'ghit' }), nodeShape(node.listed, node.listed ? r * 0.9 : r));
      const label = svg('text', { y: r + 14, 'text-anchor': 'middle', class: `glabel${isCentre ? ' glabel--centre' : ''}${alwaysLabel ? '' : ' glabel--hover'}` });
      label.textContent = shortAddr(node.address);
      g.append(label);
      const showNode = () => { const rect = g.getBoundingClientRect(); const c = canvas.getBoundingClientRect(); showTip(isCentre ? [h('strong', { class: 'mono', text: shortAddr(node.address) }), h('span', { text: `Centre of the graph, ${graph.paymentCount} payments` })] : tipFor(node), rect.left - c.left + rect.width / 2, rect.top - c.top + rect.height); };
      g.addEventListener('pointerenter', showNode);
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', showNode);
      g.addEventListener('blur', hideTip);
      g.addEventListener('click', () => select(node.address));
      g.addEventListener('dblclick', () => { if (!isCentre) pivot(node.address); });
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(node.address); } else if (e.key === 'Escape') hideTip();
      });
      nodeLayer.append(g);
    };
    const pos = lay.pos.slice().sort((a, b) => (b.node.listed - a.node.listed) || b.node.valueUsd - a.node.valueUsd);
    for (const p of pos) drawNode(p.node, p.x, p.y, false);
    drawNode(graph.center, lay.cx, lay.cy, true);
    next.append(nodeLayer);

    // Pan by dragging the background; wheel and buttons zoom.
    let drag = null;
    next.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.gnode') || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, bx: box.x, by: box.y, moved: false, id: e.pointerId };
    });
    next.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const rect = next.getBoundingClientRect();
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_PX) return;
      if (!drag.moved) { drag.moved = true; next.setPointerCapture(e.pointerId); next.classList.add('is-panning'); hideTip(); }
      box = { ...box, x: drag.bx - ((e.clientX - drag.x) * box.w) / rect.width, y: drag.by - ((e.clientY - drag.y) * box.h) / rect.height };
      setZoomState();
    });
    const endDrag = () => { drag = null; next.classList.remove('is-panning'); };
    next.addEventListener('pointerup', endDrag);
    next.addEventListener('pointercancel', endDrag);
    next.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = next.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    }, { passive: false });

    if (svgRoot) svgRoot.replaceWith(next); else canvas.prepend(next);
    svgRoot = next;
    resetView();
  };

  const tool = (id, label, text, onClick) => h('button', { type: 'button', class: 'gtool', id, 'aria-label': label, title: label, on: { click: onClick } }, text);
  const tools = h('div', { class: 'gtools', role: 'group', 'aria-label': 'Zoom and pan' },
    tool('gr-zin', 'Zoom in', '+', () => zoomAt(ZOOM_STEP)), tool('gr-zout', 'Zoom out', '−', () => zoomAt(1 / ZOOM_STEP)), tool('gr-reset', 'Reset view', 'Reset', resetView));
  const more = graph.hidden ? h('p', { class: 'gmore', id: 'gr-more', text: `+${graph.hidden} more not drawn (showing at most ${GRAPH_MAX_NODES} addresses)` }) : null;

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
    h('li', {}, svg('svg', { viewBox: '0 0 16 16', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('circle', { cx: 8, cy: 8, r: 6, class: 'gshape' })), 'Not on the list'),
    h('li', {}, svg('svg', { viewBox: '0 0 16 16', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('rect', { x: 3, y: 3, width: 10, height: 10, transform: 'rotate(45 8 8)', class: 'gshape gshape--listed' })), 'Exact match on the list in force'),
    h('li', {}, 'Arrow: direction of payments. Thickness: total value.'),
    h('li', {}, 'Drag to pan, wheel to zoom, double-click a node to centre on it.'));

  const body = graph.nodes.length
    ? h('div', { class: 'graphlayout' }, h('div', { class: 'graphmain' }, canvas, legend), panel)
    : empty('No payments for this address in the demo.', 'Pick a suggested address, or paste one that appears in the receipt explorer.');
  canvas.append(tools, tip);
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

  root.append(...[
    h('p', { class: 'notice' }, h('strong', { text: 'Synthetic payments. ' }), GRAPH_CAPTION, ' ', SOURCE_NOTE),
    card('Counterparty graph', { id: 'gr-card', sub: 'Click a node to inspect it' }, h('div', { class: 'cardbody graphbody' },
      form, err,
      h('div', { class: 'graphpick' }, h('p', { class: 'field__hint', text: 'Suggested starting points (busiest first, number = direct counterparties)' }), chipScroll),
      h('div', { class: 'graphhead' },
        h('span', { class: 'graphhead__label', text: 'Centre' }), h('span', { class: 'mono graphhead__addr', id: 'gr-selected', text: st.address }),
        graph.center.listed ? h('span', { class: 'chip chip--bad', text: `Exact list match: ${graph.center.entries.map((e) => e.name).join('; ').slice(0, 80)}` }) : h('span', { class: 'chip chip--neutral', text: 'Not on the list in force' }),
        h('span', { class: 'graphhead__hops' }, h('span', { class: 'graphhead__label', text: 'Hops' }), hops)),
      h('p', { class: 'field__hint', id: 'gr-summary', text: summary }),
      body)),
    table ? card(st.hops === 2 ? 'Counterparties within two hops, as a table' : 'Counterparties as a table', { id: 'gr-table' }, table) : null].filter(Boolean));

  if (graph.nodes.length) {
    drawPanel();
    drawCanvas();
    new ResizeObserver(() => drawCanvas()).observe(canvas);
  }
  fade();
  void icon;
}
