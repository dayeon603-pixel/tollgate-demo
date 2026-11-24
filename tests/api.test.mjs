// Unit tests for the workspace API (js/ws/api.js) and the key and webhook ops in the engine:
// key auth and scopes, screening through the API, idempotency, usage metering, webhook events
// and signatures, the public verify route, and the audit export with its hash-chain check.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspace, snapshot } from '../js/ws/session.js';
import { WorkspaceError, PERMISSIONS } from '../js/ws/engine.js';
import {
  auditCsv, auditJson, checkAuditJson, eventOf, handleApiRequest, meterOf, newApiKey, newWebhookSecret,
  signWebhook, usageCsv, usageReport, verifyWebhook, webhookDeliveries,
} from '../js/ws/api.js';
import { parseCsv } from '../js/ws/util.js';

const list = JSON.parse(await readFile(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8'));
const ANCHOR = new Date('2026-11-06T10:00:00.000Z');
let clock = Date.parse('2026-11-06T11:00:00.000Z');
const tick = () => new Date((clock += 60_000)).toISOString();
const CLEAN = '0x1111111111111111111111111111111111111111';
const CLEAN2 = '0x2222222222222222222222222222222222222222';

/** Deterministic bytes for key generation, so tests do not depend on crypto randomness. */
function seeded(seed) {
  let x = seed;
  return (n) => Uint8Array.from({ length: n }, () => { x = (x * 1103515245 + 12345) % 2 ** 31; return x & 255; });
}

async function fresh(savedOps = []) {
  return (await createWorkspace({ list, anchor: ANCHOR, savedOps })).ws;
}

async function makeKey(ws, scopes, seed = 1, name = 'Payments service') {
  const k = await newApiKey(seeded(seed));
  await ws.apply({ op: 'apiKeyCreate', ts: tick(), actor: 'admin-d', keyId: k.keyId, name, scopes, keyHash: k.hash, prefix: k.prefix });
  return k;
}

const call = (ws, method, path, { key, body, headers = {}, now } = {}) => handleApiRequest(ws, {
  method, path, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { ...(key ? { Authorization: `Bearer ${key.secret}` } : {}), ...headers },
}, { now: now ?? new Date(tick()) });

const listedEth = (ws) => [...ws.inForce.byAddress.values()].map((e) => e[0].address).find((a) => a.startsWith('0x'));

async function expectRefusal(promise, code) {
  await assert.rejects(promise, (e) => e instanceof WorkspaceError && e.code === code, `expected refusal ${code}`);
}

test('keys: format, hash only, admin only, validation', async () => {
  const ws = await fresh();
  const k = await newApiKey(seeded(7));
  assert.match(k.secret, /^tg_[A-Za-z0-9_-]{43}$/);
  assert.equal(k.prefix, k.secret.slice(0, 7));
  assert.match(k.hash, /^[0-9a-f]{64}$/);
  const op = { op: 'apiKeyCreate', actor: 'admin-d', keyId: k.keyId, name: 'Svc', scopes: ['screen'], keyHash: k.hash, prefix: k.prefix };
  await expectRefusal(ws.apply({ ...op, ts: tick(), actor: 'analyst-a' }), 'forbidden');
  await expectRefusal(ws.apply({ ...op, ts: tick(), scopes: [] }), 'scopes_required');
  await expectRefusal(ws.apply({ ...op, ts: tick(), scopes: ['admin'] }), 'bad_scope');
  await expectRefusal(ws.apply({ ...op, ts: tick(), name: '  ' }), 'name_required');
  await expectRefusal(ws.apply({ ...op, ts: tick(), keyHash: 'abc' }), 'bad_op');
  const created = await ws.apply({ ...op, ts: tick() });
  assert.equal(created.receipt.action.type, 'api_key_change');
  assert.ok(!JSON.stringify(created.receipt).includes(k.secret), 'the secret is never signed');
  assert.ok(!JSON.stringify(created.receipt).includes(k.hash), 'the hash is not in the receipt either');
  assert.ok(!JSON.stringify(ws.ops).includes(k.secret), 'the secret is never saved');
  await expectRefusal(ws.apply({ ...op, ts: tick() }), 'duplicate');
  assert.ok(PERMISSIONS.admin.includes('integrations'));
  assert.ok(!PERMISSIONS.approver.includes('integrations'));
});

test('auth: missing, wrong, revoked keys and missing scope', async () => {
  const ws = await fresh();
  const reader = await makeKey(ws, ['read'], 2);
  const screener = await makeKey(ws, ['screen'], 3);
  const body = { chain: 'ETH', to_address: CLEAN, amount_usd: 10, originator_info_present: true };
  let r = await call(ws, 'POST', '/v1/screen', { body });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'invalid_api_key');
  r = await call(ws, 'POST', '/v1/screen', { body, key: { secret: `tg_${'x'.repeat(43)}` } });
  assert.equal(r.status, 401);
  r = await call(ws, 'POST', '/v1/screen', { body, key: reader });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'insufficient_scope');
  assert.match(r.body.error.request_id, /^req_/);
  r = await call(ws, 'POST', '/v1/screen', { body, key: screener });
  assert.equal(r.status, 200);
  await ws.apply({ op: 'apiKeyRevoke', ts: tick(), actor: 'admin-d', keyId: screener.keyId });
  r = await call(ws, 'POST', '/v1/screen', { body, key: screener });
  assert.equal(r.status, 401, 'a revoked key stops working at once');
  await expectRefusal(ws.apply({ op: 'apiKeyRevoke', ts: tick(), actor: 'admin-d', keyId: screener.keyId }), 'blocked');
});

