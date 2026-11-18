// Rain streaks, ground splashes and the lightning bolt: the GL side of glsl/rain.js. All three draw in `particles`.
import { RAIN_BOX, RAIN_PERIOD, RAIN_WIND_SHARE } from './glsl/rain.js';
import { BOLT_SEGMENTS, buildBolt } from './lightning.js';

/** Streaks at full intensity per particle quality level (quality.levels.particles). */
const STREAKS = [5000, 14000, 26000];
/** Splash grid: cells per side and cell size (m). One splash can be alive per cell. */
const SPLASH_SIDE = [44, 72, 96], SPLASH_CELL = 0.55;
const LAND_Y = 1.2;
/** Exposure time of a streak (s): a 1/30 s shutter, so a drop falling at 8.5 m/s draws 0.28 m, a fine line rather than a dash. */
const SHUTTER = 1 / 30;
/** Seconds the bolt stays drawn after its strike (the flash itself is env.weather.lightning). */
const BOLT_LIFE = 0.45;

const wrap = (x, period) => x - Math.floor(x / period) * period;

export function createPrecipitation(host, programs) {
  const gl = host.gl;
  const bolt = new Float32Array(BOLT_SEGMENTS * 8);
  // Rain falls through world space: the drift of the box (wind) and the fall clock are integrated here in double
  // precision and wrapped, so the shader never sees a large number.
  const drift = new Float64Array(3), last = new Float64Array(3), velocity = new Float32Array(3);
  let fall = 0, hasLast = false, vao = null, vbo = null, boltCount = 0, boltSeed = -1;

  function build() {
    vao = gl.createVertexArray(); vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, bolt.byteLength, gl.DYNAMIC_DRAW);
    for (let i = 0; i < 2; i++) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 4, gl.FLOAT, false, 32, i * 16); gl.vertexAttribDivisor(i, 1); }
    gl.bindVertexArray(null);
    boltSeed = -1; boltCount = 0;
  }

  return {
    build,
    dispose() { if (vao) { gl.deleteVertexArray(vao); gl.deleteBuffer(vbo); vao = vbo = null; } },
    /** Forget where the camera was: the next frame starts from rest (after a spell indoors the way back is not a speed). */
    rest() { hasLast = false; },
    /** `prepare`: move the rain and note how fast the camera travels. */
    simulate(ctx, cloudBase) {
      const env = ctx.env, dt = ctx.dt, p = ctx.camera.position, wind = env.weather.wind;
      fall = wrap(fall + dt, RAIN_PERIOD);
      drift[0] = wrap(drift[0] + wind[0] * RAIN_WIND_SHARE * dt, RAIN_BOX[0]); drift[2] = wrap(drift[2] + wind[1] * RAIN_WIND_SHARE * dt, RAIN_BOX[2]);
      const jump = hasLast ? Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) : Infinity;
      // a teleport or a hitch is not a speed
      const inv = dt > 1e-4 && jump < 150 * dt + 0.5 ? 1 / dt : 0;
      for (let k = 0; k < 3; k++) { velocity[k] = (p[k] - last[k]) * inv; last[k] = p[k]; }
      hasLast = true;
      const strike = env.strike;
      if (strike[2] >= 0 && strike[2] < BOLT_LIFE && strike[3] !== boltSeed) {
        boltSeed = strike[3];
        boltCount = buildBolt(strike[0], strike[1], cloudBase + 250, 0, strike[3], bolt);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferSubData(gl.ARRAY_BUFFER, 0, bolt, 0, boltCount * 8);
      }
    },
    /** `particles` stage. */
    draw(ctx) {
      const env = ctx.env, rain = env.weather.rain, level = ctx.quality.levels.particles, cam = ctx.camera;
      if (rain > 0.01) {
        const p = cam.position, v = cam.view;
        if (programs.rain.use()) {
          const r = programs.rain;
          gl.uniform4f(r.loc('uRainShift'), wrap(drift[0] - p[0], RAIN_BOX[0]), wrap(-p[1], RAIN_BOX[1]), wrap(drift[2] - p[2], RAIN_BOX[2]), fall);
          gl.uniform4f(r.loc('uRainMotion'), velocity[0], velocity[1], velocity[2], SHUTTER);
          // keep the box ahead of the eye: most of it is then inside the view (forward = -row 2 of the rotation)
          gl.uniform4f(r.loc('uRainCentre'), -v[2] * 7, -v[6] * 7, -v[10] * 7, cam.fovY);
          gl.drawArrays(gl.TRIANGLES, 0, Math.round(STREAKS[level] * Math.sqrt(rain)) * 6);
        }
        if (programs.splash.use()) {
          const side = SPLASH_SIDE[level];
          gl.uniform4f(programs.splash.loc('uSplash'), side, SPLASH_CELL, LAND_Y, 0.25 + 0.75 * rain);
          gl.drawArrays(gl.TRIANGLES, 0, side * side * 6);
        }
      }
      const strike = env.strike;
      if (boltCount > 0 && strike[3] === boltSeed && strike[2] >= 0 && strike[2] < BOLT_LIFE && env.weather.lightning > 0.01 && programs.bolt.use()) {
        gl.bindVertexArray(vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, boltCount);
        gl.bindVertexArray(null);
      }
    },
  };
}
