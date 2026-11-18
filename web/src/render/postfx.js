// The post chain: everything between the lit HDR frame and the canvas.
//
//   lit (render size) --temporal AA / copy--> history (post size) --exhaust flames--> scratch
//     --motion blur or depth of field--> spare --bloom pyramid + exposure meter--> tone map and grade
//     --> [FXAA / upscale] --> canvas
//
// The history target is never written after the resolve: it is next frame's temporal history and the
// "last frame" image that reflections and water sample, so flames and blur must not feed back into it.
// `spare` is whichever of scratch and the OLDER history target does not hold the image so far (the older one
// is dead once the resolve has read it).
//
// The shaders are in shaders/post.js and shaders/flame.js; this file only routes targets and sets uniforms.

import { BLOOM_AMOUNT, BLOOM_SPREAD, BLUR_TILE, CAMERA_SATURATION, DOF_TAPS_MOST, EXPOSURE_BAND } from './shaders/post.js';

/** Weight of the new frame in the temporal resolve when nothing moves (about 10 frames of accumulation). */
const TAA_BLEND = 0.1;
/**
 * Longest blur streak as a fraction of the frame height (43 pixels at 1080 lines), whatever the speed. Half
 * of it must stay within reach of the tile neighbourhood (BLUR_TILE pixels) up to 2160 lines.
 */
export const BLUR_MAX_LENGTH = 0.04;
/**
 * Camera speeds (m/s) between which motion blur eases in. Below the first (about 15 km/h: parking, creeping
 * in traffic, standing at a light) there is none, however fast the view is turned or traffic passes.
 */
export const BLUR_SPEED_NONE = 4, BLUR_SPEED_FULL = 16;
/**
 * Share of the sky module's grade for the hour that reaches the image. The tone curve already carries the
 * contrast of a camera, and the lighting already turns shade towards the sky's blue and sunlit faces towards
 * the sun's colour, so the grade only leans on both instead of stating them a second time.
 */
const GRADE_SHARE = 0.5;
const lean = (term) => 1 + GRADE_SHARE * ((term ?? 1) - 1);
/** Lens terms at full strength: vignette, grain, chromatic aberration, sharpening after TAA, and the boost effect. */
const VIGNETTE = 0.3, GRAIN = 0.035, FRINGE = 0.005, SHARPEN = 0.15, SPEED_STRETCH = 0.09, SPEED_FRINGE = 0.008;
/** Width of the film frame that focal lengths and f-numbers refer to, metres (a 36 mm frame). */
export const FILM_WIDTH = 0.036;
/** Largest radius of a depth of field disc, as a fraction of the frame height: the background goes soft, not to fog. */
export const DOF_MAX_RADIUS = 0.008;

/**
 * Radius, in pixels, of the disc a thin lens spreads a point over, per unit of |1 - focus / depth|.
 * The disc's diameter on the film is  f^2 / (N (s - f)) |1 - s / z|  for focal length f, f-number N and focus
 * distance s; the picture is `width` pixels across a film FILM_WIDTH wide.
 * @param {number} focal     focal length, metres
 * @param {number} aperture  f-number
 * @param {number} distance  focus distance, metres
 * @param {number} width     picture width, pixels
 */
export function lensDiscRadius(focal, aperture, distance, width) {
  return 0.5 * focal * focal / (aperture * Math.max(distance - focal, focal)) * (width / FILM_WIDTH);
}

/** Under nitrous the shutter stays open this much longer and the cap on the streak grows with it: a modest stretch. */
export const BOOST_SHUTTER = 0.25;

export class PostChain {
  /** programs: map of fixed programs by key (programs.js). drawFullscreen: draws the fullscreen triangle. */
  constructor(ctx, programs, targets, flames, drawFullscreen) {
    this.ctx = ctx; this.programs = programs; this.targets = targets; this.flames = flames; this.draw = drawFullscreen;
    this.bloomAmount = 0;
    this.lastCam = new Float64Array(3);            // where the camera was last frame, for its speed
  }

  /**
   * Run the chain. p (a reused parameter object):
   *   quality, dt, time, frameIndex, exposure (env exposure with biases), night 0..1, grade (env.grade or null),
   *   fade 0..1, speedEffect 0..1, historyValid, temporal (TAA on), exhaust (frame.exhaust or null), cam (world),
   *   pixelsPerMetre (at depth 1, post resolution), debugMode, aoPresent, canvasWidth, canvasHeight,
   *   interior (the frame is a room lit only by its own lamps: the garage),
   *   focus ({ distance in metres, aperture as an f-number } or null; aperture 0 = everything sharp)
   *
   * In a room the camera is a studio camera: exposure is set by hand and locked (the meter would open up
   * on the dark walls until the tubes burnt out, and breathe as the view turned), and nothing is blurred by
   * motion (the camera creeps on a dolly). The street's metered correction is kept untouched for the way out.
   */
  run(p) {
    const gl = this.ctx.gl, P = this.programs, t = this.targets, post = t.post, scene = t.scene, q = p.quality;
    const width = t.postWidth, height = t.postHeight;
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);

