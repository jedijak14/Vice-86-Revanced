// Traffic signals: mast arm, span wire, and post-mounted.
//
// ORIENTATION CONVENTION (the planner and the junction logic rely on it)
//   The prototype serves "approach 0": traffic that arrives travelling from -Z towards +Z, on the right-hand
//   side of the road. The pole stands on the origin, on the FAR-RIGHT corner of the junction as that traffic
//   sees it: the junction lies towards -Z, the carriageway towards +X. The mast arm (or the span wire) reaches
//   along +X over the lanes of approach 0, and its heads face -Z, towards the arriving drivers.
//   Heads marked approach 1 face +X: they serve the cross street's traffic travelling towards -X.
//   The control cabinet stands on the pavement quadrant (-X, +Z) so it is never in a carriageway.
//
// `signalLenses` lists every vehicle lens: { pos, colour 'red' | 'amber' | 'green', facing [x, z], diameter, approach }.
// The lens meshes themselves are dim, unlit glass (LAMP_LENS with intensity 0); the game draws the lit state.
// `pedLenses` lists the pedestrian lenses in the same form with colour 'dontwalk' | 'walk'; `approach` is the
// vehicle approach they run in parallel with (walk while that approach has green).

import { CHANNEL } from '../../core/ids.js';
import { lerp } from '../../core/math.js';
import { place } from './kit.js';
import { C, basePlate, signPlate, rectOutline } from './common.js';
import { signRect } from './atlas.js';

const LENS_D = 0.3, PITCH = 0.355;
const LENSES = [
  { colour: 'red', glass: [0.42, 0.07, 0.06], channel: CHANNEL.SIGNAL_RED },
  { colour: 'amber', glass: [0.45, 0.33, 0.06], channel: CHANNEL.SIGNAL_AMBER },
  { colour: 'green', glass: [0.06, 0.34, 0.26], channel: CHANNEL.SIGNAL_GREEN },
];
const VISOR_BLACK = [0.035, 0.035, 0.04];

/** Domed round lens on the plane z = z0, facing +Z. */
function roundLens(k, y, z0, r) {
  k.lathe([0, y, 0], [0, 0, 1], [[z0, r], [z0 + r * 0.13, r * 0.62], [z0 + r * 0.2, 0]], k.n(10, 6), { crease: 80, up: [0, 1, 0] });
}

/**
 * Three-section vehicle head around its own origin, lenses facing +Z (red on top). The housing is 0.35 wide and
 * 0.2 deep; `backplate` adds the black border plate used on mast arms. Registers its three lenses with the kit.
 */
function vehicleHead(k, { backplate = false, approach = 0 } = {}) {
  const hw = 0.175, front = 0.1;
  LENSES.forEach((lens, i) => {
    const y = (1 - i) * PITCH;
    k.steel(C.signalYellow, 0.45, 0.14);
    const m = k.mark();
    if (k.lod < 2) k.box(-hw, y - PITCH / 2 + 0.003, -front, hw, y + PITCH / 2 - 0.003, front, { axis: 'z' });      // one casting per section: the seams read
    if (k.mid) {
      // tunnel visor: a hood open underneath, longest over the top; black inside so the lens reads in sunlight
      const cols = k.n(6, 4), rows = [[], []], sweep = 2.5;
      for (let j = 0; j <= cols; j++) {
        const a = -sweep + 2 * sweep * j / cols, len = lerp(0.27, 0.1, Math.pow(Math.abs(a) / sweep, 2.2)), r = 0.162, x = Math.sin(a) * r, yy = y + Math.cos(a) * r;
        rows[0].push([x, yy, front]); rows[1].push([x * 1.04, yy - len * 0.06, front + len]);
      }
      const v = k.mark();
      k.loft(rows, { crease: 80 });
      k.twoSided(v, (q) => q.steel(VISOR_BLACK, 0.8, 0.05), 0.004);      // with its rim: the gap between the skins shows edge-on
    }
    k.shade(m, (x, yy, z) => (z > front + 0.02 ? 1 : 0.86));
    k.lens(lens.glass, 0, lens.channel);
    roundLens(k, y, k.lod < 2 ? front + 0.002 : front, LENS_D / 2);
    k.signalLens([0, y, front + 0.03], lens.colour, [0, 1], LENS_D, approach);
  });
  if (k.lod === 2) { k.steel(C.signalYellow, 0.45, 0.14); k.box(-hw, -PITCH * 1.5, -front, hw, PITCH * 1.5, front, { axis: 'z' }); }
  if (backplate && k.mid) {
    // border plate with clipped corners; the housing passes through it
    const w = 0.3, h = PITCH * 1.5 + 0.13, c = 0.07;
    k.steel(VISOR_BLACK, 0.7, 0.1);
    k.extrude([[-w, -h + c], [-w + c, -h], [w - c, -h], [w, -h + c], [w, h - c], [w - c, h], [-w + c, h], [-w, h - c]], [0, 0, -0.012], [1, 0, 0], [0, 1, 0], 0.006);
  }
}

