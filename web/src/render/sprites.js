// Things drawn on top of the lit scene that are not surfaces: glow sprites, particles and exhaust flames.

import { GLOW_STRIDE, LIGHT_STRIDE } from '../core/ids.js';
import { sphereVisible } from './cull.js';

const GLOW_BYTES = GLOW_STRIDE * 4;
/** Dynamic glows accepted per frame (vehicle lamps, signals). */
const MAX_DYNAMIC_GLOWS = 1024;
/** Static glow sets further away than this are not drawn. */
const GLOW_RANGE = 2600;

// ---------------------------------------------------------------------------------------------- glows
export class Glows {
  constructor(ctx) {
    this.ctx = ctx; this.sets = new Map();
    this.stream = new Float32Array(MAX_DYNAMIC_GLOWS * GLOW_STRIDE);
    this.drawn = 0;          // sprites in the main image this frame
    // True while a closed room is shown: the glows of the city's tiles belong to the street and stay dark,
    // only the frame's own glows are drawn (set by the renderer before the first view of a frame).
    this.interior = false;
    this._staged = 0;
    this._offset = new Float32Array(3);
    this._allocate();
  }

  _vertexArray(buffer) {
    const gl = this.ctx.gl, vao = gl.createVertexArray();
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, GLOW_BYTES, 0); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, GLOW_BYTES, 16); gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  _allocate() {
    const gl = this.ctx.gl;
    this.streamBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.streamBuffer); gl.bufferData(gl.ARRAY_BUFFER, this.stream.byteLength, gl.DYNAMIC_DRAW);
    this.streamVao = this._vertexArray(this.streamBuffer);
  }

  _upload(set) {
    const gl = this.ctx.gl;
    set.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, set.buffer); gl.bufferData(gl.ARRAY_BUFFER, set.records, gl.STATIC_DRAW);
    set.vao = this._vertexArray(set.buffer);
  }

  /**
   * Replace the static glows of one key (a tile). glows: world-space records or null. lights: the light
   * records set with them; a glow takes the seed of the light at its position, so a lamp's halo strikes
   * and flickers together with its light and its lens.
   */
  set(key, glows, lights) {
    const gl = this.ctx.gl, old = this.sets.get(key);
    if (old) { gl.deleteVertexArray(old.vao); gl.deleteBuffer(old.buffer); this.sets.delete(key); }
    const count = glows ? Math.floor(glows.length / GLOW_STRIDE) : 0;
    if (!count) return;
    const lightCount = lights ? Math.floor(lights.length / LIGHT_STRIDE) : 0;
    const ox = glows[0], oy = glows[1], oz = glows[2], records = new Float32Array(count * GLOW_STRIDE);
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < count; i++) {
      const o = i * GLOW_STRIDE, x = glows[o], y = glows[o + 1], z = glows[o + 2];
      let seed = 0, nearest = 0.3 * 0.3;
      for (let k = 0; k < lightCount; k++) {
        const l = k * LIGHT_STRIDE, dx = lights[l] - x, dy = lights[l + 1] - y, dz = lights[l + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < nearest) { nearest = d2; seed = lights[l + 14]; }
      }
      records[o] = x - ox; records[o + 1] = y - oy; records[o + 2] = z - oz; records[o + 3] = glows[o + 3];
      records[o + 4] = glows[o + 4]; records[o + 5] = glows[o + 5]; records[o + 6] = glows[o + 6];
      // The seed rides in the fraction of the code.
      records[o + 7] = Math.round(glows[o + 7]) + Math.min(0.998, Math.max(0, seed));
      minx = Math.min(minx, x); miny = Math.min(miny, y); minz = Math.min(minz, z); maxx = Math.max(maxx, x); maxy = Math.max(maxy, y); maxz = Math.max(maxz, z);
    }
    const set = { records, count, ox, oy, oz, cx: (minx + maxx) / 2, cy: (miny + maxy) / 2, cz: (minz + maxz) / 2, radius: 0.5 * Math.hypot(maxx - minx, maxy - miny, maxz - minz) + 1, buffer: null, vao: null };
    this._upload(set);
    this.sets.set(key, set);
  }

  /**
   * Hand over this frame's moving glows (world-space records): uploaded once, relative to the camera,
   * and then drawn by every view of the frame (probe faces, road mirror, the main image).
   */
  stage(cam, dynamic, dynamicCount) {
    const gl = this.ctx.gl, n = dynamic ? Math.min(dynamicCount | 0, MAX_DYNAMIC_GLOWS) : 0;
    this._staged = n;
    if (n <= 0) return;
    const stream = this.stream;
    for (let i = 0; i < n; i++) {
      const o = i * GLOW_STRIDE;
      stream[o] = dynamic[o] - cam[0]; stream[o + 1] = dynamic[o + 1] - cam[1]; stream[o + 2] = dynamic[o + 2] - cam[2];
      stream[o + 3] = dynamic[o + 3]; stream[o + 4] = dynamic[o + 4]; stream[o + 5] = dynamic[o + 5]; stream[o + 6] = dynamic[o + 6]; stream[o + 7] = dynamic[o + 7];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.streamBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, stream, 0, n * GLOW_STRIDE);
  }

  /**
   * Draw all glows additively. program: a glow program, already in use with its uniforms set.
   * cam: world camera position; planes: camera-relative frustum planes of the view being drawn;
   * range: static sets further from the camera than this are left out. Returns the number of sprites.
   */
  draw(program, cam, planes, range = GLOW_RANGE) {
    const gl = this.ctx.gl, offset = this._offset, loc = program.loc('uOffset');
    let drawn = 0;
    for (const set of this.sets.values()) {
      if (this.interior) break;
      const x = set.cx - cam[0], y = set.cy - cam[1], z = set.cz - cam[2];
      if (Math.hypot(x, y, z) - set.radius > range || !sphereVisible(planes, x, y, z, set.radius, 5)) continue;
      offset[0] = set.ox - cam[0]; offset[1] = set.oy - cam[1]; offset[2] = set.oz - cam[2];
      gl.uniform3fv(loc, offset);
      gl.bindVertexArray(set.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, set.count);
      drawn += set.count;
    }
    if (this._staged > 0) {
      offset[0] = offset[1] = offset[2] = 0; gl.uniform3fv(loc, offset);
      gl.bindVertexArray(this.streamVao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this._staged);
      drawn += this._staged;
    }
    gl.bindVertexArray(null);
    return drawn;
  }

  restore() { this._allocate(); for (const set of this.sets.values()) this._upload(set); }
}

