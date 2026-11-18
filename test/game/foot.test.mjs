import test from 'node:test';
import assert from 'node:assert/strict';

import { createFoot, WALK_SPEED, RUN_SPEED, BOARD_DISTANCE } from '../../web/src/game/foot.js';

/**
 * A world of three things, all of them measured the way the game's own physics is measured: a ray that

/**
 * A world of three solids, measured the way the game's own physics measures it: a ray that answers with a
 * distance. `yaw 0` looks down +Z (the renderer's convention, camera.js), so everything a walker meets is
 * ahead of him —
 *   the kerb   z 2.0 .. 2.4, solid from y 0 to 0.2     (a step, not a wall)
 *   the wall   z 4.0 .. 4.5, solid from y 0 to 2.5      (a wall)
 *   the floor  y 0, the kerb's top at y 0.2 over its own stretch, and the water at -6 past z = 8
 * An origin inside a box answers 0, which is what Rapier does for a ray that starts in a collider.
 */
function fakeWorld() {
  const out = { hit: false, dist: 0, normal: [0, 0, 0], kind: 0, body: null };
  const BOXES = [{ z0: 2, z1: 2.4, y0: 0, y1: 0.2 }, { z0: 4, z1: 4.5, y0: 0, y1: 2.5 }];
  const top = (oz) => (oz > 2 && oz < 2.4 ? 0.2 : oz > 8 ? -6 : 0);
  const world = {
    rays: 0,
    raycast(origin, dir, maxDist) {
      world.rays++;
      out.hit = false; out.dist = maxDist; out.kind = 0; out.body = null;
      out.normal[0] = 0; out.normal[1] = 0; out.normal[2] = 0;
      const [, oy, oz] = origin, [, dy, dz] = dir;
      const len = Math.hypot(dy, dz) || 1;
      const uy = dy / len;
      if (uy < -0.9) {                                   // the floor, or the kerb's top, or the water
        const y = top(oz);
        if (oy <= y + 1e-3) return out;
        const d = (oy - y) / -uy;
        if (d > maxDist) return out;
        out.hit = true; out.dist = d; out.kind = 0; out.normal[1] = 1;
        return out;
      }
      if (Math.abs(uy) > 0.9) return out;                 // straight up: nothing there
      for (const b of BOXES) {                            // the two faces, from the side you are on
        if (oy <= b.y0 || oy >= b.y1) continue;
        if (dz > 0) { if (oz < b.z1) return face(Math.max(0, b.z0 - oz), [0, 0, -1]); }
        else if (oz > b.z0) return face(Math.max(0, oz - b.z1), [0, 0, 1]);
      }
      return out;
      function face(d, normal) {
        if (!(d >= 0 && d <= maxDist)) return out;
        out.hit = true; out.dist = d; out.kind = 1;
        out.normal[0] = normal[0]; out.normal[1] = normal[1]; out.normal[2] = normal[2];
        return out;
      }
    },
  };
  return world;
}

/** A person as the cast hands one over: the calls the crowd and the walker make, counted for the test. */
function fakePerson() {
  const p = {
    handle: 7, frames: 0, metres: 0, roles: [], placed: null, removed: false,
    stats: { vertices: 1200, triangles: 480, seed: 0 },
    dynamic: { matrix: new Float32Array(16), visible: true },
    place(x, y, z, yaw) { p.placed = [x, y, z, yaw]; return p; },
    role(name, options) { p.roles.push({ name, options }); return p; },
    frame(dt, metres) { p.frames++; p.metres += metres; return p; },
    visible(on) { p.visible = !!on; p.dynamic.visible = !!on; return p; },
    remove() { p.removed = true; },
  };
  return p;
}

function fakeCrowd(person) {
  const shelf = { taken: 0, returned: 0 };
  return {
    shelf,
    takePerson() { shelf.taken++; return person; },
    handPersonBack(entry) { shelf.returned++; entry.person.dynamic.visible = false; },
  };
}

const march = (foot, dt, n, intent) => { for (let i = 0; i < n; i++) foot.step(dt, intent); };
const walk = (foot, seconds, intent = { forward: 1 }) => march(foot, 1 / 60, Math.round(seconds * 60), intent);

test('a walker walks: the ground passes under him at walking speed, and the legs are fed metres', () => {
  const world = fakeWorld();
  const foot = createFoot({ physics: world, land: 0 });
  foot.place(0, 0, -2, 0);
  walk(foot, 1);
  assert.ok(foot.pos[2] + 2 > WALK_SPEED * 0.55 && foot.pos[2] + 2 < WALK_SPEED * 1.25,
    `one second of walking covered ${foot.pos[2]} m`);
  assert.ok(world.rays > 60, 'the walker did not ask the world whether the way was free');
  assert.equal(foot.state, 'walk');
  assert.equal(foot.pos[1], 0, `the street is flat for a metre and a half: he is at y=${foot.pos[1]}`);
});

