// The scene reflection probe: a cube map of the surroundings, captured around a point near the player and
// blurred by roughness down its mips. Every surface reads its specular environment from it (sceneSpecular
// in shaders/common.js), so that paint, glass and wet asphalt mirror the street they stand in (its lamps,
// neon, lit windows and walls) and not only the sky. Screen-space reflections refine it where they can.
//
// Two cube maps:
//   sharp      the scene as seen from the origin, lit forward by the families' `view` programs over the
//              sky; a plain box mip chain is generated for the filter to read;
//   filtered   level 0 = a copy of it, levels 1..PROBE_LAST_LEVEL = the same averaged over the specular
//              lobe of roughness level / PROBE_LAST_LEVEL. This is what shaders sample (uSceneProbe).
// Alpha holds 1 / distance to what was drawn (0 = sky), averaged down the mips like the colour: with it a
// lookup is aimed at the place a reflected ray ends and not merely along its direction (sceneAim).
// A few faces are redrawn per frame in rotation; all six after a camera cut, a jump of the origin or a
// rebuild. Faces captured on different frames differ by the distance travelled in between: `faceShift`
// tells the shaders where the probe stood for each face, and the same lookup takes the difference out.
//
// In a closed room (the garage; plan() is given its record) the probe is the room's and nothing else: the
// sky is left out, so no street light can reach a car's paint there, and the cube is thrown away on the way
// in and on the way out, so neither world is ever seen in the other. A room stands still, so its probe is
// captured when the room opens, twice more so that its polished surfaces hold each other, and then only
// when the room says it has changed (`version`: the door moving, the lights coming up).
// What lights a room is thin: a neon tube seen across it is narrower than a texel of a face, and drawn
// one sample to the texel it comes out as a string of beads that every bonnet then shows. A room's faces
// are therefore drawn at a multiple of their size and averaged down into the cube (configure(), `fine`);
// that happens a few times per visit, not per frame.

import { extractPlanes } from './cull.js';
import { PROBE_LOD } from './scene.js';
import { createTexture, createFramebuffer } from './gl.js';
import { PROBE_LAST_LEVEL } from './shaders/probe.js';

/** How far from the origin the capture draws (metres); beyond it the sky stands in. */
export const PROBE_REACH = 320;
/** Lights this close to the camera are kept even when out of view: the probe looks in every direction. */
export const PROBE_LIGHT_REACH = 60;
/** A move of the origin by more than this between two frames is a jump, not travel (metres). */
const JUMP = 25;
/** In a room the capture point is fixed; a move by more than this is another capture point (metres). */
const ROOM_MOVE = 0.05;
/**
 * Whole captures of a room, one per frame, when it opens: the first sees matte surfaces only (there is no
 * probe yet to light a polished one), the second the tubes in the floor, the third that floor in the chrome.
 */
const ROOM_OPENING_ROUNDS = 3;
/** Whole captures, a few faces per frame, after a room reports a change. */
const ROOM_CHANGE_ROUNDS = 2;
const NEAR = 0.15;
const FACE_COUNT = 6;
const NOTHING = new Float32Array(4);
// Forward and up of each face, in the order of the GL cube targets (+X, -X, +Y, -Y, +Z, -Z). The ups are
// what the cube map layout prescribes; with them every face is an ordinary, unmirrored view.
const FACE_AXES = [
  [1, 0, 0, 0, -1, 0], [-1, 0, 0, 0, -1, 0],
  [0, 1, 0, 0, 0, 1], [0, -1, 0, 0, 0, -1],
  [0, 0, 1, 0, -1, 0], [0, 0, -1, 0, -1, 0],
];

