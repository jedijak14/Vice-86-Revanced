// MeshBuilder: the one way geometry is authored in this project.
// Generators emit vertices and triangles; finish() packs them into the interleaved layout in ids.js.
// Works identically in the page, in workers and in Node (no DOM, no GL).

import { VERTEX_STRIDE, FAMILY } from './ids.js';

const clamp8 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x) | 0;

export class MeshBuilder {
  constructor(expectedVertices = 1024) {
    this._cap = Math.max(64, expectedVertices);
    this.pos = new Float32Array(this._cap * 3);
    this.nrm = new Float32Array(this._cap * 3);
    this.uv = new Float32Array(this._cap * 2);
    this.col = new Uint8Array(this._cap * 4);
    this.mat = new Uint8Array(this._cap * 4);
    this.count = 0;
    /** One growable index list per shader family. */
    this.idx = []; this.idxLen = [];
    for (let i = 0; i < FAMILY.COUNT; i++) { this.idx.push(new Uint32Array(0)); this.idxLen.push(0); }
    // Current authoring state, applied to every vertex pushed after it is set.
    this._family = FAMILY.SOLID;
    this._c = [255, 255, 255, 255];
    this._m = [0, 0, 0, 0];
  }

  // ---- authoring state
  /** Select the shader family that subsequently added triangles belong to. */
  family(f) { this._family = f; return this; }
  /** Material id and its three byte parameters (0..255) for subsequently added vertices. */
  material(id, p0 = 0, p1 = 0, p2 = 0) { const m = this._m; m[0] = id; m[1] = clamp8(p0); m[2] = clamp8(p1); m[3] = clamp8(p2); return this; }
  /** Albedo tint in sRGB 0..1 for subsequently added vertices. Does not change the occlusion byte. */
  color(r, g, b) { if (Array.isArray(r)) { b = r[2]; g = r[1]; r = r[0]; } const c = this._c; c[0] = clamp8(r * 255 + 0.5); c[1] = clamp8(g * 255 + 0.5); c[2] = clamp8(b * 255 + 0.5); return this; }
  /** Baked occlusion 0..1 (1 = fully open) for subsequently added vertices. */
  occlusion(a) { this._c[3] = clamp8(a * 255 + 0.5); return this; }

  _grow(n) {
    if (this.count + n <= this._cap) return;
    let cap = this._cap; while (cap < this.count + n) cap *= 2;
    const g = (old, Type, k) => { const a = new Type(cap * k); a.set(old.subarray(0, this.count * k)); return a; };
    this.pos = g(this.pos, Float32Array, 3); this.nrm = g(this.nrm, Float32Array, 3); this.uv = g(this.uv, Float32Array, 2);
    this.col = g(this.col, Uint8Array, 4); this.mat = g(this.mat, Uint8Array, 4); this._cap = cap;
  }

  // ---- vertices
  /** Add a vertex with the current colour and material; returns its index. The normal need not be unit length. */
  vertex(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, v = 0) {
    this._grow(1);
    const i = this.count++, p = i * 3, q = i * 4;
    this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
    this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz;
    this.uv[i * 2] = u; this.uv[i * 2 + 1] = v;
    const c = this._c, m = this._m;
    this.col[q] = c[0]; this.col[q + 1] = c[1]; this.col[q + 2] = c[2]; this.col[q + 3] = c[3];
    this.mat[q] = m[0]; this.mat[q + 1] = m[1]; this.mat[q + 2] = m[2]; this.mat[q + 3] = m[3];
    return i;
  }
  /** Overwrite the occlusion byte of an existing vertex (for baked contact darkening). */
  setOcclusion(i, a) { this.col[i * 4 + 3] = clamp8(a * 255 + 0.5); }
  setNormal(i, nx, ny, nz) { const p = i * 3; this.nrm[p] = nx; this.nrm[p + 1] = ny; this.nrm[p + 2] = nz; }

  // ---- triangles (counter-clockwise when seen from the side the normal points to)
  _reserveIdx(f, n) {
    const need = this.idxLen[f] + n; let a = this.idx[f];
    if (need > a.length) { let cap = Math.max(256, a.length * 2); while (cap < need) cap *= 2; const b = new Uint32Array(cap); b.set(a.subarray(0, this.idxLen[f])); this.idx[f] = a = b; }
    return a;
  }
  tri(a, b, c) { const f = this._family, ix = this._reserveIdx(f, 3), n = this.idxLen[f]; ix[n] = a; ix[n + 1] = b; ix[n + 2] = c; this.idxLen[f] = n + 3; return this; }
  /** Quad a-b-c-d in counter-clockwise order. */
  quad(a, b, c, d) { const f = this._family, ix = this._reserveIdx(f, 6), n = this.idxLen[f]; ix[n] = a; ix[n + 1] = b; ix[n + 2] = c; ix[n + 3] = a; ix[n + 4] = c; ix[n + 5] = d; this.idxLen[f] = n + 6; return this; }

