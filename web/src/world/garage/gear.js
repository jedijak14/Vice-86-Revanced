// Workshop gear: the things on the floor and on the walls that say what the room is for. Each builder makes one
// thing in its own frame, standing on y = 0 with its back to the wall at z = 0 and its front towards +z (wall-hung
// things: the wall face is z = 0 and the origin is where they are fixed), at real sizes: a car tyre is 0.63 m
// across, an oil drum 0.57 by 0.85 m, a trolley jack two thirds of a metre long.

import { vadd, vmad, vsub, vnorm, vcross, perpendicular } from '../props/kit.js';

const CHROME = [0.82, 0.83, 0.85], BRASS = [0.72, 0.6, 0.34], ZINC = [0.6, 0.61, 0.62], BLACK = [0.04, 0.04, 0.043];
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];

// ------------------------------------------------------------------------------------------------ tyres
export const TYRE = Object.freeze({ r: 0.315, w: 0.205, bead: 0.19 });

/** A tyre's section as [distance along the axis from one sidewall, radius], round from bead to bead. */
function tyreSection(detail) {
  const { r, w, bead } = TYRE;
  const profile = [[0.032, bead], [0.01, bead + 0.028], [0, bead + 0.07], [0.008, r - 0.035], [0.03, r - 0.006]];
  if (detail > 0) for (const f of [0.28, 0.5, 0.72]) { const h = 0.03 + (w - 0.06) * f; profile.push([h - 0.005, r], [h - 0.0035, r - 0.007], [h + 0.0035, r - 0.007], [h + 0.005, r]); }
  profile.push([w - 0.03, r - 0.006], [w - 0.008, r - 0.035], [w, bead + 0.07], [w - 0.01, bead + 0.028], [w - 0.032, bead], [0.032, bead]);
  return profile;
}

/** A car tyre without a wheel: centre c, unit axis. The tread is cut by three grooves when there is detail for it. */
export function tyre(k, c, axis, worn = 0) {
  const { w, bead } = TYRE, A = vnorm(axis), m = k.mark(), profile = tyreSection(k.detail);
  const tone = 0.05 + worn * 0.03;
  k.rubber([tone, tone, tone * 1.03], 0.92);
  k.lathe(vmad(c, A, -w / 2), A, profile, k.n(26, 14), { crease: 40 });
  // the inside of the casing sees almost nothing of the room
  k.shade(m, (x, y, z) => { const d = vsub([x, y, z], c), along = d[0] * A[0] + d[1] * A[1] + d[2] * A[2]; return Math.hypot(d[0] - A[0] * along, d[1] - A[1] * along, d[2] - A[2] * along) < bead + 0.012 ? 0.3 : 1; });
  return k;
}

/** Tyres laid flat on one another, none quite square on the one below. `offsets`: [dx, dz] per tyre. */
export function tyreStack(k, offsets) {
  offsets.forEach(([dx, dz], i) => tyre(k, [dx, TYRE.w / 2 + i * (TYRE.w + 0.002), TYRE.r + 0.03 + dz], Y, i % 2));
  return k;
}

/** A tyre stood on its tread and leant back against the wall. */
export function tyreLeaning(k, x, lean = 0.24) {
  // the shoulders are rounded, so where it meets the floor and the wall is read off its section, not its radius
  const s = Math.sin(lean), c = Math.cos(lean), half = TYRE.w / 2, section = tyreSection(k.detail);
  const below = Math.max(...section.map(([h, q]) => q * c - (h - half) * s)), behind = Math.max(...section.map(([h, q]) => q * s - (h - half) * c));
  return tyre(k, [x, below, behind + 0.004], [0, s, c], 1);
}

