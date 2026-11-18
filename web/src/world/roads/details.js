// Road-edge details the planner places: guardrail runs, median planters, storm drains and manhole covers.
// Each builder appends to the caller's MeshBuilder in the caller's coordinates and returns the collision boxes it
// implies as [cx, cy, cz, hx, hy, hz, yaw] records (hx across, hz along the heading `yaw`).

import { FAMILY, GROUND, SOLID } from '../../core/ids.js';
import { clamp, hash01, hashInts } from '../../core/math.js';
import { LAND_Y, KERB_HEIGHT, KERB, headingByte } from './lanes.js';
import { frameAt, place, quadAwayFrom, box, column } from './shapes.js';

/** Covers sit this far proud of the road so that they never fight it for depth; a tyre does not feel a centimetre. */
const COVER_LIFT = 0.01;
const TINT = Object.freeze({ galvanised: [0.72, 0.73, 0.74], iron: [0.23, 0.22, 0.21], concrete: [0.56, 0.55, 0.52], soil: [0.32, 0.25, 0.18] });

const galvanised = (mb, seed) => mb.family(FAMILY.SOLID).material(SOLID.METAL_BARE, 175, 2, seed & 255).color(TINT.galvanised).occlusion(1);
const castIron = (mb, seed) => mb.family(FAMILY.SOLID).material(SOLID.METAL_PAINTED, 170, 150, seed & 255).color(TINT.iron).occlusion(1);
const concrete = (mb, seed) => mb.family(FAMILY.SOLID).material(SOLID.CONCRETE, 0, 110, seed & 255).color(TINT.concrete).occlusion(1);

// ------------------------------------------------------------------------------------------------ guardrail

/** W-beam section: [distance out from the posts towards the traffic, height above the ground], top to bottom. */
const W_BEAM = [[0.0, 0.76], [0.045, 0.745], [0.085, 0.69], [0.02, 0.605], [0.085, 0.52], [0.045, 0.465], [0.0, 0.45]];
const POST_PITCH = 1.905;

/**
 * Steel guardrail along a polyline. path: [[x, z], ...] on the line of the posts; `side` +1 puts the traffic
 * (and the corrugated face) on the left of the path direction, -1 on the right. y: ground height, a number or
 * a function of the distance along the path. terminals: the ends turn down into the ground.
 * Returns { boxes, triangles }.
 */
