// Colour schemes. One scheme per building, derived from its seed and the district style: a wall colour, one or two
// trims (indices into FACADE_TRIMS so painted bands and solid mouldings agree), an age, awning and neon colours.
// The numbers are the sampled pairings of design/brief/architecture.md sections 8, 9, 11 to 17.

import { hashInts } from '../../core/math.js';
import { FACADE_TRIMS, facadeSeed } from '../../render/families/facade.js';

export const TRIM = Object.freeze({ WHITE: 0, SEA_GREEN: 1, TURQUOISE: 2, FLAMINGO: 3, CORAL: 4, PERIWINKLE: 5, PALE_BLUE: 6, SUN: 7, STRAW: 8, ORANGE: 9, LILAC: 10, MINT: 11, SLATE: 12, FOREST: 13, OXBLOOD: 14, NAVY: 15 });

/** Neon gas colours (sRGB), with their share of tube length on the ocean front. */
export const NEON = Object.freeze({
  azure: [0.21, 0.56, 0.95], violet: [0.32, 0.18, 0.95], purple: [0.62, 0.16, 0.92], red: [0.98, 0.13, 0.07], orange: [0.98, 0.42, 0.06],
  pink: [1.0, 0.25, 0.56], aqua: [0.22, 0.90, 0.88], green: [0.31, 0.88, 0.54], warm: [0.97, 0.84, 0.55], white: [0.92, 0.95, 1.0],
});
const NEON_EDGE = [['azure', 30], ['pink', 24], ['violet', 12], ['aqua', 12], ['purple', 8], ['green', 3], ['warm', 5], ['red', 6]];
const COOL_GAS = ['azure', 'violet', 'aqua', 'green'];
/**
 * How much neon a district carries: [share of buildings whose own lines are traced in tubes, share whose name sign is
 * lit at all]. The ocean-front hotel strip is outlined almost house by house; the resort strips have fewer, larger
 * signs; the towers only names; the poor districts paint their signs; works, the airport and the houses have none.
 */
const NEON_DENSITY = {
  artdeco_beach: [0.85, 0.92], hotel_strip: [0.4, 0.88], beach_resort: [0.3, 0.88], downtown: [0, 0.8], studio_island: [0.1, 0.5], latin_quarter: [0.12, 0.4],
  residential_poor: [0.03, 0.12], industrial_port: [0, 0.2], airport: [0, 0.3], military: [0, 0], mansion_island: [0, 0], other: [0.1, 0.4],
};
const NEON_ACCENT = { azure: ['pink', 'red', 'warm'], pink: ['azure', 'aqua', 'violet'], violet: ['pink', 'orange', 'warm'], aqua: ['pink', 'red', 'purple'], purple: ['aqua', 'pink', 'warm'], green: ['pink', 'warm', 'red'], warm: ['azure', 'red', 'pink'], red: ['azure', 'white', 'aqua'] };

// Exterior paint in this sun is chalky: saturation never above 0.4 and no surface brighter than old white paint.
const chalk = (c) => {
  const hi = Math.max(c[0], c[1], c[2]), lo = Math.min(c[0], c[1], c[2]), sat = hi > 0 ? (hi - lo) / hi : 0;
  const keep = sat > 0.4 ? 0.4 / sat : 1, dim = hi > 0.915 ? 0.915 / hi : 1;
  return c.map((v) => (hi - (hi - v) * keep) * dim);
};

const pick = (list, r) => { let tot = 0; for (const e of list) tot += e[e.length - 1]; let x = r * tot; for (const e of list) { x -= e[e.length - 1]; if (x <= 0) return e; } return list[list.length - 1]; };

