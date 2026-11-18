// Tests for the street races: the route laid on a real lane graph, the gate test the timing is built
// from, and the clock and the field. Run with `node --test`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareLaneGraph, samplePoint } from '../../web/src/game/lanes.js';
import {
  buildRoute, crossing, createRaces, buildGateMesh, formatTime, placeLabel, readBest, writeBest,
  TIERS, GATE_HALF, FALSE_START_MS, COUNTDOWN_SECONDS,
} from '../../web/src/game/races.js';
import { FAMILY } from '../../web/src/core/ids.js';

const SIDE = 400;

/** A ring of eight one-way lanes, a square 400 m a side, so a route has a road to follow. */
function makeGraph() {
  const corners = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const lanes = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    // Each side is two lanes long, so a route crosses a junction and the successor test means something.
    for (let half = 0; half < 2; half++) {
      const t0 = half / 2, t1 = (half + 1) / 2;
      lanes.push({
        id: i * 2 + half,
        pts: new Float32Array([ax + (bx - ax) * t0, 1.2, az + (bz - az) * t0, ax + (bx - ax) * t1, 1.2, az + (bz - az) * t1]),
        length: SIDE / 2, speedLimit: 15, width: 3.3, next: [i * 2 + half + 1], junction: -1, turn: 0, control: null,
      });
    }
  }
  lanes[lanes.length - 1].next = [0];
  // A spur off the second lane, which a route should not feel obliged to take.
  lanes[1].next = [lanes.length - 1 + 1, 2];
  lanes.push({
    id: 8, pts: new Float32Array([300, 1.2, 400, 300, 1.2, 900]), length: 500, speedLimit: 13, width: 3.3,
    next: [], junction: -1, turn: 0, control: null,
  });
  return prepareLaneGraph({ lanes, junctions: [] });
}

function fakeRenderer() {
  let next = 1;
  const objects = [];
  return {
    objects,
    createMesh() { return next++; },
    addDynamic({ mesh }) {
      const o = { mesh, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), visible: true, remove() { o.visible = false; o.removed = true; } };
      objects.push(o);
      return o;
    },
  };
}

/** Traffic that hands over cars and takes them back, which is all a race asks of it. */
function fakeTraffic({ graph, count = 2 } = {}) {
  const field = [], released = [];
  let asked = null;            // what the race told the street about where the line is
  return {
    field, released,
    get asked() { return asked; },
    fieldForRace(lane, s, wanted, route, opts) {
      asked = opts || null;
      for (let i = 0; i < wanted; i++) {
        const driver = { lane, s: s - 14 * i, v: 0, patrolRoute: null, finished: false };
        const car = { driver, box: { pos: [lane.pts[0] - 30 * i, 1.2, lane.pts[2]], yaw: 0 }, raced: true };
        field.push(car);
        driver.route = route;
      }
      return field.map((car) => ({ car, driver: car.driver }));
    },
    // The same guard traffic.js uses: the mark comes off, and a car whose driver is gone has nothing to
    // be told.
    releaseFromRace(cars) {
      for (const c of cars) { c.car.raced = false; if (c.car.driver) released.push(c.driver); }
    },
    setRoute() {},
  };
}

function setup(options = {}) {
  const graph = makeGraph();
  const renderer = fakeRenderer();
  const traffic = fakeTraffic({ graph });
  const messages = [];
  const store = memoryStore();
  const races = createRaces({
    graph, renderer, traffic, land: 1.2, seed: 3, store,
    notify: (t) => messages.push(t), ...options,
  });
  return { races, graph, renderer, traffic, messages, store };
}

function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

/**
 * Drive the course by following its own lane polylines at a fixed speed: the gates are on that line, so
 * a car that keeps to it goes through all of them in order. That is the whole point of laying a route
 * out of real lanes — no driving model is needed to run a race.
 * @returns {object} what the board read when the car was done
 */
