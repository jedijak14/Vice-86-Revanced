// Quality mapping: turns settings.graphics (ARCHITECTURE 11.2) into the numbers the renderer runs on,
// and the dynamic-resolution controller. Pure logic, no GL.

const clampInt = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
const clampNum = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Field defaults per preset, used for any field the caller leaves out. */
export const PRESET_DEFAULTS = Object.freeze({
  ultraLow: { resolutionScale: 0.5, maxPixelRatio: 1, shadows: 0, ao: 0, reflections: 0, antialiasing: 'off', bloom: 0, motionBlur: 0, depthOfField: 0, lights: 0, drawDistance: 0, particles: 0, volumetrics: 0, filmGrain: false, chromaticAberration: false },
  low: { resolutionScale: 0.7, maxPixelRatio: 1, shadows: 1, ao: 0, reflections: 0, antialiasing: 'fxaa', bloom: 1, motionBlur: 0, depthOfField: 0, lights: 0, drawDistance: 0, particles: 0, volumetrics: 0, filmGrain: false, chromaticAberration: false },
  medium: { resolutionScale: 0.85, maxPixelRatio: 1, shadows: 2, ao: 1, reflections: 1, antialiasing: 'taa', bloom: 1, motionBlur: 1, depthOfField: 1, lights: 1, drawDistance: 1, particles: 1, volumetrics: 0, filmGrain: true, chromaticAberration: false },
  high: { resolutionScale: 1, maxPixelRatio: 1.5, shadows: 3, ao: 2, reflections: 2, antialiasing: 'taa', bloom: 2, motionBlur: 2, depthOfField: 2, lights: 2, drawDistance: 2, particles: 2, volumetrics: 1, filmGrain: true, chromaticAberration: true },
  ultra: { resolutionScale: 1.25, maxPixelRatio: 2.5, shadows: 4, ao: 3, reflections: 4, antialiasing: 'taa', bloom: 3, motionBlur: 3, depthOfField: 3, lights: 4, drawDistance: 4, particles: 3, volumetrics: 1, filmGrain: true, chromaticAberration: true, hair: true, cloth: true, waterPhysics: true, grade: 'gtav' },
});

