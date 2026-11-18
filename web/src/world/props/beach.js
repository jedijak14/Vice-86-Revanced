// Beach and water prototypes. Front = +Z; for everything on the sand that is the seaward side (the planner yaws
// +Z towards the water), so the lifeguard towers' ramps run down towards the sea.
//
//   lifeguard_tower_a  timber hut on four posts and skids: square cabin, hip roof, propped shutters, ramp
//   lifeguard_tower_b  the stylised kind: drum cabin with portholes under a disc roof with a stepped fin
//   umbrella_a, lounger  canvas colour comes from the instance tint (fabric palette); stripes are in the material
//   volleyball_net     runs along X
//   boat_small         open skiff, bow towards +Z, keel on y = 0; `waterline` is how deep it floats (hull colour from the tint)
//   pier_post          mooring pile; its origin is at the water surface, the pile runs from y = -3 to +2
//
// The towers have fixed colour schemes (they do not use the tint): they are landmarks, and are painted as a set.

import { place, vadd, vmad, vsub, vnorm, vlen } from './kit.js';
import { C, railing, signPlate, rectOutline } from './common.js';
import { signNamed } from './atlas.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const TAU = Math.PI * 2;
const WHITE = [0.87, 0.86, 0.82];

// ---------------------------------------------------------------- lifeguard towers
/** Plank ramp from the deck edge down to the sand at about 30 degrees, with cleats and a handrail on each side. */
function ramp(k, deckY, z0, railColor) {
  const run = (deckY - 0.04) / Math.tan(30 * Math.PI / 180), a = [0, deckY, z0], b = [0, 0.04, z0 + run], T = vnorm(vsub(b, a)), up = [0, T[2], -T[1]];
  k.wood(C.timberPale, 0.8, 0.55);
  const m = k.mark();
  k.bar(vmad(a, up, -0.025), vmad(b, up, -0.025), 0.9, 0.05, { up });
  if (k.mid) for (const sx of [-0.4, 0.4]) k.bar(vmad([sx, a[1], a[2]], up, -0.13), vmad([sx, b[1], b[2]], up, -0.13), 0.05, 0.16, { up });
  if (k.near) { const len = vlen(vsub(b, a)), count = Math.floor(len / 0.4); for (let i = 1; i <= count; i++) { const p = vmad(a, T, i * len / (count + 1)); k.bar(vmad([-0.4, p[1], p[2]], up, 0.012), vmad([0.4, p[1], p[2]], up, 0.012), 0.045, 0.024, { up }); } }
  k.ground(m, 0.3, 0.4);
  if (k.mid) { railColor(k); for (const sx of [-0.42, 0.42]) railing(k, [[sx, deckY, z0 + 0.1], [sx, 0.1, z0 + run - 0.1]], { height: 0.9, r: 0.03, square: true, mids: 1, postEvery: 1.3 }); }
  return run;
}

/** Notice boards hung on the front rail either side of the ramp. */
function notices(k, deckY, z) {
  if (!k.mid) return;
  for (const [x, id] of [[1.0, 'notice/lifeguard'], [-1.0, 'notice/beach-rules']]) {
    const rect = signNamed(id, 'notice'), w = 0.66;
    signPlate(k, [x, deckY + 0.52, z], X, Y, rectOutline(w, w / rect.aspect), rect, { code: 0, thickness: 0.012, edge: (q) => q.paint(WHITE, 0.6, 0.4) });
  }
}

/** Warning flag on a staff leaning out from `base`. */
function flag(k, base, lean, color) {
  const top = vadd(base, lean), T = vnorm(lean);
  k.paint(WHITE, 0.5, 0.3); k.cyl(base, top, 0.02, 0.016, k.n(8, 4), { capB: true });
  // the cloth streams along +X with a shallow ripple; at the far level it is one flat strip, still a red mark over the roof
  k.fabric(color, 0);
  const m = k.mark(), cols = k.near ? 5 : k.mid ? 2 : 1, rows = [];
  for (const d of [0.66, 0.04]) { const row = [], p = vmad(top, T, -d); for (let j = 0; j <= cols; j++) { const t = j / cols; row.push([p[0] + 0.02 + t * 0.9, p[1] - 0.05 * t * t, p[2] + Math.sin(t * 5.5) * 0.07 * t]); } rows.push(row); }
  k.loft(rows, { crease: 80, uv: (i, j) => [j / cols * 0.9, i * 0.6] });
  k.twoSided(m, null, 0.004);
}

