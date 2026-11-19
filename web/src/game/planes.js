// Aeroplanes, and the airport the city already built for them.
//
// The map has two runways and a taxiway in it already — 45 m of tarmac with edge lights, thresholds and
// the numbered markings the renderer's ground family draws for a `runway` surface — and until now nothing
// stood on them. This file puts aeroplanes there: a body lofted from the same primitives the traffic cars
// are lofted from (no download, a whole fleet is a few thousand triangles of procedure), a body in
// physics/plane.js that flies on lift and drag rather than on a rail, and a dynamic handle the renderer
// already knows how to hold.
//
// The runways come out of the plan itself rather than out of a hardcoded coordinate: `runwaysFromPlan`
// walks the plan's own segment table for the roads whose surface is a runway, and gives back the
// centreline, the two thresholds, the length and the heading. That is what an aeroplane needs to be
// parked facing the right way, what the HUD needs to say which runway is in use, and what a landing needs
// to be judged against — touch down on the tarmac and it is a landing, touch down anywhere else and the
// legs are not up to it.
//
// The interface mirrors traffic's and the marina's on purpose — `nearestTo` for a hand on a ladder,
// `step` for the frame — because the door into an aeroplane is the same door as into a car or a boat, and
// game/boarding.js does not care what is on the other side of it.

import { MeshBuilder } from '../core/mesh.js';
import { Skin } from '../vehicles/traffic/skin.js';
import { lathe, box, rod, disc, cap, X, Y, Z } from '../vehicles/traffic/kit.js';
import * as mt from '../vehicles/traffic/materials.js';
import { planeSpec, createPlane, KNOT, FLAPS } from '../physics/plane.js';

/** Metres from a ladder to a hand, and how far off the threshold the apron parking sits. */
export const BOARD_REACH = 9, APRON_CAST = 96, APRON_SPACING = 54;
/** The fleet: one of each, because a flight school, a commuter and an executive jet is what a 1986
 *  American airport has standing on it, and each one flies differently. */
export const FLEET = Object.freeze([
  { airframe: 'trainer', livery: 'school', name: 'Paloma Flight School Trainer' },
  { airframe: 'commuter', livery: 'vice', name: 'Vice Interline Twin' },
  { airframe: 'jet', livery: 'escobar', name: 'Escobar Executive Jet' },
]);
/** Paint schemes: the fuselage, the stripe along it, and what the fin carries. */
const LIVERIES = Object.freeze({
  school: { body: [0.93, 0.93, 0.9], stripe: [0.78, 0.28, 0.14], fin: [0.78, 0.28, 0.14], wing: [0.9, 0.9, 0.87] },
  vice: { body: [0.9, 0.91, 0.92], stripe: [0.11, 0.46, 0.53], fin: [0.11, 0.46, 0.53], wing: [0.86, 0.87, 0.88] },
  escobar: { body: [0.86, 0.86, 0.88], stripe: [0.16, 0.17, 0.2], fin: [0.5, 0.11, 0.14], wing: [0.8, 0.8, 0.83] },
});
/**
 * The shape each airframe wears: where the wing sits, how far it is swept, what hangs off it and how
 * tall the tail is. Metres, in the body's own frame (+Z the nose, +X the port wing, +Y up). Exported
 * because a mesh is only as honest as the numbers it was built from, and a test that asserts a propeller
 * is the diameter `propR` says has to be able to read `propR`.
 */
export const SHAPES = Object.freeze({
  trainer: {
    radius: 0.62, wingY: 0.62, wingZ: 0.35, chord: 1.5, thickness: 0.16, sweep: 0.1, taper: 0.62,
    dihedral: 0.06, tailSpan: 3.3, tailChord: 0.95, finH: 1.5, finChord: 1.5, engine: 'prop',
    engines: 1, nacelle: 0, propR: 0.95, gearSpread: 1.15, window: [0.08, 0.32],
  },
  commuter: {
    radius: 1.05, wingY: -0.55, wingZ: 0.6, chord: 2.1, thickness: 0.24, sweep: 0.5, taper: 0.44,
    dihedral: 0.1, tailSpan: 5.2, tailChord: 1.5, finH: 2.9, finChord: 2.6, engine: 'prop',
    engines: 2, nacelle: 3.1, propR: 1.35, gearSpread: 1.5, window: [0.10, 0.66],
  },
  jet: {
    radius: 1.0, wingY: -0.35, wingZ: -0.6, chord: 2.6, thickness: 0.2, sweep: 3.4, taper: 0.3,
    dihedral: 0.14, tailSpan: 4.4, tailChord: 1.4, finH: 2.8, finChord: 2.4, engine: 'jet',
    engines: 2, nacelle: 2.0, propR: 0, gearSpread: 1.4, window: [0.12, 0.62],
    tailplane: 't',
  },
});

