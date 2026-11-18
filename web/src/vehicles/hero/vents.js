// Everything that breathes: the NACA ducts in the flanks, the shoulder air boxes behind the side windows, the raised
// engine cover with its louvred tail, and the louvre banks let into the rear wing tops. Left half; drawing millimetres.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, box, frame, planeFrame } from './kit/solids.js';
import { roundCorners, offset } from './kit/outline.js';
import * as S from './spec.js';
import { topPoint, sidePoint, nacaOutline, DOOR_TOP_ROW } from './body.js';

const MM = S.MM, toCar = S.toCar;
const SATIN_BLACK = [0.22, 0.22, 0.225];   // sRGB; about 4 % reflectance, lookdev's value for satin trim
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (p, q, t) => p.map((v, k) => v + (q[k] - v) * t);
const black = (mb, occlusion, rough = 150) => { mb.material(VEHICLE.TRIM_BLACK, rough, 0); mb.color(SATIN_BLACK); mb.occlusion(occlusion); };
const paint = (mb) => { mb.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); mb.color(1, 1, 1); mb.occlusion(1); };
/** Quadratic fillet through corner P between A and B, reaching `d` along each leg: segs + 1 points. */
function fillet(A, P, B, d, segs) {
  const la = Math.hypot(...A.map((v, k) => v - P[k])), lb = Math.hypot(...B.map((v, k) => v - P[k]));
  const a = mix(P, A, Math.min(0.45, d / la)), b = mix(P, B, Math.min(0.45, d / lb)), out = [];
  for (let i = 0; i <= segs; i++) { const t = i / segs; out.push(mix(mix(a, P, t), mix(P, b, t), t)); }
  return out;
}

// Flank duct constants, mm
const RAMP_POWER = 1.3;        // floor depth grows as t^power along the duct: a shallow dish in front, steep into the throat
const GROOVE = 6;              // the door's rear shut line where it crosses the duct's floor and walls: width and depth
const WALL_TOP = 8;            // the duct walls begin just under the roll of the panels' lip (HEM_DUCT), where it hides them
const VANE_DEPTH = 30;         // the vane bank lies this far under the skin, over the throat
const VANE_CHORD = 22, VANE_PITCH = 50, VANE_LEAN = 35 * Math.PI / 180;   // lean of the chord from vertical, top edge outward
const DUCT_FLOOR = 0.8;        // lowest baked occlusion anywhere in the flank duct (lookdev: the screen-space term adds the rest)

// Air box constants, mm
const FOOT_FADE = 45;          // the outer foot fillet reaches full size once the foot is this far inside the shoulder line
const TOP_CLEAR = 5;           // least height of the falling top over the wing top under it
const RISE_STEPS = 8;          // stations up the rising top, from the foot line to the peak radius
const LIP_RADIUS = 7;          // rolled lip round the mouth
const SLAT_SET = 14;           // slat bank this far behind the face
const FLOOR_LIFT = 1.5;        // throat floor skin above the deck panel it lies on
const FLOOR_TUCK = 6;          // and this far into the throat walls on either side
const RELEASE = { length: 44, height: 6, ahead: 50 };     // door release slot in the upper wall, its front this far ahead of the shut line

/**
 * Flank duct: an arrowhead pressed into the body side. The floor starts flush with the skin at the tip and sinks to
 * full depth at the mouth, so the front is a shallow body-colour dish that darkens into the throat. The door's rear
 * shut line crosses dish and walls as a groove, and everything behind it is satin trim. Over the throat a bank of
 * horizontal vanes lies 30 mm under the skin; a short tunnel behind the mouth keeps the opening dark. The outline is
 * the hole the door and rear wing leave; their rolled edges (HEM_DUCT) are the lip.
 */
