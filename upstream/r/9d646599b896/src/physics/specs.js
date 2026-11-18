// Vehicle specifications and surface tables for the physics module.
//
// Conventions (same as index.js): metres, seconds, kilograms, radians.
// Vehicle frame: right-handed, +Y up, +Z forward, +X to the car's LEFT.
// The vehicle origin sits on the ground, midway between the axles on the centre line,
// when the car rests at its nominal ride height. Wheel order is FL, FR, RL, RR.

/**
 * Surface and obstacle ids used by the physics module.
 * Tile colliders carry no kind (design/ARCHITECTURE.md 9.2): terrain is drivable ground whose
 * surface comes from the surface sampler (see phys.setSurfaceSampler), boxes count as
 * BUILDING, cylinders as POLE, collider meshes (bridges, ramps) as ASPHALT.
 */
export const KIND = Object.freeze({
  ASPHALT: 0,
  CONCRETE: 1, // pavement, lot paving
  SAND: 2,
  GRASS: 3,
  BUILDING: 4,
  POLE: 5,
  BARRIER: 6,
  WATER: 7,
  TRAFFIC: 8, // a traffic box
  VEHICLE: 9, // a simulated vehicle
});

/**
 * Tyre behaviour per surface kind: grip multiplier and rolling resistance coefficient.
 * Kinds 4 to 6, 8 and 9 are obstacles and are never under a wheel, the rows exist only
 * so that a lookup by any kind is safe.
 */
export const SURFACES = Object.freeze([
  { grip: 1.0, roll: 0.012 }, // 0 asphalt
  { grip: 0.95, roll: 0.014 }, // 1 concrete
  { grip: 0.6, roll: 0.11 }, // 2 sand
  { grip: 0.68, roll: 0.06 }, // 3 grass
  { grip: 0.9, roll: 0.02 }, // 4 building
  { grip: 0.9, roll: 0.02 }, // 5 pole
  { grip: 0.9, roll: 0.02 }, // 6 barrier
  { grip: 0.45, roll: 0.3 }, // 7 water (sea bed): slow and slippery
  { grip: 0.9, roll: 0.02 }, // 8 traffic
  { grip: 0.9, roll: 0.02 }, // 9 vehicle
]);

/**
 * Surface kind for a `kind` string of the world's field function (world.field(x, z).kind).
 * Anything not listed drives like asphalt.
 */
const FIELD_SURFACE = {
  road: KIND.ASPHALT, junction: KIND.ASPHALT, bridge: KIND.ASPHALT,
  pavement: KIND.CONCRETE, lot: KIND.CONCRETE, median: KIND.CONCRETE,
  beach: KIND.SAND, sand: KIND.SAND, dirt: KIND.SAND,
  park: KIND.GRASS, grass: KIND.GRASS,
  water: KIND.WATER,
};
/** @param {string} fieldKind  @returns {number} a KIND id */
export function surfaceOfField(fieldKind) {
  const k = FIELD_SURFACE[fieldKind];
  return k !== undefined ? k : KIND.ASPHALT;
}

/**
 * Geometry of a vehicle: the part of the model contract (design/ARCHITECTURE.md 10.1) that
 * physics reads. Pass the model itself; other fields are ignored.
 * @typedef {Object} VehicleGeometry
 * @property {{wheelRadiusFront: number, wheelRadiusRear: number}} dims
 * @property {{wheels: {fl: number[], fr: number[], rl: number[], rr: number[]}}} anchors
 *           wheel centres at static ride height, vehicle frame
 * @property {{halfExtents: number[], centre: number[]}} collider   bounding box, vehicle frame
 */

/**
 * Tuning of a vehicle. Geometry is not part of it: it comes from the model
 * (createVehicle(spec, model)); `model` below is only the stand-in used without one.
 * @typedef {Object} VehicleSpec
 * @property {string} name
 * @property {'front'|'mid'|'rear'} layout  engine position, for the Garage
 * @property {string} engineName           short description of the engine, for the Garage
 * @property {number} mass                 kg, whole car
 * @property {number[]} inertia            principal inertia [pitch about X, yaw about Y, roll about Z], kg m^2
 * @property {number} weightFront          share of the weight on the front axle, 0..1
 * @property {number} comHeight            height of the centre of mass above the road, m
 * @property {{clearance: number, chamfer: number, friction: number, restitution: number}} chassis
 * @property {number} wheelInertia         kg m^2 per wheel
 * @property {Object} suspension           see HERO_SPEC for the fields
 * @property {Object} tyre                 see HERO_SPEC
 * @property {Object} engine               see HERO_SPEC
 * @property {number[]} gears              forward ratios, first to last
 * @property {number} reverse              reverse ratio (positive number)
 * @property {number} finalDrive
 * @property {number} efficiency           drivetrain efficiency 0..1
 * @property {'rwd'|'awd'} drivetrain
 * @property {Object} gearbox              see HERO_SPEC
 * @property {Object} brakes               see HERO_SPEC
 * @property {Object} steer                see HERO_SPEC
 * @property {Object} aero                 see HERO_SPEC
 * @property {Object} aids                 see HERO_SPEC
 * @property {Object} stability            see HERO_SPEC
 * @property {VehicleGeometry} model       default geometry
 */

