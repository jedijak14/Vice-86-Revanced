// Motorcycles: the machines leaning on the kerb, and the ones you take off them.
//
// A bike here is three pieces wearing one name, exactly as a boat is: a mesh lofted from the same
// primitives the cars are lofted from (no download — a fleet of twelve is a few thousand triangles of
// procedure), a body in physics/bike.js that turns by leaning rather than by pointing, and a dynamic
// handle the renderer already knows how to hold. Where they stand comes from the plan's own lane graph:
// a bike is parked on the kerb beside a road, facing the way the road runs, because that is how a city
// full of them looks, and because a kerb is a place the player walks past and a hand reaches.
//
// The interface is traffic's and the marina's on purpose — `nearestTo` for a hand on a bar, `step` for
// the frame — because the door into a bike is the same door as into a car, and game/boarding.js does
// not care what is on the other side of it.

import { MeshBuilder } from '../core/mesh.js';
import { Skin } from '../vehicles/traffic/skin.js';
import { lathe, box, rod, disc, X, Y, Z } from '../vehicles/traffic/kit.js';
import * as mt from '../vehicles/traffic/materials.js';
import { bikeSpec, createBike, BIKES } from '../physics/bike.js';
import { samplePoint, laneYaw } from './lanes.js';

/** Metres from a handrail to a hand, and how far off the centreline a parked bike stands. */
export const BOARD_REACH = 2.4, KERB_CAST = 1.35;
/** Twelve machines on a city's kerbs, drawn from the three kinds in proportion to how common they are. */
export const PARKED = Object.freeze(['scooter', 'roadster', 'scooter', 'cruiser', 'roadster', 'scooter',
  'cruiser', 'roadster', 'scooter', 'roadster', 'cruiser', 'scooter']);
/** The paint each kind wears, and the steel under it. */
const PAINT = Object.freeze({
  scooter: [[0.86, 0.83, 0.72], [0.32, 0.52, 0.5], [0.72, 0.28, 0.24], [0.2, 0.24, 0.42]],
  roadster: [[0.62, 0.08, 0.1], [0.1, 0.12, 0.16], [0.86, 0.85, 0.82], [0.18, 0.3, 0.55]],
  cruiser: [[0.09, 0.09, 0.1], [0.5, 0.1, 0.12], [0.28, 0.3, 0.34], [0.72, 0.6, 0.2]],
});

/**
 * One machine's body, in its own frame: +Z the front wheel, +X the rider's left (the same axis an
 * aeroplane banks about, on a map whose +Z is south), and the origin on the ground between the two
 * contact patches, which is where the physics puts it.
 * @param {object} spec   a bikeSpec
 * @param {number[]} paint  0..1 rgb of the tank and the guards
 */
