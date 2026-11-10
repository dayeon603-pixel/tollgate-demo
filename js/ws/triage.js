/**
 * Bulk actions on the alert queue. They go through the same engine ops as single actions, so
 * permissions, notes and four-eyes apply to every row.
 */

export const BULK_ACTIONS = ['assign', 'start_review', 'propose_clear'];

/**
 * Splits selected alerts into those an action may be applied to and those it may not, with the
 * engine's own reason for each refusal.
 */
export function planBulk(ws, userId, alertIds, action) {
  const allowed = [];
  const blocked = [];
  for (const id of alertIds) {
    const alert = ws.alertById.get(id);
    if (!alert) { blocked.push({ id, reason: 'That alert no longer exists.' }); continue; }
    const reason = ws.availableActions(userId, alert)[action];
    if (reason) blocked.push({ id, reason }); else allowed.push(id);
  }
  return { allowed, blocked };
}

/**
 * Applies one action to many alerts, one engine op each (each signs its own receipt).
 *
 * Args: ws; run, an async (op) => { ok, error? } (the page passes ctx.run so state is saved);
 *   spec { actor, action, alertIds, assignee, note, ts }.
 * Returns: { done: [ids], blocked: [{id, reason}] }. Four-eyes is never bypassed: propose_clear only
 *   proposes, and a different user must approve each one.
 */
export async function applyBulk(ws, run, { actor, action, alertIds, assignee = null, note = '', ts = new Date().toISOString() }) {
  if (!BULK_ACTIONS.includes(action)) throw new RangeError(`Bulk action must be one of ${BULK_ACTIONS.join(', ')}.`);
  const plan = planBulk(ws, actor, alertIds, action);
  const done = [];
  const blocked = [...plan.blocked];
  for (const id of plan.allowed) {
    const op = { op: 'alertAction', actor, alertId: id, action, ts };
    if (action === 'assign') op.assignee = assignee;
    if (action === 'propose_clear') op.note = note;
    const result = await run(op);
    if (result.ok) done.push(id); else blocked.push({ id, reason: result.error?.message ?? 'Refused.' });
  }
  return { done, blocked };
}
