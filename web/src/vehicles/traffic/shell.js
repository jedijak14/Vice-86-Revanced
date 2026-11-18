// Shell: the parametric body surface shared by every traffic vehicle.
//
// A shell is described by
//   - a closed side-view outline (the seam where the body side meets the surfaces that wrap over it),
//   - a side surface x = side(z, y) giving the half width at every point inside that outline,
//   - a band that wraps around the outline from the left seam across the centre line: for every outline
//     point there is a cross-section made of a circular fillet (tangent to the side) and a crowned span.
// Lower bodies, glasshouses, van and bus bodies and cargo boxes are all shells with different outlines.
//
// The side is meshed as a grid of columns (rear to front) and rows (bottom to top). Columns are straight
// lines from a point on the bottom of the outline to a point on its top, so they can lean with a pillar;
// near the two end faces they take up the shape of the face. Rows follow named key lines. Because every
// feature (window, wheel arch, panel gap, lamp recess) is bounded by named columns and rows, features are
// cut out as whole blocks of cells and the hole is filled with a patch that ends on the true edge curve.
// Every vertex position and normal is evaluated on the analytic surface, which is what keeps reflections
// smooth across cells of very different sizes.
//
// Only the left half (x >= 0) is produced; callers mirror it.

import { roundedPath } from './curve.js';
import { Skin } from './skin.js';

/** Width of a panel gap (door, bonnet and boot shut lines), metres. */
export const GAP = 0.007;
const GAP_DEPTH = 0.007;
const H = 1e-3;                       // finite-difference step, metres
const num = (v, z, y) => (typeof v === 'function' ? v(z, y) : v);
const sstep = (a, b, x) => { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); };

export class Shell {
  /**
   * def = {
   *   outline: Path2 closed, with marks rb, rt, ft, fb (rear-bottom, rear-top, front-top, front-bottom corners);
   *            it starts at rb and runs up the rear face, forward along the top, down the front face and back along the bottom.
   *   side(z, y): half width.
   *   fillet, crown: { top, front, rear, bottom }, each a number or fn(z, y). Fillet radius between side and band,
   *            and how far the band's centre line stands proud of its edges.
   *   rows: [{ tag:'bottom', n }, { tag, y: number | fn(z), n, lod }...]  key rows from the bottom up; n = cells up to the next key.
   *   cols: [{ tag, z | zb+zt, gap, sideGroove:[rowTag,rowTag], bandGroove:[k0,k1], lod }...] key columns.
   *   pins: { name: { from, to, x: number | fn(frame), gap } }  lines of constant-ish x on the band between two outline refs.
   *   matSide(z, y), matBand(x, y, z, chain): materials.  chain: 0 rear face, 1 top, 2 front face, 3 bottom.
   *   openBottom: no band along the bottom (a glasshouse stands on the body below).
   * }
   * Outline refs: { top: colTag } | { bottom: colTag } | { front: rowTag } | { rear: rowTag }.
   */
  constructor(def) {
    this.def = def; this.o = def.outline;
    const m = this.o.marks, L = this.o.length;
    // An open-bottomed shell ends in sharp corners where the outline normal jumps; its end faces stop just short of them.
    const e = def.openBottom ? 0.003 : 0;
    this.sRear = [m.rb.mid + e, m.rt.mid]; this.sTop = [m.rt.mid, m.ft.mid]; this.sFront = [m.ft.mid, m.fb.mid - e]; this.sBottom = [m.fb.mid, L + m.rb.mid];
    this.frames = new Map(); this.arches = []; this.sideBlocks = []; this.bandBlocks = [];
  }

  /** Wheel arch: a circular opening of `radius` about (z, y) cut up from the bottom of the side. `band` is the width of the flared lip zone. */
  arch(a) { this.arches.push({ band: 0.045, lip: 0.022, depth: 0.3, ...a, tag: 'arch' + this.arches.length }); return this; }
  /** Window in the side between key columns c0..c1 and key rows r0..r1. */
  sideWindow(w) { this.sideBlocks.push(w); return this; }
  /** Feature on the band between two outline refs and two band columns: kind 'window' | 'recess' | 'cut' | 'paint'. */
  bandBlock(b) { this.bandBlocks.push(b); return this; }

  // ------------------------------------------------------------------ analytic surface

  /** Sample of the side surface: [x, y, z, nx, ny, nz, ua, ub] with texture coordinates in metres (along, up). */
  sideAt(z, y) {
    const X = this.def.side, x = X(z, y), xz = (X(z + H, y) - X(z - H, y)) / (2 * H), xy = (X(z, y + H) - X(z, y - H)) / (2 * H), l = Math.hypot(1, xy, xz);
    return [x, y, z, 1 / l, -xy / l, -xz / l, z, y];
  }

