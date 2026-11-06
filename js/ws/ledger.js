/**
 * The workspace ledger: every event the workspace records (a screening, a case action, a policy
 * change, a list update) becomes one signed, hash-chained receipt.
 *
 * The browser verifier checks one receipts file at a time, and it requires that a file names one
 * list version in its header and has a bounded size. So the ledger is a series of segments. Each
 * segment is an ordinary receipts file for one list version, starting from the genesis hash. The
 * first receipt of every later segment is a signed "segment_open" receipt that carries the previous
 * segment's head hash, so the segments are linked by something signed, not just by this code.
 */
import { verifyText } from '../verifier.js';
import { appendSigned, emptyChain, packageText, sha256Hex } from '../workbench.js';

export const MAX_SEGMENT_RECEIPTS = 100;
/** Keeps a segment under the verifier's 200,000 character limit with room to spare. */
export const MAX_SEGMENT_CHARS = 150_000;
export const AGENT_ID = 'tollgate.workspace-demo';

export class Ledger {
  /** idPrefix: receipt ids are `${idPrefix}${n}`. The live stream uses "d" so its ids never collide with the workspace ledger's "u". */
  constructor({ idPrefix = 'u' } = {}) {
    this.idPrefix = idPrefix;
    /** @type {{id: string, versionId: string, meta: object, chain: object, chars: number}[]} */
    this.segments = [];
    /** Flat list in ledger order: { receipt, segment (index), n (1-based count over the ledger), versionId }. */
    this.entries = [];
    this.byId = new Map();
  }

  get size() {
    return this.entries.length;
  }

  head() {
    return this.entries.at(-1)?.receipt.this_hash ?? null;
  }

  /**
   * Signs and appends an event, opening a new segment first when the list version changed or the
   * current segment is full.
   *
   * Args: spec, as for appendSigned (without id); version, the list version in force for this
   *   event ({ id, meta }); now, the Date of the event.
   * Returns: the entry { receipt, segment, n, versionId }.
   */
  async append(spec, version, now) {
    let current = this.segments.at(-1);
    const reason = !current ? 'first segment' : current.versionId !== version.id ? 'list version change'
      : current.chain.receipts.length >= MAX_SEGMENT_RECEIPTS || current.chars >= MAX_SEGMENT_CHARS ? 'segment full' : null;
    if (reason) current = await this.#open(version, now, reason);
    return this.#add(current, spec, version.meta, now);
  }

  async #open(version, now, reason) {
    const prior = this.segments.at(-1);
    const index = this.segments.length;
    const segment = {
      id: `seg-${String(index + 1).padStart(3, '0')}`,
      versionId: version.id,
      meta: version.meta,
      chain: emptyChain(version.meta),
      chars: 0,
    };
    this.segments.push(segment);
    const params = {
      segment_id: segment.id,
      reason,
      prior_segment_id: prior ? prior.id : null,
      prior_segment_head: prior ? prior.chain.receipts.at(-1).this_hash : null,
      prior_segment_receipts: prior ? prior.chain.receipts.length : 0,
    };
    await this.#add(segment, { type: 'segment_open', params, decision: 'RECORD', outcome: 'SEGMENT_OPEN', reasons: [`reason=${reason}`], agentId: AGENT_ID }, version.meta, now);
    return segment;
  }

  async #add(segment, spec, meta, now) {
    const n = this.entries.length + 1;
    const receipt = await appendSigned(segment.chain, meta, { ...spec, id: `${this.idPrefix}${n}`, agentId: spec.agentId ?? AGENT_ID }, now);
    segment.chars += JSON.stringify(receipt, null, 2).length + 2;
    const entry = { receipt, segment: this.segments.indexOf(segment), n, versionId: segment.versionId };
    this.entries.push(entry);
    this.byId.set(receipt.receipt_id, entry);
    return entry;
  }

  find(receiptId) {
    return this.byId.get(receiptId) ?? null;
  }

  /** The entry after this one in the same segment, or null. */
  next(entry) {
    const chain = this.segments[entry.segment].chain.receipts;
    const following = chain[entry.receipt.seq + 1];
    return following ? this.byId.get(following.receipt_id) : null;
  }

  /** Exact text of a segment, as the verifier and an offline checker read it. */
  segmentText(index) {
    return packageText(this.segments[index].chain);
  }

  /** Runs the real verifier over one segment. Returns its Outcome. */
  verifySegment(index) {
    return verifyText(this.segmentText(index));
  }

  /**
   * Verifies every segment with the real verifier and checks the signed links between segments.
   *
   * Returns: { ok, segments: [{ id, kind, receipts }], links: [{ from, to, ok }] }.
   */
  async verifyAll() {
    const segments = [];
    for (let i = 0; i < this.segments.length; i++) {
      const outcome = await this.verifySegment(i);
      segments.push({ id: this.segments[i].id, kind: outcome.kind, receipts: this.segments[i].chain.receipts.length, outcome });
    }
    return { ...checkLinks(this.segments.map((s) => s.chain), segments) };
  }

  /** SHA-256 of each segment's exact text. */
  async segmentDigests() {
    return Promise.all(this.segments.map((_, i) => sha256Hex(this.segmentText(i))));
  }
}

/**
 * Checks that each segment's opening receipt names the head of the segment before it.
 *
 * Args: chains, the receipts files in order; segments, their verifier results (kind per segment).
 */
export function checkLinks(chains, segments) {
  const links = [];
  for (let i = 1; i < chains.length; i++) {
    const open = chains[i].receipts[0];
    const prior = chains[i - 1].receipts.at(-1);
    const ok = open?.action?.type === 'segment_open' && open.action.params.prior_segment_head === prior?.this_hash;
    links.push({ from: i - 1, to: i, ok });
  }
  const first = chains[0]?.receipts[0];
  const startsRight = first?.action?.type === 'segment_open' && first.action.params.prior_segment_head === null;
  const ok = startsRight && segments.every((s) => s.kind === 'pass') && links.every((l) => l.ok);
  return { ok, segments, links };
}
