// Road network topology and geometry. The layout gives roads as traced centre lines that share vertices where
// they meet; this module turns them into nodes (ends, joints, junctions) and edges (the piece of one road between
// two nodes), smooths every edge into a densely sampled curve and works out how much room each junction needs.
// The layout's own junction list is only used as a hint for the traffic control at a node: topology always comes
// from the geometry, so a renumbered or incomplete list cannot break the city.

import { distSqToSegment, segmentIntersection, smoothPolyline } from './geom.js';
import { laneCode, laneLayout } from '../roads/lanes.js';

const MERGE = 1.5;        // vertices of different roads closer than this are the same node
const SNAP = 8;           // a road end this close to another road's centre line joins it
const SHORT_EDGE = 11;    // two nodes joined by less road than this are merged into one junction
const FILLET = 4;         // kerb radius at junction corners
const CROSSING = 3.6;     // depth kept for the pedestrian crossing between the corner and the stop line
export const KERB_RADIUS = FILLET;
const MIN_LINK = 14;      // two junctions whose stop lines are closer than the longest vehicle are merged into one
const LOOP_MIN = 80;      // a road returning to the node it left is a real loop only when it is longer than this
export const MAX_REACH = 28;     // a junction's kerb lines are followed at most this far along a leg to find where they part
const FORK_GAP = 6;       // pavement and verge between two carriageways before they count as separate roads
const FORK_SHALLOW = 2.4; // a road needing more than this many clear widths to part from another leaves it under ~25 degrees
const FORK_NARROW = 20;   // degrees: two arms leaving a vertex closer than this put one's stop line in the other's carriageway
const FORK_OPEN = 30;     // degrees: a narrow arm is straightened until it leaves its neighbour by at least this much
const FORK_RELAX = 60;    // the straightened arm rejoins its traced line within this distance of the junction

/** Cross-section numbers every later stage needs, derived once per road. */
function describeRoad(r, index) {
  const open = !r.sidewalk;                                     // no pavement means no kerb either: paved shoulder and verge
  const runway = r.surface === 'runway';
  const code = laneCode({ lanesPerDirection: r.lanesPerDirection, oneWay: r.oneWay, median: r.median && !r.bridge, noMarkings: runway || (r.planClass === 'lane' && r.width < 7), openShoulder: open });
  const hw = r.width / 2;
  return { ...r, index, hw, pw: r.pavementWidth, open, runway, laneCode: code, lanes: laneLayout(hw, code, false), edges: [], length: 0 };
}

/** Distance from p to a polyline; `foot` receives the nearest point on it. */
function distToPolyline(p, P, foot) {
  let best = Infinity; const t = [0];
  for (let i = 0; i + 1 < P.length; i++) {
    const d = distSqToSegment(p[0], p[1], P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], t);
    if (d < best) { best = d; if (foot) { foot[0] = P[i][0] + (P[i + 1][0] - P[i][0]) * t[0]; foot[1] = P[i][1] + (P[i + 1][1] - P[i][1]) * t[0]; } }
  }
  return Math.sqrt(best);
}

/**
 * Roads traced on top of each other. A road that leaves another at a shallow angle shares its carriageway for a long
 * way: the junction becomes longer than a block and its stop lines lie inside the other road's lanes. A road builder
 * turns the minor road to meet the major one squarely, which is what happens here: the minor road is cut back to
 * where the two are clear of each other and led straight across to the major road. A road that never gets clear of
 * another is a duplicate trace and is dropped. Returns the roads to build, with their own copies of the points.
 */
