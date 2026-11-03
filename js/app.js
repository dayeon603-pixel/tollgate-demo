/**
 * Page behaviour for the receipt check. Everything shown from the receipt file goes through
 * textContent, because the file is user input once it has been edited by hand.
 */
import { signedReason, verifyText } from './verifier.js';

const SAMPLE_URL = 'data/sample_receipts.json';
const TAMPERED_RECEIPT = 0;
const CHECKS_RUN = [
  'The signature matches the signed decision',
  'The decision was signed by the sample key',
  'The payment details match the signed decision',
  "Each receipt's fingerprint matches its contents",
  'Each receipt links to the one before it',
];
const NOT_CHECKED = 'Not checked yet. Press Verify to run the check in this browser.';

const verifyButton = document.getElementById('tg-verify');
const tamperButton = document.getElementById('tg-tamper');
const restoreButton = document.getElementById('tg-restore');
const resultBox = document.getElementById('tg-result');
const cardList = document.getElementById('tg-cards');
const cardsInvalid = document.getElementById('tg-cards-invalid');
const fileBox = document.getElementById('tg-file');

let sampleText = '';
let sampleCards = [];
let note = null;
let latestRun = 0;

/** Builds an element with optional class, text and attributes. */
function el(tag, { cls, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  return node;
}

/** String() can throw on hand-edited JSON such as {"toString": 1}, so objects go through JSON. */
function asText(value) {
  if (value === null || value === undefined) return 'missing';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function short(value, length = 14) {
  const text = asText(value);
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Display model for the cards. Tolerates any hand-edited shape, because the text is user input. */
function toCards(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.receipts)) return null;
  return parsed.receipts.map((receipt) => {
    const params = receipt?.action?.params ?? {};
    const verdict = receipt?.verdict && typeof receipt.verdict === 'object' ? receipt.verdict : {};
    const amount =
      typeof params.amount_usd === 'number'
        ? `$${params.amount_usd.toLocaleString('en-US')}`
        : short(params.amount_usd);
    return {
      outcome: asText(params.outcome),
      rows: [
        { label: 'Address checked', value: asText(params.beneficiary_address), mono: true },
        { label: 'Amount', value: amount },
        { label: 'List entry matched', value: signedReason(verdict, 'sanctions_hit') ?? 'None', mono: true },
        { label: 'List used (fingerprint)', value: short(signedReason(verdict, 'list_snapshot')), mono: true },
        { label: 'Time', value: asText(receipt?.action?.requested_at).replace('T', ' ').replace('Z', ' UTC') },
        { label: 'Signature', value: short(verdict.signature), mono: true },
      ],
    };
  });
}

/** Changes one character of the list fingerprint in the first receipt's signed decision. */
function tamperOneField() {
  const copy = JSON.parse(sampleText);
  const reasons = copy.receipts[TAMPERED_RECEIPT].verdict.reasons;
  const at = reasons.findIndex((reason) => reason.startsWith('list_snapshot='));
  const before = reasons[at].slice('list_snapshot='.length);
  const after = (before[0] === '3' ? '4' : '3') + before.slice(1);
  reasons[at] = `list_snapshot=${after}`;
  return {
    text: JSON.stringify(copy, null, 2),
    note: `We changed one character in receipt ${TAMPERED_RECEIPT + 1}. Its list fingerprint now starts ${after.slice(0, 8)} instead of ${before.slice(0, 8)}, as if a different list had been checked.`,
  };
}

function renderCards(outcome) {
  const cards = toCards(fileBox.value);
  cardList.replaceChildren();
  cardList.hidden = !cards;
  cardsInvalid.hidden = Boolean(cards);
  if (!cards) return;
  const results = outcome && 'receipts' in outcome ? outcome.receipts : null;
  cards.forEach((card, i) => {
    const item = el('li', { cls: 'card' });
    const head = el('div', { cls: 'card__head' });
    head.append(
      el('span', { text: `Sample receipt ${i + 1}` }),
      el('span', { cls: 'chip', text: short(card.outcome, 12), attrs: { 'data-outcome': card.outcome } }),
    );
    const rows = el('dl');
    card.rows.forEach((row, r) => {
      const changed = sampleCards[i]?.rows[r]?.value !== row.value;
      const wrap = el('div', { cls: 'row', attrs: { 'data-changed': String(changed) } });
      wrap.append(el('dt', { text: row.label }), el('dd', { cls: row.mono ? 'mono' : undefined, text: row.value }));
      rows.append(wrap);
    });
    item.append(head, rows);
    const result = results?.find((candidate) => candidate.index === i);
    if (result) {
      const ok = result.failed.length === 0;
      item.append(el('p', { cls: 'card__mark', text: ok ? 'Passes' : 'Fails', attrs: { 'data-ok': String(ok) } }));
    }
    cardList.append(item);
  });
}

function renderResult(outcome) {
  const state = outcome === null ? 'idle' : outcome === 'crashed' ? 'crashed' : outcome.kind;
  resultBox.dataset.state = state;
  const nodes = [];
  if (state === 'idle') {
    nodes.push(el('p', { cls: 'result__lead', text: note ?? NOT_CHECKED }));
  } else if (state === 'pass') {
    const checks = el('ul', { cls: 'checks' });
    CHECKS_RUN.forEach((check) => checks.append(el('li', { text: check })));
    nodes.push(
      el('p', { cls: 'result__head', text: `Verified. All ${outcome.receipts.length} receipts check out.` }),
      checks,
      el('p', {
        cls: 'result__note',
        text: 'This ran in your browser and sent nothing anywhere. It shows these receipts are unchanged since they were signed. It does not re-run the screening or show that the list was complete.',
      }),
    );
  } else if (state === 'fail') {
    nodes.push(el('p', { cls: 'result__head', text: 'Verification failed.' }));
    if (note) nodes.push(el('p', { cls: 'result__note', text: note }));
    outcome.fileProblems.forEach((problem) => nodes.push(el('p', { cls: 'problem', text: problem })));
    outcome.receipts
      .filter((receipt) => receipt.failed.length > 0)
      .forEach((receipt) => {
        const block = el('div', { cls: 'failed' });
        const list = el('ul', { cls: 'problems' });
        receipt.failed.forEach((failure) => list.append(el('li', { text: failure.message })));
        block.append(el('p', { cls: 'failed__name', text: `Receipt ${receipt.index + 1}` }), list);
        nodes.push(block);
      });
  } else if (state === 'unreadable') {
    nodes.push(el('p', { cls: 'result__head', text: 'Verification failed. This file cannot be read.' }));
    outcome.problems.slice(0, 4).forEach((problem) => nodes.push(el('p', { cls: 'problem', text: problem })));
  } else if (state === 'unsupported') {
    nodes.push(
      el('p', { cls: 'result__head', text: 'This browser cannot run the check, so nothing was verified.' }),
      el('p', {
        cls: 'result__note',
        text: 'It has no built-in support for Ed25519 signatures. A current version of Chrome, Safari or Firefox has it.',
      }),
    );
  } else {
    nodes.push(
      el('p', {
        cls: 'result__head',
        text: 'Something went wrong while checking, so nothing was verified. Try reloading the page.',
      }),
    );
  }
  resultBox.replaceChildren(...nodes);
}

function setBusy(busy) {
  verifyButton.disabled = busy;
  tamperButton.disabled = busy;
}

/** Only the newest run may report, so an old pass can never land on text that has since changed. */
async function run() {
  const thisRun = ++latestRun;
  setBusy(true);
  let next;
  try {
    next = await verifyText(fileBox.value);
  } catch {
    next = 'crashed';
  }
  if (thisRun !== latestRun) return;
  setBusy(false);
  renderResult(next);
  renderCards(next === 'crashed' ? null : next);
}

/** Any change to the text clears the old result before anything else can be read from the page. */
function change(nextText, nextNote) {
  latestRun++;
  setBusy(false);
  fileBox.value = nextText;
  note = nextNote;
  restoreButton.hidden = nextText === sampleText;
  renderResult(null);
  renderCards(null);
}

async function start() {
  const response = await fetch(SAMPLE_URL);
  if (!response.ok) throw new Error(`Sample file returned ${response.status}`);
  sampleText = JSON.stringify(await response.json(), null, 2);
  sampleCards = toCards(sampleText) ?? [];

  verifyButton.addEventListener('click', () => void run());
  tamperButton.addEventListener('click', () => {
    const tampered = tamperOneField();
    change(tampered.text, tampered.note);
    void run();
  });
  restoreButton.addEventListener('click', () => change(sampleText, null));
  fileBox.addEventListener('input', () => {
    const edited = fileBox.value;
    latestRun++;
    setBusy(false);
    note = null;
    restoreButton.hidden = edited === sampleText;
    renderResult(null);
    renderCards(null);
  });

  change(sampleText, null);
}

start().catch(() => {
  resultBox.dataset.state = 'crashed';
  resultBox.replaceChildren(
    el('p', { cls: 'result__head', text: 'The sample receipts did not load, so nothing was verified. Try reloading the page.' }),
  );
});
