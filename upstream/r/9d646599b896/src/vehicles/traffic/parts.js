// Parts: everything fixed to a body shell that is not part of its skin. Lamp units, bumpers, brightwork,
// mirrors, wipers, plates and the pieces that make a taxi, a patrol car, a bus or a lorry.
//
// Functions that place lamps return where they put them; the anchors of the model are built from those
// same records, so a light can never drift away from its lens.

import { quad, box, sweep, roundRect, rod, disc, cap, lathe, vec, X, Y, Z } from './kit.js';
import * as mt from './materials.js';

const V = mt.VEHICLE;
const rowY = (shell, tag, z) => { const r = shell.def.rows.find((x) => x.tag === tag); return typeof r.y === 'function' ? r.y(z) : r.y; };
// Sealed-beam lens: vertical flutes crossed by the block lines of the moulding.
const headLens = mt.lens(V.LAMP_HEAD, [0.93, 0.9, 0.82], 4);
/** What is seen between the modelled bars of a grille: the dark, finely meshed face of the radiator. */
const radiatorCore = mt.grille(1, 0.7, [0.13, 0.13, 0.14]);
/** Painted bars of a grille that has no brightwork. */
const greyBar = mt.rim([0.42, 0.43, 0.45], 0.5, 0.2);

/** Floor material of one segment of a lamp panel. */
function segMat(g) {
  switch (g.kind) {
    case 'grille': return g.mat || (g.mat = mt.grille(g.pattern ?? 0, g.coarse ?? 2.5, g.color));
    case 'ind': return mt.lens(V.LAMP_INDICATOR_L, g.color || mt.C.amber, 1);
    case 'brake': return mt.lens(V.LAMP_BRAKE, mt.C.red, 1, 1);
    case 'tail': return mt.lens(V.LAMP_TAIL, mt.C.red, 1);
    case 'rev': return mt.lens(V.LAMP_REVERSE, mt.C.white, 2);
    case 'refl': return mt.lens(V.LAMP_MARKER, mt.C.red, 2);
    case 'panel': return g.mat;
    default: return g.mat || mt.blackTrim;
  }
}

/**
 * Recessed panel across one end of a body between two key rows, divided from the outside inwards into
 * segments: spec = { rows: [low, high], depth, margin, wall, segs: [{ w, kind, ... }] }. A last segment
 * without a width runs to the centre line. Registers the recess on the shell (before layout) and returns
 * one record per segment: { kind, x0, x1, y0, y1, pos (centre of its floor), n }.
 */
export function endPanel(shell, end, spec, tag) {
  const zEnd = end > 0 ? shell.zF : shell.zR, y0 = rowY(shell, spec.rows[0], zEnd), y1 = rowY(shell, spec.rows[1], zEnd);
  const s = shell.faceS(end, (y0 + y1) / 2), F = shell.frame(s), bounds = [F.xB - (spec.margin ?? 0.02)];
  for (const g of spec.segs) bounds.push(g.w === undefined ? 0 : bounds[bounds.length - 1] - g.w);
  const face = end > 0 ? 'front' : 'rear', lo = { [face]: spec.rows[0] }, hi = { [face]: spec.rows[1] }, from = end > 0 ? hi : lo, to = end > 0 ? lo : hi;
  // A line between two segments of one kind only matters where the dividers are modelled.
  const same = (k) => k > 0 && k < spec.segs.length && spec.segs[k - 1].kind === spec.segs[k].kind;
  bounds.forEach((b, k) => { if (b > 0) shell.def.pins[tag + k] = { from, to, x: (Fr) => Fr.xB - (F.xB - b), lod: same(k) ? Math.min(1, spec.lod ?? 1) : spec.lod }; });
  const last = bounds[bounds.length - 1] > 0 ? tag + (bounds.length - 1) : 'centre', mats = spec.segs.map(segMat);
  shell.bandBlock({ kind: 'recess', from, to, k0: tag + '0', k1: last, depth: spec.depth, lod: spec.lod, wall: spec.wall || mt.chrome, floor: (x) => {
    let k = 0; while (k < mats.length - 1 && x < bounds[k + 1]) k++;
    // From far away a pair of headlamps is one bright patch: the panel itself takes the lens material there.
    if (shell.q.level === 2 && spec.segs[k].kind === 'lamps') return headLens;
    // Where the bars of a grille are modelled (see grilleBars) its floor is what lies behind them.
    return shell.q.level === 0 && spec.segs[k].kind === 'grille' ? radiatorCore : mats[k];
  } });
  return spec.segs.map((g, k) => {
    const P = shell.bandAt(s, (bounds[k] + bounds[k + 1]) / 2), d = spec.depth;
    return { ...g, shell, end, depth: d, bright: !spec.wall || spec.wall === mt.chrome, x0: bounds[k + 1], x1: bounds[k], y0, y1, pos: [P[0] - P[3] * d, P[1] - P[4] * d, P[2] - P[5] * d], n: [P[3], P[4], P[5]] };
  });
}

