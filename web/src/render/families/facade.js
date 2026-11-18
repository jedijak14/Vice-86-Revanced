// FACADE surface family: building walls whose windows, doors, mouldings and rooms are computed per pixel.
//
// A wall is a stack of horizontal BANDS (ground storey, upper storeys, parapet). Each band is plain quads with
//   uv       = (metres along the wall from its left end as seen from outside,
//               metres above the base of the band, plus one storey height when the band does not stand on the ground)
//   material = [style byte, storey height in dm, bay width in dm, building seed byte]
//   colour   = wall colour (glass tint on curtain walls), alpha = baked occlusion
// The shader cuts the band into cells of (bay width) x (storey height); one cell holds one opening and one room.
// Row 0 of a band (v < storey height) is treated as standing on the ground: it gets splash-back dirt and contact shade.
//
// Style byte = FACADE id (ids.js) + 16 * type + 128 * flag. `facadeStyle(id, type, flag)` builds it.
// Seed byte  = trim colour index (bits 0..3, into FACADE_TRIMS) + 16 * age (0 fresh .. 3 decayed) + 64 * random (0..3).
//
// Everything the geometry needs to line up with the painted openings (sill and head heights, opening widths) is
// exported from `FACADE_LAYOUT`, and the same numbers are spliced into the GLSL below, so there is one source.

import { FACADE } from '../../core/ids.js';

/** Trim / accent colours, sRGB 0..1 (sampled trims of design/brief/architecture.md 8.2 plus three dark period trims).
 * Index 0..15 lives in the low nibble of the seed byte; geometry uses the same table so mouldings match painted bands. */
export const FACADE_TRIMS = [
  [0.95, 0.94, 0.91],  //  0 white
  [0.34, 0.67, 0.60],  //  1 sea green
  [0.25, 0.72, 0.69],  //  2 turquoise
  [0.94, 0.60, 0.65],  //  3 flamingo pink
  [0.93, 0.50, 0.40],  //  4 coral
  [0.44, 0.51, 0.67],  //  5 periwinkle
  [0.64, 0.75, 0.85],  //  6 pale blue
  [0.91, 0.81, 0.18],  //  7 sun yellow
  [0.82, 0.74, 0.50],  //  8 straw
  [0.82, 0.46, 0.23],  //  9 orange
  [0.72, 0.60, 0.78],  // 10 lilac
  [0.56, 0.81, 0.69],  // 11 mint
  [0.40, 0.49, 0.59],  // 12 slate blue
  [0.13, 0.33, 0.24],  // 13 forest green
  [0.45, 0.16, 0.15],  // 14 oxblood
  [0.13, 0.19, 0.36],  // 15 navy
];

/** Opening geometry per style, metres. Geometry generators read these to place eyebrows, sills, balconies and awnings. */
export const FACADE_LAYOUT = Object.freeze({
  deco: { sill: 0.85, head: 2.30, pier: 0.55, casementMax: 1.80, portholeY: 1.65, portholeR: 0.38, glassBlockW: 0.9, stripeY: [-0.20, 0.05, 0.30], stripeH: 0.11 },
  condo: { sill: 0.06, head: 2.28, pier: 0.30, windowSill: 0.90, upstand: 1.05 },
  curtain: { sill: 0.85, head: 2.95, mullion: 0.06 },
  punched: { sill: 0.90, head: 2.45, slotW: 0.9 },
  shop: { riser: 0.45, head: 2.75, transom: 3.15, doorW: 1.05, doorH: 2.15, pier: 0.28 },
  lowrise: { sill: 0.95, head: 2.20, windowW: 1.05, doorW: 0.92, doorH: 2.05 },
  warehouse: { plinth: 0.9, doorW: 4.2, doorH: 4.6, stripDrop: [1.7, 0.6] },
  mansion: { sill: 0.55, head: 2.75, windowW: 1.25 },
  garage: { upstand: 1.10, beam: 0.42, column: 0.55 },
});

/** Opening types per style (the `type` argument of facadeStyle). */
export const FACADE_TYPE = Object.freeze({
  DECO: { CASEMENT: 0, RIBBON: 1, WRAP: 2, PORTHOLE: 3, GLASS_BLOCK: 4, PLAIN: 5, FLUTED: 6, SIDE: 7 },
  CONDO: { SLIDER: 0, SLIDER_UPSTAND: 1, MIXED: 2, HOTEL_ROOM: 3 },
  CURTAIN: { MIRROR: 0, GRID: 1, BANDED: 2, PIERS: 3 },
  PUNCHED: { SQUARE: 0, SLOT: 1, RIBBON: 2, EGGCRATE: 3, CLINIC: 4, BRICK: 5 },
  SHOPFRONT: { RETAIL: 0, LOBBY: 1, CAFE: 2, SHUTTERED: 3, SHOWROOM: 4, OFFICE_LOBBY: 5, SERVICE: 6, CLUB: 7 },
  LOWRISE: { SHUTTERS: 0, GRILLE: 1, CLAPBOARD: 2, MOTEL: 3, GALLERY: 4, BLOCK: 5 },
  WAREHOUSE: { SHEET: 0, DOORS: 1, BRICK: 2, TILT_UP: 3, HANGAR_DOOR: 4 },
  MANSION: { ARCHED: 0, ARCADE: 1, SHUTTERS: 2, MODERN: 3 },
  BLANK: { STUCCO: 0, SERVICE: 1, BRICK: 2, CONCRETE: 3, SHEET: 4, TILE: 5, PARAPET: 6, MURAL: 7 },
  GARAGE: { SPANDREL: 0, FINS: 1, RAIL: 2 },
});

/** Style byte for a wall band. flag: racing stripes / accent band / dark tile base, depending on the style. */
export function facadeStyle(id, type = 0, flag = false) { return id + 16 * (type & 7) + (flag ? 128 : 0); }
/** Seed byte from a trim index, an age 0..3 and any integer for the rest. */
export function facadeSeed(trim, age, random) { return (trim & 15) | ((age & 3) << 4) | ((random & 3) << 6); }

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const trimsGlsl = FACADE_TRIMS.map((c) => `vec3(${c.map((v) => lin(v).toFixed(4)).join(', ')})`).join(', ');
const L = FACADE_LAYOUT;

const TOOLS = /* glsl */`
// ============================================================================ FACADE
const vec3 FAC_TRIM[16] = vec3[16](${trimsGlsl});

// One cell's description, filled in by the style and consumed by the shared wall / opening code.
struct FacLay {
  vec2 oc, oh;        // opening centre and half size, cell metres (oh.x <= 0: no opening)
  float shape;        // 0 rectangle, 1 circle, 2 round-headed
  float reveal;       // how far the glass sits behind the wall face, metres
  float frameW;       // frame face width, metres
  vec3 frameCol; float frameMetal;
  vec2 panes;         // glazing divisions across and up
  float barW;         // glazing bar width, metres
  float sill;         // projecting sill height below the opening, metres (0 none)
  vec3 glassTint; float glassMetal; float see;   // see: how much of the room shows through by day, 0..1
  float interior;     // 0 home, 1 office, 2 shop, 3 lobby or cafe, 4 parking deck, 5 shed, 6 glass block, 7 solid panel
  float roomD;        // room depth, metres
  float drape;        // 0 none, 1 curtains and blinds chosen per window
  float litBase;      // fraction of rooms lit when the window channel is fully on
  float wallKind;     // 0 stucco, 1 concrete, 2 corrugated sheet, 3 brick, 4 clapboard, 5 glazed tile, 6 metal panel
  vec3 wallCol;
  float wallRough; float wallMetal;
  vec3 panelCol;      // colour of a solid panel (doors, shutters, roller doors), interior 7
  float panelKind;    // 0 flat door, 1 roller slats, 2 louvres, 3 ribbed sheet
};

// ---- small tools
// Box-filtered coverage of the interval [a, b] by a pixel of width w centred at x. Exact for thin lines.
float facCov(float x, float a, float b, float w) { return saturate((min(x + 0.5 * w, b) - max(x - 0.5 * w, a)) / w); }
float facLine(float x, float c, float halfW, float w) { return facCov(x, c - halfW, c + halfW, w); }
// Coverage of a rectangle given by centre and half size.
float facRect(vec2 p, vec2 c, vec2 h, vec2 w) { return facCov(p.x, c.x - h.x, c.x + h.x, w.x) * facCov(p.y, c.y - h.y, c.y + h.y, w.y); }
// Periodic line pattern: lines of half width hw every 'period', coverage averaged correctly when the pixel is wider than a period.
float facGrid(float x, float period, float hw, float w) {
  float k = x / period, fk = abs(fract(k + 0.5) - 0.5) * period;
  float near = saturate((hw - fk) / w + 0.5), far = 2.0 * hw / period;
  return mix(near, far, saturate(w / period * 1.5 - 0.5));
}
float facHash(vec2 cell, float seed, float salt) { return hash13(vec3(cell, seed * 7.0 + salt)); }

float facOpeningSd(vec2 p, FacLay L) {
  vec2 q = p - L.oc;
  if (L.shape > 0.5 && L.shape < 1.5) return length(q) - L.oh.x;
  if (L.shape > 1.5) { float sy = L.oh.y - L.oh.x; if (q.y > sy) return length(vec2(q.x, q.y - sy)) - L.oh.x; }
  vec2 d = abs(q) - L.oh; return max(d.x, d.y);
}
`;

