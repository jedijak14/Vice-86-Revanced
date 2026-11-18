// Shaders of the scene reflection probe (probe.js): the sky behind a cube face, and the filter that turns
// the sharp capture into the roughness mip chain the lighting reads.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD } from '../host.js';
import { MAX_REFLECTED } from './common.js';

/** Mip levels of the filtered cube: level i holds the reflection for roughness i / PROBE_LAST_LEVEL. */
export const PROBE_LAST_LEVEL = 5;
/** Directions averaged per texel of a filtered level. */
export const PROBE_FILTER_SAMPLES = 32;

/**
 * Sky behind the geometry of a cube face. uFace: columns = right, up and forward of the face in world space.
 * The sky module's own probe is the source: it already holds the sky with its clouds, sun glow and haze.
 * Alpha 0: the sky is infinitely far (the probe keeps 1 / distance there).
 */
export function probeSkyFragment(skyGlsl) {
  return HEAD + surfacePrelude(LIB, 'frag') + skyGlsl + /* glsl */`
uniform mat3 uFace;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  outColor = vec4(min(envSpecular(normalize(uFace * vec3(p, 1.0)), 0.0), vec3(${MAX_REFLECTED})), 0.0);
}`;
}

/**
 * One face of one level of the filtered cube: the capture averaged over the specular lobe of that
 * level's roughness, for a surface seen along its own normal (the usual split-sum simplification).
 * uFace as above; uFilter = (roughness of this level, solid angle of one texel of the capture's level 0).
 * Directions are drawn where the lobe is strong, and each is read from the capture's mip whose texels
 * are as wide as the share of the lobe that direction stands for: 32 directions then cover a wide lobe
 * without leaving a lamp as 32 separate dots. Alpha (1 / distance) is averaged like the colour.
 */
export const PROBE_FILTER_FS = HEAD + /* glsl */`
uniform highp samplerCube uCapture;
uniform mat3 uFace;
uniform vec4 uFilter;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
const float TAU = 6.2831853;
float radicalInverse(uint bits) {
  bits = (bits << 16u) | (bits >> 16u);
  bits = ((bits & 0x55555555u) << 1u) | ((bits & 0xAAAAAAAAu) >> 1u);
  bits = ((bits & 0x33333333u) << 2u) | ((bits & 0xCCCCCCCCu) >> 2u);
  bits = ((bits & 0x0F0F0F0Fu) << 4u) | ((bits & 0xF0F0F0F0u) >> 4u);
  bits = ((bits & 0x00FF00FFu) << 8u) | ((bits & 0xFF00FF00u) >> 8u);
  return float(bits) * 2.3283064365386963e-10;
}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  vec3 N = normalize(uFace * vec3(p, 1.0));
  vec3 T = normalize(cross(abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), N)), B = cross(N, T);
  float alpha = uFilter.x * uFilter.x, a2 = alpha * alpha;
  vec4 sum = vec4(0.0); float weight = 0.0;
  for (uint i = 0u; i < ${PROBE_FILTER_SAMPLES}u; i++) {
    float u = (float(i) + 0.5) / ${PROBE_FILTER_SAMPLES}.0, phi = TAU * radicalInverse(i);
    float cosH = sqrt((1.0 - u) / (1.0 + (a2 - 1.0) * u)), sinH = sqrt(max(1.0 - cosH * cosH, 0.0));
    vec3 H = T * (sinH * cos(phi)) + B * (sinH * sin(phi)) + N * cosH;
    vec3 L = 2.0 * cosH * H - N;
    float NoL = dot(N, L);
    if (NoL <= 0.0) continue;
    float d = cosH * cosH * (a2 - 1.0) + 1.0, density = a2 / (0.5 * TAU * d * d) * 0.25;      // per solid angle, with view = normal
    float lod = max(0.5 * log2(1.0 / (${PROBE_FILTER_SAMPLES}.0 * density * uFilter.y)) + 1.0, 0.0);
    sum += textureLod(uCapture, L, lod) * NoL; weight += NoL;
  }
  outColor = sum / max(weight, 1e-4);
}`;
