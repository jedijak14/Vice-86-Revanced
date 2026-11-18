// Scene storage and geometry drawing: meshes, static tile meshes, instanced batches and dynamic objects;
// frustum and distance culling; and the draw loops of the G-buffer, shadow and glass passes.
//
// Precision: every origin is kept as a JavaScript double. Each frame the camera position is subtracted on
// the CPU and only the small difference is sent to the GPU, so geometry 5 km from the world origin is as
// steady as geometry at the origin.
//
// Nothing here allocates per frame: visibility lists are arrays that are reused and only ever grow.

import { FAMILY, VERTEX_STRIDE, VERTEX_LAYOUT, INSTANCE_STRIDE } from '../core/ids.js';
import { aabbVisible, sphereVisible, batchTouchesLodBand, lodDistance } from './cull.js';
import { casterInCascade, casterCoveredBy } from './shadows.js';
import { ATTRIB } from './shaders/surface.js';
import { sortTrianglesByGroup } from './meshgroups.js';
import { TileClusters } from './tileclusters.js';
import { WORLD_STREET, WORLD_ROOM } from './surfaceprograms.js';

const KIND_STATIC = 0, KIND_INSTANCED = 1, KIND_DYNAMIC = 2;
/** Objects whose bounding sphere covers less than this many pixels are skipped in the main view. */
const MIN_PIXELS = 1.2;
/**
 * A second view taken from inside a vehicle leaves out the object that encloses its eye and every moving
 * object centred this close to it (metres): the car's own wheels, which would otherwise be mirrored in
 * its sills as tyres metres wide.
 */
const OWN_PARTS = 2.2;
/** Casters smaller than this many shadow texels are skipped: they could only flicker. */
const MIN_SHADOW_TEXELS = 2.5;
/** A moving caster's shadow is taken to end this far below its bounding sphere (kerbs, a cambered road), m. */
const GROUND_SLACK = 1;
/**
 * A batch of instances is cut into square cells on the ground, each drawn (and culled, and tested against
 * its distance band) on its own. Instances pick their level of detail in the vertex shader, so a batch as
 * large as a world tile sends every palm of the tile through the pipeline at every level that any palm of
 * it might need, in every shadow cascade and probe face it touches; a cell does that for a handful.
 * The cell is about as wide as the band is deep: [band depth up to (m), cell edge (m)], and no cells beyond.
 */
const BATCH_CELLS = [[64, 32], [256, 64]];
/**
 * Levels of detail in passes that need less of them than the main view: [bias, most metres]. A distance d
 * counts as d + min(d * bias, most), so the close-up meshes give way sooner and nothing vanishes more than
 * `most` metres early. A shadow needs the outline of a palm, not its leaflets; the probe and the mirror
 * draw the street at a fraction of the frame's resolution.
 */
export const SHADOW_LOD = [1, 40], PROBE_LOD = [2, 100], MIRROR_LOD = [1, 60];

