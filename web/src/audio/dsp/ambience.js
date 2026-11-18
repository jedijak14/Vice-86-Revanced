// The city's own sound, by district and hour: surf and gulls, insects and frogs, the wash of
// distant traffic, neon hum, the harbour, aircraft, wind in the palms.
//
// Each layer is a small generator with a level in 0..1 computed from the district profile
// (tables.js), the hour, the weather and the distance to the shore. A layer whose level is zero
// costs nothing. The car's own speed masks the quiet layers, as it does in life.
// Packaging rules: see the header of kernel.js.

export function defineAmbience(K) {
  const { P, PROFILE, Rng, Pink, Svf, OnePole, Wander, Ping, Ramp, sat, clamp, smoothstep, coef, sin1, saw, pulse } = K;

  const MIX = {
    surfLow: 0.12, surfWash: 0.06, seaBed: 0.015,
    gull: 0.12, cricket: 0.04, trill: 0.014, cicada: 0.02, peeper: 0.04, croaker: 0.055,
    wash: 0.06, farHorn: 0.022, siren: 0.016,
    neon: 0.012, neonBuzz: 0.008,
    lap: 0.05, bell: 0.04, shipHorn: 0.05, clink: 0.02, dockHum: 0.010,
    jet: 0.10, jetWhine: 0.008,
    leaves: 0.05,
    send: 0.5,
  };

  // ================================================================== surf
  /** One line of breakers: swell, break, and the hiss of the water running back. */
  class Breaker {
    constructor(sr, seed, pan) {
      this.sr = sr; this.rng = new Rng(seed); this.pink = new Pink(seed + 1); this.white = new Rng(seed + 2);
      this.low = new Svf(); this.wash = new Svf(); this.t = this.rng.float(); this.period = this.rng.range(7, 12); this.size = 1;
      this.gLow = new Ramp(); this.gWash = new Ramp(); this.gl = K.panL(pan); this.gr = K.panR(pan);
    }
    render(level, outL, outR, send, n) {
      this.t += n / this.sr / this.period;
      if (this.t >= 1) { this.t -= 1; this.period = this.rng.range(7, 12); this.size = this.rng.range(0.55, 1); }
      const t = this.t;
      // Swell builds over the first half, the break is a fast rise at 0.48, the wash decays after it.
      const swell = Math.pow(sat(t / 0.5), 2) * (1 - smoothstep(0.5, 0.75, t));
      const wash = smoothstep(0.44, 0.52, t) * Math.pow(1 - sat((t - 0.5) / 0.5), 1.6);
      this.gLow.aim(MIX.surfLow * level * this.size * (0.12 + swell), n);
      this.gWash.aim(MIX.surfWash * level * this.size * wash, n);
      this.low.set(240 + 500 * swell, 0.6, this.sr);
      this.wash.set(1500 + 3500 * sat((t - 0.48) / 0.5), 0.5, this.sr);
      for (let i = 0; i < n; i++) {
        const y = this.low.lp(this.pink.next()) * this.gLow.next() + this.wash.bp(this.white.white()) * this.gWash.next();
        outL[i] += y * this.gl; outR[i] += y * this.gr; send[i] += y * 0.15;
      }
    }
  }

  // ================================================================== gulls
  /** A gull's call: a few long keening notes, then a run of short ones. */
  class Gull {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.bp = new Svf(); this.phase = 0;
      this.wait = this.rng.range(1, 8); this.notes = 0; this.total = 0; this.noteT = 0; this.noteLen = 0; this.gap = 0; this.pitch = 1000;
      this.gain = new Ramp(); this.pan = 0; this.far = 1;
    }
    render(level, outL, outR, send, n) {
      const sr = this.sr, dt = n / sr;
      if (this.notes <= 0) {
        if (this.gain.silent(0)) {
          this.wait -= dt * (0.3 + level);
          if (this.wait > 0) return;
          const r = this.rng;
          this.wait = r.range(4, 16); this.notes = 3 + r.int(7); this.total = this.notes;
          this.pitch = r.range(820, 1150); this.pan = r.range(-0.9, 0.9); this.far = r.range(0.25, 1);
          this.noteT = 0; this.noteLen = r.range(0.45, 0.7); this.gap = 0;
        }
      }
      let env = 0, bend = 0;
      if (this.notes > 0) {
        if (this.gap > 0) this.gap -= dt;
        else {
          this.noteT += dt;
          const u = this.noteT / this.noteLen;
          if (u >= 1) {
            this.notes--; this.noteT = 0;
            // After the first two long notes the call quickens.
            const fast = this.total - this.notes >= 2;
            this.noteLen = fast ? this.rng.range(0.13, 0.2) : this.rng.range(0.4, 0.65); this.gap = fast ? 0.06 : 0.14;
          } else { env = Math.sin(Math.PI * u); env *= env; bend = Math.sin(Math.PI * Math.pow(u, 0.6)); }
        }
      }
      const target = MIX.gull * level * this.far * env;
      if (this.gain.silent(target)) return;
      this.gain.aim(target, n);
      const hz = this.pitch * (1 + 0.55 * bend), inc = hz / sr;
      this.bp.set(hz * 2.4, 2.2, sr);
      const gl = K.panL(this.pan), gr = K.panR(this.pan), wet = MIX.send * (1.3 - this.far);
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        const x = saw(this.phase, inc), y = (this.bp.bp(x) + x * 0.25) * this.gain.next();
        outL[i] += y * gl; outR[i] += y * gr; send[i] += y * wet;
      }
    }
  }

  // ================================================================== insects
  /** A field cricket: bursts of three or four pulses of a pure high tone. */
  class Cricket {
    constructor(sr, seed) {
      const r = new Rng(seed);
      this.sr = sr; this.inc = r.range(4100, 5200) / sr; this.chirpRate = r.range(1.7, 2.7); this.pulseRate = r.range(52, 70);
      this.pulses = 3 + r.int(2); this.pan = r.range(-1, 1); this.level = r.range(0.4, 1);
      this.phase = 0; this.chirp = r.float(); this.rest = new Wander(seed + 1, (sr / K.CHUNK) * 3, -0.6, 1);
      this.gl = K.panL(this.pan); this.gr = K.panR(this.pan);
    }
    render(level, outL, outR, n) {
      const sr = this.sr, chirpInc = this.chirpRate / sr, span = this.pulses / this.pulseRate * this.chirpRate;
      // Crickets fall silent now and then: the wander value gates whole stretches.
      const g = MIX.cricket * level * this.level * sat(this.rest.tick() * 4);
      if (g <= 1e-6) { this.chirp += chirpInc * n; this.chirp -= Math.floor(this.chirp); return; }
      for (let i = 0; i < n; i++) {
        this.chirp += chirpInc; if (this.chirp >= 1) this.chirp -= 1;
        if (this.chirp > span) continue;
        this.phase += this.inc; if (this.phase >= 1) this.phase -= 1;
        const p = sin1(this.chirp / span * this.pulses * 0.5);       // half a sine per pulse
        const y = sin1(this.phase) * p * p * g;
        outL[i] += y * this.gl; outR[i] += y * this.gr;
      }
    }
  }
  /** Night trill of tree crickets and the day drone of cicadas: amplitude-modulated narrow noise. */
  class Drone {
    constructor(sr, seed, hz, amRate, swellSeconds) {
      this.sr = sr; this.noise = new Rng(seed); this.bp = new Svf().set(hz, 9, sr); this.am = 0; this.amInc = amRate / sr;
      this.swell = new Wander(seed + 1, (sr / K.CHUNK) * swellSeconds, 0, 1); this.gain = new Ramp();
    }
    render(level, outL, outR, n) {
      const target = level * smoothstep(0.25, 0.8, this.swell.tick());
      if (this.gain.silent(target)) return;
      this.gain.aim(target, n);
      for (let i = 0; i < n; i++) {
        this.am += this.amInc; if (this.am >= 1) this.am -= 1;
        const y = this.bp.bp(this.noise.white()) * (0.55 + 0.45 * sin1(this.am)) * this.gain.next() * 3;
        outL[i] += y; outR[i] += y * 0.8;
      }
    }
  }

  // ================================================================== frogs
  /** Peepers (short rising whistles) and croakers (low pulsed honks), calling in bouts. */
  class Frog {
    constructor(sr, seed, croaker) {
      const r = new Rng(seed);
      this.sr = sr; this.rng = r; this.croaker = croaker;
      this.hz = croaker ? r.range(380, 560) : r.range(2300, 3100);
      this.len = croaker ? r.range(0.16, 0.3) : r.range(0.06, 0.11);
      this.every = croaker ? r.range(0.5, 0.9) : r.range(0.28, 0.6);
      this.pan = r.range(-1, 1); this.gl = K.panL(this.pan); this.gr = K.panR(this.pan); this.level = r.range(0.35, 1);
      this.calls = 0; this.wait = r.range(0, 9); this.t = 1; this.phase = 0; this.buzz = 0;
      this.bp = new Svf(); this.gain = new Ramp();
    }
    render(level, outL, outR, send, n) {
      const sr = this.sr, dt = n / sr;
      this.wait -= dt;
      if (this.wait <= 0) {
        if (this.calls <= 0) { this.calls = 4 + this.rng.int(14); }
        this.calls--; this.t = 0;
        this.wait = this.calls > 0 ? this.every * this.rng.range(0.9, 1.15) : this.rng.range(3, 11) / (0.4 + level);
      }
      let env = 0;
      if (this.t < 1) { this.t += dt / this.len; env = Math.sin(Math.PI * sat(this.t)); }
      const target = (this.croaker ? MIX.croaker : MIX.peeper) * level * this.level * env;
      if (this.gain.silent(target)) return;
      this.gain.aim(target, n);
      const u = sat(this.t), hz = this.croaker ? this.hz * (1 - 0.08 * u) : this.hz * (0.88 + 0.2 * u), inc = hz / sr;
      if (this.croaker) this.bp.set(hz * 2.1, 1.6, sr);
      const buzzInc = 85 / sr;
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        let y;
        if (this.croaker) {
          this.buzz += buzzInc; if (this.buzz >= 1) this.buzz -= 1;
          const x = pulse(this.phase, inc, 0.3);
          y = (this.bp.bp(x) + 0.3 * x) * (0.25 + 0.75 * sin1(this.buzz * 0.5));
        } else y = sin1(this.phase);
        y *= this.gain.next();
        outL[i] += y * this.gl; outR[i] += y * this.gr; send[i] += y * 0.2;
      }
    }
  }

  // ================================================================== distant city
  /** The low wash of a city's traffic, with a far horn now and then and a rare night siren. */
  class CityWash {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.pinkL = new Pink(seed + 1); this.pinkR = new Pink(seed + 2);
      this.lpL = new Svf().set(420, 0.6, sr); this.lpR = new Svf().set(470, 0.6, sr); this.hpL = new OnePole().set(55, sr); this.hpR = new OnePole().set(55, sr);
      const rate = sr / K.CHUNK;
      this.swellL = new Wander(seed + 3, rate * 2.2, 0.6, 1.1); this.swellR = new Wander(seed + 4, rate * 2.7, 0.6, 1.1);
      this.gL = new Ramp(); this.gR = new Ramp();
      this.hornWait = this.rng.range(6, 25); this.hornT = 1; this.hornLen = 0.4; this.hornHz = 400; this.hornPan = 0;
      this.hornA = 0; this.hornB = 0; this.hornLp = new Svf(); this.gHorn = new Ramp();
      this.sirenWait = this.rng.range(50, 160); this.sirenT = 1; this.sirenLen = 12; this.sirenPhase = 0; this.sirenPan = 0;
      this.sirenLp = new Svf().set(1500, 0.8, sr); this.gSiren = new Ramp();
    }
    render(level, night, outL, outR, send, n) {
      const sr = this.sr, dt = n / sr;
      const wash = MIX.wash * level;
      // --- far horn
      this.hornWait -= dt * level;
      if (this.hornWait <= 0) {
        const r = this.rng;
        this.hornWait = r.range(9, 40); this.hornT = 0; this.hornLen = r.range(0.2, 0.9); this.hornHz = r.range(330, 470); this.hornPan = r.range(-0.8, 0.8);
        this.hornLp.set(r.range(700, 1300), 0.8, sr);
      }
      let hornEnv = 0;
      if (this.hornT < 1) { this.hornT += dt / this.hornLen; hornEnv = smoothstep(0, 0.08, this.hornT) * (1 - smoothstep(0.8, 1, this.hornT)); }
      const hornTarget = MIX.farHorn * level * hornEnv;
      // --- siren: only at night, only where the city is dense
      this.sirenWait -= dt * level * night;
      if (this.sirenWait <= 0) { this.sirenWait = this.rng.range(90, 240); this.sirenT = 0; this.sirenLen = this.rng.range(9, 16); this.sirenPan = this.rng.range(-0.7, 0.7); }
      let sirenEnv = 0;
      if (this.sirenT < 1) { this.sirenT += dt / this.sirenLen; sirenEnv = Math.sin(Math.PI * sat(this.sirenT)); }
      const sirenTarget = MIX.siren * level * sirenEnv;

      const washing = !this.gL.silent(wash), honking = !this.gHorn.silent(hornTarget), wailing = !this.gSiren.silent(sirenTarget);
      if (!washing && !honking && !wailing) return;
      this.gL.aim(wash * this.swellL.tick(), n); this.gR.aim(wash * this.swellR.tick(), n);
      this.gHorn.aim(hornTarget, n); this.gSiren.aim(sirenTarget, n);
      const incA = this.hornHz / sr, incB = this.hornHz * 1.26 / sr;
      // The wail sweeps between 650 and 1250 Hz every four seconds; the pan drifts as it travels.
      const sweep = 0.5 - 0.5 * Math.cos(K.TAU * this.sirenT * this.sirenLen / 4), sirenInc = (650 + 600 * sweep) / sr;
      const sPan = clamp(this.sirenPan + (this.sirenT - 0.5) * 0.8, -1, 1);
      const hl = K.panL(this.hornPan), hr = K.panR(this.hornPan), sl = K.panL(sPan), sr2 = K.panR(sPan);
      for (let i = 0; i < n; i++) {
        let l = this.hpL.hp(this.lpL.lp(this.pinkL.next())) * this.gL.next() * 3;
        let r = this.hpR.hp(this.lpR.lp(this.pinkR.next())) * this.gR.next() * 3;
        if (honking) {
          this.hornA += incA; if (this.hornA >= 1) this.hornA -= 1;
          this.hornB += incB; if (this.hornB >= 1) this.hornB -= 1;
          const h = this.hornLp.lp(saw(this.hornA, incA) + saw(this.hornB, incB)) * this.gHorn.next();
          l += h * hl; r += h * hr; send[i] += h * MIX.send;
        }
        if (wailing) {
          this.sirenPhase += sirenInc; if (this.sirenPhase >= 1) this.sirenPhase -= 1;
          const s = this.sirenLp.lp(pulse(this.sirenPhase, sirenInc, 0.4)) * this.gSiren.next();
          l += s * sl; r += s * sr2; send[i] += s * MIX.send;
        }
        outL[i] += l; outR[i] += r;
      }
    }
  }

  // ================================================================== neon
  /** Transformer hum (mains harmonics) and the fizz of the tubes, with the odd flicker. */
  class Neon {
    constructor(sr, seed) {
      this.sr = sr; this.noise = new Rng(seed); this.phase = 0; this.hp = new Svf().set(3600, 0.8, sr);
      this.flicker = new Wander(seed + 1, 5, 0, 1); this.gain = new Ramp();
    }
    render(level, outL, outR, n) {
      // A tube that is about to fail drops out for a few tens of milliseconds.
      const dip = this.flicker.tick() < 0.06 ? 0.35 : 1;
      const target = level * dip;
      if (this.gain.silent(target)) return;
      this.gain.aim(target, n);
      const inc = 60 / this.sr;
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        const p = this.phase, g = this.gain.next();
        const hum = sin1(2 * p) + 0.35 * sin1(3 * p + 0.2) + 0.5 * sin1(4 * p + 0.4) + 0.25 * sin1(6 * p + 0.1) + 0.12 * sin1(8 * p);
        const arc = sin1(p); const fizz = this.hp.hp(this.noise.white()) * arc * arc * arc * arc;
        const y = (hum * MIX.neon + fizz * MIX.neonBuzz) * g;
        outL[i] += y; outR[i] += y;
      }
    }
  }

  // ================================================================== harbour
  const BELL_PARTIALS = [1, 2.76, 5.40, 8.93];
  class Harbour {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.pink = new Pink(seed + 1);
      const rate = sr / K.CHUNK;
      this.lap = new Svf().set(430, 0.8, sr); this.slosh = new Wander(seed + 2, rate * 0.45, 0, 1); this.gLap = new Ramp();
      this.pings = []; for (let i = 0; i < 10; i++) this.pings.push({ ping: new Ping(), gl: 0, gr: 0 });
      this.pingNext = 0;
      this.bellWait = this.rng.range(2, 8); this.clinkWait = 1;
      this.hornWait = this.rng.range(20, 70); this.hornT = 1; this.hornA = 0; this.hornB = 0; this.hornLp = new Svf().set(380, 0.7, sr); this.gHorn = new Ramp();
      this.humPhase = 0; this.gHum = new Ramp();
    }
    _ping(hz, seconds, amp, pan, delay = 0) {
      const v = this.pings[this.pingNext]; this.pingNext = (this.pingNext + 1) % this.pings.length;
      v.ping.start(hz, hz, seconds, amp, this.sr, delay * this.sr); v.gl = K.panL(pan); v.gr = K.panR(pan);
    }
    render(level, wind, outL, outR, send, n) {
      const sr = this.sr, dt = n / sr, r = this.rng;
      if (level > 0.01) {
        // Channel buoy bell: the swell rings it at irregular intervals, sometimes twice.
        this.bellWait -= dt;
        if (this.bellWait <= 0) {
          this.bellWait = r.range(3.5, 11);
          const pan = r.range(-0.7, 0.7), a = MIX.bell * level * r.range(0.4, 1), twice = r.chance(0.4) ? 1 : 0;
          for (let k = 0; k <= twice; k++) for (let m = 0; m < BELL_PARTIALS.length; m++) {
            this._ping(540 * BELL_PARTIALS[m], 2.4 / (1 + m * 0.8), a / (1 + m * 0.7), pan, k * 0.42);
          }
        }
        // Halyards slapping masts: more often in wind.
        this.clinkWait -= dt * (0.3 + 3 * wind);
        if (this.clinkWait <= 0) { this.clinkWait = r.range(0.15, 1.6); this._ping(r.range(2400, 4200), r.range(0.03, 0.09), MIX.clink * level * r.range(0.3, 1), r.range(-1, 1)); }
        this.hornWait -= dt;
        if (this.hornWait <= 0) { this.hornWait = r.range(70, 180); this.hornT = 0; }
      }
      let hornEnv = 0;
      if (this.hornT < 1) { this.hornT += dt / 3.2; hornEnv = smoothstep(0, 0.12, this.hornT) * (1 - smoothstep(0.85, 1, this.hornT)); }
      const lapTarget = MIX.lap * level * (0.3 + 0.7 * this.slosh.tick()), hornTarget = MIX.shipHorn * level * hornEnv, humTarget = MIX.dockHum * level;
      for (const v of this.pings) if (v.ping.active) for (let i = 0; i < n; i++) { const y = v.ping.next(); outL[i] += y * v.gl; outR[i] += y * v.gr; send[i] += y * MIX.send; }
      const lapping = !this.gLap.silent(lapTarget), sounding = !this.gHorn.silent(hornTarget);
      if (!lapping && !sounding) return;
      this.gLap.aim(lapTarget, n); this.gHorn.aim(hornTarget, n); this.gHum.aim(humTarget, n);
      const incA = 98 / sr, incB = 147.5 / sr, humInc = 50 / sr;
      for (let i = 0; i < n; i++) {
        this.humPhase += humInc; if (this.humPhase >= 1) this.humPhase -= 1;
        let y = this.lap.bp(this.pink.next()) * this.gLap.next() * 2 + (sin1(this.humPhase * 2) + 0.4 * sin1(this.humPhase * 4)) * this.gHum.next();
        if (sounding) {
          this.hornA += incA; if (this.hornA >= 1) this.hornA -= 1;
          this.hornB += incB; if (this.hornB >= 1) this.hornB -= 1;
          const h = this.hornLp.lp(saw(this.hornA, incA) + 0.8 * saw(this.hornB, incB)) * this.gHorn.next();
          y += h; send[i] += h * MIX.send * 1.5;
        }
        outL[i] += y; outR[i] += y;
      }
    }
  }

  // ================================================================== aircraft
  /** A jet passing over: a long swell of roar with a falling turbine whine, crossing the stereo field. */
  class Aircraft {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.pink = new Pink(seed + 1);
      this.lp = new Svf(); this.rumble = new OnePole().set(110, sr); this.whine = 0;
      this.wait = this.rng.range(8, 40); this.t = 1; this.len = 18; this.dir = 1; this.size = 1;
      this.gain = new Ramp(); this.gWhine = new Ramp(); this.pan = new Ramp();
    }
    render(level, outL, outR, send, n) {
      const sr = this.sr, dt = n / sr;
      this.wait -= dt * sat(level * 1.5);
      if (this.wait <= 0 && this.t >= 1) {
        this.wait = this.rng.range(45, 110); this.t = 0; this.len = this.rng.range(14, 24); this.dir = this.rng.chance(0.5) ? 1 : -1; this.size = this.rng.range(0.5, 1);
      }
      let env = 0;
      if (this.t < 1) { this.t += dt / this.len; env = Math.sin(Math.PI * sat(this.t)); env = env * env * env; }
      const target = MIX.jet * level * this.size * env;
      if (this.gain.silent(target)) return;
      const u = sat(this.t);
      this.gain.aim(target, n); this.gWhine.aim(MIX.jetWhine * level * this.size * env * env, n); this.pan.aim(this.dir * (u * 1.6 - 0.8), n);
      this.lp.set(500 + 1700 * env, 0.6, sr);
      // Doppler: the whine falls as the aircraft passes overhead.
      const whineInc = 2700 * (1.12 - 0.26 * smoothstep(0.35, 0.65, u)) / sr;
      for (let i = 0; i < n; i++) {
        const p = this.pink.next();
        this.whine += whineInc; if (this.whine >= 1) this.whine -= 1;
        const y = (this.lp.lp(p) + this.rumble.lp(p) * 2) * this.gain.next() + sin1(this.whine) * this.gWhine.next();
        const pan = this.pan.next();
        outL[i] += y * (0.5 - 0.5 * pan) * 1.41; outR[i] += y * (0.5 + 0.5 * pan) * 1.41; send[i] += y * 0.3;
      }
    }
  }

  // ================================================================== the whole bed
  class Ambience {
    constructor(sr, seed) {
      this.sr = sr;
      const rate = sr / K.CHUNK;
      this.profile = new Float32Array(PROFILE.COUNT); this.profile.set(K.DISTRICT_PROFILES[0]);
      this.profileK = coef(2.5, rate);
      this.breakers = [new Breaker(sr, seed + 1, -0.55), new Breaker(sr, seed + 2, 0.55)];
      this.seaPink = new Pink(seed + 3); this.seaLp = new OnePole().set(260, sr); this.gSea = new Ramp();
      this.gulls = [new Gull(sr, seed + 10), new Gull(sr, seed + 11)];
      this.crickets = []; for (let i = 0; i < 5; i++) this.crickets.push(new Cricket(sr, seed + 20 + i * 3));
      this.trill = new Drone(sr, seed + 40, 6200, 38, 5); this.cicada = new Drone(sr, seed + 42, 5100, 110, 7);
      this.frogs = []; for (let i = 0; i < 5; i++) this.frogs.push(new Frog(sr, seed + 50 + i * 3, i >= 3));
      this.city = new CityWash(sr, seed + 70); this.neon = new Neon(sr, seed + 80);
      this.harbour = new Harbour(sr, seed + 90); this.aircraft = new Aircraft(sr, seed + 100);
      this.leafPink = new Pink(seed + 110); this.leafF = new Svf().set(3100, 0.5, sr); this.gust = new Wander(seed + 111, rate * 1.4, 0.2, 1); this.gLeaf = new Ramp();
      /** Levels of the layers after the last render: read by the tests and by diagnostics. */
      this.levels = { surf: 0, gulls: 0, insects: 0, frogs: 0, traffic: 0, neon: 0, harbour: 0, aircraft: 0, leaves: 0 };
    }

    /** Adds n frames of ambience. `ctl` is the smoothed control vector. */
    render(ctl, outL, outR, send, n) {
      const target = K.DISTRICT_PROFILES[clamp(Math.round(ctl[P.DISTRICT]), 0, K.DISTRICT_PROFILES.length - 1)];
      const pr = this.profile;
      for (let i = 0; i < PROFILE.COUNT; i++) pr[i] += (target[i] - pr[i]) * this.profileK;

      const night = sat(ctl[P.NIGHT]), day = 1 - night, hour = ctl[P.HOUR];
      const rain = sat(ctl[P.RAIN]), wind = sat(ctl[P.WIND]), ocean = sat(ctl[P.OCEAN]), city = sat(ctl[P.CITY]);
      const speed = Math.abs(ctl[P.SPEED]), cover = sat(ctl[P.COVER]);
      // Road and wind noise mask the quiet sources quickly, the big ones slowly.
      const quiet = 1 / (1 + (speed / 16) * (speed / 16)), loud = 1 / (1 + (speed / 45) * (speed / 45));
      const open = 1 - 0.6 * cover, dryAir = 1 - 0.75 * rain;
      const busy = smoothstep(5, 8, hour) * (1 - smoothstep(21, 24, hour));
      const heat = smoothstep(10, 13.5, hour) * (1 - smoothstep(17, 19.5, hour));

      const L = this.levels;
      L.surf = ocean * loud * open * (1 + 0.5 * wind) * (1 - 0.2 * night);
      L.gulls = Math.max(pr[PROFILE.GULLS] * ocean, pr[PROFILE.HARBOUR] * 0.8) * day * dryAir * quiet * open;
      L.insects = pr[PROFILE.INSECTS] * night * dryAir * quiet * open;
      L.frogs = pr[PROFILE.FROGS] * night * quiet * open * (0.6 + 0.8 * Math.max(rain, sat(ctl[P.WET])));
      L.traffic = pr[PROFILE.TRAFFIC] * (0.35 + 0.65 * city) * (0.4 + 0.6 * busy) * loud * open;
      // Signs come on in the late afternoon. If the game does not supply a proximity, assume one from the district.
      const signs = ctl[P.NEON] >= 0 ? sat(ctl[P.NEON]) : 0.6 * pr[PROFILE.NEON] * sat(night * 1.6);
      L.neon = signs * quiet * quiet;
      L.harbour = pr[PROFILE.HARBOUR] * loud * open;
      L.aircraft = pr[PROFILE.AIRCRAFT] * (0.5 + 0.5 * busy) * (1 - 0.4 * cover);
      L.leaves = wind * (0.35 + 0.65 * pr[PROFILE.INSECTS]) * quiet * open;
      const cicadas = pr[PROFILE.INSECTS] * heat * day * dryAir * quiet * open;

      if (L.surf > 1e-4 || this.gSea.v > 1e-5) {
        this.breakers[0].render(L.surf, outL, outR, send, n); this.breakers[1].render(L.surf, outL, outR, send, n);
        this.gSea.aim(MIX.seaBed * L.surf, n);
        for (let i = 0; i < n; i++) { const y = this.seaLp.lp(this.seaPink.next()) * this.gSea.next() * 4; outL[i] += y; outR[i] += y; }
      }
      this.gulls[0].render(L.gulls, outL, outR, send, n); this.gulls[1].render(L.gulls * 0.8, outL, outR, send, n);
      if (L.insects > 1e-4) for (const c of this.crickets) c.render(L.insects, outL, outR, n);
      this.trill.render(MIX.trill * L.insects, outL, outR, n); this.cicada.render(MIX.cicada * cicadas, outL, outR, n);
      for (const f of this.frogs) f.render(L.frogs, outL, outR, send, n);
      this.city.render(L.traffic, night, outL, outR, send, n);
      this.neon.render(L.neon, outL, outR, n);
      this.harbour.render(L.harbour, wind, outL, outR, send, n);
      this.aircraft.render(L.aircraft, outL, outR, send, n);

      const leafTarget = MIX.leaves * L.leaves * this.gust.tick();
      if (!this.gLeaf.silent(leafTarget)) {
        this.gLeaf.aim(leafTarget, n);
        for (let i = 0; i < n; i++) { const y = this.leafF.bp(this.leafPink.next()) * this.gLeaf.next() * 2; outL[i] += y; outR[i] += y * 0.85; }
      }
    }
  }
  K.Ambience = Ambience;
}
