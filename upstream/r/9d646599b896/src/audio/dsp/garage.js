// The garage: what the room sounds like while the player chooses a car, and the roller door
// that lets them out. Room tone is the neon transformers (mains hum and the fizz of the tubes),
// the ventilation, and nothing else: the city behind the door is the ordinary ambience, muffled
// by the synth. The door is an electric motor and its gearbox, the curtain of steel slats
// rattling up its guides, a relay at the start and a clunk at the top.
// Packaging rules: see the header of kernel.js.

export function defineGarage(K) {
  const { Rng, Pink, Svf, Wander, Ramp, Burst, sin1, coef } = K;

  const MAINS_HZ = 60;             // the game is set in Florida
  const DOOR_SECONDS = 3.2;        // travel of the door from the floor to fully raised, as the picture shows it
  const SLATS_PER_SECOND = 9;      // slats that pass the guide rollers at full motor speed

  const MIX = {
    hum: 0.017, fizz: 0.030,       // transformers and tubes
    vent: 0.070, ventFan: 0.012,   // air in the duct, and the extractor's blades
    motor: 0.020, gear: 0.065, rumble: 0.16,
    slat: 0.28, thump: 0.17, relay: 0.30, stop: 0.42,
    send: 0.5,                     // share of the door sent to the room reverb
  };

  // ================================================================== room tone
  /** Two neon transformers a few metres apart, their tubes, and a ventilation duct. */
  class RoomTone {
    constructor(sr, seed) {
      this.sr = sr; this.phase = 0;
      this.noiseL = new Rng(seed); this.noiseR = new Rng(seed + 1);
      this.fizzL = new Svf().set(3400, 0.8, sr); this.fizzR = new Svf().set(4300, 0.8, sr);
      // One tube is on its way out: it drops for a few tens of milliseconds now and then.
      this.flicker = new Wander(seed + 2, 7, 0, 1);
      this.airL = new Pink(seed + 3); this.airR = new Pink(seed + 4);
      this.ductL = new Svf().set(430, 0.6, sr); this.ductR = new Svf().set(390, 0.6, sr);
      this.boom = new Svf().set(138, 3.2, sr);                 // the duct's own resonance
      this.fan = new Svf().set(87, 14, sr);                    // three blades at 1740 rpm
      this.draught = new Wander(seed + 5, Math.round(1.4 * sr / K.CHUNK), 0.8, 1.15);
      this.gain = new Ramp();
    }

    render(level, outL, outR, n) {
      if (this.gain.silent(level)) return;
      this.gain.aim(level, n);
      const inc = MAINS_HZ / this.sr, dip = this.flicker.tick() < 0.05 ? 0.3 : 1, air = MIX.vent * this.draught.tick();
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        const p = this.phase, g = this.gain.next();
        // Magnetostriction hums at twice the mains frequency and its multiples; the two
        // transformers are heard with different phases, which gives the hum its width.
        const humL = 0.2 * sin1(p) + sin1(2 * p) + 0.45 * sin1(3 * p + 0.2) + 0.5 * sin1(4 * p + 0.4) + 0.3 * sin1(6 * p + 0.1) + 0.14 * sin1(8 * p);
        const humR = 0.2 * sin1(p + 0.3) + sin1(2 * p + 0.55) + 0.3 * sin1(3 * p) + 0.6 * sin1(4 * p + 0.15) + 0.22 * sin1(6 * p + 0.6) + 0.18 * sin1(8 * p + 0.3);
        // The discharge strikes twice per mains cycle: the fizz exists only around the peaks.
        const arc = sin1(p), strike = arc * arc * arc * arc;
        const fizzL = this.fizzL.hp(this.noiseL.white()) * strike * dip, fizzR = this.fizzR.hp(this.noiseR.white()) * strike;
        const a = this.airL.next(), b = this.airR.next();
        const duct = this.boom.bp(a + b) * 0.6 + this.fan.bp(a - b) * (MIX.ventFan / MIX.vent) * 8;
        outL[i] += (humL * MIX.hum + fizzL * MIX.fizz + (this.ductL.lp(a) + duct) * air) * g;
        outR[i] += (humR * MIX.hum + fizzR * MIX.fizz + (this.ductR.lp(b) + duct) * air) * g;
      }
    }
  }

  // ================================================================== roller door
  /** An electric roller door going up: relay, motor, gearbox, slats over the guide rollers, the stop. */
  class RollerDoor {
    constructor(sr, seed) {
      this.sr = sr; this.rng = new Rng(seed); this.noise = new Rng(seed + 1); this.pink = new Pink(seed + 2);
      /** How far the door is up, 0..1. The synth lets the city in with it. */
      this.raised = 0;
      this.running = false; this.speed = 0; this.speedK = coef(0.16, sr / K.CHUNK);
      this.phase = 0; this.slatIn = 0; this.side = 0;
      this.gear = new Svf(); this.gearHigh = new Svf(); this.curtain = new Svf().set(230, 0.9, sr);
      this.clackL = new Burst(seed + 3); this.clackR = new Burst(seed + 4); this.thump = new Burst(seed + 5); this.relay = new Burst(seed + 6);
      this.gain = new Ramp();
    }

    /** Starts the door on its way up from the floor. */
    open() {
      this.raised = 0; this.running = true; this.slatIn = 0.12;
      this.relay.start(2300, 1.3, 0.03, MIX.relay, this.sr, 0, 0.0005);
    }

    /** Puts the door back on the floor without a sound (the scene was entered again). */
    close() { this.raised = 0; this.running = false; this.speed = 0; }

    get active() { return this.running || this.speed > 1e-3 || this.thump.active || this.relay.active || this.clackL.active || this.clackR.active; }

    /** Once per chunk: motor speed, travel, the next slat, the stop at the top. */
    _advance(seconds) {
      const sr = this.sr, r = this.rng;
      this.speed += ((this.running ? 1 : 0) - this.speed) * this.speedK;
      if (!this.running) return;
      this.raised += (seconds / DOOR_SECONDS) * this.speed;
      this.slatIn -= seconds * this.speed;
      if (this.slatIn <= 0) {
        // Each slat knocks as its hinge rolls over the guide, left and right in turn, never twice alike.
        this.slatIn = (1 / SLATS_PER_SECOND) * r.range(0.86, 1.14);
        const clack = this.side ? this.clackR : this.clackL; this.side = 1 - this.side;
        clack.start(r.range(1500, 2700), 2.6, r.range(0.035, 0.06), MIX.slat * r.range(0.55, 1), sr, 0, 0.0006);
        this.thump.start(r.range(150, 210), 1.4, 0.05, MIX.thump * r.range(0.5, 1), sr, 0, 0.002);
      }
      if (this.raised >= 1) {
        this.raised = 1; this.running = false;
        this.thump.start(120, 1.2, 0.16, MIX.stop, sr, 0, 0.002);
      }
    }

    render(level, outL, outR, send, n) {
      if (!this.active || this.gain.silent(level)) { this.gain.v = level; return; }
      const sr = this.sr;
      this._advance(n / sr);
      this.gain.aim(level, n);
      const speed = this.speed, inc = MAINS_HZ / sr;
      // The gearbox sings at the motor's speed; under the weight of the curtain it never quite holds it.
      const gearHz = 610 * speed * (1 + 0.012 * sin1(this.phase * 7));
      this.gear.set(gearHz, 11, sr); this.gearHigh.set(gearHz * 2.37, 9, sr);
      const motor = MIX.motor * speed, gear = MIX.gear * speed * speed, rumble = MIX.rumble * speed;
      for (let i = 0; i < n; i++) {
        this.phase += inc; if (this.phase >= 1) this.phase -= 1;
        const p = this.phase, g = this.gain.next(), white = this.noise.white();
        // An induction motor under load: twice mains and a stack of harmonics, harsher than a transformer.
        const hum = sin1(2 * p) + 0.7 * sin1(4 * p + 0.2) + 0.55 * sin1(6 * p + 0.5) + 0.4 * sin1(8 * p + 0.1) + 0.3 * sin1(10 * p + 0.7) + 0.2 * sin1(14 * p);
        let mid = hum * motor + (this.gear.bp(white) * 6 + this.gearHigh.bp(white) * 2.5) * gear + this.curtain.bp(this.pink.next()) * rumble;
        if (this.relay.active) mid += this.relay.next();
        if (this.thump.active) mid += this.thump.next();
        const left = this.clackL.active ? this.clackL.next() : 0, right = this.clackR.active ? this.clackR.next() : 0;
        const l = (mid + left + 0.3 * right) * g, r = (mid + right + 0.3 * left) * g;
        outL[i] += l; outR[i] += r; send[i] += (l + r) * MIX.send;
      }
    }
  }

  /** The garage as the synth uses it: room tone and door under one level. */
  class Garage {
    constructor(sr, seed) { this.tone = new RoomTone(sr, seed); this.door = new RollerDoor(sr, seed + 10); }
    openDoor() { this.door.open(); }
    closeDoor() { this.door.close(); }
    /** How far the door is up, 0..1. */
    get doorRaised() { return this.door.raised; }
    /** @param level 0..1: how much the listener is in the room */
    render(level, outL, outR, send, n) {
      this.tone.render(level, outL, outR, n);
      this.door.render(level, outL, outR, send, n);
    }
  }
  K.Garage = Garage;
  K.RollerDoor = RollerDoor;
  K.RoomTone = RoomTone;
  K.GARAGE_DOOR_SECONDS = DOOR_SECONDS;
}
