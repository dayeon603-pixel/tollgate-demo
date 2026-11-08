/**
 * Glue between the demo members (network.js), the workspace engine and the views: creating and
 * restoring the demo members' keys, receiving an inbound payment with a receipt, running a transfer
 * through the gate, and planning the seeded network history. Everything about members and payments
 * here is synthetic; the keys, signatures and checks are real.
 */
import { WorkspaceError } from './engine.js';
import { matchIn } from './lists.js';
import { cloneShare, DemoMember, FRESHNESS_MS, generateInstitution, restoreInstitution, verifyShare } from './network.js';
import { sha256Hex } from '../workbench.js';
import { between, DAY_MS, fakeEthAddress, fakeTronAddress, HOUR_MS, pick } from './util.js';

export const NET_KEYS_STORAGE = 'tollgate-demo-network-keys-v1';
export const MEMBER_NAMES = ['Demo Exchange A', 'Demo Exchange B', 'Demo Exchange C', 'Demo Exchange D'];
export const OUTSIDER_NAME = 'Demo Exchange X (not in your registry)';
export const MAX_REMEMBERED_SHARES = 60;
const MAX_MEMBERS = 12;
const OLD_RECEIPT_MS = 30 * HOUR_MS;

/** Scenarios the Network view offers, in menu order. */
export const SCENARIOS = [
  { id: 'valid', label: 'Valid, current receipt' },
  { id: 'none', label: 'No receipt' },
  { id: 'tampered', label: 'Receipt edited after signing' },
  { id: 'stale', label: 'Receipt made on an older list' },
  { id: 'unknown', label: 'Receipt from a key not in the registry' },
  { id: 'listed', label: 'Receipt says clear, address is on our list' },
  { id: 'old', label: 'Receipt older than 24 hours' },
  { id: 'reuse', label: 'Same receipt presented a second time' },
];

/**
 * The demo members of one session: their keys and chains, the one sender that is never registered,
 * and the last shares made (kept in memory so a share can be presented twice).
 */
export class DemoNetwork {
  constructor() {
    this.members = [];
    this.outsider = null;
    this.shares = new Map();
    this.lastAccepted = null;
    /** Private keys as stored, by public key, so a member added later survives a reload. */
    this.keyRecords = new Map();
  }

  /** Forgets the members' chains and shares, so a rebuilt workspace seeds the same history again. */
  reset() {
    for (const m of [...this.members, this.outsider]) if (m) m.chain = [];
    this.shares.clear();
    this.lastAccepted = null;
  }

  /** Makes a member with a fresh Ed25519 key and returns it. Raises RangeError at the member limit. */
  async addMember(name) {
    if (this.members.length >= MAX_MEMBERS) throw new RangeError(`The demo holds at most ${MAX_MEMBERS} members.`);
    const inst = await generateInstitution(name);
    const member = new DemoMember(inst);
    this.members.push(member);
    this.keyRecords.set(inst.keyId, { name: inst.name, keyId: inst.keyId, jwk: inst.jwk });
    return member;
  }

  /** The value to keep in browser storage. */
  serial() {
    return { schema: 1, members: this.members.map((m) => this.keyRecords.get(m.keyId)), outsider: this.keyRecords.get(this.outsider.keyId) };
  }

  remember(share) {
    this.shares.set(share.share_id, share);
    while (this.shares.size > MAX_REMEMBERED_SHARES) this.shares.delete(this.shares.keys().next().value);
  }
}

/**
 * Loads the members' keys from storage or makes new ones.
 *
 * Args: stored, the parsed storage value or null. Keys are real Ed25519 keys made in this browser; the
 *   private halves are kept in this browser's storage only, because they belong to made-up members.
 * Returns: { network, serial } where serial is the value to store.
 */
