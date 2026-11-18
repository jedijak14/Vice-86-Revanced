// Skid marks: the rubber the player's tyres leave on the road under hard braking, in a
// handbrake turn and in a drift.
//
// A mark is a ribbon of ground geometry as wide as the tyre (the road shader's rubber decal:
// design/ARCHITECTURE.md 5.2, MARKING with the rubber fill). The renderer has no way to
// change a mesh once it is uploaded, so a mark grows in short pieces: every metre and a half
// of sliding becomes a small static mesh at once, which keeps the visible end of the mark
// under the car, and when the tyre grips again (or the mark is long enough) the pieces are
// replaced by one mesh of the whole mark. The oldest marks are removed when there are too
// many, so the cost is bounded however long the player keeps sliding.

import { FAMILY, GROUND } from '../core/ids.js';
import { MeshBuilder } from '../core/mesh.js';
import { saturate } from '../core/math.js';
import { KIND } from '../physics/index.js';

const STEP = 0.4; // m between cross-sections of the ribbon
const PIECE_POINTS = 5; // cross-sections after which the growing end is drawn (1.6 m)
const MARK_POINTS = 120; // cross-sections of one mark (48 m); a longer slide starts another
const MAX_MARKS = 56; // finished marks kept on the road
const POINT_FLOATS = 5; // x, y, z, strength, station

// When a tyre marks the road. The slip measures are the physics wheel's: slip ratio
// (1 = locked or spinning at twice the road speed) and slip angle in radians.
const LONG_START = 0.2, LONG_RANGE = 0.4;
const LAT_START = 0.2, LAT_RANGE = 0.3;
const LAY_ABOVE = 0.12; // strength below which nothing is laid
const MIN_SPEED = 2.5; // m/s of the wheel over the road
// Braking at the limit with the anti-lock system working leaves a fainter, even mark.
const BRAKE_START = 0.85, BRAKE_MIN_SPEED = 9, BRAKE_STRENGTH = 0.32;
const REFERENCE_LOAD = 3400; // N: a tyre carrying less than this marks more faintly
const WET_FADE = 0.85; // how much of the mark a soaked road takes away
const ASPHALT_AGE = 120; // age byte of the asphalt underneath when unknown (the roads' default)

/**
 * @param {{renderer: object, rubberFill: number}} deps
 *   rubberFill: the MARKING fill code of the rubber decal (MARKING_FILL.RUBBER of the roads)
 */
