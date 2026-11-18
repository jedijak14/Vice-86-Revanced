// Render targets. Two groups with different lifetimes:
//   scene group   at RENDER resolution (canvas x resolution scale x dynamic resolution); rebuilt whenever
//                 dynamic resolution moves a step.
//   post group    at POST resolution (canvas x resolution scale); survives dynamic resolution, because it
//                 holds the temporal history, which is also what upscales the scene group.
// The formats and the reason for each target are listed at the top of index.js.

import { createTexture, createFramebuffer } from './gl.js';
import { BLUR_TILE } from './shaders/post.js';
import { hasMirror } from './quality.js';

/** Bloom levels kept even when bloom is off: the exposure meter reads the coarsest one. */
const METER_LEVELS = 4;
/** Most levels of the mirror image: the widest fan of the roughest film reads texels 128 times those of the image. */
const MIRROR_LEVELS = 8;

export class Targets {
  constructor(ctx) {
    this.ctx = ctx;
    this.width = 0; this.height = 0;             // render resolution
    this.postWidth = 0; this.postHeight = 0;
    this.scene = null; this.post = null;
    this.historyIndex = 0;                       // which of the two history targets holds the newest image
    this.exposureIndex = 0;
  }

  /** (Re)build the scene group. quality: resolved quality (quality.js). */
  allocateScene(width, height, quality) {
    this.disposeScene();
    const gl = this.ctx.gl, tex = (internal, w, h, filter = 'nearest') => createTexture(gl, { internal, width: Math.max(1, w), height: Math.max(1, h), filter });
    const s = { textures: [], framebuffers: [] };
    const make = (name, internal, w = width, h = height, filter = 'nearest') => { const t = tex(internal, w, h, filter); s.textures.push(t); s[name] = t; return t; };
    const fbo = (name, colors, depth = null) => { const f = createFramebuffer(gl, name, colors, depth); s.framebuffers.push(f); s[name + 'Fbo'] = f; return f; };
    s.gbuffer = [make('g0', gl.RGBA8), make('g1', gl.RGBA16F), make('g2', gl.RGBA8), make('g3', gl.RGBA16F)];
    make('depth', gl.DEPTH_COMPONENT24);
    make('lit', gl.RGBA16F, width, height, 'linear');
    make('sceneDepth', gl.R32F);
    make('sceneOpaque', gl.RGBA16F, width, height, 'linear');
    fbo('gbuffer', s.gbuffer, s.depth);
    fbo('lit', [s.lit], s.depth);
    fbo('water', [s.lit, s.g1, s.g2, s.g3], s.depth);
    fbo('sceneDepth', [s.sceneDepth]);
    fbo('sceneOpaque', [s.sceneOpaque]);
    fbo('litColour', [s.lit]);                                  // read side of the copy into sceneOpaque
    s.aoWidth = Math.max(1, width >> 1); s.aoHeight = Math.max(1, height >> 1);
    if (quality.ao.taps > 0) {
      make('aoA', gl.RG8, s.aoWidth, s.aoHeight, 'linear'); make('aoB', gl.RG8, s.aoWidth, s.aoHeight, 'linear');   // r = ambient occlusion, g = sun contact shadow
      fbo('aoA', [s.aoA]); fbo('aoB', [s.aoB]);
    }
    if (quality.reflections.steps > 0) {
      s.ssrWidth = Math.max(1, Math.round(width * quality.reflections.scale)); s.ssrHeight = Math.max(1, Math.round(height * quality.reflections.scale));
      make('ssrColor', gl.RGBA16F, s.ssrWidth, s.ssrHeight, 'linear'); make('ssrAux', gl.R16F, s.ssrWidth, s.ssrHeight, 'linear');
      fbo('ssr', [s.ssrColor, s.ssrAux]);
    }
    if (hasMirror(quality.reflections)) {
      // The wet-road mirror (and a closed room's floor): the scene reflected in that plane, with a mip chain for
      // the roughness blur. Each level is filtered from the one above into a scratch texture and copied back
      // (index.js), since a texture cannot be read and drawn to at once: scratch level k is as large as mirror level k + 1.
      s.planarWidth = Math.max(2, width >> 1); s.planarHeight = Math.max(2, height >> 1);
      s.planarLevels = Math.min(MIRROR_LEVELS, Math.floor(Math.log2(Math.max(s.planarWidth, s.planarHeight))) + 1);
      s.planar = createTexture(gl, { internal: gl.RGBA16F, width: s.planarWidth, height: s.planarHeight, filter: 'mipmap', levels: s.planarLevels }); s.textures.push(s.planar);
      make('planarDepth', gl.DEPTH_COMPONENT24, s.planarWidth, s.planarHeight);
      fbo('planar', [s.planar], s.planarDepth);
      s.planarScratch = createTexture(gl, { internal: gl.RGBA16F, width: Math.max(1, s.planarWidth >> 1), height: Math.max(1, s.planarHeight >> 1), levels: s.planarLevels - 1 }); s.textures.push(s.planarScratch);
      s.planarLevelFbos = [s.planarFbo]; s.planarScratchFbos = [];
      for (let level = 1; level < s.planarLevels; level++) {
        s.planarLevelFbos.push(fbo(`planarLevel${level}`, [{ texture: s.planar, level }]));
        s.planarScratchFbos.push(fbo(`planarScratch${level}`, [{ texture: s.planarScratch, level: level - 1 }]));
      }
    }
    if (quality.motionBlur.taps > 0) {
      s.tileWidth = Math.ceil(width / BLUR_TILE); s.tileHeight = Math.ceil(height / BLUR_TILE);
      make('tileA', gl.RG16F, s.tileWidth, s.tileHeight); make('tileB', gl.RG16F, s.tileWidth, s.tileHeight);
      fbo('tileA', [s.tileA]); fbo('tileB', [s.tileB]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scene = s; this.width = width; this.height = height;
  }

  /** (Re)build the post group. needLdr: an 8-bit intermediate is needed (FXAA, or the canvas is larger than the post size). */
  allocatePost(width, height, quality, needLdr) {
    this.disposePost();
    const gl = this.ctx.gl;
    const p = { textures: [], framebuffers: [], bloomDown: [], bloomUp: [], bloomSizes: [] };
    const make = (internal, w, h, filter = 'linear') => { const t = createTexture(gl, { internal, width: Math.max(1, w), height: Math.max(1, h), filter }); p.textures.push(t); return t; };
    const fbo = (name, colors) => { const f = createFramebuffer(gl, name, colors); p.framebuffers.push(f); return f; };
    p.history = [make(gl.RGBA16F, width, height), make(gl.RGBA16F, width, height)];
    p.historyFbo = [fbo('history 0', [p.history[0]]), fbo('history 1', [p.history[1]])];
    p.scratch = make(gl.RGBA16F, width, height); p.scratchFbo = fbo('scratch', [p.scratch]);
    const levels = Math.max(METER_LEVELS, quality.bloom.mips);
    let w = width, h = height;
    for (let i = 0; i < levels; i++) {
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      p.bloomSizes.push([w, h]);
      const down = make(gl.RGBA16F, w, h); p.bloomDown.push({ texture: down, fbo: fbo('bloom down ' + i, [down]) });
      if (i < levels - 1) { const up = make(gl.RGBA16F, w, h); p.bloomUp.push({ texture: up, fbo: fbo('bloom up ' + i, [up]) }); }
    }
    p.exposure = [make(gl.R16F, 1, 1, 'nearest'), make(gl.R16F, 1, 1, 'nearest')];
    p.exposureFbo = [fbo('exposure 0', [p.exposure[0]]), fbo('exposure 1', [p.exposure[1]])];
    if (needLdr) { p.ldr = make(gl.RGBA8, width, height); p.ldrFbo = fbo('display', [p.ldr]); }
    // Start the metered exposure at neutral and the history at black.
    for (const f of p.exposureFbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    for (const f of p.historyFbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.post = p; this.postWidth = width; this.postHeight = height; this.historyIndex = 0; this.exposureIndex = 0;
  }

  _dispose(group) {
    if (!group) return;
    const gl = this.ctx.gl;
    for (const f of group.framebuffers) gl.deleteFramebuffer(f);
    for (const t of group.textures) gl.deleteTexture(t);
  }
  disposeScene() { this._dispose(this.scene); this.scene = null; }
  disposePost() { this._dispose(this.post); this.post = null; }
  dispose() { this.disposeScene(); this.disposePost(); }
  /** After a context loss the old objects are gone already: forget them without deleting. */
  forget() { this.scene = null; this.post = null; }
}
