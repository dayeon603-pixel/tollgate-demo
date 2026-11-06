/**
 * List versions for the workspace. The newest version is the bundled real OFAC snapshot. The two
 * earlier versions are demo reconstructions: the same list with some entries held back, plus a few
 * clearly marked synthetic entries, so there is a history to diff and re-screen against. They are
 * not historical OFAC publications and the UI says so.
 */
import { sha256Hex } from '../workbench.js';
import { rng, shuffled } from './util.js';

/** Chains that carry stablecoins, used to pick realistic held-back entries. */
const STABLE_CHAINS = new Set(['ETH', 'TRX', 'USDT', 'USDC', 'ARB', 'BSC']);
const HELD_BACK_IN_LATEST = 7;
const HELD_BACK_IN_MIDDLE = 9;
const SYNTHETIC_REMOVED_IN_LATEST = 3;
const SYNTHETIC_REMOVED_IN_MIDDLE = 2;
export const SYNTHETIC_NAME = 'DEMO ENTRY (synthetic, not an OFAC listing)';

function syntheticEntry(n) {
  const address = `0x${'de'.repeat(16)}${'0'.repeat(6)}${String(n).padStart(2, '0')}`;
  return { address, chain: 'ETH', name: `${SYNTHETIC_NAME} ${n}`, uid: `DEMO-${n}`, synthetic: true };
}

function groupByAddress(entries) {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.address.toLowerCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return map;
}

async function makeVersion({ ordinal, entries, digest, real, publishDate, label, note }) {
  const byAddress = groupByAddress(entries);
  const addresses = Array.from(byAddress.keys()).sort();
  const finalDigest = digest ?? (await sha256Hex(`tollgate-demo-list-v${ordinal}\n${addresses.join('\n')}`));
  return {
    id: `L${ordinal}`,
    ordinal,
    label,
    digest: finalDigest,
    rulebook: `SDN-OFAC-${finalDigest.slice(0, 12)}`,
    real,
    publishDate,
    note,
    addressCount: addresses.length,
    byAddress,
    meta: { list_digest: finalDigest },
  };
}

/**
 * Builds the three list versions from the bundled snapshot.
 *
 * Args: list, the parsed bundle; seed, makes the held-back choice reproducible.
 * Returns: [oldest, middle, newest] version objects. The newest is the real snapshot unchanged.
 */
export async function buildVersions(list, seed = 7) {
  const rand = rng(seed);
  const grouped = Array.from(groupByAddress(list.entries).entries());
  const stable = grouped.filter(([, entries]) => entries.every((e) => STABLE_CHAINS.has(e.chain)));
  const pool = shuffled(rand, stable.length >= HELD_BACK_IN_LATEST + HELD_BACK_IN_MIDDLE ? stable : grouped);
  const heldLatest = new Set(pool.slice(0, HELD_BACK_IN_LATEST).map(([key]) => key));
  const heldMiddle = new Set(pool.slice(HELD_BACK_IN_LATEST, HELD_BACK_IN_LATEST + HELD_BACK_IN_MIDDLE).map(([key]) => key));
  const synthLatest = Array.from({ length: SYNTHETIC_REMOVED_IN_LATEST }, (_, i) => syntheticEntry(i + 1));
  const synthMiddle = Array.from({ length: SYNTHETIC_REMOVED_IN_MIDDLE }, (_, i) => syntheticEntry(SYNTHETIC_REMOVED_IN_LATEST + i + 1));
  const keep = (excluded) => list.entries.filter((e) => !excluded.has(e.address.toLowerCase()));
  const demoNote = 'Demo reconstruction, not a historical OFAC file.';
  const oldest = await makeVersion({
    ordinal: 1, label: 'List v1', real: false, publishDate: 'demo', note: demoNote,
    entries: [...keep(new Set([...heldLatest, ...heldMiddle])), ...synthLatest, ...synthMiddle],
  });
  const middle = await makeVersion({
    ordinal: 2, label: 'List v2', real: false, publishDate: 'demo', note: demoNote,
    entries: [...keep(heldLatest), ...synthLatest],
  });
  const newest = await makeVersion({
    ordinal: 3, label: 'List v3', real: true, publishDate: list.publish_date, digest: list.list_digest,
    note: 'The bundled OFAC snapshot, unchanged.', entries: list.entries,
  });
  return { versions: [oldest, middle, newest], heldLatest: Array.from(heldLatest), heldMiddle: Array.from(heldMiddle) };
}

/** List entries a version holds for an address (case-insensitive exact match), or []. */
export function matchIn(version, address) {
  return version.byAddress.get(address.toLowerCase()) ?? [];
}

/** What changed from one version to another. Each side is an array of { address, entries }. */
export function diffVersions(from, to) {
  const added = [];
  const removed = [];
  for (const [key, entries] of to.byAddress) if (!from.byAddress.has(key)) added.push({ address: entries[0].address, entries });
  for (const [key, entries] of from.byAddress) if (!to.byAddress.has(key)) removed.push({ address: entries[0].address, entries });
  const byAddress = (a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase());
  return { added: added.sort(byAddress), removed: removed.sort(byAddress) };
}
