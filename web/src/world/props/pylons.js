// Roadside pylon signs: what a motel, a diner or a garage plants at the edge of its lot so that drivers see it
// from down the road.
//
// A pylon stands on the origin like any kerbside prop, with +Z towards the carriageway. Its faces look along the
// street (+X and -X) and its arrow points away from the road (-Z), into the lot behind it.
//
// Neon is only ever where a sign maker would bend it: round the edge of a sign cabinet, along an arrow. The tubes
// stand 50 mm off the sheet metal on glass stand-offs, their ends turn back into the cabinet, and a transformer box
// with its conduit sits on the pole. A border takes the gas colour of the lettering it frames; arrows take the
// second colour of the sign. The printed faces come from the sign atlas, so each prototype carries the id of its
// atlas entry in `sign` for whoever wants the building behind it to carry the same name.

import { CHANNEL } from '../../core/ids.js';
import { fbm2 } from '../../core/math.js';
import { radianceCode, vadd, vmul, vsub, vnorm } from './kit.js';
import { C, SOURCE, srgb, times, basePlate } from './common.js';
import { signRect, signNamed } from './atlas.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const TUBE = 0.0075, STANDOFF = 0.05;            // 15 mm glass, 50 mm off the metal
const NEON_RADIANCE = 18, RIBBON = 0.03;         // beyond the near level a tube is a ribbon of the same emitted power
// what a tube does to the sheet metal behind it: a weak light this far off the panel, reaching a metre or two
const WASH_OFFSET = 0.42, WASH_POWER = 0.55, WASH_RADIUS = 2.6, GLOW_EVERY = 1.5;
// second gas colour of a sign, by the dominant primary of its lettering (linear chromaticity)
const GAS = { pink: [1, 0.05, 0.27], aqua: [0.04, 0.79, 0.75], azure: [0.035, 0.27, 0.89], warm: [1, 0.68, 0.26] };
const accentFor = (g) => (g[0] >= g[1] && g[0] >= g[2] ? (g[2] > 0.15 ? GAS.aqua : GAS.azure) : g[1] > 0.6 ? GAS.pink : GAS.warm);

/**
 * A neon tube along `pts`, mounted on a surface whose outward unit normal is `out`.
 * opts: closed (a loop), gas (linear chromaticity), channel, glowAt: where the glows go when `pts` is a curve whose
 * points depend on the level of detail (the records of a prototype must not).
 */
function neonRun(k, pts, out, { closed = false, gas, channel = CHANNEL.NEON, glowAt = null }) {
  const n = pts.length, segs = [];
  let total = 0;
  for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); segs.push([a, b, l]); total += l; }
  const along = (d) => { let acc = 0; for (const [a, b, l] of segs) { if (d <= acc + l) return vadd(a, vmul(vsub(b, a), Math.max(0, d - acc) / l)); acc += l; } return segs[segs.length - 1][1]; };
  const back = vmul(out, -STANDOFF);
  if (k.near) {
    k.neon(srgb(gas), NEON_RADIANCE, channel);
    // a loop is one tube bent round and joined behind itself; an open run turns back into the cabinet at both ends
    const path = closed ? [...pts, pts[0], vadd(pts[0], vmul(vnorm(vsub(pts[1], pts[0])), 0.012))] : [vadd(pts[0], back), ...pts, vadd(pts[n - 1], back)];
    k.tube(path, TUBE, 6, { capA: true, capB: true });
    k.bare(1, 0.4, C.alu);
    for (let d = 0.2; d < total; d += 0.55) { const p = along(d); k.cyl(vadd(p, back), vadd(p, vmul(out, -TUBE * 0.6)), 0.004, 0.004, 4); }
  } else {
    k.emissive(srgb(gas), NEON_RADIANCE * 0.22, channel);
    for (const [a, b] of segs) {
      const d = vnorm(vsub(b, a)), s = vmul(vnorm([d[1] * out[2] - d[2] * out[1], d[2] * out[0] - d[0] * out[2], d[0] * out[1] - d[1] * out[0]]), RIBBON);
      const a2 = vadd(a, vmul(d, -RIBBON * 0.5)), b2 = vadd(b, vmul(d, RIBBON * 0.5)), ridge = vmul(out, -0.02), ar = vadd(a2, ridge), br = vadd(b2, ridge);
      // It stands clear of the metal, so its back shows past the panel's edge: a closed three-sided prism, flat
      // face outwards, and not a sheet.
      k.quad(vsub(a2, s), vadd(a2, s), vadd(b2, s), vsub(b2, s));
      k.quad(vadd(a2, s), ar, br, vadd(b2, s));
      k.quad(ar, vsub(a2, s), vsub(b2, s), br);
      k.tri(vsub(a2, s), ar, vadd(a2, s)); k.tri(vsub(b2, s), vadd(b2, s), br);
    }
  }
  // wide, faint and overlapping, so the sprites add up to an even halo along the run and not a string of beads
  const parts = Math.max(1, Math.round(total / GLOW_EVERY)), color = times(gas, NEON_RADIANCE * 0.035);
  const spots = glowAt || Array.from({ length: parts }, (_, i) => along(total * (i + 0.5) / parts));
  for (const pos of spots) k.glows.push({ pos, size: 0.9, color, channel, kind: 2 });
}

