// Fixed tile meshes joined into shared buffers, so that one material group of many tiles is one draw.
//
// Where a family's materials are split into group programs (shaders/surface.js: Direct3D), a tile mesh
// costs a draw call for every group it holds instead of one per family, and a street has hundreds of tile
// meshes in view. The groups cannot be given up there, so the meshes are: those standing in the same square
// of ground are copied into one vertex buffer, and one index list is made of them all in which the
// triangles of each family and group lie together. The G-buffer then draws a group of a whole square with
// one call, and the calls no longer grow with the number of tiles.
//
// A merged vertex keeps its own mesh's coordinates: the shader is handed the offset of every merged mesh
// (TILE_SLOTS of them) and each vertex names its own in the spare fourth component of its normal. So what
// reaches the screen is, number for number, what the mesh drawn by itself would give, and nothing changes
// in the picture when a mesh joins or leaves.
//
// Merging is spread over frames and never waited for. A mesh keeps its own buffers and is drawn from them
// until its copy is in place and the index list of its square has been made again; when a mesh leaves, its
// square goes back to drawing each mesh by itself until its list is remade. Shadows and second views draw
// the meshes one by one as before: fixed geometry is a small part of their calls.

import { FAMILY, VERTEX_STRIDE, VERTEX_LAYOUT } from '../core/ids.js';
import { TILE_SLOTS } from './shaders/surface.js';

/** Edge of a square of ground whose tile meshes are merged, in metres. Culling is by square. */
export const CLUSTER_EDGE = 512;
/**
 * A mesh of fewer vertices that is a single call by itself is left alone: merging it saves nothing, and
 * such meshes (a piece of skid mark) come and go often, each time remaking the list of their square.
 */
export const MERGE_MIN_VERTICES = 512;
/**
 * Work done in one frame: bytes of vertices copied and indices written (one mesh and one square at least).
 * The largest squares hold near a million indices, so the second figure keeps it to one such list a frame.
 */
const PLACE_BYTES = 2 * 1024 * 1024, REBUILD_INDICES = 256 * 1024;
/**
 * A square's vertex buffer grows by a quarter when it is full, and starts no smaller than FIRST_CAPACITY bytes.
 * Every loaded tile mesh is held twice on the graphics card (its own buffer and its square's), so the room
 * kept spare is kept small; growing is a copy on the card and costs little.
 */
const GROWTH = 1.25, FIRST_CAPACITY = 256 * 1024;
/** Byte offset of the fourth component of the normal in a vertex, and its index among 16-bit words. */
const SLOT_WORD = (VERTEX_LAYOUT.normal.offset + 6) / 2, WORDS_PER_VERTEX = VERTEX_STRIDE / 2;

export class TileClusters {
  /**
   * programs: the SurfacePrograms (group counts per family).
   * vertexArrayOf(mesh): a vertex array of the scene's vertex layout over mesh.vbo and mesh.ibo.
   */
  constructor(ctx, programs, vertexArrayOf) {
    this.ctx = ctx; this.programs = programs; this.vertexArrayOf = vertexArrayOf;
    /** Every cluster that holds a mesh. The scene draws those that are `built`. */
    this.list = [];
    this._cells = new Map();              // 'x,z' of a square -> its clusters (a second one when the first is full)
    this._unplaced = [];                  // members whose vertices are not in their cluster's buffer yet, oldest first
    this._stale = [];                     // clusters whose index list is out of date
    this._bytes = new Uint8Array(0); this._words = new Int16Array(0);
    this._indices = new Uint32Array(0);
  }

  /** Whether a fixed object of the street is merged: `mesh` is the scene's record of its mesh. */
  static merges(mesh, lodNear, lodFar) {
    if (!mesh.data || mesh.hasGlass || lodNear !== 0 || lodFar !== Infinity) return false;
    if (mesh.data.vertices.byteLength >= MERGE_MIN_VERTICES * VERTEX_STRIDE) return true;
    let groups = 0;
    for (let family = 0; family < FAMILY.COUNT; family++) for (let bits = mesh.groupBits[family]; bits; bits &= bits - 1) groups++;
    return groups > 1;
  }

  /** item: a static scene item. It is drawn by itself until `item.merged` is set. */
  add(item) {
    const key = Math.floor(item.ox / CLUSTER_EDGE) + ',' + Math.floor(item.oz / CLUSTER_EDGE);
    let cell = this._cells.get(key);
    if (!cell) { cell = []; this._cells.set(key, cell); }
    let cluster = cell.find((c) => c.count < TILE_SLOTS);
    if (!cluster) { cluster = this._create(key); cell.push(cluster); this.list.push(cluster); }
    const slot = cluster.members.indexOf(null);
    cluster.members[slot] = item; cluster.count++; cluster.unplaced++;
    item.cluster = cluster; item.slot = slot; item.vertexStart = -1; item.merged = false;
    this._unplaced.push(item);
  }

