// GLSL shared by every sky program and, as SKY_CHUNK, pasted into the renderer's own shaders (host.js section 4).
// Every global name starts with sky / uSky / env / uEnv / fog so that it cannot collide with renderer or lib names.
import { ATMOSPHERE, HAZE_LOBE } from '../atmosphere.js';
import { CITY_GLOW } from '../environment.js';

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

/** Size of the sky-view table: two stacked halves (see SKY_VIEW_LOOKUP). */
export const SKY_VIEW_SIZE = Object.freeze([192, 192]);
/** Number of roughness steps in the environment map: lod = roughness * ENV_ROUGH_MIPS. */
export const ENV_ROUGH_MIPS = 5;

/**
 * The `Sky` uniform block (std140, binding 1). Field order here is the layout; block.js writes the same order.
 * All directions are unit vectors in world space pointing TOWARDS the body.
 */
export const SKY_BLOCK_FIELDS = Object.freeze([
  'uSkySunDir',        // xyz sun, w = lit fraction of the moon's disc
  'uSkyMoonDir',       // xyz moon, w = rotation of the star field (radians)
  'uSkySunScatter',    // rgb = sun irradiance above the air that drives scattering (twilight lift included), w = 1 when the aerosol half of the sky-view table belongs to the sun, 0 moon
  'uSkyMoonScatter',   // rgb likewise for the moon, w = night 0..1
  'uSkySunLight',      // rgb = sun irradiance at the ground through the weather, w = overcast 0..1
  'uSkyMoonLight',     // rgb = moon irradiance at the ground, w = storm 0..1
  'uSkyCloudLight',    // rgb = irradiance on the cumulus layer from the body that lights it, w = cloud-shadow strength on the ground 0..1
  'uSkyCloudDir',      // xyz = direction to that body, w = cirrus amount 0..1
  'uSkyCirrusLight',   // rgb = irradiance on the cirrus layer, w = strength of the low-sun tone 0..1 (environment.lowSunTone)
  'uSkyAmbient',       // rgb = mean sky radiance above the clouds (clear air), w = street-lamp switch 0..1
  'uSkyDeck',          // rgb = radiance of the underside of a full cloud deck in this weather, w = fog weather 0..1
  'uSkyGround',        // rgb = radiance of the ground seen from above, w = strength of the twilight split tone 0..1 (environment.twilightTone)
  'uSkyFogColor',      // rgb = fog colour when a deck or fog hides the sky, w = fog density at sea level (1/m)
  'uSkyFogParams',     // x = 1 / scale height (1/m), y = share of uSkyFogColor in the fog colour (0 = clear: the horizon of the sky table), z = lightning flash 0..1, w = rain 0..1
  'uSkyNight',         // rgb = night floor radiance of the sky, w = city glow strength 0..1
  'uSkyCloud',         // x = coverage 0..1, y = extinction of solid cloud (1/m), z = base altitude (m), w = top altitude (m)
  'uSkyCloudOffset',   // xy = drift of the cumulus layer (m), zw = drift of the cirrus layer (m)
  'uSkyCity',          // xy = centre of the city (world xz), z = 1 / radius, w = unused
  'uSkyCloudMapA',     // xyz = how far camera and clouds have moved since cloud map A was marched (m), w = share of map B on screen 0..1
  'uSkyCloudMapB',     // xyz = likewise for map B, w = towering cumulus over the mainland 0..1
  'uSkyCloudBake',     // xyz = start of the march filling a cloud map (glsl/clouds.js), w = jitter phase
  'uSkyStrike',        // xy = last lightning strike (world xz), z = age (s, negative = none), w = seed
  'uSkyCoast',         // xy = world xz of the coast map's first texel corner, zw = 1 / extent (0 = no map)
  'uSkySea',           // x = wind speed (m/s), y = sea state 0..1 (calm .. storm), z = wave clock (s, wrapped), w = unused
  'uSkySeaDir',        // xy = unit direction the wind sea runs towards, z = quality 0..1, w = unused
  'uSkyGlow',          // the city's lamp light round the camera (glow.js), lamp switch included: x = lit amount of the place itself, y = lit air along a level sight line, mean over the compass (km), zw = how much more of it lies towards +x and +z
  'uSkyGlowLobe',      // xy = second harmonic of the same (cos and sin of twice the bearing), zw = unused
  'uSkyGlowMap',       // xy = world xz of the first texel corner of the lit plan (uSkyGlowPlan), z = 1 / extent, w = unused
]);
export const SKY_BLOCK = `layout(std140) uniform Sky {\n${SKY_BLOCK_FIELDS.map((n) => `  vec4 ${n};`).join('\n')}\n};\n`;

