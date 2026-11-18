// Wheel arches: the flare round a wheel opening, its rolled lip and the liner behind it, for any car.
// An arch is swept along the outline of its opening in side view. The cross-section is laid out in (r, z): r is
// the distance outward from the opening edge in the side plane, z is the lateral position. It runs, from the inside
// out: liner tunnel -> flange -> rolled lip (the returned edge of the opening) -> flare. The flare is pressed out of
// the body side, not laid on it: a broad flat face beside the lip, parallel to the car's centre plane, a small
// convex radius at the face's edge, and from there one long concave sweep that lands tangent on the panel. The two
// arcs are tangent to each other, so a reflection runs from the face over the edge and onto the body in one line,
// and the band has no shoulder and no step. This is how a wing beaten out over a wider tyre looks.
// The car's body panels must be cut some 14 mm outside the opening, under the flare, so nothing shows through.
// Everything here is in the car's drawing coordinates (millimetres); the car supplies the conversion and its side.

import { VEHICLE } from '../../../core/ids.js';
import { patch, polygon } from './solids.js';
import { leftNormals } from './outline.js';

const LIP_DEPTH = 40;          // how far the lip returns into the body, mm
const LINER_STEP = 12;         // the liner tunnel is this much larger than the opening, mm
const LINER_SHEET = 1.5;       // thickness of the liner's sheet, mm
const SINK = 2.5;             // the flare's outer edge is buried this far in the body, mm
// A part mounted on the body (the fascia's flank) is sectioned more coarsely than the hull, and a
// band that only grazed it would break through its skin in a ragged line; there the edge is buried deeper.
const COVER_SINK = 9;          // depth of the flare's outer edge in a mounted part, mm
const COVER_PROUD = 15;        // a mounted part counts as the surface in full once it stands this far off the hull, mm
const BURY = 25;              // and from there a wall runs on into the body, so the band is closed where the surface beside it steps, mm
const TAPER = 0.6;            // the band narrows by at most this much per millimetre along the opening
const SHOULDER_CLEAR = 10;     // the flare stops this far below the row where the body side begins, mm
const MAX_FACE_SHARE = 0.5;    // where the band is narrowed (under the shoulder) the face gives up width first: at most this share of the band
const EDGE_RADIUS = 12;        // convex radius at the outer edge of the flat face, mm
const ON_EDGE = 0.01;          // a point this little under the body's lower edge counts as standing on it, mm
const LIP_RADIUS = 6;          // of the rolled edge of the opening: small, so the lip reads crisp, mm
const FLOOR_SPACING = 20;      // between points of the floor line under the liner's inner wall, mm
const FACE_STEPS = 2;          // sections across the face; quality.flare gives those across the edge and the sweep that join it to the body
/** Smooth step with zero slope and zero curvature at both ends. */
const ease = (u) => u * u * u * (10 - 15 * u + 6 * u * u);
export const LINER_GREY = [0.035, 0.035, 0.038];

/**
 * The outline with both ends on the line y = bottom(x): run on along its end tangents where it stops short, cut off
 * where it overshoots. An arch whose feet stand exactly on the body's lower edge leaves neither a gap over the floor
 * nor a tab hanging under it.
 */
function footed(outline, bottom) {
  const RUN = 80, MERGE = 4, height = (p) => p[1] - bottom(p[0]);
  const runOn = (p, q) => { const l = Math.hypot(p[0] - q[0], p[1] - q[1]); return [p[0] + (p[0] - q[0]) * RUN / l, p[1] + (p[1] - q[1]) * RUN / l]; };
  const cut = (pts) => {
    const first = pts.findIndex((p) => height(p) >= 0), a = pts[first - 1], b = pts[first], t = height(a) / (height(a) - height(b));
    const foot = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], near = Math.hypot(b[0] - foot[0], b[1] - foot[1]) < MERGE;
    return [foot, ...pts.slice(near ? first + 1 : first)];
  };
  const n = outline.length, long = [runOn(outline[0], outline[1]), ...outline, runOn(outline[n - 1], outline[n - 2])];
  return cut(cut(long).reverse()).reverse();
}