function squareUpForks(layoutRoads, issues) {
  const pts = layoutRoads.map((r) => r.points.map((p) => [p[0], p[1]]));
  const lengthOf = (P) => { let l = 0; for (let i = 1; i < P.length; i++) l += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); return l; };
  const fixed = (r) => r.bridge || r.surface === 'runway';
  // Narrow and short roads give way to wide and long ones.
  const order = layoutRoads.map((_, i) => i).sort((a, b) => layoutRoads[a].width - layoutRoads[b].width || lengthOf(pts[a]) - lengthOf(pts[b]) || a - b);
  const dropped = new Set(), foot = [0, 0];
  for (const r of order) {
    const A = layoutRoads[r]; if (fixed(A)) continue;
    for (let end = 0; end < 2 && !dropped.has(r); end++) {
      const P = end ? pts[r].slice().reverse() : pts[r];
      for (let q = 0; q < layoutRoads.length; q++) {
        const B = layoutRoads[q]; if (q === r || dropped.has(q) || fixed(B) || distToPolyline(P[0], pts[q]) > SNAP) continue;
        // Walk away from the shared end until the two carriageways have parted.
        const clear = (A.width + B.width) / 2 + FORK_GAP; let walked = 0, cut = null;
        for (let i = 0; i + 1 < P.length && !cut; i++) {
          const len = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]), steps = Math.max(1, Math.ceil(len / 3));
          for (let k = 1; k <= steps && !cut; k++) {
            const at = [P[i][0] + (P[i + 1][0] - P[i][0]) * k / steps, P[i][1] + (P[i + 1][1] - P[i][1]) * k / steps];
            if (distToPolyline(at, pts[q]) >= clear) cut = { at, seg: i, s: walked + len * k / steps, whole: k === steps };
          }
          walked += len;
        }
        if (!cut) {
          // Never clear: a second trace of the same road when it is long enough to have parted and its far end is on
          // the other road too; otherwise a short stub or a short road crossing the other one.
          if (walked < clear || distToPolyline(P[P.length - 1], pts[q]) > SNAP) continue;
          dropped.add(r); issues.push({ level: 'warning', what: 'road', id: A.id, text: `runs along ${B.id} for its whole length: dropped as a duplicate` }); break;
        }
        if (cut.s <= clear * FORK_SHALLOW) continue;
        distToPolyline(cut.at, pts[q], foot);
        const rest = P.slice(cut.seg + (cut.whole ? 2 : 1)), squared = [[foot[0], foot[1]], cut.at, ...rest];
        if (lengthOf(squared) < SHORT_EDGE * 2) { dropped.add(r); issues.push({ level: 'warning', what: 'road', id: A.id, text: `overlaps ${B.id} for nearly all its length: dropped` }); break; }
        pts[r] = end ? squared.reverse() : squared;
        issues.push({ level: 'warning', what: 'road', id: A.id, text: `left ${B.id} at a shallow angle (shared its carriageway for ${cut.s.toFixed(0)} m); turned to meet it squarely at (${foot[0].toFixed(0)}, ${foot[1].toFixed(0)})` });
        break;
      }
    }
  }
  return layoutRoads.map((r, i) => ({ ...r, points: pts[i] })).filter((_, i) => !dropped.has(i));
}

/**
 * Arms that leave a shared vertex nearly side by side and bend apart within a few vertices: too short a run for
 * squareUpForks to count as running along the other road, yet the carriageways overlap past where the stop lines go,
 * so traffic waiting on one arm stands in the path of traffic entering the other. The lesser arm's first vertices are
 * dropped, which makes it leave the junction on the chord, at an angle a junction can be built for. Vertices other
 * roads meet are never dropped.
 */