export async function loadDemoNetwork(stored) {
  const network = new DemoNetwork();
  const names = [...MEMBER_NAMES, 'Demo Exchange C (key 2)'];
  const usable = Boolean(stored && Array.isArray(stored.members) && stored.members.length >= names.length && stored.outsider);
  const take = async (record, name) => {
    if (usable && record) {
      try { return await restoreInstitution(record); } catch { /* an unusable stored key is replaced below */ }
    }
    return generateInstitution(name);
  };
  const keep = (inst) => network.keyRecords.set(inst.keyId, { name: inst.name, keyId: inst.keyId, jwk: inst.jwk });
  for (let i = 0; i < names.length; i++) {
    const inst = await take(usable ? stored.members[i] : null, names[i]);
    network.members.push(new DemoMember(inst));
    keep(inst);
  }
  const out = await take(usable ? stored.outsider : null, OUTSIDER_NAME);
  network.outsider = new DemoMember(out);
  keep(out);
  // Members the visitor added in an earlier visit.
  if (usable) {
    for (const record of stored.members.slice(names.length)) {
      try {
        const inst = await restoreInstitution(record);
        network.members.push(new DemoMember(inst));
        keep(inst);
      } catch { /* skip an unusable stored key */ }
    }
  }
  return { network, serial: network.serial() };
}

/** Member by public key among the registered members and the outsider. */
export function senderByKey(network, keyId) {
  return network.members.find((m) => m.keyId === keyId) ?? (network.outsider.keyId === keyId ? network.outsider : null);
}

const dayStamp = (ts) => new Date(ts).toISOString();

/** Builds the environment verifyShare reads from the workspace state. */
export function shareEnv(ws, { now, want }) {
  const inForce = ws.inForce;
  return {
    now, registry: ws.registry(), listDigest: inForce.digest, inForceOrdinal: inForce.ordinal,
    versions: ws.versions.map((v) => ({ id: v.id, label: v.label, digest: v.digest, ordinal: v.ordinal })),
    ownListHas: (address) => matchIn(inForce, address).length > 0, used: new Set(ws.net.used.keys()), want, freshnessMs: FRESHNESS_MS,
  };
}

async function digestForScenario(ws, kind) {
  const inForce = ws.inForce;
  if (kind !== 'stale') return { digest: inForce.digest, label: inForce.label };
  const older = ws.versions.filter((v) => v.ordinal < inForce.ordinal).at(-1);
  if (older) return { digest: older.digest, label: older.label };
  return { digest: await sha256Hex('a list this workspace never held'), label: 'List (not held)' };
}

/**
 * Receives one inbound payment, with or without a sender's receipt, and records what happened.
 * An accepted receipt skips the second screening. Anything else is screened here, and the screening
 * is linked to the record.
 *
 * Args: ws, network; spec { actor, senderKeyId, kind (a SCENARIOS id), address, chain, counterparty, amountUsd, ts (ISO) }.
 * Returns: { result, record, screen } where result is verifyShare's answer (or a synthetic one for no receipt).
 * Raises: WorkspaceError, or RangeError when the scenario cannot be built (for example "again" with nothing to repeat).
 */