function timberTower(k) {
  const deckY = 1.62, half = 1.5, wallH = 2.1, zb = -1.33, zf = 1.07, hw = 1.2, top = deckY + wallH, band = [0.42, 0.68, 0.67], coral = [0.85, 0.56, 0.5], yellow = [0.86, 0.74, 0.43];
  // substructure: skids on the sand, four posts, crossed braces, deck
  k.wood(C.timber, 0.85, 0.65);
  const sub = k.mark();
  for (const x of [-1.25, 1.25]) k.box(x - 0.1, 0, -half - 0.25, x + 0.1, 0.2, half + 0.25, { axis: 'z', r: k.near ? 0.02 : 0 });
  for (const x of [-1.25, 1.25]) for (const z of [-1.25, 1.25]) k.box(x - 0.075, 0.2, z - 0.075, x + 0.075, deckY - 0.2, z + 0.075, { stops: [0.5] });
  if (k.mid) for (const s of [-1, 1]) for (const d of [-1, 1]) {
    k.bar([s * (1.25 + 0.1 + 0.02 * d), 0.3, -1.25 * d], [s * (1.25 + 0.1 + 0.02 * d), deckY - 0.3, 1.25 * d], 0.035, 0.09, { up: Z });
    k.bar([-1.25 * d, 0.3, s * (1.25 + 0.1 + 0.02 * d)], [1.25 * d, deckY - 0.3, s * (1.25 + 0.1 + 0.02 * d)], 0.09, 0.035, { up: Z });
  }
  k.paint(band, 0.6, 0.4);
  k.box(-half, deckY - 0.2, -half, half, deckY - 0.04, half, { axis: 'x' });                 // rim joists, painted
  k.under(sub, deckY - 0.04, 0.7, 0.45).ground(sub, 0.35, 0.4);
  k.wood(C.timberPale, 0.8, 0.5);
  k.box(-half - 0.03, deckY - 0.04, -half - 0.03, half + 0.03, deckY, half + 0.03, { axis: 'x' });
  // cabin: white boards with one band of colour
  const walls = k.mark(), ring = (y0, y1) => { const c = [[-hw, zf], [hw, zf], [hw, zb], [-hw, zb]]; for (let e = 0; e < 4; e++) { const p = c[e], q = c[(e + 1) % 4]; k.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]]); } };
  k.paint(WHITE, 0.6, 0.45); ring(deckY, deckY + 0.55);
  k.paint(band, 0.6, 0.4); ring(deckY + 0.55, deckY + 0.9);
  k.paint(WHITE, 0.6, 0.45); ring(deckY + 0.9, top);
  k.ground(walls, 0.3, 0.35, deckY).under(walls, top, 0.45, 0.45);
  if (k.mid) {
    // door, windows with top-hinged shutters propped open on three sides
    k.paint(band, 0.55, 0.35); k.box(-1.0, deckY, zf, -0.22, deckY + 1.95, zf + 0.03);
    if (k.near) { k.bare(3, 0.4); k.cyl([-0.34, deckY + 1.0, zf + 0.03], [-0.34, deckY + 1.0, zf + 0.075], 0.022, 0.022, 8, { capB: true }); }
    const y0 = deckY + 1.0, y1 = deckY + 1.8, shutter = 0.82;
    const win = (c, right, out, w) => {
      const mid = vmad(c, out, 0.008);
      k.darkGlass([0.07, 0.09, 0.1], 0.1, 0.6); k.panel([mid[0], (y0 + y1) / 2, mid[2]], right, Y, w, y1 - y0);
      k.paint(coral, 0.55, 0.4);
      const hinge = vmad([c[0], y1 + 0.03, c[2]], out, 0.03), end = vadd(hinge, [out[0] * shutter * 0.82, -shutter * 0.57, out[2] * shutter * 0.82]);
      k.bar(hinge, end, 0.03, w + 0.08, { up: right });
      if (k.near) { k.wood(C.timberPale, 0.8, 0.5); for (const s of [-1, 1]) k.bar(vmad(vmad([c[0], y0, c[2]], out, 0.02), right, s * (w / 2 - 0.05)), vmad(end, right, s * (w / 2 - 0.05)), 0.022, 0.022, { up: right }); }
    };
    win([0.48, 0, zf], X, Z, 0.9);
    win([hw, 0, -0.15], [0, 0, -1], X, 1.3);
    win([-hw, 0, -0.15], Z, [-1, 0, 0], 1.3);
    if (k.near) {
      // ring buoy on the wall beside the ramp side
      k.plastic([0.95, 0.42, 0.1], 0.5);
      const prof = []; for (let i = 0; i <= 8; i++) { const a = i / 8 * TAU; prof.push([0.055 + Math.sin(a) * 0.05, 0.27 + Math.cos(a) * 0.05]); }
      k.lathe([0.75, deckY + 1.32, zf - 0.005], Z, prof, 14, { crease: 80 });
    }
  }
  // hip roof with a deep overhang: soffit, fascia, four standing-seam slopes
  const ex = hw + 0.52, ez0 = zb - 0.52, ez1 = zf + 0.52, apex = [0, top + 0.62, (zb + zf) / 2], fy = top + 0.12;
  k.paint(WHITE, 0.6, 0.4).occ(0.6);
  k.quad([-ex, top, ez0], [ex, top, ez0], [ex, top, ez1], [-ex, top, ez1]);
  k.occ(1).paint(coral, 0.55, 0.4);
  const eave = [[-ex, ez1], [ex, ez1], [ex, ez0], [-ex, ez0]];
  for (let e = 0; e < 4; e++) { const p = eave[e], q = eave[(e + 1) % 4]; k.quad([p[0], top, p[1]], [q[0], top, q[1]], [q[0], fy, q[1]], [p[0], fy, p[1]]); }
  k.roof(coral, 2, 0.35);
  for (let e = 0; e < 4; e++) {
    const p = [eave[e][0], fy, eave[e][1]], q = [eave[(e + 1) % 4][0], fy, eave[(e + 1) % 4][1]], w = vlen(vsub(q, p)), midp = [(p[0] + q[0]) / 2, fy, (p[2] + q[2]) / 2], slope = vlen(vsub(apex, midp));
    const n = [q[2] - p[2], 0, p[0] - q[0]], nn = vnorm([n[0] * (apex[1] - fy), Math.hypot(n[0], n[2]) * Math.hypot(apex[0] - midp[0], apex[2] - midp[2]), n[2] * (apex[1] - fy)]), b = k.b;
    const v = b.vertex(p[0], p[1], p[2], nn[0], nn[1], nn[2], 0, 0); b.vertex(q[0], q[1], q[2], nn[0], nn[1], nn[2], w, 0); b.vertex(apex[0], apex[1], apex[2], nn[0], nn[1], nn[2], w / 2, slope);
    b.tri(v, v + 1, v + 2);
  }
  // deck rail with a gap for the ramp, the ramp, notices, flag
  const rail = (q) => q.paint(yellow, 0.55, 0.4), e = half - 0.05;
  rail(k);
  railing(k, [[0.47, deckY, e], [e, deckY, e], [e, deckY, -e], [-e, deckY, -e], [-e, deckY, e], [-0.47, deckY, e]], { height: 0.9, r: 0.035, square: true, mids: k.near ? 2 : 1, postEvery: 1.5 });
  ramp(k, deckY, half, rail);
  notices(k, deckY, e + 0.045);
  flag(k, [ex - 0.03, fy - 0.06, ez1 - 0.03], [0.3, 1.45, 0.3], [0.85, 0.1, 0.08]);
}

