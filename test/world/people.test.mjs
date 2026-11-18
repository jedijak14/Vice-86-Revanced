// Tests for the crowd: the street-side behaviour that keeps people out of the road, and the bodies they
// are drawn with. Run with `node --test`.
//
// The crowd runs here against a real prepared lane graph, a fake renderer and a fake cast, so what is
// covered is the shipped code path -- placement, walking, who gets a body this frame, fear of a car, the
// fare that rides in the back seat -- and not a model of it. The cast is fake because the real one is a
// download: the models themselves are tested in cast.test.mjs, against the files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLaneGraph } from '../../web/src/game/lanes.js';
import { createCrowd, pavementOffset, threat, CROWD_BY_DENSITY, ARTICULATE_AT, PEOPLE_BY_TIER } from '../../web/src/game/crowd.js';
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
  const made = { meshes: 0, objects: 0, removed: 0, refreshes: 0 };
  return {
    made,
    createMesh() { made.meshes++; return made.meshes; },
    destroyMesh() { made.meshes--; },
    refreshMesh() { made.refreshes++; return true; },
    addDynamic() {
      made.objects++;
      const obj = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), visible: true, part: '' };
      obj.remove = () => { made.removed++; obj.visible = false; };
      return obj;
    },
  };
}

/**
 * A cast shaped like the real one: a rigged eight-vertex figure the production `newPerson` can build a
 * person out of, without three megabytes of glTF being part of a behaviour test.
 */
function fakeCast(characters = 2) {
  const nodes = [{ name: 'root' }, { name: 'hips' }, { name: 'chest' }, { name: 'head' }];
  const rig = {
    gltf: { nodes }, joints: [1, 2, 3], parents: Int32Array.from([-1, 0, 1, 2]),
    bones: new Float32Array(3 * 16),
    node: (n) => nodes.findIndex((x) => x.name === n),
    nodes: (names) => new Set(names.map((n) => nodes.findIndex((x) => x.name === n)).filter((i) => i >= 0)),
    solve() { return this.bones; },
  };
  const character = () => ({
    name: 'Test', gltf: rig.gltf, rig,
    vertexCount: 8, authored: 2, bounds: [-0.4, 0, -0.2, 0.4, 2, 0.2],
    positions: Float32Array.from([-0.2, 0, 0, 0.2, 0, 0, 0.2, 2, 0, -0.2, 2, 0, -0.2, 0, 0.2, 0.2, 0, 0.2, 0.2, 2, 0.2, -0.2, 2, 0.2]),
    normals: new Float32Array(24).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)),
    colors: new Array(24).fill(200),
    joints: new Uint8Array(32), weights: new Uint8Array(32).fill(255),
    triangles: Int32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]),
  });
  return { characters: Array.from({ length: characters }, character), clips: [], bytes: 1024, licences: ['test: CC0'] };
}

function crowd({ density = 3, at = { x: 0, z: 200, yaw: 0, speed: 0 } } = {}, extra = {}) {
  const graph = makeGraph();
  const renderer = fakeRenderer();
  const endangered = [];
  const c = createCrowd({
    graph, plan: { field: fakeField(), sample: fakeField().sample }, renderer, land: 1.2,
    onEndanger: (k) => endangered.push(k), people: fakeCast(), ...extra,
  });
  c.setDensity(density, 99);
  c.step(0.016, at, true);
  return { crowd: c, renderer, endangered, graph };
}

// ------------------------------------------------------------------------------------------ the street

test('the pavement is found where the road ends, and nowhere in open land', () => {
  const lane = makeGraph().lanes[0];
  const spot = pavementOffset(lane, 60, 1, carriageway);
  assert.ok(spot, 'no pavement beside a two-lane road');
  assert.ok(spot.off > HALF_ROAD - 1.6 && spot.off < HALF_ROAD + 3, `kerb found at ${spot.off}`);
  const x = lane.pts[0] + -Math.cos(spot.yaw) * 1 * spot.off;
  assert.ok(carriageway(x) > 0, `the person would stand at x ${x}, still on the carriageway`);
  // A lane with no edge to cross -- a runway, a bridge deck -- gets nobody.
  assert.equal(pavementOffset(lane, 60, 1, () => -1), null, 'found a pavement in the middle of the road');
});

