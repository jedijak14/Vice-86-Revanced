// The cast: the people who walk on the pavements, made from rigged models rather than from boxes.
//
// What is here is the seam between three things that must not know about each other:
//
//   * the vendored packs (web/assets/models/, put there by tools/vendor_models.py, whose manifest this
//     reads before it fetches anything, so a file that is not accounted for is not loaded);
//   * the animation clips, which are authored against KayKit's `Rig_Medium` skeleton and have to be
//     re-pointed at each character's own node indices by bone *name* -- the characters carry 41 joints,
//     the clips 23, and the extra ones are IK and control bones that no clip touches;
//   * the renderer, which wants one interleaved mesh per drawn thing and has no idea that it is being
//     re-uploaded every frame.
//
// A person is therefore: a mesh handle whose vertices are rewritten from the rig each frame, one dynamic
// object carrying where they stand, and a Player (core/animate.js) carrying what they are doing.

import { Gltf } from '../../core/gltf.js';
import { Rig, Player, createPose } from '../../core/animate.js';
import { MeshBuilder } from '../../core/mesh.js';
import { swimClips } from '../../core/swimclip.js';
import { FAMILY, VEHICLE, VERTEX_STRIDE } from '../../core/ids.js';

/** Where the parts come from. Both packs are CC0; see docs/ASSETS.md for the receipts. */
export const CHARACTER_PACK = 'kaykit-adventures';
export const ANIMATION_PACK = 'kaykit-animation';
export const CHARACTERS = Object.freeze(['Barbarian', 'Knight', 'Mage', 'Rogue', 'Rogue_Hooded']);
export const ANIMATION_FILES = Object.freeze([
  'Rig_Medium_General', 'Rig_Medium_MovementBasic', 'Rig_Medium_MovementAdvanced',
  'Rig_Medium_CombatRanged', 'Rig_Medium_Simulation',
]);

/**
 * What a pedestrian is wearing, as a multiply on the colours their model was painted with: a hooded
 * rogue in teal and the same rogue in cream are two people at a glance across a street, which is the
 * whole job. `weight` is how much of the tint to apply, so skin and hair stay their own colour.
 */
export const WARDROBE = Object.freeze([
  { id: 'street', tint: [0x2f, 0x6f, 0x8f], weight: 0.55 },
  { id: 'heat', tint: [0xe0, 0x6a, 0x86], weight: 0.5 },
  { id: 'sand', tint: [0xd8, 0xd3, 0xc4], weight: 0.45 },
  { id: 'night', tint: [0x24, 0x26, 0x2c], weight: 0.6 },
  { id: 'dock', tint: [0x4a, 0x5a, 0x6a], weight: 0.55 },
  { id: 'citrus', tint: [0xf2, 0xb2, 0x3c], weight: 0.5 },
]);

/** Props a character file carries in its hands, which a person only picks up on purpose. */
const HELD = /(knife|sword|axe|crossbow|bow|shield|quiver|mug|staff|wand|spellbook|throwable|flask|torch|bomb)/i;

/** What the game means when it says "walk": the clip, and how far one cycle of it is worth. */
export const ROLES = Object.freeze({
  idle: { clip: 'Idle_A', stride: 0 },
  walk: { clip: 'Walking_A', stride: 1.34 },
  back: { clip: 'Walking_Backwards', stride: 1.2 },
  run: { clip: 'Running_A', stride: 2.35 },
  sneak: { clip: 'Sneaking', stride: 0.7 },
  aim: { clip: 'Ranged_1H_Aiming', stride: 0 },
  shoot: { clip: 'Ranged_1H_Shoot', stride: 0 },
  reload: { clip: 'Ranged_1H_Reload', stride: 0 },
  interact: { clip: 'Interact', stride: 0 },
  grab: { clip: 'PickUp', stride: 0 },
  use: { clip: 'Use_Item', stride: 0 },
  wave: { clip: 'Waving', stride: 0 },
  cheer: { clip: 'Cheering', stride: 0 },
  throw: { clip: 'Throw', stride: 0 },
  startle: { clip: 'Hit_A', stride: 0 },
  struck: { clip: 'Hit_B', stride: 0 },
  down: { clip: 'Death_A', stride: 0 },
  lie: { clip: 'Lie_Idle', stride: 0 },
  sit: { clip: 'Sit_Chair_Idle', stride: 0 },
  sitdown: { clip: 'Sit_Chair_Down', stride: 0 },
  standup: { clip: 'Sit_Chair_StandUp', stride: 0 },
  swim: { clip: 'Swim_Free', stride: 1.9 },
  tread: { clip: 'Swim_Tread', stride: 0 },
  aim2: { clip: 'Ranged_2H_Aiming', stride: 0 },
  shoot2: { clip: 'Ranged_2H_Shoot', stride: 0 },
  reload2: { clip: 'Ranged_2H_Reload', stride: 0 },
});

