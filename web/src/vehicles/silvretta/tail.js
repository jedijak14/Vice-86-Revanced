// The tail below the engine lid: the lamp band (lamp units round the corners, the reflector between them), the
// impact bumper with its rubber strips, guards and bellows, and the valance. Swept like the nose (sweeps.js).

import { polygon, roundedBox, frame, region, ringLoft, roundRect } from '../hero/kit/solids.js';
import { VEHICLE } from '../../core/ids.js';
import * as S from './spec.js';
import { planCurve, arcOY, sectionWriter, sweepSection, facingPolygon } from './sweeps.js';
import { fasciaStyles, buildBellows, buildCore, RUBBER, UPSTAND } from './fascia.js';

const lerp = (a, b, t) => a + (b - a) * t, smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };

/**
 * Build the left half of the tail. glass: GLASS builder or null for the reduced model.
 * Returns the anchors { tail, reverse, indicator: { pos, extent }, marker, plateLamp: { pos, dir }, plate } in vehicle metres.
 */
export function buildTail(mb, glass, quality) {
  const T = S.TAIL, B = T.band, V = T.valance, fine = quality.hems !== false, styles = fasciaStyles(mb), spacing = quality.fascia, turn = fine ? 5 : 18;

  // lamp band
  const band = planCurve(B.line, -1), sLamp = band.sAtZ(B.lampZ), sRev = B.reverseZ.map((z) => band.sAtZ(z)), sCorner = [band.sAtZ(540), band.length];
  const [y0, y1] = B.y;
  sweepSection(mb, band.stations(spacing, turn, [sLamp - 5, sLamp, sRev[0], sRev[1]], 0, band.length), (st) => {
    const lean = B.lean * smooth((st.s - sCorner[0]) / (sCorner[1] - sCorner[0])), add = sectionWriter();
    const kind = st.s < sLamp - 5 ? 'reflex' : st.s < sLamp ? 'black' : st.s < sRev[0] ? 'red' : st.s < sRev[1] ? 'clear' : 'amber';
    add([[-45, y1 + 3], [-3, y1 + 3]], 'black'); add([[0, y1], [0, y1 - 5]], 'black', kind);
    add([[lean * 0.3, lerp(y1, y0, 0.33)], [lean * 0.65, lerp(y1, y0, 0.66)]], kind); add([[lean, y0 + 5]], 'black'); add([[lean, y0], [-45, y0 - 2]], 'black');
    return add.nodes;
  }, styles, { side: -1, capStyle: styles.black });

  // bumper bar
  const line = planCurve(T.line, -1), sEnd = line.atX(T.endX).s, sBellows = line.atX(T.bellowsX).s, sStrip = line.sAtZ(T.strip.z0), cornerS = [line.sAtZ(520), line.atX(4100).s];
  const frontness = (s) => 1 - smooth((s - cornerS[0]) / (cornerS[1] - cornerS[0]));
  sweepSection(mb, line.stations(spacing, turn, [sStrip], 0, sEnd), (st) => {
    const k = frontness(st.s), back = lerp(-70, -110, k), add = sectionWriter(), strip = st.s > sStrip, proud = strip ? T.strip.proud : 0, kind = strip ? 'rubber' : 'paint';
    const [s0, s1] = T.strip.y, r = T.radius, rl = T.lowRadius;
    add([[back, T.top + UPSTAND]], 'black'); add([[back, T.top + 2], [-r - 12, T.top - 2]], 'paint');
    add(arcOY(-r, T.faceTop, r, 78, 0, fine ? 5 : 2), 'paint');
    add([[0, s1 + 2]], 'paint', kind); add([[proud, s1 - 1], [proud, s0 + 1]], kind); add([[0, s0 - 2]], 'paint');
    add(arcOY(-rl, T.bottom + rl, rl, 0, -90, fine ? 4 : 2), 'paint'); add([[back, T.bottom]], 'paint');
    return add.nodes;
  }, styles, { side: -1 });
  buildBellows(mb, line, sEnd + 2, sBellows - 2, { top: T.top - 2, bottom: T.bottom, pitch: T.bellowsPitch, depth: T.bellowsDepth, side: -1, fine });

  // valance
  const grid = sweepSection(mb, line.stations(spacing, turn, [], 0, sBellows), (st) => {
    const rec = lerp(V.sideRecess, V.recess, frontness(st.s)), add = sectionWriter();
    add([[-rec, T.bottom + 3], [-rec, lerp(T.bottom, V.lipY, 0.5)], [-rec, V.lipY + 10]], 'paint');
    add(arcOY(-rec - 8, V.lipY + 8, 8, 0, -90, 3), 'paint', 'under'); add([[-rec - 70, V.lipY + 1]], 'under');
    return add.nodes;
  }, styles, { side: -1 });
  const edge = grid.map((row) => row[row.length - 1]), y = (V.lipY + 1) * S.MM, last = edge[edge.length - 1];
  styles.under();
  facingPolygon(mb, [...edge, [last[0] - 0.05, y, last[2] + 0.03], [0, y, last[2] + 0.03], [0, y, edge[0][2]]].map((p) => [p[0], y, p[2]]), [0, -1, 0]);

  buildCore(mb, line, sBellows, { o: -(V.recess + 40), top: T.top - 6, bottom: V.lipY + 1, side: -1, spacing: spacing * 2, turn: turn * 2 });

  // guard: a rubber block standing on the bumper's face beside the plate
  const G = T.guard, gz = (G.z[0] + G.z[1]) / 2, st = line.atS(line.sAtZ(gz)), gy = (G.y[0] + G.y[1]) / 2, depth = G.proud + 30, o = G.proud - depth / 2;
  styles.rubber(); mb.color(RUBBER);
  roundedBox(mb, frame(S.toCar(st.q[0] + st.n[0] * o, gy, st.q[1] + st.n[1] * o), [-st.n[1], 0, -st.n[0]], [0, 1, 0]), [(G.z[1] - G.z[0]) * S.MM, (G.y[1] - G.y[0]) * S.MM, depth * S.MM], 0.014, fine ? 3 : 1);

  const at = (s, o2 = 4) => { const q = band.atS(s); return S.toCar(q.q[0] + q.n[0] * o2, (y0 + y1) / 2, q.q[1] + q.n[1] * o2); };
  const h = (y1 - y0) * S.MM;
  return {
    tail: { pos: at((sLamp + sRev[0]) / 2), extent: [(sRev[0] - sLamp) * S.MM, h] },
    reverse: { pos: at((sRev[0] + sRev[1]) / 2), extent: [(sRev[1] - sRev[0]) * S.MM, h] },
    indicator: { pos: at((sRev[1] + band.length) / 2), extent: [(band.length - sRev[1]) * S.MM, h] },
    marker: at(band.length - 25),
    // the plate lamp shines across the plate from the inner face of the rubber guard
    plateLamp: { pos: S.toCar(st.q[0] + st.n[0] * (G.proud - 8), gy, G.z[0] - 2), dir: [-1, 0, 0] },
    plate: S.toCar(T.line[0][0] + 2, gy, 0),
  };
}

/** The rear number plate, built once on the middle of the bumper: a pressed plate in a black frame. Returns its centre. */
export function buildPlate(mb) {
  const P = S.TAIL.plate, x = S.TAIL.line[0][0] + P.proud, plane = (u, v, w = 0) => S.toCar(x + w, P.y + v, -u), w = P.width / 2, h = P.height / 2, f = P.frame;
  const outer = roundRect(-w - f, -h - f, w + f, h + f, 9, 3), inner = roundRect(-w, -h, w, h, 6, 3);
  mb.material(VEHICLE.TRIM_BLACK, 100, 0); mb.color(0.035, 0.035, 0.037); mb.occlusion(1);
  ringLoft(mb, plane, outer, [[0, -P.proud - 12], [0, 5], [-2, 7]]);
  region(mb, plane, outer.map(([u, v]) => [u - Math.sign(u) * 2, v - Math.sign(v) * 2]), [inner], { w: 7 });
  mb.material(VEHICLE.PLATE, 1, 37); mb.color(0.93, 0.92, 0.86); mb.occlusion(1);
  region(mb, plane, inner, [], { w: 6, uv: (q) => [(q[0] + w) / P.width, (q[1] + h) / P.height] });
  return plane(0, 0, 6);
}
