// Everything after the scene is lit: temporal anti-aliasing, motion blur, exposure metering, bloom, the
// tone map and grade, FXAA and the debug views.
//
// Brightness policy (the commissioner's brief: glow, never glare):
//  - Exposure is env.exposure (the sky module's value for the hour) times a metered correction. Ordinary
//    scenes are left alone; shade, tunnels and glare are followed within limits, closing fast and opening
//    slowly. It cannot pump, and night cannot be lifted into day.
//  - Bloom takes only what is well above display white (soft knee), spreads it with a tight core and a
//    wide, weak tail, and gives the scattered share back by subtracting it from the source, so it never
//    adds energy. A sunlit white wall is below the knee; a neon tube is far above it.
//  - The tone curve is one sigmoid with a deep toe and a long shoulder. It works on the brightest channel
//    and keeps the hue, so red paint in the sun stays red and a saturated tube rolls off to a pale but
//    still coloured core; only light that is over white in all three channels clips to white.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH } from '../host.js';

const PRELUDE = HEAD + surfacePrelude(LIB, 'frag');

/** Bloom knee in exposed units: nothing below THRESHOLD - KNEE blooms; full contribution above THRESHOLD + KNEE. */
export const BLOOM_THRESHOLD = 1.8;
export const BLOOM_KNEE = 0.5;
/** Share of the over-threshold light that is scattered at strength 1. */
export const BLOOM_AMOUNT = 0.18;
/** How much of each coarser bloom level is mixed into the next finer one: sets the core-to-tail balance. */
export const BLOOM_SPREAD = 0.6;
/**
 * The metered exposure correction: a multiplier on the sky module's exposure for the hour.
 * key: the level the meter aims for. By day it sits below photographic grey because most of a street is
 *   asphalt; at night it is the level of a road between lamp pools.
 * highlights: how far the reading leans from the log-average of the whole frame towards its bright
 *   regions. A log-average alone lets one lit patch of road burn out in an otherwise black frame; a camera's
 *   matrix meter protects that patch, and so does this.
 * min, max: outer limits of the multiplier (also reported in the renderer's stats).
 * dayMin, nightMax: by day the camera may open far (a tunnel, deep shade) but closes only a little, so a
 *   white wall stays white; at night it may close for glare but hardly opens, so night stays dark.
 * slack: stops around the key inside which nothing is corrected. Ordinary streets stay at the exposure the
 *   hour asks for and do not breathe with every building that passes.
 * open, close: seconds to cover most of the way when the scene got darker / brighter. Eyes and cameras
 *   close fast and open slowly.
 */
export const EXPOSURE_BAND = Object.freeze({
  min: 0.5, max: 2.5, keyDay: 0.13, keyNight: 0.05, highlights: 0.6, dayMin: 0.75, nightMax: 1.1, slack: 0.4, open: 2.4, close: 0.8,
});

const BLOOM_KNEE_GLSL = /* glsl */`
// Part of an exposed colour that blooms.
vec3 bloomBright(vec3 c) {
  float b = max(c.r, max(c.g, c.b));
  float soft = clamp(b - ${(BLOOM_THRESHOLD - BLOOM_KNEE).toFixed(3)}, 0.0, ${(2 * BLOOM_KNEE).toFixed(3)});
  soft = soft * soft / ${(4 * BLOOM_KNEE).toFixed(3)};
  return c * (max(soft, b - ${BLOOM_THRESHOLD.toFixed(3)}) / max(b, 1e-4));
}
`;

const SKY_VELOCITY = /* glsl */`
// Motion vector of the background: the sky is infinitely far, so only camera rotation moves it.
vec2 skyVelocity(vec2 uv) {
  vec4 p = uInvViewProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec4 q = uPrevViewProj * vec4(p.xyz / p.w, 0.0);
  return (uv * 2.0 - 1.0 - q.xy / q.w) * 0.5;
}
`;

// ------------------------------------------------------------------------------------------------ temporal AA
/**
 * Temporal resolve, which is also the upscale when dynamic resolution is active: the output (and the
 * history) are at post resolution, the current frame at render resolution.
 * uTaa = (history usable, base blend weight, 0, 0); uTaaSize = (history size, 1 / history size).
 */
