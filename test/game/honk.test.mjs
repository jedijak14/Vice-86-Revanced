// "of course add the ai so if you get in the actual way of the cars, they stop and honk."
//
// These drive the real TrafficSim over a real lane graph, because the claim under test is a physical
// one: that a car coming down a road at speed stops for a man standing in it, rather than drifting past
// him, and that the driver can say *why* it stopped -- which is the only thing that makes the horn
// honest. A mock of the driver model would prove nothing here; the model is the thing being asked about.
//
// What is not covered is the traffic module's own horn policy (how long a blast lasts, how many cars
// may sound at once), which lives behind createTraffic and needs a renderer and a physics world to
// build. The numbers it uses are named constants at the top of traffic.js, and test/game/wiring.test.mjs
// is what holds the call sites to the members that exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TrafficSim, OBSTACLE } from '../../web/src/game/drivers.js';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';

/** One straight road 400 m long: enough to reach speed, meet a man, and follow him a while. */
function road() {
  const lane = (pts, next) => ({ pts, next, speedLimit: 13.4, width: 3.3 });
  return prepareLaneGraph({
    lanes: [lane([0, 0, 0, 0, 0, 400], [])],
    junctions: [],
  });
}

/** An ordinary saloon's footprint, the same numbers traffic.js gives a driver. */
const SHAPE = { frontLength: 2.2, rearLength: 2.2, halfWidth: 0.9, wheelbase: 2.6, centreZ: 0, halfLength: 2.2 };

/** Steps the simulation. */
function run(sim, seconds, dt = 1 / 30) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) sim.step(dt);
  return dt;
}

/**
 * Steps with a man standing at a *fixed* station for up to `seconds`, stopping early once the car has
 * come to rest. Describing him relative to the car instead -- `car.z + 40` every step -- is a man
 * running ahead at exactly the car's speed, which is not the thing being asked about and never stops it.
 */
function approach(sim, car, atStation, seconds, opts = {}) {
  const dt = 1 / 30;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    sim.clearObstacles();
    man(sim, atStation, opts);
    sim.step(dt);
    if (car.v < 0.05) break;
  }
}

/** A man on the road at station `z`, as traffic.js describes the player on foot. */
function man(sim, z, { crouching = false, vx = 0, vz = 0, side = 0 } = {}) {
  const radius = crouching ? 0.26 : 0.32;
  // A person is a capsule with no length to it: halfLength equal to halfWidth leaves a core of zero,
  // which is a circle of one shoulder. That is what `setWalker` asks for and what this reproduces.
  sim.obstacle(side, z, 0, radius, radius, vx, vz, OBSTACLE.PERSON);
}

/** The lane's speed limit is 13.4 m/s and a driver's acceleration is about 1.6 m/s^2 times a
 *  character factor under 1.1, so four seconds of clear road is a little over 5 m/s. */
const UP_TO_SPEED = 4.5;

test('a car at speed stops for a man standing in its lane', () => {
  const sim = new TrafficSim(road(), { seed: 11 });
  const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);

  run(sim, 4);                                   // four seconds of clear road
  assert.ok(car.v > UP_TO_SPEED, `it got up to speed on an empty road (${car.v.toFixed(1)} m/s)`);
  assert.equal(car.avoidKind, -1, 'and nothing on it was worth avoiding');
  assert.equal(car.avoidAccel, 0);

  // Now put a man standing at station 150 and keep describing him, as the traffic step does every frame.
  approach(sim, car, 150, 20);
  assert.ok(car.v < 1.0, `it stopped for him, at ${car.v.toFixed(2)} m/s`);
  assert.ok(car.z < 150 - SHAPE.frontLength, `and it stopped this side of him, at station ${car.z.toFixed(1)} m`);
  assert.equal(car.avoidKind, OBSTACLE.PERSON, 'it knows the thing it stopped for was a person');
  assert.ok(car.avoidAccel < -2.2,
    `and it braked hard enough to be committed to stopping (${car.avoidAccel.toFixed(2)} m/s^2), which is what earns a horn`);
  assert.ok(car.braking, 'so its brake lamps are lit while it does it');
});

test('the same car brakes for another car, but that is not a reason to honk', () => {
  const sim = new TrafficSim(road(), { seed: 12 });
  const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);
  run(sim, 4);
  assert.ok(car.v > UP_TO_SPEED, 'up to speed');

  for (let i = 0; i < 600; i++) {
    sim.clearObstacles();
    // A parked car is a vehicle-shaped obstacle: long as well as wide, which is what wreckObstacle and
    // setFocus both describe. The drivers brake the same way for it.
    sim.obstacle(0, 150, 0, SHAPE.halfLength, SHAPE.halfWidth, 0, 0);
    sim.step(1 / 30);
    if (car.v < 0.05) break;
  }
  assert.ok(car.v < 1.0, `it stopped for the car too, at ${car.v.toFixed(2)} m/s`);
  assert.equal(car.avoidKind, OBSTACLE.VEHICLE, 'and it reports a vehicle, not a person');
  assert.ok(car.avoidAccel < -0.5, 'having braked for it');
});

