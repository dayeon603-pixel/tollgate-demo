/**
 * Synthetic demo history. Every transaction, counterparty, amount and analyst note here is made
 * up by a seeded generator. The only real data is the sanctions list itself: sanctioned addresses
 * that transactions are pointed at come from the bundled OFAC snapshot.
 *
 * The history is produced by feeding ops to the real engine, so every alert has a genuine receipt
 * trail and the numbers on the dashboard are computed from the same state the rest of the app uses.
 */
import { between, DAY_MS, fakeEthAddress, fakeTronAddress, HOUR_MS, pick, rng, startOfUtcDay } from './util.js';

export const HISTORY_DAYS = 30;
const MIN_MS = 60_000;
const HIT_RATE = 0.04;
const NO_ORIGINATOR_RATE = 0.12;
const COUNTERPARTY_POOL = 42;

const HOLD_NOTES = {
  blank_originator: 'Originator details received from the sender and matched to the payment record.',
  large_value: 'Amount checked against the expected range for this counterparty. Within range.',
};

/** Splits list addresses into those present in every version and those a later version adds. */
function pools(versions, heldLatest, heldMiddle) {
  const [v1, v2, v3] = versions;
  const stable = [];
  for (const [key, entries] of v3.byAddress) {
    if (v1.byAddress.has(key) && v2.byAddress.has(key) && /^(0x[0-9a-f]{40}|T[1-9A-HJ-NP-Za-km-z]{33})$/i.test(entries[0].address)) stable.push(entries[0].address);
  }
  stable.sort();
  const synthetic = [...v2.byAddress.values()].map((e) => e[0]).filter((e) => e.synthetic).map((e) => e.address).sort();
  return {
    stable,
    synthetic,
    heldLatest: heldLatest.map((key) => v3.byAddress.get(key)[0].address),
    heldMiddle: heldMiddle.map((key) => v3.byAddress.get(key)[0].address),
  };
}

function amountFor(rand) {
  const r = rand();
  if (r < 0.55) return between(rand, 50, 999);
  if (r < 0.85) return between(rand, 1000, 9999);
  if (r < 0.97) return between(rand, 10_000, 49_999);
  return between(rand, 50_000, 250_000);
}

/** Pre-plans how an alert is worked, as ops at later times. Steps past "now" are dropped by the caller. */
function lifecycle(alert, rand, users) {
  const steps = [];
  const owner = pick(rand, [users.a, users.b]);
  const approver = () => (rand() < 0.7 ? users.c : users.d);
  let t = Date.parse(alert.createdAt);
  const step = (minutes, op) => {
    t += minutes * MIN_MS;
    steps.push({ op: 'alertAction', ...op, ts: new Date(t).toISOString(), alertId: alert.id });
  };
  const r = rand();
  if (alert.kind === 'hold') {
    if (r < 0.1) return steps;
    step(between(rand, 20, 360), { actor: owner, action: 'start_review' });
    if (r < 0.2) return steps;
    const holdNote = HOLD_NOTES[alert.rule] ?? 'Reviewed and released.';
    if (r >= 0.88) {
      step(between(rand, 30, 240), { actor: owner, action: 'confirm', note: 'Originator details not provided after a request. Hold upheld and payment returned.' });
    } else if (r >= 0.78) {
      step(between(rand, 30, 240), { actor: owner, action: 'propose_clear', note: holdNote });
      step(between(rand, 30, 300), { actor: users.c, action: 'reject_clear', note: 'Supporting document is missing. Please attach it and propose again.' });
    } else {
      step(between(rand, 30, 240), { actor: owner, action: 'propose_clear', note: holdNote });
      step(between(rand, 30, 600), { actor: approver(), action: 'approve_clear' });
    }
    return steps;
  }
  if (r < 0.12) return steps;
  step(between(rand, 10, 180), { actor: owner, action: 'start_review' });
  if (r < 0.28) return steps;
  if (r < 0.42) {
    step(between(rand, 20, 200), { actor: owner, action: 'escalate', note: 'Exact address match on the list. Escalating for a decision.' });
    if (rand() < 0.6) step(between(rand, 60, 900), { actor: approver(), action: 'confirm', note: 'Match confirmed against the list entry. Payment blocked and recorded.' });
    return steps;
  }
  step(between(rand, 20, 300), { actor: owner, action: 'note', note: 'Checked the list entry and the payment record. Address matches exactly.' });
  step(between(rand, 20, 300), { actor: owner, action: 'confirm', note: 'Confirmed hit on the list. Payment blocked and recorded.' });
  return steps;
}

