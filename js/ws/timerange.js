/**
 * Stock-style time ranges (1D, 1W, 1M, 3M, 6M, 1Y, 3Y) for the dashboard and the Live chain history.
 *
 * Pure: no DOM, no storage. It turns timestamped events (or buckets somebody already aggregated, such
 * as the record store's minute and hour buckets) into one row per display bucket, in UTC or in the
 * visitor's local zone (the `timeZone` setting), and says honestly which buckets have nothing behind
 * them:
 *
 *   status 'ok'    the bucket is inside the recorded period; a zero is a real zero.
 *   status 'none'  the bucket ends before the first record. "No records", never a zero bar.
 *   status 'off'   (only when coverage is tracked) the bucket is after the first record but the page
 *                  was not recording during it. "Not recording", distinct from zero transfers.
 *
 * Bucket sizes: 1D hourly (24), 1W 6-hourly (28), 1M daily (30), 3M weekly (13), 6M weekly (26),
 * 1Y monthly (12), 3Y monthly (36). The last bucket holds `now` and is partial. Weeks start on Monday.
 */
import { formatClock, formatDate, getSettings } from './settings.js';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
const SIX_HOURS = 6;
const WEEK_START_OFFSET = 6; // (getDay() + 6) % 7 is the days since Monday
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Where to look for the start of the next bucket, as an offset from a bucket start: far enough to be
 * inside the next bucket whatever the length of this one (28 to 31-day months, 23 or 25-hour days).
 */
const PROBE_MS = { hour: 1.5 * HOUR_MS, '6h': 9 * HOUR_MS, day: 1.5 * DAY_MS, week: 10 * DAY_MS, month: 32 * DAY_MS };

/**
 * key: what the button says and what is stored in prefs. bucket: the bucket size. count: how many buckets.
 * window: the plain-words length, for tile labels. per: "Screenings per ...".
 */
export const RANGES = Object.freeze([
  { key: '1D', bucket: 'hour', count: 24, window: '24 hours', per: 'hour', name: 'last 24 hours' },
  { key: '1W', bucket: '6h', count: 28, window: '7 days', per: '6 hours', name: 'last 7 days' },
  { key: '1M', bucket: 'day', count: 30, window: '30 days', per: 'day', name: 'last 30 days' },
  { key: '3M', bucket: 'week', count: 13, window: '3 months', per: 'week', name: 'last 13 weeks' },
  { key: '6M', bucket: 'week', count: 26, window: '6 months', per: 'week', name: 'last 26 weeks' },
  { key: '1Y', bucket: 'month', count: 12, window: '1 year', per: 'month', name: 'last 12 months' },
  { key: '3Y', bucket: 'month', count: 36, window: '3 years', per: 'month', name: 'last 36 months' },
]);
export const RANGE_KEYS = RANGES.map((r) => r.key);
export const DEFAULT_RANGES = Object.freeze({ dashboard: '1M', chain: '1D' });

/** The range for a key; an unknown key gives `fallback` (a key), then 1M. */
export function rangeByKey(key, fallback = '1M') {
  return RANGES.find((r) => r.key === key) ?? RANGES.find((r) => r.key === fallback) ?? RANGES[2];
}

/** 'utc' or 'local' from the settings object. */
export const zoneOf = (settings = getSettings()) => (settings.timeZone === 'local' ? 'local' : 'utc');

const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));

function calendar(ms, zone) {
  const d = new Date(ms);
  return zone === 'local'
    ? { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), dow: d.getDay() }
    : { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), dow: d.getUTCDay() };
}

const make = (zone, y, mo, d, h = 0) => (zone === 'local' ? new Date(y, mo, d, h, 0, 0, 0).getTime() : Date.UTC(y, mo, d, h));

/** Start of the bucket of the given size that holds `ms`, in the zone. */
export function floorBucket(bucket, ms, zone = 'utc') {
  if (bucket === 'hour') {
    if (zone === 'local') { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); }
    return ms - (((ms % HOUR_MS) + HOUR_MS) % HOUR_MS);
  }
  const c = calendar(ms, zone);
  if (bucket === '6h') return make(zone, c.y, c.mo, c.d, c.h - (c.h % SIX_HOURS));
  if (bucket === 'day') return make(zone, c.y, c.mo, c.d);
  if (bucket === 'week') return make(zone, c.y, c.mo, c.d - ((c.dow + WEEK_START_OFFSET) % 7));
  if (bucket === 'month') return make(zone, c.y, c.mo, 1);
  throw new RangeError(`unknown bucket size: ${bucket}`);
}

/** Start of the bucket after the one that starts at `start`. */
export function nextBucketStart(bucket, start, zone = 'utc') {
  return floorBucket(bucket, start + PROBE_MS[bucket], zone);
}

/**
 * The buckets of a range: [{ start, end }] oldest first, the last one holding `now`.
 *
 * Args: rangeKey; now (Date | ms | ISO); zone 'utc' | 'local'.
 */
export function buildBuckets(rangeKey, now, zone = 'utc') {
  const range = rangeByKey(rangeKey);
  const nowMs = toMs(now);
  const starts = [floorBucket(range.bucket, nowMs, zone)];
  while (starts.length < range.count) {
    const first = starts[0];
    let prev = floorBucket(range.bucket, first - 1, zone);
    if (prev >= first) prev = first - HOUR_MS; // a zone change that repeats an hour must not stall the walk
    starts.unshift(prev);
  }
  return starts.map((start) => ({ start, end: nextBucketStart(range.bucket, start, zone) }));
}