test('POST /v1/screen: signed decision with key id, both sides screened, validation', async () => {
  const ws = await fresh();
  const key = await makeKey(ws, ['screen', 'read']);
  const listed = listedEth(ws);
  const clean = await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: CLEAN, from_address: CLEAN2, amount_usd: 50, originator_info_present: true, reference: 'pay-1' } });
  assert.equal(clean.status, 200);
  assert.equal(clean.body.outcome, 'ALLOW');
  assert.equal(clean.body.receipt.action.params.api_key_id, key.keyId);
  assert.equal(clean.body.receipt.action.params.originator_address, CLEAN2);
  assert.equal(clean.body.receipt.action.params.reference, 'pay-1');
  assert.equal(clean.body.list_in_force.label, ws.inForce.real ? 'real OFAC snapshot (bundled)' : 'demo reconstruction');
  const toHit = await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: listed, amount_usd: 5 } });
  assert.equal(toHit.body.outcome, 'BLOCK');
  assert.equal(toHit.body.decision, 'DENY');
  assert.ok(toHit.body.alert_id);
  const fromHit = await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: CLEAN, from_address: listed, amount_usd: 5, originator_info_present: true } });
  assert.equal(fromHit.body.outcome, 'BLOCK', 'a listed sender blocks too');
  assert.ok(fromHit.body.reasons.includes('side=originator'));
  assert.equal(ws.alertById.get(fromHit.body.alert_id).address.toLowerCase(), listed.toLowerCase(), 'the alert names the listed side');
  const bad = [
    [{ chain: 'eth', to_address: CLEAN }, 'bad_chain'],
    [{ chain: 'ETH' }, 'to_address_required'],
    [{ chain: 'ETH', to_address: CLEAN, amount_usd: 1.5 }, 'bad_amount'],
    [{ chain: 'ETH', to_address: CLEAN, amount_usd: -1 }, 'bad_amount'],
    [{ chain: 'ETH', to_address: CLEAN, surprise: 1 }, 'unknown_field'],
    [{ chain: 'ETH', to_address: 'not an address' }, 'bad_address'],
    [{ chain: 'ETH', to_address: 'nope' }, 'bad_address'],
    [{ chain: 'ETH', to_address: '0x123' }, 'bad_address'],
    [{ chain: 'ETH', to_address: CLEAN, from_address: 'short' }, 'bad_address'],
    [{ chain: 'ETH', to_address: CLEAN, originator_info_present: 'yes' }, 'bad_originator'],
  ];
  const before = ws.ledger.size;
  for (const [body, code] of bad) {
    const r = await call(ws, 'POST', '/v1/screen', { key, body });
    assert.equal(r.body.error?.code, code, JSON.stringify(body));
    assert.ok(r.status >= 400 && r.status < 500);
  }
  const notJson = await handleApiRequest(ws, { method: 'POST', path: '/v1/screen', body: '{nope', headers: { authorization: `Bearer ${key.secret}` } });
  assert.equal(notJson.body.error.code, 'bad_json');
  const huge = await handleApiRequest(ws, { method: 'POST', path: '/v1/screen', body: 'x'.repeat(200_001), headers: { authorization: `Bearer ${key.secret}` } });
  assert.equal(huge.status, 413);
  assert.equal(ws.ledger.size, before, 'refused requests sign nothing');
  assert.equal((await call(ws, 'GET', '/v1/screen', { key })).status, 405);
  assert.equal((await call(ws, 'GET', '/v1/nothing', { key })).status, 404);
  const got = await call(ws, 'GET', `/v1/receipts/${encodeURIComponent(clean.body.receipt.receipt_id)}`, { key });
  assert.deepEqual(got.body, clean.body.receipt);
  assert.equal((await call(ws, 'GET', '/v1/receipts/rcpt:nope', { key })).status, 404);
});