/**
 * The runways in a plan, read out of the plan's own segment table.
 * @param {{data?: object}|null} plan  planFromData's plan
 * @returns {Array<{id: string, name: string, x0: number, z0: number, x1: number, z1: number,
 *                  length: number, yaw: number, width: number, taxiway: boolean}>}
 */
export function runwaysFromPlan(plan) {
  const data = plan && plan.data;
  if (!data || !data.seg || !data.edge || !data.roads) return [];
  const { seg, edge, roads } = data;
  const byRoad = new Map();
  for (let i = 0; i < roads.length; i++) if (roads[i].runway) byRoad.set(i, []);
  if (!byRoad.size) return [];
  for (let e = 0; e < edge.seg0.length; e++) {
    const pts = byRoad.get(edge.road[e]);
    if (!pts) continue;
    const s0 = edge.seg0[e], n = edge.segN[e];
    for (let k = s0; k < s0 + n; k++) {
      pts.push([seg.ax[k], seg.az[k]]);
      pts.push([seg.ax[k] + seg.dx[k] * seg.len[k], seg.az[k] + seg.dz[k] * seg.len[k]]);
    }
  }
  const out = [];
  for (const [ri, pts] of byRoad) {
    if (pts.length < 4) continue;
    // The long axis: the pair of points furthest apart, found by projection onto the extremes rather
    // than by an O(n^2) search, which is the same trick a bounding box uses.
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cz += p[1]; }
    cx /= pts.length; cz /= pts.length;
    let ax = 1, az = 0, best = -1;
    for (const p of pts) {
      const d = Math.hypot(p[0] - cx, p[1] - cz);
      if (d > best) { best = d; ax = (p[0] - cx) / d; az = (p[1] - cz) / d; }
    }
    let lo = Infinity, hi = -Infinity, loP = pts[0], hiP = pts[0];
    for (const p of pts) {
      const t = (p[0] - cx) * ax + (p[1] - cz) * az;
      if (t < lo) { lo = t; loP = p; }
      if (t > hi) { hi = t; hiP = p; }
    }
    const length = hi - lo;
    if (length < 60) continue;                       // a stub of tarmac is not a runway
    const road = roads[ri];
    // The heading the numbers are painted for: 18-36 runs north-south, and `yaw 0` in this engine is +Z.
    const yaw = Math.atan2(hiP[0] - loP[0], hiP[1] - loP[1]);
    out.push({
      id: road.id, name: road.name || road.id, width: road.hw * 2, length, yaw,
      x0: loP[0], z0: loP[1], x1: hiP[0], z1: hiP[1],
      taxiway: /taxi/i.test(road.id) || /taxi/i.test(road.name || ''),
    });
  }
  // The longest strip first: that is the one in use, and the one a heavy aeroplane needs.
  return out.sort((a, b) => b.length - a.length);
}

/**
 * A game yaw as a compass bearing in degrees. The map is laid out with +X east and +Z *south* — that is
 * design/map/layout.json's own meta, and the reason a yaw of zero faces south and north is at 180, the
 * same offset the minimap painter uses to put north at the top of the disc. Getting this backwards is
 * invisible on a strip that runs north and south and plainly wrong on every other one, which is why the
 * test pins a runway whose name says 05-23 to the bearing its own geometry gives.
 */
export const compassDeg = (yawRad) => ((180 - (yawRad * 180) / Math.PI) % 360 + 360) % 360;

