// Cumulus clouds. They are marched through a volume with many steps, which is far too much work for every pixel of
// every frame, and they change slowly: so the march fills a map of the upper hemisphere a few tiles per frame
// (../clouds.js), and the dome and the environment probe only look the map up (SKY_CLOUD_LOOKUP).
// Sources here are BODIES; programs.js prepends the host head, the Frame block, lib.js and the chunks from common.js.
import { CITY_GLOW } from '../environment.js';

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };

/** Distance (m) west of the city centre at which the line of towering cumulus stands, and half its depth. */
export const TOWER_LINE = Object.freeze({ distance: 42000, halfDepth: 12000, base: 900, top: 7600 });

/**
 * The hemisphere map. Layout: the upper half of an octahedron unfolded onto the square, zenith in the centre and the
 * horizon along the four edges, so the horizon (where most cloud is seen) gets the longest row of texels and there
 * is no pole. Texel = premultiplied radiance in rgb, transmittance in a.
 */
export const SKY_CLOUD_MAPPING = /* glsl */`
vec2 skyHemiUv(vec3 d) {
  d.y = max(d.y, 0.0);
  vec2 p = d.xz / (abs(d.x) + d.y + abs(d.z));
  return vec2(p.x + p.y, p.x - p.y) * 0.5 + 0.5;
}
vec3 skyHemiDir(vec2 uv) {
  vec2 e = uv * 2.0 - 1.0, p = vec2(e.x + e.y, e.x - e.y) * 0.5;
  return normalize(vec3(p.x, max(1.0 - abs(p.x) - abs(p.y), 0.0), p.y));
}
// Distance (km) from radius r0 along zenith cosine mu to the shell of radius R > r0, written to survive float32.
float skyShell(float r0, float mu, float R) { float d = (R - r0) * (R + r0), b = r0 * mu; return d / (b + sqrt(b * b + d)); }
`;

/**
 * Reading the map from the screen or the probe. Two maps exist: one is shown while the other is refilled, then the
 * view fades across. Each was marched from where the camera stood and where the clouds had drifted to at that
 * moment; uSkyCloudMapA/B.xyz carry how far camera and clouds have moved since, and the lookup direction is corrected
 * for it at the height where most of the cloud is, so the layer neither swims nor jumps while driving under it.
 */
export const SKY_CLOUD_LOOKUP = SKY_CLOUD_MAPPING + /* glsl */`
uniform sampler2D uSkyCloudsA, uSkyCloudsB;
// rgb = radiance scattered towards the eye (premultiplied), a = transmittance. where = world xz of the cloud seen.
vec4 skyClouds(vec3 dir, out vec2 where) {
  where = uCamPos.xz;
  if (dir.y <= 0.004) return vec4(0.0, 0.0, 0.0, 1.0);
  float level = uSkyCloud.z + 0.3 * (uSkyCloud.w - uSkyCloud.z), r0 = SKY_RG + max(uCamPos.y, 1.0) * 1e-3;
  vec3 rel = dir * min(skyShell(r0, dir.y, SKY_RG + level * 1e-3) * 1e3, 60000.0);
  where += rel.xz;
  float shareB = uSkyCloudMapA.w;
  vec4 c = vec4(0.0);
  if (shareB < 1.0) c += (1.0 - shareB) * textureLod(uSkyCloudsA, skyHemiUv(normalize(rel + uSkyCloudMapA.xyz)), 0.0);
  if (shareB > 0.0) c += shareB * textureLod(uSkyCloudsB, skyHemiUv(normalize(rel + uSkyCloudMapB.xyz)), 0.0);
  return c;
}
`;

/** The light a city throws at the sky at night, for the march (cloud bases). */
export const SKY_CITY_LIGHT = /* glsl */`
const vec3 SKY_CITY_GLOW = vec3(${CITY_GLOW.map((c) => f(c / CITY_GLOW[0])).join(', ')});   // sodium, the colour environment.js uses
uniform sampler2D uSkyGlowPlan;   // how brightly each part of the map is lit 0..1 (glow.js)
// How much lamp light there is under a world xz position.
float skyCityAmount(vec2 xz) { return textureLod(uSkyGlowPlan, (xz - uSkyGlowMap.xy) * uSkyGlowMap.z, 0.0).r; }
`;