export function addGuardrail(mb, path, { y = LAND_Y, side = 1, terminals = true, seed = 1 } = {}) {
  const start = mb.triangleCount, boxes = [], groundAt = typeof y === 'function' ? y : () => y;
  // stations: the path's own vertices plus the posts; the beam is a ribbon through both
  const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const length = cum[cum.length - 1], at = (s) => {
    let i = 0; while (i < path.length - 2 && s > cum[i + 1]) i++;
    const t = (s - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]), dx = path[i + 1][0] - path[i][0], dz = path[i + 1][1] - path[i][1], l = Math.hypot(dx, dz) || 1;
    return { x: path[i][0] + dx * t, z: path[i][1] + dz * t, yaw: Math.atan2(dx / l, dz / l), fx: dx / l, fz: dz / l };
  };
  const posts = Math.max(1, Math.round(length / POST_PITCH)), pitch = length / posts, stations = new Set(cum);
  for (let p = 0; p <= posts; p++) stations.add(p * pitch);
  const rows = [...stations].sort((a, b) => a - b).filter((s, i, all) => i === 0 || s - all[i - 1] > 1e-6);
  // the ends drop to the ground over two post spacings
  const sink = (s) => (terminals ? 0.62 * (1 - clamp(Math.min(s, length - s) / (2 * pitch), 0, 1)) : 0);

  galvanised(mb, seed);
  const ring = rows.map((s) => {
    const f = at(s), g = groundAt(s) - sink(s), nx = f.fz * side, nz = -f.fx * side;       // towards the traffic
    return W_BEAM.map(([out, h]) => [f.x + nx * (0.07 + out), g + h, f.z + nz * (0.07 + out)]);
  });
  for (let i = 0; i + 1 < rows.length; i++) {
    const f = at((rows[i] + rows[i + 1]) / 2), behind = [f.x - f.fz * side * 5, groundAt(rows[i]) + 0.6, f.z + f.fx * side * 5], front = [2 * f.x - behind[0], behind[1], 2 * f.z - behind[2]];
    for (let k = 0; k + 1 < W_BEAM.length; k++) {
      const a = ring[i][k], b = ring[i + 1][k], c = ring[i + 1][k + 1], d = ring[i][k + 1];
      quadAwayFrom(mb, a, b, c, d, behind[0], behind[1], behind[2]);     // the face the traffic sees
      quadAwayFrom(mb, a, b, c, d, front[0], front[1], front[2]);        // and its back, seen from the verge
    }
    const g = (groundAt(rows[i]) + groundAt(rows[i + 1])) / 2, len = rows[i + 1] - rows[i];
    boxes.push(f.x + f.fz * side * 0.06, g + 0.4, f.z - f.fx * side * 0.06, 0.1, 0.4, len / 2, f.yaw);
  }
  for (let p = 0; p <= posts; p++) {
    const s = p * pitch, f = at(s), drop = sink(s); if (drop > 0.5) continue;                // the last post is under the turned-down end
    const B = frameAt(f.x, f.z, f.yaw, groundAt(s));
    box(mb, B, -0.05, 0.05, 0, 0.72 - drop, -0.035, 0.035, 'b');
    // offset block between post and beam
    const l0 = Math.min(-side * 0.05, -side * 0.07), l1 = Math.max(-side * 0.05, -side * 0.07);
    box(mb, B, l0 - 0.001, l1 + 0.001, 0.47 - drop, 0.74 - drop, -0.05, 0.05);
  }
  return { boxes, triangles: mb.triangleCount - start };
}

// ------------------------------------------------------------------------------------------------ median planter

/**
 * Raised island in the middle of a road: kerb all round with rounded noses, planted or paved on top.
 * x, z: centre; yaw: road heading; length along the road, width across. Returns { boxes, plantSpots, triangles };
 * plantSpots are [x, z] points on the centre line for palms and shrubs (the flora owner supplies those).
 */
