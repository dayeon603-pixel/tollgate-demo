/**
 * Workspace controller: loads the list, builds (or restores) the demo workspace, owns the shared
 * chrome (acting-as user, theme, reset, drawer, messages) and renders the view for a route.
 *
 * Everything runs in this browser. State is the seeded synthetic history plus the visitor's own
 * actions, which are saved to localStorage as a short op log (see persist.js).
 */
import { signingAvailable } from '../workbench.js';
import { clear, h, icon, select } from './dom.js';
import { WorkspaceError } from './engine.js';
import { PREFS_KEY, readJson, removeKey, SCHEMA, STATE_KEY, writeJson } from './persist.js';
import { createWorkspace, snapshot } from './session.js';
import { isOpenWork } from './engine.js';
import { renderDashboard } from './view-dashboard.js';
import { caseView, renderAlerts } from './view-alerts.js';
import { renderScreening } from './view-screening.js';
import { renderLists, renderMonitoring } from './view-lists.js';
import { receiptView, renderActivity, renderExplorer } from './view-receipts.js';
import { renderEvidence } from './view-evidence.js';
import { renderApi, renderPolicy } from './view-admin.js';

export const LIST_URL = 'data/ofac_crypto_addresses.json';
export const WS_ROUTES = {
  dashboard: 'Dashboard', alerts: 'Alerts', screening: 'Screening', monitoring: 'Monitoring', lists: 'Lists',
  explorer: 'Receipt explorer', evidence: 'Evidence packs', policy: 'Policy and roles', activity: 'Activity log', api: 'API examples',
};
const RENDERERS = {
  dashboard: renderDashboard, alerts: renderAlerts, screening: renderScreening, monitoring: renderMonitoring, lists: renderLists,
  explorer: renderExplorer, evidence: renderEvidence, policy: renderPolicy, activity: renderActivity, api: renderApi,
};
const TOAST_MS = 6000;
const RESET_CONFIRM_MS = 5000;
const $ = (id) => document.getElementById(id);