// ------------------------------------------------------------------------------------------------ oil drum
/** A 200 litre steel drum standing at the origin. `pump`: a rotary hand pump in the bung; otherwise a funnel. */
export function drum(k, color, pump = false) {
  const m = k.mark(), R = 0.283, H = 0.851;
  k.steel(color, 0.45, 0.4);
  k.lathe([0, 0, 0], Y, [[0.012, 0], [0.012, R - 0.012], [0, R - 0.01], [0, R + 0.005], [0.022, R + 0.005], [0.03, R], [0.27, R], [0.279, R + 0.009], [0.297, R + 0.009], [0.306, R],
    [0.545, R], [0.554, R + 0.009], [0.572, R + 0.009], [0.581, R], [H - 0.03, R], [H - 0.022, R + 0.005], [H, R + 0.005], [H, R - 0.01], [H - 0.016, R - 0.012], [H - 0.016, 0]], k.n(28, 14), { crease: 32 });
  k.ground(m, 0.2, 0.35);
  k.shade(m, (x, y, z) => (y > H - 0.02 && Math.hypot(x, z) < R - 0.011 ? 0.7 + 0.3 * Math.hypot(x, z) / R : 1));     // the recessed head
  const top = H - 0.016;
  k.bare(2, 0.5, ZINC);
  k.lathe([-0.17, top, 0.05], Y, [[0, 0.036], [0.01, 0.036], [0.012, 0.03], [0.012, 0.012], [0.006, 0.012], [0.006, 0]], 10, { crease: 30 });      // the small bung
  if (pump) {
    const b = [0.17, top, 0];
    k.cyl(b, vadd(b, [0, 0.03, 0]), 0.034, 0.034, 10, { capB: true });
    k.steel([0.5, 0.08, 0.06], 0.5, 0.35);
    k.cyl(vadd(b, [0, 0.03, 0]), vadd(b, [0, 0.36, 0]), 0.017, 0.017, 8);
    k.lathe(vadd(b, [0, 0.36, 0.05]), [0, 0, -1], [[0, 0], [0, 0.062], [0.07, 0.062], [0.085, 0.05], [0.085, 0]], 12, { crease: 40 });      // the pump body, a flat round casting
    k.tube([vadd(b, [0, 0.41, 0]), vadd(b, [0, 0.44, -0.04]), vadd(b, [0, 0.42, -0.2]), vadd(b, [0, 0.3, -0.25])], 0.014, 8, { capB: true });  // the spout
    k.bare(2, 0.5, ZINC);
    k.bar(vadd(b, [0, 0.36, 0.055]), vadd(b, [0.12, 0.3, 0.055]), 0.02, 0.008, { up: Z, r: 0.002 });               // the crank
    k.rubber(BLACK, 0.7); k.cyl(vadd(b, [0.12, 0.3, 0.058]), vadd(b, [0.12, 0.3, 0.14]), 0.013, 0.013, 8, { capB: true });
  } else {
    k.lathe([0.17, top, 0], Y, [[0, 0.036], [0.012, 0.036], [0.012, 0]], 10, { crease: 30 });
    // a tin funnel left standing in the head, its rim rolled
    const f = [0.02, top, -0.09];
    k.bare(2, 0.55, [0.66, 0.67, 0.68]);
    k.lathe(f, Y, [[0, 0.012], [0.07, 0.015], [0.19, 0.105], [0.2, 0.108], [0.2, 0.102], [0.19, 0.099], [0.072, 0.011], [0, 0.008], [0, 0.012]], k.n(16, 10), { crease: 40 });
  }
  return k;
}

// ------------------------------------------------------------------------------------------------ trolley jack
/** A garage trolley jack: its length runs along +z from the handle end (z = 0) to the saddle; the handle stands up. */
export function trolleyJack(k) {
  const m = k.mark(), paint = [0.07, 0.16, 0.38], hw = 0.15;
  const side = [[0, 0.045], [0, 0.15], [0.22, 0.158], [0.63, 0.075], [0.66, 0.04], [0.5, 0.036], [0.46, 0.045]];
  k.steel(paint, 0.45, 0.4);
  for (const x of [hw, -hw + 0.006]) k.extrude(side, [x, 0, 0], Z, Y, 0.006);
  k.box(-hw + 0.004, 0.15, 0, hw - 0.004, 0.156, 0.21, { r: 0.002 });                                                  // the cover over the pump
  k.box(-hw + 0.004, 0.046, 0.004, hw - 0.004, 0.052, 0.45, { r: 0 });                                                 // the floor plate that ties the sides
  k.bar([0, 0.118, 0.2], [0, 0.112, 0.585], 0.1, 0.045, { up: Y, r: 0.006 });                                           // the lifting arm
  k.steel([0.1, 0.1, 0.105], 0.5, 0.3);
  k.cyl([0, 0.1, 0.012], [0, 0.1, 0.2], 0.046, 0.046, k.n(14, 8), { capA: true, capB: true });                          // the hydraulic unit
  k.lathe([0, 0.134, 0.575], Y, [[0, 0.03], [0.012, 0.05], [0.03, 0.056], [0.03, 0.046], [0.02, 0.04], [0.02, 0]], k.n(14, 8), { crease: 40 });   // the saddle
  k.bare(2, 0.5, ZINC);
  k.cyl([-hw - 0.062, 0.04, 0.62], [hw + 0.062, 0.04, 0.62], 0.011, 0.011, 8, { capA: true, capB: true });
  for (const s of [-1, 1]) {
    k.bare(2, 0.55, [0.5, 0.5, 0.51]);
    k.cyl([s * (hw + 0.008), 0.04, 0.62], [s * (hw + 0.058), 0.04, 0.62], 0.04, 0.04, k.n(14, 8), { capA: true, capB: true });      // front rollers
    // rear castors on outriggers: a plate, a swivel fork and a small steel wheel
    k.steel(paint, 0.45, 0.4);
    k.box(Math.min(s * hw, s * (hw + 0.075)), 0.082, 0.02, Math.max(s * hw, s * (hw + 0.075)), 0.09, 0.1, { r: 0.002 });
    k.steel([0.1, 0.1, 0.105], 0.5, 0.3);
    for (const d of [-0.016, 0.016]) k.box(s * (hw + 0.04) + d - 0.002, 0.03, 0.04, s * (hw + 0.04) + d + 0.002, 0.082, 0.085, { r: 0 });
    k.bare(2, 0.55, [0.5, 0.5, 0.51]);
    k.cyl([s * (hw + 0.04) - 0.012, 0.03, 0.055], [s * (hw + 0.04) + 0.012, 0.03, 0.055], 0.03, 0.03, 10, { capA: true, capB: true });
  }
  // the handle: a yoke on the pump and a two-piece tube that stays where it is left, a hand's breadth off upright
  const foot = [0, 0.16, 0.03], dir = vnorm([0, 1, -0.3]);
  k.steel([0.1, 0.1, 0.105], 0.5, 0.3);
  k.box(-0.035, 0.1, 0.0, 0.035, 0.19, 0.06, { r: 0.006 });
  k.bare(2, 0.45, [0.55, 0.56, 0.57]);
  k.cyl(foot, vmad(foot, dir, 0.92), 0.016, 0.016, 10);
  k.cyl(vmad(foot, dir, 0.44), vmad(foot, dir, 0.47), 0.019, 0.019, 10, { capA: true, capB: true });                    // the joint's collar
  k.rubber(BLACK, 0.8);
  k.cyl(vmad(foot, dir, 0.92), vmad(foot, dir, 1.06), 0.021, 0.021, 10, { capA: true, capB: true });
  k.ground(m, 0.12, 0.4);
  return k;
}

