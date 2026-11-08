/**
 * Numbers for the Network view, the gate and the dashboard strip. Pure functions of workspace state,
 * so they can be tested without a browser. Every figure counts demo members and synthetic payments.
 */
import { dayKey, DAY_MS, startOfUtcDay } from './util.js';

export const NET_WINDOW_DAYS = 30;

/** Daily inbound counts: accepted (screening skipped), refused (screened here) and no receipt (screened here). Oldest first. */
export function inboundDaily(ws, now, days = NET_WINDOW_DAYS) {
  const end = startOfUtcDay(now).getTime();
  const rows = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const row = { date: dayKey(end - i * DAY_MS), t: end - i * DAY_MS, accepted: 0, refused: 0, none: 0 };
    index.set(row.date, row);
    rows.push(row);
  }
  for (const r of ws.net.reliances) {
    const row = index.get(dayKey(r.ts));
    if (!row) continue;
    row[r.outcome === 'ACCEPTED' ? 'accepted' : r.outcome === 'REFUSED' ? 'refused' : 'none']++;
  }
  return rows;
}

/**
 * Totals and breakdowns of the inbound log.
 *
 * Returns: { total, accepted, refused, none, avoided (= accepted), rescreened (= refused + none), byMember,
 *   byListVersion, refusedByReason, pinned }.
 */
export function networkSummary(ws) {
  const log = ws.net.reliances;
  const accepted = log.filter((r) => r.outcome === 'ACCEPTED');
  const refused = log.filter((r) => r.outcome === 'REFUSED');
  const none = log.filter((r) => r.outcome === 'NONE');
  const byMember = ws.net.members.map((m) => ({
    keyId: m.keyId, name: m.name, status: m.status,
    accepted: accepted.filter((r) => r.keyId === m.keyId).length, refused: refused.filter((r) => r.keyId === m.keyId).length,
  }));
  const byListVersion = {};
  for (const r of accepted) byListVersion[r.listVersionId] = (byListVersion[r.listVersionId] ?? 0) + 1;
  const refusedByReason = {};
  for (const r of [...refused, ...none]) for (const reason of r.reasons.length ? r.reasons : [{ code: 'no_receipt' }]) refusedByReason[reason.code] = (refusedByReason[reason.code] ?? 0) + 1;
  return {
    total: log.length, accepted: accepted.length, refused: refused.length, none: none.length, avoided: accepted.length, rescreened: refused.length + none.length,
    byMember, byListVersion, refusedByReason, pinned: ws.net.members.filter((m) => m.status === 'pinned').length,
  };
}

/**
 * How much of the inbound log accepted receipts covered if only the first k pinned members had been pinned.
 * Members are taken in the order they were pinned. Returns [{ k, name, covered, share }] for k = 0..n, where
 * covered counts accepted payments in the log whose sender is among the first k.
 */
export function coverageByMembers(ws) {
  const log = ws.net.reliances;
  const accepted = log.filter((r) => r.outcome === 'ACCEPTED');
  const order = ws.net.members.filter((m) => m.pinnedAt).sort((a, b) => Date.parse(a.pinnedAt) - Date.parse(b.pinnedAt));
  const rows = [{ k: 0, name: 'No members pinned', covered: 0, share: 0 }];
  const seen = new Set();
  order.forEach((m, i) => {
    seen.add(m.keyId);
    const covered = accepted.filter((r) => seen.has(r.keyId)).length;
    rows.push({ k: i + 1, name: m.name, covered, share: log.length ? covered / log.length : 0 });
  });
  return rows;
}

/** Gate totals: released, blocked, and blocked by reason (a decision with two reasons counts under each). */
export function gateSummary(ws) {
  const gates = ws.net.gates;
  const byReason = {};
  for (const g of gates) for (const code of g.reasons) byReason[code] = (byReason[code] ?? 0) + 1;
  const released = gates.filter((g) => g.release).length;
  return { total: gates.length, released, blocked: gates.length - released, byReason };
}

/** Daily gate decisions, oldest first. */
export function gateDaily(ws, now, days = NET_WINDOW_DAYS) {
  const end = startOfUtcDay(now).getTime();
  const rows = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const row = { date: dayKey(end - i * DAY_MS), t: end - i * DAY_MS, released: 0, blocked: 0 };
    index.set(row.date, row);
    rows.push(row);
  }
  for (const g of ws.net.gates) {
    const row = index.get(dayKey(g.ts));
    if (row) row[g.release ? 'released' : 'blocked']++;
  }
  return rows;
}
