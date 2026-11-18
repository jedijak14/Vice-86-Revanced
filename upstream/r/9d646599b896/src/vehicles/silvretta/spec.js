// Every dimension of the Silvretta Turbo, in the coordinates of a coachbuilder's drawing: millimetres, x rearward
// from the nose tip, y up from the ground, z outward from the centre line. Sources and measurements:
// design/brief/silvretta.md.

import { smoothRail } from './form.js';

export const MM = 0.001;
export const LENGTH = 4291, WIDTH = 1775, HEIGHT = 1310;
export const WHEELBASE = 2272, FRONT_AXLE_X = 925, REAR_AXLE_X = FRONT_AXLE_X + WHEELBASE;
/** x of the vehicle origin (middle of the wheelbase) in drawing coordinates. */
export const ORIGIN_X = FRONT_AXLE_X + WHEELBASE / 2;

/** Drawing millimetres to vehicle metres. */
export function toCar(x, y, z, out = [0, 0, 0]) { out[0] = z * MM; out[1] = y * MM; out[2] = (ORIGIN_X - x) * MM; return out; }

/**
 * Wheels: 205/55 R 16 on a 7 inch rim in front, 245/45 R 16 on a 9 inch rim behind. lip, bead, dish, bolts, shoulder
 * and grooves size the drawn wheel; rim (inches), rimWidth (inches) and driven describe the axle. axleY is the tyre
 * radius less 5 mm of squash. caliperAngle: degrees from straight ahead towards the top.
 */
const WHEEL_COMMON = { lip: 213, bead: 203, rim: 16, offset: 0 };
export const WHEEL = {
  front: { ...WHEEL_COMMON, track: 1432, tyreWidth: 205, tyreRadius: 316, axleY: 311, rimWidth: 7, driven: false, dish: 40, bolts: 24, shoulder: 24, grooves: 4, caliperAngle: 155 },
  rear: { ...WHEEL_COMMON, track: 1492, tyreWidth: 245, tyreRadius: 313, axleY: 308, rimWidth: 9, driven: true, dish: 95, bolts: 24, shoulder: 26, grooves: 5, caliperAngle: 25 },
};
export const GROUND_CLEARANCE = 160;        // the floor

// ---------------------------------------------------------------- hull control rails
// The hull is a spline surface (form.js) over seventeen control rails, listed from the centre line over the top, down
// the side and under the car. Each line of STATIONS is one cross-section: x, then [z, y] of every rail.
//   C   centre line: bonnet, windscreen, roof, rear window, engine lid
//   A   a third of the way out on the top surfaces
//   E   bonnet shut line in front; outer windscreen and roof; edge of the rear window and of the engine lid
//   V   the valley between bonnet and wing in front; the glass just inside the screen pillar; roof beside the gutter
//   P1, P2  crown of the front wing; the screen pillar and the roof gutter (a close pair: a tight radius); the rear
//       quarter where the roof runs down into the wing
//   G   outer roll of the front wing; middle of the side glass
//   T1, T2  the belt: foot of the side glass and top edge of the door (a close pair: the one hollow corner)
//   H   shoulder under the belt; crest of the rear wing
//   W   the widest line      L   lower side      K   foot of the door
//   S1, S2  bottom edge of the sill (a close pair)      U   under the sill      B   centre of the floor

