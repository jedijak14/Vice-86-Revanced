// The tail: the flat panel under the deck's overhang with the apertures of the lamp clusters cut into it, the slim
// bumper bar below, and under that the open recess with the mesh panel, its exhaust cut-outs and the four exhaust tips. The clusters themselves are built by
// rearlamps.js in the aperture handed to it here; the exhaust anchors are computed from the very numbers that place
// the pipes.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, lathe, frame, roundRect, ccw } from './kit/solids.js';
import { roundCorners, offset } from './kit/outline.js';
import * as S from './spec.js';
import { buildRearLamps } from './rearlamps.js';

const T = S.TAIL, MM = S.MM;
const BLACK = [0.02, 0.02, 0.022];
const END_STEPS = 8;           // sections round the turned end of the bumper bar
const LAMP_ROOM = 55;          // depth of the space behind the tail panel that a lamp cluster may fill, mm
const LIP_RETURN = 4;          // how far the rim's trailing lip turns back into the fold it has passed through, mm

/** A transverse plane at station x seen from behind: u runs to the car's right, v up, w towards the viewer. */
const rearPlane = (x) => (u, v, w = 0) => S.toCar(x + w, v, -u);
const mirrorU = (loop) => loop.map(([z, y]) => [-z, y]);

function paint(mb, occ = 1) { mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(occ); }
function black(mb, occ = 0.6, rough = 190) { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(BLACK); mb.occlusion(occ); }
function under(mb) { mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.55); }

/** The lamp housing aperture in (z, y). */
function housingLoop() {
  const H = T.housing, [z0, z1] = H.z;
  return roundCorners([[z0, H.yIn[1]], [z0, H.yIn[0] + H.chamfer], [z0 + H.chamfer, H.yIn[0]], [z1, H.yOut[0]], [z1, H.yOut[1]]], H.radius, { closed: true, segs: 3 });
}

/**
 * Left half of the tail. glass: the glass builder, or null for the reduced model.
 * Returns the anchors of the left lamps and exhausts (vehicle frame, metres).
 */
