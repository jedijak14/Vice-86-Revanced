// The fleet: hulls where the city put water, and a hand on a gunwale.
//
// Boats cost no download — the hull is lofted in game/boats.js and the floating is physics/boat.js — so
// what a test can hold is the mooring: a marina's boat lies in its water and not on its hard standing,
// the fleet steps whether or not a renderer exists, and the nearest boat is within reach of a hand or
// it is not offered at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoats, hullBuilder } from '../../web/src/game/boats.js';
import { boatSpec } from '../../web/src/physics/boat.js';

/** A coast with water in a disc around (40, 40) and a marina door at its edge. */
const field = (x, z) => (Math.hypot(x - 40, z - 40) < 30 ? { kind: 'water' } : { kind: 'lot' });
const plan = { landmarks: [{ kind: 'marina', pos: [40, 12] }, { kind: 'boatyard', pos: [40, 66] }, { kind: 'cafe', pos: [40, 40] }] };

test('a marina keeps boats in its water, and a cafe keeps none', () => {
  const fleet = createBoats({ plan, field, water: () => 0 });
  assert.equal(fleet.count, 2, 'two waterside landmarks, two boats; the cafe is not a harbour');
  for (const entry of fleet.boats) {
    assert.equal(field(entry.boat.pos[0], entry.boat.pos[2]).kind, 'water', 'moored in the water, not on the hard');
    assert.ok(Math.abs(entry.boat.pos[1] + entry.boat.spec.draft) < 0.06, 'and floating at her draft');
  }
});

test('page-side plan landmarks use x/z coordinates and malformed records are skipped', () => {
  const pagePlan = { landmarks: [
    { kind: 'marina', x: 40, z: 12 },
    { kind: 'boatyard', x: 40, z: 66 },
    { kind: 'marina' },
    null,
    { kind: 'cafe', x: 40, z: 40 },
  ] };
  const fleet = createBoats({ plan: pagePlan, field, water: () => 0 });
  assert.equal(fleet.count, 2, 'the page plan creates boats for valid waterside landmarks only');
  for (const entry of fleet.boats) {
    assert.equal(field(entry.boat.pos[0], entry.boat.pos[2]).kind, 'water');
  }
});

test('a hand reaches the nearest gunwale, and no further', () => {
  const fleet = createBoats({ plan, field, water: () => 0 });
  const b = fleet.boats[0].boat;
  const near = fleet.nearestTo(b.pos[0] + 2, b.pos[2], 3.4);
  assert.ok(near, 'two metres off the beam is a boat you can board');
  assert.equal(near.id, fleet.boats[0].id);
  assert.equal(fleet.nearestTo(b.pos[0] + 30, b.pos[2], 3.4), null, 'thirty metres is not within reach of a hand');
});

test('the fleet steps moored and driven, and a driven boat leaves her mooring', () => {
  const fleet = createBoats({ plan, field, water: () => 0 });
  const at = [fleet.boats[0].boat.pos[0], fleet.boats[0].boat.pos[2]];
  for (let t = 0; t < 5; t += 1 / 60) fleet.step(1 / 60);
  assert.ok(Math.hypot(fleet.boats[0].boat.pos[0] - at[0], fleet.boats[0].boat.pos[2] - at[1]) < 0.5, 'a moored boat stays moored');
  for (let t = 0; t < 10; t += 1 / 60) fleet.step(1 / 60, 0, { throttle: 1, steer: 0 });
  const gone = Math.hypot(fleet.boats[0].boat.pos[0] - at[0], fleet.boats[0].boat.pos[2] - at[1]);
  assert.ok(gone > 10, `ten seconds of throttle moves her ${gone.toFixed(0)} m`);
  assert.ok(fleet.boats[1].boat.speed < 0.1, 'the other boat never felt it');
});

test('the hull is a closed mesh of a few hundred triangles, not a download', () => {
  const b = hullBuilder(boatSpec());
  const data = b.finish();
  assert.ok(data.vertexCount > 40 && data.vertexCount < 600, `${data.vertexCount} vertices in a skiff`);
  const tris = data.indexCount / 3;
  assert.ok(tris > 60 && tris < 500, `and ${tris} triangles of hull, double-wound and all`);
});