    // ---- temporal resolve (also the upscale from render to post resolution)
    const previous = t.historyIndex, current = 1 - previous;
    gl.bindFramebuffer(gl.FRAMEBUFFER, post.historyFbo[current]); gl.viewport(0, 0, width, height);
    const resolve = p.temporal ? P.taa : P.copy;
    if (resolve.use()) {
      resolve.texture('uCurrent', scene.lit);
      if (p.temporal) {
        resolve.texture('uHistory', post.history[previous]);
        gl.uniform4f(resolve.loc('uTaa'), p.historyValid ? 1 : 0, TAA_BLEND, 0, 0);
        gl.uniform4f(resolve.loc('uTaaSize'), width, height, 1 / width, 1 / height);
      }
      this.draw();
    }
    t.historyIndex = current;
    let colour = post.history[current];

    // ---- exhaust flames, on a copy of the resolved image
    if (p.exhaust && p.exhaust.length && P.flame.ready && hasActiveFlame(p.exhaust)) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, post.historyFbo[current]); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, post.scratchFbo);
      gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.scratchFbo);
      // The flame shader refracts what is behind it: it reads the resolved image and writes the copy.
      P.flame.use(); P.flame.texture('uFlameSource', colour);
      gl.uniform4f(P.flame.loc('uFlameScreen'), 1 / width, 1 / height, p.pixelsPerMetre, 1);
      // Only the inside faces of each hull are drawn (see Flames), so a camera inside the haze still sees it.
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
      // A flame that reads at night would vanish against a noon exposure: lift it by day, but less than
      // exposure falls, because flames really are fainter in sunlight.
      this.flames.draw(P.flame, p.exhaust, p.cam, Math.min(6, Math.max(1, Math.sqrt(1 / Math.max(p.exposure, 1e-3)))));
      gl.disable(gl.CULL_FACE);
      colour = post.scratch;
    }

    // ---- motion blur
    const interior = !!p.interior;
    const blur = q.motionBlur, boost = blur.taps > 0 ? Math.min(1, Math.max(0, p.speedEffect || 0)) : 0;
    const last = this.lastCam, travelled = Math.hypot(p.cam[0] - last[0], p.cam[1] - last[1], p.cam[2] - last[2]);
    last[0] = p.cam[0]; last[1] = p.cam[1]; last[2] = p.cam[2];
    const eased = p.historyValid && !interior && p.dt > 0 ? Math.min(1, Math.max(0, (travelled / p.dt - BLUR_SPEED_NONE) / (BLUR_SPEED_FULL - BLUR_SPEED_NONE))) : 0;
    const withSpeed = eased * eased * (3 - 2 * eased);
    const blurReady = P.motionBlur.ready && P.blurTile.ready && P.blurNeighbour.ready && P.blurApply.ready;
    if (blur.taps > 0 && withSpeed > 0 && scene.tileA && post.bloomUp.length > 2 && blurReady) {
      // G-buffer velocities are per frame; rescale to the share of a 60 Hz frame the shutter is open, so the
      // streak length does not depend on the frame rate.
      const stretch = 1 + BOOST_SHUTTER * boost;
      const scale = blur.shutter * withSpeed * stretch * Math.min(2, Math.max(0.25, (1 / 60) / p.dt));
      const maxLength = BLUR_MAX_LENGTH * stretch, phase = p.temporal ? p.frameIndex % 64 : 0;
      // Two bloom upsample targets are borrowed, the eighth-resolution one for the first stage of the tile
      // maximum and the half-resolution one for the gather: neither is written until the bloom pyramid is
      // rebuilt further down, which reads the image this block produces.
      const cells = post.bloomUp[2], cellSize = post.bloomSizes[2], half = post.bloomUp[0];
      gl.bindFramebuffer(gl.FRAMEBUFFER, cells.fbo); gl.viewport(0, 0, cellSize[0], cellSize[1]);
      P.blurTile.use(); gl.uniform4f(P.blurTile.loc('uBlur'), blur.taps, scale, maxLength, phase);
      gl.uniform2f(P.blurTile.loc('uCells'), cellSize[0], cellSize[1]); this.draw();
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.tileAFbo); gl.viewport(0, 0, scene.tileWidth, scene.tileHeight);
      P.blurNeighbour.use(); P.blurNeighbour.texture('uTiles', cells.texture);
      gl.uniform3f(P.blurNeighbour.loc('uReach'), BLUR_TILE / t.width, BLUR_TILE / t.height, 0); this.draw();
      gl.bindFramebuffer(gl.FRAMEBUFFER, scene.tileBFbo);
      P.blurNeighbour.texture('uTiles', scene.tileA);
      gl.uniform3f(P.blurNeighbour.loc('uReach'), 1 / scene.tileWidth, 1 / scene.tileHeight, 1); this.draw();
      gl.bindFramebuffer(gl.FRAMEBUFFER, half.fbo); gl.viewport(0, 0, post.bloomSizes[0][0], post.bloomSizes[0][1]);
      P.motionBlur.use(); P.motionBlur.texture('uColor', colour); P.motionBlur.texture('uTiles', scene.tileB);
      gl.uniform4f(P.motionBlur.loc('uBlur'), blur.taps, scale, maxLength, phase); this.draw();
      const toHistory = colour === post.scratch;
      gl.bindFramebuffer(gl.FRAMEBUFFER, toHistory ? post.historyFbo[previous] : post.scratchFbo); gl.viewport(0, 0, width, height);
      P.blurApply.use(); P.blurApply.texture('uColor', colour); P.blurApply.texture('uBlurred', half.texture); this.draw();
      colour = toHistory ? post.history[previous] : post.scratch;
    }

    // ---- depth of field, when the game focuses the lens (the garage)
    const focus = p.focus, lensTaps = q.depthOfField ? Math.min(q.depthOfField.taps, DOF_TAPS_MOST) : 0;
    if (focus && focus.aperture > 0 && focus.distance > 0 && lensTaps > 0 && P.depthOfField.ready) {
      // The focal length follows from the projection: half the film's width over the tangent of half the
      // horizontal angle of view, which is half the picture's width over pixelsPerMetre.
      const focal = FILM_WIDTH * p.pixelsPerMetre / width;
      const toHistory = colour === post.scratch;
      gl.bindFramebuffer(gl.FRAMEBUFFER, toHistory ? post.historyFbo[previous] : post.scratchFbo); gl.viewport(0, 0, width, height);
      P.depthOfField.use(); P.depthOfField.texture('uColor', colour);
      gl.uniform4f(P.depthOfField.loc('uLens'), focus.distance, lensDiscRadius(focal, focus.aperture, focus.distance, width), DOF_MAX_RADIUS * height, lensTaps);
      this.draw();
      colour = toHistory ? post.history[previous] : post.scratch;
    }

    if (p.debugMode > 0 && p.debugMode !== 5 && p.debugMode !== 6) { this._debug(p); return; }

    // ---- bloom pyramid; its coarsest level also carries the exposure meter
    const levels = post.bloomDown.length, exposureNow = t.exposureIndex, exposureNext = 1 - exposureNow;
    const bloomOn = q.bloom.mips > 0 && q.bloomStrength > 0;
    const B = EXPOSURE_BAND, night = Math.min(1, Math.max(0, p.night));
    // The correction the picture is exposed with: the metered one outside; in a room a correction of exactly
    // one, written into the free texel of the pair without making it the current one, so that the street's
    // value waits where it was.
    let correction = post.exposure[exposureNow];
    if (interior && P.exposure.use()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.exposureFbo[exposureNext]); gl.viewport(0, 0, 1, 1);
      P.exposure.texture('uMeter', post.bloomDown[levels - 1].texture); P.exposure.texture('uPrevious', post.exposure[exposureNow]);
      gl.uniform4f(P.exposure.loc('uAdapt'), B.keyNight, 1, 1, -1);
      this.draw();
      correction = post.exposure[exposureNext];
    }
    if (P.bloomPrefilter.use()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomDown[0].fbo); gl.viewport(0, 0, post.bloomSizes[0][0], post.bloomSizes[0][1]);
      P.bloomPrefilter.texture('uColor', colour); P.bloomPrefilter.texture('uExposureTex', correction);
      gl.uniform4f(P.bloomPrefilter.loc('uPrefilter'), p.exposure, 0, 0, 0); this.draw();
    }
    if (P.bloomDown.use()) {
      for (let i = 1; i < levels; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomDown[i].fbo); gl.viewport(0, 0, post.bloomSizes[i][0], post.bloomSizes[i][1]);
        P.bloomDown.texture('uColor', post.bloomDown[i - 1].texture); this.draw();
      }
    }
    if (!interior && P.exposure.use()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, post.exposureFbo[exposureNext]); gl.viewport(0, 0, 1, 1);
      P.exposure.texture('uMeter', post.bloomDown[levels - 1].texture); P.exposure.texture('uPrevious', post.exposure[exposureNow]);
      // Interpolated in stops, so dusk is half way between the day and night behaviour.
      const key = B.keyDay * Math.pow(B.keyNight / B.keyDay, night);
      const least = B.dayMin * Math.pow(B.min / B.dayMin, night), most = B.max * Math.pow(B.nightMax / B.max, night);
      gl.uniform4f(P.exposure.loc('uAdapt'), key, least, most, p.historyValid ? p.dt : -1);
      this.draw();
      t.exposureIndex = exposureNext;
      correction = post.exposure[exposureNext];
    }
    let bloom = post.bloomDown[0].texture;
    if (bloomOn && P.bloomUp.use()) {
      gl.uniform1f(P.bloomUp.loc('uSpread'), BLOOM_SPREAD);
      let coarse = post.bloomDown[levels - 1].texture;
      for (let i = levels - 2; i >= 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, post.bloomUp[i].fbo); gl.viewport(0, 0, post.bloomSizes[i][0], post.bloomSizes[i][1]);
        P.bloomUp.texture('uColor', post.bloomDown[i].texture); P.bloomUp.texture('uCoarse', coarse); this.draw();
        coarse = post.bloomUp[i].texture;
      }
      bloom = coarse;
    }
    this.bloomAmount = bloomOn ? BLOOM_AMOUNT * q.bloomStrength : 0;

    // ---- tone map and grade, then to the canvas (through an 8-bit target when FXAA or an upscale follows)
    const direct = !post.ldr;
    gl.bindFramebuffer(gl.FRAMEBUFFER, direct ? null : post.ldrFbo);
    if (direct) gl.viewport(0, 0, p.canvasWidth, p.canvasHeight); else gl.viewport(0, 0, width, height);
    if (P.tonemap.use()) {
      const g = p.grade || NEUTRAL_GRADE, tint = g.tint || NEUTRAL_GRADE.tint, shadows = g.shadowsTint || NEUTRAL_GRADE.shadowsTint;
      P.tonemap.texture('uColor', colour); P.tonemap.texture('uBloom', bloom); P.tonemap.texture('uExposureTex', correction);
      gl.uniform4f(P.tonemap.loc('uTone'), p.exposure, this.bloomAmount, Math.min(1, Math.max(0, p.fade || 0)), p.time % 64);
      gl.uniform4f(P.tonemap.loc('uGradeTint'), lean(tint[0]), lean(tint[1]), lean(tint[2]), lean(g.contrast));
      gl.uniform4f(P.tonemap.loc('uGradeShadow'), lean(shadows[0]), lean(shadows[1]), lean(shadows[2]), CAMERA_SATURATION * lean(g.saturation));
      gl.uniform4f(P.tonemap.loc('uFx'), VIGNETTE, q.filmGrain ? GRAIN : 0, q.chromaticAberration ? FRINGE + SPEED_FRINGE * boost : 0, p.temporal ? SHARPEN : 0);
      gl.uniform4f(P.tonemap.loc('uSpeed'), SPEED_STRETCH * boost, 0, 0, 0);
      this.draw();
    }
    if (!direct && P.present.use()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, p.canvasWidth, p.canvasHeight);
      P.present.texture('uColor', post.ldr);
      gl.uniform4f(P.present.loc('uPresent'), q.antialiasing === 'fxaa' ? 1 : 0, 0, 0, 0);
      this.draw();
    }
  }

  /** G-buffer inspection views straight to the canvas. */
  _debug(p) {
    const gl = this.ctx.gl, program = this.programs.debug;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, p.canvasWidth, p.canvasHeight);
    if (!program.use()) return;
    gl.uniform4f(program.loc('uDebug'), p.debugMode, p.aoPresent ? 1 : 0, 0, 0);
    this.draw();
  }
}

const NEUTRAL_GRADE = Object.freeze({ tint: [1, 1, 1], shadowsTint: [1, 1, 1], contrast: 1, saturation: 1 });

function hasActiveFlame(exhaust) {
  for (let i = 0; i < exhaust.length; i++) if (exhaust[i].strength > 0.01) return true;
  return false;
}
