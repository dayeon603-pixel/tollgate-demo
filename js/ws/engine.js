/**
 * The analyst workspace state machine. Every change is an "op" (a plain object with a timestamp)
 * applied through Workspace.apply, which checks permissions, updates state, and records the event
 * as a signed receipt in the ledger. State is rebuilt from the op log, so saving the ops is enough
 * to restore a session: signatures are deterministic, so a replay produces the same receipts.
 *
 * Screening is an exact address match against the list version in force, ignoring case. There is
 * no name matching and no fuzzy matching.
 */
import { MAX_ADDRESS_LENGTH, MAX_AMOUNT_USD, readAddress, readAmount, sha256Hex } from '../workbench.js';
import { diffVersions, matchIn } from './lists.js';
import { Ledger } from './ledger.js';
import { checkReceipt, listSnapshotOf } from './receipt-check.js';
import { evaluateGate } from './gate.js';

export const ROLES = ['analyst', 'approver', 'admin', 'examiner'];
/** Roles that work cases. The examiner is read-only and sits outside the analyst ladder. */
export const WORKING_ROLES = ['analyst', 'approver', 'admin'];
export const STATUSES = ['open', 'in_review', 'escalated', 'cleared', 'confirmed'];
export const FINAL_STATUSES = ['cleared', 'confirmed'];
export const MIN_NOTE_CHARS = 10;
export const MAX_NOTE_CHARS = 500;
export const MAX_LABEL_CHARS = 60;
export const MAX_THRESHOLD_USD = 1_000_000_000;

export const DEFAULT_USERS = [
  { id: 'analyst-a', name: 'Analyst A', role: 'analyst' },
  { id: 'analyst-b', name: 'Analyst B', role: 'analyst' },
  { id: 'approver-c', name: 'Approver C', role: 'approver' },
  { id: 'admin-d', name: 'Admin D', role: 'admin' },
  { id: 'examiner-e', name: 'Examiner E', role: 'examiner' },
];

const ANALYST_PERMISSIONS = ['screen', 'watch', 'assign', 'note', 'start_review', 'escalate', 'propose_clear', 'confirm', 'export', 'open_pack', 'network_present', 'gate_use'];
const APPROVER_PERMISSIONS = [...ANALYST_PERMISSIONS, 'approve_clear', 'reject_clear', 'reopen'];
/** What each role may do. The Policy view shows this table. */
export const PERMISSIONS = {
  analyst: ANALYST_PERMISSIONS,
  approver: APPROVER_PERMISSIONS,
  admin: [...APPROVER_PERMISSIONS, 'policy', 'roles', 'list_update', 'network_trust'],
  /** Read only: may open an evidence pack and check it, may not change or record anything. */
  examiner: ['open_pack'],
};
export const PERMISSION_LABELS = {
  screen: 'Screen addresses and batches',
  watch: 'Add and remove watchlist entries',
  assign: 'Assign alerts',
  note: 'Add notes',
  start_review: 'Start review',
  escalate: 'Escalate',
  propose_clear: 'Propose a clearance',
  confirm: 'Confirm a hit (escalated alerts: approver or admin)',
  export: 'Export evidence packs',
  approve_clear: 'Approve or reject a clearance proposed by someone else',
  reject_clear: 'Reject a proposed clearance',
  reopen: 'Reopen a closed alert',
  policy: 'Change policy settings',
  roles: 'Change user roles',
  list_update: 'Apply a list update',
  open_pack: 'Open and check evidence packs (read only)',
  network_present: 'Receive inbound payments with receipts',
  gate_use: 'Run a transfer through the payment gate',
  network_trust: 'Register, pin and revoke counterparty keys',
};

/** Policy settings an admin may change, with the check each value must pass. */
export const POLICY_KEYS = {
  'rules.blank_originator.enabled': 'boolean',
  'rules.blank_originator.thresholdUsd': 'amount',
  'rules.large_value.enabled': 'boolean',
  'rules.large_value.thresholdUsd': 'amount',
  'fourEyes.hold': 'boolean',
};

export function defaultPolicy() {
  return {
    rules: {
      blank_originator: { enabled: true, thresholdUsd: 1000 },
      large_value: { enabled: true, thresholdUsd: 25_000 },
    },
    fourEyes: { hit: true, hold: true },
    lists: { ofac_sdn: true },
  };
}

export const RULE_LABELS = {
  blank_originator: 'Originator details blank at or above the threshold',
  large_value: 'Amount at or above the large-value threshold',
};

/** An error with a stable code, so callers and tests can tell refusals apart. */
export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => {
  throw new WorkspaceError(code, message);
};

/**
 * Applies the auto-hold rules to a payment that is not on the list.
 *
 * Args: policy; payment { amountUsd (null when unknown), originator (boolean) }.
 * Returns: { id, thresholdUsd } for the first rule that holds it, or null. An unknown amount never
 *   triggers an amount rule, which the Policy view states.
 */
