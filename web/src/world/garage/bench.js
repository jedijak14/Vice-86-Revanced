// The workbench corner: a steel-framed bench with a timber top at 0.9 m, a vice on its front corner, a sprung desk
// lamp, the radio, and a pegboard of hand tools on the wall above. Same frame as gear.js: on y = 0, back to the wall
// at z = 0, front towards +z.

import { vadd, vmad, vnorm, vcross } from '../props/kit.js';
import { edges, STEEL } from './setkit.js';
import { paintTin, sprayCan, gallonCan, carton, oilBottle } from './storage.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const CHROME = [0.82, 0.83, 0.85], TOOL = [0.62, 0.63, 0.65], ZINC = [0.6, 0.61, 0.62], BLACK = [0.04, 0.04, 0.043];

export const BENCH = Object.freeze({ w: 2.0, d: 0.7, top: 0.9 });

// ------------------------------------------------------------------------------------------------ vice
/** An engineer's vice bolted down at p (bench top), the screw towards +z, jaws a hand's breadth open. */
function vice(k, p) {
  const at = (x, y, z) => [p[0] + x, p[1] + y, p[2] + z], paint = [0.15, 0.29, 0.44];
  k.steel(paint, 0.55, 0.3);
  k.lathe(at(0, 0, -0.02), Y, [[0, 0.085], [0.012, 0.085], [0.022, 0.07], [0.022, 0]], k.n(16, 10), { crease: 36 });      // the swivel base
  k.box(p[0] - 0.04, p[1] + 0.022, p[2] - 0.085, p[0] + 0.04, p[1] + 0.105, p[2] + 0.04, { r: 0.01 });                   // body
  k.box(p[0] - 0.045, p[1] + 0.105, p[2] - 0.09, p[0] + 0.045, p[1] + 0.122, p[2] - 0.02, { r: 0.004 });                 // anvil
  k.box(p[0] - 0.058, p[1] + 0.1, p[2] - 0.022, p[0] + 0.058, p[1] + 0.15, p[2] + 0.008, { r: 0.006, axis: 'x' });       // fixed jaw
  k.box(p[0] - 0.058, p[1] + 0.05, p[2] + 0.05, p[0] + 0.058, p[1] + 0.15, p[2] + 0.085, { r: 0.006, axis: 'x' });       // moving jaw
  k.box(p[0] - 0.03, p[1] + 0.045, p[2] + 0.085, p[0] + 0.03, p[1] + 0.1, p[2] + 0.13, { r: 0.008 });                    // its nose
  for (const s of [-1, 1]) k.bolt(at(s * 0.068, 0.012, -0.02), Y, 0.011, 0.008);
  k.bare(2, 0.4, TOOL);
  k.bar(at(0, 0.072, -0.07), at(0, 0.072, 0.1), 0.042, 0.036, { up: Y, r: 0.003 });                                      // the slide
  for (const z of [0.008, 0.044]) k.box(p[0] - 0.056, p[1] + 0.126, p[2] + z, p[0] + 0.056, p[1] + 0.15, p[2] + z + 0.006, { r: 0 });   // jaw plates
  k.cyl(at(0, 0.072, 0.13), at(0, 0.072, 0.165), 0.017, 0.017, 10, { capB: true });
  const a = at(-0.1, 0.045, 0.15), b = at(0.085, 0.105, 0.15);
  k.cyl(a, b, 0.006, 0.006, 8);
  for (const e of [a, b]) k.ellipsoid(e, 0.011, 0.011, 0.011, 8, 5);
  return k;
}

// ------------------------------------------------------------------------------------------------ lamp
/**
 * A sprung desk lamp standing at p with its shade over the work at `aim`. Returns { bulb, axis } for the light.
 */
