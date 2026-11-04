// Unit tests for the Get started flow: screening, signing, packaging, tamper detection.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyText, SAMPLE_PUBLIC_KEY } from '../js/verifier.js';
import * as wb from '../js/workbench.js';

const root = new URL('../', import.meta.url);
const listText = await readFile(new URL('data/ofac_crypto_addresses.json', root), 'utf8');
const sampleText = await readFile(new URL('data/sample_receipts.json', root), 'utf8');
const prepared = await wb.prepareList(JSON.parse(listText), listText);
const listed = JSON.parse(listText).entries.find((e) => e.address.startsWith('0x')).address;
const FIXED = new Date('2026-11-03T04:00:00.000Z');

async function chainOf(...addresses) {
  const chain = wb.emptyChain(prepared.meta);
  for (const address of addresses) {
    const result = wb.screen(prepared, address);
    await wb.appendReceipt(chain, prepared.meta, { address, amount: 1000, ...result }, FIXED);
  }
  return chain;
}

test('bundle provenance is complete and the raw digest is the recorded one', () => {
  const m = prepared.meta;
  assert.equal(m.raw_sha256, '421c5f6ee841eb7c0e327eb0d6bdbe24cbb58091e3cbfd77d83dd41c7b5a5e08');
  assert.equal(m.list_digest, '112dfd2697e20e56d62eaff71d86993856600bd1502dc1ff3ee65ddeed2efff7');
  assert.equal(m.publish_date, '10/21/2026');
  assert.equal(prepared.index.size, 1050);
  assert.match(prepared.fileSha256, /^[0-9a-f]{64}$/);
});

test('prepareList rejects a bundle without provenance or with a wrong count', async () => {
  const list = JSON.parse(listText);
  const { source_url, ...noSource } = list;
  await assert.rejects(wb.prepareList(noSource, ''), /source_url/);
  await assert.rejects(wb.prepareList({ ...list, address_count: 1 }, ''), /count/);
  await assert.rejects(wb.prepareList({ ...list, entries: [] }, ''), /no entries/);
});

test('screen: exact match blocks, case is ignored, anything else allows', () => {
  assert.equal(wb.screen(prepared, listed).outcome, 'BLOCK');
  assert.equal(wb.screen(prepared, listed.toUpperCase().replace('0X', '0x')).outcome, 'BLOCK');
  assert.equal(wb.screen(prepared, listed.slice(0, -1)).outcome, 'ALLOW');
  assert.equal(wb.screen(prepared, `${listed}0`).outcome, 'ALLOW');
  assert.equal(wb.screen(prepared, '0x000000000000000000000000000000000000c1ea').outcome, 'ALLOW');
  assert.ok(wb.screen(prepared, listed).matches.length >= 1);
});

test('readAddress and readAmount validate input', () => {
  assert.deepEqual(wb.readAddress(`  ${listed}  `), { address: listed });
  assert.ok(wb.readAddress('').error);
  assert.ok(wb.readAddress('0xabc def').error);
  assert.ok(wb.readAddress('a'.repeat(wb.MAX_ADDRESS_LENGTH + 1)).error);
  assert.ok(wb.readAddress('<script>').error);
  assert.deepEqual(wb.readAmount(''), { amount: null });
  assert.deepEqual(wb.readAmount('1,250'), { amount: 1250 });
  assert.ok(wb.readAmount('12.5').error);
  assert.ok(wb.readAmount('-3').error);
  assert.ok(wb.readAmount('9'.repeat(20)).error);
});

test('signing with the demo key reproduces the published public key', async () => {
  assert.equal(await wb.signingAvailable(), true);
  const chain = await chainOf(listed);
  assert.equal(chain.receipts[0].verdict.authorizer_id, SAMPLE_PUBLIC_KEY);
});

