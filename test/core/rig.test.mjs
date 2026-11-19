// The figure the project owner uploaded arrives with no skeleton and no animation: a statue. This test
// holds the rig that tools/rig_player.py gives it to the promise made when it was shaped into an
// A-pose: 23 joints wearing KayKit's names, four influences a vertex, a rest that skins to itself, and
// -- the one that matters -- the vendored clips meaning on this figure what they mean on the pack they
// came from, which is checked by playing the T-Pose clip through the rest correction and looking at
// where the arms end up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Gltf } from '../../web/src/core/gltf.js';
import { Rig, resetPose, sampleClip, skinVertices, bakeClipForRest } from '../../web/src/core/animate.js';

const RIGGED = 'web/assets/models/player/rigged.glb';
const REFERENCE = 'web/assets/models/kaykit-animation/Rig_Medium_General.glb';

const load = (path) => {
  const b = readFileSync(new URL(`../../${path}`, import.meta.url));
  return new Gltf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const rigJson = JSON.parse(readFileSync(new URL('../../web/assets/models/player/rig.json', import.meta.url)));

const quatMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** The clips of the animation pack, read the way cast.js reads them: channels keyed by bone name. */
function clipsOf(gltf) {
  const out = [];
  for (const anim of gltf.json.animations || []) {
    const clip = { name: anim.name, duration: 0, channels: [] };
    for (const ch of anim.channels) {
      const name = gltf.json.nodes[ch.target.node]?.name;
      if (!name) continue;
      const sampler = anim.samplers[ch.sampler];
      const input = gltf.accessor(sampler.input).array;
      const output = gltf.accessor(sampler.output);
      clip.duration = Math.max(clip.duration, input[input.length - 1]);
      clip.channels.push({ name, path: ch.target.path, input, output: { array: output.array, components: output.components } });
    }
    if (clip.channels.length) out.push(clip);
  }
  return out;
}

/** One frame of a reference clip on our rig: re-pointed by bone name, baked onto our rest, sampled. */
function posedRig(rig, gltf, clip, time) {
  const named = {
    ...clip,
    channels: clip.channels
      .map((ch) => ({ ...ch, node: rig.node(ch.name) }))
      .filter((ch) => ch.node >= 0),
  };
  const baked = bakeClipForRest(named, rigJson.bones, rig);
  const pose = resetPose(gltf, {
    count: gltf.nodes.length,
    translation: new Float32Array(gltf.nodes.length * 3),
    rotation: new Float32Array(gltf.nodes.length * 4),
    scale: new Float32Array(gltf.nodes.length * 3),
    touched: new Set(),
  });
  sampleClip(baked, time, pose);
  return rig.solve(pose);
}

/** Where a joint ended up, in the figure's own metres: the node world matrices solve() leaves behind. */
const worldOf = (rig, name) => {
  const i = rig.node(name);
  return [rig.worlds[i * 16 + 12], rig.worlds[i * 16 + 13], rig.worlds[i * 16 + 14]];
};

test('the shaped figure carries a skin of 23 joints in KayKit names, four influences a vertex', () => {
  const gltf = load(RIGGED);
  const rig = new Rig(gltf, 0);
  assert.equal(rig.joints.length, 23);
  const names = rig.joints.map((i) => gltf.nodes[i].name);
  for (const want of ['hips', 'spine', 'chest', 'head', 'upperarm.l', 'lowerarm.r', 'wrist.l', 'hand.r', 'upperleg.l', 'foot.r', 'toes.l']) {
    assert.ok(names.includes(want), `missing bone ${want}`);
  }
  const prim = [...gltf.primitives()][0].prim;
  const J = gltf.attribute(prim, 'JOINTS_0').array;      // cast.js wants these raw, 0-255 and all
  const W = gltf.attribute(prim, 'WEIGHTS_0').array;
  let maxJoint = 0;
  for (let i = 0; i < J.length; i += 4) {
    let sum = 0;
    for (let k = 0; k < 4; k++) { sum += W[i + k]; maxJoint = Math.max(maxJoint, J[i + k]); }
    assert.ok(sum > 200 && sum <= 255, `vertex ${i / 4} weights sum to ${sum}`);
  }
  assert.ok(maxJoint < 23, `joint index ${maxJoint} is out of range`);
});

test('the A-pose stands on the ground and holds its arms out of its sides', () => {
  const gltf = load(RIGGED);
  const prim = [...gltf.primitives()][0].prim;
  const pos = gltf.attribute(prim, 'POSITION').array;    // raw stream: the metre lives on the node
  const node = gltf.nodes[[...gltf.primitives()][0].node];
  const s = node.scale || [1, 1, 1];
  const t = node.translation || [0, 0, 0];
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i + k] * s[k] + t[k];
      mn[k] = Math.min(mn[k], v);
      mx[k] = Math.max(mx[k], v);
    }
  }
  const height = mx[1] - mn[1];
  assert.ok(height > 1.8 && height < 2.0, `figure is ${height.toFixed(2)} m tall`);
  assert.ok(Math.abs(mn[1]) < 1e-3, `feet are at y=${mn[1]}`);
  // an A-pose: the hands stand clear of the hips, well out of the silhouette a hanging arm would make
  const halfSpan = Math.max(mx[0], -mn[0]);
  assert.ok(halfSpan > 0.45 && halfSpan < 0.8, `arm half-span is ${halfSpan.toFixed(2)} m`);
});