const SILL = [[792, 198], [766, 164], [600, 160], [0, 160]];
/** The body side at the door, from the belt down: w is the widest half width there (the flank is barrelled in plan). */
const doorSection = (w) => [[674, 874], [684, 862], [w - 46, 790], [w, 640], [w + 6, 490], [w + 1, 310], ...SILL];
const STATIONS = [
  // x      C          A            E            V            P1           P2           G            T1           T2           H            W            L            K            S1 S2 U B
  [90, [0, 512], [210, 512], [420, 510], [455, 510], [480, 510], [510, 509], [543, 497], [555, 478], [557, 465], [559, 440], [560, 400], [558, 330], [555, 280], [548, 200], [525, 170], [450, 160], [0, 160]],
  [230, [0, 595], [240, 593], [440, 588], [466, 584], [536, 556], [628, 550], [702, 534], [716, 512], [718, 495], [720, 465], [722, 415], [720, 340], [716, 285], [708, 200], [683, 170], [590, 160], [0, 160]],
  [290, [0, 622], [245, 620], [445, 615], [468, 612], [548, 590], [634, 596], [726, 590], [744, 562], [747, 545], [749, 510], [750, 450], [748, 350], [744, 288], [736, 200], [711, 170], [600, 160], [0, 160]],
  [350, [0, 648], [248, 646], [448, 640], [470, 640], [524, 714], [634, 727], [736, 712], [752, 634], [755, 608], [756, 565], [757, 495], [755, 365], [751, 290], [743, 200], [718, 170], [600, 160], [0, 160]],
  [410, [0, 672], [250, 670], [450, 664], [474, 662], [540, 758], [636, 810], [731, 758], [753, 667], [757, 643], [758, 605], [760, 535], [758, 390], [754, 295], [746, 200], [721, 170], [600, 160], [0, 160]],
  [500, [0, 698], [258, 696], [462, 688], [489, 688], [555, 759], [640, 816], [727, 767], [755, 694], [761, 670], [769, 622], [772, 548], [769, 395], [765, 295], [757, 198], [732, 168], [600, 160], [0, 160]],
  [600, [0, 728], [265, 726], [475, 716], [518, 714], [604, 764], [676, 818], [745, 778], [770, 710], [774, 688], [790, 640], [806, 555], [808, 410], [806, 298], [798, 196], [772, 165], [600, 160], [0, 160]],
  [760, [0, 767], [278, 765], [498, 754], [556, 752], [630, 792], [690, 831], [750, 804], [778, 746], [786, 720], [812, 664], [826, 566], [826, 405], [822, 297], [816, 196], [790, 163], [600, 160], [0, 160]],
  [925, [0, 806], [290, 803], [520, 792], [592, 790], [656, 816], [704, 843], [752, 826], [786, 776], [800, 746], [824, 690], [836, 575], [836, 410], [832, 298], [822, 196], [796, 163], [600, 160], [0, 160]],
  [1090, [0, 843], [300, 840], [540, 830], [620, 829], [672, 852], [708, 868], [744, 851], [768, 810], [778, 784], [806, 706], [826, 582], [824, 415], [818, 299], [806, 196], [780, 163], [600, 160], [0, 160]],
  [1250, [0, 878], [310, 875], [560, 866], [640, 866], [682, 884], [710, 892], [735, 874], [750, 848], [758, 820], [790, 730], [808, 600], [810, 450], [804, 305], [792, 198], [766, 164], [600, 160], [0, 160]],
  [1400, [0, 908], [320, 905], [570, 896], [655, 895], [686, 908], [704, 911], [718, 897], [728, 876], [736, 852], [784, 758], [805, 620], [809, 470], [804, 308], [792, 198], [766, 164], [600, 160], [0, 160]],
  [1480, [0, 958], [300, 926], [560, 916], [640, 910], [676, 908], [692, 903], [702, 893], [706, 881], [714, 867], [776, 780], [806, 630], [810, 480], [805, 310], [792, 198], [766, 164], [600, 160], [0, 160]],
  [1650, [0, 1057], [250, 1018], [500, 968], [640, 927], [676, 913], [688, 902], [690, 890], [688, 877], [698, 864], [765, 788], [808, 638], [813, 488], [807, 310], [792, 198], [766, 164], [600, 160], [0, 160]],
  [1850, [0, 1170], [243, 1146], [459, 1114], [574, 1085], [625, 1056], [634, 1040], [650, 965], ...doorSection(812)],
  [2090, [0, 1298], [235, 1292], [410, 1280], [495, 1268], [535, 1258], [547, 1238], [605, 1065], ...doorSection(814)],
  [2350, [0, 1310], [235, 1306], [405, 1294], [492, 1281], [527, 1271], [540, 1251], [603, 1068], ...doorSection(815)],
  [2650, [0, 1291], [235, 1286], [400, 1273], [485, 1258], [520, 1248], [533, 1228], [600, 1058], [670, 874], [680, 864], [766, 792], [824, 636], [828, 486], [818, 310], [800, 198], [774, 164], [600, 160], [0, 160]],
  [2780, [0, 1270], [235, 1264], [398, 1250], [478, 1232], [511, 1211], [525, 1191], [592, 1041], [666, 878], [678, 868], [786, 797], [846, 630], [848, 470], [836, 306], [818, 197], [790, 164], [600, 160], [0, 160]],
  [2900, [0, 1235], [235, 1229], [395, 1213], [470, 1190], [503, 1168], [517, 1148], [585, 1020], [662, 882], [674, 872], [816, 812], [868, 622], [868, 450], [858, 302], [846, 197], [818, 164], [600, 160], [0, 160]],
  [3197, [0, 1128], [235, 1120], [390, 1102], [455, 1080], [490, 1055], [510, 1030], [580, 950], [640, 892], [662, 878], [854, 826], [888, 630], [886, 450], [880, 300], [868, 200], [838, 165], [600, 160], [0, 160]],
  [3450, [0, 1034], [235, 1026], [385, 1010], [445, 990], [482, 968], [505, 940], [578, 866], [628, 816], [690, 792], [842, 770], [876, 605], [876, 450], [870, 305], [866, 216], [838, 186], [600, 180], [0, 180]],
  [3650, [0, 953], [235, 946], [385, 932], [450, 915], [490, 895], [520, 872], [590, 815], [650, 778], [706, 756], [824, 726], [872, 580], [868, 450], [856, 332], [842, 286], [812, 262], [600, 258], [0, 258]],
  [3900, [0, 800], [235, 796], [385, 786], [455, 776], [500, 766], [535, 756], [592, 738], [645, 720], [688, 704], [752, 668], [772, 565], [770, 450], [760, 340], [750, 290], [720, 270], [600, 265], [0, 265]],
  [4060, [0, 706], [235, 703], [385, 696], [450, 690], [495, 684], [530, 678], [575, 668], [615, 654], [632, 646], [676, 618], [700, 540], [700, 440], [692, 345], [682, 295], [655, 272], [560, 268], [0, 268]],
  [4130, [0, 664], [235, 662], [385, 657], [445, 652], [485, 648], [515, 644], [555, 637], [590, 627], [604, 620], [642, 596], [663, 520], [662, 430], [655, 345], [645, 295], [620, 272], [540, 268], [0, 268]],
  [4180, [0, 616], [235, 615.5], [380, 614], [440, 613], [478, 612], [505, 611], [540, 608], [572, 601], [584, 596], [620, 574], [640, 505], [640, 420], [632, 345], [622, 295], [600, 272], [530, 268], [0, 268]],
];
/** First and last station of the hull. */

