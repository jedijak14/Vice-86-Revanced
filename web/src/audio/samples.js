// Playback of the recorded sounds: the engine of the car in hand, its horn, the starter, the gearbox,
// the doors and the impacts, from the WAV files `tools/make_audio.py` renders into `web/assets/audio/`.
//
// The DSP synth in `dsp/` stays, and stays in charge of everything that is not the machine the player
// is sitting in: road noise, the traffic around him, rain, the city, thunder, the menu. What it does
// not do any more, once these files have loaded, is that car's engine and horn -- `P.SAMPLES` tells it
// to fade those out so the two never speak at once. If the files cannot be fetched or decoded (offline,
// a device that refuses), nothing here is built, `ready` stays false and the synth carries on exactly
// as it did: the game is never silent because a sample went missing.
//
// The browser's job here is deliberately small and all of it is standard Web Audio: a loop per rpm
// band, a crossfade between bands, one playback-rate change of no more than a fifth to bring a band to
// the live rpm, a low pass for a closed cabin, gain and pan for distance. Nothing is synthesised on the
// audio thread, and the per-frame work is a handful of comparisons that mostly change nothing.
//
// Memory is a lever, not an accident: `essentialOnly` (the low-memory budget) loads the car in hand,
// its horn, its starter and its door -- under 300 KB of files -- and leaves the impacts to the synth.

import { readVec3, panOf, distanceGain } from './spatial.js';

/** Where the files and their manifest live, relative to the page. */
export const ASSET_DIR = 'assets/audio/';

/** The three rpm bands of an engine loop, low to high. */
export const BANDS = Object.freeze(['idle', 'cruise', 'redline']);

/** A band may be pitched no further than this from the rate it was rendered at: a fifth either way.
 *  Past that a recording stops sounding like the machine it was made from and starts sounding slowed. */
export const RATE_LIMIT = 1.5;

/** Seconds for a band's gain or rate to move to its new value. */
export const CROSSFADE = 0.07;

/** The cabin low pass, wide open with the roof off and shut with it up. */
export const CABIN_OPEN_HZ = 7200, CABIN_SHUT_HZ = 760;

/** A held horn loops between these fractions of its file: past its attack, short of its release. */
export const HELD_HEAD = 0.05, HELD_TAIL = 0.88;

export const MAX_ONE_SHOTS = 8;          // impacts sounding at once; past that the new one is dropped
export const MAX_HORNS = 3;              // traffic cars honking at once; more is a wall, not information
export const MAX_CONCURRENT_LOADS = 4;

const ENGINE_LEVEL = 0.85, HORN_LEVEL = 0.5, SHOT_LEVEL = 0.8;
const STOP_SECONDS = 0.3;                // an engine's fade out
const ENGINE_REF_DISTANCE = 4;           // m: the car in hand is loud because it is close
const ENGINE_MAX_DISTANCE = 90;          // m: past this it is part of the street, not of the mix
const HORN_MAX_DISTANCE = 140;

/**
 * Weights for the three bands at `rpm`, given the rpm each was rendered at. Triangular in log rpm, so
 * two bands meet at half power halfway between them in *pitch* rather than in revs -- the ear's scale.
 * The weights always sum to 1. Below the idle band or above the redline band that band has it all, and
 * the playback rate carries the rest of the way, bounded by RATE_LIMIT.
 * @param {number} rpm
 * @param {number[]} centres one rendered rpm per band
 * @param {number[]} [out] array of three, reused rather than allocated
 */
export function bandWeights(rpm, centres, out = [0, 0, 0]) {
  const n = centres.length;
  for (let i = 0; i < n; i++) out[i] = 0;
  if (!(rpm > 0) || n === 0) return out;
  if (rpm <= centres[0]) { out[0] = 1; return out; }
  if (rpm >= centres[n - 1]) { out[n - 1] = 1; return out; }
  for (let i = 0; i < n - 1; i++) {
    const a = centres[i], b = centres[i + 1];
    if (rpm >= b) continue;
    const t = (Math.log2(rpm) - Math.log2(a)) / (Math.log2(b) - Math.log2(a));
    out[i] = 1 - t; out[i + 1] = t;
    return out;
  }
  out[n - 1] = 1;
  return out;
}

