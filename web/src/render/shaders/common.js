// Lighting GLSL shared by the deferred lighting pass, the forward passes (glass, particles) and, through
// host.glsl.LIGHTING, by the ocean: the `Lighting` uniform block, cascaded sun/moon shadows, the BRDF and
// the loop over the ground-plane light grid. Every helper is prefixed `lit` so it cannot collide with
// surface family code, except the three entry points agreed with the sky module:
//   float sunShadow(vec3 rel)                                   visibility of the dominant light, 0..1
//   vec3  sunSpecular(vec3 N, vec3 V, vec3 f0, float rough)     unshadowed highlight radiance of the dominant light
//   vec3  localLights(vec3 rel, vec3 N, vec3 V, vec3 diffuse, vec3 f0, float rough)   radiance from lamps
// Needs the Frame block, PI, TAU and saturate (surfacePrelude). Compiles in vertex shaders too.
//
// Units (ARCHITECTURE 4.6): uSunColor is irradiance, so Lambert reflects albedo / PI of it. A local
// light's colour is on the scale where `albedo * colour * falloff` is the reflected radiance, i.e. its
// irradiance is PI * colour * falloff; that is what makes a road under a sodium lamp land at 0.3..1.

/** std140 layout of the Lighting block as float offsets, for the CPU side (index.js). */
export const LIGHTING_LAYOUT = Object.freeze({
  shadowMatrix: 0,      // 4 x mat4
  shadowTexel: 64,      // vec4
  shadowDepth: 68,      // vec4
  shadowInfo: 72,       // vec4
  shadowSoft: 76,       // vec4
  gridNear: 80,         // vec4
  gridFar: 84,          // vec4
  gridInfo: 88,         // vec4
  ambientBoost: 92,     // vec4
  occluderInfo: 96,     // vec4
  occluders: 100,       // 32 x vec4
  probe: 228,           // vec4
  probeInfo: 232,       // vec4
  probeFaces: 236,      // 6 x vec4
  roomKey: 260,         // 4 x vec4
  roomAir: 276,         // vec4
  probeRoom: 280,       // 2 x vec4
  floats: 288,
});

/** Occluder boxes the shader loops over (nearest first). */
export const MAX_OCCLUDERS = 16;
/** Light data texture: LIGHTS_PER_ROW lights per row, 4 texels each. */
export const LIGHTS_PER_ROW = 256;
/** Upper bound of the light grid's slots per cell (quality.js chooses how many are in use). */
export const MAX_SLOTS_PER_CELL = 32;

/** Radius in metres assumed for a light source whose record gives none (field 15 = 0). */
const DEFAULT_SOURCE_RADIUS = '0.12';
// Haze of a closed room: the air glows within this many metres of a tube or a bare lamp, and counts there
// for this many times what evenly scattering air seen from the side would send. Both are small on purpose:
// a view that runs along a tube gathers its glow over metres, and anything stronger shows there as a cloud
// (measured on the garage's turntable strip) long before it shows beside a tube seen from the side, whose
// halo is the bloom of the glass and the wash on the wall behind it.
const ROOM_GLOW_REACH = '0.35', ROOM_GLOW_ONWARD = '0.7';
/** Low beam: share of the peak intensity that strays above the cut-off, and the most one surface may receive (colour x falloff). */
const BEAM_STRAY = '0.012', BEAM_CEILING = '3.0';
/**
 * Low beam, foreground: a second, broad fan that lights the road from the bumper outward, kerb to kerb.
 * Its strength relative to the main fan, the tangent of its half width, and the sines of the angles under
 * the axis between which it fades in (0.08 is 7.5 m ahead of a lamp 0.6 m above the road, 0.3 is 2 m).
 * lightgrid.js bins a beam with BEAM_NEAR_MARGIN to cover it.
 */
export const BEAM_FILL = '0.5', BEAM_FILL_TAN = '1.0', BEAM_FILL_FROM = '0.08', BEAM_FILL_FULL = '0.3';
/**
 * Low beam, the lamp's own car: a lens sends nothing steeply off its axis (cosines between which the
 * beam fades out: 70 and 50 degrees), and the beam takes this many metres to open (it casts no shadow,
 * so without this it would paint a white patch on the bodywork around its own housing).
 */
const BEAM_LENS = ['0.34', '0.64'], BEAM_OPENS = ['0.3', '0.9'];
/** The most a leaf may receive from one lamp (colour x falloff). */
const LEAF_CEILING = '1.2';

/** Reflected radiance above this is clamped before it enters a reflection buffer (a mirrored headlamp lens, not a firefly). */
// The rain cover map (raincover.js): half the side of the mapped square around the camera, the edge of the map
// in texels, the grid its centre snaps to (metres), and the world heights of depth 0 and depth 1.
export const COVER_HALF = 32, COVER_SIZE = 256, COVER_SNAP = 8, COVER_TOP = 480, COVER_BOTTOM = -32;
// A point counts as covered only by something this far above it (metres): kerbs, steps and the slope of a road
// inside one texel of the map must not cover themselves.
const COVER_MARGIN = '0.6';
// Rain cover (raincover.js): 1 where the point at camera-relative position `rel` has open sky above it, 0
// under a roof, a deck or an awning, blended over one texel of the map; 1 outside the mapped square. Usable
// in vertex and fragment shaders of any module (it needs the Frame block and nothing else): the centre of
// the map is recomputed here from the camera position exactly as the renderer placed it.
export const RAIN_COVER = /* glsl */`
uniform highp sampler2D uRainCover;
float rainCover(vec3 rel) {
  const float HALF = ${COVER_HALF.toFixed(1)}, SIZE = ${COVER_SIZE.toFixed(1)}, SNAP = ${COVER_SNAP.toFixed(1)};
  vec2 centre = floor(uCamPos.xz / SNAP + 0.5) * SNAP;
  vec2 t = ((rel.xz + (uCamPos.xz - centre)) / (2.0 * HALF) + 0.5) * SIZE - 0.5;
  ivec2 i = ivec2(floor(t)); vec2 f = t - floor(t);
  if (i.x < 0 || i.y < 0 || i.x >= int(SIZE) - 1 || i.y >= int(SIZE) - 1) return 1.0;
  // Depth at which the point itself would be stored, less the margin that keeps a surface from covering itself.
  float own = (${COVER_TOP.toFixed(1)} - (rel.y + uCamPos.y) - ${COVER_MARGIN}) / ${(COVER_TOP - COVER_BOTTOM).toFixed(1)};
  vec4 open = step(own, vec4(texelFetch(uRainCover, i, 0).r, texelFetch(uRainCover, i + ivec2(1, 0), 0).r,
                             texelFetch(uRainCover, i + ivec2(0, 1), 0).r, texelFetch(uRainCover, i + ivec2(1, 1), 0).r));
  return mix(mix(open.x, open.y, f.x), mix(open.z, open.w, f.x), f.y);
}
`;

