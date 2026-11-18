// Road signs: street-name blades, regulatory plates on U-channel posts, and overhead guide signs.
//
// Kerbside signs stand on the origin and face +Z. Overhead guide signs follow the signal convention: the post
// stands on the right of traffic travelling towards +Z, the arm or gantry reaches along +X over the lanes and the
// panels face -Z, towards the arriving drivers. All printed faces come from the sign atlas (SOLID.SIGN, painted).

import { place } from './kit.js';
import { C, basePlate, signPlate, rectOutline, octagonOutline } from './common.js';
import { signRect } from './atlas.js';

/** Galvanised U-channel post from the ground to `height`, its open side towards -Z (the sign bolts to the flat side). */
function channelPost(k, height, x = 0) {
  k.bare(2, 0.55, C.galv);
  const m = k.mark();
  if (k.near) k.extrude([[-0.008, -0.04], [-0.008, -0.022], [-0.032, -0.013], [-0.032, 0.013], [-0.008, 0.022], [-0.008, 0.04]], [x, 0, 0], [0, 0, 1], [1, 0, 0], height, { closed: false, crease: 20 });
  else k.box(x - 0.03, 0, -0.03, x + 0.03, height, -0.004);
  k.ground(m, 0.35, 0.5);
}

function plateSign(k, category, seed, width, bottom, outlineOf) {
  const rect = signRect(category, seed), h = width / rect.aspect, top = bottom + h;
  channelPost(k, top + 0.04);
  signPlate(k, [0, bottom + h / 2, 0.003], [1, 0, 0], [0, 1, 0], outlineOf(width, h), rect, { code: 0 });
  if (k.near) { k.bare(2, 0.5, C.galv); for (const y of [bottom + h * 0.25, bottom + h * 0.75]) k.bolt([0, y, 0.005], [0, 0, 1], 0.009, 0.005); }
}

/** Two street-name blades crossed on a round post, each printed on both sides. */
function streetSign(k, seed) {
  const h = 2.95, r = 0.03, n = k.n(10, 5), m = k.mark();
  k.bare(2, 0.55, C.galv);
  k.cyl([0, 0, 0], [0, h, 0], r, r, n, { capB: true, stops: k.mid ? [0.12] : [] });
  k.ground(m, 0.35, 0.5);
  [0, 1].forEach((i) => {
    const rect = signRect('street-name', seed + i * 7), w = 0.9, bh = w / rect.aspect, y = h + 0.02 + bh / 2 + i * (bh + 0.03), yaw = i * Math.PI / 2;
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    signPlate(k, [0, y, 0], right, [0, 1, 0], rectOutline(w, bh), rect, { backSign: rect, code: 0, thickness: 0.006 });
    if (k.mid) { k.bare(1, 0.45, C.alu); k.cyl([0, y - bh / 2 - 0.03, 0], [0, y - bh / 2 + 0.004, 0], r * 1.2, r * 1.2, n, { capA: true, capB: true }); }      // slotted bracket under each blade: a closed collar
  });
}

