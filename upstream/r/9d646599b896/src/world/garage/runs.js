// The long neon runs. Each side wall carries a double line high up in every bay between the piers and, where the
// wall is clear of benches and shelving, a line at shoulder height and one at knee height: a car's flank is a mirror
// that sees little above two metres, and these are what it carries as it turns. The same two low lines run on the
// street wall either side of the roller door, behind the camera. A single line hangs under a steel raceway along
// each ceiling edge. Magenta on the west side, cyan on the east.

import { tube, run, transformer, cable, frame } from './neon.js';
import { ROOM, GAS, GLASS_BLOCK, SIDE_DOOR, DOOR, COLOR } from './plan.js';
import { TRUSS_Z, PIER } from './shell.js';

export const SIDE_RUN = Object.freeze({ y: [2.56, 2.68], inset: 0.16 });
/** The low lines: knee and shoulder of a car, and the stretch of each side wall that is kept clear for them. */
export const LOW_RUN = Object.freeze({ y: [0.72, 1.62], inset: 0.1, from: -1.5 });
export const CEILING_RUN = Object.freeze({ x: 5.75, y: ROOM.truss - 0.05, z0: ROOM.z0 + 0.5, z1: ROOM.z1 - 0.5 });
/** The low lines on the street wall, in x: clear of the door's guides on one side and its hand chain on the other. */
const FRONT = Object.freeze({ magenta: [ROOM.x0 + 0.25, DOOR.x0 - 0.55], cyan: [DOOR.x1 + 0.85, ROOM.x1 - 0.25] });

/** Bays of a side wall between piers: [z0, z1] of clear wall. */
const bays = () => TRUSS_Z.slice(1).map((z, i) => [TRUSS_Z[i] + PIER.w / 2, z - PIER.w / 2]);
const world = (f, x, y, off) => [f.origin[0] + f.right[0] * x + f.normal[0] * off, y, f.origin[2] + f.right[2] * x + f.normal[2] * off];
const ZINC = [0.6, 0.61, 0.62];

/**
 * The electrics of a set of lines: a transformer at `at` in frame `ft`, a lead from the bushing on its `end` (+1 or
 * -1 along the frame) to each of the `near` legs, a link joining each pair of `far` legs, and a conduit from the
 * case up to the roof steel, strapped to the wall.
 */
function feed(k, ft, at, end, near, far, w = 0.3) {
  const entry = transformer(k, ft, at, 1, w), N = ft.normal, lift = (p) => [p[0] + N[0] * 0.012, p[1], p[2] + N[2] * 0.012];
  for (const leg of near) cable(k, world(ft, at[0] + end * (w / 2 + 0.05), at[1] + 0.04, 0.07), lift(leg), 0.0045, 0.05, undefined, 6);
  for (const [p, q] of far) cable(k, lift(p), lift(q), 0.0045, 0.03, undefined, 4);
  k.bare(2, 0.5, ZINC);
  k.cyl(entry, [entry[0], ROOM.truss + 0.3, entry[2]], 0.01, 0.01, 6);
  for (const cy of [entry[1] + 0.5, 3.6, 4.3]) if (cy < 4.4 && cy > entry[1] + 0.2) k.bar([entry[0] - N[0] * 0.09, cy, entry[2] - N[2] * 0.09], [entry[0] + N[0] * 0.012, cy, entry[2] + N[2] * 0.012], 0.044, 0.016, { up: [0, 1, 0], r: 0 });
}

export function buildRuns(k, log) {
  for (const side of [-1, 1]) {
    const gas = side < 0 ? GAS.magenta : GAS.cyan, name = side < 0 ? 'magenta' : 'cyan';
    // wall frame: x runs along the wall (z), y up, facing into the room; the piers' faces stand proud of it
    const R = [0, 0, side], f = frame([side * ROOM.x1, 0, 0], R, [0, 1, 0]), pier = frame([side * (ROOM.x1 - PIER.d), 0, 0], R, [0, 1, 0]);
    let n = 0, low = 0;
    for (const [z0, z1] of bays()) {
      const glass = side > 0 && z0 < GLASS_BLOCK.z1 && z1 > GLASS_BLOCK.z0, door = side > 0 && z0 < SIDE_DOOR.z1 && z1 > SIDE_DOOR.z0;
      const start = side < 0 ? -z1 : z0, end = side < 0 ? -z0 : z1;                // the bay in the frame's x
      if (!glass) {
        // high pair: one transformer a bay, above the pair at its start; a link joins the pair at the far end
        const a = start + SIDE_RUN.inset, b = end - SIDE_RUN.inset;
        const made = SIDE_RUN.y.map((y) => tube(k, log, f, [[a, y], [b, y]], { id: `side-${name}-${++n}`, group: `side-${name}`, gas }));
        feed(k, f, [a + 0.42, SIDE_RUN.y[1] + 0.42], -1, [made[1].ends[0], made[0].ends[0]], [[made[0].ends[1], made[1].ends[1]]]);
      }
      if (!glass && !door && z0 > LOW_RUN.from) {
        // low pair: its transformer on the pier at the bay's start, between the two lines
        const a = start + LOW_RUN.inset, b = end - LOW_RUN.inset;
        const made = LOW_RUN.y.map((y) => tube(k, log, f, [[a, y], [b, y]], { id: `low-${name}-${++low}`, group: `low-${name}`, gas }));
        feed(k, pier, [start - PIER.w / 2, 1.34], 1, [made[1].ends[0], made[0].ends[0]], [[made[0].ends[1], made[1].ends[1]]], 0.26);
      }
    }

    // street wall: the same two lines in two lengths each, fed from a transformer where the lengths meet
    const street = frame([0, 0, ROOM.z1], [-1, 0, 0], [0, 1, 0]), [x0, x1] = side < 0 ? FRONT.magenta : FRONT.cyan;
    const lengths = LOW_RUN.y.map((y, i) => run(k, log, street, [-x1, y], [-x0, y], { id: `front-${name}-${i + 1}`, group: `front-${name}`, gas }));
    feed(k, street, [-(x0 + x1) / 2 + 0.3 * 0.28, 1.32], -1, lengths.flatMap((l) => [l[0].ends[1], l[1].ends[0]]), [0, 1].map((j) => [lengths[0][j].ends[j ? 1 : 0], lengths[1][j].ends[j ? 1 : 0]]));

    // ceiling edge: a raceway under the bottom chords, the tubes on posts beneath it
    const x = side * CEILING_RUN.x, y = CEILING_RUN.y, { z0, z1 } = CEILING_RUN;
    k.steel(COLOR.steelDark, 0.5, 0.25);
    k.bar([x, y + 0.025, z0 - 0.15], [x, y + 0.025, z1 + 0.15], 0.11, 0.05, { r: 0.005 });
    const under = frame([x, y, 0], [0, 0, 1], [-1, 0, 0]);                       // facing down
    const sections = Math.ceil((z1 - z0) / 2.4);
    for (let i = 0; i < sections; i++) {
      const a = z0 + (z1 - z0) * i / sections + 0.05, b = z0 + (z1 - z0) * (i + 1) / sections - 0.05;
      tube(k, log, under, [[a, 0], [b, 0]], { id: `ceiling-${name}-${i + 1}`, group: `ceiling-${name}`, gas });
    }
  }
  return k;
}
