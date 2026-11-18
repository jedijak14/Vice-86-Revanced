// What every lamp of the car is made of: a bright reflector bowl, a bulb standing in it, a moulded lens in front and
// the trim that holds them. Each builder works in a lamp frame: a function to3(u, v, w) from millimetres in the
// lamp's own plane (u and v across the lens, +w out of the lamp towards whoever looks at it) to vehicle metres.
//
// Materials (ARCHITECTURE 5.4): the bowl is LENS_CLEAR with p0 = 0 and p1 = the circuit that lights it; the bulb is
// the LAMP_* id of its circuit with p0 = 6; the lens is GLASS.LAMP_LENS with p0 = its optics, p1 = the circuit and
// p2 = its density. Texture coordinates of all three are metres from the bulb axis, so that the shader can put the
// hot spot on the bulb. Without a glass builder (the reduced model) a lamp is one coloured face that glows.

import { VEHICLE, GLASS, FAMILY } from '../../../core/ids.js';
import { patch, region, ringLoft, lathe, frame, roundRect } from '../kit/solids.js';

export const MM = 0.001, TAU = Math.PI * 2;

/** Lamp circuits as the shaders number them. */
export const CIRCUIT = { HEAD: 0, TAIL: 1, STOP_TAIL: 2, REVERSE: 3, INDICATOR: 4, INDICATOR_RIGHT: 5, MARKER: 6, FOG: 7 };
/** What a lit surface is moulded as (p0 of the LAMP_* materials and of GLASS.LAMP_LENS). */
export const OPTICS = { SMOOTH: 0, FLUTES: 1, PRISMS: 2, RINGS: 3, SEALED_BEAM: 4, REFLEX: 5, BULB: 6 };
/** Lens plastics and glass: body colour (sRGB) and density (0..255, how much of what lies behind is hidden). */
export const LENS = {
  clear: { colour: [0.92, 0.94, 0.95], density: 30 },
  amber: { colour: [0.85, 0.54, 0.17], density: 150 },
  red: { colour: [0.62, 0.05, 0.07], density: 190 },
};
/** The material that glows for each circuit: [id, p1]. A stop lamp that is also the tail lamp says so in p1. */
const GLOW = [
  [VEHICLE.LAMP_HEAD, 0], [VEHICLE.LAMP_TAIL, 0], [VEHICLE.LAMP_BRAKE, 1], [VEHICLE.LAMP_REVERSE, 0],
  [VEHICLE.LAMP_INDICATOR_L, 0], [VEHICLE.LAMP_INDICATOR_R, 0], [VEHICLE.LAMP_MARKER, 0], [VEHICLE.LAMP_HEAD, 0],
];

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Unit vector along +w of a lamp frame, in the vehicle frame. */
export const axisOf = (to3) => unit(sub(to3(0, 0, 1), to3(0, 0, 0)));

/**
 * A lamp frame set inside another: origin and the directions of its u and v axes are given in the parent's
 * millimetres; v is squared up to u and both are made unit length, w is u x v.
 */
export function subFrame(parent, origin, uAxis, vAxis) {
  const U = unit(uAxis), d = dot(vAxis, U), V = unit([vAxis[0] - U[0] * d, vAxis[1] - U[1] * d, vAxis[2] - U[2] * d]), N = cross(U, V);
  return (u, v, w = 0) => parent(origin[0] + u * U[0] + v * V[0] + w * N[0], origin[1] + u * U[1] + v * V[1] + w * N[1], origin[2] + u * U[2] + v * V[2] + w * N[2]);
}

/** Circle of n points round (cu, cv), counter-clockwise. */
export function circle(r, n, cu = 0, cv = 0) {
  const c = [];
  for (let i = 0; i < n; i++) { const a = i / n * TAU; c.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]); }
  return c;
}

const metres = (cu, cv) => (q) => [(q[0] - cu) * MM, (q[1] - cv) * MM];

function bowlMetal(mb, circuit, tint, occlusion = 1) { mb.material(VEHICLE.LENS_CLEAR, 0, circuit); mb.color(tint); mb.occlusion(occlusion); }