const A = ATMOSPHERE;
/** Atmosphere constants (kilometres) and the two static tables. Only sky programs include this; the renderer chunk does not. */
export const SKY_ATMOSPHERE = /* glsl */`
const float SKY_RG = ${f(A.groundRadius)}, SKY_RT = ${f(A.topRadius)};
const vec3 SKY_BETA_R = ${v3(A.rayleigh)};
const float SKY_BETA_MS = ${f(A.mieScattering)}, SKY_BETA_ME = ${f(A.mieScattering + A.mieAbsorption)};
const vec3 SKY_BETA_O = ${v3(A.ozone)};
const float SKY_HR = ${f(A.rayleighScaleHeight)}, SKY_HM = ${f(A.mieScaleHeight)}, SKY_OBSERVER = ${f(A.observerAltitude)};
uniform sampler2D uSkyTrans;   // transmittance table (atmosphere.js)
uniform sampler2D uSkyMulti;   // multiple-scattering table
float skyDistanceToTop(float r, float mu) { return max(0.0, -r * mu + sqrt(max(r * r * (mu * mu - 1.0) + SKY_RT * SKY_RT, 0.0))); }
// Transmittance from radius r (km) along zenith cosine mu to space, with the soft earth shadow of atmosphere.js.
vec3 skyTransmittance(float r, float mu) {
  float hAtm = sqrt(SKY_RT * SKY_RT - SKY_RG * SKY_RG), rho = sqrt(max(r * r - SKY_RG * SKY_RG, 0.0));
  float d = skyDistanceToTop(r, mu), dMin = SKY_RT - r, dMax = rho + hAtm;
  vec3 t = texture(uSkyTrans, vec2((d - dMin) / (dMax - dMin), rho / hAtm)).rgb;
  float horizon = -sqrt(max(1.0 - SKY_RG * SKY_RG / (r * r), 0.0));
  return t * smoothstep(0.0, 1.0, (mu - horizon + 0.006) / 0.012);
}
vec3 skyMultiScatter(float h, float mu) { return texture(uSkyMulti, vec2(mu * 0.5 + 0.5, sqrt(max(h, 0.0) / (SKY_RT - SKY_RG)))).rgb; }
`;

/**
 * Reading the sky-view table. Layout: u = compass azimuth (atan(z, x), wraps), v = sqrt(elevation / 90 deg) so the
 * horizon gets most of the rows. Lower half of the texture: Rayleigh + multiple scattering of both bodies (smooth).
 * Upper half: aerosol single scattering of the brighter body WITHOUT its phase function, which is applied here per
 * pixel so the glow round the sun stays sharp however small the table is.
 */
