// Reflections and atmosphere: the screen-space reflection trace, and the pass that resolves it, falls
// back to the environment probe where the trace has no answer, and applies fog to everything opaque.
//
// The wet street at night is the image this renderer is built around, so the trace is designed for it:
//  - it marches in screen space with perspective-correct depth, with steps that are short near the
//    surface (contact reflections of wheels and kerbs) and long far away (a tower three blocks off);
//  - it reads LAST frame's finished image reprojected by the hit point's motion vector, so reflections
//    contain fog, glass, glow sprites and other reflections, and stay locked to moving traffic;
//  - every way of failing (ray leaves the screen, hit faces away, history missing) fades the confidence
//    smoothly to the environment fallback rather than switching, so nothing pops at the screen edge;
//  - roughness is honoured twice: the ray is jittered inside the specular lobe, and the resolve blurs
//    by the lobe's footprint at the hit distance, stretched along the reflection direction the way a
//    real wet road smears a lamp into a streak.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH, GBUFFER_READ } from '../host.js';
import { LIGHTING, SCENE_PROBE, MAX_REFLECTED } from './common.js';
import { AO_UPSAMPLE } from './lighting.js';

const PRELUDE = HEAD + surfacePrelude(LIB, 'frag');

/** Share of the surface normal's tilt that displaces the wet-road mirror image. */
const PLANAR_WOBBLE = '0.35';

/**
 * One level of the mirror image's mip chain from the level above it: each texel is the mean of a 4 x 4
 * block weighted 1 3 3 1 each way (four bilinear reads). uSource: the mirror image; uLevel = (level read,
 * 0.75 of one of its texels in x and y).
 * The plain chain (each texel the mean of its own four) keeps a thin bright line wholly in the row of texels
 * it happens to cross, so a neon tube lying at a slant across the floor came back from a blurred level as a
 * staircase. With overlapping weights the line is shared between two rows by where it lies, and the level
 * reads back as a smooth band.
 */
export const MIRROR_LEVEL_FS = HEAD + /* glsl */`
uniform sampler2D uSource;
uniform vec4 uLevel;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 o = uLevel.yz;
  outColor = 0.25 * (textureLod(uSource, vUv + vec2(-o.x, -o.y), uLevel.x) + textureLod(uSource, vUv + vec2(o.x, -o.y), uLevel.x)
    + textureLod(uSource, vUv + vec2(-o.x, o.y), uLevel.x) + textureLod(uSource, vUv + o, uLevel.x));
}`;
// Closed room: a traced ray that ends nearer than the first distance to the room's walls, floor or ceiling
// counts for nothing, one that ends further than the second counts in full (metres).
const ROOM_SHELL = ['0.25', '0.6'];
// Share of the screen-space ambient occlusion that dims specular reflections.
const SCREEN_AO_ON_SPECULAR = '0.6';


/**
 * Trace. Output 0: rgb = hit radiance times confidence, a = confidence. Output 1: r = distance to the hit in metres.
 * uSsr = (march steps, refinement steps, maximum ray length in metres, noise phase); uSsrInfo.x = 1 when last frame's image is usable.
 * uSsrRoom: the Lighting block's uProbeRoom (this pass does not bind the block): the room the scene probe stands in.
 */
