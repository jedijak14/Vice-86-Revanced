// The stage the car stands on: the turntable (a fixed ramp ring round a disc that turns) and the light box hung
// over it on chains.

import { smoothstep } from '../../core/math.js';
import { CHANNEL } from '../../core/ids.js';
import { STEEL, RUBBER_PATTERN } from './setkit.js';
import { TURNTABLE, LIGHT_BOX, COLOR, GAS, RADIANCE, ROOM } from './plan.js';

const TAU = Math.PI * 2;
/** Where the warm strip sits in the ring's ramp. */
export const STRIP = Object.freeze({ radius: 2.752, y: 0.036 });

/**
 * A flat or conical band of a turned plate about the y axis: uv = (angle, metres across the grain), which is what
 * the turned-steel surface reads its concentric tool marks from. Rows are [radius, y] from the outside inwards for
 * a face that looks up, or bottom to top for a wall that looks outwards.
 */
function turned(k, rows, n, across = (r, y) => r) {
  const b = k.b;
  for (let i = 0; i < rows.length - 1; i++) {
    const [r0, y0] = rows[i], [r1, y1] = rows[i + 1], dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
    // quads run round the axis and then along the row, so the face looks along -dr in y and +dy radially: a row
    // that steps inwards faces up, one that steps upwards faces outwards
    const nr = dy / l, ny = -dr / l, base = b.count;
    for (let j = 0; j <= n; j++) {
      const a = j / n * TAU, s = Math.sin(a), c = Math.cos(a);
      b.vertex(s * r0, y0, c * r0, s * nr, ny, c * nr, a, across(r0, y0));
      b.vertex(s * r1, y1, c * r1, s * nr, ny, c * nr, a, across(r1, y1));
    }
    for (let j = 0; j < n; j++) { const q = base + j * 2; b.quad(q, q + 2, q + 3, q + 1); }
  }
}

/** The fixed ring: a ramp a tyre can climb, a flat land, a groove with the lit strip under a frosted cover. */
export function buildRing(k, tubes) {
  const T = TURNTABLE, n = k.n(96, 48), inner = T.disc + 0.008;
  k.bare(STEEL.turned, 0.3, [0.78, 0.79, 0.8]);
  const m = k.mark();
  turned(k, [[T.ring, 0], [T.ring, 0.006]], n, (r, y) => y);                                  // the lip's edge
  turned(k, [[T.ring, 0.006], [STRIP.radius + 0.011, STRIP.y + 0.005]], n);                   // ramp, outside the strip
  turned(k, [[STRIP.radius - 0.011, STRIP.y + 0.011], [T.ring - 0.13, T.top], [inner, T.top]], n);   // ramp above it, the land
  turned(k, [[inner, T.top], [inner, 0.004]], n, (r, y) => y);                                // down into the gap
  k.shade(m, (x, y, z) => 0.75 + 0.25 * smoothstep(0, 0.02, y));
  // the groove's two cheeks and the cover of the strip between them
  k.steel([0.06, 0.06, 0.06], 0.6, 0.1).occ(0.6);
  turned(k, [[STRIP.radius + 0.011, STRIP.y + 0.005], [STRIP.radius + 0.008, STRIP.y]], n);
  turned(k, [[STRIP.radius - 0.008, STRIP.y + 0.004], [STRIP.radius - 0.011, STRIP.y + 0.011]], n);
  k.neon(GAS.warm.tube, RADIANCE.strip, CHANNEL.ALWAYS);
  turned(k, [[STRIP.radius + 0.008, STRIP.y], [STRIP.radius, STRIP.y + 0.004], [STRIP.radius - 0.008, STRIP.y + 0.004]], n);
  // countersunk fixings through the land into the slab
  k.bare(1, 0.5, [0.35, 0.35, 0.36]);
  for (let i = 0; i < 16; i++) { const a = (i + 0.5) / 16 * TAU, r = T.ring - 0.17; k.cyl([Math.sin(a) * r, T.top - 0.004, Math.cos(a) * r], [Math.sin(a) * r, T.top + 0.0008, Math.cos(a) * r], 0.011, 0.011, 8, { capB: true }); }
  // the strip as data: six chords, which is as curved as a light record gets
  const points = []; for (let i = 0; i <= 48; i++) { const a = i / 48 * TAU; points.push([Math.sin(a) * STRIP.radius, STRIP.y + 0.004, Math.cos(a) * STRIP.radius]); }
  tubes.push({ id: 'turntable-strip', group: 'turntable-strip', color: GAS.warm.light.slice(), srgb: GAS.warm.tube.slice(), radiance: RADIANCE.strip, radius: 0.008, points, ends: [], length: TAU * STRIP.radius });
  return k;
}

