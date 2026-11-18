// Traffic drivers: the part of traffic that is pure simulation. No physics, no rendering.
//
// Every driver follows the lane graph on rails (a station along a lane) and chooses its speed
// with the intelligent driver model: accelerate towards a desired speed, keep a time gap to
// whatever is ahead. "Whatever is ahead" is a list of things reduced to one form, a gap and
// the speed of the thing at the end of it:
//   - the next vehicle along the driver's own path;
//   - a vehicle that has just branched off onto a sibling lane and is not clear yet;
//   - a vehicle on another lane that will merge in ahead of the driver;
//   - a stop line the driver may not cross yet (red signal, stop sign, junction not free);
//   - an obstacle that is not traffic (the player's car, a wreck), found by sampling the path.
//
// Junctions are crossed by reservation. A driver may only pass the stop line once the junction
// has granted it its connector lane, and a grant is only given when no vehicle that already
// holds one is on a conflicting connector and there is room to leave the junction on the far
// side. Requests are served in a strict order of priority, so two drivers can never wait for
// each other, and a vehicle never stops inside a junction because of other traffic. The line
// is where the lane graph says a vehicle is out of everybody else's way (`lane.holdBack`),
// which at an awkward junction is some way before the end of the lane.

import { clamp, hash01 } from '../core/math.js';
import { TURN, COMFORT_BRAKING, samplePoint, comfortSpeed } from './lanes.js';
import { SIGNAL, signalState } from './signals.js';

// Driver model.
const STANDSTILL_GAP = 2.0; // m between bumpers in a queue
const COMFORT_DECEL = 2.0; // m/s^2, the "b" of the model
const MAX_DECEL = 7.0; // m/s^2: hardest braking a driver will use
const OVERSPEED_DECEL = 3.0; // m/s^2: limit on braking that is only due to a lower desired speed
const MIN_GAP = 0.1; // m: gaps are never taken as smaller than this
const HARD_GAP = 0.25; // m: a vehicle is never moved closer than this to what it follows

// Junction approach.
const STOP_SHORT = 0.5; // m between the front bumper and the stop line when waiting
const SIGNAL_GO_SECONDS = 2.6; // on amber: go if the line is closer than this many seconds
const REQUEST_SECONDS = 4.0; // ask for the junction this long before reaching it
const REQUEST_MARGIN = 8; // m added to that
const SIGNAL_REQUEST_MARGIN = 4;
const SET_OFF_SECONDS = 0.9; // s a standing vehicle needs to get its bumper over the line
const REVOKE_DECEL = 4.5; // m/s^2: a grant is taken back at red only if stopping needs less
const EXIT_SPACING = 2.5; // m of road reserved per vehicle beyond its own length
const ASSERTIVE_AFTER = 30; // s: a driver that has waited this long stops giving way by turn
const SIBLING_CLEARANCE = 8; // m: branching vehicles block the branch point this far along

// Obstacles that are not traffic.
const PATH_STEP = 2.5; // m between samples of the path ahead
const PATH_LOOK_MIN = 12, PATH_LOOK_SECONDS = 3.2, PATH_LOOK_MAX = 80;
const OBSTACLE_SIDE_MARGIN = 0.35; // m

// Turn choice at junctions.
const TURN_WEIGHT = [0.62, 0.18, 0.2, 0.015]; // indexed by TURN: straight, left, right, u-turn
const INDICATE_DISTANCE = 50; // m before the junction
// Giving way: lower goes first. Indexed by TURN.
const TURN_RANK = [0, 2, 1, 3];
const KIND_RANK = { stop: 2, yield: 1 };

const AMBER_UNDECIDED = 0, AMBER_GO = 1, AMBER_STOP = 2;

const BRAKE_LAMP_ON = -0.7, BRAKE_LAMP_OFF = -0.25; // m/s^2, with hysteresis

const point = [0, 0, 0];
const front = [0, 0, 0];
const rear = [0, 0, 0];

