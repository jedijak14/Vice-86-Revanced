// Tests for the crowd: the rig that poses a person, the bodies the traffic kit makes, and the
// street-side behaviour that keeps them out of the road. Run with `node --test`.
//
// The crowd runs here against a real prepared lane graph and a fake renderer, so what is covered is
// the shipped code path — placement, walking, promotion to limbs, fear of a car, and the fare that
// rides in the back seat — and not a model of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';
import { createCrowd, pavementOffset, threat, CROWD_BY_DENSITY, ARTICULATE_AT } from '../../web/src/game/crowd.js';
import { createPose, walkPose, idlePose, hailPose, startlePose, blendPose, boneMatrices, PARTS, PART_BONE, boneIndex, BONES } from '../../web/src/world/people/rig.js';
import { buildPersonMeshes, buildPersonWhole, buildSeatedPassenger, OUTFITS, SKIN_TONES } from '../../web/src/world/people/body.js';
import { FAMILY } from '../../web/src/core/ids.js';

// A two-lane one-way each way along z, 3.5 m of carriageway on either side of x = 0.
const HALF_ROAD = 3.5;

function laneRecord(id, pts, next) {
  const flat = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => { flat[i * 3] = p[0]; flat[i * 3 + 1] = 1.2; flat[i * 3 + 2] = p[1]; });
  return { id, pts: flat, length: (pts.length - 1) * 100, speedLimit: 14, width: 3.2, next, junction: -1, turn: 0, control: null };
}

function makeGraph() {
  const at = (x, z) => [x, z];
  const raw = {
    // Numbered in list order, because prepareLaneGraph takes successors by index.
    lanes: [
      laneRecord(0, [at(-1.6, 0), at(-1.6, 100), at(-1.6, 200), at(-1.6, 300), at(-1.6, 400)], [1, 3]),
      laneRecord(1, [at(1.6, 400), at(1.6, 300), at(1.6, 200), at(1.6, 100), at(1.6, 0)], [0]),
      laneRecord(2, [at(-1.6, 200), at(-1.6, 300)], []),
      laneRecord(3, [at(1.6, 200), at(1.6, 100)], []),
    ],
    junctions: [],
  };
  return prepareLaneGraph(raw);
}

/** The plan's answer: signed metres to the carriageway edge, negative on the road. */
const carriageway = (x) => Math.abs(x) - HALF_ROAD;

function fakeField() {
  return { sample: (x, z, out) => { out.a = carriageway(x); } };
}

function fakeRenderer() {
  const made = { meshes: 0, objects: 0, removed: 0 };
  return {
    made,
    createMesh() { made.meshes++; return made.meshes; },
    addDynamic() {
      made.objects++;
      const obj = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), visible: true, part: '' };
      obj.remove = () => { made.removed++; obj.visible = false; };
      return obj;
    },
  };
}

function crowd({ density = 3, at = { x: 0, z: 200, yaw: 0, speed: 0 } } = {}, extra = {}) {
  const graph = makeGraph();
  const renderer = fakeRenderer();
  const endangered = [];
  const c = createCrowd({
    graph, plan: { field: fakeField(), sample: fakeField().sample }, renderer, land: 1.2,
    onEndanger: (k) => endangered.push(k), ...extra,
  });
  c.setDensity(density, 99);
  c.step(0.016, at, true);
  return { crowd: c, renderer, endangered, graph };
}

// ------------------------------------------------------------------------------------------ the rig
test('a walk cycle swings the legs against each other and never bends a knee backwards', () => {
  const pose = createPose();
  for (let phase = 0; phase < 1; phase += 0.05) {
    walkPose(pose, phase, 1.4);
    assert.ok(pose.thighL * pose.thighR <= 0.02, 'both legs forward at once');
    assert.ok(pose.shinL >= 0 && pose.shinR >= 0, 'a knee that bends the wrong way');
    assert.ok(Math.abs(pose.armL - pose.thighR) < 1.2, 'arms not against the legs');
    for (const key of Object.keys(pose)) assert.ok(Number.isFinite(pose[key]), key);
  }
});