/** The disc that turns, about the y axis through the origin: a turned steel border and a studded rubber mat. */
export function buildDisc(k) {
  const T = TURNTABLE, n = k.n(96, 48);
  k.bare(STEEL.turned, 0.34, [0.76, 0.77, 0.78]);
  turned(k, [[T.disc, 0.004], [T.disc, T.top - 0.003]], n, (r, y) => y);
  turned(k, [[T.disc, T.top - 0.003], [T.disc - 0.003, T.top], [T.mat + 0.004, T.top]], n);
  // eight plates make up the border: the joints between them, and two screws either side of each
  k.steel([0.05, 0.05, 0.05], 0.7, 0).occ(0.5);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * TAU, s = Math.sin(a), c = Math.cos(a), w = 0.0015, y = T.top + 0.0004;
    k.quad([s * (T.mat + 0.006) - c * w, y, c * (T.mat + 0.006) + s * w], [s * (T.disc - 0.004) - c * w, y, c * (T.disc - 0.004) + s * w], [s * (T.disc - 0.004) + c * w, y, c * (T.disc - 0.004) - s * w], [s * (T.mat + 0.006) + c * w, y, c * (T.mat + 0.006) - s * w]);
  }
  k.bare(1, 0.5, [0.4, 0.4, 0.41]);
  for (let i = 0; i < 8; i++) for (const da of [-0.03, 0.03]) for (const r of [T.mat + 0.05, T.disc - 0.05]) {
    const a = i / 8 * TAU + da; k.cyl([Math.sin(a) * r, T.top - 0.004, Math.cos(a) * r], [Math.sin(a) * r, T.top + 0.0008, Math.cos(a) * r], 0.009, 0.009, 8, { capB: true });
  }
  // the mat: its bevelled edge, then the studded face (uv in metres, so the studs keep their size)
  k.mat(COLOR.rubber, RUBBER_PATTERN.plain, 0.8);
  turned(k, [[T.mat + 0.004, T.top], [T.mat, T.matTop]], n);
  k.mat(COLOR.rubber, RUBBER_PATTERN.coin, 0.82);
  const rings = [T.mat, 2.0, 1.5, 1.0, 0.5], b = k.b, base = b.count;
  for (const r of rings) for (let j = 0; j <= n; j++) { const a = j / n * TAU, x = Math.sin(a) * r, z = Math.cos(a) * r; b.vertex(x, T.matTop, z, 0, 1, 0, x, z); }
  for (let i = 0; i < rings.length - 1; i++) for (let j = 0; j < n; j++) { const q = base + i * (n + 1) + j; b.quad(q, q + 1, q + n + 2, q + n + 1); }
  const centre = b.vertex(0, T.matTop, 0, 0, 1, 0, 0, 0), last = base + (rings.length - 1) * (n + 1);
  for (let j = 0; j < n; j++) b.tri(last + j, last + j + 1, centre);
  return k;
}

/** One chain link: an oval of round bar in the plane spanned by `along` and `side`. */
function link(k, c, along, side, len = 0.042, wide = 0.026, bar = 0.0038) {
  const pts = [], h = (len - wide) / 2, r = wide / 2 - bar;
  for (let i = 0; i <= 12; i++) {
    const a = i / 12 * TAU, top = Math.cos(a) >= 0 ? 1 : -1, u = Math.cos(a) * r + top * h, v = Math.sin(a) * r;
    pts.push([c[0] + along[0] * u + side[0] * v, c[1] + along[1] * u + side[1] * v, c[2] + along[2] * u + side[2] * v]);
  }
  k.tube(pts, bar, 4);
}

/** A chain from a to b, alternate links turned a quarter. */
function chain(k, a, b) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L = Math.hypot(d[0], d[1], d[2]), T = d.map((v) => v / L), pitch = 0.031, n = Math.round(L / pitch);
  // two directions across the chain
  const S1 = [T[1], -T[0], 0], l1 = Math.hypot(S1[0], S1[1]) || 1, s1 = S1.map((v) => v / l1), s2 = [T[1] * s1[2] - T[2] * s1[1], T[2] * s1[0] - T[0] * s1[2], T[0] * s1[1] - T[1] * s1[0]];
  for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; link(k, [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t], T, i % 2 ? s1 : s2); }
}

/**
 * The light box: a black sheet-steel tray with an aluminium frame round an opal diffuser in four panels, hung by
 * four chains from the trusses either side of it and fed by a cable that sags from a junction box.
 * Returns { centre, u, v } of the lit face.
 */
