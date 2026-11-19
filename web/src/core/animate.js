// Clip sampling, skeleton solving and linear blend skinning.
//
// The rig is solved on the CPU, into the vertex buffer the renderer already uploads, rather than in a
// vertex shader: this renderer's surface programs are procedural and shared by every family in the world
// (deferred G-buffer, shadow runs, reflection probes, the forward glass pass), and a skin block bound in
// all of them is a change to all of them. One place to get wrong instead of five -- and a pedestrian is
// two thousand vertices, not two million, so the arithmetic is affordable where it is easiest to check.
//
// What lives here is plain numbers: no DOM, no GL, no notion of a street. That is what makes the vendored
// clips testable in Node against the real files (test/world/cast.test.mjs).

import { multiply, transformDirection, transformPoint } from './gltf.js';

const scratch = new Float32Array(16);

/** Last key at or before `t`, and the fraction between it and the next one. */
function keyAt(times, t) {
  const last = times.length - 1;
  if (last <= 0) return { index: 0, next: 0, k: 0 };
  if (t <= times[0]) return { index: 0, next: 0, k: 0 };
  if (t >= times[last]) return { index: last, next: last, k: 0 };
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  const span = times[hi] - times[lo];
  return { index: lo, next: hi, k: span > 0 ? (t - times[lo]) / span : 0 };
}

const lerp = (a, b, k) => a + (b - a) * k;

/** The shortest-arc blend of two quaternions, written into `out` at `offset`. */
export function slerpShort(a, ai, b, bi, k, out, offset) {
  let dot = a[ai] * b[bi] + a[ai + 1] * b[bi + 1] + a[ai + 2] * b[bi + 2] + a[ai + 3] * b[bi + 3];
  const flip = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  // nlerp, not true slerp: at the arc lengths a walk cycle uses the difference is under a tenth of a
  // degree, and it costs four multiplies instead of an asin and two sincs per vertex-blending quaternion.
  const w0 = (1 - k), w1 = k * flip;
  const inv = dot > 0.9995 ? 1 : 1 / Math.sqrt(
    (w0 * a[ai] + w1 * b[bi]) ** 2 + (w0 * a[ai + 1] + w1 * b[bi + 1]) ** 2
    + (w0 * a[ai + 2] + w1 * b[bi + 2]) ** 2 + (w0 * a[ai + 3] + w1 * b[bi + 3]) ** 2);
  for (let i = 0; i < 4; i++) out[offset + i] = (w0 * a[ai + i] + w1 * b[bi + i]) * inv;
  return out;
}

/**
 * The pose a clip puts the rig in at `time`: translation, rotation and scale per node, blended from the
 * rest pose by `weight` (1 = the clip alone). `nodes` restricts it to the bones named in `only`, which
 * is how a walk stays in the legs while an aim takes the arms.
 */
export function sampleClip(clip, time, pose, { weight = 1, only = null } = {}) {
  const { translation, rotation, scale, touched } = pose;
  const t = clip.duration > 0 ? ((time % clip.duration) + clip.duration) % clip.duration : 0;
  for (const ch of clip.channels) {
    if (only && !only.has(ch.node)) continue;
    const { index, next, k } = keyAt(ch.input, t);
    const out = ch.output.array, comps = ch.output.components;
    const step = ch.interpolation === 'STEP' || next === index;
    const a = step ? index : index, b = step ? index : next;
    if (ch.path === 'rotation') {
      if (step) { for (let i = 0; i < 4; i++) rotation[ch.node * 4 + i] = out[b * 4 + i]; }
      else if (weight >= 1) slerpShort(out, a * 4, out, b * 4, k, rotation, ch.node * 4);
      else {
        slerpShort(out, a * 4, out, b * 4, k, scratchQuat, 0);
        slerpShort(rotation, ch.node * 4, scratchQuat, 0, weight, rotation, ch.node * 4);
      }
    } else {
      const target = ch.path === 'scale' ? scale : translation;
      const base = ch.node * comps;
      for (let i = 0; i < comps; i++) {
        const v = step ? out[b * comps + i] : lerp(out[a * comps + i], out[b * comps + i], k);
        target[base + i] = weight >= 1 ? v : lerp(target[base + i], v, weight);
      }
    }
    touched.add(ch.node);
  }
  return pose;
}
const scratchQuat = new Float32Array(4);

