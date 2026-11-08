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
import { renderLive } from './view-live.js';
import { renderGraph } from './view-graph.js';
import { renderFlow } from './view-flow.js';
import { renderValue } from './view-value.js';
import { liveReceiptView } from './view-livereceipt.js';
import { createLive } from './live.js';
import { buildStatusBar } from './statusbar.js';
import { initPalette } from './palette-ui.js';
import { Measurements } from './timecost.js';
import { cleanTargets, DEFAULT_SLA_HOURS, normalizeView, upsertView } from './triage.js';
import { WS_ROUTES } from './workspace-routes.js';
import { renderSettings } from './view-settings.js';
import { applySettings, getSettings, loadSettings, setSettings, subscribeSettings } from './settings.js';
import { hitFlash } from './hits.js';
import { renderNetwork } from './view-network.js';
import { renderArchive } from './view-archive.js';
import { renderProofGap } from './view-proofgap.js';
import { loadDemoNetwork, NET_KEYS_STORAGE, receiveInbound, registerMember, runGatePreset } from './net-flow.js';

export { WS_ROUTES };
export const LIST_URL = 'data/ofac_crypto_addresses.json';
const RENDERERS = {
  dashboard: renderDashboard, live: renderLive, alerts: renderAlerts, screening: renderScreening, monitoring: renderMonitoring, graph: renderGraph, flow: renderFlow,
  lists: renderLists, explorer: renderExplorer, evidence: renderEvidence, value: renderValue, policy: renderPolicy, activity: renderActivity, api: renderApi, settings: renderSettings,
  network: renderNetwork, archive: renderArchive, proofgap: renderProofGap,
};
const TOAST_MS = 6000;
const RESET_CONFIRM_MS = 5000;
const $ = (id) => document.getElementById(id);