const WALL_HEAD = /* glsl */`// ---- wall surfaces. p = wall metres (u, v), cp = cell metres. Writes albedo / roughness / metal / a slope for the normal.
void facWall(in FacLay L, vec2 p, vec2 cp, float storey, float age, float seed, float dist, vec2 w,
             out vec3 alb, out float rough, out float metal, out vec2 slope, out float ao) {
  alb = L.wallCol; rough = L.wallRough; metal = L.wallMetal; slope = vec2(0.0); ao = 1.0;
  float micro = saturate(1.0 - dist / 45.0);                    // fine detail fades before it can shimmer
  float px = max(w.x, w.y);
  float blot = fbm(p * 0.37 + seed, 3) - 0.5;                   // slow tonal drift, metres-scale
  int kind = int(L.wallKind + 0.5);
`;
/** Every wall finish facWall can draw, in dispatch order: the value of FacLay.wallKind and the GLSL block that draws it. */
export const WALLS = Object.freeze([
  { kind: 0, code: /* glsl */`{   // stucco: sand finish, patched repainting, hairline cracks
    float drift = fbm(p * 0.045 + seed * 1.3, 3) - 0.5;          // house-scale: the side that takes the weather, the damp corner
    alb *= 1.0 + drift * 0.24 + blot * (0.12 + 0.12 * age);
    float patchN = smoothstep(0.62, 0.66, vnoise(p * 0.21 + seed * 3.1)) * age;   // repainted patches a shade off, and smoother than the old coat
    alb = mix(alb, alb * vec3(1.09, 1.05, 0.96), patchN * 0.7); rough -= 0.12 * patchN;
    float repairN = vnoise(p * vec2(0.45, 0.6) + seed * 5.7) + 0.16 * (vnoise(p * 2.7 + seed) - 0.5) + 0.07 * (vnoise(p * 8.3) - 0.5);
    float repair = smoothstep(0.78, 0.80, repairN) * step(0.45, age);   // cement repairs nobody painted: ragged trowelled patches, darker than any paint
    alb = mix(alb, vec3(0.34, 0.33, 0.31) * (1.0 + blot * 0.3), repair * 0.6); rough += 0.08 * repair;
    float fadeP = smoothstep(0.30, 0.8, vnoise(p * vec2(0.11, 0.07) + seed * 0.7) + drift * 0.6) * (0.35 + 0.65 * age);   // paint chalks and bleaches in the sun, unevenly
    alb = mix(alb, vec3(luma(alb)) * 1.06 + 0.02, 0.12 + fadeP * 0.38); rough = mix(rough, 0.97, fadeP * 0.6);
    float wash = smoothstep(0.45, 0.95, vnoise(vec2(p.x * 2.6 + seed, p.y * 0.12)) * 0.7 + vnoise(vec2(p.x * 9.0, p.y * 0.3 + seed)) * 0.3);   // years of rain carrying dust down the face
    alb *= 1.0 - wash * (0.09 + 0.13 * age);
    float salt = smoothstep(0.58, 0.9, fbm(p * vec2(0.9, 0.5) + seed * 2.3, 3)) * (1.0 - smoothstep(0.2, 1.7, p.y)) * age;   // efflorescence creeping up from damp footings
    alb = mix(alb, vec3(0.80, 0.79, 0.76), salt * 0.5);
    if (micro > 0.0) {
      vec2 g = tnoise(p * 23.0) - 0.5; vec2 g2 = tnoise(p * 71.0 + 3.0) - 0.5; float fine = saturate(1.0 - dist / 12.0);
      // the relief is the sand grain only: blue noise has no metre-scale content, so a wall stays one flat plane
      // from the street (the fractal fields would tilt it by degrees over metres and blotch it in grazing sun);
      // the fractal fields go into albedo and roughness instead, and the grain fades out with the pixel footprint
      vec2 grain = vec2(noiseTex(p * 23.0).b, noiseTex(p * 23.0 + 57.3).b) - 0.5;
      slope += grain * 0.09 * saturate(1.0 - px / 0.03) * micro;
      alb *= 1.0 + (g.x + g.y) * 0.07 * micro + (g2.x - g2.y) * 0.05 * fine; rough += (g.x - g.y) * 0.10 * micro + blot * 0.12;
      if (age > 0.2) {                                         // hairline cracks: a level line of slow noise, shown only in a few patches
        float cn = vnoise(p * 0.9 + seed * 1.7) + 0.35 * vnoise(p * 3.1 + 9.0), cg = max(fwidth(cn), 1e-4);
        float crack = (1.0 - smoothstep(0.0, 1.5, abs(cn - 0.62) / cg * (px / 0.004 > 1.0 ? 1.0 : px / 0.004))) * smoothstep(0.55, 0.7, vnoise(p * 0.23 + seed * 4.3)) * micro;
        alb *= 1.0 - crack * 0.5 * age; }
    }
  }` },
  { kind: 1, code: /* glsl */`{   // cast concrete: panel joints, tie holes, blotchy curing
    float driftC = fbm(p * 0.05 + seed * 1.9, 3) - 0.5;
    alb *= 1.0 + blot * 0.24 + driftC * 0.22; rough += blot * 0.12;
    float runC = smoothstep(0.5, 0.95, vnoise(vec2(p.x * 2.2 + seed, p.y * 0.1)) * 0.7 + vnoise(vec2(p.x * 8.0, p.y * 0.25)) * 0.3);   // water marks down the face
    alb *= 1.0 - runC * (0.10 + 0.16 * age);
    float jx = facGrid(p.x, 2.4, 0.008, w.x), jy = facGrid(cp.y, storey, 0.010, w.y);
    alb *= 1.0 - 0.45 * max(jx, jy);
    if (micro > 0.0) { vec2 g = tnoise(p * 9.0) - 0.5; alb *= 1.0 + g.x * 0.10 * micro; rough += g.y * 0.08 * micro; slope += (vec2(noiseTex(p * 31.0).b, noiseTex(p * 31.0 + 41.7).b) - 0.5) * 0.05 * saturate(1.0 - px / 0.02) * micro;   // board-formed grain, no metre-scale tilt
      vec2 th = abs(fract(p / vec2(1.2, 0.9)) - 0.5) * vec2(1.2, 0.9); alb *= 1.0 - 0.35 * micro * (1.0 - smoothstep(0.018, 0.03 + px, length(th))); }
  }` },
  { kind: 2, code: /* glsl */`{   // corrugated sheet: ribs, sheet laps, fastener rust
    float ph = p.x * (TAU / 0.19); float fade = saturate(1.0 - w.x / 0.12);
    slope.x += cos(ph) * 0.55 * fade; alb *= 1.0 + 0.10 * sin(ph) * fade;
    alb *= 1.0 - 0.25 * facGrid(p.x, 0.95, 0.006, w.x) - 0.20 * facGrid(cp.y, 2.4, 0.01, w.y);
    alb *= 1.0 + blot * 0.16;
    float rust = smoothstep(0.55, 0.8, vnoise(vec2(p.x * 1.7, p.y * 0.22) + seed * 5.0) + age * 0.25 - 0.25) * (0.3 + 0.7 * age);
    alb = mix(alb, vec3(0.20, 0.085, 0.035) * (0.7 + blot), rust * 0.75); rough = mix(rough, 0.9, rust); metal *= 1.0 - rust;
  }` },
  { kind: 3, code: /* glsl */`{   // brick: stretcher bond, per-brick tone, recessed mortar
    vec2 bs = vec2(0.225, 0.075); float row = floor(p.y / bs.y); vec2 bp = vec2(p.x + 0.5 * bs.x * mod(row, 2.0), p.y);
    vec2 id = floor(bp / bs), fr = bp - id * bs; float fadeB = saturate(1.0 - px / 0.05);
    float mort = max(1.0 - facCov(fr.x, 0.006, bs.x - 0.006, w.x), 1.0 - facCov(fr.y, 0.006, bs.y - 0.006, w.y));
    float tone = hash12(id + seed * 11.0);
    alb *= mix(1.0, 0.78 + 0.44 * tone, fadeB); alb = mix(alb, vec3(0.62, 0.59, 0.53) * (0.8 + blot * 0.5), mort * 0.85);
    alb *= 1.0 + blot * 0.18; rough = 0.9;
    slope += vec2(fr.x < 0.012 ? 1.0 : fr.x > bs.x - 0.012 ? -1.0 : 0.0, fr.y < 0.012 ? 1.0 : fr.y > bs.y - 0.012 ? -1.0 : 0.0) * 0.5 * fadeB * micro;
  }` },
  { kind: 4, code: /* glsl */`{   // timber clapboard: lapped boards, peeling paint
    float bh = 0.14, fy = fract(p.y / bh), fadeC = saturate(1.0 - w.y / 0.07);
    alb *= 1.0 - (0.42 * smoothstep(0.80, 1.0, fy) + 0.10 * (1.0 - fy)) * fadeC;   // shadow under each lap
    slope.y += (fy - 0.5) * 0.25 * fadeC;
    float board = floor(p.y / bh);
    alb *= 1.0 + (hash12(vec2(board, seed)) - 0.5) * 0.10 + blot * 0.14;
    float peel = smoothstep(0.60, 0.72, vnoise(vec2(p.x * 2.3, board * 1.7) + seed) * 0.7 + vnoise(p * 9.0) * 0.3 + age * 0.22 - 0.2) * step(0.2, age);
    alb = mix(alb, vec3(0.33, 0.30, 0.26) * (0.8 + 0.4 * vnoise(vec2(p.x * 40.0, board))), peel * 0.8);
  }` },
  { kind: 5, code: /* glsl */`{   // glazed tile: glossy, tight joints
    float ts = 0.15; float j = max(facGrid(p.x, ts, 0.0025, w.x), facGrid(p.y, ts, 0.0025, w.y));
    vec2 id = floor(p / ts); alb *= 1.0 + (hash12(id + seed) - 0.5) * 0.08 * saturate(1.0 - px / 0.1);
    alb = mix(alb, vec3(0.5, 0.5, 0.48), j * 0.6); rough = mix(0.14, 0.6, j);
    slope += (hash22(id + 3.0) - 0.5) * 0.02 * micro;         // tiles never lie quite flat: lively reflections
  }` },
  { kind: 6, code: /* glsl */`{   // flat metal or precast panel with open joints
    float j = max(facGrid(p.x, 1.2, 0.006, w.x), facGrid(cp.y, storey, 0.008, w.y)); alb *= 1.0 - 0.5 * j; alb *= 1.0 + blot * 0.06;
  }` },
]);

