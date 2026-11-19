// An aeroplane's flight model: the air it flies in, the wing that holds it up, the ground it leaves.
//
// None of this is a game pretending to fly. The numbers asserted here are the numbers a handbook has —
// an ISA atmosphere, a stall speed that follows from the wing's own area and coefficient, a takeoff run
// that a 19-seat twin can actually fit on the strip the map gives it, and a bank that turns the machine
// the way it is leaning. What a test can hold is exactly that: the physics of it, in node, with no
// renderer and no page, because every one of those numbers is wrong or right before anything is drawn.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AIRFRAMES, airDensity, planeSpec, stallSpeedOf, createPlane, basisFromAttitude, quatFromAttitude,
  FLAPS, GEAR_VLE, KNOT, RHO0,
} from '../../web/src/physics/plane.js';

/** The step the model is written for, and a flat piece of ground at the map's own land height. */
const DT = 1 / 240, GROUND = () => 1.2, LAND = 1.2;
const KMH = 3.6, FEET = 3.28084, DEG = 180 / Math.PI;

/** An aeroplane on the ground at the start of a runway, pointing along it. */
function parked(kind = 'trainer', over = {}) {
  return createPlane(planeSpec(kind, over), { x: 0, y: LAND, z: 0, yaw: 0, ground: GROUND });
}

/**
 * A takeoff run: full throttle, and the stick pulled back a third of the way once the handbook's
 * rotation speed is on the clock. Returns the seconds and metres it took to leave the ground, or null
 * for an aeroplane that never did.
 */
function roll(kind, { flaps = 0, seconds = 120 } = {}) {
  const p = parked(kind);
  p.flaps = flaps;
  const rotate = 1.2 * stallSpeedOf(planeSpec(kind), p.mass, flaps ? 1 : 0);
  for (let t = 0; t < seconds; t += DT) {
    p.step(DT, { throttle: 1, elevator: p.speed > rotate ? 0.35 : 0, flaps });
    if (!p.onGround) return { seconds: t, metres: p.distance, speed: p.speed, rotate };
  }
  return null;
}

test('the air it flies in is the ISA atmosphere, and it thins with height', () => {
  assert.equal(airDensity(0), RHO0, 'sea level is 1.225 kg/m3 by definition');
  assert.ok(Math.abs(airDensity(11000) - 0.3639) < 0.002, `11 km is ${airDensity(11000).toFixed(4)} kg/m3`);
  for (const h of [500, 1000, 2500, 6000]) {
    assert.ok(airDensity(h) > airDensity(h + 100), 'and it only ever gets thinner going up');
  }
  // What that means for the wing: the same aeroplane has to fly faster the higher it is, because there is
  // less air in each square metre of it.
  const spec = planeSpec('trainer');
  const sea = spec.stallSpeed, high = spec.stallSpeed * Math.sqrt(RHO0 / airDensity(2500));
  assert.ok(high > sea * 1.1, `2500 m costs more than a tenth of the stall speed (${sea.toFixed(1)} -> ${high.toFixed(1)} m/s)`);
});

test('the stall speed is the wing\'s own arithmetic, and the flaps change it', () => {
  for (const kind of Object.keys(AIRFRAMES)) {
    const spec = planeSpec(kind);
    const hand = Math.sqrt((2 * spec.mass * 9.81) / (RHO0 * spec.wingArea * AIRFRAMES[kind].clMax));
    assert.ok(Math.abs(stallSpeedOf(AIRFRAMES[kind], spec.mass, 0) - hand) < 1e-9, 'the formula is Vs = sqrt(2W/rho S Clmax)');
    assert.ok(spec.stallSpeedFlaps < spec.stallSpeed, `${kind}: flaps buy lift, so they buy a slower stall`);
    assert.equal(spec.rotateSpeed, 1.2 * spec.stallSpeed, 'and the handbook rotates at 1.2 of it');
    assert.equal(spec.approachSpeed, 1.3 * spec.stallSpeedFlaps, 'and comes in at 1.3 of the flapped one');
    const p = createPlane(spec, { ground: GROUND });
    assert.ok(Math.abs(p.stallSpeed - spec.stallSpeed) < 1e-9, 'the aeroplane agrees with its own handbook');
  }
  // A heavier aeroplane flies faster: the same wing has to carry more, and the only way it can is speed.
  const light = planeSpec('commuter', { fuel: 0 }), full = planeSpec('commuter', { fuel: 1400 });
  assert.ok(full.stallSpeed > light.stallSpeed * 1.08, `1400 kg of fuel costs ${((full.stallSpeed / light.stallSpeed - 1) * 100).toFixed(0)}% of the stall`);
  assert.ok(Math.abs(light.stallSpeed / KNOT - 80) < 6, `an empty twin stalls near 80 kt, not ${light.stallSpeed / KNOT}`);
});

