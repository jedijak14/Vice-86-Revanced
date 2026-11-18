// Small parts: belt seals, door mirrors, door releases, the wiper, the emblem, the model name and the number plate.
// The first three are part of the mirrored left half; the rest sit on or across the centre line and are built once.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, box, lathe, frame, planeFrame, roundRect } from './kit/solids.js';
import * as S from './spec.js';
import { sidePoint, topPoint, onSide, DOOR_TOP_ROW } from './body.js';
import { under } from './greenhouse.js';
import { buildPlateLamps } from './lamps.js';

const MM = S.MM, toCar = S.toCar, D = S.DETAIL;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
const satin = (mb, rough = 120, occlusion = 1) => { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(0.035, 0.035, 0.037); mb.occlusion(occlusion); };
const chrome = (mb, rough = 40) => { mb.material(VEHICLE.CHROME, rough, 0); mb.color(0.86, 0.86, 0.88); mb.occlusion(1); };
/** A bar between two points: `wide` across (towards `hint`), `thick` the other way. */
function strut(mb, a, b, wide, thick, hint) {
  const d = sub(b, a), mid = a.map((v, k) => (v + b[k]) / 2);
  box(mb, frame(mid, d, hint), Math.hypot(...d), wide, thick);
}

/** Rubber seal along the base of the side glass, filling the step between the door top and the glass. */
function buildBeltSeal(mb, hull) {
  const xs = []; for (let x = S.DOOR.frontTopX - 30; x <= S.CABIN_END_X + 1; x += (S.CABIN_END_X - S.DOOR.frontTopX + 30) / 16) xs.push(x);
  satin(mb, 160, 0.7);
  patch(mb, xs.map((x) => [2.93, 3.0, 3.06, DOOR_TOP_ROW + 0.05].map((b) => { const p = hull.pos(x, b, [0, 0, 0]), n = hull.normal(x, b, [0, 0, 0]); return [p[0] - n[0] * 0.003, p[1] - n[1] * 0.003, p[2] - n[2] * 0.003]; })), { facing: [1, 1, 0], crease: 50 });
}

/**
 * Door mirror on a short stalk at the foot of the A pillar. The housing is one skin through rounded-rectangle
 * sections: a blunt nose that swells on a quarter ellipse to the full section, a straight run, then the rolled rear
 * edge, the rim and the recess the glass sits in.
 */
function buildMirror(mb, hull) {
  const M = D.mirror, foot = sidePoint(hull, M.x, M.footY, 4), zc = M.outerZ - M.width / 2, pod = toCar(M.x, M.y, zc);
  satin(mb, 110);
  strut(mb, foot, [pod[0] - 0.03, pod[1] - 0.02, pod[2]], 0.05, 0.026, [0, 0, 1]);
  // rear face of the housing seen from behind: u to the car's right, v up, w towards the viewer
  const plane = (u, v, w = 0) => toCar(M.x + M.depth / 2 + w, M.y + v, zc - u), a = M.width / 2, b = M.height / 2;
  const section = (du, dv, r) => roundRect(-a + du, -b + dv, a - du, b - dv, r, 4);
  const lift = (loop, w) => loop.map(([u, v]) => plane(u, v, w));
  const run = M.depth * (1 - M.straight), rows = [];
  for (const s of [1, 0.985, 0.94, 0.86, 0.74, 0.58, 0.38, 0.18, 0]) {
    const k = Math.sqrt(1 - s * s), ku = M.nose[0] + (1 - M.nose[0]) * k, kv = M.nose[1] + (1 - M.nose[1]) * k;
    rows.push(lift(section(a * (1 - ku), b * (1 - kv), Math.min(M.corner, 0.8 * b * kv)), -M.depth + run * (1 - s)));
  }
  const roll = 3, glassInset = M.rim + 1;
  for (const [d, w] of [[0, -roll], [roll * 0.3, -roll * 0.3], [roll, 0], [M.rim, 0], [glassInset, -M.recess]]) rows.push(lift(section(d, d, M.corner - d), w));
  patch(mb, rows, { closeJ: true, flip: true, crease: 50 });
  polygon(mb, rows[0].slice().reverse());
  mb.material(VEHICLE.CHROME, 8, 0); mb.color(0.75, 0.8, 0.85); mb.occlusion(1);
  region(mb, plane, section(glassInset, glassInset, M.corner - glassInset), [], { w: -M.recess });
}

