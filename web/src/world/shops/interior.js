// The inside of a shop: one room, built in code, that stands in the world like a set.
//
// The city's buildings are shells drawn by the tile worker — there is nothing behind a shopfront to walk
// into, and streaming a room per storefront into the same colliders and light grids as the street would
// fight the LOD and cluster machinery for one interior. So the inside is made the way the garage's room is
// made (design/GARAGE.md, Interior rendering): a set of meshes flagged `interior`, standing at an origin of
// its own, visible only in frames whose environment is the closed room. A customer therefore walks into a
// real room with real lights, and the street outside is not asked to know about it.
//
// Everything is in the room's own frame (metres, origin at the middle of the floor, +Z out through the
// shopfront), and `ROOM.depth`/`ROOM.width` bound it. Nothing here touches WebGL; the result is plain data
// that `game/shops.js` hands to the renderer, which is also what makes the room testable in node.

import { MeshBuilder } from '../../core/mesh.js';
import { m4fromYawPos } from '../../core/math.js';
import { FAMILY, SOLID, GROUND, CHANNEL, LIGHT_STRIDE, GLOW_STRIDE } from '../../core/ids.js';

/** Metres. A corner store: deep enough for three aisles, low enough that the ceiling reads as a shop. */
export const ROOM = Object.freeze({ width: 13.5, depth: 9.5, height: 3.6, wall: 0.24, counter: 0.98 });
/** Where the door is, in the room's frame: the middle of the shopfront, +Z out. */
export const DOOR = Object.freeze({ x: 0, z: ROOM.depth / 2, width: 1.7 });
/** The counter's position, and the till on it — the two things a hold-up is about. */
export const COUNTER = Object.freeze({ x: 3.1, z: 1.6, yaw: -Math.PI / 2, top: 0.98 });
export const TILL = Object.freeze({ x: 3.1, z: 1.6, y: 1.02 });
/** Where the clerk stands behind the counter, and where he runs to. */
export const CLERK = Object.freeze({ x: 4.4, z: 1.1, flee: { x: 5.9, z: -3.2 } });
/** Where the walker materialises when he comes in through the door. */
export const ENTRY = Object.freeze({ x: 0, z: ROOM.depth / 2 - 1.1 });
/** A light record per unit of tube, and per point, in the renderer's units. */
const TUBE_LIGHT = 0.34, POINT_LIGHT = 1.5;
const FLOOR_TILE = 0.75;

/**
 * The room, as meshes: `floor`, `shell` (walls, ceiling, shopfront), `fittings` (counter, shelves, fridges,
 * boxes), `sign`. Plus the room's own lights and glows in the frame's record layout, and the anchors that
 * the game places people and cameras at.
 *
 * @param {{sign?: string, hours?: string, palette?: object}} [options]  the name painted on the fascia
 */
/** Where the room stands: `{yaw, at}` turns the set to the lot it belongs to and lifts it to the ground. */
const NO_PLACE = { yaw: 0, at: [0, 0, 0] };