export const SSR_TRACE_FS = PRELUDE + DEPTH + GBUFFER_READ + /* glsl */`
uniform sampler2D uSceneColor;
uniform vec4 uSsr;
uniform vec4 uSsrInfo;
uniform vec4 uSsrRoom[2];
in vec2 vUv;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outAux;

void main() {
  outColor = vec4(0.0); outAux = vec4(0.0);
  ivec2 px = ivec2(vUv * uViewport.xy);
  float z = texelFetch(uSceneDepth, px, 0).r;
  if (isSky(z) || uSsrInfo.x < 0.5) return;
  vec4 g1 = texelFetch(uGBuffer1, px, 0), g2 = texelFetch(uGBuffer2, px, 0);
  float wetCode = texelFetch(uGBuffer3, px, 0).a, wet = wetCode > 3.5 ? 1.0 : (wetCode > 1.5 ? 0.0 : wetCode);   // 4 = open water
  // Trace the sharper of the two lobes: the coat or water film when there is one, else the base.
  bool film = max(g2.b, wet) > 0.05;
  float rough = film ? g2.a : g2.r;
  float need = film ? 1.0 : 1.0 - smoothstep(0.38, 0.55, rough);
  if (need <= 0.0) return;

  // The position must belong to the very texel the depth came from (this pass may run at half resolution).
  vec3 N = octDecode(g1.xy), P = viewRay((vec2(px) + 0.5) * uViewport.zw) * z, V = normalize(P);
  // Blue noise decorrelated over time; the temporal filter integrates it.
  ivec2 np = (ivec2(gl_FragCoord.xy) + ivec2(int(uSsr.w) * 37, int(uSsr.w) * 59)) & 255;
  vec3 noise = vec3(texelFetch(uNoiseTex, np, 0).b, texelFetch(uNoiseTex, (np + ivec2(97, 61)) & 255, 0).b, texelFetch(uNoiseTex, (np + ivec2(171, 23)) & 255, 0).b);
  // Sample a micro-normal inside the lobe (kept to its core: the resolve supplies the rest of the blur).
  float alpha = rough * rough, phi = noise.y * TAU, spread = alpha * 0.7 * sqrt(noise.z / max(1.0 - noise.z, 0.02));
  vec3 T = normalize(cross(abs(N.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), N)), B = cross(N, T);
  vec3 H = normalize(N + (T * cos(phi) + B * sin(phi)) * min(spread, 0.35));
  vec3 R = reflect(V, H);
  if (dot(R, N) < 0.02) R = reflect(V, N);

  // Segment in camera-relative world space, clipped to the near plane, then to the screen rectangle.
  vec3 P0 = P + N * (0.01 + 0.002 * z);
  float rz = viewDepthOf(R), reach = uSsr.z;
  if (rz < 0.0) reach = min(reach, (z - 0.35) / -rz);
  if (reach < 0.05) return;
  vec4 h0 = uViewProj * vec4(P0, 1.0), h1 = uViewProj * vec4(P0 + R * reach, 1.0);
  float k0 = 1.0 / h0.w, k1 = 1.0 / h1.w;
  vec2 s0 = h0.xy * k0 * 0.5 + 0.5, ds = h1.xy * k1 * 0.5 + 0.5 - s0;
  float tMax = 1.0;
  if (ds.x > 0.0) tMax = min(tMax, (1.0 - s0.x) / ds.x); else if (ds.x < 0.0) tMax = min(tMax, -s0.x / ds.x);
  if (ds.y > 0.0) tMax = min(tMax, (1.0 - s0.y) / ds.y); else if (ds.y < 0.0) tMax = min(tMax, -s0.y / ds.y);
  float lengthLimited = tMax >= 1.0 ? 1.0 : 0.0;       // the ray ends by its length, not at the screen border
  tMax = max(tMax - 1e-4, 0.0);
  // The march starts two pixels out: closer than that it would only find the surface it starts from.
  float tMin = 2.0 / max(length(ds * uViewport.xy), 1e-4);
  if (tMin >= tMax) return;

  int steps = int(uSsr.x), refine = int(uSsr.y);
  float tPrev = 0.0, tHit = -1.0;
  bool inFront = false;                   // a crossing only counts once the ray has been seen in front of the scene
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float f = (float(i) + noise.x) / float(steps);
    float t = tMin + (tMax - tMin) * f * (0.3 + 0.7 * f);            // quadratic spacing: fine near the surface
    if (1.0 / mix(k0, k1, t) <= texelFetch(uSceneDepth, scenePixel(s0 + ds * t), 0).r) { inFront = true; tPrev = t; continue; }
    if (inFront) {
      // The ray went from in front of the scene to behind it. Find where by bisection ...
      float lo = tPrev, hi = t;
      for (int j = 0; j < 8; j++) {
        if (j >= refine) break;
        float mid = 0.5 * (lo + hi);
        if (1.0 / mix(k0, k1, mid) > texelFetch(uSceneDepth, scenePixel(s0 + ds * mid), 0).r) hi = mid; else lo = mid;
      }
      // ... and accept the crossing only if the ray meets the surface there, that is, lies in the plane of
      // the pixel it landed on. A depth difference cannot tell: on a wall seen at a grazing angle (every
      // street) a small step into the wall is a large step in depth. If the test fails the ray has passed
      // behind something nearer the camera, and the march goes on until it comes back into view.
      ivec2 q = scenePixel(s0 + ds * hi);
      float zq = texelFetch(uSceneDepth, q, 0).r;
      vec3 onScene = viewRay((vec2(q) + 0.5) * uViewport.zw) * zq;
      vec3 onRay = P0 + R * (reach * hi * k1 / mix(k0, k1, hi));
      if (abs(dot(onRay - onScene, octDecode(texelFetch(uGBuffer1, q, 0).xy))) < 0.1 + 0.02 * zq) { tHit = hi; break; }
      inFront = false;
    }
    tPrev = t;
  }
  if (tHit < 0.0) return;
  float t = tHit;
  vec2 hit = s0 + ds * t;
  ivec2 hp = scenePixel(hit);

  // Confidence.
  vec2 border = min(hit, 1.0 - hit);
  float confidence = need * smoothstep(0.0, 0.07, border.x) * smoothstep(0.0, 0.05, border.y);
  confidence *= 1.0 - smoothstep(0.85, 1.0, t / max(tMax, 1e-4)) * lengthLimited;
  vec4 hg1 = texelFetch(uGBuffer1, hp, 0);
  confidence *= 1.0 - smoothstep(0.05, 0.4, dot(octDecode(hg1.xy), R));                    // we would be seeing its back face
  // Last frame's image at the place where this surface point was then.
  vec2 prev = hit - hg1.zw;
  vec2 prevBorder = min(prev, 1.0 - prev);
  confidence *= smoothstep(0.0, 0.02, min(prevBorder.x, prevBorder.y));
  // Perspective-correct fraction of the world-space segment that the hit lies at.
  float travelled = reach * t * k1 / mix(k0, k1, t);
  if (uSsrRoom[0].w > 0.5) {
    // A closed room's probe is projected onto the room's own box, so for the walls, the floor, the ceiling
    // and the neon on them it is exact, whole and free of noise, on screen or off. A traced ray that lands
    // on a tube a pixel wide brings back sparks instead. The shell of the room is therefore left to the
    // probe, and the trace keeps what stands free inside: the car, the chest, the bench.
    vec3 end = P0 + R * travelled, inside = min(end - uSsrRoom[0].xyz, uSsrRoom[1].xyz - end);
    confidence *= smoothstep(${ROOM_SHELL[0]}, ${ROOM_SHELL[1]}, min(inside.x, min(inside.y, inside.z)));
  }
  if (confidence <= 0.0) return;
  vec3 radiance = min(textureLod(uSceneColor, prev, 0.0).rgb, vec3(${MAX_REFLECTED}));
  outColor = vec4(radiance * confidence, confidence);
  outAux = vec4(travelled, 0.0, 0.0, 1.0);
}`;