function openNarrowForks(roads, issues) {
  const pts = roads.map((r) => r.points.map((p) => [p[0], p[1]]));
  const fixed = (r) => r.bridge || r.surface === 'runway';
  const span = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lengths = pts.map((P) => { let l = 0; for (let i = 1; i < P.length; i++) l += span(P[i - 1], P[i]); return l; });
  const yields = (r, q) => fixed(roads[q]) || roads[r].width - roads[q].width < 0 || (roads[r].width === roads[q].width && (lengths[r] - lengths[q] || q - r) < 0);
  const heading = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);
  const between = (a, b) => { const d = Math.abs(a - b) % (2 * Math.PI); return (d > Math.PI ? 2 * Math.PI - d : d) * 180 / Math.PI; };
  // Headings of the arms of the roads `r` gives way to that leave from vertex v.
  const rivals = (r, v) => {
    const out = [];
    for (let q = 0; q < roads.length; q++) {
      if (q === r || !yields(r, q)) continue;
      const P = pts[q];
      for (let j = 0; j < P.length; j++) {
        if (span(P[j], v) >= MERGE) continue;
        if (j > 0) out.push({ road: q, heading: heading(v, P[j - 1]) });
        if (j + 1 < P.length) out.push({ road: q, heading: heading(v, P[j + 1]) });
      }
    }
    return out;
  };
  const meets = (u, skip) => pts.some((P, q) => q !== skip && P.some((w) => span(w, u) < MERGE));
  // Vertex b of road r has to stay: another road shares it, or ends on the stretch a-b-c without a vertex of its own
  // there (an end that already sits on a third road's vertex belongs to that junction, not to this stretch).
  const inUse = (r, a, b, c) => {
    for (let q = 0; q < roads.length; q++) {
      if (q === r) continue;
      const P = pts[q];
      if (P.some((u) => span(u, b) < MERGE)) return true;
      for (const u of [P[0], P[P.length - 1]]) {
        if (span(u, a) < MERGE || meets(u, q)) continue;
        if (distSqToSegment(u[0], u[1], a[0], a[1], b[0], b[1]) < SNAP * SNAP || distSqToSegment(u[0], u[1], b[0], b[1], c[0], c[1]) < SNAP * SNAP) return true;
      }
    }
    return false;
  };
  for (let r = 0; r < roads.length; r++) {
    if (fixed(roads[r])) continue;
    for (let i = 0; i < pts[r].length; i++) for (const forward of [true, false]) {
      const P = pts[r], v = P[i], arm = forward ? P.slice(i) : P.slice(0, i + 1).reverse();
      if (arm.length < 3) continue;
      const others = rivals(r, v); if (!others.length) continue;
      let dropped = 0, beside = null;
      for (; arm.length - dropped > 2; dropped++) {
        const next = arm[dropped + 1], h = heading(v, next); let gap = 180, who = null;
        for (const o of others) { const g = between(h, o.heading); if (g < gap) { gap = g; who = o.road; } }
        if (gap >= (dropped ? FORK_OPEN : FORK_NARROW) || span(v, arm[dropped + 2]) > FORK_RELAX || inUse(r, v, next, arm[dropped + 2])) break;
        beside = who;
      }
      if (!dropped) continue;
      const rest = arm.slice(dropped + 1);
      pts[r] = forward ? [...P.slice(0, i + 1), ...rest] : [...rest.reverse(), ...P.slice(i)];
      if (!forward) i -= dropped;
      issues.push({ level: 'warning', what: 'road', id: roads[r].id, text: `left (${v[0].toFixed(0)}, ${v[1].toFixed(0)}) alongside ${roads[beside].id}; straightened over ${span(v, rest[forward ? 0 : rest.length - 1]).toFixed(0)} m to leave it at a wider angle` });
    }
  }
  return roads.map((r, i) => ({ ...r, points: pts[i] }));
}

/**
 * Build the network.
 * roads: normalised layout roads (traced and generated). junctionHints: layout junctions ({ pos, control }).
 * Returns { roads, nodes, edges }:
 *   node { id, x, z, kind: 'end' | 'joint' | 'junction', legs: [{ edge, end, angle, setback }], control, radius }
 *   edge { id, road, a, b, pts (Float64Array x, z pairs), st (Float64Array road stations), length, s0, s1,
 *          setA, setB (junction setbacks from each end, 0 at joints and ends), hw, pw }
 */