export function buildShopSet(options = {}) {
  const palette = { ...PALETTES[options.palette] || PALETTES.grocery, ...(options.palette2 || {}) };
  // A room that faces a different way has to be *built* facing that way: the renderer's static instances are
  // only ever translated, so a set standing in the world carries its own turning in its vertices. The lights,
  // the glows and the anchors are moved by the same numbers, which is what keeps a lamp on its fitting.
  const yaw = Number.isFinite(options.yaw) ? options.yaw : 0;
  const at = Array.isArray(options.at) && options.at.length === 3 ? options.at : NO_PLACE.at;
  const moved = yaw !== 0 || at[0] !== 0 || at[1] !== 0 || at[2] !== 0;
  const m = moved ? m4fromYawPos(new Float32Array(16), yaw, at[0], at[1], at[2]) : null;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (p) => [at[0] + p[0] * c + p[2] * s, at[1] + p[1], at[2] - p[0] * s + p[2] * c];
  const floor = buildFloor(palette, m);
  const shell = buildShell(palette, m);
  const fittings = buildFittings(palette, m);
  const sign = buildSign(options.sign || 'OPEN', palette, m);
  // Placed first, so the glow of a tube is derived from the tube where it now stands.
  const lights = lightList(palette).map((l) => ({
    ...l,
    a: l.a ? put([l.a[0], l.a[1], l.a[2]]) : undefined,
    b: l.b ? put([l.b[0], l.b[1], l.b[2]]) : undefined,
    position: l.position ? put([l.position[0], l.position[1], l.position[2]]) : undefined,
  }));
  const glows = glowList(lights, palette);
  const anchors = {
    door: put([DOOR.x, 0, DOOR.z]),
    entry: put([ENTRY.x, 0, ENTRY.z]),
    counter: put([COUNTER.x, COUNTER.top, COUNTER.z]),
    till: put([TILL.x, TILL.y, TILL.z]),
    clerk: put([CLERK.x, 0, CLERK.z]),
    back: put([CLERK.flee.x, 0, CLERK.flee.z]),
    // The room as the renderer's interior frame wants it: the box, the ceiling that lights it, where a
    // reflection is captured from, and the ambient the walls hold. Mirrors world/garage/index.js.
    room: {
      min: [-(ROOM.width / 2 + ROOM.wall), 0, -(ROOM.depth / 2 + ROOM.wall)],
      max: [ROOM.width / 2 + ROOM.wall, ROOM.height, ROOM.depth / 2 + ROOM.wall],
    },
    lightBox: {
      centre: put([0, ROOM.height - 0.22, 0]),
      u: [(ROOM.width / 2 - 0.7) * c, 0, -(ROOM.width / 2 - 0.7) * s],
      v: [(ROOM.depth / 2 - 1) * s, 0, (ROOM.depth / 2 - 1) * c],
      normal: [0, -1, 0],
      // A shop's ceiling is one long diffuser over a flat room: the same order as the garage's panel
      // (world/garage/plan.js RADIANCE.diffuser), because a supermarket is bright for the same reason a
      // workshop is — the light is meant to fall on the goods, not to be looked at.
      radiance: [4.2, 4.05, 3.7],
    },
    probe: put([0, 1.1, 0]),
    look: { ambient: [0.05, 0.048, 0.052], haze: 0.05 },
  };
  // The box a man is kept inside, and the frame the renderer reads it in: an oriented room's AABB is the
  // eight corners of the room, placed, and a room turned 45° is a bigger box than a room facing north.
  let bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  if (moved) {
    for (const p of corners(anchors.room.min, anchors.room.max)) {
      for (let k = 0; k < 3; k++) {
        if (p[k] < bounds[k]) bounds[k] = p[k];
        if (p[k] > bounds[k + 3]) bounds[k + 3] = p[k];
      }
    }
  } else {
    bounds = anchors.room.min.concat(anchors.room.max);
  }
  return {
    meshes: { floor, shell, fittings, sign },
    lights, glows, anchors, bounds,
    yaw, at: [at[0], at[1], at[2]],
    floorY: at[1],
    // The room's own frame, for whoever has to convert a world position back into it: `game/shops.js`
    // measures a man against the till in the room's numbers, not the street's.
    toRoom: (x, z, out = [0, 0]) => {
      const dx = x - at[0], dz = z - at[2];
      out[0] = dx * c - dz * s; out[1] = dx * s + dz * c; return out;
    },
  };
}

/** The eight corners of an AABB, for turning a box into the box that holds it once it has been rotated. */
function corners(min, max) {
  const out = [];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z]);
  return out;
}

/** The three shopfronts the street offers, in their own colours. */
export const PALETTES = Object.freeze({
  grocery: { floor: [0.86, 0.85, 0.8], wall: [0.79, 0.72, 0.55], dado: [0.3, 0.36, 0.32], shelf: [0.72, 0.7, 0.66], sign: [1, 0.42, 0.12], goods: [0.9, 0.3, 0.25], fridge: [0.62, 0.72, 0.78] },
  corner: { floor: [0.72, 0.7, 0.66], wall: [0.68, 0.74, 0.72], dado: [0.24, 0.32, 0.34], shelf: [0.6, 0.6, 0.58], sign: [0.2, 0.9, 0.7], goods: [0.85, 0.7, 0.2], fridge: [0.7, 0.76, 0.8] },
  liquor: { floor: [0.4, 0.36, 0.34], wall: [0.5, 0.42, 0.4], dado: [0.22, 0.18, 0.2], shelf: [0.45, 0.38, 0.3], sign: [1, 0.24, 0.42], goods: [0.7, 0.5, 0.2], fridge: [0.55, 0.6, 0.66] },
});

