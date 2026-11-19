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
import { buildCitizen, buildCitizens } from '../../web/src/world/people/citizens.js';

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
