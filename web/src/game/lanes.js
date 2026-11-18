// Lane graph runtime: turns the plan's lane records into something drivers can query quickly.
//
// Input (world.plan.laneGraph, see design/ARCHITECTURE.md 9.1 and the lead's lane contract):
//   lanes[i] = { id, pts: Float32Array (x, y, z triples along the direction of travel), length,
//                speedLimit (m/s), width, next: [lane ids], junction (-1 or id), turn (0 straight,
//                1 left, 2 right, 3 u-turn), control: null | { junction, kind, group }, ... }
//   junctions[j] = { id, x, z, radius, control, groups, lenses: Float32Array(n * 8) }
//
// Added here: cumulative distances for sampling by station, predecessor lists, a speed profile
// that has every bend taken at a comfortable speed and braked for in time, a spatial grid of
// lane segments, and what the drivers need to share a junction, all from geometry alone and
// computed on first use: the conflicts between its connector lanes, and for every lane that
// leads into it the point where a waiting vehicle is out of everybody else's way.
//
// Two properties a plan may have are dealt with here so that the driver model can stay simple:
//   - Junctions joined by a stretch of road shorter than a vehicle. Whoever waits on such a
//     stretch stands in the junction behind, so the junctions are crossed as one: the paths
//     through them are joined into single connector lanes of one shared junction.
//   - Roads that meet at a shallow angle. The end of such a lane can lie inside the path of
//     another, so vehicles wait further back (`holdBack`), and the last metres of the lane
//     count as part of the crossing when conflicts are worked out.

import { clamp } from '../core/math.js';

const GRID_CELL = 48; // metres
/** Two lane centre lines closer than this cannot be used by two vehicles at once. */
const CONFLICT_DISTANCE = 2.6;
/** Lateral acceleration a traffic driver accepts in a bend, m/s^2. */
const COMFORT_LATERAL = 2.3;
const MIN_BEND_SPEED = 3.2; // m/s: even a hairpin is taken at walking-plus pace
/** Deceleration the speed profile assumes when slowing for a bend, m/s^2. */
export const COMFORT_BRAKING = 1.8;

/**
 * A stretch of road between two junctions must hold the longest vehicle (a bus, about 12 m)
 * with its tail out of the junction behind and its bumper short of the line ahead. Anything
 * shorter is crossed together with the junctions at its ends.
 */
export const MIN_LINK_LENGTH = 14;
/** Furthest a waiting point is moved back from the end of a lane, metres. */
const HOLD_BACK_MAX = 30;
const HOLD_BACK_STEP = 0.5;
/** A lane is never held back so far that less than this is left of it, metres. */
const HOLD_BACK_KEEP = 8;
// Total change of heading through a junction, radians: below the first it is no turn at all,
// above the second it is a turn back the way the vehicle came.
const STRAIGHT_BELOW = 0.52, UTURN_ABOVE = 2.62;

export const TURN = Object.freeze({ STRAIGHT: 0, LEFT: 1, RIGHT: 2, UTURN: 3 });

const cellKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

/**
 * @param {{lanes: object[], junctions: object[]}} raw
 * @returns {LaneGraph}
 */