// ---------------------------------------------------------------------------------------- the pieces

function buildFloor(p, m) {
  const b = new MeshBuilder(1200);
  const w = ROOM.width / 2, d = ROOM.depth / 2;
  // Tiles, drawn as a grid of quads two shades apart: a floor with no pattern in it is a box's floor.
  const cols = Math.round(ROOM.width / FLOOR_TILE), rows = Math.round(ROOM.depth / FLOOR_TILE);
  const step = (i, n, half) => -half + (i + 0.5) * ((2 * half) / n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const even = ((r + c) & 1) === 0;
      const x0 = -w + (c * 2 * w) / cols, x1 = -w + ((c + 1) * 2 * w) / cols;
      const z0 = -d + (r * 2 * d) / rows, z1 = -d + ((r + 1) * 2 * d) / rows;
      void step; void even;
      const tone = 0.9 + 0.1 * (((r * 7 + c * 3) % 5) / 4);
      b.family(FAMILY.GROUND).material(GROUND.PAVERS, 0, 0, 0)
        .color(p.floor[0] * tone, p.floor[1] * tone, p.floor[2] * tone)
        .occlusion(x0 < 0 ? 0.9 : 1);
      quad(b, x0, 0.001, z0, x1, 0.001, z0, x1, 0.001, z1, x0, 0.001, z1, [0, 1, 0]);
    }
  }
  if (m) b.transform(m);
  return b.finish();
}

function buildShell(p, m) {
  const b = new MeshBuilder(900);
  const w = ROOM.width / 2, d = ROOM.depth / 2, h = ROOM.height, t = ROOM.wall;
  const wallMat = () => b.family(FAMILY.SOLID).material(SOLID.PAINT, 0, 0, 0).color(p.wall[0], p.wall[1], p.wall[2]);
  // The three blind walls, dado below and paint above, as two bands each so the join reads at eye height.
  for (const [axis, side] of [['x', -1], ['x', 1], ['z', -1]]) {
    const band = (y0, y1, col) => {
      b.family(FAMILY.SOLID).material(SOLID.PAINT, 0, 0, 0).color(col[0], col[1], col[2]);
      const inset = 0.01;
      if (axis === 'x') {
        const x = side * (w + inset);
        quad(b, x, y0, -d - t, x, y1, -d - t, x, y1, d + t, x, y0, d + t, [-side, 0, 0]);
      } else {
        const z = side * (d + inset);
        quad(b, -w - t, y0, z, w + t, y1, z, w + t, y1, z, -w - t, y0, z, [0, 0, -side]);
        quad(b, -w - t, y0, z, w + t, y0, z, w + t, y1, z, -w - t, y1, z, [0, 0, -side]);
      }
    };
    band(0, 1.05, p.dado);
    band(1.05, h, p.wall);
  }
  // The shopfront: glass between two piers, a transom above, and the door gap in the middle of it.
  const glass = [0.42, 0.5, 0.5];
  const z = d + t * 0.5;
  b.family(FAMILY.SOLID).material(SOLID.DARK_GLASS, 0, 0, 0).color(glass[0], glass[1], glass[2]);
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -(w + t) : DOOR.width / 2, x1 = s < 0 ? -DOOR.width / 2 : w + t;
    quad(b, x0, 0.1, z, x1, 2.45, z, x1, 2.45, z, x0, 0.1, z, [0, 0, 1]);
    quad(b, x0, 0.1, z, x0, 2.45, z, x1, 2.45, z, x1, 0.1, z, [0, 0, -1]);
  }
  b.family(FAMILY.SOLID).material(SOLID.EMISSIVE, 0, 0, 0).color(1.6, 1.55, 1.4);
  quad(b, -(w + t), 0.1, z + 0.16, w + t, 2.45, z + 0.16, w + t, 2.45, z + 0.16, -(w + t), 0.1, z + 0.16, [0, 0, -1]);
  wallMat();
  quad(b, -(w + t), 2.45, z, w + t, h, z, w + t, h, z, -(w + t), 2.45, z, [0, 0, -1]);
  quad(b, -(w + t), 2.45, z, w + t, 2.45, z, w + t, 2.45, z, -(w + t), 2.45, z, [0, 0, 1]);
  // Piers either side of the door, and the lintel over it.
  box(b, -(DOOR.width / 2 + 0.14), 0, z - t / 2, 0.28, h, t * 1.6, p.wall);
  box(b, DOOR.width / 2 + 0.14, 0, z - t / 2, 0.28, h, t * 1.6, p.wall);
  // The ceiling, in squares: a light roof needs something to hold the strips.
  b.family(FAMILY.SOLID).material(SOLID.CONCRETE, 0, 0, 0).color(0.82, 0.82, 0.8);
  quad(b, -w - t, h, -d - t, w + t, h, -d - t, w + t, h, d + t, -w - t, h, d + t, [0, -1, 0]);
  const strip = 0.34;
  for (const cx of [-w / 2, 0, w / 2]) {
    b.family(FAMILY.SOLID).material(SOLID.METAL_BARE, 0, 0, 0).color(0.55, 0.56, 0.58);
    box(b, cx, h - 0.08, 0, strip, 0.08, ROOM.depth * 0.62, [0.55, 0.56, 0.58]);
    b.family(FAMILY.SOLID).material(SOLID.EMISSIVE, 0, 0, 0).color(1, 1, 0.94);
    quad(b, cx - strip / 2, h - 0.125, -ROOM.depth * 0.31, cx + strip / 2, h - 0.125, -ROOM.depth * 0.31,
      cx + strip / 2, h - 0.125, ROOM.depth * 0.31, cx - strip / 2, h - 0.125, ROOM.depth * 0.31, [0, -1, 0]);
  }
  if (m) b.transform(m);
  return b.finish();
}

