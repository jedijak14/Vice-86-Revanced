// VEHICLE surface family: car paint, trim, tyres, wheels, lamps, cabins and number plates for the player's car and
// for traffic. Material ids and the meaning of colour / p0..p2 / uv are in design/ARCHITECTURE.md section 5.4;
// the conventions both vehicle generators rely on are repeated next to each material below.
//
// How this file is organised
//   COMMON    the per-pixel context, weathering (road dirt, rain) and the small bitmap font
//   PAINT     PAINT, PAINT_FIXED, TRIM_BLACK, CHROME, UNDERBODY
//   WHEELS    TYRE, RIM, BRAKE_DISC
//   LAMPS     the lens optics and LAMP_*, LIGHTBAR, LENS_CLEAR
//   FITTINGS  INTERIOR (with the dial faces), PLATE, GRILLE
//   MAIN      surface(): builds the context once, runs exactly one material, then weathers it
//
// Two rules, shared with the other families:
//   1. Screen derivatives are taken once in surface(), before the material branch; inside the materials only
//      explicit-gradient fetches are used.
//   2. Every pattern is filtered with the pixel footprint so that it fades to its average instead of shimmering.
//
// Per-object parameters: objA = (paint r, g, b linear, finish + dirt), objB = (headlamps, brake, reverse, indicator code).
// objA.w carries two things: its whole part is the paint finish (PAINT_FINISH), its fraction the road dirt 0..0.99.

import { VEHICLE } from '../../core/ids.js';

/** Emitted radiance of each lamp at full level, scene units (ARCHITECTURE.md section 4.6). */
export const LAMP_RADIANCE = Object.freeze({ head: 120, fog: 80, tail: 6, brake: 30, reverse: 25, indicator: 20, marker: 4, lightbar: 60 });

/** Indicators are lit for the first half of each period of this many hertz (the game's lamp rig uses the same rule). */
export const BLINK_HZ = 1.5;

/** Paint finishes selectable per vehicle (the whole part of objA.w). */
export const PAINT_FINISH = Object.freeze({ SOLID: 0, METALLIC: 1, PEARL: 2 });

/**
 * objA.w for a vehicle: the paint finish and the road dirt in one number.
 * @param {number} finish  PAINT_FINISH value
 * @param {number} dirt    0 clean .. 1 filthy
 */
export const paintState = (finish, dirt) => Math.round(Math.min(Math.max(finish || 0, 0), 2)) + Math.min(Math.max(dirt || 0, 0), 0.99);

// ---------------------------------------------------------------------------------------------------- font
// A 5 x 6 dot font for number plates and tyre lettering. Each glyph is packed into 30 bits, row 0 at the top,
// bit = row * 5 + column. The shader samples it bilinearly, which rounds the dots into strokes.
const GLYPH_ART = {
  A: '.###. #...# #...# ##### #...# #...#', B: '####. #...# ####. #...# #...# ####.', C: '.#### #.... #.... #.... #.... .####',
  D: '####. #...# #...# #...# #...# ####.', E: '##### #.... ####. #.... #.... #####', F: '##### #.... ####. #.... #.... #....',
  G: '.#### #.... #..## #...# #...# .####', H: '#...# #...# ##### #...# #...# #...#', I: '##### ..#.. ..#.. ..#.. ..#.. #####',
  J: '..### ....# ....# ....# #...# .###.', K: '#...# #..#. ###.. #..#. #...# #...#', L: '#.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #...# #...# #...#', N: '#...# ##..# #.#.# #..## #...# #...#', O: '.###. #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #....', Q: '.###. #...# #...# #.#.# #..#. .##.#', R: '####. #...# #...# ####. #..#. #...#',
  S: '.#### #.... .###. ....# ....# ####.', T: '##### ..#.. ..#.. ..#.. ..#.. ..#..', U: '#...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# .#.#. ..#..', W: '#...# #...# #...# #.#.# ##.## #...#', X: '#...# .#.#. ..#.. ..#.. .#.#. #...#',
  Y: '#...# .#.#. ..#.. ..#.. ..#.. ..#..', Z: '##### ...#. ..#.. .#... #.... #####',
  0: '.###. #..## #.#.# ##..# #...# .###.', 1: '..#.. .##.. ..#.. ..#.. ..#.. .###.', 2: '.###. #...# ...#. ..#.. .#... #####',
  3: '####. ....# .###. ....# ....# ####.', 4: '#..#. #..#. #..#. ##### ...#. ...#.', 5: '##### #.... ####. ....# ....# ####.',
  6: '.###. #.... ####. #...# #...# .###.', 7: '##### ....# ...#. ..#.. ..#.. ..#..', 8: '.###. #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# .###.',
};
const GLYPH_ORDER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';   // letters are glyphs 0..25, digits 26..35
const packGlyph = (art) => art.replace(/ /g, '').split('').reduce((bits, ch, i) => bits + (ch === '#' ? 2 ** i : 0), 0);
const GLYPH_TABLE = GLYPH_ORDER.split('').map((ch) => `${packGlyph(GLYPH_ART[ch])}u`).join(', ');

// Raised lettering on the tyre sidewall, repeated around the tyre: the game's own tyre maker and line, as on the
// modelled sidewalls; -1 is a space.
const TYRE_TEXT = 'VELTRO RADIALE';
const TYRE_GLYPHS = TYRE_TEXT.split('').map((ch) => GLYPH_ORDER.indexOf(ch)).join(', ');

const IDS = Object.entries(VEHICLE).map(([name, id]) => `const int M_${name} = ${id};`).join('\n');

const COMMON = /* glsl */`
${IDS}

struct VCtx {
  SurfFrame f;      // dominant plane of the mesh-local position, metres (p.y is up on the flanks)
  SurfFrame u;      // the vertex uv
  vec2 wuv;         // pixel footprint along each uv axis separately (tyre uv is strongly anisotropic)
  float hand;       // +1 / -1: handedness of the uv on the surface; flips on mirrored instances (right-hand wheels)
  vec2 par;         // view direction in the uv frame, per unit of depth: shift for anything drawn "behind" the surface
  float p0, p1;
  float steep;      // 0 on horizontal faces, 1 on vertical ones
  float sky;        // 0..1 how much rain and dust reaches this pixel
  float soil;       // 0..1 road dirt wanted here before the material's own stickiness
  float finish;     // paint finish of this vehicle: 0 solid, 1 metallic, 2 pearl
  float bend;       // how far the surface normal turns inside one pixel, radians: near 1 a fillet is thinner than the grid
};

vec4 planeNoise(VCtx c, float k) { return noiseTexGrad(c.f.p * k, c.f.dx * k, c.f.dy * k); }
vec4 uvNoise(VCtx c, vec2 k) { return noiseTexGrad(c.u.p * k, c.u.dx * k, c.u.dy * k); }

// ---- font
const uint GLYPH[36] = uint[36](${GLYPH_TABLE});
float glyphDot(uint g, ivec2 c) { return (c.x < 0 || c.x > 4 || c.y < 0 || c.y > 5) ? 0.0 : float((g >> uint(c.y * 5 + c.x)) & 1u); }
// Coverage of glyph g at q, in dot units (x 0..5 left to right, y 0..6 top to bottom); w = pixel size in dots.
float glyph(int g, vec2 q, float w) {
  if (g < 0) return 0.0;
  uint bits = GLYPH[g]; vec2 t = q - 0.5, fl = floor(t), fr = t - fl; ivec2 i = ivec2(fl);
  float a = mix(mix(glyphDot(bits, i), glyphDot(bits, i + ivec2(1, 0)), fr.x), mix(glyphDot(bits, i + ivec2(0, 1)), glyphDot(bits, i + ivec2(1, 1)), fr.x), fr.y);
  return aastep(0.5, a, w);
}

// ---- road dirt
// Grime thrown up by the wheels: densest at the sills and thinning with height, with a dust film everywhere the
// air reaches. 'height' is metres above the road in the vehicle frame; 'stick' scales how well it holds.
const vec3 ROAD_DIRT = vec3(0.19, 0.155, 0.115);
float roadDirt(VCtx c, float height, float stick) {
  if (c.soil <= 0.0) return 0.0;
  vec4 cloud = planeNoise(c, 55.0), speck = planeNoise(c, 1400.0);
  float reach = 0.16 + 0.8 * c.soil;                                           // how high the spray climbs
  float spray = 1.0 - smoothstep(0.06, reach, height + (cloud.r - 0.5) * 0.28);
  float film = 0.3 * c.sky * (0.5 + cloud.g);
  return saturate((spray * (0.55 + 0.9 * speck.r) * 1.5 + film) * c.soil * stick);
}
void applyDirt(inout SurfOut o, float m) {
  o.albedo = mix(o.albedo, ROAD_DIRT, m); o.rough = mix(o.rough, 0.92, m);
  o.metal *= 1.0 - m; o.coat *= 1.0 - m; o.emissive *= 1.0 - 0.6 * m;
}
`;