/** Index of the bucket holding `t`, or -1. Buckets are sorted and contiguous. */
function locate(buckets, t) {
  if (!(t >= buckets[0].start) || !(t < buckets.at(-1).end)) return -1;
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buckets[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const two = (n) => String(n).padStart(2, '0');

/**
 * Axis label for a bucket start. Short for the axis, long for the tooltip and the table. Hours for
 * 1D, dates for days and weeks, "Mon YYYY" for months; in the zone and date format of the settings.
 */
export function bucketLabel(rangeKey, start, long = false, settings = getSettings()) {
  const range = rangeByKey(rangeKey);
  const zone = zoneOf(settings);
  const date = formatDate(start, settings);
  const shortDate = settings.dateFormat === 'long' ? date.replace(/, \d{4}$/, '') : date.slice(5);
  const clock = formatClock(start, settings).slice(0, 5);
  const zoneText = zone === 'local' ? 'local time' : 'UTC';
  const endClock = formatClock(nextBucketStart(range.bucket, start, zone), settings).slice(0, 5);
  if (range.bucket === 'hour') return long ? `${date} ${clock} to ${endClock} ${zoneText}` : clock;
  if (range.bucket === '6h') return long ? `${date} ${clock} to ${endClock} ${zoneText}` : (clock === '00:00' ? shortDate : clock);
  if (range.bucket === 'day') return long ? date : shortDate;
  if (range.bucket === 'week') return long ? `Week of ${date}` : shortDate;
  const c = calendar(start, zone);
  return `${MONTHS[c.mo]} ${c.y}`;
}

/**
 * One row per bucket of the range.
 *
 * Args:
 *   rangeKey, now, zone ('utc' | 'local');
 *   fields: the value names every row carries (all start at 0);
 *   events: [{ t (ms or ISO), values?: { field: n } }]; an event without values adds 1 to `count`;
 *   pre: [{ t, values: { field: n }, minutes? }] buckets somebody else aggregated, placed by their
 *     start time (an hour bucket in a zone with a half-hour offset lands in the bucket holding its start);
 *   firstRecordAt: ms of the first record, or null when there are none at all;
 *   coverage: true to track recording (minutes of `pre` rows) so a bucket with none is 'off'.
 * Returns: { range, rows, windowStart, windowEnd, firstRecordAt, hasNone, hasOff } where each row is
 *   { start, end, t, status, partial, values, coverageMinutes, spanMinutes }.
 */
export function bucketRows({ rangeKey, now, zone = 'utc', fields = ['count'], events = [], pre = [], firstRecordAt = null, coverage = false }) {
  const range = rangeByKey(rangeKey);
  const nowMs = toMs(now);
  const buckets = buildBuckets(rangeKey, nowMs, zone);
  const rows = buckets.map((b, i) => ({
    start: b.start, end: b.end, t: b.start, status: 'ok', partial: i === buckets.length - 1,
    values: Object.fromEntries(fields.map((f) => [f, 0])), coverageMinutes: 0,
    spanMinutes: Math.round((Math.min(b.end, nowMs) - b.start) / MINUTE_MS),
  }));
  for (const event of events) {
    const i = locate(buckets, toMs(event.t));
    if (i < 0) continue;
    if (event.values) for (const [k, v] of Object.entries(event.values)) rows[i].values[k] = (rows[i].values[k] ?? 0) + v;
    else rows[i].values.count = (rows[i].values.count ?? 0) + 1;
  }
  for (const item of pre) {
    const i = locate(buckets, toMs(item.t));
    if (i < 0) continue;
    for (const [k, v] of Object.entries(item.values ?? {})) rows[i].values[k] = (rows[i].values[k] ?? 0) + v;
    rows[i].coverageMinutes += item.minutes ?? 0;
  }
  for (const row of rows) {
    if (firstRecordAt === null || row.end <= firstRecordAt) row.status = 'none';
    else if (coverage && row.coverageMinutes === 0) row.status = 'off';
  }
  return {
    range, rows, windowStart: buckets[0].start, windowEnd: nowMs, firstRecordAt,
    hasNone: rows.some((r) => r.status === 'none'), hasOff: rows.some((r) => r.status === 'off'),
  };
}

/**
 * The visible note for a range that reaches back before the first record: "Records start 2026-10-14."
 * Empty when every bucket is inside the recorded period. With no record at all: "No records yet."
 */
export function recordsNote(result, settings = getSettings()) {
  if (result.firstRecordAt === null) return 'No records yet.';
  if (result.windowStart < result.firstRecordAt) return `Records start ${formatDate(result.firstRecordAt, settings)}.`;
  return '';
}

/** Chart points for createChart: gaps carry `gap: 'none' | 'off'` so they are drawn as gaps, not zero bars. */
export function toChartPoints(result, { note = null } = {}) {
  return result.rows.map((r) => ({
    t: r.t, values: { ...r.values }, gap: r.status === 'ok' ? undefined : r.status, note: r.status === 'ok' && note ? note(r) : undefined,
  }));
}
