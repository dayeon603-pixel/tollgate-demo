/**
 * The workspace's API, run in the browser. Requests go to `handleApiRequest`, which authenticates
 * a `tg_` key by its SHA-256, checks the key's scope, and calls the same workspace engine the
 * screens use, so an API screen is an ordinary signed decision in the ledger.
 *
 * Paths, scopes, the error shape and the webhook signature header follow the self-hosted kit's
 * /v1 API. This copy has no server: nothing leaves the browser, and webhook deliveries are built
 * and signed but not sent.
 *
 * Also here, derived from the ledger (nothing is stored twice):
 *   - usage metering: one count per signed screening decision, per key and per day or month;
 *   - webhook events and their signed payloads;
 *   - the audit log export (JSON and CSV) with each receipt's hash-chain fields.
 */
import { canon, verifyText } from '../verifier.js';
import { sha256Hex } from '../workbench.js';
import { checkReceipt } from './receipt-check.js';
import { API_SCOPES, KEY_PREFIX, KEY_PREFIX_SHOWN, WEBHOOK_EVENTS, WEBHOOK_SECRET_PREFIX, WorkspaceError } from './engine.js';
import { toCsv } from './util.js';

export { API_SCOPES, WEBHOOK_EVENTS };
export const SIGNATURE_HEADER = 'Tollgate-Signature';
/** Seconds a webhook signature stays valid either side of its timestamp, as in the kit. */
export const SIGNATURE_TOLERANCE_S = 300;
export const MAX_BODY_CHARS = 200_000;
export const MAX_USAGE_DAYS = 1100;
export const SCREEN_FIELDS = ['chain', 'to_address', 'from_address', 'asset', 'amount_usd', 'originator_info_present', 'reference', 'tx_hash'];
const CHAIN_RE = /^[A-Z0-9]{2,16}$/;
/** The kit's address rule: 0x plus 40 hex, or 20 to 120 letters and digits (Tron, Bitcoin and others). */
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const GENERIC_RE = /^[A-Za-z0-9]{20,120}$/;
const addressOk = (v) => typeof v === 'string' && (EVM_RE.test(v.trim()) || GENERIC_RE.test(v.trim()));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** An HTTP-style error with a stable code, mapped to the kit's `{ error: { code, message, request_id } }`. */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const ENGINE_STATUS = {
  invalid_api_key: 401, insufficient_scope: 403, idempotency_key_reused: 409, bad_address: 422, bad_amount: 422,
  bad_tx_hash: 422, bad_idempotency_key: 422, no_list: 503,
};

