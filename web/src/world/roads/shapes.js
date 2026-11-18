// Small solid shapes placed in a road-aligned frame: the pieces bridges and road details are assembled from.
// A frame maps (lateral, height, along) to the world; lateral is positive on the right of the direction of travel.

/** Frame at (x, z) heading `yaw`. `y` is the height of its origin; `grade` tilts it along the direction of travel. */
export function frameAt(x, z, yaw, y = 0, grade = 0) {
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  return { x, y, z, fx, fz, rx: -fz, rz: fx, grade };
}
/** World position of the frame point (lateral l, height h above the frame origin, distance f along). */
export const place = (B, l, h, f) => [B.x + B.rx * l + B.fx * f, B.y + h + B.grade * f, B.z + B.rz * l + B.fz * f];

/** Flat quad wound so that it faces away from the point (cx, cy, cz): no winding to get wrong in box-like solids. */
export function quadAwayFrom(mb, a, b, c, d, cx, cy, cz, own) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const mx = (a[0] + c[0]) / 2 - cx, my = (a[1] + c[1]) / 2 - cy, mz = (a[2] + c[2]) / 2 - cz;
  const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), h = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]), uv = [0, 0, w, 0, w, h, 0, h];
  const out = nx * mx + ny * my + nz * mz >= 0;
  // own = uv of a, b, c, d for surfaces whose shader reads something other than plain metres across the quad
  if (own) return out ? mb.flatQuad(a, b, c, d, own) : mb.flatQuad(a, d, c, b, [own[0], own[1], own[6], own[7], own[4], own[5], own[2], own[3]]);
  return out ? mb.flatQuad(a, b, c, d, uv) : mb.flatQuad(a, d, c, b, [0, 0, 0, h, w, h, w, 0]);
}

const FACES = [['l', 0, 4, 6, 2], ['r', 1, 3, 7, 5], ['b', 0, 1, 5, 4], ['t', 2, 6, 7, 3], ['k', 0, 2, 3, 1], ['f', 4, 5, 7, 6]];
/**
 * Box between laterals l0..l1, heights h0..h1 and distances f0..f1 of a frame. `skip` lists faces to leave out:
 * l(eft) r(ight) b(ottom) t(op) (bac)k f(ront). Returns the number of triangles added.
 */
export function box(mb, B, l0, l1, h0, h1, f0, f1, skip = '') {
  const c = [];
  for (let i = 0; i < 8; i++) c.push(place(B, i & 1 ? l1 : l0, i & 2 ? h1 : h0, i & 4 ? f1 : f0));
  const m = place(B, (l0 + l1) / 2, (h0 + h1) / 2, (f0 + f1) / 2);
  let n = 0;
  for (const [key, i, j, k, l] of FACES) if (!skip.includes(key)) { quadAwayFrom(mb, c[i], c[j], c[k], c[l], m[0], m[1], m[2]); n += 2; }
  return n;
}

/**
 * Upright prism or cone frustum with n sides on the frame point (l, f), from height h0 (radius r0) to h1 (radius r1),
 * smooth-shaded round its axis. cap: '' | 't' | 'b' | 'tb'.
 */
export function column(mb, B, l, f, h0, h1, r0, r1, n, cap = '') {
  const base = mb.count, slope = (r0 - r1) / Math.max(1e-6, h1 - h0);
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2, cl = Math.cos(a), cf = Math.sin(a);
    const nx = B.rx * cl + B.fx * cf, nz = B.rz * cl + B.fz * cf;
    const p0 = place(B, l + cl * r0, h0, f + cf * r0), p1 = place(B, l + cl * r1, h1, f + cf * r1);
    mb.vertex(p0[0], p0[1], p0[2], nx, slope, nz, a * r0, 0); mb.vertex(p1[0], p1[1], p1[2], nx, slope, nz, a * r0, h1 - h0);
  }
  for (let i = 0; i < n; i++) { const a = base + i * 2; mb.quad(a, a + 2, a + 3, a + 1); }
  for (const [key, h, r, up] of [['t', h1, r1, 1], ['b', h0, r0, -1]]) {
    if (!cap.includes(key)) continue;
    const c = place(B, l, h, f), centre = mb.vertex(c[0], c[1], c[2], 0, up, 0, 0, 0), ring = mb.count;
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, p = place(B, l + Math.cos(a) * r, h, f + Math.sin(a) * r); mb.vertex(p[0], p[1], p[2], 0, up, 0, Math.cos(a) * r, Math.sin(a) * r); }
    for (let i = 0; i < n; i++) { const a = ring + i, b = ring + (i + 1) % n; if (up > 0) mb.tri(centre, a, b); else mb.tri(centre, b, a); }
  }
  return mb.count - base;
}

/** Round tube of radius r with n sides along a list of world points (open ends), smooth-shaded. */
export function pipe(mb, points, r, n) {
  const base = mb.count, m = points.length;
  for (let k = 0; k < m; k++) {
    const a = points[Math.max(0, k - 1)], b = points[Math.min(m - 1, k + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2]; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    // ring axes: u is horizontal and square to the tube (or any horizontal for a vertical tube), v completes the frame
    let ux = tz, uz = -tx; const ul = Math.hypot(ux, uz); if (ul < 1e-4) { ux = 1; uz = 0; } else { ux /= ul; uz /= ul; }
    const vx = ty * uz, vy = tz * ux - tx * uz, vz = -ty * ux;
    for (let i = 0; i <= n; i++) {
      const ang = (i / n) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), nx = ux * c + vx * s, ny = vy * s, nz = uz * c + vz * s;
      mb.vertex(points[k][0] + nx * r, points[k][1] + ny * r, points[k][2] + nz * r, nx, ny, nz, ang * r, k);
    }
  }
  for (let k = 0; k + 1 < m; k++) for (let i = 0; i < n; i++) { const a = base + k * (n + 1) + i, b = a + n + 1; mb.quad(a, a + 1, b + 1, b); }
  return mb.count - base;
}
