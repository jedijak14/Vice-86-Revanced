// Environment probe: the sky as the renderer's ambient light and reflections.
//   uEnvMap   cube, RGBA16F, mip m holds the sky blurred for roughness m / ENV_ROUGH_MIPS (GGX), no sun or moon disc
//   uEnvIrr   cube, 16 px, cosine-convolved (irradiance / PI)
// The sky changes slowly, so the work is spread: one raw face per frame, then the filters, about ten frames a cycle.
// A jump in time or weather rebuilds everything in one frame.
import { ENV_ROUGH_MIPS } from './glsl/common.js';
import { CUBE_FACES } from './glsl/dome.js';

const IRRADIANCE_SIZE = 16;
/** Steps of one cycle: 6 raw faces, raw mips, sharp level, blurred levels, irradiance. */
const STEPS = 10;
/** GGX samples per roughness level 1..ENV_ROUGH_MIPS: wide lobes need more. */
const SAMPLES = [0, 20, 28, 32, 32, 32];

export function createProbe(host, programs) {
  const gl = host.gl;
  let size = 0, raw = null, env = null, irr = null, fbo = null, step = 0, complete = false;

  function cube(side, levels) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, gl.RGBA16F, side, side);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /** (Re)create the textures. side: 256 on high tiers, 128 on low. */
  function build(side) {
    release();
    size = side; step = 0; complete = false;
    raw = cube(size, Math.log2(size) + 1);
    env = cube(size, ENV_ROUGH_MIPS + 1);
    irr = cube(IRRADIANCE_SIZE, 1);
    fbo = gl.createFramebuffer();
    host.shareTexture('uEnvRaw', gl.TEXTURE_CUBE_MAP, raw);
    share();
  }
  /** Publish the two cubes every shader lights with. Again after something else stood in for them (a closed room). */
  function share() {
    host.shareTexture('uEnvMap', gl.TEXTURE_CUBE_MAP, env);
    host.shareTexture('uEnvIrr', gl.TEXTURE_CUBE_MAP, irr);
  }
  function release() {
    if (!fbo) return;
    gl.deleteTexture(raw); gl.deleteTexture(env); gl.deleteTexture(irr); gl.deleteFramebuffer(fbo);
    raw = env = irr = fbo = null;
  }

  function face(program, target, f, level, side) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, target, level);
    gl.viewport(0, 0, side, side);
    const b = CUBE_FACES[f];
    gl.uniform3f(program.loc('uFaceX'), b.x[0], b.x[1], b.x[2]);
    gl.uniform3f(program.loc('uFaceY'), b.y[0], b.y[1], b.y[2]);
    gl.uniform3f(program.loc('uFaceZ'), b.z[0], b.z[1], b.z[2]);
    host.drawFullscreen();
  }
  function run(s) {
    if (s < 6) {
      if (programs.probe.use()) face(programs.probe, raw, s, 0, size);
    } else if (s === 6) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, raw); gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    } else if (s === 7 || s === 8) {
      const p = programs.prefilter;
      if (!p.use()) return;
      for (let level = s === 7 ? 0 : 1; level <= (s === 7 ? 0 : ENV_ROUGH_MIPS); level++) {
        gl.uniform4f(p.loc('uParams'), level / ENV_ROUGH_MIPS, size, SAMPLES[level], 0);
        for (let f = 0; f < 6; f++) face(p, env, f, level, size >> level);
      }
    } else {
      const p = programs.irradiance;
      if (!p.use()) return;
      // read a mip whose texels are about as large as the gaps between the samples
      gl.uniform4f(p.loc('uParams'), Math.log2(size) - 3, size, 48, 0);
      for (let f = 0; f < 6; f++) face(p, irr, f, 0, IRRADIANCE_SIZE);
    }
  }

  return {
    build,
    share,
    dispose: release,
    /** True once every level has been written at least once (the renderer's warm-up can wait for it). */
    get complete() { return complete; },
    /** Force the next update to rebuild everything (time jump, teleport, weather switch). */
    invalidate() { complete = false; step = 0; },
    /** Advance by one step, or do a whole cycle when nothing valid exists yet. Leaves its own framebuffer bound. */
    update() {
      if (!programs.probe.ready || !programs.prefilter.ready || !programs.irradiance.ready) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      if (!complete) { for (let s = 0; s < STEPS; s++) run(s); complete = true; step = 0; } else { run(step); step = (step + 1) % STEPS; }
    },
  };
}
