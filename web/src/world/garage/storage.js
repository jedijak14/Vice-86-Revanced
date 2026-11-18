// Storage: the roller cabinet with its top chest, and steel shelving loaded with the tins, cans, bottles and boxes a
// workshop collects. Same frame as gear.js: on y = 0, back to the wall at z = 0, front towards +z. Nothing carries a
// maker's name: labels are plain blocks of colour, as they read from across a room anyway.

import { makeRng } from '../../core/math.js';
import { COLOR } from './plan.js';
import { STEEL } from './setkit.js';

const Y = [0, 1, 0], Z = [0, 0, 1];
const ALU = [0.74, 0.75, 0.76], TIN = [0.62, 0.63, 0.64], KRAFT = [0.5, 0.38, 0.24];

// ------------------------------------------------------------------------------------------------ tool chest
/** One bank of drawers on the front of a carcass: each a pressed front standing proud, with a full-width pull. */
function drawers(k, x0, x1, y0, heights, z, paint) {
  let y = y0;
  for (const h of heights) {
    k.steel(paint, 0.3, 0.12);
    k.box(x0 + 0.004, y + 0.003, z, x1 - 0.004, y + h - 0.003, z + 0.014, { r: 0.003, axis: 'x' });
    k.bare(STEEL.brushed, 0.35, ALU);
    k.box(x0 + 0.012, y + h - 0.024, z + 0.014, x1 - 0.012, y + h - 0.008, z + 0.027, { r: 0.003, axis: 'x' });
    y += h;
  }
}

/**
 * A mechanic's roller cabinet (0.68 wide, 0.46 deep) with a top chest standing on it, 1.42 m to the lid: red
 * enamel, aluminium pulls, a lock in each, a push handle on one end.
 */
export function toolChest(k) {
  const m = k.mark(), red = COLOR.chestRed, w = 0.34, d = 0.46, base = 0.125;
  // castors: two fixed, two swivel
  for (const x of [-w + 0.07, w - 0.07]) for (const z of [0.07, d - 0.07]) {
    k.bare(2, 0.5, [0.6, 0.61, 0.62]);
    k.box(x - 0.04, base - 0.006, z - 0.04, x + 0.04, base, z + 0.04, { r: 0 });
    for (const s of [-0.022, 0.022]) k.box(x + s - 0.002, 0.04, z - 0.025, x + s + 0.002, base - 0.006, z + 0.025, { r: 0 });
    k.rubber([0.05, 0.05, 0.052], 0.8);
    k.cyl([x - 0.018, 0.05, z], [x + 0.018, 0.05, z], 0.05, 0.05, k.n(14, 8), { capA: true, capB: true });
  }
  // cabinet: the carcass, a dark recess the drawer fronts stand in, seven drawers
  k.steel(red, 0.3, 0.12);
  k.box(-w, base, 0, w, 0.95, d - 0.016, { r: 0.006 });
  k.steel([0.05, 0.02, 0.02], 0.6, 0.1); k.occ(0.4);
  k.box(-w + 0.018, base + 0.02, d - 0.017, w - 0.018, 0.932, d - 0.012, { r: 0 });
  k.occ(1);
  drawers(k, -w + 0.02, w - 0.02, base + 0.022, [0.2, 0.2, 0.13, 0.13, 0.075, 0.075, 0.075], d - 0.014, red);
  k.bare(0, 0.3, [0.8, 0.81, 0.83]);
  k.cyl([w - 0.05, 0.94, d - 0.016], [w - 0.05, 0.94, d - 0.009], 0.009, 0.009, 8, { capB: true });
  k.tube([[w, 0.86, 0.1], [w + 0.05, 0.86, 0.1], [w + 0.05, 0.86, d - 0.12], [w, 0.86, d - 0.12]], 0.011, 8);            // push handle
  // a ribbed mat on the cabinet's top, the chest on that
  k.rubber([0.05, 0.05, 0.052], 0.85); k.box(-w + 0.01, 0.95, 0.01, w - 0.01, 0.956, d - 0.03, { r: 0 });
  const cw = w - 0.012, cd = d - 0.05, c0 = 0.956, c1 = 1.33;
  k.steel(red, 0.3, 0.12);
  k.box(-cw, c0, 0.006, cw, c1, cd - 0.014, { r: 0.006 });
  k.box(-cw - 0.002, c1 + 0.004, 0.004, cw + 0.002, c1 + 0.09, cd, { r: 0.008 });                                       // the lid, a finger's gap above the body
  k.steel([0.05, 0.02, 0.02], 0.6, 0.1); k.occ(0.4);
  k.box(-cw + 0.016, c0 + 0.016, cd - 0.015, cw - 0.016, c1 - 0.014, cd - 0.01, { r: 0 });
  k.box(-cw + 0.004, c1, 0.01, cw - 0.004, c1 + 0.004, cd - 0.004, { r: 0 });
  k.occ(1);
  drawers(k, -cw + 0.018, cw - 0.018, c0 + 0.018, [0.1, 0.075, 0.075], cd - 0.012, red);
  for (const [x0, x1] of [[-cw + 0.018, -0.105], [-0.105, 0.105], [0.105, cw - 0.018]]) drawers(k, x0, x1, c0 + 0.268, [0.075], cd - 0.012, red);
  k.bare(0, 0.3, [0.8, 0.81, 0.83]);
  k.cyl([0, c1 + 0.045, cd], [0, c1 + 0.045, cd + 0.006], 0.009, 0.009, 8, { capB: true });
  for (const s of [-1, 1]) k.tube([[s * (cw + 0.002), c0 + 0.2, 0.13], [s * (cw + 0.04), c0 + 0.2, 0.13], [s * (cw + 0.04), c0 + 0.2, cd - 0.13], [s * (cw + 0.002), c0 + 0.2, cd - 0.13]], 0.008, 6);
  k.ground(m, 0.16, 0.5);
  return { top: c1 + 0.09, depth: cd };
}

