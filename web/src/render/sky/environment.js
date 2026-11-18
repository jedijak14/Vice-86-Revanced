// Environment derivation: everything the game, renderer, audio and UI need to know about the light at a moment,
// as a pure function of the clock and the weather. No GL, no DOM; with `out` supplied no object is created or kept.
//
//   const env = deriveEnvironment({ timeOfDay, clouds, rain, wetness, puddles, fog, windX, windZ, lightning, strike }, out);
//
// The place is latitude 25.8 N at the June solstice, with solar noon at clock 12.5 so that the named presets land on
// the light they are named after (design/brief/lighting-and-mood.md section 2): the sun clears the Atlantic (+X) at
// 5.69, stands almost overhead at 12.5 and goes down behind the mainland (-X) at 19.31. A nearly full moon follows
// 11 hours behind it: it is already up over the ocean at dusk, lays its path towards the beach through the evening and
// sets before five, so the last hour before dawn is dark.
//
// Light levels use the compressed scene scale of ARCHITECTURE 4.6. Daylight follows the atmosphere model in
// atmosphere.js unchanged. Twilight is lifted on purpose (`twilightGain`): real dusk falls a thousandfold in half an
// hour, while the scale gives lamps and neon night-time values, so an unlifted dusk sky would be black behind lit signs.

import { ATMOSPHERE, atmosphereLuts, skyRadiance, transmittanceToLight, miePhase, hazePhase, gradeSky } from './atmosphere.js';

const DEG = Math.PI / 180;
export const LATITUDE = 25.8 * DEG;
const SUN_DECLINATION = 23.44 * DEG, MOON_DECLINATION = -21 * DEG;
export const SOLAR_NOON = 12.5;          // clock hours at which the sun culminates
const MOON_LAG_HOURS = 11;               // the moon crosses the meridian this long after the sun
const HORIZON_SET = -0.85 * DEG;         // geometric elevation at which the upper limb disappears (refraction + radius)
const SEA_MIST_ON_BEAM = 0.8;            // the rising sun shines through the mist lying on the ocean: extra optical depth, morning only
const MIN_LIGHT_ELEVATION = 3 * DEG;     // the shadow-casting direction never drops below this: keeps cascades finite

/** Named hours (ARCHITECTURE section 8). */
export const TIME_PRESETS = Object.freeze({ dawn: 6.2, morning: 9.0, noon: 12.5, afternoon: 16.0, golden: 18.6, dusk: 19.6, night: 22.5 });

const halfDayHours = (decl, elevation) => Math.acos((Math.sin(elevation) - Math.sin(LATITUDE) * Math.sin(decl)) / (Math.cos(LATITUDE) * Math.cos(decl))) / DEG / 15;
/** Clock hours at which the centre of the sun crosses the geometric horizon (its last light goes four minutes later). */
export const SUNRISE = SOLAR_NOON - halfDayHours(SUN_DECLINATION, 0);
export const SUNSET = SOLAR_NOON + halfDayHours(SUN_DECLINATION, 0);

/** Moon irradiance at full phase above the atmosphere, scene units: cool, and far brighter than nature relative to the sun. */
const MOON_IRRADIANCE = [0.14, 0.185, 0.27];
/** What is left of the sky when neither body lights it: airglow and starlight. */
const NIGHT_SKY = [0.0030, 0.0050, 0.0125];
/**
 * Sodium scattered back by the humid air over the streets: radiance per kilometre of fully lit haze along the line of
 * sight, per unit of the street-lamp switch. A level sight line across town gathers about a kilometre of it (glow.js).
 */
export const CITY_GLOW = Object.freeze([0.075, 0.034, 0.018]);
/**
 * What fills a fully built-up street between the pools of its lamps, as radiance of its surroundings (the probe adds
 * both by how brightly lit the place is). STREET_AIR: what hangs overhead, lit haze, signs and upper floors against
 * the night; violet, strongest straight up, so that it reaches the road and the roofs of cars and hardly the walls
 * (which are five times paler than asphalt and would stand there as if by day). STREET_FILL: the fronts and pavement
 * round the horizontal and below, dim for the same reason. Both are cool: the lamps' own sodium is in the pools,
 * and warm pools read as warm only on a cool-neutral base.
 */
export const STREET_AIR = Object.freeze([0.45, 0.48, 0.74]);
export const STREET_FILL = Object.freeze([0.036, 0.037, 0.048]);
/**
 * How brightly each kind of district of the map is lit at night, 0..1: towers and the hotel strip burn all night, the
 * islands of the rich keep their lamps behind hedges, and nobody lights a golf course. Feeds sky.setCityGlow.
 */