const url = (pack, name) => `assets/models/${pack}/${name}.glb`;

/**
 * The manifest the vendor tool wrote: what is here, what it weighs, and under what licence.
 *
 * `fetchFile(path)` resolves to an ArrayBuffer for every kind of file, model or JSON, so one injection
 * point covers both and the page's `fetch().arrayBuffer()` is the whole of the implementation.
 */
export async function loadAssetManifest(fetchFile) {
  try {
    const doc = JSON.parse(new TextDecoder().decode(await fetchFile('assets/models/manifest.json')));
    return { ok: true, ...doc, byPack: new Map((doc.packs || []).map((p) => [p.pack, p])) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), packs: [], byPack: new Map(), totalBytes: 0 };
  }
}

/**
 * Everything the street needs to be populated: five rigged characters and one shared library of clips.
 *
 * `fetchFile(path)` returns an ArrayBuffer; `decodeImage(bytes)` returns a promise for
 * `{ width, height, data }` of an RGBA8 image, or null when the caller cannot decode (a Node test, a
 * worker), in which case the model's own flat colour is used and the texture is ignored. The browser's
 * implementation is createImageBitmap plus one canvas readback, done once per character.
 */
export async function loadCast({ fetchFile, decodeImage = null, only = CHARACTERS, budget = 8 * 1024 * 1024 } = {}) {
  const manifest = await loadAssetManifest(fetchFile);
  if (!manifest.ok) throw new Error(`Cast: the asset manifest at assets/models/manifest.json could not be read (${manifest.error}). Run tools/vendor_models.py --fetch.`);
  const want = new Set(only);
  const characters = [];
  const clips = [];
  let bytes = 0;
  // `local` in the manifest already begins with the pack directory, which is the same shape as the path
  // this fetches, so the two can be compared exactly.
  const listed = new Set();
  for (const pack of manifest.packs || []) for (const f of pack.files || []) listed.add(f);

  const fetchAccounted = async (pack, name) => {
    const path = url(pack, name);
    const key = path.replace('assets/models/', '');
    if (pack === CHARACTER_PACK || pack === ANIMATION_PACK) {
      // The manifest is the licence check as well as the byte count: a file nobody listed is a file nobody
      // vouched for, and fetching it would put unlicensed bytes on the screen.
      if (!listed.has(key)) throw new Error(`Cast: ${key} is not in the asset manifest, so it will not be loaded.`);
    }
    const buffer = await fetchFile(path);
    bytes += buffer.byteLength;
    if (bytes > budget) throw new Error(`Cast: the model library passed ${(budget / 1e6).toFixed(1)} MB of download (${(bytes / 1e6).toFixed(1)} MB so far). Trim CHARACTERS or raise the budget on purpose.`);
    return buffer;
  };

  for (const name of ANIMATION_FILES) {
    const gltf = new Gltf(await fetchAccounted(ANIMATION_PACK, name));
    const names = gltf.nodes.map((n) => n.name || '');
    for (const clip of gltf.clips()) {
      clip.sourceNodes = names;                     // so retargetClips can re-point it at a character by name
      clips.push(clip);
    }
  }
  if (!clips.length) throw new Error('Cast: no animation clips were found in the vendored packs.');
  // The water: no licence we can reach carries a swimming clip, so the stroke is synthesised (see
  // core/swimclip.js) and joins the shelf here, retargeted by the same names as everything vendored.
  for (const clip of swimClips()) clips.push(clip);

  for (const name of only) {
    if (!want.has(name)) continue;
    const gltf = new Gltf(await fetchAccounted(CHARACTER_PACK, name));
    const rig = new Rig(gltf, 0);
    characters.push(await buildCharacter(name, gltf, rig, decodeImage));
  }
  if (!characters.length) throw new Error('Cast: no characters could be built from the vendored packs.');
  return { characters, clips, bytes, manifest, licences: (manifest.packs || []).map((p) => `${p.pack}: ${p.licence}`) };
}

