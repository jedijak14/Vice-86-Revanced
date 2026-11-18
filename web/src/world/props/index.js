// Street, beach, dock and airport prototypes (design/ARCHITECTURE.md section 9.3), the ironwork set into roads and
// the roadside pylon signs of motels, diners and garages.
//
// Each prototype is described once by a definition { name, build(k), far, footprint, collider, tags, nearTess?, ... } and
// built once per level of detail: `far` lists the distance at which each level hands over to the next, so its
// length is the number of levels. Lights, glows, signal lenses and wire anchors come from the nearest level,
// so they are identical whatever level is drawn.
//
// Conventions shared by every prototype (the planner relies on them):
//   metres, +Y up, standing on y = 0, front = +Z (kerbside props are yawed so +Z points at the carriageway);
//   lamp arms reach +Z; linear segments run along X, centred on the origin, and export `length`;
//   `footprint` is the clear radius an instance needs; `height` is the top of the mesh.

import { Kit } from './kit.js';
import { seedOf } from './common.js';
import { LAMPS } from './lamps.js';
import { SIGNALS } from './signals.js';
import { SIGNS } from './signs.js';
import { FURNITURE } from './furniture.js';
import { BILLBOARDS } from './billboards.js';
import { UTILITY } from './utility.js';
import { BEACH } from './beach.js';
import { DOCKS } from './docks.js';
import { ROADKIT } from './roadkit.js';
import { PYLONS } from './pylons.js';

const DEFINITIONS = [...LAMPS, ...SIGNALS, ...SIGNS, ...FURNITURE, ...BILLBOARDS, ...UTILITY, ...BEACH, ...DOCKS, ...ROADKIT, ...PYLONS];
const VEHICLE_COLOURS = new Set(['red', 'amber', 'green']);

function buildOne(def, detail) {
  const seed = seedOf(def.name), lods = [];
  let first = null, near = 0;
  def.far.forEach((far, lod) => {
    const k = new Kit(lod, detail, seed, def.nearTess);
    def.build(k);
    if (!first) first = k;
    lods.push({ mesh: k.finish(), near, far });
    near = far;
  });
  const top = lods[0].mesh.bounds[4];
  const proto = {
    name: def.name, lods, lights: first.lightRecords(), glows: first.glowRecords(),
    collider: def.collider || null, footprint: def.footprint, height: Math.round(top * 100) / 100, tags: def.tags.slice(),
  };
  if (def.length) proto.length = def.length;
  if (first.lenses.length) {
    // vehicle lenses and pedestrian lenses share one record shape; the junction logic drives them separately
    // rounded to a tenth of a millimetre, so rotations by a quarter turn do not leave 1e-17 where 0 is meant
    const tidy = (v) => v.map((x) => Math.round(x * 1e4) / 1e4 + 0);
    const record = (l) => ({ pos: tidy(l.pos), colour: l.color, color: l.color, facing: tidy(l.facing), diameter: l.diameter, approach: l.approach });
    proto.signalLenses = first.lenses.filter((l) => VEHICLE_COLOURS.has(l.color)).map(record);
    proto.pedLenses = first.lenses.filter((l) => !VEHICLE_COLOURS.has(l.color)).map(record);
  }
  if (first.anchors.length) proto.anchors = first.anchors.map((a) => ({ kind: a.kind, pos: a.pos.slice() }));
  if (def.extra) Object.assign(proto, def.extra);
  return proto;
}

/** Names of every prototype this module builds, in catalogue order. */
export const PROP_NAMES = DEFINITIONS.map((d) => d.name);

/**
 * Build every street, beach, dock and airport prototype.
 * detail: 0 low, 1 medium, 2 high (scales curve tessellation; the set of prototypes and their records do not change).
 */
export function buildPrototypes(detail = 2) {
  return DEFINITIONS.map((def) => buildOne(def, detail));
}
