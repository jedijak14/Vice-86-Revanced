// The recorded sounds: the files `tools/make_audio.py` renders, and the player that speaks them.
//
// These read web/assets/audio/**, which is what the browser fetches, so a re-render that moved a byte, a
// manifest that no longer matches the files on disk, or a loop that would click once a second all fail
// here rather than showing up as a car that sounds wrong on somebody's phone. There is no AudioContext in
// Node, so the player is driven through a mock that records what it was asked to do: which sources were
// started, whether they loop, at what rate, and what the gains were set to. The mock is the only way to
// ask those questions, and every assertion is about a number the game depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  createSamples, bandWeights, rateFor, cabinHz, loadPlan,
  BANDS, RATE_LIMIT, CABIN_OPEN_HZ, CABIN_SHUT_HZ, HELD_HEAD, HELD_TAIL,
  MAX_ONE_SHOTS, MAX_HORNS,
} from '../../web/src/audio/samples.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(here, '..', '..', 'web', 'assets', 'audio');

// ------------------------------------------------------------------ the files themselves

/** Reads the WAV header and the samples, so the assertions are about the bytes that ship. */
async function readWav(name) {
  const bytes = new Uint8Array(await readFile(path.join(AUDIO_DIR, name)));
  const text = (at, len) => String.fromCharCode(...bytes.subarray(at, at + len));
  assert.equal(text(0, 4), 'RIFF', `${name}: not a RIFF file`);
  assert.equal(text(8, 4), 'WAVE', `${name}: not a WAVE file`);
  let at = 12, fmt = null, data = null;
  while (at + 8 <= bytes.length) {
    const id = text(at, 4);
    const size = bytes[at + 4] | (bytes[at + 5] << 8) | (bytes[at + 6] << 16) | (bytes[at + 7] << 24);
    if (id === 'fmt ') {
      fmt = {
        encoding: bytes[at + 8] | (bytes[at + 9] << 8),
        channels: bytes[at + 10] | (bytes[at + 11] << 8),
        sampleRate: bytes[at + 12] | (bytes[at + 13] << 8) | (bytes[at + 14] << 16) | (bytes[at + 15] << 24),
        bits: bytes[at + 22] | (bytes[at + 23] << 8),
      };
    } else if (id === 'data') data = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size & 1);                    // chunks are padded to an even length
  }
  assert.ok(fmt, `${name}: no fmt chunk`);
  assert.ok(data, `${name}: no data chunk`);
  const n = data.length >> 1;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = data[i * 2] | (data[i * 2 + 1] << 8);
    samples[i] = (v < 32768 ? v : v - 65536) / 32768;
  }
  return { fmt, samples, seconds: n / fmt.sampleRate };
}

/** The biggest step inside a file, and the step across its join: what decides whether a loop clicks. */
function joinRatio(x) {
  let biggest = 0;
  for (let i = 1; i < x.length; i++) {
    const d = Math.abs(x[i] - x[i - 1]);
    if (d > biggest) biggest = d;
  }
  return { ratio: Math.abs(x[0] - x[x.length - 1]) / (biggest || 1e-12), biggest };
}

/** Amplitude of one frequency, as a fraction of the strongest line in the file. */
function lineAt(x, sr, hz) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    const a = -2 * Math.PI * hz * i / sr;
    re += x[i] * Math.cos(a); im += x[i] * Math.sin(a);
  }
  return Math.hypot(re, im) / x.length;
}

let manifest = null;
const theManifest = async () => (manifest ||= JSON.parse(
  new TextDecoder().decode(await readFile(path.join(AUDIO_DIR, 'manifest.json')))));

test('the manifest is a complete account of the files on disk', async () => {
  const doc = await theManifest();
  assert.ok(Array.isArray(doc.files) && doc.files.length >= 20, 'the manifest lists the rendered set');
  assert.equal(doc.licence, 'CC0 1.0 Universal', 'the licence is stated, as it is for the models');
  let total = 0;
  for (const f of doc.files) {
    const bytes = await readFile(path.join(AUDIO_DIR, f.name));
    assert.equal(bytes.length, f.bytes, `${f.name}: the manifest's byte count is not the file's`);
    total += bytes.length;
    assert.equal(f.sampleRate, 32000, `${f.name}: sample rate`);
    assert.equal(f.channels, 1, `${f.name}: mono, so it can be panned around the listener`);
  }
  assert.equal(doc.totalBytes, total, 'the roll-up total is the sum of the files');
  for (const voice of ['v8', 'v12', 'flat12', 'flat6t']) {
    for (const band of BANDS) {
      assert.ok(doc.files.some((f) => f.name === `${voice}_${band}.wav`), `${voice}/${band} is rendered`);
    }
  }
});