/** A point of a panel segment: x across, y up, `below` metres under the body surface (the floor lies `depth` under it). */
const onPanel = (seg) => (x, y, below) => { const sh = seg.shell, P = sh.bandAt(sh.faceS(seg.end, y), x); return [P[0] - P[3] * below, P[1] - P[4] * below, P[2] - P[5] * below]; };

/**
 * A straight bar standing on a panel segment from a to b (each [x, y]): t wide, its face `top` metres under
 * the body surface (negative: standing proud of it) and its flanks reaching down to `base`. Only the face and
 * the two flanks are built, since its ends always run into a wall or another bar.
 */
function panelBar(sk, m, seg, a, b, t, top, base = seg.depth, n = 1) {
  const at = onPanel(seg), l = Math.hypot(b[0] - a[0], b[1] - a[1]), px = -(b[1] - a[1]) / l * t / 2, py = (b[0] - a[0]) / l * t / 2;
  for (let k = 0; k < n; k++) {
    const p = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], q = [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n];
    const pl = at(p[0] + px, p[1] + py, top), pr = at(p[0] - px, p[1] - py, top), ql = at(q[0] + px, q[1] + py, top), qr = at(q[0] - px, q[1] - py, top);
    const side = vec.unit(vec.sub(pl, pr)), dark = [1, 1, 0.4, 0.4];
    quad(sk, m, [pl, pr, qr, ql], seg.n);
    quad(sk, m, [pl, ql, at(q[0] + px, q[1] + py, base), at(p[0] + px, p[1] + py, base)], side, null, dark);
    quad(sk, m, [pr, qr, at(q[0] - px, q[1] - py, base), at(p[0] - px, p[1] - py, base)], vec.scale(side, -1), null, dark);
  }
}

// Pitch and bar width of the grille patterns as the shader draws them, so that the modelled bars of the nearest
// level stand where the drawn ones of the next level are.
const GRILLE_PITCH = [0.014, 0.009, 0.011, 0.014], GRILLE_DUTY = [0.4, 0.24, 0.3, 0.4];

/**
 * The bars of a radiator grille, modelled at the nearest level: a surround standing a little proud of the body
 * and, set back inside it, horizontal bars (pattern 0), an egg crate (1) or vertical bars (3).
 */
export function grilleBars(sk, g, lv) {
  if (lv > 0 || g.kind !== 'grille') return;
  const kind = g.pattern ?? 0, pitch = GRILLE_PITCH[kind] * (g.coarse ?? 2.5), t = pitch * GRILLE_DUTY[kind], fr = g.bright ? 0.016 : 0.012;
  const m = g.bars || (g.bright ? mt.chrome : greyBar), edge = g.bright ? mt.chrome : mt.blackTrim, across = Math.max(2, Math.ceil(g.x1 / 0.3));
  const x1 = g.x1 - fr, ya = g.y0 + fr, yb = g.y1 - fr, top = 0.007;
  panelBar(sk, edge, g, [g.x0, g.y1 - fr / 2], [g.x1, g.y1 - fr / 2], fr, -0.003, g.depth, across);
  panelBar(sk, edge, g, [g.x0, g.y0 + fr / 2], [g.x1, g.y0 + fr / 2], fr, -0.003, g.depth, across);
  panelBar(sk, edge, g, [g.x1 - fr / 2, ya], [g.x1 - fr / 2, yb], fr, -0.003);
  if (kind !== 3) { const rows = Math.max(1, Math.round((yb - ya) / pitch)), step = (yb - ya) / rows; for (let k = 1; k < rows; k++) panelBar(sk, m, g, [g.x0, ya + k * step], [x1, ya + k * step], t, top, g.depth, across); }
  if (kind !== 0) for (let x = g.x0 + pitch / 2; x < x1 - t; x += pitch) panelBar(sk, m, g, [x, ya], [x, yb], t, top + 0.001);
  // A grille of plain horizontal bars is stiffened by a few uprights behind them.
  else for (let x = g.x0 + 0.11; x < x1 - 0.05; x += 0.22) panelBar(sk, edge, g, [x, ya], [x, yb], 0.01, top + 0.006);
}

/** Bright frame round the lamps of a tail panel, standing just proud of the body where the recess meets it. */
export function clusterFrame(sk, segs, lv) {
  const lamps = segs.filter((g) => g.bright && ['brake', 'tail', 'ind', 'rev', 'refl'].includes(g.kind));
  if (lv > 0 || !lamps.length) return;
  const g = lamps[0], xa = Math.min(...lamps.map((q) => q.x0)), xb = Math.max(...lamps.map((q) => q.x1)), t = 0.012;
  panelBar(sk, mt.chrome, g, [xa, g.y1], [xb + t / 2, g.y1], t, -0.003, 0.001);
  panelBar(sk, mt.chrome, g, [xa, g.y0], [xb + t / 2, g.y0], t, -0.003, 0.001);
  panelBar(sk, mt.chrome, g, [xb, g.y0], [xb, g.y1], t, -0.003, 0.001);
  if (xa > 0.01) panelBar(sk, mt.chrome, g, [xa, g.y0], [xa, g.y1], t, -0.003, 0.001);
}

