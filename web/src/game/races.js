// Street races: the rules, the route and the clock. Nothing here moves a car.
//
// A race on Paloma Drive is run on the streets the game already has, which is the only way it can
// mean anything: the route is a walk over the real lane graph, so the road you are timed on has
// junctions, signals, bends taken at a comfortable speed and — most importantly — traffic. There is
// no closed circuit, no invisible wall and no restart when you touch a kerb, because the island is
// not a track and neither are these races.
//
// Opponents are ordinary traffic cars handed a route (game/drivers.js, the same mechanism Paloma PD
// uses to send a cruiser to the last place you were seen), and they pass the gates exactly as you do:
// a gate is a plane across the road, and a car has crossed it when its centre goes from one side to
// the other inside the gate's width. That is one test per car per frame and no physics contact needed.

import { clamp, lerp, hash01 } from '../core/math.js';
import { samplePoint, laneYaw } from './lanes.js';
import { MeshBuilder } from '../core/mesh.js';
import { Skin } from '../vehicles/traffic/skin.js';
import { box, rod, quad, X, Y, Z } from '../vehicles/traffic/kit.js';
import * as mt from '../vehicles/traffic/materials.js';

/**
 * The three meetings the street keeps. `length` is the target distance of one lap, metres, and
 * `purse` is the money that is lying in the middle of the road before the flag drops — the field
 * stakes it, not the player, so a race pays whether or not you have a dollar in your pocket.
 * The long one is worth most because the field is bigger, the distance is further and the traffic
 * you are threading at a hundred and forty is the reason anybody pays to watch it.
 */
export const TIERS = Object.freeze([
  { id: 'local', name: 'Ocean Drive Run', length: 1200, opponents: 3, laps: 1, minutes: 3, purse: 240 },
  { id: 'county', name: 'Paloma County Sprint', length: 2600, opponents: 4, laps: 1, minutes: 5, purse: 700 },
  { id: 'palm', name: 'The Palm 500', length: 3400, opponents: 5, laps: 2, minutes: 9, purse: 1800 },
]);

/** metres either side of the centre line a gate is worth, and how far a car may be from the road. */
export const GATE_HALF = 5.2, GATE_REACH = 9;
/** A false start costs this, and the line you crossed early is not counted. */
export const FALSE_START_MS = 3000;
/** The countdown, seconds: long enough to reach the line from a kerb, short enough to not be dull. */
export const COUNTDOWN_SECONDS = 3.4;
/** Nobody is racing a car that never arrived: this long after the leader, the field is marked away. */
export const DID_NOT_FINISH_SECONDS = 150;
/** metres in one step that means the car was picked up and put down, not driven (a teleport, a respawn) */
export const TELEPORT = 60;

/**
 * What the places take of the purse. Nobody is paid for finishing fourth in a field of six, and the
 * rest of the field is what keeps the winner's share under the whole: a race moves money around, it
 * does not print it.
 */
export const PLACE_SHARES = Object.freeze([0.6, 0.25, 0.15]);
/**
 * What after ten at night and before five in the morning is added to a purse. The crowd that lays
 * money on a street race lays more of it when it should be in bed, and a man running at three in the
 * morning for the money is paid for the hour as much as for the lap.
 */
export const NIGHT_PURSE_BOOST = 1.25;

/** The small hours, by the street clock. */
export const isNightHour = (hour) => !(Number.isFinite(hour) && hour >= 5 && hour < 22);

/** What is lying in the middle of the road for this meeting, at this hour. */
export function purseFor(tier, hour = 12) {
  const base = tier && tier.purse > 0 ? tier.purse : TIERS[0].purse;
  return Math.round(base * (isNightHour(hour) ? NIGHT_PURSE_BOOST : 1));
}

/**
 * A man's share of the purse, by where the field left him. A one-car field is a time trial: the clock
 * was the only opponent, so finishing is winning and the whole purse is his.
 */
export function shareFor(place, field) {
  if (!(field > 1)) return 1;
  const p = Math.max(1, (place | 0) || field);
  return p - 1 < PLACE_SHARES.length ? PLACE_SHARES[p - 1] : 0;
}

/**
 * A route: lanes in order, gates across them, and the map the drivers are given.
 * `target` is a wish, not a promise — a route ends when the street runs out of new road to take.
 */
