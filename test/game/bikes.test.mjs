// The bike rack: twelve machines on the kerbs of a city, what a man on foot is offered when he walks past
// one, and what the panel reads out once he is on it.
//
// The machines are placed against a real lane graph, built over the smallest road that is still a road,
// because the whole of what game.js does with the rack is ask a lane where its kerb is. Physics is covered
// by test/physics/bike.test.mjs; what is covered here is the seam between the man on the pavement and the
// machine he takes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_REACH, KERB_CAST, RIDER_HIP, PARKED, BIKES,
  buildBikeMesh, createBikes, writeMatrix, bikeInstruments,
} from '../../web/src/game/bikes.js';
import { bikeSpec, createBike } from '../../web/src/physics/bike.js';
import { basisFromAttitude } from '../../web/src/physics/plane.js';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';
import { VERTEX_STRIDE } from '../../web/src/core/ids.js';

const DEG = 180 / Math.PI, LAND = 1.2;

/** A road that is long enough to have a kerb worth parking on, and nothing else. */
function street() {
  return prepareLaneGraph({
    lanes: [{ pts: [0, 0, 0, 0, 0, 400], next: [], speedLimit: 13.4, width: 7 }],
    junctions: [],
  });
}

function rack(deps = {}) {
  return createBikes({ graph: street(), ground: () => LAND, seed: 11, ...deps });
}

test('the kerb it parks on is the kerb of a road, and not the middle of it', () => {
  const r = rack();
  assert.equal(r.kind, 'bike', 'the rack says what it holds');
  assert.equal(r.count, PARKED.length, `one machine for each of the ${PARKED.length} places in the list`);
  for (const entry of r.bikes) {
    const b = entry.bike;
    // The lane runs up the z axis at x = 0 with a width of 7 m, so its kerb is 3.5 m out and the machine
    // stands a cast beyond that. On the road itself would be a machine waiting to be run over.
    assert.ok(Math.abs(Math.abs(b.pos[0]) - (3.5 + KERB_CAST)) < 0.6,
      `${entry.kind} stands ${Math.abs(b.pos[0]).toFixed(2)} m off the centreline of a 7 m road`);
    assert.ok(Math.abs(b.pos[0]) > 3.5, 'which is off the carriageway, where a parked machine belongs');
    assert.ok(b.pos[2] > 2 && b.pos[2] < 398, `and ${b.pos[2].toFixed(0)} m along it, within the road rather than past its end`);
    assert.ok(Math.abs(b.pos[1] - LAND) < 1e-9, 'on the ground it is standing on');
    assert.ok(Math.abs(b.yaw) < 1e-9 || Math.abs(Math.abs(b.yaw) - Math.PI) < 1e-9,
      'facing along the road one way or the other, which is how anything is parked on it');
    assert.ok(b.footDown, 'with a foot down, because it is parked');
    assert.equal(b.fallen, false, 'and standing up');
    assert.ok(b.fuelKg > b.spec.tank * 0.49 && b.fuelKg <= b.spec.tank,
      `${entry.kind} has ${b.fuelKg.toFixed(1)} of ${b.spec.tank} L: somebody left it part full`);
    assert.equal(entry.taken, false, 'and nobody has it');
    assert.equal(entry.name, b.spec.name, 'named for the machine it is');
    assert.ok(Array.isArray(entry.paint) && entry.paint.length === 3, 'with a paint of its own');
  }
  r.dispose();
  assert.equal(r.count, 0, 'and disposing it empties the kerb');
});

test('the kerb is not one machine copied twelve times', () => {
  const r = rack();
  const kinds = new Set(r.bikes.map((e) => e.kind));
  assert.ok(kinds.size >= 2, `${[...kinds].join(', ')} are on the street, which is what a city has`);
  assert.equal(r.bikes.filter((e) => e.kind === 'scooter').length > 1, true, 'and more than one scooter');
  // Same kind, different colours: the paint is baked into the vertices, so a kerb of six scooters in one
  // colour is a kerb somebody copied, and this is the assertion that would catch it.
  const scooters = r.bikes.filter((e) => e.kind === 'scooter');
  const colours = new Set(scooters.map((e) => e.paint.join(',')));
  assert.ok(colours.size >= 2, `${colours.size} different colours among ${scooters.length} scooters`);
  // And they are not all in the same place.
  const spots = new Set(r.bikes.map((e) => `${Math.round(e.bike.pos[0])},${Math.round(e.bike.pos[2])}`));
  assert.ok(spots.size >= r.count * 0.6, `${spots.size} distinct kerb spots for ${r.count} machines`);
  // A different seed is a different street. On one road there is only one kerb to stand on, so what the
  // seed changes here is the paint and how much is left in the tank — which on a city of a hundred roads
  // is also which roads they are standing on, and that is the part a player sees.
  const other = rack({ seed: 12 });
  const repainted = other.bikes.filter((e, i) => e.paint.join(',') !== r.bikes[i].paint.join(',')).length;
  const refuelled = other.bikes.filter((e, i) => Math.abs(e.bike.fuelKg - r.bikes[i].bike.fuelKg) > 0.05).length;
  assert.ok(repainted > 0, `${repainted} machines are a different colour with a different seed`);
  assert.ok(refuelled > 0, `and ${refuelled} have a different amount left in the tank`);
  other.dispose();
  r.dispose();
});

