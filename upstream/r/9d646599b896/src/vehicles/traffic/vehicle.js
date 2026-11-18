// Assembles one vehicle at one level of detail from its description (see specs.js): body shells, lamp
// panels, brightwork, interior and, for the far level, stand-in wheels. Also derives the anchors, which use
// the very records that placed the lamp geometry.

import { MeshBuilder } from '../../core/mesh.js';
import { Skin } from './skin.js';
import { lowerShell, cabinShell, emitShells, mirrorInto, QUALITY } from './body.js';
import { endPanel, headlampLenses, lampCells, sealedBeam, panelDividers, grilleBars, clusterFrame, bumper, sideStrip, doorHandle, emblem, fillerDoor, aerial, bonnetOrnament, tailBadge, mudFlap, doorMirror, sideMarker, plate, exhaust, wiper } from './parts.js';
import { furnish, driverFittings } from './interior.js';
import { farWheel } from './wheels.js';
import * as mt from './materials.js';

const mirrorX = (v) => [-v[0], v[1], v[2]];
const DIP = [0, -Math.sin(3 * Math.PI / 180), Math.cos(3 * Math.PI / 180)];   // headlamps aim three degrees below level
const centroid = (list) => list.reduce((a, c) => [a[0] + c[0] / list.length, a[1] + c[1] / list.length, a[2] + c[2] / list.length], [0, 0, 0]);

/**
 * Build level `lv` of vehicle description p. Returns { body, glass } (MeshBuilders holding both sides) and the anchors.
 */