export function buildRoute(graph, startLane, startS, target, rng = hash01) {
  if (!startLane || !(startLane.length > 0)) return null;
  const heading = (l, at) => laneYaw(l, at);
  // On a real street graph a lane's successor is the little connector that crosses the junction, and
  // the road on the far side is that connector's successor. So a route is walked through the connectors
  // — a car has to drive them — but they are never part of the course proper: no gate goes in a
  // junction, and `roadLane` is what turns a walked lane back into the street it belongs to.
  const isRoad = (lane) => !!lane && !lane.junction && lane.junctionId < 0;
  const roadLane = (lane) => {
    let guard = 0;
    while (lane && !isRoad(lane) && guard++ < 4) lane = (lane.next && lane.next[0]) || null;
    return isRoad(lane) ? lane : null;
  };
  // Can a route still leave this lane, given what it has already walked? The start lane always counts as
  // a way out: coming home is what a lap is.
  const leadsSomewhere = (lane) => {
    for (const raw of lane.next || []) {
      if (!raw) continue;
      if (raw === startLane) return true;
      // A junction's mouth is twenty-odd metres of connector; the road worth racing on is what comes
      // out of it, and that is what has to be long enough.
      const next = isRoad(raw) ? raw : roadLane(raw);
      if (next && (next === startLane || next.length > 24)) return true;
    }
    return false;
  };
  // A legal successor, judged for straightness with a little randomness so that two meetings on the same
  // island are not the same road. `legal` says whether the route may walk it at all right now.
  const pick = (lane, yaw, used, length, legal) => {
    let best = null, bestTurn = 9;
    bestLink = null;
    for (const raw of lane.next || []) {
      // A connector is walked, not raced on: judge the road it comes out at, and keep the connector as
      // the `link` the drivers are given, so a route tells them how over the junction as well as where.
      const through = !isRoad(raw);
      const next = through ? roadLane(raw) : raw;
      if (!next || !(next.length > 24)) continue;
      if (!legal(next)) continue;
      let turn = Math.abs(Math.atan2(Math.sin(heading(next, 0) - yaw), Math.cos(heading(next, 0) - yaw)));
      if (next.turn === 3) turn += 1.4;                       // a u-turn is not a racer's line
      // A road you cannot get out of is only worth taking as the last one, and only if it is long
      // enough to finish the course: a route that ends in a driveway is not a race.
      // A road with no way out is the last one a route takes, and only if it is long enough to finish
      // the course: a dead end that runs out short leaves the field parked in somebody's driveway.
      if (!leadsSomewhere(next) && length + next.length < target) turn += 1e6;
      turn += rng(next.id, used.size) * 0.22;
      if (turn < bestTurn) { bestTurn = turn; best = next; bestLink = through ? raw : null; }
    }
    return best && bestTurn < 1e5 ? best : null;
  };
  let bestLink = null;
  const used = new Set();
  const picked = [];
  /** The junction lanes the route crosses, in order, so the drivers can be told how to cross them. */
  const links = new Map();
  let lane = startLane, s = startS, length = 0, yaw = heading(lane, s), wrapped = false;
  for (let step = 0; step < 420; step++) {
    if (!lane) break;
    if (used.has(lane.id) && lane !== startLane) break;
    used.add(lane.id);
    const from = picked.length === 0 ? s : 0;
    picked.push({ lane, from, to: lane.length });
    length += lane.length - from;
    // New road first; and when the island runs out of it, the route is allowed to walk a road it has
    // already used, which is what a lap of a street loop is.
    let best = pick(lane, yaw, used, length, (next) => !used.has(next.id) || next === startLane);
    if (!best && used.size > 2) best = pick(lane, yaw, used, length, () => true);
    if (!best) break;
    if (bestLink) links.set(lane, bestLink);
    // Home again: stop on the line once the distance asked for has been covered, and otherwise clear the
    // loop and go round again. Two passes of the same street is a lap count, not two races.
    if (best === startLane) {
      if (length >= target * 0.55 || wrapped) break;
      wrapped = true;
      used.clear();
      used.add(startLane.id);
    } else if (length >= target) break;
    yaw = heading(best, 0);
    lane = best; s = 0;
  }
  if (picked.length < 2 || length < 260) return null;
  // The course as one continuous arc measured from the line, and gates laid along it at an even
  // spacing: four to nine of them, far enough apart that each is a corner rather than a slalom, none so
  // close to the line that a u-turn in front of the marshal would count as the next one.
  const marks = clamp(Math.round(target / 380), 4, 9);
  let every = length / (marks + 1);
  if (every < 170) every = 170;
  if (every > 700) every = 700;
  const parts = [];
  let along = 0;
  for (const part of picked) {
    parts.push({ lane: part.lane, from: part.from, to: part.to, start: along });
    along += part.to - part.from;
  }
  const atArc = (d) => {
    let k = 0;
    while (k < parts.length - 1 && d > parts[k].to - parts[k].from + parts[k].start) k++;
    const part = parts[k];
    const at = clamp(part.from + (d - part.start), part.from, part.to);
    const p = [0, 0, 0];
    samplePoint(part.lane, at, p);
    return { lane: part.lane, s: at, x: p[0], z: p[2], yaw: laneYaw(part.lane, at) };
  };
  // The line is where the car was standing, and every gate after it is measured from there: no gate is
  // ever behind the grid, and nobody can be nearer the second gate than the first when the flag drops.
  const start = [0, 0, 0];
  samplePoint(picked[0].lane, picked[0].from, start);
  const gates = [{
    lane: picked[0].lane, s: picked[0].from, x: start[0], z: start[2],
    yaw: heading(picked[0].lane, picked[0].from), start: true,
  }];
  for (let d = every; d < length - 60; d += every) gates.push(atArc(d));
  if (gates.length < 3) return null;
  // What the drivers are told: a lane of this route leads to the next one of this route.
  const map = new Map();
  for (let i = 0; i < picked.length - 1; i++) map.set(picked[i].lane, picked[i + 1].lane);
  // The connectors themselves are part of the order too: a driver told only "this street leads to that
  // one" would sit at the stop line for ever, because the graph says its next lane is the junction.
  for (const [from, via] of links) { map.set(from, via); map.set(via, roadLane(via)); }
  // And the way home, so that the opponents on the course are not retired at the last corner: a route
  // that ends on the line has to say where the line leads, or the field falls apart behind you.
  const lastLane = picked[picked.length - 1].lane;
  const comesHome = lastLane.next ? lastLane.next.includes(picked[0].lane) : false;
  if (comesHome) map.set(lastLane, picked[0].lane);
  return {
    lanes: picked.map((p) => p.lane), gates, map, length,
    /** Whether the course joins its own start: a lap, not a one-way sprint. */
    comesHome,
    start: {
      lane: picked[0].lane, s: picked[0].from, x: start[0], z: start[2],
      yaw: heading(picked[0].lane, picked[0].from),
    },
  };
}

