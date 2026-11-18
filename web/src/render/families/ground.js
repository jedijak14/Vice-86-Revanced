// GROUND surface family: everything the city stands on. Roads with their lane markings, pavements, kerbs, sand,
// grass, parking lots, dirt, bridge decks, airport tarmac and medians, and the way all of them respond to rain.
//
// Vertex contract (design/ARCHITECTURE.md section 5.2, src/world/roads/README.md section 1):
//   road surfaces (ASPHALT, DECK, TARMAC)  uv = (lateral, station) in metres, vertex alpha = marking weight
//   KERB                                   uv = (metres across the profile from the gutter line, metres along the run)
//   SIDEWALK, PAVERS                       uv = (metres to the kerb line, metres to the building line), 99 = none;
//                                          vertex alpha = blend distance / BLEND_REACH when p1 names a second material
//   every other material                   pattern from world position; uv = (blend distance, extra dampness)
//   MARKING decals                         uv = decal-local metres, colour = paint, vertex alpha = the road's marking weight
//   vertex colour rgb                      multiplicative tint, white = the material's own colour
//
// How the shader is organised. Each material fills a Layer (colour, relief, how it takes water). A triangle may
// name a second material to blend into; both layers are then mixed along a noise-broken edge. One wet response
// runs on the mixed result, so a puddle crosses a material boundary the way water does. Nothing inside the
// per-material branches uses implicit derivatives: the pixel footprint is measured once at the top and passed to
// explicit-gradient texture fetches, which keeps the branches real branches on every shader compiler.
//
// Lane geometry is defined once in src/world/roads/lanes.js; its constants are spliced into the GLSL below.

import { GROUND } from '../../core/ids.js';
import { LANE, LANE_FLAG, LOT, BLEND_REACH, KERB } from '../../world/roads/lanes.js';
import { MARKING_LANE_UNIT } from '../../world/roads/markings.js';

const glsl = (x) => Number(x).toFixed(4);
const IDS = Object.entries(GROUND).map(([name, id]) => `#define G_${name} ${id}`).join('\n');
const LANE_DEFS = Object.entries(LANE).map(([name, v]) => `#define LANE_${name} ${glsl(v)}`).join('\n')
  + Object.entries(LANE_FLAG).map(([name, v]) => `\n#define FLAG_${name} ${v}`).join('')
  + `\n#define LOT_BAY ${glsl(LOT.BAY_DEPTH)}\n#define LOT_MODULE ${glsl(LOT.MODULE)}\n#define BLEND_REACH ${glsl(BLEND_REACH)}`
  + Object.entries(KERB).map(([name, v]) => `\n#define KERB_${name} ${glsl(v)}`).join('');

/**
 * The aggregate of the asphalt. COARSE, FINE and WARP are noise-texture texels per metre (a cell of the distance
 * channel is 8 texels, so 13 mm and 6 mm stones); RELIEF is how far a stone stands out of the binder in metres.
 * The three means are what the stone field averages to over the noise texture; the shader fades to them where
 * single stones can no longer be resolved, and test/roads checks them against the texture.
 */
export const STONE = Object.freeze({ COARSE: 600, FINE: 1300, WARP: 900, RELIEF: 0.0016, TOP_MEAN: 0.4285, SHADE_MEAN: 0.8286, CS_MEAN: 0.4272 });
const STONE_DEFS = Object.entries(STONE).map(([name, v]) => `#define STONE_${name} ${glsl(v)}`).join('\n');

/** Lift of MARKING decals above the road: base in metres plus a fraction of the camera distance (also used by tests). */
export const MARKING_LIFT = Object.freeze({ BASE: 0.004, PER_METRE: 0.0005 });

// ---------------------------------------------------------------------------------------------- shared pieces
const COMMON = /* glsl */`
${IDS}
${LANE_DEFS}
${STONE_DEFS}
#define MARKING_LANE_UNIT ${glsl(MARKING_LANE_UNIT)}

// Per-pixel context, set once in surface() before any branch.
vec2 gP;          // world (x, z) in metres
vec2 gDx, gDy;    // its screen-space derivatives
float gPx;        // pixel footprint in metres: the filter width for every antialiased edge
float gNear;      // 1 where millimetre detail is resolvable, 0 where it must have faded out
float gStone;     // 1 where single road stones are resolved, 0 where they have merged into their average
float gStoneN;    // the same for their relief, which must go earlier than their colour
vec3 gAlong;      // KERB only: unit world direction in which the station (uv.y) grows
vec3 gV;          // unit vector to the camera
float gGraze;     // 0 looking straight down at the ground, 1 at a grazing angle
float gY;         // world height in metres
vec2 gBlendDir;   // unit world (x, z) direction in which the blend distance (uv.x) grows; zero if it does not vary

struct Layer {
  vec3 albedo;
  vec2 slope;      // surface slope in world (x, z): dh/dx, dh/dz
  float rough;
  float ao;
  float height;    // 0..1 relief; high spots win a blend edge and dry first
  float porosity;  // 0..1 how much the material darkens when it soaks up water
  float pool;      // puddle bias: positive collects water early; -1 or less never holds standing water
  float sheen;     // 0..1 how readily a film of rain makes it glossy
  float coat;      // clear coat when dry (fresh paint)
  float bead;      // 0..1 retro-reflective glass beads (road paint)
  vec3 silt;       // colour of the water that stands on it (zero = clear)
  float damp;      // 0..1 water the material already holds whatever the weather (tide-wet sand, a drain outfall)
  float film;      // 0..1 standing sheet of water that is not rain (the swash on a beach)
};
Layer newLayer(vec3 albedo, float rough) {
  Layer L; L.albedo = albedo; L.slope = vec2(0.0); L.rough = rough; L.ao = 1.0; L.height = 0.5; L.porosity = 0.6;
  L.pool = 0.0; L.sheen = 0.7; L.coat = 0.0; L.bead = 0.0; L.silt = vec3(0.0); L.damp = 0.0; L.film = 0.0; return L;
}

// Noise texture at k texels per metre (features of 16 / k metres), filtered with the pixel footprint. p in metres.
vec4 gn(vec2 p, float k) { float s = k * (1.0 / 256.0); return textureGrad(uNoiseTex, p * s, gDx * s, gDy * s); }
// Two random slope components at k texels per metre for surface grain. Sampled three mip levels coarser than the
// colour detail: a bump must span several pixels before it may tilt the normal, or grazing light turns it into glitter.
vec2 grit(vec2 p, float k) { float s = k * (1.0 / 256.0); return textureGrad(uNoiseTex, p * s, gDx * (s * 6.0), gDy * (s * 6.0)).rg - 0.5; }
// The same through a 2x2 matrix, for stretched or rotated detail (grass blades, broom finish, wind streaks).
vec4 gnm(vec2 p, mat2 m) { m *= 1.0 / 256.0; return textureGrad(uNoiseTex, m * p, m * gDx, m * gDy); }
// Slope of the r channel at k texels per metre by central differences, in units of height per metre for an
// amplitude of one. Four fetches: use it for relief that carries the look (churned sand, clods), not for grit.
vec2 gslope(vec2 p, float k) {
  float e = 1.5 / k;
  return vec2(gn(p + vec2(e, 0.0), k).r - gn(p - vec2(e, 0.0), k).r, gn(p + vec2(0.0, e), k).r - gn(p - vec2(0.0, e), k).r) / (2.0 * e);
}
// Pattern rotation from a heading byte: out.y runs along the heading. Matches patternCoords() in lanes.js.
mat2 headingFrame(float byte) { float a = byte * (PI / 256.0), c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// Fade for relief of the given size in metres that tilts the normal: gone well before it shrinks to a pixel (see grit).
float relief(float size) { return 1.0 - smoothstep(0.08, 0.3, gPx / size); }
// Fade for detail of the given size in metres: 1 while it spans a few pixels, 0 once it is below one.
float visible(float size) { return 1.0 - smoothstep(0.35, 1.2, gPx / size); }
`;

