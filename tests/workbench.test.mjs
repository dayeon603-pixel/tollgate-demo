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