test('a crowd is placed off the carriageway and walks along it', () => {
  const { crowd: c } = crowd();
  for (const p of c.people || []) assert.ok(carriageway(p.x) > 0, `a person stood at x ${p.x}`);
  // Two or three frames is all it takes for every person to have been positioned at least once.
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  assert.ok((c.people || []).length > 0, 'the crowd went away after one step');
});

test('every person off the ground is drawn from a model, and none of them is in the road', () => {
  const { crowd: c, renderer } = crowd();
  const live = c.snapshot();
  assert.ok(live.peds > 0, 'nobody on the street at all');
  assert.ok(live.articulated > 0, 'the closest people were never given bodies');
  assert.ok(live.bodies > 0, 'the crowd ran a frame without building a single person');
  // One dynamic object per body now -- the mesh itself is the animation -- plus the hail cards.
  assert.ok(renderer.made.objects >= live.articulated, `${renderer.made.objects} objects for ${live.articulated} bodies`);
  assert.ok(renderer.made.refreshes >= live.articulated, 'a body was drawn without its skin being solved');
  for (const p of c.people) if (carriageway(p.x) <= 0) assert.fail(`a person at x ${p.x} is standing in the road`);
});

test('a body is a mesh that is re-uploaded, not a pile of parts posed by matrices', () => {
  const { crowd: c, renderer } = crowd();
  const p = c.people[0];
  c.step(0.016, { x: p.x, z: p.z, yaw: 0, speed: 0 }, true);
  assert.ok(p.person, 'the nearest person has no body');
  assert.ok(p.person.handle >= 1, 'the body was never uploaded as a mesh');
  assert.ok(p.person.dynamic.matrix[12] === p.x || Math.abs(p.person.dynamic.matrix[12] - p.x) < 1e-3,
    'the body is not where the person is');
  const before = renderer.made.refreshes;
  c.step(0.016, { x: p.x, z: p.z, yaw: 0, speed: 0 }, true);
  assert.ok(renderer.made.refreshes > before, 'a frame passed and no skinning was uploaded');
});

test('bodies are for the nearest few, and come back off when they are far away', () => {
  const { crowd: c, renderer } = crowd();
  c.setDensity(3, 2);
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  const near = c.snapshot();
  assert.ok(near.articulated <= 2, `${near.articulated} bodies for a tier allowance of 2`);
  // Drive away: the street empties, and every object goes back to the renderer. Two frames, because a
  // body past the animation radius is handed back once the tier has decided it wants that slot elsewhere.
  c.step(0.016, { x: 0, z: 10000, yaw: 0, speed: 0 }, true);
  c.step(0.016, { x: 0, z: 10000, yaw: 0, speed: 0 }, true);
  const gone = c.snapshot();
  assert.equal(gone.articulated, 0, 'bodies were kept on people 9,800 m away');
  assert.ok(gone.peds === 0, `${gone.peds} people kept alive 9,800 m away`);
});

test('a street with nobody in the animation radius still gets one body, rather than an empty pavement', () => {
  const { crowd: c } = crowd();
  c.setDensity(3, 1);                        // the full crowd, one body to give it
  c.step(0.016, { x: 0, z: 0, yaw: 0, speed: 0 }, true);
  const people = c.people;
  assert.ok(people.length > 0, 'the street never filled');
  // What a street whose nearest pavement is too far looks like: everybody at the far end of their own
  // stretch, scaled out from where the car is standing. The lane stays a real lane — the crowd is
  // allowed to go on walking, it is simply nobody's idea of a nearby pavement.
  pushOut(c, people, 85);
  c.step(0.016, { x: 0, z: 0, yaw: 0, speed: 0 }, true);
  assert.ok(c.snapshot().articulated > 0, 'a pavement of invisible people: nothing was promoted at 85 m');
  pushOut(c, people, 283);                                          // past the keep ring entirely
  c.step(0.016, { x: 0, z: 0, yaw: 0, speed: 0 }, true);
  assert.ok(c.snapshot().bodies < c.snapshot().peds || c.snapshot().articulated === 0,
    'bodies were carried out to the horizon with people nobody can see');
});

