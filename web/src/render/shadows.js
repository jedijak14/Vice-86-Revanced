// Cascaded shadow fitting for the dominant light (sun by day, moon by night).
//
// Each cascade covers a slice of the view frustum. To keep shadows rock steady while the camera moves
// and turns, a cascade is fitted to the bounding SPHERE of its slice (its size does not change with the
// view direction) and its centre is snapped to whole shadow-map texels in light space, using absolute
// world coordinates in double precision. A shadow texel therefore always covers the same piece of world.

/** Maximum number of cascades the lighting shader supports. */
export const MAX_CASCADES = 4;

/**
 * Split distances between near and far. lambda blends a uniform scheme (0) with a logarithmic one (1).
 * out receives count + 1 values: out[0] = near ... out[count] = far.
 */
export function cascadeSplits(out, count, near, far, lambda = 0.82) {
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    out[i] = lambda * near * Math.pow(far / near, t) + (1 - lambda) * (near + (far - near) * t);
  }
  return out;
}

/**
 * Smallest sphere containing the frustum slice between view depths n and f.
 * Returns the distance of its centre along the view axis and its radius in out[0], out[1].
 */
export function sliceSphere(out, tanHalfFovY, aspect, n, f) {
  const k = tanHalfFovY * tanHalfFovY * (1 + aspect * aspect);   // squared tangent of the half diagonal
  if (k >= (f - n) / (f + n)) { out[0] = f; out[1] = f * Math.sqrt(k); }
  else { out[0] = 0.5 * (f + n) * (1 + k); out[1] = 0.5 * Math.sqrt((f - n) * (f - n) + 2 * (f * f + n * n) * k + (f + n) * (f + n) * k * k); }
  return out;
}

/**
 * Round a radius up to the next step of a geometric ladder. The field of view breathes with speed; without
 * this the cascade size would change a little every frame and every shadow edge would crawl.
 */
export function quantizeRadius(radius, ratio = 1.12) {
  return Math.pow(ratio, Math.ceil(Math.log(radius) / Math.log(ratio) - 1e-9));
}

/**
 * Orthonormal light basis. out: Float64Array(9) = right(3), up(3), toLight(3). The reference axis is world
 * Z unless the light is nearly parallel to it, so the basis turns smoothly as the sun crosses the sky.
 */
export function lightBasis(out, lx, ly, lz) {
  const l = Math.hypot(lx, ly, lz) || 1; lx /= l; ly /= l; lz /= l;
  let ax = 0, ay = 0, az = 1;
  if (Math.abs(lz) > 0.92) { ax = 1; az = 0; }
  // right = normalise(axis x toLight), up = toLight x right
  let rx = ay * lz - az * ly, ry = az * lx - ax * lz, rz = ax * ly - ay * lx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  out[0] = rx; out[1] = ry; out[2] = rz;
  out[3] = ly * rz - lz * ry; out[4] = lz * rx - lx * rz; out[5] = lx * ry - ly * rx;
  out[6] = lx; out[7] = ly; out[8] = lz;
  return out;
}

/**
 * Fit one cascade.
 *   cascade: from makeCascade().  basis: from lightBasis.  cam: camera world position.  fwd: unit view direction (world).
 *   centreDist, radius: from sliceSphere (radius already quantised).  resolution: shadow map size in texels.
 *   casterReach: how far towards the light casters are kept (they are flattened onto the near plane, so
 *   a tower outside the slice still shadows it).
 * The fit is stored in absolute light-space doubles, so a cascade that is re-rendered only every few
 * frames stays valid while the camera moves: call cascadeMatrix() each frame to re-express it relative to
 * the current camera.
 */
export function fitCascade(cascade, basis, cam, fwd, centreDist, radius, resolution, casterReach) {
  const cx = cam[0] + fwd[0] * centreDist, cy = cam[1] + fwd[1] * centreDist, cz = cam[2] + fwd[2] * centreDist;
  const texel = 2 * radius / resolution;
  cascade.basis.set(basis);
  // Light-space coordinates of the sphere centre, snapped to the texel grid (absolute world, doubles).
  const sx = Math.floor((cx * basis[0] + cy * basis[1] + cz * basis[2]) / texel) * texel;
  const sy = Math.floor((cx * basis[3] + cy * basis[4] + cz * basis[5]) / texel) * texel;
  const sz = cx * basis[6] + cy * basis[7] + cz * basis[8];
  cascade.sx = sx; cascade.sy = sy; cascade.sz = sz;
  // World position of the snapped centre, for culling casters.
  cascade.centre[0] = basis[0] * sx + basis[3] * sy + basis[6] * sz;
  cascade.centre[1] = basis[1] * sx + basis[4] * sy + basis[7] * sz;
  cascade.centre[2] = basis[2] * sx + basis[5] * sy + basis[8] * sz;
  cascade.radius = radius; cascade.texel = texel; cascade.depthRange = 2 * radius + casterReach; cascade.casterReach = casterReach;
  return cascadeMatrix(cascade, cam);
}