export const TAA_FS = PRELUDE + DEPTH + SKY_VELOCITY + /* glsl */`
uniform sampler2D uCurrent;
uniform sampler2D uHistory;
uniform sampler2D uGBuffer1;
uniform vec4 uTaa;
uniform vec4 uTaaSize;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

// Work in a compressed range so that one very bright sample cannot dominate the filter, and in YCoCg so
// that the clipping box is aligned with luminance.
vec3 compress(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 expand(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-4); }
vec3 toYCoCg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 fromYCoCg(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
vec3 fetchCurrent(vec2 uv) { return toYCoCg(compress(max(textureLod(uCurrent, uv, 0.0).rgb, 0.0))); }

// Catmull-Rom reconstruction of the history in five bilinear taps (the corner lobes are dropped):
// bilinear history blurs a little more every frame, this does not.
vec3 fetchHistory(vec2 uv) {
  vec2 pos = uv * uTaaSize.xy, centre = floor(pos - 0.5) + 0.5, f = pos - centre;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 t0 = (centre - 1.0) * uTaaSize.zw, t12 = (centre + w2 / w12) * uTaaSize.zw, t3 = (centre + 2.0) * uTaaSize.zw;
  float wa = w12.x * w0.y, wb = w0.x * w12.y, wc = w12.x * w12.y, wd = w3.x * w12.y, we = w12.x * w3.y;
  vec3 c = textureLod(uHistory, vec2(t12.x, t0.y), 0.0).rgb * wa + textureLod(uHistory, vec2(t0.x, t12.y), 0.0).rgb * wb
    + textureLod(uHistory, t12, 0.0).rgb * wc + textureLod(uHistory, vec2(t3.x, t12.y), 0.0).rgb * wd + textureLod(uHistory, vec2(t12.x, t3.y), 0.0).rgb * we;
  return max(c / (wa + wb + wc + wd + we), 0.0);
}

void main() {
  vec2 texel = uViewport.zw;
  // Motion of the nearest surface in the neighbourhood, so that the silhouette of a moving object carries its own edge.
  ivec2 px = scenePixel(vUv), best = px;
  float zBest = texelFetch(uSceneDepth, px, 0).r;
  for (int i = 0; i < 4; i++) {
    ivec2 q = clamp(px + ivec2((i & 1) * 2 - 1, (i >> 1) * 2 - 1), ivec2(0), ivec2(uViewport.xy) - 1);
    float zq = texelFetch(uSceneDepth, q, 0).r;
    if (zq < zBest) { zBest = zq; best = q; }
  }
  vec2 velocity = isSky(zBest) ? skyVelocity(vUv) : texelFetch(uGBuffer1, best, 0).ba;

  // Statistics of the current frame around this pixel.
  vec3 centre = fetchCurrent(vUv), m1 = centre, m2 = centre * centre, lo = centre, hi = centre;
  for (int i = 0; i < 8; i++) {
    int k = i < 4 ? i : i + 1;
    vec3 c = fetchCurrent(vUv + vec2(float(k % 3 - 1), float(k / 3 - 1)) * texel);
    m1 += c; m2 += c * c; lo = min(lo, c); hi = max(hi, c);
  }
  vec3 mean = m1 / 9.0, sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
  vec3 boxLo = max(lo, mean - 1.15 * sigma), boxHi = min(hi, mean + 1.15 * sigma);

  vec2 prevUv = vUv - velocity;
  vec2 border = min(prevUv, 1.0 - prevUv);
  float usable = uTaa.x * step(0.0, min(border.x, border.y));
  vec3 history = toYCoCg(compress(fetchHistory(clamp(prevUv, vec2(0.0), vec2(1.0)))));
  // Clip towards the box centre: keeps the history's detail where it is consistent, rejects it where not.
  vec3 boxCentre = 0.5 * (boxLo + boxHi), extent = 0.5 * (boxHi - boxLo) + 1e-5, d = history - boxCentre;
  vec3 a = abs(d / extent);
  float m = max(a.x, max(a.y, a.z));
  if (m > 1.0) history = boxCentre + d / m;

  // Fast screen motion makes the reconstruction less exact: lean more on the new frame there.
  float speed = length(velocity * uViewport.xy);
  float blend = mix(1.0, mix(uTaa.y, 0.2, saturate(speed / 48.0)), usable);
  vec3 result = expand(fromYCoCg(mix(history, centre, blend)));
  // A single invalid value would live in the history for ever.
  if (any(isnan(result)) || any(isinf(result))) result = vec3(0.0);
  outColor = vec4(max(result, 0.0), 1.0);
}`;

/** Resolve without temporal filtering (antialiasing off or FXAA): scales the frame to post resolution. */
export const COPY_FS = HEAD + /* glsl */`
uniform sampler2D uCurrent;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(max(textureLod(uCurrent, vUv, 0.0).rgb, 0.0), 1.0); }`;

// ------------------------------------------------------------------------------------------------ motion blur
// Per-pixel velocity blur as a reconstruction filter, in four steps:
//   1. tile max:   the fastest motion inside each TILE x TILE block of pixels (in two stages);
//   2. neighbour:  the fastest motion among a tile and its eight neighbours, so a streak can reach into
//                  pixels that are not moving themselves;
//   3. gather:     at half resolution, samples along that dominant direction, each weighted by whether it
//                  can physically cover this pixel: it is in front and moving far enough, or it is behind
//                  and this pixel moves far enough to uncover it;
//   4. apply:      at full resolution, the gathered light over the sharp pixel.
// A sharp object in front of a streaking background (the player's car in the chase view) therefore stays
// sharp and does not leak into the road, while the road streaks. (A wheel turning fast is drawn as a
// blurred disc by the vehicle shader; a rigid velocity per pixel cannot describe its rotation.)
// Steps 1 and 3 share uBlur = (most taps, velocity scale, longest streak in frame heights, noise phase). The velocity
// scale is the shutter fraction normalised to a 60 Hz frame, so the look does not change with the frame rate.

/** Side of a motion-blur tile in render pixels. */
export const BLUR_TILE = 64;
/** Streak length in render pixels below which a pixel is left sharp, and from which the gathered blur shows in full. */
const BLUR_SHARP_BELOW = 2, BLUR_FULL_ABOVE = 8;

/**
 * Share of the camera's turning that is taken out of the motion a pixel is blurred by. A camera operator pans
 * with the subject and the eye follows a corner, so a turn does not read as blur to a driver; what does is the
 * road going past. Without this the whole frame smears around the car whenever the chase camera swings.
 */
export const BLUR_TURN_REMOVED = 0.85;