function deskLamp(k, p, aim, radiance) {
  const enamel = [0.72, 0.66, 0.5];
  k.steel([0.06, 0.06, 0.065], 0.4, 0.15);
  k.lathe(p, Y, [[0, 0], [0, 0.085], [0.014, 0.085], [0.022, 0.07], [0.022, 0.016], [0.06, 0.012], [0.06, 0]], k.n(16, 10), { crease: 36 });
  const a = vadd(p, [0, 0.06, 0]), toAim = vnorm([aim[0] - p[0], 0, aim[2] - p[2]]), side = vcross(Y, toAim);
  const b = vadd(a, vadd(vmad([0, 0, 0], toAim, -0.1), [0, 0.4, 0])), c = vadd(b, vadd(vmad([0, 0, 0], toAim, 0.36), [0, 0.1, 0]));
  k.bare(0, 0.3, CHROME);
  for (const s of [-0.014, 0.014]) {
    k.cyl(vmad(a, side, s), vmad(b, side, s), 0.0045, 0.0045, 6);
    k.cyl(vmad(b, side, s), vmad(c, side, s), 0.0045, 0.0045, 6);
    k.cyl(vmad(vadd(a, [0, 0.02, 0]), side, s * 1.9), vmad(vadd(a, vmad(vmad([0, 0, 0], toAim, -0.03), Y, 0.14)), side, s * 1.9), 0.006, 0.006, 6, { capA: true, capB: true });   // springs
  }
  for (const j of [a, b, c]) k.cyl(vmad(j, side, -0.022), vmad(j, side, 0.022), 0.008, 0.008, 8, { capA: true, capB: true });
  // the shade: a spun cone, enamel outside; inside it the lit bulb and its light on the white lining
  const axis = vnorm([aim[0] - c[0], aim[1] - c[1], aim[2] - c[2]]), n = k.n(18, 10);
  k.steel(enamel, 0.35, 0.15);
  k.lathe(c, axis, [[-0.02, 0], [-0.02, 0.02], [0.03, 0.026], [0.055, 0.045], [0.155, 0.095], [0.16, 0.095]], n, { crease: 40 });
  k.lens([1.0, 0.86, 0.66], radiance * 0.16, 0);
  k.lathe(c, axis, [[0.16, 0.095], [0.158, 0.091], [0.058, 0.042], [0.04, 0.03], [0.04, 0]], n, { crease: 40 });
  k.lens([1.0, 0.9, 0.72], radiance, 0);
  const bulb = vmad(c, axis, 0.105);
  k.ellipsoid(bulb, 0.03, 0.03, 0.03, 10, 6);
  k.rubber(BLACK, 0.7);
  // the flex: out of the back of the base and along the foot of the upstand, away behind whatever stands beside the lamp
  k.tube([vadd(p, [0.015, 0.006, -0.055]), vadd(p, [0.07, 0.004, -0.09]), vadd(p, [0.16, 0.004, -0.1]), vadd(p, [0.3, 0.004, -0.1]), vadd(p, [0.58, 0.004, -0.1])], 0.004, 5, { capB: true });
  return { bulb, axis };
}