function decoTower(k) {
  const deckY = 1.7, R = 1.95, cz = -0.3, r = 1.3, wallH = 2.25, top = deckY + wallH, n = k.n(20, 8);
  const lilac = C.lilac, aqua = C.aqua, sun = C.sun, pink = C.flamingo;
  // substructure: skids, four splayed pipe legs, braces, round deck
  const sub = k.mark();
  k.wood(C.timber, 0.85, 0.65);
  for (const x of [-1.5, 1.5]) k.box(x - 0.11, 0, -1.9, x + 0.11, 0.2, 1.9, { axis: 'z', r: k.near ? 0.02 : 0 });
  k.steel(lilac, 0.5, 0.25);
  const foot = (sx, sz) => [sx * 1.5, 0.2, sz * 1.5], head = (sx, sz) => [sx * 1.03, deckY - 0.14, sz * 1.03];      // inside the deck slab: a leg cut square on its slope would show its open end below the underside
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl(foot(sx, sz), head(sx, sz), 0.075, 0.075, k.n(10, 5), { stops: [0.5], capA: true });      // the splayed foot stands partly proud of the skid
  if (k.mid) {
    k.steel(sun, 0.5, 0.25);
    for (const s of [-1, 1]) for (const d of [-1, 1]) {
      k.cyl(vmad(foot(s, -d), [0, 1, 0], 0.15), vmad(head(s, d), [0, 1, 0], -0.16), 0.028, 0.028, 5);
      k.cyl(vmad(foot(-d, s), [0, 1, 0], 0.15), vmad(head(d, s), [0, 1, 0], -0.16), 0.028, 0.028, 5);
    }
  }
  k.under(sub, deckY - 0.2, 0.8, 0.45).ground(sub, 0.35, 0.4);
  k.paint(pink, 0.55, 0.4);
  k.lathe([0, 0, 0], Y, [[deckY - 0.2, 0], [deckY - 0.2, R - 0.08], [deckY - 0.16, R], [deckY - 0.04, R]], n, { crease: 40 });
  k.wood(C.timberPale, 0.8, 0.5);
  k.lathe([0, 0, 0], Y, [[deckY - 0.04, R], [deckY - 0.04, R + 0.03], [deckY, R + 0.03], [deckY, 0]], n, { crease: 40 });      // the boards overhang the fascia: the overhang has an underside
  // drum cabin in horizontal bands
  const drum = k.mark();
  for (const [a, b, col] of [[0, 0.5, lilac], [0.5, 0.64, sun], [0.64, 1.72, WHITE], [1.72, 1.86, sun], [1.86, wallH, pink]]) { k.paint(col, 0.55, 0.4); k.lathe([0, deckY, cz], Y, [[a, r], [b, r]], n); }
  k.ground(drum, 0.3, 0.35, deckY).under(drum, top, 0.5, 0.45);
  if (k.mid) {
    // portholes: a chrome ring and dark glass, on the sides and the back quarters
    for (const a of [Math.PI / 2, -Math.PI / 2, Math.PI * 0.82, -Math.PI * 0.82]) {
      const d = [Math.sin(a), 0, Math.cos(a)], o = [d[0] * (r - 0.05), deckY + 1.2, cz + d[2] * (r - 0.05)], pn = k.n(12, 6);
      k.bare(0, 0.3); k.lathe(o, d, [[0, 0.33], [0.1, 0.33], [0.1, 0.27], [0.075, 0.27]], pn, { crease: 40 });
      k.darkGlass([0.06, 0.09, 0.11], 0.08, 0.6); k.lathe(o, d, [[0.075, 0.27], [0.075, 0]], pn);
    }
  }
  // door surround facing the sea, stepped at the top, with the door set in it
  k.paint(aqua, 0.55, 0.4);
  const door = k.mark(), zs = cz + r + 0.1;
  k.extrude([[-0.62, 0], [0.62, 0], [0.62, 1.95], [0.47, 1.95], [0.47, 2.1], [-0.47, 2.1], [-0.47, 1.95], [-0.62, 1.95]], [0, deckY, cz + r - 0.5], X, Y, 0.6);
  k.ground(door, 0.25, 0.35, deckY);
  if (k.mid) {
    k.paint(pink, 0.5, 0.35); k.box(-0.42, deckY, zs, 0.42, deckY + 1.9, zs + 0.025);
    k.bare(0, 0.3); k.lathe([0, deckY + 1.42, zs + 0.02], Z, [[0, 0.2], [0.03, 0.2], [0.03, 0.15], [0.02, 0.15]], k.n(14, 8), { crease: 40 });
    k.darkGlass([0.06, 0.09, 0.11], 0.08, 0.6); k.lathe([0, deckY + 1.42, zs + 0.02], Z, [[0.02, 0.15], [0.02, 0]], k.n(14, 8));
  }
  // disc roof far wider than the drum, a smaller disc on it, and a stepped fin over the door
  k.paint(pink, 0.5, 0.4);
  const roofR = 2.05, roof = k.mark();
  k.lathe([0, top, cz], Y, [[0, 0], [0, roofR - 0.1], [0.03, roofR - 0.02], [0.09, roofR], [0.14, roofR - 0.04], [0.15, 1.5]], n, { crease: 50 });
  k.shade(roof, (x, y) => (y < top + 0.005 ? 0.6 : 1));
  k.paint(sun, 0.5, 0.4);
  k.lathe([0, top + 0.15, cz], Y, [[0, 1.5], [0.1, 1.5], [0.1, 0]], n, { crease: 40 });
  k.paint(lilac, 0.5, 0.4);
  const fy = top + 0.25, fin = k.mark();
  k.extrude([[0, -1.2], [0, 1.25], [0.5, 1.25], [0.5, 0.95], [0.95, 0.95], [0.95, 0.65], [1.2, 0.65], [1.2, 0.35], [0.5, -1.2]], [-0.08, fy, cz], Y, Z, 0.16, { crease: 30 });
  k.joint(fin, [0, fy, cz], 0.5, 0.3);
  if (k.mid) { k.paint(aqua, 0.5, 0.4); for (const [y, z0] of [[0.3, 1.25], [0.75, 0.95], [1.08, 0.65]]) k.box(-0.11, fy + y - 0.035, cz + z0 - 0.5, 0.11, fy + y + 0.035, cz + z0 + 0.03, { axis: 'z' }); }
  // pipe rail round the deck with a gap for the ramp
  const rail = (q) => q.steel(sun, 0.5, 0.25), pts = [], gap = Math.asin(0.47 / (R - 0.06)), segs = k.n(14, 7);
  for (let i = 0; i <= segs; i++) { const a = gap + (TAU - 2 * gap) * i / segs; pts.push([Math.sin(a) * (R - 0.06), deckY, Math.cos(a) * (R - 0.06)]); }
  rail(k);
  railing(k, pts, { height: 0.95, r: 0.024, mids: k.near ? 2 : 1, postEvery: 3, n: k.n(8, 4) });
  ramp(k, deckY, Math.cos(gap) * (R - 0.06) + 0.06, (q) => q.paint(sun, 0.55, 0.4));
  flag(k, [-0.95, top + 0.25, cz - 0.75], [0, 1.25, 0], [0.95, 0.75, 0.1]);
}