export const SKY_PHASE = /* glsl */`
float skyMiePhase(float c) {
  const float g = ${f(A.mieG)};
  return 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + c * c) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * c, 1e-4), 1.5));
}
// Wide lobe of the low-sun haze (environment.HAZE_LOBE): three times a Henyey-Greenstein phase of g = 0.35.
float skyHazePhase(float c) { return ${f(HAZE_LOBE.scale)} / pow(${f(HAZE_LOBE.offset)} - ${f(HAZE_LOBE.slope)} * c, 1.5); }
`;
export const SKY_VIEW_LOOKUP = /* glsl */`
uniform sampler2D uSkyView;
vec3 skyMieLightDir() { return uSkySunScatter.w > 0.5 ? uSkySunDir.xyz : uSkyMoonDir.xyz; }
// Clear-air radiance arriving from direction dir (clamped to the horizon), with the aerosol lobe evaluated towards lobeDir.
vec3 skyClearLobe(vec3 dir, vec3 lobeDir) {
  float el = asin(clamp(dir.y, 0.0, 1.0));
  float u = atan(dir.z, dir.x) * (1.0 / TAU) + 0.5;
  float v = (sqrt(el * (2.0 / PI)) * ${f(SKY_VIEW_SIZE[1] / 2 - 1)} + 0.5) / ${f(SKY_VIEW_SIZE[1])};
  vec3 smoothPart = textureLod(uSkyView, vec2(u, v), 0.0).rgb, mie = textureLod(uSkyView, vec2(u, v + 0.5), 0.0).rgb;
  float cosLight = dot(lobeDir, skyMieLightDir()), tone = uSkyGround.w, lowSun = uSkyCirrusLight.w;
  float side = smoothstep(-0.35, 0.85, dot(dir.xz, uSkySunDir.xz) / max(length(dir.xz) * length(uSkySunDir.xz), 1e-4));
  float low = 1.0 - smoothstep(0.16, 0.74, dir.y), belt = smoothstep(0.03, 0.13, dir.y) * (1.0 - smoothstep(0.16, 0.34, dir.y));
  // Humid sea air under a low sun (environment.lowSunTone): coarse droplets spread the reddened sunlight in a wide
  // lobe round the whole sky and hide the blue air behind it, most where the sun is. The aerosol of atmosphere.js is
  // the thin air aloft and stays as it is; this is the haze of the last hour, which turns the shade of a street warm
  // instead of noon blue. (CPU twin: environment.lowSunShade, which feeds the ambient light and the exposure.)
  vec3 c = smoothPart * (1.0 - lowSun * (0.25 + 0.3 * side * low)) + mie * (skyMiePhase(cosLight) + lowSun * skyHazePhase(cosLight));
  c = max(mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, ${f(A.skyChroma)}), 0.0);   // gradeSky of atmosphere.js
  // Twilight split tone, the signature of the place: scattering alone gives a lavender afterglow and a grey-violet
  // far side; the brief asks for coral and hot pink over the set sun and teal under a mauve band opposite.
  if (tone + lowSun > 0.0) {
    c.g *= 1.0 + tone * low * mix(0.75, -0.46 * (0.45 + 0.55 * smoothstep(0.0, 0.2, dir.y)), side) - 0.2 * lowSun * low * side;
    // Low sun, still up: amber (not yellow) round the sun, and opposite it the rose band over a lavender horizon that
    // the model, which knows nothing of the long red path the backscattered light has taken, leaves blue and bright.
    c.r *= 1.0 + tone * (0.5 * side * (1.0 - smoothstep(0.04, 0.32, dir.y)) + 1.2 * (1.0 - side) * belt) + lowSun * (1.0 - side) * (0.45 * belt + 0.1 * low);
    c.b *= 1.0 - 0.5 * lowSun * low * side;
    c *= 1.0 - 0.3 * lowSun * (1.0 - side) * low;
    // the tones above are pushed apart on purpose; what a camera records of a real dusk is greyer than that
    c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.0 - 0.3 * tone);
  }
  // The glare round a low sun in sea haze is tens of times brighter than the sky beside it. A camera answers with a
  // shoulder and burns out to white; the renderer's curve keeps the hue of anything bright (right for a red lamp,
  // wrong for the sky, which would stand as a flat orange disc). So the sky does its own: above display white it
  // pales towards neutral, fully by the time the renderer's curve has nothing left to show, and is rolled off to at
  // most a dozen times white: enough to bloom and to read as the sun's own light. Under a low sun the glare instead
  // keeps its amber and is held to hardly more than white, except for an aureole some ten degrees across that pales
  // towards the disc (dome.js, far brighter still), so the sky reads as colour and the sun as a glow within it.
  float peak = max(c.r, max(c.g, c.b)) * uSunColor.w;
  if (peak > 1.0) {
    float over = peak - 1.0, aureole = lowSun * smoothstep(0.90, 0.998, cosLight);
    vec3 pale = dot(c, vec3(0.2126, 0.7152, 0.0722)) * mix(vec3(1.0), vec3(1.0, 0.78, 0.5), lowSun - 0.5 * aureole);
    c = mix(c, pale, mix(0.92, mix(0.3, 0.7, aureole), lowSun) * over / (over + 1.4));
    c *= (1.0 + over / (1.0 + mix(0.09, mix(2.5, 0.45, aureole), lowSun) * over)) / peak;
  }
  return c;
}
vec3 skyClear(vec3 dir) { return skyClearLobe(dir, dir); }
`;

