// Boats: hulls for the water the city already has.
//
// The coast map meshes a sea, the docks put piers into it, and until now nothing floated. A boat here is
// three pieces wearing one name: a hull mesh lofted from sections the way the cars are lofted from
// theirs (no download — the marina's whole fleet is a few hundred triangles of procedure), a body in
// physics/boat.js that floats it on Archimedes, and a dynamic handle the renderer already knows how to
// hold. Moorings come from the plan: wherever the city put a marina, a docks or a boatyard, a boat is
// tied up a cast of the line offshore, facing out.
//
// The interface mirrors traffic's on purpose — `nearestTo` for a hand at a gunwale, `step` for the frame —
// because the door into a boat is the same door as into a car, and game/boarding.js does not care what is
// on the other side of it.

import { MeshBuilder } from '../core/mesh.js';
import { FAMILY } from '../core/ids.js';
import { createBoat, boatSpec } from '../physics/boat.js';

/** Metres from a landmark's door to the water its boats lie in, and how many boats a city gets. */
const MOOR_CAST = 26, MAX_BOATS = 6;
/** The kinds of landmark that keep boats. */
const WATERSIDE = new Set(['marina', 'docks', 'boatyard']);

/**
 * A hard-chine skiff, lofted from eleven stations: keel, chine and sheer a side, and a deck line down
 * the middle. Double-wound, because a hull is seen from the water as often as from the air and a
 * culled inside is a hole in the boat.
 * @param {object} spec  a boatSpec, for the hull's own metres
 * @param {number[]} tint 0..1 rgb of the topsides
 */
export function hullBuilder(spec, tint = [0.92, 0.9, 0.85]) {
  const b = new MeshBuilder(512);
  b.family(FAMILY.SOLID);
  const N = 10;
  const rings = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = (t - 0.5) * spec.length;
    // Half-beam: a transom at the stern, fullness amidships, a stem at the bow.
    const w = (spec.beam / 2) * Math.sqrt(Math.max(0.06, 1 - Math.pow(2 * t - 1, 2) * 0.9));
    const rise = t * t;                       // the keel runs up towards the stem
    const yk = -0.55 + 0.4 * rise;
    const yc = -0.22 + 0.25 * rise;
    const ys = 0.34;
    rings.push([
      [0, yk, z],                              // keel
      [-w * 0.82, yc, z], [-w, ys, z],         // chine and sheer, left
      [0, ys - 0.1, z],                        // deck line
      [w, ys, z], [w * 0.82, yc, z],           // sheer and chine, right
    ]);
  }
  const quad = (p, q, r, s, col) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
    const vx = s[0] - p[0], vy = s[1] - p[1], vz = s[2] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    b.color(col);
    const a = b.vertex(...p, nx, ny, nz), c = b.vertex(...q, nx, ny, nz);
    const d = b.vertex(...r, nx, ny, nz), e = b.vertex(...s, nx, ny, nz);
    b.quad(a, c, d, e);
    b.quad(a, e, d, c);
  };
  const hull = [0.62 * tint[0], 0.62 * tint[1], 0.66 * tint[2]];
  for (let i = 0; i < N; i++) {
    const A = rings[i], B = rings[i + 1];
    quad(A[0], A[1], B[1], B[0], hull);        // bottom, left
    quad(A[1], A[2], B[2], B[1], tint);        // topsides, left
    quad(A[2], A[3], B[3], B[2], [0.55, 0.5, 0.44]);   // deck, left
    quad(A[3], A[4], B[4], B[3], [0.55, 0.5, 0.44]);   // deck, right
    quad(A[4], A[5], B[5], B[4], tint);        // topsides, right
    quad(A[5], A[0], B[0], B[5], hull);        // bottom, right
  }
  return b;
}

/**
 * @param {{
 *   renderer?: object,              absent in a test: the boats still float, they are just not seen
 *   plan?: object,                  the page-side plan, for its landmarks
 *   water?: (x: number, z: number) => number,   the surface; defaults to 0
 *   field?: (x: number, z: number) => {kind: string},   the coast map, to find the water from a door
 * }} deps
 */
