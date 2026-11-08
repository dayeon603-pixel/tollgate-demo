/**
 * Interactive time-series chart, hand-built in SVG (no library, no network request, no inline
 * styles, because the page's content security policy forbids all three).
 *
 * What it does: line, area and bar series (stacked or not) with monotone curves; a crosshair that
 * follows the pointer or the arrow keys and a tooltip that lists every visible series; legend
 * buttons that switch a series off and on; a brush strip under the plot to zoom to a time range
 * (drag the window or its ends), drag-to-zoom on the plot with a mouse, plus and minus keys, double
 * click or Reset zoom to go back; and smooth animation of the scale, of switching a series and of the
 * first draw. Animation is skipped when the visitor asked for reduced motion.
 *
 * Colours come from CSS classes. The palette is Okabe-Ito, which is colour-blind safe, and every
 * series also differs by dash or fill pattern so the chart still reads in greyscale. Each chart has
 * a "View as table" alternative. Number and time formats come from the callers, which read the
 * visitor's settings.
 */
import { h, svg } from './dom.js';
import { formatDate, getSettings } from './settings.js';

const DEFAULT_W = 640;
const MIN_W = 280;
const MARGIN = { left: 46, right: 12, top: 12, bottom: 22 };
const BRUSH_H = 30;
const BRUSH_GAP = 10;
const Y_TICKS = 4;
const MIN_POINTS_IN_VIEW = 4;
const DRAG_ZOOM_PX = 8;
const TAU_MS = 90;
const SETTLE = 0.002;
const TOOLTIP_CHAR_W = 6.3;
const TOOLTIP_LINE_H = 14;
const TABLE_ROWS = 60;
const ZOOM_STEP = 0.25;
const HANDLE_W = 7;
const PAD_HEADROOM = 1.1;

