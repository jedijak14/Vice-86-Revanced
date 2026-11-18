// Texture data that is generated instead of loaded: the tiling noise texture every surface shader samples,
// and the sign atlas (hotel names, shop signs, billboards, road signs, number plates) painted with the 2D canvas API.
//
//   buildNoiseTexture()      -> Uint8Array(256 * 256 * 4), pure JavaScript, runs in Node and in workers
//   drawAtlas(canvas)        -> paints every entry of the sign catalogue (src/world/signs.js) onto a canvas
//   buildAtlas({ size })     -> creates a canvas (OffscreenCanvas when available), paints it, returns it
//
// The catalogue decides WHAT is on each sign and WHERE it sits in the atlas; this file only decides how it is drawn.

import { hashInts, hash01, hashString } from '../core/math.js';
import { SIGNS, ATLAS_SIZE } from '../world/signs.js';

// ------------------------------------------------------------------------------------------------ noise texture

export const NOISE_SIZE = 256;

/** Replace every value by its rank, so the histogram becomes exactly uniform over 0..1. */
function equalise(field) {
  const n = field.length, order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => field[a] - field[b]);
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) out[order[r]] = r / (n - 1);
  return out;
}

/** Tiling fractal gradient noise: lattices of 16, 8 and 4 texels, each half as strong as the one before. */
function fractalField(size, seed) {
  const out = new Float32Array(size * size);
  let gain = 1;
  for (let o = 0, step = 16; o < 3; o++, step >>= 1, gain *= 0.5) {
    const cells = size / step, gx = new Float32Array(cells * cells), gy = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i++) { const a = hash01(i, seed + o * 977, 3) * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    for (let y = 0; y < size; y++) {
      const fy = y / step, y0 = Math.floor(fy), ty = fy - y0, sy = fade(ty), j0 = (y0 % cells) * cells, j1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const fx = x / step, x0 = Math.floor(fx), tx = fx - x0, sx = fade(tx), i0 = x0 % cells, i1 = (x0 + 1) % cells;
        const a = gx[j0 + i0] * tx + gy[j0 + i0] * ty, b = gx[j0 + i1] * (tx - 1) + gy[j0 + i1] * ty;
        const c = gx[j1 + i0] * tx + gy[j1 + i0] * (ty - 1), d = gx[j1 + i1] * (tx - 1) + gy[j1 + i1] * (ty - 1);
        out[y * size + x] += gain * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
  }
  return out;
}

/** 5-tap separable blur with wrap-around; used to push white noise towards blue. */
function blurWrapped(src, size) {
  const k = [0.12, 0.23, 0.3, 0.23, 0.12], tmp = new Float32Array(src.length), out = new Float32Array(src.length), mask = size - 1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let s = 0; for (let t = -2; t <= 2; t++) s += k[t + 2] * src[y * size + ((x + t) & mask)]; tmp[y * size + x] = s; }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { let s = 0; for (let t = -2; t <= 2; t++) s += k[t + 2] * tmp[((y + t) & mask) * size + x]; out[y * size + x] = s; }
  return out;
}

/** Blue noise by repeatedly removing the low frequencies of a uniform field and re-equalising it. */
function blueField(size, seed) {
  let f = new Float32Array(size * size);
  for (let i = 0; i < f.length; i++) f[i] = hash01(i, seed, 71);
  for (let pass = 0; pass < 6; pass++) {
    const low = blurWrapped(f, size);
    for (let i = 0; i < f.length; i++) f[i] -= low[i];
    f = equalise(f);
  }
  return f;
}

/** Tiling cell noise: distance to the nearest point of a jittered grid, in cells, clamped to 1. */
function cellField(size, cell, seed) {
  const cells = size / cell, out = new Float32Array(size * size), px = new Float32Array(cells * cells), py = new Float32Array(cells * cells);
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) { px[j * cells + i] = 0.1 + 0.8 * hash01(i, j, seed); py[j * cells + i] = 0.1 + 0.8 * hash01(i, j, seed + 1); }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = (x + 0.5) / cell, gy = (y + 0.5) / cell, cx = Math.floor(gx), cy = Math.floor(gy); let best = 9;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const i = (cx + di + cells) % cells, j = (cy + dj + cells) % cells;
      const dx = cx + di + px[j * cells + i] - gx, dy = cy + dj + py[j * cells + i] - gy, d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    out[y * size + x] = Math.min(1, Math.sqrt(best));
  }
  return out;
}

/**
 * The 256 x 256 RGBA8 tiling noise bound as uNoiseTex (see the notes in shaders/lib.js, section 2).
 *   r, g  independent fractal gradient noise, base feature 16 texels, histogram-equalised (mean 0.5, uniform)
 *   b     blue noise, uniform
 *   a     cell noise: distance to the nearest feature point of a jittered grid with 8-texel cells (0 at the point)
 * Upload as linear data with REPEAT wrapping and trilinear filtering.
 */
export function buildNoiseTexture() {
  const size = NOISE_SIZE, data = new Uint8Array(size * size * 4);
  const r = equalise(fractalField(size, hashInts(11, 86))), g = equalise(fractalField(size, hashInts(23, 86)));
  const b = blueField(size, 5), a = cellField(size, 8, 137);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = Math.round(r[i] * 255); data[i * 4 + 1] = Math.round(g[i] * 255);
    data[i * 4 + 2] = Math.round(b[i] * 255); data[i * 4 + 3] = Math.round(a[i] * 255);
  }
  return data;
}

// ------------------------------------------------------------------------------------------------ sign atlas
//
// How a sign gets its lit mask. A 2D canvas stores premultiplied colour, so it cannot keep a colour under zero
// alpha. Every entry is therefore painted fully opaque, and entries that need a mask (lit faces and wall decals)
// are painted a second time on a scratch canvas as a grey picture of "how lit / how covered is this pixel". The two
// are merged into alpha = 0.25 + 0.75 * mask, which SOLID.SIGN decodes; plain painted faces keep alpha 1.
// The same drawing code runs for both pictures: every call names its colour and its mask level, and `ink` picks
// the one that applies.

const BLEED = 4;                       // pixels of each face repeated outside its rectangle so mip levels stay clean
const WHITE = '#ffffff', BLACK = '#101114';

const ink = (P, colour, lit) => { if (!P.mask) return colour; const v = Math.round(255 * lit); return `rgb(${v},${v},${v})`; };
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (a, b, t) => { const p = rgbOf(a), q = rgbOf(b); return '#' + p.map((v, i) => Math.round(v + (q[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const shade = (hex, k) => mix('#000000', hex, k);
const pale = (hex) => { const [r, g, b] = rgbOf(hex); return 0.3 * r + 0.6 * g + 0.1 * b; };   // 0..255, rough lightness
const chance = (e, salt) => hash01(hashString(e.id), salt);

/** Fill the whole face, bleed included. */
function ground(P, W, H, colour, lit) { P.c.fillStyle = ink(P, colour, lit); P.c.fillRect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED); }
function box(P, colour, lit, x, y, w, h) { P.c.fillStyle = ink(P, colour, lit); P.c.fillRect(x, y, w, h); }
function roundRect(c, x, y, w, h, r) {
  c.beginPath(); c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r); c.lineTo(x + w, y + h - r);
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h); c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r); c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}
function outline(P, colour, lit, x, y, w, h, r, width) { const c = P.c; roundRect(c, x, y, w, h, r); c.lineWidth = width; c.lineJoin = 'round'; c.strokeStyle = ink(P, colour, lit); c.stroke(); }
function disc(P, colour, lit, x, y, r) { const c = P.c; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = ink(P, colour, lit); c.fill(); }
function shape(P, colour, lit, pts) { const c = P.c; c.beginPath(); c.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]); c.closePath(); c.fillStyle = ink(P, colour, lit); c.fill(); }
function gradient(c, x0, y0, x1, y1, stops) { const g = c.createLinearGradient(x0, y0, x1, y1); stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s)); return g; }

// ---------------------------------------------------------------- a drawn alphabet
// Single-stroke deco capitals in a box of cap height 1 (y grows downwards, 0 = top). Round letters are true
// circles and so much wider than E, F, L and S, the A carries its bar low and the M is splayed: the proportions
// of 1930s hotel lettering. Being skeletons they can be bent into neon tube, cut as block letters, or swelled into
// thick-and-thin display letters, which no installed font can promise.
const ring = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) / 12)), pts = [];
  for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
  return pts;
};
const GLYPHS = {
  A: [0.8, [0, 1, 0.4, 0, 0.8, 1], [0.13, 0.68, 0.67, 0.68]],
  B: [0.6, [0, 1, 0, 0, 0.3, 0, ...ring(0.3, 0.24, 0.25, 0.24, -90, 90), 0, 0.48], [0.3, 0.48, ...ring(0.31, 0.74, 0.29, 0.26, -90, 90), 0, 1]],
  C: [0.88, ring(0.5, 0.5, 0.5, 0.5, -42, -318)],
  D: [0.78, [0, 1, 0, 0, 0.28, 0, ...ring(0.28, 0.5, 0.5, 0.5, -90, 90), 0, 1]],
  E: [0.5, [0.5, 0, 0, 0, 0, 1, 0.5, 1], [0, 0.48, 0.4, 0.48]],
  F: [0.48, [0.48, 0, 0, 0, 0, 1], [0, 0.48, 0.38, 0.48]],
  G: [0.92, [...ring(0.5, 0.5, 0.5, 0.5, -42, -360), 0.56, 0.5]],
  H: [0.68, [0, 0, 0, 1], [0.68, 0, 0.68, 1], [0, 0.48, 0.68, 0.48]],
  I: [0.04, [0.02, 0, 0.02, 1]],
  J: [0.46, [0.46, 0, 0.46, 0.74, ...ring(0.23, 0.74, 0.23, 0.26, 0, 170)]],
  K: [0.64, [0, 0, 0, 1], [0.62, 0, 0, 0.58], [0.2, 0.42, 0.64, 1]],
  L: [0.46, [0, 0, 0, 1, 0.46, 1]],
  M: [0.94, [0, 1, 0.08, 0, 0.47, 0.84, 0.86, 0, 0.94, 1]],
  N: [0.7, [0, 1, 0, 0, 0.7, 1, 0.7, 0]],
  O: [1, ring(0.5, 0.5, 0.5, 0.5, 0, 360)],
  P: [0.56, [0, 1, 0, 0, 0.3, 0, ...ring(0.3, 0.27, 0.26, 0.27, -90, 90), 0, 0.54]],
  Q: [1, ring(0.5, 0.5, 0.5, 0.5, 0, 360), [0.6, 0.72, 0.92, 1.06]],
  R: [0.6, [0, 1, 0, 0, 0.3, 0, ...ring(0.3, 0.27, 0.26, 0.27, -90, 90), 0, 0.54], [0.28, 0.54, 0.6, 1]],
  S: [0.54, [...ring(0.28, 0.26, 0.25, 0.26, -25, -270), ...ring(0.27, 0.76, 0.27, 0.24, -90, 155)]],
  T: [0.64, [0, 0, 0.64, 0], [0.32, 0, 0.32, 1]],
  U: [0.68, [0, 0, 0, 0.66, ...ring(0.34, 0.66, 0.34, 0.34, 180, 0), 0.68, 0]],
  V: [0.76, [0, 0, 0.38, 1, 0.76, 0]],
  W: [1.08, [0, 0, 0.27, 1, 0.54, 0.16, 0.81, 1, 1.08, 0]],
  X: [0.7, [0, 0, 0.7, 1], [0.7, 0, 0, 1]],
  Y: [0.7, [0, 0, 0.35, 0.52, 0.7, 0], [0.35, 0.52, 0.35, 1]],
  Z: [0.64, [0, 0, 0.64, 0, 0, 1, 0.64, 1]],
  0: [0.62, ring(0.31, 0.5, 0.31, 0.5, 0, 360)],
  1: [0.3, [0, 0.24, 0.26, 0, 0.26, 1]],
  2: [0.56, [...ring(0.28, 0.28, 0.28, 0.28, -170, 40), 0, 1, 0.56, 1]],
  3: [0.54, [...ring(0.26, 0.25, 0.26, 0.25, -150, 90), ...ring(0.26, 0.74, 0.28, 0.26, -90, 150)]],
  4: [0.64, [0.46, 1, 0.46, 0, 0, 0.7, 0.64, 0.7]],
  5: [0.56, [0.5, 0, 0.08, 0, 0.05, 0.44, ...ring(0.26, 0.68, 0.3, 0.32, -130, 150)]],
  6: [0.58, ring(0.29, 0.68, 0.29, 0.32, 0, 360), [0.44, 0, 0.05, 0.52]],
  7: [0.56, [0, 0, 0.56, 0, 0.18, 1]],
  8: [0.56, ring(0.28, 0.25, 0.24, 0.25, 0, 360), ring(0.28, 0.75, 0.28, 0.25, 0, 360)],
  9: [0.58, ring(0.29, 0.32, 0.29, 0.32, 0, 360), [0.53, 0.48, 0.14, 1]],
  '-': [0.34, [0, 0.55, 0.34, 0.55]], '.': [0.04, [0.02, 0.96, 0.02, 1]], ',': [0.06, [0.05, 0.94, 0, 1.12]], "'": [0.05, [0.05, 0, 0, 0.2]],
  ':': [0.04, [0.02, 0.36, 0.02, 0.4], [0.02, 0.96, 0.02, 1]], '/': [0.4, [0, 1, 0.4, 0]],
};
const SPACE = 0.42;