// ---------------------------------------------------------------------------------------------- particles
// What each kind of particle is. Sizes in metres, speeds in m/s, life in seconds.
//   rise: vertical acceleration (negative = falls); drag: per second; follow: share of the emitter's velocity kept;
//   emit: emitted radiance as a multiple of the colour (sparks glow, smoke does not).
//   mist: 1 for water hanging in the air (drawn as a smooth haze that lamps barely tint) rather than billowing smoke.
//   streak: seconds of its own flight a sprite is drawn out over. A sprite of spray stands for the sheet of
//   droplets the tyre shed since the sprite before it, which is a ribbon along the travel, not a ball.
const KINDS = {
  // Tyre spray is a low fan of mist dragged along behind the wheel: many faint sprites, never separate puffs.
  spray: { colour: [0.72, 0.76, 0.8], alpha: 0.1, size: [0.3, 1.9], life: [0.55, 1.0], up: 0.7, spread: 0.8, rise: -0.5, drag: 1.4, follow: 0.42, soft: 0.8, emit: 0, mist: 1, streak: 0.035 },
  smoke: { colour: [0.78, 0.78, 0.8], alpha: 0.3, size: [0.35, 2.6], life: [1.3, 2.2], up: 0.7, spread: 0.7, rise: 0.5, drag: 1.3, follow: 0.18, soft: 0.6, emit: 0 },
  dust: { colour: [0.56, 0.47, 0.35], alpha: 0.22, size: [0.3, 2.1], life: [1.1, 1.9], up: 0.8, spread: 0.9, rise: -0.1, drag: 1.1, follow: 0.25, soft: 0.6, emit: 0 },
  splash: { colour: [0.74, 0.79, 0.84], alpha: 0.34, size: [0.1, 0.5], life: [0.3, 0.55], up: 2.6, spread: 1.6, rise: -9.8, drag: 0.4, follow: 0.35, soft: 0.2, emit: 0 },
  spark: { colour: [1.0, 0.55, 0.16], alpha: 1, size: [0.022, 0.01], life: [0.25, 0.7], up: 0.6, spread: 2.4, rise: -9.8, drag: 0.8, follow: 1, soft: 0.05, emit: 36 },
};
const PARTICLE_FLOATS = 16;      // per instance on the GPU
const STATE_FLOATS = 13;         // per particle in the simulation
/** A sprite is drawn out by at most this many times its radius to each side. */
const STREAK_MOST = 2.5;
const ZERO = [0, 0, 0];
const DEPTH_BUCKETS = 128;

