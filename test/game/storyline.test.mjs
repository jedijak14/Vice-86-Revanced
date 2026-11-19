// The storyline: jobs laid on a road graph, taken at a kerb, paid at a destination. These tests drive
// the module against a mock graph (no renderer, no purse beyond a counter), so what is checked is the
// story's own logic - that an offer is within reach, that taking it moves the marker, that arriving
// pays and advances, and that the next job is not the one just finished.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStoryline, JOBS, OFFER_REACH, ARRIVE_REACH } from '../../web/src/game/storyline.js';

/** A straight road lane 400 m long along +X at z = 0, the shape samplePoint and laneYaw want. */
function mockLane() {
  const pts = new Float32Array([0, 1.2, 0, 400, 1.2, 0]);
  return { id: 1, junction: false, junctionId: -1, length: 400, pts, cum: new Float32Array([0, 400]) };
}
function mockGraph() {
  const lane = mockLane();
  return { nearest: () => lane };
}
function mockPurse() {
  let cash = 0;
  return { cash: () => cash, add: (d) => { cash += d; }, canPay: () => true };
}

test('offers are laid on the road graph and spread across the map', () => {
  const st = createStoryline({ graph: mockGraph(), seed: 5, offers: 6 });
  assert.ok(st.offers.length >= 3, 'the street should have work on it');
  const xs = new Set(st.offers.map((o) => Math.round(o.x)));
  assert.ok(xs.size > 1, 'the offers should not all stand in one place');
  for (const o of st.offers) assert.ok(Number.isFinite(o.x) && Number.isFinite(o.z));
});

test('an offer is in hand only within reach, and only when no job is active', () => {
  const st = createStoryline({ graph: mockGraph(), seed: 5, offers: 6 });
  const o = st.offers[0];
  assert.equal(st.offerAt(o.x, o.z), o, 'standing on the beacon is standing on the job');
  assert.equal(st.offerAt(o.x + OFFER_REACH + 5, o.z), null, 'too far down the road is no offer');
});

test('taking a job moves the marker to a destination and arms the objective', () => {
  const st = createStoryline({ graph: mockGraph(), seed: 5, offers: 6 });
  const o = st.offers[0];
  const active = st.take(o);
  assert.ok(active, 'the job should be taken');
  assert.ok(active.objective.length > 0, 'the HUD needs a line to show');
  assert.ok(st.active === active);
  // A second offer is refused while a job is in hand: one job at a time.
  assert.equal(st.offerAt(st.offers[1].x, st.offers[1].z), null);
});

test('arriving at the destination pays the purse and advances the story', () => {
  const purse = mockPurse();
  const st = createStoryline({ graph: mockGraph(), purse, seed: 5, offers: 6 });
  const o = st.offers[0];
  const active = st.take(o);
  const pay = active.job.pay;
  // Stand on the marker: within ARRIVE_REACH the job is done.
  const hit = st.update(active.x, active.z);
  assert.equal(hit.kind, 'done');
  assert.equal(hit.pay, pay);
  assert.equal(purse.cash(), pay, 'the money should land in the pocket');
  assert.equal(st.completed, 1);
  assert.equal(st.earned, pay);
  assert.equal(st.active, null, 'the job is finished');
});

test('the next job is not the one just finished, so the story does not repeat in order', () => {
  const st = createStoryline({ graph: mockGraph(), seed: 5, offers: 6 });
  const first = st.take(st.offers[0]);
  st.update(first.x, first.z);              // finish it
  const second = st.take(st.offers[1]);
  assert.ok(second, 'there should be more work');
  // With six offers and five job kinds, the ring index advances, so the second job differs.
  assert.notEqual(second.job.id, first.job.id, 'the story should move on to a different kind of job');
});

test('a far-away destination reports the distance and keeps the job in hand', () => {
  const st = createStoryline({ graph: mockGraph(), seed: 5, offers: 6 });
  const active = st.take(st.offers[0]);
  const hit = st.update(active.x + ARRIVE_REACH + 50, active.z);
  assert.equal(hit.kind, 'active');
  assert.ok(hit.distance > ARRIVE_REACH);
  assert.ok(st.active, 'the job is not finished until the marker is reached');
});

test('the job kinds are a real ladder of pay and distance', () => {
  assert.ok(JOBS.length >= 4);
  for (const j of JOBS) {
    assert.ok(j.pay > 0 && j.dist > 0, `${j.id} should pay and send you somewhere`);
    assert.ok(typeof j.verb === 'string' && j.verb.length > 0);
  }
});