/**
 * Builds the physics part of a model record from plain dimensions.
 * @returns {VehicleGeometry}
 */
function boxModel(length, width, height, wheelbase, trackFront, trackRear, radiusFront, radiusRear, clearance, centreZ = 0) {
  const zf = wheelbase / 2, zr = -wheelbase / 2;
  return {
    dims: {
      length, width, height, wheelbase, trackFront, trackRear,
      wheelRadiusFront: radiusFront, wheelRadiusRear: radiusRear,
      groundClearance: clearance, frontAxleZ: zf, rearAxleZ: zr,
    },
    anchors: {
      wheels: {
        fl: [trackFront / 2, radiusFront, zf], fr: [-trackFront / 2, radiusFront, zf],
        rl: [trackRear / 2, radiusRear, zr], rr: [-trackRear / 2, radiusRear, zr],
      },
    },
    collider: {
      halfExtents: [width / 2, (height - clearance) / 2, length / 2],
      centre: [0, (height + clearance) / 2, centreZ],
    },
  };
}

/**
 * The hero car: a 1980s mid-engine V12 wedge supercar.
 * About 1490 kg, 455 hp at 7000 rpm, rear wheel drive, 5 gears plus a nitrous-only overdrive.
 * Targets: top speed about 295 km/h, 0 to 100 km/h about 4.8 s.
 * @type {VehicleSpec}
 */
export const HERO_SPEC = {
  name: 'hero',
  layout: 'mid', // where the engine sits: 'front', 'mid' or 'rear' (shown in the Garage)
  engineName: 'V12', // shown in the Garage
  mass: 1490,
  // Roll inertia is on the generous side of realistic. It slows roll response a little
  // and costs nothing in feel.
  inertia: [1850, 2150, 640],
  // Mid engine: 41 percent of the weight on the front axle, 59 on the rear. Low centre of mass.
  weightFront: 0.41,
  comHeight: 0.4,
  chassis: {
    // The collision shape is a convex hull fitted inside the model's bounding box.
    clearance: 0.2, // its floor is lifted to this height: kerbs and ramp feet pass under it
    chamfer: 0.45, // length over which the floor rises to the bumpers: rides up instead of digging in
    friction: 0.22, // body panels slide along walls instead of grabbing
    restitution: 0.05,
  },
  wheelInertia: 1.6,
  suspension: {
    restLength: 0.3, // hardpoint to wheel centre at full droop
    travel: 0.18, // full droop to bump stop
    stiffness: { front: 40000, rear: 66000 }, // N/m at the wheel: about 1.8 Hz front, 2.0 Hz rear
    bump: { front: 3600, rear: 5400 }, // N s/m while compressing
    rebound: { front: 5000, rear: 7400 }, // N s/m while extending: firmer, kills bounce
    antiRoll: { front: 26000, rear: 12000 }, // N per metre of left/right travel difference
    bumpStop: 5, // extra stiffness (multiple of spring rate) past full travel
    maxForce: 6, // clamp, as a multiple of the wheel's static load
  },
  tyre: {
    mu: { front: 1.21, rear: 1.31 }, // peak friction coefficient, dry asphalt
    peakSlipRatio: 0.1, // longitudinal slip at peak grip
    peakSlipAngle: 0.14, // rad (8 degrees), slip angle at peak grip
    shape: 1.4, // falloff past the peak: 1.0 none, 1.4 keeps about 81 percent when fully sliding
    loadSensitivity: 0.1, // grip lost per unit of extra relative load
    forceHeight: 0.04, // tyre forces act this far above the road: less body roll and dive
  },
  engine: {
    // Crankshaft torque. 463 Nm at 7000 rpm is 455 hp.
    torqueCurve: [
      [1000, 310], [2000, 385], [3000, 440], [4000, 478], [5200, 500],
      [6000, 490], [7000, 463], [7500, 428], [8000, 350],
    ],
    idle: 1000,
    redline: 7500,
    inertia: 0.3, // kg m^2, engine plus flywheel, reflected to the wheels through the gears
    brakeBase: 25, // Nm of engine braking at idle
    brakeSlope: 75, // extra Nm of engine braking at the redline
    launchRpm: 4200, // the clutch slips at up to this speed when pulling away at full throttle
    launchRise: 0.2, // at standstill the revs sit this fraction below launchRpm and climb to it
  },
  // Top speed is reached in fifth. Sixth is an overdrive that only nitrous can pull.
  gears: [2.232, 1.625, 1.086, 0.858, 0.707, 0.61],
  reverse: 1.96,
  finalDrive: 4.09,
  efficiency: 0.84,
  drivetrain: 'rwd',
  gearbox: {
    shiftTime: 0.28, // torque cut on an upshift
    downshiftTime: 0.1,
    cooldown: 0.35, // minimum time between shifts
    liftHold: 1.0, // s a lifted pedal must stay lifted before the box shifts up for it
    upRpm: 0.95, // upshift at this fraction of the redline at full throttle
    upRpmCruise: 0.5, // and at this fraction with the throttle closed
    lsd: 90, // limited slip: Nm per rad/s of speed difference across the driven axle
    lsdMax: 900, // Nm
    reverseMaxSpeed: 14, // m/s
    overdrive: 1, // this many top gears are only used while nitrous is flowing
  },
  boost: {
    force: 0.45, // nitrous: extra engine torque, as a share, at full flow
    minRpm: 2500, // no flow below this engine speed
    rise: 5, // per second: full flow builds up in 0.2 s
    fall: 12, // per second: and is cut in under 0.1 s
  },
  brakes: {
    torque: 5300, // Nm total at full pedal, enough to lock all four on dry asphalt
    bias: 0.62, // share on the front axle
    handbrake: 5200, // Nm on the rear axle
  },
  steer: {
    maxAngle: 0.6, // rad at parking speed
    rate: 3.2, // full lock is reached in about 0.3 s
    centreRate: 4.5, // self centring speed when the key is released
    lateralRef: 10.2, // m/s^2 the lock is scaled for at speed
    slipAllowance: 0.85, // extra lock at speed, as a fraction of the peak slip angle
    counterSteer: 0.75, // how much the front wheels follow the direction of travel in a slide
  },
  aero: {
    cdA: 0.8, // drag area, m^2
    clA: 0.55, // downforce area, m^2
    balance: 0.42, // share of the downforce on the front axle
  },
  aids: {
    tc: 1, // traction control strength 0..1
    tcSlip: 0.07, // slip ratio where it starts to cut torque
    abs: 1, // 0 or 1
    absSlip: 0.12, // slip ratio where the brakes start to release
    stability: 1, // yaw assist strength 0..1
    slideAngle: 0.2, // rad of rear slip angle allowed before the yaw assist acts
    driftAngle: 0.7, // same while drifting (after a handbrake entry)
    handbrakeAngle: 1.0, // same while the handbrake is held
    snapDamping: 4, // how strongly a collapsing slide is slowed down (1/s)
  },
  stability: {
    rollLimit: 0.07, // rad (4 degrees) of roll before the upright torque starts
    pitchLimit: 0.08, // rad
    uprightStiffness: 60, // rad/s^2 per rad beyond the limit
    uprightDamping: 10, // 1/s
    airStiffness: 14, // levelling in the air
    airDamping: 6,
    airGravity: 0.9, // extra gravity (in g) while no wheel touches the ground
    maxSpeed: 115, // m/s, hard clamp
    maxRiseSpeed: 7, // m/s, hard clamp on upward velocity
    maxRollRate: 2.5, // rad/s, roll and pitch
    maxYawRate: 5, // rad/s
    recoverAngle: 1.05, // rad (60 degrees) of tilt that triggers the auto recover
  },
  // Stand-in geometry with the numbers of design/brief/hero-car.md, used when createVehicle
  // gets no model: 4.14 x 2.0 x 1.07 m, wheelbase 2.45 m, tracks 1.536 / 1.606 m,
  // tyre radius 0.303 / 0.311 m, the body sits 0.09 m ahead of the wheelbase centre.
  model: boxModel(4.14, 2.0, 1.07, 2.45, 1.536, 1.606, 0.303, 0.311, 0.125, 0.09),
};