const ROOM_HEAD = /* glsl */`
// ---- rooms behind the glass. q = point on the glass in cell metres, r = ray into the room (z > 0 inwards), unnormalised.
// Returns the room's reflectance in 'alb' and how brightly its own lamp lights that point in 'lightAmt' (lamp fittings > 1).
void facRoom(in FacLay L, vec2 q, vec3 r, vec2 cell, float bay, float storey, float seed, float px,
             out vec3 alb, out float lightAmt) {
  int kind = int(L.interior + 0.5);
  float W = bay, y0 = 0.0, y1 = storey - 0.32, D = L.roomD;
  if (kind == 4) { y1 = storey - 0.45; }
  vec3 o = vec3(q.x, clamp(q.y, y0 + 0.01, y1 - 0.01), 0.0);
  float tx = abs(r.x) < 1e-4 ? 1e5 : (r.x > 0.0 ? (W - o.x) : -o.x) / r.x;
  float ty = abs(r.y) < 1e-4 ? 1e5 : (r.y > 0.0 ? (y1 - o.y) : (y0 - o.y)) / r.y;
  float tz = D / r.z;
  if (kind == 1 || kind == 4) tx = 1e5;                         // open-plan floors and parking decks have no cross walls
  float t = min(tx, min(ty, tz)); vec3 h = o + r * t;
  float hA = facHash(cell, seed, 31.0), hB = facHash(cell, seed, 47.0), hC = facHash(cell, seed, 59.0);
  vec3 wallTone = mix(vec3(0.62, 0.56, 0.47), vec3(0.50, 0.56, 0.57), hA);        // cream to pale blue-grey
  wallTone = mix(wallTone, vec3(0.80, 0.62, 0.56), step(0.7, hB));                   // some salmon, some wood panelling
  vec3 lamp = vec3(W * 0.5, y1 - 0.25, D * 0.45); vec3 n;
  if (t == tz) { alb = wallTone; n = vec3(0.0, 0.0, -1.0); }
  else if (t == tx) { alb = wallTone * 0.92; n = vec3(-sign(r.x), 0.0, 0.0); }
  else if (r.y > 0.0) { alb = vec3(0.86, 0.85, 0.80); n = vec3(0.0, -1.0, 0.0); }
  else { alb = mix(vec3(0.30, 0.22, 0.16), vec3(0.22, 0.25, 0.30), hC); n = vec3(0.0, 1.0, 0.0); }
  float fitting = 0.0;
`;
/** Every interior facRoom can draw, in dispatch order: the value of FacLay.interior and the GLSL block that furnishes it. */
export const ROOMS = Object.freeze([
  { kind: 0, code: /* glsl */`{   // ---- home / hotel room
    if (t == tz) {                                              // a picture, and a headboard or dresser against the back wall
      vec2 pc = vec2(W * (0.3 + 0.4 * hB), 1.55); vec2 d = abs(h.xy - pc) - vec2(0.38, 0.27);
      if (max(d.x, d.y) < 0.0) alb = max(d.x, d.y) > -0.04 ? vec3(0.25, 0.18, 0.10) : mix(vec3(0.35, 0.5, 0.6), vec3(0.75, 0.45, 0.3), hC);
      if (h.y < 0.95 && abs(h.x - W * (0.25 + 0.5 * hC)) < 0.85) alb = mix(vec3(0.32, 0.20, 0.12), vec3(0.55, 0.50, 0.45), hA);
    }
    bool lampOnly = hC > 0.62, strip = hC < 0.2;                // three ways to light a room: ceiling bowl, kitchen strip, table lamp alone
    if (t == ty && r.y > 0.0 && !lampOnly) { vec2 dl = abs(h.xz - lamp.xz); fitting = strip ? (1.0 - smoothstep(0.55, 0.57 + px, dl.x)) * (1.0 - smoothstep(0.06, 0.08 + px, dl.y)) : 1.0 - smoothstep(0.16, 0.20 + px, length(dl)); }
    if (lampOnly) lamp = vec3(W * (0.18 + 0.64 * hA), 1.3, D * 0.5);
    // wardrobe or shelving against a side wall
    if (t == tx && h.y < 1.9 && h.z > D * 0.45 && hA > 0.4) alb = mix(vec3(0.28, 0.18, 0.11), vec3(0.6, 0.57, 0.5), step(0.75, hB)) * (0.8 + 0.2 * step(0.05, fract(h.z / 0.6)));
    // a table lamp on a plane part-way into the room
    float tp = (D * 0.55) / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy - vec2(W * (0.18 + 0.64 * hA), 0.0);
      float shade = step(abs(lp.x), 0.10 + (1.42 - lp.y) * 0.25) * step(1.08, lp.y) * step(lp.y, 1.42);
      float stem = step(abs(lp.x), 0.03) * step(lp.y, 1.08) * step(0.62, lp.y), table = step(abs(lp.x), 0.34) * step(lp.y, 0.62);
      if (hB > 0.35 || lampOnly) { if (shade > 0.5) { alb = vec3(0.95, 0.85, 0.62); fitting = 0.75; n = vec3(0.0, 0.0, -1.0); } else if (stem + table > 0.5) { alb = vec3(0.20, 0.13, 0.08); n = vec3(0.0, 0.0, -1.0); } } }
  }` },
  { kind: 1, code: /* glsl */`{   // ---- office floor: luminaire grid, desks and partitions
    if (t == ty && r.y > 0.0) { vec2 g = abs(fract(h.xz / vec2(1.5, 2.4) + 0.5) - 0.5) * vec2(1.5, 2.4); fitting = (1.0 - smoothstep(0.28, 0.30 + px, g.x)) * (1.0 - smoothstep(0.58, 0.60 + px, g.y)); alb = vec3(0.80, 0.80, 0.78); }
    if (t == tz) alb = mix(vec3(0.55, 0.56, 0.58), vec3(0.62, 0.56, 0.48), hA);
    float tp = (D * 0.35) / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy; float cubicle = step(lp.y, 1.45) * step(0.08, fract(lp.x / 2.6 + hA)); if (cubicle > 0.5) { alb = mix(vec3(0.42, 0.44, 0.48), vec3(0.50, 0.42, 0.36), hB); n = vec3(0.0, 0.0, -1.0); } }
  }` },
  { kind: 2, code: /* glsl */`{   // ---- shop: shelves of goods, a counter, strip lights
    if (t == tz || t == tx) { float sh = fract(h.y / 0.42); vec2 gid = floor(vec2((t == tz ? h.x : h.z) / 0.28, h.y / 0.42)); vec3 goods = 0.25 + 0.75 * hash32(gid + seed * 3.0 + cell * 17.0); goods = mix(vec3(dot(goods, vec3(0.3, 0.5, 0.2))), goods, 0.4) * vec3(1.0, 0.94, 0.84);   // packaging on shelves: mostly paper and card, a little colour
      alb = h.y < 2.2 ? mix(goods * goods, vec3(0.75, 0.72, 0.66), step(0.86, sh)) : wallTone; }
    if (t == ty && r.y > 0.0) { float g = abs(fract(h.z / 1.8 + 0.5) - 0.5) * 1.8; fitting = 1.0 - smoothstep(0.07, 0.09 + px, g); }
    if (t == ty && r.y <= 0.0) alb = mix(vec3(0.55, 0.52, 0.47), vec3(0.42, 0.40, 0.38), step(0.5, fract(floor(h.x / 0.3) * 0.5 + floor(h.z / 0.3) * 0.5)));
    float tp = (D * 0.42) / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy; if (lp.y < 1.0 && fract(lp.x / (W * 0.999) + hA) > 0.35) { alb = lp.y > 0.94 ? vec3(0.8, 0.78, 0.72) : mix(vec3(0.45, 0.25, 0.15), vec3(0.2, 0.3, 0.4), hB); n = vec3(0.0, 0.0, -1.0); } }
    float td = 0.7 / r.z; if (td < t) { vec2 lp = (o + r * td).xy; vec2 did = floor(vec2(lp.x / 0.55, 0.0)); float hh = 0.45 + 0.5 * hash12(did + cell * 5.0 + seed);    // goods stood in the window
      if (lp.y < hh && fract(lp.x / 0.55) > 0.18) { vec3 c = hash32(did + cell * 9.0 + seed); alb = 0.15 + 0.8 * c * c; n = vec3(0.0, 0.0, -1.0); } }
  }` },
  { kind: 3, code: /* glsl */`{   // ---- lobby or cafe: pendant lamps, a long counter, tables
    if (t == ty && r.y <= 0.0) { vec2 tc = floor(h.xz / 0.6); alb = mix(vec3(0.74, 0.68, 0.58), vec3(0.50, 0.30, 0.26), step(0.5, fract((tc.x + tc.y) * 0.5))); }
    if (t == tz) { alb = mix(wallTone, vec3(0.30, 0.20, 0.14), step(h.y, 1.1)); float bottles = step(1.25, h.y) * step(h.y, 2.3) * step(0.3, fract(h.y / 0.36)); alb = mix(alb, 0.2 + 0.7 * hash32(floor(vec2(h.x / 0.12, h.y / 0.36)) + seed), bottles * step(0.5, hB)); }
    float tp = (D * 0.5) / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy; float gx = abs(fract(lp.x / 1.7 + hA) - 0.5) * 1.7;
      if (abs(gx) < 0.06 + (y1 - 0.62 - lp.y) * 0.55 && lp.y > y1 - 0.86 && lp.y < y1 - 0.62) { alb = vec3(1.0, 0.85, 0.6); fitting = 0.5; n = vec3(0.0, 0.0, -1.0); }   // pendant shades
      else if (abs(gx) < 0.008 + px && lp.y >= y1 - 0.62) { alb = vec3(0.05); n = vec3(0.0, 0.0, -1.0); }
      else if (lp.y < 0.76 && gx < 0.45) { alb = lp.y > 0.70 ? vec3(0.82, 0.80, 0.76) : vec3(0.16, 0.12, 0.10); n = vec3(0.0, 0.0, -1.0); } }
  }` },
  { kind: 4, code: /* glsl */`{   // ---- parking deck: beams, tube lights, parked cars
    if (t == ty && r.y > 0.0) { float beam = facGrid(h.z, 2.7, 0.2, px); alb = mix(vec3(0.50, 0.49, 0.46), vec3(0.30, 0.30, 0.29), beam); float g = abs(fract(h.z / 5.4 + 0.25) - 0.5) * 5.4, gx = fract(h.x / 4.0 + 0.5 * hA); fitting = (1.0 - smoothstep(0.05, 0.07 + px, g)) * step(gx, 0.32); }
    else if (t == ty) alb = vec3(0.20, 0.20, 0.21);
    else { alb = vec3(0.34, 0.34, 0.33); if (fract(h.x / 8.0) < 0.07) alb = vec3(0.55, 0.52, 0.30); }
    float tp = 3.2 / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy; float slot = floor(lp.x / 2.6 + hA * 3.0), fxs = fract(lp.x / 2.6 + hA * 3.0) * 2.6; float present = step(0.42, hash12(vec2(slot, cell.y * 7.0 + seed)));
      float body = step(0.22, fxs) * step(fxs, 2.1) * step(0.28, lp.y) * step(lp.y, 0.92), cabin = step(0.5, fxs) * step(fxs, 1.85) * step(lp.y, 1.38) * step(0.92, lp.y);
      if (present * (body + cabin) > 0.5) { vec3 c = hash32(vec2(slot, cell.y + seed * 3.0)); alb = cabin > 0.5 ? vec3(0.05, 0.06, 0.07) : mix(vec3(0.5), c * c, 0.7); n = vec3(0.0, 0.0, -1.0); h = o + r * tp; } }
  }` },
  { kind: 5, code: /* glsl */`{   // ---- shed: crates in the gloom, one hanging lamp
    alb = vec3(0.30, 0.28, 0.25); if (t == ty && r.y <= 0.0) alb = vec3(0.36, 0.35, 0.33);
    float tp = (D * 0.5) / r.z; if (tp < t) { vec2 lp = (o + r * tp).xy; vec2 cid = floor(lp / vec2(1.2, 1.1)); float hh = floor(1.0 + 2.9 * hash12(vec2(cid.x, seed + cell.x * 3.0)));
      if (cid.y < hh && lp.y > 0.0) { vec2 cf = fract(lp / vec2(1.2, 1.1)); alb = mix(vec3(0.42, 0.30, 0.17), vec3(0.25, 0.32, 0.40), step(0.7, hash12(cid + seed))) * (0.75 + 0.25 * step(0.06, min(cf.x, cf.y))); n = vec3(0.0, 0.0, -1.0); h = o + r * tp; }
      if (length(lp - vec2(W * 0.5, y1 - 0.9)) < 0.2) { fitting = 1.0; alb = vec3(1.0, 0.9, 0.7); } }
  }` },
]);
const ROOM_TAIL = /* glsl */`  vec3 toL = lamp - h; float d2 = dot(toL, toL);
  // Section 4.6 wants a lit interior at 1 to 4 units; that is the fitting. The walls it lights sit well under one
  // unit, or the window is a white card at night exposure and nothing of the room survives the tone curve.
  lightAmt = (0.06 + 1.5 * saturate(dot(n, toL) * inversesqrt(d2) * 0.6 + 0.4) / (1.0 + 0.35 * d2)) * (1.0 - fitting) + fitting * 6.0;
  alb *= 0.75 + 0.25 * smoothstep(0.0, 0.5, min(min(h.x, W - h.x) + (tx > 1e4 ? 1.0 : 0.0), min(h.y - y0, y1 - h.y)));   // corner darkening
}
`;