test('a man on foot is offered the machine he is standing next to, and not one up the street', () => {
  const r = rack();
  const first = r.bikes[0].bike;
  assert.equal(r.nearestTo(first.pos[0], first.pos[2], BOARD_REACH).id, 0, 'standing at one offers it');
  assert.equal(r.nearestTo(first.pos[0] + 1, first.pos[2], BOARD_REACH).id, 0, 'and so does standing a metre off it');
  assert.equal(r.nearestTo(first.pos[0] + 300, first.pos[2] + 300, BOARD_REACH), null, 'three hundred metres up the street there is nothing to take');
  assert.ok(BOARD_REACH < 4, `the reach a hand needs is ${BOARD_REACH} m, which is an arm and a step, not a ladder`);
  assert.ok(BOARD_REACH > 1.5, 'and long enough to reach a machine he is standing beside');
  const held = r.nearestTo(first.pos[0], first.pos[2], BOARD_REACH);
  assert.equal(held.name, first.spec.name, 'named, because that is what the prompt prints');
  assert.equal(held.x, first.pos[0], 'and where it is, so the man can be put on it');
  assert.equal(held.yaw, first.yaw, 'facing the way it is facing');
  assert.ok(held.distance >= 0 && held.distance < BOARD_REACH);
  assert.equal(r.get(0).bike, first, 'and get() hands back the same machine');
  assert.equal(r.get(99), null, 'one it does not have is null, not a throw');
  r.dispose();
});

test('one frame rides the machine that has a rider and leaves the rest leaning where they were', () => {
  const r = rack();
  const before = r.bikes.map((e) => e.bike.distance);
  for (let t = 0; t < 2; t += 1 / 30) r.step(1 / 30, 3, { throttle: 1 });
  r.bikes.forEach((entry, i) => {
    const moved = entry.bike.distance - before[i];
    if (i === 3) assert.ok(moved > 1, `the machine being ridden went ${moved.toFixed(1)} m in two seconds`);
    else assert.ok(moved < 1e-9, `and the one at index ${i} stayed where it was parked`);
  });
  // Stepping with nobody on anything is what the frame loop does most of the time.
  r.step(1 / 30);
  r.step(1 / 30, -1, null);
  r.step(1 / 30, 99, { throttle: 1 });
  assert.ok(r.bikes[0].bike.footDown, 'and the parked ones are still parked');
  // Picking one up is what R does, and it is on the rack because that is where the id lives.
  const down = r.bikes[0].bike;
  down.lean = 0.9;
  for (let t = 0; t < 1 && !down.fallen; t += 1 / 60) down.step(1 / 60, {});
  assert.ok(down.fallen, 'a machine leaned past catching is on its side');
  assert.equal(r.right(0).id, 0, 'and the rack can pick it up by id');
  assert.equal(down.fallen, false, 'which stands it back up');
  assert.equal(r.right(99), null, 'picking up one it does not have is null');
  r.dispose();
});

