// The reader, against the file that broke it.
//
// model.glb is the figure the project owner uploaded for the player, and it is written by gltfpack, which
// stores geometry as integers and textures as webp in a sixteenth of an atlas. A reader that refused it
// would have been a reader that refused most of what is published, so the three things it needs are read
// here -- and the numbers asserted are the ones the file itself says, measured out of it rather than
// typed in from a look at the model:
//
//   KHR_mesh_quantization  POSITION is u16 and *raw*, so the integer is the value and the node's own
//                          scale is the metre. Read as a float and placed by the node matrix the figure
//                          is 1.902 m tall; read as the integer it is 16383 of something.
//   i8 normals             normalized, so -128..127 is -1..1 and a direction rather than a count.
//   KHR_texture_transform  the coordinates stored in the mesh reach 0.0625, which is the sixteenth of the
//                          atlas the figure was packed into; the material's own scale of 16 is what puts
//                          it across the whole texture. Without it the figure is drawn from the wrong
//                          corner of its own skin.
//   EXT_texture_webp       the texture says so in an extension and leaves `source` out, so following the
//                          extension is the whole of supporting it.
//
// The float packs the crowd already walks on are asserted unchanged, because a reader that quietly
// converted everything would be a reader that broke five characters to fix one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Gltf, parseGLB, readGeometry, uvMatrix, transformPoint } from '../../web/src/core/gltf.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
/** The player's body, where the page can actually ask for it: the root copy is not inside Vercel's `web/`. */
const PLAYER = 'web/assets/models/player/model.glb';

/** A GLB with a JSON chunk and nothing else: enough to ask a reader what it refuses. */
function glbOf(json) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  const chunk = new Uint8Array(text.length + pad);
  chunk.set(text);
  chunk.fill(0x20, text.length);                      // a JSON chunk is padded with spaces
  const file = new ArrayBuffer(20 + chunk.length);    // 12 of header, 8 of chunk header
  const view = new DataView(file);
  view.setUint32(0, 0x46546c67, true);                // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, file.byteLength, true);
  view.setUint32(12, chunk.length, true);
  view.setUint32(16, 0x4e4f534a, true);               // 'JSON'
  new Uint8Array(file).set(chunk, 20);
  return file;
}

