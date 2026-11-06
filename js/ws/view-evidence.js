/** Exam and audit evidence packs: build, download (JSON and printable HTML), and check a pack offline. */
import { card, clear, dataTable, download, empty, field, h, icon, kv, mono, select, stamp } from './dom.js';
import { buildPack, CLI_SNIPPET, packHtml, VERIFY_STEPS, verifyPack } from './evidence.js';
import { dayKey, DAY_MS } from './util.js';

const st = { type: 'range', from: '', to: '', alertId: '', pack: null, error: '', exported: null, check: null, checkName: '' };

export function renderEvidence(ctx, root) {
  const { ws } = ctx;
  const params = ctx.takeParams('evidence');
  const today = dayKey(ctx.now());
  if (!st.to) { st.to = today; st.from = dayKey(ctx.now().getTime() - 7 * DAY_MS); }
  if (params.case) { st.type = 'case'; st.alertId = params.case; st.pack = null; }
  if (!st.alertId) st.alertId = ws.alerts.find((a) => a.timeline.some((t) => t.action === 'approve_clear'))?.id ?? ws.alerts[0]?.id ?? '';
  clear(root);

  const scopeNow = () => (st.type === 'range' ? { type: 'range', from: st.from, to: st.to } : st.type === 'case' ? { type: 'case', alertId: st.alertId } : { type: 'all' });
  const radio = (value, label) => h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'ev-type', value, checked: st.type === value, on: { change: () => { st.type = value; st.pack = null; ctx.refresh(); } } }), label);
  const from = h('input', { id: 'ev-from', class: 'input', type: 'date', value: st.from, disabled: st.type !== 'range' });
  const to = h('input', { id: 'ev-to', class: 'input', type: 'date', value: st.to, disabled: st.type !== 'range' });
  from.addEventListener('change', () => { st.from = from.value; st.pack = null; });
  to.addEventListener('change', () => { st.to = to.value; st.pack = null; });
  const caseSel = select('ev-case', ws.alerts.slice().reverse().map((a) => ({ value: a.id, label: `${a.id} · ${a.kind} · ${a.status}` })), st.alertId, (v) => { st.alertId = v; st.pack = null; });
  caseSel.disabled = st.type !== 'case';
  const error = h('p', { class: 'field__hint field__hint--bad', role: 'alert', text: st.error });
  const preview = h('div', { role: 'status', 'aria-live': 'polite' });

  const exportPack = async (kind) => {
    const pack = st.pack;
    if (!pack) return;
    if (st.exported !== pack.pack_digest) {
      const r = await ctx.run({ op: 'evidenceExport', actor: ctx.userId, scope: pack.scope, packDigest: pack.pack_digest, receiptCount: pack.selection.count, segmentCount: pack.segments.length }, { refresh: false });
      if (!r.ok) return;
      st.exported = pack.pack_digest;
    }
    const stem = `tollgate-evidence-${pack.scope.type}-${pack.pack_digest.slice(0, 10)}`;
    if (kind === 'json') download(`${stem}.json`, `${JSON.stringify(pack, null, 2)}\n`, 'application/json');
    else download(`${stem}.html`, packHtml(pack), 'text/html');
    ctx.toast('Downloaded. The export was recorded as a signed receipt.');
    ctx.refreshChrome();
  };
  const drawPreview = () => {
    clear(preview);
    const pack = st.pack;
    if (!pack) return;
    preview.append(h('div', { class: 'cardbody' },
      kv([
        ['Receipts in scope', String(pack.selection.count)], ['Screening decisions', String(pack.decisions.length)], ['Cases', String(pack.cases.length)],
        ['Four-eyes approvals', String(pack.approvals.length)], ['Policy and role changes', String(pack.policy_history.length)],
        ['Ledger segments included', pack.segments.map((s) => s.segment_id).join(', ')],
        ['List versions', pack.list_versions.map((v) => v.label).join(', ')],
        ['Pack digest', mono(pack.pack_digest)],
      ]),
      h('p', { class: 'field__hint', text: 'Whole ledger segments are included unchanged, so each one still verifies exactly as signed. The tables are summaries that point back to receipt ids, and checking the pack re-derives each line from the receipts.' }),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn btn--primary', on: { click: () => exportPack('json') } }, icon('download'), 'Download pack (JSON)'),
        h('button', { type: 'button', class: 'btn', on: { click: () => exportPack('html') } }, icon('download'), 'Download report (HTML, printable)'),
        h('button', { type: 'button', class: 'btn', on: { click: async () => { st.check = await verifyPack(st.pack); st.checkName = 'the pack you just built'; ctx.refresh(); } } }, 'Check this pack now')),
      h('p', { class: 'field__hint', text: 'Downloading records an evidence_export receipt. Open the HTML file and use your browser\'s print command to save a PDF.' })));
  };
  const build = h('button', { type: 'button', class: 'btn btn--primary', disabled: !ws.can(ctx.userId, 'export'), on: { click: async () => {
    st.error = '';
    error.textContent = '';
    try {
      st.pack = await buildPack(ws, scopeNow(), { now: ctx.now(), actor: ctx.userId });
      st.exported = null;
      st.check = null;
    } catch (e) {
      st.pack = null;
      st.error = e.message;
      error.textContent = e.message;
    }
    drawPreview();
  } } }, 'Build pack');

  root.append(
    h('p', { class: 'notice' }, h('strong', { text: 'Demo evidence. ' }), 'Built from the synthetic ledger in this browser. A real pack would hold your receipts; the structure, hashes and offline checks are the same.'),
    card('Build an evidence pack', { id: 'ev-build', sub: 'For an audit or an exam' }, h('div', { class: 'cardbody' },
      h('fieldset', { class: 'scope' }, h('legend', { text: 'Scope' }), radio('range', 'Date range (UTC)'), radio('case', 'One case'), radio('all', 'Whole ledger')),
      h('div', { class: 'filters' }, field('From', from), field('To', to), field('Case', caseSel)), build, error), preview),
  );
  drawPreview();

  // Check a pack
  const file = h('input', { id: 'ev-file', class: 'sr', type: 'file', accept: '.json,application/json' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    st.check = await verifyPack(await f.text());
    st.checkName = f.name;
    ctx.refresh();
  });
  const checkBody = h('div', { class: 'cardbody' },
    h('p', { class: 'field__hint', text: 'Choose a pack downloaded from this page. It is read in this browser, never uploaded. Each segment is run through the real verifier.' }),
    h('div', { class: 'toolbar' }, h('label', { class: 'btn', for: 'ev-file' }, icon('upload'), 'Choose a pack file'), file));
  if (st.check) {
    checkBody.append(h('div', { class: 'banner', 'data-state': st.check.ok ? 'pass' : 'fail', role: 'status' },
      h('span', { class: 'banner__lead', text: st.check.ok ? 'Pack verified' : 'Pack failed a check' }), h('span', { class: 'banner__detail', text: `Checked ${st.checkName}.` })),
    h('ul', { class: 'pchecks' }, st.check.checks.map((c) => h('li', { class: 'pcheck', 'data-ok': String(c.ok) }, h('span', { class: 'pcheck__mark', text: c.ok ? 'Pass' : 'Fail' }), h('span', { class: 'pcheck__body', text: c.detail })))));
  }
  root.append(card('Check a pack', { id: 'ev-check' }, checkBody));

  // Instructions
  root.append(card('Verify a pack offline', { id: 'ev-steps' }, h('div', { class: 'cardbody' },
    h('ol', { class: 'steps' }, VERIFY_STEPS.map((s) => h('li', { text: s }))),
    h('p', { class: 'field__hint', text: 'Command line, from a copy of this demo site (needs Node 20 or later, sends nothing anywhere):' }),
    h('pre', { class: 'rawjson', tabindex: '0', text: CLI_SNIPPET }),
    h('p', { class: 'field__hint', text: 'A pack shows the receipts are unchanged since they were signed. It does not re-run the screening, and it cannot show that a dropped last receipt or an omitted segment existed; keep the head hash you saw at export to catch that.' }))));

  // Export history
  root.append(card('Exports from this session', { id: 'ev-history' }, dataTable({
    caption: 'Exports', rows: [...ws.exports].reverse(), rowKey: (e) => e.receiptId,
    empty: empty('Nothing has been exported yet.'),
    cols: [
      { label: 'Time (UTC)', render: (e) => stamp(e.ts) }, { label: 'By', render: (e) => ws.user(e.actor)?.name ?? e.actor },
      { label: 'Scope', render: (e) => (e.scope.type === 'range' ? `${e.scope.from} to ${e.scope.to}` : e.scope.type === 'case' ? e.scope.alertId : 'Whole ledger') },
      { label: 'Pack digest', render: (e) => mono(`${e.packDigest.slice(0, 16)}…`) },
      { label: 'Receipt', render: (e) => h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(e.receiptId) } }, e.receiptId.replace('rcpt:', '')) },
    ],
  })));
}
