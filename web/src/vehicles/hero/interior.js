// The cabin seen through the glass: a tub (floor, tunnel, inner sills, door cards, bulkhead, dash) that closes the
// car from the inside, two bucket seats, and the driver's controls. The tub and seats are built as the left half and
// mirrored with the body; the controls belong to the left-hand driving position and the centre line and are built once.

import { VEHICLE } from '../../core/ids.js';
import { patch, polygon, region, ringLoft, lathe, box, frame, roundRect, ccw } from './kit/solids.js';
import { roundCorners, densify, leftNormals } from './kit/outline.js';
import * as S from './spec.js';
import { under } from './greenhouse.js';

const MM = S.MM, toCar = S.toCar, K = S.CABIN;
const TAN = [0.78, 0.64, 0.43], TAN_SHADE = [0.62, 0.50, 0.33], BLACK_HIDE = [0.035, 0.034, 0.033], CARPET = [0.05, 0.047, 0.045], PLASTIC = [0.03, 0.03, 0.032];
const LEATHER = 0, PILE = 1, HARD = 2, DIAL = 3;
/** The door card's capping reaches this far either side of the window's lower edge, mm: it ends behind the pane's black border. */
const CARD_TUCK = 18;
const trim = (mb, kind, colour, occlusion = 1) => { mb.material(VEHICLE.INTERIOR, kind, 0); mb.color(colour); mb.occlusion(occlusion); };
/** A direction given in drawing axes (rearward, up, outboard) as a vehicle-frame vector. */
const dir = (dx, dy, dz) => [dz, dy, -dx];
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const steps = (a, b, n) => { const out = []; for (let i = 0; i <= n; i++) out.push(lerp(a, b, i / n)); return out; };

/** Rows along the car through one cross-section: section(x) returns [[z, y]...]. */
const extrude = (xs, section) => xs.map((x) => section(x).map(([z, y]) => toCar(x, y, z)));

