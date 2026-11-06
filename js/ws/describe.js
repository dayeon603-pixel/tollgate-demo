/** Plain-language descriptions of ledger entries, shared by the dashboard, activity log and explorer. */
import { money, shortAddr } from './dom.js';

export const ACTION_LABELS = {
  created: 'Alert created', assign: 'Assigned', note: 'Added a note', start_review: 'Started review', escalate: 'Escalated',
  propose_clear: 'Proposed clearance', approve_clear: 'Approved clearance', reject_clear: 'Rejected clearance',
  clear: 'Cleared', confirm: 'Confirmed', reopen: 'Reopened',
};

export const TYPE_LABELS = {
  stablecoin_payment_screen: 'Screening', case_action: 'Case action', list_update: 'List update', lookback_hit: 'Lookback hit',
  watchlist_add: 'Watchlist add', watchlist_remove: 'Watchlist remove', watchlist_rescreen: 'Watchlist re-screen',
  policy_change: 'Policy change', role_change: 'Role change', evidence_export: 'Evidence export', segment_open: 'Segment open',
};

/** Which filter group a receipt type belongs to in the activity log. */
export const TYPE_GROUPS = {
  screening: ['stablecoin_payment_screen'],
  cases: ['case_action', 'lookback_hit'],
  lists: ['list_update', 'watchlist_add', 'watchlist_remove', 'watchlist_rescreen'],
  admin: ['policy_change', 'role_change', 'evidence_export'],
  ledger: ['segment_open'],
};

export function actorName(ws, id) {
  if (id === 'api') return 'API (demo feed)';
  if (id === 'system') return 'System';
  const user = ws.user(id);
  return user ? user.name : String(id ?? '');
}

/** Returns { actor, text } for a ledger entry. */
export function describe(ws, entry) {
  const { action, verdict } = entry.receipt;
  const p = action.params;
  switch (action.type) {
    case 'stablecoin_payment_screen': {
      const verb = { ALLOW: 'allowed', HOLD: 'held', BLOCK: 'hit on the list' }[p.outcome] ?? p.outcome;
      return { actor: actorName(ws, p.actor), text: `Screened ${shortAddr(p.beneficiary_address)} for ${money(p.amount_usd ?? null)}: ${verb}${p.policy_rule ? ` (${p.policy_rule.replace('_', ' ')})` : ''}` };
    }
    case 'case_action': return { actor: actorName(ws, p.actor), text: `${ACTION_LABELS[p.action] ?? p.action} on ${p.alert_id}${p.note ? `: ${p.note}` : ''}` };
    case 'list_update': return { actor: actorName(ws, p.actor), text: `Applied ${p.to_version}${p.from_version ? ` (from ${p.from_version})` : ' as the first list'}: ${p.entries_added} added, ${p.entries_removed} removed, ${p.lookback_hits} lookback hits` };
    case 'lookback_hit': return { actor: 'System', text: `Lookback: ${shortAddr(p.beneficiary_address)} is now listed. ${p.tx_ids.length} earlier payments, ${money(p.total_usd)}. Alert ${p.alert_id}` };
    case 'watchlist_add': return { actor: actorName(ws, p.actor), text: `Added ${p.label} to the watchlist (${p.status})` };
    case 'watchlist_remove': return { actor: actorName(ws, p.actor), text: `Removed ${p.label} from the watchlist` };
    case 'watchlist_rescreen': return { actor: 'System', text: `Re-screened ${p.label}: ${p.status}${p.previous_status !== p.status ? ` (was ${p.previous_status})` : ''}` };
    case 'policy_change': return { actor: actorName(ws, p.actor), text: `Changed ${p.setting} from ${p.from} to ${p.to}` };
    case 'role_change': return { actor: actorName(ws, p.actor), text: `Changed ${p.user_id} from ${p.from} to ${p.to}` };
    case 'evidence_export': return { actor: actorName(ws, p.actor), text: `Exported an evidence pack: ${p.receipts_in_pack} receipts in ${p.segments_in_pack} segments` };
    case 'segment_open': return { actor: 'System', text: `Opened ledger segment ${p.segment_id} (${p.reason})` };
    default: return { actor: '', text: `${action.type} ${verdict.decision}` };
  }
}
