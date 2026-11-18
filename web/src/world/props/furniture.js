// Kerbside furniture. Everything stands on the origin with its front (the side a user faces, or the side that
// should face the carriageway) towards +Z.

import { CHANNEL } from '../../core/ids.js';
import { fbm2 } from '../../core/math.js';
import { place, radianceCode } from './kit.js';
import { C, SOURCE, srgb, luminaire, basePlate, signPlate, rectOutline, arc } from './common.js';
import { signRect, signNamed, signIfPresent } from './atlas.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- bus bench
/** Concrete end frames, timber seat slats and a plywood back that carries a painted advertisement on both faces. */
function bench(k, { length = 2.1, seedFront = 5, seedBack = 21, advert = true } = {}) {
  const half = length / 2, frame = [[0, 0.3], [0.4, 0.3], [0.4, -0.05], [0.84, -0.17], [0.84, -0.27], [0.34, -0.2], [0, -0.3]];
  k.concrete(C.offWhite, 0, 0.45);
  const m = k.mark();
  for (const x of [-half + 0.14, half - 0.24]) k.extrude(frame, [x, 0, 0], Y, Z, 0.1, { stops: [0.5] });
  k.ground(m, 0.25, 0.5);
  k.wood(C.timberPale, 0.75, 0.5);
  const s = k.mark();
  for (const z of [0.03, 0.18, 0.33]) k.box(-half, 0.4, z - 0.065, half, 0.44, z + 0.065, { axis: 'x', r: k.near ? 0.006 : 0 });
  k.shade(s, (x, y) => (y < 0.41 ? 0.6 : 1));
  // back panel leaning on the frames
  const up = [0, 0.965, -0.263], c = [0, 0.67, -0.105], w = advert ? 1.82 : length, front = advert ? signRect('billboard-wide', seedFront) : null, h = advert ? w / front.aspect : 0.5;
  if (advert) signPlate(k, c, X, up, rectOutline(w, h), front, { backSign: signRect('billboard-wide', seedBack), code: 0, thickness: 0.024, edge: (q) => q.wood(C.timber, 0.8, 0.5) });
  else { k.wood(C.timberPale, 0.75, 0.5); for (const t of [-0.17, 0, 0.17]) { const p = [0, c[1] + up[1] * t, c[2] + up[2] * t]; k.bar([-half, p[1], p[2]], [half, p[1], p[2]], 0.03, 0.14, { up, r: k.near ? 0.006 : 0 }); } }
}

// ---------------------------------------------------------------- litter bin
function bin(k) {
  const n = k.n(20, 7), m = k.mark();
  k.concrete([0.72, 0.68, 0.6], 0, 0.55);                                   // exposed aggregate drum
  k.lathe([0, 0, 0], Y, [[0, 0.27], [0.03, 0.29], [0.76, 0.29], [0.8, 0.275], [0.8, 0.2]], n, { crease: 50 });
  // what runs off the lid dries in streaks down the drum, darker where the lid's rim drips most
  k.ground(m, 0.25, 0.5).grime(m, (x, y, z) => Math.min(0.75, Math.max(0, fbm2(Math.atan2(x, z) * 3.2, 0.7, 3, 13) - 0.36) * 2.4 * Math.min(1, y / 0.7)), [0.2, 0.17, 0.13]);
  k.steel([0.13, 0.12, 0.11], 0.6, 0.6);                                    // spun steel lid with a round mouth
  const lid = k.mark();
  k.lathe([0, 0, 0], Y, [[0.79, 0.3], [0.83, 0.3], [0.9, 0.2], [0.905, 0.14], [0.87, 0.135], [0.78, 0.13]], n, { crease: 40 });
  k.rubber([0.02, 0.02, 0.02], 0.9);
  k.lathe([0, 0, 0], Y, [[0.78, 0.14], [0.78, 0]], n);                                           // the dark of the liner; the mouth's own facets, so no gap opens round it
  k.shade(lid, (x, y, z) => (Math.hypot(x, z) < 0.15 ? 0.35 : 1));
}

// ---------------------------------------------------------------- fire hydrant
function hydrant(k) {
  const n = k.n(16, 6), body = () => k.steel([0.88, 0.69, 0.11], 0.5, 0.3), cap = () => k.bare(1, 0.5, [0.75, 0.76, 0.77]);
  const m = k.mark();
  body();
  k.lathe([0, 0, 0], Y, [[0, 0.15], [0.03, 0.15], [0.03, 0.1], [0.07, 0.092], [0.1, 0.105], [0.13, 0.092], [0.4, 0.095], [0.44, 0.1], [0.47, 0.125], [0.5, 0.125], [0.5, 0.1]], n, { crease: 40 });
  cap();
  k.lathe([0, 0, 0], Y, [[0.5, 0.118], [0.515, 0.118], [0.56, 0.1], [0.62, 0.062], [0.645, 0.03], [0.65, 0]], n, { crease: 50 });   // bonnet
  k.cyl([0, 0.648, 0], [0, 0.7, 0], 0.024, 0.02, 5, { capB: true });                                                                // pentagon operating nut
  // two hose outlets and the large pumper outlet in front
  for (const [dir, r, len] of [[[1, 0, 0], 0.052, 0.155], [[-1, 0, 0], 0.052, 0.155], [[0, 0, 1], 0.072, 0.175]]) {
    const at = (d) => [dir[0] * d, 0.36, dir[2] * d];
    body(); k.cyl(at(0.06), at(len - 0.035), r * 0.92, r * 0.92, k.n(12, 6));
    cap(); k.lathe(at(len - 0.04), dir, [[0, 0], [0, r * 1.12], [0.03, r * 1.12], [0.04, r * 0.9], [0.04, 0]], k.n(12, 6), { crease: 40 });   // closed behind: the cap is wider than the outlet
    if (k.mid) k.cyl(at(len), at(len + 0.022), 0.02, 0.018, 5, { capB: true });
  }
  if (k.near) { body(); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3; k.bolt([Math.cos(a) * 0.125, 0.03, Math.sin(a) * 0.125], Y, 0.011, 0.01); } }
  k.ground(m, 0.2, 0.5).grime(m, (x, y) => 0.35 * Math.max(0, 1 - y / 0.25), C.rust);
}

