// The tail spoiler: a flat tray over the engine lid with a turned-up rubber lip, a slatted intake in its top and a
// riser under it. One skin runs over the top, round the lip's edge and back along the underside.

import { VEHICLE } from '../../core/ids.js';
import { patch } from '../hero/kit/solids.js';
import * as S from './spec.js';
import { topPoint } from './shell.js';
import { fasciaStyles } from './fascia.js';

const MM = S.MM, P = S.SPOILER, clamp = (t) => Math.max(0, Math.min(1, t)), smooth = (t) => { const c = clamp(t); return c * c * (3 - 2 * c); };

/** Add the left half of the spoiler. quality: { hems } (false: the reduced model, without the intake's slats). */
export function buildSpoiler(mb, hull, quality) {
  const fine = quality.hems !== false, styles = fasciaStyles(mb), L = P.lip, G = P.grille;
  const hullY = (x, z) => topPoint(hull, Math.min(x, S.TAIL_X - 2), z)[1] / MM;
  const y0 = hullY(P.x0, 0), drop = (z) => y0 - hullY(P.x0, Math.min(z, P.z0 + 20));
  const edgeZ = (x) => {
    const t = clamp((x - P.x0) / (P.x1 - P.x0)), into = x - (P.x1 - P.corner);
    return P.z0 + (P.z1 - P.z0) * Math.pow(t, 0.85) - (into > 0 ? P.corner - Math.sqrt(Math.max(0, P.corner * P.corner - into * into)) : 0);
  };
  /** How near the edge a point is: 0 a lip's width in, 1 on the edge. */
  const nearEdge = (x, z) => Math.min(1, Math.hypot(clamp(1 - (edgeZ(x) - z) / L.width) * smooth((x - P.x0) / 150), clamp(1 - (P.x1 - x) / L.width)));
  const top = (x, z) => { const t = clamp((x - P.x0) / (P.x1 - P.x0)); return y0 + P.stand - P.fall * (x - P.x0) - drop(z) * (1 - t) * (1 - t) + L.rise * nearEdge(x, z) ** 2; };
  const under = (x, z) => top(x, z) - P.thick + (P.thick - P.edge) * smooth(nearEdge(x, z));
  const place = (x, y, z) => S.toCar(x - P.bow * (z / P.z1) ** 2 * clamp((x - P.x0) / (P.x1 - P.x0)), y, z);

  // rows: the front edge rolls up off the lid, then the top, then the rear lip
  const rows = [{ x: P.x0 - 10, lift: -22 }, { x: P.x0 - 9.5, lift: -9 }, { x: P.x0 - 6, lift: -3 }, { x: P.x0, lift: 0 }];
  if (fine) for (let x = G.x0; x <= G.x1 + 1e-6; x += G.pitch) rows.push({ x, lift: 0 }); else rows.push({ x: G.x0, lift: 0 }, { x: G.x1, lift: 0 });
  for (const d of fine ? [140, 110, 85, 64, 50, 40, 31, 23, 16, 10.5, 6, 3, 1.2, 0] : [110, 52, 26, 10, 0]) rows.push({ x: P.x1 - d, lift: 0 });
  rows.push({ x: P.x1 + 2.5, lift: 0, end: true });
  // columns: over the top to the edge, round it, back underneath
  const inner = [0, 110, 220, G.z, 400, 470], rim = fine ? [52, 42, 33, 25, 17, 10, 4.5, 1.2, 0] : [52, 26, 10, 0];
  const cols = [...inner.map((z) => ({ z: () => z, face: 1 })), ...rim.map((d) => ({ z: (x) => edgeZ(x) - d, face: 1, lip: d < L.width - 1 })),
    { z: (x) => edgeZ(x) + 2.5, face: 0, lip: true },
    ...(fine ? [0, 10, 25, 52] : [0, 52]).map((d) => ({ z: (x) => edgeZ(x) - d, face: -1, lip: true })), ...[470, 330, 110, 0].map((z) => ({ z: () => z, face: -1 }))];
  const jGrille = inner.indexOf(G.z);
  const grid = rows.map((r) => cols.map((c) => {
    const x = Math.min(r.x, P.x1), z = c.z(x), t = top(x, z), u = under(x, z);
    if (r.end) return place(r.x, (t + u) / 2, c.face === 0 ? z - 2.5 : z);
    return place(r.x, (c.face > 0 ? t : c.face < 0 ? u : (t + u) / 2) + (c.face > 0 ? r.lift : 0), z);
  }));
  patch(mb, grid, { flip: true, crease: 50, style: (i, j) => {
    const r = rows[i], c = cols[j], rearLip = P.x1 - rows[Math.min(i + 1, rows.length - 1)].x < L.width - 1;
    if (c.face > 0 && j < jGrille && r.x >= G.x0 - 1e-6 && r.x < G.x1 - 1e-6) return false;
    if (c.lip || rearLip) styles.rubber(); else if (c.face < 0) styles.black(); else styles.paint();
    return true;
  } });

  // the intake: a dark pocket with slats across the car
  const zs = inner.slice(0, jGrille + 1), line = (x, dy) => zs.map((z) => place(x, top(x, z) + dy, z));
  styles.black();
  patch(mb, [line(G.x0, 0), line(G.x0, -G.depth), line(G.x1, -G.depth), line(G.x1, 0)], { flip: true, crease: 30 });
  const side = []; for (let x = G.x0; x <= G.x1 + 1e-6; x += G.pitch * 2) side.push(x);
  patch(mb, [side.map((x) => place(x, top(x, G.z), G.z)), side.map((x) => place(x, top(x, G.z) - G.depth, G.z))], { facing: [-1, 0, 0], crease: 30 });
  if (fine) {
    mb.material(VEHICLE.TRIM_BLACK, 150, 0); mb.color(0.11, 0.11, 0.115); mb.occlusion(0.8);
    for (let x = G.x0; x < G.x1 - 1e-6; x += G.pitch) patch(mb, [line(x + 3, -G.depth + 1), line(x + 3, -1.5), line(x + 6, -1), line(x + 21, -G.depth + 2)], { flip: true, crease: 30 });
  }

  // the riser: walls from the lid up into the tray's underside
  const R = P.riser, outline = [];
  for (let i = 0; i <= 6; i++) { const k = i / 6; outline.push([R.x0 + (R.x1 - R.corner - R.x0) * k, R.z0 + (R.z1 - R.z0) * k]); }
  for (let i = 1; i <= 6; i++) { const a = i / 6 * Math.PI / 2; outline.push([R.x1 - R.corner + Math.sin(a) * R.corner, R.z1 - R.corner + Math.cos(a) * R.corner]); }
  for (const z of [300, 150, 0]) outline.push([R.x1, z]);
  styles.paint();
  patch(mb, [outline.map(([x, z]) => S.toCar(x, hullY(x, z) - 12, z)), outline.map(([x, z]) => S.toCar(x, under(x, z) + 4, z))], { facing: [0.3, 0, -1], crease: 50 });
}