/** Two-section pedestrian head (DONT WALK over WALK), lenses facing +Z. */
function pedHead(k, approach) {
  const hw = 0.21, front = 0.09;
  [['dontwalk', [0.5, 0.2, 0.06]], ['walk', [0.42, 0.44, 0.46]]].forEach(([colour, glass], i) => {
    const y = (0.5 - i) * 0.43;
    k.steel(C.signalYellow, 0.45, 0.14);
    // At the far level there is no hood round the lens, so the lens is the front of the housing itself rather
    // than a panel standing proud of it (whose back would show past the housing's edge).
    k.box(-hw, y - 0.212, -front, hw, y + 0.212, front, { axis: 'z', capB: k.mid });
    if (k.mid) {
      // square hood, open below: one folded sheet so both of its faces stay parallel at the corners
      const d = 0.16, t = 0.19, v = k.mark();
      k.loft([[[-t, y - t * 0.6, front], [-t, y + t, front], [t, y + t, front], [t, y - t * 0.6, front]],
        [[-t, y - t * 0.2, front + d * 0.55], [-t, y + t - 0.01, front + d], [t, y + t - 0.01, front + d], [t, y - t * 0.2, front + d * 0.55]]], { crease: 100 });
      k.twoSided(v, (q) => q.steel(VISOR_BLACK, 0.8, 0.05), 0.004);      // with its rim: the gap between the skins shows edge-on
    }
    k.lens(glass, 0, CHANNEL.ALWAYS);
    if (k.mid) k.panel([0, y, front + 0.003], [1, 0, 0], [0, 1, 0], 0.34, 0.34); else k.panel([0, y, front], [1, 0, 0], [0, 1, 0], hw * 2, 0.424);
    k.signalLens([0, y, front + 0.01], colour, [0, 1], 0.34, approach);
  });
}

/** Tapered round steel signal pole with a bolted base, standing on the origin. */
function signalPole(k, height, r0, r1) {
  const n = k.n(12, 5), m = k.mark();
  k.bare(2, 0.5, C.galv);
  basePlate(k, r0 * 3.4, 0.03, 0, 0.02);
  const ys = k.lod === 2 ? [0.03, height] : [0.03, 0.2, 0.6, height * 0.5, height];
  k.tube(ys.map((y) => [0, y, 0]), ys.map((y) => lerp(r0, r1, y / height)), n, { capB: true });
  if (k.mid) k.lathe([0, 0.03, 0], [0, 1, 0], [[0, r0 + 0.05], [0.025, r0 + 0.045], [0.1, r0 + 0.006], [0.105, r0 * 0.7]], n);      // collar; its top closes in under the pole's flats
  k.ground(m, 0.45, 0.5);
  return (y) => lerp(r0, r1, y / height);
}

/** Vehicle head placed at `pos` facing `yaw` (0 = +Z, PI = -Z, PI/2 = +X) on a rear bracket pipe. */
function mountHead(k, pos, yaw, opts) {
  const h = k.child();
  vehicleHead(h, opts);
  if (h.mid && opts.bracket !== false) {
    // rear pipe with top and bottom elbows: the head is held rigid, as on a mast arm or a pole side
    const top = PITCH * 1.5, z = -0.17;
    h.bare(2, 0.5, C.galv);
    h.tube([[0, top - 0.02, -0.05], [0, top + 0.07, -0.07], [0, top + 0.07, z], [0, -top - 0.07, z], [0, -top - 0.07, -0.07], [0, -top + 0.02, -0.05]], 0.022, 4);
  }
  k.add(h, place(pos[0], pos[1], pos[2], yaw));
}
function mountPed(k, pos, yaw, approach) {
  const h = k.child();
  pedHead(h, approach);
  h.bare(2, 0.5, C.galv);
  if (h.mid) for (const y of [0.3, -0.3]) h.box(-0.03, y - 0.02, -0.26, 0.03, y + 0.02, -0.08, { axis: 'z' });   // clamshell brackets back to the pole
  k.add(h, place(pos[0], pos[1], pos[2], yaw));
}

