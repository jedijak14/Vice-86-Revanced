// Automation hooks (design/ARCHITECTURE.md section 14): the URL query parameters and the
// `window.__vice` object that let a scripted browser drive the game without a person.
//
// The hooks object exists from the first line of the boot sequence, before there is a game,
// so that a script can always read `phase` and `errors`. Calls made before the game exists
// wait for it.

import { CARS } from '../vehicles/cars.js';
import { ENGINE } from '../render/identity.js';
import { allowedCar } from './garage.js';

// Query values are matched case-folded, so the one camelCase preset needs to be spelled without its
// capital here and turned back into the settings vocabulary's name below.
const QUALITY_NAMES = ['ultralow', 'low', 'medium', 'high', 'ultra'];
const QUALITY_PRESET = Object.freeze({ ultralow: 'ultraLow', low: 'low', medium: 'medium', high: 'high', ultra: 'ultra' });
const WEATHER_NAMES = ['clear', 'cloudy', 'overcast', 'rain', 'storm'];
const CAMERA_NAMES = ['chase', 'bonnet', 'orbit', 'free'];

const flag = (params, name) => {
  const v = params.get(name);
  return v !== null && v !== '0' && v !== 'false';
};

/** The only mode the renderer understands for `?webgl2`: insist on WebGL2 past the checks. */
const WEBGL2_MODES = ['force'];

const oneOf = (value, names) => (value !== null && names.includes(value.toLowerCase()) ? value.toLowerCase() : null);

/**
 * Reads the automation parameters from a query string. Values that are not understood are
 * dropped (and listed in `ignored`) rather than guessed at.
 * @param {string} search  `location.search`
 */
export function parseOptions(search) {
  const params = new URLSearchParams(search || '');
  const ignored = [];
  const options = {
    autostart: flag(params, 'autostart'),
    /** Boot straight into the garage instead of the title screen (autostart wins over it). */
    garage: flag(params, 'garage'),
    /** Hours, a preset name, or null. */
    time: null,
    weather: oneOf(params.get('weather'), WEATHER_NAMES),
    freeze: flag(params, 'freeze'),
    quality: QUALITY_PRESET[oneOf(params.get('quality'), QUALITY_NAMES)] || null,
    /**
     * 'force': boot past the renderer's capability checks. Which devices are refused, and what happens
     * when you insist, is documented in render/gl.js (createContext).
     */
    webgl2: oneOf(params.get('webgl2'), WEBGL2_MODES),
    /** [x, z, yaw in radians] or null. */
    pos: null,
    cam: oneOf(params.get('cam'), CAMERA_NAMES),
    autopilot: params.get('drive') === 'auto',
    /** Registry id of the car to drive this session (unreleased cars included), or null. */
    car: null,
    /** 0..3 or null. */
    traffic: null,
    /** Renderer debug view, 0 = final image. */
    debug: 0,
    nohud: flag(params, 'nohud'),
    /**
     * split=1 / split=0: draw every surface family as one shader program per group of materials, or as
     * one program. null leaves it to the renderer, which splits on Direct3D only.
     */
    split: params.get('split') === '1' ? true : params.get('split') === '0' ? false : null,
    mute: flag(params, 'mute'),
    /** Seed for traffic and weather, or null for the default. */
    seed: null,
    ignored,
  };
  const time = params.get('time');
  if (time !== null && time !== '') options.time = Number.isFinite(Number(time)) ? Number(time) : time.toLowerCase();
  const pos = params.get('pos');
  if (pos !== null) {
    const parts = pos.split(',').map(Number);
    if (parts.length >= 2 && parts.every(Number.isFinite)) options.pos = [parts[0], parts[1], ((parts[2] || 0) * Math.PI) / 180];
    else ignored.push('pos');
  }
  const integer = (name, min, max) => {
    const raw = params.get(name);
    if (raw === null) return null;
    const n = Number(raw);
    if (raw === '' || !Number.isInteger(n) || n < min || n > max) { ignored.push(name); return null; }
    return n;
  };
  options.traffic = integer('traffic', 0, 3);
  options.debug = integer('debug', 0, 64) || 0;
  options.seed = integer('seed', -2147483648, 4294967295);
  for (const name of ['weather', 'quality', 'cam']) if (params.get(name) !== null && options[name] === null) ignored.push(name);
  if (params.get('drive') !== null && !options.autopilot) ignored.push('drive');
  const car = params.get('car');
  if (car !== null) {
    options.car = allowedCar(car.toLowerCase(), true);
    if (options.car === null) ignored.push('car');
  }
  return options;
}

/**
 * Creates the `__vice` object. Until `attach(game)` is called the commands wait.
 * @returns {{hooks: object, attach: (game: object) => void, fail: (message: string) => void}}
 */
