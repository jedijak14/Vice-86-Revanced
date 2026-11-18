// Docks and airport prototypes.
//
//   container_a / container_b  20 ft and 40 ft boxes: long axis X, doors at +X, body colour from the instance tint
//                              (enamel palette), operator's mark as a decal. Stack them 2.591 m apart.
//   crane_dock                 ship-to-shore gantry. Rails run along X. The origin is on the WATERSIDE rail, midway
//                              between the legs; the boom reaches +Z over the water, the landside rail is at z = -22.
//   tank_a                     white storage tank with a spiral stair
//   pallet_stack / _b          loaded pallet; a pile of empty pallets
//   runway_light / _taxi       elevated edge lights (white, blue). They burn steadily, so they are on the STREET
//                              channel; CHANNEL.AVIATION blinks and is used for the crane's obstruction lamps.

import { CHANNEL } from '../../core/ids.js';
import { hash01, fbm2 } from '../../core/math.js';
import { place, vmad } from './kit.js';
import { C, SOURCE, srgb, times, luminaire, railing, signPlate, rectOutline } from './common.js';
import { signRect } from './atlas.js';

const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- shipping container
function container(k, L, seed) {
  const hx = L / 2, hz = 1.219, H = 2.591, rail = 0.16, body = () => k.steel(C.white, 0.6, 0.4).tintKey(), wallZ = hz - 0.02, deep = 0.036;
  body();
  const shell = k.mark();
  if (k.near) {
    // corrugated walls: trapezoid ribs at 0.28 m on both sides and the closed end; the door end stays flat
    const pitch = 0.28, ribs = (len) => Math.max(2, Math.round(len / pitch)), prof = [];
    const run = (from, to, at, out) => {           // from/to along the wall, `at(s)` -> [z, x] on the crest line, out = +1 / -1 scale of the recess
      const count = ribs(Math.abs(to - from)), step = (to - from) / count;
      for (let i = 0; i < count; i++) for (const [f, d] of [[0, 1], [0.357, 1], [0.482, 0], [0.875, 0]]) prof.push(at(from + step * (i + f), d * deep * out));
      prof.push(at(to, deep * out));
    };
    run(-hx + rail, hx - rail, (s, d) => [wallZ - d, s], 1);                    // +Z side, towards +X
    prof.push([wallZ - deep, hx - 0.03], [-wallZ + deep, hx - 0.03]);            // door end, flat
    run(hx - rail, -hx + rail, (s, d) => [-wallZ + d, s], 1);                   // -Z side, back towards -X
    run(-wallZ + rail, wallZ - rail, (s, d) => [s, -hx + 0.02 + d], 1);         // closed end
    k.extrude(prof, [0, rail, 0], Z, X, H - 2 * rail, { caps: false, crease: 25 });
  } else k.box(-hx + 0.03, rail, -wallZ + 0.01, hx - 0.03, H - rail, wallZ - 0.01, { axis: 'x' });
  k.under(shell, H - rail, 0.25, 0.3).ground(shell, 0.4, 0.3, rail);
  // frame: bottom and top rails, corner posts, roof and floor
  const frame = k.mark();
  if (k.lod < 2) {
    for (const [y0, y1] of [[0, rail], [H - rail, H]]) {
      for (const sz of [-1, 1]) k.box(-hx, y0, Math.min(sz * hz, sz * (hz - 0.1)), hx, y1, Math.max(sz * hz, sz * (hz - 0.1)), { axis: 'x' });
      for (const sx of [-1, 1]) k.box(Math.min(sx * hx, sx * (hx - 0.1)), y0, -hz + 0.1, Math.max(sx * hx, sx * (hx - 0.1)), y1, hz - 0.1, { axis: 'z' });
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.box(Math.min(sx * hx, sx * (hx - 0.14)), rail, Math.min(sz * hz, sz * (hz - 0.14)), Math.max(sx * hx, sx * (hx - 0.14)), H - rail, Math.max(sz * hz, sz * (hz - 0.14)));
    k.quad([-hx + 0.1, H - 0.03, hz - 0.1], [hx - 0.1, H - 0.03, hz - 0.1], [hx - 0.1, H - 0.03, -hz + 0.1], [-hx + 0.1, H - 0.03, -hz + 0.1]);
    k.quad([-hx + 0.1, 0.03, -hz + 0.1], [hx - 0.1, 0.03, -hz + 0.1], [hx - 0.1, 0.03, hz - 0.1], [-hx + 0.1, 0.03, hz - 0.1]);
  } else k.box(-hx, 0, -hz, hx, H, hz, { axis: 'x' });
  k.ground(frame, 0.3, 0.35);
  if (k.lod === 2) return;
  // doors: two leaves, four lock rods with handles, hinges
  const xd = hx - 0.03;
  body();
  for (const sz of [-1, 1]) k.box(xd, rail + 0.02, Math.min(sz * 0.012, sz * (hz - 0.15)), xd + 0.022, H - rail - 0.02, Math.max(sz * 0.012, sz * (hz - 0.15)));
  if (k.mid) {
    k.bare(2, 0.55, C.galv);
    for (const z of [-0.82, -0.3, 0.3, 0.82]) {
      k.cyl([xd + 0.045, rail - 0.02, z], [xd + 0.045, H - rail + 0.02, z], 0.017, 0.017, k.n(8, 4), { capA: true, capB: true });
      if (k.near) { k.box(xd + 0.03, 1.02, z - 0.04, xd + 0.075, 1.1, z + 0.2); for (const y of [0.55, 1.75]) k.box(xd + 0.02, y - 0.04, z - 0.045, xd + 0.07, y + 0.04, z + 0.045); }
    }
  }
  if (k.near) {
    // corner castings, left in dark primer
    k.steel([0.2, 0.2, 0.2], 0.7, 0.5);
    const castings = k.mark();
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
      const x0 = sx * hx, z0 = sz * hz, y0 = sy ? H - 0.118 : 0;
      k.box(Math.min(x0 + sx * 0.004, x0 - sx * 0.178), y0, Math.min(z0 + sz * 0.004, z0 - sz * 0.162), Math.max(x0 + sx * 0.004, x0 - sx * 0.178), y0 + 0.12, Math.max(z0 + sz * 0.004, z0 - sz * 0.162));
    }
    k.ground(castings, 0.12, 0.5);
  }
  // operator's mark on both long sides: a decal, so the body colour shows through around the lettering
  const rect = signRect('container', seed), w = Math.min(2.6, L * 0.4), h = w / rect.aspect;
  for (const sz of [-1, 1]) {
    k.signFace(1, CHANNEL.ALWAYS, 0.6).tintKey();
    k.panel([sz * (hx - rail - 0.25 - w / 2), H - rail - 0.3 - h / 2, sz * (wallZ + 0.004)], [sz, 0, 0], Y, w, h, rect.uv);
  }
}