export async function receiveInbound(ws, network, spec) {
  const { actor, kind, address, chain, counterparty = null, amountUsd, ts } = spec;
  const when = new Date(ts);
  const sender = kind === 'unknown' ? network.outsider : senderByKey(network, spec.senderKeyId);
  if (kind !== 'none' && kind !== 'reuse' && !sender) throw new RangeError('Pick a sending member.');
  let share = null;
  if (kind === 'reuse') {
    share = network.lastAccepted && network.shares.get(network.lastAccepted);
    if (!share) throw new RangeError('Nothing to present again yet. Receive a valid receipt first.');
  } else if (kind !== 'none') {
    const { digest, label } = await digestForScenario(ws, kind);
    const made = new Date(when.getTime() - (kind === 'old' ? OLD_RECEIPT_MS : 60_000));
    share = await sender.makeShare({ address, chain, counterparty, amountUsd, outcome: 'ALLOW', listDigest: digest, listLabel: label, ts: made });
    if (kind === 'tampered') {
      share = cloneShare(share);
      share.bundle.receipts[0].action.params.amount_usd = (amountUsd ?? 0) + 1;
    }
    network.remember(share);
  }
  const want = kind === 'reuse' ? { address: share.bundle.receipts[0].action.params.beneficiary_address, chain: share.bundle.receipts[0].action.params.chain } : { address, chain, counterparty };
  const result = share ? await verifyShare(share, shareEnv(ws, { now: when, want })) : { accepted: false, reasons: [{ code: 'no_receipt', label: 'No receipt', text: 'The sender sent no receipt, so the payment is screened here.' }], headline: null, facts: null };
  const facts = result.facts ?? {};
  const outcome = !share ? 'NONE' : result.accepted ? 'ACCEPTED' : 'REFUSED';
  const run = await ws.apply({
    op: 'netReliance', ts, actor, outcome, reasons: result.reasons.map(({ code, label, text }) => ({ code, label, text })), shareId: facts.shareId ?? null, keyId: facts.keyId ?? null,
    issuerName: facts.issuerName ?? sender?.name ?? null, receiptId: facts.receiptId ?? null, receiptHash: facts.receiptHash ?? null, address: facts.address ?? address, chain: facts.chain ?? chain,
    counterparty: facts.counterparty ?? counterparty, amountUsd: facts.amountUsd ?? amountUsd, decidedAt: facts.decidedAt ?? null, listDigest: facts.listDigest ?? null,
  });
  let screen = null;
  if (outcome === 'ACCEPTED') network.lastAccepted = facts.shareId;
  else screen = await ws.apply({ op: 'screen', ts, actor, source: 'inbound_rescreen', address: facts.address ?? address, amount: amountUsd ?? null, originator: true, relianceId: run.record.id });
  return { result, record: run.record, screen };
}

/** Pins and registers what the seed or the visitor asks for, through the engine so each step is receipted. */
export async function registerMember(ws, member, { actor, ts, pin = true }) {
  await ws.apply({ op: 'netTrust', ts, actor, action: 'register', keyId: member.keyId, name: member.name });
  if (pin) await ws.apply({ op: 'netTrust', ts: new Date(Date.parse(ts) + 1000).toISOString(), actor, action: 'pin', keyId: member.keyId });
}

/** Presents one of the workspace's own receipts or an accepted inbound receipt to the gate. */
export async function runGate(ws, { actor, ts, transferId, address, amountUsd, ref, source = 'manual' }) {
  return ws.apply({ op: 'gateCheck', ts, actor, transferId, address, amountUsd, ref, source });
}

// ---- seeded history ------------------------------------------------------------------------

/** Days on which the first inbound payment is a fixed scenario, so every refusal reason appears in the history. */
const FORCED_KINDS = { 8: 'old', 11: 'unknown', 14: 'tampered', 21: 'stale', 25: 'stale', 27: 'reuse' };
const SEED_KINDS = [['valid', 0.58], ['none', 0.14], ['tampered', 0.06], ['stale', 0.07], ['unknown', 0.07], ['listed', 0.03], ['old', 0.03], ['reuse', 0.02]];

function kindFor(rand) {
  let r = rand();
  for (const [kind, weight] of SEED_KINDS) { if (r < weight) return kind; r -= weight; }
  return 'valid';
}

/**
 * Queue items for the seeded network history: the registry growing, one key rotation, about fifty
 * inbound payments and a gate decision for a share of the payments the workspace screened.
 * Each item is { ts, run(ws) }; seedWorkspace applies them in time order with the rest.
 *
 * Args: network; rand, the seed generator; at(day, hours) -> ISO time; days; end (ms); users.
 */