/** A flush dark plaque on the body side at side-view point (x, y): the door release slot. */
function buildRelease(mb, hull) {
  const R = D.release, c = onSide(hull, R.x, R.y), p = hull.pos(c[0], c[1], [0, 0, 0]), n = hull.normal(c[0], c[1], [0, 0, 0]), ja = [0, 0, 0], jb = [0, 0, 0];
  hull.jac(c[0], c[1], ja, jb);
  const U = unit(sub(ja, n.map((v) => v * (ja[0] * n[0] + ja[1] * n[1] + ja[2] * n[2])))), V = cross(n, U), plane = planeFrame(p, U.map((v) => v * MM), V.map((v) => v * MM));
  const loop = roundRect(-R.width / 2, -R.height / 2, R.width / 2, R.height / 2, 5, 3);
  satin(mb, 90);
  ringLoft(mb, plane, loop, [[3, 0.2], [1.5, 1.2], [0, 1.4]]);
  region(mb, plane, loop, [], { w: 1.4 });
}

/** Mirrored small parts of the left half. */
export function buildSideDetails(mb, hull) {
  buildBeltSeal(mb, hull);
  buildMirror(mb, hull);
  buildRelease(mb, hull);
}

// ------------------------------------------------------------------------------------------------ centre-line parts

/** Point `lift` millimetres above the windscreen at plan position (x, z), z of either sign. */
function onScreen(canopy, x, z, lift) {
  const p = under(canopy, x, canopy.solve(x, 0, Math.abs(z), 0, 0.9), -lift * MM);
  return [z < 0 ? -p[0] : p[0], p[1], p[2]];
}

/** The single pantograph wiper, parked along the base of the screen and pointing to the passenger side. */
function buildWiper(mb, canopy, hull) {
  const W = D.wiper, pivot = topPoint(hull, W.pivotX, W.pivotZ, -6), tip = W.pivotZ + 90 - W.blade;
  satin(mb, 140);
  lathe(mb, frame([pivot[0], pivot[1] - 0.012, pivot[2]], [0, 1, 0], [0, 0, 1]), [[0, 0.016], [0.014, 0.016], [0.02, 0.011], [0.021, 0]], { segs: 14 });
  // blade: rubber edge on the glass under a flat carrier
  const zs = []; for (let i = 0; i <= 8; i++) zs.push(W.pivotZ + 90 + (tip - W.pivotZ - 90) * i / 8);
  for (let i = 0; i < zs.length - 1; i++) {
    strut(mb, onScreen(canopy, W.bladeX, zs[i], 5), onScreen(canopy, W.bladeX, zs[i + 1], 5), 0.004, 0.01, [0, 1, 0.4]);
    strut(mb, onScreen(canopy, W.bladeX, zs[i], 12), onScreen(canopy, W.bladeX, zs[i + 1], 12), 0.012, 0.004, [0, 1, 0.4]);
  }
  // two parallel arms from the pivot to the middle of the blade, and the yoke that joins them to it
  const mid = (zs[0] + tip) / 2;
  for (const s of [-1, 1]) {
    const a = [pivot[0], pivot[1] + 0.008, pivot[2] + s * 0.012], b = onScreen(canopy, W.bladeX - s * 14, mid + 60, 22);
    strut(mb, a, b, 0.007, 0.004, [0, 1, 0.4]);
    strut(mb, b, onScreen(canopy, W.bladeX, mid + s * 70, 13), 0.006, 0.004, [0, 1, 0.4]);
  }
}

/** Our emblem on the nose: a shield with a bright rim, black enamel, and a rising chevron over a bar. */
function buildEmblem(mb, hull) {
  const E = D.emblem, c = [E.x, 0], p = topPoint(hull, c[0], c[1], 0), q = topPoint(hull, c[0] + 20, c[1], 0), V = unit(sub(q, p)), U = [1, 0, 0];
  const plane = planeFrame(p, U.map((v) => v * MM), V.map((v) => v * MM)), w = E.width / 2, h = E.height / 2;
  const shield = [[-w, h], [-w, -h * 0.2], [-w * 0.72, -h * 0.68], [0, -h], [w * 0.72, -h * 0.68], [w, -h * 0.2], [w, h]];
  chrome(mb, 25);
  ringLoft(mb, plane, shield, [[0, 0], [0, 2.2], [-1.2, 3], [-3.2, 3], [-3.8, 2.2]], { crease: 50 });
  mb.material(VEHICLE.PAINT_FIXED, 0, 0); mb.color(0.015, 0.015, 0.018); mb.occlusion(1);
  region(mb, plane, shield, [], { w: 2.2 });
  chrome(mb, 25);
  const bar = (a, b, wide) => strut(mb, plane(a[0], a[1], 2.6), plane(b[0], b[1], 2.6), wide * MM, 0.0012, plane(0, 0, 1000).map((v, k) => v - p[k]));
  bar([-w * 0.55, -h * 0.1], [0, h * 0.5], 3.4); bar([0, h * 0.5], [w * 0.55, -h * 0.1], 3.4);
  bar([-w * 0.5, -h * 0.42], [w * 0.5, -h * 0.42], 2.6);
}

