import test from 'node:test';
import assert from 'node:assert/strict';

import { createWeapon, WEAPONS, RELOAD_SECONDS, rayCapsule, spreadDir, BODY_RADIUS } from '../../web/src/game/weapons.js';

/** A world whose only solid is a wall face at x = 20, hit by nothing else. */
function world(opts = {}) {
  const out = { hit: false, dist: 0, normal: [0, 0, 0], kind: 1, body: opts.body || null };
  return {
    raycast(origin, dir, maxDist) {
      world.n = (world.n || 0) + 1;
      out.hit = false; out.dist = maxDist; out.body = opts.body || null;
      if (opts.block === undefined) return out;
      const t = (opts.block - origin[2]) / (dir[2] || 1e-9);
      if (t >= 0 && t <= maxDist) { out.hit = true; out.dist = t; }
      return out;
    },
  };
}
const crowdOf = (people) => ({ people });
const rng = (seed) => { let x = seed >>> 0; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; };
/** A standing shooter's eye: the muzzle hangs below and right of it, and a man's feet are 1.55 m under it. */
const EYE = { x: 0, y: 1.55, z: 0, yaw: 0, pitch: 0 };

test('a shot is a magazine, and the trigger answers only when the gun is ready', () => {
  const gun = createWeapon({ physics: world(), crowd: crowdOf([]), rng: rng(7) });
  assert.equal(gun.state, 'none');
  assert.equal(gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }), null, 'an unarmed man fired');
  gun.equip('pistol');
  assert.equal(gun.inMagazine, WEAPONS.pistol.magazine);
  for (let i = 0; i < 20; i++) gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 0);
  assert.equal(gun.inMagazine, WEAPONS.pistol.magazine - 1, 'six pulls with no time between them fired six shots');
  const seen = [];
  for (let i = 0; i < 40; i++) { gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 1 / 6); seen.push(gun.state); }
  assert.ok(seen.includes('cycling'), 'the slide never cycled: a gun that fires faster than its rate is not a gun');
  assert.equal(gun.inMagazine, 0);
  assert.ok(gun.needReload, 'an empty chamber did not ask for a reload');
  assert.equal(gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 1), null, 'the hammer fell on an empty chamber');
});

test('a reload is timed, cannot be interrupted into a shot, and moves brass from the pouch to the gun', () => {
  const gun = createWeapon({ physics: world(), crowd: crowdOf([]), rng: rng(3) });
  gun.equip('smg');
  for (let i = 0; i < 8; i++) gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 1);
  const loaded = gun.inMagazine, brass = gun.reserve;
  assert.ok(gun.startReload());
  assert.equal(gun.state, 'reloading');
  assert.equal(gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 0.01), null, 'a shot went off during a reload');
  for (let i = 0; i < Math.ceil(RELOAD_SECONDS.smg * 60) - 2; i++) gun.tick(1 / 60);
  assert.equal(gun.state, 'reloading', 'the reload finished early');
  for (let i = 0; i < 8; i++) gun.tick(1 / 60);
  assert.equal(gun.state, 'ready');
  assert.equal(gun.inMagazine, WEAPONS.smg.magazine);
  assert.ok(gun.reserve < brass, 'the pouch did not pay for the magazine');
  assert.ok(loaded < WEAPONS.smg.magazine);
  assert.ok(!gun.startReload(), 'a full magazine was reloaded anyway');
});

test('a bullet meets a person, and a nearer person wins the shot', () => {
  const near = { x: 0.1, y: 0, z: 3, id: 1 };
  const far = { x: -0.05, y: 0, z: 9, id: 2 };
  const hit = [];
  const gun = createWeapon({
    physics: world({ block: 40 }), crowd: crowdOf([far, near]), rng: rng(11), onHit: (s) => hit.push(s),
  });
  gun.equip('pistol');
  const r = gun.fire(EYE, 1);
  assert.equal(r.struck.length, 1, `a shot down a row of men struck ${r.struck.length} of them`);
  assert.equal(r.struck[0].person, near, 'the far man took a bullet meant for the near one');
  assert.equal(r.struck[0].kind, 'person');
  assert.ok(hit.length === 1 && hit[0].person === near, 'the callback was not told who was struck');
  // A downed man is not shot again: the crowd's own words for that are a body on the ground.
  near.down = true;
  const again = gun.fire(EYE, 1);
  assert.equal(again.struck[0].person, far, 'a shot passed through a body lying in the way');
});

test('a wall stops a bullet, and a car is a harder thing to hit than air', () => {
  const car = { kind: 3, id: 'car' };
  const gun = createWeapon({ physics: world({ block: 12, body: car }), crowd: crowdOf([{ x: 0, y: 0, z: 30 }]), rng: rng(5) });
  gun.equip('pistol');
  const r = gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 1);
  assert.equal(r.struck.length, 1);
  assert.equal(r.struck[0].kind, 'car');
  assert.equal(r.struck[0].body, car);
  assert.ok(r.struck[0].dist < 13 && r.struck[0].dist > 11, `a wall at 12 m was met at ${r.struck[0].dist}`);
});

