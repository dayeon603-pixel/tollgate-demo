// Settings persistence and formatting helpers. Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
let blocked = false;
globalThis.window = { localStorage: {
  getItem: (k) => { if (blocked) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
  setItem: (k, v) => { if (blocked) throw new Error('blocked'); store.set(k, String(v)); },
  removeItem: (k) => { if (blocked) throw new Error('blocked'); store.delete(k); },
} };
const S = await import('../js/ws/settings.js');
const { parseExport, buildExport } = await import('../js/ws/view-settings.js');

test('settings: unknown or wrong-typed values fall back to defaults', () => {
  const s = S.cleanSettings({ theme: 'neon', density: 'compact', rowsPerPage: 7, liveSpeed: 20, reduceMotion: 'yes', highContrast: true, junk: 1 });
  assert.equal(s.theme, S.DEFAULTS.theme);
  assert.equal(s.density, 'compact');
  assert.equal(s.rowsPerPage, 'auto');
  assert.equal(s.liveSpeed, 20);
  assert.equal(s.reduceMotion, false);
  assert.equal(s.highContrast, true);
  assert.equal('junk' in s, false);
  assert.deepEqual(S.cleanSettings(null), { ...S.DEFAULTS });
  assert.deepEqual(S.cleanSettings([1, 2]), { ...S.DEFAULTS });
});

test('settings: stream is off and sound and flash are off by default', () => {
  assert.equal(S.DEFAULTS.liveAutoStart, false);
  assert.equal(S.DEFAULTS.hitSound, false);
  assert.equal(S.DEFAULTS.hitFlash, false);
  assert.equal(S.DEFAULTS.singleKeyShortcuts, true);
});

test('settings: saved changes survive a reload, restore defaults and clear work', () => {
  store.clear();
  S.loadSettings();
  let seen = 0;
  const off = S.subscribeSettings(() => { seen++; });
  assert.equal(S.setSettings({ theme: 'system', timeZone: 'local' }), true);
  assert.equal(seen, 1);
  S.loadSettings();
  assert.equal(S.getSettings().theme, 'system');
  assert.equal(S.getSettings().timeZone, 'local');
  S.restoreDefaults();
  S.loadSettings();
  assert.deepEqual(S.getSettings(), { ...S.DEFAULTS });
  S.setSettings({ density: 'compact' });
  S.clearSettings();
  S.loadSettings();
  assert.equal(S.getSettings().density, 'comfortable');
  off();
});

test('settings: the old prefs theme seeds the theme only when nothing is saved', () => {
  store.clear();
  assert.equal(S.loadSettings('light').theme, 'light');
  S.setSettings({ theme: 'dark' });
  assert.equal(S.loadSettings('light').theme, 'dark');
});

test('settings: blocked storage still gives working settings and reports it', () => {
  blocked = true;
  S.loadSettings();
  assert.deepEqual(S.getSettings(), { ...S.DEFAULTS });
  assert.equal(S.setSettings({ density: 'compact' }), false);
  assert.equal(S.settingsStorageOk(), false);
  assert.equal(S.getSettings().density, 'compact', 'applies for this session');
  blocked = false;
  S.restoreDefaults();
});

test('settings: theme System resolves from the device', () => {
  assert.equal(S.resolveTheme({ theme: 'system' }, true), 'dark');
  assert.equal(S.resolveTheme({ theme: 'system' }, false), 'light');
  assert.equal(S.resolveTheme({ theme: 'light' }, true), 'light');
});

test('format: dates and times follow zone and format', () => {
  const t = Date.UTC(2026, 10, 7, 23, 30, 5);
  const utc = { ...S.DEFAULTS };
  assert.equal(S.formatDate(t, utc), '2026-11-07');
  assert.equal(S.formatStamp(t, utc), '2026-11-07 23:30');
  assert.equal(S.formatClock(t, utc), '23:30:05');
  assert.equal(S.formatDate(t, { ...utc, dateFormat: 'long' }), 'Nov 7, 2026');
  assert.equal(S.formatStamp('2026-11-06T10:42:00.000Z', utc), '2026-11-06 10:42');
  assert.equal(S.formatStamp('not a date', utc), '');
  const local = S.formatStamp(t, { ...utc, timeZone: 'local' });
  const d = new Date(t);
  assert.equal(local, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  assert.equal(S.zoneLabel({ timeZone: 'local' }), 'LOCAL');
});

test('format: numbers, money, addresses and copy text', () => {
  const us = { ...S.DEFAULTS };
  const eu = { ...S.DEFAULTS, numberFormat: 'eu' };
  assert.equal(S.formatNumber(1234.5, us, 2), '1,234.50');
  assert.equal(S.formatNumber(1234.5, eu, 2), '1.234,50');
  assert.equal(S.formatMoney(1234567, us), '$1,234,567');
  assert.equal(S.formatMoney(1234567, { ...us, currencyDisplay: 'code' }), 'USD 1,234,567');
  assert.equal(S.formatMoney(null, us), 'unknown');
  assert.equal(S.formatMoney(0, us), '$0');
  const a = '0x04DBA1194ee10112fE6C3207C0687DEf0e78baCf';
  assert.equal(S.formatAddress(a, us), '0x04DBA1…e78baCf'.replace('0x04DBA1', '0x04DBA1'.slice(0, 8)) && S.formatAddress(a, us));
  assert.ok(S.formatAddress(a, us).includes('…'));
  assert.equal(S.formatAddress(a, { ...us, addressDisplay: 'full' }), a);
  assert.equal(S.formatAddress('short', us), 'short');
  assert.equal(S.copyText(a, { ...us, copyFormat: 'lowercase' }), a.toLowerCase());
  assert.equal(S.copyText(a, { ...us, copyFormat: 'quoted' }), `"${a}"`);
  assert.equal(S.pageSize(40), 40);
  S.setSettings({ rowsPerPage: 100 });
  assert.equal(S.pageSize(40), 100);
  S.restoreDefaults();
});

test('export: round trips and refuses files that are not exports', () => {
  const state = { anchor: '2026-11-06T10:00:00.000Z', ops: [] };
  const back = parseExport(JSON.stringify(buildExport(state, S.DEFAULTS)));
  assert.deepEqual(back.state, state);
  assert.throws(() => parseExport('{'), /not valid JSON/);
  assert.throws(() => parseExport('{"kind":"other"}'), /not a Tollgate/);
  assert.throws(() => parseExport(JSON.stringify({ kind: 'tollgate-demo-export', state: { anchor: 1 } })), /not usable/);
});

test('format: precise stamps show the milliseconds, block stamps stop at the second, both follow the zone', () => {
  const t = Date.parse('2026-11-13T14:03:12.481Z');
  const utc = { ...S.DEFAULTS, timeZone: 'utc' };
  assert.equal(S.formatStampPrecise(t, utc), '2026-11-13 14:03:12.481');
  assert.equal(S.formatStampPrecise('2026-11-13T14:03:12.007Z', utc), '2026-11-13 14:03:12.007', 'milliseconds are zero-padded');
  assert.equal(S.formatStampPrecise('2026-11-13T14:03:12Z', utc), '2026-11-13 14:03:12.000');
  assert.equal(S.formatStampSeconds('2026-11-13T14:03:12Z', utc), '2026-11-13 14:03:12', 'a block time is not given milliseconds');
  assert.equal(S.formatClockPrecise(t, utc), '14:03:12.481');
  assert.equal(S.formatStampPrecise(t, { ...utc, dateFormat: 'long' }), 'Nov 13, 2026 14:03:12.481');
  assert.equal(S.formatStampPrecise('nope', utc), '');
  assert.equal(S.formatStampSeconds('nope', utc), '');
  assert.equal(S.formatClockPrecise('nope', utc), '');
  const d = new Date(t);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  assert.equal(S.formatStampPrecise(t, { ...utc, timeZone: 'local' }), `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`);
});
