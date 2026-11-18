// The nose below the bonnet's edge: the impact bumper with its rubber strip and the indicators round its corners, the
// bellows between its ends and the wings, the valance with the fog lamps and the rubber chin spoiler under it.
// Sections are swept along one plan line (sweeps.js), from the centre line round the corner to the wing's foot.

import { VEHICLE } from '../../core/ids.js';
import { polygon } from '../hero/kit/solids.js';
import { OPTICS, LENS, CIRCUIT, lensFace, loopBowl, bulb, trim, bowlTint, subFrame } from '../hero/lamps/optics.js';
import { roundRect } from '../hero/kit/solids.js';
import * as S from './spec.js';
import { planCurve, arcOY, sectionWriter, sweepSection, facingPolygon } from './sweeps.js';

const lerp = (a, b, t) => a + (b - a) * t, smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
/** Behind the body's lower edge the top of a bumper and of its bellows turns up, mm: nothing is seen through the joint from below. */
export const UPSTAND = 26;
export const RUBBER = [0.2, 0.2, 0.21], SHADOW = [0.05, 0.05, 0.055];

/** Builder states shared by the bumpers, lightest first (see sweepSection). */
export const fasciaStyles = (mb) => ({
  paint: () => { mb.material(VEHICLE.PAINT, 0, 0); mb.color(1, 1, 1); mb.occlusion(1); },
  amber: () => { mb.material(VEHICLE.LAMP_INDICATOR_L, OPTICS.FLUTES, 0); mb.color(LENS.amber.colour); mb.occlusion(1); },
  red: () => { mb.material(VEHICLE.LAMP_BRAKE, OPTICS.FLUTES, 1); mb.color(LENS.red.colour); mb.occlusion(1); },
  clear: () => { mb.material(VEHICLE.LAMP_REVERSE, OPTICS.FLUTES, 0); mb.color(LENS.clear.colour); mb.occlusion(1); },
  reflex: () => { mb.material(VEHICLE.LAMP_MARKER, OPTICS.REFLEX, 0); mb.color(LENS.red.colour); mb.occlusion(1); },
  under: () => { mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.6); },
  rubber: () => { mb.material(VEHICLE.TRIM_BLACK, 185, 0); mb.color(RUBBER); mb.occlusion(0.9); },
  black: () => { mb.material(VEHICLE.TRIM_BLACK, 190, 0); mb.color(SHADOW); mb.occlusion(0.4); },
});

/**
 * Rubber bellows along a plan line between two distances: folds square to the line, the height of the bumper.
 * fine: model the folds (otherwise one flat band).
 */
export function buildBellows(mb, line, s0, s1, { top, bottom, pitch, depth, side, fine, back = -60 }) {
  const folds = Math.max(2, Math.round(Math.abs(s1 - s0) / pitch)), stations = [];
  if (fine) for (let i = 0; i <= folds * 2; i++) stations.push({ ...line.atS(lerp(s0, s1, i / (folds * 2))), fold: i % 2 });
  else stations.push({ ...line.atS(s0), fold: 0.5 }, { ...line.atS(s1), fold: 0.5 });
  const styles = fasciaStyles(mb);
  sweepSection(mb, stations, (st) => {
    const o = -depth - 2 + st.fold * depth, add = sectionWriter();
    add([[back, top + UPSTAND], [back, top], [o - 5, top]], 'rubber'); add(arcOY(o - 5, top - 5, 5, 90, 0, 2), 'rubber'); add(arcOY(o - 5, bottom + 5, 5, 0, -90, 2), 'rubber'); add([[back, bottom]], 'rubber');
    return add.nodes;
  }, { rubber: styles.rubber }, { side, caps: ['start', 'end'], crease: fine ? 25 : 40 });
}

/**
 * The core of a nose or tail: a dark wall inside the bumper and the valance, a lid under the bumper's top and a
 * bulkhead where the line ends at the body. The parts round it are separate skins with joints between them; through
 * any of those joints one now looks at shadow instead of at the far side of the car from behind.
 */
export function buildCore(mb, line, sEnd, { o, top, bottom, side, spacing, turn }) {
  const styles = fasciaStyles(mb);
  const wall = sweepSection(mb, line.stations(spacing, turn, [], 0, sEnd), () => [[o, top, 'black'], [o, bottom, 'black']], { black: styles.black }, { side, caps: [] });
  const rim = wall.map((row) => row[0]), last = rim[rim.length - 1], y0 = bottom * S.MM, y1 = top * S.MM;
  const lid = [...rim.slice().reverse(), [0, y1, rim[0][2]], [0, y1, last[2]]], end = [[last[0], y0, last[2]], [0, y0, last[2]], [0, y1, last[2]], [last[0], y1, last[2]]];
  facingPolygon(mb, lid, [0, 1, 0]); facingPolygon(mb, end, [0, 0, -side]);
}

/**
 * Build the left half of the nose. glass: GLASS builder or null for the reduced model.
 * Returns { indicator, marker: [x, y, z], fog: { pos, dir } } (vehicle metres) for the lamp anchors.
 */