/** Floor, tunnel, sill, door card, the under-dash panel, dash and bulkhead of the left half. */
function buildTub(mb, canopy) {
  const xs = steps(K.x0, K.x1, 12), D = K.dash, th = K.tunnelHalf, top = K.tunnelTop;
  trim(mb, PILE, CARPET, 0.55);
  patch(mb, extrude([K.x0, K.x1], () => [[th, K.floorY], [K.sillZ, K.floorY]]), { facing: [0, 1, 0] });
  patch(mb, extrude([K.x0, K.x1], () => [[th, K.floorY], [th, top - 12]]), { facing: [1, 0, 0] });
  patch(mb, extrude([K.x0, K.x1], () => [[K.sillZ, K.floorY], [K.sillZ, K.sillTop - 12]]), { facing: [-1, 0, 0] });
  // under the dash: a plain slope from its lower lip to the floor that closes the footwell
  patch(mb, [[toCar(D.x, D.lip, 0), toCar(D.x, D.lip, D.z)], [toCar(K.x0, K.floorY, 0), toCar(K.x0, K.floorY, D.z)]], { facing: [0, 0.4, -1] });
  // tunnel top and sill top, in hide, each with a rolled edge
  trim(mb, LEATHER, TAN, 0.9);
  patch(mb, extrude([K.x0, K.x1], () => [[th, top - 12], [th - 3, top - 4], [th - 10, top], [0, top]]), { facing: [0, 1, 0], crease: 50 });
  patch(mb, extrude([K.x0, K.x1], () => [[K.sillZ, K.sillTop - 12], [K.sillZ + 3, K.sillTop - 4], [K.sillZ + 10, K.sillTop], [K.cardZ, K.sillTop]]), { facing: [0, 1, 0], crease: 50 });
  // door card: up from the sill, leaning out under the belt, with an armrest roll, and tucked under the skin at the top
  const card = (x) => { const [z, y] = S.RAIL.D(x), arm = 560; return [[K.cardZ, K.sillTop], [K.cardZ + 2, arm - 30], [K.cardZ - 22, arm - 18], [K.cardZ - 26, arm], [K.cardZ - 18, arm + 16], [K.cardZ + 5, arm + 26], [z - 26, y - 16], [z - 3, y - 11], ...[S.SIDE_GLASS.belt - CARD_TUCK, S.SIDE_GLASS.belt + CARD_TUCK].map((up) => { const q = under(canopy, x, canopy.bOf(x, canopy.arcOf(x, 2) - up), 0.014); return [q[0] / MM, q[1] / MM]; })]; };
  patch(mb, extrude(xs, card), { facing: [-1, 0, 0], crease: 50, style: (i, j) => { if (j >= 7) trim(mb, HARD, PLASTIC, 0.5); else trim(mb, LEATHER, j >= 1 && j <= 4 ? TAN_SHADE : TAN, j >= 6 ? 0.6 : 0.9); } });

  // dash: black top running forward under the screen, tan face towards the seats
  const line = [[D.noseX, D.noseY], [1080, 742], [1250, 752], [1440, D.top], [D.x - 22, D.top + 2], [D.x - 8, D.top - 5], [D.x, D.top - 18], [D.x, D.lip]];
  patch(mb, line.map(([x, y]) => [toCar(x, y, 0), toCar(x, y, D.z * 0.5), toCar(x, y, D.z)]), {
    facing: [0, 1, -0.3], crease: 50, style: (i) => { if (i < 5) trim(mb, LEATHER, BLACK_HIDE, 0.9); else trim(mb, LEATHER, TAN, 0.85); },
  });
  // centre console: a slope from the dash down onto the tunnel, with its side cheek
  const cw = th - 10, c0 = [D.x, D.top - 22], c1 = [D.x + 150, top];
  trim(mb, LEATHER, BLACK_HIDE, 0.9);
  patch(mb, [[toCar(c0[0], c0[1], 0), toCar(c0[0], c0[1], cw)], [toCar(c1[0], c1[1], 0), toCar(c1[0], c1[1], cw)]], { facing: [0, 0.5, -1] });
  polygon(mb, [toCar(D.x, top, cw), toCar(c1[0], c1[1], cw), toCar(c0[0], c0[1], cw)]);

  // bulkhead behind the seats, up to the roof lining, with the opening of the rear window
  const plane = (u, v, w = 0) => toCar(K.x1 - w, v, u), R = S.REAR_WINDOW;
  // (the roof is crowned and the lining follows it: a top edge of a few long chords would sag under the lining and
  // let the eye past the bulkhead, so the roof's share of the edge is stepped finely)
  const ROOF_STEPS = 12, crown = Array.from({ length: ROOF_STEPS + 1 }, (_, i) => 0.9 * (1 - i / ROOF_STEPS));
  const roof = [2, 1.6, 1.15, 1.05, 1, 0.95, ...crown].map((b) => { const p = under(canopy, K.x1, b, 0.012); return [p[0] / MM, p[1] / MM]; });
  roof[roof.length - 1][0] = 0;
  // the opening stops short of the lining, which hangs lower than the top of the window recess
  const lining = under(canopy, K.x1, canopy.solve(K.x1, 0, R.halfWidth, 0, 0.9), 0.012)[1] / MM, slotTop = Math.min(R.y[1], lining - 4);
  trim(mb, PILE, CARPET, 0.6);
  region(mb, plane, [[0, K.floorY], [K.cardZ + 20, K.floorY], [K.cardZ + 20, roof[0][1] - 30], ...roof, [0, slotTop], [R.halfWidth, slotTop], [R.halfWidth, R.y[0]], [0, R.y[0]]]);
  // The same wall seen from outside through the window recess. The recess is taller than the opening (its top
  // stands above the lining), so the wall runs up past the recess's top edge, or an eye behind the car would look
  // over it at the back of the bulkhead; there it is still under the roof's skin.
  const behind = (u, v, w = 0) => toCar(K.x1 + w, v, -u), hw = R.halfWidth, y0 = R.y[0], margin = 30, wallTop = R.y[1] + 2;
  trim(mb, HARD, PLASTIC, 0.4);
  region(mb, behind, ccw([[0, y0 - margin], [0, y0], [-hw, y0], [-hw, slotTop], [0, slotTop], [0, wallTop], [-hw - margin, wallTop], [-hw - margin, y0 - margin]]), [], { w: 1 });
}

