// Every dimension of the car in one place.
// Authoring coordinates are those of a coachbuilder's drawing, in millimetres: x rearward from the nose tip, y up
// from the ground, z outward from the centreline (the left half is modelled, the right half is mirrored).
// toCar() converts to the vehicle frame of the game (metres, +Z forward, +X left, origin under the wheelbase centre).

import { curve, KINK } from './kit/curve.js';

export const MM = 0.001;
export const LENGTH = 4140, WIDTH = 2000, HEIGHT = 1070;
export const WHEELBASE = 2450, FRONT_AXLE_X = 935, REAR_AXLE_X = FRONT_AXLE_X + WHEELBASE;
/** x of the vehicle origin (middle of the wheelbase) in drawing coordinates. */
export const ORIGIN_X = FRONT_AXLE_X + WHEELBASE / 2;

/** Drawing millimetres to vehicle metres. */
export function toCar(x, y, z, out = [0, 0, 0]) { out[0] = z * MM; out[1] = y * MM; out[2] = (ORIGIN_X - x) * MM; return out; }

/**
 * Wheels. The tyre sizes, track and axle heights are the car's; the wheel itself (a three-piece alloy with five
 * spokes, see wheels/design.js) is sized from them. lip: radius of the rim's outer flange (a 16 inch wheel), the
 * same at both ends, so that the rear tyre's sidewall is the lower. dish: how far the centre's bolt ring lies behind
 * the lip (the rears are deep-dished). offset: how far the wheel is DRAWN outboard of the hub on its track, so that
 * the tyre stands close to the flare; the physics track is unchanged. caliperAngle: where the caliper sits, in
 * degrees from straight ahead towards the top.
 */
const WHEEL_COMMON = { lip: 213, bead: 203 };
export const WHEEL = {
  front: { ...WHEEL_COMMON, track: 1536, tyreWidth: 225, tyreRadius: 303, axleY: 298, dish: 50, offset: 35, bolts: 24, shoulder: 25, grooves: 4, caliperAngle: 155 },
  rear: { ...WHEEL_COMMON, track: 1606, tyreWidth: 345, tyreRadius: 311, axleY: 306, dish: 110, offset: 0, bolts: 30, shoulder: 30, grooves: 6, caliperAngle: 25 },
};
export const GROUND_CLEARANCE = 125;

// ---------------------------------------------------------------- hull rails
// The hull is a loft through eight rails. Listed from the centreline over the top and down the side:
//   C centre line of the top surfaces        E bonnet shut line (front) / engine lid edge (rear)
//   V wing top (front) / top of the valley wall beside the engine lid (rear)
//   D inner edge of the shoulder facet: wing shoulder, base of the side glass, outer edge of the rear wing top
//   W waist crease: the widest line of the upper body      K sill crease      S bottom edge of the side      B centre of the floor
// Each rail is (z, y) as a function of x.

const noseY = curve([[0, 355], [414, 539], [800, 700, KINK], [973, 733], [1118, 752]]);            // bonnet at 23 degrees with 6 mm of crown along it, cowl at 10
const valleyY = curve([[2500, 990], [3320, 895], [4140, 792]]);                                      // engine lid and tail deck: 7 degrees, 4 mm of crown along it
const centreY = (x) => (x < 1400 ? noseY(x) : x > 2400 ? valleyY(x) : noseY(1400) + (valleyY(2400) - noseY(1400)) * (x - 1400) / 1000);

