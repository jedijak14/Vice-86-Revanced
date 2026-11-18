// Sheets: the parametric surfaces that panels are cut from.
// A sheet maps chart coordinates (a, b) to a point in the vehicle frame. Panels are polygons in the chart
// (see panel.js); the sheet supplies positions, normals and the local metric, so the same panel code works
// on the lofted hull, on a flat tail panel or on a curved windscreen.
//
// The loft is the important one. It sweeps a cross-section made of straight facets between "rails"; every
// interior rail is a crease that is rounded with a true circular fillet of a chosen radius. The fillet always
// occupies the same band of the chart coordinate b around the integer value of its rail, so mesh rows can
// follow the creases exactly along the whole car.

const cross = (o, a, b) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; };
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; v[0] /= l; v[1] /= l; v[2] /= l; return v; };

/**
 * Wrap a position function as a sheet.
 * pos(a, b, out) writes a 3D point. opts: { flip: the outward normal is -(dP/da x dP/db), ha, hb: finite difference
 * steps in chart units, rows: () => hard b levels the mesh must contain, cols: () => hard a levels }.
 */
export function makeSheet(pos, opts = {}) {
  const ha = opts.ha || 1e-3, hb = opts.hb || 1e-3, sgn = opts.flip ? -1 : 1;
  const p0 = [0, 0, 0], p1 = [0, 0, 0];
  const sheet = {
    pos, flip: !!opts.flip, ha, hb,
    rows: opts.rows || (() => []), cols: opts.cols || (() => []),
    /** Partial derivatives dP/da and dP/db (central differences). */
    jac(a, b, ja, jb) {
      pos(a - ha, b, p0); pos(a + ha, b, p1); for (let k = 0; k < 3; k++) ja[k] = (p1[k] - p0[k]) / (2 * ha);
      pos(a, b - hb, p0); pos(a, b + hb, p1); for (let k = 0; k < 3; k++) jb[k] = (p1[k] - p0[k]) / (2 * hb);
    },
    /** Unit outward normal. */
    normal(a, b, out) {
      const ja = [0, 0, 0], jb = [0, 0, 0]; sheet.jac(a, b, ja, jb); cross(out, ja, jb);
      out[0] *= sgn; out[1] *= sgn; out[2] *= sgn; return norm(out);
    },
  };
  return sheet;
}

/** A flat sheet: origin + a * U + b * V. The outward normal is U x V (or its opposite with flip). */
export function planeSheet(origin, U, V, flip = false) {
  const n = norm(cross([0, 0, 0], U, V)); if (flip) { n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2]; }
  const sheet = makeSheet((a, b, o) => { o[0] = origin[0] + a * U[0] + b * V[0]; o[1] = origin[1] + a * U[1] + b * V[1]; o[2] = origin[2] + a * U[2] + b * V[2]; return o; }, { flip });
  sheet.normal = (a, b, out) => { out[0] = n[0]; out[1] = n[1]; out[2] = n[2]; return out; };
  sheet.jac = (a, b, ja, jb) => { for (let k = 0; k < 3; k++) { ja[k] = U[k]; jb[k] = V[k]; } };
  return sheet;
}

function remap(from, to, x) {
  const m = from.length; let i = 1; while (i < m - 1 && from[i] < x) i++;
  const span = from[i] - from[i - 1];
  return span > 1e-12 ? to[i - 1] + (to[i] - to[i - 1]) * (x - from[i - 1]) / span : to[i - 1];
}

const STATIONS_KEPT = 16384;   // sections a loft remembers before it starts again (about 150 numbers each)

/**
 * Lofted, creased surface.
 *   rails:  array of functions a -> [p, q]: the section vertices, in section-plane coordinates, from first to last.
 *   radius: array (one per rail; ends ignored) of numbers or functions of a: fillet radius of that crease, in the
 *           units of the section plane.
 *   place:  (a, p, q, out) -> 3D point: where the section plane sits in the vehicle frame.
 *   band:   half width of the chart band given to each fillet (in b), default 0.1.
 *   arcSegs: mesh rows per half fillet.
 *   crown:  array (one per facet) of numbers or functions of a: how far the middle of that facet stands proud of the
 *           straight line between its creases. Pressed panels are never flat: a few millimetres of crown is what
 *           makes a reflection travel across a panel instead of snapping on and off. The bulge is a parabola, so
 *           the facet is convex all the way across; it is capped at 3 % of the facet's width so that a facet
 *           which narrows to nothing does not keep its bulge. With centred = true the first facet starts on a line
 *           of symmetry and is highest there, with no slope across it.
 * Chart: a is the station, b runs 0..rails-1 across the section; integer b is the middle of a crease.
 * The chart is badly stretched across a fillet (a few millimetres take a fifth of a unit), so the loft also offers
 * arcOf/bOf: the true distance across the section, in which panel.js does its metric work.
 */