  /** Cross-section frame of the band at outline arc length u. */
  frame(u) {
    let F = this.frames.get(u); if (F) return F;
    const o = this.o, q = o.at(u), n = o.normal(u), z = q[0], y = q[1], nz = n[0], ny = n[1], X = this.def.side, xs = X(z, y);
    // alpha: how far the side leans inwards as it reaches the seam; the fillet starts tangent to it.
    const alpha = Math.atan(-(X(z + nz * H, y + ny * H) - X(z - nz * H, y - ny * H)) / (2 * H));
    const wt = ny > 0 ? ny * ny : 0, wb = ny < 0 ? ny * ny : 0, wf = nz > 0 ? nz * nz : 0, wr = nz < 0 ? nz * nz : 0, f = this.def.fillet, c0 = this.def.crown;
    const r = wt * num(f.top, z, y) + wb * num(f.bottom, z, y) + wf * num(f.front, z, y) + wr * num(f.rear, z, y);
    const c = wt * num(c0.top, z, y) + wb * num(c0.bottom, z, y) + wf * num(c0.front, z, y) + wr * num(c0.rear, z, y);
    let beta = 0, xB = xs;
    for (let k = 0; k < 3; k++) { xB = xs - r * (Math.cos(alpha) - Math.sin(beta)); beta = Math.atan(2 * c / xB); }
    xB = xs - r * (Math.cos(alpha) - Math.sin(beta));
    F = { u, z, y, nz, ny, xs, alpha, beta, r, c, xB, turn: Math.max(0, Math.PI / 2 - alpha - beta), cx: xs - r * Math.cos(alpha), cm: -r * Math.sin(alpha), mEdge: r * (Math.cos(beta) - Math.sin(alpha)) };
    this.frames.set(u, F); return F;
  }
  _fp(F, f, o) { const th = F.alpha + F.turn * f, m = F.cm + F.r * Math.sin(th); o[0] = F.cx + F.r * Math.cos(th); o[1] = F.y + F.ny * m; o[2] = F.z + F.nz * m; return th; }
  _bp(F, x, o) { const k = x / F.xB, m = F.mEdge + F.c * (1 - k * k); o[0] = x; o[1] = F.y + F.ny * m; o[2] = F.z + F.nz * m; }
  _finish(P, t1, A, B, n0) {
    const t2x = B[0] - A[0], t2y = B[1] - A[1], t2z = B[2] - A[2];
    let nx = t1[1] * t2z - t1[2] * t2y, ny = t1[2] * t2x - t1[0] * t2z, nz = t1[0] * t2y - t1[1] * t2x, l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) { nx = n0[0]; ny = n0[1]; nz = n0[2]; l = Math.hypot(nx, ny, nz); }
    if (nx * n0[0] + ny * n0[1] + nz * n0[2] < 0) l = -l;
    P[3] = nx / l; P[4] = ny / l; P[5] = nz / l; return P;
  }
  /** Sample of the fillet at outline position u; f = 0 on the side seam, 1 where the band starts. */
  filletAt(u, f) {
    const F = this.frame(u), P = [0, 0, 0, 0, 0, 0, 0, u], A = [0, 0, 0], B = [0, 0, 0];
    const th = this._fp(F, f, P); this._fp(this.frame(u - H), f, A); this._fp(this.frame(u + H), f, B); P[6] = P[0];
    const c = Math.cos(th), s = Math.sin(th);
    return this._finish(P, [-s, F.ny * c, F.nz * c], A, B, [c, F.ny * s, F.nz * s]);
  }
  /** Sample of the band at outline position u and distance x from the centre plane. Texture coordinates (x, u) in metres. */
  bandAt(u, x) {
    const F = this.frame(u), P = [0, 0, 0, 0, 0, 0, x, u], A = [0, 0, 0], B = [0, 0, 0];
    this._bp(F, x, P); this._bp(this.frame(u - H), x, A); this._bp(this.frame(u + H), x, B);
    const dm = -2 * F.c * x / (F.xB * F.xB);
    return this._finish(P, [1, F.ny * dm, F.nz * dm], A, B, [-dm, F.ny, F.nz]);
  }

  /** Arc length on the top of the outline at station z, and on the bottom. */
  topS(z) { return this.o.crossing((a) => a - z, this.sTop[0], this.sTop[1]); }
  botS(z) { return this.o.crossing((a) => z - a, this.sBottom[0], this.sBottom[1]); }
  topY(z) { return this.o.at(this.topS(z))[1]; }
  botY(z) { return this.o.at(this.botS(z))[1]; }
  /** Arc length on the front (end = 1) or rear (end = -1) face at height y. */
  faceS(end, y) { return end > 0 ? this.o.crossing((a, b) => y - b, this.sFront[0], this.sFront[1]) : this.o.crossing((a, b) => b - y, this.sRear[0], this.sRear[1]); }

  /** Resolve an outline ref to { s, index in the ring of band samples }. Valid after layout(). */
  ref(r) {
    let i;
    if (r.top !== undefined) i = this.ringTop[this.col(r.top)];
    else if (r.bottom !== undefined) i = this.ringBot[this.col(r.bottom)];
    else if (r.front !== undefined) i = this.ringFront[this.row(r.front)];
    else i = this.ringRear[this.row(r.rear)];
    if (i === undefined) throw new Error('unknown outline ref ' + JSON.stringify(r));
    return i;
  }
  col(tag) { const i = this.colTag[tag]; if (i === undefined) throw new Error('unknown column ' + tag); return i; }
  row(tag) { const j = this.rowTag[tag]; if (j === undefined) throw new Error('unknown row ' + tag); return j; }

  // ------------------------------------------------------------------ layout

  /**
   * Build the node grid for a quality q = { level 0..2, len, ang, rows (multiplier), fillet, band (cells), grooves }.
   * `len` and `ang` bound the length and turning of any cell edge along the outline.
   */
  layout(q) {
    this.q = q; const o = this.o, def = this.def, len = q.len, ang = q.ang;
    // ---- rows
    const rk = def.rows.filter((r) => (r.lod ?? 2) >= q.level), rowJ = [0]; this.rowTag = {};
    rk.forEach((r, k) => { this.rowTag[r.tag] = rowJ[k]; rowJ.push(rowJ[k] + Math.max(1, Math.round(r.n * q.rows))); });
    const R = rowJ[rk.length]; this.rowTag.top = R; this.R = R;
    const keyFn = rk.map((r) => (typeof r.y === 'function' ? r.y : () => r.y));
    // ---- key columns (a column with a panel gap becomes two, GAP apart)
    const ck = [];
    for (const c of def.cols) {
      if ((c.lod ?? 2) < q.level) continue;
      const zb = c.zb ?? c.z, zt = c.zt ?? c.z;
      if (c.gap && q.grooves) ck.push({ zb: zb - GAP / 2, zt: zt - GAP / 2, tags: [c.tag + '-'], thin: c }, { zb: zb + GAP / 2, zt: zt + GAP / 2, tags: [c.tag, c.tag + '+'] });
      else ck.push({ zb, zt, tags: [c.tag, c.tag + '-', c.tag + '+'] });
    }
    for (const a of this.arches) { const w = a.radius + a.band + 0.02; ck.push({ zb: a.z - w, zt: a.z - w, tags: [a.tag + 'a'] }, { zb: a.z + w, zt: a.z + w, tags: [a.tag + 'b'] }); }
    ck.sort((a, b) => a.zb + a.zt - b.zb - b.zt);
    const sT = ck.map((c) => this.topS(c.zt)), sB = ck.map((c) => this.botS(c.zb));
    const colTop = [this.sTop[0]], colBot = [this.sBottom[1]], thin = []; this.colTag = {};
    for (let m = 0; m <= ck.length; m++) {
      const first = m === 0, last = m === ck.length;
      const ta = first ? this.sTop[0] : sT[m - 1], tb = last ? this.sTop[1] : sT[m], ba = first ? this.sBottom[1] : sB[m - 1], bb = last ? this.sBottom[0] : sB[m];
      const isThin = !first && ck[m - 1].thin, n = isThin ? 1 : Math.max(first || last ? q.endCols : 1, o.cost(ta, tb, len, ang), o.cost(bb, ba, len, ang));
      let tops, bots;
      if (first || last) { tops = o.spread(ta, tb, n, len, ang); bots = o.spread(bb, ba, n, len, ang).reverse(); }
      else {
        tops = [ta]; bots = [ba];
        for (let k = 1; k < n; k++) { const f = k / n; tops.push(this.topS(ck[m - 1].zt + (ck[m].zt - ck[m - 1].zt) * f)); bots.push(this.botS(ck[m - 1].zb + (ck[m].zb - ck[m - 1].zb) * f)); }
        tops.push(tb); bots.push(bb);
      }
      for (let k = 1; k <= n; k++) { colTop.push(tops[k]); colBot.push(bots[k]); thin.push(k === 1 && isThin ? ck[m - 1].thin : null); }
      if (!last) for (const t of ck[m].tags) this.colTag[t] = colTop.length - 1;
    }
    const C = colTop.length - 1; this.C = C; this.thin = thin;
    const iA = ck.length ? this.colTag[ck[0].tags[0]] : C, iB = ck.length ? this.colTag[ck[ck.length - 1].tags[0]] : 0;
    // ---- rows on the two end faces
    const face = (s0, s1, up) => {
      const sk = rk.map((r, k) => (k === 0 ? (up ? s0 : s1) : o.crossing(up ? (a, b) => b - keyFn[k](a) : (a, b) => keyFn[k](a) - b, s0, s1))); sk.push(up ? s1 : s0);
      const out = new Array(R + 1);
      for (let k = 0; k < rk.length; k++) {
        const a = sk[k], b = sk[k + 1], n = rowJ[k + 1] - rowJ[k], sp = o.spread(Math.min(a, b), Math.max(a, b), n, len, ang);
        if (a > b) sp.reverse();
        for (let t = 0; t <= n; t++) out[rowJ[k] + t] = sp[t];
      }
      return out;
    };
    const rearS = face(this.sRear[0], this.sRear[1], true), frontS = face(this.sFront[0], this.sFront[1], false);
    const pt = (s) => o.at(s, [0, 0]), Lp = rearS.map(pt), Fp = frontS.map(pt), Tp = colTop.map(pt), Bp = colBot.map(pt);
    // Each face as (fraction along its chord, offset from the chord): the offset is what fades out into the body.
    const dev = (P) => { const a = P[0], b = P[R], dz = b[0] - a[0], dy = b[1] - a[1], l2 = dz * dz + dy * dy; return P.map((p) => { const e = ((p[0] - a[0]) * dz + (p[1] - a[1]) * dy) / l2; return [e, p[0] - (a[0] + dz * e), p[1] - (a[1] + dy * e)]; }); };
    const dR = dev(Lp), dF = dev(Fp), mid = (i) => (Tp[i][0] + Bp[i][0]) / 2;
    const param = [], S = [];
    for (let i = 0; i <= C; i++) {
      const pc = new Array(R + 1), sc = new Array(R + 1); param.push(pc); S.push(sc);
      if (i === 0 || i === C) { const P = i ? Fp : Lp; for (let j = 0; j <= R; j++) { pc[j] = P[j]; sc[j] = this.sideAt(P[j][0], P[j][1]); } continue; }
      const b = Bp[i], t = Tp[i], aR = i < iA ? 1 - sstep(mid(0), mid(iA), mid(i)) : 0, aF = i > iB ? 1 - sstep(mid(C), mid(iB), mid(i)) : 0;
      const eta = [0];
      // Where the column crosses each feature line: bisection, because a line that climbs steeply along a
      // strongly leaning column (the screen sill of a low coupe) defeats a simple fixed-point search.
      for (let k = 1; k < rk.length; k++) {
        let lo = 0, hi = 1;
        for (let it = 0; it < 26; it++) { const e = (lo + hi) / 2; if (b[1] + (t[1] - b[1]) * e < keyFn[k](b[0] + (t[0] - b[0]) * e)) lo = e; else hi = e; }
        eta.push(Math.min(0.999, Math.max(eta[k - 1] + 1e-4, (lo + hi) / 2)));
      }
      eta.push(1);
      for (let k = 0; k < rk.length; k++) {
        const ja = rowJ[k], jb = rowJ[k + 1];
        for (let j = ja; j <= (k === rk.length - 1 ? jb : jb - 1); j++) {
          const uni = (j - ja) / (jb - ja), fR = (dR[j][0] - dR[ja][0]) / (dR[jb][0] - dR[ja][0]), fF = (dF[j][0] - dF[ja][0]) / (dF[jb][0] - dF[ja][0]);
          const e = eta[k] + (eta[k + 1] - eta[k]) * (uni + aR * (fR - uni) + aF * (fF - uni));
          const z = b[0] + (t[0] - b[0]) * e + aR * dR[j][1] + aF * dF[j][1];
          let y = b[1] + (t[1] - b[1]) * e + aR * dR[j][2] + aF * dF[j][2];
          if (j === ja && k > 0) y = keyFn[k](z);
          pc[j] = [z, y]; sc[j] = this.sideAt(z, y);
        }
      }
    }
    this.param = param; this.S = S;
    // ---- side cell states: 0 surface, 1 removed, 2 panel gap
    const st = new Uint8Array(C * R); this.sideState = st;
    for (let i = 0; i < C; i++) { const g = thin[i] && thin[i].sideGroove; if (g) for (let j = this.row(g[0]); j < this.row(g[1]); j++) st[i * R + j] = 2; }
    // ---- wheel arches
    const botY = (z) => this.botY(z);
    for (const a of this.arches) {
      const i0 = this.col(a.tag + 'a'), i1 = this.col(a.tag + 'b'), band = q.level < 2 ? a.band : 0, need = a.y + a.radius + band + 0.012;
      let j1 = 1; for (; j1 < R; j1++) { let ok = true; for (let i = i0; i <= i1; i++) if (param[i][j1][1] < need) ok = false; if (ok) break; }
      for (let i = i0; i < i1; i++) for (let j = 0; j < j1; j++) st[i * R + j] = 1;
      const foot = (rad, dir) => { let lo = -1.45, hi = 1.45; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (a.y + rad * Math.sin(m) - botY(a.z + dir * rad * Math.cos(m)) < 0) lo = m; else hi = m; } return lo; };
      // The moulding ring pairs up point for point with the opening, so it takes the opening's count.
      const arc = (rad, count) => {
        const ff = foot(rad, 1), fr = Math.PI - foot(rad, -1), n = count || Math.max(4, Math.ceil((fr - ff) / q.archAng)), out = [];
        for (let k = 0; k <= n; k++) {
          const ph = fr + (ff - fr) * k / n, z = a.z + rad * Math.cos(ph); let y = a.y + rad * Math.sin(ph);
          if (k === 0 || k === n) y = botY(z);
          const t = ph > 2.356 ? (fr - ph) / (fr - 2.356) : ph > 0.785 ? 1 + (2.356 - ph) / 1.571 : 2 + (0.785 - ph) / (0.785 - ff);
          out.push({ sample: this.sideAt(z, y), t, ph, s: k === 0 || k === n ? this.botS(z) : 0 });
        }
        return out;
      };
      const inner = arc(a.radius);
      Object.assign(a, { i0, i1, j1, inner, outer: band ? arc(a.radius + band, inner.length - 1) : null, nearR: a.radius + band });
    }
    // ---- ring of band samples around the outline
    const ring = []; this.ringTop = []; this.ringBot = []; this.ringRear = []; this.ringFront = [];
    for (let j = 0; j <= R; j++) { this.ringRear[j] = ring.length; ring.push({ s: rearS[j], sample: S[0][j], chain: j < R ? 0 : 1 }); }
    this.ringTop[0] = this.ringRear[R];
    for (let i = 1; i <= C; i++) { this.ringTop[i] = ring.length; ring.push({ s: colTop[i], sample: S[i][R], chain: i < C ? 1 : 2 }); }
    this.ringFront[R] = this.ringTop[C];
    for (let j = R - 1; j >= 0; j--) { this.ringFront[j] = ring.length; ring.push({ s: frontS[j], sample: S[C][j], chain: j > 0 ? 2 : 3 }); }
    this.ringBot[C] = this.ringFront[0];
    for (let i = C - 1; i >= 1; i--) {
      const a = this.arches.find((x) => x.i1 === i);
      this.ringBot[i] = ring.length; ring.push({ s: colBot[i], sample: S[i][0], chain: 3 });
      if (!a) continue;
      const push = (e, arch) => ring.push({ s: e.s, sample: e.sample, chain: 3, arch });
      const n = a.inner.length - 1;
      if (a.outer) push(a.outer[n]);
      a.ringFoot = ring.length; push(a.inner[n], a); push(a.inner[0]);
      if (a.outer) push(a.outer[0]);
      i = a.i0 + 1;
    }
    this.ringBot[0] = 0; this.ring = ring; const N = ring.length; this.N = N;
    // ---- band columns: fillet, then evenly spaced lines, plus the pinned lines features asked for
    const pins = []; this.pin = {};
    const addPin = (name, s0, s1, x) => { const sm = (s0 + s1) / 2, F = this.frame(sm), p = { name, s0, s1, x, home: 1 - num2(x, F) / F.xB }; pins.push(p); this.pin[name] = p; return p; };
    const num2 = (x, F) => (typeof x === 'function' ? x(F) : x);
    this.groovePins = [];
    for (const [name, p] of Object.entries(def.pins || {})) {
      if ((p.lod ?? 2) < q.level) continue;
      const s0 = ring[this.ref(p.from)].s, s1 = ring[this.ref(p.to)].s;
      if (p.gap && q.grooves) { const a = addPin(name + 'o', s0, s1, (F) => num2(p.x, F) + GAP / 2), b = addPin(name + 'i', s0, s1, (F) => num2(p.x, F) - GAP / 2); this.pin[name] = a; this.groovePins.push([a, b, this.ref(p.from), this.ref(p.to)]); }
      else { const a = addPin(name, s0, s1, p.x); this.pin[name + 'o'] = this.pin[name + 'i'] = a; }
    }
    for (const a of this.arches) {
      const xin = Math.min(...a.inner.map((e) => e.sample[0])) - (q.level < 2 ? a.depth : 0.14); a.xin = xin;
      if (!def.openBottom) a.pin = addPin(a.tag, a.inner[a.inner.length - 1].s, a.inner[0].s, xin);
    }
    pins.sort((a, b) => a.home - b.home);
    // Each pinned line normally has a column of the band grid to itself. At the far level, lines that lie
    // within a few centimetres of each other share one column, each still ruling it inside its own span:
    // the grid is the largest cost of a distant car and most of these lines belong to opposite ends of it.
    for (let k = 0; k < pins.length; k++) {
      const p = pins[k], host = q.level === 2 && k ? pins[k - 1] : null;
      if (host && p.home - host.home < 0.05 && host.members.every((m) => m.s1 <= p.s0 || m.s0 >= p.s1)) { host.members.push(p); pins.splice(k--, 1); } else p.members = [p];
    }
    const colsB = []; let pi = 0;
    for (let k = 1; k <= q.band; k++) {
      const t = k / q.band;
      while (pi < pins.length && pins[pi].home < t) colsB.push(pins[pi++]);
      if (k === q.band || !pins.some((p) => Math.abs(p.home - t) < 0.4 / q.band)) colsB.push({ home: t });
    }
    const nf = q.fillet, K = nf + 1 + colsB.length; this.nf = nf; this.K = K;
    colsB.forEach((c, k) => { c.k = nf + 1 + k; for (const m of c.members || []) m.k = c.k; });
    const B = [], fall = 0.14, ts = new Float64Array(colsB.length);
    for (let i = 0; i < N; i++) {
      const e = ring[i], F = this.frame(e.s), row = [e.sample]; B.push(row);
      for (let k = 1; k <= nf; k++) row.push(this.filletAt(e.s, k / nf));
      // Pinned lines sit on their target inside their span and ease back to their home fraction outside it.
      let prev = -1, prevT = 0, prevHome = 0;
      for (let k = 0; k <= colsB.length; k++) {
        const c = colsB[k];
        if (k < colsB.length && !c.name) continue;
        let t = 1, home = 1;
        if (k < colsB.length) {
          let w = -1, x = 0;
          for (const m of c.members) { const wm = e.s < m.s0 ? 1 - sstep(0, fall, m.s0 - e.s) : e.s > m.s1 ? 1 - sstep(0, fall, e.s - m.s1) : 1; if (wm > w) { w = wm; x = m.x; } }
          home = c.home; t = home + (Math.min(0.999, Math.max(0.001, 1 - num2(x, F) / F.xB)) - home) * w; t = Math.max(t, prevT + 1e-4); ts[k] = t;
        }
        for (let m = prev + 1; m < k; m++) ts[m] = prevT + (colsB[m].home - prevHome) / (home - prevHome) * (t - prevT);
        prev = k; prevT = t; prevHome = home;
      }
      for (let k = 0; k < colsB.length; k++) row.push(k === colsB.length - 1 ? this.bandAt(e.s, 0) : this.bandAt(e.s, F.xB * (1 - ts[k])));
    }
    this.B = B;
    // ---- band cell states: 0 surface, 1 removed, 2 gap across the car, 3 gap along the car, 4 where two gaps cross
    const bs = new Uint8Array(N * (K - 1)); this.bandState = bs;
    const kOf = (r) => (r === 'side' ? 0 : r === 'edge' ? nf : r === 'centre' ? K - 1 : this.pinOf(r).k); this.kOf = kOf;
    for (let i = 0; i < N; i++) {
      const e = ring[i];
      if (e.chain === 3 && def.openBottom) bs.fill(1, i * (K - 1), (i + 1) * (K - 1));
      if (e.arch) { const kk = e.arch.pin ? e.arch.pin.k : K - 1; for (let k = 0; k < kk; k++) bs[i * (K - 1) + k] = 1; }
    }
    for (let i = 1; i <= C; i++) { const g = thin[i - 1] && thin[i - 1].bandGroove; if (g) for (let k = kOf(g[0]); k < kOf(g[1]); k++) bs[this.ringTop[i - 1] * (K - 1) + k] = 2; }
    for (const [a, , i0, i1] of this.groovePins) for (let i = i0; i < i1; i++) bs[i * (K - 1) + a.k] = bs[i * (K - 1) + a.k] === 2 ? 4 : 3;
    return this;
  }
  pinOf(name) { const p = this.pin[name]; if (!p) throw new Error('unknown band line ' + name); return p; }

  // ------------------------------------------------------------------ patches (a common view of the side grid and the band grid)

  _sidePatch() {
    const sh = this, R = this.R;
    return { ni: this.C, nj: R, wrap: false, node: (i, j) => sh.S[i][j], param: (i, j) => sh.param[i][j], at: (p, q) => sh.sideAt(p, q), state: (i, j) => sh.sideState[i * R + j],
      mat: (i, j) => { const a = sh.param[i][j], b = sh.param[i + 1][j + 1]; return sh.def.matSide((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); } };
  }
  _bandPatch() {
    const sh = this, N = this.N, K1 = this.K - 1;
    // At the far level the flat floor needs no divisions across the car: runs of cells are merged into one.
    return { ni: N, nj: K1, wrap: true, merge: (i) => sh.q.level === 2 && sh.ring[i].chain === 3, node: (i, k) => sh.B[i % N][k], param: (i, k) => [sh.ring[i % N].s, sh.B[i % N][k][0]], at: (p, q) => sh.bandAt(p, q), state: (i, k) => sh.bandState[i * K1 + k],
      mat: (i, k) => { const a = sh.B[i][k], b = sh.B[(i + 1) % N][k + 1]; return sh.def.matBand((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, sh.ring[i].chain); } };
  }

  /** Resolve a block description to index ranges on its patch. */
  _block(b, onBand) {
    if (onBand) { const i0 = this.ref(b.from), i1 = this.ref(b.to), j0 = this.kOf(b.k0), j1 = this.kOf(b.k1); return { i0, i1, j0, j1, open: j1 === this.K - 1 }; }
    return { i0: this.col(b.c0), i1: this.col(b.c1), j0: this.row(b.r0), j1: this.row(b.r1), open: false };
  }

  // ------------------------------------------------------------------ emission

  /**
   * Emit the left half. out = { body: MeshBuilder, glass: MeshBuilder, liner: material | null, linerDepth }.
   * With a liner the whole surface is emitted a second time, pushed inwards and seen from inside, so that
   * pillars and roof have thickness when looked at through the glass.
   */
  emit(out) {
    const q = this.q, side = this._sidePatch(), band = this._bandPatch();
    // A feature may be limited to a range of levels: lod = coarsest level that still has it, minLod = finest.
    const live = (b) => (b.lod ?? 2) >= q.level && (b.minLod ?? 0) <= q.level;
    const blocks = [...this.sideBlocks.filter(live).map((b) => ({ b, patch: side, r: this._block(b, false) })), ...this.bandBlocks.filter(live).map((b) => ({ b, patch: band, r: this._block(b, true) }))];
    const hide = new Map([[side, new Uint8Array(side.ni * side.nj)], [band, new Uint8Array(band.ni * band.nj)]]);
    for (const { b, patch, r } of blocks) if (b.kind !== 'paint' && !(b.kind === 'cut' && q.level === 2)) { const h = hide.get(patch); for (let i = r.i0; i < r.i1; i++) for (let j = r.j0; j < r.j1; j++) h[i * patch.nj + j] = 1; }
    const outer = this._ctx(new Skin(out.body)), paintOver = new Map();
    for (const { b, patch, r } of blocks) if (b.kind === 'paint') for (let i = r.i0; i < r.i1; i++) for (let j = r.j0; j < r.j1; j++) paintOver.set(patch === band ? i * patch.nj + j : -1 - (i * patch.nj + j), b.mat);
    for (const patch of [side, band]) this._cells(outer, patch, hide.get(patch), (i, j) => paintOver.get(patch === band ? i * patch.nj + j : -1 - (i * patch.nj + j)) || patch.mat(i, j), q.grooves);
    const liner = out.liner ? this._ctx(new Skin(out.body, { offset: out.linerDepth, inward: true })) : null;
    if (liner) for (const patch of [side, band]) this._cells(liner, patch, hide.get(patch), () => out.liner, false);
    for (const a of this.arches) { this._arch(outer, a, out); if (liner) this._archRing(liner, a, out.liner, out.liner); }
    for (const { b, patch, r } of blocks) {
      if (b.kind === 'paint') continue;
      if (q.level === 2) { if (b.kind !== 'cut') this._cellsIn(outer, patch, r, b.kind === 'window' ? b.far : b.floor); continue; }
      const edge = this._opening(outer, patch, r, b), depth = b.kind === 'window' ? (liner ? out.linerDepth : 0.012) : b.depth;
      if (liner) this._opening(liner, patch, r, { ...b, frame: out.liner });
      this._wall(outer, edge, depth, b.wall || b.frame, r.open, 0.9, b.kind === 'window' ? 0.5 : 0.35);
      if (b.kind === 'window') this._cellsIn(this._ctx(new Skin(out.glass, { offset: 0.008 })), patch, r, b.pane);
      else if (b.kind === 'recess') this._cellsIn(this._ctx(new Skin(out.body, { offset: b.depth })), patch, r, b.floor);
    }
  }

  _ctx(skin) { const ids = new Map(); return { skin, id: (s, occ = 1) => { let n = ids.get(s); if (n === undefined) { n = skin.node(s, s[6], s[7], occ); ids.set(s, n); } return n; } }; }

  /** All cells of a patch that are neither removed by a feature nor hidden. */
  _cells(ctx, patch, hide, matOf, grooves) {
    const { ni, nj } = patch, sk = ctx.skin;
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) {
      const st = patch.state(i, j);
      if (st === 1 || hide[i * nj + j]) continue;
      const a = patch.node(i, j), b = patch.node(i + 1, j), c = patch.node(i + 1, j + 1), d = patch.node(i, j + 1), m = matOf(i, j);
      if (st >= 2 && grooves) {
        // A gap cell gets a wall on every side whose neighbour is not itself part of a gap, so runs, corners
        // and crossings of shut lines all close up without special cases. Nothing closes the centre line.
        const gap = (ii, jj) => {
          if (jj < 0 || jj >= nj) return false;
          if (patch.wrap) ii = (ii + ni) % ni; else if (ii < 0 || ii >= ni) return false;
          return !hide[ii * nj + jj] && patch.state(ii, jj) >= 2;
        };
        this._groove(sk, [a, b, c, d], m, [!gap(i, j - 1), !gap(i + 1, j), !(gap(i, j + 1) || (patch.wrap && j + 1 === nj)), !gap(i - 1, j)]);
        continue;
      }
      if (patch.merge && patch.merge(i)) {
        // Only while the nodes passed over lie on the straight edge of the merged cell, so that no crack opens against the neighbours.
        const straight = (ii, jm, je) => { const p = patch.node(ii, j), q2 = patch.node(ii, je), r = patch.node(ii, jm), dx = q2[0] - p[0], dy = q2[1] - p[1], dz = q2[2] - p[2], l = Math.hypot(dx, dy, dz) || 1, t = ((r[0] - p[0]) * dx + (r[1] - p[1]) * dy + (r[2] - p[2]) * dz) / (l * l); return Math.hypot(r[0] - p[0] - dx * t, r[1] - p[1] - dy * t, r[2] - p[2] - dz * t) < 0.0015; };
        const fits = (je) => { for (let jm = j + 1; jm < je; jm++) if (!straight(i, jm, je) || !straight(i + 1, jm, je)) return false; return true; };
        let j1 = j + 1; while (j1 < nj && patch.state(i, j1) !== 1 && !hide[i * nj + j1] && fits(j1 + 1)) j1++;
        sk.quad(ctx.id(a), ctx.id(b), ctx.id(patch.node(i + 1, j1)), ctx.id(patch.node(i, j1)), m); j = j1 - 1;
        continue;
      }
      sk.quad(ctx.id(a), ctx.id(b), ctx.id(c), ctx.id(d), m);
    }
  }
  /** Every cell of a block, on the given skin, in one material or a material chosen per cell centre (x, y, z). */
  _cellsIn(ctx, patch, r, mat) {
    for (let i = r.i0; i < r.i1; i++) for (let j = r.j0; j < r.j1; j++) {
      const a = patch.node(i, j), b = patch.node(i + 1, j), c = patch.node(i + 1, j + 1), d = patch.node(i, j + 1);
      const m = typeof mat === 'function' ? mat((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2) : mat;
      if (m) ctx.skin.quad(ctx.id(a), ctx.id(b), ctx.id(c), ctx.id(d), m);
    }
  }

  /**
   * A panel gap filling the cell P[0..3]: a floor below the surface and a wall on each side k (the edge from
   * P[k] to P[k+1]) that is asked for, darkened towards the bottom the way a real shut line reads.
   */
  _groove(sk, P, m, walls) {
    const floor = P.map((p) => sk.raw(p[0] - p[3] * GAP_DEPTH, p[1] - p[4] * GAP_DEPTH, p[2] - p[5] * GAP_DEPTH, p[3], p[4], p[5], p[6], p[7], 0.12));
    sk.quad(floor[0], floor[1], floor[2], floor[3], m);
    for (let k = 0; k < 4; k++) {
      if (!walls[k]) continue;
      const p = P[k], q = P[(k + 1) % 4], r = P[(k + 2) % 4], fp = sk.position(floor[k]), fq = sk.position(floor[(k + 1) % 4]);
      let nx = r[0] - q[0], ny = r[1] - q[1], nz = r[2] - q[2]; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      const t0 = sk.raw(p[0], p[1], p[2], nx, ny, nz, p[6], p[7], 0.55), t1 = sk.raw(q[0], q[1], q[2], nx, ny, nz, q[6], q[7], 0.55);
      sk.quad(t0, t1, sk.raw(fq[0], fq[1], fq[2], nx, ny, nz, q[6], q[7], 0.12), sk.raw(fp[0], fp[1], fp[2], nx, ny, nz, p[6], p[7], 0.12), m);
    }
  }

  /** Boundary of a block as rows of { sample, t } (t = side index + fraction of that side's length). Open blocks skip the centre-line side. */
  _loop(patch, r) {
    const sides = [];
    const run = (fn, n) => { const o = []; for (let k = 0; k <= n; k++) o.push(fn(k)); return o; };
    sides.push(run((k) => patch.node(r.i0 + k, r.j0), r.i1 - r.i0), run((k) => patch.node(r.i1, r.j0 + k), r.j1 - r.j0));
    if (r.open) sides.unshift(run((k) => patch.node(r.i0, r.j1 - k), r.j1 - r.j0));
    else sides.push(run((k) => patch.node(r.i1 - k, r.j1), r.i1 - r.i0), run((k) => patch.node(r.i0, r.j1 - k), r.j1 - r.j0));
    const out = [];
    sides.forEach((sd, si) => {
      let l = 0; const acc = [0];
      for (let k = 1; k < sd.length; k++) { l += Math.hypot(sd[k][0] - sd[k - 1][0], sd[k][1] - sd[k - 1][1], sd[k][2] - sd[k - 1][2]); acc.push(l); }
      for (let k = si ? 1 : 0; k < sd.length; k++) out.push({ sample: sd[k], t: si + acc[k] / (l || 1) });
    });
    return out;
  }

  /**
   * Fill between the boundary of a block and its true edge: a rounded quadrilateral set in from the block
   * by `inset` (the width of the surround, drawn in the frame material). Returns the edge as a list of samples.
   */
  _opening(ctx, patch, r, b) {
    const loop = this._loop(patch, r), q = this.q;
    if (!b.inset || q.level > 0) return loop.map((e) => e.sample);
    const c = [patch.param(r.i0, r.j0), patch.param(r.i1, r.j0), patch.param(r.i1, r.j1), patch.param(r.i0, r.j1)];
    const ins = typeof b.inset === 'number' ? [b.inset, b.inset, b.inset, b.inset] : b.inset.slice(), rad = typeof b.radius === 'number' ? [b.radius, b.radius, b.radius, b.radius] : (b.radius || [0, 0, 0, 0]);
    if (r.open) ins[2] = 0;
    // Move each edge inwards and intersect neighbours.
    let area = 0; for (let k = 0; k < 4; k++) { const p = c[k], n = c[(k + 1) % 4]; area += p[0] * n[1] - n[0] * p[1]; }
    const sg = area > 0 ? 1 : -1, lines = c.map((p, k) => { const n = c[(k + 1) % 4], dx = n[0] - p[0], dy = n[1] - p[1], l = Math.hypot(dx, dy), nx = -dy / l * sg, ny = dx / l * sg; return [p[0] + nx * ins[k], p[1] + ny * ins[k], dx / l, dy / l]; });
    const meet = (A, Bl) => { const d = A[2] * Bl[3] - A[3] * Bl[2], t = ((Bl[0] - A[0]) * Bl[3] - (Bl[1] - A[1]) * Bl[2]) / d; return [A[0] + A[2] * t, A[1] + A[3] * t]; };
    const v = [meet(lines[3], lines[0]), meet(lines[0], lines[1]), meet(lines[1], lines[2]), meet(lines[2], lines[3])];
    const order = r.open ? [3, 0, 1, 2] : [0, 1, 2, 3];
    const path = roundedPath(order.map((k, n) => ({ a: v[k][0], b: v[k][1], r: r.open && (n === 0 || n === 3) ? 0 : rad[k], tag: 'c' + n })), !r.open);
    const nSides = r.open ? 3 : 4, inner = [];
    for (let k = 0; k < nSides; k++) {
      const s0 = path.marks['c' + k].mid, s1 = k === 3 ? path.length + path.marks.c0.mid : path.marks['c' + (k + 1)].mid;
      const ss = path.adaptive(s0, s1, q.len, q.ang);
      for (let n = k ? 1 : 0; n < ss.length; n++) { const p = path.at(ss[n]); inner.push({ sample: n === ss.length - 1 && k === 3 ? inner[0].sample : patch.at(p[0], p[1]), t: k + (ss[n] - s0) / (s1 - s0) }); }
    }
    const rowOf = (L) => L.map((e) => ({ node: ctx.id(e.sample), t: e.t }));
    ctx.skin.stitch(rowOf(loop), rowOf(inner), b.frame);
    return inner.map((e) => e.sample);
  }

  /** A wall dropping `depth` below the surface along an edge, facing the middle of the opening. */
  _wall(ctx, edge, depth, mat, open, occTop, occBottom) {
    if (!mat || depth <= 0) return;
    const sk = ctx.skin, n = edge.length; let cx = 0, cy = 0, cz = 0;
    for (const p of edge) { cx += p[0] / n; cy += p[1] / n; cz += p[2] / n; }
    if (open) cx = 0;
    let pt = -1, pb = -1;
    for (let k = 0; k < n; k++) {
      const p = edge[k]; let dx = cx - p[0], dy = cy - p[1], dz = cz - p[2];
      const dn = dx * p[3] + dy * p[4] + dz * p[5]; dx -= dn * p[3]; dy -= dn * p[4]; dz -= dn * p[5];
      const l = Math.hypot(dx, dy, dz) || 1;
      const t = sk.raw(p[0], p[1], p[2], dx / l, dy / l, dz / l, p[6], p[7], occTop), bt = sk.raw(p[0] - p[3] * depth, p[1] - p[4] * depth, p[2] - p[5] * depth, dx / l, dy / l, dz / l, p[6], p[7], occBottom);
      if (k) sk.quad(pt, t, bt, pb, mat);
      pt = t; pb = bt;
    }
  }

  /**
   * Surface between an arch block's boundary and the arch edge. Intermediate rings are evaluated on the true
   * side surface so that the body crease and the flare keep their shape between the two; the last ring is
   * stitched to the arch, which carries its own point count.
   */
  _archRing(ctx, a, mat, lipMat) {
    const S = this.S, P = this.param, loop = [];
    const seg = (list) => { let l = 0; const acc = [0]; for (let k = 1; k < list.length; k++) { l += Math.hypot(list[k].s[0] - list[k - 1].s[0], list[k].s[1] - list[k - 1].s[1], list[k].s[2] - list[k - 1].s[2]); acc.push(l); } return acc.map((v) => v / (l || 1)); };
    const up = [], across = [], down = [];
    for (let j = 0; j <= a.j1; j++) up.push({ s: S[a.i0][j], p: P[a.i0][j] });
    for (let i = a.i0; i <= a.i1; i++) across.push({ s: S[i][a.j1], p: P[i][a.j1] });
    for (let j = a.j1; j >= 0; j--) down.push({ s: S[a.i1][j], p: P[a.i1][j] });
    [up, across, down].forEach((list, si) => { const f = seg(list); for (let k = si ? 1 : 0; k < list.length; k++) loop.push({ ...list[k], t: si + f[k] }); });
    // Every boundary node is paired with a point on the arch: along the two upright sides at its own height, so
    // that horizontal features run straight into the opening, and across the top by its position along the car.
    const near = a.outer || a.inner, R = a.nearR, phR = near[0].ph, phF = near[near.length - 1].ph, rings = this.q.level === 0 ? 3 : this.q.level === 1 ? 1 : 0;
    const split = 1.05, corner = 1.2, yS = a.y + R * Math.sin(split), yT = P[a.i0][a.j1][1], zA = P[a.i0][a.j1][0], zB = P[a.i1][a.j1][0];
    const elev = (y) => (y <= yS ? Math.asin(Math.max(-1, (y - a.y) / R)) : split + (corner - split) * Math.min(1, (y - yS) / Math.max(1e-6, yT - yS)));
    loop.forEach((e, k) => {
      const side = e.t <= 1 ? -1 : e.t >= 2 ? 1 : 0;
      let ph = side < 0 ? Math.PI - elev(e.p[1]) : side > 0 ? elev(e.p[1]) : Math.PI - corner - (Math.PI - 2 * corner) * (e.p[0] - zA) / (zB - zA);
      ph = Math.min(phR, Math.max(phF, ph)); if (k === 0) ph = phR; if (k === loop.length - 1) ph = phF;
      e.ph = ph; e.q = [a.z + R * Math.cos(ph), a.y + R * Math.sin(ph)];
    });
    // The material of each wedge between two boundary nodes is read just inside the block boundary, not where
    // the wedge happens to lie: a colour split then runs from the boundary to the arch as one clean line, the
    // way a door edge or a two-tone break does, instead of stepping across the wedges.
    const wedge = (k) => {
      if (typeof mat !== 'function') return mat;
      const e = loop[Math.min(k, loop.length - 2)], f = loop[Math.min(k, loop.length - 2) + 1], z = (e.p[0] + f.p[0]) / 2, y = (e.p[1] + f.p[1]) / 2, mid = (e.t + f.t) / 2;
      return mat(mid < 1 ? z + 0.01 : mid > 2 ? z - 0.01 : z, mid < 1 || mid > 2 ? y : y - 0.01);
    };
    let prev = loop.map((e) => ctx.id(e.s));
    for (let r = 1; r <= rings; r++) {
      const f = r / (rings + 1), cur = loop.map((e, k) => {
        const z = e.p[0] + (e.q[0] - e.p[0]) * f;
        // The two feet stay on the bottom line, where the floor joins on.
        return ctx.id(this.sideAt(z, k === 0 || k === loop.length - 1 ? this.botY(z) : e.p[1] + (e.q[1] - e.p[1]) * f));
      });
      for (let k = 0; k < loop.length - 1; k++) ctx.skin.quad(prev[k], prev[k + 1], cur[k + 1], cur[k], wedge(k));
      prev = cur;
    }
    ctx.skin.stitch(loop.map((e, k) => ({ node: prev[k], t: -e.ph })), near.map((e) => ({ node: ctx.id(e.sample), t: -e.ph })), typeof mat === 'function' ? (x, y, z, k) => wedge(k) : mat);
    // Without a bright moulding the rim of the opening simply carries on the colour of the panel beside it.
    if (a.outer) for (let k = 0; k < a.inner.length - 1; k++) {
      const o0 = a.outer[k], o1 = a.outer[k + 1], m = a.lipMat || (typeof mat === 'function' ? mat(a.z + (R + 0.01) * Math.cos((o0.ph + o1.ph) / 2), a.y + (R + 0.01) * Math.sin((o0.ph + o1.ph) / 2)) : mat);
      ctx.skin.quad(ctx.id(o0.sample), ctx.id(o1.sample), ctx.id(a.inner[k + 1].sample), ctx.id(a.inner[k].sample), m);
    }
  }

  /** Wheel arch: surrounding surface, the lip turned inwards, the housing over the tyre and its inner wall. */
  _arch(ctx, a, out) {
    const sk = ctx.skin, q = this.q, def = this.def;
    const body = def.matSide(a.z, a.y + a.radius + 0.03), lipMat = a.lipMat || body;
    this._archRing(ctx, a, (z, y) => def.matSide(z, y), lipMat);
    const well = out.well, n = a.inner.length, lip = q.level < 2 ? a.lip : 0, xin = a.xin;
    let pl = -1, pw0 = -1, pw1 = -1, pe = -1; const wall = [], drop = [];
    for (let k = 0; k < n; k++) {
      const p = a.inner[k].sample, rz = a.z - p[2], ry = a.y - p[1], l = Math.hypot(rz, ry) || 1, nz = rz / l, ny = ry / l;
      const e = sk.raw(p[0], p[1], p[2], 0, ny, nz, 0, 0, 0.9), le = sk.raw(p[0] - lip, p[1], p[2], 0, ny, nz, 0, 0, 0.6);
      const w0 = sk.raw(p[0] - lip, p[1], p[2], 0, ny, nz, 0, 0, 0.45), w1 = sk.raw(xin, p[1], p[2], 0, ny, nz, 0, 0, 0.18);
      // At its two feet the housing meets the floor, which lies a little below the seam: close the sliver with a fan.
      let wy = p[1];
      if (k === 0 || k === n - 1) {
        const row = a.pin ? this.B[a.ringFoot + (k === 0 ? 1 : 0)] : null;
        if (row) { wy = row[a.pin.k][1]; for (let m = 0; m < a.pin.k; m++) sk.tri(w1, sk.raw(row[m][0], row[m][1], row[m][2], 0, ny, nz, 0, 0, 0.3), sk.raw(row[m + 1][0], row[m + 1][1], row[m + 1][2], 0, ny, nz, 0, 0, 0.3), well); }
      }
      wall.push(sk.raw(xin, p[1], p[2], 1, 0, 0, 0, 0, 0.18)); if (wy !== p[1]) drop[k ? 1 : 0] = sk.raw(xin, wy, p[2], 1, 0, 0, 0, 0, 0.18);
      if (k) { if (lip) sk.quad(pe, e, le, pl, lipMat); sk.quad(pw0, w0, w1, pw1, well); }
      pe = e; pl = le; pw0 = w0; pw1 = w1;
    }
    // The inner wall follows the housing exactly and reaches down to the floor at the two feet.
    if (drop[1] !== undefined) wall.push(drop[1]); if (drop[0] !== undefined) wall.push(drop[0]);
    for (let k = 1; k < wall.length - 1; k++) sk.tri(wall[0], wall[k], wall[k + 1], well);
  }
}
