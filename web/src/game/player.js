// The player's car: the simulated vehicle, what is drawn for it, its lamps, and the values
// that camera, effects, audio and HUD read from it each frame.

import { saturate, smoothstep, damp, quatYaw, m4transformPoint } from '../core/math.js';
import { KIND } from '../physics/index.js';
import { createVehicleKit, VehicleView } from './vehicleView.js';
import { writeVehicleLamps, HEADLAMP_SUN_ELEVATION, HEADLAMP_RAIN, FOGLAMP_RAIN, FOGLAMP_MIST } from './lamps.js';

export const HEADLAMP_MODES = Object.freeze(['auto', 'on', 'off']);

/** Audio surface names by physics surface kind (design/ARCHITECTURE.md 11.4). */
const SURFACE_NAMES = { [KIND.ASPHALT]: 'asphalt', [KIND.CONCRETE]: 'concrete', [KIND.SAND]: 'sand', [KIND.GRASS]: 'grass', [KIND.WATER]: 'water' };
/** How much each surface shakes the car at speed, 0..1. */
const SURFACE_ROUGHNESS = { [KIND.ASPHALT]: 0.04, [KIND.CONCRETE]: 0.14, [KIND.SAND]: 0.75, [KIND.GRASS]: 0.6, [KIND.WATER]: 0.3 };

// Tyre slip thresholds agreed with the physics owner: below them a tyre is gripping normally.
const SLIP_LONG_START = 0.15, SLIP_LONG_RANGE = 0.45;
const SLIP_LAT_START = 0.18, SLIP_LAT_RANGE = 0.30;
const SLIP_MIN_SPEED = 2; // m/s: slip ratios are meaningless at walking pace

const POD_SECONDS = 0.6; // s for pop-up headlamp pods to swing up or down
const LAMP_HALF_LIFE = 0.05; // s: a filament lamp does not switch instantly
const HEADLAMP_OFF_MARGIN = 0.02; // rad (about one degree): the sun must rise this far past the switch-on height
const DIRT_GAIN = 0.004; // dirt per metre driven on sand or grass
const DIRT_WASH = 0.03; // dirt lost per second in heavy rain

/**
 * @param {{renderer: object, physics: object, model: object, spec: object}} deps
 *   model: the car's model record (10.1); spec: its physics spec (`carSpec(id)`)
 */
