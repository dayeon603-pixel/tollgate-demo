// Unit tests for the analyst workspace logic: screening and policy, four-eyes, list-update
// lookback and diff, the receipt ledger, evidence packs, batch parsing, metrics.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyText } from '../js/verifier.js';
import { createWorkspace, snapshot } from '../js/ws/session.js';
import { diffVersions, matchIn } from '../js/ws/lists.js';
import { WorkspaceError, evaluatePolicy, defaultPolicy } from '../js/ws/engine.js';
import { MAX_SEGMENT_CHARS } from '../js/ws/ledger.js';
import { buildPack, packHtml, verifyPack } from '../js/ws/evidence.js';
import { parseBatch, resultsCsv, runBatch, MAX_BATCH_ROWS } from '../js/ws/batch.js';
import { dailyVolume, summary } from '../js/ws/metrics.js';
import { csvCell, parseCsv } from '../js/ws/util.js';

const listText = await readFile(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8');
const list = JSON.parse(listText);
const ANCHOR = new Date('2026-11-06T10:00:00.000Z');
const NOW = new Date('2026-11-06T10:30:00.000Z');
let clock = Date.parse('2026-11-06T11:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();

async function fresh(savedOps = []) {
  return createWorkspace({ list, anchor: ANCHOR, savedOps });
}

const CLEAN = '0x1111111111111111111111111111111111111111';

const screen = (ws, over = {}) => ws.apply({ op: 'screen', ts: tick(), actor: 'analyst-a', source: 'manual', address: CLEAN, amount: 100, originator: true, ...over });
const act = (ws, alertId, actor, action, extra = {}) => ws.apply({ op: 'alertAction', ts: tick(), actor, alertId, action, ...extra });
const NOTE = 'Reviewed the payment record and the list entry.';

async function expectRefusal(promise, code) {
  await assert.rejects(promise, (e) => e instanceof WorkspaceError && (!code || e.code === code), `expected refusal ${code}`);
}

test('list versions: newest is the real snapshot, diffs are what was held back', async () => {
  const { ws } = await fresh();
  const [v1, v2, v3] = ws.versions;
  assert.equal(v3.digest, list.list_digest);
  assert.equal(v3.real, true);
  assert.equal(v1.real || v2.real, false);
  assert.equal(new Set([v1.digest, v2.digest, v3.digest]).size, 3);
  assert.equal(v3.addressCount, 1050);
  const d23 = diffVersions(v2, v3);
  assert.equal(d23.added.length, 7);
  assert.equal(d23.removed.length, 3);
  assert.ok(d23.removed.every((r) => r.entries[0].synthetic), 'removed entries are marked synthetic');
  const d12 = diffVersions(v1, v2);
  assert.equal(d12.added.length, 9);
  assert.equal(d12.removed.length, 2);
  assert.deepEqual(diffVersions(v3, v3), { added: [], removed: [] });
});

test('screening is exact match, case-insensitive, never fuzzy', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const hit = await screen(ws, { address: listed.toUpperCase().replace(/^0X/, '0x') });
  assert.equal(hit.tx.outcome, hit.tx.address.toLowerCase() === listed.toLowerCase() ? 'BLOCK' : 'ALLOW');
  assert.equal((await screen(ws, { address: listed })).tx.outcome, 'BLOCK');
  assert.equal((await screen(ws, { address: `${listed}0` })).tx.outcome, 'ALLOW');
  assert.equal((await screen(ws, { address: listed.slice(0, -1) })).tx.outcome, 'ALLOW');
  assert.equal(matchIn(ws.inForce, 'not-an-address').length, 0);
});

test('blank-originator hold fires at the threshold, not below, never with originator or unknown amount', async () => {
  const { ws } = await fresh();
  assert.equal(ws.policy.rules.blank_originator.thresholdUsd, 1000);
  assert.equal((await screen(ws, { amount: 1000, originator: false })).tx.outcome, 'HOLD');
  assert.equal((await screen(ws, { amount: 999, originator: false })).tx.outcome, 'ALLOW');
  assert.equal((await screen(ws, { amount: 5000, originator: true })).tx.outcome, 'ALLOW');
  assert.equal((await screen(ws, { amount: null, originator: false })).tx.outcome, 'ALLOW');
  const big = await screen(ws, { amount: ws.policy.rules.large_value.thresholdUsd, originator: true });
  assert.equal(big.tx.rule, 'large_value');
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  assert.equal((await screen(ws, { address: listed, amount: 5000, originator: false })).tx.outcome, 'BLOCK', 'a list hit outranks a hold');
  assert.deepEqual(evaluatePolicy(defaultPolicy(), { amountUsd: 1000, originator: false }), { id: 'blank_originator', thresholdUsd: 1000 });
});

test('bad input is refused and recorded nowhere', async () => {
  const { ws } = await fresh();
  const before = ws.ops.length;
  const receipts = ws.ledger.size;
  await expectRefusal(screen(ws, { address: 'has spaces' }), 'bad_address');
  await expectRefusal(screen(ws, { address: '' }), 'bad_address');
  await expectRefusal(screen(ws, { amount: -5 }), 'bad_amount');
  await expectRefusal(screen(ws, { amount: 1.5 }), 'bad_amount');
  await expectRefusal(screen(ws, { txHash: '<script>' }), 'bad_tx_hash');
  await expectRefusal(screen(ws, { actor: 'nobody' }), 'unknown_user');
  await expectRefusal(ws.apply({ op: 'nonsense', ts: tick() }), 'bad_op');
  await expectRefusal(ws.apply({ op: 'screen', ts: 'not a date', actor: 'api' }), 'bad_op');
  assert.equal(ws.ops.length, before);
  assert.equal(ws.ledger.size, receipts);
});

test('every screening produces a receipt the real verifier accepts, and tampering is caught', async () => {
  const { ws } = await fresh();
  const { receipt } = await screen(ws, { amount: 2500, originator: false });
  assert.equal(receipt.action.params.policy_rule, 'blank_originator');
  assert.equal(receipt.verdict.decision, 'HOLD');
  const index = ws.ledger.find(receipt.receipt_id).segment;
  assert.equal((await ws.ledger.verifySegment(index)).kind, 'pass');
  const file = JSON.parse(ws.ledger.segmentText(index));
  file.receipts.at(-1).action.params.amount_usd = 1;
  const outcome = await verifyText(JSON.stringify(file, null, 2));
  assert.equal(outcome.kind, 'fail');
  assert.ok(outcome.receipts.at(-1).failed.some((f) => f.id === 'binding'));
});

test('ledger: segments verify, link by signed head hashes, and stay under the verifier size limit', async () => {
  const { ws } = await fresh();
  const all = await ws.ledger.verifyAll();
  assert.equal(all.ok, true);
  assert.ok(ws.ledger.segments.length >= 4);
  assert.deepEqual(new Set(all.segments.map((s) => s.kind)), new Set(['pass']));
  for (let i = 0; i < ws.ledger.segments.length; i++) assert.ok(ws.ledger.segmentText(i).length < 200_000);
  assert.ok(ws.ledger.segments.every((s) => s.chars < MAX_SEGMENT_CHARS + 5000));
  const second = ws.ledger.segments[1].chain.receipts[0];
  assert.equal(second.action.type, 'segment_open');
  assert.equal(second.action.params.prior_segment_head, ws.ledger.segments[0].chain.receipts.at(-1).this_hash);
  // Each segment names one list version, so the verifier's label check holds across list changes.
  assert.deepEqual(new Set(ws.ledger.segments.map((s) => s.versionId)), new Set(['L1', 'L2']));
});

test('ledger: a broken segment link or a dropped segment is detected', async () => {
  const { ws } = await fresh();
  const { checkLinks } = await import('../js/ws/ledger.js');
  const chains = ws.ledger.segments.map((s) => JSON.parse(JSON.stringify(s.chain)));
  const kinds = chains.map(() => ({ kind: 'pass' }));
  assert.equal(checkLinks(chains, kinds).ok, true);
  const dropped = chains.filter((_, i) => i !== 1);
  assert.equal(checkLinks(dropped, dropped.map(() => ({ kind: 'pass' }))).ok, false);
  const forged = JSON.parse(JSON.stringify(chains));
  forged[2].receipts[0].action.params.prior_segment_head = '0'.repeat(64);
  assert.equal(checkLinks(forged, kinds).ok, false);
});

test('four-eyes: a hit cannot be cleared by one person', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const { created } = await screen(ws, { address: listed });
  const id = created[0].id;
  await expectRefusal(act(ws, id, 'analyst-a', 'propose_clear', { note: NOTE }), 'blocked'); // not in review yet
  await act(ws, id, 'analyst-a', 'start_review');
  await expectRefusal(act(ws, id, 'analyst-a', 'propose_clear', { note: 'short' }), 'note_required');
  await act(ws, id, 'analyst-a', 'propose_clear', { note: NOTE });
  const alert = ws.alertById.get(id);
  assert.equal(alert.status, 'in_review', 'proposal alone does not clear');
  assert.equal(alert.pending.by, 'analyst-a');
  await expectRefusal(act(ws, id, 'analyst-a', 'approve_clear'), 'forbidden'); // analysts cannot approve
  await expectRefusal(act(ws, id, 'analyst-b', 'approve_clear'), 'forbidden');
  await act(ws, id, 'approver-c', 'approve_clear');
  assert.equal(alert.status, 'cleared');
  assert.equal(alert.pending, null);
});