const BLUR_VELOCITY = SKY_VELOCITY + /* glsl */`
uniform sampler2D uGBuffer1;
uniform vec4 uBlur;
// Blur vector (uv, whole exposure) of the surface at a pixel, and its depth.
vec2 blurVelocity(ivec2 px, vec2 uv, out float z) {
  z = texelFetch(uSceneDepth, px, 0).r;
  // What turning the camera does to this pixel at any distance: the motion of the sky behind it.
  vec2 turn = skyVelocity(uv);
  vec2 v = isSky(z) ? turn : texelFetch(uGBuffer1, px, 0).ba;
  // Only the part of the motion that lies along the turn is removed, and never more of it than is there:
  // the player's car, which the chase camera turns with and which hardly moves on screen, is left alone
  // instead of being given the turn backwards.
  v -= turn * (${BLUR_TURN_REMOVED} * clamp(dot(v, turn) / max(dot(turn, turn), 1e-14), 0.0, 1.0));
  v *= uBlur.y;
  float len = length(v * uViewport.xy) * uViewport.w;      // in frame heights, the unit of the cap
  return len > uBlur.z ? v * (uBlur.z / len) : v;
}
`;

/**
 * Step 1a, into a target of uCells.xy cells (an eighth of the frame each way): the fastest motion among the
 * scene pixels under each cell, visiting every second one in a checkerboard. The reduction to tiles is done
 * in two stages because one fragment reading a whole tile is thousands of fetches in a row, which a GPU
 * runs far slower than the same fetches spread over many fragments.
 */
export const BLUR_TILE_FS = PRELUDE + DEPTH + BLUR_VELOCITY + /* glsl */`
uniform vec2 uCells;
layout(location = 0) out vec4 outVelocity;
void main() {
  vec2 perCell = uViewport.xy / uCells;
  ivec2 top = ivec2(uViewport.xy) - 1;
  ivec2 lo = ivec2(floor((gl_FragCoord.xy - 0.5) * perCell)), hi = min(ivec2(ceil((gl_FragCoord.xy + 0.5) * perCell)) - 1, top);
  vec2 best = vec2(0.0); float bestLen = 0.0;
  for (int y = lo.y; y <= hi.y; y++) for (int x = lo.x + ((lo.x + y) & 1); x <= hi.x; x += 2) {
    ivec2 px = ivec2(x, y);
    float z;
    vec2 v = blurVelocity(px, (vec2(px) + 0.5) * uViewport.zw, z);
    float len = dot(v, v);
    if (len > bestLen) { bestLen = len; best = v; }
  }
  outVelocity = vec4(best, 0.0, 1.0);
}`;

/**
 * Steps 1b and 2: the fastest motion among the texels of uTiles under this fragment and uReach.z fragments
 * around it. uReach.xy is the width of one fragment in uv. Step 1b reduces the cells of step 1a to tiles
 * (reach 0); step 2 reads the tiles themselves (reach 1: a tile and its eight neighbours).
 */
export const BLUR_NEIGHBOUR_FS = HEAD + /* glsl */`
uniform sampler2D uTiles;
uniform vec3 uReach;
layout(location = 0) out vec4 outVelocity;
void main() {
  vec2 size = vec2(textureSize(uTiles, 0)), perFragment = uReach.xy * size;
  // The small margin keeps a ratio that should be a whole number from spilling into the next texel.
  ivec2 lo = max(ivec2(floor((gl_FragCoord.xy - 0.5 - uReach.z) * perFragment + 0.001)), ivec2(0));
  ivec2 hi = min(ivec2(ceil((gl_FragCoord.xy + 0.5 + uReach.z) * perFragment - 0.001)), ivec2(size)) - 1;
  vec2 best = vec2(0.0); float bestLen = 0.0;
  for (int y = lo.y; y <= hi.y; y++) for (int x = lo.x; x <= hi.x; x++) {
    vec2 v = texelFetch(uTiles, ivec2(x, y), 0).xy;
    float len = dot(v, v);
    if (len > bestLen) { bestLen = len; best = v; }
  }
  outVelocity = vec4(best, 0.0, 1.0);
}`;

/**
 * Step 3, at half post resolution: the gather. Long streaks read three textures per sample far apart, which
 * is what motion blur costs; at half resolution that is a quarter of the work, and what is lost is detail
 * inside a streak, where there is none to see. rgb = the light the samples account for, a = the share of
 * the exposure they cover; step 4 fills the rest with the sharp pixel.
 * The alpha of the colour buffer is a blur mask: 1 = ordinary scene, 0 = an effect drawn on top that has no
 * motion vector of its own (exhaust flames) and must neither be smeared nor smear.
 */
