// Everything the car makes that is not the engine: tyre roll by surface, slip (squeal on dry,
// hiss on wet, gravel on loose ground), spray, kerb and joint thumps, landing, and the wind of
// its own speed.
// Packaging rules: see the header of kernel.js.

export function defineRoad(K) {
  const { P, SURFACE, Rng, Pink, Svf, OnePole, Wander, Ping, Burst, Ramp, sat, clamp, smoothstep, saw, coef } = K;

  const MIX = {
    roll: 0.085, rumble: 0.11, sing: 0.012,
    scrub: 0.10, squeal: 0.085, wetHiss: 0.11, loose: 0.20,
    spray: 0.075, brake: 0.02,
    thump: 0.32, deckRing: 0.05,
    wind: 0.21, windHiss: 0.02,
    send: 0.10,
  };

  // Per surface: roll level, roll brightness, low rumble, how much it grinds rather than squeals.
  //                         asphalt concrete sand  grass deck  kerb  water
  const ROLL_LEVEL = [1.00, 1.10, 1.25, 0.85, 1.15, 1.25, 0.90];
  const ROLL_BRIGHT = [1.00, 1.35, 0.45, 0.60, 1.20, 1.00, 0.80];
  const ROLL_RUMBLE = [0.50, 0.55, 1.00, 0.90, 0.80, 1.00, 0.70];
  const LOOSE = [0.00, 0.00, 1.00, 1.00, 0.00, 0.00, 1.00];
  const WHEELBASE = 2.5;        // metres: the rear axle repeats what the front axle hit
  const DECK_JOINT = 11;        // metres between expansion joints on a bridge deck
  const SLAB_JOINT = 4.5;       // metres between slab joints on concrete paving
  const KERB_PITCH = 0.42;      // metres between the ribs of a rumble kerb

  /** A pool of short low thumps with a noise click on top: joints, kerbs, landings. */
  class Thumper {
    constructor(sr, seed, voices) {
      this.sr = sr; this.next = 0; this.voices = [];
      for (let i = 0; i < voices; i++) this.voices.push({ ping: new Ping(), burst: new Burst(seed + i), pan: 0 });
    }
    hit(amp, hz, seconds, clickHz, pan = 0, delaySeconds = 0) {
      const v = this.voices[this.next]; this.next = (this.next + 1) % this.voices.length;
      const delay = delaySeconds * this.sr;
      v.ping.start(hz, hz * 0.55, seconds, amp, this.sr, delay);
      v.burst.start(clickHz, 1.1, seconds * 0.3, amp * 0.55, this.sr, delay, 0.001);
      v.pan = pan;
    }
    get active() { for (const v of this.voices) if (v.ping.active || v.burst.active) return true; return false; }
    render(outL, outR, n) {
      for (const v of this.voices) {
        if (!v.ping.active && !v.burst.active) continue;
        const gl = K.panL(v.pan), gr = K.panR(v.pan);
        for (let i = 0; i < n; i++) { const y = v.ping.next() + v.burst.next(); outL[i] += y * gl; outR[i] += y * gr; }
      }
    }
  }
  K.Thumper = Thumper;

  class Road {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed);
      const chunkRate = sr / K.CHUNK;
      this.pinkL = new Pink(seed + 1); this.pinkR = new Pink(seed + 2); this.noise = new Rng(seed + 3);
      // Surface cross-fade weights: one per surface, the current one drifts to 1.
      this.weights = new Float32Array(SURFACE.COUNT); this.weights[0] = 1;
      this.weightK = coef(0.07, chunkRate);
      this.surface = 0; this.wasAirborne = false; this.airTime = 0;
      this.travel = 0; this.kerbTravel = 0;

      this.rollL = new Svf(); this.rollR = new Svf(); this.rumble = new OnePole(); this.rumbleHp = new OnePole().set(28, sr);
      this.singPhase = 0;
      this.deck = [new Svf(), new Svf(), new Svf()];
      this.grain = new Wander(seed + 4, 3, 0, 1);         // fast random amplitude: loose ground crunch

      this.scrubF = new Svf(); this.hissF = new Svf(); this.looseF = new Svf(); this.sprayF = new Svf(); this.brakeF = new Svf();
      // Two squealing tyres a little apart in pitch; each has its own pitch wander and roughness.
      this.sq = [0, 1].map((i) => ({
        phase: 0, wander: new Wander(seed + 10 + i, chunkRate * 0.12), rough: new OnePole().set(55 + 20 * i, sr),
        bp: new Svf(), ratio: i ? 1.19 : 1,
      }));

      this.windL = new Svf(); this.windR = new Svf(); this.windHp = new Svf().set(5200, 0.7, sr);
      this.gustL = new Wander(seed + 20, chunkRate * 0.9, 0.7, 1.15); this.gustR = new Wander(seed + 21, chunkRate * 1.1, 0.7, 1.15);
      this.buffet = new Wander(seed + 22, chunkRate * 0.11, 0.8, 1.2);

      this.thumps = new Thumper(sr, seed + 30, 6);

      this.gRoll = new Ramp(); this.gRumble = new Ramp(); this.gSing = new Ramp(); this.gDeck = new Ramp();
      this.gScrub = new Ramp(); this.gSqueal = new Ramp(); this.gHiss = new Ramp(); this.gLoose = new Ramp();
      this.gSpray = new Ramp(); this.gBrake = new Ramp(); this.gWindL = new Ramp(); this.gWindR = new Ramp(); this.gWindHiss = new Ramp();
      this.gSqPan = new Ramp();
    }

    _events(ctl, speed, grounded, chunkSeconds) {
      const surface = Math.round(ctl[P.SURFACE]);
      const amp = MIX.thump * smoothstep(1, 22, speed);
      if (surface !== this.surface) {
        // Crossing between carriageway and pavement means climbing or dropping a kerb.
        const hard = (s) => s === SURFACE.ASPHALT || s === SURFACE.DECK;
        const edge = hard(surface) !== hard(this.surface) || surface === SURFACE.KERB;
        if (edge && grounded > 0.5 && speed > 0.8) {
          const pan = this.rng.range(-0.5, 0.5);
          this.thumps.hit(amp * 1.1 + 0.03, 105, 0.12, 380, pan);
          this.thumps.hit(amp * 0.9 + 0.02, 95, 0.12, 340, -pan, WHEELBASE / Math.max(speed, 2));
        }
        this.surface = surface;
      }
      // Landing after the wheels left the ground: harder after a longer flight.
      const airborne = ctl[P.AIRBORNE] > 0.5;
      if (airborne) this.airTime += chunkSeconds;
      else if (this.wasAirborne) {
        const hard = MIX.thump * sat(0.35 + this.airTime * 2.2);
        this.thumps.hit(hard, 80, 0.2, 260, -0.2); this.thumps.hit(hard * 0.85, 72, 0.2, 240, 0.2, 0.045);
        this.airTime = 0;
      }
      this.wasAirborne = airborne;

      if (grounded < 0.5 || speed < 1) return;
      const step = speed * chunkSeconds;
      const joint = surface === SURFACE.DECK ? DECK_JOINT : surface === SURFACE.CONCRETE ? SLAB_JOINT : 0;
      if (joint > 0) {
        this.travel += step;
        if (this.travel >= joint) {
          this.travel -= joint;
          const a = amp * (surface === SURFACE.DECK ? 0.7 : 0.22);
          this.thumps.hit(a, 92, 0.085, 620, 0); this.thumps.hit(a * 0.9, 86, 0.085, 560, 0, WHEELBASE / Math.max(speed, 2));
        }
      }
      if (surface === SURFACE.KERB) {
        this.kerbTravel += step;
        if (this.kerbTravel >= KERB_PITCH) {
          this.kerbTravel = 0;                    // at speed the ribs merge into a buzz: one hit per chunk at most
          this.thumps.hit(amp * 0.5 + 0.02, 130, 0.05, 520, this.rng.range(-0.6, 0.6));
        }
      }
    }

    /** Adds n frames (n <= K.CHUNK) of road, tyre and wind sound. */
    render(ctl, outL, outR, send, n) {
      const sr = this.sr, chunkSeconds = n / sr;
      const speed = Math.abs(ctl[P.SPEED]), wet = sat(ctl[P.WET]), dry = 1 - wet;
      const grounded = 1 - sat(ctl[P.AIRBORNE]);
      const slip = sat(ctl[P.SLIP]) * grounded;
      this._events(ctl, speed, grounded, chunkSeconds);

      // Surface blend.
      const w = this.weights; let level = 0, bright = 0, rumbleAmt = 0, loose = 0;
      for (let s = 0; s < SURFACE.COUNT; s++) {
        w[s] += ((s === this.surface ? 1 : 0) - w[s]) * this.weightK;
        level += w[s] * ROLL_LEVEL[s]; bright += w[s] * ROLL_BRIGHT[s]; rumbleAmt += w[s] * ROLL_RUMBLE[s]; loose += w[s] * LOOSE[s];
      }
      const hard = 1 - loose;
      const moving = smoothstep(0.3, 6, speed);
      const pace = sat(speed / 60);

      // --- targets
      const grain = 1 - loose * 0.75 * this.grain.tick();
      const rollTarget = MIX.roll * level * Math.pow(pace, 0.75) * grounded * grain * (1 + 0.5 * wet);
      const rumbleTarget = MIX.rumble * rumbleAmt * Math.pow(pace, 0.6) * grounded * moving;
      const singTarget = MIX.sing * w[SURFACE.CONCRETE] * smoothstep(8, 30, speed) * grounded;
      const deckTarget = MIX.deckRing * w[SURFACE.DECK] * moving * grounded;
      const gate = smoothstep(2.5, 9, speed);
      const scrubTarget = MIX.scrub * smoothstep(0.1, 0.5, slip) * hard * gate * (1 - 0.6 * wet);
      const squealTarget = MIX.squeal * smoothstep(0.32, 0.8, slip) * hard * dry * dry * gate;
      const hissTarget = MIX.wetHiss * smoothstep(0.08, 0.6, slip) * hard * wet * gate;
      const looseTarget = MIX.loose * (0.15 * pace + smoothstep(0.08, 0.6, slip)) * loose * moving * grounded * (0.5 + 0.5 * this.grain.value);
      const sprayTarget = MIX.spray * wet * Math.pow(pace, 0.8) * grounded;
      const brakeTarget = MIX.brake * sat(ctl[P.BRAKE]) * smoothstep(3, 25, speed) * grounded;
      const air = speed + 9 * sat(ctl[P.WIND]);
      const airN = sat(air / 75);
      const buffet = this.buffet.tick();
      const windBase = MIX.wind * Math.pow(airN, 1.5) * (1 - 0.5 * sat(ctl[P.COVER]));
      const windHissTarget = MIX.windHiss * airN * airN;

      const idle = this.gRoll.silent(rollTarget) && this.gRumble.silent(rumbleTarget) && this.gScrub.silent(scrubTarget)
        && this.gSqueal.silent(squealTarget) && this.gHiss.silent(hissTarget) && this.gLoose.silent(looseTarget)
        && this.gSpray.silent(sprayTarget) && this.gWindL.silent(windBase) && this.gBrake.silent(brakeTarget);
      if (idle) { if (this.thumps.active) this.thumps.render(outL, outR, n); return; }

      this.gRoll.aim(rollTarget, n); this.gRumble.aim(rumbleTarget, n); this.gSing.aim(singTarget, n); this.gDeck.aim(deckTarget, n);
      this.gScrub.aim(scrubTarget, n); this.gSqueal.aim(squealTarget, n); this.gHiss.aim(hissTarget, n); this.gLoose.aim(looseTarget, n);
      this.gSpray.aim(sprayTarget, n); this.gBrake.aim(brakeTarget, n);
      this.gWindL.aim(windBase * this.gustL.tick() * buffet, n); this.gWindR.aim(windBase * this.gustR.tick() * buffet, n);
      this.gWindHiss.aim(windHissTarget, n);
      // The outside tyres do the squealing: lean the pair towards the side the car slides to.
      this.gSqPan.aim(clamp(ctl[P.SLIP_ANGLE] * 2.5, -0.45, 0.45), n);

      // --- filters
      const rollHz = (150 + 13 * speed) * bright;
      this.rollL.set(rollHz, 0.6, sr); this.rollR.set(rollHz * 1.07, 0.6, sr);
      this.rumble.set(45 + 1.6 * speed, sr);
      this.deck[0].set(74, 14, sr); this.deck[1].set(118, 16, sr); this.deck[2].set(187, 18, sr);
      this.scrubF.set(1300 + 900 * slip, 1.1, sr); this.hissF.set(5200, 0.6, sr);
      this.looseF.set(520 + 500 * pace, 0.7, sr); this.sprayF.set(3400 + 1500 * pace, 0.6, sr); this.brakeF.set(2600, 2.5, sr);
      const windHz = 190 + 15 * air;
      this.windL.set(windHz, 0.55, sr); this.windR.set(windHz * 1.13, 0.55, sr);

      // Squeal pitch: falls as the slide deepens, wanders as load shifts.
      const squealHz = 1050 - 330 * smoothstep(0.4, 1, slip) + 2.5 * Math.min(speed, 50);
      for (const v of this.sq) {
        v.hz = squealHz * v.ratio * (1 + 0.05 * v.wander.tick());
        v.bp.set(v.hz * 1.02, 7, sr);
      }
      const singInc = Math.min(0.2, speed / 0.036 / sr);   // tread blocks 36 mm apart
      const squealing = this.gSqueal.v > 1e-5 || squealTarget > 1e-5;
      const sqA = this.sq[0], sqB = this.sq[1];
      const incA = sqA.hz / sr, incB = sqB.hz / sr;

      for (let i = 0; i < n; i++) {
        const pl = this.pinkL.next(), pr = this.pinkR.next(), white = this.noise.white();
        const gRoll = this.gRoll.next();
        let l = this.rollL.bp(pl) * gRoll, r = this.rollR.bp(pr) * gRoll;
        const low = this.rumbleHp.hp(this.rumble.lp(pl + pr)) * this.gRumble.next();
        let mid = low;

        const gSing = this.gSing.next();
        if (gSing > 1e-6) { this.singPhase += singInc; if (this.singPhase >= 1) this.singPhase -= 1; mid += K.sin1(this.singPhase) * gSing; }
        const gDeck = this.gDeck.next();
        if (gDeck > 1e-6) mid += (this.deck[0].bp(pl) + this.deck[1].bp(pr) * 0.7 + this.deck[2].bp(white) * 0.5) * gDeck * 6;

        mid += this.scrubF.bp(white) * this.gScrub.next();
        mid += this.looseF.bp(pr) * this.gLoose.next() * 2;
        mid += this.brakeF.bp(white) * this.gBrake.next();
        const hiss = this.hissF.hp(white) * this.gHiss.next() + this.sprayF.bp(white) * this.gSpray.next();
        l += hiss * (0.7 + 0.3 * pl); r += hiss * (0.7 + 0.3 * pr);

        const gSq = this.gSqueal.next(), pan = this.gSqPan.next();
        if (squealing) {
          sqA.phase += incA; if (sqA.phase >= 1) sqA.phase -= 1;
          sqB.phase += incB; if (sqB.phase >= 1) sqB.phase -= 1;
          // Stick-slip: the tone is chopped by band-limited noise, never a steady whistle.
          const a = sqA.bp.bp(saw(sqA.phase, incA)) * (0.55 + 3.2 * Math.abs(sqA.rough.lp(white)));
          const b = sqB.bp.bp(saw(sqB.phase, incB)) * (0.55 + 3.2 * Math.abs(sqB.rough.lp(pl)));
          l += (a * (0.6 - pan) + b * (0.4 - pan * 0.5)) * gSq; r += (a * (0.4 + pan * 0.5) + b * (0.6 + pan)) * gSq;
        }

        const wl = this.windL.bp(pr) * this.gWindL.next(), wr = this.windR.bp(pl) * this.gWindR.next();
        const wh = this.windHp.hp(white) * this.gWindHiss.next();
        outL[i] += l + mid + wl + wh; outR[i] += r + mid + wr + wh;
        send[i] += (l + r + mid) * MIX.send;
      }
      if (this.thumps.active) this.thumps.render(outL, outR, n);
    }
  }
  K.Road = Road;
}