const STYLE_HEAD = /* glsl */`
// ---- the styles. cp = cell metres, cell = (bay index, storey index).
FacLay facStyle(int id, int type, bool flag, vec2 cp, vec2 cell, float bay, float storey, float seed, vec3 wallCol, vec3 trim, float age, vec2 w) {
  FacLay L;
  L.oc = vec2(bay * 0.5, storey * 0.5); L.oh = vec2(-1.0); L.shape = 0.0; L.reveal = 0.12; L.frameW = 0.05; L.frameCol = vec3(0.86, 0.86, 0.84); L.frameMetal = 0.0;
  L.panes = vec2(1.0); L.barW = 0.03; L.sill = 0.0; L.glassTint = vec3(0.05, 0.065, 0.07); L.glassMetal = 0.0; L.see = 0.55;
  L.interior = 0.0; L.roomD = 4.5; L.drape = 1.0; L.litBase = 0.55; L.wallKind = 0.0; L.wallCol = wallCol; L.wallRough = 0.86; L.wallMetal = 0.0;
  L.panelCol = trim; L.panelKind = 0.0;
  float hb = facHash(cell, seed, 3.0), hc = facHash(vec2(cell.x, 0.0), seed, 5.0);
`;
const SURFACE_HEAD = /* glsl */`  return L;
}

void surface(in SurfIn s, inout SurfOut o) {
  // ---- decode the band
  float sb = s.mat.x; int id = int(mod(sb, 16.0) + 0.5); int type = int(mod(floor(sb / 16.0), 8.0) + 0.5); bool flag = sb > 127.5;
  float storey = max(s.mat.y * 0.1, 1.0), bay = max(s.mat.z * 0.1, 0.6), seedB = s.mat.w;
  int trimIx = int(mod(seedB, 16.0) + 0.5); float age = mod(floor(seedB / 16.0), 4.0) / 3.0; vec3 trim = FAC_TRIM[trimIx];
  vec2 p = s.uv; vec2 cell = floor(p / vec2(bay, storey)); vec2 cp = p - cell * vec2(bay, storey);
  vec2 w = max(fwidth(p), vec2(1e-4)); float px = max(w.x, w.y);
  bool ground = cell.y < 0.5;
  // wall frame: T runs with u, the wall's own up vector, N out of the wall
  vec3 Ng = normalize(s.N); vec3 T = cross(vec3(0.0, 1.0, 0.0), Ng); float tl = length(T); T = tl > 1e-3 ? T / tl : vec3(1.0, 0.0, 0.0); vec3 Bv = cross(Ng, T);
  vec3 vt = vec3(dot(s.V, T), dot(s.V, Bv), max(dot(s.V, Ng), 0.06));

  FacLay L = facStyle(id, type, flag, cp, cell, bay, storey, seedB, s.color, trim, age, w);

  // ---- wall
  vec3 alb; float rough, metal, wao; vec2 slope;
  facWall(L, p, cp, storey, age, seedB, s.dist, w, alb, rough, metal, slope, wao);
  float sd = L.oh.x > 0.0 ? facOpeningSd(cp, L) : 1e3;
  float open = saturate(0.5 - sd / px);
  // weathering that depends on the openings: streaks under sills, grime in the reveal's lee, splash-back at the ground
  float streakN = vnoise(vec2(p.x * 5.5 + seedB, p.y * 0.35)) * 0.6 + vnoise(vec2(p.x * 17.0, p.y * 0.8 + seedB)) * 0.4;
  float below = (L.oc.y - L.oh.y) - cp.y;                         // metres below the sill line
  float under = L.oh.x > 0.0 && L.interior < 6.5 ? step(abs(cp.x - L.oc.x), L.oh.x + 0.12) * smoothstep(0.0, 0.05, below) * (1.0 - smoothstep(0.1, 0.9 + 0.9 * age, below)) : 0.0;
  float ends = L.oh.x > 0.0 ? smoothstep(L.oh.x - 0.22, L.oh.x + 0.02, abs(cp.x - L.oc.x)) : 0.0;   // water runs off the two ends of a sill
  float streak = under * (0.35 + 0.65 * ends) * smoothstep(0.30, 0.75, streakN) * (0.5 + 0.5 * age);
  float topRun = smoothstep(0.45, 0.9, streakN) * smoothstep(storey - 1.4 - 1.5 * age, storey, cp.y) * (0.30 + 0.45 * age) * step(L.wallKind, 1.5);
  if (id == 8 && type == 6) topRun = smoothstep(0.3, 0.85, streakN) * smoothstep(0.0, storey, cp.y) * (0.2 + 0.5 * age);
  float grime = max(streak, topRun);
  if (ground) { float splash = (1.0 - smoothstep(0.0, 0.55 + 0.5 * vnoise(vec2(p.x * 1.3, seedB)), cp.y)); grime = max(grime, splash * (0.38 + 0.4 * age)); wao *= 0.62 + 0.38 * smoothstep(0.0, 0.45, cp.y); }
  alb = mix(alb, alb * vec3(0.42, 0.40, 0.36), grime * step(L.wallMetal, 0.5));
  // the sill: a lit top edge and the shadow line beneath it
  if (L.sill > 0.0 && L.oh.x > 0.0) {
    float sx = facCov(cp.x, L.oc.x - L.oh.x - 0.07, L.oc.x + L.oh.x + 0.07, w.x), y0 = L.oc.y - L.oh.y;
    float body = sx * facCov(cp.y, y0 - L.sill, y0, w.y), shade = sx * facCov(cp.y, y0 - L.sill - 0.05, y0 - L.sill, w.y);
    alb = mix(alb, mix(L.wallCol, trim, 0.5) * 1.05, body * (1.0 - open)); wao *= 1.0 - 0.45 * shade * (1.0 - body);
  }
  // shade thrown by the eyebrow that the geometry puts over these window types
  if (id == 0 && type <= 2) { float top = ${f(L.deco.head)} + 0.14; float sh = facCov(cp.y, top - 0.55, top, w.y) * smoothstep(top - 0.55, top, cp.y);
    float span = type == 0 ? facCov(cp.x, L.oc.x - L.oh.x - 0.4, L.oc.x + L.oh.x + 0.4, w.x) : 1.0; wao *= 1.0 - 0.5 * sh * span; }
  // crevice shade hugging the opening
  if (L.oh.x > 0.0) wao *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 0.10, sd)) * step(0.0, sd);

  o.albedo = alb; o.rough = rough; o.metal = metal; o.ao = s.occ * wao; o.N = normalize(Ng - T * slope.x - Bv * slope.y);

  // ---- opening
  if (open > 0.001) {
    vec2 par = -vt.xy / vt.z;                                     // how far the line of sight slides across the wall per metre of depth
    vec2 q = cp + par * L.reveal; float sd2 = facOpeningSd(q, L);
    vec3 oAlb; float oRough = 0.8, oMetal = 0.0, oAo = 1.0, oCoat = 0.0, oWet = 0.0; vec3 oN = Ng, oEmi = vec3(0.0);
    float pxq = px;
    if (sd2 > 0.0) {                                              // the reveal: jamb, head or sill of the hole in the wall
      vec2 dq = abs(q - L.oc) - L.oh; bool side = L.shape < 0.5 ? dq.x > dq.y : abs(q.x - L.oc.x) > abs(q.y - L.oc.y);
      float sgn = side ? sign(q.x - L.oc.x) : sign(q.y - L.oc.y);
      oN = side ? -T * sgn : -Bv * sgn; oN = normalize(mix(oN, Ng, 0.5));
      oAlb = L.wallKind > 4.5 || L.wallMetal > 0.5 ? L.frameCol * 0.6 : L.wallCol * (side ? 0.92 : (sgn < 0.0 ? 1.04 : 0.8));
      oAo = side ? 0.8 : (sgn < 0.0 ? 0.95 : 0.6); oRough = 0.85;
    } else {
      float edge = -sd2;                                          // metres inside the opening on the glass plane
      vec2 gq = (q - (L.oc - L.oh)) / (2.0 * L.oh);                // 0..1 across the opening
      float fr = L.frameW > 0.0 ? 1.0 - saturate((edge - L.frameW) / pxq + 0.5) : 0.0;
      vec2 pane = 2.0 * L.oh / L.panes; float bars = 0.0;
      if (L.panes.x > 1.5) bars = max(bars, facGrid(q.x - (L.oc.x - L.oh.x), pane.x, 0.5 * L.barW, w.x));
      if (L.panes.y > 1.5) bars = max(bars, facGrid(q.y - (L.oc.y - L.oh.y), pane.y, 0.5 * L.barW, w.y));
      fr = max(fr, bars * step(L.interior, 6.5));
      int ik = int(L.interior + 0.5); bool jalousie = (id == 5 && (type == 1 || type == 5)) || (id == 0 && type == 7);
      // ---- what is behind the frame
      vec3 gAlb = vec3(0.02); vec3 gEmi = vec3(0.0); float gRough = 0.9, gMetal = 0.0, gCoat = 1.0;
      float hLit = facHash(cell, seedB, 71.0), hCol = facHash(cell, seedB, 83.0), hDr = facHash(cell, seedB, 97.0);
      // offices light by zones, not desk by desk, and by floors: where the cleaners or a late shift are working a
      // whole floor is on from end to end, and the rest of the tower shows a zone here and there
      bool band = false;
      if (ik == 1) { hLit = mix(facHash(vec2(floor(cell.x / 4.0), cell.y), seedB, 71.0), hLit, 0.35); band = facHash(vec2(3.0, cell.y), seedB, 113.0) < 0.2; hLit = band ? hLit * 0.3 : min(1.0, hLit * 1.5); }
      if (ik == 4) hLit = 0.0;
      float sw = uSwitch.z; float frac = L.litBase * sw;
      float litAmt = saturate((frac - hLit) * 6.0 + 0.5) * step(0.004, sw);
      litAmt = mix(litAmt, ik == 1 ? (band ? 0.92 * sw : 0.3 * saturate(frac)) : saturate(frac), saturate(px / bay * 2.5 - 0.6));   // far away: the mean, so the skyline does not twinkle (lit office floors stay bands)
      vec3 lightCol = hCol < 0.55 ? vec3(1.0, 0.62, 0.32) : hCol < 0.80 ? vec3(1.0, 0.78, 0.54) : vec3(0.80, 0.90, 1.0);
      if (ik == 1 || ik == 4) lightCol = mix(vec3(0.82, 0.93, 1.0), vec3(1.0, 0.93, 0.80), step(0.6, hCol));
      if (ik == 2) lightCol = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.80, 0.55), step(0.5, hCol));
      float tv = (ik == 0 && hCol > 0.86) ? 1.0 : 0.0;
      if (tv > 0.5) lightCol = vec3(0.45, 0.62, 1.0) * (0.55 + 0.45 * vnoise(vec2(uTime.x * 7.0 + hCol * 50.0, hLit * 9.0)));
      float power = (ik == 2 ? 1.5 : ik == 4 ? 0.6 : ik == 3 ? 1.5 : ik == 1 ? 1.5 : 1.0) * (0.7 + 0.6 * hDr);
`;
// What can sit in an opening, by FacLay.interior. Each piece fills gAlb / gEmi / gRough / gMetal / gCoat (and oN, oWet).
const PANEL = /* glsl */`{   // solid panel: door leaf, roller shutter, louvres
        gAlb = L.panelCol; gCoat = 0.0; gRough = 0.6; int pk = int(L.panelKind + 0.5);
        if (pk == 1) { float sl = fract(q.y / 0.075); float fadeS = saturate(1.0 - w.y / 0.05); gAlb *= 1.0 - 0.35 * fadeS * smoothstep(0.7, 1.0, sl); oN = normalize(Ng + Bv * (sl - 0.5) * 0.7 * fadeS); gMetal = 0.5; gRough = 0.5; }
        else if (pk == 2) { float sl = fract(q.y / 0.06); gAlb *= 1.0 - 0.5 * smoothstep(0.55, 1.0, sl) * saturate(1.0 - w.y / 0.04); }
        else if (pk == 3) { float ph = q.x * (TAU / 0.3); float fadeS = saturate(1.0 - w.x / 0.2); oN = normalize(Ng - T * cos(ph) * 0.5 * fadeS); gAlb *= 1.0 - 0.3 * facGrid(q.x, 5.0, 0.02, w.x); gMetal = 0.3; gRough = 0.5;
          float win = facCov(q.y, L.oc.y + 0.15 * L.oh.y, L.oc.y + 0.45 * L.oh.y, w.y) * (1.0 - facGrid(q.x, 2.5, 0.25, w.x)); gAlb = mix(gAlb, vec3(0.05, 0.07, 0.08), win); gRough = mix(gRough, 0.1, win); }
        else { vec2 pn = abs(fract(gq * vec2(1.0, 2.0)) - 0.5); float inset = step(pn.x, 0.36) * step(pn.y, 0.38); gAlb *= 0.9 + 0.1 * inset; gRough = 0.45;
          float knob = 1.0 - smoothstep(0.03, 0.04 + px, length((q - L.oc) - vec2(L.oh.x - 0.12, -0.05))); gAlb = mix(gAlb, vec3(0.8, 0.7, 0.4), knob); gMetal = knob; }
        gAlb *= 1.0 - 0.3 * grime;
      }`;
