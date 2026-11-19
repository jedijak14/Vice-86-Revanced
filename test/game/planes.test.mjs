// The hangar: the strips the map is paved with, the aeroplanes standing on them, and the panel that reads
// out what a pilot would read out.
//
// Nothing here builds a renderer or a page. The plan the real map produces is 2.4 seconds of work, so
// `runwaysFromPlan` is given the shape of a plan instead — the three arrays it reads — and the hangar is
// given the strips that come out of it. Both ends of that seam are then covered: what the pavement says,
// and what the game does with what the pavement says.
//
// The one thing worth holding on to while reading this file is that a game yaw is not a compass bearing.
// The map is laid out with +X east and +Z *south*, so yaw zero faces south and north is at yaw 180. A
// runway whose geometry says one thing and whose painted number says another is a bug that is invisible on
// a north-south strip and plainly wrong on every other one, which is why the diagonal strip below is
// asserted from its own geometry rather than from its name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_REACH, APRON_CAST, APRON_SPACING, FLEET,
  runwaysFromPlan, compassDeg, designator, createPlanes, planeMeshFor,
  writeMatrix, toKnots, planeInstruments,
} from '../../web/src/game/planes.js';
import { planeSpec, createPlane, AIRFRAMES, KNOT, basisFromAttitude } from '../../web/src/physics/plane.js';
import { VERTEX_STRIDE } from '../../web/src/core/ids.js';

const DEG = 180 / Math.PI;

/**
 * The shape of the part of a plan `runwaysFromPlan` reads: the roads, the edges that belong to them, and
 * the segments those edges are made of. A strip from one end to the other is two segments of it, which is
 * the fewest that gives four corners — the function wants four points before it will believe it has found
 * a rectangle rather than a stub of tarmac.
 */
function planWith(strips) {
  const roads = [], edge = { seg0: [], segN: [], road: [] };
  const ax = [], az = [], dx = [], dz = [], len = [];
  strips.forEach((s, i) => {
    roads.push({ id: s.id, name: s.name || s.id, hw: s.hw, runway: !!s.runway });
    const L = Math.hypot(s.x1 - s.x0, s.z1 - s.z0);
    const ux = (s.x1 - s.x0) / L, uz = (s.z1 - s.z0) / L;
    edge.seg0.push(ax.length); edge.segN.push(2); edge.road.push(i);
    for (const half of [0, 0.5]) {
      ax.push(s.x0 + ux * L * half); az.push(s.z0 + uz * L * half);
      dx.push(ux); dz.push(uz); len.push(L * 0.5);
    }
  });
  return { data: { roads, edge, seg: { ax, az, dx, dz, len } } };
}

/** Two strips, a taxiway and a street: an airport the size of the one the city already has. */
function airport() {
  return planWith([
    { id: 'surface_runway_18_36', name: 'Runway 18-36', hw: 22.5, runway: true, x0: 0, z0: 1000, x1: 0, z1: 0 },
    { id: 'surface_runway_05_23', name: 'Runway 05-23', hw: 22.5, runway: true, x0: -600, z0: 700, x1: -600 + 612.835554, z1: 700 + -514.230088 },
    { id: 'surface_taxiway_a', name: 'Taxiway A', hw: 18, runway: true, x0: 60, z0: 900, x1: 300, z1: 900 },
    { id: 'road_seawall', name: 'Ocean Drive', hw: 6, runway: false, x0: -900, z0: 300, x1: -400, z1: 300 },
  ]);
}

/** The positions and colours out of a finished mesh, decoded from the interleaved buffer it is packed in. */
function decode(mesh) {
  const out = [], view = new DataView(mesh.vertices), bytes = new Uint8Array(mesh.vertices);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * VERTEX_STRIDE;
    out.push({
      x: view.getFloat32(o, true), y: view.getFloat32(o + 4, true), z: view.getFloat32(o + 8, true),
      r: bytes[o + 20], g: bytes[o + 21], b: bytes[o + 22],
    });
  }
  return out;
}