test('a wall is a wall, and a kerb is a step', () => {
  const foot = createFoot({ physics: fakeWorld(), land: 0 });
  foot.place(0, 0, 3.7, 0);                        // facing the wall face at z = 4
  walk(foot, 4);
  assert.ok(foot.pos[2] < 4, `walked through a wall to z=${foot.pos[2]}`);
  assert.ok(foot.pos[2] > 3.7 - 0.1, `stopped a whole arm's length short of a wall he could have touched`);
  // The kerb: walked up, not stopped at. A man's hip is above a 0.2 m kerb, so nothing refuses him — the
  // floor is what changes under him, and the body has to follow the floor rather than scrape along it.
  const kerb = createFoot({ physics: fakeWorld(), land: 0 });
  kerb.place(0, 0, 0, 0);
  let onKerb = false, airFrame = false;
  for (let i = 0; i < 150; i++) {
    kerb.step(1 / 60, { forward: 1 });
    if (kerb.pos[2] > 2 && kerb.pos[2] < 2.4 && Math.abs(kerb.pos[1] - 0.2) < 0.02) onKerb = true;
    if (!kerb.grounded && kerb.pos[2] > 1.8) airFrame = true;
  }
  assert.ok(kerb.pos[2] > 2, `a 0.2 m kerb stopped a man dead at z=${kerb.pos[2]}`);
  assert.ok(onKerb, 'the body never rose with the pavement: he scraped along the kerb instead of standing on it');
  assert.ok(!airFrame, 'a 0.2 m step left a man in the air');
  walk(kerb, 3);
  assert.ok(kerb.pos[2] < 4, `walked through a wall to z=${kerb.pos[2]}`);
  assert.ok(Math.abs(kerb.pos[1]) < 0.02, `he came down off the kerb onto the flat at y=${kerb.pos[1]}`);
});

test('a man with no floor under him falls, and the landing is reported', () => {
  const landings = [];
  // `floor: -6`: the water is somewhere below and the game says where. A cast that finds it 9 m down is a
  // man in the air, and the street's own level is a fallback rather than a floor from the sky.
  // `floor: -6`: the water is somewhere below and the game says where; a walker with no floor at all is a
  // walker who drops, which is the only honest answer past the end of the island.
  const foot = createFoot({ physics: fakeWorld(), land: 0, floor: -6, onLand: (y, hard) => landings.push([y, hard]) });
  foot.place(0, 0, 8.5, 0);                        // past the edge of the island
  march(foot, 1 / 60, 12, {});
  assert.ok(foot.pos[1] < -0.1, `he was standing on nothing at y=${foot.pos[1]}`);
  assert.equal(foot.grounded, false, 'twelve frames past the edge of the world and he is already landed');
  march(foot, 1 / 60, 120, {});
  assert.ok(foot.pos[1] <= -6 + 1e-6, `the water is at -6 and he is at ${foot.pos[1]}`);
  const jump = createFoot({ physics: fakeWorld(), land: 0, onLand: (y, hard) => landings.push([y, hard]) });
  jump.place(0, 2.2, 0, 0);                        // a first-floor balcony
  march(jump, 1 / 60, 240, {});
  assert.ok(Math.abs(jump.pos[1]) < 0.02, `the street did not catch him (y=${jump.pos[1]})`);
  assert.ok(jump.grounded);
  assert.ok(landings.length > 0, 'nothing was told about a two-metre fall');
  assert.ok(landings.some(([, hard]) => hard === true), 'a fall was reported as a step');
});

test('running costs stamina, and an empty tank walks', () => {
  const foot = createFoot({ physics: fakeWorld(), land: 0 });
  foot.place(0, 0, -3, 0);                         // a short straight: a kerb ahead, and room behind
  const sprint = { forward: 1, run: 1 };
  const run = { forward: -1 };                     // and a way back, so a sprint never reaches the kerb
  walk(foot, 0.2, sprint);
  assert.ok(foot.stamina < 1, 'a sprint cost nothing');
  walk(foot, 1, sprint);
  const pace = Math.hypot(foot.vel[0], foot.vel[2]);
  assert.ok(pace > RUN_SPEED * 0.9, `a sprint settled at ${pace} m/s, no faster than a walk`);
  // The emptying is watched rather than timed, because the exact frame the tank hits zero depends on the
  // twelve frames spent getting here: a sprint held long enough must pass through a locked run and a
  // walking pace, and it must do it on its own, without the hand letting go of the key.
  let locked = false, walked = false;
  for (let i = 0; i < 60 * 20; i++) {
    foot.step(1 / 60, { forward: -1, run: 1 });
    if (foot.out) locked = true;
    if (locked && foot.gait === 0 && foot.stamina < 0.1) walked = true;
  }
  assert.ok(locked, 'a long sprint never emptied the tank');
  assert.ok(walked, 'an empty tank went straight back to running, which is the stutter the lock exists for');
  march(foot, 1 / 60, 60 * 3, run);
  assert.equal(foot.out, false, 'the run stayed locked out after three seconds of rest');
  march(foot, 1 / 60, 60 * 11, run);
  assert.ok(foot.stamina > 0.9, `the wind never came back (${foot.stamina})`);
  march(foot, 1 / 60, 60, sprint);
  assert.equal(foot.gait, 1, 'a rested man could not start running');
});

