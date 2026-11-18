// Page API of the audio system (design/ARCHITECTURE.md section 11.4 and 16). Translates the
// game's per-frame state into the synth's control vector, computes everything that needs the
// listener (pan, distance, Doppler for traffic and impacts) and forwards events. Safe to create
// before any user gesture and when there is no AudioContext: every method is then a no-op.
// Nothing here allocates per frame once created.

import { createDsp } from './dsp/index.js';
import { createHost } from './host.js';
import { readVec3, panOf, distanceGain, dopplerRatio, TrafficMatcher } from './spatial.js';

const K = createDsp();
const { P, EV, GARAGE } = K;

const STALE_SECONDS = 0.3;                // no update() for this long counts as paused
const TRAFFIC_MAX_DISTANCE = 160;

/**
 * @param {{ seed?: number, scope?: object }} options
 *        seed: noise generator seed (default from the clock); scope: where to find
 *        AudioContext (tests pass a mock).
 */
export function createAudio(options = {}) {
  const seed = options.seed === undefined ? (Date.now() % 2147483647) | 0 : options.seed | 0;
  const host = createHost({ seed, scope: options.scope });
  const state = new Float32Array(P.SIZE);
  state[P.REDLINE] = 7500; state[P.RPM] = 1000; state[P.HOUR] = 14; state[P.NEON] = -1;
  state[P.EFFECTS] = 1; state[P.TURBO] = -1;
  const volumes = { master: 1, effects: 1 };
  const matcher = new TrafficMatcher(P.TRAFFIC_VOICES);
  const listenerPos = [0, 0, 0], listenerFwd = [0, 0, -1], listenerVel = [0, 0, 0];
  const pos = [0, 0, 0], vel = [0, 0, 0];
  let sinceUpdate = 0, statsTimer = 0;

  const audio = {
    /** True once the context is running and the synth is in the graph. */
    get ready() { return host.ready; },
    /** 'worklet', 'script' (main-thread fallback) or 'none'. */
    get mode() { return host.mode; },
    /** Last stats report from the synth (peak, limiter gain, compression), refreshed about twice a second. */
    get stats() { return host.stats; },
    unlock() { host.unlock(); },
    /** { master, effects }; other fields (an old stored `music`, for instance) are ignored. */
    setVolumes(v) {
      if (!v) return;
      if (v.master !== undefined) volumes.master = clamp01(v.master);
      if (v.effects !== undefined) volumes.effects = clamp01(v.effects);
      host.setMaster(volumes.master);
      state[P.EFFECTS] = volumes.effects;
    },
    update, setCar, garage, impact, horn, thunder, ui, afterfire,
    suspend() { host.suspend(); },
    resume() { host.resume(); },
    dispose() { host.dispose(); },
  };

  /**
   * Names the car in hand: which engine is heard and where its rev range lies. Call it once
   * before the first update() and again on every car change; it is safe before unlock() and
   * takes effect with the next update(). The engine that was playing fades into the new one
   * inside the synth: nothing clicks and nothing in the audio graph changes.
   * @param {{ voice?: string, idle?: number, redline?: number, limiter?: number }} spec
   *        voice: 'v12' | 'flat12' | 'flat6t' | 'v8' (anything else plays the V12);
   *        idle, redline: rpm from the physics spec; limiter: rpm at which the ignition cut
   *        sets in, the redline when omitted. Other fields are ignored.
   */
  function setCar(spec) {
    if (!spec) return;
    state[P.VOICE] = K.voiceCode(spec.voice);
    state[P.IDLE] = num(spec.idle, 0); state[P.LIMITER] = num(spec.limiter, 0);
    if (spec.redline > 1000) state[P.REDLINE] = spec.redline;
  }

  /**
   * The garage scene, as events; each takes effect with the next update().
   * 'enter': the room closes around the listener (room tone; engine, road and traffic silent).
   * 'car': the car on show has changed (call setCar first). 'colour': its colour has changed.
   * 'drive': the chosen car's starter turns, the engine catches and settles; the roller door goes up.
   * 'leave': back to the street or the title; room and door fade, a running engine carries on.
   */
  function garage(event) {
    if (event === 'enter') state[P.GARAGE] = GARAGE.BROWSING;
    else if (event === 'drive') { if (state[P.GARAGE] === GARAGE.BROWSING) state[P.GARAGE] = GARAGE.LEAVING; }
    else if (event === 'leave') state[P.GARAGE] = GARAGE.STREET;
    else if (event === 'car' || event === 'colour') ui(event);
  }

  function update(dt, s) {
    if (!s) return;
    sinceUpdate = dt > 0 ? 0 : sinceUpdate + 1 / 60;
    state[P.PAUSED] = dt > 0 || sinceUpdate < STALE_SECONDS ? 0 : 1;
    const car = s.car, env = s.env;
    if (s.listener) {
      readVec3(s.listener.position, listenerPos); readVec3(s.listener.forward, listenerFwd); readVec3(s.listener.velocity, listenerVel);
    }
    if (car) {
      state[P.RPM] = num(car.rpm, 1000); state[P.REDLINE] = car.redline > 1000 ? car.redline : 7500;
      state[P.THROTTLE] = clamp01(car.throttle); state[P.LOAD] = clamp01(car.load === undefined ? car.throttle : car.load);
      state[P.GEAR] = num(car.gear, 1); state[P.SPEED] = Math.abs(num(car.speed, 0));
      state[P.SLIP] = clamp01(car.slip); state[P.SLIP_ANGLE] = num(car.slipAngle, 0); state[P.BRAKE] = clamp01(car.brake);
      state[P.SURFACE] = K.surfaceCode(car.surface); state[P.AIRBORNE] = car.airborne ? 1 : 0;
      state[P.WET] = clamp01(car.wet); state[P.CABIN] = clamp01(car.cabin); state[P.BOOST] = clamp01(car.boost);
      // Turbocharger boost 0..1 with its lag, if the physics reports one; without it the engine derives its own.
      state[P.TURBO] = typeof car.turbo === 'number' ? clamp01(car.turbo) : -1;
    }
    if (env) {
      state[P.RAIN] = clamp01(env.rain); state[P.WIND] = clamp01(env.wind); state[P.NIGHT] = clamp01(env.night);
      state[P.OCEAN] = clamp01(env.oceanProximity); state[P.CITY] = clamp01(env.cityDensity); state[P.COVER] = clamp01(env.underCover);
      state[P.HOUR] = env.timeOfDay === undefined ? 14 : ((num(env.timeOfDay, 14) % 24) + 24) % 24;
      state[P.DISTRICT] = K.districtCode(env.district);
      state[P.NEON] = env.neon === undefined || env.neon === null ? -1 : clamp01(env.neon);
    }
    updateTraffic(s.traffic, dt);
    host.postState(state);
    // Stats twice a second for whoever is diagnosing.
    statsTimer += dt;
    if (statsTimer > 0.5) { statsTimer = 0; host.pollStats(); }
  }

  /** Fills the traffic records: gain from distance, pan, Doppler, speed, kind, throttle, serial for slot hand-over. */
  function updateTraffic(list, dt) {
    const base = P.TRAFFIC, stride = P.TRAFFIC_STRIDE, slots = P.TRAFFIC_VOICES;
    const count = list ? Math.min(list.length, slots) : 0;
    const assign = matcher.match(list || [], count, dt > 0 ? dt : 1 / 60);
    for (let v = 0; v < slots; v++) state[base + v * stride] = 0;
    for (let i = 0; i < count; i++) {
      const slot = assign[i]; if (slot < 0) continue;
      const t = list[i], o = base + slot * stride;
      readVec3(t.position, pos); readVec3(t.velocity, vel);
      const dx = pos[0] - listenerPos[0], dy = pos[1] - listenerPos[1], dz = pos[2] - listenerPos[2];
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gain = distanceGain(distance, 6, TRAFFIC_MAX_DISTANCE);
      if (gain <= 0) continue;
      state[o] = gain; state[o + 1] = panOf(listenerPos, listenerFwd, pos);
      state[o + 2] = dopplerRatio(listenerPos, listenerVel, pos, vel);
      state[o + 3] = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);
      state[o + 4] = K.trafficKindCode(t.kind); state[o + 5] = clamp01(t.throttle === undefined ? 0.3 : t.throttle);
      state[o + 6] = distance; state[o + 7] = matcher.slots[slot].serial;
    }
  }

  /**
   * @param {number} strength 0..1
   * @param {Array|object} [position] world position; omitted means at the car
   * @param {string} [kind] 'vehicle' | 'wall' | 'pole' | 'barrier' | 'scrape' | 'glass' | 'splash'
   */
  function impact(strength, position, kind) {
    let pan = 0, distance = 0;
    if (position) {
      readVec3(position, pos);
      pan = panOf(listenerPos, listenerFwd, pos);
      const dx = pos[0] - listenerPos[0], dy = pos[1] - listenerPos[1], dz = pos[2] - listenerPos[2];
      distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    host.postEvent(EV.IMPACT, clamp01(strength), pan, distance, K.impactCode(kind));
  }
  function horn(on) { host.postEvent(EV.HORN, on ? 1 : 0); }
  function thunder(distance) { host.postEvent(EV.THUNDER, Math.max(0, num(distance, 1000))); }
  function ui(kind) { host.postEvent(EV.UI, K.uiCode(kind)); }
  /** Exhaust pops and bangs, scaled by strength 0..1 (lift-off, up-shifts, nitrous cut). */
  function afterfire(strength) { host.postEvent(EV.AFTERFIRE, clamp01(strength === undefined ? 0.6 : strength)); }

  return audio;
}

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0) || 0;
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
