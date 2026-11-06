/** Dashboard: volume, outcomes, open work, receipts and the list in force. All volumes are synthetic. */
import { card, clear, h, kv, mono, money, stamp } from './dom.js';
import { chartTable, hbars, legend, SERIES, stackedBars } from './charts.js';
import { sparkline } from './live-chart.js';
import { describe } from './describe.js';
import { isOpenWork } from './engine.js';
import { summary } from './metrics.js';
import { ageLabel } from './metrics.js';

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}% of screened` : 'no data');

function kpi(label, value, sub, route, ctx, spark = null) {
  const name = route
    ? h('a', { href: `#${route}`, on: { click: () => ctx.setParams(route, {}) } }, label)
    : label;
  return h('div', { class: 'kpi' }, h('dt', {}, name), h('dd', { text: String(value) }), h('p', { class: 'kpi__sub', text: sub }), spark ? h('div', { class: 'kpi__spark' }, sparkline(spark.values, { cls: spark.cls })) : null);
}

export function renderDashboard(ctx, root) {
  const { ws } = ctx;
  const now = ctx.now();
  const s = summary(ws, now);
  clear(root);
  const markers = ws.listHistory.slice(1).map((entry) => ({ date: entry.from.slice(0, 10), label: ws.version(entry.versionId).label }));
  const versionLine = s.listVersion ? `${s.listVersion.label}${s.listVersion.real ? ' (OFAC snapshot)' : ' (demo)'}` : 'none';

  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'Synthetic demo data. ' }), `The ${s.total} payments below were generated for this demo. Receipts, signatures and the list are real; the volumes, counterparties and people are not.`),
    h('dl', { class: 'kpis' },
      kpi('Screened, 30 days', s.total, 'demo volume', 'explorer', ctx, { values: s.rows.map((r) => r.total), cls: 'allow' }),
      kpi('Allowed', s.allow, pct(s.allow, s.total), null, ctx, { values: s.rows.map((r) => r.allow), cls: 'allow' }),
      kpi('Held by policy', s.hold, pct(s.hold, s.total), 'alerts', ctx, { values: s.rows.map((r) => r.hold), cls: 'hold' }),
      kpi('Hits on the list', s.block, pct(s.block, s.total), 'alerts', ctx, { values: s.rows.map((r) => r.block), cls: 'block' }),
      kpi('Open alerts', s.openAlerts, `${s.awaitingApproval} awaiting approval`, 'alerts', ctx),
      kpi('Receipts issued', s.receipts, `in ${s.segments} ledger segments`, 'explorer', ctx),
      kpi('List in force', s.listVersion ? s.listVersion.label : 'none', `${s.listVersion?.real ? 'OFAC snapshot' : 'demo version'}${s.listChangedAt ? `, since ${stamp(s.listChangedAt).slice(0, 10)}` : ''}`, 'lists', ctx),
    ),
  );

  const volume = card('Screenings per day', { id: 'dash-volume', sub: 'Last 30 days, UTC. Synthetic volume.' },
    h('div', { class: 'chartbox' },
      stackedBars({ rows: s.rows, markers, title: `Screenings per day over the last 30 days: ${s.allow} allow, ${s.hold} hold, ${s.block} hit.`, id: 'c-volume' }),
      legend(SERIES),
      chartTable(['Day', 'Allow', 'Hold', 'Hit', 'Total'], s.rows.map((r) => [r.date, r.allow, r.hold, r.block, r.total]))),
  );

  const statusItems = [['open', 'Open'], ['in_review', 'In review'], ['escalated', 'Escalated'], ['cleared', 'Cleared'], ['confirmed', 'Confirmed']].map(([key, label]) => ({ label, value: s.byStatus[key], cls: `s-${key}` }));
  const status = card('Alerts by status', { id: 'dash-status', sub: `${ws.alerts.length} alerts in total` },
    h('div', { class: 'chartbox' }, hbars({ items: statusItems, id: 'c-status', title: `Alerts by status: ${statusItems.map((i) => `${i.label} ${i.value}`).join(', ')}.` }),
      chartTable(['Status', 'Alerts'], statusItems.map((i) => [i.label, i.value]))));

  const open = ws.alerts.filter(isOpenWork);
  const unassigned = open.filter((a) => !a.assignee);
  const oldest = open.length ? open.reduce((a, b) => (Date.parse(a.createdAt) < Date.parse(b.createdAt) ? a : b)) : null;
  const mine = ws.alerts.filter((a) => a.pending && a.pending.by !== ctx.userId && ws.can(ctx.userId, 'approve_clear'));
  const attention = [];
  if (mine.length) attention.push(['Waiting for your approval', `${mine.length} clearance${mine.length === 1 ? '' : 's'} proposed by someone else.`, 'alerts', { status: 'pending' }]);
  if (s.pendingVersion) attention.push(['List update available', `${s.pendingVersion.label} (${s.pendingVersion.real ? `OFAC snapshot, published ${s.pendingVersion.publishDate}` : 'demo'}). Preview what it changes before applying.`, 'lists', {}]);
  if (unassigned.length) attention.push(['Unassigned', `${unassigned.length} open alert${unassigned.length === 1 ? ' has' : 's have'} no owner.`, 'alerts', { status: 'work', assignee: 'none' }]);
  if (oldest) attention.push(['Oldest open alert', `${oldest.id}, open for ${ageLabel(oldest.createdAt, now)}.`, 'alerts', { status: 'work', q: oldest.id }]);
  const lookbackOpen = open.filter((a) => a.kind === 'lookback').length;
  if (lookbackOpen) attention.push(['Lookback hits', `${lookbackOpen} earlier payment group${lookbackOpen === 1 ? '' : 's'} now match the list.`, 'alerts', { status: 'work', kind: 'lookback' }]);
  const needs = card('Needs attention', { id: 'dash-attn' },
    attention.length
      ? h('ul', { class: 'attn' }, attention.map(([title, text, route, params]) => h('li', {}, h('a', { href: `#${route}`, on: { click: () => ctx.setParams(route, params) } }, title), h('span', { text }))))
      : h('p', { class: 'card__note', text: 'Nothing is waiting.' }));

  const recent = ws.ledger.entries.filter((e) => !['stablecoin_payment_screen', 'segment_open', 'watchlist_rescreen'].includes(e.receipt.action.type)).slice(-8).reverse();
  const activity = card('Recent activity', { id: 'dash-activity', sub: 'Every line is a signed receipt' },
    h('ul', { class: 'feed' }, recent.map((entry) => {
      const d = describe(ws, entry);
      return h('li', {}, h('span', { class: 'feed__time mono', text: stamp(entry.receipt.action.requested_at) }), h('span', { class: 'feed__text' }, h('strong', { text: d.actor }), ' ', d.text),
        h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(entry.receipt.receipt_id) } }, entry.receipt.receipt_id.replace('rcpt:', '')));
    })));

  const ledger = card('Ledger', { id: 'dash-ledger' }, h('div', { class: 'card__note' }, kv([
    ['Receipts', `${s.receipts} in ${s.segments} segments`],
    ['Head hash', mono(ws.ledger.head())],
    ['List in force', `${versionLine}, digest ${s.listVersion ? s.listVersion.digest.slice(0, 16) : ''}…`],
    ['Money in view', money(ws.txs.reduce((sum, t) => sum + (t.amountUsd ?? 0), 0)) + ' screened (synthetic)'],
  ])));

  root.append(volume, h('div', { class: 'cols' }, status, needs), h('div', { class: 'cols' }, activity, ledger));
}