export function evaluatePolicy(policy, payment) {
  const { blank_originator: blank, large_value: large } = policy.rules;
  if (payment.amountUsd !== null && blank.enabled && !payment.originator && payment.amountUsd >= blank.thresholdUsd) {
    return { id: 'blank_originator', thresholdUsd: blank.thresholdUsd };
  }
  if (payment.amountUsd !== null && large.enabled && payment.amountUsd >= large.thresholdUsd) {
    return { id: 'large_value', thresholdUsd: large.thresholdUsd };
  }
  return null;
}

export const isFinal = (alert) => FINAL_STATUSES.includes(alert.status);
export const isOpenWork = (alert) => !isFinal(alert);

const pad = (n, width) => String(n).padStart(width, '0');

function cleanNote(raw, { required }) {
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (required && note.length < MIN_NOTE_CHARS) refuse('note_required', `Write a note of at least ${MIN_NOTE_CHARS} characters so the decision can be explained later.`);
  if (note.length > MAX_NOTE_CHARS) refuse('note_too_long', `Notes are limited to ${MAX_NOTE_CHARS} characters.`);
  return note;
}

export class Workspace {
  /**
   * Args: versions, the list versions oldest first (from buildVersions).
   */
  constructor({ versions }) {
    this.versions = versions;
    this.ledger = new Ledger();
    this.users = DEFAULT_USERS.map((u) => ({ ...u }));
    this.policy = defaultPolicy();
    this.inForceId = null;
    this.listHistory = [];
    this.txs = [];
    this.alerts = [];
    this.watch = [];
    this.lookbacks = [];
    this.exports = [];
    this.ops = [];
    this.seedCount = 0;
    this.counters = { tx: 0, alert: 0, lookback: 0, reliance: 0, gate: 0 };
    /** Receipt network: counterparty registry, inbound reliance log, shares already used, and gate decisions. */
    this.net = { members: [], reliances: [], used: new Map(), gates: [] };
    this.txById = new Map();
    this.alertById = new Map();
    this.#queue = Promise.resolve();
  }

  #queue;

  get inForce() {
    return this.versions.find((v) => v.id === this.inForceId) ?? null;
  }

  /** The next list version waiting to be applied, or null. */
  get pendingVersion() {
    const current = this.inForce;
    return current ? this.versions.find((v) => v.ordinal === current.ordinal + 1) ?? null : this.versions[0];
  }

  version(id) {
    return this.versions.find((v) => v.id === id);
  }

  user(id) {
    return this.users.find((u) => u.id === id) ?? null;
  }

  roleOf(id) {
    return this.user(id)?.role ?? (id === 'api' ? 'api' : 'system');
  }

  can(userId, permission) {
    const user = this.user(userId);
    return Boolean(user && PERMISSIONS[user.role].includes(permission));
  }

  /**
   * Applies one op. Ops run one at a time, because each signs a receipt that links to the one
   * before it.
   *
   * Returns: { created: alerts created, ... } specific to the op. Raises WorkspaceError when the
   * op is refused; a refused op changes nothing and is not recorded.
   */
  apply(op) {
    const run = this.#queue.then(() => this.#dispatch(op));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #dispatch(op) {
    if (!op || typeof op.ts !== 'string' || Number.isNaN(Date.parse(op.ts))) refuse('bad_op', 'The action has no valid time.');
    let result;
    switch (op.op) {
      case 'screen': result = await this.#screen(op); break;
      case 'alertAction': result = await this.#alertAction(op); break;
      case 'listUpdate': result = await this.#listUpdate(op); break;
      case 'policySet': result = await this.#policySet(op); break;
      case 'userRole': result = await this.#userRole(op); break;
      case 'watchAdd': result = await this.#watchAdd(op); break;
      case 'watchRemove': result = await this.#watchRemove(op); break;
      case 'evidenceExport': result = await this.#evidenceExport(op); break;
      case 'netTrust': result = await this.#netTrust(op); break;
      case 'netReliance': result = await this.#netReliance(op); break;
      case 'gateCheck': result = await this.#gateCheck(op); break;
      default: refuse('bad_op', `Unknown action "${op.op}".`);
    }
    this.ops.push(op);
    return result;
  }

