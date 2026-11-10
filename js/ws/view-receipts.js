/** Receipt explorer (search, filter, detail with the real verifier) and the activity log. */
import { card, clear, copyButton, dataTable, empty, field, h, icon, kv, mono, outcomeTag, pager, select, shortAddr, shortHash, stamp } from './dom.js';
import { pageSize } from './settings.js';
import { zoneName } from './dom.js';
import { actorName, describe, TYPE_GROUPS, TYPE_LABELS } from './describe.js';
import { dayKey } from './util.js';

const PAGE_DEFAULT = 40;
const pageLen = () => pageSize(PAGE_DEFAULT);
const st = { q: '', type: 'all', decision: 'all', version: 'all', from: '', to: '', page: 0 };
const activity = { group: 'all', actor: 'all', page: 0 };
const CHECK_LABELS = { signature: 'Signature matches the signed decision', signer: 'Signer is the demo key', binding: 'Details match the signed fingerprint', labels: 'Labels match the signed decision', hash: 'Own hash matches contents', chain: 'Links to the receipt before' };
let haystack = { size: -1, rows: [] };

function index(ws) {
  if (haystack.size !== ws.ledger.size) {
    haystack = {
      size: ws.ledger.size,
      rows: ws.ledger.entries.map((e) => {
        const p = e.receipt.action.params;
        return `${e.receipt.receipt_id} ${p.beneficiary_address ?? ''} ${p.tx_hash ?? ''} ${p.payment_id ?? ''} ${p.alert_id ?? ''} ${(p.tx_ids ?? []).join(' ')} ${p.actor ?? ''} ${p.label ?? ''} ${p.setting ?? ''}`.toLowerCase();
      }),
    };
  }
  return haystack.rows;
}

function filtered(ws) {
  const hay = index(ws);
  const q = st.q.trim().toLowerCase();
  const out = [];
  ws.ledger.entries.forEach((e, i) => {
    const day = dayKey(e.receipt.action.requested_at);
    if (q && !hay[i].includes(q)) return;
    if (st.type !== 'all' && e.receipt.action.type !== st.type) return;
    if (st.decision !== 'all' && e.receipt.verdict.decision !== st.decision) return;
    if (st.version !== 'all' && e.versionId !== st.version) return;
    if (st.from && day < st.from) return;
    if (st.to && day > st.to) return;
    out.push(e);
  });
  return out.reverse();
}