/**
 * One character, read into the arrays a person is made from: a merged, weighted vertex soup in the
 * renderer's own layout, the rig that moves it, and the clips re-pointed at its bone indices.
 */
async function buildCharacter(name, gltf, rig, decodeImage) {
  const texture = decodeImage ? await readTexture(gltf, decodeImage) : null;
  // Where each node sits at bind pose, so a hat on a head bone and a cape on a chest bone can be moved
  // into the body's space. A skinned mesh's own node transform is ignored, as every other glTF runtime
  // ignores it: the skinning matrices already carry the skeleton, and double-applying it is how a
  // character ends up floating half a metre above their own feet.
  const worlds = gltf.worldMatrices();
  let bodyBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const positions = [], normals = [], colors = [], joints = [], weights = [], tris = [];
  let tint = [1, 1, 1];
  for (const { node, skin, prim } of gltf.primitives()) {
    if (HELD.test(gltf.nodes[node]?.name || '') && skin === undefined) continue;      // a weapon in a hand, unless asked for
    const nodeName = gltf.nodes[node]?.name || '';
    if (HELD.test(nodeName)) continue;
    const skinned = skin !== undefined && skin !== null;
    const pos = gltf.attribute(prim, 'POSITION');
    if (!pos) continue;
    const nrm = gltf.attribute(prim, 'NORMAL');
    const uv = gltf.attribute(prim, 'TEXCOORD_0');
    const jointStream = gltf.attribute(prim, 'JOINTS_0');
    const weightStream = gltf.attribute(prim, 'WEIGHTS_0');
    const material = gltf.materials[prim.material] || {};
    if (material.baseColorFactor) tint = material.baseColorFactor.slice(0, 3);
    // A rigid piece (a hood on a head bone, a badge on a chest) becomes a one-influence skin weight,
    // which is how it follows the bone without any second code path for "rigid attachment".
    const rigid = !skinned;
    const rigidBone = rigid ? boneOfNode(gltf, node, rig) : -1;
    const base = positions.length / 3;
    // The node matrix of a skinned mesh is applied to the base positions, as the glTF spec applies it
    // to the skinned result: for the packs, whose skinned nodes are identity, this changes nothing, and
    // for a quantized figure it is the only place its metre lives.
    const m = worlds.subarray(node * 16, node * 16 + 16);
    const p = [0, 0, 0], d = [0, 0, 0];
    for (let v = 0; v < pos.count; v++) {
      if (m) {
        transformPointInto(m, 0, pos.array[v * 3], pos.array[v * 3 + 1], pos.array[v * 3 + 2], p);
        transformDirInto(m, 0, nrm ? nrm.array[v * 3] : 0, nrm ? nrm.array[v * 3 + 1] : 1, nrm ? nrm.array[v * 3 + 2] : 0, d);
      } else {
        p[0] = pos.array[v * 3]; p[1] = pos.array[v * 3 + 1]; p[2] = pos.array[v * 3 + 2];
        d[0] = nrm ? nrm.array[v * 3] : 0; d[1] = nrm ? nrm.array[v * 3 + 1] : 1; d[2] = nrm ? nrm.array[v * 3 + 2] : 0;
      }
      if (skinned) bodyBounds = growBounds(bodyBounds, p);
      positions.push(p[0], p[1], p[2]);
      normals.push(d[0], d[1], d[2]);
      const rgb = texture && uv ? texture.sample(uv.array[v * 2], uv.array[v * 2 + 1], tint) : [tint[0] * 255, tint[1] * 255, tint[2] * 255];
      colors.push(rgb[0], rgb[1], rgb[2]);
      if (jointStream && weightStream) {
        for (let k = 0; k < 4; k++) { joints.push(jointStream.array[v * 4 + k]); weights.push(weightStream.array[v * 4 + k]); }
      } else {
        joints.push(Math.max(0, rigidBone), 0, 0, 0);
        weights.push(255, 0, 0, 0);
      }
    }
    const indices = prim.indices !== undefined ? gltf.accessor(prim.indices).array : null;
    const count = indices ? indices.length : pos.count;
    for (let i = 0; i < count; i += 3) {
      const a = indices ? indices[i] : i, b = indices ? indices[i + 1] : i + 1, c = indices ? indices[i + 2] : i + 2;
      tris.push(base + a, base + b, base + c);
    }
  }
  const bounds = boundsOf(positions);
  // The packs are not authored to the same metre, and a pointy hat is not a reason to shrink a person:
  // the height a figure is scaled by comes from the skinned body only, so headwear, capes and a staff in
  // the hand ride along at the size the body's proportions imply.
  const authored = Math.max(0.2, bodyBounds[4] - bodyBounds[1]);
  return {
    name, gltf, rig, texture, positions: new Float32Array(positions), normals: new Float32Array(normals),
    colors, joints: new Uint8Array(joints), weights: new Uint8Array(weights), triangles: Int32Array.from(tris),
    vertexCount: positions.length / 3, bounds, authored, bodyHeight: authored, heightScale: 1,
  };
}