// ---------------------------------------------------------------- quay crane
function crane(k) {
  const gauge = 22, legX = 8.5, zs = [0, -gauge], girderY = 30, girderH = 3, gx = 2.75, boomZ = 36, backZ = -gauge - 14, apex = [0, 56, -5.5];
  const frame = () => k.steel([0.78, 0.8, 0.8], 0.55, 0.3), boom = () => k.steel(C.craneBlue, 0.55, 0.3), dark = () => k.steel(C.darkSteel, 0.6, 0.4);
  // bogies with buffers, legs
  for (const z of zs) for (const sx of [-1, 1]) {
    dark();
    const b = k.mark();
    k.box(sx * legX - 3, 0.25, z - 0.5, sx * legX + 3, 1.25, z + 0.5, { axis: 'x' });
    if (k.mid) {
      // a wheel is a polygon at a distance, and a polygon may rest on a flat or stand on a corner: build the four,
      // then lower them until the lowest point of the tread is on the rail
      const wheels = k.mark();
      for (let i = 0; i < 4; i++) { const x = sx * legX - 2.25 + i * 1.5; k.cyl([x, 0.38, z - 0.56], [x, 0.38, z + 0.56], 0.38, 0.38, k.n(12, 6), { capA: true, capB: true }); }
      let low = Infinity;
      for (let v = wheels.v; v < k.b.count; v++) low = Math.min(low, k.b.pos[v * 3 + 1]);
      for (let v = wheels.v; v < k.b.count; v++) k.b.pos[v * 3 + 1] -= low;
    }
    else k.box(sx * legX - 2.8, 0, z - 0.45, sx * legX + 2.8, 0.25, z + 0.45, { axis: 'x' });
    k.ground(b, 0.5, 0.5);
    if (k.mid) { k.paint(C.safetyYellow, 0.5, 0.4); for (const e of [-1, 1]) k.box(sx * legX + e * 3 - 0.06, 0.35, z - 0.52, sx * legX + e * 3 + 0.06, 1.2, z + 0.52); }
    frame();
    const leg = k.mark();
    k.box(sx * legX - 0.65, 1.25, z - 0.65, sx * legX + 0.65, girderY - 1.4, z + 0.65, { stops: [0.1, 0.5] });
    k.ground(leg, 2.5, 0.35, 1.25);
  }
  frame();
  const portal = k.mark();
  for (const z of zs) {
    k.box(-legX - 0.65, 12.2, z - 0.6, legX + 0.65, 13.8, z + 0.6, { axis: 'x' });                 // sill beams
    k.box(-legX - 0.65, girderY - 1.4, z - 0.6, legX + 0.65, girderY, z + 0.6, { axis: 'x' });     // portal beams under the girders
  }
  for (const sx of [-1, 1]) {
    k.box(sx * legX - 0.5, 12.3, -gauge + 0.6, sx * legX + 0.5, 13.7, -0.6, { axis: 'z' });        // side ties
    k.bar([sx * legX, 13.8, -0.4], [sx * legX, girderY - 1.5, -gauge + 0.4], 0.7, 0.7, { up: Y });    // side diagonal
  }
  k.under(portal, girderY, 2, 0.25);
  // twin box girders: landside girder and backreach in the frame colour, the boom beyond the hinge in the terminal's colour
  for (const sx of [-1, 1]) {
    frame(); k.box(sx * gx - 0.5, girderY, backZ, sx * gx + 0.5, girderY + girderH, 0, { axis: 'z', stops: [0.5] });
    boom(); k.box(sx * gx - 0.5, girderY, 0.15, sx * gx + 0.5, girderY + girderH, boomZ, { axis: 'z', stops: [0.5] });
  }
  for (let z = backZ + 1; z <= boomZ - 0.5; z += 8.9) { if (z > 0) boom(); else frame(); k.box(-gx + 0.5, girderY + 0.8, z - 0.3, gx - 0.5, girderY + girderH - 0.6, z + 0.3, { axis: 'x' }); }
  // A-frame, stays
  frame();
  for (const sx of [-1, 1]) {
    k.bar([sx * gx, girderY + girderH, 0], [sx * gx, apex[1], apex[2]], 0.9, 0.9, { up: Z });
    k.bar([sx * gx, girderY + girderH, -gauge], [sx * gx, apex[1], apex[2]], 0.9, 0.9, { up: Y });
    if (k.mid) k.bar([sx * gx, girderY + girderH + 11.5, -2.75], [sx * gx, girderY + girderH + 11.5, -13.5], 0.6, 0.6, { up: Y });
  }
  k.box(-gx - 0.45, apex[1] - 0.6, apex[2] - 0.6, gx + 0.45, apex[1] + 0.6, apex[2] + 0.6, { axis: 'x' });
  dark();
  const stayN = k.mid ? 5 : 3;
  for (const sx of [-1, 1]) {
    for (const z of [12, 24, boomZ - 1]) k.cyl([sx * gx, apex[1], apex[2]], [sx * gx, girderY + girderH, z], 0.11, 0.11, stayN);
    k.cyl([sx * gx, apex[1], apex[2]], [sx * gx, girderY + girderH, backZ + 1], 0.13, 0.13, stayN);
  }
  // machinery house over the landside legs
  k.steel([0.8, 0.81, 0.79], 0.6, 0.35);
  const house = k.mark();
  k.box(-3.2, girderY + girderH, -gauge - 7.5, 3.2, girderY + girderH + 5, -gauge + 6.5, { axis: 'z', stops: [0.5] });
  k.ground(house, 1.2, 0.3, girderY + girderH);
  k.roof([0.4, 0.42, 0.44], 2, 0.4); k.box(-3.35, girderY + girderH + 5, -gauge - 7.65, 3.35, girderY + girderH + 5.2, -gauge + 6.65, { axis: 'z' });
  if (k.mid) {
    dark(); k.box(3.2, girderY + girderH + 0.05, -gauge - 1, 3.24, girderY + girderH + 2.1, -gauge);                                                // door
    k.darkGlass([0.07, 0.09, 0.1], 0.1, 0.5); for (const z of [-gauge - 5, -gauge + 3]) k.box(3.2, girderY + girderH + 2.4, z, 3.23, girderY + girderH + 3.6, z + 2);
  }
  // trolley, operator's cab, spreader on its falls
  const tz = 9;
  dark(); k.box(-2.6, girderY - 0.8, tz - 3, 2.6, girderY - 0.05, tz + 3, { axis: 'x' });
  k.paint(C.white, 0.5, 0.35);
  const cab = k.mark();
  k.box(1.2, girderY - 3.3, tz + 1.2, 3.2, girderY - 0.8, tz + 3.2);
  k.under(cab, girderY - 0.8, 0.8, 0.35);
  if (k.mid) { k.darkGlass([0.06, 0.09, 0.11], 0.08, 0.6); k.box(1.17, girderY - 2.5, tz + 1.17, 3.23, girderY - 1.3, tz + 3.23); }
  const sy = 17.5;
  k.paint(C.safetyYellow, 0.55, 0.45);
  for (const z of [-1.22, 1.22]) k.box(-6.1, sy, tz + z - 0.12, 6.1, sy + 0.3, tz + z + 0.12, { axis: 'x' });
  for (const x of [-6.1, -2, 2, 6.1]) k.box(x - 0.12, sy, tz - 1.22, x + 0.12, sy + 0.3, tz + 1.22, { axis: 'z' });
  k.box(-1.6, sy + 0.3, tz - 1.0, 1.6, sy + 1.2, tz + 1.0, { axis: 'x' });                                     // headblock
  dark();
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) k.cyl([sx * 1.4, sy + 1.2, tz + sz * 0.8], [sx * 2.2, girderY - 0.8, tz + sz * 2.4], 0.035, 0.035, 3);
  if (k.mid) {
    // stair tower up one landside leg (zig-zag flights with landings), walkway along the boom
    k.bare(2, 0.6, C.galv);
    const sx0 = legX + 0.65, flights = 8, rise = (girderY - 1.25) / flights;
    for (let f = 0; f < flights; f++) {
      const y0 = 1.25 + f * rise, dir = f % 2 ? -1 : 1, za = -gauge - dir * 1.6, zb = -gauge + dir * 1.6;
      k.bar([sx0 + 0.55, y0 + 0.05, za], [sx0 + 0.55, y0 + rise - 0.05, zb], 0.9, 0.1, { up: Y });
      k.box(sx0, y0 + rise - 0.1, zb - 0.6 + (dir > 0 ? 0.3 : -0.3), sx0 + 1.05, y0 + rise, zb + 0.6 + (dir > 0 ? 0.3 : -0.3));
      if (k.near) k.cyl([sx0 + 1.02, y0 + 1.1, za], [sx0 + 1.02, y0 + rise + 1.0, zb], 0.025, 0.025, 4);
    }
    k.box(gx + 0.5, girderY + 1.0, backZ + 0.5, gx + 1.3, girderY + 1.06, boomZ - 0.5, { axis: 'z' });
    railing(k, [[gx + 1.27, girderY + 1.06, backZ + 0.5], [gx + 1.27, girderY + 1.06, boomZ - 0.5]], { height: 1.1, r: 0.025, postEvery: 4.5, mids: k.near ? 1 : 0, n: 4 });
  }
  // working floods under the girders: every fitting has a lens and a glow; two of them carry the light records
  const floods = [[-gx, backZ + 6], [gx, -11], [-gx, 10], [gx, 22], [-gx, 33]];
  floods.forEach(([x, z], i) => {
    dark(); k.box(x - 0.35, girderY - 0.3, z - 0.25, x + 0.35, girderY, z + 0.25);
    k.lens(srgb(SOURCE.halide), 60); k.box(x - 0.3, girderY - 0.33, z - 0.2, x + 0.3, girderY - 0.3, z + 0.2);
    const pos = [x, girderY - 0.33, z];
    if (i === 1 || i === 2) luminaire(k, pos, SOURCE.halide, { power: 3200, radius: 46, radiance: 60, size: 2.4, kind: 1, spot: { axis: [0, -1, 0], outerDeg: 62, innerDeg: 35 }, seed: 0.3 + 0.2 * i });
    else k.glows.push({ pos, size: 2.4, color: times(SOURCE.halide, 60), channel: CHANNEL.STREET, kind: 1 });
  });
  // red obstruction lamps at the apex and the boom tip (glow only: they mark the crane, they do not light it)
  for (const p of [[0, apex[1] + 0.6, apex[2]], [gx, girderY + girderH, boomZ - 0.3]]) {
    dark(); k.cyl(p, vmad(p, Y, 0.12), 0.1, 0.1, 8);
    k.lens(srgb(SOURCE.aviationRed), 40, CHANNEL.AVIATION);
    k.lathe(vmad(p, Y, 0.12), Y, [[0, 0.09], [0.16, 0.09], [0.22, 0.05], [0.24, 0]], k.n(10, 6), { crease: 50 });
    k.glows.push({ pos: vmad(p, Y, 0.24), size: 1.6, color: times(SOURCE.aviationRed, 40), channel: CHANNEL.AVIATION, kind: 0 });
  }
}