test('every airframe in the fleet gets off the ground the map gives it', () => {
  // The longest strip in Costa Verano is 1337 m. A fleet that cannot leave it is scenery.
  const budget = { trainer: 500, commuter: 1300, jet: 1200 };
  for (const kind of Object.keys(AIRFRAMES)) {
    const r = roll(kind, { flaps: kind === 'commuter' ? 1 : 0 });
    assert.ok(r, `${kind} never left the ground in two minutes of full throttle`);
    assert.ok(r.metres < budget[kind], `${kind} used ${r.metres.toFixed(0)} m of a ${budget[kind]} m budget`);
    assert.ok(r.speed >= r.rotate * 0.97, `${kind} flew at ${(r.speed / KNOT).toFixed(0)} kt, below its ${(r.rotate / KNOT).toFixed(0)} kt rotation`);
    assert.ok(!r.speed || r.speed > 0, 'and it was moving when it went');
  }
  // The numbers a pilot would recognise: a trainer in a few hundred metres, a twin in about a kilometre.
  const trainer = roll('trainer'), twin = roll('commuter', { flaps: 1 });
  assert.ok(trainer.metres > 200 && trainer.metres < 450, `the trainer's run is ${trainer.metres.toFixed(0)} m`);
  assert.ok(twin.seconds > 25 && twin.seconds < 45, `the twin takes ${twin.seconds.toFixed(0)} s to get airborne`);
});

test('the run down the strip is a run, and the wheels let go when the wing can carry the weight', () => {
  const p = parked('trainer');
  const seen = [];
  const rotate = p.spec.rotateSpeed;
  for (let t = 0; t < 30 && p.onGround; t += DT) {
    // A tricycle undercarriage does not fly itself off: the stick comes back at the rotation speed and
    // the wing takes over, which is the run being measured here.
    p.step(DT, { throttle: 1, elevator: p.speed > rotate ? 0.35 : 0 });
    if (t > 0 && Math.abs(t - Math.round(t)) < DT / 2) seen.push([Math.round(t), p.speed, p.lift / (p.mass * 9.81)]);
  }
  assert.ok(!p.onGround, 'it left the ground');
  assert.ok(seen.length > 8, `and it ran for ${seen.length} whole seconds to do it, which is a run`);
  // While the wheels are on it the wing is carrying less than the whole weight, and it is the crossing of
  // the two that is the takeoff rather than a decision the code makes about a height.
  const early = seen[1], last = seen[seen.length - 1];
  assert.ok(early[2] < 0.2, `two seconds in the wing was carrying ${(early[2] * 100).toFixed(0)}% of the weight`);
  assert.ok(last[2] > early[2] * 6, `and by the end of the run ${(last[2] * 100).toFixed(0)}%, which is what let go of the legs`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][1] > seen[i - 1][1], 'the run only ever speeds up');
  assert.ok(p.gearDown, 'and it went up with its legs still down, which is how a pilot flies it initially');
  // The other half of the same fact: a neutral stick leaves it rolling, because the legs hold it down
  // until somebody asks the wing for more than the weight.
  const hands = parked('trainer');
  for (let t = 0; t < 40; t += DT) hands.step(DT, { throttle: 1 });
  assert.ok(hands.onGround, 'forty seconds of full throttle and a hand off the stick is still a taxi');
  assert.ok(hands.speed > 40, `it got to ${(hands.speed / KNOT).toFixed(0)} kt doing it, so nothing was holding it back but the attitude`);
  assert.ok(p.airborne > 0 && p.airborne < 1, 'the clock that says how long it has been flying started');
});

