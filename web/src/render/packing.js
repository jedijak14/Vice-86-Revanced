// JavaScript mirrors of the G-buffer encodings in host.js (GBUFFER_WRITE / GBUFFER_READ) and of the
// temporal jitter sequence. Used by tests and by tools that read targets back; the GLSL is the reference.

/** Unit vector -> octahedral coordinates in [-1,1]^2 with +Y as the pole (most normals in a flat city point up). */
export function octEncode(out, x, y, z) {
  const l = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1; x /= l; y /= l; z /= l;
  if (y >= 0) { out[0] = x; out[1] = z; }
  else { out[0] = (1 - Math.abs(z)) * (x >= 0 ? 1 : -1); out[1] = (1 - Math.abs(x)) * (z >= 0 ? 1 : -1); }
  return out;
}

export function octDecode(out, ex, ey) {
  let x = ex, y = 1 - Math.abs(ex) - Math.abs(ey), z = ey;
  const t = Math.max(-y, 0);
  x += x >= 0 ? -t : t; z += z >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** Albedo is stored as its square root in 8 bits (gamma 2), which spends the codes on dark tones. */
export const encodeAlbedo = (linear) => Math.round(Math.sqrt(Math.min(1, Math.max(0, linear))) * 255);
export const decodeAlbedo = (byte) => (byte / 255) * (byte / 255);

/** Attachment 3 alpha: wetness in [0,1] for ordinary surfaces, 2 + sss for translucent foliage. */
export const encodeWetSss = (wet, sss) => (sss > 0 ? 2 + Math.min(1, sss) : Math.min(1, Math.max(0, wet)));
export function decodeWetSss(out, a) { if (a > 1.5) { out[0] = 0; out[1] = a - 2; } else { out[0] = a; out[1] = 0; } return out; }

/** Radical inverse of i in the given base: the Halton low-discrepancy sequence. */
export function halton(i, base) {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/**
 * Sub-pixel camera jitter for temporal antialiasing: Halton(2,3), `length` samples, centred on the pixel.
 * Returns a Float32Array of (x, y) pairs in pixels, each in (-0.5, 0.5).
 */
export function jitterSequence(length = 8) {
  const out = new Float32Array(length * 2);
  for (let i = 0; i < length; i++) { out[i * 2] = halton(i + 1, 2) - 0.5; out[i * 2 + 1] = halton(i + 1, 3) - 0.5; }
  return out;
}