// ---------------------------------------------------------------- storage tank
function tank(k) {
  const R = 6, H = 11, n = k.n(40, 12), white = [0.8, 0.79, 0.745];        // white that has stood in salt air for years
  k.concrete(C.concrete, 0, 0.5);
  const base = k.mark();
  k.lathe([0, 0, 0], Y, [[0, R + 0.35], [0.3, R + 0.35], [0.3, R - 0.1]], n, { crease: 40 });
  k.ground(base, 0.3, 0.4);
  // shell in plate courses (each ring of plates has weathered a little differently), shallow cone roof
  const shell = k.mark(), courses = k.mid ? 5 : 1;
  for (let c = 0; c < courses; c++) {
    const y0 = 0.3 + (H - 0.3) * c / courses, y1 = 0.3 + (H - 0.3) * (c + 1) / courses, t = 0.96 + 0.04 * hash01(c, 77);
    k.steel([white[0] * t, white[1] * t, white[2] * t], 0.6, 0.45 + 0.25 * hash01(c, 78), c);
    // each course laps over the one below (a closed lip, so no gap opens between rings); the extra ring on the
    // lowest course keeps the splash-zone staining near the ground instead of smearing it up the whole plate
    const prof = c ? [[y0, R], [y0, R + 0.012], [y0 + 0.03, R], [y1, R]] : [[y0, R], [Math.min(1.3, y1 - 0.1), R], [y1, R]];
    if (!c && courses === 1) prof.splice(2, 0, [2.6, R]);
    k.lathe([0, 0, 0], Y, prof, n, { crease: 60 });
  }
  // every lap seam weeps: rust runs start under each seam and under the roof's edge and thin out down the plate
  const course = (H - 0.3) / courses;
  k.ground(shell, 1.0, 0.3, 0.3).grime(shell, (x, y) => 0.22 * Math.max(0, 1 - (y - 0.3) / 0.9), C.rust)
    .grime(shell, (x, y, z) => {
      const c = Math.min(courses - 1, Math.max(0, Math.floor((y - 0.3) / course - 1e-4))), top = 0.3 + (c + 1) * course;
      const run = Math.max(0, fbm2(Math.atan2(x, z) * 7 + c * 17, c * 3.1, 3, 41) - 0.34) * 2.4 * (c === courses - 1 ? 1.5 : 1);
      return Math.min(0.8, run * Math.max(0, 1 - (top - y) / course) + 0.12);
    }, [0.36, 0.22, 0.12]);
  k.steel([white[0] * 0.95, white[1] * 0.95, white[2] * 0.94], 0.65, 0.6);
  // the roof overhangs the shell; the profile starts on the shell so the overhang has an underside
  k.lathe([0, 0, 0], Y, [[H - 0.05, R], [H - 0.05, R + 0.06], [H + 0.03, R + 0.06], [H + 0.65, 0.4], [H + 0.65, 0]], n, { crease: 30 });
  k.lathe([0, H + 0.65, 0], Y, [[0, 0.22], [0.35, 0.22], [0.4, 0.3], [0.5, 0.3], [0.55, 0]], k.n(12, 6), { crease: 40 });      // roof vent, kept at every level: it is the top of the silhouette
  // rail round the roof edge
  k.steel(C.safetyYellow, 0.55, 0.35);
  const ring = [], segs = k.n(24, 8); for (let i = 0; i <= segs; i++) { const a = i / segs * TAU; ring.push([Math.sin(a) * (R - 0.05), H + 0.05, Math.cos(a) * (R - 0.05)]); }
  if (k.mid) railing(k, ring, { height: 1.1, r: 0.03, postEvery: 4, mids: k.near ? 1 : 0, n: 4 });
  // spiral stair from the ground at the front (+Z) round to the roof
  const rs = R + 0.5, pitchA = 35 * Math.PI / 180, sweep = (H - 0.3) / Math.tan(pitchA) / rs, at = (t, rad, dy = 0) => { const a = t * sweep; return [Math.sin(a) * rad, 0.3 + (H - 0.3) * t + dy, Math.cos(a) * rad]; };
  const steps = k.n(26, 6);
  k.bare(2, 0.6, C.galv);
  const stair = k.mark(), rows = [[], []];
  for (let i = 0; i <= steps; i++) { rows[0].push(at(i / steps, R + 0.9)); rows[1].push(at(i / steps, R + 0.08)); }
  k.loft(rows, { crease: 80, uv: (i, j) => [j, i] });
  k.twoSided(stair, null, 0.06);
  k.shade(stair, (x, y, z) => 0.75 + 0.25 * Math.min(1, (Math.hypot(x, z) - R) / 0.6));
  if (k.mid) {
    const railPts = []; for (let i = 0; i <= steps; i++) railPts.push(at(i / steps, R + 0.87, 0.03));
    k.steel(C.safetyYellow, 0.55, 0.35);
    railing(k, railPts, { height: 1.0, r: 0.025, postEvery: 2.2, mids: k.near ? 1 : 0, n: 4 });
    k.bare(2, 0.6, C.galv);
    for (let i = 2; i < steps; i += 4) { const p = at(i / steps, R + 0.5, -0.06), q = at(i / steps, R - 0.02, -1.0); q[1] = Math.max(q[1], 0.4); k.bar(p, q, 0.06, 0.06, { up: Y }); }        // brackets back to the shell
  }
  if (k.near) {
    // manhole with a bolted cover
    k.steel(white, 0.6, 0.4); k.lathe([R - 0.05, 1.0, 0], X, [[0, 0.42], [0.2, 0.42], [0.2, 0.36], [0.24, 0.36], [0.24, 0]], 16, { crease: 40 });
  }
  // outlet pipe with its valve wheel; the stub stays at every level so the outline does not jump between them
  k.steel([0.3, 0.32, 0.33], 0.6, 0.45);
  k.cyl([-R + 0.1, 0.55, 1.2], [-R - 0.9, 0.55, 1.2], 0.11, 0.11, k.n(10, 5), { capB: true });
  if (k.near) k.lathe([-R - 0.5, 0.55, 1.2], Y, [[0.1, 0.03], [0.3, 0.03], [0.3, 0.16], [0.33, 0.16], [0.33, 0]], 10, { crease: 40 });
}