test('four-eyes: an approver cannot approve their own proposal, and a reject sends it back', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const { created } = await screen(ws, { address: listed });
  const id = created[0].id;
  await act(ws, id, 'approver-c', 'start_review');
  await act(ws, id, 'approver-c', 'propose_clear', { note: NOTE });
  await expectRefusal(act(ws, id, 'approver-c', 'approve_clear'), 'four_eyes');
  await expectRefusal(act(ws, id, 'approver-c', 'reject_clear', { note: NOTE }), 'four_eyes');
  await act(ws, id, 'admin-d', 'reject_clear', { note: 'Evidence is incomplete, please add it.' });
  assert.equal(ws.alertById.get(id).status, 'in_review');
  await act(ws, id, 'approver-c', 'propose_clear', { note: NOTE });
  await act(ws, id, 'admin-d', 'approve_clear');
  assert.equal(ws.alertById.get(id).status, 'cleared');
  const receipts = ws.alertById.get(id).timeline.map((t) => t.receiptId);
  assert.ok(receipts.every((r) => ws.ledger.find(r)), 'every step has a receipt');
  const approve = ws.ledger.find(receipts.at(-1)).receipt.action.params;
  assert.equal(approve.proposed_by, 'approver-c');
  assert.equal(approve.actor, 'admin-d');
});