export function prepareLaneGraph(raw) {
  raw = mergeCloseJunctions(raw);
  const lanes = raw.lanes.map((source, index) => prepareLane(source, index));
  for (const lane of lanes) {
    for (const id of lane.nextIds) {
      const next = lanes[id];
      if (!next) throw new Error(`lane graph: lane ${lane.id} lists a successor ${id} that does not exist`);
      lane.next.push(next);
      next.prev.push(lane);
    }
  }
  const junctions = (raw.junctions || []).map((j) => ({
    id: j.id, x: j.x, z: j.z, radius: j.radius || 12,
    control: j.control || 'none', groups: Math.max(1, j.groups || 1),
    lenses: j.lenses || new Float32Array(0),
    /** Id of the junction that this one is crossed together with (itself, normally). */
    zone: j.zone === undefined ? j.id : j.zone,
    /** Circle that contains every connector lane held here: centre and radius. */
    area: { x: j.x, z: j.z, radius: j.radius || 12 },
    connectors: [],
    /** Drivers that hold the right to cross: maintained by the driver model. */
    granted: [],
    /** Drivers asking to cross during the current step. */
    requests: [],
    conflictsReady: false,
  }));
  const junctionById = new Map(junctions.map((j) => [j.id, j]));
  for (const lane of lanes) {
    if (lane.junctionId >= 0) {
      // A connector belongs to the junction that hands out the right to cross it, which for
      // junctions crossed together is one of them. Signals stay with their own junction.
      const own = junctionById.get(lane.junctionId);
      lane.junction = own ? junctionById.get(own.zone) || own : null;
      if (lane.junction) lane.junction.connectors.push(lane);
    }
    if (lane.control) lane.control.junctionRef = junctionById.get(lane.control.junction) || null;
  }
  for (const junction of junctions) {
    const host = junctionById.get(junction.zone);
    if (!host || host === junction) continue;
    // Grow the host's circle to take in this member.
    const a = host.area, d = Math.hypot(junction.x - a.x, junction.z - a.z);
    if (d + junction.radius <= a.radius) continue;
    const radius = Math.max(junction.radius, 0.5 * (a.radius + d + junction.radius));
    const t = d > 0 ? (radius - a.radius) / d : 0;
    a.x += (junction.x - a.x) * t;
    a.z += (junction.z - a.z) * t;
    a.radius = radius;
  }
  return new LaneGraph(lanes, junctions);
}

/**
 * Joins junctions that are closer together than a vehicle is long. Returns lane and junction
 * records in which every path through such a group is one connector lane (the connectors and
 * the short stretches between them, end to end) and the junctions of the group name one of
 * themselves as their `zone`. The input is returned untouched if there is nothing to join.
 */
function mergeCloseJunctions(raw) {
  const lanes = raw.lanes;
  const isConnector = (lane) => lane.junction !== undefined && lane.junction >= 0;
  const nextOf = (lane) => lane.next || [];
  const prev = lanes.map(() => []);
  lanes.forEach((lane, i) => { for (const n of nextOf(lane)) if (prev[n]) prev[n].push(i); });
  const isLink = lanes.map((lane, i) => !isConnector(lane) && prev[i].length > 0 && nextOf(lane).length > 0
    && prev[i].every((p) => isConnector(lanes[p])) && nextOf(lane).every((n) => lanes[n] && isConnector(lanes[n]))
    && polylineLength(lane.pts) < MIN_LINK_LENGTH);
  if (!isLink.includes(true)) return raw;

  // Groups of junctions, as a union-find over junction ids; the lowest id speaks for a group.
  const parent = new Map();
  const find = (id) => { let root = id; while (parent.has(root)) root = parent.get(root); return root; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent.set(Math.max(a, b), Math.min(a, b)); };
  lanes.forEach((lane, i) => { if (isLink[i]) join(lanes[prev[i][0]].junction, lanes[lane.next[0]].junction); });

  // Paths through a group: from a connector entered from ordinary road, across links and
  // further connectors, until a connector lets out onto ordinary road again.
  const fromLink = (i) => prev[i].some((p) => isLink[p]);
  const intoLink = (i) => nextOf(lanes[i]).some((n) => isLink[n]);
  const paths = new Map(); // entry connector -> paths, each a list of lane indices
  const walk = (path, seen, once, found) => {
    const exits = nextOf(lanes[path[path.length - 1]]);
    if (!exits.some((n) => isLink[n])) { found.push(path.slice()); return; }
    for (const link of exits) {
      if (!isLink[link]) continue;
      for (const connector of lanes[link].next) {
        // A path that came back to a junction it has crossed would be a lap of the group.
        const mark = once ? lanes[connector].junction : link;
        if (seen.includes(mark)) continue;
        path.push(link, connector); seen.push(mark);
        walk(path, seen, once, found);
        path.length -= 2; seen.pop();
      }
    }
  };
  lanes.forEach((lane, i) => {
    if (!isConnector(lane) || fromLink(i) || !intoLink(i)) return;
    const found = [];
    walk([i], [lane.junction], true, found);
    // Where every way out is such a lap, a lap it has to be: no lane may be left without one.
    if (found.length === 0) walk([i], [], false, found);
    paths.set(i, found);
  });

  const keep = lanes.map((lane, i) => !isLink[i] && !(isConnector(lane) && (fromLink(i) || intoLink(i))));
  const index = new Int32Array(lanes.length).fill(-1);
  let count = 0;
  keep.forEach((kept, i) => { if (kept) index[i] = count++; });
  const joined = [], joinedIds = new Map();
  for (const [entry, found] of paths) {
    joinedIds.set(entry, found.map((path) => {
      joined.push(joinPath(lanes, prev, path, index));
      return count++;
    }));
  }
  const out = [];
  lanes.forEach((lane, i) => {
    if (!keep[i]) return;
    const next = [];
    for (const n of nextOf(lane)) {
      if (keep[n]) next.push(index[n]);
      else if (joinedIds.has(n)) next.push(...joinedIds.get(n));
    }
    out.push({ ...lane, next });
  });
  out.push(...joined);
  const junctions = (raw.junctions || []).map((j) => (find(j.id) === j.id ? j : { ...j, zone: find(j.id) }));
  return { lanes: out, junctions };
}