/**
 * Lay a line of drawn capitals into a box. Letters keep their height while they fit; a long name is first narrowed
 * (down to `squeeze` of its natural width) and only then made smaller. Returns the strokes in atlas pixels and,
 * in `cells`, the left edge and width of every letter.
 */
function caps(text, x, y, w, h, { track = 0.2, wide = 1, align = 0.5, squeeze = 0.62 } = {}) {
  const chars = text.toUpperCase().split(''), xs = [];
  let total = 0;
  for (const ch of chars) { xs.push(total); total += (GLYPHS[ch] ? GLYPHS[ch][0] : SPACE) + track; }
  total -= track;
  const sx = Math.min(h * wide, w / total), sy = Math.min(h, sx / (wide * squeeze));
  const left = x + (w - total * sx) * align, top = y + (h - sy) / 2, runs = [], cells = [];
  chars.forEach((ch, i) => {
    const g = GLYPHS[ch]; if (!g) return;
    cells.push(left + xs[i] * sx, g[0] * sx);
    for (let s = 1; s < g.length; s++) { const src = g[s], r = new Array(src.length); for (let k = 0; k < src.length; k += 2) { r[k] = left + (xs[i] + src[k]) * sx; r[k + 1] = top + src[k + 1] * sy; } runs.push(r); }
  });
  return { runs, cells, size: sy, left, right: left + total * sx, top, bottom: top + sy };
}

const isLoop = (r) => r.length > 8 && Math.abs(r[0] - r[r.length - 2]) + Math.abs(r[1] - r[r.length - 1]) < 1e-6;
/** A path builder for strokes laid out by `caps`. */
const along = (runs, dx = 0, dy = 0) => (c) => {
  c.beginPath();
  for (const r of runs) {
    const loop = isLoop(r), n = loop ? r.length - 2 : r.length;
    c.moveTo(r[0] + dx, r[1] + dy); for (let k = 2; k < n; k += 2) c.lineTo(r[k] + dx, r[k + 1] + dy);
    if (loop) c.closePath();
  }
};
function stroke(P, path, colour, lit, width, cap = 'round', join = 'round') {
  const c = P.c; path(c); c.lineWidth = width; c.lineCap = cap; c.lineJoin = join; c.miterLimit = 2.5; c.strokeStyle = ink(P, colour, lit); c.stroke();
}

/**
 * Glass tube: gas colour across the tube and a near-white thread only along its centre line. The glow it throws on
 * the panel behind is kept faint in the colour picture (the sign must not look switched on at noon) and strong in
 * the lit mask, so it only shows once the sign is on.
 */
function neon(P, path, colour, tube, lit = 1) {
  const c = P.c;
  for (const [k, day, night] of [[5.5, 0.05, 0.28], [2.8, 0.08, 0.4]]) { c.globalAlpha = P.mask ? night : day; stroke(P, path, colour, lit, tube * k); }
  c.globalAlpha = 1;
  stroke(P, path, colour, lit, tube);
  stroke(P, path, mix(colour, WHITE, 0.72), lit, tube * 0.34);
}

/**
 * Thick-and-thin display letters: every skeleton stroke swells with its direction as if drawn with a broad pen held
 * at 20 degrees, which gives the heavy stems and hairline bars of deco display type.
 */
function swell(P, runs, colour, lit, thin, thick, dx = 0, dy = 0) {
  const c = P.c, nx = Math.cos(-20 * Math.PI / 180), ny = Math.sin(-20 * Math.PI / 180);
  c.fillStyle = ink(P, colour, lit);
  const half = (tx, ty) => thin + (thick - thin) * Math.pow(Math.abs(tx * ny - ty * nx), 3);
  const ribbon = (r, a, b, loop) => {
    const n = b - a + 1, L = [], R = [];
    for (let i = a; i <= b; i++) {
      const p = loop ? a + ((i - 1 - a + n - 1) % (n - 1)) : Math.max(a, i - 1), q = loop ? a + ((i + 1 - a) % (n - 1)) : Math.min(b, i + 1);
      let tx = r[q * 2] - r[p * 2], ty = r[q * 2 + 1] - r[p * 2 + 1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const hw = half(tx, ty), x = r[i * 2] + dx, y = r[i * 2 + 1] + dy;
      L.push(x - ty * hw, y + tx * hw); R.push(x + ty * hw, y - tx * hw);
    }
    c.beginPath(); c.moveTo(L[0], L[1]); for (let k = 2; k < L.length; k += 2) c.lineTo(L[k], L[k + 1]);
    if (loop) { c.closePath(); c.moveTo(R[0], R[1]); for (let k = 2; k < R.length; k += 2) c.lineTo(R[k], R[k + 1]); c.closePath(); c.fill('evenodd'); return; }
    for (let k = R.length - 2; k >= 0; k -= 2) c.lineTo(R[k], R[k + 1]);
    c.closePath(); c.fill();
  };
  for (const r of runs) {
    const n = r.length / 2;
    if (isLoop(r)) { ribbon(r, 0, n - 1, true); continue; }
    let start = 0;
    for (let i = 1; i < n; i++) {
      // a ribbon cannot turn a sharp corner: cut the stroke there and plug the notch with a dot
      const ax = r[i * 2] - r[i * 2 - 2], ay = r[i * 2 + 1] - r[i * 2 - 1], last = i === n - 1;
      const bx = last ? 0 : r[i * 2 + 2] - r[i * 2], by = last ? 0 : r[i * 2 + 3] - r[i * 2 + 1];
      if (!last && (ax * bx + ay * by) / ((Math.hypot(ax, ay) * Math.hypot(bx, by)) || 1) > 0.8) continue;
      ribbon(r, start, i, false);
      if (!last) { c.beginPath(); c.arc(r[i * 2] + dx, r[i * 2 + 1] + dy, thin, 0, Math.PI * 2); c.fill(); }
      start = i;
    }
  }
}

// ---------------------------------------------------------------- installed fonts
// Only generic families and widely installed faces are named, each stack ending in a CSS generic, so the atlas
// never waits for a download. [style, weight, family, cap height as a fraction of the font size].
const FONTS = {
  script: ['italic', 400, '"Brush Script MT","Snell Roundhand","Segoe Script","Lucida Handwriting","Z003","URW Chancery L",cursive', 0.62],
  geo: ['normal', 700, '"Futura","Century Gothic","Avant Garde","URW Gothic","Trebuchet MS",sans-serif', 0.72],
  cond: ['normal', 700, '"Impact","Haettenschweiler","Arial Narrow","Roboto Condensed","Nimbus Sans Narrow",sans-serif', 0.74],
  sans: ['normal', 700, '"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif', 0.72],
  slant: ['italic', 700, '"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif', 0.72],
  serif: ['normal', 700, 'Georgia,"Times New Roman","Liberation Serif",serif', 0.68],
};
const fontOf = (kind, size) => `${FONTS[kind][0]} ${FONTS[kind][1]} ${size.toFixed(2)}px ${FONTS[kind][2]}`;

/**
 * Choose the size at which `text` fits a w x h box with its capitals filling the height, and leave that font set.
 * Installed faces differ a great deal (the script stack runs from a brush script to an italic serif), so the fit
 * uses the ink the browser reports: the real cap height, the real left and right overhang of slanted letters, and
 * ascenders and descenders that may not stray more than a fraction of the box above and below it. Where a canvas
 * reports no ink box the table's cap height stands in.
 * Returns { size, left (pen x for an ink box aligned in the box), base, width (of the ink) }.
 */
function fitType(c, text, kind, x, y, w, h, align) {
  c.font = fontOf(kind, 100);
  const m = c.measureText(text), capInk = c.measureText('H').actualBoundingBoxAscent;
  const cap = capInk > 0 ? capInk / 100 : FONTS[kind][3], known = m.actualBoundingBoxRight !== undefined;
  const inkL = known ? Math.max(0, m.actualBoundingBoxLeft) : 0, inkW = known ? inkL + Math.max(m.actualBoundingBoxRight, 0) : m.width;
  const up = known ? m.actualBoundingBoxAscent / 100 : cap, down = known ? Math.max(0, m.actualBoundingBoxDescent) / 100 : 0;
  const size = Math.min(h / cap, (w * 100) / Math.max(1, inkW), (1.3 * h) / Math.max(up, 1e-3), (0.5 * h) / Math.max(down, 1e-3));
  c.font = fontOf(kind, size);
  const width = inkW * size / 100;
  return { size, left: x + (w - width) * align + inkL * size / 100, base: y + h / 2 + size * cap / 2, width };
}

/**
 * A line of installed type fitted into a box (capitals fill its height). Options: align 0..1, shadow colour with
 * `drop` offset, edge colour with `edge` width, and the mask levels of both (`under`).
 */
function type(P, text, kind, x, y, w, h, colour, lit, { align = 0.5, shadow = null, drop = 0, edge = null, edgeW = 0, under = 0 } = {}) {
  const c = P.c, { size, left: tx, base: ty, width: tw } = fitType(c, text, kind, x, y, w, h, align);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.lineJoin = 'round';
  if (shadow) { c.fillStyle = ink(P, shadow, under); c.fillText(text, tx + drop, ty + drop); if (edge) { c.strokeStyle = c.fillStyle; c.lineWidth = edgeW; c.strokeText(text, tx + drop, ty + drop); } }
  if (edge) { c.strokeStyle = ink(P, edge, under); c.lineWidth = edgeW; c.strokeText(text, tx, ty); }
  c.fillStyle = ink(P, colour, lit); c.fillText(text, tx, ty);
  return { left: tx, right: tx + tw, base: ty, size };
}

/** Script lettering bent from tube: the glyph outline carries the gas colour, its body burns paler. */
function scriptNeon(P, text, x, y, w, h, colour, lit = 1) {
  const c = P.c, { size, left: tx, base: ty, width: tw } = fitType(c, text, 'script', x, y, w, h, 0.5), tube = size * 0.05;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic'; c.lineJoin = c.lineCap = 'round';
  for (const [k, day, night] of [[5, 0.05, 0.28], [2.6, 0.08, 0.4]]) { c.globalAlpha = P.mask ? night : day; c.strokeStyle = ink(P, colour, lit); c.lineWidth = tube * k; c.strokeText(text, tx, ty); }
  c.globalAlpha = 1;
  c.strokeStyle = ink(P, colour, lit); c.lineWidth = tube; c.strokeText(text, tx, ty);
  c.fillStyle = ink(P, mix(colour, WHITE, 0.55), lit); c.fillText(text, tx, ty);
  return { left: tx, right: tx + tw, base: ty, size };
}

/** Break a long name into two lines at the space nearest its middle. */
function twoLines(text) {
  let best = -1;
  for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2))) best = i;
  return best < 0 ? [text] : [text.slice(0, best), text.slice(best + 1)];
}
/** "The Coral Regent" -> ["The", "Coral Regent"]: the small word is set small beside the name. */
function prefixed(text) { const m = /^(The|Hotel|Club|Cafe|Cine) (.+)$/.exec(text); return m ? [m[1], m[2]] : ['', text]; }

