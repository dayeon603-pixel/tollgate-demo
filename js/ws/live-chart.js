/**
 * Live SVG charts that update in place (no redraw of the whole element, no library). Sizes are SVG
 * attributes and colours come from CSS classes, because the page's CSP forbids inline styles.
 * Hover or arrow keys move a crosshair with a tooltip. Series differ by colour (Okabe-Ito,
 * colour-blind safe) and by dash or marker pattern, so the chart reads in greyscale.
 */
import { h, svg } from './dom.js';

const W = 640;
const M = { left: 44, right: 10, top: 10, bottom: 22 };
const NS_TICKS = 4;

export function niceCeil(value) {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}

export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(a < 10 ? 1 : 0);
}

/**
 * Args: id; title (for assistive technology); series [{ key, label, cls, dash? }]; mode 'line' | 'area' | 'bars';
 *   stacked (bars and area); height; yFmt(value); xFmt(t); yMin fixed floor.
 * Returns: { el, update(points) } where points = [{ t, values: { [key]: number|null } }], oldest first.
 */
export function timeChart({ id, title, series, mode = 'line', stacked = false, height = 170, yFmt = compact, xFmt = (t) => String(t), valueFmt = null, tableLabel = 'Time' }) {
  const H = height;
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tchart', role: 'img', 'aria-labelledby': `${id}-t`, tabindex: 0, 'data-chart': id });
  const titleEl = svg('title', { id: `${id}-t` });
  titleEl.textContent = title;
  const grid = svg('g', { class: 'tchart__grid' });
  const marks = svg('g', {});
  const paths = series.map((s) => svg('path', { class: `tl tl--${s.cls}${s.dash ? ' tl--dash' : ''}`, fill: 'none' }));
  const areas = mode === 'area' ? series.map((s) => svg('path', { class: `ta ta--${s.cls}` })) : [];
  const cross = svg('g', { class: 'tchart__cross', visibility: 'hidden' });
  const vline = svg('line', { y1: M.top, y2: M.top + plotH, class: 'tchart__vline' });
  const dots = series.map((s) => svg('circle', { r: 3.5, class: `tdot tdot--${s.cls}` }));
  const tip = svg('g', { class: 'tchart__tip' });
  const tipBg = svg('rect', { rx: 3, class: 'tchart__tipbg' });
  const tipText = svg('text', { class: 'tchart__tiptext' });
  tip.append(tipBg, tipText);
  cross.append(vline, ...dots, tip);
  const hit = svg('rect', { x: M.left, y: M.top, width: plotW, height: plotH, class: 'tchart__hit' });
  root.append(titleEl, grid, ...(stacked ? areas.slice().reverse() : areas), marks, ...paths, cross, hit);

  let data = [];
  let scale = { max: 1 };
  let active = -1;
  const xAt = (i, n) => (mode === 'bars' ? M.left + ((i + 0.5) / n) * plotW : M.left + (n <= 1 ? 0 : (i / (n - 1)) * plotW));
  const yAt = (v) => M.top + plotH - (v / scale.max) * plotH;

  function totalOf(point) {
    return series.reduce((s, x) => s + (point.values[x.key] ?? 0), 0);
  }

  function draw() {
    const n = data.length;
    let top = 0;
    for (const p of data) top = Math.max(top, stacked ? totalOf(p) : Math.max(0, ...series.map((s) => p.values[s.key] ?? 0)));
    scale = { max: niceCeil(top * 1.1) };
    while (grid.firstChild) grid.firstChild.remove();
    for (let k = 0; k <= NS_TICKS; k++) {
      const v = (scale.max * k) / NS_TICKS;
      grid.append(svg('line', { x1: M.left, x2: W - M.right, y1: yAt(v), y2: yAt(v), class: 'tchart__gl' }));
      const label = svg('text', { x: M.left - 6, y: yAt(v) + 3.5, class: 'tchart__ax', 'text-anchor': 'end' });
      label.textContent = yFmt(v);
      grid.append(label);
    }
    if (n) {
      [0, Math.floor((n - 1) / 2), n - 1].forEach((i, k) => {
        const label = svg('text', { x: xAt(i, n), y: H - 6, class: 'tchart__ax', 'text-anchor': k === 0 ? 'start' : k === 2 ? 'end' : 'middle' });
        label.textContent = xFmt(data[i].t);
        grid.append(label);
      });
    }
    if (mode === 'bars') {
      while (marks.firstChild) marks.firstChild.remove();
      const bw = Math.max(1.5, (plotW / Math.max(1, n)) * 0.74);
      data.forEach((p, i) => {
        let base = 0;
        series.forEach((s) => {
          const v = p.values[s.key] ?? 0;
          if (!v) return;
          const y0 = yAt(stacked ? base : 0);
          const y1 = yAt(stacked ? base + v : v);
          marks.append(svg('rect', { x: xAt(i, n) - bw / 2, y: y1, width: bw, height: Math.max(0.5, y0 - y1), class: `tb tb--${s.cls}` }));
          if (stacked) base += v;
        });
      });
      paths.forEach((p) => p.setAttribute('d', ''));
      return;
    }
    series.forEach((s, k) => {
      const pts = data.map((p, i) => {
        const v = p.values[s.key];
        if (v === null || v === undefined) return null;
        const y = stacked ? series.slice(0, k + 1).reduce((sum, x) => sum + (p.values[x.key] ?? 0), 0) : v;
        return [xAt(i, n), yAt(y)];
      });
      let d = '';
      let pen = false;
      for (const pt of pts) {
        if (!pt) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`;
        pen = true;
      }
      paths[k].setAttribute('d', d);
      if (areas[k]) {
        const valid = pts.filter(Boolean);
        areas[k].setAttribute('d', valid.length ? `${d}L${valid.at(-1)[0].toFixed(1)} ${yAt(0)}L${valid[0][0].toFixed(1)} ${yAt(0)}Z` : '');
      }
    });
  }

  function showAt(i) {
    const n = data.length;
    if (!n) return;
    active = Math.max(0, Math.min(n - 1, i));
    const p = data[active];
    const x = xAt(active, n);
    vline.setAttribute('x1', x);
    vline.setAttribute('x2', x);
    let acc = 0;
    series.forEach((s, k) => {
      const v = p.values[s.key];
      const y = v === null || v === undefined ? null : yAt(stacked ? (acc += v) : v);
      dots[k].setAttribute('visibility', y === null || mode === 'bars' ? 'hidden' : 'visible');
      if (y !== null) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', y); }
    });
    while (tipText.firstChild) tipText.firstChild.remove();
    const lines = [xFmt(p.t, true), ...series.map((s) => `${s.label}: ${(valueFmt ?? yFmt)(p.values[s.key], s.key)}`)];
    lines.forEach((line, k) => {
      const t = svg('tspan', { x: 8, dy: k === 0 ? 13 : 13, class: k === 0 ? 'tchart__tiphead' : '' });
      t.textContent = line;
      tipText.append(t);
    });
    const width = Math.max(...lines.map((l) => l.length)) * 6.2 + 16;
    const height2 = lines.length * 13 + 8;
    tipBg.setAttribute('width', width);
    tipBg.setAttribute('height', height2);
    const left = x + 12 + width > W - M.right ? x - 12 - width : x + 12;
    tip.setAttribute('transform', `translate(${left.toFixed(1)} ${M.top + 2})`);
    cross.setAttribute('visibility', 'visible');
  }

  const move = (event) => {
    const box = root.getBoundingClientRect();
    if (!box.width || !data.length) return;
    const x = ((event.clientX - box.left) / box.width) * W;
    const n = data.length;
    showAt(mode === 'bars' ? Math.floor(((x - M.left) / plotW) * n) : Math.round(((x - M.left) / plotW) * (n - 1)));
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { active = -1; cross.setAttribute('visibility', 'hidden'); });
  root.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
    if (event.key === 'Escape') { active = -1; cross.setAttribute('visibility', 'hidden'); return; }
    if (step === null) return;
    event.preventDefault();
    showAt(active < 0 ? data.length - 1 : active + step);
  });
  root.addEventListener('blur', () => { active = -1; cross.setAttribute('visibility', 'hidden'); });

  const table = h('details', { class: 'chart__table' }, h('summary', { text: 'View as table' }), h('div', { class: 'tablewrap' }));
  table.addEventListener('toggle', () => { if (table.open) fillTable(); });
  function fillTable() {
    const host = table.querySelector('.tablewrap');
    while (host.firstChild) host.firstChild.remove();
    host.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, tableLabel), series.map((s) => h('th', { scope: 'col', class: 'num' }, s.label)))),
      h('tbody', {}, data.slice(-60).reverse().map((p) => h('tr', {}, h('td', {}, xFmt(p.t, true)), series.map((s) => h('td', { class: 'num' }, (valueFmt ?? yFmt)(p.values[s.key], s.key))))))));
  }

  const legendEl = h('ul', { class: 'legend legend--inline' }, series.map((s) => h('li', {}, svg('svg', { viewBox: '0 0 18 8', class: 'legend__line', 'aria-hidden': 'true' }, svg('line', { x1: 1, x2: 17, y1: 4, y2: 4, class: `tl tl--${s.cls}${s.dash ? ' tl--dash' : ''}` })), s.label)));
  const el = h('div', { class: 'tchartbox' }, root, legendEl, table);

  return {
    el,
    update(points) {
      data = points;
      draw();
      if (active >= 0) showAt(active);
      if (table.open) fillTable();
    },
  };
}

/** Tiny trend line for KPI tiles. values: numbers, oldest first. */
export function sparkline(values, { cls = 'allow', width = 96, height = 22 } = {}) {
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'spark', 'aria-hidden': 'true', focusable: 'false' });
  if (values.length < 2) return root;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (width - 2) + 1, height - 2 - ((v - min) / span) * (height - 5)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
  root.append(svg('path', { d: `${d}L${width - 1} ${height - 1}L1 ${height - 1}Z`, class: `spark__area spark__area--${cls}` }), svg('path', { d, class: `spark__line spark__line--${cls}`, fill: 'none' }));
  return root;
}