/** The march itself: density, lighting, the two layers. Only the map-filling program includes this. */
export const SKY_CLOUD_VOLUME = /* glsl */`
uniform mediump sampler3D uSkyVolume;   // r billows, g turrets; tiles in all directions (noise.js)
// Sampled at level 0 throughout: the march jitters its depth per texel, so derivatives would choose a blurred mip.

// Height of a cloud's head as a share of the layer: rising steeply at the rim and levelling off towards the heart of
// the cloud, which gives mounds rather than cones.
float skyCloudTop(float cover) { return mix(0.1 + 0.9 * cover * (2.0 - cover), 1.0, 0.8 * uSkySunLight.w); }

// Share 0..1 of solid cloud at p = (drifted world x, height above the base, drifted world z) in metres, at height
// fraction hN of the layer. The plan-view signal says where cloud stands and how tall; within that envelope (flat
// base, steep sides, rounded head) cloud exists where the billow noise exceeds what the envelope still asks for, so
// the outline is made of whole lobes rather than of the envelope. Three scales of turrets then swell and eat the
// surface by about as much as they are wide, which is what makes cumulus a cauliflower and frays its edges.
// detail: SKY_CLOUD_MEAN = the smooth body (far shadow samples), SKY_CLOUD_FULL = with turrets, SKY_CLOUD_BOUND =
// 1 wherever the full body could be anything but empty (what the march strides through clear air with).
const int SKY_CLOUD_MEAN = 0, SKY_CLOUD_FULL = 1, SKY_CLOUD_BOUND = 2;
const vec3 SKY_TURRET_SCALE = vec3(1.0 / 900.0, 1.0 / 290.0, 1.0 / 95.0), SKY_TURRET_WEIGHT = vec3(0.42, 0.30, 0.18);
const float SKY_TURRET_MID = 0.6;   // the turret noise swells the body above this value and eats it below
// relief = how far the turrets push the surface out (+) or cut into it (-) here, about -0.5..0.4; 0 unless FULL.
// Flat-bottomed heaps are wider than they are tall, so the billows are sampled squashed.
float skyCloudBody(float cover, float hN, vec3 p, int detail, out float relief) {
  float deck = uSkySunLight.w;
  relief = 0.0;
  if (cover <= 0.0) return 0.0;
  float billow = textureLod(uSkyVolume, p * vec3(1.0 / 1700.0, 1.0 / 1150.0, 1.0 / 1700.0), 0.0).r;
  // each lobe pushes its own head up or leaves a saddle: the skyline of a cloud is lumpy, not one mound
  float h = hN / (skyCloudTop(cover) * mix(0.62 + 0.76 * billow, 1.0, deck));
  if (h >= 1.0) return 0.0;
  float envelope = smoothstep(0.0, 0.07, h) * saturate((1.0 - h) * 1.7) * smoothstep(0.0, 0.3, cover);
  float d = billow - (1.0 - 1.35 * envelope) * (1.0 - 0.6 * deck);
  // the base stays flat: condensation starts at one level, the ragged growth is above it. A deck is only mottled.
  float rough = (1.0 - 0.6 * deck) * (0.3 + 0.7 * smoothstep(0.0, 0.3, h));
  float swell = (1.0 - SKY_TURRET_MID) * (SKY_TURRET_WEIGHT.x + SKY_TURRET_WEIGHT.y + SKY_TURRET_WEIGHT.z) * rough;
  if (d + swell <= 0.0) return 0.0;
  if (detail == SKY_CLOUD_BOUND) return 1.0;
  if (detail == SKY_CLOUD_FULL) {
    vec3 turret = vec3(textureLod(uSkyVolume, p * SKY_TURRET_SCALE.x, 0.0).g, textureLod(uSkyVolume, p.zxy * SKY_TURRET_SCALE.y, 0.0).g,
      textureLod(uSkyVolume, p.yzx * SKY_TURRET_SCALE.z, 0.0).g);
    relief = dot(turret - SKY_TURRET_MID, SKY_TURRET_WEIGHT) * rough;
    d += relief;
  }
  // the last factor removes the hair-thin filaments that the highest noise peaks would leave around a cloud
  return saturate(d * 3.0) * smoothstep(0.02, 0.12, envelope);
}

// Light scattered out of a cloud towards the eye per unit of what the body receives, for an optical depth tau between
// the sample and the light. A sum of ever more diffuse, ever more penetrating shares: the lit skin, the glow a few
// hundred metres in, and the little that crosses a whole cloud (most of that goes back the way it came, so a
// back-lit body is dark); plus the forward lobe that makes silver linings at thin edges.
// front = 1 looking down-light at a lit face, 0 into the light.
float skyCloudScatter(float tau, float front, float lobe) {
  return 0.50 * exp(-tau) + 0.27 * exp(-0.3 * tau) + (0.06 + 0.14 * front) * exp(-0.06 * tau) + 0.3 * lobe * exp(-1.2 * tau);
}

// How the march walks: in long strides through clear air, testing only for the smooth body, and from one stride
// before any cloud in short steps about as wide as a texel of the map at that range. Short steps and a dense body are
// what give cumulus its hard cauliflower surface; long ones would average it into putty.
// stride.x = long stride and stride.y = short step, both as a share of the distance travelled.
const vec2 SKY_CLOUD_STRIDE = vec2(0.018, 0.0028);
// Light inside a cloud is scattered many times and reaches far deeper than a single ray is seen to: the eye meets a
// wall where the light meets a fog. Extinction along the view ray is this many times the one used towards the light.
const float SKY_CLOUD_SOLID = 3.2;

// The cumulus layer seen from origin (xz already carries the drift since the map's snapshot, see uSkyCloudBake).
// rgb = radiance scattered towards the eye (premultiplied), a = transmittance. tMean = mean distance (m).
// budget = most steps to take, coarsen = 1 at full quality, more to save work.
vec4 skyCumulus(vec3 dir, vec3 origin, float jitter, int budget, float coarsen, out float tMean) {
  tMean = 0.0;
  if (dir.y <= 0.004 || uSkyCloud.x <= 0.001) return vec4(0.0, 0.0, 0.0, 1.0);
  float base = uSkyCloud.z, top = uSkyCloud.w, thick = top - base, r0 = SKY_RG + max(origin.y, 1.0) * 1e-3;
  float t0 = skyShell(r0, dir.y, SKY_RG + base * 1e-3) * 1e3, t1 = min(skyShell(r0, dir.y, SKY_RG + top * 1e-3) * 1e3, 60000.0);
  if (t0 >= t1) return vec4(0.0, 0.0, 0.0, 1.0);
  float ext = uSkyCloud.y;
  vec3 L = uSkyCloudDir.xyz; float cosA = dot(dir, L);
  float lobe = min(0.36 / pow(max(1.64 - 1.6 * cosA, 1e-3), 1.5), 6.0);
  vec3 sunE = uSkyCloudLight.rgb * (1.0 / PI);
  float deck = uSkySunLight.w, front = 0.5 - 0.5 * cosA;
  vec3 col = vec3(0.0); float T = 1.0, wSum = 0.0, gap = 0.0, relief, unused;
  bool inside = false;
  float t = t0 + max(t0 * SKY_CLOUD_STRIDE.x * coarsen, 50.0) * jitter, walked = t0;   // walked = how far the short steps have got
  for (int i = 0; i < budget && t < t1; i++) {
    float stride = max(t * SKY_CLOUD_STRIDE.x, 50.0) * coarsen, ds = max(t * SKY_CLOUD_STRIDE.y, 12.0) * coarsen;
    float fi = (t - t0) / (t1 - t0);
    vec2 xz = origin.xz + dir.xz * t;
    float cover = skyCloudCover(xz);
    vec3 p = vec3(xz.x + uSkyCloudOffset.x, fi * thick, xz.y + uSkyCloudOffset.y);
    float body = cover > 0.0 ? skyCloudBody(cover, fi, p, inside ? SKY_CLOUD_FULL : SKY_CLOUD_BOUND, relief) : 0.0;
    if (!inside) {
      // the bound contains the cloud, so a stride that finds nothing has missed nothing wider than itself
      // back to where the last stride began, but never over ground the short steps have already covered
      if (body > 0.0) { inside = true; gap = 0.0; t = max(t - stride + ds * jitter, walked); } else t += stride;
      continue;
    }
    t += ds; walked = t;
    if (body <= 0.002) { gap += ds; inside = gap < stride; continue; }
    gap = 0.0;
    // Optical depth towards the light: six widening samples joined by straight segments, so that the shade of an
    // edge above deepens gradually instead of in terraces. The nearest three include the turrets: small lobes shade
    // their neighbours and the lit face shows its relief.
    float tau = 0.0, sPrev = 0.0, bPrev = body;
    for (int j = 0; j < 6; j++) {
      float s = 28.0 * pow(1.75, float(j)), hq = fi + L.y * s / thick;
      bool outside = hq < 0.0 || hq > 1.0;
      float b = outside ? 0.0 : skyCloudBody(skyCloudCover(xz + L.xz * s), hq, p + L * s, j < 3 ? SKY_CLOUD_FULL : SKY_CLOUD_MEAN, unused);
      tau += 0.5 * (b + bPrev) * ext * (s - sPrev); sPrev = s; bPrev = b;
      if (outside) break;
    }
    // A cloud is darker low down, where the body above it shades it from the sky as well as from the sun.
    float low = mix(0.5 + 0.5 * smoothstep(0.0, 0.5, fi / skyCloudTop(cover)), 1.0, deck);
    // A turret that stands proud sees the whole sky and its neighbours' glow; the crease between two sees neither.
    // The shadow samples are too far apart to find creases a few tens of metres wide, so they are shaded from here.
    low *= 0.66 + 0.44 * smoothstep(-0.26, 0.2, relief);
    vec3 direct = sunE * skyCloudScatter(tau, front, lobe) * low;
    // Sky light from the sides and top; under a deck the diffused daylight instead, darker where the deck is heavy
    // (the mottled underside of an overcast, the black bellies of a storm); ground and city light from below.
    vec3 below = uSkyGround.rgb * (0.5 - 0.3 * deck) + SKY_CITY_GLOW * (0.07 * uSkyNight.w * skyCityAmount(xz));
    vec3 ambient = uSkyAmbient.rgb * (0.22 + 0.63 * fi) * low * (1.0 - deck) + below * (1.0 - fi) * (1.0 - fi);
    if (deck > 0.0) {
      float heavy = textureLod(uSkyNoise, (xz + uSkyCloudOffset.xy) * (1.0 / 8300.0) + 0.61, 0.0).b;
      ambient += uSkyDeck.rgb * (deck * mix(0.85, mix(0.5, 0.3, uSkyMoonLight.w), smoothstep(0.28, 0.72, heavy)));
    }
    float a = 1.0 - exp(-body * ext * SKY_CLOUD_SOLID * ds);
    col += T * a * (direct + ambient);
    tMean += T * a * t; wSum += T * a;
    T *= 1.0 - a;
    if (T < 0.015) { T = 0.0; break; }
  }
  tMean = wSum > 0.0 ? tMean / wSum : t0;
  return vec4(col, T);
}

// ---- The line of towering cumulus over the mainland: sea-breeze storms that build inland through the afternoon and
// stand along the western horizon, several kilometres tall and too far away to ever drift overhead.
const float SKY_TOWER_AXIS = ${f(TOWER_LINE.distance)}, SKY_TOWER_DEPTH = ${f(TOWER_LINE.halfDepth)}, SKY_TOWER_BASE = ${f(TOWER_LINE.base)}, SKY_TOWER_TOP = ${f(TOWER_LINE.top)};
// Solid share at a world position (metres).
// The same construction as the cumulus overhead, ten times the size: lobes kilometres across, turrets from two
// kilometres down to what a texel of the map still shows at that range.
float skyTowerBody(vec3 w, int detail, out float relief) {
  relief = 0.0;
  float across = abs(uSkyCity.x - SKY_TOWER_AXIS - w.x) / SKY_TOWER_DEPTH;
  if (across >= 1.0 || w.y <= SKY_TOWER_BASE) return 0.0;
  // cells along the line, each as tall as it is strong
  float cell = textureLod(uSkyNoise, w.xz * (1.0 / 60000.0) + 0.19, 0.0).r * (1.0 - smoothstep(0.3, 1.0, across));
  float cover = saturate((cell - mix(0.82, 0.34, uSkyCloudMapB.w)) * 3.2);
  if (cover <= 0.0) return 0.0;
  vec3 p = vec3(w.x, w.y - SKY_TOWER_BASE, w.z);
  float billow = textureLod(uSkyVolume, p * vec3(1.0 / 17000.0, 1.0 / 11500.0, 1.0 / 17000.0), 0.0).r;
  // a line past its peak (uSkyCloudMapB.w small) is also a low one: the towers sink as they decay
  float h = p.y / ((SKY_TOWER_TOP - SKY_TOWER_BASE) * (0.15 + 0.85 * cover * (2.0 - cover)) * (0.62 + 0.76 * billow) * mix(0.35, 1.0, uSkyCloudMapB.w));
  if (h >= 1.0) return 0.0;
  float envelope = smoothstep(0.0, 0.04, h) * saturate((1.0 - h) * 1.7) * smoothstep(0.0, 0.3, cover);
  float d = billow - (1.0 - 1.35 * envelope);
  float rough = 0.3 + 0.7 * smoothstep(0.0, 0.15, h);
  float swell = (1.0 - SKY_TURRET_MID) * (SKY_TURRET_WEIGHT.x + SKY_TURRET_WEIGHT.y + SKY_TURRET_WEIGHT.z) * rough;
  if (d + swell <= 0.0) return 0.0;
  if (detail == SKY_CLOUD_BOUND) return 1.0;
  if (detail == SKY_CLOUD_FULL) {
    vec3 turret = vec3(textureLod(uSkyVolume, p * (1.0 / 9000.0), 0.0).g, textureLod(uSkyVolume, p.zxy * (1.0 / 2900.0), 0.0).g,
      textureLod(uSkyVolume, p.yzx * (1.0 / 950.0), 0.0).g);
    relief = dot(turret - SKY_TURRET_MID, SKY_TURRET_WEIGHT) * rough;
    d += relief;
  }
  return saturate(d * 3.0) * smoothstep(0.02, 0.12, envelope);
}
vec4 skyTowers(vec3 dir, vec3 origin, float jitter, int budget, float coarsen, out float tMean) {
  tMean = 0.0;
  float axis = uSkyCity.x - SKY_TOWER_AXIS;
  if (uSkyCloudMapB.w <= 0.001 || dir.x >= -0.02 || dir.y <= 0.002 || origin.x <= axis + SKY_TOWER_DEPTH) return vec4(0.0, 0.0, 0.0, 1.0);
  float t0 = (axis + SKY_TOWER_DEPTH - origin.x) / dir.x, t1 = min((axis - SKY_TOWER_DEPTH - origin.x) / dir.x, (SKY_TOWER_TOP - origin.y) / dir.y);
  if (t0 >= t1) return vec4(0.0, 0.0, 0.0, 1.0);
  const float ext = 0.0045;
  vec3 L = uSkyCloudDir.xyz; float cosA = dot(dir, L);
  float lobe = min(0.36 / pow(max(1.64 - 1.6 * cosA, 1e-3), 1.5), 6.0), front = 0.5 - 0.5 * cosA;
  vec3 sunE = uSkyCloudLight.rgb * (1.0 / PI);
  vec3 col = vec3(0.0); float T = 1.0, wSum = 0.0, gap = 0.0, relief, unused;
  bool inside = false;
  float t = t0 + t0 * SKY_CLOUD_STRIDE.x * coarsen * jitter, walked = t0;
  for (int i = 0; i < budget && t < t1; i++) {
    float stride = t * SKY_CLOUD_STRIDE.x * coarsen, ds = t * SKY_CLOUD_STRIDE.y * coarsen;
    vec3 w = origin + dir * t;
    float body = skyTowerBody(w, inside ? SKY_CLOUD_FULL : SKY_CLOUD_BOUND, relief);
    if (!inside) {
      if (body > 0.0) { inside = true; gap = 0.0; t = max(t - stride + ds * jitter, walked); } else t += stride;
      continue;
    }
    t += ds; walked = t;
    if (body <= 0.002) { gap += ds; inside = gap < stride; continue; }
    gap = 0.0;
    float tau = 0.0, sPrev = 0.0, bPrev = body;
    for (int j = 0; j < 5; j++) {
      float s = 130.0 * pow(2.1, float(j)), b = skyTowerBody(w + L * s, j < 2 ? SKY_CLOUD_FULL : SKY_CLOUD_MEAN, unused);
      tau += 0.5 * (b + bPrev) * ext * (s - sPrev); sPrev = s; bPrev = b;
    }
    float hN = saturate((w.y - SKY_TOWER_BASE) / (SKY_TOWER_TOP - SKY_TOWER_BASE));
    // the foot of a storm cell stands in its own rain and shade
    float low = (0.4 + 0.6 * smoothstep(0.0, 0.3, hN)) * (0.66 + 0.44 * smoothstep(-0.26, 0.2, relief));
    vec3 lit = sunE * skyCloudScatter(tau, front, lobe) * low + uSkyAmbient.rgb * (0.25 + 0.6 * hN) * low + uSkyGround.rgb * 0.3 * (1.0 - hN);
    float a = 1.0 - exp(-body * ext * SKY_CLOUD_SOLID * ds);
    col += T * a * lit;
    tMean += T * a * t; wSum += T * a;
    T *= 1.0 - a;
    if (T < 0.015) { T = 0.0; break; }
  }
  tMean = wSum > 0.0 ? tMean / wSum : t0;
  return vec4(col, T);
}
`;

