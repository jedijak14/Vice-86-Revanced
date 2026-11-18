// Roadside utilities and barriers.
//
// power_pole stands on the origin. Its conductors run along X (along the street when the pole is placed like any
// kerbside prop, +Z towards the carriageway), so the cross-arm lies along Z and the transformer hangs on the
// pavement side (-Z). `anchors` lists where wires attach, in a fixed order, so the planner can string spans between
// consecutive poles anchor by anchor.
//
// Linear segments (fence, walls, guardrail, barrier) run along X, centred on the origin, `length` long, and are
// butt-jointed: a segment owns everything between x = -length/2 and +length/2. The guardrail's traffic face is +Z.

import { fbm2 } from '../../core/math.js';
import { C, ibeam } from './common.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// ---------------------------------------------------------------- timber distribution pole
/** Pin insulator standing on `p`: steel pin, two porcelain sheds. Returns the conductor seat. */
function pinInsulator(k, p) {
  const n = k.n(10, 5);
  if (k.mid) { k.bare(2, 0.5, C.galv); k.cyl(p, [p[0], p[1] + 0.07, p[2]], 0.012, 0.012, 5); }
  k.plastic(C.porcelain, 0.2);
  k.lathe([p[0], p[1] + 0.06, p[2]], Y, k.near ? [[0, 0], [0, 0.03], [0.012, 0.062], [0.045, 0.058], [0.055, 0.03], [0.07, 0.048], [0.1, 0.04], [0.125, 0.022], [0.13, 0]] : [[0, 0], [0, 0.05], [0.1, 0.045], [0.13, 0]], n, { crease: 50 });      // closed underneath: seen from the pavement
  return [p[0], p[1] + 0.165, p[2]];
}