/** Playback rate that brings a band rendered at `ref` rpm to `rpm`, bounded to a fifth either way. */
export function rateFor(rpm, ref) {
  if (!(ref > 0)) return 1;
  const r = (rpm > 0 ? rpm : 0) / ref;
  return r < 1 / RATE_LIMIT ? 1 / RATE_LIMIT : r > RATE_LIMIT ? RATE_LIMIT : r;
}

/** Cabin low pass in Hz for a cabin closure of 0..1, easing so the last of the shut is the darkest. */
export function cabinHz(cabin) {
  const c = cabin > 1 ? 1 : cabin > 0 ? cabin : 0;
  return CABIN_SHUT_HZ + (CABIN_OPEN_HZ - CABIN_SHUT_HZ) * (1 - c) * (1 - c);
}

/**
 * Which files to fetch, in the order to fetch them: the car in hand first, because Drive is pressed
 * within a second of the page loading, then the horn and the starter, then whatever is left.
 * `essentialOnly` stops after the second group, which is what the low-memory budget asks for.
 * @param {{files: Array<{name: string}>}} manifest
 * @param {string[]} voices engine voices, most wanted first
 * @param {boolean} [essentialOnly]
 */
export function loadPlan(manifest, voices, essentialOnly = false) {
  const have = new Set((manifest.files || []).map((f) => f.name));
  const wanted = [];
  const push = (name) => { if (have.has(name) && !wanted.includes(name)) wanted.push(name); };
  for (const voice of voices || []) for (const band of BANDS) push(`${voice}_${band}.wav`);
  push('horn.wav'); push('horn_low.wav'); push('starter.wav'); push('shift.wav'); push('door.wav');
  if (!essentialOnly) for (const f of manifest.files || []) push(f.name);
  return wanted;
}

/**
 * @param {object} options
 *   context: the game's unlocked AudioContext; destination: the master bus it should join
 *   fetchFile(url) -> Promise<ArrayBuffer> and decode(bytes) -> Promise<AudioBuffer>: injectable, and
 *     the tests inject both, because there is no AudioContext in Node and no network in a unit test
 *   voices: engine voices in the order they are wanted; essentialOnly: the small set only
 *   onError(error), onReady(count): a load failed / the first playable set is in
 */