// ---------------------------------------------------------------- umbrella
function umbrella(k) {
  const hubY = 2.02, tiltY = 1.5, R = 1.06, drop = 0.36, tilt = 0.24, gores = 8;
  k.paint(WHITE, 0.4, 0.3);
  const pole = k.mark();
  k.cyl([0, 0, 0], [0, tiltY, 0], 0.021, 0.021, k.n(8, 4), { capB: true });
  k.ground(pole, 0.2, 0.5);
  // head: upper pole, canopy, ribs; built upright around the tilt joint and leaned as one
  const h = k.child(), top = hubY - tiltY;
  h.paint(WHITE, 0.4, 0.3);
  h.cyl([0, -0.03, 0], [0, top + 0.05, 0], 0.017, 0.017, h.n(8, 4));
  if (h.mid) { h.bare(1, 0.4, C.alu); h.cyl([0, -0.05, 0], [0, 0.05, 0], 0.028, 0.028, h.n(8, 5), { capA: true, capB: true }); h.plastic(WHITE, 0.4); h.ellipsoid([0, top + 0.07, 0], 0.03, 0.035, 0.03, 8, 4); }
  // canvas: each gore is a flat-ish panel; u is constant within a gore so the stripe material alternates gore by gore
  h.fabric(WHITE, 1, 4).tintKey();
  const ring = (i, rad, y) => { const a = i / gores * TAU; return [Math.sin(a) * rad, y, Math.cos(a) * rad]; }, m = h.mark();
  for (let g = 0; g < gores; g++) {
    const rows = [[ring(g, R, top - drop - 0.1), ring(g + 1, R, top - drop - 0.1)], [ring(g, R, top - drop), ring(g + 1, R, top - drop)], [ring(g, R * 0.52, top - drop * 0.36), ring(g + 1, R * 0.52, top - drop * 0.36)], [[0, top, 0], [0, top, 0]]];
    const vs = [0, 0.1, 0.1 + 0.56, 0.1 + 1.12];
    h.loft(rows, { crease: 50, uv: (i, j) => [(g + 0.5) * 0.12 + (j ? 0.035 : -0.035), vs[i]] });
  }
  const outside = h.b.count;
  h.twoSided(m, null, 0.004);
  h.dim(outside, 0.62);                                              // the underside sits in its own shade
  if (h.near) {
    h.bare(1, 0.45, C.alu);
    for (let g = 0; g < gores; g++) {
      const tip = ring(g, R * 0.99, top - drop - 0.012), midp = ring(g, R * 0.5, top - 0.03 - (drop - 0.02) * 0.5);
      h.cyl([0, top - 0.03, 0], tip, 0.005, 0.005, 3);
      h.cyl([0, top - 0.52, 0], midp, 0.004, 0.004, 3);
    }
    h.cyl([0, top - 0.55, 0], [0, top - 0.49, 0], 0.026, 0.026, 6, { capA: true, capB: true });      // runner
  }
  k.add(h, place(0, tiltY, 0, 0, 0, tilt));
}

