// Brakes and the parts of the corner that show behind the wheel.
//
// buildDisc: what turns with the wheel. A ventilated disc (two plates joined by radial vanes, open at the edge), its
// hat up to the wheel's mounting face, and the hub behind it.
// buildCorner: what does not turn. A four-piston caliper in two halves bridged over the disc, with its pads, pad pins
// and bolts; the dust shield; the hub carrier with its ball joints; at the rear the drive shaft with its boot, the
// lower links and a spring strut. Millimetres in the wheel frame until written.

import { VEHICLE } from '../../../core/ids.js';
import { frame, roundedBox, sweep, pathFrames, circleSection } from '../kit/solids.js';
import { turn, arcSweep, fillet, facet, bar, MM, TAU } from './skin.js';
import { COLOUR } from './design.js';

const DEG = Math.PI / 180;
const polar = (x, r, a) => [x, r * Math.cos(a), r * Math.sin(a)];

/** BRAKE_DISC p0: the swept friction face, or raw casting (ARCHITECTURE 5.4). */
const SWEPT = 0, RAW = 1;

/** The disc, its hat and the hub: everything of the brake that turns. */
export function buildDisc(mb, d, detail = 1) {
  const D = d.disc, x0 = D.x - D.thickness / 2, x1 = D.x + D.thickness / 2, R = D.radius, ri = D.inner, pl = D.plate;
  const fine = detail >= 0.5, segs = fine ? 72 : 20;
  const profile = [
    [x0 - 2, 46], [x0 - 2, ri - 4], [x0, ri],                              // 0-1 back of the hat's hollow
    [x0, R - 1], [x0 + 1, R], [x0 + pl, R],                                // 2 inner swept face, 3-4 edge of the inner plate
    [x0 + pl, ri + 8], [x1 - pl, ri + 8], [x1 - pl, R],                    // 5-7 the air channel between the plates
    [x1 - 1, R], [x1, R - 1],                                              // 8-9 edge of the outer plate
    [x1, ri],                                                              // 10 outer swept face
    ...fillet([[x1, ri], [x1 + 2.5, ri - 4], [d.pad - 5, D.hat + 4.5], [d.pad, D.hat + 3], [d.pad, D.hat - 6]], [0, 3, 6, 3, 0], 2).slice(1),
  ];
  mb.color(COLOUR.iron);
  turn(mb, profile, {
    segs, crease: 35,
    style: (i) => {
      const swept = i === 2 || i === 10, channel = i >= 5 && i <= 7;
      if (channel && !fine) return false;
      mb.material(VEHICLE.BRAKE_DISC, swept ? SWEPT : RAW, 0, 0); mb.color(swept ? COLOUR.iron : COLOUR.castIron); mb.occlusion(channel ? 0.35 : i < 2 ? 0.5 : swept ? 0.85 : 0.75);
      return true;
    },
  });
  if (!fine) { turn(mb, [[x0 + pl, R - 0.5], [x1 - pl, R - 0.5]], { segs }); return; }
  // vanes: thin radial webs between the plates, seen end-on round the edge
  mb.material(VEHICLE.BRAKE_DISC, RAW, 0, 0); mb.color(COLOUR.castIron);
  const half = 2.6, xa = x0 + pl, xb = x1 - pl;
  for (let k = 0; k < D.vanes; k++) {
    const a = (k + 0.5) / D.vanes * TAU, c = Math.cos(a), s = Math.sin(a);
    const at = (x, r, side) => [x, r * c - side * half * s, r * s + side * half * c, r * MM, a / TAU];
    mb.occlusion(0.55);
    facet(mb, [at(xa, R - 1.5, -1), at(xb, R - 1.5, -1), at(xb, R - 1.5, 1), at(xa, R - 1.5, 1)], [0, c, s]);
    for (const side of [-1, 1]) {
      const j = facet(mb, [at(xa, R - 1.5, side), at(xb, R - 1.5, side), at(xb, ri + 8, side), at(xa, ri + 8, side)], [0, -s * side, c * side]);
      mb.setOcclusion(j + 2, 0.2); mb.setOcclusion(j + 3, 0.2);
    }
  }
}

/** Hexagon bolt head standing on a point of the caliper, along +X. */
function boltHead(mb, x, r, a, across = 13, height = 6) {
  const [, y, z] = polar(0, r, a), m = frame([x * MM, y * MM, z * MM], [1, 0, 0], [0, y, z]), rr = across / Math.sqrt(3);
  turn(mb, [[0, rr], [height - 1, rr], [height, rr - 1.6], [height, 0]], { segs: 6, m, crease: 25 });
}

/**
 * The caliper: two halves either side of the disc, bridged at both ends and across the middle, pads between.
 * A car may ask for its own through d.caliper: { colour, finish: [roughness, metalness] bytes, depth (of each half,
 * millimetres), pistons (1 or 2 bosses showing on the outer half) }.
 */