export function addMedianPlanter(mb, { x, z, yaw, length, width, y = LAND_Y, planted = true, seed = 1 }) {
  const start = mb.triangleCount, B = frameAt(x, z, yaw, y), r = width / 2, half = Math.max(0, length / 2 - r), arc = 6, heading = headingByte(yaw);
  // stadium outline: a half circle round each end, the flanks between them; the kerb stone is 0.15 m wide
  const loop = (radius) => {
    const pts = [];
    for (const end of [1, -1]) for (let i = 0; i <= arc; i++) { const a = (end > 0 ? 0 : Math.PI) + (i / arc) * Math.PI; pts.push([Math.cos(a) * radius, end * half + Math.sin(a) * radius]); }
    return pts;
  };
  const outline = loop(r), inner = loop(Math.max(0.05, r - 0.15)), n = outline.length;
  const top = planted ? KERB_HEIGHT + 0.02 : KERB_HEIGHT, centre = place(B, 0, 0, 0);
  // kerb uv (ARCHITECTURE 5.2): u across the profile from the gutter line, v the station round the island
  let s0 = 0;
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n], ia = inner[i], ib = inner[(i + 1) % n], s1 = s0 + Math.hypot(b[0] - a[0], b[1] - a[1]);
    const band = (u0, u1) => [u0, s0, u0, s1, u1, s1, u1, s0];
    mb.family(FAMILY.GROUND).material(GROUND.KERB, 0, 0, heading).color(1, 1, 1).occlusion(1);
    quadAwayFrom(mb, place(B, a[0], 0, a[1]), place(B, b[0], 0, b[1]), place(B, b[0], KERB_HEIGHT, b[1]), place(B, a[0], KERB_HEIGHT, a[1]), centre[0], centre[1], centre[2], band(0, KERB.CHAMFER));
    quadAwayFrom(mb, place(B, a[0], KERB_HEIGHT, a[1]), place(B, b[0], KERB_HEIGHT, b[1]), place(B, ib[0], KERB_HEIGHT, ib[1]), place(B, ia[0], KERB_HEIGHT, ia[1]), centre[0], centre[1] - 5, centre[2], band(KERB.CHAMFER, KERB.BACK));
    if (planted) quadAwayFrom(mb, place(B, ia[0], KERB_HEIGHT, ia[1]), place(B, ib[0], KERB_HEIGHT, ib[1]), place(B, ib[0], top, ib[1]), place(B, ia[0], top, ia[1]), centre[0], centre[1], centre[2], band(KERB.BACK, KERB.BACK + top - KERB_HEIGHT));
    s0 = s1;
  }
  // the bed (or the paved top) as a fan round the centre
  mb.family(FAMILY.GROUND).material(GROUND.MEDIAN, planted ? 1 : 0, 0, heading).color(1, 1, 1).occlusion(1);
  const hub = mb.vertex(centre[0], y + top + (planted ? 0.05 : 0), centre[2], 0, 1, 0, 99, 0), rim = mb.count;
  for (const [l, f] of inner) { const p = place(B, l, top, f); mb.vertex(p[0], p[1], p[2], 0, 1, 0, 99, 0); }
  // orientation by test, like every other face here: the fan must face up
  const p0 = place(B, inner[0][0], top, inner[0][1]), p1 = place(B, inner[1][0], top, inner[1][1]);
  const up = (p0[2] - centre[2]) * (p1[0] - centre[0]) - (p0[0] - centre[0]) * (p1[2] - centre[2]) > 0;
  for (let i = 0; i < n; i++) { const a = rim + i, b = rim + (i + 1) % n; if (up) mb.tri(hub, a, b); else mb.tri(hub, b, a); }
  const plantSpots = [], count = planted ? Math.max(1, Math.floor((length - width) / 7) + 1) : 0;
  for (let i = 0; i < count; i++) { const f = count === 1 ? 0 : -half + (2 * half) * (i / (count - 1)) + (hash01(seed, i, 5) - 0.5) * 1.2, p = place(B, 0, 0, clamp(f, -half, half)); plantSpots.push([p[0], p[2]]); }
  return { boxes: [x, y + KERB_HEIGHT / 2, z, r, KERB_HEIGHT / 2, length / 2, yaw], plantSpots, triangles: mb.triangleCount - start };
}

// ------------------------------------------------------------------------------------------------ drains and covers

/** Flat disc or rectangle of cast iron lying on the road, with a concrete collar round it. */
function coverPlate(mb, B, shape, halfL, halfF, seed) {
  const lift = COVER_LIFT, collar = 0.09;
  concrete(mb, seed);
  if (shape === 'round') {
    column(mb, B, 0, 0, 0, lift * 0.5, halfL + collar, halfL + collar, 20, 't');
    castIron(mb, seed); column(mb, B, 0, 0, 0, lift, halfL, halfL, 20, 't');
    return;
  }
  box(mb, B, -halfL - collar, halfL + collar, 0, lift * 0.5, -halfF - collar, halfF + collar, 'b');
  castIron(mb, seed); box(mb, B, -halfL, halfL, 0, lift, -halfF, halfF, 'b');
}

/** Rectangular gully grating centred on lateral `l` of frame B: frame, bars and the dark sump between them. */
function grating(mb, B, l, halfL, halfF, seed) {
  const bars = 6 + (hashInts(seed, 3) & 1);
  concrete(mb, seed); box(mb, B, l - halfL - 0.07, l + halfL + 0.02, 0, COVER_LIFT * 0.5, -halfF - 0.07, halfF + 0.07, 'b');
  mb.family(FAMILY.SOLID).material(SOLID.RUBBER, 240, 0, seed & 255).color(0.03, 0.03, 0.03).occlusion(0.4);
  box(mb, B, l - halfL, l + halfL, 0, COVER_LIFT * 0.7, -halfF, halfF, 'b');
  castIron(mb, seed);
  for (const e of [-halfL + 0.02, halfL - 0.02]) box(mb, B, l + e - 0.02, l + e + 0.02, 0, COVER_LIFT, -halfF, halfF, 'b');
  for (const f of [-halfF + 0.02, halfF - 0.02]) box(mb, B, l - halfL, l + halfL, 0, COVER_LIFT, f - 0.02, f + 0.02, 'b');
  for (let i = 0; i < bars; i++) { const f = -halfF + (i + 1) * (2 * halfF / (bars + 1)); box(mb, B, l - halfL, l + halfL, 0, COVER_LIFT, f - 0.02, f + 0.02, 'b'); }
}