// ---------------------------------------------------------------- sun lounger
function lounger(k) {
  const hw = 0.31, y = 0.3, zFoot = 0.975, zHinge = -0.28, backLen = 0.72, ang = 38 * Math.PI / 180, zTop = zHinge - Math.cos(ang) * backLen, yTop = y + Math.sin(ang) * backLen, n = k.n(8, 4), r = 0.016;
  k.paint(WHITE, 0.4, 0.3);
  const frame = k.mark();
  for (const sx of [-hw, hw]) {
    k.cyl([sx, y, zFoot], [sx, y, -0.95], r, r, n, { capA: true, capB: true });
    k.cyl([sx, y, zHinge], [sx, yTop, zTop], r, r, n, { capA: true, capB: true });
    if (k.mid) k.cyl([sx, y + (yTop - y) * 0.62, zHinge + (zTop - zHinge) * 0.62], [sx, y, -0.9], r * 0.75, r * 0.75, Math.max(4, n - 2), { capA: true, capB: true });   // back prop
  }
  for (const [py, pz] of [[y, zFoot], [yTop, zTop], [y, -0.95]]) k.cyl([-hw - r, py, pz], [hw + r, py, pz], r, r, n, { capA: true, capB: true });
  for (const z of [0.68, -0.72]) {
    if (k.mid) k.tube([[-hw, y, z], [-hw, 0.04, z + 0.07], [-hw + 0.03, 0.016, z + 0.07], [hw - 0.03, 0.016, z + 0.07], [hw, 0.04, z + 0.07], [hw, y, z]], r * 0.9, n, { capA: true, capB: true });
    else for (const sx of [-hw, hw]) k.cyl([sx, 0, z + 0.07], [sx, y, z], r, r, n);
  }
  k.ground(frame, 0.12, 0.45);
  // sling: canvas stretched between the rails, seat and raised back
  k.fabric(WHITE, 1, 4).tintKey();
  const m = k.mark(), w = hw - 0.012, sling = (a, b, v0, v1) => k.quad([-w, a[0], a[1]], [w, a[0], a[1]], [w, b[0], b[1]], [-w, b[0], b[1]], [0, v0, 2 * w, v0, 2 * w, v1, 0, v1]);
  sling([y + 0.006, zFoot - 0.02], [y + 0.006, zHinge], 0, zFoot - 0.02 - zHinge);
  sling([y + 0.006, zHinge], [yTop + 0.004, zTop + 0.01], zFoot - zHinge, zFoot - zHinge + backLen);
  const outside = k.b.count;
  k.twoSided(m, null, 0.006);
  k.dim(outside, 0.6);
}