/** Wash lights of a run on a face whose outward normal is `out`, at the given points of that face. */
function washes(k, points, out, gas, channel) {
  points.forEach((p, i) => k.wash(vadd(p, vmul(out, WASH_OFFSET)), channel, times(gas, WASH_POWER), WASH_RADIUS, 0.21 + 0.23 * i + (out[0] > 0 ? 0.3 : 0)));
}

/** Offset a polygon [[u, v], ...] inwards by d (mitred corners). */
function inset(poly, d) {
  let area = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  const s = area > 0 ? 1 : -1, n = poly.length;
  const normal = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [-(b[1] - a[1]) / l * s, (b[0] - a[0]) / l * s]; };
  return poly.map((p, i) => {
    const n1 = normal(poly[(i + n - 1) % n], p), n2 = normal(p, poly[(i + 1) % n]), f = d / Math.max(0.3, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * f, p[1] + (n1[1] + n2[1]) * f];
  });
}

/** Steel pole on a bolted base plate, with the hand-hole cover every such pole has near its foot. */
function pole(k, z, height, r0, r1, colour) {
  const m = k.mark();
  k.steel(colour, 0.5, 0.5);
  if (k.mid) { const plate = k.mark(); basePlate(k, r0 * 3.4, 0.025); for (let i = plate.v; i < k.b.count; i++) k.b.pos[i * 3 + 2] += z; }       // the plate is built on the origin
  k.cyl([0, k.mid ? 0.02 : 0, z], [0, height, z], r0, r1, k.n(14, 6), { capB: true, stops: [0.04, 0.3] });
  if (k.near) k.box(r0 * 0.82, 0.45, z - 0.06, r0 + 0.012, 0.75, z + 0.06, { r: 0.004 });
  k.ground(m, 0.5, 0.5).grime(m, (x, y) => 0.5 * Math.max(0, 1 - y / 0.6), C.rust);
}

/**
 * Double-faced sign cabinet across the street direction: sheet-metal box `depth` thick centred on x = 0, spanning
 * z0..z1, with a printed face `band` inside its edge on both sides. Returns the neon path of each face's border.
 * lit: internally lit acrylic (the atlas entry's own code) or a painted panel. A lit face gets its glow but no
 * light record: an acrylic face is too soft a source to light the ground from this height, and the pylon's light
 * budget goes to the wash of its neon.
 */
