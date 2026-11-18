// The nose below the bonnet edge: a slim bumper bar with the lamp pockets, the intake slot under it, the chin blade
// and the lower flank ahead of the front wheel. One section is swept along the plan outline of the nose: across the
// front, round the corner and back along the flank to the wheel arch. The section is authored in (o, y): o is the
// distance outward from the outline, y the height. Along the way the section changes: the intake slot and the lamp
// pocket exist only at the front, and the chin blade becomes the skirt that runs into the wheel arch flare.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, box, frame } from './kit/solids.js';
import { roundCorners, leftNormals } from './kit/outline.js';
import * as S from './spec.js';
import { onSide, SILL_ROW } from './body.js';
import { buildFogLamp } from './lamps.js';

const F = S.FASCIA;
const lerp = (a, b, t) => a + (b - a) * t, smooth = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
const BLACK = [0.02, 0.02, 0.022];

/** Plan outline of the nose at the height of the flank seam: [{ q: [x, z], n: outward normal, s: distance along }]. */
function noseOutline(hull, spacing) {
  const zAt = (x) => { const c = onSide(hull, x, S.NOSE_CUT_Y); return hull.pos(c[0], c[1], [0, 0, 0])[0] / S.MM; };
  const xEnd = S.FRONT_AXLE_X - S.FRONT_ARCH.radius + 40, raw = [[0, 0], [0, zAt(0)]];
  for (let x = 70; x < xEnd + 1; x += 35) raw.push([x, zAt(x)]);
  const rounded = roundCorners(raw, raw.map((_, i) => (i === 1 ? F.cornerRadius : 0)), { segs: 6 });
  // subdivide the straight front run, and put a pair of stations either side of every place where the section jumps
  const cornerStart = rounded[1][1], cuts = [...F.pocket.s, ...F.brakeSlot.s], zs = new Set([0, cornerStart]);
  for (let z = spacing; z < cornerStart - 5; z += spacing) zs.add(z);
  const pts = [...zs].sort((a, b) => a - b).map((z) => [0, z]).concat(rounded.slice(2));
  const out = []; let s = 0;
  const nrm = leftNormals(pts);
  for (let i = 0; i < pts.length; i++) {
    if (i) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    out.push({ q: pts[i], n: i === 0 ? [-1, 0] : nrm[i], s });
  }
  // stations exactly at the jumps: interpolate along the outline
  const atS = (sv) => {
    let i = 1; while (i < out.length - 1 && out[i].s < sv) i++;
    const a = out[i - 1], b = out[i], t = (sv - a.s) / (b.s - a.s), n = [lerp(a.n[0], b.n[0], t), lerp(a.n[1], b.n[1], t)], l = Math.hypot(n[0], n[1]);
    return { q: [lerp(a.q[0], b.q[0], t), lerp(a.q[1], b.q[1], t)], n: [n[0] / l, n[1] / l], s: sv };
  };
  for (const c of cuts) { out.push(atS(c - 0.25), atS(c + 0.25)); }
  out.sort((a, b) => a.s - b.s);
  // drop ordinary stations that crowd a jump
  const kept = out.filter((st, i) => !cuts.some((c) => Math.abs(st.s - c) < 6 && Math.abs(Math.abs(st.s - c) - 0.25) > 1e-6));
  return { stations: kept, cornerEnd: rounded.length > 2 ? out.find((st) => st.q[0] >= rounded[8][0] - 1e-6).s : 0, zAt };
}

/** Points on an arc in the (o, y) plane. */
const arcOY = (co, cy, r, a0, a1, n = 3) => { const out = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([co + Math.cos(a) * r, cy + Math.sin(a) * r]); } return out; };

/**
 * The section at one station. Returns nodes [o, y, kind]; `kind` describes the strip that starts at the node:
 * 'paint', 'black' or 'under'.
 */
