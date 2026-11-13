/** Live view: a synthetic payment stream screened through the real engine, with charts that update in place. */
import { card, clear, h, icon, money, outcomeTag, segmented, shortAddr, svg } from './dom.js';
import { zoneName } from './dom.js';
import { formatClock, formatClockPrecise } from './settings.js';
import { compact, sparkline, timeChart } from './live-chart.js';
import { gateLabel, gateText } from './gate.js';
import { chip, guardedButton, roleReason } from './moat-ui.js';
import { CHAIN_LABEL, LIVE_MAX_RECEIPTS, SPEEDS } from './stream.js';
import { HOUR_MS } from './util.js';

const TAPE_ROWS = 60;
const THROUGHPUT_S = 120;
const LATENCY_BUCKET_S = 5;
const LATENCY_POINTS = 24;
const VALUE_BUCKET_S = 10;
const VALUE_POINTS = 30;
const SPARK_S = 40;
const MIX_W = 100;

const hms = (t) => formatClock(t);
const hm = (t) => formatClock(t).slice(0, 5);

/** Alerts opened per UTC hour for the last 24 hours: workspace alerts plus live flags. */
export function alertsPerHour(ws, tape, endMs, hours = 24) {
  const end = Math.floor(endMs / HOUR_MS);
  return tape.flagsPerHour(endMs, hours).map((l, k) => {
    const hour = end - (hours - 1 - k);
    const n = ws.alerts.filter((a) => Math.floor(Date.parse(a.createdAt) / HOUR_MS) === hour).length;
    return { t: hour * HOUR_MS, values: { workspace: n, flags: l.hold + l.block } };
  });
}

