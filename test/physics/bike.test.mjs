// A motorcycle's physics: the turn is a fall you keep catching, and the tyres decide how far you can fall.
//
// Everything asserted here is the equation the model is built on rather than a number somebody liked the
// look of — tan(lean) = v^2/(gR), a grip limit of mu*g, a top speed that the power and the drag area
// agree on, and a machine at rest that stays up only because a rider is holding it. A motorcycle that
// turned because its front wheel pointed somewhere else would pass none of this and would ride like a car.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BIKES, bikeSpec, createBike } from '../../web/src/physics/bike.js';
import { basisFromAttitude } from '../../web/src/physics/plane.js';

const DT = 1 / 240, GROUND = () => 1.2, LAND = 1.2;
const DEG = 180 / Math.PI, KMH = 3.6, G = 9.81;

/** A machine standing on flat ground, pointing along +Z. */
function standing(kind = 'roadster', at = {}) {
  return createBike(bikeSpec(kind), { x: 0, y: LAND, z: 0, yaw: 0, ground: GROUND, ...at });
}

/** Full throttle to a speed, so the numbers after it are the numbers of a moving machine. */
function rolling(kind, kmh, throttle = 1) {
  const b = standing(kind);
  for (let t = 0; t < 90 && b.speed * KMH < kmh; t += DT) b.step(DT, { throttle });
  return b;
}

test('a turn is a lean, and the circle it traces is the one the lean allows', () => {
  const b = rolling('roadster', 90);
  // Hold a steady circle well inside what the tyres have: the bar asks for a rate, the machine leans to
  // get it, and the lean is the turn. A third of the lock is about twenty degrees over, which is a fast
  // road bend rather than a Grand Prix, and inside the grip so that the equation is what sets the rate.
  for (let t = 0; t < 8; t += DT) b.step(DT, { throttle: 0.62, steer: 0.34 });
  assert.ok(!b.sliding, 'the tyres are still in the road, so nothing else is choosing the rate');
  const lean = b.lean, rate = Math.abs(b.yawRate), speed = b.speed;
  assert.ok(lean > 0.1, `it is over ${(lean * DEG).toFixed(0)} degrees, which is how a motorcycle turns`);
  assert.ok(rate > 0.02, `and going round at ${(rate * DEG).toFixed(1)} degrees a second`);
  // tan(lean) = v^2/(gR), read as a rate: omega = g tan(lean) / v.
  const want = (G * Math.tan(lean)) / speed;
  assert.ok(Math.abs(rate / want - 1) < 0.12, `the rate is ${(rate / want).toFixed(2)} of the ${(want * DEG).toFixed(1)} deg/s that lean buys at ${speed.toFixed(0)} m/s`);
  const radius = speed / rate;
  assert.ok(Math.abs(radius - (speed * speed) / (G * Math.tan(lean))) / radius < 0.12,
    `the circle it is tracing is ${radius.toFixed(0)} m across, and the lean says ${((speed * speed) / (G * Math.tan(lean))).toFixed(0)} m`);
});

test('the tyres set the limit, and asking for more of a turn than they have is a slide', () => {
  const spec = bikeSpec('roadster');
  const b = rolling('roadster', 130);
  const v = b.speed;
  const ceiling = spec.gripAccel / v;
  // Full lock at a hundred and thirty: the machine cannot turn faster than mu*g/v however hard it is asked.
  for (let t = 0; t < 5; t += DT) b.step(DT, { throttle: 0.4, steer: 1 });
  assert.ok(Math.abs(b.yawRate) <= ceiling * 1.02,
    `the turn rate ${(b.yawRate * DEG).toFixed(1)} deg/s is under the ${(ceiling * DEG).toFixed(1)} deg/s the tyres allow at ${v.toFixed(0)} m/s`);
  assert.ok(Math.abs(b.lean) <= spec.maxLean + 1e-9, `and it is no further over than the ${(spec.maxLean * DEG).toFixed(0)} degrees the machine allows`);
  // The same full lock at walking pace is a tight circle, because the grip has so much less to do.
  const slow = rolling('roadster', 25);
  for (let t = 0; t < 4; t += DT) slow.step(DT, { throttle: 0.2, steer: 1 });
  assert.ok(Math.abs(slow.yawRate) > ceiling * 1.5,
    `at ${(slow.speed * KMH).toFixed(0)} km/h the same lock turns at ${(slow.yawRate * DEG).toFixed(0)} deg/s: the radius is what changes, not the hand`);
  // And at that speed the limit is the grip rather than the lean, which is the same ceiling from below.
  const slowSpec = bikeSpec('roadster');
  assert.ok(Math.abs(slow.yawRate) < slowSpec.gripAccel / slow.speed * 1.02, 'and no further than the tyres at that speed allow');
});