export function createBoats(deps = {}) {
  const renderer = deps.renderer || null;
  const water = deps.water || (() => 0);
  const field = deps.field || null;
  const boats = [];
  const landmarks = (deps.plan && deps.plan.landmarks) || [];
  let made = 0;
  for (const lm of landmarks) {
    if (made >= MAX_BOATS) break;
    if (!lm || !WATERSIDE.has(lm.kind)) continue;
    // The worker's layout landmarks use `pos: [x, z]`; the page-side plan deliberately flattens those
    // into `{ x, z }` before it crosses the worker boundary. Accept both shapes: game modules receive
    // the page-side plan, while callers and tests may still have a layout record.
    const lx = lm.pos && Number.isFinite(lm.pos[0]) ? lm.pos[0] : lm.x;
    const lz = lm.pos && Number.isFinite(lm.pos[1]) ? lm.pos[1] : lm.z;
    if (!Number.isFinite(lx) || !Number.isFinite(lz)) continue;
    // Cast a line from the door until the coast map says water: a marina's boats lie in its water, not
    // on its hard standing.
    let spot = null;
    for (let a = 0; a < 16 && !spot; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const x = lx + Math.sin(ang) * MOOR_CAST, z = lz + Math.cos(ang) * MOOR_CAST;
      if (field && field(x, z).kind === 'water') spot = [x, z, ang];
    }
    if (!spot) continue;
    const spec = boatSpec({ mass: 1300 + made * 160, length: 6.2 + (made % 3) * 0.7, beam: 2.3 + (made % 2) * 0.3 });
    const boat = createBoat(spec, { x: spot[0], y: water(spot[0], spot[1]), z: spot[1], yaw: spot[2] });
    let dynamic = null, handle = null;
    if (renderer) {
      const b = hullBuilder(spec, made % 2 ? [0.85, 0.88, 0.9] : [0.93, 0.9, 0.82]);
      handle = renderer.createMesh(b.finish(), { retain: false });
      dynamic = renderer.addDynamic({ mesh: handle, castShadow: true });
      writeMatrix(dynamic.matrix, boat);
    }
    boats.push({ id: made, name: made % 2 ? 'Harbour skiff' : 'Marina runabout', boat, dynamic, handle, taken: false });
    made++;
  }

  const fleet = {
    boats,
    get count() { return boats.length; },
    /** The nearest boat within reach of a hand, in traffic's own shape. */
    nearestTo(x, z, reach = 3.4) {
      let best = null, bd = reach;
      for (const entry of boats) {
        const d = Math.hypot(entry.boat.pos[0] - x, entry.boat.pos[2] - z);
        if (d < bd) { bd = d; best = entry; }
      }
      return best ? { id: best.id, name: best.name, distance: bd, x: best.boat.pos[0], z: best.boat.pos[2], yaw: best.boat.yaw } : null;
    },
    get(id) { return boats[id] || null; },
    /** One frame: the water argues with every hull, and the drawn one follows its body. */
    step(dt, drivenId = -1, input = null) {
      for (const entry of boats) {
        entry.boat.step(dt, entry.id === drivenId && input ? input : {});
        if (entry.dynamic) writeMatrix(entry.dynamic.matrix, entry.boat);
      }
      return fleet;
    },
    dispose() {
      for (const entry of boats) {
        if (entry.dynamic) entry.dynamic.remove();
        if (renderer && entry.handle) renderer.destroyMesh(entry.handle);
      }
      boats.length = 0;
    },
  };
  return fleet;
}

/** The dynamic's matrix from a boat's pose: heading, then the small pitch and roll, then the water. */
function writeMatrix(m, boat) {
  const [x, y, z, w] = boat.renderQuat;
  // rows of the rotation, straight from the quaternion
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w); m[3] = 0;
  m[4] = 2 * (x * y + z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z - x * w); m[7] = 0;
  m[8] = 2 * (x * z - y * w); m[9] = 2 * (y * z + x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
  m[12] = boat.pos[0]; m[13] = boat.pos[1]; m[14] = boat.pos[2]; m[15] = 1;
}