export function renderLive(ctx, root) {
  const { live, ws } = ctx;
  const { tape, runner } = live;
  clear(root);

  // ---- controls ----------------------------------------------------------------------------
  const toggle = h('button', { type: 'button', class: 'btn btn--primary', id: 'lv-toggle' });
  const stop = h('button', { type: 'button', class: 'btn', id: 'lv-stop' }, 'Stop');
  const speed = h('div', { id: 'lv-speed' });
  const pill = h('span', { class: 'livepill', id: 'lv-pill' });
  const info = h('span', { class: 'muted', id: 'lv-info' });
  const verifyOut = h('div', { id: 'lv-verify', role: 'status', 'aria-live': 'polite' });
  toggle.addEventListener('click', () => { if (runner.state === 'live') runner.pause(); else runner.start(); });
  stop.addEventListener('click', () => runner.stop());
  const verifyBtn = h('button', { type: 'button', class: 'btn', id: 'lv-verify-btn', on: { click: async () => {
    if (!tape.ledger.size) { clear(verifyOut).append(h('p', { class: 'field__hint', text: 'Nothing to verify yet. Start the stream first.' })); return; }
    const result = await ctx.measure.time('live_verify', 'Live window verified', () => tape.verify(), (r) => ({ receipts: tape.ledger.size, segments: r.segments.length }));
    clear(verifyOut).append(h('div', { class: 'banner', 'data-state': result.ok ? 'pass' : 'fail' },
      h('span', { class: 'banner__lead', text: result.ok ? 'Live window verifies' : 'Live window failed' }),
      h('span', { class: 'banner__detail', text: `${tape.ledger.size} receipts in ${result.segments.length} segments, checked with the same verifier as the Verify receipts page.` })));
  } } }, 'Verify live window');

  let controlKey = '';
  const drawControls = () => {
    const key = `${runner.state}|${runner.speed}`;
    if (key === controlKey) return;
    controlKey = key;
    const state = runner.state;
    clear(toggle).append(icon(state === 'live' ? 'pause' : 'play'), state === 'live' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start stream');
    stop.disabled = state === 'off';
    pill.dataset.state = state;
    pill.textContent = state === 'live' ? 'LIVE' : state === 'paused' ? 'PAUSED' : 'OFF';
    clear(speed).append(segmented({ label: 'Speed', value: String(runner.speed), options: SPEEDS.map((s) => ({ value: String(s), label: `${s}x` })), onChange: (v) => runner.setSpeed(Number(v)) }));
  };

  // ---- KPI strip ---------------------------------------------------------------------------
  const kpiDefs = [['screened', 'Screened'], ['rate', 'Per second'], ['hold', 'Held by policy'], ['block', 'Hits on the list'], ['value', 'Value screened']];
  const kn = Object.fromEntries(kpiDefs.map(([key]) => [key, { value: h('dd', { text: '0' }), sub: h('p', { class: 'kpi__sub' }), spark: h('div', { class: 'kpi__spark' }) }]));
  const kpis = h('dl', { class: 'kpis kpis--live' }, kpiDefs.map(([key, label]) => h('div', { class: 'kpi' }, h('dt', { text: label }), kn[key].value, kn[key].sub, kn[key].spark)));

  // ---- charts ------------------------------------------------------------------------------
  const throughput = timeChart({ id: 'c-thru', integerAxis: true, title: 'Screenings per second over the last 2 minutes, by decision', mode: 'bars', stacked: true, series: [
    { key: 'allow', label: 'Allow', cls: 'allow' }, { key: 'hold', label: 'Hold', cls: 'hold' }, { key: 'block', label: 'Hit', cls: 'block', pattern: true }],
  xFmt: hms, tableLabel: `Time (${zoneName()})` });
  const msFmt = (v) => (v === null || v === undefined ? 'no data' : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
  const latencyChart = timeChart({ id: 'c-lat', title: 'Screening latency p50 and p95 in milliseconds, measured in this browser', mode: 'line', series: [
    { key: 'p50', label: 'p50', cls: 'p50' }, { key: 'p95', label: 'p95', cls: 'p95', dash: true }], xFmt: hms, yFmt: msFmt, tableLabel: `Time (${zoneName()})` });
  const valueChart = timeChart({ id: 'c-val', title: 'Value screened in synthetic US dollars per 10 seconds', mode: 'bars', stacked: true, series: [{ key: 'usd', label: 'Value', cls: 'value' }],
    xFmt: hms, yFmt: (v) => `$${compact(v)}`, tableLabel: 'Window ending (UTC)' });
  const alertsChart = timeChart({ id: 'c-alerts', integerAxis: true, title: 'Alerts opened per hour over the last 24 hours: workspace alerts and stream flags', mode: 'bars', stacked: true, series: [
    { key: 'workspace', label: 'Workspace alerts', cls: 's-open' }, { key: 'flags', label: 'Stream flags', cls: 'flags' }], xFmt: (t) => `${hm(t)} UTC`, tableLabel: 'Hour (UTC)' });

  const gateChart = timeChart({ id: 'c-gate-live', integerAxis: true, title: 'Gate decisions per second over the last 2 minutes: released and blocked', mode: 'bars', stacked: true, series: [
    { key: 'rel', label: 'Released', cls: 'gpass' }, { key: 'blk', label: 'Blocked', cls: 'gblock', pattern: true }], xFmt: hms, tableLabel: `Time (${zoneName()})` });
  const gateList = h('ul', { class: 'plain', id: 'lv-gate-reasons' });
  const gateOut = h('div', { id: 'lv-gate-out', role: 'status', 'aria-live': 'polite' });
  const gateToggle = h('button', { type: 'button', class: 'btn', id: 'lv-gate-toggle', 'aria-pressed': String(tape.gateOn), on: { click: () => { tape.gateOn = !tape.gateOn; gateToggle.setAttribute('aria-pressed', String(tape.gateOn)); gateToggle.textContent = tape.gateOn ? 'Gate on' : 'Gate off'; } } }, tape.gateOn ? 'Gate on' : 'Gate off');
  const gateReason = roleReason(ws, ctx.userId, 'gate_use');
  const tryGate = (id) => guardedButton({ label: id === 'none' ? 'Try a transfer with no receipt' : 'Try a receipt from an older list', id: `lv-gate-${id}`, reason: gateReason, onClick: async () => {
    const out = await ctx.gate(id, { refresh: false });
    if (!out.ok) return;
    const r = out.record;
    clear(gateOut).append(h('div', { class: 'banner', 'data-state': r.release ? 'pass' : 'fail' }, h('span', { class: 'banner__lead', text: r.release ? 'RELEASED' : 'BLOCKED' }),
      h('span', { class: 'banner__detail', text: r.release ? 'Valid, current receipt.' : r.reasons.map((c) => gateText(c)).join(' ') }),
      h('button', { type: 'button', class: 'linkbtn mono', on: { click: () => ctx.openReceipt(r.receiptId) } }, r.receiptId.replace('rcpt:', ''))));
    ctx.refreshChrome();
  } });
  const mixRects = ['allow', 'hold', 'block'].map((k) => svg('rect', { y: 0, height: 10, x: 0, width: 0, class: `bar bar--${k}` }));
  const mixSvg = svg('svg', { viewBox: `0 0 ${MIX_W} 10`, class: 'mix', preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Decision mix for the stream' }, ...mixRects);
  const mixLegend = h('ul', { class: 'mixlegend' });

  // ---- tape --------------------------------------------------------------------------------
  const tbody = h('tbody', { id: 'lv-tape' });
  const empty = h('p', { class: 'tape__empty', id: 'lv-empty', text: 'The stream is off. Press Start stream.' });
  const head = ['Time (UTC)', 'Chain', 'Asset', 'Amount', 'From', 'To', 'Decision', 'Gate', 'Receipt'];
  const tableEl = h('div', { class: 'tablewrap tablewrap--scroll tape' }, h('table', { class: 'grid grid--tape' },
    h('caption', { class: 'sr', text: 'Latest screened payments, newest first' }),
    h('thead', {}, h('tr', {}, head.map((t, i) => h('th', { scope: 'col', class: i === 3 ? 'num' : '' }, t)))), tbody));

  const rowFor = (r, flash) => {
    const kind = r.outcome === 'ALLOW' ? '' : ` tape__row--${r.outcome.toLowerCase()}${flash && !live.reducedMotion ? ' tape__row--flash' : ''}`;
    const receipt = h('button', { type: 'button', class: 'linkbtn mono', 'data-rownav': '', on: { click: () => ctx.openLive(r) } }, r.receiptId.replace('rcpt:', ''));
    return h('tr', { class: `grid__row tape__row${kind}`, 'data-outcome': r.outcome },
      h('td', { 'data-label': 'Time (UTC)', class: 'num-l', text: formatClockPrecise(r.t) }), h('td', { 'data-label': 'Chain', text: CHAIN_LABEL[r.chain] }), h('td', { 'data-label': 'Asset', text: r.asset }),
      h('td', { 'data-label': 'Amount', class: 'num', text: money(r.amountUsd) }),
      h('td', { 'data-label': 'From', class: 'mono', title: r.from, text: shortAddr(r.from) }), h('td', { 'data-label': 'To', class: 'mono', title: r.to, text: shortAddr(r.to) }),
      h('td', { 'data-label': 'Decision' }, outcomeTag(r.outcome)),
      h('td', { 'data-label': 'Gate' }, r.gate ? (r.gate.release ? chip('Released', 'ok') : chip(`Blocked: ${gateLabel(r.gate.reasons[0])}`, 'bad')) : h('span', { class: 'muted', text: 'off' })),
      h('td', { 'data-label': 'Receipt' }, receipt));
  };

  // ---- update ------------------------------------------------------------------------------
  let lastIssued = -1;
  let lastSecond = -1;
  const update = () => {
    drawControls();
    const now = ctx.now().getTime();
    const fresh = live.drain();
    if (fresh.length) {
      empty.hidden = true;
      const frag = document.createDocumentFragment();
      for (const r of fresh.slice(-TAPE_ROWS).reverse()) frag.append(rowFor(r, true));
      tbody.prepend(frag);
      while (tbody.children.length > TAPE_ROWS) tbody.lastChild.remove();
    }
    const second = Math.floor(now / 1000);
    if (tape.issued === lastIssued && second === lastSecond) return;
    if (tape.issued === lastIssued && runner.state !== 'live') return;
    lastIssued = tape.issued;
    lastSecond = second;
    const t = tape.totals;
    const sec = tape.series(now, 1, THROUGHPUT_S);
    const recent = sec.slice(-SPARK_S);
    kn.screened.value.textContent = String(tape.issued);
    kn.screened.sub.textContent = 'this session';
    kn.rate.value.textContent = tape.rate(now).toFixed(1);
    kn.rate.sub.textContent = `at ${runner.speed}x`;
    kn.hold.value.textContent = String(t.hold);
    kn.hold.sub.textContent = tape.issued ? `${((t.hold / tape.issued) * 100).toFixed(1)}% of stream` : 'no data yet';
    kn.block.value.textContent = String(t.block);
    kn.block.sub.textContent = tape.issued ? `${((t.block / tape.issued) * 100).toFixed(1)}% of stream` : 'no data yet';
    kn.value.value.textContent = `$${compact(t.usd)}`;
    kn.value.sub.textContent = 'USD';
    gateChart.update(sec.map((r) => ({ t: r.t, values: { rel: r.rel, blk: r.blk } })));
    clear(gateList).append(...(Object.entries(tape.gateTotals.byReason).length ? Object.entries(tape.gateTotals.byReason).sort((a, b) => b[1] - a[1]).map(([c, n]) => h('li', {}, h('strong', { text: `${gateLabel(c)}: ` }), `${n}`)) : [h('li', { text: 'Nothing blocked yet.' })]));
    const spark = (key, values, cls) => clear(kn[key].spark).append(sparkline(values, { cls }));
    spark('screened', recent.map((r) => r.total), 'allow');
    spark('rate', recent.map((r) => r.total), 'allow');
    spark('hold', recent.map((r) => r.hold), 'hold');
    spark('block', recent.map((r) => r.block), 'block');
    spark('value', recent.map((r) => r.usd), 'value');

    throughput.update(sec.map((r) => ({ t: r.t, values: { allow: r.allow, hold: r.hold, block: r.block } })));
    latencyChart.update(tape.latencySeries(now, LATENCY_BUCKET_S, LATENCY_POINTS).map((r) => ({ t: r.t, values: { p50: r.p50, p95: r.p95 } })));
    valueChart.update(tape.series(now, VALUE_BUCKET_S, VALUE_POINTS).map((r) => ({ t: r.t, values: { usd: r.usd } })));
    alertsChart.update(alertsPerHour(ws, tape, now));

    const total = Math.max(1, t.allow + t.hold + t.block);
    let x = 0;
    ['allow', 'hold', 'block'].forEach((k, i) => {
      const w = (t[k] / total) * MIX_W;
      mixRects[i].setAttribute('x', x.toFixed(2));
      mixRects[i].setAttribute('width', w.toFixed(2));
      x += w;
    });
    clear(mixLegend).append(...[['allow', 'Allow'], ['hold', 'Hold'], ['block', 'Hit']].map(([k, label]) => h('li', {}, h('span', { class: `mixdot mixdot--${k}`, 'aria-hidden': 'true' }), `${label} `, h('span', { class: 'tnum', text: `${t[k]} (${((t[k] / total) * 100).toFixed(1)}%)` }))));
    info.textContent = `Receipts in the live window: ${tape.ledger.size} (rolls at ${LIVE_MAX_RECEIPTS}).`;
  };

  root.append(
    h('div', { class: 'livebar', role: 'group', 'aria-label': 'Stream controls' }, pill, toggle, stop, h('span', { class: 'livebar__label', text: 'Speed' }), speed, verifyBtn, info),
    verifyOut, kpis,
    h('div', { class: 'cols cols--charts' },
      card('Screenings per second', { id: 'lv-c1', sub: 'Last 2 minutes, UTC' }, throughput.el),
      card('Screening latency', { id: 'lv-c2', sub: 'p50 and p95 in ms, per 5 seconds' }, latencyChart.el),
      card('Value screened', { id: 'lv-c3', sub: 'USD per 10 seconds' }, valueChart.el),
      card('Alerts opened per hour', { id: 'lv-c4', sub: 'Last 24 hours, UTC' }, alertsChart.el)),
    card('Payment gate', { id: 'lv-gate', actions: gateToggle },
      h('div', { class: 'cardbody' }, h('div', { class: 'cols' }, gateChart.el, h('div', {}, h('h3', { class: 'subhead', text: 'Blocked, by reason' }), gateList)),
        h('div', { class: 'btnrow' }, tryGate('none'), tryGate('stale')), gateOut)),
    card('Decision mix', { id: 'lv-mix' }, h('div', { class: 'cardbody' }, mixSvg, mixLegend)),
    card('Tape', { id: 'lv-tape-card' }, empty, tableEl));

  for (const r of tape.events.slice(-TAPE_ROWS).reverse()) { tbody.append(rowFor(r, false)); empty.hidden = true; }
  live.view = update;
  update();
}