/** Tubular truss between two points along X: two chords, verticals and diagonals. */
function truss(k, x0, x1, y, depth) {
  const bays = Math.max(2, Math.round((x1 - x0) / 1.4));
  k.bare(2, 0.5, C.galv);
  for (const dy of [0, depth]) k.cyl([x0, y + dy, 0], [x1, y + dy, 0], 0.05, 0.05, k.n(8, 4), { capB: true });
  if (!k.mid) return;
  for (let i = 0; i <= bays; i++) {
    const x = x0 + (x1 - x0) * i / bays;
    const end = i === 0 || i === bays;                              // the end verticals stand half proud of the chord ends
    k.cyl([x, y, 0], [x, y + depth, 0], 0.026, 0.026, 4, { capA: end, capB: end });
    if (i < bays && k.near) { const xn = x0 + (x1 - x0) * (i + 1) / bays; k.cyl(i % 2 ? [x, y + depth, 0] : [x, y, 0], i % 2 ? [xn, y, 0] : [xn, y + depth, 0], 0.02, 0.02, 4); }
  }
}
function gantryPost(k, x, height, r) {
  const sub = k.child(), n = sub.n(12, 5), m = sub.mark();
  sub.bare(2, 0.5, C.galv);
  basePlate(sub, r * 3.6, 0.03, 0, 0.02);
  sub.cyl([0, 0.03, 0], [0, height, 0], r, r * 0.8, n, { capB: true, stops: sub.mid ? [0.08] : [] });
  sub.ground(m, 0.45, 0.5);
  k.add(sub, place(x, 0, 0));
}
/** Guide panel hung in front of the truss (facing -Z), with its extruded frame and hanger straps. */
function guidePanel(k, x, y, width, seed) {
  const rect = signRect('direction', seed), h = width / rect.aspect;
  signPlate(k, [x, y, -0.11], [-1, 0, 0], [0, 1, 0], rectOutline(width, h), rect, { code: 0, thickness: 0.012 });
  if (k.mid) { k.bare(2, 0.5, C.galv); for (const dx of [-width * 0.3, width * 0.3]) k.box(x + dx - 0.03, y - h / 2 + 0.05, -0.1, x + dx + 0.03, y + h / 2 - 0.05, -0.05); }
  return h;
}

function cantileverSign(k, seed) {
  const postH = 7.6, y = 6.15, depth = 0.9, reach = 6.6, w = 3.6;
  gantryPost(k, 0, postH, 0.17);
  truss(k, 0.1, reach, y, depth);
  guidePanel(k, reach - w / 2 - 0.1, y + depth / 2, w, seed);
}
function gantrySign(k, span, seed) {
  const postH = 7.9, y = 6.3, depth = 1.0, w = 3.9;
  gantryPost(k, 0, postH, 0.19); gantryPost(k, span, postH, 0.19);
  truss(k, 0.1, span - 0.1, y, depth);
  guidePanel(k, span * 0.28, y + depth / 2, w, seed);
  guidePanel(k, span * 0.72, y + depth / 2, w, seed + 5);
}

const post = (name, build, footprint, height) => ({ name, far: [30, 110], footprint, collider: { kind: 'cylinder', radius: 0.06, height }, tags: ['sign', 'small'], build });
const streetVariant = (suffix, seed) => post('sign_street' + suffix, (k) => streetSign(k, seed), 0.5, 3.0);

export const SIGNS = [
  streetVariant('', 3), streetVariant('_b', 17), streetVariant('_c', 31), streetVariant('_d', 53),
  post('sign_stop', (k) => plateSign(k, 'stop', 1, 0.75, 2.1, (w) => octagonOutline(w)), 0.45, 2.9),
  post('sign_speed', (k) => plateSign(k, 'speed', 2, 0.6, 2.1, rectOutline), 0.4, 2.9),
  post('sign_speed_b', (k) => plateSign(k, 'speed', 9, 0.6, 2.1, rectOutline), 0.4, 2.9),
  post('sign_oneway', (k) => plateSign(k, 'oneway', 4, 0.9, 2.2, rectOutline), 0.5, 2.5),
  { name: 'sign_direction', far: [45, 160, 500], footprint: 0.5, collider: { kind: 'cylinder', radius: 0.2, height: 7.6 }, tags: ['sign', 'tall', 'large'], extra: { arm: 6.6 }, build: (k) => cantileverSign(k, 6) },
  { name: 'sign_direction_b', far: [45, 160, 500], footprint: 0.5, collider: { kind: 'cylinder', radius: 0.2, height: 7.6 }, tags: ['sign', 'tall', 'large'], extra: { arm: 6.6 }, build: (k) => cantileverSign(k, 19) },
  { name: 'sign_gantry', far: [50, 180, 600], footprint: 0.5, collider: { kind: 'cylinder', radius: 0.22, height: 7.9 }, tags: ['sign', 'tall', 'large'],
    extra: { span: 16, extraColliders: [{ kind: 'cylinder', radius: 0.22, height: 7.9, offset: [16, 0, 0] }] }, build: (k) => gantrySign(k, 16, 12) },
];
