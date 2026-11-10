/**
 * Network view: counterparty registry, inbound payments that arrive with the sender's receipt, the
 * acceptance log, and the payment gate. The members are made up ("Demo Exchange A, B, C"); the keys,
 * signatures and checks are real (see network.js). Describes how Tollgate works across members and
 * shows it with demo members.
 */
import { card, clear, dataTable, empty, field, h, mono, select, shortHash, stamp } from './dom.js';
import { zoneName } from './dom.js';
import { axisDate, compact, createChart } from './chartx.js';
import { chip, guardedButton, roleReason } from './moat-ui.js';
import { formatNumber } from './settings.js';
import { GATE_PRESETS, SCENARIOS } from './net-flow.js';
import { coverageByMembers, gateDaily, gateSummary, inboundDaily, networkSummary } from './net-metrics.js';
import { BASIS_WORDS, FRESHNESS_MS, reasonLabel } from './network.js';
import { gateLabel, gateText } from './gate.js';

const st = { sender: '', scenario: 'valid', address: '', amount: '2500', revoking: null, reason: '', result: null, gate: null, logPage: 0 };
const LOG_PAGE = 12;
const STATUS_TONE = { pinned: 'ok', registered: 'neutral', revoked: 'bad' };
const STATUS_TEXT = { pinned: 'Pinned', registered: 'Registered, not pinned', revoked: 'Revoked' };
const MIN_REVOKE_NOTE = 10;
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'no data');

function defaultAddress(ws) {
  return `0x${[...String(ws.net.reliances.length + 1).padStart(2, '0')].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(40, '5').slice(0, 40)}`;
}

function listedAddress(ws) {
  return [...ws.inForce.byAddress.values()].map((e) => e[0]).find((e) => !e.synthetic && /^0x[0-9a-f]{40}$/i.test(e.address))?.address ?? '';
}

function reasonChips(reasons) {
  if (!reasons?.length) return chip('Accepted', 'ok');
  return h('span', { class: 'chips' }, reasons.map((r) => chip(r.label || reasonLabel(r.code), r.code === 'no_receipt' ? 'neutral' : 'bad')));
}

/** The panel under the form: what happened to the payment just received. */
function resultPanel(ctx, res) {
  if (!res) return h('p', { class: 'card__note', id: 'nw-result', text: 'Pick a sender and a scenario, then press Receive. The result appears here with every reason.' });
  const { result, record, screen } = res;
  const accepted = record.outcome === 'ACCEPTED';
  const ws = ctx.ws;
  const facts = [
    ['Sender', record.issuerName],
    ['Receipt', record.presentedReceiptId ? mono(record.presentedReceiptId.replace('rcpt:', '')) : 'none'],
    ['List the receipt used', record.listVersionId ?? 'not a list this workspace holds'],
    ['List in force here', record.listInForceId],
    ['Time basis', "Issuer's word (the demo seals nothing)"],
  ];
  const children = [
    h('div', { class: 'banner', 'data-state': accepted ? 'pass' : record.outcome === 'NONE' ? 'caveat' : 'fail', role: 'status' },
      h('span', { class: 'banner__lead', text: accepted ? BASIS_WORDS.issuer_word : record.outcome === 'NONE' ? 'NO RECEIPT, SCREENED HERE' : 'REFUSED, SCREENED HERE' }),
      h('span', { class: 'banner__detail', text: accepted ? 'The second screening was skipped. A reliance receipt was signed and added to your ledger.' : (result.reasons[0]?.text ?? '') })),
    h('dl', { class: 'kv kv--tight' }, facts.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', {}, v)))),
  ];
  if (!accepted) {
    children.push(h('h3', { class: 'subhead', text: result.reasons.length > 1 ? 'Every reason found' : 'Reason' }),
      h('ul', { class: 'plain' }, result.reasons.map((r) => h('li', {}, h('strong', { text: `${r.label}. ` }), r.text))));
    if (screen) {
      const tx = screen.tx;
      children.push(h('p', { class: 'field__hint' }, `Screened here instead: ${({ ALLOW: 'allowed', HOLD: 'held', BLOCK: 'hit on the list' })[tx.outcome]}. `,
        tx.alertId ? h('button', { type: 'button', class: 'linkbtn', on: { click: () => ctx.openAlert(tx.alertId) } }, `Open ${tx.alertId}`) : null));
    }
  }
  children.push(h('p', { class: 'field__hint' }, 'Reliance receipt ', h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(record.receiptId) } }, record.receiptId.replace('rcpt:', '')), `. A refused receipt is also signed, with verdict DENY.`));
  return h('div', { id: 'nw-result' }, children);
}

