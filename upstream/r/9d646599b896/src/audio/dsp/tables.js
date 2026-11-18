// Shared layout of the control state and the code tables that the page and the synth agree on.
// The page fills one Float32Array per frame (indices in K.P) and sends it to the synth; discrete
// things (surface, district, kinds) travel as the small integer codes defined here.
// Packaging rules: see the header of kernel.js.

export function defineTables(K) {
  /** Index of each control in the frame state vector. */
  K.P = Object.freeze({
    RPM: 0, REDLINE: 1, THROTTLE: 2, LOAD: 3, GEAR: 4, SPEED: 5, SLIP: 6, SLIP_ANGLE: 7, BRAKE: 8,
    SURFACE: 9, AIRBORNE: 10, WET: 11, CABIN: 12,
    RAIN: 13, WIND: 14, NIGHT: 15, OCEAN: 16, CITY: 17, COVER: 18, HOUR: 19, DISTRICT: 20, NEON: 21,
    EFFECTS: 22, PAUSED: 23, BOOST: 24,
    // The car in hand (audio.setCar): voice code (K.VOICE_NAMES), idle and limiter speed in rpm,
    // and its turbocharger's boost 0..1 (negative: the physics reports none, the engine derives it).
    VOICE: 25, IDLE: 26, LIMITER: 27, TURBO: 28,
    GARAGE: 29,      // K.GARAGE: where the listener is
    // Traffic voices: TRAFFIC_VOICES records of TRAFFIC_STRIDE floats starting at TRAFFIC:
    // [gain 0..1 (0 = slot free), pan -1..1, doppler ratio, speed m/s, kind code, throttle, distance m, serial]
    TRAFFIC: 32, TRAFFIC_STRIDE: 8, TRAFFIC_VOICES: 6,
    SIZE: 80,
  });

  /** One-shot events sent to the synth as [code, a, b, c, d]. */
  K.EV = Object.freeze({
    IMPACT: 1,       // a strength 0..1, b pan, c distance m, d impact kind code
    HORN: 2,         // a 1 on / 0 off
    THUNDER: 3,      // a distance m
    UI: 4,           // a ui kind code
    AFTERFIRE: 5,    // a strength 0..1
  });

  /** P.GARAGE. STREET: outdoors as ever. BROWSING: in the garage, engine off. LEAVING: Drive pressed, engine starting, door rising. */
  K.GARAGE = Object.freeze({ STREET: 0, BROWSING: 1, LEAVING: 2 });

  K.SURFACE = Object.freeze({ ASPHALT: 0, CONCRETE: 1, SAND: 2, GRASS: 3, DECK: 4, KERB: 5, WATER: 6, COUNT: 7 });
  const surfaceNames = {
    asphalt: 0, road: 0, junction: 0, tarmac: 0,
    concrete: 1, pavement: 1, sidewalk: 1, lot: 1, median: 1, pavers: 1,
    sand: 2, beach: 2, dirt: 2,
    grass: 3, park: 3,
    deck: 4, bridge: 4,
    kerb: 5, curb: 5,
    water: 6,
  };
  // Physics surface ids (src/physics/specs.js KIND): 0 asphalt, 1 concrete, 2 sand, 3 grass, 7 water.
  const surfaceOfPhysicsKind = [0, 1, 2, 3, 0, 0, 0, 6, 0, 0];
  /** Surface code from the string the game passes, or from a physics KIND number. Unknown drives like asphalt. */
  K.surfaceCode = (surface) => {
    if (typeof surface === 'number') return surfaceOfPhysicsKind[surface] || 0;
    return surfaceNames[surface] || 0;
  };

  K.TRAFFIC_KIND = Object.freeze({ CAR: 0, SPORTS: 1, LIGHT_TRUCK: 2, HEAVY: 3 });
  const trafficNames = {
    compact: 0, sedan: 0, coupe: 0, wagon: 0, station_wagon: 0, taxi: 0, police: 0, car: 0,
    sports: 1, sports_coupe: 1,
    pickup: 2, van: 2,
    bus: 3, city_bus: 3, truck: 3, box_truck: 3,
  };
  K.trafficKindCode = (kind) => trafficNames[kind] || 0;

  K.IMPACT = Object.freeze({ THUD: 0, METAL: 1, GLASS: 2, SCRAPE: 3, SPLASH: 4 });
  const impactNames = {
    wall: 0, building: 0, thud: 0, ground: 0,
    vehicle: 1, car: 1, traffic: 1, pole: 1, barrier: 1, metal: 1,
    glass: 2, scrape: 3, splash: 4, water: 4,
  };
  K.impactCode = (kind) => { const c = impactNames[kind]; return c === undefined ? 1 : c; };

  K.UI_KINDS = Object.freeze(['select', 'back', 'toggle', 'start', 'move', 'error', 'pause', 'resume', 'toast', 'car', 'colour']);
  K.uiCode = (kind) => { const i = K.UI_KINDS.indexOf(kind); return i < 0 ? 0 : i; };

  // ------------------------------------------------------------------ districts
  // How much of each ambience layer a district has. Surf is not here: it follows the measured
  // distance to the shore (env.oceanProximity), so it is right on every coast.
  //                 gulls insects frogs traffic neon harbour aircraft
  const profiles = [
    /* 0 default  */ [0.40, 0.60, 0.40, 0.40, 0.30, 0.00, 0.10],
    /* 1 downtown */ [0.15, 0.15, 0.00, 1.00, 0.80, 0.00, 0.10],
    /* 2 poor res */ [0.20, 0.70, 0.50, 0.45, 0.30, 0.00, 0.10],
    /* 3 latin    */ [0.15, 0.50, 0.25, 0.60, 0.70, 0.00, 0.10],
    /* 4 port     */ [0.80, 0.20, 0.10, 0.35, 0.10, 1.00, 0.35],
    /* 5 airport  */ [0.10, 0.40, 0.20, 0.30, 0.15, 0.00, 1.00],
    /* 6 base     */ [0.10, 0.70, 0.50, 0.15, 0.00, 0.00, 0.60],
    /* 7 strip    */ [0.70, 0.50, 0.30, 0.50, 0.50, 0.00, 0.05],
    /* 8 resort   */ [0.80, 0.45, 0.25, 0.50, 0.70, 0.00, 0.05],
    /* 9 deco     */ [1.00, 0.40, 0.20, 0.45, 1.00, 0.10, 0.05],
    /* 10 mansion */ [0.50, 1.00, 0.80, 0.10, 0.00, 0.05, 0.05],
    /* 11 studio  */ [0.50, 0.90, 0.80, 0.10, 0.10, 0.00, 0.05],
    /* 12 golf    */ [0.40, 1.00, 1.00, 0.05, 0.00, 0.00, 0.05],
  ];
  K.DISTRICT_PROFILES = profiles.map((p) => Float32Array.from(p));
  K.PROFILE = Object.freeze({ GULLS: 0, INSECTS: 1, FROGS: 2, TRAFFIC: 3, NEON: 4, HARBOUR: 5, AIRCRAFT: 6, COUNT: 7 });

  // Layout ids and both sets of names (map lore and in-game), lower case, letters and digits only.
  const districtCodes = {
    downtown: 1,
    littlehaiti: 2, littlejacmel: 2,
    littlehavana: 3, littlesantiago: 3,
    viceport: 4, southport: 4,
    escobarinternational: 5, escobarinternationalairport: 5, flamingointernational: 5,
    fortbaxter: 6, fortbaxterairbase: 6, fortmangrove: 6,
    vicepoint: 7, coralpoint: 7,
    washingtonbeach: 8, midbeach: 8,
    oceanbeach: 9, southpointbeach: 9,
    starfishisland: 10, seastarkey: 10,
    prawnisland: 11, shrimpkey: 11,
    leaflinks: 12, palmlinks: 12,
  };
  // Fallback for names that are not in the table (a renamed district still gets a fitting bed).
  const districtKeywords = [
    ['airport', 5], ['international', 5], ['port', 4], ['dock', 4], ['links', 12], ['golf', 12],
    ['downtown', 1], ['beach', 9], ['island', 10], ['key', 10], ['fort', 6], ['base', 6],
  ];
  /** District profile index from a layout id or a display name. Unknown names get the default profile. */
  K.districtCode = (name) => {
    if (typeof name !== 'string') return 0;
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (districtCodes[key] !== undefined) return districtCodes[key];
    for (const [word, code] of districtKeywords) if (key.includes(word)) return code;
    return 0;
  };
}
