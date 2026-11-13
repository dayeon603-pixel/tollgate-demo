/**
 * Numbers for the dashboard, computed from workspace state. Pure functions of (state, now), so they
 * can be tested without a browser.
 */
import { dayKey, DAY_MS, startOfUtcDay } from './util.js';
import { isOpenWork, STATUSES } from './engine.js';
import { bucketRows, rangeByKey } from './timerange.js';

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

const OUTCOME_FIELDS = ['allow', 'hold', 'block'];

/**
 * Screenings per bucket for a time range (1D to 3Y), in UTC or the visitor's zone.
 *
 * The workspace history is seeded for HISTORY_DAYS days only (seed.js) and is never stretched: buckets
 * that end before the first transaction come back with status 'none' ("no records"), not as zeros.
 *
 * Returns: the bucketRows() result plus { total, allow, hold, block } over the whole window.
 */
export function rangeVolume(ws, now, rangeKey, zone = 'utc') {
  const events = [];
  let first = null;
  for (const tx of ws.txs) {
    const t = Date.parse(tx.ts);
    if (Number.isNaN(t)) continue;
    if (first === null || t < first) first = t;
    events.push({ t, values: { [tx.outcome.toLowerCase()]: 1 } });
  }
  const result = bucketRows({ rangeKey, now, zone, fields: OUTCOME_FIELDS, events, firstRecordAt: first });
  const sum = (key) => result.rows.reduce((n, r) => n + r.values[key], 0);
  const allow = sum('allow');
  const hold = sum('hold');
  const block = sum('block');
  return { ...result, total: allow + hold + block, allow, hold, block };
}

/**
 * Headline figures for the window. With `rangeKey` the window is that range (see rangeVolume) and
 * `rows` are its buckets ({ start, status, values, ... }); without it, `days` daily rows as before.
 */
export function summary(ws, now, days = DEFAULT_WINDOW_DAYS, { rangeKey = null, zone = 'utc' } = {}) {
  const volume = rangeKey ? rangeVolume(ws, now, rangeKey, zone) : null;
  const rows = volume ? volume.rows : dailyVolume(ws, now, days);
  const total = volume ? volume.total : rows.reduce((s, r) => s + r.total, 0);
  const sum = (key) => (volume ? volume[key] : rows.reduce((s, r) => s + r[key], 0));
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const alert of ws.alerts) byStatus[alert.status]++;
  const open = ws.alerts.filter(isOpenWork);
  const awaitingApproval = ws.alerts.filter((a) => a.pending);
  const inForce = ws.inForce;
  const changed = ws.listHistory.at(-1);
  return {
    days, volume, total, allow: sum('allow'), hold: sum('hold'), block: sum('block'),
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
