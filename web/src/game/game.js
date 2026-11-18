// The game: everything between the boot sequence and the modules it glues together.
//
// `createGame` receives the finished pieces (renderer, physics, world, audio, UI, vehicle
// models) and returns an object whose `frame(dt)` runs one frame: input, fixed-step
// simulation, environment, camera, lamps and effects, audio, HUD, render. Nothing in here
// touches the DOM, so the same code runs against mocks in Node.
//
// Order within a frame, and why:
//   1. one-shot actions and the fade between scenes (they may move the car);
//   2. driver input to the player's vehicle;
//   3. traffic drivers, then physics, for the whole number of 120 Hz steps this frame holds;
//      traffic first, because it tells physics where its boxes must be at the end of them;
//   4. clock and weather, which give the environment;
//   5. the player's drawn pose (interpolated), then the camera that looks at it;
//   6. traffic poses, lamps of everything, exhaust flames, particle emitters;
//   7. world streaming around the camera, audio, HUD, and the renderer.
//
// In the garage (design/GARAGE.md) the same frame runs with the street left out: the car's
// vehicle stands parked where the drive will begin and is drawn on the turntable instead, no
// traffic moves, and the world keeps the street around the car loaded so that Drive does not
// wait for it.

import { saturate, smoothstep, lerp } from '../core/math.js';
import { FIXED_DT, KIND, surfaceOfField, carSpec } from '../physics/index.js';
import { CARS, carById, DEFAULT_CAR } from '../vehicles/cars.js';
import { MARKING_FILL } from '../world/roads/markings.js';
import { applyPreset, isPresetName } from '../ui/settings.js';
import { FixedStepper, MAX_STEPS_PER_FRAME } from './loop.js';
import { createClock, WEATHER_LABELS, TIME_LABELS } from './clock.js';
import { prepareLaneGraph } from './lanes.js';
import { writeSignalLamps } from './signals.js';
import { LampBuffer } from './lamps.js';
import { createPlayer } from './player.js';
import { createCamera } from './camera.js';
import { createTraffic } from './traffic.js';
import { createEffects } from './effects.js';
import { createHudFeed } from './hud.js';
import { ENGINE } from '../render/identity.js';
import { createAutopilot } from './autopilot.js';
import { createNitrous } from './nitrous.js';
import { createSkidMarks } from './skids.js';
import { createPhase } from './state.js';
import { allowedCar, preparePaints, paintOf, rememberPaint, cycleOf, stepCar, cycleDirection, createCarCache } from './garage.js';
import { createShowroom } from './showroom.js';
import { createGarageRig } from './garageRig.js';

/** Height of the land (design/ARCHITECTURE.md, coordinate conventions). */
const LAND_Y = 1.2;
const DEFAULT_SEED = 1986;

const FADE_OUT_SECONDS = 0.3, FADE_IN_SECONDS = 0.6;
const HOLD_MAX_SECONDS = 8; // longest the screen stays dark waiting for tiles
const SETTLE_MOVING_SPEED = 2; // m/s above which __vice.settle no longer waits for tiles
const HOLD_MIN_FRAMES = 2; // frames drawn dark before fading in, so nothing half-loaded shows
const NEAR_RADIUS = 140; // m around the car that must be loaded before a scene is shown
const WATER_RECOVER_SECONDS = 1.6;
const RECOVER_SEARCH = 400; // m
const SURROUNDINGS_INTERVAL = 0.25; // s between samples of what is around the car, for audio
const DRY_GRIP = 1, WET_GRIP = 0.8;
const HEADLAMP_LABELS = { auto: 'Headlamps: automatic', on: 'Headlamps: on', off: 'Headlamps: off' };
const TITLE_INPUT = Object.freeze({ throttle: 0, brake: 0, steer: 0, handbrake: 1 });
// The garage's detail by graphics preset (design/GARAGE.md, The set); High and beyond get the full set.
const GARAGE_DETAIL = Object.freeze({ low: 0, medium: 1 });
const GARAGE_FULL_DETAIL = 2;
// From Drive to the cut to the street: the door is a good way up and the lamps are lit.
const GARAGE_DRIVE_SECONDS = 2.4;
// What the automatic headlamps are told in the garage: a bright day until Drive, then night,
// so the lamps (and pop-up pods) come up as the door rises.
const GARAGE_LAMPS_OFF = 1, GARAGE_LAMPS_ON = -1;
const ROAD_KINDS = ['road', 'junction', 'bridge'];
const OPEN_KINDS = ['beach', 'sand', 'park', 'grass', 'water'];

/**
 * @param {object} deps
 * @param {object} deps.renderer   section 7
 * @param {object} deps.physics    src/physics
 * @param {object} deps.world      section 9.2 and 15
 * @param {object|null} deps.audio section 11.4, or null
 * @param {object} deps.ui         section 11.3
 * @param {object} deps.settings   section 11.2, edited in place by the menus
 * @param {{car: object, carId: string, traffic: object[]}} deps.models  the player's car, its registry id, the traffic types
 * @param {(id: string) => Promise<object>} [deps.buildCar]  builds another player car's model (models.js)
 * @param {(detail: number) => Promise<object>} [deps.buildGarage]  builds the garage set (models.js, buildGarageSet)
 * @param {() => void} [deps.saveSettings]  writes `settings` to storage
 * @param {{deriveEnvironment: Function, TIME_PRESETS: object, createLightning?: Function}} deps.sky
 * @param {object} deps.options    from parseOptions (automation.js)
 * @param {object} deps.input      from createInput
 * @param {object|null} [deps.tuner]  from createAutoTuner
 * @param {() => number} [deps.now]   milliseconds, monotonic
 * @param {(phase: string) => void} [deps.onPhase]
 * @param {() => void} [deps.onReady]  the first scene is loaded and visible
 * @param {(settings: object) => void} [deps.onSettings]  after settings were applied
 */
