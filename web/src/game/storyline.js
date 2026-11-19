// The storyline: the jobs the street has for a man with a car and no questions.
//
// A race is a closed loop with a flag at the end (game/races.js). A job is not. It is a meeting at a
// kerb, a name, a thing to do somewhere else in the city, and money when it is done - and the next
// meeting is somewhere the last one was not, so the story walks the player across the map rather than
// around one circuit. That is the dynamic part: the offers are laid on the real lane graph, a job's
// destination is drawn from the same graph a few kilometres away, and which job comes next depends on
// which one was just finished, so no two drives tell it in the same order.
//
// The money is the purse's (game/money.js), the heat is the ledger's (game/wanted.js), and the marker
// is one beacon mesh moved to whoever is being pointed at. Nothing here simulates a car or draws a
// building; it only knows where the road is, what the player owes, and what to say next.

import { hash01 } from '../core/math.js';
import { samplePoint, laneYaw } from './lanes.js';
import { MeshBuilder } from '../core/mesh.js';
import { Skin } from '../vehicles/traffic/skin.js';
import { box, rod } from '../vehicles/traffic/kit.js';
import * as mt from '../vehicles/traffic/materials.js';

/** metres: how close to a beacon the player must be for it to be the one in hand. */
export const OFFER_REACH = 7;
/** metres: how close to a destination counts as arrived. */
export const ARRIVE_REACH = 12;
/** The jobs on offer, by how far they send you and what they pay. */
export const JOBS = Object.freeze([
  { id: 'courier', name: 'the courier run', verb: 'Drive the package to', pay: 220, dist: 700, heat: 0 },
  { id: 'delivery', name: 'the late delivery', verb: 'Get the car to', pay: 380, dist: 1200, heat: 0 },
  { id: 'collection', name: 'the collection', verb: 'Collect the envelope at', pay: 300, dist: 900, heat: 0 },
  { id: 'boost', name: 'the boost', verb: 'Lift a car and leave it at', pay: 640, dist: 1400, heat: 1 },
  { id: 'heat', name: 'the hot run', verb: 'Run the block and reach', pay: 900, dist: 1800, heat: 2 },
]);
/** The names the street uses for the man at the kerb, so a job is a person and not a waypoint. */
export const CONTACTS = Object.freeze(['Rico', 'Delia', 'Sunny', 'Marta', 'Cole', 'Vera', 'Hoyt', 'Nadia']);

/** The beacon: a slim post with a lamp head, tall enough to read over a parked van. */
export function buildBeaconMesh() {
  const mb = new MeshBuilder(400);
  const sk = new Skin(mb);
  const post = mt.fixed(mt.hex ? mt.hex(0x2b2d31) : [0.17, 0.18, 0.19]);
  const lamp = mt.trim(0.6, [0.95, 0.78, 0.2]);
  box(sk, post, [0, 1.5, 0], [0.07, 1.5, 0.07], {});
  box(sk, lamp, [0, 3.05, 0], [0.16, 0.12, 0.16], {});
  rod(sk, post, [0, 0, 0], [0, 0.06, 0], 0.34, 8, true);
  return mb.finish();
}

/**
 * @param {{
 *   graph?: object, renderer?: object, purse?: object, wanted?: object,
 *   seed?: number, land?: number, toast?: (t: string) => void, offers?: number,
 * }} deps
 */
