/**
 * Screening, signing and packaging for the "Get started" flow. Runs with Web Crypto only and makes
 * no network calls beyond the page's own bundled list file.
 *
 * Screening is an exact address match against the bundled OFAC list, ignoring upper and lower
 * case. It does no name matching, no fuzzy matching and no address normalisation beyond trimming
 * surrounding spaces. Receipts are signed with the published demo key, whose private half is public
 * on purpose, so a receipt made here shows how the format works and says nothing about who signed.
 *
 * Every receipt this module builds is checked by verifier.js with the same rules as the sample.
 */
import { SAMPLE_PUBLIC_KEY, canon } from './verifier.js';

export const LIST_URL = 'data/ofac_crypto_addresses.json';
export const GENESIS = '0'.repeat(64);
export const MAX_ADDRESS_LENGTH = 128;
export const MAX_AMOUNT_USD = 1_000_000_000_000;
export const AGENT_ID = 'tollgate.browser-demo';

/**
 * Private seed of the published demo key: the bytes 0x00 to 0x1f. It is published so anyone can
 * reproduce the sample, which is why it authorizes nothing.
 */
const DEMO_SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
/** PKCS #8 wrapper for a raw Ed25519 seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const ADDRESS_SHAPE = /^[A-Za-z0-9:._-]+$/;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * Checks the shape of a bundled list and builds its lookup.
 *
 * Args: list, the parsed bundle; text, its exact file text (for the browser-side digest).
 * Returns: { meta, index, fileSha256 } where index maps a lower-cased address to its entries.
 * Raises: Error when the bundle is missing a provenance field or its entries are malformed.
 */
export async function prepareList(list, text) {
  const required = ['source', 'source_url', 'publish_date', 'fetched_at', 'raw_sha256', 'list_digest', 'address_count', 'entries'];
  if (list === null || typeof list !== 'object') throw new Error('The list file is not an object.');
  for (const key of required) if (!(key in list)) throw new Error(`The list file has no "${key}".`);
  if (!/^[0-9a-f]{64}$/.test(list.list_digest)) throw new Error('The list digest is not a SHA-256 hex string.');
  if (!Array.isArray(list.entries) || list.entries.length === 0) throw new Error('The list has no entries.');
  const index = new Map();
  for (const entry of list.entries) {
    if (typeof entry?.address !== 'string' || typeof entry.chain !== 'string' || typeof entry.uid !== 'string') {
      throw new Error('A list entry is malformed.');
    }
    const key = entry.address.toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(entry);
  }
  if (index.size !== list.address_count) throw new Error('The address count does not match the entries.');
  const { entries, ...meta } = list;
  return { meta, index, fileSha256: await sha256Hex(text) };
}

/** Short list label used in signed reasons, derived from the list digest. */
export function rulebookVersion(meta) {
  return `SDN-OFAC-${meta.list_digest.slice(0, 12)}`;
}

/**
 * Checks what a person typed before it is screened.
 *
 * Returns: { address } on success or { error } with a plain message.
 */
export function readAddress(raw) {
  const address = typeof raw === 'string' ? raw.trim() : '';
  if (!address) return { error: 'Paste an address to screen.' };
  if (address.length > MAX_ADDRESS_LENGTH) return { error: `That is longer than ${MAX_ADDRESS_LENGTH} characters, so it is not an address on this list.` };
  if (!ADDRESS_SHAPE.test(address)) return { error: 'Addresses use letters, digits and a few symbols only. Remove spaces or other characters.' };
  return { address };
}

/**
 * Reads an optional USD amount.
 *
 * Returns: { amount } (a whole number or null when left empty) or { error }.
 */
export function readAmount(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/,/g, '') : '';
  if (!text) return { amount: null };
  if (!/^\d+$/.test(text)) return { error: 'Use a whole number of dollars, or leave the amount empty.' };
  const amount = Number(text);
  if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT_USD) return { error: 'That amount is too large for this demo.' };
  return { amount };
}

