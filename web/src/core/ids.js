// Shared enumerations. This file is the single source of truth for the numbers that geometry
// generators write into vertices and that the surface shaders branch on.
// Meaning of every material's colour / params / uv is documented in design/ARCHITECTURE.md (section "Materials").
// Add new ids only at the end of a list, and update the document in the same change.

/** Shader family: which surface program shades a group of triangles. */
export const FAMILY = Object.freeze({
  SOLID: 0,     // generic procedural surfaces: props, roofs, bridges, signs, poles, trunks
  GROUND: 1,    // roads, pavements, kerbs, sand, grass, lot paving, markings
  FACADE: 2,    // building walls with procedural windows
  VEHICLE: 3,   // car paint, trims, tyres, lamps, interiors
  FOLIAGE: 4,   // alpha-tested, two-sided, wind-animated leaves
  GLASS: 5,     // forward-blended transparent glass (vehicle windows)
  COUNT: 6,
});
export const FAMILY_NAMES = ['solid', 'ground', 'facade', 'vehicle', 'foliage', 'glass'];

/** SOLID family material ids. */
export const SOLID = Object.freeze({
  PAINT: 0, CONCRETE: 1, STUCCO: 2, METAL_PAINTED: 3, METAL_BARE: 4, DARK_GLASS: 5, EMISSIVE: 6, WOOD: 7,
  RUBBER: 8, SIGN: 9, TRUNK: 10, ROCK: 11, FABRIC: 12, ROOF: 13, POOL_WATER: 14, TILE: 15, NEON: 16, LAMP_LENS: 17,
  PLASTIC: 18, SKIN_CLOTH: 19, EPOXY: 20, BLOCK: 21, GLASS_BLOCK: 22, PEGBOARD: 23,
});

/** GROUND family material ids. */
export const GROUND = Object.freeze({
  ASPHALT: 0, SIDEWALK: 1, KERB: 2, SAND: 3, GRASS: 4, LOT: 5, DIRT: 6, MARKING: 7, DECK: 8, PAVERS: 9, TARMAC: 10, MEDIAN: 11,
});

/** FACADE family style ids. */
export const FACADE = Object.freeze({
  DECO: 0, CONDO: 1, CURTAIN: 2, PUNCHED: 3, SHOPFRONT: 4, LOWRISE: 5, WAREHOUSE: 6, MANSION: 7, BLANK: 8, GARAGE: 9,
});

/** VEHICLE family material ids. */
export const VEHICLE = Object.freeze({
  PAINT: 0, PAINT_FIXED: 1, TRIM_BLACK: 2, CHROME: 3, TYRE: 4, RIM: 5, LAMP_HEAD: 6, LAMP_TAIL: 7, LAMP_BRAKE: 8,
  LAMP_REVERSE: 9, LAMP_INDICATOR_L: 10, LAMP_INDICATOR_R: 11, INTERIOR: 12, UNDERBODY: 13, PLATE: 14, LENS_CLEAR: 15,
  BRAKE_DISC: 16, GRILLE: 17, LIGHTBAR: 18, LAMP_MARKER: 19,
});

/** FOLIAGE family material ids. */
export const FOLIAGE = Object.freeze({ FROND: 0, LEAF: 1, GRASS: 2, FLOWER: 3 });

/** GLASS family material ids. */
export const GLASS = Object.freeze({ TINTED: 0, CLEAR: 1, LAMP_COVER: 2, LAMP_LENS: 3 });

/** Emissive / light switching channels (SOLID.EMISSIVE p1, light records, glow records). */
export const CHANNEL = Object.freeze({
  ALWAYS: 0,        // always on
  STREET: 1,        // street lighting: on from dusk to dawn
  NEON: 2,          // neon and illuminated signs: on from late afternoon to late night
  WINDOW: 3,        // interior lighting seen through windows
  SIGNAL_RED: 4, SIGNAL_AMBER: 5, SIGNAL_GREEN: 6,   // lens colours for traffic signals (lit state is drawn by the game as glows)
  AVIATION: 7,      // slow red blink on tall roofs and masts
  FLICKER: 8,       // a faulty neon tube
});

/** Bytes per vertex and attribute layout used by every mesh in the game. */
export const VERTEX_STRIDE = 36;
export const VERTEX_LAYOUT = Object.freeze({
  position: { offset: 0, size: 3, type: 'f32' },                 // metres, mesh-local
  normal: { offset: 12, size: 4, type: 'i16', normalized: true }, // xyz unit normal, w unused
  color: { offset: 20, size: 4, type: 'u8', normalized: true },   // rgb = sRGB albedo tint, a = baked occlusion (255 = open)
  material: { offset: 24, size: 4, type: 'u8' },                  // [material id, p0, p1, p2]
  uv: { offset: 28, size: 2, type: 'f32' },                       // family-defined surface coordinates
});

/** Floats per record in the light, glow and instance arrays. */
export const LIGHT_STRIDE = 16;
export const GLOW_STRIDE = 8;
export const INSTANCE_STRIDE = 8;
