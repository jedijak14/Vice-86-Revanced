// Fullscreen passes that turn the G-buffer into lit radiance: depth linearisation, ambient occlusion and
// its blur, and the deferred lighting pass itself.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH, GBUFFER_READ } from '../host.js';
import { LIGHTING } from './common.js';

const PRELUDE = HEAD + surfacePrelude(LIB, 'frag');

/** Hardware depth -> view-space depth in metres (R32F). uDepthParams = (A, B) of the projection: depth = B / (ndc + A). */
export const LINEAR_DEPTH_FS = HEAD + /* glsl */`
uniform highp sampler2D uDepthTex;
uniform vec4 uDepthParams;
layout(location = 0) out vec4 outDepth;
void main() {
  float d = texelFetch(uDepthTex, ivec2(gl_FragCoord.xy), 0).r;
  outDepth = vec4(d >= 1.0 ? 1.0e6 : uDepthParams.y / (d * 2.0 - 1.0 + uDepthParams.x), 0.0, 0.0, 1.0);
}`;

/**
 * Ambient occlusion and sun contact shadows at half resolution, one channel each.
 *
 * Red: scalable ambient obscurance, a spiral of taps in a world-space radius, each contributing by how far
 * it rises above the tangent plane of the pixel. The radius is kept near a metre: the depth buffer cannot
 * tell a mirror or a cab standing in front of a panel from a solid step, so a wide radius paints a soft dark
 * halo around every such part, while creases, sills and the kerb line only need a short reach.
 *
 * Green: a short march through the depth buffer towards the sun. The shadow maps keep a bias that lifts
 * every shadow a few centimetres off its caster; this closes that gap, so tyres, bumpers, kerbs and trunks
 * meet the ground in shadow instead of floating over a lit sliver.
 *
 * uAo = (radius in metres, taps, pixels per metre at depth 1, noise phase).
 */
export const AO_FS = PRELUDE + DEPTH + GBUFFER_READ + /* glsl */`
uniform vec4 uAo;
in vec2 vUv;
layout(location = 0) out vec4 outAo;

const int CONTACT_STEPS = 8;
// Gain of the obscurance estimate: a right-angled crease between two large faces comes out near half dark.
const float AO_STRENGTH = 6.0;
// The darkest this pass may make a pixel. The depth buffer shows only the front of things: it cannot tell how
// deep a slot is or that it is open at the sides, and the estimate overshoots in a shallow recess (an air
// intake, the dish of a wheel). Whatever is truly darker than this carries it in its baked occlusion.
const float AO_FLOOR = 0.3;

// 1 where the sun reaches P over the first decimetres of its path, 0 where the depth buffer blocks it.
float sunContact(vec3 P, vec3 N, float z, float noise) {
  vec3 L = uSunDir.xyz;
  if (dot(N, L) <= 0.0) return 1.0;                        // faces away: the lighting already leaves it dark
  // The reach grows with distance so that it still spans a few pixels on far cars; so does the assumed
  // thickness of whatever is hit, which keeps a pole or a mirror from shading everything behind it.
  float reach = 0.3 + 0.012 * z, thickness = 0.2 + 0.012 * z, bias = 0.01 + 0.002 * z;
  vec3 origin = P + N * (0.012 + 0.002 * z);
  for (int i = 0; i < CONTACT_STEPS; i++) {
    float t = (float(i) + noise) / float(CONTACT_STEPS);
    vec3 q = origin + L * (t * reach);
    vec4 clip = uViewProjStable * vec4(q, 1.0);
    if (clip.w <= 0.0) break;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv != clamp(uv, 0.0, 1.0)) break;
    float behind = viewDepthOf(q) - sceneDepth(uv);
    // Hits near the end of the march fade out: from there on the shadow maps are trustworthy.
    if (behind > bias && behind < thickness) return smoothstep(0.5, 1.0, t);
  }
  return 1.0;
}

void main() {
  ivec2 px = ivec2(vUv * uViewport.xy);
  float z = texelFetch(uSceneDepth, px, 0).r;
  outAo = vec4(1.0);
  if (isSky(z)) return;
  vec3 P = viewRay(vUv) * z, N = octDecode(texelFetch(uGBuffer1, px, 0).xy);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uAo.w * 5.588238, vec2(0.06711056, 0.00583715))));
  outAo.g = sunContact(P, N, z, noise);
  float radiusPx = min(uAo.x * uAo.z / z, 0.1 * uViewport.y);
  if (radiusPx < 1.5) return;                              // too far away for the effect to cover a pixel
  int taps = int(uAo.y);
  float r2 = uAo.x * uAo.x, sum = 0.0, bias = 0.012 + 0.0025 * z;
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    float t = (float(i) + 0.5) / float(taps), a = (t * 5.0 + noise) * TAU;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * (t * radiusPx) * uViewport.zw;
    float zq = sceneDepth(uv);
    vec3 v = viewRay(uv) * min(zq, z + uAo.x) - P;         // sky and far background count as open
    float vv = dot(v, v), vn = dot(v, N), f = max(r2 - vv, 0.0);
    sum += f * f * f * max((vn - bias) / (vv + 0.01), 0.0);
  }
  float obscurance = sum * AO_STRENGTH / (r2 * r2 * r2 * float(taps));
  // Fade the effect out where its radius shrinks to a few pixels, so distant geometry does not sparkle.
  // Occluders multiply rather than add, so light obscurance darkens as it always did (the same slope at
  // zero) and heavy obscurance levels off at the floor instead of stopping at it with a visible edge.
  float open = AO_FLOOR + (1.0 - AO_FLOOR) * exp(-obscurance / (1.0 - AO_FLOOR));
  outAo.r = mix(1.0, open, smoothstep(1.5, 6.0, radiusPx));
}`;