export function renderExplorer(ctx, root) {
  const { ws } = ctx;
  Object.assign(st, ctx.takeParams('explorer'));
  clear(root);
  const q = h('input', { id: 'ex-q', class: 'input mono', type: 'search', 'data-search': '', autocomplete: 'off', spellcheck: 'false', placeholder: 'Address, tx hash, receipt, alert', value: st.q });
  const types = select('ex-type', [{ value: 'all', label: 'All types' }, ...Object.entries(TYPE_LABELS).map(([value, label]) => ({ value, label }))], st.type, (v) => { st.type = v; st.page = 0; draw(); });
  const decisions = select('ex-dec', [{ value: 'all', label: 'Any decision' }, ...['ALLOW', 'DENY', 'HOLD', 'REVIEW', 'RECORD'].map((value) => ({ value, label: value }))], st.decision, (v) => { st.decision = v; st.page = 0; draw(); });
  const versions = select('ex-ver', [{ value: 'all', label: 'Any list version' }, ...ws.versions.map((v) => ({ value: v.id, label: v.label }))], st.version, (v) => { st.version = v; st.page = 0; draw(); });
  const from = h('input', { id: 'ex-from', class: 'input', type: 'date', value: st.from });
  const to = h('input', { id: 'ex-to', class: 'input', type: 'date', value: st.to });
  q.addEventListener('input', () => { st.q = q.value; st.page = 0; draw(); });
  from.addEventListener('change', () => { st.from = from.value; st.page = 0; draw(); });
  to.addEventListener('change', () => { st.to = to.value; st.page = 0; draw(); });
  const host = h('div', {});
  const foot = h('div', { class: 'card__foot' });
  const draw = () => {
    const rows = filtered(ws);
    if (st.page * pageLen() >= rows.length) st.page = 0;
    clear(host);
    host.append(dataTable({
      caption: 'Receipts', rows: rows.slice(st.page * pageLen(), (st.page + 1) * pageLen()), rowKey: (e) => e.receipt.receipt_id, onOpen: (e) => ctx.openReceipt(e.receipt.receipt_id),
      empty: empty('No receipts match.', 'Try a shorter search or clear a filter.'),
      cols: [
        { label: 'Receipt', open: true, render: (e) => e.receipt.receipt_id.replace('rcpt:', '') },
        { label: `Time (${zoneName()})`, render: (e) => stamp(e.receipt.action.requested_at) },
        { label: 'Type', render: (e) => TYPE_LABELS[e.receipt.action.type] ?? e.receipt.action.type },
        { label: 'Subject', cls: 'col-addr', render: (e) => { const p = e.receipt.action.params; return p.beneficiary_address ? h('span', { class: 'mono', title: p.beneficiary_address, text: shortAddr(p.beneficiary_address) }) : (p.alert_id ?? p.setting ?? p.segment_id ?? ''); } },
        { label: 'Decision', render: (e) => (['ALLOW', 'DENY', 'HOLD'].includes(e.receipt.verdict.decision) ? outcomeTag({ ALLOW: 'ALLOW', DENY: 'BLOCK', HOLD: 'HOLD' }[e.receipt.verdict.decision]) : h('span', { class: 'decision decision--other', text: e.receipt.verdict.decision })) },
        { label: 'List', render: (e) => e.versionId },
        { label: 'Segment', render: (e) => `${ws.ledger.segments[e.segment].id} #${e.receipt.seq}` },
      ],
    }), pager({ page: st.page, size: pageLen(), total: rows.length, onChange: (p) => { st.page = p; draw(); } }));
    foot.textContent = `${rows.length} of ${ws.ledger.size} receipts match.`;
  };
  const verifyHost = h('div', { role: 'status', 'aria-live': 'polite' });
  const verifyAll = h('button', { type: 'button', class: 'btn btn--primary', on: { click: async () => {
    verifyAll.disabled = true;
    verifyAll.textContent = 'Verifying';
    const result = await ctx.measure.time('ledger_verify', 'Whole ledger verified', () => ws.ledger.verifyAll(), (r) => ({ receipts: ws.ledger.size, segments: r.segments.length }));
    verifyAll.disabled = false;
    verifyAll.textContent = 'Verify the whole ledger';
    clear(verifyHost);
    verifyHost.append(h('div', { class: 'banner', 'data-state': result.ok ? 'pass' : 'fail' },
      h('span', { class: 'banner__lead' }, icon(result.ok ? 'shield' : 'back'), result.ok ? 'Every segment verified' : 'A segment failed'),
      h('span', { class: 'banner__detail', text: `${ws.ledger.size} receipts in ${result.segments.length} segments, ${result.links.filter((l) => l.ok).length} of ${result.links.length} segment links intact. Checked in this browser with the same verifier as the Verify receipts page.` })));
  } } }, 'Verify the whole ledger');
  root.append(
    card('Receipt explorer', { id: 'ex-title', actions: verifyAll },
      h('div', { class: 'filters' }, field('Search', q), field('Type', types), field('Decision', decisions), field('List version', versions), field('From', from), field('To', to)),
      verifyHost, host, foot));
  draw();
}

