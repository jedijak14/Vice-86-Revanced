// Health and breath: the two tanks, and the rules that drain them.
//
// The numbers are the contract: a held breath lasts OXYGEN_SECONDS under the surface and comes back in
// REFILL_SECONDS at it; drowning is a wound once the lung is empty; a fall prices itself by the m/s it
// arrived at; and health returns only while the street is leaving him alone, because a man who heals
// through a firefight is a man the firefight cannot touch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVitals, OXYGEN_SECONDS, REFILL_SECONDS, DROWN_RATE, FALL_SOFT } from '../../web/src/game/vitals.js';

test('a held breath lasts its advertised seconds, and comes back in a few gasps', () => {
  const v = createVitals();
  let t = 0;
  while (v.oxygen > 0 && t < 120) { v.breath(1 / 30, true); t += 1 / 30; }
  assert.ok(Math.abs(t - OXYGEN_SECONDS) < 0.1, `the tank ran ${t.toFixed(2)} s against a promise of ${OXYGEN_SECONDS}`);
  assert.ok(v.health > 0.99, 'holding your breath is not yet a wound, save the one gasp that ends it');
  let r = 0;
  while (v.oxygen < 1 && r < 30) { v.breath(1 / 30, false); r += 1 / 30; }
  assert.ok(Math.abs(r - REFILL_SECONDS) < 0.1, `the refill took ${r.toFixed(2)} s against ${REFILL_SECONDS}`);
});

test('an empty lung drowns: health goes after the oxygen, and the death names the water', () => {
  const deaths = [];
  const v = createVitals({ onDeath: (cause) => deaths.push(cause) });
  v.oxygen = 0;
  const before = v.health;
  v.breath(1, true);
  assert.ok(v.health < before, 'the water takes health once the breath is gone');
  assert.ok(Math.abs(before - v.health - DROWN_RATE) < 1e-9, 'at the published rate');
  for (let i = 0; i < 30; i++) v.breath(1, true);
  assert.equal(v.dead, true);
  assert.deepEqual(deaths, ['drown'], 'one death, named');
  assert.equal(v.snapshot().cause, 'drown');
  // The dead do not drown further, and do not breathe.
  const h = v.health;
  v.breath(5, true);
  assert.equal(v.health, h);
  v.revive(0.5);
  assert.equal(v.dead, false);
  assert.equal(v.oxygen, 1, 'coming to means coming up gasping');
});

test('a landing prices itself by the m/s it arrived at, and shrugs off a step down', () => {
  const hurts = [];
  const v = createVitals({ onHurt: (cause, amount) => hurts.push([cause, amount]) });
  assert.equal(v.fall(FALL_SOFT - 1), false, 'a step off a kerb is not a wound');
  assert.equal(v.health, 1);
  assert.equal(v.fall(FALL_SOFT + 4), true);
  assert.ok(v.health < 1, 'four m/s of arrival over the line costs something');
  assert.equal(hurts[0][0], 'fall');
});

test('health returns slowly, and not at all while the street is happening to him', () => {
  const v = createVitals();
  v.damage(0.8, 'shot');
  assert.ok(v.trouble > 0, 'a wound is trouble for a while');
  const hurt = v.health;
  v.tick(10, false);
  assert.equal(v.health, hurt, 'six seconds of trouble buy no healing');
  v.tick(60, false);
  assert.ok(v.health > hurt, 'quiet minutes close the wound slowly');
  const mid = v.health;
  v.tick(60, true);
  assert.equal(v.health, mid, 'wanted stars hold it open');
  v.heal(1);
  assert.equal(v.health, 1);
});

test('the snapshot is what a HUD can draw: hurt below the line, drowning at an empty lung', () => {
  const v = createVitals();
  let s = v.snapshot();
  assert.equal(s.hurt, false);
  assert.equal(s.drowning, false);
  v.damage(0.7, 'shot');
  s = v.snapshot();
  assert.equal(s.hurt, true);
  v.oxygen = 0;
  s = v.snapshot();
  assert.equal(s.drowning, true);
});
