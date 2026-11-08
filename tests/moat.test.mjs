// Unit tests for the moat features: receipt network, payment gate, examiner role, archive data, palette, chart math.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createWorkspace } from '../js/ws/session.js';
import { WorkspaceError, PERMISSIONS } from '../js/ws/engine.js';
import { loadDemoNetwork, receiveInbound, runGate, runGatePreset, shareEnv } from '../js/ws/net-flow.js';
import { cloneShare, verifyShare } from '../js/ws/network.js';
import { checkReceipt } from '../js/ws/receipt-check.js';
import { evaluateGate } from '../js/ws/gate.js';
import { gateSummary, networkSummary } from '../js/ws/net-metrics.js';
import { niceMax4, monotonePath } from '../js/ws/chartx.js';
import { parseInterval } from '../js/ws/view-proofgap.js';
import { timelineMarks } from '../js/ws/view-archive.js';
import { CVD_KINDS, GROUPS, MIN_CONTRAST, MIN_DELTA_E, PALETTE, SURFACE, contrast, minSeparation } from '../js/ws/palette-colors.js';

const list = JSON.parse(readFileSync(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8'));
const ANCHOR = new Date('2026-11-06T10:00:00.000Z');
let clock = Date.parse('2026-11-06T11:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();
const CLEAN = '0x1111111111111111111111111111111111111111';

async function fresh() {
  const { network } = await loadDemoNetwork(null);
  const { ws } = await createWorkspace({ list, anchor: ANCHOR, network });
  return { ws, network };
}
const inbound = (ws, network, over) => receiveInbound(ws, network, { actor: 'analyst-a', senderKeyId: network.members[0].keyId, kind: 'valid', address: CLEAN, chain: 'ethereum', amountUsd: 900, ts: tick(), ...over });

test('an accepted receipt verifies offline and skips the second screening', async () => {
  const { ws, network } = await fresh();
  const screened = ws.txs.length;
  const out = await inbound(ws, network, {});
  assert.equal(out.record.outcome, 'ACCEPTED');
  assert.equal(out.result.basis, 'issuer_word');
  assert.equal(ws.txs.length, screened, 'no screening happened');
  assert.equal(out.record.listVersionId, ws.inForceId);
  const share = network.shares.get(out.record.shareId);
  for (const r of share.bundle.receipts) assert.equal((await checkReceipt(r, { expectKey: share.issuer.key_id })).ok, true);
});

test('tampered, stale, unknown-key and revoked receipts are refused, and the payment is screened here', async () => {
  const { ws, network } = await fresh();
  const cases = [['tampered', 'bad_signature'], ['stale', 'stale_list'], ['unknown', 'unknown_key'], ['old', 'expired'], ['listed', 'on_own_list']];
  for (const [kind, code] of cases) {
    const before = ws.txs.length;
    const listed = [...ws.inForce.byAddress.values()].map((e) => e[0]).find((e) => !e.synthetic && /^0x[0-9a-f]{40}$/i.test(e.address)).address;
    const out = await inbound(ws, network, kind === 'listed' ? { kind, address: listed } : { kind });
    assert.equal(out.record.outcome, 'REFUSED', kind);
    assert.ok(out.record.reasons.some((r) => r.code === code), `${kind} -> ${code}, got ${out.record.reasons.map((r) => r.code)}`);
    assert.equal(ws.txs.length, before + 1, `${kind} was screened here`);
  }
  const c = network.members[2];
  assert.equal(ws.member(c.keyId).status, 'revoked');
  const out = await inbound(ws, network, { senderKeyId: c.keyId });
  assert.ok(out.record.reasons.some((r) => r.code === 'key_revoked'));
});

test('a share is used once, and no receipt means screened here', async () => {
  const { ws, network } = await fresh();
  const first = await inbound(ws, network, {});
  assert.equal(first.record.outcome, 'ACCEPTED');
  const again = await inbound(ws, network, { kind: 'reuse' });
  assert.ok(again.record.reasons.some((r) => r.code === 'reused'));
  const none = await inbound(ws, network, { kind: 'none' });
  assert.equal(none.record.outcome, 'NONE');
  assert.ok(none.screen);
});

test('an edited receipt fails verifyShare directly, with every reason reported', async () => {
  const { ws, network } = await fresh();
  const sender = network.members[0];
  const v = ws.inForce;
  const share = await sender.makeShare({ address: CLEAN, chain: 'ethereum', amountUsd: 5, listDigest: v.digest, listLabel: v.label, ts: new Date(Date.now() - 1000) });
  const env = shareEnv(ws, { now: new Date(), want: { address: CLEAN, chain: 'ethereum', counterparty: null } });
  assert.equal((await verifyShare(share, env)).accepted, true);
  const bad = cloneShare(share);
  bad.bundle.receipts[0].action.params.beneficiary_address = '0x2222222222222222222222222222222222222222';
  const res = await verifyShare(bad, env);
  assert.equal(res.accepted, false);
  assert.equal(res.headline.code, 'bad_signature');
  assert.ok(res.reasons.some((r) => r.code === 'wrong_scope'));
});

test('the engine itself refuses an accepted record that contradicts state', async () => {
  const { ws, network } = await fresh();
  const revoked = network.members[2];
  await assert.rejects(ws.apply({ op: 'netReliance', ts: tick(), actor: 'analyst-a', outcome: 'ACCEPTED', reasons: [], keyId: revoked.keyId, shareId: 'shr:x', address: CLEAN, chain: 'ethereum', listDigest: ws.inForce.digest }), (e) => e instanceof WorkspaceError && e.code === 'reliance_invalid');
  await assert.rejects(ws.apply({ op: 'netReliance', ts: tick(), actor: 'analyst-a', outcome: 'ACCEPTED', reasons: [], keyId: network.members[0].keyId, shareId: 'shr:y', address: CLEAN, chain: 'ethereum', listDigest: ws.versions[0].digest }), (e) => e.code === 'reliance_invalid');
});

test('pin and revoke are receipted, admin only, and a revoked key cannot be pinned again', async () => {
  const { ws, network } = await fresh();
  const extra = await network.addMember('Demo Exchange E');
  await assert.rejects(ws.apply({ op: 'netTrust', ts: tick(), actor: 'analyst-a', action: 'register', keyId: extra.keyId, name: extra.name }), (e) => e.code === 'forbidden');
  await ws.apply({ op: 'netTrust', ts: tick(), actor: 'admin-d', action: 'register', keyId: extra.keyId, name: extra.name });
  const pinned = await ws.apply({ op: 'netTrust', ts: tick(), actor: 'admin-d', action: 'pin', keyId: extra.keyId });
  assert.equal(pinned.receipt.action.type, 'network_trust_change');
  const revoked = await ws.apply({ op: 'netTrust', ts: tick(), actor: 'admin-d', action: 'revoke', keyId: extra.keyId, reason: 'Demo: key lost on a test laptop.' });
  assert.equal(revoked.member.status, 'revoked');
  await assert.rejects(ws.apply({ op: 'netTrust', ts: tick(), actor: 'admin-d', action: 'pin', keyId: extra.keyId }), (e) => e.code === 'revoked');
  assert.equal((await ws.ledger.verifyAll()).ok, true);
});

test('the gate blocks without a receipt and releases with a current one', async () => {
  const { ws } = await fresh();
  const now = new Date('2026-11-06T12:00:00Z');
  const none = await runGatePreset(ws, 'none', { actor: 'analyst-a', now });
  assert.equal(none.record.release, false);
  assert.deepEqual(none.record.reasons, ['no_receipt']);
  const ok = await runGatePreset(ws, 'screened', { actor: 'analyst-a', now: new Date(now.getTime() + 1000) });
  assert.equal(ok.record.release, true);
  const hit = await runGatePreset(ws, 'hit', { actor: 'analyst-a', now: new Date(now.getTime() + 2000) });
  assert.deepEqual(hit.record.reasons, ['not_clear']);
  const stale = await runGatePreset(ws, 'stale', { actor: 'analyst-a', now: new Date(now.getTime() + 3000) });
  assert.ok(stale.record.reasons.includes('stale_list'));
  assert.equal(gateSummary(ws).total >= 4, true);
  assert.equal(ws.ledger.entries.at(-1).receipt.action.type, 'gate_decision');
});

test('evaluateGate covers each block reason', () => {
  const base = { type: 'stablecoin_payment_screen', outcome: 'ALLOW', address: '0xA', listDigest: 'd', decidedAt: '2026-11-06T10:00:00Z' };
  const now = new Date('2026-11-06T11:00:00Z');
  const run = (over, extra = {}) => evaluateGate({ presented: { ...base, ...over }, valid: true, address: '0xa', now, listDigest: 'd', ...extra });
  assert.equal(run({}).release, true);
  assert.deepEqual(run({ address: '0xB' }).reasons, ['wrong_address']);
  assert.deepEqual(run({ outcome: 'HOLD' }).reasons, ['not_clear']);
  assert.deepEqual(run({ listDigest: 'old' }).reasons, ['stale_list']);
  assert.deepEqual(run({ decidedAt: '2026-11-04T10:00:00Z' }).reasons, ['expired']);
  assert.deepEqual(run({}, { valid: false }).reasons, ['invalid_receipt']);
  assert.deepEqual(evaluateGate({ presented: null, valid: false, address: 'x', now, listDigest: 'd' }).reasons, ['no_receipt']);
});

test('the examiner can open packs but cannot change or record anything', async () => {
  const { ws, network } = await fresh();
  assert.deepEqual(PERMISSIONS.examiner, ['open_pack']);
  const size = ws.ledger.size;
  const attempts = [
    { op: 'screen', address: CLEAN, amount: 10 }, { op: 'watchAdd', address: CLEAN, label: 'Demo label' }, { op: 'policySet', key: 'fourEyes.hold', value: false },
    { op: 'userRole', userId: 'analyst-a', role: 'admin' }, { op: 'evidenceExport', scope: { type: 'all' }, packDigest: 'x', receiptCount: 1, segmentCount: 1 },
    { op: 'netTrust', action: 'pin', keyId: network.members[0].keyId }, { op: 'listUpdate', toVersionId: 'L3' },
    { op: 'gateCheck', address: CLEAN, ref: null }, { op: 'alertAction', alertId: ws.alerts[0].id, action: 'note', note: 'A note from the examiner.' },
    { op: 'netReliance', outcome: 'NONE', reasons: [], address: CLEAN },
  ];
  for (const a of attempts) await assert.rejects(ws.apply({ ts: tick(), actor: 'examiner-e', ...a }), (e) => e instanceof WorkspaceError, a.op);
  assert.equal(ws.ledger.size, size);
  assert.equal(ws.can('examiner-e', 'open_pack'), true);
  assert.equal(ws.can('examiner-e', 'export'), false);
});

test('seeded network history has every refusal reason and a verifying ledger', async () => {
  const { ws } = await fresh();
  const sum = networkSummary(ws);
  for (const code of ['bad_signature', 'unknown_key', 'key_revoked', 'stale_list', 'reused', 'on_own_list', 'no_receipt']) assert.ok(sum.refusedByReason[code] > 0, code);
  assert.ok(sum.accepted > 10);
  assert.equal((await ws.ledger.verifyAll()).ok, true);
  void runGate;
});

// ---- real data -----------------------------------------------------------------------------

const YC = `${homedir()}/ventures/tollgate-yc`;
const NET = `${homedir()}/ventures/tollgate-network`;
const archive = JSON.parse(readFileSync(new URL('../data/archive.json', import.meta.url), 'utf8'));
const proof = JSON.parse(readFileSync(new URL('../data/proofgap.json', import.meta.url), 'utf8'));
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('archive and proof-gap data carry the source hashes and the headline numbers', () => {
  assert.equal(archive.postings.length, 10);
  assert.equal(archive.live_proof.anchored, 232);
  assert.equal(archive.seals.seals.every((s) => s.bitcoin_height === 974328), true);
  assert.equal(archive.snapshot.list_digest, list.list_digest);
  assert.equal(archive.snapshot.raw_sha256, list.raw_sha256);
  const head = proof.rows.find((r) => r.stream === 'USDC (Ethereum)' && r.subset.startsWith('after'));
  assert.equal(head.gap, '93.4% [86.7%, 100.0%]');
  assert.equal(head.n, 61);
  assert.deepEqual(parseInterval(head.gap), { point: 93.4, lo: 86.7, hi: 100 });
  assert.equal(proof.rows.find((r) => r.stream === 'USDT (Tron)' && r.subset === 'all').n, 331);
  assert.equal(proof.live.k, 7);
  assert.equal(proof.live.N, 10);
  assert.ok(timelineMarks(archive).length > 30);
});

test('archive data matches the source files when they are on this machine', { skip: !existsSync(YC) || !existsSync(NET) }, () => {
  for (const ref of [archive.snapshot.source, archive.mirror.source, archive.mirror.provenance, archive.live_proof.source, archive.live_proof.summary, ...archive.postings.flatMap((p) => [p.anchor.ots, p.anchor.tsr])]) {
    assert.equal(sha(`${YC}/${ref.path}`), ref.sha256, ref.path);
  }
  assert.equal(sha(`${NET}/${archive.seals.source.path}`), archive.seals.source.sha256);
  assert.equal(sha(`${YC}/${proof.source.path}`), proof.source.sha256);
  const report = readFileSync(`${YC}/${proof.source.path}`, 'utf8');
  for (const r of proof.rows) assert.ok(report.includes(`| ${r.stream} | ${r.subset} |`) && report.includes(`**${r.gap}**`), r.stream);
  const ledger = readFileSync(`${YC}/results/live_proof/inputs/ledger.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const p of archive.postings) assert.equal(ledger.find((r) => r.receipt_id === p.receipt_id).action.params.content_sha256, p.content_sha256);
});

// ---- palette and chart math ----------------------------------------------------------------

test('chart colours reach 3:1 on their card and stay apart for colour-blind viewers', () => {
  for (const theme of ['light', 'dark']) {
    for (const [name, hex] of Object.entries(PALETTE[theme])) assert.ok(contrast(hex, SURFACE[theme]) >= MIN_CONTRAST, `${theme} ${name} ${contrast(hex, SURFACE[theme]).toFixed(2)}`);
    for (const group of GROUPS) assert.ok(minSeparation(theme, group) >= MIN_DELTA_E, `${theme} ${group} ${minSeparation(theme, group).toFixed(1)}`);
  }
  assert.deepEqual(CVD_KINDS, ['protanopia', 'deuteranopia', 'tritanopia']);
});

test('the stylesheet repeats the validated palette', () => {
  const css = readFileSync(new URL('../css/moat.css', import.meta.url), 'utf8');
  const block = (re) => css.match(re)[0];
  const light = block(/:root \{\n  --k-blue[\s\S]*?\}/);
  const dark = block(/:root\[data-theme='dark'\] \{\n  --k-blue[\s\S]*?\}/);
  for (const [name, hex] of Object.entries(PALETTE.light)) assert.ok(light.includes(`--k-${name}: ${hex};`), `light ${name}`);
  for (const [name, hex] of Object.entries(PALETTE.dark)) assert.ok(dark.includes(`--k-${name}: ${hex};`), `dark ${name}`);
});

test('axis maximum gives round ticks and the curve never overshoots', () => {
  assert.equal(niceMax4(0, true), 4);
  assert.equal(niceMax4(5, true), 8);
  assert.equal(niceMax4(11, true) % 4, 0);
  assert.equal(niceMax4(37), 40);
  const d = monotonePath([[0, 10], [10, 10], [20, 0], null, [30, 5]]);
  assert.ok(d.startsWith('M0.0 10.0C') && d.includes('M30.0 5.0'));
  const ys = [...d.matchAll(/ (-?[\d.]+)(?=[CM]|$)/g)].map((m) => Number(m[1]));
  assert.ok(ys.every((y) => y >= 0 && y <= 10));
});
