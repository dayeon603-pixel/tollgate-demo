// Live stream, counterparty graph and bulk triage logic. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspace } from '../js/ws/session.js';
import { buildPack, verifyPack } from '../js/ws/evidence.js';
import { LiveTape, LiveRunner, makeEvent, mixSeed, percentile, SPEEDS } from '../js/ws/stream.js';
import { addressProfile, buildGraph, busiestAddress, collectPayments, edgeWidth, flowModel, FLOW_TOP, GRAPH_MAX_NODES, layoutGraph, suggestedAddresses } from '../js/ws/graph.js';
import { applyBulk, planBulk } from '../js/ws/triage.js';
import { WorkspaceError } from '../js/ws/engine.js';

const list = JSON.parse(await readFile(new URL('../data/ofac_crypto_addresses.json', import.meta.url), 'utf8'));
const ANCHOR = new Date('2026-11-06T10:00:00.000Z');
const fresh = () => createWorkspace({ list, anchor: ANCHOR });
const fixedClock = () => { let t = Date.parse('2026-11-06T12:00:00.000Z'); return () => (t += 137); };
const tapeOf = (ws, over = {}) => new LiveTape({ ws, clock: fixedClock(), ...over });
const shape = (r) => ({ i: r.i, chain: r.chain, asset: r.asset, amountUsd: r.amountUsd, from: r.from, to: r.to, outcome: r.outcome, receiptId: r.receiptId });

test('stream: same seed gives the same payments, decisions and receipt ids', async () => {
  const { ws } = await fresh();
  const a = await tapeOf(ws).step(80);
  const b = await tapeOf(ws).step(80);
  assert.deepEqual(a.map(shape), b.map(shape));
  const c = await tapeOf(ws, { seed: 99 }).step(80);
  assert.notDeepEqual(a.map(shape), c.map(shape));
  assert.equal(JSON.stringify(makeEvent(5, tapeOf(ws).pools)), JSON.stringify(makeEvent(5, tapeOf(ws).pools)));
  assert.notEqual(mixSeed(1, 1), mixSeed(1, 2));
});

test('stream: decisions come from the exact-match engine and the hold policy', async () => {
  const { ws } = await fresh();
  const records = await tapeOf(ws).step(400);
  const outcomes = new Set(records.map((r) => r.outcome));
  assert.ok(outcomes.has('ALLOW') && outcomes.has('HOLD') && outcomes.has('BLOCK'), `saw ${[...outcomes]}`);
  for (const r of records) {
    const onList = ws.inForce.byAddress.has(r.to.toLowerCase());
    if (r.outcome === 'BLOCK') assert.ok(onList);
    else assert.ok(!onList);
    if (r.outcome === 'HOLD') assert.ok(r.amountUsd >= 1000);
    assert.ok(r.ms >= 0);
  }
});

test('stream: rolling cap keeps the live ledger bounded and verifying', async () => {
  const { ws } = await fresh();
  const tape = tapeOf(ws, { maxReceipts: 60 });
  await tape.step(200);
  assert.ok(tape.epoch > 1, 'ledger rolled');
  assert.ok(tape.ledger.size <= 60 + 2, `size ${tape.ledger.size}`);
  const result = await tape.verify();
  assert.equal(result.ok, true);
  assert.equal(tape.issued, 200);
  const small = tapeOf(ws, { maxEvents: 50 });
  await small.step(120);
  assert.equal(small.events.length, 50);
});

test('stream: the workspace ledger and evidence packs are untouched by streaming', async () => {
  const { ws } = await fresh();
  const before = { size: ws.ledger.size, head: ws.ledger.head(), segments: ws.ledger.segments.length, txs: ws.txs.length, alerts: ws.alerts.length };
  const tape = tapeOf(ws);
  await tape.step(150);
  assert.deepEqual({ size: ws.ledger.size, head: ws.ledger.head(), segments: ws.ledger.segments.length, txs: ws.txs.length, alerts: ws.alerts.length }, before);
  assert.equal((await ws.ledger.verifyAll()).ok, true);
  const pack = await buildPack(ws, { type: 'all' }, { now: ANCHOR, actor: 'analyst-a' });
  const check = await verifyPack(pack);
  assert.equal(check.ok, true);
  assert.ok(tape.ledger.entries.every((e) => e.receipt.receipt_id.startsWith('rcpt:d')));
});