// ------------------------------------------------------------------------------------------------ radio
/** A two-speaker radio cassette, 0.56 m wide, standing at p facing +z. Its dial is lit; it carries no lettering. */
function radio(k, p) {
  const at = (x, y, z) => [p[0] + x, p[1] + y, p[2] + z], silver = [0.52, 0.53, 0.55], n = k.n(18, 10);
  k.plastic(silver, 0.38);
  k.box(p[0] - 0.28, p[1] + 0.006, p[2] + 0.008, p[0] + 0.28, p[1] + 0.3, p[2] + 0.13, { r: 0.012, axis: 'x' });
  k.plastic([0.05, 0.05, 0.055], 0.5);
  k.box(p[0] - 0.272, p[1] + 0.014, p[2] + 0.13, p[0] + 0.272, p[1] + 0.2, p[2] + 0.134, { r: 0.002, axis: 'x' });        // the dark lower face
  for (const x of [-0.25, 0.25]) k.box(p[0] + x - 0.02, p[1], p[2] + 0.02, p[0] + x + 0.02, p[1] + 0.007, p[2] + 0.12, { r: 0 });
  for (const s of [-1, 1]) {
    // woofer: a bright trim ring round a dished black grille; a tweeter above it
    for (const [cy, r] of [[0.105, 0.086], [0.25, 0.028]]) {
      const c = at(s * 0.182, cy, 0.134);
      k.bare(0, 0.25, CHROME);
      k.lathe(c, Z, [[0, r], [0.007, r], [0.011, r - 0.005], [0.003, r - 0.011], [0, r - 0.011], [0, r]], n, { crease: 40 });
      k.plastic([0.03, 0.03, 0.033], 0.7); k.occ(0.7);
      k.lathe(c, Z, [[0.003, r - 0.011], [0.005, r * 0.62], [0.002, r * 0.58], [0.006, r * 0.3], [0.009, 0]], n, { crease: 40 });
      k.occ(1);
    }
  }
  // cassette door with its two hubs, the lit dial with its needle, a row of knobs, the keys on top
  k.darkGlass([0.07, 0.08, 0.09], 0.1, 0.7);
  k.box(p[0] - 0.078, p[1] + 0.035, p[2] + 0.134, p[0] + 0.078, p[1] + 0.14, p[2] + 0.139, { r: 0.002, axis: 'x' });
  k.plastic([0.78, 0.78, 0.76], 0.5);
  for (const x of [-0.036, 0.036]) k.lathe(at(x, 0.09, 0.139), Z, [[0, 0.014], [0.0015, 0.014], [0.0015, 0]], 10, { crease: 40 });
  k.plastic([0.05, 0.05, 0.055], 0.5);
  k.box(p[0] - 0.115, p[1] + 0.208, p[2] + 0.13, p[0] + 0.115, p[1] + 0.286, p[2] + 0.134, { r: 0.002, axis: 'x' });
  k.lens([1.0, 0.78, 0.4], 0.7, 0);
  k.box(p[0] - 0.105, p[1] + 0.246, p[2] + 0.134, p[0] + 0.105, p[1] + 0.278, p[2] + 0.1355, { r: 0 });
  k.plastic([0.7, 0.05, 0.03], 0.5);
  k.box(p[0] + 0.031, p[1] + 0.247, p[2] + 0.1355, p[0] + 0.033, p[1] + 0.277, p[2] + 0.1362, { r: 0 });
  k.emissive([1.0, 0.12, 0.05], 5);
  k.cyl(at(-0.098, 0.228, 0.134), at(-0.098, 0.228, 0.1365), 0.0035, 0.0035, 6, { capB: true });
  k.bare(0, 0.25, CHROME);
  for (const x of [-0.07, -0.035, 0.035, 0.07]) k.lathe(at(x, 0.172, 0.134), Z, [[0, 0.013], [0.012, 0.012], [0.014, 0.01], [0.014, 0]], 10, { crease: 40 });
  for (let i = 0; i < 6; i++) k.box(p[0] - 0.093 + i * 0.032, p[1] + 0.3, p[2] + 0.075, p[0] - 0.067 + i * 0.032, p[1] + 0.309, p[2] + 0.12, { r: 0.002 });
  k.plastic([0.05, 0.05, 0.055], 0.5);
  k.tube([at(-0.21, 0.298, 0.06), at(-0.21, 0.335, 0.06), at(0.21, 0.335, 0.06), at(0.21, 0.298, 0.06)], 0.009, 6);
  k.bare(0, 0.25, CHROME);
  k.cyl(at(0.25, 0.3, 0.03), at(0.12, 0.74, 0.03), 0.003, 0.002, 5);
  k.ellipsoid(at(0.12, 0.74, 0.03), 0.005, 0.005, 0.005, 6, 4);
  return k;
}

// ------------------------------------------------------------------------------------------------ hand tools
/** A combination spanner hung by its ring at (x, y) on a board whose face is at z: ring up, jaw down. */
function spanner(k, x, y, z, len, w) {
  k.bare(0, 0.3, TOOL);
  k.lathe([x, y, z + 0.002], Z, [[0, w * 0.62], [0, w], [0.006, w], [0.006, w * 0.62], [0, w * 0.62]], 10, { crease: 40 });
  const y0 = y - w * 0.95, y1 = y0 - len;
  k.box(x - w * 0.42, y1, z + 0.003, x + w * 0.42, y0, z + 0.007, { r: 0 });
  k.box(x - w * 1.1, y1 - w * 0.8, z + 0.002, x + w * 1.1, y1, z + 0.008, { r: 0 });
  for (const s of [-1, 1]) k.box(Math.min(s * w * 1.1, s * w * 0.5) + x, y1 - w * 1.9, z + 0.002, Math.max(s * w * 1.1, s * w * 0.5) + x, y1 - w * 0.8, z + 0.008, { r: 0 });
  hook(k, x, y + w * 0.55, z);
}

/** A wire peg hook: out of the board and turned up. */
function hook(k, x, y, z, reach = 0.03) {
  k.bare(2, 0.5, ZINC);
  k.tube([[x, y, z], [x, y - 0.004, z + reach], [x, y + 0.012, z + reach + 0.004]], 0.0022, 4, { capB: true });
}