test('each machine is drawn once per colour, and drawn as the machine it is', () => {
  const built = new Map();
  for (const kind of Object.keys(BIKES)) {
    const spec = bikeSpec(kind);
    const mesh = buildBikeMesh(spec, [0.6, 0.1, 0.1]);
    const tris = mesh.indexCount / 3;
    assert.ok(tris > 300, `${kind} is ${tris} triangles, which is a motorcycle and not a pair of wheels`);
    assert.ok(tris < 1600, `and ${tris} is inside what twelve of them on a kerb can afford`);
    const b = mesh.bounds;
    assert.ok(b[3] - b[0] < 1, `${kind} is ${(b[3] - b[0]).toFixed(2)} m across, which is a machine and not a car`);
    assert.ok(b[5] - b[2] > spec.wheelbase * 1.2, `${kind} is ${(b[5] - b[2]).toFixed(2)} m long for a ${spec.wheelbase} m wheelbase`);
    assert.ok(b[4] - b[1] > spec.seat * 0.8, `${kind} is ${(b[4] - b[1]).toFixed(2)} m tall, with its saddle at ${spec.seat}`);
    assert.ok(Math.abs(b[1]) < 0.12, `${kind} sits on the ground: its lowest point is ${b[1].toFixed(3)} m from the origin`);
    assert.ok(b[5] > 0 && b[2] < 0, 'with the front wheel along +Z and the rear behind the origin');
    // The paint is in the vertices, which is why one mesh per colour is the most this can share.
    const other = buildBikeMesh(spec, [0.1, 0.2, 0.7]);
    const a = new Uint8Array(mesh.vertices), c = new Uint8Array(other.vertices);
    assert.equal(a.length, c.length, 'the same machine in two colours is the same machine');
    let differs = 0;
    for (let i = 0; i < a.length; i += VERTEX_STRIDE) if (a[i + 20] !== c[i + 20] || a[i + 22] !== c[i + 22]) differs++;
    assert.ok(differs > 8, `${differs} of its vertices changed colour, which is what a paint is`);
    built.set(kind, mesh);
  }
  // The three are not one machine in three sizes: a cruiser is long and low, a scooter short and tall
  // for its length, and the saddle of each is where its own spec says it is.
  const s = built.get('scooter').bounds, c = built.get('cruiser').bounds, d = built.get('roadster').bounds;
  const len = (b) => b[5] - b[2], tall = (b) => b[4] - b[1];
  assert.ok(len(c) > len(d) && len(d) > len(s), 'a cruiser is longer than a roadster and a roadster longer than a scooter');
  assert.ok(tall(c) < tall(s), 'and a cruiser is lower than a scooter, which is the whole of what a cruiser is');
  assert.ok(tall(s) / len(s) > tall(c) / len(c), 'a scooter is taller for its length, which is the whole of what a scooter is');
  for (const kind of Object.keys(BIKES)) {
    const spec = bikeSpec(kind), b = built.get(kind).bounds;
    assert.ok(tall(b) > spec.seat, `${kind} has something above its own ${spec.seat} m saddle`);
    assert.ok(tall(b) < spec.seat + 0.75, `and is not a machine with a ${tall(b).toFixed(2)} m handlebar on it`);
  }
});

test('the matrix it is drawn with is the attitude it is leaning in', () => {
  const b = createBike(bikeSpec('roadster'), { x: 12, y: LAND, z: -30, yaw: 0.7, ground: () => LAND });
  for (let t = 0; t < 4; t += 1 / 60) b.step(1 / 60, { throttle: 0.8, steer: 0.4 });
  const m = new Float32Array(16);
  writeMatrix(m, b);
  for (const k of [0, 1, 2]) {
    assert.ok(Math.abs(Math.hypot(m[k * 4], m[k * 4 + 1], m[k * 4 + 2]) - 1) < 1e-6, `row ${k} is a unit vector`);
    assert.ok(Math.abs(Math.hypot(m[k], m[k + 4], m[k + 8]) - 1) < 1e-6, `and so is column ${k}`);
  }
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  assert.ok(Math.abs(det - 1) < 1e-6, `it is a rotation rather than a mirror: determinant ${det.toFixed(9)}`);
  // Rows are the body's axes, in the layout the cars and the aeroplanes use: m[0], m[1], m[2] are the x of
  // the lateral, the up and the forward. A leaning machine drawn upright is the one bug here that a rider
  // would notice before he noticed anything else.
  const axes = basisFromAttitude(b.yaw, b.pitch, b.lean);
  const want = [axes.lateral, axes.up, axes.forward];
  for (let k = 0; k < 3; k++) {
    for (let w = 0; w < 3; w++) {
      assert.ok(Math.abs(m[k * 4 + w] - want[w][k]) < 1e-6, `m[${k * 4 + w}] is the ${['x', 'y', 'z'][k]} of the ${['lateral', 'up', 'forward'][w]} axis`);
    }
  }
  assert.ok(Math.abs(b.lean) > 0.05, `which is worth drawing: it is over ${(b.lean * DEG).toFixed(0)} degrees`);
  assert.ok(axes.lateral[1] < -0.05, 'with that side down, the way a positive lean is defined');
  assert.ok(Math.abs(m[12] - b.pos[0]) < 1e-3 && Math.abs(m[13] - b.pos[1]) < 1e-3 && Math.abs(m[14] - b.pos[2]) < 1e-3,
    'and the machine is where it is');
  assert.equal(m[15], 1);
  // `at` carries the same lean somewhere else, which is how a rider is put on the saddle of a machine
  // that is leaning rather than standing him upright on a leaning motorcycle.
  const m2 = new Float32Array(16);
  writeMatrix(m2, b, [1, LAND + RIDER_HIP, 2]);
  for (let i = 0; i < 12; i++) assert.equal(m2[i], m[i], 'the rotation is the same');
  const put = [1, LAND + RIDER_HIP, 2];
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(m2[12 + k] - put[k]) < 1e-5, 'and only where it is put has moved');
  assert.ok(RIDER_HIP > 0.3 && RIDER_HIP < 0.7, `a seated body's hips are ${RIDER_HIP} m above its own origin`);
});