// The front wing is one tube from the lamp to the foot of the screen pillar: between those two sections its rails
// (the valley V, then P1 to T2 over the crown) run dead straight, so the crown has no rise or fall of its own. Only
// the swell over the front wheel, which is drawn on rail H, is passed up the outer side in falling shares.
const WING = { x0: 500, x1: 1400, follow: [0, 0, 0.12, 0.45, 0.65] };
{
  const A = STATIONS.find((st) => st[0] === WING.x0), B = STATIONS.find((st) => st[0] === WING.x1), mix = (p, q, t) => p + (q - p) * t;
  for (const st of STATIONS) {
    if (st[0] <= WING.x0 || st[0] >= WING.x1) continue;
    const t = (st[0] - WING.x0) / (WING.x1 - WING.x0), swell = [st[10][0] - mix(A[10][0], B[10][0], t), st[10][1] - mix(A[10][1], B[10][1], t)];
    st[4] = [mix(A[4][0], B[4][0], t), st[4][1]];
    WING.follow.forEach((f, k) => { st[5 + k] = [mix(A[5 + k][0], B[5 + k][0], t) + f * swell[0], mix(A[5 + k][1], B[5 + k][1], t) + f * swell[1]]; });
  }
}
export const HULL_X0 = STATIONS[0][0], HULL_X1 = STATIONS[STATIONS.length - 1][0];

