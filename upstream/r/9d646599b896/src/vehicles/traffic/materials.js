// Materials shared by the traffic vehicles. Colours are sRGB; parameter bytes follow the VEHICLE and GLASS
// family tables of the architecture document (sections 5.4 and 5.6).

import { vmat, gmat, VEHICLE, GLASS } from './skin.js';

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/**
 * Keep a paint colour (linear rgb) inside what real pigments reflect: whites no brighter than 0.8, strongly
 * coloured paints no brighter than 0.5 in their strongest channel, and no channel at zero. Brighter or purer
 * values than these are what makes a rendered car look like a toy.
 */
export function limitLinear(rgb) {
  const hi = Math.max(rgb[0], rgb[1], rgb[2]), lo = Math.min(rgb[0], rgb[1], rgb[2]);
  const purity = hi > 0 ? Math.min(1, Math.max(0, ((hi - lo) / hi - 0.3) / 0.5)) : 0, cap = 0.8 - 0.3 * purity * purity * (3 - 2 * purity);
  const k = hi > cap ? cap / hi : 1;
  return rgb.map((v) => Math.max(0.006, v * k));
}
/** The same limit for a colour given in sRGB (vertex colours). */
export const limitSrgb = (rgb) => limitLinear(rgb.map(toLinear)).map(toSrgb);

/** Body colour of the instance; flake 0 = solid paint, about 120 = fine period metallic. */
export const paint = (flake = 0) => vmat(VEHICLE.PAINT, flake, 0, 0);
/** A fixed colour that does not follow the instance tint: second tones, stripes, liveries. */
export const fixed = (rgb, matte = false) => vmat(VEHICLE.PAINT_FIXED, 0, matte ? 1 : 0, 0, limitSrgb(rgb));
export const vinyl = (rgb) => vmat(VEHICLE.PAINT_FIXED, 1, 1, 0, limitSrgb(rgb));
export const wood = (rgb) => vmat(VEHICLE.PAINT_FIXED, 2, 0, 0, rgb);
export const trim = (rough = 0.6, rgb = hex(0x26282b)) => vmat(VEHICLE.TRIM_BLACK, Math.round(rough * 255), 0, 0, rgb);
export const interior = (kind, rgb) => vmat(VEHICLE.INTERIOR, kind, 0, 0, rgb);
export const rim = (rgb, rough = 0.3, metal = 1) => vmat(VEHICLE.RIM, Math.round(rough * 255), Math.round(metal * 255), 0, rgb);
/** Lamp lens: the vertex colour is the lens colour; optics 0 smooth, 1 fluted, 2 prism grid, 3 sealed-beam rings. */
export const lens = (id, rgb, optics = 0, p1 = 0) => vmat(id, optics, p1, 0, rgb);
/**
 * Radiator grille. The shader draws its bars at a fine fixed pitch; `coarse` stretches that pitch (3 turns the
 * 9 mm mesh into the 27 mm egg crate of a big saloon) by scaling the panel's texture coordinates.
 */
export const grille = (pattern, coarse = 1, rgb = [0.8, 0.8, 0.82]) => ({ ...vmat(VEHICLE.GRILLE, pattern, 0, 0, rgb), uvScale: 1 / coarse });
export const glass = (tint) => gmat(GLASS.TINTED, tint, [0.75, 0.85, 0.8]);

export const C = {
  chromeRgb: hex(0xc8cdd2), argent: hex(0xb8bcc0), black: hex(0x26282b), rubber: hex(0x1a1a1c), plastic: hex(0x2a2c2f),
  red: hex(0xd21a12), amber: hex(0xff9a1f), white: hex(0xfff4e0), headlamp: hex(0xffe3b8),
  plate: hex(0xf4f1e6), woodPanel: hex(0x6a4526), woodFrame: hex(0xc9a26b),
};

export const chrome = vmat(VEHICLE.CHROME, 0, 0, 0, C.chromeRgb);
/** Bumper bars of worn fleet cars: a dull grey metal instead of bright chrome. */
export const dullMetal = rim(hex(0x8a8d90), 0.55, 0.8);
export const argent = rim(C.argent, 0.4, 0.6);
export const under = vmat(VEHICLE.UNDERBODY, 0, 0, 0, [0.1, 0.1, 0.1]);
export const blackTrim = trim(0.6);
export const rubber = trim(0.85, C.rubber);
/** What a window becomes at the far level of detail: an opaque, glossy, nearly black panel. */
export const farGlass = trim(0.08, [0.05, 0.07, 0.08]);
/** Headlamp reflector bowl: it lights up with the headlamps, so it is used behind headlamp lenses only. */
export const reflector = vmat(VEHICLE.LENS_CLEAR, 0, 0, 0, [0.9, 0.9, 0.9]);
/** A clear ribbed lens that never lights: the patrol car's spot lamp. */
export const unlitLens = vmat(VEHICLE.LENS_CLEAR, 1, 0, 0, [0.9, 0.9, 0.88]);
export const tyre = vmat(VEHICLE.TYRE, 0, 0, 0, C.rubber);
/** Turned iron face of a brake disc; its texture coordinates are (radius in metres, fraction of a turn). */
export const brakeDisc = vmat(VEHICLE.BRAKE_DISC, 0, 0, 0, [0.62, 0.62, 0.63]);
export { VEHICLE, GLASS, hex, vmat };