function buildFittings(p, m) {
  const b = new MeshBuilder(2600);
  const w = ROOM.width / 2, d = ROOM.depth / 2;
  // Gondolas: a base, four boards, and rows of goods. The goods are what sells the room — a shop with
  // empty shelves is a car park indoors.
  const aisles = [-w + 1.9, -w + 4.3, -w + 6.7];
  for (const ax of aisles) for (const back of [0, 1]) {
    shelfRun(b, ax, -d + 1.5, back ? Math.PI : 0, 2.4, p);
  }
  // The wall of fridges at the back, glass doors and all: the coldest light in the room comes from here.
  for (let i = 0; i < 4; i++) {
    const x = -w + 1.2 + i * 1.5;
    box(b, x, 0, -d - 0.12, 1.34, 2.15, 0.66, p.fridge);
    b.family(FAMILY.SOLID).material(SOLID.DARK_GLASS, 0, 0, 0).color(0.55, 0.68, 0.72);
    quad(b, x - 0.6, 0.2, -d + 0.22, x + 0.6, 2.0, -d + 0.22, x + 0.6, 2.0, -d + 0.22, x - 0.6, 0.2, -d + 0.22, [0, 0, 1]);
    quad(b, x - 0.6, 0.2, -d + 0.22, x - 0.6, 2.0, -d + 0.22, x + 0.6, 2.0, -d + 0.22, x + 0.6, 0.2, -d + 0.22, [0, 0, -1]);
  }
  // The counter, its kick panel, and the till box on top of it.
  box(b, COUNTER.x, 0, COUNTER.z, 2.6, COUNTER.top, 0.9, [0.34, 0.28, 0.24]);
  box(b, COUNTER.x, COUNTER.top, COUNTER.z, 2.72, 0.06, 1.02, [0.5, 0.44, 0.38]);
  box(b, TILL.x, COUNTER.top + 0.06, TILL.z, 0.52, 0.34, 0.44, [0.2, 0.2, 0.22]);
  b.family(FAMILY.SOLID).material(SOLID.METAL_BARE, 0, 0, 0).color(0.7, 0.72, 0.74);
  box(b, TILL.x, COUNTER.top + 0.4, TILL.z - 0.05, 0.3, 0.1, 0.24, [0.7, 0.72, 0.74]);
  // A rack of the things you buy standing at the till, and a stack of crates by the door.
  shelfRun(b, COUNTER.x - 1.6, COUNTER.z + 1.5, 0, 1.1, p);
  for (let i = 0; i < 3; i++) box(b, -1.9 + (i % 2) * 0.7, 0.02 + Math.floor(i / 2) * 0.44, d - 1.6, 0.6, 0.42, 0.5, [0.62, 0.48, 0.3]);
  if (m) b.transform(m);
  return b.finish();
}

