// The room itself: the epoxy floor, four painted block walls on piers, the roof steel, the ducting, the roller door
// with its guides and hood, the side door and the glass block panel.

import { smoothstep } from '../../core/math.js';
import { vmad } from '../props/kit.js';
import { edges } from './setkit.js';
import { ROOM, TURNTABLE, DOOR, SIDE_DOOR, GLASS_BLOCK, BAND, FEATURE, COLOR, RADIANCE } from './plan.js';

const PIER = { w: 0.4, d: 0.2 }, TRUSS_Z = [-7.5, -4.5, -1.5, 1.5, 4.5, 7.5], TRUSS_TOP = 5.36, LINE = { off: 0.62, w: 0.1 };
const CURTAIN_Z = ROOM.z1 + 0.11;            // the curtain runs in the wall's thickness and rises behind the lintel

/**
 * The floor: one flat sheet at y = 0, uv in floor metres, with the dust that gathers where nobody drives baked into
 * its occlusion (1 = mirror clean, 0.5 = dull at the wall foot and under whatever stands on it).
 * The slab's saw cuts (drawn by the surface on every third metre of uv) are set out from the piers, as a
 * contractor would, so none runs under the middle of the car.
 *   footprints  [{ x0, z0, x1, z1 }] of the things that stand on the floor
 */
const SAW_CUT = 1.5;
export function buildFloor(k, footprints) {
  const { x0, x1, z0, z1 } = ROOM, lo = LINE.off, hi = LINE.off + LINE.w;
  const xs = edges(x0, x1, 0.5, [x0 + 0.2, x0 + lo, x0 + hi, x1 - 0.2, x1 - lo, x1 - hi]);
  const zs = edges(z0, z1, 0.5, [z0 + 0.2, z0 + lo, z0 + hi, z1 - 0.2, z1 - lo, z1 - hi]);
  const edge = (x, z) => Math.min(x - x0, x1 - x, z - z0, z1 - z);
  const dust = (x, z) => {
    let clean = 0.5 + 0.5 * smoothstep(0, 0.55, edge(x, z));
    for (const f of footprints) {
      const d = Math.max(f.x0 - x, x - f.x1, f.z0 - z, z - f.z1);              // distance outside the footprint
      clean = Math.min(clean, 0.45 + 0.55 * smoothstep(-0.05, 0.4, d));
    }
    // the ring is swept round but never under its lip
    return Math.min(clean, 0.6 + 0.4 * smoothstep(0, 0.25, Math.abs(Math.hypot(x, z) - TURNTABLE.ring)));
  };
  k.sheet([0, 0, 0], [1, 0, 0], [0, 0, -1], xs, zs.map((z) => -z).reverse(), (x, w) => {
    const z = -w, e = edge(x, z);
    if (Math.hypot(Math.abs(x) + 0.25, Math.abs(z) + 0.25) < TURNTABLE.disc - 0.1) return false;   // hidden under the disc
    // the painted border line stops either side of the roller door
    const line = e > lo && e < hi && !(z > z1 - hi - 0.01 && Math.abs(x) < DOOR.x1 + 0.3);
    if (line) k.epoxy(COLOR.line, 0.4, 0.92); else k.epoxy(COLOR.epoxy, 0.1, 0.62);
  }, (x, w) => dust(x, -w), (x, w) => [x + SAW_CUT, -w + SAW_CUT]);
  return k;
}

// ------------------------------------------------------------------------------------------------------ walls
// Inner faces in order round the room, so that the block courses run on unbroken through the corners.
const WALLS = [
  { id: 'back', origin: [ROOM.x0, 0, ROOM.z0], U: [1, 0, 0], length: 14, start: 0 },
  { id: 'east', origin: [ROOM.x1, 0, ROOM.z0], U: [0, 0, 1], length: 18, start: 14 },
  { id: 'front', origin: [ROOM.x1, 0, ROOM.z1], U: [-1, 0, 0], length: 14, start: 32 },
  { id: 'west', origin: [ROOM.x0, 0, ROOM.z1], U: [0, 0, -1], length: 18, start: 46 },
];
const wallColor = (y) => (y < BAND.dado ? COLOR.dado : y < BAND.teal ? COLOR.teal : y < BAND.gap ? COLOR.wall : y < BAND.pink ? COLOR.pink : COLOR.wall);
const V_EDGES = [0.12, BAND.dado, BAND.teal, BAND.gap, BAND.pink, FEATURE.y0, ROOM.truss];