test('a yaw is turned into a bearing the way the map is laid out, not the way it looks', () => {
  assert.equal(compassDeg(0), 180, 'yaw zero faces south on a map whose +Z is south');
  assert.equal(compassDeg(Math.PI), 0, 'and yaw 180 faces north');
  assert.equal(compassDeg(-Math.PI), 0, 'whichever way round the pi came out');
  assert.equal(compassDeg(Math.PI / 2), 90, 'yaw ninety is east');
  assert.equal(compassDeg(-Math.PI / 2), 270, 'and minus ninety is west');
  assert.equal(compassDeg(Math.PI * 3), 0, 'a heading does not run away past a turn');
  assert.equal(compassDeg(-Math.PI * 3), 0, 'nor the other way round');
  for (let d = 0; d < 360; d += 7) {
    assert.equal(Math.round(compassDeg(Math.PI - (d * Math.PI) / 180)), d, `a bearing of ${d} is the yaw that reads back as ${d}`);
  }
});

test('the number painted on the end of a strip is that end\'s bearing, to ten degrees', () => {
  assert.equal(designator(0), '36', 'north is 36, never 00 and never 360');
  assert.equal(designator(360), '36', 'and a full turn of degrees is the same end');
  assert.equal(designator(180), '18');
  assert.equal(designator(52), '05', 'a bearing is padded to two digits, because a strip is called zero five');
  assert.equal(designator(45), '05', 'and rounded to the nearest ten, which is how they are painted');
  assert.equal(designator(46), '05');
  assert.equal(designator(232), '23');
  assert.equal(designator(-90), '27', 'from a negative bearing as well');
  assert.equal(designator(451), '09', 'and from one that has run round more than once');
  for (let d = 0; d < 360; d++) {
    assert.match(designator(d), /^\d\d$/, `every designator is two digits: ${designator(d)}`);
    const other = designator((d + 180) % 360);
    assert.notEqual(designator(d), other, `the two ends of a strip are never called the same thing (${d} and ${(d + 180) % 360})`);
  }
});

test('the strips come out of a plan with their own lengths, widths and painted numbers', () => {
  const found = runwaysFromPlan(airport());
  assert.equal(found.length, 3, 'the three paved strips are found, and the street is not one of them');
  for (let i = 1; i < found.length; i++) {
    assert.ok(found[i - 1].length >= found[i].length, 'the list is ordered by length, longest strip first');
  }
  const long = found[0];
  assert.equal(long.id, 'surface_runway_18_36');
  assert.equal(long.name, 'Runway 18-36');
  assert.equal(Math.round(long.length), 1000, 'a strip from (0,1000) to (0,0) is 1000 m long');
  assert.equal(Math.round(long.width), 45, 'and a half-width of 22.5 is 45 m across, which is a real runway');
  assert.equal(long.taxiway, false);
  // The long axis is found by projection onto whichever end is furthest from the middle, so which of the
  // two ends a strip's `yaw` points at is not promised — a strip has two ends and either is a takeoff.
  // What is promised is the *pair* of numbers it is painted with, which is what its own name says.
  const pair = (r) => [designator(compassDeg(r.yaw)), designator((compassDeg(r.yaw) + 180) % 360)].sort().join('-');
  assert.equal(pair(long), '18-36', 'the pair on the north-south strip is the pair in its name');
  assert.ok(Math.abs(long.x0) < 1e-9 && Math.abs(long.z1 - 1000) < 1e-9, 'and its two ends are the two it was laid out between');

  // The diagonal strip is the test that matters. Its geometry says northeast, so its ends are 05 and 23.
  // A bearing taken straight from the yaw, without the map's own south-pointing axis, would have said 31
  // and 13 — the same numbers, the wrong way round, and the pavement still says 05-23.
  const diag = found.find((r) => r.id === 'surface_runway_05_23');
  const bearing = compassDeg(diag.yaw);
  assert.ok(Math.min(Math.abs(bearing - 50), Math.abs(bearing - 230)) < 0.5,
    `its axis is a bearing of ${bearing.toFixed(1)}, which is the northeast-southwest it was laid out on`);
  assert.equal(pair(diag), '05-23', 'so its ends are 05 and 23, and the name on the pavement says 05-23');
  assert.equal(Math.round(diag.length), 800, 'and it is 800 m long, on the diagonal it was laid out on');

  const taxi = found.find((r) => r.taxiway);
  assert.equal(taxi.id, 'surface_taxiway_a', 'the taxiway is found as well, and flagged as what it is');
  assert.equal(Math.round(taxi.width), 36, 'and is narrower than a runway');
  assert.equal(Math.round(taxi.length), 240, 'and 240 m long');

  assert.equal(runwaysFromPlan(null).length, 0, 'no plan is no strips, not a throw');
  assert.equal(runwaysFromPlan({}).length, 0, 'nor an empty one');
  assert.equal(runwaysFromPlan({ data: { roads: [], edge: null, seg: null } }).length, 0, 'nor a broken one');
  assert.equal(runwaysFromPlan(planWith([{ id: 'surface_runway_stub', hw: 20, runway: true, x0: 0, z0: 0, x1: 0, z1: 40 }])).length, 0,
    'and forty metres of tarmac is a stub, not a runway');
  assert.equal(runwaysFromPlan(planWith([{ id: 'road_only', hw: 6, runway: false, x0: 0, z0: 0, x1: 0, z1: 900 }])).length, 0,
    'a long street is still a street');
});

