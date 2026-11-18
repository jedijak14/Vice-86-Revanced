// Road wheels of the traffic vehicles: tyre, rim, one of six period wheel faces and the brake seen behind it.
//
// A wheel is modelled as the LEFT wheel with its centre at the origin and the axle along X; the outer face
// looks towards +X. Most of it is a surface of revolution about the axle. At the nearest level the openings of
// a wheel disc are real holes with the brake behind them; further away they are dark patches laid on the face.

import { MeshBuilder } from '../../core/mesh.js';
import { Skin } from './skin.js';
import { lathe, disc, cap, quad, rod, vec, X, Y, Z } from './kit.js';
import * as mt from './materials.js';

// Segments round the wheel per level. The nearest is seen from a couple of metres and must show no facets;
// 60 also divides by every count of openings used here, so their edges fall on the rings around them.
const SEGS = [60, 20, 8];
const TAU = 2 * Math.PI, O = [0, 0, 0];
const whitewall = mt.fixed([0.9, 0.89, 0.84], true);
const steelBlack = mt.rim([0.07, 0.07, 0.075], 0.6, 0.3);
const dark = mt.trim(0.9, [0.02, 0.02, 0.022]);
/** Brake drum and hub: cast iron under a film of rust and dust. */
const iron = mt.rim([0.17, 0.145, 0.125], 0.85, 0.3);
/** The dish behind the wires of a wire wheel cover: darker than the wires so that they stand out. */
const wireDish = mt.rim([0.4, 0.41, 0.43], 0.3, 1);
const alloy = mt.rim([0.72, 0.73, 0.74], 0.28, 1);
const emblem = mt.fixed([0.3, 0.02, 0.03]);

/**
 * Rings of a surface of revolution from points [h along the axle, radius, occlusion, material, tyre v]. Each
 * ring's normal is square to the line through its neighbours, on the left of the direction of travel, so a
 * run is smooth and a crease is made by starting a new run.
 */
function rings(pts) {
  return pts.map((p, k) => {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], dh = b[0] - a[0], dr = b[1] - a[1], l = Math.hypot(dh, dr) || 1;
    return { h: p[0], r: p[1], nh: -dr / l, nr: dh / l, occ: p[2] ?? 1, m: p[3], v: p[4] };
  });
}

/**
 * Tyre section from the inner bead over the tread to the outer bead: a flat tread, a rounded shoulder and a
 * sidewall that is widest half way down. v follows the TYRE convention (1 at the shoulders, 2 at the beads).
 * The inner half, which is only glimpsed under the car, is drawn with the points of the next coarser level.
 */
function tyreSection(R, w, rimR, white, level, centre = 0) {
  const hw = w / 2, sw = R - rimR;
  const half = (lv, band) => {
    const P = [], add = (h, r, v, lod = 2, m = null) => { if (lod >= lv) P.push([h, r, 1, m, v]); };
    add(hw - 0.055, R, 0.8);
    add(hw - 0.036, R - 0.003, 0.9, 0);
    add(hw - 0.02, R - 0.012, 1, 1);
    add(hw - 0.008, R - 0.03, 1.12, 0);
    add(hw - 0.002, R - sw * 0.32, 1.3);
    // A narrow white band on the outer sidewall, the mark of a comfortable American car of the time.
    if (band) { add(hw, rimR + sw * 0.62, 1.45, 2, whitewall); add(hw, rimR + sw * 0.62 - 0.02, 1.55); }
    else add(hw, rimR + sw * 0.5, 1.5, 1);
    add(hw - 0.006, rimR + sw * 0.2, 1.8, 0);
    add(hw - 0.016, rimR + 0.005, 1.95, 0);
    add(hw - 0.022, rimR - 0.002, 2);
    return P;
  };
  const inner = half(Math.min(2, level + 2), false).reverse().map((p) => [-p[0], p[1], 1, null, -p[4]]);
  return [...inner, ...half(level, white && level < 2)].map((p) => [p[0] + centre, p[1], p[2], p[3], p[4]]);
}

/**
 * Outline of an opening in a wheel disc as [radial, tangential] offsets in metres from its centre: a
 * superellipse of half sizes a by b; power 2 is an oval, 4 a rounded rectangle. `flare` widens it towards
 * the rim, which leaves spokes of even width between neighbours.
 */