// ---------------------------------------------------------------- parking meter
/** Meter head centred on x = 0 with its bottom at y = 0: a housing with a domed window, readable from both sides. */
function meterHead(k) {
  const n = k.n(10, 4), outline = [[-0.075, 0], [0.075, 0], ...arc([0, 0.215, 0], X, Y, 0.075, 0, Math.PI, n).map((p) => [p[0], p[1]])];
  k.steel([0.42, 0.45, 0.46], 0.45, 0.2);
  k.extrude(outline, [0, 0, -0.05], X, Y, 0.1, { crease: 40 });
  // window: a dark arc on each face, with the pale dial showing through its lower part
  for (const s of [1, -1]) {
    const z = s * 0.0515, right = [s, 0, 0];
    k.darkGlass([0.08, 0.09, 0.1], 0.1, 0.5);
    const pts = arc([0, 0.215, z], right, Y, 0.06, 0.12, Math.PI - 0.12, n);
    for (let i = 0; i < pts.length - 1; i++) k.tri([0, 0.2, z], pts[i], pts[i + 1]);
    if (k.near) { k.paint([0.85, 0.83, 0.76], 0.5, 0.2); k.panel([0, 0.208, z * 1.02], right, Y, 0.09, 0.022); }
  }
  if (k.mid) {
    k.bare(0, 0.3); k.cyl([0.075, 0.12, 0], [0.1, 0.12, 0], 0.016, 0.016, 8, { capB: true });       // coin handle
    k.bar([0.1, 0.12, 0], [0.108, 0.12, 0], 0.01, 0.05, { up: Y });
    k.steel([0.2, 0.21, 0.22], 0.5, 0.2); k.box(-0.055, 0.03, 0.05, 0.055, 0.1, 0.056, { axis: 'z' });   // coin vault door
  }
}
function meter(k, twin) {
  const n = k.n(10, 5), h = 1.02, m = k.mark();
  k.bare(2, 0.55, C.galv);
  k.cyl([0, 0, 0], [0, h, 0], 0.027, 0.027, n, { stops: k.mid ? [0.12] : [] });
  if (k.mid) k.lathe([0, 0, 0], Y, [[0, 0.06], [0.012, 0.06], [0.03, 0.03], [0.03, 0.015]], n, { crease: 40 });      // collar, closed in under the post's flats
  k.ground(m, 0.3, 0.5);
  const heads = twin ? [-0.105, 0.105] : [0];
  if (twin) { k.steel([0.42, 0.45, 0.46], 0.45, 0.2); k.box(-0.15, h - 0.02, -0.03, 0.15, h + 0.02, 0.03, { axis: 'x', r: 0.008 }); }
  for (const x of heads) { const sub = k.child(); meterHead(sub); k.add(sub, place(x, h + (twin ? 0.02 : 0), 0)); }
}