// Traffic classes: [width, height, length], mass, power (kW), wheel radius, top speed (km/h).
const TRAFFIC = {
  compact: { size: [1.68, 1.42, 3.9], mass: 1050, power: 60, radius: 0.29, top: 160 },
  sedan: { size: [1.85, 1.42, 5.0], mass: 1600, power: 105, radius: 0.33, top: 180 },
  coupe: { size: [1.8, 1.35, 4.8], mass: 1500, power: 115, radius: 0.33, top: 190 },
  wagon: { size: [1.9, 1.48, 5.3], mass: 1800, power: 110, radius: 0.34, top: 170 },
  pickup: { size: [1.95, 1.8, 5.3], mass: 2000, power: 120, radius: 0.37, top: 160 },
  van: { size: [1.98, 2.05, 5.1], mass: 2200, power: 110, radius: 0.36, top: 150 },
  taxi: { size: [1.85, 1.47, 5.0], mass: 1650, power: 105, radius: 0.33, top: 175 },
  police: { size: [1.88, 1.5, 5.2], mass: 1750, power: 145, radius: 0.34, top: 200 },
  sports: { size: [1.78, 1.25, 4.4], mass: 1400, power: 150, radius: 0.32, top: 225 },
  bus: { size: [2.5, 3.1, 11.5], mass: 11000, power: 160, radius: 0.5, top: 100 },
  truck: { size: [2.45, 3.3, 8.0], mass: 8000, power: 150, radius: 0.48, top: 110 },
};
TRAFFIC.hatch = TRAFFIC.compact;

/**
 * A simple, stable specification for a traffic vehicle.
 * Traffic normally runs as traffic boxes (phys.createKinematicBox), which only read the
 * geometry and the mass. The full spec also works with phys.createVehicle.
 * @param {'compact'|'hatch'|'sedan'|'coupe'|'wagon'|'pickup'|'van'|'taxi'|'police'|'sports'|'bus'|'truck'} kind
 * @param {VehicleGeometry} [model]  the traffic model (10.1); without it a box of typical size is used
 * @returns {VehicleSpec}
 */