/** The joint a rigid node hangs off -- the nearest ancestor that is a skin joint, which is where a hood lives. */
function boneOfNode(gltf, nodeIndex, rig) {
  let i = nodeIndex;
  for (let hop = 0; hop < 32 && i >= 0; hop++) {
    const joint = rig.joints.indexOf(i);
    if (joint >= 0) return joint;
    i = rig.parents[i];
  }
  return rig.node('hips') >= 0 ? rig.joints.indexOf(rig.node('hips')) : 0;
}

function growBounds(b, p) {
  for (let k = 0; k < 3; k++) { if (p[k] < b[k]) b[k] = p[k]; if (p[k] > b[k + 3]) b[k + 3] = p[k]; }
  return b;
}

function boundsOf(positions) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < b[k]) b[k] = v;
      if (v > b[k + 3]) b[k + 3] = v;
    }
  }
  return b;
}

/** The model's base-colour image, decoded once and sampled per vertex. */
async function readTexture(gltf, decodeImage) {
  const im = gltf.images.find(() => true);
  if (!im) return null;
  const bytes = gltf.imageBytes(0);
  if (!bytes) return null;
  const image = await decodeImage(bytes);
  if (!image || !image.width) return null;
  const { width, height, data } = image;
  return {
    sample(u, v, tint) {
      const x = Math.min(width - 1, Math.max(0, Math.round(u * width - 0.5)));
      const y = Math.min(height - 1, Math.max(0, Math.round((1 - v) * height - 0.5)));   // glTF v runs up
      const o = (y * width + x) * 4;
      const r = data[o] / 255, g = data[o + 1] / 255, b = data[o + 2] / 255;
      return [Math.min(255, Math.round(r * tint[0] * 255)), Math.min(255, Math.round(g * tint[1] * 255)), Math.min(255, Math.round(b * tint[2] * 255))];
    },
  };
}