function randomString(alphabet, length, random) {
  const bytes = random(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const cryptoRandom = (n) => crypto.getRandomValues(new Uint8Array(n));

/**
 * A new API key: `tg_` plus 43 URL-safe characters (the kit's format), its SHA-256, the shown
 * prefix and an id. The secret is shown once and never stored.
 *
 * Args: random, a function n -> Uint8Array(n) (tests pass a seeded one).
 */
export async function newApiKey(random = cryptoRandom) {
  const secret = KEY_PREFIX + randomString(B64URL, 43, random);
  return { secret, hash: await sha256Hex(secret), prefix: secret.slice(0, KEY_PREFIX_SHOWN), keyId: `key_${randomString(ALNUM, 12, random)}` };
}

/** A new webhook id and signing secret (`whsec_` plus 40 characters). */
export function newWebhookSecret(random = cryptoRandom) {
  return { hookId: `wh_${randomString(ALNUM, 12, random)}`, secret: WEBHOOK_SECRET_PREFIX + randomString(B64URL, 40, random) };
}

// ---- webhook signatures ---------------------------------------------------------------------

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The `Tollgate-Signature` value for a body: `t=<unix seconds>,v1=<HMAC-SHA256 hex of "t.body">`. */
export async function signWebhook(secret, timestamp, body) {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

/**
 * Whether `header` is a correct signature of `body` made within the tolerance of `nowS`.
 * Compares in constant time over the hex string. False for a missing or malformed header.
 */
export async function verifyWebhook(secret, header, body, { nowS, toleranceS = SIGNATURE_TOLERANCE_S } = {}) {
  if (typeof header !== 'string') return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)).filter((p) => p.length === 2));
  const stamp = Number(parts.t);
  if (!Number.isInteger(stamp) || typeof parts.v1 !== 'string') return false;
  if (Math.abs(nowS - stamp) > toleranceS) return false;
  const want = await hmacHex(secret, `${stamp}.${body}`);
  if (want.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

// ---- events derived from the ledger ---------------------------------------------------------

/**
 * The webhook event a ledger entry produces, or null. Event ids are the receipt id, so a
 * receiver can drop duplicates by id.
 */
export function eventOf(entry) {
  const { action, receipt_id: receiptId } = entry.receipt;
  const p = action.params;
  const base = { id: `evt_${receiptId.replace('rcpt:', '')}`, created_at: action.requested_at, receipt_id: receiptId };
  switch (action.type) {
    case 'stablecoin_payment_screen':
      return { ...base, type: 'decision.created', data: {
        payment_id: p.payment_id, outcome: p.outcome, beneficiary_address: p.beneficiary_address,
        ...(p.originator_address ? { originator_address: p.originator_address } : {}),
        ...(p.amount_usd !== undefined ? { amount_usd: p.amount_usd } : {}),
        ...(p.api_key_id ? { api_key_id: p.api_key_id } : {}), source: p.source,
      } };
    case 'list_update':
      return { ...base, type: 'list.changed', data: {
        from_version: p.from_version, to_version: p.to_version, to_digest: p.to_digest,
        entries_added: p.entries_added, entries_removed: p.entries_removed, newly_listed_addresses: p.lookback_hits,
      } };
    case 'lookback_hit':
      return { ...base, type: 'address.newly_listed', data: {
        address: p.beneficiary_address, earlier_payments: p.tx_ids, total_usd: p.total_usd,
        from_version: p.from_version, to_version: p.to_version, alert_id: p.alert_id,
      } };
    default:
      return null;
  }
}

/**
 * The deliveries a webhook would have made: every subscribed event recorded after the webhook was
 * created and before it was removed, newest first, each with its exact body and signature.
 *
 * Returns: [{ event, body, signature, status: 'not_sent' }]. `limit` caps the count.
 */
export async function webhookDeliveries(ws, hook, { limit = 50 } = {}) {
  const out = [];
  for (let i = ws.ledger.entries.length - 1; i >= 0 && out.length < limit; i--) {
    const entry = ws.ledger.entries[i];
    if (entry.n <= hook.createdN) break;
    if (hook.removedN && entry.n >= hook.removedN) continue;
    const event = eventOf(entry);
    if (!event || !hook.events.includes(event.type)) continue;
    const body = JSON.stringify(event);
    const t = Math.floor(Date.parse(event.created_at) / 1000);
    out.push({ event, body, signature: await signWebhook(hook.secret, t, body), status: 'not_sent' });
  }
  return out;
}

// ---- usage metering -------------------------------------------------------------------------

/** Who a screening decision is metered to: the API key, the demo feed, or a person in the console. */
export function meterOf(tx) {
  if (tx.keyId) return { meter: tx.keyId, kind: 'api_key' };
  if (tx.actor === 'api') return { meter: 'demo_feed', kind: 'demo_feed' };
  return { meter: `console:${tx.actor}`, kind: 'console' };
}

function readDate(text, name) {
  if (typeof text !== 'string' || !DATE_RE.test(text)) throw new ApiError(422, 'bad_date', `${name} is a date like 2026-11-24.`);
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) throw new ApiError(422, 'bad_date', `${name} is not a real date.`);
  return ms;
}

/**
 * Screening volume, one count per signed decision, grouped by meter and period.
 *
 * Args: ws; from, to (YYYY-MM-DD, UTC, inclusive); group 'day' or 'month'; keyId to restrict to
 *   one key.
 * Returns: { from, to, group, rows: [{ period, meter, kind, key_name, screened, allow, hold, block }],
 *   totals: { screened, allow, hold, block } }. Rows are sorted by period, then meter.
 * Raises: ApiError 422 on bad dates, from after to, a range over MAX_USAGE_DAYS, or a bad group.
 */
export function usageReport(ws, { from, to, group = 'day', keyId = null }) {
  if (!['day', 'month'].includes(group)) throw new ApiError(422, 'bad_group', 'group is day or month.');
  const start = readDate(from, 'from');
  const end = readDate(to, 'to') + DAY_MS;
  if (end <= start) throw new ApiError(422, 'bad_range', 'from must be on or before to.');
  if ((end - start) / DAY_MS > MAX_USAGE_DAYS) throw new ApiError(422, 'bad_range', `Ask for at most ${MAX_USAGE_DAYS} days at a time.`);
  const names = new Map(ws.apiKeys.map((k) => [k.id, k.name]));
  const rows = new Map();
  const totals = { screened: 0, allow: 0, hold: 0, block: 0 };
  for (const tx of ws.txs) {
    const at = Date.parse(tx.ts);
    if (at < start || at >= end) continue;
    const { meter, kind } = meterOf(tx);
    if (keyId && meter !== keyId) continue;
    const period = group === 'day' ? tx.ts.slice(0, 10) : tx.ts.slice(0, 7);
    const id = `${period}|${meter}`;
    if (!rows.has(id)) rows.set(id, { period, meter, kind, key_name: names.get(meter) ?? null, screened: 0, allow: 0, hold: 0, block: 0 });
    const row = rows.get(id);
    const bucket = tx.outcome.toLowerCase();
    row.screened++;
    row[bucket]++;
    totals.screened++;
    totals[bucket]++;
  }
  const sorted = [...rows.values()].sort((a, b) => (a.period === b.period ? a.meter.localeCompare(b.meter) : a.period.localeCompare(b.period)));
  return { from, to, group, unit: 'signed screening decision', rows: sorted, totals };
}

/** The usage report as CSV, one row per period and meter. */
export function usageCsv(report) {
  return toCsv([
    ['period', 'meter', 'kind', 'key_name', 'screened', 'allow', 'hold', 'block'],
    ...report.rows.map((r) => [r.period, r.meter, r.kind, r.key_name ?? '', r.screened, r.allow, r.hold, r.block]),
  ]);
}

// ---- audit log export -----------------------------------------------------------------------

/**
 * Every ledger receipt in order with the fields that chain it: segment, seq, prev_hash, this_hash.
 * Within a segment each prev_hash is the this_hash before it; a segment's first receipt
 * (segment_open) names the previous segment's head in its signed params.
 */
export function auditRows(ws) {
  return ws.ledger.entries.map((e) => {
    const r = e.receipt;
    return {
      n: e.n, segment: ws.ledger.segments[e.segment].id, seq: r.seq, receipt_id: r.receipt_id, type: r.action.type,
      requested_at: r.action.requested_at, actor: r.action.params.actor ?? 'system', decision: r.verdict.decision,
      outcome: r.action.params.outcome ?? r.verdict.labels?.outcome ?? '', prev_hash: r.prev_hash, this_hash: r.this_hash,
    };
  });
}

/** The audit export as JSON text: header (signer, head hash, count) plus the full receipts. */
export function auditJson(ws, { exportedAt }) {
  const receipts = ws.ledger.entries.map((e) => e.receipt);
  return JSON.stringify({
    format: 'tollgate-demo-audit-v1', exported_at: exportedAt, receipts_count: receipts.length,
    head_hash: ws.ledger.head(), signer: receipts[0]?.verdict.authorizer_id ?? null,
    segments: ws.ledger.segments.map((s) => ({ id: s.id, list_version: s.versionId, receipts: s.chain.receipts.length, head: s.chain.receipts.at(-1)?.this_hash ?? null })),
    receipts,
  }, null, 2);
}

export function auditCsv(ws) {
  const rows = auditRows(ws);
  const cols = ['n', 'segment', 'seq', 'receipt_id', 'type', 'requested_at', 'actor', 'decision', 'outcome', 'prev_hash', 'this_hash'];
  return toCsv([cols, ...rows.map((r) => cols.map((c) => r[c]))]);
}

/**
 * Checks an audit JSON export: every receipt's signature and hash (the real receipt checker),
 * each prev_hash against the receipt before it in the same segment, the segment links, and the
 * head hash in the header.
 *
 * Returns: { ok, checked, problems: [string] }.
 */
export async function checkAuditJson(text, { expectKey = null } = {}) {
  const problems = [];
  let doc;
  try { doc = JSON.parse(text); } catch { return { ok: false, checked: 0, problems: ['Not JSON.'] }; }
  const receipts = Array.isArray(doc?.receipts) ? doc.receipts : null;
  if (!receipts || !receipts.length) return { ok: false, checked: 0, problems: ['No receipts in the export.'] };
  let prior = null;
  for (const [i, r] of receipts.entries()) {
    const check = await checkReceipt(r, { expectKey });
    if (!check.ok) problems.push(`${r?.receipt_id ?? `#${i + 1}`}: ${check.detail}`);
    const opensSegment = r?.action?.type === 'segment_open';
    if (opensSegment) {
      const want = prior ? prior.this_hash : null;
      if (r.action.params.prior_segment_head !== want) problems.push(`${r.receipt_id}: segment link does not name the receipt before it.`);
    } else if (!prior || r?.prev_hash !== prior.this_hash) {
      problems.push(`${r?.receipt_id ?? `#${i + 1}`}: prev_hash does not match the receipt before it.`);
    }
    prior = r;
  }
  if (doc.head_hash !== prior?.this_hash) problems.push('The header head_hash is not the last receipt\'s hash.');
  if (doc.receipts_count !== receipts.length) problems.push('The header count does not match the receipts.');
  return { ok: problems.length === 0, checked: receipts.length, problems };
}

// ---- request handling -----------------------------------------------------------------------

/** Renders an ApiError (or a refused engine op) in the kit's error shape. */
function errorResponse(error, requestId) {
  return {
    status: error.status,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId },
    body: { error: { code: error.code, message: error.message, request_id: requestId } },
  };
}

async function authenticate(ws, headers, scope) {
  const auth = headers.authorization ?? headers.Authorization ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!presented.startsWith(KEY_PREFIX)) throw new ApiError(401, 'invalid_api_key', 'Send a key as Authorization: Bearer tg_...');
  const key = ws.keyByHash(await sha256Hex(presented));
  if (!key || key.revokedAt) throw new ApiError(401, 'invalid_api_key', 'Unknown or revoked API key.');
  if (!key.scopes.includes(scope)) throw new ApiError(403, 'insufficient_scope', `This key lacks the ${scope} scope.`);
  return key;
}

function readBody(body) {
  if (body === undefined || body === null || body === '') throw new ApiError(422, 'body_required', 'Send a JSON body.');
  if (typeof body !== 'string') return body;
  if (body.length > MAX_BODY_CHARS) throw new ApiError(413, 'payload_too_large', `Bodies are limited to ${MAX_BODY_CHARS} characters.`);
  try { return JSON.parse(body); } catch { throw new ApiError(400, 'bad_json', 'The body is not valid JSON.'); }
}

function listInfo(version) {
  return {
    version: version.id, list_digest: version.digest, entries: version.addressCount,
    ofac_publish_date: version.real ? version.publishDate : null,
    label: version.real ? 'real OFAC snapshot (bundled)' : 'demo reconstruction',
  };
}

function screenResponse(ws, tx, receipt, replayed) {
  return {
    decision: tx.outcome === 'ALLOW' ? 'ALLOW' : 'DENY', outcome: tx.outcome, reasons: receipt.verdict.reasons,
    screened_at: tx.ts, payment_id: tx.id, alert_id: tx.alertId, list_in_force: listInfo(ws.version(tx.versionId)),
    receipt, ...(replayed ? { idempotent_replay: true } : {}),
  };
}

async function screen(ws, key, body, headers, { now, apply }) {
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(422, 'bad_body', 'The body is one JSON object.');
  const extra = Object.keys(body).filter((k) => !SCREEN_FIELDS.includes(k));
  if (extra.length) throw new ApiError(422, 'unknown_field', `Unknown field ${extra[0]}. Fields: ${SCREEN_FIELDS.join(', ')}.`);
  if (typeof body.chain !== 'string' || !CHAIN_RE.test(body.chain)) throw new ApiError(422, 'bad_chain', 'chain is 2 to 16 capital letters or digits, for example ETH.');
  if (typeof body.to_address !== 'string') throw new ApiError(422, 'to_address_required', 'to_address is required.');
  if (!addressOk(body.to_address)) throw new ApiError(422, 'bad_address', 'to_address must be 0x plus 40 hex characters, or 20 to 120 letters and digits.');
  if (body.from_address !== undefined && body.from_address !== null && !addressOk(body.from_address)) throw new ApiError(422, 'bad_address', 'from_address must be 0x plus 40 hex characters, or 20 to 120 letters and digits.');
  if (body.amount_usd !== undefined && (!Number.isInteger(body.amount_usd) || body.amount_usd < 0)) throw new ApiError(422, 'bad_amount', 'amount_usd is whole US dollars, 0 or more.');
  if (body.originator_info_present !== undefined && typeof body.originator_info_present !== 'boolean') throw new ApiError(422, 'bad_originator', 'originator_info_present is true or false.');
  if (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 128)) throw new ApiError(422, 'bad_reference', 'reference is text of at most 128 characters.');
  const idem = headers['idempotency-key'] ?? headers['Idempotency-Key'];
  const bodyHash = await sha256Hex(canon(body));
  if (idem !== undefined) {
    const prior = ws.idempotency.get(`${key.id}|${idem}`);
    if (prior) {
      if (prior.bodyHash !== bodyHash) throw new ApiError(409, 'idempotency_key_reused', 'That Idempotency-Key was used with a different body.');
      const tx = ws.txById.get(prior.txId);
      return { status: 200, headers: { 'Idempotent-Replayed': 'true' }, body: screenResponse(ws, tx, ws.ledger.find(tx.receiptId).receipt, true) };
    }
  }
  const op = {
    op: 'screen', ts: now.toISOString(), actor: 'api', source: 'api', keyId: key.id, address: body.to_address,
    fromAddress: body.from_address ?? null, amount: body.amount_usd ?? null, originator: body.originator_info_present === true,
    txHash: body.tx_hash ?? '', reference: body.reference ?? null,
    ...(idem !== undefined ? { idempotencyKey: String(idem), bodyHash } : {}),
  };
  const result = await apply(op);
  return { status: 200, headers: {}, body: screenResponse(ws, result.tx, result.receipt, false) };
}

