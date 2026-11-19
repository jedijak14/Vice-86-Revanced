// Which way the view turns, and what the gun follows.
//
// Two conventions share one pipe in game/input.js: the garage *orbits* (the finger grabs the car and
// spins it, so the eye goes the other way) and a man on foot has a *neck* (the view goes where the hand
// goes). Feeding the walker the turntable's signs is what made on-foot controls feel inverted -- the feet
// turn towards a heading the eyes were pulled away from, and every step was a correction. `lookMode` is
// the switch, and this file is the pin: a drag right must raise `look.yaw` for a neck and lower it for an
// orbit, the right stick must agree with the drag in each mode, and the bullet, the shoulder camera and
// the eye must all read the same pitch, with a positive pitch meaning up in all four places.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createInput } from '../../web/src/game/input.js';
import { createFoot } from '../../web/src/game/foot.js';
import { spreadDir } from '../../web/src/game/weapons.js';

const HEIGHT = 400;                 // CSS px of picture the drags are measured against
const DRAG = 2.6;                   // rad for a drag the height of the picture (input.js LOOK_DRAG)

/** One finger, from (x0,y0) to (x1,y1), through the same handlers the page calls. */
function drag(input, x0, y0, x1, y1) {
  input.handlePointer('down', 1, x0, y0, HEIGHT);
  input.handlePointer('move', 1, x1, y1, HEIGHT);
}

function lookAfter(input, mode, x0, y0, x1, y1) {
  input.lookMode = mode;
  input.looking = true;
  drag(input, x0, y0, x1, y1);
  input.update(1 / 60, 0);
  return { ...input.look };
}

test('a neck turns with the hand; a turntable spins the car against it', () => {
  const neck = lookAfter(createInput(), 'neck', 100, 100, 200, 100);      // 100 px to the right
  const orbit = lookAfter(createInput(), 'orbit', 100, 100, 200, 100);
  const expected = 100 * DRAG / HEIGHT;
  assert.ok(neck.yaw > 0, 'dragging right must turn a walker to the right, not the left');
  assert.ok(orbit.yaw < 0, 'the garage still grabs the car and brings its left side round');
  assert.ok(Math.abs(neck.yaw - expected) < 1e-9 && Math.abs(orbit.yaw + expected) < 1e-9);

  const up = lookAfter(createInput(), 'neck', 100, 200, 100, 100);         // 100 px up
  const down = lookAfter(createInput(), 'neck', 100, 100, 100, 200);
  assert.ok(up.pitch > 0 && down.pitch < 0, 'drag up raises the eye, drag down drops it');
  const garageUp = lookAfter(createInput(), 'orbit', 100, 200, 100, 100);
  assert.ok(garageUp.pitch < 0, 'in the garage a drag up takes the camera down under the car');
});

test('the right stick agrees with the drag, mode for mode', () => {
  const pad = (x, y) => ({
    connected: true,
    buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })),
    axes: [0, 0, x, y, 0, 0, 0, 0, 0, 0],
  });
  for (const [mode, stickYaw, stickPitch] of [['neck', 1, -1], ['orbit', -1, -1]]) {
    const input = createInput({ getGamepads: () => [pad(1, 0)] });
    input.looking = true; input.lookMode = mode;
    input.update(1 / 60, 0);
    const turned = input.look.yaw;
    assert.ok((stickYaw > 0) === (turned > 0), `${mode}: stick right must ${turned > 0 ? 'turn right' : 'swing the car round left'} (yaw ${turned.toFixed(3)})`);
    const pitch = createInput({ getGamepads: () => [pad(0, -1)] });   // stick up is negative on a pad
    pitch.looking = true; pitch.lookMode = mode;
    pitch.update(1 / 60, 0);
    assert.ok((stickPitch < 0) === (pitch.look.pitch > 0), `${mode}: stick up must raise the eye (pitch ${pitch.look.pitch.toFixed(3)})`);
    assert.ok(pitch.look.held, 'a stick on the look axis counts as held, so the camera knows to follow');
  }
});

test('a turn is spent once, and a view at rest stays put', () => {
  const input = createInput();
  input.looking = true; input.lookMode = 'neck';
  drag(input, 100, 100, 260, 140);
  input.update(1 / 60, 0);
  assert.ok(input.look.yaw !== 0 && input.look.pitch !== 0);
  input.update(1 / 60, 0);                                    // the finger is still down, but it did not move
  assert.equal(input.look.yaw, 0, 'a held finger must not keep turning the head');
  assert.equal(input.look.pitch, 0);

  input.looking = false;
  drag(input, 0, 0, 300, 300);
  input.update(1 / 60, 0);
  assert.equal(input.look.yaw, 0, 'nothing is gathered while the view belongs to something else');
  assert.equal(input.look.held, false);
});

test('a pinch is zoom in either mode and never a turn', () => {
  for (const mode of ['neck', 'orbit']) {
    const input = createInput();
    input.looking = true; input.lookMode = mode;
    input.handlePointer('down', 1, 100, 100, HEIGHT);
    input.handlePointer('down', 2, 100, 300, HEIGHT);
    input.handlePointer('move', 1, 160, 160, HEIGHT);          // the two fingers came together
    input.update(1 / 60, 0);
    assert.ok(input.look.zoom < 0, `${mode}: fingers together zooms out, and yaw is not involved`);
    assert.equal(input.look.yaw, 0);
    assert.equal(input.look.pitch, 0);
  }
});

