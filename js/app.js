/**
 * Application behaviour for the receipts demo. The text in the raw editor is the only source of
 * truth: every view is drawn from it, and every verification result comes from verifier.js.
 * Everything shown from the file goes through textContent, because the file is user input once it
 * has been edited by hand. Nothing here decides pass or fail.
 */
import { SAMPLE_PUBLIC_KEY, ed25519Available, signedReason, verifyText } from './verifier.js';
import { initStart } from './start.js';
import { contextFragment } from './forms.js';

const SAMPLE_URL = 'data/sample_receipts.json';
const SAMPLE_LIST_DATE = 'Aug 2023';
const BASE_LABELS = { sample: 'Sample', yours: 'Your receipts', file: 'Opened file' };
const GENESIS = '0'.repeat(64);
const ROUTES = { start: 'Get started', receipts: 'Receipts', raw: 'Raw receipts', about: 'How it runs' };
const OVERLAY_PANEL_QUERY = '(max-width: 1199px)';
const COPIED_MS = 1200;
const HASH_PREFIX = 12;
const NODE_PREFIX = 8;
const MAX_FLATTEN_DEPTH = 8;
const JSON_WRAP_INDENT = 2;

const CHECK_GROUPS = [
  {
    name: 'Signature',
    checks: [
      { id: 'signature', label: 'Ed25519 signature matches the signed decision' },
      { id: 'signer', label: 'Signer key is the sample key' },
    ],
  },
  {
    name: 'Decision',
    checks: [
      { id: 'binding', label: 'Payment details match action_digest in the signed decision' },
      { id: 'labels', label: 'Receipt labels match the signed decision' },
    ],
  },
  {
    name: 'Chain link',
    checks: [
      { id: 'hash', label: 'this_hash matches the receipt contents' },
      { id: 'chain', label: 'prev_hash and seq link to the receipt before' },
    ],
  },
];
const CHECK_NAMES = { signature: 'signature', signer: 'signer', binding: 'payment details', labels: 'labels', hash: 'this_hash', chain: 'chain link' };
const PASS_NOTE = 'This ran in your browser and sent nothing anywhere. It shows these receipts are unchanged since they were signed. It does not re-run the screening or show that the list was complete.';

const ICONS = {
  list: 'M3 4.5h10M3 8h10M3 11.5h10',
  code: 'M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5',
  info: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 7.5V11M8 5v.5',
  scale: 'M8 2.5v11M5 13.5h6M3 4.5h10M3 4.5 1.5 9h3L3 4.5ZM13 4.5 11.5 9h3L13 4.5Z',
  play: 'M5 3.5v9l7-4.5-7-4.5Z',
  close: 'M4 4l8 8M12 4l-8 8',
  copy: 'M6 6h7v7H6zM3 10V3h7',
  check: 'M3 8.5 6.5 12 13 4.5',
  cross: 'M4 4l8 8M12 4l-8 8',
  flag: 'M4 14V2.5M4 3h8l-2 3 2 3H4',
  alert: 'M8 2.5 14.5 13.5h-13L8 2.5ZM8 6.5v3.5M8 11.5v.5',
  dash: 'M4 8h8',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
};

const $ = (id) => document.getElementById(id);
const verifyButton = $('tg-verify');
const tamperButton = $('tg-tamper');
const scenarioSelect = $('tg-scenario');
const restoreButton = $('tg-restore');
const useSampleButton = $('tg-use-sample');
const editLink = $('tg-edit');
const resultBox = $('tg-result');
const fileBox = $('tg-file');
const panel = $('tg-panel');
const limits = $('tg-limits');

/** The Outcome of the last finished run, or a local status. Any change to the text clears it. */
const state = {
  phase: 'loading', // loading | ready | load-error
  sampleText: '',
  sampleReceipts: [],
  // The file Restore and Simulate tampering start from: the sample, or receipts made on this page.
  baseText: '',
  baseReceipts: [],
  baseKind: 'sample', // sample | yours | file
  baseListDate: SAMPLE_LIST_DATE,
  outcome: null,
  totalMs: 0,
  busy: false,
  note: null,
  noCrypto: false,
  selected: null,
  filter: 'all',
  tab: 'fields',
  route: 'receipts',
  latestRun: 0,
};