const GLASS_BLOCK = /* glsl */`{   // glass block or fibreglass sheet: no view, a soft glow
        vec2 gb = abs(fract(q / 0.2) - 0.5); float joint = 1.0 - smoothstep(0.42, 0.47 + px * 2.0, max(gb.x, gb.y)); float lens = 1.0 - 1.6 * dot(gb, gb);
        if (id == 6) { joint = 1.0; lens = 0.8 + 0.2 * sin(q.x * (TAU / 0.19)); }
        gAlb = mix(vec3(0.55, 0.56, 0.54), vec3(0.42, 0.52, 0.50) * lens, joint); gRough = 0.25; gCoat = 0.6;
        float glow = saturate(sw * L.litBase) * (0.6 + 0.4 * vnoise(vec2(q.x * 0.7 + cell.x * 3.0, (q.y + cell.y * storey) * 0.5 + seedB)));
        gEmi = vec3(1.0, 0.78, 0.5) * glow * joint * lens * 0.4;
      }`;
// A room seen through glass, in four parts so that a group of styles without curtains, window units or louvres
// does not carry their code: view(DRAPES)(UNIT)(LOUVRES).
const VIEW_A = /* glsl */`{   // a room seen through glass
        vec3 r = vec3(-vt.x, -vt.y, vt.z);
        vec3 rAlb; float rLight; bool deep = s.dist < 140.0 && px < 0.35 * min(L.oh.x, L.oh.y) * 2.0;
        if (deep) facRoom(L, q, r, cell, bay, storey, seedB, px, rAlb, rLight);
        else { rAlb = vec3(0.5, 0.47, 0.42); rLight = 0.55; }
        // drapes: curtains drawn part-way from each side, or a venetian blind let down part-way
        float drape = 0.0; vec3 dAlb = vec3(0.0); float dThrough = 0.0, dHot = 1.0;
`;
const DRAPES = /* glsl */`        if (L.drape > 0.5) {
          float xn = (q.x - L.oc.x) / L.oh.x, yn = (q.y - (L.oc.y - L.oh.y)) / (2.0 * L.oh.y);
          vec2 dd = vec2(xn - (hLit * 1.4 - 0.7), (yn - 0.7) * 1.3); dHot = 0.35 + 0.9 * exp(-dot(dd, dd) * 1.4);   // the lamp behind the cloth: a soft bright patch, not an even card
          if (hDr < 0.34) { float cover = 0.18 + 0.62 * fract(hDr * 13.7); if (fract(hDr * 61.0) < 0.2) cover = 1.05; drape = saturate((abs(xn) - (1.0 - cover)) * L.oh.x / px + 0.5);
            float fold = 0.5 + 0.5 * sin(q.x * 42.0 + sin(q.y * 1.3 + hDr * 40.0) * 1.5); fold = mix(0.5, fold, saturate(1.0 - w.x / 0.06));
            vec3 cc = hCol < 0.4 ? vec3(0.86, 0.84, 0.78) : hCol < 0.7 ? vec3(0.80, 0.72, 0.58) : mix(trim, vec3(0.8), 0.45); dAlb = cc * (0.62 + 0.38 * fold); dThrough = 0.55; }
          else if (hDr < 0.56) { float down = 0.2 + 0.7 * fract(hDr * 29.3); if (fract(hDr * 47.0) < 0.3) down = 1.05; drape = saturate((yn - (1.0 - down)) * 2.0 * L.oh.y / px + 0.5);
            float sl = fract(q.y / 0.05); float fadeS = saturate(1.0 - w.y / 0.03); dAlb = vec3(0.82, 0.80, 0.74) * mix(0.75, 0.45 + 0.55 * smoothstep(0.0, 0.7, sl), fadeS); dThrough = 0.35; }
          else if (hDr < 0.64) { drape = 1.0; dAlb = vec3(0.88, 0.87, 0.84) * (0.8 + 0.2 * sin(q.x * 30.0) * saturate(1.0 - w.x / 0.08)); dThrough = 0.8; }   // full sheers
        }
`;
const VIEW_B = /* glsl */`        float day = 1.0 - uSwitch.w;
        // by day the room is a dim cave behind the reflection; lit rooms glow by their own lamp
        vec3 roomDay = rAlb * (0.05 + 0.20 * L.see) * (0.3 + 0.7 * day);
        gAlb = mix(roomDay, dAlb * 0.42, drape);                    // cloth seen through a pane, with a dark room behind it
        vec3 roomEmi = rAlb * lightCol * rLight * power * 1.3;   // a lit room reads clearly against a lamp-lit wall without clipping
        gEmi = mix(roomEmi, dAlb * lightCol * power * dThrough * 1.5 * dHot, drape) * litAmt;
        if (tv > 0.5) gEmi *= 0.6;
        // dark glass keeps most of the light in
        gEmi *= mix(1.0, 0.6, L.glassMetal); gAlb = mix(gAlb * mix(vec3(1.0), L.glassTint, 0.7), L.glassTint, L.glassMetal);   // clear glass only filters what is behind it; a mirror coating has its own colour
        gMetal = L.glassMetal; gRough = mix(0.9, 0.06, step(0.05, L.glassMetal)); gCoat = L.glassMetal > 0.05 ? 0.0 : 1.0;
        if (ik == 4) { gCoat = 0.0; gRough = 0.9; gMetal = 0.0; gAlb = rAlb * 0.10; gEmi = rAlb * lightCol * rLight * 0.5 * saturate(sw * 1.5); }   // open deck: no glass at all
`;
const UNIT = /* glsl */`        // window air conditioner in the lower corner, with its rust streak below (handled by 'grime' above through the sill)
        if ((id == 0 && type == 7) || (id == 5 && type < 2) || (id == 8 && type == 1)) { if (facHash(cell, seedB, 113.0) < 0.3) {
          vec2 ac = abs(q - vec2(L.oc.x - L.oh.x + 0.36, L.oc.y - L.oh.y + 0.24)) - vec2(0.30, 0.20); float inAc = saturate(0.5 - max(ac.x, ac.y) / px);
          float louv = 0.75 + 0.25 * step(0.5, fract(q.y / 0.035)) * saturate(1.0 - w.y / 0.03); gAlb = mix(gAlb, vec3(0.62, 0.62, 0.60) * louv, inAc); gEmi *= 1.0 - inAc; gCoat *= 1.0 - inAc; gRough = mix(gRough, 0.6, inAc); } }
`;
const VIEW_C = /* glsl */`        // no two panes sit in quite the same plane, and old sheet glass is never flat: each pane throws the sky back at its own angle
        vec2 paneId = floor((q - (L.oc - L.oh)) / pane) + cell * 7.0; vec2 tilt = (hash22(paneId + seedB) - 0.5) * (L.glassMetal > 0.5 ? 0.022 : 0.05);
        tilt += (tnoise(q * 9.0 + cell * 31.0) - 0.5) * 0.03 * saturate(1.0 - px / 0.05);
        oN = normalize(Ng - T * tilt.x - Bv * tilt.y);
`;
const LOUVRES = /* glsl */`        if (jalousie) {                                             // glass louvres: every blade leans out at the bottom and shows its dark edge
          float bl = (q.y - (L.oc.y - L.oh.y)) / 0.105, fb = fract(bl), fadeJ = saturate(1.0 - w.y / 0.05), lean = 0.25 + 0.5 * hDr;
          oN = normalize(oN + Bv * lean * fadeJ); gAlb = mix(gAlb, vec3(0.03), smoothstep(0.86, 0.97, fb) * fadeJ * 0.8); gEmi *= 1.0 - 0.6 * smoothstep(0.86, 0.97, fb) * fadeJ;
        }
`;
const VIEW_D = /* glsl */`        // rain on the pane
        if (uWeather.x > 0.01 && s.dist < 30.0 && gCoat > 0.5) { vec2 dv = voronoi(q * vec2(55.0, 30.0) + vec2(0.0, floor(uTime.x * 0.7) * 0.37)); float drop = (1.0 - smoothstep(0.12, 0.3, dv.x)) * step(1.0 - uWeather.x * 0.8, dv.y);
          oN = normalize(oN + (T * (dv.y - 0.5) + Bv * 0.4) * drop * 0.5); }
        oWet = (L.glassMetal > 0.05 || gCoat > 0.5) ? 0.5 : 0.0;
      }`;
