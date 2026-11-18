// Packs the `Sky` uniform block (glsl/common.js) from an Environment. Pure JavaScript: testable without GL.
import { ATMOSPHERE, atmosphereLuts, transmittanceToLight } from './atmosphere.js';
import { SKY_BLOCK_FIELDS } from './glsl/common.js';
import { twilightTone, lowSunTone } from './environment.js';
import { GLOW_SUMMARY_FLOATS } from './glow.js';

const DEG = Math.PI / 180;
const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

export const SKY_BLOCK_FLOATS = SKY_BLOCK_FIELDS.length * 4;
const OFFSET = Object.freeze(Object.fromEntries(SKY_BLOCK_FIELDS.map((name, i) => [name, i * 4])));
/** Float offset of a field inside the block (tests and tools). */
export const skyBlockOffset = (name) => OFFSET[name];

/** Sun elevation (degrees) below which the moon takes over cloud lighting and the aerosol half of the sky table: the afterglow has gone. */
const HANDOVER_DEG = -7;
const CUMULUS_KM = 1.2, CIRRUS_KM = 9.2;

/** Altitudes (m) of the cumulus layer for a given weather and cloud amount 0..1: storms bring the base down and pile the tops up. */
export function cloudLayer(overcast, storm, out, amount = 0.5) {
  out[0] = mix(mix(760, 640, overcast), 480, storm);
  // fair-weather puffs are shallow; a sky half full of cumulus has had the time to grow
  out[1] = out[0] + mix(mix(mix(420, 950, smoothstep(0.1, 0.6, amount)), 1100, overcast), 3600, storm);
  return out;
}

/** Mutable inputs that are not part of the Environment. */
export function createSkyState() {
  return {
    cloudOffset: new Float64Array(4),   // drift of cumulus (xy) and cirrus (zw), metres
    city: new Float32Array([0, 0, 1 / 2500]),   // centre x, z and 1 / radius
    coast: new Float32Array(4),         // origin x, z and 1 / extent; zero = no map
    glow: new Float32Array(GLOW_SUMMARY_FLOATS),   // the city's lamp light round the camera (glow.js, around())
    glowFrame: new Float32Array([-1, -1, 0.5]),    // the lit plan: origin x, z and 1 / extent
    cloudMapA: new Float32Array(3),     // how far camera and clouds have moved since cloud map A was marched (clouds.js)
    cloudMapB: new Float32Array(3),     // likewise for map B
    cloudMapShare: 0,                   // share of map B on screen 0..1
    cloudBake: new Float32Array(4),     // start of the march that is filling a map, and its jitter phase
    quality: 1,                         // 0 low .. 1 ultra
    waveClock: 0,                       // seconds, wrapped by the caller
    seaWind: new Float32Array([-1, 0]), // unit direction the waves run towards; lags the wind (ocean.js)
    seaState: -1,                       // 0 glassy .. 1 storm, smoothed; negative = take it straight from the weather
  };
}

const T = [0, 0, 0], layer = [0, 0];
function put(out, name, x, y, z, w) { const o = OFFSET[name]; out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = w; }

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Colour of the afterglow that lights cloud bases from below once the sun is down: salmon, the last light through the longest air path. */
const AFTERGLOW = [1.0, 0.36, 0.30];
/** Exposed radiance a sunlit cloud face may reach (display white is 1), and the albedo that turns irradiance into it. */
const SUNLIT_CLOUD_DISPLAY_CAP = 1.25, CLOUD_ALBEDO = 0.9;

/**
 * Irradiance reaching a cloud layer at an altitude from the body that lights it.
 * The sun's light is NOT lifted by twilightGain here: a cloud in direct sun after sunset is hundreds of times brighter
 * than the twilight sky behind it, and on the compressed scene scale that would clip to flat red. Instead the sunlit
 * cloud is held to a multiple of the sky's own brightness that shrinks as the sky darkens (ten times at noon, four at
 * dusk), which is how an evening exposure renders it. From sunset the direct beam gives way to the afterglow: light
 * of the glowing horizon arriving from just below the horizontal, which is what paints the undersides at dusk.
 */