/** Holes in a wall, in its own (u, y) coordinates: { u0, u1, y0, y1, depth (of the reveal) }. */
function holes(id) {
  if (id === 'front') return [{ u0: 7 - DOOR.x1, u1: 7 - DOOR.x0, y0: 0, y1: DOOR.top, depth: ROOM.wall }];
  if (id === 'east') return [
    { u0: SIDE_DOOR.z0 - ROOM.z0, u1: SIDE_DOOR.z1 - ROOM.z0, y0: 0, y1: SIDE_DOOR.top, depth: 0.09 },
    { u0: GLASS_BLOCK.z0 - ROOM.z0, u1: GLASS_BLOCK.z1 - ROOM.z0, y0: GLASS_BLOCK.y0, y1: GLASS_BLOCK.y1, depth: 0.07 },
  ];
  return [];
}

function buildWalls(k) {
  for (const w of WALLS) {
    const cut = holes(w.id), N = [-w.U[2], 0, w.U[0]];                         // U x up: into the room
    const us = edges(0, w.length, 1, [0.35, w.length - 0.35, ...cut.flatMap((h) => [h.u0, h.u1]), ...(w.id === 'back' ? [FEATURE.x0 + 7, FEATURE.x1 + 7] : [])]);
    const vs = edges(0, ROOM.deck, 0.5, [...V_EDGES, ...cut.flatMap((h) => [h.y0, h.y1])]);
    // dirt and shade: the foot of the wall, the corners of the room, and the dark up among the roof steel
    const shade = (u, y) => (0.72 + 0.28 * smoothstep(0, 0.3, y)) * (0.7 + 0.3 * smoothstep(0, 0.45, Math.min(u, w.length - u))) * (1 - 0.45 * smoothstep(ROOM.truss - 0.4, ROOM.deck, y));
    k.sheet(w.origin, w.U, [0, 1, 0], us, vs, (u, y) => {
      if (cut.some((h) => u > h.u0 && u < h.u1 && y > h.y0 && y < h.y1)) return false;
      const feature = w.id === 'back' && u > FEATURE.x0 + 7 && u < FEATURE.x1 + 7 && y > FEATURE.y0 && y < FEATURE.y1;
      k.block(feature ? COLOR.feature : wallColor(y), y < BAND.dado ? 0.3 : 0.42, y < BAND.dado ? 0.55 : 0.35);
    }, shade, (u, y) => [w.start + u, y]);
    // reveals: the wall's thickness shown round every opening, painted with the wall
    for (const h of cut) {
      const P = (u, y, d) => vmad(vmad(vmad(w.origin, w.U, u), [0, 1, 0], y), N, -d), d = h.depth;
      const side = (u, a, b) => {                                             // a jamb, wound to face into the opening
        for (const [ya, yb] of pairs(edges(h.y0, h.y1, 0.6, V_EDGES))) {
          k.block(wallColor((ya + yb) / 2), 0.4, 0.4).occ(0.7);
          const q = [P(u, ya, a), P(u, ya, b), P(u, yb, b), P(u, yb, a)];
          k.quad(q[0], q[1], q[2], q[3], [w.start + u + a, ya, w.start + u + b, ya, w.start + u + b, yb, w.start + u + a, yb]);
        }
      };
      side(h.u0, 0, d); side(h.u1, d, 0);
      k.block(COLOR.wall, 0.4, 0.4).occ(0.6);
      k.quad(P(h.u0, h.y1, d), P(h.u1, h.y1, d), P(h.u1, h.y1, 0), P(h.u0, h.y1, 0), [w.start + h.u0, h.y1 + d, w.start + h.u1, h.y1 + d, w.start + h.u1, h.y1, w.start + h.u0, h.y1]);   // head
      if (h.y0 > 0) k.quad(P(h.u0, h.y0, 0), P(h.u1, h.y0, 0), P(h.u1, h.y0, d), P(h.u0, h.y0, d), [w.start + h.u0, h.y0, w.start + h.u1, h.y0, w.start + h.u1, h.y0 - d, w.start + h.u0, h.y0 - d]);   // sill
    }
  }
  // piers under the trusses on both side walls: three block faces each, coursed with the wall behind
  for (const s of [-1, 1]) for (const z of TRUSS_Z) {
    const xw = s * ROOM.x1, xf = s * (ROOM.x1 - PIER.d), za = z - PIER.w / 2, zb = z + PIER.w / 2, vs = edges(0, ROOM.truss, 0.5, V_EDGES);
    const start = s > 0 ? 14 + (z - ROOM.z0) : 46 + (ROOM.z1 - z);
    const face = (a, b, u0, u1, occ) => {
      for (const [ya, yb] of pairs(vs)) {
        k.block(wallColor((ya + yb) / 2), ya < BAND.dado ? 0.3 : 0.42, ya < BAND.dado ? 0.55 : 0.35);
        const sh = (y) => (0.72 + 0.28 * smoothstep(0, 0.3, y)) * occ;
        const m = k.mark();
        k.quad([a[0], ya, a[1]], [b[0], ya, b[1]], [b[0], yb, b[1]], [a[0], yb, a[1]], [u0, ya, u1, ya, u1, yb, u0, yb]);
        k.shade(m, (x, y) => sh(y));
      }
    };
    // wound counter-clockwise seen from the room: on the east wall that is +z to -z across the face
    if (s > 0) { face([xw, za], [xf, za], start - 0.4, start - 0.2, 0.82); face([xf, za], [xf, zb], start - 0.2, start + 0.2, 1); face([xf, zb], [xw, zb], start + 0.2, start + 0.4, 0.82); }
    else { face([xw, zb], [xf, zb], start - 0.4, start - 0.2, 0.82); face([xf, zb], [xf, za], start - 0.2, start + 0.2, 1); face([xf, za], [xw, za], start + 0.2, start + 0.4, 0.82); }
    // padstone and bearing plate under the truss shoe
    k.concrete([0.5, 0.5, 0.48], 0, 0.4); k.box(Math.min(xw, xf) - (s > 0 ? 0.03 : 0), ROOM.truss - 0.1, za - 0.02, Math.max(xw, xf) + (s > 0 ? 0 : 0.03), ROOM.truss, zb + 0.02, { r: 0.008 });
  }
  // the floor coat turned 100 mm up the wall as a cove, the way a resin floor is finished
  k.paint([0.085, 0.09, 0.1], 0.3, 0.5);
  const cove = (a, b) => { if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) k.bar([a[0], 0.05, a[1]], [b[0], 0.05, b[1]], 0.012, 0.1, { r: 0.004 }); };
  const t = 0.006, { x0, x1, z0, z1 } = ROOM;
  cove([x0, z0 + t], [x1, z0 + t]); cove([x0 + t, z0], [x0 + t, z1]);
  cove([x0, z1 - t], [DOOR.x0, z1 - t]); cove([DOOR.x1, z1 - t], [x1, z1 - t]);
  cove([x1 - t, z0], [x1 - t, SIDE_DOOR.z0 - 0.06]); cove([x1 - t, SIDE_DOOR.z1 + 0.06], [x1 - t, z1]);
}
const pairs = (list) => list.slice(1).map((b, i) => [list[i], b]);