/**
 * Manhole or utility cover set in the carriageway. kind: 'round' (0.62 m sewer cover with a raised pattern),
 * 'grate' (0.5 x 0.8 m gully grating with real slots), 'utility' (0.6 x 0.45 m hatch). Returns { boxes: [], triangles }:
 * covers are flush, nothing collides with them.
 */
export function addManhole(mb, { x, z, y = LAND_Y, yaw = 0, kind = 'round', seed = 1 }) {
  const start = mb.triangleCount, B = frameAt(x, z, yaw, y);
  if (kind === 'round') {
    coverPlate(mb, B, 'round', 0.31, 0.31, seed);
    // raised bars in two rings and a pick hole: enough relief to catch low sun and headlamps
    castIron(mb, seed + 1);
    for (let ring = 0; ring < 2; ring++) for (let i = 0; i < (ring ? 12 : 6); i++) {
      const a = (i / (ring ? 12 : 6)) * Math.PI * 2 + ring * 0.26, rr = ring ? 0.22 : 0.11, R = frameAt(x + (B.rx * Math.cos(a) + B.fx * Math.sin(a)) * rr, z + (B.rz * Math.cos(a) + B.fz * Math.sin(a)) * rr, yaw - a, y);
      box(mb, R, -0.012, 0.012, COVER_LIFT, COVER_LIFT + 0.004, -0.04, 0.04, 'b');
    }
  } else if (kind === 'grate') {
    grating(mb, B, 0, 0.25, 0.4, seed);
  } else {
    coverPlate(mb, B, 'rect', 0.3, 0.225, seed);
    castIron(mb, seed + 1);
    for (let i = 0; i < 5; i++) box(mb, B, -0.24, 0.24, COVER_LIFT, COVER_LIFT + 0.003, -0.17 + i * 0.085 - 0.012, -0.17 + i * 0.085 + 0.012, 'b');
  }
  return { boxes: [], triangles: mb.triangleCount - start };
}

/**
 * Kerb inlet. x, z: a point on the kerb line; yaw: road heading with the kerb on the right-hand side. Builds the
 * grating in the gutter, the dished concrete apron round it and the dark throat cut into the kerb face.
 */
export function addStormDrain(mb, { x, z, yaw, y = LAND_Y, seed = 1 }) {
  const start = mb.triangleCount, B = frameAt(x, z, yaw, y), halfF = 0.45, wide = 0.42;
  // grating lies in the gutter, left of the kerb line (laterals are negative towards the road centre)
  grating(mb, B, -wide / 2 - 0.02, wide / 2, halfF, seed);
  // throat: a dark slot in the kerb face, with a concrete lintel above it
  mb.family(FAMILY.SOLID).material(SOLID.RUBBER, 240, 0, seed & 255).color(0.02, 0.02, 0.02).occlusion(0.3);
  quadAwayFrom(mb, place(B, -0.004, 0.01, -halfF), place(B, -0.004, 0.01, halfF), place(B, -0.004, KERB_HEIGHT - 0.035, halfF), place(B, -0.004, KERB_HEIGHT - 0.035, -halfF), ...place(B, 1, 0.05, 0));
  concrete(mb, seed);
  box(mb, B, -0.012, 0.3, KERB_HEIGHT - 0.035, KERB_HEIGHT + 0.004, -halfF - 0.15, halfF + 0.15, 'b');
  return { boxes: [], triangles: mb.triangleCount - start };
}