export function buildTail(mb, glass, hull) {
  const plane = rearPlane(T.planeX);

  // --- tail panel: the hull's section, set in by the rim, with the lamp housing cut out of it. The section is the
  // creases themselves joined through points of each crowned facet, so the rim keeps one width all the way round.
  const section = [], corner = [];
  for (const [name, b] of Object.entries(S.B_OF).filter(([, b]) => b <= S.B_OF.S)) {
    section.push(S.RAIL[name](T.planeX)); corner.push(T.cornerRadius);
    if (b < S.B_OF.S) for (const f of [0.3, 0.5, 0.7]) { const p = hull.pos(T.planeX, b + f, [0, 0, 0]); section.push([p[0] / MM, p[1] / MM]); corner.push(0); }
  }
  const bottomY = section[section.length - 1][1];
  section.push([0, bottomY]); corner.push(T.cornerRadius);
  // (the offset outline's first edge slopes with the deck's crown, so its first point has left the centre plane: it
  // goes back along that edge, or the two halves of the panel part in a wedge down the middle)
  const setIn = offset(section, -T.rim), [first, next] = setIn, reach = first[0] / (first[0] - next[0]);
  setIn[0] = [0, first[1] + (next[1] - first[1]) * reach];
  const inset = roundCorners(setIn, corner, { segs: 3 });
  const rimEnd = inset.findIndex((q) => q[1] < bottomY + T.rim + 1);            // where the outline turns along the bottom
  const outer = mirrorU(inset), housing = mirrorU(housingLoop()), bevel = 2;
  paint(mb, 0.85);
  region(mb, plane, outer, [ccw(offset(ccw(housing), -bevel, true))]);
  // the inside of the rim, from the panel back to the folded edge of the coachwork
  paint(mb, 0.55);
  // (it leans out at the back and passes through the fold's wall, so that no slit is left between the two; the
  // millimetre or two that comes out behind the wall turns back into it, or its unpainted side would show from
  // beside the car)
  const rimSteps = [[0, 0], [0, T.rimDepth - T.rimLean * 2], [T.rimLean, T.rimDepth]], rimLoop = outer.slice(0, rimEnd + 1);
  if (glass) rimSteps.push([T.rimLean + LIP_RETURN, T.rimDepth - LIP_RETURN]);
  const onCentre = [[0, 1], null];                                              // the rim starts on the centre line and stays on it
  ringLoft(mb, plane, rimLoop, rimSteps, { outer: true, open: true, slide: onCentre });
  // The reduced model's deck has no folded edge to cover the rim from outside, so there the rim gets an outer face too.
  if (!glass) ringLoft(mb, plane, rimLoop, [[T.rimLean + 2, 0], [T.rimLean + 2, T.rimDepth - T.rimLean * 2], [T.rimLean, T.rimDepth]], { open: true, slide: onCentre });

  // --- lamp aperture: the panel's edge rolled over into it, dark like the housing's inside; the cluster stands in the space behind
  black(mb, 0.6, 150);
  ringLoft(mb, plane, housing, [[bevel, 0], [bevel * 0.3, -bevel * 0.7], [0, -bevel]]);
  const anchors = buildRearLamps(mb, glass, { plane, loop: ccw(housing), depth: LAMP_ROOM });

  // --- bumper bar under the panel: a slim body-colour bar of closed section, full width. Its profile runs from
  // inside the rim out over the face, down, back under and up to the floor, so the open tail below it has a roof.
  const Bb = T.bar, M = S.TAIL.mesh, barTop = bottomY + T.rim, barBottom = barTop - Bb.height, faceX = T.planeX + Bb.project, backX = T.planeX - Bb.back;
  const prof = [[T.planeX - 2, barTop], ...roundCorners([[faceX, barTop], [faceX, barBottom], [backX, barBottom]], Bb.radius, { segs: 3 }), [backX, bottomY + 2]];
  // Outboard the bar does not stop at a cut face: it turns a quarter circle in plan and runs out into the tail
  // plane just inside the coachwork's side, as a bumper's wrapped end does.
  const sideZ = hull.pos(T.planeX, S.B_OF.S, [0, 0, 0])[0] / MM - 6, turnZ = sideZ - Bb.project;
  const stations = [0, M.z / 2, M.z, (M.z + turnZ) / 2].map((z) => ({ z, share: 1 }));
  for (let k = 0; k <= END_STEPS; k++) { const a = Math.PI / 2 * k / END_STEPS; stations.push({ z: turnZ + Bb.project * Math.sin(a), share: Math.cos(a) }); }
  const onBar = (px, share) => (px > T.planeX ? T.planeX + (px - T.planeX) * share : px);
  paint(mb, 0.9);
  patch(mb, stations.map(({ z, share }) => prof.map(([px, py]) => S.toCar(onBar(px, share), py, z))), { crease: 30 });
  // the end of the closed section is in view from the side under the body's corner
  polygon(mb, [[backX, barBottom], [T.planeX, barBottom], [T.planeX, bottomY + 2], [backX, bottomY + 2]].map(([px, py]) => S.toCar(px, py, sideZ)));
  // the roof of the recess, from the bar's back to the mesh panel
  black(mb, 0.4);
  patch(mb, [0, M.z].map((z) => [[backX, barBottom], [M.x - T.plateRecess.depth, barBottom]].map(([px, py]) => S.toCar(px, py, z))));

  // --- transaxle cover: the box under the tail that carries the mesh panel. Its outboard wall rises to the floor,
  // which climbs towards the tail, so nothing looks in behind the mesh from the open corner.
  under(mb);
  patch(mb, [M.boxStartX, M.x].map((px) => [0, M.z].map((z) => S.toCar(px, M.y[0], z))));
  const floorY = (px) => hull.pos(Math.min(px, T.planeX - 5), S.B_OF.S, [0, 0, 0])[1] / MM + 3, floorLine = [];
  for (let k = 0; k <= 6; k++) { const px = backX + (M.boxStartX - backX) * k / 6; floorLine.push([px, floorY(px)]); }
  polygon(mb, [[M.boxStartX, M.y[0]], [M.x, M.y[0]], [M.x, barBottom], [backX, barBottom], ...floorLine].map(([px, py]) => S.toCar(px, py, M.z)));

  // --- mesh panel with the exhaust cut-out and the plate recess in the middle (open at the top to the lip's underside)
  const meshPlane = rearPlane(M.x), C = T.cutout, cut = roundRect(-C.z[1], C.y[0], -C.z[0], C.y[1], 6, 2);
  const P = T.plate, PR = T.plateRecess, recessU = -(P.width / 2 + P.frame + PR.margin), recessV = P.bottom - P.frame - PR.margin;
  mb.material(VEHICLE.GRILLE, 2, 0); mb.color(0.067, 0.059, 0.078); mb.occlusion(0.7);
  region(mb, meshPlane, [[-M.z, M.y[0]], [0, M.y[0]], [0, recessV], [recessU, recessV], [recessU, barBottom], [-M.z, barBottom]], [cut], { uv: (q) => [q[0] * MM, q[1] * MM] });
  black(mb, 0.25);
  ringLoft(mb, meshPlane, cut, [[0, 0], [0, -C.depth]]);
  region(mb, meshPlane, cut, [], { w: -C.depth });
  black(mb, 0.35);
  ringLoft(mb, meshPlane, [[0, recessV], [recessU, recessV], [recessU, barBottom]], [[0, 0], [0, -PR.depth]], { open: true });
  region(mb, meshPlane, [[recessU, recessV], [0, recessV], [0, barBottom], [recessU, barBottom]], [], { w: -PR.depth });

  // --- exhaust tips
  const E = T.exhaust, deg = Math.PI / 180;
  const dir = [Math.sin(E.splay * deg) * Math.cos(E.down * deg), -Math.sin(E.down * deg), -Math.cos(E.splay * deg) * Math.cos(E.down * deg)];
  anchors.exhausts = [-0.5, 0.5].map((k) => {
    const root = S.toCar(M.x, E.y, E.z + k * E.pitch), exit = root.map((v, i) => v + dir[i] * E.project * MM);
    buildExhaustTip(mb, frame(exit, dir, [0, 1, 0]));
    return { pos: exit, dir };
  });
  return anchors;
}