function powerPole(k, transformer) {
  const H = 11.2, r0 = 0.155, r1 = 0.095, n = k.n(14, 5), r = (y) => r0 + (r1 - r0) * y / H;
  k.wood(C.timber, 0.85, 0.6);
  const pole = k.mark(), ys = k.lod === 2 ? [0, H] : [0, 0.5, 1.6, 4, 7.5, H];
  k.tube(ys.map((y) => [0, y, 0]), ys.map(r), n, { capB: true });
  k.ground(pole, 0.5, 0.5).grime(pole, (x, y) => 0.45 * Math.max(0, 1 - y / 1.3) + 0.2 * Math.max(0, 1 - (H - y) / 0.6), [0.1, 0.085, 0.07]);   // creosote butt, weathered top
  // cross-arm with its two flat braces
  const armY = 10.35, half = 1.2, arm = k.mark();
  k.wood(C.timber, 0.85, 0.5);
  k.bar([0, armY, -half], [0, armY, half], 0.095, 0.12, { up: Y, r: k.near ? 0.008 : 0 });
  k.joint(arm, [0, armY, 0], 0.3, 0.4);
  if (k.mid) {
    k.bare(2, 0.55, C.galv);
    for (const s of [-1, 1]) k.bar([r(armY - 0.7) + 0.012, armY - 0.72, 0], [0.06, armY - 0.03, s * 0.72], 0.006, 0.032, { up: X });
    k.box(-r(armY) - 0.02, armY - 0.05, -0.012, 0.07, armY + 0.05, 0.012, { axis: 'x' });                    // through bolt and washer plate
  }
  // three primary conductors on pin insulators, then the neutral on a spool rack and the telephone cable below
  const seats = [[0.0475, armY + 0.06, -1.05], [0.0475, armY + 0.06, 0.38], [0.0475, armY + 0.06, 1.05]].map((p) => pinInsulator(k, [0, p[1], p[2]]));
  seats.forEach((p) => k.anchors.push({ kind: 'primary', pos: p }));
  const rackY = 8.45, rz = r(rackY);
  if (k.mid) {
    k.bare(2, 0.55, C.galv); k.box(-0.02, rackY - 0.32, rz, 0.02, rackY + 0.32, rz + 0.03);
    k.plastic(C.porcelain, 0.25);
    for (const dy of [-0.2, 0, 0.2]) k.lathe([0, rackY + dy - 0.035, rz + 0.07], Y, [[0, 0], [0, 0.03], [0.012, 0.04], [0.035, 0.026], [0.058, 0.04], [0.07, 0.03], [0.07, 0]], k.n(8, 5), { crease: 50 });
  }
  for (const dy of [0.2, 0, -0.2]) k.anchors.push({ kind: 'secondary', pos: [0, rackY + dy, rz + 0.07 + 0.03] });
  const commY = 6.9;
  if (k.mid) { k.bare(2, 0.55, C.galv); k.box(-0.03, commY - 0.05, r(commY) - 0.01, 0.03, commY + 0.05, r(commY) + 0.05); }
  k.anchors.push({ kind: 'comm', pos: [0, commY, r(commY) + 0.06] });
  if (transformer) {
    // pole-mounted can on the pavement side: tank with lid, two bushings, hanger brackets and the drop from the primary
    const cz = -(r(9) + 0.3), y0 = 8.55, y1 = 9.5, tn = k.n(16, 6), can = k.mark();
    k.steel(C.transformer, 0.5, 0.3);
    k.lathe([0, 0, cz], Y, [[y0, 0], [y0, 0.22], [y0 + 0.03, 0.25], [y1 - 0.03, 0.25], [y1, 0.265], [y1 + 0.02, 0.265], [y1 + 0.05, 0.2], [y1 + 0.07, 0]], tn, { crease: 40 });
    k.under(can, y1, 0.9, 0.3).grime(can, (x, y) => 0.3 * Math.max(0, 1 - (y - y0) / 0.25), C.rust);
    if (k.mid) {
      for (const y of [y0 + 0.2, y1 - 0.15]) k.box(-0.035, y - 0.03, cz + 0.2, 0.035, y + 0.03, -r(y) + 0.02, { axis: 'z' });   // hangers
      k.plastic(C.porcelain, 0.2);
      for (const sx of [-1, 1]) k.lathe([sx * 0.1, y1 + 0.05, cz], Y, [[0, 0.03], [0.05, 0.045], [0.09, 0.03], [0.13, 0.045], [0.17, 0.02], [0.19, 0]], k.n(8, 5), { crease: 50 });
      k.rubber([0.03, 0.03, 0.03], 0.8);
      k.tube([[0.1, y1 + 0.24, cz], [0.14, y1 + 0.6, cz * 0.8], [0.06, armY - 0.3, -0.7], [0, seats[0][1], seats[0][2]]], 0.008, 4);   // primary drop lead
      if (k.near) { k.steel(C.transformer, 0.5, 0.3); k.box(-0.06, y0 + 0.25, cz - 0.27, 0.06, y0 + 0.45, cz - 0.24); }                // rating plate
    }
  }
}

// ---------------------------------------------------------------- chain-link fence
/**
 * One 3 m bay: terminal posts on both ends (a neighbour's post coincides, so a run reads as single posts), top rail,
 * bottom tension wire and the fabric. There is no alpha-tested material in the solid family, so the fabric is a
 * diamond lattice of flat galvanised ribbons, close to the real mesh at the near level and coarser beyond it;
 * the far level keeps only posts and rail.
 */
