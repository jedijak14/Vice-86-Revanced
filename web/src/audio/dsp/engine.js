// The player's engine, heard from the chase camera behind the exhausts. A time-domain physical
// model: nothing here is an oscillator or a table. Which engine it is (V12, flat-twelve,
// turbocharged flat-six, cross-plane V8) is data: see voices.js. This file is the physics they share.
//
// Source. The crank turns; at even intervals one cylinder opens its exhaust valve, in the
// voice's firing order. The valve releases a pressure pulse: a steep front and an exponential
// blow-down, whose height follows the load, whose front hardens with load, and whose length is
// a fixed crank angle at speed and a fixed time at low revs. Every firing differs a little from
// the last (cycle-to-cycle variation, large at idle, small under load), every cylinder differs
// a little from its neighbours for good (strength and runner length), and the turbulence of
// the blow-down is noise multiplied by the pulse, so it exists only while gas flows.
//
// Path. Each exhaust system (one per bank, or one for the whole engine) is header, main pipe
// and tailpipe as two-way delay lines joined by scattering junctions (the area steps at the
// collector and at the silencer), a nearly closed end at the valves, an open end at the
// tailpipe, and a silencer of four short parallel guides of different lengths that a
// load-operated valve bypasses. A turbine, where there is one, sits behind the collector and
// takes the top off every pulse. The waves travel at the speed of sound of the hot gas, which
// rises as the system heats up under load, so the resonances move with the driving. What leaves
// the open end is radiated as the rate of change of the flow (a high-pass) and loses its top to
// the air (a low-pass). Two systems are heard a little apart. The intake works the same way
// with suction pulses, a short trumpet and the throttle plates in front of it. Valve train and
// timing gears are kept low. A low-pass copy of the pipe pressure is the body of the sound
// that is felt at low revs.
//
// Behaviour: lumpy idle, bark on tip-in, hollow overrun with burble and pops, ignition-cut
// limiter, torque interruption on gear changes, afterfire on request, a starter sequence
// (cranking, catching, flare, settling). Nitrous (P.BOOST): a pressurised hiss, a rising jet
// whistle (narrow-band noise), a harder exhaust, a release puff. Turbocharger (P.TURBO): a
// whistle that follows the shaft, rushing air, harder firing, and the compressor stalling
// when the throttle shuts on boost. Cooling fan: blade-passing whirr that follows the crank.
// Packaging rules: see the header of kernel.js.