// ------------------------------------------------------------------------------------------------ creeper
/** A mechanic's creeper lying on its castors, its length along x with the headrest at +x. */
export function creeper(k) {
  const m = k.mark();
  k.steel([0.09, 0.09, 0.095], 0.5, 0.3);
  for (const z of [-0.19, 0.19]) k.bar([-0.49, 0.075, z], [0.49, 0.075, z], 0.025, 0.025, { up: Y });
  for (const x of [-0.47, 0, 0.47]) k.bar([x, 0.075, -0.19], [x, 0.075, 0.19], 0.025, 0.025, { up: Y, capA: false, capB: false });
  for (const x of [-0.44, 0, 0.44]) for (const z of [-0.19, 0.19]) {
    k.steel([0.09, 0.09, 0.095], 0.5, 0.3);
    k.cyl([x, 0.0625, z], [x, 0.05, z], 0.014, 0.014, 8, { capA: true });
    for (const d of [-0.014, 0.014]) k.box(x - 0.02, 0.018, z + d - 0.0015, x + 0.012, 0.052, z + d + 0.0015, { r: 0 });
    k.box(x - 0.02, 0.049, z - 0.0155, x + 0.016, 0.052, z + 0.0155, { r: 0 });                      // the fork's bridge under the swivel
    k.plastic([0.07, 0.07, 0.072], 0.5);
    k.cyl([x - 0.006, 0.025, z - 0.011], [x - 0.006, 0.025, z + 0.011], 0.025, 0.025, 10, { capA: true, capB: true });
  }
  // the vinyl pad in three cushions and a raised headrest
  k.plastic([0.11, 0.025, 0.028], 0.42);
  for (const [x0, x1] of [[-0.5, -0.2], [-0.19, 0.11], [0.12, 0.31]]) k.box(x0, 0.088, -0.215, x1, 0.128, 0.215, { r: 0.014, axis: 'x' });
  k.box(0.32, 0.088, -0.19, 0.5, 0.17, 0.19, { r: 0.022, axis: 'x' });
  k.ground(m, 0.1, 0.45);
  return k;
}

