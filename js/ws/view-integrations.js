/**
 * Integrations: API keys with scopes, webhooks with their signed deliveries, usage metered per
 * screened transaction, and an API console that sends requests to the in-browser API (api.js).
 *
 * Key and webhook changes are ops, so each is a signed receipt in the ledger. Only a key's SHA-256
 * is saved; the secret is shown once. Nothing here reaches a network: webhook deliveries are built
 * and signed but not sent, which the view says.
 */
import { card, clear, copyButton, dataTable, download, empty, field, h, kv, mono, select, stamp, zoneName } from './dom.js';
import { API_SCOPES, WEBHOOK_EVENTS, handleApiRequest, newApiKey, newWebhookSecret, usageCsv, usageReport, webhookDeliveries } from './api.js';
import { MAX_KEY_NAME_CHARS, MAX_WEBHOOK_URL_CHARS, WorkspaceError } from './engine.js';

const SCOPE_HINTS = { screen: 'POST /v1/screen', read: 'GET receipts and usage', webhooks: 'GET /v1/webhooks' };
const EVENT_HINTS = {
  'decision.created': 'Every signed screening decision',
  'list.changed': 'A new list version was applied',
  'address.newly_listed': 'An address screened earlier is on the new list',
};
const KIND_LABELS = { api_key: 'API key', console: 'Console user', demo_feed: 'Demo feed (synthetic)' };
/** Per-view state kept across redraws: the secret just created (shown once), console inputs, usage filter. */
const st = { revealed: null, hookOpen: null, console: null, usage: null, response: null };

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function checks(idPrefix, values, hints, chosen) {
  return h('div', { class: 'cardbody' }, values.map((v) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', id: `${idPrefix}-${v.replace('.', '-')}`, value: v, checked: chosen.includes(v) }),
    h('span', { text: `${v}` }), h('span', { class: 'muted', text: ` (${hints[v]})` }))));
}

const picked = (box) => [...box.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);

function secretBanner(title, secret, detail) {
  return h('div', { class: 'banner', 'data-state': 'caveat', role: 'status', id: 'in-secret' },
    h('span', { class: 'banner__lead', text: title }),
    h('span', { class: 'banner__detail' }, mono(secret), ' ', copyButton(secret, 'secret'), h('span', { text: ` ${detail}` })));
}

function keysCard(ctx) {
  const { ws } = ctx;
  const isAdmin = ws.can(ctx.userId, 'integrations');
  const name = h('input', { id: 'in-key-name', class: 'input', type: 'text', maxlength: MAX_KEY_NAME_CHARS, autocomplete: 'off', placeholder: 'For example: withdrawals service', disabled: !isAdmin });
  const scopes = checks('in-scope', API_SCOPES, SCOPE_HINTS, ['screen', 'read']);
  const error = h('p', { class: 'field__hint field__hint--bad', role: 'alert', id: 'in-key-error' });
  const create = h('button', { type: 'button', class: 'btn btn--primary', id: 'in-key-create', disabled: !isAdmin, on: { click: async () => {
    error.textContent = '';
    const key = await newApiKey();
    const out = await ctx.run({ op: 'apiKeyCreate', actor: ctx.userId, keyId: key.keyId, name: name.value, scopes: picked(scopes), keyHash: key.hash, prefix: key.prefix }, { quiet: true, refresh: false });
    if (!out.ok) { error.textContent = out.error.message; return; }
    st.revealed = { kind: 'key', id: key.keyId, secret: key.secret };
    st.console = { ...(st.console ?? {}), key: key.secret };
    ctx.refresh();
  } } }, 'Create key');
  const rows = [...ws.apiKeys].reverse();
  return card('API keys', { id: 'in-keys', sub: 'Each key is shown once. Only its SHA-256 is kept. Creating and revoking a key are signed receipts.' },
    st.revealed?.kind === 'key' ? secretBanner('Copy this key now.', st.revealed.secret, 'It is not shown again. Anyone holding it can call the API with its scopes.') : null,
    isAdmin ? null : h('p', { class: 'demo-line', id: 'in-readonly', text: `Read-only for ${ws.user(ctx.userId)?.name ?? 'this user'}. Switch to Admin D to create or revoke keys and webhooks.` }),
    h('div', { class: 'cardbody' }, field('Name', name), field('Scopes', scopes), error, h('div', { class: 'btnrow' }, create)),
    dataTable({
      caption: 'API keys', rows, rowKey: (k) => k.id,
      empty: empty('No API keys yet.', 'Create one to call POST /v1/screen from the console below.'),
      cols: [
        { label: 'Name', render: (k) => k.name },
        { label: 'Key', render: (k) => mono(`${k.prefix}...`) },
        { label: 'Scopes', render: (k) => k.scopes.join(', ') },
        { label: `Created (${zoneName()})`, render: (k) => stamp(k.createdAt) },
        { label: 'Status', render: (k) => (k.revokedAt ? `Revoked ${stamp(k.revokedAt)}` : 'Active') },
        { label: '', render: (k) => (k.revokedAt || !isAdmin ? '' : h('button', { type: 'button', class: 'btn', 'data-revoke': k.id, on: { click: async () => {
          const out = await ctx.run({ op: 'apiKeyRevoke', actor: ctx.userId, keyId: k.id });
          if (out.ok && st.revealed?.id === k.id) st.revealed = null;
        } } }, 'Revoke')) },
      ],
    }));
}

