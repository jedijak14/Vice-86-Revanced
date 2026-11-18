// A shop's room as the game runs it: the set (world/shops/interior.js) baked into the world where its lot
// stands, its lamps in the frame's light list, and the box a man is kept inside.
//
// There is no turntable and no door that rises — the garage has those because a car is on show in it
// (showroom.js). A shop's room is built on the way in and taken away on the way out, which is the whole of
// its life: the street outside is never asked to know about it, and the `interior` flag on every part is what
// keeps the room out of the frames the street draws.
//
// The room is placed by building it there rather than by moving it: the renderer's static instances carry an
// origin but no rotation, so `buildShopSet` turns the vertices, the lamps and the anchors by the lot's own
// yaw in one go. What the counter and the till are, and how far a man has to reach, is game/shops.js's
// business; this file only puts them somewhere the camera can find.
//
// Known limit, stated rather than hidden: the counter is drawn and is not solid. The room's walls are the
// only collision here, so a man can back into the till through the top of it. Making the fittings into
// colliders means the interior set carrying a collider list of its own, which it does not yet.

import { ROOM, buildShopSet, lightRecords, glowRecords } from '../world/shops/interior.js';

/** The parts of the set, and whether each one throws a shadow (the ceiling light is above them all). */
const PARTS = Object.freeze({ floor: false, shell: true, fittings: true, sign: false });

/**
 * @param {{renderer: object}} deps
 * @param {object} deps.renderer  the frame's renderer, for meshes and static instances
 */
export function createShopRoom({ renderer }) {
  const meshes = [], statics = [];
  let set = null, shop = null;
  let records = null, groups = null, glows = null, budget = -1;

  const shopRoom = {
    /** frame.room for the renderer, or null while the street is showing. */
    room: null,
    /** World height of the floor, and where the room's reflections are captured from. */
    floorY: 0,
    probe: [0, 0, 0],
    get ready() { return !!set; },
    get shop() { return shop; },
    /** The set as it stands in the world: anchors, bounds, and the way back into the room's frame. */
    get set() { return set; },

    /**
     * Puts a shop's room up behind its door. The room is stood so that its own doorway lands on the point in
     * the pavement the street sent him to (`shop.x, shop.z`), which is the one place the two frames have to
     * agree: cross it either way and the man is where the world says he is. The lot's shape is not the
     * room's shape — a room is a room — so the walls are set back from the building's, and the shopfront is
     * the storefront the tile drew.
     * @param {object} atShop   a game/shops.js shop record: {x, z, yaw, kind, sign}
     * @param {number} floorY   world height of the ground the lot stands on
     * @returns {boolean} false when there was no door to stand the room at
     */
    enter(atShop, floorY = 0) {
      shopRoom.leave();
      if (!atShop || !Number.isFinite(atShop.x) || !Number.isFinite(atShop.z)) return false;
      const yaw = Number.isFinite(atShop.yaw) ? atShop.yaw : 0;
      const back = ROOM.depth / 2 + ROOM.wall;
      set = buildShopSet({
        sign: atShop.sign, palette: atShop.kind, yaw,
        at: [atShop.x - Math.sin(yaw) * back, floorY, atShop.z - Math.cos(yaw) * back],
      });
      for (const name in PARTS) {
        const data = set.meshes[name];
        if (!data || !data.indexCount) continue;
        const mesh = renderer.createMesh(data);
        meshes.push(mesh);
        statics.push(renderer.addStatic({ mesh, castShadow: PARTS[name], interior: true }));
      }
      const a = set.anchors;
      // The renderer's room box is in world numbers: it is what the room's shadow map is fitted to, what
      // decides which casters are inside the walls, and what the haze is bounded by (render/lightstate.js
      // `_renderRoomShadow`). The anchors' own box is in the room's frame, because the room is built turned
      // and placed rather than moved (see the header). Handing over the unplaced one puts a room at the origin
      // with a man standing 963 metres away in it: nothing is inside the box, so nothing is lit, and a closed
      // room that culls the street is a black screen. `set.bounds` is the placed version of the same box.
      shopRoom.room = {
        min: set.bounds.slice(0, 3), max: set.bounds.slice(3, 6), version: 0,
        // Already placed, like the box: `interior.js` turns and moves the light box with the geometry.
        lightBox: {
          centre: a.lightBox.centre.slice(), u: a.lightBox.u.slice(), v: a.lightBox.v.slice(),
          radiance: a.lightBox.radiance.slice(),
        },
        ambient: a.look.ambient.slice(), haze: a.look.haze,
      };
      shopRoom.floorY = floorY;
      shopRoom.probe = a.probe.slice();
      shop = atShop;
      budget = -1;
      return true;
    },

    /**
     * The room's lamps, after whatever the street had already written into the frame.
     * @param {object} lamps  the frame's LampBuffer
     * @param {number} limit  light records the renderer takes in an interior frame
     */
    writeLights(lamps, limit) {
      if (!set) return;
      if (limit !== budget) {
        budget = limit;
        // Already placed in the world by the builder, so the records are asked for with no translation.
        const made = lightRecords(set, Math.max(limit, 0), [0, 0, 0]);
        records = made.records; groups = made.groups;
        glows = glowRecords(set, [0, 0, 0]);
      }
      lamps.lightCount = Math.min(lamps.lightCount, Math.max(0, limit - groups.length));
      for (let i = 0; i < groups.length; i++) lamps.lightRecord(records, i, 1);
      lamps.glowRecords(glows, 1);
    },

    /**
     * A man inside the room, kept inside the room: the walls are drawn, and here they are also the rule.
     * @param {number[]} pos  the walker's position, moved in place
     * @param {number} radius  how near a wall he may get (his own body)
     * @returns {boolean} true if a wall stopped him
     */
    confine(pos, radius = 0.34) {
      if (!set) return false;
      const b = set.bounds;
      let touched = false;
      for (const k of [0, 2]) {
        const lo = b[k] + radius, hi = b[k + 3] - radius;
        if (hi <= lo) continue;                      // a room thinner than the man: let him stand in it
        if (pos[k] < lo) { pos[k] = lo; touched = true; }
        else if (pos[k] > hi) { pos[k] = hi; touched = true; }
      }
      return touched;
    },

    /** The door, from the inside: where a man leaving the room is put on the pavement. */
    doorstep(out = [0, 0, 0]) {
      const a = set && set.anchors;
      if (!a) return null;
      out[0] = a.door[0]; out[1] = shopRoom.floorY; out[2] = a.door[2];
      return out;
    },

    /** Takes the room down again. Safe to call when there was never one. */
    leave() {
      for (const id of statics) { if (renderer.remove) renderer.remove(id); }
      statics.length = 0;
      for (const mesh of meshes) { if (renderer.destroyMesh) renderer.destroyMesh(mesh); }
      meshes.length = 0;
      set = null; shop = null; records = null; groups = null; glows = null;
      shopRoom.room = null;
    },
  };
  return shopRoom;
}