/** Reflector colour behind a lens of the given colour: bright plating that takes on some of what it is seen through. */
export const bowlTint = (lens) => lens.colour.map((c) => 0.95 * (0.6 + 0.4 * c / Math.max(...lens.colour)));

/**
 * A round parabolic reflector whose mouth (radius r) lies at w = 0 round the frame's origin and whose neck (radius
 * neck) lies `depth` behind it, closed by a flat back plate. w lifts the whole bowl.
 */
export function roundBowl(mb, to3, { r, depth, circuit, tint, neck = r * 0.17, segs = 40, rows = 9, w = 0 }) {
  bowlMetal(mb, circuit, tint);
  const grid = [], radii = [], k = depth / (r * r - neck * neck);
  for (let i = 0; i <= rows; i++) {
    const t = i / rows, rho = r + (neck - r) * (1 - (1 - t) * (1 - t));          // rows crowd towards the mouth, where the wall is steep
    radii.push(rho); grid.push(circle(rho, segs).map((q) => to3(q[0], q[1], w - k * (r * r - rho * rho))));
  }
  patch(mb, grid, { flip: true, closeJ: true, crease: 60, uv: (i, j) => { const a = j / segs * TAU; return [Math.cos(a) * radii[i] * MM, Math.sin(a) * radii[i] * MM]; } });
  region(mb, to3, circle(neck, segs), [], { w: w - depth, uv: metres(0, 0) });
}

/**
 * A reflector of any convex mouth: `loop` at height w, drawn in towards the bulb axis as a parabola down to a flat
 * floor `depth` below, which is the mouth scaled by `floor`. focus = [u, v] of the bulb, the origin of the texture
 * coordinates.
 */
export function loopBowl(mb, to3, loop, { w = 0, depth, circuit, tint, focus, rows = 5, floor = 0.42 }) {
  bowlMetal(mb, circuit, tint);
  const loops = [], grid = [];
  for (let i = 0; i <= rows; i++) {
    const s = i / rows, k = 1 - (1 - floor) * s;
    loops.push(loop.map((q) => [focus[0] + (q[0] - focus[0]) * k, focus[1] + (q[1] - focus[1]) * k]));
    grid.push(loops[i].map((q) => to3(q[0], q[1], w - depth * (2 * s - s * s))));
  }
  patch(mb, grid, { flip: true, closeJ: true, crease: 60, uv: (i, j) => metres(...focus)(loops[i][j % loop.length]) });
  region(mb, to3, loops[rows], [], { w: w - depth, uv: metres(...focus) });
}

/** Centre of a loop's bounding box. */
export function centreOf(loop) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const [u, v] of loop) { u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return [(u0 + u1) / 2, (v0 + v1) / 2, u1 - u0, v1 - v0];
}

/**
 * A bulb: a glass envelope of radius r and the given length standing at (u, v, w) and pointing along +w, on a short
 * bright cap. It is the part that glows white hot when its circuit is on.
 */
export function bulb(mb, to3, { u = 0, v = 0, w, r = 9, length = 30, circuit, colour = [1, 0.95, 0.85] }) {
  const m = frame(to3(u, v, w), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0))), R = r * MM, L = length * MM;
  mb.material(VEHICLE.CHROME, 60, 0); mb.color(0.8, 0.8, 0.78); mb.occlusion(0.9);
  lathe(mb, m, [[0, R * 0.62], [L * 0.22, R * 0.62]], { segs: 12 });
  mb.material(GLOW[circuit][0], OPTICS.BULB, GLOW[circuit][1]); mb.color(colour); mb.occlusion(1);
  lathe(mb, m, [[L * 0.22, R * 0.5], [L * 0.34, R * 0.92], [L * 0.44, R], [L * 0.8, R], [L * 0.93, R * 0.7], [L, 0]], { segs: 12, uv: () => [0, 0] });
}

/**
 * A flat lens over `loop` at height w. On a glass builder it is real lens glass in front of whatever stands behind;
 * on the body builder (glass == null, the reduced model) it is a complete lamp on one surface.
 * lens: an entry of LENS; origin: [u, v] of the bulb axis.
 */
