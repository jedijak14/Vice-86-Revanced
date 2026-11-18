// What stands and hangs in the room. Everything keeps to a band along the walls: the camera's box and the car's
// turning circle stay empty (plan.js). The working end of the garage is the back: bench, shelving, chest, tyres and
// compressor stand from the middle piers to the sign wall, where the camera looks; the street end of both side
// walls is left to the low neon lines (runs.js), which nothing may stand in front of.

import { place } from '../props/kit.js';
import { ROOM, SIDE_DOOR, RADIANCE } from './plan.js';
import { PIER } from './shell.js';
import { TYRE, tyreStack, tyreLeaning, drum, trolleyJack, creeper, compressor, hoseReel, wallFan, wallClock, extinguisher, stepladder, broom, bulkhead, switchboard } from './gear.js';
import { toolChest, shelving } from './storage.js';
import { BENCH, workbench, pegboard, stool } from './bench.js';

const WEST = Math.PI / 2, EAST = -Math.PI / 2, BACK = 0;
const WARM = [1.0, 0.62, 0.32];                    // linear colour of a filament lamp's light

/**
 * Build the dressing into k. Returns { footprints, lights, glows }: where things stand on the floor (for the dust
 * baked into it), and the small lamps among them.
 */
export function buildDressing(k) {
  const footprints = [], lights = [], glows = [];
  const xw = ROOM.x0 + 0.02, xe = ROOM.x1 - 0.02, zb = ROOM.z0 + 0.02;       // a finger's gap off each wall
  /** Build one thing in its own frame (back to the wall at z = 0) and stand it at (x, y, z) turned by yaw. */
  const put = (x, y, z, yaw, build, foot = null) => {
    const c = k.child(), out = build(c), m = place(x, y, z, yaw);
    k.add(c, m);
    if (foot) {
      // the footprint's corners turned into the room: yaw is a quarter turn or none for everything that stands
      const cs = Math.round(Math.cos(yaw)), sn = Math.round(Math.sin(yaw)), xs = [], zs = [];
      for (const [fx, fz] of [[foot[0], foot[1]], [foot[2], foot[3]]]) { xs.push(x + fx * cs + fz * sn); zs.push(z - fx * sn + fz * cs); }
      footprints.push({ x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) });
    }
    const at = (p) => [x + p[0] * Math.cos(yaw) + p[2] * Math.sin(yaw), y + p[1], z - p[0] * Math.sin(yaw) + p[2] * Math.cos(yaw)];
    return { out, at, dir: (d) => { const p = at(d); return [p[0] - x, p[1] - y, p[2] - z]; } };
  };

  // ---------------------------------------------------------------- west wall: shelving, the fan, the bench
  put(xw, 0, -6.0, WEST, (c) => shelving(c, 2, 11), [-0.9, 0, 0.9, 0.45]);
  put(ROOM.x0 + PIER.d, 3.05, -4.5, WEST, wallFan);
  const lampRadiance = 9;
  const bench = put(xw, 0, -3.0, WEST, (c) => { const lamp = workbench(c, lampRadiance); pegboard(c, 1.14); return lamp; }, [-BENCH.w / 2, 0, BENCH.w / 2, BENCH.d]);
  put(-6.42, 0, -1.93, 0.4, stool);
  footprints.push({ x0: -6.64, z0: -2.15, x1: -6.2, z1: -1.71 });
  const bulb = bench.at(bench.out.bulb);
  lights.push({ kind: 'spot', group: 'bench-lamp', position: bulb, axis: bench.dir(bench.out.axis), color: WARM.map((v) => v * 7), range: 3.2, outerDeg: 118, innerDeg: 60, sourceRadius: 0.03 });
  glows.push({ position: bulb, size: 0.5, color: WARM.map((v) => v * 1.6) });

  // ---------------------------------------------------------------- back wall: the corner by the shelving, and the floor under the sign
  put(-6.56, 0, zb, BACK, (c) => tyreStack(c, [[0, 0], [0.02, 0.015], [-0.015, 0.03], [0.01, 0.01]]), [-TYRE.r, 0, TYRE.r, 2 * TYRE.r + 0.06]);
  put(-5.8, 0, zb + 0.36, 0.5, (c) => drum(c, [0.1, 0.2, 0.36], true));
  footprints.push({ x0: -6.1, z0: zb + 0.06, x1: -5.5, z1: zb + 0.66 });
  put(-5.0, 0, zb + 0.05, BACK, toolChest, [-0.34, 0, 0.34, 0.46]);
  put(-5.95, 2.55, ROOM.z0, BACK, wallClock);
  put(-1.9, 0, -8.55, 0.25, trolleyJack);
  footprints.push({ x0: -2.1, z0: -8.6, x1: -1.6, z1: -7.85 });
  put(1.3, 0, -8.5, 0.06, creeper);
  footprints.push({ x0: 0.8, z0: -8.72, x1: 1.8, z1: -8.28 });
  put(5.15, 0, zb + 0.34, 2.1, (c) => drum(c, [0.62, 0.42, 0.08], false));
  footprints.push({ x0: 4.85, z0: zb + 0.04, x1: 5.45, z1: zb + 0.64 });
  put(5.85, 0, zb, BACK, (c) => { tyreLeaning(c, -0.34, 0.2); tyreLeaning(c, 0.34, 0.27); return c; });

  // ---------------------------------------------------------------- east wall: ladder, compressor and reel, parts shelving, the door's end
  put(xe, 0, -8.3, EAST, stepladder);
  const comp = put(xe - 0.06, 0, -6.1, EAST, compressor, [-0.5, 0, 0.5, 0.56]);
  const reel = put(ROOM.x1 - PIER.d, 1.55, -4.5, EAST, hoseReel);
  // the reel's feed: a rubber hose from the compressor's outlet along the foot of the pier and up to the reel
  k.rubber([0.5, 0.09, 0.06], 0.6);
  const feed = [comp.at([0.42, 0.72, 0.3]), comp.at([0.6, 0.5, 0.2]), comp.at([0.8, 0.12, 0.14]), [ROOM.x1 - PIER.d - 0.04, 0.02, -4.9], [ROOM.x1 - PIER.d - 0.05, 0.03, -4.62], reel.at([0.1, -0.9, 0.05]), reel.at([0.1, -0.12, 0.05])];
  k.tube(smooth(feed), 0.011, 6, { capA: true, capB: true });
  put(xe, 0, -3.55, EAST, (c) => shelving(c, 1, 23, true), [-0.45, 0, 0.45, 0.45]);
  put(xe - 0.03, 0, -2.4, EAST, (c) => tyreStack(c, [[0, 0], [-0.02, 0.02], [0.015, 0.0]]), [-TYRE.r, 0, TYRE.r, 2 * TYRE.r + 0.06]);
  put(ROOM.x1 - PIER.d, 0.92, 4.5, EAST, extinguisher);
  const lamp = put(ROOM.x1, 2.34, (SIDE_DOOR.z0 + SIDE_DOOR.z1) / 2, EAST, (c) => bulkhead(c, RADIANCE.diffuser * 1.6));
  const lampAt = lamp.at(lamp.out);
  lights.push({ kind: 'point', group: 'bulkhead', position: lampAt, color: WARM.map((v) => v * 1.4), range: 3.5, sourceRadius: 0.06 });
  glows.push({ position: lampAt, size: 0.6, color: WARM.map((v) => v * 1.2) });
  put(ROOM.x1, 1.25, 6.85, EAST, (c) => switchboard(c, ROOM.truss + 0.3 - 1.25));

  // the corner by the street: a broom against the east wall, clear of the low lines on the street wall
  put(xe, 0, 8.3, EAST, broom);
  return { footprints, lights, glows };
}

/** Round a polyline's corners by cutting each twice (Chaikin), keeping its ends. */
function smooth(pts, passes = 2) {
  let p = pts;
  for (let n = 0; n < passes; n++) {
    const q = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i], b = p[i + 1];
      if (i > 0) q.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2] * 0.75 + b[2] * 0.25]);
      if (i < p.length - 2) q.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, a[2] * 0.25 + b[2] * 0.75]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  return p;
}