const lidZ = curve([[0, 590], [800, 286, KINK], [1118, 300], [2400, 460], [2600, 470], [4140, 470]]);       // bonnet lines converge at 21 degrees
// The waist is narrower over the front wheels than at the door, so the front flares (face at z 940) stand a clear
// 25 to 30 mm off the body side instead of being nearly flush with it.
const waistZ = curve([[0, 790], [104, 862], [207, 884], [414, 901], [621, 907], [828, 910], [935, 911], [1118, 913], [1345, 919], [1822, 930], [2070, 931], [2422, 936], [2691, 938], [2898, 940], [3229, 942], [3385, 943], [3726, 945], [3933, 945], [4140, 948]]);
const waistY = curve([[0, 343], [104, 388], [207, 428], [414, 500], [621, 566], [828, 624], [1118, 674], [1656, 690], [2070, 706], [2422, 730], [2691, 775], [2898, 825], [3229, 852], [3385, 847], [3726, 838], [3933, 822], [4140, 792]]);
const shoulderZ = curve([[0, 786], [104, 858], [207, 874], [414, 880], [621, 872], [828, 856], [1118, 832], [1345, 845], [2422, 845], [2691, 862], [2898, 878], [3229, 885], [3385, 890], [3726, 900], [3933, 915], [4140, 936]]);
const wingTopY = curve([[2422, 808], [2691, 850], [2898, 908], [3229, 978], [3385, 947], [3726, 880], [3933, 840], [4140, 800]]);
const glassBaseY = curve([[1118, 749], [1345, 756], [1656, 770], [1822, 781], [2070, 792], [2422, 808]]);
/** Height lost across the wing top from the bonnet line to the shoulder (a 2 degree crossfall that keeps the nose from looking like a slab). */
const crossfall = curve([[0, 4], [400, 10], [800, 16], [1118, 3]]);
const shoulderY = (x) => (x < 1118 ? noseY(x) - crossfall(x) : x < 2422 ? glassBaseY(x) : wingTopY(x));
const valleyTopZ = curve([[2500, 548], [4140, 520]]);

const sillY = curve([[0, 245], [500, 200], [700, 125], [3500, 125, KINK], [3726, 278], [3933, 385], [4140, 503]]);
const creaseY = curve([[0, 318], [400, 330], [1118, 352], [2422, 360], [2898, 375], [3385, 382], [3726, 425], [3933, 495], [4140, 575]]);       // sill crease
const tuck = curve([[0, 20], [700, 45], [3400, 45], [3726, 60], [4140, 28]]);

export const RAIL = {
  C: (x) => [0, centreY(x)],
  E: (x) => [lidZ(x), centreY(x)],
  // Ahead of the cabin V is not a crease: it is the middle of the wing top, lifted so that E-V-D is one parabola
  // (the two half facets carry a quarter of the lift each, which makes their slopes meet exactly at V).
  V: (x) => { if (x >= 2400) return [valleyTopZ(x), shoulderY(x) + 3]; const m = mix(RAIL.E(x), RAIL.D(x), 0.5); m[1] += wingCrown(x); return m; },
  D: (x) => [shoulderZ(x), shoulderY(x)],
  W: (x) => [waistZ(x), waistY(x)],
  K: (x) => [waistZ(x) + 6, creaseY(x)],
  S: (x) => [waistZ(x) + 6 - tuck(x), Math.min(sillY(x), creaseY(x) - 30)],
  B: (x) => [0, Math.min(sillY(x), creaseY(x) - 30)],
};
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
/** Crown of the front wing top, mm: nothing at the nose tip, where the wing is a few centimetres wide. */
function wingCrown(x) { return 5 * Math.min(1, Math.max(0, x / 250)); }
/** Chart index of each rail in the hull loft. */
export const B_OF = { C: 0, E: 1, V: 2, D: 3, W: 4, K: 5, S: 6, B: 7 };
/** Fillet radius of each crease, mm. */
// The bonnet crease is soft; behind the cabin the same rail is the crisp edge of the engine deck (the change
// happens under the greenhouse, where no panel is cut from the hull).
export const CREASE_RADIUS = { E: (x) => (x < 1200 ? 40 : x > 2400 ? 10 : 40 - 30 * (x - 1200) / 1200), V: (x) => (x < 2400 ? 0 : 9), D: 11, W: 10, K: 14, S: 18 };
/**
 * Crown of each facet, mm, keyed by the rail the facet starts at (see makeLoft). The bonnet and the engine deck are
 * highest on the centre line (the deck a little more, so that the chase camera sees lights run across it); the door skin between waist and sill bows out the most of the side facets.
 */