/**
 * One exhaust tip, local +X out of the pipe, origin at the centre of the opening. A hollow tube: dark chrome outside,
 * a rolled lip, and a bore that goes from straw through blue to soot the way heat colours stainless steel.
 */
function buildExhaustTip(mb, m) {
  const E = T.exhaust, R = E.diameter / 2 * MM, Ri = R - E.wall * MM, len = (E.project + T.cutout.depth - 15) * MM;
  // the rolled lip: a bead round the mouth, thicker than the wall, standing BEAD_OUT proud of the tube inside and out
  const BEAD_OUT = 0.003, b = (R - Ri) / 2 + BEAD_OUT, c = (R + Ri) / 2, bead = [];
  for (let k = 0; k <= 8; k++) { const a = (150 - 300 * k / 8) * Math.PI / 180; bead.push([-b + b * Math.cos(a), c + b * Math.sin(a)]); }
  const bore = [0.012, 0.03, 0.06, 0.10, 0.16].map((d) => [-d, Ri]);
  const profile = [[-len, R], [-2 * b, R], ...bead, ...bore, [-len + 0.01, Ri], [-len + 0.01, 0]];
  const heat = [[0.42, 0.33, 0.20], [0.30, 0.22, 0.26], [0.13, 0.15, 0.30], [0.07, 0.08, 0.13], [0.025, 0.025, 0.03], [0.012, 0.012, 0.014], [0.008, 0.008, 0.008]];
  const chromeRings = 2 + bead.length - 1;                                        // tube, step to the bead, the bead itself
  lathe(mb, m, profile, {
    segs: 28,
    style: (i) => {
      if (i < chromeRings) { mb.material(VEHICLE.CHROME, 55, 0); mb.color(0.5, 0.5, 0.51); mb.occlusion(1); return; }
      const k = Math.min(heat.length - 1, i - chromeRings);
      mb.material(VEHICLE.CHROME, 150, 0); mb.color(heat[k]); mb.occlusion(Math.max(0.2, 1 - k * 0.15));
    },
  });
}