// ---------------------------------------------------------------- pallets
/** One timber pallet 1.2 x 1.0 x 0.144 with its base on y. */
function pallet(k, y, yaw = 0, dx = 0, dz = 0) {
  const p = k.child();
  p.wood([0.66, 0.56, 0.42], 0.9, 0.6);
  if (p.near) {
    // rough-sawn boards: their arrises are sharp, and a pile of eight pallets is 104 of them
    for (const z of [-0.45, 0, 0.45]) p.box(-0.6, 0.022, z - 0.05, 0.6, 0.122, z + 0.05, { axis: 'x', r: 0 });             // bearers
    for (let i = 0; i < 7; i++) { const x = -0.55 + i * 0.1833; p.box(x - 0.05, 0.122, -0.5, x + 0.05, 0.144, 0.5, { axis: 'z', r: 0 }); }
    for (const x of [-0.55, 0, 0.55]) p.box(x - 0.05, 0, -0.5, x + 0.05, 0.022, 0.5, { axis: 'z', r: 0 });
    p.shade({ v: 0 }, (px, py) => (py < 0.12 ? 0.6 : 1));
  } else p.box(-0.6, 0, -0.5, 0.6, 0.144, 0.5, { axis: 'x' });
  k.add(p, place(dx, y, dz, yaw));
}
function palletLoad(k) {
  pallet(k, 0);
  // three layers of cartons, each layer shifted a little as hand stacking leaves them
  const m = k.mark(), carton = [0.62, 0.5, 0.36];
  for (let layer = 0; layer < 3; layer++) for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    const id = layer * 4 + i * 2 + j, t = 0.92 + 0.12 * hash01(id, 11), jx = (hash01(id, 12) - 0.5) * 0.03, jz = (hash01(id, 13) - 0.5) * 0.03, y0 = 0.144 + layer * 0.38;
    if (layer === 2 && id === 11) continue;                                              // one carton already taken off the top
    k.paint([carton[0] * t, carton[1] * t, carton[2] * t], 0.85, 0.45, id);
    k.box(-0.59 + i * 0.595 + jx, y0, -0.49 + j * 0.495 + jz, -0.59 + i * 0.595 + 0.585 + jx, y0 + 0.378, -0.49 + j * 0.495 + 0.485 + jz, { r: k.near ? 0.008 : 0 });
    if (k.near) { k.paint([0.78, 0.7, 0.55], 0.6, 0.3); k.box(-0.59 + i * 0.595 + jx + 0.2, y0 + 0.378, -0.49 + j * 0.495 + jz, -0.59 + i * 0.595 + jx + 0.26, y0 + 0.38, -0.49 + j * 0.495 + 0.485 + jz); }   // tape
  }
  k.ground(m, 0.2, 0.3, 0.144);
}
function palletPile(k) {
  for (let i = 0; i < 8; i++) pallet(k, i * 0.146, (hash01(i, 21) - 0.5) * 0.12, (hash01(i, 22) - 0.5) * 0.05, (hash01(i, 23) - 0.5) * 0.05);
}

