/**
 * DOM helpers for the workspace views. Everything shown goes through textContent or attributes,
 * never innerHTML, because notes, labels and CSV cells are user input.
 */

export const WS_ICONS = {
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3L4 11ZM6.5 14h3',
  scan: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M2.5 8h11',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  layers: 'M8 2 14 5.5 8 9 2 5.5 8 2ZM2 8.5 8 12l6-3.5M2 11.5 8 15l6-3.5',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.5 10.5 14 14',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3M6 8h4M6 10.5h4',
  sliders: 'M3 4h10M3 8h10M3 12h10M6 2.5v3M10 6.5v3M5 10.5v3',
  clock: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12ZM8 4.5V8l2.5 1.5',
  plug: 'M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0V5ZM8 11.5V14',
  download: 'M8 2.5v8M4.5 7.5 8 11l3.5-3.5M3 13.5h10',
  upload: 'M8 11V3M4.5 6 8 2.5 11.5 6M3 13.5h10',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z',
  sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
  back: 'M10 3 5 8l5 5',
  shield: 'M8 14S3 11.5 3 7V3.5L8 2l5 1.5V7c0 4.5-5 7-5 7ZM6 8l1.5 1.5L10.5 6.5',
  user: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2.5 14c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5',
  link: 'M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-1 1M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l1-1',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hyperscript. attrs: class, text, on:{event:fn}, anything else becomes an attribute (true = empty). */
export function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name === 'text') node.textContent = value;
    else if (name === 'on') for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
    else node.setAttribute(name, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined && value !== null) node.setAttribute(name, String(value));
  for (const child of children.flat(Infinity)) if (child) node.append(child);
  return node;
}

export function icon(name, icons = WS_ICONS) {
  return svg('svg', { viewBox: '0 0 16 16', class: 'icon', 'aria-hidden': 'true' }, svg('path', { d: icons[name] ?? '' }));
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

// ---- formatting ------------------------------------------------------------------------

export function money(n) {
  return n === null || n === undefined ? 'unknown' : `$${Math.round(n).toLocaleString('en-US')}`;
}

/** "2026-11-06 10:42" in UTC. */
export function stamp(iso) {
  return iso ? iso.replace('T', ' ').slice(0, 16) : '';
}

export function shortHash(hex, head = 10, tail = 6) {
  return hex && hex.length > head + tail + 1 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex ?? '';
}

export function shortAddr(address) {
  return address && address.length > 20 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address ?? '';
}

export const KIND_LABELS = { hit: 'List hit', hold: 'Policy hold', lookback: 'Lookback hit', watchlist: 'Watchlist hit' };
export const STATUS_LABELS = { open: 'Open', in_review: 'In review', escalated: 'Escalated', cleared: 'Cleared', confirmed: 'Confirmed' };
export const OUTCOME_LABELS = { ALLOW: 'Allow', HOLD: 'Hold', BLOCK: 'Hit' };

/** Status chip. Colour is never the only signal: each status has a word and a distinct shape. */
export function statusChip(alert) {
  const waiting = alert.pending ? ' · approval pending' : '';
  return h('span', { class: `schip schip--${alert.status}` }, h('span', { class: 'schip__dot', 'aria-hidden': 'true' }), STATUS_LABELS[alert.status] + waiting);
}

export function outcomeTag(outcome) {
  return h('span', { class: `decision decision--${outcome.toLowerCase()}` }, OUTCOME_LABELS[outcome] ?? outcome);
}

export function mono(text, cls = '') {
  return h('span', { class: `mono ${cls}`.trim(), text });
}

/** Button that copies text, with feedback that does not rely on colour. */
export function copyButton(text, label) {
  const button = h('button', { type: 'button', class: 'iconbtn', 'aria-label': `Copy ${label}`, title: `Copy ${label}` }, icon('copy', { copy: 'M6 6h7v7H6zM3 10V3h7' }));
  button.addEventListener('click', async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
    button.dataset.copied = String(ok);
    button.setAttribute('aria-label', ok ? `Copied ${label}` : `Could not copy ${label}`);
    setTimeout(() => {
      delete button.dataset.copied;
      button.setAttribute('aria-label', `Copy ${label}`);
    }, 1400);
  });
  return button;
}