// ---------------------------------------------------------------- volleyball net
function volleyball(k) {
  const px = 5.05, hx = 4.75, topY = 2.43, botY = 1.43, n = k.n(10, 5);
  k.bare(2, 0.5, C.galv);
  const posts = k.mark();
  for (const s of [-1, 1]) {
    k.cyl([s * px, 0, 0], [s * px, 2.55, 0], 0.045, 0.045, n, { capB: true, stops: [0.12] });
    if (k.mid) { k.rubber([0.2, 0.18, 0.15], 0.9); k.cyl([s * px, 2.5, 0], [s * (px + 1.7), 0, 0], 0.006, 0.006, 3); k.bare(2, 0.5, C.galv); }   // guy line
  }
  k.ground(posts, 0.25, 0.45);
  // tapes top and bottom, side tapes, tie cords to the posts
  k.fabric(WHITE, 0);
  const tape = (a, b, hgt) => k.bar(a, b, 0.012, hgt, { up: Y });
  tape([-hx, topY - 0.035, 0], [hx, topY - 0.035, 0], 0.07);
  tape([-hx, botY + 0.025, 0], [hx, botY + 0.025, 0], 0.05);
  if (k.mid) for (const s of [-1, 1]) {
    k.bar([s * hx, botY, 0], [s * hx, topY, 0], 0.012, 0.05, { up: X });
    for (const yy of [topY - 0.035, botY + 0.025]) k.cyl([s * hx, yy, 0], [s * px, yy + 0.04, 0], 0.005, 0.005, 3);
  }
  if (k.lod === 2) return;
  // the mesh, coarser than the real 100 mm so that it reads at a distance: thin dark strips, both sides
  k.rubber([0.1, 0.1, 0.1], 0.9);
  const m = k.mark(), pitch = k.near ? 0.25 : 0.5, wd = k.near ? 0.008 : 0.014;
  for (let x = -hx + pitch; x < hx - 0.01; x += pitch) k.quad([x - wd, botY + 0.05, 0.002], [x + wd, botY + 0.05, 0.002], [x + wd, topY - 0.07, 0.002], [x - wd, topY - 0.07, 0.002]);
  for (let yy = botY + pitch; yy < topY - 0.1; yy += pitch) k.quad([-hx, yy - wd, 0.0025], [hx, yy - wd, 0.0025], [hx, yy + wd, 0.0025], [-hx, yy + wd, 0.0025]);
  k.twoSided(m, null, 0.005);
}

