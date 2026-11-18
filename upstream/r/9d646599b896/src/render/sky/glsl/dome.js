// Sky programs: the sky-view scattering pass, the dome (screen and environment-probe variants) and the two probe filters.
// Sources here are BODIES; index.js prepends the host head, the Frame block, lib.js and the chunks from common.js.
import { ATMOSPHERE } from '../atmosphere.js';
import { STREET_AIR, STREET_FILL } from '../environment.js';
import { SKY_VIEW_SIZE } from './common.js';

const f = (x) => { const s = String(x); return /[.e]/.test(s) ? s : s + '.0'; };
const v3 = (a) => `vec3(${a.map(f).join(', ')})`;

/** Single scattering of the sun and the moon into the sky-view table (layout: SKY_VIEW_LOOKUP in common.js). */
export const SKY_VIEW_FS = /* glsl */`
out vec4 outColor;
void main() {
  const float ROWS = ${f(SKY_VIEW_SIZE[1] / 2)};
  bool mieHalf = gl_FragCoord.y >= ROWS;
  float vv = clamp(((mieHalf ? gl_FragCoord.y - ROWS : gl_FragCoord.y) - 0.5) / (ROWS - 1.0), 0.0, 1.0);
  float el = vv * vv * (0.5 * PI), az = (gl_FragCoord.x / ${f(SKY_VIEW_SIZE[0])} - 0.5) * TAU;
  vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 sun = uSkySunDir.xyz, moon = uSkyMoonDir.xyz;
  bool sunMain = uSkySunScatter.w > 0.5;
  float cs = dot(dir, sun), cm = dot(dir, moon);
  float pRs = 3.0 / (16.0 * PI) * (1.0 + cs * cs), pRm = 3.0 / (16.0 * PI) * (1.0 + cm * cm);
  float pOther = skyMiePhase(sunMain ? cm : cs);
  float r0 = SKY_RG + SKY_OBSERVER, tMax = skyDistanceToTop(r0, dir.y), tPrev = 0.0;
  vec3 T = vec3(1.0), smoothSum = vec3(0.0), mieSum = vec3(0.0);
  const int STEPS = 40;
  for (int i = 0; i < STEPS; i++) {
    // quadratic spacing: the dense air near the observer carries most of the detail (same rule as atmosphere.js)
    float f1 = float(i + 1) / float(STEPS), tNext = tMax * f1 * f1, dt = tNext - tPrev, t = tPrev + 0.5 * dt; tPrev = tNext;
    vec3 p = vec3(0.0, r0, 0.0) + dir * t; float r = length(p), h = r - SKY_RG;
    float dR = exp(-h / SKY_HR), dM = exp(-h / SKY_HM), dO = max(0.0, 1.0 - abs(h - ${f(ATMOSPHERE.ozoneCentre)}) / ${f(ATMOSPHERE.ozoneHalfWidth)});
    vec3 scaR = SKY_BETA_R * dR; float scaM = SKY_BETA_MS * dM;
    vec3 ext = scaR + SKY_BETA_ME * dM + SKY_BETA_O * dO, seg = exp(-ext * dt), w = T * (1.0 - seg) / max(ext, vec3(1e-9));
    float muS = dot(p, sun) / r, muM = dot(p, moon) / r;
    vec3 tS = skyTransmittance(r, muS) * uSkySunScatter.rgb, tM = skyTransmittance(r, muM) * uSkyMoonScatter.rgb;
    vec3 multi = skyMultiScatter(h, muS) * uSkySunScatter.rgb + skyMultiScatter(h, muM) * uSkyMoonScatter.rgb;
    smoothSum += w * (scaR * (pRs * tS + pRm * tM) + (scaR + scaM) * multi + scaM * pOther * (sunMain ? tM : tS));
    mieSum += w * scaM * (sunMain ? tS : tM);
    T *= seg;
  }
  outColor = vec4(mieHalf ? mieSum : smoothSum, 1.0);
}`;