// ---------------------------------------------------------------- telephone booth
function phoneBooth(k) {
  const s = 0.42, H = 2.2, head = 0.22, post = 0.045, kick = 0.3, frame = () => k.bare(1, 0.4, C.alu);
  const m = k.mark();
  k.concrete(C.concreteDark, 0, 0.5); k.box(-s, 0, -s, s, 0.04, s);
  frame();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(sx * s - (sx > 0 ? post : 0), 0.04, sz * s - (sz > 0 ? post : 0), sx * s + (sx < 0 ? post : 0), H - head, sz * s + (sz < 0 ? post : 0), { stops: [0.1] });
  // kick panels on three sides, rails above them and at mid height
  const sides = [[[-s + post, -s + 0.012], [s - post, -s + 0.012]], [[-s + 0.012, s - post], [-s + 0.012, -s + post]], [[s - 0.012, -s + post], [s - 0.012, s - post]]];
  for (const [a, b] of sides) {
    k.bar([a[0], 0.04 + kick / 2, a[1]], [b[0], 0.04 + kick / 2, b[1]], 0.02, kick, { up: Y });
    if (k.mid) k.bar([a[0], 1.05, a[1]], [b[0], 1.05, b[1]], 0.024, 0.04, { up: Y });
  }
  k.ground(m, 0.3, 0.45);
  // roof box: blue header band on all four faces with the lit name plate on the front and the sides
  const y0 = H - head, blue = [0.12, 0.37, 0.71];
  const e = s + 0.01;
  k.plastic(blue, 0.4); k.box(-e, y0, -e, e, H - 0.025, e, { stops: [0.5], capA: false });
  frame(); k.box(-s - 0.025, H - 0.025, -s - 0.025, s + 0.025, H, s + 0.025);
  const plate = signNamed('notice/phone', 'notice', 3), ph = head - 0.07, pw = ph * plate.aspect, code = Math.max(plate.emissiveCode || 0, radianceCode(3));
  for (const [c, right] of [[[0, y0 + (head - 0.025) / 2, s + 0.012], X], [[s + 0.012, y0 + (head - 0.025) / 2, 0], [0, 0, -1]], [[-s - 0.012, y0 + (head - 0.025) / 2, 0], Z]]) {
    k.signFace(code, CHANNEL.STREET, 0.4); k.panel(c, right, Y, pw, ph, plate.uv);
  }
  // ceiling: white soffit with the light panel; the light and its glow sit on the panel
  // (both are seen from below, so they are wound to face down). The soffit is the underside of the roof box
  // itself: a separate sheet hung below it showed its back through the gap when seen from above.
  k.paint(C.white, 0.6, 0.2); k.quad([-e, y0, -e], [e, y0, -e], [e, y0, e], [-e, y0, e]);
  k.lens(srgb(SOURCE.fluorescent), 3, CHANNEL.STREET); k.quad([-0.26, y0 - 0.004, -0.2], [0.26, y0 - 0.004, -0.2], [0.26, y0 - 0.004, 0.2], [-0.26, y0 - 0.004, 0.2]);
  luminaire(k, [0, y0 - 0.004, 0], SOURCE.fluorescent, { power: 26, radius: 6, radiance: 3, size: 0.6, kind: 0, seed: 0.83 });
  // telephone on the back wall: backboard, body with a chrome face, handset on its cradle, shelf with the directory
  const zb = -s + 0.03, inside = k.mark();
  k.steel(C.darkSteel, 0.6, 0.15); k.box(-0.2, 0.95, zb, 0.2, 1.75, zb + 0.02, { axis: 'z' });
  k.steel([0.1, 0.1, 0.11], 0.5, 0.1); k.box(-0.125, 1.12, zb + 0.02, 0.125, 1.62, zb + 0.14, { axis: 'z', r: k.near ? 0.012 : 0 });
  if (k.mid) {
    k.bare(0, 0.3); k.box(-0.085, 1.3, zb + 0.14, 0.085, 1.48, zb + 0.146, { axis: 'z' });                              // keypad plate
    k.plastic([0.04, 0.04, 0.045], 0.5); k.box(-0.185, 1.25, zb + 0.05, -0.135, 1.5, zb + 0.11, { r: 0.012 });           // handset
    k.bare(0, 0.35); k.tube([[-0.16, 1.25, zb + 0.08], [-0.2, 1.05, zb + 0.14], [-0.1, 1.0, zb + 0.12], [-0.06, 1.12, zb + 0.08]], 0.007, 4);   // armoured cord
    k.bare(1, 0.4, C.alu); k.box(-0.3, 0.9, zb, 0.3, 0.92, zb + 0.22, { axis: 'x' });                                     // shelf
    k.paint([0.85, 0.8, 0.3], 0.7, 0.3); k.box(-0.14, 0.76, zb + 0.03, 0.1, 0.9, zb + 0.07, { axis: 'x' });               // directory in its binder
  }
  k.under(inside, y0, 1.6, 0.25);
  // bi-fold door on the front: two leaves, the right one folded slightly inwards
  frame();
  const leaf = (x0, z0, x1, z1) => {
    k.bar([x0, 0.04 + kick / 2, z0], [x1, 0.04 + kick / 2, z1], 0.02, kick, { up: Y });
    for (const y of [1.05, y0 - 0.03]) k.bar([x0, y, z0], [x1, y, z1], 0.022, 0.04, { up: Y });
    for (const [x, z] of [[x0, z0], [x1, z1]]) k.bar([x, 0.04, z], [x, y0, z], 0.022, 0.03, { up: [x1 - x0, 0, z1 - z0] });
    k.clearGlass(); k.quad([x0, 0.04 + kick, z0], [x1, 0.04 + kick, z1], [x1, y0 - 0.05, z1], [x0, y0 - 0.05, z0]); frame();
  };
  leaf(-s + post, s - 0.015, -0.01, s - 0.015); leaf(0.01, s - 0.015, s - post - 0.06, s - 0.1);
  if (k.mid) { k.bare(0, 0.3); k.box(-0.06, 1.0, s - 0.004, -0.03, 1.2, s + 0.02, { axis: 'y' }); }
  // glazing on the three fixed sides
  k.clearGlass();
  for (const [a, b] of sides) k.quad([b[0], 0.04 + kick, b[1]], [a[0], 0.04 + kick, a[1]], [a[0], y0, a[1]], [b[0], y0, b[1]]);
}