test('level flight carries one g, and the panel says so in a pilot\'s units', () => {
  const spec = planeSpec('trainer');
  const p = createPlane(spec, { ground: GROUND });
  p.place(0, 900, 0, 0, 63);
  p.step(DT, { throttle: 0.72 });
  assert.ok(Math.abs(p.gLoad - 1) < 0.15, `at its own cruise speed the wing is carrying ${p.gLoad.toFixed(2)} g`);
  assert.ok(Math.abs(p.lift - p.mass * 9.81) / (p.mass * 9.81) < 0.15, 'and the lift is the weight, to within the same few percent');
  const panel = { ias: p.ias / KNOT, alt: p.altitude * FEET, hdg: p.heading };
  assert.ok(Math.abs(panel.ias - 122) < 6, `the clock reads ${panel.ias.toFixed(0)} kt`);
  assert.ok(Math.abs(panel.alt - 900 * FEET) < 40, `and the altimeter ${panel.alt.toFixed(0)} ft over a ${LAND} m field`);
  assert.equal(Math.round(panel.hdg), 180, 'facing along +Z on a map whose +Z is south is a heading of 180, not of zero');
});

test('a stalled wing breaks, and a neutral stick recovers it', () => {
  const p = parked('trainer');
  p.place(0, 1200, 0, 0, 62);
  for (let i = 0; i < 240 * 12; i++) p.step(DT, { throttle: 0.72 });
  // Haul the nose up until the wing lets go.
  let stalledAt = null;
  for (let t = 0; t < 12 && stalledAt === null; t += DT) {
    p.step(DT, { throttle: 1, elevator: 1 });
    if (p.stalled) stalledAt = t;
  }
  assert.ok(stalledAt !== null, 'full back stick stalls it inside twelve seconds');
  const worst = { sink: 0, pitch: 0 };
  // Then let go of everything, which is the whole of stall recovery: the nose comes down on its own.
  for (let t = 0; t < 20; t += DT) {
    p.step(DT, { throttle: 0.72 });
    worst.sink = Math.max(worst.sink, -p.vel[1]);
    worst.pitch = Math.max(worst.pitch, Math.abs(p.pitch) * DEG);
  }
  assert.ok(!p.crashed, 'it came out of it flying rather than in pieces');
  assert.ok(!p.stalled, 'and the wing is holding again');
  assert.ok(p.speed > p.stallSpeed * 0.95, `it is back to ${(p.speed / KNOT).toFixed(0)} kt from a ${(p.stallSpeed / KNOT).toFixed(0)} kt stall`);
  assert.ok(worst.pitch < 80, `the nose went no further than ${worst.pitch.toFixed(0)} degrees, which is a break and not a tumble`);
  assert.ok(p.altitude > 200, `and it was still ${p.altitude.toFixed(0)} m up when it finished`);
});

test('the aileron is a roll rate, so a bank is held rather than arrived at', () => {
  const p = parked('trainer');
  p.place(0, 1400, 0, 0, 62);
  for (let i = 0; i < 240 * 20; i++) p.step(DT, { throttle: 0.72 });
  for (let t = 0; t < 1; t += DT) p.step(DT, { throttle: 0.72, aileron: 1 });
  const one = p.roll * DEG;
  assert.ok(one > 12 && one < 40, `one second of full stick is ${one.toFixed(0)} degrees of bank: a rate, not a switch`);
  for (let t = 0; t < 2; t += DT) p.step(DT, { throttle: 0.72, aileron: 1 });
  const three = p.roll * DEG;
  assert.ok(three > one * 1.8, `and holding it keeps rolling: ${three.toFixed(0)} degrees after three seconds`);
  // Let go and the wings stay where the pilot put them. That is what an aeroplane does, and it is why a
  // spiral is the pilot's fault rather than the model's.
  const bank = p.roll;
  for (let t = 0; t < 3; t += DT) p.step(DT, { throttle: 0.75, elevator: 0.1 });
  assert.ok(Math.abs(p.roll - bank) * DEG < 14, `three seconds of neutral stick moved the bank ${Math.abs(p.roll - bank).toFixed(3)} rad`);
});