export function lensFace(body, glass, to3, loop, { w = 0, holes = [], optics, circuit, lens, origin = [0, 0] }) {
  if (glass) {
    glass.material(GLASS.LAMP_LENS, optics, circuit, lens.density); glass.color(lens.colour); glass.occlusion(1);
    region(glass, to3, loop, holes, { w, uv: metres(...origin) });
  } else {
    body.material(GLOW[circuit][0], optics, GLOW[circuit][1]); body.color(lens.colour); body.occlusion(1);
    region(body, to3, loop, holes, { w, uv: metres(...origin) });
  }
}

/** A passive reflex reflector over `loop` at height w: it never glows, it throws headlamp light back. */
export function reflexFace(mb, to3, loop, { w = 0, holes = [], colour, origin = [0, 0] }) {
  mb.material(VEHICLE.LAMP_MARKER, OPTICS.REFLEX, 0); mb.color(colour); mb.occlusion(1);
  region(mb, to3, loop, holes, { w, uv: metres(...origin) });
}

/** A wall through copies of a loop (see the kit's ringLoft) in one material. */
export function trim(mb, to3, loop, steps, { id = VEHICLE.TRIM_BLACK, rough = 150, colour = [0.03, 0.03, 0.032], occlusion = 0.7, outer = false, crease = 38 } = {}) {
  mb.material(id, rough, 0); mb.color(colour); mb.occlusion(occlusion);
  ringLoft(mb, to3, loop, steps, { outer, crease });
}

/** Bright plated trim. */
export const CHROME = { id: VEHICLE.CHROME, rough: 30, colour: [0.9, 0.9, 0.92], occlusion: 1 };

/**
 * After a half has been copied to the other side of the car, make the copied lamps answer to the right-hand
 * indicator circuit: the glowing material itself, and the circuit numbers carried by bowls and lens glass.
 * mb: the builder appended to; first: index of the first copied vertex; glass: true for the glass builder.
 */
export function mirrorLampCircuits(mb, first, glass = false) {
  for (let i = first; i < mb.count; i++) {
    const m = i * 4, id = mb.mat[m];
    if (glass) { if (id === GLASS.LAMP_LENS && mb.mat[m + 2] === CIRCUIT.INDICATOR) mb.mat[m + 2] = CIRCUIT.INDICATOR_RIGHT; }
    else if (id === VEHICLE.LAMP_INDICATOR_L) mb.mat[m] = VEHICLE.LAMP_INDICATOR_R;
    else if (id === VEHICLE.LENS_CLEAR && mb.mat[m + 1] === 0 && mb.mat[m + 2] === CIRCUIT.INDICATOR) mb.mat[m + 2] = CIRCUIT.INDICATOR_RIGHT;
  }
}

/** Run `build` with the builder switched to the glass family, and switch it back to the vehicle family after. */
export function asGlass(mb, build) { mb.family(FAMILY.GLASS); build(mb); mb.family(FAMILY.VEHICLE); }