test('at rest the skinning is the identity: every probed vertex lands where it started', () => {
  const gltf = load(RIGGED);
  const rig = new Rig(gltf, 0);
  const prim = [...gltf.primitives()][0].prim;
  const pos = gltf.attribute(prim, 'POSITION').array;
  const node = gltf.nodes[[...gltf.primitives()][0].node];
  const s = node.scale || [1, 1, 1];
  const t = node.translation || [0, 0, 0];
  const placed = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    placed[i] = pos[i] * s[0] + t[0];
    placed[i + 1] = pos[i + 1] * s[1] + t[1];
    placed[i + 2] = pos[i + 2] * s[2] + t[2];
  }
  const nrm = gltf.attribute(prim, 'NORMAL').array;
  const J = gltf.attribute(prim, 'JOINTS_0').array;
  const W = gltf.attribute(prim, 'WEIGHTS_0').array;
  const bones = rig.restBones();
  const bp = new Float32Array(3);
  const bn = new Float32Array(3);
  let worst = 0;
  for (let v = 0; v < placed.length / 3; v += 97) {
    skinVertices(
      { position: placed.subarray(v * 3, v * 3 + 3), normal: nrm.subarray(v * 3, v * 3 + 3) },
      J.subarray(v * 4, v * 4 + 4), W.subarray(v * 4, v * 4 + 4), bones, bp, bn,
    );
    worst = Math.max(worst, Math.hypot(bp[0] - placed[v * 3], bp[1] - placed[v * 3 + 1], bp[2] - placed[v * 3 + 2]));
  }
  assert.ok(worst < 2e-3, `rest pose moved a vertex by ${worst.toExponential(2)} m`);
});

test('the T-Pose clip, through the rest correction, puts these arms horizontal', () => {
  const gltf = load(RIGGED);
  const rig = new Rig(gltf, 0);
  const ref = load(REFERENCE);
  const tpose = clipsOf(ref).find((c) => c.name === 'T-Pose');
  assert.ok(tpose, 'the reference pack has a T-Pose clip');
  posedRig(rig, gltf, tpose, 0);
  for (const side of ['l', 'r']) {
    const a = worldOf(rig, `upperarm.${side}`);
    const b = worldOf(rig, `wrist.${side}`);
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...dir);
    assert.ok(len > 0.4, `the ${side} arm collapsed under T-Pose`);
    assert.ok(Math.abs(dir[1]) / len < 0.2, `the ${side} arm is not horizontal: dy/|d| = ${(dir[1] / len).toFixed(2)}`);
    assert.ok((dir[0] / len) * (side === 'l' ? 1 : -1) > 0.9, `the ${side} arm points the wrong way`);  // kaykit's .l is +X
  }
});

test('the Idle clip leaves the arms hanging and the figure standing', () => {
  const gltf = load(RIGGED);
  const rig = new Rig(gltf, 0);
  const ref = load(REFERENCE);
  const idle = clipsOf(ref).find((c) => c.name === 'Idle_A');
  assert.ok(idle, 'the reference pack has an Idle_A clip');
  posedRig(rig, gltf, idle, idle.duration / 2);
  const hip = worldOf(rig, 'hips');
  const head = worldOf(rig, 'head');
  assert.ok(hip[1] > 0.8 && hip[1] < 1.1, `hips at ${hip[1].toFixed(2)} m under Idle`);
  assert.ok(head[1] > hip[1] + 0.4, 'the head is above the hips under Idle');
  for (const side of ['l', 'r']) {
    const a = worldOf(rig, `upperarm.${side}`);
    const b = worldOf(rig, `wrist.${side}`);
    const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...dir);
    assert.ok(dir[1] / len < -0.6, `the ${side} arm does not hang under Idle: dy/|d| = ${(dir[1] / len).toFixed(2)}`);
  }
});

test('the correction covers every bone and is made of unit quaternions', () => {
  const gltf = load(RIGGED);
  const rig = new Rig(gltf, 0);
  for (const j of rig.joints) {
    const name = gltf.nodes[j].name;
    const fix = rigJson.bones[name];
    assert.ok(fix, `no correction for ${name}`);
    for (const key of ['B', 'D']) {
      const n = Math.hypot(...fix[key]);
      assert.ok(Math.abs(n - 1) < 1e-6, `${name} ${key} is not a unit quaternion`);
    }
  }
});