/** One vehicle under AI control. Created by TrafficSim.add. */
class Driver {
  constructor(id) {
    this.id = id;
    this.lane = null;
    /** Station of the middle of the wheelbase along `lane`, metres. */
    this.s = 0;
    this.v = 0;
    this.a = 0;
    this.prevLane = null;
    /** The next two lanes of the route. */
    this.next = null;
    this.afterNext = null;
    this.frontLength = 2.2; // origin to front bumper
    this.rearLength = 2.2;
    this.halfWidth = 0.9;
    this.wheelbase = 2.6;
    // Driver character.
    this.speedFactor = 1;
    this.accel = 1.6;
    this.headway = 1.4;
    this.seed = 0;
    this.choices = 0;
    // Junction state.
    /** The connector lane this driver has been granted and has not left yet, or null. */
    this.grant = null;
    /** The connector it has driven off while its tail is still on it, or null. */
    this.held = null;
    this.requesting = false;
    this.arrival = -1;
    this.stoppedAtLine = false;
    this.heldAtLine = false;
    this.amberChoice = AMBER_UNDECIDED;
    // Pose and lamps, for whoever draws and collides the vehicle.
    this.x = 0; this.y = 0; this.z = 0; this.yaw = 0;
    this.braking = false;
    /** 0 off, 1 left, 2 right. */
    this.indicator = 0;
    /** True once the driver has run out of road (a lane with no successor). */
    this.finished = false;
    /** Seconds the vehicle has been standing still. */
    this.idle = 0;
    this.userData = null;
    this._hint = 0;
    this._limit = Infinity; // furthest this step may move the vehicle, metres
  }
}

/** A thing in the road that is not traffic: a capsule in the ground plane. */
class Obstacle {
  constructor() {
    this.x = 0; this.z = 0;
    /** Half-length vector of the capsule's core segment. */
    this.hx = 0; this.hz = 0;
    this.radius = 1;
    this.vx = 0; this.vz = 0;
  }
}

export class TrafficSim {
  /**
   * @param {import('./lanes.js').LaneGraph} graph
   * @param {{seed?: number}} [options]
   */
  constructor(graph, { seed = 1 } = {}) {
    this.graph = graph;
    this.seed = seed | 0;
    this.time = 0;
    /** @type {Driver[]} */
    this.cars = [];
    /** @type {Obstacle[]} */
    this.obstacles = [];
    this.obstacleCount = 0;
    this._nextId = 1;
    this._active = []; // junctions with requests this step
  }

  /** Forgets all obstacles. Call before describing this step's obstacles with `obstacle`. */
  clearObstacles() {
    this.obstacleCount = 0;
  }

  /**
   * Adds an obstacle for the next step: a vehicle-shaped capsule.
   * @param {number} x @param {number} z  centre
   * @param {number} yaw
   * @param {number} halfLength @param {number} halfWidth
   * @param {number} vx @param {number} vz  velocity, m/s
   */
  obstacle(x, z, yaw, halfLength, halfWidth, vx, vz) {
    if (this.obstacleCount === this.obstacles.length) this.obstacles.push(new Obstacle());
    const o = this.obstacles[this.obstacleCount++];
    const core = Math.max(0, halfLength - halfWidth);
    o.x = x; o.z = z;
    o.hx = Math.sin(yaw) * core; o.hz = Math.cos(yaw) * core;
    o.radius = halfWidth;
    o.vx = vx; o.vz = vz;
  }

