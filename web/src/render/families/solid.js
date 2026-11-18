// SOLID surface family: every procedural material that is not ground, facade, vehicle or foliage.
// Material ids and the meaning of colour / p0..p2 / uv are in design/ARCHITECTURE.md section 5.1.
//
// How this file is organised
//   COMMON    the per-pixel context (frames, noise access, shared ageing and rain helpers)
//   MASONRY   PAINT, CONCRETE, STUCCO, ROCK
//   METALS    METAL_PAINTED, METAL_BARE, PLASTIC, RUBBER, DARK_GLASS
//   LIGHTS    EMISSIVE, SIGN, NEON, LAMP_LENS
//   ORGANIC   WOOD, TRUNK, FABRIC, SKIN_CLOTH
//   BUILT     ROOF, TILE, POOL_WATER
//   INTERIOR  EPOXY, BLOCK, GLASS_BLOCK, PEGBOARD
//   MAIN      surface(): builds the context once, then runs exactly one material
//
// The material dispatch is data (MATERIALS). The renderer does not compile one fragment shader for the whole
// family: the Direct3D compiler behind Chrome on Windows needs time that grows with every material in the chain,
// and the browser kills a GPU process that is busy for too long. It compiles one shader per entry of GROUPS,
// each from fragmentFor(ids), and draws the triangles of those ids with it.
//
// Two rules keep the family cheap and stable:
//   1. Everything that needs screen derivatives is computed once in surface(), before the material branch.
//      Inside the materials only explicit-gradient fetches are used, so shader compilers keep the branch.
//   2. All repeated detail comes from the mip-mapped noise texture or is filtered with the pixel footprint, so
//      micro detail fades to its average with distance instead of shimmering.

import { SOLID } from '../../core/ids.js';
import { PLANT_SWAY } from './foliage.js';

// Shared by the vertex and the fragment stage. A lit neon tube thinner than about a pixel and a half breaks into
// dashes, so its vertices are pushed out along their (radial) normals until it covers that much, and matNeon lowers
// the radiance by the same ratio: the widened tube sends the same light to the eye. Returns the push in metres.
const NEON_WIDTH = /* glsl */`
const float NEON_RADIUS = 0.011;   // the tube radius drawn by the generators
float neonPixel(float dist) {                                       // metres covered by one pixel at that distance
  return 2.0 * dist / (length(vec3(uViewProjStable[0][1], uViewProjStable[1][1], uViewProjStable[2][1])) * uViewport.y);
}
float neonWiden(float dist, vec4 mat) {
  if (mat.y < 0.5) return 0.0;                                      // dead tubes are low in contrast and stay thin
  int ch = int(mat.z + 0.5);
  float on = ch == 2 || ch == 8 ? saturate(4.0 * uSwitch.y) : 1.0;  // not the flicker itself: the width must not pulse
  return max(0.8 * neonPixel(dist) - NEON_RADIUS, 0.0) * on;
}
`;

const COMMON = NEON_WIDTH + /* glsl */`
const float GROUND_Y = 1.2;        // land level of the map: splash grime on walls is placed relative to it

struct Ctx {
  SurfFrame f;        // pattern frame: dominant plane of the local position, or the vertex uv where a material defines one
  vec3 lp, dlx, dly;  // mesh-local position and its screen derivatives (isotropic noise projects along the three axes)
  vec3 tw;            // weights of those three projections
  vec3 col;           // base colour after resolving the instance tint key
  float seed;         // 0..1 from p2
  vec2 so;            // noise offset in texels derived from the seed and the instance, so neighbours differ
  float curv;         // surface curvature, 1/m (see surfaceCurvature)
  float wall;         // 0 on horizontal faces, 1 on vertical ones
  float upright;      // 1 where the frame's second coordinate runs up a wall (run-off streaks are valid)
  float hgt;          // metres above the ground plane
  float expo;         // 0..1 how open to the sky (from baked occlusion)
  float rain;         // wetness that reaches this pixel, 0..1
  bool mapped;        // the pattern frame is the vertex uv
  float seam;         // 0 where a curved uv-less surface passes from one projection plane to the next, 1 away from it
};

// Noise in the pattern frame. On uv-less materials the three axis projections are blended where the surface turns
// from one plane to the next: a hard switch shows on every column and ball as a step in tone (one fetch on flat faces).
vec4 planeNoise(Ctx c, vec2 k) {
  if (c.mapped) return noiseTexGrad(c.f.p * k + c.so, c.f.dx * k, c.f.dy * k);
  vec4 r = vec4(0.0);
  if (c.tw.x > 0.0) r += c.tw.x * noiseTexGrad(c.lp.zy * k + c.so, c.dlx.zy * k, c.dly.zy * k);
  if (c.tw.y > 0.0) r += c.tw.y * noiseTexGrad(c.lp.xz * k + c.so, c.dlx.xz * k, c.dly.xz * k);
  if (c.tw.z > 0.0) r += c.tw.z * noiseTexGrad(c.lp.xy * k + c.so, c.dlx.xy * k, c.dly.xy * k);
  return r;
}
vec4 planeNoise(Ctx c, float k) { return planeNoise(c, vec2(k)); }

// Noise for surfaces of any shape: the three axis projections blended by the normal (one fetch on flat faces).
// k = texels per metre (feature size is 16 / k metres). g receives a pseudo-gradient for grainNormal().
vec4 solidNoise(Ctx c, float k, out vec3 g) {
  vec4 r = vec4(0.0); g = vec3(0.0);
  if (c.tw.x > 0.0) { vec4 t = noiseTexGrad(c.lp.zy * k + c.so, c.dlx.zy * k, c.dly.zy * k); r += c.tw.x * t; g += c.tw.x * vec3(0.0, t.g - 0.5, t.r - 0.5); }
  if (c.tw.y > 0.0) { vec4 t = noiseTexGrad(c.lp.xz * k + c.so, c.dlx.xz * k, c.dly.xz * k); r += c.tw.y * t; g += c.tw.y * vec3(t.r - 0.5, 0.0, t.g - 0.5); }
  if (c.tw.z > 0.0) { vec4 t = noiseTexGrad(c.lp.xy * k + c.so, c.dlx.xy * k, c.dly.xy * k); r += c.tw.z * t; g += c.tw.z * vec3(t.r - 0.5, t.g - 0.5, 0.0); }
  return r;
}
// Tilt N by the tangential part of a pseudo-gradient. The field is isotropic, so it does not matter that g is
// expressed in mesh space while N is in world space.
vec3 grainNormal(vec3 N, vec3 g, float strength) { return normalize(N - (g - N * dot(g, N)) * strength); }

// One channel of a texel. Not t[ch]: a vector indexed by a variable breaks Chrome on Windows, see litPick in shaders/common.js.
float reliefChannel(vec4 t, int ch) { return ch == 0 ? t.x : ch == 1 ? t.y : ch == 2 ? t.z : t.w; }

// Height (0..1) and true slope of one noise channel in the pattern frame, from three fetches. Used where light has
// to agree with a visible pattern (plaster islands, gravel, bark); grainNormal is enough for unstructured grain.
// The step is one texel, or one pixel once a texel is smaller than that, so the relief fades with the mip chain.
float planeRelief(Ctx c, float k, int ch, out vec2 slope) {
  vec2 q = c.f.p * k + c.so, dx = c.f.dx * k, dy = c.f.dy * k; float e = max(1.0, c.f.px * k);
  float h = reliefChannel(noiseTexGrad(q, dx, dy), ch), hx = reliefChannel(noiseTexGrad(q + vec2(e, 0.0), dx, dy), ch), hy = reliefChannel(noiseTexGrad(q + vec2(0.0, e), dx, dy), ch);
  slope = vec2(hx - h, hy - h) / e;
  return h;
}

// The slowest of the three scales a weathered surface varies at: a signed field (two channels, about -0.5..0.5)
// with features some 20 m across. Materials lean their tone, fade and sheen on it so the two ends of a long wall,
// roof or deck are never alike; the metre and millimetre scales are each material's own patterns. It is used
// linearly on purpose: a threshold on a slow field paints camouflage.
vec2 slowDrift(Ctx c) { return planeNoise(c, 0.8).rg - 0.5; }

// Fraction of fine detail that survives at this pixel size: 1 while 'size' metres covers several pixels, 0 below one.
float detailFade(Ctx c, float size) { return 1.0 - smoothstep(0.35 * size, 1.1 * size, c.f.px); }

// Hairline cracks, 0..1: two families of wandering lines (one near the frame's second axis, one slanted across it),
// each open only along some stretches. Distances are metric, so a crack stays about 2 mm wide at any range and
// dims rather than flickers when it is thinner than a pixel. period = metres between neighbouring lines.
float hairCracks(Ctx c, float period, float amount) {
  vec4 wander = planeNoise(c, vec2(9.0, 21.0) / period), jag = planeNoise(c, 240.0);
  float open = 0.0;
  for (int i = 0; i < 2; i++) {
    // the second family is the first one sheared and mirrored, so the two cross at about 60 degrees
    vec2 ax = i == 0 ? vec2(1.0, 0.13) : vec2(-0.58, 0.82), ay = vec2(-ax.y, ax.x);
    float w = i == 0 ? wander.r : wander.g, j = i == 0 ? jag.r : jag.g;
    float u = dot(c.f.p, ax) / period + (w - 0.5) * 0.7 + float(i) * 0.37 + c.seed * 3.0, id = floor(u);
    float d = (u - id - 0.5) * period + (j - 0.5) * 0.012, t = dot(c.f.p, ay);
    float stretch = noiseTexGrad(vec2(id * 37.0 + 11.0 * float(i), t * 14.0 / period) + c.so, vec2(0.0, dot(c.f.dx, ay)) * 14.0 / period, vec2(0.0, dot(c.f.dy, ay)) * 14.0 / period).g;
    open = max(open, aaline(d, 0.0011, c.f.px) * smoothstep(1.0 - amount, 1.1 - amount, stretch + (hash11(id + float(i) * 7.0 + c.seed * 31.0) - 0.5) * 0.4));
  }
  return open * c.seam;
}

// Dirt that splashes up from the pavement and settles at the foot of anything standing on the ground, 0..1.
// The splash reaches higher in some places than others; n (any 0..1 detail noise) breaks its upper edge into speckle.
float baseGrime(Ctx c, float n) {
  if (c.wall <= 0.0 || c.hgt > 1.5 || c.hgt < -0.6) return 0.0;
  vec4 slow = planeNoise(c, vec2(24.0, 8.0));
  float h = c.hgt / (0.3 + 0.7 * slow.r);
  return c.wall * (1.0 - smoothstep(0.0, 0.95, h + (n - 0.5) * 0.22)) * (0.6 + 0.4 * slow.g);
}

// Standing water on level faces: puddles that follow the weather, with rain rings.
void standingWater(SurfIn s, inout SurfOut o, Ctx c, float lower) {
  if (uWeather.z <= 0.0 || c.wall > 0.06 || s.N.y < 0.0) return;
  float d = puddleMask(s.wpos.xz, lower, c.f.px) * c.expo;
  if (d <= 0.0) return;
  vec3 r = rainRipples(s.wpos.xz, c.f.px);
  applyPuddle(o, normalize(s.N - vec3(r.x, 0.0, r.y) * smoothstep(0.0, 0.3, d)), d);
}
// Beads and running drops on smooth, water-shedding finishes. smoothness 0..1 scales how well water beads.
void beadWater(SurfIn s, inout SurfOut o, Ctx c, float smoothness) {
  float amount = c.rain * smoothness;
  if (amount <= 0.0) return;
  applyWaterBeads(o, c.f, waterBeads(c.f.p + c.so * 0.01, c.wall * c.upright, c.f.px, amount));
}
`;