export function niceCeil(value) {
  if (!(value > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  const f = value / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** Smallest axis maximum above `value` that makes all four tick steps round (1, 2, 5 times a power of ten). */
export function niceMax4(value, integer = false) {
  const need = Math.max(value, integer ? 4 : 1e-9) / Y_TICKS;
  const exp = 10 ** Math.floor(Math.log10(need));
  let step = [1, 2, 5, 10].map((m) => m * exp).find((x) => x >= need - 1e-12);
  if (integer) step = Math.max(1, step);
  return step * Y_TICKS;
}

/** Axis number: compact above a thousand, with the visitor's decimal separator. */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  const comma = (s) => (getSettings().numberFormat === 'eu' ? s.replace('.', ',') : s);
  if (a >= 1e9) return comma(`${(n / 1e9).toFixed(1)}B`);
  if (a >= 1e6) return comma(`${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`);
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return comma(`${(n / 1e3).toFixed(1)}k`);
  return Number.isInteger(n) ? String(n) : comma(n.toFixed(a < 10 ? 1 : 0));
}

/** Monotone cubic path through points [[x, y]], no overshoot between samples. Breaks at nulls. */
export function monotonePath(points) {
  let d = '';
  let run = [];
  const flush = () => {
    if (run.length === 1) d += `M${run[0][0].toFixed(1)} ${run[0][1].toFixed(1)}`;
    else if (run.length > 1) d += curve(run);
    run = [];
  };
  for (const p of points) { if (p) run.push(p); else flush(); }
  flush();
  return d;
}

function curve(pts) {
  const n = pts.length;
  const dx = []; const m = []; const t = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push(dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i]); }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i]; const b = t[i + 1] / m[i]; const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i][0] + dx[i] / 3; const c2x = pts[i + 1][0] - dx[i] / 3;
    d += `C${c1x.toFixed(1)} ${(pts[i][1] + (t[i] * dx[i]) / 3).toFixed(1)} ${c2x.toFixed(1)} ${(pts[i + 1][1] - (t[i + 1] * dx[i]) / 3).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

const reducedMotion = () => getSettings().reduceMotion || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/**
 * Args: id; title (for assistive technology); series [{ key, label, cls, dash?, pattern? }];
 *   kind 'line' | 'area' | 'bars'; stacked; height; yFmt(value) for axis; valueFmt(value, key) for the
 *   tooltip and table; xFmt(t, long) for the axis (short) and tooltip (long); tableLabel; brush (default true);
 *   markers [{ t, label }] drawn as dashed vertical lines; emptyText.
 * Returns: { el, update(points), setMarkers(markers), resetZoom(), api } where points = [{ t, values: { [key]: number | null } }], oldest first.
 */
export function createChart({
  id, title, series, kind = 'line', stacked = false, height = 190, yFmt = compact, valueFmt = null, xFmt = (t) => String(t),
  tableLabel = 'Time', brush = true, integerAxis = false, markers = [], emptyText = 'No data yet.',
}) {
  const H = height + (brush ? BRUSH_H + BRUSH_GAP : 0);
  let W = DEFAULT_W;
  let plotW = W - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const brushTop = height + BRUSH_GAP / 2;
  const fmtVal = (v, key) => (valueFmt ?? yFmt)(v, key);
  const bars = kind === 'bars';

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'tchart', role: 'group', 'aria-roledescription': 'interactive chart', 'aria-labelledby': `${id}-t`, 'aria-describedby': `${id}-d`, tabindex: 0, 'data-chart': id });
  const titleEl = svg('title', { id: `${id}-t` });
  titleEl.textContent = title;
  const descEl = svg('desc', { id: `${id}-d` });
  descEl.textContent = 'Arrow keys move the readout. Plus and minus zoom. Zero resets the zoom. Escape clears the readout.';
  const defs = svg('defs', {});
  series.forEach((s, k) => {
    if (!s.pattern) return;
    defs.append(svg('pattern', { id: `${id}-pat-${k}`, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 1.8, height: 5, class: 'pat-ink' })));
  });
  const grid = svg('g', { class: 'tchart__grid' });
  const markerG = svg('g', {});
  const areas = series.map((s) => svg('path', { class: `ta ta--${s.cls}` }));
  const marks = svg('g', {});
  const lines = series.map((s) => svg('path', { class: `tl tl--${s.cls}${s.dash ? ' tl--dash' : ''}`, fill: 'none' }));
  const band = svg('rect', { class: 'tchart__band', y: MARGIN.top, height: plotH, visibility: 'hidden' });
  const cross = svg('g', { class: 'tchart__cross', visibility: 'hidden' });
  const vline = svg('line', { y1: MARGIN.top, y2: MARGIN.top + plotH, class: 'tchart__vline' });
  const dots = series.map((s) => svg('circle', { r: 3.6, class: `tdot tdot--${s.cls}` }));
  const tip = svg('g', { class: 'tchart__tip' });
  const tipBg = svg('rect', { rx: 4, class: 'tchart__tipbg' });
  const tipText = svg('text', { class: 'tchart__tiptext' });
  const tipSwatches = svg('g', {});
  tip.append(tipBg, tipSwatches, tipText);
  cross.append(vline, ...dots, tip);
  const hit = svg('rect', { x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH, class: 'tchart__hit' });
  const emptyMsg = svg('text', { x: MARGIN.left + plotW / 2, y: MARGIN.top + plotH / 2, class: 'tchart__empty', 'text-anchor': 'middle', visibility: 'hidden' });
  emptyMsg.textContent = emptyText;
  root.append(titleEl, descEl, defs, grid, markerG, ...(stacked ? areas.slice().reverse() : areas), marks, ...lines, band, hit, cross, emptyMsg);

  // brush
  const bg = svg('g', { class: 'tbrush' });
  const bTrack = svg('rect', { x: MARGIN.left, y: brushTop, width: plotW, height: BRUSH_H, rx: 3, class: 'tbrush__track' });
  const bPath = svg('path', { class: 'tbrush__line', fill: 'none' });
  const bShadeL = svg('rect', { y: brushTop, height: BRUSH_H, class: 'tbrush__shade' });
  const bShadeR = svg('rect', { y: brushTop, height: BRUSH_H, class: 'tbrush__shade' });
  const bWin = svg('rect', { y: brushTop, height: BRUSH_H, class: 'tbrush__win', tabindex: 0, role: 'slider', 'aria-label': 'Zoom window. Arrow keys move it.' });
  const bHandleL = svg('rect', { y: brushTop + 4, width: HANDLE_W, height: BRUSH_H - 8, rx: 2, class: 'tbrush__handle' });
  const bHandleR = svg('rect', { y: brushTop + 4, width: HANDLE_W, height: BRUSH_H - 8, rx: 2, class: 'tbrush__handle' });
  bg.append(bTrack, bPath, bShadeL, bShadeR, bWin, bHandleL, bHandleR);
  if (brush) root.append(bg);

  /** Sizes the drawing to the box it sits in, so text is true pixel size at any width. */
  function setWidth(width) {
    const next = Math.max(MIN_W, Math.round(width));
    if (next === W) return;
    W = next;
    plotW = W - MARGIN.left - MARGIN.right;
    root.setAttribute('viewBox', `0 0 ${W} ${H}`);
    hit.setAttribute('width', plotW);
    emptyMsg.setAttribute('x', MARGIN.left + plotW / 2);
    bTrack.setAttribute('width', plotW);
    draw();
  }

  // state
  let data = [];
  const visible = Object.fromEntries(series.map((s) => [s.key, true]));
  let view = { a: 0, b: 1 };
  const anim = { ymax: 1, grow: 0, vf: Object.fromEntries(series.map((s) => [s.key, 1])) };
  const target = { ymax: 1, grow: 1, vf: { ...anim.vf } };
  let active = -1;
  let raf = 0;
  let last = 0;
  let firstDraw = true;
  let markerList = markers;

  const range = () => {
    const n = data.length;
    const i0 = Math.max(0, Math.min(n - 1, Math.round(view.a * (n - 1))));
    const i1 = Math.max(i0, Math.min(n - 1, Math.round(view.b * (n - 1))));
    return [i0, i1];
  };
  const xAt = (i, i0, i1) => {
    const count = i1 - i0 + 1;
    return bars ? MARGIN.left + ((i - i0 + 0.5) / count) * plotW : MARGIN.left + (count <= 1 ? 0 : ((i - i0) / (count - 1)) * plotW);
  };
  const yAt = (v) => MARGIN.top + plotH - (v / anim.ymax) * plotH;
  const valueOf = (p, key) => p.values[key];
  const stackTotal = (p, factor = true) => series.reduce((sum, s) => sum + (valueOf(p, s.key) ?? 0) * (factor ? target.vf[s.key] : 1), 0);

  function computeTargetMax() {
    if (!data.length) { target.ymax = 1; return; }
    const [i0, i1] = range();
    let top = 0;
    for (let i = i0; i <= i1; i++) {
      const p = data[i];
      top = Math.max(top, stacked ? stackTotal(p) : Math.max(0, ...series.map((s) => (valueOf(p, s.key) ?? 0) * target.vf[s.key])));
    }
    target.ymax = niceMax4(top * PAD_HEADROOM, integerAxis);
  }

  function draw() {
    const n = data.length;
    const [i0, i1] = n ? range() : [0, 0];
    emptyMsg.setAttribute('visibility', data.some((p) => series.some((s) => (valueOf(p, s.key) ?? 0) > 0)) ? 'hidden' : 'visible');
    while (grid.firstChild) grid.firstChild.remove();
    for (let k = 0; k <= Y_TICKS; k++) {
      const v = (anim.ymax * k) / Y_TICKS;
      grid.append(svg('line', { x1: MARGIN.left, x2: W - MARGIN.right, y1: yAt(v), y2: yAt(v), class: k === 0 ? 'tchart__gl tchart__gl--base' : 'tchart__gl' }));
      const label = svg('text', { x: MARGIN.left - 7, y: yAt(v) + 3.5, class: 'tchart__ax', 'text-anchor': 'end' });
      label.textContent = yFmt(v);
      grid.append(label);
    }
    if (n) {
      const probe = xFmt(data[i0].t).length * 6.4 + 14;
      const labels = Math.max(2, Math.min(6, Math.floor(plotW / probe)));
      for (let k = 0; k < labels; k++) {
        const i = labels === 1 ? i0 : Math.round(i0 + (k / (labels - 1)) * (i1 - i0));
        const text = svg('text', { x: xAt(i, i0, i1), y: height - 6, class: 'tchart__ax', 'text-anchor': k === 0 ? 'start' : k === labels - 1 ? 'end' : 'middle' });
        text.textContent = xFmt(data[i].t);
        grid.append(text);
      }
    }
    // markers
    while (markerG.firstChild) markerG.firstChild.remove();
    if (n) {
      for (const m of markerList) {
        const i = data.findIndex((p) => p.t >= m.t);
        if (i < i0 || i > i1 || i < 0) continue;
        const x = xAt(i, i0, i1) - (bars ? plotW / (2 * (i1 - i0 + 1)) : 0);
        markerG.append(svg('line', { x1: x, x2: x, y1: MARGIN.top - 4, y2: MARGIN.top + plotH, class: 'chart__marker' }));
        const lab = svg('text', { x: x + 4, y: MARGIN.top + 8, class: 'chart__marker-label' });
        lab.textContent = m.label;
        markerG.append(lab);
      }
    }
    while (marks.firstChild) marks.firstChild.remove();
    if (!n) { lines.forEach((l) => l.setAttribute('d', '')); areas.forEach((a) => a.setAttribute('d', '')); return; }
    const factor = (s) => anim.vf[s.key] * anim.grow;
    if (bars) {
      const count = i1 - i0 + 1;
      const bw = Math.max(1.5, (plotW / count) * 0.72);
      for (let i = i0; i <= i1; i++) {
        let base = 0;
        series.forEach((s, k) => {
          const v = (valueOf(data[i], s.key) ?? 0) * factor(s);
          if (v <= 0) return;
          const y0 = yAt(stacked ? base : 0);
          const y1 = yAt(stacked ? base + v : v);
          const w = stacked ? bw : bw / series.length;
          const x = xAt(i, i0, i1) - bw / 2 + (stacked ? 0 : k * w);
          const rect = svg('rect', { x: x.toFixed(1), y: y1.toFixed(1), width: w.toFixed(1), height: Math.max(0.6, y0 - y1).toFixed(1), rx: 1.5, class: `tb tb--${s.cls}` });
          marks.append(rect);
          if (s.pattern) marks.append(svg('rect', { x: x.toFixed(1), y: y1.toFixed(1), width: w.toFixed(1), height: Math.max(0.6, y0 - y1).toFixed(1), fill: `url(#${id}-pat-${k})`, class: 'bar-pat' }));
          if (stacked) base += v;
        });
      }
      lines.forEach((l) => l.setAttribute('d', ''));
      areas.forEach((a) => a.setAttribute('d', ''));
    } else {
      series.forEach((s, k) => {
        const pts = [];
        for (let i = i0; i <= i1; i++) {
          const raw = valueOf(data[i], s.key);
          if (raw === null || raw === undefined) { pts.push(null); continue; }
          const y = stacked ? series.slice(0, k + 1).reduce((sum, x) => sum + (valueOf(data[i], x.key) ?? 0) * factor(x), 0) : raw * factor(s);
          pts.push([xAt(i, i0, i1), yAt(y)]);
        }
        const d = monotonePath(pts);
        lines[k].setAttribute('d', d);
        lines[k].setAttribute('opacity', String(Math.min(1, anim.vf[s.key])));
        if (kind === 'area') {
          const valid = pts.filter(Boolean);
          if (valid.length > 1) {
            const lower = stacked && k > 0 ? series.slice(0, k).map((_, j) => j) : null;
            let base = `L${valid.at(-1)[0].toFixed(1)} ${yAt(0).toFixed(1)}L${valid[0][0].toFixed(1)} ${yAt(0).toFixed(1)}Z`;
            if (lower) {
              const below = [];
              for (let i = i1; i >= i0; i--) below.push([xAt(i, i0, i1), yAt(series.slice(0, k).reduce((sum, x) => sum + (valueOf(data[i], x.key) ?? 0) * factor(x), 0))]);
              base = `L${below[0][0].toFixed(1)} ${below[0][1].toFixed(1)}${below.slice(1).map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')}Z`;
            }
            areas[k].setAttribute('d', `${d}${base}`);
            areas[k].setAttribute('opacity', String(Math.min(1, anim.vf[s.key])));
          } else areas[k].setAttribute('d', '');
        } else areas[k].setAttribute('d', '');
      });
    }
    if (brush) drawBrush();
    if (active >= 0) showAt(active);
  }

  function drawBrush() {
    const n = data.length;
    if (n < 2) { bPath.setAttribute('d', ''); return; }
    const totals = data.map((p) => (stacked ? stackTotal(p) : Math.max(0, ...series.map((s) => (valueOf(p, s.key) ?? 0) * target.vf[s.key]))));
    const top = Math.max(1e-9, ...totals);
    const pts = totals.map((v, i) => [MARGIN.left + (i / (n - 1)) * plotW, brushTop + BRUSH_H - 3 - (v / top) * (BRUSH_H - 8)]);
    bPath.setAttribute('d', monotonePath(pts));
    const xa = MARGIN.left + view.a * plotW;
    const xb = MARGIN.left + view.b * plotW;
    bShadeL.setAttribute('x', MARGIN.left); bShadeL.setAttribute('width', Math.max(0, xa - MARGIN.left));
    bShadeR.setAttribute('x', xb); bShadeR.setAttribute('width', Math.max(0, MARGIN.left + plotW - xb));
    bWin.setAttribute('x', xa); bWin.setAttribute('width', Math.max(2, xb - xa));
    bHandleL.setAttribute('x', xa - HANDLE_W / 2); bHandleR.setAttribute('x', xb - HANDLE_W / 2);
    bWin.setAttribute('aria-valuemin', '0'); bWin.setAttribute('aria-valuemax', '100'); bWin.setAttribute('aria-valuenow', String(Math.round(view.a * 100)));
    bWin.setAttribute('aria-valuetext', `Showing ${xFmt(data[range()[0]].t, true)} to ${xFmt(data[range()[1]].t, true)}`);
    resetBtn.hidden = view.a === 0 && view.b === 1;
  }

  // ---- animation ------------------------------------------------------------------------
  function step(now) {
    raf = 0;
    const dt = Math.min(64, last ? now - last : 16);
    last = now;
    const k = 1 - Math.exp(-dt / TAU_MS);
    let moving = false;
    const ease = (cur, goal) => {
      const next = cur + (goal - cur) * k;
      if (Math.abs(goal - next) <= SETTLE * Math.max(1, Math.abs(goal))) return goal;
      moving = true;
      return next;
    };
    anim.ymax = ease(anim.ymax, target.ymax);
    anim.grow = ease(anim.grow, target.grow);
    for (const s of series) anim.vf[s.key] = ease(anim.vf[s.key], target.vf[s.key]);
    draw();
    if (moving) raf = requestAnimationFrame(step);
    else last = 0;
  }
  function go() {
    computeTargetMax();
    if (reducedMotion()) {
      anim.ymax = target.ymax; anim.grow = target.grow; Object.assign(anim.vf, target.vf);
      draw();
      return;
    }
    if (!raf) { last = 0; raf = requestAnimationFrame(step); }
  }

  // ---- readout --------------------------------------------------------------------------
  function showAt(i) {
    const n = data.length;
    if (!n) return;
    const [i0, i1] = range();
    active = Math.max(i0, Math.min(i1, i));
    const p = data[active];
    const x = xAt(active, i0, i1);
    vline.setAttribute('x1', x); vline.setAttribute('x2', x);
    let acc = 0;
    series.forEach((s, k) => {
      const v = valueOf(p, s.key);
      const on = target.vf[s.key] > 0;
      const y = v === null || v === undefined || !on ? null : yAt(stacked ? (acc += v * anim.vf[s.key] * anim.grow) : v * anim.vf[s.key] * anim.grow);
      dots[k].setAttribute('visibility', y === null || bars ? 'hidden' : 'visible');
      if (y !== null) { dots[k].setAttribute('cx', x); dots[k].setAttribute('cy', y); }
    });
    while (tipText.firstChild) tipText.firstChild.remove();
    while (tipSwatches.firstChild) tipSwatches.firstChild.remove();
    const shown = series.filter((s) => target.vf[s.key] > 0);
    const lines2 = [{ text: xFmt(p.t, true), head: true }, ...shown.map((s) => ({ text: `${s.label}: ${fmtVal(valueOf(p, s.key), s.key)}`, s }))];
    if (stacked && shown.length > 1) lines2.push({ text: `Total: ${fmtVal(stackTotal(p), 'total')}`, total: true });
    lines2.forEach((line, k) => {
      const t = svg('tspan', { x: line.s ? 22 : 10, y: 6 + (k + 1) * TOOLTIP_LINE_H - 3, class: line.head ? 'tchart__tiphead' : line.total ? 'tchart__tiptotal' : '' });
      t.textContent = line.text;
      tipText.append(t);
      if (line.s) tipSwatches.append(svg('rect', { x: 9, y: 6 + (k + 1) * TOOLTIP_LINE_H - 11, width: 8, height: 8, rx: 2, class: `tsw tsw--${line.s.cls}` }));
    });
    const width = Math.max(...lines2.map((l) => l.text.length + (l.s ? 2 : 0))) * TOOLTIP_CHAR_W + 18;
    const hgt = lines2.length * TOOLTIP_LINE_H + 10;
    tipBg.setAttribute('width', width); tipBg.setAttribute('height', hgt);
    const left = x + 14 + width > W - MARGIN.right ? x - 14 - width : x + 14;
    tip.setAttribute('transform', `translate(${Math.max(MARGIN.left, left).toFixed(1)} ${MARGIN.top + 2})`);
    cross.setAttribute('visibility', 'visible');
  }
  const hideReadout = () => { active = -1; cross.setAttribute('visibility', 'hidden'); };
  const pxToX = (event) => {
    const box = root.getBoundingClientRect();
    return box.width ? ((event.clientX - box.left) / box.width) * W : 0;
  };
  const indexAtX = (x) => {
    const [i0, i1] = range();
    const count = i1 - i0 + 1;
    const f = (x - MARGIN.left) / plotW;
    return bars ? i0 + Math.floor(f * count) : i0 + Math.round(f * (count - 1));
  };

  // pointer on plot: crosshair, and rubber-band zoom for a mouse
  let dragStart = null;
  hit.addEventListener('pointermove', (event) => {
    const x = pxToX(event);
    if (dragStart !== null && event.pointerType === 'mouse') {
      const a = Math.max(MARGIN.left, Math.min(x, dragStart));
      const b = Math.min(MARGIN.left + plotW, Math.max(x, dragStart));
      band.setAttribute('x', a); band.setAttribute('width', b - a);
      band.setAttribute('visibility', b - a > DRAG_ZOOM_PX ? 'visible' : 'hidden');
    }
    if (data.length) showAt(indexAtX(x));
  });
  hit.addEventListener('pointerdown', (event) => {
    const x = pxToX(event);
    if (event.pointerType === 'mouse' && event.button === 0) { dragStart = x; hit.setPointerCapture?.(event.pointerId); }
    if (data.length) showAt(indexAtX(x));
  });
  const endDrag = (event) => {
    if (dragStart === null) return;
    const x = pxToX(event);
    const a = Math.min(dragStart, x);
    const b = Math.max(dragStart, x);
    dragStart = null;
    band.setAttribute('visibility', 'hidden');
    if (b - a > DRAG_ZOOM_PX && data.length > MIN_POINTS_IN_VIEW) {
      const [i0, i1] = range();
      const lo = indexAtX(Math.max(MARGIN.left, a));
      const hi = indexAtX(Math.min(MARGIN.left + plotW, b));
      zoomToIndex(Math.min(lo, hi), Math.max(lo, hi), i0, i1);
    }
  };
  hit.addEventListener('pointerup', endDrag);
  hit.addEventListener('pointercancel', () => { dragStart = null; band.setAttribute('visibility', 'hidden'); });
  hit.addEventListener('pointerleave', () => { if (dragStart === null) hideReadout(); });
  hit.addEventListener('dblclick', () => resetZoom());

  function zoomToIndex(lo, hi) {
    const n = data.length;
    if (n < 2) return;
    const span = Math.max(MIN_POINTS_IN_VIEW - 1, hi - lo);
    const start = Math.max(0, Math.min(n - 1 - span, lo));
    setView(start / (n - 1), (start + span) / (n - 1));
  }
  function setView(a, b) {
    view = { a: Math.max(0, a), b: Math.min(1, b) };
    go();
  }
  function resetZoom() { setView(0, 1); }

  root.addEventListener('keydown', (event) => {
    const [i0, i1] = range();
    const mid = active >= 0 ? active : Math.round((i0 + i1) / 2);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showAt((active < 0 ? i1 : active) + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === 'Home') { event.preventDefault(); showAt(i0); }
    else if (event.key === 'End') { event.preventDefault(); showAt(i1); }
    else if ((event.key === '+' || event.key === '=') && data.length > MIN_POINTS_IN_VIEW) {
      event.preventDefault();
      const half = Math.max((MIN_POINTS_IN_VIEW - 1) / 2, ((i1 - i0) * (1 - ZOOM_STEP)) / 2);
      zoomToIndex(Math.round(mid - half), Math.round(mid + half));
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      const half = ((i1 - i0) * (1 + ZOOM_STEP)) / 2 + 1;
      zoomToIndex(Math.round(mid - half), Math.round(mid + half));
    } else if (event.key === '0') { event.preventDefault(); resetZoom(); }
    else if (event.key === 'Escape') hideReadout();
  });
  root.addEventListener('blur', hideReadout);

  // brush interaction
  let brushDrag = null;
  const brushX = (event) => (pxToX(event) - MARGIN.left) / plotW;
  const minSpan = () => (data.length > 1 ? (MIN_POINTS_IN_VIEW - 1) / (data.length - 1) : 1);
  bg.addEventListener('pointerdown', (event) => {
    const f = Math.max(0, Math.min(1, brushX(event)));
    const onL = event.target === bHandleL;
    const onR = event.target === bHandleR;
    if (onL || onR) brushDrag = { mode: onL ? 'l' : 'r' };
    else if (f >= view.a && f <= view.b) brushDrag = { mode: 'move', grab: f - view.a, span: view.b - view.a };
    else { const span = view.b - view.a; const a = Math.max(0, Math.min(1 - span, f - span / 2)); setView(a, a + span); brushDrag = { mode: 'move', grab: span / 2, span }; }
    bg.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  bg.addEventListener('pointermove', (event) => {
    if (!brushDrag) return;
    const f = Math.max(0, Math.min(1, brushX(event)));
    if (brushDrag.mode === 'move') { const a = Math.max(0, Math.min(1 - brushDrag.span, f - brushDrag.grab)); setView(a, a + brushDrag.span); }
    else if (brushDrag.mode === 'l') setView(Math.min(f, view.b - minSpan()), view.b);
    else setView(view.a, Math.max(f, view.a + minSpan()));
  });
  const endBrush = () => { brushDrag = null; };
  bg.addEventListener('pointerup', endBrush);
  bg.addEventListener('pointercancel', endBrush);
  bWin.addEventListener('keydown', (event) => {
    const span = view.b - view.a;
    const move = event.key === 'ArrowLeft' ? -0.05 : event.key === 'ArrowRight' ? 0.05 : null;
    if (move === null) return;
    event.preventDefault();
    const a = Math.max(0, Math.min(1 - span, view.a + move));
    setView(a, a + span);
  });

  // legend, reset, table
  const resetBtn = h('button', { type: 'button', class: 'btn btn--ghost tchartbox__reset', hidden: true, on: { click: () => resetZoom() } }, 'Reset zoom');
  const legendEl = h('ul', { class: 'legend legend--inline legend--toggle' }, series.map((s) => h('li', {}, h('button', {
    type: 'button', class: 'legend__btn', 'aria-pressed': 'true', 'data-series': s.key, title: `Show or hide ${s.label}`,
    on: { click: (event) => {
      const btn = event.currentTarget;
      const on = target.vf[s.key] === 0;
      const stillOn = series.filter((x) => target.vf[x.key] > 0 && x.key !== s.key).length;
      if (!on && !stillOn) return;
      target.vf[s.key] = on ? 1 : 0;
      btn.setAttribute('aria-pressed', String(on));
      go();
    } },
  }, svg('svg', { viewBox: '0 0 18 10', class: 'legend__line', 'aria-hidden': 'true' },
    kind === 'line' ? svg('line', { x1: 1, x2: 17, y1: 5, y2: 5, class: `tl tl--${s.cls}${s.dash ? ' tl--dash' : ''}` }) : svg('rect', { x: 2, y: 1, width: 14, height: 8, rx: 2, class: `tsw tsw--${s.cls}` })), s.label))));
  const table = h('details', { class: 'chart__table' }, h('summary', { text: 'View as table' }), h('div', { class: 'tablewrap' }));
  table.addEventListener('toggle', () => { if (table.open) fillTable(); });
  function fillTable() {
    const host = table.querySelector('.tablewrap');
    while (host.firstChild) host.firstChild.remove();
    const [i0, i1] = data.length ? range() : [0, -1];
    host.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, tableLabel), series.map((s) => h('th', { scope: 'col', class: 'num' }, s.label)))),
      h('tbody', {}, data.slice(i0, i1 + 1).slice(-TABLE_ROWS).reverse().map((p) => h('tr', {}, h('td', {}, xFmt(p.t, true)), series.map((s) => h('td', { class: 'num' }, fmtVal(valueOf(p, s.key), s.key))))))));
  }

  const el = h('div', { class: 'tchartbox' }, root, h('div', { class: 'tchartbox__bar' }, legendEl, resetBtn), table);
  let sized = false;
  function observe() {
    sized = true;
    if (typeof ResizeObserver === 'undefined') return;
    new ResizeObserver((entries) => { const w = entries[0]?.contentRect.width; if (w) setWidth(w); }).observe(root);
  }
  return {
    el,
    /** Replaces the data. Keeps the zoom and the series switches. */
    update(points) {
      if (!sized) observe();
      const grew = !data.length && points.length;
      data = points;
      if (grew && firstDraw && !reducedMotion()) { anim.grow = 0; target.grow = 1; computeTargetMax(); anim.ymax = target.ymax; }
      if (grew) firstDraw = false;
      go();
      if (table.open) fillTable();
    },
    setMarkers(list) { markerList = list; draw(); },
    resetZoom,
    /** For tests: the current zoom as fractions of the data. */
    state: () => ({ view: { ...view }, visible: { ...Object.fromEntries(series.map((s) => [s.key, target.vf[s.key] > 0])) }, points: data.length }),
  };
}

