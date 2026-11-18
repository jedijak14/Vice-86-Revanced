// Panels: the coachwork is built the way a real body is, as separate sheets of metal cut from a surface.
// A panel is a polygon (with optional holes) in the chart of a sheet. Its skin is meshed in rows that follow
// the sheet's creases, and every edge of it can carry a "hem": a small swept profile that rolls the skin over
// with a real radius and returns into the body. Two neighbouring panels authored a few millimetres apart
// therefore produce a real shut line: two rolled edges, two walls and a dark floor. Nothing is drawn on.
//
// Chart polygons are prepared with the sheet's local metric, so clearances and corner radii are true
// millimetres on the car even where the chart is stretched.

import { VEHICLE } from '../../../core/ids.js';

const Q = 1e7;                                   // chart quantisation for vertex sharing
const key = (x) => Math.round(x * Q);

// ---------------------------------------------------------------- hem profiles
// A profile is described in the frame of a boundary point: o = outward in the surface, n = along the normal.
// Nodes carry a position and the normals of the segments that end and start there; segments carry a paint flag.

function node(o, n, inO, inN, outO = inO, outN = inN, occ = 1) { return { o, n, inO, inN, outO, outN, occ }; }

/**
 * Rolled edge: an arc of `radius` turning the skin by `turn` degrees, then a straight wall of `depth`,
 * then (optionally) a floor of width `floor` at a right angle, painted satin black.
 * Occlusion falls from 1 on the roll to `dark` at the bottom of the wall.
 */
export function hem({ radius = 0.004, turn = 90, depth = 0.008, floor = 0, segs = 4, dark = 0.12, wallTrim = false } = {}) {
  const nodes = [], paint = [], T = turn * Math.PI / 180;
  for (let i = 0; i <= segs; i++) { const th = T * i / segs, s = Math.sin(th), c = Math.cos(th); nodes.push(node(radius * s, -radius * (1 - c), s, c, s, c, 1 - 0.25 * i / segs)); if (i) paint.push(0); }
  const dx = Math.cos(T), dy = -Math.sin(T), last = nodes[nodes.length - 1], wn = [Math.sin(T), Math.cos(T)];
  if (depth > 0) {
    nodes.push(node(last.o + dx * depth, last.n + dy * depth, wn[0], wn[1], -dx, -dy, dark)); paint.push(wallTrim ? 1 : 0);
    if (floor > 0) { const w = nodes[nodes.length - 1]; nodes.push(node(w.o + wn[0] * floor, w.n + wn[1] * floor, -dx, -dy, -dx, -dy, dark * 0.8)); paint.push(1); }
  }
  // reach: how far the roll carries the edge outward; a panel's skin must stop this far short of its true outline.
  // drop: how far under the skin the wall ends, where whatever lies behind the edge may begin.
  return { nodes, paint, reach: radius * Math.sin(T), drop: radius * (1 - Math.cos(T)) + depth * Math.sin(T) };
}
/**
 * The standard shut line edge: one side of a 6 mm gap (spec GAP), 9 mm deep. The two floors meet under the gap;
 * each spans 3.6 mm so that they overlap by 1.2 mm and the gap stays closed where the hull's slope widens it.
 */
export const HEM_GAP = hem({ radius: 0.002, depth: 0.009, floor: 0.0036, segs: 3 });
/** A free edge that simply returns into the body (arch lips, lower edges). */
export const HEM_LIP = hem({ radius: 0.004, depth: 0.014 });
/** The edge of the flank duct: a fuller roll, so the opening carries a highlight line rather than a knife cut. */
export const HEM_DUCT = hem({ radius: 0.007, depth: 0.012, segs: 5 });
/** A plain cut with no roll, a short dark return (edges hidden under another part). */
export const HEM_TUCK = hem({ radius: 0.0008, depth: 0.006, segs: 1 });

// ---------------------------------------------------------------- loop preparation

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Chart displacement whose image under the sheet's Jacobian is closest to the 3D vector w. */
function pullBack(ja, jb, w) {
  const aa = dot(ja, ja), ab = dot(ja, jb), bb = dot(jb, jb), wa = dot(w, ja), wb = dot(w, jb), det = aa * bb - ab * ab || 1e-30;
  return [(wa * bb - wb * ab) / det, (wb * aa - wa * ab) / det];
}

