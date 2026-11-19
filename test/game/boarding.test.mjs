// The door: an empty car and an occupied one, timed.
//
// Taking a car used to be a teleport. Now it is a clock with seams — the hand on the handle, the driver
// coming out of his seat, the body leaving the pavement for the car — and the two ways in cost different
// amounts of second, because that is what they are: a theft is a door, a carjack is a man.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoarding, BOARD_SECONDS, PHASES, awayFromCar, seatFor } from '../../web/src/game/boarding.js';

/** A shelf of one very cooperative pedestrian, recording what was done to him. */
function fakeCrowd(log) {
  const person = {
    roles: [], places: [], frames: 0, gone: false, shown: true,
    place(x, y, z, yaw) { this.places.push([x, y, z, yaw]); return this; },
    role(name, opts) { this.roles.push([name, !!(opts && opts.once)]); return this; },
    frame() { this.frames++; },
    visible(on) { this.shown = !!on; return this; },
    remove() { this.gone = true; },
  };
  return {
    person,
    takePerson() { log.push('take'); return person; },
    handPersonBack() { log.push('back'); person.gone = true; },
  };
}

const run = (board, seconds, dt = 1 / 60) => {
  const events = [];
  for (let t = 0; t < seconds; t += dt) events.push(...board.step(dt));
  return events;
};

test('an empty car is a handle and a hinge: reach, hide, done, in one second', () => {
  const log = [];
  const board = createBoarding({ crowd: fakeCrowd(log) });
  assert.equal(board.active, false);
  assert.equal(board.begin(false, { x: 1, y: 0, z: 2 }, 0.5), true);
  assert.equal(board.begin(false, { x: 1, y: 0, z: 2 }, 0.5), false, 'a door already in the hand is not two doors');
  const events = run(board, BOARD_SECONDS.empty + 0.2);
  assert.deepEqual(events, ['reach', 'hide', 'seated', 'done'], 'the empty-car sequence has no pull seam');
  assert.equal(board.active, false, 'the sequence ends itself');
  assert.deepEqual(log, [], 'nobody was sitting in it, so nobody was borrowed');
  assert.ok(Math.abs(BOARD_SECONDS.empty - (PHASES.empty.reach + PHASES.empty.enter)) < 1e-9);
});

test('an occupied car is a man coming out of his seat first, and it takes nearly two seconds', () => {
  const log = [];
  const crowd = fakeCrowd(log);
  const board = createBoarding({ crowd });
  board.begin(true, { x: 0, y: 0, z: 0 }, Math.PI / 2);
  const events = run(board, BOARD_SECONDS.occupied + 2.0);   // long enough for the driver to be handed back
  assert.deepEqual(events, ['reach', 'pull', 'hide', 'seated', 'done']);
  assert.ok(BOARD_SECONDS.occupied > BOARD_SECONDS.empty + 0.5, 'a carjack is longer than a theft');
  // The driver: borrowed at the pull seam, up out of the chair, one horrible moment, then away at a
  // run — and handed back to the street once he has fled, because a fled man is a pedestrian again.
  assert.deepEqual(log, ['take', 'back']);
  const d = crowd.person;
  assert.ok(d.roles.some(([n, once]) => n === 'standup' && once), 'he stands up out of the seat');
  assert.ok(d.roles.some(([n, once]) => n === 'startle' && once), 'he understands what is happening');
  assert.ok(d.roles.some(([n]) => n === 'run'), 'and he goes');
  const first = d.places[0], last = d.places[d.places.length - 1];
  assert.ok(Math.hypot(last[0] - first[0], last[2] - first[2]) > 3, 'some metres of pavement between them');
  // He ran the way he was told to, which is straight out of the door side.
  assert.ok(Math.abs(last[0] - first[0]) > Math.abs(last[2] - first[2]), 'across the door, not along it');
});

test('a cancelled door gives the body back and leaves nothing in flight', () => {
  const log = [];
  const board = createBoarding({ crowd: fakeCrowd(log) });
  board.begin(true, { x: 0, y: 0, z: 0 }, 0);
  run(board, PHASES.occupied.reach + 0.1);
  assert.ok(board.driver, 'the driver is out and about');
  board.cancel();
  assert.deepEqual(log, ['take', 'back']);
  assert.equal(board.active, false);
  assert.equal(board.driver, null);
  assert.deepEqual(run(board, 1), [], 'a cancelled sequence steps to nothing');
});

test('the ejection runs across the door side of the car, whichever side the door is on', () => {
  // A yaw of `yaw + pi/2` points along the body's lateral axis, (cos yaw, -sin yaw), which on a map whose
  // +Z is south is the car's LEFT. So side +1 is the left-hand door, and the run-off is straight out of
  // it: across the car, not along it.
  const left = awayFromCar(0, 0, 0, 1);
  const right = awayFromCar(0, 0, 0, -1);
  assert.ok(Math.abs(left - Math.PI / 2) < 1e-9, 'the left-hand door ejects out to the car\'s left');
  assert.ok(Math.abs(right + Math.PI / 2) < 1e-9, 'and the right-hand door out to its right');
  // Out of the door means along the lateral axis, not along the nose: at a yaw of a quarter turn the
  // run-off is along the world's own z, whichever way the car is facing.
  for (const yaw of [0, 0.7, -2.1, Math.PI]) {
    const a = awayFromCar(0, 0, yaw, 1);
    assert.ok(Math.abs(Math.sin(a) - Math.cos(yaw)) < 1e-9 && Math.abs(Math.cos(a) + Math.sin(yaw)) < 1e-9,
      `at a heading of ${yaw.toFixed(2)} the ejection runs along the car's own left side`);
  }
  assert.ok(Math.abs(awayFromCar(0, 0, Math.PI, 1) + Math.PI / 2) < 1e-9, 'and a car facing the other way mirrors');
});