export async function initWorkspace({ openInVerifier }) {
  const roots = Object.fromEntries(Object.keys(WS_ROUTES).map((route) => [route, $(`ws-view-${route}`)]));
  const prefs = { user: 'analyst-a', theme: null, ...(readJson(PREFS_KEY) ?? {}) };
  let ws = null;
  let anchor = null;
  let route = null;
  let listMeta = null;
  let listJson = null;
  let ready = false;
  const params = {};
  let drawerStack = [];
  let storageWarned = false;

  const savePrefs = () => writeJson(PREFS_KEY, prefs);
  const applyTheme = () => {
    const theme = prefs.theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = theme;
    return theme;
  };
  applyTheme();

  // ---- messages --------------------------------------------------------------------------
  const toastBox = h('div', { id: 'ws-toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
  const alertBox = h('div', { id: 'ws-alert', class: 'toast toast--bad', role: 'alert' });
  document.body.append(toastBox, alertBox);
  let toastTimer = null;
  const toast = (message, kind = 'ok') => {
    const box = kind === 'bad' ? alertBox : toastBox;
    box.textContent = message;
    box.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastBox.dataset.show = 'false'; alertBox.dataset.show = 'false'; }, TOAST_MS);
  };

  // ---- drawer ----------------------------------------------------------------------------
  const dlg = $('ws-drawer');
  const dlgTitle = $('ws-drawer-title');
  const dlgBody = $('ws-drawer-body');
  const dlgBack = $('ws-drawer-back');
  const drawCurrent = () => {
    const top = drawerStack.at(-1);
    if (!top) return;
    const scroll = dlgBody.scrollTop;
    dlgTitle.textContent = top.title;
    clear(dlgBody).append(top.build());
    dlgBack.hidden = drawerStack.length < 2;
    dlgBody.scrollTop = scroll;
    if (!dlg.open) dlg.showModal();
  };
  const openDrawer = (entry, { push = false } = {}) => {
    drawerStack = push ? [...drawerStack, entry] : [entry];
    drawCurrent();
    if (!push) dlgBody.scrollTop = 0;
  };
  dlgBack.addEventListener('click', () => { drawerStack.pop(); drawCurrent(); });
  $('ws-drawer-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { drawerStack = []; });
  dlg.addEventListener('click', (event) => { if (event.target === dlg) dlg.close(); });

  // ---- context ---------------------------------------------------------------------------
  const ctx = {
    get ws() { return ws; },
    get userId() { return prefs.user; },
    get listMeta() { return listMeta; },
    now: () => new Date(),
    toast,
    openInVerifier: (text) => { dlg.close(); openInVerifier(text, 'Demo', 'yours'); },
    setParams: (r, p) => { params[r] = p; },
    takeParams: (r) => { const p = params[r] ?? {}; delete params[r]; return p; },
    go(target, p = {}) {
      if (dlg.open) dlg.close();
      params[target] = p;
      if (location.hash.slice(1) === target) show(target);
      else location.hash = target;
    },
    openAlert: (id) => openDrawer({ title: `Alert ${id}`, build: () => caseView(ctx, id) }, { push: dlg.open && drawerStack.length > 0 }),
    openReceipt: (id) => openDrawer({ title: `Receipt ${id.replace('rcpt:', '')}`, build: () => receiptView(ctx, id) }, { push: dlg.open && drawerStack.length > 0 }),
    persist() {
      if (!writeJson(STATE_KEY, snapshot(ws, anchor)) && !storageWarned) {
        storageWarned = true;
        toast('This browser would not save your changes. They will be lost when you reload.', 'bad');
      }
    },
    async run(partial, { quiet = false, refresh = true } = {}) {
      const op = { ts: new Date().toISOString(), ...partial };
      try {
        const result = await ws.apply(op);
        ctx.persist();
        if (refresh) ctx.refresh();
        else ctx.refreshChrome();
        return { ok: true, result };
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        if (!quiet) toast(error.message, 'bad');
        return { ok: false, error };
      }
    },
    refresh() {
      ctx.refreshChrome();
      if (route && ready) {
        const scroll = window.scrollY;
        const active = document.activeElement?.id;
        RENDERERS[route](ctx, roots[route]);
        if (active) $(active)?.focus({ preventScroll: true });
        window.scrollTo({ top: scroll });
      }
      if (dlg.open) drawCurrent();
    },
    refreshChrome: () => drawBar(),
  };

  // ---- chrome ----------------------------------------------------------------------------
  const bar = $('ws-bar');
  let resetArmed = false;
  let resetTimer = null;
  function drawBar() {
    if (!ws) return;
    const open = ws.alerts.filter(isOpenWork).length;
    const badge = $('ws-nav-alerts');
    badge.textContent = open ? String(open) : '';
    badge.setAttribute('aria-label', `${open} open alerts`);
    const userSelect = select('ws-user', ws.users.map((u) => ({ value: u.id, label: `${u.name} (${u.role})` })), prefs.user, (value) => { prefs.user = value; savePrefs(); ctx.refresh(); });
    userSelect.classList.add('select--bar');
    const theme = document.documentElement.dataset.theme;
    const themeButton = h('button', { type: 'button', class: 'iconbtn', 'aria-label': theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', title: 'Theme', on: { click: () => { prefs.theme = theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); drawBar(); } } }, icon(theme === 'dark' ? 'sun' : 'moon'));
    const reset = h('button', { type: 'button', class: 'btn', on: { click: () => {
      if (!resetArmed) {
        resetArmed = true;
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => { resetArmed = false; drawBar(); }, RESET_CONFIRM_MS);
        drawBar();
        $('ws-reset')?.focus();
        return;
      }
      resetArmed = false;
      void resetDemo();
    } }, id: 'ws-reset' }, resetArmed ? 'Confirm: erase my changes' : 'Reset demo');
    const version = ws.inForce;
    clear(bar).append(
      h('p', { class: 'wsbar__demo' }, h('span', { class: 'demo-badge__dot', 'aria-hidden': 'true' }), h('strong', { text: 'Demo workspace' }), ' Synthetic payments and people. Real list, real receipts.'),
      h('div', { class: 'wsbar__right' },
        h('span', { class: 'wsbar__list', title: `Digest ${version.digest}` }, `List in force: ${version.label}`, ws.pendingVersion ? h('a', { href: '#lists', class: 'wsbar__update', text: 'update available' }) : null),
        h('label', { class: 'wsbar__user' }, h('span', { text: 'Acting as' }), userSelect), themeButton, reset));
  }

  async function resetDemo() {
    removeKey(STATE_KEY);
    dlg.close();
    ready = false;
    await boot();
    toast('Demo reset. Your changes were erased and the sample history was rebuilt.');
  }

  // ---- boot ------------------------------------------------------------------------------
  function show(target) {
    route = target;
    if (!ready) {
      for (const [name, root] of Object.entries(roots)) if (name === target) clear(root).append(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton__row' }), h('div', { class: 'skeleton__row' }), h('div', { class: 'skeleton__row' })));
      return;
    }
    RENDERERS[target](ctx, roots[target]);
  }

  async function boot() {
    const saved = readJson(STATE_KEY);
    const usable = saved && saved.schema === SCHEMA && typeof saved.anchor === 'string' && !Number.isNaN(Date.parse(saved.anchor)) && Array.isArray(saved.ops);
    anchor = usable ? new Date(saved.anchor) : new Date();
    try {
      if (!(await signingAvailable())) throw new Error('This browser cannot sign with Ed25519, which the workspace needs. Try a current Chrome, Edge, Safari or Firefox.');
      if (!listJson) {
        const response = await fetch(LIST_URL);
        if (!response.ok) throw new Error(`The list file returned ${response.status}.`);
        listJson = await response.json();
        const { entries, ...meta } = listJson;
        listMeta = meta;
        void entries;
      }
      const built = await createWorkspace({ list: listJson, anchor, savedOps: usable ? saved.ops : [] });
      ws = built.ws;
      ready = true;
      ctx.persist();
      if (built.replayError && usable) toast('Your saved changes could not be restored, so the demo started fresh.', 'bad');
    } catch (error) {
      ready = false;
      const message = error instanceof Error ? error.message : 'The workspace could not start.';
      for (const root of Object.values(roots)) clear(root).append(h('div', { class: 'banner', 'data-state': 'unsupported', role: 'alert' }, h('span', { class: 'banner__lead', text: 'The workspace could not start' }), h('span', { class: 'banner__detail', text: message })));
      return;
    }
    drawBar();
    if (route) show(route);
  }

  // ---- keyboard --------------------------------------------------------------------------
  document.addEventListener('keydown', (event) => {
    if (!route || !ready || dlg.open || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    const root = roots[route];
    if (event.key === '/') {
      const search = root.querySelector('[data-search]');
      if (search) { event.preventDefault(); search.focus(); }
    } else if (event.key === 'j' || event.key === 'k') {
      const rows = Array.from(root.querySelectorAll('[data-rownav]'));
      if (!rows.length) return;
      const at = rows.indexOf(document.activeElement);
      const next = event.key === 'j' ? Math.min(rows.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
      rows[next].focus();
    }
  });
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!prefs.theme) { applyTheme(); drawBar(); } });

  const startup = boot();
  return { show, ready: startup };
}