/** One connector lane made of the lanes of `path`, end to end. */
function joinPath(lanes, prev, path, index) {
  const first = lanes[path[0]], last = lanes[path[path.length - 1]];
  const pts = [];
  let speedLimit = Infinity;
  for (const i of path) {
    const p = lanes[i].pts;
    // Consecutive lanes share a point where they meet; it is taken once.
    const shared = pts.length > 0 && Math.hypot(p[0] - pts[pts.length - 3], p[1] - pts[pts.length - 2], p[2] - pts[pts.length - 1]) < 0.01;
    for (let k = shared ? 3 : 0; k < p.length; k++) pts.push(p[k]);
    if (lanes[i].speedLimit > 0) speedLimit = Math.min(speedLimit, lanes[i].speedLimit);
  }
  // The turn is what the whole path does: from the heading of the road that leads in to the
  // heading of the road that leads out.
  const before = prev[path[0]].length > 0 ? lanes[prev[path[0]][0]].pts : null;
  const after = last.next && last.next.length > 0 ? lanes[last.next[0]].pts : null;
  const headingIn = before ? heading(before, before.length / 3 - 2) : heading(pts, 0);
  const headingOut = after ? heading(after, 0) : heading(pts, pts.length / 3 - 2);
  let change = headingOut - headingIn;
  change -= Math.round(change / (2 * Math.PI)) * 2 * Math.PI;
  const turn = Math.abs(change) < STRAIGHT_BELOW ? TURN.STRAIGHT : Math.abs(change) > UTURN_ABOVE ? TURN.UTURN : change > 0 ? TURN.LEFT : TURN.RIGHT;
  return {
    ...first,
    pts: Float32Array.from(pts),
    speedLimit: Number.isFinite(speedLimit) ? speedLimit : first.speedLimit,
    next: (last.next || []).map((n) => index[n]).filter((n) => n >= 0),
    turn,
  };
}

/** Heading (yaw) of segment `i` of a polyline of x, y, z triples. */
function heading(pts, i) {
  return Math.atan2(pts[i * 3 + 3] - pts[i * 3], pts[i * 3 + 5] - pts[i * 3 + 2]);
}

function polylineLength(pts) {
  let length = 0;
  for (let i = 3; i + 2 < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
  return length;
}

function prepareLane(source, index) {
  const pts = source.pts;
  const count = Math.floor(pts.length / 3);
  if (count < 2) throw new Error(`lane graph: lane ${index} has fewer than two points`);
  const cum = new Float32Array(count);
  for (let i = 1; i < count; i++) {
    const a = (i - 1) * 3, b = i * 3;
    cum[i] = cum[i - 1] + Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1], pts[b + 2] - pts[a + 2]);
  }
  const length = cum[count - 1];
  const speedLimit = source.speedLimit > 0 ? source.speedLimit : 13.4;
  return {
    id: index,
    pts, cum, count, length,
    speedLimit,
    width: source.width || 3.3,
    nextIds: source.next || [],
    next: [],
    prev: [],
    junctionId: source.junction === undefined ? -1 : source.junction,
    junction: null,
    turn: source.turn || 0,
    control: source.control && source.control.kind !== 'none' ? { ...source.control, junctionRef: null } : null,
    roadId: source.roadId === undefined ? -1 : source.roadId,
    /** Highest comfortable speed at each point: bends, and the braking that leads into them. */
    speedProfile: speedProfile(pts, cum, count, speedLimit),
    /**
     * Conflicting connector lanes: [{ lane, exitS, sameOrigin }], filled per junction on first
     * use. `exitS` is the station on this lane beyond which a vehicle is clear of the other;
     * it is negative where the two only meet on the way in, before this lane begins.
     */
    conflicts: [],
    /**
     * For a lane that leads into a junction: how far before its end a vehicle waits, so that
     * it stands clear of every path that is not its own. Filled with the conflicts.
     */
    holdBack: 0,
    /** Drivers on this lane, the one furthest along first. Maintained by the driver model. */
    cars: [],
  };
}

