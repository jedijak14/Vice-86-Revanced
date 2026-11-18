// Skin: a thin layer over MeshBuilder used by all traffic vehicle geometry.
//
// Geometry code creates "nodes" (a surface point with its normal) and joins them into triangles with a
// material. The skin
//   - orients every triangle from the node normals, so authors never reason about winding;
//   - creates one vertex per (node, material) pair, because material bytes must not be shared across a
//     material boundary;
//   - can offset every node along its normal and turn the surface inside out, which is how inner liners
//     (headlining, pillar insides) are produced from the same description as the outer panels.

import { FAMILY, VEHICLE, GLASS } from '../../core/ids.js';

let serial = 0;
/** A material: shader family, id, the three parameter bytes, sRGB colour and baked occlusion multiplier. */
export function material(family, id, p0 = 0, p1 = 0, p2 = 0, color = [1, 1, 1]) {
  return { family, id, p0, p1, p2, color, key: ++serial };
}
export const vmat = (id, p0 = 0, p1 = 0, p2 = 0, color = [1, 1, 1]) => material(FAMILY.VEHICLE, id, p0, p1, p2, color);
export const gmat = (id, p0 = 0, color = [1, 1, 1]) => material(FAMILY.GLASS, id, p0, 0, 0, color);
export { VEHICLE, GLASS };

const STRIDE = 9; // x y z nx ny nz ua ub occlusion

export class Skin {
  /**
   * @param {MeshBuilder} mb
   * @param {{offset?: number, inward?: boolean}} opts  offset: metres every node is pushed against its normal;
   *        inward: store the reversed normal (the surface is then seen from the other side).
   */
  constructor(mb, opts = {}) {
    this.mb = mb; this.offset = opts.offset || 0; this.inward = !!opts.inward;
    this.data = []; this.verts = new Map();
  }

  /** Add a node from [x, y, z, nx, ny, nz]. Returns its id. */
  node(p, ua = 0, ub = 0, occ = 1) {
    const d = this.offset, s = this.inward ? -1 : 1, id = this.data.length / STRIDE;
    this.data.push(p[0] - d * p[3], p[1] - d * p[4], p[2] - d * p[5], s * p[3], s * p[4], s * p[5], ua, ub, occ);
    return id;
  }
  /** Node from separate position and normal, ignoring the skin's offset and inversion. */
  raw(x, y, z, nx, ny, nz, ua = 0, ub = 0, occ = 1) {
    const id = this.data.length / STRIDE; this.data.push(x, y, z, nx, ny, nz, ua, ub, occ); return id;
  }
  position(id, out = [0, 0, 0]) { const o = id * STRIDE, D = this.data; out[0] = D[o]; out[1] = D[o + 1]; out[2] = D[o + 2]; return out; }
  normalOf(id, out = [0, 0, 0]) { const o = id * STRIDE, D = this.data; out[0] = D[o + 3]; out[1] = D[o + 4]; out[2] = D[o + 5]; return out; }

  _vertex(id, m) {
    const key = id * 4096 + m.key; let v = this.verts.get(key);
    if (v === undefined) {
      const o = id * STRIDE, D = this.data, mb = this.mb;
      mb.material(m.id, m.p0, m.p1, m.p2).color(m.color[0], m.color[1], m.color[2]).occlusion(D[o + 8]);
      // A material may scale the texture coordinates it is given: the same panel coordinates in metres then drive
      // a coarser or finer shader pattern (the pitch of a grille).
      const k = m.uvScale || 1;
      v = mb.vertex(D[o], D[o + 1], D[o + 2], D[o + 3], D[o + 4], D[o + 5], D[o + 6] * k, D[o + 7] * k);
      this.verts.set(key, v);
    }
    return v;
  }

  /** Triangle through three nodes; wound so that it faces the side its node normals point to. Zero-area triangles are dropped. */
  tri(a, b, c, m) {
    if (a === b || b === c || a === c) return;
    const D = this.data, A = a * STRIDE, B = b * STRIDE, C = c * STRIDE;
    const ux = D[B] - D[A], uy = D[B + 1] - D[A + 1], uz = D[B + 2] - D[A + 2], vx = D[C] - D[A], vy = D[C + 1] - D[A + 1], vz = D[C + 2] - D[A + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-18) return;
    const d = nx * (D[A + 3] + D[B + 3] + D[C + 3]) + ny * (D[A + 4] + D[B + 4] + D[C + 4]) + nz * (D[A + 5] + D[B + 5] + D[C + 5]);
    const mb = this.mb; mb.family(m.family);
    const va = this._vertex(a, m), vb = this._vertex(b, m), vc = this._vertex(c, m);
    if (d >= 0) mb.tri(va, vb, vc); else mb.tri(va, vc, vb);
  }

  /** Quad through four nodes given around its perimeter. */
  quad(a, b, c, d, m) { this.tri(a, b, c, m); this.tri(a, c, d, m); }

  /**
   * Join two rows of nodes that may hold different counts (rows are arrays of { node, t } sorted by t, where t is
   * a shared coordinate along the row). Used where two differently sampled regions meet. `m` may be a function
   * of the triangle centre (x, y, z) and of the index of the rowA node the triangle starts from, when the strip
   * crosses a colour split.
   */
  stitch(rowA, rowB, m) {
    const pick = typeof m === 'function', D = this.data;
    let i = 0, j = 0;
    const tri = (a, b, c) => {
      if (!pick) return this.tri(a, b, c, m);
      const A = a * STRIDE, B = b * STRIDE, C = c * STRIDE;
      this.tri(a, b, c, m((D[A] + D[B] + D[C]) / 3, (D[A + 1] + D[B + 1] + D[C + 1]) / 3, (D[A + 2] + D[B + 2] + D[C + 2]) / 3, i));
    };
    while (i < rowA.length - 1 || j < rowB.length - 1) {
      const canA = i < rowA.length - 1, canB = j < rowB.length - 1;
      const advanceA = canA && (!canB || rowA[i + 1].t <= rowB[j + 1].t);
      if (advanceA) { tri(rowA[i].node, rowA[i + 1].node, rowB[j].node); i++; }
      else { tri(rowA[i].node, rowB[j + 1].node, rowB[j].node); j++; }
    }
  }
}

/** Linear blend of two [x,y,z,nx,ny,nz] samples with a renormalised normal. */
export function mixSample(a, b, t) {
  const o = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < 6; k++) o[k] = a[k] + (b[k] - a[k]) * t;
  const l = Math.hypot(o[3], o[4], o[5]) || 1; o[3] /= l; o[4] /= l; o[5] /= l;
  return o;
}
