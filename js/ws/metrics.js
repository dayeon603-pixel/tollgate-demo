/**
 * Numbers for the dashboard, computed from workspace state. Pure functions of (state, now), so they
 * can be tested without a browser.
 */
import { dayKey, DAY_MS, startOfUtcDay } from './util.js';
import { isOpenWork, STATUSES } from './engine.js';

export const DEFAULT_WINDOW_DAYS = 30;

/**
 * Daily screening counts by outcome for the last `days` days ending on the day of `now`.
 *
 * Returns: [{ date: "YYYY-MM-DD", allow, hold, block, total }], oldest first, with zero days kept.
 */
export function dailyVolume(ws, now, days = DEFAULT_WINDOW_DAYS) {
  const end = startOfUtcDay(now).getTime();
  const rows = [];
  const index = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const row = { date: dayKey(end - i * DAY_MS), allow: 0, hold: 0, block: 0, total: 0 };
    index.set(row.date, row);
    rows.push(row);
  }
  for (const tx of ws.txs) {
    const row = index.get(dayKey(tx.ts));
    if (!row) continue;
    row[tx.outcome.toLowerCase()]++;
    row.total++;
  }
  return rows;
}

/** Headline figures for the window. */
export function summary(ws, now, days = DEFAULT_WINDOW_DAYS) {
  const rows = dailyVolume(ws, now, days);
  const total = rows.reduce((s, r) => s + r.total, 0);
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const alert of ws.alerts) byStatus[alert.status]++;
  const open = ws.alerts.filter(isOpenWork);
  const awaitingApproval = ws.alerts.filter((a) => a.pending);
  const inForce = ws.inForce;
  const changed = ws.listHistory.at(-1);
  return {
    days, total, allow: sum('allow'), hold: sum('hold'), block: sum('block'),
    openAlerts: open.length, awaitingApproval: awaitingApproval.length, byStatus,
    receipts: ws.ledger.size, segments: ws.ledger.segments.length,
    listVersion: inForce, listChangedAt: changed?.from ?? null, pendingVersion: ws.pendingVersion,
    rows,
  };
}

/** Whole days between an ISO time and now, for alert age. */
export function ageDays(iso, now) {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

/** Age label such as "3h", "2d". */
export function ageLabel(iso, now) {
  const ms = Math.max(0, now.getTime() - Date.parse(iso));
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY_MS) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}
