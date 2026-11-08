/**
 * Payment gate, demo edition. A transfer is released only when it comes with a valid, current
 * receipt that cleared it: the receipt must be intact, cover this address, say ALLOW, have been made
 * on the list in force, and be recent enough. Anything else is blocked, with the reason.
 *
 * The gate decides nothing about sanctions. It checks that a clear screening decision exists and is
 * still good, and it never overrides the list: a receipt that says ALLOW for an address the list now
 * holds was made on an older list, so it is blocked as stale.
 */
export const GATE_FRESHNESS_MS = 24 * 3_600_000;
export const GATE_FUTURE_SKEW_MS = 300_000;

/** Block reasons: short label and sentence. */
export const GATE_REASONS = {
  no_receipt: ['No receipt', 'The transfer came with no receipt, so there is no screening decision to rely on.'],
  invalid_receipt: ['Receipt does not verify', 'The receipt was changed after it was signed or its signature does not match.'],
  wrong_address: ['Different address', 'The receipt covers a different address than this transfer.'],
  not_clear: ['Receipt is not a clear', 'The receipt records a hold, a list hit or some other event, not a decision that allowed the payment.'],
  stale_list: ['Stale list', 'The receipt was made on a list version that is no longer the one in force.'],
  expired: ['Receipt too old', 'The receipt is older than the 24 hour limit.'],
  future: ['Dated in the future', 'The receipt claims a time later than the clock allows.'],
};

export const gateLabel = (code) => GATE_REASONS[code]?.[0] ?? code;
export const gateText = (code) => GATE_REASONS[code]?.[1] ?? code;

/**
 * Args: presented (null, or { kind, type, outcome, address, listDigest, decidedAt }); valid, whether
 *   the presented receipt's signature, binding and hash checked out; address, the transfer's
 *   beneficiary; now, a Date; listDigest, the list in force.
 * Returns: { release, reasons } where reasons is every block code that applies, most basic first.
 */
export function evaluateGate({ presented, valid, address, now, listDigest, freshnessMs = GATE_FRESHNESS_MS }) {
  if (!presented) return { release: false, reasons: ['no_receipt'] };
  const reasons = [];
  if (!valid) reasons.push('invalid_receipt');
  if (String(presented.address ?? '').toLowerCase() !== String(address).toLowerCase()) reasons.push('wrong_address');
  if (presented.type !== 'stablecoin_payment_screen' || presented.outcome !== 'ALLOW') reasons.push('not_clear');
  if (presented.listDigest !== listDigest) reasons.push('stale_list');
  const age = now.getTime() - Date.parse(presented.decidedAt);
  if (Number.isNaN(age) || age < -GATE_FUTURE_SKEW_MS) reasons.push('future');
  else if (age > freshnessMs) reasons.push('expired');
  return { release: reasons.length === 0, reasons };
}