  /**
   * True if a vehicle of this size can be put on `lane` at station `s` without crowding
   * another one or straddling a junction.
   */
  canPlace(lane, s, frontLength, rearLength, speed = 0) {
    if (lane.junction) return false;
    const clearAhead = frontLength + STANDSTILL_GAP + speed * 1.6 + 4;
    if (lane.next.length > 0 && lane.next[0].junction) this.graph.ensureConflicts(lane.next[0].junction);
    if (s - rearLength < 3 || s + clearAhead > lane.length - lane.holdBack) return false;
    for (let i = 0; i < lane.cars.length; i++) {
      const other = lane.cars[i];
      if (other.s >= s) {
        if (other.s - other.rearLength - (s + frontLength) < STANDSTILL_GAP + speed * 1.6) return false;
      } else if (s - rearLength - (other.s + other.frontLength) < STANDSTILL_GAP + other.v * 1.6) return false;
    }
    // A vehicle about to enter the lane from behind must also have room.
    for (let i = 0; i < lane.prev.length; i++) {
      const cars = lane.prev[i].cars;
      if (cars.length === 0) continue;
      const other = cars[0];
      const gap = lane.prev[i].length - other.s + s - rearLength - other.frontLength;
      if (other.next === lane && gap < STANDSTILL_GAP + other.v * 2.2) return false;
    }
    return true;
  }

  /**
   * Puts a new driver on a lane.
   * @param {object} lane  a prepared lane that is not a junction connector
   * @param {number} s     station of the middle of the wheelbase
   * @param {{frontLength: number, rearLength: number, halfWidth: number, wheelbase: number}} shape
   * @param {number} speed m/s
   * @returns {Driver}
   */
  add(lane, s, shape, speed = 0) {
    const car = new Driver(this._nextId++);
    car.frontLength = shape.frontLength;
    car.rearLength = shape.rearLength;
    car.halfWidth = shape.halfWidth;
    car.wheelbase = shape.wheelbase;
    car.seed = (this.seed * 7919 + car.id) | 0;
    car.speedFactor = 0.84 + 0.24 * hash01(car.seed, 1);
    car.accel = 1.25 + 0.75 * hash01(car.seed, 2);
    car.headway = 1.15 + 0.6 * hash01(car.seed, 3);
    car.lane = lane;
    car.s = s;
    car.v = speed;
    insertOrdered(lane.cars, car);
    this._chooseRoute(car);
    this.cars.push(car);
    this._pose(car);
    return car;
  }

  /** Takes a driver off the road and gives back whatever it had reserved. */
  remove(car) {
    const i = this.cars.indexOf(car);
    if (i < 0) return;
    this.cars.splice(i, 1);
    removeFrom(car.lane.cars, car);
    this._release(car);
    this._releaseHeld(car);
    car.lane = null;
  }

  /** Advances every driver by `dt` seconds (any step up to about 0.1 s). */
  step(dt) {
    if (!(dt > 0)) return;
    const cars = this.cars;
    this._active.length = 0;
    for (let i = 0; i < cars.length; i++) this._plan(cars[i]);
    for (let i = 0; i < this._active.length; i++) this._serve(this._active[i]);
    for (let i = 0; i < cars.length; i++) this._advance(cars[i], dt);
    this.time += dt;
  }

  // ------------------------------------------------------------------ route

  _chooseRoute(car) {
    if (!car.next) car.next = this._choose(car, car.lane);
    if (car.next && !car.afterNext) car.afterNext = this._choose(car, car.next);
    if (car.next && car.next.junction) this.graph.ensureConflicts(car.next.junction);
  }

  /** Picks a successor of `lane`: weighted by the kind of turn, avoiding dead ends. */
  _choose(car, lane) {
    const options = lane.next;
    if (options.length === 0) return null;
    if (options.length === 1) return options[0];
    let total = 0;
    for (let i = 0; i < options.length; i++) total += choiceWeight(options[i]);
    let pick = hash01(car.seed, 100 + car.choices++) * total;
    for (let i = 0; i < options.length; i++) {
      pick -= choiceWeight(options[i]);
      if (pick <= 0) return options[i];
    }
    return options[options.length - 1];
  }

  // ------------------------------------------------------------------ planning