// One row per level of each setting. These tables are the tuning surface of the renderer.
const SHADOWS = [
  { cascades: 0, size: 0, distance: 0, taps: 0 },
  { cascades: 2, size: 1024, distance: 70, taps: 5 },
  { cascades: 3, size: 2048, distance: 150, taps: 8 },
  { cascades: 4, size: 2048, distance: 260, taps: 12 },
  { cascades: 4, size: 4096, distance: 420, taps: 16 },   // ultra high: the whole visible street in shadow
];
const AO = [{ taps: 0, radius: 0 }, { taps: 8, radius: 0.7 }, { taps: 14, radius: 0.8 }, { taps: 20, radius: 0.85 }];
// scale: resolution of the trace relative to the frame; steps: march samples; resolve: taps of the roughness blur;
// planar: taps of the wet-road mirror's vertical fan (0 = no mirror pass: trace and probe only);
// probe: face size of the scene reflection probe in pixels (0 = the sky alone is reflected), probeFaces: faces redrawn per frame.
// planar, roomPlanar: taps of the mirror's roughness fan on a wet road and on the floor of a closed room
// (0 = no mirror pass). probe, roomProbe: edge of a face of the scene reflection probe in the street and
// in a closed room. A room's probe is drawn once, when the room opens, so even Low has one: it is what
// paint and glass show there, and on Low the floor too, in place of the mirror pass.
// roomProbeFine: how many times their size a room's faces are drawn at before being averaged down
// (probe.js: a neon tube is thinner than a texel).
const REFLECTIONS = [
  { steps: 0, scale: 0, resolve: 0, refine: 0, planar: 0, roomPlanar: 0, probe: 0, roomProbe: 256, roomProbeFine: 2, probeFaces: 0 },
  { steps: 20, scale: 0.5, resolve: 5, refine: 3, planar: 0, roomPlanar: 6, probe: 256, roomProbe: 256, roomProbeFine: 2, probeFaces: 1 },
  { steps: 36, scale: 0.5, resolve: 9, refine: 4, planar: 8, roomPlanar: 8, probe: 512, roomProbe: 512, roomProbeFine: 4, probeFaces: 2 },
  { steps: 56, scale: 1, resolve: 12, refine: 5, planar: 12, roomPlanar: 12, probe: 512, roomProbe: 1024, roomProbeFine: 2, probeFaces: 3 },
  { steps: 72, scale: 1, resolve: 16, refine: 6, planar: 16, roomPlanar: 16, probe: 1024, roomProbe: 1024, roomProbeFine: 4, probeFaces: 4 },
];
/** Whether a preset draws the road-plane mirror anywhere (wet street or closed room), and so needs its target. */
export const hasMirror = (reflections) => reflections.planar > 0 || reflections.roomPlanar > 0;
const BLOOM = [{ mips: 0 }, { mips: 5 }, { mips: 7 }, { mips: 8 }];
// taps: the most samples along a streak (short streaks take fewer); shutter: exposure in 60 Hz frames (0.5 = a 180 degree
// shutter, the film standard). The levels differ in sample count, not in how much blur there is.
const MOTION_BLUR = [{ taps: 0, shutter: 0 }, { taps: 8, shutter: 0.5 }, { taps: 12, shutter: 0.5 }, { taps: 16, shutter: 0.5 }];
// Samples of the lens blur drawn on frames that carry a focus (frame.focus: the garage camera). 0 = no such pass.
const DEPTH_OF_FIELD = [{ taps: 0 }, { taps: 12 }, { taps: 16 }, { taps: 24 }];
// perCell is the number of light slots a bin cell holds and must stay <= MAX_SLOTS_PER_CELL
// in shaders/common.js (32). Medium needs 16: a lit avenue at dusk puts ~15 lamps and head lamps on
// one near cell, and with 8 slots over half the scene's lights were dropped. On the street Low needs 12: on
// a shopping street with traffic a cell beside a lamp holds the player's two headlamps, four or six of the
// nearest cars' and a shopfront spill or two before the lamp, and with 8 the lamp's pool lost cells. It has
// 16 because of the garage: in a room every light is in every cell, so the slots are the room's whole light
// budget, and the lights that show the car's colour (the strip round the turntable, after the wall tubes
// and the sign) must fit beside the car's own two lamps on every preset. Low's grid is
// 28 cells of 8 m: lamp light then reaches 96 m from the camera at the least, wherever the camera stands in
// its cell, which is 80 m of street ahead of a car the camera trails by up to 16 m.
const LIGHTS = [
  { maxLights: 128, sizeNear: 28, sizeFar: 0, perCell: 16 },
  { maxLights: 320, sizeNear: 32, sizeFar: 16, perCell: 16 },
  { maxLights: 640, sizeNear: 48, sizeFar: 32, perCell: 24 },
  { maxLights: 1024, sizeNear: 64, sizeFar: 32, perCell: 32 },
  { maxLights: 1536, sizeNear: 72, sizeFar: 40, perCell: 40 },
];
const PARTICLES = [{ max: 384 }, { max: 1536 }, { max: 4096 }, { max: 8192 }];
// What Ultra Low shaves off the bottom of every table, because a level of 0 is already "off" and the
// preset still has to be cheaper than Low: fewer lights to bin, a smaller grid to bin them in, a
// shorter shadow and reflection reach, and a particle budget that fits sparks from one crash.
const ULTRA_LOW = Object.freeze({ maxLights: 64, sizeNear: 24, perCell: 12, particles: 128, reach: 0.55 });
// Detail level handed to surface families in uQuality.x: micro detail is skipped below 0.5.
const DETAIL = { ultraLow: 0, low: 0.25, medium: 0.5, high: 0.8, ultra: 1.15 };
/**
 * What a small-memory device is held to, whatever preset it asked for. These are not about frame rate: they
 * are the sizes of the buffers that stay alive between frames — the internal resolution (every target in the
 * renderer scales with its square), the light grid, the particle arena, the reflection probe's faces, and the
 * two passes that have to keep a whole extra copy of the frame around to work (the mirror fan and any pass
 * with a history: temporal antialiasing and motion blur). A phone with 3 GB shared with the operating system
 * and every tab it has open dies on those bytes rather than on the shader maths, so the maths is left alone
 * and the allocations are capped.
 */
const LOW_MEMORY = Object.freeze({
  scale: 0.5, lights: 96, sizeNear: 24, perCell: 12, particles: 256, probe: 128, shadowSize: 1024, cascades: 2,
});

/**
 * Resolve a graphics settings object into renderer parameters. Unknown or missing fields fall back to
 * the named preset ('high' when the preset itself is unknown, 'auto' or 'custom').
 */
