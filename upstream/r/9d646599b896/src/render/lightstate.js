// GPU state behind the `Lighting` uniform block: the cascaded shadow map of the dominant light, the light
// grid textures, the contact-occlusion boxes, and the uniform buffer that describes them to the shaders.

import { LIGHT_STRIDE } from '../core/ids.js';
import { createTexture, createFramebuffer, LIGHTING_BLOCK_BINDING } from './gl.js';
import { LightGrid, CELL_NEAR, CELL_FAR, LIGHT_TEXELS } from './lightgrid.js';
import { cascadeSplits, sliceSphere, quantizeRadius, lightBasis, fitCascade, cascadeMatrix, makeCascade, MAX_CASCADES } from './shadows.js';
import { LIGHTING_LAYOUT as L, MAX_OCCLUDERS, LIGHTS_PER_ROW } from './shaders/common.js';

/** Casters this far towards the light beyond a cascade still shadow it (the tallest tower plus margin). */
const CASTER_REACH = 320;
/** The first cascade starts here rather than at the near plane: nothing closer is ever on screen for long. */
const SHADOW_NEAR = 0.6;
/** Penumbra width in metres: the sun is a small disc; moonlight is drawn softer so that it reads as night. */
const PENUMBRA_SUN = 0.07, PENUMBRA_MOON = 0.16;
/** Cascade i is re-rendered every UPDATE_EVERY[i] frames; the far ones change slowly on screen. */
const UPDATE_EVERY = [1, 1, 2, 4];
/** Ambient radiance added at the peak of a lightning flash, in exposed units. */
const LIGHTNING_LEVEL = 1.2;
/** Share of a flash that falls by how far a surface is turned upward; the rest reaches every surface alike. */
const LIGHTNING_FROM_ABOVE = 0.45;
/**
 * A room's light box is found by rays towards points spread over it (litRoomShadow in shaders/common.js):
 * this many per tap of the street's shadow kernel, at most ROOM_RAYS_MOST (the shader's loop). A ray reads
 * the map three times, but a room has one map where the street has up to four and no cloud shadow.
 */
const ROOM_RAYS_PER_TAP = 1.4, ROOM_RAYS_MOST = 16;
/** The room's height map starts this far under its floor, so the floor itself is well inside the range. */
const ROOM_FLOOR_MARGIN = 0.25;
/** It ends this far under the lowest edge of the light box: the box and what hangs above it shade nothing. */
const ROOM_BOX_CLEARANCE = 0.03;
/** Share of light scattered per metre of a room's air at frame.room.haze = 1 (a smoke machine; at 0.25 a faint glow close to the tubes). */
const ROOM_HAZE_DENSITY = 0.004;
/** In a room every light is listed in every light cell this far round it: further than any room is wide. */
const ROOM_LIGHT_SPREAD = 64;

/**
 * Gain on the summed light of all lamps (street lamps, car lamps, sign and shopfront spill), from
 * Environment.lampGain: 1 by night, less while the sky still lights the street. An environment that does not
 * say (a harness page, a test) gets lamps at full strength.
 */
export function lampGain(env) {
  const gain = env.lampGain;
  return Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) : 1;
}

export class LightState {
  constructor(ctx) {
    this.ctx = ctx;
    this.block = new Float32Array(L.floats);
    /** uProbeRoom as it stands in the block, for the one pass that needs the room without binding the block. */
    this.probeRoom = this.block.subarray(L.probeRoom, L.probeRoom + 8);
    this.cascades = []; for (let i = 0; i < MAX_CASCADES; i++) this.cascades.push(makeCascade());
    this.cascadeCount = 0; this.shadowSize = 0; this.shadowMap = null; this.shadowFbos = [];
    this.grid = null; this.lightData = null; this.lightCells = null; this.lightRows = 0;
    // key -> { lights: Float32Array of light records (world space), memory: one float per record, how far
    // each light has faded in (LightGrid.add) }
    this.staticLights = new Map();
    this.shadowDraws = 0;
    this._splits = new Float64Array(MAX_CASCADES + 1); this._sphere = new Float64Array(2); this._basis = new Float64Array(9);
    this._occluderOrder = new Uint16Array(256); this._occluderDistance = new Float32Array(256);
    this._byDistance = (a, b) => this._occluderDistance[a] - this._occluderDistance[b];
    this._quality = null;
    this._roomAmbient = new Float32Array(3);
  }