export function buildNetwork(layoutRoads, junctionHints, issues) {
  const roads = openNarrowForks(squareUpForks(layoutRoads, issues), issues).map(describeRoad);
  const pts = roads.map((r) => r.points.map((p) => [p[0], p[1]]));
  const segBox = (a, b, m) => [Math.min(a[0], b[0]) - m, Math.min(a[1], b[1]) - m, Math.max(a[0], b[0]) + m, Math.max(a[1], b[1]) + m];
  const boxOf = (P, m) => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of P) { b[0] = Math.min(b[0], p[0] - m); b[1] = Math.min(b[1], p[1] - m); b[2] = Math.max(b[2], p[0] + m); b[3] = Math.max(b[3], p[1] + m); } return b; };
  const boxes = pts.map((P) => boxOf(P, SNAP));
  const overlap = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

  // 1. Road ends that stop on (or just short of) another road's centre line are moved onto it and split it there.
  const inserts = [];   // { road, seg, t, p }
  const t1 = [0];
  for (let r = 0; r < roads.length; r++) for (const endIdx of [0, pts[r].length - 1]) {
    const e = pts[r][endIdx];
    let best = SNAP * SNAP, hit = null, shared = false;
    for (let q = 0; q < roads.length && !shared; q++) {
      if (!(e[0] >= boxes[q][0] && e[0] <= boxes[q][2] && e[1] >= boxes[q][1] && e[1] <= boxes[q][3])) continue;
      const P = pts[q];
      for (let i = 0; i < P.length; i++) {
        if (q === r && Math.abs(i - endIdx) < 2) continue;
        if (Math.hypot(P[i][0] - e[0], P[i][1] - e[1]) < MERGE) { shared = true; break; }   // already a shared vertex
        if (i + 1 >= P.length || (q === r && Math.abs(i + 1 - endIdx) < 2)) continue;
        const d = distSqToSegment(e[0], e[1], P[i][0], P[i][1], P[i + 1][0], P[i + 1][1], t1);
        if (d < best) { best = d; hit = { road: q, seg: i, t: t1[0] }; }
      }
    }
    if (shared || !hit) continue;
    const P = pts[hit.road], a = P[hit.seg], b = P[hit.seg + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (hit.t * len < 3) { e[0] = a[0]; e[1] = a[1]; }
    else if ((1 - hit.t) * len < 3) { e[0] = b[0]; e[1] = b[1]; }
    else { e[0] = a[0] + (b[0] - a[0]) * hit.t; e[1] = a[1] + (b[1] - a[1]) * hit.t; inserts.push({ road: hit.road, seg: hit.seg, t: hit.t, p: [e[0], e[1]] }); }
    if (best > 0.25) issues.push({ level: 'note', what: 'road', id: roads[r].id, text: `end snapped ${Math.sqrt(best).toFixed(1)} m onto ${roads[hit.road].id}` });
  }

  // 2. Centre lines that cross without a shared vertex get one. A crossing along a bridge is a grade separation.
  for (let r = 0; r < roads.length; r++) for (let q = r; q < roads.length; q++) {
    if (!overlap(boxes[r], boxes[q])) continue;
    const A = pts[r], B = pts[q];
    for (let i = 0; i + 1 < A.length; i++) {
      const ab = segBox(A[i], A[i + 1], 0);
      for (let j = (q === r ? i + 2 : 0); j + 1 < B.length; j++) {
        if (!overlap(ab, segBox(B[j], B[j + 1], 0))) continue;
        const t = segmentIntersection(A[i], A[i + 1], B[j], B[j + 1]);
        if (t < 0) continue;
        const p = [A[i][0] + (A[i + 1][0] - A[i][0]) * t, A[i][1] + (A[i + 1][1] - A[i][1]) * t];
        const nearVertex = (P, k) => Math.min(Math.hypot(P[k][0] - p[0], P[k][1] - p[1]), Math.hypot(P[k + 1][0] - p[0], P[k + 1][1] - p[1])) < MERGE;
        if (nearVertex(A, i) && nearVertex(B, j)) continue;                       // they already share that vertex
        if (roads[r].bridge || roads[q].bridge) { issues.push({ level: 'note', what: 'road', id: roads[r].id, text: `passes ${roads[q].id} at (${p[0].toFixed(0)}, ${p[1].toFixed(0)}) on a bridge: treated as a grade separation` }); continue; }
        issues.push({ level: 'warning', what: 'road', id: roads[r].id, text: `crosses ${roads[q].id} at (${p[0].toFixed(1)}, ${p[1].toFixed(1)}) without a shared vertex; junction added` });
        const tb = distSqToSegment(p[0], p[1], B[j][0], B[j][1], B[j + 1][0], B[j + 1][1], t1) >= 0 ? t1[0] : 0;
        if (!nearVertex(A, i)) inserts.push({ road: r, seg: i, t, p }); else { const k = Math.hypot(A[i][0] - p[0], A[i][1] - p[1]) < MERGE ? i : i + 1; p[0] = A[k][0]; p[1] = A[k][1]; }
        if (!nearVertex(B, j)) inserts.push({ road: q, seg: j, t: tb, p: [p[0], p[1]] });
      }
    }
  }
  inserts.sort((a, b) => a.road - b.road || b.seg - a.seg || b.t - a.t);          // back to front so indices stay valid
  for (const ins of inserts) pts[ins.road].splice(ins.seg + 1, 0, ins.p);

  // 3. Cluster coincident vertices; a cluster is a node when a road ends there or two roads share it.
  const flat = [];   // { road, i }
  pts.forEach((P, r) => P.forEach((p, i) => flat.push({ road: r, i, p })));
  const parent = flat.map((_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const cellOf = new Map();
  flat.forEach((v, k) => {
    const cx = Math.floor(v.p[0] / MERGE), cz = Math.floor(v.p[1] / MERGE);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = cellOf.get((cx + dx) + ',' + (cz + dz)); if (!list) continue;
      for (const o of list) if (Math.hypot(flat[o].p[0] - v.p[0], flat[o].p[1] - v.p[1]) < MERGE) parent[find(k)] = find(o);
    }
    const key = cx + ',' + cz; if (!cellOf.has(key)) cellOf.set(key, []); cellOf.get(key).push(k);
  });
  const flatIndex = pts.map(() => []); flat.forEach((v, k) => { flatIndex[v.road][v.i] = k; });

  // Union two clusters. A pair of junctions merged later (step 5) is pinned to the point half way between them, so the
  // road they both lie on is not bent and each side road moves by half the stagger.
  const pins = new Map();
  const unite = (ka, kb, pin) => {
    const ra = find(ka), rb = find(kb); if (ra === rb) return;
    const keep = pin || pins.get(ra) || pins.get(rb);
    parent[ra] = rb; pins.delete(ra); if (keep) pins.set(rb, keep);
  };

  // 4. Nodes and edges. Two nodes joined by very little road are merged, which changes the clusters: repeat.
  const assemble = () => {
    for (let attempt = 0; ; attempt++) {
      const groups = new Map();
      flat.forEach((v, k) => { const g = find(k); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(k); });
      const nodeOf = new Map(), nodes = [];
      for (const [g, members] of groups) {
        let ends = 0; for (const k of members) { const v = flat[k]; if (v.i === 0 || v.i === pts[v.road].length - 1) ends++; }
        if (!ends && members.length < 2) continue;
        // Keep the through road's own vertex as the node position so its line is not bent.
        const anchor = members.find((k) => { const v = flat[k]; return v.i > 0 && v.i < pts[v.road].length - 1; }) ?? members[0];
        const at = pins.get(g) || flat[anchor].p;
        nodeOf.set(g, nodes.length); nodes.push({ id: nodes.length, x: at[0], z: at[1], legs: [], cluster: g });
      }
      const edges = []; let merged = false;
      roads.forEach((road, r) => {
        const P = pts[r]; let start = 0, len = 0;
        for (let i = 1; i < P.length; i++) {
          len += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
          const g = find(flatIndex[r][i]);
          if (!nodeOf.has(g)) continue;
          const a = nodeOf.get(find(flatIndex[r][start])), b = nodeOf.get(g);
          if (len < SHORT_EDGE && a !== b && !road.bridge && attempt < 4) { unite(flatIndex[r][start], flatIndex[r][i]); merged = true; }
          else if (a !== b || len > LOOP_MIN) edges.push({ id: edges.length, road: r, a, b, ctrl: P.slice(start, i + 1).map((p) => [p[0], p[1]]) });
          start = i; len = 0;
        }
      });
      if (merged) continue;
      for (const road of roads) { road.edges = []; road.length = 0; }
      for (const e of edges) {
        const na = nodes[e.a], nb = nodes[e.b];
        // How far each end was moved to reach its node (a merged junction sits between its former parts).
        const first = e.ctrl[0], last = e.ctrl[e.ctrl.length - 1];
        e.moved = [Math.hypot(first[0] - na.x, first[1] - na.z), Math.hypot(last[0] - nb.x, last[1] - nb.z)];
        e.ctrl[0] = [na.x, na.z]; e.ctrl[e.ctrl.length - 1] = [nb.x, nb.z];
        na.legs.push({ edge: e.id, end: 0 }); nb.legs.push({ edge: e.id, end: 1 });
        roads[e.road].edges.push(e.id);
      }
      const live = nodes.filter((n) => n.legs.length > 0);                         // nodes absorbed by a merge have no legs left
      const remap = new Map(live.map((n, i) => [n.id, i]));
      for (const e of edges) { e.a = remap.get(e.a); e.b = remap.get(e.b); }
      live.forEach((n, i) => { n.id = i; n.kind = n.legs.length >= 3 ? 'junction' : n.legs.length === 2 ? 'joint' : 'end'; });
      shapeEdges(roads, live, edges);
      measureJunctions(roads, live, edges, junctionHints);
      return { nodes: live, edges };
    }
  };

  // 5. Junctions whose stop lines would be closer together than a long vehicle: a bus waiting at one would stand
  //    across the other, so the pair becomes one junction.
  let net = assemble();
  for (let pass = 0; pass < 6; pass++) {
    let merged = 0;
    for (const e of net.edges) {
      const a = net.nodes[e.a], b = net.nodes[e.b];
      if (a === b || a.kind !== 'junction' || b.kind !== 'junction' || roads[e.road].bridge || e.length - e.setA - e.setB >= MIN_LINK) continue;
      if (find(a.cluster) === find(b.cluster)) continue;                           // already joined through another short link
      unite(a.cluster, b.cluster, [(a.x + b.x) / 2, (a.z + b.z) / 2]); merged++;
      issues.push({ level: 'note', what: 'road', id: roads[e.road].id, text: `junctions ${(e.length - e.setA - e.setB).toFixed(1)} m apart at (${a.x.toFixed(0)}, ${a.z.toFixed(0)}) merged into one` });
    }
    if (!merged) break;
    net = assemble();
  }
  for (const n of net.nodes) delete n.cluster;
  return { roads, nodes: net.nodes, edges: net.edges };
}

/** Smooth every edge. Two edges that meet at a joint share their tangent there so the kerbs run through cleanly. */
function shapeEdges(roads, nodes, edges) {
  // Traced lines often wobble in the last few metres before a node; a junction needs straight approaches.
  for (const e of edges) {
    const c = e.ctrl; let total = 0; for (let i = 1; i < c.length; i++) total += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
    // An end that was moved sideways to its node needs a longer run to swing back onto the traced line.
    const keep = (end) => Math.min(Math.max(14, e.moved[end] * 3), total / 3.2);
    const trimmed = c.filter((p, i) => i === 0 || i === c.length - 1 || (Math.hypot(p[0] - c[0][0], p[1] - c[0][1]) > keep(0) && Math.hypot(p[0] - c[c.length - 1][0], p[1] - c[c.length - 1][1]) > keep(1)));
    e.ctrl = trimmed; delete e.moved;
  }
  const neighbour = (e, end) => {
    const n = nodes[end ? e.b : e.a];
    if (n.kind !== 'joint') return null;
    const other = n.legs.find((l) => l.edge !== e.id || l.end !== end); if (!other) return null;
    const oc = edges[other.edge].ctrl;
    return other.end === 0 ? oc[1] : oc[oc.length - 2];
  };
  for (const e of edges) {
    const road = roads[e.road];
    const p = smoothPolyline(e.ctrl, 6, 0.12, neighbour(e, 0), neighbour(e, 1));
    const n = p.length / 2, st = new Float64Array(n);
    for (let i = 1; i < n; i++) st[i] = st[i - 1] + Math.hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
    e.pts = p; e.length = st[n - 1]; e.s0 = road.length; e.s1 = road.length + e.length; road.length = e.s1;
    for (let i = 0; i < n; i++) st[i] += e.s0;
    e.st = st; e.hw = road.hw; e.pw = road.pw; e.setA = 0; e.setB = 0;
  }
}

/** Unit direction of an edge leaving one of its ends, measured over the first `reach` metres. */
export function legDirection(e, end, reach = 12) {
  const p = e.pts, n = p.length / 2, s = e.st, target = Math.min(reach, e.length * 0.5);
  let i = end ? n - 1 : 0; const step = end ? -1 : 1, base = s[i];
  while (i + step >= 0 && i + step < n && Math.abs(s[i + step] - base) < target) i += step;
  if (i === (end ? n - 1 : 0)) i += step;
  const o = end ? n - 1 : 0, dx = p[i * 2] - p[o * 2], dz = p[i * 2 + 1] - p[o * 2 + 1], l = Math.hypot(dx, dz) || 1;
  return [dx / l, dz / l];
}

/** Junction setbacks (where each leg's plain carriageway stops), control type and signal groups. */
function measureJunctions(roads, nodes, edges, hints) {
  for (const n of nodes) {
    for (const leg of n.legs) { const d = legDirection(edges[leg.edge], leg.end); leg.dx = d[0]; leg.dz = d[1]; leg.angle = Math.atan2(d[1], d[0]); leg.setback = 0; }
    n.legs.sort((a, b) => a.angle - b.angle);
    n.control = 'none'; n.radius = 0; n.groups = 1;
    if (n.kind !== 'junction') continue;
    const k = n.legs.length;
    for (let i = 0; i < k; i++) {
      const leg = n.legs[i], e = edges[leg.edge]; let need = 0;
      for (const j of [(i + 1) % k, (i + k - 1) % k]) {
        const o = n.legs[j], oe = edges[o.edge];
        const cos = leg.dx * o.dx + leg.dz * o.dz, sin = Math.sqrt(Math.max(0, 1 - cos * cos));
        // Distance along this leg to where its kerb line meets the neighbour's kerb line.
        const reach = sin > 0.3 ? (oe.hw + e.hw * cos) / sin : cos > 0 ? oe.hw + e.hw : Math.max(0, oe.hw - e.hw);
        need = Math.max(need, Math.min(reach, MAX_REACH));
      }
      const kerbed = e.pw > 0;
      // A short leg gives up at most 45 % of its length, which leaves room for the junction at its other end. Where
      // the other end is only a joint the road carries on beyond it, so the leg may give up more when that is what
      // it takes to put the stop line outside the widest carriageway crossing in front of it.
      const far = nodes[leg.end === 0 ? e.b : e.a], facing = Math.max(...n.legs.filter((o) => o !== leg).map((o) => edges[o.edge].hw));
      const room = far.kind === 'joint' ? Math.max(e.length * 0.45, Math.min(e.length - 3, facing + CROSSING)) : e.length * 0.45;
      leg.setback = Math.min(Math.max(need + (kerbed ? FILLET * 0.6 + CROSSING : 1.5), e.hw * 0.6 + 3), room);
      if (leg.end === 0) e.setA = leg.setback; else e.setB = leg.setback;
      n.radius = Math.max(n.radius, leg.setback);
    }
    // Control: the layout's hint for the nearest junction, else by the classes that meet here.
    let hint = null, best = 14;
    for (const h of hints) { const d = Math.hypot(h.pos[0] - n.x, h.pos[1] - n.z); if (d < best) { best = d; hint = h.control; } }
    const widths = n.legs.map((l) => edges[l.edge].hw), major = Math.max(...widths), minor = Math.min(...widths);
    const generated = n.legs.some((l) => roads[edges[l.edge].road].generated), runway = n.legs.some((l) => roads[edges[l.edge].road].runway);
    if (runway) n.control = 'none';
    else if (generated) n.control = 'stop';
    else if (hint === 'signal' || hint === 'stop' || hint === 'none') n.control = hint;
    else if (hint === 'stop_minor') n.control = 'stop';
    else n.control = major >= 8 && minor >= 6 && k >= 4 ? 'signal' : 'stop';
    // The through route is the pair of legs that is widest and most nearly straight; at a stop junction it has
    // priority and the other legs stop. At signals it is group 0 and everything else group 1.
    let pair = null, score = -Infinity;
    for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
      const a = n.legs[i], b = n.legs[j], straight = -(a.dx * b.dx + a.dz * b.dz);
      const sc = straight * 20 + edges[a.edge].hw + edges[b.edge].hw + (edges[a.edge].road === edges[b.edge].road ? 6 : 0);
      if (straight > 0.5 && sc > score) { score = sc; pair = [i, j]; }
    }
    const allWay = hint === 'stop' && n.control === 'stop' && !generated && k >= 4;
    n.legs.forEach((leg, i) => {
      const through = pair && (i === pair[0] || i === pair[1]);
      leg.group = through ? 0 : 1;
      leg.control = n.control === 'signal' ? 'signal' : n.control === 'stop' ? (through && !allWay ? 'none' : 'stop') : 'none';
    });
    n.groups = n.control === 'signal' ? 2 : 1;
  }
}

/**
 * Point and unit tangent on an edge at an edge-local station (0 at node a). out = [x, z, tx, tz].
 * The right-hand side of the travel direction a -> b is (-tz, tx).
 */
export function edgePoint(e, s, out) {
  const n = e.pts.length / 2, target = e.s0 + s;
  let lo = 0, hi = n - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (e.st[mid] <= target) lo = mid; else hi = mid - 1; }
  const dx = e.pts[lo * 2 + 2] - e.pts[lo * 2], dz = e.pts[lo * 2 + 3] - e.pts[lo * 2 + 1], l = Math.hypot(dx, dz) || 1, t = (target - e.st[lo]) / l;
  out[0] = e.pts[lo * 2] + dx * t; out[1] = e.pts[lo * 2 + 1] + dz * t; out[2] = dx / l; out[3] = dz / l;
  return out;
}