export function resolveQuality(graphics = {}) {
  const presetName = PRESET_DEFAULTS[graphics.preset] ? graphics.preset : 'high';
  const base = PRESET_DEFAULTS[presetName];
  const pick = (name) => (graphics[name] !== undefined ? graphics[name] : base[name]);
  // The clamps follow the tables, so adding a row to a table is adding a level to the setting.
  const shadows = clampInt(pick('shadows'), 0, SHADOWS.length - 1, base.shadows), ao = clampInt(pick('ao'), 0, AO.length - 1, base.ao);
  const reflections = clampInt(pick('reflections'), 0, REFLECTIONS.length - 1, base.reflections), bloom = clampInt(pick('bloom'), 0, BLOOM.length - 1, base.bloom);
  const motionBlur = clampInt(pick('motionBlur'), 0, 3, base.motionBlur), lights = clampInt(pick('lights'), 0, LIGHTS.length - 1, base.lights);
  const depthOfField = clampInt(pick('depthOfField'), 0, 3, base.depthOfField);
  const particles = clampInt(pick('particles'), 0, PARTICLES.length - 1, base.particles), drawDistance = clampInt(pick('drawDistance'), 0, 4, base.drawDistance);
  const aa = pick('antialiasing'), antialiasing = aa === 'off' || aa === 'fxaa' || aa === 'taa' ? aa : base.antialiasing;
  // The detail hint follows the heaviest visual settings rather than the preset label, so 'custom' works.
  const detail = graphics.preset in DETAIL ? DETAIL[graphics.preset] : [0.25, 0.5, 0.8, 1][Math.round((shadows + reflections + lights) / 3)];
  const cuts = presetName === 'ultraLow' ? ULTRA_LOW : null;
  const mem = graphics.lowMemory === true ? LOW_MEMORY : null;
  // Above 1 is supersampling: ultra high renders the street bigger than the glass and settles it down.
  const scale = clampNum(pick('resolutionScale'), 0.5, 1.5, base.resolutionScale);
  const shadow = { ...SHADOWS[shadows], distance: SHADOWS[shadows].distance * [0.8, 1, 1.15, 1.3, 1.45][drawDistance] * (cuts ? ULTRA_LOW.reach : 1) };
  if (mem) {
    shadow.size = Math.min(shadow.size, mem.shadowSize);
    shadow.cascades = Math.min(shadow.cascades, mem.cascades);
    if (shadow.cascades > 0 && shadow.size < 512) shadow.cascades = 0;   // a 256-pixel cascade map is not a shadow
  }
  // A reflection pass that keeps a full-size mirror of the frame is the largest single thing in the frame
  // after the G-buffer, so in a small-memory budget only the room probe survives, and at a quarter of its size.
  let refl = REFLECTIONS[reflections];
  if (mem && (refl.planar > 0 || refl.probe > 0 || refl.steps > 0)) {
    refl = { ...refl, steps: 0, scale: 0, resolve: 0, refine: 0, planar: 0, roomPlanar: 0, probe: 0,
      roomProbe: Math.min(refl.roomProbe, mem.probe), roomProbeFine: 1 };
  }
  const lightSet = cuts ? { maxLights: cuts.maxLights, sizeNear: cuts.sizeNear, sizeFar: 0, perCell: cuts.perCell }
    : { ...LIGHTS[lights] };
  if (mem && !cuts) {
    lightSet.maxLights = Math.min(lightSet.maxLights, mem.lights);
    lightSet.sizeNear = Math.min(lightSet.sizeNear, mem.sizeNear);
    lightSet.sizeFar = 0;
    lightSet.perCell = Math.min(lightSet.perCell, mem.perCell);
  }
  return {
    // Whether the device is short of memory travels with the quality, because everything that has to
    // decide an allocation decides it from here (the world's streaming rings read the setting itself).
    lowMemory: mem !== null,
    resolutionScale: mem ? Math.min(scale, mem.scale) : scale,
    dynamicResolution: graphics.dynamicResolution !== false,
    maxPixelRatio: clampNum(pick('maxPixelRatio'), 1, 3, base.maxPixelRatio),
    frameTarget: graphics.frameCap === 30 ? 1000 / 30 : 1000 / 60,          // ms, target of dynamic resolution
    levels: { shadows, ao, reflections, bloom, motionBlur, depthOfField, lights, particles, drawDistance },
    shadows: shadow,
    ao: AO[ao], reflections: refl, bloom: BLOOM[bloom],
    motionBlur: mem ? MOTION_BLUR[0] : MOTION_BLUR[motionBlur],
    depthOfField: DEPTH_OF_FIELD[depthOfField],
    lights: lightSet,
    particles: cuts ? { max: cuts.particles } : mem ? { max: Math.min(PARTICLES[particles].max, mem.particles) } : PARTICLES[particles],
    antialiasing: mem && antialiasing === 'taa' ? 'fxaa' : antialiasing,
    volumetrics: clampInt(pick('volumetrics'), 0, 1, base.volumetrics) === 1,
    filmGrain: pick('filmGrain') !== false && pick('filmGrain') !== 0,
    chromaticAberration: pick('chromaticAberration') === true || pick('chromaticAberration') === 1,
    // Tunables requested by the lead: multiply the built-in bloom amount, shift exposure in stops.
    // Ultra's own switches: the hair and cloth sway, the wake field, and the grade that puts the
    // frame in the light of the reference screenshots. Every lower rung leaves them at zero.
    hair: pick('hair') === true || pick('hair') === 1,
    cloth: pick('cloth') === true || pick('cloth') === 1,
    waterPhysics: pick('waterPhysics') === true || pick('waterPhysics') === 1,
    grade: pick('grade') === 'gtav' ? 'gtav' : '',
    bloomStrength: clampNum(graphics.bloomStrength, 0, 2, 1),
    exposureBias: clampNum(graphics.exposureBias, -2, 2, 0),
    detail,
  };
}