// ---------------------------------------------------------------------------------------------- asphalt and lanes
const ROAD = /* glsl */`
struct Lanes { float n, W, edge, inner, gutter; bool oneWay, median, open, marked, parking; };

// Lane layout from the half width and the lane code. Mirrors laneLayout() in src/world/roads/lanes.js line for line.
Lanes laneFrame(float hw, float code, bool deck) {
  int c = int(code + 0.5); Lanes L;
  L.n = float(max(c & 7, 1)); L.oneWay = (c & FLAG_ONE_WAY) != 0; L.median = (c & FLAG_MEDIAN) != 0;
  L.open = deck || (c & FLAG_OPEN_SHOULDER) != 0; L.marked = (c & FLAG_NO_MARKINGS) == 0;
  L.gutter = L.open ? 0.0 : LANE_GUTTER; L.inner = 0.0; L.parking = false;
  float limit = hw - L.gutter - (L.open ? LANE_SHOULDER_SHY : LANE_SHY);
  if (L.median) { L.W = min(LANE_MEDIAN, (limit - LANE_MEDIAN_SHY) / L.n); L.edge = limit; L.inner = L.edge - L.n * L.W; }
  else {
    float across = L.oneWay ? 2.0 * limit : limit, sides = L.oneWay ? 2.0 : 1.0, per = L.oneWay ? 0.5 : 1.0;
    if (L.open) { L.W = min(LANE_OPEN, across / L.n); L.edge = L.n * L.W * per; }
    else if ((across - sides * LANE_PARKING) / L.n >= LANE_MIN) { L.W = min(LANE_MAX, (across - sides * LANE_PARKING) / L.n); L.edge = L.n * L.W * per; L.parking = true; }
    else { L.W = across / L.n; L.edge = limit; }
    if (L.oneWay) L.inner = -L.edge;
  }
  return L;
}

// Position inside the lane the pixel is in: x = metres from the lane centre, y = 1 on a traffic lane and 0 outside,
// z = a number that differs from lane to lane, w = direction of travel along the station (+1 or -1).
vec4 laneLocal(float lat, Lanes L) {
  bool across = L.oneWay && !L.median;
  float x = across ? lat + L.edge : abs(lat) - L.inner, k = floor(x / L.W);
  float inside = step(0.0, x) * step(x, L.n * L.W), dir = across || lat > 0.0 ? 1.0 : -1.0;
  return vec4((x / L.W - k - 0.5) * L.W, inside, (k + 1.0) * dir, dir);
}

// Painted lane lines: x = white coverage, y = yellow coverage. uv = (lateral, station).
vec2 laneLines(vec2 uv, Lanes L) {
  if (!L.marked) return vec2(0.0);
  float h = 0.5 * LANE_LINE, w = gPx, x = abs(uv.x), white = 0.0, yellow = 0.0;
  // thermoplastic is laid by a moving screed: the edge wanders a few millimetres
  float wob = (gn(uv, 90.0).r - 0.5) * 0.012 * gNear; x += wob;
  float dash = pulseTrain(uv.y / LANE_DASH_PERIOD, LANE_DASH / LANE_DASH_PERIOD, w / LANE_DASH_PERIOD);
  bool across = L.oneWay && !L.median;
  float from = across ? -L.edge : L.inner, t = across ? uv.x + wob : x;
  if (L.n > 1.5) { float k = clamp(floor((t - from) / L.W + 0.5), 1.0, L.n - 1.0); white += aaline(t - from - k * L.W, h, w) * dash; }
  if (across) { yellow += aaline(uv.x + L.edge, h, w); white += aaline(uv.x - L.edge, h, w); }
  else {
    if (L.median) yellow += aaline(x - L.inner, h, w); else yellow += aaline(x - LANE_CENTRE_GAP, h, w);
    if (L.parking || L.open || L.median || L.n > 1.5) white += aaline(x - L.edge, h, w);
  }
  if (L.parking) {   // bay ticks reaching from the parking line towards the kerb
    float s = uv.y / LANE_BAY, d = (s - floor(s + 0.5)) * LANE_BAY;
    white += aaline(d, h, w) * aastep(L.edge, x, w) * (1.0 - aastep(L.edge + LANE_BAY_TICK, x, w));
  }
  return saturate(vec2(white, yellow));
}

// Height of the road's stone, 0 in the binder between stones and 1 on a stone top: crushed aggregate of two sizes
// (cells of the noise texture's distance channel, 13 mm and 6 mm across) with outlines pushed out of round.
float stoneField(vec2 p, out float tone) {
  vec4 w = gn(p + 0.37, STONE_WARP); float warp = (w.r - 0.5) * 0.3; tone = w.g;
  float c = gn(p, STONE_COARSE).a, f = gn(vec2(p.y - 0.4 * p.x, p.x + 0.4 * p.y) + 3.3, STONE_FINE).a;
  return max(1.0 - smoothstep(0.2, 0.38, c + warp), 0.75 * (1.0 - smoothstep(0.2, 0.38, f - warp)));
}

// Bituminous surface without any road furniture.
//   age    0 fresh and black .. 1 old: binder weathered grey, stone showing
//   wear   0..1 traffic polish: tyres strip the binder film off the stone tops and close the texture
//   bleed  0..1 binder flushed to the surface: blacker, smoother, the stones drowned
// top returns the stone height, which paint and water need. Beyond the distance at which single stones can be
// resolved every term moves to its measured average, so the far road is a steady tone and not a field of sparkles.
Layer asphaltSurface(vec2 p, float age, float wear, float bleed, out float top) {
  vec4 macro = gn(p, 0.35), meso = gn(p + 31.7, 5.0);
  float tone, h = stoneField(p, tone);
  float shade = 1.0 - 0.3 * (1.0 - h), cs = smoothstep(0.3, 0.75, h) * shade;
  top = mix(STONE_TOP_MEAN, h, gStone); shade = mix(STONE_SHADE_MEAN, shade, gStone); cs = mix(STONE_CS_MEAN, cs, gStone);
  vec3 binder = mix(vec3(0.034, 0.035, 0.038), vec3(0.08, 0.078, 0.072), pow(age, 0.8)) * (1.0 - 0.55 * bleed);
  vec3 rock = mix(vec3(0.085, 0.082, 0.076), vec3(0.28, 0.268, 0.24), mix(0.5, tone, gStone));
  float bare = saturate(0.12 + 0.7 * age + 0.55 * wear) * (1.0 - 0.85 * bleed);
  vec3 col = binder * shade + (rock - binder) * (bare * cs);
  // the mix was never even: loads from different days, sun on one side of the street, damp that lingers
  col *= (0.86 + 0.28 * macro.r) * (0.92 + 0.16 * meso.g);
  Layer L = newLayer(col, mix(mix(0.90, 0.96, age), 0.74, wear * 0.7));
  L.rough = mix(L.rough, 0.5, bleed) - 0.06 * (meso.g - 0.5);
  if (gStoneN > 0.0) {
    // the stones stand a couple of millimetres proud; the normal comes from that height, not from noise
    const float e = 0.0012; float unused;
    vec2 d = vec2(stoneField(p + vec2(e, 0.0), unused), stoneField(p + vec2(0.0, e), unused)) - h;
    L.slope = d * (STONE_RELIEF / e) * (1.0 - 0.7 * bleed) * (1.0 - 0.35 * wear) * gStoneN;
  }
  // what was relief up close is roughness from afar
  L.rough = min(L.rough + 0.05 * (1.0 - gStoneN) * (1.0 - bleed), 0.97);
  L.height = 0.28 + 0.44 * top + 0.28 * meso.g; L.porosity = mix(0.6, 0.85, age) * (1.0 - 0.5 * bleed); L.sheen = mix(1.0, 0.85, age);
  L.pool = (0.5 - meso.g) * 0.05;
  L.ao = 1.0 - 0.25 * (1.0 - shade) * (1.0 - bleed);
  return L;
}

// Asphalt away from traffic lanes (lots, aprons, the far side of a blend): patchy binder, no wheel paths.
Layer asphaltBase(vec2 p, float age) {
  vec4 n = gn(p + 13.0, 2.3); float top;
  return asphaltSurface(p, age, 0.15 * n.r, smoothstep(0.7, 0.9, n.g) * (1.0 - 0.6 * age), top);
}

// Hot-poured sealant along cracks and the saw cuts of repairs: black, slightly proud of the road, and dull once it
// has weathered and taken up dust. Kept matt on purpose: a glossy band mirrors the sky at a grazing angle and the
// crack reads as a thin blue line instead of a dark one.
void tarSeal(inout Layer L, float m) {
  L.albedo = mix(L.albedo, vec3(0.021, 0.02, 0.018), m); L.rough = mix(L.rough, 0.78, m); L.slope *= 1.0 - 0.9 * m;
  L.height = mix(L.height, 0.95, m); L.porosity *= 1.0 - m; L.sheen = mix(L.sheen, 1.0, m); L.ao = mix(L.ao, 1.0, m);
}

const vec3 PAINT_WHITE = vec3(0.56, 0.555, 0.52), PAINT_YELLOW = vec3(0.55, 0.38, 0.05);

// Road paint over a layer. cov = geometric coverage, wear 0..1 (above 1 in wheel paths), top = stone height under
// it, p = coordinates the wear pattern lives in. Paint is a film on the stone tops; tyres take it off there first,
// so worn paint is what is left in the texture between the stones, in flecks, and goes grey with rubber and dirt.
void roadPaint(inout Layer L, vec3 colour, float cov, float wear, float top, vec2 p) {
  if (cov <= 0.0) return;
  float n = 0.6 * gn(p, 70.0).r + 0.4 * gn(p + 7.1, 260.0).g, slow = gn(p + 3.7, 1.9).g;
  // no two metres of a line wear alike: one stretch is nearly whole, the next half gone
  wear *= 0.55 + 0.9 * slow;
  float left = 1.0 - wear * (0.25 + n + 1.3 * top);
  // close up the film ends at a line; from afar a worn marking is simply fainter
  float m = cov * smoothstep(mix(-0.25, 0.02, gStone), mix(0.75, 0.2, gStone), left);
  // what is left is grey with rubber and road dirt, and the pigment has chalked
  float dull = saturate(wear);
  vec3 film = mix(colour, vec3(luma(colour)) * 0.9, 0.3 * dull) * (0.66 + 0.28 * n) * mix(1.0, 0.62, dull);
  L.albedo = mix(L.albedo, film, m); L.rough = mix(L.rough, 0.52 + 0.2 * saturate(wear), m); L.slope *= 1.0 - 0.55 * m;
  L.height = mix(L.height, 0.9, m); L.porosity = mix(L.porosity, 0.15, m); L.ao = mix(L.ao, 1.0, m);
  L.bead = max(L.bead, m * (1.0 - 0.6 * saturate(wear)));
}

// A utility repair: at most one per 11 m cell of the world, so it lies the same for the road, the junction and any
// decal painted across it. Returns x = 1 inside, y = sealant on its saw cuts, z = the age of its own asphalt (0..1),
// w = 1 if it was laid after the lines were last painted. A repair never matches the road around it: three in four
// are clearly newer and blacker with their sealant still on the cuts, the rest are from an earlier dig, greyer than
// the road, sealant long gone. Without that difference only the black outline would show, like the edge of a tile.
vec4 repairPatch(vec2 p, float age) {
  vec2 cell = floor(p / 11.0); vec3 h = hash32(cell + 91.0), k = hash32(cell + 17.0);
  if (h.x > age * 0.6 + 0.1) return vec4(0.0);
  vec2 q = p - (cell + 0.5) * 11.0 - (h.yz - 0.5) * 3.0;
  // trenches follow the street grid give or take a careless saw; one in five lies at any angle
  float a = k.x < 0.8 ? floor(k.y * 2.0) * (0.5 * PI) + (k.z - 0.5) * 0.4 : k.y * PI, c = cos(a), s = sin(a);
  q = vec2(c * q.x + s * q.y, c * q.y - s * q.x);
  vec2 ext = vec2(0.4 + 0.9 * k.z, 0.6 + 2.2 * h.y), e = ext - abs(q);
  float inside = aastep(0.0, min(e.x, e.y), gPx);
  // the saw overruns every corner; the sealant follows the cuts, poured by hand, wider here and thinner there
  float pour = 0.022 + 0.018 * gn(p, 21.0).r, over = 0.1 + 0.12 * k.x;
  float seal = max(aaline(e.x, pour, gPx) * aastep(-over, e.y, gPx), aaline(e.y, pour, gPx) * aastep(-over, e.x, gPx));
  float earlier = step(h.z, 0.25);
  float own = mix(age * (0.08 + 0.3 * h.z), min(1.0, age + 0.3 + 1.6 * h.z), earlier);
  return vec4(inside, seal * (1.0 - earlier), own, step(0.4, k.y) * (1.0 - earlier));
}

// Cracks, anchored to the world like the repairs. x = sealed with tar (wandering lines several metres long),
// y = open hairlines (a fine net where the road is old and tired).
vec2 roadCracks(vec2 p, float age, float fatigue) {
  // thermal cracks run across and along the street in wandering lines some metres apart; slow noise bends them,
  // faster noise makes them ragged, and each line exists or not by its own number
  vec4 a = gn(p, 1.3); float jag = (gn(p + 4.0, 26.0).g - 0.5) * 0.09;
  vec2 f = p + (a.rg - 0.5) * 5.0 + jag, n = f / vec2(13.0, 17.0), id = floor(n);
  vec2 d = abs(fract(n) - 0.5) * vec2(13.0, 17.0) * 0.8;                    // 0.8: the bends shorten the distance
  vec2 there = step(vec2(hash12(vec2(id.x, 5.0)), hash12(vec2(9.0, id.y))), vec2(0.35 + 0.6 * age))
             * smoothstep(0.42, 0.5, vec2(a.g, a.r) + 0.25 * age);          // and starts and ends somewhere
  float w = 0.012 + 0.013 * gn(p + 2.0, 3.1).g;                               // overbanded by the sealing crew: 25 to 50 mm
  float sealed = max(aaline(d.x, w, gPx) * there.x, aaline(d.y, w, gPx) * there.y);
  float hair = 0.0, show = visible(0.006) * smoothstep(0.35, 0.8, age + 0.5 * fatigue);
  if (show > 0.0) {
    vec4 b = gn(p + 71.0, 9.0); const float f = 0.18;
    vec4 bx = gn(p + 71.0 + vec2(f, 0.0), 9.0), bz = gn(p + 71.0 + vec2(0.0, f), 9.0);
    float d1 = abs(b.r - 0.5) / max(length(vec2(bx.r, bz.r) - b.r) / f, 0.05), d2 = abs(b.g - 0.5) / max(length(vec2(bx.g, bz.g) - b.g) / f, 0.05);
    float where = smoothstep(0.5, 0.7, gn(p + 9.0, 1.6).g + 0.3 * fatigue + 0.25 * (age - 0.5));
    // the second family only joins in where the road is failing: that is what makes a net of it
    hair = max(aaline(d1, 0.0018, gPx), aaline(d2, 0.0018, gPx) * smoothstep(0.6, 0.9, where + 0.3 * fatigue)) * where * show;
  }
  return vec2(sealed, hair);
}

float segDist(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * saturate(dot(pa, ba) / dot(ba, ba))); }

// Locator's spray paint ahead of street works: a line with an arrow head and a tick or a second line, in the colour
// of the service underneath. One candidate per 23 m cell of the world. rgb = paint, a = coverage.
vec4 sprayMarks(vec2 p) {
  vec2 cell = floor(p / 23.0); vec3 h = hash32(cell + 51.0);
  if (h.x > 0.42) return vec4(0.0);
  vec3 k = hash32(cell + 7.0);
  vec2 q = p - (cell + 0.5) * 23.0 - (h.yz - 0.5) * 12.0;
  float a = floor(k.x * 4.0) * (0.5 * PI) + (k.y - 0.5) * 0.5, c = cos(a), s = sin(a), len = 0.9 + 2.2 * k.z;
  q = vec2(c * q.x + s * q.y, c * q.y - s * q.x);
  if (abs(q.x) > 0.9 || abs(q.y) > len + 0.5) return vec4(0.0);
  q.x += (gn(p, 9.0).r - 0.5) * 0.1;                                       // nobody draws straight with a can at arm's length
  float d = min(segDist(q, vec2(0.0, -len), vec2(0.0, len)), min(segDist(q, vec2(0.0, len), vec2(-0.2, len - 0.28)), segDist(q, vec2(0.0, len), vec2(0.2, len - 0.28))));
  d = min(d, k.y < 0.5 ? segDist(q, vec2(-0.28, -0.4 * len), vec2(0.28, -0.4 * len)) : segDist(q, vec2(0.3, -len), vec2(0.3, 0.2 * len)));
  float cov = 1.0 - smoothstep(0.012, 0.034 + gPx, d);                    // a soft-edged line about 5 cm wide
  vec3 col = h.y < 0.3 ? vec3(0.62, 0.17, 0.03) : (h.y < 0.55 ? vec3(0.05, 0.16, 0.5) : (h.y < 0.8 ? vec3(0.55, 0.55, 0.52) : vec3(0.5, 0.05, 0.25)));
  return vec4(col, cov * (0.5 + 0.5 * k.x));
}

// Rubber from a locked-wheel stop: two tracks one axle apart that slew as the car slows and darken towards the
// point where it stopped. c = metres from the lane centre, s = station, lane.zw from laneLocal(), span = cell length.
float skidMarks(float c, float s, vec2 lane, float span, float chance) {
  float t = s * lane.y / span, cell = floor(t); vec3 h = hash32(vec2(cell, lane.x * 7.0 + span));
  if (h.x > chance) return 0.0;
  float len = span * (0.25 + 0.45 * h.y), u = (t - cell) * span - (span - len) * h.z;     // metres along the mark, the way the car went
  if (u < 0.0 || u > len) return 0.0;
  vec3 g = hash32(vec2(cell + 31.0, lane.x * 3.0 + span)); float k = u / len;
  float x = c - (g.z - 0.5) * 0.5 - (g.x - 0.5) * 0.5 * k - (g.y - 0.5) * 0.7 * k * k;
  float w = 0.085 + gPx, rib = gn(vec2(x * 3.0, u * 0.05), 40.0).r;         // tread ribs: streaks along the mark
  float left = 1.0 - smoothstep(w * 0.6, w, abs(x + 0.75)), right = 1.0 - smoothstep(w * 0.6, w, abs(x - 0.75));
  float body = smoothstep(0.0, 0.2, k) * (0.3 + 0.7 * k * k) * (1.0 - smoothstep(len - 0.25, len, u));
  return max(left * (0.6 + 0.4 * g.x), right * (0.6 + 0.4 * g.y)) * body * (0.55 + 0.45 * rib);
}

// What traffic does to a road, by position in the lane. All zero inside junctions, where there are no lanes.
// run = slow drift along the lane (0..1, 0.5 where there is no lane), tone = a number that differs from lane to lane.
struct Traffic { float path, centre, approach, verge, run, tone; };

// Carriageway asphalt with everything that happens to it except lane paint: repairs, cracks, oil, wear and the
// spray of the next street works. Shared by roads, junctions and decals so that they agree wherever they meet.
// top = stone height (for paint), cut = paint removed here by tar or by a repair laid after the last repaint.
Layer roadBase(vec2 p, float age, Traffic tr, out float top, out float cut) {
  vec4 rep = repairPatch(p, age), slow = gn(p + 13.0, 2.3), drift = gn(p + 47.0, 0.9);
  float localAge = mix(age, rep.z, rep.x);
  // polish in the wheel paths; the kerbside half-metre is never driven on
  float wear = saturate(0.08 + 0.16 * slow.r + tr.path * (0.55 + 0.35 * age)) * (1.0 - 0.6 * rep.x);
  // binder flushed to the surface by heat and load: long smears in the wheel paths on some stretches. Never in
  // clouds across the road, which read as stains from a leak or as a bad shadow.
  float bleed = 0.35 * tr.path * smoothstep(0.6, 0.95, tr.run + 0.15 * age) * (1.0 - 0.5 * localAge);
  // a recent repair still has its binder film over the stones: blacker and smoother than anything around it
  bleed = mix(bleed, 0.35 * step(rep.z, age), rep.x);
  Layer L = asphaltSurface(p + rep.x * 57.0, localAge, wear, bleed, top);
  // one lane was resurfaced in a different year from the next, the tone drifts slowly along the road, and the
  // large-scale unevenness of the mix is only a few per cent
  L.albedo *= (0.94 + 0.12 * tr.tone) * (0.95 + 0.1 * tr.run) * (1.0 - 0.04 * smoothstep(0.5, 0.9, slow.g));
  L.albedo *= 1.0 - 0.08 * tr.path * (0.5 + gn(p, 7.0).g);                  // a film of rubber dulls the polished stone
  L.height += 0.06 * rep.x; L.pool -= 0.03 * rep.x + 0.02 * tr.centre;

  // oil: round stains where something stood and dripped, a broken stripe down the middle of every lane, a mat of it
  // where traffic queues. Soaks in, so it is dark and less rough rather than shiny.
  // the drip stripe is splotchy, not dotted: plain noise, never the cellular channel, which lays out its dots in rows
  vec4 spot = gn(p + 3.0, 5.0); float drip = 0.5 * gn(p + 29.0, 23.0).r + 0.5 * gn(p + 29.0, 46.0).g;
  float oil = (1.0 - smoothstep(0.1, 0.3 + 0.2 * slow.b, spot.a)) * smoothstep(0.66, 0.82, drift.g) * 0.5;
  oil = max(oil, tr.centre * saturate((0.35 + 0.4 * age) * smoothstep(0.3, 0.75, slow.r + 0.3 * drift.r) + tr.approach * 0.6) * (0.55 + 0.45 * smoothstep(0.35, 0.65, drip)));
  oil *= 1.0 - 0.7 * rep.x;
  L.albedo *= 1.0 - 0.6 * oil; L.rough -= 0.2 * oil; L.porosity *= 1.0 - 0.6 * oil; L.slope *= 1.0 - 0.4 * oil;

  // dust and grit lie where no tyre sweeps them away
  float dust = tr.verge * (0.45 + 0.55 * slow.b);
  L.albedo = mix(L.albedo, vec3(0.19, 0.17, 0.14) * (0.8 + 0.4 * spot.r), 0.4 * dust); L.rough = mix(L.rough, 0.95, 0.5 * dust);

  vec2 crack = roadCracks(p, age, tr.path) * (1.0 - rep.x);
  L.albedo *= 1.0 - 0.75 * crack.y; L.height -= 0.3 * crack.y; L.ao *= 1.0 - 0.4 * crack.y;
  float tar = max(crack.x, rep.y);
  tarSeal(L, tar);
  cut = max(tar, rep.x * rep.w);
  return L;
}

// Spray marks go on last and wear like any thin paint.
void roadSpray(inout Layer L, vec2 p, float top, float wear) {
  vec4 spray = sprayMarks(p);
  if (spray.a > 0.0) roadPaint(L, spray.rgb, spray.a, 0.45 + 0.5 * wear, top, p);
}

// Traffic terms from the distance to the lane centre.
Traffic trafficAt(float c, float inside, float approach, float verge, float run, float tone) {
  Traffic tr; c = abs(c); tr.run = run; tr.tone = tone;
  tr.path = exp(-pow((c - 0.86) / 0.3, 2.0)) * inside;     // the two wheel paths of a lane
  tr.centre = exp(-pow(c / 0.4, 2.0)) * inside;            // where engines drip
  tr.approach = approach; tr.verge = verge;
  return tr;
}

// Concrete gutter pan against a kerb. g = metres from the kerb face, s = station.
void gutterPan(inout Layer L, float g, float s, float width, float pan) {
  if (pan <= 0.0) return;
  vec4 n = gn(vec2(g * 4.0, s * 0.5), 14.0), fine = gn(vec2(g, s), 300.0);
  float joint = aaline(fract(s / 3.0 + 0.5) * 3.0 - 1.5, 0.005, gPx);
  // the kerb line is where everything the rain moves ends up: silt, leaf mould, cigarette ends
  float silt = 1.0 - smoothstep(0.02, 0.12 + 0.2 * n.g, g), litter = (1.0 - aastep(0.05 + 0.05 * fine.b, gn(vec2(g, s), 30.0).a, gPx * 6.0)) * silt * visible(0.02);
  vec3 conc = vec3(0.215, 0.205, 0.19) * (0.6 + 0.5 * n.r) * (0.9 + 0.2 * fine.b) * (0.8 + 0.3 * gn(gP + 5.0, 3.0).g);
  conc = mix(conc, vec3(0.055, 0.047, 0.038), 0.8 * silt); conc = mix(conc, vec3(0.16, 0.11, 0.06) * (0.4 + fine.r), litter);
  conc *= 1.0 - 0.7 * joint;
  L.albedo = mix(L.albedo, conc, pan); L.rough = mix(L.rough, 0.88, pan); L.slope = mix(L.slope, (fine.rg - 0.5) * 0.25 * relief(0.02), pan);
  L.height = mix(L.height, 0.5 - 0.3 * joint, pan); L.porosity = mix(L.porosity, 0.7, pan); L.sheen = mix(L.sheen, 0.8, pan); L.ao = mix(L.ao, 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.05, g)), pan);
  // it falls to the kerb, so water gathers along it, but in a chain of pools and not a canal
  L.pool = mix(L.pool, 0.05 + 0.1 * (1.0 - g / width), pan);
  tarSeal(L, aaline(g - width, 0.011, gPx) * 0.85 * step(0.5, pan + 0.5));
}

// A kerbed or open road. uv = (lateral, station). weight = marking weight: 1 on a free-running leg, falling to 0.5
// at a stop line, 0 inside junctions; between 0.12 and 0.5 only the gutter pan is drawn (the fillets of a junction).
Layer asphaltRoad(vec2 uv, float hw, float code, float age, float weight) {
  float on = aastep(0.5, weight, 0.02), top, cut;      // uv means lanes only where the weight says so
  Lanes ln = laneFrame(hw, code, false);
  float x = abs(uv.x), g = hw - x, approach = saturate(2.0 - 2.0 * weight) * on;   // 1 at the stop line, 0 where the queue ends
  vec4 lane = laneLocal(uv.x, ln);
  float pan = ln.gutter > 0.0 ? (1.0 - aastep(ln.gutter, g, gPx)) * aastep(0.12, weight, 0.02) : 0.0;
  // the drift noise is eight times longer along the lane than across it; the lane tone fades out towards a stop
  // line, where the decals that continue the asphalt know nothing of the lanes
  float run = gn(vec2(uv.x, uv.y * 0.12), 9.0).g, tone = mix(hash12(vec2(lane.z, hw + 255.0 * age)), 0.5, approach);
  Traffic tr = trafficAt(lane.x, lane.y * on, approach, on * (1.0 - smoothstep(0.0, 0.5, g - ln.gutter)) * (1.0 - pan), mix(0.5, run, on), mix(0.5, tone, lane.y * on));
  Layer L = roadBase(gP, age, tr, top, cut);
  if (on > 0.0) {
    // rubber laid down braking into the stop line, heaviest in the wheel paths but over the whole lane, and the odd pair of skid marks
    float rubber = (0.25 * lane.y + 0.75 * tr.path) * approach * (0.3 + 0.4 * gn(uv * vec2(3.0, 0.3), 12.0).g);
    float skid = lane.y * on * max(skidMarks(lane.x, uv.y, lane.zw, 34.0, 0.2), approach * skidMarks(lane.x, uv.y, lane.zw, 19.0, 0.6));
    L.albedo *= 1.0 - 0.45 * rubber; L.rough -= 0.05 * rubber;
    // crown and gutter: water runs to the kerb; wheel ruts hold some on the way
    L.pool += on * (0.09 * smoothstep(0.4, 1.0, x / hw) - 0.045 + 0.05 * tr.path * age);
    vec2 lines = laneLines(uv, ln) * on * (1.0 - cut);
    float wear = 0.36 + 0.4 * age + 0.3 * tr.path;        // even a young road has been driven on since it was painted
    roadPaint(L, PAINT_WHITE, lines.x, wear, top, uv); roadPaint(L, PAINT_YELLOW, lines.y, wear * 0.9, top, uv);
    L.albedo = mix(L.albedo, vec3(0.012), 0.8 * skid); L.rough = mix(L.rough, 0.62, 0.6 * skid);
  } else L.pool += 0.015;
  roadSpray(L, gP, top, age);
  gutterPan(L, g, uv.y, ln.gutter, pan);
  return L;
}
`;

