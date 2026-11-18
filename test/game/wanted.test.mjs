// Tests for the wanted level: what is an offence, how the stars go up, and how they come down.
// The ledger is the record the agency keeps; Paloma PD (test/game/police.test.mjs) is the incident.
// Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WantedLedger, OFFENCES, STAR_STEPS, STAR_LABELS, MAX_STARS, starsForPoints,
  redLightEntered, forgiveness,
} from '../../web/src/game/wanted.js';

const FORGIVE = 55;   // seconds of quiet before one star is forgiven, at the first level

test('an offence is worth what the street thinks it is worth', () => {
  assert.ok(OFFENCES.speeding >= 1 && OFFENCES.speeding <= 2, 'speeding');
  assert.ok(OFFENCES['hit and run'] > OFFENCES['patrol car struck'], 'a run is not smaller than a scrape');
  assert.ok(OFFENCES.collision >= 2, 'a hit is not trivial');
  assert.ok(OFFENCES['peds scattered'] >= 1, 'driving at the crowd is nothing');
  for (const cause of Object.keys(OFFENCES)) {
    assert.ok(OFFENCES[cause] > 0 && OFFENCES[cause] <= 10, `${cause} has a silly weight`);
    assert.ok(STAR_LABELS.length === MAX_STARS + 1, 'the labels do not match the ladder');
  }
});

test('the ladder is monotone and every star is reachable', () => {
  assert.equal(STAR_STEPS.length, MAX_STARS);
  for (let i = 1; i < STAR_STEPS.length; i++) {
    assert.ok(STAR_STEPS[i] > STAR_STEPS[i - 1], 'star steps do not climb');
  }
  for (let s = 1; s <= MAX_STARS; s++) {
    assert.ok(starsForPoints(STAR_STEPS[s - 1]) >= s, `${STAR_STEPS[s - 1]} points did not buy star ${s}`);
    assert.ok(starsForPoints(STAR_STEPS[s - 1] - 1) < s, `star ${s} was bought too early`);
  }
  assert.equal(starsForPoints(0), 0, 'no points, some stars');
  assert.equal(starsForPoints(1e9), MAX_STARS, 'the ladder has a ceiling');
  assert.ok(WantedLedger.label(3).length > 3, 'star 3 has no label');
  assert.equal(WantedLedger.label(99), STAR_LABELS[MAX_STARS], 'a label ran off the ladder');
});

test('a ledger climbs, and forgives one level at a time', () => {
  // `hot` keeps the decay out of an assertion about the charges: heat means "somebody is after you",
  // which is exactly the state in which a record is not forgiven.
  const hot = { nearby: false, heat: 1 };
  const w = new WantedLedger();
  assert.equal(w.stars, 0);
  // One bit of speeding is a charge, not yet a star: points buy a level, an event does not.
  assert.equal(w.add('speeding'), false, 'a single offence should not buy the first star');
  assert.equal(w.points, OFFENCES.speeding, 'the charge was not kept');
  // The same charge again, at once, is worth less than the first: a stretch of speeding is one story.
  const before = w.points;
  w.add('speeding');
  const repeat = w.points - before;   // 30 % of a charge: same cause, same half-minute
  assert.ok(repeat > 0 && repeat < OFFENCES.speeding, `a repeat was worth ${repeat}`);
  w.step(31, hot);
  w.add('speeding');                       // half a minute later it is a fresh story again
  assert.ok(Math.abs(w.points - (before + repeat + OFFENCES.speeding)) < 1e-6, 'a later repeat was discounted');
  // Enough of it, and something worse, to climb.
  for (let i = 0; i < 12; i++) { w.step(31, hot); w.add('collision'); }
  assert.ok(w.stars >= 3, `only ${w.stars} stars after a dozen hits`);
  assert.ok(w.stars <= MAX_STARS, 'the ceiling was broken through');
  assert.ok(w.points >= STAR_STEPS[w.stars - 1], 'the level is not what the points are worth');
  // Quiet, and nobody nearby: it cools off, one star at a time, and never all at once.
  let last = w.stars, dropped = 0;
  for (let i = 0; i < 4000 && w.stars > 0; i++) {
    w.step(1, null);
    if (w.stars !== last) {
      assert.equal(w.stars, last - 1, `it fell from ${last} to ${w.stars}`);
      last = w.stars; dropped++;
    }
  }
  assert.equal(w.stars, 0, 'never forgiven');
  assert.ok(dropped >= 3, 'levels vanished in one go');
  assert.ok(w.raised >= 2, 'the ledger lost count of its own rises');
  assert.equal(w.lowered, dropped, 'the ledger lost count of its own falls');
});

