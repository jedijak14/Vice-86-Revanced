// Effects and dynamics: feedback-delay-network reverb, bus compressor and look-ahead limiter.
// Packaging rules: see the header of kernel.js.

export function defineFx(K) {
  const { Delay, OnePole, Svf, clamp, coef, sin1 } = K;

  // ================================================================== reverb
  // Delay lengths in samples at 48 kHz, mutually prime, 30 to 68 ms.
  const FDN_LENGTHS = [1423, 1637, 1873, 2141, 2399, 2687, 2971, 3251];
  const DIFFUSER_LENGTHS = [211, 337, 149, 271];

  /** Schroeder allpass used to smear the input before the network. */
  class Allpass {
    constructor(length, gain) { this.d = new Delay(length + 2); this.len = length; this.g = gain; }
    run(x) { const z = this.d.tap(this.len), v = x + z * this.g; this.d.write(v); return z - v * this.g; }
  }

  /**
   * Eight delay lines mixed by a Householder reflection (every line feeds every other, energy
   * preserved), each with a damping low-pass and a gain set from the decay time. Two lines are
   * slowly modulated so the tail does not ring at fixed pitches. Mono or stereo in, stereo out.
   */
  class Reverb {
    /**
     * @param {number} size      scales the delay lengths: 1 is a hall, 0.45 a tight room
     * @param {number} seconds   time for the tail to fall 60 dB
     * @param {number} dampHz    low-pass in the loop: lower is darker
     */
    constructor(sr, size, seconds, dampHz, preDelaySeconds = 0.018) {
      this.sr = sr; this.size = size;
      const scale = (sr / 48000) * size;
      this.lines = []; this.lengths = new Float32Array(8); this.gains = new Float32Array(8); this.damp = [];
      for (let i = 0; i < 8; i++) {
        const len = Math.round(FDN_LENGTHS[i] * scale);
        this.lengths[i] = len; this.lines.push(new Delay(len + 64)); this.damp.push(new OnePole());
      }
      this.diffL = [new Allpass(Math.round(DIFFUSER_LENGTHS[0] * scale), 0.6), new Allpass(Math.round(DIFFUSER_LENGTHS[1] * scale), 0.6)];
      this.diffR = [new Allpass(Math.round(DIFFUSER_LENGTHS[2] * scale), 0.6), new Allpass(Math.round(DIFFUSER_LENGTHS[3] * scale), 0.6)];
      this.pre = new Delay(Math.ceil(preDelaySeconds * sr) + 4); this.preR = new Delay(Math.ceil(preDelaySeconds * sr) + 4);
      this.preLen = Math.max(1, Math.round(preDelaySeconds * sr));
      this.lfo = 0; this.lfoInc = 0.31 / sr; this.modDepth = 9 * scale;
      this.hpL = new OnePole().set(90, sr); this.hpR = new OnePole().set(90, sr);
      this.v = new Float32Array(8);
      this.setDecay(seconds, dampHz);
    }
    setDecay(seconds, dampHz) {
      for (let i = 0; i < 8; i++) {
        this.gains[i] = Math.pow(10, (-3 * this.lengths[i]) / (seconds * this.sr));
        this.damp[i].set(dampHz, this.sr);
      }
    }
    clear() { for (const l of this.lines) l.clear(); for (const d of this.damp) d.reset(); this.pre.clear(); this.preR.clear(); }
    /** Reads `inL` (and `inR`, or null for mono) and ADDS the wet signal times `wet` to the outputs. */
    process(inL, inR, outL, outR, n, wet) {
      const lines = this.lines, len = this.lengths, g = this.gains, damp = this.damp, v = this.v;
      for (let i = 0; i < n; i++) {
        const xl = inL[i], xr = inR ? inR[i] : xl;
        this.pre.write(xl); this.preR.write(xr);
        const a = this.diffL[1].run(this.diffL[0].run(this.pre.tap(this.preLen)));
        const b = this.diffR[1].run(this.diffR[0].run(this.preR.tap(this.preLen)));
        this.lfo += this.lfoInc; if (this.lfo >= 1) this.lfo -= 1;
        const m = sin1(this.lfo) * this.modDepth;
        let sum = 0;
        for (let k = 0; k < 8; k++) {
          const raw = k === 2 ? lines[2].read(len[2] + m) : k === 5 ? lines[5].read(len[5] - m) : lines[k].tap(len[k]);
          v[k] = damp[k].lp(raw) * g[k]; sum += v[k];
        }
        sum *= 0.25;                                  // Householder: v - (2 / 8) * sum(v)
        for (let k = 0; k < 8; k++) lines[k].write(v[k] - sum + ((k & 1) ? b : a));
        outL[i] += this.hpL.hp(v[0] - v[2] + v[4] - v[6]) * wet;
        outR[i] += this.hpR.hp(v[1] - v[3] + v[5] - v[7]) * wet;
      }
    }
  }
  K.Reverb = Reverb;

  // ================================================================== dynamics
  /**
   * Stereo-linked feed-forward compressor with a soft knee. An optional key signal (the level
   * of something else) can be read with `gainFor` to duck one bus under another.
   */
  class Compressor {
    constructor(sr, thresholdDb, ratio, attackSeconds, releaseSeconds, kneeDb = 8, makeupDb = 0) {
      this.sr = sr; this.threshold = thresholdDb; this.slope = 1 - 1 / ratio; this.knee = kneeDb; this.makeup = K.dbToGain(makeupDb);
      this.att = coef(attackSeconds, sr); this.rel = coef(releaseSeconds, sr);
      this.env = 0; this.reduction = 0;          // reduction in dB (positive), readable for meters and tests
    }
    process(l, r, n) {
      const th = this.threshold, knee = this.knee, slope = this.slope, half = knee / 2;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(l[i]), b = Math.abs(r[i]), x = a > b ? a : b;
        this.env += (x - this.env) * (x > this.env ? this.att : this.rel);
        const over = 8.685889638 * Math.log(this.env + 1e-9) - th;        // dB above the threshold
        let cut = 0;
        if (over > half) cut = over * slope;
        else if (over > -half) { const t = over + half; cut = slope * t * t / (2 * knee); }
        this.reduction = cut;
        const g = Math.exp(-0.1151292546 * cut) * this.makeup;
        l[i] *= g; r[i] *= g;
      }
    }
  }
  K.Compressor = Compressor;

  /**
   * Look-ahead peak limiter. The signal is delayed a millisecond and a half; the gain needed for
   * each incoming peak is held as a running minimum over that window and smoothed, so the gain is
   * already down when the peak leaves the delay. A final clamp catches what the smoothing lets by.
   */
  class Limiter {
    constructor(sr, ceiling = 0.89, lookaheadSeconds = 0.0015, releaseSeconds = 0.09) {
      this.ceiling = ceiling; this.n = Math.max(8, Math.round(lookaheadSeconds * sr));
      this.dl = new Delay(this.n + 2); this.dr = new Delay(this.n + 2);
      // Monotonic queue of (gain, index) for the sliding minimum.
      this.cap = 1; while (this.cap < this.n + 2) this.cap <<= 1;
      this.qGain = new Float32Array(this.cap); this.qIndex = new Int32Array(this.cap); this.head = 0; this.tail = 0; this.index = 0;
      this.gain = 1; this.att = 1 - Math.exp(-5 / this.n); this.rel = coef(releaseSeconds, sr);
      this.minGain = 1;                          // lowest gain applied so far, for tests
    }
    process(l, r, n) {
      const c = this.ceiling, mask = this.cap - 1, win = this.n;
      for (let i = 0; i < n; i++) {
        const a = Math.abs(l[i]), b = Math.abs(r[i]), peak = a > b ? a : b;
        const need = peak > c ? c / peak : 1;
        while (this.head !== this.tail && this.qGain[(this.tail - 1) & mask] >= need) this.tail = (this.tail - 1) & mask;
        this.qGain[this.tail] = need; this.qIndex[this.tail] = this.index; this.tail = (this.tail + 1) & mask;
        if (((this.index - this.qIndex[this.head]) | 0) >= win) this.head = (this.head + 1) & mask;
        this.index = (this.index + 1) | 0;                 // wraps after hours; the difference above wraps with it
        const target = this.qGain[this.head];
        this.gain += (target - this.gain) * (target < this.gain ? this.att : this.rel);
        if (this.gain < this.minGain) this.minGain = this.gain;
        this.dl.write(l[i]); this.dr.write(r[i]);
        const yl = this.dl.tap(win) * this.gain, yr = this.dr.tap(win) * this.gain;
        l[i] = yl > c ? c : yl < -c ? -c : yl; r[i] = yr > c ? c : yr < -c ? -c : yr;
      }
    }
  }
  K.Limiter = Limiter;
}