test('every file is 16-bit PCM mono at the rate the manifest says, and lasts as long as it says', async () => {
  const doc = await theManifest();
  for (const f of doc.files) {
    const { fmt, samples, seconds } = await readWav(f.name);
    assert.equal(fmt.encoding, 1, `${f.name}: PCM, not something a browser has to negotiate`);
    assert.equal(fmt.channels, 1, `${f.name}: one channel`);
    assert.equal(fmt.bits, 16, `${f.name}: 16 bits`);
    assert.equal(fmt.sampleRate, f.sampleRate, `${f.name}: sample rate matches the manifest`);
    assert.ok(Math.abs(seconds - f.seconds) < 1e-3, `${f.name}: ${seconds}s of audio, manifest says ${f.seconds}s`);
    assert.ok(samples.length > 1000, `${f.name}: there is audio in it`);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.2, `${f.name}: not silence (peak ${peak.toFixed(3)})`);
    assert.ok(peak <= 0.95, `${f.name}: inside the ceiling it was normalised to (peak ${peak.toFixed(3)})`);
  }
});

test('an engine loop joins up with itself, so it does not click once a second', async () => {
  const doc = await theManifest();
  const loops = doc.files.filter((f) => f.loop);
  assert.equal(loops.length, 12, 'four engines by three bands');
  for (const f of loops) {
    const { samples } = await readWav(f.name);
    const { ratio } = joinRatio(samples);
    // A truly periodic signal scores about 1: its join step is just another sample-to-sample step. Well
    // over 1 means the join is a discontinuity the file never makes anywhere else -- a tick per loop.
    assert.ok(ratio <= 1.6, `${f.name}: join step is ${ratio.toFixed(2)}x the biggest step inside it`);
    assert.equal(f.seamless, true, `${f.name}: the tool reported a seam it does not have`);
  }
});

test('a one-shot ends at silence, so stopping it cannot click either', async () => {
  const doc = await theManifest();
  for (const f of doc.files.filter((e) => !e.loop)) {
    const { samples } = await readWav(f.name);
    const tail = samples.subarray(-32);
    let peak = 0;
    for (const v of tail) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak < 0.02, `${f.name}: its last 32 samples reach ${peak.toFixed(4)}`);
    assert.equal(f.seamless, null, `${f.name}: a one-shot has no seam to report`);
  }
});

test('each loop really turns at the rpm the manifest reports, and fires at the rate it says', async () => {
  const doc = await theManifest();
  const spec = doc.engines;
  for (const f of doc.files.filter((e) => e.loop)) {
    const voice = f.name.slice(0, f.name.indexOf('_'));
    const engine = spec[voice];
    assert.ok(engine, `${voice} is one of the four engines the game can be handed`);
    assert.ok(f.refRpm > 300, `${f.name}: reports the rpm it was rendered at`);
    // The firing frequency is the strongest thing in an engine's spectrum below 1 kHz, and it is what
    // the ear reads as rpm. If the file says 5 900 rpm and the loudest line is at 5 900/120*cylinders,
    // the recording is the engine it claims to be rather than a shape that happens to be filtered.
    const { samples } = await readWav(f.name);
    const sr = f.sampleRate;
    const want = f.firesPerSecond;
    const at = lineAt(samples, sr, want);
    let loudest = 0, loudestHz = 0;
    for (let hz = want * 0.7; hz <= want * 1.4; hz += sr / samples.length / 4) {
      const a = lineAt(samples, sr, hz);
      if (a > loudest) { loudest = a; loudestHz = hz; }
    }
    assert.ok(Math.abs(loudestHz - want) < sr / samples.length, `${f.name}: loudest line is ${loudestHz.toFixed(1)} Hz, not the ${want} Hz of ${f.refRpm} rpm`);
    assert.ok(at > loudest * 0.5, `${f.name}: the firing tone is the strongest thing near it`);
    assert.equal(Math.round(want * 120 / engine.cyl), Math.round(f.refRpm),
      `${f.name}: ${want} fires a second over ${engine.cyl} cylinders is ${f.refRpm} rpm`);
  }
});