function screwdriver(k, x, y, z, len, color) {
  k.plastic(color, 0.3);
  k.lathe([x, y, z], Y, [[0, 0.006], [0.012, 0.0135], [0.085, 0.0135], [0.095, 0.009], [0.095, 0]], 8, { crease: 40 });
  k.bare(0, 0.35, TOOL);
  k.cyl([x, y, z], [x, y - len, z], 0.003, 0.003, 5, { capB: true });
}

/** A hammer hung head-up on two hooks. `ball`: an engineer's ball-pein rather than a claw. */
function hammer(k, x, y, z, ball) {
  k.wood([0.55, 0.4, 0.22], 0.6, 0.4);
  k.bar([x, y - 0.012, z + 0.016], [x, y - 0.3, z + 0.016], 0.03, 0.02, { up: Z, r: 0.006 });
  k.bare(2, 0.4, [0.35, 0.36, 0.38]);
  k.bar([x - 0.045, y, z + 0.016], [x + 0.05, y, z + 0.016], 0.026, 0.028, { up: Y, r: 0.004 });
  if (ball) k.ellipsoid([x - 0.055, y, z + 0.016], 0.016, 0.014, 0.014, 8, 5);
  else for (const s of [-0.007, 0.007]) k.bar([x - 0.045, y, z + 0.016 + s], [x - 0.085, y - 0.03, z + 0.016 + s], 0.008, 0.012, { up: Y, r: 0 });
  for (const s of [-0.022, 0.03]) hook(k, x + s, y - 0.014, z, 0.034);
}

function pliers(k, x, y, z, grip) {
  k.bare(2, 0.4, [0.4, 0.41, 0.43]);
  for (const s of [-1, 1]) k.bar([x + s * 0.004, y, z + 0.006], [x + s * 0.002, y + 0.055, z + 0.006], 0.008, 0.008, { up: Z, r: 0 });
  k.cyl([x, y, z + 0.001], [x, y, z + 0.012], 0.009, 0.009, 8, { capB: true });
  k.plastic(grip, 0.5);
  for (const s of [-1, 1]) k.bar([x + s * 0.005, y - 0.012, z + 0.006], [x + s * 0.026, y - 0.13, z + 0.006], 0.012, 0.011, { up: Z, r: 0.003 });
  hook(k, x, y + 0.012, z, 0.02);
}

function hacksaw(k, x, y, z) {
  k.bare(0, 0.3, TOOL);
  k.tube([[x, y - 0.1, z + 0.008], [x, y, z + 0.008], [x + 0.32, y, z + 0.008], [x + 0.32, y - 0.1, z + 0.008]], 0.006, 6, { capA: true, capB: true });
  k.bare(2, 0.4, [0.3, 0.31, 0.33]);
  k.box(x - 0.01, y - 0.098, z + 0.007, x + 0.33, y - 0.086, z + 0.009, { r: 0 });
  k.plastic([0.08, 0.08, 0.085], 0.5);
  k.bar([x + 0.335, y - 0.07, z + 0.008], [x + 0.39, y - 0.16, z + 0.008], 0.03, 0.022, { up: Z, r: 0.006 });
  for (const s of [0.05, 0.27]) hook(k, x + s, y - 0.006, z, 0.02);
}