test('idempotency: a retry returns the stored decision and is metered once; a changed body is refused', async () => {
  const ws = await fresh();
  const key = await makeKey(ws, ['screen', 'read']);
  const body = { chain: 'ETH', to_address: CLEAN, amount_usd: 70, originator_info_present: true };
  const headers = { 'Idempotency-Key': 'order-42' };
  const first = await call(ws, 'POST', '/v1/screen', { key, body, headers });
  const size = ws.ledger.size;
  const again = await call(ws, 'POST', '/v1/screen', { key, body: { originator_info_present: true, amount_usd: 70, to_address: CLEAN, chain: 'ETH' }, headers });
  assert.equal(again.status, 200);
  assert.equal(again.headers['Idempotent-Replayed'], 'true');
  assert.equal(again.body.receipt.receipt_id, first.body.receipt.receipt_id);
  assert.equal(ws.ledger.size, size, 'no second decision is signed');
  const changed = await call(ws, 'POST', '/v1/screen', { key, body: { ...body, amount_usd: 71 }, headers });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'idempotency_key_reused');
  const badKey = await call(ws, 'POST', '/v1/screen', { key, body, headers: { 'Idempotency-Key': 'has space' } });
  assert.equal(badKey.body.error.code, 'bad_idempotency_key');
  const day = first.body.screened_at.slice(0, 10);
  const usage = usageReport(ws, { from: day, to: day, keyId: key.keyId });
  assert.equal(usage.totals.screened, 1);
  // The idempotency record survives a reload: it is rebuilt from the saved ops.
  const anchorSnap = snapshot(ws, ANCHOR);
  const restored = await fresh(anchorSnap.ops);
  const replay = await call(restored, 'POST', '/v1/screen', { key, body, headers });
  assert.equal(replay.body.receipt.receipt_id, first.body.receipt.receipt_id);
});

