// The swim: a front crawl and a tread, built rather than bought.
//
// No licence we can reach carries a swimming clip — KayKit's 131 clips stop at the water's edge, and the
// mirrors in tools/vendor_models.py have nothing wet either — so the stroke is synthesised here, the way
// tools/make_audio.py synthesises an engine note: from measurements somebody published, written into the
// same channel shape a vendored clip has, so the cast plays it through the same door as everything else.
//
// The numbers, and where they come from:
//   body roll      40-60 degrees to each side, more on the breathing side (Payton 1999: 57 +/- 4 and
//                  66 +/- 5 at 200 m pace; Liu 1993: 51.5-66.0; the coaching literature settles near 45).
//                  This rolls 47 degrees and lets the breath add its own on top.
//   pull:recovery  the underwater phase runs about twice the recovery (1.2-1.3 s against 0.6-0.8 s in the
//                  JOHK front-crawl timing tables), so the pull takes 0.66 of the arm cycle.
//   the catch      an early vertical forearm: 90-110 degrees of elbow through the pull, not a straight arm
//                  dragging (the dropped-elbow error every sports-science survey counts first).
//   incidence      the body lies 3-10 degrees off the surface (Payton 1997, 1999), head at the waterline.
//   the kick       a four-beat flutter: two beats a leg to the arm cycle, knee bent on the up-beat.
//   the breath     the head turns about 90 degrees to one side, once a cycle, in the window of that arm's
//                  recovery — "one eye and the majority of the mouth" out, not a lifted head.
//
// The clip is authored in the *local* space of the KayKit skeleton the cast wears: a channel's rotation
// replaces the bone's bind rotation when the pose is sampled, so a desired world orientation W for a bone
// is written as conj(W of its posed parent) times W, walked down the chain from the hips. The same clip
// therefore retargets onto the player's own rig through bakeClipForRest like any vendored one.

/** Seconds in one full stroke cycle: both arms, four kick beats, one breath. */
export const STROKE_SECONDS = 1.7;
/** Seconds in one cycle of treading water. */
export const TREAD_SECONDS = 2.4;
/** The stroke's own numbers, exported so a test can argue with them. */
export const STROKE = Object.freeze({
  roll: (40 * Math.PI) / 180,          // hips roll amplitude; the shoulders add to ~60 (see below)
  pull: 0.66,                          // fraction of the arm cycle the hand spends underwater
  incidence: (6 * Math.PI) / 180,      // head-up tilt of the laid body off the surface
  catchFlex: (100 * Math.PI) / 180,    // elbow through the pull: the early vertical forearm
  recoverFlex: (45 * Math.PI) / 180,   // elbow at the height of the recovery
  kickBeats: 4,                        // flutter beats per cycle
  kickAmp: (13 * Math.PI) / 180,       // hip swing of one beat
  breathFrom: 0.52, breathTo: 0.74,    // the window of the cycle the head turns in
  breathTurn: (85 * Math.PI) / 180,
});

/** The chain the pose is walked down: bone to the bone it hangs from, in the KayKit skeleton's own names. */
export const PARENTS = Object.freeze({
  hips: null, spine: 'hips', chest: 'spine', head: 'chest',
  'upperarm.l': 'chest', 'lowerarm.l': 'upperarm.l', 'wrist.l': 'lowerarm.l', 'hand.l': 'wrist.l',
  'upperarm.r': 'chest', 'lowerarm.r': 'upperarm.r', 'wrist.r': 'lowerarm.r', 'hand.r': 'wrist.r',
  'upperleg.l': 'hips', 'lowerleg.l': 'upperleg.l', 'foot.l': 'lowerleg.l', 'toes.l': 'foot.l',
  'upperleg.r': 'hips', 'lowerleg.r': 'upperleg.r', 'foot.r': 'lowerleg.r', 'toes.r': 'foot.r',
});
const ORDER = Object.freeze(Object.keys(PARENTS));

