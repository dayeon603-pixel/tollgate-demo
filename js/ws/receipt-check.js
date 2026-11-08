/**
 * Offline check of one receipt against the public key it names. Works for the published demo key
 * and for any other Ed25519 key, which is what lets a receipt from another institution be checked
 * here with nothing but the receipt. Uses Web Crypto only and makes no network calls.
 *
 * Checks, in order: the payment details still match the fingerprint inside the signed decision
 * (binding), the signature over the decision (signature), the receipt's own hash (hash), and
 * optionally that the signer is a key the caller expects (signer). It does not say the decision
 * was right, only that this key signed these bytes.
 */
import { canon } from '../verifier.js';
import { sha256Hex } from '../workbench.js';

const KEY_HEX = /^[0-9a-f]{64}$/;
const SIG_HEX = /^[0-9a-f]{128}$/;

/** What each failure code means in plain words. */
export const CHECK_MESSAGES = {
  shape: 'The receipt is missing a field or has one of the wrong type.',
  binding: 'The payment details changed after signing: they no longer match the fingerprint inside the signed decision.',
  signature: 'The signature does not match the signed decision.',
  hash: "The receipt's own fingerprint does not match its contents.",
  signer: 'The receipt was signed by a different key than the one expected.',
};

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function wellFormed(r) {
  return Boolean(r && typeof r === 'object' && typeof r.receipt_id === 'string' && Number.isInteger(r.seq) && typeof r.prev_hash === 'string'
    && typeof r.this_hash === 'string' && r.action && typeof r.action === 'object' && r.action.params && typeof r.action.params === 'object'
    && r.verdict && KEY_HEX.test(r.verdict.authorizer_id ?? '') && SIG_HEX.test(r.verdict.signature ?? '') && Array.isArray(r.verdict.reasons));
}

/**
 * Args: receipt; options { expectKey: hex public key the receipt must be signed by, or null }.
 * Returns: { ok, code, detail } where code is null on success or one of CHECK_MESSAGES' keys.
 */
export async function checkReceipt(receipt, { expectKey = null } = {}) {
  if (!wellFormed(receipt)) return { ok: false, code: 'shape', detail: CHECK_MESSAGES.shape };
  const { action, verdict } = receipt;
  const fail = (code) => ({ ok: false, code, detail: CHECK_MESSAGES[code] });
  if ((await sha256Hex(canon(action))) !== verdict.action_digest) return fail('binding');
  const { signature, ...unsigned } = verdict;
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(verdict.authorizer_id), { name: 'Ed25519' }, false, ['verify']);
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signature), new TextEncoder().encode(canon(unsigned)));
  } catch {
    valid = false;
  }
  if (!valid) return fail('signature');
  const hash = await sha256Hex(canon({ seq: receipt.seq, prev_hash: receipt.prev_hash, action, verdict }));
  if (hash !== receipt.this_hash) return fail('hash');
  if (expectKey && verdict.authorizer_id !== expectKey) return fail('signer');
  return { ok: true, code: null, detail: 'Signature, binding and hash all match.' };
}

/** The list digest a receipt names in its signed reasons, or null. */
export function listSnapshotOf(receipt) {
  const reason = receipt?.verdict?.reasons?.find((r) => typeof r === 'string' && r.startsWith('list_snapshot='));
  return reason ? reason.slice('list_snapshot='.length) : null;
}
