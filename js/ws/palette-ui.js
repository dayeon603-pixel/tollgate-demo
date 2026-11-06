/** Command palette dialog (Ctrl or Cmd + K). Matching lives in palette.js. */
import { clear, h } from './dom.js';
import { buildCommands, rankCommands } from './palette.js';
import { suggestedAddresses, collectPayments } from './graph.js';
import { WS_ROUTES } from './workspace-routes.js';

const MAX_ALERT_ITEMS = 200;
const MAX_ADDRESS_ITEMS = 120;

export function initPalette(ctx, { actions, run }) {
  const dlg = document.getElementById('ws-palette');
  const input = document.getElementById('ws-palette-input');
  const list = document.getElementById('ws-palette-list');
  let items = [];
  let shown = [];
  let at = 0;

  const collect = () => {
    const { ws, live } = ctx;
    const seen = new Set();
    const addresses = [];
    const add = (address, note) => { const k = address.toLowerCase(); if (!seen.has(k) && addresses.length < MAX_ADDRESS_ITEMS) { seen.add(k); addresses.push({ address, note }); } };
    for (const a of ws.alerts.slice(-60)) add(a.address, `alert ${a.id}`);
    for (const w of ws.watch) add(w.address, 'watchlist');
    for (const s of suggestedAddresses(collectPayments(ws, live.tape), ws.inForce, 40)) add(s.address, s.listed ? 'on the list' : 'counterparty');
    return buildCommands({ routes: WS_ROUTES, alerts: ws.alerts.slice(-MAX_ALERT_ITEMS).reverse(), addresses, actions });
  };

  const draw = () => {
    shown = rankCommands(items, input.value);
    at = Math.min(at, Math.max(0, shown.length - 1));
    clear(list);
    if (!shown.length) list.append(h('li', { class: 'palette__none', role: 'presentation', text: 'Nothing matches. Try a view name, an alert id or an address.' }));
    shown.forEach((item, i) => list.append(h('li', { id: `pal-${i}`, role: 'option', 'aria-selected': String(i === at), class: 'palette__item', 'data-kind': item.kind, on: { click: () => choose(item), mousemove: () => { if (at !== i) { at = i; mark(); } } } },
      h('span', { class: 'palette__title', text: item.title }), h('span', { class: 'palette__hint', text: item.hint }))));
    input.setAttribute('aria-activedescendant', shown.length ? `pal-${at}` : '');
  };
  const mark = () => {
    list.querySelectorAll('[role=option]').forEach((li, i) => li.setAttribute('aria-selected', String(i === at)));
    input.setAttribute('aria-activedescendant', `pal-${at}`);
    list.children[at]?.scrollIntoView?.({ block: 'nearest' });
  };
  const choose = (item) => {
    dlg.close();
    const p = item.payload;
    if (p.route) ctx.go(p.route);
    else if (p.alertId) ctx.openAlert(p.alertId);
    else if (p.address) ctx.go('graph', { address: p.address });
    else if (p.action) run(p.action);
  };
  const open = () => {
    if (!ctx.ws) return;
    items = collect();
    input.value = '';
    at = 0;
    draw();
    if (!dlg.open) dlg.showModal();
    input.focus();
  };
  input.addEventListener('input', () => { at = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); mark(); }
    else if (e.key === 'Enter' && shown[at]) { e.preventDefault(); choose(shown[at]); }
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (dlg.open) dlg.close(); else open(); }
  });
  return { open };
}
