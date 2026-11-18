// Every dimension of the Thunderhead in one place.
// Authoring coordinates are those of a coachbuilder's drawing, in millimetres: x rearward from the nose tip (the
// leading lip of the front bumper), y up from the ground, z outward from the centreline (the left half is modelled,
// the right half is mirrored). toCar() converts to the vehicle frame of the game (metres, +Z forward, +X left,
// origin on the ground under the middle of the wheelbase).

import { curve, KINK } from '../hero/kit/curve.js';

export const MM = 0.001;
export const LENGTH = 4483, WIDTH = 1803, HEIGHT = 1186;
export const WHEELBASE = 2443, FRONT_AXLE_X = 1029, REAR_AXLE_X = FRONT_AXLE_X + WHEELBASE;
/** x of the vehicle origin (middle of the wheelbase) in drawing coordinates. */
export const ORIGIN_X = FRONT_AXLE_X + WHEELBASE / 2;

/** Drawing millimetres to vehicle metres. */
export function toCar(x, y, z, out = [0, 0, 0]) { out[0] = z * MM; out[1] = y * MM; out[2] = (ORIGIN_X - x) * MM; return out; }

/**
 * Wheels: 16 inch flat-faced alloys on 255/50 tyres at both ends (the rear rim an inch wider). lip, bead: radius of
 * the rim's outer flange and of the bead seat. track: between the tyre centres on the physics hubs. axleY: the tyre
 * is squashed 5 mm at rest. rim: nominal diameter in inches; rimWidth: inches between the bead seats. offset: how far
 * the wheel is DRAWN outboard of its hub (the rears are drawn 8 mm inboard so that the tyre's face stands 15 mm inside
 * the arch lip, as at the front). driven: the axle with drive shafts. caliperAngle: where the caliper sits, in degrees
 * from straight ahead towards the top.
 */
const WHEEL_COMMON = { lip: 213, bead: 203, rim: 16, tyreWidth: 255, tyreRadius: 331, axleY: 326, dish: 30, bolts: 24, shoulder: 28, grooves: 5 };
export const WHEEL = {
  front: { ...WHEEL_COMMON, track: 1514, rimWidth: 8.5, offset: 0, driven: false, caliperAngle: 155 },
  rear: { ...WHEEL_COMMON, track: 1534, rimWidth: 9.5, offset: -8, driven: true, caliperAngle: 25 },
};
export const GROUND_CLEARANCE = 183;

// ---------------------------------------------------------------- hull rails
// The hull is one loft through eight rails, from the centreline over the top and down the side. The body has hardly
// a flat panel on it, so the upper rails are the corners of a control polygon rather than creases: each is rounded
// with as large a radius as its neighbours allow, which leaves a smooth section of tangent arcs.
//   C centre line: bonnet, cowl, roof, hatch glass, tail deck
//   D level with C, a little over half way to E: it keeps the section flat across the centre line
//   E bonnet: where the top begins to fall towards the fender; behind the cowl the top edge of the side glass
//     (roof edge), then the shoulder of the hatch glass dome, then the deck
//   G fender top; behind the cowl the base of the side glass, then the side edge of the hatch glass
//   H where the top rolls over into the body side (the corner of a large radius)
//   R the belt: the widest line of the body, where the rub strip runs right round the car
//   S bottom edge of the body side          B centre of the floor
// Each rail is (z, y) as a function of x. The hull starts at the bonnet's leading edge (NOSE_X) and ends at the
// tail deck's trailing edge (DECK_END_X); the bumpers below the belt at both ends are separate parts.
// The windscreen is not part of the hull (its base and header are bowed 200 mm in plan, which no section across the
// car can follow): see greenhouse.js. Between the pillar foot and the header the hull's centre is therefore
// imaginary: C, D and E climb from the cowl to the roof there, and only the side glass plane E-G is real.
export const NOSE_X = 56, DECK_END_X = 4420;
/** Bonnet's trailing edge and windscreen base on the centre line; screen header on the centre line. */
export const BONNET_END_X = 1665, SCREEN_BASE_X = 1740, HEADER_X = 2390;
/** Foot of the screen pillar and the corner where it meets the header (the screen is bowed, so both lie behind the centre). */
export const PILLAR_FOOT_X = 1960, HEADER_CORNER_X = 2560;
/** The fixed hoop behind the roof panel, the hatch glass behind that. HATCH_END_X: the glass's trailing edge on the centre line. */
export const HOOP_X = 3110, HATCH_X = 3230, HATCH_END_X = 4100;