const PAINT = /* glsl */`
// PAINT        colour from objA.rgb; finish from objA.w (0 solid, 1 metallic, 2 pearl); p0 = least flake amount x 255
//              (a panel can carry flake whatever the finish), p1 = 1 matte.
// PAINT_FIXED  vertex colour; p0 = 0 plain, 1 vinyl grain, 2 wood grain; p1 = 1 matte.
//
// Three layers, as on a real body. From the outside in:
//   clear coat   a smooth dielectric: 4 % reflection head-on rising to a mirror at grazing angles. It carries the tight
//                image of the sun and of lamps, and the sky and the street as calm shapes: baked lacquer has an orange
//                peel that spreads what it mirrors by a degree or two.
//   flake        metallic and pearl finishes only: platelets lying almost flat in the resin. Together they are a broad,
//                paint-coloured metallic lobe (the glow around the highlight, bright on the face of a panel, dark on
//                its flop); singly, within a few metres, the ones that happen to mirror the light flash as sparkles.
//   pigment      the colour itself, seen by diffuse light.
// The renderer keeps the layers honest: what the coat reflects never reaches the layers below.

// One layer of flakes: a platelet in every cell of 'size' metres, each leaning its own way. 'aim' says how a platelet
// must lean (in units of the steepest lean) to mirror the main light into the eye. Returns how strongly this pixel
// flashes, 0..1. Cells smaller than a pixel would shimmer, so the layer fades out before that.
float flakeSparkle(vec2 p, float size, vec2 aim, float px) {
  float seen = 1.0 - smoothstep(0.45, 1.6, px / size);
  if (seen <= 0.0) return 0.0;
  vec2 q = p / size, cell = floor(q); vec3 h = hash32(cell); vec2 k = hash22(cell + 71.0);
  float lean = length(h.xy * 2.0 - 1.0 - aim), radius = 0.2 + 0.22 * h.z, w = px / size;
  float body = 1.0 - smoothstep(radius - w, radius + w, length(q - cell - 0.5 - (k - 0.5) * (0.9 - 2.0 * radius)));
  return (1.0 - smoothstep(0.1, 0.34, lean)) * body * seen;
}

void carPaint(SurfIn s, VCtx c, vec3 pigment, float flake, float pearl, bool matte, inout SurfOut o) {
  float NoV = saturate(dot(s.N, s.V)), graze = 1.0 - NoV;
  float near = 1.0 - smoothstep(0.0006, 0.0025, c.f.px);
  // Pearl: mica platelets colour by interference, so the hue swings towards its neighbour as the panel turns away.
  vec3 turned = mix(pigment.gbr, vec3(luma(pigment)), 0.35) * 1.5 + 0.05;
  vec3 base = mix(pigment, turned, pearl * graze * graze * 0.6);
  // Flakes lie flat under tinted resin: light reaches them and leaves again through the colour, so what they mirror is
  // a brighter, purer version of it. Seen face-on they return light, on the flop there is only pigment between them.
  float lift = min(1.0 + 0.6 * flake, 0.85 / max(max(base.r, base.g), max(base.b, 0.05)));
  // The flop. Where the eye is near the mirror direction of the light (or looks straight at the panel) it sees the
  // faces of the flakes: the colour at its brightest, leaning towards its warmer neighbour as highlights do. Away from
  // it there is only tinted resin between them: the same hue, deeper and darker.
  vec3 H = normalize(s.V + uSunDir.xyz);
  float NoH = saturate(dot(s.N, H)), face = saturate(0.5 * NoV + 0.65 * NoH * NoH * NoH * NoH);
  vec3 warm = base + vec3(0.0, 0.02, 0.0) * max(base.r - base.g, 0.0) + vec3(0.05, 0.0, 0.0) * max(base.g - base.r, 0.0);
  base = mix(base, mix(base * 0.42, warm * max(lift, 1.0), face), flake);
  o.albedo = base;
  // Solid colour is pigment in the same resin as the coat: there is no second interface to shine, and all the gloss
  // is the coat's. A metallic has almost no pigment to scatter light: what is seen is the flake layer, a rough mirror
  // tinted by the resin over it. So its colour is a reflection: bright where a panel faces the light or the sky, deep
  // and dark where it turns away to the ground or the night. Pearl keeps more of the pigment between its platelets.
  o.metal = min(flake * mix(1.12, 0.85, pearl), 0.92); o.rough = mix(0.6, mix(0.38, 0.33, pearl), flake);
  if (flake > 0.0 && near > 0.0) {
    vec2 aim = vec2(dot(H, c.f.T), dot(H, c.f.B)) * (1.0 / 0.32);
    float spark = max(flakeSparkle(c.f.p, 0.0008, aim, c.f.px), 0.7 * flakeSparkle(c.f.p + 0.37, 0.0004, aim * 1.3, c.f.px)) * flake;
    // a flashing platelet mirrors the light through the tinted resin: a speck of the colour at full strength, a
    // little paler, never a white grain
    vec3 flash = mix(warm / max(max(warm.r, warm.g), max(warm.b, 0.02)), vec3(1.0), mix(0.22, 0.7, pearl)) * 0.9;
    o.albedo = mix(o.albedo, flash, spark * 0.8); o.metal *= 1.0 - spark * 0.8;
    // the grain of the layer: the lean of the platelets varies from spot to spot
    vec4 grain = planeNoise(c, 5200.0);
    o.albedo *= 1.0 + flake * near * (grain.b - 0.5) * 0.3;
  }
  if (matte) { o.rough = max(o.rough, 0.62); o.coat = 0.0; return; }
  // The coat. Polished lacquer is close to flat: it spreads the image of its surroundings by well under a degree, so
  // a light box overhead shows as a rectangle with an edge, a neon tube as a line and a road marking as a stripe on
  // the flank, while a panel under open sky still carries a calm gradient because the sky itself is one. The mirror
  // share rises towards grazing; seen from above, a deck stays the colour of its paint with the sky laid over it.
  // That holds for a flake layer, which has a shine of its own under the coat. A solid colour has none: the coat is
  // its whole gloss and is taken in full, which also leaves nothing of the base's own broad sheen (the renderer gives
  // the base what the coat does not claim). That sheen is a grey veil: it is what would turn a gloss black into
  // charcoal in the sun and wash a solid red out, where the lacquer should show the sky on a deep colour instead.
  o.coat = mix(1.0, mix(0.65, 1.0, smoothstep(0.62, 0.95, graze)), smoothstep(0.0, 0.3, flake)); o.coatRough = 0.06;
  vec4 peel = planeNoise(c, 4200.0);                                           // the 4 mm peel itself, seen close to
  o.N = slopeNormal(o.N, c.f, (peel.rg - 0.5) * 0.008 * near);
  // A fillet thinner than a pixel shows every one of its facets at once. One sampled normal cannot stand for them: the
  // mirror share would flick between sky and paint from pixel to pixel. There the paint is shaded as the broad, even
  // lobe that the whole fillet adds up to.
  float fillet = smoothstep(0.1, 0.45, c.bend);
  o.coat = mix(o.coat, 0.3, fillet); o.coatRough = mix(o.coatRough, 0.5, fillet); o.rough = mix(o.rough, 0.6, fillet);
}

void fixedPaint(SurfIn s, VCtx c, inout SurfOut o) {
  int kind = int(c.p0 + 0.5);
  if (kind == 1) {                                                             // vinyl roof: pebbled, satin
    vec4 n = planeNoise(c, 9000.0); float near = 1.0 - smoothstep(0.001, 0.004, c.f.px);
    o.albedo = s.color * (0.85 + 0.3 * n.a * near); o.rough = 0.55; o.coat = 0.1;
    o.N = slopeNormal(o.N, c.f, (n.rg - 0.5) * 0.5 * near);
  } else if (kind == 2) {                                                      // wood panel: long grain under varnish
    vec4 n = noiseTexGrad(c.f.p * vec2(60.0, 1400.0), c.f.dx * vec2(60.0, 1400.0), c.f.dy * vec2(60.0, 1400.0));
    o.albedo = s.color * (0.6 + 0.8 * n.r); o.rough = 0.45; o.coat = 0.7; o.coatRough = 0.08;
  } else carPaint(s, c, s.color, 0.0, 0.0, c.p1 > 0.5, o);
  if (c.p1 > 0.5) { o.coat = 0.0; o.rough = max(o.rough, 0.6); }
}

// TRIM_BLACK   vertex colour; p0 = roughness x 255. Rough trim is moulded plastic or rubber with a fine grain.
// No black on a car is black: satin plastic and rubber return about 5 % of the light, gloss black half of that under its
// sheen. A darker vertex colour is raised to that, so an intake, a louvre or an air box mouth in daylight is a dark
// grey that still shows the sky and the road, deepening with the baked occlusion, and never a hole cut in the picture.
void trim(SurfIn s, VCtx c, inout SurfOut o) {
  float rough = max(c.p0 / 255.0, 0.04), grainy = smoothstep(0.3, 0.6, rough), near = 1.0 - smoothstep(0.0008, 0.003, c.f.px);
  vec4 n = planeNoise(c, 7000.0);
  vec3 black = s.color + max(mix(0.025, 0.05, grainy) - luma(s.color), 0.0);
  o.albedo = black * (1.0 + grainy * near * (n.b - 0.5) * 0.3); o.rough = rough;
  o.coat = (1.0 - grainy) * 0.6; o.coatRough = rough;
  o.N = slopeNormal(o.N, c.f, (n.rg - 0.5) * 0.12 * grainy * near);
}

// CHROME       vertex colour tints the metal (white for bright plating, dark heat colours inside exhaust pipes);
//              p0 = roughness x 255.
void chrome(SurfIn s, VCtx c, inout SurfOut o) {
  o.albedo = s.color; o.metal = 1.0; o.rough = max(c.p0 / 255.0, 0.035);
}

// UNDERBODY    floor pans, wheel housings, suspension: dark, rough, never reflective.
void underbody(SurfIn s, VCtx c, inout SurfOut o) {
  vec4 n = planeNoise(c, 300.0);
  o.albedo = s.color * (0.75 + 0.5 * n.r); o.rough = 0.95;
}
`;