test('each machine\'s top speed is what its power and its drag agree on', () => {
  for (const kind of Object.keys(BIKES)) {
    const spec = bikeSpec(kind);
    const b = standing(kind);
    for (let t = 0; t < 120; t += DT) b.step(DT, { throttle: 1 });
    assert.ok(Math.abs(b.speed / spec.vmax - 1) < 0.06,
      `${kind}: ${(b.speed * KMH).toFixed(0)} km/h against the ${(spec.vmax * KMH).toFixed(0)} its ${(spec.power / 1000).toFixed(0)} kW and ${spec.cda} m^2 of rider give`);
    assert.ok(b.gear === spec.gears.length, 'and it got there in top gear');
    assert.ok(b.rpm > spec.redline * 0.55, `with the engine turning at ${b.rpm.toFixed(0)} rpm of a ${spec.redline} redline`);
  }
  // A scooter is a scooter and a big twin is a big twin: the numbers a rider would quote.
  assert.ok(bikeSpec('scooter').vmax * KMH < 115, 'a scooter tops out under 115 km/h');
  assert.ok(bikeSpec('cruiser').vmax * KMH > bikeSpec('scooter').vmax * KMH * 1.4, 'a cruiser leaves it behind');
});

test('it accelerates like the machine it is, and stops like one too', () => {
  const b = standing('roadster');
  let t = 0, hundred = null;
  for (; t < 30; t += DT) { b.step(DT, { throttle: 1 }); if (hundred === null && b.speed * KMH >= 100) hundred = t; }
  assert.ok(hundred > 3.5 && hundred < 7, `a 55 kW roadster with a rider on it does 100 km/h in ${hundred.toFixed(1)} s`);
  const scooter = standing('scooter');
  let t2 = 0;
  for (; t2 < 40; t2 += DT) { scooter.step(DT, { throttle: 1 }); if (scooter.speed * KMH >= 60) break; }
  assert.ok(t2 < 12, `and a scooter does 60 km/h in ${t2.toFixed(1)} s, which is all anybody asks of one`);
  // Braking: a motorcycle stops harder than a car because there is so much less of it to stop.
  const fast = rolling('roadster', 100);
  const before = fast.distance, v0 = fast.speed;
  let tb = 0;
  for (; tb < 20 && fast.speed > 0.5; tb += DT) fast.step(DT, { brake: 1 });
  const metres = fast.distance - before;
  assert.ok(metres < 55, `from 100 km/h it stops in ${metres.toFixed(0)} m`);
  assert.ok((v0 * v0) / (2 * metres) > 6, `which is ${((v0 * v0) / (2 * metres)).toFixed(1)} m/s2 of deceleration`);
  assert.ok(!fast.fallen, 'and it does not fall over doing it, upright as it is');
});

test('a machine at rest is held up by a rider, and only past recovery does it go down', () => {
  const b = standing('roadster');
  for (let t = 0; t < 5; t += DT) b.step(DT, {});
  assert.ok(!b.fallen, 'an upright machine at rest stays upright');
  assert.ok(b.footDown, 'and there is a foot down, which is what is holding it');
  assert.equal(b.speed, 0, 'it has not crept anywhere');
  // Leaned a little — walking it out of a parking space — it is still caught.
  const leaned = standing('roadster');
  leaned.lean = 0.14;
  for (let t = 0; t < 3; t += DT) leaned.step(DT, {});
  assert.ok(!leaned.fallen, 'eight degrees over at rest is a machine being walked, not one falling');
  assert.ok(Math.abs(leaned.lean) < 0.14, 'and it comes back towards upright while somebody is holding it');
  // Past the angle nobody catches, it is on its side.
  const over = standing('roadster');
  over.lean = 0.7;
  let t = 0;
  for (; t < 5 && !over.fallen; t += DT) over.step(DT, {});
  assert.ok(over.fallen, `forty degrees over at rest is on the ground in ${t.toFixed(2)} s`);
  assert.ok(!over.footDown, 'with no foot under it any more');
  const after = over.speed;
  for (let i = 0; i < 240 * 2; i++) over.step(DT, { throttle: 1 });
  assert.ok(over.speed < after + 1, 'a machine on its side does not drive off under throttle');
  // And it can be picked up, which is what a rider does next.
  over.right();
  assert.ok(!over.fallen, 'R picks it up');
  assert.equal(over.lean, 0, 'and it is standing square again');
  over.step(DT, { throttle: 0.4 });
  assert.ok(!over.fallen, 'and it can be ridden away');
});