export function createStoryline(deps = {}) {
  const graph = deps.graph || null;
  const renderer = deps.renderer || null;
  const purse = deps.purse || null;
  const wanted = deps.wanted || null;
  const land = deps.land === undefined ? 1.2 : deps.land;
  const toast = deps.toast || (() => {});
  const seed = (deps.seed | 0) || 7;
  const out = [0, 0, 0];

  /** A point on the road graph: the nearest long road lane to a guess, then a station along it. */
  function roadPoint(gx, gz, rng) {
    if (!graph || typeof graph.nearest !== 'function') return null;
    const lane = graph.nearest(gx, gz, 90, (l) => !l.junction && l.junctionId < 0 && l.length > 24);
    if (!lane || !(lane.length > 0)) return null;
    const s = Math.max(2, Math.min(lane.length - 2, rng * lane.length));
    samplePoint(lane, s, out);
    return { x: out[0], z: out[2], yaw: laneYaw(lane, s), lane };
  }

  // Lay the offers on a ring around the map's middle, each on the road nearest its spoke, so that
  // the jobs are spread across the city rather than bunched where the player happens to start.
  const offers = [];
  const n = Math.max(3, deps.offers || 6);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rad = 220 + (i % 3) * 160;
    const p = roadPoint(Math.sin(a) * rad, Math.cos(a) * rad, hash01(seed, i, 3));
    if (!p) continue;
    offers.push({
      id: i, x: p.x, z: p.z, yaw: p.yaw,
      contact: CONTACTS[(i * 3 + seed) % CONTACTS.length],
      taken: false,
    });
  }

  let handle = -1, obj = null, meshFailed = false;
  let active = null;          // { job, contact, x, z, yaw, objective }
  let done = 0, earned = 0;

  /** The one beacon, raised once and moved to whoever is being pointed at (races.js does the same). */
  function ensureMesh() {
    if (obj || meshFailed || !renderer) return !!obj;
    try {
      handle = renderer.createMesh(buildBeaconMesh(), { retain: true });
      if (handle < 0) { meshFailed = true; return false; }
      obj = renderer.addDynamic({ mesh: handle, castShadow: false });
      obj.visible = false;
    } catch (error) { meshFailed = true; console.error('The storyline could not raise its beacons', error); }
    return !!obj;
  }

  /** The job an offer hands over, drawn from the ring so the story never repeats itself in order. */
  function jobFor(offer) {
    const j = JOBS[(offer.id + done) % JOBS.length];
    // The destination is a road point roughly `j.dist` metres away, on the far side of the map.
    const a = hash01(seed, offer.id, done + 11) * Math.PI * 2;
    const target = roadPoint(offer.x + Math.sin(a) * j.dist, offer.z + Math.cos(a) * j.dist, hash01(seed, done, offer.id));
    return { job: j, target: target || { x: offer.x, z: offer.z + j.dist, yaw: 0 } };
  }

  const storyline = {
    get offers() { return offers; },
    get active() { return active; },
    get completed() { return done; },
    get earned() { return earned; },

    /** The offer nearest this point, if one is within reach and no job is in hand. */
    offerAt(x, z) {
      if (active) return null;
      let best = null, bd = OFFER_REACH;
      for (const o of offers) {
        const d = Math.hypot(o.x - x, o.z - z);
        if (d < bd) { bd = d; best = o; }
      }
      return best;
    },

    /** Stand on a beacon: the job is taken, the marker moves to the destination, the story moves on. */
    take(offer) {
      if (active || !offer) return null;
      const { job, target } = jobFor(offer);
      offer.taken = true;
      active = {
        job, contact: offer.contact, x: target.x, z: target.z, yaw: target.yaw,
        objective: `${job.verb} ${offer.contact}'s marker`,
      };
      if (job.heat && wanted && wanted.add) wanted.add(job.id, job.heat);
      toast(`${offer.contact}: ${job.name} - ${job.verb} the marker`);
      return active;
    },

    /**
     * One frame: is the player at an offer, or at the destination of the job in hand? Returns what
     * happened so the caller can say it and pay it.
     */
    update(x, z) {
      if (!active) {
        const offer = storyline.offerAt(x, z);
        if (offer) return { kind: 'offer', offer };
        return null;
      }
      const d = Math.hypot(active.x - x, active.z - z);
      if (d <= ARRIVE_REACH) {
        const pay = active.job.pay;
        if (purse && purse.add) purse.add(pay, 'job');
        earned += pay; done++;
        const who = active.contact;
        active = null;
        toast(`${who}: that's the job done - $${pay}`);
        return { kind: 'done', pay, contact: who };
      }
      return { kind: 'active', distance: d, objective: active.objective };
    },

    /** Where the single beacon stands this frame: the job in hand, or the offer nearest the player. */
    beaconAt(x, z) {
      if (!ensureMesh()) return null;
      const target = active || storyline.offerAt(x, z);
      if (!target) { obj.visible = false; return null; }
      const yaw = target.yaw || 0;
      obj.matrix[0] = Math.cos(yaw); obj.matrix[2] = -Math.sin(yaw);
      obj.matrix[8] = Math.sin(yaw); obj.matrix[10] = Math.cos(yaw);
      obj.matrix[12] = target.x; obj.matrix[13] = land; obj.matrix[14] = target.z;
      obj.visible = true;
      return target;
    },

    /** The line the HUD shows: the job in hand, or the count of work at the kerb. */
    snapshot() {
      if (active) return { active, objective: active.objective, offered: [] };
      return { active: null, objective: '', offered: offers.filter((o) => !o.taken) };
    },
  };

  return storyline;
}
