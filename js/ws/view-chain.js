/**
 * Live chain view, and the dashboard's hero card: real USDC and USDT transfers on Ethereum mainnet,
 * screened against the bundled OFAC snapshot and signed in this browser. The data comes from
 * ChainWatcher (chain.js); this file only draws it.
 */
import { card, clear, copyButton, download, h, kv, money, mono, outcomeTag, shortAddr, shortHash, zoneName } from './dom.js';
import { formatClock, formatClockPrecise, formatDate, formatNumber, formatStamp, formatStampPrecise, formatStampSeconds, getSettings } from './settings.js';
import { chip } from './moat-ui.js';
import { createChart, compact } from './chartx.js';
import { CHAIN_MAX_RECEIPTS, ENDPOINTS, isoSeconds, REPLAY } from './chain.js';
import { bucketLabel, bucketRows, rangeByKey, recordsNote, toChartPoints, zoneOf } from './timerange.js';
import { gapKey, rangeControl, sentence } from './range-ui.js';

const TABLE_ROWS = 50;
const REDRAW_MS = 800;
const CLEAR_CONFIRM_MS = 6000;
const RECORDING_LINE = 'Recording runs while this page is open. The self-hosted kit records around the clock.';
const STORAGE_TEXT = { indexeddb: 'Saved in this browser (IndexedDB)', memory: 'Memory only, lost when this page closes or reloads', loading: 'Opening saved records' };
const STATE_CHIP = {
  idle: ['Not connected', 'neutral'], connecting: ['Connecting', 'neutral'], live: ['Live', 'ok'], paused: ['Paused', 'neutral'],
  retrying: ['Retrying', 'warn'], error: ['Cannot reach the node', 'bad'],
};
const etherscanTx = (hash) => (/^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://etherscan.io/tx/${hash}` : 'https://etherscan.io/');
const etherscanAddr = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? `https://etherscan.io/address/${a}` : 'https://etherscan.io/');
const extLink = (href, text, label) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'extlink', 'aria-label': label, title: label }, text);
const isoDate = (us) => { const [m, d, y] = String(us).split('/'); return y ? `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : String(us); };
/** Token amount for a table cell. Zero-value transfers (often address-poisoning spam) read "0", dust reads "<0.01". */
const amountText = (r) => {
  const n = Number(r.amount);
  const text = n === 0 ? '0' : n < 0.01 ? '<0.01' : n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: n < 100 ? 2 : 0 });
  return `${text} ${r.symbol}`;
};

/** "Live Ethereum mainnet · real transfers · list snapshot dated 2026-10-21" with the status chip. */
export function chainLabel(ctx) {
  const date = isoDate(ctx.listMeta?.publish_date ?? '');
  return `Live Ethereum mainnet · real transfers · list snapshot dated ${date}`;
}

function statusChip(w) {
  const [text, tone] = STATE_CHIP[w.state] ?? STATE_CHIP.idle;
  return h('span', { class: `chainstate chainstate--${w.state}`, id: 'ch-state', 'data-state': w.state, title: w.message }, h('span', { class: 'chainstate__dot', 'aria-hidden': 'true' }), w.state === 'live' && w.head ? `${text} · block ${formatNumber(w.head)}` : text);
}

/** Subscribes `draw` to watcher updates (throttled) until `root` leaves the page. */
function follow(w, root, draw) {
  let pending = false;
  let last = 0;
  const run = () => { pending = false; last = Date.now(); if (root.isConnected) draw(); };
  const off = w.subscribe(() => {
    if (!root.isConnected) { off(); return; }
    if (pending) return;
    pending = true;
    setTimeout(run, Math.max(0, REDRAW_MS - (Date.now() - last)));
  });
}

function perBlockCharts(w, { height = 180, compactView = false } = {}) {
  const blockFmt = (b, long) => {
    if (!long) return formatNumber(b);
    const row = w.blocks.find((x) => x.block === b);
    return `Block ${formatNumber(b)}${row?.t ? `, ${formatClock(row.t)} ${zoneName()}` : ''}`;
  };
  const transfers = createChart({ id: compactView ? 'c-chain-mini' : 'c-chain-n', integerAxis: true, kind: 'bars', stacked: true, height,
    title: 'USDC and USDT transfers screened per block, real Ethereum mainnet data: clear and on the list',
    series: [{ key: 'clear', label: 'Clear', cls: 'allow' }, { key: 'hit', label: 'On the list', cls: 'block', pattern: true }],
    xFmt: blockFmt, tableLabel: 'Block', valueFmt: (v) => formatNumber(v ?? 0), emptyText: w.state === 'error' ? 'No data: the node cannot be reached.' : 'Waiting for the next block.' });
  const usd = compactView ? null : createChart({ id: 'c-chain-usd', kind: 'bars', height,
    title: 'USD value of USDC and USDT transfers screened per block (1 token = 1 USD)',
    series: [{ key: 'usd', label: 'USD screened', cls: 'value' }], xFmt: blockFmt, tableLabel: 'Block', yFmt: (v) => `$${compact(v)}`, valueFmt: (v) => money(v ?? 0), emptyText: 'Waiting for the next block.' });
  const update = () => {
    transfers.update(w.blocks.map((b) => ({ t: b.block, values: { clear: b.n - b.hits, hit: b.hits } })));
    usd?.update(w.blocks.map((b) => ({ t: b.block, values: { usd: b.usd } })));
  };
  return { transfers, usd, update };
}

/** Drawer body for one Live chain receipt. */
export function chainReceiptView(ctx, record) {
  const w = ctx.chain;
  const entry = record.epoch === w.epoch ? w.ledger.find(record.receiptId) : null;
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  const matches = [...record.toMatches.map((e) => `To: ${e.name} (UID ${e.uid})`), ...record.fromMatches.map((e) => `From: ${e.name} (UID ${e.uid})`)];
  const body = h('div', { class: 'case' },
    record.source === 'historical_replay' ? h('p', { class: 'chip chip--warn', text: `Historical transfer, block ${formatNumber(record.block)}, replayed from the chain` }) : null,
    kv([
      ['Decision', outcomeTag(record.outcome)],
      ['Token', `${record.symbol} (${record.symbol === 'USDC' ? 'Circle' : 'Tether'})`],
      ['Amount', amountText(record)],
      ['From', h('span', { class: 'field__text' }, mono(record.from), copyButton(record.from, 'sender'))],
      ['To', h('span', { class: 'field__text' }, mono(record.to), copyButton(record.to, 'receiver'))],
      ['Block', formatNumber(record.block)],
      ['Block time', record.block_time ? `${formatStampSeconds(record.block_time)} ${zoneName()}` : 'unknown'],
      ['Screened at', `${formatStampPrecise(record.screened_at)} ${zoneName()}`],
      ['Transaction', h('span', { class: 'field__text' }, mono(shortHash(record.tx, 12, 8)), extLink(etherscanTx(record.tx), 'Etherscan', 'Open the transaction on Etherscan'))],
      ['List', chainLabel(ctx).split('· ').at(-1)],
      matches.length ? ['On the list', matches.join('; ')] : null,
      ['Receipt', mono(record.receiptId.replace('rcpt:', ''))],
      entry ? ['Receipt hash', mono(shortHash(entry.receipt.this_hash, 14, 8))] : null,
    ]));
  const verify = h('button', { type: 'button', class: 'btn', id: 'chr-verify', disabled: !entry, on: { click: async () => {
    const outcome = await w.ledger.verifySegment(entry.segment);
    clear(out).append(h('div', { class: 'banner', 'data-state': outcome.kind === 'pass' ? 'pass' : 'fail' }, h('span', { class: 'banner__lead', text: outcome.kind === 'pass' ? 'Segment verifies' : 'Segment failed' }),
      h('span', { class: 'banner__detail', text: `${w.ledger.segments[entry.segment].chain.receipts.length} receipts checked with the page's verifier.` })));
  } } }, 'Verify');
  const json = h('details', { class: 'chart__table' }, h('summary', { text: 'Receipt JSON' }), h('pre', { class: 'jsonbox', tabindex: 0, text: JSON.stringify(record.receipt, null, 2) }));
  body.append(...[h('div', { class: 'btnrow' }, verify), out, entry ? null : h('p', { class: 'field__hint', text: `This receipt has left the rolling window of ${CHAIN_MAX_RECEIPTS}.` }), json].filter(Boolean));
  return body;
}