function cabinet(k, cy, z0, z1, depth, band, rect, colour, lit) {
  const fw = z1 - z0 - 2 * band, fh = fw / rect.aspect, h = fh + 2 * band, y0 = cy - h / 2, y1 = cy + h / 2, hx = depth / 2, zc = (z0 + z1) / 2;
  const m = k.mark();
  k.steel(colour, 0.5, 0.45);
  k.box(-hx, y0, z0, hx, y1, z1, { axis: 'z', r: k.near ? 0.012 : 0, stops: [0.25, 0.5, 0.75] });
  // rain runs off the top and drags rust down the faces from the seams
  k.grime(m, (x, y) => 0.25 * Math.max(0, 1 - (y1 - y) / 0.25) + 0.3 * Math.max(0, 1 - (y - y0) / 0.12), [0.22, 0.15, 0.1]);
  const code = lit ? Math.max(rect.emissiveCode || 0, radianceCode(3)) : 0;
  for (const s of [1, -1]) {
    k.signFace(code, CHANNEL.NEON, 0.25);
    k.panel([s * (hx + 0.003), cy, zc], [0, 0, -s], Y, fw, fh, rect.uv);
    if (k.mid) {
      // retainer angle holding the face in
      k.bare(1, 0.45, C.alu);
      const xa = s > 0 ? hx : -hx - 0.012, xb = s > 0 ? hx + 0.012 : -hx, t = 0.022;
      for (const y of [cy - fh / 2 - t, cy + fh / 2]) k.box(xa, y, zc - fw / 2 - t, xb, y + t, zc + fw / 2 + t, { axis: 'z', r: 0 });
      for (const z of [zc - fw / 2 - t, zc + fw / 2]) k.box(xa, cy - fh / 2, z, xb, cy + fh / 2, z + t, { r: 0 });
    }
    if (lit) k.glows.push({ pos: [s * (hx + 0.003), cy, zc], size: Math.min(2.4, fw * 0.8), color: times(rect.glow, 2.4), channel: CHANNEL.NEON, kind: 2 });
  }
  const e = band * 0.5, border = (s) => [[z0 + e, y0 + e], [z1 - e, y0 + e], [z1 - e, y1 - e], [z0 + e, y1 - e]].map(([z, y]) => [s * (hx + STANDOFF), y, z]);
  return { y0, y1, hx, border };
}

/**
 * Sheet-metal arrow cabinet from a (y, z) outline, `depth` thick, with a tube round its edge on both faces and
 * their wash at `lit` (y, z).
 */
function arrowPanel(k, outline, depth, colour, gas, channel, lit) {
  const m = k.mark(), hx = depth / 2;
  k.steel(colour, 0.5, 0.5);
  k.extrude(outline, [-hx, 0, 0], Y, Z, depth, { crease: 40 });
  k.grime(m, (x, y, z) => 0.15 + 0.5 * Math.max(0, fbm2(z * 1.4, y * 1.4, 3, 61) - 0.45) * 2, [0.2, 0.14, 0.1]);
  const edge = inset(outline, 0.06);
  for (const s of [1, -1]) {
    neonRun(k, edge.map(([y, z]) => [s * (hx + STANDOFF), y, z]), [s, 0, 0], { closed: true, gas, channel });
    washes(k, lit.map(([y, z]) => [s * hx, y, z]), [s, 0, 0], gas, channel);
  }
}

/** Transformer box strapped to the pole and the conduit that takes the high-tension leads up to the cabinets. */
function transformer(k, z, r, y, top) {
  if (!k.mid) return;
  k.steel([0.42, 0.43, 0.42], 0.55, 0.45);
  k.box(-0.13, y, z - r - 0.19, 0.13, y + 0.36, z - r - 0.01, { r: 0.008 });
  if (!k.near) return;
  k.bare(2, 0.55, C.galv);
  k.tube([[0.06, y + 0.36, z - r - 0.06], [0.06, y + 0.5, z - r - 0.03], [0.06, top, z - r - 0.03]], 0.011, 5, { capB: true });
  for (const yy of [y + 0.7, (y + top) / 2, top - 0.3]) k.box(0.04, yy, z - r - 0.05, 0.08, yy + 0.02, z - r + 0.01, { r: 0 });
}

// ---------------------------------------------------------------- motel
/**
 * Motel pylon: the name in a lit cabinet at the top with a neon border, a hanging VACANCY box on the road side and
 * an arrow cabinet below that slants down towards the lot.
 */
