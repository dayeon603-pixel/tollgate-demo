/** Lists (versions, update with lookback preview, diff) and Monitoring (watchlist). */
import { card, clear, copyButton, dataTable, empty, field, h, icon, kv, mono, money, select, shortAddr, stamp, statusChip } from './dom.js';
import { zoneName } from './dom.js';
import { diffVersions } from './lists.js';
import { actorName } from './describe.js';
import { MAX_LABEL_CHARS } from './engine.js';
import { SYNTHETIC_NAME } from './lists.js';

const diffState = { from: null, to: null, q: '' };

function entryRows(items) {
  return items.flatMap((item) => item.entries.map((entry) => ({ address: item.address, entry })));
}

function diffTable(items, caption) {
  return dataTable({
    caption, rows: entryRows(items), rowKey: (r) => r.address + r.entry.uid,
    empty: empty('None.'),
    cols: [
      { label: 'Address', render: (r) => mono(r.address) },
      { label: 'Chain', render: (r) => r.entry.chain },
      { label: 'Name on the list', cls: 'wrap', render: (r) => (r.entry.synthetic ? `${r.entry.name}` : r.entry.name) },
      { label: 'List UID', render: (r) => r.entry.uid },
    ],
  });
}

export function renderLists(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const now = ws.inForce;
  const pending = ws.pendingVersion;
  const meta = ws.list;
    // Versions table
  const hist = (v) => ws.listHistory.find((e) => e.versionId === v.id);
  root.append(card('List versions', { id: 'ls-versions', sub: 'v3 is the bundled OFAC snapshot. v1 and v2 are demo reconstructions.' }, dataTable({
    caption: 'List versions', rows: ws.versions, rowKey: (v) => v.id,
    cols: [
      { label: 'Version', render: (v) => h('strong', { text: v.label }) },
      { label: 'State', render: (v) => (v.id === now.id ? h('span', { class: 'chip chip--good', text: 'In force' }) : hist(v) ? h('span', { class: 'chip chip--neutral', text: 'Superseded' }) : h('span', { class: 'chip chip--warn', text: 'Update available' })) },
      { label: 'Addresses', num: true, render: (v) => v.addressCount },
      { label: 'Digest (SHA-256)', render: (v) => mono(`${v.digest.slice(0, 16)}…`) },
      { label: 'Published', render: (v) => (v.real ? v.publishDate : 'demo') },
      { label: `In force from (${zoneName()})`, render: (v) => (hist(v) ? stamp(hist(v).from) : '') },
      { label: 'Source', cls: 'wrap', render: (v) => (v.real ? 'Bundled OFAC snapshot' : 'Demo reconstruction') },
    ],
  })));

  // Update panel
  const updateBody = h('div', { class: 'cardbody' });
  if (pending) {
    const plan = ws.planUpdate(pending);
    const watchChanges = plan.watchHits.length;
    updateBody.append(
      h('p', {}, h('strong', { text: `${pending.label} is available. ` }), pending.real ? `It is the OFAC snapshot published ${pending.publishDate}.` : 'It is a demo version.'),
      kv([
        ['Entries added', `${plan.diff.added.length}`], ['Entries removed', `${plan.diff.removed.length}`],
        ['Previously screened addresses that would become hits', `${plan.newHits.length}${plan.newHits.length ? ` (${plan.newHits.reduce((s, x) => s + x.txs.length, 0)} payments, ${money(plan.newHits.reduce((s, x) => s + x.txs.reduce((a, t) => a + (t.amountUsd ?? 0), 0), 0))})` : ''}`],
        ['Watchlist entries that would hit', String(watchChanges)],
        ['Open alerts whose entry would be removed', String(plan.removedWithOpenAlerts.length)],
      ]),
      plan.newHits.length ? dataTable({
        caption: 'Lookback preview', rows: plan.newHits, rowKey: (x) => x.address,
        cols: [
          { label: 'Address', render: (x) => mono(shortAddr(x.address)) },
          { label: 'Earlier payments', num: true, render: (x) => x.txs.length },
          { label: 'Amount', num: true, render: (x) => money(x.txs.reduce((a, t) => a + (t.amountUsd ?? 0), 0)) },
          { label: `First screened (${zoneName()})`, render: (x) => stamp(x.txs[0].ts) },
          { label: 'Name on the list', cls: 'wrap', render: (x) => x.entries[0].name },
        ],
      }) : null,
      h('div', { class: 'btnrow' }, h('button', {
        type: 'button', class: 'btn btn--primary', disabled: !ws.can(ctx.userId, 'list_update'),
        title: ws.can(ctx.userId, 'list_update') ? '' : 'Only an admin can apply a list update. Change the user at the top.',
        on: { click: async () => {
          const r = await ctx.run({ op: 'listUpdate', actor: ctx.userId, toVersionId: pending.id });
          if (r.ok) ctx.toast(`${pending.label} applied. ${r.result.record.newHits.length} lookback hits, ${r.result.record.watchHits.length} watchlist hits. Receipts signed.`);
        } },
      }, 'Apply update and re-screen'), h('p', { class: 'field__hint', text: 'Applying records a list_update receipt, opens a new ledger segment for the new version, re-screens earlier payments and the watchlist, and raises alerts for new hits. Nothing is blocked retroactively; your system acts on the alerts.' })),
    );
  } else {
    updateBody.append(h('p', { text: 'The newest bundled version is in force. There is nothing to apply.' }));
  }
  root.append(card('List update and lookback', { id: 'ls-update' }, updateBody));

  // Lookback history
  if (ws.lookbacks.length) {
    root.append(card('Lookback history', { id: 'ls-lookbacks' }, dataTable({
      caption: 'Lookback history', rows: [...ws.lookbacks].reverse(), rowKey: (l) => l.id,
      cols: [
        { label: 'Run', render: (l) => l.id }, { label: `Time (${zoneName()})`, render: (l) => stamp(l.ts) },
        { label: 'Update', render: (l) => `${l.fromId ?? 'none'} to ${l.toId}` },
        { label: 'Added', num: true, render: (l) => l.added.length }, { label: 'Removed', num: true, render: (l) => l.removed.length },
        { label: 'Earlier payments screened', num: true, render: (l) => l.screenedCount },
        { label: 'New hits', num: true, render: (l) => l.newHits.length },
        { label: 'Alerts', render: (l) => [...l.newHits, ...l.watchHits].map((x) => x.alertId).map((id) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openAlert(id) } }, id)).reduce((acc, node) => (acc.length ? [...acc, ' ', node] : [node]), []) },
        { label: 'Receipt', render: (l) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(l.receiptId) } }, l.receiptId.replace('rcpt:', '')) },
      ],
    })));
  }

  // Diff
  diffState.from ??= ws.versions[0].id;
  diffState.to ??= ws.versions.at(-1).id;
  const options = ws.versions.map((v) => ({ value: v.id, label: `${v.label}${v.real ? ' (OFAC snapshot)' : ' (demo)'}` }));
  const diffHost = h('div', { id: 'ls-diff-body' });
  const draw = () => {
    clear(diffHost);
    const from = ws.version(diffState.from);
    const to = ws.version(diffState.to);
    const diff = diffVersions(from, to);
    const q = diffState.q.trim().toLowerCase();
    const keep = (items) => (q ? items.filter((i) => i.address.toLowerCase().includes(q) || i.entries.some((e) => e.name.toLowerCase().includes(q))) : items);
    const added = keep(diff.added);
    const removed = keep(diff.removed);
    diffHost.append(
      h('p', { class: 'diffsum', role: 'status' }, h('strong', { text: `${diff.added.length} added` }), ', ', h('strong', { text: `${diff.removed.length} removed` }), ` going from ${from.label} to ${to.label}.`, from.id === to.id ? ' Pick two different versions.' : '', diff.removed.some((r) => r.entries[0].synthetic) || diff.added.some((r) => r.entries[0].synthetic) ? ` Entries named "${SYNTHETIC_NAME.split(' (')[0]}" are synthetic.` : ''),
      h('h3', { text: `Added (${added.length})` }), diffTable(added, 'Added entries'),
      h('h3', { text: `Removed (${removed.length})` }), diffTable(removed, 'Removed entries'));
  };
  const fromSel = select('ls-from', options, diffState.from, (v) => { diffState.from = v; draw(); });
  const toSel = select('ls-to', options, diffState.to, (v) => { diffState.to = v; draw(); });
  const q = h('input', { id: 'ls-q', class: 'input', type: 'search', 'data-search': '', placeholder: 'Address or name', value: diffState.q, autocomplete: 'off' });
  q.addEventListener('input', () => { diffState.q = q.value; draw(); });
  root.append(card('Compare versions', { id: 'ls-diff' }, h('div', { class: 'cardbody' }, h('div', { class: 'filters' }, field('From', fromSel), field('To', toSel), field('Filter', q)), diffHost)));
  draw();

  // Provenance
  const full = ws.versions.at(-1);
  root.append(card('Provenance of the bundled snapshot', { id: 'ls-prov' }, h('div', { class: 'cardbody' }, kv([
    ['Source', ctx.listMeta.source], ['Publish date', ctx.listMeta.publish_date], ['Fetched', ctx.listMeta.fetched_at],
    ['Raw SDN.XML SHA-256', h('span', { class: 'field__text' }, mono(ctx.listMeta.raw_sha256), copyButton(ctx.listMeta.raw_sha256, 'raw digest'))],
    ['List digest', h('span', { class: 'field__text' }, mono(full.digest), copyButton(full.digest, 'list digest'))],
    ['Addresses', `${ctx.listMeta.address_count} (from ${ctx.listMeta.record_count} SDN records)`],
  ]))));
  void icon;
}