// ---------------------------------------------------------------------------------------------- paved surfaces
const PAVED = /* glsl */`
// Cast concrete in slabs. q = pattern coordinates in metres, slab = slab size, joint = tooled joint width.
// Carries what all concrete outdoors has: slab-to-slab tone, a broom finish, rain stains, dirt in the joints.
Layer concreteSlabs(vec2 q, vec3 tint, float slab, float joint, float grime, out vec2 id, out vec2 c) {
  float jm = tilePattern(q, slab, joint, gPx, id, c); vec3 h = hash32(id + 5.0);
  float stain = gn(q, 2.6).r, mottle = gn(q + 11.0, 11.0).g, broom = gnm(q, mat2(1400.0, 0.0, 0.0, 60.0)).r;
  vec4 sand_ = gn(q, 520.0);
  vec2 e = 0.5 * slab - abs(c); float nearJoint = 1.0 - smoothstep(0.0, 0.16, min(e.x, e.y)), edgeDirt = 1.0 - smoothstep(0.0, 0.03 + gPx, min(e.x, e.y));
  // no two slabs came out of the same mix or have weathered alike: tone and a little hue differ from slab to slab
  vec3 col = tint * (0.80 + 0.32 * h.x) * mix(vec3(1.04, 1.0, 0.94), vec3(0.96, 1.0, 1.05), h.z) * (0.84 + 0.2 * mottle + 0.04 * broom) * (0.92 + 0.16 * sand_.b);
  col *= 1.0 - grime * (0.55 * smoothstep(0.45, 0.85, stain) + 0.25 * nearJoint + 0.25 * edgeDirt);
  if (h.y < 0.07) col = mix(col, tint * 1.12, 0.6);                              // a slab that was replaced later
  Layer L = newLayer(mix(col, vec3(0.045, 0.042, 0.038), jm), 0.84 + 0.08 * mottle + 0.06 * (h.x - 0.5));
  L.slope = vec2(broom - 0.5, 0.0) * 0.3 * relief(0.012) + (sand_.rg - 0.5) * 0.3 * relief(0.03);
  L.slope += (hash32(id + 23.0).xy - 0.5) * 0.02 * (1.0 - jm);                    // each has settled its own way, so each mirrors a different piece of sky when wet
  // hairline cracks wander across a few slabs
  if (h.z < 0.16) { float n = gn(q + h.xy * 40.0, 7.0).g; float crack = (1.0 - smoothstep(0.0, 0.006 + gPx * 0.6, abs(n - 0.5))) * visible(0.006); L.albedo *= 1.0 - 0.7 * crack; L.height -= 0.3 * crack; }
  L.height = 0.6 + 0.2 * mottle - 0.6 * jm; L.porosity = 0.7; L.sheen = 0.75;
  L.pool = (h.x - 0.5) * 0.07 + 0.06 * jm + (0.5 - stain) * 0.04;                 // slabs settle unevenly
  return L;
}

// Trodden chewing gum: flat dark discs, densest where people walk.
float gumSpots(vec2 q) {
  vec4 cells = gn(q, 19.0); float there = smoothstep(0.45, 0.75, gn(q + 3.0, 1.9).g);
  return (1.0 - aastep(0.06 + 0.04 * cells.b, cells.a, gPx * 2.4)) * there * visible(0.06);
}

// Beach-front promenade: pale pink-grey concrete cast in 3 m bays, a deco figure (diamond, roundel, quarter fans)
// scored into each one while it was wet and its fields coloured in the mix. Thirty summers of sun, sand and feet have
// left the fields a shade apart at most; what still reads is the scored joints, the stains and the gum.
void decoFigure(inout Layer L, vec2 q, vec2 id, vec2 c) {
  vec2 a = abs(c); bool odd = mod(id.x + id.y, 2.0) > 0.5;
  float diamond = a.x + a.y, r = length(c), corner = length(a - 1.5), w = gPx;
  // signed distances to the dividing lines; the nearest one is the scored joint
  float dBorder = max(a.x, a.y) - 1.28, dOuter = (diamond - 1.22) * 0.7071, dInner = (diamond - 0.82) * 0.7071, dDisc = r - 0.36, dFan = corner - 0.62, dFan2 = corner - 0.34;
  vec3 warm = vec3(1.07, 0.95, 0.91), cool = vec3(0.93, 1.0, 1.03), tint = vec3(1.0);
  tint = mix(tint, odd ? cool : warm, 1.0 - aastep(0.0, dOuter, w));
  tint = mix(tint, vec3(1.0), 1.0 - aastep(0.0, dInner, w));
  tint = mix(tint, odd ? warm : cool, 1.0 - aastep(0.0, dDisc, w));
  tint = mix(tint, cool, aastep(0.0, dBorder, w));
  tint = mix(tint, warm, 1.0 - aastep(0.0, dFan, w));
  tint = mix(tint, vec3(1.0), 1.0 - aastep(0.0, dFan2, w));
  float strip = min(min(min(abs(dBorder), abs(dOuter)), min(abs(dInner), abs(dDisc))), min(abs(dFan), abs(dFan2)));
  float score = aaline(strip, 0.005, w), dirt = smoothstep(0.3, 0.7, gn(q + 7.0, 3.3).r);
  // the figure fades where the sun has had it and the sand has scoured it; the scored lines hold the dirt
  L.albedo *= mix(tint, vec3(1.0), 0.35 + 0.45 * dirt) * (1.0 - 0.55 * score) * (1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.05, strip)) * dirt);
  L.height -= 0.3 * score; L.pool += 0.04 * score;
}

// Small unit paving. kind 0 running bond, 1 herringbone, 2 square flags. Two brick colours mixed per unit.
Layer unitPaving(vec2 q, int kind, vec3 colA, vec3 colB, vec3 jointCol) {
  vec2 id, c; float jm; bool flags = kind == 2;
  if (kind == 1) jm = herringbonePattern(q, 0.105, 0.006, gPx, id, c);
  else jm = brickPattern(q, flags ? vec2(0.45, 0.45) : vec2(0.21, 0.105), flags ? 0.008 : 0.006, gPx, id, c);
  vec2 e = (flags ? vec2(0.225) : vec2(0.105, 0.0525)) - abs(c); float bevel = min(e.x, e.y);
  vec3 h = hash32(id + 3.0); vec4 grain = gn(q, 420.0); float stain = gn(q, 2.2).r;
  vec3 col = mix(colA, colB, smoothstep(0.35, 0.65, h.x)) * (0.8 + 0.3 * h.y) * (0.9 + 0.2 * grain.b) * (0.8 + 0.3 * stain);
  float round_ = 1.0 - smoothstep(0.0, 0.012, bevel);                              // tumbled arris
  Layer L = newLayer(mix(col * (1.0 - 0.25 * round_), jointCol, jm), 0.84);
  L.slope = (grain.rg - 0.5) * 0.3 * relief(0.04) + (h.yz - 0.5) * 0.035 * (1.0 - jm);            // units sit slightly out of level
  L.height = 0.55 + 0.25 * h.z - 0.55 * jm; L.porosity = 0.75; L.pool = (stain - 0.5) * -0.05 + 0.05 * jm;
  return L;
}

// Every call of a function is compiled as its own copy, and the Direct3D compiler behind Chrome on Windows needs time
// for each, so the styles below choose the arguments of ONE call instead of making a call each.
Layer sidewalk(vec2 q, int style) {
  if (style == 3) return unitPaving(q, 1, vec3(0.30, 0.105, 0.065), vec3(0.20, 0.085, 0.06), vec3(0.16, 0.13, 0.10));
  // 0 city concrete in 1.2 m flags, 1 the resort front: pale salmon concrete in saw-cut bays, 2 the beach-front promenade
  vec3 tint = style == 2 ? vec3(0.40, 0.31, 0.28) : style == 1 ? vec3(0.44, 0.31, 0.27) : vec3(0.35, 0.335, 0.31);
  float slab = style == 2 ? 3.0 : style == 1 ? 1.5 : 1.2, grime = style == 2 ? 0.9 : style == 1 ? 0.8 : 1.0;
  vec2 id, c; Layer L = concreteSlabs(q, tint, slab, style == 1 || style == 2 ? 0.010 : 0.012, grime, id, c);
  if (style == 2) decoFigure(L, q, id, c);
  else if (style == 1) {                                                           // a paler band across every fourth joint
    float band = aaline(fract(q.y / 8.0 + 0.5) * 8.0 - 4.0, 0.2, gPx), speck = 1.0 - smoothstep(0.15, 0.4, gn(q, 480.0).a);
    L.albedo = mix(L.albedo, vec3(0.50, 0.46, 0.40) * (0.85 + 0.3 * gn(q, 9.0).r), band * 0.9);
    L.albedo = mix(L.albedo, vec3(0.56, 0.50, 0.44), speck * 0.28);                 // exposed pale aggregate
  }
  float gum = gumSpots(q); L.albedo = mix(L.albedo, vec3(0.05, 0.048, 0.045), gum * 0.85); L.rough = mix(L.rough, 0.6, gum);
  return L;
}

Layer pavers(vec2 q, int set) {
  // 0 grey running bond, 1 red herringbone, 2 buff square flags, 3 charcoal herringbone
  vec3 colA = set == 1 ? vec3(0.36, 0.15, 0.085) : set == 2 ? vec3(0.50, 0.42, 0.30) : set == 3 ? vec3(0.075, 0.075, 0.08) : vec3(0.30, 0.295, 0.28);
  vec3 colB = set == 1 ? vec3(0.27, 0.12, 0.075) : set == 2 ? vec3(0.42, 0.36, 0.27) : set == 3 ? vec3(0.20, 0.20, 0.195) : vec3(0.24, 0.235, 0.225);
  vec3 joint = set == 1 ? vec3(0.17, 0.14, 0.11) : set == 2 ? vec3(0.20, 0.17, 0.13) : set == 3 ? vec3(0.06, 0.055, 0.05) : vec3(0.11, 0.10, 0.09);
  return unitPaving(q, set == 2 ? 2 : set == 1 || set == 3 ? 1 : 0, colA, colB, joint);
}

// Dirt where no shoe and no broom reaches: behind the kerb stones and along the foot of the buildings.
// d = (metres to the kerb line, metres to the building line), 99 where there is none.
void walkEdges(inout Layer L, vec2 d) {
  float n = gn(gP + 19.0, 6.0).r, m = gn(gP + 9.0, 38.0).g;
  float kerbBand = 1.0 - smoothstep(0.02, 0.16 + 0.3 * n, d.x), wallBand = 1.0 - smoothstep(0.04, 0.25 + 0.6 * n, d.y);
  float grime = max(0.5 * kerbBand, 0.7 * wallBand) * (0.55 + 0.45 * m);
  L.albedo = mix(L.albedo, L.albedo * vec3(0.36, 0.34, 0.30), grime); L.rough = min(L.rough + 0.08 * grime, 0.97);
  // rain splashes soil up the wall and back down; in the shade at its foot the damp never quite leaves
  float foot = 1.0 - smoothstep(0.0, 0.07 + 0.08 * m, d.y);
  L.albedo = mix(L.albedo, vec3(0.035, 0.04, 0.028) * (0.6 + 0.8 * n), 0.55 * foot); L.ao *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.12, d.y));
  // feet keep the middle clean and a shade smoother
  float trod = smoothstep(0.3, 1.1, min(d.x, d.y)) * (0.5 + 0.5 * n);
  L.albedo *= 1.0 + 0.07 * trod; L.rough -= 0.05 * trod;
  L.pool += 0.04 * kerbBand;
}

// Kerb of separate cast stones. uv.x = metres across the profile from the gutter line (face, chamfer, top),
// uv.y = metres along the run. The slope returned is in that frame: x along the run, y across the profile.
Layer kerb(vec2 uv, float paint, bool dropped) {
  float u = uv.x, n = uv.y / KERB_STONE, id = floor(n), f = (n - id - 0.5) * KERB_STONE, e = 0.5 * KERB_STONE - abs(f);
  float side = f < 0.0 ? -1.0 : 1.0; vec3 h = hash32(vec2(id, 7.0)), hn = hash32(vec2(id + side, 7.0)), hj = hash32(vec2(id + 0.5 + 0.5 * side, 3.0));
  float top = aastep(KERB_CHAMFER, u, gPx), face = 1.0 - aastep(KERB_FACE, u, gPx);
  // cast concrete: sand at the surface, the odd air hole, weather running down the face
  vec2 k = vec2(u, uv.y); vec4 sand_ = gn(k, 520.0), pit = gn(k + 3.0, 300.0);
  float mottle = gn(k, 9.0).r, streak = gnm(k, mat2(520.0, 0.0, 0.0, 9.0)).g;
  vec3 col = vec3(0.33, 0.32, 0.295) * (0.76 + 0.4 * h.x) * mix(vec3(1.04, 1.0, 0.94), vec3(0.96, 1.0, 1.05), h.y);
  col *= (0.86 + 0.22 * mottle) * (0.9 + 0.2 * sand_.b) * (1.0 - 0.3 * face * smoothstep(0.4, 0.8, streak));
  col *= 1.0 - 0.45 * (1.0 - smoothstep(0.03, 0.09, pit.a)) * visible(0.004);
  Layer L = newLayer(col, 0.84 + 0.08 * (mottle - 0.5)); L.porosity = 0.65;
  if (paint > 0.5) {
    // kerb paint chips off the arris first and lasts longest on top
    vec3 pc = paint < 1.5 ? PAINT_YELLOW : vec3(0.40, 0.05, 0.04);
    float chips = smoothstep(0.26, 0.4, 0.55 * gn(k + 2.0, 55.0).r + 0.3 * gn(k, 210.0).g + 0.15 * sand_.b + 0.16 * top - 0.2 * (1.0 - top - face));
    L.albedo = mix(L.albedo, pc * (0.6 + 0.25 * mottle), chips); L.rough = mix(L.rough, 0.55, chips); L.porosity = mix(0.65, 0.1, chips);
  }
  // tyres rub the face and the arris black in long streaks
  float scuff = (1.0 - top) * smoothstep(0.03, 0.07, u) * smoothstep(0.5, 0.8, gnm(k, mat2(0.0, 420.0, 7.0, 0.0)).r + 0.3 * (mottle - 0.5) + (dropped ? 0.2 : 0.0));
  // a dropped kerb is driven over: rubber across it, the top worn smooth
  float crossed = dropped ? smoothstep(0.35, 0.75, gnm(k, mat2(14.0, 0.0, 0.0, 300.0)).g) : 0.0;
  L.albedo *= (1.0 - 0.4 * scuff) * (1.0 - 0.5 * crossed) * (dropped ? 0.85 : 1.0); L.rough -= 0.14 * scuff + (dropped ? 0.1 : 0.0);
  // road dirt banks against the foot of the face
  float dirt = 1.0 - smoothstep(0.008, 0.02 + 0.04 * gn(vec2(uv.y, 0.0), 5.0).r, u);
  L.albedo = mix(L.albedo, vec3(0.075, 0.066, 0.054) * (0.8 + 0.4 * mottle), 0.8 * dirt); L.rough = mix(L.rough, 0.93, dirt);
  // the joint: a few millimetres of mortar or nothing, the stone ends rounded, the higher stone shading the lower
  float joint = aaline(e, 0.002 + 0.002 * hj.x, gPx), lip = (1.0 - smoothstep(0.0, 0.012, e)) * step(h.z, hn.z) * visible(0.006);
  L.albedo *= (1.0 - 0.85 * joint) * (1.0 - 0.3 * lip); L.ao = 1.0 - 0.5 * joint;
  // the dark line where the pavement butts against the back of the stone
  L.albedo *= 1.0 - 0.6 * aaline(u - KERB_BACK, 0.004, gPx);
  // no stone is set quite true: each leans a little, which shows as soon as the row catches a light
  L.slope = vec2((h.z - 0.5) * 0.035 + side * (1.0 - smoothstep(0.002, 0.012, e)) * 0.6 * relief(0.012), (h.x - 0.5) * 0.03)
          + (sand_.rg - 0.5) * 0.07 * relief(0.03);
  L.height = 0.6 - 0.5 * joint; L.pool = -1.0; L.sheen = 0.8;
  return L;
}

// Bark mulch with low ground-cover creeping over it (planted medians and beds).
Layer plantedBed(vec2 p) {
  vec4 bark = gn(p, 210.0), bark2 = gnm(p, mat2(330.0, 190.0, -60.0, 104.0)); float clump = gn(p, 9.0).r, lump = gn(p, 37.0).g;
  vec3 mulch = mix(vec3(0.04, 0.026, 0.017), vec3(0.15, 0.095, 0.055), bark2.r) * (0.6 + 0.6 * (1.0 - smoothstep(0.1, 0.5, bark.a)));
  // ground cover spreads from each plant in mats with ragged, leafy edges; the mulch shows between them
  float green = smoothstep(0.36, 0.56, 0.45 * clump + 0.35 * lump + 0.2 * gn(p + 4.0, 120.0).r + 0.1 * (bark.b - 0.5));
  vec4 leaf = gn(p, 330.0);
  vec3 cover = mix(vec3(0.035, 0.085, 0.02), vec3(0.11, 0.21, 0.045), leaf.r) * (0.55 + 0.8 * (1.0 - smoothstep(0.1, 0.55, leaf.a)));
  Layer L = newLayer(mix(mulch, cover, green), mix(0.93, 0.7, green));
  L.slope = mix((bark.rg - 0.5) * 1.1, (leaf.rg - 0.5) * 1.4, green) * relief(0.06) + gslope(p, 37.0) * 0.05 * relief(0.4);
  L.height = mix(0.3 + 0.3 * bark2.r, 0.75 + 0.2 * leaf.r, green); L.porosity = mix(0.8, 0.3, green); L.pool = -1.0; L.sheen = 0.4;
  L.ao = 0.75 + 0.25 * smoothstep(0.1, 0.5, mix(bark.a, leaf.a, green));
  return L;
}

Layer median(vec2 q, int kind) {
  if (kind == 1) return plantedBed(gP);
  vec2 id, c; Layer L = concreteSlabs(q, vec3(0.33, 0.315, 0.29), 3.0, 0.012, 1.3, id, c);
  // stamped cobble texture so nobody mistakes it for a pavement
  vec2 sid, sc; float stamp = brickPattern(q, vec2(0.24, 0.12), 0.014, gPx, sid, sc) * visible(0.02);
  L.albedo *= 1.0 - 0.3 * stamp; L.height -= 0.2 * stamp; L.pool = -0.1;
  return L;
}

// Loose stone: gravel lots, track ballast and the stony part of bare ground. size = typical stone in metres.
Layer gravel(vec2 p, float size, vec3 colA, vec3 colB) {
  float k = 8.0 / (size * 1.6); vec4 a = gn(p, k), b = gn(p.yx * 1.9 + 7.7, k * 2.3);
  float stone = 1.0 - smoothstep(0.12, 0.55, a.a), small_ = 1.0 - smoothstep(0.12, 0.5, b.a), drift = gn(p, 1.7).r;
  vec3 col = mix(colA, colB, mix(b.b, a.b, stone)) * (0.5 + 0.38 * small_ + 0.5 * stone) * (0.82 + 0.3 * drift);
  Layer L = newLayer(col, 0.94);
  L.slope = (a.rg - 0.5) * 1.3 * stone * relief(size * 3.0) + (b.rg - 0.5) * 0.8 * relief(size * 1.4);
  L.height = 0.25 + 0.5 * stone + 0.15 * small_; L.ao = 0.62 + 0.38 * max(stone, small_ * 0.7);
  L.porosity = 0.55; L.sheen = 0.5; L.pool = (0.5 - drift) * 0.1 - 0.03; L.silt = vec3(0.10, 0.085, 0.06);
  return L;
}

// Car park, service yard and gravel lot. p1 = bay spacing in dm (0 none).
Layer lot(vec2 q, int kind, float spacingDm, bool bays) {
  if (kind == 2) {
    Layer L = gravel(gP, 0.022, vec3(0.19, 0.17, 0.14), vec3(0.46, 0.43, 0.37));
    // cars pack the stone into smoother, paler wheel lanes
    float pressed = smoothstep(0.45, 0.7, gn(q * vec2(0.6, 0.15), 5.0).r);
    L.albedo *= 1.0 + 0.15 * pressed; L.slope *= 1.0 - 0.45 * pressed; L.pool += 0.07 * pressed;
    return L;
  }
  if (kind == 1) {
    vec2 id, c; Layer L = concreteSlabs(q, vec3(0.30, 0.292, 0.272), 4.5, 0.02, 1.2, id, c);
    float tyre = smoothstep(0.62, 0.9, gnm(q, mat2(40.0, 0.0, 0.0, 2.2)).r) * gn(q, 1.5).g;       // black arcs where trucks turn
    L.albedo *= 1.0 - 0.5 * tyre; L.rough -= 0.1 * tyre;
    return L;
  }
  Layer L = asphaltBase(gP, 0.62);
  float net = gn(q, 5.5).r, seal = aaline(net - 0.5, 0.004, gPx * 0.12 + 0.002) * smoothstep(0.4, 0.7, gn(q + 40.0, 1.1).g) * visible(0.03);
  tarSeal(L, seal);
  if (bays && spacingDm > 0.5) {
    float sp = spacingDm * 0.1, u = q.x - floor(q.x / LOT_MODULE) * LOT_MODULE;
    float head = min(u, LOT_MODULE - u);                         // metres from the back of the nearest bay row
    float inBay = 1.0 - aastep(LOT_BAY, head, gPx), d = (q.y / sp - floor(q.y / sp + 0.5)) * sp;
    float line = max(aaline(d, 0.05, gPx) * inBay, aaline(head - 0.05, 0.05, gPx));
    // each bay collects its own oil under the engine, towards the aisle end
    vec2 bid = vec2(floor(q.y / sp), floor(q.x / LOT_MODULE) * 2.0 + step(0.5 * LOT_MODULE, u)); vec3 h = hash32(bid + 13.0);
    vec2 o = vec2(head - 3.3 + (h.x - 0.5) * 0.8, (fract(q.y / sp) - 0.5) * sp + (h.y - 0.5) * 0.5);
    float stain = (1.0 - smoothstep(0.1, 0.55 + 0.4 * h.z, length(o) + 0.25 * (gn(q, 30.0).g - 0.5))) * step(0.25, h.z) * inBay;
    L.albedo *= 1.0 - 0.7 * stain; L.rough -= 0.25 * stain; L.porosity *= 1.0 - 0.5 * stain;
    roadPaint(L, PAINT_WHITE, line, 0.5 + 0.25 * h.x, L.height, q);
  }
  L.pool += 0.03;
  return L;
}
`;