function chainLink(k, L, H) {
  const h = L / 2, n = k.n(8, 4);
  k.bare(2, 0.55, C.galv);
  const posts = k.mark();
  for (const x of [-h, h]) { k.cyl([x, 0, 0], [x, H, 0], 0.03, 0.03, n, { capB: true, stops: [0.1] }); if (k.near) k.ellipsoid([x, H, 0], 0.03, 0.02, 0.03, n, 2, { v0: 0, v1: 0.5 }); }      // dome cap, flush with the post so it has no open lip
  k.ground(posts, 0.25, 0.5);
  k.cyl([-h, H - 0.05, 0], [h, H - 0.05, 0], 0.021, 0.021, Math.max(4, n - 2));
  if (k.lod === 2) return;
  k.cyl([-h, 0.06, 0], [h, 0.06, 0], 0.005, 0.005, 3);
  if (k.near) {
    // what holds the fabric: a tension bar laced to each terminal post by bands, tie wires up to the rail
    for (const sx of [-1, 1]) {
      k.box(sx * h - sx * 0.05 - 0.004, 0.06, -0.009, sx * h - sx * 0.05 + 0.004, H - 0.08, -0.003, { r: 0 });
      for (const y of [0.25, 0.75, 1.25, H - 0.3]) k.lathe([sx * h, y - 0.012, 0], Y, [[0, 0.03], [0, 0.034], [0.024, 0.034], [0.024, 0.03]], n, { crease: 60 });
    }
    for (let x = -h + 0.45; x < h - 0.2; x += 0.6) k.cyl([x, H - 0.085, 0.004], [x, H - 0.03, 0.004], 0.0025, 0.0025, 3);
  }
  // the weave: 60 mm diamonds up close (the real fabric is 50 mm), opening up with distance so it never turns to noise
  const pitch = k.near ? 0.085 : 0.26, wd = k.near ? 0.0042 : 0.012, y0 = 0.05, y1 = H - 0.07, span = y1 - y0, m = k.mark(), q = wd * Math.SQRT1_2;
  // ribbons at +45 and -45 degrees, clipped to the bay
  for (const dir of [1, -1]) for (let s = -h - span + pitch / 2; s < h; s += pitch) {
    const xa = Math.max(s, -h), xb = Math.min(s + span, h); if (xb - xa < 0.02) continue;
    const ya = dir > 0 ? y0 + (xa - s) : y1 - (xa - s), yb = dir > 0 ? y0 + (xb - s) : y1 - (xb - s), z = dir * 0.002;
    k.quad([xa + q, ya - dir * q, z], [xb + q, yb - dir * q, z], [xb - q, yb + dir * q, z], [xa - q, ya + dir * q, z]);
  }
  k.b.computeNormals(30, m.v, k.b.count);
  // each ribbon becomes a thin solid strip, so neither side nor its edge ever shows a back face
  k.twoSided(m, null, 0.0015);
  // old fabric: the zinc has gone dull and rust comes up from the bottom selvage and in patches where it was hit
  k.shade(m, (x, y) => 0.75 + 0.25 * Math.min(1, y / 0.5));
  k.grime(m, (x, y) => 0.55 * Math.max(0, 1 - y / 0.45) + 0.5 * Math.max(0, fbm2(x * 1.7 + 9, y * 1.7, 3, 41) - 0.52) * 3, [0.3, 0.19, 0.12]);
}

// ---------------------------------------------------------------- walls
/** Rendered block wall with a projecting coping. */
function wall(k, L, H, T) {
  const h = L / 2, t = T / 2, m = k.mark();
  // two courses: the lower one takes the splash-back from the pavement (darker, more weathered) and carries the
  // contact gradient, which needs vertices at its top edge
  const cuts = k.mid ? [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] : [0.5];
  k.stucco([0.66, 0.63, 0.57], 0.55, 0.75);
  k.box(-h, 0, -t, h, 0.3, t, { axis: 'x', stops: cuts, r: 0 });
  k.ground(m, 0.35, 0.45);
  k.stucco([0.76, 0.73, 0.66], 0.55, 0.6);
  const upper = k.mark();
  k.box(-h, 0.3, -t, h, H - 0.07, t, { axis: 'x', stops: cuts, r: 0 });
  k.under(upper, H - 0.07, 0.12, 0.3);
  // rain carries the dirt off the coping and down the render in broad stains, different on every stretch
  k.grime(upper, (x, y) => (y > H - 0.1 ? 0.55 * Math.max(0, fbm2(x * 0.9 + 3, 0.5, 3, 17) - 0.35) * 2 : 0), [0.3, 0.28, 0.24]);
  k.concrete([0.7, 0.68, 0.62], 0, 0.6);
  k.box(-h + 0.004, H - 0.07, -t - 0.03, h - 0.004, H, t + 0.03, { axis: 'x', r: k.near ? 0.012 : 0 });    // coping stones stop short: a joint shows between segments
}

