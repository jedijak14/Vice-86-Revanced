// The crowd's body shelf: the park it lends a walker from and takes him back to.
//
// `takePerson` and `handPersonBack` were the crowd's *private* functions. The street used them for its
// own pedestrians and nothing outside it could, so every caller that asked for a body guarded the call
// first and then quietly got nobody: a player who stepped out of a car and cast no figure at all, a
// carjacking with nobody landing on the asphalt, and a wanted level that never sent a single officer on
// foot because the count it computed was always zero. Nothing threw, nothing logged, and no test failed,
// because crowd.js had no test file and the callers that were tested were handed a fake crowd that *did*
// have the two names on it. These are the real object over the real vendored cast.

import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

import { createCrowd } from '../../web/src/game/crowd.js';
import { loadCast } from '../../web/src/world/people/cast.js';
import { buildCitizens } from '../../web/src/world/people/citizens.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const fetchFile = async (rel) => (await readFile(path.join(root, 'web', rel))).buffer;

/**
 * The renderer as a body builder sees it: a mesh handle, a dynamic to hang it on, and the two calls that
 * keep it in step. Nothing is drawn, but every call a person makes on the way to being a person is made
 * against something real enough to throw if the shape is wrong.
 */
function capturingRenderer() {
  const made = { meshes: 0, dynamics: 0, refreshed: 0, destroyed: 0, removed: 0 };
  return {
    made,
    createMesh() { made.meshes++; return made.meshes - 1; },
    addDynamic() {
      made.dynamics++;
      return {
        matrix: new Float32Array(16), objA: new Float32Array(4), objB: new Float32Array(4),
        visible: true, teleported: false, remove() { made.removed++; },
      };
    },
    refreshMesh() { made.refreshed++; },
    destroyMesh() { made.destroyed++; },
  };
}

function street(renderer) {
  return createCrowd({ graph: null, plan: {}, renderer, seed: 7, land: 1.2, quality: 'medium' });
}

/** The pavement's own shelf, which is what the game hands the crowd once the download lands. */
async function loadedStreet() {
  const renderer = capturingRenderer();
  const crowd = street(renderer);
  const cast = await loadCast({ fetchFile, decodeImage: null, only: ['Rogue'] });
  cast.characters = buildCitizens(cast.characters[0], { citizens: 10, officers: 2, seed: 9 });
  crowd.setCast(cast);
  return { crowd, cast, renderer };
}

test('a street with no people in it yet lends nobody, and says so rather than throwing', () => {
  const crowd = street(capturingRenderer());
  assert.equal(crowd.castReady, false, 'the cast has not arrived');
  assert.equal(crowd.takePerson({ character: 0, wardrobe: 0, id: 1 }), null, 'no cast is no body');
  // The cast is a download and the pavements fill before it lands, so both of these run on a real street.
  crowd.handPersonBack({ person: null });
  assert.equal(crowd.bodies(), 0, 'and nothing was lent, so nothing is in hand');
});

test('a body comes off the shelf, and goes back on it, and comes off again without being rebuilt', async () => {
  const { crowd, renderer } = await loadedStreet();
  assert.equal(crowd.castReady, true);

  const first = crowd.takePerson({ character: 0, wardrobe: 0, id: 1 });
  assert.ok(first, 'the shelf lends a body');
  assert.equal(renderer.made.meshes, 1, 'which cost one mesh upload');

  // What the frame loop does with him: put him somewhere, show him, give him a role, and skin him.
  first.place(3, 1.2, -4, 0.7);
  first.visible(true);
  first.role('walk');
  for (let i = 0; i < 20; i++) first.frame(1 / 60, 1.4);
  assert.ok(renderer.made.refreshed >= 20, 'every skinned frame reached the renderer');
  assert.ok(Number.isFinite(first.dynamic.matrix[12]), 'and he is standing where he was put');

  crowd.handPersonBack({ person: first, character: 0, wardrobe: 0 });
  assert.equal(crowd.bodies(), 1, 'parked, not destroyed: the upload is paid for already');
  assert.equal(renderer.made.destroyed, 0, 'so nothing was thrown away');
  assert.equal(first.dynamic.visible, false, 'and a parked body is not drawn');

  const again = crowd.takePerson({ character: 0, wardrobe: 0, id: 2 });
  assert.equal(again, first, 'the same face and tint asks for the same parked body');
  assert.equal(renderer.made.meshes, 1, 'which costs no second upload');
});