export function makeLoft({ rails, radius = [], crown = [], centred = false, place, band = 0.1, arcSegs = 3, flip = false, ha = 0.05 }) {
  const n = rails.length - 1;
  // Everything known about the section at one station lives in one block of numbers, so that a station can be put
  // away whole and brought back: every vertex asks for its own station and the two beside it (for its normal), and
  // the lattice asks for the same stations row after row. Working the section out each time was half of a car's
  // build time.
  let used = 0;
  const work = new Float64Array(18 * n + 10), part = (size) => work.subarray(used, used += size);
  const R = part((n + 1) * 2), A = part((n + 1) * 2), B = part((n + 1) * 2), D = part(n * 2), nrm = part((n + 1) * 2);
  const phi = part(n + 1), rad = part(n + 1), bulge = part(n), len = part(n);
  const knotB = part(2 * n), knotS = part(2 * n);                              // breakpoints of the piecewise linear map between b and arc length
  const stations = new Map();
  let cached = NaN;
  function section(a) {
    if (a === cached) return; cached = a;
    const known = stations.get(a);
    if (known) { work.set(known); return; }
    solveSection(a);
    if (stations.size >= STATIONS_KEPT) stations.clear();
    stations.set(a, work.slice());
  }
  function solveSection(a) {
    for (let k = 0; k <= n; k++) { const r = rails[k](a); R[k * 2] = r[0]; R[k * 2 + 1] = r[1]; }
    for (let k = 0; k < n; k++) { const dx = R[k * 2 + 2] - R[k * 2], dy = R[k * 2 + 3] - R[k * 2 + 1], l = Math.hypot(dx, dy) || 1e-9; len[k] = l; D[k * 2] = dx / l; D[k * 2 + 1] = dy / l; }
    for (let k = 0; k < n; k++) { const c = typeof crown[k] === 'function' ? crown[k](a) : (crown[k] || 0); bulge[k] = Math.min(c, 0.03 * len[k]); }
    for (let k = 0; k <= n; k++) {
      A[k * 2] = B[k * 2] = R[k * 2]; A[k * 2 + 1] = B[k * 2 + 1] = R[k * 2 + 1]; phi[k] = 0; rad[k] = 0;
      if (k === 0 || k === n) continue;
      const d0x = D[k * 2 - 2], d0y = D[k * 2 - 1], d1x = D[k * 2], d1y = D[k * 2 + 1];
      const c = Math.max(-1, Math.min(1, d0x * d1x + d0y * d1y)), ang = Math.acos(c);
      const want = typeof radius[k] === 'function' ? radius[k](a) : (radius[k] || 0);
      if (ang < 0.004 || want <= 0) continue;
      const tn = Math.tan(ang / 2), set = Math.min(want * tn, 0.45 * len[k - 1], 0.45 * len[k]);
      phi[k] = ang; rad[k] = set / tn;
      A[k * 2] = R[k * 2] - d0x * set; A[k * 2 + 1] = R[k * 2 + 1] - d0y * set;
      B[k * 2] = R[k * 2] + d1x * set; B[k * 2 + 1] = R[k * 2 + 1] + d1y * set;
      // unit vector from the tangent point A towards the arc centre
      let nx = d1x - c * d0x, ny = d1y - c * d0y; const l = Math.hypot(nx, ny) || 1; nrm[k * 2] = nx / l; nrm[k * 2 + 1] = ny / l;
    }
    // arc length across the section: straight runs and fillet arcs alternate, and each is linear in b
    let s = 0, j = 0; knotB[j] = 0; knotS[j++] = 0;
    for (let k = 0; k < n; k++) {
      s += Math.hypot(A[k * 2 + 2] - B[k * 2], A[k * 2 + 3] - B[k * 2 + 1]);
      if (k < n - 1) { knotB[j] = k + 1 - band; knotS[j++] = s; s += rad[k + 1] * phi[k + 1]; knotB[j] = k + 1 + band; knotS[j++] = s; }
      else { knotB[j] = n; knotS[j++] = s; }
    }
  }
  const pq = [0, 0];
  /** Section-plane coordinates of chart point (a, b). */
  function sec(a, b, out = pq) {
    section(a);
    let k = Math.floor(b); if (k < 0) k = 0; if (k > n - 1) k = n - 1;
    const f = b - k, hasLo = k >= 1, hasHi = k + 1 <= n - 1;
    let crease = -1, tau = 0;
    if (hasLo && f < band) { crease = k; tau = 0.5 + 0.5 * f / band; }
    else if (hasHi && f > 1 - band) { crease = k + 1; tau = 0.5 * (f - (1 - band)) / band; }
    if (crease >= 0) {
      const j = crease * 2;
      if (phi[crease] === 0) { out[0] = R[j]; out[1] = R[j + 1]; return out; }
      const th = tau * phi[crease], r = rad[crease], cs = Math.cos(th), sn = Math.sin(th), d0x = D[j - 2], d0y = D[j - 1];
      out[0] = A[j] + nrm[j] * r * (1 - cs) + d0x * r * sn; out[1] = A[j + 1] + nrm[j + 1] * r * (1 - cs) + d0y * r * sn; return out;
    }
    const e0 = hasLo ? band : 0, e1 = hasHi ? band : 0, s = (f - e0) / (1 - e0 - e1), j = k * 2;
    out[0] = B[j] + (A[j + 2] - B[j]) * s; out[1] = B[j + 1] + (A[j + 3] - B[j + 1]) * s;
    if (bulge[k] > 0) {
      // Outward is to the left of the direction of travel across the section. A facet that starts on the line of
      // symmetry rises along q alone: pushed along its own normal it would leave the centre plane wherever it slopes,
      // by a tenth of a millimetre, and the two halves of the car would stand that far apart.
      const onCentre = centred && k === 0, rise = bulge[k] * (onCentre ? 1 - s * s : 4 * s * (1 - s));
      if (!onCentre) out[0] -= D[j + 1] * rise;
      out[1] += D[j] * rise;
    }
    return out;
  }
  const sheet = makeSheet((a, b, o) => { const s = sec(a, b); return place(a, s[0], s[1], o); }, {
    flip, ha, hb: band * 0.02,
    rows: () => { const r = []; for (let k = 1; k < n; k++) for (let i = -arcSegs; i <= arcSegs; i++) r.push(k + band * i / arcSegs); return r; },
  });
  sheet.sec = (a, b) => { const s = sec(a, b); return [s[0], s[1]]; };
  sheet.rail = (k, a) => rails[k](a);
  /** Chart b in [bLo, bHi] where section coordinate `which` (0 = p, 1 = q) equals `value` at station a. The coordinate must be monotone over the range. */
  sheet.solve = (a, which, value, bLo, bHi) => {
    const vLo = sec(a, bLo)[which], vHi = sec(a, bHi)[which], rising = vHi > vLo;
    if ((value - vLo) * (rising ? 1 : -1) <= 0) return bLo; if ((value - vHi) * (rising ? 1 : -1) >= 0) return bHi;
    let lo = bLo, hi = bHi;
    for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2, v = sec(a, mid)[which]; if ((v < value) === rising) lo = mid; else hi = mid; }
    return (lo + hi) / 2;
  };
  /** Distance across the section from the first rail to chart coordinate b, in section units; and its inverse. */
  sheet.arcOf = (a, b) => { section(a); return remap(knotB, knotS, b); };
  sheet.bOf = (a, s) => { section(a); return remap(knotS, knotB, s); };
  sheet.facets = n;
  return sheet;
}