export function createHooks() {
  let game = null;
  let attached;
  const whenAttached = new Promise((resolve) => { attached = resolve; });
  /** Runs a command now, or as soon as there is a game. */
  const run = (fn) => (game ? fn(game) : whenAttached.then(fn));
  /** A copy of the garage's state once nothing is in progress any more (fade, build, door). */
  const garageSettled = (g) => g.idle().then(() => ({ ...g.garageState() }));

  const hooks = {
    phase: 'boot',
    ready: false,
    /** The renderer the game runs on, named (src/render/identity.js). */
    engine: ENGINE,
    /** Paloma PD: the patrol dispatch's units and what they are doing, as plain data. */
    police: () => (game && game.police ? game.police : null),
    /** Paloma PD for a script: the same order the dispatch gives itself, 0..3 (see game.js). */
    dispatch: (heat, message) => run((g) => g.orderPolice(heat, message)),
    /** The wanted level as the ledger keeps it: { stars, points, cause, since, raised, lowered }. */
    wanted: () => (game && game.wanted ? game.wanted : null),
    /** Clears the record, the way a completed stop does. */
    clearWanted: () => run((g) => g.clearWanted()),
    /** The crowd on the pavements: { peds, articulated, density, hailing, startled, passenger }. */
    crowd: () => (game && game.crowd ? game.crowd : null),
    /** Whether the crowd's bodies reached the camera: { rendered, triangles } from the last drawn frame. */
    crowdRender: () => (game && game.crowdRender ? game.crowdRender : null),
    /** Puts a hailer on the nearest kerb to x, z, for a script that wants a fare. */
    hail: (x, z) => run((g) => g.hailAt(x, z)),
    /** Street races: the meeting offered where the car is standing, and the board. */
    race: () => (game ? { offer: game.raceOffer(), board: game.races.snapshot() } : null),
    /** Why the street will not lay a course: { offer, road, walkable, lanes } — diagnostics only. */
    raceDiag: () => run((g) => {
      const car = g.player ? g.player.pos : null;
      const hit = g.graph ? g.graph.nearest(car[0], car[2], 40, (l) => !l.junction && l.junctionId < 0 && l.length > 20) : null;
      const any = g.graph ? g.graph.nearest(car[0], car[2], 40) : null;
      let long = 0, total = 0;
      if (g.graph) for (const l of g.graph.lanes) { total++; if (l.length > 20 && !l.junction && l.junctionId < 0) long++; }
      return {
        car: car && [Math.round(car[0]), Math.round(car[2])],
        hit: hit ? { id: hit.lane.id, s: Math.round(hit.s), len: Math.round(hit.lane.length), next: hit.lane.next.length } : null,
        any: any ? { id: any.lane.id, len: Math.round(any.lane.length), next: any.lane.next.length, jid: any.lane.junctionId, j: !!any.lane.junction } : null,
        long, total, why: g.races.last,
      };
    }),
    /** Starts a meeting ('local' | 'county' | 'palm'), putting the car on the line. */
    startRace: (tier = 'local') => run((g) => g.startRace(tier)),
    /** Calls the race off, as the V key does. */
    abortRace: () => run((g) => { g.races.abort('Called off by a script'); return g.races.snapshot(); }),
    /** Every caught error and failed shader, with context. */
    errors: [],
    stats: () => (game ? game.stats() : {}),
    settle: (frames = 30) => whenAttached.then((g) => g.settle(frames)),
    teleport: (x, z, yawDeg = 0) => run((g) => g.teleport(x, z, (yawDeg * Math.PI) / 180)),
    setTime: (hoursOrPreset) => run((g) => g.setTime(hoursOrPreset, true)),
    setWeather: (name) => run((g) => g.setWeather(name, true)),
    setQuality: (preset) => run((g) => g.setQuality(preset)),
    /** `pose` places the free camera: { position, target, fov (degrees, vertical) }. */
    setCamera: (mode, pose) => run((g) => g.setCamera(mode, pose)),
    setPaint: (index) => run((g) => g.setPaint(index)),
    input: (actions) => run((g) => g.injectInput(actions)),
    /** The car's state: { id, position, yaw, speed, rpm, gear, onRoad }; null until the game exists. */
    car: () => (game ? game.carState() : null),
    /** Every car in the registry: [{ id, released }]. */
    cars: CARS.map((entry) => ({ id: entry.id, released: entry.released })),
    /** Registry id of the car being driven; null until the game exists. */
    get carId() { return game ? game.carId : null; },
    /**
     * Changes the car, unreleased ones included. Resolves with the id of the car in the scene
     * once the change is done: the one asked for, or the one kept if it could not be built.
     */
    setCar: (id) => run((g) => g.setCar(id, { unreleased: true })),
    /**
     * The garage, for tests. Every call resolves with the state (see `state`) once what it
     * started is over: open with the room on screen, close with the title, next / prev with the
     * car on the turntable, drive with the street.
     */
    garage: {
      open: () => run((g) => { g.openGarage(); return garageSettled(g); }),
      close: () => run((g) => { g.closeGarage(); return garageSettled(g); }),
      next: () => run((g) => g.cycleCar(1).then(() => garageSettled(g))),
      prev: () => run((g) => g.cycleCar(-1).then(() => garageSettled(g))),
      /** Paints the car on show: an index into its colours (wraps). */
      colour: (index) => run((g) => { g.setPaint(index); return garageSettled(g); }),
      drive: () => run((g) => { g.start(); return garageSettled(g); }),
      /**
       * { phase, open, car, wanted, status: 'building' | 'ready', paint, door: 0..1, departing,
       *   set: 'none' | 'building' | 'ready' | 'stand-in' | 'failed', cached: ids }; null until
       * the game exists.
       */
      get state() { return game ? { ...game.garageState() } : null; },
    },
    /** The renderer, for capture scripts that read its meters; null until the game exists. */
    get renderer() { return game ? game.renderer : null; },
  };

  return {
    hooks,
    attach(g) {
      game = g;
      attached(g);
    },
    /** Records an error with its context. */
    fail(message) {
      hooks.errors.push(message);
    },
  };
}
