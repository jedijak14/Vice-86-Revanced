// The synthesised swim: a front crawl you can measure.
//
// No licence we can reach carries a swimming clip, so core/swimclip.js builds one from published stroke
// kinematics. A test therefore cannot compare it against a reference file — it compares it against the
// stroke: the body laid at the surface and rolled to both sides, the hand passing *under* the body
// through the pull and *over* it through the recovery, the elbow bent near a right angle at the catch,
// the head turning once a cycle to breathe, and every quaternion on every key a unit one, because a
// clip that drifts off the unit sphere drifts off the body too.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { swimClip, treadClip, swimClips, PARENTS, STROKE, STROKE_SECONDS } from '../../web/src/core/swimclip.js';

const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const rot = (q, v) => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * v[0] * 0 - y * t[0]),
  ];
};

/** World orientation of every bone at one key, walked down the chain the sampler will walk it. */
function worldsAt(clip, key) {
  const local = new Map();
  for (const ch of clip.channels) {
    if (ch.path !== 'rotation') continue;
    local.set(ch.name, [ch.output.array[key * 4], ch.output.array[key * 4 + 1], ch.output.array[key * 4 + 2], ch.output.array[key * 4 + 3]]);
  }
  const W = new Map();
  for (const name of Object.keys(PARENTS)) {
    const parent = PARENTS[name];
    W.set(name, mul(parent ? W.get(parent) : [0, 0, 0, 1], local.get(name)));
  }
  return W;
}
const keys = (clip) => clip.channels[0].input.length;

test('the clip is shaped like the cast expects: looped, timed, and every quaternion unit', () => {
  for (const clip of swimClips()) {
    assert.ok(clip.duration > 0.5 && clip.duration < 4, 'a stroke cycle is a second or two, not a minute');
    const n = keys(clip);
    for (const ch of clip.channels) {
      assert.equal(ch.input.length, n, `${clip.name}/${ch.name}: one time per key`);
      const comps = ch.output.components;
      assert.equal(ch.output.array.length, n * comps);
      for (let k = 0; k < n; k++) {
        if (comps === 4) {
          const q = [ch.output.array[k * 4], ch.output.array[k * 4 + 1], ch.output.array[k * 4 + 2], ch.output.array[k * 4 + 3]];
          assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-3, `${clip.name}/${ch.name} key ${k} is off the unit sphere`);
        }
      }
      if (ch.path === 'rotation') {
        const first = [ch.output.array[0], ch.output.array[1], ch.output.array[2], ch.output.array[3]];
        const last = [ch.output.array[(n - 1) * 4], ch.output.array[(n - 1) * 4 + 1], ch.output.array[(n - 1) * 4 + 2], ch.output.array[(n - 1) * 4 + 3]];
        assert.ok(first.every((v, i) => Math.abs(v - last[i]) < 1e-6), `${clip.name}/${ch.name} does not close its loop`);
      }
    }
    // Every bone the pose needs, and only bones the KayKit skeleton has.
    const names = new Set(clip.channels.filter((c) => c.path === 'rotation').map((c) => c.name));
    for (const bone of Object.keys(PARENTS)) assert.ok(names.has(bone), `${clip.name} leaves ${bone} at its bind`);
  }
});

test('the body lies at the surface and rolls to both sides, the way the literature measures it', () => {
  const clip = swimClip();
  const n = keys(clip);
  let maxRoll = 0, minRoll = 0, flatness = 0;
  for (let k = 0; k < n; k++) {
    const W = worldsAt(clip, k);
    const axis = rot(W.get('hips'), [0, 1, 0]);          // the laid body's long axis
    flatness = Math.max(flatness, Math.abs(axis[1]));    // a swimmer is horizontal, not a diver
    // Roll: how far the body's own right hand dips under the water (world -Y while prone).
    const right = rot(W.get('chest'), [1, 0, 0]);
    const roll = Math.asin(Math.max(-1, Math.min(1, -right[1])));
    maxRoll = Math.max(maxRoll, roll);
    minRoll = Math.min(minRoll, roll);
  }
  assert.ok(flatness < 0.3, `the torso axis tips ${Math.round(Math.asin(flatness) * 57.3)} degrees off the surface`);
  assert.ok(maxRoll > 0.5, `the roll only reaches ${Math.round(maxRoll * 57.3)} degrees to one side`);
  assert.ok(minRoll < -0.5, `and ${Math.round(-minRoll * 57.3)} to the other; the literature says 40-60`);
  assert.ok(Math.abs(STROKE.roll - 40 * Math.PI / 180) < 1e-9, 'hips roll 40; the shoulders add to the published 60');
});