/**
 * Did a step from `from` to `to` cross `gate`, within its width? Both points are [x, z].
 * Crossing is by side of the plane, so a car cannot miss a gate by moving fast, and a car going the
 * wrong way through it does not count: the sign of the along-axis dot product must change the right way
 * for the gate's own direction of travel.
 */
export function crossing(gate, from, to) {
  const fx = Math.sin(gate.yaw), fz = Math.cos(gate.yaw);
  // Across the road, for the width test; along it, for the direction test.
  const ax = -fz, az = fx;
  const across = (p) => Math.abs((p[0] - gate.x) * ax + (p[1] - gate.z) * az);
  const along = (p) => (p[0] - gate.x) * fx + (p[1] - gate.z) * fz;
  const a = along(from), b = along(to);
  if (!(a <= 0 && b > 0)) return false;
  // Both ends must be on the road: a car that cuts the corner through the grass crosses the plane
  // inside the mouth, and that is not going through the gate.
  const slack = GATE_HALF + 0.5;
  if (across(from) > slack || across(to) > slack) return false;
  const t = a / (a - b);
  const cx = lerp(from[0], to[0], t) - gate.x, cz = lerp(from[1], to[1], t) - gate.z;
  return Math.abs(cx * ax + cz * az) <= GATE_HALF;
}

/** The rank, as it reads on a board: `P2/5`, or `DNF`. */
export function placeLabel(place, field, done) {
  if (!done) return '';
  if (place === null) return 'DNF';
  return `P${place}/${field}`;
}

/** mm:ss.t, and hundredths beyond a minute: the way a timing board writes a lap. */
export function formatTime(ms) {
  if (!(ms > 0)) return '--:--';
  const t = ms / 1000, m = Math.floor(t / 60), s = t - m * 60;
  return m ? `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}` : `${s.toFixed(2)}`;
}

/**
 * The gate's geometry: two posts, a banner across the road, and a number. Built once per race, drawn
 * as one shared mesh for every gate on the course.
 * @param {number} half  metres to either side of the centre line
 */