const quarter = (cx, cy, r, a0, a1, n) => { const out = []; for (let i = 0; i <= n; i++) { const t = a0 + (a1 - a0) * i / n; out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]); } return out; };

/**
 * Build one arch on the left side of a car.
 * body: the car the arch is pressed out of, in its drawing coordinates (millimetres: x along the car, y up, z outward):
 *   { toCar(x, y, z): drawing point -> vehicle frame,
 *     sideZ(x, y): lateral position of the body side at a side-view point,
 *     sideTop(x): height at which the body side ends under the shoulder (the flare stays below it),
 *     paint(mb): set the builder's material state for body colour }.
 * opts: { path: opening outline [[x, y]...] (its ends are brought onto the body's lower edge),
 *         bottom: (x) => height of the body's lower edge, band: (t 0..1 along the path) => width of the flare in mm,
 *         floor: (x) => height of the car's underside inboard of the well, where that is not the lower edge (a nose
 *           whose chin hangs below its undertray): the liner stands on it and its inner wall is closed along it,
 *         face: width of the flat face in mm, faceZ, linerZ: lateral position of the liner's inner wall,
 *         cover: (x, y) => lateral position of a part that stands on the body beside the opening, if any,
 *         blendSteps, lipSteps: sections across the edge radius and the concave sweep, and round the rolled lip }.
 * Returns { footprint: [x0, x1] of the liner at floor level, floorLine: [[x, y]...] the lower edge of its inner wall
 *   from foot to foot; an underside that is to meet the wall without a crack takes its edge through these points }.
 */