/**
 * A bucket seat: one skin wrapped along a side-view spine (up the front of the cushion, along it, up the backrest,
 * over the headrest and down the back), raised into side bolsters and pressed into stitched pleats, plus two flat
 * side panels. zc: the seat's centre line.
 */
function buildSeat(mb, zc) {
  const T = K.seat, spine = densify(roundCorners(T.spine, T.radius, { segs: 5 }), 16), normals = leftNormals(spine);
  const topIndex = spine.reduce((best, p, i) => (p[1] > spine[best][1] ? i : best), 0), shoulderY = T.spine[5][1];
  let s = 0; const along = spine.map((p, i) => { if (i) s += Math.hypot(p[0] - spine[i - 1][0], p[1] - spine[i - 1][1]); return s; });
  const cols = [-1, -0.965, -0.84, -0.68, -0.52, -0.3, 0, 0.3, 0.52, 0.68, 0.84, 0.965, 1];
  const rows = spine.map(([x, y], i) => {
    const front = i <= topIndex, head = smooth(shoulderY, shoulderY + 120, y), hw = lerp(T.halfWidth, T.headHalfWidth, smooth(shoulderY, T.spine[7][1], y));
    const upholstered = front && y > K.floorY + 150 ? 1 - head : 0;
    return cols.map((c) => {
      const a = Math.abs(c), bolster = (front ? lerp(T.bolster, 10, head) : 0) * smooth(0.52, 0.84, a), groove = upholstered * (1 - smooth(0.5, 0.68, a)) * 6 * (1 - Math.pow(Math.abs(Math.sin(Math.PI * along[i] / T.pleat)), 0.5));
      const edge = a === 1 ? 9 : a > 0.9 ? 2 : 0, h = bolster - groove - edge;
      return toCar(x + normals[i][0] * h, y + normals[i][1] * h, zc + c * hw);
    });
  });
  trim(mb, LEATHER, TAN, 0.95);
  patch(mb, rows, { flip: true, crease: 55, style: (i) => { mb.occlusion(i > topIndex ? 0.7 : 0.95); } });
  trim(mb, LEATHER, TAN_SHADE, 0.8);
  const last = cols.length - 1;
  polygon(mb, rows.map((r) => r[last]).reverse());
  polygon(mb, rows.map((r) => r[0]));
}

/** Left half of the cabin. canopy: the greenhouse sheet (for the roof line of the bulkhead). */
export function buildCabin(mb, canopy) {
  buildTub(mb, canopy);
  buildSeat(mb, K.seat.z);
}

// ------------------------------------------------------------------------------------------------ driver's controls

