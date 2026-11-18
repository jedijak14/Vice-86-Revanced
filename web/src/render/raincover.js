// Rain cover: where rain cannot fall. A height map of the roofs, decks, awnings and porches around the
// camera, drawn straight down with the depth-only shadow programs. Rain streaks, splashes and wet surfaces
// ask it through rainCover() (shaders/common.js) whether a point has open sky above it, so that it does not
// rain under a bridge or a porch and the road there can stay dry.
//
// The map is a square of COVER_HALF metres to every side of the camera, centred on a COVER_SNAP grid so the
// shader can find the centre from the camera position alone (no uniform of its own, which lets any module
// that includes the chunk use it). Depth runs from COVER_TOP (0) down to COVER_BOTTOM (1) in world height.
// Only buildings and fixed props are drawn: vehicles move, and a palm crown lets the rain through.

import { createTexture, createFramebuffer } from './gl.js';
import { FAMILY } from '../core/ids.js';
import { COVER_HALF, COVER_SIZE, COVER_SNAP, COVER_TOP, COVER_BOTTOM } from './shaders/common.js';

/** Redrawn when the centre moves, and this often regardless (frames): tiles stream in around a standing camera. */
const REFRESH = 30;

/** Centre of the map for a camera coordinate, computed in single precision exactly as the shader does. */
export function coverCentre(v) { return Math.floor(Math.fround(Math.fround(v) / COVER_SNAP + 0.5)) * COVER_SNAP; }

/** Camera-relative world -> clip of the map: x east, y south, depth downwards (column-major). */
export function coverMatrix(out, cam, centreX, centreZ) {
  out.fill(0);
  out[0] = 1 / COVER_HALF; out[12] = -(centreX - cam[0]) / COVER_HALF;
  out[9] = 1 / COVER_HALF; out[13] = -(centreZ - cam[2]) / COVER_HALF;
  out[6] = -2 / (COVER_TOP - COVER_BOTTOM); out[14] = 2 * (COVER_TOP - cam[1]) / (COVER_TOP - COVER_BOTTOM) - 1;
  out[15] = 1;
  return out;
}

export class RainCover {
  constructor(ctx) {
    this.ctx = ctx; this.map = null; this.fbo = null;
    this._matrix = new Float32Array(16); this._centre = [NaN, NaN]; this._age = 0; this._empty = true;
    this.draws = 0;                       // maps drawn this frame (0 or 1)
    this._create();
  }

  _create() {
    const gl = this.ctx.gl;
    this.map = createTexture(gl, { internal: gl.DEPTH_COMPONENT24, width: COVER_SIZE, height: COVER_SIZE });
    this.fbo = createFramebuffer(gl, 'rain cover', [], this.map);
    this.ctx.shared.set('uRainCover', { target: gl.TEXTURE_2D, texture: this.map });
    this._centre[0] = NaN; this._empty = false; this._clear();
  }

  /** Open sky everywhere: the state while it is dry. */
  _clear() {
    if (this._empty) return;
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.depthMask(true); gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    this._empty = true; this._centre[0] = NaN;
  }

  /**
   * Bring the map up to date. scene: the Scene, culled for the main view this frame; cam: world camera
   * position; needed: whether anything is wet or falling (otherwise the map is left empty and costs nothing).
   */
  update(scene, cam, needed) {
    this.draws = 0;
    if (!needed) { this._clear(); return; }
    const x = coverCentre(cam[0]), z = coverCentre(cam[2]);
    if (x === this._centre[0] && z === this._centre[1] && ++this._age < REFRESH) return;
    this._centre[0] = x; this._centre[1] = z; this._age = 0; this._empty = false;
    const gl = this.ctx.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.viewport(0, 0, COVER_SIZE, COVER_SIZE);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    scene.cullCover(x - COVER_HALF, z - COVER_HALF, x + COVER_HALF, z + COVER_HALF);
    scene.drawShadow(coverMatrix(this._matrix, cam, x, z), FAMILY.FOLIAGE);
    gl.enable(gl.CULL_FACE);
    this.draws = 1;
  }

  /** After a lost context. */
  restore() { this.map = null; this.fbo = null; this._create(); }

  dispose() {
    const gl = this.ctx.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.map) gl.deleteTexture(this.map);
    this.map = this.fbo = null;
  }
}