// ---------------------------------------------------------------- newspaper box
function newsbox(k, seed) {
  const m = k.mark();
  k.steel(C.darkSteel, 0.6, 0.3);
  k.box(-0.2, 0, -0.17, 0.2, 0.025, 0.17);
  k.box(-0.045, 0.025, -0.045, 0.045, 0.56, 0.045, { stops: [0.25] });
  k.ground(m, 0.2, 0.5);
  // cabinet in the instance colour: sloped window door in front
  const prof = [[0.55, -0.19], [0.55, 0.19], [0.8, 0.19], [1.05, 0.03], [1.05, -0.19]], body = k.mark();
  k.steel(C.white, 0.45, 0.25).tintKey();
  k.extrude(prof, [-0.225, 0, 0], Y, Z, 0.45, { crease: 20 });
  k.under(body, 0.56, 0.05, 0.3);
  // window on the slope, display plate below it, coin head on top
  const up = [0, 0.842, -0.539], nrm = [0, 0.539, 0.842], c = [0, 0.925, 0.11];
  k.steel([0.1, 0.1, 0.1], 0.5, 0.2); k.panel([c[0] + nrm[0] * 0.004, c[1] + nrm[1] * 0.004, c[2] + nrm[2] * 0.004], X, up, 0.37, 0.25);
  k.darkGlass([0.1, 0.11, 0.12], 0.08, 0.5); k.panel([c[0] + nrm[0] * 0.008, c[1] + nrm[1] * 0.008, c[2] + nrm[2] * 0.008], X, up, 0.32, 0.2);
  const rect = signRect('newsbox', seed), pw = 0.3, ph = pw / rect.aspect;
  k.signFace(0); k.panel([0, 0.675, 0.192], X, Y, pw, ph, rect.uv);
  if (k.mid) {
    k.signFace(0); k.panel([0.2265, 0.78, -0.02], [0, 0, -1], Y, pw, ph, rect.uv); k.panel([-0.2265, 0.78, -0.02], Z, Y, pw, ph, rect.uv);
    k.bare(0, 0.35); k.box(-0.1, 1.05, -0.15, 0.1, 1.13, -0.05, { r: 0.008 });                         // coin mechanism
    k.box(-0.08, 0.86, 0.165, 0.08, 0.875, 0.185, { axis: 'x' });                                      // door pull
  }
}

// ---------------------------------------------------------------- bus shelter
function busShelter(k) {
  const L = 3.6, hx = L / 2, d0 = -0.75, d1 = 0.75, H = 2.4, bronze = () => k.steel(C.bronze, 0.45, 0.12);
  bronze();
  const m = k.mark(), posts = [[-hx + 0.03, d0 + 0.03], [0, d0 + 0.03], [hx - 0.03, d0 + 0.03], [-hx + 0.03, d1 - 0.33], [hx - 0.03, d1 - 0.33]];
  for (const [x, z] of posts) k.box(x - 0.03, 0, z - 0.03, x + 0.03, H - 0.1, z + 0.03, { stops: [0.08] });
  k.ground(m, 0.3, 0.5);
  // flat roof with a deep fascia and a pale underside
  k.box(-hx - 0.08, H - 0.1, d0 - 0.08, hx + 0.08, H + 0.06, d1 + 0.05, { r: k.near ? 0.012 : 0 });
  k.paint(C.offWhite, 0.6, 0.3); k.quad([-hx, H - 0.101, d0], [hx, H - 0.101, d0], [hx, H - 0.101, d1], [-hx, H - 0.101, d1]);
  // rails and bronze acrylic: back wall and the left end; the right end is the advertising box
  bronze();
  if (k.mid) for (const y of [0.25, 2.05]) { k.box(-hx + 0.06, y - 0.02, d0 + 0.015, hx - 0.06, y + 0.02, d0 + 0.045, { axis: 'x' }); k.box(-hx + 0.015, y - 0.02, d0 + 0.06, -hx + 0.045, y + 0.02, d1 - 0.36, { axis: 'z' }); }
  k.tintedGlass();
  k.quad([hx - 0.06, 0.27, d0 + 0.03], [-hx + 0.06, 0.27, d0 + 0.03], [-hx + 0.06, 2.03, d0 + 0.03], [hx - 0.06, 2.03, d0 + 0.03]);
  k.quad([-hx + 0.03, 0.27, d0 + 0.06], [-hx + 0.03, 0.27, d1 - 0.36], [-hx + 0.03, 2.03, d1 - 0.36], [-hx + 0.03, 2.03, d0 + 0.06]);
  // advertising box: lit poster on both faces
  const poster = signRect('poster', 4), pw = 1.2, ph = pw / poster.aspect, cx = hx - 0.03, cy = 0.28 + ph / 2 + 0.06, cz = d0 + 0.06 + pw / 2 + 0.03, code = Math.max(poster.emissiveCode || 0, radianceCode(4.5));
  bronze(); k.box(cx - 0.085, 0.28, cz - pw / 2 - 0.04, cx + 0.085, cy + ph / 2 + 0.04, cz + pw / 2 + 0.04, { r: k.near ? 0.01 : 0 });
  k.signFace(code, CHANNEL.NEON, 0.3);
  k.panel([cx - 0.087, cy, cz], Z, Y, pw, ph, poster.uv);
  const other = signRect('poster', 13); k.panel([cx + 0.087, cy, cz], [0, 0, -1], Y, pw, ph, other.uv);
  luminaire(k, [cx - 0.087, cy, cz], SOURCE.halide, { power: 34, radius: 7, radiance: 4.5, size: 1.6, kind: 2, channel: CHANNEL.NEON, seed: 0.27 });
  k.glows.push({ pos: [cx + 0.087, cy, cz], size: 1.6, color: SOURCE.halide.map((v) => v * 4.5), channel: CHANNEL.NEON, kind: 2 });
  // bench along the back, on two brackets
  k.wood(C.timberPale, 0.75, 0.45);
  for (const z of [d0 + 0.2, d0 + 0.36]) k.box(-hx + 0.25, 0.44, z - 0.07, hx - 0.5, 0.475, z + 0.07, { axis: 'x', r: k.near ? 0.006 : 0 });
  bronze(); const legs = k.mark();
  for (const x of [-hx + 0.6, 0, hx - 0.9]) { k.box(x - 0.025, 0, d0 + 0.26, x + 0.025, 0.44, d0 + 0.31); k.box(x - 0.025, 0.4, d0 + 0.1, x + 0.025, 0.44, d0 + 0.46, { axis: 'z' }); }
  k.ground(legs, 0.2, 0.45);
  // route plate on the front post
  const stop = signNamed('notice/bus-stop', 'notice', 1), sw = 0.45, sh = sw / stop.aspect;
  signPlate(k, [-hx + 0.03, H + 0.06 + sh / 2 + 0.05, d1 - 0.33], X, Y, rectOutline(sw, sh), stop, { backSign: stop, code: 0 });
  if (k.mid) { k.bare(2, 0.5, C.galv); k.box(-hx + 0.015, H + 0.06, d1 - 0.345, -hx + 0.045, H + 0.06 + sh + 0.07, d1 - 0.315); }
}
/** Plain stop: a pole with the route plate. */
function busSign(k) {
  const n = k.n(10, 5), m = k.mark(), stop = signNamed('notice/bus-stop', 'notice', 1), w = 0.45, h = w / stop.aspect;
  k.bare(2, 0.55, C.galv); k.cyl([0, 0, 0], [0, 2.75, 0], 0.03, 0.03, n, { capB: true, stops: k.mid ? [0.1] : [] });
  k.ground(m, 0.3, 0.5);
  signPlate(k, [0.03 + w / 2, 2.75 - h / 2 - 0.03, 0], X, Y, rectOutline(w, h), stop, { backSign: stop, code: 0 });
}