/** Changes that need render targets or textures to be rebuilt (anything else applies on the next frame). */
export function needsRebuild(a, b) {
  return !a || a.shadows.size !== b.shadows.size || a.shadows.cascades !== b.shadows.cascades || a.reflections.scale !== b.reflections.scale || hasMirror(a.reflections) !== hasMirror(b.reflections)
    || a.bloom.mips !== b.bloom.mips || a.lights.maxLights !== b.lights.maxLights || a.lights.sizeNear !== b.lights.sizeNear
    || a.lights.sizeFar !== b.lights.sizeFar || a.lights.perCell !== b.lights.perCell || a.particles.max !== b.particles.max
    || (a.ao.taps > 0) !== (b.ao.taps > 0) || a.antialiasing !== b.antialiasing || a.maxPixelRatio !== b.maxPixelRatio;
}

/**
 * Dynamic resolution with hysteresis in both directions.
 *
 * The scale moves on a fixed ladder between `minScale` and the user's resolution scale. It steps DOWN
 * after the frame cost has been over budget for a short while, and steps UP only after a longer calm
 * period in which the cost predicted for the higher step still fits. After stepping down, stepping up is
 * locked out for a while, and that lock-out doubles each time an up-step had to be undone, so the scale
 * cannot oscillate around a boundary.
 *
 * `cost` is GPU time in ms when timer queries exist. Without them the caller passes the frame interval;
 * because of vsync that never drops below the refresh period, so `measured` is false and the controller
 * probes upwards blindly after the calm period instead of predicting.
 */
export class DynamicResolution {
  constructor({ maxScale = 1, minScale = 0.5, target = 1000 / 60 } = {}) {
    this.configure(maxScale, minScale, target);
    this.scale = this.ladder[0]; this._step = 0;
    this._over = 0; this._calm = 0; this._lockout = 0; this._penalty = 2; this._sinceUp = Infinity;
  }

  configure(maxScale, minScale, target) {
    this.target = target;
    this.ladder = [];
    for (let s = maxScale; s > minScale + 1e-3; s *= 0.88) this.ladder.push(Math.round(s * 100) / 100);
    this.ladder.push(minScale);
    this._step = Math.min(this._step || 0, this.ladder.length - 1); this.scale = this.ladder[this._step];
  }

  /** Feed one frame. dt in seconds, cost in ms. Returns the scale to use for the next frame. */
  update(dt, cost, measured) {
    const budget = this.target * (measured ? 0.88 : 1.12);     // GPU time must leave headroom; frame intervals carry vsync slack
    this._lockout = Math.max(0, this._lockout - dt); this._sinceUp += dt;
    if (cost > budget) { this._over += dt; this._calm = 0; } else { this._over = Math.max(0, this._over - dt * 2); }
    if (this._over > 0.35 && this._step < this.ladder.length - 1) {
      // If the step up we just made is what broke the budget, undo it and wait twice as long before trying again.
      if (this._sinceUp < 3) this._penalty = Math.min(60, this._penalty * 2);
      this._step++; this._over = 0; this._calm = 0; this._lockout = this._penalty;
    } else if (this._step > 0 && this._lockout === 0) {
      const up = this.ladder[this._step - 1], ratio = (up * up) / (this.scale * this.scale);
      const fits = measured ? cost * ratio < this.target * 0.8 : cost <= budget;
      this._calm = fits ? this._calm + dt : 0;
      if (this._calm > (measured ? 1.5 : 4)) {
        this._step--; this._calm = 0; this._sinceUp = 0;
        if (this._penalty > 2) this._penalty *= 0.75;           // slowly forgive
      }
    }
    this.scale = this.ladder[this._step];
    return this.scale;
  }

  reset() { this._step = 0; this.scale = this.ladder[0]; this._over = 0; this._calm = 0; this._lockout = 0; this._penalty = 2; this._sinceUp = Infinity; }
}