/** The part of a convex loop to the left of the line from a to b (to its right with keepLeft false). */
export function clipByLine(loop, a, b, keepLeft = true) {
  const side = (p) => ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) * (keepLeft ? 1 : -1), out = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length], sp = side(p), sq = side(q);
    if (sp >= 0) out.push(p);
    if (sp * sq < 0) { const t = sp / (sp - sq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/**
 * A round lamp of the sealed-beam kind in a panel at w = 0 of its frame: a bright retaining ring with screws, a domed
 * glass lens, the parabolic reflector, the bulb with its shield, and a bucket behind. r: radius over the ring.
 * lensInto(build): runs build(builder) with a builder that takes glass. Returns the lens centre (vehicle metres).
 */
export function sealedBeam(mb, to3, lensInto, { r, circuit = CIRCUIT.HEAD, segs = 56, depth = 50, bucket = true }) {
  const glassR = r - 7, dome = 7, ring = circle(glassR, segs);
  // retaining ring: up from the panel, over the top and down to the lens seat
  trim(mb, to3, ring, [[7, 0], [7, 2.6], [6.2, 3.8], [4.6, 4.4], [2, 4.4], [0.8, 3.6], [0, 2.2], [0, -1.5]], { ...CHROME, crease: 60 });
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) / 4 * TAU, m = frame(to3(Math.cos(a) * (r - 3.4), Math.sin(a) * (r - 3.4), 4.2), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0)));
    mb.material(VEHICLE.CHROME, 50, 0); mb.color(0.75, 0.75, 0.76); mb.occlusion(0.9);
    lathe(mb, m, [[0, 0.0021], [0.0006, 0.0021], [0.0011, 0.0014], [0.0012, 0]], { segs: 8 });
  }
  // reflector and bulb; a bright cup on a stalk hides the filament from the road
  roundBowl(mb, to3, { r: glassR, depth, circuit, tint: [0.95, 0.95, 0.96], segs, w: -1.5 });
  bulb(mb, to3, { w: -1.5 - depth, r: 6.5, length: 26, circuit });
  const cup = frame(to3(0, 0, -depth + 30), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0)));
  mb.material(VEHICLE.CHROME, 25, 0); mb.color(0.9, 0.9, 0.92); mb.occlusion(1);
  lathe(mb, cup, [[-0.008, 0.0085], [-0.002, 0.0085], [0.002, 0.0065], [0.0035, 0]], { segs: 14 });
  lathe(mb, cup, [[-0.002, 0.0075], [-0.008, 0.0075]], { segs: 14 });
  // lens: a flat rim band, then the dome
  lensInto((glass) => {
    glass.material(GLASS.LAMP_LENS, OPTICS.SEALED_BEAM, circuit, LENS.clear.density); glass.color(LENS.clear.colour); glass.occlusion(1);
    const rows = [1, 0.955, 0.86, 0.7, 0.5, 0.28, 0].map((k) => { const h = -1 + (k > 0.955 ? 0.4 * (1 - k) / 0.045 : 0.4 + dome * (1 - (k / 0.955) ** 2)); return { k, row: circle(glassR * k, segs).map((q) => to3(q[0], q[1], h)) }; });
    patch(glass, rows.map((e) => e.row), { flip: false, closeJ: true, crease: 50, uv: (i, j) => { const a = j / segs * TAU, rr = glassR * rows[i].k * MM; return [Math.cos(a) * rr, Math.sin(a) * rr]; } });
  });
  if (bucket) {
    const m = frame(to3(0, 0, 0), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0)));
    mb.material(VEHICLE.TRIM_BLACK, 170, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5);
    lathe(mb, m, [[-(depth + 22) * MM, 0], [-(depth + 22) * MM, r * 0.45 * MM], [-(depth + 14) * MM, r * 0.8 * MM], [-0.001, r * MM]], { segs: 20 });
  }
  return to3(0, 0, dome - 0.6);
}

/** A loop with points added so that no edge is longer than `step`. */
function subdivided(loop, step) {
  const out = [];
  loop.forEach((p, i) => {
    const q = loop[(i + 1) % loop.length], n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
    for (let k = 0; k < n; k++) out.push([p[0] + (q[0] - p[0]) * k / n, p[1] + (q[1] - p[1]) * k / n]);
  });
  return out;
}

/**
 * A rectangular lamp of the sealed-beam kind in a panel at w = 0 of its frame, centred on the frame's origin: a
 * bright retaining frame with a screw at each corner, a gently pillowed glass lens, a reflector drawn in to the bulb,
 * the bulb with its shield, and a bucket behind. width, height: over the bright frame; corner: its corner radius
 * (mm); the opening to leave in the panel is roundRect(-width / 2, -height / 2, width / 2, height / 2, corner).
 * lensInto(build) as for sealedBeam; with lensInto null (the reduced model) the lamp is the frame round one glowing
 * face. Returns the lens centre (vehicle metres).
 */