const WHEELS = /* glsl */`
const float TREAD_PITCHES = 68.0;       // tread blocks around the tyre
const float TYRE_REPEATS = 3.0;         // times the lettering is repeated around the sidewall
const int TYRE_CHARS = ${TYRE_TEXT.length};
const int TYRE_TEXT[${TYRE_TEXT.length}] = int[${TYRE_TEXT.length}](${TYRE_GLYPHS});

// TYRE   uv = (angle around 0..1, across: -1..1 over the tread, 1..2 down each sidewall to the bead). Vertex colour =
// the rubber. p0 = 0: tread and sidewall relief are drawn here; p0 = 1: they are modelled and only the rubber is drawn.
// p1 = width of a white sidewall band x 255; p2 = 1: the drawn lettering is filled white, as on the era's muscle tyres.
// Tread: a continuous centre rib, two circumferential grooves each side and raked lateral grooves that open at the
// shoulder, the pattern of the era's low-profile performance tyres. Sidewall: mould rings, raised lettering and a
// rim-protector rib.
void tyre(SurfIn s, VCtx c, inout SurfOut o) {
  float u = s.uv.x, av = abs(s.uv.y), wu = c.wuv.x, wv = c.wuv.y;
  bool relief = c.p0 > 0.5;                     // p0 = 1: grooves, blocks and lettering are modelled; draw only the rubber
  float groove = 0.0, raised = 0.0, worn = 0.0, letters = 0.0;
  if (av < 1.0) {
    if (!relief) {
      float rings = max(aaline(av - 0.2, 0.045, wv), aaline(av - 0.6, 0.05, wv));
      float rake = u * TREAD_PITCHES + av * 1.15 + step(0.6, av) * 0.5;        // shoulder blocks are staggered
      float lateral = pulseTrain(rake, 0.2, wu * TREAD_PITCHES + wv * 1.15) * aastep(0.2, av, wv);
      groove = max(rings, lateral) * (1.0 - smoothstep(0.9, 1.0, av));
    }
    // the band that meets the road is polished by it and dusted grey; the shoulders scuff where the car corners
    worn = (1.0 - smoothstep(0.62, 0.9, av)) * (1.0 - groove);
    o.rough = mix(0.92, 0.8, worn);
  } else {
    float t = av - 1.0;
    if (!relief) {
      raised = max(max(aaline(t - 0.1, 0.012, wv), aaline(t - 0.17, 0.008, wv)), aaline(t - 0.86, 0.035, wv)) * 0.6;
      // lettering: tops towards the tread; reads left to right from outside whichever way the wheel is fitted
      float around = fract(u * TYRE_REPEATS * (c.hand * sign(s.uv.y) > 0.0 ? -1.0 : 1.0));
      float x = around / 0.6 * float(TYRE_CHARS), y = (t - 0.4) / 0.24 * 6.0;
      if (x < float(TYRE_CHARS) && y > -0.5 && y < 6.5) {
        float w = max(wu * TYRE_REPEATS / 0.6 * float(TYRE_CHARS) * 6.0, wv / 0.24 * 6.0);
        letters = glyph(TYRE_TEXT[int(x)], vec2(fract(x) * 6.0 - 0.25, y), w); raised = max(raised, letters);
      }
    }
    // a new sidewall keeps a little of its mould sheen; kerbs grey the bulge nearest the rim protector
    o.rough = mix(0.74, 0.62, raised); o.coat = 0.06; o.coatRough = 0.4;
  }
  vec4 grain = uvNoise(c, vec2(9000.0, 900.0)), patchy = uvNoise(c, vec2(40.0, 3.0));
  vec3 rubber = max(s.color, vec3(0.018)) * (1.0 + 0.9 * raised);
  // p1 = width of a white band on the sidewall x 255 (0 = none), in the sidewall's own 0..1 from tread to bead
  if (c.p1 > 0.5 && av > 1.0) {
    float t = av - 1.0, band = aastep(0.3, t, wv) * aastep(t, 0.3 + c.p1 / 255.0 * 0.6, wv);
    rubber = mix(rubber, vec3(0.62, 0.6, 0.55), band);
  }
  if (s.mat.w > 0.5) rubber = mix(rubber, vec3(0.6, 0.585, 0.54), letters);
  // road dust in the tread and on the shoulders: a warm grey that turns the black rubber into the dark grey of photographs
  float dust = saturate(0.35 * worn + 0.25 * (1.0 - smoothstep(0.9, 1.4, av)) * patchy.r + 0.6 * c.soil);
  o.albedo = mix(rubber, vec3(0.06, 0.056, 0.05), dust * 0.4) * (1.0 - 0.6 * groove) * (0.85 + 0.3 * grain.r);
  o.ao *= 1.0 - 0.65 * groove;
}

// RIM   vertex colour, p0 = roughness x 255, p1 = metalness x 255, p2 = how the metal was finished:
//   0 cast and painted: an even satin silver (or colour) under a thin lacquer;
//   1 diamond turned: uv = (radius in metres, turn 0..1); a lathe groove every few tenths of a millimetre, so the
//     highlight runs round the wheel as a bright arc and a ring of rainbow-free sheen;
//   2 smooth: polished or plated;
//   3 a wheel turning faster than the eye: vertex colour is the average of disc and holes, occlusion how open it is.
// Brake dust (objA.w, and a trace on every car) settles in the recesses and on the inside of the rim.
void rim(SurfIn s, VCtx c, inout SurfOut o) {
  int finish = int(s.mat.w + 0.5);
  float rough = max(c.p0 / 255.0, 0.05);
  o.albedo = s.color; o.metal = c.p1 / 255.0; o.rough = rough;
  if (finish == 0) {
    // Silver wheel paint is aluminium flake in lacquer: the flakes return far more light than the grey the paint
    // looks in the tin, and they lie at every angle, so a wheel stays pale silver in shade instead of going as grey
    // as the road it faces. The lift grows with how metallic the paint is; dark painted wheels (little metal) keep their colour.
    // The flake is far finer than a pixel at any distance a wheel is seen from, so the face is one even satin tone:
    // its shape is told by the spokes' crowns and fillets, never by grain.
    float flakeLift = min(1.0 + 0.35 * saturate(o.metal * 2.0 - 0.6), 0.9 / max(max(s.color.r, s.color.g), max(s.color.b, 0.05)));
    o.albedo *= max(flakeLift, 1.0); o.rough = max(rough, 0.36);
    o.coat = 0.6; o.coatRough = 0.12;                                           // under a thin lacquer
  } else if (finish == 1) {
    // the cut: grooves 0.25 mm apart with a slower beat where the tool's feed wandered
    float k = 1.0 / 0.00025, w = c.wuv.x * k, fine = 1.0 - smoothstep(0.3, 1.0, w);
    float x = fract(s.uv.x * k) - 0.5;
    vec4 beat = noiseTexGrad(vec2(s.uv.x * 900.0, 0.5), vec2(c.u.dx.x * 900.0, 0.0), vec2(c.u.dy.x * 900.0, 0.0));
    o.N = slopeNormal(o.N, c.u, vec2(x * 0.5 * fine, 0.0));
    // grooves smear the reflection across the cut: a broad bright band rather than a mirror
    o.rough = mix(rough, 0.18, 1.0 - fine) * (0.8 + 0.4 * beat.r); o.albedo *= 0.92 + 0.12 * beat.g;
  } else if (finish == 3) {
    o.rough = max(rough, 0.3);
  }
  float recess = saturate(1.25 - s.occ);
  o.albedo *= 1.0 - 0.5 * saturate((0.8 - s.occ) * 2.5);                        // paint lies thick and dull in the recesses
  float dust = saturate((0.12 + c.soil) * recess * 1.4 + 0.35 * c.soil);
  o.albedo = mix(o.albedo, vec3(0.055, 0.045, 0.036), dust); o.rough = mix(o.rough, 0.8, dust);
  o.metal *= 1.0 - dust; o.coat *= 1.0 - dust;
}

// BRAKE_DISC   uv = (radius in metres, angle 0..1). p0 = 0 the swept face: turned iron polished by the pads, with
// fine concentric scoring and a few deeper wear rings; p0 = 1 raw cast iron (hat, edges, vanes): dark, rough, rusty.
void brakeDisc(SurfIn s, VCtx c, inout SurfOut o) {
  vec2 dx = vec2(c.u.dx.x, 0.0), dy = vec2(c.u.dy.x, 0.0);
  vec4 n = noiseTexGrad(vec2(s.uv.x * 30000.0, 3.0), dx * 30000.0, dy * 30000.0);
  vec4 band = noiseTexGrad(vec2(s.uv.x * 900.0, 9.0), dx * 900.0, dy * 900.0);
  vec4 rust = planeNoise(c, 260.0);
  if (c.p0 < 0.5) {
    float rings = smoothstep(0.62, 0.8, band.r);                                // deeper grooves the pads have worn
    o.albedo = s.color * (0.85 + 0.3 * n.r) * (1.0 - 0.35 * rings); o.metal = 1.0;
    o.rough = mix(0.16 + 0.18 * n.g, 0.4, rings);
    float spot = smoothstep(0.62, 0.85, rust.r) * (0.25 + c.soil);              // flash rust where it last stood in the rain
    o.albedo = mix(o.albedo, vec3(0.18, 0.08, 0.035), spot * 0.5); o.rough = mix(o.rough, 0.7, spot * 0.5); o.metal *= 1.0 - spot * 0.5;
  } else {
    float r = smoothstep(0.35, 0.75, rust.g);
    o.albedo = mix(s.color * (0.8 + 0.4 * rust.b), vec3(0.17, 0.075, 0.03), 0.3 + 0.5 * r); o.metal = 0.4; o.rough = 0.85;
  }
}
`;