const DISTRICT_LIGHTS = Object.freeze({
  downtown: 1.0, hotel_strip: 0.9, artdeco_beach: 0.8, beach_resort: 0.7, latin_quarter: 0.6, airport: 0.55,
  industrial_port: 0.5, residential_poor: 0.45, military: 0.3, studio_island: 0.3, mansion_island: 0.22, golf: 0.08,
});
/** Lit amount 0..1 of a district style of the layout; a style this table has not heard of is lit like an ordinary street. */
export function districtLights(style) { return DISTRICT_LIGHTS[style] ?? 0.5; }

const GROUND_ALBEDO = [0.19, 0.18, 0.16];
/** Pastel render of the sunlit facades, and the share of the lower hemisphere they fill as seen from the street. */
const FACADE_ALBEDO = 0.5, FACADE_SHARE = 0.12;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const finite = (x, fallback) => (Number.isFinite(x) ? x : fallback);

/** Unit vector towards a body with the given hour angle (radians, 0 on the meridian, positive afterwards). +X east, +Y up, +Z south. */
function bodyDirection(hourAngle, decl, out) {
  const cd = Math.cos(decl), sd = Math.sin(decl), cl = Math.cos(LATITUDE), sl = Math.sin(LATITUDE), ch = Math.cos(hourAngle);
  out[0] = -cd * Math.sin(hourAngle);
  out[1] = sl * sd + cl * cd * ch;
  out[2] = -(cl * sd - sl * cd * ch);
  return out;
}

/**
 * Scale on the sun's scattered light: the art-direction gain of the sky by day, lifted further once the sun is below
 * the horizon. See the header.
 * The sky-view pass and the cloud lighting multiply the sun's irradiance by this; direct light never needs it.
 */
export function twilightGain(sunElevationDeg) {
  // From the last light of the disc to the dusk preset (-3.5 degrees) the lift cancels the real decay almost exactly,
  // so the sky holds its brightness through the colour show; after that it is allowed to fade into night.
  const below = clamp(0.5 - sunElevationDeg, 0, 18.5);
  return ATMOSPHERE.skyGain * Math.exp(0.492 * Math.min(below, 4) + 0.42 * Math.max(below - 4, 0));
}

/**
 * Strength 0..1 of the twilight split tone the sky-view lookup applies (glsl/common.js): nothing while the sun is up,
 * full at the dusk preset, gone again once the afterglow has faded into night.
 */
export const twilightTone = (sunElevationDeg) => smoothstep(3.5, -3, sunElevationDeg) * (1 - smoothstep(-9, -15, sunElevationDeg));
/** Strength 0..1 of the low-sun tone (lavender far horizon at dawn and golden hour), which hands over to the twilight tone. */
export const lowSunTone = (sunElevationDeg) => smoothstep(18, 6, sunElevationDeg) * smoothstep(-3, 2.5, sunElevationDeg);

// ---------------------------------------------------------------------------------------------------------------
// Sky table: the atmosphere integral evaluated once per light elevation, so the per-frame call is a few lookups.
// Elevation is stored on a square-root scale: the light changes fastest at the horizon.
const TABLE_N = 112, TABLE_MIN = -20, TABLE_MAX = 90;
const tableCoord = (deg) => { const s = deg < 0 ? -Math.sqrt(-deg / 90) : Math.sqrt(deg / 90), lo = -Math.sqrt(-TABLE_MIN / 90); return (s - lo) / (1 - lo) * (TABLE_N - 1); };
const tableElevation = (i) => { const lo = -Math.sqrt(-TABLE_MIN / 90), s = lo + (1 - lo) * i / (TABLE_N - 1); return (s < 0 ? -s * s : s * s) * 90; };
let table = null;

/**
 * The low-sun haze and tone of the sky-view lookup (glsl/common.js skyClearLobe), applied to one sky sample: `c` is
 * the scattered light with the sharp aerosol lobe already in, `mie` the aerosol without its phase, cosLight the
 * cosine to the light, cosAz the compass cosine between the view and the light, y the view direction's height.
 * Keep in step with the shader: the exposure and the ambient light are derived from these tables.
 */
function lowSunShade(c, smooth, mie, cosLight, cosAz, y, L) {
  if (L <= 0) return;
  const side = smoothstep(-0.35, 0.85, cosAz), low = 1 - smoothstep(0.16, 0.74, y), belt = smoothstep(0.03, 0.13, y) * (1 - smoothstep(0.16, 0.34, y));
  for (let k = 0; k < 3; k++) c[k] = smooth[k] * (1 - L * (0.25 + 0.3 * side * low)) + mie[k] * (miePhase(cosLight) + L * hazePhase(cosLight));
  gradeSky(c);
  c[1] *= 1 - 0.2 * L * low * side;
  c[0] *= 1 + L * (1 - side) * (0.45 * belt + 0.1 * low);
  c[2] *= 1 - 0.5 * L * low * side;
  const dim = 1 - 0.3 * L * (1 - side) * low;
  for (let k = 0; k < 3; k++) c[k] *= dim;
}