test('the four engines are not the same sound at different speeds', async () => {
  const doc = await theManifest();
  const redlines = doc.files.filter((f) => f.name.endsWith('_redline.wav'));
  const rates = [];
  for (const f of redlines) rates.push(f.firesPerSecond);
  // A V12 at 7 400 rpm fires 740 times a second; a V8 at 5 900 fires 393. If these were one file pitched
  // four ways they would be proportional to rpm alone, and the cross-plane V8's own pattern (four even
  // groups of two close fires) is what puts a 49 Hz cycle fundamental under its 393 Hz firing tone.
  assert.equal(new Set(rates.map((r) => Math.round(r))).size, 4, 'four distinct firing rates');
  const v8 = await readWav('v8_redline.wav');
  const v12 = await readWav('v12_redline.wav');
  const of = (name) => doc.files.find((f) => f.name === name);
  const sr = 32000;
  // The cross-plane V8 fires in four even groups, so a crank-cycle note sits under its firing tone at
  // a quarter of it; the V12's twelve even fires leave nothing at a sixth of its own.
  const v8Cycle = lineAt(v8.samples, sr, of('v8_redline.wav').firesPerSecond / 4);
  const v12Cycle = lineAt(v12.samples, sr, of('v12_redline.wav').firesPerSecond / 6);
  assert.ok(v8Cycle > v12Cycle * 1.5,
    `the V8 carries its crank-cycle note (${v8Cycle.toFixed(4)}) where the V12 does not (${v12Cycle.toFixed(4)})`);
});

// ------------------------------------------------------------------ the player's arithmetic

test('band weights sum to one, meet at the crossover, and hand the ends over to one band', () => {
  const centres = [780, 2600, 5900];
  const out = [0, 0, 0];
  for (const rpm of [0, 300, 780, 1200, 2600, 4000, 5900, 7000, 12000]) {
    bandWeights(rpm, centres, out);
    const sum = out[0] + out[1] + out[2];
    if (rpm > 0) assert.ok(Math.abs(sum - 1) < 1e-9, `at ${rpm} rpm the weights sum to ${sum}`);
    for (const w of out) assert.ok(w >= 0 && w <= 1, `at ${rpm} rpm every weight is a gain`);
  }
  bandWeights(0, centres, out);
  assert.deepEqual(out, [0, 0, 0], 'an engine that is not turning has no band');
  bandWeights(300, centres, out);
  assert.deepEqual(out, [1, 0, 0], 'below the idle band, the idle band has it all and the rate carries it');
  bandWeights(12000, centres, out);
  assert.deepEqual(out, [0, 0, 1], 'and above the redline band, the redline band');
  // Halfway between two bands in *pitch* is where they hand over, which is the geometric mean of the rpms.
  const mid = Math.sqrt(centres[0] * centres[1]);
  bandWeights(mid, centres, out);
  assert.ok(Math.abs(out[0] - 0.5) < 1e-9 && Math.abs(out[1] - 0.5) < 1e-9,
    `at ${mid.toFixed(0)} rpm the two bands are equal, so the crossfade has no hole or bump in it`);
});

test('a band is pitched by the rpm ratio and never past a fifth', () => {
  assert.ok(Math.abs(rateFor(1500, 1500) - 1) < 1e-12, 'the rate it was rendered at plays at 1');
  assert.ok(Math.abs(rateFor(3000, 1500) - 2) > 1e-9, 'asking for twice the rpm asks for twice the rate...');
  assert.equal(rateFor(3000, 1500), RATE_LIMIT, '...and gets the limit instead, because past a fifth it is not the machine any more');
  assert.equal(rateFor(100, 1500), 1 / RATE_LIMIT, 'and the same below');
  assert.equal(rateFor(1500, 0), 1, 'a band that does not say what rpm it is plays at its own rate');
  assert.equal(rateFor(-5, 1500), 1 / RATE_LIMIT, 'a nonsense rpm cannot produce a nonsense rate');
});