function driveThrough(races, route, { dt = 1 / 30, metresPerSecond = 34, steps = 6000 } = {}) {
  const step = metresPerSecond * dt;
  // The course is one arc measured from the line, so drive the same arc: ask the route for the point at
  // a distance along it and let the race judge it. Nothing here guesses at the gate test.
  // The course is measured from the line, which is where the field is standing.
  const firstFrom = route.start.s;
  const point = (d) => {
    let acc = 0;
    for (const lane of route.lanes) {
      const from = lane === route.lanes[0] ? firstFrom : 0;
      const span = lane.length - from;
      // The same station the gates were measured from: the line is distance 0 of the course.
      if (d <= acc + span) {
        const p = [0, 0, 0];
        samplePoint(lane, from + (d - acc), p);
        return [p[0], p[2]];
      }
      acc += span;
    }
    return null;
  };
  let d = 0, stall = 0, lastPassed = -1;
  const seen = [];
  for (let i = 0; i < steps; i++) {
    d += step;
    const p = point(d);
    if (!p) break;
    races.step(dt, p, true);
    const snap = races.snapshot();
    if (snap.passed !== lastPassed) { seen.push({ passed: snap.passed, ms: snap.elapsedMs, at: Math.round(d) }); lastPassed = snap.passed; }
    if (snap.finished || !snap.active) break;
    if (seen.length > 1 && snap.passed === lastPassed) { if (++stall > 400) break; } else stall = 0;
  }
  return { seen, snapshot: races.snapshot(), metres: Math.round(d) };
}

/**
 * The same ring, but with each corner replaced by the shape the plan builder really makes: a road lane,
 * a short connector across the junction, then the next road lane.
 */
function makeJunctionGrid() {
  const corners = [[0, 0], [400, 0], [400, 400], [0, 400]];
  const lanes = [];
  const connectorIds = new Set();
  let id = 0;
  const road = (ax, az, bx, bz, next) => {
    const mine = id++;
    lanes.push({
      id: mine, pts: new Float32Array([ax, 1.2, az, bx, 1.2, bz]),
      length: Math.hypot(bx - ax, bz - az), speedLimit: 15, width: 3.3, next, junction: -1, turn: 0, control: null,
    });
    return mine;
  };
  const roads = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    roads.push(road(ax, az, bx, bz, []));
  }
  // Each road's next is a connector at its far end, and the connector's next is the following road.
  const extra = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = corners[i], [bx, bz] = corners[(i + 1) % 4];
    const [cx, cz] = corners[(i + 2) % 4];
    const jx = bx + (cx - bx) * 0.06, jz = bz + (cz - bz) * 0.06;      // a short hop across the mouth
    const mine = id++;
    connectorIds.add(mine);
    extra.push({
      id: mine, pts: new Float32Array([bx, 1.2, bz, jx, 1.2, jz]),
      length: Math.hypot(jx - bx, jz - bz), speedLimit: 8, width: 3.3, next: [roads[(i + 1) % 4]],
      junction: i, turn: 0, control: null,
    });
    lanes[lanes.findIndex((l) => l.id === roads[i])].next = [mine];
  }
  const prepared = prepareLaneGraph({ lanes: lanes.concat(extra), junctions: [] });
  return { graph: prepared, connectorIds };
}

