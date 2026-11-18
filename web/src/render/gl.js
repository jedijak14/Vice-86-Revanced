// WebGL2 plumbing: context and capability detection, shader programs (asynchronous compile, readable
// errors, named shared textures), textures and framebuffers. No rendering policy lives here.

import { FRAME_BLOCK_BINDING, SKY_BLOCK_BINDING } from './host.js';

/** Uniform buffer binding of the renderer's own `Lighting` block (shadows, light grid, occluders). */
export const LIGHTING_BLOCK_BINDING = 2;
const BLOCK_BINDINGS = { Frame: FRAME_BLOCK_BINDING, Sky: SKY_BLOCK_BINDING, Lighting: LIGHTING_BLOCK_BINDING };

const COMPLETION_STATUS_KHR = 0x91b1;

/**
 * Create the WebGL2 context and gather what the renderer needs to know about the device.
 * Throws an Error with a message fit for the loading screen when the device cannot run the game.
 */
export function createContext(canvas, { force = false } = {}) {
  const attrs = { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, desynchronized: true };
  let gl = canvas.getContext('webgl2', attrs);
  let relaxedAttrs = false;
  if (!gl && force) {
    // The first request is the one the game wants: a discrete GPU, and a drawing buffer that is not
    // synchronised against the compositor. Both of those are also things a software rasteriser or a
    // power-managed laptop driver *refuses*, and a refusal is not the same as an inability -- so asking
    // for less is what gets a context on devices that were being turned away for the wrong reason.
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false });
    relaxedAttrs = !!gl;
  }
  if (!gl) throw new Error('This game needs WebGL2, which this browser or device does not provide. Try a current version of Chrome, Edge, Firefox or Safari with hardware acceleration enabled.');
  const floatTargets = gl.getExtension('EXT_color_buffer_float');
  if (!floatTargets && !force) throw new Error('This graphics device cannot render to floating-point textures (EXT_color_buffer_float is missing), which the game needs for HDR lighting.');
  const ext = {
    parallel: gl.getExtension('KHR_parallel_shader_compile'),
    timer: gl.getExtension('EXT_disjoint_timer_query_webgl2'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
    floatLinear: gl.getExtension('OES_texture_float_linear'),
  };
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererNamed = String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || '');    // '' when the browser hides the driver
  const renderer = rendererNamed || String(gl.getParameter(gl.RENDERER) || '');
  const vendor = String((info && gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || '');
  const caps = {
    vendor, renderer,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    floatLinear: !!ext.floatLinear,
    timerQuery: !!ext.timer,
    tierHint: guessTier(renderer, gl.getParameter(gl.MAX_TEXTURE_SIZE)),
  };
  if (caps.maxDrawBuffers < 4 && !force) throw new Error('This graphics device supports fewer than 4 render targets, which the game needs.');
  if (force && (!floatTargets || caps.maxDrawBuffers < 4 || relaxedAttrs)) {
    // Say what was stepped over, on the console where a person diagnosing this will find it. Forcing
    // cannot manufacture a feature: a device without float render targets is not going to draw HDR
    // because it was asked to try, and the honest expectation is a dark or wrong image, not a
    // downgraded one. What forcing does buy is the chance that the refusal was about the request.
    const skipped = [];
    if (!floatTargets) skipped.push('float render targets (EXT_color_buffer_float)');
    if (caps.maxDrawBuffers < 4) skipped.push(`${caps.maxDrawBuffers} draw buffer(s), 4 wanted`);
    if (relaxedAttrs) skipped.push("the 'high-performance' and desynchronised context attributes");
    console.warn(`WebGL2 was forced past: ${skipped.join(', ')}. The renderer will run as-is on this device and may fail or draw nothing.`);
    caps.tierHint = 'ultraLow';       // whatever the autotuner would have picked, start at the very bottom
  }
  return { gl, canvas, caps, rendererNamed, ext, forced: !!force, floatTargets: !!floatTargets, maxAnisotropy: ext.aniso ? Math.min(8, gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) : 1, shared: new Map(), programs: [], waiting: [], compiling: [], quietSeconds: 0, lastProgram: '' };
}