test('the cabin filter is open with the roof off and shut with it up', () => {
  assert.equal(cabinHz(0), CABIN_OPEN_HZ, 'no cabin, no filter worth hearing');
  assert.equal(cabinHz(1), CABIN_SHUT_HZ, 'a closed car takes the top off the exhaust note');
  assert.ok(cabinHz(0.5) > CABIN_SHUT_HZ && cabinHz(0.5) < CABIN_OPEN_HZ, 'and it moves between');
  assert.ok(cabinHz(0.25) > cabinHz(0.75), 'the more cabin, the darker');
  assert.equal(cabinHz(-1), CABIN_OPEN_HZ, 'a nonsense value is clamped, not passed to the filter');
  assert.equal(cabinHz(9), CABIN_SHUT_HZ, 'in both directions');
});

test('the load plan asks for the car in hand first, and the low-memory budget stops early', async () => {
  const doc = await theManifest();
  const plan = loadPlan(doc, ['flat12', 'v8']);
  assert.deepEqual(plan.slice(0, 3), ['flat12_idle.wav', 'flat12_cruise.wav', 'flat12_redline.wav'],
    'the bands of the car in hand come first, because Drive is pressed within a second of loading');
  assert.ok(plan.indexOf('horn.wav') < plan.indexOf('hit_glass.wav'), 'the horn before the rarer impacts');
  assert.equal(plan.length, doc.files.length, 'nothing is left out when there is room for it');

  const small = loadPlan(doc, ['v8'], true);
  assert.ok(small.length < plan.length, 'the essential set is smaller');
  assert.ok(small.every((name) => !name.startsWith('hit_')), 'and leaves the impacts to the synth');
  let bytes = 0;
  for (const name of small) bytes += doc.files.find((f) => f.name === name).bytes;
  assert.ok(bytes < doc.totalBytes / 2,
    `the essential set is ${(bytes / 1000).toFixed(0)} KB of the ${(doc.totalBytes / 1000).toFixed(0)} KB rendered, which is the point of the budget`);
});

// ------------------------------------------------------------------ the player, driven

/**
 * A Web Audio mock that records what it was asked to do. Nothing here makes a sound.
 *
 * `setTargetAtTime` is modelled the way the real thing behaves -- an exponential approach that is only
 * part of the way there until time has passed -- because the player reads `gain.value` back to decide
 * when a fade has finished. A stub that jumps straight to the target would make every fade look instant
 * and the test would be asserting the stub's behaviour rather than the player's.
 */
function mockContext() {
  const log = { sources: [], gains: [], filters: [], panners: [], params: [], disconnects: 0 };
  const param = (value) => {
    const p = {
      value, target: value, tc: 0, at: 0, calls: 0,
      setTargetAtTime(v, t, tc) { p.target = v; p.tc = tc; p.at = t; p.calls++; return p; },
      cancelScheduledValues() { p.target = p.value; p.tc = 0; return p; },
      /** What Web Audio would have reached by `now`. */
      settle(now) {
        if (p.tc > 0 && now > p.at) p.value = p.target + (p.value - p.target) * Math.exp(-(now - p.at) / p.tc);
        else p.value = p.target;
      },
    };
    log.params.push(p);
    return p;
  };
  const node = (extra) => ({ disconnect() { log.disconnects++; }, connect() {}, ...extra });
  const context = {
    currentTime: 0,
    destination: node({}),
    createGain: () => { const g = node({ gain: param(0) }); log.gains.push(g); return g; },
    createBiquadFilter: () => { const f = node({ type: '', frequency: param(0), Q: param(0) }); log.filters.push(f); return f; },
    createStereoPanner: () => { const p = node({ pan: param(0) }); log.panners.push(p); return p; },
    createBufferSource: () => node({
      buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: param(1),
      start(at) { this.startedAt = at; this.running = true; log.sources.push(this); },
      stop(at) { this.stoppedAt = at; this.running = false; },
      onended: null,
    }),
    /** Moves the clock on and lets every scheduled ramp reach the value it would have by then. */
    advance(seconds) {
      context.currentTime += seconds;
      for (const p of log.params) p.settle(context.currentTime);
    },
  };
  return { context, log };
}