function lightAtAltitude(luts, altitudeKm, env, sunLeads, out, o) {
  const elevation = sunLeads ? env.sunElevation : env.moonElevation, E = sunLeads ? ATMOSPHERE.sunIrradiance : env.moonScatter;
  transmittanceToLight(luts.transmittance, ATMOSPHERE.groundRadius + altitudeKm, Math.sin(elevation), T);
  let scale = 1, glow = 0;
  if (sunLeads) {
    const sunDeg = elevation / DEG, radiance = luma(E[0] * T[0], E[1] * T[1], E[2] * T[2]) / Math.PI;
    // ...and never so bright on screen that a sunlit cloud burns to white: at golden hour, exposed for the shaded
    // street, the sunward faces stay peach (the renderer's curve keeps their hue up to about this level)
    const cap = Math.min(9.2 * Math.pow(luma(env.skyMean[0], env.skyMean[1], env.skyMean[2]), 1.49), SUNLIT_CLOUD_DISPLAY_CAP / (env.exposure * CLOUD_ALBEDO));
    scale = Math.min(1, cap / Math.max(radiance, 1e-6));
    glow = 5.0 * luma(env.skyHorizon[0], env.skyHorizon[1], env.skyHorizon[2]) * smoothstep(1.5, -2.5, sunDeg) * smoothstep(HANDOVER_DEG, HANDOVER_DEG + 2.5, sunDeg);
  } else {
    scale = smoothstep(HANDOVER_DEG, HANDOVER_DEG - 2.5, env.sunElevation / DEG);   // the moon fades in from the hand-over: no pop
  }
  for (let k = 0; k < 3; k++) out[o + k] = E[k] * T[k] * scale + AFTERGLOW[k] * glow;
}

/**
 * Fill `out` (Float32Array of SKY_BLOCK_FLOATS) from the environment and the module state. Allocation-free.
 */