// ---------------------------------------------------------------- the top of the car, by rule
// A nearly flat panel shows every millimetre of a hand-set station as a wandering highlight, and glass shows it
// twice over. So everything between the centre line and rail V is not drawn station by station but follows three
// surfaces given by rule, each a crowned sweep of one centre profile:
//   the bonnet and cowl   a profile whose slope dies away from the nose
//   the windscreen        a raked, slightly bowed profile swept along a parabola in plan (a leaning cylinder)
//   the roof and tail     the roof line falling to the tail in one run, faired through the stations' centre heights
// The hull is the bonnet or the screen, whichever is higher, under the roof. The stations' columns A and E are no
// longer read; C is read behind the screen header only, V for its z.
const hand = (k, i) => STATIONS.map((st) => [st[0], st[k + 1][i]]);
/** How far a faired rail may leave its stations, mm. */
const FAIR = 2.5;
/** Control rails from the centre line to V, both included. */
const TOP_RAILS = 6;
const SCREEN = { footX: 1470, headX: 2085, headY: 1293.5, slope: [0.64, 0.571], bow: 3.69e-4 };
const tabulate = (slope, x0, y0, step = 5) => {
  const lo = HULL_X0 - 200, n = Math.ceil((HULL_X1 + 200 - lo) / step) + 1, v = new Float64Array(n);
  for (let i = 1; i < n; i++) v[i] = v[i - 1] + step * slope(lo + (i - 0.5) * step);
  const at = (x) => { const u = Math.min(n - 1.001, Math.max(0, (x - lo) / step)), i = Math.floor(u); return v[i] + (v[i + 1] - v[i]) * (u - i); };
  const shift = y0 - at(x0);
  return (x) => at(x) + shift;
};
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** Centre line of the bonnet, running on over the cowl (where it lies flatter). */
const bonnetY = tabulate((x) => 0.205 + 0.47 * Math.exp(-(x - HULL_X0) / 270) - 0.105 * ease((x - 1450) / 100), HULL_X0, 512);
const SCREEN_FOOT_Y = bonnetY(SCREEN.footX);
/** Centre line of the windscreen and its continuation either way. */
const screenY = (u) => { const d = u - SCREEN.footX, L = SCREEN.headX - SCREEN.footX; return SCREEN_FOOT_Y + SCREEN.slope[0] * d - (SCREEN.slope[0] - SCREEN.slope[1]) / (2 * L) * d * d; };
/** Centre line of the roof, rear window and engine lid. */
const roofY = smoothRail([[1900, SCREEN.headY - 37], [SCREEN.headX, SCREEN.headY], ...hand(0, 1).filter((k) => k[0] > 2100)], 5);
/** Crown: how far the surface has fallen at rail V. */
const bonnetCrown = smoothRail([[HULL_X0, 2], [230, 9], [600, 12], [1000, 14], [1470, 13], [HULL_X1, 13]]);
const roofCrown = smoothRail([[HULL_X0, 34], [2090, 35], [2350, 36], [2650, 38], [2900, 45], [3197, 48], [3450, 44], [3650, 38], [3900, 24], [4060, 16], [4130, 12], [HULL_X1, 3]], 2);
const topZ = smoothRail(hand(3, 0), FAIR);
/** Height of the top surface at a plan position inside rail V. */
export function topY(x, z) {
  const q = (z / topZ(x)) ** 2, roof = roofY(x) - roofCrown(x) * q;
  if (x > 2400) return roof;
  return Math.min(roof, Math.max(bonnetY(x) - bonnetCrown(x) * q, screenY(x - SCREEN.bow * z * z)));
}
const sampled = (f) => { const knots = []; for (let x = HULL_X0; x <= HULL_X1 + 1e-6; x += 15) knots.push([x, f(x)]); return smoothRail(knots); };