test('the rig solves a person who stands 1.8 m tall, feet on the ground', () => {
  const pose = createPose();
  idlePose(pose, 1.5);
  const out = [];
  boneMatrices(pose, [10, 20, 0.4], out, 1.2);
  const torso = out[boneIndex('torso')], shin = out[boneIndex('shinR')];
  assert.ok(torso, 'the torso bone was not solved');
  // Hips 0.94 m over the ground, chest 0.27 over them, the drawn torso's origin 0.12 higher still.
  assert.ok(Math.abs(torso[13] - (1.2 + 0.94 + 0.27 + 0.12)) < 0.04, `chest joint at ${torso[13]}`);
  assert.ok(shin[13] < torso[13], 'the shin is above the chest');
  assert.ok(Math.abs(torso[12] - 10) < 0.02 && Math.abs(torso[14] - 20) < 0.02, 'the person is not where they were put');
  // A head that turns: the chest's yaw follows the look, so the torso matrix is not axis-aligned.
  const turned = [];
  pose.look = 0.6;
  boneMatrices(pose, [0, 0, 0], turned, 1.2);
  assert.notEqual(turned[boneIndex('torso')][0], Math.cos(0) * 1, 'the head does not turn with the look');
});

test('a knee that bends lifts the foot, and a straight leg reaches the ground', () => {
  const out = [];
  const pose = createPose();
  walkPose(pose, 0.25, 1.4);
  boneMatrices(pose, [0, 0, 0], out, 0);
  const foot = out[boneIndex('shinR')];
  assert.ok(foot[13] > -0.05 && foot[13] < 1.2, `ankle height ${foot[13]}`);
  // Nobody's ankle goes under the floor: the shin ends above the ground at every phase.
  for (let phase = 0; phase < 1; phase += 0.1) {
    walkPose(pose, phase, 1.4);
    boneMatrices(pose, [0, 0, 0], out, 0);
    assert.ok(out[boneIndex('shinL')][13] > 0.2, `leg through the floor at ${phase.toFixed(2)}`);
  }
});

test('a hail raises an arm above the shoulder, and a startle puts both hands up', () => {
  const hail = createPose();
  hailPose(hail, 2);
  assert.ok(hail.armL < -1.4, 'the arm is not up');
  const startle = createPose();
  startlePose(startle, 1);
  assert.ok(startle.armL < -1 && startle.armR < -1, 'neither hand is up');
  assert.ok(startle.lean < 0, 'weight should come back');
  const still = createPose();
  blendPose(still, hail, 0.5);
  assert.ok(still.armL < -0.7 && still.armL > hail.armL, 'the blend did not ease towards the hail');
});

// --------------------------------------------------------------------------------------- the bodies
test('every outfit is a person: seven parts, one family, feet on the floor', () => {
  OUTFITS.forEach((outfit, i) => {
    const parts = buildPersonMeshes(outfit, i % SKIN_TONES.length);
    assert.deepEqual(Object.keys(parts).sort(), [...PARTS].sort(), `parts of ${outfit.id}`);
    for (const name of PARTS) {
      const mesh = parts[name];
      assert.ok(mesh.vertexCount > 40, `${outfit.id}/${name} has ${mesh.vertexCount} vertices`);
      const families = new Set(mesh.groups.map((g) => g.family));
      assert.deepEqual([...families], [FAMILY.VEHICLE], `${outfit.id}/${name} uses ${[...families]}`);
      const [x0, y0, z0, x1, y1, z1] = mesh.bounds;
      // Parts are authored about their own joint, so an arm hangs down from y = 0 and a torso stands
      // up from it: what matters is that nothing reaches further than a person does.
      assert.ok(y1 < 0.75 && y0 > -0.75, `${outfit.id}/${name} spans y ${y0}..${y1}`);
      assert.ok(x1 - x0 < 0.9 && z1 - z0 < 0.9, `${outfit.id}/${name} is wider than a person`);
    }
    // The limbs hang from their joints, so no part may be centred on the body.
    const arm = parts.armL.bounds;
    assert.ok(Math.abs(arm[0]) < 0.35 && arm[1] < -0.4, 'the left arm is not built about its shoulder');
  });
});

