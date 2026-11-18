// Lane graph for traffic (design/ARCHITECTURE.md section 15.1). Every edge of the road network yields one lane
// per direction lane of its cross-section, at the offsets the roads module defines (the same ones the shader
// paints lines for). A lane ends on the stop line at a junction's setback; connector lanes cross the junction to
// every permitted exit. Lanes run through joints directly, and turn back on themselves at dead ends so that
// traffic never strands.

import { LAND_Y, bridgeY } from './field.js';
import { edgePoint } from './network.js';

const TURN = { STRAIGHT: 0, LEFT: 1, RIGHT: 2, UTURN: 3 };
const BLEND = 24;            // metres over which a lane shifts sideways to meet a lane of different offset at a joint
const TURN_SPEED = 7;        // m/s through a junction turn
const KERB_CLEARANCE = 1.1;   // metres a turning lane's centre keeps from the kerb where the junction allows it
const CURVE_STEP = 7;        // metres between lane points beside a bend, measured on the road's centre line
const MIN_ROAD_LANE = 12;    // metres: a shorter lane between a joint and a stop line gives a driver no room to see the line and stop

/**
 * net: road network; bridges: plan bridge records (profile tables); kerbDistance(x, z): signed metres to the
 * carriageway edge (negative on the carriageway), used to keep turning lanes off the kerb corners.
 * Returns { lanes, junctions, nodeJunction: Int32Array (network node -> junction id or -1) }.
 */