const MASONRY = /* glsl */`
// ---------------------------------------------------------------- PAINT
// p0 roughness, p1 weathering. A paint film over an unknown substrate: chalks and fades where the sun reaches,
// chips from edges and from the foot upwards, collects run-off streaks.
void matPaint(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.08), age = s.mat.z / 255.0;
  vec3 g, g2; vec4 fine = solidNoise(c, 2800.0, g), mid = solidNoise(c, 190.0, g2), big = planeNoise(c, 9.0);
  // sun chalks a painted face evenly: the slow field only leans it, it must not paint pale islands
  vec2 drift = slowDrift(c);
  float sky = saturate(0.55 + 0.45 * s.N.y), fade = age * sky * (0.72 + 0.28 * big.r) * (1.0 + 0.6 * drift.x);
  vec3 col = mix(c.col, mix(vec3(luma(c.col)), vec3(0.85), 0.4), fade * 0.5);
  col *= 1.0 + drift.y * 0.07 + (big.g - 0.5) * 0.06 * (0.6 + age) + (mid.r - 0.5) * 0.06 * age;
  float edge = smoothstep(0.5, 1.5, c.curv * 0.07);
  float streak = dirtStreaks(c.f) * c.upright * age, grime = baseGrime(c, mid.g) * (0.25 + 0.75 * age), cav = cavityDirt(s.occ, mid.r) * (0.3 + 0.7 * age);
  float dirt = saturate(streak * 0.5 + grime * 0.65 + cav * 0.5);
  col = mix(col, col * vec3(0.3, 0.27, 0.23) + 0.012, dirt);
  // chips: where the film has let go the undercoat shows, and in the middle of large chips the substrate
  float field = 0.5 * mid.r + 0.3 * fine.r + 0.2 * big.g;
  float thr = 1.03 - age * 0.34 - edge * (0.2 + 0.45 * age) - grime * 0.2 * age, soft = 0.012 + c.f.px * 14.0;
  float chip = smoothstep(thr, thr + soft, field), deep = smoothstep(thr + 0.07, thr + 0.07 + soft, field);
  col = mix(col, mix(col, vec3(0.6, 0.58, 0.53), 0.78), chip);
  col = mix(col, vec3(0.2, 0.165, 0.13) * (0.7 + 0.6 * fine.g), deep * 0.9);
  o.albedo = col;
  // sheen is never even: the film is thicker where the roller overlapped and duller where it has weathered
  float sheen = rough + drift.x * 0.1 + (big.r - 0.5) * 0.12 + (fine.g - 0.5) * 0.08 * detailFade(c, 0.003);
  o.rough = mix(clamp(sheen, 0.08, 1.0), 0.92, saturate(fade * 0.6 + chip + dirt * 0.6));
  // brush texture everywhere, a lip around each chip
  o.N = grainNormal(o.N, g, 0.03 + 0.05 * age);
  o.N = grainNormal(o.N, g2, 0.9 * chip * (1.0 - chip) * detailFade(c, 0.01));
  o.ao *= 1.0 - 0.3 * cav;
  beadWater(s, o, c, smoothstep(0.75, 0.3, o.rough));
  applyWetness(o, s.N, 0.12 + 0.5 * chip + 0.3 * fade, c.expo);
}

// ---------------------------------------------------------------- CONCRETE
// p0 joint spacing in dm (0 none), p1 weathering. Cast concrete: cloudy curing marks, sand speckle, bug holes,
// lift lines on walls, hairline cracks, damp stains below joints and at the foot, puddles on slabs.
void matConcrete(SurfIn s, inout SurfOut o, Ctx c) {
  float spacing = s.mat.y * 0.1, age = s.mat.z / 255.0;
  vec3 g, g2, g3; vec4 fine = solidNoise(c, 1900.0, g), pits = solidNoise(c, 620.0, g2), mid = solidNoise(c, 110.0, g3);
  vec4 big = planeNoise(c, 6.0), blot = planeNoise(c, 31.0);
  float near = detailFade(c, 0.004);
  vec2 drift = slowDrift(c);
  vec3 col = c.col * (0.84 + 0.3 * (0.55 * big.r + 0.45 * blot.g)) * (1.0 + 0.12 * drift.x);
  col *= 1.0 + (fine.b - 0.5) * 0.2 * near + (fine.r - 0.5) * 0.1;
  col = mix(col, col * vec3(1.06, 1.0, 0.9), (blot.r - 0.5) * 0.5 + 0.25);          // warm and cool cement patches
  // bug holes: air trapped against the formwork, in clusters
  float pit = (1.0 - smoothstep(0.07, 0.16, pits.a)) * smoothstep(0.45, 0.7, mid.r) * detailFade(c, 0.006);
  // lift lines: every pour leaves a level seam and a slightly different tone
  float liftH = 1.22, row = floor(c.f.p.y / liftH), ly = c.f.p.y - (row + 0.5) * liftH;
  float lift = aaline(abs(ly) - 0.5 * liftH, 0.004, c.f.px) * c.upright;
  col *= 1.0 + (hash11(row + c.seed * 255.0) - 0.5) * 0.09 * c.upright;
  // joints
  float joint = 0.0, under = 0.0;
  if (spacing > 0.0) {
    vec2 id, q; joint = tilePattern(c.f.p, spacing, 0.014, c.f.px, id, q);
    col *= 1.0 + (hash12(id + c.seed * 91.0) - 0.5) * 0.08 * detailFade(c, spacing * 0.3);
    // on walls water sits in the horizontal joint and stains the panel below it
    under = c.upright * smoothstep(0.5 * spacing, 0.5 * spacing - 0.35, 0.5 * spacing - q.y) * (0.2 + 0.6 * blot.g);
    under += (1.0 - c.wall) * smoothstep(0.5 * spacing - 0.09, 0.5 * spacing, max(abs(q.x), abs(q.y))) * 0.6;
  }
  float crack = hairCracks(c, 2.6, 0.2 + 0.5 * age);
  float streak = dirtStreaks(c.f) * c.upright, grime = baseGrime(c, mid.g), cav = cavityDirt(s.occ, mid.r);
  float damp = saturate((streak * 0.55 + under * 0.5) * (0.35 + age) + grime * (0.35 + 0.5 * age) + cav * 0.55);
  col = mix(col, col * vec3(0.42, 0.4, 0.36), damp);
  col = mix(col, vec3(0.1, 0.13, 0.06), grime * age * smoothstep(0.35, 0.95, blot.g) * 0.5);          // algae where it stays damp
  col = mix(col, vec3(0.3, 0.14, 0.05), smoothstep(0.82, 0.97, blot.r * 0.75 + mid.g * 0.25 + 0.12 * age) * 0.4 * streak);   // rust weep from a tie
  // efflorescence: salts carried out along cracks and joints dry white
  float salt = saturate(crack * 0.7 + joint * 0.3) * age * smoothstep(0.4, 0.8, mid.g);
  col = mix(col, vec3(0.72, 0.71, 0.68), salt * 0.5);
  float groove = saturate(max(joint, lift * 0.6) + crack * 0.8 + pit);
  o.albedo = col * mix(1.0, 0.32, groove);
  // steel-trowelled patches are closed and smooth, washed-out ones open and sandy; damp concrete has a dull sheen
  o.rough = clamp(0.86 - 0.16 * (blot.r - 0.5) + 0.08 * drift.y + 0.1 * (fine.g - 0.5) * near - 0.12 * damp + 0.08 * salt + 0.1 * groove, 0.5, 1.0);
  o.N = grainNormal(o.N, g, 0.07 * near + 0.02);
  o.N = grainNormal(o.N, g2, pit * 0.8);
  o.ao *= (1.0 - 0.45 * groove) * (1.0 - 0.25 * cav);
  standingWater(s, o, c, joint * 0.12 + (0.5 - big.r) * 0.1);
  applyWetness(o, s.N, 0.75, c.expo);
}

// ---------------------------------------------------------------- STUCCO
// p0 texture strength (0 float finish, 255 heavy lace), p1 weathering. Painted cement render: flat-topped islands
// over a sandy ground, colour patches where it was repaired, hairline cracks (some caulked), rain streaks,
// mildew and splash at the foot, salt bloom above it.
void matStucco(SurfIn s, inout SurfOut o, Ctx c) {
  float tex = s.mat.y / 255.0, age = s.mat.z / 255.0;
  vec3 g, g3; vec4 sand = solidNoise(c, 3300.0, g), mid = solidNoise(c, 85.0, g3);
  vec4 big = planeNoise(c, 5.0), blot = planeNoise(c, 23.0);
  vec2 drift = slowDrift(c);
  float near = detailFade(c, 0.003), meso = detailFade(c, 0.005) * c.seam;
  // the trowelled coat: dabs of mortar knocked down flat, so the tops are level and the gaps between them are rough.
  // The islands are a few centimetres across: from the road a rendered wall is a smooth plane of colour, and the
  // texture only appears within a few steps of it.
  vec2 sl; float h = planeRelief(c, 760.0, 0, sl);
  float lo = 0.26, hi = 0.7, top = smoothstep(lo, hi, h), dTop = 6.0 * (top - top * top) / (hi - lo);
  float valley = (1.0 - top) * tex;
  vec3 col = c.col;
  // repaint patches: rectangles of a slightly different batch of paint, with a brushed-out edge
  vec2 pid, pq; tilePattern(c.f.p + vec2(c.seed * 9.0, 0.0), 2.35, 0.0, c.f.px, pid, pq);
  vec3 ph = hash32(pid + c.seed * 173.0);
  vec2 pd = vec2(0.35 + 0.6 * ph.x, 0.25 + 0.5 * ph.y) - abs(pq - (ph.xy - 0.5) * 0.5);
  float repaint = step(ph.z, 0.1 + 0.3 * age) * smoothstep(0.0, 0.06, min(pd.x, pd.y) + (mid.r - 0.5) * 0.09) * c.seam;
  col = mix(col, mix(col, vec3(luma(col)) * 1.08, 0.22) * (0.97 + 0.12 * ph.x), repaint * 0.85);
  // sun fade and the slow tonal drift of an old wall
  float fade = age * (0.65 + 0.35 * big.r + 0.5 * drift.x) * saturate(0.6 + 0.4 * s.N.y);
  col = mix(col, mix(vec3(luma(col)), vec3(0.82), 0.45), fade * 0.42);
  // the valley term is centred on its mean so the wall keeps its tone when the relief fades with distance
  col *= 1.0 + drift.y * 0.07 + (blot.r - 0.5) * 0.08 * (0.4 + age) + (sand.b - 0.5) * 0.07 * near - (valley - 0.48 * tex) * (0.05 + 0.07 * age) * meso;
  // cracks: fine dark lines where the render has moved over the block joints behind it
  float crack = hairCracks(c, 3.1, 0.12 + 0.55 * age);
  col = mix(col, col * 0.3, crack * 0.85);
  // run-off, splash, mildew, salt
  float streak = dirtStreaks(c.f) * c.upright * (0.25 + 0.75 * age), grime = baseGrime(c, mid.g), cav = cavityDirt(s.occ, mid.r);
  float dirt = saturate(streak * 0.5 + grime * (0.3 + 0.5 * age) + cav * (0.35 + 0.4 * age));
  col = mix(col, col * vec3(0.36, 0.33, 0.28) + 0.01, dirt * (0.75 + 0.25 * valley));
  float mildew = saturate(grime * 1.2 + cav * 0.8 + streak * 0.4) * age * smoothstep(0.5, 0.78, blot.g + (mid.g - 0.5) * 0.5);
  col = mix(col, vec3(0.045, 0.055, 0.04), mildew * 0.75);
  float band = smoothstep(0.1, 0.45, c.hgt) * (1.0 - smoothstep(0.5, 1.3, c.hgt + (mid.r - 0.5) * 0.6)) * c.wall;
  col = mix(col, vec3(0.8, 0.79, 0.76), band * age * smoothstep(0.45, 0.85, blot.r * 0.6 + mid.g * 0.4) * 0.3);   // salt left by evaporating splash
  o.albedo = col;
  // masonry paint is flat but not dead: fresh patches and floated tops are smoother, chalk, dirt and growth duller
  o.rough = clamp(0.86 + 0.08 * drift.x + 0.07 * (blot.g - 0.5) - 0.14 * repaint + 0.1 * fade + 0.08 * dirt + 0.06 * mildew
    - 0.1 * (top - 0.52) * tex * meso + 0.08 * (sand.g - 0.5) * near, 0.55, 1.0);
  // 760 texels per metre and about 1.2 mm of relief: slope = dh/dtexel * texels per metre * depth
  o.N = slopeNormal(o.N, c.f, sl * dTop * (760.0 * 0.0012) * (0.12 + 0.88 * tex) * meso);
  o.N = grainNormal(o.N, g, (0.06 + 0.1 * tex * (1.0 - top)) * near);
  o.ao *= (1.0 - 0.22 * valley * meso) * (1.0 - 0.45 * crack) * (1.0 - 0.25 * cav);
  applyWetness(o, s.N, 0.6, c.expo);
}

// ---------------------------------------------------------------- ROCK
// p0 scale (64 = 1: features about 0.5 m), p1 wet line in dm above sea level, p2 seed. Weathered limestone and
// coral rock: bedding, pitting, fracture lines; below the wet line a dark algae band with barnacles.
void matRock(SurfIn s, inout SurfOut o, Ctx c) {
  float scale = s.mat.y > 0.5 ? s.mat.y / 64.0 : 1.0, wetLine = s.mat.z * 0.1;
  vec3 g, g2, g3; vec2 sA, sB;
  vec4 big = solidNoise(c, 9.0 / scale, g), mid = solidNoise(c, 150.0 / scale, g2), fine = solidNoise(c, 1300.0, g3);
  float near = detailFade(c, 0.005), meso = detailFade(c, 0.03 * scale);
  // Stone carries its contrast in structure (fracture faces, beds, holes, crust) and in grain, not in soft patches:
  // the slow field only leans the tone a few percent, otherwise a large face turns into drifting cloud.
  // Fractures are the mid-level contour of two noise fields: closed wandering lines that split the face into
  // blocks. Dividing by the slope turns the level difference into metres, so a crack keeps its width.
  float kA = 22.0 / scale, kB = 95.0 / scale;
  float rA = planeRelief(c, kA, 0, sA) - 0.5, rB = planeRelief(c, kB, 1, sB) - 0.5;
  float mA = max(length(sA) * kA, 0.25 / scale), mB = max(length(sB) * kB, 1.0 / scale);
  float cracks = max(aaline(rA / mA, 0.0035 * scale, c.f.px), 0.7 * aaline(rB / mB, 0.0012 * scale, c.f.px)) * c.seam;
  // each side of a fracture is a face of its own: it weathered for a different time and leans a different way
  float faceA = (saturate(rA / (mA * max(c.f.px, 0.004)) + 0.5) - 0.5) * c.seam, faceB = (saturate(rB / (mB * max(c.f.px, 0.002)) + 0.5) - 0.5) * c.seam;
  float bed = noiseTexGrad(vec2(c.lp.y * 55.0 / scale + rA * 7.0, c.seed * 255.0), vec2(c.dlx.y, 0.0) * 55.0 / scale, vec2(c.dly.y, 0.0) * 55.0 / scale).r;
  float soft = saturate(0.5 * bed + 0.5 * big.g + faceB * 0.3);
  // solution holes sit in the softer beds, pores everywhere; both are the cell centres of the noise texture
  float holes = (1.0 - smoothstep(0.05, 0.11 + 0.1 * soft, mid.a)) * smoothstep(0.42, 0.7, soft) * meso;
  float pores = (1.0 - smoothstep(0.03, 0.14, fine.a)) * near;
  vec3 col = c.col * (0.96 + 0.06 * (big.r - 0.5) + 0.08 * (bed - 0.5) + 0.09 * faceA + 0.06 * faceB);
  col = mix(col, col * vec3(1.06, 0.97, 0.84), saturate(bed * 1.6 - 0.5) * 0.35);                // iron-stained beds
  col *= 1.0 + (fine.r - 0.5) * 0.16 * near + (mid.r - 0.5) * 0.07 * meso;
  col = mix(col, min(col * 1.3, vec3(0.8)), step(0.93, fine.b) * near * 0.5);                    // shell and calcite flecks
  // Weathering crust: the grey-black film of algae and soot that limestone grows wherever rain reaches it, heaviest
  // on faces open to the sky and down the paths water takes. It is broken at grain scale, so close up it reads as
  // speckle and from across the street as one even darkening.
  float top = saturate(s.N.y * 1.4), run = dirtStreaks(c.f) * c.upright;
  float speck = mix(0.5, 0.35 * mid.g + 0.65 * fine.g, near);
  float crust = saturate(0.2 + 0.2 * top + 0.5 * run + 0.22 * faceA + (0.5 - speck) * 1.3) * (0.4 + 0.6 * c.expo);
  col = mix(col, mix(col * 0.4, vec3(0.17, 0.175, 0.165), 0.5), crust * 0.65);
  col *= 1.0 - 0.55 * holes - 0.35 * pores - 0.75 * cracks;
  float wetBand = 0.0;
  if (wetLine > 0.0) {
    float h = s.wpos.y + rA * 0.25;
    wetBand = 1.0 - smoothstep(wetLine - 0.12, wetLine + 0.05, h);
    float algae = wetBand * (0.6 + 0.4 * mid.r);
    col = mix(col, vec3(0.035, 0.05, 0.022), algae * 0.85);
    // barnacle crust just under the line
    float barnacles = smoothstep(wetLine - 0.75, wetLine - 0.3, h) * wetBand * (1.0 - smoothstep(0.12, 0.3, mid.a)) * near;
    col = mix(col, vec3(0.55, 0.53, 0.47), barnacles * 0.8);
  }
  o.albedo = col;
  o.rough = mix(clamp(0.8 + 0.14 * crust + 0.08 * (bed - 0.5) + 0.1 * (fine.g - 0.5) * near, 0.0, 1.0), 0.35, wetBand * 0.8);
  o.coat = wetBand * 0.5; o.coatRough = 0.12;
  // the fracture faces tilt away from each crack (a V in section), the undulation of the whole face stays gentle
  vec2 tilt = (sign(rA) * sA * 4.0 + sign(rB) * sB * 2.2 * meso) * c.seam;
  o.N = slopeNormal(o.N, c.f, tilt / max(1.0, length(tilt) / 0.55));
  o.N = grainNormal(o.N, g, 0.1);
  o.N = grainNormal(o.N, g2, 0.4 * meso);
  o.N = grainNormal(o.N, g3, 0.25 * near);
  o.ao *= 1.0 - 0.55 * cracks - 0.45 * holes - 0.2 * pores;
  applyWetness(o, s.N, 0.7, c.expo);
}
`;