function transferTable(ctx, rows) {
  const tbody = h('tbody', {}, rows.map((r) => h('tr', { class: `grid__row${r.outcome === 'BLOCK' ? ' tape__row--block' : ''}`, 'data-outcome': r.outcome, 'data-source': r.source },
    h('td', { 'data-label': 'Time (UTC)', class: 'tnum' }, formatClock(r.t), h('span', { class: 'tape__ms', title: 'Screened at (this page\'s clock)', text: `screened ${formatClockPrecise(r.screened_at)}` }), r.source === 'historical_replay' ? h('span', { class: 'chip chip--warn chainhist', text: `Historical, ${formatStamp(new Date(r.t).toISOString()).slice(0, 10)}` }) : null),
    h('td', { 'data-label': 'Token', text: r.symbol }),
    h('td', { 'data-label': 'Amount', class: 'num', text: amountText(r) }),
    h('td', { 'data-label': 'From', class: 'mono', title: r.from, text: shortAddr(r.from) }),
    h('td', { 'data-label': 'To', class: 'mono', title: r.to, text: shortAddr(r.to) }),
    h('td', { 'data-label': 'Decision' }, outcomeTag(r.outcome)),
    h('td', { 'data-label': 'Receipt' }, h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openChainReceipt(r) } }, r.receiptId.replace('rcpt:', ''))),
    h('td', { 'data-label': 'Etherscan' }, extLink(etherscanTx(r.tx), shortHash(r.tx, 6, 4), `Transaction ${r.tx} on Etherscan`)))));
  return h('div', { class: 'tablewrap tablewrap--scroll tape' }, h('table', { class: 'grid grid--tape', id: 'ch-table' },
    h('caption', { class: 'sr', text: 'Latest screened transfers, newest first' }),
    h('thead', {}, h('tr', {}, [`Time (${zoneName()})`, 'Token', 'Amount', 'From', 'To', 'Decision', 'Receipt', 'Etherscan'].map((t, i) => h('th', { scope: 'col', class: i === 2 ? 'num' : '' }, t)))), tbody));
}