test('holds follow the policy: four-eyes off lets one person clear; hits never do', async () => {
  const { ws } = await fresh();
  await ws.apply({ op: 'policySet', ts: tick(), actor: 'admin-d', key: 'fourEyes.hold', value: false });
  const { created } = await screen(ws, { amount: 5000, originator: false });
  const id = created[0].id;
  await act(ws, id, 'analyst-a', 'start_review');
  await act(ws, id, 'analyst-a', 'propose_clear', { note: NOTE });
  assert.equal(ws.alertById.get(id).status, 'cleared');
  assert.equal(ws.alertById.get(id).timeline.at(-1).action, 'clear');
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const hit = (await screen(ws, { address: listed })).created[0];
  await act(ws, hit.id, 'analyst-a', 'start_review');
  await act(ws, hit.id, 'analyst-a', 'propose_clear', { note: NOTE });
  assert.equal(ws.alertById.get(hit.id).status, 'in_review');
});

test('escalated alerts need a senior role; closed alerts reopen only with a note and approver rights', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const id = (await screen(ws, { address: listed })).created[0].id;
  await act(ws, id, 'analyst-a', 'start_review');
  await act(ws, id, 'analyst-a', 'escalate', { note: NOTE });
  await expectRefusal(act(ws, id, 'analyst-a', 'confirm', { note: NOTE }), 'blocked');
  await act(ws, id, 'approver-c', 'confirm', { note: NOTE });
  assert.equal(ws.alertById.get(id).status, 'confirmed');
  await expectRefusal(act(ws, id, 'analyst-a', 'assign', { assignee: 'analyst-b' }), 'blocked');
  await expectRefusal(act(ws, id, 'analyst-a', 'reopen', { note: NOTE }), 'forbidden');
  await act(ws, id, 'analyst-a', 'note', { note: 'A note is still allowed on a closed alert.' });
  await act(ws, id, 'approver-c', 'reopen', { note: NOTE });
  assert.equal(ws.alertById.get(id).status, 'in_review');
});