// ------------------------------------------------------------------------------------------------ tins and boxes
const LABELS = [[0.62, 0.1, 0.07], [0.08, 0.2, 0.46], [0.72, 0.55, 0.1], [0.1, 0.36, 0.2], [0.78, 0.76, 0.7], [0.05, 0.05, 0.055], [0.7, 0.3, 0.06], [0.09, 0.36, 0.4]];

/** A lever-lid paint tin with a paper label and a wire bail lying against its side. */
export function paintTin(k, x, y, z, r, h, label) {
  const n = k.n(14, 8);
  k.bare(2, 0.4, TIN);
  k.lathe([x, y, z], Y, [[0, 0], [0, r], [0.006, r + 0.002], [0.012, r], [h - 0.012, r], [h - 0.006, r + 0.002], [h, r], [h, r - 0.006], [h - 0.006, r - 0.008], [h - 0.006, 0]], n, { crease: 40 });
  k.paint(label, 0.6, 0.3);
  // the paper has its own top and bottom edge, so no slot opens between it and the tin
  k.lathe([x, y, z], Y, [[0.016, r - 0.001], [0.016, r + 0.0008], [h - 0.016, r + 0.0008], [h - 0.016, r - 0.001]], n, { crease: 40 });
  return k;
}

/** An aerosol: domed shoulder, valve cup and a plastic cap. */
export function sprayCan(k, x, y, z, color, cap) {
  const r = 0.0325, n = k.n(12, 8);
  k.paint(color, 0.4, 0.2);
  k.lathe([x, y, z], Y, [[0, 0], [0, r - 0.003], [0.004, r], [0.15, r], [0.165, r - 0.006], [0.172, 0.016]], n, { crease: 40 });
  k.plastic(cap, 0.45);
  k.lathe([x, y + 0.168, z], Y, [[0, 0.012], [0, 0.02], [0.006, 0.024], [0.04, 0.024], [0.045, 0.02], [0.045, 0]], n, { crease: 40 });
  return k;
}

/** A rectangular gallon can with a screw cap and a strap handle, its long side along x. */
export function gallonCan(k, x, y, z, color, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), at = (dx, dy, dz) => [x + dx * c + dz * s, y + dy, z - dx * s + dz * c];
  k.paint(color, 0.5, 0.35);
  k.bar(at(0, 0, 0), at(0, 0.245, 0), 0.165, 0.105, { up: [s, 0, c], r: 0.008 });
  k.bare(2, 0.45, TIN);
  k.cyl(at(0.045, 0.245, 0), at(0.045, 0.268, 0), 0.02, 0.02, 10, { capB: true });
  k.tube([at(-0.06, 0.24, 0), at(-0.05, 0.268, 0), at(-0.005, 0.268, 0), at(0.005, 0.24, 0)], 0.004, 4);
  return k;
}

