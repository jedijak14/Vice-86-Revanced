// Local lights: selection, switching and binning on the ground plane.
//
// The city is flat, so lights are binned on a 2D grid around the camera instead of in view-space
// clusters. Two nested levels share one index texture: a fine grid of 8 m cells near the camera and a
// coarse grid of 32 m cells that carries street lighting out to the skyline. Each cell lists up to
// `perCell` light indices; the lighting shader looks up the cell of the pixel's world (x, z) and loops
// over that list only. Channel switching (street lamps striking at dusk, neon, flicker) is evaluated
// here on the CPU with the same formulas as channelLevel() in shaders/lib.js, so a tube and the light
// it casts always agree.
//
// Both limits of a preset (lights per frame, lights per cell) are spent by what a light gives, never by
// the order lights arrive in: the frame's limit by how near a light's pool lies to the player's car, a
// cell's slots by the light each lamp sheds on the ground of that cell. A light that loses its place in
// the frame fades out, and its successor in, over FADE_SECONDS; a light that holds a place keeps it until
// another outranks it clearly. Nothing the limits do may show as a pool of light switching.

import { LIGHT_STRIDE, CHANNEL } from '../core/ids.js';
import { sphereVisible } from './cull.js';
import { LIGHTS_PER_ROW } from './shaders/common.js';

export const CELL_NEAR = 8;       // metres
export const CELL_FAR = 32;       // metres
export const EMPTY_SLOT = 0xffff;
/** RGBA32F texels per light in the light data texture. */
export const LIGHT_TEXELS = 4;
/** Light types as the shader sees them (record field 7): point, cone, low beam of a headlamp, glowing tube. */
const LIGHT_POINT = 0, LIGHT_SPOT = 1, LIGHT_BEAM = 2, LIGHT_TUBE = 3;
/**
 * How far from its position a light record can reach. A tube's record gives its midpoint, its reach from
 * the glass (field 3) and its half length (field 11): this is the sphere around the midpoint that holds
 * all of it, which is what culling, binning and the shader's first test go by.
 */
export function lightBound(records, o) {
  return records[o + 7] > 2.5 ? records[o + 3] + Math.max(0, records[o + 11]) : records[o + 3];
}
/**
 * Half width of the fan a low beam is binned into, as a multiple of the tangent of its half spread. The
 * beam's sideways profile (litLowBeam in shaders/common.js) is exp(-(side / (0.6 * spread))^2): at 1.56
 * spreads it has fallen to a thousandth.
 */
export const BEAM_FAN = 1.56;
/**
 * The foreground fill of a low beam (BEAM_FILL in shaders/common.js) is wider than that fan but ends
 * 7.5 m ahead of the lamp: the fan is binned this many metres wider on each side, which holds every
 * point the fill reaches with more than a thousandth of the beam's strength.
 */
export const BEAM_NEAR_MARGIN = 3;