/**
 * Walk over a sheet: from chart point (a, b), `distance` metres along the skin, setting out towards `heading` (a
 * vector in the vehicle frame, which need not lie in the surface) and keeping straight on over whatever the skin does.
 * `domain` { a: [a0, a1], b: [b0, b1], within: (a, b) => false outside the panel's outline (optional) } keeps it on
 * the sheet: at the chart's own borders it runs on along the border (the centre line of a mirrored car is one), and
 * it ends before the first stride that would leave the outline. Returns the chart point reached.
 * Why: whatever lies behind a panel near its edge (a lining, the black border of a pane) must stay behind the panel.
 * Laid out in the tangent plane at the edge instead, it comes out through the skin wherever the panel turns a
 * corner within its width, as a pillar does between two panes.
 */
export function walk(sheet, a, b, heading, distance, domain, stride = 0.003) {
  const clamp = (v, range) => Math.max(range[0], Math.min(range[1], v));
  const ja = [0, 0, 0], jb = [0, 0, 0], n = [0, 0, 0], d = heading.slice(), here = sheet.pos(a, b, [0, 0, 0]), there = [0, 0, 0];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  let left = distance;
  while (left > 1e-7) {
    sheet.jac(a, b, ja, jb); norm(cross(n, ja, jb));
    const off = dot(d, n); for (let k = 0; k < 3; k++) d[k] -= n[k] * off; norm(d);
    // the chart step that moves `step` metres along the heading: least squares on the two tangents
    const step = Math.min(stride, left), aa = dot(ja, ja), ab = dot(ja, jb), bb = dot(jb, jb), ra = dot(ja, d) * step, rb = dot(jb, d) * step, det = aa * bb - ab * ab;
    const da = (ra * bb - rb * ab) / det, db = (rb * aa - ra * ab) / det;
    const a1 = clamp(a + da, domain.a), b1 = clamp(b + db, domain.b);
    if (domain.within && !domain.within(a1, b1)) break;
    a = a1; b = b1;
    // the chart is stretched unevenly (badly so across a fillet), so the ground covered is measured, not assumed
    sheet.pos(a, b, there);
    left -= Math.max(step * 0.25, Math.hypot(there[0] - here[0], there[1] - here[1], there[2] - here[2]));
    here[0] = there[0]; here[1] = there[1]; here[2] = there[2];
  }
  return [a, b];
}