function caliper(mb, d) {
  const D = d.disc, x0 = D.x - D.thickness / 2, x1 = D.x + D.thickness / 2, R = D.radius, A = d.caliperAngle, K = d.caliper || {};
  const span = 31 * DEG, depth = K.depth ?? 28, top = Math.min(R + 17, d.bore - 8), foot = R - 46, [rough, metal] = K.finish || [30, 0];
  const steps = 10;
  // body halves: a chamfered slab on each side of the disc
  const slab = (xa, xb) => { const lo = Math.min(xa, xb), hi = Math.max(xa, xb); return [[lo, foot + 4], [lo + 4, foot], [hi - 4, foot], [hi, foot + 4], [hi, top - 9], [hi - 3, top - 5], [lo + 3, top - 5], [lo, top - 9]]; };
  mb.material(VEHICLE.RIM, rough, metal, 2); mb.color(K.colour || COLOUR.caliper); mb.occlusion(0.9);     // the Lucera's: gloss red enamel
  arcSweep(mb, slab(x1 + 12.5, x1 + depth), A - span, A + span, { steps, bevel: 2.5 });
  arcSweep(mb, slab(x0 - depth, x0 - 12.5), A - span, A + span, { steps, bevel: 2.5 });
  // bridges over the disc's edge: one at each end and a bar across the middle, leaving two windows on the pads
  const over = [[x0 - depth + 3, R + 5], [x1 + depth - 3, R + 5], [x1 + depth - 3, top - 3], [x1 + depth - 6, top], [x0 - depth + 6, top], [x0 - depth + 3, top - 3]];
  arcSweep(mb, over, A - span, A - span + 10 * DEG, { steps: 3, bevel: 2 });
  arcSweep(mb, over, A + span - 10 * DEG, A + span, { steps: 3, bevel: 2 });
  arcSweep(mb, over.map(([x, r]) => [x, r > R + 6 ? r - 2 : r + 1]), A - 2.6 * DEG, A + 2.6 * DEG, { steps: 1, bevel: 1.5 });
  // the cylinders show as two round bosses on the outer half
  for (const s of K.pistons === 1 ? [0] : [-1, 1]) {
    const a = A + s * 13.5 * DEG, [, y, z] = polar(0, R - 21, a), m = frame([(x1 + depth) * MM, y * MM, z * MM], [1, 0, 0], [0, y, z]);
    turn(mb, fillet([[-1, 21], [2.6, 21], [4, 17.5], [4, 0]], [0, 1.6, 1.4, 0], 2), { segs: 20, m });
  }
  // pads: friction material on steel backing plates, in the windows
  const pad = (xa, xb) => { const lo = Math.min(xa, xb), hi = Math.max(xa, xb); return [[lo, foot + 6], [hi, foot + 6], [hi, R + 2.5], [lo, R + 2.5]]; };
  for (const [face, sign] of [[x1, 1], [x0, -1]]) {
    mb.material(VEHICLE.TRIM_BLACK, 235, 0); mb.color(0.09, 0.085, 0.08); mb.occlusion(0.6);
    arcSweep(mb, pad(face + sign * 0.6, face + sign * 8.5), A - 20 * DEG, A + 20 * DEG, { steps: 6, bevel: 0.6 });
    mb.material(VEHICLE.RIM, 120, 255, 2); mb.color(0.36, 0.36, 0.37); mb.occlusion(0.7);
    arcSweep(mb, pad(face + sign * 8.5, face + sign * 12.6), A - 21 * DEG, A + 21 * DEG, { steps: 6, bevel: 0.6 });
  }
  // pad pins across the windows, and the bolts that clamp the halves together
  mb.material(VEHICLE.RIM, 60, 255, 2); mb.color(COLOUR.steel); mb.occlusion(0.85);
  for (const s of [-1, 1]) bar(mb, polar(x0 - depth + 5, R + 3.2, A + s * 11 * DEG), polar(x1 + depth - 5, R + 3.2, A + s * 11 * DEG), 2.6, { segs: 8 });
  for (const s of [-1, 1]) for (const r of [top - 8, foot + 9]) boltHead(mb, x1 + depth, r, A + s * (r > R ? 26 : 25) * DEG);
  // bleed screw on the upper end of the outer half
  const up = A + (Math.cos(A + span) > Math.cos(A - span) ? 1 : -1) * (span - 5 * DEG);
  bar(mb, polar(x1 + depth - 12, top - 6, up), polar(x1 + depth - 12, top + 5, up), 3.2, { segs: 6, r1: 2 });
}

/** The pressed-steel shield behind the disc, cut away where the caliper sits. */
function dustShield(mb, d) {
  const D = d.disc, xs = D.x - D.thickness / 2 - 7, A = d.caliperAngle, gap = 37 * DEG;
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.07, 0.07, 0.075); mb.occlusion(0.6);
  turn(mb, fillet([[xs - 3, 50], [xs, 58], [xs, D.radius + 2], [xs + 6, D.radius + 7]], [0, 3, 5, 0], 2), { segs: 32, from: A + gap, to: A + TAU - gap });
  // its front, seen past the edge of the disc and between the vanes
  turn(mb, [[xs + 6, D.radius + 6], [xs + 1, D.radius + 1], [xs + 1, 58]], { segs: 32, from: A + gap, to: A + TAU - gap });
}

