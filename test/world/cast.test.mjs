// The cast, against the real vendored files: the loader, the retarget, and the skinning.
//
// These read web/assets/models/**, which is what the browser will fetch, so a pack that moved, a clip
// renamed upstream, or a manifest that no longer matches the bytes on disk fails here rather than showing
// up as an empty pavement. No GL and no DOM are involved: buildMeshData and skinInto are pure.

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { Gltf } from '../../web/src/core/gltf.js';
import { Rig, Player, createPose, sampleClip, resetPose } from '../../web/src/core/animate.js';
import { loadCast, retargetClips, skinInto, ROLES, CHARACTERS, CHARACTER_PACK, WARDROBE } from '../../web/src/world/people/cast.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const fetchFile = async (rel) => (await readFile(path.join(root, 'web', rel))).buffer;
const readJSON = async (rel) => JSON.parse(await readFile(path.join(root, 'web', rel), 'utf8'));

test('a GLB parses into the parts the game needs', async () => {
  const gltf = new Gltf(await fetchFile(`assets/models/${CHARACTER_PACK}/Rogue.glb`));
  assert.equal(gltf.skins.length, 1, 'one skin, the character');
  assert.ok(gltf.json.accessors.length > 10);
  assert.ok(gltf.meshes.length >= 4, 'a body, a head, arms and legs are separate meshes in the pack');
  const prim = gltf.primitives().find((p) => p.skin !== null && p.skin !== undefined);
  assert.ok(prim, 'at least one skinned primitive');
  const pos = gltf.attribute(prim.prim, 'POSITION');
  assert.ok(pos.count > 50);
  const joints = gltf.attribute(prim.prim, 'JOINTS_0');
  assert.ok(joints, 'the pack weights its vertices');
  assert.equal(joints.components, 4);
});

test('the clip library is complete enough to move a person through a street', async () => {
  const cast = await loadCast({ fetchFile, only: ['Rogue'] });
  const names = new Set(cast.clips.map((c) => c.name));
  for (const role of Object.values(ROLES)) {
    assert.ok(names.has(role.clip), `the game asks for "${role.clip}" and the vendored clips do not have it`);
  }
  assert.ok(names.size > 40, `${names.size} clips is too few for a street: walk, run, aim, shoot, hit, die, sit`);
  for (const clip of cast.clips) {
    assert.ok(clip.duration > 0, `${clip.name} has no length`);
    assert.ok(clip.channels.length > 0, `${clip.name} moves nothing`);
  }
});

test('the manifest is the gate: an unlisted file is not loaded', async () => {
  const manifest = await readJSON('assets/models/manifest.json');
  assert.ok(manifest.packs.length >= 2, 'both packs are accounted for');
  for (const pack of manifest.packs) {
    assert.ok(pack.licence, `${pack.pack} has no recorded licence`);
    assert.ok(pack.files.length > 0);
    const detail = await readJSON(`assets/models/${pack.pack}/manifest.json`);
    assert.equal(detail.totalBytes, pack.bytes, `${pack.pack}: the two manifests disagree about size`);
  }
  const bytes = manifest.packs.reduce((sum, p) => sum + p.bytes, 0);
  assert.ok(bytes < 8e6, `the model library is ${(bytes / 1e6).toFixed(1)} MB, which is more than a page should download for pedestrians`);
  await assert.rejects(
    () => loadCast({ fetchFile, only: ['NobodyFromAnUnlistedFile'] }),
    /not in the asset manifest|ENOENT/,
    'a name nobody vouched for has to be refused or missing, not silently fetched',
  );
});

test('clips are re-pointed by bone name, and every role lands on bones', async () => {
  const cast = await loadCast({ fetchFile, only: ['Rogue'] });
  const character = cast.characters[0];
  const retargeted = retargetClips(cast, character);
  const byName = new Map(retargeted.map((c) => [c.name, c]));
  for (const role of Object.values(ROLES)) {
    const clip = byName.get(role.clip);
    assert.ok(clip, `${role.clip} survived retargeting with no channels`);
    assert.ok(clip.channels.length >= 6, `${role.clip} moves ${clip.channels.length} bones: that is not a walk`);
    const nodes = new Set(clip.channels.map((c) => c.node));
    for (const n of nodes) assert.ok(n >= 0 && n < character.gltf.nodes.length, 'a channel points outside the character');
  }
  // The pack has IK and control bones the clips never touch; the point of matching by name is that the
  // 41-joint character still takes the 23-bone clip.
  assert.ok(character.rig.joints.length > 23, 'the character carries more joints than the clips name');
});