export function buildBikeMesh(spec, paint = [0.62, 0.08, 0.1]) {
  const mb = new MeshBuilder(1500);
  const sk = new Skin(mb);
  const wb = spec.wheelbase, R = spec.wheelR, seat = spec.seat;
  const body = mt.fixed(paint, false);
  const steel = mt.dullMetal;
  const chrome = mt.chrome;
  const rubber = mt.rubber;
  const dark = mt.trim(0.65, [0.13, 0.13, 0.14]);
  const lens = mt.fixed([0.9, 0.88, 0.74], false);
  const screen = mt.glass([0.24, 0.28, 0.3]);   // real glass, so the roadster's screen shows what is behind it

  // The wheels: a tyre as a short thick rod, a hub as a disc, and a few spokes to catch the light.
  for (const z of [wb / 2, -wb / 2]) {
    const rear = z < 0;
    const w = rear ? 0.11 : 0.09;
    lathe(sk, rubber, [0, R, z - w], Z, X, Y, [
      { r: R * 0.62, h: 0, nr: 0.2, nh: -1 }, { r: R, h: w * 0.35, nr: 1, nh: 0.3 },
      { r: R, h: w * 0.65, nr: 1, nh: 0 }, { r: R * 0.62, h: w, nr: 0.2, nh: 1 },
    ], 12);
    for (const side of [-1, 1]) {
      disc(sk, steel, [side * w * 0.5, R, z], [side, 0, 0], Y, Z, R * 0.55, 10, 1, R * 0.12);
    }
    // Spokes: a crossed pair a side, which is what makes a wheel read as a wheel at twenty metres.
    for (let s = 0; s < 5; s++) {
      const a = (s / 5) * Math.PI * 2;
      rod(sk, chrome, [0, R + Math.sin(a) * R * 0.14, z + Math.cos(a) * R * 0.14],
        [0, R + Math.sin(a + Math.PI) * R * 0.5, z + Math.cos(a + Math.PI) * R * 0.5], 0.012, 3, false);
    }
  }

  // ---- the frame: a spine from the steering head to the swingarm's pivot, and the rear loop ----
  const headZ = wb * 0.34, headY = seat + 0.24;
  const pivotZ = -wb * 0.12, pivotY = R + 0.1;
  rod(sk, steel, [0, pivotY, pivotZ], [0, headY - 0.1, headZ - 0.06], 0.035, 5, false);
  rod(sk, steel, [0, seat - 0.06, -wb * 0.3], [0, pivotY + 0.04, pivotZ], 0.03, 5, false);
  for (const side of [-1, 1]) {
    rod(sk, steel, [side * 0.05, R + 0.02, -wb / 2], [side * 0.05, pivotY, pivotZ], 0.026, 4, false);
    rod(sk, steel, [side * 0.09, seat - 0.02, -wb * 0.32], [side * 0.06, pivotY + 0.06, pivotZ], 0.02, 4, false);
  }
  // The forks, and the bars across the top of them.
  for (const side of [-1, 1]) {
    rod(sk, chrome, [side * 0.1, R, wb / 2], [side * 0.11, headY + 0.06, headZ], 0.022, 5, false);
  }
  rod(sk, steel, [-0.32, headY + 0.1, headZ - 0.02], [0.32, headY + 0.1, headZ - 0.02], 0.018, 5, true);
  for (const side of [-1, 1]) {
    rod(sk, dark, [side * 0.26, headY + 0.1, headZ - 0.02], [side * 0.34, headY + 0.09, headZ - 0.05], 0.024, 5, true);
  }

  // ---- the tank and the seat: the two shapes a rider knows a machine by ----
  box(sk, body, [0, seat + 0.1, wb * 0.1], [0.15, 0.13, wb * 0.2], {});
  box(sk, body, [0, seat + 0.16, wb * 0.24], [0.1, 0.07, 0.07], {});
  box(sk, dark, [0, seat + 0.02, -wb * 0.1], [0.14, 0.055, wb * 0.2], {});
  if (spec.kind === 'cruiser') {
    // A pillion pad and a sissy bar, which is what a big twin has at the back of it.
    box(sk, dark, [0, seat + 0.03, -wb * 0.34], [0.12, 0.05, 0.12], {});
    rod(sk, chrome, [0, seat + 0.05, -wb * 0.46], [0, seat + 0.34, -wb * 0.44], 0.018, 4, true);
  }

  // ---- the engine: a block with fins on it, and the pipe that comes out of it ----
  const engY = R + 0.16, engZ = wb * 0.02;
  box(sk, steel, [0, engY, engZ], [0.17, 0.15, 0.2], {});
  for (let f = 0; f < 5; f++) {
    box(sk, steel, [0, engY + 0.1 + f * 0.035, engZ], [0.19, 0.008, 0.19], {});
  }
  if (spec.kind === 'cruiser') {
    for (const side of [-1, 1]) {
      box(sk, steel, [side * 0.13, engY + 0.02, engZ - 0.1], [0.09, 0.14, 0.09], {});
    }
  }
  for (const side of spec.kind === 'roadster' ? [-1, 1] : [1]) {
    rod(sk, chrome, [side * 0.16, engY + 0.02, engZ + 0.1], [side * 0.2, R * 0.7, -wb * 0.42], 0.028, 5, false);
    rod(sk, chrome, [side * 0.2, R * 0.7, -wb * 0.42], [side * 0.2, R * 0.72, -wb * 0.62], 0.042, 5, true);
  }

  // ---- the guards, the lamp, and the tail ----
  box(sk, body, [0, R * 1.85, wb / 2 - 0.02], [0.11, 0.035, 0.24], {});
  box(sk, body, [0, R * 1.9, -wb / 2 + 0.04], [0.1, 0.035, 0.22], {});
  disc(sk, lens, [0, headY + 0.02, headZ + 0.13], Z, X, Y, 0.1, 10);
  rod(sk, dark, [0, headY + 0.02, headZ + 0.13], [0, headY + 0.02, headZ + 0.06], 0.1, 10, false);
  box(sk, mt.fixed([0.6, 0.07, 0.08], false), [0, seat + 0.06, -wb * 0.48], [0.05, 0.035, 0.02], {});
  // The bits a rider's boots and hands actually touch, and the drive that goes between them.
  for (const side of [-1, 1]) {
    box(sk, dark, [side * 0.24, R + 0.1, engZ - 0.14], [0.09, 0.014, 0.014], {});   // footpegs
    rod(sk, chrome, [side * 0.1, seat + 0.06, -wb * 0.26], [side * 0.12, R + 0.06, pivotZ], 0.014, 4, false);
  }
  // The rear suspension: two shocks, and a chain or a belt under them, which is the difference between a
  // roadster and a cruiser that you can see from behind at a set of lights.
  for (const side of [-1, 1]) {
    rod(sk, chrome, [side * 0.09, pivotY + 0.02, pivotZ + 0.02], [side * 0.1, seat - 0.02, -wb * 0.3], 0.016, 4, false);
    rod(sk, dark, [side * 0.09, pivotY + 0.2, pivotZ + 0.02], [side * 0.1, seat - 0.02, -wb * 0.3], 0.022, 4, false);
  }
  const driveY = spec.kind === 'cruiser' ? R * 0.9 : R * 0.62;
  rod(sk, spec.kind === 'cruiser' ? dark : steel, [0.13, driveY, -wb / 2 + 0.04], [0.13, R + 0.02, pivotZ], 0.026, 5, false);
  disc(sk, steel, [0.13, R + 0.02, pivotZ], X, Y, Z, 0.07, 8);
  // A fairing and a screen on the roadster, panniers on the cruiser: what the two of them are for.
  if (spec.kind === 'roadster') {
    box(sk, body, [0, headY - 0.02, headZ + 0.2], [0.24, 0.2, 0.1], {});
    box(sk, screen, [0, headY + 0.2, headZ + 0.22], [0.2, 0.12, 0.03], {});
  } else if (spec.kind === 'cruiser') {
    for (const side of [-1, 1]) box(sk, dark, [side * 0.26, seat - 0.1, -wb * 0.3], [0.1, 0.14, 0.2], {});
  }
  // The stand, down whenever the machine is stopped and upright, because that is where it is leaning.
  rod(sk, steel, [-0.06, pivotY, pivotZ + 0.1], [-0.3, 0.02, pivotZ + 0.02], 0.016, 4, false);
  // The mirrors and the number plate: small, and what makes it read as a machine rather than a frame.
  for (const side of [-1, 1]) {
    rod(sk, dark, [side * 0.24, headY + 0.12, headZ], [side * 0.3, headY + 0.28, headZ + 0.06], 0.008, 3, false);
    box(sk, dark, [side * 0.3, headY + 0.3, headZ + 0.07], [0.05, 0.035, 0.012], {});
  }
  box(sk, mt.fixed([0.9, 0.9, 0.86], false), [0, R * 1.2, -wb * 0.55], [0.09, 0.07, 0.01], {});
  return mb.finish();
}