// ---------------------------------------------------------------- runway and taxiway edge lights
function edgeLight(k, source, radiance, power, glowSize) {
  const n = k.n(12, 6);
  k.concrete(C.concreteDark, 0, 0.4);
  const m = k.mark();
  k.lathe([0, 0, 0], Y, [[0, 0.17], [0.012, 0.17], [0.012, 0]], n, { crease: 40 });                                  // base plate, almost flush
  k.steel(C.safetyYellow, 0.5, 0.3);
  k.lathe([0, 0.012, 0], Y, [[0, 0.03], [0.035, 0.03], [0.045, 0.02], [0.2, 0.02], [0.215, 0.05], [0.26, 0.062], [0.265, 0.05]], n, { crease: 40 });   // frangible coupling, stem, lamp holder
  k.ground(m, 0.1, 0.4);
  k.lens(srgb(source), radiance, CHANNEL.STREET);
  k.lathe([0, 0.275, 0], Y, [[0, 0.052], [0.05, 0.056], [0.09, 0.045], [0.115, 0.02], [0.12, 0]], n, { crease: 60 });
  // Edge lights are made to be seen, not to light the apron: the lens is bright but the light record is weak and
  // short, so it only picks out the base plate and the nearest paint, instead of blowing out whatever stands beside it.
  luminaire(k, [0, 0.34, 0], source, { power, radius: 5, radiance, size: glowSize, kind: 1, seed: 0.5 });
}

