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

import { saturate, smoothstep, lerp, angleDelta } from '../core/math.js';
import { FIXED_DT, KIND, surfaceOfField, carSpec, trafficSpec } from '../physics/index.js';
import { CARS, carById, DEFAULT_CAR } from '../vehicles/cars.js';
import { MARKING_FILL } from '../world/roads/markings.js';
import { applyPreset, isPresetName } from '../ui/settings.js';
import { FixedStepper, MAX_STEPS_PER_FRAME } from './loop.js';
import { createClock, WEATHER_LABELS, TIME_LABELS } from './clock.js';
import { prepareLaneGraph } from './lanes.js';
import { writeSignalLamps, signalState, SIGNAL } from './signals.js';
import { comfortSpeed } from './lanes.js';
import { LampBuffer } from './lamps.js';
import { createPlayer } from './player.js';
import { createCamera } from './camera.js';
import { createTraffic } from './traffic.js';
import { createCrowd, PEOPLE_BY_TIER } from './crowd.js';
import { createFoot, BOARD_DISTANCE, BOARD_SPEED_LIMIT } from './foot.js';
import { createVitals } from './vitals.js';
import { createBoarding, awayFromCar, SEAMS } from './boarding.js';
import { createBoats } from './boats.js';
import { buildCitizens } from '../world/people/citizens.js';
import { createRadio } from '../audio/radio.js';
import { createWeapon, WITNESS_RADIUS } from './weapons.js';
import { createPurse, formatCash } from './money.js';
import { WantedLedger } from './wanted.js';
import { createRaces, TIERS as RACE_TIERS } from './races.js';
import { createEffects } from './effects.js';
import { createHudFeed } from './hud.js';
import { ENGINE } from '../render/identity.js';
import { createAutopilot } from './autopilot.js';
import { createNitrous } from './nitrous.js';
import { createSkidMarks } from './skids.js';
import { createPhase } from './state.js';
import { allowedCar, preparePaints, paintOf, rememberPaint, cycleOf, stepCar, cycleDirection, createCarCache } from './garage.js';
import { createShowroom } from './showroom.js';
import { createShops } from './shops.js';
import * as settingsModule from '../ui/settings.js';
import { createShopRoom } from './shoproom.js';
import { createGarageRig } from './garageRig.js';

/** Height of the land (design/ARCHITECTURE.md, coordinate conventions). */
const LAND_Y = 1.2;
/** Metres: the surface of the sea the coast map meshes its bed against. Above it, air; below, breath. */
const SEA_Y = 0;
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
/** Afoot, the car is left exactly as its driver left it: no throttle, no steering, handbrake up. */
const PARKED_INPUT = TITLE_INPUT;
/** Metres under the street's own level that a walker is in the sea rather than on the shore. */
const DEEP_WATER = 1.2;

/**
 * The engine a car taken off the street is heard with. The recordings are of four engines (docs/AUDIO.md)
 * and a traffic car has none of them: it is driven on a specification of its own (physics/specs.js's
 * TRAFFIC), with its own idle and its own redline, which is what sets the rate a recording is played at.
 * What is left to choose is the character of it, so each kind takes the nearest engine there is: the small
 * cars the turbo flat-six, which is the smallest and the most modern-sounding of the four; the heavy cars
 * and the fleet the American V8, which is the lowest and has the most torque in it; a fast car a twelve.
 * A bus on a V8's recording is still a bus, because it is the bus's own 800 rpm turning it.
 */
