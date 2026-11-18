// A single-stroke alphabet for lettering moulded in relief (tyre sidewalls, lamp lenses, cast parts).
// Each glyph is a set of polylines in a box one cap-height tall; x runs to the right from 0 to the glyph's width.
// Only the characters our own markings use are drawn.

const arc = (cx, cy, rx, ry, from, to, n) => { const out = []; for (let i = 0; i <= n; i++) { const a = (from + (to - from) * i / n) * Math.PI / 180; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } return out; };

const GLYPHS = {
  A: { w: 0.74, lines: [[[0, 0], [0.37, 1], [0.74, 0]], [[0.13, 0.36], [0.61, 0.36]]] },
  D: { w: 0.68, lines: [[[0, 0], [0, 1], [0.3, 1], ...arc(0.3, 0.5, 0.38, 0.5, 90, -90, 8).slice(1), [0, 0]]] },
  E: { w: 0.6, lines: [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.52], [0.48, 0.52]]] },
  G: { w: 0.74, lines: [[...arc(0.37, 0.5, 0.37, 0.5, 45, 360, 12), [0.4, 0.5]]] },
  I: { w: 0.1, lines: [[[0.05, 0], [0.05, 1]]] },
  L: { w: 0.56, lines: [[[0, 1], [0, 0], [0.56, 0]]] },
  N: { w: 0.68, lines: [[[0, 0], [0, 1], [0.68, 0], [0.68, 1]]] },
  O: { w: 0.74, lines: [arc(0.37, 0.5, 0.37, 0.5, 90, 450, 16)] },
  R: { w: 0.68, lines: [[[0, 0], [0, 1], [0.38, 1], ...arc(0.38, 0.74, 0.26, 0.26, 90, -90, 6).slice(1), [0, 0.48]], [[0.36, 0.48], [0.68, 0]]] },
  S: { w: 0.6, lines: [[...arc(0.3, 0.75, 0.27, 0.25, 30, 270, 8), ...arc(0.3, 0.25, 0.3, 0.25, 90, -150, 8).slice(1)]] },
  T: { w: 0.68, lines: [[[0, 1], [0.68, 1]], [[0.34, 1], [0.34, 0]]] },
  V: { w: 0.74, lines: [[[0, 1], [0.37, 0], [0.74, 1]]] },
  0: { w: 0.6, lines: [arc(0.3, 0.5, 0.3, 0.5, 90, 450, 14)] },
  1: { w: 0.36, lines: [[[0, 0.76], [0.26, 1], [0.26, 0]]] },
  2: { w: 0.6, lines: [[...arc(0.3, 0.72, 0.28, 0.28, 165, -35, 7), [0, 0], [0.6, 0]]] },
  3: { w: 0.6, lines: [[...arc(0.28, 0.75, 0.27, 0.25, 150, -90, 6), ...arc(0.28, 0.27, 0.31, 0.27, 90, -150, 7).slice(1)]] },
  4: { w: 0.64, lines: [[[0.46, 0], [0.46, 1], [0, 0.3], [0.64, 0.3]]] },
  5: { w: 0.6, lines: [[[0.54, 1], [0.08, 1], [0.03, 0.56], ...arc(0.27, 0.31, 0.31, 0.31, 100, -150, 8)]] },
  6: { w: 0.6, lines: [[...arc(0.62, 0.31, 0.62, 0.69, 100, 180, 5), ...arc(0.3, 0.31, 0.3, 0.31, 180, 540, 14).slice(1)]] },
  7: { w: 0.6, lines: [[[0, 1], [0.6, 1], [0.22, 0]]] },
  8: { w: 0.6, lines: [arc(0.3, 0.75, 0.25, 0.25, -90, 270, 12), arc(0.3, 0.27, 0.3, 0.27, 90, 450, 12)] },
  9: { w: 0.6, lines: [[...arc(-0.02, 0.69, 0.62, 0.69, 280, 360, 5), ...arc(0.3, 0.69, 0.3, 0.31, 0, 360, 14).slice(1)]] },
  '/': { w: 0.46, lines: [[[0, 0], [0.46, 1]]] },
  ' ': { w: 0.42, lines: [] },
};
const GAP = 0.26;

/** Width of a line of text in cap heights. */
export function textWidth(text) {
  let w = 0; for (const ch of text) { const g = GLYPHS[ch]; if (!g) throw new Error(`lettering: no glyph for "${ch}"`); w += g.w + GAP; }
  return w - GAP;
}

/**
 * The strokes of a line of text as polylines in cap heights, starting at x = 0. A stroke is broken wherever it
 * turns a sharp corner, so that each piece can be given a thickness without the corner folding over itself, and
 * no segment is longer than maxSegment.
 */
export function strokes(text, maxSegment = 1) {
  const out = []; let x = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    for (const line of g.lines) {
      let pts = [[line[0][0] + x, line[0][1]]];
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSegment));
        for (let k = 1; k <= n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n + x, a[1] + (b[1] - a[1]) * k / n]);
        const c = line[i + 1];
        if (c) {
          const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
          if ((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)) < 0.75) { out.push(pts); pts = [[b[0] + x, b[1]]]; }
        }
      }
      out.push(pts);
    }
    x += g.w + GAP;
  }
  return out;
}
