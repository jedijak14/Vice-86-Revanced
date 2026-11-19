// Page API of the audio system (design/ARCHITECTURE.md section 11.4 and 16). Translates the
// game's per-frame state into the synth's control vector, computes everything that needs the
// listener (pan, distance, Doppler for traffic and impacts) and forwards events. Safe to create
// before any user gesture and when there is no AudioContext: every method is then a no-op.
// Nothing here allocates per frame once created.

import { createDsp } from './dsp/index.js';
import { createHost } from './host.js';
import { createSamples } from './samples.js';
import { createSiren } from './siren.js';
import { readVec3, panOf, distanceGain, dopplerRatio, TrafficMatcher } from './spatial.js';

const K = createDsp();
const { P, EV, GARAGE } = K;

const STALE_SECONDS = 0.3;                // no update() for this long counts as paused
const TRAFFIC_MAX_DISTANCE = 160;
const ENGINE_RUNNING_RPM = 220;           // below this the car in hand is off, and its loops are stopped

/** Which recording an impact kind plays. Anything unlisted is metal, as `K.impactCode` also decides. */
const SAMPLED_IMPACT = {
  wall: 'hit_thud', building: 'hit_thud', thud: 'hit_thud', ground: 'hit_thud',
  vehicle: 'hit_metal', car: 'hit_metal', traffic: 'hit_metal', pole: 'hit_metal', barrier: 'hit_metal', metal: 'hit_metal',
  glass: 'hit_glass', scrape: 'hit_scrape', splash: 'splash', water: 'splash',
};

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
  // The recordings of the car in hand (samples.js), built on the first update() once the page has been
  // unlocked, with the voice the game last named loaded first. Until they are in, `ready` is false on
  // that object and the synth speaks for the car as it always did; if they never arrive it keeps doing so.
  let samples = null, samplesFailed = false, sampleVoice = 'v8';
  let lastGear = 0, engineRunning = false;
  let playerHornOn = false, synthHornState = 0;
  /** Traffic cars honking through the synth because there are no recordings: ids, so one car is one horn. */
  const synthHorns = new Set();

  const audio = {
    /** True once the context is running and the synth is in the graph. */
    get ready() { return host.ready; },
    /** 'worklet', 'script' (main-thread fallback) or 'none'. */
    get mode() { return host.mode; },
    /** Last stats report from the synth (peak, limiter gain, compression), refreshed about twice a second. */
    get stats() { return host.stats; },
    /** True once the recorded engine, horn and impacts are decoded and speaking for the car in hand. */
    get sampled() { return !!(samples && samples.ready); },
    /** What the sample player has loaded and dropped, for the diagnostics readout. */
    get sampleStats() { return samples ? samples.stats : null; },
    unlock() { host.unlock(); },
    /** { master, effects }; other fields (an old stored `music`, for instance) are ignored. */
    setVolumes(v) {
      if (!v) return;
      if (v.master !== undefined) volumes.master = clamp01(v.master);
      if (v.effects !== undefined) volumes.effects = clamp01(v.effects);
      host.setMaster(volumes.master);
      state[P.EFFECTS] = volumes.effects;
    },
    update, setCar, garage, impact, horn, thunder, ui, afterfire, siren,
    play, trafficHorn, door, starter, shift,
    suspend() { host.suspend(); },
    resume() { host.resume(); },
    dispose() {
      if (sirenVoice) { sirenVoice.dispose(); sirenVoice = null; }
      if (samples) { samples.dispose(); samples = null; }
      host.dispose();
    },
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
    // The same name selects the recordings: the sample player keeps one set of loops per voice.
    if (typeof spec.voice === 'string' && spec.voice) sampleVoice = spec.voice;
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
    else if (event === 'drive') {
      if (state[P.GARAGE] === GARAGE.BROWSING) state[P.GARAGE] = GARAGE.LEAVING;
      starter();                                  // the recording cranks it; the synth's own engine fades
    }
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
    updateSamples(car);
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

  /** Builds the sample player the first time the page is unlocked and able to play into something. */
  function ensureSamples() {
    if (samples || samplesFailed) return;
    if (!host.ready || !host.context || !host.output) return;
    if (typeof host.context.createBufferSource !== 'function') { samplesFailed = true; return; }
    try {
      samples = createSamples({
        context: host.context,
        destination: host.output,
        // The car in hand first, then the rest of the fleet, so a garage visit never waits on a V12.
        voices: [sampleVoice, 'v8', 'v12', 'flat12', 'flat6t'],
        essentialOnly: !!options.essentialOnly,
        fetchFile: options.fetchFile,
        decode: options.decode,
        onError: (error) => { if (options.log) options.log(error); },
      });
    } catch (error) {
      samples = null; samplesFailed = true;
      if (options.log) options.log(error);
    }
  }

  /**
   * Hands the car in hand to its recordings, and tells the synth with P.SAMPLES whether they have it.
   * Also notices the two things the game does not announce as events: the engine catching, and a gear
   * going in under load -- both are simply read off the state the game already sends every frame.
   */
  function updateSamples(car) {
    ensureSamples();
    const rpm = car ? num(car.rpm, 0) : 0;
    const running = rpm > ENGINE_RUNNING_RPM && state[P.GARAGE] !== GARAGE.BROWSING;
    if (running && !engineRunning && samples && samples.ready) starter();
    const gear = car ? Math.round(num(car.gear, 0)) : 0;
    if (samples && samples.ready && running && gear > lastGear && rpm > 1800 && num(car.throttle, 0) > 0.25) shift();
    lastGear = gear; engineRunning = running;
    if (!samples) { state[P.SAMPLES] = 0; return; }
    samples.setEngine({
      voice: sampleVoice,
      running,
      rpm,
      throttle: car ? num(car.throttle, 0) : 0,
      load: car ? num(car.load, num(car.throttle, 0)) : 0,
      cabin: car ? num(car.cabin, 0) : 0,
      // With the car's own position the recordings fade and pan as the player walks away from a car he
      // has left idling, instead of following his head at full level the way a centred voice would.
      position: car && car.position ? car.position : null,
      listener: car && car.position ? listenerPos : null,
      listenerForward: listenerFwd,
    });
    samples.settle();
    state[P.SAMPLES] = samples.ready ? 1 : 0;
  }

  /**
   * @param {number} strength 0..1
   * @param {Array|object} [position] world position; omitted means at the car
   * @param {string} [kind] 'vehicle' | 'wall' | 'pole' | 'barrier' | 'scrape' | 'glass' | 'splash'
   */
  function impact(strength, position, kind) {
    const level = clamp01(strength);
    // The recordings carry each material's own resonances, so they get the impact when they are there;
    // the synth's version is the fallback, and it is a good one -- it is the same model, computed live.
    if (samples && samples.ready) {
      samples.play(SAMPLED_IMPACT[kind] || 'hit_metal', {
        gain: level,
        rate: 1 + (level - 0.5) * 0.12,          // a heavier blow is a fraction slower and darker
        position: position || null,
        listener: position ? listenerPos : null,
        forward: listenerFwd,
      });
      return;
    }
    let pan = 0, distance = 0;
    if (position) {
      readVec3(position, pos);
      pan = panOf(listenerPos, listenerFwd, pos);
      const dx = pos[0] - listenerPos[0], dy = pos[1] - listenerPos[1], dz = pos[2] - listenerPos[2];
      distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    host.postEvent(EV.IMPACT, level, pan, distance, K.impactCode(kind));
  }

  /** The player's own horn: a recording held down while the key is, the synth's voice otherwise. */
  function horn(on) {
    playerHornOn = !!on;
    if (samples && samples.ready) samples.setHorn(playerHornOn);
    syncSynthHorn();
  }

  /**
   * A traffic car's horn, from where that car is. `id` keeps one car to one horn: pass the same id with
   * `on` false when it gives up, and the same id with `on` true each frame to move it with the car.
   * @param {string|number} id the car
   * @param {boolean} on
   * @param {{ position: Array|object, listener?: Array|object, forward?: Array|object, kind?: string }} place
   *        `kind: 'low'` is a truck's or a bus's horn; `listener` and `forward` place it in the world.
   * @returns {boolean} whether a horn is sounding
   */
  function trafficHorn(id, on, place) {
    if (samples && samples.ready) return samples.trafficHorn(id, on, place);
    // No recordings: the synth's horn is one centred voice, so a junction full of them can only be one
    // beep. Say it once, from the middle, rather than not at all -- "you are in the way" is the whole
    // point of the honk, and losing it because an asset did not arrive would be the worse failure.
    const key = String(id);
    if (on) { synthHorns.add(key); syncSynthHorn(); return true; }
    synthHorns.delete(key);
    syncSynthHorn();
    return false;
  }

  /** The synth's horn speaks for the player and for any traffic car while there are no recordings. */
  function syncSynthHorn() {
    const on = playerHornOn || synthHorns.size > 0 ? 1 : 0;
    if (on !== synthHornState) { synthHornState = on; host.postEvent(EV.HORN, on); }
  }

  /**
   * Plays a recording by name, with or without '.wav'. Returns false when it is not loaded -- the
   * low-memory budget deliberately leaves the impacts out -- or when too many are already sounding.
   * @param {string} name
   * @param {{ gain?: number, rate?: number, pan?: number, position?: Array, listener?: Array, forward?: Array }} [opts]
   */
  function play(name, opts) {
    return !!(samples && samples.ready && samples.play(name, opts));
  }
  /** The starter motor cranking the car in hand; the recordings catch it, the synth fades out. */
  function starter() { play('starter'); }
  /** The gearbox's dogs going in. */
  function shift() { play('shift'); }
  /** A car door: the handle, the swing and the slam. `heavy` is a thicker door at a lower rate. */
  function door(heavy) { play('door', { rate: heavy ? 0.86 : 1 }); }
  function thunder(distance) { host.postEvent(EV.THUNDER, Math.max(0, num(distance, 1000))); }
  function ui(kind) { host.postEvent(EV.UI, K.uiCode(kind)); }
  /** Exhaust pops and bangs, scaled by strength 0..1 (lift-off, up-shifts, nitrous cut). */
  function afterfire(strength) { host.postEvent(EV.AFTERFIRE, clamp01(strength === undefined ? 0.6 : strength)); }

  /**
   * A patrol car's wail: level 0..1, and the world position it comes from (without one it is
   * simply "somewhere in the distance", which is what the dispatch reports when no unit is near).
   * Nothing of it is built before the level is asked for and nothing is kept once it is silent,
   * so a street with no police in it runs no extra nodes.
   */
  let sirenVoice = null;
  function siren(level, position) {
    const want = clamp01(num(level, 0));
    if (want < 0.01) {
      if (sirenVoice) { sirenVoice.dispose(); sirenVoice = null; }
      return;
    }
    if (!sirenVoice) {
      if (!host.ready || !host.context || !host.output || typeof host.context.createOscillator !== 'function') return;
      try { sirenVoice = createSiren(host.context, host.output); } catch (error) { return; }
    }
    let pan = 0;
    if (position) { readVec3(position, pos); pan = panOf(listenerPos, listenerFwd, pos); }
    sirenVoice.update(want, pan);
  }

  return audio;
}

const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0) || 0;
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