/** The runway designator a compass bearing is painted as: 18 for 180 degrees, 36 for north. */
export function designator(bearingDeg) {
  const d = Math.round((((bearingDeg % 360) + 360) % 360) / 10);
  return d === 0 ? '36' : String(d).padStart(2, '0');
}

/**
 * One aeroplane's body. The fuselage is a surface of revolution along the nose-to-tail axis, the wing and
 * the tail are lofted foils, the legs are rods with wheels on them, and what hangs off the wing is a
 * propeller disc or a jet pipe according to the airframe.
 * @param {object} spec      a planeSpec, for the span, the chord and where the legs reach
 * @param {object} shape     a SHAPES entry
 * @param {object} livery    a LIVERIES entry
 */
export function buildPlaneMesh(spec, shape, livery = LIVERIES.vice) {
  const mb = new MeshBuilder(4200);
  const sk = new Skin(mb);
  const L = spec.length, R = shape.radius;
  const body = mt.fixed(livery.body, false);
  const stripe = mt.fixed(livery.stripe, false);
  const wing = mt.fixed(livery.wing, false);
  const fin = mt.fixed(livery.fin, false);
  const dark = mt.trim(0.5, mt.hex ? mt.hex(0x24262a) : [0.14, 0.15, 0.16]);
  const glass = mt.glass([0.12, 0.16, 0.19]);
  const metal = mt.dullMetal;
  const rubber = mt.rubber;

  // ---- the fuselage, revolved about the nose-to-tail axis: +Z is the nose, so the axis runs back ----
  const noseZ = L * 0.36;
  const tailZ = noseZ - L;
  const rings = [];
  const N = 26;
  for (let i = 0; i <= N; i++) {
    const t = i / N;                       // 0 at the nose, 1 at the tail cone's end
    const z = noseZ - t * L;
    // Radius along the length: a blunt nose, a cabin, and a tail that runs out to a point.
    let r;
    if (t < 0.09) r = R * (0.3 + 0.7 * Math.sqrt(t / 0.09));
    else if (t < 0.62) r = R * (1 - 0.06 * Math.pow((t - 0.09) / 0.53, 2));
    else r = R * Math.pow(1 - (t - 0.62) / 0.38, 0.72) * 0.94;
    // The normal's axial lean follows the radius's own slope, so the tail cone is shaded as a cone.
    const dt = 1 / N;
    const rNext = (() => {
      const t2 = Math.min(1, t + dt);
      if (t2 < 0.09) return R * (0.3 + 0.7 * Math.sqrt(t2 / 0.09));
      if (t2 < 0.62) return R * (1 - 0.06 * Math.pow((t2 - 0.09) / 0.53, 2));
      return R * Math.pow(Math.max(0.001, 1 - (t2 - 0.62) / 0.38), 0.72) * 0.94;
    })();
    const slope = (rNext - r) / (dt * L);          // dr/dz, and z runs backwards
    const nl = Math.hypot(1, slope) || 1;
    // A stripe along the cabin, and the fin's own colour on the last of the tail cone.
    const wz0 = noseZ - shape.window[1] * L, wz1 = noseZ - shape.window[0] * L;
    const inWindow = z <= wz1 && z >= wz0;
    const m = t > 0.9 ? fin : (inWindow && t > 0.06 ? glass : (t > 0.34 && t < 0.4 ? stripe : body));
    rings.push({ r: Math.max(0.02, r), h: t * L, nr: 1 / nl, nh: slope / nl, m });
  }
  lathe(sk, body, [0, 0, noseZ], [0, 0, -1], X, Y, rings, 14);
  cap(sk, dark, [0, 0, noseZ + 0.02], Z, X, Y, rings[0].r * 0.94, 12);

  /**
   * A lofted foil: `stations` outlines from the root to the tip, each six points around a biconvex
   * section, joined into a closed skin and capped at the tip. This is how a wing, a tailplane and a fin
   * are all made, in one piece of code, because they are all the same shape stood in different frames:
   * `spanDir` is the way the panel runs and `thickDir` the way its section is thin, so a fin is a wing
   * that runs upwards and is thin sideways.
   */
  function foil(o) {
    const S = o.spanDir || [o.side === undefined ? 1 : o.side, 0, 0];
    const T = o.thickDir || Y;
    const stations = o.stations || 9;
    const rows = [];
    for (let i = 0; i <= stations; i++) {
      const t = i / stations;
      const c = o.chord * (1 + (o.taper - 1) * t);
      const th = o.thickness * (1 - 0.45 * t);
      const ox = o.x + S[0] * t * o.span;
      const oy = o.y + S[1] * t * o.span + (o.rise || 0) * t * o.span;
      const oz = o.z + S[2] * t * o.span - (o.sweep || 0) * t * o.span;
      // A point of the section: `pz` back along the chord from the leading edge, `pt` out along the
      // section's thin axis, and the normal given in the same two directions.
      const p = (pz, pt, nz, nt) => sk.raw(ox, oy + T[1] * pt, oz + pz,
        T[0] * nt, T[1] * nt, T[2] * nt + nz, pz, pt);
      // Six points: the leading edge, the crown, the trailing edge, and the same three underneath.
      rows.push([
        p(0, th * 0.22, 0.3, 1),
        p(-0.32 * c, th, 0.1, 1),
        p(-c, th * 0.1, -1, 0.4),
        p(-c, -th * 0.12, -1, -0.4),
        p(-0.38 * c, -th * 0.92, 0.1, -1),
        p(0, -th * 0.3, 0.3, -1),
      ]);
    }
    for (let i = 0; i < stations; i++) {
      for (let k = 0; k < 6; k++) {
        const k1 = (k + 1) % 6;
        sk.quad(rows[i][k], rows[i][k1], rows[i + 1][k1], rows[i + 1][k], o.material);
      }
    }
    const tip = rows[stations];
    sk.tri(tip[0], tip[2], tip[4], o.material);
    sk.tri(tip[0], tip[4], tip[5], o.material);
    sk.tri(tip[0], tip[1], tip[2], o.material);
    if (o.capRoot) {
      const root = rows[0];
      sk.tri(root[0], root[4], root[2], o.material);
      sk.tri(root[0], root[5], root[4], o.material);
      sk.tri(root[0], root[2], root[1], o.material);
    }
  }

  // ---- the mainplane, a panel a side, and the same foil again for the tailplane and the fin ----
  const halfSpan = spec.span / 2;
  for (const side of [-1, 1]) {
    foil({ side, span: halfSpan - 0.1, chord: shape.chord, thickness: shape.thickness, x: 0, z: shape.wingZ,
      y: shape.wingY, sweep: shape.sweep / Math.max(1, halfSpan), taper: shape.taper,
      rise: shape.dihedral / Math.max(1, halfSpan), material: wing, capRoot: false });
  }
  // The tail: the tailplane at the bottom of the fin on the props, and on top of it on the jet, where
  // a T-tail keeps the elevators out of the fuselage's own wake at a steep angle.
  const tailStation = tailZ + L * 0.055;
  const tailY = shape.tailplane === 't' ? shape.finH * 0.92 : 0.18;
  for (const side of [-1, 1]) {
    foil({ side, span: shape.tailSpan / 2, chord: shape.tailChord, thickness: shape.thickness * 0.7,
      x: 0, z: tailStation, y: tailY, sweep: 0.22 / Math.max(1, shape.tailSpan / 2), taper: 0.55,
      rise: 0.04, material: wing, capRoot: false });
  }
  // The fin: the same foil stood upright, thin sideways, swept back, in the stripe's own colour.
  foil({ span: shape.finH, chord: shape.finChord, thickness: shape.thickness * 0.55, spanDir: Y,
    thickDir: X, x: 0, z: tailStation - 0.1, y: R * 0.5, sweep: 0.5 / Math.max(1, shape.finH),
    taper: 0.34, material: fin, capRoot: false, stations: 7 });

  // ---- what hangs off it: a propeller's nacelle and disc, or a jet pipe at the back of the fuselage ----
  const nacelleY = shape.engine === 'jet' ? R * 0.15 : shape.wingY - shape.thickness * 0.6;
  for (let e = 0; e < shape.engines; e++) {
    const off = shape.engines === 1 ? 0 : (e === 0 ? -1 : 1) * shape.nacelle;
    if (shape.engine === 'jet') {
      const z0 = tailZ + L * 0.42, len = L * 0.3;
      lathe(sk, metal, [off, nacelleY, z0], [0, 0, -1], X, Y, [
        { r: 0.02, h: 0, nr: 0.2, nh: -1 }, { r: 0.44, h: len * 0.12, nr: 1, nh: 0.1 },
        { r: 0.5, h: len * 0.7, nr: 1, nh: 0 }, { r: 0.44, h: len, nr: 1, nh: -0.2 },
      ], 10);
      cap(sk, dark, [off, nacelleY, z0 - len - 0.02], [0, 0, -1], X, Y, 0.42, 10);
      disc(sk, glass, [off, nacelleY, z0 + 0.02], Z, X, Y, 0.4, 10);
    } else {
      const single = shape.engines === 1;
      const z0 = single ? noseZ : shape.wingZ + shape.chord * 0.35;
      const dir = single ? [0, 0, -1] : [0, 0, 1];     // a nose cowl runs back; a wing nacelle runs forward
      const len = single ? L * 0.22 : 1.5 + shape.propR * 0.5;
      const yy = single ? 0 : nacelleY;
      const prof = single
        ? [{ r: 0.3, h: 0, nr: 1, nh: 0.3 }, { r: 0.44, h: len * 0.35, nr: 1, nh: 0 },
           { r: 0.46, h: len * 0.8, nr: 1, nh: 0 }, { r: R * 0.82, h: len, nr: 1, nh: -0.3 }]
        : [{ r: 0.02, h: 0, nr: 0.2, nh: -1 }, { r: 0.34, h: len * 0.25, nr: 1, nh: 0.2 },
           { r: 0.36, h: len * 0.8, nr: 1, nh: 0 }, { r: 0.2, h: len, nr: 1, nh: -0.4 }];
      lathe(sk, body, [off, yy, z0], dir, X, Y, prof, 9);
      if (single) {
        // The spinner and the disc it turns: two blades, and a hub in front of the cowl.
        disc(sk, dark, [0, 0, noseZ + 0.06], Z, X, Y, 0.2, 10);
        for (const s of [-1, 1]) {
          box(sk, dark, [0, s * shape.propR * 0.55, noseZ + 0.12], [0.05, shape.propR * 0.5, 0.03], {});
        }
      } else {
        const pz = z0 + len * 0.62;
        // Two blades opposed about the nacelle's axis, built exactly as the nose spinner's pair is: the
        // sign is what puts one above the hub and one below it. Without it the loop drew the same blade
        // twice in the same place, so the twin turned a stub through its own cowl instead of a propeller
        // — twice the vertices for one box, and a disc half the diameter it was sized for.
        for (const s of [-1, 1]) {
          box(sk, dark, [off, nacelleY + s * shape.propR * 0.55, pz + 0.05], [0.04, shape.propR * 0.5, 0.03], {});
        }
        disc(sk, dark, [off, nacelleY, pz], Z, X, Y, 0.16, 8);
      }
    }
  }

  // ---- the legs: a strut each side and one under the nose, with a wheel on the end of each ----
  const gy = -spec.gearLength;
  for (const side of [-1, 1]) {
    const x = side * shape.gearSpread, zTop = shape.wingY < 0 ? shape.wingZ : 0.1;
    const yTop = shape.wingY < 0 ? shape.wingY - shape.thickness : -R * 0.75;
    rod(sk, metal, [x * 0.6, yTop, zTop], [x, gy + 0.22, zTop - 0.1], 0.05, 5, false);
    rod(sk, rubber, [x, gy + 0.22, zTop - 0.1], [x, gy + 0.22, zTop - 0.1], 0.22, 8, true);
    disc(sk, metal, [x + side * 0.06, gy + 0.22, zTop - 0.1], [side, 0, 0], Y, Z, 0.1, 8);
  }
  rod(sk, metal, [0, -R * 0.7, noseZ - L * 0.2], [0, gy + 0.18, noseZ - L * 0.17], 0.045, 5, false);
  rod(sk, rubber, [0, gy + 0.18, noseZ - L * 0.17], [0, gy + 0.18, noseZ - L * 0.17], 0.17, 8, true);

  // ---- the windows the fuselage loft did not carry: a dark band either side of the cabin ----
  const winAft = noseZ - shape.window[1] * L, winFwd = noseZ - shape.window[0] * L;
  for (const side of [-1, 1]) {
    box(sk, glass, [side * R * 0.94, R * 0.22, (winAft + winFwd) / 2],
      [0.05, R * 0.2, Math.abs(winFwd - winAft) / 2], {});
  }
  // Navigation lights: a red port, a green starboard, a white tail, all of them tiny and unlit by day.
  const redLamp = mt.fixed([0.6, 0.08, 0.1], true), greenLamp = mt.fixed([0.1, 0.55, 0.18], true);
  // A red port and a green starboard at the tips, which is the whole of a night's navigation: which way
  // an aeroplane is going is read off which light you can see. On this map the body's +X is its port side
  // — the same axis the roll and the bank are signed by — so red goes on +X and green on -X, and a pair
  // of them the wrong way round is the one lighting error a pilot will notice from two miles away.
  const tipY = shape.wingY + shape.dihedral * (halfSpan - 0.1);
  const tipZ = shape.wingZ - shape.sweep - shape.chord * 0.75;
  box(sk, redLamp, [halfSpan - 0.14, tipY, tipZ], [0.07, 0.06, 0.07], {});
  box(sk, greenLamp, [-halfSpan + 0.14, tipY, tipZ], [0.07, 0.06, 0.07], {});
  // The white tail light, at the top of the fin whichever way the tailplane is arranged.
  box(sk, body, [0, R * 0.5 + shape.finH + 0.04, tailStation - shape.finChord * 0.7], [0.05, 0.05, 0.05], {});

  return mb.finish();
}