/** Builds an element with optional class, text, attributes and children. */
function el(tag, { cls, text, attrs, kids } = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  if (kids) node.append(...kids.filter(Boolean));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

/** String() can throw on hand-edited JSON such as {"toString": 1}, so objects go through JSON. */
function asText(value) {
  if (value === null || value === undefined) return 'missing';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function prefix(value, length = HASH_PREFIX) {
  const text = asText(value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Keeps both ends of an address readable, which is how people compare them. */
function maskMiddle(value) {
  const text = asText(value);
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function formatMs(ms) {
  return ms < 0.1 ? '<0.1 ms' : `${ms.toFixed(1)} ms`;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Tolerant display parse. Returns null when the text cannot be drawn as receipts. */
function parseFile(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) && Array.isArray(parsed.receipts) ? parsed : null;
  } catch {
    return null;
  }
}

function toRow(receipt) {
  const action = isObject(receipt?.action) ? receipt.action : {};
  const params = isObject(action.params) ? action.params : {};
  const verdict = isObject(receipt?.verdict) ? receipt.verdict : {};
  return {
    seq: asText(receipt?.seq),
    time: asText(action.requested_at).replace('T', ' ').replace('Z', ''),
    address: asText(params.beneficiary_address),
    outcome: asText(params.outcome),
    amount: typeof params.amount_usd === 'number' ? `$${params.amount_usd.toLocaleString('en-US')}` : prefix(params.amount_usd),
    version: signedReason(verdict, 'rulebook_version') ?? 'missing',
    hash: asText(receipt?.this_hash),
    prevHash: asText(receipt?.prev_hash),
    id: asText(receipt?.receipt_id),
  };
}

/** Flattens a value into [path, leaf] pairs so that every field, including added ones, is shown. */
function flatten(value, path = '', depth = 0, out = []) {
  const nested = (Array.isArray(value) && value.length > 0) || (isObject(value) && Object.keys(value).length > 0);
  if (!nested || depth >= MAX_FLATTEN_DEPTH) {
    out.push([path, value]);
    return out;
  }
  if (Array.isArray(value)) value.forEach((item, i) => flatten(item, `${path}[${i}]`, depth + 1, out));
  else Object.entries(value).forEach(([key, item]) => flatten(item, path ? `${path}.${key}` : key, depth + 1, out));
  return out;
}

/** Fields that differ from the published sample, for display only. The verifier never reads this. */
function sampleDifferences(receipt, index) {
  const original = state.baseReceipts[index];
  if (original === undefined) return new Map();
  const before = new Map(flatten(original));
  const differences = new Map();
  flatten(receipt).forEach(([path, value]) => {
    if (!before.has(path) || asText(before.get(path)) !== asText(value)) differences.set(path, before.has(path) ? before.get(path) : undefined);
  });
  return differences;
}

/** Index used by a scenario: its usual receipt, or the last one in a shorter file. */
function pick(count, wanted) {
  return Math.min(wanted, count - 1);
}

const SCENARIOS = [
  {
    id: 'fingerprint',
    label: (count) => `List fingerprint, seq ${pick(count, 0)}`,
    apply(copy) {
      const i = pick(copy.receipts.length, 0);
      const reasons = copy.receipts[i].verdict.reasons;
      const at = reasons.findIndex((reason) => reason.startsWith('list_snapshot='));
      const before = reasons[at].slice('list_snapshot='.length);
      const after = (before[0] === '3' ? '4' : '3') + before.slice(1);
      reasons[at] = `list_snapshot=${after}`;
      return `Simulated: changed one character in receipt #${i}. Its list fingerprint now starts ${after.slice(0, 8)} instead of ${before.slice(0, 8)}, as if a different list had been checked.`;
    },
  },
  {
    id: 'amount',
    label: (count) => `Payment amount, seq ${pick(count, 1)}`,
    apply(copy) {
      const i = pick(copy.receipts.length, 1);
      const params = copy.receipts[i].action.params;
      const before = params.amount_usd;
      if (typeof before !== 'number') {
        params.amount_usd = 9000;
        return `Simulated: added amount_usd 9000 to receipt #${i}, which was signed without an amount.`;
      }
      params.amount_usd = before + 8000;
      return `Simulated: changed amount_usd in receipt #${i} from ${before} to ${params.amount_usd}.`;
    },
  },
  {
    id: 'outcome',
    label: (count) => `Flip the outcome, seq ${pick(count, 2)}`,
    apply(copy) {
      const i = pick(copy.receipts.length, 2);
      const params = copy.receipts[i].action.params;
      const before = params.outcome;
      params.outcome = before === 'BLOCK' ? 'ALLOW' : 'BLOCK';
      return `Simulated: changed outcome in receipt #${i} from ${before} to ${params.outcome} in the payment details.`;
    },
  },
  {
    id: 'signature',
    label: (count) => `One signature digit, seq ${pick(count, 1)}`,
    apply(copy) {
      const i = pick(copy.receipts.length, 1);
      const verdict = copy.receipts[i].verdict;
      const flipped = verdict.signature[0] === 'a' ? 'b' : 'a';
      verdict.signature = flipped + verdict.signature.slice(1);
      return `Simulated: changed the first digit of the signature in receipt #${i} to ${flipped}.`;
    },
  },
  {
    id: 'drop',
    minimum: 2,
    label: () => 'Drop the last receipt',
    apply(copy) {
      const dropped = copy.receipts.pop();
      return `Simulated: removed receipt #${dropped.seq}. This check still passes, because nothing in the remaining receipts points forward. Without a seal, a file missing its last receipt looks complete.`;
    },
  },
];

function renderScenarios() {
  const count = state.baseReceipts.length;
  const keep = scenarioSelect.value;
  const usable = SCENARIOS.filter(({ minimum = 1 }) => count >= minimum);
  scenarioSelect.replaceChildren(...usable.map(({ id, label }) => el('option', { text: label(count), attrs: { value: id } })));
  if (usable.some(({ id }) => id === keep)) scenarioSelect.value = keep;
}

/** Makes a file the one Restore and Simulate tampering start from, and shows it. */
function setBase(text, kind, listDate, note = null) {
  state.baseText = text;
  state.baseReceipts = JSON.parse(text).receipts;
  state.baseKind = kind;
  state.baseListDate = listDate;
  renderScenarios();
  change(text, note);
}

/* Shared pieces */

function chip(text, tone, iconName) {
  return el('span', { cls: `chip chip--${tone}`, kids: [iconName && icon(iconName), el('span', { text })] });
}

function decisionChip(outcome) {
  const known = outcome === 'BLOCK' || outcome === 'ALLOW';
  return el('span', { cls: `decision decision--${known ? outcome.toLowerCase() : 'other'}`, text: prefix(outcome, 12), attrs: { title: outcome } });
}

/** Copies through the clipboard API, with a fallback for pages served over plain HTTP. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = el('textarea', { attrs: { 'aria-hidden': 'true', class: 'sr' } });
    scratch.value = text;
    const returnTo = document.activeElement;
    (limits.open ? limits : document.body).append(scratch);
    scratch.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    scratch.remove();
    returnTo?.focus?.();
    return copied;
  }
}

function copyButton(text, what) {
  const label = `Copy ${what}`;
  const button = el('button', { cls: 'iconbtn iconbtn--copy', attrs: { type: 'button', 'aria-label': label, title: label } });
  button.append(icon('copy'));
  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    const copied = await copyText(text);
    button.replaceChildren(icon(copied ? 'check' : 'cross'));
    button.dataset.copied = String(copied);
    button.setAttribute('aria-label', copied ? 'Copied' : 'Copy failed');
    setTimeout(() => {
      button.replaceChildren(icon('copy'));
      delete button.dataset.copied;
      button.setAttribute('aria-label', label);
    }, COPIED_MS);
  });
  return button;
}

function resultsList() {
  const outcome = state.outcome;
  return outcome && 'receipts' in outcome ? outcome.receipts : null;
}

/* Top bar */

function renderTop() {
  const file = parseFile(fileBox.value);
  const unreadable = state.phase === 'ready' && !file ? 'Unreadable' : null;
  const loading = state.phase === 'loading' ? 'Loading' : null;
  const failedLoad = state.phase === 'load-error' ? 'Not loaded' : null;
  const fallback = loading ?? failedLoad ?? unreadable;
  const version = fallback ?? asText(file.rulebook_version);
  const print = fallback ?? prefix(file.list_snapshot);
  const baseFile = parseFile(state.baseText);
  const sameList = file && baseFile && file.list_snapshot === baseFile.list_snapshot;
  $('tg-meta-version').textContent = version;
  $('tg-meta-print').textContent = print;
  $('tg-meta-print').title = fallback ? '' : asText(file.list_snapshot);
  $('tg-meta-date').textContent = fallback ?? (sameList ? state.baseListDate ?? 'Not known' : 'Not known');
  $('tg-meta-file').textContent = state.phase !== 'ready' ? fallback : fileBox.value === state.baseText ? `${BASE_LABELS[state.baseKind]}, unchanged` : 'Modified';
  $('tg-meta-file').dataset.modified = String(state.phase === 'ready' && fileBox.value !== state.baseText);
  $('tg-chip').replaceChildren(statusChip());
}

function statusChip() {
  if (state.phase === 'loading') return chip('Loading', 'neutral');
  if (state.phase === 'load-error') return chip('Sample not loaded', 'warn', 'alert');
  if (state.busy) return chip('Checking', 'neutral');
  if (state.noCrypto) return chip('Ed25519 unavailable', 'warn', 'alert');
  const outcome = state.outcome;
  if (!outcome) return chip('Not run', 'neutral', 'dash');
  if (outcome.kind === 'pass') return chip(`Verified ${outcome.receipts.length} of ${outcome.receipts.length}`, 'good', 'check');
  if (outcome.kind === 'fail') {
    const failing = outcome.receipts.filter((receipt) => receipt.failed.length > 0).length;
    return chip(`Failed ${failing} of ${outcome.receipts.length}`, 'bad', 'cross');
  }
  if (outcome.kind === 'unreadable') return chip('Failed: unreadable', 'bad', 'cross');
  return chip('Nothing verified', 'warn', 'alert');
}

/* Result banner */

function renderBanner() {
  const outcome = state.outcome;
  let bannerState = 'idle';
  const nodes = [];
  const seeChecks = () => {
    const button = el('button', { cls: 'linkbtn', text: 'See every check', attrs: { type: 'button' } });
    button.addEventListener('click', () => {
      location.hash = 'receipts';
      setRoute('receipts');
      $('tg-checks-card').scrollIntoView({ block: 'start' });
      $('tg-checks-head').focus({ preventScroll: true });
    });
    return button;
  };
  if (state.phase === 'loading') {
    bannerState = 'loading';
    nodes.push(el('p', { cls: 'banner__lead', text: 'Loading the sample receipts.' }));
  } else if (state.phase === 'load-error') {
    bannerState = 'crashed';
    const reload = el('button', { cls: 'linkbtn', text: 'Reload the page', attrs: { type: 'button' } });
    reload.addEventListener('click', () => location.reload());
    nodes.push(el('p', { cls: 'banner__lead', kids: [icon('alert'), el('span', { text: 'The sample receipts did not load, so nothing was verified.' })] }), reload);
  } else if (state.busy) {
    bannerState = 'loading';
    nodes.push(el('p', { cls: 'banner__lead', text: 'Checking the receipts in this browser.' }));
  } else if (state.noCrypto && (!outcome || outcome.kind === 'unsupported')) {
    bannerState = 'unsupported';
    nodes.push(
      el('p', { cls: 'banner__lead', kids: [icon('alert'), el('span', { text: 'This browser cannot run the check, so nothing was verified.' })] }),
      el('p', { cls: 'banner__detail', text: 'It has no built-in support for Ed25519 signatures. A current version of Chrome, Safari or Firefox has it, on a page served over HTTPS or from localhost.' }),
    );
  } else if (!outcome) {
    nodes.push(el('p', { cls: 'banner__lead', text: state.note ?? 'Not checked yet. Press Verify chain to run the check in this browser.' }));
  } else if (outcome.kind === 'pass') {
    bannerState = 'pass';
    const total = outcome.receipts.reduce((sum, receipt) => sum + receipt.checks.length, 0);
    nodes.push(
      el('p', { cls: 'banner__lead', kids: [icon('check'), el('span', { text: outcome.receipts.length === 1 ? 'Verified. The receipt checks out.' : `Verified. All ${outcome.receipts.length} receipts check out.` })] }),
      el('p', { cls: 'banner__detail mono', text: `${total} checks in ${formatMs(state.totalMs)}, in this browser` }),
    );
    nodes.push(seeChecks());
    if (state.note) {
      bannerState = 'caveat';
      nodes.push(el('p', { cls: 'banner__note', text: state.note }));
    }
  } else if (outcome.kind === 'fail') {
    bannerState = 'fail';
    const failing = outcome.receipts.filter((receipt) => receipt.failed.length > 0);
    const first = failing[0];
    const detail = first
      ? `${failing.length} of ${outcome.receipts.length} receipts fail. First failure: #${first.index}, ${first.failed.map(({ id }) => CHECK_NAMES[id]).join(', ')}.`
      : outcome.fileProblems[0];
    nodes.push(el('p', { cls: 'banner__lead', kids: [icon('cross'), el('span', { text: 'Verification failed.' })] }), el('p', { cls: 'banner__detail', text: detail }));
    nodes.push(seeChecks());
    if (state.note) nodes.push(el('p', { cls: 'banner__note', text: state.note }));
  } else if (outcome.kind === 'unreadable') {
    bannerState = 'fail';
    nodes.push(
      el('p', { cls: 'banner__lead', kids: [icon('cross'), el('span', { text: 'Verification failed. This file cannot be read.' })] }),
      ...outcome.problems.slice(0, 4).map((problem) => el('p', { cls: 'banner__detail', text: problem })),
    );
  } else {
    bannerState = 'crashed';
    nodes.push(el('p', { cls: 'banner__lead', kids: [icon('alert'), el('span', { text: 'Something went wrong while checking, so nothing was verified. Try reloading the page.' })] }));
  }
  resultBox.dataset.state = bannerState;
  resultBox.replaceChildren(...nodes);
}

/* Receipts table */

const COLUMNS = [
  { key: 'seq', label: 'Seq' },
  { key: 'time', label: 'Time (UTC)' },
  { key: 'address', label: 'Address' },
  { key: 'decision', label: 'Decision' },
  { key: 'amount', label: 'Amount', numeric: true },
  { key: 'version', label: 'List version' },
  { key: 'hash', label: 'Hash' },
  { key: 'status', label: 'Verification' },
];

function verificationCell(index) {
  const results = resultsList();
  const result = results?.find((candidate) => candidate.index === index);
  if (result) {
    if (result.failed.length === 0) return chip('Passed', 'good', 'check');
    return el('span', {
      cls: 'rowfail',
      kids: [chip('Failed', 'bad', 'cross'), el('span', { cls: 'rowfail__checks', text: result.failed.map(({ id }) => CHECK_NAMES[id]).join(', ') })],
    });
  }
  if (state.outcome && state.outcome.kind !== 'pass') return el('span', { cls: 'muted', text: 'Not checked' });
  return el('span', { cls: 'muted', text: state.busy ? 'Checking' : 'Not run' });
}

function renderFilter(receipts) {
  const box = $('tg-filter');
  if (!receipts || receipts.length === 0) {
    box.replaceChildren();
    return;
  }
  const count = (outcome) => receipts.filter((receipt) => toRow(receipt).outcome === outcome).length;
  const options = [
    ['all', 'All', receipts.length],
    ['BLOCK', 'BLOCK', count('BLOCK')],
    ['ALLOW', 'ALLOW', count('ALLOW')],
  ];
  box.replaceChildren(
    ...options.map(([id, label, total]) => {
      const button = el('button', {
        cls: 'seg__btn',
        attrs: { type: 'button', 'aria-pressed': String(state.filter === id) },
        kids: [el('span', { text: label }), el('span', { cls: 'seg__count', text: String(total) })],
      });
      button.addEventListener('click', () => {
        state.filter = id;
        const refocus = id;
        renderFilter(parseFile(fileBox.value)?.receipts ?? null);
        renderTable();
        [...box.children][options.findIndex(([optionId]) => optionId === refocus)]?.focus();
      });
      return button;
    }),
  );
}

function tableMessage(title, detail, action) {
  return el('div', { cls: 'empty', kids: [el('p', { cls: 'empty__title', text: title }), detail && el('p', { cls: 'empty__detail', text: detail }), action] });
}

function restoreAction() {
  const button = el('button', { cls: 'btn', text: state.baseKind === 'sample' ? 'Restore sample' : 'Restore original', attrs: { type: 'button' } });
  button.addEventListener('click', () => change(state.baseText, null));
  return button;
}

function renderTable() {
  const wrap = $('tg-tablewrap');
  const foot = $('tg-table-foot');
  foot.replaceChildren();
  if (state.phase === 'loading') {
    wrap.replaceChildren(el('div', { cls: 'skeleton', attrs: { 'aria-hidden': 'true' }, kids: [0, 1, 2].map(() => el('div', { cls: 'skeleton__row' })) }));
    return;
  }
  if (state.phase === 'load-error') {
    wrap.replaceChildren(tableMessage('No receipts to show', 'The sample file did not load.'));
    return;
  }
  const file = parseFile(fileBox.value);
  if (!file) {
    wrap.replaceChildren(tableMessage('This text cannot be shown as receipts until it is valid again.', 'Fix it in Raw receipts, or go back to the sample.', restoreAction()));
    return;
  }
  if (file.receipts.length === 0) {
    wrap.replaceChildren(tableMessage('This file has no receipts in it.', 'Add receipts in Raw receipts, or go back to the sample.', restoreAction()));
    return;
  }
  const entries = file.receipts.map((receipt, index) => ({ receipt, index, row: toRow(receipt) }));
  const visible = entries.filter(({ row }) => state.filter === 'all' || row.outcome === state.filter);
  if (visible.length === 0) {
    const showAll = el('button', { cls: 'btn', text: 'Show all receipts', attrs: { type: 'button' } });
    showAll.addEventListener('click', () => {
      state.filter = 'all';
      renderFilter(file.receipts);
      renderTable();
    });
    wrap.replaceChildren(tableMessage(`No ${state.filter} receipts in this file.`, null, showAll));
  } else {
    wrap.replaceChildren(buildTable(visible));
  }
  const last = entries[entries.length - 1].row;
  foot.append(
    el('span', { text: `Showing ${visible.length} of ${entries.length}` }),
    el('span', { cls: 'card__foot-hash', kids: [el('span', { text: 'Chain head' }), el('code', { cls: 'mono', text: prefix(last.hash), attrs: { title: last.hash } }), copyButton(last.hash, 'chain head hash')] }),
  );
}

function buildTable(entries) {
  const results = resultsList();
  const table = el('table', { cls: 'grid', attrs: { role: 'table', 'aria-label': 'Receipts' } });
  table.append(
    el('thead', {
      attrs: { role: 'rowgroup' },
      kids: [
        el('tr', {
          attrs: { role: 'row' },
          kids: COLUMNS.map((column) => el('th', { cls: `col-${column.key}${column.numeric ? ' num' : ''}`, text: column.label, attrs: { scope: 'col', role: 'columnheader' } })),
        }),
      ],
    }),
  );
  const body = el('tbody', { attrs: { role: 'rowgroup' } });
  entries.forEach(({ receipt, index, row }) => {
    const result = results?.find((candidate) => candidate.index === index);
    const changed = sampleDifferences(receipt, index);
    const changedKey = (test) => [...changed.keys()].some(test);
    const tr = el('tr', {
      cls: 'grid__row',
      attrs: { role: 'row', 'data-index': String(index), 'data-failed': String(Boolean(result && result.failed.length > 0)), 'data-selected': String(state.selected === index) },
    });
    const open = el('button', { cls: 'rowlink mono', text: `#${row.seq}`, attrs: { type: 'button', 'aria-label': `Open receipt ${row.seq}`, 'aria-current': String(state.selected === index) } });
    const cells = {
      seq: open,
      time: el('span', { cls: 'mono', text: row.time, attrs: { 'data-changed': String(changedKey((key) => key.endsWith('requested_at'))) } }),
      address: el('span', {
        cls: 'addr',
        kids: [el('code', { cls: 'mono', text: maskMiddle(row.address), attrs: { title: row.address, 'data-changed': String(changedKey((key) => key.endsWith('beneficiary_address'))) } }), copyButton(row.address, `address of receipt ${row.seq}`)],
      }),
      decision: el('span', { kids: [decisionChip(row.outcome)], attrs: { 'data-changed': String(changedKey((key) => key.endsWith('params.outcome'))) } }),
      amount: el('span', { cls: 'mono', text: row.amount, attrs: { 'data-changed': String(changedKey((key) => key.endsWith('amount_usd'))) } }),
      version: el('span', { cls: 'mono clip', text: row.version, attrs: { title: row.version } }),
      hash: el('span', { cls: 'mono', text: prefix(row.hash), attrs: { title: row.hash } }),
      status: verificationCell(index),
    };
    COLUMNS.forEach((column) => {
      tr.append(el('td', { cls: `col-${column.key}${column.numeric ? ' num' : ''}`, attrs: { role: 'cell', 'data-label': column.label }, kids: [cells[column.key]] }));
    });
    tr.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('.iconbtn')) return;
      select(index);
    });
    open.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const links = [...body.querySelectorAll('.rowlink')];
      links[links.indexOf(open) + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    });
    body.append(tr);
  });
  table.append(body);
  return table;
}

