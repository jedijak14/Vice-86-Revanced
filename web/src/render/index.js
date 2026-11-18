// The renderer: hand-written WebGL2, deferred shading, camera-relative.
//
//   const r = await createRenderer(canvas, { settings });   // settings.graphics as in ARCHITECTURE 11.2
//   await r.warmup(onProgress)                               // resolves when every shader program has compiled
//   r.render(frame)                                          // ARCHITECTURE 7 and 16; see render() below
//
// The interface for modules that draw inside the frame (sky, ocean, rain) is documented in host.js.
//
// ----------------------------------------------------------------------------------------------------
// Render targets
// ----------------------------------------------------------------------------------------------------
// Three sizes are involved:
//   canvas size   client size x min(devicePixelRatio, maxPixelRatio)
//   post size     canvas size x resolutionScale                      (history, bloom, tone map)
//   render size   post size x dynamic resolution scale (0.5 .. 1)    (everything the scene is drawn into)
// The temporal resolve upscales from render size to post size; the last pass scales post size to the canvas.
//
//   target         format              size            contents
//   -------------  ------------------  --------------  -----------------------------------------------------------
//   G-buffer 0     RGBA8               render          rgb = sqrt(albedo), a = baked occlusion
//   G-buffer 1     RGBA16F             render          rg = octahedral normal, ba = motion vector (uv per frame)
//   G-buffer 2     RGBA8               render          roughness, metal, coat strength, coat roughness
//   G-buffer 3     RGBA16F             render          rgb = emissive radiance, a = wet 0..1 | 2 + translucency
//   depth          DEPTH_COMPONENT24   render          hardware depth, shared by the G-buffer and the lit target
//   sceneDepth     R32F                render          view-space depth in metres (sky = 1e6); what shaders read
//   lit            RGBA16F             render          scene-referred radiance being built up
//   sceneOpaque    RGBA16F             render          copy of `lit` before water (refraction source)
//   aoA, aoB       RG8                 render / 2      r = ambient occlusion, g = sun contact shadow; blur ping-pong
//   ssrColor       RGBA16F             render x 0.5|1  traced reflection: radiance x confidence, confidence
//   ssrAux         R16F                same            distance to the reflection hit, metres
//   tileA, tileB   RG16F               render / 64     motion blur: fastest velocity per tile, and per neighbourhood
//   shadow map     DEPTH_COMPONENT24   1024 | 2048     2D array, one layer per cascade (2..4), hardware PCF
//   light data     RGBA32F             1024 x 1..4     4 texels per light: position+radius, colour+type, axis, cone
//   light cells    R16UI               slots x rows    light indices per ground-plane cell, two grid levels
//   planar         RGBA16F + mips      render / 2      wet-road mirror: the scene reflected in the road plane (High, Ultra)
//   scene probe    RGBA16F cube x 2    256 | 512       the surroundings of the player's car: sharp capture, and the same
//                                                      blurred by roughness down 6 mips (uSceneProbe; see probe.js)
//   rain cover     DEPTH_COMPONENT24   256             height of what stands over the ground around the camera (raincover.js)
//   history x 2    RGBA16F             post            temporally resolved frames (ping-pong); the newest is also the
//                                                      source of next frame's screen-space reflections; the older one
//                                                      is reused as the motion blur output when flames took scratch
//   scratch        RGBA16F             post            resolved frame + exhaust flames (a = motion blur mask), or the
//                                                      motion blur output when there are no flames
//   bloom down/up  RGBA16F             post / 2^n      5 or 7 levels; rgb = light over the knee, a = log luminance
//   exposure x 2   R16F                1 x 1           metered exposure correction (ping-pong)
//   display        RGBA8               post            tone-mapped image, only when FXAA or an upscale follows
//
// Four colour attachments is all WebGL2 guarantees, so the G-buffer is packed deliberately: normals take two
// 16-bit channels and share a target with the motion vector, 8 bits are enough for albedo once it is stored
// as a square root, and the fourth target's alpha does double duty for wetness and foliage translucency.
//
// ----------------------------------------------------------------------------------------------------
// Frame
// ----------------------------------------------------------------------------------------------------
//   cull -> light grid -> shadow cascades -> rain cover -> scene probe faces -> wet-road mirror -> G-buffer -> linear depth -> ambient occlusion -> deferred lighting
//   -> [copy] -> water (sky module) -> sky dome (sky module) -> linear depth again -> reflection trace
//   -> reflections + environment + fog -> glass -> rain (sky module) -> particles -> glow sprites
//   -> temporal AA -> exhaust flames -> motion blur -> bloom + exposure -> tone map, grade -> FXAA / upscale

import { ENGINE } from './identity.js';
import { FAMILY, FAMILY_NAMES } from '../core/ids.js';
import { m4mul, m4invert, m4perspective } from '../core/math.js';
import { LAND_Y } from '../world/roads/lanes.js';
import { buildNoiseTexture, NOISE_SIZE } from './atlas.js';
import { extractPlanes } from './cull.js';
import { fallbackFamily, createFallbackSky, PLAIN_SKY_GLSL } from './fallback.js';
import { createContext, Program, programsLinking, recompilePrograms, createTexture, guessTier } from './gl.js';
import { HOST_GLSL, STAGES, SKY_BLOCK_BINDING, FRAME_BLOCK_BINDING } from './host.js';
import { LightState } from './lightstate.js';
import { jitterSequence } from './packing.js';
import { PostChain } from './postfx.js';
import { SceneProbe, PROBE_LIGHT_REACH, PROBE_REACH } from './probe.js';
import { fixedPrograms, FORWARD_FAMILY } from './programs.js';
import { SurfacePrograms, WORLD_STREET, WORLD_ROOM } from './surfaceprograms.js';
import { resolveQuality, needsRebuild, DynamicResolution } from './quality.js';
import { RainCover } from './raincover.js';
import { Scene, MIRROR_LOD } from './scene.js';
import { EXPOSURE_BAND } from './shaders/post.js';
import { PROBE_LAST_LEVEL } from './shaders/probe.js';
import { normaliseFamily, needsMaterialGroups, surfaceSource, TILE_SLOTS } from './shaders/surface.js';
import { Glows, Particles, Flames } from './sprites.js';
import { Targets } from './targets.js';

/** Floats in the std140 Frame block (shaders/contract.js) and the offset of each member. */
const FRAME_FLOATS = 116;
const F = Object.freeze({ viewProj: 0, viewProjStable: 16, prevViewProj: 32, view: 48, invViewProj: 64, camPos: 80, time: 84, weather: 88, wind: 92, switches: 96, sunDir: 100, sunColor: 104, viewport: 108, quality: 112 });