test('the fleet stands on the apron off the strip it will take off from', () => {
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  assert.equal(hangar.count, FLEET.length, 'one aeroplane for each entry in the fleet');
  assert.equal(hangar.kind, 'plane', 'and it says what it is');
  assert.equal(hangar.runway.id, 'surface_runway_18_36', 'the strip in use is the longest one');
  assert.equal(hangar.runways.length, 3, 'all three are kept, so an aeroplane can be taxied onto another');
  assert.equal(hangar.runway.taxiway, false, 'and the one in use is not a taxiway');

  const strip = hangar.runway;
  hangar.planes.forEach((entry, i) => {
    const p = entry.plane;
    assert.equal(entry.id, i, 'each aeroplane answers to its own index');
    assert.equal(entry.airframe, FLEET[i].airframe, `index ${i} is the ${FLEET[i].airframe}`);
    assert.ok(p.onGround, `${entry.name} is on the ground where it was parked`);
    assert.ok(p.fuelFraction > 0.99, `${entry.name} has a full tank, which is what a flight starts with`);
    assert.equal(p.crashed, false, 'and is not written off');
    assert.equal(entry.taken, false, 'and nobody has climbed into it');
    // Off the threshold, out on the apron, and facing down the strip it will leave on.
    const along = Math.hypot(p.pos[0] - strip.x0, p.pos[2] - strip.z0);
    assert.ok(along > 40, `${entry.name} stands ${along.toFixed(0)} m along from the threshold, clear of the numbers`);
    assert.ok(Math.abs(p.pos[0]) > APRON_CAST * 0.8, `${entry.name} is ${Math.abs(p.pos[0]).toFixed(0)} m off to the apron, and not on the tarmac`);
    const lined = ((compassDeg(p.yaw) - ((compassDeg(strip.yaw) + 180) % 360) + 540) % 360) - 180;
    assert.ok(Math.abs(lined) < 2, `${entry.name} faces down the strip, ${lined.toFixed(1)} degrees from lined up`);
    assert.ok(Math.abs(p.pos[1] - (1.2 + p.spec.gearLength)) < 1e-6, `and stands on its legs, ${(p.pos[1] - 1.2).toFixed(2)} m of undercarriage under it`);
    // On the apron and not on the runway, which is why the panel says nothing about a clearance yet: he
    // has to taxi on before there is a strip under him to be numbered.
    const info = hangar.runwayInfo(p.pos[0], p.pos[2]);
    assert.equal(info.onStrip, false, `${entry.name} is parked on the apron, ${info.distance.toFixed(0)} m off the paving`);
    assert.equal(hangar.takeoffLabel(p), null, 'so there is no runway to name for it yet');
  });

  // Spaced along the apron rather than stacked on one another, which is what makes it read as a ramp.
  for (let i = 1; i < hangar.planes.length; i++) {
    const a = hangar.planes[i - 1].plane, b = hangar.planes[i].plane;
    const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]);
    assert.ok(d > APRON_SPACING * 0.9, `they stand ${d.toFixed(0)} m apart, which is a ramp and not a stack`);
    assert.ok(d > Math.max(a.spec.span, b.spec.span), 'and further apart than either of their wingspans');
  }
  assert.ok(BOARD_REACH > 4, `the reach a man on foot needs to board one is ${BOARD_REACH} m, which is a ladder's length`);
  hangar.dispose();
  assert.equal(hangar.count, 0, 'and disposing the hangar empties the ramp');
});