function markSelection() {
  document.querySelectorAll('.grid__row').forEach((row) => {
    const on = Number(row.dataset.index) === state.selected;
    row.dataset.selected = String(on);
    row.querySelector('.rowlink')?.setAttribute('aria-current', String(on));
  });
  document.querySelectorAll('.node--receipt').forEach((node) => {
    node.dataset.selected = String(Number(node.dataset.index) === state.selected);
  });
}

function select(index) {
  state.selected = index;
  markSelection();
  renderPanel();
  if (window.matchMedia(OVERLAY_PANEL_QUERY).matches) $('tg-panel-close')?.focus();
}

function closePanel() {
  const index = state.selected;
  state.selected = null;
  markSelection();
  renderPanel();
  document.querySelector(`.grid__row[data-index="${index}"] .rowlink`)?.focus();
}

/* Chain diagram */

function nodeLine(label, value, tone) {
  return el('span', { cls: `node__line${tone ? ` node__line--${tone}` : ''}`, kids: [el('span', { cls: 'node__key', text: label }), el('span', { cls: 'mono', text: prefix(value, NODE_PREFIX), attrs: { title: asText(value) } })] });
}

function chainLink(result, row, ran) {
  if (!ran) return el('div', { cls: 'link', attrs: { 'data-state': 'idle' }, kids: [el('span', { cls: 'link__line' }), el('span', { cls: 'link__text', text: 'not run' })] });
  const chainFailed = result?.failed.some(({ id }) => id === 'chain');
  if (!result) return el('div', { cls: 'link', attrs: { 'data-state': 'idle' }, kids: [el('span', { cls: 'link__line' }), el('span', { cls: 'link__text', text: 'not checked' })] });
  const title = chainFailed
    ? `prev_hash ${row.prevHash} does not match the hash computed for the receipt before, ${result.expectedPrev}, or seq is out of place`
    : `prev_hash ${row.prevHash} matches the hash computed for the receipt before`;
  return el('div', {
    cls: 'link',
    attrs: { 'data-state': chainFailed ? 'broken' : 'ok', title },
    kids: [el('span', { cls: 'link__line' }), el('span', { cls: 'link__text', text: chainFailed ? 'broken' : 'linked' })],
  });
}