/** Fog and aerial perspective, cloud cover, environment lookups: the functions the renderer calls. */
export const SKY_SHARED = /* glsl */`
uniform samplerCube uEnvMap;   // prefiltered sky: lod = roughness * ${ENV_ROUGH_MIPS}. No sun or moon disc.
uniform samplerCube uEnvIrr;   // cosine-convolved sky (irradiance / PI)
uniform sampler2D uSkyNoise;   // noise.js

vec3 envSpecular(vec3 dir, float roughness) { return textureLod(uEnvMap, dir, clamp(roughness, 0.0, 1.0) * ${f(ENV_ROUGH_MIPS)}).rgb; }
vec3 envDiffuse(vec3 n) { return textureLod(uEnvIrr, n, 0.0).rgb; }

// The city's lamps on the night air, seen from the camera in a direction: sodium scattered back by the humid layer
// over the streets. Overhead there is only the depth of that layer to look through, and the glow of the place itself
// is kept faint there so that the zenith stays navy and the stars show; towards the horizon the line of sight runs
// through kilometres of it, wherever the city lies in that direction (the two harmonics of glow.js), and that is the
// rose-amber band low over a town, gone by some 25 degrees up.
vec3 skyCityGlow(vec3 dir) {
  float y = max(dir.y, 0.0), a = 5.0 * y, h = length(dir.xz);
  vec2 to = h > 1e-4 ? dir.xz / h : vec2(1.0, 0.0);
  float far = max(uSkyGlow.y + dot(uSkyGlow.zw, to) + uSkyGlowLobe.x * (to.x * to.x - to.y * to.y) + uSkyGlowLobe.y * 2.0 * to.x * to.y, 0.0);
  return ${v3(CITY_GLOW)} * (0.04 * uSkyGlow.x * (a < 1e-3 ? 1.0 : (1.0 - exp(-a)) / a) + far * exp(-11.0 * y));
}

// Colour the air takes on looking in a direction: the horizon of the clear sky in that compass direction (so distant
// buildings dissolve into exactly the sky behind them, lamp glow included), or the deck colour when cloud or fog hides the sky.
vec3 fogColorTowards(vec3 dir) {
  float h = length(dir.xz);
  vec3 flat3 = h > 1e-4 ? vec3(dir.x / h * 0.9986, 0.0523, dir.z / h * 0.9986) : vec3(0.9986, 0.0523, 0.0);   // 3 degrees up
  vec3 clear = skyClearLobe(flat3, normalize(vec3(dir.x, max(dir.y, 0.0), dir.z))) + uSkyNight.rgb + skyCityGlow(flat3);
  return mix(clear, uSkyFogColor.rgb, uSkyFogParams.y);
}
// Optical depth of the exponential height fog from the camera along dir for a distance (metres).
float fogDepth(vec3 dir, float dist) {
  float k = uSkyFogParams.x, a = dir.y * dist * k;
  float slab = abs(a) < 1e-3 ? 1.0 - 0.5 * a : (1.0 - exp(-a)) / a;
  return uSkyFogColor.w * dist * exp(-max(uCamPos.y, 0.0) * k) * slab;
}
vec4 skyFog(vec3 rel) {
  float dist = length(rel); vec3 dir = rel / max(dist, 1e-4);
  float t = exp(-fogDepth(dir, dist));
  return vec4(fogColorTowards(dir) * (1.0 - t), t);
}

// Plan-view cloud signal at a world xz position (metres): 0 clear, 1 the thickest part of a cloud.
float skyCloudCover(vec2 xz) {
  vec2 q = xz + uSkyCloudOffset.xy;
  // Explicit level 0: the cloud march calls this at jittered depths, where screen derivatives are meaningless and
  // would pick a blurred mip. The texels are 32 m and 180 m wide, far below what a pixel covers at these ranges.
  float shape = textureLod(uSkyNoise, q * (1.0 / 6000.0), 0.0).r;
  // weather-scale variation, turned so that the two tilings never line up: clear lanes, banks, no visible repeat
  float weather = textureLod(uSkyNoise, vec2(q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8) * (1.0 / 47000.0) + 0.37, 0.0).b;
  float n = shape * 0.56 + weather * 0.44;
  // The sea breeze keeps the shore itself clearer than its surroundings: cumulus gathers over the warm current
  // offshore and over the heated land to the west, so even a fair day has its row of cloud along the horizon.
  float gathered = smoothstep(1.6, 5.0, length(xz - uSkyCity.xy) * uSkyCity.z) * (1.0 - uSkySunLight.w);
  // A fair day is not an empty sky: by the time any cloud is asked for there is a field of small cumulus (about a
  // sixth of the sky), which then fills in steadily towards an overcast.
  float amount = uSkyCloud.x, fair = smoothstep(0.0, 0.12, amount) * (1.0 - smoothstep(0.12, 0.5, amount));
  // Fair-weather cumulus is convection: it has not built yet at sunrise and decays as the land cools towards sunset,
  // the distant banks first, so a low sun stands in open sky (environment.lowSunTone) instead of behind a wall of cloud.
  float settled = uSkyCirrusLight.w;
  return saturate((n - mix(0.78, 0.10, amount) + 0.10 * fair * (1.0 - 0.4 * settled) + 0.07 * gathered * (1.0 - 0.85 * settled)) * 2.8);
}
// Shade of drifting clouds on the ground: 1 in the open, lower under a cloud. rel = camera-relative world position.
#define SKY_CLOUD_SHADOW 1
float skyCloudShadow(vec3 rel) {
  vec3 l = uSunDir.xyz; float strength = uSkyCloudLight.w;
  if (strength <= 0.0) return 1.0;
  vec3 w = rel + uCamPos.xyz;
  vec2 xz = w.xz + l.xz * ((uSkyCloud.z + 400.0 - w.y) / max(l.y, 0.12));
  return 1.0 - strength * smoothstep(0.15, 0.75, skyCloudCover(xz));
}
`;

/** The chunk handed to the renderer. */
export const SKY_CHUNK = SKY_BLOCK + SKY_PHASE + SKY_VIEW_LOOKUP + SKY_SHARED;
