// The garage: the room the player chooses a car in. buildGarage() returns the whole set as plain data in its own
// frame (plan.js): meshes by part, every neon tube as a centreline, the lights, and the anchors the runtime, the
// camera and the reflections work from. Nothing here knows where the set stands in the world; it is only ever
// translated, and lightRecords() / glowRecords() take that translation.

import { CHANNEL, LIGHT_STRIDE, GLOW_STRIDE } from '../../core/ids.js';
import { SetKit } from './setkit.js';
import { buildFloor, buildShell, buildCurtain, CURTAIN_Z } from './shell.js';
import { buildRing, buildDisc, buildLightBox, STRIP } from './stage.js';
import { buildSign, SIGN_LIGHT } from './sign.js';
import { buildRuns, LOW_RUN } from './runs.js';
import { buildDressing } from './dressing.js';
import { ROOM, TURNTABLE, SWEPT, DOOR, CAMERA, GLASS_BLOCK, RADIANCE, GAS } from './plan.js';

/** Light of a tube per metre of glass (colour x this), in the units of the renderer's tube record. */
const TUBE_LIGHT = 0.32;
/** How far a tube's light reaches from the glass, metres: each lights a pool and the far corners stay black. */
const REACH = Object.freeze({ run: 4.2, low: 3.2, sign: 5 });
const srgbToLinear = (c) => c.map((v) => Math.pow(v, 2.2));

/**
 * One light for a group of tubes that lie more or less along a line: a tube record on the group's long axis through
 * its centre of light, carrying all of the group's light. A group that is a picture or a pair of lines rather than
 * one run gives `line` = [from, to, y, radius]: the ends of the line along the long axis (the group's own extent
 * if left out), its height, and the radius of the source, about half the group's height.
 */
function groupLight(tubes, group, range, line = null) {
  const list = tubes.filter((t) => t.group === group);
  if (!list.length) return null;
  const sum = [0, 0, 0], centre = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let total = 0;
  for (const t of list) {
    for (let k = 0; k < 3; k++) sum[k] += t.color[k] * t.length;
    total += t.length;
    for (let i = 1; i < t.points.length; i++) {
      const a = t.points[i - 1], b = t.points[i], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      for (let k = 0; k < 3; k++) { centre[k] += (a[k] + b[k]) / 2 * l; lo[k] = Math.min(lo[k], a[k], b[k]); hi[k] = Math.max(hi[k], a[k], b[k]); }
    }
  }
  for (let k = 0; k < 3; k++) centre[k] /= total;
  const axis = hi[0] - lo[0] > hi[2] - lo[2] ? 0 : 2, a = centre.slice(), b = centre.slice();
  a[axis] = line?.[0] ?? lo[axis]; b[axis] = line?.[1] ?? hi[axis];
  if (line) a[1] = b[1] = line[2];
  return { kind: 'tube', group, a, b, color: sum.map((v) => v * TUBE_LIGHT / (b[axis] - a[axis])), range, radius: line ? line[3] : list[0].radius };
}

/**
 * Build the set.
 *   detail  0 | 1 | 2: tessellation of round things and whether small edges are bevelled (Low 0, Medium 1, High and
 *           Ultra 2). Anchors, tubes and lights do not depend on it.
 */
