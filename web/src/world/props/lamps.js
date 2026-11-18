// Street lighting: cobra-head roadway lamps on tapered steel poles (single arm, twin-arm median, tall highway)
// and the globe-topped promenade lamp of the ocean-front drive.
//
// Orientation: the pole stands on the origin, the arm reaches along +Z (towards the carriageway).
// Every luminaire is a lens (SOLID.LAMP_LENS on CHANNEL.STREET) with its light and glow registered at the lens.

import { smoothstep, lerp } from '../../core/math.js';
import { place } from './kit.js';
import { C, SOURCE, srgb, luminaire, basePlate } from './common.js';

const HEAD_GREY = [0.52, 0.54, 0.54];

/**
 * Cobra-head luminaire around its own origin: the slip-fitter neck is at the origin, the body runs along +Z.
 * Returns the lens position (lowest point of the refractor bowl) in the head's frame.
 */
function cobraHead(k, scale, radiance) {
  const L = 0.80 * scale, rows = k.n(10, 4), cols = k.n(14, 6);
  const nose = (t) => (t <= 0.55 ? 1 : Math.sqrt(Math.max(0, 1 - ((t - 0.55) / 0.45) ** 2)));
  const halfWidth = (t) => lerp(0.052, 0.19, smoothstep(0.06, 0.55, t)) * scale * nose(t);
  const top = (t) => lerp(0.05, 0.088, smoothstep(0.03, 0.5, t)) * scale * Math.pow(nose(t), 0.8);
  const bottom = (t) => lerp(0.05, 0.07, smoothstep(0.05, 0.4, t)) * scale * Math.pow(nose(t), 0.8);
  const section = (t) => {
    const w = halfWidth(t), ring = [];
    for (let j = 0; j < cols; j++) {
      const a = j / cols * Math.PI * 2, s = Math.sin(a);
      // rounded crown, flatter belly: the door with the refractor closes the underside
      ring.push([Math.cos(a) * w, s >= 0 ? s * top(t) : -Math.pow(-s, 0.55) * bottom(t), t * L]);
    }
    return ring;
  };
  k.steel(HEAD_GREY, 0.5, 0.12);
  const body = [];
  for (let i = 0; i <= rows; i++) body.push(section(i / rows));
  k.loft(body, { closed: true, crease: 70 });
  // slip-fitter collar: a closed plug that covers the open neck of the body around the arm. Its flats, not its
  // corners, lie on the 0.056 circle, so even the five-sided collar of the far levels is wider than the neck.
  const collarSides = k.n(12, 5), collarR = 0.056 * scale / Math.cos(Math.PI / collarSides);
  k.cyl([0, 0, 0.012], [0, 0, -0.014], collarR, collarR, collarSides, { capA: true, capB: true });
  // prismatic drop refractor
  const zc = 0.62 * L, lensR = [0.128 * scale, 0.078 * scale, 0.215 * scale], yb = -bottom(0.62) * 0.9;
  k.lens(srgb(SOURCE.sodium), radiance);
  const around = k.n(14, 6);
  k.ellipsoid([0, yb, zc], lensR[0], lensR[1], lensR[2], around, k.n(3, 2), { v0: -0.5, v1: 0 });
  // The bowl is closed by a lid on its rim. The belly hides it at the near level, but the coarser bodies of the far
  // levels are narrower at the nose than the bowl, and without a lid the inside of the glass shows there.
  k.steel(HEAD_GREY, 0.5, 0.12);
  const rim = (j) => { const a = j / around * Math.PI * 2; return [Math.cos(a) * lensR[0], yb, zc - Math.sin(a) * lensR[2]]; };
  for (let j = 0; j < around; j++) k.tri([0, yb, zc], rim(j), rim(j + 1));
  if (k.near) {
    // door frame around the refractor and the photocell on the crown
    k.steel(HEAD_GREY, 0.5, 0.2);
    k.lathe([0, yb - 0.004, zc], [0, 1, 0], [[0, lensR[0] * 1.0], [-0.012 * scale, lensR[0] * 1.04], [-0.012 * scale, lensR[0] * 1.12], [0.008, lensR[0] * 1.12], [0.008, 0]], k.n(14, 6));
    k.plastic([0.18, 0.2, 0.26], 0.4);
    k.cyl([0, top(0.3) - 0.004, 0.3 * L], [0, top(0.3) + 0.03 * scale, 0.3 * L], 0.024 * scale, 0.024 * scale, 8);
    k.ellipsoid([0, top(0.3) + 0.03 * scale, 0.3 * L], 0.024 * scale, 0.014 * scale, 0.024 * scale, 8, 3, { v0: 0, v1: 0.5 });
  }
  return [0, yb - lensR[1], zc];
}