test('a man who steps aside lets the traffic go again', () => {
  const sim = new TrafficSim(road(), { seed: 13 });
  const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);
  run(sim, 4);

  approach(sim, car, 150, 20);
  const stopped = car.v;
  assert.ok(stopped < 1.0, `stopped at ${stopped.toFixed(2)} m/s`);
  const atStation = car.z;

  for (let i = 0; i < 300; i++) {
    sim.clearObstacles();                    // the man is on the pavement now: nothing to describe
    sim.step(1 / 30);
  }
  assert.ok(car.v > 5, `and it drove off once he was out of the road (${car.v.toFixed(1)} m/s)`);
  assert.ok(car.z > atStation + 20, `having covered ground again (station ${(car.z - 10).toFixed(0)} m)`);
  assert.equal(car.avoidKind, -1, 'with nothing left to avoid');
});

test('a car stops for a man standing in the road and follows one walking along it', () => {
  // The model only counts the part of an obstacle's speed along the driver's heading, so a man walking
  // the same way at 1.4 m/s is a slower version of the same gap rather than a wall: the car settles at
  // his pace behind him. Standing still, he is a wall, and the car commits to stopping. That is the
  // difference between a horn and no horn, and it is why the walker's own velocity is fed to the sim
  // rather than only his position.
  const dt = 1 / 30;
  const settled = (walkSpeed) => {
    const sim = new TrafficSim(road(), { seed: 14 });
    const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);
    let station = 150;
    for (let i = 0; i < 120; i++) sim.step(dt);                 // up to speed on a clear road
    for (let i = 0; i < 900; i++) {                             // then half a minute behind the man
      sim.clearObstacles();
      man(sim, station, { vz: walkSpeed });
      station += walkSpeed * dt;                                // and he keeps walking, as a man does
      sim.step(dt);
    }
    return { car, station };
  };

  const standing = settled(0);
  assert.ok(standing.car.v < 0.05, `it stops for a man standing in the road (${standing.car.v.toFixed(2)} m/s)`);
  const gap = standing.station - standing.car.z;
  assert.ok(gap > 3 && gap < 10, `stopping ${gap.toFixed(1)} m short of him: not through him, not a street behind`);
  assert.equal(standing.car.avoidKind, OBSTACLE.PERSON);
  assert.ok(standing.car.avoidAccel < -2.2,
    `braking hard enough to be committed (${standing.car.avoidAccel.toFixed(2)} m/s^2), which is what earns the horn`);

  const walking = settled(1.4);
  assert.ok(walking.car.v > 0.9 && walking.car.v < 2.4,
    `behind a man walking along the road it settles at his pace, not at a stop (${walking.car.v.toFixed(2)} m/s for a man at 1.4)`);
  assert.equal(walking.car.avoidKind, OBSTACLE.PERSON, 'it still knows a person is what it is following');
  assert.ok(walking.car.avoidAccel > -2.2,
    `and it is not braking hard for him (${walking.car.avoidAccel.toFixed(2)} m/s^2), so it does not honk`);
});

test('a crouching man is a smaller thing to stop for, but still in the road', () => {
  const sim = new TrafficSim(road(), { seed: 15 });
  const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);
  run(sim, 4);
  approach(sim, car, 150, 20, { crouching: true });
  assert.ok(car.v < 1.5, `it still stops for a man crouching in the road (${car.v.toFixed(2)} m/s)`);
  assert.equal(car.avoidKind, OBSTACLE.PERSON);
});

test('a man off to the side of the lane is not an obstacle at all', () => {
  const sim = new TrafficSim(road(), { seed: 16 });
  const car = sim.add(sim.graph.lanes[0], 10, SHAPE, 0);
  run(sim, 4);
  const before = car.v;
  for (let i = 0; i < 200; i++) {
    sim.clearObstacles();
    // Three metres to the side is clear of a 0.9 m half-width car and its margin: the pavement, not the road.
    man(sim, 150, { side: 3 });
    sim.step(1 / 30);
  }
  assert.ok(car.v >= before * 0.75,
    `it keeps driving past a man on the pavement (${car.v.toFixed(1)} m/s from ${before.toFixed(1)})`);
  assert.equal(car.avoidKind, -1, 'and does not report him as something it had to avoid');
});

test('the obstacle slots are reused, so a step costs nothing to allocate', () => {
  const sim = new TrafficSim(road(), { seed: 17 });
  for (let i = 0; i < 400; i++) {
    sim.clearObstacles();
    sim.obstacle(0, 50, 0, 2.2, 0.9, 0, 0);
    sim.obstacle(1, 60, 0, 0.32, 0.32, 0, 0, OBSTACLE.PERSON);
    sim.obstacle(2, 70, 0, 0.32, 0.32, 0, 0, OBSTACLE.PERSON);
    sim.step(1 / 30);
  }
  assert.equal(sim.obstacles.length, 3, 'three slots were made and then reused for four hundred steps');
  assert.equal(sim.obstacleCount, 3, 'and this step described three obstacles');
  assert.deepEqual(sim.obstacles.map((o) => o.kind), [OBSTACLE.VEHICLE, OBSTACLE.PERSON, OBSTACLE.PERSON],
    'each keeping the kind it was given');
});