function motel(k, o) {
  const rect = signRect('motel', o.seed), accent = accentFor(rect.glow), H = o.height, r0 = 0.115, r1 = 0.095;
  pole(k, 0, H - 0.3, r0, r1, o.pole);
  const w = 3.5, main = cabinet(k, H - 0.72, -w / 2, w / 2, 0.36, 0.1, rect, o.cabinet, true);
  for (const s of [1, -1]) neonRun(k, main.border(s), [s, 0, 0], { closed: true, gas: rect.glow });
  // VACANCY: its own small lit box hung under the road end of the name
  const vac = signNamed('window/vacancy', 'window', 0), vw = 1.25, vy = main.y0 - 0.12 - (vw - 0.1) / vac.aspect / 2 - 0.05, vz0 = w / 2 - vw - 0.05;
  const small = cabinet(k, vy, vz0, vz0 + vw, 0.22, 0.05, vac, o.cabinet, true);
  if (k.mid) { k.steel(o.pole, 0.5, 0.5); for (const z of [vz0 + 0.15, vz0 + vw - 0.15]) k.box(-0.02, small.y1 - 0.01, z - 0.02, 0.02, main.y0 + 0.01, z + 0.02, { r: 0 }); }
  // arrow: tail up on the road side, head down towards the lot
  const t = o.tilt * Math.PI / 180, d = [-Math.sin(t), -Math.cos(t)], e = [Math.cos(t), -Math.sin(t)], L = 3.3, sh = 0.2, hw = 0.46, hd = 0.75;
  const cy = small.y0 - 0.5 - L / 2 * Math.sin(t);                    // low enough for the raised tail to clear the box above it
  const at = (a, b) => [cy + a * d[0] + b * e[0], a * d[1] + b * e[1]];
  const outline = [at(-L / 2, -sh), at(L / 2 - hd, -sh), at(L / 2 - hd, -hw), at(L / 2, 0), at(L / 2 - hd, hw), at(L / 2 - hd, sh), at(-L / 2, sh)];
  arrowPanel(k, outline, 0.26, o.arrow, accent, o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON, [at(L * 0.12, 0)]);
  transformer(k, 0, r0, 2.5, cy - 0.15);
}

// ---------------------------------------------------------------- diner
/**
 * Diner pylon: the name cabinet on a single pole, an OPEN box under it and a band of sheet metal that sweeps over
 * the top from the road side and comes down as an arrow head above the lot, with one tube along its centre line.
 */