const DECO_WALLS = [[[0.93, 0.92, 0.90], 34], [[0.92, 0.89, 0.85], 16], [[0.92, 0.85, 0.71], 12], [[0.89, 0.75, 0.61], 9], [[0.92, 0.77, 0.74], 8], [[0.93, 0.88, 0.65], 6], [[0.81, 0.89, 0.82], 5], [[0.78, 0.88, 0.88], 4], [[0.85, 0.82, 0.90], 3], [[0.75, 0.83, 0.90], 3]];
// trims for white walls: never two warm colours together
const WHITE_PAIRS = [[TRIM.FLAMINGO, TRIM.TURQUOISE, 5], [TRIM.SUN, TRIM.PERIWINKLE, 4], [TRIM.SEA_GREEN, TRIM.CORAL, 4], [TRIM.PALE_BLUE, TRIM.STRAW, 4], [TRIM.SEA_GREEN, TRIM.LILAC, 2], [TRIM.PERIWINKLE, TRIM.STRAW, 3],
  [TRIM.ORANGE, TRIM.PALE_BLUE, 2], [TRIM.TURQUOISE, TRIM.FLAMINGO, 4], [TRIM.MINT, TRIM.FLAMINGO, 3], [TRIM.SLATE, TRIM.SEA_GREEN, 2], [TRIM.LILAC, TRIM.MINT, 2], [TRIM.CORAL, TRIM.PALE_BLUE, 2]];
// the deeper tone or the complement of each coloured wall, by wall index 2..9
const DEEP_OF = { 2: [TRIM.STRAW, TRIM.SEA_GREEN], 3: [TRIM.ORANGE, TRIM.TURQUOISE], 4: [TRIM.FLAMINGO, TRIM.SEA_GREEN], 5: [TRIM.SUN, TRIM.PERIWINKLE], 6: [TRIM.SEA_GREEN, TRIM.FLAMINGO], 7: [TRIM.TURQUOISE, TRIM.CORAL], 8: [TRIM.LILAC, TRIM.MINT], 9: [TRIM.PERIWINKLE, TRIM.STRAW] };
const DARK_TRIMS = [TRIM.FOREST, TRIM.NAVY, TRIM.OXBLOOD];
const AWNINGS = [[0.04, 0.58, 0.84], [0.81, 0.41, 0.11], [0.78, 0.20, 0.29], [0.13, 0.42, 0.30], [0.93, 0.80, 0.25], [0.90, 0.88, 0.82], [0.25, 0.30, 0.55]];

const LATIN_WALLS = [[[0.92, 0.87, 0.76], 26], [[0.89, 0.76, 0.29], 6], [[0.78, 0.42, 0.29], 6], [[0.89, 0.60, 0.60], 8], [[0.27, 0.71, 0.69], 6], [[0.32, 0.52, 0.77], 4], [[0.66, 0.84, 0.72], 7], [[0.93, 0.92, 0.88], 32]];   // most shops are cream or white; colour is the exception that makes the street
const POOR_WALLS = [[[0.90, 0.89, 0.84], 28], [[0.84, 0.80, 0.70], 20], [[0.35, 0.67, 0.81], 8], [[0.17, 0.56, 0.37], 5], [[0.89, 0.79, 0.23], 7], [[0.90, 0.62, 0.66], 8], [[0.72, 0.80, 0.86], 10], [[0.78, 0.74, 0.66], 14]];
const RESORT_WALLS = [[[0.94, 0.93, 0.90], 45], [[0.86, 0.79, 0.66], 25], [[0.92, 0.80, 0.74], 10], [[0.91, 0.78, 0.63], 6], [[0.80, 0.89, 0.88], 6], [[0.93, 0.90, 0.78], 8]];
const MANSION_WALLS = [[[0.95, 0.94, 0.92], 35], [[0.93, 0.87, 0.75], 20], [[0.90, 0.79, 0.54], 12], [[0.92, 0.75, 0.71], 15], [[0.94, 0.76, 0.60], 10], [[0.82, 0.82, 0.80], 8]];
const INDUSTRIAL_WALLS = [[[0.66, 0.68, 0.68], 30], [[0.44, 0.55, 0.65], 16], [[0.85, 0.82, 0.72], 20], [[0.62, 0.69, 0.63], 14], [[0.56, 0.29, 0.23], 10], [[0.80, 0.80, 0.78], 10]];
const OFFICE_WALLS = [[[0.81, 0.78, 0.71], 28], [[0.69, 0.71, 0.73], 26], [[0.90, 0.89, 0.86], 22], [[0.80, 0.72, 0.60], 12], [[0.72, 0.66, 0.58], 12]];
/** Mirror and tinted glass skins: the glass tint that goes in the vertex colour of CURTAIN walls. */
export const GLASS_SKINS = [[[0.62, 0.70, 0.78], 16], [[0.17, 0.32, 0.48], 22], [[0.25, 0.49, 0.53], 12], [[0.23, 0.27, 0.31], 14], [[0.54, 0.42, 0.29], 14], [[0.79, 0.64, 0.29], 8], [[0.10, 0.12, 0.14], 14]];
export const ROOF_TILE = [[0.71, 0.33, 0.23], [0.78, 0.45, 0.31], [0.56, 0.27, 0.19]];
export const GRAVEL = [0.55, 0.53, 0.49];