export class SceneProbe {
  /** programs: { sky, filter } (Program objects, see programs.js); drawFullscreen: the renderer's fullscreen triangle. */
  constructor(ctx, programs, drawFullscreen) {
    this.ctx = ctx; this.programs = programs; this.drawFullscreen = drawFullscreen;
    this.size = 0; this.facesPerFrame = 0; this.fine = 1;
    this.sharp = null; this.filtered = null; this.depth = null; this.placeholder = null;
    this.captureFbos = []; this.filteredFbos = [];
    /** Multisampled colour and depth a face is drawn into before it is resolved into the cube, or null. */
    this._fine = [];
    /** Origin of the newest capture relative to the camera, and whether the cube holds a full capture. */
    this.relative = new Float32Array(3); this.valid = false;
    /** Per face (x, y, z, 0): where the probe stood when the face was drawn, relative to where it stands now. */
    this.faceShift = new Float32Array(FACE_COUNT * 4); this._stood = new Float64Array(FACE_COUNT * 3);
    this.facesDrawn = 0;
    this._origin = new Float64Array(3); this._next = 0; this._pending = 0; this._filled = 0;
    /** Whether the cube shows a room, that room's version when it was last looked at, and the faces still to redraw there. */
    this.room = false; this._version = NaN; this._queued = 0; this._opening = false;
    this._planes = new Float64Array(24); this._matrix = new Float64Array(16); this._matrix32 = new Float32Array(16);
    this._basis = []; this._drawn = new Uint8Array(FACE_COUNT);
    for (const [fx, fy, fz, ux, uy, uz] of FACE_AXES) {
      // right = forward x up; columns of the basis are right, up, forward.
      this._basis.push(new Float32Array([fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux, ux, uy, uz, fx, fy, fz]));
    }
    this._createPlaceholder();
    this._publish();
  }

  /** The cube shaders sample: the filtered capture, or a 1 x 1 stand-in while there is none. */
  get texture() { return this.filtered || this.placeholder; }

