/**
 * Evidence packs for an audit or exam: a JSON bundle and a printable HTML report.
 *
 * A pack carries whole ledger segments unchanged, so each one can still be checked with the
 * verifier exactly as it was signed. Everything else in the pack (decision tables, case timelines,
 * approvals) is a summary that points back to receipt ids, and verifyPack re-derives each summary
 * line from the receipts, so an edited table is caught.
 *
 * Limits, repeated in the report: the pack shows these receipts are unchanged since they were
 * signed. It does not re-run the screening, it cannot show that a dropped last receipt or a whole
 * missing segment never existed (the head hashes in the manifest are what to compare), and the demo
 * key is public, so a signature here says nothing about who signed.
 */
import { canon, verifyText } from '../verifier.js';
import { packageText, sha256Hex } from '../workbench.js';
import { checkLinks } from './ledger.js';
import { dayKey, escapeHtml } from './util.js';

export const PACK_FORMAT = 'tollgate-demo-evidence-pack';
export const PACK_VERSION = 1;
const DEMO_NOTICE = 'Demo data. Transactions, volumes, counterparties and analyst notes are synthetic. List versions v1 and v2 are demo reconstructions. The signing key is a published demo key that anyone can use.';
const SCREEN_TYPES = new Set(['stablecoin_payment_screen', 'lookback_hit', 'watchlist_add', 'watchlist_rescreen']);
const POLICY_TYPES = new Set(['policy_change', 'role_change']);

export const VERIFY_STEPS = [
  'Pick one: the Evidence view of this app (section "Check a pack"), or the command line below.',
  'Recompute pack_digest: SHA-256 of the pack with the pack_digest field removed, written as canonical JSON (keys sorted, no spaces). It must equal pack_digest.',
  'For each segment, write the "chain" object to a file as JSON with two-space indent and a trailing newline. SHA-256 of that file must equal text_sha256.',
  'Open each segment file in the Tollgate receipt verifier (Verify receipts, then Raw receipts, then paste). It must report that every receipt passes.',
  'Check that each segment after the first starts with a segment_open receipt whose prior_segment_head equals the previous segment\'s head_hash.',
  'Compare head_hash values with the ones you recorded at export time. A matching pack digest and head hashes show nothing was removed since then.',
];

export const CLI_SNIPPET = 'node scripts/verify_pack.mjs evidence-pack.json';

function entriesInScope(ws, scope) {
  const all = ws.ledger.entries;
  if (scope.type === 'all') return all.map((e) => e.receipt.receipt_id);
  if (scope.type === 'range') {
    const inRange = (iso) => dayKey(iso) >= scope.from && dayKey(iso) <= scope.to;
    return all.filter((e) => inRange(e.receipt.action.requested_at)).map((e) => e.receipt.receipt_id);
  }
  const alert = ws.alertById.get(scope.alertId);
  if (!alert) return [];
  const ids = new Set(alert.timeline.map((t) => t.receiptId));
  for (const txId of alert.txIds) ids.add(ws.txById.get(txId)?.receiptId);
  for (const w of ws.watch) if (alert.kind === 'watchlist' && w.address.toLowerCase() === alert.address.toLowerCase()) ids.add(w.lastReceiptId);
  const used = new Set(alert.txIds.map((t) => ws.txById.get(t)?.versionId).concat(alert.versionId));
  for (const h of ws.listHistory) if (used.has(h.versionId)) ids.add(h.receiptId);
  ids.delete(undefined);
  return Array.from(ids);
}

function summariseDecision(entry) {
  const { action, verdict } = entry.receipt;
  const p = action.params;
  return {
    receipt_id: entry.receipt.receipt_id, at: action.requested_at, type: action.type, address: p.beneficiary_address,
    tx_hash: p.tx_hash ?? null, amount_usd: p.amount_usd ?? null, outcome: p.outcome ?? verdict.reasons[0].replace('outcome=', ''),
    decision: verdict.decision, list_version: entry.versionId, segment: entry.segment,
  };
}

/**
 * Builds a pack.
 *
 * Args: ws; scope { type: "all" } | { type: "range", from, to } (YYYY-MM-DD, UTC, inclusive) |
 *   { type: "case", alertId }; options { now: Date, actor: user id }.
 * Returns: the pack object, with pack_digest set.
 * Raises: Error when the scope selects nothing.
 */