// ---------------------------------------------------------------- small drawings
// Line drawings in a unit box, written as path strings: M move, L line, Q quadratic, C cubic, Z close, O circle
// (cx, cy, r). They are bent into neon on bar signs, brushed onto walls and printed on plastic faces.
const starPath = (cx, cy, r1, r2, n) => {
  let s = '';
  for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? r2 : r1; s += (i ? 'L' : 'M') + (cx + r * Math.cos(a)).toFixed(3) + ',' + (cy + r * Math.sin(a)).toFixed(3); }
  return s + 'Z';
};
const rays = (cx, cy, r1, r2, n) => {
  let s = '';
  for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n, x = Math.cos(a), y = Math.sin(a); s += `M${(cx + r1 * x).toFixed(3)},${(cy + r1 * y).toFixed(3)}L${(cx + r2 * x).toFixed(3)},${(cy + r2 * y).toFixed(3)}`; }
  return s;
};
const ICONS = {
  palm: 'M.46,1Q.4,.62,.52,.36M.52,.36Q.3,.2,.06,.42M.52,.36Q.36,.1,.12,.12M.52,.36Q.56,.1,.44,0M.52,.36Q.7,.1,.92,.14M.52,.36Q.78,.24,.98,.48M.52,.36Q.42,.42,.3,.62M.52,.36Q.66,.42,.74,.64',
  star: starPath(0.5, 0.53, 0.48, 0.2, 5),
  sun: 'O.5,.5,.2' + rays(0.5, 0.5, 0.3, 0.47, 10),
  flamingo: 'M.36,.5C.4,.36,.72,.36,.8,.52C.7,.64,.46,.64,.36,.5M.4,.47C.2,.42,.5,.22,.32,.1M.32,.1Q.22,.04,.16,.12L.2,.2M.56,.62L.56,.98M.63,.6L.63,.78L.5,.84',
  glass: 'M.14,.12L.86,.12L.5,.56ZM.5,.56L.5,.92M.3,.92L.7,.92M.7,.02L.54,.32O.57,.25,.05',
  moon: 'M.62,.06C.2,.1,.08,.6,.4,.86C.62,1,.9,.9,.96,.68C.6,.8,.4,.4,.62,.06Z',
  note: 'M.36,.78L.36,.18L.8,.08L.8,.68M.36,.32L.8,.22O.26,.78,.1O.7,.68,.1',
  bolt: 'M.6,.02L.2,.56L.46,.56L.36,.98L.82,.4L.54,.4Z',
  cup: 'M.16,.42L.72,.42Q.72,.8,.44,.8Q.16,.8,.16,.42ZM.72,.48Q.92,.48,.88,.62Q.84,.72,.68,.68M.06,.9L.82,.9M.34,.3Q.28,.2,.36,.1M.52,.3Q.46,.2,.54,.1',
  rooster: 'M.3,.62C.3,.42,.5,.42,.56,.5C.62,.3,.6,.22,.64,.2O.68,.16,.07M.62,.1L.64,.02L.69,.08L.74,.02L.75,.1M.75,.15L.85,.18L.75,.21M.3,.62C.1,.56,.06,.3,.2,.14M.3,.62C.16,.5,.18,.3,.3,.22M.3,.62C.4,.82,.62,.76,.64,.54L.67,.23M.44,.77L.44,.94L.36,.98M.44,.94L.52,.98',
  bubbles: 'O.3,.62,.2O.64,.4,.16O.72,.76,.1O.38,.2,.1',
  diamond: 'M.5,.95L.04,.36L.24,.1L.76,.1L.96,.36ZM.04,.36L.96,.36M.24,.1L.36,.36L.5,.95L.64,.36L.76,.1',
  pole: 'M.34,.14L.66,.14L.66,.86L.34,.86ZM.34,.34L.66,.2M.34,.52L.66,.38M.34,.7L.66,.56M.34,.86L.66,.74M.28,.14L.72,.14M.28,.86L.72,.86O.5,.07,.06',
  cigar: 'M.08,.66L.7,.4Q.84,.36,.9,.42Q.92,.5,.8,.56L.16,.82Q.06,.8,.08,.66ZM.56,.46L.64,.62M.62,.44L.7,.6M.9,.36Q.84,.24,.92,.16Q.98,.08,.9,0',
  fruit: 'M.06,.4Q.5,1.3,.94,.4ZM.5,.4L.5,.84M.5,.4L.24,.72M.5,.4L.76,.72M.4,.26Q.5,.08,.7,.14Q.6,.3,.4,.26',
  hammer: 'M.2,.92L.56,.38M.34,.2L.74,.46L.82,.34L.42,.08ZM.74,.46L.86,.58',
  bee: 'O.5,.58,.22M.38,.4L.38,.76M.5,.36L.5,.8M.62,.4L.62,.76M.44,.38Q.2,.04,.14,.3Q.2,.44,.4,.42M.56,.38Q.8,.04,.86,.3Q.8,.44,.6,.42M.72,.58L.88,.58',
  candle: 'M.38,.42L.62,.42L.62,.94L.38,.94ZM.5,.42L.5,.34M.5,.06Q.64,.22,.5,.32Q.36,.22,.5,.06Z',
  flower: 'O.5,.24,.15O.75,.42,.15O.65,.71,.15O.35,.71,.15O.25,.42,.15O.5,.5,.1',
  domino: 'M.1,.3L.9,.3L.9,.7L.1,.7ZM.5,.3L.5,.7O.22,.4,.03O.38,.4,.03O.3,.5,.03O.22,.6,.03O.38,.6,.03O.62,.4,.03O.78,.4,.03O.7,.5,.03O.62,.6,.03O.78,.6,.03',
  rainbow: 'M.06,.8Q.06,.2,.5,.2Q.94,.2,.94,.8M.2,.8Q.2,.36,.5,.36Q.8,.36,.8,.8M.34,.8Q.34,.52,.5,.52Q.66,.52,.66,.8',
  bird: 'M.04,.42Q.26,.16,.5,.5Q.74,.16,.96,.42M.5,.5L.46,.62',
  wave: 'M.02,.5Q.2,.1,.4,.42Q.5,.6,.36,.62M.3,.76Q.5,.5,.7,.72Q.86,.88,.98,.66',
  cross: 'M.32,.24L.32,.76M.68,.24L.68,.76M.32,.5L.68,.5',
  shield: 'M.5,.04L.9,.18Q.92,.7,.5,.97Q.08,.7,.1,.18Z',
  plane: 'M.5,.02Q.56,.1,.56,.3L.96,.56L.96,.64L.56,.54L.55,.8L.7,.92L.7,.97L.5,.92L.3,.97L.3,.92L.45,.8L.44,.54L.04,.64L.04,.56L.44,.3Q.44,.1,.5,.02Z',
  phone: 'M.14,.3Q.14,.14,.3,.16L.4,.2L.4,.36L.3,.4Q.4,.62,.62,.72L.66,.62L.82,.62L.86,.72Q.88,.88,.72,.88Q.2,.84,.14,.3Z',
  bus: 'M.06,.26Q.06,.2,.12,.2L.88,.2Q.94,.2,.94,.26L.94,.72L.06,.72ZM.12,.28L.88,.28L.88,.48L.12,.48ZO.26,.76,.08O.74,.76,.08',
  ring: 'O.5,.5,.42O.5,.5,.2M.5,.08L.5,.3M.5,.7L.5,.92M.08,.5L.3,.5M.7,.5L.92,.5',
};
const parsed = new Map();
/** A path builder for a drawing placed in the square (x, y, s). */
const drawing = (name, x, y, s) => (c) => {
  if (!parsed.has(name)) parsed.set(name, [...ICONS[name].matchAll(/([MLQCZO])([^MLQCZO]*)/g)].map((m) => [m[1], m[2] ? m[2].split(',').map(Number) : []]));
  c.beginPath();
  for (const [op, a] of parsed.get(name)) {
    if (op === 'M') c.moveTo(x + a[0] * s, y + a[1] * s);
    else if (op === 'L') c.lineTo(x + a[0] * s, y + a[1] * s);
    else if (op === 'Q') c.quadraticCurveTo(x + a[0] * s, y + a[1] * s, x + a[2] * s, y + a[3] * s);
    else if (op === 'C') c.bezierCurveTo(x + a[0] * s, y + a[1] * s, x + a[2] * s, y + a[3] * s, x + a[4] * s, y + a[5] * s);
    else if (op === 'O') { c.moveTo(x + (a[0] + a[2]) * s, y + a[1] * s); c.arc(x + a[0] * s, y + a[1] * s, a[2] * s, 0, Math.PI * 2); }
    else c.closePath();
  }
};
/** A drawing filled flat, as a sign painter or a printer would. */
function stamp(P, name, x, y, s, colour, lit) { const c = P.c; drawing(name, x, y, s)(c); c.fillStyle = ink(P, colour, lit); c.fill(); stroke(P, drawing(name, x, y, s), colour, lit, s * 0.045); }

// ---------------------------------------------------------------- sign styles
// Each painter draws one face in a box (0, 0, W, H) for both pictures. Colours come from the catalogue entry.

/** A dark backing panel with stepped deco corners picked out in a slightly lighter tone. */
function panel(P, e, W, H) {
  ground(P, W, H, e.colors.bg, 0);
  const step = H * 0.09, tone = mix(e.colors.bg, WHITE, 0.07);
  for (let i = 1; i <= 2; i++) outline(P, tone, 0, step * i * 0.5, step * i * 0.5, W - step * i, H - step * i, 1, 1.2);
}
/** A back-lit plastic face in a dark metal frame: evenly lit all over, so its mask is simply the face. */
function plastic(P, e, W, H, colour = e.colors.bg) {
  ground(P, W, H, '#2b2d31', 0);
  box(P, colour, 1, 3, 3, W - 6, H - 6);
  return P.mask;                                                    // nothing else changes the mask of such a face
}
/** A row of cap bulbs round a rectangle. */
function bulbs(P, x, y, w, h, gap, r, colour) {
  const nx = Math.max(2, Math.round(w / gap)), ny = Math.max(2, Math.round(h / gap));
  const dot = (px, py) => { P.c.globalAlpha = P.mask ? 0.5 : 0.12; disc(P, colour, 1, px, py, r * 2.2); P.c.globalAlpha = 1; disc(P, colour, 1, px, py, r); disc(P, mix(colour, WHITE, 0.75), 1, px, py, r * 0.45); };
  for (let i = 0; i <= nx; i++) { dot(x + w * i / nx, y); dot(x + w * i / nx, y + h); }
  for (let j = 1; j < ny; j++) { dot(x, y + h * j / ny); dot(x + w, y + h * j / ny); }
}
/** One or two lines of drawn capitals, as tube. */
function neonLines(P, lines, x, y, w, h, colour, tubeK, opts) {
  const lh = h / lines.length;
  lines.forEach((t, i) => { const l = caps(t, x, y + lh * i + lh * 0.08, w, lh * 0.84, opts); neon(P, along(l.runs), colour, Math.max(1.6, l.size * tubeK)); });
}

