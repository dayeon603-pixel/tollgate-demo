/**
 * Time and cost. Two separate things, never mixed:
 *  - measurements: how long this browser actually took to do work the app can do (recorded, not assumed);
 *  - an estimate: arithmetic on numbers the visitor types in. Nothing here is our data or industry data.
 */

export const ESTIMATE_NOTE = 'Estimate from your inputs. Not a measured result.';

export const INPUTS = [
  { key: 'analysts', label: 'Analysts on the alert queue', unit: 'people', required: false },
  { key: 'alertsPerMonth', label: 'Alerts per month', unit: 'alerts', required: true },
  { key: 'minutesNow', label: 'Minutes per alert to assemble the evidence today', unit: 'min', required: true },
  { key: 'minutesWith', label: 'Minutes per alert you expect with receipts (your assumption)', unit: 'min', required: false },
  { key: 'auditsPerYear', label: 'Audits or exams per year', unit: 'audits', required: true },
  { key: 'hoursNow', label: 'Hours per audit spent rebuilding records today', unit: 'h', required: true },
  { key: 'hoursWith', label: 'Hours per audit you expect with receipts (your assumption)', unit: 'h', required: false },
  { key: 'hourlyCost', label: 'Loaded hourly cost of the people doing this', unit: 'currency per h', required: true },
];

/** Reads typed text into a non-negative number, or null when blank or invalid. */
export function readNumber(text) {
  if (text === null || text === undefined) return null;
  const clean = String(text).replace(/[,\s]/g, '');
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
}

/**
 * Args: raw, { key: typed text or number }.
 * Returns: { ready, missing: [labels], now: {...}, with: {...}|null, difference: {...}|null }.
 *   now.alertHours = alertsPerMonth * minutesNow / 60 * 12
 *   now.auditHours = auditsPerYear * hoursNow
 *   hours = alertHours + auditHours; cost = hours * hourlyCost
 *   "with" uses minutesWith and hoursWith the same way; the difference is now minus with.
 */
export function estimate(raw) {
  const v = Object.fromEntries(INPUTS.map((i) => [i.key, readNumber(raw?.[i.key])]));
  const missing = INPUTS.filter((i) => i.required && v[i.key] === null).map((i) => i.label);
  if (missing.length) return { ready: false, missing, now: null, with: null, difference: null, note: ESTIMATE_NOTE };
  const side = (minutes, hours) => {
    const alertHours = (v.alertsPerMonth * minutes) / 60 * 12;
    const auditHours = v.auditsPerYear * hours;
    const total = alertHours + auditHours;
    return { alertHours, auditHours, hours: total, cost: total * v.hourlyCost, perAnalystHours: v.analysts ? total / v.analysts : null };
  };
  const now = side(v.minutesNow, v.hoursNow);
  const hasWith = v.minutesWith !== null && v.hoursWith !== null;
  const withSide = hasWith ? side(v.minutesWith, v.hoursWith) : null;
  const difference = withSide ? { hours: now.hours - withSide.hours, cost: now.cost - withSide.cost } : null;
  return { ready: true, missing: [], now, with: withSide, difference, note: ESTIMATE_NOTE };
}

/** The formulas, as text, for display next to the result. */
export const FORMULAS = [
  'Alert hours per year = alerts per month x minutes per alert / 60 x 12',
  'Audit hours per year = audits per year x hours per audit',
  'Hours = alert hours + audit hours',
  'Cost = hours x loaded hourly cost',
  'Difference = hours (or cost) today minus hours (or cost) with your own "with receipts" assumptions',
];

/** In-memory log of work timed in this browser session. */
export class Measurements {
  constructor() { this.items = []; }

  /** kind: short key; label: what was done; ms; detail: counts. */
  record(kind, label, ms, detail = {}) {
    const item = { kind, label, ms, detail, at: new Date().toISOString() };
    this.items.push(item);
    if (this.items.length > 200) this.items.shift();
    return item;
  }

  /** Newest measurement of each kind. */
  latest() {
    const map = new Map();
    for (const i of this.items) map.set(i.kind, i);
    return Array.from(map.values());
  }

  /** Times an async function and records it. detail may be a function of the result. */
  async time(kind, label, fn, detail = {}) {
    const t0 = performance.now();
    const result = await fn();
    this.record(kind, label, performance.now() - t0, typeof detail === 'function' ? detail(result) : detail);
    return result;
  }
}

export function formatMs(ms) {
  return ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Procedural comparison for one audit question. Steps only: no durations. */
export const AUDIT_QUESTION = 'Show what you checked for this payment and against which list.';
export const BEFORE_STEPS = [
  'Search application and screening logs for the payment.',
  'Work out which list version was in use at that time.',
  'Find or re-create that list file and its date.',
  'Re-run or reconstruct the screening to show the result.',
  'Write up what was found and attach the screenshots.',
];
export const WITH_STEPS = [
  'Open the receipt for the payment in the Receipt explorer.',
  'Verify it. The check runs in your browser and reports the signature, links and list fingerprint.',
  'Export it in an evidence pack. The pack can be checked offline by the auditor.',
];
