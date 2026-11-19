// The wake field: water that remembers. A push dips, the dip rings outward, the ring dies, and a
// hull that keeps pushing leaves a wake behind it rather than a hole underneath it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWaterField } from '../../web/src/physics/waterfield.js';
import { createWaveSet, updateWaveSet, surfaceHeight } from '../../web/src/render/sky/waves.js';

test('a splash dips, then rings outward, then dies', () => {
  const f = createWaterField({});
  f.splash(0, 0, 3, -8);
  f.step(1 / 60, 0, 0);
  assert.ok(f.height(0, 0) < 0, 'the push is a dip under the hand');
  for (let i = 0; i < 90; i++) f.step(1 / 60, 0, 0);
  const ring = Math.abs(f.height(12, 0)) + Math.abs(f.height(-12, 0));
  assert.ok(ring > 1e-4, 'and ninety frames on, the ring has travelled');
  for (let i = 0; i < 900; i++) f.step(1 / 60, 0, 0);
  assert.ok(Math.abs(f.height(0, 0)) < 0.02, 'fifteen seconds later the basin has settled');
});

test('a moving hull leaves its wake behind it', () => {
  const f = createWaterField({});
  for (let i = 0; i < 240; i++) {
    f.step(1 / 60, 0, 0);
    f.splash(-20 + i * 0.15, 0, 2, -0.5);
  }
  const bow = f.height(-20 + 240 * 0.15, 0);
  const astern = f.height(-20 + 240 * 0.15 - 14, 0);
  const aside = f.height(-20 + 240 * 0.15, 24);
  assert.ok(Math.abs(astern) > Math.abs(aside), 'the disturbance is behind the hull, not beside the lane');
  assert.ok(bow <= 0.05, 'and the bow is not climbing a wall of its own making');
});

test('the window follows the action and forgets what slides out', () => {
  const f = createWaterField({});
  f.splash(0, 0, 3, -8);
  f.step(1 / 60, 0, 0);
  const before = f.height(0, 0);
  for (let i = 0; i < 30; i++) f.step(1 / 60, 400, 400);
  assert.ok(Math.abs(f.height(0, 0)) < 1e-6, 'four hundred metres away, the old dip is gone');
  f.splash(400, 400, 3, -8);
  f.step(1 / 60, 400, 400);
  assert.ok(f.height(400, 400) < 0, 'and the new centre takes a splash like any other');
  assert.ok(before < 0);
});

test('the CPU sea and its trains: calm glass, then weather', () => {
  const set = createWaveSet(10, 0x5ea1);
  updateWaveSet(set, 1, 0, 2, 0, 1 / 60, 0, 0);
  const calm = Math.abs(surfaceHeight(set, 10, 10)) + Math.abs(surfaceHeight(set, 40, -30));
  updateWaveSet(set, 1, 0, 16, 0.9, 1 / 60, 0, 0);
  let rough = 0;
  for (let i = 0; i < 40; i++) rough = Math.max(rough, Math.abs(surfaceHeight(set, i * 7, -i * 3)));
  assert.ok(calm < 0.35, `glassy water is nearly flat (${calm.toFixed(3)})`);
  assert.ok(rough > calm, 'and a storm lifts a hull metres, not millimetres');
});