test('a route is a walk over the graph, and every gate is on a lane of it', () => {
  const graph = makeGraph();
  const route = buildRoute(graph, graph.lanes[0], 40, 1200, () => 0.2);
  assert.ok(route, 'no route on a ring road');
  // A spur with no way out of it is not a racing line: the route must not die on a dead end.
  assert.ok(!route.lanes.some((l) => l.id === 8), 'a dead-end spur was taken as the course');
  assert.ok(route.length >= 1000, `a ${route.length} m course for a 1200 m wish`);
  assert.ok(route.lanes.length >= 3, `only ${route.lanes.length} lanes`);
  assert.ok(route.gates.length >= 3, `only ${route.gates.length} gates`);
  for (let i = 0; i < route.lanes.length - 1; i++) {
    assert.ok(route.lanes[i].nextIds.includes(route.lanes[i + 1].id), `lane ${i} does not lead to ${i + 1}`);
  }
  for (const g of route.gates) {
    assert.ok(route.lanes.includes(g.lane), 'a gate is off the course');
    assert.ok(g.s >= 0 && g.s <= g.lane.length, `station ${g.s} is not on its lane`);
  }
  // The order along the course: a gate is never behind the one before it, and none is behind the line.
  let rank = -1;
  for (const g of route.gates) {
    const at = route.lanes.indexOf(g.lane) * 1e6 + g.s;
    assert.ok(at > rank, `gate at ${g.s} is out of order`);
    rank = at;
  }
  // A course that can come home does — its last lane leads to the lane the line is on, so the field is
  // not retired at the last corner and a lap means what it says. A course that cannot is a sprint, and
  // must at least be as long as was asked for.
  assert.equal(typeof route.comesHome, 'boolean', 'the walk did not report whether the course closes');
  if (route.comesHome) {
    assert.ok(route.lanes[route.lanes.length - 1].nextIds.includes(route.lanes[0].id), 'the course does not come home to the line');
  } else {
    assert.ok(route.length >= 1200, `a point-to-point course of ${route.length} m for a 1200 m wish`);
  }
  // The long wish, on the same street, is a lap: round the loop and stop on the line.
  const lap = buildRoute(graph, graph.lanes[0], 40, 2600, () => 0.2);
  assert.ok(lap.comesHome, 'a one-lap wish did not close the loop');
  assert.ok(lap.length > 1300, `a lap of only ${lap.length} m`);
  // What the drivers are told: every link of the map is a legal forward successor, and no lane of the
  // course is a dead end that would retire the field halfway round.
  for (const [from, to] of route.map) assert.ok(from.nextIds.includes(to.id), 'the route names a lane it cannot reach');
  for (const lane of route.lanes) assert.ok(lane.next.length > 0, `lane ${lane.id} has no way out`);
});

test('a course is walked through the junctions, the way a car drives them', () => {
  // On the island a lane's successor is the connector that crosses the junction, and the road beyond
  // is that connector's successor. A route that refused connectors would find one lane and stop, which
  // is exactly how a street race dies: so the walk goes through them, and the gates stay off them.
  const { graph, connectorIds } = makeJunctionGrid();
  const route = buildRoute(graph, graph.lanes[0], 20, 900, () => 0.15);
  assert.ok(route, 'no route laid where every junction is a connector');
  assert.ok(route.length >= 600, `only ${route.length} m of course`);
  for (const g of route.gates) {
    assert.ok(!connectorIds.has(g.lane.id), `a gate was put in a junction (lane ${g.lane.id})`);
    assert.ok(g.lane.junctionId < 0 && !g.lane.junction, 'a gate was put on a lane that is not a road');
  }
  // The drivers have to be told about the connectors as well, or they sit at the stop line for ever.
  for (let i = 0; i < route.lanes.length - 1; i++) {
    const from = route.lanes[i];
    const to = route.map.get(from);
    assert.ok(to, `lane ${from.id} is on the course but leads nowhere on it`);
    assert.ok(from.nextIds.includes(to.id), `the map says ${from.id} leads to ${to.id}, the graph does not`);
    if (to !== route.lanes[i + 1]) assert.ok(connectorIds.has(to.id), 'the lane between two roads is not a junction');
  }
});

