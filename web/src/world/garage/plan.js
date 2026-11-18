// The garage's plan: every dimension and colour that more than one part of the set has to agree on.
//
// Frame: metres, origin at the turntable centre on the finished floor (y = 0). +Z is the street side (the roller
// door wall), -Z the back wall with the sign, -X the magenta side wall, +X the cyan one. Wall coordinates are the
// inner faces. Scale is taken from real things: a personnel door is 2.1 m, a bench top 0.9 m, a block 400 x 200 mm.

export const ROOM = Object.freeze({ x0: -7, x1: 7, z0: -9, z1: 9, truss: 4.5, deck: 5.5, wall: 0.2 });

/** Surface-mounted car turntable: a fixed ramp ring round a rotating disc. */
export const TURNTABLE = Object.freeze({ disc: 2.6, ring: 2.82, top: 0.065, mat: 2.36, matTop: 0.069 });

/** Cylinder kept clear for a car turning on the disc (the longest car's half diagonal plus a hand's breadth). */
export const SWEPT = Object.freeze({ radius: 3.0, height: 1.75 });

/** Roller door opening in the +Z wall; the curtain hangs `gap` above the floor so the dusk shows under it. */
export const DOOR = Object.freeze({ x0: -2.2, x1: 2.2, top: 3.6, gap: 0.045, travel: 3.45 });

/** Personnel door in the +X wall. */
export const SIDE_DOOR = Object.freeze({ z0: 5.3, z1: 6.2, top: 2.1 });

/** Backlit glass block panel in the +X wall: 12 x 10 blocks, in the bay between two piers on a 200 mm module. */
export const GLASS_BLOCK = Object.freeze({ z0: -7.2, z1: -4.8, y0: 1.4, y1: 3.4 });

/** Light box over the car: lit face `y` above the floor, long side along X. */
export const LIGHT_BOX = Object.freeze({ w: 5.2, d: 2.6, y: 3.05, depth: 0.22 });

/** Volume the camera's eye may be in; the set keeps it, and the space between it and the swept cylinder, empty. */
export const CAMERA = Object.freeze({ min: [-5.6, 0.25, -6.5], max: [5.6, 2.6, 7.6] });

/** Heights of the stripe band on the walls. */
export const BAND = Object.freeze({ dado: 0.95, teal: 1.07, gap: 1.105, pink: 1.165 });

/** Feature panel painted on the back wall behind the sign. */
export const FEATURE = Object.freeze({ x0: -4.4, x1: 4.4, y0: 1.3, y1: 4.5 });

/** Paint and surface colours, sRGB 0..1. */
export const COLOR = Object.freeze({
  wall: [0.29, 0.30, 0.305],           // mid grey masonry paint, dulled by years of exhaust: tubes light pools on it, not the wall
  dado: [0.07, 0.17, 0.19],            // dark teal enamel below the stripes, where hands and tyres reach
  teal: [0.07, 0.52, 0.52],
  pink: [0.84, 0.27, 0.50],
  feature: [0.085, 0.08, 0.14],        // deep indigo behind the sign, so the tubes own that wall
  epoxy: [0.10, 0.11, 0.12],
  line: [0.50, 0.44, 0.24],            // what is left of a safety yellow line
  deck: [0.09, 0.09, 0.10],            // roof deck and steel sprayed out in near black
  steelDark: [0.13, 0.135, 0.14],
  steelGrey: [0.42, 0.43, 0.44],
  chestRed: [0.55, 0.07, 0.06],
  rubber: [0.085, 0.085, 0.09],
  boot: [0.03, 0.03, 0.032],
  porcelain: [0.82, 0.81, 0.77],
  transformer: [0.44, 0.5, 0.31],      // hammered green enamel
});

/**
 * Neon gas colours. `tube` is the sRGB colour of the lit glass, `light` the linear colour the tube throws on the
 * room. No gas is one pure primary: the weakest channel of the glass keeps a floor, so that a camera clipping on
 * the tube sees its core go pale and leaves the colour to the halo.
 */
export const GAS = Object.freeze({
  pink: { tube: [1.0, 0.21, 0.56], light: [1.0, 0.07, 0.34] },
  magenta: { tube: [1.0, 0.20, 0.78], light: [1.0, 0.04, 0.55] },
  cyan: { tube: [0.20, 0.88, 1.0], light: [0.05, 0.72, 1.0] },
  violet: { tube: [0.56, 0.26, 1.0], light: [0.28, 0.08, 1.0] },
  amber: { tube: [1.0, 0.63, 0.20], light: [1.0, 0.36, 0.03] },
  orange: { tube: [1.0, 0.40, 0.20], light: [1.0, 0.16, 0.03] },
  warm: { tube: [1.0, 0.80, 0.56], light: [1.0, 0.62, 0.32] },
});

/**
 * Radiances (the renderer's units; reflections clamp at 48 after exposure). The tubes are far over white: the
 * camera clips them to a pale core and bloom carries their colour.
 */
export const RADIANCE = Object.freeze({ tube: 30, diffuser: 4.5, strip: 5, glassBlock: 1.1, dusk: 1.6 });