function renderChain() {
  const box = $('tg-chain');
  const sub = $('tg-chain-sub');
  const file = state.phase === 'ready' ? parseFile(fileBox.value) : null;
  if (!file || file.receipts.length === 0) {
    sub.textContent = '';
    box.replaceChildren(el('p', { cls: 'empty__detail chain__empty', text: state.phase === 'loading' ? 'Loading.' : 'No receipts to draw.' }));
    return;
  }
  const results = resultsList();
  const ran = Boolean(results);
  sub.textContent = ran ? 'Drawn from this file and the hashes computed in the last run.' : 'Drawn from this file. Links are judged when the check runs.';
  const nodes = [el('div', { cls: 'node node--genesis', kids: [el('span', { cls: 'node__head', kids: [el('span', { cls: 'node__seq', text: 'Genesis' })] }), el('span', { cls: 'mono', text: prefix(GENESIS, NODE_PREFIX), attrs: { title: GENESIS } })] })];
  file.receipts.forEach((receipt, index) => {
    const row = toRow(receipt);
    const result = results?.find((candidate) => candidate.index === index);
    const hashFailed = result?.failed.some(({ id }) => id === 'hash');
    const failed = Boolean(result && result.failed.length > 0);
    nodes.push(chainLink(result, row, ran));
    const node = el('button', {
      cls: 'node node--receipt',
      attrs: { type: 'button', 'data-index': String(index), 'data-failed': String(failed), 'data-passed': String(Boolean(result) && !failed), 'data-selected': String(state.selected === index), 'aria-label': `Receipt ${row.seq}: ${failed ? 'failed' : result ? 'passed' : 'not checked'}. Open detail.` },
      kids: [
        el('span', { cls: 'node__head', kids: [el('span', { cls: 'node__seq mono', text: `#${row.seq}` }), decisionChip(row.outcome), result && el('span', { cls: `node__mark node__mark--${failed ? 'bad' : 'good'}`, kids: [icon(failed ? 'cross' : 'check')] })] }),
        nodeLine('prev', row.prevHash, result?.failed.some(({ id }) => id === 'chain') ? 'bad' : null),
        nodeLine('this', row.hash, hashFailed ? 'bad' : null),
        hashFailed && nodeLine('computed', result.computedHash, 'bad'),
      ],
    });
    node.addEventListener('click', () => select(index));
    nodes.push(node);
  });
  box.replaceChildren(...nodes);
}