/** A world with no colliders at all, but one that remembers which way each cast was sent. */
function emptyWorld() {
  const sent = [];
  return {
    sent,
    raycast(origin, dir, maxDist) {
      sent.push({ origin: [...origin], dir: [...dir], maxDist });
      return { hit: false, dist: maxDist, normal: [0, 1, 0], kind: 0, body: null };
    },
  };
}

test('the eye, the shoulder camera and the bullet share one pitch', () => {
  const world = emptyWorld();
  const foot = createFoot({ physics: world, land: 0 });
  foot.place(10, 0, 20, 0);
  const eye = foot.eye([0, 0, 0]).slice();

  foot.look.pitch = 0.4;                                      // up
  const up = foot.aim([0, 0, 0]);
  assert.ok(up[1] > 0, 'a positive pitch raises the eye, so a bullet leaves upward');
  const camUp = foot.camera([0, 0, 0]);
  assert.ok(camUp[1] < eye[1] + 1e-6, 'looking up means the camera sits under the shoulder, not over it');
  const castUp = world.sent[world.sent.length - 1].dir;
  assert.ok(castUp[1] < 0, 'and the cast that looks for a wall goes back down the view, not up it');

  foot.look.pitch = -0.4;                                     // down
  const down = foot.aim([0, 0, 0]);
  assert.ok(down[1] < 0);
  const camDown = foot.camera([0, 0, 0]);
  assert.ok(camDown[1] > eye[1] + 1e-6, 'looking down lifts the camera over the head');
  const castDown = world.sent[world.sent.length - 1].dir;
  assert.ok(castDown[1] > 0);

  assert.ok(Math.abs(Math.hypot(...up) - 1) < 1e-9, 'the aim vector is a direction, not a step');
  // The gun's own muzzle pattern is measured off the same view: forward, right and up.
  const look = { yaw: 0.7, pitch: 0.4 };
  const zero = { spread: 0, move: 0 };
  const shot = spreadDir(look, zero, 0, 0, () => 0, [0, 0, 0]);
  const at = [0, 0, 0];
  foot.look.yaw = look.yaw; foot.look.pitch = look.pitch;
  const sighted = foot.aim(at);
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(shot[k] - sighted[k]) < 1e-9, `shot axis ${k}: ${shot[k]} vs ${sighted[k]}`);
});

test('the spread opens sideways and up, never fore and aft', () => {
  // At 45 degrees of pitch the old `up` was parallel to the view, so the pattern collapsed onto the
  // sight line: a man shooting at a first-floor window missed by being nearer rather than higher.
  const weapon = { spread: 0.12, move: 0 };
  for (const pitch of [0, 0.4, Math.PI / 4, -0.7]) {
    const look = { yaw: 0.9, pitch };
    const forward = spreadDir(look, { spread: 0, move: 0 }, 0, 0, () => 0, [0, 0, 0]);
    const radius = Math.sqrt(0.5) * weapon.spread;               // what `r` will be: sqrt(rng(2)) · half
    const shots = [0, 0.25, 0.5, 0.75].map((quarter) => {
      let i = 0;
      const rng = (n) => (n === 1 ? quarter : 0.5);              // the angle, then a fixed pattern radius
      return spreadDir(look, weapon, 0, 0, rng, [0, 0, 0]);
    });
    for (const [k, off] of shots.entries()) {
      assert.ok(Math.abs(Math.hypot(...off) - 1) < 1e-9, `shot ${k}: a spread shot is a direction`);
      const dot = Math.max(-1, Math.min(1, off[0] * forward[0] + off[1] * forward[1] + off[2] * forward[2]));
      const angle = Math.acos(dot);
      assert.ok(Math.abs(angle - radius) < 1e-3,
        `pitch ${pitch.toFixed(2)}, shot ${k}: ${(angle * 180 / Math.PI).toFixed(2)}° off the sight line, ${(radius * 180 / Math.PI).toFixed(2)}° asked for`);
    }
    // Quarter turn apart, they go right, up, left, down -- so the up-and-down pair separates in Y and the
    // left-and-right pair does not, and none of them is merely nearer or further.
    assert.ok(shots[1][1] > forward[1], `the 90° shot is above the sight line at pitch ${pitch.toFixed(2)}`);
    assert.ok(shots[3][1] < forward[1], 'and the 270° shot below it');
    assert.ok(Math.abs(shots[0][1] - shots[2][1]) < 1e-9, 'the 0° and 180° shots stand at one height: pure sideways');
    assert.ok(Math.hypot(shots[0][0] - shots[2][0], shots[0][2] - shots[2][2]) > 1e-3, 'and the pair straddles the sight line');
  }
});

test('feet turn towards the head, so a drag steers rather than fights', () => {
  const foot = createFoot({ physics: emptyWorld(), land: 0 });
  foot.place(0, 0, 0, 0);
  foot.look.yaw = 0;
  for (let i = 0; i < 30; i++) foot.step(1 / 30, { forward: 1, turn: 0 });
  const straight = [foot.pos[0], foot.pos[2]];
  assert.ok(Math.abs(straight[0]) < 1e-6 && straight[1] > 1, `walking at yaw 0 goes down +Z (${straight})`);

  const turning = createFoot({ physics: emptyWorld(), land: 0 });
  turning.place(0, 0, 0, 0);
  for (let i = 0; i < 30; i++) {
    turning.look.yaw = 0.6;                                    // the neck leads, as a drag does
    turning.step(1 / 30, { forward: 1 });
  }
  assert.ok(turning.yaw > 0.3, 'the feet follow the eyes round towards the turn');
  assert.ok(turning.pos[0] > 0.2, `and the man ends up to the right of where he started (${turning.pos[0].toFixed(2)})`);
});