// ------------------------------------------------------------------------------------------------ compressor
/** A workshop compressor: a horizontal receiver on two wheels and a foot, motor and pump side by side on top. */
export function compressor(k) {
  const m = k.mark(), cz = 0.27, cy = 0.44, R = 0.2, tank = [0.09, 0.2, 0.36], n = k.n(22, 12);
  k.steel(tank, 0.4, 0.3);
  k.lathe([-0.47, cy, cz], X, [[0, 0], [0.012, 0.09], [0.04, 0.15], [0.09, 0.19], [0.14, R], [0.8, R], [0.85, 0.19], [0.9, 0.15], [0.928, 0.09], [0.94, 0]], n, { crease: 36 });
  for (const h of [0.14, 0.8]) k.lathe([-0.47 + h, cy, cz], X, [[-0.006, R - 0.002], [-0.006, R + 0.003], [0.006, R + 0.003], [0.006, R - 0.002]], n, { crease: 36 });   // the weld seams
  // deck and saddles
  k.box(-0.36, cy + R + 0.02, cz - 0.17, 0.34, cy + R + 0.028, cz + 0.17, { r: 0.002 });
  for (const x of [-0.3, 0.28]) k.box(x - 0.015, cy + R - 0.03, cz - 0.12, x + 0.015, cy + R + 0.021, cz + 0.12, { r: 0 });
  const deck = cy + R + 0.028;
  // wheels at the heavy end, a foot at the other, a pulling handle
  k.box(-0.33, 0.085, cz - 0.03, -0.27, cy - R + 0.03, cz + 0.03, { r: 0 });                       // the axle bracket, down past the axle
  k.box(0.29, 0.012, cz - 0.03, 0.33, cy - R + 0.03, cz + 0.03, { r: 0 });
  k.tube([[0.36, cy + R - 0.06, cz - 0.15], [0.56, cy + R + 0.1, cz - 0.15], [0.59, cy + R + 0.11, cz - 0.12], [0.59, cy + R + 0.11, cz + 0.12], [0.56, cy + R + 0.1, cz + 0.15], [0.36, cy + R - 0.06, cz + 0.15]], 0.012, 8, { capA: true, capB: true });
  k.bare(2, 0.5, ZINC);
  k.cyl([-0.3, 0.1, cz - 0.27], [-0.3, 0.1, cz + 0.27], 0.011, 0.011, 8, { capA: true, capB: true });
  for (const s of [-1, 1]) {
    k.rubber(BLACK, 0.85);
    k.lathe([-0.3, 0.1, cz + s * 0.215], [0, 0, s], [[0, 0.06], [0, 0.092], [0.006, 0.1], [0.04, 0.1], [0.046, 0.092], [0.046, 0.06]], k.n(18, 10), { crease: 35 });
    k.steel([0.55, 0.55, 0.56], 0.5, 0.3);
    // a dished face outwards and a flat one towards the tank: the wheel is seen from both sides
    k.lathe([-0.3, 0.1, cz + s * 0.215], [0, 0, s], [[0, 0], [0, 0.06], [0.046, 0.06], [0.04, 0.02], [0.04, 0]], k.n(18, 10), { crease: 35 });
  }
  k.rubber(BLACK, 0.85); k.box(0.275, 0, cz - 0.04, 0.345, 0.014, cz + 0.04, { r: 0.004 });
  // motor, shaft towards the front: a finned barrel between two end bells, its terminal box on top
  const mx = -0.2, my = deck + 0.105;
  k.steel([0.33, 0.35, 0.36], 0.5, 0.3);
  const fins = [[0, 0], [0, 0.06], [0.02, 0.082], [0.03, 0.086]];
  for (let i = 0; i < 6; i++) { const h = 0.04 + i * 0.027; fins.push([h, 0.086], [h, 0.094], [h + 0.009, 0.094], [h + 0.009, 0.086]); }
  fins.push([0.21, 0.086], [0.22, 0.082], [0.24, 0.06], [0.24, 0.014], [0.27, 0.014], [0.27, 0]);
  k.lathe([mx, my, cz - 0.16], Z, fins, k.n(16, 10), { crease: 36 });
  k.box(mx - 0.045, my + 0.08, cz - 0.09, mx + 0.045, my + 0.125, cz + 0.02, { r: 0.006 });
  k.box(mx - 0.08, deck, cz - 0.12, mx + 0.08, deck + 0.02, cz + 0.06, { r: 0.003 });
  // pump: crankcase, a finned cylinder with its head, the intake filter
  const px = 0.14, py = deck + 0.075;
  k.steel([0.33, 0.35, 0.36], 0.5, 0.3);
  k.box(px - 0.08, deck, cz - 0.14, px + 0.08, deck + 0.15, cz + 0.07, { r: 0.012 });
  const barrel = [[0, 0.05]];
  for (let i = 0; i < 6; i++) { const h = 0.006 + i * 0.02; barrel.push([h, 0.05], [h, 0.064], [h + 0.008, 0.064], [h + 0.008, 0.05]); }
  barrel.push([0.126, 0.05]);
  k.lathe([px, deck + 0.15, cz - 0.035], Y, barrel, k.n(14, 8), { crease: 36 });
  k.box(px - 0.065, deck + 0.276, cz - 0.1, px + 0.065, deck + 0.312, cz + 0.03, { r: 0.006 });
  for (const [dx, dz] of [[-0.05, -0.085], [0.05, -0.085], [-0.05, 0.015], [0.05, 0.015]]) k.bolt([px + dx, deck + 0.312, cz + dz], Y, 0.008, 0.006);
  k.plastic(BLACK, 0.6); k.cyl([px + 0.065, deck + 0.294, cz - 0.035], [px + 0.13, deck + 0.294, cz - 0.035], 0.032, 0.032, 12, { capA: true, capB: true });
  // belt guard across the front, covering both pulleys
  const guard = [], hull = (c, r, a0, a1, steps) => { for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * i / steps; guard.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); } };
  const tilt = Math.asin((0.135 - 0.06) / (px - mx));
  hull([px, py], 0.135, -Math.PI / 2 - tilt, Math.PI / 2 + tilt, k.n(12, 7)); hull([mx, my], 0.06, Math.PI / 2 + tilt, Math.PI * 1.5 - tilt, k.n(8, 5));
  k.steel([0.07, 0.07, 0.075], 0.5, 0.3);
  k.extrude(guard, [0, 0, cz + 0.085], X, Y, 0.06, { crease: 40 });
  for (const c of [[px, py], [mx, my]]) k.bolt([c[0], c[1], cz + 0.145], Z, 0.009, 0.005);
  // pressure switch, two gauges, the copper delivery pipe and the drain
  const sx = -0.4;
  k.plastic([0.08, 0.08, 0.085], 0.5); k.box(sx - 0.04, deck + 0.03, cz - 0.045, sx + 0.04, deck + 0.13, cz + 0.045, { r: 0.008 });
  k.bare(1, 0.45, BRASS); k.cyl([sx, cy + 0.15, cz], [sx, deck + 0.03, cz], 0.012, 0.012, 8);
  k.cyl([sx, deck + 0.012, cz], [sx, deck + 0.012, cz + 0.12], 0.008, 0.008, 6, { capB: true });
  for (const dx of [-0.045, 0.045]) gauge(k, [sx + dx, deck + 0.05, cz + 0.12], Z, 0.03);
  k.bare(1, 0.45, [0.72, 0.42, 0.26]);
  k.tube([[px - 0.02, deck + 0.312, cz - 0.07], [px - 0.02, deck + 0.35, cz - 0.07], [px - 0.1, deck + 0.36, cz - 0.1], [-0.02, deck + 0.2, cz - 0.15], [-0.02, deck + 0.03, cz - 0.15], [-0.02, cy + R * 0.86, cz - 0.1]], 0.006, 6);
  k.bare(1, 0.45, BRASS); k.cyl([0.2, cy - R + 0.004, cz], [0.2, cy - R - 0.03, cz], 0.008, 0.008, 6, { capB: true });
  k.shade(m, (x, y, z) => (y < cy ? 0.55 + 0.45 * Math.min(1, y / (cy - 0.05)) : 1) * (y > deck && y < deck + 0.12 ? 0.8 : 1));
  return k;
}