// ------------------------------------------------------------------------------------------------------ roof
function buildRoof(k) {
  const { x0, x1, z0, z1, deck, truss } = ROOM;
  // trapezoidal steel deck seen from below, ribs along x over the purlins
  k.steel(COLOR.deck, 0.7, 0.2).occ(0.55);
  const pitch = 0.3, n = Math.round((z1 - z0) / pitch);
  for (let i = 0; i < n; i++) {
    const a = z0 + i * pitch, y = deck, h = 0.045;
    const prof = [[a, y], [a + 0.11, y], [a + 0.14, y + h], [a + 0.27, y + h], [a + 0.3, y]];
    for (let j = 0; j < prof.length - 1; j++) k.quad([x0, prof[j][1], prof[j][0]], [x1, prof[j][1], prof[j][0]], [x1, prof[j + 1][1], prof[j + 1][0]], [x0, prof[j + 1][1], prof[j + 1][0]]);
  }
  // purlins along the room on the trusses' top chords
  k.steel(COLOR.deck, 0.6, 0.25).occ(0.6);
  for (let x = -6; x <= 6.01; x += 2) k.bar([x, deck - 0.07, z0], [x, deck - 0.07, z1], 0.06, 0.14, { r: 0.004, capA: false, capB: false });

  // Warren trusses: chords of back-to-back angles (read as one tee from below), web angles, gusset plates
  for (const z of TRUSS_Z) {
    const m = k.mark(), bays = 10, step = (x1 - x0) / bays, yb = truss + 0.05, yt = TRUSS_TOP - 0.05;
    k.steel(COLOR.steelDark, 0.55, 0.3);
    k.bar([x0, yb, z], [x1, yb, z], 0.13, 0.1, { r: 0.006, capA: false, capB: false });
    k.bar([x0, yt, z], [x1, yt, z], 0.13, 0.1, { r: 0.006, capA: false, capB: false });
    for (let i = 0; i < bays; i++) {
      const a = x0 + i * step, b = a + step, mid = (a + b) / 2;
      k.bar([a + 0.04, yt - 0.03, z], [mid, yb + 0.03, z], 0.065, 0.065, { up: [0, 0, 1], r: 0.004 });
      k.bar([mid, yb + 0.03, z], [b - 0.04, yt - 0.03, z], 0.065, 0.065, { up: [0, 0, 1], r: 0.004 });
      // gussets where the webs meet the chords, bolted
      k.box(mid - 0.14, yb - 0.02, z - 0.074, mid + 0.14, yb + 0.2, z - 0.066, { r: 0 }); k.box(mid - 0.14, yb - 0.02, z + 0.066, mid + 0.14, yb + 0.2, z + 0.074, { r: 0 });
      if (i > 0) { k.box(a - 0.14, yt - 0.2, z - 0.074, a + 0.14, yt + 0.02, z - 0.066, { r: 0 }); k.box(a - 0.14, yt - 0.2, z + 0.066, a + 0.14, yt + 0.02, z + 0.074, { r: 0 }); }
      for (const side of [-1, 1]) for (const dx of [-0.08, 0, 0.08]) k.bolt([mid + dx, yb + 0.1, z + side * 0.074], [0, 0, side], 0.011, 0.008);
    }
    k.shade(m, (x, y) => 1 - 0.4 * smoothstep(truss, deck, y));
  }

  // spiral duct through the webs, strapped to every truss, with two grilles dropping from it
  const dx = -3.5, dy = 5.0, r = 0.21;
  const m = k.mark();
  k.bare(2, 0.55, [0.62, 0.64, 0.65]);
  const stops = []; for (let i = 1; i < 12; i++) stops.push(i / 12);
  k.cyl([dx, dy, z0 + 0.35], [dx, dy, z1 - 1.2], r, r, k.n(20, 12), { capB: true, stops });
  for (let i = 0; i <= 12; i++) { const z = z0 + 0.35 + (z1 - 1.55 - z0) * i / 12; k.cyl([dx, dy, z - 0.02], [dx, dy, z + 0.02], r + 0.008, r + 0.008, k.n(20, 12), { capA: true, capB: true }); }
  k.steel(COLOR.steelDark, 0.6, 0.3);
  for (const z of TRUSS_Z) for (const s of [-1, 1]) k.bar([dx + s * (r + 0.004), dy, z + 0.12], [dx + s * (r + 0.004), TRUSS_TOP - 0.1, z + 0.12], 0.004, 0.03, { up: [0, 0, 1], r: 0 });
  for (const z of [-3, 3]) {
    k.bare(2, 0.55, [0.62, 0.64, 0.65]); k.box(dx - 0.16, dy - r - 0.26, z - 0.16, dx + 0.16, dy - r + 0.05, z + 0.16, { r: 0.004 });
    k.steel([0.5, 0.5, 0.5], 0.5, 0.25); k.box(dx - 0.22, dy - r - 0.29, z - 0.22, dx + 0.22, dy - r - 0.26, z + 0.22, { r: 0.004 });
    k.steel([0.08, 0.08, 0.08], 0.7, 0.1);
    for (let i = 0; i < 7; i++) k.box(dx - 0.19, dy - r - 0.294, z - 0.18 + i * 0.055, dx + 0.19, dy - r - 0.29, z - 0.15 + i * 0.055, { r: 0 });
  }
  k.shade(m, (x, y) => 0.55 + 0.25 * smoothstep(dy + r, dy - r, y));
}

