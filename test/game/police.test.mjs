// Tests for what the fork added to the vendored release: the patrol dispatch's decisions and the
// officer mesh built in code. Run with `node --test test/`.
//
// The dispatch is fed a hand-made lane graph and plain unit records, so these tests cover the
// judgements (what is a violation, who is sent, when it is over) without a renderer or a physics
// world. The officer test runs the same geometry code the traffic models use, in Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PatrolDispatch, routesTo } from '../../web/src/game/police.js';
import { TrafficSim } from '../../web/src/game/drivers.js';
import { buildFootOfficer } from '../../web/src/vehicles/traffic/officers.js';
import { FAMILY } from '../../web/src/core/ids.js';

/** Five lanes in a ring (0 to 1 to 2 to 3 to 0), with a dead-end spur off 1. */
function makeLanes() {
  const lane = (index) => ({ index, length: 100, speedLimit: 16, junction: null, cars: [], next: [], prev: [] });
  const l = [0, 1, 2, 3, 4].map(lane);
  const link = (a, b) => { l[a].next.push(l[b]); l[b].prev.push(l[a]); };
  link(0, 1); link(1, 2); link(2, 3); link(3, 0); link(1, 4);
  return l;
}

function makeGraph(lanes) {
  return {
    lanes,
    // The player is put on lane 2 at station 50, which is where `nearest` answers from.
    nearest(x, z, maxDistance, accept) {
      const lane = lanes[2];
      if (maxDistance < 0 || !accept(lane)) return null;
      return { lane, s: 50, distance: 4, x, y: 1.2, z, yaw: 0 };
    },
  };
}

function makeUnit(id, x, z, { seen = true } = {}) {
  return {
    id, range: Infinity, responding: false, onCall: false, lightBar: false, officer: null,
    driver: { id, seed: id, patrolRoute: null, finished: false },
    box: { pos: [x, 1.2, z], renderPos: [x, 1.2, z], pushed: false, userData: null },
    seen,
  };
}

function makeFocus({ x = 0, z = 50, speed = 0, yaw = 0 } = {}) {
  return {
    x, y: 1.2, z, vx: Math.sin(yaw) * speed, vz: Math.cos(yaw) * speed, yaw,
    eye: [x, 2.4, z - 6], fx: Math.sin(yaw), fy: 0, fz: Math.cos(yaw),
  };
}

function setup(units, options = {}) {
  const lanes = makeLanes();
  const messages = [];
  const dispatch = new PatrolDispatch({
    graph: makeGraph(lanes),
    canSee: (unit) => unit.seen,
    routeDriver: (driver, route) => { driver.patrolRoute = route; driver.routeSets = (driver.routeSets || 0) + 1; },
    notify: (text) => messages.push(text),
  });
  for (const u of units) dispatch.add(u);
  return { dispatch, lanes, messages, options };
}

const SCAN = 0.5; // just over the dispatch's look

const run = (dispatch, focus, seconds, dt = 1 / 60, driving = true) => {
  for (let i = 0; i < Math.round(seconds / dt); i++) dispatch.step(dt, focus, driving);
};

test('routesTo only ever names a legal forward successor', () => {
  const lanes = makeLanes();
  const route = routesTo(lanes[2]);
  assert.equal(route.get(lanes[2]), null, 'at the goal there is nowhere the route sends you');
  for (const [from, to] of route) {
    if (to === null) continue;
    assert.ok(from.next.includes(to), `lane ${from.index} does not lead to lane ${to.index}`);
  }
  assert.ok(route.has(lanes[0]) && route.has(lanes[1]), 'the lanes that can reach the goal are mapped');
  assert.ok(!route.has(lanes[4]), 'a dead-end spur is not part of a route to anywhere');
});