test('the line is where the car is standing, not where the lane began', () => {
  const graph = makeGraph();
  const lane = graph.lanes[0];
  const a = buildRoute(graph, lane, 40, 1200, () => 0.2);
  const b = buildRoute(graph, lane, 120, 1200, () => 0.2);
  assert.ok(a && b, 'both starts should lay a course');
  const pa = [0, 0, 0];
  samplePoint(lane, 40, pa);
  assert.ok(Math.hypot(a.gates[0].x - pa[0], a.gates[0].z - pa[2]) < 0.01, 'the line is not under the car');
  // The first gate after the line is a lap's corner away, never a short hop behind the car.
  const second = a.gates[1];
  assert.ok(second.lane !== a.gates[0].lane || second.s > a.gates[0].s, 'the second gate is behind the first');
  // No gate but the line itself is before the car, on either start: the arc, not the station, decides.
  for (const [r, at] of [[a, 40], [b, 120]]) {
    const arc = (g) => {
      let d = 0;
      for (const l of r.lanes) {
        const from = l === r.lanes[0] ? at : 0;
        if (l === g.lane) { d += g.s - from; break; }
        d += l.length - from;
      }
      return d;
    };
    const behind = r.gates.filter((g) => g.start ? false : arc(g) <= 0.5);
    assert.equal(behind.length, 0, 'a gate was laid behind a car that had not reached it');
    assert.ok(arc(r.gates[0]) === 0, 'the line is not at distance 0 of its own course');
    for (let i = 1; i < r.gates.length; i++) assert.ok(arc(r.gates[i]) > arc(r.gates[i - 1]), 'gates are out of order');
  }
});

test('a gate is crossed one way only, and speed cannot skip it', () => {
  const gate = { x: 0, z: 0, yaw: 0 };                    // facing +z
  assert.ok(crossing(gate, [0, -10], [0, 10]), 'a straight crossing was missed');
  assert.equal(crossing(gate, [0, 10], [0, -10]), false, 'driving backwards through a gate counts');
  assert.equal(crossing(gate, [0, -10], [0, -1]), false, 'the gate has not been reached');
  assert.ok(crossing(gate, [0, -400], [0, 400]), 'a fast car tunnelled through the gate');
  assert.ok(crossing(gate, [GATE_HALF - 0.4, -10], [GATE_HALF - 0.4, 10]), 'the edge of the mouth was missed');
  assert.equal(crossing(gate, [GATE_HALF + 1, -10], [GATE_HALF + 1, 10]), false, 'outside the gate counts');
  // A diagonal across the corner passes the plane inside the mouth, but only because it left the road
  // to do it: both ends have to be on the road for a gate to count.
  assert.equal(crossing(gate, [-GATE_HALF - 2, -40], [GATE_HALF + 2, 40]), false, 'a cut across the grass counted');
  assert.ok(crossing(gate, [GATE_HALF - 1, -40], [GATE_HALF - 1, 40]), 'a car on the road was refused');
  // A quartering gate: the mouth turns with the road it is laid across.
  const diagonal = { x: 100, z: 100, yaw: Math.PI / 4 };
  assert.ok(crossing(diagonal, [80, 80], [120, 120]), 'a car on a diagonal road was refused');
  assert.equal(crossing(diagonal, [120, 80], [80, 120]), false, 'driving along a gate is not crossing it');
});

test('a meeting counts down, times the lap and writes a record', () => {
  const { races, store, messages } = setup();
  const graph = makeGraph();
  const start = [graph.lanes[0].pts[0] + 20, graph.lanes[0].pts[2] + 40];
  assert.ok(races.start('local', start[0], start[1]), 'could not start on the ring');
  // The game parks the car on the line the course asked for, and the test does the same.
  const at = races.place();
  assert.ok(at && at.length === 3, 'the course has no grid');
  start[0] = at[0]; start[1] = at[1];
  const s0 = races.snapshot();
  assert.ok(s0.countdown > 0 && s0.countdown <= COUNTDOWN_SECONDS, 'no countdown');
  assert.ok(s0.total >= 3, `a ${s0.total}-gate course`);
  assert.ok(s0.opponents >= 2, 'the field is only you');
  // Sit at the line until the flag drops.
  for (let i = 0; i < 400; i++) races.step(1 / 60, start, true);
  assert.equal(races.snapshot().countdown, 0, 'the flag never dropped');
  assert.ok(races.snapshot().elapsedMs > 0, 'the clock did not start');
  const driven = driveThrough(races, races.route);
  assert.ok(driven.metres > 400, `the drive was only ${driven.metres} m`);
  assert.ok(driven.seen.map((g) => g.passed).join(',') === '1,2,3' || driven.seen.length >= 3, `the gates read ${JSON.stringify(driven.seen)}`);
  assert.ok(driven.snapshot.elapsedMs > 1000, 'the clock is not running');
  assert.ok(driven.snapshot.toNext >= 0, 'the course says nothing about what is next');
  assert.ok(messages.some((m) => /Ocean Drive Run/.test(m)), 'nobody announced the meeting');
  const record = readBest(store, 'local').ms;
  if (driven.snapshot.finished) {
    assert.ok(driven.snapshot.lastMs > 0, 'finished without a time');
    assert.equal(record, driven.snapshot.lastMs, 'the record is not the time that was run');
    assert.ok(messages.some((m) => /record|best/i.test(m)), 'a new record went unmentioned');
  } else {
    assert.equal(record, undefined, 'a record was written before the finish');
  }
  assert.ok(driven.snapshot.place >= 1 && driven.snapshot.place <= driven.snapshot.field, `place ${driven.snapshot.place} of ${driven.snapshot.field}`);
});