/** Low promenade sitting wall with a rounded coping and one pier at mid-length (so piers fall every `L` along a run). */
function promenadeWall(k, L) {
  const h = L / 2, t = 0.225, H = 0.5, cream = [0.91, 0.87, 0.78], m = k.mark(), n = k.n(8, 3);
  k.stucco(cream, 0.5, 0.45);
  const top = []; for (let i = 0; i <= n; i++) { const a = i / n * Math.PI; top.push([H - 0.1 + Math.sin(a) * 0.1, Math.cos(a) * (t + 0.02)]); }
  k.extrude([[0, t], [H - 0.1, t], ...top.slice(1, -1), [H - 0.1, -t], [0, -t]].map(([y, z]) => [y, -z]), [-h, 0, 0], Y, Z, L, { crease: 40 });
  if (k.mid) {
    k.box(-0.3, 0, -0.3, 0.3, 0.74, 0.3);
    k.lathe([0, 0.74, 0], Y, [[0, 0.33], [0.04, 0.33], [0.08, 0.22], [0.08, 0]], 4, { crease: 20, up: [1, 0, 1] });   // stepped square cap
  }
  k.ground(m, 0.2, 0.45).grime(m, (x, y, z) => (z < 0 ? 0.3 * Math.max(0, 1 - y / 0.25) : 0), [0.8, 0.74, 0.6]);     // sand drifted against the sea side (-Z)
}

// ---------------------------------------------------------------- guardrail
function guardrail(k, L) {
  const h = L / 2, yc = 0.545;
  // W-beam: an open rolled profile, emitted as a thin solid. Decades of salt air leave the zinc coat a matte grey
  // with no mirror left in it, so the rail is a dull grey steel rather than bright galvanising: as a flat face
  // turned to the road, a reflective finish only mirrors the dark asphalt and reads nearly black from a car.
  k.steel([0.56, 0.58, 0.58], 0.78, 0.3);
  const rail = k.mark();
  const prof = k.mid ? [[-0.155, 0.05], [-0.125, 0.05], [-0.09, 0.13], [-0.045, 0.13], [0, 0.06], [0.045, 0.13], [0.09, 0.13], [0.125, 0.05], [0.155, 0.05]] : [[-0.155, 0.05], [-0.07, 0.13], [0, 0.07], [0.07, 0.13], [0.155, 0.05]];
  k.extrude(prof.map(([y, z]) => [yc + y, z]), [-h, 0, 0], Y, Z, L, { closed: false, crease: 50 });
  k.shade(rail, (x, y, z) => 0.7 + 0.3 * Math.min(1, (z - 0.045) / 0.08));
  // posts with timber blockouts at the quarter points
  for (const x of [-L / 4, L / 4]) {
    k.steel([0.34, 0.33, 0.31], 0.7, 0.55);
    const p = k.mark();
    ibeam(k, [x, 0, -0.1], [x, 0.72, -0.1], 0.1, 0.15, Z, { stops: [0.3] });
    k.ground(p, 0.25, 0.5);
    k.wood(C.timber, 0.85, 0.6); k.box(x - 0.075, yc - 0.17, -0.025, x + 0.075, yc + 0.17, 0.05);
    if (k.near) { k.bare(2, 0.5, C.galv); k.bolt([x, yc, 0.06], Z, 0.016, 0.012); }
  }
  if (k.near) {
    // splice at the downstream end where this rail laps the next: two rows of button-head bolts, the first to rust
    k.steel([0.36, 0.3, 0.26], 0.7, 0.8);
    for (const dx of [-0.16, -0.055]) for (const dy of [-0.08, -0.055, 0.055, 0.08]) k.bolt([h + dx, yc + dy, 0.131], Z, 0.012, 0.01);     // on the flat crowns, seated within the thickness of the steel
    // delineator: a reflector tab standing on one blockout, facing the traffic
    k.plastic([0.78, 0.76, 0.7], 0.3); k.box(-L / 4 - 0.035, yc + 0.168, 0.01, -L / 4 + 0.035, yc + 0.255, 0.018, { r: 0 });
  }
}