export function createSamples(options = {}) {
  const context = options.context || null;
  const destination = options.destination || (context && context.destination) || null;
  const dir = options.dir === undefined ? ASSET_DIR : options.dir;
  const fetchFile = options.fetchFile || defaultFetch;
  const decode = options.decode || (context ? defaultDecoder(context) : null);
  const wantedVoices = options.voices && options.voices.length ? options.voices : ['v8'];
  const essentialOnly = !!options.essentialOnly;

  /** @type {Map<string, AudioBuffer>} by file name */
  const buffers = new Map();
  /** @type {Map<string, object>} the manifest's entry for each file: loop, seconds, refRpm */
  const entries = new Map();
  const stats = { files: 0, bytes: 0, decoded: 0, dropped: 0, horns: 0, engine: null };
  const pos = [0, 0, 0], weights = [0, 0, 0];
  let ready = false, disposed = false, loading = null;
  let engine = null, engineVoice = '', playerHorn = null;
  /** The one-shots currently sounding. Tracked so dispose() can stop them: a source started with no
   *  stop time of its own would otherwise play out to the end of its buffer after the page is gone. */
  const shots = new Set();
  const horns = new Map();

  const api = {
    /** True once a playable set is decoded: from here on the recordings, not the synth, are the car. */
    get ready() { return ready; },
    get stats() { return stats; },
    get buffers() { return buffers; },
    /** Resolves when loading has finished, worked or not: what a loading screen or a test waits on. */
    get loaded() { return loading || Promise.resolve(); },
    setEngine, settle, setHorn, trafficHorn, play, dispose,
  };
  // Without a context there is nothing to play into: hand back the same shape, doing nothing, so the
  // page never has to ask whether samples exist before calling them.
  if (!context || !destination || !decode || typeof context.createGain !== 'function') return api;

  load();
  return api;

  // ------------------------------------------------------------------ loading

  function load() {
    if (loading) return loading;
    loading = fetchFile(dir + 'manifest.json')
      .then((bytes) => JSON.parse(textOf(bytes)))
      .then((doc) => {
        if (disposed || !doc || !Array.isArray(doc.files)) throw new Error('audio manifest is not a file list');
        for (const f of doc.files) entries.set(f.name, f);
        stats.files = entries.size;
        stats.bytes = num(doc.totalBytes, 0);
        return waves(loadPlan(doc, wantedVoices, essentialOnly));
      })
      .then(() => {
        if (disposed) return;
        stats.decoded = buffers.size;
        if (ready && options.onReady) options.onReady(buffers.size);
      })
      .catch((error) => { if (options.onError) options.onError(error); });
    return loading;
  }

  /** Fetches in groups, so the car's own bands are decoded before the last impact is even asked for. */
  function waves(names) {
    let at = 0;
    const next = () => {
      if (disposed) return Promise.resolve();
      const group = names.slice(at, at + MAX_CONCURRENT_LOADS);
      at += group.length;
      if (!group.length) return Promise.resolve();
      return Promise.all(group.map((name) => fetchOne(name).catch((error) => {
        if (options.onError) options.onError(error);
      }))).then(next);
    };
    return next();
  }

  function fetchOne(name) {
    if (buffers.has(name)) return Promise.resolve();
    return fetchFile(dir + name).then(decode).then((buffer) => {
      if (disposed || !buffer) return;
      buffers.set(name, buffer);
      stats.decoded = buffers.size;
      const voice = engineVoice || wantedVoices[0];
      if (!ready && hasBands(voice)) { ready = true; if (options.onReady) options.onReady(buffers.size); }
      // The voice the game asked for while its files were still coming in: build it now.
      if (ready && engineVoice && !engine && hasBands(engineVoice)) buildEngine();
    });
  }

  function hasBands(voice) {
    return !!voice && BANDS.every((band) => buffers.has(`${voice}_${band}.wav`));
  }

  // ------------------------------------------------------------------ the engine

  /**
   * The car in hand, once a frame. Every field is optional and read as a number.
   * @param {{ voice?: string, running?: boolean, rpm?: number, throttle?: number, load?: number,
   *           cabin?: number, position?: Array|object, listener?: Array|object,
   *           listenerForward?: Array|object }} s
   *        `running` false fades the engine out and drops its loops, which is what saves the audio
   *        thread when the car is off, and `position` against `listener` is what makes a car the player
   *        has stepped out of get quieter as he walks away from it instead of following his head.
   */
  function setEngine(s) {
    if (disposed || !s) return;
    const voice = s.voice || engineVoice || wantedVoices[0];
    if (voice !== engineVoice) { engineVoice = voice; buildEngine(); }
    if (!engine) return;
    const running = !!s.running && ready && hasBands(voice);
    if (running && !engine.started) engine.start();
    else if (!running && engine.started) engine.wantStop();
    if (!engine.started) { engine.settle(); return; }

    const rpm = num(s.rpm, 0);
    const load = num(s.load, num(s.throttle, 0));
    let level = ENGINE_LEVEL * (0.55 + 0.45 * clamp01(0.35 + load)), pan = 0;
    if (s.position && s.listener) {
      readVec3(s.position, pos);
      const distance = length3(s.listener, pos);
      level *= distance > 1 ? distanceGain(distance, ENGINE_REF_DISTANCE, ENGINE_MAX_DISTANCE) : 1;
      pan = panOf(s.listener, s.listenerForward || [0, 0, -1], pos);
    }
    engine.set(rpm, clamp01(s.cabin), level, pan);
    stats.engine = { voice, rpm: Math.round(rpm), level: Math.round(level * 100) / 100, bands: engine.bands.slice() };
  }

  /** Finishes a stop that has faded out. Safe to call every frame with the engine running or not. */
  function settle() { if (engine) engine.settle(); }

  function buildEngine() {
    if (engine) { engine.dispose(); engine = null; }
    if (!ready || !hasBands(engineVoice)) return;
    try { engine = makeEngine(engineVoice); } catch (error) {
      engine = null;
      if (options.onError) options.onError(error);
    }
  }

  /**
   * Three loops, three gains, one cabin filter, one level, one pan. The sources exist only while the
   * engine is meant to be heard, so a parked street or a shop runs no engine nodes at all.
   */
  function makeEngine(voice) {
    const files = BANDS.map((band) => `${voice}_${band}.wav`);
    const refs = files.map((name) => {
      const entry = entries.get(name);
      return entry && entry.refRpm > 0 ? entry.refRpm : 1000;
    });
    const out = context.createGain(); out.gain.value = 0;
    const cabinFilter = context.createBiquadFilter();
    cabinFilter.type = 'lowpass'; cabinFilter.frequency.value = CABIN_OPEN_HZ; cabinFilter.Q.value = 0.7;
    const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
    cabinFilter.connect(out);
    if (panner) { out.connect(panner); panner.connect(destination); } else out.connect(destination);
    const bandGains = files.map(() => {
      const g = context.createGain(); g.gain.value = 0; g.connect(cabinFilter); return g;
    });
    const lastRate = refs.map(() => -1), lastWeight = refs.map(() => -1);
    let lastCabin = -1, lastPan = NaN;
    let sources = null, stopping = false;

    const handle = {
      voice, bands: [0, 0, 0],
      get started() { return !!sources; },
      start() {
        if (sources || stopping) return;
        const t = context.currentTime;
        sources = files.map((name, i) => {
          const s = context.createBufferSource();
          s.buffer = buffers.get(name); s.loop = true;
          s.playbackRate.value = lastRate[i] > 0 ? lastRate[i] : 1;
          s.onended = () => safeDisconnect(s);
          s.connect(bandGains[i]);
          s.start(0);
          return s;
        });
        out.gain.cancelScheduledValues(t);
        out.gain.setTargetAtTime(1, t, 0.05);
      },
      wantStop() {
        if (!sources || stopping) return;
        stopping = true;
        out.gain.setTargetAtTime(0, context.currentTime, STOP_SECONDS / 3);
      },
      /** Drops the sources once the fade has actually finished, so a restart inside it cannot double up. */
      settle() {
        if (!sources || !stopping || out.gain.value > 0.004) return;
        const t = context.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.value = 0;
        for (const s of sources) { try { s.stop(); } catch (error) { /* never started */ } }
        sources = null; stopping = false;
        for (let i = 0; i < lastWeight.length; i++) { lastWeight[i] = -1; bandGains[i].gain.value = 0; }
        handle.bands[0] = handle.bands[1] = handle.bands[2] = 0;
      },
      set(rpm, cabin, level, pan) {
        const t = context.currentTime;
        bandWeights(rpm, refs, weights);
        for (let i = 0; i < weights.length; i++) {
          const w = weights[i], rate = rateFor(rpm, refs[i]);
          handle.bands[i] = w;
          lastRate[i] = rate;
          if (Math.abs(w - lastWeight[i]) > 0.003) { bandGains[i].gain.setTargetAtTime(w, t, CROSSFADE); lastWeight[i] = w; }
          if (sources && sources[i]) sources[i].playbackRate.setTargetAtTime(rate, t, CROSSFADE);
        }
        const hz = cabinHz(cabin);
        if (Math.abs(hz - lastCabin) > 8) { cabinFilter.frequency.setTargetAtTime(hz, t, 0.12); lastCabin = hz; }
        if (!stopping && Math.abs(level - out.gain.value) > 0.01) out.gain.setTargetAtTime(clamp01(level), t, 0.06);
        if (panner && !(Math.abs(pan - lastPan) < 0.01)) { panner.pan.setTargetAtTime(clamp1(pan), t, 0.08); lastPan = pan; }
      },
      dispose() {
        if (sources) for (const s of sources) { try { s.stop(); } catch (error) { /* never started */ } }
        sources = null; stopping = false;
        for (const g of bandGains) safeDisconnect(g);
        safeDisconnect(cabinFilter); safeDisconnect(out); safeDisconnect(panner);
      },
    };
    return handle;
  }

  // ------------------------------------------------------------------ horns

  /**
   * The player's own horn, held while `on`: the recording loops over its own sustain region, so holding
   * the key down sounds like a horn held down, not like a sample played out and started again.
   */
  function setHorn(on) {
    if (disposed || !ready) return;
    if (on && !playerHorn) { playerHorn = startHeld('horn.wav', HORN_LEVEL, 1, 0); stats.horns = countHorns(); }
    else if (!on && playerHorn) { playerHorn.release(); playerHorn = null; stats.horns = countHorns(); }
  }

  /**
   * A traffic car's horn, from where that car is. `id` keeps one car to one horn: the same id again with
   * `on` false stops it, and the same id with `on` true moves it with the car. Past MAX_HORNS at once the
   * extra cars stay silent, because a junction full of horns says nothing.
   * @param {string|number} id
   * @param {boolean} on
   * @param {{ position: Array|object, listener?: Array|object, forward?: Array|object, kind?: string }} place
   * @returns {boolean} whether a horn is sounding for that id
   */
  function trafficHorn(id, on, place) {
    if (disposed || !ready) return false;
    const key = id === undefined || id === null ? `#${horns.size}` : id;
    if (!on) {
      const held = horns.get(key);
      if (held) { held.release(); horns.delete(key); stats.horns = countHorns(); }
      return false;
    }
    if (horns.has(key)) { horns.get(key).place(place); return true; }
    if (horns.size >= MAX_HORNS) return false;
    let level = HORN_LEVEL * 0.8, pan = 0;
    if (place && place.position && place.listener) {
      readVec3(place.position, pos);
      level *= distanceGain(length3(place.listener, pos), 6, HORN_MAX_DISTANCE);
      pan = panOf(place.listener, place.forward || [0, 0, -1], pos);
    }
    if (level <= 0.002) return false;
    const held = startHeld(place && place.kind === 'low' ? 'horn_low.wav' : 'horn.wav', level, level, pan);
    if (!held) return false;
    horns.set(key, held);
    stats.horns = countHorns();
    return true;
  }

  /** A function declaration, not a const: the closure returns `api` above this line, so anything
   *  declared here with const or let would never be initialised and would throw when first used. */
  function countHorns() { return horns.size + (playerHorn ? 1 : 0); }

  /** One held horn: a looping source, a gain, a pan, and a release that lets the tail be heard. */
  function startHeld(name, level, gain, pan) {
    const buffer = buffers.get(name);
    if (!buffer) return null;
    try {
      const out = context.createGain(); out.gain.value = 0;
      const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
      if (panner) { panner.pan.value = clamp1(pan); out.connect(panner); panner.connect(destination); } else out.connect(destination);
      const s = context.createBufferSource();
      s.buffer = buffer; s.loop = true;
      s.loopStart = buffer.duration * HELD_HEAD;
      s.loopEnd = buffer.duration * HELD_TAIL;
      s.connect(out);
      const t = context.currentTime;
      out.gain.setTargetAtTime(level, t, 0.012);
      s.start(0);
      let gone = false;
      return {
        source: s, gain: out,
        /** Follows the car: level from distance, pan from the listener's heading. */
        place(next) {
          if (gone || !next || !next.position || !next.listener) return;
          readVec3(next.position, pos);
          const at = context.currentTime;
          out.gain.setTargetAtTime(level * distanceGain(length3(next.listener, pos), 6, HORN_MAX_DISTANCE), at, 0.08);
          if (panner) panner.pan.setTargetAtTime(panOf(next.listener, next.forward || [0, 0, -1], pos), at, 0.08);
        },
        release() {
          if (gone) return;
          gone = true;
          const at = context.currentTime;
          out.gain.cancelScheduledValues(at);
          out.gain.setTargetAtTime(0, at, 0.02);
          try { s.stop(at + 0.14); } catch (error) { /* already stopped */ }
          s.onended = () => { safeDisconnect(s); safeDisconnect(out); safeDisconnect(panner); };
        },
      };
    } catch (error) {
      if (options.onError) options.onError(error);
      return null;
    }
  }

  // ------------------------------------------------------------------ one-shots

  /**
   * A one-shot by name, with or without '.wav': 'starter', 'shift', 'door', 'hit_thud', 'hit_metal',
   * 'hit_glass', 'hit_scrape', 'splash'. `rate` pitches it -- a heavier car's door is a slower one --
   * and `position` against `listener` places it in the world; without one it is centred, which is right
   * for the car the player is sitting in.
   * @returns {boolean} whether it sounded (false: not loaded, or MAX_ONE_SHOTS already going)
   */
  function play(name, opts) {
    if (disposed || !ready) return false;
    const key = String(name).endsWith('.wav') ? String(name) : `${name}.wav`;
    const buffer = buffers.get(key);
    if (!buffer || shots.size >= MAX_ONE_SHOTS) { stats.dropped++; return false; }
    const o = opts || {};
    let level = clamp01(num(o.gain, 1)) * SHOT_LEVEL, pan = clamp1(num(o.pan, 0));
    if (o.position && o.listener) {
      readVec3(o.position, pos);
      level *= distanceGain(length3(o.listener, pos), 5, 150);
      pan = panOf(o.listener, o.forward || [0, 0, -1], pos);
    }
    if (level <= 0.002) return false;
    try {
      const out = context.createGain(); out.gain.value = level;
      const panner = pan && typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
      if (panner) { panner.pan.value = pan; out.connect(panner); panner.connect(destination); } else out.connect(destination);
      const s = context.createBufferSource();
      s.buffer = buffer;
      s.playbackRate.value = Math.min(RATE_LIMIT, Math.max(1 / RATE_LIMIT, num(o.rate, 1)));
      s.connect(out);
      shots.add(s);
      s.onended = () => { shots.delete(s); safeDisconnect(s); safeDisconnect(out); safeDisconnect(panner); };
      s.start(0);
      return true;
    } catch (error) {
      if (options.onError) options.onError(error);
      return false;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true; ready = false;
    if (playerHorn) { playerHorn.release(); playerHorn = null; }
    for (const held of horns.values()) held.release();
    horns.clear();
    if (engine) { engine.dispose(); engine = null; }
    // A one-shot has no stop time of its own, so without this it would play out to the end of its
    // buffer after the page had gone: dispose has to mean dispose.
    for (const s of shots) { try { s.stop(); } catch (error) { /* already ended */ } }
    shots.clear();
    buffers.clear();
    stats.engine = null; stats.horns = 0;
  }
}

// ------------------------------------------------------------------ helpers

function defaultFetch(url) {
  const f = typeof globalThis !== 'undefined' ? globalThis.fetch : null;
  if (typeof f !== 'function') return Promise.reject(new Error('no fetch'));
  return f(url, { credentials: 'same-origin' }).then((response) => {
    if (!response || !response.ok) throw new Error(`${url}: ${response ? response.status : 'no response'}`);
    return response.arrayBuffer();
  });
}

/** decodeAudioData is a promise in every current browser and a callback in the old ones; accept both. */
function defaultDecoder(context) {
  return (bytes) => new Promise((resolve, reject) => {
    const copy = bytes && bytes.slice ? bytes.slice(0) : bytes;   // Safari detaches what it is given
    let promise = null;
    try { promise = context.decodeAudioData(copy, resolve, reject); } catch (error) { reject(error); return; }
    if (promise && typeof promise.then === 'function') promise.then(resolve, reject);
  });
}

const textOf = (bytes) => (typeof TextDecoder === 'function'
  ? new TextDecoder().decode(new Uint8Array(bytes))
  : String.fromCharCode.apply(null, new Uint8Array(bytes)));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp01 = (v) => (v > 1 ? 1 : v > 0 ? v : 0) || 0;
const clamp1 = (v) => (v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0);
const safeDisconnect = (node) => { if (node) { try { node.disconnect(); } catch (error) { /* not connected */ } } };

function length3(a, b) {
  const x = num(a && a[0], 0) - num(b && b[0], 0);
  const y = num(a && a[1], 0) - num(b && b[1], 0);
  const z = num(a && a[2], 0) - num(b && b[2], 0);
  return Math.sqrt(x * x + y * y + z * z);
}
