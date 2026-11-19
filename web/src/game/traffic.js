// Traffic around the player: which vehicles exist, where they are drawn and what the physics
// world knows about them. How they drive is in drivers.js; this file gives each driver a body.
//
// Moving vehicles are created on road lanes in a ring around the player, out of the camera's
// view, and removed again once they are far behind or far away. Each one is a traffic box in
// the physics world that follows its driver. When the player (or another wreck) really hits a
// box, physics takes it over; the driver is taken off the road, the vehicle slides to rest
// with its hazard lights on, and the drivers behind see it as an obstacle. A vehicle that was
// only nudged and still stands along a lane sets off again.
//
// Parked vehicles come from tile data and are the same kind of box without a driver.

import { clamp, smoothstep, makeRng, hash01, angleDelta, damp, m4transformPoint, m4fromYawPos } from '../core/math.js';
import { CHANNEL } from '../core/ids.js';
import { trafficSpec } from '../physics/index.js';
import { TrafficSim, OBSTACLE } from './drivers.js';
import { PatrolDispatch } from './police.js';
import { buildFootOfficer } from '../vehicles/traffic/officers.js';
import { comfortSpeed } from './lanes.js';
import { createVehicleKit, VehicleView } from './vehicleView.js';
import { writeVehicleLamps, GLOW_ROUND, HEADLAMP_SUN_ELEVATION, HEADLAMP_RAIN } from './lamps.js';

/** Moving vehicles and share of the parked vehicles kept, by the traffic setting 0..3. */
export const MOVING_BY_DENSITY = Object.freeze([0, 12, 24, 40]);
export const PARKED_BY_DENSITY = Object.freeze([0.3, 0.5, 0.75, 1]);

// Spawning and retiring, metres from the player.
const SPAWN_NEAR = 170, SPAWN_FAR = 330;
const SPAWN_VISIBLE_BEYOND = 250; // in view, a vehicle may only appear further away than this
const SPAWN_SNAP = 45; // a ring point is moved to the nearest lane within this distance
const SPAWN_ATTEMPTS = 3; // per simulation step
const POPULATE_NEAR = 38, POPULATE_FAR = 300;
const RETIRE_FAR = 390;
/** Metres from a start line within which an ordinary car is close enough to be racing. */
const RECRUIT_RADIUS = 260;
const RETIRE_BEHIND = 190;
const RETIRE_STUCK_SECONDS = 100; // a vehicle that has stood this long is removed when unseen
const VIEW_COS = 0.5; // cosine of the half-angle that counts as "in view" (a little over the widest field of view)

// Wrecks.
const REST_SPEED = 0.3; // m/s
const REJOIN_AFTER = 2.5; // s at rest before a nudged vehicle tries to set off again
const REJOIN_LATERAL = 2.6; // m from a lane centre
const REJOIN_ANGLE = 0.45; // rad off the lane direction
const REJOIN_HALF_LIFE = 0.45; // s: the vehicle eases from where it stood onto the lane
const WRECK_SECONDS = 25; // an unseen wreck is cleared away after this long at rest

// Drawing.
// Lamps. One beam lights ninety metres of road, so wherever the way a vehicle's lamps are drawn
// changes, it changes as a fade, over distance or over time: whatever is switched shows as the
// street flashing.
// No lamps beyond LAMP_RANGE. It lies inside RETIRE_FAR by more than a camera stands from the car,
// so a vehicle's lamps have gone out before the vehicle is removed.
const LAMP_RANGE = 370;
const LAMP_FADE_FROM = 0.75 * LAMP_RANGE; // the glows dim from here to nothing at LAMP_RANGE
const LAMP_ARRIVE_SECONDS = 1; // a vehicle put on the road in view brings its lamps up over this long
const BEAM_RANGE = 130; // beyond this headlamps are glows only
// A beam dims from BEAM_FADE_FROM to nothing at BEAM_RANGE. The band is as long as it is because of
// oncoming traffic: closing at 45 m/s a vehicle crosses it in a second and a half, which keeps the
// change from one frame to the next to a few hundredths of the beam.
const BEAM_FADE_FROM = 0.5 * BEAM_RANGE;
// The close-up set of lamps (lamps.js: a beam per headlamp, tail wash, plate lamps) goes to the
// nearest vehicles, over a band of distance in which both sets are drawn, each with its share.
// A vehicle that has one of the places counts as a little nearer than it is, so that vehicles at
// about the same distance do not keep trading places; one that loses its place fades out of it.
const NEAR_MAX = 3;
const NEAR_FULL_RANGE = 36, NEAR_RANGE = 46;
const NEAR_KEEP = 0.85;
const NEAR_FADE_SECONDS = 0.5;
const HEADLAMP_WARM_SECONDS = 0.3; // a filament coming up to brightness, or dying away
const OCCLUDER_RANGE = 36; // contact shadows under vehicles this close
const ROOF_SIGN_GLOW = 9, ROOF_SIGN_SIZE = 0.55;
const AUDIBLE = 6; // vehicles reported to the audio engine

// A man in the road is an obstacle like any other and the drivers brake for him the same way, but he
// is also the only obstacle it is worth making a noise about: a wreck is where it is, the player's own
// car is his own business, and a man standing in a lane at eleven at night is either lost or trying to
// be run over. So the horn is for him and for nothing else.
const HONK_DECEL = -2.2;      // m/s^2: braking this hard for a person means he is actually in the way
const HONK_SECONDS = 0.9;     // how long one blast lasts, which is a real horn held down
const HONK_COOLDOWN = 2.4;    // and how long before that driver will do it again while still blocked
const HONK_MAX = 4;           // drivers sounding at once; a whole junction is noise, not information
const HONK_RANGE = 120;       // m: nobody honks at a man he cannot see
/** Types whose horn is the low one, because a bus does not beep. */
const HORN_LOW_TYPES = new Set(['bus', 'city_bus', 'truck', 'box_truck']);
// Headlamp habits (design/brief/lighting-and-mood.md section 10). Drivers do not all reach
// for the switch at the same moment, and one in twenty-five forgets until it is nearly dark.
const HEADLAMP_SPREAD = 0.02; // rad: how much later than the first the last attentive driver is
const FORGETFUL_SHARE = 1 / 25;
const FORGETFUL_SUN_ELEVATION = -0.07; // rad, four degrees below the horizon
// Patrol cars mostly cruise with a dark roof; one in three is answering a call and runs its light bar.
const ON_CALL_SHARE = 1 / 3;
const LIGHT_BAR_CODE = 4; // added to the indicator code of the VEHICLE shader while the bar runs

const DRIVING = 0, WRECK = 1, PARKED = 2;

const approach = (value, target, step) => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

const isRoadLane = (lane) => !lane.junction && lane.next.length > 0;
const anyRoadLane = (lane) => !lane.junction;

/** One vehicle with a body: moving, wrecked or parked. */
class TrafficVehicle {
  constructor(id) {
    this.id = id;
    this.type = 0;
    this.state = PARKED;
    this.kit = null;
    this.view = null;
    this.box = null;
    this.driver = null;
    this.shape = null;
    this.lamp = { head: 0, brake: 0, reverse: 0, indicator: 0 };
    /** Sun elevation in radians below which this driver has the headlamps on. */
    this.dusk = HEADLAMP_SUN_ELEVATION;
    /** Share 0..1 of the close-up set of lamps this vehicle is drawn with, and whether it holds one of the places. */
    this.near = 0;
    this.nearHeld = false;
    /** Share 0..1 of their strength the lamps are drawn with while the vehicle arrives. */
    this.shown = 1;
    /** False until the first frame has set the lamps: a vehicle arrives with them as they should be. */
    this.lit = false;
    this.spin = 0;
    this.steer = 0;
    this.lastYaw = 0;
    this.rest = 0;
    this.retry = 0;
    // Offset from the driver's pose that is still being eased out after a rejoin.
    this.ox = 0; this.oz = 0; this.oyaw = 0;
    this.distance = 0;
    this.level = -2;
    this.loose = false; // a parked vehicle that has been pushed
    /** The garage id of a car the player left here, so that taking it back gives him his own car. */
    this.registryId = null;
    /** Seconds left of the blast this driver is sounding, and seconds until it may sound another. */
    this.honkFor = 0;
    this.honkWait = 0;
    this.lightBar = false; // a patrol car on a call
    // ---- Paloma PD (a police car only; see game/police.js)
    /** The light-bar state this car arrived with: the dispatch adds to it, never takes it away. */
    this.onCall = false;
    /** Ordered to the incident this frame. */
    this.responding = false;
    /** Metres from the player, from the last dispatch scan. */
    this.range = Infinity;
    /** The officer that has stepped out of this car, or null. */
    this.officer = null;
  }
}