function webhooksCard(ctx, deliveriesHost) {
  const { ws } = ctx;
  const isAdmin = ws.can(ctx.userId, 'integrations');
  const url = h('input', { id: 'in-hook-url', class: 'input mono', type: 'url', maxlength: MAX_WEBHOOK_URL_CHARS, autocomplete: 'off', placeholder: 'https://your-system.example/tollgate', disabled: !isAdmin });
  const events = checks('in-ev', WEBHOOK_EVENTS, EVENT_HINTS, ['address.newly_listed', 'list.changed']);
  const error = h('p', { class: 'field__hint field__hint--bad', role: 'alert', id: 'in-hook-error' });
  const add = h('button', { type: 'button', class: 'btn btn--primary', id: 'in-hook-add', disabled: !isAdmin, on: { click: async () => {
    error.textContent = '';
    const { hookId, secret } = newWebhookSecret();
    const out = await ctx.run({ op: 'webhookAdd', actor: ctx.userId, hookId, url: url.value, events: picked(events), secret }, { quiet: true, refresh: false });
    if (!out.ok) { error.textContent = out.error.message; return; }
    st.revealed = { kind: 'hook', id: hookId, secret };
    st.hookOpen = hookId;
    ctx.refresh();
  } } }, 'Add webhook');
  const rows = [...ws.webhooks].reverse();
  return card('Webhooks', { id: 'in-hooks', sub: 'Signed with HMAC-SHA256 in the Tollgate-Signature header, the same format as the self-hosted kit. This demo has no server, so it builds and signs each delivery and does not send it.' },
    st.revealed?.kind === 'hook' ? secretBanner('Signing secret.', st.revealed.secret, 'Your receiver uses it to check the Tollgate-Signature header. It is not shown again.') : null,
    h('div', { class: 'cardbody' }, field('Endpoint URL', url, 'https only.'), field('Events', events), error, h('div', { class: 'btnrow' }, add)),
    dataTable({
      caption: 'Webhooks', rows, rowKey: (w) => w.id, onOpen: (w) => { st.hookOpen = w.id; drawDeliveries(ctx, deliveriesHost); },
      empty: empty('No webhooks yet.', 'Subscribe to address.newly_listed to hear when a list update lists an address you screened before.'),
      cols: [
        { label: 'Endpoint', open: true, cls: 'wrap', render: (w) => w.url },
        { label: 'Events', cls: 'wrap', render: (w) => w.events.join(', ') },
        { label: 'Status', render: (w) => (w.removedAt ? `Removed ${stamp(w.removedAt)}` : 'Active') },
        { label: '', render: (w) => (w.removedAt || !isAdmin ? '' : h('button', { type: 'button', class: 'btn', 'data-remove': w.id, on: { click: () => ctx.run({ op: 'webhookRemove', actor: ctx.userId, hookId: w.id }) } }, 'Remove')) },
      ],
    }),
    deliveriesHost);
}

