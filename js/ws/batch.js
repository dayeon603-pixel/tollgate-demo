/**
 * Batch screening: parse pasted or uploaded CSV, screen each row through the workspace, and
 * export the results. Parsing says which line it could not read.
 */
import { MAX_ADDRESS_LENGTH, readAddress } from '../workbench.js';
import { parseCsv, toCsv } from './util.js';
import { WorkspaceError } from './engine.js';

export const MAX_BATCH_ROWS = 500;
export const MAX_UPLOAD_BYTES = 200_000;
const ALIASES = {
  address: ['address', 'beneficiary', 'beneficiary_address', 'counterparty', 'to', 'wallet'],
  amount: ['amount', 'amount_usd', 'usd', 'value', 'value_usd'],
  txHash: ['tx', 'tx_hash', 'txhash', 'hash', 'transaction', 'transaction_hash'],
  originator: ['originator', 'originator_info', 'originator_present', 'originator_info_present'],
};
const TRUE_WORDS = new Set(['y', 'yes', 'true', '1', 'present']);
const FALSE_WORDS = new Set(['n', 'no', 'false', '0', 'blank', 'missing', 'absent']);

function columnMap(header) {
  const names = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const found = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    const at = names.findIndex((n) => aliases.includes(n));
    if (at >= 0) found[field] = at;
  }
  return 'address' in found ? found : null;
}

/** Whole dollars from text such as "1,250.40". Decimals are rounded and flagged. */
function parseAmount(text) {
  const cleaned = text.trim().replace(/[$,\s]/g, '');
  if (!cleaned) return { amount: null };
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { problem: `Amount "${text.trim().slice(0, 20)}" is not a number.` };
  const value = Number(cleaned);
  if (!Number.isSafeInteger(Math.round(value)) || value > 1_000_000_000_000) return { problem: 'Amount is too large.' };
  return cleaned.includes('.') ? { amount: Math.round(value), note: 'Amount rounded to whole dollars.' } : { amount: value };
}

/**
 * Args: text, CSV with or without a header row. Without one, columns are address, amount, tx hash,
 *   originator, in that order.
 * Returns: { rows, truncated, error }. Each row: { line, address, amount, txHash, originator, problems, notes }.
 *   originator is true, false, or null when the cell is empty (the policy treats it as blank).
 */
export function parseBatch(text) {
  let table;
  try {
    table = parseCsv(text);
  } catch (error) {
    return { rows: [], truncated: false, error: error.message };
  }
  if (!table.length) return { rows: [], truncated: false, error: 'Nothing to screen. Paste addresses, one per line.' };
  const mapped = columnMap(table[0]);
  const columns = mapped ?? { address: 0, amount: 1, txHash: 2, originator: 3 };
  const body = mapped ? table.slice(1) : table;
  const truncated = body.length > MAX_BATCH_ROWS;
  const rows = body.slice(0, MAX_BATCH_ROWS).map((cells, i) => {
    const line = i + (mapped ? 2 : 1);
    const get = (field) => (field in columns ? (cells[columns[field]] ?? '').trim() : '');
    const problems = [];
    const notes = [];
    const address = get('address');
    const checked = readAddress(address);
    if (checked.error) problems.push(checked.error);
    const amount = parseAmount(get('amount'));
    if (amount.problem) problems.push(amount.problem);
    if (amount.note) notes.push(amount.note);
    const txHash = get('txHash');
    if (txHash.length > MAX_ADDRESS_LENGTH || (txHash && !/^[A-Za-z0-9:._-]+$/.test(txHash))) problems.push('Transaction hash has unexpected characters or is too long.');
    const flag = get('originator').toLowerCase();
    let originator = null;
    if (flag) {
      if (TRUE_WORDS.has(flag)) originator = true;
      else if (FALSE_WORDS.has(flag)) originator = false;
      else problems.push(`Originator "${flag.slice(0, 20)}" is not yes or no.`);
    }
    return { line, address: checked.address ?? address, amount: amount.amount ?? null, txHash, originator, problems, notes };
  });
  return { rows, truncated, error: null };
}

/**
 * Screens parsed rows one after another through the workspace.
 *
 * Args: ws; rows from parseBatch; { actor, batchId, now: () => Date, onProgress }.
 * Returns: result rows { ...row, status: "ALLOW" | "HOLD" | "BLOCK" | "INVALID", receiptId, alertId, rule }.
 */
export async function runBatch(ws, rows, { actor, batchId, now, onProgress }) {
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.problems.length) {
      results.push({ ...row, status: 'INVALID', receiptId: null, alertId: null, rule: null, txId: null });
    } else {
      try {
        const { tx } = await ws.apply({
          op: 'screen', ts: now().toISOString(), actor, source: 'batch', batchId, address: row.address,
          amount: row.amount, originator: row.originator === true, txHash: row.txHash || undefined,
        });
        results.push({ ...row, status: tx.outcome, receiptId: tx.receiptId, alertId: tx.alertId, rule: tx.rule, txId: tx.id });
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        results.push({ ...row, problems: [...row.problems, error.message], status: 'INVALID', receiptId: null, alertId: null, rule: null, txId: null });
      }
    }
    if (onProgress) onProgress(i + 1, rows.length);
  }
  return results;
}

const HEADER = ['line', 'address', 'amount_usd', 'tx_hash', 'originator_present', 'result', 'policy_rule', 'receipt_id', 'alert_id', 'notes'];

/** CSV text of batch results. Cells that start like formulas are neutralised. */
export function resultsCsv(results) {
  return toCsv([HEADER, ...results.map((r) => [
    r.line, r.address, r.amount ?? '', r.txHash, r.originator === null ? '' : r.originator ? 'yes' : 'no',
    r.status, r.rule ?? '', r.receiptId ?? '', r.alertId ?? '', [...r.problems, ...r.notes].join(' '),
  ])]);
}