/** Lay out the board's tools; the board's face is the plane z, its lower left corner (x0, y0). */
function tools(k, x0, y0, z, w, h) {
  for (let i = 0; i < 9; i++) spanner(k, x0 + 0.09 + i * 0.066, y0 + h - 0.1, z, 0.25 - i * 0.017, 0.016 - i * 0.0008);
  hammer(k, x0 + 0.82, y0 + h - 0.12, z, false); hammer(k, x0 + 1.0, y0 + h - 0.12, z, true);
  hacksaw(k, x0 + w - 0.55, y0 + h - 0.1, z);
  // screwdrivers standing in a strip of bent steel
  const rackY = y0 + h * 0.47, rx = x0 + w - 0.62;
  k.steel([0.1, 0.1, 0.105], 0.5, 0.2);
  k.box(rx, rackY - 0.004, z, rx + 0.45, rackY, z + 0.045, { r: 0 });
  k.box(rx, rackY - 0.03, z, rx + 0.45, rackY + 0.02, z + 0.003, { r: 0 });
  const grips = [[0.75, 0.42, 0.06], [0.6, 0.07, 0.05], [0.75, 0.42, 0.06], [0.08, 0.08, 0.085], [0.6, 0.07, 0.05], [0.75, 0.42, 0.06], [0.07, 0.2, 0.42]];
  grips.forEach((g, i) => screwdriver(k, rx + 0.04 + i * 0.062, rackY, z + 0.026, 0.19 - (i % 3) * 0.035, g));
  [[0.6, 0.07, 0.05], [0.07, 0.2, 0.42], [0.6, 0.07, 0.05]].forEach((g, i) => pliers(k, x0 + 0.84 + i * 0.1, y0 + h * 0.4, z, g));
  // a try square, an adjustable spanner and a coil of extension lead
  k.bare(2, 0.35, TOOL);
  k.box(x0 + 0.1, y0 + 0.16, z + 0.004, x0 + 0.14, y0 + 0.46, z + 0.006, { r: 0 });
  k.wood([0.4, 0.26, 0.14], 0.6, 0.3); k.box(x0 + 0.1, y0 + 0.11, z + 0.001, x0 + 0.3, y0 + 0.16, z + 0.016, { r: 0.002, axis: 'x' });
  hook(k, x0 + 0.12, y0 + 0.47, z, 0.012);
  k.bare(0, 0.3, TOOL);
  k.box(x0 + 0.42, y0 + 0.14, z + 0.003, x0 + 0.45, y0 + 0.4, z + 0.009, { r: 0 });
  k.box(x0 + 0.405, y0 + 0.4, z + 0.002, x0 + 0.465, y0 + 0.46, z + 0.012, { r: 0.002 });
  k.box(x0 + 0.405, y0 + 0.475, z + 0.002, x0 + 0.44, y0 + 0.5, z + 0.012, { r: 0 });
  k.box(x0 + 0.405, y0 + 0.46, z + 0.004, x0 + 0.42, y0 + 0.475, z + 0.01, { r: 0 });
  hook(k, x0 + 0.435, y0 + 0.15 + 0.012, z, 0.014);
  const coil = [x0 + 0.62, y0 + 0.27, z + 0.02], ring = [];
  for (let i = 0; i <= 8; i++) { const a = i / 8 * Math.PI * 2; ring.push([Math.sin(a) * 0.016, 0.115 + Math.cos(a) * 0.016]); }
  k.rubber([0.6, 0.3, 0.04], 0.6);
  k.lathe(coil, Z, ring, k.n(30, 14), { crease: 60 });
  hook(k, coil[0], coil[1] + 0.105, z, 0.04);
}

/**
 * A sheet of perforated hardboard on battens, w by h, its lower edge at y0, with tools hung on it. Width and height
 * are whole numbers of the 25.4 mm hole pitch so the holes keep an even margin.
 */
export function pegboard(k, y0, cols = 73, rows = 43) {
  const pitch = 0.0254, w = cols * pitch, h = rows * pitch, x0 = -w / 2, t = 0.03, m = k.mark();
  k.wood([0.42, 0.32, 0.2], 0.8, 0.4);
  for (const y of [y0 + 0.06, y0 + h - 0.06]) k.box(x0 + 0.02, y - 0.022, 0, x0 + w - 0.02, y + 0.022, t - 0.006, { r: 0, axis: 'x' });
  k.paint([0.36, 0.26, 0.17], 0.8, 0.3);
  k.box(x0, y0, t - 0.006, x0 + w, y0 + h, t - 0.0004, { r: 0, axis: 'x' });
  k.pegboard([0.54, 0.41, 0.27], 0.7, 0.4);
  k.sheet([x0, y0, t], X, Y, edges(0, w, 0.32), edges(0, h, 0.28), () => true, null, (u, v) => [u, v]);
  k.bare(2, 0.5, ZINC);
  for (const x of [x0 + 0.04, 0, x0 + w - 0.04]) for (const y of [y0 + 0.06, y0 + h - 0.06]) k.lathe([x, y, t], Z, [[0, 0.009], [0.002, 0.008], [0.003, 0.004], [0.003, 0]], 8, { crease: 40 });
  k.shade(m, (x, y, z) => (z < t - 0.001 ? 0.6 : 1));
  tools(k, x0, y0, t, w, h);
  return { w, h };
}

