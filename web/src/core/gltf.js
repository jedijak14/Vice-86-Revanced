// glTF 2.0 (GLB) reading: the document, its buffers, and enough of the node graph to pose a rig.
//
// This is a reader, not an importer. It knows about the parts of glTF the models it is given actually
// use -- skinned meshes, one base-colour texture, TRS nodes, a skin with inverse bind matrices,
// translation/rotation/scale animation channels, geometry stored as integers rather than floats, and a
// texture that is a webp or sits in a sixteenth of an atlas -- and it refuses anything else loudly rather
// than drawing it wrongly. No rendering policy lives here: no materials, no units, no idea what a pedestrian
// is. `core/animate.js` turns what this reads into matrices per frame, and world/people/cast.js turns
// those into vertices the renderer can upload.
//
// Works in the page and in Node: no DOM, no fetch, no GL.

/** componentType → (TypedArray ctor name, bytes). */
const COMPONENTS = {
  5120: ['Int8Array', 1], 5121: ['Uint8Array', 1], 5122: ['Int16Array', 2], 5123: ['Uint16Array', 2],
  5125: ['Uint32Array', 4], 5126: ['Float32Array', 4],
};
const CHANNELS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/**
 * The extensions this reader genuinely handles, so a file that *requires* them is read rather than
 * refused:
 *
 *   KHR_mesh_quantization  geometry stored as integers. `readGeometry` undoes it, and for the raw
 *                          (unnormalized) integers gltfpack writes, the node's own scale and translation
 *                          are the metre -- which is why a quantized figure is 1.9 m tall and not 16383.
 *   KHR_texture_transform  a texture's own offset, scale and rotation. `uvMatrix` gives the 2x3 that
 *                          turns the coordinates stored in the mesh into the ones the image is sampled
 *                          at; without it a model packed into an atlas draws from the wrong sixteenth
 *                          of its own texture.
 *   EXT_texture_webp       a webp image, which every browser this game runs in decodes natively, so all
 *                          the reader has to do is follow the extension to the image it points at.
 */
const READ_EXTENSIONS = new Set(['KHR_mesh_quantization', 'KHR_texture_transform', 'EXT_texture_webp']);