/**
 * The same surface with its chart pushed sideways near one row: the line b = row of the returned sheet lies
 * `distance` metres to the +b side (negative: -b side) of that line on the base sheet, all along its length.
 * Why: a shut line is authored once, on a row shared by the two panels that meet there. Each panel is cut from its
 * own shifted copy of the sheet, so both edges stay exact mesh rows (dense, smooth) and the gap between them has a
 * constant width in metres even where the chart is stretched.
 * The shift fades to nothing over `below` and `above` (chart units), which must stay clear of crease rows.
 */
export function shiftRow(base, row, distance, below = 0.1, above = 0.1) {
  const p0 = [0, 0, 0], p1 = [0, 0, 0], h = 1e-3, memo = new Map();
  const shiftAt = (a) => {
    let s = memo.get(a);
    if (s === undefined) {
      // metres per chart unit across the row, measured on the side the edge moves to
      base.pos(a, row, p0); base.pos(a, row + Math.sign(distance) * h, p1);
      s = distance / (Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) / h);
      if (memo.size > 20000) memo.clear(); memo.set(a, s);
    }
    return s;
  };
  const toBase = (a, b) => { const t = b - row; if (t <= -below || t >= above) return b; return b + shiftAt(a) * (t < 0 ? 1 + t / below : 1 - t / above); };
  const fromBase = (a, c) => {
    if (c <= row - below || c >= row + above) return c;
    const s = shiftAt(a);
    return c < row + s ? row - below + (c - (row - below)) / (1 + s / below) : row + (c - row - s) / (1 - s / above);
  };
  const sheet = makeSheet((a, b, o) => base.pos(a, toBase(a, b), o), { flip: base.flip, ha: base.ha, hb: base.hb, rows: base.rows, cols: base.cols });
  sheet.sec = (a, b) => base.sec(a, toBase(a, b));
  sheet.rail = base.rail;
  sheet.solve = (a, which, value, bLo, bHi) => fromBase(a, base.solve(a, which, value, toBase(a, bLo), toBase(a, bHi)));
  sheet.arcOf = (a, b) => base.arcOf(a, toBase(a, b));
  sheet.bOf = (a, s) => fromBase(a, base.bOf(a, s));
  sheet.facets = base.facets;
  return sheet;
}