// ------------------------------------------------------------------------------------------------------ openings
function buildDoorSurround(k) {
  const { x0, x1, top } = DOOR, z = ROOM.z1, zc = CURTAIN_Z;
  // guides: a channel in each jamb that the curtain's ends run in
  k.steel(COLOR.steelGrey, 0.5, 0.35);
  for (const s of [-1, 1]) {
    const x = s > 0 ? x1 : x0;
    for (const dz of [-0.035, 0.035]) k.box(Math.min(x, x - s * 0.075), 0, zc + dz - 0.004, Math.max(x, x - s * 0.075), top, zc + dz + 0.004, { r: 0 });
    k.box(Math.min(x - s * 0.006, x), 0, zc - 0.035, Math.max(x - s * 0.006, x), top, zc + 0.035, { r: 0 });
    // bollard-yellow corner guards on the inner arris, where a car would catch the wall
    k.steel([0.72, 0.56, 0.1], 0.45, 0.4);
    k.box(Math.min(x, x + s * 0.09), 0, z - 0.012, Math.max(x, x + s * 0.09), 1.2, z - 0.004, { r: 0 });
    k.box(x - (s > 0 ? 0.008 : 0), 0, z - 0.004, x + (s > 0 ? 0 : 0.008), 1.2, z + 0.085, { r: 0 });
    for (const y of [0.15, 0.6, 1.05]) k.bolt([x + s * 0.05, y, z - 0.012], [0, 0, -1], 0.008, 0.006);
    k.steel(COLOR.steelGrey, 0.5, 0.35);
  }
  // hood over the head on the room side, on end plates, with the operator and its hand chain at one end
  const m = k.mark();
  k.steel(COLOR.steelGrey, 0.5, 0.3);
  const prof = [[0, 0], [0.36, 0], [0.42, 0.06], [0.42, 0.36], [0.36, 0.42], [0, 0.42]];
  k.extrude(prof, [x0 - 0.3, top + 0.04, z], [0, 0, -1], [0, 1, 0], x1 - x0 + 0.6, { crease: 20 });
  for (const s of [-1, 1]) {
    const x = s > 0 ? x1 + 0.3 : x0 - 0.3;
    k.box(Math.min(x, x + s * 0.008), top - 0.02, z - 0.46, Math.max(x, x + s * 0.008), top + 0.5, z, { r: 0 });
    for (const [dy, dz] of [[0.06, -0.06], [0.42, -0.06], [0.06, -0.4], [0.42, -0.4]]) k.bolt([x + s * 0.008, top + dy, z + dz], [s, 0, 0], 0.01, 0.007);
  }
  k.shade(m, (x, y) => 0.7 + 0.3 * smoothstep(top + 0.46, top, y));
  k.steel([0.2, 0.22, 0.24], 0.5, 0.3);
  k.box(x1 + 0.31, top + 0.08, z - 0.36, x1 + 0.56, top + 0.36, z - 0.06, { r: 0.012 });        // operator gearbox
  k.bare(2, 0.5, [0.6, 0.6, 0.6]);
  for (const dz of [-0.26, -0.16]) {                                                               // hand chain loop
    const pts = []; for (let i = 0; i <= 8; i++) pts.push([x1 + 0.62, top + 0.2 - i * 0.3, z + dz]);
    k.tube(pts, 0.004, 4, { capB: true });
  }
  k.cyl([x1 + 0.62, top - 2.2, z - 0.264], [x1 + 0.62, top - 2.2, z - 0.156], 0.004, 0.004, 4, { capA: true, capB: true });
  k.steel(COLOR.steelGrey, 0.5, 0.3); k.box(x1 + 0.56, top + 0.12, z - 0.3, x1 + 0.66, top + 0.3, z - 0.12, { r: 0.006 });
  // threshold: a steel angle let into the slab under the curtain
  k.bare(1, 0.6, [0.5, 0.5, 0.5]); k.box(x0, -0.02, z - 0.01, x1, 0.003, z + 0.22, { r: 0 });
}