function buildNaca(mb, hull) {
  const N = S.NACA, o = nacaOutline(hull, DOOR_TOP_ROW), lip = 3, tunnel = 150, cols = 6;
  const x0 = o.apex[0] - 8, x1 = o.mouthTop[0], span = x1 - o.apex[0], along = (x) => Math.max(0, Math.min(1, (x - o.apex[0]) / span));
  const depth = (x) => N.depth * along(x) ** RAMP_POWER;
  const edgeY = (x, upper) => lerp(o.apex[1], (upper ? o.mouthTop : o.mouthBottom)[1], Math.min(1, (x - o.apex[0]) / span)) + (upper ? lip : -lip);
  // occlusion: open at the dish, closing gently down the ramp, 0.8 in the tunnel (lookdev's values). The renderer's
  // screen-space occlusion already darkens the recess by about 0.3 on top of this, so the baked term stays high;
  // nothing in the duct goes below 0.8 or the shaded flank shows a black triangle again.
  const occl = (x) => (x > x1 ? DUCT_FLOOR : along(x) < 0.5 ? lerp(1, 0.9, along(x) / 0.5) : lerp(0.9, DUCT_FLOOR, (along(x) - 0.5) / 0.5));
  // where the shut line (a straight line in side view) crosses a line y(x) of the duct
  const seamD = (o.seamTop[0] - o.seamBottom[0]) / (o.seamTop[1] - o.seamBottom[1]), seamC = o.seamBottom[0] - seamD * o.seamBottom[1];
  const crossing = (yOf) => { const b = (yOf(x1) - yOf(x0)) / (x1 - x0), a = yOf(x0) - b * x0; return (seamC + seamD * a) / (1 - seamD * b); };
  // stations along the duct for a line crossing the seam at sx: dish, groove (three faces), ramp, tunnel end
  const DISH = 5, RAMP = 7, g = GROOVE / 2;
  const stations = (sx) => {
    const st = [];
    for (let i = 0; i <= DISH; i++) st.push({ x: lerp(x0, sx - g, i / DISH), sink: 0 });
    st.push({ x: sx - g, sink: GROOVE }, { x: sx + g, sink: GROOVE }, { x: sx + g, sink: 0 });
    for (let i = 1; i <= RAMP; i++) st.push({ x: lerp(sx + g, x1, i / RAMP), sink: 0 });
    st.push({ x: x1 + tunnel, sink: 0 });
    return st;
  };
  const GROOVE_FIRST = DISH, GROOVE_LAST = DISH + 2, TUNNEL_QUAD = DISH + 3 + RAMP;
  // the quad starting at station i: body colour in the dish, dark in the groove, satin trim down the ramp and tunnel
  const style = (st) => (i) => {
    if (i < GROOVE_FIRST) { paint(mb); mb.occlusion(occl(st[i + 1].x)); }
    else if (i <= GROOVE_LAST) black(mb, DUCT_FLOOR, 150);
    else black(mb, occl(st[i + 1].x), i === TUNNEL_QUAD ? 150 : 120);
  };

  // floor: each column has its own crossing with the slanted seam, so the groove follows the shut line exactly
  const yAt = (j) => (x) => lerp(edgeY(x, false), edgeY(x, true), j / cols);
  const colSt = []; for (let j = 0; j <= cols; j++) colSt.push(stations(crossing(yAt(j))));
  const floor = colSt[0].map((_, i) => colSt.map((st, j) => sidePoint(hull, st[i].x, yAt(j)(st[i].x), depth(st[i].x) + st[i].sink)));
  patch(mb, floor, { facing: [1, 0, 0], crease: 50, style: style(colSt[0]) });

  // walls: from under the lip down to the floor; the groove steps outward into the panel behind the lip's return
  const wall = (upper) => {
    const st = stations(crossing((x) => edgeY(x, upper))), out = upper ? 1 : -1;
    const grid = [WALL_TOP, null].map((d) => st.map((s) => sidePoint(hull, s.x, edgeY(s.x, upper) + out * s.sink, d === null ? depth(s.x) + s.sink : d)));
    patch(mb, grid, { facing: [0, -out, 0], crease: 50, style: style(st) });
    return st;
  };
  const upperSt = wall(true); wall(false);

  // tunnel: the back of the skin above it and the far end
  black(mb, DUCT_FLOOR, 150);
  const ys = [edgeY(x1, false), edgeY(x1, true)], xt = x1 + tunnel;
  patch(mb, [x1, xt].map((x) => ys.map((y) => sidePoint(hull, x, y, 12))), { facing: [-1, 0, 0] });
  patch(mb, [12, N.depth].map((d) => ys.map((y) => sidePoint(hull, xt, y, d))), { facing: [0, 0, 1] });

  // vane bank over the throat: horizontal slats under the skin, each from where the floor has fallen well below it
  // (or where the opening becomes wide enough for it) back under the lip at the mouth
  black(mb, DUCT_FLOOR, 120);
  const xDeep = o.apex[0] + span * ((VANE_DEPTH + 20) / N.depth) ** (1 / RAMP_POWER), xEnd = x1 + 25;
  const yFor = (y, upper) => o.apex[0] + span * (y - o.apex[1]) / ((upper ? o.mouthTop : o.mouthBottom)[1] + (upper ? lip : -lip) - o.apex[1]);
  const vanes = Math.floor((ys[1] - ys[0]) / VANE_PITCH), y0 = (ys[0] + ys[1]) / 2 - (vanes - 1) * VANE_PITCH / 2;
  for (let k = 0; k < vanes; k++) {
    const y = y0 + k * VANE_PITCH, xs = Math.max(xDeep, yFor(y, y > o.apex[1]) + 20), mid = sidePoint(hull, (xs + xEnd) / 2, y, VANE_DEPTH);
    box(mb, frame(mid, [0, 0, 1], [Math.sin(VANE_LEAN), Math.cos(VANE_LEAN), 0]), (xEnd - xs) * MM, VANE_CHORD * MM, 0.003);
  }

  // door release: a dark slot let into the upper wall just ahead of the shut line, below the lip's return (which
  // hides the wall's first 19 mm), with a body-colour paddle hanging in it
  const sxU = upperSt[GROOVE_FIRST].x + g, rx = sxU - RELEASE.ahead + RELEASE.length / 2, slotDepth = WALL_TOP + 11 + RELEASE.height / 2;
  black(mb, DUCT_FLOOR, 150);
  box(mb, frame(sidePoint(hull, rx, edgeY(rx, true) + 2, slotDepth), [0, 0, 1], [0, 1, 0]), RELEASE.length * MM, RELEASE.height * MM, 0.006);
  paint(mb); mb.occlusion(DUCT_FLOOR);
  box(mb, frame(sidePoint(hull, rx, edgeY(rx, true) - 2, slotDepth), [0, 0, 1], [0, 1, 0]), RELEASE.length * 0.6 * MM, 0.003, 0.002);
}