/**
 * Re-author a clip from another rest pose onto this rig, once, at load: resampled to a fixed rate,
 * each key carrying the rotation that puts our bones where the clip put the reference figure's bones
 * in world space, re-localised into our hierarchy. `corr` is the per-bone constant pair the rigging
 * tool measured: `B`, the reference bone's bind rotation (where a silent channel leaves the bone
 * pointing), and `D`, the rotation from our bone's offset onto theirs (the difference between rests).
 * Without this a clip authored against a T-pose would swing an A-posed figure from the wrong start.
 */
export function bakeClipForRest(clip, corr, rig, fps = 30) {
  const { gltf, parents } = rig;
  const names = gltf.nodes.map((n) => n.name);
  const rotCh = new Map();
  const trCh = new Map();
  for (const ch of clip.channels) {
    if (ch.path === 'rotation') rotCh.set(ch.node, ch);
    else if (ch.path === 'translation') trCh.set(ch.node, ch);
  }
  const jointNodes = rig.joints.slice();
  const localAt = (ch, t, out) => {
    const { index, next, k } = keyAt(ch.input, t);
    const a = ch.output.array;
    const comps = ch.output.components;
    if (ch.path === 'rotation') {
      if (next === index) for (let i = 0; i < 4; i++) out[i] = a[index * 4 + i];
      else slerpShort(a, index * 4, a, next * 4, k, out, 0);
    } else {
      for (let i = 0; i < comps; i++) out[i] = a[index * comps + i] * (1 - k) + a[next * comps + i] * k;
    }
    return out;
  };
  const steps = Math.max(1, Math.ceil(clip.duration * fps));
  const times = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) times[i] = (clip.duration * i) / steps;
  const Mq = new Float32Array(gltf.nodes.length * 4);
  const Mp = new Float32Array(gltf.nodes.length * 4);
  const Dq = new Float32Array(gltf.nodes.length * 4);
  const local = new Float32Array(4);
  const fixed = new Float32Array(4);
  const out = {};
  for (const node of jointNodes) {
    out[node] = { rot: new Float32Array((steps + 1) * 4), tr: null };
    const c = corr[names[node]] || {};
    const d = c.D || [0, 0, 0, 1];
    Dq.set(d, node * 4);
  }
  const trNodes = [...trCh.keys()].filter((n) => jointNodes.includes(n));
  const trOut = new Map(trNodes.map((n) => [n, new Float32Array((steps + 1) * 3)]));
  const tq = new Float32Array(3);
  for (let s = 0; s <= steps; s++) {
    const t = times[s];
    for (const i of rig.order) {
      const name = names[i];
      const c = corr[name] || {};
      const ch = rotCh.get(i);
      if (ch) localAt(ch, t, local);
      else { const b = c.B || [0, 0, 0, 1]; local.set(b); }
      if (!jointNodes.includes(i)) { Mq[i * 4 + 3] = 1; Mp[i * 4 + 3] = 1; continue; }
      const p = parents[i];
      const pq = p >= 0 ? Mq.subarray(p * 4, p * 4 + 4) : IDENTITY_QUAT;
      qmulInto(pq, local, Mq, i * 4);                       // the reference figure's world rotation here
      qmulInto(Mq.subarray(i * 4, i * 4 + 4), Dq.subarray(i * 4, i * 4 + 4), Mp, i * 4);  // ...carried onto our rest
      const pp = p >= 0 ? Mp.subarray(p * 4, p * 4 + 4) : IDENTITY_QUAT;
      qconjMulInto(pp, Mp.subarray(i * 4, i * 4 + 4), out[i].rot, s * 4);   // re-localised in our hierarchy
    }
    for (const n of trNodes) {
      localAt(trCh.get(n), t, tq);
      const c = corr[names[n]] || {};
      const off = c.t || [0, 0, 0];
      trOut.get(n)[s * 3] = tq[0] + off[0];
      trOut.get(n)[s * 3 + 1] = tq[1] + off[1];
      trOut.get(n)[s * 3 + 2] = tq[2] + off[2];
    }
  }
  const channels = [];
  for (const node of jointNodes) {
    channels.push({ node, path: 'rotation', input: times, output: { array: out[node].rot, components: 4 }, interpolation: 'LINEAR' });
  }
  for (const n of trNodes) {
    channels.push({ node: n, path: 'translation', input: times, output: { array: trOut.get(n), components: 3 }, interpolation: 'LINEAR' });
  }
  return { name: clip.name, duration: clip.duration, channels, sourceNodes: null, baked: true };
}

const IDENTITY_QUAT = new Float32Array([0, 0, 0, 1]);