const stack = (name, build, hy) => ({ name, build, far: [30, 110], footprint: 0.85, collider: { kind: 'box', hx: 0.6, hy, hz: 0.5 }, tags: ['dock', 'small'] });
const box = (name, L, seed) => ({ name, build: (k) => container(k, L, seed), length: L, far: [60, 220, 900], footprint: L / 2 + 0.2, collider: { kind: 'box', hx: L / 2, hy: 1.2955, hz: 1.219 }, tags: ['dock', 'large', 'tall', 'tint'], extra: { stackHeight: 2.591 } });

export const DOCKS = [
  box('container_a', 6.058, 3),
  box('container_b', 12.192, 8),
  { name: 'crane_dock', far: [160, 520, 2600], footprint: 13.5, tags: ['dock', 'large', 'tall', 'lit'], build: crane,
    // Nothing stands at the origin (vehicles drive between the legs), so there is no main collider: the four legs
    // are extra colliders, each a box standing on the ground at its offset.
    collider: null,
    extra: { gauge: 22, outreach: 36, backreach: 36, extraColliders: [[-8.5, 0], [8.5, 0], [-8.5, -22], [8.5, -22]].map(([x, z]) => ({ kind: 'box', hx: 0.7, hy: 15, hz: 0.7, offset: [x, 0, z] })) } },
  { name: 'tank_a', far: [120, 420, 1800], footprint: 7.2, collider: { kind: 'cylinder', radius: 6.1, height: 11.6 }, tags: ['dock', 'large', 'tall'], build: tank },
  stack('pallet_stack', palletLoad, 0.62),
  stack('pallet_stack_b', palletPile, 0.58),
  { name: 'runway_light', far: [25, 90], footprint: 0.2, collider: null, tags: ['airport', 'lamp', 'small', 'lit'], build: (k) => edgeLight(k, SOURCE.runwayWhite, 40, 8, 0.9) },
  { name: 'runway_light_taxi', far: [25, 90], footprint: 0.2, collider: null, tags: ['airport', 'lamp', 'small', 'lit'], build: (k) => edgeLight(k, SOURCE.taxiBlue, 30, 4, 0.7) },
];