/**
 * One strip, measured from one point.
 *
 * Which end is nearer decides which way a takeoff from here would go, and the number painted on that end
 * is the one a pilot is given: at the north threshold of a strip he is cleared for runway 18, at the south
 * one for 36. `onStrip` is whether the point is on the paving at all, because most of the airport is not,
 * and `remaining` is the tarmac left ahead of him, which is the whole of whether a takeoff is a good idea.
 * @param {object} strip  a runwaysFromPlan record
 * @param {number} x  metres east
 * @param {number} z  metres south
 */
function infoFor(strip, x, z) {
  const dx = strip.x1 - strip.x0, dz = strip.z1 - strip.z0;
  const len = Math.hypot(dx, dz) || 1;
  const t = Math.max(0, Math.min(1, ((x - strip.x0) * dx + (z - strip.z0) * dz) / (len * len)));
  const px = strip.x0 + dx * t, pz = strip.z0 + dz * t;
  const off = Math.hypot(x - px, z - pz);
  const d0 = (x - strip.x0) * (x - strip.x0) + (z - strip.z0) * (z - strip.z0);
  const d1 = (x - strip.x1) * (x - strip.x1) + (z - strip.z1) * (z - strip.z1);
  const fromStart = d0 <= d1;
  const bearing = compassDeg(Math.atan2(fromStart ? dx : -dx, fromStart ? dz : -dz));
  return {
    id: strip.id, name: strip.name, length: strip.length, width: strip.width,
    designator: designator(bearing), bearing, end: fromStart ? 0 : 1,
    distance: off, along: t * len, x: px, z: pz, onStrip: off < strip.width / 2,
    remaining: Math.max(0, (fromStart ? 1 - t : t) * len),
  };
}