const STYLES = {
  // hotel name in single-stroke tube capitals between twin racing lines
  'fascia-neon'(P, e, W, H) {
    const { fg, accent } = e.colors, [pre, name] = prefixed(e.text), tube = Math.max(2, H * 0.045);
    panel(P, e, W, H);
    neon(P, (c) => { c.beginPath(); for (const y of [H * 0.13, H * 0.87]) { c.moveTo(W * 0.035, y); c.lineTo(W * 0.965, y); } }, accent, tube * 0.7);
    let x = W * 0.05;
    if (pre) { const l = caps(pre, x, H * 0.37, W * 0.13, H * 0.26, { align: 0 }); neon(P, along(l.runs), accent, tube * 0.6); x = l.right + H * 0.3; }
    const lines = name.length > 22 ? twoLines(name) : [name];
    neonLines(P, lines, x, H * 0.22, W * 0.95 - x, H * 0.56, fg, lines.length > 1 ? 0.11 : 0.085, { track: 0.26 });
  },
  // open-face channel letters on a pastel band, with speed stripes
  'fascia-channel'(P, e, W, H) {
    const { bg, fg, accent } = e.colors;
    ground(P, W, H, bg, 0.03);
    box(P, shade(bg, 0.82), 0.02, -BLEED, H * 0.86, W + 2 * BLEED, H * 0.14 + BLEED);
    const l = caps(e.text, W * 0.15, H * 0.2, W * 0.7, H * 0.56, { track: 0.22, wide: 0.82 }), lw = l.size * 0.2;
    stroke(P, along(l.runs, lw * 0.4, lw * 0.4), shade(bg, 0.4), 0, lw, 'butt', 'miter');
    stroke(P, along(l.runs), shade(fg, 0.75), 0.8, lw, 'butt', 'miter');
    stroke(P, along(l.runs), fg, 1, lw * 0.62, 'butt', 'miter');
    stroke(P, along(l.runs), mix(fg, WHITE, 0.7), 1, lw * 0.16);
    for (let i = 0; i < 3; i++) for (const x of [W * 0.025, W * 0.885]) box(P, accent, 0.9, x, H * (0.27 + 0.15 * i), W * 0.09, H * 0.07);
  },
  // thick-and-thin display capitals with a dropped second colour
  'fascia-display'(P, e, W, H) {
    const { fg, accent } = e.colors;
    panel(P, e, W, H);
    const lines = e.text.length > 20 && !e.sub ? twoLines(e.text) : [e.text], top = e.sub ? 0.14 : 0.2, lh = (e.sub ? 0.5 : 0.6) * H / lines.length;
    lines.forEach((t, i) => {
      const l = caps(t, W * 0.07, H * top + lh * i + lh * 0.06, W * 0.86, lh * 0.88, { track: 0.24, squeeze: 0.85 }), thick = l.size * 0.105, thin = l.size * 0.026;
      swell(P, l.runs, accent, 0.35, thin, thick, thick * 0.4, thick * 0.4);
      swell(P, l.runs, fg, 1, thin, thick);
    });
    if (e.sub) neonLines(P, [e.sub], W * 0.2, H * 0.72, W * 0.6, H * 0.17, accent, 0.1, { track: 0.3 });
    for (const y of [H * 0.1, H * 0.9]) for (const [x0, x1] of [[0.05, 0.3], [0.7, 0.95]]) stroke(P, (c) => { c.beginPath(); c.moveTo(W * x0, y); c.lineTo(W * x1, y); }, accent, 0.7, Math.max(1.5, H * 0.02), 'butt');
  },
  // vertical fin: one letter per cell, tube border, finial on top
  blade(P, e, W, H) {
    const { bg, fg, accent } = e.colors, tube = Math.max(2, W * 0.035), chars = e.text.toUpperCase().split('');
    ground(P, W, H, bg, 0);
    neon(P, (c) => roundRect(c, W * 0.09, W * 0.09, W * 0.82, H - W * 0.18, W * 0.3), accent, tube * 0.8);
    neon(P, drawing('star', W * 0.34, W * 0.2, W * 0.32), accent, tube * 0.6);
    const units = chars.reduce((s, ch) => s + (ch === ' ' ? 0.45 : 1), 0), top = W * 0.62, cell = Math.min((H - top - W * 0.3) / units, W * 0.78);
    let y = top + (H - top - W * 0.3 - cell * units) / 2;
    for (const ch of chars) {
      if (ch === ' ') { y += cell * 0.45; continue; }
      const l = caps(ch, W * 0.24, y + cell * 0.1, W * 0.52, cell * 0.8, { squeeze: 0.8 });
      neon(P, along(l.runs), fg, tube); y += cell;
    }
  },
  // bar and club script with a swash, small tube capitals beneath, a tube drawing beside
  'script-neon'(P, e, W, H) {
    const { fg, accent } = e.colors, tube = Math.max(1.8, H * 0.028), art = ICONS[e.art] ? H * 0.74 : 0;
    panel(P, e, W, H);
    if (art) neon(P, drawing(e.art, W * 0.05, H * 0.13, art), accent, tube);
    // tube is priced by the foot: sign makers leave the article out
    const x = W * 0.07 + art, w = W * 0.93 - x, l = scriptNeon(P, e.text.replace(/^The /, ''), x, H * 0.12, w, H * (e.sub ? 0.5 : 0.52), fg);
    const y = Math.min(l.base + l.size * 0.16, H * (e.sub ? 0.68 : 0.82));
    neon(P, (c) => { c.beginPath(); c.moveTo(l.left, y); c.bezierCurveTo(l.left + (l.right - l.left) * 0.3, y + H * 0.06, l.left + (l.right - l.left) * 0.7, y - H * 0.05, l.right, y - H * 0.01); }, accent, tube);
    if (e.sub) neonLines(P, [e.sub], x + w * 0.1, H * 0.74, w * 0.8, H * 0.16, accent, 0.11, { track: 0.32 });
  },
  // roadside plastic face: a slanted colour band carrying block capitals, script beneath, a starburst in the corner
  roadside(P, e, W, H) {
    const { bg, fg, accent } = e.colors, ink2 = shade(accent, 0.28);
    if (plastic(P, e, W, H)) return;
    shape(P, accent, 1, [W * 0.03, H * 0.16, W * 0.9, H * 0.16, W * 0.97, H * 0.4, W * 0.9, H * (e.sub ? 0.62 : 0.84), W * 0.03, H * (e.sub ? 0.62 : 0.84)]);
    const l = caps(e.text, W * 0.07, H * 0.24, W * 0.78, H * (e.sub ? 0.3 : 0.5), { track: 0.18, wide: 0.85 }), lw = l.size * 0.19;
    // cream letters with a dark cast shadow, except on a yellow arrow where they would vanish
    const dark = pale(accent) > 190;
    stroke(P, along(l.runs, lw * 0.35, lw * 0.35), dark ? mix(accent, WHITE, 0.6) : ink2, 1, lw, 'butt', 'miter');
    stroke(P, along(l.runs), dark ? ink2 : '#fffdf2', 1, lw, 'butt', 'miter');
    if (e.sub) type(P, e.sub, 'script', W * 0.2, H * 0.67, W * 0.72, H * 0.2, shade(fg, 0.7), 1, { align: 0.9 });
    const s = H * 0.3;
    stamp(P, ICONS[e.art] && e.art !== 'star' ? e.art : 'sun', W * 0.04, H * 0.64, s, shade(fg, 0.8), 1);
    box(P, shade(bg, 0.7), 1, 3, H * 0.92, W - 6, H * 0.03);
  },
  // theatre-style board: chaser bulbs round thick-and-thin capitals
  marquee(P, e, W, H) {
    const { fg, accent } = e.colors, r = Math.max(1.6, H * 0.022);
    ground(P, W, H, e.colors.bg, 0);
    bulbs(P, H * 0.09, H * 0.09, W - H * 0.18, H * 0.82, H * 0.12, r, '#ffd98a');
    const lines = e.text.length > 20 && !e.sub ? twoLines(e.text) : [e.text], lh = (e.sub ? 0.42 : 0.56) * H / lines.length;
    lines.forEach((t, i) => {
      const l = caps(t, W * 0.09, H * (e.sub ? 0.2 : 0.22) + lh * i + lh * 0.06, W * 0.82, lh * 0.88, { track: 0.24, squeeze: 0.85 }), thick = l.size * 0.11, thin = l.size * 0.028;
      swell(P, l.runs, accent, 0.4, thin, thick, thick * 0.4, thick * 0.4);
      swell(P, l.runs, fg, 1, thin, thick);
    });
    if (e.sub) neonLines(P, [e.sub], W * 0.2, H * 0.66, W * 0.6, H * 0.15, accent, 0.11, { track: 0.3 });
  },
  // shopfront light box: four ways a sign shop would lay out a name and a line of trade
  acrylic(P, e, W, H) {
    const { bg, fg, accent } = e.colors, dark = rgbOf(bg)[0] + rgbOf(bg)[1] + rgbOf(bg)[2] < 380, words = e.text.split(' ');
    const layout = e.sub ? Math.floor(chance(e, 1) * (words.length > 1 ? 4 : 3)) : -1, tone = dark ? shade(bg, 0.55) : mix(bg, fg, 0.25), drop = H * 0.03;
    if (plastic(P, e, W, H)) return;
    const art = ICONS[e.art] && layout !== 3 ? H * 0.62 : 0, x = W * 0.05 + (art ? art + W * 0.02 : 0), w = W * 0.95 - x, face = e.text.length > 14 ? 'cond' : 'geo';
    if (art) { disc(P, fg, 1, W * 0.04 + art / 2, H * 0.5, art * 0.56); stamp(P, e.art, W * 0.04 + art * 0.17, H * 0.5 - art * 0.33, art * 0.66, bg, 1); }
    if (layout < 0) {
      outline(P, accent, 1, 8, 8, W - 16, H - 16, 7, 1.6);
      type(P, e.text.toUpperCase(), face, x + W * 0.02, H * 0.26, w - W * 0.04, H * 0.48, fg, 1, { shadow: tone, drop });
    } else if (layout === 0) {
      type(P, e.text.toUpperCase(), 'cond', x, H * 0.1, w, H * 0.5, fg, 1, { shadow: tone, drop });
      box(P, accent, 1, 3, H * 0.68, W - 6, H * 0.32 - 3);
      type(P, e.sub.toUpperCase(), 'geo', W * 0.06, H * 0.75, W * 0.88, H * 0.16, dark ? bg : '#fff8e6', 1);
    } else if (layout === 1) {
      const l = type(P, e.text, 'script', x, H * 0.08, w, H * 0.5, fg, 1, { shadow: tone, drop: drop * 0.8 });
      stroke(P, (c) => { c.beginPath(); c.moveTo(l.left, H * 0.68); c.quadraticCurveTo((l.left + l.right) / 2, H * 0.74, l.right, H * 0.65); }, accent, 1, H * 0.035);
      type(P, e.sub.toUpperCase(), 'geo', x, H * 0.78, w, H * 0.12, dark ? fg : accent, 1);
    } else if (layout === 2) {
      outline(P, accent, 1, 8, 8, W - 16, H - 16, 7, 1.6);
      type(P, e.text.toUpperCase(), face, x + W * 0.02, H * 0.17, w - W * 0.04, H * 0.42, fg, 1, { shadow: tone, drop });
      type(P, e.sub.toUpperCase(), 'sans', x + W * 0.02, H * 0.7, w - W * 0.04, H * 0.13, dark ? fg : accent, 1);
    } else {
      // the first word reversed out of a block of the letter colour, the rest beside it
      const bw = W * 0.34;
      box(P, fg, 1, 3, 3, bw, H - 6); box(P, accent, 1, bw + 3, 3, W * 0.012, H - 6);
      type(P, words[0].toUpperCase(), 'cond', W * 0.03, H * 0.24, bw - W * 0.04, H * 0.52, bg, 1);
      type(P, words.slice(1).join(' ').toUpperCase(), 'geo', bw + W * 0.05, H * 0.16, W * 0.91 - bw, H * 0.4, fg, 1, { shadow: tone, drop });
      type(P, e.sub.toUpperCase(), 'sans', bw + W * 0.05, H * 0.69, W * 0.91 - bw, H * 0.13, dark ? fg : accent, 1);
    }
  },
  // individual lit letters on a dark fascia
  'acrylic-dark'(P, e, W, H) {
    const { fg, accent } = e.colors;
    ground(P, W, H, e.colors.bg, 0);
    const l = type(P, e.text.toUpperCase(), 'geo', W * 0.05, H * (e.sub ? 0.14 : 0.26), W * 0.9, H * (e.sub ? 0.4 : 0.48), fg, 1, { shadow: shade(fg, 0.3), drop: H * 0.03, under: 0.1 });
    if (!e.sub) return;
    box(P, accent, 0.85, l.left, H * 0.63, l.right - l.left, H * 0.03);
    type(P, e.sub.toUpperCase(), 'sans', W * 0.08, H * 0.73, W * 0.84, H * 0.14, accent, 0.85);
  },
  // hand lettering straight on the wall: brushed script or shaded capitals, a small painting, a flourish
  brush(P, e, W, H) {
    const { fg, accent, shadow } = e.colors, c = P.c, capsFirst = chance(e, 2) < 0.5, art = ICONS[e.art] ? H * 0.6 : 0;
    // yellow and orange carry a flourish or a picture but vanish as small lettering on a pale wall
    const small = pale(accent) > 140 ? fg : accent;
    c.rotate(-0.012 - 0.02 * chance(e, 3));
    if (art) { stamp(P, e.art, W * 0.03, H * 0.2, art, accent, 1); stroke(P, drawing(e.art, W * 0.03, H * 0.2, art), shadow, 1, 1.5); }
    const x = W * 0.05 + (art ? art + W * 0.02 : 0), w = W * 0.95 - x;
    // "PANADERIA" small above, "La Estrella" large below: the trade first, then the name, as on most hand-painted fronts
    const words = e.text.split(' '), stacked = words.length > 1 && e.text.length > 13, name = stacked ? words.slice(1).join(' ') : e.text, top = stacked ? 0.27 : 0.12;
    if (stacked) type(P, words[0].toUpperCase(), 'sans', x, H * 0.07, w, H * 0.14, small, 1, { align: 0 });
    const l = capsFirst
      ? type(P, name.toUpperCase(), 'cond', x, H * (top + 0.03), w, H * 0.34, fg, 1, { shadow, drop: H * 0.035 })
      : type(P, name, 'script', x, H * top, w, H * 0.4, fg, 1, { shadow, drop: H * 0.025 });
    // a loaded brush dragged under the name: fat where it lands, thin where it lifts
    const y = H * 0.7, a = Math.min(l.left, x + w * 0.1), b = Math.max(l.right, x + w * 0.9);
    c.beginPath(); c.moveTo(a, y); c.quadraticCurveTo((a + b) / 2, y - H * 0.05, b, y - H * 0.01); c.quadraticCurveTo((a + b) / 2, y + H * 0.03, a, y + H * 0.05); c.closePath();
    c.fillStyle = ink(P, accent, 1); c.fill();
    if (e.sub) type(P, capsFirst ? e.sub : e.sub.toUpperCase(), capsFirst ? 'script' : 'sans', x + w * 0.06, H * 0.79, w * 0.88, H * 0.15, capsFirst ? small : fg, 1);
  },
  // separate lit capitals with a returned edge, for bank and office tops
  rooftop(P, e, W, H) {
    const { fg, accent } = e.colors;
    ground(P, W, H, e.colors.bg, 0);
    const lines = e.text.length > 22 ? twoLines(e.text) : [e.text], lh = H * 0.72 / lines.length, mark = lines.length === 1 ? H * 0.5 : 0;
    if (mark) { shape(P, fg, 1, [W * 0.035 + mark / 2, H * 0.25, W * 0.035 + mark, H * 0.5, W * 0.035 + mark / 2, H * 0.75, W * 0.035, H * 0.5]); box(P, e.colors.bg, 0, W * 0.035, H * 0.47, mark, H * 0.06); }
    const x = W * 0.05 + mark * 1.3;
    lines.forEach((t, i) => {
      const l = caps(t, x, H * 0.14 + lh * i + lh * 0.12, W * 0.96 - x, lh * 0.76, { track: 0.3 }), lw = l.size * 0.13;
      stroke(P, along(l.runs, lw * 0.4, lw * 0.4), accent, 0.12, lw, 'butt', 'miter');
      stroke(P, along(l.runs), fg, 1, lw, 'butt', 'miter');
    });
  },
  // cinema: name in tube above a reader board with slotted black letters
  cinema(P, e, W, H) {
    const { fg, accent } = e.colors, lines = e.sub.split(/ - |: /);
    ground(P, W, H, e.colors.bg, 0);
    const l = caps(e.text, W * 0.06, H * 0.06, W * 0.88, H * 0.22, { track: 0.24, squeeze: 0.85 }), thick = l.size * 0.11;
    swell(P, l.runs, accent, 0.4, l.size * 0.028, thick, thick * 0.4, thick * 0.4); swell(P, l.runs, fg, 1, l.size * 0.028, thick);
    box(P, '#f3eedd', 1, W * 0.04, H * 0.36, W * 0.92, H * 0.56);
    const rows = Math.min(3, lines.length), rh = H * 0.52 / rows;
    for (let i = 0; i < rows; i++) {
      box(P, '#cfc9b6', 1, W * 0.04, H * 0.38 + rh * (i + 1) - 1, W * 0.92, 1.5);
      type(P, lines[i].toUpperCase(), 'cond', W * 0.07, H * 0.38 + rh * i + rh * 0.16, W * 0.86, rh * 0.68, i === 0 && rows > 2 ? '#b3151c' : BLACK, 1);
    }
    bulbs(P, W * 0.04, H * 0.33, W * 0.92, H * 0.62, H * 0.075, Math.max(1.5, H * 0.014), '#ffd98a');
  },
  // enamelled sheet-metal sign over a workshop door
  workshop(P, e, W, H) {
    const { bg, fg, accent } = e.colors;
    ground(P, W, H, bg, 0);
    outline(P, fg, 0, 4, 4, W - 8, H - 8, 3, 2.5);
    const lines = !e.sub && e.text.length > 18 ? twoLines(e.text) : [e.text], lh = H * (e.sub ? 0.46 : 0.7) / lines.length;
    lines.forEach((t, i) => type(P, t.toUpperCase(), 'cond', W * 0.06, H * 0.13 + lh * i + lh * 0.1, W * 0.88, lh * 0.8, accent, 0, { shadow: fg, drop: Math.max(1.5, lh * 0.05) }));
    if (!e.sub) return;
    box(P, fg, 0, 8, H * 0.66, W - 16, H * 0.24);
    type(P, e.sub.toUpperCase(), 'geo', W * 0.08, H * 0.71, W * 0.84, H * 0.14, bg, 0);
  },
  // filling-station price sign: roundel, brand, grade line
  gas(P, e, W, H) {
    const { bg, fg, accent } = e.colors, r = H * 0.27;
    if (plastic(P, e, W, H)) return;
    box(P, fg, 1, 3, H * 0.74, W - 6, H * 0.26 - 3); box(P, accent, 1, 3, H * 0.7, W - 6, H * 0.04);
    disc(P, fg, 1, W * 0.2, H * 0.36, r); disc(P, bg, 1, W * 0.2, H * 0.36, r * 0.82);
    stamp(P, ICONS[e.art] ? e.art : 'sun', W * 0.2 - r * 0.62, H * 0.36 - r * 0.62, r * 1.24, accent, 1);
    type(P, e.text.toUpperCase(), 'slant', W * 0.38, H * 0.14, W * 0.56, H * 0.36, fg, 1);
    type(P, e.sub.toUpperCase(), 'sans', W * 0.06, H * 0.8, W * 0.88, H * 0.11, bg, 1);
  },
  // warehouse and dock names sprayed through a stencil
  stencil(P, e, W, H) {
    const { fg } = e.colors, lines = e.sub ? [e.text] : e.text.length > 16 ? twoLines(e.text) : [e.text], lh = H * (e.sub ? 0.5 : 0.8) / lines.length;
    // a long name is squeezed narrow, so the stroke follows the letter width as well as its height
    const weight = (l, t, k) => Math.min(l.size * k, (l.right - l.left) / t.length * 0.2);
    const cut = (l, lw) => {
      stroke(P, along(l.runs), fg, 1, lw, 'butt', 'miter');
      // the bridges that hold a stencil together only exist in the coverage picture: there is no paint to draw them with.
      // One upright gap a third of the way across each letter misses every centre stem and cuts every bowl and bar.
      if (P.mask) for (let i = 0; i < l.cells.length; i += 2) box(P, BLACK, 0, l.cells[i] + l.cells[i + 1] * 0.36 - lw * 0.16, l.top - lw, lw * 0.32, l.size + 2 * lw);
    };
    lines.forEach((t, i) => { const l = caps(t, W * 0.04, H * 0.1 + lh * i + lh * 0.1, W * 0.92, lh * 0.8, { track: 0.3, wide: 0.8 }); cut(l, weight(l, t, 0.15)); });
    if (e.sub) { const l = caps(e.sub, W * 0.2, H * 0.68, W * 0.6, H * 0.2, { track: 0.28, wide: 0.8 }); cut(l, weight(l, e.sub, 0.13)); }
  },
  // hospital, police and public parking: plain lit faces
  civic(P, e, W, H) {
    const { fg, accent } = e.colors, s = H * 0.6, mark = e.category === 'parking' || ICONS[e.art];
    if (plastic(P, e, W, H)) return;
    if (mark) {
      const x = W * 0.045, y = H * 0.2;
      if (e.art === 'shield') { stamp(P, 'shield', x, y, s, fg, 1); stamp(P, 'star', x + s * 0.3, y + s * 0.27, s * 0.4, '#f1c93c', 1); }
      else { const c = P.c; roundRect(c, x, y, s, s, s * 0.14); c.fillStyle = ink(P, fg, 1); c.fill(); if (e.art === 'cross') stroke(P, drawing('cross', x, y, s), WHITE, 1, s * 0.13, 'butt'); else type(P, 'P', 'sans', x + s * 0.2, y + s * 0.18, s * 0.6, s * 0.64, WHITE, 1); }
    }
    const x = W * 0.06 + (mark ? s + W * 0.02 : 0), w = W * 0.95 - x, lines = !e.sub && e.text.length > 18 ? twoLines(e.text) : [e.text], lh = H * (e.sub ? 0.42 : 0.62) / lines.length;
    lines.forEach((t, i) => type(P, t.toUpperCase(), 'sans', x, H * 0.16 + lh * i + lh * 0.1, w, lh * 0.8, e.category === 'hospital' && e.text === 'Emergency' ? accent : fg, 1, { align: 0 }));
    box(P, accent, 1, x, H * (e.sub ? 0.62 : 0.82), w, H * 0.03);
    if (e.sub) type(P, e.sub.toUpperCase(), 'sans', x, H * 0.71, w, H * 0.14, shade(fg, 0.8), 1, { align: 0 });
  },
  // bronze name plate
  plaque(P, e, W, H) {
    const lines = e.text.length > 16 ? twoLines(e.text) : [e.text], lh = H * 0.62 / lines.length;
    ground(P, W, H, '#2b3a31', 0);
    P.c.fillStyle = gradient(P.c, 0, 0, 0, H, ['#3b4d41', '#22302a']); P.c.fillRect(0, 0, W, H);
    outline(P, '#c9b072', 0, 5, 5, W - 10, H - 10, 4, 2); outline(P, '#8f7a45', 0, 9, 9, W - 18, H - 18, 2, 1);
    lines.forEach((t, i) => type(P, t.toUpperCase(), 'serif', W * 0.08, H * 0.19 + lh * i + lh * 0.14, W * 0.84, lh * 0.72, '#dcc88c', 0, { shadow: '#141c17', drop: 1.5 }));
    for (const x of [W * 0.04, W * 0.96]) disc(P, '#c9b072', 0, x, H * 0.5, 2);
  },
  // advert on a bus bench back
  bench(P, e, W, H) {
    const { bg, fg, accent } = e.colors;
    ground(P, W, H, bg, 0);
    box(P, accent, 0, 0, 0, W, H * 0.1); box(P, fg, 0, 0, H * 0.66, W, H * 0.34);
    type(P, e.text.toUpperCase(), 'cond', W * 0.05, H * 0.2, W * 0.9, H * 0.36, fg, 0);
    type(P, e.sub.toUpperCase(), 'geo', W * 0.06, H * 0.74, W * 0.88, H * 0.17, bg, 0);
  },
  // tube sign hung inside a shop window
  'window-neon'(P, e, W, H) {
    const { fg, accent } = e.colors, tube = Math.max(2, H * 0.035), art = ICONS[e.art];
    ground(P, W, H, e.colors.bg, 0);
    neon(P, (c) => roundRect(c, H * 0.1, H * 0.1, W - H * 0.2, H * 0.8, H * 0.22), accent, tube * 0.8);
    if (art && !e.text) { neon(P, drawing(e.art, W / 2 - H * 0.3, H * 0.2, H * 0.6), fg, tube); return; }
    if (e.sub) {
      // a brewer's mark: the brand in script over one line of capitals, its emblem beside
      const m = art ? H * 0.42 : 0, bx = W * 0.11 + (m ? m + W * 0.02 : 0);
      if (m) neon(P, drawing(e.art, W * 0.11, H * 0.2, m), accent, tube * 0.7);
      scriptNeon(P, e.text, bx, H * 0.2, W * 0.89 - bx, H * 0.3, fg);
      neonLines(P, [e.sub], bx + (W * 0.89 - bx) * 0.12, H * 0.62, (W * 0.89 - bx) * 0.76, H * 0.2, accent, 0.1, { track: 0.3 });
      return;
    }
    const s = art ? H * 0.46 : 0, x = W * 0.12 + (s ? s + W * 0.03 : 0);
    if (s) neon(P, drawing(e.art, W * 0.12, H * 0.27, s), accent, tube * 0.8);
    const l = caps(e.text, x, H * 0.3, W * 0.88 - x, H * 0.4, { track: 0.24 });
    neon(P, along(l.runs), fg, Math.max(2, l.size * 0.09));
  },
  // street-name blade: white capitals on green, the suffix small and raised
  street(P, e, W, H) {
    ground(P, W, H, '#006b54', 0);
    outline(P, '#eef2ee', 0, 2.5, 2.5, W - 5, H - 5, 4, 1.6);
    // the name box stops a gap short of the suffix so a long name cannot run into it
    const sw = W * 0.14, gap = W * 0.025, l = type(P, e.text.toUpperCase(), 'sans', W * 0.06, H * 0.24, W * 0.88 - sw - gap, H * 0.52, '#f4f7f4', 0, { align: 0.5 });
    type(P, e.sub.toUpperCase(), 'sans', l.right + gap, H * 0.24, sw, H * 0.26, '#f4f7f4', 0, { align: 0 });
  },
  // overhead guide sign
  guide(P, e, W, H) {
    const c = P.c, turn = { up: 0, right: 90, down: 180, left: -90 }[e.sub] * Math.PI / 180, s = H * 0.3, ax = e.sub === 'right' ? W * 0.87 : W * 0.13;
    ground(P, W, H, '#00674f', 0);
    outline(P, '#eef2ee', 0, 4, 4, W - 8, H - 8, 8, 2.4);
    c.save(); c.translate(ax, H / 2); c.rotate(turn);
    shape(P, '#f4f7f4', 0, [0, -s, s * 0.8, -s * 0.1, s * 0.3, -s * 0.1, s * 0.3, s, -s * 0.3, s, -s * 0.3, -s * 0.1, -s * 0.8, -s * 0.1]);
    c.restore();
    const x0 = e.sub === 'right' ? W * 0.06 : W * 0.25, plane = e.art === 'plane' ? H * 0.5 : 0;
    if (plane) { c.save(); c.translate(x0 + plane / 2, H / 2); c.rotate(Math.PI / 4); stamp(P, 'plane', -plane / 2, -plane / 2, plane, '#f4f7f4', 0); c.restore(); }
    const lines = e.text.length > 12 ? twoLines(e.text) : [e.text], lh = H * 0.68 / lines.length;
    lines.forEach((t, i) => type(P, t, 'sans', x0 + plane * 1.2, H * 0.16 + lh * i + lh * 0.14, W * 0.69 - plane * 1.2, lh * 0.72, '#f4f7f4', 0, { align: e.sub === 'right' ? 1 : 0 }));
  },
  stop(P, e, W, H) {
    const oct = (r) => { const pts = []; for (let i = 0; i < 8; i++) { const a = (i + 0.5) * Math.PI / 4; pts.push(W / 2 + r * Math.cos(a), H / 2 + r * Math.sin(a)); } return pts; };
    ground(P, W, H, '#b01c2e', 0);
    shape(P, '#f4f4f0', 0, oct(W * 0.535)); shape(P, '#b01c2e', 0, oct(W * 0.5));
    type(P, 'STOP', 'sans', W * 0.14, H * 0.33, W * 0.72, H * 0.34, '#f8f8f4', 0);
  },
  speed(P, e, W, H) {
    ground(P, W, H, '#f2f2ec', 0);
    outline(P, BLACK, 0, 5, 5, W - 10, H - 10, 8, 3);
    type(P, 'SPEED', 'sans', W * 0.16, H * 0.1, W * 0.68, H * 0.13, BLACK, 0); type(P, 'LIMIT', 'sans', W * 0.16, H * 0.27, W * 0.68, H * 0.13, BLACK, 0);
    type(P, e.text, 'sans', W * 0.14, H * 0.48, W * 0.72, H * 0.4, BLACK, 0);
  },
  oneway(P, e, W, H) {
    const c = P.c;
    ground(P, W, H, BLACK, 0);
    outline(P, '#f2f2ec', 0, 2.5, 2.5, W - 5, H - 5, 4, 1.5);
    c.save(); if (e.sub === 'left') { c.translate(W, 0); c.scale(-1, 1); }
    shape(P, '#f2f2ec', 0, [W * 0.06, H * 0.3, W * 0.72, H * 0.3, W * 0.72, H * 0.14, W * 0.95, H * 0.5, W * 0.72, H * 0.86, W * 0.72, H * 0.7, W * 0.06, H * 0.7]);
    c.restore();
    type(P, 'ONE WAY', 'sans', e.sub === 'left' ? W * 0.3 : W * 0.1, H * 0.37, W * 0.6, H * 0.26, BLACK, 0);
  },
  // small public notices, each with its own layout
  notice(P, e, W, H) {
    const blue = '#1b4f9c', red = '#c8262c', paper = '#f2f2ec', c = P.c;
    if (e.art === 'phone') {
      ground(P, W, H, blue, 0); outline(P, paper, 0, 4, 4, W - 8, H - 8, 8, 2.5);
      stamp(P, 'phone', W * 0.08, H * 0.16, H * 0.68, paper, 0); type(P, 'PHONE', 'sans', W * 0.48, H * 0.36, W * 0.44, H * 0.28, paper, 0);
    } else if (e.art === 'bus-stop') {
      ground(P, W, H, paper, 0); box(P, blue, 0, 0, 0, W, H * 0.5);
      stamp(P, 'bus', W * 0.06, H * 0.02, H * 0.46, paper, 0); box(P, blue, 0, W * 0.06 + H * 0.055, H * 0.15, H * 0.35, H * 0.09);
      type(P, 'BUS STOP', 'sans', W * 0.36, H * 0.14, W * 0.58, H * 0.22, paper, 0);
      type(P, e.sub.toUpperCase(), 'sans', W * 0.08, H * 0.62, W * 0.84, H * 0.16, blue, 0); box(P, red, 0, W * 0.08, H * 0.86, W * 0.84, H * 0.04);
    } else if (e.art === 'lifeguard') {
      ground(P, W, H, paper, 0); box(P, red, 0, 0, 0, W, H * 0.56);
      stroke(P, drawing('ring', W * 0.05, H * 0.07, H * 0.42), paper, 0, H * 0.035);
      type(P, 'LIFEGUARD', 'cond', W * 0.34, H * 0.14, W * 0.6, H * 0.28, paper, 0);
      type(P, e.sub.toUpperCase(), 'sans', W * 0.08, H * 0.68, W * 0.84, H * 0.17, red, 0);
    } else if (e.art === 'beach-rules') {
      const rules = e.sub.split(' - ');
      ground(P, W, H, paper, 0); box(P, blue, 0, 0, 0, W, H * 0.3); outline(P, blue, 0, 3, 3, W - 6, H - 6, 4, 2);
      type(P, 'BEACH RULES', 'sans', W * 0.1, H * 0.08, W * 0.8, H * 0.15, paper, 0);
      rules.forEach((t, i) => { disc(P, red, 0, W * 0.12, H * (0.43 + 0.18 * i), H * 0.03); type(P, t.toUpperCase(), 'sans', W * 0.19, H * (0.38 + 0.18 * i), W * 0.72, H * 0.1, BLACK, 0, { align: 0 }); });
    } else if (e.art === 'mail') {
      // enamel collection plate of a street mailbox: the service name over an envelope, then the collection times
      const [service, word, times] = e.sub.split(' - '), ex = W * 0.08, ey = H * 0.42, ew = W * 0.26, eh = H * 0.3;
      ground(P, W, H, blue, 0); outline(P, paper, 0, 4, 4, W - 8, H - 8, 6, 2);
      type(P, service.toUpperCase(), 'cond', W * 0.08, H * 0.1, W * 0.84, H * 0.2, paper, 0);
      box(P, paper, 0, ex, ey, ew, eh); stroke(P, (k) => { k.beginPath(); k.moveTo(ex, ey); k.lineTo(ex + ew / 2, ey + eh * 0.55); k.lineTo(ex + ew, ey); }, blue, 0, 2, 'butt', 'miter');
      type(P, word.toUpperCase(), 'sans', W * 0.4, H * 0.43, W * 0.52, H * 0.15, paper, 0, { align: 0 });
      box(P, red, 0, W * 0.4, H * 0.63, W * 0.52, H * 0.035);
      type(P, times.toUpperCase(), 'sans', W * 0.08, H * 0.79, W * 0.84, H * 0.11, paper, 0);
    } else {
      ground(P, W, H, paper, 0); outline(P, red, 0, 4, 4, W - 8, H - 8, 6, 2.5);
      type(P, 'P', 'sans', W * 0.1, H * 0.2, W * 0.2, H * 0.4, BLACK, 0);
      c.beginPath(); c.arc(W * 0.2, H * 0.4, H * 0.29, 0, Math.PI * 2); c.moveTo(W * 0.2 - H * 0.2, H * 0.2); c.lineTo(W * 0.2 + H * 0.2, H * 0.6);
      c.lineWidth = H * 0.05; c.strokeStyle = ink(P, red, 0); c.stroke();
      type(P, 'NO', 'sans', W * 0.44, H * 0.14, W * 0.48, H * 0.2, red, 0); type(P, 'PARKING', 'sans', W * 0.44, H * 0.4, W * 0.48, H * 0.2, red, 0);
      type(P, e.sub.toUpperCase(), 'sans', W * 0.1, H * 0.76, W * 0.8, H * 0.12, BLACK, 0);
    }
  },
  // front page behind the window of a newspaper box
  newsbox(P, e, W, H) {
    const { bg, fg, accent } = e.colors;
    ground(P, W, H, bg, 0);
    type(P, e.text, 'serif', W * 0.06, H * 0.06, W * 0.88, H * 0.17, fg, 0);
    box(P, fg, 0, W * 0.06, H * 0.27, W * 0.88, 1.5); box(P, accent, 0, W * 0.06, H * 0.3, W * 0.88, 1);
    type(P, e.sub.toUpperCase(), 'cond', W * 0.06, H * 0.36, W * 0.88, H * 0.14, fg, 0, { align: 0 });
    P.c.fillStyle = gradient(P.c, 0, H * 0.56, 0, H * 0.94, ['#8a8f96', '#4a4f57']); P.c.fillRect(W * 0.06, H * 0.56, W * 0.4, H * 0.38);
    stamp(P, 'palm', W * 0.14, H * 0.6, H * 0.34, '#22252b', 0);
    for (let i = 0; i < 7; i++) box(P, mix(bg, fg, 0.45), 0, W * 0.5, H * (0.58 + 0.055 * i), W * (0.44 - 0.1 * hash01(i, hashString(e.id), 9)), 1.5);
  },
  // shipping line name and box number on a container side
  container(P, e, W, H) {
    const { fg } = e.colors;
    const l = caps(e.text, W * 0.03, H * 0.08, W * 0.94, H * 0.56, { track: 0.32, wide: 0.9, align: 0 }), lw = Math.min(l.size * 0.17, (l.right - l.left) / e.text.length * 0.2);
    stroke(P, along(l.runs), fg, 1, lw, 'butt', 'miter');
    box(P, fg, 1, W * 0.03, H * 0.7, W * 0.5, H * 0.05);
    const n = caps(e.sub, W * 0.58, H * 0.7, W * 0.39, H * 0.2, { track: 0.22, align: 1 });
    stroke(P, along(n.runs), fg, 1, n.size * 0.14, 'butt', 'miter');
  },
  // number plate: embossed green characters, the state legend above, the county below, a citrus sun between the groups
  plate(P, e, W, H) {
    const green = '#1d6a3c', [a, b] = e.text.split(' ');
    ground(P, W, H, '#f3f2ea', 0);
    P.c.fillStyle = gradient(P.c, 0, 0, 0, H, ['#fbfaf4', '#e6e4d8']); P.c.fillRect(0, 0, W, H);
    outline(P, green, 0, 3, 3, W - 6, H - 6, 6, 1.6);
    type(P, 'SUNCOAST', 'sans', W * 0.3, H * 0.09, W * 0.4, H * 0.11, green, 0);
    for (const [t, x] of [[a, 0.07], [b, 0.57]]) type(P, t, 'cond', W * x, H * 0.3, W * 0.36, H * 0.4, green, 0, { shadow: '#b9c7b4', drop: 0.8 });
    disc(P, '#f08a1c', 0, W * 0.5, H * 0.5, H * 0.1); stroke(P, drawing('sun', W * 0.5 - H * 0.17, H * 0.33, H * 0.34), '#f08a1c', 0, 1);
    type(P, e.sub.toUpperCase(), 'sans', W * 0.25, H * 0.8, W * 0.5, H * 0.09, green, 0);
    for (const x of [0.12, 0.88]) for (const y of [0.14, 0.86]) disc(P, '#9a9c96', 0, W * x, H * y, 1.6);
  },
};