/** Capital letters as centre-line strokes on a unit-high grid: [advance, [polyline, ...]]. */
const GLYPHS = {
  L: [0.72, [[[0, 1], [0, 0], [0.56, 0]]]],
  U: [0.86, [[[0, 1], [0, 0.3], [0.1, 0.09], [0.33, 0], [0.56, 0.09], [0.66, 0.3], [0.66, 1]]]],
  C: [0.84, [[[0.66, 0.8], [0.52, 0.96], [0.32, 1], [0.11, 0.9], [0, 0.66], [0, 0.34], [0.11, 0.1], [0.32, 0], [0.52, 0.04], [0.66, 0.2]]]],
  E: [0.76, [[[0.58, 1], [0, 1], [0, 0], [0.58, 0]], [[0, 0.5], [0.46, 0.5]]]],
  R: [0.84, [[[0, 0], [0, 1], [0.4, 1], [0.57, 0.92], [0.63, 0.75], [0.57, 0.58], [0.4, 0.5], [0, 0.5]], [[0.32, 0.5], [0.66, 0]]]],
  A: [0.86, [[[0, 0], [0.33, 1], [0.66, 0]], [[0.12, 0.36], [0.54, 0.36]]]],
};

/** The model name in raised bright letters on a plane; (u0, v0): lower left corner, millimetres. */
function buildScript(mb, plane, text, u0, v0, height, slant) {
  const stroke = height * 0.15, normal = sub(plane(0, 0, 1000), plane(0, 0, 0));
  let pen = u0;
  chrome(mb, 30);
  for (const ch of text) {
    const [advance, lines] = GLYPHS[ch];
    for (const line of lines) for (let i = 0; i < line.length - 1; i++) {
      const at = ([gx, gy]) => plane(pen + (gx + gy * slant) * height, v0 + gy * height, 1.3), a = at(line[i]), b = at(line[i + 1]), d = unit(sub(b, a)), e = stroke * MM / 2;
      strut(mb, a.map((v, k) => v - d[k] * e), b.map((v, k) => v + d[k] * e), stroke * MM, 0.0026, normal);
    }
    pen += advance * height;
  }
}

/** Rear number plate on the mesh panel: a pressed plate in a black frame, lit from above. Returns { centre, lamps }. */
function buildPlate(mb) {
  const P = S.TAIL.plate, x = S.TAIL.mesh.x - S.TAIL.plateRecess.depth + 4, plane = (u, v, w = 0) => toCar(x + w, v, -u), w = P.width / 2, y0 = P.bottom, y1 = P.bottom + P.height;
  satin(mb, 100);
  const f = P.frame, outer = roundRect(-w - f, y0 - f, w + f, y1 + f, 9, 3), inner = roundRect(-w, y0, w, y1, 6, 3);
  ringLoft(mb, plane, outer, [[0, 0], [0, 5], [-2, 7]]);
  region(mb, plane, outer.map(([u, v]) => { const cu = Math.sign(u) * 2, cv = v > (y0 + y1) / 2 ? -2 : 2; return [u - cu, v + cv]; }), [inner], { w: 7 });
  mb.material(VEHICLE.PLATE, 1, 37); mb.color(0.93, 0.92, 0.86); mb.occlusion(1);
  region(mb, plane, inner, [], { w: 6, uv: (q) => [(q[0] + w) / P.width, (q[1] - y0) / P.height] });
  const centre = plane(0, (y0 + y1) / 2, 6);
  // the two lamps that light it at night sit over its top edge
  const lamps = buildPlateLamps(mb, { centre, normal: [0, 0, -1], up: [0, 1, 0], width: P.width * MM, height: P.height * MM });
  return { centre, lamps };
}

/**
 * Parts built once for the whole car. Returns { plateRear, plateLamps, plateFront } anchors; no front plate is fitted (the
 * setting only requires a rear one), so plateFront is the place on the bumper where one would go.
 */
export function buildCentreDetails(mb, hull, canopy) {
  buildWiper(mb, canopy, hull);
  buildEmblem(mb, hull);
  const T = S.TAIL, script = D.script, tailPlane = (u, v, w = 0) => toCar(T.planeX + w, v, -u);
  buildScript(mb, tailPlane, script.text, script.u, script.v, script.height, 0.18);
  const plate = buildPlate(mb);
  return { plateRear: plate.centre, plateLamps: plate.lamps, plateFront: toCar(-2, (S.FASCIA.bumperTop + S.FASCIA.bumperBottom) / 2, 0) };
}