/** Clouds, stars, moon, sun. Shared by the screen dome and the probe faces. */
export const SKY_DOME_LIB = /* glsl */`
const float SKY_SUN_RADIUS = ${f(ATMOSPHERE.sunAngularRadius)}, SKY_MOON_RADIUS = ${f(ATMOSPHERE.moonAngularRadius)};
// ---- cirrus: one thin sheet of ice streaks high above everything else. rgb premultiplied, a = transmittance.
vec4 skyCirrus(vec3 dir) {
  float amount = uSkyCloudDir.w;
  if (dir.y <= 0.01 || amount <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float r0 = SKY_RG + 0.05, t = skyShell(r0, dir.y, SKY_RG + 9.2) * 1e3;
  vec2 xz = uCamPos.xz + dir.xz * t + uSkyCloudOffset.zw;
  // Ice falls and is drawn out by the wind shear below it: soft streaks a kilometre or two wide and ten times as
  // long, gathered into patches. Patches come from a wide, soft threshold and the streaks only modulate them: a hard
  // threshold on the sum would leave the ridge of every noise crest as a bright hairline. (The noise tiles hold 6 to
  // 48 features across, so the tile sizes below are that many times the size of what they draw.)
  vec2 bend = xz * (1.0 / 150000.0), warp = (vec2(texture(uSkyNoise, bend).b, texture(uSkyNoise, bend + 0.5).b) - 0.5) * 5000.0;
  float sheet = texture(uSkyNoise, (xz + warp) * vec2(1.0 / 400000.0, 1.0 / 250000.0)).b;
  float streak = texture(uSkyNoise, (xz + warp) * vec2(1.0 / 130000.0, 1.0 / 13000.0) + 0.23).b;
  float field = smoothstep(0.0, 0.4, sheet - (0.95 - 0.75 * amount));
  float d = field * (0.15 + 0.85 * smoothstep(0.3, 0.75, streak)) * smoothstep(0.01, 0.12, dir.y);
  float cosA = dot(dir, uSkyCloudDir.xyz), lobe = min(0.36 / pow(max(1.64 - 1.6 * cosA, 1e-3), 1.5), 6.0);
  vec3 lit = uSkyCirrusLight.rgb * (1.0 / PI) * (0.55 + 0.3 * lobe) + uSkyAmbient.rgb * 0.45;
  float a = d * 0.62;
  return vec4(lit * a, 1.0 - a);
}

// ---- stars: one star per cell of a cubic lattice cut by the unit sphere, so density is even and there is no pole.
vec3 skyStarLayer(vec3 d, float scale, float share, float pixel, float twinkle) {
  vec3 p = d * scale; ivec3 cell = ivec3(floor(p));
  uint h = hashU3(cell);
  if (float(h & 1023u) * (1.0 / 1023.0) > share) return vec3(0.0);
  vec3 pos = vec3(cell) + 0.3 + 0.4 * vec3(float((h >> 10u) & 127u), float((h >> 17u) & 127u), float((h >> 24u) & 127u)) * (1.0 / 127.0);
  float dist = length(normalize(pos) - d);
  uint g = hashU(h); float u1 = float(g & 0xffffu) * (1.0 / 65535.0), u2 = float(g >> 16u) * (1.0 / 65535.0);
  float size = max(pixel * 0.8, 0.00055);                                // never smaller than a pixel: no shimmer
  float core = exp(-dist * dist / (size * size)) * min(0.00055 * 0.00055 / (size * size), 1.0) * 6.0;
  float mag = 0.012 + 1.6 * pow(u1, 7.0);                                // a few bright stars; the faint ones drown in the city's glow
  float tw = 1.0 + twinkle * (vnoise(vec2(uTime.x * (2.5 + 5.0 * u2), u2 * 91.0)) - 0.5);
  vec3 tint = mix(vec3(1.0, 0.78, 0.55), vec3(0.68, 0.80, 1.0), u2);     // from orange giants to blue-white
  return tint * (core * mag * tw);
}
vec3 skyStars(vec3 dir, float pixel) {
  // turn the sky about the celestial pole (north is -Z, the pole stands at the latitude above the horizon)
  const vec3 pole = vec3(0.0, 0.43523, -0.90032);
  float a = uSkyMoonDir.w, c = cos(a), s = sin(a);
  vec3 d = dir * c + cross(pole, dir) * s + pole * dot(pole, dir) * (1.0 - c);
  float twinkle = 0.5 + 0.9 * (1.0 - saturate(dir.y * 2.5));             // air near the horizon scintillates more
  vec3 stars = skyStarLayer(d, 70.0, 0.25, pixel, twinkle) * 1.6 + skyStarLayer(d, 170.0, 0.4, pixel, twinkle) * 0.7;
  // the band of the galaxy, faint over a lit city
  vec3 gal = normalize(vec3(0.42, 0.55, 0.72)); float band = exp(-pow(dot(d, gal) * 4.2, 2.0));
  float dust = texture(uSkyNoise, d.xz * 1.7 + d.y * 0.9).r;
  stars += vec3(0.72, 0.80, 1.0) * (0.0028 * band * (0.35 + dust));
  return stars * 0.075 * exp(-0.11 / max(dir.y, 0.03));
}

// ---- moon: a lit sphere, so the phase follows from where the sun is. rgb = radiance, a = disc coverage.
vec4 skyMoon(vec3 dir, float pixel) {
  vec3 m = uSkyMoonDir.xyz; float c = dot(dir, m);
  if (c < 0.9994) return vec4(0.0);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), m)), up = cross(m, right);
  vec2 q = vec2(dot(dir, right), dot(dir, up)) / SKY_MOON_RADIUS; float r = length(q), edge = pixel / SKY_MOON_RADIUS;
  float cover = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
  if (cover <= 0.0) return vec4(0.0);
  vec3 n = right * q.x + up * q.y - m * sqrt(max(1.0 - r * r, 0.0));
  float lit = dot(n, uSkySunDir.xyz);
  float shade = smoothstep(-0.04, 0.22, lit) * (0.72 + 0.28 * saturate(lit));    // dusty regolith stays bright to the limb
  float maria = smoothstep(0.42, 0.62, texture(uSkyNoise, q * 0.115 + vec2(0.31, 0.62)).r) * (0.55 + 0.45 * texture(uSkyNoise, q * 0.31).b);
  vec3 albedo = mix(vec3(1.0, 0.98, 0.93), vec3(0.50, 0.52, 0.56), maria * 0.75);
  vec3 through = skyTransmittance(SKY_RG + SKY_OBSERVER, m.y);
  vec3 rad = (albedo * shade * 2.6 + vec3(0.012, 0.016, 0.024)) * through / max(through.g, 0.25);   // low moons turn amber, not dim
  return vec4(rad * mix(0.5, 1.0, through.g), cover);
}

// ---- sun disc with limb darkening (redder and darker towards the edge)
vec3 skySun(vec3 dir, float pixel) {
  float c = dot(dir, uSkySunDir.xyz);
  if (c < 0.9998) return vec3(0.0);
  float ang = acos(min(c, 1.0)), r = ang / SKY_SUN_RADIUS, edge = pixel / SKY_SUN_RADIUS;
  float cover = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, r);
  float mu = sqrt(max(1.0 - r * r, 0.0));
  vec3 limb = pow(vec3(mu), vec3(0.40, 0.50, 0.65));
  vec3 through = skyTransmittance(SKY_RG + SKY_OBSERVER, uSkySunDir.y);
  // The disc is compressed like everything else on the scene scale: bright enough to bloom hard, far below float16 limits.
  return ${f(ATMOSPHERE.sunIrradiance[1])} * 20.0 * through * limb * cover;
}

// Everything above the horizon except the haze layer: scattering, bodies, stars, both cloud layers.
// probe = true leaves out what the renderer adds analytically or does not need (sun and moon discs, stars, the flash),
// and hides the lamp glow's horizon band behind the street's own fronts: from the pavement the sky starts above the
// rooftops, and a band that is in the probe at full strength comes back as a sepia sheen on every road and bonnet.
vec3 skyAbove(vec3 dir, float pixel, bool probe) {
  vec3 c = skyClear(dir) + uSkyNight.rgb + skyCityGlow(dir) * (probe ? smoothstep(0.0, 0.22, dir.y) : 1.0);
  if (!probe) {
    c += skyStars(dir, pixel);
    vec4 moon = skyMoon(dir, pixel);
    c = mix(c, skyClear(dir) + skyCityGlow(dir) + moon.rgb, moon.a);
    c += skySun(dir, pixel);
  }
  vec4 cirrus = skyCirrus(dir);
  c = c * cirrus.a + cirrus.rgb;
  vec2 where; vec4 cloud = skyClouds(dir, where);
  c = c * cloud.a + cloud.rgb;
  // Lightning lights the cloud from inside, strongest round the strike. The probe leaves it out: half-updated faces
  // would flicker, and the renderer adds the flash to ambient itself.
  float flash = probe ? 0.0 : uSkyFogParams.z;
  if (flash > 0.0) { float d = length(where - uSkyStrike.xy); c += vec3(0.86, 0.90, 1.0) * ((1.0 - cloud.a) * flash * 3.0 / (uSunColor.w * (1.0 + d * d * 2.0e-7))); }
  return c;
}
// The haze layer in front of the sky: the same fog the renderer applies to geometry, taken to infinity.
// flash = lightning 0..1 (screen only).
vec3 skyHazed(vec3 c, vec3 dir, float flash) {
  float k = uSkyFogParams.x, tau = uSkyFogColor.w * exp(-max(uCamPos.y, 0.0) * k) / (k * max(dir.y, 1e-4));
  float t = exp(-tau);
  vec3 air = fogColorTowards(dir);
  float rain = uSkyFogParams.w;
  if (rain > 0.0) {
    // Rain hides the deck behind grey air. From the street the heavy bellies of the cloud still read through it as
    // darker masses above a paler curtain at the horizon, so shade the rain by what hangs over it.
    vec2 xz = uCamPos.xz + dir.xz * (uSkyCloud.z / max(dir.y, 0.06)) + uSkyCloudOffset.xy;
    float heavy = smoothstep(0.28, 0.72, texture(uSkyNoise, xz * (1.0 / 8300.0) + 0.61).b);
    float storm = uSkyMoonLight.w;
    air *= 1.0 - rain * smoothstep(0.0, 0.22, dir.y) * mix(mix(0.25, 0.5, storm), mix(0.55, 0.78, storm), heavy);
    // a flash lights the rain from inside, strongest towards the strike
    vec2 toStrike = uSkyStrike.xy - uCamPos.xz;
    float facing = 0.5 + 0.5 * dot(normalize(dir.xz + 1e-5), toStrike / max(length(toStrike), 1.0));
    // (set in exposed units like the renderer's flash on the ground: the sky whites out towards the strike, not everywhere)
    air += vec3(0.86, 0.90, 1.0) * (flash * rain * 0.9 / uSunColor.w * (0.3 + 0.7 * facing * facing));
  }
  return c * t + air * (1.0 - t);
}
`;