// ---------------------------------------------------------------- billboard illustration
// Printed posters in the airbrushed style of the period: banded suns, palm silhouettes, wedge coupes, cruise
// liners. These are opaque paintings, so they are drawn in colour only.

function backdrop(c, W, H, stops, y1 = H) { c.fillStyle = gradient(c, 0, 0, 0, y1, stops); c.fillRect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED); }
/** The setting sun of poster art: a disc sliced by bars that widen towards the horizon. */
function bandedSun(c, cx, cy, r, top, bottom) {
  c.save(); c.beginPath();
  for (let i = 0, y = cy - r; y < cy + r; i++) { const h = r * Math.max(0.05, 0.42 - 0.06 * i); c.rect(cx - r, y, 2 * r, h); y += h + r * 0.035 * (i + 1); }
  c.clip(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fillStyle = gradient(c, 0, cy - r, 0, cy + r, [top, bottom]); c.fill(); c.restore();
}
/** A palm in silhouette: (x, y) is the foot, h the height, lean the sideways drift of the crown as a fraction of h. */
function palmTree(c, x, y, h, lean, colour, seed) {
  const tx = x + lean * h, ty = y - h;
  c.strokeStyle = c.fillStyle = colour; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x, y); c.quadraticCurveTo(x + lean * h * 0.15, y - h * 0.55, tx, ty); c.lineWidth = h * 0.04; c.stroke();
  for (let i = 0; i < 9; i++) {
    const a = -Math.PI * (0.03 + 0.94 * (i + 0.6 * hash01(seed, i, 1)) / 9), L = h * (0.36 + 0.12 * hash01(seed, i, 2));
    const ex = tx + L * Math.cos(a), ey = ty + L * 0.5 * Math.sin(a) + L * 0.45, mx = tx + L * 0.55 * Math.cos(a), my = ty + L * 0.8 * Math.sin(a) - L * 0.12;
    c.beginPath(); c.moveTo(tx, ty); c.quadraticCurveTo(mx, my, ex, ey); c.quadraticCurveTo(mx, my + L * 0.24, tx, ty); c.fill();
  }
}
function water(c, W, H, y, stops, glint, seed) {
  c.fillStyle = gradient(c, 0, y, 0, H, stops); c.fillRect(-BLEED, y, W + 2 * BLEED, H - y + BLEED);
  c.fillStyle = glint;
  for (let i = 0; i < 30; i++) {
    const t = hash01(seed, i, 4), w = W * (0.02 + 0.07 * hash01(seed, i, 5)) * (0.4 + t);
    c.fillRect(W * (0.05 + 0.9 * hash01(seed, i, 6)) - w / 2, y + (H - y) * (0.04 + 0.92 * t * t), w, Math.max(1, (H - y) * 0.018));
  }
}
/** A generic wedge coupe seen from the side, nose to the left. (x, y) is where the front of the car meets the road; s its length. */
function coupe(c, x, y, s, body, glass) {
  const at = (pts) => { c.beginPath(); for (let i = 0; i < pts.length; i += 2) c[i ? 'lineTo' : 'moveTo'](x + pts[i] * s, y - pts[i + 1] * s); c.closePath(); };
  at([0, 0.05, 0.01, 0.115, 0.3, 0.15, 0.43, 0.25, 0.62, 0.255, 0.8, 0.185, 0.99, 0.185, 1, 0.07, 0.97, 0.04, 0.03, 0.04]); c.fillStyle = body; c.fill();
  at([0, 0.05, 0.01, 0.085, 0.99, 0.1, 1, 0.07, 0.97, 0.04, 0.03, 0.04]); c.fillStyle = shade(body, 0.62); c.fill();
  at([0.335, 0.156, 0.44, 0.236, 0.61, 0.24, 0.755, 0.186]); c.fillStyle = glass; c.fill();
  at([0.52, 0.16, 0.535, 0.24, 0.55, 0.24, 0.54, 0.16]); c.fillStyle = body; c.fill();
  at([0.03, 0.118, 0.3, 0.15, 0.3, 0.142, 0.03, 0.108]); c.fillStyle = mix(body, WHITE, 0.55); c.fill();
  for (const u of [0.19, 0.79]) {
    c.beginPath(); c.arc(x + u * s, y - 0.062 * s, 0.078 * s, 0, Math.PI * 2); c.fillStyle = '#0a0a0e'; c.fill();
    c.beginPath(); c.arc(x + u * s, y - 0.062 * s, 0.04 * s, 0, Math.PI * 2); c.fillStyle = '#c9ccd2'; c.fill();
    c.beginPath(); c.arc(x + u * s, y - 0.062 * s, 0.014 * s, 0, Math.PI * 2); c.fillStyle = '#3a3d44'; c.fill();
  }
}
/** A generic twin-jet airliner from the side, nose to the left; (x, y) is the nose, s the length. */
function airliner(c, x, y, s, body, stripe) {
  const X = (u) => x + u * s, Y = (v) => y + v * s;
  c.fillStyle = shade(body, 0.72);
  c.beginPath(); c.moveTo(X(0.84), Y(-0.01)); c.lineTo(X(0.97), Y(-0.07)); c.lineTo(X(0.99), Y(-0.07)); c.lineTo(X(0.93), Y(0)); c.closePath(); c.fill();
  c.fillStyle = body;
  c.beginPath(); c.moveTo(X(0), Y(0)); c.quadraticCurveTo(X(0.02), Y(-0.036), X(0.1), Y(-0.04)); c.lineTo(X(0.8), Y(-0.04)); c.lineTo(X(0.92), Y(-0.17)); c.lineTo(X(0.985), Y(-0.17));
  c.lineTo(X(0.95), Y(-0.02)); c.quadraticCurveTo(X(1), Y(0), X(0.93), Y(0.03)); c.lineTo(X(0.1), Y(0.042)); c.quadraticCurveTo(X(0.02), Y(0.036), X(0), Y(0)); c.closePath(); c.fill();
  c.fillStyle = stripe; c.fillRect(X(0.04), Y(-0.004), s * 0.9, s * 0.014);
  c.beginPath(); c.moveTo(X(0.8), Y(-0.04)); c.lineTo(X(0.92), Y(-0.17)); c.lineTo(X(0.985), Y(-0.17)); c.lineTo(X(0.955), Y(-0.04)); c.closePath(); c.fill();
  c.fillStyle = '#20324a'; for (let u = 0.13; u < 0.78; u += 0.03) c.fillRect(X(u), Y(-0.026), s * 0.014, s * 0.011);
  c.beginPath(); c.moveTo(X(0.03), Y(-0.012)); c.lineTo(X(0.055), Y(-0.03)); c.lineTo(X(0.085), Y(-0.03)); c.lineTo(X(0.085), Y(-0.012)); c.closePath(); c.fill();
  c.fillStyle = shade(body, 0.86);
  c.beginPath(); c.moveTo(X(0.38), Y(0.02)); c.lineTo(X(0.6), Y(0.19)); c.lineTo(X(0.66), Y(0.19)); c.lineTo(X(0.54), Y(0.02)); c.closePath(); c.fill();
  c.fillStyle = shade(body, 0.6); roundRect(c, X(0.4), Y(0.06), s * 0.1, s * 0.04, s * 0.018); c.fill();
}
/** A cruise liner from the side, bow to the right; (x, y) is the stern at the waterline, s the length. */
function liner(c, x, y, s, hull, band) {
  const X = (u) => x + u * s, Y = (v) => y - v * s;
  c.fillStyle = hull;
  c.beginPath(); c.moveTo(X(0), Y(0.07)); c.lineTo(X(0.9), Y(0.07)); c.lineTo(X(1), Y(0.095)); c.lineTo(X(0.94), Y(0)); c.lineTo(X(0.03), Y(0)); c.closePath(); c.fill();
  c.fillStyle = band; c.fillRect(X(0.02), Y(0.03), s * 0.94, s * 0.012);
  [[0.1, 0.07, 0.68, 0.04], [0.16, 0.11, 0.52, 0.035], [0.24, 0.145, 0.32, 0.03]].forEach(([u, v, w, h]) => { c.fillStyle = hull; c.fillRect(X(u), Y(v + h), s * w, s * h); c.fillStyle = '#27405e'; for (let p = u + 0.015; p < u + w - 0.015; p += 0.022) c.fillRect(X(p), Y(v + h * 0.72), s * 0.012, s * h * 0.36); });
  for (const u of [0.33, 0.46]) {
    c.fillStyle = hull; c.beginPath(); c.moveTo(X(u), Y(0.175)); c.lineTo(X(u + 0.055), Y(0.175)); c.lineTo(X(u + 0.04), Y(0.25)); c.lineTo(X(u - 0.015), Y(0.25)); c.closePath(); c.fill();
    c.fillStyle = band; c.beginPath(); c.moveTo(X(u - 0.009), Y(0.22)); c.lineTo(X(u + 0.046), Y(0.22)); c.lineTo(X(u + 0.04), Y(0.25)); c.lineTo(X(u - 0.015), Y(0.25)); c.closePath(); c.fill();
  }
  c.strokeStyle = hull; c.lineWidth = Math.max(1, s * 0.005); c.beginPath(); c.moveTo(X(0.7), Y(0.11)); c.lineTo(X(0.7), Y(0.22)); c.moveTo(X(0.7), Y(0.2)); c.lineTo(X(0.9), Y(0.08)); c.stroke();
}
/** A bottle standing at (x, y), h tall. */
function bottle(c, x, y, h, glass, label, cap) {
  const w = h * 0.15, n = h * 0.05;
  c.beginPath(); c.moveTo(x - w, y); c.lineTo(x - w, y - h * 0.56); c.quadraticCurveTo(x - w, y - h * 0.7, x - n, y - h * 0.77); c.lineTo(x - n, y - h * 0.95); c.lineTo(x + n, y - h * 0.95);
  c.lineTo(x + n, y - h * 0.77); c.quadraticCurveTo(x + w, y - h * 0.7, x + w, y - h * 0.56); c.lineTo(x + w, y); c.closePath();
  c.fillStyle = gradient(c, x - w, 0, x + w, 0, [mix(glass, WHITE, 0.25), glass, shade(glass, 0.6)]); c.fill();
  c.fillStyle = label; c.fillRect(x - w, y - h * 0.46, 2 * w, h * 0.3);
  c.fillStyle = cap; c.fillRect(x - n * 1.25, y - h, n * 2.5, h * 0.07); c.fillRect(x - w, y - h * 0.5, 2 * w, h * 0.035); c.fillRect(x - w, y - h * 0.16, 2 * w, h * 0.02);
  c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(x - w * 0.78, y - h * 0.62, w * 0.16, h * 0.56);
}
/** Mirror sunglasses centred on (cx, cy), w wide, with a sunset in the lenses. */
function sunglasses(c, cx, cy, w, seed) {
  for (const side of [-1, 1]) {
    const lens = () => { c.beginPath(); c.moveTo(cx + side * w * 0.48, cy - w * 0.14); c.lineTo(cx + side * w * 0.05, cy - w * 0.14); c.quadraticCurveTo(cx + side * w * 0.03, cy + w * 0.13, cx + side * w * 0.22, cy + w * 0.17); c.quadraticCurveTo(cx + side * w * 0.47, cy + w * 0.17, cx + side * w * 0.48, cy - w * 0.14); c.closePath(); };
    c.save(); lens(); c.clip();
    c.fillStyle = gradient(c, 0, cy - w * 0.14, 0, cy + w * 0.17, ['#2a1458', '#c2267a', '#ff8a3a', '#ffd76a']); c.fillRect(cx - w / 2, cy - w * 0.2, w, w * 0.4);
    bandedSun(c, cx + side * w * 0.3, cy + w * 0.09, w * 0.1, '#fff2a8', '#ff5f8a');
    palmTree(c, cx + side * w * 0.14, cy + w * 0.2, w * 0.26, 0.12 * side, '#1a0b2e', seed + side);
    c.fillStyle = 'rgba(255,255,255,0.28)'; c.beginPath(); c.moveTo(cx + side * w * 0.36, cy - w * 0.14); c.lineTo(cx + side * w * 0.42, cy - w * 0.14); c.lineTo(cx + side * w * 0.3, cy + w * 0.17); c.lineTo(cx + side * w * 0.24, cy + w * 0.17); c.closePath(); c.fill();
    c.restore(); lens(); c.lineWidth = w * 0.022; c.lineJoin = 'round'; c.strokeStyle = '#0d0d12'; c.stroke();
  }
  c.fillStyle = '#0d0d12'; c.fillRect(cx - w * 0.5, cy - w * 0.165, w, w * 0.04);
}
/** A lattice mast with radio waves, foot at (x, y). */
function mast(c, x, y, h, colour, wave) {
  c.strokeStyle = colour; c.lineWidth = Math.max(1.2, h * 0.018); c.lineJoin = 'round';
  c.beginPath(); c.moveTo(x - h * 0.13, y); c.lineTo(x, y - h * 0.78); c.lineTo(x + h * 0.13, y);
  for (let i = 0; i < 5; i++) { const t0 = i / 5, t1 = (i + 1) / 5, w0 = 0.13 * (1 - t0), w1 = 0.13 * (1 - t1), s = i % 2 ? 1 : -1; c.moveTo(x + s * h * w0, y - h * 0.78 * t0); c.lineTo(x - s * h * w1, y - h * 0.78 * t1); }
  c.moveTo(x, y - h * 0.78); c.lineTo(x, y - h * 0.9); c.stroke();
  c.strokeStyle = wave; c.lineCap = 'round';
  for (let i = 1; i <= 3; i++) for (const side of [0, Math.PI]) { c.beginPath(); c.arc(x, y - h * 0.9, h * 0.1 * i, side - 0.6, side + 0.6); c.stroke(); }
  c.beginPath(); c.arc(x, y - h * 0.9, h * 0.028, 0, Math.PI * 2); c.fillStyle = wave; c.fill();
}
/** A cocktail glass centred on (cx, cy), s tall. */
function martini(c, cx, cy, s, drink, line) {
  c.beginPath(); c.moveTo(cx - s * 0.36, cy - s * 0.4); c.lineTo(cx + s * 0.36, cy - s * 0.4); c.lineTo(cx, cy + s * 0.06); c.closePath();
  c.fillStyle = gradient(c, 0, cy - s * 0.4, 0, cy + s * 0.06, [mix(drink, WHITE, 0.35), drink]); c.fill();
  c.strokeStyle = line; c.lineWidth = Math.max(1.5, s * 0.03); c.lineJoin = c.lineCap = 'round';
  c.beginPath(); c.moveTo(cx - s * 0.42, cy - s * 0.47); c.lineTo(cx, cy + s * 0.06); c.lineTo(cx + s * 0.42, cy - s * 0.47); c.closePath();
  c.moveTo(cx, cy + s * 0.06); c.lineTo(cx, cy + s * 0.44); c.moveTo(cx - s * 0.22, cy + s * 0.46); c.lineTo(cx + s * 0.22, cy + s * 0.46);
  c.moveTo(cx + s * 0.3, cy - s * 0.62); c.lineTo(cx + s * 0.06, cy - s * 0.2); c.stroke();
  c.beginPath(); c.arc(cx + s * 0.12, cy - s * 0.3, s * 0.06, 0, Math.PI * 2); c.fillStyle = '#ff3b4e'; c.fill();
}
function sparkle(c, x, y, r, colour) {
  c.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, k = i % 2 ? 0.22 : 1; c[i ? 'lineTo' : 'moveTo'](x + r * k * Math.cos(a), y + r * k * Math.sin(a)); } c.closePath(); c.fillStyle = colour; c.fill();
}

