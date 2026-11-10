/**
 * List archive: a timeline of the OFAC list publications and postings the Tollgate watcher recorded,
 * each with its fingerprint and the independent timestamps that cover it (OpenTimestamps, which
 * anchors in Bitcoin, and RFC 3161 from a public time-stamp authority). The records come from
 * data/archive.json, built by scripts/build_moat_data.py from the research repo's result files; each
 * row names its source file. The demo workspace's own list versions are listed apart and marked demo.
 */
import { card, clear, h, shortHash } from './dom.js';
import { categoryAxis, esc, mount, seriesColour, tooltipBase } from './echart.js';
import { formatDate, formatStamp, getSettings } from './settings.js';
import { chip, dataTag, sourceRef } from './moat-ui.js';
import { loadMoatData } from './moat-data.js';

const LANES = [
  { id: 'page', label: 'OFAC page seen', shape: 'circle' },
  { id: 'tsa', label: 'RFC 3161 time', shape: 'square' },
  { id: 'btc', label: 'Bitcoin block', shape: 'diamond' },
  { id: 'sdn', label: 'SDN.XML first fetched', shape: 'tri' },
  { id: 'seal', label: 'Seals at block 974,328', shape: 'diamond' },
];
const LANE_H = 34;
const RANGES = [{ id: 'all', label: 'Whole period' }, { id: 'week', label: 'Oct 26 to 30' }, { id: 'day', label: 'Oct 28' }];
const st = { range: 'all', selected: null };
const t = (iso) => Date.parse(iso);
const DAY = 86_400_000;

/** Marks for the swimlane chart, from the archive data. */
export function timelineMarks(archive) {
  const marks = [];
  for (const p of archive.postings) {
    marks.push({ id: `page-${p.receipt_id}`, lane: 'page', t: t(p.observed_at), title: `OFAC recent action ${p.slug} seen`, detail: `${p.addresses_listed} addresses listed. Page fingerprint ${shortHash(p.content_sha256, 12, 6)}. Receipt ${p.receipt_id}.`, row: `posting-${p.receipt_id}` });
    marks.push({ id: `tsa-${p.receipt_id}`, lane: 'tsa', t: t(p.anchor.rfc3161_time), title: `RFC 3161 time ${p.anchor.rfc3161_time}`, detail: `Batch ${p.anchor.batch} covers receipt ${p.receipt_id}.`, row: `posting-${p.receipt_id}` });
    const first = p.anchor.bitcoin[0];
    marks.push({ id: `btc-${p.receipt_id}`, lane: 'btc', t: t(first.block_time), title: `Bitcoin block ${first.height}`, detail: `Block time ${first.block_time}. Covers receipt ${p.receipt_id} through batch ${p.anchor.batch}.`, row: `posting-${p.receipt_id}` });
  }
  for (const [publish, fetched] of Object.entries(archive.fetches.first_seen_by_publish_date)) {
    marks.push({ id: `sdn-${publish}`, lane: 'sdn', t: t(fetched), title: `SDN.XML publication ${publish}`, detail: `First fetched ${fetched}.`, row: `sdn-${publish}` });
  }
  for (const s of archive.seals.seals) {
    marks.push({ id: `seal-${s.batch}`, lane: 'seal', t: t(s.header_time), title: `Block ${s.bitcoin_height.toLocaleString('en-US')}`, detail: `Seal "${s.label}" (batch ${s.batch}), header time ${s.header_time}.`, row: 'seals' });
  }
  return marks;
}

const SYMBOL = { circle: 'circle', square: 'rect', diamond: 'diamond', tri: 'triangle' };
const LANE_STYLE = {
  page: (t) => ({ color: seriesColour('allow') }),
  tsa: (t) => ({ color: seriesColour('hold') }),
  btc: (t) => ({ color: t.surface, borderColor: t.ink, borderWidth: 2 }),
  sdn: (t) => ({ color: t.ink }),
  seal: (t) => ({ color: t.surface, borderColor: seriesColour('s-cleared'), borderWidth: 2.5 }),
};

