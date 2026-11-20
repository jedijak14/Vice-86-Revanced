// Citizens: the pavement's people, built rather than borrowed.
//
// The vendored shelf is fantasy adventurers; the street needs citizens. These are procedure — prisms of
// modern clothing on the vendored skeleton — so what a test asserts is the contract the crowd and the
// animation library both rely on: a body that stands on zero, weighs a few hundred triangles, skins
// rigidly to bones that exist, and is the same citizen every time for the same seed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Gltf } from '../../web/src/core/gltf.js';
import { Rig } from '../../web/src/core/animate.js';
import { buildCitizen, buildCitizens, splitShelf } from '../../web/src/world/people/citizens.js';
import { newPerson, WARDROBE } from '../../web/src/world/people/cast.js';
import { VERTEX_STRIDE } from '../../web/src/core/ids.js';

const b = readFileSync(new URL('../../web/assets/models/kaykit-adventures/Rogue.glb', import.meta.url));
const gltf = new Gltf(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const base = { gltf, rig: new Rig(gltf, 0), authored: 1.8 };

test('a citizen is a small body that stands on the same zero as the vendored cast', () => {
  const c = buildCitizen(base, 5);
  assert.ok(c.vertexCount > 200 && c.vertexCount < 700, `${c.vertexCount} verts: a person, not a city`);
  assert.ok(c.triangles.length / 3 > 300 && c.triangles.length / 3 < 1400, 'and a few hundred triangles of clothes');
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 1; i < c.positions.length; i += 3) { ymin = Math.min(ymin, c.positions[i]); ymax = Math.max(ymax, c.positions[i]); }
  assert.ok(ymin > -0.02 && ymin < 0.05, `feet at ${ymin.toFixed(3)}: the pavement is zero`);
  assert.ok(ymax > 1.5 && ymax < 2.1, `crown at ${ymax.toFixed(2)} m: a person's height in the bind's metre`);
});

test('every vertex rides one bone that exists, at full weight', () => {
  for (const c of buildCitizens(base, { citizens: 6, officers: 2 })) {
    assert.equal(c.joints.length, c.vertexCount * 4);
    assert.equal(c.weights.length, c.vertexCount * 4);
    for (let v = 0; v < c.vertexCount; v++) {
      assert.equal(c.weights[v * 4], 255, 'rigid skinning, one influence, no leaks');
      assert.ok(c.joints[v * 4] >= 0 && c.joints[v * 4] < c.rig.joints.length, 'on a bone the skeleton has');
    }
    assert.equal(c.triangles.length % 6, 0, 'double-wound for a renderer that culls');
  }
});

test('a citizen is a closed body, not a wall with half its quads missing', () => {
  // Every prism here is double-wound, so half the index list is the other half backwards. What is left
  // once the two windings are folded together is the surface, and a surface is closed where two of its
  // triangles share an edge. A limb wall is a strip of quads and a quad is *two* triangles: emit the
  // second one as the first one wound backwards instead of as the other half of the quad, and the wall
  // keeps one diagonal stripe per segment and loses the rest — an arm you can see the pavement through,
  // from every angle, on every pedestrian in the city.
  //
  // The count alone cannot catch it. The broken wall still emits two triangles per segment and still
  // divides by six, so it passes a budget and a double-winding check while drawing half a person. Only
  // the edges know: 15% of them were shared before this was fixed, and 63% are now. The rest stay open
  // honestly, because a sleeve that meets a forearm is two prisms abutting, not one surface welded.
  let worst = 1, worstOpen = 0, worstShared = 0;
  for (const c of buildCitizens(base, { citizens: 10, officers: 2, seed: 4 })) {
    const distinct = new Set();
    for (let t = 0; t < c.triangles.length; t += 3) {
      distinct.add([c.triangles[t], c.triangles[t + 1], c.triangles[t + 2]].slice().sort((x, y) => x - y).join(','));
    }
    assert.equal(distinct.size * 2, c.triangles.length / 3, 'each triangle drawn twice, once each way round');
    const edges = new Map();
    for (const key of distinct) {
      const [a, b2, c2] = key.split(',').map(Number);
      for (const [p, q] of [[a, b2], [b2, c2], [c2, a]]) {
        const e = p < q ? `${p}|${q}` : `${q}|${p}`;
        edges.set(e, (edges.get(e) || 0) + 1);
      }
    }
    let open = 0, shared = 0;
    for (const n of edges.values()) { if (n === 1) open++; else shared++; }
    assert.equal(open + shared, edges.size);
    const ratio = shared / edges.size;
    if (ratio < worst) { worst = ratio; worstOpen = open; worstShared = shared; }
  }
  assert.ok(worst >= 0.5,
    `only ${(worst * 100).toFixed(0)}% of its edges are shared (${worstShared} closed, ${worstOpen} open): a wall with gaps in it`);
});

