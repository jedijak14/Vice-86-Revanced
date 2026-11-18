// Outdoor advertising structures. The printed face looks along +Z (yaw the instance so +Z points at the traffic
// that should read it); the structure stands on the origin.
//
//   billboard_a  the large "bulletin" of causeways and approach roads: a wide face high on a single steel column,
//                a service catwalk along the bottom and flood lamps on arms in front of the bottom edge, aimed up.
//   billboard_b  the smaller poster panel of commercial streets: a moulded pale frame on two rolled-steel posts,
//                an apron and catwalk under it, lamps on arms from the top edge shining down the face.
//
// Each board has four (a) or two (b) lamp fittings with their own lens and glow; the light records are merged to
// two per board (the renderer's per-cell budget), registered at the lens of the fitting they stand for.

import { CHANNEL } from '../../core/ids.js';
import { place, radianceCode } from './kit.js';
import { C, SOURCE, srgb, times, basePlate, signPlate, rectOutline, ladder, railing, ibeam } from './common.js';
import { signRect } from './atlas.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const FRAME_GREEN = [0.12, 0.2, 0.16], FACE_GLOW = 1.2;

/** Flood fitting around its own origin with the lens facing +Y (tilted into place by the caller). */
function flood(k) {
  const f = k.child();
  f.steel(C.darkSteel, 0.55, 0.3);
  f.box(-0.26, -0.15, -0.12, 0.26, 0, 0.12, { axis: 'x', r: f.near ? 0.012 : 0 });
  if (f.near) { f.box(-0.03, -0.22, -0.03, 0.03, -0.15, 0.03); for (const sx of [-1, 1]) f.box(sx * 0.27 - 0.008, -0.1, -0.1, sx * 0.27 + 0.008, 0.04, 0.1); }   // knuckle and side visors
  f.lens(srgb(SOURCE.halide), 30);
  f.box(-0.235, 0, -0.1, 0.235, 0.012, 0.1, { axis: 'x' });
  return f;
}

/**
 * Mount the lamps of a board. `mounts`: [{ arm: [from, to], pitch }], lens at `to`; `lit`: indices of the two fittings
 * that carry the merged light records, each aimed at `aim[i]`.
 */
function boardLamps(k, mounts, lit, aims, power, radius) {
  mounts.forEach((mt, i) => {
    const [a, b] = mt.arm;
    k.bare(2, 0.5, C.galv);
    if (k.mid) k.tube([a, [b[0], b[1] - Math.sign(Math.cos(mt.pitch)) * 0.2, b[2]]], 0.022, k.n(8, 4), { capA: true, capB: true });
    k.add(flood(k), place(b[0], b[1], b[2], 0, mt.pitch));
    const lens = [b[0], b[1] + Math.cos(mt.pitch) * 0.012, b[2] + Math.sin(mt.pitch) * 0.012], glow = { color: times(SOURCE.halide, 30), size: 0.6, kind: 0 }, at = lit.indexOf(i);
    if (at >= 0) k.fixture(lens, CHANNEL.STREET, { color: times(SOURCE.halide, power), radius, spot: { axis: [aims[at][0] - lens[0], aims[at][1] - lens[1], aims[at][2] - lens[2]], outerDeg: 72, innerDeg: 40 } }, glow, 0.2 + 0.4 * at);
    else k.glows.push({ pos: lens, size: glow.size, color: glow.color, channel: CHANNEL.STREET, kind: 0 });
  });
}

/** Service catwalk in front of the bottom edge: grating on brackets with a single pipe rail on the outside. */
function catwalk(k, x0, x1, y, z0, width, brackets) {
  k.bare(2, 0.6, C.galv);
  const m = k.mark();
  k.box(x0, y - 0.04, z0, x1, y, z0 + width, { axis: 'x' });
  if (k.mid) for (const x of brackets) k.bar([x, y - 0.09, z0 - 0.2], [x, y - 0.09, z0 + width], 0.06, 0.1, { up: Y });
  k.shade(m, (px, py) => (py < y - 0.02 ? 0.6 : 1));
  if (k.mid) railing(k, [[x0 + 0.03, y, z0 + width - 0.03], [x1 - 0.03, y, z0 + width - 0.03]], { height: 0.95, r: 0.016, postEvery: 2.5, mids: 0, n: k.n(6, 4) });
}