export function trafficSpec(kind, model) {
  const t = TRAFFIC[kind];
  if (!t) throw new Error('trafficSpec: unknown kind ' + kind);
  let [w, hgt, len] = t.size;
  let r = t.radius;
  if (model) {
    const he = model.collider.halfExtents;
    w = he[0] * 2;
    len = he[2] * 2;
    hgt = model.collider.centre[1] + he[1];
    r = model.dims.wheelRadiusRear;
  } else {
    model = boxModel(len, w, hgt, len * 0.6, w - 0.28, w - 0.28, r, r, 0.2);
  }
  const m = t.mass;
  const comHeight = Math.min(0.3 + hgt * 0.18, 1.0);
  // Corner mass and spring rate for a ride frequency of 1.5 Hz with firm damping.
  const corner = m / 4;
  const k = corner * (2 * Math.PI * 1.5) ** 2;
  const c = 2 * 0.75 * Math.sqrt(k * corner);
  // Flat torque curve sized for the stated power at 5000 rpm.
  const peak = (t.power * 1000) / (5000 * 0.10472);
  // Final drive so that the top speed is reached at 5200 rpm in top gear.
  const topGear = 0.8;
  const finalDrive = (5200 * 0.10472 * r) / ((t.top / 3.6) * topGear);
  return {
    name: kind,
    mass: m,
    inertia: [
      (m / 12) * (hgt * hgt + len * len) * 0.85,
      (m / 12) * (w * w + len * len) * 0.85,
      (m / 12) * (w * w + hgt * hgt) * 1.1,
    ],
    weightFront: 0.5,
    comHeight,
    chassis: { clearance: 0.25, chamfer: 0.4, friction: 0.25, restitution: 0.05 },
    wheelInertia: 1.2 + m / 2500,
    suspension: {
      restLength: 0.32,
      travel: 0.2,
      stiffness: { front: k, rear: k },
      bump: { front: c * 0.85, rear: c * 0.85 },
      rebound: { front: c * 1.15, rear: c * 1.15 },
      antiRoll: { front: k * 0.5, rear: k * 0.3 },
      bumpStop: 5,
      maxForce: 6,
    },
    tyre: {
      mu: { front: 0.9, rear: 0.98 },
      peakSlipRatio: 0.12,
      peakSlipAngle: 0.16,
      shape: 1.3,
      loadSensitivity: 0.1,
      forceHeight: Math.min(comHeight * 0.5, 0.4),
    },
    engine: {
      torqueCurve: [
        [800, peak * 0.7], [2000, peak * 0.95], [3500, peak * 1.05],
        [5000, peak], [5800, peak * 0.8], [6200, peak * 0.5],
      ],
      idle: 800,
      redline: 5800,
      inertia: 0.2 + m / 20000,
      brakeBase: peak * 0.06,
      brakeSlope: peak * 0.18,
      launchRpm: 2200,
      launchRise: 0.2,
    },
    gears: [3.4, 2.0, 1.35, 1.0, topGear],
    reverse: 3.2,
    finalDrive,
    efficiency: 0.84,
    drivetrain: 'awd',
    gearbox: {
      shiftTime: 0.3, downshiftTime: 0.2, cooldown: 0.6, liftHold: 1.0,
      upRpm: 0.9, upRpmCruise: 0.45, lsd: 60, lsdMax: 600, reverseMaxSpeed: 8,
    },
    brakes: { torque: m * 9.81 * 1.1 * r, bias: 0.62, handbrake: m * 9.81 * 0.6 * r },
    steer: {
      maxAngle: 0.55, rate: 2.5, centreRate: 3.5, lateralRef: 7.5,
      slipAllowance: 0.6, counterSteer: 0.6,
    },
    aero: { cdA: 0.32 * w * hgt * 0.85, clA: 0, balance: 0.5 },
    aids: {
      tc: 1, tcSlip: 0.1, abs: 1, absSlip: 0.12,
      stability: 1, slideAngle: 0.12, driftAngle: 0.3, handbrakeAngle: 0.5, snapDamping: 4,
    },
    stability: {
      rollLimit: 0.06, pitchLimit: 0.07,
      uprightStiffness: 60, uprightDamping: 10,
      airStiffness: 14, airDamping: 6, airGravity: 0.9,
      maxSpeed: 70, maxRiseSpeed: 6, maxRollRate: 2, maxYawRate: 3,
      recoverAngle: 1.05,
    },
    model,
  };
}

// ---------------------------------------------------------------------------------------
// The other player cars. Each is written as its differences from the hero car: `car()`
// copies HERO_SPEC and replaces what is given, one level deep (a section such as `tyre`
// keeps the hero's fields that are not named, a value inside a section is replaced whole).
// What stays the same on every car is what keeps a car on its wheels: the chassis hull,
// the upright and airborne stability, the speed and rate clamps.
// ---------------------------------------------------------------------------------------