/** A renderer that keeps the mesh it is handed, which is the only way to read the colours back. */
function capturingRenderer(into) {
  return {
    createMesh: (data) => { into.data = data; return { id: 1 }; },
    addDynamic: () => ({ matrix: new Float32Array(16), visible: true, remove() {} }),
    refreshMesh() {}, destroyMesh() {},
  };
}
/** The RGB a vertex actually carries in the interleaved buffer, 0..1. */
function colourAt(data, v) {
  const u8 = new Uint8Array(data.vertices), o = v * VERTEX_STRIDE + 20;
  return [u8[o] / 255, u8[o + 1] / 255, u8[o + 2] / 255];
}

test('a citizen wears the colours it was built in, and the wardrobe does not grade them', () => {
  // A wardrobe is a grade over the vendored shelf, whose painted fantasy colours are all one
  // costume-department brown: 'street' cools it, 'night' puts it out. A citizen's vertex colours are its
  // own clothes and face instead -- six skin tones, fourteen ordinary colours, a navy uniform with a
  // brass badge -- so grading them at a weight of 0.55 turned a warm skin teal (blue over red, which no
  // skin is), a cream tee blue and a policeman's navy olive, and washed a street of individuals back into
  // one palette. That is half of why the pavement looked wrong; the other half was the wall below.
  for (const citizen of buildCitizens(base, { citizens: 4, officers: 2, seed: 9 })) {
    for (const wardrobe of [WARDROBE[0], WARDROBE[3]]) {
      const into = {};
      newPerson(capturingRenderer(into), { clips: [] }, citizen, { wardrobe, seed: 1 });
      // Every vertex, not a sample: the colours were set *after* each vertex was pushed, and a
      // MeshBuilder snapshots its colour state at push time, so the whole body was painted one vertex
      // late and the first vertex wore the builder's default white. A sample of four would have missed
      // it, which is the difference between a mesh that reads and a mesh with a white speck on it.
      for (let v = 0; v < citizen.vertexCount; v++) {
        const got = colourAt(into.data, v);
        for (let k = 0; k < 3; k++) {
          assert.ok(Math.abs(got[k] - citizen.colors[v * 3 + k] / 255) < 1.6 / 255,
            `${citizen.name} in '${wardrobe.id}': vertex ${v} channel ${k} is ${got[k].toFixed(3)}, ` +
            `built as ${(citizen.colors[v * 3 + k] / 255).toFixed(3)}`);
        }
      }
    }
  }
  // And the grade is still there for the shelf that needs it: the same arrays without `citizen` on them
  // come back shifted towards the wardrobe, which is the whole of what a wardrobe is for.
  const plain = buildCitizen(base, 5);
  const vendored = { ...plain, citizen: false, name: 'vendored' };
  const into = {};
  newPerson(capturingRenderer(into), { clips: [] }, vendored, { wardrobe: WARDROBE[0], seed: 1 });
  let moved = 0;
  for (let v = 0; v < vendored.vertexCount; v++) {
    const got = colourAt(into.data, v);
    for (let k = 0; k < 3; k++) if (Math.abs(got[k] - vendored.colors[v * 3 + k] / 255) > 1.6 / 255) moved++;
  }
  assert.ok(moved > vendored.vertexCount,
    `a graded body shifts most of its channels; only ${moved} of ${vendored.vertexCount * 3} did`);
});