/**
 * Divide a lamp segment into cells stacked from the bottom up: cells = [{ kind, h (share of the height) }].
 * The segment's own floor shows through cells of its own kind; every other cell is a lens laid just above
 * it. Bright bars part the cells at the nearest level. Returns [{ kind, pos }] for the anchors.
 */
export function lampCells(sk, seg, cells, lv) {
  const total = cells.reduce((a, c) => a + c.h, 0), out = [], sh = seg.shell, lift = seg.depth - 0.003;
  const at = (x, y) => { const P = sh.bandAt(sh.faceS(seg.end, y), x); return [P[0] - P[3] * lift, P[1] - P[4] * lift, P[2] - P[5] * lift]; };
  let y = seg.y0;
  cells.forEach((c, k) => {
    const y1 = y + (seg.y1 - seg.y0) * c.h / total, mid = at((seg.x0 + seg.x1) / 2, (y + y1) / 2);
    out.push({ kind: c.kind, pos: mid });
    if (c.kind !== seg.kind && lv < 2) {
      const P = [at(seg.x0, y), at(seg.x1, y), at(seg.x1, y1), at(seg.x0, y1)];
      quad(sk, segMat(c), seg.end > 0 ? P : [P[1], P[0], P[3], P[2]], seg.n, [[0, 0], [seg.x1 - seg.x0, 0], [seg.x1 - seg.x0, y1 - y], [0, y1 - y]]);
    }
    if (k && lv === 0) box(sk, mt.chrome, at((seg.x0 + seg.x1) / 2, y), [(seg.x1 - seg.x0) / 2, 0.004, 0.004], { skip: seg.end > 0 ? 'z' : 'Z' });
    y = y1;
  });
  return out;
}

/** A lamp lens standing on a flat face that looks along z (a bumper bar, a valance): returns its centre for the anchors. */
export function faceLamp(sk, c, w, h, end, m, lv) {
  if (lv < 2) box(sk, m, [c[0], c[1], c[2] - end * 0.004], [w / 2, h / 2, 0.006], { skip: end > 0 ? 'z' : 'Z' });
  // From far away only its colour is left, as a flat patch just clear of the face.
  else { const z = c[2] + end * 0.004, a = end * w / 2; quad(sk, m, [[c[0] - a, c[1] - h / 2, z], [c[0] + a, c[1] - h / 2, z], [c[0] + a, c[1] + h / 2, z], [c[0] - a, c[1] + h / 2, z]], [0, 0, end]); }
  return [c[0], c[1], c[2] + end * 0.002];
}

/** A round lamp in a bright ring on a face that looks along z: returns its centre for the anchors. */
export function roundLamp(sk, c, r, end, m, lv) {
  const n = [0, 0, end], o = [c[0], c[1], c[2] + end * 0.006], segs = lv === 0 ? 14 : lv === 1 ? 8 : 4;
  cap(sk, m, o, n, X, Y, r * 0.84, segs);
  if (lv < 2) { disc(sk, mt.chrome, o, n, X, Y, r, segs, 1, r * 0.84); rod(sk, mt.chrome, [c[0], c[1], c[2]], o, r, segs, false, 0.8); }
  return o;
}

/** Lens rectangles of the headlamps inside a 'lamps' segment: [{ c: [x, y, z], w, h }], z on the lens face. */
export function headlampLenses(seg) {
  const quadLamp = seg.lamps === 'quad', w = quadLamp ? 0.165 : 0.2, h = quadLamp ? 0.1 : 0.142, bez = 0.012, n = quadLamp ? 2 : 1;
  const y = (seg.y0 + seg.y1) / 2, z = seg.pos[2] + seg.depth - 0.008, pitch = w + 2 * bez + 0.004, x1 = seg.x1 - 0.006 - bez - w / 2, out = [];
  // The bright lamp door fills the height of the panel, as the surround of a sealed beam did.
  const bezY = Math.max(bez, (seg.y1 - seg.y0 - h) / 2 - 0.003);
  for (let k = 0; k < n; k++) out.push({ c: [x1 - k * pitch, y, z], w, h, bez, bezY, back: seg.depth - 0.008 });
  return out;
}

