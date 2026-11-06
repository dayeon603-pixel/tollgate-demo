/**
 * Plain SVG charts. No chart library, no inline styles (the page's content security policy forbids
 * them), so sizes are SVG attributes and colours come from CSS classes. The palette is the
 * Okabe-Ito colour-blind-safe set, and each series also has its own fill pattern, so the chart
 * still reads in greyscale. Every chart has a "View as table" alternative.
 */
import { h, svg } from './dom.js';

const W = 960;
const H = 250;
const M = { left: 38, right: 8, top: 18, bottom: 28 };

function niceMax(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * magnitude >= value / 4) * magnitude;
  return Math.ceil(value / step) * step;
}

function shortDate(key) {
  const [, month, day] = key.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(month) - 1]} ${Number(day)}`;
}

function patterns() {
  return svg('defs', {},
    svg('pattern', { id: 'pat-hold', width: 4, height: 4, patternUnits: 'userSpaceOnUse' }, svg('circle', { cx: 2, cy: 2, r: 0.9, class: 'pat-ink' })),
    svg('pattern', { id: 'pat-block', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 2, height: 5, class: 'pat-ink' })));
}

export const SERIES = [
  { key: 'allow', label: 'Allow', cls: 'allow' },
  { key: 'hold', label: 'Hold', cls: 'hold', pattern: 'pat-hold' },
  { key: 'block', label: 'Hit', cls: 'block', pattern: 'pat-block' },
];

/**
 * Stacked daily bars.
 *
 * Args: rows [{ date, allow, hold, block, total }]; markers [{ date, label }] drawn as dashed lines;
 *   title, a description for assistive technology.
 */
export function stackedBars({ rows, markers = [], title, id }) {
  const max = niceMax(Math.max(1, ...rows.map((r) => r.total)));
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const slot = plotW / rows.length;
  const barW = Math.max(3, slot * 0.7);
  const y = (v) => M.top + plotH - (v / max) * plotH;
  const readout = svg('text', { x: M.left, y: 11, class: 'chart__readout' });
  readout.textContent = 'Hover or focus a day for its counts.';
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-labelledby': `${id}-t` }, svg('title', { id: `${id}-t` }), patterns());
  root.querySelector('title').textContent = title;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  for (const t of ticks) {
    root.append(svg('line', { x1: M.left, x2: W - M.right, y1: y(t), y2: y(t), class: 'chart__grid' }));
    const label = svg('text', { x: M.left - 5, y: y(t) + 3.5, class: 'chart__axis', 'text-anchor': 'end' });
    label.textContent = String(t);
    root.append(label);
  }
  rows.forEach((row, i) => {
    const x = M.left + i * slot + (slot - barW) / 2;
    const group = svg('g', { class: 'chart__day', tabindex: i === rows.length - 1 ? 0 : -1 });
    const text = `${shortDate(row.date)}: ${row.total} screened. ${row.allow} allow, ${row.hold} hold, ${row.block} hit.`;
    group.append(svg('title', {}));
    group.querySelector('title').textContent = text;
    group.append(svg('rect', { x: M.left + i * slot, y: M.top, width: slot, height: plotH, class: 'chart__hit' }));
    let base = 0;
    for (const s of SERIES) {
      const v = row[s.key];
      if (!v) continue;
      const top = y(base + v);
      const hgt = y(base) - top;
      group.append(svg('rect', { x, y: top, width: barW, height: hgt, class: `bar bar--${s.cls}` }));
      if (s.pattern) group.append(svg('rect', { x, y: top, width: barW, height: hgt, fill: `url(#${s.pattern})`, class: 'bar-pat' }));
      base += v;
    }
    const show = () => { readout.textContent = text; };
    group.addEventListener('pointerenter', show);
    group.addEventListener('focus', show);
    root.append(group);
    if (i % 5 === 0 || i === rows.length - 1) {
      const lab = svg('text', { x: x + barW / 2, y: H - 10, class: 'chart__axis', 'text-anchor': i === rows.length - 1 ? 'end' : 'middle' });
      lab.textContent = shortDate(row.date);
      root.append(lab);
    }
  });
  for (const m of markers) {
    const i = rows.findIndex((r) => r.date === m.date);
    if (i < 0) continue;
    const x = M.left + i * slot;
    root.append(svg('line', { x1: x, x2: x, y1: M.top - 4, y2: M.top + plotH, class: 'chart__marker' }));
    const lab = svg('text', { x: x + 3, y: M.top + 8, class: 'chart__marker-label' });
    lab.textContent = m.label;
    root.append(lab);
  }
  root.append(readout);
  root.addEventListener('keydown', (event) => {
    const days = Array.from(root.querySelectorAll('.chart__day'));
    const at = days.indexOf(document.activeElement);
    const next = event.key === 'ArrowLeft' ? at - 1 : event.key === 'ArrowRight' ? at + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : null;
    if (next === null || at < 0) return;
    event.preventDefault();
    const target = days[Math.max(0, Math.min(days.length - 1, next))];
    days.forEach((d) => d.setAttribute('tabindex', '-1'));
    target.setAttribute('tabindex', '0');
    target.focus();
  });
  return root;
}

/** Legend for the series, with the same patterns as the bars. */
export function legend(series = SERIES) {
  return h('ul', { class: 'legend' }, series.map((s) => h('li', {},
    svg('svg', { viewBox: '0 0 14 14', class: 'legend__swatch', 'aria-hidden': 'true' }, svg('rect', { width: 14, height: 14, rx: 2, class: `bar bar--${s.cls}` }), s.pattern ? svg('rect', { width: 14, height: 14, rx: 2, fill: `url(#${s.pattern})`, class: 'bar-pat' }) : null),
    s.label)));
}

/**
 * Horizontal bars for a short list.
 *
 * Args: items [{ label, value, cls }], id, title.
 */
export function hbars({ items, id, title }) {
  const rowH = 26;
  const labelW = 104;
  const total = Math.max(1, ...items.map((i) => i.value));
  const root = svg('svg', { viewBox: `0 0 360 ${items.length * rowH + 4}`, class: 'chart chart--small', role: 'img', 'aria-labelledby': `${id}-t` }, svg('title', { id: `${id}-t` }));
  root.querySelector('title').textContent = title;
  items.forEach((item, i) => {
    const y = i * rowH + 3;
    const label = svg('text', { x: 0, y: y + 14, class: 'chart__axis chart__axis--ink' });
    label.textContent = item.label;
    const width = Math.max(item.value ? 2 : 0, ((360 - labelW - 34) * item.value) / total);
    const count = svg('text', { x: labelW + width + 6, y: y + 14, class: 'chart__axis chart__axis--ink' });
    count.textContent = String(item.value);
    root.append(label, svg('rect', { x: labelW, y, width, height: 18, rx: 2, class: `bar bar--${item.cls}` }), count);
  });
  return root;
}

/** Accessible table version of a chart. */
export function chartTable(headers, rows) {
  return h('details', { class: 'chart__table' }, h('summary', { text: 'View as table' }),
    h('div', { class: 'tablewrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, headers.map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, String(c)))))))));
}
