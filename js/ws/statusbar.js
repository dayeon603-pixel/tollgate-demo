/** Terminal-style status bar: list in force, ledger head, receipts today, stream, alerts, UTC clock. */
import { h } from './dom.js';
import { formatClock, zoneLabel } from './settings.js';
import { isOpenWork } from './engine.js';
import { ageLabel } from './metrics.js';
import { shortHash } from './dom.js';

const STREAM_TEXT = { live: 'LIVE', paused: 'PAUSED', off: 'OFF' };

function cell(label, valueNode, title) {
  return h('div', { class: 'sb__cell', title }, h('span', { class: 'sb__label', text: label }), valueNode);
}

export function buildStatusBar(ctx, host) {
  const v = {
    list: h('a', { class: 'sb__val mono', href: '#lists' }),
    head: h('span', { class: 'sb__val mono' }),
    today: h('span', { class: 'sb__val mono' }),
    rate: h('span', { class: 'sb__val mono' }),
    alerts: h('a', { class: 'sb__val mono', href: '#alerts' }),
    clock: h('span', { class: 'sb__val mono' }),
    clockLabel: h('span', { class: 'sb__label', text: 'UTC' }),
    streamText: h('span', { class: 'sb__streamtext' }),
  };
  const dot = h('span', { class: 'sb__dot', 'aria-hidden': 'true' });
  const stream = h('a', { class: 'sb__stream', href: '#live', 'data-state': 'off', title: 'Simulated payment stream. No network connection: it is generated in this browser.' }, dot, v.streamText);
  while (host.firstChild) host.firstChild.remove();
  host.append(
    cell('LIST', v.list, 'List version in force and how long it has been in force'),
    cell('HEAD', v.head, 'Head hash of the workspace ledger'),
    cell('RECEIPTS TODAY', v.today, 'Workspace ledger receipts dated today (UTC). Stream receipts are counted separately.'),
    cell('STREAM', v.rate, 'Screenings per second over the last 5 seconds'),
    cell('OPEN ALERTS', v.alerts, 'Open and in-progress alerts'),
    h('div', { class: 'sb__spacer' }),
    h('div', { class: 'sb__cell' }, v.clockLabel, v.clock),
    stream);

  let cache = { size: -1, day: '', count: 0 };
  const todayCount = (ws, day) => {
    if (cache.size === ws.ledger.size && cache.day === day) return cache.count;
    cache = { size: ws.ledger.size, day, count: ws.ledger.entries.filter((e) => e.receipt.action.requested_at.startsWith(day)).length };
    return cache.count;
  };
  return function update() {
    const { ws, live } = ctx;
    if (!ws || !live) return;
    const now = ctx.now();
    const iso = now.toISOString();
    const inForce = ws.inForce;
    const since = ws.listHistory.at(-1)?.from;
    v.list.textContent = inForce ? `${inForce.label.replace('List ', '')} · ${since ? ageLabel(since, now) : 'new'}` : 'none';
    v.head.textContent = shortHash(ws.ledger.head() ?? '', 6, 4);
    v.today.textContent = String(todayCount(ws, iso.slice(0, 10)));
    v.alerts.textContent = String(ws.alerts.filter(isOpenWork).length);
    v.clock.textContent = formatClock(now);
    v.clockLabel.textContent = zoneLabel();
    const state = live.runner.state;
    v.rate.textContent = state === 'live' ? `${live.tape.rate(now.getTime()).toFixed(1)}/s` : state === 'paused' ? 'paused' : '0.0/s';
    stream.dataset.state = state;
    v.streamText.textContent = `DEMO STREAM ${STREAM_TEXT[state]} (synthetic)`;
  };
}