// ---------------------------------------------------------------- small items
function bollard(k) {
  const n = k.n(16, 6), m = k.mark();
  k.concrete(C.concrete, 0, 0.5);
  k.lathe([0, 0, 0], Y, [[0, 0.1], [0.66, 0.092], [0.68, 0.082], [0.74, 0.082], [0.76, 0.092], [0.84, 0.09], [0.885, 0.07], [0.9, 0.03], [0.9, 0]], n, { crease: 40 });
  k.ground(m, 0.25, 0.5);
}

function mailbox(k) {
  const w = 0.25, d = 0.275, base = 0.16, shoulder = 0.95, n = k.n(12, 4), m = k.mark(), blue = () => k.steel(C.mailBlue, 0.45, 0.45);
  blue();
  // four legs, each on a foot pad bolted to the pavement; the pads rust first
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (w - 0.05), z = sz * (d - 0.05);
    k.box(x - 0.025, 0.006, z - 0.025, x + 0.025, base + 0.02, z + 0.025, { r: 0 });
    if (k.mid) k.box(x - 0.03 - (sx > 0 ? 0 : 0.045), 0, z - 0.03 - (sz > 0 ? 0 : 0.045), x + 0.03 + (sx > 0 ? 0.045 : 0), 0.008, z + 0.03 + (sz > 0 ? 0.045 : 0), { r: 0 });
    if (k.near) { k.bare(2, 0.6, C.galv); k.bolt([x + sx * 0.05, 0.008, z + sz * 0.05], Y, 0.011, 0.01); blue(); }
  }
  k.ground(m, 0.15, 0.5).grime(m, (x, y) => 0.6 * Math.max(0, 1 - y / 0.1), C.rust);
  const top = arc([shoulder, 0, 0], [0, 1, 0], [1, 0, 0], d, 0, Math.PI, n).map((p) => [p[0], p[1]]);        // (y, z) barrel vault over the body
  const body = k.mark();
  k.extrude([[base, -d], [base, d], ...top], [-w, 0, 0], Y, Z, 2 * w, { crease: 35, stops: [0.5] });
  if (k.mid) {
    // the hem: the skirt is folded back on itself round the bottom and stands a few millimetres proud
    const t = 0.004, y0 = base - 0.004, y1 = base + 0.045;
    for (const sz of [-1, 1]) k.box(-w - t, y0, sz > 0 ? d - 0.002 : -d - t, w + t, y1, sz > 0 ? d + t : -d + 0.002, { axis: 'x', r: 0 });
    for (const sx of [-1, 1]) k.box(sx > 0 ? w - 0.002 : -w - t, y0, -d + 0.002, sx > 0 ? w + t : -w + 0.002, y1, d - 0.002, { axis: 'z', r: 0 });
  }
  // rain off the vault leaves pale chalk and dirt runs down the sides; rust creeps up from the hem
  k.under(body, base + 0.001, 0.06, 0.35)
    .grime(body, (x, y, z) => 0.3 * Math.max(0, fbm2(z * 9 + (x > 0 ? 0 : 31), x * 9, 3, 19) - 0.4) * 2 * Math.min(1, Math.max(0, (shoulder + 0.1 - y) / 0.5)), [0.42, 0.44, 0.5])
    .grime(body, (x, y, z) => 0.55 * Math.max(0, 1 - (y - base) / 0.14) * (0.4 + 0.6 * fbm2(x * 7 + z * 7, 3, 2, 23)), C.rust);
  if (k.near) {
    // riveted seams where the side sheets lap the front and the back
    blue();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let i = 0; i < 6; i++) k.bolt([sx * w, base + 0.1 + i * 0.145, sz * (d - 0.022)], [sx, 0, 0], 0.007, 0.004);
  }
  // pull-down door high on the front with its handle, and the collection plate under it
  if (k.mid) {
    blue();
    const fl = arc([shoulder, 0, 0], [0, 1, 0], [1, 0, 0], d + 0.012, 0.18, 0.95, Math.max(3, n >> 1)).map((p) => [p[0], p[1]]), inner = fl.slice().reverse().map((p) => [shoulder + (p[0] - shoulder) * 0.97, p[1] * 0.97]);
    k.extrude([...fl, ...inner], [-w + 0.03, 0, 0], Y, Z, 2 * w - 0.06, { crease: 35 });
    k.bare(0, 0.35); k.box(-0.09, shoulder + 0.2, d - 0.05, 0.09, shoulder + 0.225, d + 0.0, { axis: 'x' });
    // enamelled plate held by a rivet in each corner; the wording, when the atlas has it, is printed on its face
    const plate = k.mark(), pw = 0.3, ph = 0.2, py = 0.62, notice = signIfPresent('notice/mail');
    k.paint([0.8, 0.79, 0.74], 0.45, 0.45); k.box(-pw / 2, py - ph / 2, d - 0.001, pw / 2, py + ph / 2, d + 0.003, { r: 0 });
    k.grime(plate, (x, y) => 0.5 * Math.max(0, 1 - (py + ph / 2 - y) / 0.05) + 0.25 * Math.max(0, fbm2(x * 30, y * 30, 2, 29) - 0.5) * 2, [0.3, 0.2, 0.12]);
    if (notice) { k.signFace(0); k.panel([0, py, d + 0.0036], X, Y, pw - 0.02, (pw - 0.02) / notice.aspect > ph - 0.02 ? ph - 0.02 : (pw - 0.02) / notice.aspect, notice.uv); }
    if (k.near) { k.bare(1, 0.5, C.alu); for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.bolt([sx * (pw / 2 - 0.012), py + sy * (ph / 2 - 0.012), d + 0.003], Z, 0.004, 0.002); }
  }
}