test('a created chain (block, allow, block) passes the real verifier', async () => {
  const chain = await chainOf(listed, '0x000000000000000000000000000000000000c1ea', listed.toUpperCase().replace('0X', '0x'));
  assert.deepEqual(chain.receipts.map((r) => r.action.params.outcome), ['BLOCK', 'ALLOW', 'BLOCK']);
  assert.equal(chain.receipts[1].prev_hash, chain.receipts[0].this_hash);
  const outcome = await verifyText(wb.packageText(chain));
  assert.equal(outcome.kind, 'pass');
});

test('a receipt without an amount still passes', async () => {
  const chain = wb.emptyChain(prepared.meta);
  await wb.appendReceipt(chain, prepared.meta, { address: listed, amount: null, ...wb.screen(prepared, listed) }, FIXED);
  assert.equal('amount_usd' in chain.receipts[0].action.params, false);
  assert.equal((await verifyText(wb.packageText(chain))).kind, 'pass');
});

test('tampering with a created receipt fails: outcome, amount, signature, list, extra field', async () => {
  const base = await chainOf(listed, '0x000000000000000000000000000000000000c1ea');
  const cases = {
    outcome: (c) => { c.receipts[0].action.params.outcome = 'ALLOW'; },
    amount: (c) => { c.receipts[1].action.params.amount_usd = 9000; },
    signature: (c) => { const v = c.receipts[0].verdict; v.signature = (v.signature[0] === 'a' ? 'b' : 'a') + v.signature.slice(1); },
    list: (c) => { c.list_snapshot = '0'.repeat(64); },
    extra: (c) => { c.note = 'x'; },
  };
  for (const [name, apply] of Object.entries(cases)) {
    const copy = structuredClone(base);
    apply(copy);
    assert.equal((await verifyText(wb.packageText(copy))).kind, 'fail', name);
  }
});

test('package round trip: downloaded text verifies unchanged and names the head hash', async () => {
  const chain = await chainOf(listed);
  const text = wb.packageText(chain);
  assert.deepEqual(JSON.parse(text), chain);
  assert.equal(wb.packageName(chain), `tollgate-receipts-${chain.receipts[0].this_hash.slice(0, 12)}.json`);
  assert.equal((await verifyText(text)).kind, 'pass');
});

test('the shipped sample still passes, and its edited signature fails', async () => {
  assert.equal((await verifyText(sampleText)).kind, 'pass');
  const copy = JSON.parse(sampleText);
  copy.receipts[1].verdict.signature = 'b' + copy.receipts[1].verdict.signature.slice(1);
  assert.equal((await verifyText(JSON.stringify(copy))).kind, 'fail');
});

test('a non-receipt upload is refused, never passed', async () => {
  assert.equal((await verifyText('not json')).kind, 'unreadable');
  assert.equal((await verifyText(listText)).kind, 'unreadable');
  assert.equal((await verifyText('{"receipts":[]}')).kind, 'unreadable');
});

/* Files this page was not made to check get a neutral result: never "pass", never "fail". */

import { canon, FOREIGN_MESSAGES } from '../js/verifier.js';

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(digest).toString('hex');
}

/** The sample re-signed honestly with a fresh key, as a real workspace would sign its own chain. */
async function resignedWithOwnKey(mutate = () => {}) {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
  const file = JSON.parse(sampleText);
  mutate(file);
  let prev = '0'.repeat(64);
  for (const receipt of file.receipts) {
    const { signature, ...signed } = receipt.verdict;
    signed.authorizer_id = pub;
    signed.action_digest = await sha256(canon(receipt.action));
    const sig = await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(canon(signed)));
    receipt.verdict = { ...signed, signature: Buffer.from(sig).toString('hex') };
    receipt.prev_hash = prev;
    receipt.this_hash = await sha256(canon({ seq: receipt.seq, prev_hash: prev, action: receipt.action, verdict: receipt.verdict }));
    prev = receipt.this_hash;
  }
  return file;
}