test('usage: one count per signed decision, by key and period, with outcome mix and CSV', async () => {
  const ws = await fresh();
  const a = await makeKey(ws, ['screen', 'read'], 11, 'Exchange hot wallet');
  const b = await makeKey(ws, ['screen'], 12, 'OTC desk');
  const listed = listedEth(ws);
  const at = (iso) => new Date(iso);
  await call(ws, 'POST', '/v1/screen', { key: a, body: { chain: 'ETH', to_address: CLEAN, amount_usd: 1, originator_info_present: true }, now: at('2026-11-07T01:00:00Z') });
  await call(ws, 'POST', '/v1/screen', { key: a, body: { chain: 'ETH', to_address: listed, amount_usd: 1 }, now: at('2026-11-07T02:00:00Z') });
  await call(ws, 'POST', '/v1/screen', { key: a, body: { chain: 'ETH', to_address: CLEAN, amount_usd: 50_000, originator_info_present: true }, now: at('2026-11-08T02:00:00Z') });
  await call(ws, 'POST', '/v1/screen', { key: b, body: { chain: 'ETH', to_address: CLEAN, amount_usd: 1, originator_info_present: true }, now: at('2026-11-08T03:00:00Z') });
  const day = usageReport(ws, { from: '2026-11-07', to: '2026-11-08', group: 'day' });
  const apiRows = day.rows.filter((r) => r.kind === 'api_key');
  assert.deepEqual(apiRows.map((r) => [r.period, r.key_name, r.screened, r.allow, r.hold, r.block]), [
    ['2026-11-07', 'Exchange hot wallet', 2, 1, 0, 1],
    ['2026-11-08', 'Exchange hot wallet', 1, 0, 1, 0],
    ['2026-11-08', 'OTC desk', 1, 1, 0, 0],
  ].sort((x, y) => (x[0] === y[0] ? ws.apiKeys.find((k) => k.name === x[1]).id.localeCompare(ws.apiKeys.find((k) => k.name === y[1]).id) : x[0].localeCompare(y[0]))));
  const month = usageReport(ws, { from: '2026-11-01', to: '2026-11-30', group: 'month', keyId: a.keyId });
  assert.deepEqual(month.rows.map((r) => [r.period, r.screened]), [['2026-11', 3]]);
  // Over the API: a key sees its own usage unless it asks for all keys.
  const own = await call(ws, 'GET', '/v1/usage?from=2026-11-07&to=2026-11-08&group=month', { key: a });
  assert.equal(own.body.totals.screened, 3);
  const csv = await call(ws, 'GET', '/v1/usage?from=2026-11-07&to=2026-11-08&format=csv', { key: a });
  assert.equal(csv.headers['Content-Type'], 'text/csv');
  const rows = parseCsv(csv.body);
  assert.deepEqual(rows[0], ['period', 'meter', 'kind', 'key_name', 'screened', 'allow', 'hold', 'block']);
  assert.equal(rows.length, 3);
  assert.equal(usageCsv(month).split('\n').length >= 2, true);
  // Empty and bad ranges.
  assert.equal(usageReport(ws, { from: '2020-01-01', to: '2020-01-01' }).totals.screened, 0);
  for (const [q, code] of [['from=2026-11-08&to=2026-11-07', 'bad_range'], ['from=2026-02-30&to=2026-03-01', 'bad_date'], ['from=yesterday&to=2026-11-08', 'bad_date'], ['from=2020-01-01&to=2026-11-08', 'bad_range'], ['from=2026-11-07&to=2026-11-08&group=week', 'bad_group']]) {
    const r = await call(ws, 'GET', `/v1/usage?${q}`, { key: a });
    assert.equal(r.status, 422, q);
    assert.equal(r.body.error.code, code, q);
  }
  assert.equal((await call(ws, 'GET', '/v1/usage?from=2026-11-07&to=2026-11-08', { key: b })).status, 403, 'usage needs read');
  // Seeded history is metered too, labelled for what it is.
  const kinds = new Set(ws.txs.map((t) => meterOf(t).kind));
  assert.ok(kinds.has('demo_feed') || kinds.has('console'));
});