/** Key/value list. rows: [[label, node-or-text], ...] */
export function kv(rows) {
  return h('dl', { class: 'kv' }, rows.filter(Boolean).map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', {}, v))));
}

export function card(title, { sub, actions, id } = {}, ...body) {
  return h('section', { class: 'card', 'aria-labelledby': id }, h('div', { class: 'card__head' }, h('h2', { class: 'card__title', id, text: title }), sub ? h('p', { class: 'card__sub', text: sub }) : null, actions ?? null), ...body);
}

export function empty(title, detail) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty__title', text: title }), detail ? h('p', { class: 'empty__detail', text: detail }) : null);
}

/** Download a text file from the browser. */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- tables ----------------------------------------------------------------------------

/**
 * Data table with a keyboard-reachable open button in the first column. On narrow screens the
 * existing stylesheet turns each row into a card using data-label.
 *
 * Args: cols [{ label, render(row), num, cls, open }], rows, rowKey(row), onOpen(row), caption.
 */
export function dataTable({ cols, rows, rowKey, onOpen, caption, empty: emptyNode }) {
  if (!rows.length) return emptyNode ?? empty('Nothing here yet.');
  const head = h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: `${c.num ? 'num' : ''} ${c.cls ?? ''}`.trim() }, c.label)));
  const body = rows.map((row) => {
    const tr = h('tr', { class: 'grid__row', 'data-key': rowKey(row) });
    cols.forEach((c) => {
      const content = c.render(row);
      const cell = h('td', { class: `${c.num ? 'num' : ''} ${c.cls ?? ''}`.trim(), 'data-label': c.label });
      if (c.open && onOpen) {
        const button = h('button', { type: 'button', class: 'rowlink', 'data-rownav': '' }, content);
        button.addEventListener('click', (e) => { e.stopPropagation(); onOpen(row); });
        cell.append(button);
      } else append(cell, [content]);
      tr.append(cell);
    });
    if (onOpen) tr.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, select, textarea')) onOpen(row); });
    return tr;
  });
  return h('div', { class: 'tablewrap' }, h('table', { class: 'grid' }, caption ? h('caption', { class: 'sr', text: caption }) : null, h('thead', {}, head), h('tbody', {}, body)));
}

/** Previous/next controls. Returns an empty fragment when everything fits on one page. */
export function pager({ page, size, total, onChange }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages === 1) return document.createDocumentFragment();
  const from = page * size + 1;
  const to = Math.min(total, (page + 1) * size);
  return h('div', { class: 'pager' },
    h('span', { class: 'muted', text: `${from} to ${to} of ${total}` }),
    h('button', { type: 'button', class: 'btn', disabled: page === 0, on: { click: () => onChange(page - 1) } }, 'Previous'),
    h('button', { type: 'button', class: 'btn', disabled: page >= pages - 1, on: { click: () => onChange(page + 1) } }, 'Next'));
}

/** Segmented filter. options: [{ value, label, count }] */
export function segmented({ label, options, value, onChange }) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map((o) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(o.value === value), on: { click: () => onChange(o.value) } },
      o.label, o.count !== undefined ? h('span', { class: 'seg__count', text: String(o.count) }) : null)));
}

/** Labelled form field. control is a node that already has an id. */
export function field(label, control, hint) {
  return h('div', { class: 'fieldbox' }, h('label', { for: control.id, text: label }), control, hint ? h('p', { class: 'field__hint', text: hint }) : null);
}

export function select(id, options, value, onChange) {
  const node = h('select', { id, class: 'select' }, options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  if (onChange) node.addEventListener('change', () => onChange(node.value));
  return node;
}