// ---- bit-exact ports of the GLSL hash and value noise in lib.js
function hashU(v) {
  const s = (Math.imul(v, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const hash11 = (p) => hashU(Math.floor(p) >>> 0) / 4294967296;
const hash12 = (x, y) => hashU(((Math.floor(x) >>> 0) + hashU(Math.floor(y) >>> 0)) >>> 0) / 4294967296;
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}
const fract = (x) => x - Math.floor(x);

/**
 * How bright a switched fixture is right now, 0..1. Mirror of channelLevel() in lib.js.
 * switches = { street, neon, windows }, night 0..1, time in seconds.
 */
export function channelLevel(channel, seed, switches, night, time) {
  switch (channel | 0) {
    case CHANNEL.ALWAYS: return 1;
    case CHANNEL.STREET: return switches.street >= seed * 0.35 ? switches.street : 0;
    case CHANNEL.NEON: return switches.neon >= seed * 0.5 ? switches.neon : 0;
    case CHANNEL.WINDOW: return switches.windows;
    case CHANNEL.AVIATION: return fract(time * 0.45 + seed) >= 0.6 ? night : 0;
    case CHANNEL.FLICKER: {
      const t = time * 9 + seed * 91;
      return vnoise(t, seed * 13) >= 0.35 ? switches.neon * (0.6 + 0.4 * hash11(Math.floor(t * 3))) : 0;
    }
    default: return 1;
  }
}

/**
 * Append a light to every cell of one grid level that its circle of influence touches.
 * cells: Uint16Array rows of `size` cells x `perCell` slots starting at row `rowBase`; counts: Uint8Array per cell.
 * (ox, oz) is the grid origin in the same space as the light position. Returns the number of cells that were full.
 * A light that only shines into a fan (a headlamp beam) passes the fan's unit axis on the ground (ax, az) and
 * the tangent of its half angle: cells wholly outside the fan are skipped. fanTan = 0 means all round.
 * fanMargin widens the fan by that many metres on each side.
 * With `ranks` (a Float32Array laid out like `cells`) a full cell keeps the lights that shed most on it: the
 * newcomer takes the place of the weakest one listed if it gives more there. What a light gives a cell is
 * its `power` (colour sum x level) as irradiance on level ground at the nearest point of the cell, the lamp
 * standing `lift` metres above it (cellShare); power = Infinity is never displaced. Without `ranks` a full
 * cell turns the light away. Returns how many times a light was kept out of, or put out of, a full cell.
 */
export function binLight(cells, counts, stride, rowBase, countBase, size, perCell, cellSize, ox, oz, index, x, z, radius, ax = 0, az = 0, fanTan = 0, fanMargin = 0, ranks = null, power = 0, lift = 1) {
  const x0 = Math.max(0, Math.floor((x - radius - ox) / cellSize)), x1 = Math.min(size - 1, Math.floor((x + radius - ox) / cellSize));
  const z0 = Math.max(0, Math.floor((z - radius - oz) / cellSize)), z1 = Math.min(size - 1, Math.floor((z + radius - oz) / cellSize));
  const r2 = radius * radius; let dropped = 0;
  for (let cz = z0; cz <= z1; cz++) {
    const minZ = oz + cz * cellSize, dz = z < minZ ? minZ - z : z > minZ + cellSize ? z - minZ - cellSize : 0;
    for (let cx = x0; cx <= x1; cx++) {
      const minX = ox + cx * cellSize, dx = x < minX ? minX - x : x > minX + cellSize ? x - minX - cellSize : 0;
      if (dx * dx + dz * dz > r2) continue;            // circle misses this cell's rectangle
      if (fanTan > 0) {
        // Cell centre in the fan's frame; the cell reaches half a diagonal further in every direction.
        const vx = minX + cellSize * 0.5 - x, vz = minZ + cellSize * 0.5 - z, reach = cellSize * 0.7072;
        const ahead = vx * ax + vz * az, side = Math.abs(vx * az - vz * ax);
        if (ahead < -reach || side - reach - fanMargin * Math.sqrt(1 + fanTan * fanTan) > (ahead + reach) * fanTan) continue;
      }
      const c = countBase + cz * size + cx, n = counts[c], first = (rowBase + cz) * stride + cx * perCell;
      const share = ranks ? cellShare(power, lift, dx * dx + dz * dz, r2) : 0;
      if (n < perCell) { cells[first + n] = index; counts[c] = n + 1; if (ranks) ranks[first + n] = share; continue; }
      dropped++;
      if (!ranks) continue;
      let weakest = first;
      for (let slot = first + 1; slot < first + perCell; slot++) if (ranks[slot] < ranks[weakest]) weakest = slot;
      if (share > ranks[weakest]) { cells[weakest] = index; ranks[weakest] = share; }
    }
  }
  return dropped;
}

/**
 * What a lamp gives the ground `flat2` (metres squared) away from the point below it, `lift` metres under
 * it: power x cosine / distance squared, brought to zero at the lamp's reach the way litFetch does
 * (reach2 = radius squared). A cell's slots go to the lights that score highest here, so a full cell
 * loses a headlamp eighty metres off (which skims the road and gives it little) or a lamp at the edge of
 * its reach, and never the lamp above it.
 */
export function cellShare(power, lift, flat2, reach2) {
  if (power === Infinity) return Infinity;
  const d2 = flat2 + lift * lift, x2 = d2 / reach2, window = 1 - x2 * x2;
  return window > 0 ? power * lift * window * window / (d2 * Math.sqrt(d2)) : 0;
}
/**
 * Height of a lamp over the surface it lights, for cellShare, is held between these: half a metre, and a
 * quarter of the lamp's reach (a sign's wash hangs high on a wall and lights the wall beside it, not the
 * pavement far below).
 */
const LIFT_LEAST = 0.5, LIFT_MOST_OF_REACH = 0.25;
/** A low beam that starts within this many metres of the player's car is its own headlamp: no cell ever turns it away. */
const OWN_LAMPS = 4;
/** A light that loses its place in the frame leaves, and the one that takes it arrives, over this long. */
export const FADE_SECONDS = 0.4;
/** A light that is shown keeps its place until another's pool lies this many metres nearer to the car. */
const HOLD_METRES = 8;
/** Memory of one static light between frames (LightGrid.add): 0 = was not offered, WAITING = offered but not shown, else the level it was shown at, up to 1. */
const WAITING = -1;

// When more lights are in range than the preset holds, the nearest to the player's car are kept. A neon wash or
// a shopfront spill colours a patch of wall and pavement; a street lamp or a headlamp lights the road for forty
// metres. So that a strip of signs never costs the avenue its lamps, a weak light counts as farther away than it is: by the
// fourth root of how much weaker it is than a street lamp, at most three times. In strength (colour sum x
// radius): street lamp 770 x 37 = 28 000 (factor 1), shopfront spill 113 x 15 = 1 700 (2), neon wash 2 x 4.5 = 9 (3).
const KEY_STRENGTH = 28000, FILL_HANDICAP_MAX = 3;
export function fillHandicap(strength) {
  return Math.min(FILL_HANDICAP_MAX, Math.max(1, Math.sqrt(Math.sqrt(KEY_STRENGTH / Math.max(strength, 1e-3)))));
}

export class LightGrid {
  /** maxLights <= 1024; sizeNear / sizeFar = cells per side of each level (sizeFar may be 0); perCell <= MAX_SLOTS_PER_CELL in shaders/common.js. */
  constructor({ maxLights = 1024, sizeNear = 48, sizeFar = 32, perCell = 16 } = {}) {
    this.maxLights = maxLights; this.sizeNear = sizeNear; this.sizeFar = sizeFar; this.perCell = perCell;
    this.width = Math.max(sizeNear, sizeFar) * perCell;      // index texture size in texels (R16UI)
    this.height = sizeNear + sizeFar;
    this.cells = new Uint16Array(this.width * this.height);
    this.counts = new Uint8Array(sizeNear * sizeNear + sizeFar * sizeFar);
    this.ranks = new Float32Array(this.cells.length);         // what each listed light gives its cell (cellShare)
    // Room beyond the limit for lights that are fading out after losing their place: a quarter more, which
    // is the turnover of FADE_SECONDS at top speed where the chosen lights lie within fifty metres.
    this.capacity = maxLights + (maxLights >> 2);
    // Padded to whole texture rows, so that the rows in use can be uploaded in one call.
    this.data = new Float32Array(Math.ceil(this.capacity / LIGHTS_PER_ROW) * LIGHTS_PER_ROW * LIGHT_TEXELS * 4);
    this.range = Math.max(sizeNear * CELL_NEAR, sizeFar * CELL_FAR) * 0.5;   // metres from the camera
    this.count = 0; this.dropped = 0;
    /** Metres added to every light's reach when it is listed in the near cells (not to what it lights): set per frame, 0 on the street. */
    this.spread = 0;
    this.offered = 0;                                          // lights in range and in view this frame, before the preset's limit
    /** Grid origins RELATIVE TO THE CAMERA (x, z of the corner of cell 0,0), for the shader. */
    this.originNear = new Float32Array(2); this.originFar = new Float32Array(2);
    const cap = 8192;                                          // candidates considered per frame
    this._src = new Array(cap); this._off = new Int32Array(cap); this._level = new Float32Array(cap); this._score = new Float32Array(cap);
    this._memory = new Array(cap).fill(null);
    this._order = new Uint16Array(cap); this._n = 0;
    this._cam = new Float64Array(3); this._planes = null; this._switches = null; this._night = 0; this._time = 0; this._surround = 0;
    this._subject = new Float64Array(3); this._ground = 0; this._step = Infinity;
    this._byScore = (a, b) => this._score[a] - this._score[b];
  }

  /**
   * Start a frame. cam: world camera position; planes: camera-relative frustum planes from extractPlanes;
   * surround: lights reaching within this many metres of the camera are kept even when out of view
   * (for the reflection probe, which looks in every direction); subject: world position of what the
   * camera follows, the player's car (default: the camera), from which lights are ranked when the frame's
   * limit is reached; ground: world height of the road there (default: a metre under the subject); dt:
   * seconds since the last frame, for the fades (default: none, places change hands at once, as they
   * must after a camera cut).
   */
  begin(cam, planes, switches, night, time, surround = 0, subject = null, ground = NaN, dt = Infinity) {
    const at = subject || cam;
    this._cam[0] = cam[0]; this._cam[1] = cam[1]; this._cam[2] = cam[2];
    this._subject[0] = at[0]; this._subject[1] = at[1]; this._subject[2] = at[2];
    this._ground = Number.isFinite(ground) ? ground : at[1] - 1;
    this._step = dt / FADE_SECONDS;
    this._planes = planes; this._switches = switches; this._night = night; this._time = time; this._surround = surround; this._n = 0;
  }

  /**
   * Offer `count` light records (world space, LIGHT_STRIDE floats each). Lights that are off, out of range or
   * out of view are skipped. memory: a Float32Array of `count` zeros that the caller keeps for these records
   * from frame to frame; lights offered with one fade when the frame's limit gives or takes their place,
   * lights offered without one (car lamps, which move) switch.
   */
  add(records, count, memory = null) {
    const cam = this._cam, subject = this._subject, range = this.range, planes = this._planes;
    for (let i = 0; i < count && this._n < this._src.length; i++) {
      const o = i * LIGHT_STRIDE, radius = lightBound(records, o);
      const x = records[o] - cam[0], y = records[o + 1] - cam[1], z = records[o + 2] - cam[2];
      const before = memory ? memory[i] : 0;
      if (memory) memory[i] = 0;                       // stays so unless the light is offered below
      const reach = Math.hypot(x, z) - radius;
      if (reach > range) continue;
      if (reach > this._surround && !sphereVisible(planes, x, y, z, radius, 5)) continue;          // the far plane never matters for lights
      const level = channelLevel(records[o + 13], records[o + 14], this._switches, this._night, this._time);
      if (level <= 0.001) continue;
      const n = this._n++;
      this._src[n] = records; this._off[n] = o; this._level[n] = level; this._memory[n] = memory;
      if (memory) memory[i] = before;
      // Rank, in metres: how far from the car the light's pool begins, or (negative) how deep in the pool the
      // car stands. A pool the car stands in comes before every pool it does not, whatever the light's
      // strength; a weak light counts as farther off, or as less deep. Car lamps cannot fade, so they hold
      // their places as shown lights do.
      const gap = Math.hypot(records[o] - subject[0], records[o + 2] - subject[2]) - radius;
      const weak = fillHandicap((records[o + 4] + records[o + 5] + records[o + 6]) * level * radius);
      this._score[n] = (gap > 0 ? gap * weak : gap / weak) - (before > 0 || !memory ? HOLD_METRES : 0);
    }
  }

  /** Choose the lights that fit, write the data texture and fill both grid levels. Returns the number of lights written. */
  finish() {
    const n = this._n, order = this._order, cam = this._cam, subject = this._subject, data = this.data, step = this._step;
    for (let i = 0; i < n; i++) order[i] = i;
    let chosen = n;
    this.offered = n;
    if (n > this.maxLights) {            // too many: keep those whose pools lie nearest to the car
      order.subarray(0, n).sort(this._byScore); chosen = this.maxLights;
    }

    this.cells.fill(EMPTY_SLOT); this.counts.fill(0);
    // Grid origins snapped to whole cells in world space so that cell membership does not flicker.
    const nearX = (Math.floor(cam[0] / CELL_NEAR) - (this.sizeNear >> 1)) * CELL_NEAR, nearZ = (Math.floor(cam[2] / CELL_NEAR) - (this.sizeNear >> 1)) * CELL_NEAR;
    const farX = (Math.floor(cam[0] / CELL_FAR) - (this.sizeFar >> 1)) * CELL_FAR, farZ = (Math.floor(cam[2] / CELL_FAR) - (this.sizeFar >> 1)) * CELL_FAR;
    this.originNear[0] = nearX - cam[0]; this.originNear[1] = nearZ - cam[2];
    this.originFar[0] = farX - cam[0]; this.originFar[1] = farZ - cam[2];
    let dropped = 0, count = 0;
    for (let i = 0; i < n; i++) {
      const k = order[i], s = this._src[k], o = this._off[k], memory = this._memory[k], at = o / LIGHT_STRIDE;
      // How much of itself the light shows this frame. One that was not offered last frame (out of view,
      // out of range, switched off) owes nobody a fade; one that waited for a place rises into it; one
      // that has lost its place sinks, as long as there is room to draw it.
      const before = memory ? memory[at] : 0;
      let shown;
      if (i < chosen) shown = before === 0 ? 1 : Math.min(1, Math.max(before, 0) + step);
      else shown = before > 0 && count < this.capacity ? before - step : 0;
      if (memory) memory[at] = shown > 0 ? shown : WAITING;
      this._memory[k] = null;                          // no reference outlives the frame
      if (!(shown > 0)) continue;
      const full = this._level[k], level = full * shown, d = count * LIGHT_TEXELS * 4;
      const radius = lightBound(s, o), type = s[o + 7] > 2.5 ? LIGHT_TUBE : s[o + 7] > 1.5 ? LIGHT_BEAM : s[o + 7] > 0.5 ? LIGHT_SPOT : LIGHT_POINT;
      data[d] = s[o] - cam[0]; data[d + 1] = s[o + 1] - cam[1]; data[d + 2] = s[o + 2] - cam[2]; data[d + 3] = radius;
      data[d + 4] = s[o + 4] * level; data[d + 5] = s[o + 5] * level; data[d + 6] = s[o + 6] * level; data[d + 7] = type;
      data[d + 8] = s[o + 8]; data[d + 9] = s[o + 9]; data[d + 10] = s[o + 10]; data[d + 11] = 0;
      if (type === LIGHT_TUBE) {
        // Tube: half length beside the axis, then its reach from the glass (the radius above is the bound).
        data[d + 11] = Math.max(0, s[o + 11]); data[d + 12] = Math.max(1e-3, s[o + 3]); data[d + 13] = 0;
      } else if (type === LIGHT_BEAM) {
        // Low beam: tangent of the horizontal half spread and of the hot spot's depression below the axis.
        data[d + 12] = Math.max(1e-3, s[o + 11]); data[d + 13] = Math.max(1e-4, s[o + 12]);
      } else if (type === LIGHT_SPOT) {
        // Cone as scale and offset: saturate(cosAngle * scale + offset) is 0 at the outer edge and 1 inside the inner cone.
        const spread = Math.max(1e-4, s[o + 12] - s[o + 11]);
        data[d + 12] = 1 / spread; data[d + 13] = -s[o + 11] / spread;
      } else { data[d + 12] = 0; data[d + 13] = 1; }
      data[d + 14] = Math.max(0, s[o + 15] || 0);          // radius of the source in metres, 0 = the shader's default
      data[d + 15] = 0;
      // A beam or a level cone lights a fan ahead of the lamp, not a circle around it: with dozens of headlamps in a street
      // that is the difference between a few lights per cell and every cell being full.
      let ax = 0, az = 0, fanTan = 0, fanMargin = 0;
      if (type === LIGHT_SPOT || type === LIGHT_BEAM) {
        const flat = Math.hypot(s[o + 8], s[o + 10]);
        if (flat > 1e-3) {
          ax = s[o + 8] / flat; az = s[o + 10] / flat;
          if (type === LIGHT_BEAM) { fanTan = BEAM_FAN * data[d + 12]; fanMargin = BEAM_NEAR_MARGIN; }
          else {
            // A cone of half angle a about an axis pitched by p stays within asin(sin a / cos p) of the
            // axis' bearing; a cone that points mostly down (a street lamp) lights all round.
            const sine = Math.sqrt(Math.max(0, 1 - s[o + 11] * s[o + 11])) / flat;
            if (s[o + 11] > 0 && sine < 0.94) fanTan = sine / Math.sqrt(1 - sine * sine);
          }
        }
      }
      // A cell's slots are given by full strength, not by the fade: a light on its way in or out holds
      // the cells it will hold, or held, at full, so the fade is all that changes on screen.
      const own = type === LIGHT_BEAM && !memory && Math.hypot(s[o] - subject[0], s[o + 2] - subject[2]) < OWN_LAMPS;
      // A tube's colour is per metre of its length.
      const power = own ? Infinity : (s[o + 4] + s[o + 5] + s[o + 6]) * full * (type === LIGHT_TUBE ? 2 * Math.max(0.05, s[o + 11]) : 1);
      const lift = Math.min(Math.max(s[o + 1] - this._ground, LIFT_LEAST), Math.max(LIFT_LEAST, radius * LIFT_MOST_OF_REACH));
      dropped += binLight(this.cells, this.counts, this.width, 0, 0, this.sizeNear, this.perCell, CELL_NEAR, nearX, nearZ, count, s[o], s[o + 2], radius + this.spread, ax, az, fanTan, fanMargin, this.ranks, power, lift);
      if (this.sizeFar) dropped += binLight(this.cells, this.counts, this.width, this.sizeNear, this.sizeNear * this.sizeNear, this.sizeFar, this.perCell, CELL_FAR, farX, farZ, count, s[o], s[o + 2], radius, ax, az, fanTan, fanMargin, this.ranks, power, lift);
      count++;
    }
    this.count = count; this.dropped = dropped;
    return count;
  }
}
