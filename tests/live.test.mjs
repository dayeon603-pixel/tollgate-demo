// Live stream, counterparty graph, command palette, triage and time/cost logic. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWorkspace } from '../js/ws/session.js';
import { buildPack, verifyPack } from '../js/ws/evidence.js';
import { LiveTape, LiveRunner, makeEvent, mixSeed, percentile, SPEEDS } from '../js/ws/stream.js';
import { buildGraph, collectPayments, edgeWidth, layoutGraph, suggestedAddresses } from '../js/ws/graph.js';
import { buildCommands, rankCommands } from '../js/ws/palette.js';
import { applyBulk, caseSummary, cleanTargets, DEFAULT_SLA_HOURS, planBulk, slaLabel, slaState, upsertView } from '../js/ws/triage.js';
import { estimate, readNumber, ESTIMATE_NOTE } from '../js/ws/timecost.js';
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
  assert.equal(layoutGraph(g, 600, 400).length, g.nodes.length);
  assert.deepEqual(buildGraph(payments, listed, ws.inForce), g);
});

test('palette: ranks prefix over substring, requires every word, handles empty and no match', () => {
  const items = buildCommands({
    routes: { dashboard: 'Dashboard', alerts: 'Alerts', live: 'Live' }, alerts: [{ id: 'AL-0007', kind: 'hold', status: 'open', address: '0xabc' }],
    addresses: [{ address: '0xabc123', note: 'demo' }], actions: [{ id: 'theme', title: 'Switch theme', keywords: 'dark light' }],
  });
  assert.equal(rankCommands(items, 'alerts')[0].id, 'view:alerts');
  assert.equal(rankCommands(items, 'al-0007')[0].id, 'alert:AL-0007');
  assert.equal(rankCommands(items, '0xabc123')[0].kind, 'address');
  assert.equal(rankCommands(items, 'dark')[0].id, 'action:theme');
  assert.equal(rankCommands(items, 'zzzz').length, 0);
  assert.equal(rankCommands(items, 'go live')[0].id, 'view:live');
  assert.ok(rankCommands(items, '').every((i) => ['view', 'action'].includes(i.kind)));
  assert.equal(rankCommands(items, '', 2).length, 2);
});

test('sla: states and labels follow the target', async () => {
  const hit = { kind: 'hit', createdAt: '2026-11-06T00:00:00.000Z', status: 'open' };
  const at = (h) => Date.parse(hit.createdAt) + h * 3_600_000;
  assert.equal(slaState(hit, at(1)).state, 'ok');
  assert.equal(slaState(hit, at(3.5)).state, 'due_soon');
  assert.equal(slaState(hit, at(5)).state, 'overdue');
  assert.equal(slaLabel(slaState(hit, at(5))), '1h over');
  assert.equal(slaState({ ...hit, status: 'cleared' }, at(99)).state, 'closed');
  assert.equal(slaState(hit, at(5), { hit: 10 }).state, 'ok');
  assert.deepEqual(cleanTargets({ hit: 'abc', hold: 2 }), { ...DEFAULT_SLA_HOURS, hold: 2 });
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

test('case summary: only facts from the ledger', async () => {
  const { ws } = await fresh();
  const hit = ws.alerts.find((a) => a.kind === 'hit');
  const lines = caseSummary(ws, hit);
  const text = lines.join('\n');
  assert.match(text, /List: List v\d/);
  assert.match(text, /exact address match/);
  assert.ok(text.includes(hit.entries[0].uid));
  const hold = ws.alerts.find((a) => a.kind === 'hold');
  assert.match(caseSummary(ws, hold).join('\n'), /Held by policy/);
});

test('saved views: validated, replaced by name, capped', () => {
  let views = upsertView([], { name: ' Mine ', filters: { status: 'work', assignee: 'me' } });
  assert.equal(views[0].name, 'Mine');
  assert.equal(views[0].filters.kind, 'all');
  views = upsertView(views, { name: 'Mine', filters: { status: 'pending' } });
  assert.equal(views.length, 1);
  assert.equal(views[0].filters.status, 'pending');
  assert.equal(upsertView(views, { name: '', filters: {} }).length, 1);
  assert.equal(upsertView(views, { name: 'x' }).length, 1);
  for (let i = 0; i < 30; i++) views = upsertView(views, { name: `v${i}`, filters: {} });
  assert.equal(views.length, 12);
});

test('estimate: formula from the visitor inputs only', () => {
  assert.equal(estimate({}).ready, false);
  assert.equal(estimate({}).missing.length, 5);
  const e = estimate({ alertsPerMonth: 100, minutesNow: 30, auditsPerYear: 2, hoursNow: 40, hourlyCost: 50 });
  assert.equal(e.ready, true);
  assert.equal(e.now.alertHours, 600);
  assert.equal(e.now.auditHours, 80);
  assert.equal(e.now.hours, 680);
  assert.equal(e.now.cost, 34_000);
  assert.equal(e.with, null);
  assert.equal(e.difference, null);
  assert.equal(e.note, ESTIMATE_NOTE);
  const w = estimate({ analysts: 4, alertsPerMonth: '100', minutesNow: '30', minutesWith: '10', auditsPerYear: '2', hoursNow: '40', hoursWith: '10', hourlyCost: '1,000' });
  assert.equal(w.with.hours, 200 + 20);
  assert.equal(w.difference.hours, 680 - 220);
  assert.equal(w.difference.cost, 460_000);
  assert.equal(w.now.perAnalystHours, 170);
  assert.equal(estimate({ alertsPerMonth: 'abc', minutesNow: 1, auditsPerYear: 1, hoursNow: 1, hourlyCost: 1 }).ready, false);
  assert.equal(estimate({ alertsPerMonth: -5, minutesNow: 1, auditsPerYear: 1, hoursNow: 1, hourlyCost: 1 }).ready, false);
  assert.equal(readNumber(''), null);
  assert.equal(readNumber('0'), 0);
  assert.equal(estimate({ alertsPerMonth: 0, minutesNow: 0, auditsPerYear: 0, hoursNow: 0, hourlyCost: 0 }).now.cost, 0);
});