/** One rectangular sealed-beam unit facing forwards: bright bezel, the aluminised bowl showing round the edge, and the moulded lens. */
export function sealedBeam(sk, L, lv) {
  const [cx, cy, cz] = L.c, hw = L.w / 2, hh = L.h / 2, b = L.bez;
  if (lv === 2) return;   // the lamp panel itself is lens-coloured at this distance (see endPanel)
  const ring = (ow, oh, iw, ih, zo, zi, m, nIn) => {
    const o = [[-ow, -oh], [ow, -oh], [ow, oh], [-ow, oh]], i = [[-iw, -ih], [iw, -ih], [iw, ih], [-iw, ih]], nn = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let k = 0; k < 4; k++) {
      const k1 = (k + 1) % 4, n = nIn === null ? Z : vec.unit([-nn[k][0] * nIn, -nn[k][1] * nIn, 1]);
      quad(sk, m, [[cx + o[k][0], cy + o[k][1], zo], [cx + o[k1][0], cy + o[k1][1], zo], [cx + i[k1][0], cy + i[k1][1], zi], [cx + i[k][0], cy + i[k][1], zi]], n);
    }
  };
  const by = L.bezY, set = lv === 0 ? 0.005 : 0;   // the door dishes in towards the lamp
  ring(hw + b, hh + by, hw + 0.003, hh + 0.003, cz, cz - set, mt.chrome, lv === 0 ? 0.3 : null);
  if (lv === 0) {
    ring(hw + 0.003, hh + 0.003, hw - 0.004, hh - 0.004, cz - set, cz - set - 0.008, mt.reflector, 1);
    box(sk, mt.chrome, [cx, cy, cz - L.back / 2], [hw + b, hh + by, L.back / 2], { skip: 'zZ', occ: 0.7 });
  }
  // The lens bulges a few millimetres; its texture coordinates are metres from the middle, where the optics are centred.
  const nx = lv === 0 ? 4 : 1, ny = lv === 0 ? 2 : 1, iw = hw - (lv === 0 ? 0.004 : -0.003), ih = hh - (lv === 0 ? 0.004 : -0.003), zb = lv === 0 ? cz - set - 0.008 : cz - 0.001, ids = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const u = (i / nx) * 2 - 1, v = (j / ny) * 2 - 1, dome = 0.007 * (1 - u * u) * (1 - v * v), n = vec.unit([u * 0.12, v * 0.1, 1]);
    ids.push(sk.raw(cx + u * iw, cy + v * ih, zb + dome, n[0], n[1], n[2], u * iw, v * ih, 1));
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const a = j * (nx + 1) + i; sk.quad(ids[a], ids[a + 1], ids[a + nx + 2], ids[a + nx + 1], headLens); }
}

/** Bright dividers between the segments of a lamp panel. */
export function panelDividers(sk, segs, lv, mat = mt.chrome) {
  if (lv > 0) return;
  for (let k = 0; k < segs.length - 1; k++) {
    const g = segs[k], s = g.end;
    if (g.kind === segs[k + 1].kind && !g.split) continue;
    box(sk, mat, [g.x0, (g.y0 + g.y1) / 2, g.pos[2] + s * g.depth / 2], [0.005, (g.y1 - g.y0) / 2, g.depth / 2 - 0.001], { skip: s > 0 ? 'zyY' : 'ZyY' });
  }
}

/**
 * Half of a bumper bar: across the car from the centre line, round the corner and back along the body side.
 * b = { y, h, depth, wrap, radius, bow, mat, strip, guard, half (half width) }; end +1 front, -1 rear; face = z of its outer face.
 */
export function bumper(sk, b, end, face, lv) {
  const xe = b.half, rc = b.radius ?? 0.07, bow = b.bow ?? 0.03, zAt = (x) => face - end * bow * (x / xe) * (x / xe);
  const path = [], nArc = lv === 0 ? 5 : lv === 1 ? 2 : 1, nRun = lv === 0 ? 4 : lv === 1 ? 2 : 1;
  for (let k = 0; k <= nRun; k++) { const x = (xe - rc) * k / nRun, sl = -end * 2 * bow * x / (xe * xe), n = vec.unit([-sl * end, 0, 1]); path.push({ p: [x, zAt(x)], n: [n[0], end * n[2]] }); }
  const zc = zAt(xe - rc) - end * rc;
  for (let k = 1; k <= nArc; k++) { const t = (Math.PI / 2) * k / nArc; path.push({ p: [xe - rc + rc * Math.sin(t), zc + end * rc * Math.cos(t)], n: [Math.sin(t), end * Math.cos(t)] }); }
  path.push({ p: [xe, zc - end * b.wrap], n: [1, 0] });
  const frames = (inset, d) => path.map((q) => ({ o: [q.p[0] + q.n[0] * (inset - d / 2), b.y, q.p[1] + q.n[1] * (inset - d / 2)], a: [q.n[0], 0, q.n[1]], b: Y }));
  const d = b.depth, steps = lv === 0 ? 3 : lv === 1 ? 1 : 0;
  sweep(sk, b.mat, frames(0, d), roundRect(d, b.h, Math.min(0.028, b.h * 0.3), steps), { caps: '1' });
  if (b.strip && lv < 2) sweep(sk, mt.rubber, frames(0.006, 0.014), roundRect(0.014, b.strip, 0.004, 0), { caps: '1' });
  if (b.guard && lv < 2) box(sk, b.mat, [b.guard, b.y, face + end * 0.012], [0.028, b.h / 2 + 0.03, 0.03], { mats: { [end > 0 ? 'Z' : 'z']: mt.rubber } });
}