/**
 * The roller door curtain, a separate mesh that moves up: interlocking curved slats on a 75 mm pitch and a bottom
 * rail with its rubber seal. Seen only from the room.
 */
export function buildCurtain(k) {
  const { x0, x1, top, gap } = DOOR, z = CURTAIN_Z, pitch = 0.075, n = Math.ceil((top + 0.15 - gap - 0.07) / pitch);
  const xs = [x0 - 0.05, x0 + 0.25, 0, x1 - 0.25, x1 + 0.05], bottom = gap + 0.07;
  const m = k.mark();
  for (let i = 0; i < n; i++) {
    const y = bottom + i * pitch;
    // one slat: a shallow arc bowed towards the room, then the dark curl where it hooks into the one above
    const prof = [[0, 0.004], [0.012, -0.007], [0.034, -0.011], [0.056, -0.007], [0.066, 0.002], [0.075, 0.004]];
    const occ = [0.55, 0.9, 1, 0.95, 0.7, 0.5];
    k.steel([0.5, 0.52, 0.53], 0.42, 0.3, i);
    for (let j = 0; j < prof.length - 1; j++) for (let c = 0; c < xs.length - 1; c++) {
      const a = k.b.count, P = [[xs[c + 1], j], [xs[c], j], [xs[c], j + 1], [xs[c + 1], j + 1]];
      for (const [x, q] of P) {
        const nxt = prof[Math.min(q + 1, prof.length - 1)], prv = prof[Math.max(q - 1, 0)], dy = nxt[0] - prv[0], dz = nxt[1] - prv[1], l = Math.hypot(dy, dz) || 1;
        k.b.occlusion(occ[q]); k.b.vertex(x, y + prof[q][0], z + prof[q][1], 0, dz / l, -dy / l, x, y + prof[q][0]);
      }
      k.b.quad(a, a + 1, a + 2, a + 3);
    }
  }
  // grime that the guides wipe onto the curtain's ends, and the shade under the hood
  k.shade(m, (x, y) => (0.75 + 0.25 * smoothstep(0, 0.3, Math.min(x - x0, x1 - x))) * (1 - 0.3 * smoothstep(top - 0.5, top, y)));
  k.steel([0.3, 0.31, 0.32], 0.5, 0.4); k.box(x0 - 0.04, gap + 0.012, z - 0.03, x1 + 0.04, bottom + 0.004, z + 0.012, { r: 0.004, axis: 'x' });
  k.rubber(COLOR.rubber, 0.9); k.box(x0 - 0.03, gap, z - 0.02, x1 + 0.03, gap + 0.014, z + 0.004, { r: 0.004, axis: 'x' });
  // lifting handles riveted to the rail
  k.bare(2, 0.5, [0.6, 0.6, 0.6]);
  for (const x of [-1.2, 1.2]) k.tube([[x - 0.09, bottom - 0.03, z - 0.03], [x - 0.09, bottom - 0.03, z - 0.07], [x + 0.09, bottom - 0.03, z - 0.07], [x + 0.09, bottom - 0.03, z - 0.03]], 0.006, 5);
  return k;
}

