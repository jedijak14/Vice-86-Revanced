// The whole synth: owns every sound source, mixes them on buses, applies the city reverb,
// volume, pause fades, glue compression and the limiter, and hands back stereo blocks. It also
// decides which engine is heard (the voice of the car in hand, none while the player browses
// the garage) and moves the listener between the street and the garage. It runs the same way
// inside an AudioWorkletProcessor, a ScriptProcessorNode and the Node test harness. Audio is
// rendered in control chunks of at most K.CHUNK frames regardless of the host block size, so
// control smoothing does not depend on the host.
// Packaging rules: see the header of kernel.js.

export function defineSynth(K) {
  const { CHUNK, P, EV, GARAGE, Ramp, OnePole, coef, clamp } = K;

  // Fields of the state vector that are copied as they are instead of smoothed.
  const DISCRETE = new Set([P.GEAR, P.SURFACE, P.AIRBORNE, P.DISTRICT, P.PAUSED, P.VOICE, P.IDLE, P.LIMITER, P.TURBO, P.GARAGE]);
  for (let v = 0; v < P.TRAFFIC_VOICES; v++) {
    const o = P.TRAFFIC + v * P.TRAFFIC_STRIDE;
    DISCRETE.add(o + 4); DISCRETE.add(o + 7);                  // kind, serial
  }

  const PAUSE_FADE = 0.3;          // seconds for the car and the world to fade out or back in
  const PAUSED_AMBIENCE = 0.25;    // the city stays faintly audible behind the pause menu

  const SWAP_SECONDS = 0.3;        // one engine fades out while the next fades in
  // The garage. Walls close around the listener in ROOM_IN seconds and let go in ROOM_OUT.
  const ROOM_IN = 0.6, ROOM_OUT = 0.4;
  const ROOM_WET = 0.5;            // a small hard room answers louder than the street
  const CITY_BEHIND_DOOR = 0.3, CITY_THROUGH_DOORWAY = 0.75;   // level of the city with the door shut and fully raised
  const DOOR_MUFFLE_HZ = 380;      // what sheet steel lets through
  const DOORWAY_CLEARS = 0.7;      // share of the muffling that a fully raised door removes

  /** Adds `src` to `dst` under a gain that runs linearly from `from` to `to` across the chunk. */
  const addFaded = (src, dst, n, from, to) => {
    const step = (to - from) / n;
    let g = from;
    for (let i = 0; i < n; i++) { g += step; dst[i] += src[i] * g; }
  };

  class ViceSynth {
    /**
     * @param {number} sr           sample rate
     * @param {number} seed         session seed for the noise generators
     */
    constructor(sr, seed = 1) {
      this.sr = sr; this.seed = seed | 0;
      this.state = new Float32Array(P.SIZE);                 // last values received from the page
      this.ctl = new Float32Array(P.SIZE);                    // smoothed values the sources read
      this.state[P.REDLINE] = this.ctl[P.REDLINE] = 7500; this.state[P.RPM] = this.ctl[P.RPM] = 1000;
      this.state[P.NEON] = this.ctl[P.NEON] = -1; this.state[P.HOUR] = this.ctl[P.HOUR] = 14;
      this.state[P.EFFECTS] = 1; this.ctl[P.EFFECTS] = 0;
      this.smooth = coef(0.02, sr / CHUNK);
      this.volumeSmooth = coef(0.08, sr / CHUNK);
      this.state[P.TURBO] = this.ctl[P.TURBO] = -1;
      // The engine is rebuilt on every car change. A change is rare and happens at rest; a new
      // engine with clean pipes is simpler and safer than making every part of a running one
      // resettable. Nothing is heard of it until the first state has said which car it is.
      this.engine = new K.Engine(sr, this.seed + 11);
      this.outgoing = null; this.handover = 1; this.fadeIn = false; this.gotState = false; this.engineHeard = false;
      this.road = new K.Road(sr, this.seed + 23);
      this.rain = new K.Rain(sr, this.seed + 31);
      this.thunder = new K.Thunder(sr, this.seed + 37);
      this.impacts = new K.Impacts(sr, this.seed + 41);
      this.horn = new K.Horn(sr);
      this.traffic = new K.Traffic(sr, this.seed + 43);
      this.ui = new K.Ui(sr);
      this.ambience = new K.Ambience(sr, this.seed + 53);
      this.cityReverb = new K.Reverb(sr, 1.0, 1.7, 4200, 0.012);
      this.garage = new K.Garage(sr, this.seed + 61);
      this.roomReverb = new K.Reverb(sr, 0.42, 0.9, 5200, 0.004);
      this.where = GARAGE.STREET;
      /** How far the listener is inside the garage, 0..1. */
      this.indoors = 0;
      this.doorL = new OnePole().set(DOOR_MUFFLE_HZ, sr); this.doorR = new OnePole().set(DOOR_MUFFLE_HZ, sr);
      this.glue = new K.Compressor(sr, -14, 2.5, 0.012, 0.22, 10, 1.5);
      this.limiter = new K.Limiter(sr, 0.89, 0.0015, 0.09);
      this.effL = new Float32Array(CHUNK); this.effR = new Float32Array(CHUNK);
      this.ambL = new Float32Array(CHUNK); this.ambR = new Float32Array(CHUNK);
      this.uiL = new Float32Array(CHUNK); this.uiR = new Float32Array(CHUNK);
      this.send = new Float32Array(CHUNK);
      this.auxL = new Float32Array(CHUNK); this.auxR = new Float32Array(CHUNK); this.auxSend = new Float32Array(CHUNK);
      this.mixL = new Float32Array(CHUNK); this.mixR = new Float32Array(CHUNK);
      // Pause: car, road, traffic and world fade out; ambience drops; the menu sounds continue.
      this.pauseGain = new Ramp(1); this.ambPauseGain = new Ramp(1);
      this.sinceState = 0; this.frames = 0;
      /** Diagnostics for the tests and the page: last block peak, limiter gain and compression. */
      this.stats = { peak: 0, limiterGain: 1, compression: 0 };
    }

    /** Receives the page's state vector (any length up to P.SIZE). */
    setState(values) {
      const n = Math.min(values.length, P.SIZE);
      for (let i = 0; i < n; i++) this.state[i] = values[i];
      this.sinceState = 0; this.gotState = true;
    }

    /** One-shot event as sent by the page. */
    event(code, a = 0, b = 0, c = 0, d = 0) {
      switch (code) {
        case EV.IMPACT: this.impacts.hit(a, b, c, d); break;
        case EV.HORN: this.horn.set(a > 0.5); break;
        case EV.THUNDER: this.thunder.strike(a); break;
        case EV.UI: this.ui.play(a); break;
        case EV.AFTERFIRE: if (this.engine) this.engine.afterfire(a); break;
        default: break;
      }
    }

    /** Smooths the state vector into the control vector once per chunk. */
    _control() {
      const s = this.state, c = this.ctl, k = this.smooth, vk = this.volumeSmooth;
      for (let i = 0; i < P.SIZE; i++) {
        if (DISCRETE.has(i)) { c[i] = s[i]; continue; }
        const rate = i === P.EFFECTS ? vk : k;
        c[i] += (s[i] - c[i]) * rate;
      }
    }

    /** The listener has moved between the street, the garage and the garage with Drive pressed. */
    _moveTo(where) {
      if (where === GARAGE.BROWSING) {
        this.garage.closeDoor();
        if (this.indoors <= 0) this.roomReverb.clear();         // no echo of the last visit
      } else if (where === GARAGE.LEAVING && this.where === GARAGE.BROWSING) this.garage.openDoor();
      this.where = where;
    }

    /**
     * Makes the engine that should be heard the current one: none while the player browses the
     * garage, else the voice of the car in hand. The one it replaces fades out as `outgoing`.
     */
    _handOver(c) {
      if (this.outgoing || !this.gotState) return;              // one change at a time, and none before the game has named the car
      const voice = this.where === GARAGE.BROWSING ? null : K.VOICES[clamp(c[P.VOICE] | 0, 0, K.VOICES.length - 1)];
      const current = this.engine ? this.engine.voice : null;
      if (voice === current) return;
      // An engine nobody has heard yet is simply replaced; one that is playing fades out.
      this.outgoing = this.engineHeard ? this.engine : null; this.handover = this.engineHeard ? 0 : 1;
      this.engine = voice ? new K.Engine(this.sr, this.seed + 11, voice) : null;
      // An engine on its starter begins in silence by itself; any other fades in.
      this.fadeIn = this.where !== GARAGE.LEAVING;
      if (this.engine && !this.fadeIn) this.engine.start();
    }

    /** Renders the engine, or the two engines of a handover under an equal-power crossfade. */
    _renderEngine(c, n) {
      const effL = this.effL, effR = this.effR, send = this.send;
      if (!this.gotState) return;
      if (this.engine) this.engineHeard = true;
      if (this.handover >= 1) { if (this.engine) this.engine.render(c, effL, effR, send, n); return; }
      const auxL = this.auxL, auxR = this.auxR, auxSend = this.auxSend;
      const from = this.handover, to = Math.min(1, from + n / (SWAP_SECONDS * this.sr)), quarter = Math.PI / 2;
      if (this.outgoing) {
        auxL.fill(0, 0, n); auxR.fill(0, 0, n); auxSend.fill(0, 0, n);
        this.outgoing.render(c, auxL, auxR, auxSend, n);
        const g0 = Math.cos(from * quarter), g1 = Math.cos(to * quarter);
        addFaded(auxL, effL, n, g0, g1); addFaded(auxR, effR, n, g0, g1); addFaded(auxSend, send, n, g0, g1);
      }
      if (this.engine) {
        auxL.fill(0, 0, n); auxR.fill(0, 0, n); auxSend.fill(0, 0, n);
        this.engine.render(c, auxL, auxR, auxSend, n);
        const g0 = this.fadeIn ? Math.sin(from * quarter) : 1, g1 = this.fadeIn ? Math.sin(to * quarter) : 1;
        addFaded(auxL, effL, n, g0, g1); addFaded(auxR, effR, n, g0, g1); addFaded(auxSend, send, n, g0, g1);
      }
      this.handover = to;
      if (to >= 1) this.outgoing = null;
    }

    /** Road, traffic, rain and horn: everything of the street that the pause silences. */
    _renderStreet(c, outL, outR, send, n) {
      this.road.render(c, outL, outR, send, n);
      this.traffic.render(c, outL, outR, send, n);
      this.rain.render(c, outL, outR, n);
      this.horn.render(outL, outR, send, n);
    }

    /** The city heard from inside the garage: quieter and dull behind the door, clearer as it rises. */
    _muffleCity(ambL, ambR, n, indoors) {
      const raised = this.garage.doorRaised;
      const level = 1 + (CITY_BEHIND_DOOR + (CITY_THROUGH_DOORWAY - CITY_BEHIND_DOOR) * raised - 1) * indoors;
      const dull = indoors * (1 - DOORWAY_CLEARS * raised);
      for (let i = 0; i < n; i++) {
        const l = ambL[i], r = ambR[i];
        ambL[i] = (l + (this.doorL.lp(l) - l) * dull) * level;
        ambR[i] = (r + (this.doorR.lp(r) - r) * dull) * level;
      }
    }

    /**
     * Renders `frames` stereo frames into outL/outR (overwrites). Also accepts frames larger
     * than K.CHUNK; the work is split into chunks internally.
     */
    process(outL, outR, frames) {
      const sr = this.sr;
      let peak = 0;
      for (let at = 0; at < frames; at += CHUNK) {
        const n = Math.min(CHUNK, frames - at);
        this.sinceState += n / sr; this.frames += n;
        this._control();
        const c = this.ctl;
        const paused = c[P.PAUSED] > 0.5 || this.sinceState > 0.3;
        this.pauseGain.slew(paused ? 0 : 1, n, PAUSE_FADE * sr);
        this.ambPauseGain.slew(paused ? PAUSED_AMBIENCE : 1, n, PAUSE_FADE * sr);

        const effL = this.effL, effR = this.effR, ambL = this.ambL, ambR = this.ambR;
        const uiL = this.uiL, uiR = this.uiR, send = this.send;
        effL.fill(0, 0, n); effR.fill(0, 0, n); ambL.fill(0, 0, n); ambR.fill(0, 0, n);
        uiL.fill(0, 0, n); uiR.fill(0, 0, n); send.fill(0, 0, n);

        if (c[P.GARAGE] !== this.where) this._moveTo(c[P.GARAGE]);
        this._handOver(c);
        const wasIndoors = this.indoors, inGarage = this.where !== GARAGE.STREET;
        const indoors = inGarage ? Math.min(1, wasIndoors + n / (ROOM_IN * sr)) : Math.max(0, wasIndoors - n / (ROOM_OUT * sr));
        this.indoors = indoors;
        const inside = wasIndoors > 0 || indoors > 0;

        const effects = c[P.EFFECTS];
        if (effects > 1e-4) {
          if (this.pauseGain.v > 1e-4 || !paused) {
            this._renderEngine(c, n);
            if (!inside) this._renderStreet(c, effL, effR, send, n);
            else if (indoors < 1 || wasIndoors < 1) {
              // The street falls away as the walls close in. The engine does not: it is in the room.
              const auxL = this.auxL, auxR = this.auxR, auxSend = this.auxSend;
              auxL.fill(0, 0, n); auxR.fill(0, 0, n); auxSend.fill(0, 0, n);
              this._renderStreet(c, auxL, auxR, auxSend, n);
              addFaded(auxL, effL, n, 1 - wasIndoors, 1 - indoors); addFaded(auxR, effR, n, 1 - wasIndoors, 1 - indoors);
              addFaded(auxSend, send, n, 1 - wasIndoors, 1 - indoors);
            }
          }
          this.thunder.render(effL, effR, send, n);
          this.impacts.render(effL, effR, send, n);
          this.ambience.render(c, ambL, ambR, send, n);
          if (inside) {
            this._muffleCity(ambL, ambR, n, indoors);
            this.garage.render(indoors, ambL, ambR, send, n);
          }
          this.ui.render(uiL, uiR, n);
        }
        // Reverb is shared by everything outdoors; its return joins the effects bus. Indoors the room answers instead.
        this.cityReverb.process(send, null, effL, effR, n, 0.35 * effects * (1 - indoors));
        if (inside) this.roomReverb.process(send, null, effL, effR, n, ROOM_WET * effects * indoors);

        const mixL = this.mixL, mixR = this.mixR;
        for (let i = 0; i < n; i++) {
          const pg = this.pauseGain.next() * effects, ag = this.ambPauseGain.next() * effects;
          mixL[i] = effL[i] * pg + ambL[i] * ag + uiL[i] * effects;
          mixR[i] = effR[i] * pg + ambR[i] * ag + uiR[i] * effects;
        }
        this.glue.process(mixL, mixR, n);
        this.limiter.process(mixL, mixR, n);
        for (let i = 0; i < n; i++) {
          const l = mixL[i], r = mixR[i];
          outL[at + i] = l; outR[at + i] = r;
          const a = Math.abs(l), b = Math.abs(r);
          if (a > peak) peak = a; if (b > peak) peak = b;
        }
      }
      const st = this.stats;
      st.peak = peak; st.limiterGain = this.limiter.minGain; st.compression = this.glue.reduction;
    }
  }
  K.ViceSynth = ViceSynth;
}