test('a body asked for without saying whose is a body, not a hole in the street', async () => {
  // boarding.js lends the driver of a carjacked car with nothing but an id: `takePerson({ id: 'jack' })`.
  // `undefined % n` is NaN, `characters[NaN]` is undefined, and that reached the mesh builder and threw —
  // caught by the shelf's own handler and reported as "a pedestrian could not be built from the vendored
  // models", so the man who was supposed to be pulled out of the car and thrown onto the street never
  // existed at all. Worse, that handler latches: once it has fired the street stops parking bodies and
  // starts destroying them, so one unnamed request cost the pavement its whole shelf.
  const { crowd, renderer } = await loadedStreet();
  const driver = crowd.takePerson({ id: 'jack' });
  assert.ok(driver, 'an unnamed body is still a body');
  assert.ok(driver.character, 'and it knows whose face it is wearing');

  // Two carjackings in a row are two different people: an unnamed request takes the next face round
  // rather than always the first, so the street does not throw out identical twins.
  const second = crowd.takePerson({ id: 'jack2' });
  assert.ok(second, 'and so is the next one');
  assert.notEqual(second, driver, 'two requests are two bodies');
  assert.notEqual(second.character, driver.character, 'wearing two different faces');

  // Handing one back with nothing but the body is what game.js does — the owner list and the officer list
  // both call `handPersonBack({ person })` and neither repeats the face and tint it borrowed under. He has
  // to go back to the slot he came off, or the next caller builds a new one and the shelf quietly leaks.
  const lent = crowd.bodies();
  crowd.handPersonBack({ person: driver });
  assert.equal(crowd.bodies(), lent + 1, 'he is parked rather than gone: still in hand');
  const reused = crowd.takePerson({ id: 'jack3' });
  assert.ok(reused, 'and the shelf still answers');
  assert.equal(renderer.made.removed, 0, 'with nothing destroyed on the way');
});

test('an index outside the shelf wraps onto it, from either end', async () => {
  // The crowd's own pedestrians are numbered by a lane and a station, and the officers by how many are
  // already out, so the shelf is asked for indices it was not built with. A negative one used to index
  // `characters[-1]`, which is undefined, which is the same hole in the street as an unnamed request.
  const { crowd, cast } = await loadedStreet();
  const n = cast.characters.length;
  assert.equal(n, 12, 'ten passers-by and two officers');
  for (const want of [-1, -n, n, n + 3, 2.5 * n]) {
    const person = crowd.takePerson({ character: want, wardrobe: want, id: want });
    assert.ok(person, `character ${want} still yields a body`);
    assert.ok(person.character, 'with a face on it');
    crowd.handPersonBack({ person });
  }
});

test('the officers are at the end of the shelf, where the game says they are', async () => {
  // `splitShelf` hands the game *indices*, and `stepOfficers` passes them straight to the shelf as
  // `character:`. If the two ever disagreed about which end the uniforms are on, the men walking the
  // player down would be wearing whatever the pavement wears, and nothing else would notice.
  const { crowd, cast } = await loadedStreet();
  for (const i of [10, 11]) {
    const officer = crowd.takePerson({ character: i, wardrobe: 0, id: `officer${i}` });
    assert.ok(officer, `index ${i} is on the shelf`);
    assert.equal(officer.character, cast.characters[i], 'and it is the character at that index');
    assert.equal(officer.character.police, true, 'wearing a uniform');
    crowd.handPersonBack({ person: officer });
  }
  const passer = crowd.takePerson({ character: 3, wardrobe: 0, id: 'ped' });
  assert.equal(passer.character.police, false, 'and index 3 is not');
});