export function buildGarage({ detail = 2 } = {}) {
  const kit = () => new SetKit(detail, 86);
  const tubes = [];
  const shell = buildShell(kit());
  const neon = kit(); buildRuns(neon, tubes); buildSign(neon, tubes);
  const ring = buildRing(kit(), tubes);
  const dressing = kit(), dressed = buildDressing(dressing);
  const floor = buildFloor(kit(), dressed.footprints);
  const boxFrame = kit(), diffuser = kit(), lit = buildLightBox(boxFrame, boxFrame, diffuser);
  shell.add(ring); shell.add(boxFrame);

  const diffuserLinear = srgbToLinear([0.88, 0.94, 1.0]).map((v) => v * RADIANCE.diffuser);
  // In order of what the room loses least by going without: the wall runs and the low lines that the car carries,
  // the sign, the bench lamp, the turntable strip, then the ceiling edges, the street wall and the small things.
  const order = ['side-magenta', 'side-cyan', 'low-magenta', 'low-cyan', 'sign-sun', 'sign-script', 'sign-palm', 'bench-lamp', 'turntable-strip',
    'ceiling-magenta', 'ceiling-cyan', 'front-magenta', 'front-cyan', 'bulkhead', 'door', 'glass-block'];
  // a pair of low lines is one light, on the upper line: that is the one with pale wall round it to show a pool,
  // the lower runs on the dark dado
  const lowLine = [undefined, undefined, LOW_RUN.y[1], 0.008];
  const lights = [
    groupLight(tubes, 'side-magenta', REACH.run), groupLight(tubes, 'side-cyan', REACH.run),
    groupLight(tubes, 'low-magenta', REACH.low, lowLine), groupLight(tubes, 'low-cyan', REACH.low, lowLine),
    groupLight(tubes, 'ceiling-magenta', REACH.run), groupLight(tubes, 'ceiling-cyan', REACH.run),
    groupLight(tubes, 'front-magenta', REACH.low, lowLine), groupLight(tubes, 'front-cyan', REACH.low, lowLine),
    groupLight(tubes, 'sign-sun', REACH.sign, SIGN_LIGHT['sign-sun']), groupLight(tubes, 'sign-script', REACH.sign, SIGN_LIGHT['sign-script']), groupLight(tubes, 'sign-palm', REACH.sign, SIGN_LIGHT['sign-palm']),
    ...dressed.lights,
  ];
  // the strip in the turntable ring: six chords of its circle
  for (let i = 0; i < 6; i++) {
    const a0 = i / 6 * Math.PI * 2, a1 = (i + 1) / 6 * Math.PI * 2, r = STRIP.radius;
    lights.push({ kind: 'tube', group: 'turntable-strip', a: [Math.sin(a0) * r, STRIP.y + 0.02, Math.cos(a0) * r], b: [Math.sin(a1) * r, STRIP.y + 0.02, Math.cos(a1) * r], color: GAS.warm.light.map((v) => v * 1.2), range: 2, radius: 0.008 });
  }
  // the dusk through the roller door at its full-open strength (the runtime scales the group with the opening), and
  // the glow of the glass block panel
  lights.push({ kind: 'tube', group: 'door', a: [DOOR.x0 + 0.2, 0.3, ROOM.z1 + 0.05], b: [DOOR.x1 - 0.2, 0.3, ROOM.z1 + 0.05], color: [2.2, 0.75, 0.3], range: 8, radius: 0.1 });
  lights.push({ kind: 'tube', group: 'glass-block', a: [ROOM.x1 - 0.05, (GLASS_BLOCK.y0 + GLASS_BLOCK.y1) / 2, GLASS_BLOCK.z0 + 0.2], b: [ROOM.x1 - 0.05, (GLASS_BLOCK.y0 + GLASS_BLOCK.y1) / 2, GLASS_BLOCK.z1 - 0.2], color: [0.8, 0.3, 0.42], range: 6, radius: 0.1 });
  const ranked = lights.filter(Boolean).sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)).map((l, i) => ({ ...l, priority: i }));

  const inner = { min: [ROOM.x0, 0, ROOM.z0], max: [ROOM.x1, ROOM.truss, ROOM.z1] };
  return {
    detail,
    meshes: {
      floor: floor.finish(), shell: shell.finish(), dressing: dressing.finish(), neon: neon.finish(),
      lightbox: diffuser.finish(), turntable: buildDisc(kit()).finish(), door: buildCurtain(kit()).finish(),
    },
    tubes: tubes.map((t) => ({ id: t.id, group: t.group, color: t.color, radiance: t.radiance, radius: t.radius, points: t.points })),
    lights: ranked,
    glows: dressed.glows,
    anchors: {
      car: { position: [0, TURNTABLE.matTop, 0], yaw: Math.PI / 2 },
      turntable: { centre: [0, 0, 0], radius: TURNTABLE.disc, axis: [0, 1, 0], top: TURNTABLE.matTop },
      door: { opening: { min: [DOOR.x0, 0, CURTAIN_Z], max: [DOOR.x1, DOOR.top, CURTAIN_Z] }, travel: DOOR.travel, axis: [0, 1, 0], closedGain: 0.08 },
      camera: {
        min: CAMERA.min.slice(), max: CAMERA.max.slice(),
        orbit: { centre: [0, 0.6, 0], minRadius: 5.0, maxRadius: 7.0, minHeight: 0.3, maxHeight: 2.4, yaw: { centre: 0, halfRange: 1.9 } },
        home: { yaw: 0.6, height: 0.75, radius: 6.5 },
      },
      lightBox: { centre: lit.centre, u: lit.u, v: lit.v, normal: [0, -1, 0], radiance: diffuserLinear },
      room: inner, probe: { ...inner, position: [0, 1.1, 0] },
      floor: { y: 0, min: [ROOM.x0, ROOM.z0], max: [ROOM.x1, ROOM.z1] },
      swept: { radius: SWEPT.radius, height: SWEPT.height },
      look: { ambient: [0.02, 0.017, 0.026], haze: 0.22, tubeRadiance: RADIANCE.tube, diffuserRadiance: RADIANCE.diffuser },
    },
  };
}