/** A character's clips, with their channels re-pointed at this rig by bone name. */
export function retargetClips(cast, character) {
  const rig = character.rig;
  const out = [];
  const seen = new Set();
  for (const clip of cast.clips) {
    if (seen.has(clip.name)) continue;
    seen.add(clip.name);
    const channels = [];
    for (const ch of clip.channels) {
      // A vendored channel names its bone by index into the file it came from; a synthesised one (see
      // core/swimclip.js) carries the name itself, having no file to point at.
      const name = ch.name !== undefined ? ch.name : clip.sourceNodes?.[ch.node];
      if (!name) continue;
      const node = rig.node(name);
      if (node < 0) continue;                                  // an IK or control bone: no clip on it
      channels.push({ ...ch, node });
    }
    if (channels.length) out.push({ name: clip.name, duration: clip.duration, channels });
  }
  return out;
}

/**
 * A person: the mesh, the rig, the clock. `renderer.refreshMesh` is what pushes one frame of skinning
 * into the buffer the renderer already owns.
 */
export function newPerson(renderer, cast, character, { height = 1.78, wardrobe = WARDROBE[0], seed = 0 } = {}) {
  const build = buildMeshData(character, wardrobe);
  const handle = renderer.createMesh(build.data, { retain: true });
  const dynamic = renderer.addDynamic({ mesh: handle, castShadow: true });
  const player = new Player(character.rig, createPose(character.gltf), retargetClips(cast, character));
  const n = build.vertexCount;
  const heightScale = height / character.authored;
  return {
    handle, dynamic, player, character,
    position: new Float32Array(3),
    yaw: 0,
    /** The frame's skinning: the rig is solved, the vertices follow, the buffer is re-uploaded. */
    frame(dt = 0, metres = 0) {
      player.update(dt, metres);
      player.solve(heightScale);
      writeVertices(build, character, heightScale);
      renderer.refreshMesh(handle);
    },
    place(x, y, z, yaw = 0) {
      this.position[0] = x; this.position[1] = y; this.position[2] = z; this.yaw = yaw;
      const m = dynamic.matrix;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      m[0] = c; m[1] = 0; m[2] = -s; m[3] = 0;
      m[4] = 0; m[5] = 1; m[6] = 0; m[7] = 0;
      m[8] = s; m[9] = 0; m[10] = c; m[11] = 0;
      m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
      return this;
    },
    role(name, { once = false, upper = false } = {}) {
      const spec = ROLES[name] || (name && name !== 'none' ? { clip: name, stride: 0 } : null);
      if (!spec) { player.play(null); player.clearLayer(); return this; }
      const clip = player.has(spec.clip) ? spec.clip : (player.has('Idle_A') ? 'Idle_A' : null);
      if (upper) player.layer(clip, player.upperBody(), { once, restart: once });
      else player.play(clip, { stride: spec.stride, restart: once });
      return this;
    },
    visible(on) { this.dynamic.visible = !!on; return this; },
    remove() { dynamic.remove(); renderer.destroyMesh(handle); },
    stats: { vertices: n, triangles: build.triangleCount, seed },
  };
}

/** The rest-pose mesh, in the renderer's interleaved layout, with the character's painted colours. */
function buildMeshData(character, wardrobe) {
  const b = new MeshBuilder(character.vertexCount);
  const tint = wardrobe ? wardrobe.tint : null, weight = wardrobe ? wardrobe.weight : 0;
  b.family(FAMILY.VEHICLE).material(VEHICLE.TRIM_BLACK, Math.round(0.92 * 255), 0, 0);
  const { positions, colors, triangles } = character;
  for (let v = 0; v < character.vertexCount; v++) {
    let r = colors[v * 3] / 255, g = colors[v * 3 + 1] / 255, bl = colors[v * 3 + 2] / 255;
    if (tint) {
      r = r * (1 - weight) + (tint[0] / 255) * weight * r * 2;
      g = g * (1 - weight) + (tint[1] / 255) * weight * g * 2;
      bl = bl * (1 - weight) + (tint[2] / 255) * weight * bl * 2;
    }
    b.vertex(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2],
      character.normals[v * 3], character.normals[v * 3 + 1], character.normals[v * 3 + 2], 0, 0);
    b.color(Math.min(1, r), Math.min(1, g), Math.min(1, bl));
  }
  for (let i = 0; i < triangles.length; i += 3) b.tri(triangles[i], triangles[i + 1], triangles[i + 2]);
  return {
    data: b.finish(), vertexCount: character.vertexCount, triangleCount: triangles.length / 3,
    // Scratch for this frame's skinning, allocated once per person and never again.
    skinned: new Float32Array(character.vertexCount * 3),
    skinnedNormal: new Float32Array(character.vertexCount * 3),
  };
}

