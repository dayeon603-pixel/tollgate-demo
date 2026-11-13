// Time ranges: bucketing for every range (counts, boundaries, month lengths, leap day, time zone, "no records"
// before the first record, coverage gaps) and the dashboard figures built on it. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bucketLabel, bucketRows, buildBuckets, DAY_MS, DEFAULT_RANGES, floorBucket, HOUR_MS, MINUTE_MS, RANGE_KEYS, RANGES, rangeByKey, recordsNote, toChartPoints, zoneOf } from '../js/ws/timerange.js';
import { DEFAULTS } from '../js/ws/settings.js';
import { createWorkspace } from '../js/ws/session.js';
import { rangeVolume, summary } from '../js/ws/metrics.js';

const NOW = Date.parse('2026-11-13T14:03:12.481Z'); // a Friday
const utc = { ...DEFAULTS, timeZone: 'utc' };
const local = { ...DEFAULTS, timeZone: 'local' };
const COUNTS = { '1D': 24, '1W': 28, '1M': 30, '3M': 13, '6M': 26, '1Y': 12, '3Y': 36 };
const iso = (ms) => new Date(ms).toISOString();

/** Runs fn with the process time zone set to `tz`, then restores it. */
async function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return await fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

test('ranges: the seven stock-style ranges, in order, with the specified bucket sizes', () => {
  assert.deepEqual(RANGE_KEYS, ['1D', '1W', '1M', '3M', '6M', '1Y', '3Y']);
  assert.deepEqual(Object.fromEntries(RANGES.map((r) => [r.key, r.bucket])), { '1D': 'hour', '1W': '6h', '1M': 'day', '3M': 'week', '6M': 'week', '1Y': 'month', '3Y': 'month' });
  assert.deepEqual(DEFAULT_RANGES, { dashboard: '1M', chain: '1D' });
  assert.equal(rangeByKey('nope').key, '1M', 'an unknown key falls back');
  assert.equal(rangeByKey('nope', '1D').key, '1D');
  assert.equal(zoneOf(utc), 'utc');
  assert.equal(zoneOf(local), 'local');
});

test('buckets: every range has the right number of contiguous buckets and the last one holds now', () => {
  for (const [key, count] of Object.entries(COUNTS)) {
    const b = buildBuckets(key, NOW, 'utc');
    assert.equal(b.length, count, `${key} has ${count} buckets`);
    for (let i = 1; i < b.length; i++) assert.equal(b[i].start, b[i - 1].end, `${key}: bucket ${i} starts where the one before ends`);
    assert.ok(b.at(-1).start <= NOW && NOW < b.at(-1).end, `${key}: the last bucket holds now`);
  }
});

test('buckets: boundaries and sizes in UTC', () => {
  const at = (key) => buildBuckets(key, NOW, 'utc');
  assert.equal(iso(at('1D').at(-1).start), '2026-11-13T14:00:00.000Z');
  assert.equal(iso(at('1D')[0].start), '2026-11-12T15:00:00.000Z');
  assert.ok(at('1D').every((b) => b.end - b.start === HOUR_MS));
  assert.equal(iso(at('1W').at(-1).start), '2026-11-13T12:00:00.000Z', '6-hourly buckets start at 00, 06, 12, 18');
  assert.ok(at('1W').every((b) => b.end - b.start === 6 * HOUR_MS));
  assert.equal(iso(at('1M').at(-1).start), '2026-11-13T00:00:00.000Z');
  assert.equal(iso(at('1M')[0].start), '2026-10-15T00:00:00.000Z');
  assert.ok(at('1M').every((b) => b.end - b.start === DAY_MS));
  assert.equal(iso(at('3M').at(-1).start), '2026-11-09T00:00:00.000Z', 'weeks start on Monday');
  assert.ok(at('3M').every((b) => new Date(b.start).getUTCDay() === 1 && b.end - b.start === 7 * DAY_MS));
  assert.equal(iso(at('6M')[0].start), '2026-05-18T00:00:00.000Z');
  assert.equal(iso(at('1Y').at(-1).start), '2026-11-01T00:00:00.000Z');
  assert.equal(iso(at('1Y')[0].start), '2025-12-01T00:00:00.000Z');
  assert.equal(iso(at('3Y')[0].start), '2023-12-01T00:00:00.000Z');
  assert.ok(at('3Y').every((b) => new Date(b.start).getUTCDate() === 1));
});