test('a man on foot is offered the aeroplane he is standing next to, and not one across the apron', () => {
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  const first = hangar.planes[0].plane;
  assert.equal(hangar.nearestTo(first.pos[0], first.pos[2], BOARD_REACH).id, 0, 'standing at one offers it');
  assert.equal(hangar.nearestTo(first.pos[0] + 3, first.pos[2] + 3, BOARD_REACH).id, 0, 'and so does standing beside it');
  assert.equal(hangar.nearestTo(first.pos[0] + 400, first.pos[2] + 400, BOARD_REACH), null, 'four hundred metres away there is nothing to board');
  assert.equal(hangar.nearestTo(first.pos[0], first.pos[2], 1).id, 0, 'and standing right at one is inside even a one metre reach');
  assert.equal(hangar.nearestTo(first.pos[0] + APRON_SPACING, first.pos[2], BOARD_REACH), null,
    'the next aeroplane along the apron is not offered to a man standing at this one');
  const held = hangar.nearestTo(first.pos[0], first.pos[2], BOARD_REACH);
  assert.equal(held.name, FLEET[0].name, 'the aeroplane held out is named, which is what the prompt prints');
  assert.ok(held.distance >= 0 && held.distance < BOARD_REACH, `and reported as ${held.distance.toFixed(1)} m away`);
  assert.equal(hangar.get(0).name, held.name, 'and get() hands back the same aeroplane');
  assert.equal(hangar.get(99), null, 'an aeroplane it does not have is null, not a throw');
  hangar.dispose();
});

test('one frame steps every aeroplane, and only the one being flown is flown', () => {
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  const before = hangar.planes.map((e) => e.plane.distance);
  for (let t = 0; t < 1; t += 1 / 30) hangar.step(1 / 30, 1, { throttle: 1 });
  hangar.planes.forEach((entry, i) => {
    const moved = entry.plane.distance - before[i];
    if (i === 1) assert.ok(moved > 0.5, `the aeroplane being flown went ${moved.toFixed(1)} m in a second under full throttle`);
    else assert.ok(moved < 1e-9, `and the one at index ${i} did not move at all, with no throttle on it`);
  });
  // Stepping with nobody in the seat is what the frame loop does most of the time, and must not throw.
  hangar.step(1 / 30);
  hangar.step(1 / 30, -1, null);
  hangar.step(1 / 30, 99, { throttle: 1 });
  hangar.reset(1);
  const back = hangar.get(1).plane;
  assert.ok(back.onGround, 'the one that was flown is back on the ground');
  assert.equal(back.crashed, false, 'and is not written off any more');
  assert.ok(back.fuelFraction > 0.99, 'with a full tank again');
  assert.equal(hangar.reset(99), null, 'resetting an aeroplane it does not have is null');
  hangar.dispose();
});

test('what the pavement under him is called depends on which end he is nearest', () => {
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  const north = hangar.runwayInfo(0, 0);
  assert.ok(north.onStrip, 'the threshold itself is on the strip');
  assert.equal(Math.round(north.remaining), 1000, 'with the whole strip remaining down it');
  assert.equal(north.bearing, 180, 'so the bearing down that end is south');
  assert.equal(north.designator, '18', 'which is the number painted on it');
  const mid = hangar.runwayInfo(0, 500);
  assert.ok(mid.onStrip, 'halfway along is still on it');
  assert.equal(Math.round(mid.remaining), 500, 'with half of it remaining');
  assert.equal(Math.round(mid.along), 500, 'and half of it behind');
  const south = hangar.runwayInfo(0, 1000);
  assert.equal(south.designator, '36', 'the other threshold is the other end of the same strip');
  assert.equal(Math.round(south.remaining), 1000, 'with the whole strip remaining back up it');
  assert.equal(south.id, north.id, 'and it is the same strip, not another one');
  // Off the paving the panel still knows where the strip in use is, and says he is not on it, which is
  // what makes the label go quiet rather than guess.
  const off = hangar.runwayInfo(900, 900);
  assert.equal(off.onStrip, false, 'nine hundred metres east and south of it is not on a runway');
  assert.equal(off.id, 'surface_runway_18_36', 'and the strip it falls back to naming is the one in use');
  assert.ok(off.distance > 800, `${off.distance.toFixed(0)} m away, which is the honest answer`);
  assert.equal(hangar.runwayInfo(-900, 300).onStrip, false, 'and so is a place with only a street under it');
  // But an aeroplane taxied onto the other runway is on that runway, and is told its number.
  const diag = hangar.runwayInfo(-200, 380);
  assert.ok(diag.onStrip, 'a point on the diagonal strip is on it');
  assert.equal(diag.id, 'surface_runway_05_23', 'and it is the diagonal strip that is named, not the longer one');
  assert.ok(diag.designator === '05' || diag.designator === '23', `numbered from its own geometry: ${diag.designator}`);
  assert.ok(Math.round(diag.remaining) > 50 && Math.round(diag.remaining) < 800,
    `with ${Math.round(diag.remaining)} m of it left down the end he is nearer`);
  // And a taxiway is paving but not a runway, so it is not what the panel names a clearance for.
  assert.equal(hangar.runwayInfo(180, 900).id, 'surface_runway_18_36', 'on the taxiway it falls back to the strip in use');
  assert.equal(hangar.runwayInfo(180, 900).onStrip, false, 'and says he is not on it');
  hangar.dispose();
});