/** The control rails as smooth functions of x: the top by rule, the rest faired through the stations. */
export const RAILS = [
  ...Array.from({ length: TOP_RAILS }, (_, j) => { const t = j / (TOP_RAILS - 1), z = (x) => t * topZ(x); return { z, y: sampled((x) => topY(x, z(x))) }; }),
  ...Array.from({ length: STATIONS[0].length - 5 }, (_, k) => ({ z: smoothRail(hand(k + 4, 0), FAIR), y: smoothRail(hand(k + 4, 1), FAIR) })),
];
/** Index of each control rail (the top has C, four rails by rule, then V). */
export const RAIL = { C: 0, V: 5, P1: 6, P2: 7, G: 8, T1: 9, T2: 10, H: 11, W: 12, L: 13, K: 14, S1: 15, S2: 16, U: 17, B: 18 };

// ---------------------------------------------------------------- chart rows
/** Chart rows that carry long joints: the roof gutter (crest of the front wing, drip rail, rear deck), the belt (door top, foot of the side glass) and the lower edge of the body side. */
export const GUTTER_ROW = RAIL.P1 + 0.5, BELT_ROW = RAIL.T1 + 0.5, SILL_ROW = RAIL.S2;
/** Chart ranges in which the section's z (plan) or y (side view) is monotone: the top, the side, the cabin's side above the belt, the floor. */
export const ROWS = { top: [0, RAIL.H + 0.6], side: [RAIL.P2, RAIL.S2 + 0.4], glass: [RAIL.P1 - 0.6, RAIL.T2 + 0.4], floor: [RAIL.S2 + 0.4, RAIL.B] };
/** Shut lines are 4.5 mm wide. */
export const GAP = 4.5;

// ---------------------------------------------------------------- coachwork (side view x, y; plan x, z)
/** The painted skin starts here, folded down behind the bumper, and ends here above the lamp band. */
export const NOSE_X = HULL_X0 + 6, TAIL_X = HULL_X1 - 6;
/** Height at which the wings end above the bumpers' sides and their bellows. */
export const NOSE_CUT_Y = 505, TAIL_CUT_Y = 512;
/** Bonnet: its shut line against the wing in plan (it runs on to the door as the wing's inner edge), and its rear edge. */
export const BONNET = { x0: NOSE_X, x1: 1385, shut: [[NOSE_X, 453], [330, 488], [1385, 638], [1470, 650]], corner: 0.030 };
/** Door: straight front shut line, the top on the belt row, a rear shut line that sweeps forward to the sill ahead of the rear wing's flare. */
export const DOOR = { x0: 1470, x1: 2620, bottomY: 322, rear: [[2612, 700], [2585, 560], [2530, 440], [2462, 362], [2400, 322]], corner: 0.012 };
/** Top of the sill under the door, and how far back the rear wing runs down to the hull's lower edge (the rear bumper's bellows begin there). */
export const SILL_TOP_Y = DOOR.bottomY, REAR_SKIRT_X = 3850;
export const FRONT_ARCH = { radius: 355, flare: 70, face: 12, faceZ: 840, linerZ: 480 };
export const REAR_ARCH = { radius: 350, flare: 70, face: 14, faceZ: 887, linerZ: 500 };

/**
 * Windscreen opening in plan: the foot is bowed (base(z)), the sides run up the pillars, the header is nearly
 * straight. Rear window likewise. Side windows in side view: the door's glass between the screen pillar and the
 * door post, and the fixed quarter light behind it.
 */
export const WINDSCREEN = {
  baseX: 1470, bow: 190, bowZ: 690, footZ: 652, headZ: 508, headX: 2085, headBow: 22, corner: 0.045,
  base(z) { return this.baseX + this.bow * (z / this.bowZ) ** 2; }, head(z) { return this.headX + this.headBow * (z / this.headZ) ** 2; },
};
export const REAR_WINDOW = { x0: 2905, z0: 432, x1: 3640, z1: 486, bow: 18, corner: 0.060 };
export const DOOR_GLASS = { foot: 1664, top: [[2117, 1225], [2350, 1234], [2596, 1214]], rearFoot: 2614, corner: 0.035 };
export const QUARTER_LIGHT = { outline: [[2662, 884], [2646, 1206], [2800, 1176], [2990, 1090], [3150, 985], [3215, 920], [3150, 893]], corner: [0.012, 0.03, 0, 0, 0, 0.03, 0.03] };
/** Engine lid in plan. */
export const ENGINE_LID = { x0: 3690, x1: 4100, z: [[3690, 498], [3900, 512], [4100, 492]], corner: 0.035 };