  remove(item) {
    const cluster = item.cluster, gl = this.ctx.gl;
    if (item.vertexStart < 0) { this._unplaced.splice(this._unplaced.indexOf(item), 1); cluster.unplaced--; }
    else giveBack(cluster.free, item.vertexStart, item.mesh.data.vertices.byteLength);
    // Its triangles are in the list being drawn: the cluster's meshes are drawn one by one until the list is remade.
    if (item.merged) this._unbuild(cluster);
    cluster.members[item.slot] = null; cluster.count--;
    item.cluster = null; item.merged = false; item.vertexStart = -1;
    if (cluster.count > 0) return;
    if (cluster.mesh.vbo) { gl.deleteVertexArray(cluster.mesh.vao); gl.deleteBuffer(cluster.mesh.vbo); }
    gl.deleteBuffer(cluster.mesh.ibo);
    const cell = this._cells.get(cluster.key);
    cell.splice(cell.indexOf(cluster), 1);
    if (!cell.length) this._cells.delete(cluster.key);
    this.list.splice(this.list.indexOf(cluster), 1);
    if (cluster.stale) this._stale.splice(this._stale.indexOf(cluster), 1);
  }

  /** A frame's share of the merging. Call once a frame, before deciding what is in view. */
  prepare() {
    let bytes = 0, indices = 0;
    while (this._unplaced.length && bytes < PLACE_BYTES) bytes += this._place(this._unplaced.shift());
    for (let i = 0; i < this._stale.length && indices < REBUILD_INDICES; i++) {
      const cluster = this._stale[i];
      // A list is not made twice for meshes that arrive together: it waits until all of them are in place.
      if (cluster.unplaced > 0) continue;
      indices += this._rebuild(cluster);
      this._stale[i] = this._stale[this._stale.length - 1]; this._stale.pop(); i--;
    }
  }

  /**
   * The offsets of a built cluster's meshes from the camera (cam: world position in doubles), for the frame.
   * A slot without a mesh keeps whatever it held: no vertex of the list names it.
   */
  static place(cluster, cam) {
    const offsets = cluster.offsets, members = cluster.members;
    for (let slot = 0; slot < TILE_SLOTS; slot++) {
      const item = members[slot];
      if (!item) continue;
      offsets[slot * 3] = item.ox - cam[0]; offsets[slot * 3 + 1] = item.oy - cam[1]; offsets[slot * 3 + 2] = item.oz - cam[2];
    }
  }

  /** After a lost context: every buffer is gone, every member is merged afresh. */
  restore() {
    this._unplaced.length = 0; this._stale.length = 0;
    for (const cluster of this.list) {
      const mesh = cluster.mesh;
      mesh.vbo = null; mesh.ibo = this.ctx.gl.createBuffer(); mesh.vao = null;
      cluster.capacity = 0; cluster.free.length = 0; cluster.built = false; cluster.unplaced = cluster.count;
      this._markStale(cluster);
      for (const item of cluster.members) if (item) { item.merged = false; item.vertexStart = -1; this._unplaced.push(item); }
    }
  }

  _create(key) {
    const gl = this.ctx.gl, P = this.programs, ranges = [];
    for (let family = 0; family < FAMILY.COUNT; family++) ranges.push(new Int32Array(P.groupCount[family] * 2));
    return {
      key, members: new Array(TILE_SLOTS).fill(null), count: 0, unplaced: 0,
      // What the scene's draw loops read of an item: a mesh (vertex array, index ranges per family and group,
      // the groups held as bits) and, in place of one origin, the offsets of all the meshes merged.
      mesh: { vbo: null, ibo: gl.createBuffer(), vao: null, ranges, groupBits: new Array(FAMILY.COUNT).fill(0) },
      offsets: new Float32Array(TILE_SLOTS * 3),
      minx: 0, miny: 0, minz: 0, maxx: 0, maxy: 0, maxz: 0,
      capacity: 0, free: [],                // bytes of the vertex buffer; its unused stretches as [start, size, ...] in order
      built: false, stale: false,
    };
  }

  _markStale(cluster) {
    if (!cluster.stale) { cluster.stale = true; this._stale.push(cluster); }
  }

  _unbuild(cluster) {
    cluster.built = false;
    for (const item of cluster.members) if (item) item.merged = false;
    this._markStale(cluster);
  }

