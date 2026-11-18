// The Thunderhead's wheel openings: round, with a narrow pressed lip. The sweep itself is the kit's.

import { VEHICLE } from '../../core/ids.js';
import { buildArch } from '../hero/kit/arch.js';
import { arc } from '../hero/kit/outline.js';
import * as S from './spec.js';
import { onSide, rowY, SILL_ROW, GLASS_ROW } from './body.js';

/** Opening outline in side view, from the front foot over the top to the rear foot. */
function opening(axleX, w, spacing) {
  const r = S.ARCH.radius, cy = w.axleY, foot = Math.asin((cy - S.GROUND_CLEARANCE) / r);
  return arc(axleX, cy, r, Math.PI + foot, -foot, Math.max(12, Math.round(r * (Math.PI + 2 * foot) / spacing)));
}

/** Both arches of the left side. quality: { arch: spacing of sections along the outline in mm, flare: sections across the lip's S }. */
export function buildArches(mb, hull, quality) {
  const body = {
    toCar: S.toCar,
    sideZ: (x, y) => { const c = onSide(hull, x, y); return hull.pos(c[0], c[1], [0, 0, 0])[0] / S.MM; },
    sideTop: (x) => rowY(hull, x, GLASS_ROW + 0.7),
    paint: (builder) => { builder.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); builder.color(1, 1, 1); builder.occlusion(1); },
  };
  const steps = { blendSteps: quality.flare, lipSteps: Math.ceil(quality.flare / 2) }, sill = (x) => rowY(hull, x, SILL_ROW);
  const common = { bottom: sill, band: () => S.ARCH.flare, face: S.ARCH.face, faceZ: S.ARCH.faceZ, linerZ: S.ARCH.linerZ, ...steps };
  return {
    front: buildArch(mb, body, { path: opening(S.FRONT_AXLE_X, S.WHEEL.front, quality.arch), ...common }),
    rear: buildArch(mb, body, { path: opening(S.REAR_AXLE_X, S.WHEEL.rear, quality.arch), ...common }),
  };
}