  /**
   * Flat quad from four corner positions (counter-clockwise), with a face normal computed from the corners.
   * uvs: optional [u0,v0,u1,v1,u2,v2,u3,v3]. Returns the index of the first of its four vertices.
   */
  flatQuad(p0, p1, p2, p3, uvs) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2], vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const u = uvs || [0, 0, 1, 0, 1, 1, 0, 1];
    const a = this.vertex(p0[0], p0[1], p0[2], nx, ny, nz, u[0], u[1]);
    this.vertex(p1[0], p1[1], p1[2], nx, ny, nz, u[2], u[3]);
    this.vertex(p2[0], p2[1], p2[2], nx, ny, nz, u[4], u[5]);
    this.vertex(p3[0], p3[1], p3[2], nx, ny, nz, u[6], u[7]);
    this.quad(a, a + 1, a + 2, a + 3);
    return a;
  }

  /**
   * A (rows+1) x (cols+1) grid of vertices from a callback, stitched into quads.
   * fn(i, j, out) fills out = {x,y,z,nx,ny,nz,u,v} for row i (0..rows), column j (0..cols).
   * Winding: with i increasing "up" and j increasing "right" as seen from outside, set flip=false.
   */
  grid(rows, cols, fn, flip = false) {
    const o = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, u: 0, v: 0 }, base = this.count;
    for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) { fn(i, j, o); this.vertex(o.x, o.y, o.z, o.nx, o.ny, o.nz, o.u, o.v); }
    const w = cols + 1;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const a = base + i * w + j, b = a + 1, c = a + w + 1, d = a + w;
      if (flip) this.quad(a, d, c, b); else this.quad(a, b, c, d);
    }
    return base;
  }

  // ---- whole-mesh operations
  /**
   * Append another builder, optionally transformed by a column-major 4x4 (rigid or uniformly scaled;
   * normals are transformed by the upper 3x3 and renormalised at finish). If the matrix mirrors
   * (negative determinant) triangle winding is reversed so faces stay outward.
   */
  append(other, m = null) {
    const n = other.count, base = this.count; this._grow(n);
    const P = other.pos, N = other.nrm;
    if (m) {
      for (let i = 0; i < n; i++) {
        const p = i * 3, x = P[p], y = P[p + 1], z = P[p + 2], a = N[p], b = N[p + 1], c = N[p + 2], q = (base + i) * 3;
        this.pos[q] = m[0] * x + m[4] * y + m[8] * z + m[12]; this.pos[q + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; this.pos[q + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        this.nrm[q] = m[0] * a + m[4] * b + m[8] * c; this.nrm[q + 1] = m[1] * a + m[5] * b + m[9] * c; this.nrm[q + 2] = m[2] * a + m[6] * b + m[10] * c;
      }
    } else { this.pos.set(P.subarray(0, n * 3), base * 3); this.nrm.set(N.subarray(0, n * 3), base * 3); }
    this.uv.set(other.uv.subarray(0, n * 2), base * 2);
    this.col.set(other.col.subarray(0, n * 4), base * 4);
    this.mat.set(other.mat.subarray(0, n * 4), base * 4);
    this.count += n;
    const mirrored = m ? (m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5])) < 0 : false;
    for (let f = 0; f < FAMILY.COUNT; f++) {
      const len = other.idxLen[f]; if (!len) continue;
      const src = other.idx[f], dst = this._reserveIdx(f, len), o = this.idxLen[f];
      if (mirrored) for (let k = 0; k < len; k += 3) { dst[o + k] = src[k] + base; dst[o + k + 1] = src[k + 2] + base; dst[o + k + 2] = src[k + 1] + base; }
      else for (let k = 0; k < len; k++) dst[o + k] = src[k] + base;
      this.idxLen[f] = o + len;
    }
    return base;
  }

  /** Transform every vertex in place (same rules as append). */
  transform(m) { const t = new MeshBuilder(this.count); t.append(this, m); Object.assign(this, t); return this; }

  /**
   * Recompute normals from triangles. Vertices closer than `weld` metres share a normal when the angle
   * between their faces is below `creaseDeg`; sharper edges stay hard. Area-and-angle weighted.
   * Only touches vertices in [from, to).
   */
  computeNormals(creaseDeg = 40, from = 0, to = this.count, weld = 1e-4) {
    const P = this.pos, N = this.nrm, cosC = Math.cos(creaseDeg * Math.PI / 180), inv = 1 / weld;
    // face normals for triangles fully inside the range
    const tris = [];
    for (let f = 0; f < FAMILY.COUNT; f++) { const ix = this.idx[f], len = this.idxLen[f]; for (let k = 0; k < len; k += 3) { const a = ix[k], b = ix[k + 1], c = ix[k + 2]; if (a >= from && a < to && b >= from && b < to && c >= from && c < to) tris.push(a, b, c); } }
    const nt = tris.length / 3, fn = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      fn[t * 3] = uy * vz - uz * vy; fn[t * 3 + 1] = uz * vx - ux * vz; fn[t * 3 + 2] = ux * vy - uy * vx; // length = 2 * area
    }
    // bucket corners by welded position
    const buckets = new Map();
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
      const v = tris[t * 3 + k], p = v * 3, key = Math.round(P[p] * inv) + ',' + Math.round(P[p + 1] * inv) + ',' + Math.round(P[p + 2] * inv);
      let b = buckets.get(key); if (!b) buckets.set(key, b = []); b.push(v, t);
    }
    const acc = new Float32Array((to - from) * 3);
    for (const b of buckets.values()) {
      for (let i = 0; i < b.length; i += 2) {
        const v = b[i], t = b[i + 1], ax = fn[t * 3], ay = fn[t * 3 + 1], az = fn[t * 3 + 2], al = Math.hypot(ax, ay, az) || 1;
        let sx = 0, sy = 0, sz = 0;
        for (let j = 0; j < b.length; j += 2) {
          const u = b[j + 1], bx = fn[u * 3], by = fn[u * 3 + 1], bz = fn[u * 3 + 2], bl = Math.hypot(bx, by, bz) || 1;
          if ((ax * bx + ay * by + az * bz) / (al * bl) >= cosC) { sx += bx; sy += by; sz += bz; }
        }
        const q = (v - from) * 3; acc[q] += sx; acc[q + 1] += sy; acc[q + 2] += sz;
      }
    }
    for (let v = from; v < to; v++) { const q = (v - from) * 3; if (acc[q] || acc[q + 1] || acc[q + 2]) { N[v * 3] = acc[q]; N[v * 3 + 1] = acc[q + 1]; N[v * 3 + 2] = acc[q + 2]; } }
    return this;
  }

  get triangleCount() { let n = 0; for (const l of this.idxLen) n += l; return n / 3; }

  bounds() {
    const P = this.pos, b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.count; i++) for (let k = 0; k < 3; k++) { const v = P[i * 3 + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
    if (!this.count) return [0, 0, 0, 0, 0, 0];
    return b;
  }

  /**
   * Pack into the GPU layout.
   * Returns MeshData: { vertices: ArrayBuffer, indices: Uint32Array, groups: [{family, start, count}],
   *                     bounds: [minx,miny,minz,maxx,maxy,maxz], vertexCount, indexCount }
   * Groups are contiguous index ranges, one per family that has triangles.
   */
  finish() {
    const n = this.count, buf = new ArrayBuffer(n * VERTEX_STRIDE), dv = new DataView(buf), u8 = new Uint8Array(buf);
    const P = this.pos, N = this.nrm, U = this.uv, C = this.col, M = this.mat;
    for (let i = 0; i < n; i++) {
      const o = i * VERTEX_STRIDE, p = i * 3, q = i * 4;
      dv.setFloat32(o, P[p], true); dv.setFloat32(o + 4, P[p + 1], true); dv.setFloat32(o + 8, P[p + 2], true);
      let nx = N[p], ny = N[p + 1], nz = N[p + 2]; const l = Math.hypot(nx, ny, nz);
      if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 1; nz = 0; }
      dv.setInt16(o + 12, Math.round(nx * 32767), true); dv.setInt16(o + 14, Math.round(ny * 32767), true); dv.setInt16(o + 16, Math.round(nz * 32767), true); dv.setInt16(o + 18, 0, true);
      u8[o + 20] = C[q]; u8[o + 21] = C[q + 1]; u8[o + 22] = C[q + 2]; u8[o + 23] = C[q + 3];
      u8[o + 24] = M[q]; u8[o + 25] = M[q + 1]; u8[o + 26] = M[q + 2]; u8[o + 27] = M[q + 3];
      dv.setFloat32(o + 28, U[i * 2], true); dv.setFloat32(o + 32, U[i * 2 + 1], true);
    }
    let total = 0; for (const l of this.idxLen) total += l;
    const indices = new Uint32Array(total), groups = []; let at = 0;
    for (let f = 0; f < FAMILY.COUNT; f++) { const len = this.idxLen[f]; if (!len) continue; indices.set(this.idx[f].subarray(0, len), at); groups.push({ family: f, start: at, count: len }); at += len; }
    return { vertices: buf, indices, groups, bounds: this.bounds(), vertexCount: n, indexCount: total };
  }
}

/** Transferable buffers of a MeshData, for postMessage. */
export const meshTransferables = (md) => [md.vertices, md.indices.buffer];

/** Read back positions / normals / colours of a MeshData (used by tools and tests, not by the game loop). */
export function unpackMesh(md) {
  const n = md.vertexCount, dv = new DataView(md.vertices), u8 = new Uint8Array(md.vertices);
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = new Uint8Array(n * 4), mat = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * VERTEX_STRIDE;
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = dv.getFloat32(o + k * 4, true); nrm[i * 3 + k] = dv.getInt16(o + 12 + k * 2, true) / 32767; }
    uv[i * 2] = dv.getFloat32(o + 28, true); uv[i * 2 + 1] = dv.getFloat32(o + 32, true);
    for (let k = 0; k < 4; k++) { col[i * 4 + k] = u8[o + 20 + k]; mat[i * 4 + k] = u8[o + 24 + k]; }
  }
  return { pos, nrm, uv, col, mat, indices: md.indices, groups: md.groups };
}