/** The mesh for an airframe name, with the shape and the paint that go with it. */
export function planeMeshFor(airframe, livery) {
  const spec = planeSpec(airframe);
  const shape = SHAPES[airframe] || SHAPES.trainer;
  return buildPlaneMesh(spec, shape, LIVERIES[livery] || LIVERIES.vice);
}

/**
 * @param {{
 *   renderer?: object, plan?: object, seed?: number,
 *   ground?: (x: number, z: number) => number,      the land under the apron
 *   runways?: Array<object>,                        overrides what the plan says, for a test
 * }} deps
 */
export function createPlanes(deps = {}) {
  const renderer = deps.renderer || null;
  const ground = deps.ground || (() => 1.2);
  const plan = deps.plan || null;
  const runways = deps.runways || runwaysFromPlan(plan);
  const strip = runways.find((r) => !r.taxiway) || runways[0] || null;
  const fleet = [];

  // Where the fleet stands: off the threshold of the runway in use, on the side the apron is on, each
  // aeroplane facing down the strip it will take off from. With no runway in the plan (a test, or a map
  // that has none) they stand at the origin, which is where a test wants them.
  const park = strip
    ? { x: strip.x0, z: strip.z0, yaw: strip.yaw }
    : { x: 0, z: 0, yaw: 0 };
  const rx = Math.cos(park.yaw), rz = -Math.sin(park.yaw);       // across the strip, to the apron
  FLEET.forEach((entry, i) => {
    const spec = planeSpec(entry.airframe);
    const along = 60 + i * APRON_SPACING;
    const across = APRON_CAST + (i % 2 ? 16 : 0);
    const x = park.x + Math.sin(park.yaw) * along + rx * across;
    const z = park.z + Math.cos(park.yaw) * along + rz * across;
    const plane = createPlane(spec, { x, y: 0, z, yaw: park.yaw + Math.PI, ground });
    plane.refuel();
    let dynamic = null, handle = null;
    if (renderer) {
      try {
        handle = renderer.createMesh(buildPlaneMesh(spec, SHAPES[entry.airframe], LIVERIES[entry.livery]), { retain: false });
        dynamic = renderer.addDynamic({ mesh: handle, castShadow: true });
        writeMatrix(dynamic.matrix, plane);
      } catch (error) {
        console.error('An aeroplane could not be drawn; it will still fly, unseen', error);
      }
    }
    fleet.push({ id: i, name: entry.name, airframe: entry.airframe, tail: spec.tail, plane, dynamic, handle, taken: false });
  });

  const hangar = {
    /** What the fleet is, so a boarding branch and the panel can tell one machine from another. */
    kind: 'plane',
    planes: fleet,
    runways,
    /** The strip in use: the longest one that is not a taxiway. */
    get runway() { return strip; },
    get count() { return fleet.length; },
    get(id) { return fleet[id] || null; },

    /** The nearest aeroplane within reach of a ladder, in traffic's own shape. */
    nearestTo(x, z, reach = BOARD_REACH) {
      let best = null, bd = reach;
      for (const entry of fleet) {
        const d = Math.hypot(entry.plane.pos[0] - x, entry.plane.pos[2] - z);
        if (d < bd) { bd = d; best = entry; }
      }
      if (!best) return null;
      return {
        id: best.id, name: best.name, distance: bd,
        x: best.plane.pos[0], z: best.plane.pos[2], yaw: best.plane.yaw,
      };
    },

    /**
     * The nearest point of the runway in use, and how the aeroplane lies against it — which is what a
     * takeoff is judged on and what the HUD says when the strip is ahead.
     */
    runwayInfo(x, z) {
      if (!strip) return null;
      // The strip he is actually standing on, if he is standing on one, and the strip in use otherwise.
      // An airport with two runways has two of them for a reason: an aeroplane taxied onto the diagonal
      // one is lined up on that one and is told its number, and the panel falls back to the longest strip
      // only when there is no paving under him at all, which is still worth saying because it is how far
      // he is from one.
      let chosen = strip;
      for (const r of runways) {
        if (r.taxiway) continue;
        if (infoFor(r, x, z).onStrip) { chosen = r; break; }
      }
      return infoFor(chosen, x, z);
    },


    /**
     * What the panel says about the strip under him: the number painted on the end he is pointing at, and
     * how much tarmac is left to get airborne on. Null when he is not on a runway or is not pointing down
     * it, because a designator then would be a lie he might believe.
     */
    takeoffLabel(plane) {
      const info = hangar.runwayInfo(plane.pos[0], plane.pos[2]);
      if (!info || !info.onStrip) return null;
      // A strip has two numbers on it and an aeroplane can be pointed down either, so both ends are
      // offered and the first one he is lined up with is the one he is cleared for. Two things rule an
      // end out: being more than a quarter turn away from it, which is what an aeroplane taxiing across
      // a runway is, and having less than sixty metres of tarmac left down it, which is what an
      // aeroplane parked at the far threshold pointing off the paving is. Either way a number would be
      // a lie he might believe, so it says nothing.
      for (const back of [false, true]) {
        const bearing = back ? (info.bearing + 180) % 360 : info.bearing;
        if (Math.abs(((plane.heading - bearing + 540) % 360) - 180) >= 90) continue;
        const left = back ? info.length - info.remaining : info.remaining;
        if (left < 60) continue;
        return `${designator(bearing)} · ${Math.round(left)} m`;
      }
      return null;
    },

    /** One frame: the air argues with every aeroplane, and the drawn one follows its body. */
    step(dt, drivenId = -1, input = null) {
      for (const entry of fleet) {
        entry.plane.step(dt, entry.id === drivenId && input ? input : { throttle: 0 });
        if (entry.dynamic) writeMatrix(entry.dynamic.matrix, entry.plane);
      }
      return hangar;
    },

    /** Put an aeroplane back where it was parked: what a flight ends with, and what a test starts with. */
    reset(id) {
      const entry = fleet[id];
      if (!entry) return null;
      const p = entry.plane;
      p.place(p.pos[0], ground(p.pos[0], p.pos[2]) + p.spec.gearLength, p.pos[2], p.yaw);
      p.refuel();
      p.crashed = false;
      return entry;
    },

    dispose() {
      for (const entry of fleet) {
        if (entry.dynamic) entry.dynamic.remove();
        if (renderer && entry.handle >= 0) renderer.destroyMesh(entry.handle);
      }
      fleet.length = 0;
    },
  };
  return hangar;
}