// ---------------------------------------------------------------------------------------------- decks, tarmac, decals
const STRUCTURES = /* glsl */`
// Bridge deck: tined concrete, lane lines by the open-shoulder rules, an armoured expansion joint every 'spacing' metres.
Layer deckRoad(vec2 uv, float hw, float code, float spacing, float weight) {
  float on = aastep(0.5, weight, 0.02); vec2 id, c;
  Layer L = concreteSlabs(vec2(uv.x + 100.0, uv.y), vec3(0.265, 0.258, 0.24), max(spacing, 4.0) * 0.5, 0.006, 0.8, id, c);
  // transverse tining gives the tyres grip and the deck its fine cross-hatch
  float tine = pulseTrain(uv.y / 0.019, 0.3, gPx / 0.019) - 0.3, show = visible(0.006);
  L.albedo *= 1.0 - 0.35 * tine * show; L.slope.y += tine * 0.5 * show;
  Lanes ln = laneFrame(hw, code, true); vec4 lane = laneLocal(uv.x, ln); float cc = abs(lane.x);
  float path = exp(-pow((cc - 0.86) / 0.3, 2.0)) * lane.y * on, centre = exp(-pow(cc / 0.4, 2.0)) * lane.y * on;
  float streak = gn(uv * vec2(1.0, 0.1), 10.0).r;
  L.albedo *= (1.0 - 0.34 * path * (0.6 + 0.6 * streak)) * (1.0 - 0.3 * centre * smoothstep(0.3, 0.8, streak));   // rubber and oil show strongly on pale concrete
  L.rough -= 0.1 * path; L.pool += 0.03 * path - 0.05;
  if (spacing > 0.5) {
    float jd = (uv.y / spacing - floor(uv.y / spacing + 0.5)) * spacing, a = abs(jd);
    float seal = 1.0 - aastep(0.022, a, gPx), steel = (1.0 - aastep(0.07, a, gPx)) - seal;
    L.albedo = mix(L.albedo, vec3(0.10, 0.095, 0.09) * (0.7 + 0.6 * gn(uv, 60.0).r), steel * on); L.rough = mix(L.rough, 0.42, steel * on);
    L.albedo = mix(L.albedo, vec3(0.012), seal * on); L.rough = mix(L.rough, 0.6, seal * on);
    L.height = mix(L.height, 0.1, seal * on); L.pool += 0.2 * seal * on; L.slope *= 1.0 - (steel + seal) * on;
    L.albedo *= 1.0 - 0.25 * smoothstep(0.5, 0.07, a) * on;                                   // dirt trails off each joint
  }
  vec2 lines = laneLines(uv, ln) * on;
  roadPaint(L, PAINT_WHITE, lines.x, 0.3 + 0.2 * path, 0.5, uv); roadPaint(L, PAINT_YELLOW, lines.y, 0.25, 0.5, uv);
  return L;
}

// Airport paving. kind 0 runway, 1 taxiway, 2 apron. uv = (lateral, station); len = runway length in metres.
Layer tarmac(vec2 uv, int kind, float len, float hw, float weight) {
  float on = aastep(0.5, weight, 0.02), x = abs(uv.x), w = gPx;
  if (kind == 2) {
    vec2 id, c; Layer L = concreteSlabs(gP, vec3(0.28, 0.275, 0.26), 6.0, 0.025, 1.0, id, c);
    float drip = (1.0 - smoothstep(0.1, 0.5, gn(gP, 7.0).a)) * smoothstep(0.5, 0.8, gn(gP + 5.0, 0.8).r);     // fuel and hydraulic spots on the stands
    L.albedo *= 1.0 - 0.6 * drip; L.rough -= 0.2 * drip;
    return L;
  }
  Layer L = asphaltBase(gP, kind == 0 ? 0.5 : 0.7);
  if (on <= 0.0) return L;
  float white = 0.0, yellow = 0.0;
  if (kind == 0) {
    float e = min(uv.y, len - uv.y);                                // metres from the nearer runway end
    // rubber from landings: long dark streaks either side of the centre line in the touchdown zones
    float zone = smoothstep(120.0, 260.0, e) * (1.0 - smoothstep(520.0, 760.0, e)) * (1.0 - smoothstep(0.25 * hw, 0.6 * hw, x));
    float skid = gnm(uv, mat2(26.0, 0.0, 0.0, 0.5)).r;
    L.albedo *= 1.0 - 0.6 * zone * smoothstep(0.3, 0.7, skid); L.rough -= 0.12 * zone;
    L.albedo *= 1.0 - 0.1 * (pulseTrain(uv.y / 0.038, 0.25, w / 0.038) - 0.25) * visible(0.01);      // transverse grooving
    white += aaline(uv.x, 0.45, w) * pulseTrain((uv.y + 15.0) / 50.0, 0.6, w / 50.0) * step(60.0, e);                // centre line
    white += aaline(x - (hw - 1.4), 0.45, w);                                                                      // side stripes
    // threshold: a row of longitudinal bars, 30 m long, starting 6 m in
    float bars = pulseTrain((x - 1.5) / 3.6, 0.5, w / 3.6) * step(1.5, x) * (1.0 - aastep(hw - 3.0, x, w));
    white += bars * aastep(6.0, e, w) * (1.0 - aastep(36.0, e, w));
    // aiming point blocks and touchdown-zone pairs
    float aim = aaline(x - 0.3 * hw, 0.11 * hw, w) * aastep(300.0, e, w) * (1.0 - aastep(345.0, e, w));
    float tdz = aaline(x - 0.3 * hw, 0.09 * hw, w) * pulseTrain(x / 1.9, 0.6, w / 1.9) * pulseTrain((e - 150.0) / 150.0, 0.15, w / 150.0) * step(150.0, e) * (1.0 - step(600.0, e)) * (1.0 - aim);
    white += aim + tdz;
  } else {
    yellow += aaline(uv.x, 0.075, w);                                                                // taxiway centre line
    yellow += aaline(x - (hw - 0.9), 0.075, w) + aaline(x - (hw - 1.2), 0.075, w);                   // double edge lines
    float centre = exp(-pow(x / 1.2, 2.0)); L.albedo *= 1.0 - 0.3 * centre * gn(uv * vec2(1.0, 0.1), 8.0).r;   // nose-wheel track
  }
  roadPaint(L, PAINT_WHITE, saturate(white) * on, 0.35, L.height, uv); roadPaint(L, PAINT_YELLOW, saturate(yellow) * on, 0.3, L.height, uv);
  L.pool -= 0.04;
  return L;
}

// Painted decal on a road. uv = decal-local metres: x across the direction of travel, shifted by the builder so
// that lane boundaries fall on whole lane widths, y along it. code = fill + 8 * lane width in MARKING_LANE_UNIT
// (0 = lanes unknown). fill 0 zebra bars, 2 box-junction lattice, 3 tyre rubber, 5 chevrons, anything else solid.
// weight = the marking weight of the road underneath, so the asphalt under the paint matches the road beside it.
Layer markingDecal(vec2 uv, vec3 paint, int code, float wear, float age, float weight) {
  int fill = code & 7; float laneW = float(code >> 3) * MARKING_LANE_UNIT, top, cut;
  Layer L;
  if (fill == 3) {
    // rubber from the player's own tyres: uv.x = -1..1 across the streak, weight = how hard the tyre slid
    Traffic none = trafficAt(0.0, 0.0, 0.0, 0.0, 0.5, 0.5); L = roadBase(gP, age, none, top, cut);
    float x = abs(uv.x), prof = (1.0 - smoothstep(0.6, 1.0, x)) * (0.7 + 0.3 * exp(-pow((x - 0.68) / 0.14, 2.0)));
    float streak = gn(vec2(uv.x * 0.12, uv.y * 0.04), 40.0).r;
    // it comes off on the stone tops; the binder between them stays as it was
    float m = saturate(weight * prof * (0.55 + 0.45 * streak) * mix(1.0, 0.4 + 0.75 * smoothstep(0.3, 0.75, top), gStone));
    L.albedo = mix(L.albedo, vec3(0.016), 0.85 * m); L.rough = mix(L.rough, 0.62, 0.6 * m);
    return L;
  }
  float on = aastep(0.5, weight, 0.02), known = step(0.001, laneW) * on;
  float c = laneW > 0.0 ? (fract(uv.x / laneW) - 0.5) * laneW : 0.0;
  Traffic tr = trafficAt(c, known, saturate(2.0 - 2.0 * weight) * on, 0.0, mix(0.5, gn(vec2(uv.x, uv.y * 0.12), 9.0).g, known), 0.5);
  L = roadBase(gP, age, tr, top, cut);
  L.pool += on > 0.0 ? 0.05 * tr.path * age - 0.03 : 0.015;
  roadSpray(L, gP, top, age);
  float cov = 1.0;
  if (fill == 0) cov = pulseTrain(uv.x / 1.2 + 0.25, 0.5, gPx / 1.2);
  else if (fill == 2) {
    vec2 d = vec2(uv.x + uv.y, uv.x - uv.y) * 0.70710678; d = (fract(d / 2.0 + 0.5) - 0.5) * 2.0;
    cov = max(aaline(d.x, 0.075, gPx), aaline(d.y, 0.075, gPx));
  }
  else if (fill == 5) cov = pulseTrain((uv.x + uv.y) / 1.7, 0.42, gPx / 1.2);
  // tyres take the paint off where they run: in the wheel paths if the decal knows its lanes, else in loose bands along the road
  float tyres = laneW > 0.0 ? exp(-pow((abs(c) - 0.86) / 0.34, 2.0)) : 0.6 * gn(vec2(uv.x * 0.9, uv.y * 0.12), 16.0).r;
  roadPaint(L, paint, cov * (1.0 - cut), wear * 0.85 + 0.5 * tyres, top, gP);
  return L;
}
`;