function car(changes) {
  const out = {};
  for (const key in HERO_SPEC) {
    const base = HERO_SPEC[key], change = changes[key];
    if (change === undefined) out[key] = base;
    else if (typeof base === 'object' && !Array.isArray(base) && key !== 'model') out[key] = { ...base, ...change };
    else out[key] = change;
  }
  return out;
}

/**
 * Tirreno: a mid-engined flat-twelve grand tourer. About 390 hp, 1500 kg, five long gears.
 * Wide rear track, long wheelbase, much yaw inertia: very stable at speed, heavier and
 * slower steering than the hero car, and a rear that lets go gently.
 * @type {VehicleSpec}
 */
const TIRRENO_SPEC = car({
  name: 'tirreno',
  layout: 'mid',
  engineName: 'Flat-twelve',
  mass: 1500,
  inertia: [2050, 2650, 700],
  weightFront: 0.42,
  comHeight: 0.42,
  suspension: {
    stiffness: { front: 32000, rear: 53000 }, // about 1.6 Hz front, 1.75 Hz rear: a tourer
    bump: { front: 3200, rear: 4700 },
    rebound: { front: 4500, rear: 6700 },
    antiRoll: { front: 25000, rear: 11000 },
  },
  tyre: {
    mu: { front: 1.15, rear: 1.29 }, // a little less bite than the hero car, more of it at the rear
    peakSlipAngle: 0.165, // the tyres build grip over a wider angle: slower to answer
    shape: 1.28, // and lose little past the peak: the slide comes on gently
  },
  engine: {
    // Crankshaft torque. 441 Nm at 6300 rpm is 390 hp. Broad and flat from 3000 rpm.
    torqueCurve: [
      [950, 300], [2000, 392], [3000, 452], [4500, 490], [5500, 472],
      [6300, 441], [6800, 400], [7300, 320],
    ],
    idle: 950,
    redline: 6800,
    inertia: 0.34,
    brakeBase: 25,
    brakeSlope: 70,
    launchRpm: 3600,
  },
  // Long legs: second runs to about 130 km/h, top speed comes at the power peak in fifth
  // with revs to spare, which is where the nitrous goes.
  gears: [3.139, 2.014, 1.526, 1.167, 0.875],
  reverse: 2.53,
  finalDrive: 3.21,
  gearbox: { shiftTime: 0.32, overdrive: 0 },
  steer: {
    rate: 2.0, // heavy steering: full lock takes half a second
    centreRate: 3.5,
    lateralRef: 9.6,
  },
  aero: { cdA: 0.8, clA: 0.5, balance: 0.4 },
  aids: { slideAngle: 0.17, snapDamping: 5 },
  // Stand-in geometry, taken from the dimensions of the car's model:
  // 4.485 x 1.976 x 1.13 m, wheelbase 2.55 m, tracks 1.518 / 1.66 m.
  model: boxModel(4.485, 1.976, 1.13, 2.55, 1.518, 1.66, 0.316, 0.331, 0.15, 0.118),
});

/**
 * Silvretta: a rear-engined turbocharged flat-six. About 300 hp, 1300 kg, four long gears.
 * 38 percent of the weight on the front axle and the engine behind the rear one: it puts
 * its power down better than anything else here. Little happens below 3000 rpm, then
 * the boost arrives. Lifting off in a bend tightens the line.
 * @type {VehicleSpec}
 */
const SILVRETTA_SPEC = car({
  name: 'silvretta',
  layout: 'rear',
  engineName: 'Turbo flat-six',
  mass: 1300,
  inertia: [1550, 1800, 520], // short, but with the engine hung out at the back
  weightFront: 0.38,
  comHeight: 0.47,
  suspension: {
    stiffness: { front: 28500, rear: 57500 }, // about 1.7 Hz front, 1.9 Hz rear
    bump: { front: 2750, rear: 5000 },
    rebound: { front: 3800, rear: 6900 },
    antiRoll: { front: 23000, rear: 8000 },
  },
  tyre: {
    mu: { front: 1.2, rear: 1.3 }, // narrow fronts with little weight on them, wide rears
    peakSlipAngle: 0.14,
    shape: 1.36,
  },
  engine: {
    // Crankshaft torque on full boost. 372 Nm at 5750 rpm is 300 hp.
    torqueCurve: [
      [950, 236], [2000, 290], [3000, 360], [4000, 412], [4500, 418],
      [5750, 372], [6300, 330], [6800, 280], [7300, 215],
    ],
    idle: 950,
    redline: 6800,
    inertia: 0.26,
    // Strong engine braking on the driven rear wheels: with so little weight on the nose,
    // this is what turns the car in when the pedal is lifted in a bend.
    brakeBase: 40,
    brakeSlope: 140,
    launchRpm: 4500, // pulls away with the revs up, on boost
    // One large turbocharger. Off boost the engine gives `offBoost` of the curve above.
    // Boost builds between startRpm and fullRpm with the pedal down, after a lag.
    turbo: {
      offBoost: 0.64,
      startRpm: 2600,
      fullRpm: 3600,
      rise: 1.5, // per second: two thirds of a second from nothing to full boost
      fall: 7, // per second: gone at once on a lift and through an upshift
    },
  },
  // Four gears, far apart. First is short and uses the traction; the step to second
  // drops the engine to 3500 rpm with the boost gone, and then it comes back.
  gears: [2.6, 1.42, 0.95, 0.66],
  reverse: 2.8,
  finalDrive: 4.222,
  gearbox: { shiftTime: 0.32, overdrive: 0 },
  brakes: { torque: 4700, bias: 0.56, handbrake: 4600 }, // the rear tyres carry the weight, and brake with it
  steer: {
    rate: 3.4, // light nose: quick, light steering
    centreRate: 4.5,
    lateralRef: 9.8,
  },
  aero: { cdA: 0.78, clA: 0.42, balance: 0.36 },
  aids: { slideAngle: 0.18, snapDamping: 5 },
  // Stand-in geometry with the numbers of design/brief/silvretta.md: 4.291 x 1.775 x 1.31 m,
  // wheelbase 2.272 m, tracks 1.432 / 1.492 m, tyre radius 0.316 / 0.313 m, the body
  // sits 0.085 m behind the wheelbase centre (the engine hangs out at the back).
  model: boxModel(4.291, 1.775, 1.31, 2.272, 1.432, 1.492, 0.316, 0.313, 0.125, -0.085),
});