export async function buildPack(ws, scope, { now, actor }) {
  const ids = entriesInScope(ws, scope);
  if (!ids.length) throw new Error('Nothing in that scope. Pick a wider date range or another case.');
  const idSet = new Set(ids);
  const selected = ws.ledger.entries.filter((e) => idSet.has(e.receipt.receipt_id));
  const segIndexes = Array.from(new Set(selected.map((e) => e.segment))).sort((a, b) => a - b);
  const segments = [];
  for (const index of segIndexes) {
    const segment = ws.ledger.segments[index];
    const text = packageText(segment.chain);
    segments.push({
      index, segment_id: segment.id, list_version_id: segment.versionId, receipt_count: segment.chain.receipts.length,
      head_hash: segment.chain.receipts.at(-1).this_hash, text_sha256: await sha256Hex(text), chain: segment.chain,
    });
  }
  const versionIds = new Set(segments.map((s) => s.list_version_id));
  const history = ws.listHistory;
  const list_versions = ws.versions.filter((v) => versionIds.has(v.id)).map((v) => {
    const at = history.findIndex((h) => h.versionId === v.id);
    return {
      id: v.id, label: v.label, digest: v.digest, rulebook_version: v.rulebook, published: v.publishDate,
      real_ofac_snapshot: v.real, note: v.note, address_count: v.addressCount,
      in_force_from: history[at]?.from ?? null, in_force_to: history[at + 1]?.from ?? null, update_receipt: history[at]?.receiptId ?? null,
    };
  });
  const alerts = scope.type === 'case'
    ? [ws.alertById.get(scope.alertId)]
    : ws.alerts.filter((a) => a.timeline.some((t) => idSet.has(t.receiptId)));
  const cases = alerts.map((a) => ({
    alert_id: a.id, kind: a.kind, status: a.status, address: a.address, tx_ids: a.txIds, amount_usd: a.amountUsd,
    assignee: a.assignee, opened_at: a.createdAt,
    timeline: a.timeline.map((t) => ({ at: t.ts, actor: t.actor, role: ws.roleOf(t.actor), action: t.action, from: t.from, to: t.to, note: t.note, receipt_id: t.receiptId })),
  }));
  const approvals = [];
  for (const a of alerts) {
    for (const t of a.timeline) {
      if (t.action !== 'approve_clear' && t.action !== 'reject_clear') continue;
      const proposal = [...a.timeline].reverse().find((p) => p.action === 'propose_clear' && Date.parse(p.ts) <= Date.parse(t.ts));
      approvals.push({
        alert_id: a.id, proposed_by: proposal?.actor ?? null, proposal_receipt: proposal?.receiptId ?? null,
        decided_by: t.actor, decision: t.action === 'approve_clear' ? 'approved' : 'rejected', decision_receipt: t.receiptId, at: t.ts,
        different_people: proposal ? proposal.actor !== t.actor : null,
      });
    }
  }
  const pack = {
    format: PACK_FORMAT, format_version: PACK_VERSION, demo: true, demo_notice: DEMO_NOTICE,
    generated_at: now.toISOString(), generated_by: actor, scope,
    ledger: { receipts_total: ws.ledger.size, segments_total: ws.ledger.segments.length, head_hash_at_export: ws.ledger.head() },
    list_versions, segments,
    selection: { count: ids.length, receipt_ids: ids },
    decisions: selected.filter((e) => SCREEN_TYPES.has(e.receipt.action.type)).map(summariseDecision),
    cases, approvals,
    policy_history: selected.filter((e) => POLICY_TYPES.has(e.receipt.action.type)).map((e) => ({ receipt_id: e.receipt.receipt_id, at: e.receipt.action.requested_at, ...e.receipt.action.params })),
    policy_at_export: JSON.parse(JSON.stringify(ws.policy)),
    verification: { steps: VERIFY_STEPS, command: CLI_SNIPPET },
  };
  pack.pack_digest = await packDigest(pack);
  return pack;
}

/** SHA-256 of the canonical JSON of the pack without its pack_digest field. */
export async function packDigest(pack) {
  const { pack_digest: _omit, ...rest } = pack;
  return sha256Hex(canon(rest));
}

/**
 * Checks a pack's integrity, offline, with the real verifier.
 *
 * Args: input, the pack object or its JSON text.
 * Returns: { ok, checks: [{ id, ok, detail }] }. Never throws on bad input; it reports a failed check.
 */