// ---------------------------------------------------------------------------------------------- sand, grass, earth
const NATURAL = /* glsl */`
// Beach sand. y = height above sea level; paved = metres to the nearest paving (large if unknown).
// Dry and pale above the tide, rippled by wind where nobody walks, churned by feet and raked near the promenade,
// then firm, dark and wet towards the water with a glassy swash zone at the waterline.
Layer sand(float y, float paved) {
  vec2 p = gP; vec4 grain = gn(p, 900.0), grain2 = gn(p.yx + 1.7, 2700.0); float drift = gn(p, 1.1).r, patchy = gn(p + 60.0, 4.6).g;
  // how wet the tide leaves it: saturated near the water, drying out up the foreshore along an uneven line
  float line = (patchy - 0.5) * 0.16 + (gn(p, 19.0).r - 0.5) * 0.05;
  float soaked = 1.0 - smoothstep(0.34, 0.42, y + line), moist = 1.0 - smoothstep(0.4, 0.95, y + line);   // a clear line where the last wave stopped
  float swashTop = 0.05 + 0.05 * sin(uTime.x * 0.42 + drift * 9.0 + p.x * 0.05) + 0.03 * sin(uTime.x * 0.9 + patchy * 14.0);
  float swash = 1.0 - smoothstep(swashTop - 0.015, swashTop + 0.03, y), glaze = 1.0 - smoothstep(swashTop, swashTop + 0.2, y);   // glaze: sheet still draining back
  float dry = 1.0 - moist;

  vec3 col = mix(vec3(0.37, 0.30, 0.20), vec3(0.45, 0.38, 0.27), drift) * (0.9 + 0.14 * patchy);
  col *= 0.86 + 0.22 * grain.b + 0.1 * grain2.b;                                    // individual grains: quartz, shell, dark mineral
  col = mix(col, vec3(0.09, 0.075, 0.06), step(0.93, grain2.b) * 0.5 * gNear);
  Layer L = newLayer(col, 0.93);
  L.slope = (grain.rg - 0.5) * 0.5 * relief(0.018) + (grain2.rg - 0.5) * 0.35 * relief(0.006);

  // people: footprints overlap into a lumpy field near the promenade and thin out towards the water
  float people = mix(0.3 + 0.4 * smoothstep(0.35, 0.75, gn(p + 17.0, 0.9).g), 0.9, 1.0 - smoothstep(6.0, 34.0, paved));
  float churn = saturate(people * (0.55 + 0.9 * patchy)) * (1.0 - 0.75 * soaked);
  vec4 pits = gn(p, 30.0); float pit = smoothstep(0.55, 0.1, pits.a);
  L.slope += (gslope(p, 30.0) * 0.065 * relief(0.5) + gslope(p + 4.0, 74.0) * 0.03 * relief(0.2)) * churn;
  L.albedo *= 1.0 - churn * (0.26 * pit + 0.12 * (pits.r - 0.5)) * visible(0.1);

  // wind ripples on undisturbed dry sand: crests about 9 cm apart, bending with the drift
  float calm = (1.0 - smoothstep(0.15, 0.5, churn)) * dry * smoothstep(0.3, 0.55, gn(p + 9.0, 2.3).r + 0.25);
  if (calm > 0.0) {
    vec2 dir = normalize(vec2(0.86, 0.5)); float ph = (dot(p, dir) + 0.22 * gn(p, 7.0).g + 0.05 * gn(p, 31.0).r) * (TAU / 0.09);
    float show = calm * visible(0.03);
    L.slope += dir * cos(ph) * 0.26 * calm * relief(0.045); L.albedo *= 1.0 + 0.06 * sin(ph - 0.9) * show;         // dark coarse grains settle in the troughs
  }
  // beach rake and the tractor that pulls it: lines of constant distance from the promenade
  float lane = paved + (gn(p, 2.6).r - 0.5) * 0.5;                                                  // the driver does not steer a perfect line
  float swath = floor(lane / 2.4), raked = step(0.45, hash11(swath + 3.0)) * smoothstep(2.0, 4.0, paved) * (1.0 - smoothstep(13.0, 18.0, paved)) * dry;
  raked *= 1.0 - smoothstep(0.3, 0.75, patchy * people * 1.6);                                 // trampled out again where it is busy
  float rph = (lane + 0.012 * gn(p, 40.0).g) * (TAU / 0.075), rshow = raked * visible(0.025);
  L.slope += gBlendDir * cos(rph) * 0.22 * raked * relief(0.04); L.albedo *= 1.0 + 0.045 * sin(rph - 0.9) * rshow;
  float track = max(aaline(lane - 5.6, 0.19, gPx), aaline(lane - 7.5, 0.19, gPx)) * dry * step(0.5, length(gBlendDir));
  float lug = pulseTrain(dot(p, vec2(-gBlendDir.y, gBlendDir.x)) / 0.16, 0.5, gPx / 0.16) - 0.5;
  L.albedo *= 1.0 - track * (0.1 + 0.16 * lug * visible(0.08)); L.slope *= 1.0 - 0.5 * track; L.slope += gBlendDir * lug * 0.5 * track * visible(0.08);

  // shell fragments everywhere, weed along the high-water line
  vec4 bits = gn(p + 2.2, 62.0); float shell = (1.0 - aastep(0.05 + 0.04 * bits.b, bits.a, gPx * 8.0)) * step(0.45, bits.r) * visible(0.012);
  L.albedo = mix(L.albedo, bits.g > 0.5 ? vec3(0.78, 0.74, 0.68) : vec3(0.42, 0.25, 0.2), shell * 0.85);
  // a thin broken string of it where the last high tide stopped, single strands elsewhere on the foreshore
  float wrackLine = exp(-pow((y + line * 1.5 - 0.6) / 0.022, 2.0));
  vec4 strand = gnm(p, mat2(260.0, 90.0, -60.0, 150.0));
  float weed = smoothstep(0.95, 0.985, strand.r + 0.3 * wrackLine * smoothstep(0.35, 0.6, gn(p + 8.0, 6.0).g)) * (1.0 - smoothstep(0.7, 1.0, y)) * visible(0.02);
  L.albedo = mix(L.albedo, vec3(0.075, 0.055, 0.03) * (0.6 + 0.8 * gn(p, 200.0).b), weed * 0.9); L.rough = mix(L.rough, 0.8, weed);

  // wet sand packs flat and goes dark; the foam leaves thin pale lines where each wave stopped
  float rill = aaline(fract((y + line * 0.7) / 0.055 + 0.3 * gn(p, 3.0).g) - 0.5, 0.05, gPx * 1.2 + 0.02) * soaked * (1.0 - swash);
  L.slope *= 1.0 - 0.8 * soaked; L.albedo *= 1.0 + 0.1 * rill;
  L.damp = max(soaked, 0.45 * moist); L.film = max(swash, 0.55 * glaze);
  L.height = 0.5 + 0.3 * (pits.r - 0.5) * churn; L.porosity = 0.72; L.pool = -1.0; L.sheen = 0.35;
  L.ao = 1.0 - 0.25 * churn * pit;
  return L;
}

// Turf. kind 0 lawn, 1 rough, 2 fairway, 3 putting green. q = pattern coordinates (q.y along the mowing direction),
// viewQ = horizontal direction to the camera in the same coordinates.
Layer grass(vec2 q, int kind, vec2 viewQ) {
  vec2 p = gP;
  float len = kind == 1 ? 1.9 : (kind == 0 ? 1.0 : (kind == 2 ? 0.6 : 0.4));        // blade length relative to a lawn
  float macro = gn(p, 1.1).r, patchy = gn(p + 23.0, 7.0).g;
  // blades: three families of lozenges from the cell channel, 60 degrees apart, each about 6 mm by 4 cm on a lawn.
  // Which family lies on top changes from clump to clump, so the turf has a nap without a global direction.
  vec4 clump = gn(p, 64.0 / len), tuft = gnm(p, mat2(480.0, -260.0, 62.0, 115.0) * (1.0 / len));
  vec4 a1 = gnm(p, mat2(1222.0, -68.0, 445.0, 188.0) * (1.0 / len)), a2 = gnm(p, mat2(226.0, -197.0, 1280.0, 35.0) * (1.0 / len));
  vec4 a3 = gnm(p + 0.37, mat2(-996.0, -129.0, 836.0, -153.0) * (1.0 / len));
  float sharp = visible(0.003 * len);                                                // below a pixel the blades average out
  float m1 = mix(0.45, 1.0 - smoothstep(0.24, 0.42, a1.a), sharp) * smoothstep(0.1, 0.45, clump.r + 0.2);
  float m2 = mix(0.45, 1.0 - smoothstep(0.24, 0.42, a2.a), sharp);
  float m3 = mix(0.45, 1.0 - smoothstep(0.24, 0.42, a3.a), sharp) * smoothstep(0.9, 0.55, clump.r - 0.2);
  float cover = 1.0 - (1.0 - m1) * (1.0 - m2) * (1.0 - m3);
  float body = saturate(0.6 * (0.3 * m1 + 0.4 * m2 + 0.6 * m3) + 0.3 * tuft.r + 0.2 * (1.0 - smoothstep(0.1, 0.6, clump.a)));
  float gap = (1.0 - cover) * (1.0 - 0.8 * gGraze);                                  // looking down between the blades: shadow and soil

  vec3 deep, bright, straw = vec3(0.20, 0.165, 0.075);
  if (kind == 3) { deep = vec3(0.028, 0.07, 0.018); bright = vec3(0.06, 0.125, 0.035); }
  else if (kind == 2) { deep = vec3(0.024, 0.058, 0.014); bright = vec3(0.06, 0.105, 0.03); }
  else if (kind == 1) { deep = vec3(0.022, 0.042, 0.012); bright = vec3(0.07, 0.09, 0.03); }
  else { deep = vec3(0.022, 0.05, 0.012); bright = vec3(0.058, 0.098, 0.027); }
  // lower blades sit in the shade of the ones above
  vec3 col = deep * 0.6;
  col = mix(col, mix(deep, bright, 0.75 * a1.r), m1);
  col = mix(col, mix(deep, bright, 0.2 + 0.75 * a2.r), m2);
  col = mix(col, mix(deep, bright, 0.4 + 0.75 * a3.g), m3);
  col *= 0.9 + 0.16 * macro;
  col = mix(col, col * vec3(1.18, 1.05, 0.72), smoothstep(0.55, 0.9, tuft.g) * 0.5);  // sun-bleached tips
  col = mix(col, col.grb * vec3(0.9, 1.1, 0.8), (clump.b - 0.5) * 0.25);              // clumps of a slightly different grass

  // drought: straw-coloured patches, large in rough, rare on anything that is watered
  float thirst = kind == 1 ? 0.5 : (kind == 0 ? 0.24 : (kind == 2 ? 0.16 : 0.06));
  float dryness = smoothstep(1.0 - thirst, 1.25 - thirst * 0.6, 0.45 * patchy + 0.4 * macro + 0.15 * clump.g + 0.25 * (tuft.g - 0.5));
  col = mix(col, straw * (0.55 + 0.75 * body), dryness * 0.85);
  float bare = kind < 2 ? smoothstep(0.80, 0.9, 0.5 * gn(p + 71.0, 9.0).r + 0.3 * patchy + 0.2 * (1.0 - body) + 0.25 * dryness - (kind == 0 ? 0.12 : 0.0)) : 0.0;
  Layer L = newLayer(col, mix(0.84, 0.92, dryness));       // a mat of blades has no smooth face to mirror the sky
  // kept gentle: turf scatters light through its blades, so a steep facet model turns a low sun into black and lit stripes
  // and each term goes before its own grain drops under a pixel: the sampler would smear it along the line of sight
  L.slope = ((mix(a2.rg, a3.rg, m3) - 0.5) * 0.45 * relief(0.012 * len) + (tuft.rg - 0.5) * 0.3 * relief(0.02 * len) + (clump.rg - 0.5) * 0.15 * relief(0.25 * len)) * mix(0.55, 1.0, min(len, 1.0));
  L.height = 0.35 + 0.6 * body;

  if (kind == 1) {
    // clover in dark round-leaved drifts with white flower heads; broad-leaved weeds as paler rosettes
    float drift = smoothstep(0.6, 0.72, gn(p + 5.0, 5.2).r + 0.1 * (clump.g - 0.5)) * (1.0 - dryness);
    vec4 leaf = gn(p, 330.0); float lobe = 1.0 - smoothstep(0.12, 0.5, leaf.a);
    L.albedo = mix(L.albedo, mix(vec3(0.014, 0.036, 0.011), vec3(0.04, 0.085, 0.025), lobe), drift * 0.9);
    L.albedo = mix(L.albedo, vec3(0.72, 0.70, 0.62), drift * (1.0 - aastep(0.07, gn(p + 1.3, 44.0).a, gPx * 6.0)) * step(0.6, leaf.b) * visible(0.012));
    L.slope = mix(L.slope, (leaf.rg - 0.5) * 1.2 * relief(0.05), drift * 0.7); gap *= 1.0 - 0.7 * drift;
    vec4 w = gn(p + 9.0, 13.0); vec2 wc = vec2(w.r, w.g) - 0.5;
    float rosette = (1.0 - smoothstep(0.1, 0.24, w.a)) * step(0.55, gn(p, 2.0).r);
    float spokes = 0.6 + 0.4 * sin(atan(wc.y, wc.x) * 9.0 + w.b * 6.0);
    L.albedo = mix(L.albedo, vec3(0.05, 0.10, 0.03) * spokes, rosette * 0.8); gap *= 1.0 - rosette;
  }
  if (kind >= 2) {
    // mowing stripes: the roller lays the blades towards or away from the viewer, so alternate passes differ in tone
    float width = kind == 2 ? 6.0 : 1.4, s1 = pulseTrain(q.x / (2.0 * width), 0.5, gPx / (2.0 * width)) - 0.5;
    float s2 = kind == 3 ? pulseTrain(q.y / (2.0 * width), 0.5, gPx / (2.0 * width)) - 0.5 : 0.0;
    float nap = s1 + 0.6 * s2;
    L.albedo *= 1.0 + nap * (kind == 2 ? 0.3 : 0.16) * (0.35 + 0.65 * viewQ.y);     // strongest looking along the cut, reversed from the far end
    L.rough += nap * 0.08;
    vec4 dv = gn(p + 31.0, 5.0); float divot = kind == 2 ? (1.0 - aastep(0.07, dv.a, gPx * 0.6)) * step(0.72, dv.r) : 0.0;
    bare = max(bare, divot);
  }
  // soil shows through the gaps and in worn spots
  vec3 soil = vec3(0.075, 0.052, 0.032) * (0.6 + 0.8 * gn(p, 150.0).b);
  L.albedo = mix(L.albedo, soil, max(gap * (kind >= 2 ? 0.25 : 0.6), bare)); L.ao = 1.0 - 0.45 * gap * (1.0 - bare);
  L.slope *= 1.0 - 0.6 * bare; L.rough = mix(L.rough, 0.92, bare);
  // at a grazing angle one sees the lit sides and tips of the blades, not the thatch: paler, and facing the viewer
  L.albedo = mix(L.albedo, L.albedo * 1.15 + vec3(0.004, 0.006, 0.0), gGraze * (1.0 - bare) * 0.7);
  L.slope -= gV.xz * 0.12 * gGraze * min(len, 1.2) * (1.0 - bare);
  L.porosity = mix(0.3, 0.85, bare); L.sheen = mix(0.55, 0.8, bare); L.pool = kind >= 2 ? -1.0 : -0.13 + 0.1 * bare; L.silt = vec3(0.06, 0.07, 0.03);
  return L;
}

// Bare ground. kind 0 open earth with stones and dried mud, 1 a track rutted by tyres (q.y along the track).
Layer dirt(vec2 q, int kind) {
  vec2 p = gP; float macro = gn(p, 1.3).r, patchy = gn(p + 41.0, 6.0).g; vec4 clod = gn(p, 52.0), fine = gn(p, 420.0), crumb = gn(p.yx, 170.0);
  vec3 col = mix(vec3(0.115, 0.078, 0.048), vec3(0.25, 0.185, 0.115), 0.55 * macro + 0.45 * patchy);
  col *= (0.72 + 0.4 * clod.r) * (0.85 + 0.3 * fine.b) * (0.8 + 0.35 * (1.0 - smoothstep(0.1, 0.5, crumb.a)));
  Layer L = newLayer(col, 0.95);
  L.slope = gslope(p, 52.0) * 0.03 * relief(0.3) + (crumb.rg - 0.5) * 0.9 * relief(0.09) + (fine.rg - 0.5) * 0.5 * relief(0.04);
  L.height = 0.3 + 0.5 * clod.r; L.ao = 0.8 + 0.2 * clod.r;
  // stones lie on it in drifts
  float stony = smoothstep(0.5, 0.75, gn(p + 13.0, 3.4).r);
  if (stony > 0.0) {
    Layer g = gravel(p, 0.03, vec3(0.16, 0.13, 0.10), vec3(0.40, 0.36, 0.30)); float st = stony * smoothstep(0.45, 0.6, g.height);
    L.albedo = mix(L.albedo, g.albedo, st); L.slope = mix(L.slope, g.slope, st); L.height = mix(L.height, g.height, st);
  }
  // where water stood and dried the silt is pale, smooth and cracked into plates
  float pan = smoothstep(0.62, 0.78, 0.6 * gn(p + 3.0, 2.1).g + 0.4 * (1.0 - macro)) * (1.0 - stony);
  float n1 = gn(p, 23.0).r, n2 = gn(p + 6.5, 31.0).g;
  float cracks = max(1.0 - smoothstep(0.0, 0.012 + gPx * 0.9, abs(n1 - 0.5)), 1.0 - smoothstep(0.0, 0.012 + gPx * 0.9, abs(n2 - 0.5))) * visible(0.012);
  L.albedo = mix(L.albedo, vec3(0.30, 0.235, 0.16) * (0.85 + 0.2 * clod.r), pan * 0.8); L.slope *= 1.0 - 0.7 * pan; L.albedo *= 1.0 - 0.75 * cracks * pan;
  L.height = mix(L.height, 0.2, pan); L.pool = 0.05 + 0.16 * pan + (0.5 - macro) * 0.08;
  // dead grass stalks
  float straw = smoothstep(0.78, 0.86, gnm(p, mat2(1300.0, 500.0, -40.0, 104.0)).r) * smoothstep(0.4, 0.7, gn(p + 29.0, 4.0).r) * visible(0.006);
  L.albedo = mix(L.albedo, vec3(0.36, 0.30, 0.15), straw * 0.8);
  if (kind == 1) {
    float wob = (gn(q * vec2(0.4, 0.06), 9.0).r - 0.5) * 1.3, x = q.x + wob, r = abs(fract(x / 1.8) - 0.5) * 1.8;
    float rut = 1.0 - smoothstep(0.1, 0.3, r), berm = exp(-pow((r - 0.38) / 0.09, 2.0)), hump = smoothstep(0.55, 0.85, r);
    float lug = pulseTrain(q.y / 0.11 + 0.6 * abs(fract(x / 1.8) - 0.5), 0.5, gPx / 0.11) - 0.5;
    L.albedo = mix(L.albedo, L.albedo * 0.62 + vec3(0.008), rut); L.slope *= 1.0 - 0.75 * rut; L.rough = mix(L.rough, 0.8, rut);
    L.albedo *= 1.0 + rut * 0.2 * lug * visible(0.05) + 0.2 * berm; L.slope.y += rut * lug * 0.5 * visible(0.05);
    L.height = mix(L.height, 0.05, rut) + 0.3 * berm; L.pool += 0.26 * rut - 0.05 * berm;
    // grass survives on the hump between the wheels
    float green = hump * smoothstep(0.4, 0.62, 0.6 * patchy + 0.4 * clod.g);
    L.albedo = mix(L.albedo, mix(vec3(0.045, 0.09, 0.025), vec3(0.16, 0.19, 0.06), crumb.b) * (0.6 + 0.6 * fine.r), green * 0.85);
  }
  L.porosity = 0.85; L.sheen = 0.9; L.silt = vec3(0.19, 0.14, 0.085);
  return L;
}
`;