function sectionAt(st, cornerEnd) {
  const k = 1 - smooth((st.s - cornerEnd - F.fadeStart) / F.fadeLength);              // 1 across the front, 0 along the flank
  const inPocket = st.s > F.pocket.s[0] && st.s < F.pocket.s[1], inSlot = st.s > F.brakeSlot.s[0] && st.s < F.brakeSlot.s[1];
  const top = lerp(S.NOSE_CUT_Y - S.GAP, F.bumperTop, k), back = lerp(-9, -F.shadowDepth, k), face = lerp(0, -F.faceInset, k), rb = F.bevel;
  const pocket = inPocket ? F.pocket.depth : 0, gap = F.intakeDepth * k, gapKind = gap > 1 ? 'black' : 'paint';
  const lipO = lerp(F.skirtLip, F.chinLip, k), slot = inSlot ? F.brakeSlot.depth : 0;
  const nodes = [];
  const add = (pts, kind, last = kind) => { pts.forEach((p, i) => nodes.push([p[0], p[1], i === pts.length - 1 ? last : kind])); };
  const pocketKind = inPocket ? 'black' : 'paint', slotKind = inSlot ? 'black' : 'paint';
  add([[back, S.NOSE_CUT_Y + 2]], 'black');
  add([[back, top]], 'paint');
  add(arcOY(face - rb, top - rb, rb, 90, 0), 'paint');
  add([[face, F.pocket.y[1]], [face - pocket, F.pocket.y[1]], [face - pocket, F.pocket.y[0]]], pocketKind); add([[face, F.pocket.y[0]]], 'paint');
  add(arcOY(face - rb, F.bumperBottom + rb, rb, 0, -90), 'paint', gapKind);
  // the chin blade: its top face runs from the floor of the intake slot forward and down to the edge, which is a
  // short vertical face with a small radius above and a larger one rolling under
  const edgeTop = F.lipY + F.edge, f0 = [face - rb - gap, F.chinTop], f1 = [lipO, edgeTop], on = (t) => [lerp(f0[0], f1[0], t), lerp(f0[1], f1[1], t)];
  add([f0], 'paint');
  const s0 = on(F.brakeSlot.t[0]), s1 = on(F.brakeSlot.t[1]);
  add([s0, [s0[0] - slot, s0[1]], [s1[0] - slot, s1[1]]], slotKind); add([s1], 'paint');
  const run = Math.hypot(f1[0] - f0[0], f1[1] - f0[1]), a = on(1 - 5 / run), b = [lipO, edgeTop - 5];
  add([a, [lerp(lerp(a[0], f1[0], 0.5), lerp(f1[0], b[0], 0.5), 0.5), lerp(lerp(a[1], f1[1], 0.5), lerp(f1[1], b[1], 0.5), 0.5)], b, [lipO, F.lipY + 6]], 'paint');
  add(arcOY(lipO - 6, F.lipY + 6, 6, 0, -90), 'paint', 'under');
  add([[lipO - 6 - F.returnDepth, F.lipY + F.trayStep]], 'under');
  return nodes;
}

/**
 * Lateral position of the fascia's outer face along the flank, for the wheel arch flare that dies into it:
 * (x, y) => z in mm, -Infinity above and below the fascia.
 */
export function flankSkin(hull) {
  const { stations, cornerEnd, zAt } = noseOutline(hull, 45), flank = stations.filter((st) => st.s > cornerEnd);
  return (x, y) => {
    let i = 1; while (i < flank.length - 1 && flank[i].q[0] < x) i++;
    const a = flank[i - 1], b = flank[i], nodes = sectionAt({ s: lerp(a.s, b.s, (x - a.q[0]) / (b.q[0] - a.q[0])) }, cornerEnd);
    let o = -Infinity;
    for (let k = 1; k < nodes.length; k++) {
      const [o0, y0] = nodes[k - 1], [o1, y1] = nodes[k];
      if ((y - y0) * (y - y1) <= 0) o = Math.max(o, y0 === y1 ? Math.max(o0, o1) : lerp(o0, o1, (y - y0) / (y1 - y0)));
    }
    // the section is laid out square to the outline, which is not quite parallel to the car's axis here
    return zAt(x) + o * Math.hypot(1, (zAt(x + 4) - zAt(x - 4)) / 8);
  };
}

/**
 * The underside of the nose in side view, from the chin back to where it has become the sill and the floor:
 * { edge(x): height of the body's lower edge in mm (the chin, rising to the sill round the front wheel),
 *   tray(x): height of the undertray inboard of that edge (level behind the chin, sweeping up into the floor between
 *   the front wheels), end: the x at which both have arrived }.
 * The tray meets the floor tangent and at the floor's own height. A level tray stopped at the wheel wells would
 * leave a step up to the floor there, open to the rear, and an eye at road level behind the car would look through
 * it into the back of the chin.
 */
export function noseUnderside(hull) {
  const sill = (x) => hull.pos(x, SILL_ROW, [0, 0, 0])[1] / S.MM, half = S.FRONT_ARCH.radius / 2;
  const rise = (x) => smooth((x - S.FRONT_AXLE_X + half) / (2 * half));
  return {
    edge: (x) => lerp(F.lipY, sill(x), rise(x)),
    tray: (x) => lerp(F.lipY + F.trayStep, sill(x), rise(x)),
    end: S.FRONT_AXLE_X + half,
  };
}