test('a person who leaves the animation radius hands their body back, and the next one takes it', () => {
  const { crowd: c, renderer } = crowd();
  const first = c.snapshot();
  const made = renderer.made.meshes;
  c.setDensity(0, 99);
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  assert.equal(renderer.made.meshes, made, 'bodies were destroyed when they could have been parked');
  c.setDensity(3, 99);
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  assert.ok(c.snapshot().bodies > 0, 'nobody came back');
  void first;
});

test('a car coming at the kerb makes somebody step back, and the police are told', () => {
  const { crowd: c, endangered } = crowd();
  for (let i = 0; i < 400; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  // Aim at somebody who is actually standing off the kerb, on the side the car comes from.
  const victim = c.people.filter((p) => p.x < 0).sort((a, b) => Math.abs(a.z - 200) - Math.abs(b.z - 200))[0];
  assert.ok(victim, 'nobody on the -x pavement to frighten');
  const before = c.snapshot().startled;
  for (let i = 0; i < 300; i++) c.step(1 / 60, { x: victim.x + 2.4, z: victim.z - 30 + i * 0.1, yaw: 0, speed: 6 }, true);
  assert.ok(c.snapshot().startled > before, `nobody moved out of the way (${before})`);
  assert.ok(endangered.length > 0, 'the police were never told');
  assert.ok(endangered.every((k) => k > 0.5 && k <= 1), 'the fear reported was not a real one');
  assert.ok(threat(2, 12, 1) > 0.7, 'a close pass at speed is nothing');
  assert.equal(threat(30, 12, 1), 0, 'frightened from thirty metres off');
  assert.equal(threat(3, 0.5, 1), 0, 'a crawling car is not a threat');
  assert.ok(threat(3, 12, -1) < threat(3, 12, 1) * 0.75, 'being aimed at should matter');
});

test('nobody without a cast is still a person, and the street says it is unseen', () => {
  const graph = makeGraph();
  const renderer = fakeRenderer();
  const c = createCrowd({ graph, plan: { field: fakeField(), sample: fakeField().sample }, renderer, land: 1.2 });
  c.setDensity(3, 99);
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  const live = c.snapshot();
  assert.ok(live.peds > 0, 'the simulation stopped when the models were not there');
  assert.equal(live.articulated, 0, 'somebody was drawn without a cast to draw them from');
  assert.equal(live.cast, false, 'the snapshot does not say the cast is missing');
  assert.equal(c.castReady, false);
  c.setCast({ characters: [{ name: 'x' }], clips: [] });
  assert.equal(c.castReady, true);
});

test('a fare hails, rides in the back seat and is put down again', () => {
  const { crowd: c, renderer } = crowd();
  for (let i = 0; i < 30; i++) c.step(1 / 60, { x: 0, z: 200, yaw: 0, speed: 4 }, true);
  const any = c.people[0];
  assert.ok(any, 'no people to place a fare on');
  const hailed = c.makeHailer(any.x, any.z);
  assert.ok(hailed, 'the nearest person could not be made to hail');
  assert.equal(c.nearestHail(any.x, any.z), hailed, 'the hail was not findable');
  const before = c.count;
  const seat = c.board(hailed);
  assert.ok(seat, 'nobody got in');
  assert.equal(c.count, before - 1, 'a person in the car is still on the pavement');
  assert.ok(c.snapshot().passenger);
  for (let i = 0; i < 10; i++) c.step(1 / 60, { x: 4, z: 220 + i, yaw: 0.2, speed: 8 }, true);
  assert.ok(seat.person, 'the fare was never given a body in the car');
  assert.ok(Math.abs(seat.person.dynamic.matrix[12] - (4 + Math.cos(0.2) * 0.42)) < 1e-3, 'the passenger is not beside the driver');
  const out = c.alight(0, 240);
  assert.ok(out && !c.passenger, 'they never got out');
  assert.ok(c.count >= before, 'the fare was lost rather than dropped off');
  c.reset();
  assert.equal(c.count, 0, 'reset left people on the street');
  assert.equal(renderer.made.removed, renderer.made.objects, 'objects were left with the renderer');
});

test('no crowd on a street the player is not driving on', () => {
  const { crowd: c } = crowd();
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, false);
  assert.equal(c.enabled, true);
  c.setDensity(3, 99);
  const before = c.count;
  for (let i = 0; i < 5; i++) c.step(0.5, { x: 0, z: 200, yaw: 0, speed: 0 }, false);
  assert.ok(c.count <= before + 1, 'the crowd grew while the player was not on the street');
});