/** Screen dome: background stage, drawn at the far plane. Below the horizon it continues the sea beyond the far plane. */
export const SKY_DOME_FS = /* glsl */`
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 h = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(h.xyz / h.w);
  float pixel = length(fwidth(dir));
  vec3 c;
  if (dir.y >= 0.0) {
    c = skyHazed(skyAbove(dir, pixel, false), dir, uSkyFogParams.z);
  } else {
    // Sea beyond the far plane: mean water under the same reflection and fog as the ocean pass, so the mesh edge cannot show.
    float cosV = -dir.y, fres = 0.02 + 0.98 * pow(1.0 - cosV, 5.0) * 0.72;
    vec3 body = vec3(0.006, 0.030, 0.052) * (uSunColor.rgb * max(uSunDir.y, 0.0) + PI * envDiffuse(vec3(0.0, 1.0, 0.0)));
    c = mix(body, envSpecular(vec3(dir.x, -dir.y, dir.z), 0.42), fres);
    vec4 fog = skyFog(dir * (max(uCamPos.y, 0.5) / cosV));
    c = c * fog.a + fog.rgb;
  }
  outColor = vec4(min(c, vec3(6.0e4)), 1.0);
}`;

/** One face of the environment probe. uFaceX/Y/Z are the cube face basis (GL convention). */
export const SKY_PROBE_FS = /* glsl */`
in vec2 vUv;
uniform vec3 uFaceX, uFaceY, uFaceZ;
out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 dir = normalize(uFaceZ + uFaceX * p.x + uFaceY * p.y);
  vec3 horizon = vec3(dir.x, 0.0, dir.z); horizon = normalize(horizon + vec3(1e-5, 0.0, 0.0));
  // A street at night is not lit by the sky alone. Between the pools of its lamps it is filled by what those lamps
  // light round about: lit haze, signs and upper floors overhead, fronts and parked cars round the horizontal, the
  // pavement below. None of that is in a picture of the sky, so the probe adds it, by how brightly lit the place is.
  vec3 fronts = ${v3(STREET_FILL)} * uSkyGlow.x, air = ${v3(STREET_AIR)} * uSkyGlow.x;
  vec3 c;
  if (dir.y >= 0.0) c = skyHazed(skyAbove(dir, 0.004, true), dir, 0.0) + air * dir.y * dir.y + fronts * (1.0 - smoothstep(0.0, 0.75, dir.y));
  else c = mix(fogColorTowards(horizon) + fronts, uSkyGround.rgb + 0.6 * fronts, smoothstep(0.0, 0.14, -dir.y));   // dark ground bounce below
  outColor = vec4(min(c, vec3(6.0e4)), 1.0);
}`;