function freezeTable(ctx, w) {
  const date = isoDate(ctx.listMeta?.publish_date ?? '');
  if (!w.freezes.length) {
    const text = w.backfill.state === 'failed' ? `Could not read past freezes (${w.backfill.message}). New ones will appear as they happen.`
      : w.backfill.state === 'done' ? `No freezes in blocks ${formatNumber(w.backfill.from)} to ${formatNumber(w.backfill.to)}. New ones will appear here.` : 'Reading recent freezes.';
    return h('p', { class: 'card__note', id: 'ch-freeze-empty', text });
  }
  return h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'ch-freezes' },
    h('caption', { class: 'sr', text: 'Issuer freeze events, newest first' }),
    h('thead', {}, h('tr', {}, [`Time (${zoneName()})`, 'Issuer', 'Event', 'Address', `On OFAC list (${date})`, 'Etherscan'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', {}, w.freezes.slice(0, TABLE_ROWS).map((f) => h('tr', { class: 'grid__row', 'data-listed': String(f.listed) },
      h('td', { 'data-label': 'Time (UTC)', class: 'tnum', text: f.t ? formatStampSeconds(f.t) : `block ${formatNumber(f.block)}` }),
      h('td', { 'data-label': 'Issuer', text: `${f.symbol === 'USDC' ? 'Circle' : 'Tether'} (${f.symbol})` }),
      h('td', { 'data-label': 'Event', text: f.kind === 'freeze' ? 'Frozen' : 'Unfrozen' }),
      h('td', { 'data-label': 'Address' }, h('a', { href: etherscanAddr(f.address), target: '_blank', rel: 'noopener noreferrer', class: 'mono', title: f.address }, shortAddr(f.address))),
      h('td', { 'data-label': 'On OFAC list' }, f.listed ? chip(`Yes: ${f.entries[0].name}`, 'bad') : chip('No', 'neutral')),
      h('td', { 'data-label': 'Etherscan' }, extLink(etherscanTx(f.tx), shortHash(f.tx, 6, 4), `Transaction ${f.tx} on Etherscan`)))))));
}