/** A round dial gauge facing along `axis`: black case, white face, a needle. */
export function gauge(k, c, axis, r) {
  const A = vnorm(axis), U = perpendicular(A, Y), R = vcross(U, A);
  k.plastic(BLACK, 0.4);
  k.lathe(c, A, [[0, 0], [0, r], [0.022, r], [0.022, r - 0.004], [0.017, r - 0.004]], 12, { crease: 40 });
  k.plastic([0.82, 0.81, 0.76], 0.5);
  k.lathe(vmad(c, A, 0.017), A, [[0, r - 0.004], [0, 0]], 12);
  k.plastic([0.6, 0.06, 0.04], 0.5);
  k.bar(vmad(c, A, 0.0185), vadd(vmad(c, A, 0.0185), vadd(vmad([0, 0, 0], U, r * 0.5), vmad([0, 0, 0], R, r * 0.45))), 0.003, 0.001, { up: A, r: 0 });
  return k;
}

// ------------------------------------------------------------------------------------------------ hose reel
/** A wall hose reel: axis along x, the reel 0.2 m off the wall, a length of hose hanging from it. */
export function hoseReel(k) {
  const m = k.mark(), c = [0, 0, 0.21], n = k.n(22, 12);
  k.steel([0.5, 0.08, 0.06], 0.45, 0.35);
  k.box(-0.11, -0.12, 0, 0.11, 0.12, 0.006, { r: 0.002 });
  for (const s of [-1, 1]) {
    k.bar([s * 0.092, 0, 0.004], [s * 0.092, 0, c[2]], 0.006, 0.045, { up: Y, r: 0.002 });
    k.lathe([s * 0.068, 0, c[2]], [s, 0, 0], [[0, 0.03], [0, 0.2], [0.004, 0.204], [0.008, 0.2], [0.006, 0.03], [0, 0.03]], n, { crease: 40 });
  }
  k.bare(2, 0.5, ZINC);
  k.cyl([-0.1, 0, c[2]], [0.1, 0, c[2]], 0.014, 0.014, 8, { capA: true, capB: true });
  // hub bosses fill the bore of each flange, so the drum is never seen into
  for (const s of [-1, 1]) k.cyl([s * 0.062, 0, c[2]], [s * 0.084, 0, c[2]], 0.034, 0.034, 12, { capA: true, capB: true });
  for (const [x, y] of [[-0.08, -0.09], [0.08, -0.09], [-0.08, 0.09], [0.08, 0.09]]) k.bolt([x, y, 0.006], Z, 0.008, 0.005);
  // the wound hose: five turns side by side
  const hose = [0.42, 0.07, 0.05], wound = [[0, 0.1], [0, 0.136]];
  for (let i = 0; i < 5; i++) { const h = 0.004 + i * 0.0256; wound.push([h + 0.004, 0.146], [h + 0.0128, 0.15], [h + 0.0216, 0.146], [h + 0.0256, 0.136]); }
  wound.push([0.136, 0.1]);
  k.rubber(hose, 0.7);
  k.lathe([-0.068, 0, c[2]], X, wound, n, { crease: 50 });
  // the free end: off the bottom of the reel, through a guide, hanging with its coupling
  k.tube([[0.03, -0.146, c[2] + 0.02], [0.034, -0.26, c[2] + 0.05], [0.03, -0.42, c[2] + 0.035], [0.03, -0.62, c[2] + 0.03]], 0.0125, 8);
  k.rubber(BLACK, 0.8); k.ellipsoid([0.03, -0.6, c[2] + 0.03], 0.028, 0.028, 0.028, 10, 6);
  k.bare(1, 0.4, BRASS); k.cyl([0.03, -0.62, c[2] + 0.03], [0.03, -0.69, c[2] + 0.03], 0.011, 0.011, 8, { capB: true });
  k.shade(m, (x, y, z) => 0.7 + 0.3 * Math.min(1, z / 0.2));
  return k;
}

