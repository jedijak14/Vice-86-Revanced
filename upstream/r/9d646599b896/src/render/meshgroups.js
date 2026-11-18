// Orders a mesh's triangles by material group, so that each group of a family is one run of the index
// buffer and can be drawn with the program built for that group (shaders/surface.js).

import { VERTEX_STRIDE, VERTEX_LAYOUT } from '../core/ids.js';

// Reused between meshes: a copy of the run being reordered, and the write position of each group.
let scratch = new Uint32Array(0);
const cursor = new Int32Array(32);

/**
 * Reorder, in place, the triangles of indices[start, start + count) by the group of their material, keeping
 * the order within a group. The material of a triangle is that of its last vertex: the one a `flat` varying
 * takes its value from, so it is the id the fragment shader sees.
 * vertices: the mesh's vertex bytes (Uint8Array over MeshData.vertices); groupOf: material id -> group;
 * ranges: receives, per group, [first index, index count] (count 0 for a group the run does not hold).
 * Returns the groups present as bits (bit g = group g).
 */
export function sortTrianglesByGroup(indices, start, count, vertices, groupOf, groupCount, ranges) {
  const material = VERTEX_LAYOUT.material.offset, end = start + count;
  ranges.fill(0, 0, groupCount * 2);
  let present = 0;
  for (let i = start + 2; i < end; i += 3) {
    const group = groupOf[vertices[indices[i] * VERTEX_STRIDE + material]];
    ranges[group * 2 + 1] += 3; present |= 1 << group;
  }
  let next = start;
  for (let group = 0; group < groupCount; group++) { ranges[group * 2] = next; cursor[group] = next; next += ranges[group * 2 + 1]; }
  // One group only (most meshes of a tile's smaller families): the run is already in order.
  if ((present & (present - 1)) === 0) return present;
  if (scratch.length < count) scratch = new Uint32Array(count + (count >> 1));
  scratch.set(indices.subarray(start, end));
  for (let i = 0; i < count; i += 3) {
    const at = cursor[groupOf[vertices[scratch[i + 2] * VERTEX_STRIDE + material]]];
    indices[at] = scratch[i]; indices[at + 1] = scratch[i + 1]; indices[at + 2] = scratch[i + 2];
    cursor[groupOf[vertices[scratch[i + 2] * VERTEX_STRIDE + material]]] = at + 3;
  }
  return present;
}