function dumpster(k) {
  const hx = 0.9, z0 = -0.6, z1 = 0.6, yb = 0.12, hf = 1.0, hb = 1.22, green = () => k.steel(C.dumpsterGreen, 0.6, 0.7);
  green();
  const m = k.mark();
  // tub: the front leans out and is lower than the back, so the lids slope forwards
  k.extrude([[yb, z0], [yb, z1 - 0.12], [hf, z1], [hb, z0]], [-hx, 0, 0], Y, Z, 2 * hx, { stops: [0.25, 0.5, 0.75] });
  // the top of the tub is its open mouth: whatever shows of it under a lid is the dark inside
  k.shade(m, (x, y, z) => (y > hf - 0.002 && Math.abs(x) < hx - 0.001 && z > z0 + 0.001 && z < z1 - 0.001 ? 0.12 : 1));
  if (k.mid) {
    k.box(-hx - 0.012, hb - 0.08, z0 - 0.03, hx + 0.012, hb - 0.02, z0 + 0.0, { axis: 'x' });                    // hinge bar
    // rolled rim round the mouth
    k.box(-hx - 0.014, hf - 0.05, z1 - 0.006, hx + 0.014, hf - 0.005, z1 + 0.022, { axis: 'x' });
    for (const sx of [-1, 1]) {
      k.box(sx * hx + (sx > 0 ? 0 : -0.1), 0.62, -0.5, sx * hx + (sx > 0 ? 0.1 : 0), 0.8, 0.42, { axis: 'z' });      // fork pockets
      for (const z of [-0.3, 0.2]) k.box(sx * hx - 0.012, yb, z - 0.03, sx * hx + 0.012, 0.62, z + 0.03);             // stiffening ribs
    }
    for (const x of [-0.45, 0.45]) k.box(x - 0.03, yb + 0.05, z1 - 0.07, x + 0.03, hf - 0.08, z1 - 0.02, { r: 0.004 });   // pressed ribs on the front
    for (const sx of [-1, 1]) for (const z of [-0.45, 0.35]) { k.rubber(C.black); k.cyl([sx * 0.72 - 0.03, 0.07, z], [sx * 0.72 + 0.03, 0.07, z], 0.07, 0.07, k.n(10, 6), { capA: true, capB: true }); green(); k.box(sx * 0.72 - 0.045, 0.07, z - 0.02, sx * 0.72 + 0.045, yb + 0.01, z + 0.02); }
  } else k.box(-hx + 0.1, 0, z0 + 0.1, hx - 0.1, yb, z1 - 0.2);
  // years of lorries: dirt thrown up from the yard, rust blooming along the bottom seam, down from the rim and
  // wherever the forks have scraped the pockets
  k.ground(m, 0.5, 0.45).grime(m, (x, y) => 0.4 * Math.max(0, 1 - y / 0.5) + 0.12, [0.12, 0.1, 0.08])
    .grime(m, (x, y, z) => (y > hf - 0.002 ? 0 : Math.min(0.85, (0.9 * Math.max(0, 1 - (y - yb) / 0.22) + 0.6 * Math.max(0, 1 - (hf - y) / 0.3) + 0.25) * Math.max(0, fbm2(x * 2.3 + z * 1.9, y * 2.6 + (z > 0 ? 7 : 0), 3, 37) - 0.36) * 2.6)), C.rust);
  // two plastic lids with moulded ribs; the right-hand one rests on a bag that did not quite fit
  for (const sx of [-1, 1]) {
    const a = sx < 0 ? -hx - 0.01 : 0.01, b = sx < 0 ? -0.01 : hx + 0.01, lift = sx > 0 ? 0.075 : 0, lid = k.mark();
    k.plastic([0.07, 0.07, 0.075], 0.6);
    k.extrude([[hb, z0 - 0.02], [hf + lift, z1 + 0.03], [hf + lift + 0.035, z1 + 0.03], [hb + 0.035, z0 - 0.02]], [a, 0, 0], Y, Z, b - a);
    if (k.near) for (let i = 1; i <= 3; i++) {
      const x = a + (b - a) * i / 4, at = (t) => [x, hb + 0.035 + (hf + lift - hb) * t, z0 - 0.02 + (z1 + 0.05 - z0) * t];
      k.bar(at(0.08), at(0.92), 0.05, 0.016, { up: Y, r: 0.004 });
    }
    k.grime(lid, (x, y, z) => 0.5 * Math.max(0, fbm2(x * 4, z * 4, 3, 43) - 0.3) * 1.6, [0.3, 0.28, 0.24]);                     // dust and bird lime
    if (lift && k.mid) { k.plastic([0.025, 0.025, 0.03], 0.3); k.ellipsoid([(a + b) / 2 + 0.1, hf - 0.02, z1 - 0.2], 0.3, 0.1, 0.19, k.n(10, 6), k.n(5, 3)); }
  }
}