// ---- monitoring ------------------------------------------------------------------------------

export function renderMonitoring(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const can = ws.can(ctx.userId, 'watch');
  const address = h('input', { id: 'wl-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: '0x... or any address', 'aria-describedby': 'wl-error' });
  const label = h('input', { id: 'wl-label', class: 'input', type: 'text', maxlength: MAX_LABEL_CHARS, autocomplete: 'off', placeholder: 'Your name for this counterparty' });
  const error = h('p', { id: 'wl-error', class: 'field__hint field__hint--bad', role: 'alert' });
  const form = h('form', { class: 'screen', novalidate: true }, h('div', { class: 'screen__fields' },
    h('div', { class: 'fieldbox fieldbox--grow' }, h('label', { for: 'wl-address', text: 'Address' }), address), field('Label', label),
    h('button', { type: 'submit', class: 'btn btn--primary btn--tall', disabled: !can }, 'Add and screen')), error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const r = await ctx.run({ op: 'watchAdd', actor: ctx.userId, address: address.value, label: label.value }, { quiet: true });
    if (!r.ok) error.textContent = r.error.message;
    else ctx.toast(r.result.created.length ? 'Added. It matches the list, so an alert was raised.' : 'Added. Not on the list now; it is re-screened on every update.');
  });
  root.append(
    card('Add a counterparty', { id: 'wl-add' }, h('div', { class: 'cardbody' }, form)),
    card('Watchlist', { id: 'wl-list', sub: `${ws.watch.length} entries, checked against ${ws.inForce.label}` }, dataTable({
      caption: 'Watchlist', rows: ws.watch, rowKey: (w) => w.address,
      empty: empty('No counterparties are being monitored.', 'Add one above.'),
      cols: [
        { label: 'Label', render: (w) => w.label }, { label: 'Address', render: (w) => h('span', { class: 'mono', title: w.address, text: shortAddr(w.address) }) },
        { label: 'Status', render: (w) => h('span', { class: `chip ${w.status === 'hit' ? 'chip--bad' : 'chip--good'}`, text: w.status === 'hit' ? 'Hit on the list' : 'Clear' }) },
        { label: `Last checked (${zoneName()})`, render: (w) => `${stamp(w.checkedAt)} on ${w.versionId}` },
        { label: 'Added by', render: (w) => actorName(ws, w.addedBy) },
        { label: 'Receipt', render: (w) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(w.lastReceiptId) } }, w.lastReceiptId.replace('rcpt:', '')) },
        { label: '', render: (w) => h('button', { type: 'button', class: 'btn', disabled: !can, 'aria-label': `Remove ${w.label}`, on: { click: () => ctx.run({ op: 'watchRemove', actor: ctx.userId, address: w.address }) } }, 'Remove') },
      ],
    })));
  void statusChip;
}