/**
 * The dynamic's matrix from an aeroplane's attitude: the same three axes the physics flies by. `at`
 * puts it somewhere other than the airframe's own origin, which is how a chase camera's anchor or a
 * rider's saddle would be carried by the same rotation.
 */
export function writeMatrix(m, plane, at = null) {
  const [x, y, z, w] = plane.renderQuat;
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y - z * w); m[2] = 2 * (x * z + y * w); m[3] = 0;
  m[4] = 2 * (x * y + z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z - x * w); m[7] = 0;
  m[8] = 2 * (x * z - y * w); m[9] = 2 * (y * z + x * w); m[10] = 1 - 2 * (x * x + y * y); m[11] = 0;
  m[12] = at ? at[0] : plane.pos[0]; m[13] = at ? at[1] : plane.pos[1]; m[14] = at ? at[2] : plane.pos[2]; m[15] = 1;
}

/** Knots, for a HUD that reads like a panel rather than like a speedometer. */
export const toKnots = (mps) => mps / KNOT;

const FEET = 3.28084;

/**
 * The panel, in the units a pilot reads it in rather than the ones the physics keeps: knots, feet, feet
 * a minute, and degrees. This is the whole of what the instrument row of the HUD is given, so a flight
 * test can assert on the numbers a player sees rather than on the ones underneath them.
 * @param {object} plane  a body from physics/plane.js
 * @param {string|null} [runway]  the designator he is lined up with, when the fleet knows one
 */
export function planeInstruments(plane, runway = null) {
  return {
    kind: 'plane',
    ias: Math.round(plane.ias / KNOT),
    alt: Math.round(plane.altitude * FEET),
    vsi: Math.round(plane.vsi),
    heading: Math.round(plane.heading) % 360,
    throttle: Math.round(plane.input.throttle * 100),
    bank: Math.round(plane.roll * 180 / Math.PI),
    pitch: Math.round(plane.pitch * 180 / Math.PI),
    gear: !!plane.gearDown,
    flaps: FLAPS[plane.flaps] ? FLAPS[plane.flaps].deg : 0,
    runway,
    g: plane.gLoad,
    stalled: !!plane.stalled, overspeed: !!plane.overspeed,
    gearUnsafe: !!plane.gearUnsafe, crashed: !!plane.crashed,
    onGround: !!plane.onGround,
    stallSpeed: Math.round(plane.stallSpeed / KNOT),
    fuel: plane.fuelFraction,
  };
}