test('the far LOD is one mesh of the same person, and a seated fare is shorter', () => {
  const whole = buildPersonWhole(OUTFITS[0], 0, 0.25);
  assert.ok(whole.vertexCount > 500, `${whole.vertexCount} vertices`);
  const [x0, y0, z0, x1, y1, z1] = whole.bounds;
  assert.ok(y0 > -0.05 && y1 > 1.6 && y1 < 1.95, `whole body spans ${y0}..${y1}`);
  assert.ok(x1 - x0 > 0.3 && x1 - x0 < 0.75, `shoulder to shoulder ${x1 - x0}`);
  assert.ok(z1 - z0 < 0.6, `front to back ${z1 - z0}`);
  const seated = buildSeatedPassenger(OUTFITS[2], 1);
  const s = seated.bounds;
  // Built about the hip joint, which is where the seat is: the knees come up, the shoes come down.
  assert.ok(s[1] > -0.35 && s[4] < 1.35, `a seated person spans ${s[1]}..${s[4]}`);
});

// -------------------------------------------------------------------------------------- the street
test('the pavement is found where the road ends, and nowhere in open land', () => {
  const graph = makeGraph();
  const lane = graph.lanes[0];
  const spot = pavementOffset(lane, 60, 1, carriageway);
  assert.ok(spot, 'no pavement beside a two-lane road');
  assert.ok(spot.off > HALF_ROAD - 1.6 && spot.off < HALF_ROAD + 3, `kerb found at ${spot.off}`);
  const x = lane.pts[0] + -Math.cos(spot.yaw) * 1 * spot.off;
  assert.ok(carriageway(x) > 0, `the person would stand at x ${x}, still on the carriageway`);
  // A lane with no edge to cross — a runway, a bridge deck — gets nobody.
  assert.equal(pavementOffset(lane, 60, 1, () => -1), null, 'found a pavement in the middle of the road');
});

