// Signal-processing kernel shared by every synthesis module.
//
// How the DSP code is packaged (applies to every file in src/audio/dsp/):
// each file exports ONE function `defineX(K)` that adds its classes to the namespace object K
// and references nothing outside its own body except K and JavaScript built-ins. That makes
// the same source usable three ways without a build step:
//   - imported as an ES module on the page (fallback path) and in Node (offline tests),
//   - stringified with Function.prototype.toString and concatenated into a Blob that becomes
//     the AudioWorklet module (see dsp/index.js),
//   - evaluated in a bare VM context by the tests, which proves the worklet source is
//     self-contained.
// So: no imports, no module-scope helpers, no Math.random (noise is seeded and reproducible).
//
// Conventions: audio is rendered in control chunks of at most K.CHUNK frames. Parameters are
// smoothed once per chunk and every gain is ramped linearly inside the chunk, so nothing steps.

export function defineKernel(K) {
  const TAU = Math.PI * 2;
  K.TAU = TAU;
  /** Frames per control chunk. 32 frames at 48 kHz is a 1.5 kHz control rate. */
  K.CHUNK = 32;
  /** Added to recursive filter states: keeps them out of the denormal range, which is slow on x86. */
  const TINY = 1e-25;

  K.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  K.sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  K.lerp = (a, b, t) => a + (b - a) * t;
  K.smoothstep = (a, b, x) => { const t = K.sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  K.dbToGain = (db) => Math.pow(10, db / 20);
  K.midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  /** One-pole coefficient that covers 63 percent of a step in `seconds`, when ticked at `rate` Hz. */
  K.coef = (seconds, rate) => 1 - Math.exp(-1 / (Math.max(1e-5, seconds) * rate));
  /** Cheap sigmoid with unit slope at zero and asymptotes at +-1. */
  K.shape = (x) => x / (1 + (x < 0 ? -x : x));
  /** Equal-power pan gains for p in -1 (left) .. 1 (right). */
  K.panL = (p) => Math.cos((K.clamp(p, -1, 1) + 1) * 0.7853981634);
  K.panR = (p) => Math.sin((K.clamp(p, -1, 1) + 1) * 0.7853981634);

  // ------------------------------------------------------------------ sine table
  const SIN_N = 4096;
  const sinTable = new Float32Array(SIN_N + 1);
  for (let i = 0; i <= SIN_N; i++) sinTable[i] = Math.sin((i / SIN_N) * TAU);
  /** sin(2 pi * turns) by table lookup with linear interpolation. Any real argument. */
  K.sin1 = (turns) => {
    const x = (turns - Math.floor(turns)) * SIN_N;
    const i = x | 0;
    return sinTable[i] + (sinTable[i + 1] - sinTable[i]) * (x - i);
  };

  // ------------------------------------------------------------------ randomness
  /** Integer hash of up to three integers to [0, 1). Pure: used where content must be seekable. */
  K.hash = (a, b = 0, c = 0) => {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  /** xorshift32. One instance per noise source so that sources are uncorrelated. */
  class Rng {
    constructor(seed) { this.s = (Math.imul(seed | 0, 0x9e3779b1) ^ 0x5bd1e995) | 0 || 0x2545f491; }
    _step() { let s = this.s; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.s = s; return s; }
    /** White noise sample in [-1, 1). */
    white() { return this._step() / 2147483648; }
    /** Uniform in [0, 1). */
    float() { return (this._step() >>> 0) / 4294967296; }
    range(a, b) { return a + (b - a) * this.float(); }
    int(n) { return (this.float() * n) | 0; }
    chance(p) { return this.float() < p; }
  }
  K.Rng = Rng;

  /** Pink noise (about -3 dB per octave) from white, Paul Kellet's economy filter. Output roughly +-1. */
  class Pink {
    constructor(seed) { this.rng = new Rng(seed); this.b0 = 0; this.b1 = 0; this.b2 = 0; }
    next() {
      const w = this.rng.white();
      this.b0 = 0.99765 * this.b0 + w * 0.0990460;
      this.b1 = 0.96300 * this.b1 + w * 0.2965164;
      this.b2 = 0.57000 * this.b2 + w * 1.0526913;
      return (this.b0 + this.b1 + this.b2 + w * 0.1848) * 0.25;
    }
  }
  K.Pink = Pink;

  /**
   * Slow random control signal: a new uniform target every `period` ticks, approached smoothly.
   * Used for gusts, wander and drift. Tick it once per control chunk.
   */
  class Wander {
    constructor(seed, periodTicks, lo = -1, hi = 1) {
      this.rng = new Rng(seed); this.period = Math.max(1, periodTicks | 0); this.lo = lo; this.hi = hi;
      this.count = this.rng.int(this.period); this.target = this.rng.range(lo, hi); this.value = this.target;
      this.k = 2.5 / this.period;
    }
    tick() {
      if (--this.count <= 0) { this.count = this.period; this.target = this.rng.range(this.lo, this.hi); }
      this.value += (this.target - this.value) * this.k;
      return this.value;
    }
  }
  K.Wander = Wander;

  // ------------------------------------------------------------------ filters
  /** One-pole low-pass / high-pass. */
  class OnePole {
    constructor() { this.a = 1; this.z = 0; }
    set(hz, sr) { this.a = 1 - Math.exp(-TAU * Math.min(hz, sr * 0.49) / sr); return this; }
    lp(x) { this.z += (x - this.z) * this.a + TINY; return this.z; }
    hp(x) { this.z += (x - this.z) * this.a + TINY; return x - this.z; }
    reset() { this.z = 0; }
  }
  K.OnePole = OnePole;

  /**
   * Two-pole state-variable filter (trapezoidal integrators), stable under fast modulation.
   * Call one of lp / bp / hp per sample; bp has unit gain at the centre frequency.
   */
  class Svf {
    constructor() { this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.s1 = 0; this.s2 = 0; }
    set(hz, q, sr) {
      const g = Math.tan(Math.PI * K.clamp(hz, 10, sr * 0.45) / sr);
      this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
      return this;
    }
    lp(x) {
      const v3 = x - this.s2, v1 = this.a1 * this.s1 + this.a2 * v3, v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
      this.s1 = 2 * v1 - this.s1 + TINY; this.s2 = 2 * v2 - this.s2 + TINY; return v2;
    }
    bp(x) {
      const v3 = x - this.s2, v1 = this.a1 * this.s1 + this.a2 * v3, v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
      this.s1 = 2 * v1 - this.s1 + TINY; this.s2 = 2 * v2 - this.s2 + TINY; return v1 * this.k;
    }
    hp(x) {
      const v3 = x - this.s2, v1 = this.a1 * this.s1 + this.a2 * v3, v2 = this.s2 + this.a2 * this.s1 + this.a3 * v3;
      this.s1 = 2 * v1 - this.s1 + TINY; this.s2 = 2 * v2 - this.s2 + TINY; return x - this.k * v1 - v2;
    }
    reset() { this.s1 = 0; this.s2 = 0; }
  }
  K.Svf = Svf;

  /** Removes DC: one-pole high-pass a few hertz above zero. */
  class DcBlock {
    constructor(sr, hz = 12) { this.r = Math.exp(-TAU * hz / sr); this.x1 = 0; this.y1 = 0; }
    run(x) { const y = x - this.x1 + this.r * this.y1 + TINY; this.x1 = x; this.y1 = y; return y; }
  }
  K.DcBlock = DcBlock;

  /**
   * A value that moves linearly to its target across one control chunk: the click-free way to
   * apply a gain. Call aim(target, frames) before the sample loop and next() once per sample.
   */
  class Ramp {
    constructor(v = 0) { this.v = v; this.d = 0; }
    aim(target, frames) { this.d = (target - this.v) / frames; return this; }
    /**
     * Aims `frames` ahead like aim(), but moves no faster than one full 0..1 swing per
     * `fadeFrames`. Called once per chunk it gives a linear fade of fixed length that really
     * arrives, where re-aiming at a far target every chunk would only creep towards it.
     */
    slew(target, frames, fadeFrames) {
      const step = frames / fadeFrames, delta = target - this.v;
      return this.aim(this.v + (delta > step ? step : delta < -step ? -step : delta), frames);
    }
    next() { return (this.v += this.d); }
    /** True when the ramp rests at (practically) zero and is not about to leave it. */
    silent(target) { return this.v < 1e-5 && target < 1e-5; }
  }
  K.Ramp = Ramp;

  // ------------------------------------------------------------------ delay
  /** Circular delay line with fractional read. Length is rounded up to a power of two. */
  class Delay {
    constructor(maxSamples) {
      let n = 2; while (n < maxSamples + 4) n <<= 1;
      this.buf = new Float32Array(n); this.mask = n - 1; this.w = 0;
    }
    write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
    /** Sample written `d` writes ago (d >= 1), integer delay. */
    tap(d) { return this.buf[(this.w - d) & this.mask]; }
    /** Fractional delay with linear interpolation. */
    read(d) {
      const i = d | 0, f = d - i, a = this.buf[(this.w - i) & this.mask], b = this.buf[(this.w - i - 1) & this.mask];
      return a + (b - a) * f;
    }
    clear() { this.buf.fill(0); }
  }
  K.Delay = Delay;

  // ------------------------------------------------------------------ envelopes

  // ------------------------------------------------------------------ band-limited oscillators
  /** PolyBLEP residual for a unit step at phase 0, phase t in [0,1), increment dt. */
  K.blep = (t, dt) => {
    if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
    if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
    return 0;
  };
  /** Sawtooth -1..1 at phase t. */
  K.saw = (t, dt) => 2 * t - 1 - K.blep(t, dt);
  /** Pulse -1..1 with width pw. */
  K.pulse = (t, dt, pw) => {
    let t2 = t + 1 - pw; if (t2 >= 1) t2 -= 1;
    return (t < pw ? 1 : -1) + K.blep(t, dt) - K.blep(t2, dt);
  };

  // ------------------------------------------------------------------ wavetables
  /** In-place inverse FFT, radix 2. Input is the spectrum; output real part is the signal times n. */
  K.ifft = (re, im) => {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = TAU / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  };

  /**
   * A periodic waveform stored at several band limits, so it can be played at any pitch without
   * aliasing. Level L keeps harmonics 1 .. maxHarmonics / 2^L. All levels share one scale, chosen
   * so that the full-band level has unit RMS.
   */
  class Wavetable {
    /**
     * @param {number} maxHarmonics   harmonics in the richest level (must be below size / 4)
     * @param {number} levels         number of band-limited levels
     * @param {(h:number)=>number} amp     amplitude of harmonic h (1-based)
     * @param {(h:number)=>number} phase   phase of harmonic h in turns
     */
    constructor(maxHarmonics, levels, amp, phase) {
      const size = 4096;
      this.size = size; this.maxHarmonics = maxHarmonics; this.levels = levels; this.tables = [];
      const amps = new Float64Array(maxHarmonics + 1), phases = new Float64Array(maxHarmonics + 1);
      let power = 0;
      for (let h = 1; h <= maxHarmonics; h++) { amps[h] = amp(h); phases[h] = phase(h); power += 0.5 * amps[h] * amps[h]; }
      const norm = 1 / Math.sqrt(power || 1);
      const re = new Float64Array(size), im = new Float64Array(size);
      for (let level = 0; level < levels; level++) {
        re.fill(0); im.fill(0);
        const top = maxHarmonics >> level;
        for (let h = 1; h <= top; h++) {
          // Half amplitude in bins h and size - h gives a real cosine of full amplitude.
          const a = 0.5 * amps[h] * norm, c = Math.cos(TAU * phases[h]), s = Math.sin(TAU * phases[h]);
          re[h] = a * c; im[h] = a * s; re[size - h] = a * c; im[size - h] = -a * s;
        }
        K.ifft(re, im);
        const t = new Float32Array(size + 1);
        for (let i = 0; i < size; i++) t[i] = re[i];
        t[size] = t[0];
        this.tables.push(t);
      }
    }
    /** Fractional level at which the highest harmonic stays below `limitHz` for fundamental f0. */
    levelFor(f0, limitHz) {
      const l = Math.log2(Math.max(1e-6, (f0 * this.maxHarmonics) / limitHz));
      return K.clamp(l, 0, this.levels - 1);
    }
    /** Sample at phase (turns, in [0,1)) blending the two nearest levels. */
    read(phase, level) {
      const x = phase * this.size, i = x | 0, f = x - i;
      const l0 = level | 0, lf = level - l0, t0 = this.tables[l0];
      const a = t0[i] + (t0[i + 1] - t0[i]) * f;
      if (lf <= 0) return a;
      const t1 = this.tables[l0 + 1];
      return a + (t1[i] + (t1[i + 1] - t1[i]) * f - a) * lf;
    }
  }
  K.Wavetable = Wavetable;

  // ------------------------------------------------------------------ one-shot percussive element
  /**
   * A decaying sine with an optional pitch drop: the building block of thumps, pops and pings.
   * Inactive when its envelope has faded, so pools of them cost nothing at rest.
   */
  class Ping {
    constructor() { this.env = 0; this.decay = 0; this.phase = 0; this.inc = 0; this.incEnd = 0; this.slide = 0; this.delay = 0; }
    /** @param f0 start Hz  @param f1 end Hz  @param seconds decay to -60 dB  @param delaySamples onset delay */
    start(f0, f1, seconds, amp, sr, delaySamples = 0) {
      this.env = amp; this.decay = Math.exp(-6.9 / (seconds * sr)); this.phase = 0;
      this.inc = f0 / sr; this.incEnd = f1 / sr; this.slide = K.coef(seconds * 0.25, sr); this.delay = delaySamples | 0;
    }
    get active() { return this.env > 1e-5; }
    next() {
      if (this.delay > 0) { this.delay--; return 0; }
      if (this.env <= 1e-5) { this.env = 0; return 0; }
      this.inc += (this.incEnd - this.inc) * this.slide;
      this.phase += this.inc; if (this.phase >= 1) this.phase -= 1;
      const y = K.sin1(this.phase) * this.env;
      this.env *= this.decay;
      return y;
    }
  }
  K.Ping = Ping;

  /** A decaying burst of noise through a band-pass: clicks, crunches, splashes. */
  class Burst {
    constructor(seed) { this.rng = new Rng(seed); this.f = new Svf(); this.env = 0; this.decay = 0; this.att = 1; this.rise = 0; this.delay = 0; }
    start(hz, q, seconds, amp, sr, delaySamples = 0, attackSeconds = 0) {
      this.f.set(hz, q, sr); this.env = amp; this.decay = Math.exp(-6.9 / (seconds * sr)); this.delay = delaySamples | 0;
      // A short linear rise instead of a step keeps even loud bursts free of a leading click.
      this.rise = 0; this.att = 1 / Math.max(1, (attackSeconds || 0.0004) * sr);
    }
    get active() { return this.env > 1e-5; }
    next() {
      if (this.delay > 0) { this.delay--; return 0; }
      if (this.env <= 1e-5) { this.env = 0; return 0; }
      if (this.rise < 1) this.rise = Math.min(1, this.rise + this.att);
      const y = this.f.bp(this.rng.white()) * this.env * this.rise;
      this.env *= this.decay;
      return y;
    }
  }
  K.Burst = Burst;
}