function diner(k, o) {
  const rect = signRect('diner', o.seed), accent = accentFor(rect.glow), w = 2.9, cyMain = o.height - 2.3, r0 = 0.105, r1 = 0.09;
  const R = w / 2 + 0.55, half = 0.17, yc = cyMain + 0.15, n = k.n(18, 6), a0 = 0.12, a1 = Math.PI * 0.98;
  pole(k, 0, yc + R + 0.02, r0, r1, o.pole);
  const main = cabinet(k, cyMain, -w / 2, w / 2, 0.36, 0.1, rect, o.cabinet, true);
  for (const s of [1, -1]) neonRun(k, main.border(s), [s, 0, 0], { closed: true, gas: rect.glow });
  const open = signNamed('window/open', 'window', 0), ow = 1.1, oy = main.y0 - 0.1 - (ow - 0.1) / open.aspect / 2 - 0.05, oz0 = w / 2 - ow - 0.05;
  const small = cabinet(k, oy, oz0, oz0 + ow, 0.22, 0.05, open, o.cabinet, true);
  if (k.mid) { k.steel(o.pole, 0.5, 0.5); for (const z of [oz0 + 0.15, oz0 + ow - 0.15]) k.box(-0.02, small.y1 - 0.01, z - 0.02, 0.02, main.y0 + 0.01, z + 0.02, { r: 0 }); }
  // the sweep: outer arc, arrow head, inner arc back (y, z)
  const pt = (a, r) => [yc + Math.sin(a) * r, Math.cos(a) * r], outer = [], inner = [], centre = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; outer.push(pt(a, R + half)); inner.push(pt(a, R - half)); centre.push(pt(a, R)); }
  const tip = [yc + Math.sin(a1) * R - 0.62, Math.cos(a1) * R - 0.04];
  const outline = [...outer, pt(a1, R + half + 0.24), tip, pt(a1, R - half - 0.24), ...inner.reverse()];
  const m = k.mark();
  k.steel(o.arrow, 0.5, 0.5);
  k.extrude(outline, [-0.11, 0, 0], Y, Z, 0.22, { crease: 40 });
  k.grime(m, (x, y) => 0.3 * Math.max(0, 1 - (y - (yc - 0.7)) / 0.5), [0.22, 0.15, 0.1]);
  if (k.mid) { k.steel(o.pole, 0.5, 0.5); for (const z of [-w / 2 + 0.1, w / 2 - 0.1]) k.bar([0, main.y1 - 0.01, z], [0, yc + Math.sqrt(Math.max(0.01, (R - half) ** 2 - z * z)) + 0.02, z], 0.05, 0.05, { up: X, r: 0 }); }   // struts up to the band
  for (const s of [1, -1]) {
    const x = s * (0.11 + STANDOFF), run = (p) => [x, p[0], p[1]];
    neonRun(k, [...centre.map(run), run([tip[0] + 0.14, tip[1]])], [s, 0, 0], { gas: accent, channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON, glowAt: [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => run(pt(a0 + (a1 - a0) * f, R))) });
    neonRun(k, [run(pt(a1, R + half + 0.17)), run([tip[0] + 0.1, tip[1]]), run(pt(a1, R - half - 0.17))], [s, 0, 0], { gas: accent, channel: o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON });
    washes(k, [0.62].map((f) => { const p = pt(a0 + (a1 - a0) * f, R); return [s * 0.11, p[0], p[1]]; }), [s, 0, 0], accent, o.flicker ? CHANNEL.FLICKER : CHANNEL.NEON);
  }
  transformer(k, 0, r0, 2.4, main.y0 - 0.2);
}

// ---------------------------------------------------------------- garage
/**
 * Garage pylon: no neon (a workshop paints its sign). A painted board between two posts, lit from above by a
 * gooseneck lamp on each side, and a painted arrow board under it.
 */
function garage(k, o) {
  const rect = signRect('garage', o.seed), zs = [-1.75, 1.75], H = o.height, r = 0.07;
  for (const z of zs) pole(k, z, H, r, r, o.pole);
  const board = cabinet(k, H - 0.75, zs[0] + 0.02, zs[1] - 0.02, 0.12, 0.07, rect, o.cabinet, false);
  // painted arrow board
  const cy = board.y0 - 0.55, at = (a, b) => [cy + b, -a], L = 2.6, sh = 0.13, hw = 0.33, hd = 0.6;
  const m = k.mark();
  k.steel(o.arrow, 0.55, 0.6);
  k.extrude([at(-L / 2, -sh), at(L / 2 - hd, -sh), at(L / 2 - hd, -hw), at(L / 2, 0), at(L / 2 - hd, hw), at(L / 2 - hd, sh), at(-L / 2, sh)], [-0.02, 0, 0], Y, Z, 0.04, { crease: 40 });
  k.grime(m, (x, y, z) => 0.2 + 0.5 * Math.max(0, fbm2(z * 1.6, y * 1.6, 3, 67) - 0.45) * 2, [0.24, 0.15, 0.1]);
  if (k.mid) { k.steel(o.pole, 0.5, 0.5); k.box(-0.035, cy - 0.03, zs[0], -0.02, cy + 0.03, zs[1], { axis: 'z', r: 0 }); }     // the rail it is bolted to
  // gooseneck lamps over each face
  for (const s of [1, -1]) {
    const yTop = board.y1, lens = [s * 0.62, yTop + 0.2, 0];
    k.bare(2, 0.5, C.galv);
    if (k.mid) k.tube([[s * 0.03, yTop - 0.05, 0], [s * 0.06, yTop + 0.3, 0], [s * 0.3, yTop + 0.5, 0], [s * 0.55, yTop + 0.42, 0], [s * 0.62, yTop + 0.27, 0]], 0.014, k.n(6, 4), { capA: true, capB: true });
    k.steel([0.2, 0.26, 0.22], 0.5, 0.4);
    k.lathe([lens[0], lens[1], 0], Y, [[0, 0.15], [0.02, 0.15], [0.09, 0.05], [0.1, 0]], k.n(12, 6), { crease: 40 });      // enamel shade
    k.lens(srgb(SOURCE.warmWhite), 14, CHANNEL.STREET);
    k.lathe([lens[0], lens[1], 0], Y, [[-0.012, 0], [-0.012, 0.15], [0, 0.15]], k.n(12, 6), { crease: 40 });               // closes the shade's mouth ring to ring
    k.fixture([lens[0], lens[1] - 0.012, 0], CHANNEL.STREET, { color: times(SOURCE.warmWhite, 7), radius: 7, spot: { axis: [-s * 0.75, -0.66, 0], outerDeg: 72, innerDeg: 40 } }, { color: times(SOURCE.warmWhite, 14), size: 0.5, kind: 0 }, 0.3 + 0.3 * (s > 0 ? 1 : 0));
  }
}