test('the driver\'s seat is on the left of every machine that has one', () => {
  // Every car in this city is left-hand drive and every one of them is drawn that way: the steering
  // wheel, the column and the instrument cowl are built at the model's own driver's eye, which is at +X
  // in the body's frame. +X is the car's left, because +Z is south and a yaw of zero faces south. So a
  // body carried into a car has to end up on +X too, and one carried into an aeroplane on the same side,
  // because the left seat is the pilot's and the door is behind it.
  const car = seatFor('own', 100, -50, 0.9);
  const eye = [0.4, 1.12, 0.2];
  const told = seatFor('own', 100, -50, 0.9, eye);
  const street = seatFor('traffic', 100, -50, 0.9);
  const left = [Math.cos(0.9), -Math.sin(0.9)];       // the body's own left, in world metres
  for (const [name, seat] of [['the player\'s car', car], ['a car off the street', street]]) {
    const across = (seat[0] - 100) * left[0] + (seat[1] + 50) * left[1];
    assert.ok(across > 0.2, `${name} puts the body ${across.toFixed(2)} m along its own left, which is where the wheel is`);
  }
  // A model that says where its driver sits gets its body put exactly there.
  const acrossEye = (told[0] - 100) * left[0] + (told[1] + 50) * left[1];
  assert.ok(Math.abs(acrossEye - eye[0]) < 1e-9, `and a car with a driver's eye at ${eye[0]} m is sat at ${acrossEye.toFixed(2)} m`);
  // The pilot's seat is the left one, two rows back from the panel, and the saddle is on the centreline.
  const plane = seatFor('plane', 100, -50, 0.9);
  assert.ok((plane[0] - 100) * left[0] + (plane[1] + 50) * left[1] > 0.3, 'a cockpit puts him in the left seat');
  const bike = seatFor('bike', 100, -50, 0.9);
  const bikeAcross = (bike[0] - 100) * left[0] + (bike[1] + 50) * left[1];
  assert.ok(Math.abs(bikeAcross) < 1e-9, 'and a motorcycle puts him on the centreline, where the saddle is');
  // Whichever way the machine is facing, the side it is on does not change: a left is a left.
  for (const yaw of [0, 1.3, -2.4, Math.PI]) {
    const l = [Math.cos(yaw), -Math.sin(yaw)];
    const s = seatFor('own', 0, 0, yaw);
    assert.ok(s[0] * l[0] + s[1] * l[1] > 0.2, `at a heading of ${yaw.toFixed(1)} the seat is still on the left`);
  }
  // A gunwale is abaft the beam and on neither side, which is what a boat has instead of a driver's seat.
  const boat = seatFor('boat', 0, 0, 0);
  assert.ok(Math.abs(boat[0]) < 1e-9 && boat[1] < -0.3, 'and a boat puts him aft on the centreline');
});

test('a seat is a place on the ground, and never a NaN', () => {
  // A heading on the ground is a pair, [x, z], and a pair has no third element. Reading one gives
  // `undefined`, and `undefined` in arithmetic gives NaN — quietly, with no exception, all the way into
  // the body's position, the matrix that draws him, and the free camera that follows him. Every door
  // sequence in the game used to carry its body to a seat whose z was NaN, so the man walked towards
  // nothing and vanished at the door: the arc lerps to the seat, and lerping to NaN is NaN from the
  // first frame. This is the test that would have caught it, and it costs nothing to keep.
  for (const tag of ['own', 'traffic', 'boat', 'plane', 'bike']) {
    for (const yaw of [0, 0.7, -2.1, Math.PI, 4.9]) {
      for (const eye of [null, [0.35, 0.905, 0.05], [0.372, 0.985, -0.6495]]) {
        const seat = seatFor(tag, 12.5, -340.25, yaw, eye);
        assert.equal(seat.length, 2, `${tag} hands back an [x, z] pair`);
        for (const [i, v] of seat.entries()) {
          assert.ok(Number.isFinite(v), `${tag} at a heading of ${yaw.toFixed(1)} gives a finite ${i === 0 ? 'x' : 'z'} (got ${v})`);
        }
      }
    }
  }
  // And the same, for the walk out of the door: a yaw is an angle, so it is finite by construction, but
  // the sign of `side` reaching it from foot.js is what decides which way the driver runs.
  for (const yaw of [0, 1.1, -2.6]) for (const side of [1, -1]) {
    assert.ok(Number.isFinite(awayFromCar(3, -7, yaw, side)), 'the run-off yaw is a number');
  }
});