const SURFACE_TAIL = /* glsl */`
      float inner = smoothstep(0.0, L.reveal * 1.4 + 0.02, edge);  // the recess shades whatever sits in it
      oAlb = mix(gAlb, L.frameCol, fr); oEmi = gEmi * (1.0 - fr);
      oRough = mix(gRough, L.frameMetal > 0.5 ? 0.35 : 0.5, fr); oMetal = mix(gMetal, L.frameMetal, fr); oCoat = gCoat * (1.0 - fr); oWet *= 1.0 - fr;
      oAo = mix(0.55, 1.0, inner);
    }
    o.albedo = mix(o.albedo, oAlb, open); o.rough = mix(o.rough, oRough, open); o.metal = mix(o.metal, oMetal, open);
    o.ao = mix(o.ao, s.occ * oAo, open); o.N = normalize(mix(o.N, oN, open)); o.emissive = oEmi * open; o.coat = oCoat * open; o.coatRough = 0.03; o.wet = oWet * open;
  }

  // ---- rain: stucco and concrete drink it unevenly, sheet and tile just shine
  float wetW = uWeather.y;
  if (wetW > 0.0) {
    float soak = wetW * (0.35 + 0.65 * smoothstep(0.25, 0.8, streakN)) * (1.0 - open);
    float porous = L.wallKind < 1.5 || (L.wallKind > 2.5 && L.wallKind < 4.5) ? 1.0 : 0.15;
    o.albedo *= mix(1.0, 0.66, soak * porous); o.rough = mix(o.rough, min(o.rough, 0.38), soak * 0.7);
    o.coat = max(o.coat, soak * 0.25 * (1.0 - porous));
  }
}
`;

/**
 * Every style in dispatch order: its id and the GLSL block that lays out its openings, frames and wall finish.
 * cp = cell metres, cell = (bay index, storey index).
 *
 * walls, rooms: every value the block can leave in L.wallKind and L.interior, the FacLay defaults (0 and 0) included
 * when a path through the block keeps them. fittings: what its windows can carry: 'drapes' (L.drape left at 1 on some
 * path), 'unit' (window air conditioners) and 'louvres' (jalousie blades); the last two are chosen by id and type in
 * UNIT and in SURFACE_HEAD. A shader built for a group of styles contains only the finishes, interiors and fittings
 * listed here, so a style that sets a kind it does not list is drawn without it.
 */