test('below a walking pace the bars do nothing, because there is no circle to trace', () => {
  const b = standing('roadster');
  for (let t = 0; t < 3; t += DT) b.step(DT, { steer: 1, throttle: 0 });
  assert.ok(Math.abs(b.yawRate) < 1e-9, 'a machine that is not moving does not turn however hard the bars are');
  assert.ok(Math.abs(b.lean) < 1e-9, 'and it does not lean either: the lean belongs to the turn');
  // Which is why a tight parking-lot circle is done at a walking pace with the body, not with the bars.
  const slow = standing('roadster');
  for (let t = 0; t < 8; t += DT) slow.step(DT, { throttle: 0.1, steer: 1 });
  assert.ok(slow.speed > 0.5, 'a little throttle gets it moving');
  assert.ok(Math.abs(slow.yawRate) > 0.05, `and then the same lock turns it at ${(slow.yawRate * DEG).toFixed(0)} deg/s`);
});

test('the gearbox follows the road speed, and the fuel goes with the throttle', () => {
  const spec = bikeSpec('roadster');
  const b = standing('roadster');
  assert.equal(b.gear, 1, 'it starts in first');
  assert.equal(b.fuelKg, spec.tank, 'with a full tank');
  const shifts = [];
  let last = b.gear;
  for (let t = 0; t < 30; t += DT) {
    b.step(DT, { throttle: 1 });
    if (b.gear !== last) { shifts.push([b.gear, b.speed * KMH]); last = b.gear; }
  }
  assert.equal(shifts.length, spec.gears.length - 1, `it went through all ${spec.gears.length} gears`);
  for (let i = 1; i < shifts.length; i++) {
    assert.ok(shifts[i][1] > shifts[i - 1][1], 'each shift is at a higher road speed than the one before');
  }
  // A close-ratio box on a machine that revs: first gear is good for most of a city's speed limit, which
  // is exactly what makes a 600 feel like a 600.
  assert.ok(shifts[0][1] > 45 && shifts[0][1] < 105, `first to second at ${shifts[0][1].toFixed(0)} km/h`);
  // In a given gear the tacho is the road speed by a fixed ratio, which is what a chain and a gearbox are.
  const held = rolling('roadster', 100);
  const gear = held.gear, rpm = held.rpm, speed = held.speed;
  held.step(DT, { throttle: 0.5 });
  assert.equal(held.gear, gear, 'still in the same gear');
  assert.ok(Math.abs(held.rpm / rpm - held.speed / speed) < 0.02, 'and the revs are the road speed by the same ratio');
  // Fuel: half an hour of riding is a few litres, because the tank is emptied by the work done and not
  // by the throttle position — and an empty tank is a push home.
  const cruise = rolling('roadster', 110);
  const full = cruise.fuelKg, distBefore = cruise.distance;
  for (let t = 0; t < 1800; t += DT) cruise.step(DT, { throttle: 0.45 });
  const used = full - cruise.fuelKg;
  const per100 = used / ((cruise.distance - distBefore) / 1000) * 100;
  assert.ok(used > 1.5, 'half an hour of riding has used something');
  assert.ok(per100 > 3 && per100 < 14, `and the figure a rider would quote is ${per100.toFixed(1)} L/100 km, which is what a big single-track does at speed`);
  assert.ok(cruise.speed * KMH > 80, `still going ${(cruise.speed * KMH).toFixed(0)} km/h at the end of it`);
  const dry = standing('roadster');
  dry.refuel(0);
  for (let t = 0; t < 20; t += DT) dry.step(DT, { throttle: 1 });
  assert.ok(dry.speed < 0.5, 'a machine with no fuel does not drive');
  dry.refuel();
  assert.equal(dry.fuelKg, spec.tank, 'and a refill puts the tank back');
});

