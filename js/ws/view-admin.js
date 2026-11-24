/** Policy and roles (admin changes are receipted) and the API examples page (static). */
import { card, clear, copyButton, dataTable, empty, field, h, kv, mono, select, stamp } from './dom.js';
import { zoneName } from './dom.js';
import { actorName } from './describe.js';
import { PERMISSION_LABELS, PERMISSIONS, RULE_LABELS, ROLES } from './engine.js';

function rowSetting(ctx, { key, label, enabledKey, valueKey, current }) {
  const { ws } = ctx;
  const isAdmin = ws.can(ctx.userId, 'policy');
  const on = h('input', { id: `pol-${key}-on`, type: 'checkbox', checked: current.enabled, disabled: !isAdmin });
  const amount = h('input', { id: `pol-${key}-amt`, class: 'input num', type: 'text', inputmode: 'numeric', value: String(current.thresholdUsd), disabled: !isAdmin, 'aria-describedby': `pol-${key}-hint` });
  const error = h('p', { class: 'field__hint field__hint--bad', role: 'alert' });
  const save = h('button', { type: 'button', class: 'btn', disabled: !isAdmin, on: { click: async () => {
    error.textContent = '';
    if (on.checked !== current.enabled) {
      const r = await ctx.run({ op: 'policySet', actor: ctx.userId, key: enabledKey, value: on.checked }, { quiet: true, refresh: false });
      if (!r.ok) { error.textContent = r.error.message; return; }
    }
    if (amount.value.replace(/,/g, '') !== String(current.thresholdUsd)) {
      const r = await ctx.run({ op: 'policySet', actor: ctx.userId, key: valueKey, value: amount.value.replace(/,/g, '') }, { quiet: true, refresh: false });
      if (!r.ok) { error.textContent = r.error.message; return; }
    }
    ctx.toast('Policy saved. The change was signed as a receipt and applies to later screenings only.');
    ctx.refresh();
  } } }, 'Save');
  return h('div', { class: 'rule' },
    h('div', { class: 'rule__main' }, h('label', { class: 'check' }, on, h('span', { text: label })),
      h('p', { id: `pol-${key}-hint`, class: 'field__hint', text: key === 'blank_originator' ? 'Holds a payment when originator details are blank. A payment with no amount never triggers an amount rule.' : 'Holds a payment at or above this amount, whether or not originator details are present.' })),
    h('div', { class: 'rule__controls' }, field('Threshold in USD', amount), save), error);
}