/**
 * Lamp circuits and lens optics, shared with the GLASS family (lamp lenses in front of modelled reflectors).
 * Needs the frame uniforms (uTime) and the object parameters objB = (headlamps, brake, reverse, indicator code).
 */
export const LAMP_GLSL = /* glsl */`
float lampBlink() { return step(fract(uTime.x * ${BLINK_HZ.toFixed(2)}), 0.5); }
// Indicator code in objB.w: 0 off, 1 left, 2 right, 3 hazard; 4 added while a light bar is running, 8 while the fog
// lamps are switched on.
float indicatorLevel(vec4 objB, bool leftSide) {
  int code = int(mod(objB.w + 0.5, 4.0));
  return (code == 3 || code == (leftSide ? 1 : 2)) ? lampBlink() : 0.0;
}
// Emitted radiance of a lamp circuit: 0 headlamps, 1 tail, 2 brake with a dim tail filament, 3 reverse,
// 4 / 5 left / right indicator, 6 marker, 7 fog (its own switch, and only with the headlamps: a smaller bulb than
// theirs), 8 brake only.
float lampLevel(int circuit, vec4 objB) {
  if (circuit == 0) return objB.x * ${LAMP_RADIANCE.head.toFixed(1)};
  if (circuit == 7) return step(7.5, objB.w) * objB.x * ${LAMP_RADIANCE.fog.toFixed(1)};
  if (circuit == 1) return objB.x * ${LAMP_RADIANCE.tail.toFixed(1)};
  if (circuit == 2) return max(objB.y * ${LAMP_RADIANCE.brake.toFixed(1)}, objB.x * ${LAMP_RADIANCE.tail.toFixed(1)});
  if (circuit == 3) return objB.z * ${LAMP_RADIANCE.reverse.toFixed(1)};
  if (circuit == 4 || circuit == 5) return indicatorLevel(objB, circuit == 4) * ${LAMP_RADIANCE.indicator.toFixed(1)};
  if (circuit == 8) return objB.y * ${LAMP_RADIANCE.brake.toFixed(1)};
  return objB.x * ${LAMP_RADIANCE.marker.toFixed(1)};
}

// What a filament looks like through a lens of this colour: the lens colour at full strength under tungsten light.
// Tungsten has little blue in it, so a red lens glows towards orange, never towards pink.
vec3 lensHue(vec3 colour) {
  vec3 hue = colour / max(max(colour.r, colour.g), max(colour.b, 0.05)) * vec3(1.0, 0.94, 0.7);
  hue.g = max(hue.g, 0.035 * hue.r); return hue;
}
// Light reaching a lens r metres off the axis of a bulb that stands 'behind' metres behind it (1 on the axis).
float bulbFalloff(float r, float behind) { float k = behind * behind / (behind * behind + r * r); return k * sqrt(k); }
// How much of a lamp's light its optics throw into a beam instead of scattering: 0 for signal lamps, whose whole lens
// is meant to glow, 1 for headlamps, which from outside the beam show a hot focus and a lens that is merely lit.
float lampFocus(float level) { return smoothstep(35.0, 100.0, level); }

// Moulded lens optics: 0 smooth, 1 vertical flutes, 2 prism grid, 3 concentric rings about uv (0, 0), 4 vertical
// flutes crossed by the horizontal block lines of a sealed-beam unit. p is in metres, w the pixel footprint.
// Returns the slope of the moulding and, in 'fill', how much of the light behind each element reaches the eye
// (its middle shows the reflector, its flanks the housing). Fades to the average when elements pass under a pixel.
const float FLUTE_PITCH = 0.006, PRISM_PITCH = 0.005, BLOCK_PITCH = 0.021;
vec2 lensOptics(int kind, vec2 p, float w, out float fill) {
  fill = 1.0;
  if (kind == 1 || kind == 4) {
    float x = fract(p.x / FLUTE_PITCH) - 0.5, fade = 1.0 - smoothstep(0.25, 0.9, w / FLUTE_PITCH);
    fill = 1.0 - 1.3 * abs(x) * fade;
    if (kind == 4) fill *= 1.0 - 0.6 * aaline(fract(p.y / BLOCK_PITCH + 0.5) - 0.5, 0.035, w / BLOCK_PITCH) * (1.0 - smoothstep(0.3, 1.0, w / BLOCK_PITCH));
    return vec2(x * 1.7 * fade, 0.0);
  }
  if (kind == 2) {
    vec2 q = fract(p / PRISM_PITCH) - 0.5; float fade = 1.0 - smoothstep(0.25, 0.9, w / PRISM_PITCH);
    fill = 1.0 - 1.1 * max(abs(q.x), abs(q.y)) * fade; return q * 1.5 * fade;
  }
  if (kind == 3) {
    float r = length(p), x = fract(r / PRISM_PITCH) - 0.5, fade = 1.0 - smoothstep(0.25, 0.9, w / PRISM_PITCH);
    fill = 1.0 - 1.2 * abs(x) * fade; return p / max(r, 1e-5) * (x * 1.5 * fade);
  }
  return vec2(0.0);
}
`;