const TRAFFIC_VOICE = Object.freeze({
  compact: 'flat6t', hatch: 'flat6t', sedan: 'flat6t', wagon: 'flat6t', taxi: 'flat6t',
  coupe: 'v12', sports: 'flat12',
  pickup: 'v8', van: 'v8', police: 'v8', bus: 'v8', truck: 'v8',
});
const voiceFor = (kind) => TRAFFIC_VOICE[kind] || 'v8';
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
  /**
   * The car he is in when it is not the car he owns: one he took off the street. `carId` stays the
   * garage's choice throughout -- that is the car the garage will hand him and the car whose colour is
   * remembered -- and this says what is actually under him while it lasts.
   * @type {{id: string, name: string, voice: string, kind: string, model: object}|null}
   */
  let stolenCar = null;
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
  // The crowd on the pavements (game/crowd.js), and the record the agency keeps of you
  // (game/wanted.js). Both are built from what the street already is: the lane graph says where the
  // pavement is, the plan says where the carriageway ends, and the dispatch says what it saw. With
  // no road network there is nobody to walk and nothing to be wanted for.
  const wanted = new WantedLedger();
  let lastHeat = 0, shownStars = 0, spedFor = 0, redChecked = -1;
  /** Where the red-light check has already been done on this lap of the approach. */
  let redLaneId = -1, redAt = -1;
  const approach = [0, 0, 0];
  const crowd = createCrowd({
    graph, plan, renderer, seed: ((seed | 0) ^ 0x506c) >>> 0, land: LAND_Y, quality: settings.graphics.preset,
    // A person driven at off the kerb is an offence, and the only witness is the crowd itself.
    onEndanger: (k) => {
      if (wanted.add('peds scattered', k > 0.8 ? 1 : 0.5)) toast('A pedestrian was struck out of the way');
    },
  });
  // The people themselves are a download: five rigged bodies and one shared clip library, vendored into
  // web/assets/models by tools/vendor_models.py. Asked for here, after the renderer and the world are up,
  // so the loading screen does not wait on three megabytes of models nobody has looked at yet -- and the
  // street says so out loud when they do not arrive, rather than quietly emptying the pavements.
  const castRequest = (async () => {
    const castModule = await import('../world/people/cast.js');
    const decode = typeof self !== 'undefined' && typeof self.createImageBitmap === 'function'
      ? async (bytes) => {
        const bitmap = await self.createImageBitmap(new self.Blob([bytes], { type: 'image/png' }));
        const surface = document.createElement('canvas');
        surface.width = bitmap.width; surface.height = bitmap.height;
        const ctx2d = surface.getContext('2d', { willReadFrequently: true });
        ctx2d.drawImage(bitmap, 0, 0);
        const pixels = ctx2d.getImageData(0, 0, bitmap.width, bitmap.height);
        if (bitmap.close) bitmap.close();
        return { width: pixels.width, height: pixels.height, data: pixels.data };
      }
      : null;
    return castModule.loadCast({
      fetchFile: (rel) => fetch(rel).then((r) => { if (!r.ok) throw new Error(`${rel}: ${r.status}`); return r.arrayBuffer(); }),
      decodeImage: decode || null,
    });
  })().then((cast) => {
    if (cast) {
      // The pavement gets citizens, not the fantasy shelf: bodies built procedurally on the vendored
      // skeleton (world/people/citizens.js), so every clip the street owns still fits them. Officers
      // go last on the shelf, so their indices stay put while the crowd counts.
      const shelf = buildCitizens(cast.characters[0], { citizens: 10, officers: 2, seed: 9 });
      officerChars = shelf.map((c, i) => (c.police ? i : -1)).filter((i) => i >= 0);
      cast.characters = shelf;
      crowd.setCast(cast); footCast = cast; if (onFoot) foot.attach(cast, renderer);
    }
    return cast;
  })
    .catch((error) => {
      console.error('The street could not load its people: the pavements will be empty.', error);
      crowd.castError = String((error && error.message) || error);
      return null;
    });
  // Street races (game/races.js): a route laid on the same lane graph the traffic drives, timed by
  // gates across the road. `raceKey` is what the nearest one asks for, and it is what the HUD and the
  // touch overlay both read, so a phone and a keyboard see the same opportunity.
  const races = createRaces({
    graph, renderer, traffic, seed: ((seed | 0) ^ 0x9a37) >>> 0, land: LAND_Y,
    notify: (text) => toast(text),
    // The purse is sized on the hour the street is standing at, so the small hours pay more (races.js).
    hour: () => clock.timeOfDay,
  });
  let raceNear = null, raceSaid = '', raceTimer = 0;
  // A crash the player caused: physics knows the contact, and the ledger keeps the score. Reported
  // whatever the dispatch happens to be doing, because a parked car hit at 30 m/s is a charge whether
  // or not a unit was near enough to radio it in.
  if (physics.onImpact) {
    physics.onImpact((e) => {
      if (phase.name !== 'driving' || !e || e.vehicle !== player.vehicle) return;
      const other = e.other ? e.other.userData : null;
      const speed = Math.abs(e.speed || 0);
      if (speed < 2.2) return;
      const cruiser = traffic.isPolice(other);
      // Driving off after a patrol car is the heavier charge; a parked car is not, and neither is a
      // bumper repair at walking pace (which the speed gate above already refused).
      const cause = cruiser ? (speed > 9 ? 'hit and run' : 'patrol car struck') : 'collision';
      if (wanted.add(cause, speed > 16 ? 1.6 : 1)) {
        toast(cruiser ? `You hit a patrol car · ${WantedLedger.label(wanted.stars)}` : 'A crash · the record grew');
      }
    });
  }
  // ---- On foot ------------------------------------------------------------------------------
  // The street is built around a car, so a man on the pavement is a guest in it. game/foot.js owns his
  // body and game/weapons.js his gun; what is kept here is the handover — whose input he answers to, where
  // the camera goes when he leaves the car, and what the police hear when the gun speaks.
  /** The last place he was dry: where a drowning or a death puts him back, one step of shore at a time. */
  // The body's two tanks (game/vitals.js): health, and the breath that runs out under the surface and
  // comes back in a few gasps at it. Drowning is a wound like any other once the lung is empty.
  const vitals = createVitals({
    onHurt: () => camera.addTrauma(0.18),
    onDeath: (cause) => {
      boarding.cancel();
      if (foot.person) foot.person.visible(true);
      foot.place(drySpot[0], drySpot[1], drySpot[2], foot.yaw);
      vitals.revive(0.5);
      camera.addTrauma(0.5);
      toast(cause === 'drown' ? 'The water took you · the shore gave you back'
        : cause === 'fall' ? 'The fall took you · you came to on dry ground' : 'You were killed · you came to');
    },
  });
  // The second-and-a-half at a door (game/boarding.js): an empty car is a handle and a hinge, an
  // occupied one is a man coming out of his seat before the wheel is yours.
  const boarding = createBoarding({ crowd });
  // The car radio: three synthesised stations on the M key, audible only while there is a dashboard.
  const radio = createRadio({ context: () => (audio ? audio.context : null), seed: 11 });
  let boardTag = 'own';
  let boardBoat = -1;
  let boardArc = null;
  // The marina's fleet: hulls tied up wherever the city put water and a door to it (game/boats.js).
  let boats = null;
  let boatDriven = -1;
  let boatNear = null;
  // The citizen shelf's officer indices, and the officers currently walking the player down.
  let officerChars = [];
  const officers = [];
  const foot = createFoot({
    physics, land: LAND_Y, crowd,
    water: (x, z) => (typeof world.field === 'function' && world.field(x, z).kind === 'water' ? SEA_Y : null),
    onLand: (y, hard, impact) => {
      if (!hard) return;
      camera.addTrauma(0.22);
      vitals.fall(impact);
      toast('You landed hard');
    },
  });
  /** The cast, when it arrives. The walker borrows a body off the crowd's own shelf, so it costs no upload. */
  let footCast = null;
  const gun = createWeapon({
    physics, crowd,
    // A discharged firearm is a witness event rather than a vehicle event: the crowd flinches at the
    // muzzle, whoever was struck goes down on the pavement, and the ledger is told what it heard. What the
    // dispatch does about it is the dispatch's business, which is exactly why none of it is decided here.
    onShot: ({ origin, struck }) => {
      const seen = crowd.frighten(origin[0], origin[2], WITNESS_RADIUS, 1);
      if (wanted.add('shots fired', struck.length ? 2.2 : 1.5)) {
        toast(seen > 2 ? `Shots fired \u00b7 ${seen} witnesses \u00b7 ${WantedLedger.label(wanted.stars)}` : 'Shots fired');
      }
    },
    onHit: (info) => {
      if (!info.person) return;
      crowd.strike(info.person, { seconds: 30 });
      if (wanted.add('person shot')) toast('You struck somebody on the street');
    },
  });
  // The purse is the street's other score: what a race paid, what a till took, and what is left to spend.
  // It keeps itself in localStorage, which is also the only reason a saved game has a wallet at all.
  const purse = createPurse({
    storage: typeof self !== 'undefined' && self.localStorage ? self.localStorage : null,
    startingCash: 40,
  });
  purse.load();
  let onFoot = false, footFirst = false, purseCash = purse.cash, purseAge = 99, purseDelta = 0;
  /** Where the last dry pavement was: the sea is a wall you can walk into and be sent back from. */
  const drySpot = [0, LAND_Y, 0];
  const footIntent = { forward: 0, strafe: 0, run: 0, crouch: 0, turn: 0, pitch: 0 };
  const footEye = [0, 0, 0], footAim = [0, 0, 0], footCam = [0, 0, 0];
  const footLook = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  /** The walker as the camera's subject: 'free' wants a pose and a speed, and this is cheaper than a lie. */
  const footSubject = {
    pos: foot.pos, quat: [0, 0, 0, 1], yaw: 0, vel: foot.vel, forwardSpeed: 0, yawRate: 0,
    lookBack: false, roughness: 0, bonnet: null, length: 0.5, height: 1.8, boost: 0,
  };

  /** Out of the car, at the door side, on the ground beside it, looking along the street. */
  function stepOut() {
    const p = player.pos, yaw = player.vehicle ? player.vehicle.yaw : 0;
    // 1.35 m of door, shoulder and mirror along the car's own right, which is the side that faces the
    // pavement in a country that drives on the right. A man put down at the centre of the car is a man
    // standing in the engine, and the world's first ray is the car's own body.
    foot.place(p[0] + Math.cos(yaw) * 1.35, p[1] + 0.05, p[2] - Math.sin(yaw) * 1.35, yaw);
    foot.look.yaw = yaw; foot.look.pitch = -0.05;
    foot.stamina = 1;
    foot.attach(footCast, renderer);
    drySpot[0] = foot.pos[0]; drySpot[1] = foot.pos[1]; drySpot[2] = foot.pos[2];
    onFoot = true;
    if (audio) audio.door(false);         // the door he just came out of, swinging and shutting behind him
    input.looking = true;                 // the picture is his neck now, not the turntable's
    input.lookMode = 'neck';               // drag right looks right; the turntable's signs walk a man in circles
    camera.setMode('free');
    camera.snap();
    gun.equip('pistol');                  // there is a short .38 under the driver's seat, as there was in 1986
    toast('On foot \u00b7 Space to fire, B to draw or stow, R to reload, F back in \u2014 or into any car you can reach');
  }

  /**
   * The car the street is holding out to him, measured every step while he is on foot: traffic's own
   * pooled record, or null when nothing is within reach of his hand. It is the same measurement foot.js
   * makes of his own car, with the same two numbers, so the offer and the taking cannot disagree about
   * how far a door is.
   * @type {object|null}
   */
  let streetCar = null;

  /**
   * Takes a car off the street and drives away in it. The car is taken out of traffic's own lists and
   * rebuilt as the player's, in the same place, facing the same way, wearing the same paint, on the
   * specification of its own kind -- a bus taken off the street is eleven tonnes and geared like a bus,
   * not the car he drove to get there. The car he was driving is not destroyed for it: it is left
   * standing where he left it, as a parked car of its own type that traffic owns from then on, so the
   * street he walked away from still has his car in it and he can take it back the same way.
   *
   * The people nearby see it and run, and the record takes a charge: heavier when somebody was sitting
   * in the car than when it was standing empty, because that is what the two are.
   */
  function takeCar() {
    // Asked again here rather than read from the step's offer: the key is pressed between steps, and a
    // car that has rolled on or been retired in the meantime is a car that is not there to take.
    const ask = traffic.nearestTo(foot.pos[0], foot.pos[2], BOARD_DISTANCE, BOARD_SPEED_LIMIT);
    if (!ask.active) { toast('Nothing within reach to take'); return; }
    const id = ask.id, name = ask.name;
    const taken = traffic.take(id);
    if (!taken) { toast('It drove off'); return; }
    // The new car is built before anything is given up, as it is in the garage: a model that turns out
    // to be undrivable puts the car back on the street and leaves the player standing where he was.
    let next = null;
    try {
      next = createPlayer({ renderer, physics, model: taken.model, spec: trafficSpec(taken.kind, taken.model) });
    } catch (error) {
      traffic.adopt({
        model: taken.model, kind: taken.kind, name: taken.name, x: taken.x, y: taken.y, z: taken.z,
        yaw: taken.yaw, paint: taken.paint, dirt: taken.dirt, registryId: taken.registryId,
      });
      console.warn(`The ${taken.name} could not be driven: ${error && error.message ? error.message : String(error)}`);
      toast('It will not start');
      return;
    }
    const old = player;
    const headlampMode = old.headlampMode;
    if (old.vehicle) {
      traffic.adopt({
        model: old.model, name: drivenCar().name, kind: old.model.kind || 'sedan',
        mass: old.vehicle.spec.mass,
        x: old.vehicle.pos[0], y: old.groundY + 0.03, z: old.vehicle.pos[2], yaw: old.vehicle.yaw,
        paint: old.paints[old.paintIndex] || null, dirt: 0,
        // A car of his own goes back on the street as a car of his own, and keeps its garage id: taking
        // it back is then the same act, and gives him the car the garage sold him.
        registryId: stolenCar ? null : carId,
      });
    }
    skids.lift();
    old.dispose();
    player = next;
    player.headlampMode = headlampMode;
    place[0] = taken.x; place[1] = groundHeight(taken.x, taken.z) + 0.03; place[2] = taken.z;
    if (taken.registryId) { carId = taken.registryId; stolenCar = null; }
    else {
      stolenCar = {
        id: `street:${taken.kind}`, name: taken.name, voice: voiceFor(taken.kind),
        kind: taken.kind, model: taken.model,
      };
    }
    adoptPlayer();
    player.place(place, taken.yaw);
    nitrous.reset();
    stepper.reset();
    waterTime = 0;
    if (autopilot) autopilot.reset();
    if (hornOn && audio) { hornOn = false; audio.horn(false); }
    // The colour it was wearing on the street, and the swatches of the car he is now sitting in.
    const worn = taken.model.paints ? taken.model.paints.indexOf(taken.paint) : -1;
    const applied = player.setPaint(worn < 0 ? 0 : worn);
    ui.setPaints(player.paints, applied, taken.model.paintNames || null);
    ui.setState({ paint: applied });
    refreshSubject();
    streetCar = null;
    // And back to being a driver: the same door going the other way, the neck giving way to the chase rig.
    onFoot = false;
    foot.letGo();
    if (audio) audio.door(true);
    input.looking = false;
    input.lookMode = 'orbit';
    camera.setMode('chase');
    camera.snap();
    gun.stow();
    const seen = wanted.add(taken.hadDriver ? 'car jacked' : 'car stolen');
    if (taken.hadDriver) crowd.frighten(taken.x, taken.z, 30, 1);
    toast(seen ? `${name} taken \u00b7 that was seen` : `${name} taken`);
  }

  /** Back into the car: the body goes where it came from and the camera goes back to the chase rig. */
  function climbIn() {
    // A shop is left by its own door. The car can be parked on the pavement outside it, and a man who
    // reached for the door handle from behind the counter would leave the room without going through it.
    if (inShop) { toast('Out of the shop first'); return; }
    if (!foot.near) { toast('The car is too far off to get into'); return; }
    onFoot = false;
    foot.letGo();
    if (audio) audio.door(true);          // and the heavier one going the other way as he gets back in
    input.looking = false;
    input.lookMode = 'orbit';
    camera.setMode('chase');
    camera.snap();
    gun.stow();
    toast('In');
  }

  /** Untie: the wheel becomes a tiller and the chase camera learns what a wake looks like. */
  function enterBoat() {
    const entry = boats && boats.get(boardBoat);
    if (!entry) { toast('She slipped her mooring'); return; }
    boatDriven = entry.id;
    onFoot = false;
    foot.letGo();
    gun.stow();
    input.looking = false;
    input.lookMode = 'orbit';
    if (audio) audio.door(true);
    toast(`${entry.name} · untied`);
  }

  /** Over the side: into the water if that is what is there — the swim is the gangplank now. */
  function leaveBoat() {
    const entry = boats.get(boatDriven);
    const b = entry.boat;
    const right = [Math.cos(b.yaw), 0, -Math.sin(b.yaw)];
    onFoot = true;
    boatDriven = -1;
    foot.place(b.pos[0] + right[0] * 1.9, SEA_Y - 0.2, b.pos[2] + right[2] * 1.9, b.yaw);
    camera.setMode('chase');
    camera.snap();
    toast('Over the side');
  }

  // ---- shops ----------------------------------------------------------------------------------------------
  // A door on the pavement is a place, not a menu. game/shops.js decides what the door means at this hour and
  // what a till gives up; game/shoproom.js puts a room with its own lamps behind it while a man is standing in
  // there. Neither of them knows the renderer or the street, which is why both are tested in node and the
  // wiring under this comment is not.
  const shopRoom = createShopRoom({ renderer });
  const shops = createShops({
    purse, wanted, crowd, gun,
    plan, field: typeof world.field === 'function' ? world.field : null,
    toast: (text) => toast(text),
    // Both ways through the door go behind a fade, the way the garage does: a room appearing around a man
    // mid-stride is a cut, and a cut is rude without being announced.
    onEnter: (shop) => fadeThrough(() => shopIn(shop)),
    onExit: () => fadeThrough(() => shopOut()),
    // A bell nobody can hear is not an alarm: what the street does about a hold-up is the crowd flinching at
    // the door and the ledger's stars, both of which shops.js has already spent its words on.
    onAlarm: (shop) => { if (crowd) crowd.frighten(shop.x, shop.z, 26, 1); },
  });
  let inShop = false, shopSaid = '', shopNear = null, shopTimer = 0;
  /** Where the man is, in the frame the room measures the counter in. Refilled every time it is asked for. */
  const shopAt = { x: 0, z: 0, hour: 12 };

  /** Where he stands, as the shop sees it: the room's own numbers inside, the street's outside. */
  function shopsAt() {
    if (inShop && shopRoom.set) {
      const p = shopRoom.set.toRoom(foot.pos[0], foot.pos[2]);
      shopAt.x = p[0]; shopAt.z = p[1];
    } else { shopAt.x = foot.pos[0]; shopAt.z = foot.pos[2]; }
    shopAt.hour = clock.timeOfDay;
    return shopAt;
  }

  /** In through the door: the street stops being the frame and the room becomes it. */
  function shopIn(shop) {
    if (!shopRoom.enter(shop, LAND_Y)) { toast('There was nothing behind that door'); return; }
    inShop = true;
    clock.interior = true;                       // the street's hour, weather and thunder wait outside
    const a = shopRoom.set.anchors;
    foot.place(a.entry[0], a.entry[1] + 0.05, a.entry[2], (shop.yaw || 0) + Math.PI);
    foot.look.yaw = (shop.yaw || 0) + Math.PI; foot.look.pitch = -0.02;
    frame.room = shopRoom.room;
    frame.reflectionOrigin[0] = shopRoom.probe[0];
    frame.reflectionOrigin[1] = shopRoom.probe[1];
    frame.reflectionOrigin[2] = shopRoom.probe[2];
    input.looking = true;
    input.lookMode = 'neck';
    camera.setMode('free');
    camera.snap();
    shopSaid = '';
    toast(`${shop.name} \u00b7 the counter is in front of you`);
  }

  /** Out again, with whatever the visit cost or earned. */
  function shopOut() {
    const at = shopRoom.doorstep([0, 0, 0]);
    inShop = false;
    clock.interior = false;
    shopRoom.leave();
    frame.room = null;
    if (at) foot.place(at[0], at[1] + 0.05, at[2], foot.yaw);
    camera.snap();
    shopSaid = ''; shopNear = null;
  }

  /** The trigger, from a man's eye rather than a camera: it is the eye that aims a gun, not the feet. */
  function pullTrigger(dt) {
    if (!gun.armed) return false;
    foot.eye(footEye);
    footLook.x = footEye[0]; footLook.y = footEye[1]; footLook.z = footEye[2];
    footLook.yaw = foot.look.yaw; footLook.pitch = foot.look.pitch;
    const fired = gun.fire(footLook, dt, Math.min(1, foot.moving / 4.4));
    if (fired && foot.person) foot.person.role(gun.weapon.hands === 2 ? 'shoot2' : 'shoot', { once: true, upper: true });
    return !!fired;
  }

  /**
   * Actual police: uniformed citizens, not a siren with no body behind it. While the record wants the
   * player, officers spawn at the edge of the crowd's attention and walk him down — running while he is
   * far, walking once they can see him — and an arrest is a fine, a wiped record and a walk back from
   * the shore. Stars at zero and the officers go back to being pedestrians, because that is what they
   * are between shifts.
   */
  function stepOfficers(dt) {
    const want = wanted.stars > 0 && crowd && crowd.takePerson ? Math.min(3, wanted.stars + 1) : 0;
    while (officers.length < want && officerChars.length) {
      const person = crowd.takePerson({ character: officerChars[officers.length % officerChars.length], wardrobe: 0, id: `officer${officers.length}` });
      if (!person) break;
      const a = (officers.length * 2.39996) % Math.PI * 2;
      const d = 26 + (officers.length % 3) * 6;
      const x = crowdAt.x + Math.sin(a) * d, z = crowdAt.z + Math.cos(a) * d;
      person.place(x, groundHeight(x, z), z, Math.atan2(crowdAt.x - x, crowdAt.z - z));
      person.visible(true);
      officers.push({ person });
    }
    for (let i = officers.length - 1; i >= 0; i--) {
      const o = officers[i];
      if (!want) { crowd.handPersonBack({ person: o.person }); officers.splice(i, 1); continue; }
      const px = o.person.position[0], pz = o.person.position[2];
      const dx = crowdAt.x - px, dz = crowdAt.z - pz;
      const dist = Math.hypot(dx, dz) || 1;
      const speed = dist > 12 ? 4.2 : 2.1;
      const step = Math.min(dist, speed * dt);
      const nx = px + (dx / dist) * step, nz = pz + (dz / dist) * step;
      o.person.place(nx, groundHeight(nx, nz), nz, Math.atan2(dx, dz));
      o.person.role(dist > 12 ? 'run' : 'walk');
      o.person.frame(dt, step);
      if (dist < 1.5 && onFoot && !inShop && !vitals.dead) {
        purse.lose(250, 'fines');
        wanted.clear();
        crowd.handPersonBack({ person: o.person });
        officers.splice(i, 1);
        foot.place(drySpot[0], drySpot[1], drySpot[2], foot.yaw);
        camera.snap();
        toast('Arrested · $250 in fines and the record is wiped');
      }
    }
  }

  /** One object for the HUD, so that the street's news arrives in one place each frame. */
  const hudStatus = { police: null, wanted: null, race: null, mission: null, net: null };
  /** Where the crowd should look for a car to react to: filled from the player every frame. */
  const crowdAt = { x: 0, y: LAND_Y, z: 0, yaw: 0, speed: 0, hour: 12 };
  /** The car, as the crowd and the races want it: [x, z] for the plan's sampler. */
  const playerPos2 = [0, 0];
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
  /** The drivers currently sounding their horn at the player, so each is released when it gives up. */
  const honkSounding = new Set();
  const honkPlace = { position: null, listener: null, forward: null, kind: 'high' };
  let physicsMs = 0, gameMs = 0, streetSeconds = 0;
  // What the frame loop was actually handed, kept for `stats()`: a soak on a software renderer measures the
  // machine as much as the game, and the only way to tell "the walker is slow" from "this page got six frames
  // a minute" is to report the clock each subsystem was given. See `frames`, `pacedDt`, `realMs` below.
  let frameCount = 0, lastPacedDt = 0, lastRealDt = 0, lastSimDt = 0;
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
    if (audio) audio.setCar({ voice: drivenCar().voice, idle: spec.engine.idle, redline: spec.engine.redline });
  }

  /** The car the player is in, whether the garage sold it to him or he took it off the street. */
  function drivenCar() {
    if (stolenCar) return stolenCar;
    const owned = carById(carId);
    return { id: carId, name: owned.name, line: owned.line, voice: owned.voice };
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
    stolenCar = null;   // the garage has handed him a car of his own again; whatever he took is behind him
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
    // The player has been moved: whatever the units were chasing is gone with it, and so is the
    // crowd, which would otherwise walk on from a pavement they were left behind on.
    if (police) police.reset();
    crowd.reset();
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
    // The memory budget is re-derived here rather than remembered, so the settings panel's choice takes
    // effect the moment it is changed (and a device the auto-tuner has since classified is honoured).
    settingsModule.applyMemoryMode(settings, settings.graphics.memoryDetected);
    const g = effectiveGraphics();
    const signature = JSON.stringify(g);
    if (signature !== graphicsSignature) {
      graphicsSignature = signature;
      renderer.setQuality(g);
    }
    if (typeof world.setDensity === 'function') world.setDensity(settings.graphics.density);
    const trafficDensity = options.traffic === null ? settings.graphics.traffic : options.traffic;
    traffic.setDensity(trafficDensity);
    // People come with the street the player asked for, and limbs come with the graphics preset:
    // a person with arms is seven draw calls, and a slow machine needs them elsewhere.
    // People come with the street the player asked for, and how many of them may be animated comes with
    // the graphics preset: a body is a rig solved and a vertex buffer rewritten every frame, and a slow
    // machine needs that work elsewhere. Ultra Low still gets two, because a street with nobody on it is
    // a car park rather than a neighbourhood.
    crowd.setDensity(trafficDensity, PEOPLE_BY_TIER[settings.graphics.preset] ?? 5);
    crowd.setQuality(settings.graphics.preset);
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
    input.lookMode = 'orbit';            // the turntable: the car is what the finger moves
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

  /**
   * Ages the scene change. `dt` is kept for anything that must agree with the simulation; both the fades and
   * the dark hold are wall-paced, because they are a duration a person waits, not a distance the street travels.
   */
  function advanceTransition(dt, realDt = dt) {
    if (transition.stage === 'out') {
      frame.fade = Math.min(1, frame.fade + realDt / FADE_OUT_SECONDS);
      if (frame.fade >= 1 && (!transition.ready || transition.ready())) runTransitionAction();
    } else if (transition.stage === 'hold') {
      frame.fade = 1;
      transition.held += realDt;
      transition.frames++;
      // The garage shows nothing of the street: it need not wait for the tiles it keeps warm.
      const loaded = phase.name === 'garage' || world.isReady(player.pos, NEAR_RADIUS) || transition.held > HOLD_MAX_SECONDS;
      if (loaded && transition.frames > HOLD_MIN_FRAMES && phase.name !== 'boot') transition.stage = 'in';
    } else if (transition.stage === 'in') {
      frame.fade = Math.max(0, frame.fade - realDt / FADE_IN_SECONDS);
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
    // Out of the car and back into it. Nothing about this is a menu: the door is the door, and the only
    // condition is that the car is nearly stopped, because a man stepping out of one at 40 m/s is a
    // casualty rather than a pedestrian.
    if (input.consume('foot') && driving) {
      // Whichever car his hand is on: his own, or one the street is holding out to him. foot.js has
      // measured both by the same rule and said which was nearer, so this is a reading, not a guess.
      if (onFoot) {
        // The door takes a second (game/boarding.js). Which car his hand is on says which sequence:
        // the street's offer carries whether a driver is sitting in it, and his own car is empty by
        // definition -- he just left it.
        if (!boarding.active && foot.near) {
          if (foot.swimming) toast('Not from the water');
          else {
            boardTag = foot.near.tag === 'traffic' && streetCar && streetCar.active ? 'traffic' : 'own';
            const c = boardTag === 'traffic' ? streetCar : null;
            const cx = c ? c.x : player.pos[0], cz = c ? c.z : player.pos[2], cyaw = c ? c.yaw : player.vehicle.yaw;
            const side = foot.near.side;
            boarding.begin(boardTag === 'traffic' && !!c.hadDriver, { x: foot.pos[0], y: foot.pos[1], z: foot.pos[2] },
              awayFromCar(cx, cz, cyaw, side));
          }
        } else if (!boarding.active && boatNear && boatDriven < 0) {
          boardTag = 'boat';
          boardBoat = boatNear.id;
          boarding.begin(false, { x: foot.pos[0], y: foot.pos[1], z: foot.pos[2] },
            awayFromCar(boatNear.x, boatNear.z, boatNear.yaw, 1));
        }
      }
      else if (boatDriven >= 0) {
        const b = boats.get(boatDriven).boat;
        if (b.speed < 2.5) leaveBoat();
        else toast('Slow her down first');
      }
      else if (Math.abs(player.forwardSpeed || 0) < 2.2) stepOut();
      else toast('Stop the car first');
    }
    // The dial: only a car or a boat has a radio, and turning it is a press, not a hold.
    if (input.consume('radio')) {
      if (!onFoot) {
        if (!radio.playing) radio.start();
        const st = radio.next();
        toast(`${st.name} · ${st.tagline}`);
      } else toast('The radio lives in the dashboard');
    }
    // A door: the shopfront's from the pavement, and the same key is the only way out of the room.
    if (input.consume('shop') && driving) {
      if (inShop) shops.leave();
      else if (!onFoot) toast('A shop is walked into, not driven into');
      else {
        const near = shops.nearest(foot.pos[0], foot.pos[2], 7);
        if (near) shops.press(near, shopsAt());
        else toast('No shopfront within reach');
      }
    }
    if (input.consume('weapon') && driving) {
      if (!onFoot) toast('Guns are for the pavement');
      else if (gun.id) { gun.stow(); toast('Stowed'); }
      else { gun.equip('pistol'); toast('The .38 is in your hand'); }
    }
    if (input.consume('camera') && driving) {
      if (onFoot) { footFirst = !footFirst; camera.snap(); }
      else camera.nextMode();
    }
    if (input.consume('headlamps') && driving) toast(HEADLAMP_LABELS[player.cycleHeadlamps()]);
    if (input.consume('recover') && phase.name === 'driving') {
      // The same key means two things, because a man on the pavement has nothing to recover: the car is
      // where he left it. R is the natural key for a magazine, and the street has no other use for it.
      if (onFoot) { if (gun.startReload() && foot.person) foot.person.role(gun.weapon.hands === 2 ? 'reload2' : 'reload', { once: true, upper: true }); }
      else { recoverToRoad(); toast('Back on the road'); }
    }
    if (input.consume('time') && driving) {
      const name = clock.nextTimePreset();
      toast(TIME_LABELS[name] || name);
      ui.setState({ time: name });
    }
    if (input.consume('race') && driving) {
      if (races.state.active) { races.abort('Race called off'); }
      else if (raceNear) startRace(raceNear.tier.id);
      else toast('No street race from here');
    }
    if (input.consume('weather') && driving) {
      const name = clock.nextWeather();
      toast(WEATHER_LABELS[name] || name);
      ui.setState({ weather: name });
    }
  }

  /**
   * What the street itself witnessed, as distinct from what a unit reported (which is escalated by
   * the dispatch above): too fast on this road, and over a red. Both are cheap to judge from what the
   * game has already computed — a lane, a station, a signal clock — and both are the kind of thing a
   * driver does while nobody is watching, which is exactly when a record should still grow.
   */
  function chargeFromStreet(dt) {
    if (!graph || phase.name !== 'driving') { spedFor = 0; return; }
    const speed = Math.abs(player.forwardSpeed || 0);
    const time = traffic.sim ? traffic.sim.time : 0;
    const hit = graph.nearest(player.pos[0], player.pos[2], 14, (lane) => !lane.junction && lane.length > 20);
    if (!hit) { spedFor = 0; return; }
    const limit = comfortSpeed(hit.lane, hit.s);
    // A tolerance, and a second of it: a momentary read of 3 m/s over on a cambered bridge is not
    // speeding, and neither is a short burst past the sign on the way into a gap in traffic.
    if (speed > limit + 3.2) spedFor += dt; else spedFor = Math.max(0, spedFor - dt * 2);
    if (spedFor > 1.6) {
      spedFor = 0;
      if (wanted.add('speeding')) toast('Speeding · the street noticed');
    }
    // The red: judged at the mouth of the junction, on the lane the player is actually over, from the
    // same answer the lamps are drawn from. Once per approach, because a red run is one offence.
    const control = hit.lane.control;
    const junction = control && control.junctionRef;
    if (!junction || !junction.groups) return;
    if (redLaneId === hit.lane.id && hit.s < redAt) return;
    const toGo = hit.lane.length - hit.s;
    if (toGo > 26 || speed <= 3) return;
    const green = signalState(junction, control.group || 0, time) === SIGNAL.GREEN;
    redLaneId = hit.lane.id; redAt = hit.s;
    if (green) return;
    if (wanted.add('red light')) toast('Over a red · that will be written down');
  }

  /**
   * Start a meeting: the course is laid from where the car is, and the car is put on the line. A race
   * begun 300 m down the road from the start gate is a race already lost, so the placement is not a
   * courtesy — and it is what makes a race startable from a kerb, a car park or a rooftop ramp.
   */
  function startRace(tierId) {
    const at = player.pos;
    if (!races.start(tierId, at[0], at[2])) return false;
    const place = races.place();
    if (place && Math.hypot(place[0] - at[0], place[1] - at[2]) > 24) {
      player.place([place[0], LAND_Y, place[1]], place[2]);
      camera.snap();
      crowd.reset();
    }
    races.resync();
    return true;
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
    // Where the car is, for the recorded engine: on foot, a car left idling fades and pans as the
    // player walks away from it instead of following his head at full level.
    car.position = player.pos;
    car.cabin = camera.mode === 'bonnet' ? 1 : 0;
    env.rain = weather.rain; env.wind = Math.hypot(weather.windX, weather.windZ); env.night = clock.env.night;
    env.timeOfDay = clock.timeOfDay; env.district = hud.district; env.neon = clock.env.switches.neon;
    audio.update(simDt, audioState);
    // The wail of the nearest unit, silent (and unbuilt) while nobody is after the player.
    if (police && audio.siren) audio.siren(phase.name === 'driving' ? police.siren.level : 0, police.siren.position);
    const horn = phase.name === 'driving' && input.state.horn > 0;
    if (horn !== hornOn) { hornOn = horn; audio.horn(horn); }
    honkTraffic();
  }

  /**
   * The cars the player has walked into the path of, sounding their horns at him. Each keeps its own
   * horn until it gives up, and one that is not in this step's list is released: the audio caps how
   * many sound at once, so a car that stops being blocked has to hand its voice back rather than leave
   * it holding a place somebody nearer needs.
   */
  function honkTraffic() {
    if (!audio || typeof audio.trafficHorn !== 'function') return;
    const list = traffic.honking;
    for (const id of honkSounding) {
      let still = false;
      for (let i = 0; i < list.length; i++) if (list[i].id === id) { still = true; break; }
      if (!still) { audio.trafficHorn(id, false); honkSounding.delete(id); }
    }
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      honkPlace.position = h.position;
      honkPlace.listener = camera.position;
      honkPlace.forward = camera.forward;
      honkPlace.kind = h.low ? 'low' : 'high';
      if (audio.trafficHorn(h.id, true, honkPlace)) honkSounding.add(h.id);
    }
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
    /** The street's own population, and what the agency has written down against you. */
    get crowd() { return crowd.snapshot(); },
    /** Bodies and triangles the crowd put in front of the camera on the last drawn frame. */
    get crowdRender() { return crowd.renderStats(); },
    /** The vendored people: whether they arrived, and what they weigh. `pending` means still fetching. */
    get people() { return { state: crowd.castReady ? 'ready' : (crowd.castError ? 'failed' : 'pending'), error: crowd.castError || null }; },
    get wanted() { return wanted.snapshot(); },
    /** The crowd, for a script that wants somebody on a particular corner (see game/missions.js). */
    hailAt(x, z) { return crowd.makeHailer(x, z) ? crowd.snapshot() : null; },
    /** Street races: the meetings on offer here, the board, and the course. */
    races,
    raceTiers: RACE_TIERS,
    /** Start a meeting by hand (the touch overlay, a script): the same path the V key takes. */
    startRace(tierId) { return startRace(tierId); },
    /** What the street is offering where the car is standing (null = nothing to take). */
    raceOffer() { return raceNear; },
    /** The crowd, for a mission that wants a fare on a particular corner. */
    /** The record, cleared: what a completed traffic stop does to it. */
    clearWanted() { wanted.clear(); return wanted.snapshot(); },
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
      // A car taken off the street is not his to remember a colour against: the garage's car would come
      // back wearing whatever the stolen one was painted, and the street's car is not in the swatches.
      if (!stolenCar) rememberPaint(settings, carId, applied);
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

    /**
     * A one-shot action from script, exactly as a key would send it: 'foot' to step out of the car,
     * 'weapon' to draw, 'recover' to reload afoot. For the automation harness, and for nothing else.
     */
    press(action) {
      input.press(action);
      return true;
    },

    /**
     * The nearest door, in the terms a script needs to reach it: the shopfront's world position, what the
     * counter would offer there right now, and whether a room is up. `x, z` override where he stands.
     */
    shopInfo(x, z) {
      const at = x !== undefined && z !== undefined ? [x, 0, z] : (onFoot ? foot.pos : player.pos);
      const shop = shops.nearest(at[0], at[2], 60);
      const offer = shop ? shops.offer(shop, { x: at[0], z: at[2], hour: clock.timeOfDay }) : null;
      const s = shops.snapshot();
      return {
        count: shops.count, name: shop ? shop.name : null, kind: shop ? shop.kind : null,
        x: shop ? shop.x : null, z: shop ? shop.z : null, hours: shop ? shop.hours : null,
        till: shop ? shop.till : 0, action: offer ? offer.action : null, label: offer ? offer.label : null,
        hour: clock.timeOfDay, onFoot, inside: s.inside, holding: s.holding, progress: s.progress,
        room: shopRoom.ready, lights: shopRoom.room ? 1 : 0,
      };
    },

    /** Puts the walker's feet somewhere else: a script checking a doorway should not have to drive to it. */
    walkTo(x, z) {
      if (!onFoot || !Number.isFinite(x) || !Number.isFinite(z)) return false;
      foot.place(x, LAND_Y + 0.05, z, foot.yaw);
      camera.snap();
      return true;
    },

    /**
     * The closest shopfront on the island, preferring one that is open: for a script (or a person with a map
     * and no memory) that wants to know where the nearest door is from wherever they are standing, rather
     * than the offer report, which only sees 60 metres and is meant for the HUD.
     */
    nearestShop() {
      const hour = clock.timeOfDay;
      let open = null, openD = Infinity, any = null, anyD = Infinity;
      for (const s of shops.list) {
        const d = Math.hypot(s.x - player.pos[0], s.z - player.pos[2]);
        if (d < anyD) { anyD = d; any = s; }
        if (d < openD && shops.offer(s, { x: s.x, z: s.z, hour }).action === 'enter') { openD = d; open = s; }
      }
      const s = open || any;
      if (!s) return null;
      return {
        name: s.name, kind: s.kind, x: s.x, z: s.z, hours: s.hours, till: s.till,
        metres: Math.round((open ? openD : anyD)), open: !!open, shops: shops.count,
      };
    },

    /** Whether the player is on the pavement rather than in the car, and what each of them is doing. */
    get onFoot() { return onFoot; },
    footState() { return foot.snapshot(); },
    gunState() { return gun.snapshot(); },
    purseState() { return purse.snapshot(); },

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
        streetSeconds: Math.round(streetSeconds * 100) / 100,
        // Frames the game was asked to draw, and the three clocks that came out of them: the pacer's
        // (suspension- and cap-clamped), the wall's, and what the street was granted. `frames` growing while
        // `simDt` stays at the pacer's floor is a starving machine; `frames` frozen is a page nobody pumped.
        frames: frameCount, pacedDt: Math.round(lastPacedDt * 10000) / 10000,
        realDt: Math.round(lastRealDt * 10000) / 10000, simDt: Math.round(lastSimDt * 10000) / 10000,
        onFoot, cash: Math.round(purse.cash * 100) / 100,
        foot: onFoot ? foot.snapshot() : null, gun: gun.snapshot(),
        // A script that presses a key wants to know whether the game was listening: a fade swallows a
        // press, and a soak harness that cannot see the difference blames the walker for being slow.
        transition: transition.stage, frameFade: Math.round(frame.fade * 100) / 100,
        transitionHeld: Math.round(transition.held * 100) / 100, transitionBusy: !!transition.action,
        inShop, shop: inShop ? shops.snapshot() : (shopNear ? { inside: shopNear.name, holding: false } : null),
        lowMemory: settings.graphics.lowMemory === true, atlas: null,
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
      frameCount++;
      handlePresses();
      // The pacer hands a slow machine a fraction of a second for a second and a half of real time (loop.js,
      // and every software-renderer soak in this repo's history), so anything measured in *seconds a person
      // waits* has to be counted in wall seconds: how long the screen stays dark, and how long the fade takes
      // to cross it. Counted in `dt` instead, a half-second fade is a minute of black on a 5 fps device, which
      // is the opposite of what a fade is for -- and it is exactly the machine this fork is trying to keep.
      const realDt = Math.max(dt, (frameMs > 0 ? frameMs : 0) / 1000);
      lastPacedDt = dt; lastRealDt = realDt;
      advanceDeparture(phase.name === 'garage' ? dt : 0);
      advanceTransition(dt, realDt);
      const simDt = phase.running ? dt : 0;
      lastSimDt = simDt;
      const inGarage = phase.name === 'garage';

      // Input.
      input.update(simDt, player.forwardSpeed);
      let controls = TITLE_INPUT;
      if (phase.name === 'driving') {
        controls = input.state;
        const hands = controls.throttle > 0 || controls.brake > 0 || controls.steer !== 0 || controls.handbrake > 0;
        // The autopilot drives a car, and a man on the pavement is not being driven: taken over here, his
        // own feet would answer to a route the machine is flying, which is how a walker ends up in the sea.
        if (autopilotOn && !onFoot && !hands) {
          controls = autopilot.update(simDt, player.vehicle, traffic.sim.time, autoInput);
          if (autopilot.stuck) recoverToRoad();
        }
      }
      // The script's or the player's finger on the nitrous also counts while the autopilot steers.
      const boost = phase.name === 'driving' && !onFoot ? nitrous.request(input.state.boost, controls.throttle, player.vehicle) : 0;
      if (onFoot) {
        // The man's own controls, and the car left parked behind him. The wheel is the strafe, the drag on
        // the picture is the neck, and Shift is the run: nothing here is remapped, because a pedestrian who
        // had to learn new keys would be a mode rather than the same street with a man in it.
        player.drive(PARKED_INPUT, 0);
        footIntent.forward = controls.throttle - controls.brake;
        footIntent.strafe = -controls.steer;
        footIntent.run = controls.boost;
        footIntent.crouch = controls.lookBack;
        footIntent.turn = simDt > 0 ? input.look.yaw / simDt : 0;
        footIntent.pitch = simDt > 0 ? input.look.pitch / simDt : 0;
        // A door in the hand holds the legs: the sequence owns the body until it is through it.
        if (boarding.active) {
          footIntent.forward = 0; footIntent.strafe = 0; footIntent.run = 0;
          footIntent.turn = 0; footIntent.pitch = 0;
        }
        // A car that is not his, if the street is holding one within reach. A man in a shop is not on
        // the street and has nothing to take; anywhere else the nearest car that is nearly stopped is
        // offered, and foot.js picks between it and his own by distance alone.
        streetCar = !inShop ? traffic.nearestTo(foot.pos[0], foot.pos[2], BOARD_DISTANCE, BOARD_SPEED_LIMIT) : null;
        boatNear = null;
        // A car that drove off mid-door takes the sequence with it, and the body back with it.
        if (boarding.active && boardTag === 'traffic' && (!streetCar || !streetCar.active)) {
          boarding.cancel();
          if (foot.person) foot.person.visible(true);
          foot.play(null);
          toast('It drove off');
        }
        foot.step(simDt, footIntent, player.vehicle ? {
          x: player.pos[0], y: player.pos[1], z: player.pos[2],
          yaw: player.vehicle.yaw, speed: player.vehicle.speed,
        } : null, streetCar && streetCar.active ? streetCar : null);
        // A gunwale within reach, when no car door is: the boat is offered on the same principle as
        // the car — close enough to touch, still enough to board.
        if (!boats && world.plan) {
          boats = createBoats({
            renderer, plan: world.plan, water: () => SEA_Y,
            field: typeof world.field === 'function' ? (x, z) => world.field(x, z) : null,
          });
        }
        if (boats && !foot.near && !inShop) boatNear = boats.nearestTo(foot.pos[0], foot.pos[2], 3.4);
        // The lung, and the slow clock: breath empties under the surface and the wound closes only
        // while the street leaves him alone (game/vitals.js).
        vitals.breath(simDt, foot.submerged);
        vitals.tick(simDt, wanted.stars > 0);
        // The door sequence: events at the seams, and the car at the end of them.
        for (const ev of boarding.step(simDt)) {
          if (ev === 'reach') foot.play('interact');
          else if (ev === 'pull' && audio) audio.door(true);
          else if (ev === 'hide') {
            // The body commits to the seat: the sit begins at the door and the arc below carries it
            // in, so the frame it disappears is a frame it is already inside the car.
            foot.play('sitdown');
            const seams = boarding.occupied ? SEAMS.occupied : SEAMS.empty;
            const c = boardTag === 'traffic' && streetCar && streetCar.active ? streetCar
              : boardTag === 'boat' && boats && boats.get(boardBoat) ? boats.get(boardBoat).boat : null;
            const cyaw = c ? c.yaw : (player.vehicle ? player.vehicle.yaw : 0);
            const cx = c ? c.pos[0] : player.pos[0], cz = c ? c.pos[2] : player.pos[2];
            const rgt = [Math.cos(cyaw), -Math.sin(cyaw)];
            const fwd = [Math.sin(cyaw), Math.cos(cyaw)];
            const seat = boardTag === 'boat'
              ? [cx - fwd[0] * 0.6, cz - fwd[2] * 0.6]
              : [cx - rgt[0] * 0.42 + fwd[0] * 0.08, cz - rgt[1] * 0.42 + fwd[2] * 0.08];
            const dx = foot.pos[0] - cx, dz = foot.pos[2] - cz;
            const dl = Math.hypot(dx, dz) || 1;
            boardArc = {
              x0: foot.pos[0], z0: foot.pos[2], yaw0: foot.yaw,
              seat, yaw1: cyaw, t0: boarding.t, t1: seams.seated,
              outx: dx / dl, outz: dz / dl,
            };
            if (audio) audio.door(true);
          } else if (ev === 'seated') {
            if (foot.person) foot.person.visible(false);
            if (audio) audio.door(false);
            boardArc = null;
          } else if (ev === 'done') {
            if (boardTag === 'traffic') takeCar();
            else if (boardTag === 'boat') enterBoat();
            else climbIn();
          }
        }
        // The arc into the seat: a quadratic ease from the door to the seat with a bulge outwards,
        // because a body getting into a car goes around the door, not through it.
        if (boarding.active && boardArc && foot.person) {
          const u = Math.max(0, Math.min(1, (boarding.t - boardArc.t0) / Math.max(1e-4, boardArc.t1 - boardArc.t0)));
          const e = u * u * (3 - 2 * u);
          const bulge = Math.sin(Math.PI * u) * 0.22;
          const px = lerp(boardArc.x0, boardArc.seat[0], e) + boardArc.outx * bulge;
          const pz = lerp(boardArc.z0, boardArc.seat[1], e) + boardArc.outz * bulge;
          const yaw = boardArc.yaw0 + angleDelta(boardArc.yaw0, boardArc.yaw1) * e;
          foot.pos[0] = px; foot.pos[2] = pz; foot.yaw = yaw;
          foot.person.place(px, foot.pos[1], pz, yaw);
        }
        // The stance: a drawn gun is held, not carried, and the hold rides over the legs (upper body
        // only) so a man can walk his shot up the street. Two-handed guns get their own clips.
        if (gun.armed && foot.person && !foot.swimming && !boarding.active) {
          foot.person.role(gun.weapon.hands === 2 ? 'aim2' : 'aim', { upper: true });
        }
        // The trigger is held, not tapped: the gun's own cooldown is what sets the rate, so a held Space
        // empties a machine pistol and taps a pistol one at a time with the same code.
        if (controls.handbrake > 0.5) pullTrigger(simDt); else gun.advance(simDt);
        if (inShop) {
          // The walls are drawn, and here they are the rule: a room with no colliders of its own would let a
          // man walk out of a shop and into the sea without ever opening a door.
          if (shopRoom.confine(foot.pos)) foot.place(foot.pos[0], foot.pos[1], foot.pos[2], foot.yaw);
          const said = shops.step(simDt, gun.armed && controls.handbrake > 0.5);
          if (said) toast(said);
          const offer = shops.offer(shops.inside, shopsAt());
          shopSaid = offer ? `${offer.label} \u00b7 E` : '';
        } else if (foot.grounded && foot.pos[1] > LAND_Y - 0.4 && !foot.swimming) {
          drySpot[0] = foot.pos[0]; drySpot[1] = foot.pos[1]; drySpot[2] = foot.pos[2];
        }
      } else {
        player.drive(controls, boost);
      }
      if (boats) {
        boats.step(simDt, boatDriven, boatDriven >= 0 ? {
          throttle: controls.throttle - controls.brake, steer: -controls.steer, brake: 0,
        } : null);
      }

      // Simulation.
      const steps = simDt > 0 ? stepper.advance(simDt) : 0;
      // How much time the streets really got this frame. Below 12 frames per second the game slows
      // down rather than spiral (loop.js), so this is less than `simDt`: anything that measures a
      // rate against what the cars are doing — the dispatch, an officer's walk — belongs to it.
      const stepTime = steps * FIXED_DT;
      // How much simulated time the street has been granted since the game started. Everything that
      // measures a rate — a race's clock, a pedestrian's think time, the stars cooling off — runs on
      // this and not on the wall, so a soak that is starving the frame loop shows up here first. It is
      // reported in stats() for exactly that reason: "the countdown never moved" means something quite
      // different when the street got 4 seconds of clock in a minute of wall time.
      streetSeconds += stepTime;
      if (simDt > 0) {
        const p0 = now();
        if (steps > 0 && !inGarage) {
          traffic.setFocus(player, camera);
          // A man standing in a lane is an obstacle the drivers brake for, which is what makes them
          // stop instead of drifting past him; a man in a shop is not in the road at all. His own car
          // stays an obstacle either way, and that is what setFocus has just described.
          traffic.setWalker(onFoot && !inShop
            ? {
              active: true, x: foot.pos[0], z: foot.pos[2], yaw: foot.yaw,
              vx: foot.vel[0], vz: foot.vel[2], crouching: foot.gait < 0,
            }
            : { active: false });
          traffic.step(stepTime);
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
      } else if (onFoot) {
        // The room the man is standing in has no hour of its own, so the street keeps its weather; what the
        // camera does is his: over the shoulder, or the eye itself when he wants it close.
        player.update(simDt, env.sunElevation, weather.rain, cameraDistance, weather.fog);
        footSubject.yaw = foot.yaw; footSubject.forwardSpeed = foot.moving;
        foot.eye(footEye);
        if (footFirst) {
          foot.aim(footAim);
          camera.place(footEye, [footEye[0] + footAim[0] * 10, footEye[1] + footAim[1] * 10, footEye[2] + footAim[2] * 10], 1.15);
        } else {
          camera.place(foot.camera(footCam), footEye, 1.05);
        }
      } else {
        player.update(simDt, env.sunElevation, weather.rain, cameraDistance, weather.fog);
      }
      refreshSubject();
      camera.update(simDt, onFoot ? footSubject : subject);
      if (boatDriven >= 0 && boats) {
        // Astern and above the wake: the chase arm's car assumptions are no good to a hull, so the
        // boat gets the free camera held by hand, one springless frame at a time.
        const b = boats.get(boatDriven).boat;
        const back = 7.5 + Math.min(4, b.speed * 0.22);
        camera.place(
          [b.pos[0] - Math.sin(b.yaw) * back, b.pos[1] + 2.6 + b.speed * 0.05, b.pos[2] - Math.cos(b.yaw) * back],
          [b.pos[0] + Math.sin(b.yaw) * 2, b.pos[1] + 0.7, b.pos[2] + Math.cos(b.yaw) * 2],
          1.05,
        );
      }
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
        if (inShop) {
          // The room's lamps, after the man's own: the same budget the garage's room is lit on, because it is
          // the same kind of frame — a closed room the street is not asked to draw.
          shopRoom.writeLights(lamps, renderer.interiorLightBudget);
        }
        if (police) police.enabled = phase.name === 'driving';
        crowd.enabled = phase.name === 'driving';
        // A race's clock is the one thing that must not run while the game is paused, and a car put back
        // on the road by R has been carried, not driven: both are told here.
        if (races.state.active && phase.name !== 'driving') races.resync();
        traffic.setFocus(player, camera);
        traffic.update(simDt, env.sunElevation, weather.rain, stepTime);
        // What the street is doing: the crowd walks, and the stars follow what the police saw.
        if (onFoot) {
          // A man on the pavement is what the crowd has to react to now: the threat a standing car poses
          // is nothing, and the one a gun poses is handled by the shot itself, not by this.
          crowdAt.x = foot.pos[0]; crowdAt.y = foot.pos[1]; crowdAt.z = foot.pos[2];
          crowdAt.yaw = foot.yaw; crowdAt.speed = foot.moving;
        } else {
          crowdAt.x = player.pos[0]; crowdAt.y = player.pos[1]; crowdAt.z = player.pos[2];
        }
        playerPos2[0] = player.pos[0]; playerPos2[1] = player.pos[2];
        crowdAt.yaw = player.vehicle ? player.vehicle.yaw : crowdAt.yaw;
        crowdAt.speed = Math.abs(player.forwardSpeed || 0);
        // The hour is part of what the street is: the pavement empties after midnight and the kerbs fill
        // with people wanting a cab, which is the one piece of night that the crowd can show on its own.
        crowdAt.hour = clock.timeOfDay;
        crowd.step(stepTime, crowdAt, phase.name === 'driving');
        if (police) {
          const heat = police.status.heat | 0;
          // The dispatch's escalation is the witness: it is what saw the offence, and its heat is
          // how seriously it took it. The stars are that, kept after the cars have gone home.
          // Which charge the escalation answers to, in the ledger's own weights: a unit starting to
          // chase is a struck car, a pursuit with officers out is the driver running for it.
          if (heat > lastHeat) wanted.add(heat >= 3 ? 'hit and run' : heat === 2 ? 'patrol car struck' : 'speeding');
          lastHeat = heat;
        }
        chargeFromStreet(stepTime);
        wanted.step(stepTime, police ? police.status : null);
        if (wanted.stars !== shownStars) {
          const up = wanted.stars > shownStars;
          shownStars = wanted.stars;
          if (wanted.stars > 0) {
            toast(up ? `${WantedLedger.label(wanted.stars)} \u00b7 ${wanted.stars} star${wanted.stars > 1 ? 's' : ''}`
                     : `${wanted.stars} star${wanted.stars > 1 ? 's' : ''} \u00b7 you are cooling off`);
          }
        }
        hudStatus.police = police ? police.status : null;
        hudStatus.wanted = wanted.snapshot();
        // The purse is aged here rather than in money.js, because only the frame loop knows how long ago
        // six seconds was; the HUD keeps the change in view for a moment and then says nothing but the sum.
        if (purse.cash !== purseCash) { purseCash = purse.cash; purseAge = 0; purseDelta = purse.lastDelta; }
        purseAge += simDt;
        hudStatus.purse = { cash: purse.cash, lastDelta: purseAge < 6 ? purseDelta : 0, lastAt: purseAge, best: purse.best };
        hudStatus.radio = radio.playing ? { station: radio.station.name, title: radio.title } : null;
        hudStatus.foot = onFoot ? {
          onFoot: true, gun: gun.weapon ? gun.weapon.name : null, magazine: gun.inMagazine, reserve: gun.reserve,
          state: gun.state, stamina: foot.stamina, out: foot.out, boarding: !!foot.near || boarding.active,
          health: vitals.health, oxygen: vitals.oxygen, swimming: foot.swimming, submerged: foot.submerged,
          dead: vitals.dead,
          boat: boatDriven >= 0 ? (boats.get(boatDriven).name) : (boatNear ? boatNear.name : null),
          door: inShop ? (shopSaid || 'E for the door')
            : boarding.active ? (boarding.phase === 'pull' ? 'Getting him out' : 'Getting in')
              : boatNear && !foot.near ? 'F for the boat'
                : gun.weapon && gun.needReload ? 'R for a magazine'
                : !onFoot && shopNear ? 'E for the shop' : null,
        } : (foot.near ? { onFoot: false, boarding: false, door: 'F to get out' } : null);
        if (!onFoot && !radio.playing) radio.start();
        if (onFoot && radio.playing) radio.stop();
        if (radio.playing) radio.tick(0.42);
        stepOfficers(simDt);
        races.step(stepTime, playerPos2, phase.name === 'driving');
        hudStatus.race = races.snapshot();
        // A race pays out of the money that was on the street before the flag, and the pocket is the only
        // place it can land: the ledger says what it came from, and the toast says how much. `paid` is on
        // the snapshot, so a finish that scored nothing is still closed off here rather than asked again.
        if (hudStatus.race.finished && !hudStatus.race.paid) {
          const won = races.collect();
          toast(won > 0 ? `The purse is yours · ${formatCash(won)}` : 'No purse · the field took it');
        }
        // What the street is offering here, once a second: a race is taken from a kerb, not from a menu.
        raceTimer -= stepTime;
        if (raceTimer <= 0 && phase.name === 'driving') {
          raceTimer = 1.1;
          const near = races.state.active ? null : (races.offer(playerPos2[0], playerPos2[1]) || [])[0] || null;
          raceNear = near;
          const line = near
            ? `${near.tier.name} · ${Math.round(near.length / 100) / 10} km · ${formatCash(near.purse || 0)} · press V`
            : '';
          if (line !== raceSaid) {
            raceSaid = line;
            if (line) toast(line);
            ui.touchOffer(near);
          }
        }
        // The tills, once a second, and with them what a door is worth right now: a drawer fills through a
        // trading day and a shut shop is a locked one, and neither of them is a thing to recompute per frame.
        shopTimer -= stepTime;
        if (shopTimer <= 0 && phase.name === 'driving') {
          shopTimer = 1.1;
          shops.trade(clock.timeOfDay);
          shopNear = !inShop && onFoot ? shops.nearest(foot.pos[0], foot.pos[2], 7) : null;
        }
        traffic.writeLamps(lamps, camera.position, frame.time);
        if (graph) writeSignalLamps(lamps, graph.junctions, traffic.sim.time, camera.position);
        nitrous.update(simDt, controls.throttle, player, lamps);
        effects.update(simDt, player, weather, traffic.audible);
        if (simDt > 0) skids.update(player.vehicle, tyreWidths, weather.wetness);
      }

      // The world follows the camera on the street, and in the garage the car waiting up there.
      world.update(inGarage ? player.pos : camera.position, dt);
      if (phase.name === 'driving') hud.update(simDt, player, clock.timeOfDay, controls.handbrake, nitrous, hudStatus);
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
      shopRoom.leave();
      effects.dispose();
      skids.clear();
      traffic.dispose();
      player.dispose();
      showroom.dispose();
    },
  };
  return game;
}