export const CROWN = { C: (x) => (x < 1200 ? 7 : 12), E: (x) => (x < 2400 ? wingCrown(x) / 4 : 0), V: (x) => (x < 2400 ? wingCrown(x) / 4 : 6), D: 8, W: 9, K: 3 };
/** Crown of the canopy's roof (and, less, of the windscreen) across the width, mm: a flat roof carries no reflection. */
export const CANOPY_CROWN = (x) => (x < 1801 ? 6 : 10);

// ---------------------------------------------------------------- panel layout (drawing millimetres)
export const GAP = 6;                         // shut line width
/**
 * Least metallic flake in the body paint, as PAINT's first material parameter (0..255). The finish of a car (solid,
 * metallic, pearl) belongs to its paint entry, see index.js, so the panels themselves ask for none.
 */
export const PAINT_FLAKE = 0;
export const NOSE_CUT_Y = 345;                // the flank ends here ahead of the front wheel; the bumper and chin are below
export const SILL_TOP_Y = 375;                // door bottom / top of the fixed sill
export const BONNET = { x0: 0, x1: 787 };
export const SCREEN_BASE = { x0: 973, z0: 470, x1: 1118, z1: 820 };     // lower edge of the hexagonal windscreen
export const DOOR = { frontTopX: 1110, frontBottomX: 1449, rearBottomX: 2153, rearTopX: 2424 };
export const CABIN_END_X = 2546;              // rear bulkhead and rear window
export const ENGINE_LID = { x0: 2629, x1: 3560 };
export const BOOT_LID = { x0: 3600 };
export const TAIL_INSET = 25;                 // the tail panel stands this far inside the deck's trailing edge
/**
 * Wheel openings. radius / outline: the opening edge, 30 to 40 mm clear of the tyre all round (front tyre 303, rear 311
 * about the axle); flare: width of the flare band along the body side; face: width of its flat outer face; faceZ:
 * lateral position of that face (the tyre's outer face stands 15 to 25 mm inside it); linerZ: the liner's inner wall.
 */
export const FRONT_ARCH = { radius: 336, flare: 150, face: 60, faceZ: 940, linerZ: 560 };
/** Rear wheel opening, side view (x, y): a slanted trapezoid, long sloping leading edge. Both ends lie on the body's lower edge; flareLead: the band's width on that leading edge. */
// Rear opening: a vertical cut ahead of the tyre, then an arc of 346 mm about the axle (3385, 306), 35 mm outside the
// 311 mm tyre round to the last arc point, then a straight run down to the trailing foot on the body's lower edge.
export const REAR_ARCH = { outline: [[3010, 120], [3010, 410], [3212, 606], [3295, 640], [3385, 652], [3475, 640], [3558, 606], [3630, 551], [3685, 479], [3719, 396], [3760, 297]], cornerRadius: [0, 60, 30, 30, 30, 30, 30, 30, 30, 30, 0], faceZ: 1000, flare: 190, face: 80, flareLead: 255, linerZ: 540 };
/**
 * Pop-up headlamp pod: a body-colour lid in each wing top between the bonnet shut line and the shoulder, hinged across
 * the car near its rear edge. hingeDepth: how far the axis lies under the skin; depthFront/Rear: depth of the well
 * under the opening (the lamps' face hangs from the lid's front edge and swings down and back into it as the pod
 * shuts, so the front is the deeper end); openAngle: how far the pod turns to bring the lid level and the lamps
 * upright (radians).
 */
export const LAMP_POD = { x0: 225, x1: 600, lidClear: 20, shoulderClear: 18, hingeX: 575, hingeDepth: 14, depthFront: 225, depthRear: 180, openAngle: 0.5 };
export const INDICATOR = { x0: 82, x1: 195, lidClear: 18, shoulderClear: 16, amberShare: 0.4 };
export const SIDE_MARKER = { front: [373, 385], rear: [3850, 556], width: 45, height: 25 };
export const LOUVRE_BANK = { x0: 3570, x1: 3975, z0: 585, z1: 862, slats: 7 };
export const NACA = { apex: [2132, 642], top: [2670, 742], bottom: [2670, 535], depth: 110 };
/**
 * Shoulder air box: side-view wedge from the foot behind the side glass over the peak and down into the deck. lean and
 * fall in degrees. The brief's 16 degree fall would bury the box in the rising wing top 300 mm behind the peak, and
 * a 52 degree outer face would leave a top only 50 mm wide, so both are gentler here.
 */
