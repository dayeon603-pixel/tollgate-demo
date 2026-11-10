/** Screening: one address at a time, or a pasted or uploaded CSV. Exact address match, nothing fuzzy. */
import { card, clear, dataTable, download, empty, field, h, icon, mono, money, outcomeTag, pager, segmented, select, shortAddr } from './dom.js';
import { pageSize } from './settings.js';
import { stamp, zoneName } from './dom.js';
import { MAX_BATCH_ROWS, MAX_UPLOAD_BYTES, parseBatch, resultsCsv, runBatch } from './batch.js';
import { MAX_ADDRESS_LENGTH } from '../workbench.js';

const PAGE_DEFAULT = 50;
const pageLen = () => pageSize(PAGE_DEFAULT);
const st = { single: null, text: '', parsed: null, results: null, filter: 'all', page: 0, busy: false, progress: '', fileNote: '' };

function exampleCsv(ws) {
  const listed = [...ws.inForce.byAddress.values()].map((e) => e[0].address).find((a) => a.startsWith('0x'));
  return [
    'address,amount_usd,tx_hash,originator_present',
    '0x3b7a1c9e5d2f4a6b8c0d1e2f3a4b5c6d7e8f9a0b,420,0xdemo0001,yes',
    '0x8c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d,1500,0xdemo0002,no',
    `${listed},950,0xdemo0003,yes`,
    '0x5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f,60000,0xdemo0004,yes',
    'not an address,100,,yes',
    '0x9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b,2300.50,,',
  ].join('\n');
}