test('the panel names the strip he is cleared for, and says nothing when a name would be a lie', () => {
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  const spec = planeSpec('trainer');
  const p = createPlane(spec, { ground: () => 1.2 });
  const stand = (x, z, yaw, air = null) => p.place(x, 1.2 + spec.gearLength, z, yaw, air);
  // Yaw zero faces south on this map, which is the bearing the 18 end is painted with.
  stand(0, 0, 0);
  assert.equal(hangar.takeoffLabel(p), '18 · 1000 m', 'on the north threshold pointing down the strip is the whole of the strip');
  stand(0, 0, Math.PI);
  assert.equal(hangar.takeoffLabel(p), null, 'turned round on the threshold itself has the whole strip behind him and none ahead');
  stand(0, 500, 0);
  assert.equal(hangar.takeoffLabel(p), '18 · 500 m', 'halfway along is half of it left');
  stand(0, 500, Math.PI);
  assert.equal(hangar.takeoffLabel(p), '36 · 500 m', 'and halfway the other way is the other half');
  stand(0, 500, Math.PI / 2);
  assert.equal(hangar.takeoffLabel(p), null, 'an aeroplane taxiing across the strip is cleared for neither end of it');
  stand(0, 500, Math.PI / 4);
  assert.ok(hangar.takeoffLabel(p), 'but a forty-five degree turn onto it is a lining up, and says so');
  stand(0, 1000, Math.PI);
  assert.equal(hangar.takeoffLabel(p), '36 · 1000 m', 'at the south threshold pointing up the strip is the whole of it, the other way round');
  stand(0, 1000, 0);
  assert.equal(hangar.takeoffLabel(p), null, 'and pointing off the paving from there has nothing to take off on');
  stand(0, 960, 0);
  assert.equal(hangar.takeoffLabel(p), null, 'and forty metres of it is not a runway either');
  stand(900, 900, 0);
  assert.equal(hangar.takeoffLabel(p), null, 'off the airport altogether there is nothing to name');
  // In the air the label follows the aeroplane rather than the ground, which is what makes it worth
  // printing on a base leg: it stops being a clearance and becomes where he is.
  stand(0, 500, 0, 60);
  assert.equal(hangar.takeoffLabel(p), '18 · 500 m', 'four hundred metres over the strip it still says what is under him');
  hangar.dispose();
});

test('the hangar answers to what the frame loop calls it by', () => {
  // game.js reaches for these names from inside a branch that only runs when a man walks past an
  // aeroplane, which is exactly where a missing name would hide until somebody tried to fly one. The
  // aeroplanes fly in a test because physics/plane.test.mjs flies them; what is not exercised anywhere
  // else is the seam between the man on the tarmac and the aeroplane he climbs into.
  const hangar = createPlanes({ runways: runwaysFromPlan(airport()), ground: () => 1.2 });
  for (const name of ['nearestTo', 'runwayInfo', 'takeoffLabel', 'step', 'get', 'reset', 'dispose', 'planes', 'runways', 'runway', 'count', 'kind']) {
    assert.ok(name in hangar, `the hangar has a ${name}`);
  }
  for (const name of ['nearestTo', 'runwayInfo', 'takeoffLabel', 'step', 'get', 'reset', 'dispose']) {
    assert.equal(typeof hangar[name], 'function', `${name} is something that can be called`);
  }
  assert.ok(Array.isArray(hangar.planes), 'the fleet is a list');
  assert.ok(Array.isArray(hangar.runways), 'and so are the strips');
  // Built with no plan and no strips at all — which is what a map without an airport is — the hangar
  // still stands a fleet up somewhere, so the boarding code has an aeroplane to find.
  const bare = createPlanes({ ground: () => 1.2 });
  assert.equal(bare.count, FLEET.length, 'with no airport there are still aeroplanes');
  assert.equal(bare.runway, null, 'and no strip in use, so nothing is named');
  assert.equal(bare.runways.length, 0);
  assert.equal(bare.takeoffLabel(bare.planes[0].plane), null, 'and a panel that would have to guess says nothing');
  bare.dispose();
  hangar.dispose();
});