// centre line: the bonnet rises at 25 degrees from the nose and eases to level at the cowl; the roof peaks at HEIGHT;
// the hatch glass falls ever more steeply to a nearly level deck
const centreY = curve([[NOSE_X, 525], [64, 532], [80, 540], [222, 599], [398, 661], [598, 714], [720, 750], [894, 785], [1098, 817], [1294, 836], [1450, 848], [BONNET_END_X, 856],
  [PILLAR_FOOT_X, 858, KINK], [HEADER_X, 1155, KINK], [HEADER_CORNER_X, 1176], [2800, HEIGHT], [3000, 1180], [3170, 1166], [HATCH_X, 1158], [3400, 1120], [3600, 1071], [3885, 988], [HATCH_END_X, 901, KINK], [DECK_END_X, 886]]);

// belt (rub strip): level along the doors, falling to the nose ahead of the front wheel
const beltY = curve([[NOSE_X, 519], [300, 524], [600, 545], [720, 554], [1029, 572], [1400, 585], [2200, 586], [3000, 588], [3760, 596], [DECK_END_X, 598]]);
// plan of the body side: widest at the doors, drawing in a little towards both ends, straight over the last 300 mm
export const sideZ = curve([[NOSE_X, 849], [400, 856], [700, 866], [1029, 884], [1500, 892], [2000, 894], [3000, 894], [3472, 892], [3900, 882], [4100, 872], [DECK_END_X, 856]]);
/**
 * Plan of the nose: straight across for `flat` each side of the centre line, then one sweep round the corner that
 * has run out into the body side by station `roundX`. The sweep is a superellipse of exponent `power`: it leaves
 * the straight front without a kink and without a jump in curvature.
 */
export const NOSE = { flat: 200, roundX: 700, power: 2.55 };
/** Half width of the body at the belt. At NOSE_X the outline is square to the car: its slope there is infinite. */
export function beltZ(x) {
  if (x >= NOSE.roundX) return sideZ(x);
  return NOSE.flat + (sideZ(x) - NOSE.flat) * noseSweep(Math.max(0, (x - NOSE_X) / (NOSE.roundX - NOSE_X)));
}
/** The superellipse: share of the way out to the body side reached at share s of the way back to roundX. */
export function noseSweep(s) { return s >= 1 ? 1 : (-Math.expm1(NOSE.power * Math.log1p(-s))) ** (1 / NOSE.power); }
export { beltY };

/**
 * Crossfall of the tail deck from the centre line, mm, at E and at G. No two facets of the hull may lie in line:
 * the loft drops a fillet whose corner turns less than a quarter of a degree, and its rows of the chart collapse.
 */
const DECK_FALL = { E: 4, G: 24 };
// G: fender top -> base of the side glass (rising to the rear) -> side edge of the hatch glass -> deck edge
const topZ = curve([[NOSE_X, 170], [60, 270], [70, 330], [100, 430], [222, 620], [398, 690], [1029, 720], [1450, 760], [BONNET_END_X, 780], [PILLAR_FOOT_X, 790], [2400, 760], [3000, 748], [HATCH_X, 745], [3600, 715], [3885, 705], [HATCH_END_X, 735], [4250, 788], [DECK_END_X, 782]]);
/** Side edge of the hatch glass in plan: it draws in faster than the fender top beside it. */
export const hatchSideZ = curve([[HATCH_X, 725], [3600, 690], [3885, 640], [4040, 590]]);
/** Crossfall of the bonnet and fender top from the centre line out to G. */
const topFall = curve([[NOSE_X, 2.5], [300, 14], [600, 16], [1029, 17], [1450, 36], [BONNET_END_X, 41], [PILLAR_FOOT_X, 46]]);
const glassBaseY = curve([[PILLAR_FOOT_X, 812], [2500, 846], [3050, 875], [HATCH_X, 878], [3600, 880], [3885, 886], [HATCH_END_X, 901 - DECK_FALL.G], [DECK_END_X, 886 - DECK_FALL.G]]);
const topY = (x) => (x < PILLAR_FOOT_X ? centreY(x) - topFall(x) : glassBaseY(x));