/**
 * Skin this frame into the buffer the renderer uploaded. Positions are float, normals are signed 16-bit
 * normalized, both inside one 36-byte vertex, so the whole mesh is written in two passes over typed
 * array views of the same ArrayBuffer.
 */
function writeVertices(build, character, scale) {
  const buf = build.data.vertices;
  const f32 = new Float32Array(buf);
  const i16 = new Int16Array(buf);
  const out = build.skinned, outN = build.skinnedNormal;
  skinInto(character, build, scale, out, outN);
  const strideF = VERTEX_STRIDE / 4, strideS = VERTEX_STRIDE / 2;
  for (let v = 0; v < character.vertexCount; v++) {
    const o = v * strideF;
    f32[o] = out[v * 3]; f32[o + 1] = out[v * 3 + 1]; f32[o + 2] = out[v * 3 + 2];
    const n = v * strideS + 6;
    i16[n] = Math.round(Math.max(-1, Math.min(1, outN[v * 3])) * 32767);
    i16[n + 1] = Math.round(Math.max(-1, Math.min(1, outN[v * 3 + 1])) * 32767);
    i16[n + 2] = Math.round(Math.max(-1, Math.min(1, outN[v * 3 + 2])) * 32767);
    i16[n + 3] = 0;
  }
  return build;
}

/** The skinning itself, kept apart because the Node tests run it directly, without a renderer. */
export function skinInto(character, build, scale, outPosition, outNormal) {
  const { rig } = character;
  const bones = rig.bones;
  const pos = character.positions, nrm = character.normals, joints = character.joints, weights = character.weights;
  const p = [0, 0, 0], d = [0, 0, 0];
  for (let v = 0; v < character.vertexCount; v++) {
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k] / 255;
      if (w <= 0) continue;
      const o = joints[v * 4 + k] * 16;
      transformPointInto(bones, o, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2], p);
      transformDirInto(bones, o, nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2], d);
      x += p[0] * w; y += p[1] * w; z += p[2] * w;
      nx += d[0] * w; ny += d[1] * w; nz += d[2] * w;
      sum += w;
    }
    if (sum <= 0) { outPosition[v * 3] = pos[v * 3] * scale; outPosition[v * 3 + 1] = pos[v * 3 + 1] * scale; outPosition[v * 3 + 2] = pos[v * 3 + 2] * scale; outNormal[v * 3] = nrm[v * 3]; outNormal[v * 3 + 1] = nrm[v * 3 + 1]; outNormal[v * 3 + 2] = nrm[v * 3 + 2]; continue; }
    const inv = 1 / sum;
    outPosition[v * 3] = x * inv * scale; outPosition[v * 3 + 1] = y * inv * scale; outPosition[v * 3 + 2] = z * inv * scale;
    const len = Math.hypot(nx * inv, ny * inv, nz * inv) || 1;
    outNormal[v * 3] = nx * inv / len; outNormal[v * 3 + 1] = ny * inv / len; outNormal[v * 3 + 2] = nz * inv / len;
  }
  return outPosition;
}

// Written out long, in the file that runs every frame for every person on screen.
function transformPointInto(m, o, x, y, z, out) {
  out[0] = m[o] * x + m[o + 4] * y + m[o + 8] * z + m[o + 12];
  out[1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z + m[o + 13];
  out[2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z + m[o + 14];
  return out;
}
function transformDirInto(m, o, x, y, z, out) {
  out[0] = m[o] * x + m[o + 4] * y + m[o + 8] * z;
  out[1] = m[o + 1] * x + m[o + 5] * y + m[o + 9] * z;
  out[2] = m[o + 2] * x + m[o + 6] * y + m[o + 10] * z;
  return out;
}