// ---------------------------------------------------------------------------------------------- blending, water, entry
const MAIN_MID = /* glsl */`
bool isPaved(int id) { return id == G_SIDEWALK || id == G_PAVERS || id == G_ASPHALT || id == G_LOT; }

// Share of the primary material at relative blend distance t (0 = the secondary's edge, 1 = the end of the fringe).
// The line between two ground materials is never straight: its character depends on what is spreading over what.
float blendWeight(int a, float t, Layer A, Layer B) {
  float big = gn(gP + 77.0, 3.2).r, mid = gn(gP + 12.0, 21.0).g, fine = gn(gP + 3.0, 190.0).r, edge, soft;
  if (a == G_GRASS || a == G_MEDIAN) {
    // turf ends in tufts: whole clumps reach out and single blades fray the line
    edge = 0.48 * big + 0.27 * mid + 0.25 * (1.0 - A.height) + 0.12 * (fine - 0.5); soft = 0.035;
  } else if (a == G_SAND || a == G_DIRT) {
    // loose material thins out in drifts, lying deepest in the hollows of whatever it covers
    edge = 0.42 * big + 0.2 * mid + 0.3 * B.height + 0.3 * (fine - 0.5); soft = 0.2;
  } else {
    // paving keeps a firm edge; the neighbour creeps a short way over it and further along its joints
    float n = 0.5 * big + 0.3 * mid + 0.2 * fine; edge = n * n * 0.8 + 0.55 * (0.6 - A.height); soft = 0.09;
  }
  edge = clamp(edge, 0.07, 0.93);
  float w = smoothstep(edge - soft, edge + soft, t);
  return max(w * smoothstep(0.0, 0.06, t), smoothstep(0.94, 1.0, t));
}
Layer mixLayer(Layer B, Layer A, float w) {
  Layer L; L.albedo = mix(B.albedo, A.albedo, w); L.slope = mix(B.slope, A.slope, w); L.rough = mix(B.rough, A.rough, w);
  L.ao = mix(B.ao, A.ao, w); L.height = mix(B.height, A.height, w); L.porosity = mix(B.porosity, A.porosity, w);
  L.pool = mix(B.pool, A.pool, w); L.sheen = mix(B.sheen, A.sheen, w); L.coat = mix(B.coat, A.coat, w); L.bead = mix(B.bead, A.bead, w);
  L.silt = mix(B.silt, A.silt, w); L.damp = mix(B.damp, A.damp, w); L.film = mix(B.film, A.film, w);
  return L;
}

// Water on the ground. Everything comes from one height comparison: a water level against the lie of the land plus
// the relief of whatever is on it. Where the level is above the surface there is standing water; a little below it
// the texture is brimming (soaked); below that it is damp. Rain raises the level everywhere for as long as it
// falls; when it stops the ground dries from the high and trafficked spots first and the hollows last.
//   standing  level, mirror-smooth, ringed by raindrops, hides the relief under it
//   soaked    a film over the texture: dark, glossy, deep and smooth in the low places, thin and rough on the crowns
//   damp      water in the surface only: darker and a little smoother
// The planar road mirror (ARCHITECTURE.md section 7) reads exactly these outputs; this function never sees it.
void wetResponse(inout SurfOut o, in Layer L, vec3 N, float upness) {
  float wetness = uWeather.y * saturate(upness * 2.0 - 0.6);
  // the same two octaves as the shared puddleMask(), so a puddle crosses from the road onto any other family
  float terrain = 0.66 * gn(gP, 4.0).r + 0.34 * gn(gP + 10.7, 14.6).g;
  float micro = L.height - 0.5, shore = gn(gP + 3.0, 60.0).r - 0.5;
  float holds = L.pool > -0.9 && upness > 0.7 && uWeather.z > 0.001 ? 1.0 : 0.0;
  // > 0 where the water stands above this pixel. Stones and joints near the waterline break it into islands and inlets.
  float level = mix(0.10, 0.43, uWeather.z) + L.pool - terrain - 0.05 * micro - 0.035 * shore;
  float aa = 0.3 * gPx;
  float standing = max(L.film, holds * smoothstep(0.0, 0.03 + aa, level));
  // what dries last: low ground, sheltered texture
  float lag = 1.0 - (0.6 * terrain + 0.2 * gn(gP + 5.0, 1.7).g + 0.2 * L.height);
  float rain = wetness * 1.5 + lag - 1.0;                                    // > 0 while this spot is still wet from rain
  float soaked = max(smoothstep(0.0, 0.16, rain), holds * smoothstep(-0.05 - aa, -0.012, level));
  float damp = max(smoothstep(-0.25, 0.0, rain) * smoothstep(0.0, 0.05, wetness), holds * smoothstep(-0.14 - aa, -0.04, level));
  soaked = max(soaked, smoothstep(0.5, 0.95, L.damp)); damp = max(max(damp, soaked), L.damp);
  float film = soaked * L.sheen;
  // depth of the film over the texture: brimming in the hollows and between the stones, a skin on the crowns
  float brim = saturate(0.5 + 2.2 * (level + 0.12) - 0.8 * micro);

  vec3 albedo = L.albedo * mix(vec3(1.0), 0.36 + 0.3 * L.albedo, damp * L.porosity);
  // the film lowers the roughness of what it covers in proportion, so a pool of lamp light still shows the texture
  float rough = L.rough * (1.0 - 0.28 * damp) * mix(1.0, mix(0.68, 0.5, brim), film);
  vec2 slope = L.slope * (1.0 - film * mix(0.35, 0.7, brim));
  o.coat = max(L.coat, mix(0.28 * damp, mix(0.5, 0.85, brim), film));
  o.coatRough = mix(mix(0.05, mix(0.3, 0.2, damp), smoothstep(0.0, 0.1, damp)), mix(0.2, 0.06, brim), film);
  o.wet = mix(0.4 * damp, mix(0.45, 0.8, brim), film); o.ao = mix(L.ao, 1.0, 0.5 * film);

  if (standing > 0.0) {
    // water hides the relief under it and takes the colour of what it has washed in
    float depth = saturate(level * 12.0), cloudy = dot(L.silt, vec3(1.0)) > 0.0 ? smoothstep(0.1, 0.9, depth) * 0.8 : 0.0;
    albedo = mix(albedo, mix(albedo * 0.85, L.silt * 0.55, cloudy), standing);
    // drop rings are a few centimetres across and only a millimetre high: a slight tilt of the mirror that shows
    // where it bends a lamp's reflection and nowhere else
    vec3 rings = rainRipples(gP * 2.4, gPx * 2.4);
    vec2 breeze = (gn(gP * vec2(1.0, 0.6) + uWind.xy * uTime.x * 0.035, 110.0).rg - 0.5) * (0.01 + 0.04 * uWind.z) * gNear;
    // a puddle is level: only rings and a breath of wind tilt it, by a few degrees at most
    slope = mix(slope, rings.xy * 0.05 + breeze, standing);
    // still water is a mirror; while rain falls its whole face is chopped by overlapping rings, so it smears the
    // lamps into streaks like the wet road around it instead of showing a sharp piece of black sky
    float mirror = 0.035 + 0.015 * rings.z + 0.09 * uWeather.x;
    rough = mix(rough, mirror, standing); o.coat = mix(o.coat, 1.0, standing); o.coatRough = mix(o.coatRough, mirror, standing);
    o.wet = mix(o.wet, 1.0, standing); o.ao = mix(o.ao, 1.0, standing);
  } else if (film > 0.0 && uWeather.x > 0.0) {
    // drops landing in the film break it up for an instant
    vec3 rings = rainRipples(gP * 3.5 + 3.0, gPx * 3.5); slope += rings.xy * 0.04 * film * brim;
  }
  o.albedo = albedo; o.rough = clamp(rough, 0.02, 1.0);
  // kerb slopes are along the run and across the profile; everything else is flat ground in world axes
  o.N = dot(gAlong, gAlong) > 0.5 ? normalize(N - gAlong * slope.x - cross(N, gAlong) * slope.y) : tiltNormal(N, slope);

  if (L.bead > 0.0) {
    // glass beads in road paint send light back where it came from. A family cannot see the lamps, but it can turn
    // the shading normal of a bead towards the eye, which is where the driver's own headlamps are.
    float bead = step(0.86, gn(gP, 2300.0).b) * gNear, night = 0.12 + 0.88 * uSwitch.w;
    float retro = L.bead * (0.3 + 0.7 * bead) * night * (1.0 - standing);
    o.N = normalize(mix(o.N, gV, 0.5 * retro)); o.rough = mix(o.rough, 0.3, retro); o.coat = max(o.coat, 0.7 * retro * (0.4 + 0.6 * bead));
  }
}

void surface(in SurfIn s, inout SurfOut o) {
  vec3 rel = relativePos(s), dx = dFdx(rel), dy = dFdy(rel);
  float major = max(length(dx), length(dy)), minor = min(length(dx), length(dy));
  gP = s.wpos.xz; gY = s.wpos.y; gDx = dx.xz; gDy = dy.xz; gPx = major;
  gNear = (1.0 - smoothstep(0.006, 0.03, gPx)) * step(0.5, uQuality.x);
  // The noise texture is filtered anisotropically, so what limits fine detail on a road seen at a grazing angle is
  // the short axis of the pixel's footprint (up to the 8:1 the sampler is set to), not the long one.
  float fine = max(minor, major * 0.125);
  gStone = 1.0 - smoothstep(0.12, 0.42, fine / 0.013);
  gStoneN = (1.0 - smoothstep(0.06, 0.24, fine / 0.013)) * step(0.5, uQuality.x);
  gV = s.V; gGraze = smoothstep(0.75, 0.1, dot(s.N, s.V));

  int id = int(s.mat.x + 0.5); float p0 = s.mat.y, p1 = s.mat.z, p2 = s.mat.w, upness = s.N.y;
  int code = int(p1 + 0.5), other = (code & 15) - 1;
  bool walk = id == G_SIDEWALK || id == G_PAVERS, blend = code > 0 && id != G_KERB;
  // world direction in which the blend distance grows, from its screen derivatives
  float bd = walk ? s.occ * BLEND_REACH : s.uv.x;
  float det = gDx.x * gDy.y - gDx.y * gDy.x; vec2 du = vec2(dFdx(bd), dFdy(bd));
  vec2 grad = abs(det) > 1e-12 ? vec2(du.x * gDy.y - du.y * gDx.y, du.y * gDx.x - du.x * gDy.x) / det : vec2(0.0);
  gBlendDir = dot(grad, grad) > 0.04 ? normalize(grad) : vec2(0.0);
  // direction along a kerb run: the gradient of the station on the surface, whichever way the surface faces
  vec2 dv = vec2(dFdx(s.uv.y), dFdy(s.uv.y)); vec3 r1 = cross(dy, s.N), r2 = cross(s.N, dx), along = dv.x * r1 + dv.y * r2;
  gAlong = id == G_KERB && dot(along, along) > 1e-20 ? normalize(along) * sign(dot(dx, r1)) : vec3(0.0);

  Layer L;
`;
// A soft ground material: its own layer, then the noise-broken edge to the material it gives way to.
const SOFT = /* glsl */`{
    float d = blend ? bd : 99.0;
    L = groundLayer(id, int(p0 + 0.5), p2, s.wpos.y, blend && isPaved(other) ? d : 99.0);
    if (walk) walkEdges(L, s.uv);
    if (blend && d < BLEND_REACH) {
      Layer B = groundOther(other, code >> 4, p2, s.wpos.y, 99.0);
      float w = blendWeight(id, d * (1.0 / BLEND_REACH), L, B);
      // the taller material shades the edge of the lower one
      B.albedo *= 1.0 - 0.3 * w * (1.0 - w) * 4.0 * step(B.height, L.height);
      L = mixLayer(B, L, w);
    }
    if (!walk) L.damp = max(L.damp, saturate(s.uv.y));
  }
`;
const MAIN_TAIL = /* glsl */`  // the vertex alpha is occlusion only where it is not already spoken for: marking weight on roads and decals,
  // blend distance on a pavement that fades into something else
  bool spoken = id == G_ASPHALT || id == G_DECK || id == G_TARMAC || id == G_MARKING || (walk && blend);
  if (id != G_MARKING) L.albedo *= s.color;
  if (!spoken) L.ao *= s.occ;
  wetResponse(o, L, s.N, upness);
}
`;

