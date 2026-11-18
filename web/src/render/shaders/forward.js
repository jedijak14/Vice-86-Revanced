// Forward-drawn sprites: glows (the halo that makes a small lamp read at distance) and particles
// (tyre spray, smoke, dust, splashes). Glass is assembled in surface.js because it runs a surface family.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH } from '../host.js';
import { LIGHTING, MAX_REFLECTED } from './common.js';

/** Glow limits. The brief is "glow, never glare": a sprite is a hint of scattering around a source, not a second light. */
export const GLOW = Object.freeze({
  minRadiusPx: 1.5,        // smaller sprites keep this size and lose energy instead, so far lamps dim rather than shimmer
  maxRadiusFraction: 0.09, // of the frame height
  peak: 0.9,               // brightest a single sprite may be at its centre, in exposed (display-referred) units
  gain: 0.3,               // sprite centre as a share of the source radiance, before the cap
});

/**
 * Glow sprites. Instance attributes: aGlowPos = (xyz relative to uOffset, size in metres),
 * aGlowColor = (rgb source radiance, code + seed fraction) with code = channel + 16 * kind.
 * uGlow = (exposure, pixels per metre at depth 1, overall strength, frame height in pixels).
 * Visibility is measured in the vertex shader with a ring of depth taps around the source, so a lamp
 * sliding behind a pole fades over a few frames instead of popping, and costs nothing per pixel.
 */
export const GLOW_VS = HEAD + surfacePrelude(LIB, 'vert') + DEPTH + /* glsl */`
layout(location = 0) in vec4 aGlowPos;
layout(location = 1) in vec4 aGlowColor;
uniform vec3 uOffset;
uniform vec4 uGlow;
out vec2 vQuad;
out vec3 vColor;
flat out vec3 vCentre;
flat out float vKind;
void main() {
  gl_Position = vec4(0.0, 0.0, -2.0, 1.0);                 // culled unless everything below says otherwise
  float code = floor(aGlowColor.a + 1e-3), seed = fract(aGlowColor.a + 1e-3);
  float kind = floor(code / 16.0), channel = code - kind * 16.0;
  float level = channelLevel(channel, seed);
  vec3 rel = uOffset + aGlowPos.xyz;
  vec4 clip = uViewProj * vec4(rel, 1.0);
  if (level <= 0.002 || clip.w < 0.5) return;
  float depth = clip.w;
  vec2 centre = clip.xy / clip.w * 0.5 + 0.5;
  if (any(lessThan(centre, vec2(-0.1))) || any(greaterThan(centre, vec2(1.1)))) return;

  float radius = 0.5 * aGlowPos.w * uGlow.y / depth, energy = 1.0;
  if (radius < ${GLOW.minRadiusPx.toFixed(1)}) { energy = radius / ${GLOW.minRadiusPx.toFixed(1)}; energy *= energy; radius = ${GLOW.minRadiusPx.toFixed(1)}; }
  float largest = ${GLOW.maxRadiusFraction.toFixed(3)} * uGlow.w;
  // Close up the lens itself is on screen and blooms; the sprite steps back so the two do not stack.
  float closeFade = min(1.0, largest / radius);
  radius = min(radius, largest);

  // Share of the source that is unoccluded: centre plus a ring, compared with a tolerance that keeps the
  // lamp's own lens (which sits at the same place) from hiding its glow.
  float tolerance = 0.3 + 0.015 * depth, visible = step(depth - tolerance, sceneDepth(centre));
  float ring = max(2.0, 0.25 * radius);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.7853982 + 0.3;
    visible += step(depth - tolerance, sceneDepth(centre + vec2(cos(a), sin(a)) * ring * uViewport.zw));
  }
  visible /= 9.0;
  if (visible <= 0.0) return;

  vec3 radiance = aGlowColor.rgb * level;
  float brightest = max(radiance.r, max(radiance.g, radiance.b)) * ${GLOW.gain.toFixed(2)} * uGlow.x;
  float cap = min(1.0, ${GLOW.peak.toFixed(2)} / max(brightest, 1e-4));
  vColor = radiance * (${GLOW.gain.toFixed(2)} * cap * energy * closeFade * visible * visible * uGlow.z);
  vQuad = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vCentre = rel; vKind = kind;
  gl_Position = vec4(clip.xy + vQuad * radius * 2.0 * uViewport.zw * clip.w, 0.0, clip.w);
}`;

export function glowFragment(skyGlsl) {
  return HEAD + surfacePrelude(LIB, 'frag') + skyGlsl + /* glsl */`
in vec2 vQuad;
in vec3 vColor;
flat in vec3 vCentre;
flat in float vKind;
layout(location = 0) out vec4 outColor;
void main() {
  float r2 = dot(vQuad, vQuad);
  if (r2 >= 1.0) discard;
  float window = (1.0 - r2) * (1.0 - r2);                  // reaches zero with zero slope at the rim: no visible disc
  // Tight core, weak wide skirt: the eye reads the source, the skirt only suggests the air around it.
  float shape = exp(-r2 * 22.0) + 0.07 * window;
  if (vKind > 1.5) shape = 0.22 * window;                                                     // wide wash around neon
  else if (vKind > 0.5) shape += 0.3 * exp(-vQuad.y * vQuad.y * 320.0) * window * (1.0 - abs(vQuad.x));   // lamp: horizontal streak
  outColor = vec4(vColor * shape * skyFog(vCentre).a, 1.0);
}`;
}