/** Rough preset guess from the renderer string; the UI refines it with measured frame times. */
export function guessTier(renderer, maxTextureSize) {
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|software|basic render/.test(r)) return 'ultraLow';
  if (/rtx|radeon rx (6[7-9]|7[6-9]|9)\d\d|rx (6[7-9]|7[6-9])\d\d|arc a7|m[1-4] (max|ultra)/.test(r)) return 'ultra';
  if (/gtx (9[7-8]|1[06][5-9])\d|gtx 1080|rx (5[5-9]|6[0-6])\d\d|radeon pro|arc a[35]|apple m[1-4]|m[1-4] pro/.test(r)) return 'high';
  if (/intel|uhd|iris|hd graphics|adreno|mali|powervr|apple gpu|radeon\(tm\) graphics|vega/.test(r)) return maxTextureSize >= 16384 && /iris xe|radeon\(tm\) graphics|vega|apple gpu/.test(r) ? 'medium' : 'low';
  return maxTextureSize >= 16384 ? 'high' : 'medium';
}

/** Turn a shader info log into a message that shows the offending source lines. */
function describeShaderError(log, source) {
  const lines = source.split('\n'), shown = new Set(), out = [log.trim()];
  for (const m of log.matchAll(/(?:ERROR|WARNING): \d+:(\d+)/g)) {
    const n = Number(m[1]);
    if (shown.has(n) || shown.size >= 4) continue;
    shown.add(n);
    for (let i = Math.max(1, n - 2); i <= Math.min(lines.length, n + 1); i++) out.push(`${i === n ? '>' : ' '} ${String(i).padStart(4)}: ${lines[i - 1]}`);
  }
  return out.join('\n');
}

const SAMPLER_TARGETS = {
  0x8b5e: 0x0de1, 0x8b62: 0x0de1, 0x8dca: 0x0de1, 0x8dd2: 0x0de1,     // sampler2D, sampler2DShadow, isampler2D, usampler2D -> TEXTURE_2D
  0x8b60: 0x8513, 0x8dc5: 0x8513,                                     // samplerCube, samplerCubeShadow -> TEXTURE_CUBE_MAP
  0x8dc1: 0x8c1a, 0x8dc4: 0x8c1a,                                     // sampler2DArray, sampler2DArrayShadow -> TEXTURE_2D_ARRAY
  0x8b5f: 0x806f,                                                     // sampler3D -> TEXTURE_3D
};

/**
 * How many programs may be compiling at once. The driver compiles in a pool of worker threads, and the
 * browser's own compositor links its programs through the same pool and waits for them on the thread that
 * presents the page: behind a hundred queued programs that wait is minutes on Direct3D, and the browser
 * takes the graphics process for hung and kills it. So programs wait their turn here, not in the driver.
 */
export const MAX_PROGRAMS_COMPILING = 3;

/**
 * When a program's turn to compile comes. FIRST: the picture is not right without it. AFTER: it can wait
 * until no FIRST program is waiting. SPARE: the picture is right without it (it only draws faster); it
 * waits for both, only one SPARE compiles at a time, so that the others never find every place taken by
 * programs that take long, and nobody waits for it: programsLinking does not count it, and if it cannot
 * be built it is reported and simply never becomes ready.
 *
 * A SPARE program takes the driver minutes where the others take seconds, and while it compiles the others
 * compile slower. "No other is waiting" is true for moments all through loading, when programs are still
 * being asked for one after another, so that is not enough to start one: the game must have been played
 * for SPARE_QUIET_SECONDS on end with every program the picture needs ready and none newly made
 * (ctx.quietSeconds, kept by programsLinking and by whoever knows of programs not ready to draw with).
 */