/**
 * @param {{
 *   renderer?: object, graph?: object|null, seed?: number, count?: number,
 *   ground?: (x: number, z: number) => number, at?: Array<[number, number]>,
 * }} deps
 *   `at` overrides where the machines are parked, which is what a test wants; without it they are found
 *   on the kerbs of the plan's own lane graph, spread around the map rather than bunched at the spawn.
 */
export function createBikes(deps = {}) {
  const renderer = deps.renderer || null;
  const graph = deps.graph || null;
  const ground = deps.ground || (() => 1.2);
  const seed = (deps.seed | 0) || 11;
  const count = Math.max(1, Math.min(48, deps.count || PARKED.length));
  const out = [0, 0, 0];
  const bikes = [];

  /** Where the next machine stands: a station on a road lane, pushed out to the kerb. */
  function kerbSpot(i) {
    if (deps.at && deps.at[i]) return { x: deps.at[i][0], z: deps.at[i][1], yaw: 0 };
    if (!graph || typeof graph.nearest !== 'function') return { x: 24 + i * 7, z: 12 + (i % 4) * 6, yaw: 0 };
    // A ring of guesses around the map, so the kerbs are not all the same kerb. A city with roads
    // everywhere answers the first guess; a sparse one may not, so the guess is walked in towards the
    // middle before it is given up on, and a machine is never left unplaced for want of a kerb — twelve
    // places on the list is twelve machines on the street, which is what a player counts.
    const a = (i / count) * Math.PI * 2 + (seed % 7) * 0.31;
    const rad = 120 + (i * 97) % 640;
    const onRoad = (lane) => !lane.junction && lane.junctionId < 0 && lane.length > 24;
    let hit = null;
    for (const shrink of [1, 0.5, 0.25, 0.08]) {
      hit = graph.nearest(Math.sin(a) * rad * shrink, Math.cos(a) * rad * shrink, 160, onRoad);
      if (hit && hit.lane) break;
      hit = null;
    }
    if (!hit) return { x: 24 + i * 7, z: 12 + (i % 4) * 6, yaw: 0 };
    const lane = hit.lane;
    // Where along it: near the guess, but stepped by the machine's own index so that two of them which
    // found the same lane are not standing on the same spot. Twenty-three metres is a gap a rider would
    // walk between, and it wraps, so a short lane is used up and a long one is spread along.
    const span = Math.max(4, lane.length - 4);
    const guess = hit.s === undefined ? lane.length * 0.5 : hit.s;
    const s = 2 + ((guess + i * 23) % span);
    samplePoint(lane, s, out);
    const yaw = laneYaw(lane, s);
    const off = (lane.width || 3.4) / 2 + KERB_CAST;
    const side = i % 2 ? 1 : -1;
    return {
      x: out[0] - Math.cos(yaw) * off * side,
      z: out[2] + Math.sin(yaw) * off * side,
      yaw: yaw + (side > 0 ? 0 : Math.PI),
    };
  }

  const meshes = new Map();
  for (let i = 0; i < count; i++) {
    const spot = kerbSpot(i);
    if (!spot) continue;
    const kind = PARKED[i % PARKED.length];
    const spec = bikeSpec(kind);
    const colour = (i * 3 + seed) % PAINT[kind].length;
    const paint = PAINT[kind][colour];
    const bike = createBike(spec, { x: spot.x, y: 0, z: spot.z, yaw: spot.yaw, ground });
    bike.refuel(spec.tank * (0.5 + ((i * 37 + seed) % 50) / 100));
    // One mesh per kind *and colour*, twelve handles: the geometry is the same machine over and over, but
    // a kerb of six scooters that are all the same colour is a kerb somebody copied, and the paint is
    // baked into the vertices so it cannot be varied per instance. Four schemes to a kind is the most
    // this can ever upload, and sharing them is what keeps a city from stuttering when you look at it.
    const key = `${kind}:${colour}`;
    let handle = meshes.get(key);
    if (handle === undefined) {
      try { handle = renderer ? renderer.createMesh(buildBikeMesh(spec, paint), { retain: true }) : -1; }
      catch (error) { console.error('A motorcycle could not be drawn', error); handle = -1; }
      meshes.set(key, handle);
    }
    let dynamic = null;
    if (renderer && handle >= 0) {
      try {
        dynamic = renderer.addDynamic({ mesh: handle, castShadow: true });
        writeMatrix(dynamic.matrix, bike);
      } catch (error) { dynamic = null; }
    }
    bikes.push({ id: bikes.length, name: spec.name, kind, paint, bike, dynamic, handle, taken: false });
  }

  const rack = {
    /** What it holds, so a boarding branch and the panel can tell one machine from another. */
    kind: 'bike',
    bikes,
    get count() { return bikes.length; },
    get(id) { return bikes[id] || null; },

    /** The nearest machine within reach of a hand, in traffic's own shape. */
    nearestTo(x, z, reach = BOARD_REACH) {
      let best = null, bd = reach;
      for (const entry of bikes) {
        const d = Math.hypot(entry.bike.pos[0] - x, entry.bike.pos[2] - z);
        if (d < bd) { bd = d; best = entry; }
      }
      if (!best) return null;
      return {
        id: best.id, name: best.name, distance: bd,
        x: best.bike.pos[0], z: best.bike.pos[2], yaw: best.bike.yaw,
      };
    },

    /** One frame: the rider argues with every machine that has one, and the drawn ones follow. */
    step(dt, drivenId = -1, input = null) {
      for (const entry of bikes) {
        entry.bike.step(dt, entry.id === drivenId && input ? input : {});
        if (entry.dynamic) writeMatrix(entry.dynamic.matrix, entry.bike);
      }
      return rack;
    },

    /** Pick a machine up off the tarmac, and put it back where it was leaning. Null for one it has not
     *  got, which is what get() and nearestTo() do, so a caller can test the answer rather than catch it. */
    right(id) { const e = bikes[id] || null; if (e) e.bike.right(); return e; },

    dispose() {
      for (const entry of bikes) if (entry.dynamic) entry.dynamic.remove();
      if (renderer) for (const handle of meshes.values()) if (handle >= 0) renderer.destroyMesh(handle);
      meshes.clear();
      bikes.length = 0;
    },
  };
  return rack;
}