// ------------------------------------------------------------------------------------------------ wall fan
/** A wall-mounted workshop fan: bracket at the origin, a 0.46 m guard tipped down towards the floor. */
export function wallFan(k) {
  const m = k.mark(), A = vnorm([0, -0.3, 1]), U = perpendicular(A, Y), R = vcross(U, A), o = [0, 0.02, 0.13];
  const at = (h, r, a) => vadd(vmad(o, A, h), vadd(vmad([0, 0, 0], R, Math.cos(a) * r), vmad([0, 0, 0], U, Math.sin(a) * r)));
  k.steel([0.1, 0.1, 0.105], 0.5, 0.3);
  k.box(-0.06, -0.1, 0, 0.06, 0.1, 0.008, { r: 0.002 });
  for (const y of [-0.075, 0.075]) k.bolt([0, y, 0.008], Z, 0.009, 0.006);
  k.tube([[0, -0.05, 0.006], [0, -0.05, 0.1], [0, -0.03, 0.14], vmad(o, A, 0.06)], 0.014, 8);
  k.steel([0.2, 0.21, 0.22], 0.45, 0.2);
  k.lathe(o, A, [[0, 0], [0.006, 0.045], [0.03, 0.066], [0.12, 0.066], [0.15, 0.042], [0.168, 0.02], [0.168, 0]], k.n(16, 10), { crease: 36 });
  // hub and three pitched blades
  k.plastic([0.07, 0.07, 0.075], 0.4);
  k.lathe(vmad(o, A, 0.168), A, [[0, 0.03], [0.05, 0.03], [0.06, 0.02], [0.06, 0]], 12, { crease: 36 });
  const outline = [[0.025, -0.02], [0.09, -0.07], [0.17, -0.085], [0.205, -0.03], [0.2, 0.04], [0.14, 0.06], [0.03, 0.02]];
  for (let i = 0; i < 3; i++) {
    const a = i / 3 * Math.PI * 2 + 0.4, radial = vsub(at(0, 1, a), at(0, 0, a)), tangent = vsub(at(0, 1, a + Math.PI / 2), at(0, 0, a)), pitched = vnorm(vmad(tangent, A, 0.45));
    k.extrude(outline, at(0.2, 0, a), radial, pitched, 0.003, { crease: 50 });
  }
  // guards: two rims and wires dished front and back, a bright cap in the middle
  const wires = k.n(28, 14), rimR = 0.23;
  k.bare(0, 0.3, CHROME);
  const circle = (h, r) => { const pts = []; for (let i = 0; i <= 24; i++) pts.push(at(h, r, i / 24 * Math.PI * 2)); return pts; };
  k.tube(circle(0.185, rimR), 0.0045, 4); k.tube(circle(0.215, rimR), 0.0045, 4);
  k.tube(circle(0.262, 0.12), 0.002, 3);
  for (let i = 0; i < wires; i++) {
    const a = i / wires * Math.PI * 2;
    k.tube([at(0.275, 0.04, a), at(0.268, 0.1, a), at(0.25, 0.18, a), at(0.215, rimR, a)], 0.0016, 3);
    k.tube([at(0.185, rimR, a), at(0.155, 0.18, a), at(0.135, 0.1, a), at(0.13, 0.066, a)], 0.0016, 3);
  }
  k.lathe(vmad(o, A, 0.27), A, [[0, 0.045], [0.008, 0.042], [0.012, 0.03], [0.012, 0]], 12, { crease: 36 });
  k.shade(m, (x, y, z) => { const d = vsub([x, y, z], o), h = d[0] * A[0] + d[1] * A[1] + d[2] * A[2]; return h > 0.19 && h < 0.24 && Math.hypot(d[0] - A[0] * h, d[1] - A[1] * h, d[2] - A[2] * h) < 0.21 ? 0.55 : 1; });
  return k;
}

