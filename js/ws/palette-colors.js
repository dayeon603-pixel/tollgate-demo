/**
 * Chart colours and the checks they must pass. The CSS custom properties in css/moat.css repeat these
 * values; tests/palette.test.mjs fails if the two drift apart or if a pair stops passing.
 *
 * Rules: every colour reaches at least 3:1 contrast against the card it is drawn on (WCAG 1.4.11 for
 * graphics), and every pair of colours drawn together stays distinguishable for people with red-green
 * or blue-yellow colour blindness (CIEDE2000 above MIN_DELTA_E after simulating protanopia, deuteranopia
 * and tritanopia). Charts also vary dash and fill pattern, so colour is never the only cue.
 */
export const MIN_CONTRAST = 3;
export const MIN_DELTA_E = 11;
export const SURFACE = { light: '#ffffff', dark: '#10161a' };

/**
 * Okabe-Ito-derived hues. The light-theme values are darkened until they reach 3:1 on white, and amber and
 * vermillion are moved apart (gold and crimson) because the original pair merges for red-green colour blindness.
 */
export const PALETTE = {
  light: { blue: '#0072b2', amber: '#9c7a00', vermillion: '#a31f34', green: '#00785a', purple: '#8e3f9a', sky: '#2f7fb0' },
  dark: { blue: '#56b4e9', amber: '#f2d03b', vermillion: '#e8556b', green: '#3cc9a0', purple: '#e29bc3', sky: '#8fd0f5' },
};

/** Which colours are drawn together in one chart. */
export const GROUPS = [
  ['blue', 'amber', 'vermillion'],
  ['blue', 'vermillion'],
];

const toRgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

export function luminance(hex) {
  const [r, g, b] = toRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Machado et al. (2009) simulation matrices at full severity, applied in linear RGB. */
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

export const CVD_KINDS = Object.keys(CVD);

function simulate(hex, kind) {
  const rgb = toRgb(hex).map(lin);
  const m = CVD[kind];
  return m.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])));
}

function toLab(linear) {
  const [r, g, b] = linear;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000 colour difference between two Lab colours. */
export function deltaE2000(l1, l2) {
  const rad = Math.PI / 180;
  const [L1, a1, b1] = l1; const [L2, a2, b2] = l2;
  const C1 = Math.hypot(a1, b1); const C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1; const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1); const C2p = Math.hypot(a2p, b2);
  const hp = (b, a) => { const d = Math.atan2(b, a) / rad; return d < 0 ? d + 360 : d; };
  const h1p = C1p === 0 ? 0 : hp(b1, a1p); const h2p = C2p === 0 ? 0 : hp(b2, a2p);
  const dLp = L2 - L1; const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) { dhp = h2p - h1p; if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360; }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);
  const Lbp = (L1 + L2) / 2; const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) hbp = Math.abs(h1p - h2p) <= 180 ? (h1p + h2p) / 2 : (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp; const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** Smallest colour difference between any two colours of a group, over normal vision and three kinds of colour blindness. */
export function minSeparation(theme, group) {
  let worst = Infinity;
  for (const kind of [null, ...CVD_KINDS]) {
    const labs = group.map((name) => toLab(kind ? simulate(PALETTE[theme][name], kind) : toRgb(PALETTE[theme][name]).map(lin)));
    for (let i = 0; i < labs.length; i++) for (let j = i + 1; j < labs.length; j++) worst = Math.min(worst, deltaE2000(labs[i], labs[j]));
  }
  return worst;
}