export const AIR_BOX = { x0: 2530, x1: 3400, z0: 562, z1: 878, footY: 822, peakX: 2857, peakY: 1045, fall: 9, lean: 24, frame: 16, depth: 30, slatPitch: 21 };
/** Raised engine cover on the lid; the opening is in its rear face (top: margin under the top edge). */
export const ENGINE_COVER = { x0: 2720, x1: 3500, ramp: 45, halfWidthFront: 260, halfWidthRear: 320, heightFront: 30, heightRear: 78, flankLean: 0.2,
  opening: { halfWidth: 260, height: 54, top: 11, depth: 45, slats: 3 } };
// ---------------------------------------------------------------- canopy rails
// The cabin is a second loft standing on the hull: centre line of windscreen and roof, the A pillar that becomes
// the roof edge, and the base of the side glass (the hull's shoulder line). Ahead of the pillar foot the two outer
// rails run on together so the windscreen plane carries on down to the cowl.
export const CANOPY = { x0: 973, x1: 2546, footX: 1118, headerX: 1801 };
const roofY = curve([[973, 733], [1801, 1022], [1880, 1047], [2000, 1050], [2525, 1060], [2546, 1060]]);
const cantZ = curve([[973, 890], [1118, 806, KINK], [1801, 490, KINK], [2546, 490]]);
const cantY = curve([[973, 723], [1118, 762, KINK], [1801, 1022, KINK], [1900, 1043], [2546, 1055]]);
export const CANOPY_RAIL = {
  C: (x) => [0, roofY(x)],
  R: (x) => [cantZ(x), cantY(x)],
  G: (x) => (x < CANOPY.footX ? [cantZ(x) + 27, cantY(x) - 14] : RAIL.D(x)),
};
/** Fillet of the A pillar and of the roof edge. */
export const CANOPY_RADIUS = (x) => (x < 1801 ? 14 : 22);
/** Apertures: margins in millimetres from the canopy's edges and creases; seal: the dark rubber surround on the skin round each pane, width and how far it stands proud. */
export const WINDSCREEN = { baseX: 1005, headerX: 1788, baseZ: 455, footX: 1128, footZ: 768, headerZ: 450, depth: 6, thickness: 5 };
export const SIDE_GLASS = { x0: 1250, x1: 2422, pillar: 20, belt: 8, dividerX: 1560, splitY: 904, depth: 6, thickness: 4 };
export const REAR_WINDOW = { halfWidth: 320, y: [1004, 1052], depth: 10 };
export const GLASS_SEAL = { width: 13, proud: 2 };

/**
 * Cabin (see interior.js). The brief's 480 mm seats at z 330 would overlap its own 300 mm tunnel, so the seats are
 * 380 mm wide at z 350, and the backs recline 28 degrees so that the cushions clear the dash.
 */
export const CABIN = {
  x0: 1310, x1: 2532, floorY: 150, tunnelHalf: 150, tunnelTop: 410, sillZ: 560, sillTop: 372, cardZ: 800,
  dash: { x: 1500, top: 762, lip: 600, noseX: 985, noseY: 712, z: 812 },
  seat: { z: 350, halfWidth: 190, headHalfWidth: 135, bolster: 38, pleat: 66,
    spine: [[1560, 150], [1560, 318], [1585, 345], [1930, 300], [1990, 345], [2238, 815], [2290, 950], [2325, 990], [2375, 965], [2110, 330], [2090, 150]],
    radius: [0, 20, 25, 50, 50, 80, 30, 35, 30, 20, 0] },
  binnacle: { z: [140, 560], y: [742, 868], faceX: 1512, hood: 30, noseX: 1300, noseY: 775 },
  wheel: { diameter: 350, tube: 13, topX: 1656, topY: 850, z: 350, rake: 22 },
  gate: { x: 1863, length: 120, width: 100 },
  pedals: { x: 1400, y: 255, z: [245, 335, 430] },
  eye: [2110, 905, 350],
};