/** Push button for pedestrians: a small box with a round plunger and a plate above it. */
function pushButton(k, pos, yaw) {
  const h = k.child();
  h.steel(C.signalYellow, 0.5, 0.2); h.box(-0.05, -0.075, 0, 0.05, 0.075, 0.06, { axis: 'z' });
  h.bare(0, 0.3); h.cyl([0, -0.02, 0.06], [0, -0.02, 0.075], 0.022, 0.02, 6, { capB: true });
  h.paint(C.white, 0.5, 0.3); h.box(-0.06, 0.1, 0, 0.06, 0.28, 0.006, { axis: 'z' });
  k.add(h, place(pos[0], pos[1], pos[2], yaw));
}

/** Ground-mounted controller cabinet on a concrete pad, door facing +Z. */
function cabinet(k, x, z) {
  const w = 0.62, d = 0.42, h = 1.25, pad = 0.1, m = k.mark();
  k.concrete(C.concrete, 0, 0.5); k.box(x - w / 2 - 0.08, 0, z - d / 2 - 0.08, x + w / 2 + 0.08, pad, z + d / 2 + 0.08);
  k.bare(1, 0.5, C.alu);
  k.box(x - w / 2, pad, z - d / 2, x + w / 2, pad + h, z + d / 2, { stops: [0.15] });
  k.box(x - w / 2 - 0.03, pad + h, z - d / 2 - 0.03, x + w / 2 + 0.03, pad + h + 0.035, z + d / 2 + 0.05, { r: 0.008 });                      // drip cap
  if (k.near) {
    k.box(x - w / 2 + 0.03, pad + 0.05, z + d / 2, x + w / 2 - 0.03, pad + h - 0.04, z + d / 2 + 0.012, { axis: 'z' });                          // door
    k.bare(0, 0.3); k.box(x + w / 2 - 0.11, pad + 0.55, z + d / 2 + 0.012, x + w / 2 - 0.08, pad + 0.72, z + d / 2 + 0.04, { axis: 'z' });   // handle
    k.steel(C.darkSteel, 0.7, 0.1);
    for (let i = 0; i < 4; i++) k.box(x - w / 2 + 0.1, pad + h - 0.14 - i * 0.035, z + d / 2 + 0.012, x + w / 2 - 0.16, pad + h - 0.125 - i * 0.035, z + d / 2 + 0.018, { axis: 'z' });   // louvres
  }
  k.ground(m, 0.3, 0.5);
}

/** Street-name panel hung under the arm, printed on both sides. */
function armBlade(k, x, y, seed) {
  const rect = signRect('street-name', seed), w = 1.8, h = w / rect.aspect;
  signPlate(k, [x, y - h / 2 - 0.1, 0], [-1, 0, 0], [0, 1, 0], rectOutline(w, h), rect, { backSign: rect, code: 0, thickness: 0.006 });
  if (k.mid) { k.bare(2, 0.5, C.galv); for (const dx of [-0.6, 0.6]) k.box(x + dx - 0.015, y - 0.11, -0.012, x + dx + 0.015, y + 0.02, 0.012); }
}

function mastSignal(k, { arm, heads, seed }) {
  const poleH = 6.9, armY = 6.05, rise = Math.tan(3.5 * Math.PI / 180), radius = signalPole(k, poleH, 0.16, 0.115);
  const armAt = (x) => armY + (x - 0.1) * rise, armR = (x) => lerp(0.1, 0.052, x / arm);
  k.bare(2, 0.5, C.galv);
  const m = k.mark(), xs = k.lod === 2 ? [0.1, arm] : [0.1, 0.5, arm * 0.5, arm];
  k.tube(xs.map((x) => [x, armAt(x), 0]), xs.map(armR), k.n(12, 5), { capA: true, capB: true, up: [0, 1, 0] });      // capped at the pole too: at the far level the arm is as thick as the pole
  if (k.mid) {
    // flange: a clamp plate on the pole and gussets under the arm
    k.box(radius(armY) - 0.01, armY - 0.2, -0.16, radius(armY) + 0.03, armY + 0.2, 0.16, { axis: 'x', r: 0.01 });
    k.extrude([[0, 0], [0.45, 0], [0, -0.38]], [radius(armY) + 0.02, armY - 0.09, -0.008], [1, 0, 0], [0, 1, 0], 0.016);
  }
  k.joint(m, [0.1, armY, 0], 0.5, 0.4);
  for (const x of heads) mountHead(k, [x, armAt(x), -0.24], Math.PI, { backplate: true, approach: 0 });
  // pole-side head for approach 0 and the two pedestrian heads of this corner
  mountHead(k, [0.47, 3.95, 0], Math.PI, { approach: 0, bracket: false });
  if (k.mid) { k.bare(2, 0.5, C.galv); for (const y of [3.95 + PITCH * 1.5 + 0.02, 3.95 - PITCH * 1.5 - 0.02]) k.tube([[0, y, 0], [0.47, y, 0]], 0.022, k.n(6, 4), { capB: true }); }
  mountPed(k, [0, 2.75, -(radius(2.75) + 0.27)], Math.PI, 0);
  mountPed(k, [radius(2.75) + 0.27, 2.75, 0], Math.PI / 2, 1);
  if (k.near) { pushButton(k, [0, 1.1, -radius(1.1) + 0.005], Math.PI); pushButton(k, [radius(1.1) - 0.005, 1.1, 0], Math.PI / 2); }
  armBlade(k, 1.55, armAt(1.55) - armR(1.55), seed);
  cabinet(k, -0.85, 0.5);
}