// E on the bonnet: a share of the way out to G and of the fall to it; it ends at the pillar foot, just inside G
const edgeShare = curve([[NOSE_X, 0.72], [BONNET_END_X, 0.72], [PILLAR_FOOT_X, 1]]);
const edgeFall = curve([[NOSE_X, 0.35], [BONNET_END_X, 0.35], [PILLAR_FOOT_X, 0.78]]);
// E behind the cowl: height of the side glass's top edge, then of the dome's shoulder
const edgeY = curve([[PILLAR_FOOT_X, 822, KINK], [2100, 965], [HEADER_X, 1139], [HEADER_CORNER_X, 1143], [2700, 1157], [2850, 1160], [3170, 1150], [HATCH_X, 1141], [3600, 1030], [3885, 957], [4040, 912, KINK], [HATCH_END_X, 901 - DECK_FALL.E], [DECK_END_X, 886 - DECK_FALL.E]]);
const edgeZ = curve([[HEADER_CORNER_X, 548], [2800, 545], [3170, 555], [HATCH_X, 558], [3600, 500], [3885, 470], [HATCH_END_X, 450], [DECK_END_X, 440]]);
/** Tumblehome of the side glass: millimetres inward per millimetre of height. */
export const TUMBLEHOME = (topZ(HEADER_CORNER_X) - edgeZ(HEADER_CORNER_X)) / (edgeY(HEADER_CORNER_X) - glassBaseY(HEADER_CORNER_X));
/** Where the plane of the side glass, which stands on G, reaches height y at station x. */
export const glassPlaneZ = (x, y) => topZ(x) - (y - glassBaseY(x)) * TUMBLEHOME;
function edge(x) {
  if (x >= HEADER_CORNER_X) return [edgeZ(x), edgeY(x)];
  if (x >= PILLAR_FOOT_X) return [glassPlaneZ(x, edgeY(x)), edgeY(x)];
  const share = edgeShare(x), z = topZ(x) * share, fall = topFall(x) * edgeFall(x);
  // at the pillar foot E sits on the glass plane, a hand inside G
  const foot = (x - BONNET_END_X) / (PILLAR_FOOT_X - BONNET_END_X), zFoot = glassPlaneZ(PILLAR_FOOT_X, edgeY(PILLAR_FOOT_X));
  return [foot > 0 ? z + (zFoot - topZ(PILLAR_FOOT_X)) * foot * foot : z, centreY(x) - fall];
}
/**
 * Windscreen. Its base and its header are bowed in plan: parabolas from the centre line (SCREEN_BASE_X, HEADER_X)
 * out to the pillar foot and the header corner. Its side edge is the pillar line, which lies on the plane of the
 * side glass and climbs at `slope` from footY at the pillar foot. The glass is crowned by `crown` mm up its
 * height. tuck: how far the cowl runs on under the lower edge at the centre line (nothing at the pillar foot).
 */
export const SCREEN = { footY: 822, slope: 0.535, crown: 9, tuck: 25 };
export const pillarY = (x) => SCREEN.footY + SCREEN.slope * (x - PILLAR_FOOT_X);
/**
 * Screen pillar: its outer face is the strip of the side glass plane between the pillar line and the leading edge
 * of the door glass, `width` mm behind it measured square to the line in side view.
 */
export const PILLAR = { width: 36 };
/** Panes: depth of the outer face under the skin and thickness, mm. Seals round them: width on the skin and height over it. */
export const PANE = { screen: { depth: 4, thickness: 5 }, side: { depth: 5, thickness: 4 }, hatch: { depth: 4, thickness: 5 }, seal: { width: 12, proud: 2 }, overlap: 9 };
/** D stands this share of the way from the centre line to E. */
const INNER_SHARE = 0.56;

// H: the corner of the shoulder roll, given as its height over the belt and its inset from the belt's width
const rollRise = curve([[NOSE_X, 0.5], [100, 17], [222, 54], [398, 105], [598, 141], [720, 159], [1029, 202], [1450, 176], [BONNET_END_X, 163], [PILLAR_FOOT_X, 147], [2400, 134], [3000, 134], [3472, 138], [3900, 140], [4250, 215], [DECK_END_X, 212]]);
const rollInset = curve([[NOSE_X, 2], [300, 6], [1029, 8], [PILLAR_FOOT_X, 6], [DECK_END_X, 6]]);

