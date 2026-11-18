// The wheel arches: round openings centred on the axles. In front a flare stands 50 mm proud of the wing; behind,
// the wing itself swells out over the wheel (that is hull form) and the kit's band only adds the flat face beside the
// lip and the liner. The sweep is the kit's (hero/kit/arch.js).

import { VEHICLE } from '../../core/ids.js';
import { buildArch } from '../hero/kit/arch.js';
import { arc } from '../hero/kit/outline.js';
import * as S from './spec.js';
import { onSide } from './shell.js';
import { sillY } from './body.js';

/** Chart row under which the flares stay: the shoulder of the wings. */
const FLARE_TOP_ROW = S.RAIL.T2 + 0.2;

/** Opening outline in side view, from the front foot over the top to the rear foot. */
function opening(cx, cy, r, bottom, spacing) {
  const f0 = Math.asin(Math.min(0.9, (cy - bottom(cx - r)) / r)), f1 = Math.asin(Math.min(0.9, (cy - bottom(cx + r)) / r));
  return arc(cx, cy, r, Math.PI + f0, -f1, Math.max(12, Math.round(r * (Math.PI + f0 + f1) / spacing)));
}

/** Both arches of the left side. quality: { arch: spacing of sections along the outline in mm, flare: sections across the flare }. */
export function buildArches(mb, hull, quality) {
  const body = {
    toCar: S.toCar,
    sideZ: (x, y) => { const c = onSide(hull, x, y); return hull.sec(c[0], c[1])[0]; },
    sideTop: (x) => hull.sec(x, FLARE_TOP_ROW)[1],
    paint: (builder) => { builder.material(VEHICLE.PAINT, 0, 0); builder.color(1, 1, 1); builder.occlusion(1); },
  };
  const steps = { blendSteps: quality.flare, lipSteps: Math.ceil(quality.flare / 2) }, bottom = (x) => sillY(hull, Math.min(S.HULL_X1, Math.max(S.HULL_X0, x)));
  const F = S.FRONT_ARCH, R = S.REAR_ARCH;
  const front = buildArch(mb, body, {
    path: opening(S.FRONT_AXLE_X, S.WHEEL.front.axleY, F.radius, bottom, quality.arch), bottom,
    band: () => F.flare, face: F.face, faceZ: F.faceZ, linerZ: F.linerZ, ...steps,
  });
  const rear = buildArch(mb, body, {
    path: opening(S.REAR_AXLE_X, S.WHEEL.rear.axleY, R.radius, bottom, quality.arch), bottom,
    band: () => R.flare, face: R.face, faceZ: R.faceZ, linerZ: R.linerZ, ...steps,
  });
  return { front, rear };
}
