/**
 * The "Get started" view: screen an address, sign a receipt, check receipts. The logic lives in
 * workbench.js and verifier.js; this file only reads the form and draws results. Every value shown
 * goes through textContent. Receipts made here live in this tab's memory only.
 */
import { verifyText } from './verifier.js';
import {
  LIST_URL,
  appendReceipt,
  emptyChain,
  packageName,
  packageText,
  prepareList,
  readAddress,
  readAmount,
  screen,
  signingAvailable,
} from './workbench.js';

const MAX_UPLOAD_BYTES = 200_000;
const $ = (id) => document.getElementById(id);

function el(tag, { cls, text, attrs, kids } = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, value);
  if (kids) node.append(...kids.filter(Boolean));
  return node;
}

function short(hex, head = 10, tail = 6) {
  return hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex;
}

function decision(outcome) {
  return el('span', { cls: `decision decision--${outcome.toLowerCase()}`, text: outcome });
}

/** "10/21/2026" to "Oct 21, 2026". */
export function listDateLabel(publishDate) {
  const [month, day, year] = publishDate.split('/').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? publishDate : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Wires the view.
 *
 * Args: openInVerifier(text, listDate, kind), called with a receipts file to load and check in the
 *   Receipts view.
 */
export async function initStart({ openInVerifier }) {
  const form = $('st-form');
  const addressBox = $('st-address');
  const amountBox = $('st-amount');
  const screenButton = $('st-screen');
  const errorBox = $('st-error');
  const resultBox = $('st-result');
  const signButton = $('st-sign');
  const downloadButton = $('st-download');
  const clearButton = $('st-clear');
  const signStatus = $('st-sign-status');
  const openButton = $('st-open');

  let prepared = null;
  let pending = null; // last screening decision not yet signed
  let chain = null;
  let canSign = false;
  let busy = false;

  const refresh = () => {
    screenButton.disabled = !prepared || busy;
    signButton.disabled = !pending || !canSign || busy;
    const has = Boolean(chain && chain.receipts.length);
    downloadButton.disabled = !has;
    clearButton.disabled = !has;
    openButton.disabled = !has;
  };

  // Check a package works without the list, so wire it first.
  bindDrop();

  try {
    const response = await fetch(LIST_URL);
    if (!response.ok) throw new Error(`List file returned ${response.status}`);
    const text = await response.text();
    prepared = await prepareList(JSON.parse(text), text);
    chain = emptyChain(prepared.meta);
    renderProvenance(prepared);
    const example = [...prepared.index.keys()].find((key) => key.startsWith('0x'));
    const exampleButton = $('st-example');
    exampleButton.textContent = prepared.index.get(example)[0].address;
    exampleButton.addEventListener('click', () => {
      addressBox.value = exampleButton.textContent;
      addressBox.focus();
    });
  } catch {
    $('st-prov-short').textContent = 'did not load';
    errorBox.textContent = 'The OFAC list did not load, so screening is off. Reload the page to try again. Checking a package still works.';
  }
  canSign = await signingAvailable();
  if (!canSign) signStatus.textContent = 'This browser cannot sign Ed25519, so it cannot make receipts. A current Chrome, Safari or Firefox can.';
  refresh();

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!prepared) return;
    const address = readAddress(addressBox.value);
    const amount = readAmount(amountBox.value);
    const problem = address.error ?? amount.error;
    errorBox.textContent = problem ?? '';
    addressBox.setAttribute('aria-invalid', String(Boolean(address.error)));
    amountBox.setAttribute('aria-invalid', String(Boolean(amount.error)));
    if (problem) {
      pending = null;
      resultBox.replaceChildren();
      refresh();
      return;
    }
    const result = screen(prepared, address.address);
    pending = { address: address.address, amount: amount.amount, ...result };
    renderResult(pending);
    if (canSign) signStatus.textContent = 'Ready to sign this decision.';
    refresh();
  });

  addressBox.addEventListener('input', () => {
    if (pending) {
      pending = null;
      resultBox.replaceChildren();
      if (canSign) signStatus.textContent = 'Screen an address first.';
      refresh();
    }
  });

  signButton.addEventListener('click', async () => {
    if (!pending || !chain) return;
    busy = true;
    refresh();
    try {
      const receipt = await appendReceipt(chain, prepared.meta, pending);
      pending = null;
      signStatus.textContent = `Signed receipt #${receipt.seq} and added it to your chain. Your chain has ${chain.receipts.length} receipt${chain.receipts.length === 1 ? '' : 's'}.`;
      renderReceipt(receipt);
      renderChain();
    } catch {
      signStatus.textContent = 'Signing failed in this browser, so no receipt was made.';
    }
    busy = false;
    refresh();
  });

  downloadButton.addEventListener('click', () => {
    const blob = new Blob([packageText(chain)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { attrs: { href: url, download: packageName(chain) } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  clearButton.addEventListener('click', () => {
    chain = emptyChain(prepared.meta);
    $('st-receipt').replaceChildren();
    $('st-chain').replaceChildren();
    signStatus.textContent = pending ? 'New chain started. Ready to sign this decision.' : 'New chain started. Screen an address first.';
    refresh();
  });

  openButton.addEventListener('click', () => {
    openInVerifier(packageText(chain).trimEnd(), listDateLabel(prepared.meta.publish_date), 'yours');
  });

  /** The list date for a file, when it was checked against the bundled list. */
  function listDateFor(text) {
    try {
      return prepared && JSON.parse(text).list_snapshot === prepared.meta.list_digest ? listDateLabel(prepared.meta.publish_date) : null;
    } catch {
      return null;
    }
  }

  function renderProvenance({ meta, fileSha256 }) {
    $('st-prov-short').textContent = `OFAC SDN list published ${listDateLabel(meta.publish_date)}, ${meta.address_count.toLocaleString('en-US')} addresses`;
    const rows = [
      ['Source', meta.source],
      ['Downloaded from', meta.source_url, true],
      ['Published by OFAC', meta.publish_date],
      ['Downloaded at', meta.fetched_at.replace('T', ' ').replace('Z', ' UTC')],
      ['SHA-256 of the downloaded SDN.XML', meta.raw_sha256, true],
      ['List fingerprint (signed into receipts)', meta.list_digest, true],
      ['SHA-256 of this page\'s list file, computed just now', fileSha256, true],
      ['Addresses', `${meta.address_count.toLocaleString('en-US')} distinct addresses`],
      ['Match rule', 'Exact address match, ignoring upper and lower case. No name matching, no partial matches.'],
    ];
    $('st-prov').replaceChildren(
      ...rows.map(([term, value, mono]) => el('div', { kids: [el('dt', { text: term }), el('dd', { cls: mono ? 'mono' : undefined, text: value })] })),
    );
  }

  function renderResult(decided) {
    const lead = decided.outcome === 'BLOCK'
      ? 'This address is on the list.'
      : 'No exact match on this list.';
    const detail = decided.outcome === 'BLOCK'
      ? decided.matches.map((entry) => `${entry.name} · SDN entry ${entry.uid} · ${entry.chain}`)
      : ['ALLOW only means this exact address is not on this copy of the list. It is not a clearance.'];
    resultBox.dataset.outcome = decided.outcome;
    resultBox.replaceChildren(
      el('div', { cls: 'screen__lead', kids: [decision(decided.outcome), el('span', { text: lead })] }),
      el('p', { cls: 'screen__addr mono', text: decided.address }),
      ...detail.map((line) => el('p', { cls: 'screen__detail', text: line })),
    );
  }

  function renderReceipt(receipt) {
    const params = receipt.action.params;
    const rows = [
      ['Receipt', `${receipt.receipt_id} · seq ${receipt.seq}`, true],
      ['Address', params.beneficiary_address, true],
      ['Amount', typeof params.amount_usd === 'number' ? `$${params.amount_usd.toLocaleString('en-US')}` : 'Not given'],
      ['Checked at', receipt.verdict.decided_at.replace('T', ' ').replace('Z', ' UTC')],
      ['List fingerprint', short(receipt.verdict.reasons.find((r) => r.startsWith('list_snapshot=')).slice(14)), true],
      ['Signature', short(receipt.verdict.signature, 16, 8), true],
      ['Signed by', 'Public demo key'],
      ['Receipt hash', short(receipt.this_hash), true],
      ['Links to', receipt.seq === 0 ? 'Start of chain' : short(receipt.prev_hash), true],
    ];
    $('st-receipt').replaceChildren(
      el('div', {
        cls: 'mini-receipt',
        kids: [
          el('div', { cls: 'mini-receipt__head', kids: [el('span', { text: 'Your receipt' }), decision(params.outcome)] }),
          el('dl', { cls: 'mini-receipt__grid', kids: rows.map(([term, value, mono]) => el('div', { kids: [el('dt', { text: term }), el('dd', { cls: mono ? 'mono' : undefined, text: value })] })) }),
        ],
      }),
    );
  }

  function renderChain() {
    $('st-chain').replaceChildren(
      el('ol', {
        cls: 'mini-chain',
        attrs: { 'aria-label': 'Your chain' },
        kids: chain.receipts.map((r) => el('li', { kids: [el('span', { cls: 'mini-chain__seq', text: `#${r.seq}` }), decision(r.action.params.outcome), el('code', { cls: 'mono', text: r.this_hash.slice(0, 8) })] })),
      }),
    );
  }

  function bindDrop() {
    const drop = $('st-drop');
    const input = $('st-file');
    const out = $('st-check');
    const check = async (file) => {
      if (!file) return;
      if (file.size > MAX_UPLOAD_BYTES) {
        show('fail', 'Not checked. This file is too large to be a receipt package.', []);
        return;
      }
      show('loading', `Checking ${file.name} in this browser.`, []);
      let text;
      try {
        text = await file.text();
      } catch {
        show('fail', 'This file could not be read.', []);
        return;
      }
      let outcome;
      try {
        outcome = await verifyText(text);
      } catch {
        outcome = { kind: 'crashed' };
      }
      if (outcome.kind === 'pass') {
        const n = outcome.receipts.length;
        show('pass', `Verified. ${n === 1 ? 'The receipt checks out' : `All ${n} receipts check out`}.`, [`${file.name}: every signature, hash and chain link matches. Signed with the public demo key, so this shows the receipts are unchanged and says nothing about who signed.`], text);
      } else if (outcome.kind === 'fail') {
        const failing = outcome.receipts.filter((r) => r.failed.length);
        const lines = [
          ...outcome.fileProblems,
          ...failing.slice(0, 4).map((r) => `Receipt #${r.index}: ${r.failed.map(({ message }) => message).join(' ')}`),
        ];
        show('fail', 'Verification failed.', lines, text);
      } else if (outcome.kind === 'unreadable') {
        show('fail', 'Verification failed. This file cannot be read as receipts.', outcome.problems.slice(0, 3));
      } else if (outcome.kind === 'unsupported') {
        show('fail', 'This browser cannot check Ed25519 signatures, so nothing was verified.', []);
      } else {
        show('fail', 'Something went wrong while checking, so nothing was verified.', []);
      }
    };
    const show = (kind, lead, lines, text) => {
      const kids = [el('p', { cls: 'banner__lead', text: lead }), ...lines.map((line) => el('p', { cls: 'banner__detail', text: line }))];
      if (text && (kind === 'pass' || kind === 'fail')) {
        const open = el('button', { cls: 'linkbtn', text: 'Open this file in the verifier', attrs: { type: 'button' } });
        open.addEventListener('click', () => openInVerifier(text, listDateFor(text), 'file'));
        kids.push(open);
      }
      out.replaceChildren(el('div', { cls: 'banner', attrs: { 'data-state': kind }, kids }));
    };
    input.addEventListener('change', () => {
      void check(input.files?.[0]);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.dataset.over = 'true';
    }));
    ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, () => {
      delete drop.dataset.over;
    }));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      void check(event.dataTransfer?.files?.[0]);
    });
  }
}