export async function initWorkspace({ openInVerifier }) {
  const roots = Object.fromEntries(Object.keys(WS_ROUTES).map((route) => [route, $(`ws-view-${route}`)]));
  const prefs = { user: 'analyst-a', views: [], sla: { ...DEFAULT_SLA_HOURS }, ...(readJson(PREFS_KEY) ?? {}) };
  prefs.views = (Array.isArray(prefs.views) ? prefs.views : []).map(normalizeView).filter(Boolean);
  prefs.sla = cleanTargets(prefs.sla);
  const measure = new Measurements();
  let live = null;
  let statusUpdate = () => {};
  let ws = null;
  let anchor = null;
  let route = null;
  let listMeta = null;
  let listJson = null;
  let network = null;
  let ready = false;
  const params = {};
  let drawerStack = [];
  let storageWarned = false;

  const savePrefs = () => writeJson(PREFS_KEY, prefs);
  // Theme and the other appearance choices live in settings.js, the single source for them.
  loadSettings(prefs.theme ?? null);
  const applyTheme = () => applySettings(getSettings());
  applyTheme();
  subscribeSettings(() => { applyTheme(); if (ready) { drawBar(); ctx.refresh(); } });

  // ---- messages --------------------------------------------------------------------------
  const toastBox = h('div', { id: 'ws-toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
  const alertBox = h('div', { id: 'ws-alert', class: 'toast toast--bad', role: 'alert' });
  document.body.append(toastBox, alertBox);
  let toastTimer = null;
  const toast = (message, kind = 'ok') => {
    const box = kind === 'bad' ? alertBox : toastBox;
    // An open drawer sits in the top layer, above everything else, so the message goes inside it.
    const host = dlg.open ? dlg : document.body;
    if (box.parentNode !== host) host.append(box);
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
    dlgBody.scrollTop = 0;
  };
  dlgBack.addEventListener('click', () => { drawerStack.pop(); drawCurrent(); });
  $('ws-drawer-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { drawerStack = []; });
  dlg.addEventListener('click', (event) => { if (event.target === dlg) dlg.close(); });

  // ---- context ---------------------------------------------------------------------------
  const ctx = {
    get ws() { return ws; },
    get live() { return live; },
    measure,
    intent: null,
    get sla() { return prefs.sla; },
    setSla(targets) { prefs.sla = cleanTargets(targets); savePrefs(); },
    get views() { return prefs.views; },
    saveView(view) { prefs.views = upsertView(prefs.views, view); savePrefs(); },
    deleteView(name) { prefs.views = prefs.views.filter((v) => v.name !== name); savePrefs(); },
    openLive: (record) => openDrawer({ title: `Stream receipt ${record.receiptId.replace('rcpt:', '')}`, build: () => liveReceiptView(ctx, record) }, { push: dlg.open && drawerStack.length > 0 }),
    get userId() { return prefs.user; },
    get listMeta() { return listMeta; },
    get network() { return network; },
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
    openAlert: (id, intent = null) => { ctx.intent = intent ? { id, ...intent } : null; return openDrawer({ title: `Alert ${id}`, build: () => caseView(ctx, id) }, { push: dlg.open && drawerStack.length > 0 }); },
    openReceipt: (id) => openDrawer({ title: `Receipt ${id.replace('rcpt:', '')}`, build: () => receiptView(ctx, id) }, { push: dlg.open && drawerStack.length > 0 }),
    persist() {
      if (!writeJson(STATE_KEY, snapshot(ws, anchor)) && !storageWarned) {
        storageWarned = true;
        toast('This browser would not save your changes. They will be lost when you reload.', 'bad');
      }
    },
    /**
     * Receives an inbound payment with a receipt (see net-flow.js), saves, redraws.
     * Returns { ok, result, record, screen } or { ok: false, error }.
     */
    async receive(spec, { refresh = true } = {}) {
      try {
        const out = await receiveInbound(ws, network, { actor: prefs.user, ts: new Date().toISOString(), ...spec });
        ctx.persist();
        if (refresh) ctx.refresh(); else ctx.refreshChrome();
        return { ok: true, ...out };
      } catch (error) {
        if (!(error instanceof WorkspaceError) && !(error instanceof RangeError)) throw error;
        toast(error.message, 'bad');
        return { ok: false, error };
      }
    },
    /** Runs one gate preset (net-flow.js GATE_PRESETS). */
    async gate(id, { refresh = true } = {}) {
      try {
        const out = await runGatePreset(ws, id, { actor: prefs.user, now: new Date() });
        if (out.unavailable) { toast(out.unavailable, 'bad'); return { ok: false, unavailable: out.unavailable }; }
        ctx.persist();
        if (refresh) ctx.refresh(); else ctx.refreshChrome();
        return { ok: true, ...out };
      } catch (error) {
        if (!(error instanceof WorkspaceError)) throw error;
        toast(error.message, 'bad');
        return { ok: false, error };
      }
    },
    /** Adds a demo member with a new Ed25519 key, registers it and pins it. */
    async addMember() {
      try {
        const extra = network.members.length - 5;
        const member = await network.addMember(`Demo Exchange ${String.fromCharCode(69 + extra)}`);
        writeJson(NET_KEYS_STORAGE, network.serial());
        await registerMember(ws, member, { actor: prefs.user, ts: new Date().toISOString(), pin: false });
        ctx.persist();
        ctx.refresh();
        return { ok: true, member };
      } catch (error) {
        if (!(error instanceof WorkspaceError) && !(error instanceof RangeError)) throw error;
        toast(error.message, 'bad');
        return { ok: false, error };
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
    refreshChrome: () => { drawBar(); statusUpdate(); },
    /** The saved op log, as the browser holds it, for the settings export. */
    exportState: () => readJson(STATE_KEY) ?? snapshot(ws, anchor),
    async importState(state, settings) {
      if (state) writeJson(STATE_KEY, state); else removeKey(STATE_KEY);
      if (settings) setSettings(settings);
      dlg.close();
      ready = false;
      await boot();
    },
    confirmReset: () => { if (!resetArmed) { resetArmed = true; drawBar(); toast('Press Reset demo again within a few seconds to erase your changes.'); clearTimeout(resetTimer); resetTimer = setTimeout(() => { resetArmed = false; drawBar(); }, RESET_CONFIRM_MS); } },
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
    const themeButton = h('button', { type: 'button', class: 'iconbtn', id: 'ws-theme', 'aria-label': theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', title: 'Theme', on: { click: () => toggleTheme() } }, icon(theme === 'dark' ? 'sun' : 'moon'));
    const gear = h('a', { class: 'iconbtn', id: 'ws-settings', href: '#settings', 'aria-label': 'Settings', title: 'Settings' }, icon('gear'));
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
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'ws-palette-open', 'aria-keyshortcuts': 'Control+K Meta+K', on: { click: () => palette.open() } }, icon('search'), 'Search', h('kbd', { class: 'kbd', text: navigator.platform?.includes('Mac') ? '\u2318K' : 'Ctrl K' })),
        h('label', { class: 'wsbar__user' }, h('span', { text: 'Acting as' }), userSelect), themeButton, gear, reset));
  }

  async function resetDemo() {
    removeKey(STATE_KEY);
    removeKey(NET_KEYS_STORAGE);
    dlg.close();
    ready = false;
    await boot();
    toast('Demo reset. Your changes were erased and the sample history was rebuilt.');
  }

  // ---- status bar and command palette ----------------------------------------------------
  statusUpdate = buildStatusBar(ctx, $('ws-status'));
  function toggleTheme() { setSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }); }
  const palette = initPalette(ctx, {
    actions: [
      { id: 'theme', title: 'Switch between dark and light theme', keywords: 'theme dark light' },
      { id: 'stream', title: 'Start or pause the demo stream', keywords: 'live stream start pause resume synthetic' },
      { id: 'stream-stop', title: 'Stop the demo stream', keywords: 'live stream stop off' },
    ],
    run(action) {
      if (action === 'theme') toggleTheme();
      else if (action === 'stream' && live) { if (live.runner.state === 'live') live.runner.pause(); else live.runner.start(); }
      else if (action === 'stream-stop' && live) live.runner.stop();
    },
  });

  // ---- boot ------------------------------------------------------------------------------
  function show(target) {
    route = target;
    if (live) live.view = null;
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
      const loaded = await loadDemoNetwork(readJson(NET_KEYS_STORAGE));
      network = loaded.network;
      writeJson(NET_KEYS_STORAGE, loaded.serial);
      const built = await createWorkspace({ list: listJson, anchor, savedOps: usable ? saved.ops : [], network });
      ws = built.ws;
      ready = true;
      live?.dispose();
      live = createLive(ctx);
      live.bar = statusUpdate;
      live.runner.setSpeed(getSettings().liveSpeed);
      live.onHits = (records) => hitFlash(records, getSettings());
      if (getSettings().liveAutoStart) live.runner.start();
      ctx.persist();
      if (built.replayError && usable) toast('Your saved changes could not be restored, so the demo started fresh.', 'bad');
    } catch (error) {
      ready = false;
      const message = error instanceof Error ? error.message : 'The workspace could not start.';
      for (const root of Object.values(roots)) clear(root).append(h('div', { class: 'banner', 'data-state': 'unsupported', role: 'alert' }, h('span', { class: 'banner__lead', text: 'The workspace could not start' }), h('span', { class: 'banner__detail', text: message })));
      return;
    }
    drawBar();
    statusUpdate();
    if (route) show(route);
  }

  // ---- keyboard --------------------------------------------------------------------------
  document.addEventListener('keydown', (event) => {
    if (!route || !ready || dlg.open || event.metaKey || event.ctrlKey || event.altKey || !getSettings().singleKeyShortcuts) return;
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
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (getSettings().theme === 'system') { applyTheme(); drawBar(); } });

  const startup = boot();
  return { show, ready: startup };
}