  /** Decides the acceleration of one driver and files its junction request. */
  _plan(car) {
    const lane = car.lane;
    const index = lane.cars.indexOf(car);
    const isFront = index === 0;
    const remaining = lane.length - car.s; // to the end of the lane, from the vehicle origin
    const toLine = remaining - lane.holdBack - car.frontLength; // from the front bumper

    // Desired speed: the driver's version of the limit, the bends here and those coming.
    let desired = Math.min(lane.speedLimit * car.speedFactor, comfortSpeed(lane, car.s, car._hint));
    if (car.next) {
      // v^2 = v0^2 + 2 a d: the speed from which comfortable braking still reaches the
      // entry speed of the lane ahead.
      const room = Math.max(0, remaining);
      const v1 = car.next.speedProfile[0];
      desired = Math.min(desired, Math.sqrt(v1 * v1 + 2 * COMFORT_BRAKING * room));
      if (car.afterNext) {
        const v2 = car.afterNext.speedProfile[0];
        desired = Math.min(desired, Math.sqrt(v2 * v2 + 2 * COMFORT_BRAKING * (room + car.next.length)));
      }
    }
    const ratio = car.v / Math.max(desired, 0.5);
    let accel = Math.max(car.accel * (1 - ratio * ratio * ratio * ratio), -OVERSPEED_DECEL);
    let limit = Infinity;

    // The vehicle ahead on the same path.
    let gap = Infinity, leader = null;
    if (index > 0) {
      leader = lane.cars[index - 1];
      gap = leader.s - leader.rearLength - (car.s + car.frontLength);
    } else {
      let offset = remaining;
      const reach = 50 + car.v * 5;
      for (let hop = 0, ahead = car.next; ahead && offset < reach; hop++) {
        if (ahead.cars.length > 0) {
          leader = ahead.cars[ahead.cars.length - 1];
          gap = offset + leader.s - leader.rearLength - car.frontLength;
          break;
        }
        offset += ahead.length;
        // Beyond the chosen route the path is only known where there is no choice to make.
        ahead = hop === 0 ? car.afterNext : (ahead.next.length === 1 ? ahead.next[0] : null);
      }
    }
    if (leader) {
      accel = Math.min(accel, this._follow(car, gap, leader.v));
      limit = Math.min(limit, gap - HARD_GAP);
    }

    // Vehicles that left this driver's path at a branch and have not cleared it yet.
    if (lane.junction) {
      const conflicts = lane.conflicts;
      for (let k = 0; k < conflicts.length; k++) {
        if (!conflicts[k].sameOrigin) continue;
        const sibling = conflicts[k].lane, exit = exitStation(sibling, lane);
        for (let i = sibling.cars.length - 1; i >= 0; i--) {
          const other = sibling.cars[i];
          if (other.s < car.s || other.s - other.rearLength > exit) continue;
          const g = other.s - other.rearLength - (car.s + car.frontLength);
          accel = Math.min(accel, this._follow(car, g, other.v));
          limit = Math.min(limit, g - HARD_GAP);
        }
      }
    } else if (isFront && lane.next.length > 1) {
      for (let k = 0; k < lane.next.length; k++) {
        const sibling = lane.next[k];
        if (sibling === car.next || sibling.cars.length === 0) continue;
        const other = sibling.cars[sibling.cars.length - 1];
        const clear = car.next && car.next.junction ? exitStation(sibling, car.next) : SIBLING_CLEARANCE;
        const tail = other.s - other.rearLength;
        if (tail > clear) continue;
        const g = remaining + tail - car.frontLength;
        accel = Math.min(accel, this._follow(car, g, other.v));
        limit = Math.min(limit, g - HARD_GAP);
      }
    }

    // Lanes that join ahead without a junction: whoever is closer to the join goes first.
    if (isFront && car.next && !car.next.junction && car.next.prev.length > 1) {
      for (let k = 0; k < car.next.prev.length; k++) {
        const other = car.next.prev[k];
        if (other === lane || other.cars.length === 0) continue;
        const rival = other.cars[0];
        if (rival.next !== car.next) continue;
        const theirs = other.length - rival.s;
        if (theirs > remaining || (theirs === remaining && rival.id > car.id)) continue;
        const g = remaining - theirs - rival.rearLength - car.frontLength;
        accel = Math.min(accel, this._follow(car, g, rival.v));
      }
    }

    // The end of the lane: a junction to be granted, or the end of the road.
    car.requesting = false;
    if (!car.next) {
      accel = Math.min(accel, this._follow(car, toLine + STANDSTILL_GAP - STOP_SHORT, 0));
      limit = Math.min(limit, toLine - MIN_GAP);
    } else if (car.next.junction) {
      const mustWait = this._approach(car, car.next.junction, isFront, toLine);
      if (mustWait) {
        accel = Math.min(accel, this._follow(car, toLine + STANDSTILL_GAP - STOP_SHORT, 0));
        limit = Math.min(limit, toLine - MIN_GAP);
      } else if (car.grant !== car.next) {
        // Still far out: free to drive, but never across the line without a grant.
        limit = Math.min(limit, toLine - MIN_GAP);
      }
    }

    if (this.obstacleCount > 0) accel = Math.min(accel, this._avoid(car));

    car.a = Math.max(accel, -MAX_DECEL);
    car._limit = limit;

    // Lamps.
    if (car.braking ? car.a > BRAKE_LAMP_OFF && car.v > 0.3 : car.a < BRAKE_LAMP_ON || car.v < 0.1) car.braking = !car.braking;
    const turning = lane.junction ? lane : (car.next && car.next.junction && remaining < INDICATE_DISTANCE ? car.next : null);
    car.indicator = !turning ? 0 : turning.turn === TURN.LEFT || turning.turn === TURN.UTURN ? 1 : turning.turn === TURN.RIGHT ? 2 : 0;
  }

