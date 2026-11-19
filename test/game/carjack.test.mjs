// "allow stealing cars"
//
// A car taken off the street is traffic's to hand over: the vehicle comes out of traffic's own lists, its
// physics box and its pooled view go back to where they came from, and what is left is the model, the kind,
// the paint and the pose -- enough for game.js to build a drivable car in the same place, facing the same
// way, wearing the same colour, on the specification of its own kind. The car the player left goes back
// through the same door as a parked vehicle of its own type, so the street keeps his car and he can take it
// back the same way.
//
// These build the real traffic module over a real lane graph and the release's own thirteen vehicle models.
// Physics is a stub that keeps the boxes it hands out, because a test has to be able to push one: that is
// what makes "nearly stopped, or you cannot open it" a measured rule rather than a comment. The renderer is
// the permissive stub the wiring test uses, which is enough for a module that only ever calls it.
//
// What is not driven here is a car that stopped for a man and was then taken off him. test/game/honk.test.mjs
// proves a car comes to rest for a walker standing in the road (0.0 m/s, avoidKind PERSON, braking), and the
// reach-and-speed test below proves a car at rest within reach is takeable, so the two halves meet on the
// same number. Spawning traffic of one's own needs a street the world plan built rather than a lane made by
// hand, and a test that invented one would be testing the invention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTraffic } from '../../web/src/game/traffic.js';
import { createFoot, BOARD_DISTANCE, BOARD_SPEED_LIMIT } from '../../web/src/game/foot.js';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';
import { buildTrafficModels } from '../../web/src/vehicles/traffic/index.js';
import { trafficSpec } from '../../web/src/physics/specs.js';
import { WantedLedger, OFFENCES } from '../../web/src/game/wanted.js';

/** Answers anything with itself: enough for a module that only stores and calls its dependencies. */
const anything = new Proxy(function () {}, {
  get(target, key) {
    if (key === Symbol.toPrimitive || key === 'valueOf') return () => 0;
    if (key === 'length') return 0;
    if (key === 'then') return undefined;            // never mistaken for a thenable
    return anything;
  },
  apply() { return anything; },
  construct() { return anything; },
  has() { return true; },
  set() { return true; },
});

/**
 * A physics world that keeps every box it handed out, with the vehicle traffic stored in it. Keeping them
 * is the point: a parked car that something has pushed is a car rolling down the street, and the only way
 * to ask about one in a test is to hold the box and move it.
 */
function stubPhysics() {
  const boxes = [];
  const world = {
    boxes,
    createKinematicBox(spec) {
      const box = {
        pos: Float64Array.from(spec.pos), vel: new Float64Array(3),
        yaw: spec.yaw || 0, yawRate: 0, pushed: false, userData: spec.userData || null,
        renderPos: Float64Array.from(spec.pos), renderQuat: new Float64Array([0, 0, 0, 1]),
        setPose(p, y) { box.pos.set(p); box.renderPos.set(p); box.yaw = y; },
      };
      boxes.push(box);
      return box;
    },
    removeKinematicBox(box) { const i = boxes.indexOf(box); if (i >= 0) boxes.splice(i, 1); },
    raycast: () => ({ hit: false, body: null, dist: 0 }),
  };
  return new Proxy(world, { get: (target, key) => (key in target ? target[key] : anything) });
}

/** One straight road: enough for a lane graph that answers `nearest`, which is all traffic asks of it here. */
function road() {
  return prepareLaneGraph({ lanes: [{ pts: [0, 0, 0, 0, 0, 400], next: [], speedLimit: 13.4, width: 3.3 }], junctions: [] });
}

const MODELS = buildTrafficModels();