/**
 * Comfortable speed at every point of a polyline: the lateral-acceleration limit of the local
 * bend, then a backward pass so that each point is slow enough to brake for what follows.
 */
function speedProfile(pts, cum, count, speedLimit) {
  const profile = new Float32Array(count).fill(speedLimit);
  for (let i = 1; i < count - 1; i++) {
    const a = (i - 1) * 3, b = i * 3, c = (i + 1) * 3;
    const ax = pts[b] - pts[a], az = pts[b + 2] - pts[a + 2], bx = pts[c] - pts[b], bz = pts[c + 2] - pts[b + 2];
    const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (turn < 0.02) continue;
    // Radius of the bend, from the turning angle over the mean of the two chords.
    const radius = 0.5 * ((cum[i] - cum[i - 1]) + (cum[i + 1] - cum[i])) / turn;
    profile[i] = Math.min(speedLimit, Math.max(MIN_BEND_SPEED, Math.sqrt(COMFORT_LATERAL * radius)));
  }
  for (let i = count - 2; i >= 0; i--) {
    const reach = Math.sqrt(profile[i + 1] * profile[i + 1] + 2 * COMFORT_BRAKING * (cum[i + 1] - cum[i]));
    if (reach < profile[i]) profile[i] = reach;
  }
  return profile;
}

export class LaneGraph {
  constructor(lanes, junctions) {
    this.lanes = lanes;
    this.junctions = junctions;
    /** Lanes that are not junction connectors: where vehicles may be spawned. */
    this.roadLanes = lanes.filter((l) => l.junctionId < 0);
    this._grid = new Map();
    this._buildGrid();
    this._nearest = { lane: null, s: 0, distance: 0, x: 0, y: 0, z: 0, yaw: 0 };
  }