export async function verifyPack(input) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok, detail });
  let pack = input;
  if (typeof input === 'string') {
    try {
      pack = JSON.parse(input);
    } catch {
      add('format', false, 'The file is not valid JSON.');
      return { ok: false, checks };
    }
  }
  if (!pack || pack.format !== PACK_FORMAT || !Array.isArray(pack.segments)) {
    add('format', false, 'This is not a Tollgate demo evidence pack.');
    return { ok: false, checks };
  }
  add('format', true, `Format ${pack.format}, version ${pack.format_version}.`);
  add('digest', (await packDigest(pack)) === pack.pack_digest, 'pack_digest matches the pack contents.');
  const receipts = new Map();
  const seenSegments = new Map();
  for (const seg of pack.segments) {
    const label = seg.segment_id;
    const text = packageText(seg.chain ?? {});
    const hashOk = (await sha256Hex(text)) === seg.text_sha256;
    add(`segment-${label}-hash`, hashOk, `${label}: file digest matches text_sha256.`);
    const outcome = await verifyText(text);
    add(`segment-${label}-verifier`, outcome.kind === 'pass', `${label}: verifier result is "${outcome.kind}"${outcome.kind === 'pass' ? ` for ${seg.chain.receipts.length} receipts` : ''}.`);
    const last = seg.chain?.receipts?.at(-1);
    add(`segment-${label}-head`, Boolean(last) && last.this_hash === seg.head_hash && seg.chain.receipts.length === seg.receipt_count, `${label}: head hash and receipt count match the manifest.`);
    for (const r of seg.chain?.receipts ?? []) receipts.set(r.receipt_id, { receipt: r, segment: seg.index, versionId: seg.list_version_id });
    seenSegments.set(seg.index, seg);
  }
  const ordered = [...seenSegments.keys()].sort((a, b) => a - b);
  for (const index of ordered) {
    const prior = seenSegments.get(index - 1);
    if (!prior) {
      if (index > 0) add(`link-${index}`, true, `${seenSegments.get(index).segment_id}: previous segment is not in this pack. Compare its head hash with your record.`);
      continue;
    }
    const link = checkLinks([prior.chain, seenSegments.get(index).chain], []).links[0];
    add(`link-${index}`, Boolean(link?.ok), `${seenSegments.get(index).segment_id} opens from the head of ${prior.segment_id}.`);
  }
  const missing = (pack.selection?.receipt_ids ?? []).filter((id) => !receipts.has(id));
  add('selection', missing.length === 0, missing.length ? `${missing.length} selected receipts are not in the included segments.` : `All ${pack.selection?.receipt_ids?.length ?? 0} selected receipts are in the included segments.`);
  let bad = 0;
  for (const row of pack.decisions ?? []) {
    const hit = receipts.get(row.receipt_id)?.receipt;
    const p = hit?.action?.params;
    if (!p || p.beneficiary_address !== row.address || (p.amount_usd ?? null) !== row.amount_usd || (p.tx_hash ?? null) !== row.tx_hash || hit.verdict.decision !== row.decision || hit.action.requested_at !== row.at) bad++;
  }
  add('decisions', bad === 0, bad ? `${bad} decision rows do not match their receipts.` : `All ${pack.decisions?.length ?? 0} decision rows match their receipts.`);
  bad = 0;
  for (const c of pack.cases ?? []) {
    for (const t of c.timeline) {
      const p = receipts.get(t.receipt_id)?.receipt?.action?.params;
      if (!p) { bad++; continue; }
      if (t.action === 'created') continue;
      if (p.action !== t.action || p.actor !== t.actor || p.status_to !== t.to || (p.note ?? '') !== (t.note ?? '')) bad++;
    }
  }
  add('cases', bad === 0, bad ? `${bad} case timeline lines do not match their receipts.` : `All case timeline lines match their receipts.`);
  bad = 0;
  for (const a of pack.approvals ?? []) {
    const decided = receipts.get(a.decision_receipt)?.receipt?.action?.params;
    const proposed = receipts.get(a.proposal_receipt)?.receipt?.action?.params;
    if (!decided || !proposed || decided.actor !== a.decided_by || proposed.actor !== a.proposed_by || a.proposed_by === a.decided_by) bad++;
  }
  add('approvals', bad === 0, bad ? `${bad} approvals do not match their receipts or were not made by two different people.` : `All ${pack.approvals?.length ?? 0} approvals match their receipts and were made by two different people.`);
  return { ok: checks.every((c) => c.ok), checks };
}

const REPORT_CSS = `body{font:13px/1.45 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15191c;max-width:1000px;margin:24px auto;padding:0 16px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #cdd2d6;padding-bottom:3px}
.demo{border:1px solid #855400;background:#fcf3dd;padding:8px 10px;border-radius:4px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #cdd2d6;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f1f3f4}code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}
.small{color:#47525a;font-size:12px}li{margin:2px 0}
@media print{body{margin:0;max-width:none}h2{break-after:avoid}tr{break-inside:avoid}}`;

function table(headers, rows) {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows.length
    ? rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}">None in this scope.</td></tr>`;
  return `<table>${head}${body}</table>`;
}