// ---- quaternions, the four operations the pose needs -----------------------------------------------------------------
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (a) => [-a[0], -a[1], -a[2], a[3]];
const qnorm = (a) => { const l = Math.hypot(a[0], a[1], a[2], a[3]) || 1; return [a[0] / l, a[1] / l, a[2] / l, a[3] / l]; };
/** Rotation of `angle` about a unit axis. */
export function axisAngle(x, y, z, angle) {
  const h = angle * 0.5, s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
}
const rot = (q, v) => {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [
    v[0] + w * t[0] + (y * t[2] - z * t[1]),
    v[1] + w * t[1] + (z * t[0] - x * t[2]),
    v[2] + w * t[2] + (x * t[1] - y * t[0]),
  ];
};
/**
 * The orientation whose bone axis (+Y) points along `d`, with the bone's hinge (+X) as close to `h` as
 * d allows. A shortest-arc quaternion would leave the twist to chance and the elbow would hinge towards
 * the sky; naming the hinge is what makes a pull look like a pull.
 */
function frameY(d, h) {
  const y = norm3(d);
  let x = [h[0], h[1], h[2]];
  const dot = x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  x = norm3([x[0] - y[0] * dot, x[1] - y[1] * dot, x[2] - y[2] * dot]);
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  // columns x,y,z as a quaternion, by the standard matrix-to-quaternion branch on the trace
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return qnorm(q);
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const smooth = (t) => t * t * (3 - 2 * t);
const bump = (u, a, b) => {           // 0 outside [a,b], 1 in the middle, smooth at both lips
  if (u <= a || u >= b) return 0;
  const mid = (a + b) / 2, half = (b - a) / 2;
  return smooth(1 - Math.abs(u - mid) / half);
};
/** Piecewise-linear table over a phase, wrapping at 1: [[phase, degrees], ...] */
function table(p, rows) {
  for (let i = 0; i < rows.length - 1; i++) {
    const [p0, v0] = rows[i], [p1, v1] = rows[i + 1];
    if (p >= p0 && p <= p1) return v0 + ((v1 - v0) * (p - p0)) / (p1 - p0);
  }
  return rows[rows.length - 1][1];
}
const D = Math.PI / 180;

/**
 * One arm, as a pair of desired world orientations, in the chest's posed frame.
 * @param {number} p     the arm's own phase 0..1: 0 the hand enters, STROKE.pull the hand leaves the water
 * @param {number} side  +1 for the character's left, -1 for the right
 * @param {object} chest the posed world rotation of the chest, so "forward" and "down" mean the swimmer's
 */
function arm(p, side, chest) {
  const pull = STROKE.pull;
  // The sweep angle from overhead, in the chest's sagittal plane: 15 degrees of reach at the entry,
  // straight down at mid-pull, past the hip at the exit, and home over the water through 360.
  const alpha = p < pull ? 15 + (165 - 15) * smooth(p / pull) : 165 + (375 - 165) * smooth((p - pull) / (1 - pull));
  // Wide at the entry, medial through the pull (the hand path crosses under the centreline), elbow out
  // of the water on the recovery: the lateral offset of the upper arm, in chest widths.
  const wide = p < pull ? 0.26 - 0.4 * smooth(Math.min(1, p / (pull * 0.8))) + 0.1 * smooth(p / pull)
    : 0.34 * bump(p, pull, 1) + 0.06;
  const a = alpha * D;
  // chest-local: +Y along the body towards the head of the stroke, +Z the swimmer's face side (the pool
  // floor while prone), +X the character's left. sin(alpha) carries the hand from the surface to the keel.
  const dLocal = norm3([side * wide, Math.cos(a), Math.sin(a)]);
  const flex = table(p, [[0, 160], [0.1, 100], [0.35, 95], [0.6, 120], [pull, 145], [0.78, 45], [0.92, 60], [1, 160]]) * D;
  return { dLocal, flex };
}

/**
 * The front crawl, as one loopable clip.
 * @returns {{name: string, duration: number, channels: object[]}} in the shape cast.js retargets
 */
export function swimClip() {
  const T = STROKE_SECONDS;
  const KEYS = 28;
  const times = new Float32Array(KEYS + 1);
  /** desired world orientation per bone per key, walked down the chain into local rotations below */
  const want = [];
  const trans = new Float32Array((KEYS + 1) * 3);
  for (let k = 0; k <= KEYS; k++) {
    const u = k / KEYS;                       // cycle phase; key KEYS repeats key 0 so the loop closes
    times[k] = u * T;
    const roll = STROKE.roll * Math.sin(2 * Math.PI * u);
    const breath = bump(u, STROKE.breathFrom, STROKE.breathTo);
    // Laid prone: the bone axis (their +Y) swings onto the swim's heading, six degrees of head-up
    // incidence, then rolled about that axis by the stroke, hips leading the shoulders into it.
    const prone = axisAngle(1, 0, 0, Math.PI / 2 - STROKE.incidence);
    const W = {};
    W.hips = qmul(qmul(prone, axisAngle(0, 1, 0, roll)), axisAngle(1, 0, 0, 0.05 * Math.sin(4 * Math.PI * u)));
    W.spine = qmul(W.hips, axisAngle(0, 1, 0, 0.22 * roll));
    W.chest = qmul(W.spine, axisAngle(0, 1, 0, 0.3 * roll));
    // The head stays nearly out of the roll — hips and shoulders roll, the head watches the pool floor —
    // except in the breath window, where it turns about the body's long axis (its own +Y once laid),
    // which is the axis the roll has already put horizontal: a turn, not a lift.
    W.head = qmul(W.chest, axisAngle(0, 1, 0, -1.22 * roll - STROKE.breathTurn * breath));
    for (const [side, tag] of [[1, 'l'], [-1, 'r']]) {
      const p = (u + (tag === 'r' ? 0.5 : 0)) % 1;
      const a = arm(p, side, W.chest);
      const dUpper = rot(W.chest, a.dLocal);
      const hinge = rot(W.chest, [side, 0, 0]);            // the elbow hinges across the body, not along it
      W[`upperarm.${tag}`] = frameY(dUpper, hinge);
      // The hinge axis is the character's own +X on the left and -X on the right, so the *same* bend
      // in chest terms is a signed bend in bone terms: without the side, one arm elbows to the sky.
      W[`lowerarm.${tag}`] = qmul(W[`upperarm.${tag}`], axisAngle(1, 0, 0, side * a.flex));
      W[`wrist.${tag}`] = qmul(W[`lowerarm.${tag}`], axisAngle(1, 0, 0, side * (-0.35 * a.flex + 0.2)));
      W[`hand.${tag}`] = W[`wrist.${tag}`];
      // Flutter: two beats a leg a cycle, out of phase with each other; the knee stores the up-beat and
      // pays it into the down-beat, and the foot stays pointed the whole way round.
      const beat = 2 * Math.PI * (STROKE.kickBeats / 2) * u + (tag === 'r' ? Math.PI : 0);
      const hip = STROKE.kickAmp * Math.sin(beat);
      const knee = (22 + 34 * Math.max(0, -Math.sin(beat))) * D;
      const dLeg = rot(W.hips, norm3([0.06 * side, -Math.cos(hip), Math.sin(hip)]));
      W[`upperleg.${tag}`] = frameY(dLeg, rot(W.hips, [side, 0, 0]));
      W[`lowerleg.${tag}`] = qmul(W[`upperleg.${tag}`], axisAngle(1, 0, 0, side * knee));
      W[`foot.${tag}`] = qmul(W[`lowerleg.${tag}`], axisAngle(1, 0, 0, side * 35 * D));
      W[`toes.${tag}`] = W[`foot.${tag}`];
    }
    want.push(W);
    // A stroke bobs twice a cycle at the hips and once with the breath; the channel is local, and the
    // hips' local frame is the laid body's, so the bob rides its face-up axis.
    trans[k * 3] = 0;
    trans[k * 3 + 1] = 0.012 * Math.sin(4 * Math.PI * u);
    trans[k * 3 + 2] = 0.02 * breath;
  }

  // Walk the chain: a bone's channel is the rotation from its parent's posed world to its own desired
  // world, which is exactly what the sampler multiplies back out when it plays the clip.
  const channels = [];
  for (const name of ORDER) {
    const parent = PARENTS[name];
    const out = new Float32Array((KEYS + 1) * 4);
    for (let k = 0; k <= KEYS; k++) {
      const W = want[k][name];
      const Wp = parent ? want[k][parent] : [0, 0, 0, 1];
      const local = qnorm(qmul(qconj(Wp), W));
      out[k * 4] = local[0]; out[k * 4 + 1] = local[1]; out[k * 4 + 2] = local[2]; out[k * 4 + 3] = local[3];
    }
    channels.push({ name, node: -1, path: 'rotation', input: times, output: { array: out, components: 4 }, interpolation: 'LINEAR' });
  }
  channels.push({ name: 'hips', node: -1, path: 'translation', input: times, output: { array: trans, components: 3 }, interpolation: 'LINEAR' });
  return { name: 'Swim_Free', duration: T, channels, synthesized: 'front crawl, see web/src/core/swimclip.js' };
}

/**
 * Treading water: upright, chin at the surface, hands sculling wide and legs walking on the water. The
 * pose the game holds a man in while he looks about afloat, and the one he drops into when the breath
 * needs saving.
 */
export function treadClip() {
  const T = TREAD_SECONDS;
  const KEYS = 20;
  const times = new Float32Array(KEYS + 1);
  const want = [];
  const trans = new Float32Array((KEYS + 1) * 3);
  for (let k = 0; k <= KEYS; k++) {
    const u = k / KEYS;
    times[k] = u * T;
    const bob = Math.sin(2 * Math.PI * u);
    const W = {};
    W.hips = axisAngle(1, 0, 0, 0.06 * bob);
    W.spine = qmul(W.hips, axisAngle(1, 0, 0, -0.03 * bob));
    W.chest = qmul(W.spine, axisAngle(0, 1, 0, 0.05 * Math.sin(2 * Math.PI * u + 1)));
    W.head = qmul(W.chest, axisAngle(1, 0, 0, -0.06 * bob));
    for (const [side, tag] of [[1, 'l'], [-1, 'r']]) {
      // Sculling: the hands sweep out and in at hip height, palms catching on the out-sweep. Elbows stay
      // near the ribs; it is the forearm and wrist that move water.
      const sc = Math.sin(2 * Math.PI * u + (tag === 'r' ? Math.PI : 0));
      const dUpper = rot(W.chest, norm3([side * 0.75, -0.45, 0.12 * sc]));
      W[`upperarm.${tag}`] = frameY(dUpper, rot(W.chest, [side, 0, 0]));
      W[`lowerarm.${tag}`] = qmul(W[`upperarm.${tag}`], qmul(axisAngle(1, 0, 0, side * (70 + 25 * sc) * D), axisAngle(0, 0, 1, side * 0.3 * sc)));
      W[`wrist.${tag}`] = qmul(W[`lowerarm.${tag}`], axisAngle(1, 0, 0, side * -20 * D));
      W[`hand.${tag}`] = W[`wrist.${tag}`];
      // An egg-beater nobody would believe at this skeleton's budget: alternate circular-ish knee lifts,
      // which from the surface read as a man keeping himself up.
      const lift = Math.max(0, Math.sin(2 * Math.PI * u + (tag === 'r' ? Math.PI : 0)));
      const dLeg = rot(W.hips, norm3([side * 0.22 * lift, -0.85, 0.3 * lift]));
      W[`upperleg.${tag}`] = frameY(dLeg, rot(W.hips, [side, 0, 0]));
      W[`lowerleg.${tag}`] = qmul(W[`upperleg.${tag}`], axisAngle(1, 0, 0, side * (35 + 30 * lift) * D));
      W[`foot.${tag}`] = qmul(W[`lowerleg.${tag}`], axisAngle(1, 0, 0, side * 25 * D));
      W[`toes.${tag}`] = W[`foot.${tag}`];
    }
    want.push(W);
    trans[k * 3] = 0; trans[k * 3 + 1] = 0.045 * bob; trans[k * 3 + 2] = 0;
  }
  const channels = [];
  for (const name of ORDER) {
    const parent = PARENTS[name];
    const out = new Float32Array((KEYS + 1) * 4);
    for (let k = 0; k <= KEYS; k++) {
      const local = qnorm(qmul(qconj(parent ? want[k][parent] : [0, 0, 0, 1]), want[k][name]));
      out[k * 4] = local[0]; out[k * 4 + 1] = local[1]; out[k * 4 + 2] = local[2]; out[k * 4 + 3] = local[3];
    }
    channels.push({ name, node: -1, path: 'rotation', input: times, output: { array: out, components: 4 }, interpolation: 'LINEAR' });
  }
  channels.push({ name: 'hips', node: -1, path: 'translation', input: times, output: { array: trans, components: 3 }, interpolation: 'LINEAR' });
  return { name: 'Swim_Tread', duration: T, channels, synthesized: 'treading water, see web/src/core/swimclip.js' };
}

/** Both clips, in the order the cast should register them. */
export function swimClips() {
  return [swimClip(), treadClip()];
}