/**
 * Thunderhead: a front-engined 5.7 litre V8, rear drive. About 245 hp but a wall of
 * torque from idle, 1450 kg, four gears, a low redline. Weight split evenly, wide tyres
 * of one size all round, stiff anti-roll bars: it corners flat, and the throttle steers it.
 * @type {VehicleSpec}
 */
const THUNDERHEAD_SPEC = car({
  name: 'thunderhead',
  layout: 'front',
  engineName: 'V8',
  mass: 1450,
  inertia: [1950, 2300, 620],
  weightFront: 0.5,
  comHeight: 0.44,
  suspension: {
    stiffness: { front: 52000, rear: 57000 }, // about 1.9 Hz front, 2.0 Hz rear: firm
    bump: { front: 4500, rear: 4700 },
    rebound: { front: 6200, rear: 6600 },
    antiRoll: { front: 40000, rear: 22000 }, // stiff bars: it corners flat
  },
  tyre: {
    mu: { front: 1.21, rear: 1.25 }, // the same wide tyre on all four corners, set up to push at the limit
    peakSlipAngle: 0.13,
    shape: 1.45,
  },
  engine: {
    // Crankshaft torque. 406 Nm at 4300 rpm is 245 hp; the peak is 480 Nm at 3000 rpm.
    torqueCurve: [
      [750, 385], [1500, 445], [2400, 476], [3000, 480], [3600, 455],
      [4300, 406], [5000, 335], [5500, 275], [6000, 200],
    ],
    idle: 750,
    redline: 5500,
    inertia: 0.42, // a heavy flywheel
    brakeBase: 35,
    brakeSlope: 80,
    launchRpm: 2600,
  },
  // Four gears with wide gaps, which the torque fills. Fourth is tall.
  gears: [2.88, 1.75, 1.15, 0.745],
  reverse: 2.78,
  finalDrive: 3.07,
  gearbox: { shiftTime: 0.34, upRpm: 0.93, lsd: 120, lsdMax: 1100, overdrive: 0 },
  brakes: { torque: 5200, bias: 0.66, handbrake: 5000 },
  steer: {
    rate: 3.0,
    centreRate: 4.5,
    lateralRef: 10,
  },
  aero: { cdA: 0.78, clA: 0.3, balance: 0.45 },
  // The traction control lets the rear tyres spin further before it steps in, and in slow
  // corners the yaw assist allows a wide slide: the tail comes out on the throttle, and
  // comes back. At speed the allowance narrows to that of the other cars.
  aids: {
    tc: 0.55, tcSlip: 0.16, snapDamping: 4.5,
    slideAngle: 0.34, // rad, up to slideFadeFrom
    slideAngleFast: 0.17, // rad, from slideFadeTo
    slideFadeFrom: 22, // m/s
    slideFadeTo: 42, // m/s
  },
  // Stand-in geometry with the numbers of the car's model: 4.483 x 1.803 x 1.186 m,
  // wheelbase 2.443 m, tracks 1.514 / 1.534 m, tyre radius 0.331 m at both ends.
  model: boxModel(4.483, 1.803, 1.186, 2.443, 1.514, 1.534, 0.331, 0.331, 0.119, 0.009),
});

/** The player cars that have a spec, in the order of src/vehicles/cars.js. */
export const CAR_IDS = Object.freeze(['lucera', 'tirreno', 'silvretta', 'thunderhead']);

const CAR_SPECS = {
  lucera: HERO_SPEC,
  tirreno: TIRRENO_SPEC,
  silvretta: SILVRETTA_SPEC,
  thunderhead: THUNDERHEAD_SPEC,
};

/**
 * The tuning of a player car by its id (src/vehicles/cars.js). An unknown id gives the
 * Lucera, so that a car that has no tuning yet can always be driven. The same object is
 * returned on every call: treat it as read-only.
 * @param {string} id
 * @returns {VehicleSpec}
 */
