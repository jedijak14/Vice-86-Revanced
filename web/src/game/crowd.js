// The crowd: the people on the pavements of Paloma Drive.
//
// A street with nobody walking on it is a car park with palm trees. The release ships traffic, parked
// cars, lamps and birds, and no pedestrians — so this adds them, on the terms everything else in the
// fork is added: the lane graph says where the pavements are, the vendored models say what a body looks
// like (world/people/cast.js, and web/assets/models with its licence manifest), and nothing here has a
// collider, a
// kinematic body or an opinion about the player's car. A crowd you could not drive through would be
// wrong in a world with real physics, so instead the crowd *answers* the car: it stops, turns to look
// and steps back from anything that comes at it on the wrong side of the kerb, and the police notice
// (game/wanted.js).
//
// Where a person walks is worked out once, from the road, and never re-litigated per frame:
//   - a lane of the graph that is not a junction connector is a stretch of pavement-carrying road;
//   - marching outboard from its centre line until the plan's carriageway distance says the kerb is
//     behind you lands on the pavement, at the width that road was actually built with;
//   - a person walks their lane, waits at the ends, and is quietly moved to another lane near the
//     player when they have wandered too far. They never cross a junction: waiting at the corner is
//     what a background crowd should do, and it is why nothing here can step out in front of a car.

import { m4fromYawPos, clamp, lerp, makeRng, hash01, TAU } from '../core/math.js';
import { samplePoint, laneYaw } from './lanes.js';
import { newPerson, WARDROBE } from '../world/people/cast.js';
import { Sample } from '../world/plan/field.js';
import { MeshBuilder } from '../core/mesh.js';
import { Skin } from '../vehicles/traffic/skin.js';
import { box } from '../vehicles/traffic/kit.js';
import * as mt from '../vehicles/traffic/materials.js';

/** Metres: how far from the player a person is kept at all. */
export const CROWD_KEEP = 132;
/** Metres: within this, a person gets their own limbs and a walk cycle. */
/**
 * How far a person is worth animating: within this radius somebody is drawn from their model, with a rig
 * that moves; outside it they are not drawn at all. A pedestrian at 40 m is a dozen pixels tall, and what
 * the street used to put there instead -- a box, walking -- is the thing this whole file replaced.
 */
export const ARTICULATE_AT = 34;
/** The radius a body will be carried past rather than leaving the street without one (see `step`). */
export const ARTICULATE_FAR = 96;
/** The ring new people are put down in: near enough that the street is inhabited where you are looking. */
export const SPAWN_NEAR = 58;
/** Seconds a person at a corner keeps waving before they give up on the traffic. */
export const HAIL_PATIENCE = 26;
/** The odds, per six seconds of waiting, that somebody decides they need a cab. */
export const HAIL_ODDS = 0.16;
/** The carriageway edge is behind you once the plan's distance is above this. */
const KERB_A = 0.05;
/** How far outboard to look for a pavement before giving up on that side of that lane, metres. */
const SEARCH_OUT = 7.5;
/** A person stands this far in from the kerb line, so their feet are not in the gutter. */
const PAVE_INNER = 0.95;
/** The width the crowd is given to walk in: enough to keep two people apart, no more than a pavement. */
const PAVE_WIDTH = 2.2;
/** Seconds between the two slow lookups: what the car is doing, and which way to face. */
const THINK_SECONDS = 0.14;
/** The stride a person's walk cycle is measured against, metres per full cycle (game/wanted.js reads it too). */
const STRIDE_METRES = 1.34;

/** How many people, and how many of them with limbs, at each traffic density the settings offer. */
export const CROWD_BY_DENSITY = Object.freeze([
  { peds: 0, articulated: 0 },
  { peds: 14, articulated: 6 },
  { peds: 30, articulated: 10 },
  { peds: 48, articulated: 14 },
]);