/** Glow sprites as a second view (a face of the scene probe, the wet-road mirror) records them. */
export const GLOW_VIEW = Object.freeze({
  sourceShare: 0.4,        // diameter of the lens as a share of the halo diameter a glow record carries
  minRadiusPx: 1.6,        // a smaller image keeps this size and loses energy, so a far lamp is a steady faint point
  gain: 2.0,               // lens radiance over the radiance of the record (records are tuned for halos, lenses are brighter)
});

/**
 * The same glow records drawn into a second view, where they stand for the SOURCE and not for its halo:
 * the image of the lens that a car body, a pane or a puddle mirrors. A lamp forty metres off covers a
 * fraction of a probe texel and its lens geometry falls between the samples, and a neon tube is thinner
 * still; without these sprites the reflected street has no lamps in it. Energy is conserved (a source
 * smaller than the smallest sprite is dimmed by the ratio of the areas), so the blurred mips of the probe
 * and of the mirror carry the right amount of light. Occlusion is the view's own depth buffer.
 * uAltViewProj, uAltEye as in the surface view programs; uGlowView = (pixels per metre at depth 1,
 * 2 / width, 2 / height, camera-relative height below which nothing is drawn); uGlowSkip = (xyz of a
 * point relative to the camera, radius): glows inside that sphere are left out (the lamps of the car the
 * probe sits in, whose body is left out of its own reflection as well).
 */
export const GLOW_VIEW_VS = HEAD + surfacePrelude(LIB, 'vert') + /* glsl */`
layout(location = 0) in vec4 aGlowPos;
layout(location = 1) in vec4 aGlowColor;
uniform vec3 uOffset;
uniform mat4 uAltViewProj;
uniform vec4 uAltEye;
uniform vec4 uGlowView;
uniform vec4 uGlowSkip;
out vec2 vQuad;
out vec3 vColor;
flat out vec3 vCentre;
void main() {
  gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  float code = floor(aGlowColor.a + 1e-3), seed = fract(aGlowColor.a + 1e-3);
  float kind = floor(code / 16.0), channel = code - kind * 16.0;
  float level = channelLevel(channel, seed);
  vec3 rel = uOffset + aGlowPos.xyz;
  vec4 clip = uAltViewProj * vec4(rel, 1.0);
  vec3 skip = rel - uGlowSkip.xyz;
  if (level <= 0.002 || clip.w < 0.3 || rel.y < uGlowView.w || dot(skip, skip) < uGlowSkip.w * uGlowSkip.w) return;

  // A wash (kind 2) stands for a length of tube or a lit panel and keeps its size; a lamp shrinks to its lens.
  bool wash = kind > 1.5;
  float source = 0.5 * aGlowPos.w * (wash ? 1.0 : ${GLOW_VIEW.sourceShare.toFixed(2)});
  // The sprite is a soft disc 1.5 source radii wide whose integral equals that of the hard disc of the lens.
  float radius = 1.5 * source * uGlowView.x / clip.w, energy = wash ? 1.0 : 1.3333;
  if (radius < ${GLOW_VIEW.minRadiusPx.toFixed(1)}) { energy *= radius * radius / ${(GLOW_VIEW.minRadiusPx * GLOW_VIEW.minRadiusPx).toFixed(2)}; radius = ${GLOW_VIEW.minRadiusPx.toFixed(1)}; }
  vec3 radiance = min(aGlowColor.rgb * (level * (wash ? 1.0 : ${GLOW_VIEW.gain.toFixed(1)})), vec3(${MAX_REFLECTED}));
  vColor = radiance * energy;
  vQuad = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  vCentre = rel;
  // Depth of a point a little nearer the eye, so that the lens the glow sits on does not hide it.
  vec3 toEye = uAltEye.xyz - rel;
  float dist = length(toEye);
  vec4 nearer = uAltViewProj * vec4(rel + toEye * min((0.3 + 0.015 * dist) / max(dist, 1e-3), 0.5), 1.0);
  gl_Position = vec4(clip.xy + vQuad * radius * uGlowView.yz * clip.w, nearer.z / nearer.w * clip.w, clip.w);
}`;