export function defineEngine(K) {
  const { P, Rng, Svf, OnePole, DcBlock, Delay, Burst, sat, clamp, smoothstep, coef, panL, panR } = K;

  const GUIDES = 4;                // parallel guides in a silencer

  // Engine speeds in this file are written for an engine that idles at 1000 and is red-lined at
  // 7500 rpm, and are placed between the idle and the redline of the car in hand (Engine._at).
  const WRITTEN_IDLE = 1000, WRITTEN_REDLINE = 7500;
  const MAX_REDLINE = 20000;       // no engine in a car turns faster; anything above is a broken caller

  // Inertia of what the listener hears, on top of the 20 ms control smoothing of the synth.
  const RPM_INERTIA = 0.04, RPM_RISE = 16000, RPM_FALL = 10000;   // seconds, rpm per second
  const LOAD_ATTACK = 0.04, LOAD_RELEASE = 0.07, THROTTLE_INERTIA = 0.03;

  // Speed of sound (m/s) of the gas in each part, cold, and how much it gains at full heat.
  const HEADER_SPEED = 520, HEADER_HEAT = 150, PIPE_SPEED = 450, PIPE_HEAT = 120, TAIL_SPEED = 400, TAIL_HEAT = 90;

  /**
   * Shock steepening: a strong compression travels faster than a weak one and a rarefaction
   * cannot fall below a vacuum, so the wave compresses asymmetrically. Slope never exceeds one,
   * which keeps the guide passive.
   */
  const steepen = (x) => (x > 0 ? x / (1 + 0.22 * x) : x / (1 - 0.55 * x));

  /** One exhaust system, from the valves to the air behind the car. */
  class ExhaustPath {
    /** @param lengthScale stretches every length  @param x the `exhaust` group of a voice */
    constructor(sr, lengthScale, x = K.VOICES[0].exhaust) {
      this.sr = sr; this.scale = lengthScale; this.x = x;
      const longest = (Math.max(x.header, x.pipe, x.tail, 2 * x.guides[GUIDES - 1]) * (1 + x.spread) / TAIL_SPEED) * sr;
      this.headF = new Delay(longest); this.headB = new Delay(longest);
      this.pipeF = new Delay(longest); this.pipeB = new Delay(longest);
      this.tailF = new Delay(longest); this.tailB = new Delay(longest);
      this.guides = x.guides.map(() => new Delay(longest));
      this.guideLoss = x.guides.map((_, i) => new OnePole().set(x.guideLossHz + 600 * i, sr));
      this.guideTrip = new Float32Array(GUIDES);
      this.valveLoss = new OnePole().set(x.valveLossHz, sr);
      this.returnLoss = new OnePole().set(x.returnLossHz, sr);
      this.mouth = new OnePole().set(x.mouthHz, sr);
      this.radiation = new OnePole().set(x.radiationHz, sr);
      this.dc = new DcBlock(sr, 18);   // one-sided pressure pulses carry a mean the microphone never hears
      this.air = new Svf().set(x.airHz, 0.62, sr);
      this.turbine = new OnePole().set(x.turbineHz || 1000, sr);
      this.d1 = 8; this.d2 = 8; this.d3 = 8; this.bypass = 0;
      /** Pressure in the main pipe, read by the body layer. */
      this.pressure = 0;
    }

    /** Sets the travel times for the gas temperature and the position of the bypass valve. */
    tune(heat, bypass) {
      const x = this.x, tail = TAIL_SPEED + TAIL_HEAT * heat, k = this.scale * this.sr;
      this.d1 = (x.header / (HEADER_SPEED + HEADER_HEAT * heat)) * k; this.d2 = (x.pipe / (PIPE_SPEED + PIPE_HEAT * heat)) * k; this.d3 = (x.tail / tail) * k;
      for (let i = 0; i < GUIDES; i++) this.guideTrip[i] = Math.max(2, (2 * x.guides[i] / tail) * k);
      this.bypass = bypass;
    }

    /** Four parallel guides, each ringing at its own length; their sum blurs and hollows the wave. */
    _silencer(x) {
      const feedback = this.x.silencerFeedback;
      let sum = 0;
      for (let i = 0; i < GUIDES; i++) {
        const line = this.guides[i], trip = this.guideTrip[i];
        line.write(x * (1 - feedback) + feedback * this.guideLoss[i].lp(line.read(trip)));
        sum += line.read(1 + trip * 0.5);
      }
      const muffled = sum * 0.25;
      return muffled + (x - muffled) * this.bypass;
    }

    /**
     * One sample. `source` is the pressure released at the valves, `inject` anything that
     * ignites in the pipe itself (pops). Returns the sound radiated behind the car.
     */
    tick(source, inject) {
      const x = this.x, collector = x.collectorStep, silencer = x.silencerStep;
      const f1 = this.headF.read(this.d1), b1 = this.headB.read(this.d1);
      const f2 = this.pipeF.read(this.d2), b2 = this.pipeB.read(this.d2);
      const f3 = this.tailF.read(this.d3), b3 = this.tailB.read(this.d3);

      this.headF.write(source + x.valveReflection * this.valveLoss.lp(b1));
      let onward = steepen((1 + collector) * f1 - collector * b2 + inject);
      // The turbine wheel takes its work out of the fast part of the wave.
      if (x.turbine > 0) onward += (this.turbine.lp(onward) - onward) * x.turbine;
      this.pipeF.write(onward);
      this.headB.write(collector * f1 + (1 - collector) * b2);

      const back = x.silencerReturn * this.returnLoss.lp(b3);
      this.pipeB.write(silencer * f2 + (1 - silencer) * back);
      this.tailF.write(this._silencer((1 + silencer) * f2 - silencer * back));

      const reflected = x.mouthReflection * this.mouth.lp(f3);
      this.tailB.write(-reflected);
      this.pressure = f2 + b2;
      // Flow out of the mouth is the outgoing wave minus the returning one; the ear gets its rate of change.
      const flow = f3 + reflected;
      return this.air.lp(this.dc.run(flow - x.radiationDepth * this.radiation.lp(flow)));
    }
  }

  /**
   * A compressor stalling: the air it has packed into the pipework beats back through the
   * wheel in a few quick breaths when the throttle shuts. Band-limited noise under an envelope
   * that pulses at a slowing rate; with no pulse rate it is a single sigh. `seconds` is the
   * time it takes to fall by 20 dB.
   */
  class Chuff {
    constructor(seed) { this.rng = new Rng(seed); this.band = new Svf(); this.env = 0; this.decay = 0; this.rise = 0; this.attack = 0; this.beat = 0; this.rate = 0; this.slowing = 1; }
    start(hz, q, seconds, level, flutterHz, sr) {
      this.band.set(hz, q, sr); this.env = level; this.decay = Math.exp(-2.3 / (seconds * sr));
      this.rise = 0; this.attack = 1 / (0.004 * sr);
      this.beat = 0.25; this.rate = flutterHz / sr; this.slowing = Math.exp(-0.9 / (seconds * sr));
    }
    get active() { return this.env > 1e-5; }
    next() {
      if (this.env <= 1e-5) { this.env = 0; return 0; }
      if (this.rise < 1) this.rise = Math.min(1, this.rise + this.attack);
      let breath = 1;
      if (this.rate > 0) {
        this.beat += this.rate; if (this.beat >= 1) this.beat -= 1;
        this.rate *= this.slowing;
        const open = 0.5 + 0.5 * K.sin1(this.beat);
        breath = 0.12 + 0.88 * open * open;
      }
      const y = this.band.bp(this.rng.white()) * this.env * this.rise * breath;
      this.env *= this.decay;
      return y;
    }
  }

  class Engine {
    /** @param voice one entry of K.VOICES: which engine this is */
    constructor(sr, seed, voice = K.VOICES[0]) {
      this.sr = sr; this.voice = voice;
      this.rng = new Rng(seed);
      this.noise = new Rng(seed + 1);
      const chunkRate = sr / K.CHUNK, cylinders = voice.cylinders, pulse = voice.pulse, intake = voice.intake;

      // --- crank and cylinders
      this.phase = 0; this.slot = -1; this.inc = 1000 / (120 * sr);
      /** Lasting differences between the cylinders: firing strength and exhaust runner length (m). */
      this.trim = new Float32Array(cylinders); this.runner = new Float32Array(cylinders);
      for (let c = 0; c < cylinders; c++) { this.trim[c] = K.hash(c, seed, 6) * 2 - 1; this.runner[c] = pulse.runner + pulse.runnerSpread * K.hash(c, seed, 7); }
      // Each pulse is the difference of a slow and a fast decaying exponential.
      this.slow = new Float32Array(cylinders); this.fast = new Float32Array(cylinders);
      this.slowRate = new Float32Array(cylinders).fill(0.9); this.fastRate = new Float32Array(cylinders).fill(0.5);
      this.wait = new Int32Array(cylinders); this.startSlow = new Float32Array(cylinders); this.startFast = new Float32Array(cylinders);
      this.stumbleIn = 60; this.cutLeft = 0; this.fireLeft = 0; this.cutting = false; this.limiting = false;
      this.amplitude = pulse.idleFiring; this.variation = 0.3; this.imbalance = 0.1; this.overrunNow = 0; this.popChance = 0;
      /** Spread of the pulses' travel time from one firing to the next, seconds. */
      this.scatter = 0.0001;
      this.pumping = pulse.pumping;
      this.decaySeconds = pulse.seconds; this.riseSeconds = pulse.seconds * 0.2; this.headerSpeed = HEADER_SPEED;

      // --- what the listener's engine is doing, after inertia
      this.rpm = 1000; this.slewed = 1000; this.redline = WRITTEN_REDLINE; this.started = false;
      /** Idle speed of the car in hand and the stretch from the written rev range to its own. */
      this.idle = WRITTEN_IDLE; this.span = 1;
      this.load = 0; this.loadSlow = 0; this.throttle = 0; this.open = 0;
      this.rpmK = coef(RPM_INERTIA, chunkRate); this.throttleK = coef(THROTTLE_INERTIA, chunkRate);
      this.loadUpK = coef(LOAD_ATTACK, chunkRate); this.loadDownK = coef(LOAD_RELEASE, chunkRate);
      this.barkK = coef(0.16, chunkRate);
      this.roughness = 0; this.roughK = coef(0.22, chunkRate);
      this.heat = 0.2; this.heatK = coef(1.6, chunkRate);
      this.overrun = 0; this.overrunK = coef(0.09, chunkRate); this.fresh = 0; this.wasOverrun = false;
      this.gear = 0; this.cutTime = 0; this.blipTime = 0; this.crack = false;

      // --- exhaust: one system per bank, or one for the whole engine
      const x = voice.exhaust;
      this.left = new ExhaustPath(sr, 1 - x.spread, x);
      this.right = voice.exhausts === 2 ? new ExhaustPath(sr, 1 + x.spread, x) : null;
      this.grainL = new OnePole().set(pulse.grainHz, sr); this.grainR = new OnePole().set(pulse.grainHz, sr);
      // Brings the low-passed white noise back to unit RMS, so `grain` is a modulation depth.
      this.grainMakeup = 1 / (0.577 * Math.sqrt((Math.PI / 2) * pulse.grainHz / (sr / 2)));
      this.bodyLp = new Svf().set(voice.body.lowpassHz, 0.8, sr); this.bodyHp = new Svf().set(voice.body.highpassHz, 0.7, sr);
      // Pops: a short pulse per bank that starts in the pipe. Up to eight more can be queued.
      this.popSlow = new Float32Array(2); this.popFast = new Float32Array(2);
      this.popSlowRate = new Float32Array(2).fill(0.9); this.popFastRate = new Float32Array(2).fill(0.5);
      this.queueIn = new Float32Array(8); this.queueSize = new Float32Array(8); this.queued = 0;

      // --- intake
      this.intakeSlow = 0; this.intakeFast = 0; this.intakeTrim = new Float32Array(cylinders);
      for (let c = 0; c < cylinders; c++) this.intakeTrim[c] = 1 + 0.2 * (K.hash(c, seed, 8) * 2 - 1);
      this.trumpet = new Delay((2 * intake.trumpet / 343) * sr + 8); this.trumpetTrip = (2 * intake.trumpet / 343) * sr;
      this.trumpetLoss = new OnePole().set(intake.lossHz, sr);
      this.airbox = new Svf(); this.plates = new Svf(); this.intakeDc = new DcBlock(sr, 30);
      this.intakeGrain = new OnePole().set(2800, sr);

      // --- mechanical
      this.tick = 0; this.tickWait = 0;
      this.valveHp = new Svf().set(voice.mech.valveHz, 0.7, sr); this.whine = new Svf();
      this.valveTop = new Svf().set(voice.mech.valveTopHz || sr * 0.45, 0.7, sr);
      this.clunk = new Burst(seed + 30);

      // --- nitrous
      this.boost = 0; this.boostTime = 0; this.boostK = coef(0.05, chunkRate); this.wasBoosting = false;
      this.hissBp = new Svf(); this.whistleBp = new Svf(); this.puff = new Burst(seed + 32);
      /** Centre frequency of the jet whistle in Hz; read by the offline tests. */
      this.whistleHz = 0;

      // --- turbocharger: boost pressure and shaft speed, both 0..1
      this.spool = 0; this.derivedSpool = 0; this.shaft = 0; this.heldBoost = 0; this.chuffArmed = false;
      this.spoolK = coef(0.03, chunkRate);          // the physics reports boost once per frame
      this.shaftUpK = coef(0.07, chunkRate);
      this.turboBp = new Svf(); this.rushBp = new Svf(); this.chuff = new Chuff(seed + 34);
      /** Centre frequency of the turbine whistle in Hz; read by the offline tests. */
      this.turboHz = 0;

      // --- cooling fan
      this.fanBp = new Svf(); this.fanRush = new Svf();
      if (voice.fan) this.fanRush.set(voice.fan.rushHz, 0.6, sr);

      // --- starter (start())
      this.startTime = -1; this.cranking = false; this.catching = 0;
      this.starterBp = new Svf(); this.starterK = coef(0.035, chunkRate);

      // Per-sample gains, ramped across each chunk (value at the end of the previous chunk).
      this.exGain = 0; this.bodyGain = 0; this.inGain = 0; this.mechGain = 0; this.grain = 0; this.hissG = 0; this.whistleG = 0;
      this.turboG = 0; this.rushG = 0; this.fanG = 0; this.starterG = 0;
    }

    /** An engine speed written for the 1000 to 7500 rpm engine, placed in the rev range of the car in hand. */
    _at(rpm) { return this.idle + (rpm - WRITTEN_IDLE) * this.span; }

    /**
     * Starts the engine from standstill: the starter turns it, it catches, flares and settles
     * to the speed the game reports. Call on a new engine, before its first render.
     */
    start() {
      const s = this.voice.start;
      this.startTime = 0; this.cranking = true; this.catching = 1;
      this.started = true; this.rpm = s.crankRpm; this.slewed = s.crankRpm;
      // The solenoid throws the pinion into the ring gear.
      this.clunk.start(1300, 1.4, 0.035, 0.6 * this.voice.mix.clunk, this.sr, 0, 0.001);
    }

    /** Something ignites in the pipes: a short pressure pulse that starts past the collector. */
    _pop(size, seconds) {
      const bank = this.rng.chance(0.5) ? 1 : 0;
      this.popSlow[bank] += size; this.popFast[bank] += size;
      this.popSlowRate[bank] = Math.exp(-1 / (seconds * this.sr));
      this.popFastRate[bank] = Math.exp(-1 / (seconds * 0.12 * this.sr));
    }

    _queuePop(size, delaySeconds) {
      if (this.queued >= this.queueIn.length) return;
      this.queueIn[this.queued] = delaySeconds; this.queueSize[this.queued] = size; this.queued++;
    }

    /** Fires the queued pops whose time has come. */
    _runQueue(seconds) {
      for (let i = this.queued - 1; i >= 0; i--) {
        this.queueIn[i] -= seconds;
        if (this.queueIn[i] > 0) continue;
        this._pop(this.queueSize[i], 0.001 + 0.0012 * this.rng.float());
        this.queued--; this.queueIn[i] = this.queueIn[this.queued]; this.queueSize[i] = this.queueSize[this.queued];
      }
    }

    /**
     * Afterfire: unburnt fuel lighting in the pipes. One bang whose size follows `strength`
     * (0..1), then a scatter of pops over the next third of a second.
     */
    afterfire(strength) {
      const s = sat(strength), r = this.rng, mix = this.voice.mix;
      if (s <= 0) return;
      this._pop(mix.bang * (0.35 + 0.65 * s), 0.0018 + 0.0025 * s);
      const pops = 1 + Math.round(4 * s * r.float());
      for (let i = 0; i < pops; i++) this._queuePop(mix.pop * (0.4 + 0.6 * r.float() * s), 0.03 + r.float() * (0.1 + 0.25 * s));
    }

    /** A gear change interrupts the torque: combustion is cut for an upshift, blipped for a downshift. */
    _gearChange(from, to) {
      if (from > 0 && to > from) { this.cutTime = 0.15; this.crack = this.load > 0.5; }
      else if (from > 1 && to > 0 && to < from) this.blipTime = 0.09;
      this.clunk.start(150, 1.1, 0.05, this.voice.mix.clunk, this.sr, 0, 0.002);
    }

    /** How hard the cylinder that is due fires, with everything that makes one firing differ from the next. */
    _strength(cylinder) {
      const r = this.rng, voice = this.voice, pop = voice.mix.pop;
      // On the starter nothing burns: the cylinders only push their air out.
      if (this.cranking) return this.pumping * (0.8 + 0.4 * r.float());
      // The first firings after the catch come one by one.
      if (this.catching > 0 && r.chance(0.7 * this.catching)) return this.pumping;
      let a = this.amplitude * (1 + this.trim[cylinder] * this.imbalance + (r.white() + r.white()) * 0.6 * this.variation);
      if (this.limiting) {
        // Ignition cut: about 30 ms without spark, 25 ms with, never twice the same length.
        if (this.cutLeft <= 0 && this.fireLeft <= 0) { this.cutLeft = 18 + r.int(8); this.fireLeft = 14 + r.int(8); }
        if (this.cutLeft > 0) { this.cutLeft--; this.cutting = true; return this.pumping; }
        if (this.cutting) { this.cutting = false; if (r.chance(0.6)) this._pop(pop * r.range(0.5, 1), 0.0012); }
        this.fireLeft--;
      } else { this.cutLeft = 0; this.fireLeft = 0; this.cutting = false; }
      if (this.overrunNow > 0.5) {
        // Fuel is cut on the overrun: most cylinders only pump, some catch a partial charge.
        a = this.pumping * (1 + 0.25 * r.white()) + (r.chance(voice.overrun.partial) ? 0.12 + 0.4 * r.float() * r.float() : 0);
        if (r.chance(this.popChance)) this._pop(pop * r.range(0.35, 1), 0.001 + 0.0015 * r.float());
      } else if (this.amplitude < voice.pulse.idleFiring * 1.3 && --this.stumbleIn <= 0) {
        // An idling engine drops a weak firing now and then.
        this.stumbleIn = voice.idle.stumbleEvery + r.int(voice.idle.stumbleSpread);
        a *= voice.idle.stumbleDepth;
      }
      return a > 0.5 * voice.pulse.pumping ? a : 0.5 * voice.pulse.pumping;
    }

    /**
     * The exhaust valve of cylinder `c` opens. `since` is how long ago within the current
     * sample (0..1) the crank passed the slot, so the pulse starts between samples.
     */
    _fire(c, since) {
      const sr = this.sr;
      const a = this._strength(c);
      const slowRate = Math.exp(-1 / (this.decaySeconds * sr)), fastRate = Math.exp(-1 / (this.riseSeconds * sr));
      // The pulse reaches the collector after the runner's travel time. No two charges burn alike:
      // the gas of one firing is hotter than that of the next and its wave travels faster, so the
      // pulses arrive a few tens of microseconds early or late. That is what turns the upper
      // harmonics of a real engine into noise while the low ones stay lines.
      const late = this.scatter * sr * (1.5 + 0.7 * (this.rng.white() + this.rng.white()));
      const arrival = (this.runner[c] / this.headerSpeed) * sr + late - since;
      const whole = Math.ceil(arrival), part = whole - arrival;
      this.wait[c] = whole + 1; this.slowRate[c] = slowRate; this.fastRate[c] = fastRate;
      this.startSlow[c] = a * Math.pow(slowRate, part); this.startFast[c] = a * Math.pow(fastRate, part);
      // The same cylinder's neighbour in the cycle draws its charge in: one intake pulse per slot.
      const suck = this.intakeTrim[c];
      this.intakeSlow += suck; this.intakeFast += suck;
      // Two valves close per slot: one now, one half a slot later.
      this.tick = 0.5 + 0.5 * this.rng.float();
      this.tickWait = (0.5 / (this.voice.slots * this.inc)) | 0;
    }

    /**
     * The starter sequence, while it runs: dictates crank speed, load and throttle.
     * Returns the crank speed the engine is aiming for; `gameRpm` is where it must end up.
     */
    _startSequence(seconds, gameRpm) {
      const s = this.voice.start;
      this.startTime += seconds;
      const t = this.startTime - s.crankSeconds;
      if (t < 0) {
        // Every compression stroke slows the starter: the rhythm of a cranking engine.
        const rpm = s.crankRpm * (1 + 0.14 * K.sin1(this.phase * this.voice.slots));
        this.rpm = rpm; this.slewed = rpm;
        return rpm;
      }
      this.cranking = false;
      this.catching = Math.max(0, 1 - t / 0.3);
      if (t < s.flareSeconds) return s.crankRpm + (s.flareRpm - s.crankRpm) * smoothstep(0, s.flareSeconds, t);
      const settled = smoothstep(s.flareSeconds, s.flareSeconds + s.settleSeconds, t);
      if (settled >= 1) this.startTime = -1;
      return s.flareRpm + (gameRpm - s.flareRpm) * settled;
    }

    /** Follows the inputs with the inertia of a real engine. Called once per chunk. */
    _follow(ctl, seconds) {
      // A rev range that is missing or makes no sense (also NaN and infinity) reads as the range the model was written for.
      const redline = ctl[P.REDLINE] > 1000 && ctl[P.REDLINE] < MAX_REDLINE ? ctl[P.REDLINE] : WRITTEN_REDLINE;
      const idle = ctl[P.IDLE] > 300 && ctl[P.IDLE] < 0.5 * redline ? ctl[P.IDLE] : Math.min(WRITTEN_IDLE, 0.5 * redline);
      const limiter = ctl[P.LIMITER] > 1000 ? ctl[P.LIMITER] : redline;
      this.idle = idle; this.span = (redline - idle) / (WRITTEN_REDLINE - WRITTEN_IDLE);
      // Written as comparisons so that a NaN from a broken caller reads as a stalled engine, not as poison for the delay lines.
      const raw = ctl[P.RPM];
      let rpmIn = raw > 500 ? (raw < redline + 400 ? raw : redline + 400) : 500;
      const starting = this.startTime >= 0;
      if (starting) rpmIn = this._startSequence(seconds, rpmIn);
      if (!this.started) { this.started = true; this.rpm = rpmIn; this.slewed = rpmIn; }
      // The crank cannot jump: limit how fast it may gain or lose speed, then round the corners.
      const up = RPM_RISE * seconds, down = RPM_FALL * seconds, d = rpmIn - this.slewed;
      this.slewed += d > up ? up : d < -down ? -down : d;
      this.rpm += (this.slewed - this.rpm) * this.rpmK;
      this.throttle += (sat(ctl[P.THROTTLE]) - this.throttle) * this.throttleK;

      // --- gear change
      const gear = Math.round(ctl[P.GEAR]);
      if (gear !== this.gear) { this._gearChange(this.gear, gear); this.gear = gear; }
      let loadIn = sat(ctl[P.LOAD]), open = this.throttle;
      if (this.cutTime > 0) {
        this.cutTime -= seconds; loadIn = 0; open = 0;
        // Fuel that went unburnt during the cut lights in the pipe as the drive comes back.
        if (this.cutTime <= 0 && this.crack && this.rng.chance(0.75)) this._pop(this.voice.mix.pop * this.rng.range(0.5, 1), 0.0014);
      }
      if (this.blipTime > 0) { this.blipTime -= seconds; if (loadIn < 0.45) loadIn = 0.45; if (open < 0.45) open = 0.45; }
      if (starting) {
        // Nothing burns on the starter; the catch is a rich, fast idle that the engine then runs down from.
        loadIn = this.cranking ? 0 : Math.max(loadIn, 0.5 * (1 - smoothstep(0, this.voice.start.flareSeconds, this.startTime - this.voice.start.crankSeconds)));
        open = this.cranking ? 0 : Math.max(open, 0.15);
      }
      this.load += (loadIn - this.load) * (loadIn > this.load ? this.loadUpK : this.loadDownK);
      this.loadSlow += (this.load - this.loadSlow) * this.barkK;
      this.open = open;
      this.redline = redline;
      this.limiting = rpmIn >= limiter - 60 && this.throttle > 0.5 && this.cutTime <= 0;
    }

    /**
     * Turbocharger, once per chunk: boost from the physics (P.TURBO) or, without it, from revs
     * and throttle with the lag of the wheel; the shaft that runs on after the pressure has
     * gone; and the compressor stalling when the throttle shuts on boost.
     */
    _turbo(ctl, seconds, open, rpmN) {
      const t = this.voice.turbo, sr = this.sr, given = ctl[P.TURBO];
      let boost = given;
      if (!(given >= 0)) {
        const want = smoothstep(this._at(t.from), this._at(t.full), this.rpm) * smoothstep(0.3, 0.85, open);
        this.derivedSpool += (want - this.derivedSpool) * (1 - Math.exp(-seconds / (want > this.derivedSpool ? t.rise : t.fall)));
        boost = this.derivedSpool;
      }
      this.spool += (sat(boost) - this.spool) * this.spoolK;
      // Exhaust flow alone keeps the wheel turning; pressure in the pipework needs it fast.
      const driven = Math.max(this.spool, t.freewheel * rpmN * (0.35 + 0.65 * open));
      this.shaft += (driven - this.shaft) * (driven > this.shaft ? this.shaftUpK : 1 - Math.exp(-seconds / t.coast));
      // What is still packed into the pipework a moment after the boost reading has fallen.
      this.heldBoost = Math.max(this.spool, this.heldBoost * Math.exp(-seconds / 0.25));
      if (open > 0.5) this.chuffArmed = true;
      else if (open < 0.25 && this.chuffArmed) {
        this.chuffArmed = false;
        if (this.heldBoost > t.chuffAbove) this.chuff.start(t.chuffHz, t.chuffQ, t.chuffSeconds * (0.6 + 0.4 * this.heldBoost), t.chuff * this.heldBoost, t.flutterHz, sr);
      }
      // The wastegate holds the pressure, not the wheel: it still gains a little speed with the revs.
      this.turboHz = t.whistleHz + t.whistleSpan * this.shaft * (0.86 + 0.14 * rpmN);
      this.turboBp.set(this.turboHz, t.whistleQ, sr);
      this.rushBp.set(t.rushHz * (0.7 + 0.3 * this.spool), 0.9, sr);
    }

    /**
     * Adds `n` frames (n <= K.CHUNK) of engine to outL / outR and its reverb share to `send`.
     * @param {Float32Array} ctl  smoothed controls (K.P)
     */
    render(ctl, outL, outR, send, n) {
      const sr = this.sr, seconds = n / sr, rng = this.rng, noise = this.noise;
      const voice = this.voice, mix = voice.mix, pulse = voice.pulse, x = voice.exhaust, lumpy = voice.idle, mech = voice.mech;
      const turbo = voice.turbo, fan = voice.fan;
      this._follow(ctl, seconds);
      const load = this.load, open = this.open, redline = this.redline;
      const cabin = sat(ctl[P.CABIN]);
      const floor = this._at(800);
      const rpmN = sat((this.rpm - floor) / (redline - floor));
      const idleness = 1 - smoothstep(this._at(1150), this._at(2400), this.rpm);
      /** Tip-in: how far the load has run ahead of where it was a moment ago. */
      const bark = Math.max(0, load - this.loadSlow);

      // --- overrun: throttle shut with the engine well above idle
      const overTarget = sat(1 - open * 8) * smoothstep(this._at(1400), this._at(2300), this.rpm) * (1 - load);
      this.overrun += (overTarget - this.overrun) * this.overrunK;
      const over = this.overrun;
      if (over > 0.5 && !this.wasOverrun) { this.wasOverrun = true; this.fresh = 1; }
      else if (over < 0.2) this.wasOverrun = false;
      this.fresh *= Math.exp(-seconds / 1.2);
      this.overrunNow = over;
      // Pops per firing: frequent just after the lift, occasional later, none at low revs.
      const popsPerSecond = (voice.overrun.pops + voice.overrun.popsFresh * this.fresh) * smoothstep(this._at(2500), this._at(4500), this.rpm);
      this.popChance = popsPerSecond / (this.rpm / (120 / voice.cylinders));
      this._runQueue(seconds);

      // --- nitrous: how long the bottle has been open, and the puff when it shuts
      const boostIn = sat(ctl[P.BOOST]);
      this.boost += (boostIn - this.boost) * this.boostK;
      const boost = this.boost;
      if (boostIn > 0.5) { this.boostTime += seconds; this.wasBoosting = true; }
      else if (this.wasBoosting && boostIn < 0.2) {
        this.wasBoosting = false;
        this.puff.start(1600, 0.5, 0.3 + 0.25 * Math.min(1, this.boostTime), mix.puff, sr, 0, 0.004);
        this.boostTime = 0;
      } else if (boostIn <= 0.5) this.boostTime = Math.max(0, this.boostTime - seconds * 3);
      const spool = 1 - Math.exp(-this.boostTime / 0.9);                     // the whistle climbs as pressure builds
      this.whistleHz = 1150 + 1500 * spool + 250 * rpmN;
      this.hissBp.set(2200 + 2600 * spool, 1.1, sr);
      this.whistleBp.set(this.whistleHz, 14, sr);

      // --- turbocharger: a charged cylinder fires harder
      if (turbo) this._turbo(ctl, seconds, open, rpmN);
      const charge = turbo ? 1 + turbo.charge * this.spool : 1;

      // --- crank speed: no engine holds its speed exactly, an idling one least of all
      this.roughness += (rng.white() - this.roughness) * this.roughK;
      // (for the V12 about 0.35 percent RMS under way, 1.2 percent at idle; the filtered noise has an RMS of 0.0225)
      const rpm = this.rpm * (1 + this.roughness * (lumpy.roughness + lumpy.roughnessIdle * idleness));
      const inc = rpm / (120 * sr);
      this.inc = inc;

      // --- the pulse the cylinders will release during this chunk
      const idleFiring = pulse.idleFiring * (1 - 0.45 * smoothstep(this._at(1500), this._at(3000), this.rpm));
      this.amplitude = (idleFiring + (1 - idleFiring) * Math.pow(load, 0.9)) * (1 + 0.55 * bark + 0.35 * boost) * charge;
      this.variation = 0.05 + lumpy.variation * (1 - load) * (0.35 + 0.65 * idleness);
      this.imbalance = 0.07 + lumpy.imbalance * idleness + 0.05 * (1 - load);
      this.scatter = pulse.scatter * (1.5 - 0.5 * load);
      this.pumping = pulse.pumping + pulse.pumpingRevs * rpmN;
      const hardness = sat(load + bark + 0.4 * boost);
      const longest = pulse.seconds + (pulse.secondsLoaded - pulse.seconds) * hardness;
      this.decaySeconds = Math.min(longest, (pulse.angle + (pulse.angleLoaded - pulse.angle) * hardness) / (6 * rpm));
      this.riseSeconds = this.decaySeconds * (pulse.rise - pulse.riseHardening * hardness);

      // --- gas temperature and the bypass valve
      this.heat += (sat(0.15 + 0.85 * load * (0.4 + 0.6 * rpmN)) - this.heat) * this.heatK;
      this.headerSpeed = HEADER_SPEED + HEADER_HEAT * this.heat;
      // The bypass valve opens with load; some gas always goes straight through the perforated core.
      const valve = Math.max(smoothstep(0.2, 0.75, load + bark) * smoothstep(this._at(1200), this._at(3000), this.rpm), x.bypassFloor + x.bypassRevs * smoothstep(this._at(2600), this._at(4200), this.rpm), boost);
      const left = this.left, right = this.right;
      left.tune(this.heat, valve); if (right) right.tune(this.heat, valve);

      // --- filters that follow the engine
      this.airbox.set(voice.intake.airboxHz + voice.intake.airboxRevs * rpmN, voice.intake.airboxQ, sr);
      this.plates.set(voice.intake.platesHz + voice.intake.platesOpen * open, 0.7, sr);
      this.whine.set(clamp((rpm / 60) * mech.whineOrder, 200, 9000), mech.whineQ, sr);
      if (fan) this.fanBp.set(rpm * fan.perRpm, fan.q, sr);
      if (this.cranking) this.starterBp.set(voice.start.starterHz * (rpm / voice.start.crankRpm), 9, sr);

      // --- targets of the ramped gains
      const inv = 1 / n;
      // A real engine idles some 25 dB below its full-load level. The game narrows that range
      // so that the idle is heard at the volume the player chose for full throttle.
      const lowRevs = 1 + lumpy.level * (1 - smoothstep(this._at(1000), this._at(3600), this.rpm)) * (1 - 0.6 * load);
      const lightLoad = 1 + 1.3 * (1 - smoothstep(0.1, 0.7, load));
      const exTarget = mix.exhaust * lowRevs * lightLoad * (1 - 0.45 * cabin);
      // The body is what the listener feels at low revs; a launch pushes it hardest.
      const bodyTarget = mix.body * (1 - 0.7 * smoothstep(this._at(3200), this._at(6500), this.rpm)) * (1 + 0.8 * load * (1 - smoothstep(this._at(1400), this._at(3000), this.rpm))) * (1 - 0.3 * cabin);
      const inTarget = mix.intake * Math.pow(open, 1.4) * (0.25 + 0.75 * rpmN) * (1 + 0.8 * cabin);
      const mechTarget = (mech.idle + mech.revs * rpmN) * (1 + 1.2 * cabin);
      const grainTarget = this.grainMakeup * (pulse.grain + pulse.grainIdle * idleness + pulse.grainLoad * load * rpmN + 0.2 * over + 0.3 * bark + 0.2 * boost);
      const hissTarget = mix.boostHiss * boost * (0.6 + 0.4 * spool), whistleTarget = mix.boostWhistle * boost * spool * (0.5 + 0.5 * rpmN);
      let exG = this.exGain, bodyG = this.bodyGain, inG = this.inGain, mechG = this.mechGain, grain = this.grain, hissG = this.hissG, whistleG = this.whistleG;
      const dEx = (exTarget - exG) * inv, dBody = (bodyTarget - bodyG) * inv, dIn = (inTarget - inG) * inv, dMech = (mechTarget - mechG) * inv;
      const dGrain = (grainTarget - grain) * inv, dHiss = (hissTarget - hissG) * inv, dWhistle = (whistleTarget - whistleG) * inv;
      // The whistle is the wheel, the rush is the pressure; the fan follows the crank; the starter dies as the engine catches.
      const turboTarget = turbo ? turbo.whistle * this.shaft * this.shaft * (1 + 0.6 * cabin) : 0, rushTarget = turbo ? turbo.rush * this.spool : 0;
      // (The blade-passing band widens with speed; the root keeps its power from growing with the bandwidth alone.)
      const fanTarget = fan ? Math.sqrt(this.idle / this.rpm) * (1 + fan.revs * rpmN) * (1 + 1.2 * cabin) : 0;
      const starterTarget = this.cranking ? voice.start.starterLevel * (1 + 0.4 * K.sin1(this.phase * voice.slots)) : this.starterG * (1 - this.starterK);
      let turboG = this.turboG, rushG = this.rushG, fanG = this.fanG, starterG = this.starterG;
      const dTurbo = (turboTarget - turboG) * inv, dRush = (rushTarget - rushG) * inv, dFan = (fanTarget - fanG) * inv, dStarter = (starterTarget - starterG) * inv;
      const blown = turboTarget > 1e-5 || turboG > 1e-5 || rushTarget > 1e-5 || rushG > 1e-5, cranked = starterTarget > 1e-5 || starterG > 1e-5;

      const tickDecay = Math.exp(-1 / (mech.tickSeconds * sr));
      const intakeSlowRate = Math.exp(-1 / (this.decaySeconds * 1.6 * sr)), intakeFastRate = Math.exp(-1 / (this.decaySeconds * 0.6 * sr));
      const slow = this.slow, fast = this.fast, slowRate = this.slowRate, fastRate = this.fastRate, wait = this.wait;
      const popSlow = this.popSlow, popFast = this.popFast;
      const nearL = panL(-x.pan), farL = panR(-x.pan);
      const cylinders = voice.cylinders, slots = voice.slots, firing = voice.firing, exhaustOf = voice.exhaustOf, reflection = voice.intake.reflection;
      const capped = mech.valveTopHz > 0;
      let phase = this.phase, tick = this.tick;

      for (let i = 0; i < n; i++) {
        phase += inc; if (phase >= 1) phase -= 1;
        const slot = (phase * slots) | 0;
        if (slot !== this.slot) { this.slot = slot; this._fire(firing[slot], (phase * slots - slot) / (inc * slots)); tick = this.tick; }
        exG += dEx; bodyG += dBody; inG += dIn; mechG += dMech; grain += dGrain; hissG += dHiss; whistleG += dWhistle;

        // Exhaust pulses, summed per exhaust system.
        let a = 0, b = 0;
        for (let c = 0; c < cylinders; c++) {
          if (wait[c] > 0 && --wait[c] === 0) { slow[c] += this.startSlow[c]; fast[c] += this.startFast[c]; }
          else { slow[c] *= slowRate[c]; fast[c] *= fastRate[c]; }
          if (exhaustOf[c] === 0) a += slow[c] - fast[c]; else b += slow[c] - fast[c];
        }
        // Turbulence exists only where gas flows: noise times the pulse, never added beside it.
        const white = noise.white();
        a *= 1 + grain * this.grainL.lp(white);
        b *= 1 + grain * this.grainR.lp(noise.white());
        popSlow[0] *= this.popSlowRate[0]; popFast[0] *= this.popFastRate[0];
        popSlow[1] *= this.popSlowRate[1]; popFast[1] *= this.popFastRate[1];
        const popA = (popSlow[0] - popFast[0]) * (1 + 1.4 * white), popB = (popSlow[1] - popFast[1]) * (1 - 1.4 * white);

        // A single system takes every pop and is heard from the middle (its pan is zero).
        const tailA = left.tick(a, right ? popA : popA + popB), tailB = right ? right.tick(b, popB) : 0;
        const body = this.bodyHp.hp(this.bodyLp.lp(left.pressure + (right ? right.pressure : 0))) * bodyG;
        let l = (tailA * nearL + tailB * farL) * exG + body;
        let r = (tailB * nearL + tailA * farL) * exG + body;
        if (this.puff.active) { const y = this.puff.next(); l += y; r += y * 0.8; }

        // Intake: suction pulses with their own turbulence into the trumpets, behind the throttle plates.
        this.intakeSlow *= intakeSlowRate; this.intakeFast *= intakeFastRate;
        const suction = (this.intakeFast - this.intakeSlow) * (1 + 0.9 * this.intakeGrain.lp(white));
        const column = suction - reflection * this.trumpetLoss.lp(this.trumpet.read(this.trumpetTrip));
        this.trumpet.write(column);
        let mono = this.intakeDc.run(this.plates.lp(column + 1.2 * this.airbox.bp(column))) * inG;

        // Nitrous: pressurised hiss and the jet whistle, from under the bonnet, so they sit in the middle.
        if (hissG > 1e-5 || whistleG > 1e-5) mono += this.hissBp.bp(white) * hissG * 2 + this.whistleBp.bp(white) * whistleG * 6;

        // Turbocharger: the wheel's whistle, the rush of charged air, the compressor's stall.
        if (blown) { turboG += dTurbo; rushG += dRush; mono += this.turboBp.bp(white) * turboG * 6 + this.rushBp.bp(white) * rushG * 2; }
        if (this.chuff.active) mono += this.chuff.next();

        // Mechanical: valves closing, and the timing gears as a narrow band of noise.
        if (this.tickWait > 0 && --this.tickWait === 0) tick = 0.4 + 0.4 * rng.float();
        tick *= tickDecay;
        let clatter = this.valveHp.hp(white) * tick;
        if (capped) clatter = this.valveTop.lp(clatter);
        mono += (clatter * mix.valveTrain + this.whine.bp(white) * mix.gearWhine) * mechG;
        // Cooling fan: the blades passing as a narrow band of noise, and the air they move.
        if (fan) { fanG += dFan; mono += (this.fanBp.bp(white) * fan.level * 6 + this.fanRush.bp(white) * fan.rush * 2) * fanG; }
        if (cranked) { starterG += dStarter; mono += this.starterBp.bp(white) * starterG * 6; }
        if (this.clunk.active) mono += this.clunk.next();

        outL[i] += l + mono; outR[i] += r + mono;
        send[i] += (l + r) * mix.send;
      }
      this.phase = phase; this.tick = tick;
      this.exGain = exTarget; this.bodyGain = bodyTarget; this.inGain = inTarget; this.mechGain = mechTarget; this.grain = grainTarget;
      this.hissG = hissTarget; this.whistleG = whistleTarget;
      this.turboG = turboTarget; this.rushG = rushTarget; this.fanG = fanTarget; this.starterG = starterTarget < 1e-5 ? 0 : starterTarget;
    }
  }
  K.Engine = Engine;
  K.ExhaustPath = ExhaustPath;
}