const FACE_DIR = /* glsl */`
uniform vec3 uFaceX, uFaceY, uFaceZ;
uniform samplerCube uEnvRaw;   // the unfiltered probe with a full mip chain
vec2 skyHammersley(int i, int n) {
  uint b = uint(i); b = (b << 16u) | (b >> 16u); b = ((b & 0x55555555u) << 1u) | ((b & 0xAAAAAAAAu) >> 1u);
  b = ((b & 0x33333333u) << 2u) | ((b & 0xCCCCCCCCu) >> 2u); b = ((b & 0x0F0F0F0Fu) << 4u) | ((b & 0xF0F0F0F0u) >> 4u);
  b = ((b & 0x00FF00FFu) << 8u) | ((b & 0xFF00FF00u) >> 8u);
  return vec2((float(i) + 0.5) / float(n), float(b) * 2.3283064365386963e-10);
}
mat3 skyBasis(vec3 n) { vec3 a = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), t = normalize(cross(a, n)); return mat3(t, cross(n, t), n); }
`;

/** GGX prefilter of the raw probe into one roughness level. uParams: x = roughness, y = raw face size, z = sample count. */
export const SKY_PREFILTER_FS = FACE_DIR + /* glsl */`
in vec2 vUv;
uniform vec4 uParams;
out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 N = normalize(uFaceZ + uFaceX * p.x + uFaceY * p.y);
  float rough = uParams.x;
  if (rough <= 0.0) { outColor = vec4(textureLod(uEnvRaw, N, 0.0).rgb, 1.0); return; }
  float a = rough * rough, a2 = a * a, texel = 4.0 * PI / (6.0 * uParams.y * uParams.y);
  int count = int(uParams.z); mat3 B = skyBasis(N);
  vec3 sum = vec3(0.0); float wSum = 0.0;
  for (int i = 0; i < count; i++) {
    vec2 xi = skyHammersley(i, count);
    float cosT = sqrt((1.0 - xi.y) / (1.0 + (a2 - 1.0) * xi.y)), sinT = sqrt(1.0 - cosT * cosT), phi = TAU * xi.x;
    vec3 H = B * vec3(sinT * cos(phi), sinT * sin(phi), cosT), L = 2.0 * dot(N, H) * H - N;
    float nl = dot(N, L);
    if (nl <= 0.0) continue;
    // pick the raw mip whose texels match the solid angle this sample stands for: few samples, no fireflies
    float d = (cosT * cosT * (a2 - 1.0) + 1.0), pdf = a2 / (PI * d * d) * 0.25;
    float lod = max(0.5 * log2(1.0 / (float(count) * pdf * texel)) + 1.0, 0.0);
    sum += textureLod(uEnvRaw, L, lod).rgb * nl; wSum += nl;
  }
  outColor = vec4(sum / max(wSum, 1e-4), 1.0);
}`;

