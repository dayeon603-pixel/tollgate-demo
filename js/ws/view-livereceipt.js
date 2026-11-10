/** Drawer content for one stream receipt: what was screened, the decision, verify, and send to the queue. */
import { clear, copyButton, h, kv, money, mono, outcomeTag, shortHash } from './dom.js';
import { CHAIN_LABEL, LIVE_MAX_RECEIPTS } from './stream.js';

export function liveReceiptView(ctx, record) {
  const { tape } = ctx.live;
  const entry = record.epoch === tape.epoch ? tape.ledger.find(record.receiptId) : null;
  const out = h('div', { class: 'receipt-live', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { class: 'case' });
  body.append(
    h('p', { class: 'demo-line' }, `Sample payment. The decision and receipt are real (rolling window of ${LIVE_MAX_RECEIPTS}).`),
    kv([
      ['Decision', outcomeTag(record.outcome)],
      ['Chain and asset', `${CHAIN_LABEL[record.chain]}, ${record.asset}`],
      ['Amount', money(record.amountUsd)],
      ['From', h('span', { class: 'field__text' }, mono(record.from), copyButton(record.from, 'sender'))],
      ['To (screened)', h('span', { class: 'field__text' }, mono(record.to), copyButton(record.to, 'beneficiary'))],
      ['List', record.versionId],
      record.rule ? ['Policy rule', record.rule.replace('_', ' ')] : null,
      record.entries.length ? ['Matched', record.entries.map((e) => `${e.name} (UID ${e.uid})`).join('; ')] : null,
      ['Receipt', mono(record.receiptId.replace('rcpt:', ''))],
      entry ? ['Hash', mono(shortHash(entry.receipt.this_hash, 14, 8))] : null,
      ['Screening time', `${record.ms.toFixed(1)} ms, measured in this browser`],
    ]));
  const verify = h('button', { type: 'button', class: 'btn', id: 'lr-verify', disabled: !entry, on: { click: async () => {
    const outcome = await tape.ledger.verifySegment(entry.segment);
    clear(out).append(h('div', { class: 'banner', 'data-state': outcome.kind === 'pass' ? 'pass' : 'fail' }, h('span', { class: 'banner__lead', text: outcome.kind === 'pass' ? 'Segment verifies' : 'Segment failed' }),
      h('span', { class: 'banner__detail', text: `${tape.ledger.segments[entry.segment].chain.receipts.length} receipts in the segment holding this one, checked with the real verifier.` })));
  } } }, 'Verify this receipt\'s segment');
  const send = h('button', { type: 'button', class: 'btn btn--primary', id: 'lr-send', disabled: record.outcome === 'ALLOW' || !ctx.ws.can(ctx.userId, 'screen'), on: { click: async () => {
    const r = await ctx.run({ op: 'screen', actor: 'api', source: 'api', address: record.to, amount: record.amountUsd, originator: record.originator });
    if (r.ok && r.result.created.length) { ctx.toast(`Alert ${r.result.created[0].id} opened in the queue.`); ctx.openAlert(r.result.created[0].id); }
  } } }, 'Send to the alert queue');
  body.append(...[h('div', { class: 'btnrow' }, verify, send, h('button', { type: 'button', class: 'btn', on: { click: () => ctx.go('graph', { address: record.to }) } }, 'Counterparties')), out,
    entry ? null : h('p', { class: 'field__hint', text: 'This receipt has left the rolling window, so it can no longer be verified here.' })].filter(Boolean));
  return body;
}