/**
 * A strip running along a body side at height yOf(z): a moulding standing `proud` of the panel, or with
 * `flat` a painted stripe lying on it. It stops at wheel arches (listed as { z, y, r }).
 */
export function sideStrip(sk, m, shell, yOf, z0, z1, { h = 0.03, proud = 0.008, flat = false, arches = [], step = 0.3, uvScale = 0 } = {}) {
  const runs = []; let cur = null;
  const inArch = (z) => arches.some((a) => { const dy = yOf(z) - a.y; return dy < a.r && Math.abs(z - a.z) < Math.sqrt(Math.max(0, a.r * a.r - dy * dy)) + 0.015; });
  const zs = [];
  for (let z = z0; z < z1 - 1e-6;) { zs.push(z); const near = Math.min(z - (shell.zR ?? z0), (shell.zF ?? z1) - z); z += near < 0.3 ? 0.05 : Math.min(step, Math.max(0.05, near - 0.28)); }
  zs.push(z1);
  for (const a of arches) { const dy = yOf(a.z) - a.y; if (dy < a.r) { const w = Math.sqrt(a.r * a.r - dy * dy) + 0.016; zs.push(a.z - w, a.z + w); } }
  zs.sort((a, b) => a - b);
  for (const z of zs) { if (z < z0 - 1e-6 || z > z1 + 1e-6) continue; if (inArch(z)) { cur = null; continue; } if (!cur) { cur = []; runs.push(cur); } if (!cur.length || z - cur[cur.length - 1] > 0.004) cur.push(z); }
  for (const run of runs) {
    if (run.length < 2) continue;
    const rows = run.map((z, k) => {
      const y = yOf(z), S = shell.sideAt(z, y), n = [S[3], S[4], S[5]], up = vec.unit(vec.cross(n, vec.unit(vec.cross(Y, n)))), yy = up[1] < 0 ? vec.scale(up, -1) : up;
      const tip = !flat && (k === 0 || k === run.length - 1) ? 0 : 1, P = (da, db) => [S[0] + n[0] * da + yy[0] * db, S[1] + n[1] * da + yy[1] * db, S[2] + n[2] * da + yy[2] * db];
      const node = (da, db, nn) => { const q = P(da, db); return sk.raw(q[0], q[1], q[2], nn[0], nn[1], nn[2], uvScale ? z : 0, uvScale ? db : 0, 1); };
      if (flat) return [node(proud, -h / 2, n), node(proud, h / 2, n)];
      const e = proud * tip, lowN = vec.unit(vec.mad(n, yy, -1.2)), highN = vec.unit(vec.mad(n, yy, 1.2));
      return [node(0, -h / 2, lowN), node(e, -h / 2 + proud * 0.7, lowN), node(e, -h / 2 + proud * 0.7, n), node(e, h / 2 - proud * 0.7, n), node(e, h / 2 - proud * 0.7, highN), node(0, h / 2, highN)];
    });
    for (let k = 0; k < rows.length - 1; k++) for (let j = 0; j < rows[k].length - 1; j += flat ? 1 : 2) sk.quad(rows[k][j], rows[k][j + 1], rows[k + 1][j + 1], rows[k + 1][j], m);
  }
}

/**
 * Local frame on a body side at (z, y): P(out, up, along) is a point `out` metres off the panel, and ax the
 * three unit vectors [outwards, up the panel, forwards along it] for boxes laid on it.
 */
function onSide(shell, z, y) {
  const S = shell.sideAt(z, y), n = [S[3], S[4], S[5]], fwd = vec.unit(vec.cross(n, Y)), up = vec.cross(fwd, n);
  return { n, up, fwd, ax: [n, up, fwd], P: (a, b, c) => [S[0] + n[0] * a + up[0] * b + fwd[0] * c, S[1] + n[1] * a + up[1] * b + fwd[1] * c, S[2] + n[2] * a + up[2] * b + fwd[2] * c] };
}
const pocket = mt.trim(0.9, [0.02, 0.02, 0.02]);
/**
 * Flat patch standing a hair off a panel, with walls down into the panel all round. Without the walls the
 * underside of the patch shows past the silhouette wherever the panel curves away beneath it.
 * `top` and `sunk` are matching outlines above and below the panel surface.
 */
function patch(sk, m, top, sunk, n, occ = 1) {
  const mid = [0, 1, 2].map((k) => top.reduce((a, p) => a + p[k], 0) / top.length), c = sk.raw(...mid, ...n, 0, 0, occ), ids = top.map((p) => sk.raw(...p, ...n, 0, 0, occ));
  top.forEach((p, i) => {
    const j = (i + 1) % top.length, out = vec.unit(vec.sub(vec.scale(vec.add(p, top[j]), 0.5), mid));
    sk.tri(c, ids[i], ids[j], m); quad(sk, m, [p, top[j], sunk[j], sunk[i]], out, null, occ);
  });
}

