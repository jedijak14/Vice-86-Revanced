// The quality tiers, as a ladder rather than as four magic strings. Ultra Low was added below Low when
// rigged people arrived on the streets, and an extra rung is only worth having if everything Auto and the
// menus do with a preset still holds: the order, the monotonic walk up it, the floor below the tables,
// and a renderer that runs on the numbers instead of on the label.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PRESET_NAMES, PRESET_CHOICES, PRESETS, FALLBACK_PRESET, applyPreset, matchPreset, isPresetName, sanitizeValue, fieldOf, SCHEMA } from '../../web/src/ui/settings.js';
import { PRESET_DEFAULTS, resolveQuality, needsRebuild } from '../../web/src/render/quality.js';
import { PRESET_MIN_SCORE, describeGraphics } from '../../web/src/ui/detect.js';
import { guessTier } from '../../web/src/render/gl.js';
import { PEOPLE_BY_TIER } from '../../web/src/game/crowd.js';
import { parseOptions } from '../../web/src/game/automation.js';

const ORDERED = ['shadows', 'ao', 'reflections', 'lights', 'volumetrics', 'drawDistance', 'density', 'traffic', 'particles', 'bloom', 'motionBlur'];

test('Ultra Low is on every list a preset can be named from', () => {
  assert.deepEqual(PRESET_NAMES, ['ultraLow', 'low', 'medium', 'high', 'ultra'], 'Ultra is the top rung now; Ultra High is retired');
  assert.equal(PRESET_NAMES[0], 'ultraLow', 'and it is the bottom of the ladder Auto walks');
  assert.ok(PRESET_CHOICES.includes('ultraLow'));
  assert.ok(isPresetName('ultraLow'));
  assert.ok(PRESET_DEFAULTS.ultraLow, 'the renderer has defaults for it');
  assert.ok(PRESET_MIN_SCORE.ultraLow !== undefined, 'Auto knows what it is worth');
  assert.ok(PEOPLE_BY_TIER.ultraLow !== undefined, 'the crowd knows it too');
  assert.equal(guessTier('ANGLE (Apple, Apple M1, OpenGL 4.1)') === 'ultraLow', false, 'a real card is not demoted');
});

test('the preset row offers it in order, and the value round-trips', () => {
  const field = fieldOf('graphics', 'preset');
  const values = field.options.map((o) => o.value);
  assert.deepEqual(values.slice(0, 3), ['auto', 'ultraLow', 'low'], 'Auto, then the rungs weakest first');
  assert.equal(sanitizeValue(field, 'ultraLow'), 'ultraLow');
  assert.equal(sanitizeValue(field, 'ultra low'), undefined, 'a label is not a value');
  assert.equal(parseOptions('?quality=ultraLow').quality, 'ultraLow');
  assert.equal(parseOptions('?quality=ULTRALOW').quality, 'ultraLow', 'the query is case-folded, the setting is not');
  assert.equal(parseOptions('?quality=medium').quality, 'medium');
  assert.equal(parseOptions('?quality=ultra-low').quality, null, 'anything else is dropped, not guessed at');
});

test('Ultra Low is cheaper than Low on every dial, and never dearer on one', () => {
  const ul = PRESETS.ultraLow, lo = PRESETS.low;
  for (const key of ORDERED) {
    assert.ok(ul[key] <= lo[key], `${key}: Ultra Low ${ul[key]} should not exceed Low ${lo[key]}`);
  }
  assert.ok(ul.resolutionScale < lo.resolutionScale);
  assert.equal(ul.antialiasing, 'off');
  assert.equal(ul.shadows, 0, 'no shadow pass at all');
  assert.equal(ul.frameCap, 30, 'and the frame cap stops the game paying for frames nobody sees');
});

test('every step up the ladder turns something on and nothing off', () => {
  for (let i = 1; i < PRESET_NAMES.length; i++) {
    const a = PRESETS[PRESET_NAMES[i - 1]], b = PRESETS[PRESET_NAMES[i]];
    for (const key of ORDERED) assert.ok(b[key] >= a[key], `${PRESET_NAMES[i]}.${key} went down from ${a[key]} to ${b[key]}`);
    assert.ok(b.resolutionScale >= a.resolutionScale, 'resolution is never lower on a better preset');
  }
});

test('the renderer takes real numbers below the tables, not the tables\' floor', () => {
  const q = resolveQuality({ preset: 'ultraLow' });
  assert.equal(q.resolutionScale, 0.5);
  assert.equal(q.shadows.cascades, 0);
  assert.equal(q.reflections.steps, 0);
  assert.equal(q.antialiasing, 'off');
  assert.equal(q.detail, 0, 'micro detail off entirely');
  assert.equal(q.particles.max, 128, 'below the 384 of the tables\' level 0');
  assert.equal(q.lights.maxLights, 64, 'and fewer lights to bin');
  assert.ok(q.lights.perCell <= 32, 'still inside the shader cell capacity');
  const low = resolveQuality({ preset: 'low' });
  assert.ok(q.lights.sizeNear < low.lights.sizeNear);
  assert.ok(q.bloom.mips < low.bloom.mips);
  assert.equal(needsRebuild(low, q), true, 'switching to it rebuilds the render targets, as it must');
});

test('a custom preset sits on the same scales', () => {
  // The whole point of the tables is that a hand-set field is honoured; Ultra Low's cuts must not
  // leak into a Custom that borrowed one of its numbers.
  const custom = resolveQuality({ preset: 'custom', shadows: 0, lights: 0, particles: 0, ao: 0, reflections: 0, bloom: 0, motionBlur: 0, depthOfField: 0, drawDistance: 0, volumetrics: 0 });
  assert.equal(custom.lights.maxLights, 128, 'Custom at level 0 is Low at level 0');
  assert.equal(custom.particles.max, 384);
  const forcedDown = resolveQuality({ preset: 'ultraLow', particles: 2, lights: 2 });
  assert.equal(forcedDown.particles.max, 128, 'the Ultra Low budget holds even when a field says otherwise');
  assert.equal(forcedDown.lights.maxLights, 64);
});

test('Auto can choose it, and refuses to climb past it on a weak device', () => {
  const settings = { graphics: { preset: 'auto' } };
  const software = { deviceMemory: 8, hardwareConcurrency: 8, touch: false };
  const seen = describeGraphics({ renderer: 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device)', tierHint: 'ultraLow' }, software);
  assert.equal(seen.preset, 'ultraLow');
  assert.equal(seen.ceiling, 'ultraLow');
  applyPreset(settings, 'auto', seen.preset);
  assert.equal(settings.graphics.frameCap, 30);
  assert.equal(matchPreset(settings.graphics), 'ultraLow', 'the settings still name the preset they hold');
  assert.equal(sanitizeValue(fieldOf('graphics', 'preset'), 'auto'), 'auto');
  applyPreset(settings, 'ultraLow');
  assert.equal(settings.graphics.preset, 'ultraLow');
  assert.equal(matchPreset(settings.graphics), 'ultraLow');
  // A phone-class device is not confined to it: the ceiling only applies where the hardware says so.
  const gpu = describeGraphics({ renderer: 'NVIDIA GeForce RTX 4070' }, { deviceMemory: 8, hardwareConcurrency: 8, touch: false });
  assert.ok(PRESET_NAMES.indexOf(gpu.preset) > 0, `a real card got ${gpu.preset}`);
  assert.notEqual(gpu.ceiling, 'ultraLow');
  assert.equal(FALLBACK_PRESET, 'medium', 'an unclassified device still starts in the middle');
});
