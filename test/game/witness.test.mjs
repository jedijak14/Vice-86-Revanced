// The eyes of the street: a shop or a parking lot is a place where a crime needs a witness, and
// the witness is a cone on a bracket or a pair of eyes within twenty metres.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWitness, CAMERA_RANGE, CAMERA_CONE, EYE_RANGE } from '../../web/src/game/witness.js';
import { COVER } from '../../web/src/world/plan/field.js';

const shop = { name: 'Corner Store', x: 100, z: 100, yaw: 0 };
const lot = { cover: COVER.PARKING, x: 200, z: 200, width: 30, depth: 24, yaw: 0 };
const lawn = { cover: COVER.LAWN, x: 300, z: 300, width: 30, depth: 24, yaw: 0 };

const fakeCrowd = (pts) => ({
  people: pts.map((p, i) => ({ i })),
  at(p, out) { out[0] = pts[p.i][0]; out[1] = 0; out[2] = pts[p.i][1]; return out; },
});

test('shops and parking lots are zones; lawns are not', () => {
  const w = createWitness({ shops: [shop], lots: [lot, lawn] });
  assert.equal(w.zones.length, 2, 'one shop, one lot, and the lawn stays open street');
  assert.ok(w.zoneAt(100, 100), 'the door is inside its own zone');
  assert.ok(w.zoneAt(200, 200));
  assert.equal(w.zoneAt(300, 300), null, 'a lawn is nobody\'s business');
  assert.equal(w.zoneAt(0, 0), null, 'and neither is the middle of nowhere');
  assert.equal(w.cameras.length, 4, 'two lenses a zone');
});

test('a camera sees what stands in its cone and nothing behind it', () => {
  const w = createWitness({ shops: [shop], lots: [] });
  const c = w.cameras[0];
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw);
  const inFront = [c.x + fx * 10, c.z + fz * 10];
  const behind = [c.x - fx * 10, c.z - fz * 10];
  const sideways = [c.x + Math.cos(c.yaw) * 10 * Math.sin(CAMERA_CONE * 2), c.z - Math.sin(c.yaw) * 10 * Math.sin(CAMERA_CONE * 2)];
  assert.equal(w.seen(inFront[0], inFront[1]).camera, true, 'ten metres down the lens is in frame');
  assert.equal(w.seen(behind[0], behind[1]).camera, false, 'behind the bracket is blind');
  const wide = [c.x + Math.sin(c.yaw + CAMERA_CONE + 0.5) * 12, c.z + Math.cos(c.yaw + CAMERA_CONE + 0.5) * 12];
  assert.equal(w.seen(wide[0], wide[1]).camera, false, 'outside the cone is outside the tape');
  const far = [c.x + fx * (CAMERA_RANGE + 5), c.z + fz * (CAMERA_RANGE + 5)];
  assert.equal(w.seen(far[0], far[1]).camera, false, 'and past the range the lens gives up');
  assert.equal(sideways.length, 2);
});

test('bystanders count inside twenty metres and not outside', () => {
  const w = createWitness({ shops: [shop], lots: [], crowd: fakeCrowd([[102, 101], [105, 100], [140, 140]]) });
  const s = w.seen(100, 100);
  assert.equal(s.people, 2, 'two pairs of eyes close enough to report it');
  assert.equal(s.camera, true, 'the door is exactly where the two lenses cross');
  const none = createWitness({ shops: [shop], lots: [], crowd: fakeCrowd([[140, 140]]) });
  assert.equal(none.seen(100, 100).people, 0, 'one bystander forty metres away saw nothing');
  assert.ok(EYE_RANGE === 20);
});

test('the open street needs no witness because it is not a zone', () => {
  const w = createWitness({ shops: [shop], lots: [lot] });
  const s = w.seen(500, 500);
  assert.equal(s.zone, null);
  assert.equal(s.camera, false);
  assert.equal(s.people, 0);
});