  /** Intelligent-driver acceleration towards a gap whose far end moves at `leaderSpeed`. */
  _follow(car, gap, leaderSpeed) {
    const v = car.v;
    const wanted = STANDSTILL_GAP + Math.max(0, v * car.headway + v * (v - leaderSpeed) / (2 * Math.sqrt(car.accel * COMFORT_DECEL)));
    const q = wanted / Math.max(gap, MIN_GAP);
    return car.accel * (1 - q * q);
  }

  /**
   * The driver's dealings with the junction ahead: obeys the signal or stop sign, asks for
   * its connector when close enough. Returns true while the stop line must be respected.
   */
  _approach(car, junction, isFront, toLine) {
    const control = car.lane.control;
    const kind = control ? control.kind : 'none';
    // The signal is that of the junction the lane leads to, which is not always the one that
    // hands out the crossing (junctions that are crossed as one keep their own signals).
    const signals = kind === 'signal' ? control.junctionRef || junction : null;
    const holds = car.grant === car.next;
    let state = SIGNAL.GREEN;
    if (signals) state = signalState(signals, control.group, this.time);

    if (kind === 'signal') {
      if (state === SIGNAL.GREEN) car.amberChoice = AMBER_UNDECIDED;
      else if (state === SIGNAL.AMBER && car.amberChoice === AMBER_UNDECIDED) {
        // Decided once, when the light changes: go only if the line can be reached before red
        // at the pace the turn ahead allows. Deciding again while braking would flip the answer.
        const pace = 0.5 * (car.v + Math.min(car.v, car.next.speedProfile[0]));
        car.amberChoice = car.heldAtLine || toLine < pace * SIGNAL_GO_SECONDS ? AMBER_GO : AMBER_STOP;
      }
      // A grant is a reservation, not a promise: a driver that will not make it through
      // gives the junction back, at red as long as it can still stop.
      if (holds) {
        const stoppable = toLine > car.v * car.v / (2 * REVOKE_DECEL) + STOP_SHORT;
        if ((state === SIGNAL.RED && stoppable) || (state === SIGNAL.AMBER && car.amberChoice === AMBER_STOP)) this._release(car);
      }
      if (!car.grant && (state === SIGNAL.RED || (state === SIGNAL.AMBER && car.amberChoice === AMBER_STOP))) return true;
      // Nobody is let in who would reach the line after the light has gone red, which is
      // what a driver held up during amber (or setting off late from the line) would do.
      if (!car.grant && state === SIGNAL.AMBER) {
        const eta = toLine / Math.max(car.v, 1.5) + (car.v < 2 ? SET_OFF_SECONDS : 0.3);
        if (signalState(signals, control.group, this.time + eta) === SIGNAL.RED) return true;
      }
    }
    if (holds) return false;
    // Only the first vehicle in the queue deals with the junction; the rest follow it.
    if (!isFront) return false;

    if (kind === 'stop' && !car.stoppedAtLine) {
      if (car.v < 0.4 && toLine < STOP_SHORT + 1.5) {
        car.stoppedAtLine = true;
        car.arrival = this.time;
      }
      return true;
    }
    const window = kind === 'signal'
      ? car.v * SIGNAL_GO_SECONDS + SIGNAL_REQUEST_MARGIN
      : car.v * REQUEST_SECONDS + REQUEST_MARGIN;
    if (toLine > window) return false;

    if (car.arrival < 0) car.arrival = this.time;
    car.requesting = true;
    if (junction.requests.length === 0) this._active.push(junction);
    junction.requests.push(car);
    // Waiting at a green light for a gap: this driver may still go when it turns amber.
    if (state === SIGNAL.GREEN && car.v < 1 && toLine < STOP_SHORT + 2.5) car.heldAtLine = true;
    return true;
  }