export const MATERIALS = Object.freeze([
  { id: FACADE.DECO, walls: [0], rooms: [0, 6], fittings: ['drapes', 'unit', 'louvres'], call: /* glsl */`{
    float sill = ${f(L.deco.sill)}, head = ${f(L.deco.head)};
    L.oc.y = 0.5 * (sill + head); L.oh.y = 0.5 * (head - sill); L.sill = 0.06; L.panes = vec2(2.0, 4.0); L.barW = 0.028;
    if (type == 0 || type == 7) { L.oh.x = 0.5 * clamp(bay - 2.0 * ${f(L.deco.pier)}, 0.9, ${f(L.deco.casementMax)}); if (type == 7) { L.oh.x = min(L.oh.x, 0.6); L.panes = vec2(1.0, 4.0); if (hb < 0.3) L.oh.x = -1.0; } }
    else if (type == 1) { L.oh.x = 0.5 * (bay - 2.0 * 0.26); L.panes = vec2(max(2.0, floor((bay - 0.5) / 0.8 + 0.5)), 4.0); }
    else if (type == 2) { L.oh.x = 0.5 * bay + 0.02; L.frameW = 0.03; L.panes = vec2(max(1.0, floor(bay / 0.9 + 0.5)), 4.0); L.barW = 0.04; }
    else if (type == 3) { L.shape = 1.0; L.oc.y = ${f(L.deco.portholeY)}; L.oh = vec2(${f(L.deco.portholeR)}); L.frameW = 0.06; L.frameCol = trim; L.panes = vec2(2.0); L.sill = 0.0; L.drape = 0.0; }
    else if (type == 4) { L.oh = vec2(0.5 * ${f(L.deco.glassBlockW)}, storey * 0.5 + 0.02); L.oc.y = storey * 0.5; L.interior = 6.0; L.reveal = 0.04; L.frameW = 0.0; L.sill = 0.0; L.drape = 0.0; L.litBase = 1.2; }
    if (flag) {                                                 // racing stripes ride the spandrel between window rows
      float yy = cp.y > storey * 0.5 ? cp.y - storey : cp.y, s = 0.0;
      s = max(s, facLine(yy, ${f(L.deco.stripeY[0])}, ${f(L.deco.stripeH / 2)}, w.y)); s = max(s, facLine(yy, ${f(L.deco.stripeY[1])}, ${f(L.deco.stripeH / 2)}, w.y)); s = max(s, facLine(yy, ${f(L.deco.stripeY[2])}, ${f(L.deco.stripeH / 2)}, w.y));
      L.wallCol = mix(L.wallCol, trim, s);
    }
    if (type == 6) { float ph = cp.x / 0.14; float fl = abs(fract(ph) - 0.5); L.wallCol *= 0.82 + 0.36 * smoothstep(0.0, 0.5, fl) * saturate(1.0 - w.x / 0.1) + 0.18 * saturate(w.x / 0.1); }
  }` },
  { id: FACADE.CONDO, walls: [0], rooms: [0], fittings: ['drapes'], call: /* glsl */`{
    L.oc.y = 0.5 * (${f(L.condo.sill)} + ${f(L.condo.head)}); L.oh.y = 0.5 * (${f(L.condo.head)} - ${f(L.condo.sill)}); L.oh.x = 0.5 * bay - ${f(L.condo.pier)};
    L.panes = vec2(max(2.0, floor(bay / 1.3 + 0.5)), 1.0); L.barW = 0.05; L.frameCol = vec3(0.62, 0.64, 0.66); L.frameMetal = 0.7; L.reveal = 0.16; L.glassTint = vec3(0.045, 0.06, 0.065); L.roomD = 5.5;
    if (type == 2 && mod(cell.x, 2.0) > 0.5) { L.oc.y = 0.5 * (${f(L.condo.windowSill)} + ${f(L.condo.head)}); L.oh.y = 0.5 * (${f(L.condo.head)} - ${f(L.condo.windowSill)}); L.oh.x = min(L.oh.x, 0.9); L.panes = vec2(2.0, 1.0); L.sill = 0.05; }
    if (type == 3) { L.oc.y = 0.5 * (0.75 + 2.35); L.oh.y = 0.8; L.oh.x = 0.5 * bay - 0.22; L.panes = vec2(3.0, 1.0); }
    if (flag) L.wallCol = mix(L.wallCol, trim, max(facCov(cp.y, storey - 0.34, storey + 1.0, w.y), facCov(cp.y, -1.0, 0.02, w.y)));   // painted slab edge
  }` },
  { id: FACADE.CURTAIN, walls: [1, 6], rooms: [1], fittings: [], call: /* glsl */`{
    L.interior = 1.0; L.roomD = 9.0; L.drape = 0.0; L.litBase = 0.34; L.reveal = 0.03; L.sill = 0.0;
    L.glassTint = wallCol; L.glassMetal = 0.85; L.see = 0.22;
    L.oc.y = 0.5 * (${f(L.curtain.sill)} + ${f(L.curtain.head)}); L.oh.y = 0.5 * (${f(L.curtain.head)} - ${f(L.curtain.sill)}); L.oh.x = 0.5 * bay - 0.5 * ${f(L.curtain.mullion)};
    L.frameW = 0.0; L.wallKind = 6.0; L.wallRough = 0.12; L.wallMetal = 0.85; L.wallCol = wallCol * 0.82;                // spandrel glass: same family, opaque
    if (type == 0) { L.oh.x = 0.5 * bay - 0.012; }
    if (type == 1) { L.wallCol = wallCol * 0.7; L.frameW = 0.03; L.frameCol = vec3(0.60, 0.62, 0.64); L.frameMetal = 0.9; }
    if (type == 2) { L.oh.x = 0.5 * bay + 0.02; L.wallKind = 1.0; L.wallCol = trim; L.wallRough = 0.8; L.wallMetal = 0.0; L.glassMetal = 0.6; L.reveal = 0.18; L.oc.y = 0.5 * (1.0 + 2.6); L.oh.y = 0.8; }
    if (type == 3) { L.oh.x = 0.5 * bay - 0.38; L.oh.y = storey * 0.5 + 0.02; L.oc.y = storey * 0.5; L.wallKind = 1.0; L.wallCol = trim; L.wallRough = 0.8; L.wallMetal = 0.0; L.reveal = 0.4; L.glassMetal = 0.6; }
  }` },
  { id: FACADE.PUNCHED, walls: [0, 1, 3], rooms: [0, 1], fittings: ['drapes'], call: /* glsl */`{
    L.wallKind = 1.0; L.interior = 1.0; L.roomD = 7.0; L.drape = 0.0; L.litBase = 0.36; L.reveal = 0.28; L.sill = 0.0;
    L.frameCol = vec3(0.16, 0.16, 0.17); L.frameMetal = 0.6; L.glassTint = vec3(0.035, 0.05, 0.06); L.glassMetal = 0.25; L.see = 0.35;
    L.oc.y = 0.5 * (${f(L.punched.sill)} + ${f(L.punched.head)}); L.oh.y = 0.5 * (${f(L.punched.head)} - ${f(L.punched.sill)}); L.oh.x = min(0.5 * bay - 0.45, 0.5 * bay * 0.62);
    if (type == 1) { L.oh.x = 0.5 * ${f(L.punched.slotW)}; L.oh.y = storey * 0.5 - 0.35; L.oc.y = storey * 0.5 + 0.05; }
    if (type == 2) { L.oh.x = 0.5 * bay - 0.03; L.reveal = 0.16; L.frameCol = vec3(0.55, 0.56, 0.58); }
    if (type == 3) { L.oh = vec2(0.5 * bay - 0.22, storey * 0.5 - 0.24); L.oc.y = storey * 0.5; L.reveal = 0.7; }
    if (type == 4) { L.oh.x = 0.5 * bay + 0.02; L.reveal = 0.1; L.wallKind = 0.0; L.glassTint = vec3(0.03, 0.07, 0.12); L.glassMetal = 0.5; L.interior = 0.0; L.drape = 1.0; L.litBase = 0.6; L.frameCol = vec3(0.7); }
    if (type == 5) { L.wallKind = 3.0; L.wallRough = 0.9; L.sill = 0.08; L.reveal = 0.14; L.frameCol = vec3(0.80, 0.80, 0.76); L.frameMetal = 0.0; L.panes = vec2(2.0, 2.0); L.barW = 0.035; L.interior = 0.0; L.drape = 1.0; L.roomD = 5.0; L.oh.x = min(0.5 * bay - 0.6, 0.75); }
    if (flag) L.wallCol = mix(L.wallCol, trim, facLine(cp.y > storey * 0.5 ? cp.y - storey : cp.y, 0.38, 0.16, w.y));
  }` },
  { id: FACADE.SHOPFRONT, walls: [0, 5], rooms: [2, 3, 7], fittings: [], call: /* glsl */`{   // ground storey; storey = band height
    float riser = ${f(L.shop.riser)}, head = min(${f(L.shop.head)}, storey - 0.5);
    L.interior = 2.0; L.roomD = 7.0; L.drape = 0.0; L.litBase = 0.85; L.reveal = 0.10; L.frameW = 0.045; L.frameCol = vec3(0.60, 0.62, 0.64); L.frameMetal = 0.85; L.see = 0.8; L.glassTint = vec3(0.06, 0.07, 0.075);
    float doorW = ${f(L.shop.doorW)}, pier = ${f(L.shop.pier)}; bool doorLeft = hc < 0.5; float dx = doorLeft ? cp.x - pier : bay - pier - cp.x;   // distance into the door zone
    bool hasDoor = true;
    if (type == 1) { doorW = 1.9; hasDoor = mod(cell.x + floor(seed), 3.0) < 0.5; L.interior = 3.0; L.roomD = 9.0; riser = 0.25; L.litBase = 1.2; }   // a lobby is lit all night
    if (type == 2) { riser = 0.85; head = min(2.5, storey - 0.5); L.interior = 3.0; L.roomD = 8.0; hasDoor = mod(cell.x + floor(seed), 3.0) < 0.5; }
    if (type == 4) { riser = 0.08; head = storey - 0.45; hasDoor = false; L.roomD = 12.0; L.frameW = 0.035; }
    if (type == 5) { riser = 0.08; head = storey - 0.6; L.interior = 3.0; L.glassTint = vec3(0.03, 0.04, 0.045); L.glassMetal = 0.3; L.see = 0.45; doorW = 1.9; hasDoor = mod(cell.x + floor(seed), 4.0) < 0.5; L.roomD = 10.0; L.litBase = 1.2; }
    if (type == 7) { hasDoor = mod(cell.x + floor(seed), 5.0) < 0.5; }
    bool inDoor = hasDoor && dx > 0.0 && dx < doorW + 0.08;
    if (type == 6) {                                            // service front: a roller door or a steel door, no glazing
      bool roller = hb < 0.55; L.interior = 7.0; L.panelKind = roller ? 1.0 : 0.0; L.panelCol = roller ? vec3(0.50, 0.51, 0.50) : trim * 0.7; L.frameW = 0.06; L.frameCol = vec3(0.3);
      L.oh = roller ? vec2(min(1.6, 0.5 * bay - 0.4), 1.5) : vec2(0.46, 1.03); L.oc.y = L.oh.y + 0.02; L.reveal = 0.15;
    } else if (type == 7) {                                     // club front: padded doors and nothing else
      L.interior = 7.0; L.panelCol = trim * 0.5; L.oh = inDoor ? vec2(0.5 * doorW, 1.1) : vec2(-1.0); L.oc = vec2(doorLeft ? pier + 0.5 * doorW : bay - pier - 0.5 * doorW, 1.12); L.panelKind = 0.0;
    } else if (type == 3 && hb < 0.75) {                        // shutter pulled down over the whole front
      L.interior = 7.0; L.panelKind = 1.0; L.panelCol = mix(vec3(0.46, 0.47, 0.46), trim * 0.6, step(0.6, hc)); L.oh = vec2(0.5 * bay - pier, 0.5 * head - 0.02); L.oc.y = 0.5 * head + 0.02; L.reveal = 0.06; L.frameW = 0.05;
    } else if (inDoor) {                                        // glazed door with a transom light
      L.oh = vec2(0.5 * doorW, 0.5 * head - 0.02); L.oc = vec2(doorLeft ? pier + 0.5 * doorW : bay - pier - 0.5 * doorW, 0.5 * head + 0.02);
      L.panes = vec2(doorW > 1.5 ? 2.0 : 1.0, 1.0); L.frameW = 0.07; L.reveal = type == 1 ? 0.3 : 0.55; L.barW = 0.07;
    } else {
      float x0 = pier, x1 = bay - pier; if (hasDoor) { if (doorLeft) x0 += doorW + 0.14; else x1 -= doorW + 0.14; }
      L.oc = vec2(0.5 * (x0 + x1), 0.5 * (riser + head)); L.oh = vec2(0.5 * (x1 - x0), 0.5 * (head - riser)); L.panes = vec2(max(1.0, floor((x1 - x0) / 1.7 + 0.5)), 1.0); L.barW = 0.04;
    }
    if (flag) { L.wallKind = 5.0; L.wallCol = cp.y < min(storey - 0.9, 3.2) ? mix(vec3(0.03, 0.03, 0.032), trim * 0.4, 0.5 * step(0.5, hc)) : wallCol; if (cp.y >= min(storey - 0.9, 3.2)) L.wallKind = 0.0; }
    else if (cp.y < riser && type != 7) { L.wallKind = 5.0; L.wallCol = mix(trim, vec3(0.1), 0.55); }
  }` },
  { id: FACADE.LOWRISE, walls: [0, 1, 4], rooms: [0, 7], fittings: ['drapes', 'unit', 'louvres'], call: /* glsl */`{
    float sill = ${f(L.lowrise.sill)}, head = ${f(L.lowrise.head)};
    L.oc.y = 0.5 * (sill + head); L.oh = vec2(0.5 * min(${f(L.lowrise.windowW)}, bay - 1.3), 0.5 * (head - sill)); L.panes = vec2(1.0, 2.0); L.sill = 0.07; L.reveal = 0.09; L.litBase = 0.5;
    if (type == 1) { L.panes = vec2(1.0, 6.0); L.barW = 0.02; L.frameCol = vec3(0.66, 0.68, 0.70); L.frameMetal = 0.8; L.oh.x = 0.5 * min(1.3, bay - 1.0); }
    if (type == 2) { L.wallKind = 4.0; L.frameW = 0.09; L.frameCol = trim; L.reveal = 0.05; }
    if (type == 5) { L.wallKind = 1.0; L.panes = vec2(1.0, 5.0); L.barW = 0.02; }
    if (type == 3 || type == 4) {                               // a door and a window per bay
      float doorW = ${f(L.lowrise.doorW)}, doorH = ${f(L.lowrise.doorH)}; bool mirror = type == 4 && mod(cell.x, 2.0) > 0.5; float x = mirror ? bay - cp.x : cp.x;
      if (x < 0.5 + doorW + 0.25) { L.oc = vec2(0.5 + 0.5 * doorW, 0.5 * doorH + 0.02); if (mirror) L.oc.x = bay - L.oc.x; L.oh = vec2(0.5 * doorW, 0.5 * doorH); L.interior = 7.0; L.panelCol = trim; L.frameW = 0.06; L.sill = 0.0; L.reveal = 0.1; }
      else { float x0 = 0.5 + doorW + 0.55, x1 = bay - 0.5; L.oc.x = 0.5 * (x0 + x1); if (mirror) L.oc.x = bay - L.oc.x; L.oh.x = 0.5 * (x1 - x0); L.oc.y = 0.5 * (0.8 + 2.05); L.oh.y = 0.5 * (2.05 - 0.8); L.panes = vec2(max(1.0, floor((x1 - x0) / 0.9)), 1.0); L.frameCol = vec3(0.64, 0.66, 0.68); L.frameMetal = 0.8; }
    }
    if (flag) L.wallCol = mix(L.wallCol, trim, facCov(cp.y, -1.0, 0.9, w.y) * step(cell.y, 0.5));       // two-tone wall: painted dado on the ground storey
  }` },
  { id: FACADE.WAREHOUSE, walls: [1, 2, 3], rooms: [5, 6, 7], fittings: [], call: /* glsl */`{   // storey = wall height or a tall tier
    L.wallKind = 2.0; L.wallRough = 0.55; L.wallMetal = 0.0; L.interior = 5.0; L.roomD = 14.0; L.drape = 0.0; L.litBase = 0.25; L.sill = 0.0; L.see = 0.5;
    float plinth = ${f(L.warehouse.plinth)}; L.oh = vec2(-1.0);
    if (type == 0) { L.oc.y = storey - 0.5 * (${f(L.warehouse.stripDrop[0])} + ${f(L.warehouse.stripDrop[1])}); L.oh = vec2(0.5 * bay - 0.6, 0.5 * (${f(L.warehouse.stripDrop[0])} - ${f(L.warehouse.stripDrop[1])})); L.interior = 6.0; L.reveal = 0.02; L.frameW = 0.0; L.litBase = 0.5; if (storey < 4.2) L.oh.x = -1.0; }
    if (type == 1 || type == 4) { float dw = type == 4 ? 0.5 * bay + 0.02 : min(0.5 * ${f(L.warehouse.doorW)}, 0.5 * bay - 0.5), dh = type == 4 ? storey - 1.2 : min(${f(L.warehouse.doorH)}, storey - 0.9);
      bool has = type == 4 || hb < 0.7; if (has) { L.oh = vec2(dw, 0.5 * dh); L.oc.y = 0.5 * dh + 0.02; bool open = type == 1 && facHash(cell, seed, 9.0) < 0.22; L.interior = open ? 5.0 : 7.0; L.panelKind = type == 4 ? 3.0 : 1.0; L.panelCol = type == 4 ? mix(wallCol, vec3(0.6), 0.25) : mix(vec3(0.55, 0.56, 0.55), trim, step(0.5, hc) * 0.7); L.reveal = 0.2; L.frameW = 0.08; L.frameCol = vec3(0.75, 0.62, 0.1); L.see = 1.0; } }
    if (type == 2) { L.wallKind = 3.0; L.wallRough = 0.9; L.oc.y = min(storey - 1.9, 2.6); L.oh = vec2(0.5 * bay - 0.7, 1.05); L.panes = vec2(max(3.0, floor((bay - 1.4) / 0.42)), 5.0); L.barW = 0.022; L.frameCol = vec3(0.12, 0.14, 0.13); L.interior = 5.0; L.reveal = 0.1; L.sill = 0.08; }
    if (type == 3) { L.wallKind = 1.0; L.wallRough = 0.85; L.oc.y = storey - 1.5; L.oh = vec2(0.6, 0.35); L.reveal = 0.1; if (storey < 4.0) L.oc.y = 1.6; }
    if (cp.y < plinth && L.wallKind > 1.5 && L.wallKind < 2.5) { L.wallKind = 1.0; L.wallCol = vec3(0.52, 0.51, 0.48); L.wallRough = 0.85; }
    if (flag) L.wallCol = mix(L.wallCol, trim, facCov(cp.y, storey - 1.25, storey - 0.45, w.y));
  }` },
  { id: FACADE.MANSION, walls: [0], rooms: [0], fittings: ['drapes'], call: /* glsl */`{
    float sill = ${f(L.mansion.sill)}, head = min(${f(L.mansion.head)}, storey - 0.45);
    L.shape = 2.0; L.oc.y = 0.5 * (sill + head); L.oh = vec2(0.5 * min(${f(L.mansion.windowW)}, bay - 1.0), 0.5 * (head - sill)); L.panes = vec2(2.0, 4.0); L.barW = 0.03; L.reveal = 0.2; L.sill = 0.08; L.frameCol = vec3(0.24, 0.16, 0.10); L.litBase = 0.6; L.roomD = 6.0;
    if (type == 1) { L.oh = vec2(min(0.5 * bay - 0.45, 1.1), 0.5 * head); L.oc.y = 0.5 * head + 0.02; L.sill = 0.0; L.panes = vec2(2.0, 5.0); L.reveal = 0.3; }
    if (type == 2) { L.shape = 0.0; }
    if (type == 3) { L.shape = 0.0; L.oh = vec2(0.5 * bay - 0.35, 0.5 * (head - 0.1)); L.oc.y = 0.5 * (head + 0.1); L.panes = vec2(max(1.0, floor(bay / 1.6)), 1.0); L.frameCol = vec3(0.1); L.frameMetal = 0.6; L.glassTint = vec3(0.03, 0.04, 0.045); L.glassMetal = 0.3; L.sill = 0.0; }
    if (flag) L.wallCol = mix(L.wallCol, mix(wallCol, vec3(0.86, 0.82, 0.74), 0.7), facLine(cp.y > storey * 0.5 ? cp.y - storey : cp.y, 0.0, 0.16, w.y));
  }` },
  { id: FACADE.BLANK, walls: [0, 1, 2, 3, 5], rooms: [0], fittings: ['drapes', 'unit'], call: /* glsl */`{
    L.wallKind = type == 2 ? 3.0 : type == 3 ? 1.0 : type == 4 ? 2.0 : type == 5 ? 5.0 : 0.0; if (type == 4) L.wallRough = 0.55;
    if (type == 1 && hb < 0.35 && cell.y > 0.5) { L.oc.y = 1.75; L.oh = vec2(0.32, 0.36); L.panes = vec2(1.0, 4.0); L.barW = 0.02; L.reveal = 0.08; L.sill = 0.05; L.litBase = 0.3; }
    if (type == 7) {                                            // mural: large flat colour fields in the building's own colours
      vec2 m = vec2(cp.x + cell.x * bay, cp.y + cell.y * storey); float band = floor((m.y + 0.35 * m.x * (hc - 0.5)) / 1.3 + seed), sun = length(m - vec2(3.0 + 5.0 * hc, 2.6));
      vec3 c = mod(band, 3.0) < 0.5 ? trim : mod(band, 3.0) < 1.5 ? mix(wallCol, vec3(1.0), 0.5) : mix(trim, vec3(0.02, 0.1, 0.25), 0.6);
      L.wallCol = mix(c, vec3(0.95, 0.75, 0.2), 1.0 - smoothstep(1.4, 1.42 + w.x, sun));
    }
    if (flag) { float yy = cp.y > storey * 0.5 ? cp.y - storey : cp.y, s = max(facLine(yy, ${f(L.deco.stripeY[0])}, ${f(L.deco.stripeH / 2)}, w.y), max(facLine(yy, ${f(L.deco.stripeY[1])}, ${f(L.deco.stripeH / 2)}, w.y), facLine(yy, ${f(L.deco.stripeY[2])}, ${f(L.deco.stripeH / 2)}, w.y))); L.wallCol = mix(L.wallCol, trim, s); }
  }` },
  { id: FACADE.GARAGE, walls: [1], rooms: [4], fittings: [], call: /* glsl */`{
    float up = type == 2 ? 0.18 : ${f(L.garage.upstand)}, beam = ${f(L.garage.beam)}, col = ${f(L.garage.column)};
    L.wallKind = 1.0; L.interior = 4.0; L.roomD = 17.0; L.drape = 0.0; L.litBase = 2.0; L.reveal = 0.35; L.frameW = 0.0; L.sill = 0.0; L.see = 1.0; L.glassTint = vec3(0.0); L.panes = vec2(1.0);
    L.oc = vec2(0.5 * bay, 0.5 * (up + storey - beam)); L.oh = vec2(0.5 * (bay - col), 0.5 * (storey - beam - up));
    if (type == 1) { L.panes = vec2(max(2.0, floor(bay / 0.6)), 1.0); L.barW = 0.16; L.frameCol = wallCol; }
    if (type == 2) { L.panes = vec2(1.0, 5.0); L.barW = 0.012; L.frameCol = vec3(0.6); L.frameMetal = 0.9; L.oh.y = 0.5 * (storey - beam - up); }
    if (flag) L.wallCol = mix(L.wallCol, trim, facLine(cp.y, 0.5 * up + 0.1, 0.16, w.y));
  }` },
]);