test('webhooks: validation, events from the ledger, signatures that verify and fail when tampered', async () => {
  const ws = await fresh();
  const { hookId, secret } = newWebhookSecret(seeded(5));
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{40}$/);
  const base = { op: 'webhookAdd', actor: 'admin-d', hookId, secret, events: ['decision.created', 'address.newly_listed'] };
  await expectRefusal(ws.apply({ ...base, ts: tick(), url: 'http://example.com/hook' }), 'bad_url');
  await expectRefusal(ws.apply({ ...base, ts: tick(), url: 'https://user:pw@example.com/hook' }), 'bad_url');
  await expectRefusal(ws.apply({ ...base, ts: tick(), url: 'https://example.com/hook', events: ['alert.everything'] }), 'bad_event');
  await expectRefusal(ws.apply({ ...base, ts: tick(), url: 'https://example.com/hook', actor: 'approver-c' }), 'forbidden');
  const added = await ws.apply({ ...base, ts: tick(), url: 'https://example.com/hook' });
  assert.ok(!JSON.stringify(added.receipt).includes(secret), 'the secret is not signed');
  const hook = ws.webhooks[0];
  assert.deepEqual(await webhookDeliveries(ws, hook), [], 'events before the webhook existed are not delivered');
  const key = await makeKey(ws, ['screen', 'webhooks']);
  const r = await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: CLEAN, amount_usd: 9, originator_info_present: true } });
  const deliveries = await webhookDeliveries(ws, hook);
  assert.equal(deliveries.length, 1, 'only subscribed events: the key creation is not one');
  const [d] = deliveries;
  assert.equal(d.event.type, 'decision.created');
  assert.equal(d.event.receipt_id, r.body.receipt.receipt_id);
  assert.equal(d.status, 'not_sent');
  const t = Math.floor(Date.parse(d.event.created_at) / 1000);
  assert.ok(await verifyWebhook(secret, d.signature, d.body, { nowS: t + 10 }));
  assert.equal(await verifyWebhook(secret, d.signature, d.body.replace('ALLOW', 'BLOCK'), { nowS: t }), false, 'a changed body fails');
  assert.equal(await verifyWebhook('whsec_other', d.signature, d.body, { nowS: t }), false, 'the wrong secret fails');
  assert.equal(await verifyWebhook(secret, d.signature, d.body, { nowS: t + 301 }), false, 'a stale signature fails');
  assert.equal(await verifyWebhook(secret, 'garbage', d.body, { nowS: t }), false);
  assert.equal(await signWebhook(secret, t, d.body), d.signature, 'signing is deterministic');
  const listed = await call(ws, 'GET', '/v1/webhooks', { key });
  assert.deepEqual(listed.body.items.map((w) => w.id), [hookId]);
  assert.ok(!JSON.stringify(listed.body).includes(secret), 'the API never returns the secret');
  await ws.apply({ op: 'webhookRemove', ts: tick(), actor: 'admin-d', hookId });
  await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: CLEAN2, amount_usd: 9, originator_info_present: true } });
  assert.equal((await webhookDeliveries(ws, hook)).length, 1, 'nothing after removal');
});

test('address.newly_listed fires when a list update lists an address screened earlier', async () => {
  // Build a workspace still on L2 so the visitor can apply L3, the real snapshot.
  const ws = await fresh();
  // The seeded history already applied every version; find the lookback hits it signed.
  const events = ws.ledger.entries.map(eventOf).filter(Boolean);
  const newly = events.filter((e) => e.type === 'address.newly_listed');
  const changed = events.filter((e) => e.type === 'list.changed');
  assert.ok(changed.length >= 2, 'each list update is a list.changed event');
  const lookbacks = ws.ledger.entries.filter((e) => e.receipt.action.type === 'lookback_hit');
  assert.equal(newly.length, lookbacks.length, 'one event per newly listed address');
  for (const e of newly) {
    assert.match(e.data.address, /\S/);
    assert.ok(e.data.earlier_payments.length >= 1);
    assert.notEqual(e.data.from_version, e.data.to_version);
  }
  // Now drive one by hand: screen an address the next version adds, then apply that version.
  const next = ws.pendingVersion;
  assert.ok(next, 'the demo leaves one list update for the visitor');
  const { diffVersions } = await import('../js/ws/lists.js');
  const added = diffVersions(ws.inForce, next).added[0].address;
  const key = await makeKey(ws, ['screen'], 21);
  const { hookId, secret } = newWebhookSecret(seeded(22));
  await ws.apply({ op: 'webhookAdd', ts: tick(), actor: 'admin-d', hookId, secret, url: 'https://example.com/h', events: ['address.newly_listed', 'list.changed'] });
  const before = await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: added, amount_usd: 5, originator_info_present: true } });
  assert.equal(before.body.outcome, 'ALLOW', 'not listed yet');
  await ws.apply({ op: 'listUpdate', ts: tick(), actor: 'admin-d', toVersionId: next.id });
  const got = (await webhookDeliveries(ws, ws.webhooks.at(-1))).map((d) => d.event);
  const hit = got.find((e) => e.type === 'address.newly_listed' && e.data.address.toLowerCase() === added.toLowerCase());
  assert.ok(hit, 'the newly listed address produced an event');
  assert.ok(hit.data.earlier_payments.includes(before.body.payment_id), 'the event names the earlier payment');
  assert.equal(hit.data.to_version, next.id);
  const changedNow = got.find((e) => e.type === 'list.changed');
  assert.equal(changedNow.data.newly_listed_addresses, got.filter((e) => e.type === 'address.newly_listed').length);
});