/** A player whose files come from the manifest without a network: decode is mocked, keyed by URL. */
async function playerWithBuffers(extra = {}) {
  const doc = await theManifest();
  const { context, log } = mockContext();
  const asked = [];
  const player = createSamples({
    context,
    destination: context.destination,
    voices: ['v8'],
    // The name travels in the bytes, because several fetches are in flight at once and "the last URL
    // asked for" is not necessarily the one these bytes belong to. decode() then sees exactly what
    // fetchFile returned, which is the real contract.
    fetchFile: async (url) => {
      const name = url.slice(url.lastIndexOf('/') + 1);
      asked.push(name);
      return new TextEncoder().encode(name === 'manifest.json' ? JSON.stringify(doc) : name).buffer;
    },
    decode: async (bytes) => {
      const text = new TextDecoder().decode(new Uint8Array(bytes));
      if (text.startsWith('{')) return null;                       // the manifest is not audio
      const f = doc.files.find((e) => e.name === text);
      return f ? { duration: f.seconds, name: f.name } : null;
    },
    ...extra,
  });
  await player.loaded;
  return { player, context, log, doc, asked };
}

test('with no AudioContext the player is inert, and the synth carries on speaking for the car', () => {
  const player = createSamples({});
  assert.equal(player.ready, false, 'nothing is ready');
  // None of these may throw: game.js calls them every frame whether or not there is a context.
  player.setEngine({ running: true, rpm: 3000, voice: 'v8' });
  player.settle();
  player.setHorn(true);
  assert.equal(player.trafficHorn('car-1', true, {}), false);
  assert.equal(player.play('door'), false);
  player.dispose();
});

test('a failure to fetch leaves the player not ready rather than half playing', async () => {
  const errors = [];
  const { context } = mockContext();
  const player = createSamples({
    context,
    destination: context.destination,
    voices: ['v8'],
    fetchFile: async () => { throw new Error('offline'); },
    decode: async () => null,
    onError: (e) => errors.push(e),
  });
  await player.loaded;
  assert.equal(player.ready, false, 'no files, no recordings');
  assert.equal(errors.length, 1, 'and the page is told once, not per file');
  assert.match(errors[0].message, /offline/);
  player.setEngine({ running: true, rpm: 3000 });
  assert.equal(player.play('door'), false, 'a one-shot says so rather than throwing');
  player.dispose();
});

test('the car in hand is fetched first, and the player is ready as soon as its three bands are in', async () => {
  const { player, asked } = await playerWithBuffers({ voices: ['flat12'] });
  assert.deepEqual(asked.slice(0, 4), ['manifest.json', 'flat12_idle.wav', 'flat12_cruise.wav', 'flat12_redline.wav'],
    'the manifest, then the bands of the car the game named');
  assert.equal(player.ready, true, 'ready once a playable set is in');
  assert.ok(player.buffers.has('flat12_idle.wav'));
});

test('the low-memory budget loads the car in hand and not the impacts', async () => {
  const { player, asked } = await playerWithBuffers({ voices: ['v8'], essentialOnly: true });
  assert.ok(asked.includes('v8_idle.wav'), 'the engine is loaded');
  assert.ok(asked.includes('horn.wav'), 'and the horn, because a car that cannot honk is not finished');
  assert.ok(!asked.some((n) => n.startsWith('hit_')), 'the impacts are left to the synth');
  assert.equal(player.play('hit_metal'), false, 'and say so rather than pretending to play one');
});

test('a running engine starts three loops and pitches them by the rpm it is given', async () => {
  const { player, log, doc } = await playerWithBuffers();
  const refs = BANDS.map((b) => doc.files.find((f) => f.name === `v8_${b}.wav`).refRpm);
  player.setEngine({ running: true, voice: 'v8', rpm: refs[1], load: 0.5 });
  const loops = log.sources.filter((s) => s.loop);
  assert.equal(loops.length, 3, 'one loop per band, and they are the only sources started');
  for (const s of loops) assert.equal(s.startedAt, 0, 'started now');
  assert.deepEqual(loops.map((s) => s.buffer.name), BANDS.map((b) => `v8_${b}.wav`),
    'and they are the bands of the car in hand, in order');
  // At exactly the cruise band's own rpm the cruise loop plays at rate 1 and carries all the weight,
  // while the idle and redline loops are silent: that is the crossfade having a clean middle.
  const rates = loops.map((s) => s.playbackRate.value);
  assert.ok(Math.abs(rates[1] - 1) < 1e-9, `the band being played at its own rpm runs at 1, not ${rates[1]}`);
  assert.ok(rates.every((r) => r >= 1 / RATE_LIMIT - 1e-9 && r <= RATE_LIMIT + 1e-9),
    `every loop is inside a fifth of the rate it was rendered at: ${rates.map((r) => r.toFixed(2)).join(', ')}`);
  const wanted = bandWeights(refs[1], refs, [0, 0, 0]);
  assert.deepEqual(player.stats.engine.bands, wanted, 'the reported band weights are the ones the gains were set to');
  assert.equal(player.stats.engine.voice, 'v8', 'and the voice the page can read back');

  // Halfway to the redline, in pitch, and both bands share it: no hole in the crossfade.
  const mid = Math.sqrt(refs[1] * refs[2]);
  player.setEngine({ running: true, voice: 'v8', rpm: mid, load: 1 });
  const shared = player.stats.engine.bands;
  assert.ok(Math.abs(shared[1] - 0.5) < 1e-9 && Math.abs(shared[2] - 0.5) < 1e-9,
    `at ${mid.toFixed(0)} rpm the cruise and redline bands are equal (${shared.map((w) => w.toFixed(3)).join(', ')})`);
  assert.equal(shared[0], 0, 'and the idle band is out of it');
});