// underside: the rocker between the wheels and the air dam ahead of them; the tail sweeps up
const sillY = curve([[NOSE_X, 192], [520, 190], [700, 183], [3550, 183], [3900, 253], [DECK_END_X, 360]]);
const tuck = curve([[NOSE_X, 20], [400, 60], [1029, 90], [1500, 95], [3000, 95], [3472, 100], [DECK_END_X, 110]]);

export const RAIL = {
  C: (x) => [0, centreY(x)],
  D: (x) => [edge(x)[0] * INNER_SHARE, centreY(x)],
  E: edge,
  G: (x) => [topZ(x), topY(x)],
  H: (x) => [beltZ(x) - rollInset(x), beltY(x) + rollRise(x)],
  R: (x) => [beltZ(x), beltY(x)],
  S: (x) => [beltZ(x) - tuck(x), sillY(x)],
  B: (x) => [0, sillY(x)],
};
export const RAIL_NAMES = ['C', 'D', 'E', 'G', 'H', 'R', 'S', 'B'];
/** Chart index of each rail in the hull loft. */
export const B_OF = { C: 0, D: 1, E: 2, G: 3, H: 4, R: 5, S: 6, B: 7 };
const ramp = (x, x0, x1, v0, v1) => v0 + (v1 - v0) * Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
/** "As round as the neighbouring facets allow": the loft caps a fillet at 0.45 of each facet beside it. */
const FAIR = 1e5;
/**
 * Fillet radius of each crease, mm. D is always faired. E is faired on the bonnet and the deck, absent where the
 * hull's centre is imaginary, a 30 mm roof edge beside the roof panel and the hoop, and the broad shoulder of the
 * hatch glass. G is faired on the fenders and the tail, and a plain break under the side and hatch glass. H is the
 * big roll of the shoulder; R is hidden under the rub strip.
 */
export const CREASE_RADIUS = {
  D: FAIR,
  E: (x) => (x < PILLAR_FOOT_X ? FAIR : x < HEADER_X ? 0 : x < HOOP_X ? ramp(x, HEADER_X, HEADER_CORNER_X, 0, 30) : x < HATCH_END_X ? ramp(x, HOOP_X, HATCH_X, 30, 400) : FAIR),
  G: (x) => (x < BONNET_END_X ? 400 : x < 3500 ? ramp(x, BONNET_END_X, PILLAR_FOOT_X, 400, 12) : x < 3885 ? ramp(x, 3500, 3885, 12, 120) : ramp(x, 3885, 4250, 120, 85)),
  H: (x) => (x < 3900 ? ramp(x, FRONT_AXLE_X, PILLAR_FOOT_X, 95, 130) : ramp(x, 3900, 4250, 130, 85)),
  R: 20, S: 35,
};
/**
 * Crown of each facet, mm, keyed by the rail the facet starts at: only the side glass is crowned (a barrel, its
 * edges under seals); everywhere else the curvature comes from the faired corners. The crown runs out over the hoop
 * (and by itself at the pillar foot, where the facet has no length): a crown that ended at a station would be a step.
 */
export const CROWN = { E: (x) => (x < PILLAR_FOOT_X ? 0 : ramp(x, HOOP_X, HATCH_X, 8, 0)) };

export const GAP = 6;                         // shut line width
export const PAINT_FLAKE = 0;                 // the finish belongs to the paint entry, see index.js

/** Wheel openings: round, 35 mm clear of the tyre, with a slight pressed lip. faceZ: the flat face of the lip, level with the rub strip. */
export const ARCH = { radius: 366, flare: 50, face: 14, faceZ: 900, linerZ: 520 };

// ---------------------------------------------------------------- panel lines (side view x, y; plan x, z)
/** The clamshell bonnet's trailing edge: across the cowl in plan [x, z], then straight down the flank at CLAM_X. */
export const CLAM_X = 1830;
export const CLAM_CUT = [[BONNET_END_X, 0], [1680, 330], [1740, 640], [CLAM_X, 778]];
/**
 * Door: front edge upright at frontX, rear edge leaning from rearBottomX at the sill line to rearTopX at the glass;
 * lower corners rounded. The line bottomY also parts the rocker from the panels above it, wheel to wheel.
 */
