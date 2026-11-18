// Shared maths for Vice. Plain arrays / Float32Array, no classes, no allocation in hot paths
// when an `out` argument is supplied.
//
// Conventions (whole project):
//   metres, seconds, radians. +X east, +Y up, +Z south. Right-handed.
//   Vehicle local frame: +Z forward, +Y up, +X = the car's left side.
//   Yaw is a rotation about +Y; yaw 0 faces +Z; positive yaw turns towards +X.
//   Matrices are column-major Float32Array(16), column vectors (M * v), same as WebGL.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const saturate = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (x - a) / (b - a);
export const remap = (x, a, b, c, d) => c + (d - c) * saturate((x - a) / (b - a));
export const smoothstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sign = (x) => (x < 0 ? -1 : 1);
export const mod = (x, m) => ((x % m) + m) % m;
/** Shortest signed difference b - a between two angles, in (-PI, PI]. */
export const angleDelta = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d <= -Math.PI) d += TAU; return d; };
/** Frame-rate independent exponential approach. `halfLife` in seconds. */
export const damp = (a, b, halfLife, dt) => b + (a - b) * Math.pow(0.5, dt / Math.max(1e-6, halfLife));

// ---------------------------------------------------------------- vec3
export const v3 = (x = 0, y = 0, z = 0) => [x, y, z];
export const v3set = (o, x, y, z) => { o[0] = x; o[1] = y; o[2] = z; return o; };
export const v3copy = (o, a) => { o[0] = a[0]; o[1] = a[1]; o[2] = a[2]; return o; };
export const v3add = (o, a, b) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; };
export const v3sub = (o, a, b) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; };
export const v3scale = (o, a, s) => { o[0] = a[0] * s; o[1] = a[1] * s; o[2] = a[2] * s; return o; };
export const v3addScaled = (o, a, b, s) => { o[0] = a[0] + b[0] * s; o[1] = a[1] + b[1] * s; o[2] = a[2] + b[2] * s; return o; };
export const v3lerp = (o, a, b, t) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };
export const v3dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const v3cross = (o, a, b) => {
  const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
  o[0] = x; o[1] = y; o[2] = z; return o;
};
export const v3len = (a) => Math.hypot(a[0], a[1], a[2]);
export const v3dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const v3norm = (o, a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; o[0] = a[0] / l; o[1] = a[1] / l; o[2] = a[2] / l; return o; };