  /** Copies a member's vertices into its cluster's buffer, each marked with the member's slot. Returns the bytes copied. */
  _place(item) {
    const gl = this.ctx.gl, cluster = item.cluster, source = item.mesh.data.vertices, size = source.byteLength;
    let start = take(cluster.free, size);
    if (start < 0) { this._grow(cluster, size); start = take(cluster.free, size); }
    if (this._bytes.length < size) {
      this._bytes = new Uint8Array(Math.max(size, this._bytes.length * 2));
      this._words = new Int16Array(this._bytes.buffer);
    }
    this._bytes.set(new Uint8Array(source));
    // The words are in the machine's byte order, as the mesh builder's are on every machine the game runs on.
    for (let word = SLOT_WORD, end = size / 2; word < end; word += WORDS_PER_VERTEX) this._words[word] = item.slot;
    gl.bindBuffer(gl.ARRAY_BUFFER, cluster.mesh.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, start, this._bytes, 0, size);
    item.vertexStart = start; cluster.unplaced--;
    this._markStale(cluster);
    return size;
  }

  /** Makes room for `size` more bytes: a larger buffer, the old one copied into it on the graphics card. */
  _grow(cluster, size) {
    const gl = this.ctx.gl, mesh = cluster.mesh, old = cluster.capacity;
    const wanted = Math.max(old + size, Math.ceil(old * GROWTH), FIRST_CAPACITY), capacity = Math.ceil(wanted / VERTEX_STRIDE) * VERTEX_STRIDE;
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, capacity, gl.STATIC_DRAW);
    if (old > 0) {
      gl.bindBuffer(gl.COPY_READ_BUFFER, mesh.vbo);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.ARRAY_BUFFER, 0, 0, old);
      gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    }
    if (mesh.vbo) { gl.deleteBuffer(mesh.vbo); gl.deleteVertexArray(mesh.vao); }
    mesh.vbo = vbo; mesh.vao = this.vertexArrayOf(mesh);
    cluster.capacity = capacity;
    giveBack(cluster.free, old, capacity - old);
  }

  /**
   * Writes the cluster's index list from the members in place: family by family and group by group, each
   * the triangles of every member in turn. Returns the number of indices written.
   */
  _rebuild(cluster) {
    const gl = this.ctx.gl, P = this.programs, members = cluster.members, mesh = cluster.mesh;
    let total = 0;
    for (const item of members) if (item) total += item.mesh.data.indices.length;
    if (this._indices.length < total) this._indices = new Uint32Array(Math.max(total, this._indices.length * 2));
    const out = this._indices;
    let at = 0;
    for (let family = 0; family < FAMILY.COUNT; family++) {
      const ranges = mesh.ranges[family];
      let bits = 0;
      for (let group = 0; group < P.groupCount[family]; group++) {
        const first = at;
        for (let slot = 0; slot < TILE_SLOTS; slot++) {
          const item = members[slot], own = item ? item.mesh.ranges[family] : null;
          if (!own || !own[group * 2 + 1]) continue;
          const source = item.mesh.data.indices, from = own[group * 2] / 4, to = from + own[group * 2 + 1], base = item.vertexStart / VERTEX_STRIDE;
          for (let i = from; i < to; i++) out[at++] = source[i] + base;
        }
        ranges[group * 2] = first * 4; ranges[group * 2 + 1] = at - first;
        if (at > first) bits |= 1 << group;
      }
      mesh.groupBits[family] = bits;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, out.subarray(0, at), gl.STATIC_DRAW);
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (const item of members) {
      if (!item) continue;
      item.merged = true;
      minx = Math.min(minx, item.minx); miny = Math.min(miny, item.miny); minz = Math.min(minz, item.minz);
      maxx = Math.max(maxx, item.maxx); maxy = Math.max(maxy, item.maxy); maxz = Math.max(maxz, item.maxz);
    }
    cluster.minx = minx; cluster.miny = miny; cluster.minz = minz; cluster.maxx = maxx; cluster.maxy = maxy; cluster.maxz = maxz;
    cluster.built = true; cluster.stale = false;
    return at;
  }
}

/** First stretch of `free` ([start, size, ...] in order of start) that holds `size` bytes: its start, taken out; -1 if none. */
function take(free, size) {
  for (let i = 0; i < free.length; i += 2) {
    if (free[i + 1] < size) continue;
    const start = free[i];
    if (free[i + 1] === size) free.splice(i, 2); else { free[i] += size; free[i + 1] -= size; }
    return start;
  }
  return -1;
}

/** Returns a stretch to `free`, joined to the unused stretches it touches. */
function giveBack(free, start, size) {
  let i = 0;
  while (i < free.length && free[i] < start) i += 2;
  free.splice(i, 0, start, size);
  if (i + 2 < free.length && free[i] + free[i + 1] === free[i + 2]) { free[i + 1] += free[i + 3]; free.splice(i + 2, 2); }
  if (i >= 2 && free[i - 2] + free[i - 1] === free[i]) { free[i - 1] += free[i + 1]; free.splice(i, 2); }
}