const METALS = /* glsl */`
// ---------------------------------------------------------------- METAL_PAINTED
// p0 roughness, p1 rust amount. Enamel on steel: rust breaks through from edges, low points and scratches,
// lifts the paint around it into blisters and runs down the face below.
void matMetalPainted(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.08), rust = s.mat.z / 255.0;
  vec3 g, g2; vec4 fine = solidNoise(c, 2500.0, g), mid = solidNoise(c, 240.0, g2), big = planeNoise(c, 17.0);
  float edge = smoothstep(0.5, 1.5, c.curv * 0.05), low = baseGrime(c, mid.g);
  // the fine grain only frays the edge of a rust blotch up close: from the kerb a blotch is one ragged patch, not
  // a sprinkle of flecks, and its run-off hangs below it rather than dashing the whole face
  float coarse = 0.58 * big.r + 0.27 * mid.r, field = coarse + 0.15 * mix(0.5, fine.g, detailFade(c, 0.006));
  float thr = 1.04 - rust * 0.42 - edge * (0.1 + 0.4 * rust) - low * 0.4 * rust, soft = 0.012 + c.f.px * 12.0;
  float eaten = smoothstep(thr, thr + soft, field), blister = smoothstep(thr - 0.09, thr, field) * (1.0 - eaten);
  float run = dirtStreaks(c.f) * c.upright * rust * smoothstep(thr - 0.3, thr - 0.05, coarse + 0.075);
  vec2 drift = slowDrift(c);
  vec3 col = c.col * (1.0 + (big.g - 0.5) * 0.06 + drift.y * 0.06);
  float chalk = rust * saturate(0.5 + 0.5 * s.N.y) * (1.0 + 0.6 * drift.x);                                 // top faces chalk in the sun
  col = mix(col, mix(vec3(luma(col)), vec3(0.8), 0.3), chalk * 0.25);
  col = mix(col, col * vec3(0.6, 0.4, 0.26), saturate(run * 0.8 + blister * 0.3));
  float dirt = saturate(cavityDirt(s.occ, mid.r) * 0.5 + low * 0.45);
  col = mix(col, col * vec3(0.33, 0.3, 0.26), dirt);
  vec3 rustCol = mix(vec3(0.06, 0.026, 0.014), vec3(0.16, 0.07, 0.03), fine.r) * (0.7 + 0.6 * mid.g);
  o.albedo = mix(col, rustCol, eaten);
  // enamel loses its gloss unevenly: by the metre where the sun and the spray gun differed, by the millimetre in its orange peel
  float sheen = clamp(rough + 0.3 * chalk + (big.r - 0.5) * 0.1 + (fine.g - 0.5) * 0.06 * detailFade(c, 0.003) + 0.25 * blister, 0.08, 1.0);
  o.rough = mix(mix(sheen, 0.85, dirt), 0.96, eaten);
  o.N = grainNormal(o.N, g, 0.02 + 0.3 * eaten);
  o.N = grainNormal(o.N, g2, 0.7 * blister * detailFade(c, 0.012));
  beadWater(s, o, c, smoothstep(0.7, 0.3, o.rough) * (1.0 - eaten));
  applyWetness(o, s.N, 0.6 * eaten, c.expo);
}

// ---------------------------------------------------------------- METAL_BARE
// p0 roughness, p1 kind: 0 chrome, 1 aluminium, 2 galvanised steel, 3 brass, 4 brushed stainless, 5 turned
// stainless (the only kind with a uv). Colour multiplies the metal's own reflectance (white = the pure metal).
void matMetalBare(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.03); int kind = int(s.mat.z + 0.5);
  vec3 g, g2; vec4 fine = solidNoise(c, 2600.0, g), mid = solidNoise(c, 150.0, g2), big = planeNoise(c, 11.0);
  float near = detailFade(c, 0.004), cav = cavityDirt(s.occ, mid.r);
  o.metal = 1.0;
  if (kind == 0) {
    // chrome plate: a mirror with wipe marks, and pin-point pitting where salt air got under the plating
    float pit = (1.0 - smoothstep(0.03, 0.09, fine.a)) * smoothstep(0.62, 0.8, mid.g) * near;
    o.albedo = mix(vec3(0.8, 0.81, 0.83), vec3(0.2, 0.09, 0.04), pit) * c.col;
    o.rough = mix(rough + 0.035 * big.r, 0.8, pit);
    o.metal = 1.0 - pit;
    o.N = grainNormal(o.N, g, 0.006);
  } else if (kind == 1) {
    // mill-finish aluminium: brushed along the extrusion, with a chalky oxide bloom
    vec2 along = c.upright > 0.5 ? vec2(2200.0, 35.0) : vec2(35.0, 2200.0);
    vec4 brush = planeNoise(c, along);
    float oxide = smoothstep(0.3, 1.0, big.r * 0.7 + mid.r * 0.3), pit = (1.0 - smoothstep(0.04, 0.1, fine.a)) * oxide * near;
    o.albedo = (vec3(0.83, 0.84, 0.85) * (0.9 + 0.2 * (brush.r - 0.5) * near) + oxide * 0.02) * c.col;
    o.albedo = mix(o.albedo, vec3(0.78, 0.78, 0.76), pit * 0.8);
    // on a mirror-like metal a small change of roughness is a large change of brightness: keep the bloom faint
    o.rough = max(rough, 0.28) + 0.035 * oxide + 0.1 * (brush.g - 0.5) * near;
    // metalness stays put under the bloom: off the highlight a metal is nearly black, so even a few percent of
    // diffuse would print the oxide pattern as bright clouds
    o.metal = 1.0 - 0.5 * pit;
    o.N = grainNormal(o.N, vec3(brush.r - 0.5, brush.g - 0.5, brush.r - 0.5), 0.03 * near);
  } else if (kind == 2) {
    // hot-dip galvanised: zinc crystals (spangle) of different brightness, dulling to grey with white rust blotches
    // Weathered spangle is two-centimetre crystals a couple of percent apart in tone and barely apart in gloss:
    // with the street mirrored in it any more reads as salt and pepper. White rust follows the run-off and the
    // grain as a linear haze: thresholded into islands it printed pale blotches on every flat sheet.
    float crystals = detailFade(c, 0.012); vec2 sp = vec2(0.5, 0.5);
    if (crystals > 0.0) sp = voronoi(c.f.p * 52.0 + c.so);
    float tone = mix(0.5, sp.y, crystals), white = saturate((0.6 * mid.g + 0.4 * fine.g - 0.3) * 0.45 + dirtStreaks(c.f) * c.upright * 0.6);
    o.albedo = mix(vec3(0.6, 0.62, 0.64) * (0.965 + 0.07 * tone + 0.05 * (big.g - 0.5)), vec3(0.7, 0.71, 0.7), white * 0.3) * c.col;
    o.rough = max(rough, 0.34) + 0.04 * (tone - 0.5) + 0.1 * white + 0.06 * (big.r - 0.5);
    // Weathered zinc wears a matt carbonate crust, which is a dielectric: a dull pole or rail is lit like grey
    // paint by the sun, where bare metal would only mirror whatever faces it (a flat rail showed black asphalt).
    o.metal = 0.9 - 0.6 * saturate(smoothstep(0.36, 0.72, rough) + 0.35 * white);
    o.N = grainNormal(o.N, g, 0.02 + 0.03 * white);
  } else if (kind >= 4) {
    // Stainless steel with a directional finish: 4 brushed along the frame's first axis, 5 turned on a lathe
    // (uv = angle in radians, metres across the grain: a whole number of noise tiles per turn closes the grain).
    // The lighting has one roughness for all directions, so the finish is written as slopes across the grain
    // only. They draw a highlight out at right angles to the scratches, which is how the eye knows the finish.
    // Brush marks run out after a hand's length; the feed marks of a lathe are whole circles, with a finer
    // broken grain over them.
    vec4 brush = planeNoise(c, vec2(kind == 4 ? 35.0 : 0.0, 2600.0)), hair = planeNoise(c, vec2(kind == 4 ? 105.0 : 81.4874, 9400.0));
    // A mirror metal turns each mark's tilt into a jump in what it reflects, far larger than the mark itself when
    // seen at a low angle. So the marks are drawn only while each covers several pixels across the grain; below
    // that they are what they physically are at that range, roughness.
    float acr = max(abs(c.f.dx.y), abs(c.f.dy.y)), coarse = 1.0 - smoothstep(0.0008, 0.003, acr);
    o.albedo = vec3(0.64, 0.62, 0.59) * (0.93 + 0.14 * (brush.g - 0.5) * coarse) * c.col;
    // wiped by hand: the smears are a few percent of roughness, which on a mirror metal is plain to see.
    // Scratches too small for a pixel still scatter the light, so their loss is paid back as roughness.
    o.rough = max(rough, 0.22) + 0.07 * (mid.g - 0.5) + 0.08 * (brush.g - 0.5) * coarse + 0.07 * (1.0 - coarse);
    o.N = slopeNormal(o.N, c.f, vec2(0.0, (brush.r - 0.5) * 0.14 * coarse + (hair.r - 0.5) * 0.06 * (1.0 - smoothstep(0.0003, 0.001, acr))));
  } else {
    // brass: polished where hands and edges rub it, brown tarnish in the recesses, a trace of verdigris in corners
    float tarnish = saturate(0.1 + 0.08 * (big.r - 0.5) + smoothstep(0.35, 0.95, 0.5 * mid.r + 0.5 * fine.r) * 0.25 + cav * 0.9 - smoothstep(0.5, 1.5, c.curv * 0.05));
    o.albedo = mix(vec3(0.84, 0.67, 0.33), vec3(0.42, 0.28, 0.11), tarnish) * c.col;
    o.albedo = mix(o.albedo, vec3(0.2, 0.42, 0.34), cav * smoothstep(0.6, 0.85, fine.g) * 0.6);
    o.rough = mix(rough, max(rough, 0.5), tarnish * tarnish);
    o.metal = 1.0 - 0.2 * cav;
    o.N = grainNormal(o.N, g, 0.012);
  }
  o.albedo = mix(o.albedo, o.albedo * vec3(0.3, 0.28, 0.25), cav * 0.6);
  o.rough = saturate(mix(o.rough, 0.8, cav * 0.6));
  beadWater(s, o, c, 1.0 - smoothstep(0.3, 0.7, o.rough));
  applyWetness(o, s.N, 0.0, c.expo);
}

// ---------------------------------------------------------------- PLASTIC
// p0 roughness. Moulded plastic: faint moulding texture, chalky sun fade on top, scuffs, dust in the corners.
void matPlastic(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.06);
  vec3 g, g2; vec4 fine = solidNoise(c, 3000.0, g), mid = solidNoise(c, 130.0, g2);
  float sun = saturate(s.N.y) * (0.8 + 0.2 * mid.r), cav = cavityDirt(s.occ, mid.g), low = baseGrime(c, mid.g);
  // scuffs: short pale scratches, all roughly along one direction per object
  vec4 sc = planeNoise(c, vec2(60.0, 1700.0));
  float scuff = smoothstep(0.8, 0.95, sc.r * 0.7 + mid.r * 0.3) * detailFade(c, 0.003);
  vec3 col = mix(c.col, mix(vec3(luma(c.col)), vec3(0.85), 0.5), sun * 0.3 + scuff * 0.3) * (1.0 + (mid.g - 0.5) * 0.05);
  float dirt = saturate(cav * 0.6 + low * 0.4);
  o.albedo = mix(col, col * vec3(0.3, 0.28, 0.24) + 0.01, dirt);
  // handled and wiped patches keep their shine, the rest dulls with dust
  o.rough = saturate(rough + 0.3 * sun + 0.3 * scuff + 0.4 * dirt + (mid.r - 0.5) * 0.14 + (fine.g - 0.5) * 0.05 * detailFade(c, 0.003));
  o.N = grainNormal(o.N, g, 0.018);
  o.ao *= 1.0 - 0.25 * cav;
  beadWater(s, o, c, smoothstep(0.75, 0.3, o.rough));
  applyWetness(o, s.N, 0.0, c.expo);
}

// ---------------------------------------------------------------- RUBBER
// p0 roughness, p1 moulded pattern: 0 plain, 1 fine ribs (6 mm pitch), 2 broad flat ribs (25 mm), 3 coin studs
// (28 mm). Black to coloured rubber: matt, slightly pitted, grey bloom and dust where it is not flexed. The pattern
// lies in the dominant local plane with the ribs along its first axis; dust settles in the grooves and the tops
// are rubbed smooth.
void matRubber(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.35); int pat = int(s.mat.z + 0.5);
  vec3 g, g2; vec4 fine = solidNoise(c, 2200.0, g), mid = solidNoise(c, 120.0, g2);
  // a moulded mat is one large flat sheet: the mottled bloom that suits a tyre or a hose would blotch it
  float bloom = mid.r * (pat == 0 ? 0.25 : 0.07) + cavityDirt(s.occ, mid.g) * 0.6 + baseGrime(c, mid.g) * 0.4;
  // top = 1 on the raised part; low = how much of this pixel is groove (its average once the pattern is sub-pixel)
  float top = 1.0, low = 0.0, relief = 0.0; vec2 slope = vec2(0.0);
  if (pat == 1 || pat == 2) {
    float pitch = pat == 1 ? 0.006 : 0.025, flat0 = pat == 1 ? 0.15 : 0.5, flat1 = pat == 1 ? 0.85 : 0.76, depth = pat == 1 ? 0.0008 : 0.002;
    float x = fract(c.f.p.y / pitch) - 0.5, t = saturate((2.0 * abs(x) - flat0) / (flat1 - flat0));
    relief = detailFade(c, 0.5 * pitch) * c.seam;
    top = 1.0 - t * t * (3.0 - 2.0 * t); low = mix(pat == 1 ? 0.5 : 0.37, 1.0 - top, relief);
    slope.y = -depth * 6.0 * t * (1.0 - t) / (flat1 - flat0) * 2.0 * sign(x) / pitch;
  } else if (pat == 3) {
    vec2 id, q; tilePattern(c.f.p, 0.028, 0.0, c.f.px, id, q);
    float r = length(q), t = saturate((r - 0.0092) / 0.0022);
    relief = detailFade(c, 0.012) * c.seam;
    top = 1.0 - t * t * (3.0 - 2.0 * t); low = mix(0.6, 1.0 - top, relief);
    slope = -0.0012 * 6.0 * t * (1.0 - t) / 0.0022 * q / max(r, 1e-5);
  }
  o.albedo = mix(c.col * (0.92 + 0.16 * fine.r), vec3(0.2, 0.19, 0.175), saturate(bloom) * 0.45 + low * (0.12 + 0.3 * saturate(bloom)));
  o.rough = saturate(rough + 0.15 * bloom + 0.1 * low - 0.12 * top * relief);
  o.N = slopeNormal(o.N, c.f, slope * relief);
  o.N = grainNormal(o.N, g, 0.06 * detailFade(c, 0.004));
  o.ao *= 1.0 - 0.35 * (1.0 - top) * relief;
  applyWetness(o, s.N, 0.25, c.expo);
}

// ---------------------------------------------------------------- DARK_GLASS
// p0 roughness, p1 tint strength. Opaque stand-in for glazing: a dark body under a mirror-sharp coat. More tint
// means a more reflective, more coloured film (the bronze and blue mirror glass of the period).
void matDarkGlass(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.02), tint = s.mat.z / 255.0;
  vec4 wave = planeNoise(c, 4.5), dust = planeNoise(c, 13.0), speck = planeNoise(c, 900.0);
  float film = saturate(0.14 * dust.r + cavityDirt(s.occ, dust.g) * 0.7 + baseGrime(c, dust.g) * 0.5);
  // dried drops: rings of dust left where earlier rain evaporated
  float spots = (1.0 - smoothstep(0.1, 0.2, speck.a)) * smoothstep(0.4, 1.0, dust.g) * detailFade(c, 0.004);
  vec3 body = mix(vec3(0.045, 0.05, 0.055), c.col * 0.55, tint);
  o.albedo = mix(body, vec3(0.3, 0.28, 0.25), film * 0.5 + spots * 0.12);
  o.metal = (0.55 + 0.4 * tint) * (1.0 - film * 0.6);
  o.rough = saturate(rough + 0.35 * film + 0.2 * spots);
  o.coat = 1.0; o.coatRough = saturate(rough + 0.25 * film);
  // float glass is never flat: a slow ripple makes reflections wander from pane to pane
  o.N = slopeNormal(o.N, c.f, (wave.rg - 0.5) * 0.02);
  o.wet = 1.0 - film;
  beadWater(s, o, c, 1.0);
}
`;

const LIGHTS = /* glsl */`
// ---------------------------------------------------------------- EMISSIVE
// p0 intensity code, p1 channel. A plain diffuser panel: glows in its colour when the channel is on,
// reads as milky plastic of that colour when it is off.
void matEmissive(SurfIn s, inout SurfOut o, Ctx c) {
  float level = channelLevel(s.mat.z, c.seed);
  o.albedo = mix(vec3(0.5), c.col, 0.6) * 0.75;
  o.rough = 0.35;
  o.emissive = c.col * radianceCode(s.mat.y) * level;
}

// ---------------------------------------------------------------- SIGN
// uv = atlas coordinates. p0: 0 painted face (opaque), 1 decal (atlas mask = paint coverage over the vertex
// colour), 2..255 internally lit with that intensity code and the atlas mask as the lit mask. p1 channel,
// p2 roughness. The mask is stored in alpha as 0.25 + 0.75 * mask, because a 2D canvas cannot keep colour
// under zero alpha. Lit faces are even, like acrylic in front of fluorescent tubes: the tubes show only as a very
// soft banding, and the unlit parts of the face stay dark.
void matSign(SurfIn s, inout SurfOut o, Ctx c, vec4 face) {
  float code = s.mat.y, rough = max(s.mat.w / 255.0, 0.08);
  vec4 dust = planeNoise(c, 12.0);
  float film = saturate(0.1 * dust.r + cavityDirt(s.occ, dust.g) * 0.5 + dirtStreaks(c.f) * c.upright * 0.25);
  float mask = saturate(face.a * (4.0 / 3.0) - (1.0 / 3.0));
  if (code > 0.5 && code < 1.5) {
    // painted straight onto the surface behind it: the paint wears thin with the surface
    vec4 wear = planeNoise(c, 600.0);
    float cover = mask * smoothstep(0.08, 0.3, wear.r + 0.25) * (0.86 + 0.14 * wear.g);
    o.albedo = mix(c.col, face.rgb, cover);
    o.rough = mix(0.85, rough, cover);
    o.albedo = mix(o.albedo, o.albedo * vec3(0.4, 0.37, 0.32), film);
    applyWetness(o, s.N, 0.4, c.expo);
    return;
  }
  vec3 col = face.rgb * c.col;
  o.albedo = mix(col, col * vec3(0.45, 0.42, 0.37) + 0.015, film);
  o.rough = saturate(rough + 0.35 * film);
  if (code > 1.5) {
    float level = channelLevel(s.mat.z, c.seed);
    float tubes = 0.94 + 0.06 * cos(c.f.p.y * 21.0 + c.seed * 40.0);
    // keep a little of the hue of even the palest letters so a lit face never clips to blank white
    o.emissive = (col * 0.92 + 0.08 * luma(col)) * (radianceCode(code) * level * tubes * mix(0.02, 1.0, mask) * (1.0 - 0.5 * film));
    o.coat = 0.6; o.coatRough = 0.08;
  }
  beadWater(s, o, c, smoothstep(0.7, 0.3, o.rough));
  applyWetness(o, s.N, 0.0, c.expo);
}

// ---------------------------------------------------------------- NEON
// p0 intensity code (0 = dead tube), p1 channel, uv.x = metres along the tube. The geometry is a round glass tube.
// Lit: saturated gas colour across the tube with a near-white core only along its centre line as seen from the
// camera. Unlit: pale coated glass with a hint of the gas colour.
void matNeon(SurfIn s, inout SurfOut o, Ctx c) {
  float level = s.mat.y > 0.5 ? channelLevel(s.mat.z, c.seed) : 0.0;
  float peak = max(max(c.col.r, c.col.g), c.col.b); vec3 hue = c.col / max(peak, 1e-3);
  // The hot centre line has to stay in the middle of the tube when it is seen along its length, so measure the
  // facing angle within the tube's cross-section. The axis is the one direction in which the normal does not turn.
  vec3 dn = dFdx(s.N), dm = dFdy(s.N); if (dot(dm, dm) > dot(dn, dn)) dn = dm;
  float across = 1.0;
  if (dot(dn, dn) > 1e-10) { float va = dot(s.V, normalize(cross(s.N, dn))); across = sqrt(max(1.0 - va * va, 1e-3)); }
  float nv = saturate(dot(s.N, s.V) / across);
  // Unlit, the tube is milky glass: light scatters through it, so its shaded side never goes as dark as an opaque
  // rod would (the shading normal is pulled towards the eye) and it reads as a pale line on the wall by day.
  o.albedo = mix(vec3(0.76, 0.77, 0.78), hue, 0.14);
  o.N = normalize(o.N + s.V * 0.7);
  o.rough = 0.16; o.coat = 1.0; o.coatRough = 0.05;
  // across the tube: the discharge is deepest in the middle, so that is where it burns towards white
  float core = smoothstep(0.86, 1.0, nv);
  vec3 glow = mix(hue * hue * (0.55 + 0.45 * nv), mix(hue, vec3(1.0), 0.72), core * core);
  // The white core is a fifth of the tube's width. Until the tube is several pixels across, a pixel either lands
  // on the core or misses it and a sloping run turns into a string of white and coloured dashes, so a narrow tube
  // shows the average of its cross-section instead. A tube widened to stay visible (see neonWiden) is dimmed by
  // the widening.
  float wide = NEON_RADIUS + neonWiden(s.dist, s.mat), thin = NEON_RADIUS / wide;
  float resolved = smoothstep(2.5, 7.0, 2.0 * wide / neonPixel(s.dist));
  glow = mix(mix(hue * hue * 0.85, mix(hue, vec3(1.0), 0.72), 0.14), glow, resolved) * thin;
  o.emissive = glow * radianceCode(s.mat.y) * level * peak;
  // a lit tube hides its own glass
  o.albedo *= 1.0 - 0.8 * level;
}

// ---------------------------------------------------------------- LAMP_LENS
// p0 intensity code (0 = never lit: signal and reflector lenses), p1 channel. A moulded refractor: ribbed glass
// by day, a glowing body with a hotter centre when its channel is on. Discharge lamps strike pink and warm up.
void matLampLens(SurfIn s, inout SurfOut o, Ctx c) {
  float level = s.mat.y > 0.5 ? channelLevel(s.mat.z, c.seed) : 0.0;
  float nv = saturate(dot(s.N, s.V)), ribs = detailFade(c, 0.0028);
  // prisms: ribs 6 mm apart running around the lens
  float coord = (c.upright > 0.5 ? c.f.p.y : c.f.p.x) / 0.006, ph = coord - floor(coord);
  vec2 slope = (c.upright > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) * ((ph - 0.5) * 1.1 * ribs);
  vec4 dust = planeNoise(c, 16.0);
  float film = saturate(0.12 * dust.r + saturate(s.N.y) * 0.35 + cavityDirt(s.occ, dust.g) * 0.5);
  bool signal = s.mat.y < 0.5;
  vec3 glass = signal ? c.col * 0.3 + 0.01 : mix(vec3(0.6), c.col, 0.3) * 0.62;
  o.albedo = mix(glass, vec3(0.3, 0.28, 0.25), film * 0.5);
  o.rough = 0.14 + 0.4 * film; o.coat = 1.0; o.coatRough = 0.05 + 0.2 * film;
  o.N = slopeNormal(o.N, c.f, slope);
  if (level > 0.0) {
    vec3 hot = mix(vec3(1.0, 0.36, 0.3) * 0.3, c.col, smoothstep(0.1, 0.9, level));
    float body = (0.62 + 0.38 * nv * nv) * (1.0 + 0.12 * (0.5 - abs(ph - 0.5)) * ribs);
    o.emissive = hot * radianceCode(s.mat.y) * level * body * (1.0 - 0.3 * film);
  }
  beadWater(s, o, c, 1.0 - film);
}
`;