  _buildGrid() {
    const cells = new Map();
    const add = (key, laneId, segment) => {
      let list = cells.get(key);
      if (!list) { list = []; cells.set(key, list); }
      list.push(laneId, segment);
    };
    for (const lane of this.lanes) {
      const p = lane.pts;
      for (let i = 0; i < lane.count - 1; i++) {
        const x0 = p[i * 3], z0 = p[i * 3 + 2], x1 = p[i * 3 + 3], z1 = p[i * 3 + 5];
        const cx0 = Math.floor(Math.min(x0, x1) / GRID_CELL), cx1 = Math.floor(Math.max(x0, x1) / GRID_CELL);
        const cz0 = Math.floor(Math.min(z0, z1) / GRID_CELL), cz1 = Math.floor(Math.max(z0, z1) / GRID_CELL);
        for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) add(cellKey(cx, cz), lane.id, i);
      }
    }
    for (const [key, list] of cells) this._grid.set(key, Int32Array.from(list));
  }

  /** Lane segments registered in the grid cell that contains (x, z): pairs of lane id and segment index, or null. */
  segmentsAt(x, z) {
    return this._grid.get(cellKey(Math.floor(x / GRID_CELL), Math.floor(z / GRID_CELL))) || null;
  }

  /**
   * Closest point on any lane to (x, z).
   * @param {number} maxDistance  search radius, metres
   * @param {(lane: object) => boolean} [accept]  optional lane filter
   * @returns {{lane, s, distance, x, y, z, yaw} | null}  a reused object
   */
  nearest(x, z, maxDistance, accept) {
    const out = this._nearest;
    let best = maxDistance * maxDistance;
    out.lane = null;
    const reach = Math.ceil(maxDistance / GRID_CELL);
    const cx0 = Math.floor(x / GRID_CELL), cz0 = Math.floor(z / GRID_CELL);
    // Search outwards ring by ring and stop once a ring cannot contain anything closer.
    for (let ring = 0; ring <= reach; ring++) {
      if (out.lane && (ring - 1) * GRID_CELL > Math.sqrt(best)) break;
      for (let cx = cx0 - ring; cx <= cx0 + ring; cx++) {
        for (let cz = cz0 - ring; cz <= cz0 + ring; cz++) {
          if (Math.max(Math.abs(cx - cx0), Math.abs(cz - cz0)) !== ring) continue;
          const list = this._grid.get(cellKey(cx, cz));
          if (!list) continue;
          for (let k = 0; k < list.length; k += 2) {
            const lane = this.lanes[list[k]];
            if (accept && !accept(lane)) continue;
            const i = list[k + 1], p = lane.pts;
            const ax = p[i * 3], az = p[i * 3 + 2], bx = p[i * 3 + 3], bz = p[i * 3 + 5];
            const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
            const t = len2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / len2, 0, 1) : 0;
            const px = ax + dx * t, pz = az + dz * t;
            const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
            if (d2 < best) {
              best = d2;
              out.lane = lane;
              out.s = lane.cum[i] + (lane.cum[i + 1] - lane.cum[i]) * t;
              out.x = px; out.z = pz;
              out.y = p[i * 3 + 1] + (p[i * 3 + 4] - p[i * 3 + 1]) * t;
              out.yaw = Math.atan2(dx, dz);
            }
          }
        }
      }
    }
    if (!out.lane) return null;
    out.distance = Math.sqrt(best);
    return out;
  }

  /**
   * Works out how the lanes of a junction get in each other's way: the waiting point of every
   * lane that leads in, and the conflict lists of the connector lanes. Idempotent.
   */
  ensureConflicts(junction) {
    if (junction.conflictsReady) return;
    junction.conflictsReady = true;
    const list = junction.connectors;
    const approaches = [];
    for (const connector of list) {
      const approach = connector.prev[0];
      if (approach && !approaches.includes(approach)) approaches.push(approach);
    }
    for (const approach of approaches) approach.holdBack = holdBack(approach, list, approaches);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const sameOrigin = a.prev.length > 0 && b.prev.length > 0 && a.prev[0] === b.prev[0];
        const sameTarget = a.next.length > 0 && b.next.length > 0 && a.next[0] === b.next[0];
        const exitA = conflictExit(a, b, sameOrigin), exitB = conflictExit(b, a, sameOrigin);
        if (!Number.isFinite(exitA) && !sameTarget) continue;
        // Two lanes that feed the same lane stay in conflict to their very end. Two that leave
        // the same lane only until they have parted. Crossing lanes until the crossing is passed.
        a.conflicts.push({ lane: b, exitS: sameTarget ? a.length : exitA, sameOrigin });
        b.conflicts.push({ lane: a, exitS: sameTarget ? b.length : exitB, sameOrigin });
      }
    }
  }
}

/**
 * How far before the end of `approach` a vehicle has to wait to be clear of the connectors
 * that start from other lanes and of the other lanes that lead in. Zero wherever roads meet
 * squarely; several car lengths where two of them run into the junction almost side by side.
 */
function holdBack(approach, connectors, approaches) {
  const most = Math.max(0, Math.min(HOLD_BACK_MAX, approach.length - HOLD_BACK_KEEP));
  for (let back = 0; back < most; back += HOLD_BACK_STEP) {
    samplePoint(approach, approach.length - back, scratch);
    let clear = true;
    for (let i = 0; clear && i < connectors.length; i++) {
      if (connectors[i].prev[0] !== approach && distanceToLane(connectors[i], scratch[0], scratch[2], 0) < CONFLICT_DISTANCE) clear = false;
    }
    for (let i = 0; clear && i < approaches.length; i++) {
      const other = approaches[i];
      if (other !== approach && distanceToLane(other, scratch[0], scratch[2], other.length - HOLD_BACK_MAX) < CONFLICT_DISTANCE) clear = false;
    }
    if (clear) return back;
  }
  return most;
}