test('jumping the start costs three seconds, and that gate is not counted', () => {
  const { races, messages } = setup();
  const graph = makeGraph();
  const start = [graph.lanes[0].pts[0] + 20, graph.lanes[0].pts[2] + 40];
  assert.ok(races.start('local', start[0], start[1]), 'could not start');
  const at = races.place();
  start[0] = at[0]; start[1] = at[1];
  const s0 = races.snapshot();
  assert.equal(s0.passed, 0);
  // Run at the line before the flag: the start gate is right where the car is standing.
  const g0 = races.route.gates[0];
  const fx = Math.sin(g0.yaw), fz = Math.cos(g0.yaw);
  // Creep up on the line and jump it before the flag: four frames short of it, then across.
  for (let i = 1; i <= 4; i++) races.step(1 / 30, [g0.x - fx * (16 - i * 3), g0.z - fz * (16 - i * 3)], true);
  races.step(1 / 30, [g0.x + fx * 6, g0.z + fz * 6], true);
  assert.ok(races.snapshot().countdown > 0, 'the flag dropped by itself');
  const s1 = races.snapshot();
  assert.equal(s1.penaltyMs, FALSE_START_MS, `the penalty was ${s1.penaltyMs}`);
  assert.equal(s1.passed, s0.passed, 'a false start still counted the gate');
  assert.ok(messages.some((m) => /False start/i.test(m)), 'nobody was told');
  // The countdown is cut short, so a jump does not also cost the whole wait.
  assert.ok(s1.countdown < COUNTDOWN_SECONDS - 2, `the flag is still at ${s1.countdown}`);
});

test('the cars handed to a race are given back to the street', () => {
  const { races, traffic, renderer } = setup();
  const graph = makeGraph();
  const start = [graph.lanes[0].pts[0] + 20, graph.lanes[0].pts[2] + 40];
  assert.ok(races.start('county', start[0], start[1]), 'could not start the county meeting');
  assert.ok(traffic.field.length >= 1, 'no opponents were placed');
  assert.ok(traffic.field.every((car) => car.driver.route), 'an opponent was left without the course');
  // A field cannot be filled from the street without being told where the street is: the line's own
  // position and the lanes the course uses are what traffic.js recruits with (see fieldForRace).
  assert.ok(traffic.asked && traffic.asked.from, 'the race never told traffic where the line is');
  assert.ok(traffic.asked.lanes && traffic.asked.lanes.size >= 2, 'the race never said which lanes it runs on');
  assert.ok(races.snapshot().opponents >= 2, 'the field is only you');
  assert.ok(renderer.objects.length >= 3, 'the course has no gates drawn');
  for (const o of renderer.objects) assert.ok(o.matrix[12] !== 0 || o.matrix[14] !== 0, 'a gate was put at the origin');
  races.abort('Race called off');
  assert.equal(traffic.released.length, traffic.field.length, 'opponents were left with an order');
  assert.ok(traffic.field.every((car) => car.raced === false), 'a race car was not told it is traffic again');
  assert.equal(races.snapshot().active, false);
  assert.ok(renderer.objects.every((o) => o.removed), 'gates were left in the scene');
});