/** Instrument binnacle: a hooded wedge on the dash with seven dials, two large and five small. Returns nothing. */
function buildBinnacle(mb) {
  const B = K.binnacle, plane = (u, v, w = 0) => toCar(B.faceX + w, v, -u), wall = 6;
  const face = [[-B.z[1], B.y[0]], [-B.z[0], B.y[0]], [-B.z[0], B.y[1]], [-B.z[1], B.y[1]]], rim = face.map(([u, v]) => [u + Math.sign(u + (B.z[0] + B.z[1]) / 2) * wall, v + (v > B.y[0] ? wall : 0)]);
  trim(mb, HARD, PLASTIC, 0.5);
  region(mb, plane, face);
  ringLoft(mb, plane, face, [[0, 0], [0, B.hood]], { outer: true, crease: 30 });
  trim(mb, LEATHER, BLACK_HIDE, 0.9);
  region(mb, plane, rim, [face], { w: B.hood });
  // outside of the hood: top and two cheeks running forward into the dash top
  const zi = B.z[0] - wall, zo = B.z[1] + wall, yt = B.y[1] + wall, back = B.faceX + B.hood, foot = B.y[0] - 40;   // the foot is sunk in the dash
  patch(mb, [[toCar(back, yt, zi), toCar(back, yt, zo)], [toCar(B.faceX, yt, zi), toCar(B.faceX, yt, zo)], [toCar(B.noseX, B.noseY, zi), toCar(B.noseX, B.noseY, zo)], [toCar(B.noseX, foot, zi), toCar(B.noseX, foot, zo)]], { facing: [0, 1, 0], crease: 15 });
  const cheek = (z) => [toCar(back, foot, z), toCar(back, yt, z), toCar(B.faceX, yt, z), toCar(B.noseX, B.noseY, z), toCar(B.noseX, foot, z)];
  polygon(mb, cheek(zo));
  polygon(mb, cheek(zi).reverse());
  // dials: uv 0..1 across each, a bright bezel around it
  const zc = (B.z[0] + B.z[1]) / 2, yc = (B.y[0] + B.y[1]) / 2;
  const dials = [[-75, 0, 45], [75, 0, 45], [0, 6, 22], [-158, 29, 24], [-158, -29, 24], [158, 29, 24], [158, -29, 24]];
  dials.forEach(([dz, dy, r], k) => {
    const u = -(zc + dz), v = yc + dy;
    mb.material(VEHICLE.INTERIOR, DIAL, k); mb.color(0.9, 0.88, 0.8); mb.occlusion(1);
    const a = mb.vertex(...plane(u - r, v - r, 1.5), 0, 0, -1, 1, 0), b = mb.vertex(...plane(u + r, v - r, 1.5), 0, 0, -1, 0, 0), c = mb.vertex(...plane(u + r, v + r, 1.5), 0, 0, -1, 0, 1), d = mb.vertex(...plane(u - r, v + r, 1.5), 0, 0, -1, 1, 1);
    mb.quad(a, b, c, d);
    mb.material(VEHICLE.CHROME, 50, 0); mb.color(0.8, 0.8, 0.82);
    const ring = []; for (let i = 0; i <= 8; i++) { const t = i / 8 * Math.PI * 2; ring.push([(2.2 - 2.2 * Math.cos(t)) * MM, (r + 2.2 * Math.sin(t)) * MM]); }
    lathe(mb, frame(plane(u, v, 0.5), dir(1, 0, 0), [0, 1, 0]), ring, { segs: 28, crease: 50 });
  });
}

/** Steering wheel on its column: three spokes, a padded hub. Returns nothing. */
function buildSteeringWheel(mb) {
  const W = K.wheel, rake = W.rake * Math.PI / 180, R = W.diameter / 2 - W.tube, axis = dir(Math.cos(rake), Math.sin(rake), 0), up = dir(-Math.sin(rake), Math.cos(rake), 0);
  const centre = toCar(W.topX + Math.sin(rake) * (R + W.tube), W.topY - Math.cos(rake) * (R + W.tube), W.z), m = frame(centre, axis, up);
  const tube = []; for (let i = 0; i <= 10; i++) { const t = i / 10 * Math.PI * 2; tube.push([-W.tube * Math.cos(t) * MM, (R + W.tube * Math.sin(t)) * MM]); }
  trim(mb, LEATHER, BLACK_HIDE, 1);
  lathe(mb, m, tube, { segs: 48, crease: 50 });
  // hub pad and the column running forward into the dash
  lathe(mb, m, [[-0.26, 0.026], [-0.03, 0.026], [-0.03, 0.05], [0.004, 0.05], [0.014, 0.044], [0.016, 0]], { segs: 24, crease: 40, style: (i) => { trim(mb, i < 2 ? HARD : LEATHER, i < 2 ? PLASTIC : BLACK_HIDE, 0.9); } });
  // spokes: left, right and down; flat bars set a little behind the rim
  mb.material(VEHICLE.TRIM_BLACK, 90, 0); mb.color(0.05, 0.05, 0.052); mb.occlusion(1);
  const side = [axis[1] * up[2] - axis[2] * up[1], axis[2] * up[0] - axis[0] * up[2], axis[0] * up[1] - axis[1] * up[0]];
  for (const a of [0, Math.PI, -Math.PI / 2]) {
    const radial = [0, 1, 2].map((k) => side[k] * Math.cos(a) + up[k] * Math.sin(a)), mid = (0.045 + R * MM) / 2;
    box(mb, frame([0, 1, 2].map((k) => centre[k] + radial[k] * mid - axis[k] * 0.004), radial, axis), R * MM - 0.04, 0.005, 0.034);
  }
}