/**
 * Station on connector `a` beyond which a vehicle on it is clear of connector `b`: the last
 * point of `a` that lies within the conflict distance of `b`, plus a margin. Unless the two
 * start from the same lane, the path of each begins at its waiting point, so a station on the
 * way in counts too, as a negative one. -Infinity if the paths never meet.
 */
function conflictExit(a, b, sameOrigin) {
  let exit = -Infinity;
  const step = 1.0;
  const approachA = sameOrigin ? null : a.prev[0] || null, approachB = sameOrigin ? null : b.prev[0] || null;
  for (let s = approachA ? -approachA.holdBack : 0; s <= a.length; s += step) {
    if (s < 0) samplePoint(approachA, approachA.length + s, scratch);
    else samplePoint(a, s, scratch);
    let d = distanceToLane(b, scratch[0], scratch[2], 0);
    if (approachB && approachB.holdBack > 0) d = Math.min(d, distanceToLane(approachB, scratch[0], scratch[2], approachB.length - approachB.holdBack));
    if (d < CONFLICT_DISTANCE) exit = s;
  }
  return Math.min(a.length, exit + step);
}

const scratch = [0, 0, 0];

/** Distance from (x, z) to the part of a lane that lies beyond station `fromS`. */
function distanceToLane(lane, x, z, fromS) {
  const p = lane.pts, cum = lane.cum;
  let best = Infinity;
  for (let i = 0; i < lane.count - 1; i++) {
    if (cum[i + 1] <= fromS) continue;
    const ax = p[i * 3], az = p[i * 3 + 2], dx = p[i * 3 + 3] - ax, dz = p[i * 3 + 5] - az, len2 = dx * dx + dz * dz;
    const span = cum[i + 1] - cum[i];
    const least = span > 0 ? clamp((fromS - cum[i]) / span, 0, 1) : 0;
    const t = len2 > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / len2, least, 1) : least;
    const ex = x - ax - dx * t, ez = z - az - dz * t;
    best = Math.min(best, ex * ex + ez * ez);
  }
  return Math.sqrt(best);
}

/** Index of the segment of `lane` that contains station `s`, starting the search at `hint`. */
export function segmentAt(lane, s, hint = 0) {
  const cum = lane.cum, last = lane.count - 2;
  let i = clamp(hint, 0, last);
  while (i < last && cum[i + 1] < s) i++;
  while (i > 0 && cum[i] > s) i--;
  return i;
}

/**
 * Point on a lane at station `s`. Stations before the start or past the end continue along
 * the first or last segment, so that a vehicle's axles can straddle a lane boundary.
 * @param {number[]} out  receives x, y, z
 * @returns {number} the segment index, to pass as `hint` next time
 */
export function samplePoint(lane, s, out, hint = 0) {
  const i = segmentAt(lane, s, hint);
  const p = lane.pts, cum = lane.cum;
  const span = cum[i + 1] - cum[i];
  const t = span > 0 ? (s - cum[i]) / span : 0;
  const a = i * 3;
  out[0] = p[a] + (p[a + 3] - p[a]) * t;
  out[1] = p[a + 1] + (p[a + 4] - p[a + 1]) * t;
  out[2] = p[a + 2] + (p[a + 5] - p[a + 2]) * t;
  return i;
}

/** Comfortable speed (m/s) on a lane at station `s`, from its speed profile. */
export function comfortSpeed(lane, s, hint = 0) {
  const i = segmentAt(lane, s, hint), cum = lane.cum, span = cum[i + 1] - cum[i];
  const t = span > 0 ? clamp((s - cum[i]) / span, 0, 1) : 0;
  return lane.speedProfile[i] + (lane.speedProfile[i + 1] - lane.speedProfile[i]) * t;
}

/** Heading (yaw, 0 = +Z, positive towards +X) of a lane at station `s`. */
export function laneYaw(lane, s, hint = 0) {
  const i = segmentAt(lane, s, hint), p = lane.pts, a = i * 3;
  return Math.atan2(p[a + 3] - p[a], p[a + 5] - p[a + 2]);
}
