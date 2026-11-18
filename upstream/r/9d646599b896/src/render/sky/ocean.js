// Ocean pass: the camera-centred mesh, the wave uniforms and the shore map.
import { createWaveSet, updateWaveSet } from './waves.js';
import { WAVE_COUNT } from './glsl/ocean.js';

/** Mesh per quality tier: segments round the circle, radial growth per ring, vertex displacement, wave trains shaded. */
export const OCEAN_TIERS = Object.freeze([
  { segments: 128, growth: 1.07, displace: false, waves: 16 },   // low: flat mesh, normals only
  { segments: 192, growth: 1.046, displace: true, waves: 22 },
  { segments: 256, growth: 1.035, displace: true, waves: WAVE_COUNT },
  { segments: 384, growth: 1.0233, displace: true, waves: WAVE_COUNT },
]);
const INNER_RADIUS = 0.6, OUTER_RADIUS = 7200;

/**
 * Polar grid round the origin: rings grow geometrically so triangles stay the same size on screen at any distance.
 * Returns { positions: Float32Array (x, z), indices: Uint32Array, rings }.
 */
export function buildOceanMesh(segments, growth) {
  const rings = Math.ceil(Math.log(OUTER_RADIUS / INNER_RADIUS) / Math.log(growth)) + 1;
  const positions = new Float32Array((rings * segments + 1) * 2), indices = new Uint32Array((rings - 1) * segments * 6 + segments * 3);
  let r = INNER_RADIUS, p = 2, k = 0;                       // vertex 0 is the centre
  for (let i = 0; i < rings; i++, r *= growth) {
    // alternate rings are turned half a step: the triangles are near equilateral and show no radial seams
    const turn = (i & 1) * 0.5;
    for (let j = 0; j < segments; j++) { const a = (j + turn) / segments * Math.PI * 2; positions[p++] = Math.cos(a) * r; positions[p++] = Math.sin(a) * r; }
  }
  for (let j = 0; j < segments; j++) { indices[k++] = 0; indices[k++] = 1 + (j + 1) % segments; indices[k++] = 1 + j; }
  for (let i = 0; i < rings - 1; i++) {
    const a = 1 + i * segments, b = a + segments, odd = i & 1;
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      if (odd) { indices[k++] = a + j; indices[k++] = b + j1; indices[k++] = b + j; indices[k++] = a + j; indices[k++] = a + j1; indices[k++] = b + j1; }
      else { indices[k++] = a + j; indices[k++] = a + j1; indices[k++] = b + j; indices[k++] = a + j1; indices[k++] = b + j1; indices[k++] = b + j; }
    }
  }
  return { positions, indices, rings };
}

/**
 * Turn the planner's coast map (bytes: r = 128 + distance / 2, g = shore kind, b = exposure) into float texels
 * [distance (m), kind 0..1, exposure 0..1, 1]. The distance is smoothed over one cell: eight-bit steps of two
 * metres would otherwise show as terraces in the breaker lines.
 */
export function decodeShoreField(coast) {
  const { data, width: w, height: h } = coast, out = new Float32Array(w * h * 4), dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = (data[i * 4] - 128) * 2;
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y;
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x, i = y * w + x, o = i * 4;
      out[o] = 0.25 * dist[i] + 0.125 * (dist[y * w + x0] + dist[y * w + x1] + dist[y0 * w + x] + dist[y1 * w + x])
        + 0.0625 * (dist[y0 * w + x0] + dist[y0 * w + x1] + dist[y1 * w + x0] + dist[y1 * w + x1]);
      out[o + 1] = data[o + 1] / 255; out[o + 2] = data[o + 2] / 255; out[o + 3] = 1;
    }
  }
  return out;
}

export function createOcean(host, program, state) {
  const gl = host.gl;
  const sets = OCEAN_TIERS.map((t) => createWaveSet(t.waves));
  let tier = -1, vao = null, vbo = null, ibo = null, indexCount = 0, shore = null, shoreSource = null;
  // the sea follows the wind slowly: a gust must not swing every wave train round at once
  let windX = -1, windZ = 0, seaLevel = -1;

  function buildMesh(index) {
    releaseMesh();
    tier = index;
    const mesh = buildOceanMesh(OCEAN_TIERS[index].segments, OCEAN_TIERS[index].growth);
    vao = gl.createVertexArray(); vbo = gl.createBuffer(); ibo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    indexCount = mesh.indices.length;
  }
  function releaseMesh() {
    if (!vao) return;
    gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); gl.deleteBuffer(ibo); vao = vbo = ibo = null;
  }
  function uploadShore() {
    if (shore) gl.deleteTexture(shore);
    shore = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shore);
    if (shoreSource) {
      const c = shoreSource;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, c.width, c.height, 0, gl.RGBA, gl.FLOAT, decodeShoreField(c));
      state.coast[0] = c.minX; state.coast[1] = c.minZ; state.coast[2] = 1 / (c.width * c.cell); state.coast[3] = 1 / (c.height * c.cell);
    } else {
      // no map yet: open sea everywhere (the shader tests uSkyCoast.z and never reads this texel)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([1e4, 0, 1, 1]));
      state.coast.fill(0);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    host.shareTexture('uSkyShore', gl.TEXTURE_2D, shore);
  }

  return {
    /** Recreate GL objects (start-up and context restore). */
    build() { vao = vbo = ibo = shore = null; tier = -1; uploadShore(); },
    dispose() { releaseMesh(); if (shore) gl.deleteTexture(shore); shore = null; },
    setShoreField(coast) { shoreSource = coast || null; uploadShore(); },
    get triangles() { return indexCount / 3; },
    /** Advance the wave trains. Call once per frame before the block is packed. */
    simulate(env, dt, tierIndex, seaState, camX, camZ) {
      const w = env.weather.wind, speed = Math.hypot(w[0], w[1]);
      const tx = speed > 0.05 ? w[0] / speed : -1, tz = speed > 0.05 ? w[1] / speed : 0;
      if (seaLevel < 0) { windX = tx; windZ = tz; seaLevel = seaState; }
      else {
        const follow = 1 - Math.pow(0.5, dt / 12), inv = 1 / (Math.hypot(windX + (tx - windX) * follow, windZ + (tz - windZ) * follow) || 1);
        const nx = (windX + (tx - windX) * follow) * inv, nz = (windZ + (tz - windZ) * follow) * inv;
        windX = nx; windZ = nz; seaLevel += (seaState - seaLevel) * (1 - Math.pow(0.5, dt / 6));
      }
      if (tierIndex !== tier) buildMesh(tierIndex);
      updateWaveSet(sets[tier], windX, windZ, speed, seaLevel, dt, camX, camZ);
      state.seaWind[0] = windX; state.seaWind[1] = windZ; state.seaState = seaLevel;
    },
    /** `water` stage. */
    draw(ctx) {
      if (!vao || !program.use()) return;
      const t = OCEAN_TIERS[tier], set = sets[tier];
      gl.uniform4fv(program.loc('uWaveA'), set.a); gl.uniform4fv(program.loc('uWaveB'), set.b);
      gl.uniform1i(program.loc('uWaveCount'), set.count);
      // from high up the nearest water is far away: scale the whole mesh so its fine rings are not wasted below the eye
      const scale = Math.max(1, ctx.camera.position[1] / 4);
      gl.uniform4f(program.loc('uOcean'), scale, t.displace ? 1 : 0, 0, Math.max(t.growth - 1, Math.PI * 2 / t.segments));
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
      gl.bindVertexArray(null);
    },
  };
}