/**
 * Louvre bank in the rear wing top: a dark box under the opening and black slats that rise towards the rear, so from
 * behind and above one sees their top faces and never the bottom of the box.
 */
function buildLouvreBank(mb, hull) {
  const L = S.LOUVRE_BANK, boxDepth = 75, grow = 2.5, chord = 54, tilt = 30 * Math.PI / 180;
  const outerZ = (x) => L.z1 + 22 * (x - L.x0) / (L.x1 - L.x0);
  const corners = [[L.x0 - grow, L.z0 - grow], [L.x0 - grow, outerZ(L.x0) + grow], [L.x1 + grow, outerZ(L.x1) + grow], [L.x1 + grow, L.z0 - grow]];
  const rim = corners.map(([x, z]) => topPoint(hull, x, z, 3)), low = rim.map((p) => [p[0], p[1] - boxDepth * MM, p[2]]);
  black(mb, 0.7);
  patch(mb, [rim, low], { closeJ: true, crease: 30, facing: [-1, 0, 0] });      // judged on the outboard wall, whose inside looks inboard
  black(mb, 0.45);
  patch(mb, [[low[0], low[1]], [low[3], low[2]]], { facing: [0, 1, 0] });
  // the slats are satin black, a little smoother than the box so their top faces catch a line of sky
  black(mb, 0.85, 110);
  const pitch = (L.x1 - L.x0) / L.slats;
  for (let i = 0; i < L.slats; i++) {
    const xr = L.x0 + (i + 0.92) * pitch, zin = L.z0 + 1, zout = outerZ(xr) - 1, zm = (zin + zout) / 2;
    const rear = topPoint(hull, xr, zm, 2.5), ahead = topPoint(hull, xr - 40, zm, 2.5);
    const along = [0, 1, 2].map((k) => (ahead[k] - rear[k]) / 0.04);                  // unit-ish, forward along the skin
    const c = Math.cos(tilt), s = Math.sin(tilt), dir = [0, along[1] * c - along[2] * s, along[2] * c + along[1] * s];   // tipped nose-down about the car's X axis
    const mid = [rear[0], rear[1] + dir[1] * chord * MM / 2, rear[2] + dir[2] * chord * MM / 2];
    box(mb, frame(mid, [1, 0, 0], dir), (zout - zin) * MM, chord * MM, 0.0035);
  }
}

