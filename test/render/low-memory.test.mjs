// The small-memory budget: what a device with 3 GB shared between the operating system, every tab and the
// picture is given instead. The user asking for this has an iPad like that, so the promise these tests hold
// is narrow and specific: the buffers shrink, the street does not disappear, and nobody has to take the
// browser's word for how much memory a machine has. Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuality } from '../../web/src/render/quality.js';
import { atlasSize } from '../../web/src/render/atlas.js';
import { memoryWanted, applyMemoryMode } from '../../web/src/ui/settings.js';
import { describeGraphics } from '../../web/src/ui/detect.js';
import { ATLAS_SIZE as ATLAS_NOMINAL } from '../../web/src/world/signs.js';

test('the memory budget caps what stays allocated between frames, and not the maths', () => {
  const rich = resolveQuality({ preset: 'high' });
  const small = resolveQuality({ preset: 'high', lowMemory: true });
  assert.equal(small.lowMemory, true, 'the renderer is never told the device is short of memory');
  assert.ok(small.resolutionScale <= 0.5, `internal resolution still ${small.resolutionScale}`);
  assert.ok(small.resolutionScale < rich.resolutionScale, 'the picture is the same size either way');
  assert.ok(small.particles.max <= 256 && small.particles.max < rich.particles.max, 'the particle arena is unchanged');
  assert.ok(small.lights.maxLights <= 96 && small.lights.maxLights < rich.lights.maxLights, 'the light grid is unchanged');
  assert.equal(small.lights.sizeFar, 0, 'the far light grid is still allocated');
  assert.ok(small.shadows.size <= 1024 && small.shadows.cascades <= 2, `shadow maps still ${small.shadows.size}² × ${small.shadows.cascades}`);
  assert.ok(small.reflections.probe === 0 && small.reflections.planar === 0, 'the street keeps its reflection targets');
  assert.ok(small.reflections.roomProbe > 0, 'a closed room lost its probe: the memory budget is not supposed to be blind');
  assert.equal(small.motionBlur.taps, 0, 'a pass that keeps a whole frame around was kept');
  assert.notEqual(small.antialiasing, 'taa', 'temporal antialiasing kept its history buffers');
  // What costs nothing to keep is kept: the light, the road, the crowd and the sky are all still there.
  assert.ok(small.ao.taps > 0, 'the memory budget turned a screen-space pass off for no reason');
  assert.ok(small.bloom.mips > 0, 'bloom went away, and bloom is a handful of small mips');
  assert.ok(small.detail > 0, 'micro detail was dropped: that is a slow-machine decision, not a small-memory one');
});

test('a preset that has already been cut to nothing is not cut twice', () => {
  // Ultra Low's own cuts (render/quality.js ULTRA_LOW) are the tighter of the two on purpose, so a device
  // that is both slow and small must not end up below what Ultra Low alone promises, nor above its budget.
  const flat = resolveQuality({ preset: 'ultraLow' });
  const small = resolveQuality({ preset: 'ultraLow', lowMemory: true });
  assert.equal(small.lights.maxLights, flat.lights.maxLights, 'the light grid moved under Ultra Low');
  assert.equal(small.particles.max, flat.particles.max, 'the particle arena moved under Ultra Low');
  assert.equal(small.shadows.size, flat.shadows.size, 'the shadow map moved under Ultra Low');
  assert.ok(small.resolutionScale <= flat.resolutionScale, 'the small-memory device got a bigger picture');
  assert.equal(small.lowMemory, true, 'Ultra Low alone was allowed to claim the memory budget');
});

test('the sign atlas is sized for the machine, and every glyph still fits', () => {
  assert.equal(atlasSize({}), 4096, 'a desktop was given a small atlas');
  assert.equal(atlasSize({ preset: 'low' }), 2048, 'Low still pays for a 4096 texture');
  assert.equal(atlasSize({ preset: 'medium', lowMemory: true }), 2048, 'a 3 GB tablet was given the full atlas');
  assert.equal(atlasSize({ preset: 'ultraLow', lowMemory: true }), 1024, 'the smallest device was not given the smallest atlas');
  // The packer works in the nominal 4096 grid and scales it into whatever canvas it is handed (world/signs.js),
  // so a small canvas is a soft sign rather than a missing one: each step down is a whole-number reduction.
  assert.equal(ATLAS_NOMINAL / 1024, 4, 'the smallest atlas is not a whole-number reduction of the nominal grid');
});

test('memory mode: the player\'s choice beats the device\'s, and Auto obeys the device', () => {
  assert.equal(memoryWanted('auto', true), true);
  assert.equal(memoryWanted('auto', false), false);
  assert.equal(memoryWanted('low', false), true, 'an order to shrink was overruled by the device');
  assert.equal(memoryWanted('full', true), false, 'an order to stop shrinking was overruled by the device');
  assert.equal(memoryWanted(undefined, true), true, 'an unset mode is Auto, and Auto follows the device');

  const settings = { graphics: { memoryMode: 'auto' } };
  assert.equal(applyMemoryMode(settings, true), true, 'the flag did not reach the graphics settings');
  assert.equal(settings.graphics.memoryDetected, true, 'the device\'s answer was not remembered');
  settings.graphics.memoryMode = 'full';
  assert.equal(applyMemoryMode(settings) , false, 'the panel\'s choice was ignored on the next apply');
  assert.equal(settings.graphics.memoryDetected, true, 're-deriving without a new measurement lost the device');
});

test('an iPad that will not say its memory is treated as a small one, and a desktop is not', () => {
  const apple = { renderer: 'Apple GPU' };
  const tablet = describeGraphics(apple, { touch: true, ios: true, hardwareConcurrency: 6 });
  assert.equal(tablet.lowMemory, true, 'a 3 GB iPad on Safari was promised the full budget');
  const desktop = describeGraphics({ renderer: 'NVIDIA GeForce RTX 4070' }, { touch: false, hardwareConcurrency: 12 });
  assert.equal(desktop.lowMemory, false, 'a desktop with no reported memory was treated as small');
  const big = describeGraphics(apple, { touch: true, ios: true, deviceMemory: 8, hardwareConcurrency: 8 });
  assert.equal(big.lowMemory, false, 'a device that says it has 8 GB was still treated as small');
  const small = describeGraphics({ renderer: 'Adreno (TM) 630' }, { touch: true, deviceMemory: 3, hardwareConcurrency: 8 });
  assert.equal(small.lowMemory, true, '3 GB reported by the browser was not enough to trigger the budget');
  const tight = describeGraphics({ renderer: 'NVIDIA GeForce GTX 1060' }, { deviceMemory: 2, hardwareConcurrency: 4 });
  assert.equal(tight.lowMemory, true, 'a 2 GB desktop was not included');
  assert.ok(tight.reasons.some((r) => /memory/i.test(r)), 'no reason was given for the memory decision');
});