/**
 * Scheme for a building. family: 'deco' | 'resort' | 'latin' | 'poor' | 'mansion' | 'industrial' | 'office'.
 * Returns { wall, trim, trim2 (indices), trimC, trim2C (colours), age 0..3, seedByte (for FACADE bands),
 * awning, awningStripe, neon, neonAccent, lit (its lines are traced in working neon), signLit (its name sign is lit),
 * flicker (a failing transformer), glass }. style: the district style, which sets how much neon there is.
 */
export function scheme(seed, family, style = 'artdeco_beach') {
  const r = (salt) => hashInts(seed, salt, 0xc01a) / 4294967296;
  let wall, trim, trim2, age;
  if (family === 'deco') {
    const mood = r(1);
    if (mood < 0.60) {                                           // the pastel repaint
      const wi = DECO_WALLS.indexOf(pick(DECO_WALLS, r(2))); wall = DECO_WALLS[wi][0];
      if (wi < 2) { const p = pick(WHITE_PAIRS, r(3)); trim = p[0]; trim2 = p[1]; } else { trim = TRIM.WHITE; trim2 = DEEP_OF[wi][r(3) < 0.65 ? 0 : 1]; }
      age = r(4) < 0.55 ? 0 : 1;
    } else if (mood < 0.85) {                                    // still white or cream with one dark trim
      wall = r(2) < 0.6 ? DECO_WALLS[0][0] : r(2) < 0.85 ? DECO_WALLS[1][0] : DECO_WALLS[2][0]; trim = DARK_TRIMS[Math.floor(r(3) * 3)]; trim2 = trim; age = r(4) < 0.5 ? 1 : 2;
    } else { wall = [0.84, 0.80, 0.71]; trim = r(3) < 0.5 ? TRIM.STRAW : TRIM.SLATE; trim2 = TRIM.WHITE; age = 3; }   // tired beige, stained
  } else {
    const table = family === 'latin' ? LATIN_WALLS : family === 'poor' ? POOR_WALLS : family === 'mansion' ? MANSION_WALLS : family === 'industrial' ? INDUSTRIAL_WALLS : family === 'office' ? OFFICE_WALLS : RESORT_WALLS;
    const wi = table.indexOf(pick(table, r(2))); wall = table[wi][0];
    const whiteish = wall[0] > 0.85 && wall[1] > 0.84 && wall[2] > 0.7;
    if (family === 'latin' || family === 'poor') { const set = [TRIM.CORAL, TRIM.TURQUOISE, TRIM.SUN, TRIM.ORANGE, TRIM.FOREST, TRIM.OXBLOOD, TRIM.NAVY, TRIM.SEA_GREEN, TRIM.FLAMINGO]; trim = whiteish ? set[Math.floor(r(3) * set.length)] : TRIM.WHITE; trim2 = set[Math.floor(r(5) * set.length)]; age = family === 'poor' ? 2 + (r(4) < 0.5 ? 1 : 0) : 1 + Math.floor(r(4) * 2.4); }
    else if (family === 'resort') { const set = [TRIM.TURQUOISE, TRIM.CORAL, TRIM.SUN, TRIM.FLAMINGO, TRIM.STRAW, TRIM.PALE_BLUE, TRIM.ORANGE]; trim = set[Math.floor(r(3) * set.length)]; trim2 = whiteish ? set[Math.floor(r(5) * set.length)] : TRIM.WHITE; age = Math.floor(r(4) * 2.6); }
    else if (family === 'mansion') { trim = TRIM.WHITE; trim2 = [TRIM.STRAW, TRIM.FOREST, TRIM.OXBLOOD, TRIM.SLATE][Math.floor(r(3) * 4)]; age = r(4) < 0.8 ? 0 : 1; }
    else if (family === 'industrial') { trim = [TRIM.NAVY, TRIM.OXBLOOD, TRIM.ORANGE, TRIM.FOREST, TRIM.SUN, TRIM.SLATE][Math.floor(r(3) * 6)]; trim2 = TRIM.SUN; age = 1 + Math.floor(r(4) * 2.9); }
    else { trim = [TRIM.SLATE, TRIM.STRAW, TRIM.NAVY, TRIM.OXBLOOD, TRIM.FOREST][Math.floor(r(3) * 5)]; trim2 = TRIM.WHITE; age = Math.floor(r(4) * 2.5); }
  }
  // The gas colour is chosen against the paint: cool tubes on warm walls, warm tubes on cool walls, anything on white.
  const warmth = wall[0] - wall[2], against = warmth > 0.09 ? NEON_EDGE.filter((e) => COOL_GAS.includes(e[0])) : warmth < -0.04 ? NEON_EDGE.filter((e) => !COOL_GAS.includes(e[0])) : NEON_EDGE;
  const edge = pick(against, r(6))[0], accents = NEON_ACCENT[edge], ai = Math.floor(r(8) * AWNINGS.length), density = NEON_DENSITY[style] ?? NEON_DENSITY.other;
  if (family !== 'industrial' && family !== 'office') wall = chalk(wall);
  if (fixed) { wall = fixed.wall ?? wall; trim = fixed.trim ?? trim; trim2 = fixed.trim2 ?? trim2; age = fixed.age ?? age; }
  const out = {
    wall, trim, trim2, trimC: FACADE_TRIMS[trim], trim2C: FACADE_TRIMS[trim2], age,
    seedByte: facadeSeed(trim, age, seed >>> 6), seedByte2: facadeSeed(trim2, age, seed >>> 8),
    awning: r(9) < 0.4 ? FACADE_TRIMS[trim === TRIM.WHITE ? trim2 : trim] : AWNINGS[ai], awningStripe: r(10) < 0.45 ? 1 : 0,
    neon: NEON[edge], neonAccent: NEON[accents[Math.floor(r(7) * accents.length)]], lit: r(11) < density[0], signLit: r(14) < density[1], flicker: r(12) < 0.05,
    glass: pick(GLASS_SKINS, r(13))[0],
  };
  if (fixed) for (const key of ['awning', 'awningStripe', 'neon', 'neonAccent', 'lit', 'signLit', 'flicker', 'glass']) if (fixed[key] !== undefined) out[key] = fixed[key];
  return out;
}

let fixed = null;
/**
 * Run fn with parts of every scheme fixed: a landmark is a stock building in a known livery.
 * paint: { wall, trim, trim2 (indices), age, awning, awningStripe, neon, neonAccent, lit, flicker, glass }.
 */
export function withPaint(paint, fn) { const before = fixed; fixed = paint; try { return fn(); } finally { fixed = before; } }