export function renderPolicy(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const isAdmin = ws.can(ctx.userId, 'policy');
  const p = ws.policy;
  root.append(...[
    isAdmin ? null : h('p', { class: 'demo-line', id: 'pol-readonly' }, `Read-only for ${ws.user(ctx.userId).name}. Switch to the admin user to edit.`),
    card('Lists', { id: 'pol-lists' }, h('div', { class: 'cardbody' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: true, 'aria-describedby': 'pol-lists-hint' }), h('span', { text: 'OFAC SDN digital currency addresses' })),
      h('p', { id: 'pol-lists-hint', class: 'field__hint', text: 'Always on. Tollgate matches exact addresses on this list only. Name matching and other lists are not part of this demo.' }))),
    card('Auto-hold rules', { id: 'pol-rules' }, h('div', { class: 'cardbody' },
      rowSetting(ctx, { key: 'blank_originator', label: RULE_LABELS.blank_originator, enabledKey: 'rules.blank_originator.enabled', valueKey: 'rules.blank_originator.thresholdUsd', current: p.rules.blank_originator }),
      rowSetting(ctx, { key: 'large_value', label: RULE_LABELS.large_value, enabledKey: 'rules.large_value.enabled', valueKey: 'rules.large_value.thresholdUsd', current: p.rules.large_value }))),
    card('Four-eyes approval', { id: 'pol-4eyes' }, h('div', { class: 'cardbody' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, disabled: true }), h('span', { text: 'Clearing a list hit needs a second person (always on)' })),
      h('label', { class: 'check' }, h('input', { id: 'pol-4eyes-hold', type: 'checkbox', checked: p.fourEyes.hold, disabled: !isAdmin, on: { change: (e) => ctx.run({ op: 'policySet', actor: ctx.userId, key: 'fourEyes.hold', value: e.target.checked }) } }), h('span', { text: 'Clearing a policy hold needs a second person' })),
      h('p', { class: 'field__hint', text: 'The second person must be a different user with the approver or admin role. Nobody can approve their own proposal.' }))),
  ].filter(Boolean));

  // Roles
  const roleRows = Object.keys(PERMISSION_LABELS);
  root.append(card('Roles', { id: 'pol-roles' }, h('div', { class: 'cardbody' },
    h('h3', { class: 'subhead', text: 'Users' }),
    dataTable({
      caption: 'Users', rows: ws.users, rowKey: (u) => u.id,
      cols: [
        { label: 'User', render: (u) => u.name },
        { label: 'Role', render: (u) => {
          const sel = select(`role-${u.id}`, ROLES.map((r) => ({ value: r, label: r })), u.role, async (v) => {
            const r = await ctx.run({ op: 'userRole', actor: ctx.userId, userId: u.id, role: v });
            if (!r.ok) sel.value = u.role;
          });
          sel.disabled = !ws.can(ctx.userId, 'roles');
          sel.setAttribute('aria-label', `Role for ${u.name}`);
          return sel;
        } },
      ],
    }),
    h('h3', { class: 'subhead', text: 'What each role can do' }),
    h('div', { class: 'tablewrap' }, h('table', { class: 'grid matrixtable' },
      h('caption', { class: 'sr', text: 'What each role can do' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Permission' }), ROLES.map((r) => h('th', { scope: 'col', text: r })))),
      h('tbody', {}, roleRows.map((perm) => h('tr', {}, h('td', { text: PERMISSION_LABELS[perm] }), ROLES.map((r) => h('td', { 'data-label': r, text: PERMISSIONS[r].includes(perm) ? 'Yes' : 'No', class: PERMISSIONS[r].includes(perm) ? 'yes' : 'no' }))))))),
    h('p', { class: 'field__hint', text: 'These are demo users with generic names. A real deployment would use your own people and sign-in.' }))));

  // Change log
  const changes = ws.ledger.entries.filter((e) => ['policy_change', 'role_change'].includes(e.receipt.action.type)).reverse();
  root.append(card('Change log', { id: 'pol-log' }, dataTable({
    caption: 'Policy and role changes', rows: changes, rowKey: (e) => e.receipt.receipt_id, onOpen: (e) => ctx.openReceipt(e.receipt.receipt_id),
    empty: empty('No changes yet.'),
    cols: [
      { label: `Time (${zoneName()})`, render: (e) => stamp(e.receipt.action.requested_at) },
      { label: 'Change', cls: 'wrap', render: (e) => { const a = e.receipt.action.params; return a.setting ? `${a.setting}: ${a.from} to ${a.to}` : `${a.user_id}: ${a.from} to ${a.to}`; } },
      { label: 'By', render: (e) => actorName(ws, e.receipt.action.params.actor) },
      { label: 'Receipt', open: true, render: (e) => e.receipt.receipt_id.replace('rcpt:', '') },
    ],
  })));
}

// ---- API examples ---------------------------------------------------------------------------

function code(title, text) {
  return card(title, { actions: copyButton(text, title) }, h('pre', { class: 'rawjson', tabindex: '0', text }));
}

export function renderApi(ctx, root) {
  const { ws } = ctx;
  clear(root);
  const sample = [...ws.ledger.entries].reverse().find((e) => e.receipt.action.type === 'stablecoin_payment_screen' && e.receipt.action.params.outcome === 'BLOCK') ?? ws.ledger.entries.at(-1);
  const request = `POST /v1/screen
Authorization: Bearer tg_...
Idempotency-Key: withdrawal-1001
Content-Type: application/json

{
  "chain": "ETH",
  "to_address": "0x0123456789abcdef0123456789abcdef01234567",
  "from_address": "0x1111111111111111111111111111111111111111",
  "amount_usd": 1500,
  "originator_info_present": false,
  "reference": "withdrawal-1001"
}`;
  const response = `{
  "decision": "DENY",
  "outcome": "HOLD",
  "reasons": ["outcome=HOLD", "rulebook_version=SDN-OFAC-${ws.inForce.digest.slice(0, 12)}", "...", "policy_rule=blank_originator"],
  "payment_id": "TX-00412",
  "alert_id": "AL-0031",
  "list_in_force": { "version": "${ws.inForce.id}", "list_digest": "${ws.inForce.digest.slice(0, 16)}...", "entries": ${ws.inForce.addressCount} },
  "receipt": { ...a receipt like the real one below... }
}`;
  const webhook = `POST https://your-system.example/tollgate
Content-Type: application/json
Tollgate-Signature: t=1763971200,v1=<HMAC-SHA256 hex of "t.body">

{
  "id": "evt_u512",
  "type": "address.newly_listed",
  "created_at": "2026-11-24T08:00:00.000Z",
  "receipt_id": "rcpt:u512",
  "data": { "address": "0x0123...4567", "earlier_payments": ["TX-00087"], "total_usd": 4200, "from_version": "L2", "to_version": "L3", "alert_id": "AL-0032" }
}`;
  root.append(
    h('div', { class: 'banner', 'data-state': 'caveat', role: 'note' }, h('span', { class: 'banner__lead', text: 'Try it in Integrations' }),
      h('span', { class: 'banner__detail', text: 'These are the shapes the API in this demo returns, with illustrative values. Create a key under Admin, Integrations and send real requests from its API console; they run in your browser against this workspace. The receipt at the end is a real one from this demo ledger.' })),
    code('Screen a transfer (request)', request),
    code('Screen a transfer (response)', response),
    code('Webhook delivery', webhook),
    card('A real receipt from this demo', { sub: `${sample.receipt.receipt_id}, signed with the public demo key`, actions: copyButton(JSON.stringify(sample.receipt, null, 2), 'receipt') },
      h('pre', { class: 'rawjson', tabindex: '0', text: JSON.stringify(sample.receipt, null, 2) })),
    card('Checking a receipt yourself', { id: 'api-verify' }, h('div', { class: 'cardbody' }, h('ol', { class: 'steps' },
      h('li', { text: 'Write the receipts file exactly as exported.' }),
      h('li', { text: 'Check each signature with Ed25519 over the canonical JSON of the verdict without its signature field (keys sorted, no spaces).' }),
      h('li', { text: 'Recompute each this_hash as SHA-256 of the canonical JSON of seq, prev_hash, action and verdict, and check prev_hash links to the receipt before.' })),
    h('p', { class: 'field__hint', text: 'The Verify receipts page in this app does all of this in the browser, and scripts/verify_pack.mjs does it from the command line.' }))),
  );
  void kv; void mono; void field;
}
