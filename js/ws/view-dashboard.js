/** Dashboard: volume, outcomes, open work, receipts and the list in force. All volumes are synthetic. */
import { card, clear, h, kv, mono, money, stamp } from './dom.js';
import { formatDate } from './settings.js';
import { axisDate, barList, createChart } from './chartx.js';
import { formatNumber } from './settings.js';
import { gateSummary, networkSummary } from './net-metrics.js';
import { loadMoatData } from './moat-data.js';
import { chip } from './moat-ui.js';
import { sparkline } from './live-chart.js';
import { describe } from './describe.js';
import { chainHero } from './view-chain.js';
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

/** "Why this compounds": four tiles that link to the receipt network, the list archive, the gate and the proof gap. */
function compounds(ctx) {
  const { ws } = ctx;
  const net = networkSummary(ws);
  const gate = gateSummary(ws);
  const tile = (id, route, label, value, sub, tag, params = {}) => h('a', { class: 'compound', id, href: `#${route}`, on: { click: () => ctx.setParams(route, params) } },
    h('span', { class: 'compound__label', text: label }), h('span', { class: 'compound__value', id: `${id}-v`, text: value }), h('span', { class: 'compound__sub', id: `${id}-s`, text: sub }), tag);
  const archive = tile('cp-archive', 'archive', 'History nobody can backfill', '...', 'OFAC postings time-stamped, real', chip('Real data', 'ok'));
  const proof = tile('cp-proof', 'proofgap', 'Public proof gap', '...', 'of 61 USDC freezes on Ethereum, from public data', chip('Real data', 'ok'));
  void loadMoatData('archive').then((a) => {
    archive.querySelector('#cp-archive-v').textContent = `${a.postings.length} postings`;
    archive.querySelector('#cp-archive-s').textContent = `${a.live_proof.anchored} of ${a.live_proof.receipts} receipts anchored in Bitcoin blocks. Real.`;
  }).catch(() => { archive.querySelector('#cp-archive-v').textContent = 'unavailable'; });
  void loadMoatData('proofgap').then((p) => {
    const row = p.rows.find((r) => r.stream === 'USDC (Ethereum)' && r.subset.startsWith('after'));
    proof.querySelector('#cp-proof-v').textContent = row.gap.split(' ')[0];
    proof.querySelector('#cp-proof-s').textContent = `${row.gap.slice(row.gap.indexOf('['))} of ${row.n} USDC freezes on Ethereum after 2023-12-09 have no provable order from public data.`;
  }).catch(() => { proof.querySelector('#cp-proof-v').textContent = 'unavailable'; });
  return h('section', { class: 'compounds', id: 'dash-compounds', 'aria-labelledby': 'dash-compounds-h' },
    h('h2', { class: 'compounds__title', id: 'dash-compounds-h', text: 'Network and proof' }),
    h('div', { class: 'compounds__grid' },
      tile('cp-network', 'network', 'Re-screens avoided via accepted receipts (demo)', formatNumber(net.avoided), `${net.pinned} demo members pinned. ${net.rescreened} inbound payments screened here.`, chip('Demo data', 'neutral')),
      archive,
      tile('cp-gate', 'network', 'Payment gate (demo)', `${formatNumber(gate.released)} released`, `${formatNumber(gate.blocked)} blocked for a missing, stale or unclear receipt.`, chip('Demo data', 'neutral'), { focus: 'nw-gate' }),
      proof));
}