const WHITE = [0.8, 0.79, 0.74], CREAM = [0.78, 0.72, 0.58];
const def = (name, build, sign, collider, footprint, more = {}) => ({ name, build, far: [45, 150, 520], footprint, collider, tags: ['sign', 'pylon', 'large', 'lit'], extra: { sign: sign.id, faces: 'x', ...more } });
// a car can pass between the garage's two posts: each post is its own collider and the gap stays open
const POSTS = { extraColliders: [-1.75, 1.75].map((z) => ({ kind: 'cylinder', radius: 0.09, height: 3, offset: [0, 0, z] })) };

export const PYLONS = [
  def('pylon_motel_a', (k) => motel(k, { seed: 0, height: 8.2, tilt: 24, pole: WHITE, cabinet: [0.3, 0.52, 0.55], arrow: [0.74, 0.62, 0.3] }), signRect('motel', 0), { kind: 'cylinder', radius: 0.14, height: 3 }, 1.9),
  def('pylon_motel_b', (k) => motel(k, { seed: 1, height: 7.4, tilt: 8, pole: [0.5, 0.36, 0.36], cabinet: [0.72, 0.5, 0.5], arrow: [0.3, 0.46, 0.56], flicker: true }), signRect('motel', 1), { kind: 'cylinder', radius: 0.14, height: 3 }, 1.9),
  def('pylon_motel_c', (k) => motel(k, { seed: 3, height: 8.8, tilt: 32, pole: [0.42, 0.44, 0.45], cabinet: CREAM, arrow: [0.66, 0.3, 0.26] }), signRect('motel', 3), { kind: 'cylinder', radius: 0.14, height: 3 }, 1.9),
  def('pylon_diner_a', (k) => diner(k, { seed: 1, height: 8.0, pole: WHITE, cabinet: [0.62, 0.64, 0.64], arrow: [0.68, 0.28, 0.24] }), signRect('diner', 1), { kind: 'cylinder', radius: 0.13, height: 3 }, 2.2),
  def('pylon_diner_b', (k) => diner(k, { seed: 2, height: 7.2, pole: [0.3, 0.42, 0.44], cabinet: CREAM, arrow: [0.3, 0.5, 0.52], flicker: true }), signRect('diner', 2), { kind: 'cylinder', radius: 0.13, height: 3 }, 2.2),
  def('pylon_garage_a', (k) => garage(k, { seed: 1, height: 5.6, pole: [0.4, 0.4, 0.38], cabinet: WHITE, arrow: [0.76, 0.62, 0.2] }), signRect('garage', 1), null, 2.0, POSTS),
  def('pylon_garage_b', (k) => garage(k, { seed: 0, height: 5.2, pole: [0.5, 0.2, 0.16], cabinet: WHITE, arrow: [0.6, 0.18, 0.14] }), signRect('garage', 0), null, 2.0, POSTS),
];