export const MOTION_BLUR_FS = PRELUDE + DEPTH + BLUR_VELOCITY + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uTiles;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
// 1 when a is in front of b, falling to 0 as it goes behind; soft so that a sloping road does not band.
float inFront(float a, float b) { return saturate(1.0 - (a - b) / (0.02 * min(a, b) + 0.05)); }
float cone(float dist, float reach) { return saturate(1.0 - dist / max(reach, 1e-6)); }
float cylinder(float dist, float reach) { return 1.0 - smoothstep(0.95 * reach, 1.05 * reach + 1e-6, dist); }
void main() {
  outColor = vec4(0.0);
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uBlur.w * 5.588238, vec2(0.06711056, 0.00583715))));
  // Jitter the tile lookup so that tile borders dissolve instead of showing as blocks.
  vec2 tiles = vec2(textureSize(uTiles, 0));
  vec2 tileUv = vUv * uViewport.xy / (tiles * ${BLUR_TILE}.0) + (vec2(noise, fract(noise * 7.31)) - 0.5) * 0.6 / tiles;
  vec2 dominant = textureLod(uTiles, tileUv, 0.0).xy;
  float span = length(dominant * uViewport.xy);            // render pixels covered during the exposure
  if (span < ${BLUR_SHARP_BELOW.toFixed(1)}) return;

  float zc;
  vec2 vc = blurVelocity(scenePixel(vUv), vUv, zc);
  float reachC = 0.5 * length(vc * uViewport.xy);
  // A short streak needs fewer samples than a long one: about one every three pixels, never fewer than four.
  int taps = min(int(uBlur.x), 4 + int(span * 0.3));
  vec4 sum = vec4(0.0);
  for (int i = 0; i < 32; i++) {
    if (i >= taps) break;
    float t = (float(i) + noise) / float(taps) - 0.5;
    vec2 uv = vUv + dominant * t;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    float zs;
    vec2 vs = blurVelocity(scenePixel(uv), uv, zs);
    float dist = abs(t) * span, reachS = 0.5 * length(vs * uViewport.xy);
    float w = inFront(zs, zc) * cone(dist, reachS) + inFront(zc, zs) * cone(dist, reachC) + 2.0 * cylinder(dist, reachS) * cylinder(dist, reachC);
    vec4 c = textureLod(uColor, uv, 0.0);
    sum += vec4(c.rgb, 1.0) * (min(w, 1.0) * c.a);
  }
  // Streaks of a few pixels stay with the full-resolution image: half resolution would only soften them.
  outColor = sum * (smoothstep(${BLUR_SHARP_BELOW.toFixed(1)}, ${BLUR_FULL_ABOVE.toFixed(1)}, span) / float(taps));
}`;

/**
 * Step 4, at post resolution: the sharp pixel shows for whatever share of the exposure the gather did not
 * cover. The half-resolution result is read from the four nearest texels weighted by how well their depth
 * matches this pixel's, so that the road's blur stops at the outline of the car instead of bleeding a
 * texel into it.
 */
export const MOTION_BLUR_APPLY_FS = PRELUDE + DEPTH + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uBlurred;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 centre = textureLod(uColor, vUv, 0.0);
  float zc = texelFetch(uSceneDepth, scenePixel(vUv), 0).r;
  vec2 size = vec2(textureSize(uBlurred, 0));
  vec2 at = vUv * size - 0.5;
  ivec2 base = ivec2(floor(at)), top = ivec2(size) - 1;
  vec2 f = at - floor(at);
  vec4 sum = vec4(0.0); float total = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 corner = ivec2(i & 1, i >> 1), q = clamp(base + corner, ivec2(0), top);
    // The gather measured depth at the scene pixel under the centre of its texel.
    float z = texelFetch(uSceneDepth, scenePixel((vec2(q) + 0.5) / size), 0).r;
    vec2 side = mix(1.0 - f, f, vec2(corner));
    float w = (side.x * side.y + 0.02) / (0.02 + abs(z - zc) / min(z, zc));
    sum += texelFetch(uBlurred, q, 0) * w; total += w;
  }
  vec4 gathered = sum / total;
  vec3 blurred = centre.rgb * (1.0 - min(gathered.a, 1.0)) + gathered.rgb;
  outColor = vec4(mix(centre.rgb, blurred, centre.a), 1.0);
}`;

// ------------------------------------------------------------------------------------------------ depth of field
/** Most samples the depth of field gather may be asked for (its loop bound). */
export const DOF_TAPS_MOST = 32;
/**
 * Depth of field of a real lens, one gather at post resolution, for a camera that stands still and looks at
 * one thing (the garage). A point at depth z is spread over a disc whose radius the thin lens equation gives:
 * proportional to |1 - focus / z|. Each pixel gathers over its own disc and takes from a sample what that
 * sample's disc would have thrown on it, with one rule about order: a surface behind this pixel is seen past
 * it only as far as this pixel's own disc reaches. So a soft wall never bleeds over the sharp outline of the
 * car in front of it, while the car's edge still cuts cleanly into the wall's blur.
 * uLens = (focus distance in metres, disc radius in pixels per unit of |1 - focus / z|, largest radius in
 * pixels, samples). Alpha (the motion blur mask) passes through.
 */
export const DEPTH_OF_FIELD_FS = PRELUDE + DEPTH + /* glsl */`
uniform sampler2D uColor;
uniform vec4 uLens;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float disc(float z) { return min(abs(1.0 - uLens.x / z) * uLens.y, uLens.z); }
void main() {
  vec4 centre = textureLod(uColor, vUv, 0.0);
  vec2 texel = 1.0 / vec2(textureSize(uColor, 0));
  float zc = sceneDepth(vUv), rc = disc(zc);
  // The resolve has already drawn the car's outline into the pixels on both sides of it, while depth says
  // car or wall. A wall pixel that carries part of that outline would trade it for blurred wall, and the
  // outline would turn into this frame's stair steps; so a pixel is as sharp as the sharpest beside it.
  rc = min(rc, min(min(disc(sceneDepth(vUv + vec2(texel.x, 0.0))), disc(sceneDepth(vUv - vec2(texel.x, 0.0)))),
                   min(disc(sceneDepth(vUv + vec2(0.0, texel.y))), disc(sceneDepth(vUv - vec2(0.0, texel.y))))));
  outColor = centre;
  if (rc < 0.5) return;                                    // in focus: the pixel is itself
  // The sample pattern is turned from pixel to pixel so that what a few samples miss shows as grain, not as rings.
  float turn = TAU * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  int taps = int(uLens.w);
  vec3 sum = centre.rgb; float total = 1.0;
  for (int i = 0; i < ${DOF_TAPS_MOST}; i++) {
    if (i >= taps) break;
    // Sunflower spiral: every sample stands for the same area of the disc.
    float radius = rc * sqrt((float(i) + 0.5) / float(taps)), angle = float(i) * 2.39996323 + turn;
    vec2 uv = vUv + vec2(cos(angle), sin(angle)) * radius * texel;
    float zs = sceneDepth(uv), rs = disc(zs);
    if (zs > zc) rs = min(rs, rc);
    float w = saturate(rs - radius + 1.0);
    sum += textureLod(uColor, uv, 0.0).rgb * w; total += w;
  }
  outColor = vec4(sum / total, centre.a);
}`;