// ---------------------------------------------------------------- small boat
function boat(k) {
  const z0 = -2.0, L = 4.4, stations = k.n(12, 4), cols = k.n(10, 4);
  const beam = (t) => 0.84 * (t < 0.35 ? 0.88 + 0.12 * (t / 0.35) : Math.pow(Math.max(0, 1 - Math.pow((t - 0.35) / 0.65, 2.3)), 0.75)) + 0.012;
  const keel = (t) => 0.3 * Math.pow(Math.max(0, (t - 0.5) / 0.5), 1.8), sheer = (t) => 0.6 + 0.22 * t * t;
  /** Point of the hull section at station t; s in -1 (port gunwale) .. 0 (keel) .. 1 (starboard gunwale); inset shrinks it for the inside. */
  const hull = (t, s, inset = 0) => {
    const a = Math.abs(s) * Math.PI / 2, b = Math.max(0.006, beam(t) - inset), ky = keel(t) + inset * 1.4, sy = sheer(t);
    return [Math.sign(s) * b * Math.pow(Math.sin(a), 0.62), ky + (sy - ky) * (1 - Math.pow(Math.cos(a), 1.25)), z0 + t * L];
  };
  const shell = (inset) => { const rows = []; for (let i = 0; i <= stations; i++) { const row = []; for (let j = 0; j <= 2 * cols; j++) row.push(hull(i / stations, j / cols - 1, inset)); rows.push(row); } return rows; };
  // outside: colour from the instance tint
  k.paint(WHITE, 0.35, 0.35).tintKey();
  const out = k.mark();
  k.loft(shell(0), { crease: 70 });
  const stern = []; for (let j = 0; j <= 2 * cols; j++) stern.push(hull(0, j / cols - 1));
  for (let j = 0; j < 2 * cols; j++) k.tri([0, sheer(0), z0], stern[j + 1], stern[j]);          // transom
  const bow = shell(0)[stations];
  for (let j = 0; j < 2 * cols; j++) k.tri([0, sheer(1), z0 + L], bow[j], bow[j + 1]);
  k.ground(out, 0.25, 0.4);
  // inside: pale gel coat, darker towards the bilge
  k.paint([0.86, 0.87, 0.84], 0.45, 0.45);
  const inner = k.mark(), ins = 0.03;
  const zIn = (i, z) => (i === 0 ? z0 + ins : i === stations ? z - ins : z);             // the inner shell stops short of the transom and the stem
  k.loft(shell(ins).map((row, i) => row.map((p) => [p[0], p[1], zIn(i, p[2])])), { crease: 70, flip: true });
  const sternIn = []; for (let j = 0; j <= 2 * cols; j++) { const p = hull(0, j / cols - 1, ins); sternIn.push([p[0], p[1], z0 + ins]); }
  for (let j = 0; j < 2 * cols; j++) k.tri([0, sheer(0), z0 + ins], sternIn[j], sternIn[j + 1]);
  // stem: both shells end in a narrow U there, so each gets its own cap and the gunwale bridges them
  const bowIn = []; for (let j = 0; j <= 2 * cols; j++) { const p = hull(1, j / cols - 1, ins); bowIn.push([p[0], p[1], p[2] - ins]); }
  for (let j = 0; j < 2 * cols; j++) k.tri([0, sheer(1), z0 + L - ins], bowIn[j + 1], bowIn[j]);
  k.shade(inner, (x, y) => 0.55 + 0.45 * Math.min(1, y / 0.6));
  // gunwale: closes the gap between the two shells and carries the rub rail
  k.paint(WHITE, 0.4, 0.35);
  for (const s of [-1, 1]) {
    for (let i = 0; i < stations; i++) {
      const a = hull(i / stations, s), b = hull((i + 1) / stations, s), ai = hull(i / stations, s, ins), bi = hull((i + 1) / stations, s, ins);
      ai[2] = zIn(i, ai[2]); bi[2] = zIn(i + 1, bi[2]);
      if (s > 0) k.quad(b, a, ai, bi); else k.quad(a, b, bi, ai);
    }
  }
  k.quad(hull(0, 1), hull(0, -1), [hull(0, -1, ins)[0], sheer(0), z0 + ins], [hull(0, 1, ins)[0], sheer(0), z0 + ins]);
  k.quad(hull(1, -1), hull(1, 1), bowIn[2 * cols], bowIn[0]);
  if (k.mid) {
    k.rubber([0.08, 0.08, 0.08], 0.8);
    for (const s of [-1, 1]) { const pts = []; for (let i = 0; i <= stations; i++) { const p = hull(i / stations, s); pts.push([p[0] + s * 0.012, p[1] - 0.03, p[2]]); } k.tube(pts, 0.022, 5, { capA: true, capB: true }); }
    // thwarts
    k.wood(C.timberPale, 0.7, 0.45);
    for (const t of [0.3, 0.58]) {
      let s = 0.5; for (let it = 0; it < 12; it++) { const p = hull(t, s, ins); s += (0.4 - p[1]) * 0.6; }
      const half = hull(t, s, ins)[0] + 0.01, z = z0 + t * L;
      k.box(-half, 0.37, z - 0.13, half, 0.4, z + 0.13, { axis: 'x' });
    }
  }
  // outboard motor on the transom
  k.plastic([0.07, 0.09, 0.14], 0.4);
  const mot = k.mark();
  k.box(-0.16, 0.62, z0 - 0.42, 0.16, 1.0, z0 - 0.06, { axis: 'z', r: k.near ? 0.04 : 0 });
  k.steel([0.5, 0.52, 0.53], 0.5, 0.2);
  k.box(-0.05, 0.12, z0 - 0.3, 0.05, 0.62, z0 - 0.14);
  if (k.mid) {
    k.box(-0.12, 0.5, z0 - 0.1, 0.12, 0.72, z0 + 0.06);                                              // clamp bracket over the transom
    k.box(-0.012, 0.03, z0 - 0.38, 0.012, 0.3, z0 - 0.12);                                           // skeg
    k.rubber([0.05, 0.05, 0.05], 0.7); k.cyl([0, 0.86, z0 - 0.06], [0.1, 0.8, z0 + 0.42], 0.018, 0.022, 6, { capB: true });   // tiller
  }
  k.under(mot, 0.62, 0.3, 0.3);
}