/** A street with a real traffic module on it, and the boxes it is holding. */
function street(seed = 7) {
  const physics = stubPhysics();
  const traffic = createTraffic({ renderer: anything, physics, graph: road(), models: MODELS, seed, notify: null });
  // Traffic asks where the player is before it will do anything at all; a car at the origin looking down
  // the road is the whole of what it reads.
  const car = { pos: [0, 0, 0], vel: [0, 0, 0], yaw: 0 };
  const player = { vehicle: car, kit: { halfExtents: [1, 0.7, 2.2], colliderCentre: [0, 0.7, 0] } };
  const camera = { position: [0, 1.6, -6], forward: [0, 0, 1] };
  traffic.setFocus(player, camera);
  return { traffic, physics, car, camera, refocus: () => traffic.setFocus(player, camera) };
}

/** Puts a car on the street where the test wants it, as game.js puts the car the player left. */
function park(traffic, at, opts = {}) {
  const model = opts.model || MODELS[1];
  const ok = traffic.adopt({
    model, kind: opts.kind || model.kind, name: opts.name || model.name,
    mass: opts.mass || 1600, x: at[0], y: at[1] || 0, z: at[2], yaw: opts.yaw || 0,
    paint: opts.paint || model.paints[3], dirt: 0, registryId: opts.registryId || null,
  });
  assert.equal(ok, true, 'the street would not take the car it was handed');
  return model;
}

// ------------------------------------------------------------------------------------ the street's side

test('a car within reach is held out, and one further off is not', () => {
  const { traffic } = street();
  park(traffic, [1.6, 0, 40]);

  const near = traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  assert.equal(near.active, true, 'a car 1.6 m away is within reach of a door');
  assert.equal(near.tag, 'traffic', 'the street says whose car it is offering');
  assert.ok(Math.abs(near.distance - 1.6) < 1e-9, `measured ${near.distance} m`);
  assert.equal(near.kind, 'sedan');
  assert.equal(near.name, 'sedan');
  assert.equal(near.hadDriver, false, 'a parked car has nobody in it');
  assert.equal(near.speed, 0);

  // The same car, asked from further away than a man can reach, and asked from down the street.
  assert.equal(traffic.nearestTo(0, 40, 1.0, BOARD_SPEED_LIMIT).active, false, 'a door is not 1 m from here');
  assert.equal(traffic.nearestTo(0, 0, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, false, '40 m up the road is not in reach');
  // And nothing at all is offered when the street is empty of it.
  assert.equal(traffic.nearestTo(0, 300, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, false);
});

test('a car that is rolling is not a car you can open', () => {
  const { traffic, physics, refocus } = street();
  park(traffic, [1.6, 0, 40]);
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, true);

  // Something has hit it: the box physics handed out for it is now moving at 5 m/s, which is a car rolling
  // away from the kerb and not a door a man can catch hold of.
  const box = physics.boxes[physics.boxes.length - 1];
  box.vel[0] = 5;
  box.pushed = true;
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, false,
    'a car rolling at 5 m/s was offered to a man on foot');

  // It is still on the street, and still not takeable: refusing it is not the same as losing it.
  refocus();
  traffic.step(1 / 30);
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, 50).active, true, 'it is still there at a wider limit');
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, false,
    'and still rolling after a step');
});

test('taking it hands over the car and empties the street of it', () => {
  const { traffic, physics } = street();
  const model = park(traffic, [1.6, 0, 40], { paint: MODELS[1].paints[5], registryId: 'lucera', yaw: 0.4 });
  const boxesBefore = physics.boxes.length;

  const ask = traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  const taken = traffic.take(ask.id);
  assert.ok(taken, 'the car in reach was not there to take');
  assert.equal(taken.model, model, 'the model handed over is the one the street was drawing it from');
  assert.equal(taken.kind, 'sedan', 'the kind comes with it, because the specification is built from it');
  assert.equal(taken.name, 'sedan');
  assert.equal(taken.paint, MODELS[1].paints[5], 'the colour it was wearing on the street');
  assert.ok(Math.abs(taken.x - 1.6) < 1e-9 && Math.abs(taken.z - 40) < 1e-9, `it was standing at ${taken.x}, ${taken.z}`);
  assert.ok(Math.abs(taken.yaw - 0.4) < 1e-9, 'facing the way it was facing');
  assert.equal(taken.hadDriver, false);
  assert.equal(taken.registryId, 'lucera', 'a car of his own says which car of his own it is');

  // The street no longer has it, and its box went back to physics rather than staying in the world.
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).active, false, 'it is still on the street');
  assert.equal(physics.boxes.length, boxesBefore - 1, 'the physics box was not given back');
  assert.equal(traffic.take(ask.id), null, 'the same car cannot be taken twice');
});