  /** (Re)create everything that depends on quality: shadow map size and cascade count, grid dimensions. */
  configure(quality) {
    const gl = this.ctx.gl;
    this.release();
    this._quality = quality;
    this.ubo = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo); gl.bufferData(gl.UNIFORM_BUFFER, this.block.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, LIGHTING_BLOCK_BINDING, this.ubo);

    // A 1x1 map stands in when shadows are off, so the sampler always has a complete texture.
    this.cascadeCount = quality.shadows.cascades; this.shadowSize = quality.shadows.size || 1;
    this.shadowMap = createTexture(gl, { internal: gl.DEPTH_COMPONENT24, width: this.shadowSize, height: this.shadowSize, layers: Math.max(1, this.cascadeCount), filter: 'linear', compare: true });
    for (let i = 0; i < this.cascadeCount; i++) this.shadowFbos.push(createFramebuffer(gl, 'shadow cascade ' + i, [], { texture: this.shadowMap, level: 0, layer: i }));
    for (const c of this.cascades) c.valid = false;

    const q = quality.lights;
    this.grid = new LightGrid(q);
    this.lightRows = Math.ceil(this.grid.capacity / LIGHTS_PER_ROW);
    this.lightData = createTexture(gl, { internal: gl.RGBA32F, width: LIGHTS_PER_ROW * LIGHT_TEXELS, height: this.lightRows });
    this.lightCells = createTexture(gl, { internal: gl.R16UI, width: this.grid.width, height: this.grid.height });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.ctx.shared.set('uShadowMap', { target: gl.TEXTURE_2D_ARRAY, texture: this.shadowMap });
    this.ctx.shared.set('uLightData', { target: gl.TEXTURE_2D, texture: this.lightData });
    this.ctx.shared.set('uLightCells', { target: gl.TEXTURE_2D, texture: this.lightCells });
  }

  release() {
    const gl = this.ctx.gl;
    if (!this.ubo) return;
    gl.deleteBuffer(this.ubo); gl.deleteTexture(this.shadowMap); gl.deleteTexture(this.lightData); gl.deleteTexture(this.lightCells);
    for (const f of this.shadowFbos) gl.deleteFramebuffer(f);
    this.forget();
  }

  /** After a context loss the GL objects are gone already. */
  forget() { this.ubo = null; this.shadowMap = this.lightData = this.lightCells = null; this.shadowFbos.length = 0; }

  /** Static lights of one tile; null clears. The array is kept by reference (the world owns it and does not change it). */
  setStatic(key, lights) {
    if (lights && lights.length >= LIGHT_STRIDE) this.staticLights.set(key, { lights, memory: new Float32Array(Math.floor(lights.length / LIGHT_STRIDE)) });
    else this.staticLights.delete(key);
  }

  // ---------------------------------------------------------------------------------------------- shadows
  /**
   * Fit and render the cascades that are due this frame.
   * view: { cam (world, doubles), forward (unit), tanHalfFovY, aspect }; lightDir: unit vector towards the light;
   * force: re-render every cascade (camera cut, first frame).
   */
  renderShadows(scene, view, lightDir, isSun, frameIndex, force, room = null, interior = false) {
    const gl = this.ctx.gl, q = this._quality.shadows, block = this.block, count = this.cascadeCount;
    this.shadowDraws = 0;
    if (interior) { this._renderRoomShadow(scene, view.cam, room); return; }
    block[L.shadowInfo] = count; block[L.shadowInfo + 1] = q.distance * 0.82; block[L.shadowInfo + 2] = q.distance; block[L.shadowInfo + 3] = Math.max(1, q.taps);
    block[L.shadowSoft] = isSun ? PENUMBRA_SUN : PENUMBRA_MOON; block[L.shadowSoft + 1] = 1 / this.shadowSize;
    if (!count) return;
    // A light at or below the horizon would stretch every shadow to infinity: keep it a little above.
    const basis = lightBasis(this._basis, lightDir[0], Math.max(lightDir[1], 0.08), lightDir[2]), splits = cascadeSplits(this._splits, count, SHADOW_NEAR, q.distance);

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.disable(gl.BLEND);
    // Both faces are drawn: thin geometry (signs, fences, leaves) must cast, and with the normal offset in
    // the lookup, front faces do not self-shadow.
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.1, 2.0);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    for (let i = 0; i < count; i++) {
      const cascade = this.cascades[i];
      const due = force || !cascade.valid || (frameIndex + i) % UPDATE_EVERY[i] === 0;
      if (due) {
        sliceSphere(this._sphere, view.tanHalfFovY, view.aspect, splits[i], splits[i + 1]);
        // Cascades that skip frames are fitted with room for the distance the camera covers meanwhile.
        const radius = quantizeRadius(this._sphere[1] + (UPDATE_EVERY[i] - 1) * 2.5);
        fitCascade(cascade, basis, view.cam, view.forward, this._sphere[0], radius, this.shadowSize, CASTER_REACH);
        cascade.valid = true;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbos[i]);
        gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
        // Until both cascades are drawn again the camera travels up to 2.5 m a frame (see the radius above).
        if (i > 0) scene.cullCasters(cascade, this.cascades[i - 1], (UPDATE_EVERY[i] + UPDATE_EVERY[i - 1] - 2) * 2.5);
        else scene.cullCasters(cascade, null, 0);
        scene.drawShadow(cascade.matrix);
        this.shadowDraws++;
      } else {
        cascadeMatrix(cascade, view.cam);          // same map, re-expressed relative to where the camera is now
      }
      this._describeCascade(i);
    }
    for (let i = count; i < MAX_CASCADES; i++) block[L.shadowTexel + i] = 0;
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.enable(gl.CULL_FACE);
  }

  /** Cascade i for the shaders: its matrix taken from clip space to texture space (xy and depth from [-1,1] to [0,1]), texel and depth range. */
  _describeCascade(i) {
    const block = this.block, cascade = this.cascades[i], m = cascade.matrix, o = L.shadowMatrix + i * 16;
    for (let c = 0; c < 4; c++) {
      const w = m[c * 4 + 3];
      block[o + c * 4] = 0.5 * m[c * 4] + 0.5 * w; block[o + c * 4 + 1] = 0.5 * m[c * 4 + 1] + 0.5 * w;
      block[o + c * 4 + 2] = 0.5 * m[c * 4 + 2] + 0.5 * w; block[o + c * 4 + 3] = w;
    }
    block[L.shadowTexel + i] = cascade.texel; block[L.shadowDepth + i] = 1 / cascade.depthRange;
  }

  /**
   * The shadow of a closed room. Its key is a light box overhead, far too wide for a view from the light:
   * instead the first layer of the map becomes a height map of all that stands under the box, drawn
   * looking straight up from below the floor and keeping the highest surface (depth 0 at the floor, 1 just
   * under the box). What hangs above the box is cut off by the far plane, so trusses and the ceiling never
   * shade the room. The shader walks from a surface towards the box through this map (litRoomShadow).
   * Without a light box, or at a quality without shadow maps, the room has no such shadow.
   */
  _renderRoomShadow(scene, cam, room) {
    const gl = this.ctx.gl, q = this._quality.shadows, block = this.block, box = room && room.lightBox;
    const mapped = this.cascadeCount > 0 && !!box;
    block[L.shadowInfo] = mapped ? 1 : 0; block[L.shadowInfo + 1] = 1e9; block[L.shadowInfo + 2] = 1e9;
    block[L.shadowInfo + 3] = Math.min(ROOM_RAYS_MOST, Math.max(1, Math.round(q.taps * ROOM_RAYS_PER_TAP)));
    block[L.shadowSoft] = 0; block[L.shadowSoft + 1] = 1 / this.shadowSize;
    for (let i = 0; i < MAX_CASCADES; i++) { block[L.shadowTexel + i] = 0; this.cascades[i].valid = false; }
    if (!mapped) return;
    const min = room.min, max = room.max, cascade = this.cascades[0], m = cascade.matrix, basis = cascade.basis;
    const bottom = min[1] - ROOM_FLOOR_MARGIN;
    const top = box.centre[1] - Math.abs(box.u[1]) - Math.abs(box.v[1]) - ROOM_BOX_CLEARANCE;
    const spanX = Math.max(max[0] - min[0], 1e-3), spanZ = Math.max(max[2] - min[2], 1e-3), spanY = Math.max(top - bottom, 1e-3);
    // Map u runs along world x, v along world z, depth along world y (up).
    m.fill(0);
    m[0] = 2 / spanX; m[12] = 2 * (cam[0] - min[0]) / spanX - 1;
    m[9] = 2 / spanZ; m[13] = 2 * (cam[2] - min[2]) / spanZ - 1;
    m[6] = 2 / spanY; m[14] = 2 * (cam[1] - bottom) / spanY - 1;
    m[15] = 1;
    // The same room as a cascade, for the caster test of the scene: everything inside its walls is drawn.
    basis.fill(0); basis[0] = 1; basis[5] = 1; basis[7] = 1;
    cascade.centre[0] = (min[0] + max[0]) / 2; cascade.centre[1] = bottom; cascade.centre[2] = (min[2] + max[2]) / 2;
    cascade.radius = Math.max(spanX, spanZ) / 2; cascade.casterReach = spanY; cascade.depthRange = spanY;
    cascade.texel = Math.max(spanX, spanZ) / this.shadowSize;

    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GREATER); gl.depthMask(true); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.viewport(0, 0, this.shadowSize, this.shadowSize);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbos[0]);
    gl.clearDepth(0); gl.clear(gl.DEPTH_BUFFER_BIT);
    scene.cullCasters(cascade, null, 0);
    scene.drawShadow(cascade.matrix);
    this.shadowDraws = 1;
    gl.clearDepth(1); gl.depthFunc(gl.LESS); gl.enable(gl.CULL_FACE);
    this._describeCascade(0);
  }

  /**
   * The room of an interior frame as the shaders need it, or null on a street frame (which also takes the
   * room's light box, air and ambient light away again). cam: world camera position; room: frame.room of
   * design/GARAGE.md, { lightBox: { centre, u, v, radiance } | null, ambient: [r, g, b], haze: 0..1 }.
   * Presets without volumetric light show the room without haze.
   */
  setRoom(cam, room) {
    const block = this.block, key = L.roomKey, box = room && room.lightBox, ambient = this._roomAmbient, q = this._quality;
    block.fill(0, key, key + 16); block[L.roomAir] = 0;
    ambient[0] = ambient[1] = ambient[2] = 0;
    if (!room) return;
    if (room.ambient) { ambient[0] = room.ambient[0]; ambient[1] = room.ambient[1]; ambient[2] = room.ambient[2]; }
    if (q.volumetrics) block[L.roomAir] = Math.min(1, Math.max(0, room.haze || 0)) * ROOM_HAZE_DENSITY;
    if (!box) return;
    const u = box.u, v = box.v;
    block[key] = box.centre[0] - cam[0]; block[key + 1] = box.centre[1] - cam[1]; block[key + 2] = box.centre[2] - cam[2]; block[key + 3] = 1;
    block[key + 4] = u[0]; block[key + 5] = u[1]; block[key + 6] = u[2];
    // The face that shines is the one turned down, whichever way round the two edges were given.
    block[key + 7] = u[2] * v[0] - u[0] * v[2] <= 0 ? 1 : -1;
    block[key + 8] = v[0]; block[key + 9] = v[1]; block[key + 10] = v[2];
    block[key + 12] = box.radiance[0]; block[key + 13] = box.radiance[1]; block[key + 14] = box.radiance[2];
  }

  // ---------------------------------------------------------------------------------------------- lights
  /**
   * Select and bin this frame's lights and upload the grid. Returns the number of lights in use.
   * surround, subject, ground, dt: see LightGrid.begin (subject = the player's car, ground = the road under
   * it, dt = Infinity after a camera cut).
   */
  buildGrid(cam, planes, env, time, dynamic, dynamicCount, surround, subject, ground, dt, interior = false) {
    const gl = this.ctx.gl, grid = this.grid, block = this.block;
    grid.begin(cam, planes, env.switches || NO_SWITCHES, env.night || 0, time, surround, subject, ground, dt);
    // The lamps of the city's tiles light the street; a closed room is lit by the frame's own lights alone.
    // The tiles keep their fade memory: nothing was offered, so on the way back every lamp simply is on.
    if (!interior) for (const tile of this.staticLights.values()) grid.add(tile.lights, tile.memory.length, tile.memory);
    // The glow of the air round a light shows in front of whatever lies behind it, however far off.
    grid.spread = interior ? ROOM_LIGHT_SPREAD : 0;
    if (dynamic && dynamicCount > 0) grid.add(dynamic, dynamicCount);
    const count = grid.finish();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (count > 0) {
      const rows = Math.ceil(count / LIGHTS_PER_ROW);
      gl.bindTexture(gl.TEXTURE_2D, this.lightData);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHTS_PER_ROW * LIGHT_TEXELS, rows, gl.RGBA, gl.FLOAT, grid.data);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.lightCells);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, grid.width, grid.height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, grid.cells);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    block[L.gridNear] = grid.originNear[0]; block[L.gridNear + 1] = grid.originNear[1]; block[L.gridNear + 2] = 1 / CELL_NEAR; block[L.gridNear + 3] = grid.sizeNear;
    block[L.gridFar] = grid.originFar[0]; block[L.gridFar + 1] = grid.originFar[1]; block[L.gridFar + 2] = 1 / CELL_FAR; block[L.gridFar + 3] = grid.sizeFar;
    block[L.gridInfo] = grid.perCell; block[L.gridInfo + 1] = grid.sizeNear; block[L.gridInfo + 2] = lampGain(env);
    return count;
  }

  /** Contact-occlusion boxes: the nearest MAX_OCCLUDERS of frame.occluders ([cx, cy, cz, yaw, halfW, halfH, halfL, _] each). */
  setOccluders(cam, occluders, count) {
    const block = this.block, order = this._occluderOrder, distance = this._occluderDistance;
    const n = Math.min(count | 0, order.length);
    for (let i = 0; i < n; i++) { order[i] = i; distance[i] = Math.hypot(occluders[i * 8] - cam[0], occluders[i * 8 + 2] - cam[2]); }
    if (n > MAX_OCCLUDERS) order.subarray(0, n).sort(this._byDistance);
    const used = Math.min(n, MAX_OCCLUDERS);
    for (let k = 0; k < used; k++) {
      const s = order[k] * 8, o = L.occluders + k * 8, yaw = occluders[s + 3];
      block[o] = occluders[s] - cam[0]; block[o + 1] = occluders[s + 1] - cam[1]; block[o + 2] = occluders[s + 2] - cam[2]; block[o + 3] = Math.cos(yaw);
      block[o + 4] = occluders[s + 4]; block[o + 5] = occluders[s + 5]; block[o + 6] = occluders[s + 6]; block[o + 7] = Math.sin(yaw);
    }
    block[L.occluderInfo] = used;
  }

  /**
   * The scene reflection probe as shaders need it. relative: origin of the capture relative to the camera;
   * valid: the cube holds a capture; groundHeight: height of the ground plane relative to the camera
   * (reflections that go down are aimed at it); lastLevel: mip level that holds roughness 1; faceShift:
   * six (x, y, z, 0), where the probe stood for each face relative to where it stands now.
   */
  setProbe(relative, valid, groundHeight, lastLevel, faceShift) {
    const block = this.block;
    block[L.probe] = relative[0]; block[L.probe + 1] = relative[1]; block[L.probe + 2] = relative[2]; block[L.probe + 3] = valid ? 1 : 0;
    block[L.probeInfo] = groundHeight; block[L.probeInfo + 1] = lastLevel;
    block.set(faceShift, L.probeFaces);
  }

  /**
   * The box a room's reflection probe is read against (roomAim in shaders/common.js). cam: world camera
   * position; room: { min, max } in world metres, or null when the probe does not stand in a room.
   */
  setProbeRoom(cam, room) {
    const block = this.block, o = L.probeRoom;
    block[o + 3] = room ? 1 : 0;
    if (!room) return;
    block[o] = room.min[0] - cam[0]; block[o + 1] = room.min[1] - cam[1]; block[o + 2] = room.min[2] - cam[2];
    block[o + 4] = room.max[0] - cam[0]; block[o + 5] = room.max[1] - cam[1]; block[o + 6] = room.max[2] - cam[2];
  }

  /**
   * flash: lightning 0..1; exposure: this frame's exposure; noisePhase: advances per frame under temporal AA
   * so that noise averages out.
   */
  upload(flash, exposure, noisePhase) {
    const gl = this.ctx.gl, block = this.block;
    block[L.shadowSoft + 2] = noisePhase;
    // Lightning lights the scene from above with a cold white for an instant. Its strength is set in
    // display terms (a mid-grey road reaches about a third of white) whatever the hour: a flash that was
    // right against a noon exposure would burn the whole frame out at night.
    const boost = LIGHTNING_LEVEL * flash / Math.max(exposure, 1e-3);
    // A room's ambient light (what its walls and floor throw back) arrives from all round, a flash from above:
    // w is the share of the whole that falls by the upward tilt of a surface.
    const ambient = this._roomAmbient;
    block[L.ambientBoost] = 0.86 * boost + ambient[0]; block[L.ambientBoost + 1] = 0.94 * boost + ambient[1]; block[L.ambientBoost + 2] = 1.2 * boost + ambient[2];
    block[L.ambientBoost + 3] = boost > 0 ? LIGHTNING_FROM_ABOVE * boost / (boost + (ambient[0] + ambient[1] + ambient[2]) / 3) : 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, block);
  }
}
const NO_SWITCHES = Object.freeze({ street: 0, neon: 0, windows: 0 });
