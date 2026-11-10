/**
 * Shared base for every chart in the workspace, on Apache ECharts 5.6.0 (vendored at
 * js/vendor/echarts.min.js, loaded by app.html as a plain deferred script, so it is `globalThis.echarts`).
 *
 * One look for all charts: colours come from the site's CSS custom properties (the colour-blind-safe
 * status colours --c-allow, --c-hold, --c-block and the rest, plus --ink, --faint, --line, --surface),
 * read at draw time, so a chart follows the theme toggle and high contrast. Thin lines, light
 * gridlines, tabular numbers, one tooltip style. Tooltip markup uses classes only: the page's content
 * security policy forbids inline style attributes (ECharts sets its own container styles through the
 * CSSOM, which the policy allows).
 *
 * Charts are created lazily: the element can be built before it is in the document, and the ECharts
 * instance starts the first time it has a size. A chart whose element has left the document is disposed
 * on the next sweep.
 */

const live = new Set();
let themeWatch = null;

/** True when the visitor asked for less motion (the app setting or the system one). */
export const reducedMotion = () => document.documentElement.dataset.motion === 'reduce' || Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** A CSS custom property from the root element, trimmed; `fallback` when unset. */
export function cssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Series colour for a series class such as 'allow', 'hold', 'block', 's-open'. */
export const seriesColour = (cls) => cssVar(`--c-${cls}`, cssVar('--c-allow', '#0072b2'));

/** The palette every chart draws with, read from the current theme. */
export function theme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    dark,
    ink: cssVar('--ink', dark ? '#e7ebed' : '#15191c'),
    dim: cssVar('--dim', dark ? '#b6c0c6' : '#47525a'),
    faint: cssVar('--faint', dark ? '#98a4ab' : '#5f6b73'),
    line: cssVar('--line', dark ? '#2a343a' : '#e1e4e7'),
    lineStrong: cssVar('--line-strong', dark ? '#3b484f' : '#cdd2d6'),
    surface: cssVar('--surface', dark ? '#161c20' : '#ffffff'),
    sunken: cssVar('--sunken', dark ? '#1b2327' : '#f8f9fa'),
    focus: cssVar('--focus', '#1f6feb'),
    link: cssVar('--link', '#1a5fb4'),
    sans: cssVar('--sans', 'system-ui, sans-serif'),
    mono: cssVar('--mono', 'ui-monospace, monospace'),
    /** Gridlines lighter than the hairline token, so the marks lead. */
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(21,25,28,0.07)',
  };
}

/** Escapes text for the tooltip's HTML. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tooltip box options shared by every chart (styled by .ect in css/charts.css). */
export function tooltipBase(t = theme()) {
  return {
    confine: true,
    className: 'ect',
    backgroundColor: t.surface,
    borderColor: t.lineStrong,
    borderWidth: 1,
    padding: [7, 10],
    textStyle: { color: t.ink, fontFamily: t.sans, fontSize: 12 },
    extraCssText: 'box-shadow: 0 4px 14px rgba(0,0,0,0.12); border-radius: 4px;',
    transitionDuration: 0,
  };
}

/** Value axis with light gridlines and no axis line, as in Grafana or TRM. */
export function valueAxis(t, formatter, extra = {}) {
  return {
    type: 'value',
    splitNumber: 4,
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: t.grid, width: 1 } },
    axisLabel: { color: t.faint, fontFamily: t.sans, fontSize: 11, formatter, hideOverlap: true },
    ...extra,
  };
}

/** Category axis: one hairline base, small labels, no overlap. */
export function categoryAxis(t, data, formatter, extra = {}) {
  return {
    type: 'category',
    data,
    axisLine: { lineStyle: { color: t.lineStrong } },
    axisTick: { show: false },
    axisLabel: { color: t.faint, fontFamily: t.sans, fontSize: 11, formatter, hideOverlap: true },
    splitLine: { show: false },
    ...extra,
  };
}

function watchTheme() {
  if (themeWatch || typeof MutationObserver === 'undefined') return;
  themeWatch = new MutationObserver(() => {
    sweep();
    for (const c of live) c.restyle();
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-contrast', 'data-motion'] });
}

/** Disposes charts whose element has left the document. */
export function sweep() {
  for (const c of live) if (!c.host.isConnected && c.started) c.dispose();
}

/**
 * Mounts an ECharts instance on `host` (a div) once it has a size.
 *
 * Args: host, the element to draw in; build(theme), returns the full option for the current data and theme;
 *   onReady(chart), called once after the instance exists (to bind events).
 * Returns: { host, chart(), render(), restyle(), dispose(), started }
 */
export function mount(host, build, onReady = null) {
  watchTheme();
  sweep();
  const handle = {
    host,
    started: false,
    instance: null,
    chart() { return this.instance; },
    /** Draws the current data, starting the instance if the host has a size. */
    render() {
      if (!this.instance) {
        if (!host.isConnected || !host.clientWidth || !globalThis.echarts) return;
        this.instance = globalThis.echarts.init(host, null, { renderer: 'canvas' });
        this.started = true;
        live.add(this);
        if (onReady) onReady(this.instance);
      }
      const option = build(theme());
      option.animation = !reducedMotion() && option.animation !== false;
      option.animationDuration ??= 400;
      option.animationDurationUpdate ??= 250;
      option.textStyle = { fontFamily: theme().sans, ...(option.textStyle ?? {}) };
      this.instance.setOption(option, { replaceMerge: ['series', 'graphic'], lazyUpdate: false });
    },
    restyle() { if (this.instance) this.render(); },
    dispose() {
      ro?.disconnect();
      this.instance?.dispose();
      this.instance = null;
      live.delete(this);
    },
  };
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (!host.isConnected) return;
      if (!handle.instance) handle.render();
      else handle.instance.resize();
    });
    ro.observe(host);
  }
  return handle;
}