export const COMPILE_FIRST = 0, COMPILE_AFTER = 1, COMPILE_SPARE = 2;
export const SPARE_QUIET_SECONDS = 10;

/**
 * A linked shader program. It is compiled when its turn comes (programsLinking), in the background where
 * the driver supports it; `ready` turns true once the program can be used.
 */
export class Program {
  /**
   * ctx: from createContext. fallback: optional () => [vertexSource, fragmentSource] used when the given
   * sources fail to compile (a broken surface family must not stop the game); the error is still reported.
   * order: COMPILE_FIRST, COMPILE_AFTER or COMPILE_SPARE.
   */
  constructor(ctx, name, vertexSource, fragmentSource, fallback = null, order = COMPILE_FIRST) {
    this.ctx = ctx; this.name = name; this.vertexSource = vertexSource; this.fragmentSource = fragmentSource; this.fallback = fallback; this.order = order;
    this.handle = null; this.failed = null; this._state = 'waiting'; this._locs = new Map(); this._samplers = []; this._samplerByName = new Map();
    ctx.programs.push(this); ctx.waiting.push(this);
    if (order !== COMPILE_SPARE) ctx.quietSeconds = 0;
  }

  _start() {
    const gl = this.ctx.gl;
    this.ctx.lastProgram = this.name + ' (compile)';       // named in the log if the context is lost (index.js)
    const shader = (type, source) => { const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s); return s; };
    this._vs = shader(gl.VERTEX_SHADER, this.vertexSource); this._fs = shader(gl.FRAGMENT_SHADER, this.fragmentSource);
    this.handle = gl.createProgram();
    gl.attachShader(this.handle, this._vs); gl.attachShader(this.handle, this._fs);
    gl.linkProgram(this.handle);
    this._state = 'pending'; this._locs.clear(); this._samplers.length = 0; this._samplerByName.clear();
    this.ctx.compiling.push(this);
  }

  /** True once linked. Never blocks when KHR_parallel_shader_compile is available. */
  get ready() { return this._state === 'ready' || this.poll(); }

  /** Ask the driver about a program that is compiling, and finish it when it is done. Returns `ready`. */
  poll() {
    if (this._state !== 'pending') return this._state === 'ready';
    const gl = this.ctx.gl;
    if (this.ctx.ext.parallel && !gl.getProgramParameter(this.handle, COMPLETION_STATUS_KHR)) return false;
    this._finish();
    return this._state === 'ready';
  }

  /** Block until linked (used when a program is needed immediately): it does not wait its turn. */
  wait() {
    if (this._state === 'waiting') { this.ctx.waiting.splice(this.ctx.waiting.indexOf(this), 1); this._start(); }
    if (this._state === 'pending') this._finish();
    return this._state === 'ready';
  }

  _finish() {
    const gl = this.ctx.gl, compiling = this.ctx.compiling;
    compiling.splice(compiling.indexOf(this), 1);
    if (!gl.getProgramParameter(this.handle, gl.LINK_STATUS) && !gl.isContextLost()) {
      const parts = [];
      if (!gl.getShaderParameter(this._vs, gl.COMPILE_STATUS)) parts.push('vertex shader:\n' + describeShaderError(gl.getShaderInfoLog(this._vs) || '', this.vertexSource));
      if (!gl.getShaderParameter(this._fs, gl.COMPILE_STATUS)) parts.push('fragment shader:\n' + describeShaderError(gl.getShaderInfoLog(this._fs) || '', this.fragmentSource));
      if (!parts.length) parts.push('link: ' + (gl.getProgramInfoLog(this.handle) || 'unknown error'));
      const error = new Error(`Shader program "${this.name}" failed to build.\n${parts.join('\n')}`);
      gl.deleteShader(this._vs); gl.deleteShader(this._fs); gl.deleteProgram(this.handle);
      if (this.fallback) {
        // Report, then rebuild from the fallback sources so the frame still renders.
        console.error(error.message);
        this.failed = error;
        const [vs, fs] = this.fallback(); this.fallback = null; this.vertexSource = vs; this.fragmentSource = fs;
        this._start();
        return;
      }
      this._state = 'failed'; this.failed = error;
      if (this.order === COMPILE_SPARE) { this.handle = null; console.warn(error.message); return; }
      throw error;
    }
    gl.deleteShader(this._vs); gl.deleteShader(this._fs); this._vs = this._fs = null;
    for (const [block, binding] of Object.entries(BLOCK_BINDINGS)) {
      const index = gl.getUniformBlockIndex(this.handle, block);
      if (index !== gl.INVALID_INDEX) gl.uniformBlockBinding(this.handle, index, binding);
    }
    // Give every sampler a fixed texture unit now; use() only has to bind textures.
    gl.useProgram(this.handle);
    const count = gl.getProgramParameter(this.handle, gl.ACTIVE_UNIFORMS) | 0;
    for (let i = 0; i < count; i++) {
      const u = gl.getActiveUniform(this.handle, i);
      const target = u && SAMPLER_TARGETS[u.type];
      if (!target) continue;
      const sampler = { name: u.name, unit: this._samplers.length, target };
      gl.uniform1i(gl.getUniformLocation(this.handle, u.name), sampler.unit);
      this._samplers.push(sampler); this._samplerByName.set(u.name, sampler);
    }
    this._state = 'ready';
  }

  /** Make current and bind every shared texture this program samples. Returns false if it is not usable yet. */
  use() {
    if (!this.ready) return false;
    const gl = this.ctx.gl, shared = this.ctx.shared, samplers = this._samplers;
    gl.useProgram(this.handle);
    for (let i = 0; i < samplers.length; i++) {
      const s = samplers[i], t = shared.get(s.name);
      if (t) { gl.activeTexture(gl.TEXTURE0 + s.unit); gl.bindTexture(t.target, t.texture); }
    }
    return true;
  }

  /** Bind a texture to one of this program's samplers by name (for inputs that change per draw). Call after use(). */
  texture(name, texture, target = 0x0de1) {
    const s = this._samplerByName.get(name);
    if (!s) return;
    const gl = this.ctx.gl;
    gl.activeTexture(gl.TEXTURE0 + s.unit); gl.bindTexture(target, texture);
  }

  /** Cached uniform location (null when the uniform is unused; gl.uniform* then does nothing). */
  loc(name) {
    let l = this._locs.get(name);
    if (l === undefined) { l = this.ctx.gl.getUniformLocation(this.handle, name); this._locs.set(name, l); }
    return l;
  }

  dispose() {
    for (const list of [this.ctx.programs, this.ctx.waiting, this.ctx.compiling]) { const i = list.indexOf(this); if (i >= 0) list.splice(i, 1); }
    if (this.handle) this.ctx.gl.deleteProgram(this.handle);
    this.handle = null; this._state = 'disposed';
  }
}