function cone(k) {
  const n = k.n(14, 6), orange = () => k.plastic(C.coneOrange, 0.55), m = k.mark();
  orange();
  k.box(-0.18, 0, -0.18, 0.18, 0.03, 0.18, { r: 0.012 });
  const r = (y) => 0.135 - (y - 0.03) / 0.67 * 0.105;
  k.cyl([0, 0.03, 0], [0, 0.38, 0], r(0.03), r(0.38), n);
  k.plastic([0.92, 0.92, 0.9], 0.5); k.cyl([0, 0.38, 0], [0, 0.52, 0], r(0.38), r(0.52), n);       // reflective collar
  orange(); k.cyl([0, 0.52, 0], [0, 0.7, 0], r(0.52), r(0.7), n, { capB: true });
  k.ground(m, 0.12, 0.45).grime(m, (x, y) => 0.25 * Math.max(0, 1 - y / 0.2), [0.2, 0.18, 0.15]);
}

/** Square concrete planter for a street palm; the planner stands the tree on its soil (`soilHeight`). */
function planter(k) {
  const o = 0.6, i = 0.5, h = 0.5, soil = h - 0.08, m = k.mark();
  k.concrete(C.offWhite, 0, 0.6);
  // One casting: the shell is skinned round the square with eased corners, from the shadow gap at the pavement
  // up the outside, over the chamfered lip and down the inside to below the soil.
  const per = k.near ? 8 : 2, turn = k.near ? 3 : 1, ease = 0.025;
  const loop = (half, y) => {
    const out = [], e = Math.min(ease, half * 0.2), flat = half - e;
    for (let c = 0; c < 4; c++) {
      // side c looks along (sin a, cos a); the loop runs to its right as seen from outside
      const a = c * Math.PI / 2, nx = Math.sin(a), nz = Math.cos(a), tx = Math.cos(a), tz = -Math.sin(a);
      for (let q = 0; q < per; q++) { const u = -flat + 2 * flat * q / per; out.push([nx * half + tx * u, y, nz * half + tz * u]); }
      for (let q = 0; q < turn; q++) { const f = a + (q / turn) * Math.PI / 2; out.push([(nx + tx) * flat + Math.sin(f) * e, y, (nz + tz) * flat + Math.cos(f) * e]); }
    }
    return out;
  };
  const lipIn = 0.012;
  k.loft([loop(o - 0.03, 0.03), loop(o, 0.03), loop(o, h - lipIn), loop(o - lipIn, h), loop(i + lipIn, h), loop(i, h - lipIn), loop(i, soil - 0.07)], { closed: true, crease: 30 });
  k.box(-o + 0.03, 0, -o + 0.03, o - 0.03, 0.031, o - 0.03, { r: 0 });                 // recessed plinth: a shadow line at the pavement
  // watering overflows the lip and the soil leaches through: brown runs from the top, green-black at the foot
  k.ground(m, 0.25, 0.5)
    .grime(m, (x, y, z) => (Math.max(Math.abs(x), Math.abs(z)) < o - 0.002 ? 0.5 * Math.max(0, 1 - (h - y) / 0.1) : 0.6 * Math.max(0, fbm2((Math.abs(x) > Math.abs(z) ? z : x) * 5 + (x + z > 0 ? 0 : 9), 1.3, 3, 47) - 0.4) * 2.2 * Math.max(0, 1 - (h - y) / 0.42)), [0.3, 0.23, 0.15])
    .grime(m, (x, y) => 0.35 * Math.max(0, 1 - y / 0.12), [0.13, 0.16, 0.1]);
  // soil, mounded and uneven
  const g = k.near ? 6 : 2, at = (a, b) => { const x = -i + 2 * i * a / g, z = -i + 2 * i * b / g, edge = Math.min(1, (i - Math.max(Math.abs(x), Math.abs(z))) / 0.12); return [x, soil - 0.03 + edge * (0.03 + 0.035 * fbm2(x * 4, z * 4, 3, 53)), z]; };
  const dirt = k.mark();
  k.paint([0.2, 0.15, 0.1], 0.95, 0.2);
  for (let a = 0; a < g; a++) for (let b = 0; b < g; b++) k.quad(at(a, b + 1), at(a + 1, b + 1), at(a + 1, b), at(a, b));
  k.shade(dirt, (x, y, z) => (0.55 + 0.45 * Math.min(1, (i - Math.max(Math.abs(x), Math.abs(z))) / 0.15)) * (0.8 + 0.4 * fbm2(x * 9, z * 9, 2, 59)));
}

