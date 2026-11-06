/**
 * Command palette data and matching. Matching is plain case-insensitive substring search on titles
 * and keywords, ranked by where the match falls. It is a navigation aid, not part of screening.
 */
export const PALETTE_LIMIT = 12;

/**
 * Args: routes {id: label}; alerts; addresses [{address, note}]; actions [{id, title, keywords}].
 * Returns: items { id, kind ('view'|'alert'|'address'|'action'), title, hint, keywords, payload }.
 */
export function buildCommands({ routes, extraRoutes = {}, alerts = [], addresses = [], actions = [] }) {
  const items = [];
  for (const [id, label] of Object.entries({ ...routes, ...extraRoutes })) items.push({ id: `view:${id}`, kind: 'view', title: `Go to ${label}`, hint: 'View', keywords: `${label} ${id} open`, payload: { route: id } });
  for (const a of actions) items.push({ id: `action:${a.id}`, kind: 'action', title: a.title, hint: 'Action', keywords: a.keywords ?? '', payload: { action: a.id } });
  for (const a of alerts) items.push({ id: `alert:${a.id}`, kind: 'alert', title: `Alert ${a.id}`, hint: `${a.kind}, ${a.status.replace('_', ' ')}`, keywords: `${a.address} ${a.kind} ${a.status}`, payload: { alertId: a.id } });
  for (const a of addresses) items.push({ id: `address:${a.address}`, kind: 'address', title: a.address, hint: a.note ?? 'Address', keywords: 'counterparty graph address', payload: { address: a.address } });
  return items;
}

function score(item, tokens) {
  const title = item.title.toLowerCase();
  const hay = `${title} ${item.keywords.toLowerCase()}`;
  let total = 0;
  for (const t of tokens) {
    if (!hay.includes(t)) return -1;
    if (title.startsWith(t)) total += 4;
    else if (title.split(/[\s:]+/).some((w) => w.startsWith(t))) total += 3;
    else if (title.includes(t)) total += 2;
    else total += 1;
  }
  return total;
}

/** Items matching every word of `query`, best first. An empty query returns views and actions. */
export function rankCommands(items, query, limit = PALETTE_LIMIT) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return items.filter((i) => i.kind === 'view' || i.kind === 'action').slice(0, limit);
  return items
    .map((item, order) => ({ item, s: score(item, tokens), order }))
    .filter((r) => r.s >= 0)
    .sort((a, b) => b.s - a.s || a.order - b.order)
    .slice(0, limit)
    .map((r) => r.item);
}
