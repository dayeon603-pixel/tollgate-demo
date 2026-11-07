/**
 * Live session: owns the demo stream (tape and runner) and a throttled UI frame loop, so the status
 * bar and the Live view can show the same numbers. The stream is off until the visitor starts it.
 */
import { LiveRunner, LiveTape } from './stream.js';

export const UI_FRAME_MS = 250;

export function createLive(ctx) {
  const tape = new LiveTape({ ws: ctx.ws });
  const live = {
    tape,
    runner: null,
    view: null,
    bar: null,
    pending: [],
    lastBusyMs: 0,
    reducedMotion: Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches),
    /** Records screened since the last frame, oldest first. */
    drain() {
      const out = live.pending;
      live.pending = [];
      return out;
    },
    frame() {
      live.bar?.();
      live.view?.();
    },
    dispose() {
      live.runner.stop();
      clearInterval(timer);
    },
  };
  live.runner = new LiveRunner(tape, {
    onTick: (records, ms) => { live.pending.push(...records); live.lastBusyMs = ms; live.onHits?.(records); },
    onState: () => live.frame(),
  });
  const timer = setInterval(() => { if (!document.hidden) live.frame(); }, UI_FRAME_MS);
  return live;
}