// ------------------------------------------------------------------------------------------------ wall clock
/** A shop wall clock, 0.36 m across, at ten past ten: spun rim, printed face with baton marks, a glass. */
export function wallClock(k) {
  const R = 0.18, n = k.n(28, 16);
  k.bare(0, 0.3, CHROME);
  k.lathe([0, 0, 0], Z, [[0, 0], [0, R], [0.03, R], [0.045, R - 0.012], [0.045, R - 0.022], [0.03, R - 0.026]], n, { crease: 36 });
  k.plastic([0.8, 0.79, 0.73], 0.6);
  k.lathe([0, 0, 0.03], Z, [[0, R - 0.026], [0, 0]], n);
  k.plastic([0.06, 0.06, 0.065], 0.5);
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2, d = [Math.sin(a), Math.cos(a), 0], long = i % 3 === 0;
    k.bar(vmad([0, 0, 0.0306], d, R - 0.04 - (long ? 0.03 : 0.016)), vmad([0, 0, 0.0306], d, R - 0.04), long ? 0.01 : 0.005, 0.0012, { up: Z, r: 0 });
  }
  const hand = (a, len, w, z) => { const d = [Math.sin(a), Math.cos(a), 0]; k.bar(vmad([0, 0, z], d, -len * 0.14), vmad([0, 0, z], d, len), w, 0.0014, { up: Z, r: 0 }); };
  hand(-Math.PI / 3 + 0.09, 0.075, 0.009, 0.034); hand(Math.PI / 3, 0.115, 0.006, 0.036);
  k.plastic([0.6, 0.06, 0.04], 0.5); hand(Math.PI * 1.08, 0.125, 0.002, 0.038);
  k.bare(0, 0.3, CHROME); k.cyl([0, 0, 0.03], [0, 0, 0.041], 0.007, 0.007, 8, { capB: true });
  k.clearGlass();
  k.lathe([0, 0, 0.043], Z, [[0, R - 0.022], [0, 0]], n);
  return k;
}

// ------------------------------------------------------------------------------------------------ small wall things
/** A fire extinguisher on its bracket: wall face z = 0, origin at the foot of the cylinder. */
export function extinguisher(k) {
  const m = k.mark(), c = [0, 0, 0.075];
  k.steel([0.58, 0.05, 0.04], 0.35, 0.15);
  k.lathe(c, Y, [[0, 0], [0, 0.058], [0.008, 0.065], [0.36, 0.065], [0.4, 0.052], [0.425, 0.026], [0.44, 0.02], [0.44, 0]], k.n(16, 10), { crease: 36 });
  k.bare(1, 0.4, BRASS); k.cyl(vadd(c, [0, 0.44, 0]), vadd(c, [0, 0.47, 0]), 0.016, 0.016, 8, { capB: true });
  k.steel([0.07, 0.07, 0.075], 0.5, 0.2);
  k.bar(vadd(c, [0, 0.475, -0.02]), vadd(c, [0, 0.5, 0.085]), 0.022, 0.007, { up: Y, r: 0.002 });                       // lever
  k.bar(vadd(c, [0, 0.462, -0.02]), vadd(c, [0, 0.455, 0.075]), 0.022, 0.007, { up: Y, r: 0.002 });                     // carrying handle
  k.rubber(BLACK, 0.8);
  k.tube([vadd(c, [0.016, 0.455, 0]), vadd(c, [0.075, 0.44, 0.01]), vadd(c, [0.085, 0.3, 0.02]), vadd(c, [0.072, 0.12, 0.03])], 0.009, 6, { capB: true });
  gauge(k, vadd(c, [-0.016, 0.45, 0.012]), [-0.6, 0, 0.8], 0.014);
  k.bare(2, 0.5, ZINC);
  k.box(-0.03, 0.1, 0, 0.03, 0.4, 0.004, { r: 0 });
  k.tube([[-0.066, 0.3, 0.07], [-0.066, 0.3, 0.012], [0.066, 0.3, 0.012], [0.066, 0.3, 0.07]], 0.004, 4, { capA: true, capB: true });
  k.shade(m, (x, y, z) => 0.75 + 0.25 * Math.min(1, z / 0.08));
  return k;
}

/** A folding aluminium stepladder shut and leant against the wall, feet 0.42 m out. */
export function stepladder(k) {
  const m = k.mark(), H = 1.86, out = 0.42, top = [0, H, 0.03], alu = [0.7, 0.71, 0.72];
  k.bare(1, 0.5, alu);
  for (const s of [-1, 1]) {
    k.bar([s * 0.24, 0.006, out], [s * 0.17, top[1], top[2]], 0.024, 0.07, { up: [0, 0.2, 1], r: 0.003 });
    k.bar([s * 0.225, 0.006, out - 0.075], [s * 0.165, top[1] - 0.06, top[2] - 0.004 + 0.03], 0.02, 0.03, { up: [0, 0.2, 1], r: 0.002 });   // the back frame folded against it
  }
  for (let i = 1; i <= 6; i++) {
    const t = i / 7, y = 0.006 + (H - 0.006) * t, z = out + (top[2] - out) * t, w = 0.24 + (0.17 - 0.24) * t;
    k.box(-w + 0.012, y - 0.012, z - 0.04, w - 0.012, y + 0.012, z + 0.04, { r: 0.003, axis: 'x' });
  }
  k.plastic([0.55, 0.09, 0.06], 0.5);
  k.box(-0.19, H - 0.02, top[2] - 0.05, 0.19, H + 0.02, top[2] + 0.075, { r: 0.008, axis: 'x' });
  k.rubber(BLACK, 0.85);
  for (const s of [-1, 1]) k.box(s * 0.24 - 0.016, 0, out - 0.045, s * 0.24 + 0.016, 0.03, out + 0.04, { r: 0.004 });
  k.ground(m, 0.2, 0.3);
  return k;
}