// ---------------------------------------------------------------- quaternion [x, y, z, w]
export const quat = () => [0, 0, 0, 1];
export const quatFromAxisAngle = (o, ax, ay, az, ang) => { const s = Math.sin(ang / 2); o[0] = ax * s; o[1] = ay * s; o[2] = az * s; o[3] = Math.cos(ang / 2); return o; };
export const quatFromYaw = (o, yaw) => quatFromAxisAngle(o, 0, 1, 0, yaw);
export const quatMul = (o, a, b) => {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = aw * bx + ax * bw + ay * bz - az * by;
  o[1] = aw * by - ax * bz + ay * bw + az * bx;
  o[2] = aw * bz + ax * by - ay * bx + az * bw;
  o[3] = aw * bw - ax * bx - ay * by - az * bz; return o;
};
export const quatRotate = (o, q, v) => {
  const x = v[0], y = v[1], z = v[2], qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o[0] = x + qw * tx + qy * tz - qz * ty; o[1] = y + qw * ty + qz * tx - qx * tz; o[2] = z + qw * tz + qx * ty - qy * tx; return o;
};
export const quatSlerp = (o, a, b, t) => {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let c = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (c < 0) { c = -c; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let s0, s1;
  if (c > 0.9995) { s0 = 1 - t; s1 = t; } else { const th = Math.acos(c), sn = Math.sin(th); s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn; }
  o[0] = a[0] * s0 + bx * s1; o[1] = a[1] * s0 + by * s1; o[2] = a[2] * s0 + bz * s1; o[3] = a[3] * s0 + bw * s1; return o;
};
/** Heading of a quaternion: yaw of its +Z axis about +Y (0 faces +Z, positive towards +X). */
export const quatYaw = (q) => {
  const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
  return Math.atan2(fx, fz);
};

// ---------------------------------------------------------------- mat4
export const m4 = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
export const m4identity = (o) => { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o; };
export const m4copy = (o, a) => { o.set(a); return o; };
export const m4mul = (o, a, b) => {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
    a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    o[c * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    o[c * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    o[c * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    o[c * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return o;
};
export const m4translation = (o, x, y, z) => { m4identity(o); o[12] = x; o[13] = y; o[14] = z; return o; };
export const m4scaling = (o, x, y, z) => { m4identity(o); o[0] = x; o[5] = y; o[10] = z; return o; };
export const m4rotationX = (o, a) => { const c = Math.cos(a), s = Math.sin(a); m4identity(o); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o; };
/** Yaw: +Z rotates towards +X for positive angles. */
export const m4rotationY = (o, a) => { const c = Math.cos(a), s = Math.sin(a); m4identity(o); o[0] = c; o[2] = -s; o[8] = s; o[10] = c; return o; };
export const m4rotationZ = (o, a) => { const c = Math.cos(a), s = Math.sin(a); m4identity(o); o[0] = c; o[1] = s; o[4] = -s; o[5] = c; return o; };
/** Rigid transform from a position and quaternion, optional uniform scale. */
export const m4fromQuatPos = (o, q, p, s = 1) => {
  const x = q[0], y = q[1], z = q[2], w = q[3], x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  o[0] = (1 - yy - zz) * s; o[1] = (xy + wz) * s; o[2] = (xz - wy) * s; o[3] = 0;
  o[4] = (xy - wz) * s; o[5] = (1 - xx - zz) * s; o[6] = (yz + wx) * s; o[7] = 0;
  o[8] = (xz + wy) * s; o[9] = (yz - wx) * s; o[10] = (1 - xx - yy) * s; o[11] = 0;
  o[12] = p[0]; o[13] = p[1]; o[14] = p[2]; o[15] = 1; return o;
};
/** Position + yaw (+ optional scale): the common case for placed props. */
export const m4fromYawPos = (o, yaw, x, y, z, s = 1) => {
  const c = Math.cos(yaw) * s, sn = Math.sin(yaw) * s; o.fill(0);
  o[0] = c; o[2] = -sn; o[5] = s; o[8] = sn; o[10] = c; o[12] = x; o[13] = y; o[14] = z; o[15] = 1; return o;
};
export const m4transformPoint = (o, m, p) => {
  const x = p[0], y = p[1], z = p[2];
  o[0] = m[0] * x + m[4] * y + m[8] * z + m[12]; o[1] = m[1] * x + m[5] * y + m[9] * z + m[13]; o[2] = m[2] * x + m[6] * y + m[10] * z + m[14]; return o;
};
export const m4transformDir = (o, m, d) => {
  const x = d[0], y = d[1], z = d[2];
  o[0] = m[0] * x + m[4] * y + m[8] * z; o[1] = m[1] * x + m[5] * y + m[9] * z; o[2] = m[2] * x + m[6] * y + m[10] * z; return o;
};
export const m4invert = (o, a) => {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3], a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
    a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11], a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
    b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
    b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return null;
  det = 1 / det;
  o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return o;
};
/** Perspective projection, depth range [0,1] after the usual GL -1..1 mapping. fovY in radians. */
export const m4perspective = (o, fovY, aspect, near, far) => {
  const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far); o.fill(0);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf; o[11] = -1; o[14] = 2 * far * near * nf; return o;
};
export const m4ortho = (o, l, r, b, t, n, f) => {
  o.fill(0); o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = -2 / (f - n);
  o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = -(f + n) / (f - n); o[15] = 1; return o;
};
/** View matrix looking from `eye` to `target`. */
export const m4lookAt = (o, eye, target, up = [0, 1, 0]) => {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  o[0] = xx; o[1] = yx; o[2] = zx; o[3] = 0; o[4] = xy; o[5] = yy; o[6] = zy; o[7] = 0; o[8] = xz; o[9] = yz; o[10] = zz; o[11] = 0;
  o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]); o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]); o[15] = 1; return o;
};

// ---------------------------------------------------------------- deterministic randomness
/** 32-bit integer hash of up to three integers. Stable across platforms. */
export function hashInts(a, b = 0, c = 0) {
  let h = (a | 0) * 0x27d4eb2d ^ (b | 0) * 0x165667b1 ^ (c | 0) * 0x9e3779b1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}
/** Hash to [0,1). */
export const hash01 = (a, b = 0, c = 0) => hashInts(a, b, c) / 4294967296;
/** Hash a string to a 32-bit seed. */
export function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

/** Small fast seeded generator. Returns an object with helpers; `rng()` itself is not callable to keep call sites explicit. */
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),          // inclusive
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sign: () => (next() < 0.5 ? -1 : 1),
    gauss: () => { let u = 0; for (let i = 0; i < 4; i++) u += next(); return (u - 2) / 0.5774; }, // approx N(0,1)
    weighted: (items, weightOf) => { let tot = 0; for (const it of items) tot += weightOf(it); let r = next() * tot; for (const it of items) { r -= weightOf(it); if (r <= 0) return it; } return items[items.length - 1]; },
    fork: (salt = 0) => makeRng(hashInts(s, salt, 0x51ed)),
  };
}

// ---------------------------------------------------------------- CPU noise (for generators; shaders have their own)
const fade = (t) => t * t * (3 - 2 * t);
/** Value noise in [0,1], period-free, 2D. */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = fade(x - xi), yf = fade(y - yi);
  const a = hash01(xi, yi, seed), b = hash01(xi + 1, yi, seed), c = hash01(xi, yi + 1, seed), d = hash01(xi + 1, yi + 1, seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
/** Fractal value noise in roughly [0,1]. */
export function fbm2(x, y, octaves = 4, seed = 0, lacunarity = 2, gain = 0.5) {
  let amp = 0.5, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) { sum += amp * noise2(x, y, seed + i * 131); norm += amp; x *= lacunarity; y *= lacunarity; amp *= gain; }
  return sum / norm;
}

// ---------------------------------------------------------------- colour
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** '#rrggbb' or 0xrrggbb to [r,g,b] in 0..1 sRGB. */
export function hexColor(h) { if (typeof h === 'string') h = parseInt(h.replace('#', ''), 16); return [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]; }
export function hsv(h, s, v) { const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; }