/** The printed face: a panel thick enough to read as sheet on stringers, weakly self-lit so it carries beyond the range of its lamps. */
function face(k, rect, w, h, centre, thickness) {
  signPlate(k, centre, X, Y, rectOutline(w, h), rect, { code: radianceCode(FACE_GLOW), channel: CHANNEL.STREET, thickness, edge: (q) => q.steel(FRAME_GREEN, 0.6, 0.3) });
}

function bulletin(k, seed) {
  const rect = signRect('billboard-wide', seed), w = 14.6, h = w / rect.aspect, yb = 8.2, yt = yb + h, zf = 0.62, colR = 0.5, beamY = yb + h * 0.5;
  // footing and column
  k.concrete(C.concrete, 0, 0.5);
  const foot = k.mark();
  k.cyl([0, 0, 0], [0, 0.22, 0], 0.95, 0.95, k.n(24, 8), { capB: true });
  k.ground(foot, 0.2, 0.4);
  k.steel([0.36, 0.4, 0.4], 0.55, 0.3);
  const col = k.mark(), n = k.n(22, 7);
  k.tube([0.22, 0.6, 2.2, 5, beamY + 0.5].map((y) => [0, y, 0]), colR, n, { capB: true });
  if (k.mid) k.lathe([0, 0.22, 0], Y, [[0, colR + 0.16], [0.035, colR + 0.16], [0.035, colR]], n, { crease: 30 });           // base flange
  if (k.near) for (let i = 0; i < 12; i++) { const a = (i + 0.5) / 12 * Math.PI * 2; k.bolt([Math.cos(a) * (colR + 0.09), 0.255, Math.sin(a) * (colR + 0.09)], Y, 0.03, 0.03); }
  k.ground(col, 0.9, 0.45, 0.22).under(col, beamY - 0.45, 1.2, 0.35);
  k.grime(col, (x, y) => 0.3 * Math.max(0, 1 - (y - 0.22) / 1.4), C.rust);
  // torsion beam through the column head, uprights carrying the face
  const beam = k.mark();
  k.box(-5.4, beamY - 0.45, -0.35, 5.4, beamY + 0.45, 0.35, { axis: 'x', stops: [0.44, 0.56] });
  k.joint(beam, [0, beamY, 0], 1.1, 0.35);
  const uprights = []; for (let i = 0; i < 7; i++) uprights.push(-6.3 + i * 2.1);
  const frame = k.mark();
  if (k.mid) for (const x of uprights) ibeam(k, [x, yb - 0.15, 0.455], [x, yt, 0.455], 0.16, 0.21, Z);
  if (k.near) for (const y of [yb + 0.25, yt - 0.25]) k.box(-w / 2, y - 0.04, 0.5, w / 2, y + 0.04, 0.56, { axis: 'x' });   // girts
  k.shade(frame, (x, y, z) => (z > 0.36 ? 0.7 : 1));
  face(k, rect, w, h, [0, yb + h / 2, zf - 0.03], 0.06);
  if (k.mid) {
    // trim round the face
    k.steel(FRAME_GREEN, 0.6, 0.3);
    for (const y of [yb - 0.05, yt + 0.05]) k.box(-w / 2 - 0.1, y - 0.05, zf - 0.08, w / 2 + 0.1, y + 0.05, zf + 0.02, { axis: 'x' });
    for (const sx of [-1, 1]) k.box(sx * (w / 2 + 0.05) - 0.05, yb, zf - 0.08, sx * (w / 2 + 0.05) + 0.05, yt, zf + 0.02);
  }
  const deckY = yb - 0.38, deckZ = zf + 0.03;
  catwalk(k, -w / 2, w / 2, deckY, deckZ, 0.62, uprights);
  if (k.mid) { k.bare(2, 0.55, C.galv); ladder(k, [0, 2.9, colR + 0.14], [0, deckY - 0.05, colR + 0.14], Z); }
  // four floods on arms 1.5 m in front of the bottom edge, aimed up the face
  const lampX = [-5.48, -1.83, 1.83, 5.48], lz = zf + 1.5, ly = deckY - 0.2;
  boardLamps(k, lampX.map((x) => ({ arm: [[x, deckY - 0.06, deckZ + 0.6], [x, ly, lz]], pitch: -0.62 })), [1, 2], [[-3.9, yb + h * 0.6, zf], [3.9, yb + h * 0.6, zf]], 150, 15);
}