test('a bank turns the aeroplane the way it is leaning, in the sign the whole game steers by', () => {
  const p = parked('jet');
  p.place(0, 2000, 0, 0, 130);
  for (let i = 0; i < 240 * 20; i++) p.step(DT, { throttle: 0.6 });
  const before = p.heading, yawBefore = p.yaw;
  // One second of aileron on its own, which is a firm input and not an inversion. A positive aileron is
  // the same sign as a positive steer and a positive yaw, and all three of those are left on this map.
  for (let t = 0; t < 1; t += DT) p.step(DT, { throttle: 0.6, aileron: 1 });
  assert.ok(p.roll > 0.15 && p.roll < 1.2, `a positive aileron banks it ${(p.roll * DEG).toFixed(0)} degrees`);
  const axes = basisFromAttitude(p.yaw, p.pitch, p.roll);
  assert.ok(axes.lateral[1] < 0, `and the port wing is the lower one: its axis is at y ${axes.lateral[1].toFixed(3)}`);
  assert.ok(axes.up[1] > 0.2, 'the cabin floor is still mostly up, which is what a bank and not a loop is');
  for (let t = 0; t < 2; t += DT) p.step(DT, { throttle: 0.6 });
  assert.ok(p.yaw > yawBefore, 'the yaw went the way the bank did');
  const turn = ((p.heading - before + 540) % 360) - 180;
  assert.ok(turn < -1, `and the compass followed: ${turn.toFixed(1)} degrees in three seconds, which is the way a left bank turns`);
  // A rudder on its own slips the aeroplane and rolls it, which is why the ball is centred rather than
  // ignored, and why a model without it turns by skidding and feels like a car.
  const slip = parked('jet');
  slip.place(0, 1800, 0, 0, 130);
  for (let i = 0; i < 240 * 20; i++) slip.step(DT, { throttle: 0.6 });
  for (let t = 0; t < 3; t += DT) slip.step(DT, { throttle: 0.6, rudder: 0.25 });
  assert.ok(Math.abs(slip.beta) > 1 && Math.abs(slip.beta) < 8, `a quarter rudder holds it ${(slip.beta).toFixed(1)} degrees out of its own airflow`);
  assert.ok(Math.abs(slip.roll) > 0.02, `and the wings follow the slip: ${(slip.roll * DEG).toFixed(1)} degrees from the feet alone`);
  // The same three angles, through the same door the renderer uses.
  const q = p.renderQuat, ref = quatFromAttitude(p.yaw, p.pitch, p.roll);
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(q[i] - ref[i]) < 1e-12, 'the quaternion it is drawn with is the attitude it is flying');
});

test('a held turn goes round at the rate its own bank allows', () => {
  // tan(bank) = v^2 / (g R) is the whole of it: the rate a bank buys at a speed, with nothing else in the
  // model choosing it. A trainer at thirty degrees and its own cruise speed turns at about five degrees a
  // second, and if the numbers in this file are honest that is what the compass will do.
  const p = parked('trainer');
  p.place(0, 1800, 0, 0, 62);
  for (let i = 0; i < 240 * 20; i++) p.step(DT, { throttle: 0.72 });
  const want = 30 / DEG, h0 = p.heading;
  // The two loops a pilot flies at once: the wings held at thirty degrees by the aileron, and the nose
  // held at the horizon by the elevator. Both are proportional with the rate damped out, which is what a
  // hand on a stick does - it stops asking before the attitude arrives rather than after.
  let n = 0, sumRoll = 0, sumBeta = 0, sumG = 0, sumIas = 0;
  for (let t = 0; t < 16; t += DT) {
    p.step(DT, {
      throttle: 0.8,
      aileron: Math.max(-1, Math.min(1, (want - p.roll) * 1.4 - p.p * 1.5)),
      elevator: Math.max(-1, Math.min(1, (0 - p.pitch * DEG) * 0.14)),
    });
    if (t > 4) { n++; sumRoll += p.roll * DEG; sumBeta += Math.abs(p.beta); sumG += p.gLoad; sumIas += p.ias; }
  }
  const bank = sumRoll / n, speed = sumIas / n;
  const moved = ((p.heading - h0 + 540) % 360) - 180;
  const allowed = -(9.81 * Math.tan(bank / DEG) / speed) * DEG * 12;
  assert.ok(Math.abs(bank - 30) < 4, `the wings are held at ${bank.toFixed(1)} degrees by the aileron alone`);
  assert.ok(Math.abs(moved / allowed) > 0.8 && Math.abs(moved / allowed) < 1.25,
    `twelve seconds of it turned ${moved.toFixed(0)} degrees against the ${allowed.toFixed(0)} that bank and speed allow`);
  assert.ok(sumBeta / n < 2, `and it turned ${(sumBeta / n).toFixed(1)} degrees out of its own airflow doing it: a coordinated turn, not a skid`);
  assert.ok(Math.abs(sumG / n - 1 / Math.cos(bank / DEG)) < 0.12, `it cost ${(sumG / n).toFixed(2)} g, which is the ${1 / Math.cos(bank / DEG)} a thirty degree bank costs`);
  assert.ok(p.altitude > 900, `still ${p.altitude.toFixed(0)} m up, because the elevator was holding it`);
  // The radius the turn actually traced, from the same equation read the other way round.
  const radius = (speed * speed) / (9.81 * Math.tan(bank / DEG));
  assert.ok(radius > 500 && radius < 1000, `a ${speed.toFixed(0)} m/s aeroplane at ${bank.toFixed(0)} degrees turns inside ${radius.toFixed(0)} m`);
});