test('policy, roles and list updates are admin only, and changes are receipted', async () => {
  const { ws } = await fresh();
  const ops = ws.ops.length;
  await expectRefusal(ws.apply({ op: 'policySet', ts: tick(), actor: 'approver-c', key: 'rules.blank_originator.thresholdUsd', value: 2000 }), 'forbidden');
  await expectRefusal(ws.apply({ op: 'userRole', ts: tick(), actor: 'analyst-a', userId: 'analyst-b', role: 'admin' }), 'forbidden');
  await expectRefusal(ws.apply({ op: 'listUpdate', ts: tick(), actor: 'approver-c', toVersionId: 'L3' }), 'forbidden');
  assert.equal(ws.ops.length, ops);
  const before = ws.ledger.size;
  const { receipt } = await ws.apply({ op: 'policySet', ts: tick(), actor: 'admin-d', key: 'rules.blank_originator.thresholdUsd', value: 2500 });
  assert.equal(ws.policy.rules.blank_originator.thresholdUsd, 2500);
  assert.equal(ws.ledger.size, before + 1);
  assert.deepEqual([receipt.action.params.from, receipt.action.params.to], [1000, 2500]);
  await expectRefusal(ws.apply({ op: 'policySet', ts: tick(), actor: 'admin-d', key: 'rules.blank_originator.thresholdUsd', value: 2500 }), 'no_change');
  await expectRefusal(ws.apply({ op: 'policySet', ts: tick(), actor: 'admin-d', key: 'rules.blank_originator.thresholdUsd', value: 0 }), 'bad_value');
  await expectRefusal(ws.apply({ op: 'policySet', ts: tick(), actor: 'admin-d', key: 'nope', value: 1 }), 'bad_setting');
  await ws.apply({ op: 'userRole', ts: tick(), actor: 'admin-d', userId: 'analyst-b', role: 'approver' });
  assert.equal(ws.user('analyst-b').role, 'approver');
  await expectRefusal(ws.apply({ op: 'userRole', ts: tick(), actor: 'admin-d', userId: 'admin-d', role: 'analyst' }), 'last_admin');
  // Policy applies to later screenings only: the change did not re-open or re-decide old ones.
  assert.equal((await screen(ws, { amount: 2000, originator: false })).tx.outcome, 'ALLOW');
});

test('list update lookback: earlier clean payments to newly listed addresses become alerts', async () => {
  const { ws } = await fresh();
  assert.equal(ws.inForce.id, 'L2');
  assert.equal(ws.pendingVersion.id, 'L3');
  const plan = ws.planUpdate(ws.pendingVersion);
  assert.equal(plan.diff.added.length, 7);
  assert.ok(plan.newHits.length >= 2, 'seeded payments hit newly added addresses');
  const expected = new Set(plan.newHits.map((h) => h.address.toLowerCase()));
  const openBefore = ws.alerts.length;
  const { record, created } = await ws.apply({ op: 'listUpdate', ts: tick(), actor: 'admin-d', toVersionId: 'L3' });
  assert.equal(ws.inForce.id, 'L3');
  assert.equal(ws.pendingVersion, null);
  assert.deepEqual(new Set(record.newHits.map((h) => h.address.toLowerCase())), expected);
  const lookbackAlerts = created.filter((a) => a.kind === 'lookback');
  assert.equal(lookbackAlerts.length, expected.size);
  assert.equal(ws.alerts.length, openBefore + created.length);
  for (const alert of lookbackAlerts) {
    for (const txId of alert.txIds) assert.equal(ws.txById.get(txId).outcome, 'ALLOW', 'those payments were allowed at the time');
    assert.ok(ws.txById.get(alert.txIds[0]).flagged);
  }
  assert.ok(record.watchHits.length >= 1, 'a watchlist entry became a hit');
  assert.equal(record.removed.length, 3);
  await expectRefusal(ws.apply({ op: 'listUpdate', ts: tick(), actor: 'admin-d', toVersionId: 'L3' }), 'not_next');
  assert.equal((await ws.ledger.verifyAll()).ok, true, 'the new list version opens a new verified segment');
  assert.equal(ws.ledger.segments.at(-1).versionId, 'L3');
});

test('lookback does not repeat itself or re-flag payments that were already hits', async () => {
  const { ws } = await fresh();
  const { record } = await ws.apply({ op: 'listUpdate', ts: tick(), actor: 'admin-d', toVersionId: 'L3' });
  const flagged = new Set(record.newHits.flatMap((h) => h.txIds));
  assert.ok(flagged.size > 0);
  for (const tx of ws.txs) if (tx.outcome === 'BLOCK') assert.equal(tx.flagged, false);
  assert.equal(ws.planUpdate(ws.versions[2]).newHits.length, 0);
});