test('an engine that stops fades out and its loops are dropped, so a parked street runs nothing', async () => {
  const { player, context, log } = await playerWithBuffers();
  player.setEngine({ running: true, voice: 'v8', rpm: 900 });
  const started = log.sources.filter((s) => s.running).length;
  assert.equal(started, 3, 'three loops are running');
  context.advance(0.4);                         // let the level ramp arrive, as it would while driving
  player.settle();
  assert.equal(log.sources.filter((s) => s.running).length, 3, 'and it is still running half a second in');

  player.setEngine({ running: false, voice: 'v8', rpm: 0 });
  context.advance(0.016);                       // one frame later
  player.settle();
  assert.equal(log.sources.filter((s) => s.running).length, 3,
    'a stop begins as a fade: the loops are still going one frame in, because cutting them is a click');

  context.advance(1.0);                         // the fade is 0.3 s, so a second is past it
  player.settle();
  assert.equal(log.sources.filter((s) => s.running).length, 0,
    'and once the fade has landed the sources are dropped, so a parked street runs no engine nodes');

  player.setEngine({ running: true, voice: 'v8', rpm: 900 });
  assert.equal(log.sources.filter((s) => s.running).length, 3,
    'a restart builds new sources rather than reviving stopped ones, which a BufferSource cannot do');
});

test('changing car rebuilds the loops, and a voice nobody loaded leaves the last one speaking', async () => {
  // With room for everything, the plan takes all four engines, so any car the garage can hand over is
  // already decoded: there is no first frame of silence when the player changes car.
  const { player, log, doc } = await playerWithBuffers({ voices: ['v8'] });
  assert.equal(player.buffers.size, doc.files.length, 'the whole set is in when the budget allows it');
  player.setEngine({ running: true, voice: 'v8', rpm: 900 });
  const running = () => log.sources.filter((s) => s.running);
  assert.deepEqual(running().map((s) => s.buffer.name), BANDS.map((b) => `v8_${b}.wav`),
    'the V8 has its three loops going');
  player.setEngine({ running: true, voice: 'v12', rpm: 900 });
  assert.deepEqual(running().map((s) => s.buffer.name), BANDS.map((b) => `v12_${b}.wav`),
    'changing car stops the old loops and starts the new engine\'s, so two engines are never speaking');
  assert.equal(player.stats.engine.voice, 'v12');

  // On the low-memory budget only the voices asked for are fetched, so a car outside that set has no
  // recordings: the engine that was speaking carries on rather than going silent mid-corner.
  const small = await playerWithBuffers({ voices: ['v8'], essentialOnly: true });
  assert.equal(small.player.buffers.has('flat12_idle.wav'), false, 'the flat-12 was never fetched');
  small.player.setEngine({ running: true, voice: 'v8', rpm: 900 });
  small.player.setEngine({ running: true, voice: 'flat12', rpm: 900 });
  assert.equal(small.player.stats.engine.voice, 'v8', 'and the V8 keeps speaking for it');
});