export function rectBeam(mb, to3, lensInto, { width, height, corner = 14, circuit = CIRCUIT.HEAD, depth = Math.max(36, Math.min(50, height * 0.5)), bucket = true }) {
  const band = 6, dome = 4, hu = width / 2 - band, hv = height / 2 - band, seat = roundRect(-hu, -hv, hu, hv, Math.max(2, corner - band), 5);
  const scaled = (loop, k) => loop.map((q) => [q[0] * k, q[1] * k]);
  // retaining frame: up from the panel, over the top and down to the lens seat
  trim(mb, to3, seat, [[band, 0], [band, 2.6], [band - 0.8, 3.8], [band - 2.2, 4.4], [2, 4.4], [0.8, 3.6], [0, 2.2], [0, -1.5]], { ...CHROME, crease: 60 });
  const inset = Math.max(2, corner - band) * (1 - Math.SQRT1_2) - 3.2 * Math.SQRT1_2;   // screw centre, in from the seat's corner along both axes
  for (const [su, sv] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const m = frame(to3(su * (hu - inset), sv * (hv - inset), 4.2), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0)));
    mb.material(VEHICLE.CHROME, 50, 0); mb.color(0.75, 0.75, 0.76); mb.occlusion(0.9);
    lathe(mb, m, [[0, 0.0021], [0.0006, 0.0021], [0.0011, 0.0014], [0.0012, 0]], { segs: 8 });
  }
  if (!lensInto) { lensFace(mb, null, to3, seat, { w: -1, optics: OPTICS.SEALED_BEAM, circuit, lens: LENS.clear }); return to3(0, 0, -1); }
  // reflector and bulb; a bright cup on a stalk hides the filament from the road
  const fine = subdivided(seat, Math.max(hu, hv) / 5);
  loopBowl(mb, to3, fine, { w: -1.5, depth, circuit, tint: [0.95, 0.95, 0.96], focus: [0, 0], rows: 6, floor: 0.3 });
  bulb(mb, to3, { w: -1.5 - depth, r: 6.5, length: 26, circuit });
  const cup = frame(to3(0, 0, -depth + 30), axisOf(to3), sub(to3(1, 0, 0), to3(0, 0, 0)));
  mb.material(VEHICLE.CHROME, 25, 0); mb.color(0.9, 0.9, 0.92); mb.occlusion(1);
  lathe(mb, cup, [[-0.008, 0.0085], [-0.002, 0.0085], [0.002, 0.0065], [0.0035, 0]], { segs: 14 });
  lathe(mb, cup, [[-0.002, 0.0075], [-0.008, 0.0075]], { segs: 14 });
  // lens: a flat rim band, then a pillow that is highest over the bulb
  const edge = 0.955, pillow = (q) => dome * Math.max(0, 1 - (q[0] / (hu * edge)) ** 2) * Math.max(0, 1 - (q[1] / (hv * edge)) ** 2);
  lensInto((glass) => {
    glass.material(GLASS.LAMP_LENS, OPTICS.SEALED_BEAM, circuit, LENS.clear.density); glass.color(LENS.clear.colour); glass.occlusion(1);
    const rows = [1, edge, 0.86, 0.7, 0.5, 0.28, 0].map((k) => scaled(fine, k));
    patch(glass, rows.map((row, i) => row.map((q) => to3(q[0], q[1], i ? -0.6 + pillow(q) : -1))), { flip: true, closeJ: true, crease: 50, uv: (i, j) => metres(0, 0)(rows[i][j % fine.length]) });
  });
  if (bucket) {
    const outer = roundRect(-width / 2, -height / 2, width / 2, height / 2, corner, 3), back = scaled(outer, 0.45);
    mb.material(VEHICLE.TRIM_BLACK, 170, 0); mb.color(0.03, 0.03, 0.032); mb.occlusion(0.5);
    patch(mb, [[1, -1], [0.8, -(depth + 14)], [0.45, -(depth + 22)]].map(([k, w]) => scaled(outer, k).map((q) => to3(q[0], q[1], w))), { flip: false, closeJ: true, crease: 50 });
    region(mb, (u, v, w) => to3(-u, v, w), back, [], { w: -(depth + 22) });          // the frame mirrored: this face looks backwards
  }
  return to3(0, 0, dome - 0.6);
}