/**
 * The set's lights as renderer records, the most important first, at most `maxLights` of them, for a set standing
 * at `origin`. Returns { records, groups }: groups[i] names the group of record i, for scaling a group at run time
 * (the group 'door' is given at its full-open strength; shut, the runtime shows anchors.door.closedGain of it).
 */
export function lightRecords(set, maxLights = 32, origin = [0, 0, 0]) {
  // a group is lit whole or not at all (half a ring of the turntable strip would be worse than none), so a group
  // that does not fit the budget gives its place to the ones after it
  const size = new Map(), list = [];
  for (const l of set.lights) size.set(l.group, (size.get(l.group) || 0) + 1);
  for (let i = 0; i < set.lights.length;) {
    const n = size.get(set.lights[i].group);
    if (list.length + n <= maxLights) list.push(...set.lights.slice(i, i + n));
    i += n;
  }
  const records = new Float32Array(list.length * LIGHT_STRIDE), groups = [];
  list.forEach((l, i) => {
    const o = i * LIGHT_STRIDE, p = l.kind === 'tube' ? [(l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, (l.a[2] + l.b[2]) / 2] : l.position;
    records[o] = p[0] + origin[0]; records[o + 1] = p[1] + origin[1]; records[o + 2] = p[2] + origin[2];
    records[o + 3] = l.range; records[o + 4] = l.color[0]; records[o + 5] = l.color[1]; records[o + 6] = l.color[2];
    if (l.kind === 'tube') {
      const d = [l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]], length = Math.hypot(d[0], d[1], d[2]);
      records[o + 7] = 3; records[o + 8] = d[0] / length; records[o + 9] = d[1] / length; records[o + 10] = d[2] / length; records[o + 11] = length / 2;
      records[o + 15] = l.radius;
    } else {
      records[o + 7] = l.kind === 'spot' ? 1 : 0;
      const ax = l.axis || [0, -1, 0];
      records[o + 8] = ax[0]; records[o + 9] = ax[1]; records[o + 10] = ax[2];
      records[o + 11] = Math.cos((l.outerDeg ?? 180) * Math.PI / 360); records[o + 12] = Math.cos((l.innerDeg ?? 180) * Math.PI / 360);
      records[o + 15] = l.sourceRadius ?? 0.03;
    }
    records[o + 13] = CHANNEL.ALWAYS; records[o + 14] = (i * 0.37) % 1;
    groups.push(l.group);
  });
  return { records, groups };
}

/** The set's glow sprites (the small lamps' halos) as renderer records for a set standing at `origin`. */
export function glowRecords(set, origin = [0, 0, 0]) {
  const records = new Float32Array(set.glows.length * GLOW_STRIDE);
  set.glows.forEach((g, i) => {
    const o = i * GLOW_STRIDE;
    records[o] = g.position[0] + origin[0]; records[o + 1] = g.position[1] + origin[1]; records[o + 2] = g.position[2] + origin[2];
    records[o + 3] = g.size; records[o + 4] = g.color[0]; records[o + 5] = g.color[1]; records[o + 6] = g.color[2]; records[o + 7] = CHANNEL.ALWAYS;
  });
  return records;
}