// ------------------------------------------------------------------------------------------------ small things
function mug(k, p) {
  k.plastic([0.78, 0.76, 0.7], 0.3);
  k.lathe(p, Y, [[0, 0], [0, 0.036], [0.004, 0.04], [0.095, 0.042], [0.095, 0.037], [0.012, 0.035], [0.012, 0]], k.n(12, 8), { crease: 40 });
  k.tube([vadd(p, [0.04, 0.075, 0]), vadd(p, [0.066, 0.068, 0]), vadd(p, [0.068, 0.035, 0]), vadd(p, [0.04, 0.025, 0])], 0.006, 5);
}

/** A thumb-pump oil can. */
function oiler(k, p) {
  k.steel([0.5, 0.08, 0.06], 0.4, 0.3);
  k.lathe(p, Y, [[0, 0], [0, 0.045], [0.006, 0.048], [0.06, 0.048], [0.085, 0.02], [0.095, 0.012], [0.095, 0]], k.n(12, 8), { crease: 36 });
  k.bare(1, 0.4, [0.72, 0.6, 0.34]);
  k.tube([vadd(p, [0, 0.095, 0]), vadd(p, [0, 0.125, 0]), vadd(p, [0.05, 0.19, 0]), vadd(p, [0.13, 0.2, 0])], 0.004, 5, { capB: true });
}

/** A cantilever tool box, shut. */
function toolBox(k, x, y, z, color) {
  k.steel(color, 0.4, 0.3);
  k.box(x, y, z, x + 0.46, y + 0.13, z + 0.2, { r: 0.006, axis: 'x' });
  k.box(x - 0.002, y + 0.132, z - 0.002, x + 0.462, y + 0.2, z + 0.202, { r: 0.012, axis: 'x' });
  k.bare(2, 0.45, ZINC);
  k.tube([[x + 0.13, y + 0.2, z + 0.1], [x + 0.13, y + 0.235, z + 0.1], [x + 0.33, y + 0.235, z + 0.1], [x + 0.33, y + 0.2, z + 0.1]], 0.006, 6);
  for (const dx of [0.09, 0.37]) k.box(x + dx - 0.015, y + 0.105, z + 0.2, x + dx + 0.015, y + 0.15, z + 0.206, { r: 0.002 });
}

/** A round shop stool: vinyl pad, four splayed tube legs, a foot ring. */
export function stool(k) {
  const m = k.mark(), H = 0.62;
  k.plastic([0.07, 0.07, 0.075], 0.45);
  k.lathe([0, H - 0.05, 0], Y, [[0, 0], [0, 0.16], [0.012, 0.172], [0.04, 0.172], [0.05, 0.16], [0.05, 0]], k.n(18, 10), { crease: 36 });
  k.bare(0, 0.3, CHROME);
  const ring = [];
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + Math.PI / 4, c = Math.cos(a), s = Math.sin(a);
    k.cyl([c * 0.118, H - 0.036, s * 0.118], [c * 0.21, 0.01, s * 0.21], 0.011, 0.011, 8);
    k.rubber(BLACK, 0.8); k.cyl([c * 0.21, 0.012, s * 0.21], [c * 0.212, 0, s * 0.212], 0.014, 0.014, 8, { capA: true, capB: true }); k.bare(0, 0.3, CHROME);
  }
  for (let i = 0; i <= 20; i++) { const a = i / 20 * Math.PI * 2; ring.push([Math.cos(a) * 0.178, 0.22, Math.sin(a) * 0.178]); }
  k.tube(ring, 0.008, 6, { capA: true, capB: true });   // the weld where the ring closes
  k.ground(m, 0.12, 0.35);
  return k;
}

// ------------------------------------------------------------------------------------------------ the bench
/**
 * The workbench with everything on and under it. Returns the lamp's { bulb, axis } in the builder's frame.
 */