/** The hub carrier: bearing housing, an arm up and an arm down to the ball joints, and the steering or toe arm. */
function upright(mb, d) {
  const D = d.disc, x0 = D.x - D.thickness / 2, xe = x0 - 62, rear = d.rear, reach = Math.min(rear ? 128 : 136, d.bore - 48);
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(COLOUR.castIron); mb.occlusion(0.6);
  turn(mb, fillet([[xe, 0], [xe, 40], [xe + 10, 52], [x0 - 8, 52], [x0 - 8, 44]], [0, 4, 5, 0, 0], 2), { segs: 24 });
  for (const s of [-1, 1]) {
    const arm = frame([(x0 - 36) * MM, s * (reach / 2 + 22) * MM, 0], [1, 0, 0], [0, 1, 0]);
    roundedBox(mb, arm, [0.03, (reach - 30) * MM, 0.044], 0.009, 2);
    // ball joint: a housing with the stud's taper pointing along the arm
    const y = s * reach, m = frame([(x0 - 38) * MM, y * MM, 0], [0, s, 0], [1, 0, 0]);
    turn(mb, fillet([[-14, 0], [-14, 15], [-2, 19], [6, 19], [9, 9], [20, 7], [20, 0]], [0, 3, 4, 2, 2, 0, 0], 2), { segs: 14, m });
  }
  // steering arm (front) or toe link eye (rear), pointing along the car
  const z = (Math.sin(d.caliperAngle) > 0 ? -1 : 1) * 78;
  roundedBox(mb, frame([(x0 - 40) * MM, -46 * MM, z * 0.55 * MM], [1, 0, 0], [0, 1, 0]), [0.024, 0.03, Math.abs(z) * 1.2 * MM], 0.008, 2);
  bar(mb, [x0 - 40, -58, z], [x0 - 40, -30, z], 11, { segs: 12 });
}

/** Rear only: drive shaft with its convoluted boot, the lower links and a spring strut reaching up into the arch. */
function driveline(mb, d) {
  const D = d.disc, xe = D.x - D.thickness / 2 - 62, inboard = -(d.hw + 82);
  mb.material(VEHICLE.TRIM_BLACK, 200, 0); mb.color(COLOUR.black); mb.occlusion(0.6);
  const boot = [[xe + 2, 44]]; for (let k = 0; k < 6; k++) { const x = xe - 8 - k * 9, r = 41 - k * 4.2; boot.push([x, r], [x - 4.5, r - 6.5]); }
  boot.push([xe - 66, 15]);
  turn(mb, boot.reverse(), { segs: 20, crease: 75 });
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.1, 0.1, 0.105); mb.occlusion(0.6);
  bar(mb, [xe - 60, 0, 0], [inboard, 6, 0], 14.5, { segs: 12 });
  // lower links from the bottom ball joint in to the chassis
  for (const z of [-150, 135]) bar(mb, [xe + 24, -128, 0], [inboard, -112, z], 12, { segs: 8 });
  // spring strut: damper body, rod, and the spring as a stack of coils
  const foot = [xe + 4, -96, 96], head = [inboard + 30, 196, 110], along = [head[0] - foot[0], head[1] - foot[1], head[2] - foot[2]], L = Math.hypot(...along);
  const m = frame(foot.map((v) => v * MM), along.map((v) => v / L), [0, 0, 1]);
  mb.color(0.05, 0.05, 0.055);
  turn(mb, [[0, 0], [0, 21], [L * 0.52, 21], [L * 0.52, 7.5], [L, 7.5], [L, 0]], { segs: 12, m, crease: 30 });
  // the spring: a true helix of round wire about the strut
  mb.material(VEHICLE.TRIM_BLACK, 110, 0); mb.color(0.2, 0.03, 0.03); mb.occlusion(0.7);
  const axis = along.map((v) => v / L), side = [m[4], m[5], m[6]], up = [m[8], m[9], m[10]], coil = [], turns = 8.5, per = 12;
  for (let k = 0; k <= turns * per; k++) {
    const t = k / per * TAU, s = L * (0.2 + 0.76 * k / (turns * per)), c = Math.cos(t) * 31, sn = Math.sin(t) * 31;
    coil.push([0, 1, 2].map((i) => (foot[i] + axis[i] * s + side[i] * c + up[i] * sn) * MM));
  }
  sweep(mb, pathFrames(coil, axis), circleSection(5.2 * MM, 6), { caps: true, flip: true });
}

/** Everything behind one wheel that does not turn with it. */
export function buildCorner(mb, d) {
  caliper(mb, d);
  dustShield(mb, d);
  upright(mb, d);
  if (d.rear) driveline(mb, d);
}
