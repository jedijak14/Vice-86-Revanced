// Sky module: the sky dome, the environment probe, the ocean, rain and lightning, and the GLSL the renderer's own
// shaders use for ambient light, reflections and fog. Written against src/render/host.js.
//
//   const sky = await createSky(host);          // called by the renderer while booting
//   sky.glsl                                    // chunk for the renderer's shaders (host.js section 4)
//   sky.setShoreField(world.plan.coast)         // where the shore is: beaches, breakers, sheltered water
//   sky.setCity(x, z, radius)                   // the extent of the map: where clouds gather round it, how far the night glow is mapped
//   sky.setCityGlow((x, z) => 0..1)             // how brightly each spot is lit at night (optional: all land is lit alike without it)
//   sky.invalidate()                            // after a jump in time or weather: rebuild clouds and probe in one frame
//   sky.ready                                   // true once clouds and probe hold a complete sky
//
// A closed room (design/GARAGE.md) needs no call: while the Environment of a frame says `interior`, the module stands
// still. Nothing is simulated and nothing drawn, the Sky block carries no light and no fog, and the two probe cubes
// are dark; every map, clock and phase is kept, so the first frame without the flag shows the street as it was left.
import { atmosphereLuts } from './atmosphere.js';
import { SKY_BLOCK_FLOATS, cloudLayer, createSkyState, packSkyBlock, seaState } from './block.js';
import { CLOUD_MAP_SIDES, createCloudMaps } from './clouds.js';
import { SKY_CHUNK, SKY_VIEW_SIZE } from './glsl/common.js';
import { GLOW_MAP_SIDE, createGlowMap } from './glow.js';
import { SKY_NOISE_SIZE, buildSkyNoise, buildSkyVolume, SKY_VOLUME_SIZE } from './noise.js';
import { OCEAN_TIERS, createOcean } from './ocean.js';
import { createPrecipitation } from './precipitation.js';
import { createProbe } from './probe.js';
import { skyPrograms } from './programs.js';

/** The wave clock wraps after this many seconds. A multiple of every shore period in glsl/ocean.js, so swash and breakers do not notice. */
const WAVE_CLOCK_PERIOD = 15600;
const DARK_TEXEL = new Uint8Array(4);
/** Speed of the cloud layers relative to the wind near the ground, and the least they ever drift (m/s). */
const CUMULUS_WIND = 1.6, CUMULUS_MIN = 4.5, CIRRUS_SPEED = 16;