function kpis(w) {
  const kpi = (label, value, sub, id) => h('div', { class: 'kpi', id }, h('dt', { text: label }), h('dd', { text: value }), h('p', { class: 'kpi__sub', text: sub }));
  const t = w.totals;
  return h('dl', { class: 'kpis', id: 'ch-kpis' },
    kpi('Latest block', w.head ? formatNumber(w.head) : '-', w.headTime ? `${formatClock(w.headTime)} ${zoneName()}` : 'waiting', 'ch-k-block'),
    kpi('Transfers screened', formatNumber(t.transfers), `in ${formatNumber(t.blocks)} block${t.blocks === 1 ? '' : 's'}`, 'ch-k-n'),
    kpi('Hits on the list', formatNumber(t.hits), `${formatNumber(t.hits)} hit${t.hits === 1 ? '' : 's'} in ${formatNumber(t.transfers)} transfers`, 'ch-k-hits'),
    kpi('Value screened', `$${compact(t.usd)}`, 'USD, 1 token = 1 USD', 'ch-k-usd'),
    kpi('Issuer freezes', formatNumber(w.freezes.filter((f) => f.kind === 'freeze').length), w.backfill.state === 'done' ? `since block ${formatNumber(w.backfill.from)}` : 'live', 'ch-k-freezes'));
}

/**
 * History card: transfers per bucket over the selected range (1D to 3Y), from the saved records. A bucket
 * before the first record reads "No records"; a bucket after it in which the page was not recording reads
 * "Not recording"; a recorded bucket with no transfers is a real zero. Redraws itself when the range changes.
 */
function historyCard(ctx) {
  const store = ctx.records;
  let rangeKey = ctx.range('chain');
  const chart = createChart({
    id: 'c-chain-history', integerAxis: true, kind: 'bars', stacked: true, height: 190,
    title: 'USDC and USDT transfers screened per time bucket, from the records this browser saved: clear and on the list',
    series: [{ key: 'clear', label: 'Clear', cls: 'allow' }, { key: 'hit', label: 'On the list', cls: 'block', pattern: true }],
    xFmt: (t, long) => bucketLabel(rangeKey, t, long, getSettings()), tableLabel: 'Time bucket', valueFmt: (v) => formatNumber(v ?? 0),
    emptyText: 'No saved records yet. Connect, and the page starts recording.',
  });
  const bar = h('div', { class: 'rangebar', id: 'ch-range-bar' });
  const keyHost = h('div', { id: 'ch-range-key' });
  const sub = h('p', { class: 'card__sub', id: 'ch-history-sub' });
  const el = card('History', { id: 'ch-history' }, bar, chart.el, keyHost);
  el.querySelector('.card__head').append(sub);
  const draw = () => {
    const s = getSettings();
    const range = rangeByKey(rangeKey);
    const { firstRecordAt, buckets } = store.series();
    const result = bucketRows({ rangeKey, now: ctx.now(), zone: zoneOf(s), fields: ['clear', 'hit', 'usd'], pre: buckets, firstRecordAt, coverage: true });
    const note = store.state === 'loading' ? 'Opening saved records.' : recordsNote(result, s);
    sub.textContent = `${sentence(range.name)}, ${s.timeZone === 'local' ? 'local time' : 'UTC'}, per ${range.per}`;
    clear(bar).append(rangeControl({ id: 'ch-range', value: rangeKey, onPick: (key) => { rangeKey = key; ctx.setRange('chain', key, { refresh: false }); draw(); } }),
      ...(note ? [h('p', { class: 'rangenote', id: 'ch-range-note', text: result.hasNone && result.firstRecordAt !== null ? `${note} Earlier buckets have no records.` : note })] : []));
    const recordedNote = (r) => `Recorded ${formatNumber(Math.min(r.coverageMinutes, Math.max(r.spanMinutes, 1)))} of ${formatNumber(Math.max(r.spanMinutes, 1))} min · $${compact(r.values.usd)} screened`;
    chart.update(toChartPoints(result, { note: recordedNote }));
    clear(keyHost).append(gapKey({ none: result.hasNone, off: result.hasOff }) ?? '');
  };
  return { el, draw };
}