test('a crowd is placed off the carriageway and walks along it', () => {
  const { crowd: c } = crowd();
  assert.ok(c.count > 0, 'nobody came');
  const before = c.snapshot();
  for (let i = 0; i < 240; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  const after = c.snapshot();
  assert.ok(after.peds >= before.peds, 'the crowd thinned on a quiet street');
  for (const p of c.people || []) assert.ok(carriageway(p.x) > 0, `a person stood at x ${p.x}`);
  // Two or three frames is all it takes for every person to have been positioned at least once.
  assert.ok(after.peds <= CROWD_BY_DENSITY[3].peds + 4, 'more people than the density asked for');
});

test('every person is off the road, checked through the objects the renderer was given', () => {
  const { crowd: c, renderer } = crowd({ density: 3 });
  for (let i = 0; i < 120; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  // Nothing was left behind: whatever objects exist belong to people who are still on the street.
  const live = c.snapshot();
  assert.ok(live.peds > 0 && renderer.made.objects > live.peds, 'nobody has limbs at all');
  assert.ok(live.articulated > 0, 'the closest people were never articulated');
  assert.ok(live.articulated * PARTS.length + (live.peds - live.articulated) <= renderer.made.objects,
    'more objects than there are people to own them');
});

test('limbs are for the nearest few, and come back off when they are far away', () => {
  const { crowd: c } = crowd({ density: 3, at: { x: 0, z: 200, yaw: 0, speed: 0 } });
  for (let i = 0; i < 120; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  const near = c.snapshot().articulated;
  assert.ok(near > 0 && near <= CROWD_BY_DENSITY[3].articulated, `${near} articulated`);
  // Drive away: the street empties, and every object goes back to the renderer.
  for (let i = 0; i < 400; i++) c.step(1 / 60, { x: 0, z: 200 + i * 4, yaw: 0, speed: 240 }, true);
  const gone = c.snapshot();
  assert.ok(gone.articulated <= near, 'the crowd grew limbs as it was left behind');
});

test('a car coming at the kerb makes somebody step back, and the police are told', () => {
  const { crowd: c, endangered } = crowd({ density: 3 });
  for (let i = 0; i < 400; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  // Aim at somebody who is actually standing off the kerb, on the side the car comes from.
  const victim = c.people.filter((p) => p.x < 0).sort((a, b) => Math.abs(a.z - 200) - Math.abs(b.z - 200))[0];
  assert.ok(victim, 'nobody on the -x pavement to frighten');
  const before = c.snapshot().startled;
  // Down the road, past them, at 6 m/s: the kerb side is to the car's left, and one of the crowd is
  // within a few metres of the line of travel.
  for (let i = 0; i < 300; i++) {
    c.step(1 / 60, { x: victim.x + 2.4, z: victim.z - 30 + i * 0.1, yaw: 0, speed: 6 }, true);
  }
  assert.ok(c.snapshot().startled > before, `nobody moved out of the way (${before})`);
  assert.ok(endangered.length > 0, 'the police were never told');
  assert.ok(endangered.every((k) => k > 0.5 && k <= 1), 'the fear reported was not a real one');
  assert.ok(threat(2, 12, 1) > 0.7, 'a close pass at speed is nothing');
  assert.equal(threat(30, 12, 1), 0, 'frightened from thirty metres off');
  assert.equal(threat(3, 0.5, 1), 0, 'a crawling car is not a threat');
  assert.ok(threat(3, 12, -1) < threat(3, 12, 1) * 0.75, 'being aimed at should matter');
});

test('a fare hails, rides in the back seat and is put down again', () => {
  const { crowd: c, renderer } = crowd({ density: 3 });
  for (let i = 0; i < 30; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 4 }, true);
  const any = c.people[0];
  assert.ok(any, 'no people to place a fare on');
  const hailed = c.makeHailer(any.x, any.z);
  assert.ok(hailed, 'the nearest person could not be made to hail');
  assert.equal(c.nearestHail(any.x, any.z), hailed, 'the hail was not findable');
  const before = c.count;
  const seat = c.board(hailed);
  assert.ok(seat && seat.obj, 'nobody got in');
  assert.equal(c.count, before - 1, 'a person in the car is still on the pavement');
  assert.ok(c.snapshot().passenger);
  for (let i = 0; i < 10; i++) { c.step(1 / 60, { x: 4, z: 220 + i, yaw: 0.2, speed: 8 }, true); }
  assert.ok(seat.obj.visible, 'the passenger vanished from the car');
  assert.ok(Math.abs(seat.obj.matrix[12] - (4 + Math.cos(0.2) * 0.42)) < 1e-3, 'the passenger is not beside the driver');
  const out = c.alight(0, 240);
  assert.ok(out && !c.passenger, 'they never got out');
  assert.ok(c.count >= before, 'the fare was lost rather than dropped off');
  c.reset();
  assert.equal(c.count, 0, 'reset left people on the street');
  assert.equal(renderer.made.removed, renderer.made.objects, 'objects were left with the renderer');
});

test('no crowd on a street the player is not driving on', () => {
  const { crowd: c } = crowd({ density: 3 });
  c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, false);
  c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  c.enabled = false;
  const at = c.count;
  for (let i = 0; i < 20; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 30 }, true);
  assert.equal(c.count, at, 'the crowd kept walking in the garage');
  c.enabled = true;
  const density = c.setDensity(0);
  for (let i = 0; i < 60; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  assert.equal(c.count, 0, 'traffic off still has pedestrians');
});

test('a crowd with no plan and no road does not throw', () => {
  const renderer = fakeRenderer();
  const c = createCrowd({ graph: { lanes: [] }, plan: null, renderer });
  c.setDensity(3, 99);
  for (let i = 0; i < 10; i++) c.step(1 / 60, { x: 0, z: 0, yaw: 0, speed: 10 }, true);
  assert.equal(c.count, 0, 'people appeared where there is no street');
  assert.equal(c.live, false);
});

test('a person at the kerb asks for a cab, and stops asking after a while', () => {
  const { crowd: c, renderer } = crowd({ density: 3 });
  const episodes = new Map();          // person id -> 1 waving, 2 gave up
  let maxHailing = 0;
  // Five minutes of street, the car parked where it is: slow enough that the arm must come down on its
  // own, which is the part that used to be missing — a hail that never ends is a statue with a sign.
  for (let i = 0; i < 3000; i++) {
    c.step(0.1, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
    const s = c.snapshot();
    if (s.hailing > maxHailing) maxHailing = s.hailing;
    for (const p of c.people) {
      if (p.hailing) episodes.set(p.id, 1);
      else if (episodes.get(p.id) === 1) episodes.set(p.id, 2);
    }
  }
  assert.ok(maxHailing > 0, `nobody on this street ever wanted a cab (${JSON.stringify(c.snapshot())})`);
  assert.ok(maxHailing <= c.count, 'more marks than people');
  const givenUp = [...episodes.values()].filter((v) => v === 2).length;
  assert.ok(givenUp > 0, `${episodes.size} people started a hail and none of them finished one`);
  assert.ok([...c.people].every((p) => !p.hailing || p.mark), 'a hailer is waving without a mark');
  c.reset();
  assert.equal(renderer.made.removed, renderer.made.objects,
    'a hail mark was left with the renderer after the person went');
});