// ---------------------------------------------------------------- concrete safety barrier
function jersey(k, L) {
  // Cast in a steel form: the arrises are rounded and each unit stops a few millimetres short of its neighbour, so
  // a run shows its joints. The profile is the usual safety shape: a low vertical toe, a 55 degree slope, a steep face.
  const h = L / 2 - 0.006, m = k.mark(), e = 0.022;
  k.concrete([0.62, 0.61, 0.57], 0, 0.6);
  const side = [[0, 0.3], [0.075 - e * 0.4, 0.3], [0.075 + e, 0.3 - e * 0.7], [0.33 - e * 0.5, 0.125 + e * 0.35], [0.33 + e, 0.125 - e * 0.1], [0.81 - e, 0.075 + e * 0.1], [0.81, 0.075 - e]];
  const prof = k.mid ? side : [[0, 0.3], [0.075, 0.3], [0.33, 0.125], [0.81, 0.075]];
  const cuts = k.near ? [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] : k.mid ? [0.25, 0.5, 0.75] : [];
  k.extrude([...prof.map(([y, z]) => [y, z]), ...prof.slice().reverse().map(([y, z]) => [y, -z])], [-h, 0, 0], Y, Z, 2 * h, { crease: 50, stops: cuts });
  k.ground(m, 0.12, 0.45);
  // road film thrown up onto the toe, black tyre scrubs on the slope where cars have leaned on it, streaks from the top
  k.grime(m, (x, y, z) => 0.3 * Math.max(0, 1 - y / 0.3) + 0.75 * Math.max(0, 1 - Math.abs(y - 0.24) / 0.14) * Math.max(0, fbm2(x * 1.3 + 5 + (z > 0 ? 0 : 40), 0.3, 3, 23) - 0.42) * 2.4, [0.08, 0.08, 0.085]);
  k.grime(m, (x, y) => (y > 0.7 ? 0.4 * Math.max(0, fbm2(x * 2.1, 1.5, 3, 29) - 0.4) * 2 : 0), [0.3, 0.29, 0.26]);
  if (!k.mid) return;
  // drainage scuppers through the toe (dark recesses) and the lifting loops cast into the top
  k.paint([0.03, 0.03, 0.03], 0.9, 0).occ(0.35);
  for (const x of [-h * 0.5, h * 0.5]) for (const sz of [1, -1]) k.panel([x, 0.032, sz * 0.3015], [sz, 0, 0], Y, 0.3, 0.05);     // below the rounded arris: on the flat of the toe
  k.occ(1);
  if (k.near) {
    k.steel([0.3, 0.27, 0.24], 0.7, 0.85);
    for (const x of [-h * 0.62, h * 0.62]) k.tube([[x - 0.06, 0.8, 0], [x - 0.05, 0.825, 0], [x, 0.836, 0], [x + 0.05, 0.825, 0], [x + 0.06, 0.8, 0]], 0.008, 5);
    // pin-and-loop connection: two steel loops stand out of each end face
    for (const sx of [-1, 1]) for (const y of [0.22, 0.6]) k.tube([[sx * h - sx * 0.02, y, -0.035], [sx * (h + 0.005), y, -0.03], [sx * (h + 0.005), y, 0.03], [sx * h - sx * 0.02, y, 0.035]], 0.007, 5);
  }
}

const linear = (name, length, height, half, build, tags, far) => ({ name, build, length, far, footprint: length / 2, collider: { kind: 'box', hx: length / 2, hy: height / 2, hz: half }, tags: ['linear', ...tags] });

export const UTILITY = [
  { name: 'power_pole', far: [50, 180, 700], footprint: 0.4, collider: { kind: 'cylinder', radius: 0.17, height: 11.2 }, tags: ['utility', 'tall', 'large'], build: (k) => powerPole(k, true) },
  { name: 'power_pole_plain', far: [50, 180, 700], footprint: 0.4, collider: { kind: 'cylinder', radius: 0.17, height: 11.2 }, tags: ['utility', 'tall', 'large'], build: (k) => powerPole(k, false) },
  linear('fence_chain_seg', 3.0, 2.1, 0.05, (k) => chainLink(k, 3.0, 2.1), ['fence', 'small'], [22, 60, 200]),
  linear('wall_seg', 4.0, 1.8, 0.13, (k) => wall(k, 4.0, 1.8, 0.2), ['wall', 'large'], [40, 200]),
  linear('wall_low_seg', 6.0, 0.5, 0.25, (k) => promenadeWall(k, 6.0), ['wall', 'beach', 'small'], [40, 160]),
  linear('guardrail_seg', 3.81, 0.72, 0.15, (k) => guardrail(k, 3.81), ['barrier', 'small'], [35, 140]),
  linear('barrier_jersey', 3.0, 0.81, 0.3, (k) => jersey(k, 3.0), ['barrier', 'small'], [40, 160]),
];