async function drawDeliveries(ctx, host) {
  clear(host);
  const hook = ctx.ws.webhooks.find((w) => w.id === st.hookOpen);
  if (!hook) return;
  const list = await webhookDeliveries(ctx.ws, hook, { limit: 20 });
  clear(host).append(h('div', { class: 'cardbody', id: 'in-deliveries' },
    h('h3', { class: 'card__title', text: `Deliveries for ${hook.url}` }),
    h('p', { class: 'field__hint', text: 'Newest 20. Status "not sent": the self-hosted kit would POST each body below with the header shown, retrying on failure.' }),
    list.length ? dataTable({
      caption: 'Webhook deliveries', rows: list, rowKey: (d) => d.event.id,
      cols: [
        { label: `Time (${zoneName()})`, render: (d) => stamp(d.event.created_at) },
        { label: 'Event', render: (d) => d.event.type },
        { label: 'Status', render: () => 'not sent' },
        { label: 'Body and signature', cls: 'wrap', render: (d) => h('details', {}, h('summary', { text: d.event.id }),
          h('pre', { class: 'rawjson', tabindex: '0', text: `Tollgate-Signature: ${d.signature}\n\n${JSON.stringify(d.event, null, 2)}` })) },
      ],
    }) : empty('No deliveries yet.', 'Screen something or apply a list update, then look again.')));
}

function usageCard(ctx) {
  const { ws } = ctx;
  const today = isoDay(ctx.now());
  const u = st.usage ?? { from: isoDay(new Date(ctx.now().getTime() - 29 * 86_400_000)), to: today, group: 'day' };
  st.usage = u;
  const from = h('input', { id: 'in-use-from', class: 'input', type: 'date', value: u.from });
  const to = h('input', { id: 'in-use-to', class: 'input', type: 'date', value: u.to });
  const group = select('in-use-group', [{ value: 'day', label: 'By day' }, { value: 'month', label: 'By month' }], u.group);
  const error = h('p', { class: 'field__hint field__hint--bad', role: 'alert', id: 'in-use-error' });
  const host = h('div', {});
  let report = null;
  const draw = () => {
    clear(host);
    error.textContent = '';
    try {
      report = usageReport(ws, st.usage);
    } catch (e) {
      report = null;
      error.textContent = e.message;
      return;
    }
    host.append(
      kv([['Unit', 'One signed screening decision'], ['Screened in range', String(report.totals.screened)], ['Allow / Hold / Hit', `${report.totals.allow} / ${report.totals.hold} / ${report.totals.block}`]]),
      dataTable({
        caption: 'Usage', rows: [...report.rows].reverse(), rowKey: (r) => `${r.period}|${r.meter}`,
        empty: empty('No screenings in this range.'),
        cols: [
          { label: 'Period (UTC)', render: (r) => r.period },
          { label: 'Who', render: (r) => (r.kind === 'api_key' ? `${r.key_name} (${r.meter})` : r.kind === 'console' ? ws.user(r.meter.slice(8))?.name ?? r.meter : KIND_LABELS[r.kind]) },
          { label: 'Source', render: (r) => KIND_LABELS[r.kind] },
          { label: 'Screened', num: true, render: (r) => String(r.screened) },
          { label: 'Allow', num: true, render: (r) => String(r.allow) },
          { label: 'Hold', num: true, render: (r) => String(r.hold) },
          { label: 'Hit', num: true, render: (r) => String(r.block) },
        ],
      }));
  };
  const apply = () => { st.usage = { from: from.value, to: to.value, group: group.value }; draw(); };
  [from, to, group].forEach((n) => n.addEventListener('change', apply));
  const csv = h('button', { type: 'button', class: 'btn', id: 'in-use-csv', on: { click: () => { if (report) download(`tollgate-usage-${report.from}-${report.to}.csv`, usageCsv(report), 'text/csv'); } } }, 'Export CSV');
  draw();
  return card('Usage', { id: 'in-usage', sub: 'Metered per screened transaction, one count per signed decision. An idempotent retry is not counted again. Seeded history is synthetic demo data. No prices are attached.' },
    h('div', { class: 'filters' }, field('From', from), field('To', to), field('Group', group), h('div', { class: 'btnrow' }, csv)), error, host);
}

