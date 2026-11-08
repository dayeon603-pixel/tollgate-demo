/** Small pieces shared by the Network, List archive, Proof gap views and the dashboard strip. */
import { h, icon } from './dom.js';

/** Status chip. Colour is never the only cue: each tone has its own mark and a word. */
export function chip(text, tone = 'neutral') {
  return h('span', { class: `mchip mchip--${tone}` }, h('span', { class: 'mchip__mark', 'aria-hidden': 'true' }), text);
}

/** Label for a source file: path in mono type, with the first characters of its hash when given. */
export function sourceRef(path, sha256 = null) {
  return h('span', { class: 'srcref' }, h('code', { class: 'mono', text: path }), sha256 ? h('span', { class: 'srcref__hash mono', text: ` sha256 ${sha256.slice(0, 12)}…` }) : null);
}

/** Tag that says whether what is shown is real data from a file or made up for the demo. */
export function dataTag(kind) {
  const real = kind === 'real';
  return h('span', { class: `dtag dtag--${real ? 'real' : 'demo'}` }, real ? 'Real data' : 'Demo data');
}

/** Disabled-with-a-reason button. */
export function guardedButton({ label, reason, onClick, cls = 'btn', id, iconName }) {
  const button = h('button', { type: 'button', class: cls, id, disabled: Boolean(reason), title: reason ?? undefined, on: { click: onClick } }, iconName ? icon(iconName) : null, label);
  if (reason) button.setAttribute('aria-describedby', `${id ?? 'btn'}-why`);
  return reason ? h('span', { class: 'guarded' }, button, h('span', { class: 'sr', id: `${id ?? 'btn'}-why`, text: reason })) : button;
}

/** Why a role cannot do something, or null when it can. */
export function roleReason(ws, userId, permission) {
  if (ws.can(userId, permission)) return null;
  const user = ws.user(userId);
  return user?.role === 'examiner' ? 'Examiner is read-only. Switch to another user to do this.' : `${user?.name ?? 'This user'} (${user?.role}) does not have the ${permission.replace(/_/g, ' ')} permission.`;
}