export function buildArch(mb, body, opts) {
  const { toCar } = body;
  const sideBottom = opts.bottom, floor = opts.floor || sideBottom;
  const path = footed(opts.path, sideBottom), { faceZ, linerZ } = opts, n = path.length, nrm = leftNormals(path), rl = LIP_RADIUS;
  // The surface the flare grows out of: the body side, or whatever is mounted on it. A section near a foot reaches
  // below the body's lower edge, where there is no side to stand on: sampled there it would be the underside, and
  // drag the band's cut end in under the car. Below the edge the side counts as running straight down from it.
  const onSide = (x, y) => Math.max(y, sideBottom(x));
  const bareZ = (x, y) => body.sideZ(x, onSide(x, y));
  const hullZ = (x, y) => (opts.cover ? Math.max(bareZ(x, y), opts.cover(x, onSide(x, y))) : bareZ(x, y));
  const sink = (x, y) => SINK + (COVER_SINK - SINK) * Math.max(0, Math.min(1, (hullZ(x, y) - bareZ(x, y)) / COVER_PROUD));
  // The flare lives on the body side. Over the top of the opening it may not climb past the shoulder crease, so it
  // narrows there.
  const sideTop = (x) => body.sideTop(x) - SHOULDER_CLEAR;
  const widths = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = path[i], [nx, ny] = nrm[i], wide = opts.band(i / (n - 1));
    let width = wide;
    if (ny > 0.05) {
      let r = (sideTop(x) - y) / ny;
      for (let pass = 0; pass < 3; pass++) r = (sideTop(x + nx * r) - y) / ny;
      width = Math.min(wide, Math.max(rl + 20, r));
    }
    widths.push(width);
  }
  // The shoulder falls towards the nose and bites into the band suddenly; lead the width down to it instead.
  const step = (i, j) => Math.hypot(path[i][0] - path[j][0], path[i][1] - path[j][1]) * TAPER;
  for (let i = 1; i < n; i++) widths[i] = Math.min(widths[i], widths[i - 1] + step(i, i - 1));
  for (let i = n - 2; i >= 0; i--) widths[i] = Math.min(widths[i], widths[i + 1] + step(i, i + 1));
  for (let pass = 0; pass < 4; pass++) for (let i = 1; i < n - 1; i++) widths[i] = Math.min(widths[i], (widths[i - 1] + 2 * widths[i] + widths[i + 1]) / 4);
  // The liner tunnel in side view; its two end sections stand on the floor. A liner that hung below the floor beside
  // it would show its back from the far side of the car, to an eye at road level.
  const wall = path.map((p, i) => { const x = p[0] + nrm[i][0] * LINER_STEP; return [x, i === 0 || i === n - 1 ? floor(x) : p[1] + nrm[i][1] * LINER_STEP]; });
  // Sections of the band, square to the opening, as points [x, y, z] in drawing millimetres.
  const liner = [], band = [], lipZ = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = path[i], [nx, ny] = nrm[i], width = widths[i], zLip = hullZ(x, y) - LIP_DEPTH;
    liner.push([toCar(wall[i][0], wall[i][1], linerZ), toCar(wall[i][0], wall[i][1], zLip), toCar(x, y, zLip)]);
    const prof = [[0, zLip], ...quarter(rl, faceZ - rl, rl, Math.PI, Math.PI / 2, opts.lipSteps)];
    const face = Math.min(opts.face, (width - rl) * MAX_FACE_SHARE), r0 = rl + face, run = width - r0;
    for (let k = 1; k <= FACE_STEPS; k++) prof.push([rl + face * k / FACE_STEPS, faceZ]);
    const skin = (r) => hullZ(x + nx * r, y + ny * r), drop = faceZ - skin(width);
    if (drop > 1) {
      // Two tangent arcs take the face down to the panel over the width `run`: a convex edge of radius rc turning
      // through theta, then a concave sweep of radius rk turning back; tan(theta / 2) = drop / run makes them meet
      // tangent, and the sweep lands tangent on the panel. Every point is laid out as its share of the drop over the
      // panel as it really is at that point, so the band follows the body's own curvature under it.
      const theta = 2 * Math.atan2(drop, run), sinT = Math.sin(theta), total = run / sinT, rc = Math.min(EDGE_RADIUS, total / 2), rk = total - rc;
      const edgeSteps = Math.max(1, Math.round(opts.blendSteps * 0.3)), sweepSteps = Math.max(1, opts.blendSteps - edgeSteps);
      const place = (r, share) => { const sk = skin(r); const u = 1 - share; return [r, Math.min(faceZ, sk + (faceZ - sk) * share - sink(x + nx * r, y + ny * r) * u * u)]; };
      for (let k = 1; k <= edgeSteps; k++) { const a = theta * k / edgeSteps; prof.push(place(r0 + rc * Math.sin(a), 1 - rc * (1 - Math.cos(a)) / drop)); }
      for (let k = 1; k <= sweepSteps; k++) { const a = theta * (1 - k / sweepSteps); prof.push(place(width - rk * Math.sin(a), rk * (1 - Math.cos(a)) / drop)); }
    } else {
      // where the body is already as wide as the face (the tail of the rear wing) the flare simply dies into it
      for (let k = 1; k <= opts.blendSteps; k++) {
        const u = k / opts.blendSteps, r = r0 + run * u, sk = skin(r);
        prof.push([r, Math.min(faceZ, sk + Math.max(0, faceZ - sk) * (1 - ease(u))) - sink(x + nx * r, y + ny * r) * u * u]);
      }
    }
    band.push(prof.map(([r, z]) => [x + nx * r, y + ny * r, z])); lipZ.push(zLip);
  }
  // Nor may the band hang below the body's lower edge, which a section near a foot would cross (behind the rear wheel
  // that edge climbs steeply towards the tail). There the band is cut off along the edge: each line that runs along
  // the band is followed in from the foot to where it comes up through the edge, and ends there. The sections keep
  // their shape right down to the cut, so the foot is a clean slanted end and not a lump.
  const over = (q) => q[1] - sideBottom(q[0]), cols = band[0].length, cutEnds = [], cutRows = new Set();   // cutRows: sections whose outer edge is cut away
  for (const [end, inward] of [[0, 1], [n - 1, -1]]) {
    let cut = false;
    for (let j = 0; j < cols; j++) {
      let i = end; while (i !== end + inward * (n >> 1) && over(band[i][j]) < -ON_EDGE) i += inward;
      if (i === end) continue;
      const a = band[i][j], b = band[i - inward][j], t = over(a) / (over(a) - over(b)), x = a[0] + (b[0] - a[0]) * t;
      const crossing = [x, sideBottom(x), a[2] + (b[2] - a[2]) * t];
      for (let k = end; k !== i; k += inward) { band[k][j] = crossing; if (j === cols - 1) cutRows.add(k); }
      cut = true;
    }
    if (cut) cutEnds.push(end);
  }
  const painted = band.map((row) => row.map((q) => toCar(q[0], q[1], q[2])));
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(LINER_GREY); mb.occlusion(0.45);
  patch(mb, liner, { crease: 50 });
  // The tunnel's far side is in view too wherever the underside beside a leg stands higher than its foot: behind the
  // rear wheel of a car whose tail is open underneath, to an eye at road level behind it. A wheel tub is sheet
  // metal with two sides, so the tunnel gets its other side, the sheet's thickness away.
  const back = wall.map((p, i) => { const x = p[0] + nrm[i][0] * LINER_SHEET; return [x, i === 0 || i === n - 1 ? floor(x) : p[1] + nrm[i][1] * LINER_SHEET]; });
  patch(mb, back.map((p, i) => [toCar(p[0], p[1], linerZ), toCar(p[0], p[1], lipZ[i])]), { crease: 50, flip: true });
  // inner wall of the liner, closed along the floor line (which climbs towards the tail under the rear arch)
  const floorSteps = Math.ceil((wall[n - 1][0] - wall[0][0]) / FLOOR_SPACING), floorLine = [wall[0]];
  for (let k = 1; k < floorSteps; k++) { const x = wall[0][0] + (wall[n - 1][0] - wall[0][0]) * k / floorSteps; floorLine.push([x, floor(x)]); }
  floorLine.push(wall[n - 1]);
  polygon(mb, [...wall, ...floorLine.slice(1, -1).reverse()].reverse().map((p) => toCar(p[0], p[1], linerZ)));
  body.paint(mb);
  patch(mb, painted, { crease: 50 });
  // From the band's outer edge a wall runs on into the body, so the band is closed where the surface beside it steps.
  // It runs down to a cut and ends on it (the sections past the cut have no outer edge left); stopped a section
  // short, it would leave the band's end open to an eye behind the foot.
  patch(mb, band.map((row) => { const q = row[cols - 1]; return [toCar(q[0], q[1], q[2]), toCar(q[0], q[1], q[2] - BURY)]; }), { crease: 50, style: (i) => !(cutRows.has(i) && cutRows.has(i + 1)) });
  // Feet. A band that reaches its foot whole is closed there across its section. A cut one is closed from below along
  // the cut; that underside faces the road, and behind the rear wheel the tail too, so it is undersealed like the
  // floor it continues and a polished face does not flash the road's light from under the body.
  for (const end of [0, n - 1]) {
    if (cutEnds.includes(end)) continue;
    const ring = painted[end].concat([toCar(band[end][cols - 1][0], band[end][cols - 1][1], lipZ[end])]); polygon(mb, end ? ring.slice().reverse() : ring);
  }
  mb.material(VEHICLE.UNDERBODY, 0, 0); mb.color(LINER_GREY); mb.occlusion(0.5);
  for (const end of cutEnds) patch(mb, band[end].map((q) => [toCar(q[0], q[1], q[2]), toCar(q[0], q[1], lipZ[end])]), { facing: [0, -1, 0] });
  return { footprint: [wall[0][0], wall[n - 1][0]], floorLine };
}