const ORGANIC = /* glsl */`
// ---------------------------------------------------------------- WOOD
// uv.x along the grain in metres; boards 0.14 m wide across uv.y. p0 roughness, p1 weathering.
// Growth rings cut by the saw, knots that bend them, pores along the grain; weathering silvers the surface,
// opens checks along the grain and rusts the nails at the board ends.
void matWood(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.2), age = s.mat.z / 255.0, px = c.f.px;
  vec2 id, q; float gap = plankPattern(c.f.p, 0.14, 2.6, 0.003 + 0.005 * age, px, id, q);
  vec3 ph = hash32(id + c.seed * 61.0);
  vec2 gp = vec2(c.f.p.x + ph.x * 37.0, q.y + ph.y * 3.0), kw = vec2(11.0, 70.0), kf = vec2(38.0, 3100.0);
  vec4 warp = noiseTexGrad(gp * kw, c.f.dx * kw, c.f.dy * kw), pore = noiseTexGrad(gp * kf, c.f.dx * kf, c.f.dy * kf);
  // one knot in some boards
  vec2 kd = (q - vec2((ph.x - 0.5) * 1.9, (ph.y - 0.5) * 0.07)) * vec2(0.55, 1.0); float kr = 0.011 + 0.012 * ph.z;
  float kn = ph.z < 0.42 ? length(kd) / kr : 9.0, knot = 1.0 - smoothstep(0.7, 1.15, kn);
  // ring coordinate across the board; the figure widens and narrows along it and wraps around the knot
  float density = 70.0 + 80.0 * ph.z, ring = q.y * density + (warp.r - 0.5) * 11.0 + 5.0 * exp(-kn * kn * 0.18) + kn * knot * 3.0;
  float rw = px * density * 1.6, late = 0.5 - 0.5 * cos(TAU * ring) * (1.0 - smoothstep(0.25, 0.8, rw));
  float fibre = (pore.r - 0.5) * detailFade(c, 0.0012);
  vec3 col = c.col * (0.84 + 0.3 * ph.y) * mix(1.0, 0.66, late * late) * (1.0 + 0.22 * fibre);
  col = mix(col, c.col * vec3(0.3, 0.2, 0.13), knot * 0.85);
  // weathering: grey from the top fibres down, more on the early wood
  vec2 drift = slowDrift(c);
  float grey = age * saturate(0.55 + 0.6 * warp.g - 0.3 * late + 0.5 * drift.x) * (0.6 + 0.4 * c.expo);
  col = mix(col, vec3(0.34, 0.335, 0.32) * (0.75 + 0.5 * ph.y) * (1.0 - 0.3 * late), grey);
  // checks: splits that open along the grain as it dries
  float check = smoothstep(0.93 - 0.2 * age, 0.97 - 0.2 * age, pore.g * 0.7 + warp.r * 0.3) * detailFade(c, 0.002);
  // nails: two at each end of a board, each with a rust bloom
  vec2 nq = vec2(1.3 - 0.035 - abs(q.x), abs(q.y) - 0.04); float nd = length(nq);
  float nail = aastep(nd, 0.0035, px), bloom = (1.0 - smoothstep(0.004, 0.03, nd)) * age;
  col = mix(col, col * vec3(0.55, 0.33, 0.2), bloom * 0.7);
  col = mix(col, vec3(0.1, 0.085, 0.075), nail);
  float dark = saturate(gap + check * 0.8), cav = cavityDirt(s.occ, warp.g);
  // end-grain stain: boards soak water at the butt joints
  float soak = smoothstep(1.3 - 0.12 - 0.1 * warp.g, 1.3, abs(q.x)) * age;
  col = mix(col, col * vec3(0.4, 0.38, 0.34), saturate(soak * 0.6 + cav * 0.5));
  o.albedo = col * mix(1.0, 0.12, dark);
  // every board took its finish differently; the dense late wood stays smoother than the open early wood
  o.rough = saturate(mix(rough + (ph.y - 0.5) * 0.16 + drift.y * 0.08 - 0.1 * late, 0.92, grey) + 0.2 * dark + (pore.g - 0.5) * 0.08 * detailFade(c, 0.002));
  o.metal = nail * 0.8;
  // relief: late wood stands proud once the soft early wood has eroded; boards cup towards their edges
  float cup = smoothstep(0.045, 0.07, abs(q.y)) * sign(q.y) * 0.25;
  o.N = slopeNormal(o.N, c.f, vec2(0.0, sin(TAU * ring) * (0.05 + 0.3 * age) * (1.0 - smoothstep(0.2, 0.7, rw)) - cup));
  o.ao *= 1.0 - 0.6 * dark;
  standingWater(s, o, c, gap * 0.2);
  applyWetness(o, s.N, 0.8, c.expo);
}

// ---------------------------------------------------------------- TRUNK
// uv = (0..1 around, metres along the trunk from the ground). p0 species, p1 start of the species' upper zone in
// dm (0 = none), p2 seed. Colour is the base colour of whichever zone the vertex is in. Patterns repeat a whole
// number of times around the trunk so the uv seam never shows.
vec4 barkNoise(Ctx c, float around, float along) { vec2 k = vec2(256.0 * around, along); return noiseTexGrad(c.f.p * k + c.so, c.f.dx * k, c.f.dy * k); }

// Helical lattice shared by the fan palm's boots and the date palm's leaf-base diamonds.
// Returns cell-local coordinates: x across (-1..1), y up (-1..1); edge = 0 on the cell border, 1 at its centre.
vec3 trunkLattice(vec2 uv, float around, float perMetre, out vec2 cell) {
  float a = uv.x * around + uv.y * perMetre * 0.5, b = uv.x * around - uv.y * perMetre * 0.5;
  cell = vec2(floor(a), floor(b)); vec2 f = vec2(a, b) - cell;
  return vec3(f.x + f.y - 1.0, f.x - f.y, 1.0 - 2.0 * max(abs(f.x - 0.5), abs(f.y - 0.5)));
}

void matTrunk(SurfIn s, inout SurfOut o, Ctx c) {
  int species = int(s.mat.y + 0.5); float zone = s.mat.z * 0.1, u = c.f.p.x, v = c.f.p.y;
  float pv = max(abs(c.f.dx.y), abs(c.f.dy.y)), pu = max(abs(c.f.dx.x), abs(c.f.dy.x));
  float upper = zone > 0.0 ? aastep(zone, v, pv) : 0.0;
  vec4 fibre = barkNoise(c, 3.0, 34.0), blotch = barkNoise(c, 1.0, 190.0), fine = barkNoise(c, 12.0, 2500.0);
  vec3 col = c.col; vec2 slope = vec2(0.0); float rough = 0.9, pit = 0.0, lichenAmt = 0.5, coat = 0.0;

  if (species == 0) {
    // Coconut: leaf scars ring the trunk, about 10 cm apart at the swollen base and closing to 4.5 cm higher up;
    // they wander and tilt. Fine vertical cracks cross them. The base is a mat of dead roots.
    float rc = v / 0.045 - 30.5 * (1.0 - exp(-v / 2.5)) + (blotch.r - 0.5) * 0.35 + 0.25 * sin(TAU * u + c.seed * 40.0);
    float rw = (1.0 / 0.045 - 12.2 * exp(-v / 2.5)) * pv, k = fract(rc), keep = 1.0 - smoothstep(0.25, 0.9, rw);
    float scar = aaline(min(k, 1.0 - k), 0.09, rw) * keep;
    vec4 cr = barkNoise(c, 7.0, 21.0);
    float crack = aaline(cr.r - 0.5, 0.03, pu * 256.0 * 7.0 * 0.1 + pv * 2.0) * smoothstep(0.35, 0.65, blotch.g);
    col *= (0.8 + 0.3 * k * keep + 0.2 * (fibre.r - 0.5)) * (1.0 + 0.25 * (fine.r - 0.5));
    col = mix(col, col * vec3(1.12, 1.0, 0.84), smoothstep(0.4, 0.8, fibre.g) * 0.5);
    float roots = 1.0 - smoothstep(0.12, 0.5, v + (blotch.g - 0.5) * 0.2);
    col = mix(col, vec3(0.085, 0.06, 0.04) * (0.6 + 0.9 * fine.g), roots * 0.85);
    // under the crown the old fibre mat stains everything and the scars crowd together
    col *= mix(1.0, 0.8 + 0.5 * fibre.r, upper);
    pit = saturate(scar * 0.75 + crack * 0.7 + roots * fine.r * 0.5);
    slope = vec2((cr.r - 0.5) * 0.35, (k - 0.5) * 1.1 * keep + (fine.g - 0.5) * 0.4 * roots);
  } else if (species == 1) {
    // Royal: smooth as cast concrete, pale grey, widely spaced faint rings; algae creeps up from the ground.
    // The rings mark single leaves, so their spacing follows the years (it drifts by a third along the trunk) and
    // some are barely there: evenly ruled rings crossed by fibre lines would read as coursed masonry.
    float drift = noiseTexGrad(vec2(c.seed * 255.0, v * 10.0) + c.so, vec2(0.0, c.f.dx.y) * 10.0, vec2(0.0, c.f.dy.y) * 10.0).r;
    float rc = v / 0.17 + (drift - 0.5) * 3.0 + (blotch.r - 0.5) * 0.12, rw = pv / 0.17, k = fract(rc);
    float mark = 0.3 + 0.7 * hash11(floor(rc + 0.5) + c.seed * 97.0);
    float scar = aaline(min(k, 1.0 - k), 0.035, rw) * (1.0 - smoothstep(0.25, 0.9, rw)) * mark;
    col *= 0.93 + 0.04 * (fibre.r - 0.5) + 0.1 * (blotch.g - 0.5) + 0.06 * (fine.b - 0.5);
    col = mix(col, col * vec3(0.72, 0.8, 0.6), (1.0 - smoothstep(0.2, 2.2, v + (blotch.r - 0.5) * 1.2)) * 0.55);
    pit = scar * 0.3 * (1.0 - upper);
    slope = vec2(0.0, (k - 0.5) * 0.06 * mark * (1.0 - upper));
    rough = 0.82;
    if (upper > 0.0) {
      // crownshaft: waxy green leaf sheaths, finely striated, with a papery brown collar where the oldest is letting go
      float collar = 1.0 - smoothstep(0.03, 0.16, v - zone + (fibre.g - 0.5) * 0.12);
      vec3 shaft = c.col * (0.9 + 0.25 * (fibre.r - 0.5) + 0.12 * (fine.r - 0.5));
      shaft = mix(shaft, vec3(0.25, 0.17, 0.09) * (0.7 + 0.6 * fine.g), collar * 0.8);
      col = mix(col, shaft, upper); rough = mix(rough, mix(0.38, 0.8, collar), upper); coat = 0.35 * upper * (1.0 - collar);
      lichenAmt *= 1.0 - upper;
      pit += upper * collar * 0.3 * fine.r;
    }
  } else if (species == 2 || species == 3) {
    // Fan and date palms carry a helical lattice of old leaf bases.
    bool date = species == 3; vec2 cell; vec3 l = trunkLattice(c.f.p, date ? 10.0 : 9.0, date ? 10.0 : 5.0, cell);
    float lw = (pu * (date ? 10.0 : 9.0) + pv * (date ? 5.0 : 2.5)) * 2.0, keep = 1.0 - smoothstep(0.2, 0.8, lw);
    vec3 ch = hash32(cell + c.seed * 77.0);
    if (date) {
      // Date: diamond scars, each a stub that rises towards its upper end and finishes in a pale sawn face.
      float body = (1.0 - l.x * l.x) * smoothstep(-1.0, 0.5, l.y), groove = (1.0 - aastep(0.16, l.z, lw)) * keep;
      float cut = aastep(0.3, l.y, lw) * aastep(abs(l.x), 0.42, lw) * aastep(0.2, l.z, lw) * keep;
      col *= (0.62 + 0.5 * body * keep + 0.25 * (ch.x - 0.5) * keep) * (1.0 + 0.3 * (fine.r - 0.5));
      col = mix(col, vec3(0.3, 0.23, 0.15) * (0.7 + 0.6 * fine.b), cut * 0.45);
      // between the stubs: a brown felt of fibre
      col = mix(col, vec3(0.1, 0.07, 0.045) * (0.6 + 0.8 * fine.g), groove * 0.9);
      pit = groove * 0.8;
      slope = vec2(-1.3 * l.x * smoothstep(-1.0, 0.5, l.y), 0.75 * (1.0 - l.x * l.x) * (1.0 - cut) - 1.2 * cut) * keep * (0.7 + 0.5 * upper);
    } else {
      // Fan (cabbage) palm: below the zone line a close-ringed, fissured grey trunk; above it the criss-cross of
      // split leaf bases ("boots"), two families of straps woven over each other with dark diamonds between.
      float rc = v / 0.032 + (blotch.r - 0.5) * 0.8, rw = pv / 0.032, k = fract(rc), rkeep = 1.0 - smoothstep(0.25, 0.9, rw);
      vec4 cr = barkNoise(c, 6.0, 30.0);
      float fissure = aaline(cr.r - 0.5, 0.05, pu * 256.0 * 6.0 * 0.1 + pv * 3.0);
      vec3 bare = c.col * (0.82 + 0.25 * k * rkeep + 0.22 * (fibre.r - 0.5)) * (1.0 - 0.6 * fissure);
      vec2 bareSlope = vec2((cr.r - 0.5) * 0.8, (k - 0.5) * 0.7 * rkeep);
      // straps: distance from the centre line of each family, in units of the strap pitch
      vec2 lf = vec2(l.x + l.y, l.x - l.y) * 0.5;                       // back to the two lattice axes, -0.5..0.5
      float sa = abs(lf.x), sb = abs(lf.y), hw = 0.33;
      float ona = aastep(sa, hw, lw), onb = aastep(sb, hw, lw);
      bool aTop = mod(cell.x + cell.y, 2.0) < 0.5;
      float top = aTop ? ona : onb, under = (aTop ? onb : ona) * (1.0 - top);
      float across = aTop ? lf.x : lf.y, acrossU = aTop ? lf.y : lf.x;
      float prof = top * sqrt(max(1.0 - across * across / (hw * hw), 0.0)) + under * 0.55 * sqrt(max(1.0 - acrossU * acrossU / (hw * hw), 0.0));
      float hole = (1.0 - top) * (1.0 - under);
      vec3 boots = c.col * (0.55 + 0.6 * prof + 0.3 * (ch.x - 0.5)) * (1.0 + 0.35 * (fibre.r - 0.5) + 0.25 * (fine.r - 0.5));
      boots = mix(boots, vec3(0.05, 0.035, 0.022), hole * 0.92);
      // the strap's own direction on the trunk decides which way its rounded back tilts the normal
      vec2 dirA = normalize(vec2(1.0, 0.45)), dirB = normalize(vec2(1.0, -0.45));
      vec2 bootSlope = (top > 0.0 ? (aTop ? dirA : dirB) * across : (aTop ? dirB : dirA) * acrossU) * (-3.2 * (top + under * 0.6));
      col = mix(bare, mix(c.col * 0.72, boots, keep), upper);
      slope = mix(bareSlope, bootSlope * keep, upper);
      pit = mix(fissure * 0.7, hole * keep * 0.9, upper);
      lichenAmt *= 1.0 - 0.7 * upper;
    }
  } else {
    // Broadleaf: bark split into long plates by furrows that run with the limb, each plate cracked across into
    // blocks; moss on the weather side. Furrows are spaced in fractions of the girth and cracks in centimetres,
    // so both keep their width at any range.
    // Each furrow wanders on its own as it climbs (one line of the noise texture per furrow), never far enough to
    // cross its neighbour.
    float n = 14.0, q = u * n, id = floor(q), fq = q - id, col1 = mod(id, n), qw = pu * n + pv * 0.8;
    vec2 wdx = vec2(0.0, c.f.dx.y * 26.0), wdy = vec2(0.0, c.f.dy.y * 26.0);
    vec4 wl = noiseTexGrad(vec2(col1 * 37.0 + 0.5, v * 26.0) + c.so, wdx, wdy), wr = noiseTexGrad(vec2(mod(id + 1.0, n) * 37.0 + 0.5, v * 26.0) + c.so, wdx, wdy);
    float dl = fq - (wl.r - 0.5) * 0.5, dr = 1.0 - fq + (wr.r - 0.5) * 0.5, border = min(dl, dr), du = 0.5 * (dl - dr) / max(dl + dr, 1e-3);
    float keep = 1.0 - smoothstep(0.2, 0.7, qw);
    float furrow = (1.0 - aastep(0.035 + 0.06 * blotch.r, border, qw)) * keep;
    float plate = smoothstep(0.0, 0.3, border);
    float r = v / (0.06 + 0.05 * hash11(col1 + c.seed * 91.0)) + hash11(col1 + 17.0) * 7.0 + (wl.g - 0.5) * 0.35, row = floor(r), k = r - row;
    float rw = pv / 0.06, vkeep = 1.0 - smoothstep(0.25, 0.9, rw);
    float crossC = aaline(min(k, 1.0 - k), 0.07, rw) * vkeep * (1.0 - furrow) * step(0.3, hash12(vec2(col1, row + step(0.5, k))));
    float tone = hash12(vec2(col1 + 31.0, row));
    col *= (0.74 + 0.34 * plate * keep + 0.22 * (tone - 0.5) * keep * vkeep + 0.2 * (blotch.r - 0.5)) * (1.0 + 0.3 * (fine.r - 0.5));
    col = mix(col, col * vec3(1.15, 0.95, 0.78), smoothstep(0.5, 0.8, fibre.g) * 0.5);
    pit = saturate(furrow * 0.85 + crossC * 0.55);
    slope = vec2(-sign(du) * (1.0 - plate) * 1.6 * keep, (k - 0.5) * 0.14 * vkeep + (fine.g - 0.5) * 0.3);
    float moss = smoothstep(0.58, 0.8, blotch.g * 0.7 + saturate(s.N.y) * 0.5 + (1.0 - smoothstep(0.0, 1.5, v)) * 0.25);
    col = mix(col, vec3(0.13, 0.19, 0.05) * (0.6 + 0.8 * fine.g), moss * 0.6);
    lichenAmt = 0.8;
  }
  // lichen: pale crusts, a few of them orange
  float lich = smoothstep(0.66, 0.74, blotch.g * 0.8 + fine.g * 0.2) * lichenAmt * (1.0 - pit);
  col = mix(col, mix(vec3(0.5, 0.53, 0.45), vec3(0.6, 0.38, 0.12), step(0.8, fibre.g)), lich * 0.6);
  o.albedo = col * mix(1.0, 0.22, pit);
  o.rough = rough; o.coat = coat; o.coatRough = 0.25;
  o.N = slopeNormal(o.N, c.f, slope * (1.0 - smoothstep(0.004, 0.03, c.f.px * 1.2)));
  o.ao *= 1.0 - 0.55 * pit;
  applyWetness(o, s.N, 0.7 * (1.0 - coat), c.expo);
}

// ---------------------------------------------------------------- FABRIC
// uv in metres. p0 pattern (0 plain, 1 stripes 12 cm wide, 2 stripes 4 cm wide, 3 gingham 5 cm), p1 index of the
// second colour, p2 seed. Acrylic canvas: plain weave, soft billows between the frame ribs, sun fade,
// tide-marked water stains and mildew specks; some light comes through it.
const vec3 FABRIC_SECOND[10] = vec3[10](vec3(0.848, 0.828, 0.748), vec3(0.848, 0.711, 0.420), vec3(0.570, 0.013, 0.013), vec3(0.911, 0.604, 0.033),
  vec3(0.015, 0.051, 0.342), vec3(0.020, 0.420, 0.393), vec3(0.828, 0.064, 0.263), vec3(0.022, 0.187, 0.059), vec3(0.007, 0.007, 0.009), vec3(0.848, 0.196, 0.017));
void matFabric(SurfIn s, inout SurfOut o, Ctx c) {
  int pat = int(s.mat.y + 0.5); vec2 p = c.f.p; float px = c.f.px;
  vec3 second = FABRIC_SECOND[min(int(s.mat.z + 0.5), 9)];
  float m = 0.0;
  if (pat == 1) m = pulseTrain(p.x / 0.24, 0.5, px / 0.24);
  else if (pat == 2) m = pulseTrain(p.x / 0.08, 0.5, px / 0.08);
  else if (pat == 3) m = 0.5 * (pulseTrain(p.x / 0.1, 0.5, px / 0.1) + pulseTrain(p.y / 0.1, 0.5, px / 0.1));
  vec3 col = mix(c.col, second, m);
  vec4 big = planeNoise(c, 7.0), stain = planeNoise(c, 26.0), slubA = planeNoise(c, vec2(2600.0, 45.0)), slubB = planeNoise(c, vec2(45.0, 2600.0));
  // weave: threads 1.1 mm apart, over and under
  float pitch = 0.0011, wv = detailFade(c, pitch); vec2 th = p * (TAU / pitch);
  float weave = cos(th.x) * cos(th.y) * wv;
  col *= 1.0 + 0.07 * weave + 0.1 * (slubA.r + slubB.g - 1.0) * detailFade(c, 0.002);
  float sky = saturate(0.5 + 0.5 * s.N.y), fade = sky * (0.25 + 0.5 * big.r);
  col = mix(col, mix(vec3(luma(col)), vec3(0.85), 0.5), fade * 0.3);
  // rain water sits in the sags, dries from the edge inwards and leaves a brown rim
  float pond = smoothstep(0.52, 0.78, stain.r * 0.7 + big.g * 0.3), rim = aaline(stain.r * 0.7 + big.g * 0.3 - 0.6, 0.012, px * 3.0);
  col = mix(col, col * vec3(0.72, 0.66, 0.55), pond * 0.35 + rim * 0.4);
  float mildew = (1.0 - smoothstep(0.08, 0.2, planeNoise(c, 500.0).a)) * pond * detailFade(c, 0.006);
  col = mix(col, vec3(0.05, 0.06, 0.045), mildew * 0.6);
  col = mix(col, col * 0.4, cavityDirt(s.occ, stain.g) * 0.5);
  o.albedo = col;
  o.rough = 0.88; o.sss = 0.4;
  o.N = slopeNormal(o.N, c.f, (big.rg - 0.5) * 0.3 + vec2(sin(th.x) * cos(th.y), cos(th.x) * sin(th.y)) * 0.25 * wv);
  // wet canvas goes dark and heavy but never glossy
  float w = c.rain;
  o.albedo *= mix(vec3(1.0), 0.45 + 0.3 * o.albedo, w * 0.85);
  o.rough = mix(o.rough, 0.6, w); o.sss *= 1.0 - 0.5 * w;
}

// ---------------------------------------------------------------- SKIN_CLOTH
// p0: 0 skin, 1 cloth, 2 hair. p1 (cloth): 0 plain, 1 hoops, 2 plaid, 3 tropical print, 4 denim, 5 pinstripe.
// Patterns are laid out in the body's own coordinates so they move with the figure.
void matSkinCloth(SurfIn s, inout SurfOut o, Ctx c) {
  int kind = int(s.mat.y + 0.5), pat = int(s.mat.z + 0.5); vec2 p = c.f.p; float px = c.f.px;
  vec3 g, g2; vec4 fine = solidNoise(c, 2600.0, g), mid = solidNoise(c, 170.0, g2);
  if (kind == 0) {
    o.albedo = c.col * (1.0 + (mid.r - 0.5) * 0.1) * mix(vec3(1.0), vec3(1.08, 0.94, 0.9), cavityDirt(s.occ, mid.g) * 0.6);
    o.rough = 0.52 - 0.2 * c.rain; o.sss = 0.2;
    o.N = grainNormal(o.N, g, 0.02);
    return;
  }
  if (kind == 2) {
    vec4 st = planeNoise(c, vec2(2300.0, 40.0));
    o.albedo = c.col * (0.55 + 0.9 * st.r * st.r);
    o.rough = 0.42 + 0.2 * st.g;
    o.N = slopeNormal(o.N, c.f, vec2((st.g - 0.5) * 0.7, 0.0));
    return;
  }
  // second colour of the garment, chosen from the seed
  float h = hash11(c.seed * 255.0 + 7.0);
  vec3 alt = h < 0.4 ? vec3(0.78, 0.76, 0.68) : (h < 0.6 ? vec3(0.012, 0.016, 0.045) : (h < 0.8 ? c.col * 0.3 : c.col.gbr * 0.7 + 0.08));
  vec3 col = c.col;
  if (pat == 1) col = mix(col, alt, pulseTrain(p.y / 0.045, 0.45, px / 0.045));
  else if (pat == 2) {
    float a = pulseTrain(p.x / 0.07, 0.4, px / 0.07), b = pulseTrain(p.y / 0.07, 0.4, px / 0.07);
    float thin = max(pulseTrain(p.x / 0.07 + 0.68, 0.05, px / 0.07), pulseTrain(p.y / 0.07 + 0.68, 0.05, px / 0.07));
    col = mix(mix(col, alt, 0.5 * (a + b)), vec3(0.75, 0.7, 0.3), thin * 0.6);
  } else if (pat == 3) {
    // big blooms and leaves scattered on the ground colour
    vec4 n = planeNoise(c, 105.0), n2 = planeNoise(c, 61.0);
    float w = px * 105.0 * 0.1, bloom = (1.0 - aastep(0.3, n.a + (n.r - 0.5) * 0.2, w)) * aastep(0.62, n2.r, w), leaf = aastep(0.78, n2.g, w) * (1.0 - bloom);
    col = mix(col, vec3(0.03, 0.2, 0.09), leaf * 0.9);
    col = mix(col, alt, bloom);
    col = mix(col, vec3(0.85, 0.6, 0.05), (1.0 - aastep(0.09, n.a, w)) * bloom);
  } else if (pat == 4) {
    // denim: indigo warp over white weft in a steep twill, faded on the high points
    float tw = pulseTrain((p.x + p.y * 2.0) / 0.0016, 0.55, px * 2.2 / 0.0016) * detailFade(c, 0.0016);
    vec4 wash = planeNoise(c, vec2(900.0, 30.0));
    col = mix(col, mix(vec3(luma(col)), vec3(0.75), 0.6), 0.12 + 0.3 * smoothstep(0.5, 0.9, mid.r) + 0.18 * (wash.r - 0.5) - 0.1 * tw);
  } else if (pat == 5) col = mix(col, alt, aaline(fract(p.x / 0.014) - 0.5, 0.045, px / 0.014) * (1.0 - smoothstep(0.004, 0.012, px)) + 0.09 * smoothstep(0.004, 0.012, px));
  col *= 1.0 + (fine.r - 0.5) * 0.12 * detailFade(c, 0.003) - 0.25 * cavityDirt(s.occ, mid.g);
  o.albedo = col;
  o.rough = 0.86;
  o.N = grainNormal(o.N, g, 0.06 * detailFade(c, 0.003));
  o.N = grainNormal(o.N, g2, 0.12);                                    // soft creases
  o.albedo *= mix(vec3(1.0), 0.45 + 0.3 * o.albedo, c.rain * 0.8);
  o.rough = mix(o.rough, 0.6, c.rain);
}
`;