/** Square prestressed-concrete strain pole with chamfered corners, leaning `lean` radians away from the span. */
function strainPole(k, x, height, lean) {
  const sub = k.child(), ys = sub.lod === 2 ? [-0.1, height] : [-0.1, 0.25, 1, height * 0.5, height], rows = [];
  for (const y of ys) { const h = lerp(0.2, 0.11, y / height), c = h * 0.28; rows.push([[-h + c, y, h], [h - c, y, h], [h, y, h - c], [h, y, -h + c], [h - c, y, -h], [-h + c, y, -h], [-h, y, -h + c], [-h, y, h - c]]); }
  sub.concrete(C.concrete, 0, 0.5);
  const m = sub.mark();
  sub.loft(rows, { closed: true, crease: 30 });
  const top = rows[rows.length - 1];
  for (let i = 1; i < 7; i++) sub.tri(top[0], top[i], top[i + 1]);
  sub.ground(m, 0.5, 0.5);
  if (sub.near) { sub.bare(2, 0.5, C.galv); sub.box(-0.15, height - 0.42, -0.15, 0.15, height - 0.34, 0.15, { r: 0.01 }); }      // strain band
  k.add(sub, place(x, 0, 0, 0, 0, lean));
}

function spanSignal(k, { span, heads, seed }) {
  const poleH = 9.2, lean = 0.035, attach = poleH - 0.38, sag = span * 0.05, headY = 6.05;
  strainPole(k, 0, poleH, lean); strainPole(k, span, poleH, -lean);
  const x0 = -Math.sin(lean) * attach + 0.14, x1 = span + Math.sin(lean) * attach - 0.14, wireY = (x) => { const t = (x - x0) / (x1 - x0); return attach - 4 * sag * t * (1 - t); };
  const steps = k.n(16, 4), wire = [], tether = [];
  for (let i = 0; i <= steps; i++) { const x = lerp(x0, x1, i / steps); wire.push([x, wireY(x), 0]); }
  // the lower tether steadies the heads in wind; it runs nearly straight at the level of their bottoms
  const ty = headY - PITCH * 1.5 - 0.1, tx0 = 0.16, tx1 = span - 0.16;
  for (let i = 0; i <= 2; i++) tether.push([lerp(tx0, tx1, i / 2), ty + (i === 1 ? -0.05 : 0.25), 0]);
  k.bare(2, 0.6, C.darkSteel);
  k.tube(wire, 0.012, 4); k.tube(tether, 0.008, 4);
  for (const f of heads) {
    const x = span * f;
    mountHead(k, [x, headY, 0], Math.PI, { approach: 0, bracket: false });
    k.bare(2, 0.5, C.galv);
    k.cyl([x, headY + PITCH * 1.5, 0], [x, wireY(x), 0], 0.02, 0.02, k.n(6, 4));                                       // drop pipe from the messenger
    if (k.mid) {
      k.box(x - 0.05, wireY(x) - 0.03, -0.02, x + 0.05, wireY(x) + 0.03, 0.02, { axis: 'x' });                        // hanger clamp
      k.cyl([x, ty + 0.02, 0], [x, headY - PITCH * 1.5, 0], 0.014, 0.014, 4);
      if (k.near) { k.rubber(C.black); k.tube([[x + 0.03, wireY(x) - 0.02, 0.01], [x + 0.2, wireY(x) - 0.24, 0.03], [x + 0.05, headY + PITCH * 1.5 + 0.02, 0.02]], 0.008, 4); }   // drip loop of the feed cable
    }
  }
  // the corner's pedestrian heads on the near pole
  mountPed(k, [0, 2.7, -0.44], Math.PI, 0);
  mountPed(k, [0.44, 2.7, 0], Math.PI / 2, 1);
  if (k.near) { pushButton(k, [0, 1.1, -0.185], Math.PI); pushButton(k, [0.185, 1.1, 0], Math.PI / 2); }
  armBlade(k, span * 0.14, wireY(span * 0.14) - 0.02, seed);
  cabinet(k, -0.9, 0.55);
}