/** The receipt detail for the drawer. */
export function receiptView(ctx, receiptId) {
  const { ws } = ctx;
  const entry = ws.ledger.find(receiptId);
  if (!entry) return empty('That receipt does not exist.');
  const { receipt } = entry;
  const segment = ws.ledger.segments[entry.segment];
  const version = ws.version(entry.versionId);
  const p = receipt.action.params;
  const prev = receipt.seq > 0 ? segment.chain.receipts[receipt.seq - 1] : null;
  const next = ws.ledger.next(entry);
  const body = h('div', { class: 'receipt' });
  const hashRow = (value) => h('span', { class: 'field__text' }, mono(value, 'hash'), copyButton(value, 'value'));
  const d = describe(ws, entry);
  body.append(
    h('p', { class: 'receipt__what', text: `${d.actor}: ${d.text}` }),
    kv([
      ['Type', TYPE_LABELS[receipt.action.type] ?? receipt.action.type], [`Time (${zoneName()})`, receipt.action.requested_at], ['Decision', receipt.verdict.decision],
      ['List version', `${version.label} (${version.real ? 'OFAC snapshot' : 'demo reconstruction'}), digest ${shortHash(version.digest)}`],
      ['Segment', `${segment.id}, position ${receipt.seq} of ${segment.chain.receipts.length}`],
    ]),
    h('h3', { text: 'What was recorded' }),
    kv(Object.entries(p).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])),
    h('h3', { text: 'Signature and chain' }),
    kv([
      ['Signer (public key)', hashRow(receipt.verdict.authorizer_id)], ['Signature (Ed25519)', hashRow(receipt.verdict.signature)],
      ['Action digest', hashRow(receipt.verdict.action_digest)], ['This receipt hash', hashRow(receipt.this_hash)],
      ['Previous hash', prev ? h('span', { class: 'field__text' }, mono(receipt.prev_hash, 'hash'), h('button', { type: 'button', class: 'linkbtn', on: { click: () => ctx.openReceipt(prev.receipt_id) } }, 'open')) : mono(`${receipt.prev_hash.slice(0, 16)}… (start of segment)`)],
      ['Next receipt', next ? h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(next.receipt.receipt_id) } }, next.receipt.receipt_id.replace('rcpt:', '')) : 'None yet (this is the segment head)'],
    ]),
  );
  const result = h('div', { role: 'status', 'aria-live': 'polite' });
  const verify = h('button', { type: 'button', class: 'btn btn--primary', on: { click: async () => {
    verify.disabled = true;
    const outcome = await ws.ledger.verifySegment(entry.segment);
    verify.disabled = false;
    clear(result);
    if (outcome.kind !== 'pass' && outcome.kind !== 'fail') {
      result.append(h('div', { class: 'banner', 'data-state': outcome.kind === 'unsupported' ? 'unsupported' : 'neutral' }, h('span', { class: 'banner__lead', text: outcome.kind === 'unsupported' ? 'This browser cannot check Ed25519 signatures.' : 'Could not check' }), h('span', { class: 'banner__detail', text: outcome.message ?? '' })));
      return;
    }
    const mine = outcome.receipts[receipt.seq];
    const ok = mine.failed.length === 0;
    result.append(
      h('div', { class: 'banner', 'data-state': ok ? (outcome.kind === 'pass' ? 'pass' : 'caveat') : 'fail' },
        h('span', { class: 'banner__lead', text: ok ? 'This receipt verified' : 'This receipt failed' }),
        h('span', { class: 'banner__detail', text: `The real verifier checked all ${outcome.receipts.length} receipts in ${segment.id}, because receipts verify as a chain. ${outcome.kind === 'pass' ? 'The segment passes.' : 'Another receipt in the segment failed.'}` })),
      h('ul', { class: 'pchecks' }, mine.checks.map((c) => h('li', { class: 'pcheck', 'data-ok': String(c.ok) }, h('span', { class: 'pcheck__mark', text: c.ok ? 'Pass' : 'Fail' }), h('span', { class: 'pcheck__body', text: CHECK_LABELS[c.id] ?? c.id })))),
      h('p', { class: 'field__hint', text: 'This shows the receipt is unchanged since it was signed. It does not re-run the screening. The demo key is public, so it says nothing about who signed.' }));
  } } }, icon('shield'), 'Verify this receipt');
  body.append(h('h3', { text: 'Verify' }), h('div', { class: 'btnrow' }, verify,
    h('button', { type: 'button', class: 'btn', on: { click: () => ctx.openInVerifier(ws.ledger.segmentText(entry.segment)) } }, 'Open the segment in the verifier page')), result,
    h('details', { class: 'chart__table' }, h('summary', { text: 'Raw receipt JSON' }), h('pre', { class: 'rawjson', tabindex: '0', text: JSON.stringify(receipt, null, 2) })));
  return body;
}

// ---- activity log ---------------------------------------------------------------------------

export function renderActivity(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const groups = [{ value: 'all', label: 'Everything' }, { value: 'screening', label: 'Screenings' }, { value: 'cases', label: 'Case work' }, { value: 'lists', label: 'Lists and watchlist' }, { value: 'admin', label: 'Policy, roles, exports' }, { value: 'network', label: 'Receipt network and gate' }, { value: 'ledger', label: 'Ledger' }];
  const actors = [{ value: 'all', label: 'Anyone' }, { value: 'api', label: 'API (demo feed)' }, { value: 'system', label: 'System' }, ...ws.users.map((u) => ({ value: u.id, label: u.name }))];
  const host = h('div', {});
  const draw = () => {
    clear(host);
    const types = activity.group === 'all' ? null : new Set(TYPE_GROUPS[activity.group]);
    const rows = ws.ledger.entries.filter((e) => {
      if (types && !types.has(e.receipt.action.type)) return false;
      const actor = e.receipt.action.params.actor ?? 'system';
      return activity.actor === 'all' || actor === activity.actor;
    }).reverse();
    if (activity.page * 40 >= rows.length) activity.page = 0;
    host.append(dataTable({
      caption: 'Activity log', rows: rows.slice(activity.page * 40, (activity.page + 1) * 40), rowKey: (e) => e.receipt.receipt_id, onOpen: (e) => ctx.openReceipt(e.receipt.receipt_id),
      empty: empty('No activity matches.'),
      cols: [
        { label: `Time (${zoneName()})`, render: (e) => stamp(e.receipt.action.requested_at) },
        { label: 'Who', render: (e) => describe(ws, e).actor },
        { label: 'What', cls: 'wrap', render: (e) => describe(ws, e).text },
        { label: 'Receipt', open: true, render: (e) => e.receipt.receipt_id.replace('rcpt:', '') },
      ],
    }), pager({ page: activity.page, size: 40, total: rows.length, onChange: (p) => { activity.page = p; draw(); } }));
  };
  root.append(
    card('Activity log', { id: 'ac-title' }, h('div', { class: 'filters' }, field('Show', select('ac-group', groups, activity.group, (v) => { activity.group = v; activity.page = 0; draw(); })), field('Who', select('ac-actor', actors, activity.actor, (v) => { activity.actor = v; activity.page = 0; draw(); }))), host));
  draw();
}