/** Tapered round steel pole with flared base collar, handhole cover and cap. Returns the radius function r(y). */
export function steelPole(k, height, r0, r1, plate) {
  const radius = (y) => lerp(r0, r1, y / height), n = k.n(16, 5);
  k.bare(2, 0.5, C.galv);
  const base = k.mark();
  basePlate(k, plate, 0.028);
  const ys = k.lod === 2 ? [0.028, height] : [0.028, 0.16, 0.45, 1.2, height * 0.5, height];
  k.tube(ys.map((y) => [0, y, 0]), ys.map(radius), n, { capB: true });
  if (k.mid) k.lathe([0, 0.028, 0], [0, 1, 0], [[0, r0 + 0.045], [0.02, r0 + 0.04], [0.085, r0 + 0.006], [0.09, r0 * 0.7]], n);   // weld collar; its top closes in under the pole's flats, whose facets are not its own
  k.ground(base, 0.4, 0.5);
  if (k.near) {
    const y = 0.62, r = radius(y);
    k.bar([0, y - 0.13, -r - 0.001], [0, y + 0.13, -r - 0.001], 0.1, 0.012, { up: [0, 0, 1], r: 0.004 });    // handhole cover, pavement side
    for (const dy of [-0.1, 0.1]) k.bolt([0, y + dy, -r - 0.006], [0, 0, -1], 0.008, 0.005);
    k.ellipsoid([0, height, 0], r1, r1 * 0.5, r1, n, 3, { v0: 0, v1: 0.5 });
  }
  return radius;
}

/** One arm with its cobra head: an upswept pipe that levels out at the luminaire, braced back to the pole. */
export function lampArm(k, yaw, height, reach, rise, poleR, head) {
  const sub = k.child(), n = sub.n(8, 4), steps = sub.n(10, 3);
  const p0 = [0, height - 0.22, poleR(height - 0.22) * 0.6], p1 = [0, height + rise, reach * 0.42], p2 = [0, height + rise, reach - 0.02];
  const path = [];
  for (let i = 0; i <= steps; i++) { const t = i / steps, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t; path.push([0, a * p0[1] + b * p1[1] + c * p2[1], a * p0[2] + b * p1[2] + c * p2[2]]); }
  sub.bare(2, 0.5, C.galv);
  const m = sub.mark();
  sub.tube(path, 0.03 * head.scale, n);
  if (sub.mid) {
    const j = Math.round(steps * 0.5), yb = height - 1.25;
    sub.tube([[0, yb, poleR(yb) * 0.6], [0, path[j][1] - 0.02, path[j][2]]], 0.017 * head.scale, sub.n(8, 4));         // brace
    for (const y of [height - 0.22, yb]) sub.cyl([0, y - 0.06, 0], [0, y + 0.06, 0], poleR(y) + 0.008, poleR(y) + 0.008, sub.n(12, 5), { capA: true, capB: true });   // clamp bands
  }
  sub.joint(m, [0, height - 0.22, 0], 0.35, 0.4);
  const headKit = k.child(), lensPos = cobraHead(headKit, head.scale, head.radiance);
  sub.add(headKit, place(0, height + rise, reach, 0, 0, 0));
  const lens = [0, height + rise + lensPos[1], reach + lensPos[2]];
  luminaire(sub, lens, SOURCE.sodium, { power: head.power, radius: Math.round(lens[1] * 4), radiance: head.radiance, size: head.glow, kind: 1, spot: { axis: [0, -1, 0], outerDeg: head.outerDeg, innerDeg: head.innerDeg }, seed: head.seed });
  k.add(sub, place(0, 0, 0, yaw));
}

function roadLamp(k, o) {
  const poleR = steelPole(k, o.height, o.r0, o.r1, o.plate);
  o.arms.forEach((yaw, i) => lampArm(k, yaw, o.height, o.reach, o.rise, poleR, { ...o.head, seed: 0.37 + 0.31 * i }));
}