export function carSpec(id) {
  return CAR_SPECS[id] || HERO_SPEC;
}

// ---------------------------------------------------------------------------------------
// Garage statistics. Nothing here is typed in: the figures are worked out from the spec.
// Power and torque are read off the torque curve. 0 to 100 km/h comes from a straight-line
// run of the same drivetrain rules that vehicle.js applies (clutch slip when pulling away,
// the automatic gearbox and its torque cut, turbo lag, the rev limiter, the grip of the
// driven tyres with weight transfer and downforce, drag and rolling resistance), reduced
// to one dimension. Top speed is where drive and resistance balance in the last gear the
// box reaches. Together they cost a fraction of a millisecond per car, once.
// test/physics checks both against the full simulation for every car.
// ---------------------------------------------------------------------------------------

const RAD_TO_RPM = 60 / (2 * Math.PI);
const AIR_DENSITY = 1.2;
const GRAVITY = 9.81;
// Share of the peak tyre force that the traction control holds on to in a full throttle
// start (it lets the tyres slip a little past their peak and trims the throttle in pulses).
const LAUNCH_GRIP = 0.95;

function torqueAt(curve, rpm) {
  const n = curve.length;
  if (rpm <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < n; i++) {
    if (rpm <= curve[i][0]) {
      const a = curve[i - 1], b = curve[i];
      return a[1] + ((b[1] - a[1]) * (rpm - a[0])) / (b[0] - a[0]);
    }
  }
  return curve[n - 1][1];
}

/** Road resistance at speed v on flat asphalt: air drag plus rolling resistance, N. */
function resistance(spec, v) {
  const aero = spec.aero;
  const down = 0.5 * AIR_DENSITY * aero.clA * v * v;
  const roll = SURFACES[KIND.ASPHALT].roll * (spec.mass * GRAVITY + down) * Math.min(1, v);
  return 0.5 * AIR_DENSITY * aero.cdA * v * v + roll;
}

/**
 * Full throttle from rest on flat asphalt, without nitrous, in one dimension.
 * @returns {number} seconds to 100 km/h
 */
function zeroTo100(spec) {
  const eng = spec.engine, gb = spec.gearbox, tyre = spec.tyre, aero = spec.aero, tb = eng.turbo;
  const dims = spec.model.dims;
  const awd = spec.drivetrain === 'awd';
  const r = dims.wheelRadiusRear, rf = dims.wheelRadiusFront;
  const normalGears = spec.gears.length - (gb.overdrive || 0);
  // Weight on the driven tyres at rest, and how much of each newton of drive is added to it.
  const rest = spec.mass * GRAVITY * (awd ? 1 : 1 - spec.weightFront);
  const transfer = awd ? 0 : (spec.comHeight - tyre.forceHeight) / dims.wheelbase;
  const mu = awd ? (tyre.mu.front + tyre.mu.rear) * 0.5 : tyre.mu.rear;
  const wheels = 2 * spec.wheelInertia * (1 / (r * r) + 1 / (rf * rf));
  const h = 1 / 120;

  let v = 0, t = 0, rpm = eng.idle, gear = 1, shift = 0, cooldown = 0, turbo = 0;
  while (v < 100 / 3.6 && t < 60) {
    const ratio = spec.gears[gear - 1] * spec.finalDrive;
    const wheelRpm = (v / r) * ratio * RAD_TO_RPM;
    if (shift > 0) shift -= h;
    if (cooldown > 0) cooldown -= h;
    if (cooldown <= 0 && gear < normalGears && wheelRpm > eng.redline * gb.upRpm) {
      gear++;
      shift = gb.shiftTime;
      cooldown = gb.cooldown;
      continue;
    }
    let torque = 0, locked = false;
    if (shift > 0) {
      // Gear change: no drive, the revs travel to the new gear's speed.
      const target = wheelRpm > eng.idle ? wheelRpm : eng.idle;
      rpm += (target - rpm) * Math.min(1, h / (shift + h));
    } else {
      const slipRpm = gear === 1 ? eng.launchRpm : eng.idle;
      if (wheelRpm < slipRpm) {
        // Pulling away: the clutch slips and the engine sits in its power band.
        const target = slipRpm - (slipRpm - wheelRpm) * (eng.launchRise || 0);
        rpm += (target - rpm) * Math.min(1, 12 * h);
        torque = torqueAt(eng.torqueCurve, rpm);
      } else {
        locked = true;
        rpm = wheelRpm;
        torque = torqueAt(eng.torqueCurve, rpm) * Math.min(1, Math.max(0, (eng.redline + 50 - rpm) / 100));
      }
    }
    if (tb) {
      const want = shift > 0 ? 0 : Math.min(1, Math.max(0, (rpm - tb.startRpm) / (tb.fullRpm - tb.startRpm)));
      const step = (want > turbo ? tb.rise : tb.fall) * h;
      turbo = want > turbo ? Math.min(want, turbo + step) : Math.max(want, turbo - step);
      torque *= tb.offBoost + (1 - tb.offBoost) * turbo;
    }
    let force = (torque * ratio * spec.efficiency) / r;
    // What the driven tyres can put down: their load grows with the drive force itself,
    // and a tyre loaded beyond its static load grips a little less per newton.
    const load = rest + 0.5 * AIR_DENSITY * aero.clA * v * v * (awd ? 1 : 1 - aero.balance);
    let limit = (mu * load) / (1 - mu * transfer);
    const rel = (load + limit * transfer) / rest - 1;
    const muLoaded = mu * Math.min(1.1, Math.max(0.75, 1 - tyre.loadSensitivity * rel));
    limit = (LAUNCH_GRIP * muLoaded * load) / (1 - muLoaded * transfer);
    if (force > limit) force = limit;
    const inertia = spec.mass + wheels + (locked ? (eng.inertia * ratio * ratio) / (r * r) : 0);
    v += ((force - resistance(spec, v)) / inertia) * h;
    if (v < 0) v = 0;
    t += h;
  }
  return t;
}