/**
 * Exact address match, ignoring upper and lower case.
 *
 * Returns: { outcome: 'BLOCK' | 'ALLOW', matches } where matches are the list entries hit.
 */
export function screen(prepared, address) {
  const matches = prepared.index.get(address.toLowerCase()) ?? [];
  return { outcome: matches.length ? 'BLOCK' : 'ALLOW', matches };
}

let demoKeyPromise = null;
function demoKey() {
  if (!demoKeyPromise) {
    const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + DEMO_SEED.length);
    pkcs8.set(PKCS8_ED25519_PREFIX);
    pkcs8.set(DEMO_SEED, PKCS8_ED25519_PREFIX.length);
    demoKeyPromise = crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']).catch((error) => {
      demoKeyPromise = null;
      throw error;
    });
  }
  return demoKeyPromise;
}

/** True when this browser can sign with Ed25519. */
export async function signingAvailable() {
  try {
    await demoKey();
    return true;
  } catch {
    return false;
  }
}

/** An empty receipt file for a list. Its header must match every receipt's signed reasons. */
export function emptyChain(meta) {
  return { list_snapshot: meta.list_digest, rulebook_version: rulebookVersion(meta), receipts: [] };
}

/**
 * Signs one screening decision and appends it to a chain, in the same format as the sample.
 *
 * Args: chain, a receipt file built by emptyChain (changed in place); meta, the list provenance;
 *   decision, { address, amount, outcome, matches }; now, the Date of the check.
 * Returns: the new receipt.
 */
export async function appendReceipt(chain, meta, decision, now = new Date()) {
  const seq = chain.receipts.length;
  const prevHash = seq === 0 ? GENESIS : chain.receipts[seq - 1].this_hash;
  const id = `u${seq + 1}`;
  const version = rulebookVersion(meta);
  const params = { payment_id: id, outcome: decision.outcome, beneficiary_address: decision.address };
  if (decision.amount !== null && decision.amount !== undefined) params.amount_usd = decision.amount;
  const iso = now.toISOString();
  const action = {
    action_id: `act:${id}`,
    agent_id: AGENT_ID,
    mandate_id: `rulebook:${version}`,
    type: 'stablecoin_payment_screen',
    params,
    requested_at: iso,
  };
  const hits = decision.matches.map((entry) => `sanctions_hit=SDN-${entry.uid}-${entry.chain}`);
  const unsigned = {
    verdict_id: `vd:${id}`,
    action_id: action.action_id,
    authorizer_id: SAMPLE_PUBLIC_KEY,
    decision: decision.outcome === 'BLOCK' ? 'DENY' : 'ALLOW',
    reasons: [`outcome=${decision.outcome}`, `rulebook_version=${version}`, `list_snapshot=${meta.list_digest}`, ...(hits.length ? hits : ['clean'])],
    decided_at: iso,
    action_digest: await sha256Hex(canon(action)),
  };
  const signature = toHex(await crypto.subtle.sign({ name: 'Ed25519' }, await demoKey(), new TextEncoder().encode(canon(unsigned))));
  const verdict = { ...unsigned, signature };
  const receipt = { receipt_id: `rcpt:${id}`, seq, prev_hash: prevHash, action, verdict, this_hash: '' };
  receipt.this_hash = await sha256Hex(canon({ seq, prev_hash: prevHash, action, verdict }));
  chain.receipts.push(receipt);
  return receipt;
}

/** The exact text of a receipt package: the receipts file the verifier reads, nothing added. */
export function packageText(chain) {
  return `${JSON.stringify(chain, null, 2)}\n`;
}

/** File name for a package, from the hash of its newest receipt. */
export function packageName(chain) {
  const head = chain.receipts.at(-1)?.this_hash ?? GENESIS;
  return `tollgate-receipts-${head.slice(0, 12)}.json`;
}