export function planNetworkSeed(network, { rand, at, days, end, users, listed, counterparties }) {
  const items = [];
  const [a, b, c, d, c2] = network.members;
  const dayOfD = 6;
  const dayOfRotation = Math.round(days * 0.74);
  const push = (ts, run) => { if (Date.parse(ts) <= end) items.push({ ts, run, op: 'seedNetwork' }); };
  for (const [member, day, hour] of [[a, 0, 3], [b, 0, 4], [c, 1, 3]]) push(at(day, hour), (ws) => registerMember(ws, member, { actor: users.d, ts: at(day, hour) }));
  push(at(dayOfD, 5), (ws) => registerMember(ws, d, { actor: users.d, ts: at(dayOfD, 5) }));
  push(at(dayOfRotation, 10), async (ws) => {
    await ws.apply({ op: 'netTrust', ts: at(dayOfRotation, 10), actor: users.d, action: 'revoke', keyId: c.keyId, reason: 'Demo: the member rotated its key after a simulated laptop loss.' });
    await registerMember(ws, c2, { actor: users.d, ts: at(dayOfRotation, 10.1) });
  });
  const active = (day) => [a, b, c, d, c2].filter((m) => {
    if (m === d) return day > dayOfD;
    if (m === c) return day >= 1;
    if (m === c2) return day > dayOfRotation;
    return true;
  });
  for (let day = 1; day <= days; day++) {
    const count = [0, 6].includes(new Date(Date.parse(at(day, 0))).getUTCDay()) ? between(rand, 0, 1) : between(rand, 1, 3);
    for (let i = 0; i < count; i++) {
      const ts = at(day, 7 + rand() * 12);
      let kind = kindFor(rand);
      if (i === 0 && FORCED_KINDS[day]) kind = FORCED_KINDS[day];
      let sender = pick(rand, active(day).filter((m) => m !== c || day <= dayOfRotation));
      if (day > dayOfRotation && day <= dayOfRotation + 3 && rand() < 0.5) { sender = c; kind = 'valid'; }
      const tron = rand() < 0.3;
      const address = kind === 'listed' ? pick(rand, listed) : pick(rand, counterparties.filter((x) => (x.startsWith('T') === tron)).concat(tron ? [fakeTronAddress(rand)] : [fakeEthAddress(rand)]));
      const amountUsd = between(rand, 300, 40_000);
      const actor = rand() < 0.5 ? users.a : users.b;
      push(ts, async (ws) => {
        try {
          const done = await receiveInbound(ws, network, { actor, senderKeyId: sender.keyId, kind, address, chain: tron ? 'tron' : 'ethereum', counterparty: null, amountUsd, ts });
          return { created: done.screen?.created ?? [] };
        } catch (error) {
          if (!(error instanceof RangeError) && !(error instanceof WorkspaceError)) throw error;
          return { created: [] };
        }
      });
    }
  }
  return items;
}

/** Plans gate checks over the seeded history. Each picks from what the workspace holds at the time it runs. */
export function planGateSeed({ rand, at, days, end, users }) {
  const items = [];
  for (let day = 2; day <= days; day++) {
    const count = between(rand, 0, 3);
    for (let i = 0; i < count; i++) {
      const ts = at(day, 8 + rand() * 11);
      if (Date.parse(ts) > end) continue;
      const pickKind = rand();
      const pickIndex = rand();
      items.push({ ts, op: 'seedGate', run: async (ws) => {
        const now = Date.parse(ts);
        const screens = ws.txs.filter((t) => Date.parse(t.ts) <= now);
        const recent = screens.filter((t) => now - Date.parse(t.ts) < 20 * HOUR_MS);
        const everAccepted = ws.net.reliances.filter((r) => r.outcome === 'ACCEPTED' && Date.parse(r.ts) <= now);
        const freshAccepted = everAccepted.filter((r) => now - Date.parse(r.ts) < 20 * HOUR_MS);
        const accepted = freshAccepted.length ? freshAccepted : everAccepted;
        let ref = null;
        let tx = null;
        if (pickKind < 0.62 && recent.length) { tx = recent.filter((t) => t.outcome === 'ALLOW')[Math.floor(pickIndex * recent.filter((t) => t.outcome === 'ALLOW').length)] ?? null; }
        else if (pickKind < 0.7 && recent.length) { tx = recent.filter((t) => t.outcome !== 'ALLOW')[Math.floor(pickIndex * recent.filter((t) => t.outcome !== 'ALLOW').length)] ?? null; }
        else if (pickKind < 0.8 && screens.length) { tx = screens[Math.floor(pickIndex * screens.length)]; }
        else if (pickKind < 0.9 && accepted.length) {
          const rel = accepted[Math.floor(pickIndex * accepted.length)];
          await runGate(ws, { actor: users.a, ts, transferId: `XFER-${ts.slice(5, 16)}`, address: rel.address, amountUsd: rel.amountUsd, ref: { kind: 'shared', id: rel.id }, source: 'seed' });
          return;
        }
        if (tx) ref = { kind: 'ledger', id: tx.receiptId };
        const address = tx?.address ?? fakeEthAddress(rand);
        await runGate(ws, { actor: users.a, ts, transferId: `XFER-${ts.slice(5, 16)}`, address, amountUsd: tx?.amountUsd ?? between(rand, 100, 9000), ref, source: 'seed' });
      } });
    }
  }
  return items;
}

