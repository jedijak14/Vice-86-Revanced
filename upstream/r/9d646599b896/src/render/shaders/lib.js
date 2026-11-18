// Shared GLSL helpers available to every surface family (prepended after the contract structs).
// Signatures listed in design/ARCHITECTURE.md are frozen: bodies may be improved, names and parameters may not change.
//
// Sections
//   1. hashing and arithmetic noise        hash11 .. voronoi
//   2. noise texture                       tnoise, noiseTex, noiseTexGrad, tfbm
//   3. projections and normals             triplanarWeights, triNoise, dominantPlane, bumpNormal, tiltNormal
//   4. surface frames (fragment stage)     SurfFrame, planeFrame, uvFrame, slopeNormal, localNormal, surfaceCurvature, edgeWear
//   5. antialiasing                        aastep, aaline, pulseTrain
//   6. colour and emission                 luma, srgbToLinear, radianceCode, channelLevel
//   7. patterns                            tilePattern, brickPattern, herringbonePattern, plankPattern
//   8. ageing                              dirtStreaks, cavityDirt
//   9. water                               applyWetness, puddleMask, rainRipples, waterBeads, applyWaterBeads, applyPuddle
//
// Cost guide: hash* and vnoise are arithmetic (4 integer hashes per vnoise, 9 cells per voronoi). On anything that
// covers many pixels prefer the noise texture: one fetch is cheaper than one vnoise and it is mip-filtered, so it
// cannot shimmer.