function determinant3(m) {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

export class Scene {
  /**
   * programs: the SurfacePrograms (surfaceprograms.js): which material group each material id of a family
   * belongs to, and the tables of programs to draw each group with, which fill in as programs are built.
   * mergeTiles: fixed tile meshes of the street are merged by square of ground (tileclusters.js); the
   * 'static' programs must then have been made with tile slots (shaders/surface.js).
   */
  constructor(ctx, programs, mergeTiles = false) {
    this.ctx = ctx; this.programs = programs;
    this.clusters = mergeTiles ? new TileClusters(ctx, programs, (mesh) => this._vertexArray(mesh, null)) : null;
    this._nothing = null;                 // the mesh behind drawNothing()
    this.meshes = [null];                 // handle 0 is never valid
    this.freeMeshes = [];
    this.items = new Map();               // id -> static or instanced item
    this.statics = []; this.batches = []; this.dynamics = [];
    this.nextId = 1;
    this.visible = [[], [], []]; this.visibleCount = [0, 0, 0];
    this.casters = [[], [], []]; this.casterCount = [0, 0, 0];
    this.second = [[], [], []]; this.secondCount = [0, 0, 0]; this.mirrored = false;     // lists of a second view (road mirror, probe face)
    this.glass = []; this.glassCount = 0;
    this._offset = new Float32Array(3); this._model = new Float32Array(16); this._prevModel = new Float32Array(16);
    this._cam = new Float64Array(3);
    this._lod = [0, 0];                   // level-of-detail bias of the pass being drawn (see SHADOW_LOD)
    this._secondLod = [0, 0];
    // Which of the two worlds this frame shows: the street (false) or a closed room (true). Every object
    // belongs to one of them (its `interior` flag) and is invisible to every view of the other, so a room
    // can stand anywhere in the loaded city without either being drawn, shadowed or mirrored in the other.
    this.interior = false;
    this.drawCalls = 0; this.triangles = 0;
    /** Fixed objects in the main view, each merged tile mesh counted for itself. */
    this.staticsInView = 0;
  }

  // ------------------------------------------------------------------------------------------ meshes
  /** first: index of the first instance record this vertex array draws. */
  _vertexArray(mesh, instanceBuffer, first = 0) {
    const gl = this.ctx.gl, vao = gl.createVertexArray(), L = VERTEX_LAYOUT;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo);
    gl.enableVertexAttribArray(ATTRIB.position); gl.vertexAttribPointer(ATTRIB.position, 3, gl.FLOAT, false, VERTEX_STRIDE, L.position.offset);
    gl.enableVertexAttribArray(ATTRIB.normal); gl.vertexAttribPointer(ATTRIB.normal, 4, gl.SHORT, true, VERTEX_STRIDE, L.normal.offset);
    gl.enableVertexAttribArray(ATTRIB.color); gl.vertexAttribPointer(ATTRIB.color, 4, gl.UNSIGNED_BYTE, true, VERTEX_STRIDE, L.color.offset);
    gl.enableVertexAttribArray(ATTRIB.material); gl.vertexAttribPointer(ATTRIB.material, 4, gl.UNSIGNED_BYTE, false, VERTEX_STRIDE, L.material.offset);
    gl.enableVertexAttribArray(ATTRIB.uv); gl.vertexAttribPointer(ATTRIB.uv, 2, gl.FLOAT, false, VERTEX_STRIDE, L.uv.offset);
    if (instanceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      const bytes = INSTANCE_STRIDE * 4, start = first * bytes;
      gl.enableVertexAttribArray(ATTRIB.instancePosYaw); gl.vertexAttribPointer(ATTRIB.instancePosYaw, 4, gl.FLOAT, false, bytes, start); gl.vertexAttribDivisor(ATTRIB.instancePosYaw, 1);
      gl.enableVertexAttribArray(ATTRIB.instanceParams); gl.vertexAttribPointer(ATTRIB.instanceParams, 4, gl.FLOAT, false, bytes, start + 16); gl.vertexAttribDivisor(ATTRIB.instanceParams, 1);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo);
    gl.bindVertexArray(null);
    return vao;
  }

  _upload(mesh) {
    const gl = this.ctx.gl;
    mesh.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh.data.vertices, gl.STATIC_DRAW);
    mesh.ibo = gl.createBuffer(); gl.bindVertexArray(null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.data.indices, gl.STATIC_DRAW);
    mesh.vao = this._vertexArray(mesh, null);
  }

  /**
   * data: MeshData. The CPU copy is kept (it is needed to rebuild after a lost context) unless
   * `retain: false` is passed, in which case the mesh simply disappears if the context is ever lost.
   * `data.indices` is reordered in place: within each of `data.groups` the triangles end up sorted by
   * material group (the same triangles, each with its vertices in the same order).
   */
  createMesh(data, { retain = true } = {}) {
    if (!data || !(data.vertices instanceof ArrayBuffer) || !(data.indices instanceof Uint32Array) || !Array.isArray(data.groups)) {
      throw new Error('createMesh: expected MeshData { vertices: ArrayBuffer, indices: Uint32Array, groups, bounds } from MeshBuilder.finish().');
    }
    const b = data.bounds || [0, 0, 0, 0, 0, 0];
    const mesh = {
      data, retain, vbo: null, ibo: null, vao: null,
      bounds: Float64Array.from(b),
      centre: new Float32Array([(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]),
      radius: 0.5 * Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]),
      // Per family: the index range of each of its material groups, [start (bytes), count] per group, or null;
      // and the groups it holds as bits. The triangles of a family are put in group order here, once.
      ranges: new Array(FAMILY.COUNT).fill(null),
      groupBits: new Array(FAMILY.COUNT).fill(0),
      spans: new Int32Array(FAMILY.COUNT * 2),         // per family: [start (bytes), count] of all its groups together
      shadowRuns: [],                                  // merged index ranges per depth-only program
      hasGlass: false,
    };
    const P = this.programs, vertexBytes = new Uint8Array(data.vertices);
    for (const g of data.groups) {
      if (!(g.family >= 0 && g.family < FAMILY.COUNT) || !g.count) continue;
      const groups = P.groupCount[g.family], ranges = new Int32Array(groups * 2), classes = P.shadowClass[g.family];
      mesh.groupBits[g.family] = sortTrianglesByGroup(data.indices, g.start, g.count, vertexBytes, P.groupOf[g.family], groups, ranges);
      mesh.ranges[g.family] = ranges; mesh.spans[g.family * 2] = g.start * 4; mesh.spans[g.family * 2 + 1] = g.count;
      for (let group = 0; group < groups; group++) ranges[group * 2] *= 4;
      if (g.family === FAMILY.GLASS) { mesh.hasGlass = true; continue; }
      for (let group = 0; group < groups; group++) {
        const start = ranges[group * 2], count = ranges[group * 2 + 1], cls = classes[group], last = mesh.shadowRuns[mesh.shadowRuns.length - 1];
        if (!count || cls < 0) continue;
        // Groups and families that share a depth-only program and sit next to each other in the index buffer are drawn in one call.
        if (last && last.cls === cls && last.start + last.count * 4 === start) last.count += count;
        else mesh.shadowRuns.push({ cls, start, count });
      }
    }
    this._upload(mesh);
    if (!retain) mesh.data = null;
    const handle = this.freeMeshes.length ? this.freeMeshes.pop() : this.meshes.length;
    this.meshes[handle] = mesh;
    return handle;
  }

  destroyMesh(handle) {
    const mesh = this.meshes[handle], gl = this.ctx.gl;
    if (!mesh) return;
    gl.deleteVertexArray(mesh.vao); gl.deleteBuffer(mesh.vbo); gl.deleteBuffer(mesh.ibo);
    this.meshes[handle] = null; this.freeMeshes.push(handle);
  }

  _mesh(handle, caller) {
    const mesh = this.meshes[handle];
    if (!mesh) throw new Error(`${caller}: unknown mesh handle ${handle} (was it destroyed?).`);
    return mesh;
  }

  /** Ask for the programs an object of this mesh, drawn as `kind` in `world`, will be drawn with. */
  _wantPrograms(mesh, kind, world) {
    const P = this.programs;
    for (let family = 0; family < FAMILY.COUNT; family++) {
      const bits = mesh.groupBits[family];
      for (let group = 0; bits >>> group !== 0; group++) if (bits & (1 << group)) P.want(family, kind, group, world);
    }
  }

  /**
   * One triangle of no area, in the vertex layout and with the draw call of `kind`, with the current
   * program into the bound target: the first draw of a program (surfaceprograms.js), which shows nothing.
   */
  drawNothing(kind) {
    const gl = this.ctx.gl;
    if (!this._nothing) {
      const mesh = { data: { vertices: new ArrayBuffer(3 * VERTEX_STRIDE), indices: new Uint32Array([0, 1, 2]) }, vbo: null, ibo: null, vao: null };
      this._upload(mesh);
      const instance = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, instance); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(INSTANCE_STRIDE), gl.STATIC_DRAW);
      this._nothing = { mesh, instance, instancedVao: this._vertexArray(mesh, instance) };
    }
    if (kind === KIND_INSTANCED) { gl.bindVertexArray(this._nothing.instancedVao); gl.drawElementsInstanced(gl.TRIANGLES, 3, gl.UNSIGNED_INT, 0, 1); }
    else { gl.bindVertexArray(this._nothing.mesh.vao); gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_INT, 0); }
    gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------------------------------ objects
  addStatic({ mesh, origin = [0, 0, 0], castShadow = true, lodNear = 0, lodFar = Infinity, interior = false }) {
    const m = this._mesh(mesh, 'addStatic'), b = m.bounds, id = this.nextId++;
    const item = {
      id, kind: KIND_STATIC, mesh: m, castShadow, lodNear, lodFar, sortKey: 0, interior: !!interior,
      // Where tile meshes are merged: its cluster and slot there, where its vertices start in the cluster's
      // buffer (-1 = not copied yet), and whether the cluster draws it. `offsets` is what a cluster has instead of an origin.
      cluster: null, slot: -1, vertexStart: -1, merged: false, offsets: null,
      ox: origin[0], oy: origin[1], oz: origin[2],
      minx: origin[0] + b[0], miny: origin[1] + b[1], minz: origin[2] + b[2], maxx: origin[0] + b[3], maxy: origin[1] + b[4], maxz: origin[2] + b[5],
      cx: origin[0] + m.centre[0], cy: origin[1] + m.centre[1], cz: origin[2] + m.centre[2], radius: m.radius,
    };
    this.items.set(id, item); this.statics.push(item);
    this._wantPrograms(m, KIND_STATIC, interior ? WORLD_ROOM : WORLD_STREET);
    if (this.clusters && !interior && TileClusters.merges(m, lodNear, lodFar)) this.clusters.add(item);
    return id;
  }

  _uploadInstances(item) {
    const gl = this.ctx.gl;
    item.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, item.buffer); gl.bufferData(gl.ARRAY_BUFFER, item.records, gl.STATIC_DRAW);
    for (const part of item.parts) part.vao = this._vertexArray(item.mesh, item.buffer, part.first);
  }

  /** instances: world-space records (INSTANCE_STRIDE floats each). They are copied; the caller may reuse the array. */
  addInstances({ mesh, instances, count, castShadow = true, lodNear = 0, lodFar = Infinity, interior = false }) {
    const m = this._mesh(mesh, 'addInstances'), id = this.nextId++;
    if (!(count > 0) || !instances || instances.length < count * INSTANCE_STRIDE) throw new Error('addInstances: `instances` must hold `count` records of 8 floats.');
    // Order the instances by ground cell, so that each cell is one run of the buffer.
    const depth = lodFar - lodNear, rule = BATCH_CELLS.find((r) => depth <= r[0]), edge = rule ? rule[1] : 0;
    const order = new Uint32Array(count), cellOf = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      order[i] = i;
      if (edge) cellOf[i] = Math.floor(instances[i * INSTANCE_STRIDE] / edge) * 4194304 + Math.floor(instances[i * INSTANCE_STRIDE + 2] / edge);
    }
    if (edge) order.sort((a, b) => cellOf[a] - cellOf[b] || a - b);
    // Re-base the records to the first instance so the GPU never sees kilometre-sized coordinates.
    const ox = instances[0], oy = instances[1], oz = instances[2], records = new Float32Array(count * INSTANCE_STRIDE);
    const item = { id, kind: KIND_INSTANCED, mesh: m, records, buffer: null, parts: [] };
    const reachOfOne = Math.hypot(m.centre[0], m.centre[1], m.centre[2]) + m.radius;
    let part = null;
    for (let n = 0; n < count; n++) {
      const i = order[n], from = i * INSTANCE_STRIDE, o = n * INSTANCE_STRIDE, x = instances[from], y = instances[from + 1], z = instances[from + 2];
      records[o] = x - ox; records[o + 1] = y - oy; records[o + 2] = z - oz;
      for (let k = 3; k < INSTANCE_STRIDE; k++) records[o + k] = instances[from + k];
      if (!part || cellOf[i] !== part.cell) {
        part = {
          kind: KIND_INSTANCED, mesh: m, castShadow, lodNear, lodFar, sortKey: 0, first: n, count: 0, vao: null, cell: cellOf[i], slot: -1, interior: !!interior,
          ox, oy, oz, minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity, cx: 0, cy: 0, cz: 0, radius: 0,
        };
        item.parts.push(part);
      }
      // Yaw is free, so each instance is bounded by a sphere about its own origin.
      const reach = reachOfOne * instances[from + 4];
      part.count++;
      part.minx = Math.min(part.minx, x - reach); part.miny = Math.min(part.miny, y - reach); part.minz = Math.min(part.minz, z - reach);
      part.maxx = Math.max(part.maxx, x + reach); part.maxy = Math.max(part.maxy, y + reach); part.maxz = Math.max(part.maxz, z + reach);
    }
    for (const q of item.parts) {
      q.cx = (q.minx + q.maxx) / 2; q.cy = (q.miny + q.maxy) / 2; q.cz = (q.minz + q.maxz) / 2;
      q.radius = 0.5 * Math.hypot(q.maxx - q.minx, q.maxy - q.miny, q.maxz - q.minz);
      q.slot = this.batches.length; this.batches.push(q);
    }
    this._uploadInstances(item);
    this.items.set(id, item);
    this._wantPrograms(m, KIND_INSTANCED, interior ? WORLD_ROOM : WORLD_STREET);
    return id;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    if (item.kind === KIND_STATIC) {
      const i = this.statics.indexOf(item);
      if (i >= 0) { this.statics[i] = this.statics[this.statics.length - 1]; this.statics.pop(); }
      if (item.cluster) this.clusters.remove(item);
      return;
    }
    const gl = this.ctx.gl, batches = this.batches;
    for (const part of item.parts) {
      const last = batches.pop();
      if (last !== part) { batches[part.slot] = last; last.slot = part.slot; }
      gl.deleteVertexArray(part.vao);
    }
    gl.deleteBuffer(item.buffer);
  }

  addDynamic({ mesh, castShadow = true, interior = false, fixture = false }) {
    const m = this._mesh(mesh, 'addDynamic'), scene = this;
    const obj = {
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), objA: new Float32Array(4), objB: new Float32Array(4),
      visible: true, castShadow,
      /** True while the object stands in a closed room (the garage): writable, a car changes worlds by it. */
      interior: !!interior,
      /**
       * True for a moving part of the surroundings (a turntable, a roller door) as opposed to a vehicle: it
       * stays in the reflection probe even when the probe is captured from inside its bounds.
       */
      fixture: !!fixture,
      /** Set to true for one frame after moving the object discontinuously: it then leaves no motion trail. */
      teleported: true,
      remove() { const i = scene.dynamics.indexOf(obj); if (i >= 0) { scene.dynamics[i] = scene.dynamics[scene.dynamics.length - 1]; scene.dynamics.pop(); } },
      // ---- renderer-private
      kind: KIND_DYNAMIC, mesh: m, sortKey: 0, flipped: false, drawnLastFrame: false,
      previous: new Float32Array(16),          // world matrix of the previous frame
    };
    this.dynamics.push(obj);
    // A moving object can change worlds (`interior` is writable): its programs are asked for in both.
    this._wantPrograms(m, KIND_DYNAMIC, WORLD_STREET); this._wantPrograms(m, KIND_DYNAMIC, WORLD_ROOM);
    return obj;
  }

  // ------------------------------------------------------------------------------------------ culling
  _show(kind, item) {
    this.visible[kind][this.visibleCount[kind]++] = item;
    if (item.mesh.hasGlass) this.glass[this.glassCount++] = item;
  }

  /**
   * Decide what the camera sees. cam: world position (doubles); planes: camera-relative frustum planes;
   * pixelsPerRadian: frame height / fovY, for the small-object test.
   */
  cull(cam, planes, pixelsPerRadian) {
    const c = this._cam; c[0] = cam[0]; c[1] = cam[1]; c[2] = cam[2];
    const n = this.visibleCount; n[0] = n[1] = n[2] = 0; this.glassCount = 0;
    const clusters = this.clusters;
    if (clusters) clusters.prepare();
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i], dist = Math.hypot(s.cx - c[0], s.cy - c[1], s.cz - c[2]);
      if (s.interior !== this.interior) continue;
      s.sortKey = dist;
      if (s.merged) continue;                        // drawn with its cluster, below
      if (dist < s.lodNear || dist >= s.lodFar || s.radius * pixelsPerRadian < MIN_PIXELS * dist) continue;
      if (aabbVisible(planes, s.minx - c[0], s.miny - c[1], s.minz - c[2], s.maxx - c[0], s.maxy - c[1], s.maxz - c[2])) this._show(KIND_STATIC, s);
    }
    this.staticsInView = n[KIND_STATIC];
    // Merged tile meshes belong to the street and are seen or not by the cluster.
    if (clusters && !this.interior) {
      for (let i = 0; i < clusters.list.length; i++) {
        const g = clusters.list[i];
        if (!g.built || !aabbVisible(planes, g.minx - c[0], g.miny - c[1], g.minz - c[2], g.maxx - c[0], g.maxy - c[1], g.maxz - c[2])) continue;
        TileClusters.place(g, c);
        this.visible[KIND_STATIC][n[KIND_STATIC]++] = g; this.staticsInView += g.count;
      }
    }
    for (let i = 0; i < this.batches.length; i++) {
      const s = this.batches[i], dist = Math.hypot(s.cx - c[0], s.cy - c[1], s.cz - c[2]);
      if (s.interior !== this.interior) continue;
      s.sortKey = dist;
      if (!batchTouchesLodBand(dist, s.radius, s.lodNear, s.lodFar)) continue;
      if (aabbVisible(planes, s.minx - c[0], s.miny - c[1], s.minz - c[2], s.maxx - c[0], s.maxy - c[1], s.maxz - c[2])) this._show(KIND_INSTANCED, s);
    }
    for (let i = 0; i < this.dynamics.length; i++) {
      const d = this.dynamics[i], m = d.matrix, mc = d.mesh.centre;
      // An object of the other world is not drawn, and has no previous position when it comes back.
      if (d.interior !== this.interior) { d.inView = false; continue; }
      // World position of the bounds centre and the largest axis scale.
      d.cx = m[0] * mc[0] + m[4] * mc[1] + m[8] * mc[2] + m[12]; d.cy = m[1] * mc[0] + m[5] * mc[1] + m[9] * mc[2] + m[13]; d.cz = m[2] * mc[0] + m[6] * mc[1] + m[10] * mc[2] + m[14];
      d.radius = d.mesh.radius * Math.sqrt(Math.max(m[0] * m[0] + m[1] * m[1] + m[2] * m[2], m[4] * m[4] + m[5] * m[5] + m[6] * m[6], m[8] * m[8] + m[9] * m[9] + m[10] * m[10]));
      d.flipped = determinant3(m) < 0;
      const x = d.cx - c[0], y = d.cy - c[1], z = d.cz - c[2];
      d.sortKey = Math.hypot(x, y, z);
      const drawn = d.visible && d.radius * pixelsPerRadian >= MIN_PIXELS * d.sortKey && sphereVisible(planes, x, y, z, d.radius);
      // An object that was not drawn last frame has no meaningful previous position.
      if (d.teleported || !d.drawnLastFrame) d.previous.set(m);
      d.teleported = false; d.inView = drawn;
      if (drawn) this._show(KIND_DYNAMIC, d);
    }
    // Glass is blended, so it is drawn far to near.
    const glass = this.glass;
    for (let i = 1; i < this.glassCount; i++) {
      const item = glass[i]; let j = i - 1;
      while (j >= 0 && glass[j].sortKey < item.sortKey) { glass[j + 1] = glass[j]; j--; }
      glass[j + 1] = item;
    }
  }

  /**
   * Decide what a second view sees (after cull(), whose distances from the main camera it reuses for the
   * levels of detail): the road mirror or one face of the reflection probe.
   * planes: frustum of that view, relative to the main camera; reach: how far from the main camera it
   * draws, in metres; floorY: objects wholly below this world height are skipped; skip: world position
   * (or null) whose enclosing dynamic object is left out, so that a car is not in its own probe (objects
   * added as `fixture` stay);
   * lod: [bias, most metres] by which this view prefers coarser levels of detail (see SHADOW_LOD).
   */
  cullView(planes, pixelsPerRadian, reach, floorY, skip, lod) {
    const c = this._cam, n = this.secondCount, lists = this.second; n[0] = n[1] = n[2] = 0;
    const bias = lod[0], most = lod[1]; this._secondLod[0] = bias; this._secondLod[1] = most;
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i], dist = s.sortKey, level = lodDistance(dist, bias, most);
      if (s.interior !== this.interior) continue;
      if (level < s.lodNear || level >= s.lodFar || dist - s.radius > reach || s.maxy <= floorY || s.radius * pixelsPerRadian < MIN_PIXELS * dist) continue;
      if (aabbVisible(planes, s.minx - c[0], s.miny - c[1], s.minz - c[2], s.maxx - c[0], s.maxy - c[1], s.maxz - c[2])) lists[KIND_STATIC][n[KIND_STATIC]++] = s;
    }
    for (let i = 0; i < this.batches.length; i++) {
      const s = this.batches[i];
      if (s.interior !== this.interior) continue;
      if (s.sortKey - s.radius > reach || s.maxy <= floorY || !batchTouchesLodBand(s.sortKey, s.radius, s.lodNear, s.lodFar, bias, most)) continue;
      if (aabbVisible(planes, s.minx - c[0], s.miny - c[1], s.minz - c[2], s.maxx - c[0], s.maxy - c[1], s.maxz - c[2])) lists[KIND_INSTANCED][n[KIND_INSTANCED]++] = s;
    }
    for (let i = 0; i < this.dynamics.length; i++) {
      const d = this.dynamics[i];
      if (d.interior !== this.interior) continue;
      if (!d.visible || d.sortKey - d.radius > reach || d.cy + d.radius <= floorY || d.radius * pixelsPerRadian < MIN_PIXELS * d.sortKey) continue;
      if (skip && !d.fixture && Math.hypot(d.cx - skip[0], d.cy - skip[1], d.cz - skip[2]) < Math.max(d.radius, OWN_PARTS)) continue;
      if (sphereVisible(planes, d.cx - c[0], d.cy - c[1], d.cz - c[2], d.radius)) lists[KIND_DYNAMIC][n[KIND_DYNAMIC]++] = d;
    }
  }

  /** Remember this frame's matrices for next frame's motion vectors. Call once after drawing. */
  endFrame() {
    for (let i = 0; i < this.dynamics.length; i++) { const d = this.dynamics[i]; d.previous.set(d.matrix); d.drawnLastFrame = d.inView; }
    for (let k = 0; k < 3; k++) {
      const list = this.visible[k], second = this.second[k];
      for (let i = this.visibleCount[k]; i < list.length; i++) list[i] = null;
      for (let i = this.secondCount[k]; i < second.length; i++) second[i] = null;
      this.secondCount[k] = 0;
    }
  }

  /**
   * Collect the shadow casters of one cascade (uses the camera from the last cull). inner: the cascade one
   * step closer to the camera, or null; a moving object that it covers completely is left out of this one
   * (the player's car is half the triangles of a street and would otherwise be drawn into every cascade).
   * margin: metres the object or the camera may travel before both cascades have been drawn again.
   */
  cullCasters(cascade, inner, margin) {
    const casters = this.casters, n = this.casterCount; n[0] = n[1] = n[2] = 0;
    const bias = SHADOW_LOD[0], most = SHADOW_LOD[1];
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i], level = lodDistance(s.sortKey, bias, most);
      if (s.interior !== this.interior) continue;
      if (!s.castShadow || level < s.lodNear || level >= s.lodFar || !s.mesh.shadowRuns.length) continue;
      if (casterInCascade(cascade, s.cx, s.cy, s.cz, s.radius, MIN_SHADOW_TEXELS)) casters[0][n[0]++] = s;
    }
    for (let i = 0; i < this.batches.length; i++) {
      const s = this.batches[i];
      if (s.interior !== this.interior) continue;
      if (!s.castShadow || !s.mesh.shadowRuns.length || !batchTouchesLodBand(s.sortKey, s.radius, s.lodNear, s.lodFar, bias, most)) continue;
      // The batch as a whole is large; what matters for the size test is one instance.
      if (s.mesh.radius * 2 < cascade.texel * MIN_SHADOW_TEXELS) continue;
      if (casterInCascade(cascade, s.cx, s.cy, s.cz, s.radius, 0)) casters[1][n[1]++] = s;
    }
    for (let i = 0; i < this.dynamics.length; i++) {
      const d = this.dynamics[i];
      if (d.interior !== this.interior) continue;
      if (!d.visible || !d.castShadow || !d.mesh.shadowRuns.length) continue;
      if (!casterInCascade(cascade, d.cx, d.cy, d.cz, d.radius, MIN_SHADOW_TEXELS)) continue;
      // A moving object stands on the ground: its shadow ends where the light has dropped by its own height.
      if (inner && casterCoveredBy(inner, d.cx, d.cy, d.cz, d.radius, (2 * d.radius + GROUND_SLACK) / inner.basis[7], margin)) continue;
      casters[2][n[2]++] = d;
    }
  }

  // ------------------------------------------------------------------------------------------ drawing
  _setOffset(program, item) {
    const o = this._offset, c = this._cam;
    o[0] = item.ox - c[0]; o[1] = item.oy - c[1]; o[2] = item.oz - c[2];
    this.ctx.gl.uniform3fv(program.loc('uOffset'), o);
  }

  _setModel(program, d, withPrevious) {
    const gl = this.ctx.gl, c = this._cam, m = this._model;
    m.set(d.matrix); m[12] = d.matrix[12] - c[0]; m[13] = d.matrix[13] - c[1]; m[14] = d.matrix[14] - c[2];
    gl.uniformMatrix4fv(program.loc('uModel'), false, m);
    if (withPrevious) {
      const p = this._prevModel;
      p.set(d.previous); p[12] = d.previous[12] - c[0]; p[13] = d.previous[13] - c[1]; p[14] = d.previous[14] - c[2];
      gl.uniformMatrix4fv(program.loc('uPrevModel'), false, p);
      gl.uniform4fv(program.loc('uObjA'), d.objA); gl.uniform4fv(program.loc('uObjB'), d.objB);
    }
  }

  _draw(kind, item, program, start, count, withPrevious) {
    const gl = this.ctx.gl, mesh = item.mesh;
    if (kind === KIND_STATIC) {
      // A cluster of merged tile meshes hands over the offset of each; anything else has the one.
      if (item.offsets) gl.uniform3fv(program.loc('uOffset'), item.offsets); else this._setOffset(program, item);
      gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start);
      this.triangles += count / 3;
    } else if (kind === KIND_INSTANCED) {
      this._setOffset(program, item);
      gl.uniform4f(program.loc('uLod'), item.lodNear, Math.min(item.lodFar, 1e9), this._lod[0], this._lod[1]);
      gl.uniform3fv(program.loc('uLodCentre'), mesh.centre);
      gl.bindVertexArray(item.vao); gl.drawElementsInstanced(gl.TRIANGLES, count, gl.UNSIGNED_INT, start, item.count);
      this.triangles += (count / 3) * item.count;
    } else {
      this._setModel(program, item, withPrevious);
      // A mirrored matrix reverses the winding (and the mirror pass has already reversed it once).
      if (item.flipped) gl.frontFace(this.mirrored ? gl.CCW : gl.CW);
      gl.bindVertexArray(mesh.vao); gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, start);
      if (item.flipped) gl.frontFace(this.mirrored ? gl.CW : gl.CCW);
      this.triangles += count / 3;
    }
    this.drawCalls++;
  }

  /** The material groups of `family` that the first n items of a list hold, as bits. */
  _groupsIn(list, n, family) {
    let bits = 0;
    for (let i = 0; i < n; i++) bits |= list[i].mesh.groupBits[family];
    return bits;
  }

  /** Opaque geometry into the G-buffer: program by program, so state changes stay few. */
  drawGBuffer() {
    const gl = this.ctx.gl, P = this.programs;
    this._lod[0] = 0; this._lod[1] = 0;
    for (let family = 0; family < FAMILY.COUNT; family++) {
      if (family === FAMILY.GLASS) continue;
      if (P.twoSided[family]) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      for (let kind = 0; kind < 3; kind++) {
        const list = this.visible[kind], n = this.visibleCount[kind], programs = P.gbuffer[family][kind], present = this._groupsIn(list, n, family);
        for (let group = 0; present >>> group !== 0; group++) {
          const bit = 1 << group, program = programs[group];
          if (!(present & bit) || !program || !program.use()) continue;
          for (let i = 0; i < n; i++) {
            const item = list[i], mesh = item.mesh;
            if (mesh.groupBits[family] & bit) this._draw(kind, item, program, mesh.ranges[family][group * 2], mesh.ranges[family][group * 2 + 1], true);
          }
        }
      }
    }
    gl.enable(gl.CULL_FACE); gl.bindVertexArray(null);
  }

  /** Makes a second view's program current with that view's uniforms; false when there is none to draw with yet. */
  _useForView(program, matrix, eyeX, eyeY, eyeZ, mirrored, clipHeight, distanceInAlpha) {
    if (!program || !program.use()) return false;
    const gl = this.ctx.gl;
    gl.uniformMatrix4fv(program.loc('uAltViewProj'), false, matrix);
    gl.uniform4f(program.loc('uAltEye'), eyeX, eyeY, eyeZ, mirrored ? 1 : 0); gl.uniform4f(program.loc('uAltClip'), clipHeight, distanceInAlpha ? 1 : 0, 0, 0);
    return true;
  }

  /**
   * The scene as a second view sees it (after cullView), lit forward, glass included as opaque panes.
   * matrix: camera-relative world -> clip of that view; eye: its eye relative to the main camera;
   * mirrored: the view is a mirror image (every triangle's winding is reversed); clipHeight: camera-relative
   * height below which nothing is drawn; distanceInAlpha: alpha receives 1 / distance from the eye instead
   * of coverage (probe faces). The caller has bound the target and set depth state.
   */
  drawView(matrix, eyeX, eyeY, eyeZ, mirrored, clipHeight, distanceInAlpha = false) {
    const gl = this.ctx.gl, P = this.programs;
    gl.frontFace(mirrored ? gl.CW : gl.CCW); this.mirrored = mirrored;
    this._lod[0] = this._secondLod[0]; this._lod[1] = this._secondLod[1];
    for (let family = 0; family < FAMILY.COUNT; family++) {
      if (P.twoSided[family]) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
      for (let kind = 0; kind < 3; kind++) {
        const list = this.second[kind], n = this.secondCount[kind], programs = P.view[family][kind], present = this._groupsIn(list, n, family);
        if (!present) continue;
        // A split family is drawn whole, one call an object, once the program of all its materials is there.
        const whole = P.viewWhole[family][kind];
        if (this._useForView(whole, matrix, eyeX, eyeY, eyeZ, mirrored, clipHeight, distanceInAlpha)) {
          for (let i = 0; i < n; i++) {
            const item = list[i], mesh = item.mesh;
            if (mesh.groupBits[family]) this._draw(kind, item, whole, mesh.spans[family * 2], mesh.spans[family * 2 + 1], true);
          }
          continue;
        }
        for (let group = 0; present >>> group !== 0; group++) {
          const bit = 1 << group, program = programs[group];
          if (!(present & bit) || !this._useForView(program, matrix, eyeX, eyeY, eyeZ, mirrored, clipHeight, distanceInAlpha)) continue;
          for (let i = 0; i < n; i++) {
            const item = list[i], mesh = item.mesh;
            if (mesh.groupBits[family] & bit) this._draw(kind, item, program, mesh.ranges[family][group * 2], mesh.ranges[family][group * 2 + 1], true);
          }
        }
      }
    }
    gl.frontFace(gl.CCW); this.mirrored = false;
    gl.enable(gl.CULL_FACE); gl.bindVertexArray(null);
  }

  /**
   * Collect what stands over the ground inside a world rectangle, for the rain cover map (raincover.js):
   * fixed geometry that casts a shadow, at the levels of detail the shadow pass uses. Nothing that moves.
   */
  cullCover(minX, minZ, maxX, maxZ) {
    const casters = this.casters, n = this.casterCount; n[0] = n[1] = n[2] = 0;
    const bias = SHADOW_LOD[0], most = SHADOW_LOD[1];
    for (let i = 0; i < this.statics.length; i++) {
      const s = this.statics[i], level = lodDistance(s.sortKey, bias, most);
      if (s.interior !== this.interior) continue;
      if (!s.castShadow || level < s.lodNear || level >= s.lodFar || !s.mesh.shadowRuns.length) continue;
      if (s.maxx > minX && s.minx < maxX && s.maxz > minZ && s.minz < maxZ) casters[0][n[0]++] = s;
    }
    for (let i = 0; i < this.batches.length; i++) {
      const s = this.batches[i];
      if (s.interior !== this.interior) continue;
      if (!s.castShadow || !s.mesh.shadowRuns.length || !batchTouchesLodBand(s.sortKey, s.radius, s.lodNear, s.lodFar, bias, most)) continue;
      if (s.maxx > minX && s.minx < maxX && s.maxz > minZ && s.minz < maxZ) casters[1][n[1]++] = s;
    }
  }

  /**
   * Depth of the current casters (after cullCasters or cullCover) into the bound depth target.
   * matrix: camera-relative world -> clip of that target; skipFamily: a family left out (-1 = none). Runs
   * are merged per depth-only program, so a family is left out only where it has a program of its own.
   */
  drawShadow(matrix, skipFamily = -1) {
    const gl = this.ctx.gl, P = this.programs;
    this._lod[0] = SHADOW_LOD[0]; this._lod[1] = SHADOW_LOD[1];
    for (let cls = 0; cls < P.shadow.length; cls++) {
      if (skipFamily >= 0 && P.shadowOwner[cls] === skipFamily) continue;
      for (let kind = 0; kind < 3; kind++) {
        const list = this.casters[kind], n = this.casterCount[kind], program = P.shadow[cls][kind];
        if (!program) continue;
        let bound = false;
        for (let i = 0; i < n; i++) {
          const item = list[i], runs = item.mesh.shadowRuns;
          for (let r = 0; r < runs.length; r++) {
            if (runs[r].cls !== cls) continue;
            if (!bound) { if (!program.use()) break; gl.uniformMatrix4fv(program.loc('uShadowViewProj'), false, matrix); bound = true; }
            this._draw(kind, item, program, runs[r].start, runs[r].count, false);
          }
        }
      }
    }
    gl.bindVertexArray(null);
  }

  /** Glass, far to near. The caller has set blending and depth state. */
  drawForward() {
    const gl = this.ctx.gl, P = this.programs;
    if (!this.glassCount) return;
    this._lod[0] = 0; this._lod[1] = 0;
    if (P.twoSided[FAMILY.GLASS]) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
    let current = null;
    for (let i = 0; i < this.glassCount; i++) {
      const item = this.glass[i], bits = item.mesh.groupBits[FAMILY.GLASS], ranges = item.mesh.ranges[FAMILY.GLASS], programs = P.forward[item.kind];
      for (let group = 0; bits >>> group !== 0; group++) {
        const program = programs[group];
        if (!(bits & (1 << group)) || !program) continue;
        if (program !== current) { if (!program.use()) continue; current = program; }
        this._draw(item.kind, item, program, ranges[group * 2], ranges[group * 2 + 1], true);
      }
    }
    for (let i = this.glassCount; i < this.glass.length; i++) this.glass[i] = null;
    gl.enable(gl.CULL_FACE); gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------------------------------ context restore
  /** Recreate GPU buffers after a lost context. Meshes created with retain: false are dropped. */
  restore() {
    this._nothing = null;
    for (const mesh of this.meshes) {
      if (!mesh) continue;
      if (mesh.data) this._upload(mesh); else { mesh.vao = null; mesh.ranges.fill(null); mesh.groupBits.fill(0); mesh.spans.fill(0); mesh.shadowRuns.length = 0; mesh.hasGlass = false; }
    }
    for (const item of this.items.values()) if (item.kind === KIND_INSTANCED) this._uploadInstances(item);
    if (this.clusters) this.clusters.restore();
  }
}