const BUILT = /* glsl */`
// ---------------------------------------------------------------- ROOF
// uv in metres with v running up the slope. p0: 0 gravel, 1 barrel tile, 2 standing seam, 3 membrane, 4 shingle.
// p1 weathering.
void matRoof(SurfIn s, inout SurfOut o, Ctx c) {
  int kind = int(s.mat.y + 0.5); float age = s.mat.z / 255.0, px = c.f.px; vec2 p = c.f.p;
  vec4 big = planeNoise(c, 5.0), mid = planeNoise(c, 60.0), fine = planeNoise(c, 1400.0);
  vec2 drift = slowDrift(c);
  float cav = cavityDirt(s.occ, mid.g), near = detailFade(c, 0.004);
  vec3 col = c.col; vec2 slope = vec2(0.0); float rough = 0.9, shade = 1.0, porous = 0.6, puddles = 0.0, beads = 0.0;
  if (kind == 0) {
    // built-up roof: pea gravel bedded in bitumen. Stones of several colours, bare black patches where the wind
    // scoured them off, silt where water ponds.
    // each cell of the noise texture is one stone: its distance field gives the dome, so the light agrees with the pattern
    vec4 st = planeNoise(c, 950.0); vec2 dome; float cell = planeRelief(c, 950.0, 3, dome);
    float stone = (1.0 - smoothstep(0.38, 0.62, cell)) * near, bare = smoothstep(0.8, 1.02, big.r * 0.75 + mid.r * 0.25 + 0.14 * age);
    vec3 pebble = mix(vec3(0.62, 0.58, 0.52), vec3(0.3, 0.27, 0.24), smoothstep(0.25, 0.75, st.r)) * mix(vec3(1.0), vec3(1.15, 0.95, 0.75), st.g);
    col = c.col * mix(mix(vec3(0.4, 0.38, 0.34), pebble * 1.5, stone * 0.85), vec3(0.09, 0.088, 0.09), bare * 0.8);
    float silt = smoothstep(0.7, 0.1, big.g * 0.8 + mid.g * 0.2) * (1.0 - bare);
    col = mix(col, vec3(0.2, 0.17, 0.13), silt * (0.3 + 0.4 * age));
    rough = mix(0.95 - 0.1 * silt, 0.5, bare); shade = 1.0 - 0.3 * (1.0 - stone) * near * (1.0 - bare);
    // 950 texels per metre and about 2 mm of dome; the height falls as the cell distance grows
    slope = -dome * (950.0 * 0.002) * near * (1.0 - bare) + (fine.rg - 0.5) * 0.25 * bare;
    puddles = 1.0; porous = 0.5;
  } else if (kind == 1) {
    // clay barrel tile: rows of convex covers over concave pans, each course lapping the one below.
    float W = 0.2, L = 0.4, keep = detailFade(c, 0.07);
    float cx = p.x / W, ci = floor(cx); cx -= ci;
    float pan = aastep(0.25, 0.5 - abs(cx - 0.5), px / W);                      // 1 in the trough half
    float ry = p.y / L + 0.5 * pan, ri = floor(ry); ry -= ri;                           // pans are laid half a course out of step
    vec3 th = hash32(vec2(ci * 2.0 + pan, ri) + c.seed * 53.0);
    col = c.col * (0.72 + 0.5 * th.x) * mix(vec3(1.0), vec3(0.85, 1.0, 1.1), th.y * 0.35) * (1.0 + 0.2 * (fine.r - 0.5) * near);
    col = mix(col, c.col * 0.45, step(0.9, th.z) * 0.6);                                // over-fired tiles
    // the troughs carry the dirt and the black streaks; the crowns grow pale lichen
    vec4 run = planeNoise(c, vec2(140.0, 7.0));
    col = mix(col, vec3(0.035, 0.035, 0.03), pan * (0.25 + 0.6 * age) * smoothstep(0.3, 0.8, run.r));
    col = mix(col, vec3(0.55, 0.56, 0.48), (1.0 - pan) * age * smoothstep(0.68, 0.8, mid.r) * 0.55);
    float butt = 1.0 - aastep(0.045, ry, px / L), lap = aastep(0.9, ry, px / L);
    slope = vec2(-1.35 * sin(TAU * cx), -0.05 + 1.6 * butt) * keep;
    shade = 1.0 - (0.55 * lap + 0.3 * pan) * keep - 0.2 * (1.0 - keep);
    // glazed-over hard-fired tiles shed the light, soft ones and lichen scatter it
    rough = 0.8 + 0.14 * th.x - 0.15 * step(0.9, th.z) + 0.08 * pan; porous = 0.7;
  } else if (kind == 2) {
    // standing-seam metal: painted pans 42 cm wide between upturned seams; chalks, streaks down the slope, rusts at the seams.
    float W = 0.42, x = fract(p.x / W) - 0.5, d = (0.5 - abs(x)) * W, keep = detailFade(c, 0.03);
    float ridge = 1.0 - aastep(0.014, d, px), flank = (1.0 - smoothstep(0.004, 0.022, d)) * keep;
    vec4 run = planeNoise(c, vec2(260.0, 5.0));
    // each pan is its own sheet of coil stock and chalks at its own rate; the slow field only leans the whole slope
    float pan = hash11(floor(p.x / W) + c.seed * 131.0), fade = age * (0.6 + 0.25 * pan + 0.15 * big.r + 0.5 * drift.x);
    col = mix(c.col, mix(vec3(luma(c.col)), vec3(0.85), 0.45), fade * 0.5);
    float runoff = smoothstep(0.55, 0.9, run.r) * (0.2 + 0.5 * age);
    col = mix(col, col * vec3(0.4, 0.37, 0.33), runoff);
    float rust = smoothstep(1.06 - 0.4 * age, 1.12 - 0.4 * age, big.g * 0.5 + mid.r * 0.3 + fine.g * 0.1 + ridge * 0.3);
    col = mix(col, mix(vec3(0.075, 0.03, 0.014), vec3(0.21, 0.085, 0.03), fine.r), rust);
    slope = vec2(sign(x) * 2.2 * flank, 0.0) + (big.rg - 0.5) * 0.035;                  // seams, and the slight buckle of thin sheet
    shade = 1.0 - 0.3 * (smoothstep(0.014, 0.03, d) - smoothstep(0.03, 0.07, d)) * keep;
    rough = mix(0.42 + 0.3 * fade + 0.25 * runoff + 0.06 * (mid.g - 0.5), 0.95, rust); porous = 0.5 * rust; beads = 1.0 - rust;
  } else if (kind == 3) {
    // roll membrane: metre-wide sheets lapped along the slope, mineral surfaced, patched, stained where water ponds.
    float W = 1.0, x = fract(p.x / W) - 0.5, d = (0.5 - abs(x)) * W;
    float lap = aaline(d, 0.004, px), band = 1.0 - smoothstep(0.07, 0.09, d + (mid.r - 0.5) * 0.02);
    col = c.col * (0.9 + 0.2 * (hash11(floor(p.x / W) + c.seed * 255.0) - 0.5) + 0.06 * band) * (1.0 + 0.22 * (fine.b - 0.5) * near);
    vec2 pid, pq; tilePattern(p + c.seed * 5.0, 3.1, 0.0, px, pid, pq); vec3 ph = hash32(pid + 3.0);
    vec2 pd = vec2(0.3 + 0.5 * ph.x, 0.3 + 0.4 * ph.y) - abs(pq - (ph.xy - 0.5));
    // Repairs are rare (one in eight bays on an old roof) and the mastic bead around them is a soft dark fringe
    // under the dust, not a drawn frame; the pond stain is a gentle sun-bleached tide mark rather than a dark pool.
    float inside = aastep(0.0, min(pd.x, pd.y), px) * step(ph.z, 0.04 + 0.1 * age), edge = inside * (1.0 - smoothstep(0.0, 0.06, min(pd.x, pd.y) + (mid.g - 0.5) * 0.04));
    col = mix(col, c.col * (0.86 + 0.28 * ph.x), inside * 0.6);
    col = mix(col, col * 0.45, edge * (0.3 + 0.4 * age));
    float low = big.g * 0.85 + mid.g * 0.15, pond = smoothstep(0.42, 0.12, low) * c.seam;
    col = mix(col, col * vec3(0.84, 0.81, 0.76), pond * (0.3 + 0.4 * age));
    col = mix(col, col * 0.85, aaline(low - 0.27, 0.006, px * 0.4) * (0.2 + 0.4 * age) * c.seam);   // tide line of the last puddle
    shade = 1.0 - 0.6 * lap;
    slope = vec2(sign(x) * 0.3 * (1.0 - smoothstep(0.0, 0.01, d)), 0.0) + (fine.rg - 0.5) * 0.25 * near + (big.rg - 0.5) * 0.03;
    // mineral granules are dull; where they have washed off into the low spots the bitumen underneath shows its sheen
    rough = 0.88 - 0.25 * edge - 0.14 * pond * (0.3 + 0.7 * age) + 0.08 * (mid.r - 0.5); puddles = 1.0; porous = 0.35;
  } else {
    // three-tab asphalt shingle: 30 cm tabs, 12.7 cm exposed, courses half a tab out of step; mineral granules,
    // black algae streaks down the slope, bald patches.
    vec2 size = vec2(0.305, 0.127), id, q; float slot = brickPattern(p, size, 0.007, px, id, q), keep = detailFade(c, 0.04);
    float ry = q.y / size.y + 0.5; slot *= step(abs(q.y), 0.5 * size.y - 0.006);          // the slots, not the course line
    vec3 th = hash32(id + c.seed * 29.0);
    col = c.col * (0.82 + 0.36 * th.x * keep) * (1.0 + 0.45 * (fine.b - 0.5) * near + 0.2 * (fine.r - 0.5));
    vec4 run = planeNoise(c, vec2(170.0, 6.0));
    col = mix(col, vec3(0.03, 0.03, 0.028), smoothstep(0.5, 0.85, run.r) * (0.15 + 0.6 * age));
    float bald = smoothstep(0.86 - 0.2 * age, 0.92 - 0.2 * age, mid.r * 0.7 + th.y * 0.3);
    col = mix(col, vec3(0.06, 0.06, 0.065), bald * 0.8);
    float butt = 1.0 - aastep(0.07, ry, px / size.y), lap = aastep(0.9, ry, px / size.y);
    slope = vec2(0.0, 1.1 * butt) * keep + (fine.rg - 0.5) * 0.5 * near * (1.0 - bald);
    shade = 1.0 - (0.4 * lap + 0.75 * slot) * keep;
    rough = 0.93 - 0.3 * bald - 0.08 * th.x * keep; porous = 0.6;
  }
  col = mix(col, col * vec3(0.35, 0.32, 0.28), cav * 0.6);
  o.albedo = col * shade * (1.0 + 0.1 * drift.y);
  o.rough = clamp(rough + 0.07 * drift.x + 0.1 * cav, 0.1, 1.0);
  o.N = slopeNormal(o.N, c.f, slope);
  o.ao *= mix(1.0, shade, 0.7);
  if (beads > 0.0) beadWater(s, o, c, beads * smoothstep(0.75, 0.35, rough));
  if (puddles > 0.0) standingWater(s, o, c, (0.5 - big.g) * 0.2);
  applyWetness(o, s.N, porous, c.expo);
}

// ---------------------------------------------------------------- TILE
// uv in metres. p0 unit size in cm, p1 pattern: 0 grid, 1 checker, 2 terrazzo (p0 = divider spacing), 3 brick paver
// (p0 = brick width). Colour is the tile (or cement matrix) colour.
void matTile(SurfIn s, inout SurfOut o, Ctx c) {
  float size = max(s.mat.y, 2.0) * 0.01, px = c.f.px; int pat = int(s.mat.z + 0.5); vec2 p = c.f.p, id, q;
  vec4 big = planeNoise(c, 8.0), mid = planeNoise(c, 75.0), fine = planeNoise(c, 1700.0);
  float cav = cavityDirt(s.occ, mid.g), near = detailFade(c, 0.004), foot = baseGrime(c, mid.g);
  float film = saturate(0.3 * smoothstep(0.45, 0.85, big.r * 0.5 + mid.r * 0.5) + cav * 0.6 + foot * 0.5);
  vec3 col; vec2 slope = vec2(0.0); float rough, coat = 0.0, groove = 0.0, porous = 0.1, lower = 0.0;
  if (pat == 2) {
    // terrazzo: marble chips of two sizes in tinted cement, ground flat and polished, divided by brass strips
    float chips = detailFade(c, 0.006); vec3 chipCol = vec3(0.5); float chip = 0.45;
    if (chips > 0.0) {
      vec2 v1 = voronoi(p * 85.0 + c.so), v2 = voronoi(p * 210.0 + 17.0);
      float w = px * 85.0, c1 = 1.0 - aastep(0.26 + 0.2 * v1.y, v1.x, w), c2 = (1.0 - aastep(0.3, v2.x, w * 2.5)) * (1.0 - c1);
      float tone = c1 > 0.0 ? v1.y : v2.y; chip = mix(0.45, max(c1, c2), chips);
      chipCol = tone < 0.4 ? vec3(0.8, 0.78, 0.72) : (tone < 0.62 ? vec3(0.07, 0.07, 0.075) : (tone < 0.82 ? vec3(0.5, 0.43, 0.36) : c.col * 1.25 + 0.05));
      chipCol = mix(vec3(0.42, 0.4, 0.37), chipCol, chips);
    }
    float strip = tilePattern(p, size, 0.005, px, id, q);
    col = mix(c.col * (0.8 + 0.2 * mid.r), chipCol, chip * 0.9);
    col = mix(col, vec3(0.78, 0.6, 0.28), strip);
    o.metal = strip * 0.9;
    rough = 0.2 + 0.25 * film; coat = 0.5 * (1.0 - film);
  } else if (pat == 3) {
    // clay brick paver in herringbone: every brick its own firing colour, sand and a little moss in the joints
    float jm = herringbonePattern(p, size, 0.005, px, id, q), keep = detailFade(c, size * 0.5);
    vec3 bh = hash32(id + c.seed * 41.0);
    col = c.col * (0.72 + 0.5 * bh.x * keep) * mix(vec3(1.0), vec3(0.8, 0.86, 1.0), bh.y * 0.4 * keep);
    col = mix(col, c.col * 0.38, step(0.88, bh.z) * 0.7 * keep);
    col *= 1.0 + 0.25 * (fine.r - 0.5) * near;
    // worn arrises: the edge of each brick is chipped paler
    vec2 e = vec2(size, 0.5 * size) - abs(q); float arris = (1.0 - smoothstep(0.003, 0.012, min(e.x, e.y) + (fine.g - 0.5) * 0.008)) * (1.0 - jm);
    col = mix(col, col * 1.25 + 0.03, arris * 0.5 * near);
    col = mix(col, mix(vec3(0.34, 0.3, 0.23), vec3(0.06, 0.1, 0.03), smoothstep(0.55, 0.75, mid.r)) * (0.7 + 0.6 * fine.b), jm);
    // hard-fired bricks are closed and faintly glossy, soft ones sandy; feet polish the middle of each face
    groove = jm * 0.6; rough = 0.92 - 0.2 * bh.x * keep - 0.1 * step(0.88, bh.z) * keep + 0.12 * arris; porous = 0.7; lower = jm * 0.15;
    slope = (fine.rg - 0.5) * 0.3 * near;
  } else {
    // glazed ceramic: pillowed tiles with dirty grout; a few are cracked or chipped at a corner
    float jw = min(0.004, size * 0.06), jm = tilePattern(p, size, jw, px, id, q), keep = detailFade(c, size * 0.5);
    vec3 th = hash32(id + c.seed * 67.0);
    vec3 base = c.col;
    if (pat == 1 && mod(id.x + id.y, 2.0) > 0.5) base = luma(c.col) > 0.2 ? vec3(0.02, 0.02, 0.024) : vec3(0.72, 0.69, 0.62);
    col = base * (0.93 + 0.14 * th.x * keep) * (1.0 + 0.05 * (mid.r - 0.5));
    // a crack runs straight across some tiles
    float ang = th.y * PI, cd = dot(q, vec2(cos(ang), sin(ang))) + (fine.r - 0.5) * 0.004;
    float crack = step(th.z, 0.045) * aaline(cd, 0.0006, px) * keep;
    vec2 e = vec2(0.5 * size) - abs(q); float corner = step(0.93, th.z) * (1.0 - aastep(0.25 * size * th.x, e.x + e.y, px)) * keep;
    col = mix(col, vec3(0.55, 0.5, 0.45), corner * 0.8);
    col = mix(col, mix(vec3(0.36, 0.35, 0.33), vec3(0.09, 0.085, 0.075), saturate(0.35 + 0.6 * mid.g + film)), jm);
    groove = saturate(jm * 0.5 + crack);
    float glaze = (1.0 - jm) * (1.0 - corner);
    rough = mix(0.9, 0.12 + 0.3 * film + 0.06 * th.y * keep, glaze); coat = 0.7 * glaze * (1.0 - film);
    // pillowed edges tip the reflection at every joint
    vec2 edge = smoothstep(0.5 * size - 0.012, 0.5 * size, abs(q)) * sign(q);
    slope = -edge * 0.35 * keep * glaze + (big.rg - 0.5) * 0.01;
    lower = jm * 0.1;
  }
  vec2 drift = slowDrift(c);
  col = mix(col, col * vec3(0.4, 0.37, 0.32) + 0.008, film * 0.6);
  o.albedo = col * mix(1.0, 0.45, groove) * (1.0 + 0.08 * drift.y);
  o.rough = clamp(rough + 0.06 * drift.x, 0.05, 1.0); o.coat = coat; o.coatRough = 0.05 + 0.15 * film;
  o.N = slopeNormal(o.N, c.f, slope);
  o.ao *= (1.0 - 0.4 * groove) * (1.0 - 0.2 * cav);
  if (coat > 0.0) beadWater(s, o, c, coat);
  standingWater(s, o, c, lower + (0.5 - big.g) * 0.12);
  applyWetness(o, s.N, porous, c.expo);
}

// ---------------------------------------------------------------- POOL_WATER
// uv in metres on the water surface. p0 depth in dm. Colour is the colour of the pool shell. The floor is drawn
// where the refracted view ray meets it, tinted by the water it passes through, with moving caustics by day and
// the glow of underwater lamps (channel STREET) by night.
void matPoolWater(SurfIn s, inout SurfOut o, Ctx c) {
  float depth = max(s.mat.y, 5.0) * 0.1, px = c.f.px, t = uTime.x; vec2 p = c.f.p;
  // surface: two trains of ripples crossing, livelier in wind and rain
  vec2 k1 = vec2(26.0), k2 = vec2(43.0);
  vec4 a = noiseTexGrad((p + t * vec2(0.05, 0.027)) * k1, c.f.dx * k1, c.f.dy * k1), b = noiseTexGrad((p - t * vec2(0.031, 0.046)) * k2 + 91.0, c.f.dx * k2, c.f.dy * k2);
  vec2 slope = ((a.rg - 0.5) + (b.gr - 0.5) * 0.7) * (0.07 + 0.05 * uWind.z + 0.1 * uWeather.x);
  vec3 rr = rainRipples(p, px); slope += rr.xy;
  // refraction: the floor point seen through this pixel lies further from the viewer than the surface point
  vec2 vt = vec2(dot(s.V, c.f.T), dot(s.V, c.f.B)); float sinI = min(length(vt), 0.999), sinR = sinI / 1.33, cosR = sqrt(1.0 - sinR * sinR);
  vec2 fp = p - vt / max(sinI, 1e-4) * (sinR / cosR) * depth - slope * depth * 0.6;
  float fpx = px * (1.0 + depth * 0.35);
  // shell: pale tiles with grout
  vec2 id, q; float grout = tilePattern(fp, 0.15, 0.012, fpx, id, q);
  vec3 shell = c.col * (0.92 + 0.12 * hash12(id)) * mix(1.0, 0.72, grout * detailFade(c, 0.05));
  // caustics: bright cell edges of two drifting layers, focused where they coincide
  vec2 kc = vec2(11.0), kd = vec2(17.0), wob = (a.rg - 0.5) * 0.5;
  float c1 = noiseTexGrad((fp + wob * 0.2 + t * vec2(0.03, 0.02)) * kc, c.f.dx * kc, c.f.dy * kc).a, c2 = noiseTexGrad((fp - wob * 0.15 - t * vec2(0.022, 0.035)) * kd + 37.0, c.f.dx * kd, c.f.dy * kd).a;
  float caustic = pow(saturate(c1 * c2 * 1.9), 3.0) * 2.2 + 0.25 * (c1 + c2 - 0.8);
  float sun = uSunDir.w * saturate(uSunDir.y * 3.0) * (1.0 - 0.8 * uWeather.w);
  // water takes the red out of the light on its way down and back
  vec3 through = exp(-vec3(0.36, 0.06, 0.03) * depth * (1.0 + 1.0 / cosR));
  o.albedo = shell * through * (1.0 + caustic * sun * 0.9) + vec3(0.0, 0.012, 0.016) * (1.0 - through.g);
  float lamps = channelLevel(1.0, c.seed);
  o.emissive = shell * through * lamps * (0.5 + 0.3 * caustic) * vec3(0.75, 0.95, 1.0);
  o.N = slopeNormal(s.N, c.f, slope);
  o.rough = 0.03; o.metal = 0.0; o.ao = 1.0;
  o.coat = 1.0; o.coatRough = 0.02; o.wet = 1.0;
}
`;