/**
 * Build the left half of the fascia. wellLine: the lower edge of the front wheel well's inner wall, [[x, y]...] in
 * mm from its front foot back (see arches.js); the undertray is laid through its points.
 * glass: GLASS builder or null for the cheap model. Returns { fog: { centre, size, dir } } for the lamp anchors.
 */
export function buildFascia(mb, glass, hull, quality, wellLine) {
  const { stations, cornerEnd, zAt } = noseOutline(hull, quality.fascia || 45);
  const cx = S.FRONT_AXLE_X, cy = S.WHEEL.front.axleY, rCut = S.FRONT_ARCH.radius + 12;
  /** The flank stops at the wheel arch liner: the last x allowed at height y. */
  const xLimit = (y) => cx - Math.sqrt(Math.max(0, rCut * rCut - (y - cy) * (y - cy)));
  const sideNormal = (x) => { const d = (zAt(x + 4) - zAt(x - 4)) / 8, l = Math.hypot(1, d); return [-d / l, 1 / l]; };
  const kinds = [];
  const grid = stations.map((st) => {
    const nodes = sectionAt(st, cornerEnd); kinds.push(nodes.map((nd) => nd[2]));
    return nodes.map(([o, y]) => {
      let q = st.q, n = st.n;
      if (st.s > cornerEnd && q[0] > xLimit(y)) { const x = xLimit(y); q = [x, zAt(x)]; n = sideNormal(x); }
      return S.toCar(q[0] + n[0] * o, y, q[1] + n[1] * o);
    });
  });
  const styles = {
    paint: () => { mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(1); },
    black: () => { mb.material(VEHICLE.TRIM_BLACK, 190, 0); mb.color(BLACK); mb.occlusion(0.5); },
    under: () => { mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.6); },
  };
  // a strip takes the darker of the kinds at its two stations, so pockets are black right up to their side walls
  const rank = { paint: 0, under: 1, black: 2 };
  patch(mb, grid, { flip: true, crease: 40, style: (i, j) => { const a = kinds[i][j], b = kinds[i + 1][j]; styles[rank[a] >= rank[b] ? a : b](); } });

  // undertray: closes the nose from below, level with the return of the chin, back to the wheel well; from there it
  // runs on between the two wells, where the liners' inner walls stand on it, and up into the floor
  const edge = grid.map((row) => row[row.length - 1]), y = (F.lipY + F.trayStep) * S.MM, wellX = wellLine[0][0], wallZ = S.FRONT_ARCH.linerZ;
  styles.under();
  polygon(mb, [...edge.slice().reverse(), S.toCar(0, 0, 0), S.toCar(wellX, 0, 0), S.toCar(wellX, 0, wallZ)].map((p) => [p[0], y, p[2]]).filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[2] - a[i - 1][2]) > 1e-4));
  const under = noseUnderside(hull), sweep = [...wellLine.filter((p) => p[0] < under.end - 1), [under.end, under.tray(under.end)]];
  patch(mb, sweep.map(([x, h]) => [S.toCar(x, h, 0), S.toCar(x, h, wallZ)]), { facing: [0, -1, 0], crease: 40 });

  return { fog: buildPocketParts(mb, glass) };
}

/**
 * Fog lamp and grille bars in the bumper pocket (front run of the outline, where s equals z). glass: GLASS builder
 * or null for the cheap model. Returns the lamp unit's { centre, size, dir }.
 */
function buildPocketParts(mb, glass) {
  const P = F.pocket, fog = F.fog, floorX = F.faceInset + P.depth, yMid = (P.y[0] + P.y[1]) / 2, h = P.y[1] - P.y[0] - 8;
  // the lamp unit stands on the pocket floor with its face 8 mm behind the bumper face; +w comes forward out of it
  const faceX = F.faceInset + 8, plane = (u, v, w = 0) => S.toCar(faceX - w, yMid + v, fog.z + u);
  const unit = buildFogLamp(mb, glass, { plane, size: [fog.width, h], depth: P.depth - 8 });
  // grille bars: bright aluminium strips outboard of the lamp
  const place = (x, yy, z) => frame(S.toCar(x, yy, z), [0, 0, 1], [1, 0, 0]);
  mb.material(VEHICLE.CHROME, 90, 0); mb.color(0.78, 0.79, 0.8); mb.occlusion(0.85);
  const g = F.grille, len = g.z[1] - g.z[0];
  for (let i = 0; i < g.bars; i++) {
    const yy = P.y[0] + (P.y[1] - P.y[0]) * (i + 0.5) / g.bars;
    box(mb, place(floorX - 9, yy, (g.z[0] + g.z[1]) / 2), 18 * S.MM, len * S.MM, g.height * S.MM);
  }
  return unit;
}