function opening(a, b, power = 2, flare = 0, n = 12) {
  return Array.from({ length: n }, (_, j) => {
    const t = ((j + 0.5) / n) * TAU, c = Math.cos(t), s = Math.sin(t), dr = a * Math.sign(c) * Math.abs(c) ** (2 / power);
    return [dr, b * (1 + flare * dr / a) * Math.sign(s) * Math.abs(s) ** (2 / power)];
  });
}

/**
 * spec = { R, w, rimR, style, whitewall, dual, color, ring, cap, lugs }.
 *   style 'steel'  painted steel wheel with vent holes and a chrome hub cap ('dish' covers the nuts, 'small'
 *                  leaves them showing); `ring` adds a bright trim ring
 *         'wire'   full chrome cover with two crossed layers of wires
 *         'cover'  pressed full wheel cover with radial slots
 *         'rally'  painted sports wheel with five windows, trim ring and chrome centre
 *         'alloy'  cast five-spoke wheel
 *         'truck'  bus or lorry wheel with hand holes and a hub that stands proud; `dual` builds the twin
 *                  rear wheel (two tyres, deeply dished centre)
 */
export function buildWheel(spec, level) {
  const mb = new MeshBuilder(1024), sk = new Skin(mb), { R, w, rimR } = spec, segs = SEGS[level], fine = level === 0 ? 30 : segs;
  /**
   * Lathe a profile about the axle. Small parts near the hub are turned with half as many segments; their
   * outermost ring is then grown until its flats touch the circle it stands on, and lifted a hair, so that the
   * coarse polygon overlaps the finer ring it meets instead of leaving slivers open between the two.
   */
  const turn = (m, pts, n = segs, uvOf = null) => {
    const rs = rings(pts);
    if (n < segs) { const o = rs.reduce((a, b) => (b.r > a.r ? b : a)); o.r /= Math.cos(Math.PI / n); o.h += 0.0003; }
    return lathe(sk, m, O, X, Y, Z, rs, n, uvOf);
  };
  const tyre = (centre) => turn(mt.tyre, tyreSection(R, w, rimR, spec.whitewall, level, centre), segs, (p, f) => [f, p.v]);
  const nuts = (n, r, h, len = 0.014) => { if (level === 0) for (let k = 0; k < n; k++) { const t = ((k + 0.5) / n) * TAU; rod(sk, mt.chrome, [h, Math.cos(t) * r, Math.sin(t) * r], [h + len, Math.cos(t) * r, Math.sin(t) * r], 0.011, 6); } };

  /**
   * The part of a wheel disc between radius r1 (at height h1) and r0 (at h0) with n openings through it.
   * Each of the n sectors is filled between its own edge and the outline of its opening; the opening gets a
   * wall `depth` deep so the disc shows its thickness. Away from the nearest level: a plain ring and dark patches.
   */
  const band = ({ n, r0, r1, h0, h1, m, depth, hole, occ0 = 1, occ1 = 1 }) => {
    const rc = (r0 + r1) / 2;
    if (level > 0) {
      turn(m, [[h1, r1, occ1], [h0, r0, occ0]]);
      if (level === 2) return;
      const a = Math.max(...hole.map((q) => q[0])) * 0.85, b = Math.max(...hole.map((q) => q[1])) * 0.85, lift = 0.001;
      for (let k = 0; k < n; k++) {
        const tc = ((k + 0.5) / n) * TAU, P = (dr, ds) => { const r = rc + dr, t = tc + ds / rc; return [h0 + (h1 - h0) * (r - r0) / (r1 - r0) + lift, r * Math.cos(t), r * Math.sin(t)]; };
        quad(sk, dark, [P(-a, -b), P(a, -b), P(a, b), P(-a, b)], X, null, 0.5);
      }
      return;
    }
    const per = segs / n, len = Math.hypot(h1 - h0, r1 - r0), nx = (r1 - r0) / len, nr = -(h1 - h0) / len;
    const hAt = (r) => h0 + (h1 - h0) * (r - r0) / (r1 - r0), occAt = (r) => occ0 + (occ1 - occ0) * (r - r0) / (r1 - r0);
    for (let k = 0; k < n; k++) {
      const tc = ((k + 0.5) / n) * TAU;
      const at = (r, t, dr, ds) => ({ node: sk.raw(hAt(r), r * Math.cos(t), r * Math.sin(t), nx, nr * Math.cos(t), nr * Math.sin(t), 0, 0, occAt(r)), t: Math.atan2(ds, dr), r, a: t });
      const edge = [], rim = hole.map(([dr, ds]) => at(rc + dr, tc + ds / rc, dr, ds));
      for (let i = 0; i <= per; i++) { const t = ((k * per + i) / segs) * TAU; edge.push(at(r0, t, r0 - rc, (t - tc) * rc)); }
      for (let i = per; i >= 0; i--) { const t = ((k * per + i) / segs) * TAU; edge.push(at(r1, t, r1 - rc, (t - tc) * rc)); }
      // Both outlines are walked once round the centre of the opening and joined as one closed strip.
      const loop = (row) => { const s = row.slice().sort((p, q) => p.t - q.t); return [...s, { ...s[0], t: s[0].t + TAU }]; };
      sk.stitch(loop(edge), loop(rim), m);
      const walls = rim.map((p, j) => {
        const a = hole[(j + rim.length - 1) % rim.length], b = hole[(j + 1) % rim.length], q = hole[j];
        let ir = -(b[1] - a[1]), is = b[0] - a[0];
        if (ir * q[0] + is * q[1] > 0) { ir = -ir; is = -is; }   // the wall faces the middle of the opening
        const l = Math.hypot(ir, is) || 1, c = Math.cos(p.a), s = Math.sin(p.a), ny = (ir * c - is * s) / l, nz = (ir * s + is * c) / l, h = hAt(p.r);
        return [sk.raw(h, p.r * c, p.r * s, 0, ny, nz, 0, 0, 0.75), sk.raw(h - depth, p.r * c, p.r * s, 0, ny, nz, 0, 0, 0.3)];
      });
      walls.forEach((a, j) => { const b = walls[(j + 1) % walls.length]; sk.quad(a[0], b[0], b[1], a[1], m); });
    }
  };

  /**
   * Inside of the rim from height h1 back to h0. Whatever stands behind a wheel disc is narrower than the rim,
   * so a glance through an opening at a slant ends on this wall and never looks out of the back of the wheel.
   */
  const barrel = (m, h1, h0, r = rimR - 0.018) => { turn(m, [[h1, r, 0.5], [h0, r, 0.25]]); turn(dark, [[h0, r, 0.25], [h0, r - 0.04, 0.25]]); };
  /** Brake drum, which also closes the view through the openings of a steel wheel. */
  const drum = (h, m = steelBlack) => {
    if (level > 0) return;
    barrel(m, h + 0.02, h - 0.012);
    turn(iron, [[h, rimR - 0.024, 0.45], [h + 0.004, rimR * 0.55, 0.6], [h + 0.014, rimR * 0.34, 0.65], [h + 0.014, 0, 0.65]], fine);
  };
  /** Brake disc behind an open sports wheel: the bright swept face, its iron hat and the dark gap round it. */
  const brake = (h, front, m, r) => {
    if (level > 0) return;
    barrel(m, front, h - 0.012, r);
    turn(mt.brakeDisc, [[h, rimR - 0.03], [h, rimR * 0.5]], segs, (p, f) => [p.r, f]);
    turn(iron, [[h, rimR * 0.5, 0.7], [h + 0.02, rimR * 0.46, 0.8], [h + 0.022, 0, 0.8]], fine);
  };

  if (spec.dual) {
    const off = w / 2 + 0.02, f = off + w / 2 - 0.022, col = mt.rim(spec.color || [0.75, 0.75, 0.73], 0.5, 0.2);
    tyre(-off); tyre(off);
    // Outer rim lip, then a deep cone in to the hub, which stands out again in the middle.
    turn(col, [[f, rimR + 0.004], [f + 0.005, rimR + 0.002], [f + 0.003, rimR - 0.012], [f - 0.02, rimR - 0.03, 0.8]]);
    band({ n: 5, r1: rimR - 0.03, h1: f - 0.02, r0: rimR * 0.52, h0: f - 0.165, m: col, depth: 0.01, hole: opening(rimR * 0.1, rimR * 0.13), occ1: 0.8, occ0: 0.5 });
    turn(steelBlack, [[f - 0.165, rimR * 0.52, 0.5], [f - 0.165, rimR * 0.36, 0.55]]);
    turn(steelBlack, [[f - 0.165, rimR * 0.36, 0.6], [f - 0.07, rimR * 0.3, 0.8]], fine);
    turn(steelBlack, [[f - 0.07, rimR * 0.3, 0.9], [f - 0.062, rimR * 0.2, 0.9], [f - 0.06, 0, 0.9]], fine);
    nuts(10, rimR * 0.44, f - 0.165, 0.022);
    // Between and behind the two tyres only a dark drum is ever glimpsed.
    turn(dark, [[-f, rimR, 0.4], [f, rimR, 0.6]]);
    if (level === 0) { barrel(steelBlack, f - 0.02, f - 0.2, rimR - 0.03); cap(sk, dark, [f - 0.2, 0, 0], X, Y, Z, rimR - 0.03, fine, 0.3); }
    cap(sk, dark, [-f, 0, 0], [-1, 0, 0], Z, Y, rimR, segs, 0.4);
    return mb;
  }

  tyre(0);
  // fb: the plane of the outer bead. The rim's rolled lip stands just proud of it; fd is the wheel disc, set back inside the rim.
  const fb = w / 2 - 0.022, fd = fb - 0.032;
  const lip = (m) => turn(m, level === 0 ? [[fb, rimR + 0.004], [fb + 0.006, rimR + 0.002], [fb + 0.007, rimR - 0.005], [fb + 0.002, rimR - 0.012]] : [[fb, rimR + 0.004], [fb + 0.005, rimR + 0.002], [fb + 0.002, rimR - 0.012]]);
  const well = (m) => turn(m, [[fb + 0.002, rimR - 0.012, 0.9], [fd, rimR - 0.018, 0.55]]);
  /** Bright trim ring pressed into the rim: it hides the rim's well and ends on the disc. */
  const trimRing = () => turn(mt.chrome, [[fb + 0.002, rimR - 0.012], [fb - 0.006, rimR - 0.022], [fd + 0.004, rimR * 0.8, 0.8]]);
  const style = spec.style;

  if (style === 'wire') {
    lip(mt.chrome);
    turn(mt.chrome, [[fb + 0.002, rimR - 0.012], [fb + 0.006, rimR * 0.9]]);
    turn(mt.chrome, [[fb + 0.006, rimR * 0.9], [fb - 0.006, rimR * 0.86, 0.7]]);
    const hOf = (r) => fb - 0.006 + 0.012 * (rimR * 0.86 - r) / (rimR * 0.56);
    turn(level === 0 ? wireDish : mt.argent, [[hOf(rimR * 0.86), rimR * 0.86, 0.5], [hOf(rimR * 0.3), rimR * 0.3, 0.8]]);
    turn(mt.chrome, [[hOf(rimR * 0.3), rimR * 0.3], [fb + 0.018, rimR * 0.27], [fb + 0.022, rimR * 0.17]], fine);
    turn(emblem, [[fb + 0.022, rimR * 0.17], [fb + 0.023, 0]], fine);
    if (level === 0) {
      // Each wire is a low ridge from the rim to the hub, leaning round the wheel; the second layer leans the other way and lies over the first.
      const count = 30, lean = (TAU / count) * 1.5;
      for (const side of [1, -1]) for (let k = 0; k < count; k++) {
        const end = (r, t, half) => {
          const c = Math.cos(t), s = Math.sin(t), lift = side > 0 ? 0.004 : 0.0065, h = hOf(r);
          return { p: [h, r * c, r * s], half, lift };
        };
        const A = end(rimR * 0.875, (k / count) * TAU, 0.0032), B = end(rimR * 0.29, (k / count) * TAU + side * lean, 0.002);
        const d = vec.unit(vec.sub(B.p, A.p)), e = vec.unit([0, -d[2], d[1]]), nl = vec.unit([0.5, -e[1], -e[2]]), nr = vec.unit([0.5, e[1], e[2]]);
        const row = (E) => [sk.raw(E.p[0], E.p[1] - e[1] * E.half, E.p[2] - e[2] * E.half, nl[0], nl[1], nl[2]), sk.raw(E.p[0] + E.lift, E.p[1], E.p[2], 1, 0, 0), sk.raw(E.p[0], E.p[1] + e[1] * E.half, E.p[2] + e[2] * E.half, nr[0], nr[1], nr[2])];
        const a = row(A), b = row(B);
        sk.quad(a[0], a[1], b[1], b[0], mt.chrome); sk.quad(a[1], a[2], b[2], b[1], mt.chrome);
      }
    }
  } else if (style === 'cover') {
    // Pressed full wheel cover: a shallow dome with a ring of radial slots; the black steel wheel shows through them.
    const col = mt.rim(mt.C.argent, 0.32, 0.9);
    lip(steelBlack);
    turn(col, [[fb + 0.002, rimR - 0.008], [fb + 0.007, rimR * 0.93], [fb + 0.008, rimR * 0.9]]);
    band({ n: 15, r1: rimR * 0.9, h1: fb + 0.008, r0: rimR * 0.54, h0: fb + 0.004, m: col, depth: 0.006, hole: opening(rimR * 0.14, rimR * 0.05, 4, 0.3, 10) });
    turn(col, [[fb + 0.004, rimR * 0.54], [fb + 0.013, rimR * 0.47], [fb + 0.016, rimR * 0.3], [fb + 0.016, rimR * 0.22]], fine);
    turn(mt.chrome, [[fb + 0.016, rimR * 0.22], [fb + 0.021, rimR * 0.2], [fb + 0.023, rimR * 0.1], [fb + 0.023, 0]], fine);
    if (level === 0) { barrel(steelBlack, fb + 0.002, fb - 0.012, rimR - 0.012); cap(sk, steelBlack, [fb - 0.012, 0, 0], X, Y, Z, rimR - 0.012, fine, 0.4); }
  } else if (style === 'rally') {
    // Painted steel sports wheel: bright trim ring, five long windows, exposed nuts and a tall chrome centre.
    lip(mt.chrome); trimRing();
    turn(mt.argent, [[fd, rimR - 0.018, 0.5], [fd, rimR * 0.8, 0.8]]);
    band({ n: 5, r1: rimR * 0.8, h1: fd, r0: rimR * 0.5, h0: fd + 0.012, m: mt.argent, depth: 0.006, hole: opening(rimR * 0.115, rimR * 0.24, 3.5, 0.3, 16) });
    turn(mt.argent, [[fd + 0.012, rimR * 0.5], [fd + 0.02, rimR * 0.44], [fd + 0.022, rimR * 0.25]], fine);
    nuts(5, rimR * 0.36, fd + 0.02);
    turn(mt.chrome, [[fd + 0.022, rimR * 0.25], [fd + 0.045, rimR * 0.24]], fine);
    turn(mt.chrome, [[fd + 0.045, rimR * 0.24], [fd + 0.05, rimR * 0.2], [fd + 0.052, 0]], fine);
    brake(fd - 0.025, fd, steelBlack);
  } else if (style === 'alloy') {
    // Cast alloy: five broad spokes are what is left between five windows that widen towards the rim.
    lip(alloy);
    turn(alloy, [[fb + 0.002, rimR - 0.012, 0.9], [fb - 0.006, rimR - 0.02, 0.75]]);
    band({ n: 5, r1: rimR - 0.02, h1: fb - 0.006, r0: rimR * 0.36, h0: fb - 0.016, m: alloy, depth: 0.022, hole: opening((rimR * 0.64 - 0.02) * 0.4, rimR * 0.17, 3, 0.72, 16) });
    turn(alloy, [[fb - 0.016, rimR * 0.36], [fb - 0.012, rimR * 0.3], [fb - 0.012, rimR * 0.17]], fine);
    nuts(5, rimR * 0.245, fb - 0.014);
    turn(dark, [[fb - 0.012, rimR * 0.17], [fb - 0.004, rimR * 0.15], [fb - 0.003, 0]], fine);
    brake(fb - 0.05, fb - 0.006, alloy, rimR - 0.02);
  } else if (style === 'truck') {
    // Front wheel of a bus or lorry: hand holes round a ring of nuts, and a hub that stands proud of the disc.
    const col = mt.rim(spec.color || [0.75, 0.75, 0.73], 0.5, 0.2);
    lip(col); well(col);
    turn(col, [[fd, rimR - 0.018, 0.6], [fd, rimR * 0.84, 0.8]]);
    band({ n: 5, r1: rimR * 0.84, h1: fd, r0: rimR * 0.56, h0: fd + 0.02, m: col, depth: 0.01, hole: opening(rimR * 0.095, rimR * 0.12) });
    turn(col, [[fd + 0.02, rimR * 0.56], [fd + 0.022, rimR * 0.37]]);
    nuts(8, rimR * 0.47, fd + 0.021, 0.02);
    turn(steelBlack, [[fd + 0.022, rimR * 0.37, 0.7], [fd + 0.07, rimR * 0.33]], fine);
    turn(steelBlack, [[fd + 0.07, rimR * 0.33], [fd + 0.08, rimR * 0.2], [fd + 0.082, 0]], fine);
    drum(fd - 0.02, col);
  } else {
    // Painted steel wheel with vent holes and a chrome hub cap: fleet cars, vans, pickups and plain saloons.
    const col = spec.color ? mt.rim(spec.color, 0.5, 0.2) : steelBlack, small = spec.cap === 'small';
    lip(spec.ring ? mt.chrome : col);
    if (spec.ring) trimRing(); else well(col);
    turn(col, [[fd, rimR - 0.018, 0.55], [fd, rimR * 0.8, 0.8]]);
    band({ n: small ? 6 : 10, r1: rimR * 0.8, h1: fd, r0: rimR * 0.58, h0: fd + 0.01, m: col, depth: 0.005, hole: small ? opening(rimR * 0.07, rimR * 0.17, 3) : opening(rimR * 0.065, rimR * 0.09) });
    turn(col, [[fd + 0.01, rimR * 0.58], [fd + 0.022, rimR * 0.5], [fd + 0.024, rimR * 0.3], [fd + 0.024, 0]], fine);
    if (small) {
      nuts(spec.lugs || 5, rimR * 0.4, fd + 0.023);
      turn(mt.chrome, [[fd + 0.024, rimR * 0.27], [fd + 0.044, rimR * 0.26]], fine);
      turn(mt.chrome, [[fd + 0.044, rimR * 0.26], [fd + 0.052, rimR * 0.17], [fd + 0.054, 0]], fine);
    } else turn(mt.chrome, [[fd + 0.016, rimR * 0.52], [fd + 0.03, rimR * 0.5], [fd + 0.043, rimR * 0.36], [fd + 0.049, rimR * 0.16], [fd + 0.05, 0]], fine);
    drum(fd - 0.02, col);
  }
  // The back of the wheel is closed flush with the inner bead, so nothing is seen through it from under the car.
  cap(sk, dark, [-fb, 0, 0], [-1, 0, 0], Z, Y, rimR, segs, 0.4);
  return mb;
}

/** Stand-in wheel for the far level, added to the body mesh itself: a short dark drum with a lighter centre. */
export function farWheel(sk, c, R, w, rimR, side, rimMat) {
  const prof = [{ h: -w / 2, r: R, nh: 0, nr: 1 }, { h: w / 2, r: R, nh: 0, nr: 1 }];
  lathe(sk, mt.tyre, c, [side, 0, 0], Y, Z, prof, 8);
  disc(sk, mt.tyre, [c[0] + side * w / 2, c[1], c[2]], [side, 0, 0], Y, Z, R, 8, 1, rimR);
  cap(sk, rimMat, [c[0] + side * w / 2, c[1], c[2]], [side, 0, 0], Y, Z, rimR, 8);
  cap(sk, mt.tyre, [c[0] - side * w / 2, c[1], c[2]], [-side, 0, 0], Y, Z, R, 8, 0.4);
}