/** Date for a chart axis from a UTC day start (ms): short on the axis, long in the readout, in the visitor's date format. */
export function axisDate(t, long = false) {
  const full = formatDate(t);
  if (long) return full;
  return getSettings().dateFormat === 'long' ? full.replace(/, \d{4}$/, '') : full.slice(5);
}

const BAR_ROW_H = 28;
const BAR_LABEL_W = 112;
const BAR_VALUE_W = 44;
const BAR_W = 420;
const BAR_ANIM_MS = 650;

/**
 * Horizontal bars for a short list, grown from zero on first draw (skipped for reduced motion), with a
 * hover and focus highlight and a readout.
 *
 * Args: id; title; items [{ label, value, cls, note? }]; fmt(value).
 */
export function barList({ id, title, items, fmt = (v) => String(v) }) {
  const total = Math.max(1, ...items.map((i) => i.value));
  const H = items.length * BAR_ROW_H + 6;
  const root = svg('svg', { viewBox: `0 0 ${BAR_W} ${H}`, class: 'chart chart--small blist', role: 'img', 'aria-labelledby': `${id}-t` }, svg('title', { id: `${id}-t` }));
  root.querySelector('title').textContent = title;
  const rects = [];
  const counts = [];
  items.forEach((item, i) => {
    const y = i * BAR_ROW_H + 4;
    const g = svg('g', { class: 'blist__row', tabindex: 0, role: 'img', 'aria-label': `${item.label}: ${fmt(item.value)}${item.note ? `. ${item.note}` : ''}` });
    const label = svg('text', { x: 0, y: y + 15, class: 'chart__axis chart__axis--ink' });
    label.textContent = item.label;
    const track = svg('rect', { x: BAR_LABEL_W, y, width: BAR_W - BAR_LABEL_W - BAR_VALUE_W, height: 20, rx: 3, class: 'blist__track' });
    const rect = svg('rect', { x: BAR_LABEL_W, y, width: 0, height: 20, rx: 3, class: `bar bar--${item.cls}` });
    const count = svg('text', { x: BAR_LABEL_W + 6, y: y + 15, class: 'chart__axis chart__axis--ink blist__count' });
    count.textContent = fmt(item.value);
    g.append(svg('rect', { x: 0, y: y - 3, width: BAR_W, height: BAR_ROW_H - 2, class: 'blist__hit' }), label, track, rect, count);
    root.append(g);
    rects.push(rect);
    counts.push(count);
  });
  const full = BAR_W - BAR_LABEL_W - BAR_VALUE_W;
  const place = (k) => items.forEach((item, i) => {
    const w = Math.max(item.value ? 2 : 0, (item.value / total) * full * k);
    rects[i].setAttribute('width', w.toFixed(1));
    counts[i].setAttribute('x', (BAR_LABEL_W + w + 6).toFixed(1));
  });
  if (reducedMotion()) place(1);
  else {
    const start = performance.now();
    const frame = (now) => {
      const k = Math.min(1, (now - start) / BAR_ANIM_MS);
      place(1 - (1 - k) ** 3);
      if (k < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
  return root;
}