export class Particles {
  constructor(ctx, capacity) {
    this.ctx = ctx; this.count = 0;
    this._seed = 0x2f6e2b1;
    this._buckets = new Uint16Array(DEPTH_BUCKETS + 1);
    this.configure(capacity);
  }

  /** Change the pool size (quality setting); live particles are dropped. */
  configure(capacity) {
    const gl = this.ctx.gl;
    this.capacity = capacity; this.count = 0;
    this.position = new Float64Array(capacity * 3);          // world space
    this.velocity = new Float32Array(capacity * 3);
    // age, life, size at birth, size at death, rotation, spin, texture offset, opacity, rise, drag, softness, emission, streak
    this.state = new Float32Array(capacity * STATE_FLOATS);
    this.colour = new Float32Array(capacity * 3);
    this.order = new Uint16Array(capacity); this.bucketOf = new Uint8Array(capacity);
    this.stream = new Float32Array(capacity * PARTICLE_FLOATS);
    if (this.buffer) { gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.buffer); }
    this._allocate();
  }

  _allocate() {
    const gl = this.ctx.gl, bytes = PARTICLE_FLOATS * 4;
    this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferData(gl.ARRAY_BUFFER, this.stream.byteLength, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    for (let i = 0; i < PARTICLE_FLOATS / 4; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, bytes, i * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(null);
  }

  restore() { this._allocate(); }

  // xorshift32: the simulation must not depend on Math.random (deterministic captures).
  _random() {
    let s = this._seed; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this._seed = s;
    return (s >>> 0) / 4294967296;
  }

  _spawn(kind, px, py, pz, vx, vy, vz, colour, sizeScale) {
    if (this.count >= this.capacity) return;
    const k = KINDS[kind] || KINDS.smoke, i = this.count++, p = i * 3, s = i * STATE_FLOATS;
    const angle = this._random() * Math.PI * 2, out = Math.sqrt(this._random()) * k.spread;
    this.position[p] = px; this.position[p + 1] = py; this.position[p + 2] = pz;
    this.velocity[p] = vx * k.follow + Math.cos(angle) * out; this.velocity[p + 1] = vy * k.follow + k.up * (0.5 + this._random()); this.velocity[p + 2] = vz * k.follow + Math.sin(angle) * out;
    const c = colour || k.colour, shade = 0.85 + 0.3 * this._random();
    this.colour[p] = c[0] * shade; this.colour[p + 1] = c[1] * shade; this.colour[p + 2] = c[2] * shade;
    this.state[s] = 0; this.state[s + 1] = k.life[0] + (k.life[1] - k.life[0]) * this._random();
    this.state[s + 2] = k.size[0] * sizeScale * (0.8 + 0.4 * this._random()); this.state[s + 3] = k.size[1] * sizeScale * (0.8 + 0.4 * this._random());
    this.state[s + 4] = this._random() * Math.PI * 2; this.state[s + 5] = (this._random() - 0.5) * 1.6; this.state[s + 6] = this._random() * 0.999 + (k.mist ? 1 : 0);   // texture offset in the fraction, mist flag in the integer part
    this.state[s + 7] = k.alpha; this.state[s + 8] = k.rise; this.state[s + 9] = k.drag; this.state[s + 10] = k.soft; this.state[s + 11] = k.emit; this.state[s + 12] = k.streak || 0;
  }

  /**
   * Advance the simulation and emit. emitters: frame.spray; exhaust: frame.exhaust (after-fire throws sparks);
   * wind: [x, z] in m/s.
   */
  update(dt, emitters, exhaust, wind) {
    dt = Math.min(dt, 0.05);
    const pos = this.position, vel = this.velocity, st = this.state, col = this.colour;
    const wx = wind ? wind[0] : 0, wz = wind ? wind[1] : 0;
    for (let i = 0; i < this.count;) {
      const p = i * 3, s = i * STATE_FLOATS;
      st[s] += dt;
      if (st[s] >= st[s + 1]) {
        // Retire: move the last live particle into this slot.
        const last = --this.count, lp = last * 3, ls = last * STATE_FLOATS;
        if (last !== i) {
          for (let k = 0; k < 3; k++) { pos[p + k] = pos[lp + k]; vel[p + k] = vel[lp + k]; col[p + k] = col[lp + k]; }
          for (let k = 0; k < STATE_FLOATS; k++) st[s + k] = st[ls + k];
        }
        continue;
      }
      const drag = Math.exp(-st[s + 9] * dt);
      // Drag pulls the particle towards the speed of the air, which is the wind.
      vel[p] = wx + (vel[p] - wx) * drag; vel[p + 2] = wz + (vel[p + 2] - wz) * drag;
      vel[p + 1] = vel[p + 1] * drag + st[s + 8] * dt;
      pos[p] += vel[p] * dt; pos[p + 1] += vel[p + 1] * dt; pos[p + 2] += vel[p + 2] * dt;
      if (pos[p + 1] < 0.02 && vel[p + 1] < 0) { pos[p + 1] = 0.02; vel[p + 1] *= -0.25; }       // the ground is near y = 0 everywhere a car can be
      st[s + 4] += st[s + 5] * dt;
      i++;
    }
    if (emitters) {
      for (let e = 0; e < emitters.length; e++) {
        const em = emitters[e], n = Math.floor((em.rate || 0) * dt + this._random());       // stochastic rounding keeps low rates honest
        const v = em.velocity || ZERO, q = em.position;
        for (let k = 0; k < n; k++) this._spawn(em.kind, q[0], q[1], q[2], v[0], v[1], v[2], em.color || null, em.size || 1);
      }
    }
    if (exhaust) {
      for (let e = 0; e < exhaust.length; e++) {
        const ex = exhaust[e];
        if (ex.kind !== 'afterfire' || !(ex.strength > 0)) continue;
        const n = Math.floor(ex.strength * 220 * dt + this._random()), q = ex.position, d = ex.direction, v = ex.velocity || ZERO;
        for (let k = 0; k < n; k++) { const speed = 5 + 9 * this._random(); this._spawn('spark', q[0], q[1], q[2], v[0] + d[0] * speed, v[1] + d[1] * speed, v[2] + d[2] * speed, null, 1); }
      }
    }
  }

  /**
   * Upload far to near and draw; the particle program must be in use.
   * cam: world camera position; forward: unit view direction.
   */
  draw(cam, forward) {
    const n = this.count;
    if (!n) return;
    const gl = this.ctx.gl, pos = this.position, vel = this.velocity, st = this.state, col = this.colour, out = this.stream, buckets = this._buckets, order = this.order, bucketOf = this.bucketOf;
    // Counting sort on view depth: exact order does not matter for soft sprites, only that far ones come first.
    buckets.fill(0);
    for (let i = 0; i < n; i++) {
      const p = i * 3, depth = (pos[p] - cam[0]) * forward[0] + (pos[p + 1] - cam[1]) * forward[1] + (pos[p + 2] - cam[2]) * forward[2];
      const b = depth <= 0 ? DEPTH_BUCKETS - 1 : Math.max(0, DEPTH_BUCKETS - 1 - Math.min(DEPTH_BUCKETS - 1, Math.floor(Math.sqrt(depth) * 8)));
      bucketOf[i] = b; buckets[b + 1]++;
    }
    for (let b = 0; b < DEPTH_BUCKETS; b++) buckets[b + 1] += buckets[b];
    for (let i = 0; i < n; i++) order[buckets[bucketOf[i]]++] = i;
    for (let k = 0; k < n; k++) {
      const i = order[k], p = i * 3, s = i * STATE_FLOATS, o = k * PARTICLE_FLOATS, t = st[s] / st[s + 1];
      out[o] = pos[p] - cam[0]; out[o + 1] = pos[p + 1] - cam[1]; out[o + 2] = pos[p + 2] - cam[2];
      out[o + 3] = 0.5 * (st[s + 2] + (st[s + 3] - st[s + 2]) * Math.sqrt(t));
      out[o + 4] = col[p]; out[o + 5] = col[p + 1]; out[o + 6] = col[p + 2];
      // Quick fade in, long fade out.
      out[o + 7] = st[s + 7] * Math.min(1, t * 12) * (1 - t) * Math.sqrt(1 - t);
      out[o + 8] = st[s + 4]; out[o + 9] = st[s + 6]; out[o + 10] = st[s + 10]; out[o + 11] = st[s + 11];
      // Half the path flown in the streak time, to each side of the centre; a slow sprite stays round.
      const speed = Math.hypot(vel[p], vel[p + 1], vel[p + 2]), half = Math.min(0.5 * st[s + 12] * speed, STREAK_MOST * out[o + 3]);
      const scale = speed > 1e-3 ? half / speed : 0;
      out[o + 12] = vel[p] * scale; out[o + 13] = vel[p + 1] * scale; out[o + 14] = vel[p + 2] * scale; out[o + 15] = 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, n * PARTICLE_FLOATS);
    gl.bindVertexArray(this.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.bindVertexArray(null);
  }
}

// ---------------------------------------------------------------------------------------------- exhaust flames
/** Jet dimensions in metres at strength 0 and 1. */
const FLAME_SHAPE = {
  nitrous: { kind: 0, length: [0.5, 1.4], radius: [0.05, 0.07], peak: 9 },
  afterfire: { kind: 1, length: [0.55, 0.7], radius: [0.07, 0.085], peak: 7 },
};
const MAX_FLAMES = 8;

/**
 * Hull of one flame: a unit cube, corners in [0,1]^3, with triangles wound so that the INSIDE faces are
 * front faces. Drawing those (the far side of the box) keeps the flame visible when the camera is inside it.
 */
export const FLAME_CORNERS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1]);
export const FLAME_INDICES = new Uint16Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);