export function createPlayer({ renderer, physics, model, spec }) {
  // The model first: one that cannot be drawn must leave nothing behind, in the physics either.
  const kit = createVehicleKit(renderer, model);
  let vehicle = null;
  try {
    vehicle = physics.createVehicle(spec, model);
  } catch (error) {
    kit.dispose();
    throw error;
  }
  const view = new VehicleView(renderer, kit, { castShadow: true });
  const lampState = { head: 0, brake: 0, reverse: 0, indicator: 0, fog: 0 };
  let throttlePedal = 0, brakePedal = 0;
  const hasPods = kit.pods.length > 0;
  let podTravel = 0; // 0 folded .. 1 raised, linear in time
  const centre = [0, 0, 0];
  const paints = model.paints && model.paints.length > 0 ? model.paints : [[0.5, 0.02, 0.02]];
  let paintIndex = 0;
  let dirt = 0;
  let headWanted = false;
  let fogWanted = false;
  // Where the car is drawn: with the vehicle, or on a stage (see `stage`).
  let drawnPos = vehicle.renderPos, drawnQuat = vehicle.renderQuat;

  const player = {
    vehicle,
    view,
    kit,
    model,
    paints,
    /** Interpolated pose at render time (the physics vehicle's own arrays). */
    pos: vehicle.renderPos,
    quat: vehicle.renderQuat,
    yaw: 0,
    /** Signed speed along the car, m/s. */
    forwardSpeed: 0,
    yawRate: 0,
    /** 0..1: how hard the tyres are sliding, for audio and smoke. */
    slip: 0,
    /** Angle between heading and direction of travel, rad. */
    slipAngle: 0,
    /** Physics KIND under most of the wheels, and its audio name. */
    surfaceKind: KIND.ASPHALT,
    surface: 'asphalt',
    /** 0..1: surface shake at the current speed, for camera and rumble. */
    roughness: 0,
    /** World height of the ground under the wheels; kept while the car is in the air. */
    groundY: vehicle.renderPos[1],
    headlampMode: 'auto',
    headlampsOn: false,
    fogLampsOn: false,
    bonnetCam: (model.anchors && model.anchors.bonnetCam) || null,
    /** Exhaust pipe exits in the vehicle frame: [{ pos, dir }]. */
    exhausts: (model.anchors && model.anchors.exhausts) || [],
    length: model.dims.length,
    height: model.dims.height,

    get paintIndex() { return paintIndex; },

    /** Paint by index into the model's factory colours (wraps). */
    setPaint(index) {
      paintIndex = ((Math.round(index) % paints.length) + paints.length) % paints.length;
      view.setPaint(paints[paintIndex], dirt);
      return paintIndex;
    },

    /**
     * Shows the car somewhere other than where its vehicle stands: on the garage's turntable,
     * as it sits on its springs but moved by no physics. The two arrays are read every frame,
     * so whoever owns them moves the car; `stage(null, null)` gives it back to the vehicle.
     * A staged car belongs to the renderer's interior world, and is shown clean: whatever
     * the road left on it is washed off, for good, since every drive begins from there.
     * @param {number[]|null} pos   world position of the vehicle frame's origin
     * @param {number[]|null} quat  its orientation
     */
    stage(pos, quat) {
      const staged = Boolean(pos && quat);
      drawnPos = staged ? pos : vehicle.renderPos;
      drawnQuat = staged ? quat : vehicle.renderQuat;
      if (staged && dirt > 0) {
        dirt = 0;
        view.setPaint(paints[paintIndex], dirt);
      }
      view.setInterior(staged);
      view.markTeleported();
      refresh(0, 0);
    },

    /** The headlamp key: automatic, on, off. Returns the new mode. */
    cycleHeadlamps() {
      player.headlampMode = HEADLAMP_MODES[(HEADLAMP_MODES.indexOf(player.headlampMode) + 1) % HEADLAMP_MODES.length];
      return player.headlampMode;
    },

    /**
     * Driver input for the next physics steps.
     * @param {{throttle: number, brake: number, steer: number, handbrake: number}} input
     * @param {number} boost  nitrous valve opening, 0..1
     */
    drive(input, boost) {
      throttlePedal = input.throttle;
      brakePedal = input.brake;
      vehicle.setInput(input);
      vehicle.setBoost(boost);
    },

    /** Places the car at rest on the ground point `pos`. */
    place(pos, yaw) {
      vehicle.reset(pos, yaw);
      player.groundY = pos[1];
      view.markTeleported();
      refresh(0, 0);
    },

    /**
     * After the physics step: derived values, lamp levels, and the pose of the drawn parts.
     * @param {number} dt          frame time, seconds
     * @param {number} sunElevation  radians above the horizon (the environment's sunElevation)
     * @param {number} rain        0..1
     * @param {number} cameraDistance  metres from the camera to the car
     * @param {number} [mist]      0..1: water hanging in the air (the weather's fog)
     */
    update(dt, sunElevation, rain, cameraDistance, mist = 0) {
      // Automatic headlamps come on at dusk and in rain, as the traffic's do, and go off a
      // little later than they came on so that they do not flicker at the threshold.
      if (player.headlampMode === 'auto') {
        headWanted = headWanted
          ? sunElevation < HEADLAMP_SUN_ELEVATION + HEADLAMP_OFF_MARGIN || rain > HEADLAMP_RAIN * 0.6
          : sunElevation < HEADLAMP_SUN_ELEVATION || rain > HEADLAMP_RAIN;
      } else {
        headWanted = player.headlampMode === 'on';
      }
      // Fog lamps go with the low beams and only in rain or mist, with the same kind of margin.
      const margin = fogWanted ? 0.6 : 1;
      fogWanted = headWanted && (rain > FOGLAMP_RAIN * margin || mist > FOGLAMP_MIST * margin);
      refresh(dt, rain);
      view.update(cameraDistance, vehicle.wheels);
    },

    /** This frame's lights, glows and contact shadow. */
    writeLamps(out, eye, time) {
      writeVehicleLamps(out, kit.lamps, view.matrix, lampState, eye, time, 1, 1, 1);
      m4transformPoint(centre, view.matrix, kit.colliderCentre);
      const he = kit.halfExtents;
      out.occluder(centre[0], centre[1], centre[2], quatYaw(drawnQuat), he[0], he[1], he[2]);
    },

    dispose() {
      view.dispose();
      kit.dispose();
      physics.removeVehicle(vehicle);
    },
  };

  function refresh(dt, rain) {
    player.yaw = quatYaw(vehicle.renderQuat);
    player.forwardSpeed = vehicle.speed;
    player.yawRate = vehicle.angVel[1];
    const speed = Math.abs(vehicle.speed);

    // Slip: the worst tyre decides. Surface: what most of the touching wheels stand on.
    let slip = 0, contacts = 0, rough = 0, kind = player.surfaceKind, votes = 0, groundSum = 0;
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheels[i];
      if (!w.contact) continue;
      contacts++;
      groundSum += w.surfaceY;
      slip = Math.max(slip, (Math.abs(w.slipLong) - SLIP_LONG_START) / SLIP_LONG_RANGE, (Math.abs(w.slipLat) - SLIP_LAT_START) / SLIP_LAT_RANGE);
      rough += SURFACE_ROUGHNESS[w.surfaceKind] || 0;
      let same = 0;
      for (let j = 0; j < 4; j++) if (vehicle.wheels[j].contact && vehicle.wheels[j].surfaceKind === w.surfaceKind) same++;
      if (same > votes) { votes = same; kind = w.surfaceKind; }
    }
    player.slip = speed > SLIP_MIN_SPEED ? saturate(slip) : 0;
    const planar = Math.hypot(vehicle.vel[0], vehicle.vel[2]);
    player.slipAngle = planar > SLIP_MIN_SPEED
      ? Math.atan2(vehicle.vel[0] * Math.cos(player.yaw) - vehicle.vel[2] * Math.sin(player.yaw), Math.abs(vehicle.speed))
      : 0;
    player.surfaceKind = vehicle.inWater ? KIND.WATER : kind;
    player.surface = SURFACE_NAMES[player.surfaceKind] || 'asphalt';
    if (contacts > 0) player.groundY = groundSum / contacts;
    player.roughness = contacts > 0 ? (rough / contacts) * smoothstep(1, 22, speed) : 0;

    // The car gets dusty off the road and the rain washes it.
    if (dt > 0) {
      if (contacts > 0 && (kind === KIND.SAND || kind === KIND.GRASS)) dirt = Math.min(1, dirt + speed * dt * DIRT_GAIN);
      if (rain > 0.3) dirt = Math.max(0, dirt - DIRT_WASH * rain * dt);
    }

    // Pop-up lamps: the pods swing up first and the lamps light as they arrive; switching off,
    // the lamps go dark at once and the pods fold away.
    let headTarget = headWanted ? 1 : 0;
    if (hasPods) {
      podTravel = dt > 0 ? saturate(podTravel + (headWanted ? dt : -dt) / POD_SECONDS) : headTarget;
      view.podOpen = smoothstep(0, 1, podTravel);
      if (headWanted) headTarget = smoothstep(0.6, 1, podTravel);
    }
    lampState.head = dt > 0 ? damp(lampState.head, headTarget, LAMP_HALF_LIFE, dt) : headTarget;
    // The fog lamps are wired through the headlamp switch: they light when the low beams do.
    const fogTarget = fogWanted ? headTarget : 0;
    lampState.fog = dt > 0 ? damp(lampState.fog, fogTarget, LAMP_HALF_LIFE, dt) : fogTarget;
    // Brake lamps follow the driver's foot, not the brake torque: the physics also holds a
    // stopped car on its brakes, and a parked car does not sit with its lamps lit. In reverse
    // the pedals swap roles (the throttle slows the car).
    lampState.brake = (vehicle.gear === -1 ? throttlePedal : brakePedal) > 0.02 ? 1 : 0;
    lampState.reverse = vehicle.gear === -1 ? 1 : 0;
    // Hazards while the car is being put back on its wheels.
    lampState.indicator = vehicle.recovering ? 3 : 0;
    player.headlampsOn = headWanted;
    player.fogLampsOn = fogWanted;

    view.setBodyFromQuat(drawnPos, drawnQuat);
    view.setPaint(paints[paintIndex], dirt);
    view.setLamps(lampState.head, lampState.brake, lampState.reverse, lampState.indicator, lampState.fog > 0.5);
  }

  player.setPaint(0);
  refresh(0, 0);
  return player;
}