function posterPanel(k, seed) {
  const rect = signRect('billboard', seed), w = 7.62, h = w / rect.aspect, yb = 4.6, yt = yb + h, postX = [-2.45, 2.45], pale = [0.86, 0.85, 0.8];
  // posts on concrete footings
  for (const x of postX) {
    k.concrete(C.concrete, 0, 0.5);
    const f = k.mark(); k.box(x - 0.3, 0, -0.5, x + 0.3, 0.16, 0.1, { r: k.near ? 0.015 : 0 }); k.ground(f, 0.15, 0.4);
    k.steel([0.3, 0.33, 0.32], 0.6, 0.4);
    const p = k.mark();
    ibeam(k, [x, 0.16, -0.2], [x, yt + 0.05, -0.2], 0.22, 0.3, Z, { stops: [0.08, 0.5] });
    k.ground(p, 0.6, 0.45, 0.16).grime(p, (px, py) => 0.35 * Math.max(0, 1 - (py - 0.16) / 1.0), C.rust);
  }
  k.steel([0.3, 0.33, 0.32], 0.6, 0.4);
  if (k.mid) for (const y of [yb + 0.3, yb + h / 2, yt - 0.3]) k.box(-w / 2 + 0.1, y - 0.05, -0.05, w / 2 - 0.1, y + 0.05, 0, { axis: 'x' });   // girts
  if (k.near) for (const s of [-1, 1]) k.bar([postX[0], yb - 1.4 + (s > 0 ? 0 : 1.2), -0.2], [postX[1], yb - 1.4 + (s > 0 ? 1.2 : 0), -0.2], 0.012, 0.07, { up: Y });   // cross bracing between the posts
  face(k, rect, w, h, [0, yb + h / 2, 0.025], 0.05);
  // moulded frame: an outer band and a raised inner bead
  k.paint(pale, 0.5, 0.4);
  const fr = k.mark(), band = 0.2;
  for (const [y0, y1] of [[yb - band, yb], [yt, yt + band]]) k.box(-w / 2 - band, y0, -0.02, w / 2 + band, y1, 0.11, { axis: 'x', r: k.mid ? 0.03 : 0 });
  for (const sx of [-1, 1]) k.box(Math.min(sx * w / 2, sx * (w / 2 + band)), yb, -0.02, Math.max(sx * w / 2, sx * (w / 2 + band)), yt, 0.11, { r: k.mid ? 0.03 : 0 });
  k.grime(fr, (x, y) => 0.25 * Math.max(0, 1 - (yt + band - y) / 0.5) * (y > yt ? 1 : 0) + (y < yb ? 0.18 : 0), [0.25, 0.24, 0.2]);
  // apron below the frame with the operator's plate, then the catwalk
  k.steel(FRAME_GREEN, 0.6, 0.35);
  const ap = k.mark();
  k.box(-w / 2, yb - band - 0.55, 0, w / 2, yb - band, 0.04, { axis: 'x' });
  k.under(ap, yb - band, 0.3, 0.35);
  if (k.near) { k.paint(pale, 0.5, 0.3); k.panel([0, yb - band - 0.27, 0.042], X, Y, 1.1, 0.22); }
  const deckY = yb - band - 0.6;
  catwalk(k, -w / 2, w / 2, deckY, 0.04, 0.6, [-3.3, -1.1, 1.1, 3.3]);
  if (k.mid) { k.bare(2, 0.55, C.galv); ladder(k, [postX[1], 2.6, -0.42], [postX[1], yt - 0.4, -0.42], [0, 0, -1]); }
  // two floods on arms from the top edge, shining down and back onto the face
  boardLamps(k, [-1.9, 1.9].map((x) => ({ arm: [[x, yt + band, 0.05], [x, yt + 0.62, 1.3]], pitch: -(Math.PI - 0.6) })), [0, 1], [[-1.9, yb + h * 0.35, 0.05], [1.9, yb + h * 0.35, 0.05]], 70, 11);
}

const board = (name, build, extra) => ({ name, build, far: [60, 220, 900], tags: ['billboard', 'tall', 'large', 'lit'], ...extra });

export const BILLBOARDS = [
  board('billboard_a', (k) => bulletin(k, 7), { footprint: 1.0, collider: { kind: 'cylinder', radius: 0.55, height: 8 } }),
  board('billboard_b', (k) => posterPanel(k, 4), { footprint: 2.9, collider: { kind: 'box', hx: 2.75, hy: 4.3, hz: 0.3 } }),
];
