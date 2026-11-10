/** Timings of work done in this browser (the Live view times its own verification with these). */

/** In-memory log of work timed in this browser session. */
export class Measurements {
  constructor() { this.items = []; }

  /** kind: short key; label: what was done; ms; detail: counts. */
  record(kind, label, ms, detail = {}) {
    const item = { kind, label, ms, detail, at: new Date().toISOString() };
    this.items.push(item);
    if (this.items.length > 200) this.items.shift();
    return item;
  }

  /** Newest measurement of each kind. */
  latest() {
    const map = new Map();
    for (const i of this.items) map.set(i.kind, i);
    return Array.from(map.values());
  }

  /** Times an async function and records it. detail may be a function of the result. */
  async time(kind, label, fn, detail = {}) {
    const t0 = performance.now();
    const result = await fn();
    this.record(kind, label, performance.now() - t0, typeof detail === 'function' ? detail(result) : detail);
    return result;
  }
}

export function formatMs(ms) {
  return ms < 10 ? `${ms.toFixed(1)} ms` : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
