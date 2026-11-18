// Rear lamp cluster of the Lucera: one trapezoid housing sunk into the tail panel on each side. A dark red reflex
// surround fills the aperture; three lens blocks stand proud of it in bright frames. Outboard the amber indicator, in
// the middle the red tail and stop lamp, inboard a red tail strip over the white reversing lamp; a red reflex
// reflector sits under the middle block. Behind each lens is its own plated reflector with a bulb in it.
//
//   buildRearLamps(body, glass, mount)
//     mount = { plane(u, v, w), loop, depth } from the tail: plane maps millimetres of the tail panel (u towards the
//     car's right as seen from behind, v up, +w out of the car, w = 0 on the panel) to vehicle metres; loop is the
//     aperture's edge, counter-clockwise, at w = -2; depth is the room behind the panel.
//     glass: the glass builder, or null for the reduced model (lit faces only, no reflectors, bulbs or lens glass).
//   Returns the anchors of the left cluster: { tail, brake, reverse, indicator, reflector } each { pos, size, dir },
//   and fog: null (the car carries no rear fog lamp).

import { VEHICLE } from '../../core/ids.js';
import { roundRect, region } from './kit/solids.js';
import * as S from './spec.js';
import { MM, CIRCUIT, OPTICS, LENS, CHROME, axisOf, bowlTint, loopBowl, bulb, lensFace, reflexFace, trim } from './lamps/optics.js';

/** Heights (w, millimetres) of the cluster's layers below the tail panel. */
const SURROUND = -16, TOP = -7, FRAME = 2.5, SEAT = 3, SPLIT_RADIUS = 2.5;
const SURROUND_RED = [0.40, 0.05, 0.09], REFLEX_RED = [0.66, 0.05, 0.06], BULB_CLEAR = [1, 0.95, 0.85];

/** One lamp of a block: lens over [u0, v0, u1, v1], reflector and bulb behind it. Returns its anchor. */
function lamp(body, glass, mount, [u0, v0, u1, v1], radius, circuit, lens, bulbColour) {
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, depth = Math.min(mount.depth + TOP - SEAT - 6, (v1 - v0) * 0.55), loop = roundRect(u0, v0, u1, v1, radius, 3);
  if (glass) {
    loopBowl(body, mount.plane, loop, { w: TOP - SEAT, depth, circuit, tint: bowlTint(lens), focus: [cu, cv] });
    bulb(body, mount.plane, { u: cu, v: cv, w: TOP - SEAT - depth, r: 8, length: Math.min(26, depth * 0.8), circuit, colour: bulbColour });
  }
  lensFace(body, glass, mount.plane, loop, { w: TOP - 0.6, optics: OPTICS.PRISMS, circuit, lens, origin: [cu, cv] });
  return { pos: mount.plane(cu, cv, TOP), size: [(u1 - u0) * MM, (v1 - v0) * MM], dir: axisOf(mount.plane) };
}

/** The left rear lamp cluster (see the head of this file). */
export function buildRearLamps(body, glass, mount) {
  const g = S.TAIL.segment, R = S.TAIL.reflector, plane = mount.plane;
  const v0 = g.y - g.height / 2, v1 = g.y + g.height / 2, split = v0 + g.height * 2 / 3;
  const span = (i) => { const z = g.z0 + i * (g.width + g.gap); return [-(z + g.width), -z]; };       // u range of block i, 0 = inboard
  const blocks = [0, 1, 2].map((i) => { const [u0, u1] = span(i); return roundRect(u0, v0, u1, v1, g.radius, 3); });
  const [m0, m1] = span(1), rc = (m0 + m1) / 2, rv1 = v0 - R.drop - FRAME, rv0 = rv1 - R.height;
  const reflector = roundRect(rc - R.width / 2, rv0, rc + R.width / 2, rv1, 4, 2);
  const grown = (loop, by) => { const c = loop.reduce((a, q) => [a[0] + q[0] / loop.length, a[1] + q[1] / loop.length], [0, 0]); return loop.map((q) => [q[0] + Math.sign(q[0] - c[0]) * by, q[1] + Math.sign(q[1] - c[1]) * by]); };

  // the aperture's wall down to the surround, then the surround itself round the blocks
  trim(body, plane, mount.loop, [[0, -2], [0, SURROUND]], { rough: 90, occlusion: 0.55 });
  reflexFace(body, plane, mount.loop, { w: SURROUND, holes: [...blocks.map((b) => grown(b, FRAME)), grown(reflector, 1.5)], colour: SURROUND_RED, origin: [rc, g.y] });

  // a black back plate, so that nothing of the car's inside shows between the reflectors
  if (glass) { body.material(VEHICLE.TRIM_BLACK, 200, 0); body.color(0.02, 0.02, 0.02); body.occlusion(0.3); region(body, plane, mount.loop, [], { w: -mount.depth }); }

  // bright frames standing on the surround, one round each block, and the bar that parts the inboard block
  for (const b of blocks) trim(body, plane, b, [[FRAME, SURROUND], [FRAME, TOP - 0.8], [FRAME - 0.8, TOP], [0, TOP], [0, TOP - SEAT]], CHROME);
  const [a0, a1] = span(0), bar = 1.5;
  trim(body, plane, roundRect(a0, split - bar, a1, split + bar, 1, 1), [[0, TOP - SEAT], [0, TOP - 0.2]], CHROME);
  body.material(CHROME.id, CHROME.rough, 0); body.color(CHROME.colour); body.occlusion(1);
  body.flatQuad(plane(a0, split - bar, TOP - 0.2), plane(a1, split - bar, TOP - 0.2), plane(a1, split + bar, TOP - 0.2), plane(a0, split + bar, TOP - 0.2));

  // the lamps
  const [i0, i1] = span(2), anchors = { fog: null };
  anchors.reverse = lamp(body, glass, mount, [a0, v0, a1, split - bar], SPLIT_RADIUS, CIRCUIT.REVERSE, LENS.clear, BULB_CLEAR);
  lamp(body, glass, mount, [a0, split + bar, a1, v1], SPLIT_RADIUS, CIRCUIT.TAIL, LENS.red, LENS.red.colour);
  anchors.tail = lamp(body, glass, mount, [m0, v0, m1, v1], g.radius, CIRCUIT.STOP_TAIL, LENS.red, LENS.red.colour);
  anchors.brake = { ...anchors.tail };
  anchors.indicator = lamp(body, glass, mount, [i0, v0, i1, v1], g.radius, CIRCUIT.INDICATOR, LENS.amber, LENS.amber.colour);

  // reflex reflector in a black frame
  trim(body, plane, reflector, [[1.5, SURROUND], [1.5, SURROUND + 3], [0.5, SURROUND + 4], [0, SURROUND + 4], [0, SURROUND + 3]], { rough: 110, occlusion: 0.8 });
  reflexFace(body, plane, reflector, { w: SURROUND + 3, colour: REFLEX_RED, origin: [rc, (rv0 + rv1) / 2] });
  anchors.reflector = { pos: plane(rc, (rv0 + rv1) / 2, SURROUND + 4), size: [R.width * MM, R.height * MM], dir: axisOf(plane) };
  return anchors;
}