const LAMPS = LAMP_GLSL + /* glsl */`
// LAMP_*   vertex colour = lens colour, uv in metres; the material id names the circuit. p0 says what is modelled:
//   0..4   a moulded lens with its reflector imagined behind it (lensOptics kinds). This is a complete lamp on one
//          surface: by day coloured plastic with depth under a glossy skin, at night each element of the moulding
//          glows, hotter in its middle, the way a real lens breaks the filament up.
//   5      a passive reflex reflector: corner cubes in a hexagonal grid; never emits.
//   6      a bulb standing in a modelled reflector: glass by day, the brightest thing on the car when lit.
//   7      opal sign plastic lit from inside (a roof sign): its own pale colour by day, an even glow at night.
void lampLens(SurfIn s, VCtx c, float level, inout SurfOut o) {
  int kind = int(c.p0 + 0.5);
  float NoV = saturate(dot(s.N, s.V));
  vec3 hue = lensHue(s.color);
  float hot = saturate(level * (1.0 / 40.0));                                   // a brake or head filament burns paler than a tail lamp
  o.coat = 1.0; o.coatRough = 0.04;
  if (kind == 6) {
    o.albedo = s.color * 0.5; o.rough = 0.15;
    // the filament burns on the axis of the envelope; towards its rim the glass only carries the glow
    o.emissive = mix(hue, max(hue, vec3(1.0, 0.8, 0.55)), 0.5 * hot) * level * 3.0 * mix(0.12, 1.0, NoV * NoV * NoV);
    return;
  }
  if (kind == 7) {
    o.albedo = s.color * 0.85; o.rough = 0.4; o.coat = 0.5; o.coatRough = 0.1;
    o.emissive = s.color * level * (0.75 + 0.25 * NoV);
    return;
  }
  if (kind == 5) {
    vec2 q = s.uv / 0.0035, period = vec2(1.0, 1.7320508), h = period * 0.5;
    vec2 a = mod(q, period) - h, b = mod(q - h, period) - h, g = dot(a, a) < dot(b, b) ? a : b;
    float fade = 1.0 - smoothstep(0.3, 1.0, c.u.px / 0.0035);
    // three facets to a cube, each a different brightness; the one facing the eye changes as the car turns
    float facet = fract((atan(g.y, g.x) + dot(c.par, vec2(1.3, 0.7))) * (3.0 / TAU));
    o.albedo = s.color * mix(0.55, 0.25 + 0.75 * facet, fade); o.metal = 0.6; o.rough = 0.22;
    return;
  }
  // A lamp given uv has it in metres from the bulb axis. One without (the plain lens blocks of traffic) is mapped on
  // the plane of the body instead, and its bulb is taken to light the lens evenly.
  bool mapped = c.u.px > 0.0;
  vec2 p = mapped ? s.uv : c.f.p, par = c.par; float w = mapped ? c.u.px : c.f.px;
  if (!mapped) par = vec2(dot(s.V, c.f.T), dot(s.V, c.f.B)) / max(NoV, 0.3);
  float fill, deepFill;
  vec2 slope = lensOptics(kind, p, w, fill);
  // the reflector, a centimetre behind the moulding: coarser facets that slide against it as the eye moves
  lensOptics(kind == 0 ? 3 : kind, (p - par * 0.012) * 0.31, w * 0.31, deepFill);
  float depth = fill * (0.55 + 0.45 * deepFill);
  o.albedo = s.color * mix(0.12, 0.7, depth); o.metal = 0.5; o.rough = 0.22;
  if (mapped) o.N = slopeNormal(o.N, c.u, slope * 0.25); else o.N = slopeNormal(o.N, c.f, slope * 0.25);
  // Lit: the bulb is a hot core seen through the lens around its axis, paler than the lens where it burns brightest;
  // away from it only the light the reflector spreads is left, in the full colour of the lens.
  float bulb = mapped ? bulbFalloff(length(p - par * 0.03), 0.035) : 0.3;
  vec3 glow = mix(hue, max(hue, vec3(1.0, 0.62, 0.4)), hot * bulb * fill * 0.8);
  o.emissive = glow * level * (0.05 + 0.6 * bulb) * mix(0.35, 1.0, fill * fill) * (0.6 + 0.4 * deepFill) * (0.6 + 0.4 * NoV);
}

// LIGHTBAR   emergency beacons: vertex colour, p0 = phase group. Alternate groups flash in bursts of three.
float lightbarLevel(SurfIn s, VCtx c) {
  if (mod(s.objB.w, 8.0) < 3.5) return 0.0;
  float t = fract(uTime.x * 1.6 + 0.5 * mod(c.p0, 2.0));
  return t < 0.5 ? step(fract(t * 12.0), 0.55) : 0.0;
}
void lightbar(SurfIn s, VCtx c, inout SurfOut o) {
  float level = lightbarLevel(s, c) * ${LAMP_RADIANCE.lightbar.toFixed(1)};
  c.p0 = 2.0;                                                                   // a prism dome, whatever the phase group
  lampLens(s, c, level, o);
}

// LENS_CLEAR p0 = 0   a plated reflector bowl; uv in metres from the lamp axis, p1 = the circuit that lights it
//                     (lampLevel; 0 = headlamps), vertex colour = the plating, tinted where it sits behind a coloured
//                     lens. Stepped facets catch the sky by day; lit, the bowl fills with light from the bulb outwards.
//            p0 = 1   a ribbed clear lens over bright metal (unlit).
void clearLens(SurfIn s, VCtx c, inout SurfOut o) {
  if (c.p0 < 0.5) {
    int circuit = int(c.p1 + 0.5);
    float r = length(s.uv), fill; vec2 slope = lensOptics(3, s.uv, c.u.px, fill);
    float spokes = cos(atan(s.uv.y, s.uv.x) * 24.0) * (1.0 - smoothstep(0.002, 0.008, c.u.px));
    o.albedo = s.color * (0.82 + 0.1 * spokes); o.metal = 1.0; o.rough = 0.07;
    o.N = slopeNormal(o.N, c.u, slope * 0.35);
    vec3 hue = lensHue(s.color);
    vec3 light = circuit == 0 || circuit == 7 ? vec3(1.0, 0.9, 0.72) : hue * hue * hue;
    float level = lampLevel(circuit, s.objB), focus = lampFocus(level);
    o.emissive = light * level * (mix(0.3, 0.012, focus) + 1.6 * exp(-r / mix(0.022, 0.012, focus))) * (0.75 + 0.25 * fill);
  } else {
    float fill; vec2 slope = lensOptics(1, s.uv, c.u.px, fill);
    o.albedo = s.color * mix(0.4, 0.8, fill); o.metal = 0.7; o.rough = 0.16; o.coat = 1.0; o.coatRough = 0.03;
    o.N = slopeNormal(o.N, c.u, slope * 0.6);
  }
}
`;