export function packSkyBlock(env, state, out) {
  const luts = atmosphereLuts(), w = env.weather;
  const sunDeg = env.sunElevation / DEG, sunLeads = sunDeg > HANDOVER_DEG;
  put(out, 'uSkySunDir', env.sunDir[0], env.sunDir[1], env.sunDir[2], env.moonPhase);
  put(out, 'uSkyMoonDir', env.moonDir[0], env.moonDir[1], env.moonDir[2], env.starAngle);
  put(out, 'uSkySunScatter', env.sunScatter[0], env.sunScatter[1], env.sunScatter[2], sunLeads ? 1 : 0);
  put(out, 'uSkyMoonScatter', env.moonScatter[0], env.moonScatter[1], env.moonScatter[2], env.night);
  put(out, 'uSkySunLight', env.sunLight[0], env.sunLight[1], env.sunLight[2], env.overcast);
  put(out, 'uSkyMoonLight', env.moonLight[0], env.moonLight[1], env.moonLight[2], env.storm);

  const body = sunLeads ? env.sunDir : env.moonDir;
  lightAtAltitude(luts, CUMULUS_KM, env, sunLeads, out, OFFSET.uSkyCloudLight);
  lightAtAltitude(luts, CIRRUS_KM, env, sunLeads, out, OFFSET.uSkyCirrusLight);
  // Cloud shadows on the ground only make sense under broken cloud with a body above the horizon.
  out[OFFSET.uSkyCloudLight + 3] = env.interior ? 0 : 0.82 * (1 - env.overcast) * smoothstep(0.03, 0.2, env.lightDir[1]);
  out[OFFSET.uSkyCirrusLight + 3] = lowSunTone(env.sunElevation / DEG);
  put(out, 'uSkyCloudDir', body[0], body[1], body[2], (0.30 + 0.55 * w.clouds) * (1 - 0.5 * env.storm));

  put(out, 'uSkyAmbient', env.skyMean[0], env.skyMean[1], env.skyMean[2], env.switches.street);
  put(out, 'uSkyDeck', env.deckLight[0], env.deckLight[1], env.deckLight[2], w.fog);
  put(out, 'uSkyGround', env.ambientGround[0], env.ambientGround[1], env.ambientGround[2], twilightTone(env.sunElevation / DEG));
  put(out, 'uSkyFogColor', env.fogColor[0], env.fogColor[1], env.fogColor[2], env.fogDensity);
  // share of the deck colour in the fog: squared towards 1 so that not even the glare of the sun leaks through a full deck
  const clearShare = 1 - Math.max(env.overcast, 0.6 * w.fog);
  put(out, 'uSkyFogParams', 1 / env.fogHeight, 1 - clearShare * clearShare, w.lightning, w.rain);
  put(out, 'uSkyNight', env.nightSky[0], env.nightSky[1], env.nightSky[2], env.switches.street);

  cloudLayer(env.overcast, env.storm, layer, w.clouds);
  put(out, 'uSkyCloud', w.clouds, mix(0.011, 0.024, env.overcast), layer[0], layer[1]);
  put(out, 'uSkyCloudOffset', state.cloudOffset[0], state.cloudOffset[1], state.cloudOffset[2], state.cloudOffset[3]);
  put(out, 'uSkyCity', state.city[0], state.city[1], state.city[2], 0);
  // Sea-breeze storms over the mainland: little in the morning, fully built by mid afternoon, collapsing from the late
  // afternoon so that by golden hour only sinking remnants stand along the horizon and the low sun is in open sky.
  // A fair sky has a few, a sky full of cumulus has a wall of them, and under a deck nobody can see them.
  const building = smoothstep(9, 15, env.timeOfDay) * (1 - smoothstep(17, 19.5, env.timeOfDay));
  const towers = (0.3 + 0.7 * building) * (0.45 + 0.55 * saturate(w.clouds * 2)) * (1 - env.overcast);
  put(out, 'uSkyCloudMapA', state.cloudMapA[0], state.cloudMapA[1], state.cloudMapA[2], state.cloudMapShare);
  put(out, 'uSkyCloudMapB', state.cloudMapB[0], state.cloudMapB[1], state.cloudMapB[2], towers);
  put(out, 'uSkyCloudBake', state.cloudBake[0], state.cloudBake[1], state.cloudBake[2], state.cloudBake[3]);
  put(out, 'uSkyStrike', env.strike[0], env.strike[1], env.strike[2], env.strike[3]);
  put(out, 'uSkyCoast', state.coast[0], state.coast[1], state.coast[2], state.coast[3]);

  // Lamp glow only while the lamps burn: the switch scales every term here, the shaders use them as they come.
  // (A closed room has its lamps on and no sky for them to glow in.)
  const lamps = env.interior ? 0 : env.switches.street, g = state.glow;
  put(out, 'uSkyGlow', g[0] * lamps, g[1] * lamps, g[2] * lamps, g[3] * lamps);
  put(out, 'uSkyGlowLobe', g[4] * lamps, g[5] * lamps, 0, 0);
  put(out, 'uSkyGlowMap', state.glowFrame[0], state.glowFrame[1], state.glowFrame[2], 0);

  const windSpeed = Math.hypot(w.wind[0], w.wind[1]);
  put(out, 'uSkySea', windSpeed, state.seaState >= 0 ? state.seaState : seaState(windSpeed, env.storm), state.waveClock, 0);
  put(out, 'uSkySeaDir', state.seaWind[0], state.seaWind[1], state.quality, 0);
  return out;
}

/** 0 = glassy, 0.35 = an ordinary trade-wind day, 1 = storm. */
export function seaState(windSpeed, storm) {
  return saturate(0.08 + 0.055 * windSpeed + 0.25 * storm);
}