test('each airframe is drawn as the aeroplane it is, with its own size and its own engines', () => {
  const built = new Map();
  for (const kind of Object.keys(AIRFRAMES)) {
    const spec = planeSpec(kind);
    const mesh = planeMeshFor(kind);
    const tris = mesh.indexCount / 3;
    assert.ok(tris > 600, `${kind} is ${tris} triangles, which is an aeroplane and not a box`);
    assert.ok(tris < 4200, `and ${tris} is inside the budget it was built with`);
    assert.equal(mesh.groups.length, 2, `${kind} is drawn in two shader families: the body and the glass`);
    // A finished mesh reports its box as the three minimums and then the three maximums.
    const b = mesh.bounds;
    assert.equal(b.length, 6, `${kind} knows how big it is`);
    assert.ok(b[3] - b[0] > spec.span * 0.92, `${kind} is ${(b[3] - b[0]).toFixed(1)} m across for a ${spec.span} m span`);
    assert.ok(b[4] - b[1] < spec.span * 0.55, `${kind} is only ${(b[4] - b[1]).toFixed(1)} m tall, which is what a tail and an undercarriage make`);
    assert.ok(b[5] - b[2] > spec.span * 0.6, `${kind} is ${(b[5] - b[2]).toFixed(1)} m from nose to tail`);
    assert.ok(b[2] < 0 && b[5] > 0, 'with the nose along +Z and the tail behind the origin, which is the way the body flies');
    assert.ok(b[1] < 0, `and it stands on its legs: the lowest part of it is ${b[1].toFixed(2)} m below the origin`);
    built.set(kind, mesh);
    // A different livery is a different mesh, but the same aeroplane: same size, different paint.
    const painted = planeMeshFor(kind, 'escobar');
    assert.notEqual(painted, mesh, `${kind} in another livery is built again`);
    for (let i = 0; i < 6; i++) assert.ok(Math.abs(painted.bounds[i] - mesh.bounds[i]) < 1e-4, 'and is the same shape');
    const a = new Uint8Array(mesh.vertices), c = new Uint8Array(painted.vertices);
    let differs = 0;
    for (let i = 0; i < a.length; i += VERTEX_STRIDE) if (a[i + 20] !== c[i + 20] || a[i + 21] !== c[i + 21]) differs++;
    assert.ok(differs > 10, `${differs} of its vertices changed colour, which is what a livery is`);
  }
  // The three are not the same aeroplane painted differently: a jet is longer and lower than a trainer.
  const noseTo = (m) => m.bounds[5] - m.bounds[2];
  assert.ok(noseTo(built.get('jet')) > noseTo(built.get('trainer')), 'the jet is longer than the trainer');
  assert.ok(noseTo(built.get('commuter')) > noseTo(built.get('jet')), 'and the twin longer than either');
});