export function renderScreening(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const canScreen = ws.can(ctx.userId, 'screen');

  // Single address
  const address = h('input', { id: 'sc-address', class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: MAX_ADDRESS_LENGTH, placeholder: '0x... or any address', 'aria-describedby': 'sc-error' });
  const amount = h('input', { id: 'sc-amount', class: 'input', type: 'text', inputmode: 'numeric', autocomplete: 'off', placeholder: 'Whole dollars, or empty' });
  const originator = select('sc-orig', [{ value: 'yes', label: 'Provided' }, { value: 'no', label: 'Blank' }], 'yes');
  const txHash = h('input', { id: 'sc-tx', class: 'input mono', type: 'text', autocomplete: 'off', placeholder: 'Optional, one is generated if empty' });
  const error = h('p', { id: 'sc-error', class: 'field__hint field__hint--bad', role: 'alert' });
  const resultBox = h('div', { class: 'screen__result', role: 'status', 'aria-live': 'polite' });
  const showSingle = () => {
    clear(resultBox);
    const r = st.single;
    if (!r) { delete resultBox.dataset.outcome; return; }
    resultBox.dataset.outcome = r.tx.outcome;
    const entry = r.tx.entries[0];
    resultBox.append(
      h('p', { class: 'screen__lead' }, outcomeTag(r.tx.outcome), r.tx.outcome === 'BLOCK' ? 'On the list' : r.tx.outcome === 'HOLD' ? 'Held by a policy rule' : 'Not on the list, no rule triggered'),
      h('p', { class: 'screen__addr mono', text: r.tx.address }),
      h('p', { class: 'screen__detail', text: entry ? `${entry.name} (${entry.chain}, list UID ${entry.uid})` : r.tx.rule ? `Rule: ${r.tx.rule.replace('_', ' ')}` : `Checked against ${ws.version(r.tx.versionId).label}, exact match.` }),
      h('p', { class: 'screen__detail' }, `Receipt `, h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(r.tx.receiptId) } }, r.tx.receiptId.replace('rcpt:', '')), r.tx.alertId ? [' · Alert ', h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openAlert(r.tx.alertId) } }, r.tx.alertId)] : ''));
  };
  const form = h('form', { class: 'screen', novalidate: true },
    h('div', { class: 'screen__fields' },
      h('div', { class: 'fieldbox fieldbox--grow' }, h('label', { for: 'sc-address', text: 'Crypto address' }), address),
      field('Amount in USD', amount), field('Originator details', originator), field('Transaction hash', txHash),
      h('button', { type: 'submit', class: 'btn btn--primary btn--tall', disabled: !canScreen }, 'Screen')),
    error);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const raw = amount.value.trim();
    const result = await ctx.run({ op: 'screen', actor: ctx.userId, source: 'manual', address: address.value, amount: raw === '' ? null : raw.replace(/,/g, ''), originator: originator.value === 'yes', txHash: txHash.value || undefined }, { quiet: true, refresh: false });
    if (!result.ok) { error.textContent = result.error.message; address.setAttribute('aria-invalid', 'true'); return; }
    address.removeAttribute('aria-invalid');
    st.single = result.result;
    st.focus = true;
    ctx.toast(`Screened. Receipt ${result.result.receipt.receipt_id.replace('rcpt:', '')} signed.`);
    ctx.refresh();
  });
  const example = ws.inForce ? [...ws.inForce.byAddress.values()].map((e) => e[0].address).find((a) => a.startsWith('0x')) : '';
  const trylink = h('p', { class: 'screen__try' }, 'Try a listed address: ', h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => { address.value = example; address.focus(); } } }, example));
  root.append(card('Screen one address', { id: 'sc-single', sub: `Exact match against ${ws.inForce.label}, ignoring case` }, h('div', { class: 'cardbody' }, form, trylink, resultBox)));
  showSingle();
  if (st.focus) { st.focus = false; address.focus(); }

  // Batch
  const text = h('textarea', { id: 'bt-text', class: 'file batchtext', rows: 6, spellcheck: 'false', 'aria-describedby': 'bt-hint', placeholder: 'address,amount_usd,tx_hash,originator_present\n0x...,1500,0x...,no' });
  text.value = st.text;
  text.addEventListener('input', () => { st.text = text.value; });
  const file = h('input', { id: 'bt-file', class: 'sr', type: 'file', accept: '.csv,.txt,text/csv,text/plain' });
  const status = h('p', { class: 'field__hint', role: 'status', 'aria-live': 'polite', text: st.progress });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > MAX_UPLOAD_BYTES) { status.textContent = `That file is larger than ${MAX_UPLOAD_BYTES / 1000} KB. Split it and try again.`; return; }
    text.value = await f.text();
    st.text = text.value;
    status.textContent = `Loaded ${f.name}. It was read in this browser and not uploaded.`;
  });
  const resultsHost = h('div', { id: 'bt-results' });
  const drawResults = () => {
    clear(resultsHost);
    const all = st.results;
    if (!all) return;
    const counts = (k) => all.filter((r) => r.status === k).length;
    const rows = st.filter === 'all' ? all : all.filter((r) => r.status === st.filter);
    resultsHost.append(
      h('div', { class: 'card__head' }, h('h3', { class: 'card__title', text: `Results: ${all.length} rows` }), segmented({
        label: 'Filter results', value: st.filter,
        options: [{ value: 'all', label: 'All', count: all.length }, { value: 'BLOCK', label: 'Hit', count: counts('BLOCK') }, { value: 'HOLD', label: 'Hold', count: counts('HOLD') }, { value: 'ALLOW', label: 'Allow', count: counts('ALLOW') }, { value: 'INVALID', label: 'Invalid', count: counts('INVALID') }],
        onChange: (v) => { st.filter = v; st.page = 0; drawResults(); },
      }), h('button', { type: 'button', class: 'btn', on: { click: () => download('tollgate-batch-results.csv', resultsCsv(all), 'text/csv') } }, icon('download'), 'Export CSV')),
      dataTable({
        caption: 'Batch results', rows: rows.slice(st.page * pageLen(), (st.page + 1) * pageLen()), rowKey: (r) => String(r.line),
        empty: empty('No rows in this filter.'),
        cols: [
          { label: 'Line', num: true, render: (r) => r.line },
          { label: 'Address', render: (r) => h('span', { class: 'mono', title: r.address, text: shortAddr(r.address) }) },
          { label: 'Amount', num: true, render: (r) => (r.amount === null ? '' : money(r.amount)) },
          { label: 'Result', render: (r) => (r.status === 'INVALID' ? h('span', { class: 'decision decision--other', text: 'Invalid' }) : outcomeTag(r.status)) },
          { label: 'Receipt', render: (r) => (r.receiptId ? h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(r.receiptId) } }, r.receiptId.replace('rcpt:', '')) : '') },
          { label: 'Alert', render: (r) => (r.alertId ? h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openAlert(r.alertId) } }, r.alertId) : '') },
          { label: 'Notes', cls: 'wrap', render: (r) => [...r.problems, ...r.notes].join(' ') },
        ],
      }),
      pager({ page: st.page, size: pageLen(), total: rows.length, onChange: (p) => { st.page = p; drawResults(); } }));
  };
  const run = h('button', { type: 'button', class: 'btn btn--primary', disabled: !canScreen || st.busy }, 'Screen all');
  run.addEventListener('click', async () => {
    const parsed = parseBatch(text.value);
    if (parsed.error) { status.textContent = parsed.error; return; }
    run.disabled = true;
    st.busy = true;
    const batchId = `B${Date.now().toString(36)}`;
    const results = await ctx.measure.time('batch', 'Batch screened and signed', () => runBatch(ws, parsed.rows, {
      actor: ctx.userId, batchId, now: () => ctx.now(),
      onProgress: (done, total) => { status.textContent = `Screened ${done} of ${total}`; },
    }), (r) => ({ addresses: r.length }));
    st.busy = false;
    st.results = results;
    st.filter = 'all';
    st.page = 0;
    ctx.persist();
    const hits = results.filter((r) => r.status === 'BLOCK').length;
    const holds = results.filter((r) => r.status === 'HOLD').length;
    status.textContent = `${results.length} rows: ${hits} hit, ${holds} hold, ${results.filter((r) => r.status === 'ALLOW').length} allow, ${results.filter((r) => r.status === 'INVALID').length} invalid.${parsed.truncated ? ` Only the first ${MAX_BATCH_ROWS} rows were screened.` : ''}`;
    ctx.refreshChrome();
    drawResults();
    if (results.some((r) => r.alertId)) ctx.toast('Alerts were created for hits and holds.');
  });
  root.append(card('Batch screening', { id: 'bt-title', sub: `Up to ${MAX_BATCH_ROWS} rows` }, h('div', { class: 'cardbody' },
    h('p', { id: 'bt-hint', class: 'field__hint', text: 'Paste CSV or upload a file. Columns: address, amount_usd, tx_hash, originator_present (yes or no). A header row is optional. Each valid row gets its own signed receipt. Nothing is uploaded.' }),
    h('div', { class: 'fieldbox' }, h('label', { for: 'bt-text', text: 'Addresses or transactions' }), text),
    h('div', { class: 'toolbar' }, run,
      h('label', { class: 'btn', for: 'bt-file' }, icon('upload'), 'Upload CSV'), file,
      h('button', { type: 'button', class: 'btn', on: { click: () => { text.value = exampleCsv(ws); st.text = text.value; } } }, 'Load an example')),
    status), resultsHost));
  drawResults();

  // Recent screenings
  const recent = ws.txs.slice(-12).reverse();
  root.append(card('Latest screenings', { id: 'sc-recent' }, dataTable({
    caption: 'Latest screenings', rows: recent, rowKey: (t) => t.id, onOpen: (t) => ctx.openReceipt(t.receiptId),
    cols: [
      { label: 'Payment', open: true, render: (t) => t.id }, { label: `Time (${zoneName()})`, render: (t) => stamp(t.ts) },
      { label: 'Address', render: (t) => mono(shortAddr(t.address)) }, { label: 'Amount', num: true, render: (t) => money(t.amountUsd) },
      { label: 'Result', render: (t) => outcomeTag(t.outcome) }, { label: 'Source', render: (t) => t.source },
    ],
  })));
}