function gateResultPanel(ctx, res) {
  if (!res) return h('p', { class: 'card__note', id: 'gt-result', text: 'Pick a transfer to try. The gate releases it only with a valid, current receipt that cleared it, and says why when it does not.' });
  const r = res.record;
  return h('div', { id: 'gt-result' },
    h('div', { class: 'banner', 'data-state': r.release ? 'pass' : 'fail', role: 'status' },
      h('span', { class: 'banner__lead', text: r.release ? 'RELEASED' : 'BLOCKED' }),
      h('span', { class: 'banner__detail', text: r.release ? `Transfer ${r.transferId} came with a valid, current receipt that cleared it.` : gateText(r.reasons[0]) })),
    r.release ? null : h('ul', { class: 'plain' }, r.reasons.map((c) => h('li', {}, h('strong', { text: `${gateLabel(c)}. ` }), gateText(c)))),
    h('p', { class: 'field__hint' }, 'Gate receipt ', h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(r.receiptId) } }, r.receiptId.replace('rcpt:', ''))));
}

export function renderNetwork(ctx, root) {
  const { ws } = ctx;
  const params = ctx.takeParams('network');
  const now = ctx.now();
  const sum = networkSummary(ws);
  const gates = gateSummary(ws);
  const members = ws.net.members;
  const userId = ctx.userId;
  clear(root);
  if (!st.sender || !ws.member(st.sender)) st.sender = (members.find((m) => m.status === 'pinned') ?? members[0])?.keyId ?? '';
  if (!st.address) st.address = defaultAddress(ws);

  // ---- intro and numbers -------------------------------------------------------------------
  const intro = h('details', { class: 'card moat-intro', id: 'nw-intro' },
    h('summary', { class: 'card__head' }, h('span', { class: 'card__title', text: 'How shared receipts work' })),
    h('div', { class: 'cardbody' },
      h('ol', { class: 'steps' },
        h('li', { text: 'A member screens a payment and signs a receipt with its own key. It can share that one receipt with the member receiving the funds.' }),
        h('li', { text: 'You pin the member\'s public key. You can revoke it later; revoking and pinning are both signed receipts.' }),
        h('li', { text: 'Every receipt a pinned member sends is now worth a skipped screening. Every receipt you send is worth the same to the members who pinned you.' })),
      h('p', { class: 'field__hint', text: 'Your own list always wins: a receipt that says clear for an address on your list is refused. Receipts here carry the issuer\'s word only, because nothing in the demo is sealed.' })));

  const kpi = (label, value, sub, id) => h('div', { class: 'kpi', id }, h('dt', { text: label }), h('dd', { text: value }), h('p', { class: 'kpi__sub', text: sub }));
  const kpis = h('dl', { class: 'kpis kpis--moat' },
    kpi('Re-screens avoided via accepted receipts (demo)', formatNumber(sum.avoided), `${pct(sum.avoided, sum.total)} of ${sum.total} inbound payments`, 'nw-k-avoided'),
    kpi('Re-screened here', formatNumber(sum.rescreened), `${sum.refused} refused receipts, ${sum.none} with no receipt`, 'nw-k-rescreened'),
    kpi('Members pinned', String(sum.pinned), `${members.filter((m) => m.status === 'revoked').length} key revoked`, 'nw-k-pinned'),
    kpi('Gate', `${gates.released} released`, `${gates.blocked} blocked`, 'nw-k-gate'));

  // ---- receive form --------------------------------------------------------------------------
  const senderReason = roleReason(ws, userId, 'network_present');
  const senderSel = select('nw-sender', members.map((m) => ({ value: m.keyId, label: `${m.name} (${STATUS_TEXT[m.status].toLowerCase()})` })), st.sender, (v) => { st.sender = v; });
  const scenarioSel = select('nw-scenario', SCENARIOS.map((s) => ({ value: s.id, label: s.label })), st.scenario, (v) => { st.scenario = v; ctx.refresh(); });
  const address = h('input', { id: 'nw-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', value: st.scenario === 'listed' ? listedAddress(ws) : st.address, disabled: st.scenario === 'listed' });
  address.addEventListener('input', () => { st.address = address.value; });
  const amount = h('input', { id: 'nw-amount', class: 'input', type: 'text', inputmode: 'numeric', value: st.amount });
  amount.addEventListener('input', () => { st.amount = amount.value; });
  if (senderReason) for (const el of [senderSel, scenarioSel, address, amount]) el.disabled = true;
  const receive = guardedButton({
    label: 'Receive', cls: 'btn btn--primary', id: 'nw-receive', reason: senderReason,
    onClick: async () => {
      const out = await ctx.receive({
        senderKeyId: st.sender, kind: st.scenario, address: st.scenario === 'listed' ? listedAddress(ws) : st.address.trim(), chain: /^T/.test(st.address) ? 'tron' : 'ethereum',
        amountUsd: st.amount.replace(/,/g, '').trim() === '' ? null : st.amount.replace(/,/g, '').trim(),
      }, { refresh: false });
      if (out.ok) { st.result = out; st.address = ''; ctx.refresh(); }
    },
  });
  const burst = guardedButton({
    label: 'Receive 10 mixed', id: 'nw-burst', reason: senderReason,
    onClick: async () => {
      const mix = ['valid', 'valid', 'valid', 'none', 'valid', 'tampered', 'valid', 'unknown', 'valid', 'stale'];
      const pinned = members.filter((m) => m.status === 'pinned');
      let last = null;
      for (let i = 0; i < mix.length; i++) {
        const sender = pinned.length ? pinned[i % pinned.length] : members[0];
        const addr = `0x${(i + 1 + ws.net.reliances.length).toString(16).padStart(40, 'a')}`;
        const out = await ctx.receive({ senderKeyId: sender.keyId, kind: mix[i], address: addr, chain: 'ethereum', amountUsd: String(300 + i * 175) }, { refresh: false });
        if (!out.ok) break;
        last = out;
      }
      if (last) st.result = last;
      ctx.refresh();
    },
  });
  const form = card('Receive an inbound payment', { id: 'nw-receive-card' },
    h('div', { class: 'cardbody' },
      h('div', { class: 'filters nw-form' }, field('Sender', senderSel), field('Receipt', scenarioSel), field('Address to screen', address, st.scenario === 'listed' ? 'Uses an address that is on the list in force.' : undefined), field('Amount in USD', amount)),
      h('div', { class: 'btnrow' }, receive, burst),
      resultPanel(ctx, st.result)));

  // ---- charts --------------------------------------------------------------------------------
  const days = inboundDaily(ws, now);
  const daily = createChart({
    id: 'c-net-daily', integerAxis: true, title: 'Inbound payments per day: accepted receipts, refused receipts and payments with no receipt', kind: 'bars', stacked: true, height: 200,
    series: [{ key: 'accepted', label: 'Accepted receipt (screening skipped)', cls: 'acc' }, { key: 'refused', label: 'Refused receipt (screened here)', cls: 'rej', pattern: true }, { key: 'none', label: 'No receipt (screened here)', cls: 'rescr' }],
    xFmt: axisDate, tableLabel: 'Day (UTC)', yFmt: compact, valueFmt: (v) => formatNumber(v ?? 0),
  });
  daily.update(days.map((d) => ({ t: d.t, values: { accepted: d.accepted, refused: d.refused, none: d.none } })));
  const cover = coverageByMembers(ws);
  const coverage = createChart({
    id: 'c-net-cover', title: 'Share of inbound payments covered by accepted receipts, by how many members are pinned', kind: 'bars', height: 180, brush: false,
    series: [{ key: 'share', label: 'Share of inbound payments', cls: 'acc' }],
    xFmt: (k, long) => (long ? `${k} member${k === 1 ? '' : 's'} pinned: ${cover[k]?.name ?? ''}` : String(k)), yFmt: (v) => `${Math.round(v)}%`, valueFmt: (v) => `${(v ?? 0).toFixed(1)}%`, tableLabel: 'Members pinned',
  });
  coverage.update(cover.map((c) => ({ t: c.k, values: { share: c.share * 100 } })));
  const charts = h('div', { class: 'cols cols--charts' },
    card('Inbound payments per day', { id: 'nw-c1', sub: 'Last 30 days, UTC' }, daily.el),
    card('More members, more covered', { id: 'nw-c2', sub: 'Share of inbound payments covered, by members pinned' }, coverage.el));

  // ---- registry ------------------------------------------------------------------------------
  const trustReason = roleReason(ws, userId, 'network_trust');
  const registry = card('Counterparty registry', { id: 'nw-registry',
    actions: h('div', { class: 'btnrow' }, guardedButton({ label: 'Register another demo member', id: 'nw-add', reason: trustReason, onClick: () => ctx.addMember() })) },
  dataTable({
    caption: 'Counterparty registry', rows: members, rowKey: (m) => m.keyId,
    cols: [
      { label: 'Member', render: (m) => h('span', {}, m.name) },
      { label: 'Public key', render: (m) => mono(shortHash(m.keyId, 10, 6)), cls: 'mono' },
      { label: 'Status', render: (m) => chip(STATUS_TEXT[m.status], STATUS_TONE[m.status]) },
      { label: 'Accepted', num: true, render: (m) => String(sum.byMember.find((x) => x.keyId === m.keyId)?.accepted ?? 0) },
      { label: 'Refused', num: true, render: (m) => String(sum.byMember.find((x) => x.keyId === m.keyId)?.refused ?? 0) },
      { label: 'Last change', render: (m) => (m.receiptId ? h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(m.receiptId) } }, m.receiptId.replace('rcpt:', '')) : '') },
      { label: 'Action', render: (m) => {
        if (st.revoking === m.keyId) {
          const reason = h('input', { id: 'nw-revoke-reason', class: 'input', type: 'text', placeholder: 'Why? (10 or more characters)', value: st.reason, 'aria-label': `Reason for revoking ${m.name}` });
          reason.addEventListener('input', () => { st.reason = reason.value; });
          return h('span', { class: 'btnrow btnrow--tight' }, reason,
            h('button', { type: 'button', class: 'btn btn--danger', id: 'nw-revoke-go', on: { click: async () => {
              if (st.reason.trim().length < MIN_REVOKE_NOTE) { ctx.toast(`Write a reason of at least ${MIN_REVOKE_NOTE} characters.`, 'bad'); return; }
              const r = await ctx.run({ op: 'netTrust', actor: userId, action: 'revoke', keyId: m.keyId, reason: st.reason });
              if (r.ok) { st.revoking = null; st.reason = ''; ctx.refresh(); }
            } } }, 'Confirm revoke'),
            h('button', { type: 'button', class: 'btn', on: { click: () => { st.revoking = null; ctx.refresh(); } } }, 'Cancel'));
        }
        return h('span', { class: 'btnrow btnrow--tight' },
          m.status === 'revoked' ? h('span', { class: 'muted', text: 'Stays revoked' }) : null,
          m.status === 'registered' ? guardedButton({ label: 'Pin key', id: `nw-pin-${m.keyId.slice(0, 6)}`, reason: trustReason, onClick: () => ctx.run({ op: 'netTrust', actor: userId, action: 'pin', keyId: m.keyId }) }) : null,
          m.status !== 'revoked' ? guardedButton({ label: 'Revoke', id: `nw-revoke-${m.keyId.slice(0, 6)}`, reason: trustReason, onClick: () => { st.revoking = m.keyId; ctx.refresh(); } }) : null);
      } },
    ],
  }),
  h('div', { class: 'cardbody' }, h('p', { class: 'field__hint', text: 'A revoked key stays revoked: an unsealed receipt from it is refused whatever time it claims, so a member that rotates its key registers the new one. Pin, register and revoke are admin actions in this demo. A real deployment would ask for a second person.' })));

  // ---- log -----------------------------------------------------------------------------------
  const log = [...ws.net.reliances].reverse();
  const page = Math.min(st.logPage, Math.max(0, Math.ceil(log.length / LOG_PAGE) - 1));
  const rows = log.slice(page * LOG_PAGE, (page + 1) * LOG_PAGE);
  const logCard = card('Receipt acceptance log', { id: 'nw-log' },
    dataTable({
      caption: 'Inbound payments and what Tollgate did with their receipts', rows, rowKey: (r) => r.id, onOpen: (r) => ctx.openReceipt(r.receiptId),
      empty: empty('No inbound payments yet.', 'Receive one above.'),
      cols: [
        { label: `Time (${zoneName()})`, render: (r) => stamp(r.ts), open: true },
        { label: 'Sender', render: (r) => r.issuerName },
        { label: 'Result', render: (r) => (r.outcome === 'ACCEPTED' ? chip('Accepted, screening skipped', 'ok') : r.outcome === 'NONE' ? chip('No receipt, screened', 'neutral') : chip('Refused, screened', 'bad')) },
        { label: 'List used', render: (r) => r.listVersionId ?? 'n/a' },
        { label: 'Why', render: (r) => reasonChips(r.reasons) },
        { label: 'Receipt', render: (r) => mono((r.presentedReceiptId ?? '').replace('rcpt:', '') || 'none'), cls: 'mono' },
      ],
    }),
    h('div', { class: 'cardbody' }, pagerFor(log.length, page, (p) => { st.logPage = p; ctx.refresh(); })));

  // ---- gate ----------------------------------------------------------------------------------
  const gateReason = roleReason(ws, userId, 'gate_use');
  const presetButtons = GATE_PRESETS.map((p) => guardedButton({
    label: p.label, id: `gt-${p.id}`, reason: gateReason,
    onClick: async () => { const out = await ctx.gate(p.id, { refresh: false }); if (out.ok) st.gate = out; ctx.refresh(); },
  }));
  const gateDays = gateDaily(ws, now);
  const gateChart = createChart({
    id: 'c-gate-daily', integerAxis: true, title: 'Gate decisions per day: released and blocked', kind: 'bars', stacked: true, height: 170,
    series: [{ key: 'released', label: 'Released', cls: 'gpass' }, { key: 'blocked', label: 'Blocked', cls: 'gblock', pattern: true }],
    xFmt: axisDate, tableLabel: 'Day (UTC)', valueFmt: (v) => formatNumber(v ?? 0),
  });
  gateChart.update(gateDays.map((d) => ({ t: d.t, values: { released: d.released, blocked: d.blocked } })));
  const recentGates = [...ws.net.gates].reverse().slice(0, 8);
  const gateCard = card('Payment gate', { id: 'nw-gate', sub: `Valid receipt, list in force, under ${FRESHNESS_MS / 3_600_000} hours old` },
    h('div', { class: 'cardbody' },
      h('div', { class: 'btnrow btnrow--wrap' }, presetButtons),
      gateResultPanel(ctx, st.gate),
      h('div', { class: 'cols' },
        h('div', {}, h('h3', { class: 'subhead', text: 'Blocked, by reason' }),
          h('ul', { class: 'plain' }, Object.entries(gates.byReason).length ? Object.entries(gates.byReason).sort((a, b) => b[1] - a[1]).map(([c, n]) => h('li', {}, `${gateLabel(c)}: ${n}`)) : [h('li', { text: 'Nothing blocked yet.' })])),
        gateChart.el),
      dataTable({
        caption: 'Recent gate decisions', rows: recentGates, rowKey: (g) => g.id, onOpen: (g) => ctx.openReceipt(g.receiptId),
        cols: [
          { label: `Time (${zoneName()})`, render: (g) => stamp(g.ts), open: true },
          { label: 'Transfer', render: (g) => mono(g.transferId), cls: 'mono' },
          { label: 'Decision', render: (g) => (g.release ? chip('Released', 'ok') : chip('Blocked', 'bad')) },
          { label: 'Why', render: (g) => (g.release ? 'Valid, current receipt' : h('span', { class: 'chips' }, g.reasons.map((c) => chip(gateLabel(c), 'bad')))) },
          { label: 'Receipt shown', render: (g) => g.presentedKind === 'none' ? 'none' : g.presentedKind === 'shared' ? 'accepted inbound' : 'own screening' },
        ],
      })));

  root.append(
    kpis, form, gateCard, charts, registry, logCard, intro);
  if (params.focus) document.getElementById(params.focus)?.scrollIntoView({ block: 'start' });
}

function pagerFor(total, page, onChange) {
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE));
  if (pages === 1) return document.createDocumentFragment();
  return h('div', { class: 'pager' }, h('span', { class: 'muted', text: `${page * LOG_PAGE + 1} to ${Math.min(total, (page + 1) * LOG_PAGE)} of ${total}` }),
    h('button', { type: 'button', class: 'btn', disabled: page === 0, on: { click: () => onChange(page - 1) } }, 'Previous'),
    h('button', { type: 'button', class: 'btn', disabled: page >= pages - 1, on: { click: () => onChange(page + 1) } }, 'Next'));
}
