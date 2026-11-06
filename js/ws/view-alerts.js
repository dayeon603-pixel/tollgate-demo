/** Alert queue and case view. Every action here goes through the engine and ends up as a signed receipt. */
import { append, card, clear, copyButton, dataTable, empty, field, h, icon, KIND_LABELS, kv, money, mono, pager, segmented, select, shortAddr, stamp, statusChip } from './dom.js';
import { actorName, ACTION_LABELS } from './describe.js';
import { isFinal, isOpenWork, MAX_NOTE_CHARS, MIN_NOTE_CHARS, STATUSES } from './engine.js';
import { matchIn } from './lists.js';
import { ageLabel } from './metrics.js';
import { applyBulk, caseSummary, DEFAULT_SLA_HOURS, planBulk, slaLabel, slaState } from './triage.js';

const PAGE = 25;
const st = { status: 'work', kind: 'all', assignee: 'any', q: '', sort: 'newest', page: 0, selected: new Set(), message: '', viewName: '' };
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

function applyFilters(ctx) {
  const { ws } = ctx;
  const now = ctx.now().getTime();
  const q = st.q.trim().toLowerCase();
  const list = ws.alerts.filter((a) => {
    if (st.status === 'work' && !isOpenWork(a)) return false;
    if (st.status === 'pending' && !a.pending) return false;
    if (STATUSES.includes(st.status) && a.status !== st.status) return false;
    if (st.kind !== 'all' && a.kind !== st.kind) return false;
    if (st.assignee === 'none' && a.assignee) return false;
    if (st.assignee === 'me' && a.assignee !== ctx.userId) return false;
    if (!['any', 'none', 'me'].includes(st.assignee) && a.assignee !== st.assignee) return false;
    if (q && !`${a.id} ${a.address} ${a.txIds.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const by = {
    newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    oldest: (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    amount: (a, b) => b.amountUsd - a.amountUsd,
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    sla: (a, b) => slaState(a, now, ctx.sla).remainingH - slaState(b, now, ctx.sla).remainingH,
  }[st.sort];
  return list.sort(by);
}

export function renderAlerts(ctx, root) {
  const { ws } = ctx;
  Object.assign(st, ctx.takeParams('alerts'));
  clear(root);
  const count = (fn) => ws.alerts.filter(fn).length;
  const rows = applyFilters(ctx);
  if (st.page * PAGE >= rows.length) st.page = 0;
  const pageRows = rows.slice(st.page * PAGE, (st.page + 1) * PAGE);

  const statusFilter = segmented({
    label: 'Status', value: st.status,
    options: [
      { value: 'work', label: 'Open work', count: count(isOpenWork) },
      { value: 'pending', label: 'Awaiting approval', count: count((a) => a.pending) },
      { value: 'escalated', label: 'Escalated', count: count((a) => a.status === 'escalated') },
      { value: 'cleared', label: 'Cleared', count: count((a) => a.status === 'cleared') },
      { value: 'confirmed', label: 'Confirmed', count: count((a) => a.status === 'confirmed') },
      { value: 'all', label: 'All', count: ws.alerts.length },
    ],
    onChange: (v) => { st.status = v; st.page = 0; ctx.refresh(); },
  });
  const search = h('input', { id: 'al-q', class: 'input', type: 'search', 'data-search': '', autocomplete: 'off', placeholder: 'Alert, address or transaction', value: st.q });
  search.addEventListener('input', () => { st.q = search.value; st.page = 0; drawTable(); });
  const kindSel = select('al-kind', [{ value: 'all', label: 'All kinds' }, ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))], st.kind, (v) => { st.kind = v; st.page = 0; ctx.refresh(); });
  const ownerSel = select('al-owner', [{ value: 'any', label: 'Anyone' }, { value: 'me', label: 'Assigned to me' }, { value: 'none', label: 'Unassigned' }, ...ws.users.map((u) => ({ value: u.id, label: u.name }))], st.assignee, (v) => { st.assignee = v; st.page = 0; ctx.refresh(); });
  const sortSel = select('al-sort', [{ value: 'newest', label: 'Newest first' }, { value: 'oldest', label: 'Oldest first' }, { value: 'priority', label: 'Priority' }, { value: 'sla', label: 'Most overdue first' }, { value: 'amount', label: 'Amount' }], st.sort, (v) => { st.sort = v; ctx.refresh(); });

  const tableHost = h('div', { id: 'al-table' });
  const drawTable = () => {
    const all = applyFilters(ctx);
    const shown = all.slice(st.page * PAGE, (st.page + 1) * PAGE);
    clear(tableHost);
    tableHost.append(dataTable({
      caption: 'Alerts', rows: shown, rowKey: (a) => a.id, onOpen: (a) => ctx.openAlert(a.id),
      empty: empty('No alerts match these filters.', ws.alerts.length ? 'Clear a filter to see more.' : 'Screen an address to create one.'),
      cols: [
        { label: 'Select', cls: 'col-select', render: (a) => h('input', { type: 'checkbox', class: 'selbox', 'aria-label': `Select ${a.id}`, 'data-sel': a.id, checked: st.selected.has(a.id), on: { change: (e) => { toggleSel(a.id, e.target.checked); } } }) },
        { label: 'Alert', open: true, render: (a) => a.id },
        { label: 'Age', render: (a) => ageLabel(a.createdAt, ctx.now()) },
        { label: 'SLA', render: (a) => { const s = slaState(a, ctx.now().getTime(), ctx.sla); return h('span', { class: `sla sla--${s.state}`, 'data-sla': s.state }, s.state === 'closed' ? 'closed' : slaLabel(s)); } },
        { label: 'Kind', render: (a) => KIND_LABELS[a.kind] },
        { label: 'Address', cls: 'col-addr', render: (a) => h('span', { class: 'mono', title: a.address, text: shortAddr(a.address) }) },
        { label: 'Amount', num: true, render: (a) => (a.txIds.length ? money(a.amountUsd) : '') },
        { label: 'Status', render: (a) => statusChip(a) },
        { label: 'Owner', render: (a) => (a.assignee ? actorName(ws, a.assignee) : h('span', { class: 'muted', text: 'Unassigned' })) },
        { label: 'Priority', render: (a) => a.priority },
      ],
    }), pager({ page: st.page, size: PAGE, total: all.length, onChange: (p) => { st.page = p; drawTable(); } }));
    tableHost.querySelectorAll('tr[data-key]').forEach((tr) => {
      const alert = ws.alertById.get(tr.dataset.key);
      tr.dataset.sla = slaState(alert, ctx.now().getTime(), ctx.sla).state;
      if (st.selected.has(alert.id)) tr.dataset.selected = 'true';
    });
    foot.textContent = `${all.length} alert${all.length === 1 ? '' : 's'} match. Keys: j and k move between rows, x selects, a assigns to you, e escalates, c proposes clearance, Enter opens.`;
    drawBulk();
  };
  function toggleSel(id, on) {
    if (on) st.selected.add(id); else st.selected.delete(id);
    const tr = tableHost.querySelector(`tr[data-key="${id}"]`);
    if (tr) { if (on) tr.dataset.selected = 'true'; else delete tr.dataset.selected; const box = tr.querySelector('.selbox'); if (box) box.checked = on; }
    drawBulk();
  }
  const bulkHost = h('div', { id: 'al-bulk', class: 'bulk', role: 'region', 'aria-label': 'Bulk actions' });
  const runBulk = async (action, extra = {}) => {
    const ids = Array.from(st.selected);
    const result = await applyBulk(ws, (op) => ctx.run(op, { quiet: true, refresh: false }), { actor: ctx.userId, action, alertIds: ids, ...extra });
    result.done.forEach((id) => st.selected.delete(id));
    const reasons = Array.from(new Set(result.blocked.map((b) => b.reason))).slice(0, 2).join(' ');
    st.message = `${result.done.length} done${result.blocked.length ? `, ${result.blocked.length} not applied. ${reasons}` : ''}.`;
    ctx.refresh();
  };
  function drawBulk() {
    clear(bulkHost);
    if (!st.selected.size && !st.message) { bulkHost.hidden = true; return; }
    bulkHost.hidden = false;
    const ids = Array.from(st.selected);
    const assignee = select('al-bulk-assignee', ws.users.map((u) => ({ value: u.id, label: u.name })), ctx.userId);
    const note = h('input', { id: 'al-bulk-note', class: 'input', type: 'text', maxlength: MAX_NOTE_CHARS, placeholder: `Note for clearance, at least ${MIN_NOTE_CHARS} characters`, 'aria-label': 'Note for proposed clearance' });
    const can = (action) => planBulk(ws, ctx.userId, ids, action).allowed.length > 0;
    const btn = (id, label, action, fn) => h('button', { type: 'button', class: 'btn', id, disabled: !ids.length || !can(action), on: { click: fn } }, label);
    bulkHost.append(
      h('span', { class: 'bulk__count', id: 'al-bulk-count', text: `${ids.length} selected` }),
      h('label', { class: 'sr', for: 'al-bulk-assignee', text: 'Assign selected to' }), assignee,
      btn('al-bulk-assign', 'Assign', 'assign', () => runBulk('assign', { assignee: assignee.value })),
      btn('al-bulk-review', 'Start review', 'start_review', () => runBulk('start_review')),
      note, btn('al-bulk-clear', 'Propose clearance', 'propose_clear', () => runBulk('propose_clear', { note: note.value })),
      h('button', { type: 'button', class: 'linkbtn', on: { click: () => { st.selected.clear(); st.message = ''; drawTable(); } } }, 'Clear selection'),
      h('p', { class: 'bulk__msg field__hint', id: 'al-bulk-msg', role: 'status', text: st.message || 'Each row signs its own receipt. Clearing still needs a second person to approve every alert.' }));
  }
  const foot = h('div', { class: 'card__foot' });
  tableHost.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const tr = document.activeElement?.closest?.('tr[data-key]');
    if (!tr || !tableHost.contains(tr)) return;
    const id = tr.dataset.key;
    if (event.key === 'x') { event.preventDefault(); toggleSel(id, !st.selected.has(id)); }
    else if (event.key === 'a') { event.preventDefault(); if (!st.selected.size) st.selected.add(id); void runBulk('assign', { assignee: ctx.userId }); }
    else if (event.key === 'e') { event.preventDefault(); ctx.openAlert(id, { action: 'escalate' }); }
    else if (event.key === 'c') { event.preventDefault(); ctx.openAlert(id, { action: 'propose_clear' }); }
  });
  // Saved views
  const viewSel = select('al-views', [{ value: '', label: 'Saved views' }, ...ctx.views.map((v) => ({ value: v.name, label: v.name }))], st.viewName, (name) => {
    const view = ctx.views.find((v) => v.name === name);
    st.viewName = name;
    if (view) { Object.assign(st, view.filters, { page: 0 }); ctx.refresh(); }
  });
  const viewName = h('input', { id: 'al-view-name', class: 'input', type: 'text', maxlength: 40, placeholder: 'Name this view', 'aria-label': 'Name for the saved view' });
  const saveView = h('button', { type: 'button', class: 'btn', id: 'al-view-save', on: { click: () => {
    const name = viewName.value.trim();
    if (!name) { viewName.focus(); return; }
    ctx.saveView({ name, filters: { status: st.status, kind: st.kind, assignee: st.assignee, q: st.q, sort: st.sort } });
    st.viewName = name;
    ctx.refresh();
  } } }, 'Save view');
  const delView = h('button', { type: 'button', class: 'linkbtn', disabled: !st.viewName, on: { click: () => { ctx.deleteView(st.viewName); st.viewName = ''; ctx.refresh(); } } }, 'Delete view');
  // SLA targets
  const slaBox = h('details', { class: 'slabox' }, h('summary', { text: 'SLA targets' }),
    h('p', { class: 'field__hint', text: 'Hours from the alert opening to a decision. Alerts past the target are marked overdue. These are your demo settings, kept in this browser.' }),
    h('div', { class: 'slagrid' }, Object.keys(DEFAULT_SLA_HOURS).map((kind) => {
      const input = h('input', { id: `sla-${kind}`, class: 'input', type: 'number', min: 0.25, max: 720, step: 'any', value: ctx.sla[kind] });
      input.addEventListener('change', () => { ctx.setSla({ ...ctx.sla, [kind]: Number(input.value) }); ctx.refresh(); });
      return field(`${KIND_LABELS[kind] ?? kind} (hours)`, input);
    })));
  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'Demo alerts. ' }), 'Alerts come from synthetic payments and from the real list. You are acting as ', h('strong', { text: `${actorName(ws, ctx.userId)} (${ws.user(ctx.userId).role})` }), '. Change the user at the top to try approvals.'),
    card('Alert queue', { id: 'al-title', actions: statusFilter },
      h('div', { class: 'filters' }, field('Search', search), field('Kind', kindSel), field('Owner', ownerSel), field('Sort', sortSel)),
      h('div', { class: 'viewsbar' }, h('label', { class: 'sr', for: 'al-views', text: 'Saved views' }), viewSel, viewName, saveView, delView),
      bulkHost, tableHost, foot),
    slaBox,
  );
  void pageRows;
  drawTable();
}

// ---- case view -----------------------------------------------------------------------------

function why(text) {
  return h('p', { class: 'why', text });
}

/** Builds the case view body for the drawer. */
export function caseView(ctx, alertId) {
  const { ws } = ctx;
  const alert = ws.alertById.get(alertId);
  if (!alert) return empty('That alert no longer exists.');
  const user = ws.user(ctx.userId);
  const can = ws.availableActions(ctx.userId, alert);
  const inForce = ws.inForce;
  const onList = matchIn(inForce, alert.address).length > 0;
  const body = h('div', { class: 'case' });

  body.append(kv([
    ['Status', statusChip(alert)],
    ['Kind', KIND_LABELS[alert.kind] + (alert.rule ? ` (${alert.rule.replace('_', ' ')})` : '')],
    ['Priority', alert.priority],
    ['Owner', alert.assignee ? actorName(ws, alert.assignee) : 'Unassigned'],
    ['Opened', `${stamp(alert.createdAt)} UTC`],
    ['SLA', (() => { const sl = slaState(alert, ctx.now().getTime(), ctx.sla); return h('span', { class: `sla sla--${sl.state}`, 'data-sla': sl.state }, sl.state === 'closed' ? `closed (target ${sl.targetH}h)` : `${slaLabel(sl)} (target ${sl.targetH}h)`); })()],
    ['Address', h('span', { class: 'field__text' }, mono(alert.address), copyButton(alert.address, 'address'))],
    alert.txIds.length ? ['Amount', money(alert.amountUsd) + (alert.txIds.length > 1 ? ` across ${alert.txIds.length} payments` : '')] : null,
    ['List when raised', ws.version(alert.versionId).label],
  ]));

  if (alert.kind !== 'hold') {
    body.append(h('p', { class: `callout ${onList ? '' : 'callout--warn'}`, role: 'note' }, onList ? `This address is on ${inForce.label}, the list in force now.` : `This address is not on ${inForce.label}, the list in force now. The entry may have been removed. Review before you confirm.`));
  }

  if (alert.entries.length) {
    body.append(h('h3', { text: 'Matched list entries' }), dataTable({
      caption: 'Matched list entries', rows: alert.entries, rowKey: (e) => e.uid + e.chain,
      cols: [{ label: 'Name', render: (e) => e.name }, { label: 'Chain', render: (e) => e.chain }, { label: 'List UID', render: (e) => e.uid }],
    }), h('p', { class: 'field__hint', text: 'Exact address match only. Tollgate does not match names.' }));
  }

  if (alert.txIds.length) {
    body.append(h('h3', { text: 'Payments' }), dataTable({
      caption: 'Payments', rows: alert.txIds.map((id) => ws.txById.get(id)), rowKey: (t) => t.id,
      cols: [
        { label: 'Payment', render: (t) => t.id }, { label: 'Time (UTC)', render: (t) => stamp(t.ts) },
        { label: 'Amount', num: true, render: (t) => money(t.amountUsd) },
        { label: 'Screened as', render: (t) => `${t.outcome === 'BLOCK' ? 'Hit' : t.outcome === 'HOLD' ? 'Hold' : 'Allow'} on ${t.versionId}` },
        { label: 'Receipt', render: (t) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(t.receiptId) } }, t.receiptId.replace('rcpt:', '')) },
      ],
    }));
  }

  // Actions
  const note = h('textarea', { id: 'case-note', class: 'input note', rows: 3, maxlength: MAX_NOTE_CHARS, 'aria-describedby': 'case-note-hint', placeholder: 'What did you check, and what did you decide?' });
  const assignee = select('case-assignee', [{ value: '', label: 'Unassigned' }, ...ws.users.map((u) => ({ value: u.id, label: u.name }))], alert.assignee ?? '');
  const act = async (action, extra = {}) => {
    const result = await ctx.run({ op: 'alertAction', actor: ctx.userId, alertId, action, note: note.value, ...extra });
    if (result.ok) ctx.toast(`${ACTION_LABELS[result.result.alert.timeline.at(-1).action] ?? action}. Receipt ${result.result.receipt.receipt_id.replace('rcpt:', '')} signed.`);
  };
  const button = (action, label, { primary = false } = {}) => h('button', {
    id: `case-${action}`, type: 'button', class: `btn${primary ? ' btn--primary' : ''}`, disabled: Boolean(can[action]), title: can[action] ?? '', on: { click: () => act(action) },
  }, label);

  const fourEyes = ws.requiresFourEyes(alert);
  const actions = h('div', { class: 'actions' }, h('h3', { text: 'Actions' }),
    h('p', { class: 'field__hint', text: `Acting as ${user.name} (${user.role}).` }),
    h('div', { class: 'fieldbox' }, h('label', { for: 'case-note', text: 'Note' }), note,
      h('button', { type: 'button', class: 'linkbtn', id: 'case-draft', on: { click: () => { note.value = [note.value.trim(), ...caseSummary(ws, alert)].filter(Boolean).join('\n').slice(0, MAX_NOTE_CHARS); note.focus(); } } }, 'Insert draft summary from the receipts'),
      h('p', { id: 'case-note-hint', class: 'field__hint', text: `Required for escalate, propose or reject clearance, confirm and reopen (at least ${MIN_NOTE_CHARS} characters). It is signed into the receipt.` })));
  if (!isFinal(alert)) {
    actions.append(h('div', { class: 'btnrow' }, button('start_review', 'Start review', { primary: alert.status === 'open' }), button('escalate', 'Escalate'), button('confirm', alert.kind === 'hold' ? 'Uphold hold' : 'Confirm hit'), button('propose_clear', fourEyes ? 'Propose clearance' : 'Clear')),
      h('div', { class: 'btnrow' }, h('div', { class: 'inline' }, h('label', { for: 'case-assignee', class: 'sr', text: 'Assign to' }), assignee, h('button', { type: 'button', class: 'btn', disabled: Boolean(can.assign), on: { click: () => act('assign', { assignee: assignee.value || null }) } }, 'Assign'))),
      h('button', { type: 'button', class: 'linkbtn', disabled: Boolean(can.note), on: { click: () => act('note') } }, 'Add the note without changing status'));
    if (fourEyes) actions.append(why('Four-eyes: clearing needs a second person. You propose, a different approver or admin approves.'));
    if (alert.pending) {
      actions.append(h('div', { class: 'pending', role: 'group', 'aria-label': 'Clearance awaiting approval' },
        h('p', {}, h('strong', { text: `${actorName(ws, alert.pending.by)} proposed clearing this alert` }), ` on ${stamp(alert.pending.at)} UTC.`),
        h('p', { class: 'pending__note', text: `"${alert.pending.note}"` }),
        h('div', { class: 'btnrow' }, button('approve_clear', 'Approve clearance', { primary: true }), button('reject_clear', 'Reject')),
        can.approve_clear ? why(can.approve_clear) : null));
    }
  } else {
    actions.append(h('div', { class: 'btnrow' }, button('reopen', 'Reopen'), h('button', { type: 'button', class: 'linkbtn', disabled: Boolean(can.note), on: { click: () => act('note') } }, 'Add the note')),
      can.reopen ? why(can.reopen) : null);
  }
  body.append(actions);
  const intent = ctx.intent?.id === alertId ? ctx.intent : null;
  ctx.intent = null;
  if (intent) {
    note.value = caseSummary(ws, alert).join('\n').slice(0, MAX_NOTE_CHARS);
    setTimeout(() => { const target = document.getElementById(`case-${intent.action}`); (target && !target.disabled ? target : note).focus(); }, 0);
  }

  // Timeline
  body.append(h('h3', { text: 'Timeline' }), h('ol', { class: 'timeline' }, alert.timeline.map((t) => h('li', { class: 'timeline__item' },
    h('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
    h('div', {}, h('p', { class: 'timeline__head' }, h('strong', { text: ACTION_LABELS[t.action] ?? t.action }), ` by ${actorName(ws, t.actor)}`, t.from && t.from !== t.to ? ` (${t.from.replace('_', ' ')} to ${t.to.replace('_', ' ')})` : ''),
      t.assignee !== undefined ? h('p', { class: 'timeline__note', text: `Owner: ${t.assignee ? actorName(ws, t.assignee) : 'none'}` }) : null,
      t.note ? h('p', { class: 'timeline__note', text: t.note }) : null,
      h('p', { class: 'timeline__meta' }, `${stamp(t.ts)} UTC · `, h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(t.receiptId) } }, `receipt ${t.receiptId.replace('rcpt:', '')}`)))))));

  body.append(h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', id: 'case-evidence', on: { click: () => ctx.go('evidence', { case: alert.id, auto: true }) } }, icon('file'), 'Evidence for this case')));
  void append;
  return body;
}