test('a rest pose skins to itself, and a walk does not', async () => {
  const cast = await loadCast({ fetchFile, only: ['Rogue'] });
  const character = cast.characters[0];
  const clips = retargetClips(cast, character);
  const player = new Player(character.rig, createPose(character.gltf), clips);

  const out = new Float32Array(character.vertexCount * 3);
  const outN = new Float32Array(character.vertexCount * 3);
  const walk = () => { player.solve(1); skinInto(character, {}, 1, out, outN); return Float64Array.from(out); };

  const rest = walk();
  let maxDrift = 0;
  for (let i = 0; i < rest.length; i++) maxDrift = Math.max(maxDrift, Math.abs(rest[i] - character.positions[i]));
  assert.ok(maxDrift < 5e-3, `the bind pose moved the mesh by ${maxDrift.toFixed(4)} m, so the bind matrices are wrong`);
  for (let v = 0; v < character.vertexCount; v++) {
    const len = Math.hypot(outN[v * 3], outN[v * 3 + 1], outN[v * 3 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-3 || len === 0, 'normals come out of skinning unit length');
  }

  player.play('Walking_A', { stride: 1.34, restart: true });
  player.update(0.25, 0.34);
  const mid = walk();
  let moved = 0;
  for (let v = 0; v < character.vertexCount; v++) {
    moved = Math.max(moved, Math.hypot(mid[v * 3] - rest[v * 3], mid[v * 3 + 2] - rest[v * 3 + 2]));
  }
  assert.ok(moved > 0.03, `a walk cycle moved the furthest vertex only ${moved.toFixed(4)} m`);
  assert.ok(moved < 1.2, `the walk threw a vertex ${moved.toFixed(2)} m across the body: a broken retarget, not a stride`);

  // The clip clock is driven by metres, so a person who does not move does not animate -- and a person
  // who moves twice as far does. That is the whole anti-slide rule, and it has to hold.
  // Standing at the start of the cycle is not the bind pose -- a walk's first frame has the legs apart
  // and the hips low -- so the invariant is periodic: one stride of ground is exactly one cycle of the
  // clip, and half a stride is mid-cycle.
  const at = (metres) => {
    const p = new Player(character.rig, createPose(character.gltf), clips).play('Walking_A', { stride: 1.34, restart: true });
    p.update(0.5, metres);
    p.solve(1);
    skinInto(character, {}, 1, out, outN);
    return Float64Array.from(out);
  };
  const diff = (a, b) => { let d = 0; for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k] - b[k])); return d; };
  const a0 = at(0), aHalf = at(0.67), aFull = at(1.34), aAgain = at(0);
  assert.ok(diff(a0, aAgain) < 1e-6, 'the same playhead produced two different poses');
  assert.ok(diff(aHalf, a0) > 1e-2, `half a stride changed the rig by ${diff(aHalf, a0).toFixed(4)} m: the clip is not driven by distance`);
  assert.ok(diff(aFull, a0) < 1e-2, `a full stride left the cycle ${diff(aFull, a0).toFixed(4)} m out of itself: stride and clip length disagree`);
});

test('the figure is scaled to a metre that means something, and one cycle covers its stride', async () => {
  const cast = await loadCast({ fetchFile, only: CHARACTERS });
  for (const character of cast.characters) {
    // The body, not the hat: bounds cover every vertex the mesh carries, authored is the skinned figure.
    const tall = character.authored;
    assert.ok(tall > 1.9 && tall < 2.5, `${character.name}'s body is authored ${tall.toFixed(2)} m tall, and the cast should be one scale`);
    assert.ok(character.bounds[4] - character.bounds[1] >= tall, `${character.name}'s body is taller than the mesh that carries it`);
    assert.equal(Math.round(character.authored * 100) / 100, Math.round(character.bodyHeight * 100) / 100);
    assert.equal(character.rig.joints.length > 20, true, `${character.name} has too few joints to be a person`);
    assert.ok(character.vertexCount > 300 && character.vertexCount < 20000, `${character.name} has ${character.vertexCount} vertices`);
    assert.ok(character.triangles.length % 3 === 0);
  }
  // The same clips play on all of them, which is the point of one shared skeleton.
  const rogue = cast.characters.find((c) => c.name === 'Rogue');
  const knight = cast.characters.find((c) => c.name === 'Knight');
  const a = retargetClips(cast, rogue).map((c) => c.name).sort();
  const b = retargetClips(cast, knight).map((c) => c.name).sort();
  assert.deepEqual(a, b, 'the cast cannot share a clip library, so each character would need its own animations');
  assert.ok(a.length > 40);
  assert.ok(WARDROBE.length >= 4, 'a crowd of one tint is a queue, not a crowd');
});