/** A plastic oil bottle with an offset neck. */
export function oilBottle(k, x, y, z, color) {
  const n = k.n(10, 6);
  k.plastic(color, 0.4);
  k.lathe([x, y, z], Y, [[0, 0], [0, 0.04], [0.005, 0.045], [0.16, 0.045], [0.2, 0.03], [0.215, 0.016], [0.24, 0.016]], n, { crease: 36 });
  k.plastic([0.75, 0.1, 0.07], 0.5);
  k.cyl([x, y + 0.238, z], [x, y + 0.26, z], 0.019, 0.019, n, { capA: true, capB: true });
  return k;
}

/** A cardboard carton, taped. */
export function carton(k, x0, y, z0, w, h, d) {
  k.paint(KRAFT, 0.85, 0.5);
  k.box(x0, y, z0, x0 + w, y + h, z0 + d, { r: 0.004 });
  k.paint([0.6, 0.5, 0.33], 0.5, 0.3);
  k.box(x0 + w / 2 - 0.025, y + h - 0.03, z0 - 0.0008, x0 + w / 2 + 0.025, y + h + 0.0008, z0 + d + 0.0008, { r: 0 });
  return k;
}

/** A row of open-fronted parts bins. */
function bins(k, x0, y, z, count, color) {
  for (let i = 0; i < count; i++) {
    const x = x0 + i * 0.112;
    k.plastic(color, 0.5);
    k.box(x, y, z - 0.2, x + 0.105, y + 0.075, z, { r: 0.004 });
    k.box(x, y, z, x + 0.105, y + 0.035, z + 0.03, { r: 0.004 });                                                       // the scoop lip
    k.steel([0.03, 0.03, 0.032], 0.7, 0); k.occ(0.35);
    k.box(x + 0.008, y + 0.076, z - 0.192, x + 0.097, y + 0.0765, z - 0.006, { r: 0 });                                 // what is inside is in shadow
    k.occ(1);
  }
}

/** Fill one shelf (x0..x1, top surface y, depth 0..d, headroom h) from a seeded list of things. */
function load(k, rng, x0, x1, y, d, h) {
  let x = x0 + rng.range(0.01, 0.05);
  while (x < x1 - 0.1) {
    const kind = rng.next(), left = x1 - x, zb = d * 0.5 + rng.range(-0.04, 0.04);
    if (kind < 0.22 && left > 0.4 && h > 0.2) {
      const w = rng.range(0.26, 0.38), ch = Math.min(h - 0.03, rng.range(0.16, 0.3));
      carton(k, x, y, d * 0.5 - 0.15 + rng.range(-0.02, 0.02), w, ch, 0.3);
      if (ch + 0.16 < h && rng.chance(0.5)) paintTin(k, x + w / 2, y + ch, d * 0.5, 0.055, 0.125, rng.pick(LABELS));
      x += w + rng.range(0.015, 0.05);
    } else if (kind < 0.5) {
      const big = rng.chance(0.4) && h > 0.25, r = big ? 0.085 : 0.055, th = big ? 0.2 : 0.125, n = rng.int(1, big ? 2 : 3);
      for (let i = 0; i < n && x + 2 * r < x1; i++) {
        const label = rng.pick(LABELS);
        paintTin(k, x + r, y, zb, r, th, label);
        if (!big && rng.chance(0.4) && h > 0.3) paintTin(k, x + r + rng.range(-0.008, 0.008), y + th, zb + rng.range(-0.008, 0.008), r, th, rng.pick(LABELS));
        x += 2 * r + rng.range(0.006, 0.02);
      }
      x += rng.range(0.01, 0.05);
    } else if (kind < 0.68 && h > 0.24) {
      const n = rng.int(2, 4), color = rng.pick(LABELS);
      for (let i = 0; i < n && x + 0.07 < x1; i++) { sprayCan(k, x + 0.035, y, zb + rng.range(-0.02, 0.02), color, rng.pick(LABELS)); x += 0.072 + rng.range(0, 0.008); }
      x += rng.range(0.02, 0.06);
    } else if (kind < 0.84 && h > 0.29) {
      const n = rng.int(1, 3), color = rng.pick(LABELS);
      for (let i = 0; i < n && x + 0.18 < x1; i++) { gallonCan(k, x + 0.09, y, zb, color, rng.range(-0.12, 0.12)); x += 0.185 + rng.range(0, 0.01); }
      x += rng.range(0.02, 0.05);
    } else if (h > 0.29) {
      const n = rng.int(2, 4), color = rng.pick(LABELS);
      for (let i = 0; i < n && x + 0.1 < x1; i++) { oilBottle(k, x + 0.048, y, zb + rng.range(-0.03, 0.03), color); x += 0.1 + rng.range(0, 0.012); }
      x += rng.range(0.02, 0.05);
    } else x += 0.08;
  }
}

