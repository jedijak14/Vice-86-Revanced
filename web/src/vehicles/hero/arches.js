// The Lucera's wheel arches: where the openings are, and how wide the flares stand. The sweep itself is kit/arch.js.

import { VEHICLE } from '../../core/ids.js';
import { buildArch } from './kit/arch.js';
import { arc, densify, roundCorners } from './kit/outline.js';
import * as S from './spec.js';
import { onSide, DOOR_TOP_ROW, SILL_ROW } from './body.js';
import { flankSkin, noseUnderside } from './fascia.js';

/** Opening outline of the front arch in side view, from the front foot over the top to the rear foot. */
export function frontOpening(spacing = 22) {
  const r = S.FRONT_ARCH.radius, cx = S.FRONT_AXLE_X, cy = S.WHEEL.front.axleY, foot = Math.asin((cy - S.GROUND_CLEARANCE) / r);
  return arc(cx, cy, r, Math.PI + foot, -foot, Math.max(12, Math.round(r * (Math.PI + 2 * foot) / spacing)));
}
/** Opening outline of the rear arch: the slanted trapezoid of the brief with rounded corners. */
export function rearOpening(spacing = 22) {
  return densify(roundCorners(S.REAR_ARCH.outline, S.REAR_ARCH.cornerRadius, { segs: 7 }), spacing);
}

/** Both arches of the left side. quality: { arch: spacing of sections along the outline in mm, flare: sections across the flare's S }. */
export function buildArches(mb, hull, quality) {
  // what the kit needs to know of this car: its frame, where its side is, where the side ends, and its paint
  const body = {
    toCar: S.toCar,
    sideZ: (x, y) => { const c = onSide(hull, x, y); return hull.pos(c[0], c[1], [0, 0, 0])[0] / S.MM; },
    sideTop: (x) => hull.pos(x, DOOR_TOP_ROW, [0, 0, 0])[1] / S.MM,
    paint: (builder) => { builder.material(VEHICLE.PAINT, S.PAINT_FLAKE, 0); builder.color(1, 1, 1); builder.occlusion(1); },
  };
  const spacing = quality.arch, steps = { blendSteps: quality.flare, lipSteps: Math.ceil(quality.flare / 2) }, sill = (x) => hull.pos(x, SILL_ROW, [0, 0, 0])[1] / S.MM;
  // Ahead of the front wheel the body's lower edge is the chin of the fascia, which hangs below the sill; the front
  // flare's leading leg stands on it and dies into the fascia's flank as it does into the wing above. The liner
  // stands on the undertray, a little above the chin.
  const nose = noseUnderside(hull);
  const front = buildArch(mb, body, {
    path: frontOpening(spacing), bottom: nose.edge, floor: nose.tray, cover: flankSkin(hull),
    band: () => S.FRONT_ARCH.flare, face: S.FRONT_ARCH.face, faceZ: S.FRONT_ARCH.faceZ, linerZ: S.FRONT_ARCH.linerZ, ...steps,
  });
  // The rear band is widest on its long leading leg and narrows over the top. Its trailing leg stands on the
  // coachwork's lower edge, which climbs steeply behind the wheel: the tail is open underneath.
  const rear = buildArch(mb, body, {
    path: rearOpening(spacing), bottom: sill,
    band: (t) => S.REAR_ARCH.flare + (S.REAR_ARCH.flareLead - S.REAR_ARCH.flare) * Math.max(0, 1 - t / 0.35) ** 2, face: S.REAR_ARCH.face, faceZ: S.REAR_ARCH.faceZ, linerZ: S.REAR_ARCH.linerZ, ...steps,
  });
  return { front, rear };
}