export const MAX_REFLECTED = '48.0';
// Exponent of the view-angle rise of a lacquer's mirror reflection (5 would be a bare interface).
const LACQUER_FALLOFF = '3.0';
// Ceilings of a lamp's mirror image in lacquer: per unit of the lamp's strength, and in scene radiance.
const GLINT_CAP = '1.0', GLINT_RADIANCE = '400.0';
// The scene probe's estimate of where a reflected ray ends (sceneAim). The distance to the surroundings is
// read from this level of the probe: blurred, so that a pole in front of a far wall bends the reflection
// around it instead of tearing it. Nothing is taken to be nearer than 1 / PROBE_NEAREST_INV metres, and
// surfaces further from the capture point than PROBE_PARALLAX[0] metres trust the estimate less and less,
// until at PROBE_PARALLAX[1] they read the probe by direction alone.
const PROBE_DISTANCE_LEVEL = '2.0', PROBE_NEAREST_INV = '2.0', PROBE_PARALLAX = ['6.0', '16.0'];
/** Metres beyond the edge of a room's light box at which the roof beside its housing is read (see roomAim). */
const ROOM_KEY_SURROUND = '0.35';
/**
 * Roughness over which a lobe stops finding the light box's edge exactly (see sceneAimFor): up to the first
 * it is aimed as a mirror is, from the second as if the room were its bare box.
 */
const ROOM_KEY_EXACT = ['0.12', '0.3'];