test('the search works backwards over junction connectors too', () => {
  const lanes = makeLanes();
  const junction = { index: 90, length: 8, speedLimit: 8, junction: { id: 0 }, cars: [], next: [lanes[2]], prev: [lanes[1]] };
  lanes[1].next = lanes[1].next.filter((l) => l !== lanes[2]);
  lanes[1].next.push(junction);
  lanes[2].prev = lanes[2].prev.filter((l) => l !== lanes[1]);
  lanes[2].prev.push(junction);
  const route = routesTo(lanes[2]);
  assert.equal(route.get(junction), lanes[2], 'through the connector, onto the goal');
  assert.equal(route.get(lanes[1]), junction, 'and the lane before the connector');
});

test('speeding is only a violation where an officer can see it', () => {
  const far = makeUnit(1, 400, 50, { seen: false });
  const a = setup([far]);
  run(a.dispatch, makeFocus({ speed: 40 }), 6);
  assert.equal(a.dispatch.status.heat, 0, 'nobody watched, so nothing happened');

  const near = makeUnit(2, 30, 50);
  const b = setup([near]);
  run(b.dispatch, makeFocus({ speed: 40 }), 6);
  assert.equal(b.dispatch.status.heat, 1, 'a witnessed excess of speed brings one unit out');
  assert.equal(near.responding, true, 'and that unit is on its way');
  assert.equal(near.driver.patrolRoute !== null, true, 'with a route to follow');
  assert.match(a.messages.join('|') + b.messages.join('|'), /Speeding/);
});

test('a traffic stop ends the incident, and the route is handed back', () => {
  const unit = makeUnit(3, 14, 52);
  const { dispatch, messages } = setup([unit]);
  run(dispatch, makeFocus({ speed: 40 }), 4);
  assert.equal(dispatch.status.heat, 1);
  const route = unit.driver.patrolRoute;
  // The player pulls over: the unit closes, stops, and the officer walks out.
  const focus = makeFocus({ speed: 0 });
  run(dispatch, focus, 6);
  assert.equal(dispatch.status.heat, 0, 'the incident is over');
  assert.equal(dispatch.status.mode, 'cleared');
  assert.equal(unit.responding, false, 'the unit is not ordered anywhere any more');
  assert.equal(unit.driver.patrolRoute, null, 'and its driver has its own choices back');
  assert.ok(messages.some((m) => /Traffic stop complete/.test(m)), 'the dispatch says so');
  assert.equal(dispatch.siren.level, 0, 'and the wail dies away');
  assert.equal(route !== null, true, 'there was a route to hand back');
});

test('disappearing ends a pursuit as a search, then as nothing', () => {
  const unit = makeUnit(4, 30, 50);
  const { dispatch, messages } = setup([unit]);
  const hot = makeFocus({ speed: 40 });
  run(dispatch, hot, 4);
  assert.equal(dispatch.status.heat, 1);
  // Out of sight for good: the search runs, then the call is cancelled.
  unit.seen = false;
  unit.box.pos = [900, 1.2, 900]; unit.box.renderPos = [900, 1.2, 900];
  run(dispatch, hot, 4);
  assert.equal(dispatch.status.heat, 1, 'the search is still on');
  assert.equal(dispatch.status.mode, 'search');
  run(dispatch, hot, 11);
  assert.equal(dispatch.status.heat, 0, 'the search is called off');
  assert.ok(messages.some((m) => /Search called off/.test(m)), 'and the dispatch says so');
  assert.equal(unit.responding, false, 'nobody is directed any more');
  run(dispatch, hot, 5);
  assert.equal(dispatch.status.mode, 'patrol', 'the line goes back to patrol once it has been read');
});

test('a struck patrol car is news even where nobody was watching', () => {
  const unit = makeUnit(5, 500, 500, { seen: false });
  const { dispatch, messages } = setup([unit]);
  unit.box.userData = unit;
  dispatch.step(1 / 60, makeFocus({ speed: 0 }), true);
  dispatch.impact(unit, 6);
  dispatch.step(1 / 60, makeFocus({ speed: 0 }), true);
  // Striking a patrol car is not a parking ticket: two units, at once.
  assert.equal(dispatch.status.heat, 2);
  assert.match(messages.join('|'), /Patrol car struck/);
});