/** What is seen under and through the door: the apron outside and the last of the dusk across the street. */
function buildOutside(k) {
  const { x0, x1, top } = DOOR, z = ROOM.z1 + ROOM.wall;
  k.concrete([0.42, 0.41, 0.4], 30, 0.5);
  k.quad([x0 - 2, -0.02, z + 6], [x1 + 2, -0.02, z + 6], [x1 + 2, -0.02, z], [x0 - 2, -0.02, z]);
  // a painted backing across the street, as on a film stage: afterglow low down, deep blue above the roofs
  const rows = [[-0.02, [1.0, 0.42, 0.16], 1], [0.5, [1.0, 0.36, 0.2], 1], [1.3, [0.9, 0.24, 0.36], 0.75], [2.4, [0.42, 0.16, 0.5], 0.4], [top + 1.2, [0.1, 0.07, 0.3], 0.2]];
  for (let i = 0; i < rows.length - 1; i++) {
    const [ya, ca, ga] = rows[i], [yb, cb, gb] = rows[i + 1], a = k.b.count;
    for (const [x, y, c, g] of [[x1 + 4, ya, ca, ga], [x0 - 4, ya, ca, ga], [x0 - 4, yb, cb, gb], [x1 + 4, yb, cb, gb]]) {
      k.emissive([c[0] * g, c[1] * g, c[2] * g], RADIANCE.dusk);
      k.b.vertex(x, y, z + 6, 0, 0, -1, x, y);
    }
    k.b.quad(a, a + 1, a + 2, a + 3);
  }
}