function signedArea(pts) { let s = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i].p || pts[i], q = pts[(i + 1) % n].p || pts[(i + 1) % n]; s += p[0] * q[1] - q[0] * p[1]; } return s / 2; }

/**
 * Turn an authored loop into a dense chart polyline.
 * Authored vertex: { p: [a, b], r: corner radius in metres (0 = keep the corner), hem: profile or null for the edge
 * that leaves this vertex, via: 0 | 1 (the edge is straight in the loft's section coordinate p or q instead of in the
 * chart), range: [bLo, bHi] for solving `via`, inset: clearance of the edge leaving this vertex (overrides opts.inset),
 * margin: clearance already provided by the sheet itself (only used to keep corner radii concentric),
 * sharp: true to start a new hem run here }.
 * opts: { inset: metres to shrink the loop on the surface, hole: true to orient clockwise, cornerSegs,
 *         tolerance: how far a curved edge may stray from its chords (m), halvings: least number of times such an
 *         edge is halved (default 3) }.
 * Returns points { p: [a, b], hem, sharp }.
 */
export function prepareLoop(sheet, verts, opts = {}) {
  const ccw = signedArea(verts) > 0, want = !opts.hole, m = verts.length;
  const edgeOf = (v) => ({ hem: v.hem, via: v.via, range: v.range, inset: v.inset, margin: v.margin });
  // reversing the order hands every edge to the vertex at its other end
  let V = ccw === want ? verts.map((v) => ({ ...v })) : verts.map((v, i) => ({ ...verts[m - 1 - i], ...edgeOf(verts[(2 * m - 2 - i) % m]) }));
  V = V.map((v) => ({ ...v, p: [v.p[0], v.p[1]] }));
  // an edge of no length (two authored vertices at the same place) has no direction: keep only the vertex that starts a real edge
  V = V.filter((v, i) => { const o = V[(i + 1) % V.length], same = Math.abs(v.p[0] - o.p[0]) < 1e-6 && Math.abs(v.p[1] - o.p[1]) < 1e-9; if (same && v.sharp) o.sharp = true; return !same; });
  const n = V.length, sgn = sheet.flip ? -1 : 1;

  // Metric work is done in (a, distance across the section) where the sheet offers it: there the surface map is even.
  const toMetric = sheet.arcOf ? (p) => [p[0], sheet.arcOf(p[0], p[1])] : (p) => p;
  const fromMetric = sheet.bOf ? (q) => [q[0], sheet.bOf(q[0], q[1])] : (q) => q;
  const P = (p) => sheet.pos(p[0], p[1], [0, 0, 0]);
  const frameAt = (p) => {
    const q = toMetric(p), ha = sheet.ha || 1e-3, hs = sheet.hs || ha;
    const a0 = P(fromMetric([q[0] - ha, q[1]])), a1 = P(fromMetric([q[0] + ha, q[1]])), s0 = P(fromMetric([q[0], q[1] - hs])), s1 = P(fromMetric([q[0], q[1] + hs]));
    const ja = [(a1[0] - a0[0]) / (2 * ha), (a1[1] - a0[1]) / (2 * ha), (a1[2] - a0[2]) / (2 * ha)], js = [(s1[0] - s0[0]) / (2 * hs), (s1[1] - s0[1]) / (2 * hs), (s1[2] - s0[2]) / (2 * hs)];
    const c = [ja[1] * js[2] - ja[2] * js[1], ja[2] * js[0] - ja[0] * js[2], ja[0] * js[1] - ja[1] * js[0]], l = (len(c) || 1) * sgn;
    return { q, ja, js, nrm: [c[0] / l, c[1] / l, c[2] / l] };
  };
  /** Chart point reached from p by the surface displacement w (a 3D vector in the tangent plane). */
  const moved = (f, w) => { const d = pullBack(f.ja, f.js, w); return fromMetric([f.q[0] + d[0], f.q[1] + d[1]]); };
  /** Point at parameter t of the edge from chart point p0 to p1 authored on vertex v. */
  const along = (v, p0, p1) => {
    if (v.via !== 0 && v.via !== 1) return (t) => [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
    const w = v.via, s0 = sheet.sec(p0[0], p0[1])[w], s1 = sheet.sec(p1[0], p1[1])[w];
    return (t) => { if (t === 0) return p0; if (t === 1) return p1; const a = p0[0] + (p1[0] - p0[0]) * t; return [a, sheet.solve(a, w, s0 + (s1 - s0) * t, v.range[0], v.range[1])]; };
  };
  /** Unit directions in which the two edges leave vertex i (back along the incoming edge, forward along the outgoing one) and their lengths. */
  const directions = (i) => {
    const prev = (i + n - 1) % n, next = (i + 1) % n, here = P(V[i].p), eps = 0.02;
    const back = sub(P(along(V[prev], V[prev].p, V[i].p)(1 - eps)), here), fwd = sub(P(along(V[i], V[i].p, V[next].p)(eps)), here);
    const lb = len(back) || 1e-12, lf = len(fwd) || 1e-12;
    return { back: [back[0] / lb, back[1] / lb, back[2] / lb], fwd: [fwd[0] / lf, fwd[1] / lf, fwd[2] / lf], lenBack: lb / eps, lenFwd: lf / eps };
  };
  /** The point of the edge p0 -> p1 (authored on vertex v), or of its extension, level with chart point p along the edge's longer chart axis. */
  const ontoEdge = (v, p0, p1, p, extend = false) => {
    const q0 = toMetric(p0), q1 = toMetric(p1), q = toMetric(p), k = Math.abs(q1[0] - q0[0]) >= Math.abs(q1[1] - q0[1]) ? 0 : 1;
    const t = (q[k] - q0[k]) / (q1[k] - q0[k]);
    return along(v, p0, p1)(extend ? t : Math.max(0, Math.min(1, t)));
  };
  const crossed = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];

  // Clearances: every edge may be moved into the panel by its own amount (half a shut line, or nothing on the centreline).
  const insetOf = (v) => v.inset ?? opts.inset ?? 0;
  /** Distance from the authored outline to the skin edge: the inset plus any margin already built into the sheet (see shiftRow). */
  const clearanceOf = (v) => insetOf(v) + (v.margin || 0);
  if (V.some((v) => insetOf(v) !== 0)) {
    const shifted = V.map((v, i) => {
      const e0 = insetOf(V[(i + n - 1) % n]), e1 = insetOf(v); if (e0 === 0 && e1 === 0) return v.p;
      const f = frameAt(v.p), d = directions(i);
      // into the panel: chart normal x direction of travel (the loop runs counter-clockwise in the chart)
      const up = [f.nrm[0] * sgn, f.nrm[1] * sgn, f.nrm[2] * sgn], n0 = crossed(up, [-d.back[0], -d.back[1], -d.back[2]]), n1 = crossed(up, d.fwd);
      const c = dot(n0, n1), det = 1 - c * c;
      let al, be; if (det < 1e-3) { al = be = (e0 + e1) / (2 * (1 + c) || 1); } else { al = (e0 - c * e1) / det; be = (e1 - c * e0) / det; }
      const w = [n0[0] * al + n1[0] * be, n0[1] * al + n1[1] * be, n0[2] * al + n1[2] * be], wl = len(w), cap = 4 * Math.max(Math.abs(e0), Math.abs(e1));
      if (wl > cap) { w[0] *= cap / wl; w[1] *= cap / wl; w[2] *= cap / wl; }
      // a vertex whose other edge has no clearance only slides along that edge: keep it exactly on it (it may be a mesh row)
      const q = moved(f, w), prev = V[(i + n - 1) % n], next = V[(i + 1) % n];
      if (e0 === 0) return ontoEdge(prev, prev.p, v.p, q, true);
      if (e1 === 0) return ontoEdge(v, v.p, next.p, q, true);
      return q;
    });
    shifted.forEach((q, i) => { V[i].p = q; });
  }
  // corner fillets, drawn in the tangent plane of each corner
  const segs90 = opts.cornerSegs || 5, corners = [];
  for (let i = 0; i < n; i++) {
    const v = V[i]; if (!(v.r > 0)) { corners.push([{ p: v.p, sharp: !!v.sharp }]); continue; }
    const d = directions(i), th = Math.acos(Math.max(-1, Math.min(1, dot(d.back, d.fwd))));          // interior angle
    if (th > Math.PI - 0.02) { corners.push([{ p: v.p }]); continue; }
    // The radius is authored for the outline. The skin runs parallel to it at the clearance of its edges: inside it
    // on a convex corner (smaller radius), outside it on a concave one (larger), so shut lines keep their width round corners.
    const f = frameAt(v.p), clear = (clearanceOf(V[(i + n - 1) % n]) + clearanceOf(v)) / 2;
    const convex = dot(crossed([-d.back[0], -d.back[1], -d.back[2]], d.fwd), f.nrm) * sgn > 0, want = Math.max(v.r + (convex ? -clear : clear), 0.0005);
    const tn = Math.tan(th / 2), set = Math.min(want / tn, 0.45 * d.lenBack, 0.45 * d.lenFwd), r = set * tn;
    const bis = [d.back[0] + d.fwd[0], d.back[1] + d.fwd[1], d.back[2] + d.fwd[2]], bl = len(bis) || 1, cd = r / Math.sin(th / 2);
    const C = [bis[0] / bl * cd, bis[1] / bl * cd, bis[2] / bl * cd];                                   // arc centre relative to the corner
    const s0 = sub([d.back[0] * set, d.back[1] * set, d.back[2] * set], C), s1 = sub([d.fwd[0] * set, d.fwd[1] * set, d.fwd[2] * set], C);
    const sweep = Math.PI - th, cnt = Math.max(2, Math.ceil(sweep / (Math.PI / 2) * segs90)), arcPts = [];
    for (let k = 0; k <= cnt; k++) {
      const t = k / cnt, sn = Math.sin(sweep), w0 = Math.sin((1 - t) * sweep) / sn, w1 = Math.sin(t * sweep) / sn;
      arcPts.push({ p: moved(f, [C[0] + s0[0] * w0 + s1[0] * w1, C[1] + s0[1] * w0 + s1[1] * w1, C[2] + s0[2] * w0 + s1[2] * w1]) });
    }
    // The arc was laid out in the tangent plane; put its two ends back exactly on the edges they join, so that an
    // edge running along a mesh row stays on that row.
    arcPts[0].p = ontoEdge(V[(i + n - 1) % n], V[(i + n - 1) % n].p, v.p, arcPts[0].p);
    arcPts[cnt].p = ontoEdge(v, v.p, V[(i + 1) % n].p, arcPts[cnt].p);
    corners.push(arcPts);
  }
  // edges between corners
  const out = [], tol = opts.tolerance || 2e-4, least = opts.halvings ?? 3;
  for (let i = 0; i < n; i++) {
    const v = V[i], arcPts = corners[i], next = corners[(i + 1) % n][0];
    // a rounded corner continues the hem of the edge that arrives at it
    for (let k = 0; k < arcPts.length - 1; k++) out.push({ p: arcPts[k].p, hem: v.r > 0 ? V[(i + n - 1) % n].hem ?? v.hem ?? null : v.hem ?? null, sharp: arcPts[k].sharp });
    const from = arcPts[arcPts.length - 1];
    out.push({ p: from.p, hem: v.hem ?? null, sharp: from.sharp });
    if (v.via === 0 || v.via === 1) {
      const at = along(v, from.p, next.p);
      const rec = (t0, c0, t1, c1, depth) => {
        const tm = (t0 + t1) / 2, cm = at(tm), pa = P(cm), pb = P([(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2]);
        if (depth < 9 && (depth < least || Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]) > tol)) { rec(t0, c0, tm, cm, depth + 1); out.push({ p: cm, hem: v.hem ?? null }); rec(tm, cm, t1, c1, depth + 1); }
      };
      rec(0, from.p, 1, next.p, 0);
    }
  }
  // drop coincident neighbours
  return out.filter((q, i) => { const o = out[(i + 1) % out.length]; return Math.abs(q.p[0] - o.p[0]) > 1e-7 || Math.abs(q.p[1] - o.p[1]) > 1e-9 || q.sharp; });
}