test('a held horn loops over its own sustain, so holding the key down sounds like holding it down', async () => {
  const { player, log, doc } = await playerWithBuffers();
  player.setHorn(true);
  const horn = log.sources[log.sources.length - 1];
  assert.equal(horn.buffer.name, 'horn.wav');
  assert.equal(horn.loop, true, 'it loops');
  const dur = doc.files.find((f) => f.name === 'horn.wav').seconds;
  assert.ok(Math.abs(horn.loopStart - dur * HELD_HEAD) < 1e-9, 'from just past its attack');
  assert.ok(Math.abs(horn.loopEnd - dur * HELD_TAIL) < 1e-9, 'to just before its release');
  player.setHorn(true);
  assert.equal(log.sources.filter((s) => s.buffer && s.buffer.name === 'horn.wav').length, 1,
    'holding it down does not start another horn');
  player.setHorn(false);
  assert.equal(horn.running, false, 'and letting go stops it, with its tail');
});

test('traffic horns are one per car, placed in the world, and capped', async () => {
  const { player, log } = await playerWithBuffers();
  const listener = [0, 0, 0], forward = [0, 0, -1];
  const place = (x, z) => ({ position: [x, 0, z], listener, forward });
  assert.equal(player.trafficHorn('car-1', true, place(8, 4)), true, 'the first car honks');
  assert.equal(player.trafficHorn('car-1', true, place(9, 4)), true, 'the same car keeps its own horn');
  assert.equal(log.sources.filter((s) => s.buffer && s.buffer.name === 'horn.wav').length, 1,
    'and does not stack a second one on itself');
  for (let i = 2; i <= MAX_HORNS + 2; i++) player.trafficHorn(`car-${i}`, true, place(10 + i, 5));
  const sounding = log.sources.filter((s) => s.running && s.buffer && s.buffer.name.startsWith('horn'));
  assert.equal(sounding.length, MAX_HORNS, `no more than ${MAX_HORNS} cars honk at once`);
  assert.equal(player.trafficHorn('car-1', false, place(8, 4)), false, 'giving up stops it');
  assert.equal(player.trafficHorn('far', true, place(900, 0)), false, 'and a car 900 m off is not worth a voice');
  assert.equal(player.trafficHorn('truck', true, { ...place(6, 2), kind: 'low' }), true, 'a low horn is a truck horn');
  assert.ok(log.sources.some((s) => s.buffer && s.buffer.name === 'horn_low.wav'));
});

test('one-shots are placed in the world and capped, and a name with or without .wav is the same sound', async () => {
  const { player, log } = await playerWithBuffers();
  assert.equal(player.play('door'), true, 'by name');
  assert.equal(player.play('door.wav'), true, 'or by file name');
  const shots = log.sources.filter((s) => s.buffer && s.buffer.name === 'door.wav');
  assert.equal(shots.length, 2);
  assert.equal(shots[0].loop, false, 'a one-shot does not loop');
  for (let i = 0; i < MAX_ONE_SHOTS + 4; i++) player.play('hit_metal');
  const running = log.sources.filter((s) => s.running).length;
  assert.ok(running <= MAX_ONE_SHOTS + 2, `the cap holds: ${running} sources running`);
  assert.ok(player.stats.dropped > 0, 'and what was refused is counted rather than silently lost');
  assert.equal(player.play('not_a_sound'), false, 'an unknown name says no');
});

test('a one-shot can be pitched and placed, which is how a heavier car gets a heavier door', async () => {
  const { player, log } = await playerWithBuffers();
  player.play('door', { rate: 0.86, position: [3, 0, -2], listener: [0, 0, 0], forward: [0, 0, -1] });
  const door = log.sources[log.sources.length - 1];
  assert.ok(Math.abs(door.playbackRate.value - 0.86) < 1e-9, 'pitched down');
  player.play('door', { rate: 99 });
  assert.equal(log.sources[log.sources.length - 1].playbackRate.value, RATE_LIMIT, 'and a silly rate is clamped');
  assert.ok(log.panners.length > 0, 'a placed sound is panned');
});

test('dispose stops everything and leaves nothing to be started again', async () => {
  const { player, log } = await playerWithBuffers();
  player.setEngine({ running: true, voice: 'v8', rpm: 3000 });
  player.setHorn(true);
  player.trafficHorn('car-1', true, { position: [5, 0, 5], listener: [0, 0, 0] });
  player.play('door');
  player.dispose();
  assert.equal(player.ready, false);
  assert.equal(player.buffers.size, 0, 'the decoded buffers are given back');
  assert.equal(log.sources.filter((s) => s.running).length, 0, 'nothing is left sounding');
  player.setEngine({ running: true, voice: 'v8', rpm: 3000 });
  player.setHorn(true);
  assert.equal(player.play('door'), false, 'and a disposed player stays disposed');
});