/**
 * Every material in dispatch order. 'call' shades a material that has surface() to itself (roads, decals, kerbs,
 * lots); 'layer' is the expression that builds a material which can be one side of a blend: the soft materials
 * as the near side or the far side, ASPHALT and LOT as the far side only.
 */
export const MATERIALS = Object.freeze([
  { id: GROUND.ASPHALT, call: 'L = asphaltRoad(s.uv, p0 * 0.1, p1, p2 * (1.0 / 255.0), s.occ);', layer: 'asphaltBase(gP, 0.55)' },
  { id: GROUND.DECK, call: 'L = deckRoad(s.uv, p0 * 0.1, p1, p2, s.occ);' },
  { id: GROUND.TARMAC, call: 'L = tarmac(s.uv, int(p0 + 0.5), p1 * 16.0, max(p2, 1.0), s.occ);' },
  { id: GROUND.MARKING, call: 'L = markingDecal(s.uv, s.color, int(p0 + 0.5), p1 * (1.0 / 255.0), p2 * (1.0 / 255.0), s.occ);' },
  { id: GROUND.LOT, call: 'L = lot(headingFrame(p2) * gP, int(p0 + 0.5), p1, true);', layer: 'lot(q, variant, 0.0, false)' },
  { id: GROUND.KERB, call: 'L = kerb(s.uv, p0, p1 > 0.5);' },
  { id: GROUND.SIDEWALK, layer: 'sidewalk(q, variant)' },
  { id: GROUND.SAND, layer: 'sand(y, paved)' },
  { id: GROUND.GRASS, layer: 'grass(q, variant, H * gV.xz)' },
  { id: GROUND.DIRT, layer: 'dirt(q, variant)' },
  { id: GROUND.PAVERS, layer: 'pavers(q, variant)' },
  { id: GROUND.MEDIAN, layer: 'median(q, variant)' },
]);
// the chains name each id by its GLSL constant, so the shader text reads like the id table
const NAME_OF = new Map(Object.entries(GROUND).map(([name, id]) => [id, name]));
const SOFT_IDS = MATERIALS.filter((m) => !m.call).map((m) => m.id);