// ---------------------------------------------------------------- skin tessellation

/** Chart distance in b below which two boundary vertices are taken to lie on the same mesh row. */
const ROW_SNAP = 0.0015;

/**
 * Mesh the interior of prepared loops on a sheet. Rows are lines of constant b: the sheet's crease rows, one row
 * through every boundary vertex, and filler rows no further apart than `db`. Along each row vertices sit on a global
 * lattice of spacing `da` plus the exact boundary crossings, so rows stitch without T-junctions. A boundary edge
 * that crosses a strip between two rows at a shallow angle carries lattice vertices of its own.
 * shade(mb, a, b, P, N) may set per-vertex state (colour, occlusion) and returns [u, v] or nothing.
 * Returns the loops refined with every boundary vertex of the mesh.
 */
export function meshLoops(mb, sheet, loops, { da, db, shade = null, cols = null }) {
  const edges = [];
  let bMin = Infinity, bMax = -Infinity;
  // An edge meant to run along a row seldom keeps exactly one b once its loop has been inset on a curved sheet. Left
  // alone, the hair-thin strip between its two ends is filled by a fan of triangles a metre long that cut across the
  // surface. Boundary levels closer than ROW_SNAP are therefore gathered onto one row (their mean).
  const levels = new Map(), authored = [...new Set(loops.flatMap((loop) => loop.map((v) => v.p[1])))].sort((x, y) => x - y);
  for (let i = 0; i < authored.length;) {
    let j = i; while (j + 1 < authored.length && authored[j + 1] - authored[i] < ROW_SNAP) j++;
    let mean = 0; for (let k = i; k <= j; k++) mean += authored[k] / (j - i + 1);
    for (let k = i; k <= j; k++) levels.set(key(authored[k]), mean);
    i = j + 1;
  }
  const snap = (b) => { const k = key(b); if (!levels.has(k)) levels.set(k, b); return levels.get(k); };
  for (const loop of loops) for (let i = 0, m = loop.length; i < m; i++) {
    const p = loop[i].p, q = loop[(i + 1) % m].p, b0 = snap(p[1]), b1 = snap(q[1]);
    bMin = Math.min(bMin, b0); bMax = Math.max(bMax, b0);
    if (b0 !== b1) edges.push(b0 < b1 ? [p[0], b0, q[0], b1] : [q[0], b1, p[0], b0]);
  }
  for (const r of sheet.rows()) if (r > bMin && r < bMax) snap(r);
  let rows = [...levels.values()].sort((x, y) => x - y);
  const filled = [];
  for (let i = 0; i < rows.length; i++) {
    filled.push(rows[i]);
    if (i + 1 < rows.length) { const gap = rows[i + 1] - rows[i], m = Math.ceil(gap / db - 1e-9); for (let k = 1; k < m; k++) filled.push(rows[i] + gap * k / m); }
  }
  rows = filled;
  const rowIndex = new Map(rows.map((b, i) => [key(b), i]));
  // trapezoids per strip
  const traps = [], special = rows.map(() => new Set());
  const order = edges.slice().sort((e, f) => e[1] - f[1]);
  for (let i = 0; i + 1 < rows.length; i++) {
    const b0 = rows[i], b1 = rows[i + 1], bm = (b0 + b1) / 2, hit = [];
    for (const e of order) {
      if (e[1] > bm) break; if (e[3] < bm) continue;
      const span = e[3] - e[1], x0 = e[0] + (e[2] - e[0]) * (b0 - e[1]) / span, x1 = e[0] + (e[2] - e[0]) * (b1 - e[1]) / span;
      hit.push([key(b0) === key(e[1]) ? e[0] : x0, key(b1) === key(e[3]) ? e[2] : x1]);
    }
    hit.sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
    for (let k = 0; k + 1 < hit.length; k += 2) {
      const L = hit[k], Rr = hit[k + 1]; if (Rr[0] - L[0] < 1e-9 && Rr[1] - L[1] < 1e-9) continue;
      traps.push([i, L[0], Rr[0], L[1], Rr[1]]);
      special[i].add(key(L[0])); special[i].add(key(Rr[0])); special[i + 1].add(key(L[1])); special[i + 1].add(key(Rr[1]));
    }
  }
  // candidate positions along each row: lattice and hard columns, minus those crowding a boundary crossing
  const hard = (cols || sheet.cols()).slice().sort((x, y) => x - y);
  const rowPts = special.map((set) => [...set].map((k) => k / Q).sort((x, y) => x - y));
  const verts = rows.map(() => new Map()), P = [0, 0, 0], Nn = [0, 0, 0];
  const vertex = (row, a) => {
    const k = key(a); let v = verts[row].get(k);
    if (v === undefined) {
      const b = rows[row]; sheet.pos(a, b, P); sheet.normal(a, b, Nn);
      const uv = shade ? shade(mb, a, b, P, Nn) : null;
      v = mb.vertex(P[0], P[1], P[2], Nn[0], Nn[1], Nn[2], uv ? uv[0] : a, uv ? uv[1] : b); verts[row].set(k, v);
    }
    return v;
  };
  const line = (row, x0, x1) => {
    const out = [x0], sp = rowPts[row], crowd = da * 0.25;
    if (x1 - x0 > 1e-9) {
      const cand = [];
      for (let a = Math.ceil((x0 + 1e-9) / da) * da; a < x1 - 1e-9; a += da) cand.push(a);
      for (const h of hard) if (h > x0 + 1e-9 && h < x1 - 1e-9) cand.push(h);
      for (const s of sp) if (s > x0 + 1e-9 && s < x1 - 1e-9) cand.push(s);
      cand.sort((x, y) => x - y);
      const isSpecial = (a) => special[row].has(key(a));
      let lastKept = x0;
      for (const a of cand) {
        if (isSpecial(a)) { if (a - lastKept > 1e-9) { out.push(a); lastKept = a; } continue; }
        // a lattice point survives only if no boundary crossing of this row is closer than `crowd`
        let near = false; for (const s of sp) { if (Math.abs(s - a) < crowd) { near = true; break; } }
        if (!near && a - lastKept > 1e-9) { out.push(a); lastKept = a; }
      }
      out.push(x1);
    }
    return out;
  };
  // Where a boundary edge passes through a strip at a shallow angle (the top of a door, inset on a side that grows
  // taller towards the tail, ends a millimetre lower than it starts), the strip there is a wedge as long as the edge
  // and hair-thin. Zipped from row to row it would be a fan from its far corner: triangles a metre long whose planes
  // have nothing to do with the surface, some of them facing inward. So such an edge is given the lattice's vertices
  // along its own length. shallow() returns them as chart points from the lower row to the upper.
  const shallow = (a0, b0, a1, b1) => {
    const out = [], first = Math.min(a0, a1), last = Math.max(a0, a1), crowd = da * 0.25;
    if (last - first <= 2 * da) return out;
    for (let a = Math.ceil((first + crowd) / da) * da; a < last - crowd; a += da) out.push([a, b0 + (b1 - b0) * (a - a0) / (a1 - a0)]);
    return a1 < a0 ? out.reverse() : out;
  };
  const free = ([a, b]) => {
    sheet.pos(a, b, P); sheet.normal(a, b, Nn);
    const uv = shade ? shade(mb, a, b, P, Nn) : null;
    return mb.vertex(P[0], P[1], P[2], Nn[0], Nn[1], Nn[2], uv ? uv[0] : a, uv ? uv[1] : b);
  };
  const flip = sheet.flip;
  const d2 = (i, j) => { const pos = mb.pos, x = pos[i * 3] - pos[j * 3], y = pos[i * 3 + 1] - pos[j * 3 + 1], z = pos[i * 3 + 2] - pos[j * 3 + 2]; return x * x + y * y + z * z; };
  const tri = (a, b, c) => { if (a === b || b === c || a === c || d2(a, b) < 1e-13 || d2(b, c) < 1e-13 || d2(a, c) < 1e-13) return; if (flip) mb.tri(a, c, b); else mb.tri(a, b, c); };
  for (const t of traps) {
    let lo = line(t[0], t[1], t[2]).map((a) => vertex(t[0], a)), hi = line(t[0] + 1, t[3], t[4]).map((a) => vertex(t[0] + 1, a));
    // a shallow side joins the chain it lies along: the upper one where it leans away from the trapezoid's middle
    // going down, the lower one where it leans away going up
    const b0 = rows[t[0]], b1 = rows[t[0] + 1], left = shallow(t[1], b0, t[3], b1).map(free), right = shallow(t[2], b0, t[4], b1).map(free);
    if (left.length) { if (t[3] > t[1]) hi = [lo[0], ...left, ...hi]; else lo = [hi[0], ...left.reverse(), ...lo]; }
    if (right.length) { if (t[4] > t[2]) lo = [...lo, ...right, hi[hi.length - 1]]; else hi = [...hi, ...right.reverse(), lo[lo.length - 1]]; }
    let i = 0, j = 0;
    while (i < lo.length - 1 || j < hi.length - 1) {
      const canLo = i < lo.length - 1, canHi = j < hi.length - 1;
      if (canLo && (!canHi || d2(lo[i + 1], hi[j]) <= d2(lo[i], hi[j + 1]))) { tri(lo[i], lo[i + 1], hi[j]); i++; }
      else { tri(lo[i], hi[j + 1], hi[j]); j++; }
    }
  }
  // The boundary as the skin actually meshed it: loop vertices plus every row crossing and lattice point on the way,
  // so that hems share the skin's edge vertices exactly.
  return loops.map((loop) => {
    const out = [];
    for (let i = 0, m = loop.length; i < m; i++) {
      const v = loop[i], p = [v.p[0], snap(v.p[1])], q = [loop[(i + 1) % m].p[0], snap(loop[(i + 1) % m].p[1])], r0 = rowIndex.get(key(p[1])), r1 = rowIndex.get(key(q[1]));
      out.push({ p: [p[0], rows[r0]], hem: v.hem, sharp: v.sharp });
      if (r0 === r1) { const as = line(r0, Math.min(p[0], q[0]), Math.max(p[0], q[0])).slice(1, -1); if (q[0] < p[0]) as.reverse(); for (const a of as) out.push({ p: [a, rows[r0]], hem: v.hem }); continue; }
      const step = r1 > r0 ? 1 : -1, lo = r1 > r0 ? p : q, hi = r1 > r0 ? q : p, span = rows[rowIndex.get(key(hi[1]))] - rows[rowIndex.get(key(lo[1]))];
      const at = (r) => (r === r0 ? p[0] : r === r1 ? q[0] : lo[0] + (hi[0] - lo[0]) * (rows[r] - rows[rowIndex.get(key(lo[1]))]) / span);
      for (let r = r0; r !== r1; r += step) {
        if (r !== r0) out.push({ p: [at(r), rows[r]], hem: v.hem });
        const below = Math.min(r, r + step), above = below + 1, pts = shallow(at(below), rows[below], at(above), rows[above]);
        for (const s of step > 0 ? pts : pts.reverse()) out.push({ p: s, hem: v.hem });
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------- hems

const MIN_HEM_STEP = 0.0006;
const CENTRE_SNAP = 1e-6;      // a skin vertex this close to x = 0 is on the centre plane, m

/** Sweep hem profiles along the prepared loops of a panel. */
export function sweepHems(mb, sheet, fullLoop) {
  // Boundary vertices closer together than the hem is fine would only give needle triangles with unreliable
  // directions; the hem skips them (the skin edge between its neighbours is straight to within microns).
  let last = null;
  const loop = fullLoop.map((q) => ({ q, P: sheet.pos(q.p[0], q.p[1], [0, 0, 0]) })).filter((e) => {
    const keep = !last || e.q.sharp || len(sub(e.P, last)) > MIN_HEM_STEP; if (keep) last = e.P; return keep;
  }).map((e) => e.q);
  const m = loop.length; if (m < 2) return;
  const P = loop.map((q) => sheet.pos(q.p[0], q.p[1], [0, 0, 0])), Nn = loop.map((q) => sheet.normal(q.p[0], q.p[1], [0, 0, 0]));
  const side = sheet.flip ? -1 : 1;
  // runs of consecutive hemmed segments, broken at sharp vertices and where the profile changes
  const runs = []; let cur = null;
  const start = (() => { for (let i = 0; i < m; i++) { const prev = loop[(i + m - 1) % m]; if (!loop[i].hem || !prev.hem || loop[i].sharp || prev.hem !== loop[i].hem) return i; } return 0; })();
  for (let s = 0; s < m; s++) {
    const i = (start + s) % m, q = loop[i];
    if (!q.hem) { cur = null; continue; }
    if (!cur || q.sharp || cur.hem !== q.hem) { cur = { hem: q.hem, idx: [i] }; runs.push(cur); }
    cur.idx.push((i + 1) % m);
  }
  const saveM = mb._m.slice(), saveC = mb._c.slice();
  for (const run of runs) {
    const idx = run.idx, closed = idx.length > 2 && idx[0] === idx[idx.length - 1] && !loop[idx[0]].sharp, cnt = idx.length;
    const O = [];
    for (let k = 0; k < cnt; k++) {
      const i = idx[k]; let a = idx[Math.max(0, k - 1)], b = idx[Math.min(cnt - 1, k + 1)];
      if (closed && k === 0) a = idx[cnt - 2]; if (closed && k === cnt - 1) b = idx[1];
      const t = sub(P[b], P[a]), nr = Nn[i], o = [t[1] * nr[2] - t[2] * nr[1], t[2] * nr[0] - t[0] * nr[2], t[0] * nr[1] - t[1] * nr[0]], l = (len(o) || 1) * side;
      O.push([o[0] / l, o[1] / l, o[2] / l]);
    }
    // A hem that ends on the car's centre plane (x = 0, where the mirrored half takes over) keeps its end section in
    // that plane. Left to the skin's own directions there it leans a few tenths of a millimetre across the plane or
    // away from it, and the two halves of the fold overlap or stand apart.
    const inPlane = (v) => { const l = Math.hypot(v[1], v[2]) || 1; return [0, v[1] / l, v[2] / l]; };
    const N = idx.map((i, k) => { if (Math.abs(P[i][0]) > CENTRE_SNAP) return Nn[i]; O[k] = inPlane(O[k]); return inPlane(Nn[i]); });
    const { nodes, paint } = run.hem;
    for (let g = 0; g + 1 < nodes.length; g++) {
      const n0 = nodes[g], n1 = nodes[g + 1];
      if (paint[g]) { mb.material(VEHICLE.TRIM_BLACK, 200); mb.color(0.02, 0.02, 0.02); } else { mb._m = saveM.slice(); mb._c[0] = saveC[0]; mb._c[1] = saveC[1]; mb._c[2] = saveC[2]; }
      const base = mb.count;
      for (let k = 0; k < cnt; k++) {
        const i = idx[k], p = P[i], o = O[k], nr = N[k];
        mb.occlusion(n0.occ * saveC[3] / 255);
        mb.vertex(p[0] + o[0] * n0.o + nr[0] * n0.n, p[1] + o[1] * n0.o + nr[1] * n0.n, p[2] + o[2] * n0.o + nr[2] * n0.n, o[0] * n0.outO + nr[0] * n0.outN, o[1] * n0.outO + nr[1] * n0.outN, o[2] * n0.outO + nr[2] * n0.outN, loop[i].p[0], loop[i].p[1]);
        mb.occlusion(n1.occ * saveC[3] / 255);
        mb.vertex(p[0] + o[0] * n1.o + nr[0] * n1.n, p[1] + o[1] * n1.o + nr[1] * n1.n, p[2] + o[2] * n1.o + nr[2] * n1.n, o[0] * n1.inO + nr[0] * n1.inN, o[1] * n1.inO + nr[1] * n1.inN, o[2] * n1.inO + nr[2] * n1.inN, loop[i].p[0], loop[i].p[1]);
      }
      // Travelling along the loop with the interior on the left (as seen from outside), the profile runs to the right.
      for (let k = 0; k + 1 < cnt; k++) { const a = base + k * 2, b = a + 2; if (side > 0) mb.quad(a, a + 1, b + 1, b); else mb.quad(a, b, b + 1, a + 1); }
    }
  }
  mb._m = saveM; mb._c = saveC;
}

/**
 * Build one panel: skin plus hems.
 * spec: { outer: [vertex...], holes: [[vertex...]], inset, holeInset, da, db, shade, cornerSegs, tolerance, halvings }.
 * The current family, material, colour and occlusion of the builder are used for the skin and the painted part of the hems.
 * Returns the prepared loops (outer first) for callers that place parts along the same edges.
 */
export function buildPanel(mb, sheet, spec) {
  const edges = { cornerSegs: spec.cornerSegs, tolerance: spec.tolerance, halvings: spec.halvings };
  const loops = [prepareLoop(sheet, spec.outer, { inset: spec.inset || 0, ...edges })];
  for (const h of spec.holes || []) loops.push(prepareLoop(sheet, h, { hole: true, inset: spec.holeInset || 0, ...edges }));
  const refined = meshLoops(mb, sheet, loops, spec);
  for (const loop of refined) sweepHems(mb, sheet, loop);
  return refined;
}