test('POST /v1/verify: no key needed; PASS for a real receipt, FAIL naming the check when tampered', async () => {
  const ws = await fresh();
  const receipt = ws.ledger.entries.at(-1).receipt;
  const ok = await call(ws, 'POST', '/v1/verify', { body: { receipt } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.verdict, 'PASS');
  assert.equal(ok.body.signer_is_this_workspace, true);
  const tampered = structuredClone(receipt);
  tampered.action.params.actor = 'someone-else';
  const bad = await call(ws, 'POST', '/v1/verify', { body: { receipt: tampered } });
  assert.equal(bad.body.verdict, 'FAIL');
  assert.equal(bad.body.failed_check, 'binding');
  const file = ws.ledger.segmentText(0);
  const pass = await call(ws, 'POST', '/v1/verify', { body: { receipts_file: file } });
  assert.equal(pass.body.verdict, 'PASS');
  const broken = await call(ws, 'POST', '/v1/verify', { body: { receipts_file: file.replace('"ALLOW"', '"DENY"') } });
  assert.equal(broken.body.verdict, 'FAIL');
  assert.ok(broken.body.failed_checks.length >= 1);
  assert.equal((await call(ws, 'POST', '/v1/verify', { body: { what: 1 } })).status, 422);
  assert.equal((await call(ws, 'POST', '/v1/verify', { body: { receipt: { nope: true } } })).body.verdict, 'FAIL');
});

test('audit export: JSON and CSV carry the chain; the checker passes it and catches edits, cuts and reorders', async () => {
  const ws = await fresh();
  const text = auditJson(ws, { exportedAt: '2026-11-24T00:00:00Z' });
  const doc = JSON.parse(text);
  assert.equal(doc.receipts_count, ws.ledger.size);
  assert.equal(doc.head_hash, ws.ledger.head());
  const good = await checkAuditJson(text);
  assert.equal(good.ok, true, good.problems.join('; '));
  assert.equal(good.checked, ws.ledger.size);
  const edited = structuredClone(doc);
  edited.receipts[5].action.params.actor = 'nobody';
  assert.equal((await checkAuditJson(JSON.stringify(edited))).ok, false, 'an edited receipt fails');
  const cut = structuredClone(doc);
  cut.receipts.splice(3, 1);
  cut.receipts_count -= 1;
  const cutResult = await checkAuditJson(JSON.stringify(cut));
  assert.equal(cutResult.ok, false, 'a removed receipt breaks the chain');
  assert.ok(cutResult.problems.some((p) => p.includes('prev_hash')));
  const truncated = structuredClone(doc);
  truncated.receipts.pop();
  truncated.receipts_count -= 1;
  assert.equal((await checkAuditJson(JSON.stringify(truncated))).ok, false, 'a dropped tail no longer matches the head hash');
  const swapped = structuredClone(doc);
  [swapped.receipts[4], swapped.receipts[5]] = [swapped.receipts[5], swapped.receipts[4]];
  assert.equal((await checkAuditJson(JSON.stringify(swapped))).ok, false, 'reordering fails');
  assert.equal((await checkAuditJson('not json')).ok, false);
  const csv = parseCsv(auditCsv(ws));
  assert.equal(csv.length, ws.ledger.size + 1);
  assert.deepEqual(csv[0].slice(-2), ['prev_hash', 'this_hash']);
});

test('key and webhook ops replay from the saved op log to the same receipts', async () => {
  const ws = await fresh();
  const key = await makeKey(ws, ['screen']);
  const { hookId, secret } = newWebhookSecret(seeded(9));
  await ws.apply({ op: 'webhookAdd', ts: tick(), actor: 'admin-d', hookId, secret, url: 'https://example.com/h', events: ['decision.created'] });
  await call(ws, 'POST', '/v1/screen', { key, body: { chain: 'ETH', to_address: CLEAN, amount_usd: 3, originator_info_present: true } });
  const again = await fresh(snapshot(ws, ANCHOR).ops);
  assert.equal(again.ledger.head(), ws.ledger.head());
  assert.equal(again.apiKeys.length, 1);
  assert.equal(again.webhooks.length, 1);
  assert.equal((await webhookDeliveries(again, again.webhooks[0])).length, 1);
});