export const DOOR = { frontX: 1880, rearBottomX: 2945, rearTopX: 3020, bottomY: 400, frontCorner: 80, rearCorner: 90 };
/** Roof panel: its front edge lies FRAME behind the screen header, its side edge on the glass plane under the roof edge. */
export const ROOF = { frame: 48, sideRow: 2.36 };
/** Hatch glass: corner radii in metres; its trailing edge is bowed back by `bow` mm at the centre line. */
export const HATCH = { frontCorner: 0.05, rearCorner: 0.09, bow: 60 };

// ---------------------------------------------------------------- the two ends
// Both bumpers are skins swept along the plan outline of the belt (see plan.js and bumpers.js). Their sections are
// given as [out, y]: millimetres outward from the belt's outline, and height.
/**
 * Front bumper, on the centre line: the face leans forward from the rub strip down to `lip`, turns under to `under`
 * (where the paint ends) and the black air dam falls back to `dam`. Round the corner the section fades into the
 * body side between the stations `fade`; there the paint ends at height sideUnderY.
 */
export const FRONT_BUMPER = { lip: [56, 342], under: [-8, 300], dam: [-45, 192], lipRadius: 38, underRadius: 7, sideLipY: 330, sideUnderY: 262, fade: [120, 560] };
/**
 * Tail. In plan the body side runs straight to cornerX, turns through a corner of `radius` and runs square across
 * the car. startX: where the skin begins on the body side (ahead of the rear wheel opening's trailing edge);
 * seamX: where its upper part begins, at a shut line down to the belt. Section on the centre line, from the deck
 * down: `inner` (how far inboard of the belt the skin begins, on the level deck), `crest` the deck's trailing edge,
 * `foot` of the lamp panel, which is undercut, `ledge` the outer edge of the shelf below it, the belt, `bulge` the
 * rearmost line of the bumper, `bottom` its lower edge and `tuck` the return under it. cutRow: the row of the
 * skin's chart (0 inner .. 1 crest) on which the shut line to the deck lies.
 */
export const TAIL = {
  startX: 3800, seamX: 4120, cornerX: 4309, radius: 165,
  inner: 260, crest: [-48, 0], foot: [-84, 690], ledge: [-3, 620], bulge: [12, 505], bottom: [-28, 370], tuck: [-75, 362],
  crestRadius: 20, footRadius: 35, ledgeRadius: 8, beltRadius: 6, bulgeRadius: 300, bottomRadius: 30, cutRow: 0.62,
};

// ---------------------------------------------------------------- lamps (see lamps.js)
/**
 * Pop-up headlamp pod: a body-colour lid let into the bonnet, [x0, x1] by [z0, z1] in plan with corners of `corner`
 * (m), hinged across the car hingeDepth under the skin at station hingeX. The well under it is depthFront deep at
 * its leading edge and depthRear at the hinge. openAngle (rad): how far the pod turns to stand the lamps upright.
 * lamp: the two rectangular lamps side by side in the pod's face, and the distance between their centres.
 */
export const LAMP_POD = {
  x0: 275, x1: 525, z0: 402, z1: 716, corner: 0.028, hingeX: 506, hingeDepth: 14, depthFront: 215, depthRear: 120, openAngle: 0.6,
  lamp: { width: 142, height: 98, pitch: 146, corner: 12 },
};
/**
 * The lamp unit in the front bumper's slot: lenses between the heights y; the fog lamp inboard, then the turn lamp
 * and the parking lamp outboard, each [z0, z1]; frame: width of the black frame round each lens; `facet`: width of the flat facets a lens is made of as it follows the bumper round;
 * seat: height of the lens under the bumper's skin; depth of the reflectors behind it. All mm.
 */
export const FRONT_LAMPS = { y: [402, 468], fog: [203, 386], turn: [400, 522], park: [532, 617], facet: 44, seat: -11, depth: 32, frame: 4 };
/**
 * Round tail lamp: radius of the lens and of its centre, which is a lamp of its own behind a bright ring; seat:
 * height of the lens under the panel; depth of the reflector. mm.
 */
export const TAIL_LAMP = { lens: 67, centre: 27, ring: 2.6, seat: -9, depth: 36, centreDepth: 20 };
/** High centre stop lamp on the hoop above the hatch glass: station of its rear face, half width, height, length. mm. */
export const STOP_LAMP = { x: 3236, half: 150, height: 30, length: 70 };
/** Side marker lamps [x, y] on the bumpers' sides, and their size. mm. */
export const SIDE_MARKER = { front: [455, 462], rear: [4215, 548], width: 105, height: 30 };