function buildSign(text, p, m) {
  const b = new MeshBuilder(200);
  const z = ROOM.depth / 2 + ROOM.wall + 0.06, y = ROOM.height - 0.62;
  box(b, 0, y, z, ROOM.width * 0.86, 0.52, 0.14, [0.12, 0.12, 0.13]);
  // The letters are tubes: nine segments of a seven-bar row per glyph, which is what a 1986 fascia was.
  b.family(FAMILY.SOLID).material(SOLID.NEON, 200, 0, 0).color(p.sign[0], p.sign[1], p.sign[2]);
  const glyphs = text.slice(0, 9);
  const cell = 0.4, x0 = -((glyphs.length - 1) * cell) / 2;
  for (let g = 0; g < glyphs.length; g++) {
    const bars = SEVEN[Math.min(9, glyphs.charCodeAt(g) % 10)] || SEVEN[0];
    for (let s = 0; s < 7; s++) {
      if (!(bars & (1 << s))) continue;
      const seg = SEG[s];
      tube(b, x0 + g * cell + seg[0] * 0.16, y + seg[1] * 0.22, z + 0.1, seg[2], seg[3], 0.035);
    }
  }
  if (m) b.transform(m);
  return b.finish();
}

// ---------------------------------------------------------------------------------------- the kit

/** The seven bars of a digit: top, top-left, top-right, middle, bottom-left, bottom-right, bottom. */
const SEVEN = [0b1110111, 0b0010010, 0b1011101, 0b1011011, 0b0111010, 0b1101011, 0b1101111, 0b1010010, 0b1111111, 0b1111011];
const SEG = [[-0.5, 0.5, 1, 0], [-0.5, 0, 0, -1], [0.5, 0, 0, -1], [-0.5, 0, 1, 0], [-0.5, -0.5, 0, 1], [0.5, -0.5, 0, 1], [-0.5, -0.5, 1, 0]];

function quad(b, x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3, n) {
  const i = b.count;
  const verts = [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2], [x3, y3, z3]];
  for (const v of verts) b.vertex(v[0], v[1], v[2], n[0], n[1], n[2], 0, 0);
  b.tri(i, i + 1, i + 2); b.tri(i, i + 2, i + 3);
}

function box(b, cx, y, cz, w, h, d, color) {
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y + h;
  b.family(FAMILY.SOLID).material(SOLID.METAL_PAINTED, 0, 0, 0).color(color[0], color[1], color[2]);
  quad(b, x0, y, z1, x1, y, z1, x1, y1, z1, x0, y1, z1, [0, 0, 1]);
  quad(b, x1, y, z0, x0, y, z0, x0, y1, z0, x1, y1, z0, [0, 0, -1]);
  quad(b, x1, y, z1, x1, y, z0, x1, y1, z0, x1, y1, z1, [1, 0, 0]);
  quad(b, x0, y, z0, x0, y, z1, x0, y1, z1, x0, y1, z0, [-1, 0, 0]);
  quad(b, x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, [0, 1, 0]);
  quad(b, x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1, [0, -1, 0]);
}

function tube(b, x, y, z, dx, dz, r) {
  // A segment as a flat ribbon facing into the room: neon is read as a line, and a dozen triangles per bar
  // is a dozen too many for a sign nobody looks at from behind.
  const l = Math.max(1e-6, Math.hypot(dx, dz));
  const ux = (-dz / l) * r, uz = (dx / l) * r;
  const hw = (l > 0.5 ? 0 : r) + r * 0.9;      // a horizontal bar has height because of its length
  quad(b, x - ux, y - hw, z - uz, x + ux, y - hw, z + uz, x + ux, y + hw, z + uz, x - ux, y + hw, z - uz, [0, 0, 1]);
}