test('the panel reads out what a rider reads, in the units he reads it in', () => {
  const b = createBike(bikeSpec('roadster'), { x: 0, y: LAND, z: 0, yaw: 0, ground: () => LAND });
  let f = bikeInstruments(b);
  assert.equal(f.kind, 'bike', 'the panel knows which machine it is reading');
  assert.equal(f.speed, 0, 'a parked machine is not moving');
  assert.equal(f.gear, 1, 'and is in first');
  assert.equal(f.gears, bikeSpec('roadster').gears.length, 'of five');
  assert.equal(f.lean, 0, 'upright');
  assert.equal(f.fallen, false, 'standing');
  assert.equal(f.sliding, false, 'with the tyres in the road');
  assert.equal(f.footDown, true, 'and a foot down');
  assert.ok(Math.abs(f.fuel - 1) < 1e-9, 'with a full tank');
  assert.equal(f.redline, bikeSpec('roadster').redline, 'and the redline on the panel is the engine\'s own');
  assert.ok(f.rpm > 0 && f.rpm < f.redline, `${f.rpm} rpm at rest is a tickover`);

  for (let t = 0; t < 8; t += 1 / 60) b.step(1 / 60, { throttle: 1 });
  f = bikeInstruments(b);
  assert.ok(f.speed > 10, `${f.speed} km/h after eight seconds of it`);
  assert.equal(f.speed, Math.round(Math.abs(b.speed) * 3.6), 'in kilometres an hour, which is what a rider quotes');
  assert.ok(Number.isInteger(f.speed) && Number.isInteger(f.rpm) && Number.isInteger(f.lean),
    'and whole numbers, because a panel is read at a glance');
  assert.ok(f.rpm > 1000 && f.rpm <= f.redline, `${f.rpm} rpm is on the tacho and under the redline`);

  // A machine over in a corner says which way it is over, in the sign the whole game steers by.
  const leaned = createBike(bikeSpec('roadster'), { x: 0, y: LAND, z: 0, yaw: 0, ground: () => LAND });
  for (let t = 0; t < 6; t += 1 / 60) leaned.step(1 / 60, { throttle: 0.6, steer: 1 });
  const lf = bikeInstruments(leaned);
  assert.ok(lf.lean > 5, `${lf.lean} degrees over, which is what the panel is for`);
  assert.equal(lf.lean, Math.round(leaned.lean * DEG), 'and it is the lean the machine is actually in');

  // On its side, the panel says so and says what to do about it, because that is the only thing worth
  // printing while a machine is on the tarmac.
  const down = createBike(bikeSpec('scooter'), { x: 0, y: LAND, z: 0, yaw: 0, ground: () => LAND });
  down.lean = 0.9;
  for (let t = 0; t < 1 && !down.fallen; t += 1 / 60) down.step(1 / 60, {});
  assert.equal(bikeInstruments(down).fallen, true, 'a machine on its side says so');
  down.right();
  assert.equal(bikeInstruments(down).fallen, false, 'and stops saying so once it is picked up');
  // Out of fuel is a fuel reading of nothing, which is what makes the gauge worth having.
  const dry = createBike(bikeSpec('scooter'), { x: 0, y: LAND, z: 0, yaw: 0, ground: () => LAND });
  dry.refuel(0);
  assert.equal(bikeInstruments(dry).fuel, 0, 'an empty tank reads empty');
});

test('the rack answers to what the frame loop calls it by', () => {
  // game.js reaches for these names from inside a branch that only runs when a man walks past a
  // motorcycle, which is where a missing name would hide until somebody tried to ride one.
  const r = rack();
  for (const name of ['nearestTo', 'step', 'get', 'right', 'dispose', 'bikes', 'count', 'kind']) {
    assert.ok(name in r, `the rack has a ${name}`);
  }
  for (const name of ['nearestTo', 'step', 'get', 'right', 'dispose']) {
    assert.equal(typeof r[name], 'function', `${name} is something that can be called`);
  }
  assert.ok(Array.isArray(r.bikes), 'and its machines are a list');
  // With no road graph at all — a test, or a city still being built — the rack still stands its machines
  // up somewhere, so the boarding code has one to find.
  const bare = createBikes({ ground: () => LAND, seed: 3 });
  assert.equal(bare.count, PARKED.length, 'with no streets there are still machines');
  for (const e of bare.bikes) assert.ok(Number.isFinite(e.bike.pos[0]) && Number.isFinite(e.bike.pos[2]), 'and they are somewhere, not nowhere');
  bare.dispose();
  // And a count is a count.
  const few = rack({ count: 4 });
  assert.equal(few.count, 4, 'four places is four machines');
  few.dispose();
  r.dispose();
});