  /** Grants the junction to this step's requests, most entitled first. */
  _serve(junction) {
    const requests = junction.requests;
    // Insertion sort: a handful of entries, already nearly ordered from the last step.
    for (let i = 1; i < requests.length; i++) {
      const car = requests[i];
      let j = i - 1;
      while (j >= 0 && this._outranks(car, requests[j])) { requests[j + 1] = requests[j]; j--; }
      requests[j + 1] = car;
    }
    for (let i = 0; i < requests.length; i++) {
      const car = requests[i];
      if (this._canEnter(car, junction)) {
        car.grant = car.next;
        junction.granted.push(car);
      }
    }
    requests.length = 0;
  }

  _outranks(a, b) {
    const ka = this._rank(a), kb = this._rank(b);
    if (ka !== kb) return ka < kb;
    if (a.arrival !== b.arrival) return a.arrival < b.arrival;
    return a.id < b.id;
  }

  /** Priority class: by traffic control first, then by the kind of turn. Lower goes first. */
  _rank(car) {
    if (this.time - car.arrival > ASSERTIVE_AFTER) return 0;
    const kind = car.lane.control ? car.lane.control.kind : 'none';
    // At stop signs the order of arrival decides, whatever the turn.
    if (kind === 'stop') return KIND_RANK.stop * 4;
    return (KIND_RANK[kind] || 0) * 4 + TURN_RANK[car.next.turn];
  }

  /** True if `car` can be given its connector now. */
  _canEnter(car, junction) {
    const connector = car.next;
    const granted = junction.granted;
    for (let i = 0; i < granted.length; i++) {
      const other = granted[i];
      if (other.grant && other.grant.junction === junction && inTheWay(other, other.grant, connector)) return false;
      if (other.held && other.held.junction === junction && inTheWay(other, other.held, connector)) return false;
    }

    // Room on the far side, counting the vehicles already on their way there.
    // The road ends, for this purpose, at the last vehicle on it or at the line of the next
    // junction, where whoever arrives may have to wait.
    const exit = connector.next.length > 0 ? connector.next[0] : null;
    if (exit) {
      let room = 0, bounded = false, taken = 0;
      for (let lane = exit, hop = 0; lane && hop < 3; hop++) {
        if (lane.cars.length > 0) {
          const last = lane.cars[lane.cars.length - 1];
          room += last.s - last.rearLength + (last.v > 2 ? last.v * 1.5 : 0);
          bounded = true;
          taken++;
          break;
        }
        if (lane.next.length > 0 && lane.next[0].junction) {
          this.graph.ensureConflicts(lane.next[0].junction);
          room += lane.length - lane.holdBack;
          bounded = true;
          break;
        }
        room += lane.length;
        lane = lane.next.length === 1 ? lane.next[0] : null;
      }
      if (bounded) {
        for (let i = 0; i < granted.length; i++) {
          const other = granted[i];
          if (other.grant && other.grant.junction === junction && other.lane !== exit && other.grant.next[0] === exit) {
            room -= other.frontLength + other.rearLength + EXIT_SPACING;
            taken++;
          }
        }
        // A vehicle longer than an empty stretch of road still has to be let onto it.
        if (taken > 0 && room < car.frontLength + car.rearLength + EXIT_SPACING) return false;
      }
    }

    // Something that is not traffic standing on the connector.
    for (let k = 0; k < this.obstacleCount; k++) {
      const o = this.obstacles[k];
      const area = junction.area, reach = area.radius + 12;
      if ((o.x - area.x) * (o.x - area.x) + (o.z - area.z) * (o.z - area.z) > reach * reach) continue;
      const clear = o.radius + car.halfWidth + OBSTACLE_SIDE_MARGIN;
      let hint = 0;
      for (let s = 0; s <= connector.length; s += PATH_STEP) {
        hint = samplePoint(connector, s, point, hint);
        if (capsuleDistance(o, point[0], point[2]) < clear) return false;
      }
    }
    return true;
  }