export const LIB = /* glsl */`
#define PI 3.14159265359
#define TAU 6.28318530718
#define saturate(x) clamp(x, 0.0, 1.0)

// ---------------------------------------------------------------- 1. hashing and arithmetic noise
// Integer hashing (bit-exact on every GPU).
uint hashU(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
// The same hash on two or four values at once. The noises below hash their lattice corners through these: the
// result is bit for bit what the scalar calls give, in a quarter of the instructions. That matters to the Direct3D
// compiler behind Chrome on Windows, whose time grows with the instruction count of every inlined call.
uvec2 hashU(uvec2 v) { uvec2 s = v * 747796405u + 2891336453u; uvec2 w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uvec4 hashU(uvec4 v) { uvec4 s = v * 747796405u + 2891336453u; uvec4 w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
uint hashU2(ivec2 p) { return hashU(uint(p.x) + hashU(uint(p.y))); }
uint hashU3(ivec3 p) { return hashU(uint(p.x) + hashU(uint(p.y) + hashU(uint(p.z)))); }
float hash11(float p) { return float(hashU(uint(int(floor(p))))) * (1.0 / 4294967296.0); }
float hash12(vec2 p) { return float(hashU2(ivec2(floor(p)))) * (1.0 / 4294967296.0); }
float hash13(vec3 p) { return float(hashU3(ivec3(floor(p)))) * (1.0 / 4294967296.0); }
vec2 hash22(vec2 p) { uint h = hashU2(ivec2(floor(p))); return vec2(float(h & 0xffffu), float(h >> 16u)) * (1.0 / 65536.0); }
vec3 hash32(vec2 p) { uint h = hashU2(ivec2(floor(p))); uint g = hashU(h); return vec3(float(h & 0xffffu), float(h >> 16u), float(g & 0xffffu)) * (1.0 / 65536.0); }

// Value noise, 0..1.
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i; f = f * f * (3.0 - 2.0 * f);
  uvec2 c = uvec2(ivec2(i)), row = hashU(c.yy + uvec2(0u, 1u));          // hash12 of the four corners: rows first, then
  vec4 n = vec4(hashU(c.xxxx + uvec4(0u, 1u, 0u, 1u) + row.xxyy)) * (1.0 / 4294967296.0);   // (x, y) (x+1, y) (x, y+1) (x+1, y+1)
  return mix(mix(n.x, n.y, f.x), mix(n.z, n.w, f.x), f.y);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = p - i; f = f * f * (3.0 - 2.0 * f);
  uvec3 c = uvec3(ivec3(i)); uvec2 slab = hashU(c.zz + uvec2(0u, 1u));
  uvec4 row = hashU(c.yyyy + uvec4(0u, 1u, 0u, 1u) + slab.xxyy);          // (y, z) (y+1, z) (y, z+1) (y+1, z+1)
  vec4 n = mix(vec4(hashU(c.xxxx + row)), vec4(hashU(c.xxxx + 1u + row)), f.x) * (1.0 / 4294967296.0);
  return mix(mix(n.x, n.y, f.y), mix(n.z, n.w, f.y), f.z);
}
float fbm(vec2 p, int octaves) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < octaves; i++) { s += a * vnoise(p); n += a; p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }
  return s / n;
}
// Cellular noise: x = distance to the nearest feature point (0..~1), y = random id of that cell (0..1).
vec2 voronoi(vec2 p) {
  vec2 i = floor(p), f = p - i; float best = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)), o = hash22(i + g), r = g + o - f; float d = dot(r, r);
    if (d < best) { best = d; id = hash12(i + g + 37.0); }
  }
  return vec2(sqrt(best), id);
}

// ---------------------------------------------------------------- 2. noise texture
// uNoiseTex is 256 x 256 and tiles. Coordinates below are in TEXELS: one unit of p is one texel.
//   r, g  two independent fractal value-noise fields, base feature 16 texels, histogram-equalised: the fraction of
//         the surface where r > t is exactly 1 - t, which makes thresholds read as coverage.
//   b     blue noise, uniform 0..1 (dither, sparkle, per-pixel jitter)
//   a     cell noise: distance to the nearest feature point of a jittered 8-texel grid, 0 at the point, about 1 far away
// The texture is mip-mapped, so anything built from it fades to its mean with distance instead of aliasing.
// Inside a branch that depends on the material id use noiseTexGrad (or textureLod), never texture() or dFdx():
// implicit derivatives inside flow control make some shader compilers evaluate every branch for every pixel.
vec2 tnoise(vec2 p) { return texture(uNoiseTex, p * (1.0 / 256.0)).rg; }
vec4 noiseTex(vec2 p) { return texture(uNoiseTex, p * (1.0 / 256.0)); }
// Explicit-gradient variant: safe inside branches and across projection seams. dx, dy are the screen derivatives of p.
vec4 noiseTexGrad(vec2 p, vec2 dx, vec2 dy) { return textureGrad(uNoiseTex, p * (1.0 / 256.0), dx * (1.0 / 256.0), dy * (1.0 / 256.0)); }
// Two fetches at incommensurate scales: richer than one fetch and hides the 256-texel period. 0..1, mean 0.5.
float tfbm(vec2 p) { return 0.62 * texture(uNoiseTex, p * (1.0 / 256.0)).r + 0.38 * texture(uNoiseTex, p * (2.63 / 256.0) + 0.37).g; }

// ---------------------------------------------------------------- 3. projections and normals
vec3 triplanarWeights(vec3 n) { vec3 w = abs(n); w = max(w - 0.2, 0.0); w *= w; return w / max(w.x + w.y + w.z, 1e-5); }
// Value noise projected along the three axes and blended; p in metres times your scale. Projections with no weight are skipped.
float triNoise(vec3 p, vec3 n) {
  vec3 w = triplanarWeights(n); float r = 0.0;
  if (w.x > 0.0) r += w.x * vnoise(p.zy);
  if (w.y > 0.0) r += w.y * vnoise(p.xz);
  if (w.z > 0.0) r += w.z * vnoise(p.xy);
  return r;
}
// 2D coordinates on the dominant plane of n (for patterns that must not blend). On walls the second coordinate is up.
vec2 dominantPlane(vec3 p, vec3 n) { vec3 a = abs(n); return a.y >= a.x && a.y >= a.z ? p.xz : (a.x >= a.z ? p.zy : p.xy); }

// Bump mapping from a scalar height without tangents (fragment stage only).
// h = height in metres at this pixel, computed by the caller; wpos = any position that moves with the surface.
// Pass a camera-relative position (-s.V * s.dist) rather than s.wpos: absolute world coordinates lose the
// sub-millimetre precision the derivatives need a few kilometres from the origin.
#ifdef VICE_FRAGMENT
vec3 bumpNormal(vec3 N, vec3 wpos, float h, float strength) {
  vec3 dpdx = dFdx(wpos), dpdy = dFdy(wpos); float dhdx = dFdx(h), dhdy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx); float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
  return normalize(abs(det) * N - strength * grad);
}
#endif
// Tilt N by a small 2D slope expressed on the dominant plane (cheaper than bumpNormal; no derivatives).
// Only correct on geometry that is not rotated against the world (static tile meshes). Use slopeNormal() elsewhere.
vec3 tiltNormal(vec3 N, vec2 slope) {
  vec3 a = abs(N);
  vec3 t = a.y >= a.x && a.y >= a.z ? vec3(slope.x, 0.0, slope.y) : (a.x >= a.z ? vec3(0.0, slope.y, slope.x) : vec3(slope.x, slope.y, 0.0));
  return normalize(N - t + N * dot(t, N));
}

// ---------------------------------------------------------------- 4. surface frames (fragment stage)
// A SurfFrame bundles 2D surface coordinates with everything needed to antialias patterns drawn in them and to
// turn a slope in those coordinates into a world-space normal. It works on rotated instances and moving vehicles,
// where s.N (world) and s.lpos (mesh-local) are in different spaces.
#ifdef VICE_FRAGMENT
struct SurfFrame {
  vec2 p;       // surface coordinates (metres for planeFrame; whatever the uv means for uvFrame)
  vec2 dx, dy;  // screen-space derivatives of p (use with noiseTexGrad)
  float px;     // size of one pixel in units of p: the filter width for aastep / aaline / pulseTrain
  vec3 T, B;    // world-space directions in which p.x and p.y increase (unit length for metric coordinates)
  vec3 Nl;      // unit normal in mesh-local space (planeFrame); s.N for uvFrame
};

// Camera-relative position: identical derivatives to s.wpos without the precision loss.
vec3 relativePos(SurfIn s) { return -s.V * s.dist; }

// The shading normal expressed in mesh-local space, recovered from how local and world positions change across
// the pixel. Equals s.N on static meshes. Needed to choose projection planes for s.lpos on anything that rotates.
vec3 localNormalFrom(vec3 N, vec3 dwx, vec3 dwy, vec3 dlx, vec3 dly) {
  vec3 nw = cross(dwx, dwy), nl = cross(dlx, dly); float d = dot(nw, nw), e = dot(nl, nl);
  if (d < 1e-24 || e < 1e-24) return N;
  // N in the basis (dwx, dwy, nw); the same coefficients in the local basis give the local normal.
  float a = dot(N, cross(dwy, nw)), b = dot(N, cross(nw, dwx)), c = dot(N, nw) * sqrt(sqrt(d / e));
  vec3 r = a * dlx + b * dly + c * nl; float l = dot(r, r);
  return l > 0.0 ? r * inversesqrt(l) : N;
}
vec3 localNormal(SurfIn s) { vec3 rel = relativePos(s); return localNormalFrom(s.N, dFdx(rel), dFdy(rel), dFdx(s.lpos), dFdy(s.lpos)); }

// World-space gradients of a 2D coordinate field on the surface, normalised so the longer one has unit length.
void coordTangents(vec3 N, vec3 dwx, vec3 dwy, vec2 dcx, vec2 dcy, out vec3 T, out vec3 B) {
  vec3 r1 = cross(dwy, N), r2 = cross(N, dwx); float sgn = dot(dwx, r1) < 0.0 ? -1.0 : 1.0;
  T = (r1 * dcx.x + r2 * dcy.x) * sgn; B = (r1 * dcx.y + r2 * dcy.y) * sgn;
  float m = max(dot(T, T), dot(B, B)), inv = m > 1e-30 ? inversesqrt(m) : 0.0;
  T *= inv; B *= inv;
}

// Frame for detail projected on the dominant plane of the mesh-local position (the mapping every uv-less material uses).
// Coordinates are metres; on walls p.y is up.
SurfFrame planeFrame(SurfIn s) {
  SurfFrame f; vec3 rel = relativePos(s), dwx = dFdx(rel), dwy = dFdy(rel), dlx = dFdx(s.lpos), dly = dFdy(s.lpos);
  f.Nl = localNormalFrom(s.N, dwx, dwy, dlx, dly);
  vec3 a = abs(f.Nl);
  if (a.y >= a.x && a.y >= a.z) { f.p = s.lpos.xz; f.dx = dlx.xz; f.dy = dly.xz; }
  else if (a.x >= a.z) { f.p = s.lpos.zy; f.dx = dlx.zy; f.dy = dly.zy; }
  else { f.p = s.lpos.xy; f.dx = dlx.xy; f.dy = dly.xy; }
  f.px = max(length(f.dx), length(f.dy));
  coordTangents(s.N, dwx, dwy, f.dx, f.dy, f.T, f.B);
  return f;
}
// Frame for any continuous 2D coordinate field (vertex uv, world xz ...).
SurfFrame uvFrame(SurfIn s, vec2 uv) {
  SurfFrame f; vec3 rel = relativePos(s);
  f.p = uv; f.dx = dFdx(uv); f.dy = dFdy(uv); f.px = max(length(f.dx), length(f.dy)); f.Nl = s.N;
  coordTangents(s.N, dFdx(rel), dFdy(rel), f.dx, f.dy, f.T, f.B);
  return f;
}
// Tilt N by a slope (dh/dp.x, dh/dp.y) given in the frame's coordinates. Positive height is out of the surface.
vec3 slopeNormal(vec3 N, SurfFrame f, vec2 slope) { return normalize(N - f.T * slope.x - f.B * slope.y); }

// Mean curvature of the shaded surface in 1/metres, positive where it is convex (a cylinder of radius r gives 0.5 / r).
// Real bevels and rounded corners show up here; hard creases between flat faces do not.
float surfaceCurvature(SurfIn s) {
  vec3 rel = relativePos(s), dpx = dFdx(rel), dpy = dFdy(rel), dnx = dFdx(s.N), dny = dFdy(s.N);
  return 0.5 * (dot(dnx, dpx) / max(dot(dpx, dpx), 1e-12) + dot(dny, dpy) / max(dot(dpy, dpy), 1e-12));
}
// 0..1 mask of convex edges tighter than 'radius' metres: where paint chips and metal polishes first.
float edgeWear(SurfIn s, float radius) { return smoothstep(0.5, 1.5, surfaceCurvature(s) * 2.0 * radius); }
#endif

// ---------------------------------------------------------------- 5. antialiasing
// All take the filter width w in the units of the argument (SurfFrame.px, or fwidth of the coordinate).
// Step from 0 to 1 at 'edge', box-filtered over w.
float aastep(float edge, float x, float w) { return saturate((x - edge) / max(w, 1e-6) + 0.5); }
// Coverage of a line: 1 where |d| < halfWidth. Thin lines keep their energy (they dim instead of flickering).
float aaline(float d, float halfWidth, float w) { float a = abs(d); w = max(w, 1e-6); return saturate((halfWidth - a) / w + 0.5) * saturate(2.0 * halfWidth / w + 0.25); }
// Periodic pulse of period 1 that is on for the first 'duty' fraction, integrated exactly over the filter width.
float pulseTrain(float x, float duty, float w) {
  w = max(w, 1e-6); float a = x - 0.5 * w, b = x + 0.5 * w;
  float fa = floor(a) * duty + min(a - floor(a), duty), fb = floor(b) * duty + min(b - floor(b), duty);
  return (fb - fa) / w;
}

// ---------------------------------------------------------------- 6. colour and emission
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 srgbToLinear(vec3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
// Emissive intensity code used by material parameters: radiance = 0.25 * 2^(code / 16) in scene units
// (code 64 = 4, 96 = 16, 112 = 32, 128 = 64, 160 = 256).
float radianceCode(float code) { return 0.25 * exp2(code * (1.0 / 16.0)); }

// Emissive switching. channel = CHANNEL id (see ids.js), seed 0..1 per fixture. Returns 0..1 (may flicker).
// The renderer evaluates the same rules on the CPU for light records; keep the two in step.
float channelLevel(float channel, float seed) {
  int c = int(channel + 0.5);
  if (c == 0) return 1.0;
  if (c == 1) return uSwitch.x * step(seed * 0.35, uSwitch.x);                       // street lamps strike one after another
  if (c == 2) return uSwitch.y * step(seed * 0.5, uSwitch.y);
  if (c == 3) return uSwitch.z;
  if (c == 7) return step(0.6, fract(uTime.x * 0.45 + seed)) * uSwitch.w;            // aviation blink
  if (c == 8) { float t = uTime.x * 9.0 + seed * 91.0; return uSwitch.y * step(0.35, vnoise(vec2(t, seed * 13.0))) * (0.6 + 0.4 * hash11(floor(t * 3.0))); }
  return 1.0;
}

// ---------------------------------------------------------------- 7. patterns
// Each returns the joint mask (1 inside the joint, 0 on the unit) and writes
//   id  integer coordinates of the unit (hash it for per-unit variation)
//   q   position inside the unit in metres, measured from its centre
// 'joint' is the full joint width in metres, w the filter width in metres.
float jointMask(vec2 q, vec2 halfSize, float joint, float w) { vec2 e = halfSize - abs(q); return 1.0 - aastep(0.5 * joint, min(e.x, e.y), w); }
// Square grid.
float tilePattern(vec2 p, float size, float joint, float w, out vec2 id, out vec2 q) {
  vec2 g = p / size; id = floor(g); q = (g - id - 0.5) * size;
  return jointMask(q, vec2(0.5 * size), joint, w);
}
// Running bond: size = (length, height) of one brick including its joint; alternate courses shift by half a brick.
float brickPattern(vec2 p, vec2 size, float joint, float w, out vec2 id, out vec2 q) {
  vec2 g = p / size; float row = floor(g.y); g.x += 0.5 * (row - 2.0 * floor(row * 0.5));
  id = vec2(floor(g.x), row); q = (g - id - 0.5) * size;
  return jointMask(q, 0.5 * size, joint, w);
}
// 90 degree herringbone of bricks 2 * width long. q.x runs along the brick.
float herringbonePattern(vec2 p, float width, float joint, float w, out vec2 id, out vec2 q) {
  vec2 g = p / width, i = floor(g); float m = i.x - i.y; m -= 4.0 * floor(m * 0.25);
  // squares on diagonals 0|1 pair sideways into a horizontal brick, 2|3 pair vertically
  vec2 o = m < 0.5 ? i : (m < 1.5 ? i - vec2(1.0, 0.0) : (m < 2.5 ? i - vec2(0.0, 1.0) : i));
  bool upright = m > 1.5; vec2 l = g - o - (upright ? vec2(0.5, 1.0) : vec2(1.0, 0.5));
  id = o * 2.0 + (upright ? 1.0 : 0.0); q = (upright ? l.yx : l) * width;
  return jointMask(q, vec2(width, 0.5 * width), joint, w);
}
// Boards running along p.x: 'width' across p.y, butt joints about every 'len' metres, staggered per board.
float plankPattern(vec2 p, float width, float len, float joint, float w, out vec2 id, out vec2 q) {
  float row = floor(p.y / width), x = p.x / len + hash11(row * 3.0 + 11.0) * 7.0; id = vec2(floor(x), row);
  q = vec2((x - id.x - 0.5) * len, p.y - (row + 0.5) * width);
  return jointMask(q, vec2(0.5 * len, 0.5 * width), joint, w);
}

// ---------------------------------------------------------------- 8. ageing
#ifdef VICE_FRAGMENT
// Run-off streaks on a wall, 0..1. f.p in metres with p.y up. Streaks are 3 to 10 cm wide, metres long, and start
// at irregular heights. Multiply by your own weathering amount; darken albedo and raise roughness with the result.
float dirtStreaks(SurfFrame f) {
  vec2 k = vec2(190.0, 5.0), k2 = vec2(11.0, 7.0);
  float fine = noiseTexGrad(f.p * k, f.dx * k, f.dy * k).r, band = noiseTexGrad(f.p * k2 + 40.0, f.dx * k2, f.dy * k2).g;
  return smoothstep(0.52, 0.9, fine) * smoothstep(0.25, 0.75, band);
}
#endif
// Dirt that collects where geometry meets geometry. occ = baked occlusion (s.occ), n = any 0..1 noise to break the edge.
// The noise only frays the edge of the gradient: builders also bake one occlusion value over a whole shaded face
// (the piers under a deck), and a stronger noise term printed that face with dark blotches.
float cavityDirt(float occ, float n) { return smoothstep(0.92, 0.35, occ + (n - 0.5) * 0.1); }

// ---------------------------------------------------------------- 9. water
// Call at the end of surface() for anything exposed to the sky.
// porosity 0..1: how much the material darkens when wet (asphalt 0.8, stucco 0.6, paint/metal/glass 0).
// exposure 0..1: how much rain reaches it (1 = open to the sky, 0 = sheltered).
void applyWetness(inout SurfOut o, vec3 N, float porosity, float exposure) {
  float w = uWeather.y * exposure * saturate(0.35 + 0.65 * N.y);
  if (w <= 0.0) return;
  // absorbed water darkens dark channels more than bright ones, so wet colour is deeper, not just dimmer
  o.albedo *= mix(vec3(1.0), 0.42 + 0.3 * o.albedo, w * porosity);
  o.rough = mix(o.rough, min(o.rough, 0.22), w * 0.85);
  o.coat = max(o.coat, w * 0.6 * (1.0 - o.metal));
  o.coatRough = mix(o.coatRough, 0.06, w);
}

// World-space puddle field. xz = world position in metres. Returns standing-water depth 0..1 (0 dry, 1 well under
// the surface); the wetted area grows with uWeather.z up to about 40 percent of flat ground. Add your own bias to
// 'lower' (metres-free, 0..0.3) where water collects first: wheel ruts, kerb lines, low corners.
float puddleMask(vec2 xz, float lower) {
  float terrain = 0.66 * texture(uNoiseTex, xz * (4.0 / 256.0)).r + 0.34 * texture(uNoiseTex, xz * (14.6 / 256.0) + 0.61).g;
  return saturate((mix(0.14, 0.47, uWeather.z) + lower - terrain) * 9.0) * step(0.001, uWeather.z);
}
float puddleMask(vec2 xz) { return puddleMask(xz, 0.0); }
// The same field with an explicit filter width w (pixel size in metres, SurfFrame.px). Use this one inside
// per-material branches: it needs no screen derivatives, so the branch is not flattened by shader compilers.
float puddleMask(vec2 xz, float lower, float w) {
  float terrain = 0.66 * textureLod(uNoiseTex, xz * (4.0 / 256.0), log2(max(w * 4.0, 1.0))).r + 0.34 * textureLod(uNoiseTex, xz * (14.6 / 256.0) + 0.61, log2(max(w * 14.6, 1.0))).g;
  return saturate((mix(0.14, 0.47, uWeather.z) + lower - terrain) * 9.0) * step(0.001, uWeather.z);
}

// One layer of expanding rain rings on a grid of the given cell size (metres).
vec3 rippleLayer(vec2 p, float cell, float salt) {
  vec2 g = p / cell + salt * 17.3, id = floor(g), f = g - id; float h = hash12(id + salt * 91.0);
  float t = uTime.x * (1.25 + 0.6 * h) + h * 7.0, cycle = floor(t), ft = t - cycle;
  vec3 r = hash32(id + cycle * 13.0 + salt * 7.0);                      // a new place in the cell for every drop
  if (r.z > uWeather.x * 0.85 + 0.1) return vec3(0.0);
  vec2 q = f - (0.3 + 0.4 * r.xy); float d = length(q), x = (d - ft * 0.3) / 0.04, env = exp(-x * x) * (1.0 - ft) * (1.0 - ft);
  return vec3(q / max(d, 1e-4) * (sin(x * 2.6) * env), env);
}
// Rings made by raindrops on standing water. p in metres on the water plane, w = pixel size in metres.
// Returns xy = slope to add to the water normal (slopeNormal / tiltNormal), z = ring presence 0..1. Zero when it is not raining.
vec3 rainRipples(vec2 p, float w) {
  float fade = (1.0 - smoothstep(0.012, 0.05, w)) * step(0.001, uWeather.x);
  if (fade <= 0.0) return vec3(0.0);
  vec3 a = rippleLayer(p, 0.19, 0.0) + rippleLayer(p + 0.11, 0.31, 1.0);
  return vec3(a.xy * 0.55, min(a.z, 1.0)) * fade;
}

// One layer of sessile drops: at most one drop per cell, kept inside its cell so a single hash is enough.
// Returns xy = slope, z = coverage. 'life' re-rolls a cell while rain is falling so that drops come and go.
vec3 beadLayer(vec2 p, float cell, float density, float w, float salt) {
  vec2 g = p / cell, id = floor(g), f = g - id; float h0 = hash12(id + salt);
  float t = uTime.x * 0.35 + h0 * 9.0, epoch = uWeather.x > h0 * 0.8 ? floor(t) : 0.0, grow = uWeather.x > h0 * 0.8 ? smoothstep(0.0, 0.3, t - epoch) : 1.0;
  vec3 h = hash32(id + salt + epoch * 7.0);
  if (h.z > density) return vec3(0.0);
  float r = (0.14 + 0.3 * h.z / max(density, 1e-3)) * grow; vec2 q = f - (r + h.xy * (1.0 - 2.0 * r));
  float d = length(q) / max(r, 1e-4), m = aastep(0.0, 1.0 - d, w / (cell * max(r, 1e-4)));
  return vec3(-q / max(r, 1e-4) * (0.55 * inversesqrt(max(1.0 - d * d, 0.12))) * m, m);
}
// Water standing in beads and running in streaks on a smooth surface (paint, glass, metal, plastic).
//   p       surface coordinates in metres, p.y up on walls (SurfFrame.p)
//   steep   0 on a horizontal surface, 1 on a vertical one (1 - abs(world N.y) is a good value)
//   w       pixel size in metres (SurfFrame.px)
//   amount  0..1: uWeather.y times how exposed the surface is
// Returns xy = slope for slopeNormal(), z = water coverage 0..1 (use it to drop roughness), w = how much of the
// pixel has just been wiped by a running drop (clean streak through dirt).
// Beads appear with wetness and stay after the rain; running drops need falling rain (uWeather.x).
vec4 waterBeads(vec2 p, float steep, float w, float amount) {
  if (amount <= 0.0) return vec4(0.0);
  float near = 1.0 - smoothstep(0.0015, 0.005, w);                    // drops smaller than a pixel become their average
  vec3 acc = vec3(0.0); float trail = 0.0;
  if (near > 0.0) {
    float dens = amount * mix(0.75, 0.4, steep);
    acc = beadLayer(p, mix(0.026, 0.017, steep), dens, w, 3.0);
    vec3 fine = beadLayer(p + 0.37, 0.0085, dens * 0.8, w, 57.0) * (1.0 - smoothstep(0.002, 0.006, w));
    acc = acc.z > 0.0 ? acc : fine;
    // running drops: one track per column, the head leaves a thin trail that breaks into small beads
    float run = steep * smoothstep(0.02, 0.25, uWeather.x) * amount;
    if (run > 0.0) {
      float colW = 0.034, cx = p.x / colW, ci = floor(cx); vec3 h = hash32(vec2(ci, 5.0));
      if (h.z < 0.25 + 0.6 * uWeather.x) {
        float period = 0.7 + 1.6 * h.y, t = uTime.x * (0.22 + 0.5 * h.x) + 0.05 * sin(uTime.x * 2.3 + h.x * 40.0);
        float k = fract((p.y + t) / period + h.z * 13.0), up = k * period;            // metres above the drop head
        float dx = (cx - ci - 0.5 - 0.22 * sin(p.y * 11.0 + h.y * 30.0)) * colW;
        float below = (k - 1.0) * period, dy = up < 0.5 * period ? up : below;
        // head: a drop stretched along its fall
        float rh = 0.0034 + 0.002 * h.x, d = length(vec2(dx, dy * 0.6)) / rh, head = aastep(0.0, 1.0 - d, w / rh);
        vec2 hs = -vec2(dx, dy * 0.6) / rh * (0.7 * inversesqrt(max(1.0 - d * d, 0.12)));
        // trail: narrows and breaks up behind the head
        float len = 0.35 * period, along = saturate(1.0 - up / len), tw = 0.0013 * along + 0.0003;
        float beads = step(0.35, hash12(vec2(floor(p.y / 0.004), ci))) * 0.6 + 0.4;
        float tr = aaline(dx, tw, w) * along * step(0.0, up) * mix(beads, 1.0, along * along);
        vec2 ts = vec2(-dx / max(tw, 1e-4) * 0.5, 0.0);
        float wipe = aaline(dx, 0.004, w) * saturate(1.0 - up / (0.9 * period));     // the path it cleared
        acc *= 1.0 - wipe; trail = wipe * run;
        acc = head > 0.0 ? vec3(hs * head, head) * run : (tr > 0.0 ? vec3(ts * tr, tr) * run : acc);
      }
    }
  }
  float average = amount * 0.22;
  return vec4(acc.xy * near, mix(average, acc.z, near), trail);
}
#ifdef VICE_FRAGMENT
// Apply the result of waterBeads(): lens-like drops with their own sharp highlight.
void applyWaterBeads(inout SurfOut o, SurfFrame f, vec4 beads) {
  o.N = slopeNormal(o.N, f, beads.xy);
  o.rough = mix(o.rough, 0.05, beads.z);
  o.coat = max(o.coat, beads.z * (1.0 - o.metal)); o.coatRough = mix(o.coatRough, 0.04, beads.z);
}
#endif
// Turn a pixel into standing water. depth = puddleMask() result, flatN = the undisturbed surface normal (water is
// level, so it hides the bumps of what it covers), ripple = rainRipples().xy already applied to flatN if wanted.
void applyPuddle(inout SurfOut o, vec3 flatN, float depth) {
  if (depth <= 0.0) return;
  float film = smoothstep(0.0, 0.35, depth);
  o.albedo *= mix(1.0, 0.5, film);
  o.N = normalize(mix(o.N, flatN, film));
  o.rough = mix(o.rough, 0.04, film);
  o.coat = max(o.coat, film); o.coatRough = mix(o.coatRough, 0.03, film);
  o.wet = max(o.wet, film);
  o.ao = mix(o.ao, 1.0, film * 0.5);
}
`;