/** Cosine convolution of the raw probe (irradiance / PI). uParams: x = source lod, z = sample count. */
export const SKY_IRRADIANCE_FS = FACE_DIR + /* glsl */`
in vec2 vUv;
uniform vec4 uParams;
out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 N = normalize(uFaceZ + uFaceX * p.x + uFaceY * p.y);
  int count = int(uParams.z); mat3 B = skyBasis(N); vec3 sum = vec3(0.0);
  for (int i = 0; i < count; i++) {
    vec2 xi = skyHammersley(i, count);
    float r = sqrt(xi.y), phi = TAU * xi.x;                       // cosine-weighted hemisphere: every sample weighs the same
    sum += textureLod(uEnvRaw, B * vec3(r * cos(phi), r * sin(phi), sqrt(1.0 - xi.y)), uParams.x).rgb;
  }
  outColor = vec4(sum / float(count), 1.0);
}`;

/** Cube face bases in GL order (+X, -X, +Y, -Y, +Z, -Z): direction = Z + X * s + Y * t with s, t in -1..1. */
export const CUBE_FACES = Object.freeze([
  { x: [0, 0, -1], y: [0, -1, 0], z: [1, 0, 0] },
  { x: [0, 0, 1], y: [0, -1, 0], z: [-1, 0, 0] },
  { x: [1, 0, 0], y: [0, 0, 1], z: [0, 1, 0] },
  { x: [1, 0, 0], y: [0, 0, -1], z: [0, -1, 0] },
  { x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, 1] },
  { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] },
]);
