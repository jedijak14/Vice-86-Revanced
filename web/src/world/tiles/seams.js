// Closing the seams of a clipped mesh.
//
// The ground mesher cuts each cell by one contour after another. A later cut adds a point to an edge that an
// earlier piece on the other side of that edge already took as one straight run: the point lies on the neighbour's
// edge but is not one of its corners. On the GPU the two sides are then rasterised from different end points and
// single pixels of whatever lies behind show through along the line (most visibly along the foot of a kerb, where
// the road is cut at the gutter and at junction mouths but the kerb face is not).
// closeSeams finds every such point and divides the triangle that lacks it, so that both sides of every edge use
// the same vertices. Nothing moves: the new triangles lie in the plane of the one they replace.

import { FAMILY } from '../../core/ids.js';

const QUANTUM = 1000;            // positions are matched to the millimetre
const ON_EDGE = 0.0015;          // metres a point may lie off an edge and still be taken as on it
const CELL = 2;                  // metres: bucket size of the search grid for points on an edge

/**
 * Table from three non-negative integers to an integer (-1 until set), with open addressing: this pass looks up
 * every vertex and every triangle edge of a tile, and a Map keyed by numbers that large costs several times more.
 */
class TripleTable {
  constructor(entries) {
    let size = 64; while (size < entries * 2) size *= 2;
    this.mask = size - 1; this.a = new Int32Array(size).fill(-1); this.b = new Int32Array(size); this.c = new Int32Array(size); this.value = new Int32Array(size).fill(-1);
  }
  /** The slot of (a, b, c), claimed for it if it was not in the table. */
  slot(a, b, c) {
    let h = (Math.imul(a, 0x9E3779B1) ^ Math.imul(b, 0x85EBCA6B) ^ Math.imul(c, 0xC2B2AE35)) & this.mask;
    while (this.a[h] !== -1 && (this.a[h] !== a || this.b[h] !== b || this.c[h] !== c)) h = (h + 1) & this.mask;
    this.a[h] = a; this.b[h] = b; this.c[h] = c;
    return h;
  }
}

/**
 * Divide the triangles of a MeshBuilder at the points that other triangles put on their edges.
 * Returns the number of points inserted.
 */