/**
 * Door handle of the lift-up kind: a bright bezel round a dark pocket, the upper half of which is covered by
 * the flap the fingers go under. `lock` adds the key cylinder below it. Further away it is one bright bar.
 */
export function doorHandle(sk, shell, z, y, lv, lock = false) {
  if (lv === 2) return;
  const F = onSide(shell, z, y), hw = 0.062, hh = 0.025, t = 0.005, d = 0.005;
  if (lv === 1) { box(sk, mt.chrome, F.P(0.003, 0, 0), [0.003, hh - 0.004, hw], { ax: F.ax, skip: 'x' }); return; }
  box(sk, mt.chrome, F.P(d / 2, hh - t / 2, 0), [d / 2, t / 2, hw], { ax: F.ax, skip: 'x' });
  box(sk, mt.chrome, F.P(d / 2, -hh + t / 2, 0), [d / 2, t / 2, hw], { ax: F.ax, skip: 'x' });
  for (const e of [-1, 1]) box(sk, mt.chrome, F.P(d / 2, 0, e * (hw - t / 2)), [d / 2, hh - t, t / 2], { ax: F.ax, skip: 'xyY' });
  const wi = hw - t, top = hh - t, edge = -0.004;
  quad(sk, pocket, [F.P(0.0008, -top, -wi), F.P(0.0008, -top, wi), F.P(0.0008, edge, wi), F.P(0.0008, edge, -wi)], F.n, null, [0.5, 0.5, 0.2, 0.2]);
  // The flap is hinged along its top edge and stands a little open at the bottom, which is where its shadow falls.
  quad(sk, mt.chrome, [F.P(0.0035, top, -wi), F.P(0.0035, top, wi), F.P(0.0065, edge, wi), F.P(0.0065, edge, -wi)], vec.unit(vec.mad(F.n, F.up, 0.14)));
  quad(sk, mt.chrome, [F.P(0.0065, edge, -wi), F.P(0.0065, edge, wi), F.P(0.0008, edge, wi), F.P(0.0008, edge, -wi)], vec.scale(F.up, -1), null, [0.8, 0.8, 0.2, 0.2]);
  if (lock) { const c = F.P(0.003, -hh - 0.034, -hw + 0.018); rod(sk, mt.chrome, F.P(0, -hh - 0.034, -hw + 0.018), c, 0.011, 8, false); disc(sk, mt.chrome, c, F.n, F.up, F.fwd, 0.011, 8); }
}

/**
 * A maker's emblem without lettering, at the nearest level only: e = { z, y, kind }. 'bar' is a bright strip
 * with a block beside it (the trim-level badge on a wing), 'crest' a small shield with an enamelled middle
 * (on the sail panel of a formal roof), 'plaque' a framed black tablet (vans and lorries).
 */
export function emblem(sk, shell, e) {
  const F = onSide(shell, e.z, e.y);
  if (e.kind === 'crest') {
    const w = 0.02, h = 0.027, shape = [[h, -w], [h, w], [-h * 0.25, w], [-h, 0], [-h * 0.25, -w]];
    const fan = (m, k, a) => patch(sk, m, shape.map(([b, cc]) => F.P(a, b * k, cc * k)), shape.map(([b, cc]) => F.P(-0.004, b * k, cc * k)), F.n);
    fan(mt.chrome, 1, 0.002); fan(mt.fixed([0.32, 0.03, 0.05]), 0.68, 0.0028);
  } else if (e.kind === 'plaque') {
    box(sk, mt.chrome, F.P(0.0015, 0, 0), [0.0015, 0.019, 0.06], { ax: F.ax, skip: 'x' });
    quad(sk, pocket, [F.P(0.0036, -0.014, -0.055), F.P(0.0036, -0.014, 0.055), F.P(0.0036, 0.014, 0.055), F.P(0.0036, 0.014, -0.055)], F.n);
    box(sk, mt.chrome, F.P(0.0045, 0, 0), [0.001, 0.004, 0.04], { ax: F.ax, skip: 'x' });
  } else {
    box(sk, mt.chrome, F.P(0.0015, 0, 0.012), [0.0015, 0.006, 0.045], { ax: F.ax, skip: 'x' });
    box(sk, mt.chrome, F.P(0.0015, 0, -0.052), [0.0015, 0.009, 0.009], { ax: F.ax, skip: 'x' });
  }
}

