// The door: an empty car and an occupied one, timed.
//
// Taking a car used to be a teleport. Now it is a clock with seams — the hand on the handle, the driver
// coming out of his seat, the body leaving the pavement for the car — and the two ways in cost different
// amounts of second, because that is what they are: a theft is a door, a carjack is a man.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoarding, BOARD_SECONDS, PHASES, awayFromCar } from '../../web/src/game/boarding.js';

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
  assert.deepEqual(events, ['reach', 'hide', 'done'], 'the empty-car sequence has no pull seam');
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
  assert.deepEqual(events, ['reach', 'pull', 'hide', 'done']);
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
  const right = awayFromCar(0, 0, 0, 1);
  const left = awayFromCar(0, 0, 0, -1);
  assert.ok(Math.abs(right - Math.PI / 2) < 1e-9, 'the right-hand door ejects to the right of the heading');
  assert.ok(Math.abs(left + Math.PI / 2) < 1e-9, 'and the left to the left');
  assert.ok(Math.abs(awayFromCar(0, 0, Math.PI, 1) + Math.PI / 2) < 1e-9, 'a car facing the other way mirrors');
});