/**
 * Top speed on flat asphalt without nitrous: the speed at which the drive force of the
 * gear the automatic box ends up in equals the road resistance (or the rev limiter).
 * @returns {number} m/s
 */
function topSpeed(spec) {
  const eng = spec.engine, gb = spec.gearbox;
  const r = spec.model.dims.wheelRadiusRear;
  const normalGears = spec.gears.length - (gb.overdrive || 0);
  for (let gear = 1; ; gear++) {
    const ratio = spec.gears[gear - 1] * spec.finalDrive;
    const rpmPerSpeed = (ratio * RAD_TO_RPM) / r;
    // Drive minus resistance falls with speed in the upper part of a gear and is negative
    // on the limiter: the crossing is found by halving the interval.
    let lo = eng.idle / rpmPerSpeed, hi = (eng.redline + 50) / rpmPerSpeed;
    for (let i = 0; i < 40; i++) {
      const v = (lo + hi) * 0.5;
      const rpm = v * rpmPerSpeed;
      const torque = torqueAt(eng.torqueCurve, rpm) * Math.min(1, Math.max(0, (eng.redline + 50 - rpm) / 100));
      if ((torque * ratio * spec.efficiency) / r > resistance(spec, v)) lo = v;
      else hi = v;
    }
    // The box takes the next gear if this one gets as far as its shift point.
    if (gear >= normalGears || lo * rpmPerSpeed <= eng.redline * gb.upRpm) return lo;
  }
}

const DESCRIBED = new WeakMap();

/**
 * The figures the Garage shows for a car, worked out from its spec (see above). Plain
 * numbers and enums, no formatted text. The result is frozen and kept: the first call for
 * a spec costs a fraction of a millisecond, later calls return the same object.
 * @param {VehicleSpec} spec  as returned by carSpec(id)
 * @returns {{
 *   powerKw: number, powerHp: number, powerRpm: number, torqueNm: number, torqueRpm: number,
 *   massKg: number, topSpeedKmh: number, zeroTo100: number, zeroToHundred: number,
 *   engine: 'front'|'mid'|'rear', drive: 'rwd'|'awd', layoutLabel: string, engineName: string,
 *   gears: number, redline: number, turbo: boolean, nitrous: boolean,
 * }}
 */
export function describeSpec(spec) {
  let out = DESCRIBED.get(spec);
  if (out) return out;
  const eng = spec.engine;
  // Peak power and torque, sampled along the curve up to the redline.
  let watts = 0, powerRpm = 0, torqueNm = 0, torqueRpm = 0;
  for (let rpm = eng.idle; rpm <= eng.redline; rpm += 50) {
    const torque = torqueAt(eng.torqueCurve, rpm);
    const w = (torque * rpm) / RAD_TO_RPM;
    if (w > watts) { watts = w; powerRpm = rpm; }
    if (torque > torqueNm) { torqueNm = torque; torqueRpm = rpm; }
  }
  const seconds = Math.round(zeroTo100(spec) * 10) / 10;
  const engine = spec.layout || 'front';
  const drive = spec.drivetrain === 'awd' ? 'awd' : 'rwd';
  const place = engine === 'mid' ? 'Mid-engined' : engine === 'rear' ? 'Rear-engined' : 'Front-engined';
  out = Object.freeze({
    powerKw: Math.round(watts / 100) / 10,
    powerHp: Math.round(watts / 745.7),
    powerRpm,
    torqueNm: Math.round(torqueNm),
    torqueRpm,
    massKg: spec.mass,
    topSpeedKmh: Math.round(topSpeed(spec) * 3.6),
    zeroTo100: seconds,
    zeroToHundred: seconds, // the same figure under its other name
    engine,
    drive,
    layoutLabel: `${place}, ${drive === 'awd' ? 'all-wheel drive' : 'rear-wheel drive'}`,
    engineName: spec.engineName || '',
    gears: spec.gears.length - (spec.gearbox.overdrive || 0),
    redline: eng.redline,
    turbo: !!eng.turbo,
    nitrous: !!spec.boost,
  });
  DESCRIBED.set(spec, out);
  return out;
}