/**
 * Which ids are compiled into one shader (see fragmentFor). The Direct3D compiler behind Chrome on Windows needs
 * time that grows with the size of the shader, and the browser kills a GPU process that is busy for too long, so
 * the renderer compiles one shader per group and draws the walls of those styles with it. Wall finishes and
 * interiors are most of that time, so styles share a group only where they share those.
 */
export const GROUPS = Object.freeze([
  [FACADE.DECO], [FACADE.CONDO, FACADE.MANSION], [FACADE.CURTAIN, FACADE.GARAGE], [FACADE.PUNCHED], [FACADE.SHOPFRONT],
  [FACADE.LOWRISE], [FACADE.WAREHOUSE], [FACADE.BLANK],
].map((g) => Object.freeze(g)));

/** Group index for a triangle's style byte (id in the low four bits, see facadeStyle). Unknown ids fall to the last group. */
export function groupOf(m0) {
  const g = GROUPS.findIndex((ids) => ids.includes(m0 & 15));
  return g < 0 ? GROUPS.length - 1 : g;
}

/** The else-if chain that lays out each listed style, in dispatch order. */
export function dispatchChain(ids) {
  const wanted = new Set(ids);
  for (const id of wanted) if (!MATERIALS.some((m) => m.id === id)) throw new Error(`facade: no style with id ${id}`);
  return MATERIALS.filter((m) => wanted.has(m.id)).map((m, i) => `  ${i ? 'else ' : ''}if (id == ${m.id}) ${m.call}\n`).join('');
}

// An if / else-if chain over the listed kinds of one table, in the table's order.
const kindChain = (table, kinds, indent) => table.filter((e) => kinds.has(e.kind))
  .map((e, i) => `${i ? ' else ' : indent}if (kind == ${e.kind}) ${e.code}`).join('');

/** The family's fragment source with only the listed styles, and only what they can draw (all styles by default). */
export function fragmentFor(ids = MATERIALS.map((m) => m.id)) {
  const styles = MATERIALS.filter((m) => ids.includes(m.id));
  const walls = new Set(styles.flatMap((m) => m.walls)), rooms = new Set(styles.flatMap((m) => m.rooms));
  const fittings = new Set(styles.flatMap((m) => m.fittings));
  const furnished = ROOMS.some((e) => rooms.has(e.kind));
  const view = VIEW_A + (fittings.has('drapes') ? DRAPES : '') + VIEW_B + (fittings.has('unit') ? UNIT : '') + VIEW_C
    + (fittings.has('louvres') ? LOUVRES : '') + VIEW_D;
  const opening = [[7, PANEL], [6, GLASS_BLOCK]].filter(([k]) => rooms.has(k)).map(([k, code]) => `if (ik == ${k}) ${code}`);
  if (furnished) opening.push(opening.length ? view : `if (ik < 6) ${view}`);
  return TOOLS + WALL_HEAD + kindChain(WALLS, walls, '  ') + '\n}\n'
    + (furnished ? ROOM_HEAD + kindChain(ROOMS, rooms, '  ') + '\n' + ROOM_TAIL : '')
    + STYLE_HEAD + dispatchChain(ids) + SURFACE_HEAD + '      ' + opening.join(' else ') + SURFACE_TAIL;
}

export default {
  name: 'facade', fragment: fragmentFor(), materials: MATERIALS, groups: GROUPS, groupOf, fragmentFor, alphaTest: false, twoSided: false,
};
export { FACADE };