/** The same table by graphics preset: a slow machine spends its draw calls elsewhere. */
/** How many bodies are animated at once, per quality tier: a rigged person costs a skin solve every frame. */
export const PEOPLE_BY_TIER = Object.freeze({ ultraLow: 2, low: 5, medium: 9, high: 13, ultra: 18 });

/**
 * Where the pavement is beside one lane, at one station, on one side.
 * @param {object} lane         a lane record of the prepared graph
 * @param {number} s            station along it
 * @param {number} side         1 = to the right of the direction of travel, -1 = to the left
 * @param {Function} carriageway (x, z) => signed metres to the kerb edge, negative on the carriageway
 * @returns {{off:number, room:number, yaw:number}|null} null where there is nowhere to walk
 */
export function pavementOffset(lane, s, side, carriageway, out = [0, 0, 0]) {
  const yaw = laneYaw(lane, s);
  // The outboard unit vector on the chosen side: the same pair the officer code uses for a kerb.
  const rx = -Math.cos(yaw) * side, rz = Math.sin(yaw) * side;
  samplePoint(lane, s, out);
  let kerb = -1;
  for (let d = 0.2; d <= SEARCH_OUT; d += 0.4) {
    if (carriageway(out[0] + rx * d, out[2] + rz * d) > KERB_A) { kerb = d; break; }
  }
  // Past the reach of the search the carriageway edge never arrived: the lane runs along open land
  // (a runway, a bridge deck), and there is no pavement to put anybody on.
  if (kerb < 0) return null;
  return { off: kerb + PAVE_INNER, room: PAVE_WIDTH, yaw };
}

/**
 * Whether a car is near enough, and coming, for a person to step back from.
 * @param {number} d      metres from the person to the car
 * @param {number} speed  the car's speed, m/s
 * @param {number} toward -1..1: how squarely the car is pointed at the person
 */
export function threat(d, speed, toward) {
  if (!(d > 0) || d > 9 || speed < 2.2) return 0;
  const near = clamp(1 - (d - 2.2) / 6.5, 0, 1);
  // Being aimed at makes it worse; it is not a gate. A car that passes two metres from your shoulder
  // at speed is a near miss whether or not the driver was steering at you.
  const aimed = clamp((toward - 0.2) / 0.8, 0, 1);
  return clamp(near * (0.55 + 0.45 * aimed) * clamp(speed / 7, 0, 1), 0, 1);
}

/** Two poses to blend the walk and the standing still with, reused per person. */

/**
 * @param {object} options
 * @param {object|null} options.graph   the prepared lane graph
 * @param {object|null} options.plan    the plan, for `field.sample`: the carriageway distance
 * @param {object} options.renderer     the renderer: `createMesh`, `addDynamic`
 * @param {number} [options.seed]
 * @param {number} [options.land]       the height of the flat street level
 * @param {(k: number) => void} [options.onEndanger] called with 0..1 when a car frightens somebody
 */
