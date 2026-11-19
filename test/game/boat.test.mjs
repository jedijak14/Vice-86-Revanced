// A boat: what Archimedes promises, and what the rudder refuses.
//
// The physics is measured here rather than admired: a hull settles at the draft its displacement was
// promised, rights a heel because a dipped side pushes harder, makes way on the throttle and loses it
// to its own wake, and will not turn at rest because a rudder is a wing and a wing needs flow.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoat, boatSpec, RHO } from '../../web/src/physics/boat.js';

const settle = (boat, seconds = 4, input = {}) => {
  for (let t = 0; t < seconds; t += 1 / 60) boat.step(1 / 60, input);
  return boat;
};

test('a hull floats at the draft its displacement was promised, and settles there', () => {
  const spec = boatSpec({ mass: 1400, length: 6.4, beam: 2.4 });
  const boat = createBoat(spec, { y: 0 });
  settle(boat, 6);
  // The waterplane origin sits one draft above the surface line at equilibrium.
  assert.ok(Math.abs(boat.pos[1] + spec.draft) < 0.05,
    `sits ${(-boat.pos[1]).toFixed(3)} m deep against a promised draft of ${spec.draft.toFixed(3)}`);
  assert.ok(Math.abs(boat.vel[1]) < 0.02, 'and is not still bouncing');
  assert.ok(Math.abs(boat.pitch) < 0.02 && Math.abs(boat.roll) < 0.02, 'level, on still water');
  assert.ok(Math.abs(boat.immersion - spec.draft) < 0.08, 'the immersion reading is the draft');
});

test('double the displacement, double the draft: buoyancy is a volume, not a vibe', () => {
  const light = boatSpec({ mass: 1000 });
  const heavy = boatSpec({ mass: 2000, length: light.length, beam: light.beam, waterplane: light.waterplane });
  assert.ok(Math.abs(heavy.draft - 2 * light.draft) < 1e-9);
  const a = settle(createBoat(light, { y: 0 }), 6);
  const b = settle(createBoat(heavy, { y: 0 }), 6);
  const da = -a.pos[1], db = -b.pos[1];
  assert.ok(Math.abs(db / da - 2) < 0.15, `the heavy hull sits ${db.toFixed(2)} m against ${da.toFixed(2)}: not twice`);
});

test('a heel rights itself: dip a side and the water puts it back', () => {
  const boat = settle(createBoat(boatSpec(), { y: 0 }), 4);
  boat.roll = 0.35;                     // twenty degrees of somebody walking the gunwale
  boat.rollRate = 0;
  settle(boat, 8);
  assert.ok(Math.abs(boat.roll) < 0.04, `still heeled ${Math.round(Math.abs(boat.roll) * 57.3)} degrees after eight seconds`);
  assert.ok(Math.abs(boat.pos[1] + boat.spec.draft) < 0.06, 'and still at its draft');
});

test('throttle makes way, and the wake takes it back when the hand comes off', () => {
  const boat = settle(createBoat(boatSpec(), { y: 0 }), 4);
  settle(boat, 12, { throttle: 1 });
  const top = boat.forwardSpeed;
  assert.ok(top > 6 && top < 25, `full throttle makes ${top.toFixed(1)} m/s, which is not a boat speed`);
  assert.ok(boat.pitch < 0.06, 'planing bow-up within reason');
  settle(boat, 20, {});
  assert.ok(boat.forwardSpeed < 0.4, `still coasting at ${boat.forwardSpeed.toFixed(2)} m/s twenty seconds later`);
});

test('the rudder is a wing: no flow, no bite', () => {
  const boat = settle(createBoat(boatSpec(), { y: 0 }), 4);
  settle(boat, 2, { steer: 1 });
  assert.ok(Math.abs(boat.yawRate) < 0.05, `turns at ${boat.yawRate.toFixed(3)} rad/s with no way on`);
  settle(boat, 10, { throttle: 0.7, steer: 1 });
  assert.ok(boat.yawRate > 0.2, 'with way on, the same rudder turns her');
  const yaw = boat.yaw;
  settle(boat, 10, { throttle: 0.7, steer: -1 });
  assert.ok(boat.yaw !== yaw, 'and the other way round');
});

test('reverse is a reversed propeller, not a brake pedal', () => {
  const boat = settle(createBoat(boatSpec(), { y: 0 }), 4);
  settle(boat, 8, { throttle: -0.8 });
  assert.ok(boat.forwardSpeed < -1, `reverse gives ${boat.forwardSpeed.toFixed(2)} m/s of stern way`);
});

test('the interface is the car\'s: a chase camera can hold a boat without learning a new verb', () => {
  const boat = settle(createBoat(boatSpec(), { x: 10, y: 0, z: 20, yaw: 1 }), 2);
  assert.equal(boat.renderPos, boat.pos);
  const q = boat.renderQuat;
  assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6, 'a unit quaternion out');
  assert.ok(Number.isFinite(boat.speed) && Number.isFinite(boat.forwardSpeed));
  boat.place(0, 0, 0, 0);
  assert.deepEqual(boat.vel, [0, 0, 0], 'place stops the world');
  assert.ok(RHO > 1000, 'salt water, as advertised');
});