/* Verification run */

function matrixCell(result, id) {
  const check = result?.checks?.find((candidate) => candidate.id === id);
  if (!check) return el('td', { cls: 'matrix__cell', attrs: { 'data-state': 'idle' }, kids: [el('span', { cls: 'muted matrix__idle', attrs: { role: 'img', 'aria-label': 'Not run', title: 'Not run' }, kids: [icon('dash')] })] });
  return el('td', {
    cls: 'matrix__cell',
    attrs: { 'data-state': check.ok ? 'pass' : 'fail' },
    kids: [el('span', { cls: 'matrix__mark', kids: [icon(check.ok ? 'check' : 'cross'), el('span', { text: check.ok ? 'Pass' : 'Fail' })] }), el('span', { cls: 'matrix__ms mono', text: formatMs(check.ms) })],
  });
}

function renderChecks() {
  const box = $('tg-checks');
  const sub = $('tg-checks-sub');
  const outcome = state.outcome;
  if (state.phase !== 'ready') {
    sub.textContent = '';
    box.replaceChildren(el('p', { cls: 'empty__detail chain__empty', text: state.phase === 'loading' ? 'Loading.' : 'No run. The sample file did not load.' }));
    return;
  }
  if (outcome && !('receipts' in outcome)) {
    sub.textContent = 'No check results';
    const message = outcome.kind === 'unreadable' ? 'The file was refused before any check ran.' : outcome.kind === 'unsupported' ? 'The signature check cannot run in this browser, so no check is reported as passed.' : 'The run stopped, so no check is reported as passed.';
    box.replaceChildren(el('p', { cls: 'empty__detail chain__empty', text: message }));
    return;
  }
  if (state.noCrypto && !outcome) {
    sub.textContent = 'No check results';
    box.replaceChildren(el('p', { cls: 'empty__detail chain__empty', text: 'The signature check cannot run in this browser, so no check is reported as passed.' }));
    return;
  }
  const file = parseFile(fileBox.value);
  const count = file ? file.receipts.length : 0;
  if (count === 0) {
    sub.textContent = 'No check results';
    box.replaceChildren(el('p', { cls: 'empty__detail chain__empty', text: 'No receipts to check.' }));
    return;
  }
  const results = outcome?.receipts ?? null;
  sub.textContent = results ? `Total ${formatMs(state.totalMs)}, measured with performance.now() around this real run` : state.busy ? 'Checking' : 'Not run';
  const head = el('tr', {
    kids: [
      el('th', { text: 'Check', attrs: { scope: 'col' } }),
      ...Array.from({ length: results ? results.length : count }, (_, index) => el('th', { cls: 'matrix__seq mono', text: `#${index}`, attrs: { scope: 'col' } })),
      el('th', { cls: 'num matrix__time', text: 'Time', attrs: { scope: 'col' } }),
    ],
  });
  const columns = (results ? results.length : count) + 2;
  const body = el('tbody');
  CHECK_GROUPS.forEach((group, groupIndex) => {
    const ids = group.checks.map(({ id }) => id);
    const groupChecks = results ? results.flatMap((result) => result.checks.filter((check) => ids.includes(check.id))) : [];
    const failures = groupChecks.filter((check) => !check.ok).length;
    body.append(
      el('tr', {
        cls: 'matrix__group',
        kids: [
          el('th', {
            attrs: { colspan: String(columns), scope: 'colgroup' },
            kids: [
              el('span', { text: `${groupIndex + 1}. ${group.name}` }),
              results && el('span', { cls: failures ? 'matrix__sum matrix__sum--bad' : 'matrix__sum', text: `${groupChecks.length - failures} of ${groupChecks.length} passed` }),
            ],
          }),
        ],
      }),
    );
    group.checks.forEach((check) => {
      const row = el('tr', { kids: [el('th', { cls: 'matrix__name', text: check.label, attrs: { scope: 'row' } })] });
      for (let index = 0; index < columns - 2; index++) row.append(matrixCell(results?.[index], check.id));
      const spent = results ? results.reduce((sum, result) => sum + (result.checks.find(({ id }) => id === check.id)?.ms ?? 0), 0) : null;
      row.append(el('td', { cls: 'num mono matrix__time', text: spent === null ? '' : formatMs(spent) }));
      body.append(row);
    });
  });
  const nodes = [el('div', { cls: 'tablewrap', kids: [el('table', { cls: 'matrix', kids: [el('thead', { kids: [head] }), body] })] })];
  if (outcome?.kind === 'fail') {
    const failures = el('ul', { cls: 'failures' });
    outcome.fileProblems.forEach((problem) => failures.append(el('li', { cls: 'failures__item', kids: [el('span', { cls: 'failures__where', text: 'File' }), el('span', { text: problem })] })));
    outcome.receipts.forEach((receipt) => {
      receipt.failed.forEach((failure) => {
        failures.append(el('li', { cls: 'failures__item', kids: [el('span', { cls: 'failures__where mono', text: `#${receipt.index} ${CHECK_NAMES[failure.id]}` }), el('span', { text: failure.message })] }));
      });
    });
    nodes.push(failures);
  }
  if (outcome?.kind === 'pass') nodes.push(el('p', { cls: 'card__note', text: PASS_NOTE }));
  box.replaceChildren(...nodes);
}