/**
 * Height of the body skin above a point of the plan, mm: the wing top inboard of the shoulder line and the shoulder
 * face, which falls away outboard, beyond it.
 */
function skinHeight(hull, x, z) {
  const rim = topPoint(hull, x, 1e4);
  if (z * MM <= rim[0]) return topPoint(hull, x, z)[1] / MM;
  let hi = rim[1] / MM, lo = hi - 200;
  for (let i = 0; i < 20; i++) { const y = (lo + hi) / 2; if (sidePoint(hull, x, y)[0] > z * MM) lo = y; else hi = y; }
  return (lo + hi) / 2;
}

/**
 * Shoulder air box: a wedge standing on the rear wing top behind the side glass, pressed from the body rather than
 * set on it: a 12 mm radius on its top edges, a concave fillet where its walls meet the deck and the roof rail. Its
 * forward face is a scoop: the deck runs straight into the throat (the mouth has no sill), a rolled body-colour lip
 * frames the sides and top, and a bank of leaning slats stands a little way inside. Behind the peak the top falls
 * back into the deck.
 */
function buildAirBox(mb, hull) {
  const A = S.AIR_BOX, lean = Math.tan(A.lean * Math.PI / 180), rise = (A.peakY - A.footY) / (A.peakX - A.x0), fall = Math.tan(A.fall * Math.PI / 180);
  // top line in side view: up to the peak, a radius over it, then down to the deck
  const d = 24, up = Math.hypot(1, rise), peak = [];
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, a = [A.peakX - d / up, A.peakY - d * rise / up], b = [A.peakX + d * Math.cos(Math.atan(fall)), A.peakY - d * Math.sin(Math.atan(fall))];
    peak.push(mix(mix(a, [A.peakX, A.peakY], t), mix([A.peakX, A.peakY], b, t), t));
  }
  // stations up the rising top follow the wing and shoulder under the walls' feet; the last of them starts the peak
  const line = []; for (let i = 0; i < RISE_STEPS; i++) line.push(mix([A.x0, A.footY], peak[0], i / RISE_STEPS));
  line.push(...peak);
  // behind the peak the top falls at a steady angle but never sinks under the hump of the wing top below it
  const crest = (x) => Math.max(...[0, 1, 2, 3, 4].map((j) => skinHeight(hull, x, lerp(A.z0, A.z1 - 40, j / 4))));
  for (let x = A.peakX + 60; x <= A.x1; x += 60) line.push([x, Math.max(A.peakY - (x - A.peakX) * fall, crest(x) + TOP_CLEAR)]);
  const bevel = 4, edge = 12, foot = 10, footSegs = 3;   // reach of the convex top fillets and of the concave foot fillets, mm
  const section = ([x, top]) => {
    const skin = (z) => skinHeight(hull, x, z);
    const zo = A.z1 - lean * (top - A.footY), outerTop = [zo, top], innerTop = [A.z0, top];
    // feet: the leaning outer wall lands on the wing top or, near the front, on the shoulder face below it; the
    // vertical inner wall lands beside the roof rail
    let yf = skin(A.z1); for (let i = 0; i < 8; i++) yf = skin(A.z1 + lean * (A.footY - yf));
    const zf = A.z1 + lean * (A.footY - yf), yi = skin(A.z0);
    // the outer fillet also needs wing top to land on: it grows from nothing as the foot comes in from the shoulder
    // line, in front of which the wall simply runs down into the shoulder face
    const reach = 2.3, room = Math.max(0, topPoint(hull, x, 1e4)[0] / MM - zf), grown = Math.min(1, room / FOOT_FADE);   // fillet() bends over at most 45 % of a leg
    // neither fillet takes more than the lower half of its wall: the upper half belongs to the top edge radius
    const ro = Math.max(0, Math.min(foot * grown * grown * (3 - 2 * grown), (top - yf) / (2 * reach), room / reach)), ri = Math.max(0, Math.min(foot, (top - yi) / (2 * reach)));
    const Ao = [zf - lean * reach * ro, yf + reach * ro], Po = [zf, yf], Bo = [zf + reach * ro, skin(zf + reach * ro)];
    const Ai = [A.z0, yi + reach * ri], Pi = [A.z0, yi], Bi = [A.z0 - reach * ri, skin(A.z0 - reach * ri)];
    // both feet end in a flap tucked under the skin so no edge shows where the fillet runs out
    const pts = [[Bo[0] + lean * 14, Bo[1] - 14], Bo, ...fillet(Ao, Po, Bo, ro, footSegs).reverse(), Ao,
      ...fillet(Po, outerTop, innerTop, edge, bevel), ...fillet(outerTop, innerTop, Pi, edge, bevel),
      Ai, ...fillet(Ai, Pi, Bi, ri, footSegs), Bi, [Bi[0] - 4, Bi[1] - 8]];
    return pts.map(([z, y]) => toCar(x, y, z));
  };
  const grid = line.map(section), topCol = 4 + footSegs + bevel;   // last point of the outer top fillet; topCol + 1 starts the inner one
  paint(mb);
  patch(mb, grid, { facing: [0, 1, 0], crease: 30, style: (i, j) => !(i < RISE_STEPS && j === topCol) });
  // the tail end, where the falling top is about to meet the deck, is closed so nothing looks into the box from behind
  polygon(mb, grid[grid.length - 1].slice().reverse());

  // scoop face: the plane through the foot line and the start of the peak radius; u runs outboard, v up the slope
  const c0 = grid[0][topCol + 1], c1 = grid[0][topCol], c2 = grid[RISE_STEPS][topCol], c3 = grid[RISE_STEPS][topCol + 1];
  const V = [0, 1, 2].map((k) => c3[k] - c0[k]), slope = Math.hypot(...V), Vm = V.map((v) => v / slope * MM), plane = planeFrame(c0, [MM, 0, 0], Vm);
  const uv = (p) => [(p[0] - c0[0]) / MM, ((p[1] - c0[1]) * Vm[1] + (p[2] - c0[2]) * Vm[2]) / (MM * MM)];
  const face = [c0, c1, c2, c3].map(uv), inset = offset(face, A.frame, true);
  // the mouth is open at the bottom: its sides come down to the foot line, so the deck is the floor of the throat
  const atFoot = (p, q) => [p[0] + (q[0] - p[0]) * (0 - p[1]) / (q[1] - p[1]), 0];
  const mouth = roundCorners([atFoot(inset[0], inset[3]), inset[3], inset[2], atFoot(inset[1], inset[2])], [0, 14, 14, 0], { segs: 3 });
  // the face shares every station's vertex with the top fillets either side of it
  const rim = (col) => grid.slice(1, RISE_STEPS + 1).map((row) => uv(row[col]));
  region(mb, plane, [face[0], ...mouth, face[1], ...rim(topCol), ...rim(topCol + 1).reverse()]);
  // rolled lip (body colour) turning into the throat walls (trim), which run back to the wall behind the slats
  const R = LIP_RADIUS, roll = [0, 1, 2, 3].map((i) => { const a = i * Math.PI / 6; return [-R * (1 - Math.cos(a)), -R * Math.sin(a)]; });
  ringLoft(mb, plane, mouth, [...roll, [-R, -A.depth]], { open: true, crease: 50, style: (i) => (i < roll.length - 1 ? paint(mb) : black(mb, 0.7)) });
  // throat floor: a skin laid on the deck from the mouth to the back wall, body colour where it enters and satin
  // from the slats back, so the wing top is seen to run on into the scoop instead of stopping at a hole
  const cosFace = 1 / Math.hypot(1, rise), zA = A.z0 + edge + A.frame + R - FLOOR_TUCK, zB = A.z1 - edge - A.frame - R + FLOOR_TUCK;
  const onDeck = (z, w) => {   // where the plane `w` behind the face meets the floor skin
    let x = A.x0; for (let i = 0; i < 6; i++) x = A.x0 + (skinHeight(hull, x, z) + FLOOR_LIFT - A.footY + w / cosFace) / rise;
    return toCar(x, skinHeight(hull, x, z) + FLOOR_LIFT, z);
  };
  // back wall: a hair larger than the throat, and ending just under the floor so nothing of it hangs inside the body
  const sill = (q) => [q[0], uv(onDeck(c0[0] / MM + q[0], A.depth))[1] - 4];
  black(mb, 0.45);
  region(mb, plane, offset([sill(mouth[0]), ...mouth.slice(1, -1), sill(mouth[mouth.length - 1])], 1 - R, true), [], { w: -A.depth });
  const floor = (depths, style) => patch(mb, depths.map((w) => [0, 1, 2, 3, 4].map((j) => onDeck(lerp(zA, zB, j / 4), w))), { facing: [0, 1, 0], style });
  floor([0, SLAT_SET / 2, SLAT_SET], (i) => { paint(mb); mb.occlusion(i ? 0.8 : 1); });
  floor([SLAT_SET, (SLAT_SET + A.depth) / 2, A.depth + 2], (i) => black(mb, i ? 0.5 : 0.7, 120));
  // slats across the throat, leaning back like the vanes of a shutter, set in behind the lip
  black(mb, 0.75, 110);
  const v1 = Math.max(...mouth.map((q) => q[1])), n = Math.round(v1 / A.slatPitch), wall = A.frame + R - 2;
  const widthAt = (v) => { const t = v / (slope / MM); return [lerp(face[0][0], face[3][0], t) + wall, lerp(face[1][0], face[2][0], t) - wall]; };
  for (let i = 0; i < n; i++) {
    const v = (i + 0.5) * v1 / n, [ua, ub] = widthAt(v), mid = plane((ua + ub) / 2, v, -SLAT_SET), tip = plane((ua + ub) / 2, v + 10, -SLAT_SET + 6);
    box(mb, frame(mid, [1, 0, 0], [0, 1, 2].map((k) => tip[k] - mid[k])), (ub - ua) * MM, 0.017, 0.0028);
  }
}