/** A gondola: two ends, four boards and the goods on them. */
function shelfRun(b, x, z, yaw, length, p) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const at = (lx, lz, ly, h, col, w = 0.62) => {
    const px = x + lx * c - lz * s, pz = z + lx * s + lz * c;
    box(b, px, ly, pz, w, h, length, col);
  };
  at(0, 0, 0, 0.16, [0.4, 0.4, 0.42]);
  for (let i = 1; i <= 3; i++) at(0, 0, 0.16 + (i - 1) * 0.52, 0.05, p.shelf);
  // Goods: rows of tins and boxes at three heights, in the shop's own colours.
  for (let row = 0; row < 3; row++) {
    const y = 0.21 + row * 0.52;
    for (let j = 0; j < 9; j++) {
      const lx = -0.12 + ((j % 3) - 1) * 0.2, lz = -length / 2 + 0.28 + j * (length - 0.5) / 8;
      const tint = 0.72 + 0.28 * (((j * 5 + row * 3) % 4) / 3);
      at(lx, lz, y, 0.24, [p.goods[0] * tint, p.goods[1] * tint * 0.9, p.goods[2] * tint]);
    }
  }
}

/** Light records: three ceiling strips as tubes, the fridges and the sign as points, in the room's frame. */
function lightList(p) {
  const w = ROOM.width / 2, d = ROOM.depth / 2, h = ROOM.height - 0.2;
  const list = [];
  for (const cx of [-w / 2, 0, w / 2]) {
    list.push({ kind: 'tube', a: [cx, h, -d * 0.62], b: [cx, h, d * 0.62], radius: 0.2, color: [1, 0.98, 0.9], range: 8.5, group: 'ceiling' });
  }
  list.push({ kind: 'point', position: [0, d + ROOM.wall + 0.3, ROOM.height - 0.6], color: p.sign, range: 6.5, group: 'sign' });
  list.push({ kind: 'point', position: [-w + 3, -d - 0.4, 1.9], color: [0.7, 0.85, 1], range: 5, group: 'fridge' });
  return list;
}

function glowList(lights, p) {
  const g = [];
  for (const l of lights) {
    if (l.kind === 'tube') g.push({ position: [(l.a[0] + l.b[0]) / 2, l.a[1], (l.a[2] + l.b[2]) / 2], size: 1.1, color: l.color, channel: CHANNEL.ALWAYS });
    else g.push({ position: l.position, size: 0.6, color: l.color, channel: CHANNEL.NEON });
  }
  return g;
}

/** The frame's light records, `LIGHT_STRIDE` apart, translated by `origin`. See world/garage/index.js. */
export function lightRecords(set, maxLights = 24, origin = [0, 0, 0]) {
  const list = set.lights.slice(0, Math.max(0, maxLights));
  const records = new Float32Array(list.length * LIGHT_STRIDE);
  list.forEach((l, i) => {
    const o = i * LIGHT_STRIDE;
    const p = l.kind === 'tube' ? [(l.a[0] + l.b[0]) / 2, l.a[1], (l.a[2] + l.b[2]) / 2] : l.position;
    records[o] = p[0] + origin[0]; records[o + 1] = p[1] + origin[1]; records[o + 2] = p[2] + origin[2];
    records[o + 3] = l.range; records[o + 4] = l.color[0]; records[o + 5] = l.color[1]; records[o + 6] = l.color[2];
    if (l.kind === 'tube') {
      const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], dz = l.b[2] - l.a[2];
      const len = Math.max(1e-6, Math.hypot(dx, dy, dz));
      records[o + 7] = 3;
      records[o + 8] = dx / len; records[o + 9] = dy / len; records[o + 10] = dz / len;
      records[o + 11] = len / 2; records[o + 15] = l.radius;
    } else {
      records[o + 7] = 0;
      records[o + 8] = 0; records[o + 9] = -1; records[o + 10] = 0;
      records[o + 11] = 1; records[o + 12] = 1; records[o + 15] = 0.12;
    }
  });
  return { records, groups: list.map((l) => l.group) };
}

export function glowRecords(set, origin = [0, 0, 0]) {
  const records = new Float32Array(set.glows.length * GLOW_STRIDE);
  set.glows.forEach((g, i) => {
    const o = i * GLOW_STRIDE;
    records[o] = g.position[0] + origin[0]; records[o + 1] = g.position[1] + origin[1]; records[o + 2] = g.position[2] + origin[2];
    records[o + 3] = g.size; records[o + 4] = g.color[0]; records[o + 5] = g.color[1]; records[o + 6] = g.color[2];
    records[o + 7] = g.channel;
  });
  return records;
}