/** Fuel filler door: its shut line as a dark outline lying on the panel, with the finger notch at its rear edge. */
export function fillerDoor(sk, shell, z, y) {
  const w = 0.075, h = 0.062, t = 0.0025, at = (zz, yy, a) => { const S = shell.sideAt(zz, yy); return [S[0] + S[3] * a, S[1] + S[4] * a, S[2] + S[5] * a]; };
  const n = onSide(shell, z, y).n, ring = (z0, y0, z1, y1, a) => [at(z0, y0, a), at(z1, y0, a), at(z1, y1, a), at(z0, y1, a)];
  const line = (z0, y0, z1, y1) => patch(sk, pocket, ring(z0, y0, z1, y1, 0.0007), ring(z0, y0, z1, y1, -0.003), n, 0.3);
  line(z - w, y - h - t, z + w, y - h + t); line(z - w, y + h - t, z + w, y + h + t);
  line(z - w - t, y - h, z - w + t, y + h); line(z + w - t, y - h, z + w + t, y + h);
  line(z - w - 0.012, y - 0.014, z - w, y + 0.014);
}

/** Radio aerial on a wing: a thin mast leaning back from a bright foot. `at` is its foot on the panel. */
export function aerial(sk, at, lv, len) {
  const [x, y, z] = at, tip = [x, y + len * 0.985, z - len * 0.17];
  rod(sk, mt.chrome, [x, y - 0.01, z], tip, 0.003, lv === 0 ? 5 : 3, lv === 0, 1);
  if (lv === 0) lathe(sk, mt.chrome, [x, y - 0.004, z], Y, X, Z, [{ r: 0.013, h: 0, nr: 0.6, nh: 0.8 }, { r: 0.008, h: 0.014, nr: 0.8, nh: 0.6 }, { r: 0.004, h: 0.03, nr: 1, nh: 0.2 }], 8);
}

/** Stand-up bonnet ornament on the centre line: a foot and a slim upright ring seen edge-on from the side. */
export function bonnetOrnament(sk, at, lv) {
  const [x, y, z] = at;
  box(sk, mt.chrome, [x, y + 0.003, z], [0.011, 0.006, 0.022], { skip: 'y' });
  if (lv === 0) { rod(sk, mt.chrome, [x, y + 0.006, z], [x, y + 0.03, z], 0.004, 5, false); box(sk, mt.chrome, [x, y + 0.045, z], [0.017, 0.017, 0.003], { ax: [vec.unit([1, 1, 0]), vec.unit([-1, 1, 0]), Z] }); }
}

/** Boot lid fittings on the plain middle segment of a tail panel: the lock in the middle and an emblem bar to the right of it. */
export function tailBadge(sk, g) {
  const at = onPanel(g), y = (g.y0 + g.y1) / 2, c0 = at(0, y, g.depth), c1 = at(0, y, g.depth - 0.004);
  rod(sk, mt.chrome, c0, c1, 0.014, 10, false); disc(sk, mt.chrome, c1, vec.unit([0, g.n[1], g.n[2]]), X, Y, 0.014, 10);
  const b = at(Math.max(0.12, g.x1 - 0.14), g.y1 - 0.045, g.depth - 0.0015);
  box(sk, mt.chrome, [-b[0], b[1], b[2]], [0.055, 0.007, 0.0015], { skip: g.end > 0 ? 'z' : 'Z' });
}

/** Mud flap hanging behind a wheel: c is the middle of its top edge. */
export function mudFlap(sk, c, w, h) { box(sk, mt.rubber, [c[0], c[1] - h / 2, c[2]], [w / 2, h / 2, 0.005], { skip: 'Y' }); }

/** Door mirror on a short arm; the glass faces rearwards. */
export function doorMirror(sk, at, lv, m = mt.chrome) {
  if (lv === 2) return;
  const [x, y, z] = at;
  box(sk, m, [x + 0.035, y - 0.02, z], [0.035, 0.012, 0.014], { skip: 'x' });
  box(sk, m, [x + 0.115, y + 0.01, z], [0.07, 0.047, 0.026], { mats: { z: mt.chrome } });
}

/** Small marker lamp on a body side. */
export function sideMarker(sk, shell, z, y, color, lv, w = 0.12, h = 0.04) {
  if (lv === 2) return;
  const S = shell.sideAt(z, y);
  box(sk, mt.lens(V.LAMP_MARKER, color, 1), [S[0] + 0.003, y, z], [0.006, h / 2, w / 2], { skip: 'x' });
}