function buildSideDoor(k) {
  const { z0, z1, top } = SIDE_DOOR, x = ROOM.x1, back = x + 0.09;
  // pressed steel frame lining the reveal, a flush leaf set in it
  k.steel([0.16, 0.2, 0.22], 0.45, 0.35);
  for (const z of [z0, z1]) k.box(x - 0.012, 0, Math.min(z, z + (z === z0 ? 0.05 : -0.05)), x + 0.09, top, Math.max(z, z + (z === z0 ? 0.05 : -0.05)), { r: 0.004 });
  k.box(x - 0.012, top - 0.05, z0 + 0.05, x + 0.09, top, z1 - 0.05, { r: 0.004, axis: 'z' });
  const m = k.mark();
  k.steel([0.2, 0.36, 0.38], 0.4, 0.4);
  k.box(back - 0.045, 0.008, z0 + 0.053, back - 0.005, top - 0.053, z1 - 0.053, { r: 0.004 });
  k.shade(m, (px, y) => 0.8 + 0.2 * smoothstep(0, 0.4, y));
  k.bare(4, 0.45, [0.75, 0.75, 0.75]);
  k.box(back - 0.048, 0.03, z0 + 0.08, back - 0.045, 0.28, z1 - 0.08, { r: 0 });                 // kick plate
  // lever handle on a rose, and a rim cylinder above it
  const hz = z0 + 0.13, hx = back - 0.045;
  k.cyl([hx, 1.02, hz], [hx - 0.008, 1.02, hz], 0.027, 0.027, k.n(12, 8), { capB: true });
  k.tube([[hx - 0.008, 1.02, hz], [hx - 0.05, 1.02, hz], [hx - 0.056, 1.02, hz + 0.012], [hx - 0.056, 1.02, hz + 0.12]], 0.009, 6, { capB: true });
  k.cyl([hx, 1.13, hz], [hx - 0.006, 1.13, hz], 0.016, 0.016, 8, { capB: true });
  // three butt hinges on the other stile
  for (const y of [0.25, 1.05, 1.85]) k.cyl([hx - 0.004, y - 0.05, z1 - 0.05], [hx - 0.004, y + 0.05, z1 - 0.05], 0.008, 0.008, 6, { capA: true, capB: true });
  // overhead closer: body on the leaf, folding arm to the frame
  k.steel([0.55, 0.55, 0.55], 0.45, 0.2);
  k.box(hx - 0.05, top - 0.17, z1 - 0.36, hx, top - 0.115, z1 - 0.12, { r: 0.006 });
  k.bar([hx - 0.04, top - 0.11, z1 - 0.3], [hx - 0.2, top - 0.1, z1 - 0.5], 0.02, 0.006, { r: 0 });
  k.bar([hx - 0.2, top - 0.1, z1 - 0.5], [x - 0.02, top - 0.03, z1 - 0.62], 0.02, 0.006, { r: 0 });
}

function buildGlassBlock(k) {
  const { z0, z1, y0, y1 } = GLASS_BLOCK, x = ROOM.x1 + 0.07, rows = 5;
  // lit from the street side: the afterglow low in the panel, the blue of the evening at its head
  const tone = (t) => [1.0 - 0.45 * t, 0.42 - 0.2 * t + 0.1 * t * t, 0.2 + 0.55 * t];
  for (let j = 0; j < rows; j++) {
    const ya = y0 + (y1 - y0) * j / rows, yb = y0 + (y1 - y0) * (j + 1) / rows, a = k.b.count;
    for (const [z, y] of [[z0, ya], [z1, ya], [z1, yb], [z0, yb]]) { k.glassBlock(tone((y - y0) / (y1 - y0)), RADIANCE.glassBlock); k.b.vertex(x, y, z, -1, 0, 0, z - z0, y - y0); }
    k.b.quad(a, a + 1, a + 2, a + 3);
  }
  // a splayed concrete sill under it
  k.concrete([0.55, 0.54, 0.52], 0, 0.4);
  k.box(ROOM.x1 - 0.035, y0 - 0.05, z0 - 0.05, ROOM.x1 + 0.07, y0, z1 + 0.05, { r: 0.006, axis: 'z' });
}

/** Everything fixed that is not the floor: walls, roof, door surround, side door, glass block, the backing outside. */
export function buildShell(k) {
  buildWalls(k); buildRoof(k); buildDoorSurround(k); buildOutside(k); buildSideDoor(k); buildGlassBlock(k);
  return k;
}

export { TRUSS_Z, PIER, CURTAIN_Z };