test('the navigation lights are on the sides the convention says they are', () => {
  // The body's +X is its port side on a map whose +Z is south — the same axis the roll and the bank are
  // signed by — so the red lamp belongs on +X and the green on -X. Red to port is the one lighting
  // arrangement a pilot reads from two miles away to tell which way an aeroplane is going, and a pair of
  // them the wrong way round would be invisible in every test that did not look at the colours.
  const mesh = planeMeshFor('trainer');
  const verts = decode(mesh);
  const red = verts.filter((v) => v.r === 153 && v.g === 20 && v.b === 26);
  const green = verts.filter((v) => v.r === 26 && v.g === 140 && v.b === 46);
  assert.ok(red.length >= 8, `${red.length} red vertices: the port lamp is drawn`);
  assert.ok(green.length >= 8, `${green.length} green vertices: the starboard lamp is drawn`);
  for (const v of red) assert.ok(v.x > 1, `the red lamp is on the port side, at x ${v.x.toFixed(2)}`);
  for (const v of green) assert.ok(v.x < -1, `and the green on the starboard, at x ${v.x.toFixed(2)}`);
  // And they sit at the tips, at the height the dihedral puts a tip at, near the back of the chord.
  const span = planeSpec('trainer').span;
  for (const v of red.concat(green)) {
    assert.ok(Math.abs(Math.abs(v.x) - span / 2) < 0.3, `${Math.abs(v.x).toFixed(2)} m out is the tip of a ${span} m wing`);
    assert.ok(v.z < 0, `and ${(v.z).toFixed(2)} m along is behind the nose, where a wing's trailing edge is`);
  }
});

test('the matrix it is drawn with is the attitude it is flying', () => {
  const spec = planeSpec('commuter');
  const p = createPlane(spec, { ground: () => 1.2 });
  p.place(-300, 900, 600, 0.6, 95);
  for (let i = 0; i < 60; i++) p.step(1 / 60, { throttle: 0.7, aileron: 0.3 });
  const m = new Float32Array(16);
  writeMatrix(m, p);
  for (const c of [0, 1, 2]) {
    const l = Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
    assert.ok(Math.abs(l - 1) < 1e-6, `column ${c} is a unit vector (${l.toFixed(9)})`);
    const r = Math.hypot(m[c], m[c + 4], m[c + 8]);
    assert.ok(Math.abs(r - 1) < 1e-6, `and so is row ${c} (${r.toFixed(9)})`);
  }
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  assert.ok(Math.abs(det - 1) < 1e-6, `and it is a rotation rather than a mirror: determinant ${det.toFixed(9)}`);
  assert.ok(Math.abs(m[12] - p.pos[0]) < 1e-3, 'with the aeroplane where it was put, to the float a matrix keeps');
  assert.ok(Math.abs(m[13] - p.pos[1]) < 1e-3);
  assert.ok(Math.abs(m[14] - p.pos[2]) < 1e-3);
  assert.equal(m[15], 1, 'and no perspective in it');
  assert.equal(m[3], 0); assert.equal(m[7], 0); assert.equal(m[11], 0);
  // The drawn axes are the flying ones. In this engine a matrix holds the three body axes as its *rows*
  // of components — m[0], m[1], m[2] are the x of the lateral, the up and the forward — which is the same
  // layout m4lookAt writes and physics/vehicle.js reads a car's basis back out of. If the drawn aeroplane
  // ever disagreed with the flying one about which way its nose was, this is where it would show.
  const axes = basisFromAttitude(p.yaw, p.pitch, p.roll);
  const names = ['lateral', 'up', 'forward'];
  const want = [axes.lateral, axes.up, axes.forward];
  for (let k = 0; k < 3; k++) {
    for (let w = 0; w < 3; w++) {
      assert.ok(Math.abs(m[k * 4 + w] - want[w][k]) < 1e-6,
        `m[${k * 4 + w}] is the ${['x', 'y', 'z'][k]} of the ${names[w]} axis, ${m[k * 4 + w].toFixed(4)} against ${want[w][k].toFixed(4)}`);
    }
  }
  assert.ok(Math.abs(m[12] - p.pos[0]) < 1e-3 && Math.abs(m[14] - p.pos[2]) < 1e-3, 'with the aeroplane where it is');
  // `at` carries the same rotation somewhere else, which is how a rider or a camera anchor is held.
  const m2 = new Float32Array(16);
  writeMatrix(m2, p, [1, 2, 3]);
  for (let i = 0; i < 12; i++) assert.equal(m2[i], m[i], 'the rotation is the same');
  assert.deepEqual([m2[12], m2[13], m2[14]], [1, 2, 3], 'and only the position is moved');
  assert.equal(m2[15], 1);
});