  _release(car) {
    if (!car.grant) return;
    removeFrom(car.grant.junction.granted, car);
    car.grant = null;
  }

  _releaseHeld(car) {
    if (!car.held) return;
    removeFrom(car.held.junction.granted, car);
    car.held = null;
  }

  /** Acceleration that keeps the driver from running into an obstacle on its path. */
  _avoid(car) {
    const look = clamp(car.v * PATH_LOOK_SECONDS + PATH_LOOK_MIN, PATH_LOOK_MIN, PATH_LOOK_MAX);
    const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
    let accel = Infinity;
    for (let k = 0; k < this.obstacleCount; k++) {
      const o = this.obstacles[k];
      const dx = o.x - car.x, dz = o.z - car.z;
      const range = look + car.frontLength + o.radius + Math.abs(o.hx) + Math.abs(o.hz) + 2;
      if (dx * dx + dz * dz > range * range) continue;
      const clear = o.radius + car.halfWidth + OBSTACLE_SIDE_MARGIN;
      for (let d = 0; d <= look; d += PATH_STEP) {
        this._pathPoint(car, car.s + car.frontLength + d, point);
        if (capsuleDistance(o, point[0], point[2]) >= clear) continue;
        // Only the part of its speed along our heading helps: an obstacle crossing the path
        // counts as standing still.
        const along = Math.max(0, o.vx * fx + o.vz * fz);
        accel = Math.min(accel, this._follow(car, Math.max(MIN_GAP, d - PATH_STEP * 0.5), along));
        break;
      }
    }
    return accel;
  }

  // ------------------------------------------------------------------ motion

  _advance(car, dt) {
    let v = Math.max(0, car.v + car.a * dt);
    let step = v * dt;
    if (step > car._limit) {
      step = Math.max(0, car._limit);
      v = step / dt;
    }
    car.v = v;
    car.s += step;
    car.idle = v < 0.05 ? car.idle + dt : 0;

    while (car.s >= car.lane.length) {
      const next = car.next;
      if (!next) {
        car.s = car.lane.length;
        car.v = 0;
        car.finished = true;
        break;
      }
      removeFrom(car.lane.cars, car);
      car.s -= car.lane.length;
      car.prevLane = car.lane;
      car.lane = next;
      car.next = car.afterNext;
      car.afterNext = null;
      car.arrival = -1;
      car.stoppedAtLine = false;
      car.heldAtLine = false;
      car.amberChoice = AMBER_UNDECIDED;
      car._hint = 0;
      // Off the granted connector, but the tail is still on it. Should the tail of the one
      // before be too (lanes shorter than the vehicle), that one is given back early.
      if (car.prevLane === car.grant) {
        this._releaseHeld(car);
        car.held = car.grant;
        car.grant = null;
      }
      insertOrdered(next.cars, car);
      this._chooseRoute(car);
    }
    // The junction is given back once the tail is out of it.
    if (car.held && (car.prevLane !== car.held || car.s - car.rearLength >= 0)) this._releaseHeld(car);
    if (!car.next && !car.finished && car.lane.length - car.s - car.frontLength < 1.5 && car.v < 0.3) car.finished = true;
    this._pose(car);
  }