/** Swimlane timeline on ECharts: one lane per kind of record, time across. Arrow keys move between marks, Enter selects. */
function swimlane(archive, onSelect) {
  const all = timelineMarks(archive);
  const t0 = t(archive.live_proof.t0);
  const end = Math.max(...all.map((m) => m.t));
  const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
  const [lo, hi] = st.range === 'day' ? [dayStart(t('2026-10-28T00:00:00Z')), dayStart(t('2026-10-28T00:00:00Z')) + DAY]
    : st.range === 'week' ? [dayStart(t0), dayStart(t('2026-10-30T00:00:00Z')) + DAY] : [dayStart(t0), dayStart(end) + DAY];
  const marks = all.filter((m) => m.t >= lo && m.t <= hi).sort((a, b) => a.t - b.t);
  const host = h('div', { class: 'echost' });
  host.style.height = `${LANES.length * LANE_H + 44}px`;
  const frame = h('div', { class: 'tchart', tabindex: 0, role: 'group', id: 'arc-lane', 'aria-roledescription': 'timeline',
    'aria-label': 'Timeline of OFAC postings seen and the independent timestamps that cover them. Arrow keys move between marks, Enter jumps to the row. Each mark is also listed in the tables below.' }, host);
  const announce = h('p', { class: 'sr', role: 'status', 'aria-live': 'polite' });
  let focus = -1;
  const laneIndex = (m) => LANES.findIndex((l) => l.id === m.lane);
  const chart = mount(host, (th) => {
    const links = archive.postings.map((p) => [t(p.observed_at), t(p.anchor.bitcoin[0].block_time)]).filter(([a, b]) => a >= lo && b <= hi);
    return {
      grid: { left: 8, right: 16, top: 8, bottom: 4, containLabel: true },
      tooltip: { ...tooltipBase(th), trigger: 'item', formatter: (p) => { const m = p.data?.m; return m ? `<div class="ect__head">${esc(formatStamp(m.t))}</div><div><strong>${esc(m.title)}</strong></div><div class="ect__note">${esc(m.detail)}</div>` : ''; } },
      xAxis: { type: 'time', min: lo, max: hi, axisLine: { lineStyle: { color: th.lineStrong } }, axisTick: { show: false }, splitLine: { show: true, lineStyle: { color: th.grid } },
        axisLabel: { color: th.faint, fontSize: 11, hideOverlap: true, formatter: (v) => formatDate(v).slice(getSettings().dateFormat === 'long' ? 0 : 5, getSettings().dateFormat === 'long' ? -6 : undefined) } },
      yAxis: categoryAxis(th, LANES.map((l) => l.label), null, { inverse: true, axisLine: { show: false }, splitLine: { show: true, lineStyle: { color: th.grid, type: [2, 4] } }, axisLabel: { color: th.dim, fontSize: 12, fontFamily: th.sans } }),
      series: [
        { type: 'lines', coordinateSystem: 'cartesian2d', silent: true, z: 1, polyline: false,
          data: links.map(([a, b]) => ({ coords: [[a, 0], [b, 2]] })), lineStyle: { color: th.faint, width: 1, type: [3, 3], opacity: 0.7 } },
        { type: 'scatter', z: 3, cursor: 'pointer',
          data: marks.map((m, i) => {
            const on = st.selected === m.row || i === focus;
            return { value: [m.t, laneIndex(m)], m, symbol: SYMBOL[LANES[laneIndex(m)].shape], symbolSize: on ? 15 : 11,
              itemStyle: { borderColor: th.surface, borderWidth: 1.5, ...LANE_STYLE[m.lane](th), ...(on ? { shadowBlur: 0, borderColor: th.focus, borderWidth: 2.5 } : {}) } };
          }),
          emphasis: { scale: 1.3 } },
      ],
    };
  }, (inst) => inst.on('click', (p) => { if (p.data?.m) onSelect(p.data.m.row); }));
  chart.render();
  const move = (i) => {
    if (!marks.length) return;
    focus = (i + marks.length) % marks.length;
    chart.render();
    chart.chart()?.dispatchAction({ type: 'showTip', seriesIndex: 1, dataIndex: focus });
    announce.textContent = `${marks[focus].title}. ${marks[focus].detail}`;
  };
  frame.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(focus + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(focus - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && focus >= 0) { e.preventDefault(); onSelect(marks[focus].row); }
    else if (e.key === 'Escape') { chart.chart()?.dispatchAction({ type: 'hideTip' }); }
  });
  return h('div', {}, frame, announce);
}

const idOf = (row) => `arc-${row}`;