test('buckets: month lengths are the real ones, including a leap day', () => {
  const months = buildBuckets('3Y', NOW, 'utc');
  const lengthOf = (start) => { const b = months.find((m) => m.start === Date.parse(start)); return (b.end - b.start) / DAY_MS; };
  assert.equal(lengthOf('2024-02-01T00:00:00Z'), 29, 'February 2024 has the leap day');
  assert.equal(lengthOf('2025-02-01T00:00:00Z'), 28);
  assert.equal(lengthOf('2024-04-01T00:00:00Z'), 30);
  assert.equal(lengthOf('2024-03-01T00:00:00Z'), 31);
  // A daily range that crosses 29 February has a 29 February bucket, and a 1D range on it works.
  const leapNow = Date.parse('2024-03-05T10:00:00Z');
  const days = buildBuckets('1M', leapNow, 'utc').map((b) => iso(b.start).slice(0, 10));
  assert.ok(days.includes('2024-02-29'));
  assert.equal(days.indexOf('2024-03-01') - days.indexOf('2024-02-29'), 1);
  const feb29 = buildBuckets('1D', Date.parse('2024-02-29T23:30:00Z'), 'utc');
  assert.equal(iso(feb29.at(-1).end), '2024-03-01T00:00:00.000Z');
  assert.equal(iso(buildBuckets('1Y', Date.parse('2028-03-01T00:00:00Z'), 'utc').at(-2).end), '2028-03-01T00:00:00.000Z');
  assert.equal(floorBucket('month', Date.parse('2028-02-29T23:59:59Z'), 'utc'), Date.parse('2028-02-01T00:00:00Z'));
});

test('buckets: the time zone setting moves the boundaries (local zone, DST)', async () => {
  await inZone('Asia/Seoul', () => {
    const day = buildBuckets('1M', NOW, 'local').at(-1);
    assert.equal(iso(day.start), '2026-11-12T15:00:00.000Z', 'a Seoul day starts at 15:00 UTC the day before');
    const hour = buildBuckets('1D', NOW, 'local').at(-1);
    assert.equal(iso(hour.start), '2026-11-13T14:00:00.000Z');
    assert.equal(iso(buildBuckets('1Y', NOW, 'local').at(-1).start), '2026-10-31T15:00:00.000Z');
    // Half past the UTC hour in Seoul is still a whole local hour, so the hourly bucket is unchanged.
    assert.equal(bucketLabel('1D', hour.start, false, local), '23:00');
    assert.equal(bucketLabel('1D', hour.start, false, utc), '14:00');
  });
  await inZone('Asia/Kolkata', () => {
    const hour = buildBuckets('1D', NOW, 'local').at(-1);
    assert.equal(iso(hour.start), '2026-11-13T13:30:00.000Z', 'a half-hour zone has half-hour UTC boundaries');
    assert.equal(hour.end - hour.start, HOUR_MS);
  });
  await inZone('America/New_York', () => {
    // 1 November 2026 is the day the clocks go back: that local day is 25 hours long.
    const days = buildBuckets('1M', Date.parse('2026-11-05T12:00:00Z'), 'local');
    const fall = days.find((d) => iso(d.start) === '2026-11-01T04:00:00.000Z');
    assert.equal((fall.end - fall.start) / HOUR_MS, 25);
    assert.equal(days.length, 30);
    for (let i = 1; i < days.length; i++) assert.equal(days[i].start, days[i - 1].end);
    const spring = buildBuckets('1M', Date.parse('2026-03-12T12:00:00Z'), 'local').find((d) => iso(d.start) === '2026-03-08T05:00:00.000Z');
    assert.equal((spring.end - spring.start) / HOUR_MS, 23);
  });
});

test('labels: hours for 1D, dates for days and weeks, "Mon YYYY" for months', () => {
  const start = (key) => buildBuckets(key, NOW, 'utc').at(-1).start;
  assert.equal(bucketLabel('1D', start('1D'), false, utc), '14:00');
  assert.equal(bucketLabel('1D', start('1D'), true, utc), '2026-11-13 14:00 to 15:00 UTC');
  assert.equal(bucketLabel('1W', start('1W'), false, utc), '12:00');
  assert.equal(bucketLabel('1W', Date.parse('2026-11-13T00:00:00Z'), false, utc), '11-13', 'a 6-hourly bucket at midnight shows the date');
  assert.equal(bucketLabel('1W', start('1W'), true, utc), '2026-11-13 12:00 to 18:00 UTC');
  assert.equal(bucketLabel('1M', start('1M'), false, utc), '11-13');
  assert.equal(bucketLabel('1M', start('1M'), true, utc), '2026-11-13');
  assert.equal(bucketLabel('3M', start('3M'), false, utc), '11-09');
  assert.equal(bucketLabel('3M', start('3M'), true, utc), 'Week of 2026-11-09');
  assert.equal(bucketLabel('1Y', start('1Y'), false, utc), 'Nov 2026');
  assert.equal(bucketLabel('3Y', Date.parse('2024-02-01T00:00:00Z'), true, utc), 'Feb 2024');
  assert.equal(bucketLabel('1M', start('1M'), false, { ...utc, dateFormat: 'long' }), 'Nov 13');
  assert.equal(bucketLabel('1M', start('1M'), true, { ...utc, dateFormat: 'long' }), 'Nov 13, 2026');
});