// promenade lamp paint: the resort's sea green after some summers of sun and salt
const DECO_GREEN = [0.4, 0.58, 0.56];
/** Promenade lamp: stepped base, fluted shaft, banded capital and an opal globe. */
function decoLamp(k) {
  const n = k.n(24, 6), shaftBase = 0.62, shaftTop = 3.02, r0 = 0.085, r1 = 0.062;
  const base = k.mark();
  k.concrete(C.offWhite, 0, 0.35);
  k.lathe([0, 0, 0], [0, 1, 0], [[0, 0.27], [0.11, 0.27], [0.125, 0.255], [0.125, 0.215], [0.24, 0.215], [0.255, 0.2], [0.255, 0.165], [0.4, 0.165], [0.415, 0.15], [0.415, 0.125],
    [0.56, 0.115], [shaftBase, 0.1], [shaftBase, 0.04]], n, { crease: 30 });
  k.ground(base, 0.3, 0.55);
  // fluted shaft: twelve shallow flutes with crisp arrises, plain tube from the middle distance
  k.steel(DECO_GREEN, 0.45, 0.3);
  const shaft = k.mark();
  if (k.near) {
    const flutes = 12, per = 4, cols = flutes * per, rowsY = [shaftBase, shaftBase + 0.05, 1.4, 2.2, shaftTop - 0.05, shaftTop], rows = [];
    rowsY.forEach((y, i) => {
      const r = lerp(r0, r1, (y - shaftBase) / (shaftTop - shaftBase)), fade = i === 0 || i === rowsY.length - 1 ? 0 : 1, ring = [];
      for (let j = 0; j < cols; j++) { const a = j / cols * Math.PI * 2, f = 0.5 - 0.5 * Math.cos(a * flutes); ring.push([Math.cos(a) * r * (1 - 0.085 * f * fade), y, -Math.sin(a) * r * (1 - 0.085 * f * fade)]); }
      rows.push(ring);
    });
    k.loft(rows, { closed: true, crease: 28 });
  } else k.cyl([0, shaftBase, 0], [0, shaftTop, 0], r0, r1, n, { capB: true });
  k.under(shaft, shaftTop, 0.25, 0.35).ground(shaft, 0.25, 0.4, shaftBase);
  // capital: three speed rings, then the cup that carries the globe
  k.bare(1, 0.3, C.alu);
  const cap = k.mark(), ring = (y, r) => [[y - 0.016, r1 * 0.9], [y - 0.016, r], [y + 0.016, r], [y + 0.016, r1 * 0.9]];
  if (k.mid) for (const [y, r] of [[shaftTop + 0.03, 0.105], [shaftTop + 0.085, 0.125], [shaftTop + 0.14, 0.105]]) k.lathe([0, 0, 0], [0, 1, 0], ring(y, r), n, { crease: 30 });
  k.steel(DECO_GREEN, 0.45, 0.3);
  const cupY = shaftTop + 0.16, globeR = 0.2, globeY = cupY + 0.1 + globeR * 0.92;
  // the cup is a closed solid (disc underneath, disc on top): its facets do not line up with the shaft's or the globe's
  k.lathe([0, 0, 0], [0, 1, 0], [[shaftTop, 0], [shaftTop, r1], [cupY, r1 * 0.95], [cupY + 0.05, 0.09], [cupY + 0.1, 0.125], [cupY + 0.115, 0.125], [cupY + 0.115, 0]], n, { crease: 40 });
  k.under(cap, globeY - globeR * 0.5, 0.2, 0.3);
  k.lens(srgb(SOURCE.warmWhite), 24);
  k.ellipsoid([0, globeY, 0], globeR, globeR, globeR, k.n(24, 8), k.n(14, 4), { v0: -0.4, v1: 0.5 });
  if (k.mid) {
    k.bare(1, 0.3, C.alu);
    k.lathe([0, globeY + globeR, 0], [0, 1, 0], [[-0.012, 0.062], [0.006, 0.058], [0.03, 0.02], [0.07, 0.012], [0.085, 0]], k.n(12, 5), { crease: 50 });      // finial
  }
  luminaire(k, [0, globeY, 0], SOURCE.warmWhite, { power: 82, radius: Math.round(globeY * 4), radiance: 24, size: 1.0, kind: 1, seed: 0.61 });   // omnidirectional globe; reach four times its height like the roadway lamps
}

// Cobra-head beams. The cut-off optic is bright straight down and still throws about a tenth of that along the
// road between poles, which is what lights the cars and lets the lamp glint in paint, glass and wet asphalt
// from further than its own pool: full beam to 63 degrees, tailing off to 80, with a reach of four times the
// mounting height (set from the lens height in lampArm). The inverse-square falloff keeps a readable pool
// under each lamp and a dimmer stretch between, instead of either an even wash or black gaps.
const HEAD = { scale: 1, radiance: 45, power: 420, glow: 1.4, outerDeg: 80, innerDeg: 63 };
const HEAD_HIGHWAY = { scale: 1.22, radiance: 60, power: 760, glow: 1.8, outerDeg: 80, innerDeg: 63 };

export const LAMPS = [
  { name: 'lamp_cobra', nearTess: 1.25, far: [45, 150, 600], footprint: 0.35, collider: { kind: 'cylinder', radius: 0.16, height: 8.6 }, tags: ['lamp', 'tall', 'large', 'lit'],
    build: (k) => roadLamp(k, { height: 8.6, r0: 0.125, r1: 0.065, plate: 0.4, reach: 2.4, rise: 0.75, arms: [0], head: HEAD }) },
  { name: 'lamp_cobra_twin', nearTess: 1.0, far: [45, 150, 600], footprint: 0.38, collider: { kind: 'cylinder', radius: 0.15, height: 9.4 }, tags: ['lamp', 'tall', 'large', 'lit'],
    build: (k) => roadLamp(k, { height: 9.4, r0: 0.135, r1: 0.07, plate: 0.44, reach: 2.2, rise: 0.7, arms: [0, Math.PI], head: HEAD }) },
  { name: 'lamp_highway', nearTess: 1.25, far: [55, 190, 800], footprint: 0.45, collider: { kind: 'cylinder', radius: 0.18, height: 12.2 }, tags: ['lamp', 'tall', 'large', 'lit'],
    build: (k) => roadLamp(k, { height: 12.2, r0: 0.15, r1: 0.075, plate: 0.5, reach: 3.3, rise: 0.95, arms: [0], head: HEAD_HIGHWAY }) },
  { name: 'lamp_deco', nearTess: 1.0, far: [35, 110, 380], footprint: 0.32, collider: { kind: 'cylinder', radius: 0.2, height: 3.6 }, tags: ['lamp', 'large', 'lit'],
    build: decoLamp },
];