// ------------------------------------------------------------------------------------------------ bloom and metering
/**
 * First bloom level, at half post resolution: 13-tap downsample in five groups, each weighted by
 * 1 / (1 + brightness) so that one hot pixel cannot flicker the whole halo, then the soft knee.
 * rgb = light that blooms (exposed units), a = log2 of the exposed luminance for the exposure meter.
 * uPrefilter = (exposure, 0, 0, 0).
 */
export const BLOOM_PREFILTER_FS = HEAD + BLOOM_KNEE_GLSL + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uExposureTex;
uniform vec4 uPrefilter;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float brightness(vec3 c) { return max(c.r, max(c.g, c.b)); }
vec4 group(vec3 a, vec3 b, vec3 c, vec3 d) {
  vec3 mean = (a + b + c + d) * 0.25;
  return vec4(mean, 1.0) / (1.0 + brightness(mean));
}
void main() {
  vec2 t = 1.0 / vec2(textureSize(uColor, 0));
  float e = uPrefilter.x * texelFetch(uExposureTex, ivec2(0), 0).r;
#define TAP(x, y) (min(textureLod(uColor, vUv + vec2(x, y) * t, 0.0).rgb * e, vec3(48.0)))
  vec3 a = TAP(-2.0, -2.0), b = TAP(0.0, -2.0), c = TAP(2.0, -2.0);
  vec3 d = TAP(-2.0, 0.0), m = TAP(0.0, 0.0), f = TAP(2.0, 0.0);
  vec3 g = TAP(-2.0, 2.0), h = TAP(0.0, 2.0), i = TAP(2.0, 2.0);
  vec3 j = TAP(-1.0, -1.0), k = TAP(1.0, -1.0), l = TAP(-1.0, 1.0), n = TAP(1.0, 1.0);
  vec4 sum = group(j, k, l, n) * 0.5 + (group(a, b, d, m) + group(b, c, m, f) + group(d, m, g, h) + group(m, f, h, i)) * 0.125;
  vec3 mean = sum.rgb / sum.a;
  // The meter ignores what is far outside the displayable range, so lamps do not drive exposure down.
  float luminance = clamp(dot(mean, vec3(0.2126, 0.7152, 0.0722)), 0.004, 3.0);
  outColor = vec4(bloomBright(mean), log2(luminance));
}`;

/** Further bloom levels: the same 13-tap kernel without the weighting. */
export const BLOOM_DOWN_FS = HEAD + /* glsl */`
uniform sampler2D uColor;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uColor, 0));
#define TAP(x, y) textureLod(uColor, vUv + vec2(x, y) * t, 0.0)
  vec4 a = TAP(-2.0, -2.0), b = TAP(0.0, -2.0), c = TAP(2.0, -2.0);
  vec4 d = TAP(-2.0, 0.0), m = TAP(0.0, 0.0), f = TAP(2.0, 0.0);
  vec4 g = TAP(-2.0, 2.0), h = TAP(0.0, 2.0), i = TAP(2.0, 2.0);
  vec4 j = TAP(-1.0, -1.0), k = TAP(1.0, -1.0), l = TAP(-1.0, 1.0), n = TAP(1.0, 1.0);
  outColor = (j + k + l + n) * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + m * 0.125;
}`;

/** Upsample: 3x3 tent of the coarser accumulated level, mixed into this level. uSpread = share of the coarser level. */
export const BLOOM_UP_FS = HEAD + /* glsl */`
uniform sampler2D uColor;     // this level (downsampled)
uniform sampler2D uCoarse;    // accumulated coarser levels
uniform float uSpread;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uCoarse, 0));
  vec3 c = textureLod(uCoarse, vUv, 0.0).rgb * 4.0;
  c += (textureLod(uCoarse, vUv + vec2(t.x, 0.0), 0.0).rgb + textureLod(uCoarse, vUv - vec2(t.x, 0.0), 0.0).rgb
      + textureLod(uCoarse, vUv + vec2(0.0, t.y), 0.0).rgb + textureLod(uCoarse, vUv - vec2(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureLod(uCoarse, vUv + t, 0.0).rgb + textureLod(uCoarse, vUv - t, 0.0).rgb
     + textureLod(uCoarse, vUv + vec2(t.x, -t.y), 0.0).rgb + textureLod(uCoarse, vUv + vec2(-t.x, t.y), 0.0).rgb;
  outColor = vec4(mix(textureLod(uColor, vUv, 0.0).rgb, c * (1.0 / 16.0), uSpread), 1.0);
}`;

/**
 * Exposure correction, one texel. Reads the meter (alpha of the coarsest bloom level: log2 of luminance,
 * averaged region by region), centre weighted with a lean towards the bright regions, and moves the stored
 * correction towards its target at a bounded rate.
 * uAdapt = (key, min, max, seconds since the last frame; negative = jump to the target)
 */
export const EXPOSURE_FS = HEAD + /* glsl */`
uniform sampler2D uMeter;
uniform sampler2D uPrevious;
uniform vec4 uAdapt;
layout(location = 0) out vec4 outColor;
void main() {
  float sum = 0.0, bright = 0.0, weight = 0.0;
  for (int y = 0; y < 5; y++) for (int x = 0; x < 7; x++) {
    vec2 uv = (vec2(float(x), float(y)) + 0.5) / vec2(7.0, 5.0);
    vec2 c = uv - vec2(0.5, 0.45);
    float w = exp(-dot(c, c) * 5.0);                // the road ahead matters more than the corners
    float region = textureLod(uMeter, uv, 0.0).a;
    sum += region * w; bright += exp2(region) * w; weight += w;
  }
  // The mean of the regions' levels is at or above their log-average, by more the more uneven the frame.
  float reading = mix(sum / weight, log2(bright / weight), ${EXPOSURE_BAND.highlights.toFixed(2)});
  float previous = texelFetch(uPrevious, ivec2(0), 0).r;
  // The meter saw the scene through the previous correction; undo it to get the correction the scene wants.
  float wanted = log2(uAdapt.x) - (reading - log2(max(previous, 1e-3)));
  wanted = sign(wanted) * max(abs(wanted) - ${EXPOSURE_BAND.slack.toFixed(2)}, 0.0);
  float target = clamp(exp2(wanted), uAdapt.y, uAdapt.z);
  float seconds = target < previous ? ${EXPOSURE_BAND.close.toFixed(2)} : ${EXPOSURE_BAND.open.toFixed(2)};
  float next = uAdapt.w < 0.0 ? target : mix(previous, target, 1.0 - exp(-uAdapt.w / seconds));
  outColor = vec4(next != next ? 1.0 : clamp(next, uAdapt.y, uAdapt.z), 0.0, 0.0, 1.0);
}`;

// ------------------------------------------------------------------------------------------------ tone map and grade
/**
 * The camera's response. `contrast` is the exponent of the sigmoid (its slope on a log-log plot through the
 * dark half, where film and sensors with a picture profile sit near 1.4 to 1.5); `grey` is the exposed value
 * that is shown as itself; `white` is the exposed value that reaches display white.
 */
export const TONE = Object.freeze({ contrast: 1.45, grey: 0.18, white: 24 });
/** Scene-linear saturation of the neutral camera, before the grade for the hour: a little under the scene's. */
export const CAMERA_SATURATION = 0.86;
/** How far colours over display white lose saturation: 0 = never, 1 = like a sensor clipping channel by channel. */
export const SENSOR_CLIP = 0.35;
/**
 * That share for a source the camera looks straight into. It grows from SENSOR_CLIP at `from` (exposed units:
 * a lamp lens across the street) to `most` where the curve itself reaches white, so that the glass of a neon
 * tube or a headlamp filament is nearly white and its colour is in the glow around it, as it is in a photograph.
 */
export const SENSOR_CLIP_SOURCE = Object.freeze({ from: 6, most: 0.85 });

// y = scale * x^n / (x^n + shoulder), solved so that grey maps to grey and white to 1.
const TONE_GREY_N = Math.pow(TONE.grey, TONE.contrast), TONE_WHITE_N = Math.pow(TONE.white, TONE.contrast);
export const TONE_SHOULDER = TONE_WHITE_N * TONE_GREY_N * (1 - TONE.grey) / (TONE.grey * TONE_WHITE_N - TONE_GREY_N);
export const TONE_SCALE = (TONE_WHITE_N + TONE_SHOULDER) / TONE_WHITE_N;

export const TONE_CURVE_GLSL = /* glsl */`
// A single sigmoid in exposed units. Its toe is a power law, so unlit surfaces fall to black instead of
// sitting on a grey veil; its shoulder closes in on white slowly (0.73 at 1, 0.88 at 2, 0.96 at 4), so a
// sunlit white wall or the pool of a headlamp keeps its gradients instead of clipping to a flat patch.
vec3 toneCurve(vec3 x) {
  vec3 p = pow(max(x, 0.0), vec3(${TONE.contrast.toFixed(3)}));
  return min(p * ${TONE_SCALE.toFixed(5)} / (p + ${TONE_SHOULDER.toFixed(5)}), 1.0);
}
vec3 toneMap(vec3 c) {
  c = max(c, 0.0);
  float peak = max(c.r, max(c.g, c.b)), low = min(c.r, min(c.g, c.b));
  float shown = toneCurve(vec3(peak)).r, base = toneCurve(vec3(low)).r;
  // The brightest channel goes through the curve; the other two follow it on a straight line, so the hue
  // never bends (red paint in the sun rolls off to a lighter red, not through orange to pink, which is
  // what a curve per channel does once red clips and green catches up). The slope of that line sets how
  // much colour survives: shown / peak keeps all of it, which leaves lamps garish; the slope through the
  // darkest channel's own curve value loses as much as a sensor whose channels clip one by one, which
  // turns a brake lamp white. In between, a lens keeps its colour; the share grows for what is far over
  // white, so the glass of a tube is pale and the colour is in its halo.
  float clipped = mix(${SENSOR_CLIP.toFixed(2)}, ${SENSOR_CLIP_SOURCE.most.toFixed(2)}, smoothstep(${SENSOR_CLIP_SOURCE.from.toFixed(1)}, ${TONE.white.toFixed(1)}, peak));
  float slope = mix(shown / max(peak, 1e-6), (shown - base) / max(peak - low, 1e-6), clipped);
  return shown - (peak - c) * slope;
}
vec3 encodeSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

/**
 * Final image. uTone = (base exposure, bloom amount, fade to black 0..1, time), uGradeTint = (tint rgb, contrast),
 * uGradeShadow = (shadow tint rgb, saturation), uFx = (vignette, grain, chromatic aberration, sharpen),
 * uSpeed.x = radial stretch under boost (0 = none).
 */
export const TONEMAP_FS = HEAD + BLOOM_KNEE_GLSL + TONE_CURVE_GLSL + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uBloom;
uniform sampler2D uExposureTex;
uniform sampler2D uNoiseTex;
uniform vec4 uTone;
uniform vec4 uGradeTint;
uniform vec4 uGradeShadow;
uniform vec4 uFx;
uniform vec4 uSpeed;
in vec2 vUv;
layout(location = 0) out vec4 outColor;

void main() {
  vec2 t = 1.0 / vec2(textureSize(uColor, 0)), fromCentre = vUv - 0.5;
  ivec2 np = (ivec2(gl_FragCoord.xy) + ivec2(int(uTone.w * 60.0) * 61, int(uTone.w * 60.0) * 29)) & 255;
  float noise = texelFetch(uNoiseTex, np, 0).b;
  // Lens-like terms that grow with the cube of the distance from the centre, so the middle of the frame
  // (the car, the road ahead) is untouched: lateral chromatic aberration, and under boost a radial stretch.
  vec2 radial = fromCentre * dot(fromCentre, fromCentre), fringe = radial * uFx.z;
  vec3 c;
  if (uSpeed.x > 0.0) {
    c = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      vec2 uv = vUv - radial * (uSpeed.x * (float(i) + noise) / 6.0);
      c += vec3(textureLod(uColor, uv + fringe, 0.0).r, textureLod(uColor, uv, 0.0).g, textureLod(uColor, uv - fringe, 0.0).b);
    }
    c /= 6.0;
  } else if (uFx.z > 0.0) {
    c = vec3(textureLod(uColor, vUv + fringe, 0.0).r, textureLod(uColor, vUv, 0.0).g, textureLod(uColor, vUv - fringe, 0.0).b);
  } else c = textureLod(uColor, vUv, 0.0).rgb;
  if (uFx.w > 0.0) {
    // Mild unsharp mask, limited in proportion to the local brightness so it cannot ring around lamps.
    vec3 around = (textureLod(uColor, vUv + vec2(t.x, 0.0), 0.0).rgb + textureLod(uColor, vUv - vec2(t.x, 0.0), 0.0).rgb
                 + textureLod(uColor, vUv + vec2(0.0, t.y), 0.0).rgb + textureLod(uColor, vUv - vec2(0.0, t.y), 0.0).rgb) * 0.25;
    float limit = 0.2 * max(c.g, around.g) + 1e-4;
    c = max(c + clamp((c - around) * uFx.w, -limit, limit), 0.0);
  }
  c *= uTone.x * texelFetch(uExposureTex, ivec2(0), 0).r;
  // Bloom moves light, it does not create it: what is scattered into the halo is taken from the source.
  c = max(c + uTone.y * (textureLod(uBloom, vUv, 0.0).rgb - bloomBright(c)), 0.0);

  // Grade in scene-referred space, before the curve, so that highlights still roll off afterwards.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c *= mix(uGradeShadow.rgb, uGradeTint.rgb, smoothstep(0.0, 0.5, lum));
  c = 0.18 * pow(c / 0.18, vec3(uGradeTint.a));
  lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Saturation is a property of the picture, not of the lamps in it: lights over white keep theirs, or a
  // red lens would pick up grey from its own luminance and go pink.
  float peak = max(c.r, max(c.g, c.b)), lit = smoothstep(1.0, 4.0, peak);
  // Nor does it touch colours that are already pure: a camera mutes the greys, sands and greens of a
  // street, while a saturated red panel stays as red as its paint.
  float purity = (peak - min(c.r, min(c.g, c.b))) / max(peak, 1e-5);
  c = max(mix(vec3(lum), c, 1.0 + (uGradeShadow.a - 1.0) * (1.0 - lit) * (1.0 - purity * purity)), 0.0);

  c = toneMap(c);
  c *= 1.0 - uFx.x * smoothstep(0.25, 1.1, dot(fromCentre, fromCentre) * 2.6);
  c *= 1.0 - uTone.z;
  c = encodeSrgb(c);
  // Grain is strongest in the mid tones and vanishes in clipped whites; the same noise breaks up 8-bit banding in dark gradients.
  c += (noise - 0.5) * (uFx.y * (1.0 - 0.7 * dot(c, vec3(0.3333))) + 1.5 / 255.0);
  outColor = vec4(c, 1.0);
}`;

// ------------------------------------------------------------------------------------------------ present / FXAA
/**
 * Copies the display-referred image to the canvas, with FXAA when uPresent.x = 1.
 * Edge search after Lottes (FXAA 3.11): find the edge orientation from the local luma gradient, walk along
 * it in both directions to find its ends, and shift the sample across the edge by the pixel's position on it.
 */
export const PRESENT_FS = HEAD + /* glsl */`
uniform sampler2D uColor;
uniform vec4 uPresent;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float lumaAt(vec2 uv) { return luma(textureLod(uColor, uv, 0.0).rgb); }
void main() {
  vec3 centre = textureLod(uColor, vUv, 0.0).rgb;
  outColor = vec4(centre, 1.0);
  if (uPresent.x < 0.5) return;
  vec2 t = 1.0 / vec2(textureSize(uColor, 0));
  float lM = luma(centre);
  float lN = lumaAt(vUv + vec2(0.0, t.y)), lS = lumaAt(vUv - vec2(0.0, t.y)), lE = lumaAt(vUv + vec2(t.x, 0.0)), lW = lumaAt(vUv - vec2(t.x, 0.0));
  float lMin = min(lM, min(min(lN, lS), min(lE, lW))), lMax = max(lM, max(max(lN, lS), max(lE, lW))), range = lMax - lMin;
  if (range < max(0.0312, lMax * 0.125)) return;
  float lNE = lumaAt(vUv + t), lSW = lumaAt(vUv - t), lNW = lumaAt(vUv + vec2(-t.x, t.y)), lSE = lumaAt(vUv + vec2(t.x, -t.y));
  float edgeH = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lN + lS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
  float edgeV = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lW + lE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
  bool horizontal = edgeV >= edgeH;                       // the edge runs horizontally: blend vertically
  float l1 = horizontal ? lS : lW, l2 = horizontal ? lN : lE;
  float g1 = l1 - lM, g2 = l2 - lM;
  bool steeper1 = abs(g1) >= abs(g2);
  float gradient = 0.25 * max(abs(g1), abs(g2));
  float stepLength = horizontal ? t.y : t.x;
  float lumaEdge = 0.5 * ((steeper1 ? l1 : l2) + lM);
  if (steeper1) stepLength = -stepLength;
  vec2 edgeUv = vUv;
  if (horizontal) edgeUv.y += stepLength * 0.5; else edgeUv.x += stepLength * 0.5;
  vec2 along = horizontal ? vec2(t.x, 0.0) : vec2(0.0, t.y);
  vec2 uv1 = edgeUv - along, uv2 = edgeUv + along;
  float e1 = lumaAt(uv1) - lumaEdge, e2 = lumaAt(uv2) - lumaEdge;
  bool done1 = abs(e1) >= gradient, done2 = abs(e2) >= gradient;
  for (int i = 0; i < 9; i++) {
    if (done1 && done2) break;
    float stride = i < 3 ? 1.0 : (i < 6 ? 2.0 : 4.0);
    if (!done1) { uv1 -= along * stride; e1 = lumaAt(uv1) - lumaEdge; done1 = abs(e1) >= gradient; }
    if (!done2) { uv2 += along * stride; e2 = lumaAt(uv2) - lumaEdge; done2 = abs(e2) >= gradient; }
  }
  float d1 = horizontal ? vUv.x - uv1.x : vUv.y - uv1.y, d2 = horizontal ? uv2.x - vUv.x : uv2.y - vUv.y;
  bool nearer1 = d1 < d2;
  float edgeOffset = 0.5 - min(d1, d2) / (d1 + d2);
  // Only shift if the end of the edge confirms which side of it this pixel is on.
  bool correct = ((nearer1 ? e1 : e2) < 0.0) != (lM < lumaEdge);
  float offset = correct ? edgeOffset : 0.0;
  // Sub-pixel aliasing: a single bright pixel is blended with its surroundings.
  float average = (2.0 * (lN + lS + lE + lW) + lNE + lNW + lSE + lSW) / 12.0;
  float sub = smoothstep(0.0, 1.0, abs(average - lM) / range);
  offset = max(offset, sub * sub * 0.75);
  vec2 uv = vUv;
  if (horizontal) uv.y += offset * stepLength; else uv.x += offset * stepLength;
  outColor = vec4(textureLod(uColor, uv, 0.0).rgb, 1.0);
}`;

// ------------------------------------------------------------------------------------------------ debug views
/** G-buffer inspection. uDebug.x = mode: 1 albedo, 2 normals, 3 roughness, 4 occlusion, 7 velocity, 8 wetness. */
export const DEBUG_FS = HEAD + /* glsl */`
uniform sampler2D uGBuffer0;
uniform sampler2D uGBuffer1;
uniform sampler2D uGBuffer2;
uniform sampler2D uGBuffer3;
uniform sampler2D uAoTex;
uniform highp sampler2D uSceneDepth;
uniform vec4 uDebug;
in vec2 vUv;
layout(location = 0) out vec4 outColor;
vec3 octDecode(vec2 e) {
  vec3 n = vec3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
  float t = max(-n.y, 0.0);
  n.x += n.x >= 0.0 ? -t : t; n.z += n.z >= 0.0 ? -t : t;
  return normalize(n);
}
void main() {
  int mode = int(uDebug.x);
  vec4 g0 = textureLod(uGBuffer0, vUv, 0.0), g1 = textureLod(uGBuffer1, vUv, 0.0), g2 = textureLod(uGBuffer2, vUv, 0.0), g3 = textureLod(uGBuffer3, vUv, 0.0);
  vec3 c = vec3(0.0);
  if (textureLod(uSceneDepth, vUv, 0.0).r < 5.0e5) {
    if (mode == 1) c = g0.rgb;                                              // stored as sqrt(albedo): close to display encoding
    else if (mode == 2) c = octDecode(g1.xy) * 0.5 + 0.5;
    else if (mode == 3) c = vec3(g2.r, g2.b, g2.g);                         // roughness, coat, metal
    else if (mode == 4) c = vec3(g0.a * (uDebug.y > 0.5 ? textureLod(uAoTex, vUv, 0.0).r : 1.0));
    else if (mode == 7) c = vec3(0.5 + g1.zw * 40.0, 0.5);
    else if (mode == 8) c = g3.a > 3.5 ? vec3(0.0, 0.6, 1.0) : g3.a > 1.5 ? vec3(0.0, g3.a - 2.0, 0.0) : vec3(0.0, 0.25 * g3.a, g3.a);   // cyan = open water, green = translucency, blue = wet
  }
  outColor = vec4(c, 1.0);
}`;