export function workbench(k, lampRadiance) {
  const { w, d, top } = BENCH, hw = w / 2, frame = [0.16, 0.2, 0.19], m = k.mark();
  k.steel(frame, 0.5, 0.4);
  for (const x of [-hw + 0.05, hw - 0.05]) for (const z of [0.05, d - 0.09]) {
    k.box(x - 0.025, 0.012, z - 0.025, x + 0.025, top - 0.045, z + 0.025, { r: 0.004 });
    k.box(x - 0.035, 0, z - 0.035, x + 0.035, 0.012, z + 0.035, { r: 0 });
  }
  for (const y of [0.2, top - 0.07]) {
    for (const z of [0.05, d - 0.09]) k.box(-hw + 0.075, y - 0.025, z - 0.02, hw - 0.075, y + 0.025, z + 0.02, { r: 0.003, axis: 'x' });
    for (const x of [-hw + 0.05, hw - 0.05]) k.box(x - 0.02, y - 0.025, 0.075, x + 0.02, y + 0.025, d - 0.115, { r: 0.003, axis: 'z' });
  }
  const under = k.mark();
  k.wood([0.4, 0.3, 0.19], 0.8, 0.5);
  k.box(-hw + 0.03, 0.225, 0.03, hw - 0.03, 0.245, d - 0.07, { r: 0.002, axis: 'x' });                                   // the shelf below
  // the top: thick boards, an upstand at the back to stop things rolling off
  const topMark = k.mark();
  k.wood([0.38, 0.27, 0.16], 0.65, 0.65);
  k.box(-hw, top - 0.045, 0, hw, top, d, { r: 0.005, axis: 'x' });
  k.box(-hw, top, 0, hw, top + 0.1, 0.022, { r: 0.003, axis: 'x' });
  // a drawer unit hung under the right-hand end
  k.steel(frame, 0.5, 0.4);
  k.box(hw - 0.58, top - 0.4, 0.08, hw - 0.1, top - 0.046, d - 0.07, { r: 0.004 });
  for (const y of [top - 0.39, top - 0.215]) {
    k.steel([0.3, 0.33, 0.33], 0.45, 0.3);
    k.box(hw - 0.57, y, d - 0.07, hw - 0.11, y + 0.16, d - 0.058, { r: 0.003, axis: 'x' });
    k.bare(STEEL.brushed, 0.35, [0.74, 0.75, 0.76]);
    k.box(hw - 0.42, y + 0.11, d - 0.058, hw - 0.26, y + 0.125, d - 0.04, { r: 0.003, axis: 'x' });
  }
  // under the bench
  toolBox(k, -hw + 0.12, 0.245, 0.22, [0.08, 0.17, 0.4]);
  carton(k, -hw + 0.68, 0.245, 0.16, 0.36, 0.26, 0.32);
  gallonCan(k, -hw + 1.18, 0.245, 0.36, [0.62, 0.1, 0.07], 0.2); gallonCan(k, -hw + 1.2, 0.245, 0.2, [0.1, 0.36, 0.2], -0.1);
  k.shade(under, (x, y, z) => (y < top - 0.05 ? 0.45 + 0.4 * Math.min(1, Math.max(0, z - 0.1) / (d - 0.1)) : 1));
  // on the bench
  vice(k, [-hw + 0.26, top, d - 0.1]);
  for (let i = 0; i < 3; i++) sprayCan(k, -hw + 0.56 + i * 0.075, top, 0.09 + (i % 2) * 0.012, [[0.62, 0.1, 0.07], [0.08, 0.08, 0.085], [0.72, 0.55, 0.1]][i], [[0.62, 0.1, 0.07], [0.78, 0.76, 0.7], [0.72, 0.55, 0.1]][i]);
  paintTin(k, -hw + 0.86, top, 0.1, 0.055, 0.125, [0.08, 0.2, 0.46]);
  oilBottle(k, -hw + 0.99, top, 0.09, [0.72, 0.55, 0.1]);
  oiler(k, [-0.42, top, 0.4]);
  const lamp = deskLamp(k, [0.02, top, 0.13], [-0.3, top, 0.42], lampRadiance);
  radio(k, [0.5, top, 0.03]);
  mug(k, [0.34, top, 0.34]);
  // a hammer left lying where it was put down, and a spanner beside it
  k.wood([0.55, 0.4, 0.22], 0.6, 0.4); k.bar([-0.22, top + 0.011, 0.5], [0.06, top + 0.011, 0.44], 0.03, 0.02, { up: Y, r: 0.006 });
  k.bare(2, 0.4, [0.35, 0.36, 0.38]); k.bar([0.075, top + 0.014, 0.39], [0.055, top + 0.014, 0.49], 0.028, 0.028, { up: Y, r: 0.004 });
  k.bare(0, 0.3, TOOL); k.bar([0.2, top + 0.003, 0.52], [0.4, top + 0.003, 0.56], 0.014, 0.005, { up: Y, r: 0 });
  k.shade(topMark, (x, y, z) => (y < top + 0.002 && y > top - 0.002 ? 0.75 + 0.25 * Math.min(1, z / 0.2) : 1));
  k.ground(m, 0.2, 0.4);
  return lamp;
}