test('rows: events land in their bucket; events outside the window and bad times are ignored', () => {
  const events = [
    { t: NOW - 2 * 60_000, values: { a: 1 } }, // same hour (14:01)
    { t: NOW - 30 * 60_000, values: { a: 2, b: 1 } }, // the hour before (13:33)
    { t: NOW - 25 * HOUR_MS, values: { a: 100 } }, // outside 1D
    { t: NOW + HOUR_MS, values: { a: 100 } }, // the future
    { t: 'not a time', values: { a: 100 } },
  ];
  const r = bucketRows({ rangeKey: '1D', now: NOW, fields: ['a', 'b'], events, firstRecordAt: NOW - 30 * DAY_MS });
  assert.equal(r.rows.length, 24);
  assert.equal(r.rows.at(-1).values.a, 1);
  assert.equal(r.rows.at(-2).values.a, 2);
  assert.equal(r.rows.at(-2).values.b, 1);
  assert.equal(r.rows.reduce((n, x) => n + x.values.a, 0), 3);
  assert.ok(r.rows.every((x) => x.status === 'ok'));
  assert.equal(r.rows.at(-1).partial, true);
  assert.equal(r.rows.at(-1).spanMinutes, 3, 'the current hour has run for 3 minutes');
  assert.equal(r.rows[0].spanMinutes, 60);
  const plain = bucketRows({ rangeKey: '1M', now: NOW, events: [{ t: NOW }, { t: NOW }] });
  assert.equal(plain.rows.at(-1).values.count, 2, 'an event without values counts as one');
});

test('rows: buckets before the first record are "none" (no records), not zeros; the bucket holding it is ok', () => {
  const first = Date.parse('2026-11-05T09:30:00Z');
  const r = bucketRows({ rangeKey: '1M', now: NOW, fields: ['n'], events: [{ t: first, values: { n: 4 } }], firstRecordAt: first });
  const firstIndex = r.rows.findIndex((x) => x.start <= first && first < x.end);
  assert.equal(iso(r.rows[firstIndex].start), '2026-11-05T00:00:00.000Z');
  assert.ok(r.rows.slice(0, firstIndex).every((x) => x.status === 'none'));
  assert.equal(r.rows.slice(0, firstIndex).length, 21, '15 October to 4 November');
  assert.ok(r.rows.slice(firstIndex).every((x) => x.status === 'ok'), 'after the first record a zero is a real zero');
  assert.equal(r.rows[firstIndex + 1].values.n, 0);
  assert.equal(r.rows[firstIndex].values.n, 4);
  assert.equal(r.hasNone, true);
  assert.equal(r.hasOff, false);
  assert.equal(recordsNote(r, utc), 'Records start 2026-11-05.');
  assert.equal(recordsNote(r, { ...utc, dateFormat: 'long' }), 'Records start Nov 5, 2026.');
  // A range that starts after the first record has no note and no "none".
  const inside = bucketRows({ rangeKey: '1D', now: NOW, fields: ['n'], firstRecordAt: first });
  assert.equal(recordsNote(inside, utc), '');
  assert.equal(inside.hasNone, false);
  // No records at all: every bucket is "none".
  const nothing = bucketRows({ rangeKey: '3Y', now: NOW, fields: ['n'], firstRecordAt: null });
  assert.ok(nothing.rows.every((x) => x.status === 'none'));
  assert.equal(recordsNote(nothing, utc), 'No records yet.');
});