export function createGame(deps) {
  const { renderer, physics, world, audio, ui, settings, models, sky, options, input } = deps;
  const tuner = deps.tuner || null;
  const now = deps.now || (() => 0);
  const plan = world.plan || {};
  const seed = options.seed === null || options.seed === undefined ? DEFAULT_SEED : options.seed;
  const graph = plan.laneGraph && plan.laneGraph.lanes && plan.laneGraph.lanes.length > 0 ? prepareLaneGraph(plan.laneGraph) : null;

  const phase = createPhase((next) => { if (deps.onPhase) deps.onPhase(next); });
  const stepper = new FixedStepper(FIXED_DT, MAX_STEPS_PER_FRAME);
  const lamps = new LampBuffer();
  const clock = createClock({
    sky, seed,
    timeFlow: 0,
    time: options.time === null ? 'dusk' : options.time,
    weather: options.weather || settings.game.weather,
    onThunder: (distance) => { if (audio) audio.thunder(distance); },
  });
  clock.frozen = options.freeze;

  physics.setGroundPlane(LAND_Y);
  if (typeof world.field === 'function') physics.setSurfaceSampler((x, z) => surfaceOfField(world.field(x, z).kind));

  // The car being driven. `setCar` replaces both; nothing else may keep the player object, its
  // vehicle or its model across frames (see adoptPlayer for the few values that are copied).
  let carId = models.carId;
  let player = createPlayer({ renderer, physics, model: models.car, spec: carSpec(carId) });
  const ray = { origin: [0, 0, 0], direction: [0, -1, 0] };
  const camera = createCamera({
    obstruction(origin, direction, maxDistance) {
      const hit = physics.raycast(origin, direction, maxDistance, player.vehicle);
      // Walls and the ground stop the camera; poles and other cars are too thin or too
      // brief to be worth a jump of the view.
      if (!hit.hit || hit.kind === KIND.POLE || hit.kind === KIND.TRAFFIC || hit.kind === KIND.VEHICLE || hit.kind === KIND.WATER) return maxDistance;
      return hit.dist;
    },
  });
  const traffic = createTraffic({
    renderer, physics, graph, models: models.traffic, seed,
    // What the patrol dispatch tells the player: a toast, in the game's own words.
    notify: (text) => { toast(text); },
  });
  /** Paloma PD (game/police.js): null where there is no road network to chase anyone over. */
  const police = traffic.police;
  const effects = createEffects({ physics, audio, camera, input, settings });
  const hud = createHudFeed({ ui, world });
  const skids = createSkidMarks({ renderer, rubberFill: MARKING_FILL.RUBBER });
  const tyreWidths = [0, 0, 0, 0];
  const nitrous = createNitrous({ audio, seed });
  const autopilot = graph ? createAutopilot({ graph, physics, seed }) : null;
  let autopilotOn = options.autopilot && autopilot !== null;
  const autoInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };

  const subject = {
    pos: null, quat: null, yaw: 0, vel: null, forwardSpeed: 0, yawRate: 0,
    lookBack: false, roughness: 0, bonnet: null, length: 0, height: 0, boost: 0,
  };
  const frame = {
    time: 0, dt: 0, camera, env: null,
    lights: lamps.lights, lightCount: 0, glows: lamps.glows, glowCount: 0, occluders: lamps.occluders, occluderCount: 0,
    spray: effects.spray, exhaust: nitrous.exhaust, speedEffect: 0, exposureBias: 0, fade: 1,
    /** World height of the road the wet-road mirror lies in: the road under the player's car. */
    reflectionPlaneY: 0,
    /** Where the scene reflection probe is captured: the player's car, a metre above the road. */
    reflectionOrigin: [0, 0, 0],
    /** The room of an interior frame (design/GARAGE.md), null on the street. */
    room: null,
    /** The lens' focus, set by the garage's camera rig; an aperture of 0 keeps everything sharp. */
    focus: { distance: 0, aperture: 0 },
  };
  const audioState = {
    listener: { position: camera.position, forward: camera.forward, velocity: camera.velocity },
    car: { rpm: 0, redline: 1, throttle: 0, load: 0, gear: 1, speed: 0, slip: 0, slipAngle: 0, brake: 0, surface: 'asphalt', airborne: false, wet: 0, boost: 0, turbo: 0, cabin: 0 },
    env: { rain: 0, wind: 0, night: 0, oceanProximity: 0, cityDensity: 0.5, underCover: 0, timeOfDay: 12, district: '', neon: 0 },
    traffic: traffic.audible,
  };
  const statsOut = {};
  const graphics = {};
  const settleWaiters = [];
  const place = [0, 0, 0];

  // Scene changes go through black: fade out, do the change, wait for the tiles, fade in.
  const transition = { stage: 'hold', action: null, ready: null, held: 0, frames: 0 };
  let qualityLocked = options.quality !== null;
  let graphicsSignature = '';
  let ready = false;
  let waterTime = 0;
  let surroundingsTimer = 0;
  let hornOn = false;
  let physicsMs = 0, gameMs = 0;
  let cameraDistance = 6;
  let wasMeasuring = tuner ? tuner.measuring : false;
  // Changing the car: the id asked for last, and the promise of the change in progress.
  let carWanted = carId;
  let carChange = null;
  const carCache = createCarCache((id) => {
    if (typeof deps.buildCar !== 'function') throw new Error('this build cannot change cars');
    return deps.buildCar(id);
  });
  carCache.put(carId, models.car);
  const testCars = new Set(carById(carId).released ? [] : [carId]);

  // The garage. Its set is built the first time it is needed and then kept.
  const driveSpot = options.pos
    ? { x: options.pos[0], z: options.pos[1], yaw: options.pos[2] }
    : spotOr(plan.spawn, firstRoadPoint());
  // The set stands where the drive begins, its floor at the height of the land: its surfaces
  // are the street's materials, which read heights from there, and whole metres keep its
  // vertices exact. It shares the place with the street without meeting it: a frame draws one
  // of the two worlds, never both.
  const garageOrigin = [Math.round(driveSpot.x), LAND_Y, Math.round(driveSpot.z)];
  const showroom = createShowroom({ renderer, origin: garageOrigin });
  let rig = null;
  let garageSet = 'none'; // 'none' | 'building' | 'ready' | 'failed'
  let departing = -1; // seconds since Drive was chosen in the garage, negative before
  let departureFading = false;
  const garageLook = { yaw: 0, pitch: 0, zoom: 0, held: false, aspect: 16 / 9 };
  const rigOut = { position: [0, 0, 0], target: [0, 0, 0], fov: 0.6, cut: false, focusDistance: 0, aperture: 0 };
  const garageInfo = { phase: 'boot', open: false, car: carId, wanted: carId, status: 'ready', paint: 0, door: 0, departing: false, set: 'none', cached: [] };
  const idleWaiters = [];
  adoptPlayer();

  // ------------------------------------------------------------------ helpers

  const toast = (text) => { if (text) ui.toast(text); };

  /**
   * Hands the current player's car to everything that holds a piece of it: the camera's
   * subject, the skid marks' tyre widths, the exhaust flames, the sound of the engine.
   */
  function adoptPlayer() {
    const dims = player.model.dims, spec = player.vehicle.spec;
    subject.pos = player.pos; subject.quat = player.quat; subject.vel = player.vehicle.vel;
    subject.bonnet = player.bonnetCam; subject.length = player.length; subject.height = player.height;
    tyreWidths[0] = tyreWidths[1] = dims.tyreWidthFront;
    tyreWidths[2] = tyreWidths[3] = dims.tyreWidthRear;
    nitrous.setPipes(player.exhausts);
    frame.reflectionPlaneY = player.groundY;
    if (audio) audio.setCar({ voice: carById(carId).voice, idle: spec.engine.idle, redline: spec.engine.redline });
  }

  /** The colour this car was left in, on the car and in the garage's swatches. */
  function applyRememberedPaint() {
    const applied = player.setPaint(paintOf(settings, carId));
    rememberPaint(settings, carId, applied);
    ui.setPaints(player.paints, applied, player.model.paintNames);
    ui.setState({ paint: applied });
  }

  const tellGarage = (event) => { if (audio) audio.garage(event); };

  /** The cars that left and right step through: the finished ones and those under test this session. */
  const carCycle = () => cycleOf(CARS, testCars);

  /** Tells the garage's overlay which cars there are; a car under test joins them when first shown. */
  function offerCars() {
    ui.setCars(carCycle().map(({ id, name, line }) => ({ id, name, line })), carId);
  }

  /** Builds the two neighbours of the car on show while the player looks at it. */
  function warmNeighbours() {
    const cycle = carCycle();
    const ids = [stepCar(cycle, carId, 1), stepCar(cycle, carId, -1)].filter((id, i, all) => id !== carId && all.indexOf(id) === i);
    if (ids.length > 0) carCache.warm(ids);
  }

  const tellCarState = (status, wanted) => {
    ui.setCarState({ id: carId, status, wanted });
  };

  /**
   * Puts another car where the player's car stands, at rest, and releases the old car's
   * meshes, drawn objects and physics body. The new car is made first: if its model turns
   * out to be unusable the old car is still whole, and the error is the caller's to report.
   */
  function replaceCar(model, id) {
    const old = player;
    const next = createPlayer({ renderer, physics, model, spec: carSpec(id) });
    const x = old.vehicle.pos[0], z = old.vehicle.pos[2], yaw = old.vehicle.yaw;
    // The ground the old car stood on, not a fresh search: under a bridge the two differ.
    place[0] = x; place[1] = old.groundY + 0.03; place[2] = z;
    const headlampMode = old.headlampMode;
    // A car under test takes its place in the cycle the first time it is shown.
    const added = !carById(id).released && !testCars.has(id);
    if (added) testCars.add(id);
    const direction = cycleDirection(carCycle(), carId, id);
    skids.lift();
    old.dispose();
    carId = id;
    player = next;
    player.headlampMode = headlampMode;
    adoptPlayer();
    player.place(place, yaw);
    nitrous.reset();
    stepper.reset();
    waterTime = 0;
    if (autopilot) autopilot.reset();
    if (hornOn && audio) { hornOn = false; audio.horn(false); }
    refreshSubject();
    // The new car is another length and height: the camera takes its place for it at once.
    camera.snap();
    if (added) offerCars();
    applyRememberedPaint();
    if (phase.name === 'garage') {
      showCarInGarage(direction);
      tellGarage('car');
      warmNeighbours();
    }
  }

  /** Stands the player's car on the turntable and frames it. */
  function showCarInGarage(direction) {
    showroom.update(0, player);
    player.stage(showroom.carPos, showroom.carQuat);
    const dims = player.model.dims;
    rig.setCar({ length: dims.length, width: dims.width, height: dims.height }, direction);
  }

  /**
   * Builds and swaps in the car wanted last, until the car in the scene is the one wanted.
   * One build runs at a time; a request made meanwhile only changes what is built next.
   * @returns {Promise<string>} the id of the car in the scene
   */
  async function changeCar() {
    while (carWanted !== carId) {
      const id = carWanted;
      tellCarState('building', id);
      // A car already built is in the scene within the frame; only a real wait dims the room.
      showroom.setBuilding(!carCache.has(id));
      let shown = false;
      try {
        const model = await carCache.get(id);
        // Asked for something else while this one was building: its model is not needed.
        if (carWanted !== id) continue;
        replaceCar(model, id);
        shown = true;
      } catch (error) {
        console.warn(`The ${carById(id).name} could not be built, the ${carById(carId).name} stays: ${error && error.message ? error.message : String(error)}`);
        // A model that was built but cannot be shown is not offered again from the cache.
        carCache.drop(id);
      }
      if (carWanted !== id) continue;
      if (!shown) {
        carWanted = carId;
        tellCarState('failed', id);
        break;
      }
      // Only a finished car becomes the saved choice; a car under test lasts for the session.
      if (allowedCar(id, false)) {
        settings.game.car = id;
        if (deps.saveSettings) deps.saveSettings();
      }
      tellCarState('ready', id);
    }
    showroom.setBuilding(false);
    return carId;
  }

  /** Height of the ground at (x, z): the road if one is near, else whatever is loaded there. */
  function groundHeight(x, z) {
    if (graph) {
      const hit = graph.nearest(x, z, 9);
      if (hit) return hit.y;
    }
    ray.origin[0] = x; ray.origin[1] = LAND_Y + 40; ray.origin[2] = z;
    const hit = physics.raycast(ray.origin, ray.direction, 60, player.vehicle);
    if (hit.hit && hit.normal[1] > 0.5 && hit.kind <= KIND.GRASS) return ray.origin[1] - hit.dist;
    return LAND_Y;
  }

  /** Puts the car at rest at (x, z) and makes everything that follows it start afresh. */
  function placeCar(x, z, yaw, withTraffic = true) {
    place[0] = x; place[1] = groundHeight(x, z) + 0.03; place[2] = z;
    skids.lift();
    player.place(place, yaw);
    nitrous.reset();
    stepper.reset();
    camera.snap();
    waterTime = 0;
    if (autopilot) autopilot.reset();
    // The player has been moved: whatever the units were chasing is gone with it.
    if (police) police.reset();
    traffic.clear();
    refreshSubject();
    // Traffic is placed around where the camera will be, so the camera goes there first; the
    // frame that shows the new place must still be a cut for the renderer.
    camera.update(0, subject);
    camera.snap();
    if (!withTraffic) return;
    traffic.setFocus(player, camera);
    traffic.populate();
  }

  function spotOr(spot, fallback) {
    if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.z)) return spot;
    return fallback;
  }

  function firstRoadPoint() {
    if (!graph || graph.roadLanes.length === 0) return { x: 0, z: 0, yaw: 0 };
    const lane = graph.roadLanes[0], p = lane.pts;
    return { x: p[0], z: p[2], yaw: Math.atan2(p[3] - p[0], p[5] - p[2]) };
  }

  function refreshSubject() {
    subject.yaw = player.yaw;
    subject.forwardSpeed = player.forwardSpeed;
    subject.yawRate = player.yawRate;
    subject.roughness = player.roughness;
    subject.boost = nitrous.flow;
    subject.lookBack = input.state.lookBack > 0;
  }

  /** The graphics settings as the renderer should see them right now. */
  function effectiveGraphics() {
    Object.assign(graphics, settings.graphics);
    // Dynamic resolution would hide what the auto-tuner measures, and a forced preset must
    // stay exactly as asked.
    if (qualityLocked || (tuner && tuner.measuring)) graphics.dynamicResolution = false;
    return graphics;
  }

  function applySettings() {
    const g = effectiveGraphics();
    const signature = JSON.stringify(g);
    if (signature !== graphicsSignature) {
      graphicsSignature = signature;
      renderer.setQuality(g);
    }
    if (typeof world.setDensity === 'function') world.setDensity(settings.graphics.density);
    traffic.setDensity(options.traffic === null ? settings.graphics.traffic : options.traffic);
    input.sensitivity = settings.controls.steerSensitivity || 1;
    if (phase.name === 'driving' || phase.name === 'paused') clock.timeFlow = settings.game.timeFlow;
    clock.reduceFlashing = Boolean(settings.game.reduceFlashing);
    if (audio) {
      const a = settings.audio, mute = options.mute ? 0 : 1;
      audio.setVolumes({ master: a.master * mute, effects: a.effects });
    }
    if (deps.onSettings) deps.onSettings(settings);
  }

  // ------------------------------------------------------------------ scenes

  function titleScene() {
    clock.timeFlow = 0;
    clock.setTime(options.time === null ? 'dusk' : options.time, true);
    const spot = spotOr(plan.titleSpot, spotOr(plan.spawn, firstRoadPoint()));
    camera.setMode(options.cam || 'orbit');
    placeCar(spot.x, spot.z, spot.yaw || 0);
    input.driving = false;
  }

  function driveScene() {
    clock.timeFlow = settings.game.timeFlow;
    clock.setTime(options.time === null ? settings.game.startTime : options.time, true);
    const spot = spotOr(plan.spawn, firstRoadPoint());
    camera.setMode(options.cam || 'chase');
    if (options.pos) placeCar(options.pos[0], options.pos[1], options.pos[2]);
    else placeCar(spot.x, spot.z, spot.yaw || 0);
    input.driving = true;
    ui.showHud();
  }

  /** Starts building the garage set, once. The promise settles either way; `garageSet` says how. */
  function loadGarage() {
    if (garageSet !== 'none') return;
    garageSet = 'building';
    Promise.resolve().then(() => {
      if (typeof deps.buildGarage !== 'function') throw new Error('this build has no garage');
      const detail = GARAGE_DETAIL[settings.graphics.preset];
      return deps.buildGarage(detail === undefined ? GARAGE_FULL_DETAIL : detail);
    }).then((built) => {
      showroom.load(built);
      rig = createGarageRig({ anchors: built.set.anchors, origin: garageOrigin });
      garageSet = 'ready';
    }).catch((error) => {
      garageSet = 'failed';
      console.warn(`The garage could not be built, Play goes straight to the street: ${error && error.message ? error.message : String(error)}`);
    });
  }

  /** Behind the fade: into the garage, or, with no room to show, to where Play led before there was one. */
  function garageScene() {
    if (garageSet !== 'ready') {
      if (phase.name === 'driving') input.driving = true;
      else if (phase.name !== 'paused' && phase.to('driving')) driveScene();
      return;
    }
    if (!phase.to('garage')) return;
    clock.timeFlow = 0;
    clock.interior = true;
    camera.setMode('garage');
    // The vehicle waits on the street where the drive begins; the street's traffic comes with Drive.
    placeCar(driveSpot.x, driveSpot.z, driveSpot.yaw || 0, false);
    input.driving = false;
    input.looking = true;
    departing = -1; departureFading = false;
    frame.spray = null; frame.exhaust = null;
    frame.room = showroom.room;
    frame.reflectionOrigin[0] = showroom.probe[0]; frame.reflectionOrigin[1] = showroom.probe[1]; frame.reflectionOrigin[2] = showroom.probe[2];
    showroom.enter();
    showCarInGarage(0);
    rig.reset(); // after the car: its arrival is a cut to the next angle, entering is the home angle
    if (hornOn && audio) { hornOn = false; audio.horn(false); }
    tellGarage('enter');
    ui.showGarage();
    warmNeighbours();
  }

  /** Behind the fade: the car back on the street, the frame the street's again. */
  function leaveGarage() {
    clock.interior = false;
    input.looking = false;
    departing = -1; departureFading = false;
    player.stage(null, null);
    frame.spray = effects.spray; frame.exhaust = nitrous.exhaust;
    frame.room = null;
    frame.focus.distance = 0; frame.focus.aperture = 0;
    tellGarage('leave');
  }

  /** Drive in the garage: the door rises, the lamps come on, and the picture cuts to the street. */
  function departGarage() {
    if (departing >= 0 || transition.action) return;
    departing = 0;
    ui.hideAll(); // the last shot of the room is the car's alone
    showroom.openDoor();
    rig.drive();
    tellGarage('drive');
  }

  function advanceDeparture(dt) {
    if (departing < 0) return;
    departing += dt;
    if (departureFading || departing < GARAGE_DRIVE_SECONDS - FADE_OUT_SECONDS) return;
    departureFading = true;
    fadeThrough(() => {
      leaveGarage();
      if (phase.to('driving')) driveScene();
    });
  }

  /**
   * Runs `action` behind a fade. A change requested during a fade replaces the pending one.
   * @param {() => void} action
   * @param {(() => boolean)|null} [ready]  the screen stays dark until this is true, then `action` runs
   */
  function fadeThrough(action, ready = null) {
    transition.action = action;
    transition.ready = ready;
    if (transition.stage === 'hold' && (!ready || ready())) runTransitionAction();
    else transition.stage = 'out';
  }

  function runTransitionAction() {
    const action = transition.action;
    transition.action = null;
    transition.ready = null;
    transition.stage = 'hold';
    transition.held = 0;
    transition.frames = 0;
    if (action) action();
  }

  function advanceTransition(dt) {
    if (transition.stage === 'out') {
      frame.fade = Math.min(1, frame.fade + dt / FADE_OUT_SECONDS);
      if (frame.fade >= 1 && (!transition.ready || transition.ready())) runTransitionAction();
    } else if (transition.stage === 'hold') {
      frame.fade = 1;
      transition.held += dt;
      transition.frames++;
      // The garage shows nothing of the street: it need not wait for the tiles it keeps warm.
      const loaded = phase.name === 'garage' || world.isReady(player.pos, NEAR_RADIUS) || transition.held > HOLD_MAX_SECONDS;
      if (loaded && transition.frames > HOLD_MIN_FRAMES && phase.name !== 'boot') transition.stage = 'in';
    } else if (transition.stage === 'in') {
      frame.fade = Math.max(0, frame.fade - dt / FADE_IN_SECONDS);
      if (frame.fade <= 0) transition.stage = 'none';
    }
  }

  // ------------------------------------------------------------------ actions

  function recoverToRoad() {
    const p = player.vehicle.pos;
    const hit = graph ? graph.nearest(p[0], p[2], RECOVER_SEARCH, (lane) => !lane.junction) : null;
    if (hit) {
      place[0] = hit.x; place[1] = hit.y + 0.03; place[2] = hit.z;
      skids.lift();
      player.place(place, hit.yaw);
      camera.snap();
      if (autopilot) autopilot.reset();
    } else {
      player.vehicle.recover();
    }
    waterTime = 0;
  }

  function handlePresses() {
    const driving = phase.name === 'driving' && transition.stage === 'none';
    if (input.consume('pause') && driving) game.pause();
    if (input.consume('camera') && driving) camera.nextMode();
    if (input.consume('headlamps') && driving) toast(HEADLAMP_LABELS[player.cycleHeadlamps()]);
    if (input.consume('recover') && phase.name === 'driving') { recoverToRoad(); toast('Back on the road'); }
    if (input.consume('time') && driving) {
      const name = clock.nextTimePreset();
      toast(TIME_LABELS[name] || name);
      ui.setState({ time: name });
    }
    if (input.consume('weather') && driving) {
      const name = clock.nextWeather();
      toast(WEATHER_LABELS[name] || name);
      ui.setState({ weather: name });
    }
  }

  /** What surrounds the car, sampled a few times a second for the audio ambience. */
  function sampleSurroundings(dt) {
    surroundingsTimer -= dt;
    if (surroundingsTimer > 0 || typeof world.field !== 'function') return;
    surroundingsTimer = SURROUNDINGS_INTERVAL;
    const field = world.field(player.pos[0], player.pos[2]);
    const env = audioState.env;
    env.oceanProximity = Number.isFinite(field.distShore) ? saturate(1 - field.distShore / 260) : 0;
    env.cityDensity = lerp(env.cityDensity, OPEN_KINDS.includes(field.kind) ? 0.15 : 0.75, 0.3);
  }

  function feedAudio(simDt) {
    const vehicle = player.vehicle, car = audioState.car, env = audioState.env, weather = clock.weather;
    car.rpm = vehicle.rpm; car.redline = vehicle.redline; car.throttle = vehicle.throttle; car.load = vehicle.throttle;
    car.gear = vehicle.gear; car.speed = vehicle.speed; car.slip = player.slip; car.slipAngle = player.slipAngle;
    car.brake = vehicle.brake; car.surface = player.surface; car.airborne = vehicle.airborne; car.wet = weather.wetness; car.boost = nitrous.flow;
    car.turbo = vehicle.turbo || 0;
    car.cabin = camera.mode === 'bonnet' ? 1 : 0;
    env.rain = weather.rain; env.wind = Math.hypot(weather.windX, weather.windZ); env.night = clock.env.night;
    env.timeOfDay = clock.timeOfDay; env.district = hud.district; env.neon = clock.env.switches.neon;
    audio.update(simDt, audioState);
    // The wail of the nearest unit, silent (and unbuilt) while nobody is after the player.
    if (police && audio.siren) audio.siren(phase.name === 'driving' ? police.siren.level : 0, police.siren.position);
    const horn = phase.name === 'driving' && input.state.horn > 0;
    if (horn !== hornOn) { hornOn = horn; audio.horn(horn); }
  }

  // ------------------------------------------------------------------ public

  const game = {
    phase, renderer, clock, camera, traffic, graph, input, effects, skids, nitrous, stepper, frameData: frame,

    /** The player's car (createPlayer). Replaced by `setCar`: read it afresh, do not keep it. */
    get player() { return player; },
    /** Registry id of the car being driven. */
    get carId() { return carId; },
    /** The renderer's own name (the engine this game was built on), for menus and tools. */
    engine: ENGINE,
    /** Paloma PD: what the units are doing, as plain data (null without a road network). */
    get police() { return police ? police.snapshot() : null; },
    /** Paloma PD for scripts: 1..3 orders an incident, 0 ends one as a completed stop. */
    orderPolice(heat, message) {
      if (!police) return null;
      police.order(heat, message);
      return police.snapshot();
    },

    /** Sets the title scene up behind the loading screen, so that warm-up sees its meshes. */
    prepareTitle() {
      applySettings();
      preparePaints(settings);
      offerCars();
      applyRememberedPaint();
      tellCarState('ready', carId);
      if (options.debug > 0) renderer.debug(options.debug);
      titleScene();
    },

    /**
     * Loading has finished: shows the title screen, or starts driving at once (autostart), or
     * opens the garage (`?garage=1`).
     */
    begin() {
      if (options.autostart) {
        driveScene();
        phase.to('driving');
      } else if (options.garage) {
        game.openGarage();
      } else {
        phase.to('title');
        ui.showTitle();
        // Play leads to the garage: its set is built while the player reads the title.
        loadGarage();
      }
    },

    /**
     * Drive. In the garage the door rises and the picture cuts to the street; from the title
     * (scripts, and a build without a garage) the drive begins behind a fade. With a car still
     * being built, the drive starts in it once it is in.
     */
    start() {
      if (phase.name !== 'title' && phase.name !== 'garage') return;
      if (departing >= 0) return;
      if (carChange) { carChange.then(() => game.start()); return; }
      if (phase.name === 'garage') { departGarage(); return; }
      fadeThrough(() => {
        if (phase.to('driving')) driveScene();
      });
    },

    /**
     * Play on the title screen (and, for scripts, from a drive or a pause): to the garage
     * behind a fade, which stays dark until the set is built.
     */
    openGarage() {
      if (phase.name === 'garage' || phase.name === 'error') return;
      loadGarage();
      input.driving = false;
      fadeThrough(garageScene, () => garageSet !== 'building');
    },

    /** Back in the garage: to the title screen. Not once the door is rising. */
    closeGarage() {
      if (phase.name !== 'garage' || departing >= 0) return;
      fadeThrough(() => {
        leaveGarage();
        if (!phase.to('title')) return;
        titleScene();
        ui.showTitle();
      });
    },

    /** The next (+1) or previous (-1) car of the garage's cycle; see setCar for what it returns. */
    cycleCar(delta) {
      return game.setCar(stepCar(carCycle(), carWanted, delta), { unreleased: true });
    },

    pause() {
      if (!phase.to('paused')) return;
      input.driving = false;
      ui.showPause();
    },

    resume() {
      if (!phase.to('driving')) return;
      input.driving = true;
      ui.showHud();
    },

    quitToMenu() {
      if (phase.name !== 'driving' && phase.name !== 'paused') return;
      input.driving = false;
      fadeThrough(() => {
        if (phase.to('title')) titleScene();
      });
    },

    /** Menu actions: time and weather arrive as fronts, not jumps, unless `instant`. */
    setTime(value, instant = false) {
      const ok = clock.setTime(value, instant);
      if (ok) ui.setState({ time: clock.nearestTimePreset() });
      return ok;
    },

    setWeather(name, instant = false) {
      const ok = clock.setWeather(name, instant);
      if (ok) ui.setState({ weather: name });
      return ok;
    },

    /** Paints the car being driven; each car remembers its own colour. */
    setPaint(index) {
      const before = player.paintIndex;
      const applied = player.setPaint(index);
      rememberPaint(settings, carId, applied);
      ui.setState({ paint: applied });
      if (applied !== before) {
        if (phase.name === 'garage') tellGarage('colour');
        if (deps.saveSettings) deps.saveSettings();
      }
      return applied;
    },

    /**
     * Changes the car: builds its model, then replaces the car in the scene where it stands, at
     * rest. May be called again before the change is done; the last call decides, and every
     * pending call resolves when the scene has caught up with it.
     * @param {string} id  registry id; unknown ids, and unreleased ones unless allowed, select the default car
     * @param {{unreleased?: boolean}} [options]  unreleased: cars not yet in the Garage may be chosen (scripts)
     * @returns {Promise<string>} the id of the car in the scene: `id`, or the car that stayed
     *   because `id` could not be built
     */
    setCar(id, { unreleased = false } = {}) {
      // Once the door is rising the car on the turntable is the one that drives out.
      if (departing >= 0) return carChange || Promise.resolve(carId);
      // A car under test stays selectable for the session once it has been shown.
      carWanted = allowedCar(id, unreleased || testCars.has(id)) || DEFAULT_CAR;
      if (!carChange) carChange = changeCar().finally(() => { carChange = null; });
      return carChange;
    },

    /** What the garage is doing, for scripts and tests; one object, rewritten on each call. */
    garageState() {
      garageInfo.phase = phase.name;
      garageInfo.open = phase.name === 'garage';
      garageInfo.car = carId;
      garageInfo.wanted = carWanted;
      garageInfo.status = carChange ? 'building' : 'ready';
      garageInfo.paint = player.paintIndex;
      garageInfo.door = showroom.doorOpening;
      garageInfo.departing = departing >= 0;
      garageInfo.set = garageSet === 'ready' && showroom.standIn ? 'stand-in' : garageSet;
      garageInfo.cached = carCache.ids;
      return garageInfo;
    },

    /**
     * Resolves after the first frame on which nothing is in progress: no fade, no change of
     * scene pending, no car being built, no door rising.
     */
    idle() {
      return new Promise((resolve) => { idleWaiters.push(resolve); });
    },

    /** A named preset, held: no automatic changes and no dynamic resolution afterwards. */
    setQuality(preset) {
      if (!isPresetName(preset)) return false;
      applyPreset(settings, preset);
      qualityLocked = true;
      applySettings();
      ui.setState({});
      return true;
    },

    setCamera(mode, pose) {
      return camera.setMode(mode, pose);
    },

    setAutopilot(on) {
      autopilotOn = Boolean(on) && autopilot !== null;
      if (autopilot) autopilot.reset();
    },

    applySettings,

    /** Held actions from script, until changed; null hands the controls back. */
    injectInput(actions) {
      input.inject(actions);
    },

    teleport(x, z, yaw = 0) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      placeCar(x, z, yaw);
      return true;
    },

    carState() {
      const p = player.vehicle.pos, vehicle = player.vehicle;
      const kind = typeof world.field === 'function' ? world.field(p[0], p[2]).kind : 'road';
      return { id: carId, position: [p[0], p[1], p[2]], yaw: vehicle.yaw, speed: vehicle.speed, rpm: vehicle.rpm, gear: vehicle.gear, onRoad: ROAD_KINDS.includes(kind) };
    },

    stats() {
      const w = world.stats || {};
      return Object.assign(statsOut, renderer.stats, {
        physicsMs, gameMs, car: carId, traffic: traffic.count, parked: traffic.parkedCount,
        tilesLoaded: w.tilesLoaded || 0, tilesPending: w.tilesPending || 0, workerMs: w.workerMs || 0,
      });
    },

    /** Resolves once the tiles around the car are loaded and `frames` more frames were drawn. */
    settle(frames = 30) {
      return new Promise((resolve) => { settleWaiters.push({ frames: Math.max(1, frames | 0), resolve }); });
    },

    tileLoaded(tile) { traffic.addTile(tile); },
    tileReleased(key) { traffic.removeTile(key); },

    get ready() { return ready; },

    /**
     * One frame.
     * @param {number} dt       seconds since the previous frame, already clamped by the pacer
     * @param {number} [frameMs] real time between the two frames in milliseconds, for the auto-tuner
     */
    frame(dt, frameMs = dt * 1000) {
      const t0 = now();
      handlePresses();
      advanceDeparture(phase.name === 'garage' ? dt : 0);
      advanceTransition(dt);
      const simDt = phase.running ? dt : 0;
      const inGarage = phase.name === 'garage';

      // Input.
      input.update(simDt, player.forwardSpeed);
      let controls = TITLE_INPUT;
      if (phase.name === 'driving') {
        controls = input.state;
        const hands = controls.throttle > 0 || controls.brake > 0 || controls.steer !== 0 || controls.handbrake > 0;
        if (autopilotOn && !hands) {
          controls = autopilot.update(simDt, player.vehicle, traffic.sim.time, autoInput);
          if (autopilot.stuck) recoverToRoad();
        }
      }
      // The script's or the player's finger on the nitrous also counts while the autopilot steers.
      const boost = phase.name === 'driving' ? nitrous.request(input.state.boost, controls.throttle, player.vehicle) : 0;
      player.drive(controls, boost);

      // Simulation.
      const steps = simDt > 0 ? stepper.advance(simDt) : 0;
      if (simDt > 0) {
        const p0 = now();
        if (steps > 0 && !inGarage) {
          traffic.setFocus(player, camera);
          traffic.step(steps * FIXED_DT);
        }
        physics.advance(steps, stepper.alpha);
        physicsMs += (now() - p0 - physicsMs) * 0.1;
      }

      // Environment.
      const env = clock.update(simDt, camera.position);
      const weather = clock.weather;
      physics.setGrip(lerp(DRY_GRIP, WET_GRIP, smoothstep(0.1, 0.8, weather.wetness)));

      // The car, then the camera that looks at it.
      let shown = player.pos;
      if (inGarage) {
        // The turntable carries the car, as its springs hold it on the street after this frame's steps.
        showroom.update(simDt, player);
        shown = showroom.carPos;
        player.update(simDt, departing >= 0 ? GARAGE_LAMPS_ON : GARAGE_LAMPS_OFF, 0, cameraDistance, 0);
        const look = input.look, size = renderer.stats.resolution;
        garageLook.yaw = look.yaw; garageLook.pitch = look.pitch; garageLook.zoom = look.zoom; garageLook.held = look.held;
        if (size[1] > 0) garageLook.aspect = size[0] / size[1];
        rig.update(simDt, garageLook, rigOut);
        camera.place(rigOut.position, rigOut.target, rigOut.fov);
        if (rigOut.cut) camera.snap();
        frame.focus.distance = rigOut.focusDistance; frame.focus.aperture = rigOut.aperture;
      } else {
        player.update(simDt, env.sunElevation, weather.rain, cameraDistance, weather.fog);
      }
      refreshSubject();
      camera.update(simDt, subject);
      cameraDistance = Math.hypot(camera.position[0] - shown[0], camera.position[1] - shown[1], camera.position[2] - shown[2]);
      if (player.vehicle.inWater && phase.name === 'driving') {
        waterTime += simDt;
        if (waterTime > WATER_RECOVER_SECONDS) { recoverToRoad(); toast('Back on the road'); }
      } else {
        waterTime = 0;
      }

      // Everything else that is drawn.
      lamps.reset();
      player.writeLamps(lamps, camera.position, frame.time);
      if (inGarage) {
        // The room's lights follow the car's lamps and share the renderer's interior budget with them.
        showroom.writeLights(lamps, renderer.interiorLightBudget);
      } else {
        // The dispatch works on the street while the player is driving: no policing the title
        // scene, the room, or a frame that is not moving.
        if (police) police.enabled = phase.name === 'driving';
        traffic.setFocus(player, camera);
        traffic.update(simDt, env.sunElevation, weather.rain);
        traffic.writeLamps(lamps, camera.position, frame.time);
        if (graph) writeSignalLamps(lamps, graph.junctions, traffic.sim.time, camera.position);
        nitrous.update(simDt, controls.throttle, player, lamps);
        effects.update(simDt, player, weather, traffic.audible);
        if (simDt > 0) skids.update(player.vehicle, tyreWidths, weather.wetness);
      }

      // The world follows the camera on the street, and in the garage the car waiting up there.
      world.update(inGarage ? player.pos : camera.position, dt);
      if (phase.name === 'driving') hud.update(simDt, player, clock.timeOfDay, controls.handbrake, nitrous, police ? police.status : null);
      if (audio) {
        sampleSurroundings(simDt);
        feedAudio(simDt);
      }

      frame.time += simDt;
      frame.dt = simDt;
      frame.env = env;
      frame.speedEffect = inGarage ? 0 : nitrous.speedEffect;
      if (inGarage) {
        // The mirror is the room's floor; the probe's point was fixed on entering.
        frame.reflectionPlaneY = showroom.floorY;
      } else {
        frame.reflectionPlaneY = player.groundY; // the mirror follows the car up a bridge ramp
        frame.reflectionOrigin[0] = player.pos[0]; frame.reflectionOrigin[1] = player.pos[1] + 1; frame.reflectionOrigin[2] = player.pos[2];
      }
      frame.lightCount = lamps.lightCount;
      frame.glowCount = lamps.glowCount;
      frame.occluderCount = lamps.occluderCount;
      gameMs += (now() - t0 - gameMs) * 0.1;
      renderer.render(frame);

      // After the frame: the auto-tuner, readiness, and scripts waiting for a settled scene.
      // Measured on whatever is on screen, the title scene or a drive (a script may skip the
      // title), but never through a fade or a pause, when the frame time says nothing, nor in
      // the garage, whose cost says nothing about the street's.
      if (tuner && tuner.measuring && phase.running && !inGarage && transition.stage === 'none') {
        const moved = tuner.sample(frameMs, renderer.stats ? renderer.stats.gpuMs : -1);
        if (!tuner.measuring) {
          ui.setDeviceInfo(tuner.info);
          if (moved) ui.setState({});
        }
      }
      if (tuner && wasMeasuring && !tuner.measuring) applySettings();
      wasMeasuring = tuner ? tuner.measuring : false;
      const settled = transition.stage === 'none' && phase.name !== 'boot' && world.isReady(player.pos, NEAR_RADIUS);
      if (settled && !ready) {
        ready = true;
        if (deps.onReady) deps.onReady();
      }
      // A waiting script wants a finished picture of a place, so frames only count once the
      // tiles around the car are in. Behind a moving car the tiles are still arriving by
      // nature; there the frames count as they are, or a script that drives would wait for
      // ever.
      if ((settled || (ready && Math.abs(player.vehicle.speed) > SETTLE_MOVING_SPEED)) && settleWaiters.length > 0) {
        for (let i = settleWaiters.length - 1; i >= 0; i--) {
          const waiter = settleWaiters[i];
          if (--waiter.frames > 0) continue;
          settleWaiters.splice(i, 1);
          waiter.resolve();
        }
      }
      if (idleWaiters.length > 0 && transition.stage === 'none' && !transition.action && !carChange && departing < 0 && garageSet !== 'building') {
        for (const resolve of idleWaiters.splice(0)) resolve();
      }
    },

    dispose() {
      effects.dispose();
      skids.clear();
      traffic.dispose();
      player.dispose();
      showroom.dispose();
    },
  };
  return game;
}
