// Paloma PD. Dispatch only directs existing traffic drivers. It never moves a
// mesh or teleports a collider: junction grants, car following, impacts and
// interpolation remain the responsibility of TrafficSim and Rapier.
const OBSERVE = 95, CONTACT = 155, SCAN_SECONDS = 0.45;
const SEARCH_SECONDS = 12, STOP_SECONDS = 3, GRACE_SECONDS = 10;
const ROAD = lane => !lane.junction;

/** Work backwards from the last sighting. One bounded search is shared by all
 * units. Every entry is a legal *forward* successor, including bridge ramps. */
export function routesTo(goal, budget = 900) {
  const next = new Map();
  if (!goal) return next;
  const queue = [goal];
  next.set(goal, null);
  for (let i = 0; i < queue.length && queue.length < budget; i++) {
    const lane = queue[i];
    for (const before of lane.prev) {
      if (next.has(before)) continue;
      next.set(before, lane);
      queue.push(before);
      if (queue.length === budget) break;
    }
  }
  return next;
}

export class PatrolDispatch {
  constructor({ graph, canSee, routeDriver, notify }) {
    this.graph = graph;
    this.canSee = canSee;
    this.routeDriver = routeDriver;
    this.notify = notify;
    this.units = new Set();
    this.mobile = [];
    this.enabled = true;
    // Reused by the HUD, never contains renderer or physics objects.
    this.status = { mode: 'patrol', heat: 0, responding: 0, nearby: false, officers: 0 };
    /** What the audio module turns into a wail: a level 0..1 and where it comes from. */
    this.siren = { level: 0, position: [0, 0, 0] };
    this.reset();
  }

  reset() {
    for (const unit of this.units) this.assign(unit, null);
    this.active = false;
    this.violation = this.speeding = this.lost = this.still = this.age = this.grace = this.scanIn = this.impactCooldown = 0;
    this.speedLimit = 15;
    this.witness = this.contact = false;
    this.goal = null;
    this.route = new Map();
    this.mobile.length = 0;
    Object.assign(this.status, { mode: 'patrol', heat: 0, responding: 0, nearby: false, officers: 0 });
  }

  add(unit) { this.units.add(unit); this.scanIn = 0; }
  remove(unit) { this.assign(unit, null); this.units.delete(unit); this.scanIn = 0; }

  assign(unit, route) {
    unit.responding = route !== null && !!unit.driver && !unit.box.pushed;
    if (unit.driver && unit.driver.patrolRoute !== route) this.routeDriver(unit.driver, route);
  }

  /** A real collision with traffic, reported by the physics world. A unit can
   * radio its own collision even if the impact immediately disables its car. */
  impact(other, speed) {
    if (!this.active || this.grace > 0 || this.impactCooldown > 0) return;
    const cruiser = this.units.has(other);
    if (cruiser ? speed < 2.5 : !this.witness || speed < 6) return;
    this.violation = Math.max(this.violation, cruiser ? 2 : 1);
    this.impactCooldown = 3;
  }

  scan(focus) {
    const list = this.mobile;
    list.length = 0;
    this.witness = this.contact = false;
    for (const unit of this.units) {
      const p = unit.box.pos;
      unit.range = Math.hypot(p[0] - focus.x, p[1] - focus.y, p[2] - focus.z);
      if (unit.box.pushed) { this.assign(unit, null); continue; }
      if (unit.driver && !unit.driver.finished) list.push(unit);
      if (unit.range <= CONTACT && this.canSee(unit, focus)) {
        this.contact = true;
        if (unit.range <= OBSERVE) this.witness = true;
      }
    }
    list.sort((a, b) => a.range - b.range || a.id - b.id);
    this.status.nearby = this.witness;
    // Where the units are sent is the lane the player was last seen on: refreshed while anybody has
    // him in view, and taken from his position once at the start of an incident. After that the
    // search runs on the last sighting, which is what makes losing the officers mean something.
    // One map per sighting: never rebuilt at physics frequency.
    if (this.contact || (this.status.heat && !this.goal)) {
      const lane = this.graph.nearest(focus.x, focus.z, 60, ROAD)?.lane;
      if (lane) {
        this.speedLimit = lane.speedLimit;
        if (lane !== this.goal) { this.goal = lane; this.route = routesTo(lane); }
      }
    }
    this.deploy();
  }

  deploy() {
    // An empty map would be obeyed as "no route" by the driver and read as "responding" here, so
    // an incident nobody has placed yet sends nobody anywhere.
    const route = this.route && this.route.size > 0 ? this.route : null;
    let n = 0;
    for (const unit of this.mobile) {
      // A scan may have been invalidated by streaming or an impact.
      if (!this.units.has(unit) || !unit.driver || unit.box.pushed) continue;
      const needed = route !== null && n < this.status.heat && unit.range <= 400;
      this.assign(unit, needed ? route : null);
      if (needed) n++;
    }
    this.status.responding = n;
  }