/** Small parts (see details.js). The model is called Lucera; the name is ours. */
export const DETAIL = {
  // nose: width and height of the housing's front as shares of its rear; straight: share of the depth with the full
  // section; rim: flat border round the glass; recess: how far the glass sits inside it
  mirror: { x: 1408, y: 800, footY: 735, outerZ: 1010, width: 170, height: 110, depth: 90, nose: [0.6, 0.34], straight: 0.3, corner: 16, rim: 5, recess: 5 },
  release: { x: 2629, y: 396, width: 80, height: 14 },
  wiper: { pivotX: 990, pivotZ: 190, blade: 600, bladeX: 1052 },
  emblem: { x: 145, width: 45, height: 50 },
  script: { text: 'LUCERA', u: 205, v: 640, height: 30 },
};

/**
 * Nose below the bonnet edge (see fascia.js). s = distance along the plan outline from the centreline; o = outward.
 * The brief's 95 mm fog lamp cannot fit a bumper band that ends at y 245 under a nose edge at 355, so the band is
 * taken 5 mm lower and the lamp is 60 mm tall.
 */
export const FASCIA = {
  cornerRadius: 45, fadeStart: 110, fadeLength: 170,
  bumperTop: 338, bumperBottom: 262, shadowDepth: 14, faceInset: 3, bevel: 4,
  pocket: { s: [352, 742], y: [268, 320], depth: 30 },
  fog: { z: 455, width: 195 }, grille: { z: [572, 734], bars: 3, height: 8 },
  // The chin is a blade: its top face slopes from the back of the intake slot forward and down to a thin edge that
  // stands chinLip ahead of the bumper face; along the flank the same section becomes the skirt (skirtLip forward).
  // The edge rolls under and returns returnDepth inward, trayStep above its lowest line; the undertray starts there.
  intakeDepth: 36, chinTop: 222, chinLip: 55, skirtLip: 30, edge: 25, lipY: 110, returnDepth: 30, trayStep: 4,
  brakeSlot: { s: [530, 710], t: [0.3, 0.75], depth: 24 },
};
/**
 * Tail (see tail.js). The hull's underside rises to y 503 at the tail, so the lamp housing sits a little higher than
 * the brief's 470 and its three segments are 128 mm wide instead of 137 to fit between the centre panel and the rim.
 * Under the panel a slim body-colour bumper bar (bar: how far it stands behind the tail plane, height, edge radius,
 * back: depth of its closed section ahead of the plane); below the bar the tail is open: a dark recess with the mesh
 * panel, the plate and the exhausts in the middle, and the rear tyres in view at both corners. The mesh panel stands
 * 55 mm ahead of the tail panel so that the exhaust tips end inside the overall length.
 */
export const TAIL = {
  planeX: LENGTH - TAIL_INSET, rim: 20, cornerRadius: 10, rimDepth: 28, rimLean: 5,
  housing: { z: [487, 921], yIn: [512, 752], yOut: [574, 736], chamfer: 60, depth: 20, radius: 9 },
  segment: { z0: 499, width: 128, height: 105, gap: 12, y: 642, radius: 8, proud: 7 },
  reflector: { width: 60, height: 26, drop: 8 },
  bar: { project: 22, height: 48, radius: 6, back: 12 },
  mesh: { x: LENGTH - 80, y: [250, 432], z: 480, boxStartX: 3740 },
  cutout: { z: [245, 445], y: [293, 367], depth: 120 },
  exhaust: { z: 345, pitch: 95, y: 330, diameter: 70, wall: 3, project: 70, down: 8, splay: 6 },
  plate: { width: 305, height: 152, bottom: 272, frame: 7 },
  // the plate and its frame sit in a pressed recess of the mesh panel, open at the top to the lip's underside
  plateRecess: { margin: 10, depth: 16 },
};
export { lidZ, shoulderZ, waistZ, waistY, sillY };