test('the instruments speak a pilot\'s units, and the ones that matter are the honest ones', () => {
  assert.ok(Math.abs(toKnots(KNOT) - 1) < 1e-9, 'a knot is a knot');
  assert.equal(toKnots(0), 0, 'and nothing is nothing');
  const spec = planeSpec('trainer');
  const p = createPlane(spec, { ground: () => 1.2 });
  p.place(0, 1.2 + spec.gearLength, 0, 0);
  let f = planeInstruments(p, '18 · 1000 m');
  assert.equal(f.kind, 'plane', 'the panel knows which machine it is reading');
  assert.equal(f.ias, 0, 'a parked aeroplane is not moving');
  assert.equal(f.vsi, 0, 'and is not going anywhere vertically');
  assert.equal(f.heading, 180, 'yaw zero on this map is a heading of 180');
  assert.equal(f.throttle, 0, 'with the throttle closed');
  assert.equal(f.bank, 0, 'the wings level');
  assert.equal(f.gear, true, 'and the gear down');
  assert.equal(f.flaps, 0, 'and the flaps up');
  assert.equal(f.runway, '18 · 1000 m', 'the label it was given, unchanged');
  assert.equal(f.onGround, true, 'on the ground');
  assert.equal(f.crashed, false, 'and in one piece');
  assert.ok(Math.abs(f.fuel - 1) < 1e-9, 'with a full tank');
  assert.equal(f.stallSpeed, Math.round(spec.stallSpeed / KNOT), 'and the stall speed on the panel is the aeroplane\'s own');
  assert.ok(f.alt >= 0 && f.alt < 20, `${f.alt} ft on the ground is the height of the undercarriage and nothing else`);
  assert.ok(Number.isInteger(f.ias) && Number.isInteger(f.alt) && Number.isInteger(f.vsi) && Number.isInteger(f.heading)
    && Number.isInteger(f.bank) && Number.isInteger(f.pitch) && Number.isInteger(f.stallSpeed),
    'every figure is a whole number, because a panel is read at a glance and not calculated');

  // North reads 000 on a compass and never 360, which is the sort of thing only a pilot would notice.
  const north = createPlane(spec, { ground: () => 1.2 });
  north.place(0, 1.2 + spec.gearLength, 0, Math.PI);
  assert.equal(planeInstruments(north).heading, 0, 'facing north reads 000');
  north.place(0, 1.2 + spec.gearLength, 0, Math.PI * 5);
  assert.equal(planeInstruments(north).heading, 0, 'and so does facing north five times round');
  north.place(0, 1.2 + spec.gearLength, 0, -Math.PI);
  assert.equal(planeInstruments(north).heading, 0, 'whichever way the pi came out');

  // In the air the numbers are knots, feet and feet a minute, read off the same body the physics flies.
  const air = createPlane(spec, { ground: () => 1.2 });
  air.place(0, 900, 0, 0, 62);
  for (let i = 0; i < 120; i++) air.step(1 / 60, { throttle: 0.72, elevator: 0.02 });
  f = planeInstruments(air, null);
  assert.ok(f.ias > 90 && f.ias < 160, `${f.ias} kt is what a trainer cruises at`);
  assert.ok(Math.abs(f.alt - air.altitude * 3.28084) < 1.5, `${f.alt} ft is its own ${air.altitude.toFixed(0)} m`);
  assert.equal(f.gear, !!air.gearDown, 'the gear light is the gear');
  assert.equal(f.bank, Math.round(air.roll * DEG), 'and the bank on the panel is the bank it is in');
  assert.equal(f.pitch, Math.round(air.pitch * DEG), 'as the pitch is');
  assert.ok(f.g > 0.9 && f.g < 1.15, `${f.g.toFixed(2)} g in level flight`);
  assert.equal(f.stalled, false, 'and it is not stalled');
  assert.equal(f.overspeed, false, 'nor over the never-exceed speed');
  assert.equal(f.runway, null, 'with no strip named, the panel says nothing rather than guess');
  air.flaps = 2;
  assert.equal(planeInstruments(air).flaps, 32, 'and a flap lever of two is thirty-two degrees');
  // A stalled aeroplane says so, because that is the whole of the warning being worth printing.
  const stalled = createPlane(spec, { ground: () => 1.2 });
  stalled.place(0, 2000, 0, 0, 34);
  for (let i = 0; i < 240; i++) stalled.step(1 / 60, { throttle: 0.2, elevator: 0.8 });
  const sf = planeInstruments(stalled);
  assert.ok(sf.stalled || sf.vsi < -500, `it is either called stalled or the panel shows ${sf.vsi} fpm of it going down`);
});