test('the noise is reported once per trigger pull, with the aim that was actually taken', () => {
  const shots = [];
  const gun = createWeapon({ physics: world(), crowd: crowdOf([]), rng: rng(9), onShot: (i) => shots.push(i) });
  gun.equip('shotgun');
  gun.fire({ x: 1, y: 2, z: 3, yaw: Math.PI / 2, pitch: 0 }, 1);
  assert.equal(shots.length, 1);
  assert.equal(shots[0].gun, 'shotgun');
  assert.equal(shots[0].pellets.length, WEAPONS.shotgun.pellets, 'a 12-gauge threw one pellet');
  assert.ok(shots[0].origin[0] > 1.4 && shots[0].origin[0] < 1.9, `the muzzle was at x=${shots[0].origin[0]}, not ahead of a man facing +X`);
  assert.ok(Math.abs(shots[0].origin[2] - 3) < 0.3, 'the muzzle was not beside the man it belongs to');
  assert.ok(shots[0].dir[0] > 0.9, 'the reported aim was not where the eye was looking');
  gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 0);
  assert.equal(shots.length, 1, 'a refused trigger pull was reported as a shot');
});

test('the cone opens as the gun is worked and closes as the shooter waits', () => {
  const look = { yaw: 0, pitch: 0 };
  const off = (heat) => { const d = spreadDir(look, WEAPONS.pistol, heat, 0, rng(4)); return Math.hypot(d[0], d[1]); };
  const gun = createWeapon({ physics: world(), crowd: crowdOf([]), rng: rng(21) });
  gun.equip('pistol');
  const cold = [];
  for (let i = 0; i < 12; i++) cold.push(off(0));
  // One magazine, taken at the rate the gun can actually feed, and sampled before the pattern cools: the
  // last shot's own heat is the thing the cone is supposed to remember.
  for (let i = 0; i < gun.weapon.magazine; i++) gun.fire({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, 1 / gun.weapon.rate);
  const hot = [];
  for (let i = 0; i < 12; i++) hot.push(off(gun.heat));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(hot) > mean(cold) * 1.5, `the pattern barely opened: cold ${mean(cold)}, hot ${mean(hot)}`);
  assert.ok(gun.heat >= 0.9, `a full magazine of shots left the heat at ${gun.heat}`);
  for (let i = 0; i < 120; i++) gun.tick(1 / 60);
  assert.ok(gun.heat < 0.1, `two seconds of standing still did not close the pattern (${gun.heat})`);
});

test('a standing body is a capsule, and a shot at the sky misses it', () => {
  // (ox, oy, oz) is the man's feet relative to the muzzle, which is how the caller holds them.
  const man = (mx, my, mz) => [mx - 0, my - 0, mz - 0];
  const [ax, ay, az] = man(0, 0, 5);                   // a man 5 m down the +Z axis from the muzzle at 0
  // The offsets are the man's feet relative to the muzzle, which is how `oneShot` hands them over.
  const shotAt = (origin, dir, man, maxDist) =>
    rayCapsule(origin, dir, man[0] - origin[0], man[1] - origin[1], man[2] - origin[2], BODY_RADIUS, 1.75, maxDist);
  assert.equal(shotAt([0, 0, 0], [0, 1, 0], [0, 0, 5], 100), null, 'a shot straight up from five metres away hit a man standing there');
  const chest = shotAt([0, 1.3, 0], [0, 0, 1], [0, 0, 5], 100);
  assert.ok(Math.abs(chest - (5 - BODY_RADIUS)) < 1e-6, `a chest-height shot met a man at ${chest}, not at his shoulder`);
  assert.equal(shotAt([0, 2.6, 0], [0, 0, 1], [0, 0, 5], 100), null, 'a shot over a man’s head was a hit');
  const knees = shotAt([0, 0.4, 0], [0, 0, 1], [0, 0, 5], 100);
  assert.ok(knees !== null && knees > 0, 'a shot at a man’s knees missed him');
  assert.equal(shotAt([0, 1, 0], [0, 0, 1], [0, 0, 50], 4), null, 'a man 50 m away was struck by a 4 m shot');
  assert.equal(shotAt([0, 1, 4.9], [0, 0, 1], [0.9, 0, 5], 100), null, 'a man a metre to the side of the line was struck');
});

test('a gun put away is the gun you pick up, and brass goes in the bag', () => {
  const gun = createWeapon({ physics: world(), crowd: crowdOf([]), rng: rng(9) });
  gun.equip('pistol');
  for (let i = 0; i < 3; i++) { gun.fire(EYE, 1 / gun.weapon.rate); gun.tick(1 / gun.weapon.rate); }
  assert.equal(gun.inMagazine, WEAPONS.pistol.magazine - 3, 'three shots out of six left a different count');
  gun.stow();
  assert.equal(gun.armed, false, 'the gun is still in the hand');
  gun.equip('pistol');
  assert.equal(gun.inMagazine, WEAPONS.pistol.magazine - 3, 'drawing it again handed over a fresh magazine');
  assert.equal(gun.reserve, WEAPONS.pistol.reserve, 'the pouch grew in the glovebox');
  gun.issue(10);
  assert.equal(gun.reserve, WEAPONS.pistol.reserve + 10, 'bought brass did not go in the bag');
  gun.stow(); gun.equip('pistol');
  assert.equal(gun.reserve, WEAPONS.pistol.reserve + 10, 'the bag forgot what was put in it');
});