/** Printable report for a pack. Every value is escaped. Returns a full HTML document. */
export function packHtml(pack) {
  const scope = pack.scope.type === 'range' ? `${pack.scope.from} to ${pack.scope.to} (UTC)` : pack.scope.type === 'case' ? `Case ${pack.scope.alertId}` : 'Whole demo ledger';
  const o = { allow: 0, hold: 0, block: 0 };
  for (const d of pack.decisions) if (d.type === 'stablecoin_payment_screen') o[d.outcome.toLowerCase()]++;
  const parts = [
    `<h1>Tollgate evidence pack</h1><p class="small">Scope: ${escapeHtml(scope)}. Generated ${escapeHtml(pack.generated_at)} by ${escapeHtml(pack.generated_by)}.</p>`,
    `<p class="demo"><strong>Demo.</strong> ${escapeHtml(pack.demo_notice)}</p>`,
    `<h2>Summary</h2>${table(['Item', 'Count'], [
      ['Receipts in scope', pack.selection.count], ['Screening decisions in scope', pack.decisions.length],
      ['Allow / Hold / Hit (payments)', `${o.allow} / ${o.hold} / ${o.block}`], ['Cases in scope', pack.cases.length],
      ['Approvals in scope', pack.approvals.length], ['Ledger segments included', pack.segments.length],
    ])}`,
    `<h2>Integrity</h2><p>Pack digest (SHA-256): <code>${escapeHtml(pack.pack_digest)}</code></p>
     <p>Ledger head hash at export: <code>${escapeHtml(pack.ledger.head_hash_at_export)}</code>. Keep this value; it is what shows later that nothing was removed.</p>`,
    `<h2>List versions in force</h2>${table(['Version', 'Digest (SHA-256)', 'Published', 'In force from', 'In force until', 'Source'], pack.list_versions.map((v) => [v.label, v.digest, v.published, v.in_force_from ?? '', v.in_force_to ?? 'now', v.real_ofac_snapshot ? 'Bundled OFAC snapshot' : 'Demo reconstruction']))}`,
    `<h2>Ledger segments</h2>${table(['Segment', 'List version', 'Receipts', 'Head hash', 'File digest (text_sha256)'], pack.segments.map((s) => [s.segment_id, s.list_version_id, s.receipt_count, s.head_hash, s.text_sha256]))}`,
    `<h2>Screening decisions</h2>${table(['Receipt', 'Time (UTC)', 'Type', 'Address', 'Tx hash', 'USD', 'Outcome', 'List'], pack.decisions.map((d) => [d.receipt_id, d.at, d.type, d.address, d.tx_hash ?? '', d.amount_usd ?? '', d.outcome, d.list_version]))}`,
    `<h2>Cases</h2>${pack.cases.length ? pack.cases.map((c) => `<h3>${escapeHtml(c.alert_id)} (${escapeHtml(c.kind)}, ${escapeHtml(c.status)})</h3><p class="small">Address <span class="mono">${escapeHtml(c.address)}</span>. Opened ${escapeHtml(c.opened_at)}.</p>${table(['Time (UTC)', 'Who', 'Role', 'Action', 'Status', 'Note', 'Receipt'], c.timeline.map((t) => [t.at, t.actor, t.role, t.action, `${t.from ?? ''} to ${t.to}`, t.note, t.receipt_id]))}`).join('') : '<p>None in this scope.</p>'}`,
    `<h2>Four-eyes approvals</h2>${table(['Case', 'Proposed by', 'Decided by', 'Decision', 'Time (UTC)', 'Proposal receipt', 'Decision receipt'], pack.approvals.map((a) => [a.alert_id, a.proposed_by, a.decided_by, a.decision, a.at, a.proposal_receipt, a.decision_receipt]))}`,
    `<h2>Policy and role changes</h2>${table(['Time (UTC)', 'Receipt', 'Change', 'By'], pack.policy_history.map((p) => [p.at, p.receipt_id, p.setting ? `${p.setting}: ${p.from} to ${p.to}` : `${p.user_id}: ${p.from} to ${p.to}`, p.actor]))}`,
    `<h2>How to verify this pack offline</h2><ol>${pack.verification.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol><p>Command line: <code>${escapeHtml(pack.verification.command)}</code></p>`,
    `<h2>What this pack does and does not show</h2><ul>
      <li>It shows the included receipts are unchanged since they were signed, and that each case line and decision row matches a receipt.</li>
      <li>It does not re-run the screening, and it does not show the list itself was complete or current.</li>
      <li>Screening is an exact address match against the list version named on each receipt. There is no name matching.</li>
      <li>It cannot show that a dropped last receipt or an omitted segment ever existed. Compare head hashes with your own record.</li>
      <li>The signing key in this demo is public, so a signature here says nothing about who signed.</li></ul>`,
  ];
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Tollgate evidence pack</title><style>${REPORT_CSS}</style></head><body>${parts.join('\n')}</body></html>`;
}