const JITTER_LENGTH = 16;
/** Longest reflection ray in metres. */
const SSR_REACH = 140;
/** Wet-road mirror: how far its image reaches, and the lowest camera height above the plane at which it is drawn (metres). */
const MIRROR_REACH = 450, MIRROR_MIN_HEIGHT = 0.1;
/** Debug view owned by this file: every surface shows the scene probe along the view ray, as a perfect mirror ball would. */
const DEBUG_PROBE = 9;
/** Glows nearer than this to the origin of the scene probe are the lamps of the car it rides in (metres). */
const PROBE_OWN_LAMPS = 2.6;
/** Nothing lower than this above the mirror plane is drawn into the mirror (metres). */
const MIRROR_CLIP = 0.02;
/** Light shafts: strength, and how far along the view ray the air is tested for shadow. */
const SHAFT_STRENGTH = 0.85, SHAFT_REACH = 90;
/** Lowest dynamic resolution scale. */
const MIN_DYNAMIC_SCALE = 0.5;
// Most of one frame that counts as play towards the quiet a whole-family program waits for (gl.js), seconds:
// a frame that took longer was a stall, not play.
const LONGEST_QUIET_STEP = 0.1;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Create the renderer. Throws an Error with a message fit for the loading screen when the device lacks
 * WebGL2 or float render targets. options.settings: the game settings ({ graphics }) or a graphics object.
 */