test('the shelf is citizens with two officers last, and the seed is a face', () => {
  const shelf = buildCitizens(base, { citizens: 8, officers: 2, seed: 4 });
  assert.equal(shelf.length, 10);
  assert.ok(shelf.slice(0, 8).every((c) => !c.police), 'the first eight are civilians');
  assert.ok(shelf.slice(8).every((c) => c.police), 'and the last two wear the uniform');
  const again = buildCitizen(base, 4 * 1 + 0 * 31);
  const first = buildCitizens(base, { citizens: 1, officers: 0, seed: 4 })[0];
  assert.deepEqual(Array.from(first.positions.slice(0, 30)), Array.from(again.positions.slice(0, 30)),
    'the same seed is the same citizen, every time');
  const other = buildCitizen(base, 999);
  assert.notDeepEqual(Array.from(other.colors.slice(0, 30)), Array.from(first.colors.slice(0, 30)),
    'a different seed is a different person in different clothes');
});

test('the uniform reads as a uniform: navy top, navy trousers, a cap and a badge', () => {
  const cop = buildCitizen(base, 12, { police: true });
  const cols = new Set();
  for (let v = 0; v < cop.vertexCount; v++) {
    cols.add(`${cop.colors[v * 3] >> 4},${cop.colors[v * 3 + 1] >> 4},${cop.colors[v * 3 + 2] >> 4}`);
  }
  assert.ok(cols.has(`${(0.13 * 255) >> 4},${(0.17 * 255) >> 4},${(0.26 * 255) >> 4}`), 'the navy shirt is on the body');
  assert.ok(cols.has(`${(0.85 * 255) >> 4},${(0.70 * 255) >> 4},${(0.25 * 255) >> 4}`), 'and brass on the chest');
  const civ = buildCitizen(base, 12);
  assert.ok(!civ.police, 'the same seed without the flag is a civilian');
});

test('the sway mask: hair a full one, cloth a half, and every vertex accounted for', () => {
  const shelf = buildCitizens(base, { citizens: 6, officers: 1, seed: 4 });
  for (const rec of shelf) {
    assert.equal(rec.sway.length, rec.vertexCount, 'one mask value per vertex');
    for (const m of rec.sway) assert.ok(m >= 0 && m <= 1, 'a mask is a share, not a distance');
  }
  const hairy = shelf.find((r) => r.sway.some((m) => m === 1));
  assert.ok(hairy, 'somebody on the shelf has hair that moves');
  assert.ok(shelf.every((r) => r.sway.some((m) => m > 0)), 'and nobody is welded solid');
});

test('the shelf is split into the police and everybody else, by index, and the split can be run', () => {
  // This is the seam the game loads its people through: ten citizens and two officers on one shelf, and
  // two lists of indices saying which is which. It is here rather than inline in the cast loader because
  // inline it was written as `.filter((i) >= 0)` -- a comparison where an arrow function belongs, and a
  // ReferenceError at runtime. It threw inside a promise, the promise's own catch reported "the street
  // could not load its people", and the game carried on with nobody on the pavement and no body for the
  // player to walk about in. Nothing a browser shows you; everything a test does.
  const shelf = buildCitizens(base, { citizens: 10, officers: 2, seed: 9 });
  assert.equal(shelf.length, 12, 'the shelf is the twelve it was asked for');
  const { officers, citizens } = splitShelf(shelf);
  assert.deepEqual(officers, [10, 11], 'the officers are the two at the end, where buildCitizens puts them');
  assert.deepEqual(citizens, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'and everybody before them is a passer-by');
  for (const i of officers) assert.ok(shelf[i].police, `index ${i} really is wearing a uniform`);
  for (const i of citizens) assert.ok(!shelf[i].police, `and index ${i} really is not`);
  assert.equal(officers.length + citizens.length, shelf.length, 'nobody is lost between the two lists');
  // An empty shelf and a shelf of nobody are both a pair of empty lists, not a throw: the cast is a
  // download, and a street that has not finished loading is a street with nobody on it yet.
  assert.deepEqual(splitShelf([]), { officers: [], citizens: [] });
  assert.deepEqual(splitShelf(null), { officers: [], citizens: [] });
});