test('watchlist: add screens at once, re-screens on update, rejects duplicates', async () => {
  const { ws } = await fresh();
  const add = await ws.apply({ op: 'watchAdd', ts: tick(), actor: 'analyst-a', address: CLEAN, label: 'Example counterparty (demo)' });
  assert.equal(add.receipt.action.params.status, 'clear');
  await expectRefusal(ws.apply({ op: 'watchAdd', ts: tick(), actor: 'analyst-a', address: CLEAN.toUpperCase().replace('0X', '0x'), label: 'x' }), 'duplicate');
  await expectRefusal(ws.apply({ op: 'watchAdd', ts: tick(), actor: 'analyst-a', address: CLEAN, label: '' }), 'label_required');
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const hit = await ws.apply({ op: 'watchAdd', ts: tick(), actor: 'analyst-a', address: listed, label: 'Listed (demo)' });
  assert.equal(hit.created[0].kind, 'watchlist');
  await ws.apply({ op: 'watchRemove', ts: tick(), actor: 'analyst-a', address: CLEAN });
  assert.ok(!ws.watch.some((w) => w.address === CLEAN));
});

test('replay: the same seed and saved ops rebuild the same ledger head', async () => {
  const a = await fresh();
  const b = await fresh();
  assert.equal(a.ws.ledger.head(), b.ws.ledger.head());
  assert.equal(a.ws.ledger.size, b.ws.ledger.size);
  await screen(a.ws, { amount: 4000, originator: false });
  const id = a.ws.alerts.at(-1).id;
  await act(a.ws, id, 'analyst-a', 'start_review');
  const saved = snapshot(a.ws, ANCHOR);
  assert.equal(saved.ops.length, 2);
  const restored = await createWorkspace({ list, anchor: ANCHOR, savedOps: JSON.parse(JSON.stringify(saved.ops)) });
  assert.equal(restored.replayError, null);
  assert.equal(restored.ws.ledger.head(), a.ws.ledger.head());
  assert.equal(restored.ws.alertById.get(id).status, 'in_review');
  const broken = await createWorkspace({ list, anchor: ANCHOR, savedOps: [{ op: 'alertAction', ts: tick(), actor: 'analyst-a', alertId: 'AL-9999', action: 'note', note: 'x' }] });
  assert.ok(broken.replayError, 'bad saved state falls back to the clean history');
  assert.equal(broken.ws.ledger.head(), b.ws.ledger.head());
});

test('metrics add up to the underlying data', async () => {
  const { ws } = await fresh();
  const s = summary(ws, NOW, 30);
  assert.equal(s.allow + s.hold + s.block, s.total);
  assert.equal(s.total, ws.txs.filter((t) => Date.parse(t.ts) >= Date.parse('2026-10-08T00:00:00Z')).length);
  assert.equal(Object.values(s.byStatus).reduce((a, b) => a + b, 0), ws.alerts.length);
  assert.equal(s.receipts, ws.ledger.size);
  assert.equal(s.rows.length, 30);
  assert.equal(dailyVolume(ws, NOW, 7).length, 7);
  assert.equal(s.listVersion.id, 'L2');
});