export async function createRenderer(canvas, options = {}) {
  // `forceWebGL2` (?webgl2=force): ask for the context past the checks that would turn a weak device
  // away. See gl.js for what that does and, importantly, what it cannot do.
  const ctx = createContext(canvas, { force: !!options.forceWebGL2 }), gl = ctx.gl;
  const graphicsOf = (s) => (s && s.graphics ? s.graphics : s) || {};
  let quality = resolveQuality(graphicsOf(options.settings));

  // ------------------------------------------------------------------------------------------ shared GL objects
  let frameBuffer = null, emptyVao = null, noiseTexture = null, atlasTexture = null, whiteTexture = null, atlasSource = null;
  const frameBlock = new Float32Array(FRAME_FLOATS);

  function uploadAtlas() {
    if (atlasTexture) gl.deleteTexture(atlasTexture);
    atlasTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, atlasTexture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    // sRGB internal format: the sampler hands shaders linear colour, and mip levels are averaged in linear light.
    if (!atlasSource) gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 0]));
    else if (atlasSource.data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, atlasSource.width, atlasSource.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlasSource.data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, atlasSource);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (ctx.ext.aniso) gl.texParameterf(gl.TEXTURE_2D, ctx.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, ctx.maxAnisotropy);
    ctx.shared.set('uAtlasTex', { target: gl.TEXTURE_2D, texture: atlasTexture });
  }

  function createSharedObjects() {
    frameBuffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, frameBuffer); gl.bufferData(gl.UNIFORM_BUFFER, frameBlock.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, FRAME_BLOCK_BINDING, frameBuffer);
    emptyVao = gl.createVertexArray();
    noiseTexture = createTexture(gl, { internal: gl.RGBA8, width: NOISE_SIZE, height: NOISE_SIZE, levels: 'full', filter: 'mipmap', wrap: 'repeat', anisotropy: ctx.maxAnisotropy, anisoExt: ctx.ext.aniso });
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, NOISE_SIZE, NOISE_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, buildNoiseTexture());
    gl.generateMipmap(gl.TEXTURE_2D);
    ctx.shared.set('uNoiseTex', { target: gl.TEXTURE_2D, texture: noiseTexture });
    // Stands in for the occlusion buffer when ambient occlusion is off.
    // White in every channel: the occlusion buffer carries a second term (sun contact shadow) in green.
    whiteTexture = createTexture(gl, { internal: gl.RGBA8, width: 1, height: 1, filter: 'linear' });
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    uploadAtlas();
  }
  createSharedObjects();

  function drawFullscreen() {
    gl.bindVertexArray(emptyVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
  }

  // ------------------------------------------------------------------------------------------ host and sky
  const targets = new Targets(ctx);
  const passes = { prepare: [], water: [], background: [], particles: [] };
  const restoreCallbacks = [];
  const host = {
    gl, caps: ctx.caps, glsl: HOST_GLSL, SKY_BLOCK_BINDING,
    createProgram: (name, vertexSource, fragmentSource) => new Program(ctx, name, vertexSource, fragmentSource),
    drawFullscreen,
    shareTexture(name, target, texture) { ctx.shared.set(name, { target, texture }); },
    registerPass(stage, fn) {
      if (!STAGES.includes(stage)) throw new Error(`registerPass: unknown stage "${stage}" (expected one of ${STAGES.join(', ')}).`);
      passes[stage].push(fn);
      return () => { const i = passes[stage].indexOf(fn); if (i >= 0) passes[stage].splice(i, 1); };
    },
    targets: {
      get width() { return targets.width; }, get height() { return targets.height; },
      get lit() { return targets.scene.lit; }, get depth() { return targets.scene.depth; }, get sceneDepth() { return targets.scene.sceneDepth; },
      get sceneColor() { return targets.post.history[targets.historyIndex]; }, get sceneOpaque() { return targets.scene.sceneOpaque; },
      get gbuffer() { return targets.scene.gbuffer; },
    },
    onRestore(fn) { restoreCallbacks.push(fn); },
  };

  // The sky module is another owner's code: if it is missing or fails while starting, undo whatever it
  // registered and use the built-in stand-in, so that the game still runs.
  async function loadSky() {
    const programsBefore = ctx.programs.length;
    try {
      const module = await import('./sky/index.js');
      const sky = await module.createSky(host);
      if (!sky || typeof sky.glsl !== 'string') throw new Error('createSky() did not return { glsl }.');
      return sky;
    } catch (error) {
      console.warn(`Renderer: the sky module could not be used (${error && error.message}); using the built-in fallback sky.`);
      for (const p of ctx.programs.slice(programsBefore)) p.dispose();
      for (const stage of STAGES) passes[stage].length = 0;
      restoreCallbacks.length = 0;
      for (const name of [...ctx.shared.keys()]) if (/^u(Sky|Env)/.test(name)) ctx.shared.delete(name);
      return createFallbackSky(host);
    }
  }
  const sky = await loadSky();

  // ------------------------------------------------------------------------------------------ programs
  // Surface families are other owners' modules too: one that is missing or malformed is replaced by a
  // plain stand-in here, and one whose GLSL fails on this device is replaced when its program is built.
  // options.split (true or false) overrides what the device asks for: for tests and for comparing the two paths.
  const split = typeof options.split === 'boolean' ? options.split
    : needsMaterialGroups(ctx.rendererNamed, typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '');
  const families = {};
  for (const name of FAMILY_NAMES) {
    let family = null;
    try { family = normaliseFamily((await import(`./families/${name}.js`)).default, name, split); } catch (error) {
      console.warn(`Renderer: surface family "${name}" could not be loaded (${error && error.message}).`);
    }
    if (!family) { console.warn(`Renderer: using the fallback surface for family "${name}".`); family = normaliseFamily(fallbackFamily(name), name); }
    families[name] = family;
  }

  const fixed = {};
  for (const p of fixedPrograms(sky.glsl)) {
    const fallback = p.usesSky ? () => { const q = fixedPrograms(PLAIN_SKY_GLSL).find((x) => x.key === p.key); return [q.vertex, q.fragment]; } : null;
    fixed[p.key] = new Program(ctx, p.key, p.vertex, p.fragment, fallback);
  }

  // The families' programs are built as geometry asks for them (surfaceprograms.js). One whose GLSL fails on
  // this device is rebuilt from the plain stand-in of its family. Where the families are split, tile meshes
  // are merged (tileclusters.js) and the programs that draw them take an offset per merged mesh.
  const tileSlots = split ? TILE_SLOTS : 0;
  const plainFamilies = {};
  const surface = new SurfacePrograms(ctx, families, FORWARD_FAMILY, (name, kind, pass, group, plain) => {
    if (!plain) return surfaceSource(families[name], kind, pass, group, sky.glsl, tileSlots);
    if (!plainFamilies[name]) plainFamilies[name] = normaliseFamily(fallbackFamily(name), name);
    return surfaceSource(plainFamilies[name], kind, pass, 0, name === FORWARD_FAMILY ? PLAIN_SKY_GLSL : sky.glsl, tileSlots);
  });
  // Second views of the street are the reflection probe and the wet-road mirror; of a room, its own probe and floor.
  function chooseSurfacePasses() {
    surface.setViewPass(WORLD_STREET, quality.reflections.probe > 0 || quality.reflections.planar > 0);
    surface.setViewPass(WORLD_ROOM, quality.reflections.roomProbe > 0 || quality.reflections.roomPlanar > 0);
  }

  // ------------------------------------------------------------------------------------------ subsystems
  const scene = new Scene(ctx, surface, split);
  const lights = new LightState(ctx);
  const probe = new SceneProbe(ctx, { sky: fixed.probeSky, filter: fixed.probeFilter }, drawFullscreen);
  const rainCover = new RainCover(ctx);
  const glows = new Glows(ctx);
  const particles = new Particles(ctx, quality.particles.max);
  const flames = new Flames(ctx);
  const post = new PostChain(ctx, fixed, targets, flames, drawFullscreen);
  const drs = new DynamicResolution({ maxScale: 1, minScale: MIN_DYNAMIC_SCALE, target: quality.frameTarget });
  lights.configure(quality);
  chooseSurfacePasses();

  let canvasWidth = 0, canvasHeight = 0, postWidth = 0, postHeight = 0;
  let historyValid = false, contextLost = false, debugMode = 0, frameIndex = 0, disposed = false;
  // Whether the last frame showed a closed room (frame.env.interior) rather than the street.
  let wasInterior = false;
  // surface.generation as of the last frame: a change means triangles are drawn now that were left out before.
  let surfaceGeneration = 0;

  function allocateScene() {
    // Even sizes keep the half-resolution buffers aligned with the full-resolution ones.
    const w = Math.max(2, Math.round(postWidth * drs.scale / 2) * 2), h = Math.max(2, Math.round(postHeight * drs.scale / 2) * 2);
    if (targets.scene && w === targets.width && h === targets.height) return;
    targets.allocateScene(w, h, quality);
    const s = targets.scene;
    ctx.shared.set('uSceneDepth', { target: gl.TEXTURE_2D, texture: s.sceneDepth });
    ctx.shared.set('uSceneOpaque', { target: gl.TEXTURE_2D, texture: s.sceneOpaque });
    for (let i = 0; i < 4; i++) ctx.shared.set('uGBuffer' + i, { target: gl.TEXTURE_2D, texture: s.gbuffer[i] });
    ctx.shared.set('uAoTex', { target: gl.TEXTURE_2D, texture: s.aoA || whiteTexture });
  }

  function allocate() {
    const needDisplayTarget = quality.antialiasing === 'fxaa' || postWidth !== canvasWidth || postHeight !== canvasHeight;
    targets.allocatePost(postWidth, postHeight, quality, needDisplayTarget);
    ctx.shared.set('uSceneColor', { target: gl.TEXTURE_2D, texture: targets.post.history[targets.historyIndex] });
    targets.disposeScene();
    allocateScene();
    historyValid = false;
  }

  function resize() {
    const ratio = Math.min((typeof devicePixelRatio === 'number' && devicePixelRatio) || 1, quality.maxPixelRatio);
    const limit = Math.min(ctx.caps.maxTextureSize, 8192);
    const w = Math.min(limit, Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * ratio)));
    const h = Math.min(limit, Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * ratio)));
    const pw = Math.max(2, Math.round(w * quality.resolutionScale)), ph = Math.max(2, Math.round(h * quality.resolutionScale));
    if (w === canvasWidth && h === canvasHeight && pw === postWidth && ph === postHeight && targets.post) return;
    canvasWidth = w; canvasHeight = h; postWidth = pw; postHeight = ph;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    allocate();
  }
  resize();

  // ------------------------------------------------------------------------------------------ GPU timing
  // Timer queries report a few frames late, so a small ring of them is kept in flight.
  const timer = { queries: [], pending: [], active: null, ms: -1 };
  function beginGpuTimer() {
    const ext = ctx.ext.timer;
    if (!ext) return;
    while (timer.pending.length) {
      const q = timer.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      timer.pending.shift();
      // A disjoint event (the GPU was busy with something else) makes the measurement meaningless.
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) { const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; timer.ms = timer.ms < 0 ? ms : timer.ms + (ms - timer.ms) * 0.2; }
      timer.queries.push(q);
    }
    if (timer.pending.length >= 4) return;                    // results are not coming back: stop piling up
    timer.active = timer.queries.pop() || gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, timer.active);
  }
  function endGpuTimer() {
    if (!timer.active) return;
    gl.endQuery(ctx.ext.timer.TIME_ELAPSED_EXT);
    timer.pending.push(timer.active); timer.active = null;
  }

  // ------------------------------------------------------------------------------------------ per-frame scratch
  const jitter = jitterSequence(JITTER_LENGTH);
  const cam = new Float64Array(3), prevCam = new Float64Array(3), forward = new Float64Array(3);
  const proj = new Float64Array(16), projJittered = new Float64Array(16), viewRot = new Float64Array(16);
  const viewProj = new Float64Array(16), viewProjStable = new Float64Array(16), prevStable = new Float64Array(16);
  const prevRelative = new Float64Array(16), invViewProj = new Float64Array(16), shift = new Float64Array(16);
  const planes = new Float64Array(24);
  const mirrorPlanes = new Float64Array(24), mirrorReflect = new Float64Array(16), mirrorScratch = new Float64Array(16), mirrorMatrix = new Float32Array(16);
  mirrorReflect[0] = mirrorReflect[10] = mirrorReflect[15] = 1; mirrorReflect[5] = -1;
  const shadowView = { cam, forward, tanHalfFovY: 1, aspect: 1 };

  /**
   * The street's lamps into a second view that has just been drawn (a probe face, the road mirror): glow
   * records as small sources, added to the bound target and hidden by its depth buffer.
   * matrix, viewPlanes: camera-relative world -> clip of the view and its frustum; eye: the view's eye
   * relative to the camera; clipHeight: camera-relative height below which nothing is drawn;
   * ownRadius: glows this close to the probe's origin belong to the car it sits in and are left out.
   */
  function reflectedLamps(matrix, viewPlanes, viewPixelsPerMetre, viewWidth, viewHeight, eyeX, eyeY, eyeZ, clipHeight, ownRadius, reach) {
    const program = fixed.glowView;
    if (!program.use()) return;
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(program.loc('uAltViewProj'), false, matrix);
    gl.uniform4f(program.loc('uAltEye'), eyeX, eyeY, eyeZ, 0);
    gl.uniform4f(program.loc('uGlowView'), viewPixelsPerMetre, 2 / viewWidth, 2 / viewHeight, clipHeight);
    gl.uniform4f(program.loc('uGlowSkip'), probe.relative[0], probe.relative[1], probe.relative[2], ownRadius);
    glows.draw(program, cam, viewPlanes, reach);
    gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.CULL_FACE);
  }
  const probeLamps = (matrix, viewPlanes, viewPixelsPerMetre, viewWidth, viewHeight) =>
    reflectedLamps(matrix, viewPlanes, viewPixelsPerMetre, viewWidth, viewHeight, probe.relative[0], probe.relative[1], probe.relative[2], -1e9, PROBE_OWN_LAMPS, PROBE_REACH);
  const clearBlack = new Float32Array([0, 0, 0, 0]), clearAlbedo = new Float32Array([0, 0, 0, 1]);
  const stageCamera = { position: cam, view: new Float32Array(16), proj: new Float32Array(16), viewProj: new Float32Array(16), fovY: 1, near: 0.3, far: 6000 };
  const stage = { gl, frame: null, env: null, time: 0, dt: 0, frameIndex: 0, width: 0, height: 0, camera: stageCamera, quality, framebuffer: null };
  const postParams = {
    quality, dt: 0, time: 0, frameIndex: 0, exposure: 1, night: 0, grade: null, fade: 0, speedEffect: 0, historyValid: false, temporal: true,
    exhaust: null, cam, pixelsPerMetre: 1, debugMode: 0, aoPresent: false, canvasWidth: 0, canvasHeight: 0,
    // A closed room is shown (design/GARAGE.md), and frame.room of that frame or null; frame.focus
    // ({ distance in metres, aperture as an f-number }) for the depth of field of the post chain, or null.
    interior: false, room: null, focus: null,
  };
  const stats = {
    fps: 0, cpuMs: 0, gpuMs: -1, drawCalls: 0, triangles: 0, lights: 0, tiles: 0, resolution: [0, 0], scale: 1,
    // Beyond ARCHITECTURE 7: what the light and bloom tuning is doing right now.
    lightsDropped: 0, lightsOffered: 0, glows: 0, particles: 0, shadowCascadesDrawn: 0,
    // Surface programs the scene needs that cannot be drawn with yet (see the shadersPending getter): automation waits for 0.
    shadersPending: 0,
    // exposure = env.exposure x 2^bias; the meter may then correct it within exposureBand (multipliers).
    exposure: 0, exposureBias: 0, exposureBand: [EXPOSURE_BAND.min, EXPOSURE_BAND.max], bloomStrength: 0, bloomAmount: 0,
    roadMirror: false,       // whether the wet-road mirror pass ran this frame
    interior: false,         // whether this frame showed a closed room (frame.env.interior) instead of the street
    probeFaces: 0,           // faces of the scene reflection probe redrawn this frame
    // Triangles by pass (they add up to `triangles`): shadow cascades, probe faces, road mirror, the main view.
    trianglesShadow: 0, trianglesProbe: 0, trianglesMirror: 0, trianglesMain: 0,
  };
  let lastFrameAt = 0, smoothedInterval = 1000 / 60;

  /** Run the passes another module registered for a stage. A pass that throws is reported once and removed. */
  function runStage(name, framebuffer) {
    const list = passes[name];
    if (!list.length) return;
    stage.framebuffer = framebuffer;
    for (let i = 0; i < list.length; i++) {
      try { list[i](stage); } catch (error) {
        console.error(`Renderer: a "${name}" pass failed and was disabled: ${error && error.stack ? error.stack : error}`);
        list.splice(i--, 1);
      }
    }
    // Whatever the pass did, the renderer's next step starts from known state.
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.bindVertexArray(null); gl.disable(gl.SCISSOR_TEST); gl.colorMask(true, true, true, true);
    gl.viewport(0, 0, targets.width, targets.height);
  }

  function linearizeDepth(a, b) {
    const s = targets.scene, program = fixed.linearDepth;
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.sceneDepthFbo);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND);
    if (!program.use()) return;
    program.texture('uDepthTex', s.depth);
    gl.uniform4f(program.loc('uDepthParams'), a, b, 0, 0);
    drawFullscreen();
  }

  // ------------------------------------------------------------------------------------------ the frame
  /**
   * Draw one frame. frame (ARCHITECTURE 7 and 16):
   *   time, dt, camera { position, view, fovY, near, far, cut? }, env, lights + lightCount, glows + glowCount,
   *   occluders + occluderCount, spray, exhaust, speedEffect, exposureBias, fade,
   *   reflectionPlaneY (world height of the wet-road mirror; default: the road datum),
   *   reflectionOrigin (world position the scene reflection probe is captured from: the player's car, about
   *   a metre above the road; default: the camera)
   */
  function render(frame) {
    if (contextLost || disposed) return;
    const cpuStart = now();
    const env = frame && frame.env, camera = frame && frame.camera;
    if (!env || !env.weather || !camera) throw new Error('render(frame): frame.camera and frame.env (from deriveEnvironment) are required.');
    const weather = env.weather;
    const dt = Math.max(0, frame.dt || 0), time = frame.time || 0;
    const temporal = quality.antialiasing === 'taa';
    // A closed room (design/GARAGE.md): only what is flagged `interior` is drawn, lit by the frame's own
    // lights and the room's light box; no sun, sky, weather or city. Going in or coming out, nothing of the
    // last frame is where it was, so that frame is a camera cut.
    const interior = env.interior === true, room = interior ? frame.room || null : null;
    const cut = !!camera.cut || !historyValid || interior !== wasInterior;
    scene.interior = interior; glows.interior = interior;
    // Programs are compiled a few at a time and this is what moves the line along; then at most one surface
    // program has its first draw, here, before anything of the frame is bound. A frame is play, which the
    // programs that only make drawing faster wait for (gl.js): a long frame counts as a short one, and
    // none counts while a program the picture needs has yet to be drawn for the first time.
    if (surface.pending > 0) ctx.quietSeconds = 0;
    programsLinking(ctx, Math.min(dt, LONGEST_QUIET_STEP));
    surface.tick(scene);
    const newPrograms = surface.generation !== surfaceGeneration;
    surfaceGeneration = surface.generation;

    // ---- resolution
    if (quality.dynamicResolution) allocateScene();           // no-op unless the controller moved a step
    const width = targets.width, height = targets.height, s = targets.scene;
    beginGpuTimer();

    // ---- camera. Everything the GPU sees is relative to the camera position, subtracted here in doubles.
    cam[0] = camera.position[0]; cam[1] = camera.position[1]; cam[2] = camera.position[2];
    const near = camera.near || 0.3, far = camera.far || 6000, aspect = width / height;
    m4perspective(proj, camera.fovY, aspect, near, far);
    viewRot.set(camera.view); viewRot[12] = viewRot[13] = viewRot[14] = 0;
    forward[0] = -viewRot[2]; forward[1] = -viewRot[6]; forward[2] = -viewRot[10];
    m4mul(viewProjStable, proj, viewRot);
    projJittered.set(proj);
    if (temporal) {
      // A sub-pixel shift of the whole image: NDC moves by 2 * pixels / size, and NDC x = -(p0 x + p8 z) / z.
      const j = (frameIndex % JITTER_LENGTH) * 2;
      projJittered[8] -= 2 * jitter[j] / width; projJittered[9] -= 2 * jitter[j + 1] / height;
    }
    m4mul(viewProj, projJittered, viewRot);
    m4invert(invViewProj, viewProjStable);
    if (cut) prevRelative.set(viewProjStable);
    else {
      // Last frame's projection, re-expressed for positions relative to where the camera is NOW.
      shift.fill(0); shift[0] = shift[5] = shift[10] = shift[15] = 1;
      shift[12] = cam[0] - prevCam[0]; shift[13] = cam[1] - prevCam[1]; shift[14] = cam[2] - prevCam[2];
      m4mul(prevRelative, prevStable, shift);
    }
    extractPlanes(planes, viewProjStable);

    // ---- Frame block
    const exposure = (env.exposure || 1) * Math.pow(2, quality.exposureBias + (frame.exposureBias || 0));
    const noisePhase = temporal ? frameIndex % 64 : 0, wind = weather.wind;
    const lightDir = env.lightDir, lightColor = env.lightColor, switches = env.switches;
    const fb = frameBlock;
    fb.set(viewProj, F.viewProj); fb.set(viewProjStable, F.viewProjStable); fb.set(prevRelative, F.prevViewProj); fb.set(viewRot, F.view); fb.set(invViewProj, F.invViewProj);
    fb[F.camPos] = cam[0]; fb[F.camPos + 1] = cam[1]; fb[F.camPos + 2] = cam[2];
    fb[F.time] = time; fb[F.time + 1] = dt; fb[F.time + 2] = frameIndex % 4096; fb[F.time + 3] = env.timeOfDay || 0;
    fb[F.weather] = weather.rain || 0; fb[F.weather + 1] = weather.wetness || 0; fb[F.weather + 2] = weather.puddles || 0; fb[F.weather + 3] = weather.clouds || 0;
    // Gusts: a slow swell the foliage shaders share, stronger in a stronger wind.
    const gust = Number.isFinite(weather.gust) ? weather.gust : (0.5 + 0.3 * Math.sin(time * 0.37) + 0.2 * Math.sin(time * 0.91 + 1.7)) * Math.min(1, Math.hypot(wind[0], wind[1]) / 8);
    fb[F.wind] = wind[0]; fb[F.wind + 1] = wind[1]; fb[F.wind + 2] = gust; fb[F.wind + 3] = weather.lightning || 0;
    fb[F.switches] = switches.street || 0; fb[F.switches + 1] = switches.neon || 0; fb[F.switches + 2] = switches.windows || 0; fb[F.switches + 3] = env.night || 0;
    fb[F.sunDir] = lightDir[0]; fb[F.sunDir + 1] = lightDir[1]; fb[F.sunDir + 2] = lightDir[2]; fb[F.sunDir + 3] = env.isSun === false ? 0 : 1;
    fb[F.sunColor] = lightColor[0]; fb[F.sunColor + 1] = lightColor[1]; fb[F.sunColor + 2] = lightColor[2]; fb[F.sunColor + 3] = exposure;
    if (interior) {
      // No sun reaches a room. Whatever still asks for the direction of the key light gets straight up,
      // where the light box hangs.
      fb[F.sunDir] = 0; fb[F.sunDir + 1] = 1; fb[F.sunDir + 2] = 0;
      fb[F.sunColor] = fb[F.sunColor + 1] = fb[F.sunColor + 2] = 0;
    }
    fb[F.viewport] = width; fb[F.viewport + 1] = height; fb[F.viewport + 2] = 1 / width; fb[F.viewport + 3] = 1 / height;
    // y: under temporal AA alpha-tested edges are dithered so that they resolve to soft coverage.
    fb[F.quality] = quality.detail; fb[F.quality + 1] = temporal ? 0.5 : 0; fb[F.quality + 2] = noisePhase; fb[F.quality + 3] = 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, frameBuffer); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, fb);

    // ---- other modules prepare (sky probe, ocean simulation)
    stage.frame = frame; stage.env = env; stage.time = time; stage.dt = dt; stage.frameIndex = frameIndex; stage.width = width; stage.height = height; stage.quality = quality;
    stageCamera.view.set(viewRot); stageCamera.proj.set(proj); stageCamera.viewProj.set(viewProjStable); stageCamera.fovY = camera.fovY; stageCamera.near = near; stageCamera.far = far;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    runStage('prepare', null);

    // ---- visibility, lights, shadows
    const tanHalfFov = Math.tan(camera.fovY / 2), pixelsPerMetre = height / (2 * tanHalfFov);
    scene.drawCalls = 0; scene.triangles = 0;
    scene.cull(cam, planes, height / camera.fovY);
    const planeY = Number.isFinite(frame.reflectionPlaneY) ? frame.reflectionPlaneY : LAND_Y;
    // Lights are ranked from the player's car and fade when the preset's limit changes their places; a cut may not fade.
    const lightCount = lights.buildGrid(cam, planes, env, time, frame.lights, frame.lightCount | 0, quality.reflections.probe > 0 ? PROBE_LIGHT_REACH : 0,
      frame.reflectionOrigin || cam, planeY, cut ? Infinity : dt, interior);
    lights.setOccluders(cam, frame.occluders, frame.occluders ? frame.occluderCount | 0 : 0);
    lights.setRoom(cam, room);
    shadowView.tanHalfFovY = tanHalfFov; shadowView.aspect = aspect;
    lights.renderShadows(scene, shadowView, lightDir, env.isSun !== false, frameIndex, cut, room, interior);
    rainCover.update(scene, cam, !interior && Math.max(weather.wetness || 0, weather.puddles || 0, weather.rain || 0) > 0.01);
    const shadowTriangles = scene.triangles;
    const mirrorHeight = planeY - cam[1];
    // ---- scene reflection probe: a few faces of the cube around the player's car (or the camera); in a
    // closed room, that room's own cube, drawn when the room opens and read against the room's box. Sized
    // here, every frame: the street's and a room's differ, and so do the presets'.
    probe.configure(room ? quality.reflections.roomProbe : quality.reflections.probe, quality.reflections.probeFaces, room ? quality.reflections.roomProbeFine : 1);
    probe.plan(cam, frame.reflectionOrigin || cam, cut, room, newPrograms);
    lights.setProbe(probe.relative, probe.valid, mirrorHeight, PROBE_LAST_LEVEL, probe.faceShift);
    lights.setProbeRoom(cam, probe.room ? room : null);
    lights.upload(weather.lightning || 0, exposure, noisePhase);
    glows.stage(cam, frame.glows, frame.glowCount | 0);
    probe.capture(scene, probeLamps);
    const probeTriangles = scene.triangles - shadowTriangles;

    // ---- wet-road mirror: the scene as the road plane reflects it, for the reflection resolve further down.
    // A closed room's polished floor is the same mirror, wet or not: the whole room and the car in it are
    // drawn (they are small), because the tubes above the frame and the far side of the car are exactly
    // what a trace across the screen cannot find.
    const mirrorTaps = room ? quality.reflections.roomPlanar
      : Math.max(weather.wetness || 0, weather.puddles || 0, weather.rain || 0) > 0.01 ? quality.reflections.planar : 0;
    const mirrored = mirrorTaps > 0 && !!s.planar && fixed.mirrorLevel.ready && mirrorHeight < -MIRROR_MIN_HEIGHT;
    if (mirrored) {
      // y' = 2 h - y in camera-relative space, then the camera's own projection. The image is shifted by
      // its own sub-texel jitter so that temporal AA averages its half-resolution edges away.
      mirrorReflect[13] = 2 * mirrorHeight;
      projJittered.set(proj);
      if (temporal) { const j = (frameIndex % JITTER_LENGTH) * 2; projJittered[8] -= 2 * jitter[j] / s.planarWidth; projJittered[9] -= 2 * jitter[j + 1] / s.planarHeight; }
      m4mul(mirrorScratch, projJittered, viewRot); m4mul(mirrorScratch, mirrorScratch, mirrorReflect);
      mirrorMatrix.set(mirrorScratch);
      extractPlanes(mirrorPlanes, mirrorScratch);
      scene.cullView(mirrorPlanes, s.planarHeight / camera.fovY, MIRROR_REACH, planeY, null, MIRROR_LOD);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.planarFbo); gl.viewport(0, 0, s.planarWidth, s.planarHeight);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND); gl.cullFace(gl.BACK);
      gl.clearBufferfv(gl.COLOR, 0, clearBlack); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
      // The mirror's eye is the camera's reflection; the road itself and the paint a hair above it stay out.
      scene.drawView(mirrorMatrix, 0, 2 * mirrorHeight, 0, true, mirrorHeight + MIRROR_CLIP);
      // The street's lamps are glow sprites and are added as such; a room's are its tubes, drawn above.
      if (!room) reflectedLamps(mirrorMatrix, mirrorPlanes, s.planarHeight / (2 * tanHalfFov), s.planarWidth, s.planarHeight, 0, 2 * mirrorHeight, 0, mirrorHeight + MIRROR_CLIP, 0, MIRROR_REACH);
      // The levels the roughness fan reads, each from the one above (MIRROR_LEVEL_FS).
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
      const level = fixed.mirrorLevel; level.use(); level.texture('uSource', s.planar);
      for (let i = 1; i < s.planarLevels; i++) {
        const w = Math.max(1, s.planarWidth >> i), h = Math.max(1, s.planarHeight >> i);
        gl.bindFramebuffer(gl.FRAMEBUFFER, s.planarScratchFbos[i - 1]); gl.viewport(0, 0, w, h);
        gl.uniform4f(level.loc('uLevel'), i - 1, 0.75 / Math.max(1, s.planarWidth >> (i - 1)), 0.75 / Math.max(1, s.planarHeight >> (i - 1)), 0);
        drawFullscreen();
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.planarScratchFbos[i - 1]); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.planarLevelFbos[i]);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.enable(gl.CULL_FACE);
    }

    const mirrorTriangles = scene.triangles - shadowTriangles - probeTriangles;

    // ---- G-buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.gbufferFbo); gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK); gl.frontFace(gl.CCW);
    gl.clearBufferfv(gl.COLOR, 0, clearAlbedo); gl.clearBufferfv(gl.COLOR, 1, clearBlack); gl.clearBufferfv(gl.COLOR, 2, clearBlack); gl.clearBufferfv(gl.COLOR, 3, clearBlack);
    gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    scene.drawGBuffer();

    // ---- depth in metres, ambient occlusion
    // For the projection above: ndc = A + B / z, so z = B' / (ndc + A') with A' = -(f + n) / (f - n), B' = -2 f n / (f - n).
    const depthA = -(far + near) / (far - near), depthB = -2 * far * near / (far - near);
    linearizeDepth(depthA, depthB);
    const aoOn = quality.ao.taps > 0 && !!s.aoA && fixed.ao.ready && fixed.aoBlur.ready;
    if (aoOn) {
      gl.viewport(0, 0, s.aoWidth, s.aoHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.aoAFbo);
      fixed.ao.use(); gl.uniform4f(fixed.ao.loc('uAo'), quality.ao.radius, quality.ao.taps, pixelsPerMetre, noisePhase); drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.aoBFbo);
      fixed.aoBlur.use(); fixed.aoBlur.texture('uAoTex', s.aoA); gl.uniform2f(fixed.aoBlur.loc('uBlurDir'), 1 / s.aoWidth, 0); drawFullscreen();
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.aoAFbo);
      fixed.aoBlur.texture('uAoTex', s.aoB); gl.uniform2f(fixed.aoBlur.loc('uBlurDir'), 0, 1 / s.aoHeight); drawFullscreen();
      gl.viewport(0, 0, width, height);
    }

    // ---- deferred lighting: a far-plane triangle with GREATER shades exactly the pixels that hold geometry
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.litFbo);
    gl.clearBufferfv(gl.COLOR, 0, clearBlack);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GREATER); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    if (fixed.lighting.use()) {
      gl.uniform4f(fixed.lighting.loc('uLightingParams'), aoOn ? 1 : 0, debugMode === 5 ? 1 : debugMode === 6 ? 2 : 0, 0, 0);
      drawFullscreen();
    }

    // ---- water: a forward-lit surface that also writes its surface description and depth
    const hasWater = !interior && passes.water.length > 0;
    if (hasWater) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.litColourFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.sceneOpaqueFbo);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.waterFbo);
      gl.depthFunc(gl.LESS); gl.depthMask(true);
      runStage('water', s.waterFbo);
    }

    // ---- sky dome behind everything
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.litFbo);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    runStage('background', s.litFbo);
    if (hasWater) linearizeDepth(depthA, depthB);

    // ---- reflections: trace against last frame's image, then resolve with the environment and add fog
    const ssr = quality.reflections;
    const traced = ssr.steps > 0 && !!s.ssrColor && !cut && fixed.ssrTrace.ready;
    if (traced) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.ssrFbo); gl.viewport(0, 0, s.ssrWidth, s.ssrHeight);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      fixed.ssrTrace.use();
      gl.uniform4f(fixed.ssrTrace.loc('uSsr'), ssr.steps, ssr.refine, SSR_REACH, noisePhase);
      gl.uniform4f(fixed.ssrTrace.loc('uSsrInfo'), 1, 0, 0, 0);
      gl.uniform4fv(fixed.ssrTrace.loc('uSsrRoom'), lights.probeRoom);
      drawFullscreen();
      gl.viewport(0, 0, width, height);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, s.litFbo);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GREATER); gl.depthMask(false);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.SRC_ALPHA);          // lit = lit * transmittance + (specular + in-scatter)
    if (fixed.reflection.use()) {
      // Bound even when nothing was traced: a sampler must never be left on a unit holding a texture of
      // another kind, or the browser rejects the draw.
      fixed.reflection.texture('uSsrColor', s.ssrColor || whiteTexture); fixed.reflection.texture('uSsrAux', s.ssrAux || whiteTexture);
      gl.uniform4f(fixed.reflection.loc('uReflect'), traced ? 1 : 0, ssr.resolve, pixelsPerMetre, noisePhase);
      fixed.reflection.texture('uPlanarTex', mirrored ? s.planar : whiteTexture); fixed.reflection.texture('uPlanarDepth', mirrored ? s.planarDepth : whiteTexture);
      gl.uniform4f(fixed.reflection.loc('uPlanar'), mirrored ? mirrorTaps : 0, mirrorHeight, depthA, depthB);
      gl.uniform4f(fixed.reflection.loc('uReflectFx'), quality.volumetrics && quality.shadows.cascades && !interior ? SHAFT_STRENGTH : 0, Math.min(SHAFT_REACH, quality.shadows.distance), aoOn ? 1 : 0, debugMode === DEBUG_PROBE ? 1 : 0);
      drawFullscreen();
    }

    // ---- glass, far to near
    gl.depthFunc(gl.LEQUAL); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.CULL_FACE);
    scene.drawForward();

    // ---- rain and other registered particles, then spray, smoke and sparks
    gl.disable(gl.CULL_FACE);
    runStage('particles', s.litFbo);
    // Spray and smoke belong to the street: in a room what is still in the air ages unseen and nothing is added.
    particles.update(dt, interior ? null : frame.spray, interior ? null : frame.exhaust, wind);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.disable(gl.CULL_FACE);
    if (!interior && particles.count && fixed.particle.use()) particles.draw(cam, forward);

    // ---- glow sprites: additive, occlusion measured in the vertex shader
    gl.disable(gl.DEPTH_TEST); gl.blendFunc(gl.ONE, gl.ONE);
    if (fixed.glow.use()) {
      gl.uniform4f(fixed.glow.loc('uGlow'), exposure, pixelsPerMetre, 1, height);
      glows.drawn = glows.draw(fixed.glow, cam, planes);
    }
    gl.disable(gl.BLEND);

    // ---- post
    const pp = postParams;
    pp.quality = quality; pp.dt = dt; pp.time = time; pp.frameIndex = frameIndex; pp.exposure = exposure; pp.night = env.night || 0; pp.grade = env.grade || null;
    pp.fade = frame.fade || 0; pp.speedEffect = frame.speedEffect || 0; pp.historyValid = !cut; pp.temporal = temporal; pp.exhaust = frame.exhaust || null;
    pp.interior = interior; pp.room = room; pp.focus = frame.focus || null;
    pp.pixelsPerMetre = targets.postHeight / (2 * tanHalfFov); pp.debugMode = debugMode === DEBUG_PROBE ? 0 : debugMode; pp.aoPresent = aoOn; pp.canvasWidth = canvasWidth; pp.canvasHeight = canvasHeight;
    post.run(pp);
    ctx.shared.set('uSceneColor', sharedSceneColor(targets.post.history[targets.historyIndex]));

    // ---- bookkeeping
    endGpuTimer();
    scene.endFrame();
    prevStable.set(viewProjStable); prevCam[0] = cam[0]; prevCam[1] = cam[1]; prevCam[2] = cam[2];
    historyValid = true; wasInterior = interior; frameIndex++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const t = now(), interval = lastFrameAt ? t - lastFrameAt : 1000 / 60;
    lastFrameAt = t;
    smoothedInterval += (Math.min(interval, 250) - smoothedInterval) * 0.08;
    stats.fps = 1000 / smoothedInterval; stats.cpuMs += (t - cpuStart - stats.cpuMs) * 0.1; stats.gpuMs = timer.ms;
    stats.drawCalls = scene.drawCalls; stats.triangles = Math.round(scene.triangles); stats.lights = lightCount; stats.lightsDropped = lights.grid.dropped; stats.lightsOffered = lights.grid.offered;
    stats.tiles = scene.staticsInView; stats.resolution[0] = width; stats.resolution[1] = height; stats.scale = drs.scale * quality.resolutionScale;
    stats.glows = glows.drawn; stats.particles = particles.count; stats.shadowCascadesDrawn = lights.shadowDraws;
    stats.interior = interior; stats.shadersPending = surface.pending;
    stats.exposure = exposure; stats.exposureBias = quality.exposureBias + (frame.exposureBias || 0);
    stats.bloomStrength = quality.bloomStrength; stats.bloomAmount = post.bloomAmount; stats.roadMirror = mirrored; stats.probeFaces = probe.facesDrawn;
    stats.trianglesShadow = Math.round(shadowTriangles); stats.trianglesProbe = Math.round(probeTriangles); stats.trianglesMirror = Math.round(mirrorTriangles);
    stats.trianglesMain = stats.triangles - stats.trianglesShadow - stats.trianglesProbe - stats.trianglesMirror;
    // With timer queries the controller steers on GPU time; without them on the frame interval, which
    // vsync pins to the refresh period, so it can only tell "too slow" from "fine".
    if (quality.dynamicResolution && dt > 0) drs.update(dt, timer.ms >= 0 ? timer.ms : interval, timer.ms >= 0);
  }

  // One record is reused for the texture that changes hands every frame.
  const sceneColorRecord = { target: gl.TEXTURE_2D, texture: null };
  function sharedSceneColor(texture) { sceneColorRecord.texture = texture; return sceneColorRecord; }

  // ------------------------------------------------------------------------------------------ context loss
  function onLost(event) {
    event.preventDefault();                    // tells the browser that the context should be restored
    contextLost = true;
    // On Direct3D a shader that takes too long to compile is what loses the context: name the last one.
    console.warn(`Renderer: the WebGL context was lost. Last shader program compiled or first drawn: ${ctx.lastProgram || 'none'}. Materials split into group programs: ${split ? 'yes' : 'no'}.`);
    if (typeof api.onContextLost === 'function') api.onContextLost();
  }
  function onRestored() {
    // Every GL object is gone. Rebuild in dependency order; CPU-side data (meshes, instances, lights) was kept.
    ctx.ext.parallel = gl.getExtension('KHR_parallel_shader_compile'); ctx.ext.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    ctx.ext.aniso = gl.getExtension('EXT_texture_filter_anisotropic'); ctx.ext.floatLinear = gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_float');
    timer.queries.length = 0; timer.pending.length = 0; timer.active = null; timer.ms = -1;
    atlasTexture = null;
    ctx.shared.clear();                        // every published texture is stale; each owner publishes again below
    createSharedObjects();
    surface.forget();
    recompilePrograms(ctx);
    targets.forget(); lights.forget(); lights.configure(quality); probe.restore(); rainCover.restore();
    scene.restore(); glows.restore(); particles.restore(); flames.restore();
    allocate();
    for (const fn of restoreCallbacks) fn();
    contextLost = false;
    if (typeof api.onContextRestored === 'function') api.onContextRestored();
  }
  if (typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('webglcontextlost', onLost, false);
    canvas.addEventListener('webglcontextrestored', onRestored, false);
  }

  // ------------------------------------------------------------------------------------------ public interface
  const api = {
    caps: ctx.caps,
    stats,
    /** The renderer's own name and what it is: the fork's label for the WebGL 2 engine below. */
    engine: ENGINE,
    /** The sky module's object (setShoreField, setCity, ...), or the fallback sky ({ fallback: true }). */
    sky,
    /** The host interface (host.js), for tools. */
    host,
    /** Live render targets ({ scene, post } of targets.js), for inspection tools only. */
    get internals() { return { scene: targets.scene, post: targets.post }; },
    /** Optional callbacks, set by the game. */
    onContextLost: null, onContextRestored: null,
    /**
     * The most light records an interior frame may pass at this quality (design/GARAGE.md). A room is a
     * few light cells across and every one of its lights reaches all of it, so the slots of one cell are
     * the limit.
     */
    get interiorLightBudget() { return quality.lights.perCell; },

    /** Surface programs that geometry in the scene needs and that cannot be drawn with yet: their triangles are missing from the frame. */
    get shadersPending() { return surface.pending; },
    /** Whether the families' materials are drawn as separate group programs (Direct3D) or each family as one. */
    split,
    /** Name of the shader program compiled or first drawn last: what to suspect when the context is lost. */
    get lastProgram() { return ctx.lastProgram; },

    /**
     * Resolves once every shader program the scene needs so far is compiled, linked and, for the surface
     * programs, drawn for the first time (one at a time; surfaceprograms.js), so that a frame rendered
     * afterwards compiles nothing. Call it after the first scene is set up. onProgress(0..1) for the
     * loading screen. Rejects with a readable Error: a program that cannot be built, or a lost context.
     */
    async warmup(onProgress = null) {
      let most = 1, shown = 0;
      for (;;) {
        if (contextLost) throw new Error(`The WebGL context was lost while the shaders were being prepared. Last shader program compiled or first drawn: ${ctx.lastProgram || 'none'}.`);
        const left = programsLinking(ctx) + surface.tick(scene);
        most = Math.max(most, left); shown = Math.max(shown, 1 - left / most);
        if (onProgress) onProgress(left ? shown : 1);
        if (!left) return;
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
    },

    /** graphics: settings.graphics (ARCHITECTURE 11.2), plus optional bloomStrength (0..2) and exposureBias (stops, -2..2). */
    setQuality(graphics) {
      const next = resolveQuality(graphicsOf(graphics)), rebuild = needsRebuild(quality, next);
      const particleChange = next.particles.max !== quality.particles.max;
      quality = next;
      chooseSurfacePasses();
      if (rebuild) lights.configure(quality);
      if (particleChange) particles.configure(quality.particles.max);
      drs.configure(1, MIN_DYNAMIC_SCALE, quality.frameTarget);
      if (!quality.dynamicResolution) drs.reset();
      canvasWidth = 0;                          // forces resize() to reallocate every target for the new settings
      resize();
    },
    resize,

    /** source: canvas or ImageBitmap of the sign atlas (or { data: Uint8Array RGBA, width, height }). Kept for context restore. */
    setAtlas(source) { atlasSource = source || null; uploadAtlas(); },

    createMesh: (data, options) => scene.createMesh(data, options),
    destroyMesh: (handle) => scene.destroyMesh(handle),
    addStatic: (description) => scene.addStatic(description),
    addInstances: (description) => scene.addInstances(description),
    remove: (id) => scene.remove(id),
    addDynamic: (description) => scene.addDynamic(description),

    /** Static lights and glows of one tile (world-space records, ARCHITECTURE 4.4 / 4.5); null clears. */
    setLights(key, lightRecords, glowRecords) { lights.setStatic(key, lightRecords); glows.set(key, glowRecords, lightRecords); },

    render,

    /** 0 final image, 1 albedo, 2 normals, 3 roughness, 4 occlusion, 5 local lights only, 6 shadows, 7 velocity, 8 wetness. */
    debug(mode) { debugMode = Math.min(DEBUG_PROBE, Math.max(0, mode | 0)); },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof canvas.removeEventListener === 'function') {
        canvas.removeEventListener('webglcontextlost', onLost, false);
        canvas.removeEventListener('webglcontextrestored', onRestored, false);
      }
      if (typeof sky.dispose === 'function') sky.dispose();
      targets.dispose(); lights.release(); probe.dispose(); rainCover.dispose(); surface.dispose();
      for (const program of ctx.programs.slice()) program.dispose();
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    },
  };
  return api;
}

export { guessTier };