/**
 * Builds the demo history by applying ops to an empty workspace.
 *
 * Args: ws, a new Workspace; anchor, the Date the demo was started (history ends just before it);
 *   held, { heldLatest, heldMiddle } from buildVersions; seed, makes the data reproducible.
 * Returns: the number of ops applied.
 */
export async function seedWorkspace(ws, { anchor, held, seed = 20261106, days = HISTORY_DAYS }) {
  const rand = rng(seed);
  const users = { a: 'analyst-a', b: 'analyst-b', c: 'approver-c', d: 'admin-d' };
  const pool = pools(ws.versions, held.heldLatest, held.heldMiddle);
  const start = startOfUtcDay(new Date(anchor.getTime() - days * DAY_MS));
  const end = anchor.getTime() - 30 * MIN_MS;
  const at = (dayOffset, hours) => new Date(start.getTime() + dayOffset * DAY_MS + hours * HOUR_MS).toISOString();
  const counterparties = Array.from({ length: COUNTERPARTY_POOL }, (_, i) => (i % 3 === 2 ? fakeTronAddress(rand) : fakeEthAddress(rand)));
  const queue = [];
  const dayOfV2 = Math.round(days * 0.6);

  queue.push({ op: 'listUpdate', ts: at(0, 1), actor: users.d, toVersionId: 'L1' });
  counterparties.slice(0, 4).forEach((address, i) => queue.push({ op: 'watchAdd', ts: at(0, 2 + i), actor: users.a, address, label: `Counterparty W-0${i + 1} (demo label)` }));
  queue.push({ op: 'watchAdd', ts: at(1, 3), actor: users.b, address: pool.heldMiddle[0], label: 'Counterparty W-05 (demo label)' });
  queue.push({ op: 'watchAdd', ts: at(2, 3), actor: users.b, address: pool.heldLatest[0], label: 'Counterparty W-06 (demo label)' });
  queue.push({ op: 'policySet', ts: at(Math.round(days * 0.45), 9), actor: users.d, key: 'rules.large_value.thresholdUsd', value: 50_000 });
  queue.push({ op: 'listUpdate', ts: at(dayOfV2, 8), actor: users.d, toVersionId: 'L2' });

  // Payments to addresses that a later list version adds. They are clean when screened.
  const planted = [
    [5, pool.heldMiddle[0]], [7, pool.heldMiddle[1]], [dayOfV2 - 2, pool.heldLatest[1]],
    [dayOfV2 + 3, pool.heldLatest[0]], [dayOfV2 + 5, pool.heldLatest[0]], [dayOfV2 + 8, pool.heldLatest[2]],
  ];
  for (const [day, address] of planted) {
    queue.push({ op: 'screen', ts: at(day, between(rand, 8, 18)), actor: 'api', source: 'api', address, amount: between(rand, 800, 40_000), originator: true });
  }

  for (let d = 0; d < days + 1; d++) {
    const weekend = [0, 6].includes(new Date(start.getTime() + d * DAY_MS).getUTCDay());
    const count = weekend ? between(rand, 2, 5) : between(rand, 8, 14);
    for (let i = 0; i < count; i++) {
      const ts = at(d, 6 + rand() * 14);
      if (Date.parse(ts) > end) continue;
      const hit = rand() < HIT_RATE;
      const address = hit
        ? (rand() < 0.22 ? pick(rand, pool.synthetic) : pick(rand, pool.stable))
        : counterparties[Math.floor(rand() ** 1.6 * counterparties.length)];
      queue.push({ op: 'screen', ts, actor: 'api', source: 'api', address, amount: amountFor(rand), originator: rand() >= NO_ORIGINATOR_RATE });
    }
  }

  let applied = 0;
  for (;;) {
    queue.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const next = queue.shift();
    if (!next || Date.parse(next.ts) > end) break;
    const result = await ws.apply(next);
    applied++;
    for (const alert of result.created ?? []) for (const op of lifecycle(alert, rand, users)) if (Date.parse(op.ts) <= end) queue.push(op);
  }
  ws.seedCount = ws.ops.length;
  return applied;
}