  /** Point on the driver's path at station `s` of its current lane; may lie on the lane before or after. */
  _pathPoint(car, s, out) {
    const lane = car.lane;
    if (s < 0 && car.prevLane) samplePoint(car.prevLane, car.prevLane.length + s, out, car.prevLane.count);
    else if (s > lane.length && car.next) {
      const over = s - lane.length;
      if (over > car.next.length && car.afterNext) samplePoint(car.afterNext, over - car.next.length, out, 0);
      else samplePoint(car.next, over, out, 0);
    } else car._hint = samplePoint(lane, s, out, car._hint);
  }

  /** Places the vehicle with both axles on the path, which is what makes it turn like a car. */
  _pose(car) {
    this._pathPoint(car, car.s + car.wheelbase * 0.5, front);
    this._pathPoint(car, car.s - car.wheelbase * 0.5, rear);
    car.x = (front[0] + rear[0]) * 0.5;
    car.y = (front[1] + rear[1]) * 0.5;
    car.z = (front[2] + rear[2]) * 0.5;
    const dx = front[0] - rear[0], dz = front[2] - rear[2];
    if (dx * dx + dz * dz > 1e-6) car.yaw = Math.atan2(dx, dz);
  }
}

function choiceWeight(lane) {
  const weight = lane.junction ? TURN_WEIGHT[lane.turn] : 1;
  // A connector that leads into a dead end is taken only if there is nothing else.
  const leadsOn = lane.next.length > 0 && (lane.junction ? lane.next[0].next.length > 0 : true);
  return leadsOn ? weight : weight * 0.001;
}

/** The record of lane `b` in the conflict list of lane `a`, if they conflict. */
function conflictBetween(a, b) {
  const list = a.conflicts;
  for (let i = 0; i < list.length; i++) if (list[i].lane === b) return list[i];
  return null;
}

/**
 * True while `other`, which holds the connector `theirs`, keeps `connector` from being used:
 * the two conflict and its tail has not passed the point where they part.
 */
function inTheWay(other, theirs, connector) {
  if (theirs === connector) return false; // same path: following takes care of it
  const conflict = conflictBetween(theirs, connector);
  if (!conflict || conflict.sameOrigin) return false;
  // Station of its tail along its connector: negative on the way in, beyond the length once out.
  let tail;
  if (other.lane === theirs) tail = other.s - other.rearLength;
  else if (other.prevLane === theirs) tail = theirs.length + other.s - other.rearLength;
  else tail = other.s - other.rearLength - other.lane.length;
  return tail <= conflict.exitS;
}

/** Station on `sibling` beyond which a vehicle on it is clear of `lane` (both leave the same lane). */
function exitStation(sibling, lane) {
  const conflict = conflictBetween(sibling, lane);
  return conflict ? conflict.exitS : SIBLING_CLEARANCE;
}

/** Distance from a point to an obstacle's core segment (the caller allows for its radius). */
function capsuleDistance(o, x, z) {
  const dx = x - o.x, dz = z - o.z;
  const len2 = o.hx * o.hx + o.hz * o.hz;
  const t = len2 > 0 ? clamp((dx * o.hx + dz * o.hz) / len2, -1, 1) : 0;
  const ox = dx - o.hx * t, oz = dz - o.hz * t;
  return Math.sqrt(ox * ox + oz * oz);
}

/** Inserts into a lane's list, which is kept ordered from the front vehicle to the last. */
function insertOrdered(list, car) {
  let i = list.length;
  list.push(car);
  while (i > 0 && list[i - 1].s < car.s) { list[i] = list[i - 1]; i--; }
  list[i] = car;
}

function removeFrom(list, item) {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}