export class Flames {
  constructor(ctx) {
    this.ctx = ctx;
    this._origin = new Float32Array(4); this._axis = new Float32Array(4); this._side = new Float32Array(3); this._up = new Float32Array(3);
    this._allocate();
  }

  _allocate() {
    const gl = this.ctx.gl;
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, FLAME_CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    this.ibo = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, FLAME_INDICES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  restore() { this._allocate(); }

  /**
   * Draw frame.exhaust. program: the flame program, in use, with uFlameScreen and uFlameSource set.
   * gain: brightness multiplier for the time of day (a flame that reads at night would vanish at noon).
   */
  draw(program, exhaust, cam, gain) {
    const gl = this.ctx.gl, origin = this._origin, axis = this._axis, side = this._side, up = this._up;
    gl.bindVertexArray(this.vao);
    const n = Math.min(exhaust.length, MAX_FLAMES);
    for (let i = 0; i < n; i++) {
      const e = exhaust[i], strength = Math.min(1, Math.max(0, e.strength || 0));
      if (strength <= 0.01) continue;
      const shape = FLAME_SHAPE[e.kind] || FLAME_SHAPE.nitrous, d = e.direction;
      const dl = Math.hypot(d[0], d[1], d[2]) || 1, ax = d[0] / dl, ay = d[1] / dl, az = d[2] / dl;
      // Right-handed jet frame (side, up, axis) with `up` the direction nearest to world up. It must be
      // right-handed: a mirrored frame would reverse the hull's winding and cull the wrong faces.
      let sx = az, sz = -ax; const sl = Math.hypot(sx, sz);
      if (sl < 1e-3) { sx = 1; sz = 0; } else { sx /= sl; sz /= sl; }
      side[0] = sx; side[1] = 0; side[2] = sz;
      up[0] = ay * sz; up[1] = az * sx - ax * sz; up[2] = -ay * sx;       // axis x side
      origin[0] = e.position[0] - cam[0]; origin[1] = e.position[1] - cam[1]; origin[2] = e.position[2] - cam[2];
      origin[3] = shape.length[0] + (shape.length[1] - shape.length[0]) * strength;
      axis[0] = ax; axis[1] = ay; axis[2] = az; axis[3] = shape.radius[0] + (shape.radius[1] - shape.radius[0]) * strength;
      gl.uniform4fv(program.loc('uFlameOrigin'), origin); gl.uniform4fv(program.loc('uFlameAxis'), axis);
      gl.uniform3fv(program.loc('uFlameSide'), side); gl.uniform3fv(program.loc('uFlameUp'), up);
      gl.uniform4f(program.loc('uFlameParams'), strength, shape.kind, e.seed || 0, shape.peak * gain);
      gl.drawElements(gl.TRIANGLES, FLAME_INDICES.length, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }
}
