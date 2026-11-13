/** Settings: appearance, regional formats, workspace defaults, keyboard, data and about. Browser only. */
import { card, clear, download, h, kv, segmented } from './dom.js';
import { BUILD_LABEL, formatDate, formatMoney, formatNumber, formatStamp, getSettings, restoreDefaults, ROWS_OPTIONS, setSettings, settingsStorageOk, SPEED_OPTIONS, clearSettings } from './settings.js';
import { WS_ROUTES } from './workspace-routes.js';

export const SHORTCUTS = [
  ['Ctrl K or Cmd K', 'Open search and commands (works anywhere in the workspace)', false],
  ['/', 'Focus the search box on the current view', true],
  ['j and k', 'Move down and up through table rows', true],
  ['Enter', 'Open the focused row or inspect the focused graph node', false],
  ['Escape', 'Close a dialog or the search', false],
];
const EXPORT_NAME = 'tollgate-demo-state.json';
const EXPORT_KIND = 'tollgate-demo-export';
const MAX_IMPORT_BYTES = 5_000_000;

const choice = (label, key, options, hint) => {
  const s = getSettings();
  return h('div', { class: 'setrow' },
    h('div', { class: 'setrow__text' }, h('span', { class: 'setrow__label', text: label }), hint ? h('span', { class: 'setrow__hint', text: hint }) : null),
    segmented({ label, value: s[key], options: options.map(([value, text]) => ({ value, label: text })), onChange: (value) => setSettings({ [key]: value }) }));
};
const toggle = (label, key, hint) => {
  const id = `set-${key}`;
  const input = h('input', { type: 'checkbox', id, checked: getSettings()[key] });
  input.addEventListener('change', () => setSettings({ [key]: input.checked }));
  return h('div', { class: 'setrow' },
    h('label', { class: 'setrow__text', for: id }, h('span', { class: 'setrow__label', text: label }), hint ? h('span', { class: 'setrow__hint', text: hint }) : null), input);
};

/** The JSON a visitor downloads: their saved op log and settings. Nothing else. */
export function buildExport(state, settings) {
  return { kind: EXPORT_KIND, version: 1, exportedAt: new Date().toISOString(), state, settings };
}