function buildTable() {
  const luts = atmosphereLuts(), E = ATMOSPHERE.sunIrradiance, r0 = ATMOSPHERE.groundRadius + ATMOSPHERE.observerAltitude;
  const t = {
    direct: new Float32Array(TABLE_N * 3),    // irradiance on a surface facing the body
    zenith: new Float32Array(TABLE_N * 3),    // sky radiance straight up
    horizon: new Float32Array(TABLE_N * 3),   // sky radiance 3 degrees up, averaged round the compass
    hemisphere: new Float32Array(TABLE_N * 3), // cosine-weighted mean sky radiance (sky irradiance / PI)
    // the same three for the sun, with the low-sun haze and tone the shader adds to its light (the moon has none)
    zenithSun: new Float32Array(TABLE_N * 3), horizonSun: new Float32Array(TABLE_N * 3), hemisphereSun: new Float32Array(TABLE_N * 3),
  };
  const s6 = new Float64Array(6), c3 = [0, 0, 0], sm = [0, 0, 0], mi = [0, 0, 0], T = [0, 0, 0], RING = 6, BANDS = 5;
  // arr gets the plain sky, sunArr the sun's version; L = lowSunTone at this row's elevation
  const add = (arr, sunArr, o, vx, vy, vz, lx, ly, w, L) => {
    skyRadiance(luts, vx, vy, vz, lx, ly, 0, s6, 36); const cosLight = vx * lx + vy * ly, pm = miePhase(cosLight);
    for (let k = 0; k < 3; k++) { sm[k] = s6[k] * E[k]; mi[k] = s6[k + 3] * E[k]; c3[k] = sm[k] + mi[k] * pm; }
    gradeSky(c3);
    for (let k = 0; k < 3; k++) arr[o + k] += w * c3[k];
    lowSunShade(c3, sm, mi, cosLight, vx / (Math.hypot(vx, vz) || 1), vy, L);
    for (let k = 0; k < 3; k++) sunArr[o + k] += w * c3[k];
  };
  for (let i = 0; i < TABLE_N; i++) {
    const deg = tableElevation(i), e = deg * DEG, lx = Math.cos(e), ly = Math.sin(e), o = i * 3, L = lowSunTone(deg);
    transmittanceToLight(luts.transmittance, r0, ly, T);
    const up = smoothstep(HORIZON_SET, -0.3 * DEG, e);
    for (let k = 0; k < 3; k++) t.direct[o + k] = T[k] * E[k] * up;
    add(t.zenith, t.zenithSun, o, 0, 1, 0, lx, ly, 1, L);
    for (let a = 0; a < RING; a++) {
      // azimuths 0..180 relative to the light: the far side mirrors them
      const az = Math.PI * (a + 0.5) / RING, h = 3 * DEG;
      add(t.horizon, t.horizonSun, o, Math.cos(h) * Math.cos(az), Math.sin(h), Math.cos(h) * Math.sin(az), lx, ly, 1 / RING, L);
      for (let b = 0; b < BANDS; b++) {
        // equal steps in sin^2(elevation) are equal shares of a cosine-weighted hemisphere
        const sinEl = Math.sqrt((b + 0.5) / BANDS), cosEl = Math.sqrt(1 - sinEl * sinEl);
        add(t.hemisphere, t.hemisphereSun, o, cosEl * Math.cos(az), sinEl, cosEl * Math.sin(az), lx, ly, 1 / (RING * BANDS), L);
      }
    }
  }
  // Deep twilight: the model's light comes up in two surges (as the last direct sunlight reaches the top of the
  // atmosphere, and again as the planet's shadow leaves the dense air). On screen the sky absorbs that; in the ambient
  // light and the exposure it would read as a pulse. Smooth the rows of deep twilight, in logarithms as twilight is geometric.
  const firstLit = Math.floor(tableCoord(-4.2));    // the dusk preset (sun 3.5 degrees down) keeps its fitted values
  for (const arr of [t.zenith, t.horizon, t.hemisphere, t.zenithSun, t.horizonSun, t.hemisphereSun]) {
    for (let pass = 0; pass < 4; pass++) {
      for (let k = 0; k < 3; k++) {
        let below = Math.log(Math.max(arr[k], 1e-12));
        for (let i = 1; i < firstLit; i++) {
          const here = Math.log(Math.max(arr[i * 3 + k], 1e-12)), above = Math.log(Math.max(arr[i * 3 + 3 + k], 1e-12));
          arr[i * 3 + k] = Math.exp(0.25 * below + 0.5 * here + 0.25 * above);
          below = here;
        }
      }
    }
  }
  return t;
}
function lookup(arr, deg, out) {
  const x = clamp(tableCoord(clamp(deg, TABLE_MIN, TABLE_MAX)), 0, TABLE_N - 1.0001), i = Math.floor(x), f = x - i, o = i * 3;
  for (let k = 0; k < 3; k++) {
    const a = arr[o + k], b = arr[o + 3 + k];
    // below the horizon the light falls geometrically: a straight line between rows would brighten in a sawtooth
    out[k] = deg < 0 && a > 0 && b > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Colour grade keys (lighting brief section 6). Rows: night, twilight, low sun, mid sun, high sun, at the sun
// elevations of the presets, so each preset shows its row unmixed. Morning and evening share the night and noon rows.
// Each key: tint rgb, contrast, saturation, shadowsTint rgb.
const GRADE_AM_ELEVATIONS = [-11, -3.5, 6.2, 42.5, 80], GRADE_PM_ELEVATIONS = [-11, -3.5, 8.7, 42.5, 80];
const GRADE_AM = [
  [0.96, 0.98, 1.08, 1.12, 1.20, 0.86, 0.94, 1.16],   // night: blue-violet blacks under amber and pink
  [1.05, 0.96, 1.02, 1.03, 1.12, 0.88, 0.98, 1.12],   // dawn twilight: rose over lavender
  [1.04, 0.98, 0.94, 1.02, 1.05, 0.92, 0.98, 1.10],   // dawn: soft peach light, cool blue shade
  [1.03, 1.00, 0.96, 1.05, 1.08, 0.96, 1.00, 1.06],   // morning: warm and clean
  [1.00, 1.00, 0.98, 1.10, 1.12, 0.95, 1.00, 1.08],   // noon: crisp pastels, shadows a touch blue
];
const GRADE_PM = [
  GRADE_AM[0],
  [1.06, 0.94, 1.08, 1.04, 1.25, 0.80, 1.02, 1.12],   // dusk: magenta highlights over teal shadows
  [1.10, 0.98, 0.86, 1.06, 1.15, 0.90, 0.98, 1.14],   // golden hour: peach against blue-violet shade
  [1.04, 1.00, 0.94, 1.08, 1.12, 0.94, 1.00, 1.08],   // afternoon: postcard warmth
  GRADE_AM[4],
];
// Shadow tints of the brief's rain rows; the other weather terms are written out where the grade is assembled.
const GRADE_RAIN_DAY_SHADOWS = [0.86, 1.00, 1.04], GRADE_RAIN_NIGHT_SHADOWS = [0.82, 1.00, 1.10];
const gradeScratch = new Float32Array(8);
function gradeAt(keys, elevations, elevationDeg, out) {
  let i = 0; while (i < elevations.length - 2 && elevationDeg > elevations[i + 1]) i++;
  const f = smoothstep(elevations[i], elevations[i + 1], elevationDeg), a = keys[i], b = keys[i + 1];
  for (let k = 0; k < 8; k++) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
/** A fresh Environment with every array in place; pass it back as `out` to avoid allocation. */
export function createEnvironment() {
  return {
    timeOfDay: 0,
    sunDir: [0, 1, 0], moonDir: [0, 1, 0],
    lightDir: [0, 1, 0], lightColor: [0, 0, 0], isSun: true,
    ambientSky: [0, 0, 0], ambientGround: [0, 0, 0],
    fogColor: [0, 0, 0], fogDensity: 0, fogHeight: 1,
    exposure: 1, night: 0,
    lampGain: 1,                             // gain on every local lamp (beams, street lamps, sign spill): 1 by night, less while the sky still lights the street
    switches: { street: 0, neon: 0, windows: 0 },
    weather: { clouds: 0, rain: 0, wetness: 0, puddles: 0, fog: 0, wind: [0, 0], lightning: 0 },
    grade: { tint: [1, 1, 1], contrast: 1, saturation: 1, shadowsTint: [1, 1, 1] },
    // Additions used by the sky module itself (and free for anyone else to read):
    sunElevation: 0, moonElevation: 0,       // radians, geometric
    sunLight: [0, 0, 0], moonLight: [0, 0, 0], // irradiance each body delivers at the ground through the weather
    sunScatter: [0, 0, 0], moonScatter: [0, 0, 0], // irradiance above the atmosphere that drives sky scattering and cloud lighting
    moonPhase: 1,                            // lit fraction of the disc 0..1
    skyZenith: [0, 0, 0], skyHorizon: [0, 0, 0], // clear-sky radiance overhead and round the horizon (before clouds)
    skyMean: [0, 0, 0],                      // cosine-weighted mean radiance of the clear sky (what lights cloud sides and tops)
    deckLight: [0, 0, 0],                    // radiance of the underside of a full cloud deck in this weather (daylight above it, diffused)
    nightSky: [0, 0, 0],                     // radiance left in the sky when neither body lights it
    overcast: 0, storm: 0,                   // 0..1 summaries of the cloud deck used for light and grade
    daylight: 0,                             // horizontal illuminance reaching the street, scene units (drives the switches)
    starAngle: 0,                            // rotation of the star field about the celestial pole, radians
    strike: new Float32Array(4),             // last lightning strike: x, z (world metres), age (s), seed; age < 0 = none
    interior: false,                         // true while a closed room is shown instead of the street (input.interior): no sky, no weather
  };
}

const sunScr = [0, 0, 0], moonScr = [0, 0, 0], hemiSun = [0, 0, 0], hemiMoon = [0, 0, 0], horSun = [0, 0, 0], horMoon = [0, 0, 0], zenSun = [0, 0, 0], zenMoon = [0, 0, 0];

/** Ramp 1 -> 0 as light rises through [lo, hi] on a logarithmic scale (lamps react to ratios of light, not differences). */
const darkRamp = (light, lo, hi) => 1 - smoothstep(Math.log(lo), Math.log(hi), Math.log(Math.max(light, 1e-6)));

/**
 * Derive the environment. Every input is optional: timeOfDay in hours (any real number, wrapped), the weather
 * amounts in 0..1, wind in m/s, lightning = flash 0..1, strike = Float32Array(4) from lightning.js.
 * interior: true asks for a closed room at that same hour instead (see shutIn); the input is not written to, and
 * nothing is carried from one call to the next, so the street is back with the next call without it.
 */
export function deriveEnvironment(input, out = createEnvironment()) {
  if (!table) table = buildTable();
  const env = out, w = env.weather;
  const time = ((finite(input.timeOfDay, 12) % 24) + 24) % 24;
  env.timeOfDay = time;
  const clouds = w.clouds = saturate(finite(input.clouds, 0)), rain = w.rain = saturate(finite(input.rain, 0));
  w.wetness = saturate(finite(input.wetness, 0)); w.puddles = saturate(finite(input.puddles, 0));
  const fog = w.fog = saturate(finite(input.fog, 0));
  w.wind[0] = finite(input.windX, 0); w.wind[1] = finite(input.windZ, 0);
  w.lightning = saturate(finite(input.lightning, 0));
  if (input.strike) env.strike.set(input.strike); else { env.strike[0] = env.strike[1] = env.strike[3] = 0; env.strike[2] = -1; }

  // ---- where the sun and moon are
  let hours = time - SOLAR_NOON; if (hours < -12) hours += 24; else if (hours >= 12) hours -= 24;   // hours since solar noon
  bodyDirection(hours * 15 * DEG, SUN_DECLINATION, env.sunDir);
  bodyDirection((hours - MOON_LAG_HOURS) * 15 * DEG, MOON_DECLINATION, env.moonDir);
  const sunEl = env.sunElevation = Math.asin(clamp(env.sunDir[1], -1, 1)), moonEl = env.moonElevation = Math.asin(clamp(env.moonDir[1], -1, 1));
  const sunDeg = sunEl / DEG, moonDeg = moonEl / DEG;
  env.moonPhase = 0.5 * (1 - (env.sunDir[0] * env.moonDir[0] + env.sunDir[1] * env.moonDir[1] + env.sunDir[2] * env.moonDir[2]));
  env.starAngle = time / 24 * 2 * Math.PI * 1.0027;
  env.night = smoothstep(2, -8, sunDeg);

  // 1 before solar noon, 0 after: morning and evening differ. The two meet again in the middle of the night.
  const amShare = mix(1 - smoothstep(-1.5, 1.5, hours), 0.5, smoothstep(10.5, 12, Math.abs(hours)));

  // ---- cloud deck summaries
  const overcast = env.overcast = smoothstep(0.55, 0.95, clouds);
  const storm = env.storm = overcast * smoothstep(0.25, 1.0, rain);
  // share of daylight that gets through to the street: 15 % under a plain deck, 5 % in steady rain, 2 % in a storm
  const deckTransmission = mix(1, 0.155 * Math.pow(0.136, Math.pow(storm, 0.72)), overcast);
  // through a deck the sun is a soft brighter patch (4 %); rain closes even that
  const directShare = mix(1 - 0.25 * smoothstep(0.2, 0.6, clouds), 0.04, 1 - (1 - overcast) * (1 - overcast)) * (1 - overcast * smoothstep(0.05, 0.5, rain));

  // ---- fog: the haze that is always there (thickest and lowest at sunrise, thin and deep at noon), rain, real fog
  const lowSun = smoothstep(60, 4, sunDeg) * (1 - 0.65 * smoothstep(-4, -12, sunDeg));
  const haze = 1.6e-4 + mix(1.6e-4, 2.4e-4, amShare) * lowSun;
  env.fogDensity = haze + 4.1e-3 * rain * rain + 2.0e-4 * overcast + 1.1e-2 * fog * fog;
  const heightAm = sunDeg < 4 ? mix(200, 120, smoothstep(-12, 4, sunDeg)) : 120 + 380 * smoothstep(4, 70, sunDeg);
  const heightPm = 200 + 300 * smoothstep(-12, 30, sunDeg);
  const hazeHeight = mix(heightPm, heightAm, amShare);
  env.fogHeight = mix(mix(hazeHeight, 900, overcast), 110, smoothstep(0.05, 0.6, fog));
  // The beam of a low sun or moon crosses that same haze layer at a slant: the soft, dim disc of a humid horizon.
  // Weather is not counted here; directShare below takes the light away under cloud.
  const hazeDepth = haze * hazeHeight * (1 + SEA_MIST_ON_BEAM * amShare * lowSun);
  const sunHaze = Math.exp(-hazeDepth / Math.max(env.sunDir[1], 0.035)), moonHaze = Math.exp(-hazeDepth / Math.max(env.moonDir[1], 0.035));

  // ---- the two bodies: light at the ground and light driving the sky
  const gain = twilightGain(sunDeg), moonUp = smoothstep(-3.5, -9, sunDeg), moonLit = 0.15 + 0.85 * env.moonPhase;
  lookup(table.direct, sunDeg, sunScr); lookup(table.direct, moonDeg, moonScr);
  const E = ATMOSPHERE.sunIrradiance, grey = overcast * 0.75;
  for (let k = 0; k < 3; k++) {
    env.sunScatter[k] = E[k] * gain;
    env.moonScatter[k] = MOON_IRRADIANCE[k] * moonLit * moonUp;
    env.sunLight[k] = sunScr[k] * sunHaze * directShare;
    env.moonLight[k] = moonScr[k] / E[k] * MOON_IRRADIANCE[k] * moonLit * moonUp * moonHaze * directShare;
  }
  // light that has come through cloud has lost its colour
  const sunL = luma(env.sunLight), moonL = luma(env.moonLight);
  for (let k = 0; k < 3; k++) { env.sunLight[k] = mix(env.sunLight[k], sunL, grey); env.moonLight[k] = mix(env.moonLight[k], moonL, grey); }

  // The sun's irradiance is exactly zero before it reaches HORIZON_SET and the moon's is zero until the sun is well
  // below it, so the hand-over between the two happens in darkness and cannot pop.
  const isSun = env.isSun = sunEl > HORIZON_SET;
  const body = isSun ? env.sunDir : env.moonDir, light = isSun ? env.sunLight : env.moonLight;
  const ly = Math.max(body[1], Math.sin(MIN_LIGHT_ELEVATION)), lh = Math.hypot(body[0], body[2]) || 1, lr = Math.sqrt(1 - ly * ly) / lh;
  env.lightDir[0] = body[0] * lr; env.lightDir[1] = ly; env.lightDir[2] = body[2] * lr;
  env.lightColor[0] = light[0]; env.lightColor[1] = light[1]; env.lightColor[2] = light[2];

  // ---- sky radiance summaries (clear air), then the cloud deck on top
  lookup(table.hemisphereSun, sunDeg, hemiSun); lookup(table.hemisphere, moonDeg, hemiMoon);
  lookup(table.horizonSun, sunDeg, horSun); lookup(table.horizon, moonDeg, horMoon);
  lookup(table.zenithSun, sunDeg, zenSun); lookup(table.zenith, moonDeg, zenMoon);
  const street = lampSwitches(env, hours, sunDeg, luma(sunScr) * Math.max(Math.sin(sunEl), 0) + Math.PI * luma(hemiSun), deckTransmission);
  const lowCloud = smoothstep(0.1, 0.8, clouds);
  let ambientL = 0;
  for (let k = 0; k < 3; k++) {
    const moonK = env.moonScatter[k] / E[k];
    // Lamp glow as the whole sky of an ordinary street has it in the mean: little on a clear night, when it is a band
    // at the horizon (glsl/common.js skyCityGlow), several times that held under a cloud deck or in fog.
    const glow = NIGHT_SKY[k] * (1 - 0.6 * overcast) + CITY_GLOW[k] * street * (0.06 + 0.25 * lowCloud + 0.2 * fog);
    env.skyZenith[k] = zenSun[k] * gain + zenMoon[k] * moonK + NIGHT_SKY[k];
    env.skyHorizon[k] = horSun[k] * gain + horMoon[k] * moonK + glow;
    env.nightSky[k] = NIGHT_SKY[k] * (1 - 0.6 * overcast);
    const clear = env.skyMean[k] = hemiSun[k] * gain + hemiMoon[k] * moonK;
    // Under a deck the sky is the daylight above it, diffused: brighter than blue sky at noon, darker in a storm.
    const under = env.deckLight[k] = ((sunScr[k] * Math.max(Math.sin(sunEl), 0) + moonScr[k] * moonK * Math.max(Math.sin(moonEl), 0)) / Math.PI + clear) * deckTransmission;
    env.ambientSky[k] = mix(clear * (1 + 0.3 * smoothstep(0.1, 0.6, clouds)), under, overcast) + glow;
    ambientL += env.ambientSky[k] * (k === 0 ? 0.2126 : k === 1 ? 0.7152 : 0.0722);
  }
  if (overcast > 0) {
    // a deck is close to neutral with a slight cool cast; keep the luminance
    for (let k = 0; k < 3; k++) env.ambientSky[k] = mix(env.ambientSky[k], ambientL * (k === 0 ? 0.93 : k === 1 ? 0.99 : 1.08), overcast * 0.8);
  }
  // The lamps are tuned against the night: a low-beam pool that is right on a night road is several times the
  // sky-lit road at dusk, and a glare by day. Their gain follows the sky light, 1 under any night sky (clear or under a
  // deck, so that the accepted night look is untouched) and falling as a power of how much brighter the sky is, to a
  // pool of about 1.75 times the ambient road at the clear dusk preset. Weather enters through ambientSky itself.
  env.lampGain = Math.min(1, Math.pow(LAMP_GAIN_SKY / Math.max(ambientL, 1e-6), LAMP_GAIN_POWER));
  // Light coming up from below the horizon: the ground under the sky, plus, while the sun is low, the sunlit faces of
  // buildings that stand square to it (a share of what a street sees sideways, and the warmth of the shade at golden hour).
  const lightHorizontal = Math.max(env.lightDir[1], 0), lowSunK = lowSunTone(sunDeg);
  const walls = FACADE_ALBEDO * FACADE_SHARE * lowSunK * Math.sqrt(1 - lightHorizontal * lightHorizontal);
  for (let k = 0; k < 3; k++) env.ambientGround[k] = GROUND_ALBEDO[k] * (env.lightColor[k] * lightHorizontal / Math.PI + env.ambientSky[k]) + env.lightColor[k] * walls / Math.PI;

  for (let k = 0; k < 3; k++) env.fogColor[k] = mix(env.skyHorizon[k], env.ambientSky[k] * 1.05, Math.max(overcast, 0.6 * fog));

  // ---- exposure from an estimate of the average scene radiance (sunlit and shaded surfaces of middling albedo).
  // A power law, not full compensation: evenings are shown darker than noon, as a camera operator would expose them.
  const facing = mix(lightHorizontal, 1, 0.4);    // walls take low sun square on, so do not let exposure run away at sunset
  // With the sun low, most of a street lies in the shadow of its own buildings: the operator exposes for the shade and
  // lets the sunlit crowns and upper floors run bright, so the direct light counts for less the lower the sun.
  const sunlitShare = smoothstep(4, 30, sunDeg);
  const sceneRadiance = 0.18 * (luma(env.lightColor) * facing * sunlitShare / Math.PI + luma(env.ambientSky));
  // under cloud the eye expects grey, not a re-brightened day: weather is compensated a little more than the hour is
  const weatherLift = (1 + 0.085 * overcast) * (1 + 0.31 * storm * storm * storm);
  env.exposure = clamp(EXPOSURE_KEY * Math.pow(Math.max(sceneRadiance, 1e-4), -EXPOSURE_SLOPE) * weatherLift, EXPOSURE_MIN, EXPOSURE_MAX);

  // ---- grade
  const g = env.grade, a = gradeAt(GRADE_AM, GRADE_AM_ELEVATIONS, sunDeg, gradeScratch);
  const tr = a[0], tg = a[1], tb = a[2], con = a[3], sat = a[4], sr = a[5], sg = a[6], sb = a[7];
  const b = gradeAt(GRADE_PM, GRADE_PM_ELEVATIONS, sunDeg, gradeScratch);
  // A dry deck turns the day silver; rain by day goes grey-teal; rain at night keeps a black road under full colour.
  const wet = smoothstep(0.05, 0.5, rain), dry = overcast * (1 - wet), wetDay = wet * (1 - env.night), wetNight = wet * env.night;
  g.tint[0] = mix(b[0], tr, amShare) * (1 - 0.03 * dry - 0.05 * wetDay);
  g.tint[1] = mix(b[1], tg, amShare);
  g.tint[2] = mix(b[2], tb, amShare) * (1 + 0.02 * (dry + wetDay));
  const contrast = mix(b[3], con, amShare), saturation = mix(b[4], sat, amShare);
  g.contrast = contrast + (0.96 - contrast) * dry + (0.98 - contrast) * wetDay + (1.16 - contrast) * wetNight;
  g.saturation = mix(saturation * (1 - 0.2 * dry - 0.3 * wetDay), 1.25, wetNight);
  for (let k = 0; k < 3; k++) {
    const preset = k === 0 ? mix(b[5], sr, amShare) : k === 1 ? mix(b[6], sg, amShare) : mix(b[7], sb, amShare);
    g.shadowsTint[k] = preset + (GRADE_RAIN_DAY_SHADOWS[k] - preset) * wetDay + (GRADE_RAIN_NIGHT_SHADOWS[k] - preset) * wetNight;
  }
  env.interior = input.interior === true;
  if (env.interior) shutIn(env);
  return env;
}

/**
 * A room with the door down: nothing of the sky or the weather reaches it. Every radiance the sky gives is zero and
 * the air is clear and dry and still, whatever goes on outside; the directions of sun and moon stay as they are
 * (unit vectors, so that nothing downstream normalises a zero). What a room has is its own lamps: the switches are
 * on, the lamps run at full gain and the exposure is the one they are tuned against, the night's.
 */
function shutIn(env) {
  for (const name of INTERIOR_DARK) env[name].fill(0);
  env.fogDensity = 0; env.daylight = 0; env.overcast = 0; env.storm = 0;
  const w = env.weather;
  w.clouds = w.rain = w.wetness = w.puddles = w.fog = w.lightning = 0; w.wind[0] = w.wind[1] = 0;
  env.strike[0] = env.strike[1] = env.strike[3] = 0; env.strike[2] = -1;
  env.night = 1; env.lampGain = 1; env.exposure = EXPOSURE_MAX;
  const s = env.switches; s.street = s.neon = s.windows = 1;
  const g = env.grade; g.tint.fill(1); g.shadowsTint.fill(1); g.contrast = 1; g.saturation = 1;
}
/** The fields of an Environment that hold light of the sun, the moon or the sky. */
const INTERIOR_DARK = Object.freeze(['lightColor', 'ambientSky', 'ambientGround', 'fogColor', 'sunLight', 'moonLight', 'sunScatter', 'moonScatter', 'skyZenith', 'skyHorizon', 'skyMean', 'deckLight', 'nightSky']);

// Fitted to the brief: 0.045 at clear noon, 0.11 at golden hour, 0.40 at dusk, 1.0 at night, 0.10 under a noon overcast.
/** Sky-light luminance (scene units) up to which the lamps run at full gain: just above the brightest night sky, a cloudy one. */
const LAMP_GAIN_SKY = 0.022, LAMP_GAIN_POWER = 0.54;
const EXPOSURE_KEY = 0.110, EXPOSURE_SLOPE = 0.478, EXPOSURE_MAX = 1.05, EXPOSURE_MIN = 0.035;

/**
 * Street lamps, neon and windows (brief section 10). All three follow the light actually reaching the street, as a
 * photocell does, so a black afternoon storm brings them on. Hysteresis: lamps strike in the evening at a lower light
 * level than the one at which they go out in the morning. Neon leads the lamps in the evening (it is already glowing
 * against the dusk sky) and outlasts them into sunrise. Returns the street switch.
 */
function lampSwitches(env, hours, sunDeg, clearDaylight, deckTransmission) {
  const daylight = env.daylight = clearDaylight * deckTransmission, s = env.switches;
  const evening = smoothstep(-1.5, 1.5, hours);   // 0 in the morning, 1 after solar noon; both sides agree at midnight (all on)
  // by day under a storm deck: lamps and signs come on although the sun is high
  const stormDark = saturate(env.storm * 2) * darkRamp(daylight, 3.5, 8);
  s.street = Math.max(mix(darkRamp(daylight, 0.2, 1.6), darkRamp(daylight, 0.14, 1.25), evening), stormDark);
  s.neon = Math.max(mix(darkRamp(daylight, 0.26, 2.6), darkRamp(daylight, 1.25, 5.9), evening), stormDark);
  // Windows: on through the evening, thinning out after eleven as people go to bed, off with the sun.
  let late = env.timeOfDay - 23; if (late < -12) late += 24;                 // hours after 23:00, negative before
  const awake = 1 - 0.68 * smoothstep(0, 3.5, late);
  s.windows = mix(darkRamp(daylight, 0.25, 2.2), darkRamp(daylight, 0.15, 5), evening) * awake;
  return s.street;
}