function assertNeutral(outcome, reason, name) {
  assert.equal(outcome.kind, 'foreign', name);
  assert.equal(outcome.reason, reason, name);
  assert.equal(outcome.message, FOREIGN_MESSAGES[reason], name);
  assert.equal('receipts' in outcome, false, `${name}: no partial checks`);
}

test('a real-format package signed with its own key is neutral, never fail or pass', async () => {
  const file = await resignedWithOwnKey();
  assertNeutral(await verifyText(JSON.stringify(file, null, 2)), 'workspace', 'own key');
});

test('kit labels, ids and structure are neutral', async () => {
  const kitLabels = await resignedWithOwnKey((f) => {
    f.rulebook_version = 'OFAC-SDN-9f2503ec4c17';
    f.receipts.forEach((r, i) => {
      const hex = (i + 1).toString(16).padStart(16, '0');
      r.receipt_id = `rcpt:${hex}`;
      r.action.action_id = `act:${hex}`;
      r.verdict.action_id = `act:${hex}`;
    });
  });
  assertNeutral(await verifyText(JSON.stringify(kitLabels)), 'workspace', 'kit labels and key');
  const label = JSON.parse(sampleText);
  label.rulebook_version = 'OFAC-SDN-9f2503ec4c17';
  assertNeutral(await verifyText(JSON.stringify(label)), 'workspace', 'non-demo rulebook label');
  const ids = JSON.parse(sampleText);
  ids.receipts.forEach((r, i) => { r.receipt_id = `rcpt:${(i + 1).toString(16).padStart(16, '0')}`; });
  assertNeutral(await verifyText(JSON.stringify(ids)), 'workspace', 'non-demo id form');
  const stub = JSON.parse(sampleText);
  stub.receipts[1] = { seq: 1, prev_hash: stub.receipts[1].prev_hash, this_hash: stub.receipts[1].this_hash };
  assertNeutral(await verifyText(JSON.stringify(stub)), 'workspace', 'receipt held by hash only');
  assertNeutral(await verifyText(JSON.stringify({ bundle: JSON.parse(sampleText) })), 'workspace', 'nested bundle');
  assertNeutral(await verifyText('PK\u0003\u0004 zip bytes'), 'workspace', 'zip archive');
});

test('an integral float such as 6.0 is neutral, never fail or pass', async () => {
  assert.match(sampleText, /"amount_usd": 1000,/);
  assertNeutral(await verifyText(sampleText.replace('"amount_usd": 1000,', '"amount_usd": 1000.0,')), 'number', '1000.0');
  assertNeutral(await verifyText(sampleText.replace('"amount_usd": 1000,', '"amount_usd": 1e3,')), 'number', '1e3');
  const chain = await chainOf(listed);
  const text = wb.packageText(chain).replace('"amount_usd":1000', '"amount_usd":6.0').replace('"amount_usd": 1000', '"amount_usd": 6.0');
  assertNeutral(await verifyText(text), 'number', 'own receipt with 6.0');
});

test('an oversized file is neutral, never fail or pass', async () => {
  assertNeutral(await verifyText(sampleText + ' '.repeat(200_001)), 'workspace', 'oversized');
});

test('demo files with one edited key or label still fail', async () => {
  const signer = JSON.parse(sampleText);
  signer.receipts[1].verdict.authorizer_id = 'f'.repeat(64);
  assert.equal((await verifyText(JSON.stringify(signer))).kind, 'fail', 'one signer changed');
  const id = JSON.parse(sampleText);
  id.receipts[0].receipt_id = 'rcpt:0000000000000001';
  assert.equal((await verifyText(JSON.stringify(id))).kind, 'fail', 'one id changed');
  const own = await chainOf(listed, '0x000000000000000000000000000000000000c1ea');
  own.receipts[0].verdict.authorizer_id = 'f'.repeat(64);
  assert.equal((await verifyText(wb.packageText(own))).kind, 'fail', 'own chain, one signer changed');
});
