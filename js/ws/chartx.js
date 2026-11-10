/**
 * Time-series and bar-list charts on Apache ECharts (see echart.js for the shared look).
 *
 * createChart keeps the call shape the views already use: series [{ key, label, cls, dash?, pattern? }],
 * kind 'line' | 'area' | 'bars', stacked, formats from the caller. It adds an HTML legend whose buttons
 * switch series off and on, a "View as table" alternative, a clean empty state (no axes, one muted line),
 * keyboard reading (arrow keys move the readout, plus and minus zoom, zero resets) and Ctrl or Cmd plus
 * wheel zoom on a mouse, with a Reset zoom button. No brush strip.
 */
import { h } from './dom.js';
import { formatDate, getSettings } from './settings.js';
import { categoryAxis, esc, mount, seriesColour, tooltipBase, valueAxis } from './echart.js';

const Y_TICKS = 4;
const TABLE_ROWS = 60;
const ZOOM_STEP = 0.25;
const MIN_POINTS_IN_VIEW = 4;
const BAR_ROW_H = 30;

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

/** Axis number: compact above a thousand, with the visitor's decimal separator. Integers stay integers. */
export function compact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '-';
  const a = Math.abs(n);
  const comma = (s) => (getSettings().numberFormat === 'eu' ? s.replace('.', ',') : s);
  const trim = (s) => s.replace(/\.0(?=[kMB]?$)/, '');
  if (a >= 1e9) return comma(trim(`${(n / 1e9).toFixed(1)}B`));
  if (a >= 1e6) return comma(trim(`${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`));
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}k`;
  if (a >= 1e3) return comma(trim(`${(n / 1e3).toFixed(1)}k`));
  return Number.isInteger(n) ? String(n) : comma(n.toFixed(a < 10 ? 1 : 0));
}

/** Date for a chart axis from a UTC day start (ms): short on the axis, long in the readout, in the visitor's date format. */
export function axisDate(t, long = false) {
  const full = formatDate(t);
  if (long) return full;
  return getSettings().dateFormat === 'long' ? full.replace(/, \d{4}$/, '') : full.slice(5);
}

/** Diagonal hatching for a series that must also read in greyscale (the "hit" and "blocked" series). */
const HATCH = { symbol: 'rect', symbolSize: 1, dashArrayX: [1, 0], dashArrayY: [1.5, 4], rotation: -Math.PI / 4, color: 'rgba(255,255,255,0.38)' };
const NO_DECAL = { symbol: 'none' };

/**
 * Args: id; title (for assistive technology); series [{ key, label, cls, dash?, pattern? }];
 *   kind 'line' | 'area' | 'bars'; stacked; height (px); yFmt(value) for the axis; valueFmt(value, key) for
 *   the tooltip and table; xFmt(t, long) short on the axis, long in the tooltip; tableLabel; integerAxis;
 *   markers [{ t, label }] drawn as dashed vertical lines; emptyText.
 * Returns: { el, update(points), setMarkers(markers), resetZoom(), state() } where
 *   points = [{ t, values: { [key]: number | null } }], oldest first.
 */
export function createChart({
  id, title, series, kind = 'line', stacked = false, height = 190, yFmt = compact, valueFmt = null, xFmt = (t) => String(t),
  tableLabel = 'Time', integerAxis = false, markers = [], emptyText = 'No data yet.',
}) {
  const bars = kind === 'bars';
  const fmtVal = (v, key) => (v === null || v === undefined ? 'no data' : (valueFmt ?? yFmt)(v, key));
  let data = [];
  let markerList = markers;
  const visible = Object.fromEntries(series.map((s) => [s.key, true]));
  let zoom = { start: 0, end: 100 };

  const host = h('div', { class: 'tchart__canvas' });
  host.style.height = `${height}px`;
  const emptyMsg = h('p', { class: 'tchart__empty', text: emptyText, hidden: true });
  const frame = h('div', {
    class: 'tchart', role: 'group', tabindex: 0, 'data-chart': id, 'aria-label': title, 'aria-roledescription': 'interactive chart',
  }, host, emptyMsg);
  const hint = h('p', { class: 'sr', id: `${id}-d`, text: 'Arrow keys read the values. Plus and minus zoom, zero resets. Ctrl and the mouse wheel also zoom.' });
  frame.setAttribute('aria-describedby', `${id}-d`);

  const hasData = () => data.some((p) => series.some((s) => (p.values[s.key] ?? 0) > 0));

  function tooltipHtml(params) {
    const list = Array.isArray(params) ? params : [params];
    if (!list.length) return '';
    const p = data[list[0].dataIndex];
    if (!p) return '';
    const rows = series.filter((s) => visible[s.key]).map((s) => `<div class="ect__row"><span class="ect__sw ect__sw--${esc(s.cls)}${s.dash ? ' ect__sw--dash' : ''}"></span><span class="ect__k">${esc(s.label)}</span><span class="ect__v">${esc(fmtVal(p.values[s.key], s.key))}</span></div>`);
    const shown = series.filter((s) => visible[s.key]);
    if (stacked && shown.length > 1) {
      const total = shown.reduce((sum, s) => sum + (p.values[s.key] ?? 0), 0);
      rows.push(`<div class="ect__row ect__row--total"><span class="ect__k">Total</span><span class="ect__v">${esc(fmtVal(total, 'total'))}</span></div>`);
    }
    return `<div class="ect__head">${esc(xFmt(p.t, true))}</div>${rows.join('')}`;
  }

  function build(t) {
    const empty = !hasData();
    emptyMsg.hidden = !empty;
    frame.dataset.empty = String(empty);
    const cats = data.map((p) => String(p.t));
    const markLine = !empty && markerList.length ? {
      silent: true, symbol: 'none', animation: false,
      lineStyle: { color: t.dim, type: [3, 3], width: 1 },
      label: { show: true, position: 'end', distance: 3, color: t.dim, fontSize: 11, fontWeight: 600, formatter: (m) => m.name },
      data: markerList.map((m) => ({ name: m.label, xAxis: data.findIndex((p) => p.t >= m.t) })).filter((m) => m.xAxis >= 0),
    } : undefined;
    return {
      aria: { enabled: true, label: { description: title }, decal: { show: true } },
      grid: { left: 20, right: 24, top: markerList.length ? 22 : 10, bottom: 2, containLabel: true },
      tooltip: { ...tooltipBase(t), show: !empty, trigger: 'axis', formatter: tooltipHtml,
        axisPointer: bars ? { type: 'shadow', shadowStyle: { color: t.dark ? 'rgba(255,255,255,0.05)' : 'rgba(21,25,28,0.05)' } } : { type: 'line', lineStyle: { color: t.faint, width: 1, type: [3, 3] } } },
      legend: { show: false, data: series.map((s) => s.label), selected: Object.fromEntries(series.map((s) => [s.label, visible[s.key]])) },
      xAxis: categoryAxis(t, cats, (v) => xFmt(Number(v)), { show: !empty, boundaryGap: bars }),
      yAxis: valueAxis(t, (v) => yFmt(v), { show: !empty, minInterval: integerAxis ? 1 : 0 }),
      dataZoom: [{ type: 'inside', ...zoom, zoomOnMouseWheel: 'ctrl', moveOnMouseWheel: false, moveOnMouseMove: zoom.start > 0.01 || zoom.end < 99.99, preventDefaultMouseMove: false, filterMode: 'none', minValueSpan: MIN_POINTS_IN_VIEW - 1 }],
      series: empty ? [] : series.map((s, k) => {
        const colour = seriesColour(s.cls);
        const values = data.map((p) => p.values[s.key] ?? (bars ? 0 : null));
        const common = { id: s.key, name: s.label, stack: stacked ? 'total' : undefined, data: values, markLine: k === 0 ? markLine : undefined };
        if (bars) {
          return { ...common, type: 'bar', barMaxWidth: 26, barCategoryGap: '30%', barGap: '10%',
            itemStyle: { color: colour, borderRadius: stacked && k < series.length - 1 ? 0 : [1.5, 1.5, 0, 0], decal: s.pattern ? HATCH : NO_DECAL },
            emphasis: { disabled: true } };
        }
        return { ...common, type: 'line', smooth: 0.2, smoothMonotone: 'x', showSymbol: false, symbol: 'circle', symbolSize: 6, connectNulls: false,
          lineStyle: { width: 1.5, color: colour, type: s.dash ? [5, 3] : 'solid' }, itemStyle: { color: colour, borderColor: t.surface, borderWidth: 1.5, decal: NO_DECAL },
          areaStyle: kind === 'area' ? { color: colour, opacity: stacked ? 0.28 : 0.14, decal: NO_DECAL } : undefined,
          emphasis: { disabled: true } };
      }),
    };
  }

  const chart = mount(host, build, (inst) => {
    inst.on('datazoom', () => {
      const dz = inst.getOption().dataZoom?.[0];
      if (dz) zoom = { start: dz.start, end: dz.end };
      resetBtn.hidden = zoom.start <= 0.01 && zoom.end >= 99.99;
    });
  });

  // Keyboard: read values, zoom, reset.
  let active = -1;
  const showAt = (i) => {
    const inst = chart.chart();
    if (!inst || !data.length || !hasData()) return;
    active = Math.max(0, Math.min(data.length - 1, i));
    inst.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: active });
  };
  const setZoom = (start, end) => {
    zoom = { start: Math.max(0, start), end: Math.min(100, end) };
    chart.chart()?.dispatchAction({ type: 'dataZoom', start: zoom.start, end: zoom.end });
    resetBtn.hidden = zoom.start <= 0.01 && zoom.end >= 99.99;
  };
  function resetZoom() { setZoom(0, 100); }
  frame.addEventListener('keydown', (event) => {
    const span = zoom.end - zoom.start;
    const mid = (zoom.start + zoom.end) / 2;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      showAt((active < 0 ? data.length - 1 : active) + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === 'Home') { event.preventDefault(); showAt(0); }
    else if (event.key === 'End') { event.preventDefault(); showAt(data.length - 1); }
    else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      const minSpan = data.length > 1 ? ((MIN_POINTS_IN_VIEW - 1) / (data.length - 1)) * 100 : 100;
      const next = Math.max(minSpan, span * (1 - ZOOM_STEP));
      setZoom(Math.max(0, Math.min(100 - next, mid - next / 2)), Math.max(0, Math.min(100 - next, mid - next / 2)) + next);
    } else if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      const next = Math.min(100, span * (1 + ZOOM_STEP));
      const start = Math.max(0, Math.min(100 - next, mid - next / 2));
      setZoom(start, start + next);
    } else if (event.key === '0') { event.preventDefault(); resetZoom(); }
    else if (event.key === 'Escape') { active = -1; chart.chart()?.dispatchAction({ type: 'hideTip' }); }
  });
  frame.addEventListener('blur', () => { active = -1; chart.chart()?.dispatchAction({ type: 'hideTip' }); });

  const resetBtn = h('button', { type: 'button', class: 'btn btn--ghost tchartbox__reset', hidden: true, on: { click: () => resetZoom() } }, 'Reset zoom');
  const legendEl = series.length > 1 ? h('ul', { class: 'legend legend--inline legend--toggle' }, series.map((s) => h('li', {}, h('button', {
    type: 'button', class: 'legend__btn', 'aria-pressed': 'true', 'data-series': s.key, title: `Show or hide ${s.label}`,
    on: { click: (event) => {
      const on = !visible[s.key];
      if (!on && series.filter((x) => visible[x.key]).length <= 1) return;
      visible[s.key] = on;
      event.currentTarget.setAttribute('aria-pressed', String(on));
      chart.render();
    } },
  }, h('span', { class: `legend__key legend__key--${kind === 'line' ? 'line' : 'box'} ect__sw--${s.cls}${s.dash ? ' ect__sw--dash' : ''}`, 'aria-hidden': 'true' }), s.label)))) : h('span', {});
  const table = h('details', { class: 'chart__table' }, h('summary', { text: 'View as table' }), h('div', { class: 'tablewrap' }));
  table.addEventListener('toggle', () => { if (table.open) fillTable(); });
  function fillTable() {
    const host2 = table.querySelector('.tablewrap');
    while (host2.firstChild) host2.firstChild.remove();
    if (!data.length) { host2.append(h('p', { class: 'card__note', text: emptyText })); return; }
    host2.append(h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, tableLabel), series.map((s) => h('th', { scope: 'col', class: 'num' }, s.label)))),
      h('tbody', {}, data.slice(-TABLE_ROWS).reverse().map((p) => h('tr', {}, h('td', {}, xFmt(p.t, true)), series.map((s) => h('td', { class: 'num' }, fmtVal(p.values[s.key], s.key))))))));
  }

  const el = h('div', { class: 'tchartbox' }, frame, hint, h('div', { class: 'tchartbox__bar' }, legendEl, resetBtn), table);
  return {
    el,
    /** Replaces the data. Keeps the zoom and the series switches. */
    update(points) {
      data = points;
      const empty = !hasData();
      emptyMsg.hidden = !empty;
      frame.dataset.empty = String(empty);
      chart.render();
      if (table.open) fillTable();
    },
    setMarkers(list) { markerList = list; chart.render(); },
    resetZoom,
    /** For tests: the current zoom as fractions of the data, the series switches and the number of points. */
    state: () => ({ view: { a: zoom.start / 100, b: zoom.end / 100 }, visible: { ...visible }, points: data.length, empty: !hasData() }),
  };
}

/**
 * Horizontal bars for a short list (alerts by status and the like), with the value at the end of each bar.
 *
 * Args: id; title; items [{ label, value, cls, note? }]; fmt(value).
 * Returns: an element.
 */
export function barList({ id, title, items, fmt = (v) => String(v) }) {
  const host = h('div', { class: 'blist__canvas' });
  host.style.height = `${items.length * BAR_ROW_H + 8}px`;
  const el = h('div', { class: 'blist', role: 'img', 'data-chart': id, 'aria-label': title }, host);
  mount(host, (t) => ({
    grid: { left: 4, right: 44, top: 4, bottom: 4, containLabel: true },
    tooltip: { ...tooltipBase(t), trigger: 'item', formatter: (p) => `<div class="ect__row"><span class="ect__sw ect__sw--${esc(items[p.dataIndex].cls)}"></span><span class="ect__k">${esc(items[p.dataIndex].label)}</span><span class="ect__v">${esc(fmt(items[p.dataIndex].value))}</span></div>${items[p.dataIndex].note ? `<div class="ect__note">${esc(items[p.dataIndex].note)}</div>` : ''}` },
    xAxis: { type: 'value', show: false, max: Math.max(1, ...items.map((i) => i.value)) },
    yAxis: categoryAxis(t, items.map((i) => i.label), null, { inverse: true, axisLine: { show: false }, axisLabel: { color: t.ink, fontSize: 12, fontFamily: t.sans, margin: 12 } }),
    series: [{
      type: 'bar', barWidth: 14, showBackground: true, backgroundStyle: { color: t.sunken, borderRadius: 2 },
      data: items.map((i) => ({ value: i.value, itemStyle: { color: seriesColour(i.cls), borderRadius: 2 } })),
      label: { show: true, position: 'right', color: t.dim, fontSize: 12, fontFamily: t.sans, formatter: (p) => fmt(p.value) },
      emphasis: { disabled: true },
    }],
  })).render();
  return el;
}