// ---------------------------------------------------------------- mooring pile
function pierPost(k) {
  const n = k.n(14, 6), ys = k.mid ? [-3, -0.5, 0.2, 0.45, 0.9, 1.9] : [-3, 0.2, 0.9, 1.9], r = 0.17;
  k.wood([0.5, 0.41, 0.31], 0.9, 0.75);
  const m = k.mark();
  // turned as a lathe, like the cap and the rope: the facets of all three line up, so nothing opens between them
  k.lathe([0, 0, 0], Y, ys.map((y) => [y, r * (1 - 0.025 * y)]), n, { crease: 60 });
  // wet, weed-dark below the tide line, bleached above
  k.grime(m, (x, y) => (y < 0.3 ? 0.65 : 0.25 * Math.max(0, 1 - (y - 0.3) / 0.5)), [0.07, 0.08, 0.06]);
  k.shade(m, (x, y) => (y < 0.3 ? 0.7 : 1));
  k.bare(2, 0.6, C.galv);
  k.lathe([0, 1.9, 0], Y, [[-0.1, r * 0.9], [-0.1, r * 0.95 + 0.006], [0, r * 0.95 + 0.006], [0.07, 0]], n, { crease: 30 });     // sheet metal cap against rot
  if (k.mid) { k.fabric(C.rope, 0); for (const y of [1.25, 1.31, 1.37]) k.lathe([0, y, 0], Y, [[-0.028, r * 0.96], [0, r * 0.96 + 0.03], [0.028, r * 0.96]], n, { crease: 80 }); }
}

export const BEACH = [
  { name: 'lifeguard_tower_a', far: [45, 150, 600], footprint: 2.3, collider: { kind: 'box', hx: 1.5, hy: 2.1, hz: 1.5 }, tags: ['beach', 'large', 'tall'], build: timberTower,
    extra: { extraColliders: [{ kind: 'box', hx: 0.45, hy: 0.8, hz: 1.4, offset: [0, 0, 2.9] }] } },
  { name: 'lifeguard_tower_b', far: [45, 150, 600], footprint: 2.4, collider: { kind: 'cylinder', radius: 1.95, height: 4.1 }, tags: ['beach', 'large', 'tall'], build: decoTower,
    extra: { extraColliders: [{ kind: 'box', hx: 0.45, hy: 0.85, hz: 1.45, offset: [0, 0, 3.4] }] } },
  { name: 'umbrella_a', far: [30, 120], footprint: 1.2, collider: { kind: 'cylinder', radius: 0.04, height: 1.5 }, tags: ['beach', 'small', 'tint'], build: umbrella },
  { name: 'lounger', far: [25, 90], footprint: 1.05, collider: { kind: 'box', hx: 0.33, hy: 0.2, hz: 0.98 }, tags: ['beach', 'small', 'tint'], build: lounger },
  { name: 'volleyball_net', far: [30, 100, 300], footprint: 5.2, collider: { kind: 'box', hx: 5.1, hy: 1.25, hz: 0.06 }, tags: ['beach', 'small'], build: volleyball },
  { name: 'boat_small', far: [35, 130, 400], footprint: 2.5, collider: { kind: 'box', hx: 0.86, hy: 0.42, hz: 2.3 }, tags: ['beach', 'dock', 'large', 'tint'], build: boat, extra: { waterline: 0.2 } },
  { name: 'pier_post', far: [35, 140], footprint: 0.3, collider: { kind: 'cylinder', radius: 0.18, height: 1.95 }, tags: ['beach', 'dock', 'small'], build: pierPost, extra: { originAtWater: true, depth: 3 } },
];