function postSignal(k) {
  const h = 3.65, r = 0.057, n = k.n(12, 5), m = k.mark();
  k.bare(2, 0.5, C.galv);
  // cast pedestal base with an access door, then a plain pipe
  k.lathe([0, 0, 0], [0, 1, 0], [[0, 0.2], [0.03, 0.2], [0.06, 0.15], [0.42, 0.105], [0.46, 0.075], [0.46, r * 0.6]], n, { crease: 40 });
  k.cyl([0, 0.3, 0], [0, h, 0], r, r, n, { capB: true });      // starts inside the pedestal, whose top closes in under the pipe's flats
  k.ground(m, 0.4, 0.5);
  if (k.near) { k.box(-0.05, 0.12, 0.1, 0.05, 0.36, 0.125, { axis: 'z', r: 0.006 }); for (let i = 0; i < 4; i++) { const a = Math.PI / 4 + i * Math.PI / 2; k.bolt([Math.cos(a) * 0.16, 0.03, Math.sin(a) * 0.16], [0, 1, 0], 0.018, 0.014); } }
  // post-top head for approach 0, side head for the cross street (its housing clears 2.4 m above the pavement)
  const sideY = 3.02;
  mountHead(k, [0, h + PITCH * 1.5 + 0.09, 0], Math.PI, { approach: 0, bracket: false });
  k.bare(2, 0.5, C.galv); k.cyl([0, h, 0], [0, h + 0.1, 0], 0.075, 0.05, n, { capA: true });      // adapter under the head, wider than the pipe
  mountHead(k, [0.42, sideY, 0.02], Math.PI / 2, { approach: 1, bracket: false });
  if (k.mid) { k.bare(2, 0.5, C.galv); for (const y of [sideY + PITCH * 1.5 + 0.02, sideY - PITCH * 1.5 - 0.02]) k.tube([[0, y, 0.02], [0.42, y, 0.02]], 0.02, k.n(6, 4), { capB: true }); }
  mountPed(k, [0, 2.55, -0.33], Math.PI, 0);
  if (k.near) pushButton(k, [0, 1.1, -r + 0.004], Math.PI);
}

export const SIGNALS = [
  { name: 'signal_mast', nearTess: 1.0, far: [40, 130, 420], footprint: 1.5, collider: { kind: 'cylinder', radius: 0.2, height: 6.9 }, tags: ['signal', 'tall', 'large'], extra: { arm: 9.2 },
    build: (k) => mastSignal(k, { arm: 9.2, heads: [3.3, 6.2, 8.75], seed: 11 }) },
  { name: 'signal_mast_short', nearTess: 1.0, far: [40, 130, 420], footprint: 1.5, collider: { kind: 'cylinder', radius: 0.2, height: 6.9 }, tags: ['signal', 'tall', 'large'], extra: { arm: 6.2 },
    build: (k) => mastSignal(k, { arm: 6.2, heads: [3.1, 5.75], seed: 23 }) },
  { name: 'signal_spanwire', nearTess: 1.0, far: [40, 130, 420], footprint: 1.5, collider: { kind: 'cylinder', radius: 0.24, height: 9.2 }, tags: ['signal', 'tall', 'large'],
    extra: { span: 15, extraColliders: [{ kind: 'cylinder', radius: 0.24, height: 9.2, offset: [15, 0, 0] }] },
    build: (k) => spanSignal(k, { span: 15, heads: [0.27, 0.45], seed: 37 }) },
  { name: 'signal_spanwire_wide', nearTess: 1.0, far: [40, 130, 420], footprint: 1.5, collider: { kind: 'cylinder', radius: 0.24, height: 9.2 }, tags: ['signal', 'tall', 'large'],
    extra: { span: 21, extraColliders: [{ kind: 'cylinder', radius: 0.24, height: 9.2, offset: [21, 0, 0] }] },
    build: (k) => spanSignal(k, { span: 21, heads: [0.2, 0.33, 0.46], seed: 41 }) },
  { name: 'signal_post', nearTess: 1.0, far: [35, 110, 300], footprint: 0.6, collider: { kind: 'cylinder', radius: 0.12, height: 4.7 }, tags: ['signal', 'large'],
    build: postSignal },
];