test('the record does not decay while the street is still upset', () => {
  const w = new WantedLedger();
  for (let i = 0; i < 4; i++) { w.step(31, null); w.add('patrol car struck'); }
  const stars = w.stars;
  assert.ok(stars >= 3, `four struck cruisers bought ${stars}`);
  // A unit at the window: nothing is forgiven.
  for (let i = 0; i < 400; i++) w.step(1, { nearby: true, heat: 2 });
  assert.equal(w.stars, stars, 'a level went down with the police at the window');
  // Not nearby, but still being looked for: the timer holds instead.
  for (let i = 0; i < FORGIVE + 20; i++) w.step(1, { nearby: false, heat: 1 });
  assert.equal(w.stars, stars, 'a level went down while somebody was still after you');
  // Away, and nobody about: now it can forget.
  for (let i = 0; i < 600; i++) w.step(1, { nearby: false, heat: 0 });
  assert.ok(w.stars < stars, `nothing was forgiven in ten quiet minutes (${w.stars})`);
  assert.equal(forgiveness({ dt: 1, contact: true, heat: 0, sinceOffence: 900, stars: 1 }), 0, 'forgiveness with a unit nearby');
  assert.equal(forgiveness({ dt: 1, contact: false, heat: 2, sinceOffence: 900, stars: 1 }), 0, 'forgiveness during a pursuit');
  assert.ok(forgiveness({ dt: 1, contact: false, heat: 0, sinceOffence: 900, stars: 1 }) > 0, 'forgiveness on a quiet street');
  assert.ok(
    forgiveness({ dt: 1, contact: false, heat: 0, sinceOffence: 900, stars: 4 })
    < forgiveness({ dt: 1, contact: false, heat: 0, sinceOffence: 900, stars: 1 }),
    'a high level should be harder to shrug off',
  );
});

test('a clear is a clean sheet, not a negotiation', () => {
  const w = new WantedLedger();
  for (let i = 0; i < 12; i++) { w.step(31, null); w.add('hit and run'); }
  assert.equal(w.stars, MAX_STARS, `a dozen hit and runs bought ${w.stars}`);
  const snap = w.snapshot();
  assert.ok(snap.points >= STAR_STEPS[MAX_STARS - 1], 'the ledger lost the points');
  assert.equal(snap.stars, MAX_STARS);
  w.clear();
  assert.equal(w.stars, 0);
  assert.equal(w.points, 0);
  assert.equal(w.snapshot().cause, '', 'a cleared record still names a cause');
  // After a clear, a fresh charge is a fresh charge: full weight, and no repeat discount.
  assert.equal(w.add('no lights at night'), false, 'one point should not buy the first star');
  assert.equal(w.points, OFFENCES['no lights at night'], 'a cleared ledger will not start again');
  w.step(31, { nearby: false, heat: 1 });
  w.add('no lights at night');
  w.step(31, { nearby: false, heat: 1 });
  w.add('no lights at night');
  assert.ok(w.stars >= 1, `three charges and no star (${w.points})`);
});

test('running a red is something you did, not something you were near', () => {
  const control = { junction: 3, kind: 'signal', group: 0 };
  const lane = { junction: 3, control };
  const red = () => false;
  const green = () => true;
  assert.ok(redLightEntered(lane, 12, red, 9), 'a red run was missed');
  assert.equal(redLightEntered(lane, 12, green, 9), false, 'a green light was punished');
  assert.equal(redLightEntered(lane, 12, red, 0.4), false, 'sitting still was punished');
  assert.equal(redLightEntered({ junction: -1, control: null }, 12, red, 9), false, 'an uncontrolled junction was punished');
  assert.equal(redLightEntered({ junction: 3, control: { kind: 'stop', group: 0 } }, 12, () => false, 9), false, 'a stop sign was called a signal');
  assert.equal(redLightEntered(null, 12, red, 9), false, 'no lane, no charge');
});

test('the snapshot is what a HUD needs, and only that', () => {
  const hot = { nearby: false, heat: 1 };
  const w = new WantedLedger();
  const empty = w.snapshot();
  assert.equal(empty.stars, 0);
  assert.equal(empty.cause, '', 'a clean record should not name a cause');
  assert.equal(w.add('wrong way'), false, 'two points is not yet a star');
  assert.equal(w.snapshot().stars, 0, 'a record below one star was advertised');
  assert.equal(w.snapshot().cause, '', 'an unstarred record named a cause');
  // A different cause, at once, is a different story: no repeat discount, and one star.
  w.step(1, hot);
  assert.equal(w.add('collision'), true, 'a second, different charge did not buy a star');
  const s = w.snapshot();
  assert.equal(s.stars, 1, `four points and no star (${w.points})`);
  assert.equal(s.cause, 'collision');
  assert.equal(s.raised, 1, 'the change was not reported');
  assert.equal(s.lowered, 0);
  assert.ok(s.since >= 0 && s.since < 3, 'the clock is not kept');
  // A charge worth more than the rest buys more than one level at once.
  w.step(1, hot);
  assert.ok(w.add('red light', 8), 'a heavy charge was refused');
  assert.equal(w.snapshot().stars, 2, `twelve points should be two stars (${w.points})`);
  // Hand it back to a quiet street and let it forget, a level at a time.
  for (let i = 0; i < 40 && w.stars > 0; i++) w.step(100, null);
  assert.equal(w.stars, 0, `a level did not come down (${w.stars})`);
  const after = w.snapshot();
  assert.ok(after.lowered >= 2, 'a level going down was not reported');
  assert.equal(after.cause, '', 'a clean record still names a cause');
  assert.ok(after.since >= 0, 'the clock went backwards');
  assert.ok(JSON.stringify(after).length < 260, 'the snapshot is a heap of HUD');
});