/**
 * Moves the line of programs along and returns how many the picture needs that are not linked yet (SPARE
 * ones are not counted): looks at those that are compiling, then starts waiting ones while there is room,
 * in their order (COMPILE_FIRST and so on) and, within one order, as they were made. Call it every frame;
 * nothing is compiled otherwise. Does not block where the driver compiles in the background.
 * played: seconds of play since the last call, 0 while loading: what the quiet before a SPARE program is counted in.
 */
export function programsLinking(ctx, played = 0) {
  const compiling = ctx.compiling, waiting = ctx.waiting;
  let needed = 0, spareCompiling = false;
  for (let i = compiling.length - 1; i >= 0; i--) compiling[i].poll();        // a finished program leaves the list
  for (let i = 0; i < compiling.length; i++) { if (compiling[i].order === COMPILE_SPARE) spareCompiling = true; else needed++; }
  while (compiling.length < MAX_PROGRAMS_COMPILING) {
    let next = -1;
    for (let i = 0; i < waiting.length; i++) {
      const order = waiting[i].order;
      if (order === COMPILE_SPARE && (spareCompiling || ctx.quietSeconds < SPARE_QUIET_SECONDS)) continue;
      if (next < 0 || order < waiting[next].order) next = i;
    }
    if (next < 0) break;
    const program = waiting.splice(next, 1)[0];
    if (program.order === COMPILE_SPARE) spareCompiling = true; else needed++;
    program._start();
  }
  for (let i = 0; i < waiting.length; i++) if (waiting[i].order !== COMPILE_SPARE) needed++;
  ctx.quietSeconds = needed > 0 ? 0 : ctx.quietSeconds + played;
  return needed;
}