test('stream: series, latency and hourly counters add up', async () => {
  const { ws } = await fresh();
  const tape = tapeOf(ws);
  const records = await tape.step(100);
  const end = records.at(-1).t;
  const total = tape.series(end, 1, 60).reduce((s, r) => s + r.total, 0);
  assert.equal(total, 100);
  assert.equal(tape.totals.allow + tape.totals.hold + tape.totals.block, 100);
  assert.equal(tape.latencySummary().n, 100);
  assert.ok(tape.latencySummary().p95 >= tape.latencySummary().p50);
  const flags = tape.flagsPerHour(end, 2).reduce((s, r) => s + r.hold + r.block, 0);
  assert.equal(flags, tape.totals.hold + tape.totals.block);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([], 50), null);
});

test('runner: start, pause, resume, stop and speed', async () => {
  const { ws } = await fresh();
  const tape = tapeOf(ws);
  let now = 0;
  const queue = [];
  const runner = new LiveRunner(tape, { schedule: (fn) => { queue.push(fn); return queue.length; }, cancel: () => { queue.length = 0; }, now: () => now });
  assert.equal(runner.state, 'off');
  assert.throws(() => runner.setSpeed(7), RangeError);
  runner.setSpeed(20);
  assert.ok(SPEEDS.includes(runner.speed));
  runner.start();
  now += 500;
  await queue.shift()();
  assert.ok(tape.issued >= 10, `issued ${tape.issued}`);
  runner.pause();
  assert.equal(runner.state, 'paused');
  const n = tape.issued;
  assert.equal(queue.length, 0);
  assert.equal(tape.issued, n);
  runner.stop();
  assert.equal(runner.state, 'off');
});

test('graph: direct counterparties only, listed nodes flagged, widths by value', async () => {
  const { ws } = await fresh();
  const tape = tapeOf(ws);
  await tape.step(300);
  const payments = collectPayments(ws, tape);
  assert.ok(payments.length > ws.txs.length);
  const suggestions = suggestedAddresses(payments, ws.inForce, 5);
  assert.ok(suggestions.length > 0);
  const listed = payments.find((p) => ws.inForce.byAddress.has(p.to.toLowerCase())).to;
  const g = buildGraph(payments, listed, ws.inForce);
  assert.equal(g.center.listed, true);
  assert.ok(g.nodes.length > 0);
  for (const n of g.nodes) assert.ok(payments.some((p) => (p.from === listed && p.to === n.address) || (p.to === listed && p.from === n.address)));
  assert.ok(g.nodes.every((n, i, a) => i === 0 || a[i - 1].listed >= n.listed));
  const capped = buildGraph(payments, listed, ws.inForce, 1);
  assert.equal(capped.nodes.length, 1);
  assert.equal(capped.hidden, g.totalCounterparties - 1);
  const flagged = buildGraph(payments, payments.find((p) => ws.inForce.byAddress.has(p.to.toLowerCase())).from, ws.inForce);
  assert.ok(flagged.nodes.some((n) => n.listed), 'a counterparty that is on the list is flagged');
  assert.equal(buildGraph(payments, '0xnobody', ws.inForce).nodes.length, 0);
  assert.ok(edgeWidth(100, 100) > edgeWidth(1, 100));
  // layoutGraph now returns the fitted canvas size with the positions, so the height follows the content.
  assert.equal(layoutGraph(g, 600).pos.length, g.nodes.length);
  assert.deepEqual(buildGraph(payments, listed, ws.inForce), g);
});