// ---------------------------------------------------------------- details (see details.js)
/**
 * The two gills behind the front wheel: stations of their centres at mid height, their width, bottom and top, and
 * how far the top of each stands ahead of its foot. mm.
 */
export const GILL = { x: [1556, 1626], width: 27, y: [426, 542], lean: 12, corner: 0.009, depth: 22 };
/** Door handle: a flap in a pocket high on the door's trailing end. Stations, heights, depth of the pocket. mm. */
export const HANDLE = { x: [2888, 3004], y: [716, 752], corner: 0.009, depth: 16, flap: 0.58 };
/**
 * Door mirror: station of its rear face and height of its centre; width (across the car), height and length of the
 * housing; the gap between the door and the housing; corner radius of its section; width of the black rim round the glass. mm.
 */
export const MIRROR = { x: 2082, y: 846, width: 160, height: 98, length: 116, stand: 30, corner: 24, rim: 5 };
/** Exhaust tips, two a side under the rear bumper: [z0, z1] of each, bottom and top, station of the mouths, length, wall. mm. */
export const EXHAUST = { z: [[316, 420], [432, 536]], y: [301, 353], x: 4444, length: 170, wall: 3.5, corner: 9, bore: 120 };
/** Rear number plate: width, height, frame; emblem on the nose: station and radius; the name on the tail: lower left corner [z, y] on the right-hand side, letter height. mm. */
export const PLATE = { width: 305, height: 152, frame: 5, y: 518 };
export const EMBLEM = { x: 150, radius: 27 };
export const SCRIPT = { z: 205, y: 541, height: 21, slant: 0.2 };
/** Wipers: the blades lie along the foot of the screen; height above the screen's base line as a share of the screen, blade length. */
export const WIPER = { t: 0.045, blade: 480, lift: 16 };

// ---------------------------------------------------------------- cabin (see cabin.js)
/**
 * The cabin. Seat zone: floor, the tall backbone between the seats (tunnelHalf, tunnelTop), the wide sill (its inner
 * wall at sillZ, its top at sillTop), the door card at cardZ with its armrest. footX: where the footwell ends under
 * the dash. bulkhead: side-view line of the wall behind the seats, which leans back over the rear wheel houses up
 * to the load floor. Load zone under the hatch glass: a well (floor at loadY, half width wellZ, as far back as
 * loadEndX) between two shelves at shelfY that cover the wheel houses.
 */
export const CABIN = {
  floorY: 215, tunnelHalf: 150, tunnelTop: 480, sillZ: 592, sillTop: 400, cardZ: 735, armY: 630, footX: 1960,
  bulkhead: [[3040, 215], [3060, 420], [3150, 600], [3150, 730]], shelfY: 730, wellZ: 505, loadY: 600, loadEndX: 4020,
  // dash: the brow's station on the centre line and at the side, its height on the centre line and its fall to the
  // side, the half width, the lower lip of the face
  dash: { browX: 2150, sideX: 2185, top: 866, fall: 50, z: 750, lipX: 2165, lipY: 610 },
  // seat: centre line, half widths, the height of the side bolsters, the pitch of the pleats, and the side-view
  // spine from the foot of the cushion's front over the headrest and down the back, with its corner radii
  seat: { z: 372, halfWidth: 205, headHalfWidth: 130, bolster: 40, pleat: 62,
    spine: [[2470, 215], [2470, 392], [2498, 422], [2850, 372], [2906, 412], [3040, 880], [3062, 1000], [3088, 1036], [3122, 1010], [2992, 400], [2978, 215]],
    radius: [0, 20, 25, 50, 50, 80, 30, 35, 30, 20, 0] },
  // instrument panel: a hooded box on the dash face in front of the driver; z and y of its face, the station of the face
  panel: { z: [185, 559], y: [742, 852], faceX: 2168, hood: 46, noseX: 2060, noseY: 868 },
  wheel: { diameter: 368, tube: 14, topX: 2296, topY: 926, z: 372, rake: 20 },
  lever: { x: 2560, z: 40 },
  eye: [2900, 985, 372],
};
