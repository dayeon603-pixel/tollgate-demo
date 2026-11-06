/**
 * Small pure helpers shared by the workspace modules: a seeded random generator (so the demo
 * data is the same every time for the same start date), date helpers and CSV text handling.
 */

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** Seeded generator (mulberry32). Returns a function giving floats in [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] from a generator. */
export function between(rand, lo, hi) {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

export function pick(rand, items) {
  return items[Math.floor(rand() * items.length)];
}

/** Fisher-Yates on a copy. */
export function shuffled(rand, items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** "2026-11-06" in UTC. */
export function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

export function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const HEX = '0123456789abcdef';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Synthetic Ethereum-shaped address. Random, so it is not tied to any real wallet. */
export function fakeEthAddress(rand) {
  let out = '0x';
  for (let i = 0; i < 40; i++) out += HEX[Math.floor(rand() * 16)];
  return out;
}

/** Synthetic Tron-shaped address. */
export function fakeTronAddress(rand) {
  let out = 'T';
  for (let i = 0; i < 33; i++) out += BASE58[Math.floor(rand() * BASE58.length)];
  return out;
}

/** Characters that make a spreadsheet read a cell as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell, quoted when needed, with formula starts neutralised for spreadsheet programs. */
export function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/**
 * Parses CSV text (RFC 4180 quoting, comma or tab separated) into rows of strings.
 * Blank lines are skipped. Raises Error on an unterminated quote.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const body = text.replace(/^﻿/, '');
  const delimiter = body.split('\n', 1)[0].includes('\t') && !body.split('\n', 1)[0].includes(',') ? '\t' : ',';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell); cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (quoted) throw new Error('A quoted value is not closed. Check the quotes in the CSV.');
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

/** Escapes text for use inside generated HTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