/** Rear number plate with its frame. `seed` picks the registration. */
export function plate(sk, c, seed, lv) {
  const [x, y, z] = c, hw = 0.1525, hh = 0.076, m = mt.vmat(V.PLATE, 1, seed & 255, 0, mt.C.plate);
  if (lv < 2) box(sk, mt.blackTrim, [x, y, z + 0.006], [hw + 0.008, hh + 0.008, 0.005], { skip: 'Z' });
  // Seen from behind, the car's left (+X) is on the reader's left.
  quad(sk, m, [[x + hw, y - hh, z], [x - hw, y - hh, z], [x - hw, y + hh, z], [x + hw, y + hh, z]], [0, 0, -1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
}

/** Tail pipe; returns the anchor record of its mouth. */
export function exhaust(sk, x, y, z0, z1, lv, r = 0.024) {
  // The mouth is a bright rim round a black disc: the bore itself is never seen, so it is not modelled.
  if (lv < 2) {
    const n = lv === 0 ? 10 : 6, back = [0, 0, -1], tip = lv === 0 ? r * 1.2 : r, m = lv === 0 ? mt.chrome : mt.dullMetal;
    rod(sk, mt.dullMetal, [x, y, z0], [x, y, z1], r, n, false, 0.8);
    // A bright sleeve over the last few centimetres of the pipe.
    if (lv === 0) { rod(sk, m, [x, y, z1 + 0.075], [x, y, z1 - 0.004], tip, n, false); disc(sk, m, [x, y, z1 + 0.075], Z, X, Y, tip, n, 0.8, r); }
    disc(sk, m, [x, y, z1 - (lv === 0 ? 0.004 : 0)], back, X, Y, tip, n, 0.8, r * 0.8); disc(sk, mt.trim(0.9, [0.01, 0.01, 0.01]), [x, y, z1], back, X, Y, lv === 0 ? tip * 0.99 : r * 0.8, n, 0.3);
  }
  return { pos: [x, y, z1], dir: [0, 0, -1] };
}

/** A windscreen wiper lying along the base of the glass: P0 and P1 are the ends of the blade just above the glass, pivot is on the cowl. */
export function wiper(sk, P0, P1, n, pivot) {
  const along = vec.unit(vec.sub(P1, P0)), up = vec.unit(vec.cross(n, along)), len = Math.hypot(...vec.sub(P1, P0)), mid = vec.mad(P0, along, len / 2), c = vec.mad(mid, n, 0.012);
  box(sk, mt.blackTrim, c, [len / 2, 0.006, 0.007], { ax: [along, up, n] });
  const armTo = vec.mad(mid, n, 0.022), d = vec.sub(armTo, pivot), al = Math.hypot(...d), a0 = vec.unit(d), a1 = vec.unit(vec.cross(n, a0));
  box(sk, mt.trim(0.4), vec.mad(pivot, a0, al / 2), [al / 2, 0.005, 0.004], { ax: [a0, a1, vec.cross(a0, a1)] });
}

/** Steering wheel with two spokes and its column; `c` is the hub, `ax` points at the driver. */
export function steeringWheel(sk, c, ax, lv, m) {
  const u = X, v = vec.unit(vec.cross(ax, u)), R = 0.19, r = 0.014, prof = [], n = lv === 0 ? 6 : 4;
  for (let k = 0; k <= n; k++) { const t = (k / n) * 2 * Math.PI; prof.push({ r: R + r * Math.cos(t), h: r * Math.sin(t), nr: Math.cos(t), nh: Math.sin(t) }); }
  lathe(sk, m, c, ax, u, v, prof, lv === 0 ? 18 : 10);
  box(sk, m, vec.mad(c, ax, -0.02), [R, 0.022, 0.008], { ax: [u, v, ax] });
  rod(sk, m, vec.mad(c, ax, -0.02), vec.mad(c, ax, -0.3), 0.03, 8, false);
  box(sk, m, vec.mad(c, ax, -0.012), [0.05, 0.045, 0.02], { ax: [u, v, ax] });
}

/** Roof light bar of a patrol car: black base, five lens segments across, the lit faces flashing in two alternating groups. */
export function lightbar(sk, c, w, d, h, lv) {
  const [x, y, z] = c, cols = [[0.85, 0.125, 0.1], [0.12, 0.31, 0.78], [0.95, 0.95, 0.94], [0.12, 0.31, 0.78], [0.85, 0.125, 0.1]], sw = w / 5;
  box(sk, mt.blackTrim, [x, y + 0.015, z], [w / 2 + 0.01, 0.015, d / 2 + 0.01]);
  cols.forEach((col, k) => box(sk, mt.vmat(V.LIGHTBAR, k % 2, 0, 0, col), [x + (k - 2) * sw, y + 0.03 + (h - 0.03) / 2, z], [sw / 2 - (lv === 0 ? 0.004 : 0), (h - 0.03) / 2, d / 2], { skip: 'y' }));
  if (lv < 2) for (const sx of [-0.4, 0.4]) box(sk, mt.dullMetal, [x + sx * w, y - 0.02, z], [0.015, 0.025, 0.03], {});
}

/** Roof sign of a taxi: a box with translucent faces front and back. */
export function roofSign(sk, c, w, h, d, lv) {
  // The faces are marker-lamp lenses: plain coloured plastic by day, glowing once the car's lamps are on.
  const [x, y, z] = c, lit = mt.lens(V.LAMP_MARKER, [1, 0.86, 0.35], 0);
  box(sk, mt.fixed([0.95, 0.78, 0.2]), [x, y + h / 2 + 0.02, z], [w / 2, h / 2, d / 2], { mats: { Z: lit, z: lit } });
  if (lv < 2) box(sk, mt.blackTrim, [x, y + 0.01, z], [w / 2 + 0.01, 0.012, d / 2 + 0.01], { skip: 'y' });
}