const INTERIOR = /* glsl */`
// The surfaces of a room. Only BLOCK answers the weather (painted block also stands outdoors); the others are
// never rained on, and what gathers in a room's corners reaches them through the baked occlusion.

// Rubber left by a car turning on the floor, 0..1: two tracks 1.45 m apart on an arc of a few metres' radius.
// A layer may leave one mark in each cell of its grid. The mark dies away before it reaches the edge of its cell,
// so no cell has to know its neighbours.
float tyreArcs(Ctx c, vec2 p, float cell, float salt, float amount) {
  vec2 id = floor(p / cell); vec3 h = hash32(id + salt), h2 = hash32(id + salt + 71.0);
  float R = 2.5 + 8.0 * h2.x * h2.x, ang = h2.y * 2.0 * PI; vec2 dir = vec2(cos(ang), sin(ang));
  vec2 rel = p - ((id + 0.35 + 0.3 * h.xy) * cell + dir * R);                 // from the centre of the turn
  // metres across the mark and along it; the angle is measured from the cell's own point of the arc, which puts
  // its wrap on the far side of the circle where the mark has long faded
  float d = length(rel) - R, along = atan(dot(rel, vec2(-dir.y, dir.x)), -dot(rel, dir)) * R;
  float off = abs(abs(d) - 0.725), band = 1.0 - aastep(0.085, off, max(c.f.px, 0.025));
  if (band <= 0.0) return 0.0;
  float ribs = mix(0.8, 0.72 + 0.28 * cos(off * (2.0 * PI / 0.034)), detailFade(c, 0.03));
  // a tyre only marks while it scrubs: the track comes and goes along its length, the loaded outer wheel heavier
  float press = smoothstep(0.3, 0.7, noiseTexGrad(vec2(along * 7.0, h2.z * 251.0 + 8.0), vec2(c.f.px * 7.0, 0.0), vec2(0.0)).r);
  float fade = 1.0 - smoothstep(0.24, 0.42, length(p - (id + 0.5) * cell) / cell);
  return band * ribs * press * fade * (d > 0.0 ? 1.0 : 0.45 + 0.5 * h2.z) * saturate(amount * (0.5 + 1.2 * h.z));
}

// ---------------------------------------------------------------- EPOXY
// uv = floor metres. p0 roughness of the fresh coat, p1 wear. Colour is the pigment. A resin floor poured over a
// concrete slab: the resin is a clear mirror over its pigment, and everything that has happened to the floor since
// is written in how sharp that mirror still is. The slab is saw-cut every 3 m of uv. Dust lies where the baked
// occlusion says the room's corners are.
void matEpoxy(SurfIn s, inout SurfOut o, Ctx c) {
  float gloss = max(s.mat.y / 255.0, 0.03), wear = s.mat.z / 255.0, px = c.f.px; vec2 p = c.f.p, id, q;
  vec4 big = planeNoise(c, 5.5), mid = planeNoise(c, 70.0), fine = planeNoise(c, 1800.0), grit = planeNoise(c, 300.0);
  vec2 drift = slowDrift(c); float near = detailFade(c, 0.004);
  // Where wheels and feet go the resin is scratched to a haze. The field is used linearly, so lanes grade into
  // the quiet corners instead of printing islands.
  float traffic = saturate(0.5 + 1.1 * drift.x + 0.5 * (big.r - 0.5));
  // mop and squeegee strokes: long parallel smears a hand wide, lying across the room at an angle
  vec2 sa = vec2(0.94, 0.342), sb = vec2(-0.342, 0.94), sk = vec2(5.0, 110.0);
  vec4 smear = noiseTexGrad(vec2(dot(p, sa), dot(p, sb)) * sk + c.so, vec2(dot(c.f.dx, sa), dot(c.f.dx, sb)) * sk, vec2(dot(c.f.dy, sa), dot(c.f.dy, sb)) * sk);
  // A stroke is a film of dried dirty water: it dims the mirror. It must not change how sharp the mirror is by
  // much, because the length a reflected lamp is drawn out to goes with the square of the roughness, and a tube
  // crossing strokes of unlike roughness is cut into short and long pieces.
  float film = wear * saturate(1.6 * (smear.r - 0.4));
  float haze = wear * (0.02 + 0.1 * traffic * traffic + 0.02 * (smear.r - 0.5) + 0.06 * smoothstep(0.55, 0.9, fine.g) * near);
  vec3 col = c.col * (1.0 + 0.1 * drift.y + 0.08 * (big.g - 0.5) + 0.05 * (mid.r - 0.5));

  // saw cuts: the resin rolls over each arris into the cut, chips along it, and the cut itself fills with dirt
  float jm = tilePattern(p, 3.0, 0.006, px, id, q);
  vec2 e = vec2(1.5) - abs(q), toCut = e.x < e.y ? vec2(sign(q.x), 0.0) : vec2(0.0, sign(q.y)); float je = min(e.x, e.y);
  float lip = (1.0 - smoothstep(0.003, 0.016, je)) * (1.0 - jm) * detailFade(c, 0.012);
  // spalls: here and there the arris has broken away in a shallow bite with a crisp edge
  float bite = 0.024 * smoothstep(1.0 - 0.3 * wear, 1.06 - 0.3 * wear, mid.r) - 0.005;
  float chip = (1.0 - smoothstep(bite - 0.0015, bite + 0.0015, je + (grit.r - 0.5) * 0.006)) * (1.0 - jm) * detailFade(c, 0.008);
  // The slab is never flat: each bay settled at its own slight tilt and the resin levelled into long shallow
  // waves, so a reflected tube wanders and breaks at every cut. The waves are three sines, not noise: a mirror
  // shows the slope itself, and the slope of fractal noise is all in its smallest octave, which saws the image.
  vec3 ph = vec3(dot(p, vec2(3.4, 1.3)), dot(p, vec2(-2.9, 6.1)), dot(p, vec2(9.6, -5.2))) + c.seed * vec3(41.0, 67.0, 23.0);
  vec2 wave = vec2(3.4, 1.3) * cos(ph.x) * 0.0011 + vec2(-2.9, 6.1) * cos(ph.y) * 0.00045 + vec2(9.6, -5.2) * cos(ph.z) * 0.00016;
  vec2 slope = wave * (0.5 + big.r) + (hash22(id + c.seed * 91.0) - 0.5) * 0.004 - toCut * lip * 0.3;

  // Scrubbed rubber is a matte deposit on top of the resin: it does not darken a dark floor, it puts out the
  // mirror, so a track shows as a dull grey band wherever the floor reflects something.
  float tyre = max(tyreArcs(c, p, 7.0, 3.0, wear * 1.4), tyreArcs(c, p + vec2(3.1, 4.7), 9.5, 29.0, wear * 1.1));
  // oil ghosts: where a sump dripped and was wiped up, the resin stays dull inside a tide line
  vec2 oc = floor(p / 4.3 + 0.37); vec3 oh = hash32(oc + 53.0 + c.seed * 17.0);
  float od = length(p - (oc - 0.37 + 0.25 + 0.5 * oh.xy) * 4.3) / (0.12 + 0.3 * oh.z) + (mid.g - 0.5) * 0.7 + (big.r - 0.5) * 0.3;
  float spilt = step(fract(oh.z * 7.3), 0.25 + 0.6 * wear);
  float stain = (1.0 - smoothstep(0.7, 1.05, od)) * spilt, ring = smoothstep(0.7, 0.92, od) * (1.0 - smoothstep(0.95, 1.15, od)) * spilt;
  // dust: banked in the corners, and as single specks that sit on the mirror everywhere else
  // (the bank follows the occlusion alone: a builder shades a whole floor with one gradient, and noise in the
  // threshold turns that into clouds)
  float speck = (1.0 - smoothstep(0.03, 0.07, grit.a)) * smoothstep(0.5, 0.85, mid.g) * detailFade(c, 0.003) * (0.3 + 0.7 * wear);
  float dust = saturate(smoothstep(0.92, 0.35, s.occ) * (0.9 + 0.2 * (grit.g - 0.5) * detailFade(c, 0.02)) + 0.4 * speck);

  col = mix(col, vec3(0.034, 0.033, 0.032), tyre * 0.85);
  col = mix(col, vec3(0.05, 0.048, 0.045), film * 0.12);
  col *= 1.0 - 0.3 * stain - 0.2 * ring;
  col = mix(col, vec3(0.17, 0.165, 0.155) * (0.8 + 0.4 * fine.r), chip);
  col = mix(col, vec3(0.035, 0.03, 0.026), jm);
  o.albedo = mix(col, vec3(0.2, 0.19, 0.17), dust * 0.55);
  float bare = saturate(jm + chip);
  o.coat = (1.0 - bare) * (1.0 - 0.85 * dust) * (1.0 - 0.95 * tyre) * (1.0 - 0.2 * stain - 0.35 * ring) * (1.0 - 0.3 * film);
  o.coatRough = clamp(gloss + haze + 0.5 * tyre + 0.16 * stain + 0.26 * ring + 0.35 * dust, 0.03, 1.0);
  o.rough = mix(0.5, 0.92, saturate(bare + dust + tyre));
  o.N = slopeNormal(o.N, c.f, slope);
  o.ao *= 1.0 - 0.5 * jm;
}

// ---------------------------------------------------------------- BLOCK
// uv = (metres along the wall, metres above the floor). p0 paint roughness, p1 wear. Colour is the paint.
// Concrete blocks 400 x 200 mm in running bond with 10 mm tooled joints, under coats of masonry paint. The paint
// bridges the joints, so the wall is one colour and its pattern is all relief: joints, blocks that sit a hair
// proud of their neighbours, the open face of the block. Wear rises from the floor (v = 0).
void matBlock(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.15), wear = s.mat.z / 255.0, px = c.f.px; vec2 p = c.f.p, id, q;
  vec4 big = planeNoise(c, 9.0), mid = planeNoise(c, 110.0), fine = planeNoise(c, 2400.0), lap = planeNoise(c, vec2(70.0, 3.0));
  vec2 drift = slowDrift(c);
  float jm = brickPattern(p, vec2(0.4, 0.2), 0.010, px, id, q), keep = detailFade(c, 0.1), near = detailFade(c, 0.004);
  vec3 bh = hash32(id + c.seed * 57.0); vec2 lean = hash22(id + 19.0 + c.seed * 113.0) - 0.5;
  // the joint is a shallow tooled hollow: its two flanks face up and down (or left and right)
  vec2 e = vec2(0.2, 0.1) - abs(q), flank = sin(PI * min(e / 0.006, vec2(1.0)));
  // a lightweight block has an open, sandy face; paint closes the small pores and leaves the large ones as pinholes
  vec2 pore; planeRelief(c, 3600.0, 1, pore);
  float pin = (1.0 - smoothstep(0.04, 0.1, fine.a)) * smoothstep(0.5, 0.8, mid.g) * near;
  vec2 slope = -sign(q) * flank * 0.45 * detailFade(c, 0.008) + pore * 1.1 * detailFade(c, 0.003) + lean * 0.014 * keep;

  // paint: each block drank it differently, the roller left bands a roller wide, and gloss follows both
  vec3 col = c.col * (1.0 + 0.05 * (bh.x - 0.5) * keep + 0.06 * drift.y + 0.03 * (lap.r - 0.5) + 0.04 * (big.g - 0.5));
  float sheen = rough + 0.08 * (lap.g - 0.5) + 0.06 * (bh.y - 0.5) * keep + 0.07 * drift.x + 0.05 * (fine.g - 0.5) * near;
  // low down: mop splash and floor dust, dark rubs from tyres, trolleys and boots, chips off the arrises
  float low = 1.0 - smoothstep(0.0, 0.25 + 0.35 * big.r, p.y + (mid.g - 0.5) * 0.08), reach = 1.0 - smoothstep(0.3, 1.4, p.y);
  float grime = saturate(0.7 * wear * low + 0.6 * cavityDirt(s.occ, mid.r));
  float rub = smoothstep(0.84, 0.93, planeNoise(c, vec2(60.0, 700.0)).r) * smoothstep(0.05, 0.2, p.y) * (1.0 - smoothstep(0.7, 1.15, p.y)) * wear;
  float chipAt = 1.0 - wear * (0.01 + 0.11 * reach);
  // a knocked arris breaks away in a shallow bite with a crisp edge, down to the grey of the block
  float bite = 0.02 * smoothstep(chipAt, chipAt + 0.06, mid.r) - 0.004;
  float chip = (1.0 - smoothstep(bite - 0.0015, bite + 0.0015, min(e.x, e.y) + (fine.g - 0.5) * 0.004)) * (1.0 - jm) * detailFade(c, 0.008);
  col = mix(col, col * vec3(0.5, 0.47, 0.42), grime * 0.6);
  col = mix(col, vec3(0.05, 0.048, 0.045), rub * 0.6);
  col = mix(col, vec3(0.2, 0.195, 0.18) * (0.8 + 0.4 * fine.r), chip);
  o.albedo = col * (1.0 - jm * (0.04 + 0.35 * grime)) * (1.0 - 0.5 * pin);
  o.rough = clamp(mix(sheen, 0.9, saturate(0.7 * grime + chip + 0.25 * jm + pin)) + 0.15 * rub, 0.12, 1.0);
  o.N = slopeNormal(o.N, c.f, slope);
  // the hollow of a joint is 2 mm deep and wide open: it is shaded by its flanks, with only a breath of occlusion
  o.ao *= (1.0 - 0.2 * jm) * (1.0 - 0.5 * pin);
  applyWetness(o, s.N, 0.15, c.expo);
}

// ---------------------------------------------------------------- GLASS_BLOCK
// uv = metres. p0 radiance code of the light behind the wall (0 = dark), p1 = channel + 16 * pattern (0 pressed
// wave, 1 straight flutes). Colour is that light. Hollow pressed-glass blocks, 190 mm on a 200 mm module in pale
// mortar. The outer face is a flat sheet of glass that mirrors the room; the pattern is pressed into the two inner
// faces. Clear glass does not diffuse: it bends the line of sight, so what a block shows is the space behind it
// (upright lamps every 1.2 m of u in front of a pale backing, 0.3 m back) pulled about by the pattern. Where a
// sight line lands on a lamp the glass is near white, where it is thrown wide of one it is dim. Every block came
// out of the same mould, so the pattern belongs to the block, not to the wall.

// The pressed wave at q (metres from the block's centre): flutes 47 mm apart that wander from side to side.
// x = height -1..1, yz = its slope per metre.
vec3 glassWave(vec2 q) {
  float bend = 2.0 * PI * q.y / 0.12, ph = 2.0 * PI * (q.x / 0.047 + 0.3 * sin(bend));
  return vec3(sin(ph), cos(ph) * (2.0 * PI / 0.047), cos(ph) * 0.3 * cos(bend) * (4.0 * PI * PI / 0.12));
}
// Light behind the wall at u = x metres, seen through glass that spreads the sight line by 'spread' metres there:
// the backing, the pool of light each lamp throws on it, and the lamp itself.
float lampField(float x, float spread) {
  float d = (fract((x - 0.6) / 1.2 + 0.5) - 0.5) * 1.2, w = sqrt(0.00016 + spread * spread);
  return 0.4 + 0.8 * exp(-d * d / 0.09) + 7.0 * (0.0126 / w) * exp(-0.5 * d * d / (w * w));
}
void matGlassBlock(SurfIn s, inout SurfOut o, Ctx c) {
  float px = c.f.px; vec2 p = c.f.p, id, q;
  float pattern = floor(s.mat.z / 16.0 + 0.01), channel = s.mat.z - 16.0 * pattern;
  float jm = tilePattern(p, 0.2, 0.010, px, id, q), keep = detailFade(c, 0.06);
  vec2 e = vec2(0.1) - abs(q); float je = min(e.x, e.y);
  vec4 mid = planeNoise(c, 90.0), field = planeNoise(c, 2.5); vec3 bh = hash32(id + c.seed * 83.0);
  // sideways travel of the line of sight per metre of depth behind the face, flattened by refraction
  vec2 vt = vec2(dot(s.V, c.f.T), dot(s.V, c.f.B)) / (1.5 * max(dot(s.V, s.N), 0.25));
  // throw = how far the pattern moves the sight line sideways at the lamps (metres), rise = the same up and down
  // (in block heights), gather = the light a crest focuses and a trough loses, crest = the relief for the unlit
  // glass, spread = how wide a lamp is smeared: by the pattern once that is too small to see, and by the pixel,
  // which covers a stretch of the space behind as many times its own size as the pattern magnifies
  float throwX, rise, gather, crest, spread;
  if (pattern > 0.5) {
    // Upright flutes 13 mm wide on the near face and a little coarser on the far one. Each is a cylinder lens:
    // it shows a hand's width of the space behind squeezed into its own width and turned left for right,
    // and goes dark at the cusp where it meets the next. So a lamp shows once in every flute near it, and the
    // two faces beat against each other in bands a few flutes wide that move with the eye.
    float near = detailFade(c, 0.007) * smoothstep(0.012, 0.02, je);
    float u1 = q.x / 0.013, t = u1 - floor(u1 + 0.5), u2 = (q.x - vt.x * 0.08) / 0.0146 + 0.3, t2 = u2 - floor(u2 + 0.5);
    throwX = -(0.1 * t + 0.05 * t2) * near; rise = 0.0;
    float cusp = (1.0 - 0.65 * smoothstep(0.7, 1.0, abs(t) * 2.0)) * (1.0 - 0.35 * smoothstep(0.7, 1.0, abs(t2) * 2.0));
    gather = mix(1.0, cusp * (1.05 + 0.3 * (hash11(floor(u1 + 0.5) + id.x * 17.0 + c.seed * 7.0) - 0.5)), near);
    crest = cos(2.0 * PI * t) * near; spread = 0.04 * (1.0 - near) + 8.0 * px * near;
  } else {
    // the near inner face lies 8 mm behind the outer one, the far one 80 mm, with its flutes laid across the
    // first; each block is laid one of four ways round
    float near = detailFade(c, 0.02); vec2 turn = vec2(bh.y < 0.5 ? -1.0 : 1.0, bh.z < 0.5 ? -1.0 : 1.0);
    vec3 front = glassWave((q - vt * 0.008) * turn), back = glassWave((q - vt * 0.08).yx * turn);
    throwX = (front.y * turn.x + back.z * turn.y) * 0.0004 * near; rise = (front.z * turn.y + back.y * turn.x) * 0.0012 * near;
    vec2 ridge = saturate(0.5 + 0.5 * vec2(front.x, back.x)); ridge *= ridge * ridge;
    gather = mix(1.0, 0.12 + 1.6 * ridge.x + 1.0 * ridge.y, near);
    crest = 0.5 * (front.x + back.x) * near; spread = 0.06 * (1.0 - near) + 7.0 * px * near;
  }
  // behind the glass the backing is brighter above than below; the rise of the sight line picks along it
  float aim = 0.5 + (q.y - vt.y * 0.03) / 0.19 + rise;
  float lens = mix(1.0, mix(0.7, 1.25, smoothstep(0.05, 0.95, aim)), keep) * gather * lampField(p.x - vt.x * 0.3 + throwX, spread);
  // the fused edge of a block is seen through its side walls: dimmer and greener, with one bright line where the
  // inner corner catches the light
  float rim = (1.0 - smoothstep(0.006, 0.024, je)) * keep;
  lens = lens * (1.0 - 0.55 * rim) + 0.32 * (1.0 - smoothstep(0.0, 0.005, abs(je - 0.022))) * keep;
  lens *= 1.0 + 0.25 * (field.r - 0.5) + 0.7 * (bh.x - 0.5) * keep;
  float level = s.mat.y > 0.5 ? channelLevel(channel, c.seed) : 0.0, glass = 1.0 - jm;
  // the glass tints the light; where the lamp itself shows, there is too much of it to stay coloured
  vec3 through = mix(vec3(0.93, 1.0, 0.96), vec3(0.72, 1.0, 0.86), rim);
  vec3 light = mix(c.col * through, vec3(max(max(c.col.r, c.col.g), c.col.b)), 0.75 * saturate(0.3 * (lens - 1.5)));
  o.emissive = light * (radianceCode(s.mat.y) * level * lens * glass);

  float film = saturate(0.15 * mid.r + 0.6 * cavityDirt(s.occ, mid.g));
  vec3 mortar = vec3(0.55, 0.53, 0.49) * (0.72 + 0.3 * mid.g) * (1.0 - 0.4 * film);
  o.albedo = mix(mix(vec3(0.2, 0.25, 0.23) * (1.0 + 0.25 * crest - 0.3 * rim), vec3(0.3, 0.29, 0.26), film * 0.5), mortar, jm);
  o.rough = mix(0.35, 0.92, jm);
  o.coat = glass * (1.0 - 0.5 * film); o.coatRough = 0.04 + 0.2 * film;
  // the face rounds off into the joint
  vec2 pillow = (1.0 - smoothstep(vec2(0.005), vec2(0.016), e)) * glass;
  o.N = slopeNormal(o.N, c.f, -sign(q) * pillow * 0.5 * keep);
  o.ao *= 1.0 - 0.3 * jm;
}

// ---------------------------------------------------------------- PEGBOARD
// uv = metres. p0 roughness, p1 wear. Colour is the face of the board (bare hardboard or paint). Tempered
// hardboard with 6 mm holes on 25.4 mm centres. A hole is drawn as what it is: an opening in a 3 mm board, so
// from the side its far wall shows as a crescent of raw fibre.
void matPegboard(SurfIn s, inout SurfOut o, Ctx c) {
  float rough = max(s.mat.y / 255.0, 0.2), wear = s.mat.z / 255.0, px = c.f.px; vec2 p = c.f.p, id, q;
  tilePattern(p, 0.0254, 0.0, px, id, q);
  vec4 big = planeNoise(c, 9.0), mid = planeNoise(c, 130.0), fine = planeNoise(c, 2600.0);
  vec2 drift = slowDrift(c);
  float keep = detailFade(c, 0.006), near = detailFade(c, 0.003), r = length(q);
  vec2 vt = vec2(dot(s.V, c.f.T), dot(s.V, c.f.B)) / max(dot(s.V, s.N), 0.3);
  float front = 1.0 - aastep(0.0032, r, px), open = front * (1.0 - aastep(0.0032, length(q - vt * 0.0032), px));
  float bore = (front - open) * keep;
  open = mix(0.05, open, keep);                                   // five percent of the board is hole
  // hooks go in and out of the same few holes: the board round them is rubbed dark and smooth
  float used = step(0.86, hash12(id + c.seed * 29.0)) * wear, halo = (1.0 - smoothstep(0.005, 0.011, r)) * used * keep;
  float handled = wear * saturate(0.5 * big.r + 0.5 * mid.g - 0.2), cav = cavityDirt(s.occ, mid.r);
  vec3 col = c.col * (1.0 + 0.07 * (mid.r - 0.5) + 0.05 * (big.g - 0.5) + 0.06 * drift.y + 0.06 * (fine.r - 0.5) * near);
  col *= (1.0 - 0.2 * handled) * (1.0 - 0.3 * halo) * (1.0 - 0.5 * cav);
  col = mix(col, mix(c.col, vec3(0.3, 0.2, 0.12), 0.7) * 0.55, bore);
  o.albedo = mix(col, vec3(0.012), open);
  o.rough = mix(clamp(rough + 0.08 * (fine.g - 0.5) * near + 0.07 * drift.x + 0.1 * handled - 0.1 * halo + 0.2 * cav, 0.15, 1.0), 0.95, saturate(open + bore));
  // the punch leaves each hole with a slightly sunk edge
  float sunk = (1.0 - smoothstep(0.0034, 0.0052, r)) * (1.0 - front) * keep;
  o.N = slopeNormal(o.N, c.f, q / max(r, 1e-5) * sunk * 0.45);
  o.ao *= 1.0 - 0.85 * open - 0.4 * bore;
}
`;

