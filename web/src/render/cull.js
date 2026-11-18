// View-frustum culling maths. Everything here works in CAMERA-RELATIVE space with double precision
// (plain Float64Array), so it stays exact kilometres from the world origin.

/**
 * Extract the six clip planes of a column-major view-projection matrix.
 * out: Float64Array(24) holding (nx, ny, nz, d) per plane in the order left, right, bottom, top, near, far,
 * normalised so that n.p + d is a signed distance in metres (positive inside).
 */
export function extractPlanes(out, m) {
  const row = (r, c) => m[c * 4 + r];
  for (let i = 0; i < 6; i++) {
    const axis = i >> 1, sign = (i & 1) ? -1 : 1;
    let a = row(3, 0) + sign * row(axis, 0), b = row(3, 1) + sign * row(axis, 1), c = row(3, 2) + sign * row(axis, 2), d = row(3, 3) + sign * row(axis, 3);
    const inv = 1 / (Math.hypot(a, b, c) || 1);
    out[i * 4] = a * inv; out[i * 4 + 1] = b * inv; out[i * 4 + 2] = c * inv; out[i * 4 + 3] = d * inv;
  }
  return out;
}

/** True when the axis-aligned box touches the inside of the first `planeCount` planes (conservative). */
export function aabbVisible(planes, minx, miny, minz, maxx, maxy, maxz, planeCount = 6) {
  for (let i = 0; i < planeCount; i++) {
    const o = i * 4, a = planes[o], b = planes[o + 1], c = planes[o + 2];
    // The corner furthest along the plane normal: if even that one is outside, the whole box is.
    const d = a * (a >= 0 ? maxx : minx) + b * (b >= 0 ? maxy : miny) + c * (c >= 0 ? maxz : minz) + planes[o + 3];
    if (d < 0) return false;
  }
  return true;
}

/** True when the sphere touches the inside of the first `planeCount` planes (conservative). */
export function sphereVisible(planes, x, y, z, radius, planeCount = 6) {
  for (let i = 0; i < planeCount; i++) {
    const o = i * 4;
    if (planes[o] * x + planes[o + 1] * y + planes[o + 2] * z + planes[o + 3] < -radius) return false;
  }
  return true;
}

/**
 * Distance band test used for levels of detail: an object is drawn when the distance from the camera to
 * its bounds centre is within [near, far).
 */
export function inLodBand(distance, near, far) { return distance >= near && distance < far; }

/**
 * The distance a level of detail is chosen by in a pass that wants coarser levels than the main view:
 * d + min(d * bias, most). bias 0 is the main view. The same formula runs per instance in the vertex
 * shader (uLod.zw in shaders/surface.js).
 */
export function lodDistance(distance, bias, most) { return distance + Math.min(distance * bias, most); }

/**
 * For a batch of instances treated as one sphere: can ANY instance be inside [near, far)?
 * (Instances are then selected individually in the vertex shader.) bias, most: see lodDistance.
 */
export function batchTouchesLodBand(centreDistance, radius, near, far, bias = 0, most = 0) {
  return lodDistance(centreDistance + radius, bias, most) >= near && lodDistance(Math.max(0, centreDistance - radius), bias, most) < far;
}