/** Separable depth-aware blur of the half-resolution occlusion pair. uBlurDir = one half-res texel along the blur axis, in uv. */
export const AO_BLUR_FS = PRELUDE + DEPTH + /* glsl */`
uniform sampler2D uAoTex;
uniform vec2 uBlurDir;
in vec2 vUv;
layout(location = 0) out vec4 outAo;
void main() {
  float z = sceneDepth(vUv);
  vec2 sum = texture(uAoTex, vUv).rg;
  float weight = 1.0;
  if (!isSky(z)) {
    for (int i = -3; i <= 3; i++) {
      if (i == 0) continue;
      vec2 uv = vUv + uBlurDir * float(i);
      float zq = sceneDepth(uv);
      // Only blur across pixels of the same surface: weight falls off with relative depth difference.
      float w = exp(-0.22 * float(i * i)) * max(0.0, 1.0 - abs(zq - z) / (0.03 * z + 0.02));
      sum += texture(uAoTex, uv).rg * w; weight += w;
    }
  }
  outAo = vec4(sum / weight, 1.0, 1.0);
}`;

/**
 * GLSL: (ambient occlusion, sun contact shadow) at a full-resolution pixel from the half-resolution buffer,
 * without bleeding across depth edges; upsampleAo is the first of the pair for passes that only shade ambient.
 */
export const AO_UPSAMPLE = /* glsl */`
uniform sampler2D uAoTex;
vec2 upsampleOcclusion(vec2 uv, float z) {
  vec2 size = vec2(textureSize(uAoTex, 0)), pos = uv * size - 0.5, f = fract(pos);
  ivec2 base = ivec2(floor(pos)), top = ivec2(size) - 1;
  vec2 sum = vec2(0.0);
  float weight = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1), at = clamp(base + o, ivec2(0), top);
    float zq = sceneDepth((vec2(at) + 0.5) / size);
    float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    w *= max(0.02, 1.0 - abs(zq - z) / (0.03 * z + 0.02));
    sum += texelFetch(uAoTex, at, 0).rg * w; weight += w;
  }
  return sum / max(weight, 1e-4);
}
float upsampleAo(vec2 uv, float z) { return upsampleOcclusion(uv, z).x; }
`;

/**
 * Deferred lighting. Drawn with a far-plane triangle and depth func GREATER so only pixels with geometry
 * are shaded. Writes direct light, diffuse ambient and emission; specular ambient (environment and
 * screen-space reflections) and fog are added by the reflection pass once the sky and water exist.
 * uLightingMode: 0 normal, 1 local lights only, 2 shadow term only (debug views).
 */
export function lightingFragment(skyGlsl) {
  return PRELUDE + DEPTH + GBUFFER_READ + skyGlsl + LIGHTING + AO_UPSAMPLE + /* glsl */`
uniform vec4 uLightingParams;   // x = ambient occlusion buffer present, y = debug mode
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uSceneDepth, px, 0).r;
  GPixel g = readGBuffer(px);
  vec3 rel = viewRay(vUv) * z;
  vec3 V = -normalize(rel);

  LitSurface s;
  s.N = g.N; s.V = V;
  s.diffuse = g.albedo * (1.0 - g.metal);
  // A water film is a clear coat: at least as strong as the wetness, with water's lower reflectance.
  s.coat = max(g.coat, g.wet); s.coatAlpha = litAlpha(g.coatRough); s.coatF0 = mix(0.04, 0.02, g.wet);
  s.f0 = litBaseF0(g.albedo, g.metal, s.coat); s.alpha = litAlpha(g.rough);
  s.lacquer = g.coat; s.sss = g.sss;

  // x = ambient occlusion, y = the sun's contact shadow marched through the depth buffer: detail the
  // shadow cascades are too coarse to hold (panel gaps, trim, the foot of a kerb).
  vec2 occlusion = uLightingParams.x > 0.5 ? upsampleOcclusion(vUv, z) : vec2(1.0);
  float screenAo = occlusion.x;
  float contact = litContact(rel);
  float ao = g.ao * screenAo * contact;

  // The contact shadow is marched towards the sun. A room's light box is no direction: what it lights is
  // shaded by litRoomShadow alone.
  float shadow = litSunShadow(rel, g.N) * (uRoomKey[0].w > 0.5 ? 1.0 : occlusion.y);
#ifdef SKY_CLOUD_SHADOW
  shadow *= skyCloudShadow(rel);
#endif
  vec3 sun = litKey(rel, s, shadow);
  // Lamps cast no shadow maps; baked and analytic occlusion stand in so that wheel arches and the road
  // under a car do not glow under a street light.
  vec3 lamps = litLocal(rel, s) * mix(1.0, g.ao, 0.85) * contact;
  // Lightning is a flash from overhead: mostly on upward faces. A room's bounced light comes from all round.
  vec3 ambient = s.diffuse * (envDiffuse(g.N) + uAmbientBoost.rgb * (1.0 - uAmbientBoost.w * (1.0 - g.N.y))) * ao;
  // What the coat mirrors does not reach the paint below it: grazing flanks go dark under their reflection.
  ambient *= 1.0 - litCoatMirror(s.coatF0, abs(dot(g.N, V)), g.coat) * s.coat;

  vec3 colour = sun + lamps + ambient + g.emissive;
  if (uLightingParams.y > 1.5) colour = vec3(shadow * contact * screenAo) / max(uSunColor.w, 1e-4) * 0.6;
  else if (uLightingParams.y > 0.5) colour = lamps;
  outColor = vec4(colour, 1.0);
}`;
}