const MAIN_HEAD = /* glsl */`
// Instance tint key: a vertex colour of exactly magenta means "take the colour from the instance's tint"
// (objA.y of an instanced prototype), so one prototype mesh can appear in eight colours.
const vec3 TINT_FABRIC[8] = vec3[8](vec3(0.570, 0.013, 0.013), vec3(0.911, 0.604, 0.033), vec3(0.015, 0.051, 0.342), vec3(0.020, 0.420, 0.393),
  vec3(0.848, 0.828, 0.748), vec3(0.828, 0.064, 0.263), vec3(0.848, 0.196, 0.017), vec3(0.022, 0.187, 0.059));
const vec3 TINT_GENERAL[8] = vec3[8](vec3(0.263, 0.030, 0.017), vec3(0.013, 0.040, 0.147), vec3(0.025, 0.119, 0.047), vec3(0.692, 0.147, 0.013),
  vec3(0.748, 0.477, 0.022), vec3(0.448, 0.448, 0.420), vec3(0.787, 0.748, 0.638), vec3(0.013, 0.196, 0.214));

void surface(in SurfIn s, inout SurfOut o) {
  int id = int(s.mat.x + 0.5);
  // --- everything that needs screen derivatives, once, before branching on the material
  SurfFrame pf = planeFrame(s), uf = uvFrame(s, s.uv);
  Ctx c;
  c.lp = s.lpos; c.dlx = dFdx(s.lpos); c.dly = dFdy(s.lpos);
  c.curv = surfaceCurvature(s);
  // WOOD, TRUNK, FABRIC, ROOF, POOL_WATER, TILE, the interior surfaces and turned steel bring their own uv
  bool mapped = id == 7 || id == 10 || (id >= 12 && id <= 15) || (id >= 20 && id <= 23) || (id == 4 && s.mat.z > 4.5);
  if (mapped) c.f = uf; else c.f = pf;
  c.mapped = mapped;
  // --- the rest of the context
  vec3 an = abs(pf.Nl);
  c.tw = triplanarWeights(pf.Nl);
  c.seed = s.mat.w / 255.0;
  c.so = vec2(s.mat.w * 37.0 + s.objA.x * 113.0, s.mat.w * 91.0 + s.objA.x * 71.0);
  c.wall = 1.0 - abs(s.N.y);
  // patterns bound to one plane (streaks, cracks, trowel marks) are faded out along the line where the plane changes
  float hiN = max(an.x, max(an.y, an.z)), loN = min(an.x, min(an.y, an.z));
  c.seam = mapped ? 1.0 : smoothstep(0.0, 0.25, 2.0 * hiN + loN - an.x - an.y - an.z);
  c.upright = mapped || (an.y >= an.x && an.y >= an.z) ? 0.0 : smoothstep(0.25, 0.55, 1.0 - an.y) * c.seam;
  c.hgt = s.wpos.y - GROUND_Y;
  c.expo = smoothstep(0.2, 0.75, s.occ);
  c.rain = uWeather.y * c.expo * saturate(0.35 + 0.65 * s.N.y);
  c.col = s.color;
  if (s.color.g < 0.004 && s.color.r > 0.99 && s.color.b > 0.99) {
    int k = clamp(int(s.objA.y * 8.0), 0, 7);
    c.col = id == 12 ? TINT_FABRIC[k] : TINT_GENERAL[k];
  }
  o.albedo = c.col;

`;
const MAIN_TAIL = /* glsl */`
  // nothing outdoors returns more than about 85 percent of the light that falls on it; a metal's colour is its
  // mirror reflectance and may go higher
  o.albedo = min(o.albedo, vec3(mix(0.85, 0.96, o.metal)));
}
`;