/**
 * The secondaries each soft material is blended into (p1 blend codes; ARCHITECTURE.md section 5.2, Blends), as the
 * tiles in src/world/tiles/ground.js emit them. A shader built for some ids carries only these as the far side
 * of their blends; a pair that is not listed here draws a flat dark layer as its secondary, so list it.
 */
export const BLENDS = Object.freeze({
  [GROUND.SIDEWALK]: [GROUND.SAND],
  [GROUND.SAND]: [GROUND.SIDEWALK],
  [GROUND.GRASS]: [GROUND.SAND, GROUND.DIRT, GROUND.SIDEWALK, GROUND.PAVERS],
  [GROUND.DIRT]: [GROUND.GRASS, GROUND.LOT],
  [GROUND.PAVERS]: [],
  [GROUND.MEDIAN]: [],
});

// One function per side of a blend, each with only the materials that side can be. Both sides in one function
// would put every material into the shader twice, since each call site is compiled as its own copy.
const layerFunction = (name, ids) => `Layer ${name}(int id, int variant, float heading, float y, float paved) {
  mat2 H = headingFrame(heading); vec2 q = H * gP;
${MATERIALS.filter((m) => ids.has(m.id)).map((m) => `  if (id == G_${NAME_OF.get(m.id)}) return ${m.layer};\n`).join('')}  return newLayer(vec3(0.05), 0.9);
}
`;

/**
 * Which ids are compiled into one shader (see fragmentFor). The Direct3D compiler behind Chrome on Windows needs
 * time that grows with every material in the chain, and the browser kills a GPU process that is busy for too
 * long, so the renderer compiles one shader per group and draws the triangles of those ids with it. A soft
 * material brings the secondaries of its blends with it (BLENDS), which is why each of them is a group of its own.
 */
export const GROUPS = Object.freeze([
  [GROUND.ASPHALT], [GROUND.DECK], [GROUND.TARMAC], [GROUND.MARKING], [GROUND.LOT], [GROUND.KERB],
  [GROUND.SIDEWALK], [GROUND.SAND], [GROUND.GRASS], [GROUND.DIRT], [GROUND.PAVERS, GROUND.MEDIAN],
].map((g) => Object.freeze(g)));

/**
 * The family's fragment source with only the listed ids dispatched (all of them by default). The secondaries
 * of their blends are the ones BLENDS lists for them unless 'partners' names others.
 */
export function fragmentFor(ids = MATERIALS.map((m) => m.id), partners = null) {
  const wanted = new Set(ids), soft = new Set(SOFT_IDS.filter((id) => wanted.has(id)));
  const far = new Set(partners || [...soft].flatMap((id) => BLENDS[id]));
  for (const id of [...wanted, ...far]) if (!NAME_OF.has(id)) throw new Error(`ground: no material with id ${id}`);
  for (const id of far) if (!MATERIALS.some((m) => m.id === id && m.layer)) throw new Error(`ground: ${NAME_OF.get(id)} cannot be a blend secondary`);
  const own = MATERIALS.filter((m) => m.call && wanted.has(m.id))
    .map((m, i) => `  ${i ? 'else ' : ''}if (id == G_${NAME_OF.get(m.id)}) ${m.call}\n`).join('');
  const chain = own + (soft.size ? `  ${own ? 'else ' : ''}${SOFT}` : '');
  const layers = soft.size ? layerFunction('groundLayer', soft) + layerFunction('groundOther', far) : '';
  return COMMON + ROAD + PAVED + STRUCTURES + NATURAL + layers + MAIN_MID + chain + MAIN_TAIL;
}

// Decals share the road's plane. Raising them by a few millimetres, and by more with distance as depth precision
// falls, keeps them from z-fighting without a polygon offset state in the renderer.
const deform = /* glsl */`
void deform(inout vec3 p, inout vec3 n, in DeformIn d) {
  if (int(d.mat.x + 0.5) == ${GROUND.MARKING}) p.y += ${glsl(MARKING_LIFT.BASE)} + ${glsl(MARKING_LIFT.PER_METRE)} * distance(d.origin + p, uCamPos.xyz);
}
`;

export default { name: 'ground', fragment: fragmentFor(), materials: MATERIALS, groups: GROUPS, fragmentFor, deform, alphaTest: false, twoSided: false };