test('a crowd with no plan and no road does not throw', () => {
  const c = createCrowd({ graph: null, plan: null, renderer: fakeRenderer(), people: fakeCast(1) });
  c.setDensity(3, 99);
  c.step(0.016, { x: 0, z: 0, yaw: 0, speed: 0 }, true);
  assert.equal(c.count, 0);
  assert.equal(c.snapshot().bodies, 0);
});

test('a person at the kerb asks for a cab, and stops asking after a while', () => {
  const { crowd: c, renderer } = crowd({ at: { x: 0, z: 200, yaw: 0, speed: 0 } });
  const episodes = new Map();          // person id -> 1 waving, 2 gave up
  for (let i = 0; i < 4000; i++) {
    c.step(0.05, { x: 0, z: 100 + i * 0.2, yaw: Math.PI / 2, speed: 4 }, true);
    for (const p of c.people) {
      if (p.hailing > 0) episodes.set(p.id, 1);
      else if (episodes.get(p.id) === 1) episodes.set(p.id, 2);
    }
  }
  const started = [...episodes.values()].filter((v) => v >= 1).length;
  const finished = [...episodes.values()].filter((v) => v === 2).length;
  assert.ok(started > 0, 'in forty minutes of traffic nobody wanted a cab');
  assert.ok(finished > 0, 'nobody ever gave up: the arm stays up for ever');
  assert.ok(started >= finished);
  // An idle body keeps its object -- that is the point of the shelf -- so the invariant is checked after
  // a reset, which is when the street is thrown away and every object has to go back.
  c.setDensity(0, 0);
  c.step(0.016, { x: 0, z: 200, yaw: 0, speed: 0 }, true);
  assert.ok(renderer.made.removed < renderer.made.objects, 'the shelf kept nothing, so bodies are rebuilt every time');
  c.reset();
  assert.equal(renderer.made.removed, renderer.made.objects,
    'a mark or a parked body was left with the renderer after the street was thrown away');
});

test('the tier allowance is a number for every preset, and it is never zero on a street that is drawn', () => {
  for (const preset of ['ultraLow', 'low', 'medium', 'high', 'ultra']) {
    assert.ok(Number.isFinite(PEOPLE_BY_TIER[preset]), `${preset} has no allowance`);
    assert.ok(PEOPLE_BY_TIER[preset] >= 2, `${preset} would empty the pavements`);
  }
  assert.ok(PEOPLE_BY_TIER.ultraLow < PEOPLE_BY_TIER.low, 'the ladder is upside down');
  assert.ok(PEOPLE_BY_TIER.ultra < PEOPLE_BY_TIER.low + 40);
  assert.ok(ARTICULATE_AT > 20, `${ARTICULATE_AT} m is close enough to see a body arrive`);
  assert.ok(CROWD_BY_DENSITY[3].peds > CROWD_BY_DENSITY[1].peds);
});

/** Stand everybody out at `metres` from the origin, along the line from the car to where they are now. */
function pushOut(c, people, metres) {
  const scratch = [0, 0, 0];
  for (const p of people) {
    const w = c.at(p, scratch);
    const len = Math.max(1e-3, Math.hypot(w[0], w[2]));
    p.x = w[0] / len * metres; p.z = w[2] / len * metres;
  }
}