/**
 * Fills the hemisphere map. uSkyCloudBake: xyz = where the march starts (the camera of the snapshot, shifted by what
 * the clouds have drifted since so that the current drift in the Sky block lands them where they were), w = jitter phase.
 */
export const SKY_CLOUD_FS = /* glsl */`
in vec2 vUv;
out vec4 outColor;
// Cloud sinks into the air in front of it: what is lost on the way is replaced by the sky's own light.
vec4 skyThroughAir(vec4 cloud, float dist, vec3 clear) {
  float air = exp(-dist * 2.4e-5);
  return vec4(cloud.rgb * air + clear * ((1.0 - cloud.a) * (1.0 - air)), cloud.a);
}
void main() {
  vec3 dir = skyHemiDir(vUv), origin = uSkyCloudBake.xyz;
  // interleaved gradient noise: neighbouring texels take evenly spread offsets, and every refill takes new ones
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uSkyCloudBake.w);
  // quality buys finer steps; the budget only has to cover the longest walk at that fineness
  float q = uSkySeaDir.z, coarsen = q > 0.75 ? 1.0 : (q > 0.35 ? 1.5 : 2.2);
  int budget = q > 0.75 ? 420 : (q > 0.35 ? 300 : 210);
  vec3 clear = skyClear(dir) + uSkyNight.rgb;
  float tNear, tFar;
  vec4 near = skyThroughAir(skyCumulus(dir, origin, jitter, budget, coarsen, tNear), tNear, clear);
  vec4 far = skyThroughAir(skyTowers(dir, origin, jitter, budget, coarsen, tFar), tFar, clear);
  outColor = vec4(min(near.rgb + near.a * far.rgb, vec3(6.0e4)), near.a * far.a);
}`;