const FITTINGS = /* glsl */`
// INTERIOR p0 = 3: an instrument. uv 0..1 across the dial, p1 = which dial (0 speedometer, 1 rev counter, others
// small gauges). Cream markings on black, an orange needle; the markings glow when the lights are on or at night.
void dialFace(SurfIn s, VCtx c, inout SurfOut o) {
  vec2 q = (s.uv - 0.5) * 2.0; float r = length(q), w = c.u.px * 2.0, which = c.p1;
  bool big = which < 1.5;
  float sweep = 0.75 * PI, th = atan(q.x, q.y);                                 // 0 at the top, +-135 degrees of scale
  float n = big ? 9.0 : 4.0, t = (th / (2.0 * sweep) + 0.5) * n, onScale = step(abs(th), sweep + 0.02);
  float arc = (2.0 * sweep / n) * r;                                            // length of one division at this radius
  float major = aaline((fract(t + 0.5) - 0.5) * arc, 0.022, w) * aastep(0.7, r, w) * aastep(r, 0.93, w);
  float minor = aaline((fract(t * 5.0 + 0.5) - 0.5) * arc * 0.2, 0.01, w) * aastep(0.83, r, w) * aastep(r, 0.93, w) * (big ? 1.0 : 0.0);
  float marks = max(major, minor) * onScale;
  float redline = which > 0.5 && which < 1.5 ? step(n - 1.6, t) * aastep(0.86, r, w) * aastep(r, 0.93, w) * onScale : 0.0;
  // needles rest where a parked car would leave them: speed at zero, revs at idle, small gauges mid-scale
  float rest = which < 0.5 ? 0.0 : (which < 1.5 ? 0.11 : 0.3 + 0.4 * hash11(which + 3.0));
  float na = (rest - 0.5) * 2.0 * sweep; vec2 d = vec2(sin(na), cos(na));
  float along = dot(q, d), across = q.x * d.y - q.y * d.x;
  float needle = aaline(across, 0.028, w) * aastep(-0.18, along, w) * aastep(along, 0.82, w);
  float hub = aastep(r, 0.13, w);
  vec3 cream = s.color, orange = vec3(0.9, 0.2, 0.03), red = vec3(0.8, 0.04, 0.02);
  vec3 ink = mix(mix(vec3(0.012), cream, marks), red, redline);
  ink = mix(mix(ink, orange, needle), vec3(0.02), hub);
  float lit = max(s.objB.x, uSwitch.w);
  o.albedo = ink; o.rough = 0.45; o.coat = 0.8; o.coatRough = 0.1;             // the dial glass
  o.emissive = (cream * marks * (1.0 - redline) * 0.45 + red * redline * 0.5 + orange * needle * (1.0 - hub) * 0.7) * lit;
}

// INTERIOR   vertex colour; p0 = 0 leather, 1 carpet, 2 moulded plastic, 3 dial face, 4 display segment.
void interior(SurfIn s, VCtx c, inout SurfOut o) {
  int kind = int(c.p0 + 0.5); float near = 1.0 - smoothstep(0.0008, 0.003, c.f.px);
  if (kind == 3) { dialFace(s, c, o); return; }
  if (kind == 4) {
    // One lit bar or digit stroke of a digital instrument panel, modelled as its own small quad in the colour it
    // glows in. It is its own light, on whenever the car is, so it reads in a sunlit cabin; with the lights on it is
    // dimmed, as such panels were, or the night's exposure would turn it into a flare. Behind the same glass as a dial.
    o.albedo = s.color * 0.05; o.rough = 0.3; o.coat = 0.8; o.coatRough = 0.1;
    o.emissive = s.color * mix(1.5, 0.8, max(s.objB.x, uSwitch.w));
    return;
  }
  vec4 fine = planeNoise(c, 9000.0), broad = planeNoise(c, 260.0);
  if (kind == 0) {                                                              // hide: pebble grain, polished where it is sat on
    o.albedo = s.color * (0.9 + 0.2 * broad.r); o.rough = 0.42 + 0.2 * broad.g; o.coat = 0.25; o.coatRough = 0.3;
    o.N = slopeNormal(o.N, c.f, (fine.rg - 0.5) * 0.3 * near);
  } else if (kind == 1) {                                                       // carpet: fibres swallow the light
    o.albedo = s.color * (0.6 + 0.8 * mix(0.5, fine.b, near)); o.rough = 1.0;
  } else {
    o.albedo = s.color * (1.0 + (fine.b - 0.5) * 0.25 * near); o.rough = 0.58;
    o.N = slopeNormal(o.N, c.f, (fine.rg - 0.5) * 0.1 * near);
  }
}

// PLATE   p0 = 0: uv addresses the plate artwork in the atlas.
//         p0 = 1: drawn here. uv 0..1 across the plate, vertex colour = background, p1 = registration seed:
//                 three letters and three digits pressed into the sheet, a border bead and two fixing screws.
void plate(SurfIn s, VCtx c, inout SurfOut o) {
  o.rough = 0.38; o.coat = 0.35; o.coatRough = 0.12;
  if (c.p0 < 0.5) { o.albedo = textureGrad(uAtlasTex, s.uv, c.u.dx, c.u.dy).rgb; return; }
  // metres per unit of u and v differ; the ratio of the two gradients gives the plate's aspect
  float aspect = length(c.u.B) / max(length(c.u.T), 1e-4);
  vec3 ground = s.color, ink = luma(ground) > 0.25 ? vec3(0.02, 0.035, 0.07) : vec3(0.85, 0.83, 0.75);
  float cellU = min(0.86 / 7.0, 0.36 / aspect), cellV = cellU * aspect * 1.75;   // one character cell, in uv
  vec2 org = vec2(0.5 - 3.5 * cellU, 0.5 + 0.5 * cellV - 0.03);
  float x = (s.uv.x - org.x) / cellU, y = (org.y - s.uv.y) / cellV * 6.0;
  float text = 0.0;
  if (x > 0.0 && x < 7.0 && y > -0.5 && y < 6.5) {
    int slot = int(x), n = slot > 3 ? slot - 1 : slot;
    if (slot != 3) {
      float h = hash11(c.p1 * 7.0 + float(n) * 3.0 + 11.0);
      int g = n < 3 ? int(h * 25.99) : 26 + int(h * 9.99);
      text = glyph(g, vec2(fract(x) * 6.2 - 0.6, y), max(c.wuv.x / cellU * 6.2, c.wuv.y / cellV * 6.0));
    }
  }
  vec2 e = min(s.uv, 1.0 - s.uv) * vec2(aspect, 1.0);                           // distance to the edge in plate heights
  float bead = aaline(min(e.x, e.y) - 0.07, 0.016, c.wuv.y);
  vec2 sc = vec2(abs(s.uv.x - 0.5) - 0.36, s.uv.y - 0.9) * vec2(aspect, 1.0);
  float screw = aastep(length(sc), 0.03, c.wuv.y);
  o.albedo = mix(mix(ground, ink, max(text, bead)), vec3(0.45), screw);
  o.metal = screw;
}

// GRILLE   uv in metres; p0 = 0 horizontal bars, 1 square mesh, 2 hexagonal mesh, 3 vertical bars. A flat panel
// that reads as an opening: the bars are drawn twice, shifted with the view, so each has a visible depth, and the
// holes show a dark void.
float grillePattern(int kind, vec2 p, float w) {
  if (kind == 0) return pulseTrain(p.y / 0.014, 0.4, w / 0.014);
  if (kind == 3) return pulseTrain(p.x / 0.014, 0.4, w / 0.014);
  if (kind == 1) { vec2 q = p / 0.009, ww = vec2(w / 0.009); return max(pulseTrain(q.x, 0.24, ww.x), pulseTrain(q.y, 0.24, ww.y)); }
  vec2 q = p / 0.011, period = vec2(1.0, 1.7320508), h = period * 0.5;
  vec2 a = mod(q, period) - h, b = mod(q - h, period) - h, g = dot(a, a) < dot(b, b) ? a : b;
  float d = max(abs(g.x), abs(g.x) * 0.5 + abs(g.y) * 0.8660254);              // 0 in a cell centre, 0.5 on its wall
  float ww = w / 0.011;
  return mix(aastep(0.38, d, ww), 0.42, smoothstep(0.3, 1.2, ww));              // far away: the wall fraction
}
void grille(SurfIn s, VCtx c, inout SurfOut o) {
  int kind = int(c.p0 + 0.5);
  float front = grillePattern(kind, s.uv, c.u.px), back = grillePattern(kind, s.uv - c.par * 0.004, c.u.px);
  float wall = saturate(back - front);
  o.albedo = mix(vec3(0.004), s.color, front) + s.color * 0.3 * wall;
  o.rough = mix(1.0, 0.45, front); o.metal = 0.0;
  o.ao *= mix(0.12, 1.0, max(front, 0.5 * wall));
}
`;