function qmulInto(a, b, out, offset) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[offset] = aw * bx + ax * bw + ay * bz - az * by;
  out[offset + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[offset + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[offset + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

function qconjMulInto(a, b, out, offset) {
  fixedConj[0] = -a[0]; fixedConj[1] = -a[1]; fixedConj[2] = -a[2]; fixedConj[3] = a[3];
  qmulInto(fixedConj, b, out, offset);
}
const fixedConj = new Float32Array(4);

/** A pose: the rest transform of every node, and the places a clip has changed it. */
export function createPose(gltf) {
  const count = gltf.nodes.length;
  const pose = {
    count,
    translation: new Float32Array(count * 3),
    rotation: new Float32Array(count * 4),
    scale: new Float32Array(count * 3),
    touched: new Set(),
  };
  resetPose(gltf, pose);
  return pose;
}

/** Back to the model as authored: what a pose looks like with no clip on it. */
export function resetPose(gltf, pose) {
  pose.touched.clear();
  for (let i = 0; i < pose.count; i++) {
    const n = gltf.nodes[i] || {};
    const t = n.translation || [0, 0, 0], r = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    pose.translation.set(t, i * 3);
    pose.rotation.set(r, i * 4);
    pose.scale.set(s, i * 3);
  }
  return pose;
}

/**
 * A skinned model, solved per frame: `bones()` gives the matrix each joint multiplies its vertices by,
 * in the model's own units and space. The world matrix of the person (where they stand, which way they
 * face) is the renderer's business, applied on top of what comes out of here.
 */
export class Rig {
  constructor(gltf, skinIndex = 0) {
    const skin = gltf.skin(skinIndex);
    if (!skin) throw new Error('Rig: the model has no skin.');
    this.gltf = gltf;
    this.joints = skin.joints;
    this.inverseBind = skin.inverseBindMatrices || new Float32Array(skin.joints.length * 16);
    this.worlds = new Float32Array(gltf.nodes.length * 16);
    this.bones = new Float32Array(skin.joints.length * 16);
    this.local = new Float32Array(16);
    this.byName = new Map();
    gltf.nodes.forEach((n, i) => { if (n.name && !this.byName.has(n.name)) this.byName.set(n.name, i); });
    this.order = gltf.orderedNodes();
    const parents = new Int32Array(gltf.nodes.length).fill(-1);
    gltf.nodes.forEach((n, i) => { for (const c of n.children || []) parents[c] = i; });
    this.parents = parents;
  }

  /** The node index of a bone by its glTF name, or -1. */
  node(name) { return this.byName.has(name) ? this.byName.get(name) : -1; }

  /** Indices of the named bones, for layering one clip over another. */
  nodes(names) { const s = new Set(); for (const n of names) { const i = this.node(n); if (i >= 0) s.add(i); } return s; }

  /**
   * Compose the pose into node matrices, then into skinning matrices.
   * `height` scales the whole figure about its feet, because the packs are not all authored to the same
   * metre, and a pedestrian who is 2.3 m tall on the pavement is a bug rather than a style. It scales
   * about the feet by scaling the heights about y = 0, which is where a pack puts the ground.
   */
  solve(pose, out = this.bones, height = 1) {
    const { gltf, parents, order, local, worlds } = this;
    const scaleFromFeet = height !== 1;
    for (const i of order) {
      const t = [pose.translation[i * 3], pose.translation[i * 3 + 1], pose.translation[i * 3 + 2]];
      const r = [pose.rotation[i * 4], pose.rotation[i * 4 + 1], pose.rotation[i * 4 + 2], pose.rotation[i * 4 + 3]];
      const s = [pose.scale[i * 3], pose.scale[i * 3 + 1], pose.scale[i * 3 + 2]];
      const p = parents[i];
      // Heights are not applied here, bone by bone: a figure is posed in its own authored metres and the
      // scale goes on once, on the way out, where it cannot drift between a parent and its child.
      composeInto(local, t, r, s, gltf, i);
      if (p < 0) worlds.set(local, i * 16);
      else multiply(worlds, p * 16, local, 0, worlds, i * 16);
    }
    for (let j = 0; j < this.joints.length; j++) {
      const node = this.joints[j];
      // Bone matrices are world × inverse bind: what a vertex weighted to this joint is multiplied by.
      multiply(worlds, node * 16, this.inverseBind, j * 16, out, j * 16);
      // The y translation only, so limbs stay rigid and only the figure's stature changes. No correction
      // is owed for where the feet are: a pack's origin is the ground under it, so scaling the heights
      // about y = 0 is scaling about the soles, which is what keeps a tall pedestrian standing on the
      // pavement rather than an inch above it.
      if (scaleFromFeet) out[j * 16 + 13] *= height;
    }
    return out;
  }

  /** The rest pose's joint matrices, for a figure that is not animated (a body in a chair, a corpse). */
  restBones(out = this.bones) {
    const gltf = this.gltf;
    const pose = resetPose(gltf, { count: gltf.nodes.length, translation: new Float32Array(gltf.nodes.length * 3), rotation: new Float32Array(gltf.nodes.length * 4), scale: new Float32Array(gltf.nodes.length * 3), touched: new Set() });
    return this.solve(pose, out, 1);
  }
}

function composeInto(out, t, r, s, gltf, node) {
  const n = gltf.nodes[node] || {};
  if (n.matrix && !t) return out.set(n.matrix);
  const x = r[0], y = r[1], z = r[2], w = r[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = (1 - (yy + zz)) * s[0]; out[1] = (xy + wz) * s[0]; out[2] = (xz - wy) * s[0]; out[3] = 0;
  out[4] = (xy - wz) * s[1]; out[5] = (1 - (xx + zz)) * s[1]; out[6] = (yz + wx) * s[1]; out[7] = 0;
  out[8] = (xz + wy) * s[2]; out[9] = (yz - wx) * s[2]; out[10] = (1 - (xx + yy)) * s[2]; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}

/**
 * Linear blend skinning, four influences a vertex, in place over `base`.
 *
 * `joints` and `weights` are the glTF streams: four indices, four bytes of weight (0..255) that may not
 * sum to 1 -- an authored file rounds its last influence off -- so the sum is taken per vertex and the
 * blend is divided by it. That is what makes a badly exported pack look right instead of collapsing.
 */
export function skinVertices(base, joints, weights, bones, outPosition, outNormal) {
  const p = scratchPoint, n = scratchNormal;
  for (let v = 0, count = base.position.length / 3; v < count; v++) {
    let x = 0, y = 0, z = 0, nx = 0, ny = 0, nz = 0, sum = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights[v * 4 + k] / 255;
      if (w <= 0) continue;
      const j = joints[v * 4 + k] * 16;
      transformPoint(bones, j, base.position[v * 3], base.position[v * 3 + 1], base.position[v * 3 + 2], p);
      transformDirection(bones, j, base.normal[v * 3], base.normal[v * 3 + 1], base.normal[v * 3 + 2], n);
      x += p[0] * w; y += p[1] * w; z += p[2] * w;
      nx += n[0] * w; ny += n[1] * w; nz += n[2] * w;
      sum += w;
    }
    if (sum <= 0) {                                            // an unweighted vertex: leave it where it was authored
      outPosition[v * 3] = base.position[v * 3]; outPosition[v * 3 + 1] = base.position[v * 3 + 1]; outPosition[v * 3 + 2] = base.position[v * 3 + 2];
      outNormal[v * 3] = base.normal[v * 3]; outNormal[v * 3 + 1] = base.normal[v * 3 + 1]; outNormal[v * 3 + 2] = base.normal[v * 3 + 2];
      continue;
    }
    const inv = 1 / sum;
    outPosition[v * 3] = x * inv; outPosition[v * 3 + 1] = y * inv; outPosition[v * 3 + 2] = z * inv;
    const len = Math.hypot(nx * inv, ny * inv, nz * inv) || 1;
    outNormal[v * 3] = nx * inv / len; outNormal[v * 3 + 1] = ny * inv / len; outNormal[v * 3 + 2] = nz * inv / len;
  }
  return { outPosition, outNormal };
}
const scratchPoint = new Float32Array(3), scratchNormal = new Float32Array(3);

/**
 * One person's animation clock.
 *
 * A walk is driven by the ground covered rather than by wall time: the playhead moves
 * `metres / stride` of a cycle per frame, so a pedestrian who is slowed by a crowd or pushed along by a
 * slope keeps their feet under them instead of ice-skating. A one-shot (a shot fired, a punch taken) has
 * no distance to be measured against and runs on the clock, once.
 */
export class Player {
  constructor(rig, pose, clips = []) {
    this.rig = rig;
    this.pose = pose;
    this.byName = new Map(clips.map((c) => [c.name, c]));
    /** Metres one cycle of a locomotion clip is worth; 0 makes the clip run on the clock instead. */
    this.stride = 1;
    this.main = null;
    this.time = 0;
    this.over = null;                  // { clip, bones, weight, once }
    this.overTime = 0;
    this.blend = 0;                    // 0..1 cross-fade between the previous clip and the new one
    this.previous = null;
    this._fadeSeconds = 0.22;
    /** Radians of forward lean at the hips, set by whoever owns the body: a runner leans, a walker barely. */
    this.lean = 0;
  }

  has(name) { return this.byName.has(name); }
  clip(name) { return this.byName.get(name) || null; }

  /**
   * Switch the body's locomotion. Same clip and no stride change is a no-op, which is what keeps a
   * pedestrian who wobbles between walk and run from restarting the cycle every frame.
   */
  play(name, { stride = null, restart = false } = {}) {
    const clip = name ? this.byName.get(name) || null : null;
    if (stride !== null) this.stride = stride;
    if (this.main && clip && this.main.name === clip.name && !restart) return this;
    this.previous = this.main;
    this.blend = this.main && clip ? 0 : 1;
    this.main = clip;
    if (restart || !clip) this.time = 0;
    return this;
  }

  /** A second clip over some bones only -- aim over a walk, a hit over an idle. */
  layer(name, bones, { weight = 1, once = false, restart = false } = {}) {
    const clip = name ? this.byName.get(name) || null : null;
    if (!clip) { this.over = null; return this; }
    if (this.over && this.over.clip.name === clip.name && !restart) return this;
    this.over = { clip, bones, weight, once, held: false };
    if (restart) this.overTime = 0;
    return this;
  }

  /** The arms and shoulders, which is what an aim or a gesture is allowed to move. */
  upperBody() {
    if (!this._upper) {
      const names = ['spine', 'chest', 'head', 'upperarm.l', 'lowerarm.l', 'wrist.l', 'hand.l', 'handslot.l',
        'upperarm.r', 'lowerarm.r', 'wrist.r', 'hand.r', 'handslot.r'];
      this._upper = this.rig.nodes(names);
    }
    return this._upper;
  }

  /** Seconds of game time and metres travelled. Call once per person per frame. */
  update(dt, metres = 0) {
    if (this.blend < 1) this.blend = Math.min(1, this.blend + dt / this._fadeSeconds);
    if (this.main) {
      this.time += this.stride > 0 && this.main.duration > 0
        ? (metres / this.stride) * (this.main.duration || 1)
        : dt;
    }
    if (this.over) {
      this.overTime += dt;
      if (this.over.once && this.overTime >= this.over.clip.duration) {
        this.overTime = Math.min(this.overTime, this.over.clip.duration);   // hold the last frame
        this.over.held = true;
      }
    }
    return this;
  }

  /** Whether a one-shot on top has finished, so the caller can stop asking for it. */
  layerFinished() { return !this.over || this.over.held; }
  clearLayer() { this.over = null; this.overTime = 0; return this; }

  /** Solve the rig: pose is rebuilt from rest every frame, which is what makes a dropped clip impossible to stick. */
  solve(height = 1) {
    const pose = resetPose(this.rig.gltf, this.pose);
    if (this.lean) {
      // A body that leans is one the clip cannot know about: the lean is the owner's, added at the hips
      // in local space, so a runner tips into his stride whatever the clip's own posture says.
      const i = this.rig.node('hips');
      if (i >= 0) {
        const h = this.lean * 0.5, sl = Math.sin(h), cl = Math.cos(h);
        const q = [sl, 0, 0, cl];
        const o = i * 4;
        const x = pose.rotation[o], y = pose.rotation[o + 1], z = pose.rotation[o + 2], w = pose.rotation[o + 3];
        pose.rotation[o] = q[3] * x + q[0] * w + q[1] * z - q[2] * y;
        pose.rotation[o + 1] = q[3] * y - q[0] * z + q[1] * w + q[2] * x;
        pose.rotation[o + 2] = q[3] * z + q[0] * y - q[1] * x + q[2] * w;
        pose.rotation[o + 3] = q[3] * w - q[0] * x - q[1] * y - q[2] * z;
      }
    }
    if (this.previous && this.blend < 1) {
      sampleClip(this.previous, this.time, pose, { weight: 1 - this.blend });
      if (this.main) sampleClip(this.main, this.time, pose, { weight: this.blend });
    } else if (this.main) {
      sampleClip(this.main, this.time, pose, { weight: 1 });
    }
    if (this.over) sampleClip(this.over.clip, this.overTime, pose, { weight: this.over.weight, only: this.over.bones });
    return this.rig.solve(pose, this.rig.bones, height);
  }
}