function read(path) {
  const buf = readFileSync(join(root, path));
  return new Gltf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/** Every vertex of the uploaded figure, placed by the node matrix that carries its metre. */
function placedFigure(gltf) {
  const prim = gltf.meshes[0].primitives[0];
  const pos = gltf.geometry(prim, 'POSITION');
  const worlds = gltf.worldMatrices();
  const drawn = gltf.primitives()[0];
  const m = worlds.subarray(drawn.node * 16, drawn.node * 16 + 16);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], out = [0, 0, 0];
  for (let v = 0; v < pos.count; v++) {
    transformPoint(m, 0, pos.array[v * 3], pos.array[v * 3 + 1], pos.array[v * 3 + 2], out);
    for (let k = 0; k < 3; k++) { if (out[k] < lo[k]) lo[k] = out[k]; if (out[k] > hi[k]) hi[k] = out[k]; }
  }
  return { pos, lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

// --------------------------------------------------------------------------------------- the figure

test('a quantized figure is read at the size it was authored', () => {
  const gltf = read(PLAYER);
  const { pos, lo, hi, size } = placedFigure(gltf);

  assert.equal(pos.count, 201540, 'the vertex count the file states');
  assert.ok(pos.array instanceof Float32Array, 'geometry is handed over as floats whatever was stored');
  // A person, in metres, standing with his origin at his own middle: 1.9 m tall, a shoulder and a half
  // wide, and as deep as a chest. Read as the raw integers these are 16383, 5982 and 3452.
  assert.ok(Math.abs(size[1] - 1.902) < 0.01, `the figure is ${size[1].toFixed(3)} m tall`);
  assert.ok(Math.abs(size[0] - 0.695) < 0.01, `${size[0].toFixed(3)} m wide`);
  assert.ok(Math.abs(size[2] - 0.401) < 0.01, `${size[2].toFixed(3)} m deep`);
  assert.ok(Math.abs(lo[1] + 0.951) < 0.01 && Math.abs(hi[1] - 0.951) < 0.01,
    `centred on his own height: y runs ${lo[1].toFixed(3)} to ${hi[1].toFixed(3)}, so he is lifted by 0.951 to stand on the ground`);
});

test('an i8 normal is a direction, and an integer index stays an integer', () => {
  const gltf = read(PLAYER);
  const prim = gltf.meshes[0].primitives[0];
  const nrm = gltf.geometry(prim, 'NORMAL');

  assert.equal(gltf.json.accessors[prim.attributes.NORMAL].componentType, 5120, 'stored as signed bytes');
  assert.ok(nrm.array instanceof Float32Array, 'and read as floats');
  let longest = 0, shortest = Infinity;
  for (let v = 0; v < nrm.count; v++) {
    const x = nrm.array[v * 3], y = nrm.array[v * 3 + 1], z = nrm.array[v * 3 + 2];
    for (const c of [x, y, z]) assert.ok(c >= -1 && c <= 1, `a normal component of ${c} is not a direction`);
    const len = Math.hypot(x, y, z);
    longest = Math.max(longest, len); shortest = Math.min(shortest, len);
  }
  // A byte is 1/127 of a unit, so a unit normal comes back within a byte or two of its length.
  assert.ok(longest < 1.05 && shortest > 0.9, `normal lengths ran ${shortest.toFixed(3)} to ${longest.toFixed(3)}`);

  // Indices are not geometry: 1.1 m of them, as the u32 the file stored, and every one of them a vertex.
  const idx = gltf.accessor(prim.indices);
  assert.ok(idx.array instanceof Uint32Array, 'the index buffer is still integers');
  assert.equal(idx.array.length, 1110912, '370 304 triangles');
  let max = 0;
  for (let i = 0; i < idx.array.length; i++) if (idx.array[i] > max) max = idx.array[i];
  assert.ok(max < nrm.count, `index ${max} reaches past the last of ${nrm.count} vertices`);
});

test('a texture packed into a sixteenth of an atlas is sampled across the whole of it', () => {
  const gltf = read(PLAYER);
  const prim = gltf.meshes[0].primitives[0];
  const uv = gltf.geometry(prim, 'TEXCOORD_0');
  const info = gltf.materials[0].pbrMetallicRoughness.baseColorTexture;

  let umax = 0, vmax = 0;
  for (let v = 0; v < uv.count; v++) { umax = Math.max(umax, uv.array[v * 2]); vmax = Math.max(vmax, uv.array[v * 2 + 1]); }
  assert.ok(Math.abs(umax - 1 / 16) < 1e-4 && Math.abs(vmax - 1 / 16) < 1e-4,
    `the stored coordinates reach ${umax.toFixed(5)} by ${vmax.toFixed(5)}, which is one sixteenth of the atlas`);

  const m = uvMatrix(info);
  assert.ok(m, 'the material carries a placement, and the reader is what applies it');
  assert.ok(Math.abs(m[0] - 16.0026) < 1e-3 && Math.abs(m[4] - 15.9785) < 1e-3, `scaled by ${m[0]}, ${m[4]}`);
  // Across the whole texture, rather than the corner of it the figure was packed into.
  assert.ok(Math.abs(m[0] * umax + m[2] - 1) < 1e-3, `u reaches ${(m[0] * umax + m[2]).toFixed(4)}`);
  assert.ok(Math.abs(m[4] * vmax + m[5] - 1) < 1e-3, `v reaches ${(m[4] * vmax + m[5]).toFixed(4)}`);

  // A texture placed where it was authored needs no matrix at all, which is what most of them are.
  assert.equal(uvMatrix({ index: 0 }), null, 'no extension, no matrix');
  assert.equal(uvMatrix({ extensions: { KHR_texture_transform: { offset: [0, 0], scale: [1, 1] } } }), null,
    'an identity placement is still no placement');
});

test('a webp texture is found through the extension that hides it', () => {
  const gltf = read(PLAYER);
  assert.equal(gltf.json.textures[0].source, undefined, 'the texture has no source of its own');
  assert.equal(gltf.textureSource(0), 0, 'and the extension says which image it is');

  const texture = gltf.textureBytes(0);
  assert.ok(texture, 'the base colour is there to be decoded');
  assert.equal(texture.mimeType, 'image/webp');
  assert.equal(String.fromCharCode(...texture.bytes.subarray(0, 4)), 'RIFF', 'the bytes are a webp');
  assert.equal(String.fromCharCode(...texture.bytes.subarray(8, 12)), 'WEBP');
  assert.ok(texture.bytes.length > 100000, `${texture.bytes.length} bytes of it`);
  assert.equal(gltf.textureSource(99), -1, 'a texture that is not there is -1 rather than a throw');
});

test('the figure has no skeleton in it, and says so rather than pretending', () => {
  const gltf = read(PLAYER);
  assert.equal(gltf.skins.length, 0, 'no skin');
  assert.equal(gltf.clips().length, 0, 'no animation');
  // So whatever walks it has to be walked by the game, not by the file: this is the fact the player's body
  // is built around, and a loader that invented a rig would hide it.
  assert.equal(gltf.nodes.length, 2, 'a node with a mesh on it and the node that holds it');
});

// ----------------------------------------------------------------------- the packs already walking

test('a pack stored as floats is handed over untouched', () => {
  const gltf = read('web/assets/models/kaykit-adventures/Barbarian.glb');
  const drawn = gltf.primitives().find((p) => p.prim.attributes.POSITION !== undefined);
  const stored = gltf.attribute(drawn.prim, 'POSITION');
  const geometry = gltf.geometry(drawn.prim, 'POSITION');

  assert.ok(stored.array instanceof Float32Array, 'this pack stores floats');
  assert.deepEqual(geometry.array, stored.array, 'and the reader converts nothing, so five characters are unchanged');
  assert.ok(gltf.skins.length > 0, 'a rigged character, unlike the uploaded figure');
  assert.ok(gltf.clips().length > 0 || gltf.json.animations === undefined, 'clips come from the animation pack');
  assert.equal(uvMatrix(gltf.materials[0]?.pbrMetallicRoughness?.baseColorTexture), null,
    'and its texture is placed where it was authored');
});

// ------------------------------------------------------------------------------------ what is refused

test('an extension that changes the bytes is refused, and one that does not is not', () => {
  // Refused: the geometry would have to be decoded, and drawing it undecoded is drawing the wrong thing.
  assert.throws(() => parseGLB(glbOf({ extensionsRequired: ['KHR_draco_mesh_compression'] })),
    /KHR_draco_mesh_compression is not read/, 'a Draco-compressed file was read rather than refused');
  assert.throws(() => parseGLB(glbOf({ extensionsRequired: ['EXT_meshopt_compression'] })),
    /EXT_meshopt_compression is not read/);

  // Read: these three are handled, and materials are shading, which is not this reader's business.
  for (const ext of ['KHR_mesh_quantization', 'KHR_texture_transform', 'EXT_texture_webp', 'KHR_materials_unlit']) {
    assert.doesNotThrow(() => parseGLB(glbOf({ extensionsRequired: [ext] })), `${ext} should be read`);
  }
  // And the file the player is made of requires two of them at once.
  assert.doesNotThrow(() => parseGLB(glbOf({ extensionsRequired: ['KHR_mesh_quantization', 'EXT_texture_webp'] })));

  // The check itself is the thing that was broken: it read `requiredExtensions`, which is not a glTF
  // field, so nothing was ever refused. A misspelling in a guard is a guard that is not there.
  assert.doesNotThrow(() => parseGLB(glbOf({ requiredExtensions: ['KHR_draco_mesh_compression'] })),
    'a field glTF does not have is not a requirement');
});