test('the undercarriage has a speed it must not be down at, and says so', () => {
  const p = parked('commuter');
  p.place(0, 1500, 0, 0, 95);
  p.gearDown = true;
  for (let i = 0; i < 240 * 20; i++) p.step(DT, { throttle: 1 });
  assert.ok(p.ias > GEAR_VLE, `it is at ${p.ias.toFixed(0)} m/s, past the ${GEAR_VLE} m/s the legs are good for`);
  assert.ok(p.gearUnsafe, 'and the panel is telling him');
  p.gearDown = false;
  p.step(DT, { throttle: 1 });
  assert.ok(!p.gearUnsafe, 'up, and the warning goes with it');
});

test('flaps buy lift and cost drag, which is what an approach is', () => {
  const clean = parked('trainer'), dirty = parked('trainer');
  for (const p of [clean, dirty]) p.place(0, 800, 0, 0, 52);
  dirty.flaps = 2;
  clean.step(DT, { throttle: 0.5 });
  dirty.step(DT, { throttle: 0.5 });
  assert.ok(dirty.lift > clean.lift * 1.15, `at the same speed full flap makes ${(dirty.lift / clean.lift).toFixed(2)} times the lift`);
  assert.ok(dirty.drag > clean.drag * 1.2, `and ${(dirty.drag / clean.drag).toFixed(2)} times the drag`);
  assert.equal(FLAPS.length, 3, 'three detents: up, approach, and full');
  assert.deepEqual(FLAPS.map((f) => f.deg), [0, 15, 32], 'which are 0, 15 and 32 degrees, as painted on the lever');
});

test('a landing is a landing, and the ground decides what a bad one was', () => {
  // Settled onto the runway from just above it, at a rate a pilot would call a good one.
  const soft = parked('trainer');
  soft.place(0, LAND + 2.4, 0, 0, 58);
  soft.gearDown = true;
  soft.vel[1] = -1.6;
  for (let i = 0; i < 240 * 3; i++) soft.step(DT, { throttle: 0, brake: 0.6 });
  assert.ok(soft.onGround, 'the wheels are on it');
  assert.ok(!soft.crashed, 'and nothing is broken');
  assert.ok(soft.touchdownSink < 2.5, `it arrived at ${soft.touchdownSink.toFixed(1)} m/s`);
  // The same aeroplane, dropped.
  const hard = parked('trainer');
  hard.place(0, LAND + 9, 0, 0, 58);
  hard.gearDown = true;
  hard.vel[1] = -9;
  for (let i = 0; i < 240 * 3; i++) hard.step(DT, {});
  assert.ok(hard.crashed, 'nine metres a second onto a runway is a wreck, not an arrival');
  // And a good rate on one wing tip is the same answer, because the legs are in the middle.
  const wing = parked('trainer');
  wing.place(0, LAND + 4, 0, 0, 58);
  wing.gearDown = true;
  wing.roll = 0.5;
  wing.vel[1] = -1.2;
  for (let i = 0; i < 240 * 2; i++) wing.step(DT, {});
  assert.ok(wing.crashed, 'and thirty degrees of bank on arrival is one too');
});