export function glowViewFragment(skyGlsl) {
  return HEAD + surfacePrelude(LIB, 'frag') + skyGlsl + /* glsl */`
in vec2 vQuad;
in vec3 vColor;
flat in vec3 vCentre;
layout(location = 0) out vec4 outColor;
void main() {
  float r2 = dot(vQuad, vQuad);
  if (r2 >= 1.0) discard;
  float window = (1.0 - r2) * (1.0 - r2);
  // Alpha 0: light is added to the view, its coverage (what the mirror resolve reads) is left alone.
  outColor = vec4(vColor * window * skyFog(vCentre).a, 0.0);
}`;
}

/**
 * Particles. Instance attributes: aPartPos = (camera-relative xyz, radius in metres),
 * aPartColor = (rgb albedo, opacity), aPartMisc = (rotation, texture offset in the fraction + 1 for mist, softness
 * in metres, emitted radiance as a multiple of the albedo: sparks), aPartStreak = (xyz: half the path the sprite
 * is drawn out along, in metres; zero for a round sprite).
 * Lit per sprite in the vertex shader (sun with one shadow lookup, lamps from the grid); ambient and fog per pixel.
 */
export const PARTICLE_VS = HEAD + surfacePrelude(LIB, 'vert') + LIGHTING + /* glsl */`
layout(location = 0) in vec4 aPartPos;
layout(location = 1) in vec4 aPartColor;
layout(location = 2) in vec4 aPartMisc;
layout(location = 3) in vec4 aPartStreak;
out vec2 vQuad;
out vec2 vNoiseUv;
out vec4 vColor;
out vec3 vLight;       // direct light arriving at the sprite
out vec3 vRel;
flat out vec2 vSoftEmit;
flat out float vMist;
void main() {
  vec2 q = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0;
  float c = cos(aPartMisc.x), s = sin(aPartMisc.x);
  vec2 turned = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  // Camera-facing quad from the rows of the view rotation.
  vec3 right = vec3(uView[0][0], uView[1][0], uView[2][0]), up = vec3(uView[0][1], uView[1][1], uView[2][1]);
  vec3 centre = aPartPos.xyz;
  vRel = centre + (right * turned.x + up * turned.y) * aPartPos.w;
  // Drawn out along its flight as the camera sees it: the corners ahead move on, those behind fall back.
  // The same water over a longer sprite is thinner.
  vec2 along = vec2(dot(aPartStreak.xyz, right), dot(aPartStreak.xyz, up));
  float reach = length(along), thin = aPartPos.w / (aPartPos.w + reach);
  if (reach > 1e-4) vRel += (right * along.x + up * along.y) * (dot(turned, along) / reach);
  float mist = floor(aPartMisc.y), offset = aPartMisc.y - mist;
  vQuad = q; vNoiseUv = q * 0.5 * (0.35 + 0.1 * offset) + offset * vec2(7.3, 3.1);
  vMist = mist;
  vColor = vec4(aPartColor.rgb, aPartColor.a * thin); vSoftEmit = aPartMisc.zw;
  // Smoke scatters light in all directions: no cosine term, a fixed phase share instead.
  // Fine droplets scatter a lamp's light forwards, away from a camera that looks along the beam: mist
  // behind a car takes little colour from its tail lamps, where smoke would glow with it.
  vLight = uSunColor.rgb * (sunShadow(centre) * 0.3 / PI) + litLocalVolume(centre) * mix(0.5, 0.2, mist);
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;

export function particleFragment(skyGlsl) {
  return HEAD + surfacePrelude(LIB, 'frag') + DEPTH + skyGlsl + /* glsl */`
in vec2 vQuad;
in vec2 vNoiseUv;
in vec4 vColor;
in vec3 vLight;
in vec3 vRel;
flat in vec2 vSoftEmit;
flat in float vMist;
layout(location = 0) out vec4 outColor;
void main() {
  float r2 = dot(vQuad, vQuad);
  if (r2 >= 1.0) discard;
  // Billowing edge: the noise eats into the disc more towards the rim.
  vec2 n = texture(uNoiseTex, vNoiseUv).rg;
  float body = saturate((1.0 - r2) * 1.6 - (0.25 + 0.75 * r2) * n.x * 1.2);
  float alpha = vColor.a * body * body * (3.0 - 2.0 * body);
  // Mist has no edge at all: a smooth falloff to zero at the rim, only faintly uneven inside.
  if (vMist > 0.5) alpha = vColor.a * (1.0 - r2) * (1.0 - r2) * (0.7 + 0.3 * n.x);
  // Fade where the sprite meets geometry, so it never shows a hard line against the road.
  float behind = texelFetch(uSceneDepth, ivec2(gl_FragCoord.xy), 0).r - viewDepthOf(vRel);
  alpha *= saturate(behind / max(vSoftEmit.x, 1e-3));
  if (alpha <= 0.002) discard;
  vec3 light = vLight + envDiffuse(vec3(0.0, 1.0, 0.0)) * (0.75 + 0.25 * n.y) + vSoftEmit.y;
  vec4 fog = skyFog(vRel);
  outColor = vec4((vColor.rgb * light * fog.a + fog.rgb) * alpha, alpha);
}`;
}