/** The context is back after a loss: every program is compiled again, in the order they were made. */
export function recompilePrograms(ctx) {
  ctx.compiling.length = 0; ctx.waiting.length = 0; ctx.quietSeconds = 0;
  for (const program of ctx.programs) { program.handle = null; program._state = 'waiting'; ctx.waiting.push(program); }
}

const FILTERS = (gl) => ({ nearest: [gl.NEAREST, gl.NEAREST], linear: [gl.LINEAR, gl.LINEAR], mipmap: [gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR], mipnearest: [gl.LINEAR_MIPMAP_NEAREST, gl.LINEAR] });

/**
 * Immutable 2D texture (or 2D array when `layers` is given).
 * opts: { internal, width, height, layers?, levels = 1, filter = 'nearest', wrap = 'clamp', compare = false, anisotropy = 1 }
 */
export function createTexture(gl, opts) {
  const target = opts.layers ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, texture = gl.createTexture();
  const levels = opts.levels === 'full' ? Math.floor(Math.log2(Math.max(opts.width, opts.height))) + 1 : (opts.levels || 1);
  gl.bindTexture(target, texture);
  if (opts.layers) gl.texStorage3D(target, levels, opts.internal, opts.width, opts.height, opts.layers);
  else gl.texStorage2D(target, levels, opts.internal, opts.width, opts.height);
  const [min, mag] = FILTERS(gl)[opts.filter || 'nearest'];
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, min); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, mag);
  const wrap = opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrap);
  if (opts.compare) { gl.texParameteri(target, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(target, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL); }
  if (opts.anisotropy > 1 && opts.anisoExt) gl.texParameterf(target, opts.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, opts.anisotropy);
  return texture;
}

/**
 * Framebuffer over the given colour textures (entries may be a texture, { texture, level, layer } for an
 * array layer or { texture, level, face } for a cube face 0..5) and an
 * optional depth texture (same forms). Throws a readable Error when the combination is not renderable.
 */
export function createFramebuffer(gl, label, colors, depth = null) {
  const fbo = gl.createFramebuffer(), buffers = [];
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  const attach = (point, entry) => {
    const t = entry.texture ? entry : { texture: entry, level: 0 };
    if (t.layer !== undefined) gl.framebufferTextureLayer(gl.FRAMEBUFFER, point, t.texture, t.level || 0, t.layer);
    else gl.framebufferTexture2D(gl.FRAMEBUFFER, point, t.face === undefined ? gl.TEXTURE_2D : gl.TEXTURE_CUBE_MAP_POSITIVE_X + t.face, t.texture, t.level || 0);
  };
  colors.forEach((c, i) => { attach(gl.COLOR_ATTACHMENT0 + i, c); buffers.push(gl.COLOR_ATTACHMENT0 + i); });
  if (depth) attach(gl.DEPTH_ATTACHMENT, depth);
  if (buffers.length) gl.drawBuffers(buffers); else { gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE); }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) throw new Error(`Render target "${label}" is not supported by this graphics device (framebuffer status 0x${status.toString(16)}).`);
  return fbo;
}