export function buildVehicle(p, lv) {
  const q = { ...QUALITY[lv], ...(p.quality ? p.quality[lv] : null) }, lower = p.makeLower ? p.makeLower(p, lv) : lowerShell(p), cab = p.cabin ? cabinShell(p, lower) : null;
  // A description may give its lamp panels per level (the bus gives up the small segments far away).
  const perLevel = (v) => (typeof v === 'function' ? v(lv) : v);
  const front = p.front ? endPanel(lower, 1, perLevel(p.front), 'fp') : [], rear = (perLevel(p.rear) || []).map((r, k) => endPanel(lower, -1, r, 'rp' + k));
  const L = { head: [], tail: [], brake: [], reverse: [], indF: [], indR: [] };
  const ctx = { p, lv, q, lower, cab, front, rear: [...rear], lamps: L, exhausts: [], shells: [] };
  if (p.setup) p.setup(ctx);
  // A body that is its own cabin (the bus) is lined inside at the nearest level, where its glass is clear enough to see in.
  const shells = [{ shell: lower, liner: lv === 0 ? p.lowerLiner : null }];
  if (cab) shells.push({ shell: cab, liner: mt.interior(2, p.headlining || [0.62, 0.6, 0.56]) });
  const half = emitShells([...shells, ...ctx.shells], q), sk = new Skin(half.body);
  ctx.sk = sk; ctx.half = half;

  // ---- lamps: geometry and records together
  const note = (kind, pos) => {
    if (kind === 'brake') { L.brake.push(pos); L.tail.push(pos); } else if (kind === 'tail') L.tail.push(pos); else if (kind === 'rev') L.reverse.push(pos);
    else if (kind === 'ind') (pos[2] > 0 ? L.indF : L.indR).push(pos);
  };
  ctx.note = note;
  for (const panel of [front, ...ctx.rear]) {
    for (const g of panel) {
      // Only the outer lamp of a pair is the dipped beam, so only it lights the road.
      if (g.kind === 'lamps') headlampLenses(g).forEach((lens, k) => { sealedBeam(sk, lens, lv); if (k === 0) L.head.push(lens.c); });
      if (g.cells) for (const c of lampCells(sk, g, g.cells, lv)) note(c.kind, c.pos); else note(g.kind, g.pos);
      grilleBars(sk, g, lv);
    }
    panelDividers(sk, panel, lv);
    if (panel !== front) clusterFrame(sk, panel, lv);
  }

  // ---- brightwork on the left half
  const arches = (p.archZ || [p.wheelbase / 2, -p.wheelbase / 2]).map((z) => ({ z, y: p.wheelR, r: p.archR + 0.05 }));
  if (p.bumperF) bumper(sk, { half: p.W / 2, ...p.bumperF }, 1, p.nose, lv);
  if (p.bumperR) bumper(sk, { half: p.W / 2, ...p.bumperR }, -1, p.tail, lv);
  for (const s of p.strips || []) if ((s.lod ?? 1) >= lv) sideStrip(sk, s.mat, s.cabin ? cab : lower, typeof s.y === 'function' ? (z) => s.y(z, s.cabin ? cab : lower) : () => s.y, s.z0 ?? lower.zR + 0.1, s.z1 ?? lower.zF - 0.1, { arches: s.cabin ? [] : arches, ...s });
  (p.handles || []).forEach((d, k) => doorHandle(sk, lower, d.z, d.y, lv, k === 0));
  if (lv === 0) for (const e of p.emblems || []) emblem(sk, e.cabin ? cab : lower, e);
  if (lv < 2) for (const f of p.mudFlaps || []) mudFlap(sk, f.c, f.w, f.h);
  if (p.mirror) doorMirror(sk, p.mirror.at, lv, p.mirror.mat);
  for (const m of p.markers || []) sideMarker(sk, lower, m.z, m.y, m.color, lv, m.w, m.h);
  // The cabin is furnished from the driver's eye point and the shells it has to fit inside.
  const room = p.interior && cab ? { xIn: cab.base(p.eye[2]) - 0.085, belt: lower.topSeam(p.eye[2]), zFront: cab.footF - 0.25, zBack: cab.footR + 0.06, floor: p.sillY + 0.05, eye: p.eye, ...p.interior } : null;
  if (room) { room.wells = lower.arches.map((a) => ({ z0: a.z - a.radius - 0.03, z1: a.z + a.radius + 0.03, x: a.xin, top: a.y + a.radius + 0.03 })); room.rows = room.rows.map((r) => ({ ...r, z: p.eye[2] + r.dz })); if (room.shelf === true) room.shelf = room.belt - 0.03; if (room.wallDz != null) { room.wall = p.eye[2] + room.wallDz; room.wallTop = room.wallTop ?? p.eye[1] + 0.2; room.wallX = cab.def.side(room.wall, room.wallTop) - 0.04; } furnish(sk, room, lv); }
  if (p.halfParts) p.halfParts(ctx);

  // ---- both sides, then the parts that exist once
  const body = new MeshBuilder(8192), glass = new MeshBuilder(1024);
  mirrorInto(body, half.body); mirrorInto(glass, half.glass);
  const skC = new Skin(body); ctx.skC = skC; ctx.skG = new Skin(glass);
  let plateAt = null;
  if (p.plate) {
    const host = p.plate.on === 'bumper' ? null : ctx[p.plate.on] || lower;
    plateAt = [0, p.plate.y, (p.plate.z ?? (host ? host.bandAt(host.faceS(-1, p.plate.y), 0)[2] : p.tail)) - 0.012];
    plate(skC, plateAt, p.seed, lv);
  }
  for (const e of p.exhausts || []) ctx.exhausts.push(exhaust(skC, e.x, e.y, e.z0, e.z1, lv));
  if (room) driverFittings(skC, room, lv);
  // Fittings that a car has on one side or in the middle only.
  const onTop = (x, z) => { const P = lower.bandAt(lower.topS(z), Math.abs(x)); return [x, P[1], P[2]]; };
  if (p.filler && lv === 0) fillerDoor(skC, lower, p.filler.z, p.filler.y);
  // The mast stops just short of the roof line, so the stated height and the collider stay true.
  if (p.aerial && lv < 2) { const foot = onTop(p.aerial.x, p.aerial.z); aerial(skC, foot, lv, Math.min(0.78, (p.H - 0.01 - foot[1]) / 0.985)); }
  if (p.ornament && lv < 2) bonnetOrnament(skC, onTop(0, p.ornament), lv);
  if (p.tailBadge && lv === 0) tailBadge(skC, rear[0][rear[0].length - 1]);
  if (lv === 0 && cab && p.wipers) {
    // Both blades park pointing the same way, so they cannot be mirrored.
    const s = cab.faceS(1, cab.sillY(cab.footF - 0.12) + 0.03), at = (x) => { const P = cab.bandAt(s, Math.abs(x)); return { p: [x, P[1], P[2]], n: [Math.sign(x) * P[3], P[4], P[5]] }; };
    for (const [x0, x1] of p.wipers) { const a = at(x0), b = at(x1); wiper(skC, a.p, b.p, a.n, [x0, a.p[1] - 0.03, a.p[2] + 0.05]); }
  }
  if (p.centreParts) p.centreParts(ctx);
  const rR = p.wheelsRear ? p.wheelsRear.R : p.wheels.R, h = { l: 1, r: -1 };
  const wheelAt = { fl: [p.trackF / 2, p.wheels.R, p.wheelbase / 2], fr: [-p.trackF / 2, p.wheels.R, p.wheelbase / 2], rl: [p.trackR / 2, rR, -p.wheelbase / 2], rr: [-p.trackR / 2, rR, -p.wheelbase / 2] };
  if (lv === 2) {
    // The far level has no separate wheels; dark drums with a lighter centre are baked into the body.
    for (const [k, c] of Object.entries(wheelAt)) {
      const w = k[0] === 'r' && p.wheelsRear ? p.wheelsRear : p.wheels, bright = w.style === 'steel' || w.style === 'truck' ? mt.rim(w.color || [0.3, 0.3, 0.3], 0.5, 0.3) : mt.argent;
      farWheel(skC, c, c[1], (w.dual ? 2.1 : 1) * w.w, w.rimR, h[k[1]], bright);
    }
  }

  const pair = (list) => (list.length ? [{ pos: centroid(list) }, { pos: mirrorX(centroid(list)) }] : []);
  const indF = centroid(L.indF.length ? L.indF : L.head), indR = centroid(L.indR.length ? L.indR : L.brake);
  const anchors = {
    wheels: wheelAt,
    headlamps: L.head.flatMap((c) => [{ pos: c.slice(), dir: DIP.slice() }, { pos: mirrorX(c), dir: DIP.slice() }]),
    tailLamps: pair(L.tail), brakeLamps: pair(L.brake), reverseLamps: pair(L.reverse),
    indicators: { fl: indF, fr: mirrorX(indF), rl: indR, rr: mirrorX(indR) },
    exhausts: ctx.exhausts, plateFront: null, plateRear: plateAt,
    driverEye: p.eye.slice(), centreOfMass: [0, p.clearance + (p.H - p.clearance) * 0.36, (p.nose + p.tail) / 2 + (p.massBias ?? 0.15)],
  };
  return { body, glass, anchors };
}
