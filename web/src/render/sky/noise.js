// Tiling noise for the sky module, built once on the CPU and uploaded as one RGBA8 texture (`uSkyNoise`).
// Deterministic: lattice hashes from src/core/math.js, no Math.random.
//   r  billow field (gradient noise remapped by cell noise): the plan shape of cumulus clouds
//   g  fine cell noise: erosion of cloud edges, foam lace, caustic cells
//   b  smooth gradient noise, medium scale: cirrus, domain warps, weather-scale variation
//   a  fine gradient noise: water micro ripples
import { hashInts } from '../../core/math.js';

export const SKY_NOISE_SIZE = 256;

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const wrap = (i, period) => ((i % period) + period) % period;

/** Periodic gradient noise, roughly -1..1. */
function gradientNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = fade(xf), v = fade(yf);
  const dot = (ix, iy, dx, dy) => { const a = hashInts(wrap(ix, period), wrap(iy, period), seed) * (Math.PI * 2 / 4294967296); return Math.cos(a) * dx + Math.sin(a) * dy; };
  const a = dot(xi, yi, xf, yf), b = dot(xi + 1, yi, xf - 1, yf), c = dot(xi, yi + 1, xf, yf - 1), d = dot(xi + 1, yi + 1, xf - 1, yf - 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.5;
}
/** Periodic cell noise: 1 at feature points falling to 0 between them. */
function cellNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y); let best = 4;
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const h = hashInts(wrap(xi + i, period), wrap(yi + j, period), seed);
    const dx = xi + i + (h & 0xffff) / 65536 - x, dy = yi + j + (h >>> 16) / 65536 - y, d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return 1 - Math.min(Math.sqrt(best), 1);
}
function octaves(fn, x, y, period, seed, count) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < count; o++) { sum += amp * fn(x * period, y * period, period, seed + o * 17); norm += amp; amp *= 0.5; period *= 2; }
  return sum / norm;
}

/** Build the texture data: Uint8Array(size * size * 4). */
export function buildSkyNoise(size = SKY_NOISE_SIZE) {
  const n = size * size, ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = y * size + x;
    const billow = octaves(gradientNoise, u, v, 4, 101, 4) * 0.5 + 0.5, cells = octaves(cellNoise, u, v, 5, 211, 3);
    ch[0][i] = billow * 0.62 + cells * 0.38 + (cells - 0.5) * billow * 0.3;   // puffs with crisp cell-shaped edges
    ch[1][i] = octaves(cellNoise, u, v, 14, 307, 3);
    ch[2][i] = octaves(gradientNoise, u, v, 6, 401, 4);
    ch[3][i] = octaves(gradientNoise, u, v, 20, 503, 3);
  }
  const data = new Uint8Array(n * 4);
  for (let c = 0; c < 4; c++) {
    // stretch each channel to the full byte range so that thresholds in the shaders mean the same thing every build
    let lo = Infinity, hi = -Infinity; const a = ch[c];
    for (let i = 0; i < n; i++) { if (a[i] < lo) lo = a[i]; if (a[i] > hi) hi = a[i]; }
    const s = 255 / (hi - lo);
    for (let i = 0; i < n; i++) data[i * 4 + c] = Math.round((a[i] - lo) * s);
  }
  return data;
}

export const SKY_VOLUME_SIZE = 48;