/* Detail panel */

function highlightLine(text) {
  const line = el('span', { cls: 'json__line' });
  const indent = text.length - text.trimStart().length;
  line.style.paddingLeft = `${indent + JSON_WRAP_INDENT}ch`;
  line.style.textIndent = `-${JSON_WRAP_INDENT}ch`;
  const body = text.slice(indent);
  const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let cursor = 0;
  for (const match of body.matchAll(token)) {
    if (match.index > cursor) line.append(body.slice(cursor, match.index));
    if (match[1] !== undefined) {
      line.append(el('span', { cls: match[2] ? 'json__key' : 'json__str', text: match[1] }));
      if (match[2]) line.append(match[2]);
    } else {
      const kind = match[0] === 'null' ? 'json__null' : /^[tf]/.test(match[0]) ? 'json__bool' : 'json__num';
      line.append(el('span', { cls: kind, text: match[0] }));
    }
    cursor = match.index + match[0].length;
  }
  line.append(body.slice(cursor));
  return line;
}

function syntaxHighlight(jsonText) {
  return el('code', { cls: 'json', kids: jsonText.split('\n').map(highlightLine) });
}

function fieldRow(path, value, differences, extra) {
  const text = asText(value);
  const isChanged = differences.has(path);
  const before = differences.get(path);
  return el('div', {
    cls: 'field',
    attrs: { 'data-changed': String(isChanged) },
    kids: [
      el('dt', { cls: 'field__key mono', text: path }),
      el('dd', {
        cls: 'field__value',
        kids: [
          el('span', {
            cls: 'field__text',
            kids: [el('span', { cls: 'mono', text }), text.length > 20 && copyButton(text, path)],
          }),
          isChanged && el('span', { cls: 'field__was', text: before === undefined ? (state.baseKind === 'sample' ? 'Not in the sample' : 'Not in the original') : `${state.baseKind === 'sample' ? 'In the sample' : 'Originally'}: ${asText(before)}` }),
          extra,
        ],
      }),
    ],
  });
}

function fieldGroup(title, note, rows) {
  if (rows.length === 0) return null;
  return el('section', { cls: 'group', kids: [el('h3', { cls: 'group__title', text: title }), note && el('p', { cls: 'group__note', text: note }), el('dl', { cls: 'fields', kids: rows })] });
}

function prevLink(receipts, index, prevHash) {
  if (prevHash === GENESIS) return el('span', { cls: 'field__hint', text: 'Genesis: the first receipt has no previous receipt.' });
  const target = receipts.findIndex((candidate) => candidate?.this_hash === prevHash);
  if (target < 0) return el('span', { cls: 'field__hint field__hint--bad', text: 'No receipt in this file has this hash.' });
  const button = el('button', { cls: 'linkbtn mono', text: `Go to previous receipt #${asText(receipts[target].seq)}`, attrs: { type: 'button' } });
  button.addEventListener('click', () => select(target));
  return button;
}

function checksSummary(result) {
  if (!result) return el('section', { cls: 'group', kids: [el('h3', { cls: 'group__title', text: 'Checks' }), el('p', { cls: 'group__note', text: 'Not run for this receipt. Press Verify chain.' })] });
  const list = el('ul', { cls: 'pchecks' });
  CHECK_GROUPS.forEach((group) => {
    group.checks.forEach((definition) => {
      const check = result.checks.find(({ id }) => id === definition.id);
      const failure = result.failed.find(({ id }) => id === definition.id);
      list.append(
        el('li', {
          cls: 'pcheck',
          attrs: { 'data-ok': String(check.ok) },
          kids: [
            icon(check.ok ? 'check' : 'cross'),
            el('span', { cls: 'pcheck__body', kids: [el('span', { text: definition.label }), failure && el('span', { cls: 'pcheck__msg', text: failure.message })] }),
            el('span', { cls: 'pcheck__ms mono', text: formatMs(check.ms) }),
          ],
        }),
      );
    });
  });
  return el('section', { cls: 'group', kids: [el('h3', { cls: 'group__title', text: 'Checks in the last run' }), list] });
}

function computedRows(receipt, result) {
  if (!result) return [];
  const rows = [];
  const add = (id, label, value) => {
    if (result.failed.some((failure) => failure.id === id)) rows.push(fieldRow(label, value, new Map()));
  };
  add('hash', 'computed this_hash', result.computedHash);
  add('binding', 'computed action_digest', result.computedDigest);
  add('chain', 'expected prev_hash', result.expectedPrev);
  return rows;
}

