// Time of day and weather.
//
// The clock owns a handful of slowly varying numbers (hour, cloud cover, rain, road wetness,
// puddles, mist, wind, storm intensity) and nothing else. What the sky, the light and the
// colour grade look like for those numbers is decided by `deriveEnvironment` of the sky
// module, which is called once per frame with them.
//
// Weather is a small state machine of fronts: fair weather, cloud building up, rain (now and
// then a thunderstorm), the front passing, and the roads drying. The physical couplings are
// rules that hold in every mode: it only rains from a covered sky, rain wets the road within
// seconds, puddles need sustained rain, and drying depends on sun, cloud and wind.

import { clamp, lerp, mod, smoothstep, smootherstep, makeRng, TAU } from '../core/math.js';

/** Steady states for the fixed weather modes. Wind in m/s. */
export const WEATHER_PRESETS = Object.freeze({
  clear: { clouds: 0.12, rain: 0, storm: 0, wind: 3 },
  cloudy: { clouds: 0.5, rain: 0, storm: 0, wind: 5 },
  overcast: { clouds: 0.9, rain: 0, storm: 0, wind: 6 },
  rain: { clouds: 0.95, rain: 0.6, storm: 0, wind: 8 },
  storm: { clouds: 1, rain: 1, storm: 1, wind: 14 },
});

/** Order in which the weather key steps through the modes. */
export const WEATHER_CYCLE = ['clear', 'cloudy', 'rain', 'storm', 'dynamic'];

export const WEATHER_LABELS = Object.freeze({
  clear: 'Clear', cloudy: 'Cloudy', overcast: 'Overcast', rain: 'Rain', storm: 'Thunderstorm', dynamic: 'Changing weather',
});

export const TIME_LABELS = Object.freeze({
  dawn: 'Dawn', morning: 'Morning', noon: 'Noon', afternoon: 'Afternoon', golden: 'Golden hour', dusk: 'Dusk', night: 'Night',
});

// Rates, per second of real time.
const WET_RATE = 0.06; // road film per unit of rain: heavy rain soaks the road in about 17 s
const DRY_RATE = 1 / 300; // at night, overcast, calm; sun and wind multiply it
const DRY_SUN_GAIN = 1.6;
const PUDDLE_FILL_RATE = 1 / 50; // per unit of rain, once the road is soaked
const PUDDLE_DRAIN_RATE = 1 / 260;
const RAIN_ONSET = 0.55; // cloud cover where rain can begin
const RAIN_FULL = 0.8; // cloud cover that supports any rain intensity
const TIME_SWEEP_SECONDS = 2.2; // how long the sky takes to move to a chosen preset
const MANUAL_CLOUD_SECONDS = 14; // cloud build-up after a manual weather change
const MANUAL_RAIN_SECONDS = 8;
// "Reduce flashing": a lightning flash is a train of sharp strokes a few hundredths of a second
// apart. With the setting on, the sky follows the envelope of the train at a fraction of the
// brightness and fades slowly, so a strike reads as one soft swell instead of a strobe.
const SOFT_FLASH_GAIN = 0.2;
const SOFT_FLASH_HALF_LIFE = 0.4; // s

const approach = (x, target, step) => (x < target ? Math.min(x + step, target) : Math.max(x - step, target));

/**
 * @param {object} opts
 * @param {{deriveEnvironment: Function, TIME_PRESETS: Record<string, number>, createLightning?: Function}} opts.sky
 * @param {number} [opts.seed]
 * @param {number} [opts.timeFlow]   game seconds per real second: 0, 1, 10 or 60
 * @param {number|string} [opts.time]  start hour or preset name
 * @param {string} [opts.weather]    a WEATHER_PRESETS name or 'dynamic'
 * @param {(distance: number) => void} [opts.onThunder]
 * @param {(strike: object) => void} [opts.onStrike]
 */