  #requireUser(op, permission) {
    const user = this.user(op.actor);
    if (!user) refuse('unknown_user', 'That user does not exist in this demo.');
    if (!PERMISSIONS[user.role].includes(permission)) refuse('forbidden', `${user.name} (${user.role}) cannot do this. It needs the ${permission.replace('_', ' ')} permission.`);
    return user;
  }

  #sign(spec, version, op) {
    return this.ledger.append(spec, version, new Date(op.ts));
  }

  // ---- screening -------------------------------------------------------------------------

  async #screen(op) {
    const actor = op.actor === 'api' ? { id: 'api' } : this.#requireUser(op, 'screen');
    if (!this.inForce) refuse('no_list', 'No list version is in force yet.');
    const checked = readAddress(op.address);
    if (checked.error) refuse('bad_address', checked.error);
    const amountChecked = op.amount === null || op.amount === undefined ? { amount: null } : readAmount(String(op.amount));
    if (amountChecked.error) refuse('bad_amount', amountChecked.error);
    const txHashRaw = typeof op.txHash === 'string' ? op.txHash.trim() : '';
    if (txHashRaw.length > MAX_ADDRESS_LENGTH || (txHashRaw && !/^[A-Za-z0-9:._-]+$/.test(txHashRaw))) refuse('bad_tx_hash', 'The transaction hash uses unexpected characters or is too long.');
    const version = this.inForce;
    const address = checked.address;
    const amountUsd = amountChecked.amount;
    const originator = op.originator === true;
    const matches = matchIn(version, address);
    const rule = matches.length ? null : evaluatePolicy(this.policy, { amountUsd, originator });
    const outcome = matches.length ? 'BLOCK' : rule ? 'HOLD' : 'ALLOW';
    const id = `TX-${pad(this.counters.tx + 1, 5)}`;
    const txHash = txHashRaw || `0x${await sha256Hex(`${id}|${address}|${op.ts}`)}`;
    const params = {
      payment_id: id, tx_hash: txHash, outcome, beneficiary_address: address,
      originator_info_present: originator, source: op.source ?? 'manual', actor: actor.id,
    };
    if (amountUsd !== null) params.amount_usd = amountUsd;
    if (op.batchId) params.batch_id = String(op.batchId);
    if (rule) params.policy_rule = rule.id;
    const reasons = matches.length
      ? matches.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}`)
      : rule ? [`policy_rule=${rule.id}`, `threshold_usd=${rule.thresholdUsd}`] : ['clean'];
    const entry = await this.#sign({ type: 'stablecoin_payment_screen', params, decision: outcome === 'BLOCK' ? 'DENY' : outcome === 'HOLD' ? 'HOLD' : 'ALLOW', outcome, reasons }, version, op);
    this.counters.tx++;
    const tx = {
      id, ts: op.ts, address, amountUsd, originator, outcome, rule: rule?.id ?? null, entries: matches,
      versionId: version.id, receiptId: entry.receipt.receipt_id, source: op.source ?? 'manual', batchId: op.batchId ?? null,
      txHash, txHashGenerated: !txHashRaw, actor: actor.id, flagged: false, alertId: null,
    };
    this.txs.push(tx);
    this.txById.set(id, tx);
    if (op.relianceId) this.linkRescreen(op.relianceId, id);
    const created = [];
    if (outcome !== 'ALLOW') {
      const alert = this.#newAlert({
        kind: outcome === 'BLOCK' ? 'hit' : 'hold', address, txIds: [id], amountUsd: amountUsd ?? 0, entries: matches,
        rule: rule?.id ?? null, versionId: version.id, ts: op.ts, receiptId: entry.receipt.receipt_id,
      });
      tx.alertId = alert.id;
      created.push(alert);
    }
    return { tx, receipt: entry.receipt, created };
  }

  #newAlert({ kind, address, txIds, amountUsd, entries, rule, versionId, ts, receiptId }) {
    this.counters.alert++;
    const alert = {
      id: `AL-${pad(this.counters.alert, 4)}`, kind, address, txIds, amountUsd, entries: entries.map((e) => ({ ...e })),
      rule: rule ?? null, versionId, createdAt: ts, updatedAt: ts, status: 'open', assignee: null, pending: null,
      priority: kind === 'hold' ? (amountUsd >= 10_000 ? 'medium' : 'low') : 'high',
      timeline: [{ ts, actor: kind === 'hold' || kind === 'hit' ? 'api' : 'system', action: 'created', note: '', from: null, to: 'open', receiptId }],
    };
    this.alerts.push(alert);
    this.alertById.set(alert.id, alert);
    return alert;
  }

  // ---- alerts and four-eyes --------------------------------------------------------------

  /** True when clearing this alert needs a second person. Hits always do; holds follow the policy. */
  requiresFourEyes(alert) {
    return alert.kind === 'hold' ? this.policy.fourEyes.hold : true;
  }

  /**
   * What a user may do to an alert right now.
   *
   * Returns: { action: reason-or-null }, where null means allowed.
   */
  availableActions(userId, alert) {
    const out = {};
    for (const action of ALERT_ACTIONS) out[action] = this.#actionBlocker(userId, alert, action);
    return out;
  }

  #actionBlocker(userId, alert, action, input = {}) {
    const user = this.user(userId);
    if (!user) return 'Unknown user.';
    const permission = action === 'clear' ? 'propose_clear' : action;
    if (!PERMISSIONS[user.role].includes(permission)) return `Needs the ${permission.replace('_', ' ')} permission, which the ${user.role} role does not have.`;
    const final = isFinal(alert);
    const senior = user.role !== 'analyst';
    switch (action) {
      case 'note': return null;
      case 'reopen': return final ? null : 'Only a cleared or confirmed alert can be reopened.';
      default: if (final) return 'This alert is closed. Reopen it first.';
    }
    switch (action) {
      case 'assign':
        if (input.assignee && !this.user(input.assignee)) return 'Pick a user to assign.';
        return null;
      case 'start_review': return alert.status === 'open' ? null : 'Review has already started.';
      case 'escalate':
        if (alert.pending) return 'A clearance is awaiting approval. Reject it first.';
        return alert.status === 'escalated' ? 'Already escalated.' : null;
      case 'propose_clear':
        if (alert.pending) return 'A clearance is already awaiting approval.';
        if (alert.status === 'open') return 'Start review first.';
        if (alert.status === 'escalated' && !senior) return 'Escalated alerts are cleared by an approver or admin.';
        return null;
      case 'confirm':
        if (alert.pending) return 'A clearance is awaiting approval. Reject it first.';
        if (alert.status === 'open') return 'Start review first.';
        if (alert.status === 'escalated' && !senior) return 'Escalated alerts are confirmed by an approver or admin.';
        return null;
      case 'approve_clear':
      case 'reject_clear':
        if (!alert.pending) return 'No clearance is awaiting approval.';
        if (alert.pending.by === userId) return 'Four-eyes: a different user must approve or reject what you proposed.';
        return null;
      default: return 'Unknown action.';
    }
  }

  async #alertAction(op) {
    const alert = this.alertById.get(op.alertId);
    if (!alert) refuse('no_alert', 'That alert does not exist.');
    const action = op.action;
    if (!ALERT_ACTIONS.includes(action)) refuse('bad_action', 'Unknown alert action.');
    const user = this.user(op.actor);
    if (!user) refuse('unknown_user', 'That user does not exist in this demo.');
    const blocker = this.#actionBlocker(op.actor, alert, action, op);
    if (blocker) refuse(blocker.startsWith('Four-eyes') ? 'four_eyes' : blocker.startsWith('Needs the') ? 'forbidden' : 'blocked', blocker);
    const noteRequired = ['escalate', 'propose_clear', 'reject_clear', 'confirm', 'reopen'].includes(action);
    const note = cleanNote(op.note, { required: noteRequired });
    let assignee = alert.assignee;
    let to = alert.status;
    let pending = alert.pending;
    let effective = action;
    switch (action) {
      case 'assign': assignee = op.assignee ?? null; break;
      case 'start_review': to = 'in_review'; assignee = alert.assignee ?? user.id; break;
      case 'escalate': to = 'escalated'; break;
      case 'propose_clear':
        if (this.requiresFourEyes(alert)) {
          pending = { by: user.id, at: op.ts, note, fromStatus: alert.status, receiptId: null };
        } else {
          to = 'cleared';
          effective = 'clear';
        }
        break;
      case 'approve_clear': to = 'cleared'; pending = null; break;
      case 'reject_clear': to = alert.pending.fromStatus; pending = null; break;
      case 'confirm': to = 'confirmed'; break;
      case 'reopen': to = 'in_review'; break;
      default: break;
    }
    const params = {
      alert_id: alert.id, alert_kind: alert.kind, beneficiary_address: alert.address, tx_ids: alert.txIds,
      action: effective, actor: user.id, actor_role: user.role, status_from: alert.status, status_to: to,
      four_eyes: this.requiresFourEyes(alert),
    };
    if (note) params.note = note;
    if (action === 'assign') params.assignee = assignee;
    if (action === 'approve_clear' || action === 'reject_clear') {
      params.proposed_by = alert.pending.by;
      params.proposal_receipt = alert.pending.receiptId;
    }
    const version = this.inForce;
    const entry = await this.#sign({
      type: 'case_action', params, decision: 'RECORD', outcome: to.toUpperCase(),
      reasons: [`action=${effective}`, `actor=${user.id}`],
    }, version, op);
    if (action === 'propose_clear' && pending && !alert.pending) pending.receiptId = entry.receipt.receipt_id;
    alert.status = to;
    alert.assignee = assignee;
    alert.pending = pending;
    alert.updatedAt = op.ts;
    alert.timeline.push({ ts: op.ts, actor: user.id, action: effective, note, from: params.status_from, to, receiptId: entry.receipt.receipt_id, assignee: action === 'assign' ? assignee : undefined });
    return { alert, receipt: entry.receipt, created: [] };
  }

  // ---- list updates, lookback, watchlist --------------------------------------------------

  /**
   * Works out what a move to a new list version changes, without changing anything.
   *
   * Returns: { diff, newHits: [{ address, txs, entries }], watchHits, removedWithOpenAlerts }.
   */
  planUpdate(toVersion) {
    const from = this.inForce;
    const diff = from ? diffVersions(from, toVersion) : { added: [], removed: [] };
    const byAddress = new Map();
    if (from) {
      for (const tx of this.txs) {
        if (tx.outcome === 'BLOCK' || tx.flagged) continue;
        const entries = matchIn(toVersion, tx.address);
        if (!entries.length) continue;
        const key = tx.address.toLowerCase();
        if (!byAddress.has(key)) byAddress.set(key, { address: tx.address, txs: [], entries });
        byAddress.get(key).txs.push(tx);
      }
    }
    const removedKeys = new Set(diff.removed.map((r) => r.address.toLowerCase()));
    return {
      diff,
      newHits: Array.from(byAddress.values()),
      watchHits: this.watch.filter((w) => matchIn(toVersion, w.address).length).map((w) => w.address),
      removedWithOpenAlerts: this.alerts.filter((a) => isOpenWork(a) && removedKeys.has(a.address.toLowerCase())).map((a) => a.id),
    };
  }

  async #listUpdate(op) {
    if (op.actor !== 'system') this.#requireUser(op, 'list_update');
    const to = this.version(op.toVersionId);
    if (!to) refuse('no_version', 'That list version does not exist.');
    const from = this.inForce;
    if (from ? to.ordinal !== from.ordinal + 1 : to.ordinal !== 1) refuse('not_next', 'Only the next list version can be applied.');
    const plan = this.planUpdate(to);
    const actorId = op.actor;
    const first = await this.#sign({
      type: 'list_update',
      params: {
        from_version: from?.id ?? null, to_version: to.id, from_digest: from?.digest ?? null, to_digest: to.digest,
        entries_added: plan.diff.added.length, entries_removed: plan.diff.removed.length,
        lookback_hits: plan.newHits.length, demo_reconstruction: !to.real, actor: actorId,
      },
      decision: 'RECORD', outcome: 'LIST_UPDATE', reasons: [`to_version=${to.id}`],
    }, to, op);
    this.inForceId = to.id;
    this.listHistory.push({ versionId: to.id, from: op.ts, receiptId: first.receipt.receipt_id, actor: actorId });
    const created = [];
    const record = {
      id: `LB-${pad(this.counters.lookback + 1, 3)}`, ts: op.ts, fromId: from?.id ?? null, toId: to.id,
      added: plan.diff.added.map((a) => a.address), removed: plan.diff.removed.map((r) => r.address),
      newHits: [], watchHits: [], removedWithOpenAlerts: plan.removedWithOpenAlerts, receiptId: first.receipt.receipt_id,
      screenedCount: from ? this.txs.length : 0,
    };
    for (const hit of plan.newHits) {
      const alertNumber = this.counters.alert + 1;
      const alertId = `AL-${pad(alertNumber, 4)}`;
      const total = hit.txs.reduce((sum, tx) => sum + (tx.amountUsd ?? 0), 0);
      const entry = await this.#sign({
        type: 'lookback_hit',
        params: {
          alert_id: alertId, beneficiary_address: hit.address, tx_ids: hit.txs.map((t) => t.id), total_usd: total,
          from_version: from.id, to_version: to.id, actor: 'system',
        },
        decision: 'REVIEW', outcome: 'LOOKBACK_HIT', reasons: hit.entries.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}`),
      }, to, op);
      const alert = this.#newAlert({
        kind: 'lookback', address: hit.address, txIds: hit.txs.map((t) => t.id), amountUsd: total, entries: hit.entries,
        rule: null, versionId: to.id, ts: op.ts, receiptId: entry.receipt.receipt_id,
      });
      hit.txs.forEach((t) => { t.flagged = true; });
      record.newHits.push({ address: hit.address, txIds: hit.txs.map((t) => t.id), totalUsd: total, alertId: alert.id });
      created.push(alert);
    }
    for (const w of this.watch) {
      const entries = matchIn(to, w.address);
      const status = entries.length ? 'hit' : 'clear';
      const entry = await this.#sign({
        type: 'watchlist_rescreen',
        params: { beneficiary_address: w.address, label: w.label, previous_status: w.status, status, list_version: to.id, actor: 'system' },
        decision: status === 'hit' ? 'DENY' : 'ALLOW', outcome: status === 'hit' ? 'BLOCK' : 'ALLOW',
        reasons: status === 'hit' ? entries.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}`) : ['clean'],
      }, to, op);
      const changed = w.status !== status;
      w.status = status;
      w.checkedAt = op.ts;
      w.versionId = to.id;
      w.lastReceiptId = entry.receipt.receipt_id;
      if (status === 'hit' && changed) {
        const alert = this.#newAlert({
          kind: 'watchlist', address: w.address, txIds: [], amountUsd: 0, entries, rule: null, versionId: to.id, ts: op.ts,
          receiptId: entry.receipt.receipt_id,
        });
        record.watchHits.push({ address: w.address, label: w.label, alertId: alert.id });
        created.push(alert);
      }
    }
    this.counters.lookback++;
    this.lookbacks.push(record);
    return { record, created };
  }

  async #watchAdd(op) {
    const user = this.#requireUser(op, 'watch');
    const checked = readAddress(op.address);
    if (checked.error) refuse('bad_address', checked.error);
    const label = typeof op.label === 'string' ? op.label.trim() : '';
    if (!label) refuse('label_required', 'Give the counterparty a label.');
    if (label.length > MAX_LABEL_CHARS) refuse('label_too_long', `Labels are limited to ${MAX_LABEL_CHARS} characters.`);
    if (this.watch.some((w) => w.address.toLowerCase() === checked.address.toLowerCase())) refuse('duplicate', 'That address is already on the watchlist.');
    const version = this.inForce;
    const entries = matchIn(version, checked.address);
    const status = entries.length ? 'hit' : 'clear';
    const entry = await this.#sign({
      type: 'watchlist_add',
      params: { beneficiary_address: checked.address, label, status, list_version: version.id, actor: user.id },
      decision: status === 'hit' ? 'DENY' : 'ALLOW', outcome: status === 'hit' ? 'BLOCK' : 'ALLOW',
      reasons: status === 'hit' ? entries.map((e) => `sanctions_hit=SDN-${e.uid}-${e.chain}`) : ['clean'],
    }, version, op);
    this.watch.push({ address: checked.address, label, addedBy: user.id, addedAt: op.ts, status, checkedAt: op.ts, versionId: version.id, lastReceiptId: entry.receipt.receipt_id });
    const created = [];
    if (status === 'hit') {
      created.push(this.#newAlert({ kind: 'watchlist', address: checked.address, txIds: [], amountUsd: 0, entries, rule: null, versionId: version.id, ts: op.ts, receiptId: entry.receipt.receipt_id }));
    }
    return { receipt: entry.receipt, created };
  }

  async #watchRemove(op) {
    const user = this.#requireUser(op, 'watch');
    const index = this.watch.findIndex((w) => w.address.toLowerCase() === String(op.address).toLowerCase());
    if (index < 0) refuse('not_found', 'That address is not on the watchlist.');
    const [removed] = this.watch.splice(index, 1);
    // Entry is already out of the list, so a failed signature would lose it; restore on error.
    try {
      const entry = await this.#sign({
        type: 'watchlist_remove', params: { beneficiary_address: removed.address, label: removed.label, actor: user.id },
        decision: 'RECORD', outcome: 'REMOVED', reasons: [`actor=${user.id}`],
      }, this.inForce, op);
      return { receipt: entry.receipt, created: [] };
    } catch (error) {
      this.watch.splice(index, 0, removed);
      throw error;
    }
  }

  // ---- receipt network and payment gate ------------------------------------------------------

  /** A registry member by public key (hex), or null. */
  member(keyId) {
    return this.net.members.find((m) => m.keyId === keyId) ?? null;
  }

  /** Registry as the share check reads it: Map of key id to { status }. */
  registry() {
    return new Map(this.net.members.map((m) => [m.keyId, { status: m.status, name: m.name }]));
  }

  /** The list version with this digest, or null. */
  versionByDigest(digest) {
    return this.versions.find((v) => v.digest === digest) ?? null;
  }

  async #netTrust(op) {
    const user = this.#requireUser(op, 'network_trust');
    const keyId = typeof op.keyId === 'string' ? op.keyId : '';
    if (!/^[0-9a-f]{64}$/.test(keyId)) refuse('bad_key', 'A key is 64 hexadecimal characters.');
    let member = this.member(keyId);
    let before = member?.status ?? null;
    if (op.action === 'register') {
      if (member) refuse('duplicate', 'That key is already in the registry.');
      const name = typeof op.name === 'string' ? op.name.trim() : '';
      if (!name || name.length > MAX_LABEL_CHARS) refuse('label_required', `Give the member a name of 1 to ${MAX_LABEL_CHARS} characters.`);
      member = { keyId, name, status: 'registered', registeredAt: op.ts, registeredBy: user.id, pinnedAt: null, pinnedBy: null, revokedAt: null, revokedBy: null, revokeReason: null, receiptId: null };
    } else if (op.action === 'pin') {
      if (!member) refuse('unknown_key', 'That key is not in the registry. Register it first.');
      if (member.status === 'pinned') refuse('no_change', 'That key is already pinned.');
      if (member.status === 'revoked') refuse('revoked', 'A revoked key stays revoked. Register a new key for this member instead.');
    } else if (op.action === 'revoke') {
      if (!member) refuse('unknown_key', 'That key is not in the registry.');
      if (member.status === 'revoked') refuse('no_change', 'That key is already revoked.');
      if (!cleanNote(op.reason, { required: true })) refuse('note_required', 'Say why the key is revoked.');
    } else refuse('bad_action', 'Network key actions are register, pin and revoke.');
    const after = op.action === 'register' ? 'registered' : op.action === 'pin' ? 'pinned' : 'revoked';
    const reason = op.action === 'revoke' ? cleanNote(op.reason, { required: true }) : '';
    const entry = await this.#sign({
      type: 'network_trust_change',
      params: { action: op.action, key_id: keyId, member_name: member.name, state_before: before, state_after: after, actor: user.id, actor_role: user.role, ...(reason ? { reason } : {}) },
      decision: 'RECORD', outcome: 'TRUST_CHANGE', reasons: [`key_state=${after}`, `actor=${user.id}`],
    }, this.inForce ?? this.versions[0], op);
    if (!this.net.members.includes(member)) this.net.members.push(member);
    member.status = after;
    member.receiptId = entry.receipt.receipt_id;
    if (op.action === 'pin') { member.pinnedAt = op.ts; member.pinnedBy = user.id; }
    if (op.action === 'revoke') { member.revokedAt = op.ts; member.revokedBy = user.id; member.revokeReason = reason; }
    return { member, receipt: entry.receipt, created: [] };
  }

  /**
   * Records what happened to one inbound payment that came with (or without) a sender's receipt.
   * The signature checks ran before this op, in network.js; this op re-checks the facts the engine
   * owns (key pinned, list current, share unused) so an accepted record can never contradict state.
   */
  async #netReliance(op) {
    const user = this.#requireUser(op, 'network_present');
    if (!this.inForce) refuse('no_list', 'No list version is in force yet.');
    if (!['ACCEPTED', 'REFUSED', 'NONE'].includes(op.outcome)) refuse('bad_outcome', 'An inbound payment is accepted, refused or arrived with no receipt.');
    const checked = readAddress(op.address);
    if (checked.error) refuse('bad_address', checked.error);
    const amount = op.amountUsd === null || op.amountUsd === undefined ? null : readAmount(String(op.amountUsd));
    if (amount?.error) refuse('bad_amount', amount.error);
    const reasons = Array.isArray(op.reasons) ? op.reasons.map((r) => String(r.code ?? r)) : [];
    const member = op.keyId ? this.member(op.keyId) : null;
    const listVersion = op.listDigest ? this.versionByDigest(op.listDigest) : null;
    if (op.outcome === 'ACCEPTED') {
      if (reasons.length) refuse('reliance_invalid', 'An accepted payment cannot carry a refusal reason.');
      if (!member || member.status !== 'pinned') refuse('reliance_invalid', 'A receipt is relied on only when its key is pinned and not revoked.');
      if (!listVersion || listVersion.id !== this.inForceId) refuse('reliance_invalid', 'A receipt is relied on only when it was made on the list in force.');
      if (this.net.used.has(op.shareId)) refuse('reliance_invalid', 'That share was already relied on once.');
    }
    const id = `NR-${pad(this.counters.reliance + 1, 5)}`;
    const params = {
      reliance_id: id, outcome: op.outcome, share_id: op.shareId ?? null, issuer_key_id: op.keyId ?? null, issuer_name: member?.name ?? op.issuerName ?? null,
      presented_receipt_id: op.receiptId ?? null, presented_receipt_hash: op.receiptHash ?? null, beneficiary_address: checked.address, chain: op.chain ?? null,
      counterparty_address: op.counterparty ?? null, list_in_force: this.inForce.id, list_of_receipt: listVersion?.id ?? null, time_basis: 'issuer_word',
      reason_codes: reasons, actor: user.id, synthetic: true,
    };
    if (amount?.amount !== null && amount?.amount !== undefined) params.amount_usd = amount.amount;
    const decision = op.outcome === 'REFUSED' ? 'DENY' : 'RECORD';
    const outcomeWord = { ACCEPTED: 'RELIED_ON', REFUSED: 'REFUSED', NONE: 'NO_RECEIPT' }[op.outcome];
    const entry = await this.#sign({
      type: 'network_reliance', params, decision, outcome: outcomeWord, reasons: reasons.length ? reasons.map((c) => `refused=${c}`) : [`time_basis=issuer_word`],
    }, this.inForce, op);
    this.counters.reliance++;
    const record = {
      id, ts: op.ts, actor: user.id, outcome: op.outcome, reasons: Array.isArray(op.reasons) ? op.reasons.map((r) => ({ code: r.code ?? r, label: r.label ?? '', text: r.text ?? '' })) : [],
      shareId: op.shareId ?? null, keyId: op.keyId ?? null, issuerName: member?.name ?? op.issuerName ?? 'Unregistered sender', presentedReceiptId: op.receiptId ?? null,
      receiptHash: op.receiptHash ?? null, address: checked.address, chain: op.chain ?? null, counterparty: op.counterparty ?? null, amountUsd: amount?.amount ?? null,
      decidedAt: op.decidedAt ?? null, listVersionId: listVersion?.id ?? null, listInForceId: this.inForce.id, receiptId: entry.receipt.receipt_id, rescreenTxId: null,
    };
    this.net.reliances.push(record);
    if (op.outcome === 'ACCEPTED') this.net.used.set(op.shareId, id);
    return { record, receipt: entry.receipt, created: [] };
  }

  /** Links an inbound payment that had to be screened here to the screening it caused. */
  linkRescreen(relianceId, txId) {
    const record = this.net.reliances.find((r) => r.id === relianceId);
    if (record) record.rescreenTxId = txId;
  }

  async #gateCheck(op) {
    const user = this.#requireUser(op, 'gate_use');
    if (!this.inForce) refuse('no_list', 'No list version is in force yet.');
    const checked = readAddress(op.address);
    if (checked.error) refuse('bad_address', checked.error);
    const amount = op.amountUsd === null || op.amountUsd === undefined ? { amount: null } : readAmount(String(op.amountUsd));
    if (amount.error) refuse('bad_amount', amount.error);
    let presented = null;
    let valid = false;
    if (op.ref?.kind === 'ledger') {
      const entry = this.ledger.find(op.ref.id);
      if (entry) {
        const r = entry.receipt;
        presented = { kind: 'own', receiptId: r.receipt_id, type: r.action.type, outcome: r.action.params.outcome, address: r.action.params.beneficiary_address, listDigest: listSnapshotOf(r), decidedAt: r.verdict.decided_at };
        valid = (await checkReceipt(r)).ok;
      }
    } else if (op.ref?.kind === 'shared') {
      const rel = this.net.reliances.find((r) => r.id === op.ref.id);
      if (rel?.outcome === 'ACCEPTED') {
        presented = { kind: 'shared', receiptId: rel.id, type: 'stablecoin_payment_screen', outcome: 'ALLOW', address: rel.address, listDigest: this.version(rel.listVersionId)?.digest ?? null, decidedAt: rel.decidedAt };
        valid = true;
      }
    }
    const verdict = evaluateGate({ presented, valid, address: checked.address, now: new Date(op.ts), listDigest: this.inForce.digest });
    const id = `GT-${pad(this.counters.gate + 1, 5)}`;
    const release = verdict.release;
    const params = {
      gate_id: id, transfer_id: op.transferId ?? id, gate: release ? 'RELEASE' : 'BLOCK', beneficiary_address: checked.address, presented_kind: presented?.kind ?? 'none',
      presented_receipt_id: presented?.receiptId ?? null, reason_codes: verdict.reasons, list_in_force: this.inForce.id, source: op.source ?? 'manual', actor: user.id, synthetic: true,
    };
    if (amount.amount !== null) params.amount_usd = amount.amount;
    const entry = await this.#sign({
      type: 'gate_decision', params, decision: release ? 'ALLOW' : 'DENY', outcome: release ? 'RELEASED' : 'BLOCKED',
      reasons: release ? ['gate=release'] : verdict.reasons.map((c) => `gate_block=${c}`),
    }, this.inForce, op);
    this.counters.gate++;
    const record = {
      id, ts: op.ts, actor: user.id, transferId: params.transfer_id, release, reasons: verdict.reasons, address: checked.address, amountUsd: amount.amount,
      presentedKind: params.presented_kind, presentedReceiptId: params.presented_receipt_id, source: params.source, receiptId: entry.receipt.receipt_id,
    };
    this.net.gates.push(record);
    return { record, receipt: entry.receipt, created: [] };
  }

  // ---- policy, roles, exports -------------------------------------------------------------

  #policyValue(key) {
    return key.split('.').reduce((node, part) => node[part], this.policy);
  }

  async #policySet(op) {
    const user = this.#requireUser(op, 'policy');
    const kind = POLICY_KEYS[op.key];
    if (!kind) refuse('bad_setting', 'That setting does not exist.');
    let value = op.value;
    if (kind === 'boolean' && typeof value !== 'boolean') refuse('bad_value', 'This setting is on or off.');
    if (kind === 'amount') {
      const checked = readAmount(String(value));
      if (checked.error || checked.amount === null || checked.amount < 1 || checked.amount > MAX_THRESHOLD_USD) refuse('bad_value', `Use a whole number of dollars from 1 to ${MAX_THRESHOLD_USD.toLocaleString('en-US')}.`);
      value = checked.amount;
    }
    const before = this.#policyValue(op.key);
    if (before === value) refuse('no_change', 'That is already the current value.');
    const entry = await this.#sign({
      type: 'policy_change',
      params: { setting: op.key, from: before, to: value, actor: user.id, actor_role: user.role, applies_to: 'future screenings only' },
      decision: 'RECORD', outcome: 'POLICY_CHANGE', reasons: [`setting=${op.key}`],
    }, this.inForce, op);
    const parts = op.key.split('.');
    const leaf = parts.pop();
    parts.reduce((node, part) => node[part], this.policy)[leaf] = value;
    return { receipt: entry.receipt, created: [] };
  }

  async #userRole(op) {
    const actor = this.#requireUser(op, 'roles');
    const target = this.user(op.userId);
    if (!target) refuse('unknown_user', 'That user does not exist in this demo.');
    if (!ROLES.includes(op.role)) refuse('bad_role', 'Roles are analyst, approver or admin.');
    if (target.role === op.role) refuse('no_change', 'That user already has this role.');
    if (target.role === 'admin' && this.users.filter((u) => u.role === 'admin').length === 1) refuse('last_admin', 'The last admin cannot be changed.');
    const entry = await this.#sign({
      type: 'role_change', params: { user_id: target.id, from: target.role, to: op.role, actor: actor.id },
      decision: 'RECORD', outcome: 'ROLE_CHANGE', reasons: [`user=${target.id}`],
    }, this.inForce, op);
    target.role = op.role;
    return { receipt: entry.receipt, created: [] };
  }

  async #evidenceExport(op) {
    const user = this.#requireUser(op, 'export');
    const entry = await this.#sign({
      type: 'evidence_export',
      params: { scope: op.scope, pack_digest: op.packDigest, receipts_in_pack: op.receiptCount, segments_in_pack: op.segmentCount, actor: user.id },
      decision: 'RECORD', outcome: 'EXPORT', reasons: [`pack_digest=${op.packDigest}`],
    }, this.inForce, op);
    this.exports.push({ ts: op.ts, actor: user.id, scope: op.scope, packDigest: op.packDigest, receiptId: entry.receipt.receipt_id });
    return { receipt: entry.receipt, created: [] };
  }
}

export const ALERT_ACTIONS = ['assign', 'note', 'start_review', 'escalate', 'propose_clear', 'confirm', 'approve_clear', 'reject_clear', 'reopen'];

export { MAX_AMOUNT_USD };