test('bulk: assign and start review apply; propose clearance still needs a second person', async () => {
  const { ws } = await fresh();
  const run = async (op) => { try { return { ok: true, result: await ws.apply(op) }; } catch (e) { if (e instanceof WorkspaceError) return { ok: false, error: e }; throw e; } };
  const holds = ws.alerts.filter((a) => a.kind === 'hold' && a.status === 'open' && !a.pending).slice(0, 3);
  assert.ok(holds.length >= 2);
  const ids = holds.map((a) => a.id);
  const ts = '2026-11-06T11:00:00.000Z';
  const assigned = await applyBulk(ws, run, { actor: 'analyst-a', action: 'assign', alertIds: ids, assignee: 'analyst-b', ts });
  assert.deepEqual(assigned.done, ids);
  assert.ok(holds.every((a) => a.assignee === 'analyst-b'));
  const started = await applyBulk(ws, run, { actor: 'analyst-a', action: 'start_review', alertIds: ids, ts });
  assert.equal(started.done.length, ids.length);
  assert.ok(holds.every((a) => a.status === 'in_review'));
  const short = await applyBulk(ws, run, { actor: 'analyst-a', action: 'propose_clear', alertIds: ids, note: 'short', ts });
  assert.equal(short.done.length, 0, 'a note under the minimum is refused for every row');
  assert.equal(short.blocked.length, ids.length);
  const note = 'Reviewed each payment record against the expected range.';
  const proposed = await applyBulk(ws, run, { actor: 'analyst-a', action: 'propose_clear', alertIds: ids, note, ts });
  assert.deepEqual(proposed.done, ids);
  assert.ok(holds.every((a) => a.status === 'in_review' && a.pending?.by === 'analyst-a'), 'proposed, not cleared');
  const self = await run({ op: 'alertAction', actor: 'analyst-a', alertId: ids[0], action: 'approve_clear', ts });
  assert.equal(self.ok, false);
  assert.equal(self.error.code, 'forbidden', 'an analyst cannot approve at all');
  const extra = ws.alerts.find((a) => a.kind === 'hold' && a.status === 'open' && !a.pending);
  await applyBulk(ws, run, { actor: 'approver-c', action: 'start_review', alertIds: [extra.id], ts });
  const mine = await applyBulk(ws, run, { actor: 'approver-c', action: 'propose_clear', alertIds: [extra.id], note, ts });
  assert.deepEqual(mine.done, [extra.id]);
  const own = await run({ op: 'alertAction', actor: 'approver-c', alertId: extra.id, action: 'approve_clear', ts });
  assert.equal(own.error.code, 'four_eyes', 'an approver cannot approve what they proposed');
  assert.equal((await run({ op: 'alertAction', actor: 'admin-d', alertId: extra.id, action: 'approve_clear', ts })).ok, true);
  const plan = planBulk(ws, 'analyst-a', ids, 'propose_clear');
  assert.equal(plan.allowed.length, 0, 'already pending');
  const approved = await run({ op: 'alertAction', actor: 'approver-c', alertId: ids[0], action: 'approve_clear', ts });
  assert.equal(approved.ok, true);
  assert.equal(ws.alertById.get(ids[0]).status, 'cleared');
  await assert.rejects(applyBulk(ws, run, { actor: 'analyst-a', action: 'confirm', alertIds: ids }), RangeError);
  assert.equal((await ws.ledger.verifyAll()).ok, true);
});

test('bulk: roles that lack a permission are blocked per row with the engine reason', async () => {
  const { ws } = await fresh();
  const open = ws.alerts.filter((a) => a.status === 'open').slice(0, 2).map((a) => a.id);
  const plan = planBulk(ws, 'nobody', open, 'assign');
  assert.equal(plan.allowed.length, 0);
  assert.equal(plan.blocked[0].reason, 'Unknown user.');
  assert.equal(planBulk(ws, 'analyst-a', ['AL-9999'], 'assign').blocked.length, 1);
});

test('graph: default is the busiest address, two hops add real edges only, cap and layout hold', async () => {
  const { ws } = await fresh();
  const tape = tapeOf(ws);
  const payments = collectPayments(ws, tape);
  assert.ok(payments.some((p) => p.source === 'background'), 'synthetic background payments exist');
  assert.deepEqual(collectPayments(ws, tapeOf(ws)).map((p) => p.id), payments.map((p) => p.id), 'deterministic');
  const busiest = busiestAddress(payments);
  const one = buildGraph(payments, busiest, ws.inForce, GRAPH_MAX_NODES, 1);
  const two = buildGraph(payments, busiest, ws.inForce, GRAPH_MAX_NODES, 2);
  assert.ok(one.nodes.length >= 10, `busiest has ${one.nodes.length} counterparties`);
  assert.ok(two.nodes.length > one.nodes.length);
  assert.ok(two.nodes.length <= GRAPH_MAX_NODES);
  assert.equal(two.nodes.filter((n) => n.hop === 1).length <= Math.ceil(GRAPH_MAX_NODES * 0.45), true);
  const count = (a) => new Set(payments.filter((p) => p.from.toLowerCase() === a.toLowerCase() || p.to.toLowerCase() === a.toLowerCase()).flatMap((p) => [p.from.toLowerCase(), p.to.toLowerCase()])).size - 1;
  assert.ok(suggestedAddresses(payments, ws.inForce, 5).every((s) => count(busiest) >= s.counterparties));
  const real = new Set(payments.map((p) => `${p.from.toLowerCase()}>${p.to.toLowerCase()}`));
  for (const e of two.edges) assert.ok(real.has(`${e.from.toLowerCase()}>${e.to.toLowerCase()}`), 'every edge is a demo payment');
  for (const n of two.nodes.filter((x) => x.hop === 2)) assert.ok(two.nodes.some((m) => m.hop === 1 && m.address === n.parent));
  assert.ok(two.hidden >= 0 && two.totalCounterparties === two.nodes.length + two.hidden);
  const lay = layoutGraph(two, 900);
  assert.equal(lay.pos.length, two.nodes.length);
  assert.ok(lay.pos.every((p) => p.x >= 0 && p.x <= 900 && p.y >= 0 && p.y <= lay.height));
  assert.ok(layoutGraph(buildGraph(payments, busiest, ws.inForce, 3, 1), 900).height <= 320, 'a small graph gets a small canvas');
  const profile = addressProfile(payments, busiest, ws.inForce);
  assert.equal(profile.counterparties, count(busiest));
  assert.ok(profile.first <= profile.last && profile.paymentsIn + profile.paymentsOut > 0);
});