export function buildGateMesh(half = GATE_HALF) {
  const mb = new MeshBuilder(900);
  const sk = new Skin(mb);
  const post = mt.fixed(mt.hex ? mt.hex(0x2a2c30) : [0.16, 0.17, 0.18]);
  const banner = mt.fixed([0.93, 0.9, 0.8]);
  const flag = mt.trim(0.5, [0.85, 0.16, 0.42]);
  for (const side of [-1, 1]) {
    const x = side * half;
    box(sk, post, [x, 1.35, 0], [0.09, 1.35, 0.09], {});
    box(sk, flag, [x, 2.78, 0], [0.13, 0.11, 0.13], {});            // the lamp that says which is next
  }
  // The banner is a sheet across the road, and it is deliberately above the tallest van.
  quad(sk, banner, [-half, 2.55, -0.05], [half, 2.55, -0.05], [half, 3.15, -0.05], [-half, 3.15, -0.05], [[0, 0], [1, 0], [1, 1], [0, 1]], 1);
  quad(sk, banner, [-half, 2.55, 0.05], [half, 2.55, 0.05], [half, 3.15, 0.05], [-half, 3.15, 0.05], [[0, 0], [1, 0], [1, 1], [0, 1]], 1);
  rod(sk, post, [-half, 2.5, 0], [half, 2.5, 0], 0.05, 6, true);
  return mb.finish();
}

/** The browser's own store, where there is one: a record should survive a reload and nothing else. */
export function localStore() {
  try {
    if (typeof localStorage === 'undefined' || !localStorage) return null;
    localStorage.setItem('vice86.probe', '1');
    localStorage.removeItem('vice86.probe');
    return localStorage;
  } catch {
    return null;                        // private mode, a sandboxed frame: no records, no fault
  }
}

/**
 * The races, in the game's hands.
 * @param {object} options { graph, renderer, traffic, land, notify, store, seed }
 */