export async function createSky(host) {
  const gl = host.gl;
  gl.getExtension('EXT_color_buffer_float');       // rendering into the RGBA16F probe and sky table
  const sources = skyPrograms(host.glsl), programs = {};
  for (const name of Object.keys(sources)) programs[name] = host.createProgram('sky ' + name, sources[name].vs, sources[name].fs);

  const state = createSkyState(), block = new Float32Array(SKY_BLOCK_FLOATS), layer = [0, 0];
  const probe = createProbe(host, programs), clouds = createCloudMaps(host, programs.clouds, state);
  const ocean = createOcean(host, programs.ocean, state), precipitation = createPrecipitation(host, programs);
  const glow = createGlowMap();
  let ubo = null, viewTexture = null, viewTarget = null, statics = [];
  // what the lit plan is built from; it is rebuilt (cheaply, on the next frame) whenever one of them changes
  let glowTexture = null, glowStale = true, coastSource = null, cityLights = null;
  let lastTime = NaN, lastClouds = NaN, probeSide = 0, cloudSide = 0;
  // indoors: what stands in for the probe (one black texel a face), and whether it is what is published now
  let dark = null, indoors = false;

  function texture2d(internal, width, height, format, type, data, wrapS, wrapT, mipmaps) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }
  /** Everything that lives in the GL context: called at start and after a context restore. */
  function build() {
    const luts = atmosphereLuts(), C = gl.CLAMP_TO_EDGE;
    const trans = texture2d(gl.RGBA16F, luts.transmittance.width, luts.transmittance.height, gl.RGBA, gl.FLOAT, luts.transmittance.data, C, C, false);
    const multi = texture2d(gl.RGBA16F, luts.multiScatter.width, luts.multiScatter.height, gl.RGBA, gl.FLOAT, luts.multiScatter.data, C, C, false);
    const noise = texture2d(gl.RGBA8, SKY_NOISE_SIZE, SKY_NOISE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, buildSkyNoise(), gl.REPEAT, gl.REPEAT, true);
    // the table wraps round the compass and ends at the zenith
    viewTexture = texture2d(gl.RGBA16F, SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1], gl.RGBA, gl.HALF_FLOAT, null, gl.REPEAT, C, false);
    viewTarget = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, viewTarget);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, viewTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const volume = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, volume);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RG8, SKY_VOLUME_SIZE, SKY_VOLUME_SIZE, SKY_VOLUME_SIZE, 0, gl.RG, gl.UNSIGNED_BYTE, buildSkyVolume());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.REPEAT); gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.REPEAT);
    host.shareTexture('uSkyVolume', gl.TEXTURE_3D, volume);
    glowTexture = texture2d(gl.R8, GLOW_MAP_SIDE, GLOW_MAP_SIDE, gl.RED, gl.UNSIGNED_BYTE, null, C, C, false);
    host.shareTexture('uSkyGlowPlan', gl.TEXTURE_2D, glowTexture);
    glowStale = true;
    dark = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, dark);
    for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, DARK_TEXEL);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    indoors = false;
    // Until the probe is first built (in the first frame) the dark cube stands in for it: programs that
    // light with the probe are drawn once before any frame is.
    host.shareTexture('uEnvMap', gl.TEXTURE_CUBE_MAP, dark); host.shareTexture('uEnvIrr', gl.TEXTURE_CUBE_MAP, dark);
    statics = [trans, multi, noise, volume, glowTexture, dark];
    host.shareTexture('uSkyTrans', gl.TEXTURE_2D, trans); host.shareTexture('uSkyMulti', gl.TEXTURE_2D, multi);
    host.shareTexture('uSkyNoise', gl.TEXTURE_2D, noise); host.shareTexture('uSkyView', gl.TEXTURE_2D, viewTexture);
    ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferData(gl.UNIFORM_BUFFER, block.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, host.SKY_BLOCK_BINDING, ubo);
    probeSide = 0; cloudSide = 0;
    ocean.build(); precipitation.build();
  }
  build();
  host.onRestore(build);

  const tierOf = (detail) => (detail < 0.4 ? 0 : detail < 0.65 ? 1 : detail < 0.9 ? 2 : 3);

  const unregister = [
    host.registerPass('prepare', (ctx) => {
      const env = ctx.env, w = env.weather, dt = Math.min(Math.max(ctx.dt, 0), 0.25), cam = ctx.camera.position;
      if (env.interior) {
        if (!indoors) {
          indoors = true;
          host.shareTexture('uEnvMap', gl.TEXTURE_CUBE_MAP, dark); host.shareTexture('uEnvIrr', gl.TEXTURE_CUBE_MAP, dark);
        }
        // the block of a room: no light, no fog, no glow (environment.js and block.js see to that); the rest of it is
        // the street's, untouched, and nobody draws with it
        packSkyBlock(env, state, block);
        gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, block);
        return;
      }
      if (indoors) {
        indoors = false;
        // only if the probe still stands: after a lost context it is rebuilt, and published, a few lines down
        if (probeSide) probe.share();
        precipitation.rest();
      }
      const windSpeed = Math.hypot(w.wind[0], w.wind[1]), tier = tierOf(ctx.quality.detail);
      // clouds ride a faster wind than the street and never stand still; cirrus goes its own way, from the west
      const push = windSpeed > 0.05 ? Math.max(CUMULUS_WIND, CUMULUS_MIN / windSpeed) : 0;
      state.cloudOffset[0] -= (windSpeed > 0.05 ? w.wind[0] * push : -CUMULUS_MIN) * dt;
      state.cloudOffset[1] -= w.wind[1] * push * dt;
      state.cloudOffset[2] -= CIRRUS_SPEED * dt; state.cloudOffset[3] -= CIRRUS_SPEED * 0.25 * dt;
      state.waveClock = (state.waveClock + dt) % WAVE_CLOCK_PERIOD;
      state.quality = ctx.quality.detail;
      ocean.simulate(env, dt, tier, seaState(windSpeed, env.storm), cam[0], cam[2]);
      precipitation.simulate(ctx, cloudLayer(env.overcast, env.storm, layer)[0]);

      const side = tier === 0 ? 128 : 256;
      if (side !== probeSide) { probe.build(side); probeSide = side; }
      if (CLOUD_MAP_SIDES[tier] !== cloudSide) { cloudSide = CLOUD_MAP_SIDES[tier]; clouds.build(cloudSide); }
      // a jump of the clock or of the cloud cover (a preset change, a loaded game) must not creep in over many frames
      let hours = Math.abs(env.timeOfDay - lastTime); if (hours > 12) hours = 24 - hours;
      if (!(hours < 0.05) || !(Math.abs(w.clouds - lastClouds) < 0.08)) { clouds.invalidate(); probe.invalidate(); }
      lastTime = env.timeOfDay; lastClouds = w.clouds;

      if (glowStale) {
        glow.build(state.city, coastSource, cityLights);
        state.glowFrame.set(glow.frame);
        gl.bindTexture(gl.TEXTURE_2D, glowTexture);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GLOW_MAP_SIDE, GLOW_MAP_SIDE, gl.RED, gl.UNSIGNED_BYTE, glow.bytes);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        glowStale = false;
        clouds.invalidate(); probe.invalidate();
      }
      glow.around(cam[0], cam[2], state.glow);

      clouds.schedule(cam);
      packSkyBlock(env, state, block);
      gl.bindBuffer(gl.UNIFORM_BUFFER, ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, block);

      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE); gl.depthMask(false); gl.colorMask(true, true, true, true);
      if (programs.skyView.use()) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, viewTarget);
        gl.viewport(0, 0, SKY_VIEW_SIZE[0], SKY_VIEW_SIZE[1]);
        host.drawFullscreen();
      }
      // in this order: the clouds are lit by the sky table, the probe looks at the clouds
      clouds.march();
      if (clouds.complete) probe.update();
      gl.depthMask(true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.framebuffer || null);
      gl.viewport(0, 0, ctx.width, ctx.height);
    }),
    host.registerPass('water', (ctx) => { if (!ctx.env.interior) ocean.draw(ctx); }),
    host.registerPass('background', (ctx) => { if (!ctx.env.interior && programs.dome.use()) host.drawFullscreen(); }),
    host.registerPass('particles', (ctx) => { if (!ctx.env.interior) precipitation.draw(ctx); }),
  ];

  return {
    glsl: SKY_CHUNK,
    /** True once the environment probe holds a complete sky (renderer warm-up may wait for it). */
    get ready() { return clouds.complete && probe.complete; },
    /** world.plan.coast: { data: Uint8Array rgba, width, height, minX, minZ, cell }. Pass null to remove it. */
    setShoreField(coast) { ocean.setShoreField(coast); coastSource = coast || null; glowStale = true; },
    /** Centre and radius (m) of the map: clouds gather round it, and the night glow is mapped out to past its edge. */
    setCity(x, z, radius) { state.city[0] = x; state.city[1] = z; state.city[2] = 1 / Math.max(radius, 1); glowStale = true; },
    /**
     * How brightly each spot of the map is lit at night: lights(x, z) in 0..1 (1 = towers and a lit strip, 0 = a
     * dark park). Sampled once on a coarse grid; water is dark whatever it returns. Pass null for land lit alike.
     */
    setCityGlow(lights) { cityLights = typeof lights === 'function' ? lights : null; glowStale = true; },
    /** Rebuild the cloud maps and the probe on the next frame (time skip; a teleport does not need it). */
    invalidate() { clouds.invalidate(); probe.invalidate(); },
    /** Triangles of the ocean mesh at the current quality (statistics). */
    get oceanTriangles() { return ocean.triangles; },
    dispose() {
      for (const off of unregister) if (typeof off === 'function') off();
      probe.dispose(); clouds.dispose(); ocean.dispose(); precipitation.dispose();
      for (const t of statics) gl.deleteTexture(t);
      gl.deleteTexture(viewTexture); gl.deleteFramebuffer(viewTarget); gl.deleteBuffer(ubo);
      statics = [];
    },
  };
}
