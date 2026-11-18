// Cloud maps: the cumulus march of glsl/clouds.js, spread over frames.
//   uSkyCloudsA, uSkyCloudsB   square RGBA16F maps of the upper hemisphere (layout: SKY_CLOUD_MAPPING)
// One map is on screen while the other is refilled a tile per frame from a snapshot of the camera position and the
// cloud drift; then the screen fades across and the roles swap. The lookup corrects each map for the movement since
// its snapshot, so the refresh rate limits how fast clouds can change shape, never how they sit in the sky.
// A jump in time or weather refills the visible map over a few frames; `complete` is false until that is done.

/** Tiles per side. One tile is marched per frame: a refill takes about a second, in which a cloud drifts a few metres. */
const GRID = 8;
/** Tiles per frame when nothing valid is on screen (first frame, jump in time or weather). */
const RUSH = 8;
/** Frames the screen takes to fade from the old map to the new one. */
const FADE_FRAMES = 12;
/** Side of a map in texels by quality tier (0 low .. 3 ultra). */
export const CLOUD_MAP_SIDES = Object.freeze([768, 1024, 1536, 2048]);
/** Uniform-free jitter phases: a different one for each refill, so the grain of the march never repeats in place. */
const PHASE_STEP = 0.61803;

export function createCloudMaps(host, program, state) {
  const gl = host.gl;
  // per map: where the camera stood and how far the clouds had drifted when its march began
  const snapshots = [{ camera: new Float64Array(3), drift: new Float64Array(2) }, { camera: new Float64Array(3), drift: new Float64Array(2) }];
  let side = 0, textures = [null, null], targets = [null, null];
  let shown = 0, tile = 0, fade = 0, fading = false, complete = false, refills = 0, pending = 0;

  function release() {
    if (!side) return;
    for (let i = 0; i < 2; i++) { gl.deleteTexture(textures[i]); gl.deleteFramebuffer(targets[i]); }
    textures = [null, null]; targets = [null, null]; side = 0;
  }
  /** (Re)create both maps with the given side. */
  function build(size) {
    release();
    side = size; complete = false;
    for (let i = 0; i < 2; i++) {
      textures[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, side, side);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      targets[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, textures[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    host.shareTexture('uSkyCloudsA', gl.TEXTURE_2D, textures[0]);
    host.shareTexture('uSkyCloudsB', gl.TEXTURE_2D, textures[1]);
  }

  function snapshot(index, camera) {
    const s = snapshots[index];
    s.camera[0] = camera[0]; s.camera[1] = camera[1]; s.camera[2] = camera[2];
    s.drift[0] = state.cloudOffset[0]; s.drift[1] = state.cloudOffset[1];
  }
  function shift(index, camera, out) {
    const s = snapshots[index];
    out[0] = camera[0] - s.camera[0] + state.cloudOffset[0] - s.drift[0];
    out[1] = camera[1] - s.camera[1];
    out[2] = camera[2] - s.camera[2] + state.cloudOffset[1] - s.drift[1];
  }

  return {
    build,
    dispose: release,
    /** True once the visible map holds a complete sky. */
    get complete() { return complete; },
    /** Refill the visible map as fast as is reasonable, starting at the next update (time jump, weather switch). */
    invalidate() { complete = false; tile = 0; },
    /**
     * Decide this frame's work and write the lookup corrections into the sky state. Call before the Sky block is
     * packed; `march` then does the work with the block bound.
     */
    schedule(camera) {
      const filling = 1 - shown;
      if (!complete) {
        // nothing valid to show: march the hidden map in a few frames and cut to it
        if (tile === 0) snapshot(filling, camera);
        pending = RUSH; fading = false; fade = 0;
      } else if (fading) {
        fade += 1 / FADE_FRAMES; pending = 0;
        if (fade >= 1) { shown = filling; fading = false; fade = 0; }
      } else {
        if (tile === 0) { snapshot(filling, camera); refills++; }
        pending = 1;
      }
      shift(0, camera, state.cloudMapA); shift(1, camera, state.cloudMapB);
      const towards = fading ? fade * fade * (3 - 2 * fade) : 0;
      state.cloudMapShare = shown === 1 ? 1 - towards : towards;
      // The march adds the current drift from the Sky block; starting it this far from the snapshot camera lands the
      // clouds where they were when the snapshot was taken, however many frames the refill takes.
      const s = snapshots[1 - shown], bake = state.cloudBake;
      bake[0] = s.camera[0] + s.drift[0] - state.cloudOffset[0]; bake[1] = s.camera[1];
      bake[2] = s.camera[2] + s.drift[1] - state.cloudOffset[1]; bake[3] = (refills * PHASE_STEP) % 1;
    },
    /** March the tiles scheduled for this frame. Leaves its own framebuffer bound and the scissor test off. */
    march() {
      if (!pending || !program.use()) return;
      const filling = 1 - shown, step = side / GRID;
      gl.bindFramebuffer(gl.FRAMEBUFFER, targets[filling]);
      gl.viewport(0, 0, side, side);
      gl.enable(gl.SCISSOR_TEST);
      for (; pending > 0 && tile < GRID * GRID; pending--, tile++) {
        gl.scissor((tile % GRID) * step, Math.floor(tile / GRID) * step, step, step);
        host.drawFullscreen();
      }
      gl.disable(gl.SCISSOR_TEST);
      if (tile >= GRID * GRID) {
        tile = 0;
        if (complete) fading = true; else { shown = filling; complete = true; }
      }
    },
  };
}