// ------------------------------------------------------------------------------------------------ shelving
/**
 * Bolted steel shelving, `bays` wide (0.9 m each), 0.45 deep and 1.98 m high, loaded. Angle uprights with their
 * rows of holes left to the eye; sheet shelves with a turned-down front; a diagonal brace across the back.
 */
export function shelving(k, bays, seed, parts = false) {
  const m = k.mark(), bw = 0.9, W = bays * bw, d = 0.45, H = 1.98, x0 = -W / 2, grey = [0.3, 0.33, 0.34];
  const levels = [0.1, 0.52, 0.94, 1.36, 1.78];
  k.steel(grey, 0.5, 0.35);
  for (let i = 0; i <= bays; i++) for (const z of [0.004, d - 0.004]) {
    const x = x0 + i * bw, sx = i === 0 ? 1 : -1, sz = z < 0.1 ? 1 : -1;
    // an angle: two flats meeting at the corner
    k.box(Math.min(x, x + sx * 0.038), 0, Math.min(z, z + sz * 0.003), Math.max(x, x + sx * 0.038), H, Math.max(z, z + sz * 0.003), { r: 0 });
    k.box(Math.min(x, x + sx * 0.003), 0, Math.min(z, z + sz * 0.038), Math.max(x, x + sx * 0.003), H, Math.max(z, z + sz * 0.038), { r: 0 });
    if (i > 0 && i < bays) k.box(x, 0, Math.min(z, z + sz * 0.003), x + 0.038, H, Math.max(z, z + sz * 0.003), { r: 0 });
  }
  const shelfMark = k.mark();
  for (let b = 0; b < bays; b++) for (const y of levels) {
    k.steel(grey, 0.5, 0.35);
    k.box(x0 + b * bw + 0.004, y - 0.032, 0.006, x0 + (b + 1) * bw - 0.004, y, d - 0.006, { r: 0.002, axis: 'x' });
    for (const z of [0.004, d - 0.007]) for (const s of [0.02, bw - 0.02]) { k.bare(2, 0.5, [0.62, 0.63, 0.64]); k.bolt([x0 + b * bw + s, y - 0.016, z < 0.1 ? z : z + 0.003], z < 0.1 ? [0, 0, -1] : Z, 0.007, 0.005); }
  }
  k.steel(grey, 0.5, 0.35);
  for (let b = 0; b < bays; b++) k.bar([x0 + b * bw + 0.03, 0.14, 0.012], [x0 + (b + 1) * bw - 0.03, 1.74, 0.012], 0.025, 0.003, { up: Z, r: 0 });
  // everything on a shelf sits in the shadow of the shelf above it, deepest at the back
  const rng = makeRng(seed);
  const stock = k.mark();
  for (let b = 0; b < bays; b++) levels.forEach((y, i) => {
    const a = x0 + b * bw + 0.045, e = x0 + (b + 1) * bw - 0.045, head = (levels[i + 1] ?? y + 0.5) - y - 0.04;
    if (parts && i === 2) { bins(k, a + 0.01, y, d - 0.05, 7, [0.08, 0.2, 0.44]); return; }
    if (parts && i === 3) { bins(k, a + 0.01, y, d - 0.05, 7, [0.66, 0.5, 0.08]); return; }
    load(k, rng, a, e, y, d, head);
  });
  k.shade(stock, (x, y, z) => {
    let i = levels.length - 1; while (i > 0 && levels[i] > y + 0.001) i--;
    const top = levels[i + 1]; if (top === undefined) return 1;
    return 0.5 + 0.5 * Math.min(1, z / d + 0.25) * (0.6 + 0.4 * Math.min(1, (top - 0.032 - y) / 0.3));
  });
  k.shade(shelfMark, (x, y, z) => 0.6 + 0.4 * Math.min(1, z / d + 0.3));
  k.ground(m, 0.12, 0.4);
  return { w: W, d, h: H };
}