/**
 * Write cascade.matrix for the given camera position: it maps CAMERA-RELATIVE world positions to the
 * cascade's clip space (x, y in [-1,1]; z in [-1,1] with -1 nearest to the light).
 */
export function cascadeMatrix(cascade, cam) {
  const b = cascade.basis, m = cascade.matrix, ir = 1 / cascade.radius, iz = -2 / cascade.depthRange;
  const camX = cam[0] * b[0] + cam[1] * b[1] + cam[2] * b[2], camY = cam[0] * b[3] + cam[1] * b[4] + cam[2] * b[5], camZ = cam[0] * b[6] + cam[1] * b[7] + cam[2] * b[8];
  const zNear = cascade.sz + cascade.radius + cascade.casterReach;        // light-space z of the near plane
  m[0] = b[0] * ir; m[4] = b[1] * ir; m[8] = b[2] * ir; m[12] = (camX - cascade.sx) * ir;
  m[1] = b[3] * ir; m[5] = b[4] * ir; m[9] = b[5] * ir; m[13] = (camY - cascade.sy) * ir;
  m[2] = b[6] * iz; m[6] = b[7] * iz; m[10] = b[8] * iz; m[14] = (camZ - zNear) * iz - 1;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  return cascade;
}

export function makeCascade() {
  return { matrix: new Float32Array(16), basis: new Float64Array(9), centre: new Float64Array(3), sx: 0, sy: 0, sz: 0, radius: 1, texel: 1, depthRange: 1, casterReach: 0, valid: false };
}

/**
 * Does a caster's bounding sphere (world centre x, y, z) matter to a cascade? It does when its shadow
 * volume crosses the cascade's cylinder: inside the texel square sideways, not behind the far side, and no
 * further towards the light than the caster reach. Spheres smaller than `minTexels` texels are dropped:
 * they could only flicker.
 */
export function casterInCascade(cascade, x, y, z, radius, minTexels = 0) {
  const basis = cascade.basis;
  if (radius * 2 < cascade.texel * minTexels) return false;
  const dx = x - cascade.centre[0], dy = y - cascade.centre[1], dz = z - cascade.centre[2];
  const reach = cascade.radius + radius;
  if (Math.abs(dx * basis[0] + dy * basis[1] + dz * basis[2]) > reach) return false;
  if (Math.abs(dx * basis[3] + dy * basis[4] + dz * basis[5]) > reach) return false;
  const along = dx * basis[6] + dy * basis[7] + dz * basis[8];
  return along > -reach && along < cascade.radius + cascade.casterReach + radius;
}

/**
 * Share of a cascade's half width, counted from its edge, that the lighting shader may hand over to the
 * next cascade (the dithered band in litSunShadow plus the filter kernel and the normal offset).
 */
const HANDOVER_SHARE = 0.18;

/**
 * Is a small caster (bounding sphere at world x, y, z) needed only by `inner`, the cascade one step
 * closer to the camera, so that the cascades after it can leave it out? The lighting shader reads the
 * first cascade whose square holds the receiver, so that is the case when everything the caster can
 * shadow lies well inside the inner cascade: its sphere, swept away from the light by `shadowLength`
 * metres, stays `margin` metres plus the handover band inside the square and in front of the far plane.
 * margin: how far the caster or the camera may move before either cascade is drawn again.
 */
export function casterCoveredBy(inner, x, y, z, radius, shadowLength, margin) {
  const basis = inner.basis, dx = x - inner.centre[0], dy = y - inner.centre[1], dz = z - inner.centre[2];
  const room = inner.radius * (1 - HANDOVER_SHARE) - margin - radius;
  if (room <= 0 || Math.abs(dx * basis[0] + dy * basis[1] + dz * basis[2]) > room || Math.abs(dx * basis[3] + dy * basis[4] + dz * basis[5]) > room) return false;
  return dx * basis[6] + dy * basis[7] + dz * basis[8] - radius - shadowLength > margin - inner.radius;
}
