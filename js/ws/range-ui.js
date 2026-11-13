/** Shared pieces of the 1D to 3Y range UI: the radiogroup and the key to empty buckets. DOM only; the bucketing is in timerange.js. */
import { h, segmented } from './dom.js';
import { RANGES } from './timerange.js';

const RANGE_CAPTION = 'Time range';

/** First letter capitalised. */
export const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The range buttons (1D, 1W, 1M, 3M, 6M, 1Y, 3Y) as a radiogroup.
 *
 * Args: id, prefix for the button ids (`${id}-1M`); value, the selected key; onPick(key).
 */
export function rangeControl({ id, value, onPick }) {
  return segmented({ label: RANGE_CAPTION, options: RANGES.map((r) => ({ value: r.key, label: r.key })), value, onChange: onPick, radio: true, idPrefix: id });
}

/** The key under a range chart naming the kinds of empty bucket it contains, or null when it has none. */
export function gapKey({ none, off }) {
  if (!none && !off) return null;
  return h('div', { class: 'rangekey', 'aria-label': 'Key to empty buckets' },
    none ? h('span', {}, h('span', { class: 'gapkey gapkey--none', 'aria-hidden': 'true' }), 'No records') : null,
    off ? h('span', {}, h('span', { class: 'gapkey gapkey--off', 'aria-hidden': 'true' }), 'Not recording') : null);
}