// Each advert paints the whole sheet and returns how its words are set: [font, colour, shadow, second-line colour].
// O = [x, y, w, h] is the part of the sheet kept free for the pictured thing.
const ADS = {
  sunset(c, W, H, O, seed) {
    const hz = H * 0.66, r = Math.min(O[2], O[3]) * 0.36;
    backdrop(c, W, H, ['#241056', '#7a1d7e', '#e03a6a', '#ff8a3a', '#ffd76a'], hz);
    bandedSun(c, O[0] + O[2] * 0.55, hz - r * 0.35, r, '#fff2a0', '#ff4f7a');
    c.fillStyle = '#2a0f45'; for (let i = 0; i < 14; i++) { const w = W * (0.02 + 0.03 * hash01(seed, i, 7)), h = H * (0.03 + 0.1 * hash01(seed, i, 8)); c.fillRect(W * (0.3 + 0.7 * i / 14), hz - h, w, h); }
    water(c, W, H, hz, ['#6a2278', '#1a0d3a'], '#ffa06a', seed);
    palmTree(c, O[0] + O[2] * 0.14, H * 0.98, O[3] * 0.82, 0.16, '#160a26', seed); palmTree(c, O[0] + O[2] * 0.3, H * 1.02, O[3] * 0.6, -0.1, '#160a26', seed + 1);
    return ['script', '#fff6e0', '#3a0f4a', '#ffd76a'];
  },
  rum(c, W, H, O, seed) {
    c.fillStyle = gradient(c, 0, 0, W, H, ['#160805', '#6a210e']); c.fillRect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
    const cx = O[0] + O[2] * 0.5, by = O[1] + O[3] * 0.97, h = O[3] * 0.94;
    c.beginPath(); c.arc(cx, O[1] + O[3] * 0.5, Math.min(O[2], O[3]) * 0.46, 0, Math.PI * 2); c.fillStyle = gradient(c, 0, O[1], 0, O[1] + O[3], ['#ffc04a', '#e0561a']); c.fill();
    palmTree(c, cx - h * 0.34, by, h * 0.7, -0.14, '#2a0d06', seed); palmTree(c, cx + h * 0.36, by, h * 0.56, 0.14, '#2a0d06', seed + 3);
    bottle(c, cx, by, h, '#4a1f0c', '#f3e6c8', '#c8262c');
    palmTree(c, cx - h * 0.03, by - h * 0.2, h * 0.2, -0.1, '#7a2a10', seed + 5); palmTree(c, cx + h * 0.04, by - h * 0.2, h * 0.17, 0.12, '#7a2a10', seed + 6);
    return ['script', '#f5c96a', '#150603', '#f3e6c8'];
  },
  airline(c, W, H, O, seed) {
    backdrop(c, W, H, ['#1a5fc4', '#58aef0', '#d9f0ff']);
    c.fillStyle = 'rgba(255,255,255,0.7)'; for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse(W * hash01(seed, i, 2), H * (0.62 + 0.34 * hash01(seed, i, 3)), W * (0.08 + 0.08 * hash01(seed, i, 4)), H * 0.05, 0, 0, Math.PI * 2); c.fill(); }
    const s = O[2] * 0.96, x = O[0] + O[2] * 0.02, y = O[1] + O[3] * 0.42;
    c.save(); c.translate(x + s / 2, y); c.rotate(0.2); c.lineCap = 'butt';
    ['#ffb21c', '#ff5a1c', '#d81f6a'].forEach((col, i) => { c.strokeStyle = col; c.lineWidth = s * 0.03; c.beginPath(); c.moveTo(s * 0.45, s * (-0.035 + 0.035 * i)); c.quadraticCurveTo(s * 0.9, s * (0.02 + 0.04 * i), s * 1.6, s * (0.35 + 0.06 * i)); c.stroke(); });
    airliner(c, -s / 2, 0, s, '#f6f7f9', '#e0461a');
    c.restore();
    return ['slant', '#ffffff', '#0e3f86', '#fff2b0'];
  },
  radio(c, W, H, O, seed) {
    backdrop(c, W, H, ['#14082e', '#4a1270']);
    c.strokeStyle = 'rgba(95,232,240,0.22)'; c.lineWidth = 1; c.beginPath(); for (let i = 0; i < 12; i++) { const y = H * (0.6 + 0.4 * Math.pow(i / 12, 1.6)); c.moveTo(-BLEED, y); c.lineTo(W + BLEED, y); } c.stroke();
    mast(c, O[0] + O[2] * 0.5, O[1] + O[3], O[3] * 0.98, '#ff4fa0', '#5fe8f0');
    c.fillStyle = '#ffe14a'; drawing('bolt', O[0] + O[2] * 0.02, O[1] + O[3] * 0.5, O[3] * 0.34)(c); c.fill(); drawing('bolt', O[0] + O[2] * 0.72, O[1] + O[3] * 0.56, O[3] * 0.28)(c); c.fill();
    for (let i = 0; i < 9; i++) sparkle(c, W * hash01(seed, i, 1), H * 0.5 * hash01(seed, i, 2), H * (0.012 + 0.02 * hash01(seed, i, 3)), '#fff6c8');
    return ['cond', '#ffe14a', '#e0207a', '#5fe8f0'];
  },
  lotion(c, W, H, O, seed) {
    backdrop(c, W, H, ['#ffd84a', '#ff8a1c']);
    const cx = O[0] + O[2] * 0.5, cy = O[1] + O[3] * 0.42;
    c.fillStyle = 'rgba(255,255,255,0.2)'; for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6 + 0.1; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + W * 2 * Math.cos(a), cy + W * 2 * Math.sin(a)); c.lineTo(cx + W * 2 * Math.cos(a + 0.14), cy + W * 2 * Math.sin(a + 0.14)); c.closePath(); c.fill(); }
    c.beginPath(); c.arc(cx, cy, Math.min(O[2], O[3]) * 0.34, 0, Math.PI * 2); c.fillStyle = '#fff3b0'; c.fill();
    const h = O[3] * 0.86, by = O[1] + O[3] * 0.98;
    bottle(c, cx, by, h, '#8a4214', '#ffe9b0', '#3a1a08');
    c.fillStyle = '#f0661a'; drawing('sun', cx - h * 0.11, by - h * 0.42, h * 0.22)(c); c.fill(); c.strokeStyle = '#f0661a'; c.lineWidth = h * 0.012; c.stroke();
    palmTree(c, O[0] - O[2] * 0.02, by + h * 0.25, h * 0.9, 0.2, '#1f6a3a', seed);
    return ['script', '#5a2408', '#fff0b8', '#5a2408'];
  },
  car(c, W, H, O, seed) {
    const hz = H * 0.6, s = Math.min(O[2] * 1.02, O[3] * 2.6);
    backdrop(c, W, H, ['#0c0620', '#4a1270', '#e03a6a', '#ff9a3a'], hz);
    bandedSun(c, O[0] + O[2] * 0.72, hz - H * 0.02, Math.min(O[3] * 0.3, O[2] * 0.3), '#fff2a0', '#ff4f7a');
    c.fillStyle = '#0b0618'; c.fillRect(-BLEED, hz, W + 2 * BLEED, H - hz + BLEED);
    c.strokeStyle = '#c22fd0'; c.lineWidth = 1; c.beginPath();
    for (let i = 1; i < 9; i++) { const y = hz + (H - hz) * Math.pow(i / 9, 1.8); c.moveTo(-BLEED, y); c.lineTo(W + BLEED, y); }
    for (let i = -12; i <= 12; i++) { c.moveTo(W / 2 + i * W * 0.03, hz); c.lineTo(W / 2 + i * W * 0.16, H + BLEED); }
    c.stroke();
    const x = O[0] + (O[2] - s) / 2, y = Math.max(hz + s * 0.12, O[1] + O[3] * 0.84);
    c.fillStyle = 'rgba(255,90,140,0.25)'; c.beginPath(); c.ellipse(x + s / 2, y + s * 0.01, s * 0.52, s * 0.035, 0, 0, Math.PI * 2); c.fill();
    coupe(c, x, y, s, hash01(seed, 1) < 0.5 ? '#e0182c' : '#f2f2f4', '#1a2440');
    return ['slant', '#ffffff', '#c2185b', '#5fe8f0'];
  },
  bank(c, W, H, O) {
    backdrop(c, W, H, ['#f8f4e8', '#efe8d4']);
    c.fillStyle = '#0f7f6e'; c.fillRect(-BLEED, -BLEED, O[0] + O[2] + BLEED, H + 2 * BLEED);
    const cx = O[0] + O[2] * 0.5, cy = O[1] + O[3] * 0.6, r = Math.min(O[2], O[3]) * 0.3;
    c.fillStyle = '#f8f4e8'; c.beginPath(); c.arc(cx, cy, r, Math.PI, 0); c.closePath(); c.fill();
    c.strokeStyle = '#f8f4e8'; c.lineWidth = r * 0.09; c.lineCap = 'butt'; c.beginPath();
    for (let i = 0; i < 9; i++) { const a = Math.PI + (i + 0.5) * Math.PI / 9; c.moveTo(cx + r * 1.18 * Math.cos(a), cy + r * 1.18 * Math.sin(a)); c.lineTo(cx + r * 1.55 * Math.cos(a), cy + r * 1.55 * Math.sin(a)); }
    for (let i = 1; i <= 3; i++) { c.moveTo(cx - r * 1.5, cy + r * 0.22 * i); c.lineTo(cx + r * 1.5, cy + r * 0.22 * i); }
    c.stroke();
    return ['geo', '#12305a', null, '#0f7f6e'];
  },
  shades(c, W, H, O, seed) {
    c.fillStyle = gradient(c, 0, 0, W, H, ['#ff3f8e', '#ff8a4a']); c.fillRect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED);
    c.fillStyle = 'rgba(255,255,255,0.12)'; for (let i = -4; i < 14; i++) { c.beginPath(); c.moveTo(W * 0.1 * i, H + BLEED); c.lineTo(W * 0.1 * i + W * 0.035, H + BLEED); c.lineTo(W * 0.1 * i + W * 0.035 + H, -BLEED); c.lineTo(W * 0.1 * i + H, -BLEED); c.closePath(); c.fill(); }
    sunglasses(c, O[0] + O[2] / 2, O[1] + O[3] / 2, Math.min(O[2] * 0.96, O[3] * 2.4), seed);
    return ['cond', '#ffffff', '#7a1040', '#fff2b0'];
  },
  carwash(c, W, H, O, seed) {
    backdrop(c, W, H, ['#1fb6d0', '#9aeaf0']);
    const s = Math.min(O[2], O[3] * 2.4), x = O[0] + (O[2] - s) / 2, y = O[1] + O[3] * 0.86;
    c.fillStyle = '#0f8fb0'; c.fillRect(-BLEED, y + s * 0.01, W + 2 * BLEED, H);
    coupe(c, x, y, s, '#ff5fa2', '#274a7a');
    for (let i = 0; i < 16; i++) {
      const bx = x + s * hash01(seed, i, 1), by = y - s * (0.16 + 0.34 * hash01(seed, i, 2)), r = s * (0.025 + 0.05 * hash01(seed, i, 3));
      c.beginPath(); c.arc(bx, by, r, 0, Math.PI * 2); c.fillStyle = 'rgba(255,255,255,0.55)'; c.fill(); c.lineWidth = 1; c.strokeStyle = '#ffffff'; c.stroke();
      c.beginPath(); c.arc(bx - r * 0.35, by - r * 0.35, r * 0.22, 0, Math.PI * 2); c.fillStyle = '#ffffff'; c.fill();
    }
    for (let i = 0; i < 5; i++) sparkle(c, x + s * (0.1 + 0.8 * hash01(seed, i, 5)), y - s * (0.08 + 0.2 * hash01(seed, i, 6)), s * 0.05, '#fffbe0');
    return ['script', '#ffffff', '#0e6f8a', '#fff9c4'];
  },
  cocktail(c, W, H, O, seed) {
    backdrop(c, W, H, ['#0b0d18', '#2a0f3a']);
    const s = Math.min(O[2], O[3]) * 0.86, cx = O[0] + O[2] / 2, cy = O[1] + O[3] * 0.52;
    c.beginPath(); c.arc(cx, cy - s * 0.1, s * 0.62, 0, Math.PI * 2); c.fillStyle = 'rgba(255,60,160,0.16)'; c.fill();
    c.strokeStyle = '#3fe07c'; c.lineWidth = Math.max(1.5, s * 0.025); c.lineCap = 'round'; drawing('palm', cx - s * 0.75, cy - s * 0.5, s * 0.95)(c); c.stroke();
    martini(c, cx + s * 0.08, cy, s, '#ff4fa0', '#7ff0f4');
    for (let i = 0; i < 6; i++) sparkle(c, W * hash01(seed, i, 1), H * hash01(seed, i, 2), H * (0.012 + 0.016 * hash01(seed, i, 3)), '#ffe9a0');
    return ['geo', '#ff5fb0', '#3a0a2a', '#7ff0f4'];
  },
  ship(c, W, H, O, seed) {
    const hz = H * 0.64, s = O[2] * 1.02;
    backdrop(c, W, H, ['#3fa6ea', '#bfe6fa', '#fff1c9'], hz);
    c.beginPath(); c.arc(W * 0.86, H * 0.2, H * 0.09, 0, Math.PI * 2); c.fillStyle = '#fff6c0'; c.fill();
    water(c, W, H, hz, ['#1a86c4', '#0b4f86'], 'rgba(255,255,255,0.55)', seed);
    liner(c, O[0], hz + H * 0.05, s, '#fbfbf6', '#d8263a');
    c.strokeStyle = '#ffffff'; c.lineWidth = 1.2; for (let i = 0; i < 3; i++) { drawing('bird', O[0] + O[2] * (0.1 + 0.3 * i), O[1] + O[3] * (0.02 + 0.08 * hash01(seed, i)), H * 0.07)(c); c.stroke(); }
    return ['serif', '#ffffff', '#0b3f73', '#fff2b0'];
  },
};