test('the hand goes under the body to pull and over it to recover, on each arm in turn', () => {
  const clip = swimClip();
  const n = keys(clip);
  const conj = (q) => [-q[0], -q[1], -q[2], q[3]];
  // The body rolls through the stroke, so "under the body" is the chest's own face-side axis, not the
  // world's down: a hand path is measured against the trunk it hangs from.
  const local = (W, bone, v) => rot(conj(W.get('chest')), rot(W.get(bone), v));
  for (const [tag, off] of [['l', 0], ['r', 0.5]]) {
    // The pull's middle and the recovery's middle, as keys of the cycle.
    const keyAt = (phase) => Math.round(((phase - off + 1) % 1) * (n - 1));
    const catchKey = keyAt(0.14);
    const pullKey = keyAt(STROKE.pull * 0.6);
    const recKey = keyAt((STROKE.pull + 1) / 2);
    const Wc = worldsAt(clip, catchKey);
    const Wp = worldsAt(clip, pullKey);
    const Wr = worldsAt(clip, recKey);
    const foreCatch = local(Wc, `lowerarm.${tag}`, [0, 1, 0]);
    const forePull = local(Wp, `lowerarm.${tag}`, [0, 1, 0]);
    const upperRec = local(Wr, `upperarm.${tag}`, [0, 1, 0]);
    const upperPull = local(Wp, `upperarm.${tag}`, [0, 1, 0]);
    // chest-local +Z is the swimmer's face side: the pool floor while prone. At the catch the forearm
    // points straight at it — the early vertical forearm — and by mid-pull it has swept to point back
    // along the trunk, which is the hand passing under the body towards the hip.
    assert.ok(foreCatch[2] > 0.3, `the ${tag} catch forearm is ${foreCatch[2].toFixed(2)} off the face axis: no vertical forearm`);
    assert.ok(forePull[1] < -0.3, `the ${tag} mid-pull forearm is ${forePull[1].toFixed(2)} along the trunk: the hand is not sweeping under the body`);
    assert.ok(upperRec[2] < upperPull[2] - 0.5, `the ${tag} recovery does not lift the arm over the water`);
    assert.ok(upperRec[2] < -0.1, `the ${tag} recovering arm stays on the face side: ${upperRec[2].toFixed(2)}`);
    // The catch: elbow near a right angle at the start of the pull, not a straight arm dragging.
    const foreWorld = rot(Wc.get(`lowerarm.${tag}`), [0, 1, 0]);
    const upperWorld = rot(Wc.get(`upperarm.${tag}`), [0, 1, 0]);
    const dot = upperWorld[0] * foreWorld[0] + upperWorld[1] * foreWorld[1] + upperWorld[2] * foreWorld[2];
    const elbow = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    assert.ok(elbow > 60 && elbow < 130, `the ${tag} catch is ${Math.round(elbow)} degrees of elbow; the early vertical forearm is 90-110`);
  }
});

test('the head turns once a cycle to breathe, and stays down the rest of the time', () => {
  const clip = swimClip();
  const n = keys(clip);
  const face = (k) => rot(worldsAt(clip, k).get('head'), [0, 0, 1]);
  const mid = Math.round(((STROKE.breathFrom + STROKE.breathTo) / 2) * (n - 1));
  const quiet = Math.round(0.15 * (n - 1));
  assert.ok(Math.abs(face(mid)[0]) > 0.5, 'in the breath window the face turns to the side');
  assert.ok(Math.abs(face(quiet)[0]) < 0.35, 'outside it the face looks at the pool floor');
});

test('the tread holds a man upright with his chin out, bobbing', () => {
  const clip = treadClip();
  const n = keys(clip);
  let upright = 0, bob = 0, lo = Infinity, hi = -Infinity;
  for (let k = 0; k < n; k++) {
    const W = worldsAt(clip, k);
    const axis = rot(W.get('chest'), [0, 1, 0]);
    upright = Math.max(upright, axis[1]);
    const t = W.get('hips');
    // the hips translation channel carries the bob
    const ch = clip.channels.find((c) => c.path === 'translation');
    const y = ch.output.array[k * 3 + 1];
    lo = Math.min(lo, y); hi = Math.max(hi, y);
    void t;
  }
  assert.ok(upright > 0.9, 'treading water is a vertical man');
  bob = hi - lo;
  assert.ok(bob > 0.05 && bob < 0.2, `the bob is ${(bob * 100).toFixed(0)} cm; a tread rises and falls with the breath`);
  assert.equal(STROKE_SECONDS, swimClip().duration);
});