async function verify(ws, body) {
  if (typeof body !== 'object' || Array.isArray(body)) throw new ApiError(422, 'bad_body', 'Send { "receipt": {...} } or { "receipts_file": "..." }.');
  if (body.receipt !== undefined) {
    const out = await checkReceipt(body.receipt);
    const signer = body.receipt?.verdict?.authorizer_id ?? null;
    const known = signer !== null && ws.ledger.entries[0]?.receipt.verdict.authorizer_id === signer;
    return { verdict: out.ok ? 'PASS' : 'FAIL', failed_check: out.code, detail: out.detail, signer, signer_is_this_workspace: known };
  }
  if (typeof body.receipts_file === 'string') {
    if (body.receipts_file.length > MAX_BODY_CHARS) throw new ApiError(413, 'payload_too_large', `Files are limited to ${MAX_BODY_CHARS} characters.`);
    const outcome = await verifyText(body.receipts_file);
    const failed = outcome.kind === 'fail'
      ? outcome.receipts.flatMap((r, i) => r.checks.filter((c) => !c.ok).map((c) => `receipt ${i + 1}: ${c.id}`)).concat(outcome.fileProblems ?? [])
      : [];
    const detail = outcome.kind === 'foreign' ? outcome.message : outcome.kind === 'unreadable' ? outcome.problems.join(' ') : outcome.kind === 'unsupported' ? 'This browser cannot check Ed25519 signatures.' : null;
    return { verdict: outcome.kind === 'pass' ? 'PASS' : outcome.kind === 'fail' ? 'FAIL' : 'NO VERDICT', kind: outcome.kind, receipts: outcome.receipts?.length ?? 0, failed_checks: failed, detail };
  }
  throw new ApiError(422, 'bad_body', 'Send { "receipt": {...} } or { "receipts_file": "..." }.');
}