STYLES.billboard = (P, e, W, H) => {
  if (P.mask) { ground(P, W, H, WHITE, 1); return; }                  // a poster case is lit evenly from behind
  const tall = H > W, seed = hashString(e.id);
  const O = tall ? [W * 0.08, H * 0.05, W * 0.84, H * 0.54] : [W * 0.03, H * 0.08, W * 0.4, H * 0.84];
  const T = tall ? [W * 0.08, H * 0.63, W * 0.84, H * 0.31] : [W * 0.46, H * 0.14, W * 0.5, H * 0.72];
  const [font, colour, shadow, second] = ADS[e.art](P.c, W, H, O, seed);
  const drop = Math.max(1.2, T[3] * 0.022), subs = e.sub.length > 22 ? twoLines(e.sub) : [e.sub], sh = T[3] * 0.34 / subs.length;
  type(P, font === 'script' || font === 'serif' ? e.text : e.text.toUpperCase(), font, T[0], T[1], T[2], T[3] * 0.52, colour, 1, { shadow, drop, edge: shadow, edgeW: drop * 1.6 });
  subs.forEach((t, i) => type(P, t.toUpperCase(), 'geo', T[0], T[1] + T[3] * 0.66 + sh * i + sh * 0.14, T[2], sh * 0.7, second, 1, { shadow, drop: drop * 0.6, edge: shadow, edgeW: drop * 1.3 }));
  outline(P, '#f4efe2', 1, 3.5, 3.5, W - 7, H - 7, 1, 3);
};