export function createClock(opts) {
  const sky = opts.sky;
  const presets = sky.TIME_PRESETS;
  const presetNames = Object.keys(presets).sort((a, b) => presets[a] - presets[b]);
  const rng = makeRng((opts.seed === undefined ? 1986 : opts.seed) ^ 0x5eed);

  const weather = { clouds: 0.12, rain: 0, wetness: 0, puddles: 0, fog: 0, windX: 0, windZ: 0, storm: 0 };
  const target = { clouds: 0.12, rain: 0, storm: 0, wind: 3 };
  const rate = { clouds: 1 / MANUAL_CLOUD_SECONDS, rain: 1 / MANUAL_RAIN_SECONDS };
  let windSpeed = 3;
  let windDir = rng.range(0, TAU);
  let windTurn = 0;
  /** Front state for the dynamic mode. */
  const front = { phase: 'clear', remaining: 0 };
  let sweep = null;
  const envInput = {
    timeOfDay: 12, clouds: 0, rain: 0, wetness: 0, puddles: 0, fog: 0, windX: 0, windZ: 0, lightning: 0, strike: null, interior: false,
  };
  let softFlash = 0;
  const lightning = sky.createLightning
    ? sky.createLightning({ seed: (opts.seed === undefined ? 1986 : opts.seed), onThunder: opts.onThunder, onStrike: opts.onStrike })
    : null;

  const clock = {
    /** Hours, [0, 24). */
    timeOfDay: 12,
    /** Game seconds per real second. */
    timeFlow: opts.timeFlow === undefined ? 1 : opts.timeFlow,
    /** While true neither the hour nor the weather moves on their own. */
    frozen: false,
    /**
     * While true the environment is that of a closed room (the garage: no sun, sky or weather;
     * `env.interior`), and the street's hour and weather wait unchanged behind it.
     */
    interior: false,
    /** From settings.game.reduceFlashing: lightning becomes a dim, slow swell. */
    reduceFlashing: false,
    /** 'clear' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'dynamic' */
    mode: 'clear',
    weather,
    front,
    /** The derived environment of the current frame (owned by the sky module's function). */
    env: null,

    /** Hour for a preset name or a number; NaN if neither. */
    resolveTime(value) {
      if (typeof value === 'number') return mod(value, 24);
      if (typeof value === 'string') {
        if (value in presets) return presets[value];
        const hours = parseFloat(value);
        if (Number.isFinite(hours)) return mod(hours, 24);
      }
      return NaN;
    },

    /**
     * Moves the clock to an hour or preset. By default the sky sweeps forward to it in about
     * two seconds; `instant` jumps (start-up, automation, a frozen clock).
     * @returns {boolean} false if the value was not understood
     */
    setTime(value, instant = false) {
      const hours = clock.resolveTime(value);
      if (Number.isNaN(hours)) return false;
      if (instant || clock.frozen) {
        clock.timeOfDay = hours;
        sweep = null;
      } else {
        sweep = { from: clock.timeOfDay, delta: mod(hours - clock.timeOfDay, 24), t: 0 };
      }
      return true;
    },

    /** Steps to the next named time of day; returns its name. */
    nextTimePreset() {
      const now = sweep ? mod(sweep.from + sweep.delta, 24) : clock.timeOfDay;
      const name = presetNames.find((n) => presets[n] > now + 0.05) || presetNames[0];
      clock.setTime(presets[name]);
      return name;
    },

    /** Name of the preset closest to the current hour, for menus. */
    nearestTimePreset() {
      let best = presetNames[0], bestDistance = 24;
      for (const name of presetNames) {
        const d = Math.abs(mod(presets[name] - clock.timeOfDay + 12, 24) - 12);
        if (d < bestDistance) { bestDistance = d; best = name; }
      }
      return best;
    },

    /**
     * Selects a weather mode. Normally the change arrives as a front over a quarter of a
     * minute; `instant` puts sky and road straight into the steady state.
     * @returns {boolean} false for an unknown name
     */
    setWeather(name, instant = false) {
      if (name !== 'dynamic' && !(name in WEATHER_PRESETS)) return false;
      clock.mode = name;
      if (name === 'dynamic') {
        enterPhase(weather.rain > 0.05 ? 'rain' : weather.clouds > 0.6 ? 'building' : 'clear');
      } else {
        const p = WEATHER_PRESETS[name];
        target.clouds = p.clouds; target.rain = p.rain; target.storm = p.storm; target.wind = p.wind;
        rate.clouds = 1 / MANUAL_CLOUD_SECONDS;
        rate.rain = 1 / MANUAL_RAIN_SECONDS;
      }
      if (instant || clock.frozen) settle();
      return true;
    },

    /** Steps to the next weather mode; returns its name. */
    nextWeather() {
      const i = WEATHER_CYCLE.indexOf(clock.mode);
      const name = WEATHER_CYCLE[(i + 1) % WEATHER_CYCLE.length];
      clock.setWeather(name);
      return name;
    },

    /**
     * Advances time and weather and derives the environment.
     * @param {number} dt  real seconds (0 while paused)
     * @param {number[]} [listener]  camera position, for the lightning scheduler
     */
    update(dt, listener) {
      // Indoors the street's clock, weather and thunder stand still: leaving the room gives
      // the street back as it was.
      if (clock.interior) dt = 0;
      if (sweep) {
        sweep.t += dt / TIME_SWEEP_SECONDS;
        clock.timeOfDay = mod(sweep.from + sweep.delta * smootherstep(0, 1, sweep.t), 24);
        if (sweep.t >= 1) sweep = null;
      } else if (!clock.frozen) {
        clock.timeOfDay = mod(clock.timeOfDay + (dt * clock.timeFlow) / 3600, 24);
      }
      if (!clock.frozen && dt > 0) {
        if (clock.mode === 'dynamic') advanceFront(dt);
        advanceWeather(dt);
      }
      let flash = 0;
      if (lightning) {
        const intensity = weather.storm * smoothstep(0.7, 0.95, weather.rain);
        flash = lightning.update(clock.frozen ? 0 : dt, intensity, listener ? listener[0] : 0, listener ? listener[2] : 0) || 0;
        softFlash = Math.max(flash * SOFT_FLASH_GAIN, softFlash * Math.pow(0.5, dt / SOFT_FLASH_HALF_LIFE));
        if (clock.reduceFlashing) flash = softFlash;
      }
      envInput.timeOfDay = clock.timeOfDay;
      envInput.clouds = weather.clouds; envInput.rain = weather.rain;
      envInput.wetness = weather.wetness; envInput.puddles = weather.puddles; envInput.fog = weather.fog;
      envInput.windX = weather.windX; envInput.windZ = weather.windZ;
      envInput.lightning = flash;
      envInput.strike = lightning ? lightning.strike : null;
      envInput.interior = clock.interior;
      clock.env = sky.deriveEnvironment(envInput, clock.env || undefined);
      return clock.env;
    },
  };

  /** Jumps every weather variable to the steady state of the current targets. */
  function settle() {
    weather.clouds = target.clouds;
    weather.rain = target.rain;
    weather.storm = target.storm;
    weather.wetness = target.rain > 0 ? 1 : 0;
    weather.puddles = target.rain;
    windSpeed = target.wind;
    writeDerived();
  }

  function enterPhase(phase) {
    front.phase = phase;
    if (phase === 'clear') {
      front.remaining = rng.range(240, 540);
      setFrontTarget(rng.range(0.08, 0.32), 0, 0, rng.range(2, 5), 90, 20);
    } else if (phase === 'building') {
      front.remaining = rng.range(70, 130);
      setFrontTarget(rng.range(0.9, 1), 0, 0, rng.range(6, 9), front.remaining * 0.9, 20);
    } else if (phase === 'rain') {
      front.remaining = rng.range(150, 320);
      const thunder = rng.chance(0.3);
      setFrontTarget(1, thunder ? 1 : rng.range(0.45, 0.85), thunder ? 1 : 0, thunder ? 14 : rng.range(7, 10), 20, thunder ? 25 : 40);
    } else if (phase === 'clearing') {
      front.remaining = rng.range(60, 110);
      setFrontTarget(rng.range(0.4, 0.55), 0, 0, rng.range(4, 7), front.remaining, front.remaining * 0.35);
    } else {
      // Drying lasts until the road is dry (see advanceFront); the sky keeps opening meanwhile.
      front.remaining = 60;
      setFrontTarget(rng.range(0.12, 0.3), 0, 0, rng.range(3, 5), 120, 20);
    }
  }

  /** Targets for a front phase, with ramp times in seconds from where the weather is now. */
  function setFrontTarget(clouds, rain, storm, wind, cloudSeconds, rainSeconds) {
    target.clouds = clouds; target.rain = rain; target.storm = storm; target.wind = wind;
    rate.clouds = Math.max(Math.abs(clouds - weather.clouds), 0.05) / cloudSeconds;
    rate.rain = Math.max(Math.abs(rain - weather.rain), 0.05) / rainSeconds;
  }

  function advanceFront(dt) {
    front.remaining -= dt;
    if (front.remaining > 0) return;
    if (front.phase === 'clear') enterPhase('building');
    else if (front.phase === 'building') enterPhase('rain');
    else if (front.phase === 'rain') enterPhase('clearing');
    else if (front.phase === 'clearing') enterPhase('drying');
    else if (weather.wetness < 0.05) enterPhase('clear');
  }

  function advanceWeather(dt) {
    weather.clouds = approach(weather.clouds, target.clouds, rate.clouds * dt);
    // Rain follows the cloud: none below the onset cover, any intensity once the sky is closed.
    const supported = target.rain * smoothstep(RAIN_ONSET, RAIN_FULL, weather.clouds);
    weather.rain = approach(weather.rain, supported, rate.rain * dt);
    weather.storm = approach(weather.storm, target.storm, dt / 10);

    const raining = weather.rain > 0.02;
    if (raining) {
      weather.wetness = Math.min(1, weather.wetness + weather.rain * WET_RATE * dt);
      if (weather.wetness > 0.7 && weather.puddles < weather.rain) {
        weather.puddles = Math.min(weather.rain, weather.puddles + weather.rain * PUDDLE_FILL_RATE * dt);
      }
    } else {
      const daylight = clock.env ? 1 - clock.env.night : 0.5;
      const drying = (1 + DRY_SUN_GAIN * daylight * (1 - weather.clouds)) * (1 + windSpeed / 20);
      // Puddles outlast the film: the road dries between them first.
      weather.puddles = Math.max(0, weather.puddles - PUDDLE_DRAIN_RATE * drying * dt);
      const floor = weather.puddles * 0.35;
      weather.wetness = Math.max(floor, weather.wetness - DRY_RATE * drying * dt);
    }

    windSpeed = approach(windSpeed, target.wind, dt * 0.4);
    // The wind direction wanders: a slowly changing turn rate, itself pulled back to zero.
    windTurn = clamp(windTurn + (rng.next() - 0.5) * 0.02 * dt - windTurn * 0.05 * dt, -0.02, 0.02);
    windDir = mod(windDir + windTurn * dt, TAU);
    writeDerived();
  }

  function writeDerived() {
    // Mist: rain hangs in the air, a storm more so. Zero is the sky module's normal haze.
    weather.fog = lerp(0, 0.3, weather.rain * weather.rain) + 0.12 * weather.storm * weather.rain;
    weather.windX = Math.cos(windDir) * windSpeed;
    weather.windZ = Math.sin(windDir) * windSpeed;
  }

  clock.setTime(opts.time === undefined ? 'noon' : opts.time, true);
  if (!clock.setWeather(opts.weather || 'clear', true)) clock.setWeather('clear', true);
  return clock;
}