  _createPlaceholder() {
    const gl = this.ctx.gl;
    this.placeholder = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.placeholder);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 1, gl.RGBA8, 1, 1);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  _publish() { this.ctx.shared.set('uSceneProbe', { target: this.ctx.gl.TEXTURE_CUBE_MAP, texture: this.texture }); }

  /**
   * size: edge of a capture face in pixels (0 = no probe); facesPerFrame: faces redrawn per frame;
   * fine: 1 = a face is drawn at its own size; 2 or 4 = at that multiple of it, each texel the mean of
   * the 4 or 16 pixels drawn for it.
   */
  configure(size, facesPerFrame, fine = 1) {
    this.facesPerFrame = facesPerFrame;
    if (size === this.size && fine === this.fine) return;
    this._release();
    this.size = size; this.fine = fine; this.valid = false; this._filled = 0;
    if (size > 0) {
      const gl = this.ctx.gl;
      const cube = (levels) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, t);
        gl.texStorage2D(gl.TEXTURE_CUBE_MAP, levels, gl.RGBA16F, size, size);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.sharp = cube(Math.floor(Math.log2(size)) + 1);
      this.filtered = cube(PROBE_LAST_LEVEL + 1);
      this.depth = createTexture(gl, { internal: gl.DEPTH_COMPONENT24, width: size, height: size });
      for (let face = 0; face < FACE_COUNT; face++) {
        this.captureFbos.push(createFramebuffer(gl, `probe capture ${face}`, [{ texture: this.sharp, level: 0, face }], this.depth));
        const levels = [];
        for (let level = 0; level <= PROBE_LAST_LEVEL; level++) levels.push(createFramebuffer(gl, `probe filtered ${face}/${level}`, [{ texture: this.filtered, level, face }]));
        this.filteredFbos.push(levels);
      }
      // The face is drawn into the first of these; each further one is half the size of the one before.
      for (let edge = size * fine; edge > size; edge >>= 1) {
        const colour = createTexture(gl, { internal: gl.RGBA16F, width: edge, height: edge, filter: 'linear' });
        const depth = this._fine.length ? null : createTexture(gl, { internal: gl.DEPTH_COMPONENT24, width: edge, height: edge });
        this._fine.push({ edge, colour, depth, fbo: createFramebuffer(gl, `probe face, fine ${edge}`, [{ texture: colour }], depth) });
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    this._publish();
  }

  _release() {
    const gl = this.ctx.gl;
    for (const fbo of this.captureFbos) gl.deleteFramebuffer(fbo);
    for (const levels of this.filteredFbos) for (const fbo of levels) gl.deleteFramebuffer(fbo);
    for (const t of [this.sharp, this.filtered, this.depth]) if (t) gl.deleteTexture(t);
    for (const f of this._fine) { gl.deleteFramebuffer(f.fbo); gl.deleteTexture(f.colour); if (f.depth) gl.deleteTexture(f.depth); }
    this.captureFbos.length = 0; this.filteredFbos.length = 0; this._fine.length = 0;
    this.sharp = this.filtered = this.depth = null;
  }

  /** After a lost context: every GL object is gone; build them again at the same size. */
  restore() {
    const size = this.size;
    this.captureFbos.length = 0; this.filteredFbos.length = 0; this.sharp = this.filtered = this.depth = null; this._fine.length = 0; this.size = 0;
    this._createPlaceholder();
    this.configure(size, this.facesPerFrame, this.fine);
  }

  /**
   * Decide what this frame captures. cam: world camera position; origin: world position to capture from
   * (the player's car, about a metre up; in a room, a fixed point of it); cut: the view jumped this frame;
   * room: the closed room the frame is in ({ version }, see design/GARAGE.md) or null on the street;
   * stale: the scene draws something this frame that it left out before (a shader program has just been
   * built), so a room's cube, which is otherwise drawn once, no longer shows the room as it is. Fills
   * `relative`, `valid` and `room`, which the lighting block carries to the shaders, and returns the number
   * of faces capture() will draw.
   */
  plan(cam, origin, cut, room = null, stale = false) {
    this._pending = 0;
    const inRoom = !!room, changedWorld = inRoom !== this.room;
    this.room = inRoom;
    // A cube of the other world is no cube at all, whether or not this frame can draw a new one.
    if (changedWorld) this._filled = 0;
    if (this.size === 0 || !this.programs.sky.ready || !this.programs.filter.ready) { this.valid = false; return 0; }
    const o = this._origin;
    const jumped = cut || Math.hypot(origin[0] - o[0], origin[1] - o[1], origin[2] - o[2]) > (inRoom ? ROOM_MOVE : JUMP);
    o[0] = origin[0]; o[1] = origin[1]; o[2] = origin[2];
    this.relative[0] = o[0] - cam[0]; this.relative[1] = o[1] - cam[1]; this.relative[2] = o[2] - cam[2];
    if (jumped) this._filled = 0;
    if (inRoom) {
      if (this._filled === 0) { this._queued = FACE_COUNT * ROOM_OPENING_ROUNDS; this._opening = true; }
      else {
        // The opening ends before a change is queued: a change reported on the very next frame is drawn
        // at the preset's pace like any other, not as more whole captures.
        if (this._queued === 0) this._opening = false;
        if (room.version !== this._version || stale) this._queued = Math.max(this._queued, FACE_COUNT * ROOM_CHANGE_ROUNDS);
      }
      this._version = room.version;
      this._pending = this._opening ? FACE_COUNT : Math.min(this._queued, Math.max(1, this.facesPerFrame));
    } else {
      // Until the cube is whole it is redrawn whole. Its first pass lights surfaces from the sky alone
      // (valid is still false); the one after that already sees the street in itself.
      this._pending = this._filled < FACE_COUNT ? FACE_COUNT : this.facesPerFrame;
    }
    this.valid = this._filled >= FACE_COUNT;
    // The faces capture() is about to draw stand at the new origin; the others keep theirs.
    const stood = this._stood, shift = this.faceShift;
    for (let k = 0; k < Math.min(this._pending, FACE_COUNT); k++) {
      const face = (this._next + k) % FACE_COUNT;
      stood[face * 3] = o[0]; stood[face * 3 + 1] = o[1]; stood[face * 3 + 2] = o[2];
    }
    for (let face = 0; face < FACE_COUNT; face++) {
      shift[face * 4] = stood[face * 3] - o[0]; shift[face * 4 + 1] = stood[face * 3 + 1] - o[1]; shift[face * 4 + 2] = stood[face * 3 + 2] - o[2];
    }
    return this._pending;
  }

  /**
   * Draw the faces chosen by plan() and refilter them. scene: the Scene, already culled for the main view.
   * drawLamps(matrix, planes, pixelsPerMetre, width, height): adds the lamps of the street to the face
   * just drawn (glow sprites as sources, see GLOW_VIEW_VS); called with the face bound and depth test on.
   */
  capture(scene, drawLamps) {
    const gl = this.ctx.gl, size = this.size, n = this._pending, rel = this.relative, programs = this.programs, fine = this._fine;
    const drawn = size * this.fine;
    this.facesDrawn = n;
    if (n === 0) return;
    const a = (PROBE_REACH + NEAR) / (NEAR - PROBE_REACH), b = 2 * PROBE_REACH * NEAR / (NEAR - PROBE_REACH);
    this._drawn.fill(0);
    gl.viewport(0, 0, drawn, drawn);
    gl.disable(gl.BLEND); gl.cullFace(gl.BACK); gl.depthFunc(gl.LESS); gl.clearDepth(1);
    for (let k = 0; k < n; k++) {
      const face = this._next; this._next = (face + 1) % FACE_COUNT; this._drawn[face] = 1;
      const e = this._basis[face], m = this._matrix;
      const rx = e[0], ry = e[1], rz = e[2], ux = e[3], uy = e[4], uz = e[5], fx = e[6], fy = e[7], fz = e[8];
      const ahead = fx * rel[0] + fy * rel[1] + fz * rel[2];
      // Camera-relative world -> clip of this face: a 90 degree square view from the origin (column-major).
      m[0] = rx; m[4] = ry; m[8] = rz; m[12] = -(rx * rel[0] + ry * rel[1] + rz * rel[2]);
      m[1] = ux; m[5] = uy; m[9] = uz; m[13] = -(ux * rel[0] + uy * rel[1] + uz * rel[2]);
      m[2] = -a * fx; m[6] = -a * fy; m[10] = -a * fz; m[14] = a * ahead + b;
      m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -ahead;
      this._matrix32.set(m);
      extractPlanes(this._planes, m);
      // The object the origin sits in (the player's car) would fill its own reflection: it is left out.
      scene.cullView(this._planes, drawn / (Math.PI / 2), PROBE_REACH, -Infinity, this._origin, PROBE_LOD);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fine.length ? fine[0].fbo : this.captureFbos[face]);
      gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
      if (this.room) {
        // A room has no sky: what its walls do not cover is black and at no distance.
        gl.clearBufferfv(gl.COLOR, 0, NOTHING);
      } else {
        gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
        programs.sky.use(); gl.uniformMatrix3fv(programs.sky.loc('uFace'), false, e);
        this.drawFullscreen();
      }
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
      scene.drawView(this._matrix32, rel[0], rel[1], rel[2], false, -1e9, true);
      // A room's lamps are its tubes and its light box, which are geometry and already drawn.
      if (drawLamps && !this.room) drawLamps(this._matrix32, this._planes, size / 2, size, size);
      // Halving with a linear filter reads every pixel once: each step leaves the mean of four.
      for (let i = 0; i < fine.length; i++) {
        const from = fine[i].edge, to = from >> 1;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fine[i].fbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, i + 1 < fine.length ? fine[i + 1].fbo : this.captureFbos[face]);
        gl.blitFramebuffer(0, 0, from, from, 0, 0, to, to, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      }
    }
    this._filled = Math.min(FACE_COUNT, this._filled + n);
    this._queued = Math.max(0, this._queued - n);

    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.sharp); gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);
    const texelSolidAngle = 4 * Math.PI / (FACE_COUNT * size * size);
    for (let face = 0; face < FACE_COUNT; face++) {
      if (!this._drawn[face]) continue;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.captureFbos[face]); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.filteredFbos[face][0]);
      gl.blitFramebuffer(0, 0, size, size, 0, 0, size, size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      programs.filter.use(); programs.filter.texture('uCapture', this.sharp, gl.TEXTURE_CUBE_MAP);
      gl.uniformMatrix3fv(programs.filter.loc('uFace'), false, this._basis[face]);
      for (let level = 1; level <= PROBE_LAST_LEVEL; level++) {
        const edge = Math.max(1, size >> level);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.filteredFbos[face][level]); gl.viewport(0, 0, edge, edge);
        gl.uniform4f(programs.filter.loc('uFilter'), level / PROBE_LAST_LEVEL, texelSolidAngle, 0, 0);
        this.drawFullscreen();
      }
    }
    gl.enable(gl.CULL_FACE);
  }

  dispose() {
    this._release();
    if (this.placeholder) this.ctx.gl.deleteTexture(this.placeholder);
    this.placeholder = null; this.size = 0;
  }
}