export function closeSeams(mb) {
  const n = mb.count; if (!n) return 0;
  // ---- one id per distinct position
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (let i = 0; i < n; i++) { minX = Math.min(minX, mb.pos[i * 3]); minY = Math.min(minY, mb.pos[i * 3 + 1]); minZ = Math.min(minZ, mb.pos[i * 3 + 2]); }
  const weld = new Int32Array(n), first = [], positions = new TripleTable(n);
  for (let i = 0; i < n; i++) {
    const slot = positions.slot(Math.round((mb.pos[i * 3] - minX) * QUANTUM), Math.round((mb.pos[i * 3 + 1] - minY) * QUANTUM), Math.round((mb.pos[i * 3 + 2] - minZ) * QUANTUM));
    if (positions.value[slot] < 0) { positions.value[slot] = first.length; first.push(i); }
    weld[i] = positions.value[slot];
  }

  // ---- edges used by one triangle only
  let corners = 0; for (let f = 0; f < FAMILY.COUNT; f++) corners += mb.idxLen[f];
  const edges = new TripleTable(corners), slots = new Int32Array(corners); let c = 0;
  for (let f = 0; f < FAMILY.COUNT; f++) {
    const idx = mb.idx[f], len = mb.idxLen[f];
    for (let t = 0; t < len; t += 3) for (let e = 0; e < 3; e++, c++) {
      const a = weld[idx[t + e]], b = weld[idx[t + (e + 1) % 3]]; if (a === b) { slots[c] = -1; continue; }
      const slot = a < b ? edges.slot(a, b, 0) : edges.slot(b, a, 0); edges.value[slot] = edges.value[slot] < 0 ? 1 : edges.value[slot] + 1; slots[c] = slot;
    }
  }
  const places = first.length, open = [], onOpen = new Uint8Array(places); c = 0;
  for (let f = 0; f < FAMILY.COUNT; f++) {
    const idx = mb.idx[f], len = mb.idxLen[f];
    for (let t = 0; t < len; t += 3) for (let e = 0; e < 3; e++, c++) {
      if (slots[c] < 0 || edges.value[slots[c]] !== 1) continue;
      open.push(f, t, e); onOpen[weld[idx[t + e]]] = 1; onOpen[weld[idx[t + (e + 1) % 3]]] = 1;
    }
  }
  if (!open.length) return 0;

  // ---- the end points of open edges, bucketed on the ground plane
  const buckets = new Map(), bucketOf = (x, z) => Math.floor((x - minX) / CELL) * 4096 + Math.floor((z - minZ) / CELL);
  for (let id = 0; id < places; id++) {
    if (!onOpen[id]) continue;
    const key = bucketOf(mb.pos[first[id] * 3], mb.pos[first[id] * 3 + 2]); let list = buckets.get(key); if (!list) buckets.set(key, list = []); list.push(id);
  }

  // ---- points lying inside each open edge, gathered per triangle
  const divided = new Map();      // family * 2^32 + triangle offset -> [points on edge 0, on edge 1, on edge 2], each [t, place]
  for (let o = 0; o < open.length; o += 3) {
    const f = open[o], t = open[o + 1], e = open[o + 2], idx = mb.idx[f], ia = idx[t + e], ib = idx[t + (e + 1) % 3], wa = weld[ia], wb = weld[ib];
    const ax = mb.pos[ia * 3], ay = mb.pos[ia * 3 + 1], az = mb.pos[ia * 3 + 2], dx = mb.pos[ib * 3] - ax, dy = mb.pos[ib * 3 + 1] - ay, dz = mb.pos[ib * 3 + 2] - az, l2 = dx * dx + dy * dy + dz * dz;
    const margin = ON_EDGE / Math.sqrt(l2); let found = null;
    const i0 = Math.floor((Math.min(ax, ax + dx) - ON_EDGE - minX) / CELL), i1 = Math.floor((Math.max(ax, ax + dx) + ON_EDGE - minX) / CELL);
    const j0 = Math.floor((Math.min(az, az + dz) - ON_EDGE - minZ) / CELL), j1 = Math.floor((Math.max(az, az + dz) + ON_EDGE - minZ) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = buckets.get(i * 4096 + j); if (!list) continue;
      for (const id of list) {
        if (id === wa || id === wb) continue;
        const p = first[id] * 3, px = mb.pos[p] - ax, py = mb.pos[p + 1] - ay, pz = mb.pos[p + 2] - az, s = (px * dx + py * dy + pz * dz) / l2;
        if (s <= margin || s >= 1 - margin) continue;
        const ox = px - dx * s, oy = py - dy * s, oz = pz - dz * s; if (ox * ox + oy * oy + oz * oz > ON_EDGE * ON_EDGE) continue;
        (found || (found = [])).push([s, id]);
      }
    }
    if (!found) continue;
    found.sort((p, q) => p[0] - q[0]);
    const key = f * 4294967296 + t; let record = divided.get(key); if (!record) divided.set(key, record = [null, null, null]);
    record[e] = found;
  }

  // ---- divide those triangles
  /** A new vertex at an inserted place, with everything else interpolated between the two ends of its edge. */
  const between = (ia, ib, s, place) => {
    const mix = (array, stride, k) => array[ia * stride + k] + (array[ib * stride + k] - array[ia * stride + k]) * s, p = first[place] * 3;
    mb.material(mb.mat[ia * 4], mb.mat[ia * 4 + 1], mb.mat[ia * 4 + 2], mb.mat[ia * 4 + 3]).color(mix(mb.col, 4, 0) / 255, mix(mb.col, 4, 1) / 255, mix(mb.col, 4, 2) / 255).occlusion(mix(mb.col, 4, 3) / 255);
    return mb.vertex(mb.pos[p], mb.pos[p + 1], mb.pos[p + 2], mix(mb.nrm, 3, 0), mix(mb.nrm, 3, 1), mix(mb.nrm, 3, 2), mix(mb.uv, 2, 0), mix(mb.uv, 2, 1));
  };
  let inserted = 0;
  for (const [key, record] of divided) {
    const f = Math.floor(key / 4294967296), t = key - f * 4294967296, corners = [mb.idx[f][t], mb.idx[f][t + 1], mb.idx[f][t + 2]];
    const ring = [], cornerAt = []; let dividedEdges = 0, lastDivided = -1;
    for (let e = 0; e < 3; e++) {
      cornerAt.push(ring.length); ring.push(corners[e]);
      if (!record[e]) continue;
      dividedEdges++; lastDivided = e;
      for (const [s, place] of record[e]) { ring.push(between(corners[e], corners[(e + 1) % 3], s, place)); inserted++; }
    }
    mb.family(f);
    const fan = [];              // triangles as index triples; the first replaces the original
    if (dividedEdges === 1) {
      // One divided edge: a fan from the opposite corner has no flat triangle in it.
      const apex = corners[(lastDivided + 2) % 3], from = cornerAt[lastDivided], count = record[lastDivided].length + 1;
      for (let i = 0; i < count; i++) fan.push(apex, ring[(from + i) % ring.length], ring[(from + i + 1) % ring.length]);
    } else {
      // Several: a fan around the middle of the triangle uses every point of its outline.
      const [a, b, c] = corners, third = (array, stride, k) => (array[a * stride + k] + array[b * stride + k] + array[c * stride + k]) / 3;
      mb.material(mb.mat[a * 4], mb.mat[a * 4 + 1], mb.mat[a * 4 + 2], mb.mat[a * 4 + 3]).color(third(mb.col, 4, 0) / 255, third(mb.col, 4, 1) / 255, third(mb.col, 4, 2) / 255).occlusion(third(mb.col, 4, 3) / 255);
      const hub = mb.vertex(third(mb.pos, 3, 0), third(mb.pos, 3, 1), third(mb.pos, 3, 2), third(mb.nrm, 3, 0), third(mb.nrm, 3, 1), third(mb.nrm, 3, 2), third(mb.uv, 2, 0), third(mb.uv, 2, 1));
      for (let i = 0; i < ring.length; i++) fan.push(hub, ring[i], ring[(i + 1) % ring.length]);
    }
    const idx = mb.idx[f]; idx[t] = fan[0]; idx[t + 1] = fan[1]; idx[t + 2] = fan[2];
    for (let i = 3; i < fan.length; i += 3) mb.tri(fan[i], fan[i + 1], fan[i + 2]);
  }
  return inserted;
}