export function buildFascia(mb, glass, quality) {
  const F = S.FRONT_BUMPER, V = F.valance, line = planCurve(F.line, 1), fine = quality.hems !== false;
  const sEnd = line.atX(F.endX).s, sBellows = line.atX(F.bellowsX).s, sInd0 = line.sAtZ(F.indicator.z0), sInd1 = line.atX(F.indicator.x1).s;
  const sFog = F.fog.z.map((z) => line.sAtZ(z)), sCorner = [line.sAtZ(470), line.atX(230).s];
  const styles = fasciaStyles(mb), spacing = quality.fascia, turn = fine ? 5 : 18;
  /** 1 across the front, 0 along the side. */
  const frontness = (s) => 1 - smooth((s - sCorner[0]) / (sCorner[1] - sCorner[0]));

  // bumper bar
  sweepSection(mb, line.stations(spacing, turn, [sInd0, sInd1], 0, sEnd), (st) => {
    const k = frontness(st.s), back = lerp(-70, -135, k), add = sectionWriter();
    const lamp = st.s > sInd0 && st.s < sInd1, strip = st.s <= sInd0, proud = lamp ? F.indicator.proud : strip ? F.strip.proud : 0, kind = lamp ? 'amber' : strip ? 'rubber' : 'paint';
    const [y0, y1] = F.strip.y, r = F.radius, rl = F.lowRadius;
    add([[back, F.top + UPSTAND]], 'black'); add([[back, F.top + 2], [-r - 14, F.top - 3]], 'paint');
    add(arcOY(-r, F.faceTop, r, 78, 0, fine ? 5 : 2), 'paint');
    add([[0, y1 + 2]], 'paint', kind); add([[proud, y1 - 1], [proud, y0 + 1]], kind); add([[0, y0 - 2]], 'paint');
    add(arcOY(-rl, F.bottom + rl, rl, 0, -90, fine ? 4 : 2), 'paint'); add([[back, F.bottom]], 'paint');
    return add.nodes;
  }, styles, { side: 1 });
  buildBellows(mb, line, sEnd + 2, sBellows - 2, { top: F.top - 2, bottom: F.bottom, pitch: F.bellowsPitch, depth: F.bellowsDepth, side: 1, fine });

  // valance and chin spoiler
  const grid = sweepSection(mb, line.stations(spacing, turn, sFog, 0, sBellows), (st) => {
    const k = frontness(st.s), rec = lerp(V.sideRecess, V.recess, k), lip = lerp(V.sideLip, V.lip, k), add = sectionWriter();
    const pocket = st.s > sFog[0] && st.s < sFog[1], depth = pocket ? F.fog.depth : 0, kind = pocket ? 'black' : 'paint';
    add([[-rec, F.bottom + 3]], 'paint');
    add([[-rec, F.fog.y[1]]], kind); add([[-rec - depth, F.fog.y[1]], [-rec - depth, F.fog.y[0]]], kind); add([[-rec, F.fog.y[0]]], 'paint');
    add([[-rec + 3, V.chinTop + 3]], 'rubber');
    add([[-rec + 4, V.chinTop - 3], [lerp(-rec + 4, lip, 0.45), lerp(V.chinTop, V.lipY, 0.5)], [lip - 1.5, V.lipY + 14]], 'rubber');
    add(arcOY(lip - 6, V.lipY + 6, 6, 20, -90, 3), 'rubber', 'under');
    add([[lip - 70, V.lipY + 2]], 'under');
    return add.nodes;
  }, styles, { side: 1 });

  // undertray: closes the nose from below, from the chin's return back under the front of the floor
  const edge = grid.map((row) => row[row.length - 1]), y = (V.lipY + 2) * S.MM, last = edge[edge.length - 1];
  styles.under();
  facingPolygon(mb, [...edge, [last[0] - 0.05, y, last[2] - 0.12], [0, y, last[2] - 0.12], [0, y, edge[0][2]]].map((p) => [p[0], y, p[2]]), [0, -1, 0]);

  buildCore(mb, line, sBellows, { o: -(V.recess + F.fog.depth + 14), top: F.top - 6, bottom: V.lipY + 2, side: 1, spacing: spacing * 2, turn: turn * 2 });

  // fog lamp: a rectangular unit standing in its pocket
  const fz = (F.fog.z[0] + F.fog.z[1]) / 2, fy = (F.fog.y[0] + F.fog.y[1]) / 2, st = line.atS(line.sAtZ(fz)), o = -V.recess - 8;
  const origin = [st.q[0] + st.n[0] * o, fy, st.q[1] + st.n[1] * o];
  const to3 = subFrame((x, yy, z) => S.toCar(x, yy, z), origin, [-st.n[1], 0, st.n[0]].map((v) => -v), [0, 1, 0]);
  const w = F.fog.z[1] - F.fog.z[0] - 10, h = F.fog.y[1] - F.fog.y[0] - 8, loop = roundRect(-w / 2, -h / 2, w / 2, h / 2, 9, 3);
  trim(mb, to3, loop, [[4, -F.fog.depth + 10], [4, 1], [2.5, 2.5], [0, 2.5], [-3, 1], [-3, -2]], { rough: 150, colour: SHADOW });
  if (glass) { loopBowl(mb, to3, loop.map((q) => [q[0] * 0.95, q[1] * 0.93]), { w: -2, depth: 20, circuit: CIRCUIT.FOG, tint: bowlTint(LENS.clear), focus: [0, 0] }); bulb(mb, to3, { w: -20, r: 5, length: 16, circuit: CIRCUIT.FOG }); }
  lensFace(mb, glass, to3, loop.map((q) => [q[0] * 0.96, q[1] * 0.94]), { w: -1, optics: OPTICS.FLUTES, circuit: CIRCUIT.FOG, lens: LENS.clear });

  const onStrip = (s) => { const q = line.atS(s); return S.toCar(q.q[0] + q.n[0] * 4, (F.strip.y[0] + F.strip.y[1]) / 2, q.q[1] + q.n[1] * 4); };
  return {
    indicator: onStrip((sInd0 + sInd1) / 2), marker: onStrip(sInd1 - 25),
    fog: { pos: to3(0, 0, 2), dir: [0, 0, 1] },
  };
}