export function createSkidMarks({ renderer, rubberFill }) {
  const tracks = [];
  for (let i = 0; i < 4; i++) {
    tracks.push({ points: new Float32Array(MARK_POINTS * POINT_FLOATS), count: 0, drawn: 0, station: 0, active: false, pieces: [], width: 0.25 });
  }
  const marks = [];
  const origin = [0, 0, 0];

  /** Static mesh of the cross-sections first..last of a track. */
  function draw(track, first, last) {
    const p = track.points, half = track.width / 2, n = last - first + 1;
    const mb = new MeshBuilder(n * 2);
    mb.family(FAMILY.GROUND).material(GROUND.MARKING, rubberFill, 0, ASPHALT_AGE).color(1, 1, 1);
    const ox = p[first * POINT_FLOATS], oy = p[first * POINT_FLOATS + 1], oz = p[first * POINT_FLOATS + 2];
    for (let i = first; i <= last; i++) {
      const o = i * POINT_FLOATS;
      // The ribbon is cut square to the mean direction of the two segments that meet here.
      const a = Math.max(first === 0 ? 0 : first - 1, i - 1) * POINT_FLOATS, b = Math.min(track.count - 1, i + 1) * POINT_FLOATS;
      let dx = p[b] - p[a], dz = p[b + 2] - p[a + 2];
      const length = Math.hypot(dx, dz) || 1;
      dx /= length; dz /= length;
      // Facing along the mark, (dz, -dx) is on the left: u = -1 there, +1 on the right.
      const x = p[o] - ox, y = p[o + 1] - oy, z = p[o + 2] - oz;
      mb.occlusion(p[o + 3]);
      const left = mb.vertex(x + dz * half, y, z - dx * half, 0, 1, 0, -1, p[o + 4]);
      const right = mb.vertex(x - dz * half, y, z + dx * half, 0, 1, 0, 1, p[o + 4]);
      if (i > first) mb.quad(left - 2, right - 2, right, left); // counter-clockwise seen from above
    }
    const mesh = renderer.createMesh(mb.finish());
    origin[0] = ox; origin[1] = oy; origin[2] = oz;
    return { mesh, id: renderer.addStatic({ mesh, origin, castShadow: false }) };
  }

  function discard(piece) {
    renderer.remove(piece.id);
    renderer.destroyMesh(piece.mesh);
  }

  function add(track, x, y, z, strength) {
    const p = track.points, o = track.count * POINT_FLOATS;
    if (track.count > 0) track.station += Math.hypot(x - p[o - POINT_FLOATS], z - p[o - POINT_FLOATS + 2]);
    p[o] = x; p[o + 1] = y; p[o + 2] = z; p[o + 3] = strength; p[o + 4] = track.station;
    track.count++;
  }

  /** The pieces of a track become one finished mark. */
  function finish(track) {
    for (const piece of track.pieces) discard(piece);
    track.pieces.length = 0;
    if (track.count >= 2) {
      marks.push(draw(track, 0, track.count - 1));
      if (marks.length > MAX_MARKS) discard(marks.shift());
    }
    track.count = 0;
    track.drawn = 0;
  }

  return {
    /** Finished marks on the road, for tests and statistics. */
    get count() { return marks.length; },

    /**
     * Once per frame, after the physics step.
     * @param {object} vehicle  the player's physics vehicle
     * @param {number[]} tyreWidths  metres, per wheel (FL, FR, RL, RR)
     * @param {number} wetness  0..1 of the road
     */
    update(vehicle, tyreWidths, wetness) {
      const braking = vehicle.brake > BRAKE_START && Math.abs(vehicle.speed) > BRAKE_MIN_SPEED;
      const dry = 1 - WET_FADE * saturate(wetness);
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheels[i], track = tracks[i];
        let strength = 0;
        if (w.contact && w.surfaceKind === KIND.ASPHALT && Math.hypot(vehicle.vel[0], vehicle.vel[2]) > MIN_SPEED) {
          const slide = Math.max((Math.abs(w.slipLong) - LONG_START) / LONG_RANGE, (Math.abs(w.slipLat) - LAT_START) / LAT_RANGE);
          strength = Math.max(saturate(slide), braking ? BRAKE_STRENGTH : 0) * saturate(w.load / REFERENCE_LOAD) * dry;
        }
        const x = w.worldPos[0], y = w.surfaceY, z = w.worldPos[2];
        if (strength > LAY_ABOVE) {
          if (!track.active) {
            // A mark fades in from nothing at the point where the tyre let go.
            track.active = true;
            track.station = 0;
            track.width = tyreWidths[i];
            add(track, x, y, z, 0);
            continue;
          }
          const last = (track.count - 1) * POINT_FLOATS;
          if (Math.hypot(x - track.points[last], z - track.points[last + 2]) < STEP) continue;
          add(track, x, y, z, strength);
          if (track.count === MARK_POINTS) {
            // Long enough: finish this mark and carry on with a new one from its last point.
            const station = track.station;
            finish(track);
            track.station = station;
            add(track, x, y, z, strength);
            track.station = station; // the first point of a mark does not advance the station
          } else if (track.count - track.drawn >= PIECE_POINTS) {
            track.pieces.push(draw(track, track.drawn, track.count - 1));
            track.drawn = track.count - 1;
          }
        } else if (track.active) {
          // The tyre grips again: the mark fades out where it does.
          const last = (track.count - 1) * POINT_FLOATS;
          if (Math.hypot(x - track.points[last], z - track.points[last + 2]) > 0.05 && track.count < MARK_POINTS) add(track, x, y, z, 0);
          else track.points[last + 3] = 0;
          track.active = false;
          finish(track);
        }
      }
    },

    /** Ends the marks being laid without joining them to where the car is next (a teleport). */
    lift() {
      for (const track of tracks) {
        if (!track.active) continue;
        track.points[(track.count - 1) * POINT_FLOATS + 3] = 0;
        track.active = false;
        finish(track);
      }
    },

    /** Removes every mark (a new drive, or leaving the game). */
    clear() {
      for (const track of tracks) {
        for (const piece of track.pieces) discard(piece);
        track.pieces.length = 0;
        track.count = 0; track.drawn = 0; track.active = false;
      }
      for (const mark of marks) discard(mark);
      marks.length = 0;
    },
  };
}