test('the body is the cast’s, borrowed from the street and given back', () => {
  const person = fakePerson();
  const crowd = fakeCrowd(person);
  const foot = createFoot({ physics: fakeWorld(), crowd, land: 0 });
  assert.equal(foot.attach(null, {}), person);
  assert.equal(crowd.shelf.taken, 1);
  assert.equal(crowd.shelf.returned, 0);
  foot.place(1, 0, 0, 0.5);
  walk(foot, 0.5);
  assert.ok(person.frames > 0, 'the body was never animated');
  assert.ok(person.metres > 0.1, `the legs were fed ${person.metres} m of walking`);
  assert.equal(Math.round(person.placed[2] * 100) / 100, Math.round(foot.pos[2] * 100) / 100,
    'the body was left behind by the walker');
  assert.equal(person.placed[3], 0.5, 'the body did not turn with the walker');
  assert.ok(person.roles.some((r) => r.name === 'walk'), 'a walking man with no walk clip');
  foot.letGo();
  assert.equal(crowd.shelf.returned, 1, 'a borrowed body was not given back');
  assert.equal(person.removed, false, 'a borrowed body was destroyed as well as returned');
});

test('a body that is not borrowed is removed, and no body at all is not an error', () => {
  const made = fakePerson();
  const foot = createFoot({ physics: fakeWorld(), land: 0 });   // no crowd: nothing to borrow from
  const built = foot.attach(null, { note: 'renderer' }, (renderer, cast, index, options) => {
    assert.equal(options.height, 1.78);
    void renderer; void cast; void index;
    return made;
  });
  assert.equal(built, made);
  assert.equal(foot.borrowed, false);
  walk(foot, 0.1);
  foot.letGo();
  assert.equal(made.removed, true, 'a body the player owned was left in the world');

  const bare = createFoot({ physics: fakeWorld(), land: 0 });
  assert.equal(bare.attach(null, null), null, 'a walker needs a renderer before he can be built');
  walk(bare, 0.5, { forward: 1 });                               // and he walks anyway
  assert.ok(bare.pos[2] > 0.5);
});

test('a car at the kerb is something to get into, and a moving one is not', () => {
  const foot = createFoot({ physics: fakeWorld(), land: 0 });
  foot.place(0, 0, 0, 0);
  foot.step(1 / 60, {}, { x: 1.2, z: 0, yaw: 0, speed: 0 });
  assert.ok(foot.near && foot.near.distance < 1.3, 'a car at arm’s length was not offered');
  foot.step(1 / 60, {}, { x: BOARD_DISTANCE + 1, z: 0, yaw: 0, speed: 0 });
  assert.equal(foot.near, null, 'a car eight metres away was offered');
  foot.step(1 / 60, {}, { x: 0.5, z: 0, yaw: 0, speed: 22 });
  assert.equal(foot.near, null, 'a boarding pass was offered for a car at 50 mph');
});

test('the camera hangs behind him and the eye is where a man’s is', () => {
  const foot = createFoot({ physics: fakeWorld(), land: 0 });
  foot.place(0, 0, 0, 0);                        // looking down +Z at the wall
  const eye = foot.eye();
  assert.ok(eye[1] > 1.5 && eye[1] < 1.9, `a camera at eye height ${eye[1]}`);
  const cam = foot.camera();
  assert.ok(cam[2] < foot.pos[2], 'the camera was in front of the man it follows');
  const back = foot.pos[2] - cam[2];
  assert.ok(back > 1 && back < 4.5, `the camera was ${back} m away, not over a shoulder`);
  const aim = foot.aim();
  assert.ok(Math.abs(aim[2] - 1) < 0.05 && Math.abs(aim[0]) < 0.05, 'a bullet left in a direction the eye was not looking');
  // The same ray that stops the feet stops the eye: a camera inside a wall is a wall of nothing.
  // Something *behind* him is what a third-person camera has to dodge: the eye looks away from the wall,
  // and the camera hangs in the wall unless the cast is answered.
  const close = createFoot({ physics: fakeWorld(), land: 0 });
  close.place(0, 0, 3.7, Math.PI);                 // back against the wall at z = 4, looking down -Z
  const ducked = close.camera();
  assert.ok(ducked[2] > close.pos[2], 'the camera went through the man into the wall behind him');
  const pulled = ducked[2] - close.pos[2];
  assert.ok(pulled < 1.2, `the camera hung ${pulled} m out, inside the wall it was looking at`);
});

test('no physics at all still walks, because the world may not be up yet', () => {
  const foot = createFoot({ land: 3.5 });
  foot.place(0, 3.5, 0, 0);
  walk(foot, 1);
  assert.ok(foot.pos[2] > 1, 'a walker with no world could not walk');
  assert.equal(foot.pos[1], 3.5, 'he fell through the street the game says it is at');
});