/** What a normalized integer accessor is divided by to become a float, per componentType. */
const NORM_DIVISOR = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** The first four bytes of a GLB, and the two chunks after the header. */
export function parseGLB(buffer) {
  const view = buffer instanceof DataView ? buffer : new DataView(buffer.buffer || buffer, buffer.byteOffset || 0, buffer.byteLength || 0);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (bytes.length < 12 || view.getUint32(0, true) !== 0x46546c67) throw new Error('glTF: not a GLB file (missing "glTF" magic).');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF: only version 2 is read, this file says ${version}.`);
  const length = view.getUint32(8, true);
  let json = null, bin = null, pos = 12;
  while (pos + 8 <= Math.min(length, bytes.length)) {
    const chunkLength = view.getUint32(pos, true);
    const kind = view.getUint32(pos + 4, true);
    const start = pos + 8;
    if (kind === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + chunkLength)));
    else if (kind === 0x004e4942) bin = bytes.subarray(start, start + chunkLength);
    pos = start + chunkLength;
  }
  if (!json) throw new Error('glTF: no JSON chunk.');
  // The field is `extensionsRequired`. This guard used to read `requiredExtensions`, which is not a glTF
  // field, so it was a guard that never fired: nothing was ever refused, and a file whose geometry this
  // reader cannot decode was read as though it could.
  const required = json.extensionsRequired || [];
  for (const ext of required) {
    // KHR_materials_* change how a surface is shaded, which this reader is not asked to care about;
    // anything else (meshopt, Draco) changes the bytes themselves and needs a decoder this does not have.
    if (/^(KHR_materials_|MSFT_|EXT_texture_status)/.test(ext)) continue;
    if (READ_EXTENSIONS.has(ext)) continue;
    throw new Error(`glTF: required extension ${ext} is not read by this loader.`);
  }
  return { json, bin: bin || new Uint8Array(0) };
}

/**
 * One accessor as a typed array, packed densely (stride and byte offsets applied, sparse ignored).
 * `out` is reused when given and the shapes match, which is how a per-frame read stays allocation-free.
 */
export function readAccessor(json, bin, index, out = null) {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error(`glTF: accessor ${index} is not in the document.`);
  if (acc.sparse) throw new Error(`glTF: sparse accessor ${index} is not read by this loader.`);
  const names = Object.keys(COMPONENTS);
  const compType = acc.componentType;
  if (!names.includes(String(compType))) throw new Error(`glTF: componentType ${compType} unsupported`);
  const [ctorName, size] = COMPONENTS[String(compType)];
  const comps = CHANNELS[acc.type];
  if (!comps) throw new Error(`glTF: type ${acc.type} unsupported`);
  const Ctor = { Int8Array, Uint8Array, Int16Array, Uint16Array, Float32Array, Uint32Array }[ctorName];
  const count = acc.count;
  const normalized = !!acc.normalized;
  let dst = out && out.length === count * comps && out.constructor === Ctor ? out : new Ctor(count * comps);
  const view = acc.bufferView === undefined ? null : json.bufferViews[acc.bufferView];
  if (!view) {
    dst.fill(0);                                               // accessor with no buffer view: all zero
    return { array: dst, count, components: comps, normalized };
  }
  const stride = view.byteStride || size * comps;
  const base = view.byteOffset + (acc.byteOffset || 0);
  const src = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const little = true;
  const read = (o, k) => (compType === 5126 ? src.getFloat32(o + k * size, little)
    : compType === 5123 ? src.getUint16(o + k * size, little)
      : compType === 5125 ? src.getUint32(o + k * size, little)
        : compType === 5122 ? src.getInt16(o + k * size, little)
          : compType === 5120 ? src.getInt8(o + k * size) : src.getUint8(o + k * size));
  for (let i = 0; i < count; i++) for (let k = 0; k < comps; k++) dst[i * comps + k] = read(base + i * stride, k);
  return { array: dst, count, components: comps, normalized };
}

/**
 * A geometry attribute as floats in the model's own units: a position in metres (before the node's
 * transform, which is where a quantized file keeps its scale), a normal as a direction, a texture
 * coordinate as the material samples it. Storage is not the value, and the three ways a file may store
 * one are told apart here rather than by whoever reads it:
 *
 *   floats            nothing to undo;
 *   normalized ints   divide by the type's largest value, clamping a signed -128 or -32768 to -1 as the
 *                     specification says, which is what an i8 normal or a u16 texture coordinate is;
 *   raw ints          the integer *is* the value and the node's scale is the metre (KHR_mesh_quantization
 *                     as gltfpack writes it), so these become floats and are placed by the node matrix
 *                     that whoever reads this already applies.
 *
 * Indices, joints and weights are not geometry and stay the integers they are: read those with
 * `readAccessor`. `out` is reused when it fits, as it is there.
 * @returns {{array: Float32Array, count: number, components: number}|null}
 */
export function readGeometry(gltf, primitive, name, out = null) {
  const index = primitive.attributes?.[name];
  if (index === undefined) return null;
  const acc = gltf.json.accessors?.[index];
  const raw = gltf.accessor(index);
  if (!acc || raw.array instanceof Float32Array) return { array: raw.array, count: raw.count, components: raw.components };
  const divisor = NORM_DIVISOR[acc.componentType];
  const dst = out && out.length === raw.array.length && out instanceof Float32Array ? out : new Float32Array(raw.array.length);
  if (!divisor) { for (let i = 0; i < dst.length; i++) dst[i] = raw.array[i]; }        // u32 geometry: the integer is the value
  else if (acc.normalized) {
    // A signed byte bottoms out at -128, which has no -1.0157 to divide down to: the specification clamps it.
    const floor = acc.componentType === 5120 || acc.componentType === 5122 ? -1 : 0;
    for (let i = 0; i < dst.length; i++) {
      const v = raw.array[i] / divisor;
      dst[i] = v < floor ? floor : v;
    }
  } else { for (let i = 0; i < dst.length; i++) dst[i] = raw.array[i]; }               // raw ints: the node places them
  return { array: dst, count: raw.count, components: raw.components };
}

/**
 * A texture's placement as a 2x3 matrix, from KHR_texture_transform: `uv' = T(offset) · R(rotation) ·
 * S(scale) · uv`, which is four multiplies and two adds per vertex. Null when the texture is placed
 * where it was authored, which is most of them.
 * @param {object} [info]  the material's texture info (the object holding `index`)
 * @returns {number[]|null} [a, b, ou, c, d, ov] with u' = a·u + b·v + ou and v' = c·u + d·v + ov
 */
export function uvMatrix(info) {
  const t = info?.extensions?.KHR_texture_transform;
  if (!t) return null;
  const [ou, ov] = t.offset || [0, 0];
  const [su, sv] = t.scale || [1, 1];
  const r = t.rotation || 0;
  if (r === 0) return (su === 1 && sv === 1 && ou === 0 && ov === 0) ? null : [su, 0, ou, 0, sv, ov];
  const cos = Math.cos(r), sin = Math.sin(r);
  return [cos * su, -sin * sv, ou, sin * su, cos * sv, ov];
}

/** A model in memory: the document, its binary chunk, and the tables read from them on demand. */
export class Gltf {
  constructor(buffer) {
    const { json, bin } = parseGLB(buffer);
    this.json = json;
    this.bin = bin;
    this.nodes = json.nodes || [];
    this.meshes = json.meshes || [];
    this.materials = json.materials || [];
    this.skins = json.skins || [];
    this.scenes = json.scenes || [];
    this.buffer = json.buffers?.[0] || {};
  }

  /** Named, in file order: `images` plus the textures that point at them. */
  get images() { return this.json.images || []; }
  get textures() { return this.json.textures || []; }
  get samplers() { return this.json.samplers || [null]; }

  accessor(index, out) { return readAccessor(this.json, this.bin, index, out); }

  /** `POSITION`-style convenience: an accessor by a mesh attribute name, as it is stored. */
  attribute(primitive, name, out) {
    const index = primitive.attributes?.[name];
    return index === undefined ? null : this.accessor(index, out);
  }

  /** The same attribute as floats in the model's own units, for geometry rather than for indices. */
  geometry(primitive, name, out) {
    return readGeometry(this, primitive, name, out);
  }

  /** A texture image as bytes (PNG/JPEG/WebP) -- decoding is the browser's job, so this hands the bytes over. */
  imageBytes(imageIndex) {
    const im = this.images[imageIndex];
    if (!im || im.bufferView === undefined) return null;
    const view = this.json.bufferViews[im.bufferView];
    return this.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  }

  /**
   * The image a texture actually points at. A file that carries a webp says so in an extension and leaves
   * `source` out, because a reader without EXT_texture_webp is meant to fall back to a PNG that is not
   * there; following the extension is the whole of supporting it.
   * @returns {number} the image index, or -1 when the texture has none
   */
  textureSource(textureIndex) {
    const t = this.textures[textureIndex];
    if (!t) return -1;
    const webp = t.extensions?.EXT_texture_webp?.source;
    return webp !== undefined ? webp : (t.source ?? -1);
  }

  /** A texture's image as bytes, and what those bytes are. */
  textureBytes(textureIndex) {
    const source = this.textureSource(textureIndex);
    if (source < 0) return null;
    const bytes = this.imageBytes(source);
    return bytes ? { bytes, mimeType: this.images[source].mimeType || null, index: source } : null;
  }

  /** The node indices that are children of `nodeIndex`, from the scene graph as authored. */
  childrenOf(nodeIndex) { return this.nodes[nodeIndex]?.children || []; }

  /** Every node reachable from the default scene, in parent-before-child order (what a skin needs). */
  orderedNodes() {
    const sceneIndex = this.json.scene ?? 0;
    const roots = this.scenes[sceneIndex]?.nodes || this.nodes.map((n, i) => (this.isRoot(i) ? i : -1)).filter((i) => i >= 0);
    const order = [], seen = new Set();
    const walk = (i) => {
      if (seen.has(i)) return;
      seen.add(i);
      order.push(i);
      for (const c of this.childrenOf(i)) walk(c);
    };
    for (const r of roots) walk(r);
    for (let i = 0; i < this.nodes.length; i++) if (!seen.has(i)) order.push(i);   // orphaned bones still get posed
    return order;
  }

  isRoot(nodeIndex) {
    for (const n of this.nodes) if ((n.children || []).includes(nodeIndex)) return false;
    return true;
  }

  /**
   * The node's own transform, composed from TRS (or a pre-multiplied matrix, which is rare and here
   * taken at face value). `out` is a 16-float column-major matrix.
   */
  localMatrix(nodeIndex, out) {
    const n = this.nodes[nodeIndex] || {};
    if (n.matrix) {
      for (let i = 0; i < 16; i++) out[i] = n.matrix[i];
      return out;
    }
    const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    return composeTRS(t, r, s, out);
  }

  /** World matrices of every node, rest pose unless `patch` says otherwise (see animate.js). */
  worldMatrices(patch = null) {
    const count = this.nodes.length;
    const out = new Float32Array(count * 16);
    const order = this.orderedNodes();
    const parents = parentIndex(this);
    for (const i of order) {
      const local = patch ? patch.localMatrix(this, i, new Float32Array(16)) : this.localMatrix(i, new Float32Array(16));
      const p = parents[i];
      if (p < 0) out.set(local, i * 16);
      else multiply(out, p * 16, local, 0, out, i * 16);
    }
    return out;
  }

  /** The joint list and inverse bind matrices of a skin. */
  skin(index = 0) {
    const s = this.skins[index];
    if (!s) return null;
    const joints = s.joints || [];
    const ibm = s.inverseBindMatrices === undefined ? null : this.accessor(s.inverseBindMatrices).array;
    return { joints, inverseBindMatrices: ibm, skeleton: s.skeleton ?? null, name: s.name || `skin${index}` };
  }

  /** Animation clips as `{ name, duration, channels: [{ node, path, input, output, interpolation }] }`. */
  clips() {
    return (this.json.animations || []).map((a) => {
      const samplers = (a.samplers || []).map((s) => ({
        input: this.accessor(s.input).array,
        output: this.accessor(s.output),
        interpolation: s.interpolation || 'LINEAR',
      }));
      let duration = 0;
      const channels = (a.channels || []).map((c) => {
        const s = samplers[c.sampler];
        if (s.input.length) duration = Math.max(duration, s.input[s.input.length - 1]);
        return { node: c.target.node, path: c.target.path, ...s };
      });
      return { name: a.name || 'clip', duration, channels };
    });
  }

  /**
   * Mesh primitives with their vertex arrays read out, grouped by the node that draws them, plus the
   * skin each is weighted to. This is the shape world/people/cast.js wants; it does not know what to do
   * with it.
   */
  primitives() {
    const parents = parentIndex(this);
    const out = [];
    for (let node = 0; node < this.nodes.length; node++) {
      const n = this.nodes[node];
      if (n.mesh === undefined) continue;
      for (const prim of this.meshes[n.mesh]?.primitives || []) {
        out.push({ node, parent: parents[node], name: n.name || this.meshes[n.mesh].name || 'mesh', skin: n.skin ?? null, prim });
      }
    }
    return out;
  }
}

/** The index of each node's parent, or -1 at the roots. */
export function parentIndex(gltf) {
  const out = new Int32Array(gltf.nodes.length).fill(-1);
  gltf.nodes.forEach((n, i) => { for (const c of n.children || []) out[c] = i; });
  return out;
}

/** Column-major `out = T * R * S`, the glTF node transform. */
export function composeTRS(t, r, s, out) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
  out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
  out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

/** Column-major matrix product, `a` read at `aOffset` and `b` at `bOffset`, into `out` at `outOffset`. */
export function multiply(a, aOffset, b, bOffset, out, outOffset) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bOffset + c * 4], b1 = b[bOffset + c * 4 + 1], b2 = b[bOffset + c * 4 + 2], b3 = b[bOffset + c * 4 + 3];
    out[outOffset + c * 4] = a[aOffset] * b0 + a[aOffset + 4] * b1 + a[aOffset + 8] * b2 + a[aOffset + 12] * b3;
    out[outOffset + c * 4 + 1] = a[aOffset + 1] * b0 + a[aOffset + 5] * b1 + a[aOffset + 9] * b2 + a[aOffset + 13] * b3;
    out[outOffset + c * 4 + 2] = a[aOffset + 2] * b0 + a[aOffset + 6] * b1 + a[aOffset + 10] * b2 + a[aOffset + 14] * b3;
    out[outOffset + c * 4 + 3] = a[aOffset + 3] * b0 + a[aOffset + 7] * b1 + a[aOffset + 11] * b2 + a[aOffset + 15] * b3;
  }
  return out;
}

/** A point through a column-major matrix (the w row ignored, as glTF skinning does). */
export function transformPoint(m, offset, x, y, z, out) {
  out[0] = m[offset] * x + m[offset + 4] * y + m[offset + 8] * z + m[offset + 12];
  out[1] = m[offset + 1] * x + m[offset + 5] * y + m[offset + 9] * z + m[offset + 13];
  out[2] = m[offset + 2] * x + m[offset + 6] * y + m[offset + 10] * z + m[offset + 14];
  return out;
}

/** A direction through the upper-left 3x3, without the translation. */
export function transformDirection(m, offset, x, y, z, out) {
  out[0] = m[offset] * x + m[offset + 4] * y + m[offset + 8] * z;
  out[1] = m[offset + 1] * x + m[offset + 5] * y + m[offset + 9] * z;
  out[2] = m[offset + 2] * x + m[offset + 6] * y + m[offset + 10] * z;
  return out;
}