  finish(mode, message) {
    this.status.heat = 0;
    this.status.mode = mode;
    this.notify(message);
    this.deploy();
    this.grace = GRACE_SECONDS;
    this.speeding = this.lost = this.still = this.age = 0;
    this.goal = null;
    this.siren.level = 0;
  }

  step(dt, focus, driving) {
    if (!(dt > 0)) return;
    if (!driving || !this.enabled || !this.graph) {
      if (this.active) this.reset();
      this.siren.level = 0;
      return;
    }
    this.active = true;
    this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    this.scanIn -= dt;
    if (this.scanIn <= 0) { this.scan(focus); this.scanIn = SCAN_SECONDS; }
    if (this.grace > 0) {
      this.grace = Math.max(0, this.grace - dt);
      if (this.grace < GRACE_SECONDS - 3.5) this.status.mode = 'patrol';
      this._siren(focus);
      return;
    }
    const s = this.status, speed = Math.hypot(focus.vx, focus.vz);
    if (!s.heat) this.speeding = this.witness && speed > this.speedLimit + 6 ? this.speeding + dt : 0;
    if (this.violation || this.speeding >= 1.25) {
      const cause = this.violation === 2 ? 'Patrol car struck' : this.violation ? 'Collision reported' : 'Speeding';
      s.heat = Math.min(3, s.heat ? s.heat + 1 : Math.max(1, this.violation));
      this.violation = this.speeding = 0;
      this.notify(`${cause} · Pull over for Paloma PD`);
      this.scan(focus);
    }
    if (!s.heat) return;
    this.age += dt;
    this.lost = this.contact ? 0 : this.lost + dt;
    s.mode = this.lost > 1.5 ? 'search' : 'pursuit';
    const lead = this.mobile[0];
    this.still = this.contact && lead?.responding && lead.range < 22 && speed < 1.1 ? this.still + dt : 0;
    if (this.still >= STOP_SECONDS) this.finish('cleared', 'Traffic stop complete · Drive safely');
    else if (this.lost >= SEARCH_SECONDS) this.finish('escaped', 'Search called off');
    else if (this.contact && s.heat < 3 && this.age >= s.heat * 35) {
      s.heat++;
      this.notify('Dispatch · Additional unit requested');
      this.deploy();
    }
  }

  /**
   * How the wail is heard: the nearest unit's distance (the audio engine places it, as it does
   * the traffic) and a level that falls away with it. It fades out on its own terms, so that
   * losing the units does not cut the siren off in mid-wail.
   */
  _siren(focus) {
    const out = this.siren, unit = this.status.heat ? this.mobile[0] : null;
    if (!unit) {
      out.level = Math.max(0, out.level - 0.06);
      return;
    }
    const p = unit.box.renderPos;
    const d = Math.max(1, Math.hypot(p[0] - focus.eye[0], p[1] - focus.eye[1], p[2] - focus.eye[2]));
    out.position[0] = p[0]; out.position[1] = p[1]; out.position[2] = p[2];
    out.level = (unit.responding ? 1 : 0.5) * (0.12 + 0.88 * (1 - Math.min(1, d / 190)));
  }

  /**
   * Orders an incident from outside, at the level the dispatch would have arrived at by watching
   * one. It is there for scripts: a machine on a software renderer may not earn a real violation
   * within the time a check can wait, and `order` sends the units through the same deployment,
   * the same routing and the same officers as a witnessed one. It creates no vehicle and moves
   * none: with nothing on the road to send, it is a number and nothing more.
   */
  order(heat, message = 'Dispatch · Patrol car ordered to pull you over') {
    const want = Math.max(0, Math.min(3, heat | 0));
    if (!want) {
      if (this.status.heat) this.finish('cleared', 'Traffic stop complete \u00b7 Drive safely');
      else this.reset();
      return this.status;
    }
    this.active = true;
    this.enabled = true;
    this.grace = 0;
    this.violation = this.speeding = this.lost = this.still = this.age = 0;
    this.status.heat = want;
    this.notify(message);
    this.scanIn = 0;
    return this.status;
  }

  /** A public copy for tools; not used to drive the simulation. */
  snapshot() {
    return { ...this.status, units: Array.from(this.units, u => ({
      id: u.id, position: [...u.box.pos], yaw: u.box.yaw, mobile: !!u.driver, bar: !!u.lightBar,
      responding: !!u.responding, onFoot: !!u.officer,
    })) };
  }
}