export function buildLightBox(k, frame, glass) {
  const { w, d, y, depth } = LIGHT_BOX, hx = w / 2, hz = d / 2, rim = 0.06;
  const m = frame.mark();
  frame.steel([0.05, 0.05, 0.055], 0.5, 0.15);
  frame.box(-hx - rim, y + 0.03, -hz - rim, hx + rim, y + depth, hz + rim, { r: 0.012 });
  // top: stiffening ribs and a row of vents
  for (const x of [-1.5, 0, 1.5]) frame.box(x - 0.02, y + depth, -hz, x + 0.02, y + depth + 0.025, hz, { r: 0.004, axis: 'z' });
  // aluminium frame under the tray, mitred look: four bars standing a little below the diffuser
  frame.bare(STEEL.brushed, 0.4, [0.72, 0.73, 0.74]);
  frame.box(-hx - rim - 0.004, y - 0.014, -hz - rim - 0.004, hx + rim + 0.004, y + 0.03, -hz, { r: 0.004, axis: 'x' });
  frame.box(-hx - rim - 0.004, y - 0.014, hz, hx + rim + 0.004, y + 0.03, hz + rim + 0.004, { r: 0.004, axis: 'x' });
  frame.box(-hx - rim - 0.004, y - 0.014, -hz, -hx, y + 0.03, hz, { r: 0.004, axis: 'z' });
  frame.box(hx, y - 0.014, -hz, hx + rim + 0.004, y + 0.03, hz, { r: 0.004, axis: 'z' });
  // glazing bars between the four panels
  for (const x of [-hx / 2, 0, hx / 2]) frame.box(x - 0.011, y - 0.01, -hz, x + 0.011, y + 0.02, hz, { r: 0.002, axis: 'z' });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const t of [0.15, 0.5, 0.85]) frame.bolt([sx * (hx + rim + 0.004), y + 0.12, sz * hz * (t * 2 - 1)], [sx, 0, 0], 0.008, 0.005);
  frame.shade(m, (px, py) => 0.6 + 0.4 * smoothstep(y + depth, y - 0.014, py));

  // the diffuser: opal sheet, a touch dimmer towards the frame where the tubes inside stop short
  const xs = [-hx, -hx + 0.3, -hx / 2, 0, hx / 2, hx - 0.3, hx], zs = [-hz, -hz + 0.3, 0, hz - 0.3, hz], b = glass.b;
  const fall = (x, z) => 0.8 + 0.2 * smoothstep(0, 0.3, Math.min(hx - Math.abs(x), hz - Math.abs(z)));
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < zs.length - 1; j++) {
    const q = b.count;
    for (const [x, z] of [[xs[i], zs[j]], [xs[i + 1], zs[j]], [xs[i + 1], zs[j + 1]], [xs[i], zs[j + 1]]]) {
      const g = fall(x, z); glass.emissive([0.88 * g, 0.94 * g, 1.0 * g], RADIANCE.diffuser);
      b.vertex(x, y, z, 0, -1, 0, x, z);
    }
    b.quad(q, q + 1, q + 2, q + 3);
  }

  // hangers: an eye bolt at each corner, a chain to a clamp on the truss chord either side
  const zTruss = 1.5, yHang = ROOM.truss;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const foot = [sx * (hx - 0.15), y + depth, sz * (hz - 0.05)], head = [sx * (hx - 0.15), yHang, sz * zTruss];
    frame.bare(2, 0.5, [0.62, 0.63, 0.64]);
    frame.cyl(foot, [foot[0], foot[1] + 0.03, foot[2]], 0.006, 0.006, 6);
    frame.lathe([foot[0], foot[1] + 0.045, foot[2]], [1, 0, 0], [[-0.004, 0.012], [-0.004, 0.02], [0.004, 0.02], [0.004, 0.012], [-0.004, 0.012]], 8, { crease: 40 });
    chain(frame, [foot[0], foot[1] + 0.05, foot[2]], [head[0], head[1] - 0.05, head[2]]);
    frame.steel(COLOR.steelDark, 0.5, 0.3);
    frame.box(head[0] - 0.03, head[1] - 0.055, head[2] - 0.08, head[0] + 0.03, head[1] - 0.004, head[2] + 0.08, { r: 0.004 });   // beam clamp
  }
  // power: a junction box on the truss, a cable down to a gland on the tray, slack between
  frame.steel([0.3, 0.31, 0.32], 0.5, 0.3);
  frame.box(1.0, yHang - 0.11, zTruss - 0.065, 1.16, yHang - 0.004, zTruss + 0.065, { r: 0.006 });
  const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push([1.08 - 0.5 * t, yHang - 0.11 - (yHang - 0.11 - y - depth - 0.03) * (t * t * 0.4 + t * 0.6) - 0.16 * Math.sin(t * Math.PI), zTruss - (zTruss - 0.6) * t]); }
  frame.rubber(COLOR.boot, 0.7); frame.tube(pts, 0.007, 6);
  frame.bare(2, 0.5, [0.6, 0.6, 0.6]); frame.cyl([0.58, y + depth, 0.6], [0.58, y + depth + 0.035, 0.6], 0.013, 0.011, 8);
  return { centre: [0, y, 0], u: [hx, 0, 0], v: [0, 0, hz] };
}