export { DAY_MS, dayStamp };

// ---- gate presets ----------------------------------------------------------------------------

/** Transfers the gate card can try. Each one is built from what the workspace holds right now. */
export const GATE_PRESETS = [
  { id: 'screened', label: 'Screen it, then release', hint: 'Screens a clean address now and presents its fresh receipt.' },
  { id: 'none', label: 'Send with no receipt', hint: 'A transfer that skipped screening.' },
  { id: 'hit', label: 'Present a receipt that is a list hit', hint: 'Screens a listed address now and presents the receipt it gets.' },
  { id: 'stale', label: 'Present a receipt from an older list', hint: 'An earlier clear made on a list version that is no longer in force.' },
  { id: 'old', label: 'Present a receipt older than 24 hours', hint: 'A clear made on the current list, but more than 24 hours ago.' },
  { id: 'shared', label: 'Present an accepted inbound receipt', hint: "A sender's receipt you relied on, if it is still current." },
];

/**
 * Runs one gate preset.
 *
 * Args: ws; preset id; opts { actor, now (Date) }.
 * Returns: { record, note } where record is the gate decision, or { unavailable } with a plain reason when the
 *   workspace holds nothing to present.
 */
export async function runGatePreset(ws, id, { actor, now }) {
  const ts = now.toISOString();
  const transferId = `XFER-${now.getTime().toString(36).toUpperCase()}`;
  const old = (tx) => now.getTime() - Date.parse(tx.ts);
  let address; let amountUsd = 500; let ref = null;
  if (id === 'screened' || id === 'hit') {
    address = id === 'hit' ? [...ws.inForce.byAddress.values()].map((e) => e[0]).find((e) => !e.synthetic && /^0x[0-9a-f]{40}$/i.test(e.address))?.address : `0x${(await sha256Hex(`gate|${transferId}`)).slice(0, 40)}`;
    const screen = await ws.apply({ op: 'screen', ts, actor, source: 'gate_demo', address, amount: amountUsd, originator: true });
    ref = { kind: 'ledger', id: screen.tx.receiptId };
  } else if (id === 'stale' || id === 'old') {
    const pool = ws.txs.filter((t) => t.outcome === 'ALLOW');
    const tx = id === 'stale' ? pool.filter((t) => t.versionId !== ws.inForceId).at(-1) : pool.filter((t) => t.versionId === ws.inForceId && old(t) > FRESHNESS_MS).at(-1);
    if (!tx) return { unavailable: id === 'stale' ? 'No clear was made on an earlier list version in this workspace.' : 'No clear on the current list is older than 24 hours yet.' };
    address = tx.address; amountUsd = tx.amountUsd ?? 500; ref = { kind: 'ledger', id: tx.receiptId };
  } else if (id === 'shared') {
    const rel = ws.net.reliances.filter((r) => r.outcome === 'ACCEPTED').at(-1);
    if (!rel) return { unavailable: 'No inbound receipt has been accepted yet. Receive a valid one first.' };
    address = rel.address; amountUsd = rel.amountUsd ?? 500; ref = { kind: 'shared', id: rel.id };
  } else {
    address = `0x${(await sha256Hex(`gate-none|${transferId}`)).slice(0, 40)}`;
  }
  const out = await runGate(ws, { actor, ts, transferId, address, amountUsd, ref, source: 'gate_demo' });
  return { record: out.record };
}