const MAIN_HEAD = /* glsl */`
void surface(in SurfIn s, inout SurfOut o) {
  VCtx c;
  c.f = planeFrame(s); c.u = uvFrame(s, s.uv);
  c.wuv = max(abs(c.u.dx), abs(c.u.dy));
  c.hand = dot(cross(c.u.T, c.u.B), s.N) < 0.0 ? -1.0 : 1.0;
  c.par = vec2(dot(s.V, c.u.T), dot(s.V, c.u.B)) / max(dot(s.V, s.N), 0.3);
  c.p0 = s.mat.y; c.p1 = s.mat.z;
  c.steep = 1.0 - abs(s.N.y);
  c.sky = saturate(s.occ * 1.6 - 0.4) * smoothstep(-0.4, 0.05, s.N.y);
  c.soil = fract(s.objA.w); c.finish = floor(s.objA.w + 1e-4);
  c.bend = abs(surfaceCurvature(s)) * 2.0 * c.f.px;

  int id = int(s.mat.x + 0.5);
  // How the weather treats the material: 'stick' scales road dirt, 'smooth' surfaces bead water, others soak it.
  float stick = 1.0, porosity = 0.0; bool beading = false;
  int lamp = -1;        // which lamp this lens belongs to (the code lampLevel() takes), -1 on everything else

`;
const MAIN_TAIL = /* glsl */`  // ---- under the waistline a body sees more road than sky: the ambient light thins towards the sills
  bool wheel = id == M_TYRE || id == M_RIM || id == M_BRAKE_DISC;
  if (!wheel) o.ao *= mix(0.7, 1.0, smoothstep(0.08, 0.62, s.lpos.y));

  // ---- weathering, the same for every material so that a dirty wet car is dirty and wet all over
  float amount = uWeather.y * c.sky;
  // on waxed paint and glass rain stands in beads a few millimetres across, far smaller than on a wall: the shared
  // bead pattern is drawn at a finer scale, and thinner, so the car is wet rather than blistered
  vec4 beads = beading ? waterBeads(c.f.p * 1.7, c.steep, c.f.px * 1.7, amount * 0.75) : vec4(0.0);
  // wheels turn through the spray, so they are dirty all round: their local height says nothing
  float dirt = roadDirt(c, wheel ? 0.0 : s.lpos.y, stick) * (1.0 - 0.75 * beads.w);   // running drops wash a track clean
  if (dirt > 0.0) applyDirt(o, dirt);
  if (beading) applyWaterBeads(o, c.f, beads);
  else applyWetness(o, s.N, porosity, c.sky);
}
`;