/** How far a seated body's hips sit above its own origin, which the models put between the feet. */
export const RIDER_HIP = 0.46;

/**
 * The dynamic's matrix from a machine's pose: the heading, then the lean, then the pitch. `at` moves it
 * somewhere other than the contact patches, which is how a rider is put on the saddle rather than under it.
 */
export function writeMatrix(m, bike, at = null) {
  const [x, y, z, w] = bike.renderQuat;
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w); m[3] = 0;
  m[4] = 2 * (x * y + z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z - x * w); m[7] = 0;
  m[8] = 2 * (x * z - y * w); m[9] = 2 * (y * z + x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
  m[12] = at ? at[0] : bike.pos[0]; m[13] = at ? at[1] : bike.pos[1]; m[14] = at ? at[2] : bike.pos[2]; m[15] = 1;
}

/**
 * What a rider reads: how fast, which gear, how far over the machine is, and the two things that mean
 * the tyres or the tarmac have won. Kept beside the fleet rather than in the physics, because these are
 * the rider's units and not the equation's.
 */
export function bikeInstruments(bike) {
  return {
    kind: 'bike',
    speed: Math.round(Math.abs(bike.speed) * 3.6),
    gear: bike.gear, gears: bike.spec.gears.length,
    rpm: Math.round(bike.rpm), redline: bike.spec.redline,
    lean: Math.round(bike.lean * 180 / Math.PI),
    sliding: !!bike.sliding, fallen: !!bike.fallen, footDown: !!bike.footDown,
    fuel: bike.fuelKg / bike.spec.tank,
  };
}

export { BIKES };