export function createCrowd({ graph, plan, renderer, seed = 7, land = 1.2, onEndanger = null, people: cast = null, quality = 'medium' } = {}) {
  const rng = makeRng(seed | 0);
  const lanes = graph && graph.lanes ? graph.lanes : [];
  const walkable = [];
  /** The same lanes as a set: the near-cell scan asks "is this one walkable?" once per segment found. */
  const walkableSet = new Set();
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i];
    // A junction connector is not a pavement: the graph marks the lanes that stand in a crossing,
    // and nobody walks there (see game/lanes.js, where `junction` is set for those lanes).
    if (lane.junction || lane.junctionId >= 0 || !(lane.length > 30)) continue;   // -1 means an ordinary road
    walkable.push(lane);
    walkableSet.add(lane);
  }
  // The plan's own sampler answers `a`: signed metres to the carriageway edge, negative on the road.
  const probe = plan && plan.sample ? new Sample() : null;
  const carriageway = probe ? (x, z) => { plan.sample(x, z, probe); return probe.a || 0; } : null;
  const live = walkable.length > 0 && !!carriageway && !!renderer;

  let density = 1, cap = 99, serial = 0;
  const people = [], spare = [];
  const scratch = [0, 0, 0];
  const car = { x: 0, z: 0, y: 0, yaw: 0, speed: 0 };
  let mark = -1, failed = false, qualityTier = quality;
  const idlePeople = [];                       // built bodies, parked: see takePerson and handPersonBack

  /** The one mesh that is not a person: the card a hailer holds up. */
  function ensureMark() {
    if (mark >= 0 || failed) return mark >= 0;
    try { mark = renderer.createMesh(buildHailMark(), { retain: true }); }
    catch (error) { failed = true; console.error('The crowd could not be uploaded to the renderer', error); }
    return mark >= 0;
  }

  /**
   * A body for one person: the same character and tint as last time if one is parked, because building a
   * person means uploading a few thousand vertices and nobody should pay that every time a pedestrian
   * drifts in and out of the animation radius.
   */
  function takePerson(p) {
    if (!cast || !cast.characters || !cast.characters.length) return null;
    const key = `${p.character}/${p.wardrobe}`;
    for (let i = 0; i < idlePeople.length; i++) {
      if (idlePeople[i].key === key) return idlePeople.splice(i, 1)[0].person;
    }
    try {
      return newPerson(renderer, cast, cast.characters[p.character % cast.characters.length], {
        wardrobe: WARDROBE[p.wardrobe % WARDROBE.length], seed: p.id,
      });
    } catch (error) {
      if (!failed) console.error('A pedestrian could not be built from the vendored models', error);
      failed = true;
      return null;
    }
  }

  function handPersonBack(p) {
    const person = p.person;
    if (!person) return;
    p.person = null;
    if (failed) { person.remove(); return; }
    person.visible(false);
    if (idlePeople.length < 24) idlePeople.push({ key: `${p.character}/${p.wardrobe}`, person });
    else person.remove();
  }

  /** Where a person is: their station on their lane, pushed out to the pavement. */
  function where(p, out = [0, 0, 0]) {
    if (!p.lane) { out[0] = p.x; out[1] = land; out[2] = p.z; return out; }   // parked, not walking
    samplePoint(p.lane, p.s, out);
    const yaw = laneYaw(p.lane, p.s);
    out[0] += -Math.cos(yaw) * p.side * p.off;
    out[2] += Math.sin(yaw) * p.side * p.off;
    out[1] = land;
    return out;
  }

  /** Put a person on a lane within reach of the player, at a station that has somewhere to walk. */
  /**
   * The lanes worth walking on near the player. An island has thousands of them and a crowd is a few
   * dozen, so picking one at random from the whole graph almost always picks a road at the horizon and
   * the person is thrown away: this reads the graph's own grid, a cell at a time, and is only redone
   * when the car has moved off the cells it was gathered from.
   */
  const nearby = [];
  let nearX = 1e9, nearZ = 1e9, nearAt = -9;
  function nearLanes(px, pz, radius, now) {
    if (nearby.length && now - nearAt < 2 && Math.hypot(px - nearX, pz - nearZ) < radius * 0.5) return nearby;
    nearby.length = 0;
    nearX = px; nearZ = pz; nearAt = now;
    if (!graph || typeof graph.segmentsAt !== 'function') {
      for (const lane of walkable) nearby.push(lane);
      return nearby;
    }
    const cell = 48;                                        // lanes.js: GRID_CELL
    const seen = new Set();
    const reach = Math.ceil(radius / cell);
    const cx0 = Math.floor(px / cell), cz0 = Math.floor(pz / cell);
    for (let cx = cx0 - reach; cx <= cx0 + reach; cx++) {
      for (let cz = cz0 - reach; cz <= cz0 + reach; cz++) {
        const list = graph.segmentsAt(cx * cell + cell * 0.5, cz * cell + cell * 0.5);
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const lane = lanes[list[k]];
          if (!lane || seen.has(lane.id) || !walkableSet.has(lane)) continue;
          seen.add(lane.id);
          nearby.push(lane);
        }
      }
    }
    // A street with no grid answer (a hand-made graph, a tile not streamed in yet) still gets a crowd.
    if (!nearby.length) for (const lane of walkable) nearby.push(lane);
    return nearby;
  }

  let clock = 0;

  function place(p, px, pz, radius, near = SPAWN_NEAR) {
    if (!live) return false;
    const pool = nearLanes(px, pz, radius, clock);
    for (let tries = 0; tries < 24; tries++) {
      const lane = pool[rng.int(0, pool.length - 1)];
      if (!lane) break;
      const s = rng.range(4, Math.max(5, lane.length - 4));
      const side = rng.next() < 0.5 ? 1 : -1;
      const spot = pavementOffset(lane, s, side, carriageway, scratch);
      if (!spot) continue;
      const x = scratch[0] + -Math.cos(spot.yaw) * side * spot.off, z = scratch[2] + Math.sin(spot.yaw) * side * spot.off;
      const dist = Math.hypot(x - px, z - pz);
      // Not under the player's wheels, and not at the horizon either: the ring a person may appear in is
      // the one the camera can actually reach, `near` (game.js re-asks at the full keep radius if this
      // stretch of street has nothing that close, which is what an empty pavement looks like).
      if (dist > near || dist < 14) continue;
      p.lane = lane; p.s = s; p.side = side; p.off = spot.off + hash01(p.id, 17) * (spot.room - 1.1);
      p.dir = rng.next() < 0.5 ? 1 : -1;
      p.character = cast && cast.characters ? rng.int(0, cast.characters.length - 1) : 0;
      p.wardrobe = rng.int(0, WARDROBE.length - 1);
      p.walk = 1.05 + hash01(p.id, 3) * 0.7;
      p.phase = hash01(p.id, 5);
      p.state = 'walk'; p.hold = 0; p.threat = 0; p.hailing = 0; p.look = 0;
      return true;
    }
    return false;
  }

  function detach(p) {
    handPersonBack(p);
    if (p.mark) { p.mark.remove(); p.mark = null; }
    p.articulated = false;
  }

  /**
   * What you actually see when somebody wants a cab: a card over their head on a thin post. It is not
   * billboarded — a crowd of those turning to face the camera every frame costs what it does not buy, and
   * a hail is a street sign anyway. The plate is glass, so it takes the world behind it; the mark on it
   * is paint, so it stays readable when the sun is on it.
   */
  function buildHailMark() {
    const mb = new MeshBuilder(400);
    const sk = new Skin(mb);
    const plate = mt.glass([0.95, 0.78, 0.22]);
    const ink = mt.fixed([1, 0.92, 0.52]);
    box(sk, plate, [0, 0.4, 0], [0.2, 0.3, 0.02], {});              // the card
    box(sk, ink, [0, 0.6, 0.03], [0.032, 0.13, 0.02], {});          // the stroke of the !
    box(sk, ink, [0, 0.43, 0.03], [0.032, 0.032, 0.02], {});        // and its dot
    box(sk, ink, [0, 0.1, 0], [0.013, 0.3, 0.013], {});             // the post
    return mb.finish();
  }

  /** The mark is worn by the person rather than kept in a list of its own: a pedestrian who leaves the
   *  street takes the sign with them, which is the only way a corner ends up without a hail over it. */
  function drawMark(p, moving) {
    if (!ensureMark()) return;
    if (!p.mark) {
      p.mark = renderer.addDynamic({ mesh: mark, castShadow: false, blend: true });
      if (!p.mark) return;
    }
    const m = p.mark.matrix;
    m[0] = 1; m[1] = 0; m[2] = 0; m[3] = 0;
    m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
    m[8] = 0; m[9] = 0; m[10] = 1; m[11] = 0; m[14] = 0; m[15] = 1;
    m[12] = p.x; m[14] = p.z;
    // It rises and falls with the walk, which is the whole of the far crowd's animation and enough to
    // read as something held up rather than something bolted to the pavement.
    m[13] = land + 1.66 + (moving ? Math.sin(p.phase * TAU * 2) * 0.03 : 0);
    p.mark.visible = true;
  }

  function retire(p) {
    detach(p);
    p.lane = null;
    spare.push(p);
  }

  function acquire(px, pz, radius, near) {
    const p = spare.pop() || {
      id: ++serial, lane: null, s: 0, side: 1, off: 1.2, dir: 1, walk: 1.2,
      phase: 0, x: px, z: pz, yaw: 0, state: 'walk', clock: 0, hold: 0, threat: 0, think: 0, hailClock: 0, patience: 0,
      hailing: 0, look: 0, person: null, mark: null, articulated: false, character: 0, wardrobe: 0,
    };
    return place(p, px, pz, radius, near) ? p : null;
  }

  /** A real body, from the vendored models, for the few the camera can read. */
  function promote(p) {
    if (!p.person) p.person = takePerson(p);
    if (!p.person) return false;
    p.person.visible(true);
    p.articulated = true;
    return true;
  }

  /** Out of the animation radius: the body goes back on the shelf, the person stays on the street. */
  function demote(p) {
    if (p.person) handPersonBack(p);
    p.articulated = false;
  }

  const crowd = {
    enabled: true,
    /** Whether the models are in: `false` means the street is walking about unseen, which is a defect. */
    get castReady() { return !!cast; },
    /** The cast arrives after boot (the models are a download); the crowd draws nobody until it does. */
    setCast(next) {
      for (const parked of idlePeople) parked.person.remove();
      idlePeople.length = 0;
      cast = next;
    },
    /** The quality tier, which is what decides how many bodies may be animated at once. */
    setQuality(preset) { qualityTier = preset || 'medium'; },
    density: 1,
    /** Placement attempts that found nowhere to walk: reported so that a street of a hundred lanes
     * holding four people is a number you can read, not a mystery (open land, a bridge, sea). */
    misses: 0,
    articulated: 0,
    /** Bodies currently in hand (drawn or parked on the shelf). */
    bodies() { return people.reduce((n, p) => n + (p.person ? 1 : 0), 0) + idlePeople.length; },
    /**
     * What the crowd put in front of the camera on the last frame it drew. A tool needs this because
     * `articulated: 1` alone cannot say whether that one body reached the renderer with triangles in it,
     * which is the difference between a quiet street and a crowd that quietly failed to load.
     */
    rendered: 0, triangles: 0,
    renderStats() { return { rendered: crowd.rendered, triangles: crowd.triangles }; },
    passenger: null,
    get count() { return people.length; },
    /** The people themselves, for a mission that wants to put somebody somewhere on purpose. */
    get people() { return people; },
    /** Where a person is standing, as the crowd sees it (their lane, their station, their kerb side). */
    at(p, out = [0, 0, 0]) { return where(p, out); },
    get live() { return live; },

    /** How many people, from the traffic the player asked for, and the preset's own cap on limbs. */
    setDensity(next, presetCap) {
      density = clamp(next | 0, 0, 3);
      if (presetCap !== undefined) cap = Math.max(0, presetCap | 0);
      crowd.density = density;
      const want = CROWD_BY_DENSITY[density].peds;
      while (people.length > want) retire(people.pop());
      if (!want) { while (people.length) retire(people.pop()); crowd.articulated = 0; }
    },

    reset() {
      while (people.length) retire(people.pop());
      crowd.articulated = 0;
      if (crowd.passenger) { handPersonBack(crowd.passenger); crowd.passenger = null; }
      // A reset is the street being thrown away -- a new game, another island, the garage. The parked
      // bodies go with it: a shelf of meshes for a crowd that no longer exists is a leak with a lid on it.
      for (const parked of idlePeople) parked.person.remove();
      idlePeople.length = 0;
    },

    /**
     * One frame of the street's own life.
     * @param {number} dt simulated seconds
     * @param {object} at { x, y, z, yaw, speed }: the player's car
     * @param {boolean} driving whether the game is out on the street at all
     */
    step(dt, at, driving = true) {
      if (!(dt > 0) || !live || !driving || !crowd.enabled) return;
      car.x = at.x; car.z = at.z; car.y = at.y || land; car.yaw = at.yaw; car.speed = at.speed || 0;
      clock += dt;
      const want = CROWD_BY_DENSITY[density].peds;
      // People arrive as the crowd thins. The rate is per second of game time rather than per frame:
      // on a slow machine two a frame is two every quarter of a second, and a street that takes half a
      // minute to fill up is a street that reads as empty at every speed the game can actually run at.
      const gap = want - people.length;
      const batch = gap > 0 ? clamp(Math.ceil(gap * dt / 0.35), 2, 14) : 0;
      // A spot that is not walkable is a miss, not a stop: a road whose pavement turns out to be sea,
      // or a carriageway the plan has not streamed yet, must not leave the street empty for a minute.
      for (let n = 0, tries = 0; n < batch && tries < batch * 4; tries++) {
        // The first ask is for the ring the camera is in; past a few tries the street is allowed to hand
        // out a pavement further off, because a crowd that only ever appears next to you reads as a magic
        // trick, and a queue of people waiting 90 m away to walk into frame is the street.
        const p = acquire(car.x, car.z, tries > 3 ? CROWD_KEEP : SPAWN_NEAR);
        if (p) { people.push(p); n++; }
      }
      // A rigged body is not free, so the tier says how many the street may animate at once
      // (`cap`, handed over with the preset by game.js) and the density says how many more are walking
      // about unseen. Bodies are not handed out by a queue: a person out of reach loses theirs to whoever
      // is nearer, and a body already held is a slot spent before this frame decides anything — that is
      // what makes `cap` a cap on what is animated rather than on what may be promoted.
      let limbs = cast ? Math.min(cap, CROWD_BY_DENSITY[density].articulated + 6) : 0;
      let held = 0;
      for (const p of people) if (p.articulated) held++;
      limbs = Math.max(0, limbs - held);
      crowd.articulated = 0;
      crowd.rendered = 0; crowd.triangles = 0;   // this frame's draw tally, recounted below
      for (let i = people.length - 1; i >= 0; i--) {
        const p = people[i];
        const w = where(p, scratch);
        p.x = w[0]; p.z = w[2];
        const d = Math.hypot(p.x - car.x, p.z - car.z);
        if (d > CROWD_KEEP) { retire(p); people.splice(i, 1); continue; }
        crowd.think(p, dt, d);
        // Inside the animation radius a body is worth it. Outside it one is handed out only when the
        // street would otherwise have none at all — a pavement of invisible people is the failure a player
        // notices, and one distant figure is worth more than a crowd you cannot see.
        const near = d < ARTICULATE_AT;
        const lonely = !crowd.articulated && d < ARTICULATE_FAR;
        if (p.articulated) {
          // Hysteresis: a held body is given up only past the wider ring, so a person standing on the
          // boundary is not trading a mesh with the shelf every other frame.
          if (near || (d < ARTICULATE_AT * 1.35 && crowd.articulated <= cap)) {
            crowd.articulated++; if (limbs > 0) limbs--;
          } else demote(p);
        } else if ((near || lonely) && limbs > 0) {
          if (promote(p)) { limbs--; crowd.articulated++; }
        }
        crowd.draw(p, dt, d);
      }
      crowd.drawPassenger();
    },

    /** Where they are going, whether to wait, and what the car is doing about them. */
    think(p, dt, d) {
      p.clock += dt;
      p.think -= dt;
      if (p.think <= 0) {
        p.think = THINK_SECONDS;
        // The only threat that matters is the player's own car: the crowd is walked, not simulated,
        // and flinching at a car that is not there would look worse than standing still.
        const dx = p.x - car.x, dz = p.z - car.z, len = Math.max(1, Math.hypot(dx, dz));
        const toward = (Math.sin(car.yaw) * dx + Math.cos(car.yaw) * dz) / len;
        p.threat = threat(len, car.speed, toward);
        p.look = clamp(-dx * Math.cos(car.yaw) + dz * Math.sin(car.yaw), -1, 1) * 0.6;
        if (p.threat > 0.55) { p.hold = Math.max(p.hold, 0.8 + p.threat); if (onEndanger) onEndanger(p.threat); }
        if (p.threat > 0.3 && p.state === 'walk') p.state = 'startle';
        // Wanting a cab is the crowd's own business, not a mission's. A person at the kerb, not being
        // hurried past by anybody, tries their luck every so often — which is what the mark over their
        // head is for, and the only reason a driver has to look at a pavement.
        if (!p.hailing && p.threat < 0.12 && (p.state === 'walk' || p.state === 'hold')
            && hash01(p.id, Math.floor(p.clock / 6)) < HAIL_ODDS) {
          p.state = 'hail'; p.hold = 1e3; p.hailing = 1; p.hailClock = 0;
          p.patience = HAIL_PATIENCE * (0.55 + 0.9 * hash01(p.id, 13));
        }
      }
      if (p.state === 'walk') {
        const ahead = p.s + p.dir * p.walk * dt;
        if (ahead < 3 || ahead > p.lane.length - 3) { p.state = 'hold'; p.hold = 1.5 + hash01(p.id, 9) * 4; return; }
        p.s = ahead;
        p.phase = (p.phase + p.walk * dt / STRIDE_METRES) % 1;
        p.yaw = laneYaw(p.lane, p.s) + (p.dir < 0 ? Math.PI : 0) + p.side * 0.1;
      } else if (p.state === 'hold') {
        // At the end of the pavement they wait, then turn back: nobody crosses a junction, and
        // nobody walks off the world either.
        p.hold -= dt;
        if (p.hold <= 0) { p.state = 'walk'; p.dir *= -1; }
      } else if (p.state === 'startle') {
        p.hold -= dt;
        if (p.threat < 0.2 && p.hold <= 0) p.state = p.hailing ? 'hail' : 'walk';
      } else if (p.state === 'hail') {
        // Standing at the kerb with an arm out is not a permanent condition: the arm comes down, the
        // person walks on, and the mark goes with the arm rather than being taken away by a janitor.
        p.hold -= dt;
        if (p.hold <= 0 || !p.hailing) { p.state = 'walk'; p.dir *= -1; p.hailing = 0; p.hailClock = 0; }
      }
      if (p.hailing > 0) {
        p.hailClock = (p.hailClock || 0) + dt;
        if (p.hailClock > (p.patience || HAIL_PATIENCE)) p.hailing = 0;
      }
    },

    /**
     * What a state of the street looks like on a body. The names are the cast's roles, which are the
     * vendored clips: `walk` is KayKit's Walking_A, and one cycle of it is one stride, so the feet land
     * where the pavement says they should rather than where the clock says.
     */
    roleFor(p) {
      if (p.state === 'walk') return p.walk > 1.55 ? 'run' : 'walk';
      if (p.state === 'startle') return 'startle';
      return null;
    },

    draw(p, dt, d) {
      const moving = p.state === 'walk' ? 1 : 0;
      const yaw = p.yaw || laneYaw(p.lane, p.s);
      const person = p.person;
      if (person) {
        person.place(p.x, land, p.z, yaw);
        const role = crowd.roleFor(p);
        if (role) person.role(role);
        if (p.hailing > 0) person.role('wave', { upper: true });
        person.frame(dt, moving ? p.walk * dt : 0);
        crowd.rendered++; crowd.triangles += (person.stats && person.stats.triangles) || 0;
      }
      // Only somebody actually waving gets a mark: a street of cards is a street of noise, and a fare is
      // worth finding precisely because the person wanting it is the one holding it up.
      if (p.hailing > 0) drawMark(p, moving || 1);
      else if (p.mark) p.mark.visible = false;
    },

    /** The fare in the back seat rides with the car, not with the world. */
    drawPassenger() {
      const seat = crowd.passenger;
      if (!seat) return;
      if (!seat.person) seat.person = takePerson(seat);
      const person = seat.person;
      if (!person) return;
      // A step to the left of the driver, the way a 1986 saloon's front bench takes a second person, and
      // the seated clip: a fare with straight legs down in the footwell is a bug wearing a body.
      const x = car.x + Math.cos(car.yaw) * 0.42, z = car.z - Math.sin(car.yaw) * 0.42;
      person.place(x, car.y + 0.02, z, car.yaw);
      person.role('sit');
      person.frame(0, 0);
      crowd.rendered++; crowd.triangles += (person.stats && person.stats.triangles) || 0;
      person.visible(true);
    },

    /** The nearest person to a point, waving or not — a street job wants a body to send somewhere. */
    nearest(x, z, radius = 40) {
      let best = null, bd = radius * radius;
      for (const p of people) {
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },

    /** The nearest person holding their arm out, or null. */
    nearestHail(x, z, radius = 90) {
      let best = null, bd = radius * radius;
      for (const p of people) {
        if (!p.hailing) continue;
        const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
        if (d < bd) { bd = d; best = p; }
      }
      return best;
    },

    /** Put an arm out for the nearest person to a point: a mission's way of placing a fare. */
    makeHailer(x, z) {
      let best = null, bd = 1e9;
      for (const p of people) {
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) { bd = d; best = p; }
      }
      if (!best || bd > 30) return null;
      best.hailing = 1; best.state = 'hail'; best.hold = 1e4; best.hailClock = 0; best.patience = 1e4;
      return best;
    },

    /** Somebody into the back seat: they stop being a pedestrian and become a passenger. */
    board(p) {
      if (!p) return null;
      // The fare keeps their character and their tint: a passenger who changed clothes on the way to the
      // car would be a rendering bug, not a costume change.
      const seat = { p, person: null, character: p.character, wardrobe: p.wardrobe };
      crowd.passenger = seat;
      const i = people.indexOf(p);
      if (i >= 0) { detach(p); people.splice(i, 1); spare.push(p); }
      return seat;
    },

    /** And back onto the pavement, where they were asked to be. */
    alight(x, z) {
      const seat = crowd.passenger;
      if (!seat) return null;
      if (seat.person) handPersonBack(seat);
      crowd.passenger = null;
      const p = seat.p;
      if (!p.lane) { if (!place(p, x, z, 40)) return p; }
      p.state = 'hold'; p.hold = 7 + hash01(p.id, 7) * 9; p.hailing = 0;
      if (people.indexOf(p) < 0) people.push(p);
      return p;
    },

    snapshot() {
      let hailing = 0, startled = 0;
      for (const p of people) { if (p.hailing) hailing++; if (p.threat > 0.3) startled++; }
      return {
        peds: people.length, articulated: crowd.articulated, cast: !!cast, bodies: crowd.bodies(), density, hailing, startled,
        passenger: !!crowd.passenger,
        // What the crowd has to work with: the streets it was offered, and the ones near the car now.
        streets: nearby.length, walkable: walkable.length, misses: crowd.misses,
      };
    },
  };


  return crowd;
}