export function createRaces({ graph, renderer, traffic, land = 1.2, notify = () => {}, store = localStore(), seed = 1, hour = null } = {}) {
  // The purse is sized when the flag goes up, on the hour the street is at: a meeting called at dusk is
  // worth what it was worth at dusk, and the clock moving under it mid-race does not change a bet.
  const hourAt = () => {
    const h = typeof hour === 'function' ? hour() : hour;
    return Number.isFinite(h) ? h : 12;
  };
  const mesh = { handle: -1, failed: false };
  const gates = [];
  const was = [0, 0], is = [0, 0];
  let rng = (a, b) => hash01(a * 31 + 7, b * 17 + seed);
  const state = {
    active: false, tier: null, name: '', countdown: 0, elapsedMs: 0, penaltyMs: 0,
    passed: 0, total: 0, lap: 1, laps: 1, place: null, field: 1, finished: false, lastMs: 0,
    bestMs: 0, opponents: 0, distance: 0,
    // The money: what is in the middle of the road, what the result pays, and whether it was taken.
    purse: 0, payout: 0, paid: false,
  };
  let route = null, cars = null, lapOf = [], times = [], armed = false;
  const last = [0, 0];

  function ensureMesh() {
    if (mesh.handle >= 0 || mesh.failed) return mesh.handle;
    try {
      mesh.handle = renderer.createMesh(buildGateMesh(), { retain: true });
    } catch (error) {
      mesh.failed = true;
      console.error('Race gates could not be uploaded', error);
    }
    return mesh.handle;
  }

  function clearGates() {
    for (const g of gates) if (g.obj) g.obj.remove();
    gates.length = 0;
  }

  function showGates() {
    const handle = ensureMesh();
    if (handle < 0 || !route) return;
    clearGates();
    for (const gate of route.gates) {
      const obj = renderer.addDynamic({ mesh: handle, castShadow: false });
      obj.matrix[0] = Math.cos(gate.yaw); obj.matrix[2] = -Math.sin(gate.yaw); obj.matrix[8] = Math.sin(gate.yaw); obj.matrix[10] = Math.cos(gate.yaw);
      obj.matrix[12] = gate.x; obj.matrix[13] = land; obj.matrix[14] = gate.z;
      obj.visible = false;
      gates.push({ obj, gate });
    }
  }

  /** How far the next gate is: the HUD reads it as the metres to the corner you are aimed at. */
  function nextDistance() {
    if (!route) return 0;
    const g = route.gates[state.passed % route.gates.length];
    return Math.round(Math.hypot(g.x - is[0], g.z - is[1]));
  }

  const races = {
    state,
    /** The lanes of the course in order — a test or an overlay can drive them. */
    get lanes() { return route ? route.lanes : []; },
    get live() { return !!graph && !!traffic; },
    /** Why the last start was refused, in the race's own words: for a toast and for a check. */
    last: '',
    /** The course being run, or null: gates and lanes, for a test or a minimap overlay. */
    get route() { return route; },

    /** Where the next meeting starts, from where you are standing: a route, or nothing. */
    offer(x, z) {
      if (!races.live) return null;
      const hit = graph.nearest(x, z, 40, (lane) => !lane.junction && lane.junctionId < 0 && lane.length > 20);
      if (!hit) { races.last = 'no road'; return null; }
      return TIERS.map((tier) => {
        const route = buildRoute(graph, hit.lane, hit.s, tier.length, rng);
        return route ? { tier, length: route.length, gates: route.gates.length, purse: purseFor(tier, hourAt()) } : null;
      }).filter(Boolean);
    },

    /**
     * Start a meeting on the street the car is standing on. `x, z` are only used to find the road: the
     * field is placed at the course's own grid, and the caller moves the player there if it wants the
     * race to be fair (`place()`), because a race begun 400 m from the line is a race already lost.
     * @returns {boolean} false where the street is too thin to lay a course on
     */
    start(tierId = 'local', x = 0, z = 0) {
      if (!races.live || state.active) return false;
      const tier = TIERS.find((t) => t.id === tierId) || TIERS[0];
      const hit = graph.nearest(x, z, 40, (lane) => !lane.junction && lane.junctionId < 0 && lane.length > 20);
      if (!hit) { notify('No road wide enough to race on here'); races.last = 'no road'; return false; }
      route = buildRoute(graph, hit.lane, hit.s, tier.length, rng);
      if (!route) { route = null; notify('The street here is too short to lay a course on'); races.last = 'no course'; return false; }
      races.last = '';
      state.active = true;
      state.tier = tier.id;
      state.name = tier.name;
      state.countdown = COUNTDOWN_SECONDS;
      state.elapsedMs = 0; state.penaltyMs = 0; state.finished = false; state.lastMs = 0;
      state.passed = 0; state.total = route.gates.length * tier.laps; state.lap = 1; state.laps = tier.laps;
      state.distance = route.length; state.place = null; state.bestMs = 0;
      state.purse = purseFor(tier, hourAt()); state.payout = 0; state.paid = false;
      times = [];
      showGates();
      // The opponents: traffic cars on the grid behind the line, told to follow the course.
      // The line's own position and the lanes the course uses, because the field is filled from the
      // street as it stands: cars are recruited where they are, not conjured onto a kerb (traffic.js).
      const line = route.gates[0];
      cars = traffic.fieldForRace
        ? traffic.fieldForRace(route.start.lane, route.start.s, tier.opponents, route.map, {
          from: line ? [line.x, line.z] : null,
          lanes: new Set(route.lanes.map((l) => l.id)),
        })
        : [];
      state.field = state.opponents = (cars ? cars.length : 0) + 1;
      // On the line, and no further: the caller has just put the car there (place()). Starting exactly
      // on the plane is deliberate — a car 12 m back would count a crossing of its own start line as a
      // false start the instant the frame runs, and a car ahead of it would have tunnelled a gate.
      // The first step is spent resyncing (see step()): the caller is about to put the car on this line,
      // and a jump from wherever it was standing must not be read as a crossing of its own start gate.
      armed = true;
      const g0 = route.gates[0];
      is[0] = g0.x; is[1] = g0.z; was[0] = g0.x; was[1] = g0.z;
      last[0] = g0.x; last[1] = g0.z;
      // `out` is how long the car has been out of sight of the course, `dead` that the street has taken
      // it back (see step()). Two different things, and only one of them ends a race.
      lapOf = (cars || []).map(() => ({ passed: 0, out: 0, dead: 0, was: null }));
      if (!cars || !cars.length) notify('Nobody turned up to race you');
      notify(`${tier.name} · ${Math.round(route.length)} m over ${tier.laps} lap${tier.laps > 1 ? 's' : ''}, ${route.gates.length} gates · $${state.purse.toLocaleString('en-US')} in the middle`);
      return true;
      /* the grid is where the cars are; see place() */
    },

    /**
     * The purse, once: handed to whoever is keeping the money. Nothing is owed after it has been taken,
     * so a caller that asks every frame gets 0 and can ask again all day.
     * @returns {number} dollars
     */
    collect() {
      if (!state.finished || state.paid) return 0;
      state.paid = true;
      return Math.max(0, state.payout);
    },

    /**
     * Call this after moving the player (a placement, a respawn, an unpause) so the next step is spent
     * resyncing rather than judging a jump. Cheap to call too often; not calling it is what hurts.
     */
    resync() { armed = true; },

    /** Where the field is put: [x, z, yaw] on the start line. The caller parks the player here. */
    place() {
      if (!route) return null;
      const g = route.gates[0];
      return [g.x, g.z, g.yaw];
    },

    abort(reason = 'Race called off') {
      if (!state.active) return;
      if (cars && traffic.releaseFromRace) traffic.releaseFromRace(cars);
      cars = null;
      state.active = false; state.place = null; armed = false;
      state.purse = 0; state.payout = 0; state.paid = false;
      clearGates();
      if (reason) notify(reason);
    },

    /**
     * One frame of the meeting.
     * @param {number} dt simulated seconds
     * @param {number[]} pos the player's car, [x, z]
     * @param {boolean} driving
     */
    step(dt, pos, driving = true) {
      if (!state.active || !driving || !(dt > 0)) return;
      is[0] = pos[0]; is[1] = pos[1];
      // A placement, not a drive. The game puts the car on the grid when a meeting starts and again when
      // it is unpaused, and a jump from wherever the car happened to be is not a car crossing a gate. So
      // the first step after either is spent on resyncing the previous position — and a car that has been
      // carried further in one frame than it could ever have driven (a respawn, a debug warp) is resynced
      // too, losing at most one gate rather than inventing one.
      if (armed || Math.hypot(pos[0] - last[0], pos[1] - last[1]) > TELEPORT) {
        armed = false;
        was[0] = pos[0]; was[1] = pos[1];
        last[0] = pos[0]; last[1] = pos[1];
        return;
      }
      last[0] = pos[0]; last[1] = pos[1];
      if (state.countdown > 0) {
        state.countdown -= dt;
        // Crossing the line before the flag: the gate is not counted, and three seconds are.
        if (route && crossing(route.gates[0], was, is)) {
          state.penaltyMs += FALSE_START_MS;
          state.countdown = Math.min(state.countdown, 0.6);
          notify('False start  ·  three seconds');
        }
      } else {
        state.elapsedMs += dt * 1000;
        if (route) races.judge();
      }
      for (let i = 0; i < gates.length; i++) {
        const g = gates[i];
        const d = Math.hypot(g.gate.x - is[0], g.gate.z - is[1]);
        g.obj.visible = d < 420;
        g.obj.matrix[4] = 1;
      }
      if (cars) {
        for (let i = 0; i < cars.length; i++) {
          const t = lapOf[i];
          // A car the street took back mid-race (it fell behind the field and was parked, which is what
          // traffic does to anybody who stops being relevant) is out: it is not scored, not ranked, and
          // not held on the road by an order any more.
          const car = cars[i].car;
          if (!car || !car.driver || !car.box) { t.dead = 1; t.out = 0; continue; }
          const p = [car.box.pos[0], car.box.pos[2]];
          if (!t.was) { t.was = p; continue; }
          if (route) for (let g = 0; g < route.gates.length; g++) {
            if (g !== t.passed % route.gates.length) continue;
            if (crossing(route.gates[g], t.was, p)) t.passed++;
          }
          t.was = p;
          t.out = state.countdown > 0 ? 0 : t.out + dt;
        }
      }
      races.rank();
      was[0] = is[0]; was[1] = is[1];
    },

    /** The whole course, for the finish: every gate counted, and then the race is over. */
    get gates() { return route ? route.gates : []; },

    /** Which gate the player went through, if any. */
    judge() {
      const gatesOf = route.gates, n = gatesOf.length;
      const want = gatesOf[state.passed % n];
      if (crossing(want, was, is)) {
        const ms = state.elapsedMs + state.penaltyMs;
        times.push(ms);
        state.passed++;
        if (state.passed % n === 0 && state.lap < state.laps) {
          state.lap++;
          notify(`Lap ${state.lap} of ${state.laps}  ·  ${formatTime(ms - (times.length > 1 ? times[times.length - 2] : 0))}`);
        }
        if (state.passed >= n * state.laps) races.finish(ms);
      }
    },

    finish(ms) {
      state.finished = true;
      state.lastMs = ms;
      state.elapsedMs = ms;
      const best = readBest(store, state.tier);
      if (!best.ms || ms < best.ms) {
        writeBest(store, state.tier, { ms, at: Date.now() });
        state.bestMs = ms;
        notify(`${state.name}  ·  new record ${formatTime(ms)}${state.penaltyMs ? ' (with penalties)' : ''}`);
      } else {
        state.bestMs = best.ms;
        notify(`${state.name}  ·  ${formatTime(ms)}, best is ${formatTime(best.ms)}`);
      }
      races.rank();
      // The purse is settled the moment the field is: the money was on the street before the flag and
      // the result only says which car it goes to. Collecting it is the caller's business (game.js).
      state.payout = Math.max(0, Math.round(state.purse * shareFor(state.place, state.field)));
      notify(state.place === 1
        ? `You took the flag and the purse · $${state.payout.toLocaleString('en-US')}`
        : `P${state.place || '?'} of ${state.field} · ${state.payout ? `$${state.payout.toLocaleString('en-US')} to take` : 'the field took the purse'}`);
      // The field goes back to being traffic, and the board goes up: the course itself stays in place
      // until the next start, so the result and the gates can still be read after the flag.
      if (cars && traffic.releaseFromRace) traffic.releaseFromRace(cars);
      cars = null;
      state.active = false;
    },

    /** Who is where: the player and the field, ordered by gates passed and then by nearness to next. */
    /**
     * Who is where. Gates passed decide it; two cars on the same gate are split by who is nearer to
     * the next one, which is the only ordering the street can actually observe. After the flag the
     * finish time settles it, and the course is not consulted again.
     */
    rank() {
      if (!route) return;
      const n = route.gates.length;
      const mine = state.passed;
      let ahead = 0;
      for (let i = 0; i < (cars ? cars.length : 0); i++) {
        const t = lapOf[i];
        if (!t || t.dead) continue;
        if (t.passed > mine) { ahead++; continue; }
        if (t.passed < mine) continue;
        const g = route.gates[mine % n];
        const box = cars[i].car ? cars[i].car.box : null;
        if (!g || !box) continue;
        const theirs = Math.hypot(g.x - box.pos[0], g.z - box.pos[2]);
        const mineD = Math.hypot(g.x - is[0], g.z - is[1]);
        if (theirs < mineD) ahead++;
      }
      state.field = (cars ? cars.length : 0) + 1;
      state.place = Math.min(ahead + 1, state.field);
      let running = 1;
      for (const t of lapOf) if (t && !t.dead) running++;
      state.running = running;
    },

    /** What the HUD row reads, and what a test reads. */
    snapshot() {
      const n = route ? route.gates.length : 0;
      return {
        active: state.active, finished: state.finished, name: state.name, tier: state.tier,
        countdown: state.active ? Math.max(0, state.countdown) : 0,
        passed: state.passed, total: n * state.laps, lap: state.lap, laps: state.laps,
        elapsedMs: Math.round(state.elapsedMs), penaltyMs: state.penaltyMs,
        toNext: state.active ? nextDistance() : 0,
        place: state.place, field: state.field, lastMs: state.lastMs, bestMs: (readBest(store, state.tier) || {}).ms || state.bestMs,
        opponents: state.opponents, running: state.running, length: Math.round(state.distance),
        purse: state.purse, payout: state.payout, paid: state.paid,
        // Why a street would not lay a course, or why this one ended: 'no road', 'no course', ''. A
        // script that sees a race with no gates passed needs this, not a guess.
        last: state.last,
      };
    },
  };
  return races;
}

/** The record for a tier, in the browser's own store where there is one. */
export function readBest(store, tier) {
  if (!store || !tier) return {};
  try {
    const raw = store.getItem(`vice86.race.${tier}`);
    const v = raw ? JSON.parse(raw) : null;
    return v && Number.isFinite(v.ms) ? v : {};
  } catch {
    return {};
  }
}

export function writeBest(store, tier, value) {
  if (!store || !tier) return false;
  try {
    store.setItem(`vice86.race.${tier}`, JSON.stringify(value));
    return true;
  } catch {
    return false;                      // private mode, a full quota: the race still happened
  }
}