test('rows: with coverage, a bucket after the first record with no recorded minute is "off" (not recording), distinct from zero', () => {
  const first = Date.parse('2026-11-13T10:00:00Z');
  const pre = [
    { t: first, values: { clear: 5 }, minutes: 1 },
    { t: first + MINUTE_MS, values: { clear: 0 }, minutes: 1 }, // recorded, and nothing happened: a real zero
    { t: Date.parse('2026-11-13T12:20:00Z'), values: { clear: 2, hit: 1 }, minutes: 1 },
    { t: Date.parse('2026-11-13T13:00:00Z'), values: { clear: 1 }, minutes: 40 }, // an hour bucket from compaction, 40 minutes recorded
  ];
  const r = bucketRows({ rangeKey: '1D', now: NOW, fields: ['clear', 'hit'], pre, firstRecordAt: first, coverage: true });
  const byHour = (h) => r.rows.find((x) => iso(x.start) === `2026-11-13T${h}:00:00.000Z`);
  assert.equal(byHour('09').status, 'none', 'before the first record');
  assert.equal(byHour('10').status, 'ok');
  assert.equal(byHour('10').values.clear, 5);
  assert.equal(byHour('10').coverageMinutes, 2);
  assert.equal(byHour('11').status, 'off', 'after the first record, nothing was recording');
  assert.equal(byHour('11').values.clear, 0, 'an off bucket carries no values; the chart draws it as a gap, not a bar');
  assert.equal(byHour('12').values.hit, 1);
  assert.equal(byHour('13').coverageMinutes, 40);
  assert.equal(byHour('14').status, 'off', 'the current hour, before anything was recorded in it');
  assert.equal(r.hasOff, true);
  // Without coverage tracking (the dashboard) the same empty hour is an honest zero.
  const noCov = bucketRows({ rangeKey: '1D', now: NOW, fields: ['clear'], pre, firstRecordAt: first });
  assert.equal(noCov.rows.find((x) => iso(x.start) === '2026-11-13T11:00:00.000Z').status, 'ok');
  // Chart points: gaps are marked, recorded buckets get the note.
  const points = toChartPoints(r, { note: (row) => `${row.coverageMinutes} min` });
  assert.equal(points.find((p) => p.t === byHour('09').start).gap, 'none');
  assert.equal(points.find((p) => p.t === byHour('11').start).gap, 'off');
  assert.equal(points.find((p) => p.t === byHour('10').start).gap, undefined);
  assert.equal(points.find((p) => p.t === byHour('10').start).note, '2 min');
  assert.equal(points.find((p) => p.t === byHour('11').start).note, undefined);
});

test('rows: a pre-aggregated bucket is placed by its start, for every range', () => {
  const t = Date.parse('2026-11-13T09:15:00Z');
  for (const key of RANGE_KEYS) {
    const r = bucketRows({ rangeKey: key, now: NOW, fields: ['n'], pre: [{ t, values: { n: 7 }, minutes: 1 }], firstRecordAt: t, coverage: true });
    const hit = r.rows.filter((x) => x.values.n === 7);
    assert.equal(hit.length, 1, `${key}: one bucket holds it`);
    assert.ok(hit[0].start <= t && t < hit[0].end, `${key}: and it is the right one`);
  }
});

test('bucketing is stable for a one-event-per-bucket sweep across every range', () => {
  for (const key of RANGE_KEYS) {
    const buckets = buildBuckets(key, NOW, 'utc');
    const events = buckets.map((b) => ({ t: b.start }));
    events.push(...buckets.map((b) => ({ t: b.end - 1 })));
    const r = bucketRows({ rangeKey: key, now: NOW, events, firstRecordAt: buckets[0].start - 1 });
    assert.ok(r.rows.every((x) => x.values.count === 2), `${key}: the first and last millisecond of each bucket belong to it`);
  }
});

test('dashboard: the 1M figures equal the old 30-day figures; longer ranges never invent history', async () => {
  const list = JSON.parse(await readFile(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8'));
  const anchor = new Date('2026-11-06T10:00:00.000Z');
  const now = new Date('2026-11-06T10:30:00.000Z');
  const { ws } = await createWorkspace({ list, anchor });
  const old = summary(ws, now, 30);
  const month = summary(ws, now, 30, { rangeKey: '1M', zone: 'utc' });
  assert.equal(month.total, old.total);
  assert.equal(month.allow, old.allow);
  assert.equal(month.hold, old.hold);
  assert.equal(month.block, old.block);
  assert.equal(month.rows.length, 30);
  const everything = ws.txs.length;
  const three = rangeVolume(ws, now, '3Y', 'utc');
  assert.equal(three.rows.length, 36);
  assert.equal(three.total, everything, '3Y holds exactly the seeded transactions, nothing synthetic added');
  const first = Math.min(...ws.txs.map((t) => Date.parse(t.ts)));
  assert.equal(three.firstRecordAt, first);
  const none = three.rows.filter((r) => r.status === 'none');
  assert.ok(none.length >= 33, `most of 3Y is before the first record (${none.length} of 36 buckets)`);
  assert.ok(none.every((r) => r.end <= first && r.values.allow + r.values.hold + r.values.block === 0));
  assert.match(recordsNote(three, utc), /^Records start 2026-/);
  const day = rangeVolume(ws, now, '1D', 'utc');
  assert.equal(day.rows.length, 24);
  assert.equal(day.total, ws.txs.filter((t) => Date.parse(t.ts) >= day.windowStart && Date.parse(t.ts) < day.rows.at(-1).end).length);
  assert.ok(day.total <= month.total);
});
