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
import { createPlanes } from '../../web/src/game/planes.js';
import { createBikes } from '../../web/src/game/bikes.js';
import { createCrowd } from '../../web/src/game/crowd.js';
import { createVitals } from '../../web/src/game/vitals.js';
import { createJail } from '../../web/src/game/jail.js';
import { createWitness } from '../../web/src/game/witness.js';
import { createNitrous } from '../../web/src/game/nitrous.js';
import { createSkidMarks } from '../../web/src/game/skids.js';
import { createBoarding } from '../../web/src/game/boarding.js';
import { createCamera } from '../../web/src/game/camera.js';
import { createClock } from '../../web/src/game/clock.js';
import { createEffects } from '../../web/src/game/effects.js';
import { createStoryline } from '../../web/src/game/storyline.js';
import { createRadio } from '../../web/src/audio/radio.js';
import { createVoice } from '../../web/src/audio/voice.js';

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

test('the hangar and the bike rack answer to what the frame loop calls them by', () => {
  // Both are reached for from inside branches that only run when a man walks up to an aeroplane or a
  // motorcycle, which is exactly where a name that does not exist hides: the game boots, the city runs,
  // and nothing notices until somebody presses F on a kerb and the frame loop throws. `takeoffLabel` is
  // the worst of them, because it is read once a frame from the instrument panel and only while flying.
  const planes = createPlanes({ ground: () => 1.2 });
  assertWired('planes', planes, 'game/planes.js is the airport, and game.js only knows these names');
  for (const name of ['nearestTo', 'takeoffLabel', 'step', 'get', 'dispose']) {
    assert.equal(typeof planes[name], 'function', `planes.${name} is something that can be called`);
  }
  assert.ok('runway' in planes, 'and the strip in use is a property rather than a call');

  const bikes = createBikes({ ground: () => 1.2, seed: 11 });
  assertWired('bikes', bikes, 'game/bikes.js is the kerb, and game.js only knows these names');
  for (const name of ['nearestTo', 'step', 'get', 'dispose']) {
    assert.equal(typeof bikes[name], 'function', `bikes.${name} is something that can be called`);
  }

  // And the two are usable over a real street, not just present: a machine is held out to a man standing
  // at it, stepped with a rider on it, picked up when it falls over, and disposed of without a renderer.
  const graph = prepareLaneGraph({
    lanes: [{ pts: [0, 0, 0, 0, 0, 400], next: [], speedLimit: 13.4, width: 7 }],
    junctions: [],
  });
  const kerb = createBikes({ graph, ground: () => 1.2, seed: 5 });
  const one = kerb.bikes[0].bike;
  assert.equal(kerb.nearestTo(one.pos[0], one.pos[2]).id, 0, 'a machine at the kerb is offered to a man at the kerb');
  kerb.step(1 / 30, 0, { throttle: 1 });
  kerb.step(1 / 30);
  assert.ok(kerb.right(0), 'and it can be picked up by the id the frame loop is holding');
  kerb.dispose();
  planes.dispose();
  bikes.dispose();
});

test('the crowd answers to what the frame loop calls it by, body shelf included', () => {
  // The graph is null rather than the permissive stub because the crowd walks its lanes at construction,
  // and a street with no lanes in it yet is a state the real game is in for the first few frames anyway.
  const crowd = createCrowd({ graph: null, plan: {}, renderer: anything, seed: 7, land: 1.2, quality: 'medium' });
  assertWired('crowd', crowd, 'game/crowd.js is the street, and game.js only knows these names');
  // Named, because these three were the ones missing: `takePerson` and `handPersonBack` existed inside
  // createCrowd and were never put on the object it returned, and `castError` was written by the game's
  // cast loader and read by its diagnostics without ever being declared. Every caller guarded the first
  // two, so nothing threw — the player just stepped out of a car with no body, a carjacked driver was
  // never thrown onto the street, and a wanted level never sent anybody after him on foot, because the
  // count of officers to send was computed from a method that was not there.
  assert.equal(typeof crowd.takePerson, 'function', 'the shelf lends a body to whoever asks');
  assert.equal(typeof crowd.handPersonBack, 'function', 'and takes it back again');
  assert.ok('castError' in crowd, 'why the models did not arrive is somewhere to be read from');
  assert.equal(crowd.takePerson({ character: 0, wardrobe: 0, id: 1 }), null, 'with no cast in, nobody is lent');
});

test('every other object the frame loop talks to answers to the name it is called by', () => {
  // The same check as above, over the rest of the collaborators game.js builds and then reaches into from
  // inside a branch that may run once a session: the cell, the witness, the nitrous, the skid marks, the
  // door sequence, the clock, the effects, the two audio voices. A name that is not there is a TypeError
  // inside frame(), which main.js turns into a stopped loop, and which presents to the player as a game
  // that froze for no reason he can name. None of these are on the boot path, so nothing else catches it.
  const built = [
    ['vitals', createVitals({})],
    ['jail', createJail({ toast: anything, purse: anything, wanted: anything })],
    ['witness', createWitness({ shops: [], lots: [], crowd: anything, seed: 21 })],
    ['nitrous', createNitrous({ audio: anything, seed: 3 })],
    ['skids', createSkidMarks({ renderer: anything })],
    ['boarding', createBoarding({ crowd: anything })],
    ['camera', createCamera({})],
    ['clock', createClock({ sky: anything, seed: 1, time: 'dusk', weather: 'clear' })],
    ['effects', createEffects({ physics: anything, audio: anything, camera: anything, input: anything, settings: anything })],
    ['storyline', createStoryline({ toast: anything, purse: anything, wanted: anything })],
    ['radio', createRadio({ context: () => null, seed: 11 })],
    ['voice', createVoice({ context: () => null })],
  ];
  for (const [owner, object] of built) {
    assertWired(owner, object, `the object game.js builds and drives as \`${owner}\``);
  }
  assert.equal(built.length, 12, 'and the list above is the list this test walked');
});