test('evidence pack: range and case packs verify; edits are caught', async () => {
  const { ws } = await fresh();
  const range = await buildPack(ws, { type: 'range', from: '2026-10-25', to: '2026-10-31' }, { now: NOW, actor: 'analyst-a' });
  assert.ok(range.selection.count > 0);
  assert.equal(range.demo, true);
  assert.ok(range.segments.every((s) => s.chain.receipts.length === s.receipt_count));
  const ok = await verifyPack(JSON.stringify(range));
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));

  const approved = ws.alerts.find((a) => a.timeline.some((t) => t.action === 'approve_clear'));
  const casePack = await buildPack(ws, { type: 'case', alertId: approved.id }, { now: NOW, actor: 'approver-c' });
  assert.equal(casePack.cases.length, 1);
  assert.equal(casePack.approvals.length, 1);
  assert.notEqual(casePack.approvals[0].proposed_by, casePack.approvals[0].decided_by);
  assert.equal((await verifyPack(casePack)).ok, true);

  const editedRow = JSON.parse(JSON.stringify(range));
  editedRow.decisions[0].amount_usd = 1;
  const r1 = await verifyPack(editedRow);
  assert.equal(r1.ok, false);
  assert.ok(r1.checks.some((c) => c.id === 'digest' && !c.ok) && r1.checks.some((c) => c.id === 'decisions' && !c.ok));

  const editedReceipt = JSON.parse(JSON.stringify(range));
  editedReceipt.segments[0].chain.receipts[1].action.params.beneficiary_address = '0x2222222222222222222222222222222222222222';
  const r2 = await verifyPack(editedReceipt);
  assert.equal(r2.ok, false);
  assert.ok(r2.checks.some((c) => /verifier/.test(c.id) && !c.ok));

  // An attacker who also fixes the digest still fails the segment hash and the verifier.
  const { packDigest } = await import('../js/ws/evidence.js');
  editedReceipt.pack_digest = await packDigest(editedReceipt);
  const r3 = await verifyPack(editedReceipt);
  assert.equal(r3.ok, false);
  assert.ok(r3.checks.some((c) => /hash$/.test(c.id) && !c.ok));

  const forgedApproval = JSON.parse(JSON.stringify(casePack));
  forgedApproval.approvals[0].proposed_by = forgedApproval.approvals[0].decided_by;
  forgedApproval.pack_digest = await packDigest(forgedApproval);
  assert.equal((await verifyPack(forgedApproval)).checks.find((c) => c.id === 'approvals').ok, false);

  assert.equal((await verifyPack('not json')).ok, false);
  assert.equal((await verifyPack({ format: 'other' })).ok, false);
  await assert.rejects(buildPack(ws, { type: 'range', from: '2020-01-01', to: '2020-01-02' }, { now: NOW, actor: 'analyst-a' }), /Nothing in that scope/);
});

test('evidence report escapes everything it prints', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const id = (await screen(ws, { address: listed })).created[0].id;
  await act(ws, id, 'analyst-a', 'start_review');
  await act(ws, id, 'analyst-a', 'note', { note: '<script>alert(1)</script> & "quoted"' });
  const pack = await buildPack(ws, { type: 'case', alertId: id }, { now: NOW, actor: 'analyst-a' });
  const html = packHtml(pack);
  assert.ok(!html.includes('<script>alert'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot;'));
  assert.ok(html.includes(pack.pack_digest));
  assert.ok(/Demo/.test(html));
});

test('batch: parsing, limits, results and a safe CSV export', async () => {
  const { ws } = await fresh();
  const listed = ws.inForce.byAddress.values().next().value[0].address;
  const csv = `address,amount_usd,tx_hash,originator\n${CLEAN},"1,500",0xabc,no\n${listed},200,,yes\nbad address,10,,\n${CLEAN},12.6,,yes\n${CLEAN},abc,,\n${CLEAN},50,,maybe\n=cmd|' /C calc'!A0,5,,yes\n`;
  const parsed = parseBatch(csv);
  assert.equal(parsed.rows.length, 7);
  assert.equal(parsed.rows[0].amount, 1500);
  assert.equal(parsed.rows[3].amount, 13);
  assert.ok(parsed.rows[3].notes.length === 1);
  assert.ok(parsed.rows[2].problems.length && parsed.rows[4].problems.length && parsed.rows[5].problems.length);
  const results = await runBatch(ws, parsed.rows, { actor: 'analyst-a', batchId: 'B1', now: () => new Date(tick()) });
  assert.deepEqual(results.map((r) => r.status), ['HOLD', 'BLOCK', 'INVALID', 'ALLOW', 'INVALID', 'INVALID', 'INVALID']);
  assert.ok(results.filter((r) => r.status !== 'INVALID').every((r) => ws.ledger.find(r.receiptId)));
  assert.ok(results[0].alertId && results[1].alertId && !results[3].alertId);
  const out = resultsCsv(results);
  assert.ok(!/^=/m.test(out), 'no cell starts with a formula character');
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('a,"b"'), '"a,""b"""');
  assert.deepEqual(parseCsv('a,"b ""q"" c",d\r\n\r\ne,f,g'), [['a', 'b "q" c', 'd'], ['e', 'f', 'g']]);
  assert.throws(() => parseCsv('a,"open'), /quote/);
  const headerless = parseBatch(`${CLEAN}\n${listed}`);
  assert.equal(headerless.rows.length, 2);
  const many = parseBatch(Array.from({ length: MAX_BATCH_ROWS + 5 }, () => CLEAN).join('\n'));
  assert.equal(many.rows.length, MAX_BATCH_ROWS);
  assert.equal(many.truncated, true);
  assert.ok(parseBatch('').error);
  assert.ok(parseBatch('a,"open').error);
});