export async function renderArchive(ctx, root) {
  const { ws } = ctx;
  clear(root);
  root.append(h('div', { class: 'skeleton' }, h('div', { class: 'skeleton__row' }), h('div', { class: 'skeleton__row' })));
  let archive;
  try {
    archive = await loadMoatData('archive');
  } catch (error) {
    clear(root).append(h('div', { class: 'banner', 'data-state': 'unsupported', role: 'alert' }, h('span', { class: 'banner__lead', text: 'The archive data could not be read' }), h('span', { class: 'banner__detail', text: error.message })));
    return;
  }
  clear(root);
  const live = archive.live_proof;
  const days = ((t(live.t1) - t(live.t0)) / DAY).toFixed(1);
  const blocks = archive.postings.flatMap((p) => p.anchor.bitcoin.map((b) => b.height));

  const redraw = () => ctx.refresh();
  const lane = swimlane(archive, (row) => {
    st.selected = row;
    const node = document.getElementById(idOf(row));
    if (node) { node.scrollIntoView({ block: 'center', behavior: getSettings().reduceMotion ? 'auto' : 'smooth' }); node.focus({ preventScroll: true }); }
    redraw();
  });
  const rangeBar = h('div', { class: 'seg', role: 'group', 'aria-label': 'Time range' }, RANGES.map((r) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(st.range === r.id), on: { click: () => { st.range = r.id; redraw(); } } }, r.label)));

  const postingRows = [...archive.postings].sort((a, b) => t(a.observed_at) - t(b.observed_at));
  const rowAttrs = (row) => ({ id: idOf(row), tabindex: -1 });
  const postings = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'arc-postings' },
    h('caption', { class: 'sr', text: 'OFAC postings the watcher saw, with the timestamps that cover each one' }),
    h('thead', {}, h('tr', {}, ['Posting', 'Seen (UTC)', 'Page fingerprint', 'RFC 3161', 'Bitcoin block (OpenTimestamps)', 'Proof files'].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', {}, postingRows.map((p) => h('tr', { ...rowAttrs(`posting-${p.receipt_id}`), class: `grid__row${st.selected === `posting-${p.receipt_id}` ? ' grid__row--sel' : ''}`, 'data-selected': String(st.selected === `posting-${p.receipt_id}`) },
      h('td', { 'data-label': 'Posting' }, h('a', { href: p.url, rel: 'noreferrer noopener', target: '_blank', text: p.slug }), p.addresses_listed ? h('span', { class: 'muted', text: ` · ${p.addresses_listed} addresses` }) : null),
      h('td', { 'data-label': 'Seen', class: 'tnum', text: p.observed_at.replace('T', ' ').replace('Z', '') }),
      h('td', { 'data-label': 'Page fingerprint', class: 'mono', title: p.content_sha256, text: shortHash(p.content_sha256, 12, 6) }),
      h('td', { 'data-label': 'RFC 3161', class: 'tnum', text: p.anchor.rfc3161_time.replace('T', ' ').replace('Z', '') }),
      h('td', { 'data-label': 'Bitcoin', class: 'tnum', text: p.anchor.bitcoin.map((b) => `${b.height} (${b.block_time.replace('T', ' ').replace('Z', '')})`).join('; ') }),
      h('td', { 'data-label': 'Proof files', class: 'mono' }, `batch_${String(p.anchor.batch).padStart(5, '0')}.ots ${p.anchor.ots.sha256.slice(0, 8)}, .tsr ${p.anchor.tsr.sha256.slice(0, 8)}`))))));

  const snap = archive.snapshot;
  const mirror = archive.mirror;
  const publications = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'arc-lists' },
    h('caption', { class: 'sr', text: 'List publications and their fingerprints' }),
    h('thead', {}, h('tr', {}, ['List', 'Time', 'Fingerprint', 'Independent timestamp', 'Source'].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', {},
      h('tr', { ...rowAttrs('sdn-10/21/2026'), class: 'grid__row', 'data-selected': String(st.selected === 'sdn-10/21/2026') },
        h('td', { 'data-label': 'List' }, `OFAC SDN publication ${snap.publish_date}`, h('br'), dataTag('real'), ' ', h('span', { class: 'muted', text: 'the list this demo screens against' })),
        h('td', { 'data-label': 'Time', class: 'tnum', text: `fetched ${snap.fetched_at}` }),
        h('td', { 'data-label': 'Fingerprint', class: 'mono', title: snap.list_digest, text: `list ${shortHash(snap.list_digest, 12, 6)}; raw XML ${shortHash(snap.raw_sha256, 12, 6)}` }),
        h('td', { 'data-label': 'Independent timestamp' }, chip('None on the list file itself', 'neutral'), h('p', { class: 'field__hint', text: 'The fingerprint was recorded. The first independent timestamps in this archive cover the postings above, not this file.' })),
        h('td', { 'data-label': 'Source' }, sourceRef(snap.source.path, snap.source.sha256))),
      h('tr', { ...rowAttrs('sdn-10/28/2026'), class: 'grid__row', 'data-selected': String(st.selected === 'sdn-10/28/2026') },
        h('td', { 'data-label': 'List' }, 'OFAC SDN publication 10/28/2026', h('br'), dataTag('real')),
        h('td', { 'data-label': 'Time', class: 'tnum', text: `first fetched ${archive.fetches.first_seen_by_publish_date['10/28/2026']}` }),
        h('td', { 'data-label': 'Fingerprint', text: 'Not kept in the committed inputs' }),
        h('td', { 'data-label': 'Independent timestamp' }, chip('None on the list file itself', 'neutral')),
        h('td', { 'data-label': 'Source' }, sourceRef(archive.fetches.source.path, archive.fetches.source.sha256))),
      h('tr', { class: 'grid__row' },
        h('td', { 'data-label': 'List' }, 'August 2023 public mirror of the list', h('br'), dataTag('real'), ' ', h('span', { class: 'muted', text: 'behind the sample receipts' })),
        h('td', { 'data-label': 'Time', class: 'tnum', text: `decision moment ${mirror.decision_moment}` }),
        h('td', { 'data-label': 'Fingerprint', class: 'mono', title: mirror.list_snapshot, text: `${shortHash(mirror.list_snapshot, 12, 6)} (${mirror.list_entries} entries)` }),
        h('td', { 'data-label': 'Independent timestamp' }, chip('None', 'neutral'), h('p', { class: 'field__hint', text: 'Reconstructed after the fact from a public mirror. It shows the format, not a time anyone can vouch for.' })),
        h('td', { 'data-label': 'Source' }, sourceRef(mirror.source.path, mirror.source.sha256))))));

  const seals = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'arc-seals' },
    h('caption', { class: 'sr', text: 'Shared-receipt seals taken to a Bitcoin block' }),
    h('thead', {}, h('tr', {}, ['Seal', 'State', 'Bitcoin block', 'Header time (UTC)', 'Root'].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', { ...rowAttrs('seals') }, archive.seals.seals.map((s) => h('tr', { class: 'grid__row' },
      h('td', { 'data-label': 'Seal', text: `${s.label} (batch ${s.batch})` }), h('td', { 'data-label': 'State', text: s.state }),
      h('td', { 'data-label': 'Bitcoin block', class: 'tnum', text: s.bitcoin_height.toLocaleString('en-US') }), h('td', { 'data-label': 'Header time', class: 'mono', text: s.header_time.replace('T', ' ').replace('Z', '') }),
      h('td', { 'data-label': 'Root', class: 'mono', title: s.root, text: shortHash(s.root, 12, 6) }))))));

  const demoVersions = h('div', { class: 'tablewrap' }, h('table', { class: 'grid', id: 'arc-demo' },
    h('caption', { class: 'sr', text: 'List versions in this demo workspace' }),
    h('thead', {}, h('tr', {}, ['Version', 'Origin', 'Fingerprint', 'Addresses', 'Independent timestamp'].map((c) => h('th', { scope: 'col', text: c })))),
    h('tbody', {}, ws.versions.map((v) => h('tr', { class: 'grid__row' },
      h('td', { 'data-label': 'Version', text: `${v.label}${ws.inForceId === v.id ? ' (in force)' : ''}` }),
      h('td', { 'data-label': 'Origin' }, v.real ? [dataTag('real'), ` OFAC publication ${v.publishDate}`] : [dataTag('demo'), ' reconstruction for this workspace']),
      h('td', { 'data-label': 'Fingerprint', class: 'mono', title: v.digest, text: shortHash(v.digest, 12, 6) }), h('td', { 'data-label': 'Addresses', class: 'num', text: String(v.addressCount) }),
      h('td', { 'data-label': 'Independent timestamp', text: v.real ? 'See the SDN row above' : 'None (demo version)' }))))));

  const gapGraphic = h('div', { class: 'backfill', role: 'img', 'aria-label': `Anchored record starts at ${live.t0}. Nothing anchored exists before it. A recorder that starts today has no days.` },
    h('div', { class: 'backfill__row' }, h('span', { class: 'backfill__label', text: 'Before 2026-10-26' }), h('span', { class: 'backfill__bar backfill__bar--none', text: 'No anchored record. Cannot be made later.' })),
    h('div', { class: 'backfill__row' }, h('span', { class: 'backfill__label', text: `${live.t0.slice(0, 10)} to ${live.t1.slice(0, 10)}` }), h('span', { class: 'backfill__bar backfill__bar--have', text: `${days} days recorded: ${live.receipts} receipts, ${live.bitcoin_confirmed} in Bitcoin blocks` })),
    h('div', { class: 'backfill__row' }, h('span', { class: 'backfill__label', text: 'A recorder starting today' }), h('span', { class: 'backfill__bar backfill__bar--zero', text: '0 days. Starts here.' })));

  root.append(
    h('p', { class: 'demo-line' }, 'Real records from Tollgate\'s research runs. Each row names its source file.'),
    card('Recorded history', { id: 'arc-why' },
      h('div', { class: 'cardbody' },
        h('p', { class: 'moat-lead', text: 'Every list we saw was timestamped in Bitcoin as it happened. Someone starting today cannot go back and record these days.' }),
        gapGraphic,
        h('dl', { class: 'kpis kpis--moat' },
          h('div', { class: 'kpi' }, h('dt', { text: 'Receipts anchored' }), h('dd', { text: `${live.anchored} of ${live.receipts}` }), h('p', { class: 'kpi__sub', text: `in ${live.batches} batches, all re-verified` })),
          h('div', { class: 'kpi' }, h('dt', { text: 'Bitcoin blocks' }), h('dd', { text: `${Math.min(...blocks).toLocaleString('en-US')} to ${Math.max(...blocks).toLocaleString('en-US')}` }), h('p', { class: 'kpi__sub', text: 'OpenTimestamps attestations' })),
          h('div', { class: 'kpi' }, h('dt', { text: 'OFAC postings seen' }), h('dd', { text: String(archive.postings.length) }), h('p', { class: 'kpi__sub', text: `${archive.postings.filter((p) => p.addresses_listed).length} carried a digital currency address` })),
          h('div', { class: 'kpi' }, h('dt', { text: 'Copy of the ledger taken' }), h('dd', { text: live.t1.slice(0, 10) }), h('p', { class: 'kpi__sub', text: 'the evidence here stops at this copy' }))),
        h('p', { class: 'field__hint' }, 'Source: ', sourceRef(live.source.path, live.source.sha256), ' and ', sourceRef(live.summary.path, live.summary.sha256)))),
    card('Timeline', { id: 'arc-timeline', actions: rangeBar }, h('div', { class: 'cardbody lanebox' }, lane)),
    card('OFAC postings seen and the timestamps that cover them', { id: 'arc-p' }, postings),
    card('List publications and fingerprints', { id: 'arc-l' }, publications),
    card('Shared-receipt seals taken to Bitcoin block 974,328', { id: 'arc-s', sub: `Checked ${archive.seals.checked_at_utc}` }, seals),
    card('List versions in this demo workspace', { id: 'arc-d', sub: 'v1 and v2 are demo reconstructions without timestamps.' }, demoVersions),
    card('Check it yourself', { id: 'arc-verify' }, h('div', { class: 'cardbody' },
      h('p', { class: 'field__hint', text: 'These commands run from a copy of the Tollgate research repository, not from this site. The first checks one receipt\'s inclusion path, its RFC 3161 token and its Bitcoin header. The second replays the transcript with only xxd, shasum and curl.' }),
      h('pre', { class: 'rawjson', tabindex: '0', text: 'python3 scripts/verify_anchor.py obs:0 --anchors results/anchoring\nsh verify_by_hand.sh bitcoin_path_973196.txt' }),
      h('p', { class: 'field__hint', text: 'A timestamp shows a receipt existed by a time. It does not show that the event it records happened then, and it says nothing about legality.' }))));
}