/**
 * Handles one API request against the workspace.
 *
 * Args: ws; req { method, path (may carry a query string), headers (lower-case names), body
 *   (JSON text or an object) }; options { now: Date, apply: op -> result (defaults to ws.apply;
 *   the page passes one that also saves), requestId }.
 * Returns: { status, headers, body } where body is an object (or text for CSV).
 *
 * Routes (scope): POST /v1/screen (screen), GET /v1/receipts/{id} (read), GET /v1/usage (read),
 * GET /v1/webhooks (webhooks), POST /v1/verify (no key).
 */
export async function handleApiRequest(ws, req, { now = new Date(), apply = (op) => ws.apply(op), requestId = 'req_demo' } = {}) {
  const method = String(req.method ?? 'GET').toUpperCase();
  const url = new URL(String(req.path ?? '/'), 'https://demo.invalid');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  try {
    let out;
    if (method === 'POST' && path === '/v1/screen') {
      const key = await authenticate(ws, headers, 'screen');
      out = await screen(ws, key, readBody(req.body), headers, { now, apply });
    } else if (method === 'GET' && path.startsWith('/v1/receipts/')) {
      await authenticate(ws, headers, 'read');
      const id = decodeURIComponent(path.slice('/v1/receipts/'.length));
      const entry = ws.ledger.find(id) ?? ws.ledger.find(`rcpt:${id}`);
      if (!entry) throw new ApiError(404, 'not_found', 'No receipt with that id.');
      out = { status: 200, headers: {}, body: entry.receipt };
    } else if (method === 'GET' && path === '/v1/usage') {
      const key = await authenticate(ws, headers, 'read');
      const q = url.searchParams;
      const scope = q.get('all_keys') === 'true' ? null : key.id;
      const report = usageReport(ws, { from: q.get('from'), to: q.get('to'), group: q.get('group') ?? 'day', keyId: scope });
      out = q.get('format') === 'csv' || (headers.accept ?? '').includes('text/csv')
        ? { status: 200, headers: { 'Content-Type': 'text/csv' }, body: usageCsv(report) }
        : { status: 200, headers: {}, body: report };
    } else if (method === 'GET' && path === '/v1/webhooks') {
      await authenticate(ws, headers, 'webhooks');
      out = { status: 200, headers: {}, body: { items: ws.webhooks.filter((w) => !w.removedAt).map((w) => ({ id: w.id, url: w.url, events: w.events, created_at: w.createdAt })) } };
    } else if (method === 'POST' && path === '/v1/verify') {
      out = { status: 200, headers: {}, body: await verify(ws, readBody(req.body)) };
    } else if (['/v1/screen', '/v1/usage', '/v1/webhooks', '/v1/verify'].includes(path) || path.startsWith('/v1/receipts/')) {
      throw new ApiError(405, 'method_not_allowed', `${method} is not allowed on ${path}.`);
    } else {
      throw new ApiError(404, 'not_found', `No route ${path}. Routes: POST /v1/screen, GET /v1/receipts/{id}, GET /v1/usage, GET /v1/webhooks, POST /v1/verify.`);
    }
    return { status: out.status, headers: { 'Content-Type': 'application/json', 'X-Request-ID': requestId, ...out.headers }, body: out.body };
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error, requestId);
    if (error instanceof WorkspaceError) return errorResponse(new ApiError(ENGINE_STATUS[error.code] ?? 422, error.code, error.message), requestId);
    throw error;
  }
}