function consoleCard(ctx) {
  const { ws } = ctx;
  const listed = [...ws.inForce.byAddress.values()].map((e) => e[0].address).find((a) => a.startsWith('0x')) ?? '';
  const presets = {
    screen: { method: 'POST', path: '/v1/screen', body: JSON.stringify({ chain: 'ETH', to_address: listed, from_address: '0x1111111111111111111111111111111111111111', amount_usd: 2500, originator_info_present: true, reference: 'withdrawal-1001' }, null, 2) },
    usage: { method: 'GET', path: `/v1/usage?from=${isoDay(new Date(ctx.now().getTime() - 6 * 86_400_000))}&to=${isoDay(ctx.now())}&group=day`, body: '' },
    receipt: { method: 'GET', path: `/v1/receipts/${encodeURIComponent(ws.ledger.entries.at(-1).receipt.receipt_id)}`, body: '' },
    verify: { method: 'POST', path: '/v1/verify', body: JSON.stringify({ receipt: ws.ledger.entries.at(-1).receipt }, null, 2) },
  };
  const c = st.console ?? { preset: 'screen', key: '', idem: '', ...presets.screen };
  st.console = c;
  const preset = select('in-con-preset', [{ value: 'screen', label: 'Screen a transfer' }, { value: 'usage', label: 'Read usage' }, { value: 'receipt', label: 'Fetch a receipt' }, { value: 'verify', label: 'Verify a receipt (no key)' }], c.preset ?? 'screen', (v) => {
    st.console = { ...st.console, preset: v, ...presets[v] };
    st.response = null;
    ctx.refresh();
  });
  const method = select('in-con-method', [{ value: 'POST', label: 'POST' }, { value: 'GET', label: 'GET' }], c.method);
  const path = h('input', { id: 'in-con-path', class: 'input mono', type: 'text', value: c.path, autocomplete: 'off', spellcheck: 'false' });
  const key = h('input', { id: 'in-con-key', class: 'input mono', type: 'text', value: c.key ?? '', autocomplete: 'off', spellcheck: 'false', placeholder: 'tg_... (create one above; it fills in here)' });
  const idem = h('input', { id: 'in-con-idem', class: 'input mono', type: 'text', value: c.idem ?? '', autocomplete: 'off', placeholder: 'Optional Idempotency-Key' });
  const body = h('textarea', { id: 'in-con-body', class: 'file batchtext', rows: 8, spellcheck: 'false', text: c.body });
  body.value = c.body;
  const out = h('pre', { class: 'rawjson', tabindex: '0', id: 'in-con-out', text: st.response ?? 'Send a request to see the response.' });
  const send = h('button', { type: 'button', class: 'btn btn--primary', id: 'in-con-send', on: { click: async () => {
    st.console = { ...st.console, method: method.value, path: path.value, key: key.value, idem: idem.value, body: body.value };
    const headers = {};
    if (key.value.trim()) headers.Authorization = `Bearer ${key.value.trim()}`;
    if (idem.value.trim()) headers['Idempotency-Key'] = idem.value.trim();
    // Screens go through the page's runner so they are saved like any other action.
    const apply = async (op) => {
      const r = await ctx.run(op, { quiet: true, refresh: false });
      if (!r.ok) throw r.error;
      return r.result;
    };
    let response;
    try {
      response = await handleApiRequest(ctx.ws, { method: method.value, path: path.value, headers, body: body.value || undefined }, { now: ctx.now(), apply, requestId: `req_${Date.now().toString(36)}` });
    } catch (e) {
      if (!(e instanceof WorkspaceError) && !(e instanceof TypeError)) throw e;
      response = { status: 400, headers: {}, body: { error: { code: 'bad_request', message: e.message } } };
    }
    const shown = typeof response.body === 'string' ? response.body : JSON.stringify(response.body, null, 2);
    st.response = `HTTP ${response.status}\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${shown}`;
    ctx.refresh();
  } } }, 'Send');
  return card('API console', { id: 'in-console', sub: 'Runs against this workspace in your browser. The paths, scopes and error shape follow the self-hosted kit\'s /v1 API; see the API reference page for each route.' },
    h('div', { class: 'cardbody' },
      h('div', { class: 'filters' }, field('Example', preset), field('Method', method), field('Path', path)),
      field('API key', key), field('Idempotency-Key', idem), field('Body (JSON)', body),
      h('div', { class: 'btnrow' }, send, h('a', { class: 'btn', href: 'docs.html', text: 'API reference' }))),
    out);
}

export function renderIntegrations(ctx, root) {
  clear(root);
  const deliveries = h('div', { id: 'in-deliveries-host' });
  root.append(
    h('div', { class: 'banner', 'data-state': 'caveat', role: 'note' }, h('span', { class: 'banner__lead', text: 'In-browser API' }),
      h('span', { class: 'banner__detail', text: 'Keys, webhooks and usage here are real code running on this demo workspace, saved in this browser only. The screening list is the bundled OFAC snapshot; the seeded payments are synthetic. Nothing is sent to a server.' })),
    keysCard(ctx), consoleCard(ctx), webhooksCard(ctx, deliveries), usageCard(ctx));
  if (st.hookOpen) drawDeliveries(ctx, deliveries);
}
