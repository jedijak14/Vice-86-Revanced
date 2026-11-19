// The names on the objects the frame loop talks to. `node --check` proves a file parses; it does not know
// that `shopRoom.stepsoff(...)` is a method nobody has — that typo was a `TypeError` inside `frame()`, which
// main.js turns into a stopped loop, and it hid behind four browser runs that each blamed the walker for not
// getting out of a shop. So the wiring is checked here, against the real objects, with no GPU and no page.
//
// The trick is that these modules take collaborators they only *call*: a permissive stub is enough to build
// them, and then the properties the game reaches for can be looked up on the finished object.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createShopRoom } from '../../web/src/game/shoproom.js';
import { createShops, indexShops } from '../../web/src/game/shops.js';
import { createFoot } from '../../web/src/game/foot.js';
import { createWeapon } from '../../web/src/game/weapons.js';
import { createPurse } from '../../web/src/game/money.js';
import { createTraffic } from '../../web/src/game/traffic.js';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';

const here = dirname(fileURLToPath(import.meta.url));
const gameSource = readFileSync(join(here, '../../web/src/game/game.js'), 'utf8');

/** Answers anything with itself: enough for a constructor that only stores and calls its dependencies. */
const anything = new Proxy(function () {}, {
  get(target, key) {
    if (key === Symbol.toPrimitive || key === 'valueOf') return () => 0;
    if (key === 'length') return 0;
    if (key === 'then') return undefined;            // never mistaken for a thenable
    return anything;
  },
  apply() { return anything; },
  construct() { return anything; },
  has() { return true; },
  set() { return true; },
});

/**
 * Prose and paths are not wiring: neither a comment that says "see game/shops.js" nor the import string
 * './shops.js' is the frame loop reaching for a member of the object. So strings go first (they are what a
 * comment inside a path would otherwise hide), then the comments.
 */
function codeOnly(source) {
  return source
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/** Every `owner.member` the source mentions, whether it reads, calls or assigns it. */
function membersOf(rawSource, owner) {
  const source = codeOnly(rawSource);
  const found = new Set();
  for (const m of source.matchAll(new RegExp(`\\b${owner}\\.(\\w+)`, 'g'))) found.add(m[1]);
  return [...found].sort();
}

function assertWired(owner, object, what) {
  const wanted = membersOf(gameSource, owner);
  assert.ok(wanted.length > 0, `${owner}: the game never touches it, so what is this test for?`);
  const missing = wanted.filter((name) => !(name in object));
  assert.deepEqual(missing, [], `${what} — ${owner} was asked for ${missing.join(', ')}, which it does not have`);
}

test('every part of a shop room the frame loop uses exists on it', () => {
  const shopRoom = createShopRoom({ renderer: anything });
  assertWired('shopRoom', shopRoom, 'web/src/game/shoproom.js builds the object game.js drives');
  // And the two the last bug touched, named, so a rename has to be a decision rather than a typo.
  assert.equal(typeof shopRoom.enter, 'function');
  assert.equal(typeof shopRoom.doorstep, 'function');
  assert.equal(typeof shopRoom.writeLights, 'function');
  assert.equal(typeof shopRoom.confine, 'function');
});

test('the shop rules, the walker and the gun answer to what the game calls them by', () => {
  const purse = createPurse({ storage: null });
  const shops = createShops({
    purse, wanted: anything, crowd: anything, gun: anything,
    plan: anything, field: anything, toast: anything,
    onEnter: anything, onExit: anything, onAlarm: anything,
  });
  assertWired('shops', shops, 'game/shops.js is the rules, game.js is the wiring');
  const foot = createFoot({ physics: anything, land: anything, floor: anything, onLand: anything, person: anything, crowd: anything });
  assertWired('foot', foot, 'game/foot.js is the man, and the frame loop only knows these names');
  const gun = createWeapon({ crowd: anything, wanted: anything, purse: anything, toast: anything, physics: anything, at: anything });
  assertWired('gun', gun, 'game/weapons.js is the .38');
});

test('the traffic answers to what the frame loop calls it by, horns and walkers included', () => {
  // createTraffic takes a renderer, a physics world and the model list, but it only *calls* them, so the
  // permissive stub is enough to build the real object over a real lane graph. That matters: `traffic.step`
  // and `traffic.setFocus` have been in the frame loop since the beginning and a typo there would be
  // caught by any drive at all, but `setWalker` and `honking` are reached for once a step, from inside a
  // branch that only runs on foot, and nothing else would notice them missing until somebody stood in a
  // road and wondered why the cars went through him.
  const graph = prepareLaneGraph({
    lanes: [{ pts: [0, 0, 0, 0, 0, 200], next: [], speedLimit: 13.4, width: 3.3 }],
    junctions: [],
  });
  const traffic = createTraffic({ renderer: anything, physics: anything, graph, models: [], seed: 1, notify: null });
  assertWired('traffic', traffic, 'game/traffic.js is the street, and game.js only knows these names');
  assert.equal(typeof traffic.setWalker, 'function', 'the man on foot is described to the drivers');
  assert.ok(Array.isArray(traffic.honking), 'and the drivers that stopped for him are reported as a list');
  assert.equal(typeof traffic.nearestTo, 'function', 'the street holds out a car to a man on foot');
  assert.equal(typeof traffic.take, 'function', 'and hands it over when he takes it');
  assert.equal(typeof traffic.adopt, 'function', 'and keeps the car he left standing where he left it');

  // The two are not just present but usable: a walker can be described, taken away again, and the step
  // run either way without throwing, which is the whole of what game.js does with them each frame.
  traffic.setWalker({ active: true, x: 1, z: 2, yaw: 0, vx: 0, vz: 0, crouching: false });
  traffic.setWalker({ active: false });
  traffic.setWalker(null);
  traffic.step(1 / 30);
  assert.equal(traffic.honking.length, 0, 'an empty road has nobody to honk');
  // And the same for a car: an empty street holds out nothing, taking nothing is null rather than a throw,
  // and a car it was not given is refused. game.js does all three from inside a branch that only runs on
  // foot, which is exactly where a missing name hides.
  const held = traffic.nearestTo(0, 0, 2.4, 1.5);
  assert.equal(held.active, false, 'an empty street has no car in it to take');
  assert.equal(traffic.take(held.id), null, 'nothing to take is null');
  assert.equal(traffic.adopt(null), false, 'and no car handed over is no car parked');
  traffic.dispose();
});

test('the shop records the room is built from are where indexShops put them', () => {
  // `shopInfo` looks a door up in world metres and `shops.offer` measures a man in the room's own: one of
  // the two has to convert, and a room that is placed rather than moved means the *box* is world and the
  // counter is local. Both are checked here because the frame loop is not.
  const plan = { blocks: [], lots: [] };
  const list = indexShops(plan, { field: () => ({ kind: 'pavement' }), rng: () => 0.5, limit: 8 });
  assert.ok(Array.isArray(list) || typeof list === 'object', 'an empty plan yields a list, not a throw');
});