test('the car he left is put on the street as one type, however often he leaves it', () => {
  const { traffic } = street();

  park(traffic, [1.6, 0, 40], { registryId: 'lucera' });
  const first = traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  assert.equal(first.active, true);
  const firstType = first.type;
  assert.ok(firstType >= MODELS.length, 'a car of the player\'s is a type of its own, not one of the fleet');
  traffic.take(first.id);

  // Leaving it again, and a different car as well: the first must not grow the fleet's tables a second
  // time, because a street a player keeps walking away from would otherwise run out of them.
  park(traffic, [1.6, 0, 40], { registryId: 'lucera' });
  const again = traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  assert.equal(again.type, firstType, 'the same car left twice is the same type');

  park(traffic, [-1.6, 0, 60], { registryId: 'thunderhead', model: MODELS[4], kind: MODELS[4].kind, name: MODELS[4].name });
  const other = traffic.nearestTo(0, 60, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  assert.notEqual(other.type, firstType, 'a different car is a different type');
  assert.equal(other.name, MODELS[4].name);

  // Both are still there, and each is the nearer of the two from where it was asked.
  assert.equal(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).type, firstType);
  assert.equal(traffic.nearestTo(0, 60, BOARD_DISTANCE, BOARD_SPEED_LIMIT).type, other.type);
});

test('a car taken back off the street is drivable on the specification of its own kind', () => {
  const { traffic } = street();
  // The player's own car is a model the garage built, which need not say what kind of car it is; the kind
  // is told to the street when the car is left, and has to come back with it, because trafficSpec is built
  // from it and a car with no specification is a car that cannot be driven.
  park(traffic, [1.6, 0, 40], { model: MODELS[9], kind: 'bus', name: 'bus', mass: 11000, registryId: null });
  const ask = traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT);
  const taken = traffic.take(ask.id);

  assert.equal(taken.kind, 'bus', 'the kind it was adopted under came back with it');
  const spec = trafficSpec(taken.kind, taken.model);
  assert.equal(spec.mass, 11000, 'a bus taken off the street is eleven tonnes, not the car he drove there');
  assert.ok(spec.engine.idle > 0 && spec.engine.redline > spec.engine.idle, 'the engine the sound is played at');
  assert.ok(Array.isArray(spec.gears) && spec.gears.length > 1, 'and a box to drive it through');
  assert.equal(taken.registryId, null, 'a car that is not his says so');
});

test('a car of the agency says so, and is the heavier act', () => {
  const { traffic } = street();
  const POLICE = MODELS.findIndex((m) => m.kind === 'police');
  assert.ok(POLICE >= 0, 'the release has no cruiser in it, so there is nothing to ask about');
  park(traffic, [1.6, 0, 40], { model: MODELS[POLICE], kind: 'police', name: MODELS[POLICE].name });
  const taken = traffic.take(traffic.nearestTo(0, 40, BOARD_DISTANCE, BOARD_SPEED_LIMIT).id);
  assert.equal(taken.police, true, 'a cruiser taken off the street was not reported as one');
  assert.equal(taken.kind, 'police');

  // An ordinary car is not one, and the ledger charges the two differently.
  park(traffic, [1.6, 0, 60]);
  const plain = traffic.take(traffic.nearestTo(0, 60, BOARD_DISTANCE, BOARD_SPEED_LIMIT).id);
  assert.equal(plain.police, false, 'a saloon was reported as a patrol car');
  assert.equal(OFFENCES['patrol car taken'], 6, 'a cruiser costs more than anybody else\'s car');
  assert.ok(OFFENCES['patrol car taken'] > OFFENCES['car jacked'], 'and more than a car with a man in it');
});

