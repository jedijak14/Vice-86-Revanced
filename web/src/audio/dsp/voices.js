// The engine voices: what makes one car's engine differ from another's, as data for the
// physical model in engine.js. A voice says how many cylinders there are, in which order and on
// which exhaust they fire, how long and how silenced the pipes are, how the pulse of one
// cylinder is shaped, how loud each part is, how the engine behaves at idle and on the
// overrun, how it starts, and whether it has a turbocharger or a cooling fan.
//
// The V12 is written out in full and is the base. The other voices list only what differs,
// each difference for a reason that can be heard, so the reasons are in the comments.
// Engine speeds inside a voice are never absolute: engine.js places its landmarks between the
// idle and the redline of the car that is being driven (audio.setCar).
// Packaging rules: see the header of kernel.js.

export function defineVoices(K) {
  /** A copy of `base` with `changes` laid over it, group by group. Arrays and nulls are replaced whole. */
  const derive = (base, changes) => {
    const out = {};
    const isGroup = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    for (const key of Object.keys(base)) {
      const b = base[key], c = changes[key];
      out[key] = c === undefined ? b : isGroup(b) && isGroup(c) ? derive(b, c) : c;
    }
    for (const key of Object.keys(changes)) if (!(key in base)) out[key] = changes[key];
    return out;
  };

  // ------------------------------------------------------------------ V12
  // Naturally aspirated 60 degree V12 with an exhaust per bank, heard from behind the car.
  const V12 = {
    cylinders: 12,
    /** Crank slots per cycle (two revolutions), and the cylinder whose exhaust valve opens in each (-1: none). */
    slots: 12,
    firing: [0, 6, 4, 10, 2, 8, 5, 11, 1, 7, 3, 9],      // alternates between the banks: each bank is an even-firing six
    /** Exhaust system (0 or 1) each cylinder blows into, and how many systems there are. */
    exhaustOf: [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1],
    exhausts: 2,

    // Levels of the engine's parts relative to each other.
    mix: {
      exhaust: 1.15,        // radiated tailpipe sound
      body: 0.22,           // low-passed pipe pressure: what is felt at idle and on launch
      intake: 0.11,
      valveTrain: 0.010,
      gearWhine: 0.006,
      pop: 3.2,             // overrun and limiter pops, injected into the pipe
      bang: 5.0,            // afterfire bang before scaling by strength
      clunk: 0.10,
      boostHiss: 0.08,      // nitrous
      boostWhistle: 0.25,
      puff: 0.42,
      send: 0.16,           // share of the exhaust sent to the reverb
    },

    // The pressure pulse one cylinder releases when its exhaust valve opens.
    pulse: {
      angle: 46, angleLoaded: 30,             // crank degrees of blow-down decay at speed: shorter and harder under load
      seconds: 0.0022, secondsLoaded: 0.0013, // and the gas-dynamic limit at low revs
      rise: 0.22, riseHardening: 0.16,        // front of the pulse as a share of its decay; steeper under load
      idleFiring: 0.24,                       // pulse height of an idling cylinder, full load is 1
      pumping: 0.13, pumpingRevs: 0.22,       // a cylinder that did not fire still pushes its charge out, harder at speed
      grainHz: 1400,                          // bandwidth of the blow-down turbulence
      grain: 0.22, grainIdle: 0.12, grainLoad: 0.10,   // its depth: always, more at idle, more at full load and speed
      scatter: 0.00011,                       // spread of the pulses' travel time from one firing to the next, seconds
      runner: 0.30, runnerSpread: 0.05,       // header runner length and how much the cylinders differ, metres
    },

    idle: {
      variation: 0.27,                        // cycle-to-cycle spread of the firing strength at idle
      imbalance: 0.26,                        // lasting differences between the cylinders at idle
      roughness: 0.16, roughnessIdle: 0.37,   // crank speed wander under way, and what idling adds
      stumbleEvery: 90, stumbleSpread: 220,   // firings between two weak ones
      stumbleDepth: 0.4,
      level: 1.6,                             // how far low revs are lifted so the idle is heard beside full throttle
    },

    overrun: {
      partial: 0.18,                          // chance that a cylinder catches a partial charge with the fuel cut
      pops: 0.7, popsFresh: 9,                // pops per second, and what the first second after a lift adds
    },

    // One exhaust system, valves to tailpipe. Lengths in metres.
    exhaust: {
      header: 0.62, pipe: 1.65, tail: 0.55,
      spread: 0.012,                          // the two systems differ by this much so they never coincide
      guides: [0.12, 0.19, 0.29, 0.43],       // the silencer: four short parallel guides
      valveReflection: 0.82,                  // closed valves send the wave back
      collectorStep: 0.30,                    // pressure reflection where the runners merge into the pipe
      silencerStep: -0.35,                    // and where the pipe opens into the silencer
      silencerFeedback: 0.55, silencerReturn: 0.6,
      mouthReflection: 0.88,                  // open end, inverted, low frequencies only
      valveLossHz: 3800, returnLossHz: 1800, mouthHz: 1300, guideLossHz: 3200,
      bypassFloor: 0.25, bypassRevs: 0.3,     // share of the gas that goes straight through the silencer core, and more at speed
      pan: 0.38,
      // Below radiationHz the mouth is small against the wavelength and only the rate of change of
      // the flow is heard; radiationDepth is how much of the steady part is removed.
      radiationHz: 1300, radiationDepth: 0.86, airHz: 5200,
      turbineHz: 0, turbine: 0,               // a turbine in the pipe takes the edge off every pulse (share removed above turbineHz)
    },

    body: { lowpassHz: 240, highpassHz: 38 },

    intake: {
      trumpet: 0.34,                          // metres from valve to bell mouth
      reflection: 0.62, lossHz: 2600,
      airboxHz: 340, airboxRevs: 180, airboxQ: 1.6,
      platesHz: 900, platesOpen: 3600,        // the throttle plates low-pass what gets out; opening them lets the top through
    },

    mech: {
      idle: 0.25, revs: 0.75,                 // mechanical gain at idle and what full revs add (the layer also grows by itself: more
                                              // valves close per second and the whine's band widens)
      valveHz: 3400, tickSeconds: 0.0005,
      valveTopHz: 0,                          // where the clatter ends (0: nowhere; a water jacket leaves only the hiss of it)
      whineOrder: 21, whineQ: 8,              // timing gears: a narrow band of noise at this many cycles per crank turn
    },

    // Starting from cold in the garage: the starter turns the engine, it catches, flares and settles.
    start: {
      crankSeconds: 0.85, crankRpm: 260,      // a geared starter spins twelve small cylinders fast
      starterHz: 740, starterLevel: 0.09,
      flareRpm: 2300, flareSeconds: 0.5, settleSeconds: 0.9,
    },

    turbo: null,
    fan: null,
  };

  // ------------------------------------------------------------------ flat-twelve
  // Twelve cylinders laid flat, four valves each, a short exhaust per bank ending close behind
  // the engine. Fires like the V12 (even, alternating banks), so the pitch is the same; what
  // differs is everything that colours it.
  const FLAT12 = derive(V12, {
    firing: [0, 8, 4, 11, 2, 7, 5, 9, 1, 6, 3, 10],
    pulse: {
      angle: 40, angleLoaded: 24, seconds: 0.0018, secondsLoaded: 0.0010,   // small ports, high lift: a short hard pulse, the rip in the sound
      rise: 0.18, riseHardening: 0.14,
      grainHz: 2100, grain: 0.18, grainLoad: 0.30,                          // brighter tearing, most of it under load
      runner: 0.42, runnerSpread: 0.02,                                     // equal-length headers: a clean, pitched howl
    },
    idle: { variation: 0.2, imbalance: 0.18, level: 1.7 },                  // injected and smooth at idle
    overrun: { partial: 0.12, pops: 0.5, popsFresh: 5 },
    exhaust: {
      header: 0.50, pipe: 0.90, tail: 0.38,                                 // short system: its resonances sit above the firing line right to the redline
      guides: [0.07, 0.11, 0.17, 0.26],                                     // small silencers that take little away
      valveReflection: 0.86, collectorStep: 0.36, mouthReflection: 0.93,    // hard, ringing pipes: the metallic edge
      silencerFeedback: 0.45, returnLossHz: 2600, mouthHz: 1900, guideLossHz: 4600,
      bypassFloor: 0.42, bypassRevs: 0.45,                                  // little silencing to bypass: the note rises without a step
      radiationHz: 1450, radiationDepth: 0.90, airHz: 7400,                 // less bass leaves the pipes, more top reaches the ear
      pan: 0.42,
    },
    mix: { exhaust: 1.0, body: 0.10, intake: 0.09, valveTrain: 0.35, gearWhine: 0.12, pop: 2.4 },     // 48 valves and toothed belts are heard
    body: { lowpassHz: 210, highpassHz: 48 },
    mech: { idle: 1.0, revs: -0.2, valveHz: 2600, valveTopHz: 6500, whineOrder: 26 },
    start: { crankSeconds: 0.9, crankRpm: 240, starterHz: 690, flareRpm: 2100 },
  });

  // ------------------------------------------------------------------ turbocharged air-cooled flat-six
  // Six big air-cooled cylinders, one turbocharger, one short exhaust behind the rear axle.
  // Three firings per turn: half the pitch of the twelves. The turbine swallows the edge of
  // every pulse; a belt-driven axial fan and the timing chain are heard over the idle.
  const FLAT6T = derive(V12, {
    cylinders: 6, slots: 6,
    firing: [0, 5, 1, 3, 2, 4],
    exhaustOf: [0, 0, 0, 0, 0, 0],
    exhausts: 1,
    pulse: {
      angle: 54, angleLoaded: 38, seconds: 0.0030, secondsLoaded: 0.0019,   // 550 cc cylinders with two valves: a long, round pulse
      idleFiring: 0.22,
      grainHz: 1100, grain: 0.3, grainIdle: 0.16, grainLoad: 0.12,          // a dry, breathy bark
      runner: 0.36, runnerSpread: 0.16,                                     // unequal runners: the pulses do not line up, hence the hollow note
      scatter: 0.00016,
    },
    idle: { variation: 0.3, imbalance: 0.34, roughnessIdle: 0.5, stumbleEvery: 50, stumbleSpread: 120, level: 0.6 },
    overrun: { partial: 0.08, pops: 0.15, popsFresh: 1.6 },                 // the turbine swallows most of the crackle
    exhaust: {
      header: 0.58, pipe: 0.85, tail: 0.30,                                 // rear engine: the whole system is under the bumper
      guides: [0.10, 0.16, 0.25, 0.37],
      collectorStep: 0.42,                                                  // the turbine housing reflects more than an open collector
      silencerFeedback: 0.62, mouthReflection: 0.92, mouthHz: 900,          // a strong low pipe resonance: hollow
      bypassFloor: 0.45, bypassRevs: 0.2,
      radiationHz: 900, radiationDepth: 0.90, airHz: 3900,
      turbineHz: 950, turbine: 0.72,
      pan: 0,
    },
    mix: { exhaust: 1.1, body: 0.14, intake: 0.05, valveTrain: 0.45, gearWhine: 0.45, pop: 2.2, send: 0.11 },      // no water jacket: the valve gear rattles through the fins
    body: { lowpassHz: 200, highpassHz: 34 },
    intake: { trumpet: 0.5, airboxHz: 260, airboxRevs: 120 },               // the compressor sits in front of the plenum: little induction roar
    mech: { idle: 0.8, revs: -0.35, valveHz: 1800, valveTopHz: 5200, whineOrder: 34, whineQ: 12 },   // chain sprockets and the oil pump drive; they sink into the exhaust at speed
    start: { crankSeconds: 0.7, crankRpm: 300, starterHz: 830, starterLevel: 0.085, flareRpm: 1900, flareSeconds: 0.45 },
    turbo: {
      from: 2600, full: 4400,               // boost builds between these (as V12 landmarks, see engine.js) when the physics sends none
      rise: 0.7, fall: 0.15,                // seconds of lag up and down, for the same case
      freewheel: 0.22,                      // share of full shaft speed that exhaust flow alone keeps up at the redline
      coast: 0.9,                           // seconds the wheel takes to run down after the pressure has gone
      whistleHz: 1800, whistleSpan: 3400, whistleQ: 22, whistle: 0.05,
      rushHz: 2600, rush: 0.05,             // compressed air in the pipework
      charge: 0.4,                          // how much harder the cylinders fire at full boost
      chuffAbove: 0.3,                      // boost at the lift needed for the compressor to stall audibly
      chuffHz: 1150, chuffQ: 1.3, chuffSeconds: 0.45, chuff: 2.0, flutterHz: 17,   // no blow-off valve: the air beats back through the wheel
    },
    fan: { perRpm: 0.33, q: 7, level: 0.07, rushHz: 1300, rush: 0.035, revs: 1.2 },   // eleven blades at 1.8 times crank speed; `revs`: what full revs add
  });

  // ------------------------------------------------------------------ cross-plane pushrod V8
  // Eight big cylinders firing evenly as a whole but unevenly on each bank (left bank: 270,
  // 180, 90, 180 degrees apart), each bank into its own long exhaust that never meets the
  // other. That uneven beat per pipe is the burble; the long pipes and long pulses are the depth.
  const V8 = derive(V12, {
    cylinders: 8, slots: 8,
    firing: [0, 7, 5, 1, 6, 2, 3, 4],
    exhaustOf: [0, 0, 0, 0, 1, 1, 1, 1],
    pulse: {
      angle: 62, angleLoaded: 44, seconds: 0.0038, secondsLoaded: 0.0024,   // 700 cc cylinders, two valves, a lazy cam: long heavy pulses
      rise: 0.26, riseHardening: 0.16,
      idleFiring: 0.34,
      grainHz: 900, grain: 0.28, grainIdle: 0.2, grainLoad: 0.14,
      runner: 0.24, runnerSpread: 0.14,                                     // cast log manifolds: every runner a different length
      scatter: 0.00018,
    },
    idle: {
      variation: 0.5, imbalance: 0.42,                                      // a long-overlap cam idles unevenly: the lope
      roughness: 0.2, roughnessIdle: 1.1,
      stumbleEvery: 14, stumbleSpread: 30, stumbleDepth: 0.3,
      level: 0.72,
    },
    overrun: { partial: 0.4, pops: 1.6, popsFresh: 5 },                     // a carburettor never cuts the fuel: it burbles all the way down
    exhaust: {
      header: 0.42, pipe: 2.7, tail: 0.75,                                  // front engine: the pipes run the length of the car
      guides: [0.21, 0.33, 0.48, 0.66],                                     // big chambered silencers
      valveReflection: 0.8, collectorStep: 0.26, silencerFeedback: 0.6,
      mouthReflection: 0.9, mouthHz: 800, returnLossHz: 1300, guideLossHz: 2200, valveLossHz: 2600,
      bypassFloor: 0.35, bypassRevs: 0.25,
      radiationHz: 700, radiationDepth: 0.78, airHz: 3000,                  // wide pipes radiate their bass
      pan: 0.55,                                                            // true duals, one at each corner
    },
    mix: { exhaust: 1.05, body: 0.36, intake: 0.13, valveTrain: 0.32, gearWhine: 0.0, pop: 2.4, send: 0.18 },
    body: { lowpassHz: 170, highpassHz: 26 },
    intake: { trumpet: 0.22, airboxHz: 210, airboxRevs: 110, airboxQ: 2.2, platesHz: 700, platesOpen: 2600 },   // one big throttle body on a plenum: a low moan
    mech: { idle: 0.6, revs: 0.1, valveHz: 1900, valveTopHz: 5000, tickSeconds: 0.0008 },   // pushrods and rockers tick
    start: { crankSeconds: 0.95, crankRpm: 170, starterHz: 430, starterLevel: 0.12, flareRpm: 1700, flareSeconds: 0.45, settleSeconds: 0.8 },   // a slow, heavy churn
  });

  /** Voices by code. The page sends the code in the state vector (K.P.VOICE). */
  K.VOICES = [V12, FLAT12, FLAT6T, V8];
  K.VOICE_NAMES = Object.freeze(['v12', 'flat12', 'flat6t', 'v8']);
  /** Voice code from the id in the car registry. An unknown id plays the V12. */
  K.voiceCode = (name) => { const i = K.VOICE_NAMES.indexOf(name); return i < 0 ? 0 : i; };
}
