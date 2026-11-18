// Weather and events around the car: rain on the ground and on the body, thunder, collisions
// (thud, metal, glass, splash), scrapes, the horn, traffic pass-bys and the menu sounds.
// Packaging rules: see the header of kernel.js.

export function defineWorld(K) {
  const { P, IMPACT, Rng, Pink, Svf, OnePole, Wander, Ping, Burst, Ramp, Wavetable, sat, clamp, smoothstep, coef, sin1, pulse } = K;

  const MIX = {
    rainBed: 0.075, rainRoar: 0.10, rainDrop: 0.05, rainBody: 0.085,
    thunder: 0.36, thunderSend: 0.5,
    impact: 0.55, impactSend: 0.35, scrape: 0.40,
    horn: 0.11, hornSend: 0.4,
    traffic: 0.11, trafficNoise: 0.10, trafficSend: 0.25,
    ui: 0.14,
  };
  const SPEED_OF_SOUND = 343;

  // ================================================================== rain
  class Rain {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed);
      this.nL = new Rng(seed + 1); this.nR = new Rng(seed + 2); this.pink = new Pink(seed + 3);
      this.hpL = new Svf(); this.hpR = new Svf(); this.lpL = new OnePole(); this.lpR = new OnePole(); this.roar = new Svf();
      this.swell = new Wander(seed + 4, (sr / K.CHUNK) * 1.3, 0.8, 1.1);
      this.drops = []; for (let i = 0; i < 10; i++) this.drops.push({ ping: new Ping(), gl: 0, gr: 0 });
      this.taps = []; for (let i = 0; i < 6; i++) this.taps.push({ burst: new Burst(seed + 10 + i), gl: 0, gr: 0 });
      this.dropNext = 0; this.tapNext = 0;
      this.gBed = new Ramp(); this.gRoar = new Ramp();
    }
    render(ctl, outL, outR, n) {
      const sr = this.sr, rain = sat(ctl[P.RAIN]), cover = sat(ctl[P.COVER]), open = 1 - 0.75 * cover;
      const bedTarget = MIX.rainBed * Math.pow(rain, 0.8) * open * this.swell.tick();
      const roarTarget = MIX.rainRoar * rain * rain * open;
      let busy = false;
      for (const d of this.drops) if (d.ping.active) { busy = true; break; }
      if (!busy) for (const t of this.taps) if (t.burst.active) { busy = true; break; }
      if (this.gBed.silent(bedTarget) && !busy) return;

      // New drops: puddle plinks anywhere around, and taps on the bodywork (denser at speed).
      const seconds = n / sr, speed = Math.abs(ctl[P.SPEED]);
      if (this.rng.chance(70 * rain * open * seconds)) {
        const d = this.drops[this.dropNext]; this.dropNext = (this.dropNext + 1) % this.drops.length;
        const hz = this.rng.range(1400, 5200), pan = this.rng.range(-1, 1), amp = MIX.rainDrop * this.rng.range(0.25, 1);
        d.ping.start(hz, hz * 1.25, this.rng.range(0.008, 0.03), amp, sr);
        d.gl = K.panL(pan); d.gr = K.panR(pan);
      }
      if (this.rng.chance(34 * rain * (1 + speed / 25) * (1 - cover) * seconds)) {
        const t = this.taps[this.tapNext]; this.tapNext = (this.tapNext + 1) % this.taps.length;
        const pan = this.rng.range(-0.35, 0.35);
        t.burst.start(this.rng.range(1700, 4200), 2.2, this.rng.range(0.006, 0.02), MIX.rainBody * this.rng.range(0.3, 1), sr);
        t.gl = K.panL(pan); t.gr = K.panR(pan);
      }

      this.gBed.aim(bedTarget, n); this.gRoar.aim(roarTarget, n);
      this.hpL.set(1700, 0.6, sr); this.hpR.set(1900, 0.6, sr);
      const lp = 9500 - 5500 * cover; this.lpL.set(lp, sr); this.lpR.set(lp, sr);
      this.roar.set(650, 0.5, sr);
      for (let i = 0; i < n; i++) {
        const g = this.gBed.next(), roar = this.roar.bp(this.pink.next()) * this.gRoar.next();
        outL[i] += this.lpL.lp(this.hpL.hp(this.nL.white())) * g + roar;
        outR[i] += this.lpR.lp(this.hpR.hp(this.nR.white())) * g + roar;
      }
      for (const d of this.drops) if (d.ping.active) for (let i = 0; i < n; i++) { const y = d.ping.next(); outL[i] += y * d.gl; outR[i] += y * d.gr; }
      for (const t of this.taps) if (t.burst.active) for (let i = 0; i < n; i++) { const y = t.burst.next(); outL[i] += y * t.gl; outR[i] += y * t.gr; }
    }
  }
  K.Rain = Rain;

  // ================================================================== thunder
  /** One strike: waits for the sound to arrive, then a crack (if close) and a long lumpy rumble. */
  class ThunderVoice {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.noise = new Rng(seed + 1);
      this.lp1 = new OnePole(); this.lp2 = new OnePole(); this.hp = new OnePole().set(22, sr); this.crackF = new Svf();
      this.active = false; this.t = 0; this.wait = 0; this.length = 0;
      this.lumps = new Float32Array(8 * 4); this.lumpCount = 0;     // [start s, amp, rise s, fall s]
      this.gain = new Ramp(); this.crack = new Ramp(); this.pan = 0; this.level = 0; this.crackLevel = 0; this.crackEnd = 0;
    }
    start(distance) {
      const r = this.rng, d = Math.max(30, distance);
      this.wait = Math.min(14, d / SPEED_OF_SOUND); this.t = 0; this.active = true;
      this.level = MIX.thunder / (1 + d / 900);
      // Air swallows the top of the spectrum with distance.
      const cutoff = clamp(2600 * Math.exp(-d / 1400), 140, 2200);
      this.lp1.set(cutoff, this.sr); this.lp2.set(cutoff * 1.6, this.sr);
      this.crackLevel = this.level * 0.7 * smoothstep(1800, 300, d); this.crackEnd = 0.22 + 0.2 * r.float();
      this.crackF.set(2400, 0.5, this.sr);
      this.lumpCount = 5 + r.int(4);
      let at = 0;
      for (let i = 0; i < this.lumpCount; i++) {
        const o = i * 4;
        this.lumps[o] = at; this.lumps[o + 1] = (i === 0 ? 1 : r.range(0.25, 0.85)) * Math.exp(-at * 0.22);
        this.lumps[o + 2] = i === 0 ? 0.03 + d / 20000 : r.range(0.08, 0.35); this.lumps[o + 3] = r.range(0.7, 2.2);
        at += r.range(0.25, 1.1);
      }
      this.length = at + 4; this.pan = r.range(-0.6, 0.6);
    }
    _envelope(t) {
      let e = 0;
      for (let i = 0; i < this.lumpCount; i++) {
        const o = i * 4, dt = t - this.lumps[o];
        if (dt <= 0) continue;
        const rise = this.lumps[o + 2];
        e += this.lumps[o + 1] * (dt < rise ? dt / rise : Math.exp(-(dt - rise) / (this.lumps[o + 3] * 0.45)));
      }
      return e;
    }
    render(outL, outR, send, n) {
      const dt = n / this.sr; this.t += dt;
      const t = this.t - this.wait;
      if (t < 0) return;
      const target = this.level * this._envelope(t);
      if (t > this.length && this.gain.silent(target)) { this.active = false; return; }
      const crackTarget = t < this.crackEnd ? this.crackLevel * (0.4 + 0.6 * this.rng.float()) * (1 - t / this.crackEnd) : 0;
      this.gain.aim(target, n); this.crack.aim(crackTarget, n);
      const gl = K.panL(this.pan), gr = K.panR(this.pan);
      for (let i = 0; i < n; i++) {
        const w = this.noise.white();
        // Two cascaded low-passes on white noise give the brown rumble; the gain restores the level lost.
        const y = this.hp.hp(this.lp2.lp(this.lp1.lp(w))) * this.gain.next() * 7 + this.crackF.hp(w) * this.crack.next();
        outL[i] += y * gl; outR[i] += y * gr; send[i] += y * MIX.thunderSend;
      }
    }
  }
  class Thunder {
    constructor(sr, seed) { this.voices = [new ThunderVoice(sr, seed), new ThunderVoice(sr, seed + 7), new ThunderVoice(sr, seed + 13)]; this.next = 0; }
    strike(distance) {
      let v = null;
      for (const c of this.voices) if (!c.active) { v = c; break; }
      if (!v) { v = this.voices[this.next]; this.next = (this.next + 1) % this.voices.length; }
      v.start(distance);
    }
    render(outL, outR, send, n) { for (const v of this.voices) if (v.active) v.render(outL, outR, send, n); }
  }
  K.Thunder = Thunder;

  // ================================================================== impacts and scrapes
  const METAL_MODES = [287, 461, 733, 1187, 1873, 2920];
  class Impacts {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed);
      this.pings = []; for (let i = 0; i < 28; i++) this.pings.push({ ping: new Ping(), gl: 0, gr: 0 });
      this.bursts = []; for (let i = 0; i < 8; i++) this.bursts.push({ burst: new Burst(seed + 1 + i), gl: 0, gr: 0 });
      this.pingNext = 0; this.burstNext = 0;
      // Scrape: a continuous voice whose strength is refreshed by events and decays on its own.
      this.scrape = 0; this.scrapePan = 0; this.scrapeK = coef(0.12, sr / K.CHUNK);
      this.gScrape = new Ramp(); this.scrapeNoise = new Rng(seed + 20);
      this.scrapeF = [new Svf(), new Svf(), new Svf()]; this.scrapeLow = new OnePole().set(240, sr);
      this.grind = new Wander(seed + 21, 2, 0.25, 1); this.chatter = 0;
    }
    _ping(hz, hzEnd, seconds, amp, gl, gr, delay = 0) {
      const v = this.pings[this.pingNext]; this.pingNext = (this.pingNext + 1) % this.pings.length;
      v.ping.start(hz, hzEnd, seconds, amp, this.sr, delay * this.sr); v.gl = gl; v.gr = gr;
    }
    _burst(hz, q, seconds, amp, gl, gr, delay = 0, attack = 0) {
      const v = this.bursts[this.burstNext]; this.burstNext = (this.burstNext + 1) % this.bursts.length;
      v.burst.start(hz, q, seconds, amp, this.sr, delay * this.sr, attack); v.gl = gl; v.gr = gr;
    }
    /**
     * @param strength 0..1  @param pan -1..1  @param distance metres from the listener  @param kind K.IMPACT code
     */
    hit(strength, pan, distance, kind) {
      const s = sat(strength); if (s <= 0.005) return;
      if (kind === IMPACT.SCRAPE) { if (s > this.scrape) this.scrape = s; this.scrapePan = pan; return; }
      const r = this.rng, near = 1 / (1 + Math.max(0, distance) / 14);
      const a = MIX.impact * Math.pow(s, 0.8) * near, gl = K.panL(pan), gr = K.panR(pan);
      const long = 0.6 + 0.9 * s;
      if (kind === IMPACT.SPLASH) {
        this._burst(900, 0.5, 0.35 * long, a, gl, gr, 0, 0.02); this._burst(3600, 0.6, 0.55 * long, a * 0.6, gl, gr, 0.03, 0.04);
        this._ping(120, 60, 0.18, a * 0.7, gl, gr);
        return;
      }
      if (kind === IMPACT.GLASS) { this._glass(a, gl, gr); return; }
      // Body of every solid hit: a low thud and a dull crunch.
      this._ping(r.range(85, 105), 45, 0.22 * long, a * 1.2, gl, gr);
      this._burst(320, 0.8, 0.09 * long, a * 0.9, gl, gr);
      if (kind === IMPACT.METAL) {
        const tune = r.range(0.85, 1.2);
        for (let m = 0; m < METAL_MODES.length; m++) {
          const hz = METAL_MODES[m] * tune * r.range(0.97, 1.03);
          this._ping(hz, hz * 0.995, (0.34 - 0.04 * m) * long, a * 0.42 * s / (1 + m * 0.35), gl, gr);
        }
        this._burst(2100, 0.9, 0.07 * long, a * 0.8, gl, gr);
        // A hard hit between vehicles breaks a lamp or a window.
        if (s > 0.55) this._glass(a * (s - 0.3), gl, gr);
      }
    }
    _glass(a, gl, gr) {
      const r = this.rng;
      this._burst(6500, 0.7, 0.06, a * 0.9, gl, gr);
      for (let i = 0; i < 9; i++) {
        const hz = r.range(2800, 9000);
        this._ping(hz, hz, r.range(0.025, 0.09), a * r.range(0.08, 0.3), gl, gr, r.range(0.01, 0.55) * r.float());
      }
    }
    render(outL, outR, send, n) {
      for (const v of this.pings) if (v.ping.active) for (let i = 0; i < n; i++) { const y = v.ping.next(); outL[i] += y * v.gl; outR[i] += y * v.gr; send[i] += y * MIX.impactSend; }
      for (const v of this.bursts) if (v.burst.active) for (let i = 0; i < n; i++) { const y = v.burst.next(); outL[i] += y * v.gl; outR[i] += y * v.gr; send[i] += y * MIX.impactSend; }

      this.scrape -= this.scrape * this.scrapeK;
      const target = MIX.scrape * Math.pow(this.scrape, 0.7) * this.grind.tick();
      if (this.gScrape.silent(target)) return;
      this.gScrape.aim(target, n);
      const sr = this.sr, shift = 0.8 + 0.5 * this.scrape;
      this.scrapeF[0].set(940 * shift, 5, sr); this.scrapeF[1].set(2350 * shift, 6, sr); this.scrapeF[2].set(4100 * shift, 5, sr);
      const gl = K.panL(this.scrapePan), gr = K.panR(this.scrapePan);
      for (let i = 0; i < n; i++) {
        const w = this.scrapeNoise.white();
        this.chatter += 37 / sr; if (this.chatter >= 1) this.chatter -= 1;
        const y = (this.scrapeF[0].bp(w) + this.scrapeF[1].bp(w) * 0.8 + this.scrapeF[2].bp(w) * 0.5 + this.scrapeLow.lp(w) * 1.5)
          * (0.6 + 0.4 * this.chatter) * this.gScrape.next();
        outL[i] += y * gl; outR[i] += y * gr; send[i] += y * MIX.impactSend * 0.5;
      }
    }
  }
  K.Impacts = Impacts;

  // ================================================================== horn
  /** Twin-tone horn: two reedy notes a major third apart through one flared trumpet resonance. */
  const HORN_WIDTH_A = 0.28, HORN_WIDTH_B = 0.31;
  // A pulse of width w has a mean of 2w - 1. Left in, the horn would shift the whole mix off centre.
  const HORN_DC = (2 * HORN_WIDTH_A - 1) + (2 * HORN_WIDTH_B - 1);
  class Horn {
    constructor(sr) {
      this.sr = sr; this.on = false; this.gain = 0; this.phA = 0; this.phB = 0;
      this.up = coef(0.008, sr); this.down = coef(0.035, sr);
      this.bell = new Svf().set(1900, 1.4, sr); this.lp = new Svf().set(3800, 0.7, sr);
    }
    set(on) { this.on = !!on; }
    render(outL, outR, send, n) {
      if (!this.on && this.gain < 1e-4) { this.gain = 0; return; }
      const sr = this.sr, incA = 415 / sr, incB = 523 / sr, target = this.on ? MIX.horn : 0, k = this.on ? this.up : this.down;
      for (let i = 0; i < n; i++) {
        this.gain += (target - this.gain) * k;
        this.phA += incA; if (this.phA >= 1) this.phA -= 1;
        this.phB += incB; if (this.phB >= 1) this.phB -= 1;
        const x = pulse(this.phA, incA, HORN_WIDTH_A) + pulse(this.phB, incB, HORN_WIDTH_B) - HORN_DC;
        const y = this.lp.lp(x * 0.5 + this.bell.bp(x) * 1.4) * this.gain;
        outL[i] += y; outR[i] += y; send[i] += y * MIX.hornSend;
      }
    }
  }
  K.Horn = Horn;

  // ================================================================== traffic pass-bys
  // Per kind: [engine cycle Hz at idle (two crank turns), tone level, low-pass base Hz, road-noise level]
  const TRAFFIC_KINDS = [
    /* car         */ [7.5, 1.00, 900, 1.0],
    /* sports      */ [8.0, 1.25, 1500, 1.0],
    /* light truck */ [6.0, 1.20, 700, 1.25],
    /* heavy       */ [5.0, 1.50, 520, 1.7],
  ];
  /** Engine waves for other vehicles: four, six (sports) and eight cylinders, and a diesel. */
  function trafficWave(firingHarmonic, slope, seed) {
    return new Wavetable(128, 3, (h) => {
      const k = h / firingHarmonic;
      if (h % firingHarmonic === 0) return Math.pow(k, -slope);
      return 0.22 * K.hash(h, seed, 1) * Math.pow(Math.max(0.5, k), -slope);
    }, (h) => K.hash(h, seed, 2));
  }

  class TrafficVoice {
    constructor(sr, seed, waves) {
      this.sr = sr; this.waves = waves; this.pink = new Pink(seed);
      this.phase = 0; this.kind = 0; this.serial = -1;
      this.lp = new Svf(); this.noiseF = new Svf(); this.low = new OnePole();
      this.gain = new Ramp(); this.gNoise = new Ramp(); this.pan = new Ramp(); this.hz = 40;
      this.kHz = coef(0.06, sr / K.CHUNK);
    }
    render(ctl, o, outL, outR, send, n) {
      const sr = this.sr;
      let level = sat(ctl[o]);
      const serial = ctl[o + 7];
      // A different vehicle has taken this slot: let the old one fade to nothing before switching.
      if (serial !== this.serial) {
        if (this.gain.v > 1e-4) level = 0;
        else { this.serial = serial; this.kind = clamp(Math.round(ctl[o + 4]), 0, 3); this.hz = 0; this.pan.v = ctl[o + 1]; }
      }
      if (this.gain.silent(level)) { this.gain.v = 0; this.gNoise.v = 0; return; }
      const k = TRAFFIC_KINDS[this.kind], doppler = clamp(ctl[o + 2], 0.6, 1.6), speed = Math.abs(ctl[o + 3]);
      const throttle = sat(ctl[o + 5]), distance = ctl[o + 6];
      // Engine speed follows road speed through an imaginary gearbox: it climbs within each gear.
      const gearPos = (speed / 11) % 1, revs = 0.55 + 0.45 * gearPos + 0.25 * throttle;
      const hzTarget = k[0] * (1.5 + 2.6 * revs * sat(speed / 4)) * doppler;
      this.hz = this.hz > 0 ? this.hz + (hzTarget - this.hz) * this.kHz : hzTarget;
      const wave = this.waves[this.kind], inc = this.hz / sr, lod = wave.levelFor(this.hz, 5000);
      const air = 1 / (1 + distance / 60);                   // distance dulls the tone
      this.lp.set((k[2] + 1400 * throttle) * (0.35 + 0.65 * air) * doppler, 0.75, sr);
      this.noiseF.set((260 + 22 * speed) * doppler, 0.55, sr);
      this.low.set(140 * doppler, sr);
      this.gain.aim(MIX.traffic * level * k[1] * (0.55 + 0.45 * throttle), n);
      this.gNoise.aim(MIX.trafficNoise * level * k[3] * sat(speed / 28), n);
      this.pan.aim(clamp(ctl[o + 1], -1, 1), n);
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        const p = this.pink.next();
        const y = this.lp.lp(wave.read(this.phase, lod)) * this.gain.next()
          + (this.noiseF.bp(p) + this.low.lp(p) * 0.8) * this.gNoise.next();
        const pan = this.pan.next();
        outL[i] += y * (0.5 - 0.5 * pan) * 1.41; outR[i] += y * (0.5 + 0.5 * pan) * 1.41;
        send[i] += y * MIX.trafficSend;
      }
    }
  }
  class Traffic {
    constructor(sr, seed) {
      const waves = [trafficWave(4, 1.3, seed), trafficWave(6, 1.1, seed + 1), trafficWave(8, 1.25, seed + 2), trafficWave(6, 0.9, seed + 3)];
      this.voices = []; for (let i = 0; i < P.TRAFFIC_VOICES; i++) this.voices.push(new TrafficVoice(sr, seed + 10 + i, waves));
    }
    render(ctl, outL, outR, send, n) {
      for (let v = 0; v < this.voices.length; v++) this.voices[v].render(ctl, P.TRAFFIC + v * P.TRAFFIC_STRIDE, outL, outR, send, n);
    }
  }
  K.Traffic = Traffic;

  // ================================================================== menu sounds
  // Each sound is a few notes: [delay s, MIDI note, decay s, level, modulator ratio, modulation index]
  const UI_SOUNDS = [
    /* select */ [[0, 84, 0.10, 0.8, 2, 0.6], [0.055, 91, 0.16, 0.9, 2, 0.6]],
    /* back   */ [[0, 79, 0.10, 0.8, 2, 0.5], [0.055, 72, 0.16, 0.8, 2, 0.5]],
    /* toggle */ [[0, 88, 0.07, 0.7, 3, 0.8]],
    /* start  */ [[0, 72, 0.22, 0.7, 2, 0.9], [0.07, 76, 0.22, 0.7, 2, 0.9], [0.14, 79, 0.24, 0.8, 2, 0.9], [0.21, 84, 0.6, 1.0, 2, 1.1], [0.21, 91, 0.6, 0.5, 1, 0.5]],
    /* move   */ [[0, 93, 0.035, 0.45, 1, 0.3]],
    /* error  */ [[0, 51, 0.14, 0.9, 1.41, 2.2], [0.13, 50, 0.2, 0.9, 1.41, 2.2]],
    /* pause  */ [[0, 76, 0.14, 0.7, 2, 0.5], [0.08, 69, 0.26, 0.8, 2, 0.5]],
    /* resume */ [[0, 69, 0.14, 0.7, 2, 0.5], [0.08, 76, 0.26, 0.8, 2, 0.5]],
    /* toast  */ [[0, 81, 0.2, 0.5, 3.5, 0.7], [0.09, 88, 0.4, 0.55, 3.5, 0.7]],
    /* car    */ [[0, 74, 0.09, 0.75, 3, 0.7], [0.05, 81, 0.24, 0.85, 3, 0.7]],
    /* colour */ [[0, 86, 0.04, 0.4, 2, 0.4], [0.03, 90, 0.07, 0.5, 2, 0.4]],
  ];
  /** Small two-operator FM bell notes for the interface. */
  class Ui {
    constructor(sr) {
      this.sr = sr; this.next = 0; this.voices = [];
      for (let i = 0; i < 8; i++) this.voices.push({ env: 0, decay: 0, delay: 0, attack: 0, phase: 0, mod: 0, inc: 0, modInc: 0, index: 0, level: 0 });
    }
    play(kind) {
      const notes = UI_SOUNDS[clamp(kind | 0, 0, UI_SOUNDS.length - 1)], sr = this.sr;
      for (const note of notes) {
        const v = this.voices[this.next]; this.next = (this.next + 1) % this.voices.length;
        const hz = K.midiToHz(note[1]);
        v.delay = (note[0] * sr) | 0; v.env = 1; v.decay = Math.exp(-6.9 / (note[2] * sr)); v.attack = 0;
        v.phase = 0; v.mod = 0; v.inc = hz / sr; v.modInc = (hz * note[4]) / sr; v.index = note[5] / K.TAU; v.level = note[3] * MIX.ui;
      }
    }
    render(outL, outR, n) {
      const rise = 1 / (0.002 * this.sr);
      for (const v of this.voices) {
        if (v.env < 1e-4) continue;
        for (let i = 0; i < n; i++) {
          if (v.delay > 0) { v.delay--; continue; }
          if (v.attack < 1) v.attack = Math.min(1, v.attack + rise);
          v.phase += v.inc; if (v.phase >= 1) v.phase -= 1;
          v.mod += v.modInc; if (v.mod >= 1) v.mod -= 1;
          const y = sin1(v.phase + v.index * v.env * sin1(v.mod)) * v.env * v.attack * v.level;
          v.env *= v.decay;
          outL[i] += y; outR[i] += y;
        }
      }
    }
  }
  K.Ui = Ui;
}