/**
 * Resolve + environment fallback + fog, blended over the lit buffer with (ONE, SRC_ALPHA):
 *   lit = lit * fog.a + (specularAmbient * fog.a + fog.rgb).
 * uReflect = (trace present, resolve taps, pixels per metre at depth 1, noise phase)
 * uReflectFx = (light shaft strength, shaft march distance in metres, ambient occlusion present, 1 = debug view of the scene probe)
 * uPlanar = (taps of the mirror fan, 0 when there is no mirror image this frame; height of the mirror plane
 *            relative to the camera; depth reconstruction A, B of the mirror's depth buffer)
 *
 * The wet-road mirror (uPlanarTex: the scene reflected in the road plane as the camera sees it, premultiplied
 * by coverage in alpha, with mips) replaces the trace on wet, near-level ground close to the plane. There
 * the trace is at its weakest: the rays graze the road, leave the screen and can never show what is hidden
 * behind the foreground, whereas the mirror image holds exactly what a level puddle reflects.
 */
export function reflectionFragment(skyGlsl) {
  return PRELUDE + DEPTH + GBUFFER_READ + skyGlsl + LIGHTING + SCENE_PROBE + AO_UPSAMPLE + /* glsl */`
uniform sampler2D uSsrColor;
uniform sampler2D uSsrAux;
uniform vec4 uReflect;
uniform vec4 uReflectFx;
uniform sampler2D uPlanarTex;
uniform highp sampler2D uPlanarDepth;
uniform vec4 uPlanar;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// How far a pixel is road-like enough to be given the mirror image: wet (or, in a closed room, lacquered or
// polished metal: film), close to level and close to the plane.
float planarShare(vec3 rel, vec3 N, float film) {
  if (uPlanar.x < 0.5) return 0.0;
  return smoothstep(0.05, 0.12, film) * smoothstep(0.94, 0.97, N.y) * (1.0 - smoothstep(0.25, 0.35, abs(rel.y - uPlanar.y)));
}

// The mirror image seen in a film of the given roughness: premultiplied radiance and coverage.
// Each tap asks "where does my reflected ray end, and where is that point in the mirror image": the ray
// is followed for the distance at which the image has something (from the mirror's own depth), its end is
// reflected in the plane and projected. For a level, smooth pixel that is the pixel itself; a rippled
// normal displaces it, and a rough film spreads the taps into a vertical fan, because tilting a facet
// towards or away from the viewer moves the reflection up and down the screen by the full angle while a
// sideways tilt moves it only by sin(grazing angle). The narrow axis is left to the mip chain.
//
// A tap is first laid out for the distance of what the pixel itself mirrors, and then moved to where its
// ray ends for the distance of what it found there. Beside the car a pixel that mirrors the far wall has a
// long fan and one that mirrors the sill a short one; laid out once, the two gather different stretches of
// the image (the long one reaching a neon tube the short one never sees) and the outline between them is
// drawn, hard, into a reflection that should be a blur. Moved, taps on either side of the outline that tilt
// towards the car end on the car and those that tilt away end on the wall, and the outline is soft.
float mirrorReach(vec2 uv, float z, float slant) {
  float d = textureLod(uPlanarDepth, uv, 0.0).r;
  float zMirror = d >= 1.0 ? 1.0e6 : uPlanar.w / (d * 2.0 - 1.0 + uPlanar.z);
  return clamp((zMirror - z) * slant, 0.3, 120.0);
}

// Where a point (relative to the camera) lies in the mirror image: clip space, w < 0.05 behind the camera.
vec4 mirrorClip(vec3 end) { return uViewProjStable * vec4(end.x, 2.0 * uPlanar.y - end.y, end.z, 1.0); }

vec4 planarReflection(vec3 rel, float z, vec3 N, vec3 V, float NoV, float rough, float noise) {
  float slant = length(rel) / z;
  float reach = mirrorReach(vUv, z, slant);
  // The fan covers facet tilts up to twice the GGX width; a reflected ray turns by twice the tilt.
  float spread = min(2.0 * rough * rough, 0.3);
  float radius = 2.0 * spread * reach * uReflect.z / (z + reach);     // half length of the fan on screen, in pixels
  int taps = radius < 0.75 ? 1 : int(uPlanar.x);
  // In texels of the mirror (two pixels each): across, the lobe is a quarter of the fan's length times
  // N.V wide; along, each mip texel must bridge the gap to the next tap, or the taps show as copies.
  // No wider than that: a thin slanted line read from a coarse level comes back as a staircase.
  float lod = log2(max(max(0.125 * radius * NoV, 0.6 * radius / float(taps)), 1.0));
  vec3 towards = V - N * dot(N, V);
  towards *= inversesqrt(max(dot(towards, towards), 1e-6));
  vec4 sum = vec4(0.0); float weight = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= taps) break;
    float t = taps == 1 ? 0.0 : (float(i) + noise) / float(taps) * 2.0 - 1.0;
    vec3 R = reflect(-V, normalize(N + towards * (t * spread)));
    R.y = max(R.y, 0.02);                                             // a ray into the road reflects nothing
    vec4 clip = mirrorClip(rel + R * reach);
    if (taps > 1 && clip.w >= 0.05) clip = mirrorClip(rel + R * mirrorReach(clip.xy / clip.w * 0.5 + 0.5, z, slant));
    float w = 1.0 / ((1.0 + 4.0 * t * t) * (1.0 + 4.0 * t * t));     // the GGX profile over the facet tilt
    weight += w;
    if (clip.w < 0.05) continue;
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5, border = min(uv, 1.0 - uv);
    sum += textureLod(uPlanarTex, uv, lod) * (w * smoothstep(0.0, 0.03, min(border.x, border.y)));
  }
  return sum / weight;
}

// Blur the traced reflection by the footprint of the specular lobe.
vec4 resolveReflection(vec2 uv, float z, float rough, vec3 rel, vec3 R, float NoV, float noise) {
  vec4 centre = textureLod(uSsrColor, uv, 0.0);
  int taps = int(uReflect.y);
  float alpha = rough * rough;
  if (taps <= 1 || alpha < 0.0015) return centre;
  // Footprint of the lobe at the hit, seen from the camera, in pixels. Where the centre ray missed, assume
  // a reflection a view-distance away so that neighbours which did hit are still gathered.
  float hitDist = textureLod(uSsrAux, uv, 0.0).r;
  if (hitDist <= 0.0) hitDist = 0.5 * z;
  float radius = min(alpha * 1.4 * hitDist * uReflect.z / (z + hitDist), 0.035 * uViewport.y);
  if (radius < 0.6) return centre;
  // Screen direction of the reflected ray: the smear is longest along it, by 1 / N.V at grazing angles.
  vec4 a = uViewProj * vec4(rel, 1.0), b = uViewProj * vec4(rel + R * max(0.25 * z, 0.5), 1.0);
  vec2 along = b.xy / max(b.w, 1e-3) - a.xy / a.w;
  along = dot(along, along) > 1e-10 ? normalize(along * uViewport.xy) : vec2(0.0, 1.0);
  vec2 across = vec2(-along.y, along.x);
  float stretch = min(1.0 / max(NoV, 0.22), 4.5);
  vec4 sum = centre; float weight = 1.0;
  float angle = noise * TAU, scale = radius / sqrt(float(taps));
  for (int i = 0; i < 12; i++) {
    if (i >= taps) break;
    float r = sqrt(float(i) + 0.5) * scale, t = angle + float(i) * 2.39996323;
    vec2 o = along * (cos(t) * r * stretch) + across * (sin(t) * r);
    vec2 q = uv + o * uViewport.zw;
    float zq = sceneDepth(q);
    // Borrow only from pixels of the same surface.
    float w = max(0.0, 1.0 - abs(zq - z) / (0.06 * z + 0.05));
    sum += textureLod(uSsrColor, q, 0.0) * w; weight += w;
  }
  return sum / weight;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  float z = texelFetch(uSceneDepth, px, 0).r;
  GPixel g = readGBuffer(px);
  vec3 rel = viewRay(vUv) * z;
  vec3 V = -normalize(rel), N = g.N;
  float NoV = abs(dot(N, V)) + 1e-4;
  vec3 R = reflect(-V, N);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uReflect.w * 5.588238, vec2(0.06711056, 0.00583715))));

  // Open water carries no meaningful occlusion (the sea bed's would be read), and its coat strength is
  // what the water shader wrote: foam lowers it, so it must not be raised to the wetness.
  bool water = g.water > 0.5;
  // The screen-space term is a half-resolution estimate of how much of the whole hemisphere is blocked.
  // It says little about the narrow cone a polished surface mirrors, and taken at full strength its
  // blotches would be stamped onto chrome and paint: it counts for part only. Baked and contact
  // occlusion describe real geometry and count in full.
  float screenAo = uReflectFx.z > 0.5 ? mix(1.0, upsampleAo(vUv, z), ${SCREEN_AO_ON_SPECULAR}) : 1.0;
  float ao = water ? 1.0 : g.ao * screenAo * litContact(rel);
  float coat = water ? g.coat : max(g.coat, g.wet), coatF0 = mix(0.04, 0.02, g.wet);
  bool film = coat > 0.05;
  vec3 f0 = litBaseF0(g.albedo, g.metal, water ? 0.0 : coat);

  vec4 traced = vec4(0.0);
  // In a closed room bare polished metal lying in the floor (the turntable's steel ring) mirrors as the
  // lacquered floor around it does. On the street only a film of water makes a mirror of the road.
  float polished = film ? coat : uProbeRoom[0].w * g.metal * (1.0 - smoothstep(0.3, 0.5, g.rough));
  float mirrored = water ? 0.0 : planarShare(rel, N, polished);
  if (uReflect.x > 0.5 && mirrored < 1.0 && (film || g.rough < 0.55)) traced = resolveReflection(vUv, z, film ? g.coatRough : g.rough, rel, R, NoV, noise);
  if (mirrored > 0.0) {
    // The surface normal carries detail far smaller than the reach of a reflected ray; taken at full
    // strength it would throw the image metres sideways from one pixel to the next. A share of it is
    // kept so that ripples and the grain of the road still break the image up.
    vec3 level = normalize(vec3(N.x * ${PLANAR_WOBBLE}, N.y, N.z * ${PLANAR_WOBBLE}));
    vec4 planar = planarReflection(rel, z, level, V, NoV, film ? g.coatRough : g.rough, noise);
    // Where the mirror image is empty (sky, or something it does not draw) the trace and then the
    // environment still show through.
    traced = mix(traced, vec4(planar.rgb + traced.rgb * (1.0 - planar.a), 1.0 - (1.0 - planar.a) * (1.0 - traced.a)), mirrored);
  }

  // Base lobe.
  vec3 aim = sceneAim(rel, R);
  vec3 base = sceneRadiance(sceneAimFor(aim, rel, R, g.rough), g.rough) * litSpecularOcclusion(NoV, ao, g.rough);
  if (!film) base = base * (1.0 - traced.a) + traced.rgb;
  // Water has one lobe only, the film below: a second dielectric lobe under it would grey the sea.
  vec3 specular = water ? vec3(0.0) : base * litEnvBrdf(f0, g.rough, NoV);
  // Coat or water film on top: it takes its share of the light first.
  if (coat > 0.003) {
    vec3 sheen = sceneRadiance(sceneAimFor(aim, rel, R, g.coatRough), g.coatRough) * litSpecularOcclusion(NoV, ao, g.coatRough);
    if (film) sheen = sheen * (1.0 - traced.a) + traced.rgb;
    // A lacquer mirrors over a wider range of angles than the split-sum term of a bare film.
    float Fc = mix(litEnvBrdf(vec3(coatF0), g.coatRough, NoV).g, litCoatMirror(coatF0, NoV, 1.0), water ? 0.0 : g.coat) * coat;
    specular = specular * (1.0 - Fc) + sheen * Fc;
  }

  vec4 fog = skyFog(rel);
  // A closed room has haze of its own and no sky to fog it.
  if (uRoomAir.x > 0.0) fog = litRoomAir(rel);
  else if (uReflectFx.x > 0.0) {
    // Light shafts: in-scattered light exists only where the air itself is lit. March the view ray through
    // the shadow cascades and dim the fog by the share of it that lies in shadow.
    float reach = min(length(rel), uReflectFx.y), litShare = 0.0;
    vec3 dir = rel / max(length(rel), 1e-4);
    for (int i = 0; i < 8; i++) litShare += litSunShadowCheap(dir * (reach * (float(i) + noise) / 8.0));
    fog.rgb *= mix(1.0, litShare / 8.0, uReflectFx.x);
  }
  outColor = vec4(specular * fog.a + fog.rgb, fog.a);
  // Debug view of the probe: what the cube holds along each view ray, replacing the lit image.
  if (uReflectFx.w > 0.5) outColor = vec4(textureLod(uSceneProbe, rel - uProbe.xyz, 0.0).rgb, 0.0);
}`;
}