// Every lamp is the same lens at a different level, so a lamp's branch only names its lamp and the lens is shaded
// once after the chain: a copy of the lens per lamp id is what made this family slow to compile on Direct3D.
const LAMP = (code) => ({ call: `lamp = ${code};`, lens: true });
const LENS = '  if (lamp >= 0) { lampLens(s, c, lampLevel(lamp, s.objB), o); beading = true; stick = 0.7; }\n';
/**
 * Every material in dispatch order: its id and the GLSL block that shades it and says how the weather treats it
 * ('stick' scales road dirt, 'beading' surfaces bead water, the others soak it by 'porosity').
 */
export const MATERIALS = Object.freeze([
  // metallic and pearl finishes carry flake everywhere; a vertex can ask for more (heavy silver) but not less
  { id: VEHICLE.PAINT, call: `{
    float flake = max(c.p0 / 255.0, c.finish > 1.5 ? 0.6 : (c.finish > 0.5 ? 0.8 : 0.0));
    carPaint(s, c, s.objA.rgb, flake, c.finish > 1.5 ? 1.0 : 0.0, c.p1 > 0.5, o); beading = true;
  }` },
  { id: VEHICLE.PAINT_FIXED, call: '{ fixedPaint(s, c, o); beading = true; }' },
  { id: VEHICLE.TRIM_BLACK, call: '{ trim(s, c, o); beading = c.p0 < 110.0; porosity = 0.15; }' },
  { id: VEHICLE.CHROME, call: '{ chrome(s, c, o); beading = true; stick = 0.8; }' },
  { id: VEHICLE.TYRE, call: '{ tyre(s, c, o); porosity = 0.3; stick = 0.6; }' },
  { id: VEHICLE.RIM, call: '{ rim(s, c, o); beading = true; stick = 0.5; }' },
  { id: VEHICLE.LAMP_HEAD, ...LAMP('0') },
  { id: VEHICLE.LAMP_TAIL, ...LAMP('1') },
  // p1 = 1: one lens does both jobs, glowing dimly with the headlamps and brightly under braking
  { id: VEHICLE.LAMP_BRAKE, ...LAMP('c.p1 > 0.5 ? 2 : 8') },
  { id: VEHICLE.LAMP_REVERSE, ...LAMP('3') },
  { id: VEHICLE.LAMP_INDICATOR_L, ...LAMP('4') },
  { id: VEHICLE.LAMP_INDICATOR_R, ...LAMP('5') },
  { id: VEHICLE.LAMP_MARKER, ...LAMP('6') },
  { id: VEHICLE.LIGHTBAR, call: '{ lightbar(s, c, o); beading = true; stick = 0.3; }' },
  { id: VEHICLE.LENS_CLEAR, call: '{ clearLens(s, c, o); stick = 0.0; }' },
  { id: VEHICLE.INTERIOR, call: '{ interior(s, c, o); stick = 0.0; c.sky = 0.0; }' },
  { id: VEHICLE.UNDERBODY, call: '{ underbody(s, c, o); porosity = 0.5; }' },
  { id: VEHICLE.PLATE, call: '{ plate(s, c, o); beading = true; }' },
  { id: VEHICLE.BRAKE_DISC, call: '{ brakeDisc(s, c, o); stick = 0.0; }' },
  { id: VEHICLE.GRILLE, call: '{ grille(s, c, o); stick = 0.5; porosity = 0.2; }' },
]);

/**
 * Which ids are compiled into one shader (see fragmentFor). The Direct3D compiler behind Chrome on Windows needs
 * time that grows with every material in the chain, and the browser kills a GPU process that is busy for too
 * long, so the renderer compiles one shader per group and draws the triangles of those ids with it. All the
 * lamps are one lens function with a different level, so they cost one material together. Every id appears once.
 */
export const GROUPS = Object.freeze([
  [VEHICLE.PAINT], [VEHICLE.PAINT_FIXED, VEHICLE.UNDERBODY], [VEHICLE.TRIM_BLACK, VEHICLE.GRILLE], [VEHICLE.CHROME, VEHICLE.PLATE],
  [VEHICLE.TYRE], [VEHICLE.RIM, VEHICLE.BRAKE_DISC],
  [VEHICLE.LAMP_HEAD, VEHICLE.LAMP_TAIL, VEHICLE.LAMP_BRAKE, VEHICLE.LAMP_REVERSE, VEHICLE.LAMP_INDICATOR_L, VEHICLE.LAMP_INDICATOR_R,
    VEHICLE.LAMP_MARKER, VEHICLE.LENS_CLEAR],
  [VEHICLE.LIGHTBAR], [VEHICLE.INTERIOR],
].map((g) => Object.freeze(g)));

// the chain names each id by its GLSL constant, so the shader text reads like the id table
const NAME_OF = new Map(Object.entries(VEHICLE).map(([name, id]) => [id, name]));

/** The else-if chain that runs the material of each listed id, in dispatch order, and the lamp lens if any of them is a lamp. */
export function dispatchChain(ids) {
  const wanted = new Set(ids);
  for (const id of wanted) if (!MATERIALS.some((m) => m.id === id)) throw new Error(`vehicle: no material with id ${id}`);
  const used = MATERIALS.filter((m) => wanted.has(m.id));
  return used.map((m, i) => `  ${i ? 'else ' : ''}if (id == M_${NAME_OF.get(m.id)}) ${m.call}\n`).join('') + (used.some((m) => m.lens) ? LENS : '') + '\n';
}

/** The family's fragment source with only the listed ids dispatched (all of them by default). */
export function fragmentFor(ids = MATERIALS.map((m) => m.id)) {
  return COMMON + PAINT + WHEELS + LAMPS + FITTINGS + MAIN_HEAD + dispatchChain(ids) + MAIN_TAIL;
}


export default {
  name: 'vehicle',
  fragment: fragmentFor(),
  materials: MATERIALS,
  groups: GROUPS,
  fragmentFor,
};