// ---------------------------------------------------------------------------------------- the ledger

test('the record charges for it, and more for throwing somebody out', () => {
  assert.equal(OFFENCES['car jacked'], 4, 'a car taken from somebody is a car taken from a shop\'s till');
  assert.equal(OFFENCES['car stolen'], 2, 'an empty car at the kerb is less of it');

  const jacked = new WantedLedger();
  assert.equal(jacked.add('car jacked'), true, 'the ledger would not take the charge');
  assert.equal(jacked.points, 4, `four points, and it recorded ${jacked.points}`);
  assert.equal(jacked.lastCause, 'car jacked');

  const stolen = new WantedLedger();
  stolen.add('car stolen');
  assert.equal(stolen.points, 2);
  // One star is three points, so a car taken from its driver is a star on its own and an empty one is not.
  assert.equal(jacked.stars, 1, 'a man thrown out of his car is worth a star');
  assert.equal(stolen.stars, 0, 'an empty car at the kerb is not, yet');
});

// -------------------------------------------------------------------------------------- the man's side

/** A flat street with nothing on it: the floor answers a downward ray at y = 0 and nothing else answers. */
function flatWorld() {
  const out = { hit: false, dist: 0, normal: [0, 1, 0], kind: 0, body: null };
  return {
    raycast(origin, dir, maxDist) {
      out.hit = false; out.dist = maxDist; out.kind = 0; out.body = null;
      out.normal[0] = 0; out.normal[1] = 1; out.normal[2] = 0;
      if (dir[1] < -0.9 && origin[1] > 0) { out.hit = true; out.dist = origin[1] / -dir[1]; }
      return out;
    },
  };
}

/** A car as game.js describes one to the walker: where it is, which way it faces, how fast it is going. */
const aCar = (x, z, opts = {}) => ({ x, y: 0, z, yaw: opts.yaw || 0, speed: opts.speed || 0, tag: opts.tag });

/** What the walker's hand is on after one step with these two cars beside him. */
function nearOf(own, offered) {
  const foot = createFoot({ physics: flatWorld(), land: 0 });
  foot.place(0, 0, 0, 0);
  foot.step(1 / 30, {}, own, offered);
  return foot.near;
}

test('the nearer of two cars in reach is the one his hand goes to', () => {
  // His own car further off than the one the street is holding out: he is taking that one.
  const taken = nearOf(aCar(0, 2.0), aCar(0, 1.0, { tag: 'traffic' }));
  assert.equal(taken.tag, 'traffic', 'a car 1 m away lost to his own 2 m away');
  assert.ok(Math.abs(taken.distance - 1.0) < 1e-9);

  // And the other way round: his own car is nearer, so F is the door he left open.
  const own = nearOf(aCar(0, 1.0), aCar(0, 2.0, { tag: 'traffic' }));
  assert.equal(own.tag, 'own', 'his own car 1 m away lost to one 2 m away');

  // A car with no tag is his own, which is what the single-car call has always meant.
  assert.equal(nearOf(aCar(0, 1.5), null).tag, 'own');
});

test('a car moving past him is not offered, and his own still is', () => {
  const near = nearOf(aCar(0, 2.0), aCar(0, 1.0, { tag: 'traffic', speed: BOARD_SPEED_LIMIT + 1 }));
  assert.equal(near.tag, 'own', 'a car rolling past at 2.5 m/s was offered to a man on foot');
  assert.ok(Math.abs(near.distance - 2.0) < 1e-9);

  // Nothing in reach at all is nothing, and the walker says so rather than guessing.
  assert.equal(nearOf(aCar(0, BOARD_DISTANCE + 0.1), aCar(0, BOARD_DISTANCE + 2, { tag: 'traffic' })), null);
  assert.equal(nearOf(null, null), null);

  // A man with no car of his own can still take one: that is the whole of the thing.
  const only = nearOf(null, aCar(0, 1.2, { tag: 'traffic' }));
  assert.equal(only.tag, 'traffic');
  assert.equal(only.side, -1, 'which side of the car he is standing on is still said');
});