export function renderDashboard(ctx, root) {
  const { ws } = ctx;
  const now = ctx.now();
  const s = summary(ws, now);
  clear(root);
  const markers = ws.listHistory.slice(1).map((entry) => ({ date: entry.from.slice(0, 10), label: ws.version(entry.versionId).label }));
  const versionLine = s.listVersion ? `${s.listVersion.label}${s.listVersion.real ? ' (OFAC snapshot)' : ' (demo)'}` : 'none';

  root.append(
    chainHero(ctx),
    h('p', { class: 'demo-line' }, 'Below the live chain: sample payments and people. The sanctions list, signatures and receipts are real.'),
    h('dl', { class: 'kpis' },
      kpi('Screened, 30 days', s.total, `${s.allow} allowed`, 'explorer', ctx, { values: s.rows.map((r) => r.total), cls: 'allow' }),
      kpi('Held by policy', s.hold, pct(s.hold, s.total), 'alerts', ctx, { values: s.rows.map((r) => r.hold), cls: 'hold' }),
      kpi('Hits on the list', s.block, pct(s.block, s.total), 'alerts', ctx, { values: s.rows.map((r) => r.block), cls: 'block' }),
      kpi('Open alerts', s.openAlerts, `${s.awaitingApproval} awaiting approval`, 'alerts', ctx),
      kpi('List in force', s.listVersion ? s.listVersion.label : 'none', `${s.listVersion?.real ? 'OFAC snapshot' : 'demo version'}${s.listChangedAt ? `, since ${formatDate(s.listChangedAt)}` : ''}`, 'lists', ctx),
    ),
  );

  const volumeChart = createChart({
    id: 'c-volume', integerAxis: true, title: `Screenings per day over the last 30 days: ${s.allow} allow, ${s.hold} hold, ${s.block} hit.`, kind: 'bars', stacked: true, height: 210,
    series: [{ key: 'allow', label: 'Allow', cls: 'allow' }, { key: 'hold', label: 'Hold', cls: 'hold' }, { key: 'block', label: 'Hit', cls: 'block', pattern: true }],
    xFmt: axisDate, tableLabel: 'Day (UTC)', valueFmt: (v) => formatNumber(v ?? 0),
    markers: markers.map((m) => ({ t: Date.parse(`${m.date}T00:00:00Z`), label: m.label })),
  });
  volumeChart.update(s.rows.map((r) => ({ t: Date.parse(`${r.date}T00:00:00Z`), values: { allow: r.allow, hold: r.hold, block: r.block } })));
  const volume = card('Screenings per day', { id: 'dash-volume', sub: 'Last 30 days, UTC' }, volumeChart.el);

  const statusItems = [['open', 'Open'], ['in_review', 'In review'], ['escalated', 'Escalated'], ['cleared', 'Cleared'], ['confirmed', 'Confirmed']].map(([key, label]) => ({ label, value: s.byStatus[key], cls: `s-${key}` }));
  const status = card('Alerts by status', { id: 'dash-status', sub: `${ws.alerts.length} alerts in total` },
    h('div', { class: 'chartbox' }, barList({ items: statusItems, id: 'c-status', title: `Alerts by status: ${statusItems.map((i) => `${i.label} ${i.value}`).join(', ')}.` })));

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
  const activity = card('Recent activity', { id: 'dash-activity' },
    h('ul', { class: 'feed' }, recent.map((entry) => {
      const d = describe(ws, entry);
      return h('li', {}, h('span', { class: 'feed__time tnum', text: stamp(entry.receipt.action.requested_at) }), h('span', { class: 'feed__text' }, h('strong', { text: d.actor }), ' ', d.text),
        h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(entry.receipt.receipt_id) } }, entry.receipt.receipt_id.replace('rcpt:', '')));
    })));

  const ledger = card('Ledger', { id: 'dash-ledger' }, h('div', { class: 'card__note' }, kv([
    ['Receipts', `${s.receipts} in ${s.segments} segments`],
    ['Head hash', mono(ws.ledger.head())],
    ['List in force', `${versionLine}, digest ${s.listVersion ? s.listVersion.digest.slice(0, 16) : ''}…`],
    ['Money in view', money(ws.txs.reduce((sum, t) => sum + (t.amountUsd ?? 0), 0)) + ' screened (synthetic)'],
  ])));

  root.append(compounds(ctx), volume, h('div', { class: 'cols' }, status, needs), h('div', { class: 'cols' }, activity, ledger));
}