/** Saved records card: totals, storage state, Export CSV and Clear (confirmed in the page, never with a dialog). */
function savedCard(ctx) {
  const store = ctx.records;
  const notice = h('p', { class: 'savedrec__notice', id: 'ch-saved-notice', role: 'status', hidden: true });
  const facts = h('div', { id: 'ch-saved-facts' });
  const out = h('div', { id: 'ch-saved-out', role: 'status', 'aria-live': 'polite' });
  const actions = h('div', { class: 'btnrow', id: 'ch-saved-actions' });
  let armed = false;
  let timer = null;
  const disarm = () => { armed = false; clearTimeout(timer); draw(); };
  const exportBtn = h('button', { type: 'button', class: 'btn', id: 'ch-saved-export', on: { click: async () => {
    exportBtn.disabled = true;
    try {
      const csv = await store.exportCsv();
      const stamp = isoSeconds(Date.now()).replace(/[-:]/g, '');
      download(`tollgate-saved-records-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
      clear(out).append(h('p', { class: 'field__hint', text: `Exported ${formatNumber(csv.split('\r\n').length - 2)} rows. Times are UTC: block_time to the second, screened_at to the millisecond.` }));
    } catch (error) {
      clear(out).append(h('p', { class: 'field__hint', text: `Could not read the saved records (${error?.message ?? 'error'}).` }));
    } finally { exportBtn.disabled = false; }
  } } }, 'Export CSV');
  function draw() {
    const t = store.summary();
    notice.hidden = !t.notice;
    notice.textContent = t.notice;
    notice.dataset.level = t.noticeKind === 'quota' || t.noticeKind === 'error' ? 'warn' : 'info';
    const first = t.firstRecordAt;
    clear(facts).append(kv([
      ['First record', h('span', { id: 'ch-saved-first', text: first === null ? (store.state === 'loading' ? 'Opening saved records' : 'Nothing recorded yet') : `${formatStamp(first)} ${zoneName()}` })],
      ['Transfers screened', h('span', { id: 'ch-saved-transfers', text: `${formatNumber(t.transfers)} in ${formatNumber(t.blocks)} blocks, ${formatNumber(t.hits)} hit${t.hits === 1 ? '' : 's'}, $${compact(t.usd)}` })],
      ['Minutes recorded', h('span', { id: 'ch-saved-minutes', text: formatNumber(t.minutesRecorded) })],
      ['Full records kept', h('span', { id: 'ch-saved-records', text: `${formatNumber(t.records)} of the latest ${formatNumber(t.maxRecords)}` })],
      ['Kept indefinitely', h('span', { id: 'ch-saved-forever', text: `${formatNumber(t.hitRows)} hit${t.hitRows === 1 ? '' : 's'} with receipts, ${formatNumber(t.freezeRows)} issuer events${t.replayRows ? `, ${formatNumber(t.replayRows)} replayed (not counted as live)` : ''}` })],
      ['Storage', h('span', { id: 'ch-saved-storage', 'data-state': store.state, text: STORAGE_TEXT[store.state] ?? store.state })],
    ]));
    const eraseBtn = h('button', { type: 'button', class: 'btn', id: 'ch-saved-clear', on: { click: () => {
      armed = true;
      clearTimeout(timer);
      timer = setTimeout(disarm, CLEAR_CONFIRM_MS);
      draw();
      document.getElementById('ch-saved-confirm')?.focus();
    } } }, 'Clear saved records');
    const confirmBtn = h('button', { type: 'button', class: 'btn btn--primary', id: 'ch-saved-confirm', on: { click: async () => {
      armed = false;
      clearTimeout(timer);
      const ok = await store.clear();
      clear(out).append(h('p', { class: 'field__hint', text: ok ? 'Saved records erased.' : 'Could not erase everything in browser storage.' }));
      draw();
    } } }, 'Confirm: erase all saved records');
    const cancelBtn = h('button', { type: 'button', class: 'btn', id: 'ch-saved-cancel', on: { click: disarm } }, 'Cancel');
    clear(actions).append(exportBtn, ...(armed ? [confirmBtn, cancelBtn] : [eraseBtn]));
  }
  const el = card('Saved records', { id: 'ch-saved', sub: 'In this browser' }, h('div', { class: 'savedrec' }, notice, facts, actions, out),
    h('p', { class: 'field__hint chainnote chainnote--rec', id: 'ch-record-line', text: RECORDING_LINE }));
  return { el, draw };
}

export function renderChain(ctx, root) {
  const w = ctx.chain;
  clear(root);
  if (!w) { root.append(h('p', { class: 'card__note', text: 'The workspace is still loading.' })); return; }
  if (ctx.autoConnect()) w.start();

  const head = h('div', { class: 'chainhead', id: 'ch-head' });
  const source = h('p', { class: 'demo-line', id: 'ch-source' });
  const kpiHost = h('div', {});
  const charts = perBlockCharts(w);
  const tableHost = h('div', { id: 'ch-table-host' });
  let transfersCard = null;
  const freezeHost = h('div', { id: 'ch-freeze-host' });
  const replayOut = h('div', { id: 'ch-replay-out', role: 'status', 'aria-live': 'polite' });
  const verifyOut = h('div', { id: 'ch-verify-out', role: 'status', 'aria-live': 'polite' });

  const toggle = h('button', { type: 'button', class: 'btn btn--primary', id: 'ch-toggle', on: { click: () => { if (w.running) w.stop(); else w.start(); } } });
  const verifyBtn = h('button', { type: 'button', class: 'btn', id: 'ch-verify', on: { click: async () => {
    if (!w.ledger.size) { clear(verifyOut).append(h('p', { class: 'field__hint', text: 'Nothing signed yet.' })); return; }
    const r = await w.verify();
    clear(verifyOut).append(h('div', { class: 'banner', 'data-state': r.ok ? 'pass' : 'fail' }, h('span', { class: 'banner__lead', text: r.ok ? 'Window verifies' : 'Window failed' }),
      h('span', { class: 'banner__detail', text: `${w.ledger.size} receipts in ${r.segments.length} segments.` })));
  } } }, 'Verify receipts');
  const replayBtn = h('button', { type: 'button', class: 'btn', id: 'ch-replay', on: { click: async () => {
    replayBtn.disabled = true;
    clear(replayOut).append(h('p', { class: 'field__hint', text: `Fetching block ${formatNumber(REPLAY.block)} from the chain.` }));
    try {
      const r = await w.replay();
      clear(replayOut).append(h('div', { class: 'banner', 'data-state': 'fail' }, h('span', { class: 'banner__lead', text: 'Historical hit' }),
        h('span', { class: 'banner__detail', text: `${amountText(r)} to ${shortAddr(r.to)} (${r.toMatches[0]?.name ?? 'on the list'}) in block ${formatNumber(r.block)}, ${formatStamp(new Date(r.t).toISOString()).slice(0, 10)}. Read from ${r.endpoint} just now and signed as a historical replay. Not a live transfer.` }),
        h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openChainReceipt(r) } }, r.receiptId.replace('rcpt:', ''))));
    } catch (error) {
      clear(replayOut).append(h('div', { class: 'banner', 'data-state': 'unsupported' }, h('span', { class: 'banner__lead', text: 'Could not fetch the historical transfer' }), h('span', { class: 'banner__detail', text: error?.message ?? 'error' })));
    } finally { replayBtn.disabled = false; }
  } } }, 'Replay a known sanctioned address (historical)');

  const history = historyCard(ctx);
  const saved = savedCard(ctx);
  const draw = () => {
    history.draw();
    saved.draw();
    clear(head).append(statusChip(w), h('span', { class: 'chainhead__label', text: chainLabel(ctx) }));
    head.title = w.message;
    source.textContent = `Your browser reads public blockchain data from ${w.endpoint.host}${w.endpointIndex ? ` (fallback for ${ENDPOINTS[0].host})` : ''}.${w.state === 'retrying' || w.state === 'error' ? ` ${w.message}.` : ''}`;
    toggle.textContent = w.running ? 'Disconnect' : 'Connect';
    clear(kpiHost).append(kpis(w));
    charts.update();
    // Replayed historical rows stay pinned on top; live rows follow, newest first.
    // Zero-value transfers are almost always address-poisoning spam: still screened and signed, but kept out of the table.
    const valued = w.transfers.filter((r) => Number(r.amount) > 0);
    const zeroCount = w.transfers.length - valued.length;
    const rows = [...w.replayed.slice().reverse(), ...valued.slice(-TABLE_ROWS).sort((a, b) => b.block - a.block || b.logIndex - a.logIndex)];
    transfersCard?.querySelector('.card__sub')?.replaceChildren(zeroCount ? `Newest first · ${zeroCount} zero-value transfers hidden (usually spam), still screened` : 'Newest first');
    clear(tableHost).append(rows.length ? transferTable(ctx, rows) : h('p', { class: 'tape__empty', id: 'ch-empty', text: w.state === 'error' ? 'No transfers: the node cannot be reached.' : w.running ? 'Waiting for the next block.' : 'Not connected. Press Connect.' }));
    clear(freezeHost).append(freezeTable(ctx, w));
  };

  root.append(
    head, source,
    h('div', { class: 'livebar', role: 'group', 'aria-label': 'Chain controls' }, toggle, verifyBtn, replayBtn),
    verifyOut, replayOut, kpiHost,
    h('div', { class: 'cols cols--charts' },
      card('Transfers screened per block', { id: 'ch-c1', sub: 'USDC and USDT' }, charts.transfers.el),
      card('Value screened per block', { id: 'ch-c2', sub: 'USD' }, charts.usd.el)),
    history.el,
    (transfersCard = card('Transfers', { id: 'ch-transfers', sub: 'Newest first' }, tableHost)),
    card('Issuer freezes', { id: 'ch-freeze', sub: 'USDC Blacklisted and USDT AddedBlackList events' }, freezeHost,
      h('p', { class: 'field__hint chainnote', text: 'A freeze has a block time. Public data does not show when the issuer acted on a listing; see Proof gap.' })),
    saved.el);
  draw();
  // Anchored on `head` (replaced with the view), so a left-behind view stops redrawing.
  follow(w, head, draw);
  const offStore = ctx.records.subscribe(() => { if (!head.isConnected) offStore(); else { history.draw(); saved.draw(); } });
}

/** Dashboard hero: the live chain in one card. */
export function chainHero(ctx) {
  const w = ctx.chain;
  const host = h('section', { class: 'card chainhero', id: 'dash-chain', 'aria-labelledby': 'dash-chain-h' });
  if (!w) return host;
  if (ctx.autoConnect()) w.start();
  const charts = perBlockCharts(w, { height: 120, compactView: true });
  const stats = h('div', { class: 'chainhero__stats' });
  const head = h('div', { class: 'card__head' });
  const draw = () => {
    clear(head).append(h('h2', { class: 'card__title', id: 'dash-chain-h', text: 'Live chain' }), statusChip(w),
      h('a', { href: '#chain', class: 'chainhero__open', on: { click: () => ctx.setParams('chain', {}) } }, 'Open'));
    const t = w.totals;
    clear(stats).append(
      h('p', { class: 'chainhead__label', text: chainLabel(ctx) }),
      h('dl', { class: 'chainhero__nums' },
        h('div', {}, h('dt', { text: 'Transfers screened' }), h('dd', { id: 'dash-chain-n', text: formatNumber(t.transfers) })),
        h('div', {}, h('dt', { text: 'Hits on the list' }), h('dd', { id: 'dash-chain-hits', text: `${formatNumber(t.hits)} in ${formatNumber(t.transfers)}` })),
        h('div', {}, h('dt', { text: 'Value screened' }), h('dd', { text: `$${compact(t.usd)}` })),
        h('div', {}, h('dt', { text: 'Issuer freezes' }), h('dd', { text: formatNumber(w.freezes.filter((f) => f.kind === 'freeze').length) }))),
      h('p', { class: 'demo-line', text: w.state === 'error' || w.state === 'retrying' ? w.message : `Your browser reads public blockchain data from ${w.endpoint.host}.` }));
    charts.update();
  };
  host.append(head, h('div', { class: 'chainhero__body' }, stats, charts.transfers.el));
  draw();
  follow(w, host, draw);
  return host;
}