function renderPanel() {
  const body = $('tg-body');
  const file = parseFile(fileBox.value);
  const receipts = file?.receipts ?? [];
  if (state.selected !== null && state.selected >= receipts.length) state.selected = null;
  const open = state.selected !== null && state.route === 'receipts';
  panel.hidden = !open;
  body.dataset.panel = String(open);
  if (!open) {
    panel.replaceChildren();
    return;
  }
  const index = state.selected;
  const receipt = receipts[index];
  const row = toRow(receipt);
  const result = resultsList()?.find((candidate) => candidate.index === index);
  const differences = sampleDifferences(receipt, index);
  const safe = isObject(receipt) ? receipt : {};
  const verdict = isObject(safe.verdict) ? safe.verdict : {};
  const prefixed = (name, value) => flatten(value, name);

  const closeButton = el('button', { cls: 'iconbtn', attrs: { type: 'button', id: 'tg-panel-close', 'aria-label': 'Close receipt detail', title: 'Close (Esc)' }, kids: [icon('close')] });
  closeButton.addEventListener('click', closePanel);
  const stepButton = (delta, name, label) => {
    const button = el('button', { cls: 'iconbtn', attrs: { type: 'button', 'aria-label': label, title: label }, kids: [icon(name)] });
    const target = index + delta;
    if (target < 0 || target >= receipts.length) button.disabled = true;
    button.addEventListener('click', () => {
      select(target);
      panel.querySelector(`[aria-label="${label}"]`)?.focus();
    });
    return button;
  };

  const status = result ? (result.failed.length ? chip('Failed', 'bad', 'cross') : chip('Passed', 'good', 'check')) : chip('Not run', 'neutral', 'dash');
  const head = el('div', {
    cls: 'panel__head',
    kids: [
      el('div', {
        cls: 'panel__title',
        kids: [el('h2', { text: `Receipt #${row.seq}`, attrs: { id: 'tg-panel-title' } }), el('span', { cls: 'panel__sub mono', text: row.id }), decisionChip(row.outcome), status],
      }),
      el('div', { cls: 'panel__actions', kids: [stepButton(-1, 'up', 'Previous receipt'), stepButton(1, 'down', 'Next receipt'), closeButton] }),
    ],
  });

  const tabs = [
    { id: 'fields', label: 'Fields' },
    { id: 'raw', label: 'Raw JSON' },
  ];
  const tablist = el('div', { cls: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Receipt detail views' } });
  const sections = {};
  const showTab = (id, focus) => {
    state.tab = id;
    tabs.forEach((tab) => {
      const button = tablist.querySelector(`[data-tab="${tab.id}"]`);
      const on = tab.id === id;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      sections[tab.id].hidden = !on;
      if (on && focus) button.focus();
    });
  };
  tabs.forEach((tab) => {
    const button = el('button', { cls: 'tab', text: tab.label, attrs: { type: 'button', role: 'tab', 'data-tab': tab.id, id: `tg-tab-${tab.id}`, 'aria-controls': `tg-pane-${tab.id}` } });
    button.addEventListener('click', () => showTab(tab.id));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        showTab(tab.id === 'fields' ? 'raw' : 'fields', true);
      }
    });
    tablist.append(button);
  });

  const reservedTop = ['seq', 'receipt_id', 'prev_hash', 'this_hash', 'action', 'verdict'];
  const otherRows = Object.entries(safe)
    .filter(([key]) => !reservedTop.includes(key))
    .flatMap(([key, value]) => prefixed(key, value).map(([path, leaf]) => fieldRow(path, leaf, differences)));
  const verdictRows = Object.entries(verdict)
    .filter(([key]) => key !== 'signature' && key !== 'authorizer_id')
    .flatMap(([key, value]) => prefixed(`verdict.${key}`, value).map(([path, leaf]) => fieldRow(path, leaf, differences)));
  const actionRows = prefixed('action', safe.action).map(([path, leaf]) => fieldRow(path, leaf, differences));

  sections.fields = el('div', {
    cls: 'panel__pane',
    attrs: { role: 'tabpanel', id: 'tg-pane-fields', 'aria-labelledby': 'tg-tab-fields' },
    kids: [
      checksSummary(result),
      fieldGroup('Signature', 'Ed25519 over the verdict, without the signature field itself. The signer key id is the signed authorizer_id.', [
        fieldRow('verdict.signature', verdict.signature, differences),
        fieldRow('verdict.authorizer_id', verdict.authorizer_id, differences, el('span', { cls: 'field__hint', text: verdict.authorizer_id === SAMPLE_PUBLIC_KEY ? 'Signer key id. This is the published demo key.' : 'Signer key id. This differs from the published demo key.' })),
      ]),
      fieldGroup('Chain', 'seq, prev_hash, action and verdict are covered by this_hash.', [
        fieldRow('receipt_id', safe.receipt_id, differences),
        fieldRow('seq', safe.seq, differences),
        fieldRow('prev_hash', safe.prev_hash, differences, prevLink(receipts, index, row.prevHash)),
        fieldRow('this_hash', safe.this_hash, differences),
        ...computedRows(receipt, result),
      ]),
      fieldGroup('Action', 'Payment details. Bound to the signature through verdict.action_digest.', actionRows),
      fieldGroup('Verdict', 'The signed decision.', verdictRows),
      fieldGroup('Other fields', 'Outside the signed part. The verifier fails a receipt with extra fields.', otherRows),
    ],
  });

  const rawText = JSON.stringify(receipt, null, 2) ?? 'null';
  sections.raw = el('div', {
    cls: 'panel__pane',
    attrs: { role: 'tabpanel', id: 'tg-pane-raw', 'aria-labelledby': 'tg-tab-raw' },
    kids: [
      el('div', { cls: 'rawbar', kids: [el('span', { cls: 'rawbar__label', text: 'This receipt as it stands in the file' }), copyButton(rawText, 'receipt JSON')] }),
      el('pre', { cls: 'jsonbox', attrs: { tabindex: '0', 'aria-label': 'Receipt JSON' }, kids: [syntaxHighlight(rawText)] }),
    ],
  });

  panel.setAttribute('aria-labelledby', 'tg-panel-title');
  panel.replaceChildren(head, tablist, sections.fields, sections.raw);
  showTab(state.tab);
}

/* Raw editor status */

function renderRawStatus() {
  const box = $('tg-raw-status');
  if (state.phase !== 'ready') {
    box.textContent = state.phase === 'loading' ? 'Loading' : 'Not loaded';
    return;
  }
  const file = parseFile(fileBox.value);
  box.textContent = !file ? 'Not valid receipts JSON' : `Valid JSON, ${file.receipts.length} receipt${file.receipts.length === 1 ? '' : 's'}${fileBox.value === state.baseText ? (state.baseKind === 'sample' ? ', unchanged sample' : `, ${BASE_LABELS[state.baseKind].toLowerCase()}, unchanged`) : ', modified'}`;
  box.dataset.bad = String(!file);
}