/** A yard broom leant in a corner: head on the floor 0.3 m out, the stick against the wall. */
export function broom(k) {
  const head = [0, 0.085, 0.32], tip = [0.06, 1.42, 0.02];
  k.wood([0.5, 0.36, 0.2], 0.7, 0.5);
  k.cyl(vadd(head, [0, 0.02, 0]), tip, 0.0135, 0.0125, 8, { capB: true });
  k.box(-0.2, 0.06, 0.29, 0.2, 0.105, 0.35, { r: 0.006, axis: 'x' });
  k.fabric([0.16, 0.1, 0.06], 0, 4);
  k.box(-0.195, 0, 0.28, 0.195, 0.062, 0.36, { r: 0.004, axis: 'x' });
  return k;
}

/**
 * A bulkhead lamp, the caged oval kind put over a back door: wall face z = 0. Returns where its light is, in the
 * builder's frame.
 */
export function bulkhead(k, radiance) {
  k.steel([0.1, 0.1, 0.105], 0.5, 0.35);
  k.lathe([0, 0, 0], Z, [[0, 0], [0, 0.085], [0.03, 0.085], [0.036, 0.078], [0.036, 0.06]], k.n(14, 10), { crease: 40 });
  k.lens([1.0, 0.86, 0.6], radiance, 0);
  k.lathe([0, 0, 0.036], Z, [[0, 0.062], [0.05, 0.058], [0.075, 0.04], [0.082, 0]], k.n(14, 10), { crease: 30 });
  k.steel([0.1, 0.1, 0.105], 0.5, 0.35);
  for (let i = 0; i < 4; i++) { const a = i / 4 * Math.PI, c = Math.cos(a), s = Math.sin(a); k.tube([[c * 0.075, s * 0.075, 0.036], [c * 0.07, s * 0.07, 0.075], [c * 0.03, s * 0.03, 0.094], [-c * 0.03, -s * 0.03, 0.094], [-c * 0.07, -s * 0.07, 0.075], [-c * 0.075, -s * 0.075, 0.036]], 0.0035, 4); }
  k.bare(2, 0.5, ZINC); k.cyl([0, 0.085, 0.012], [0, 0.4, 0.012], 0.009, 0.009, 6);                                      // its conduit, up the wall
  return [0, 0, 0.07];
}

/** A steel distribution board with its isolator handle and the conduits that leave it for the roof. */
export function switchboard(k, rise) {
  const m = k.mark();
  k.steel([0.36, 0.38, 0.38], 0.5, 0.3);
  k.box(-0.19, 0, 0, 0.19, 0.56, 0.12, { r: 0.006 });
  k.box(-0.175, 0.015, 0.12, 0.175, 0.545, 0.126, { r: 0.003 });                                                       // the door
  k.box(0.24, 0.2, 0, 0.36, 0.42, 0.09, { r: 0.006 });                                                                  // the isolator beside it
  k.steel([0.55, 0.07, 0.05], 0.45, 0.2);
  k.bar([0.3, 0.33, 0.09], [0.3, 0.41, 0.125], 0.022, 0.016, { up: Z, r: 0.004 });
  k.bare(0, 0.35, CHROME); k.cyl([0.15, 0.28, 0.126], [0.15, 0.28, 0.14], 0.012, 0.012, 8, { capB: true });
  for (const y of [0.1, 0.46]) k.cyl([-0.19, y, 0.1], [-0.2, y, 0.1], 0.008, 0.008, 6, { capB: true });                 // hinge knuckles
  k.bare(2, 0.5, ZINC);
  for (const x of [-0.12, -0.04, 0.04, 0.12]) k.cyl([x, 0.56, 0.05], [x, rise, 0.05], 0.0105, 0.0105, 6);
  k.cyl([0.19, 0.31, 0.045], [0.24, 0.31, 0.045], 0.0105, 0.0105, 6);
  for (let y = 0.95; y < rise; y += 1.0) k.box(-0.15, y - 0.012, 0, 0.15, y + 0.012, 0.064, { r: 0 });                  // conduit saddles' strut
  k.shade(m, (x, y, z) => 0.8 + 0.2 * Math.min(1, z / 0.1));
  return k;
}
