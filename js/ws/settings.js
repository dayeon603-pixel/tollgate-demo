/**
 * Visitor settings: appearance, regional formats, workspace defaults and shortcuts. They live in
 * this browser only (localStorage, every access wrapped), apply as soon as they change, and are
 * read by the formatting helpers below so tables and charts follow them.
 *
 * Nothing here touches the DOM except applySettings(), so the rest is testable in Node.
 */
import { readJson, writeJson } from './persist.js';

export const SETTINGS_KEY = 'tollgate-demo-settings-v1';
export const BUILD_LABEL = 'demo';
export const ROWS_OPTIONS = ['auto', 25, 50, 100];
export const SPEED_OPTIONS = [1, 5, 20];

/** Allowed values per setting; anything else falls back to the default. */
export const CHOICES = {
  theme: ['light', 'dark', 'system'],
  density: ['comfortable', 'compact'],
  fontSize: ['s', 'm', 'l'],
  timeZone: ['utc', 'local'],
  dateFormat: ['iso', 'long'],
  numberFormat: ['us', 'eu'],
  currencyDisplay: ['symbol', 'code'],
  landing: ['dashboard', 'live', 'alerts', 'screening', 'graph', 'explorer'],
  addressDisplay: ['short', 'full'],
  copyFormat: ['plain', 'lowercase', 'quoted'],
};

export const DEFAULTS = Object.freeze({
  theme: 'dark', density: 'comfortable', fontSize: 'm', reduceMotion: false, highContrast: false,
  timeZone: 'utc', dateFormat: 'iso', numberFormat: 'us', currencyDisplay: 'symbol',
  landing: 'dashboard', rowsPerPage: 'auto', liveSpeed: 1, liveAutoStart: false, hitFlash: false, hitSound: false,
  addressDisplay: 'short', copyFormat: 'plain', singleKeyShortcuts: true,
});

const BOOLEANS = ['reduceMotion', 'highContrast', 'liveAutoStart', 'hitFlash', 'hitSound', 'singleKeyShortcuts'];
const LOCALES = { us: 'en-US', eu: 'de-DE' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

/** Returns a complete, valid settings object from untrusted input (missing or bad fields use defaults). */
export function cleanSettings(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };
  for (const [key, allowed] of Object.entries(CHOICES)) if (allowed.includes(src[key])) out[key] = src[key];
  for (const key of BOOLEANS) if (typeof src[key] === 'boolean') out[key] = src[key];
  if (ROWS_OPTIONS.includes(src.rowsPerPage)) out.rowsPerPage = src.rowsPerPage;
  if (SPEED_OPTIONS.includes(src.liveSpeed)) out.liveSpeed = src.liveSpeed;
  return out;
}

let current = { ...DEFAULTS };
let storageOk = true;
const listeners = new Set();

export const getSettings = () => current;
export const settingsStorageOk = () => storageOk;
export const subscribeSettings = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Loads from storage. `legacyTheme` (the old prefs theme) seeds the theme when nothing is saved yet. */
export function loadSettings(legacyTheme = null) {
  const saved = readJson(SETTINGS_KEY);
  current = cleanSettings(saved ?? (legacyTheme ? { theme: legacyTheme } : {}));
  return current;
}

/** Applies a partial change, saves it and tells listeners. Returns whether it was stored. */
export function setSettings(patch) {
  current = cleanSettings({ ...current, ...patch });
  storageOk = writeJson(SETTINGS_KEY, current);
  for (const fn of listeners) fn(current);
  return storageOk;
}

export function restoreDefaults() { return setSettings({ ...DEFAULTS }); }

/** Forgets every saved setting (the stored copy is emptied) and goes back to the defaults. */
export function clearSettings() {
  current = { ...DEFAULTS };
  storageOk = writeJson(SETTINGS_KEY, null);
  for (const fn of listeners) fn(current);
}

/** The theme that is actually shown. */
export function resolveTheme(settings, prefersDark) {
  return settings.theme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.theme;
}

/** Rows per page for a view whose own default is `fallback`. */
export const pageSize = (fallback) => (current.rowsPerPage === 'auto' ? fallback : current.rowsPerPage);

// ---- formatting ---------------------------------------------------------------------------

function parts(value, settings) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return settings.timeZone === 'local'
    ? { y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), hh: d.getHours(), mm: d.getMinutes(), ss: d.getSeconds() }
    : { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds() };
}

/** "2026-11-07" or "Nov 7, 2026" in the chosen time zone. Empty string for an invalid date. */
export function formatDate(value, settings = current) {
  const p = parts(value, settings);
  if (!p) return '';
  return settings.dateFormat === 'long' ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : `${p.y}-${pad(p.m + 1)}-${pad(p.d)}`;
}

/** Date and minute, "2026-11-06 10:42", in the chosen zone. */
export function formatStamp(value, settings = current) {
  const p = parts(value, settings);
  if (!p) return '';
  return `${formatDate(value, settings)} ${pad(p.hh)}:${pad(p.mm)}`;
}

/** Clock time with seconds in the chosen zone. */
export function formatClock(value, settings = current) {
  const p = parts(value, settings);
  return p ? `${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}` : '';
}

export const zoneLabel = (settings = current) => (settings.timeZone === 'local' ? 'LOCAL' : 'UTC');

/** Number with the chosen separators. */
export function formatNumber(n, settings = current, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return Number(n).toLocaleString(LOCALES[settings.numberFormat], { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Dollars as "$1,234" or "USD 1,234", with the chosen separators. */
export function formatMoney(n, settings = current, digits = 0) {
  if (n === null || n === undefined) return 'unknown';
  const body = formatNumber(n, settings, digits);
  return settings.currencyDisplay === 'code' ? `USD ${body}` : `$${body}`;
}

/** Address as shown in tables and panels. */
export function formatAddress(address, settings = current) {
  if (!address) return '';
  if (settings.addressDisplay === 'full' || address.length <= 20) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

/** What goes on the clipboard for an address. */
export function copyText(text, settings = current) {
  if (settings.copyFormat === 'lowercase') return text.toLowerCase();
  if (settings.copyFormat === 'quoted') return JSON.stringify(text);
  return text;
}

// ---- applying to the page ------------------------------------------------------------------

/** Sets the data attributes the stylesheets key on. Returns the resolved theme. */
export function applySettings(settings = current, root = document.documentElement) {
  const prefersDark = Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const theme = resolveTheme(settings, prefersDark);
  root.dataset.theme = theme;
  root.dataset.density = settings.density;
  root.dataset.fontsize = settings.fontSize;
  root.dataset.motion = settings.reduceMotion ? 'reduce' : 'auto';
  root.dataset.contrast = settings.highContrast ? 'high' : 'normal';
  return theme;
}