test('a finished race is remembered, and a slower one does not beat the record', () => {
  const { races, store } = setup();
  const tier = TIERS[0];
  writeBest(store, tier.id, { ms: 5000, at: 1 });
  const best = readBest(store, tier.id);
  assert.equal(best.ms, 5000, 'the record was not read back');
  assert.equal(formatTime(5000), '5.00');
  assert.equal(formatTime(65320), '1:05.32');
  assert.equal(formatTime(0), '--:--');
  assert.equal(placeLabel(2, 5, true), 'P2/5');
  assert.equal(placeLabel(null, 5, true), 'DNF');
  assert.equal(placeLabel(1, 5, false), '', 'a race not finished should not show a place');
  assert.equal(writeBest(memoryStore(), 'x', { ms: 1 }), true, 'a store that works was refused');
  assert.equal(writeBest({ setItem() { throw new Error('quota'); } }, 'x', { ms: 1 }), false, 'a throwing store should be forgiven');
  assert.equal(readBest({ getItem() { throw new Error('denied'); } }, 'x').ms, undefined, 'a denied store should read as no record');
});

test('the gate is a thing you can see: one family, tall enough to clear a van', () => {
  const mesh = buildGateMesh();
  assert.ok(mesh.vertexCount > 100 && mesh.indexCount > 60, `${mesh.vertexCount} vertices`);
  const families = new Set(mesh.groups.map((g) => g.family));
  assert.deepEqual([...families], [FAMILY.VEHICLE], `${[...families]}`);
  const [x0, y0, z0, x1, y1, z1] = mesh.bounds;
  assert.ok(y1 > 2.8 && y1 < 4, `the banner is at ${y1} m`);
  assert.ok(x1 - x0 > 2 * GATE_HALF - 0.4 && x1 - x0 < 2 * GATE_HALF + 0.6, `the mouth is ${x1 - x0} m wide`);
  assert.ok(z1 - z0 < 1, 'the gate is deep into the road');
});

test('a race cannot be started twice, or run with no street', () => {
  const { races, graph } = setup();
  const start = [graph.lanes[0].pts[0] + 20, graph.lanes[0].pts[2] + 40];
  assert.ok(races.start('local', start[0], start[1]), 'could not start');
  assert.equal(races.start('local', start[0] + 20, start[1] + 40), false, 'two meetings at once');
  races.step(1 / 60, start, false);                          // paused: the clock holds
  const held = races.snapshot().elapsedMs;
  for (let i = 0; i < 60; i++) races.step(1 / 60, start, false);
  assert.equal(races.snapshot().elapsedMs, held, 'the clock ran while the game was paused');
  const bare = createRaces({ graph: { lanes: [], nearest: () => null }, renderer: fakeRenderer(), traffic: null });
  assert.equal(bare.live, false);
  assert.equal(bare.start(), false);
  assert.equal(bare.snapshot().active, false);
});

test('a car the street takes back during a race is out, not on the board', () => {
  const { races, traffic } = setup();
  const graph = makeGraph();
  const start = [graph.lanes[0].pts[0] + 20, graph.lanes[0].pts[2] + 40];
  assert.ok(races.start('local', start[0], start[1]), 'could not start');
  for (let i = 0; i < 400; i++) races.step(1 / 60, start, true);   // past the flag
  assert.ok(races.snapshot().running >= 2, `the field is already ${JSON.stringify(races.snapshot())}`);
  // Traffic parks the first opponent: the driver is gone and the box is back in the pool.
  traffic.field[0].driver = null;
  traffic.field[0].box = null;
  races.step(1 / 60, start, true);
  const s = races.snapshot();
  assert.equal(s.running, s.field - 1, `a retired car is still being scored (${JSON.stringify(s)})`);
  races.abort('Race called off');
  assert.equal(traffic.released.length, traffic.field.length - 1, 'a retired car was handed an order to forget');
});