test('graph: listed addresses seen in the history get several counterparties', async () => {
  const { ws } = await fresh();
  const payments = collectPayments(ws, tapeOf(ws));
  const listed = [...new Set(ws.txs.map((t) => t.address))].filter((a) => ws.inForce.byAddress.has(a.toLowerCase()));
  assert.ok(listed.length > 0);
  for (const a of listed) assert.ok(addressProfile(payments, a, ws.inForce).counterparties >= 4, a);
});

test('graph: funds-flow model puts money in on the left and money out on the right, top 8 per column', async () => {
  const { ws } = await fresh();
  const payments = collectPayments(ws, tapeOf(ws));
  const busiest = busiestAddress(payments);
  for (const hops of [1, 2]) {
    const g = buildGraph(payments, busiest, ws.inForce, GRAPH_MAX_NODES, hops);
    const m = flowModel(g);
    const ids = new Set(m.nodes.map((n) => n.id));
    for (const l of m.links) assert.ok(ids.has(l.source) && ids.has(l.target), `link ${l.source} > ${l.target} has both ends`);
    for (const col of ['L1', 'R1', 'L2', 'R2']) {
      const shown = m.nodes.filter((n) => n.col === col && !n.more);
      assert.ok(shown.length <= FLOW_TOP, `${col} shows at most ${FLOW_TOP}`);
      const usd = shown.map((n) => n.usd);
      const listedFirst = shown.filter((n) => !n.listed);
      assert.deepEqual(listedFirst.map((n) => n.usd), listedFirst.map((n) => n.usd).sort((a, b) => b - a), `${col} sorted by USD`);
      void usd;
    }
    // Every dollar paid to the centre is on a left link, every dollar it paid is on a right link.
    const paidIn = g.nodes.filter((n) => n.hop === 1).reduce((s, n) => s + n.sentUsd, 0);
    const paidOut = g.nodes.filter((n) => n.hop === 1).reduce((s, n) => s + n.receivedUsd, 0);
    assert.equal(m.links.filter((l) => l.target === 'C').reduce((s, l) => s + l.usd, 0), paidIn);
    assert.equal(m.links.filter((l) => l.source === 'C').reduce((s, l) => s + l.usd, 0), paidOut);
    assert.ok(m.links.filter((l) => l.target === 'C').every((l) => l.source.startsWith('L1')), 'only the left column pays the centre');
    const listed = g.nodes.filter((n) => n.hop === 1 && n.listed && n.sentUsd > 0).length;
    assert.ok(m.nodes.filter((n) => n.col === 'L1' && n.listed).length >= Math.min(listed, FLOW_TOP), 'listed senders are never folded away');
    const all = flowModel(g, { expanded: { L1: true, R1: true, L2: true, R2: true } });
    assert.ok(all.nodes.every((n) => !n.more), 'expanding shows every address');
  }
  const g1 = buildGraph(payments, busiest, ws.inForce, GRAPH_MAX_NODES, 1);
  const folded = flowModel(g1).nodes.find((n) => n.id === 'L1:more');
  if (g1.nodes.filter((n) => n.sentUsd > 0).length > FLOW_TOP) assert.ok(folded && folded.more.n === g1.nodes.filter((n) => n.sentUsd > 0).length - FLOW_TOP, 'the rest fold into one +N more node');
});