const small = (name, build, footprint, collider, tags = ['furniture', 'small'], far = [28, 90]) => ({ name, build, footprint, collider, tags, far });

export const FURNITURE = [
  small('bench_a', (k) => bench(k), 1.15, { kind: 'box', hx: 1.05, hy: 0.45, hz: 0.32 }),
  small('bench_b', (k) => bench(k, { seedFront: 44, seedBack: 9 }), 1.15, { kind: 'box', hx: 1.05, hy: 0.45, hz: 0.32 }),
  small('bench_plain', (k) => bench(k, { advert: false, length: 1.8 }), 1.0, { kind: 'box', hx: 0.9, hy: 0.45, hz: 0.32 }),
  small('bin_a', bin, 0.4, { kind: 'cylinder', radius: 0.3, height: 0.9 }),
  small('hydrant', hydrant, 0.3, { kind: 'cylinder', radius: 0.16, height: 0.7 }),
  small('meter', (k) => meter(k, false), 0.2, { kind: 'cylinder', radius: 0.05, height: 1.3 }),
  small('meter_twin', (k) => meter(k, true), 0.25, { kind: 'cylinder', radius: 0.05, height: 1.3 }),
  small('phone_booth', phoneBooth, 0.7, { kind: 'box', hx: 0.43, hy: 1.1, hz: 0.43 }, ['furniture', 'small', 'lit'], [30, 110]),
  small('newsbox', (k) => newsbox(k, 2), 0.35, { kind: 'box', hx: 0.23, hy: 0.55, hz: 0.2 }, ['furniture', 'small', 'tint']),
  small('newsbox_b', (k) => newsbox(k, 8), 0.35, { kind: 'box', hx: 0.23, hy: 0.55, hz: 0.2 }, ['furniture', 'small', 'tint']),
  small('bus_stop', busShelter, 2.1, { kind: 'box', hx: 1.85, hy: 1.25, hz: 0.8 }, ['furniture', 'large', 'lit'], [35, 130]),
  small('bus_stop_sign', busSign, 0.5, { kind: 'cylinder', radius: 0.05, height: 2.75 }, ['furniture', 'sign', 'small']),
  small('bollard', bollard, 0.2, { kind: 'cylinder', radius: 0.1, height: 0.9 }),
  small('mailbox', mailbox, 0.42, { kind: 'box', hx: 0.25, hy: 0.61, hz: 0.28 }),
  small('dumpster', dumpster, 1.2, { kind: 'box', hx: 0.92, hy: 0.62, hz: 0.62 }, ['furniture', 'small'], [30, 110]),
  small('cone', cone, 0.26, null),
  small('planter_a', planter, 0.9, { kind: 'box', hx: 0.6, hy: 0.25, hz: 0.6 }, ['furniture', 'small'], [30, 110]),
].map((d) => (d.name === 'planter_a' ? { ...d, extra: { soilHeight: 0.42 } } : d));