export const LIGHTING = /* glsl */`
layout(std140) uniform Lighting {
  mat4 uShadowMatrix[4];   // camera-relative world -> shadow map space (xy = uv, z = depth, all 0..1), one per cascade
  vec4 uShadowTexel;       // world size of one shadow texel per cascade, 0 = cascade unusable
  vec4 uShadowDepth;       // 1 / depth range in metres per cascade
  vec4 uShadowInfo;        // x = cascade count, y = distance where shadows start to fade out, z = where they end, w = PCF taps
  vec4 uShadowSoft;        // x = penumbra width in metres, y = 1 / map size, z = noise phase (advances per frame under TAA), w unused
  vec4 uGridNear;          // xy = camera-relative (x, z) of the corner of cell (0,0), z = 1 / cell size, w = cells per side
  vec4 uGridFar;           // same for the coarse level; w = 0 when there is none
  vec4 uGridInfo;          // x = slots per cell, y = first row of the coarse level in uLightCells, z = gain on the light of all lamps together (Environment.lampGain)
  vec4 uAmbientBoost;      // rgb = extra ambient radiance (a lightning flash, the bounced light of a closed room), w = share of it that falls by the upward tilt of a surface (the flash comes from overhead)
  vec4 uOccluderInfo;      // x = number of occluder boxes
  vec4 uOccluders[32];     // per box: [camera-relative centre xyz, cos yaw], [half width, half height, half length, sin yaw]
  vec4 uProbe;             // xyz = camera-relative point the scene reflection probe was captured from, w = 1 when it holds an image
  vec4 uProbeInfo;         // x = camera-relative height of the ground plane its downward rays are corrected against, y = its last mip level
  vec4 uProbeFaces[6];     // xyz = where the probe stood when it drew that face (+X, -X, +Y, -Y, +Z, -Z), relative to where it stands now
  vec4 uRoomKey[4];        // the light box of a closed room, which takes the sun's place there: [0] xyz = camera-relative centre, w = 1 on a frame inside a room that has one; [1] xyz = half edge u, w = +1 or -1 so that w * cross(u, v) is the face that emits; [2] xyz = half edge v; [3] rgb = radiance of the face
  vec4 uRoomAir;           // x = haze in a closed room: share of the light crossing one metre of its air that is scattered, 0 outdoors
  vec4 uProbeRoom[2];      // the box a room's reflection probe is read against: [0] xyz = its lowest corner relative to the camera, w = 1 while the probe stands in a room; [1] xyz = its highest corner
};
uniform highp sampler2DArrayShadow uShadowMap;
uniform highp sampler2D uLightData;
uniform highp usampler2D uLightCells;

// Interleaved gradient noise: well distributed over a 3x3 neighbourhood, which is what the TAA
// neighbourhood clamp and the PCF kernel both want.
#ifdef VICE_FRAGMENT
float litDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy + uShadowSoft.z * 5.588238, vec2(0.06711056, 0.00583715)))); }
#else
float litDither() { return 0.5; }
#endif

// ---------------------------------------------------------------------------------------------- shadows
float litShadowKernel(int cascade, vec3 sc, float radiusTexels, float dither) {
  int taps = int(uShadowInfo.w);
  float sum = 0.0, angle = dither * TAU, scale = radiusTexels * uShadowSoft.y / sqrt(float(taps));
  for (int i = 0; i < 16; i++) {
    if (i >= taps) break;
    // Golden-angle spiral: even coverage of the disc for any tap count; hardware PCF filters each tap bilinearly.
    float a = angle + float(i) * 2.39996323;
    vec2 o = vec2(cos(a), sin(a)) * (sqrt(float(i) + 0.5) * scale);
    sum += texture(uShadowMap, vec4(sc.xy + o, float(cascade), sc.z));
  }
  return sum / float(taps);
}

// Inside a room the shadow map is not a view from the light. The key there is a light box metres wide and
// hanging close: a point is lit by a whole patch of ceiling and shaded by degrees, which no kernel of
// fixed size over a depth map reproduces. So the one map of a room is a height map of everything under the
// box (lightstate.js draws it looking straight up from the floor and keeps the highest surface), and
// visibility is found by walking from the receiver towards points spread over the box: a sample of that
// path that lies below the height map is inside something. What stands under the box is treated as solid
// down to the floor, which is true of a car and of everything else that stands on one.
// 1 where the camera-relative point p is above everything mapped at its place, 0 inside or under it.
float litRoomOpen(vec3 p) {
  vec3 sc = (uShadowMatrix[0] * vec4(p, 1.0)).xyz;
  if (sc.x <= 0.0 || sc.y <= 0.0 || sc.x >= 1.0 || sc.y >= 1.0) return 1.0;
  // The map compares "at or nearer than what is stored"; heights grow with depth here, so that is "below".
  return 1.0 - texture(uShadowMap, vec4(sc.xy, 0.0, sc.z + 0.012 * uShadowDepth.x));
}
// The share of the light box that the point at rel sees, weighted by what each part of the box would give
// a surface with normal N there (vec3(0): a point in the air).
float litRoomShadow(vec3 rel, vec3 N) {
  if (uShadowInfo.x < 0.5) return 1.0;
  vec3 centre = uRoomKey[0].xyz - rel;
  vec3 face = normalize(cross(uRoomKey[1].xyz, uRoomKey[2].xyz)) * uRoomKey[1].w;
  if (centre.y < 0.08) return 1.0;                       // level with the box or above it: nothing it lights can be in the way
  int rays = int(uShadowInfo.w);
  float dither = litDither(), given = 0.0, arrived = 0.0;
  vec3 from = rel + N * 0.02;
  // Nothing mapped is taller than this over the receiver, so the walk ends there.
  float rise = min(centre.y - 0.04, 2.4);
  for (int i = 0; i < 16; i++) {
    if (i >= rays) break;
    // A lattice over the box, shifted per pixel and per frame: temporal AA turns the grain into the penumbra.
    vec2 at = fract(vec2(float(i) * 0.7548777 + dither, float(i) * 0.5698403 + dither * 47.0)) * 2.0 - 1.0;
    vec3 to = centre + uRoomKey[1].xyz * at.x + uRoomKey[2].xyz * at.y;
    float d2 = dot(to, to);
    vec3 dir = to * inversesqrt(d2);
    float weight = max(-dot(face, dir), 0.0) / d2 * (dot(N, N) > 0.25 ? max(dot(N, dir), 0.0) : 1.0);
    if (weight <= 0.0) continue;
    // Three samples on the way up, close together near the receiver where what shades it begins.
    float open = 1.0, phase = fract(dither * 13.0 + float(i) * 0.618034);
    for (int k = 0; k < 3; k++) {
      float share = (float(k) + phase) / 3.0;
      open = min(open, litRoomOpen(from + to * ((0.03 + rise * share * share) / to.y)));
    }
    given += weight; arrived += weight * open;
  }
  return given > 0.0 ? arrived / given : 1.0;
}

// One cascade's entry of a vec4. Never index a vector with a variable: ANGLE's Direct3D 11 backend emulates that with
// a generated helper, and Chrome on Windows fails to compile a shader that needs two of them (the context is lost).
float litPick(vec4 v, int i) { return i == 0 ? v.x : i == 1 ? v.y : i == 2 ? v.z : v.w; }

// Visibility of the dominant light at camera-relative position rel on a surface with normal N
// (pass vec3(0) when there is no meaningful normal: particles, volumes).
float litSunShadow(vec3 rel, vec3 N) {
  if (uRoomKey[0].w > 0.5) return litRoomShadow(rel, N);
  int count = int(uShadowInfo.x);
  float dist = length(rel);
  if (count == 0 || dist >= uShadowInfo.z) return 1.0;
  float dither = litDither();
  float slope = 1.0 - saturate(dot(N, uSunDir.xyz));
  for (int c = 0; c < 4; c++) {
    if (c >= count) break;
    float texel = litPick(uShadowTexel, c);
    if (texel <= 0.0) continue;
    float radius = clamp(uShadowSoft.x / texel, 1.0, 3.5);
    // Normal offset: move the lookup off the surface by about the kernel footprint, more at grazing sun
    // angles. This is what keeps curved car bodies free of acne without a depth bias large enough to
    // detach contact shadows.
    vec3 p = rel + N * (texel * (0.5 + radius) * (0.2 + 0.8 * slope));
    vec3 sc = (uShadowMatrix[c] * vec4(p, 1.0)).xyz;
    vec2 border = min(sc.xy, 1.0 - sc.xy) - (radius + 1.5) * uShadowSoft.y;
    float inside = min(border.x, border.y);
    if (inside <= 0.0 || sc.z >= 1.0) continue;
    // Hand over to the next cascade through a dithered band instead of a visible line.
    if (c < count - 1 && inside < 0.07 * dither) continue;
    sc.z -= 0.6 * texel * litPick(uShadowDepth, c);
    float lit = litShadowKernel(c, sc, radius, dither);
    return mix(lit, 1.0, smoothstep(uShadowInfo.y, uShadowInfo.z, dist));
  }
  return 1.0;
}
float sunShadow(vec3 rel) { return litSunShadow(rel, vec3(0.0)); }
// One bilinear tap, for marching through the air (light shafts) where a soft kernel would be wasted.
float litSunShadowCheap(vec3 rel) {
  int count = int(uShadowInfo.x);
  // In a room: is the point under open ceiling, or under (inside) something that stands below the light box?
  if (uRoomKey[0].w > 0.5) return count > 0 ? litRoomOpen(rel + vec3(0.0, 0.03, 0.0)) : 1.0;
  for (int c = 0; c < 4; c++) {
    if (c >= count) break;
    if (litPick(uShadowTexel, c) <= 0.0) continue;
    vec3 sc = (uShadowMatrix[c] * vec4(rel, 1.0)).xyz;
    vec2 border = min(sc.xy, 1.0 - sc.xy);
    if (min(border.x, border.y) <= 0.01 || sc.z >= 1.0) continue;
    return texture(uShadowMap, vec4(sc.xy, float(c), sc.z));
  }
  return 1.0;
}

// ---------------------------------------------------------------------------------------------- BRDF
float litPow5(float x) { float x2 = x * x; return x2 * x2 * x; }
vec3 litFresnel(vec3 f0, float VoH) { return f0 + (1.0 - f0) * litPow5(1.0 - VoH); }
float litFresnel1(float f0, float VoH) { return f0 + (1.0 - f0) * litPow5(1.0 - VoH); }
// Share of its surroundings that a clear layer mirrors at this view angle. lacquer 0 is a single
// interface (a water film): the classic fifth-power rise that only shows near grazing. lacquer 1 is
// the baked lacquer of car paint and enamel, which photographs as a mirror over a much wider range of
// angles (light bounces between the coat and the pigment below it, and the coat is never one flat
// interface), so its rise starts earlier.
float litCoatMirror(float f0, float NoV, float lacquer) {
  return f0 + (1.0 - f0) * pow(1.0 - saturate(NoV), mix(5.0, ${LACQUER_FALLOFF}, lacquer));
}
// GGX distribution times Smith visibility times N.L, without Fresnel. alpha = roughness squared.
float litLobe(float NoL, float NoV, float NoH, float alpha) {
  float a2 = alpha * alpha;
  float d = (NoH * a2 - NoH) * NoH + 1.0;
  float D = a2 / (PI * d * d + 1e-7);
  float vis = 0.5 / max(mix(2.0 * NoL * NoV, NoL + NoV, alpha), 1e-4);
  return D * vis * NoL;
}
float litAlpha(float rough) { float r = max(rough, 0.045); return r * r; }

// Split-sum environment BRDF, analytic fit (Karis, "Physically based shading on mobile").
vec3 litEnvBrdf(vec3 f0, float rough, float NoV) {
  vec4 r = rough * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  vec2 ab = vec2(-1.04, 1.04) * a004 + r.zw;
  return f0 * ab.x + saturate(50.0 * f0.g) * ab.y;
}
// How much of the environment a glossy lobe still sees given diffuse occlusion (Lagarde).
float litSpecularOcclusion(float NoV, float ao, float rough) {
  return saturate(pow(NoV + ao, exp2(-16.0 * rough - 1.0)) - 1.0 + ao);
}

// A surface as the light loops see it.
struct LitSurface {
  vec3 N; vec3 V;
  vec3 diffuse;      // diffuse albedo (already without the metallic part)
  vec3 f0; float alpha;
  float coat; float coatAlpha; float coatF0;
  float lacquer;     // share of the coat that is hard lacquer or glass rather than a water film
  float sss;         // leaf translucency
};

// Reflectance at normal incidence of the base layer. Under a clear coat or a water film there is no step
// in refractive index left for a dielectric base to reflect at: its own 4 % goes and the film's takes over.
vec3 litBaseF0(vec3 albedo, float metal, float coat) { return mix(vec3(0.04 * (1.0 - coat)), albedo, metal); }

// Highlight of the dominant light. Its disc is far brighter than anything else in the scene, so the lobe
// is capped at a multiple of the irradiance. Rough surfaces get a low cap, because their glints are the
// single-pixel fireflies that temporal AA would smear; polished ones (lacquer, chrome, glass, still
// water) a high one, because there the glint is a real, small, very bright image of the sun.
vec3 litSunLobe(vec3 N, vec3 V, vec3 f0, float alpha, float NoL) {
  vec3 H = normalize(V + uSunDir.xyz);
  float NoV = abs(dot(N, V)) + 1e-4;
  float cap = mix(64.0, 4.0, smoothstep(0.1, 0.35, sqrt(alpha)));
  return litFresnel(f0, saturate(dot(V, H))) * min(litLobe(NoL, NoV, saturate(dot(N, H)), max(alpha, 0.006)), cap);
}
vec3 sunSpecular(vec3 N, vec3 V, vec3 f0, float rough) {
  float NoL = saturate(dot(N, uSunDir.xyz));
  return uSunColor.rgb * litSunLobe(N, V, f0, litAlpha(rough), NoL);
}

// Dominant light on a full surface; shadow is the caller's (it also carries cloud shadow).
vec3 litSun(LitSurface s, float shadow) {
  float d = dot(s.N, uSunDir.xyz), NoL = saturate(d);
  vec3 E = uSunColor.rgb * shadow;
  // Leaves: light wraps around the terminator and shines through from behind, tinted by the leaf.
  float wrap = saturate((d + 0.4 * s.sss) / (1.0 + 0.4 * s.sss));
  vec3 through = s.diffuse * s.diffuse * (s.sss * 0.55 * saturate(-d) + s.sss * 0.25 * litPow5(saturate(dot(-s.V, uSunDir.xyz))));
  vec3 result = s.diffuse * (1.0 / PI) * mix(NoL, wrap, step(0.001, s.sss)) + through * (1.0 / PI);
  if (NoL > 0.0) {
    vec3 spec = litSunLobe(s.N, s.V, s.f0, s.alpha, NoL);
    if (s.coat > 0.003) {
      vec3 H = normalize(s.V + uSunDir.xyz);
      float Fc = litFresnel1(s.coatF0, saturate(dot(s.V, H))) * s.coat;
      result *= 1.0 - Fc;
      spec = spec * (1.0 - Fc) + litSunLobe(s.N, s.V, vec3(s.coatF0), s.coatAlpha, NoL) * s.coat;
    }
    result += spec;
  }
  return result * E;
}

// Share of everything a surface with normal N at rel could receive that the light box of a room fills (1 = a
// luminous ceiling from horizon to horizon). Lambert's sum over the edges of the rectangle gives the
// direction and size of the light arriving; where the surface's own horizon cuts the box, the box is
// treated as a disc of the same size, of which the part above the horizon counts.
vec3 litBoxEdge(vec3 a, vec3 b) {
  float x = clamp(dot(a, b), -0.9999, 0.9999);
  return cross(a, b) * (acos(x) * inversesqrt(1.0 - x * x));
}
float litBoxShare(vec3 rel, vec3 N) {
  vec3 c = uRoomKey[0].xyz - rel, u = uRoomKey[1].xyz, v = uRoomKey[2].xyz;
  if (dot(cross(u, v), c) * uRoomKey[1].w >= 0.0) return 0.0;        // behind the face that emits
  vec3 p0 = normalize(c - u - v), p1 = normalize(c + u - v), p2 = normalize(c + u + v), p3 = normalize(c - u + v);
  vec3 flow = (litBoxEdge(p0, p1) + litBoxEdge(p1, p2) + litBoxEdge(p2, p3) + litBoxEdge(p3, p0)) * (0.5 / PI);
  float size = length(flow);
  if (size < 1e-6) return 0.0;
  // The sum points to one side of the rectangle or the other by the order of its corners: towards it is meant.
  float facing = dot(N, flow) / size * sign(dot(flow, c));
  // A disc that fills the share "size" head-on has an angular radius whose sine is sqrt(size). Standing clear
  // of the horizon it gives size x cosine; sinking through it, the smooth curve that meets that line where
  // the disc touches the horizon and reaches nothing when it has set.
  float rim = sqrt(size);
  return size * (facing >= rim ? facing : (rim + max(facing, -rim)) * (rim + max(facing, -rim)) / (4.0 * rim));
}

// The key light on a full surface: the sun or moon outdoors, the light box in a room. In a room only the
// matte part is computed here; the box's mirror image comes from the room's reflection probe, where it is
// drawn as the lit panel it is, so a second, analytic highlight would lie over it.
vec3 litKey(vec3 rel, LitSurface s, float shadow) {
  if (uRoomKey[0].w < 0.5) return litSun(s, shadow);
  float mirrored = litFresnel1(s.coatF0, abs(dot(s.N, s.V))) * s.coat;
  return s.diffuse * uRoomKey[3].rgb * (litBoxShare(rel, s.N) * shadow * (1.0 - mirrored));
}

// ---------------------------------------------------------------------------------------------- local lights
// Returns (first column, row) of the pixel's cell in uLightCells, or x = -1 outside the grid.
ivec2 litCell(vec2 xz) {
  vec2 g = (xz - uGridNear.xy) * uGridNear.z;
  if (g.x >= 0.0 && g.y >= 0.0 && g.x < uGridNear.w && g.y < uGridNear.w) return ivec2(int(g.x) * int(uGridInfo.x), int(g.y));
  g = (xz - uGridFar.xy) * uGridFar.z;
  if (g.x >= 0.0 && g.y >= 0.0 && g.x < uGridFar.w && g.y < uGridFar.w) return ivec2(int(g.x) * int(uGridInfo.x), int(g.y) + int(uGridInfo.y));
  return ivec2(-1);
}

// Low beam of a headlamp: share of the peak intensity sent in direction dir (lamp to surface).
// axis is the lamp's level aim. Below it the beam is shaped so that a road is lit almost evenly from the
// hot spot inwards: a road point seen at an angle v under the axis lies at height / sin(v), so its
// illumination would rise with the cube of that sine; the throw term takes most of that back. Above the
// axis a soft cut-off leaves only the stray light that lets signs and walls ahead show. Sideways, a wide
// fan carries a narrower hot spot down the lane, and close to the car a broader, weaker one fills the
// foreground (BEAM_FILL).
float litLowBeam(vec3 dir, vec3 axis, float tanSpread, float tanDip) {
  float ahead = dot(dir, axis);
  if (ahead <= 0.0) return 0.0;
  vec3 side = normalize(cross(axis, vec3(0.0, 1.0, 0.0)) + vec3(1e-5, 0.0, 0.0));
  float sinBelow = -dot(dir, cross(side, axis));
  float sinDip = tanDip * inversesqrt(1.0 + tanDip * tanDip);
  float cut = mix(${BEAM_STRAY}, 1.0, smoothstep(-0.0105, 0.0157, sinBelow));      // from 0.6 degrees above to 0.9 below
  float nearThrow = pow(sinDip / max(sinBelow, sinDip), 2.6);
  float across = dot(dir, side) / ahead;
  float wide = across / (0.6 * tanSpread), hot = across / 0.105, fill = across / ${BEAM_FILL_TAN};
  float fan = exp(-wide * wide) + 0.6 * exp(-hot * hot) + ${BEAM_FILL} * smoothstep(${BEAM_FILL_FROM}, ${BEAM_FILL_FULL}, sinBelow) * exp(-fill * fill);
  return cut * nearThrow * fan * smoothstep(${BEAM_LENS[0]}, ${BEAM_LENS[1]}, ahead) * 0.625;
}

// What a glowing tube gives a surface per unit of its strength per metre: cosine over distance squared,
// summed along the tube in closed form, so a wall is washed evenly along a tube mounted on it and the wash
// ends where the tube does. toMid: from the surface to the tube's midpoint; axis: unit; glass: radius of
// the tube, which keeps the sum finite on the wall it is fixed to. N = vec3(0): a point in the air, no cosine.
float litTube(vec3 toMid, vec3 axis, float halfLength, float glass, vec3 N) {
  float along = dot(toMid, axis);
  vec3 across = toMid - axis * along;                     // to the nearest point of the tube's line
  float h2 = dot(across, across) + glass * glass;
  float x0 = along - halfLength, x1 = along + halfLength;
  if (dot(N, N) < 0.25) { float h = sqrt(h2); return (atan(x1 / h) - atan(x0 / h)) / h; }
  // With x measured along the tube from that nearest point, the cosine times the distance is a + b x.
  float a = dot(N, across), b = dot(N, axis);
  // Only the stretch of tube above the surface's own horizon lights it.
  if (abs(b) > 1e-4) { if (b > 0.0) x0 = max(x0, -a / b); else x1 = min(x1, -a / b); }
  else if (a <= 0.0) return 0.0;
  if (x1 <= x0) return 0.0;
  float r0 = inversesqrt(x0 * x0 + h2), r1 = inversesqrt(x1 * x1 + h2);
  return a * (x1 * r1 - x0 * r0) / h2 - b * (r1 - r0);
}

// One light of the pixel's cell: rgb = colour, a = falloff (distance window and cone or beam; 0 = out of reach).
// L receives the unit direction to the light, dist the distance; shape = (radius of the source in metres,
// ceiling on what one surface may receive from this light in units of colour x falloff, 0 = none).
// A tube (a neon tube of a room) is marked by a negative shape.x, the radius of its glass: L and dist then
// point at its midpoint, line holds its unit axis and half length, and a is the distance window alone;
// the caller sums along it (litTube).
vec4 litFetch(uint index, vec3 rel, out vec3 L, out float dist, out vec2 shape, out vec4 line) {
  ivec2 at = ivec2(int(index & 255u) * 4, int(index >> 8u));
  vec4 posRadius = texelFetch(uLightData, at, 0);
  L = posRadius.xyz - rel;
  float d2 = dot(L, L), r2 = posRadius.w * posRadius.w;
  dist = sqrt(d2);
  L /= max(dist, 1e-4);
  shape = vec2(${DEFAULT_SOURCE_RADIUS}, 0.0);
  line = vec4(0.0);
  if (d2 >= r2) return vec4(0.0);
  vec4 colourType = texelFetch(uLightData, at + ivec2(1, 0), 0);
  if (colourType.w > 2.5) {
    line = texelFetch(uLightData, at + ivec2(2, 0), 0);
    vec4 tube = texelFetch(uLightData, at + ivec2(3, 0), 0);          // x = reach from the tube, z = radius of the glass
    shape.x = -max(tube.z, 0.004);
    // The window closes with the distance from the nearest point of the tube, not from its middle.
    vec3 nearest = L * dist + line.xyz * clamp(-dot(L * dist, line.xyz), -line.w, line.w);
    float n2 = dot(nearest, nearest) / (tube.x * tube.x), open = saturate(1.0 - n2 * n2);
    return vec4(colourType.rgb, open * open);
  }
  // Inverse square, softened inside a metre of the source, and brought to zero at the radius.
  float x2 = d2 / r2, window = saturate(1.0 - x2 * x2);
  float falloff = window * window / (d2 + 1.0);
  if (colourType.w > 0.5) {
    vec4 axis = texelFetch(uLightData, at + ivec2(2, 0), 0), cone = texelFetch(uLightData, at + ivec2(3, 0), 0);
    if (cone.z > 0.0) shape.x = cone.z;
    if (colourType.w > 1.5) {
      falloff *= litLowBeam(-L, axis.xyz, cone.x, cone.y) * smoothstep(${BEAM_OPENS[0]}, ${BEAM_OPENS[1]}, dist);
      // An upright surface inside the beam at ten metres would physically receive hundreds of times what
      // the road does and burn out; a camera exposing for the road would too, but a game must stay readable.
      shape.y = ${BEAM_CEILING};
    } else {
      // Linear in the cosine between inner and outer angle, then smoothed: no visible ring at either edge.
      float t = saturate(dot(-L, axis.xyz) * cone.x + cone.y);
      falloff *= t * t * (3.0 - 2.0 * t);
    }
  } else {
    float size = texelFetch(uLightData, at + ivec2(3, 0), 0).z;
    if (size > 0.0) shape.x = size;
  }
  return vec4(colourType.rgb, falloff);
}

// Mirrored radiance of a lamp per unit of its colour. The fixture is a small sphere, not a point: the lobe
// is widened by its angular size and renormalised (Karis), then capped at roughly the radiance of the
// lens that emits this light, so polished paint shows a lamp as a small bright disc and a wet road shows
// a streak under it, never a clipped spark.
float litLampLobe(float NoL, float NoV, float NoH, float alpha, float dist, float falloff, float size) {
  float wide = saturate(alpha + saturate(size / max(dist, size))), norm = alpha / wide;
  return min(PI * falloff * litLobe(NoL, NoV, NoH, wide) * norm * norm, 0.125);
}
// The same lamp in lacquer or glass. A photograph of a car at night shows every lamp around it as a
// small burnt-out disc on roof, deck and shoulder, far brighter than the paint the lamp lights: the
// lens is thousands of times brighter than anything it illuminates, and four percent of that is still
// beyond white. Here the lobe keeps all of the lamp's energy (it is only as wide as the lens looks
// from the surface) and is capped high: at the lamp's own strength, and at a fixed radiance so that a
// headlamp, whose strength is in the tens of thousands, glints instead of flaring. peak is the largest
// channel of the lamp's colour times intensity.
float litLampGlint(float NoL, float NoV, float NoH, float alpha, float dist, float falloff, float size, float peak) {
  float wide = saturate(alpha + saturate(size / max(dist, size)));
  return min(PI * falloff * litLobe(NoL, NoV, NoH, wide), min(${GLINT_CAP}, ${GLINT_RADIANCE} / max(peak, 1e-3)));
}

vec3 litLocal(vec3 rel, LitSurface s) {
  ivec2 cell = litCell(rel.xz);
  if (cell.x < 0) return vec3(0.0);
  int slots = int(uGridInfo.x);
  float NoV = abs(dot(s.N, s.V)) + 1e-4;
  bool leaf = s.sss > 0.001;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_SLOTS_PER_CELL}; i++) {
    if (i >= slots) break;
    uint index = texelFetch(uLightCells, ivec2(cell.x + i, cell.y), 0).r;
    if (index == 0xffffu) break;
    vec3 L; float dist; vec2 shape; vec4 line;
    vec4 light = litFetch(index, rel, L, dist, shape, line);
    if (light.a <= 0.0) continue;
    if (shape.x < 0.0) {
      // A tube lights the matte part only. It is there as glowing glass in the room's reflection probe, in
      // the floor mirror and on screen, and those carry its image into every polished surface.
      float mirrored = litFresnel1(s.coatF0, NoV) * s.coat;
      sum += light.rgb * s.diffuse * (litTube(L * dist, line.xyz, line.w, -shape.x, s.N) * light.a * (1.0 - mirrored));
      continue;
    }
    float d = dot(s.N, L), NoL = saturate(d);
    // Leaves: the light wraps a little and a small share comes through from behind. Lamps cast no
    // shadows, so every leaf of a crown would otherwise be lit as if it hung alone next to the lamp;
    // the ceiling keeps a palm beside a street light a lit palm and not a lantern.
    float received = leaf ? saturate((d + 0.25 * s.sss) / (1.0 + 0.25 * s.sss)) + s.sss * 0.12 * saturate(-d) : NoL;
    float ceiling = leaf ? ${LEAF_CEILING} : shape.y;
    if (ceiling > 0.0) light.a /= 1.0 + max(light.r, max(light.g, light.b)) * light.a * received / ceiling;
    vec3 response = s.diffuse * (received * light.a);
    if (NoL > 0.0) {
      vec3 H = normalize(s.V + L);
      float NoH = saturate(dot(s.N, H)), VoH = saturate(dot(s.V, H));
      vec3 spec = litFresnel(s.f0, VoH) * litLampLobe(NoL, NoV, NoH, s.alpha, dist, light.a, shape.x);
      if (s.coat > 0.003) {
        float Fc = litFresnel1(s.coatF0, VoH) * s.coat;
        response *= 1.0 - Fc;
        float mirrored = litLampLobe(NoL, NoV, NoH, s.coatAlpha, dist, light.a, shape.x);
        if (s.lacquer > 0.003) mirrored = mix(mirrored, litLampGlint(NoL, NoV, NoH, s.coatAlpha, dist, light.a, shape.x, max(light.r, max(light.g, light.b))), s.lacquer);
        spec = spec * (1.0 - Fc) + Fc * mirrored;
      }
      response += spec;
    }
    sum += light.rgb * response;
  }
  // The lamps are tuned against the night. While the sky still lights the street their sum is turned down, after
  // every per-light ceiling, so that pools, beams and their highlights keep their proportions to one another.
  return sum * uGridInfo.z;
}

// Lamp light arriving at a point in the air, for particles: no surface, so no cosine and no highlight.
vec3 litLocalVolume(vec3 rel) {
  ivec2 cell = litCell(rel.xz);
  if (cell.x < 0) return vec3(0.0);
  int slots = int(uGridInfo.x);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${MAX_SLOTS_PER_CELL}; i++) {
    if (i >= slots) break;
    uint index = texelFetch(uLightCells, ivec2(cell.x + i, cell.y), 0).r;
    if (index == 0xffffu) break;
    vec3 L; float dist; vec2 shape; vec4 line;
    vec4 light = litFetch(index, rel, L, dist, shape, line);
    if (shape.x < 0.0) { sum += light.rgb * (litTube(L * dist, line.xyz, line.w, -shape.x, vec3(0.0)) * light.a); continue; }
    if (shape.y > 0.0) light.a /= 1.0 + max(light.r, max(light.g, light.b)) * light.a / shape.y;
    sum += light.rgb * light.a;
  }
  return sum * uGridInfo.z;
}

// The haze of a closed room along the view ray to the surface at rel: rgb = light the air scatters towards
// the eye, a = share of the surface's own light that still arrives. This is no fog: the air shows only
// close to what shines. Each tube and each bare lamp of the pixel's light cell gets a glow of the air
// within ${ROOM_GLOW_REACH} m of it, in closed form (the light of a long tube falls off with the distance from
// it, and along a ray passing it that sums to a logarithm; a point's inverse square sums to an arc tangent;
// each less what it would be at the edge of the glow, so that it ends there without a step). The wide
// light box lights the air of the whole room faintly and evenly, which would only grey the blacks: it
// is left out.
vec4 litRoomAir(vec3 rel) {
  float far = length(rel);
  vec3 dir = rel / max(far, 1e-4), glow = vec3(0.0);
  ivec2 cell = litCell(rel.xz);
  int slots = cell.x < 0 ? 0 : int(uGridInfo.x);
  for (int i = 0; i < ${MAX_SLOTS_PER_CELL}; i++) {
    if (i >= slots) break;
    uint index = texelFetch(uLightCells, ivec2(cell.x + i, cell.y), 0).r;
    if (index == 0xffffu) break;
    ivec2 at = ivec2(int(index & 255u) * 4, int(index >> 8u));
    vec4 posRadius = texelFetch(uLightData, at, 0), colourType = texelFetch(uLightData, at + ivec2(1, 0), 0);
    vec3 mid = posRadius.xyz;
    if (colourType.w > 2.5) {
      vec4 line = texelFetch(uLightData, at + ivec2(2, 0), 0), glass = texelFetch(uLightData, at + ivec2(3, 0), 0);   // glass: x = reach, z = radius
      // A record that stands for a whole band of tubes (a wide radius) has no glow of its own: each of
      // its tubes would have one, where the record has only its middle line.
      float single = 1.0 - smoothstep(0.03, 0.12, glass.z), edge = min(glass.x, ${ROOM_GLOW_REACH});
      float lean = dot(dir, line.xyz), sine = sqrt(max(1.0 - lean * lean, 1e-4)), axial = dot(line.xyz, mid);
      float gap = dot(mid, cross(dir, line.xyz)) / sine, h = sqrt(gap * gap + 4e-4);
      if (single <= 0.0 || h >= edge) continue;
      // u: along the ray from where it passes closest to the tube, measured square to the tube.
      float nearest = (dot(dir, mid) - lean * axial) / sine, side = sqrt(edge * edge - h * h);
      float u0 = max(-nearest, -side), u1 = min(far * sine - nearest, side);
      // Only the stretch of the ray that lies beside the tube, rounded off past its ends.
      float span = line.w + 0.5 * h;
      if (abs(lean) > 1e-3) {
        float a = ((axial - span) / lean) * sine - nearest, b = ((axial + span) / lean) * sine - nearest;
        u0 = max(u0, min(a, b)); u1 = min(u1, max(a, b));
      } else if (abs(axial) > span) continue;
      if (u1 > u0) glow += colourType.rgb * (single * PI / sine * (asinh(u1 / h) - asinh(u0 / h) - (u1 - u0) / edge));
    } else if (colourType.w < 0.5) {
      float edge = min(posRadius.w, ${ROOM_GLOW_REACH}), nearest = dot(dir, mid);
      float h2 = max(dot(mid, mid) - nearest * nearest, 0.0) + 0.01, h = sqrt(h2);
      if (h >= edge) continue;
      float side = sqrt(edge * edge - h2), u0 = max(-nearest, -side), u1 = min(far - nearest, side);
      if (u1 > u0) glow += colourType.rgb * ((atan(u1 / h) - atan(u0 / h)) / h - (u1 - u0) / (edge * edge));
    }
  }
  // Haze throws most of its light onward, so the air round a source the eye looks towards counts for
  // several times the even share of a quarter that the lit air seen from the side sends.
  glow *= uGridInfo.z * ${ROOM_GLOW_ONWARD};
  return vec4(glow * uRoomAir.x, exp(-uRoomAir.x * far));
}

vec3 localLights(vec3 rel, vec3 N, vec3 V, vec3 diffuse, vec3 f0, float rough) {
  LitSurface s;
  s.N = N; s.V = V; s.diffuse = diffuse; s.f0 = f0; s.alpha = litAlpha(rough);
  s.coat = 0.0; s.coatAlpha = 0.01; s.coatF0 = 0.04; s.lacquer = 0.0; s.sss = 0.0;
  return litLocal(rel, s);
}

// ---------------------------------------------------------------------------------------------- contact occlusion
// Vehicles as boxes: how much sky and lamp light still reaches a point on the ground beside or under them.
// Analytic, so it is stable, free of screen-space artefacts and present at any distance.
float litContact(vec3 rel) {
  int count = int(uOccluderInfo.x);
  float open = 1.0;
  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    vec4 c = uOccluders[2 * i], h = uOccluders[2 * i + 1];
    vec3 d = rel - c.xyz;
    vec2 q = abs(vec2(d.x * c.w - d.z * h.w, d.x * h.w + d.z * c.w)) - h.xz;
    float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);          // signed distance to the footprint
    if (sd > 0.7) continue;
    float above = d.y + h.y;                                             // height above the underside of the box
    // Only what lies at or below the floor of the box is shaded: the vehicle's own body must not darken itself.
    float under = 1.0 - smoothstep(0.02, 0.3, above);
    float core = 1.0 - smoothstep(-0.5, 0.0, sd), skirt = 1.0 - smoothstep(0.0, 0.7, sd);
    open *= 1.0 - under * (0.5 * core + 0.42 * skirt * skirt);
  }
  return open;
}
`;