/** Parses an import. Returns { state, settings } or throws an Error with a message fit to show. */
export function parseExport(text) {
  if (text.length > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a demo export.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That file is not valid JSON.'); }
  if (!data || data.kind !== EXPORT_KIND) throw new Error('That is not a Tollgate demo export.');
  const state = data.state;
  if (state !== null && !(state && typeof state.anchor === 'string' && Array.isArray(state.ops))) throw new Error('The saved demo state in that file is not usable.');
  return { state, settings: data.settings ?? null };
}

export function renderSettings(ctx, root) {
  const s = getSettings();
  clear(root);
  const sample = Date.UTC(2026, 10, 7, 14, 5, 9);
  const landing = Object.entries(WS_ROUTES).filter(([k]) => ['dashboard', 'live', 'alerts', 'screening', 'graph', 'explorer'].includes(k)).map(([k, v]) => [k, v]);
  const msg = h('p', { class: 'field__hint', id: 'set-msg', role: 'status' });

  const importInput = h('input', { type: 'file', id: 'set-import', class: 'sr', accept: 'application/json,.json' });
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const { state, settings } = parseExport(await file.text());
      await ctx.importState(state, settings);
      msg.textContent = 'Imported. The demo now shows the state from that file.';
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      msg.textContent = error.message;
    }
  });

  root.append(...[
    settingsStorageOk() ? null : h('p', { class: 'banner', 'data-state': 'fail', role: 'alert', id: 'set-storage' }, 'This browser would not save settings. They apply until you reload.'),
    h('div', { class: 'cols' },
      h('div', { class: 'setcol' },
        card('Appearance', { id: 'set-appearance' }, h('div', { class: 'cardbody' },
          choice('Theme', 'theme', [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']], 'System follows your device and changes with it.'),
          choice('Density', 'density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], 'Compact shortens table rows.'),
          choice('Font size', 'fontSize', [['s', 'S'], ['m', 'M'], ['l', 'L']]),
          toggle('Reduce motion', 'reduceMotion', 'Overrides your device setting.'),
          toggle('High contrast', 'highContrast', 'Stronger text and borders.'))),
        card('Regional', { id: 'set-regional' }, h('div', { class: 'cardbody' },
          choice('Time zone', 'timeZone', [['utc', 'UTC'], ['local', 'Local']], 'Tables, drawers and the clock. Daily and hourly charts stay in UTC.'),
          choice('Date format', 'dateFormat', [['iso', '2026-11-07'], ['long', 'Nov 7, 2026']]),
          choice('Number format', 'numberFormat', [['us', '1,234.56'], ['eu', '1.234,56']]),
          choice('Currency display', 'currencyDisplay', [['symbol', '$'], ['code', 'USD']]),
          h('p', { class: 'field__hint', id: 'set-preview', text: `Preview: ${formatStamp(sample)} · ${formatDate(sample)} · ${formatMoney(1234567.5, s, 2)} · ${formatNumber(1234.56, s, 2)}` }))),
        card('Keyboard', { id: 'set-keys' }, h('div', { class: 'cardbody' },
          toggle('Single-key shortcuts', 'singleKeyShortcuts', 'Turns off / and j k. Ctrl or Cmd K stays on.'),
          h('ul', { class: 'keylist' }, SHORTCUTS.map(([keys, what, single]) => h('li', {}, h('kbd', { class: 'kbd', text: keys }), h('span', { text: what }), single && !s.singleKeyShortcuts ? h('span', { class: 'chip chip--neutral chip--xs', text: 'off' }) : null)))))),
      h('div', { class: 'setcol' },
        card('Workspace', { id: 'set-workspace' }, h('div', { class: 'cardbody' },
          choice('Open on', 'landing', landing, 'The view you land on when you open the app without a link.'),
          choice('Rows per page', 'rowsPerPage', ROWS_OPTIONS.map((v) => [v, v === 'auto' ? 'Auto' : String(v)])),
          choice('Live stream speed', 'liveSpeed', SPEED_OPTIONS.map((v) => [v, `${v}x`]), 'Used when the demo stream starts.'),
          toggle('Start the stream automatically', 'liveAutoStart', 'Off by default. The stream is synthetic.'),
          toggle('Connect to Ethereum mainnet automatically', 'chainAutoConnect', 'Live chain reads public data from ethereum-rpc.publicnode.com (fallback eth.drpc.org). Turn off to connect only when you press Connect.'),
          toggle('Flash on list hits', 'hitFlash', 'A brief visual flash in the status bar when the stream screens a hit.'),
          toggle('Sound on list hits', 'hitSound', 'A short tone. Off by default.'),
          choice('Address display', 'addressDisplay', [['short', 'Short'], ['full', 'Full']]),
          choice('Copy format', 'copyFormat', [['plain', 'As shown'], ['lowercase', 'Lowercase'], ['quoted', 'Quoted']], 'What the copy button puts on the clipboard for an address.'),
          h('p', { class: 'field__hint' }, 'Alert SLA targets are set on the ', h('a', { href: '#alerts', text: 'Alerts view' }), ', where they apply.'))),
        card('Data', { id: 'set-data' }, h('div', { class: 'cardbody' },
          h('div', { class: 'btnrow' },
            h('button', { type: 'button', class: 'btn', id: 'set-export', on: { click: () => { download(EXPORT_NAME, JSON.stringify(buildExport(ctx.exportState(), getSettings()), null, 2), 'application/json'); msg.textContent = `Saved ${EXPORT_NAME}.`; } } }, 'Export my demo state (JSON)'),
            h('label', { class: 'btn', for: 'set-import' }, 'Import demo state'), importInput),
          h('div', { class: 'btnrow' },
            h('button', { type: 'button', class: 'btn', id: 'set-restore', on: { click: () => { restoreDefaults(); msg.textContent = 'Settings are back to the defaults.'; } } }, 'Restore defaults'),
            h('button', { type: 'button', class: 'btn', id: 'set-clear', on: { click: () => { clearSettings(); msg.textContent = 'Saved settings cleared.'; } } }, 'Clear saved settings'),
            h('button', { type: 'button', class: 'btn', id: 'set-reset', on: { click: () => ctx.confirmReset() } }, 'Reset demo')),
          msg)),
        card('About', { id: 'set-about' }, h('div', { class: 'cardbody' },
          kv([
            ['Build', BUILD_LABEL],
            ['Stored in this browser', 'Your demo changes (a short log of actions), these settings and the demo network keys in localStorage, and Live chain records in IndexedDB, on this site only.'],
            ['Not stored anywhere else', 'No account, no analytics and no network request carries any of it.'],
          ]),
          h('p', { class: 'field__hint' }, h('a', { href: 'privacy.html', text: 'Privacy notice' }), '.')))))].filter(Boolean));
}