/* Orchestration */

const NOTICES = {
  sample: ['Sample data.', ' The payments are made up and the signing key is a published demo key that anyone can use.'],
  yours: ['Your receipts.', ' Made on this page and signed with the published demo key that anyone can use, so they say nothing about who signed. They live in this tab only.'],
  file: ['Opened file.', ' Checked against the published demo key. A pass shows the receipts are unchanged since signing with that key.'],
};

function renderNotice() {
  const [lead, rest] = NOTICES[state.baseKind];
  $('tg-notice-text').replaceChildren(el('strong', { text: lead }), document.createTextNode(rest));
}

function renderAll() {
  const receipts = parseFile(fileBox.value)?.receipts ?? null;
  renderTop();
  renderBanner();
  renderFilter(state.phase === 'ready' ? receipts : null);
  renderTable();
  renderChain();
  renderChecks();
  renderPanel();
  renderRawStatus();
  const ready = state.phase === 'ready';
  verifyButton.disabled = !ready || state.busy;
  tamperButton.disabled = !ready || state.busy;
  scenarioSelect.disabled = !ready || state.busy;
  restoreButton.disabled = !ready || fileBox.value === state.baseText;
  restoreButton.textContent = state.baseKind === 'sample' ? 'Restore sample' : 'Restore original';
  useSampleButton.hidden = state.baseKind === 'sample';
  renderNotice();
}

/** Only the newest run may report, so an old pass can never land on text that has since changed. */
async function run() {
  const thisRun = ++state.latestRun;
  state.busy = true;
  state.outcome = null;
  renderAll();
  let next;
  const startedAt = performance.now();
  try {
    next = await verifyText(fileBox.value);
  } catch {
    next = { kind: 'crashed' };
  }
  const elapsed = performance.now() - startedAt;
  if (thisRun !== state.latestRun) return;
  state.busy = false;
  state.outcome = next;
  state.totalMs = elapsed;
  renderAll();
}

/** Any change to the text clears the old result before anything else can be read from the page. */
function change(nextText, nextNote) {
  state.latestRun++;
  state.busy = false;
  state.outcome = null;
  state.note = nextNote;
  fileBox.value = nextText;
  renderAll();
}

function setRoute(route, { focus = false } = {}) {
  state.route = route;
  document.querySelectorAll('.view').forEach((view) => {
    view.hidden = view.dataset.view !== route;
  });
  document.querySelectorAll('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('tg-title').textContent = ROUTES[route];
  document.body.dataset.route = route;
  editLink.hidden = route === 'raw';
  renderPanel();
  if (focus) $('tg-title').focus();
}

function routeFromHash() {
  const name = location.hash.slice(1);
  return Object.hasOwn(ROUTES, name) ? name : null;
}

function bindEvents() {
  verifyButton.addEventListener('click', () => void run());
  tamperButton.addEventListener('click', () => {
    const scenario = SCENARIOS.find(({ id }) => id === scenarioSelect.value) ?? SCENARIOS[0];
    const copy = JSON.parse(state.baseText);
    const nextNote = scenario.apply(copy);
    change(JSON.stringify(copy, null, 2), nextNote);
    void run();
  });
  restoreButton.addEventListener('click', () => change(state.baseText, null));
  useSampleButton.addEventListener('click', () => setBase(state.sampleText, 'sample', SAMPLE_LIST_DATE));
  fileBox.addEventListener('input', () => {
    state.latestRun++;
    state.busy = false;
    state.outcome = null;
    state.note = null;
    renderAll();
  });
}

function bindShell() {
  document.querySelectorAll('[data-icon]').forEach((slot) => slot.replaceWith(icon(slot.dataset.icon)));
  $('tg-limits-key').textContent = SAMPLE_PUBLIC_KEY;
  $('tg-limits-key').after(copyButton(SAMPLE_PUBLIC_KEY, 'public demo key'));
  const openLimits = () => limits.showModal();
  $('tg-limits-open').addEventListener('click', openLimits);
  $('tg-limits-open-2').addEventListener('click', openLimits);
  $('tg-limits-close').addEventListener('click', () => limits.close());
  limits.addEventListener('click', (event) => {
    if (event.target === limits) limits.close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !limits.open && state.selected !== null && state.route === 'receipts') closePanel();
  });
  window.addEventListener('hashchange', () => {
    const route = routeFromHash();
    if (route) setRoute(route, { focus: true });
  });
  setRoute(routeFromHash() ?? 'start');
}

/**
 * Link to the problem-report form, carrying what this page is showing in the URL fragment, which
 * the browser never sends to a server. The form shows all of it before any email opens.
 */
function problemReportHref() {
  const outcome = state.outcome;
  const failed = outcome?.kind === 'fail'
    ? outcome.receipts.filter((r) => r.failed.length).map((r) => `#${r.index} ${r.failed.map(({ id }) => id).join('/')}`).join('; ') || outcome.fileProblems.join('; ')
    : '';
  const context = {
    page: `${location.pathname.split('/').pop() || 'app.html'}#${state.route}, ${BASE_LABELS[state.baseKind].toLowerCase()}${fileBox.value === state.baseText ? '' : ', modified'}`,
    error: Array.from(resultBox.children).filter((node) => node.tagName !== 'BUTTON').map((node) => node.textContent.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' '),
    result: outcome ? `${outcome.kind}${failed ? `: ${failed}` : ''}` : state.phase === 'ready' ? 'not run' : state.phase,
  };
  return `report.html${contextFragment(context)}`;
}

async function start() {
  bindShell();
  const report = $('tg-report');
  const refreshReport = () => { report.href = problemReportHref(); };
  ['click', 'focus', 'pointerenter'].forEach((type) => report.addEventListener(type, refreshReport));
  renderAll();
  try {
    state.noCrypto = !(await ed25519Available());
    const response = await fetch(SAMPLE_URL);
    if (!response.ok) throw new Error(`Sample file returned ${response.status}`);
    const parsed = await response.json();
    state.sampleText = JSON.stringify(parsed, null, 2);
    state.sampleReceipts = parsed.receipts;
    state.phase = 'ready';
    state.baseText = state.sampleText;
    state.baseReceipts = parsed.receipts;
    renderScenarios();
    fileBox.value = state.sampleText;
    bindEvents();
  } catch {
    state.phase = 'load-error';
  }
  renderAll();
  void initStart({
    openInVerifier(text, listDate, kind) {
      if (state.phase !== 'ready') return;
      setBase(text, kind, listDate);
      location.hash = 'receipts';
      setRoute('receipts', { focus: true });
      void run();
    },
  });
}

void start();