/** Periodic 3D cell noise sampler: feature points are drawn once per lattice, so a lookup is 27 distances. */
function cellField(period, seed) {
  const points = new Float32Array(period * period * period * 3);
  for (let k = 0, o = 0; k < period; k++) for (let j = 0; j < period; j++) for (let i = 0; i < period; i++, o += 3) {
    const h = hashInts(i + j * 131, k, seed), g = hashInts(h, 77, seed);
    points[o] = i + (h & 0xffff) / 65536; points[o + 1] = j + (h >>> 16) / 65536; points[o + 2] = k + (g & 0xffff) / 65536;
  }
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let best = 4;
    for (let c = -1; c <= 1; c++) {
      // a stored point belongs to the wrapped cell: `shift` moves it to the cell being visited
      const wk = wrap(zi + c, period), shiftZ = zi + c - wk - z;
      for (let b = -1; b <= 1; b++) {
        const wj = wrap(yi + b, period), shiftY = yi + b - wj - y, row = (wk * period + wj) * period;
        for (let a = -1; a <= 1; a++) {
          const wi = wrap(xi + a, period), o = (row + wi) * 3;
          const dx = points[o] + xi + a - wi - x, dy = points[o + 1] + shiftY, dz = points[o + 2] + shiftZ, d = dx * dx + dy * dy + dz * dz;
          if (d < best) best = d;
        }
      }
    }
    return 1 - Math.min(Math.sqrt(best), 1);
  };
}
/** Periodic 3D gradient noise, roughly -1..1. */
function gradientNoise3(x, y, z, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi, u = fade(xf), v = fade(yf), w = fade(zf);
  const corner = (a, b, c) => {
    const h = hashInts(wrap(xi + a, period) + wrap(yi + b, period) * 131, wrap(zi + c, period), seed);
    // one of the twelve edge directions of a cube: even coverage without a square root
    const e = h % 12, dx = xf - a, dy = yf - b, dz = zf - c;
    return e < 4 ? (e & 1 ? dx : -dx) + (e & 2 ? dy : -dy) : e < 8 ? (e & 1 ? dx : -dx) + (e & 2 ? dz : -dz) : (e & 1 ? dy : -dy) + (e & 2 ? dz : -dz);
  };
  const x00 = corner(0, 0, 0) + (corner(1, 0, 0) - corner(0, 0, 0)) * u, x10 = corner(0, 1, 0) + (corner(1, 1, 0) - corner(0, 1, 0)) * u;
  const x01 = corner(0, 0, 1) + (corner(1, 0, 1) - corner(0, 0, 1)) * u, x11 = corner(0, 1, 1) + (corner(1, 1, 1) - corner(0, 1, 1)) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 0.95;
}

/**
 * The cloud volume, tiling in all three directions: Uint8Array(size^3 * 2), z slices of rows of (r, g).
 *   r  billows: smooth noise inflated by cell noise, the body of a cumulus (1 = dense)
 *   g  cell noise in three octaves: the small turrets that erode its surface (1 = centre of a turret)
 */
export function buildSkyVolume(size = SKY_VOLUME_SIZE) {
  const n = size * size * size, shape = new Float32Array(n), detail = new Float32Array(n);
  const coarse = [cellField(3, 601), cellField(6, 602), cellField(12, 603)], fine = [cellField(4, 701), cellField(8, 702), cellField(16, 703)];
  const cells = (set, base, u, v, w) => 0.57 * set[0](u * base, v * base, w * base) + 0.29 * set[1](u * base * 2, v * base * 2, w * base * 2) + 0.14 * set[2](u * base * 4, v * base * 4, w * base * 4);
  for (let z = 0, i = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++, i++) {
    const u = x / size, v = y / size, w = z / size;
    const smooth = 0.5 + 0.5 * (0.6 * gradientNoise3(u * 3, v * 3, w * 3, 3, 611) + 0.3 * gradientNoise3(u * 6, v * 6, w * 6, 6, 612) + 0.1 * gradientNoise3(u * 12, v * 12, w * 12, 12, 613));
    const puffs = cells(coarse, 3, u, v, w);
    shape[i] = smooth + (1 - smooth) * puffs * 0.9 - (1 - puffs) * 0.25;     // cell noise swells the smooth field into rounded lobes
    detail[i] = cells(fine, 4, u, v, w);
  }
  // Sums of octaves crowd around their mean, and a field like that only moves a cloud's surface a little. Stretch each
  // channel so that its 2nd and 98th percentiles land on 0 and 1: the shader then gets the whole range to carve with.
  const data = new Uint8Array(n * 2), sorted = new Float32Array(n);
  [shape, detail].forEach((a, c) => {
    sorted.set(a); sorted.sort();
    const lo = sorted[Math.floor(n * 0.02)], s = 255 / (sorted[Math.floor(n * 0.98)] - lo);
    for (let i = 0; i < n; i++) data[i * 2 + c] = Math.max(0, Math.min(255, Math.round((a[i] - lo) * s)));
  });
  return data;
}