/** Gear lever in its slotted gate on the tunnel. */
function buildGearLever(mb) {
  const G = K.gate, y = K.tunnelTop, plane = (u, v, w = 0) => toCar(G.x - u, y + w, v), a = 4.5, L = 30, p = 24;
  // the slots form one opening: three fore-and-aft lanes joined by a cross lane
  const slots = [[-L, -p - a], [L, -p - a], [L, -p + a], [a, -p + a], [a, -a], [L, -a], [L, a], [a, a], [a, p - a], [L, p - a], [L, p + a], [-L, p + a], [-L, p - a], [-a, p - a], [-a, a], [-L, a], [-L, -a], [-a, -a], [-a, -p + a], [-L, -p + a]];
  const plate = roundRect(-G.length / 2, -G.width / 2, G.length / 2, G.width / 2, 8, 3);
  mb.material(VEHICLE.CHROME, 70, 0); mb.color(0.78, 0.78, 0.8); mb.occlusion(1);
  region(mb, plane, plate, [slots], { w: 4 });
  ringLoft(mb, plane, plate, [[0, 4], [0, 0]], { outer: true });
  mb.material(VEHICLE.TRIM_BLACK, 200, 0); mb.color(0.01, 0.01, 0.01); mb.occlusion(0.2);
  ringLoft(mb, plane, slots, [[0, 4], [0, -14]]);
  region(mb, plane, slots, [], { w: -14 });
  // lever standing in the middle lane, leaning back towards the driver's hand, with a ball knob
  const foot = plane(-8, 0, -10), lean = dir(0.2, 1, 0.1), m = frame(foot, lean, dir(1, 0, 0)), len = 0.17, ball = 0.021;
  mb.material(VEHICLE.CHROME, 40, 0); mb.color(0.85, 0.85, 0.87); mb.occlusion(1);
  lathe(mb, m, [[0, 0.0055], [len, 0.0055]], { segs: 10 });
  trim(mb, HARD, PLASTIC, 1);
  const knob = []; for (let i = 0; i <= 10; i++) { const t = i / 10 * Math.PI; knob.push([len + ball * 0.8 - ball * Math.cos(t), ball * Math.sin(t)]); }
  lathe(mb, m, knob, { segs: 16, crease: 50 });
}

/** Clutch, brake and throttle: rubber pads on bright arms, hanging in the footwell. */
function buildPedals(mb) {
  const P = K.pedals, tilt = dir(-0.45, 1, 0);
  P.z.forEach((z, k) => {
    const pad = toCar(P.x, P.y, z), wide = k === 2 ? 0.04 : 0.06, tall = k === 2 ? 0.11 : 0.07;
    mb.material(VEHICLE.TRIM_BLACK, 200, 0); mb.color(0.03, 0.03, 0.03); mb.occlusion(0.7);
    box(mb, frame(pad, [1, 0, 0], tilt), wide, tall, 0.01);
    mb.material(VEHICLE.CHROME, 90, 0); mb.color(0.6, 0.6, 0.62);
    box(mb, frame([pad[0], pad[1] + 0.11, pad[2] + 0.07], [1, 0, 0], tilt), 0.012, 0.24, 0.008);
  });
}

/** Everything that is not mirrored: binnacle, steering wheel and pedals on the left, gear lever on the centre line. */
export function buildControls(mb) {
  buildBinnacle(mb);
  buildSteeringWheel(mb);
  buildGearLever(mb);
  buildPedals(mb);
}

/** Where the driver's eyes are, vehicle frame. */
export const driverEye = () => toCar(K.eye[0], K.eye[1], K.eye[2]);