test('a hit that no officer saw, and no unit reported, is not a crime', () => {
  const other = { box: { pos: [0, 1.2, 0], renderPos: [0, 1.2, 0], pushed: false } };
  const { dispatch, messages } = setup([other]);
  dispatch.step(1 / 60, makeFocus(), true);
  dispatch.impact(null, 3);
  dispatch.step(1 / 60, makeFocus(), true);
  assert.equal(dispatch.status.heat, 0);
  assert.equal(messages.length, 0);
});

test('a unit that is out of position stops being directed', () => {
  const unit = makeUnit(6, 10, 50);
  const { dispatch } = setup([unit]);
  run(dispatch, makeFocus({ speed: 40 }), 4);
  assert.equal(unit.responding, true);
  unit.box.pushed = true; // the player shoved it aside: its driver no longer commands it
  run(dispatch, makeFocus({ speed: 40 }), SCAN); // the next scan is where the units are read
  assert.equal(unit.responding, false);
  assert.equal(unit.driver.patrolRoute, null, 'the order is taken back, not left in the driver');
});

test('heat rises while the player keeps driving past them', () => {
  const unit = makeUnit(7, 20, 50);
  const backup = makeUnit(8, 40, 50);
  const { dispatch, messages } = setup([unit, backup]);
  run(dispatch, makeFocus({ speed: 26 }), 80);
  assert.ok(dispatch.status.heat >= 2, `heat was ${dispatch.status.heat}`);
  assert.ok(messages.some((m) => /Additional unit/.test(m)));
  assert.equal(dispatch.status.responding, Math.min(dispatch.status.heat, 2), 'both units are directed');
});

test('no policing in the garage, on the title, or while paused', () => {
  const unit = makeUnit(9, 20, 50);
  const { dispatch } = setup([unit]);
  run(dispatch, makeFocus({ speed: 45 }), 5, 1 / 60, false);
  assert.equal(dispatch.status.heat, 0);
  dispatch.enabled = true;
  run(dispatch, makeFocus({ speed: 45 }), 5);
  assert.equal(dispatch.status.heat, 1, 'and it starts again when the player is driving');
  dispatch.enabled = false;
  run(dispatch, makeFocus({ speed: 0 }), 1);
  assert.equal(dispatch.status.heat, 0, 'paused or parked: back to patrol');
});

test('the dispatch never touches a driver it has no unit for', () => {
  const lanes = makeLanes();
  const sim = new TrafficSim({ ensureConflicts() {}, nearest: () => null }, { seed: 3 });
  const car = {
    lane: lanes[1], next: null, afterNext: null, patrolRoute: null, grant: null,
    choices: 0, seed: 11, cars: lanes[1].cars,
  };
  const route = routesTo(lanes[2]);
  sim.setRoute(car, route);
  assert.equal(car.next, lanes[2], 'the ordered lane, not the spur it would have taken');
  // On the spur, which the route does not know: it chooses as usual rather than freezing.
  car.lane = lanes[4]; car.next = null;
  sim.setRoute(car, route);
  assert.equal(car.next, null, 'the spur leads nowhere, whatever the order said');
  // A granted connector is not taken away from the car that is standing in it.
  car.lane = lanes[0]; car.next = null; car.afterNext = null; car.grant = lanes[1];
  const before = car.next;
  sim.setRoute(car, routesTo(lanes[3]));
  assert.equal(car.next, before, 'held until the junction is cleared');
  assert.equal(car.patrolRoute !== null, true, 'but the order stands, for the next lane');
  sim.setRoute(car, null);
  assert.equal(car.patrolRoute, null);
});

