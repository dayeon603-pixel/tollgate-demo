/**
 * Time-series chart used by the Live, Network and Dashboard views. The drawing lives in chartx.js; this
 * keeps the older call shape (mode instead of kind), and holds the KPI sparkline.
 */
import { svg } from './dom.js';
import { compact, createChart, niceCeil } from './chartx.js';

export function timeChart({ mode = 'line', height = 170, ...rest }) {
  return createChart({ kind: mode, height, ...rest });
}

export { compact, niceCeil };

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