/**
 * Raised engine cover: a box on the lid that widens and grows towards the tail, its rear face open and louvred.
 * It straddles the centreline, so the half ends there and the opening is a notch in the rear face's outline.
 */
function buildEngineCover(mb, hull) {
  const E = S.ENGINE_COVER, deck = (x) => topPoint(hull, x, 0)[1] / MM, n = 8, bevel = 2;
  const rows = [];
  for (let i = -1; i <= n; i++) {
    const t = Math.max(0, i) / n, x = lerp(E.x0, E.x1, t), h = i < 0 ? -4 : lerp(E.heightFront, E.heightRear, t), hw = lerp(E.halfWidthFront, E.halfWidthRear, t), y = deck(i < 0 ? x - E.ramp : x);
    const pts = [[0, y + h], [hw, y + h], [hw + E.flankLean * Math.max(0, h) + 2, y - 6]];
    rows.push([pts[0], ...fillet(pts[0], pts[1], pts[2], 5, bevel), pts[2]].map(([z, yy]) => toCar(i < 0 ? x - E.ramp : x, yy, z)));
  }
  paint(mb);
  patch(mb, rows, { facing: [0, 1, 0], crease: 28 });

  // rear face
  const x1 = E.x1, top = deck(x1) + E.heightRear, base = deck(x1) - 6, o = E.opening, plane = (u, v, w = 0) => toCar(x1 + w, v, -u);
  const y1 = top - o.top, y0 = y1 - o.height, notch = [[0, y1], [-o.halfWidth, y1], [-o.halfWidth, y0], [0, y0]];
  region(mb, plane, [[0, base], [0, y0], [-o.halfWidth, y0], [-o.halfWidth, y1], [0, y1], [0, top], [-E.halfWidthRear, top], [-E.halfWidthRear - E.flankLean * E.heightRear - 2, base]]);
  black(mb, 0.3);
  ringLoft(mb, plane, notch, [[0, 0], [0, -o.depth]], { open: true, crease: 30 });
  black(mb, 0.1);
  region(mb, plane, notch, [], { w: -o.depth });
  black(mb, 0.75, 110);
  for (let i = 0; i < o.slats; i++) {
    const y = y0 + (i + 0.5) * o.height / o.slats;
    box(mb, frame(toCar(x1 - 12, y, o.halfWidth / 2), [1, 0, 0], [0, -0.55, -1]), (o.halfWidth - 1) * MM, 0.024, 0.003);
  }
}

/** Left half of the vents and scoops. */
export function buildVents(mb, hull) {
  buildNaca(mb, hull);
  buildLouvreBank(mb, hull);
  buildAirBox(mb, hull);
  buildEngineCover(mb, hull);
}