// ---------------------------------------------------------------- lamps
/** Headlamp: centre of the lens, radius of the trim ring's outer edge and of the lens, lean back from upright (degrees). */
export const HEADLAMP = { x: 338, y: 674, z: 622, ring: 108, lens: 89, lean: 27 };

// ---------------------------------------------------------------- bumpers (plan lines x, z; sections o, y)
/**
 * Front bumper: a painted bar standing ahead of the bonnet's edge, with a rubber strip let into its face between the
 * indicators, which wrap its corners; rubber bellows join its ends to the wings. Under it the valance with the fog
 * lamps, and a rubber chin spoiler.
 */
export const FRONT_BUMPER = {
  line: [[0, 0], [4, 210], [22, 400], [60, 540], [114, 630], [192, 706], [290, 753], [400, 773], [490, 782]],
  top: 500, faceTop: 480, bottom: 397, radius: 16, lowRadius: 12,
  strip: { y: [434, 472], proud: 7 }, indicator: { z0: 508, x1: 168, proud: 4 },
  endX: 400, bellowsX: 490, bellowsPitch: 15, bellowsDepth: 7,
  valance: { recess: 26, sideRecess: 13, chinTop: 242, lipY: 176, lip: 6, sideLip: -6 },
  fog: { z: [392, 548], y: [296, 374], depth: 36 },
};
/**
 * Tail: the lamp band stands under the edge of the engine lid and the wings (lamp units round the corners, the
 * reflector between them); under it the bumper, with bellows ahead of its ends, and the valance.
 */
export const TAIL = {
  band: { line: [[4188, 0], [4187, 250], [4186, 440], [4180, 556], [4152, 606], [4110, 646], [4062, 680]], y: [518, 604], lean: 16, lampZ: 388, reverseZ: [516, 552], endX: 4062 },
  line: [[4268, 0], [4266, 250], [4256, 440], [4226, 590], [4160, 682], [4070, 720], [3990, 746], [3850, 794]],
  top: 512, faceTop: 496, bottom: 398, radius: 14, lowRadius: 12,
  strip: { y: [436, 468], proud: 6, z0: 360 }, endX: 3990, bellowsX: 3850, bellowsPitch: 15, bellowsDepth: 7,
  valance: { recess: 22, sideRecess: 10, lipY: 272 },
  guard: { z: [262, 352], y: [372, 530], proud: 23 },
  plate: { width: 305, height: 152, y: 442, frame: 7, proud: 5 },
};

/**
 * Tail spoiler: a tray standing off the engine lid, wider towards the rear, with a turned-up rubber lip along its
 * sides and rear edge; in its top a slatted air intake; under it a riser in the body's colour.
 * x0..x1: front edge on the lid to the lip's rear edge on the centre line; z0, z1: half width in front and behind;
 * stand: height of the front edge over the lid; fall: slope of the top to the rear.
 */
export const SPOILER = {
  x0: 3712, x1: 4208, z0: 565, z1: 705, corner: 110, bow: 22, stand: 16, fall: 0.03, thick: 24, edge: 6,
  lip: { width: 52, rise: 34 }, grille: { x0: 3752, x1: 4040, z: 330, depth: 14, pitch: 24 },
  riser: { x0: 3780, z0: 478, x1: 4126, z1: 440, corner: 50 },
};

// ---------------------------------------------------------------- cabin
/** The cabin between its bulkheads: the scuttle and the wall behind the rear seats. */
export const CABIN = { x0: 1472, x1: 3662 };
