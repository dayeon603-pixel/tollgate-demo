/**
 * Analyst speed features that are plain logic: SLA timers, bulk actions, auto-filled case
 * summaries and saved queue views. Bulk actions go through the same engine ops as single actions,
 * so permissions, notes and four-eyes apply to every row.
 */
import { money, stamp } from './dom.js';
import { isFinal } from './engine.js';

export const HOUR = 3_600_000;
/** Default response targets in hours by alert kind. Configurable in the Policy view's SLA box. */
export const DEFAULT_SLA_HOURS = { hit: 4, hold: 24, lookback: 8, watchlist: 24 };
export const DUE_SOON_FRACTION = 0.25;
export const MAX_SAVED_VIEWS = 12;
export const BULK_ACTIONS = ['assign', 'start_review', 'propose_clear'];

/**
 * SLA state of one alert.
 *
 * Returns: { state: 'closed'|'overdue'|'due_soon'|'ok', targetH, ageH, remainingH }.
 */
export function slaState(alert, nowMs, targets = DEFAULT_SLA_HOURS) {
  const targetH = targets[alert.kind] ?? DEFAULT_SLA_HOURS[alert.kind] ?? 24;
  const ageH = Math.max(0, (nowMs - Date.parse(alert.createdAt)) / HOUR);
  const remainingH = targetH - ageH;
  if (isFinal(alert)) return { state: 'closed', targetH, ageH, remainingH };
  const state = remainingH < 0 ? 'overdue' : remainingH <= targetH * DUE_SOON_FRACTION ? 'due_soon' : 'ok';
  return { state, targetH, ageH, remainingH };
}

/** "3h left", "2h over", "4d over". */
export function slaLabel(s) {
  const h = Math.abs(s.remainingH);
  const text = h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.floor(h / 24)}d`;
  return s.state === 'closed' ? 'closed' : s.remainingH < 0 ? `${text} over` : `${text} left`;
}

/** Reads SLA hour targets from untrusted input, keeping defaults for anything invalid. */
export function cleanTargets(input) {
  const out = { ...DEFAULT_SLA_HOURS };
  for (const key of Object.keys(DEFAULT_SLA_HOURS)) {
    const n = Number(input?.[key]);
    if (Number.isFinite(n) && n >= 0.25 && n <= 720) out[key] = n;
  }
  return out;
}

/**
 * Splits selected alerts into those an action may be applied to and those it may not, with the
 * engine's own reason for each refusal.
 */
export function planBulk(ws, userId, alertIds, action) {
  const allowed = [];
  const blocked = [];
  for (const id of alertIds) {
    const alert = ws.alertById.get(id);
    if (!alert) { blocked.push({ id, reason: 'That alert no longer exists.' }); continue; }
    const reason = ws.availableActions(userId, alert)[action];
    if (reason) blocked.push({ id, reason }); else allowed.push(id);
  }
  return { allowed, blocked };
}

/**
 * Applies one action to many alerts, one engine op each (each signs its own receipt).
 *
 * Args: ws; run, an async (op) => { ok, error? } (the page passes ctx.run so state is saved);
 *   spec { actor, action, alertIds, assignee, note, ts }.
 * Returns: { done: [ids], blocked: [{id, reason}] }. Four-eyes is never bypassed: propose_clear only
 *   proposes, and a different user must approve each one.
 */
export async function applyBulk(ws, run, { actor, action, alertIds, assignee = null, note = '', ts = new Date().toISOString() }) {
  if (!BULK_ACTIONS.includes(action)) throw new RangeError(`Bulk action must be one of ${BULK_ACTIONS.join(', ')}.`);
  const plan = planBulk(ws, actor, alertIds, action);
  const done = [];
  const blocked = [...plan.blocked];
  for (const id of plan.allowed) {
    const op = { op: 'alertAction', actor, alertId: id, action, ts };
    if (action === 'assign') op.assignee = assignee;
    if (action === 'propose_clear') op.note = note;
    const result = await run(op);
    if (result.ok) done.push(id); else blocked.push({ id, reason: result.error?.message ?? 'Refused.' });
  }
  return { done, blocked };
}

/**
 * Draft case summary built only from facts the ledger already holds. The analyst edits it; the
 * app does not decide anything. Returns an array of lines.
 */
export function caseSummary(ws, alert) {
  const version = ws.version(alert.versionId);
  const lines = [];
  const tx = alert.txIds.map((id) => ws.txById.get(id)).filter(Boolean);
  const first = tx[0];
  if (first) {
    lines.push(`Payment ${first.id}${tx.length > 1 ? ` and ${tx.length - 1} more` : ''}: ${money(alert.amountUsd)}${tx.length > 1 ? ' in total' : ''}, screened ${stamp(first.ts)} UTC.`);
  }
  lines.push(`List: ${version.label} (${version.real ? 'OFAC snapshot' : 'demo version'}), digest ${version.digest.slice(0, 12)}.`);
  if (alert.entries.length) {
    lines.push(`Matched: exact address match to ${alert.entries.map((e) => `${e.name} (UID ${e.uid}, ${e.chain})`).join('; ')}.`);
  } else if (alert.rule) {
    const rule = alert.rule === 'large_value' ? 'amount at or above the large-value threshold' : 'originator details blank at or above the threshold';
    lines.push(`Held by policy: ${rule} (rule ${alert.rule}). The address is not on the list.`);
  }
  const receipt = first?.receiptId ?? alert.timeline[0]?.receiptId;
  if (receipt) lines.push(`Signed screening receipt: ${receipt.replace('rcpt:', '')}.`);
  return lines;
}

/** Saved queue filters, validated. Returns a clean { name, filters } or null. */
export function normalizeView(input) {
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, 40) : '';
  const f = input?.filters;
  if (!name || !f || typeof f !== 'object') return null;
  const str = (v, d) => (typeof v === 'string' ? v.slice(0, 80) : d);
  return { name, filters: { status: str(f.status, 'work'), kind: str(f.kind, 'all'), assignee: str(f.assignee, 'any'), q: str(f.q, ''), sort: str(f.sort, 'newest') } };
}

/** Adds or replaces a view by name, keeping at most MAX_SAVED_VIEWS. */
export function upsertView(views, view) {
  const clean = normalizeView(view);
  if (!clean) return views;
  const rest = views.filter((v) => v.name !== clean.name);
  return [...rest, clean].slice(-MAX_SAVED_VIEWS);
}