test('the officer is a person, not a blob: built by the traffic geometry kit', () => {
  const mesh = buildFootOfficer();
  assert.ok(mesh.indexCount > 300, `${mesh.indexCount} indices is not an officer`);
  assert.equal(mesh.indexCount % 3, 0);
  assert.deepEqual(mesh.groups.map((g) => g.family), [FAMILY.VEHICLE], 'one family, the one the cars use');
  const [minx, miny, minz, maxx, maxy, maxz] = mesh.bounds;
  const view = new DataView(mesh.vertices);
  for (let i = 0; i < mesh.vertexCount; i++) {
    const o = i * 36;
    for (let k = 0; k < 3; k++) assert.ok(Number.isFinite(view.getFloat32(o + k * 4, true)), 'a NaN vertex');
  }
  const height = maxy - miny;
  assert.ok(height > 1.5 && height < 2, `an officer ${height.toFixed(2)} m tall`);
  assert.ok(maxx - minx < 0.8 && maxz - minz < 0.7, 'they do not have arms like a windmill');
  assert.ok(minx < 0 && maxx > 0, 'symmetric about the body');
  // Feet on the ground, head at about eye level of a standing adult.
  assert.ok(Math.abs(miny) < 0.05, `feet at ${miny.toFixed(3)}`);
  assert.ok(maxy > 1.75 && maxy < 1.95, `top of the cap at ${maxy.toFixed(2)}`);
});

// ---- over a real lane graph: the order changes what the driver model does

import { prepareLaneGraph } from '../../web/src/game/lanes.js';

/**
 * Five lanes and one choice. A driver that is left to itself may take either of the two roads out
 * of lane 0; the route the dispatch computes goes by the shorter of them, and stops on the goal.
 */
function realGraph() {
  // The builder numbers lanes by their position in this list, so the successors below are indices.
  const lane = (pts, next) => ({ pts, next, speedLimit: 13.4, width: 3.3 });
  return prepareLaneGraph({
    lanes: [
      lane([0, 0, 0, 0, 0, 120], [1, 2]),        // 0: where the unit is, with a choice to make
      lane([0, 0, 120, 0, 0, 240], [4]),          // 1: the near road on to the goal
      lane([0, 0, 120, 40, 0, 240], [3]),         // 2: the one that bends away and comes back
      lane([40, 0, 240, 40, 0, 360], [4]),         // 3
      lane([0, 0, 240, 0, 0, 360], []),            // 4: the goal, where the incident is
    ],
    junctions: [],
  });
}

test('a directed unit drives the route and stops where the incident is', () => {
  const graph = realGraph();
  const l0 = graph.lanes[0], l1 = graph.lanes[1], l5 = graph.lanes[2], l2 = graph.lanes[4];
  const sim = new TrafficSim(graph, { seed: 5 });
  const shape = { frontLength: 2.2, rearLength: 2.2, halfWidth: 0.9, wheelbase: 2.6, centreZ: 0, halfLength: 2.2 };
  const car = sim.add(l0, 10, shape, 0);
  const route = routesTo(l2);
  assert.equal(route.get(l0), l1, 'the route takes the near road, not the one that bends away');
  assert.equal(route.get(l2), null, 'and it stops on the goal');

  const undirected = sim.add(l0, 60, shape, 0);
  sim.setRoute(undirected, null);
  assert.ok(undirected.next === l1 || undirected.next === l5, 'a free driver picks one of the two');

  sim.setRoute(car, route);
  assert.equal(car.next, l1);
  assert.equal(car.patrolRoute, route);

  for (let i = 0; i < 60 * 30; i++) sim.step(1 / 30);
  assert.equal(car.lane, l2, 'it arrived on the lane the incident is on');
  assert.equal(car.finished, true, 'the road runs out there, which is where a patrol car stops');
  assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z), 'and it stayed in the world');
  assert.ok(car.z > 240, `it is past the entry of the goal lane (${car.z.toFixed(0)})`);
  assert.ok(car.v < 0.4, `stopped, at ${car.v.toFixed(2)} m/s`);
  // The order is only a decision: nothing was written to the car's own state beyond the route.
  sim.setRoute(car, null);
  assert.equal(car.patrolRoute, null);
});