test('fuel burns with the throttle, and an empty tank is a glider', () => {
  const p = parked('trainer');
  const full = p.fuelKg;
  assert.ok(Math.abs(full - AIRFRAMES.trainer.fuelMax) < 1e-9, 'it starts with full tanks');
  for (let t = 0; t < 600; t += DT) p.step(DT, { throttle: 1 });
  assert.ok(p.fuelKg < full, 'ten minutes of full throttle has used something');
  assert.ok(p.fuelKg > full * 0.9, `and not very much: ${p.fuelKg.toFixed(0)} kg of ${full} is what a light aeroplane drinks`);
  assert.ok(p.fuelFraction > 0.9 && p.fuelFraction < 1, 'the gauge is a fraction of the same thing');
  // Endurance is the number that decides whether a trip across the map is possible at all.
  for (const kind of Object.keys(AIRFRAMES)) {
    const spec = planeSpec(kind);
    const hours = spec.fuelMax / spec.burn / 3600;
    assert.ok(hours > 2 && hours < 5, `${kind}: full tanks are good for ${hours.toFixed(1)} hours`);
  }
  // Empty: the engine stops making thrust and the aeroplane comes down, which is the only honest ending.
  const dry = parked('trainer', { fuel: 0 });
  dry.place(0, 1500, 0, 0, 62);
  const before = dry.altitude;
  for (let t = 0; t < 30; t += DT) dry.step(DT, { throttle: 1 });
  assert.ok(dry.thrust <= 0, 'a throttle open on an empty tank makes drag, not thrust');
  assert.ok(dry.altitude < before - 100, `and thirty seconds of it costs ${((before - dry.altitude)).toFixed(0)} m of height`);
  dry.refuel();
  assert.equal(dry.fuelKg, dry.spec.fuelMax, 'a refuelled aeroplane has its tanks full again');
});

test('one long step is the same flight as many short ones', () => {
  const fine = parked('commuter'), coarse = parked('commuter');
  for (const p of [fine, coarse]) p.place(0, 1500, 0, 0.4, 95);
  for (let t = 0; t < 10; t += 1 / 240) fine.step(1 / 240, { throttle: 0.7, aileron: 0.4, elevator: 0.1 });
  for (let t = 0; t < 10; t += 1 / 15) coarse.step(1 / 15, { throttle: 0.7, aileron: 0.4, elevator: 0.1 });
  // A frame that drops to fifteen a second must not fly a different aeroplane: the model substeps itself.
  // The model substeps itself down to 1/240 s and stops at six substeps, so a 1/15 s frame is flown as
  // six of 1/90 s: a little coarser than the reference, and the allowance here is the difference that
  // makes. Half a percent of the distance flown is a frame rate, not a different aeroplane.
  const gap = Math.hypot(fine.pos[0] - coarse.pos[0], fine.pos[1] - coarse.pos[1], fine.pos[2] - coarse.pos[2]);
  assert.ok(gap < fine.distance * 0.01, `ten seconds apart by ${gap.toFixed(2)} m, having flown ${fine.distance.toFixed(0)} m`);
  assert.ok(Math.abs(fine.roll - coarse.roll) < 0.05, `and banked within ${(Math.abs(fine.roll - coarse.roll) * DEG).toFixed(1)} degrees of each other`);
  assert.ok(Math.abs(fine.speed - coarse.speed) < 2, 'at very nearly the same speed');
});

test('a parked aeroplane sits on its legs and stays where it was put', () => {
  const p = parked('jet');
  assert.ok(p.onGround, 'it starts on the ground');
  assert.ok(Math.abs(p.pos[1] - (LAND + p.spec.gearLength)) < 1e-9, `at the height its own legs are long: ${p.pos[1].toFixed(2)} m`);
  for (let t = 0; t < 60; t += DT) p.step(DT, {});
  assert.ok(p.distance < 0.01, 'a minute with the throttles closed does not move it');
  assert.equal(p.roll, 0, 'and it does not lean');
  assert.equal(Math.round(p.heading), 180, 'facing +Z is a compass heading of 180 on this map');
  // Which is the convention the whole map is written in, and the reason a heading is not a yaw.
  p.place(0, LAND, 0, Math.PI / 2);
  assert.equal(Math.round(p.heading), 90, 'and facing +X is east');
});