/**
 * Every material in dispatch order: its id and the GLSL call that shades it. Inside the call, s, o and c are the
 * surface input, output and context, and uf is the uv frame.
 */
export const MATERIALS = Object.freeze([
  { id: SOLID.PAINT, call: 'matPaint(s, o, c)' },
  { id: SOLID.CONCRETE, call: 'matConcrete(s, o, c)' },
  { id: SOLID.STUCCO, call: 'matStucco(s, o, c)' },
  { id: SOLID.METAL_PAINTED, call: 'matMetalPainted(s, o, c)' },
  { id: SOLID.METAL_BARE, call: 'matMetalBare(s, o, c)' },
  { id: SOLID.DARK_GLASS, call: 'matDarkGlass(s, o, c)' },
  { id: SOLID.EMISSIVE, call: 'matEmissive(s, o, c)' },
  { id: SOLID.WOOD, call: 'matWood(s, o, c)' },
  { id: SOLID.RUBBER, call: 'matRubber(s, o, c)' },
  { id: SOLID.SIGN, call: 'matSign(s, o, c, textureGrad(uAtlasTex, s.uv, uf.dx, uf.dy))' },
  { id: SOLID.TRUNK, call: 'matTrunk(s, o, c)' },
  { id: SOLID.ROCK, call: 'matRock(s, o, c)' },
  { id: SOLID.FABRIC, call: 'matFabric(s, o, c)' },
  { id: SOLID.ROOF, call: 'matRoof(s, o, c)' },
  { id: SOLID.POOL_WATER, call: 'matPoolWater(s, o, c)' },
  { id: SOLID.TILE, call: 'matTile(s, o, c)' },
  { id: SOLID.NEON, call: 'matNeon(s, o, c)' },
  { id: SOLID.LAMP_LENS, call: 'matLampLens(s, o, c)' },
  { id: SOLID.PLASTIC, call: 'matPlastic(s, o, c)' },
  { id: SOLID.SKIN_CLOTH, call: 'matSkinCloth(s, o, c)' },
  { id: SOLID.EPOXY, call: 'matEpoxy(s, o, c)' },
  { id: SOLID.BLOCK, call: 'matBlock(s, o, c)' },
  { id: SOLID.GLASS_BLOCK, call: 'matGlassBlock(s, o, c)' },
  { id: SOLID.PEGBOARD, call: 'matPegboard(s, o, c)' },
]);

/**
 * Which ids are compiled into one shader. Each group stays near one and a half seconds in the Direct3D compiler
 * (measured per id on a Windows machine), which leaves the heavy materials alone; the light ones are paired with
 * what they usually share a mesh with, so a prop is drawn with as few programs as possible. Every id appears once.
 */
export const GROUPS = Object.freeze([
  [SOLID.PAINT], [SOLID.CONCRETE], [SOLID.STUCCO], [SOLID.METAL_PAINTED], [SOLID.METAL_BARE], [SOLID.DARK_GLASS],
  [SOLID.EMISSIVE, SOLID.LAMP_LENS],         // a luminaire: its lamp and its lens
  [SOLID.SIGN, SOLID.NEON],                  // a sign face and the tubes mounted on it
  [SOLID.WOOD, SOLID.RUBBER],
  [SOLID.FABRIC, SOLID.POOL_WATER],          // pool decks: umbrellas and loungers round the water
  [SOLID.PLASTIC, SOLID.SKIN_CLOTH],         // pedestrians and what they carry, street furniture
  [SOLID.TRUNK], [SOLID.ROCK], [SOLID.ROOF], [SOLID.TILE],
  [SOLID.EPOXY], [SOLID.BLOCK], [SOLID.GLASS_BLOCK, SOLID.PEGBOARD],   // the garage
].map((g) => Object.freeze(g)));

/** The else-if chain that runs the material of each listed id, in dispatch order. A pixel of any other id keeps the vertex colour. */
export function dispatchChain(ids) {
  const wanted = new Set(ids);
  for (const id of wanted) if (!MATERIALS.some((m) => m.id === id)) throw new Error(`solid: no material with id ${id}`);
  return MATERIALS.filter((m) => wanted.has(m.id)).map((m, i) => `  ${i ? 'else ' : ''}if (id == ${m.id}) ${m.call};\n`).join('');
}

/** The family's fragment source with only the listed ids dispatched (all of them by default). */
export function fragmentFor(ids = MATERIALS.map((m) => m.id)) {
  return COMMON + MASONRY + METALS + LIGHTS + ORGANIC + BUILT + INTERIOR + MAIN_HEAD + dispatchChain(ids) + MAIN_TAIL;
}


// Trunks belong to plants whose crowns are FOLIAGE: both must sway by the same amount or the crown tears off.
const DEFORM = PLANT_SWAY + NEON_WIDTH + /* glsl */`
void deform(inout vec3 p, inout vec3 n, in DeformIn d) {
  if (d.mat.x == 10.0) p += folPlantSway(p, d.objA, d.objB, d.origin, d.time);
  else if (d.mat.x == 16.0) p += n * neonWiden(distance(d.origin + p, uCamPos.xyz), d.mat);
}
`;

export default {
  name: 'solid',
  fragment: fragmentFor(),
  materials: MATERIALS,
  groups: GROUPS,
  fragmentFor,
  deform: DEFORM,
  alphaTest: false,
  twoSided: false,
};