export function buildLaneGraph(net, bridges, kerbDistance = null) {
  const lanes = [], junctions = [], nodeJunction = new Int32Array(net.nodes.length).fill(-1);
  const bridgeOfRoad = new Map(bridges.map((b) => [b.road, b]));
  const drivable = (e) => !net.roads[e.road].runway;

  // Lanes of each edge in travel order from left to right: fwd runs a -> b, bwd runs b -> a.
  const sides = net.edges.map((e) => {
    const all = drivable(e) ? net.roads[e.road].lanes.lanes : [];
    return { fwd: all.filter((l) => l.dir > 0).sort((p, q) => p.offset - q.offset), bwd: all.filter((l) => l.dir < 0).sort((p, q) => q.offset - p.offset) };
  });
  /** Lanes that arrive at / leave from the node at one end of an edge. */
  const arriving = (edge, end) => (end ? sides[edge].fwd : sides[edge].bwd);
  const leaving = (edge, end) => (end ? sides[edge].bwd : sides[edge].fwd);
  /** Which lanes of a group of m pair with lane i of a group of n (inner lanes pair up, the last one fans out). */
  const pairs = (i, n, m) => { const out = []; for (let j = 0; j < m; j++) if (Math.min(i, m - 1) === j || (Math.min(j, n - 1) === i && j >= n)) out.push(j); return out; };

  // What a node is to traffic. A joint passes lanes straight through, but only if both of its roads can be driven
  // and take what the other delivers; a road that runs into a runway or a one-way against it ends there instead.
  const role = net.nodes.map((node) => {
    const legs = node.legs.filter((l) => drivable(net.edges[l.edge]));
    if (node.kind !== 'joint') return node.kind;
    if (legs.length < 2) return 'end';
    const feeds = (p, q) => arriving(p.edge, p.end).length === 0 || leaving(q.edge, q.end).length > 0;
    return feeds(legs[0], legs[1]) && feeds(legs[1], legs[0]) ? 'joint' : 'end';
  });

  // At a joint the two roads may have different lane offsets. The side with more lanes (or both, if equal) is
  // shifted over the last metres so that paired lanes meet end to end. target[edge][end] = offsets by lane.
  const jointTarget = (edgeId, end, laneList, laneIndex, isArriving) => {
    const e = net.edges[edgeId], node = net.nodes[end ? e.b : e.a];
    if (role[node.id] !== 'joint') return null;
    const other = node.legs.find((l) => l.edge !== edgeId || l.end !== end); if (!other || !drivable(net.edges[other.edge])) return null;
    const mates = isArriving ? leaving(other.edge, other.end) : arriving(other.edge, other.end); if (!mates.length) return null;
    const sign = other.end !== end ? 1 : -1, mate = mates[Math.min(laneIndex, mates.length - 1)].offset * sign, own = laneList[laneIndex].offset;
    return laneList.length > mates.length ? mate : laneList.length < mates.length ? own : (own + mate) / 2;
  };

  // ---- road lanes
  const laneIds = net.edges.map(() => ({ fwd: [], bwd: [] }));
  for (const e of net.edges) {
    if (!drivable(e)) continue;
    const road = net.roads[e.road], bridge = bridgeOfRoad.get(e.road), n = e.pts.length / 2;
    const endKind = [role[e.a], role[e.b]];
    // Trim: to the stop line at junctions, and short of a dead end to leave room to turn round.
    const trim = [endKind[0] === 'junction' ? e.setA : endKind[0] === 'end' ? Math.min(e.length * 0.3, e.hw + 3) : 0, endKind[1] === 'junction' ? e.setB : endKind[1] === 'end' ? Math.min(e.length * 0.3, e.hw + 3) : 0];
    const from = trim[0], to = e.length - trim[1];
    // Stations to sample: the edge's own points inside the range plus both ends; straight runs are thinned.
    const stations = [from], curved = new Set();
    for (let i = 1; i + 1 < n; i++) {
      const s = e.st[i] - e.s0; if (s <= from + 1 || s >= to - 1) continue;
      const bend = Math.abs(Math.atan2((e.pts[i * 2 + 2] - e.pts[i * 2]) * (e.pts[i * 2 + 1] - e.pts[i * 2 - 1]) - (e.pts[i * 2 + 3] - e.pts[i * 2 + 1]) * (e.pts[i * 2] - e.pts[i * 2 - 2]), (e.pts[i * 2 + 2] - e.pts[i * 2]) * (e.pts[i * 2] - e.pts[i * 2 - 2]) + (e.pts[i * 2 + 3] - e.pts[i * 2 + 1]) * (e.pts[i * 2 + 1] - e.pts[i * 2 - 1])));
      if (bridge || bend > 0.004 || s - stations[stations.length - 1] > 40) { stations.push(s); if (bend > 0.004) curved.add(s); }
    }
    stations.push(to);
    // Section 15.1: points at most 8 m apart on curves. The edge's own points may be further apart than that, so
    // the stretches beside a bend are subdivided (the outer lanes of a bend are longer than its centre line).
    for (let i = stations.length - 1; i > 0; i--) {
      const gap = stations[i] - stations[i - 1], parts = Math.ceil(gap / CURVE_STEP);
      if (parts > 1 && (curved.has(stations[i]) || curved.has(stations[i - 1]))) stations.splice(i, 0, ...Array.from({ length: parts - 1 }, (_, k) => stations[i - 1] + gap * (k + 1) / parts));
    }
    const at = (s, out) => edgePoint(e, s, out);
    const f = [0, 0, 0, 0];
    for (const dir of [1, -1]) {
      const list = dir > 0 ? sides[e.id].fwd : sides[e.id].bwd;
      list.forEach((lane, k) => {
        // Offsets at the two ends of the edge (a end, b end) when a joint needs the lane shifted.
        const tA = jointTarget(e.id, 0, list, k, dir < 0), tB = jointTarget(e.id, 1, list, k, dir > 0);
        const pts = new Float32Array(stations.length * 3);
        stations.forEach((s, i) => {
          at(s, f);
          let o = lane.offset;
          if (tA !== null && s < BLEND) { const u = s / BLEND, w = u * u * (3 - 2 * u); o = tA + (o - tA) * w; }
          if (tB !== null && e.length - s < BLEND) { const u = (e.length - s) / BLEND, w = u * u * (3 - 2 * u); o = tB + (o - tB) * w; }
          const j = (dir > 0 ? i : stations.length - 1 - i) * 3;
          pts[j] = f[0] - f[3] * o; pts[j + 1] = bridge && bridge.edge === e.id ? bridgeY(bridge, s - bridge.start) : LAND_Y; pts[j + 2] = f[1] + f[2] * o;
        });
        let length = 0; for (let i = 3; i < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 1] - pts[i - 2], pts[i + 2] - pts[i - 1]);
        const id = lanes.length;
        lanes.push({ id, pts, length, speedLimit: road.speedLimitKmh / 3.6, width: lane.width, next: [], junction: -1, turn: 0, control: { junction: -1, kind: 'none', group: 0 }, roadId: road.id, roadClass: road.planClass || road.class, edge: e.id, dir, offset: lane.offset });
        (dir > 0 ? laneIds[e.id].fwd : laneIds[e.id].bwd).push(id);
      });
    }
  }
  const arrivingIds = (edge, end) => (end ? laneIds[edge].fwd : laneIds[edge].bwd);
  const leavingIds = (edge, end) => (end ? laneIds[edge].bwd : laneIds[edge].fwd);

  // ---- short lanes at joints
  // A joint close to a junction leaves a few metres of lane between the two. Traffic reads a lane's control only
  // while it is on that lane, so such a stub is joined to the lane it continues across the joint: one lane, the long
  // road's, running to the stop line. Both edges then list the same lane and the joint has nothing left to link.
  const joined = new Set(), gone = new Set();
  const append = (first, second) => {
    const a = first.pts, b = second.pts, n = a.length, skip = Math.hypot(b[0] - a[n - 3], b[1] - a[n - 2], b[2] - a[n - 1]) < 0.05 ? 3 : 0;
    const pts = new Float32Array(n + b.length - skip); pts.set(a); pts.set(b.subarray(skip), n);
    return { pts, length: first.length + second.length + (skip ? 0 : Math.hypot(b[0] - a[n - 3], b[1] - a[n - 2], b[2] - a[n - 1])) };
  };
  for (const node of net.nodes) {
    if (role[node.id] !== 'joint') continue;
    const legs = node.legs.filter((l) => drivable(net.edges[l.edge]));
    for (const [p, q] of [[legs[0], legs[1]], [legs[1], legs[0]]]) {
      const stubIn = arrivingIds(p.edge, p.end), stubOut = leavingIds(p.edge, p.end), onward = leavingIds(q.edge, q.end), inward = arrivingIds(q.edge, q.end);
      const stubs = [...stubIn, ...stubOut];
      if (joined.has(node.id) || !stubs.length || stubIn.length !== onward.length || stubOut.length !== inward.length) continue;
      if (stubs.some((id) => lanes[id].length >= MIN_ROAD_LANE) || [...onward, ...inward].some((id) => lanes[id].length < MIN_ROAD_LANE)) continue;
      stubIn.forEach((id, i) => { const keep = lanes[onward[i]]; Object.assign(keep, append(lanes[id], keep), { width: Math.min(keep.width, lanes[id].width) }); gone.add(id); });
      stubOut.forEach((id, i) => { const keep = lanes[inward[i]]; Object.assign(keep, append(keep, lanes[id]), { width: Math.min(keep.width, lanes[id].width) }); gone.add(id); });
      const ids = laneIds[p.edge], forwardArrives = p.end === 1;
      ids.fwd = forwardArrives ? onward.slice() : inward.slice(); ids.bwd = forwardArrives ? inward.slice() : onward.slice();
      joined.add(node.id);
    }
  }
  if (gone.size) {
    const renumber = new Map(), kept = lanes.filter((l) => !gone.has(l.id));
    kept.forEach((l, i) => { renumber.set(l.id, i); l.id = i; });
    lanes.length = 0; lanes.push(...kept);
    for (const ids of laneIds) { ids.fwd = ids.fwd.map((id) => renumber.get(id)); ids.bwd = ids.bwd.map((id) => renumber.get(id)); }
  }

  /** Connector lane from the end of lane a to the start of lane b: a cubic with tangents of both lanes. */
  const connect = (a, b, junction, turn, bulge) => {
    const A = lanes[a], B = lanes[b], n = A.pts.length, p0 = [A.pts[n - 3], A.pts[n - 2], A.pts[n - 1]], p3 = [B.pts[0], B.pts[1], B.pts[2]];
    let d0 = [p0[0] - A.pts[n - 6], p0[2] - A.pts[n - 4]], d1 = [B.pts[3] - p3[0], B.pts[5] - p3[2]];
    const l0 = Math.hypot(d0[0], d0[1]) || 1, l1 = Math.hypot(d1[0], d1[1]) || 1; d0 = [d0[0] / l0, d0[1] / l0]; d1 = [d1[0] / l1, d1[1] / l1];
    const span = Math.hypot(p3[0] - p0[0], p3[2] - p0[2]);
    const h = bulge || Math.min(18, Math.max(1, span * 0.42)); let ha = h, hb = h, pts;
    // Where the two lanes' own lines meet: a turn drawn through that point stays on both carriageways, however long
    // the junction's legs are.
    const cross = d0[0] * d1[1] - d0[1] * d1[0], rx = p3[0] - p0[0], rz = p3[2] - p0[2];
    const reachA = Math.abs(cross) > 0.05 ? (rx * d1[1] - rz * d1[0]) / cross : -1, reachB = Math.abs(cross) > 0.05 ? -(rx * d0[1] - rz * d0[0]) / cross : -1;
    const corner = reachA > 0 && reachB > 0;
    // A turn that would brush the kerb on its inside is squared off (longer tangents) until half a car clears it.
    for (let attempt = 0; ; attempt++) {
      const c1 = [p0[0] + d0[0] * ha, p0[2] + d0[1] * ha], c2 = [p3[0] - d1[0] * hb, p3[2] - d1[1] * hb];
      const steps = Math.max(1, Math.ceil((span + (turn ? Math.max(ha, hb) : 0)) / 2.5)); pts = new Float32Array((steps + 1) * 3);
      let worst = -Infinity;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, u = 1 - t, w0 = u * u * u, w1 = 3 * u * u * t, w2 = 3 * u * t * t, w3 = t * t * t;
        pts[i * 3] = w0 * p0[0] + w1 * c1[0] + w2 * c2[0] + w3 * p3[0]; pts[i * 3 + 1] = p0[1] + (p3[1] - p0[1]) * t; pts[i * 3 + 2] = w0 * p0[2] + w1 * c1[1] + w2 * c2[1] + w3 * p3[2];
        if (kerbDistance && i > 0 && i < steps) worst = Math.max(worst, kerbDistance(pts[i * 3], pts[i * 3 + 2]));
      }
      if (!kerbDistance || turn === TURN.STRAIGHT || turn === TURN.UTURN || worst < -KERB_CLEARANCE || attempt >= 4) break;
      // Towards the corner point when there is one, else simply longer tangents.
      if (corner) { const f = (attempt + 1) / 4; ha = h + (Math.max(h, reachA) - h) * f; hb = h + (Math.max(h, reachB) - h) * f; }
      else { ha *= 1.3; hb *= 1.3; }
    }
    let length = 0; for (let i = 3; i < pts.length; i += 3) length += Math.hypot(pts[i] - pts[i - 3], pts[i + 2] - pts[i - 1]);
    const id = lanes.length, speed = Math.min(A.speedLimit, B.speedLimit);
    lanes.push({ id, pts, length, speedLimit: turn === TURN.STRAIGHT ? speed : Math.min(speed, turn === TURN.UTURN ? 4 : TURN_SPEED), width: Math.min(A.width, B.width), next: [b], junction, turn, control: { junction, kind: 'none', group: A.control.group }, roadId: B.roadId, roadClass: B.roadClass, edge: -1, dir: 1, offset: 0 });
    A.next.push(id);
  };

  // ---- nodes
  for (const node of net.nodes) {
    const legs = node.legs.filter((l) => drivable(net.edges[l.edge]));
    if (!legs.length) continue;
    if (role[node.id] === 'joint') {
      if (joined.has(node.id)) continue;
      for (const [p, q] of [[legs[0], legs[1]], [legs[1], legs[0]]]) {
        const ins = arrivingIds(p.edge, p.end), outs = leavingIds(q.edge, q.end);
        ins.forEach((id, i) => { for (const j of pairs(i, ins.length, outs.length)) lanes[id].next.push(outs[j]); });
      }
      continue;
    }
    const jid = junctions.length; nodeJunction[node.id] = jid;
    junctions.push({ id: jid, node: node.id, x: node.x, z: node.z, radius: Math.max(node.radius, 6), control: node.kind === 'junction' ? node.control : 'none', groups: node.groups, lenses: new Float32Array(0) });
    for (const p of legs) {
      const ins = arrivingIds(p.edge, p.end);
      ins.forEach((id, i) => {
        const lane = lanes[id]; lane.control = { junction: jid, kind: node.kind === 'junction' ? p.control : 'none', group: p.group || 0 };
        const options = [];
        for (const q of legs) {
          if (q === p) continue;
          const outs = leavingIds(q.edge, q.end); if (!outs.length) continue;
          // Leg directions point away from the node: travel in is -p, travel out is +q.
          const dot = -(p.dx * q.dx + p.dz * q.dz), cross = -(p.dx * q.dz - p.dz * q.dx);
          options.push({ outs, turn: dot > 0.7 ? TURN.STRAIGHT : cross > 0 ? TURN.RIGHT : TURN.LEFT });
        }
        let made = 0;
        const add = (strict) => {
          for (const o of options) {
            const m = o.outs.length;
            if (o.turn === TURN.STRAIGHT || !strict) { for (const j of pairs(i, ins.length, m)) { connect(id, o.outs[j], jid, o.turn, 0); made++; } }
            else if (o.turn === TURN.LEFT && i === 0) { connect(id, o.outs[0], jid, o.turn, 0); made++; }
            else if (o.turn === TURN.RIGHT && i === ins.length - 1) { connect(id, o.outs[m - 1], jid, o.turn, 0); made++; }
          }
        };
        add(true); if (!made) add(false);
        if (!made) {                       // dead end, or a junction whose other legs are all one-way against us
          const back = leavingIds(p.edge, p.end);
          if (back.length) { const b = back[Math.min(i, back.length - 1)], sep = Math.hypot(lanes[b].pts[0] - lane.pts[lane.pts.length - 3], lanes[b].pts[2] - lane.pts[lane.pts.length - 1]); connect(id, b, jid, TURN.UTURN, Math.max(3.5, sep * 0.75)); }
        }
      });
    }
  }
  return { lanes, junctions, nodeJunction };
}