/**
 * @param {{renderer: object, physics: object, graph: import('./lanes.js').LaneGraph|null,
 *          models: object[], seed?: number, notify?: (text: string) => void}} deps
 *   models: the traffic models (10.1, 15.3); their order is the parked type index
 *   notify: what the patrol dispatch says to the player (a toast)
 */
export function createTraffic(deps) {
  const { renderer, physics, graph, seed = 1, notify = null } = deps;
  // The list of vehicle types is traffic's own from here: a car the player leaves standing on the street
  // is added to it (`adopt`), and adding to the array the caller handed over would be growing somebody
  // else's data. The copy is shallow, so a model record handed to the game is the same record the street
  // was drawing from, which is what makes taking a car cost nothing.
  const models = Array.isArray(deps.models) ? deps.models.slice() : [];
  const sim = graph ? new TrafficSim(graph, { seed }) : null;
  // Without a lane graph or without vehicle types there is nothing to put on the road; the
  // simulation still runs, because its clock times the signals.
  const drivable = sim !== null && models.length > 0;
  const rng = makeRng(seed ^ 0x7ac1);
  const kits = models.map((model) => createVehicleKit(renderer, model));
  const shapes = models.map((model) => {
    const he = model.collider.halfExtents, c = model.collider.centre;
    return { frontLength: he[2] + c[2], rearLength: he[2] - c[2], halfWidth: he[0], wheelbase: model.dims.wheelbase, centreZ: c[2], halfLength: he[2] };
  });
  const masses = models.map((model) => trafficSpec(model.kind, model).mass);
  // The kind each type is, which is the model's own for the fleet and the one it was adopted under for a
  // car the player left: `trafficSpec` needs it to make the car drivable again when he takes it back.
  const typeKind = models.map((model) => model.kind);
  // How often each type appears on the road (buses and trucks are rare).
  const spawnWeight = (index) => (models[index].spawnWeight !== undefined ? models[index].spawnWeight : 1);
  const typeIndices = models.map((_, i) => i);
  const viewPools = models.map(() => []);

  /** @type {TrafficVehicle[]} */
  const moving = [];
  /** @type {TrafficVehicle[]} */
  const parked = [];
  /** @type {TrafficVehicle[]} */
  const loose = [];
  const tiles = new Map(); // key -> { data: Float32Array, vehicles: (TrafficVehicle|null)[] }
  const audible = [];
  const audiblePool = [];
  for (let i = 0; i < AUDIBLE; i++) audiblePool.push({ position: [0, 0, 0], velocity: [0, 0, 0], kind: 'sedan', throttle: 0, id: 0, distance: 0 });
  const focus = { x: 0, y: 0, z: 0, vx: 0, vz: 0, yaw: 0, halfLength: 2.1, halfWidth: 1, centreZ: 0, eye: [0, 0, 0], fx: 0, fy: 0, fz: 1, vehicle: null };
  /**
   * The player on foot, as the drivers see him. He is not part of the crowd -- the crowd steps aside
   * for him on its own rules -- he is an obstacle in a lane, which is what makes a car stop for him
   * rather than drift past. A man is a capsule with no length to it: a circle of one shoulder.
   */
  const walker = { active: false, x: 0, z: 0, yaw: 0, radius: 0.32, vx: 0, vz: 0 };
  /** The cars sounding their horn this step, nearest first, for the audio and the HUD. */
  const honking = [];
  const honkingPool = [];
  for (let i = 0; i < HONK_MAX; i++) honkingPool.push({ id: 0, position: [0, 0, 0], forward: [0, 0, -1], low: false });
  /** The distance each reported horn is at, so the list can be kept nearest-first by insertion. */
  const honkDist = new Float64Array(HONK_MAX);
  const pos = [0, 0, 0];
  const centre = [0, 0, 0];
  let density = 2;
  // The holders of the close-up lamps this frame, nearest first, and the distance each was ranked by.
  const nearest = new Array(NEAR_MAX).fill(null), nearKey = new Float64Array(NEAR_MAX);
  let nearCount = 0;
  let nextId = 1;

  // ------------------------------------------------------------------ Paloma PD
  //
  // The cruiser models, the roof bar and the road behaviour of a patrol car are the release's
  // own (traffic type 7, `lightBar` in spawnOn). What follows is the dispatch added on top: it
  // gives the units it wants at an incident a route over the lane graph, runs their bars, and
  // puts an officer on the ground next to a stopped car. It never writes a pose and never
  // creates a body: the drivers keep their junction grants, and an officer walks in the drawn
  // world only, so nothing here can push traffic or clip through a wall undetected.
  // Every type the agency puts on the road: the marked cruiser (the release's own type 7) and the
  // unmarked radio car this fork adds on the mid-size body. `policeType` is the marked one, which is
  // what the beat is made of; the dispatch counts them all, because to a driver a follow car is a
  // follow car whatever it is wearing.
  const policeTypes = new Set();
  for (let i = 0; i < models.length; i++) if (models[i].kind === 'police') policeTypes.add(i);
  const policeType = models.findIndex((model) => model.kind === 'police');
  const unmarkedType = models.findIndex((model) => model.name === 'police-unmarked');
  const police = drivable && policeType >= 0 ? new PatrolDispatch({
    graph,
    // A unit is seen when a ray from the camera to it reaches it: buildings, walls and other
    // cars all block the view, so an incident only escalates where an officer can see it.
    canSee(unit) {
      const p = unit.box.renderPos;
      const dx = p[0] - focus.eye[0], dy = p[1] + 1.25 - focus.eye[1], dz = p[2] - focus.eye[2];
      const d = Math.hypot(dx, dy, dz);
      if (d < 3.5) return true;
      ray.origin[0] = focus.eye[0]; ray.origin[1] = focus.eye[1]; ray.origin[2] = focus.eye[2];
      ray.direction[0] = dx / d; ray.direction[1] = dy / d; ray.direction[2] = dz / d;
      const hit = physics.raycast(ray.origin, ray.direction, d - 0.4, focus.vehicle);
      return !hit.hit || hit.body === unit.box;
    },
    routeDriver: (driver, route) => sim.setRoute(driver, route),
    notify: (text) => { if (notify) notify(text); },
  }) : null;
  const ray = { origin: [0, 0, 0], direction: [0, 0, 0] };
  const officer = { mesh: -1, failed: false, clock: 0 };
  // An impact is reported by physics, where the contact really happened. It is reported for the
  // simulated vehicle in it, which is the player's car: so a patrol car being struck is news on
  // its own, and a crash between the player and anyone else is a violation only where an officer
  // can see it (which police.impact judges with the last scan).
  const stopImpact = physics.onImpact ? physics.onImpact((e) => {
    if (police && e.vehicle === focus.vehicle) police.impact(e.other ? e.other.userData : null, e.speed);
  }) : null;

  /** The officer mesh, made once on first need: a car that never chases anyone costs nothing. */
  function officerMesh() {
    if (officer.failed) return -1;
    if (officer.mesh < 0) {
      try {
        officer.mesh = renderer.createMesh(buildFootOfficer(), { retain: true });
      } catch (error) {
        officer.failed = true; // no officers on a renderer that will not take the mesh
        console.error('Officer mesh could not be uploaded', error);
        return -1;
      }
    }
    return officer.mesh;
  }

  function acquireOfficer(unit) {
    if (unit.officer) return unit.officer;
    const mesh = officerMesh();
    if (mesh < 0) return null;
    const p = unit.box.pos;
    const obj = renderer.addDynamic({ mesh, castShadow: true });
    // The VEHICLE shader reads objA as paint and finish and objB.w as the lamp code: an officer
    // wears no lamps, and every material of the mesh is a fixed one, so both stay neutral.
    obj.objA[0] = 0.42; obj.objA[1] = 0.48; obj.objA[2] = 0.54;
    const o = { obj, x: p[0], z: p[2], yaw: unit.box.yaw, walking: 0, at: 0 };
    unit.officer = o;
    return o;
  }

  function releaseOfficer(unit) {
    const o = unit.officer;
    if (!o) return;
    o.obj.remove();
    unit.officer = null;
  }

  /**
   * The officers and the roof bars, once per frame. Officers ride: an officer exists only while
   * their own car is standing, is within OFFICER_RANGE and has not been shoved out of place, and
   * `stopped` (the player waiting with a unit after him) is what sends one across to the driver's
   * door. Otherwise an officer walks back to their own car and is released when they reach it, so
   * nobody is left standing on a double yellow line chasing a cruiser that has pulled away.
   */
  const OFFICER_RANGE = 150, OFFICER_WALK = 1.75, BAR_RANGE = 220;
  /** Metres: how near the stopped car an officer will set out across. */
  const OFFICER_DEPLOY = 60;
  /** Metres: the height of the flat land the streets are drawn at (see game.js). */
  const LAND_Y = 1.2;
  function updatePolice(dt, stopped) {
    const status = police.status;
    let onFoot = 0;
    officer.clock += dt;
    for (const unit of police.units) {
      const p = unit.box;
      // Every unit answering, or simply near, an incident runs its bar; one that arrived on a
      // call keeps it running, which is how the release's own cruisers came onto the road.
      unit.lightBar = unit.onCall || unit.responding || (status.heat > 0 && unit.range < BAR_RANGE);
      // Officers ride. They are on the ground only while their own car is standing and while the
      // one they stopped is close; nobody chases a cruising car on foot across the island.
      const speed = unit.driver ? unit.driver.v : Math.hypot(p.vel[0], p.vel[2]);
      if (speed > 2.2 || unit.distance > OFFICER_RANGE || p.pushed || unit.state !== DRIVING) {
        releaseOfficer(unit);
        continue;
      }
      const out = stopped && unit.distance < OFFICER_DEPLOY;
      const o = out ? acquireOfficer(unit) : unit.officer;
      if (!o) continue;
      const cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
      // Local +x is the car's left. At a stop the officer walks out to the player's driver's
      // door; otherwise they make for the kerb side of their own car, facing along it.
      const gx = 1.55, gz = -1.15;
      const idle = !out;
      const tx = idle ? p.pos[0] - cs * 1.3 : focus.x + cs * gx + sn * gz;
      const tz = idle ? p.pos[2] + sn * 1.3 : focus.z - sn * gx + cs * gz;
      const dx = tx - o.x, dz = tz - o.z, d = Math.hypot(dx, dz);
      const step = OFFICER_WALK * dt;
      if (idle && d < 0.45) { releaseOfficer(unit); continue; }
      if (d > 0.02) {
        o.yaw = idle ? p.yaw : Math.atan2(dx, dz);
        if (d > step) { o.x += dx / d * step; o.z += dz / d * step; } else { o.x = tx; o.z = tz; }
      }
      o.walking = clamp(o.walking + (d > step * 1.5 ? dt * 5 : -dt * 5), 0, 1);
      // Both feet on the ground: the flat land height, the same the parked cars are put at.
      const bob = Math.abs(Math.sin(officer.clock * 7.4)) * 0.035 * o.walking;
      m4fromYawPos(o.obj.matrix, o.yaw, o.x, LAND_Y + bob, o.z, 1);
      o.at = idle ? 0 : 1 - clamp(d / 12, 0, 1);
      onFoot++;
    }
    status.officers = onFoot;
  }

  function inView(x, y, z) {
    const dx = x - focus.eye[0], dy = y - focus.eye[1], dz = z - focus.eye[2];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return d < 1 || (dx * focus.fx + dy * focus.fy + dz * focus.fz) / d > VIEW_COS;
  }

  function acquireView(type) {
    const view = viewPools[type].pop() || new VehicleView(renderer, kits[type], { castShadow: true });
    view.setVisible(true);
    view.markTeleported();
    return view;
  }

  function releaseView(type, view) {
    view.setVisible(false);
    view.update(0, null);
    viewPools[type].push(view);
  }

  function makeVehicle(type, state, x, y, z, yaw, paint, dirt) {
    const v = new TrafficVehicle(nextId++);
    v.type = type;
    v.state = state;
    v.kit = kits[type];
    v.shape = shapes[type];
    v.view = acquireView(type);
    v.view.setPaint(paint, dirt);
    // What it is wearing, kept on the vehicle: a car that is taken off the street is rebuilt as the
    // player's own in the same colour, and the colour lives in the view otherwise.
    v.paint = paint;
    v.dirt = dirt;
    v.view.setLamps(0, 0, 0, 0);
    pos[0] = x; pos[1] = y; pos[2] = z;
    v.box = physics.createKinematicBox({ model: models[type], mass: masses[type], userData: v, pos, yaw });
    v.lastYaw = yaw;
    v.view.setBodyFromYaw(pos, yaw);
    return v;
  }

  function destroyVehicle(v) {
    releaseOfficer(v);
    if (police) police.remove(v);
    if (v.driver) { sim.remove(v.driver); v.driver = null; }
    physics.removeKinematicBox(v.box);
    releaseView(v.type, v.view);
    v.box = null;
    v.view = null;
  }

  function removeAt(list, index) {
    list[index] = list[list.length - 1];
    list.pop();
  }

  // ------------------------------------------------------------------ moving vehicles

  function spawnOn(lane, s, forcedType = -1) {
    const type = forcedType >= 0 ? forcedType : rng.weighted(typeIndices, spawnWeight);
    const shape = shapes[type];
    const speed = Math.min(comfortSpeed(lane, s), lane.speedLimit) * 0.85;
    if (!sim.canPlace(lane, s, shape.frontLength, shape.rearLength, speed)) return false;
    const driver = sim.add(lane, s, shape, speed);
    const paints = models[type].paints;
    const v = makeVehicle(type, DRIVING, driver.x, driver.y, driver.z, driver.yaw, paints[rng.int(0, paints.length - 1)], rng.range(0, 0.3));
    v.driver = driver;
    v.dusk = hash01(driver.seed, 11) < FORGETFUL_SHARE ? FORGETFUL_SUN_ELEVATION : HEADLAMP_SUN_ELEVATION - HEADLAMP_SPREAD * hash01(driver.seed, 9);
    // A bar only goes on a car built with one: the radio car has no glass on its roof to light.
    v.lightBar = policeTypes.has(type) && type !== unmarkedType && hash01(driver.seed, 13) < ON_CALL_SHARE;
    if (police && policeTypes.has(type)) { v.onCall = v.lightBar; police.add(v); }
    driver.userData = v;
    moving.push(v);
    return true;
  }

  /**
   * A patrol car of its own: the traffic mix puts one on the road about once in fifty cars,
   * which is not a police force. So the streets keep a minimum number of cruisers driving
   * within PATROL_KEEP of the player, one at low density and two above it, and a car that is
   * standing down is not retired while it is the last one. They are ordinary traffic in every
   * other respect: put on a lane through the driver simulation, with a box in physics, and
   * taken off again by the same rules as any other car.
   */
  const PATROL_KEEP = 260;
  /** None at all with the traffic switched off; one at low density, two above it. */
  const patrolWanted = () => (density === 0 ? 0 : density >= 2 ? 2 : 1);
  function patrolCount() {
    let n = 0;
    for (const v of moving) if (v.type === policeType || v.type === unmarkedType) n++;
    return n;
  }

  // A cruiser may come onto the beat nearer than ordinary traffic does, because a patrol car down
  // the road is the thing that makes the police feel present; it still may not arrive in view.
  const PATROL_NEAR = 95;
  /** One attempt at a cruiser on a lane of the ring at `angle`, `radius`. */
  function trySpawnPatrol(angle, radius) {
    const hit = graph.nearest(focus.x + Math.sin(angle) * radius, focus.z + Math.cos(angle) * radius, SPAWN_SNAP, isRoadLane);
    if (!hit) return false;
    if (Math.hypot(hit.x - focus.x, hit.z - focus.z) < PATROL_NEAR) return false;
    if (inView(hit.x, hit.y + 0.7, hit.z)) return false;
    return spawnOn(hit.lane, hit.s, policeType);
  }

  function keepPatrol() {
    const want = patrolWanted();
    // A few attempts, not a loop until it works: the ring may be full of cars right now, and the
    // next step will try again. Closer than ordinary traffic, so that the beat runs past the
    // player rather than happening somewhere out of sight.
    for (let i = 0; i < SPAWN_ATTEMPTS * 2 && patrolCount() < want; i++) {
      if (trySpawnPatrol(rng.range(-Math.PI, Math.PI), rng.range(PATROL_NEAR, 240))) moving[moving.length - 1].shown = 0;
    }
  }

  /** One attempt to put a vehicle on a lane near the ring point at `angle`, `radius`. */
  function trySpawn(angle, radius, near, hiddenWithin) {
    const hit = graph.nearest(focus.x + Math.sin(angle) * radius, focus.z + Math.cos(angle) * radius, SPAWN_SNAP, isRoadLane);
    if (!hit) return false;
    const distance = Math.hypot(hit.x - focus.x, hit.z - focus.z);
    if (distance < near) return false;
    if (distance < hiddenWithin && inView(hit.x, hit.y + 0.7, hit.z)) return false;
    return spawnOn(hit.lane, hit.s);
  }

  function spawn() {
    // The beat is on top of the traffic target, not inside it.
    const want = MOVING_BY_DENSITY[density] + patrolWanted();
    if (!drivable || moving.length >= want) return;
    // Mostly ahead of where the player is going, so that the road in front is never empty.
    const speed = Math.hypot(focus.vx, focus.vz);
    const heading = speed > 3 ? Math.atan2(focus.vx, focus.vz) : focus.yaw;
    for (let i = 0; i < SPAWN_ATTEMPTS && moving.length < want; i++) {
      const angle = rng.chance(0.3) ? rng.range(-Math.PI, Math.PI) : heading + rng.gauss() * 0.9;
      // Far ahead a new vehicle may be in view, and at night its lamps are all of it that shows.
      if (trySpawn(angle, rng.range(SPAWN_NEAR, SPAWN_FAR), SPAWN_NEAR, SPAWN_VISIBLE_BEYOND)) moving[moving.length - 1].shown = 0;
    }
    keepPatrol();
  }

  function retire() {
    const hx = Math.sin(focus.yaw), hz = Math.cos(focus.yaw);
    for (let i = moving.length - 1; i >= 0; i--) {
      const v = moving[i];
      const dx = v.box.pos[0] - focus.x, dz = v.box.pos[2] - focus.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      let gone = d > RETIRE_FAR;
      if (!gone && (d > RETIRE_BEHIND || v.state === WRECK || v.driver.finished || v.driver.idle > RETIRE_STUCK_SECONDS)) {
        const seen = inView(v.box.pos[0], v.box.pos[1] + 0.7, v.box.pos[2]);
        if (v.state === WRECK) gone = !seen && d > 60 && v.rest > WRECK_SECONDS;
        else if (v.driver.finished || v.driver.idle > RETIRE_STUCK_SECONDS) gone = !seen && d > 60;
        else gone = !seen && dx * hx + dz * hz < 0;
      }
      // A car in somebody's race is kept on the road while the course still holds it: the field falling
      // apart behind a straggler is a broken board, not a close finish. It is still dropped at the far
      // radius, where the race marks it out (game/races.js).
      if (gone && v.raced && d < RETIRE_FAR) gone = false;
      // The last cruiser of the beat stays on the road while it is still worth keeping.
      if (gone && police && policeTypes.has(v.type) && d < PATROL_KEEP && v.state === DRIVING && !v.driver.finished && patrolCount() <= 1) gone = false;
      if (gone) {
        destroyVehicle(v);
        removeAt(moving, i);
      }
    }
  }

  /** A hit vehicle that has come to rest along a lane goes back to its driver. */
  function tryRejoin(v) {
    const box = v.box;
    const hit = graph.nearest(box.pos[0], box.pos[2], REJOIN_LATERAL, anyRoadLane);
    if (!hit || !isRoadLane(hit.lane) || Math.abs(angleDelta(hit.yaw, box.yaw)) > REJOIN_ANGLE) return false;
    if (!sim.canPlace(hit.lane, hit.s, v.shape.frontLength, v.shape.rearLength, 0)) return false;
    const driver = sim.add(hit.lane, hit.s, v.shape, 0);
    v.ox = box.pos[0] - driver.x; v.oz = box.pos[2] - driver.z; v.oyaw = angleDelta(driver.yaw, box.yaw);
    v.driver = driver;
    driver.userData = v;
    v.state = DRIVING;
    v.rest = 0;
    box.resume();
    return true;
  }

  function stepMoving(dt) {
    for (let i = 0; i < moving.length; i++) {
      const v = moving[i], box = v.box;
      if (v.state === DRIVING) {
        if (box.pushed) {
          // Physics has taken the vehicle: the driver gives up the road.
          sim.remove(v.driver);
          v.driver = null;
          v.state = WRECK;
          v.rest = 0;
          v.retry = 0;
          continue;
        }
        const d = v.driver;
        if (v.ox !== 0 || v.oz !== 0 || v.oyaw !== 0) {
          v.ox = damp(v.ox, 0, REJOIN_HALF_LIFE, dt); v.oz = damp(v.oz, 0, REJOIN_HALF_LIFE, dt); v.oyaw = damp(v.oyaw, 0, REJOIN_HALF_LIFE, dt);
          if (Math.abs(v.ox) + Math.abs(v.oz) < 0.01 && Math.abs(v.oyaw) < 0.002) { v.ox = 0; v.oz = 0; v.oyaw = 0; }
        }
        pos[0] = d.x + v.ox; pos[1] = d.y; pos[2] = d.z + v.oz;
        box.setPose(pos, d.yaw + v.oyaw);
        // Front wheels follow the curvature of the path; all wheels roll with the speed.
        const travelled = d.v * dt;
        if (travelled > 0.02) v.steer = damp(v.steer, clamp(Math.atan(v.shape.wheelbase * angleDelta(v.lastYaw, d.yaw) / travelled), -0.6, 0.6), 0.08, dt);
        v.lastYaw = d.yaw;
      } else {
        const speed = Math.sqrt(box.vel[0] * box.vel[0] + box.vel[2] * box.vel[2]);
        v.rest = speed < REST_SPEED ? v.rest + dt : 0;
        v.retry -= dt;
        if (v.rest > REJOIN_AFTER && v.retry <= 0) {
          v.retry = 1;
          tryRejoin(v);
        }
      }
    }
  }

  // ------------------------------------------------------------------ parked vehicles

  /**
   * A parked vehicle's fixed rank in 0..1 and its dirt come from where it stands, not from its
   * slot in the tile data: a tile rebuilt at another planting density lists its cars in another
   * order, and the cars the player sees must be the same ones before and after.
   */
  const PARKED_FLOATS = 6;
  const parkedHash = (data, o, salt) => hash01(Math.round(data[o] * 8), Math.round(data[o + 2] * 8), salt);

  function parkFromTile(tile, index) {
    const data = tile.data, o = index * PARKED_FLOATS;
    const type = clamp(data[o + 4] | 0, 0, models.length - 1);
    const paints = models[type].paints;
    const v = makeVehicle(type, PARKED, data[o], data[o + 1], data[o + 2], data[o + 3], paints[(data[o + 5] | 0) % paints.length], 0.35 * parkedHash(data, o, 7));
    parked.push(v);
    return v;
  }

  function removeParked(v) {
    const i = parked.indexOf(v);
    if (i >= 0) removeAt(parked, i);
    const j = loose.indexOf(v);
    if (j >= 0) removeAt(loose, j);
    destroyVehicle(v);
  }

  // ------------------------------------------------------------------ taken from the street
  //
  // A car the player walks up to and takes. Traffic owns every vehicle on the road, so the taking is
  // traffic's to hand over: it lifts the vehicle out of its own lists, gives the pooled view and the
  // physics box back, and says what the game needs to build a drivable car in the same place, facing
  // the same way, wearing the same paint. The model record is plain data -- packed meshes, numbers,
  // arrays -- so handing it over costs nothing and does not take it away from traffic, which goes on
  // drawing the rest of the fleet from it. The reverse is here as well: the car the player left
  // standing becomes a parked vehicle of its own type, so the street he walked away from still has
  // his car in it, and he can take it back the same way.

  /** Fastest car (m/s) a man may climb into, and how far he may reach it from. foot.js owns the rule
   *  (`BOARD_SPEED_LIMIT`, `BOARD_DISTANCE`) and game.js passes its own numbers in; these are only the
   *  defaults of a search called with nothing. */
  const TAKE_SPEED = 1.5, TAKE_REACH = 2.4;

  /** The speed of a vehicle along the road, from the driver while it has one and from physics after. */
  function speedOf(v) {
    return v.driver ? v.driver.v : Math.hypot(v.box.vel[0], v.box.vel[2]);
  }

  /**
   * Whether a vehicle may be walked up to and taken. Nearly stopped, whatever it is doing: a parked
   * car, a car waiting for a man in the road, a wreck that has finished sliding. A car in somebody's
   * race belongs to the field until the course lets go of it, and a car physics has taken over is
   * rolling, which is the same thing as not stopped.
   */
  function takeable(v, speedLimit) {
    if (v.raced) return false;
    if (v.state === DRIVING && v.driver === null) return false;
    if (Math.abs(speedOf(v)) >= speedLimit) return false;
    return v.state !== WRECK || v.rest > 0.4;
  }

  /** The lists a vehicle may be standing in, in the order they are worth searching. */
  const takeLists = [moving, parked];

  /** The one pooled record `nearestTo` answers with, so that asking every step allocates nothing. */
  const nearTake = {
    active: false, id: 0, type: 0, kind: 'sedan', name: 'sedan', tag: 'traffic',
    x: 0, y: 0, z: 0, yaw: 0, speed: 0, distance: 0, hadDriver: false,
  };

  /**
   * The nearest vehicle a man standing at (x, z) could take. Called every step while the player is on
   * foot, which is why the answer is a record rewritten in place rather than a new object.
   * @param {number} x
   * @param {number} z
   * @param {number} [reach]       metres from the man to the car's origin
   * @param {number} [speedLimit]  fastest car taken, m/s
   * @returns {object} `nearTake`, with `active` false when nothing is in reach
   */
  function nearestTo(x, z, reach = TAKE_REACH, speedLimit = TAKE_SPEED) {
    nearTake.active = false;
    let best = reach;
    let found = null;
    // `loose` is a subset of `parked` (a parked car physics has pushed), so two lists cover the road.
    for (let pass = 0; pass < takeLists.length; pass++) {
      const list = takeLists[pass];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (!takeable(v, speedLimit)) continue;
        const dx = v.box.pos[0] - x, dz = v.box.pos[2] - z;
        const d = Math.hypot(dx, dz);
        if (d >= best) continue;
        best = d; found = v;
      }
    }
    if (!found) return nearTake;
    nearTake.active = true;
    nearTake.id = found.id; nearTake.type = found.type;
    nearTake.kind = typeKind[found.type]; nearTake.name = models[found.type].name;
    nearTake.x = found.box.pos[0]; nearTake.y = found.box.pos[1]; nearTake.z = found.box.pos[2];
    nearTake.yaw = found.box.yaw; nearTake.speed = speedOf(found);
    nearTake.distance = best;
    // A car with a driver in it is a car somebody is being thrown out of, and the street should see it.
    nearTake.hadDriver = found.driver !== null;
    return nearTake;
  }

  /**
   * Takes a vehicle off the road and hands it over. Its box and its view go back to the pools they
   * came from -- the view is traffic's, and the player's car is drawn by a view of its own -- and its
   * driver is given up to the simulation, the dispatch and the beat.
   * @param {number} id  the vehicle id from `nearestTo`
   * @returns {object|null} what the game needs to build the car, or null when it is no longer there
   */
  function take(id) {
    for (let pass = 0; pass < takeLists.length; pass++) {
      const list = takeLists[pass];
      for (let i = 0; i < list.length; i++) {
        const v = list[i];
        if (v.id !== id) continue;
        const model = models[v.type];
        const taken = {
          model, kind: typeKind[v.type], name: model.name,
          paint: v.paint, dirt: v.dirt,
          x: v.box.pos[0], y: v.box.pos[1], z: v.box.pos[2], yaw: v.box.yaw,
          speed: speedOf(v), hadDriver: v.driver !== null, state: v.state,
          registryId: v.registryId || null,
          // A car of the agency's is a different act again: it is missed by the dispatch the moment it
          // goes, and the street knows what it was.
          // By the beat's own list for a unit that is on it, and by kind for a cruiser the player has
          // already taken once and left on the street: the dispatch does not count that one as a unit
          // (it is parked, and `keepPatrol` would otherwise wait for it), but it is still a patrol car
          // and taking it again is still the same act.
          police: policeTypes.has(v.type) || typeKind[v.type] === 'police',
        };
        destroyVehicle(v);
        removeAt(list, i);
        return taken;
      }
    }
    return null;
  }

  /** The traffic type each adopted car was given, by the key it was adopted under. */
  const adoptedTypes = new Map();

  /**
   * Puts a car that is not traffic's -- the one the player just left -- on the street as a parked
   * vehicle of its own type. The type is made once per car and kept: leaving the same car twice, or
   * taking it back and leaving it again, must not grow the fleet's tables for ever. It is never
   * spawned into traffic (`typeIndices` is built before this and is not added to), so a car the
   * player owns stays the one car of its kind on the road.
   * @param {{model: object, kind?: string, name: string, x: number, y: number, z: number, yaw: number,
   *          mass?: number, paint?: object, dirt?: number, registryId?: string|null}} rec
   * @returns {boolean} whether the car was put there
   */
  function adopt(rec) {
    if (!drivable || !rec || !rec.model) return false;
    const key = rec.registryId || ('adopted:' + rec.name);
    let type = adoptedTypes.get(key);
    if (type === undefined) {
      type = models.length;
      const model = rec.model;
      // Its own mass if the caller knows it -- the player's car is built to a specification that says --
      // and the kind's otherwise. Both are what physics will push it about with when something hits it.
      const kind = rec.kind || model.kind || 'sedan';
      const mass = rec.mass > 0 ? rec.mass : trafficSpec(kind, model).mass;
      models.push(model);
      kits.push(createVehicleKit(renderer, model));
      const he = model.collider.halfExtents, c = model.collider.centre;
      shapes.push({ frontLength: he[2] + c[2], rearLength: he[2] - c[2], halfWidth: he[0], wheelbase: model.dims.wheelbase, centreZ: c[2], halfLength: he[2] });
      masses.push(mass);
      typeKind.push(kind);
      viewPools.push([]);
      adoptedTypes.set(key, type);
    }
    const v = makeVehicle(type, PARKED, rec.x, rec.y, rec.z, rec.yaw, rec.paint || models[type].paints[0], rec.dirt || 0);
    v.registryId = rec.registryId || null;
    parked.push(v);
    return true;
  }

  /** Brings a tile's parked vehicles in line with the density setting. */
  function reconcileTile(tile) {
    const share = PARKED_BY_DENSITY[density];
    const count = tile.vehicles.length;
    for (let i = 0; i < count; i++) {
      // The same vehicles stay at every setting: each has a fixed rank between 0 and 1.
      const wanted = parkedHash(tile.data, i * PARKED_FLOATS, 3) < share;
      const v = tile.vehicles[i];
      if (wanted && !v) tile.vehicles[i] = parkFromTile(tile, i);
      else if (!wanted && v && !v.loose) { removeParked(v); tile.vehicles[i] = null; }
    }
  }

  /** Same car: same spot, same type, same colour (the tile builder places a car to the millimetre). */
  function sameParked(a, i, b, j) {
    const p = i * PARKED_FLOATS, q = j * PARKED_FLOATS;
    return Math.abs(a[p] - b[q]) < 0.01 && Math.abs(a[p + 2] - b[q + 2]) < 0.01 && (a[p + 4] | 0) === (b[q + 4] | 0) && (a[p + 5] | 0) === (b[q + 5] | 0);
  }

  /**
   * The tile has been rebuilt (another planting density): its vehicles move to the slot their
   * car has in the new data, so a car that is still listed stays the same object, unmoved and
   * undrawn-again, whether it is standing where it was put or has been pushed loose. Only a car
   * that the new data no longer lists goes.
   */
  function replaceTile(tile, data) {
    const old = tile.vehicles, count = Math.floor(data.length / PARKED_FLOATS);
    const vehicles = new Array(count).fill(null);
    for (let i = 0; i < old.length; i++) {
      const v = old[i];
      if (!v) continue;
      let j = 0;
      while (j < count && (vehicles[j] !== null || !sameParked(tile.data, i, data, j))) j++;
      if (j < count) vehicles[j] = v;
      else removeParked(v);
    }
    tile.data = data;
    tile.vehicles = vehicles;
    reconcileTile(tile);
  }

  // ------------------------------------------------------------------ public

  const traffic = {
    sim,
    /** The patrol dispatch, or null where there is no road network (game/police.js). */
    police,
    /** Is this vehicle's type a Paloma PD car (marked or unmarked)? For a caller that met one. */
    isPolice(v) { return !!v && policeTypes.has(v.type); },
    /** Number of moving vehicles (wrecks included). */
    get count() { return moving.length; },
    get parkedCount() { return parked.length; },
    /** The vehicles nearest to the listener, for the audio engine. Refreshed by update(). */
    audible,

    /** Traffic setting 0..3. */
    setDensity(level) {
      const next = clamp(Math.round(level), 0, 3);
      if (next === density) return;
      density = next;
      for (const tile of tiles.values()) reconcileTile(tile);
      if (density === 0 && police) police.reset();
      // Fewer wanted than exist: the ones furthest from the player go first, the cruisers of the
      // beat excepted (they are the police minimum, not part of the traffic the setting counts).
      const want = MOVING_BY_DENSITY[density];
      while (moving.length > want) {
        const cruisers = patrolCount();
        let far = -1, best = -Infinity;
        for (let i = 0; i < moving.length; i++) {
          const v = moving[i];
          if (police && v.type === policeType && cruisers <= patrolWanted()) continue;
          if (v.distance > best) { best = v.distance; far = i; }
        }
        if (far < 0) break;
        destroyVehicle(moving[far]);
        removeAt(moving, far);
      }
    },

    /**
     * A near tile has arrived: `tile.parked` holds n * 6 values (15.2). A tile that is already
     * here is being replaced (rebuilt at another planting density): its cars are kept in place.
     */
    addTile(tile) {
      if (!tile || models.length === 0) return;
      const data = tile.parked && tile.parked.length >= PARKED_FLOATS ? tile.parked : null;
      const entry = tiles.get(tile.key);
      if (!data) { traffic.removeTile(tile.key); return; }
      if (entry) { replaceTile(entry, data); return; }
      const fresh = { data, vehicles: new Array(Math.floor(data.length / PARKED_FLOATS)).fill(null) };
      tiles.set(tile.key, fresh);
      reconcileTile(fresh);
    },

    removeTile(key) {
      const entry = tiles.get(key);
      if (!entry) return;
      for (const v of entry.vehicles) if (v) removeParked(v);
      tiles.delete(key);
    },

    /**
     * Where the player and the camera are; decides spawning, retiring and what the drivers
     * must avoid.
     * @param {object} player  from createPlayer
     * @param {{position: number[], forward: number[]}} camera
     */
    setFocus(player, camera) {
      const p = player.vehicle.pos, vel = player.vehicle.vel;
      focus.x = p[0]; focus.y = p[1]; focus.z = p[2];
      focus.vx = vel[0]; focus.vz = vel[2];
      focus.yaw = player.vehicle.yaw;
      focus.halfLength = player.kit.halfExtents[2]; focus.halfWidth = player.kit.halfExtents[0]; focus.centreZ = player.kit.colliderCentre[2];
      focus.eye[0] = camera.position[0]; focus.eye[1] = camera.position[1]; focus.eye[2] = camera.position[2];
      focus.fx = camera.forward[0]; focus.fy = camera.forward[1]; focus.fz = camera.forward[2];
      // Whose body the sight rays must not be stopped by: the player's own car stands between
      // the camera and most of what is ahead of it.
      focus.vehicle = player.vehicle;
    },

    /**
     * Advances the drivers and tells physics where every vehicle should be at the end of the
     * coming physics steps. Call before `physics.advance`, only when at least one step runs.
     * @param {number} dt  simulated time of those steps, seconds
     */
    step(dt) {
      if (!sim) return;
      sim.clearObstacles();
      const sin = Math.sin(focus.yaw), cos = Math.cos(focus.yaw);
      sim.obstacle(focus.x + sin * focus.centreZ, focus.z + cos * focus.centreZ, focus.yaw, focus.halfLength, focus.halfWidth, focus.vx, focus.vz);
      for (let i = 0; i < moving.length; i++) {
        const v = moving[i];
        if (v.state === WRECK) wreckObstacle(v);
      }
      for (let i = 0; i < loose.length; i++) wreckObstacle(loose[i]);
      // The man, after the cars: a driver that has to brake for both brakes for the nearer of them,
      // and the reason it reports is the one that bound, which is what the horn is decided from.
      if (walker.active) {
        sim.obstacle(walker.x, walker.z, walker.yaw, walker.radius, walker.radius, walker.vx, walker.vz, OBSTACLE.PERSON);
      }
      sim.step(dt);
      stepMoving(dt);
      horns(dt);
      retire();
      spawn();
    },

    /**
     * The player on foot, where the drivers can see him. Call every step while he is out of the car,
     * and with `active` false the moment he is back in it, or the drivers brake for a man who is
     * sitting behind the wheel of the car they are braking for.
     * @param {{active?: boolean, x?: number, z?: number, yaw?: number, vx?: number, vz?: number,
     *          crouching?: boolean}} w
     */
    setWalker(w) {
      if (!w || !w.active) { walker.active = false; return; }
      walker.active = true;
      walker.x = w.x; walker.z = w.z;
      walker.yaw = w.yaw || 0;
      walker.vx = w.vx || 0; walker.vz = w.vz || 0;
      // Crouching is a smaller thing to hit and a smaller thing to stop for, but it is still in the road.
      walker.radius = w.crouching ? 0.26 : 0.32;
    },

    /** The cars sounding their horn this step, nearest first. Refreshed by step(). */
    honking,

    /**
     * The nearest vehicle a man at (x, z) could take, as one pooled record with `active` saying
     * whether there is one. Called every step while the player is on foot; nothing is allocated.
     */
    nearestTo,

    /** Takes that vehicle off the road and hands it over, or null when it has gone. */
    take,

    /** Puts a car that is not traffic's on the street as a parked vehicle of its own type. */
    adopt,

    /** Fills the streets around the player at once (start of a drive, after a teleport). */
    populate() {
      if (!drivable) return;
      const want = MOVING_BY_DENSITY[density];
      for (let i = 0; i < want * 14 && moving.length < want; i++) {
        trySpawn(rng.range(-Math.PI, Math.PI), rng.range(POPULATE_NEAR, POPULATE_FAR), POPULATE_NEAR, 0);
      }
    },

    /**
     * Cars for a street race: `count` vehicles put on the grid behind a start line and told to follow
     * `route` over the lane graph. They are ordinary traffic in every other respect — the same drivers,
     * the same junction grants, the same retire rules — which is why they are worth racing: nothing is
     * simulated twice. (game/races.js)
     * @returns {object[]} one record per car that was actually placed, `{ car, driver, box, view }`
     */
    /**
     * Hand a race the field it wants.
     * @param {object} lane   the lane the start line sits on
     * @param {number} s      its arc position, where the player is standing
     * @param {number} count  how many rivals the tier asks for
     * @param {object} map    the course order, for sim.setRoute
     * @param {object} [opts] { from: [x, z] the line, lanes: Set of lane ids the course uses }
     */
    fieldForRace(lane, s, count, map, opts = {}) {
      const cars = [];
      // A street grid: cars go in front of the line first, since those are the ones you can see and
      // overtake, then behind it. `canPlace` refuses a spot somebody is already occupying, so a slot
      // that is taken is skipped rather than waited for — a race with three opponents beats a fair one
      // that never starts.
      const spots = [];
      for (let i = 0; i < count; i++) spots.push(s + 14 + i * 12, i ? s - 16 - i * 12 : -999);
      for (const want of spots) {
        if (cars.length >= count) break;
        if (!(want > 4) || want > lane.length - 4) continue;
        if (!spawnOn(lane, want, -1)) continue;
        const v = moving[moving.length - 1];
        if (v && v.driver) {
          if (map) sim.setRoute(v.driver, map);
          // Only the vehicle and its driver are handed out: the box and the view are the traffic pool's
          // to take back, and a car that falls behind the field is retired like any other (races.js reads
          // `car.driver` to tell a live opponent from a parked one).
          v.raced = true;
          cars.push({ car: v, driver: v.driver });
        }
      }
      // A borrowed field, when the kerbside is empty: the cars already out on the course *are* the
      // race, and a street race that turns up alone is not a race. These need no spawn at all, which is
      // why they work in a small streamed neighbourhood where the slot above is occupied or off-lane —
      // and they are taken as they come, since who happens to be driving this road is the whole point of
      // racing on one. The order is what makes them rivals; the physics was never asked to move anybody.
      if (cars.length < count) {
        const from = opts.from || null, onCourse = opts.lanes || null;
        const picked = [];
        for (let i = 0; i < moving.length; i++) {
          const v = moving[i];
          if (!v.driver || v.raced || v.state !== DRIVING || policeTypes.has(v.type)) continue;
          const p = v.box.pos;
          const d = from ? Math.hypot(p[0] - from[0], p[2] - from[1]) : 0;
          if (d > RECRUIT_RADIUS) continue;
          // Somebody already driving the course first, then whoever is closest to the line: both are a
          // car that was going this way anyway, which is what a street race is made of.
          const on = onCourse && v.driver.lane && onCourse.has(v.driver.lane.id) ? 0 : 1;
          picked.push({ v, d, rank: on * 1e4 + d });
        }
        picked.sort((a, b) => a.rank - b.rank);
        for (let i = 0; i < picked.length && cars.length < count; i++) {
          const v = picked[i].v;
          if (map) sim.setRoute(v.driver, map);
          v.raced = true;
          cars.push({ car: v, driver: v.driver });
        }
      }
      return cars;
    },

    /** Give a race's cars back to the street: the order is taken away and they drive on their own. */
    releaseFromRace(cars) {
      for (const c of cars || []) {
        if (!c.car) continue;
        // The mark comes off with the order: from here the street owns the car again, retire rules and
        // all. A car whose driver is gone has nothing left to be told.
        c.car.raced = false;
        if (c.car.driver) sim.setRoute(c.car.driver, null);
        else c.driver = null;
      }
    },

    /** Removes every moving vehicle (the player was moved somewhere else). */
    clear() {
      for (const v of moving) destroyVehicle(v);
      moving.length = 0;
    },

    /**
     * After the physics step: poses of the drawn vehicles, lamp states, the audible list.
     * @param {number} dt            frame time, seconds
     * @param {number} sunElevation  radians above the horizon
     * @param {number} rain          0..1
     * @param {number} [stepTime]    the simulated time `step` just advanced, seconds
     */
    update(dt, sunElevation, rain, stepTime = dt) {
      if (police) {
        // What the units are told happens before their lamps are written for this frame. Timed on
        // the simulation, not on the wall clock: a search called off after twelve seconds is
        // twelve seconds of the cars' own time, and a slow frame does not make the police impatient.
        police.step(stepTime, focus, true);
        updatePolice(stepTime, police.status.heat > 0 && Math.hypot(focus.vx, focus.vz) < 2.2);
      }
      const eye = focus.eye;
      audible.length = 0;
      nearCount = 0;
      for (let i = 0; i < moving.length; i++) {
        const v = moving[i], box = v.box, lamp = v.lamp;
        const p = box.renderPos;
        v.distance = distanceTo(p, eye);
        const night = sunElevation < v.dusk || rain > HEADLAMP_RAIN ? 1 : 0;
        lamp.head = v.lit && dt > 0 ? approach(lamp.head, night, dt / HEADLAMP_WARM_SECONDS) : night;
        if (lamp.head > 0) offerNear(v);
        let speed = 0;
        if (v.state === DRIVING) {
          const d = v.driver;
          speed = d.v;
          lamp.brake = d.braking ? 1 : 0; lamp.indicator = d.indicator;
        } else {
          speed = Math.sqrt(box.vel[0] * box.vel[0] + box.vel[2] * box.vel[2]);
          lamp.brake = 0; lamp.indicator = 3;
        }
        v.spin = (v.spin + speed * dt / v.kit.wheelRadius[0]) % (Math.PI * 2);
        v.view.setLamps(lamp.head, lamp.brake, 0, lamp.indicator + (v.lightBar ? LIGHT_BAR_CODE : 0));
        v.view.setBodyFromQuat(p, box.renderQuat);
        v.view.update(v.distance, null, v.steer, v.spin);
        noteAudible(v);
      }
      for (let i = 0; i < moving.length; i++) {
        const v = moving[i];
        v.nearHeld = false;
        for (let k = 0; k < nearCount; k++) if (nearest[k] === v) v.nearHeld = true;
        const share = v.nearHeld ? 1 - smoothstep(NEAR_FULL_RANGE, NEAR_RANGE, v.distance) : 0;
        v.near = v.lit && dt > 0 ? approach(v.near, share, dt / NEAR_FADE_SECONDS) : share;
        v.shown = Math.min(1, v.shown + dt / LAMP_ARRIVE_SECONDS);
        v.lit = true;
      }
      for (let i = 0; i < parked.length; i++) {
        const v = parked[i], box = v.box;
        const p = box.renderPos;
        v.distance = distanceTo(p, eye);
        if (box.pushed && !v.loose) { v.loose = true; loose.push(v); }
        // A parked vehicle only needs redrawing when it is moved or changes level of detail.
        const levels = v.kit.levels;
        let level = 0;
        while (level < levels.length - 1 && v.distance >= levels[level].far) level++;
        const moved = v.loose && (Math.abs(box.vel[0]) + Math.abs(box.vel[2]) > 0.01 || Math.abs(box.yawRate) > 0.01);
        if (level === v.level && !moved) continue;
        v.level = level;
        v.view.setBodyFromQuat(p, box.renderQuat);
        v.view.update(v.distance, null, 0, 0);
      }
    },

    /** This frame's vehicle lights, glows and contact shadows. */
    writeLamps(out, eye, time) {
      for (let i = 0; i < moving.length; i++) {
        const v = moving[i];
        if (v.distance < LAMP_RANGE) {
          const reach = v.shown * (1 - smoothstep(BEAM_FADE_FROM, BEAM_RANGE, v.distance));
          const glare = v.shown * (1 - smoothstep(LAMP_FADE_FROM, LAMP_RANGE, v.distance));
          writeVehicleLamps(out, v.kit.lamps, v.view.matrix, v.lamp, eye, time, reach, v.near, glare);
          const sign = v.kit.model.anchors.roofSign, lit = ROOF_SIGN_GLOW * v.lamp.head * reach;
          if (sign && lit > 0) {
            m4transformPoint(centre, v.view.matrix, sign.pos);
            out.glow(centre[0], centre[1], centre[2], ROOF_SIGN_SIZE, lit, lit * 0.72, lit * 0.2, CHANNEL.ALWAYS, GLOW_ROUND);
          }
        }
        if (v.distance < OCCLUDER_RANGE) occlude(out, v);
      }
      for (let i = 0; i < parked.length; i++) if (parked[i].distance < OCCLUDER_RANGE) occlude(out, parked[i]);
    },

    dispose() {
      if (stopImpact) stopImpact();
      if (police) { for (const unit of police.units) releaseOfficer(unit); police.reset(); }
      if (officer.mesh >= 0) renderer.destroyMesh(officer.mesh);
      traffic.clear();
      for (const key of [...tiles.keys()]) traffic.removeTile(key);
      for (const pool of viewPools) { for (const view of pool) view.dispose(); pool.length = 0; }
      for (const kit of kits) kit.dispose();
    },
  };

  function distanceTo(p, eye) {
    const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Which drivers are entitled to the horn, and for how long.
   *
   * A driver honks when the thing it is braking hardest for is a person and it is braking hard enough
   * that this is not a courtesy gap: HONK_DECEL is past the point where a car is committed to stopping.
   * One blast lasts HONK_SECONDS and then that driver stays quiet for HONK_COOLDOWN even if the man is
   * still standing there, because a horn held down forever stops being information. The nearest
   * HONK_MAX are reported, nearest first: the audio has a cap of its own, and a junction full of horns
   * says nothing that one horn does not.
   *
   * Nothing here allocates. This runs every simulated step, and the list it fills is four pooled
   * entries kept in order by insertion, which for four items is cheaper than sorting and cheaper than
   * the garbage a candidate array would make.
   */
  function horns(dt) {
    let count = 0;
    const eye = focus.eye;
    for (let i = 0; i < moving.length; i++) {
      const v = moving[i], driver = v.driver;
      if (v.honkFor > 0) v.honkFor -= dt;
      if (v.honkWait > 0) v.honkWait -= dt;
      if (!driver) continue;
      const dx = driver.x - eye[0], dz = driver.z - eye[2];
      const squared = dx * dx + dz * dz;
      if (squared > HONK_RANGE * HONK_RANGE) { v.honkFor = 0; continue; }   // out of earshot: give it up
      if (driver.avoidKind === OBSTACLE.PERSON && driver.avoidAccel < HONK_DECEL
          && v.honkFor <= 0 && v.honkWait <= 0) {
        v.honkFor = HONK_SECONDS;
        v.honkWait = HONK_COOLDOWN;
      }
      if (v.honkFor <= 0) continue;
      const distance = Math.sqrt(squared);
      let k = count;
      if (k >= HONK_MAX) {
        if (distance >= honkDist[k - 1]) continue;      // further than the four already reported
        k = HONK_MAX - 1;                                // and the furthest of those makes way
      } else {
        honking[k] = honkingPool[k];
        count++;
      }
      while (k > 0 && honkDist[k - 1] > distance) {
        honking[k] = honking[k - 1]; honkDist[k] = honkDist[k - 1]; k--;
      }
      honkDist[k] = distance;
      const entry = honking[k];
      entry.id = driver.id;
      entry.position[0] = driver.x; entry.position[1] = driver.y; entry.position[2] = driver.z;
      entry.forward[0] = Math.sin(driver.yaw); entry.forward[1] = 0; entry.forward[2] = Math.cos(driver.yaw);
      entry.low = HORN_LOW_TYPES.has(v.type);
    }
    honking.length = count;
  }

  function wreckObstacle(v) {
    const box = v.box, s = v.shape;
    const sin = Math.sin(box.yaw), cos = Math.cos(box.yaw);
    sim.obstacle(box.pos[0] + sin * s.centreZ, box.pos[2] + cos * s.centreZ, box.yaw, s.halfLength, s.halfWidth, box.vel[0], box.vel[2]);
  }

  function occlude(out, v) {
    m4transformPoint(centre, v.view.matrix, v.kit.colliderCentre);
    const he = v.kit.halfExtents;
    out.occluder(centre[0], centre[1], centre[2], v.box.yaw, he[0], he[1], he[2]);
  }

  /** Keeps the NEAR_MAX nearest vehicles with their lamps on as the holders of the close-up set. */
  function offerNear(v) {
    if (v.distance >= NEAR_RANGE) return;
    const key = v.nearHeld ? v.distance * NEAR_KEEP : v.distance;
    let slot = nearCount;
    if (slot === NEAR_MAX) {
      if (key >= nearKey[slot - 1]) return;
      slot--;
    } else {
      nearCount++;
    }
    while (slot > 0 && nearKey[slot - 1] > key) { nearest[slot] = nearest[slot - 1]; nearKey[slot] = nearKey[slot - 1]; slot--; }
    nearest[slot] = v; nearKey[slot] = key;
  }

  /** Keeps the AUDIBLE nearest moving vehicles, nearest first. */
  function noteAudible(v) {
    let slot = audible.length;
    if (slot === AUDIBLE) {
      if (v.distance >= audible[slot - 1].distance) return;
      slot--;
    } else {
      audible.push(audiblePool[slot]);
    }
    const entry = audible[slot];
    while (slot > 0 && audible[slot - 1].distance > v.distance) { audible[slot] = audible[slot - 1]; slot--; }
    audible[slot] = entry;
    const p = v.box.renderPos, vel = v.box.vel;
    entry.position[0] = p[0]; entry.position[1] = p[1]; entry.position[2] = p[2];
    entry.velocity[0] = vel[0]; entry.velocity[1] = vel[1]; entry.velocity[2] = vel[2];
    entry.kind = v.kit.model.kind;
    entry.throttle = v.driver ? clamp(0.15 + v.driver.a / v.driver.accel, 0, 1) : 0;
    entry.id = v.id;
    entry.distance = v.distance;
  }

  return traffic;
}