test('each tank is worth the hours a tank is worth, and an empty one is a push', () => {
  for (const kind of Object.keys(BIKES)) {
    const spec = bikeSpec(kind);
    const b = rolling(kind, Math.min(90, spec.vmax * KMH * 0.7));
    const from = b.fuelKg, d0 = b.distance;
    let t = 0;
    for (; t < 5400 && b.fuelKg > 0; t += DT) b.step(DT, { throttle: 0.4 });
    const range = ((b.distance - d0) / 1000) * (from / Math.max(1e-6, from - b.fuelKg));
    assert.ok(b.fuelKg === 0 || t > 5400, 'the tank is not bottomed in a couple of hours of steady riding');
    assert.ok(range > 90, `${kind}: a full tank is worth about ${range.toFixed(0)} km at a steady ${(b.speed * KMH).toFixed(0)} km/h`);
    // Out of fuel is out of fuel: the engine stops and the machine rolls to a halt.
    const dry = standing(kind);
    dry.refuel(0);
    assert.equal(dry.fuelKg, 0, 'the tank is empty');
    for (let i = 0; i < 240 * 15; i++) dry.step(DT, { throttle: 1 });
    assert.ok(dry.speed < 0.5, `${kind} with no fuel does not drive, however hard the throttle is`);
    dry.refuel();
    assert.equal(dry.fuelKg, spec.tank, 'and a refill puts the whole tank back');
  }
});

test('it runs straight with the hands off, which is the only reason two wheels work', () => {
  const b = rolling('roadster', 120);
  const before = b.yaw, lean = b.lean;
  for (let t = 0; t < 8; t += DT) b.step(DT, { throttle: 0.4 });
  assert.ok(Math.abs(((b.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.02,
    `eight seconds with nothing on the bars moved the heading ${(((b.yaw - before + Math.PI * 3) % (Math.PI * 2)) - Math.PI).toFixed(4)} rad`);
  assert.ok(Math.abs(b.lean - lean) < 0.02, 'and left the machine as upright as it was');
  assert.ok(!b.sliding, 'with the tyres still in the road');
});

test('the lean is the same sign as the turn, and as the aeroplane\'s roll', () => {
  // One attitude convention for both machines: a positive lean and a positive yaw are the same direction,
  // which is the direction `controls.steer` positive has meant since the first car.
  const b = rolling('roadster', 100);
  const before = b.yaw;
  for (let t = 0; t < 3; t += DT) b.step(DT, { throttle: 0.5, steer: 1 });
  assert.ok(b.lean > 0.1, `a positive steer leans it ${(b.lean * DEG).toFixed(0)} degrees`);
  assert.ok(b.yaw > before, 'and turns the way it leaned');
  const axes = basisFromAttitude(b.yaw, b.pitch, b.lean);
  assert.ok(axes.lateral[1] < -0.1, `with that side down: the lateral axis is at y ${axes.lateral[1].toFixed(2)}`);
  // The quaternion the renderer is given is the attitude the machine is in, from the shared helper.
  const q = b.renderQuat;
  assert.equal(q.length, 4, 'four numbers');
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  assert.ok(Math.abs(n - 1) < 1e-9, `and a unit one (${n.toFixed(9)})`);
  const other = rolling('roadster', 100);
  const otherBefore = other.yaw;
  for (let t = 0; t < 3; t += DT) other.step(DT, { throttle: 0.5, steer: -1 });
  assert.ok(other.lean < -0.1, 'and the other way round leans it the other way');
  assert.ok(other.yaw < otherBefore, 'and turns the other way with it');
});

test('the seat, the wheels and the ground agree about where the machine is', () => {
  const b = standing('cruiser');
  const spec = b.spec;
  assert.ok(Math.abs(b.seatPos[1] - (LAND + spec.seat)) < 1e-9, `the saddle is ${spec.seat} m above the ground it stands on`);
  assert.ok(Math.abs(b.pos[1] - (LAND)) < 1e-9, 'and the machine\'s own origin is on that ground, between the contact patches');
  // A hill tilts it, which is what makes a motorcycle on a cambered road a different problem from a car.
  const slope = createBike(spec, { x: 0, y: 0, z: 0, yaw: 0, ground: (x, z) => 1.2 + z * 0.1 });
  for (let t = 0; t < 2; t += DT) slope.step(DT, {});
  assert.ok(Math.abs(slope.pitch) > 0.02, `a 1 in 10 slope pitches it ${(slope.pitch * DEG).toFixed(1)} degrees`);
  assert.ok(Math.abs(slope.pos[1] - (1.2 + slope.pos[2] * 0.1)) < 1e-9, 'and it is standing on the hill rather than in it');
  // Wheel spin for a wheel that is turning: the animation of a spoke is the road speed over the radius.
  const rollingBike = rolling('roadster', 60);
  const spin = rollingBike.wheelSpin;
  rollingBike.step(DT, { throttle: 0.4 });
  assert.ok(rollingBike.wheelSpin - spin > (rollingBike.speed / spec.wheelR) * DT * 0.9, 'the wheels turn at the speed the road is going past');
});