// ---------------------------------------------------------------- putting it on the canvas

function paintEntry(ctx, e, k, ox, oy, mask) {
  const [, , W, H] = e.rect, P = { c: ctx, mask };
  ctx.save();
  ctx.setTransform(k, 0, 0, k, ox * k, oy * k);
  ctx.beginPath(); ctx.rect(-BLEED, -BLEED, W + 2 * BLEED, H + 2 * BLEED); ctx.clip();
  ctx.globalAlpha = 1;
  // a decal has no face of its own: under the paint its colour simply continues, so thin edges never pick up a fringe
  if (e.decal) ground(P, W, H, e.colors.fg, 0);
  STYLES[e.style](P, e, W, H);
  ctx.restore();
}

/**
 * Paint the whole sign atlas onto `canvas` (any square size; 4096 is the nominal one, 2048 and 1024 also land every
 * rectangle on whole pixels). Canvas row 0 is v = 0. `createCanvas(w, h)` supplies the scratch canvases where
 * neither OffscreenCanvas nor a document exists.
 * Faces that carry a mask are composed on two small scratch canvases and copied in, so the big canvas is never
 * read back (a read-back of an accelerated canvas stalls for a frame or more, and there would be hundreds).
 */
export function drawAtlas(canvas, { createCanvas } = {}) {
  const ctx = canvas.getContext('2d'), k = canvas.width / ATLAS_SIZE;
  const make = createCanvas || ((w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })));
  const masked = SIGNS.filter((e) => e.lit || e.decal);
  const sw = Math.ceil((Math.max(...masked.map((e) => e.w)) + 2 * BLEED) * k), sh = Math.ceil((Math.max(...masked.map((e) => e.h)) + 2 * BLEED) * k);
  const colour = make(sw, sh).getContext('2d', { willReadFrequently: true }), level = make(sw, sh).getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const e of SIGNS) {
    const [x, y, w, h] = e.rect;
    if (!e.lit && !e.decal) { paintEntry(ctx, e, k, x, y, false); continue; }
    const pw = Math.round((w + 2 * BLEED) * k), ph = Math.round((h + 2 * BLEED) * k);
    paintEntry(colour, e, k, BLEED, BLEED, false);
    level.setTransform(1, 0, 0, 1, 0, 0); level.fillStyle = '#000'; level.fillRect(0, 0, pw, ph);
    paintEntry(level, e, k, BLEED, BLEED, true);
    const face = colour.getImageData(0, 0, pw, ph), mask = level.getImageData(0, 0, pw, ph);
    for (let i = 3; i < face.data.length; i += 4) face.data[i] = 64 + Math.round(mask.data[i - 2] * (191 / 255));
    ctx.putImageData(face, Math.round((x - BLEED) * k), Math.round((y - BLEED) * k));
  }
  return canvas;
}

/** Create a canvas, paint the atlas on it and return it (page side: pass the result to the renderer's setAtlas). */
export function buildAtlas({ size = ATLAS_SIZE, createCanvas } = {}) {
  const make = createCanvas || ((w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h })));
  return drawAtlas(make(size, size), { createCanvas: make });
}