/**
 * The scene reflection probe: a cube map of the surroundings captured near the player (probe.js), blurred
 * by roughness down its mips. It is the specular environment of every surface. Needs the sky chunk
 * (envSpecular, used until the first capture exists and at qualities without a probe) and LIGHTING.
 */
export const SCENE_PROBE = /* glsl */`
uniform highp samplerCube uSceneProbe;
// The face of a cube map a direction falls on, in the order +X, -X, +Y, -Y, +Z, -Z.
int probeFace(vec3 d) {
  vec3 a = abs(d);
  if (a.x >= a.y && a.x >= a.z) return d.x >= 0.0 ? 0 : 1;
  if (a.y >= a.z) return d.y >= 0.0 ? 2 : 3;
  return d.z >= 0.0 ? 4 : 5;
}
// The same question inside a closed room (the garage), where it has an exact answer: the ray ends on the
// room's box, and the probe, which never moves there, is read towards that very place. A neon tube on a
// wall then lies on a door panel where the tube, the panel and the eye put it, and slides along the body as
// the car turns under it.
// The light box hangs well inside the box, a metre under the roof, and is the brightest thing in the room:
// read against the roof it would be half as large again on a bonnet and off to one side. So it is a second
// surface of the room's shape (uRoomKey: the rectangle of its lit face):
//   - a ray that meets the rectangle is aimed at the point it meets;
//   - a ray that passes it and ends on the roof behind it, where the probe cannot see for the light box,
//     is aimed past the rectangle's nearest edge instead, at the roof beside its housing. Without this the
//     light box would reappear, stretched, along the far side of its own reflection.
float roomReach(vec3 rel, vec3 R) {
  vec3 d = vec3(R.x < 0.0 ? min(R.x, -1e-5) : max(R.x, 1e-5), R.y < 0.0 ? min(R.y, -1e-5) : max(R.y, 1e-5), R.z < 0.0 ? min(R.z, -1e-5) : max(R.z, 1e-5));
  vec3 walls = (mix(uProbeRoom[0].xyz, uProbeRoom[1].xyz, step(0.0, R)) - rel) / d;
  return max(min(walls.x, min(walls.y, walls.z)), 0.0);
}
vec3 roomAim(vec3 rel, vec3 R) {
  float reach = roomReach(rel, R);
  vec3 end = rel + R * reach - uProbe.xyz;
  if (uRoomKey[0].w < 0.5) return end;
  vec3 u = uRoomKey[1].xyz, v = uRoomKey[2].xyz, n = cross(u, v);
  vec3 centre = uRoomKey[0].xyz - rel, fromProbe = uRoomKey[0].xyz - uProbe.xyz;
  float facing = dot(n, R), met = dot(n, centre) / (abs(facing) > 1e-5 ? facing : 1e-5);
  if (met > 0.0 && met < reach) {
    vec3 q = R * met - centre;
    if (max(abs(dot(q, u)) / dot(u, u), abs(dot(q, v)) / dot(v, v)) < 1.0) return rel + R * met - uProbe.xyz;
  }
  float towards = dot(n, end), crossed = dot(n, fromProbe) / (abs(towards) > 1e-5 ? towards : 1e-5);
  if (crossed > 0.0 && crossed < 1.0) {
    vec3 q = end * crossed - fromProbe;
    vec2 at = vec2(dot(q, u) / dot(u, u), dot(q, v) / dot(v, v)), size = vec2(length(u), length(v));
    if (max(abs(at.x), abs(at.y)) < 1.0) {
      vec2 gap = (1.0 - abs(at)) * size;                                 // metres to the edges
      if (gap.x < gap.y) at.x = (at.x < 0.0 ? -1.0 : 1.0) * (1.0 + ${ROOM_KEY_SURROUND} / size.x);
      else at.y = (at.y < 0.0 ? -1.0 : 1.0) * (1.0 + ${ROOM_KEY_SURROUND} / size.y);
      return fromProbe + u * at.x + v * at.y;
    }
  }
  return end;
}
// Where in the probe to look for what a ray from camera-relative point rel along R sees.
// A cube map knows directions, not places: read along R it shows what the capture point would see,
// which for a door panel a metre and a half off centre puts a lamp post five metres away twenty degrees
// from where its reflection belongs, and makes every reflection stand still on the body while the car
// passes the thing reflected. So the place the ray ends is estimated and the lookup aimed at that place:
//   - the probe carries 1 / distance in alpha; read along R from a blurred level it says how far away
//     the surroundings are in that direction. Only surfaces near the capture point may trust it;
//   - rays that go down end on the ground at the latest, wherever the surface stands, which puts the
//     road and its paint under a car's sills where they belong.
// Faces are redrawn in rotation, so each shows the street from where the probe stood a few frames ago.
// The same estimate takes that out: seen from the older standpoint the place lies in a slightly different
// direction. Without it a face's whole image jumps forward each time it is redrawn, which at speed is a
// reflection that stutters along the flank.
// Without a probe (uProbe.w = 0) the sky alone is reflected, and that is read by direction.
vec3 sceneAim(vec3 rel, vec3 R) {
  if (uProbe.w < 0.5) return R;
  if (uProbeRoom[0].w > 0.5) return roomAim(rel, R);
  vec3 from = rel - uProbe.xyz;
  float stored = min(textureLod(uSceneProbe, R, ${PROBE_DISTANCE_LEVEL}).a, ${PROBE_NEAREST_INV});
  float inv = stored * (1.0 - smoothstep(${PROBE_PARALLAX[0]}, ${PROBE_PARALLAX[1]}, length(from)));
  float drop = rel.y - uProbeInfo.x;
  if (R.y < -1e-3 && drop > 0.0) inv = max(inv, -R.y / drop);
  vec3 aim = from * inv + R;
  return aim - uProbeFaces[probeFace(aim)].xyz * max(inv, stored);
}
// Radiance found in direction aim (from sceneAim) for a lobe of the given roughness.
vec3 sceneRadiance(vec3 aim, float rough) {
  if (uProbe.w < 0.5) return envSpecular(aim, rough);
  return textureLod(uSceneProbe, aim, rough * uProbeInfo.y).rgb;
}
// The aim of a lobe of the given roughness, from the mirror's aim (sceneAim of the same rel and R).
// roomAim decides ray by ray whether the light box is met, which is what a mirror does and draws the box
// with a hard edge. A wide lobe meets it with part of itself: aimed the mirror's way, a painted block wall
// showed the box as a crisp pale rectangle, each pixel's blurred lookup jumping with the aim at the edge.
// The wide lobe is aimed at the room's bare box instead, where the aim has no jump and the blur of its own
// mip level draws the box as the soft sheen it is.
vec3 sceneAimFor(vec3 aim, vec3 rel, vec3 R, float rough) {
  if (uProbe.w < 0.5 || uProbeRoom[0].w < 0.5 || uRoomKey[0].w < 0.5) return aim;
  float bare = smoothstep(${ROOM_KEY_EXACT[0]}, ${ROOM_KEY_EXACT[1]}, rough);
  if (bare <= 0.0) return aim;
  return mix(aim, rel + R * roomReach(rel, R) - uProbe.xyz, bare);
}
// Radiance arriving at camera-relative point rel from direction R, for a lobe of the given roughness.
vec3 sceneSpecular(vec3 rel, vec3 R, float rough) { return sceneRadiance(sceneAimFor(sceneAim(rel, R), rel, R, rough), rough); }
`;

