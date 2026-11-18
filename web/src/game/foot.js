// On foot: the player outside a car, and the rules for being one of the pedestrians.
//
// The release drives only. That is a real limitation of the street: you cannot go into a shop, cannot leave a
// car where it stands, cannot be a person on the pavement you have been frightening for an hour. This module
// is the walking half of that. It is not a physics character controller — the world's colliders are a mesh
// soup built for a car to drive over, and a body that can be shoved by traffic is not what a walker wants —
// it is the same trick the crowd runs: the walker's own intent, resolved against the world with rays, one per
// direction, once a step. A kerb is a step up; a wall is a wall; a car is something you walk round and, at
// the right height, climb into.
//
// The body itself is the cast's: a person from world/people/cast.js, the same rigged figure the crowd walks
// about, so the player is modelled by the same vendored assets as everybody else and animated by the same
// clips. That is also why `createFoot` is handed the crowd rather than a renderer: the street's shelf of
// bodies can lend the player one and take it back, which costs no upload either way.

import { clamp, lerp, angleDelta, TAU } from '../core/math.js';

/** m/s. A man walks at 1.4; this is a game, so the walk is quick and the run is a jog. */
export const WALK_SPEED = 1.65, RUN_SPEED = 4.4, CROUCH_SPEED = 0.95;
/** Metres: how far a foot is put down before it is refused, and how tall a kerb may be. */
const REACH = 0.42, STEP_UP = 0.24;
/** Metres a floor may be below the feet before it counts as a step rather than a fall. */
const GROUND_SNAP = 0.35;
/** Metres above the floor: the hip a wall is measured at, the chest that steps over it, the eye. */
const HIP = 0.92, CHEST = 1.32, EYE = 1.68;
/** Metres: how close to a car the player has to be to get in, and how far the door puts him out. */
export const BOARD_DISTANCE = 2.4, BOARD_SPEED_LIMIT = 1.5;
/** Stamina: the drain and refill rates, as a fraction of the tank per second. */
const RUN_DRAIN = 1 / 13, RUN_FILL = 1 / 9, RUN_RECOVER = 0.25;
/** The camera hangs this far behind and this far above the feet, pitched down a little. */
const CAM_BACK = 3.4, CAM_UP = 1.45, CAM_PITCH = -0.10;
/** Terminal velocity of a man who steps off a first-floor balcony, m/s, and the fall that hurts. */
const FALL_SPEED = 22, HARD_LAND = 7.5;
/** Metres a down-cast is sent looking for a floor: enough for a fall to be seen coming, short of the sea bed. */
const FALL_DEPTH = 26;

/**
 * @param {{
 *   physics?: object,                 the world; only `raycast(origin, dir, maxDist, exclude)` is used
 *   crowd?: object,                   the street's people: `takePerson`/`handPersonBack` for the player's body
 *   land?: number,                    the street's ground height
 *   height?: number,                  the player's height in metres (the cast's figure is scaled to it)
 *   seed?: number,
 *   onLand?: (y: number, hard: boolean) => void,   footfall, for audio and the shake
 * }} deps
 */
export function createFoot(deps = {}) {
  const physics = deps.physics || null;
  const crowd = deps.crowd || null;
  const land = Number.isFinite(deps.land) ? deps.land : 0;
  /**
   * The lowest the street's own ground can be: the sea. A cast that finds no floor anywhere below the feet
   * is not a floor — past the end of the island the world has nothing under a man and he drops — but the
   * street's level is never below this, so an unstreamed tile is a soft landing and not a hole.
   */
  const underfloor = Number.isFinite(deps.floor) ? deps.floor : -Infinity;
  const height = deps.height || 1.78;
  const onLand = deps.onLand || null;
  const cast = [0, 0, 0], dir = [0, 0, 0], out = [0, 0, 0];

  const foot = {
    /** The body's feet, world metres. Read `foot.pos` in place; it is reused. */
    pos: [0, land, 0],
    vel: [0, 0, 0],
    yaw: 0,
    /** Where the eye is looking, radians. The camera and every bullet follow this, not the legs. */
    look: { yaw: 0, pitch: CAM_PITCH },
    /** 1 run, 0 walk, -1 crouch: a mode that survives a frame of no input, not a held key. */
    gait: 0,
    stamina: 1,
    /** True while the run is locked out by an empty tank (see `step`). */
    out: false,
    /** m/s of ground covered last step — what drives the walk cycle (metres, never seconds: animate.js). */
    moving: 0,
    grounded: true,
    fall: 0,
    /** The cast's body, or null while the models are not loaded. */
    person: null,
    characterIndex: 0,
    wardrobe: 0,
    seed: deps.seed || 0,
    role: null,
    /** A car he could get into (see `step`): distance in metres and which side he is standing on. */
    near: null,
    state: 'idle',            // idle | walk | run | crouch | land
    /** What the down-cast hit: a physics surface kind (see physics/index.js KIND), or -1 for nothing. */
    surface: -1,
    /** Whether the body came off the street's shelf (and so must be given back). */
    borrowed: false,
    turn: 0,

    /** Sets the walker down somewhere: leaving a car, arriving in a room, a new game. */
    place(x, y, z, yaw = 0) {
      foot.pos[0] = x; foot.pos[1] = y; foot.pos[2] = z;
      foot.yaw = yaw; foot.look.yaw = yaw; foot.look.pitch = CAM_PITCH;
      foot.vel[0] = foot.vel[1] = foot.vel[2] = 0;
      foot.moving = 0; foot.grounded = true; foot.fall = 0; foot.near = null;
      if (foot.person) foot.person.place(x, y, z, yaw);
      return foot;
    },

    /**
     * Gives the walker a body. The street's shelf is asked first, because a mesh the renderer already owns is
     * free and a second download of the same GLB is not. No body, no complaint: the pavements have people
     * before the cast finishes loading, and a player walks on invisible legs until it does.
     */
    attach(cast0, renderer, factory = null) {
      if (foot.person || !renderer) return foot.person;
      let person = null;
      if (crowd && crowd.takePerson) person = crowd.takePerson({ character: foot.characterIndex, wardrobe: foot.wardrobe, id: foot.seed });
      if (!person && factory) person = factory(renderer, cast0, foot.characterIndex, { height, wardrobe: foot.wardrobe });
      if (!person) return null;
      foot.person = person;
      foot.borrowed = !!(crowd && crowd.handPersonBack);
      person.place(foot.pos[0], foot.pos[1], foot.pos[2], foot.yaw);
      person.visible(true);
      if (foot.role) person.role(foot.role.name, foot.role.options || {});
      return person;
    },

    /** Puts the body back where it came from — into a car, out of a room, at the end of the session. */
    letGo() {
      const person = foot.person;
      if (!person) return;
      foot.person = null;
      if (foot.borrowed && crowd && crowd.handPersonBack) {
        crowd.handPersonBack({ person, character: foot.characterIndex, wardrobe: foot.wardrobe });
      } else person.remove();
      foot.borrowed = false;
    },

    /**
     * How far along one axis the walker may actually go: the whole of it when the way is free, the length up
     * to the thing in front of him when it is not, and nothing at all when the hip is blocked by a face he
     * cannot step over. A step over it is the same answer the kerb needs, so it is taken here rather than by
     * the caller: `up` says the foot landed on something, and the caller lifts the body by the kerb's height.
     * @param {0|2} axis   X or Z
     * @param {number} want metres along it this step, signed
     */
    clear(axis, want, max = REACH) {
      if (!physics || typeof physics.raycast !== 'function') return { room: want, step: false };
      const len = Math.min(Math.abs(want), max), sign = Math.sign(want);
      const other = axis ? 0 : 2;                       // the axis we are *not* moving along
      cast[axis] = foot.pos[axis]; cast[other] = foot.pos[other];
      cast[1] = foot.pos[1] + HIP;
      dir[axis] = sign; dir[1] = 0; dir[other] = 0;
      const hit = foot.blocked(cast, dir, len);
      // The offer is the step, never more: a ray that finds a wall two streets away is not permission to
      // walk there in one frame. `room` is the step with whatever part of it the obstacle takes away.
      const room = hit < 0 ? len : Math.min(len, Math.max(0, hit - 0.3));
      if (room > 1e-4) return { room: room * sign, step: false };
      if (!foot.grounded) return { room: 0, step: false };
      // Blocked at the hip and clear at the head is a step, not a wall: a kerb, the lip of a drain, a
      // kerbside bollard. The foot goes over it and `step` tells the caller to lift the body with it.
      cast[1] = foot.pos[1] + CHEST + STEP_UP;
      if (foot.blocked(cast, dir, len) >= 0) return { room: 0, step: false };
      return { room: Math.min(len, 0.32) * sign, step: true };
    },

    /**
     * A horizontal cast that answers for one step rather than for the world: the game's `raycast` reports the
     * nearest collider at any distance, and a wall 40 m away is not in the way of a foot going forward half
     * a metre. Returns the distance to the face, or -1 when nothing is inside the step.
     */
    blocked(origin, direction, len) {
      if (!physics || typeof physics.raycast !== 'function') return -1;
      const hit = physics.raycast(origin, direction, len + 0.3, null);
      return hit.hit && hit.dist <= len + 0.3 ? hit.dist : -1;
    },

    /** Plays a clip through the crowd's own role names, so the player and the pavement share a vocabulary. */
    play(name, options = {}) {
      foot.role = name ? { name, options } : null;
      if (foot.person) foot.person.role(name, options);
      return foot;
    },

    /**
     * One step. `intent` is the player's own wish, in the walker's frame; `car` is the player's car, for the
     * one thing a pedestrian must never be — inside it and walking about at the same time.
     * @param {number} dt seconds
     * @param {{forward?: number, strafe?: number, run?: number, crouch?: number, turn?: number, pitch?: number}} intent
     * @param {{x: number, z: number, yaw?: number, speed?: number}|null} [car]
     */
    step(dt, intent = {}, car = null) {
      const f = clamp(intent.forward || 0, -1, 1), s = clamp(intent.strafe || 0, -1, 1);
      const drive = Math.min(1, Math.hypot(f, s));
      const want = intent.run > 0.5 ? 1 : (intent.crouch > 0.5 ? -1 : 0);
      foot.gait = want;
      // An empty tank locks the run out until the wind has properly come back. Without the lock a man
      // sprints at one stride per frame — gait off when the tank reads 0, on again the frame the refill
      // touches it — which is a stutter on the screen and a flicker in the walk cycle.
      if (foot.gait > 0 && (foot.stamina <= 0 || foot.out)) foot.gait = 0;
      // Wind comes back at the same rate whether he stands or walks: tying it to how hard the legs are
      // working means a man who is refused by a wall (moving 0.05 m/s, intent full) never recovers at all.
      foot.stamina = clamp(foot.stamina + (foot.gait > 0 ? -RUN_DRAIN : RUN_FILL) * dt, 0, 1);
      if (foot.stamina <= 0) foot.out = true;
      else if (foot.out && foot.stamina >= RUN_RECOVER) foot.out = false;

      const speed = foot.gait > 0 ? RUN_SPEED : foot.gait < 0 ? CROUCH_SPEED : WALK_SPEED;
      if (drive > 0.02) {
        // The feet turn towards the thumb, at a rate a person could manage: no instant spin, because a
        // body that snaps round has no weight in it.
        const want_yaw = foot.look.yaw + Math.atan2(s, f);   // atan2(right, forward) is the yaw the feet face
        const turn = clamp(angleDelta(foot.yaw, want_yaw), -10 * dt, 10 * dt);
        foot.yaw += turn;
        if (foot.yaw > Math.PI) foot.yaw -= TAU; else if (foot.yaw < -Math.PI) foot.yaw += TAU;
      }
      const sin = Math.sin(foot.yaw), cos = Math.cos(foot.yaw);
      const wish = drive * speed;
      // The renderer's own yaw convention (camera.js): `yaw 0` looks down +Z, and +X is to the right of
      // that. Forward is (sin yaw, cos yaw) and the right hand (cos yaw, -sin yaw); get this wrong and the
      // man walks in circles, because the body turns towards a heading the feet do not share.
      const mx = drive > 0.02 ? (sin * f + cos * s) / Math.hypot(f, s) * wish : 0;
      const mz = drive > 0.02 ? (cos * f - sin * s) / Math.hypot(f, s) * wish : 0;
      void 0;
      // Walkers do not coast: the foot stops when the hand lets go, which is the difference between a
      // person and a shopping trolley.
      const blend = 1 - Math.exp(-14 * dt);
      foot.vel[0] = lerp(foot.vel[0], mx, blend); foot.vel[2] = lerp(foot.vel[2], mz, blend);

      foot.landSeen = foot.state === 'land' || foot.state === 'fall';
      foot.turn = intent.turn || 0;
      foot.look.yaw += foot.turn * dt;
      if (foot.look.yaw > Math.PI) foot.look.yaw -= TAU; else if (foot.look.yaw < -Math.PI) foot.look.yaw += TAU;
      foot.look.pitch = clamp(foot.look.pitch + (intent.pitch || 0) * dt, -0.85, 0.55);

      // Move one axis at a time, refusing what a ray says is not free. The classic and the right answer
      // for a walker: a body pushed diagonally into a wall loses the axis that hits it and keeps the one
      // that does not, which is what sliding along a pavement is, and two casts cost less than eight.
      let moved = 0;
      for (const axis of [0, 2]) {
        const want = (axis ? mz : mx) * dt;
        if (Math.abs(want) < 1e-6) continue;
        const way = foot.clear(axis, want);
        if (way.room !== 0) { foot.pos[axis] += way.room; moved += Math.abs(way.room); }
        if (way.step) foot.pos[1] += STEP_UP;
      }
      foot.moving = moved / Math.max(dt, 1e-4);

      // The ground: whatever the world says is under the chest, and where the street's own floor is if the
      // cast found nothing (a pavement the tiles have not reached yet must not drop the player into the sea).
      let ground = land;
      if (physics && typeof physics.raycast === 'function') {
        // From the chest, downwards: CHEST + 1 of slack so that a kerb 0.2 high is not read as being
        // inside the body, and FALL_DEPTH of air, so that a man who has walked off the end of the island
        // sees the water coming and the tiles that have not streamed yet do not swallow him.
        const from = foot.pos[1] + CHEST;
        cast[0] = foot.pos[0]; cast[1] = from; cast[2] = foot.pos[2];
        const down = physics.raycast(cast, [0, -1, 0], CHEST + 1 + FALL_DEPTH, null);
        if (down.hit) ground = Math.max(underfloor, from - down.dist);
      }
      foot.ground = ground;
      if (foot.pos[1] > ground + GROUND_SNAP) {
        foot.vel[1] = Math.max(-FALL_SPEED, foot.vel[1] - 24 * dt);
        foot.pos[1] += foot.vel[1] * dt;
        foot.grounded = false; foot.fall += dt;
        foot.state = 'fall';
      } else {
        const hard = foot.vel[1] < -HARD_LAND;
        const wasAirborne = !foot.grounded;
        foot.pos[1] = ground; foot.vel[1] = 0; foot.grounded = true;
        if (wasAirborne) { foot.state = 'land'; foot.fall = 0; if (onLand) onLand(ground, hard); }
      }
      // What is beside him. Boarding is offered by the world rather than guessed at by the UI: the car has
      // to be nearly stopped and he has to be at the door side, not under the wheels.
      foot.near = null;
      if (car && Number.isFinite(car.x) && Number.isFinite(car.z)) {
        const dx = foot.pos[0] - car.x, dz = foot.pos[2] - car.z;
        const d = Math.hypot(dx, dz);
        if (d < BOARD_DISTANCE && Math.abs(car.speed || 0) < BOARD_SPEED_LIMIT) {
          const yaw = car.yaw || 0;
          foot.near = { distance: d, side: Math.sin(yaw) * dx + Math.cos(yaw) * dz > 0 ? 1 : -1 };
        }
      }
      // The gait describes the legs, the air describes the body: a man falling with the thumb forward is
      // falling, not walking, and one who has just landed is landing for exactly one frame.
      if (foot.state !== 'land' && foot.state !== 'fall') {
        foot.state = foot.moving > 0.25 ? (foot.gait > 0 ? 'run' : foot.gait < 0 ? 'crouch' : 'walk') : 'idle';
      }

      // The animation is fed metres travelled, so the feet land where the pavement says rather than where
      // the clock says. A stationary player still gets a frame: the pose has to be written at least once.
      if (foot.person) {
        foot.person.place(foot.pos[0], foot.pos[1], foot.pos[2], foot.yaw);
        const role = foot.state === 'run' ? 'run' : foot.state === 'walk' ? 'walk' : null;
        if ((role || foot.role) && role !== (foot.role && foot.role.name)) foot.play(role);
        foot.person.frame(dt, moved);
      }
      return foot;
    },

    /** Where the eye is, for the renderer's camera and the audio listener. */
    eye(target = out) {
      const scale = height / 1.78;
      target[0] = foot.pos[0];
      target[1] = foot.pos[1] + (foot.gait < 0 ? EYE - 0.45 : EYE) * scale;
      target[2] = foot.pos[2];
      return target;
    },
    /** The direction a bullet leaves from: the eye's own, not the feet's. */
    aim(target = [0, 0, 0]) {
      const c = Math.cos(foot.look.pitch);
      target[0] = Math.sin(foot.look.yaw) * c; target[1] = -Math.sin(foot.look.pitch); target[2] = Math.cos(foot.look.yaw) * c;
      return target;
    },
    /**
     * The third-person camera: behind the shoulder, pulled in until the world stops being inside it. A
     * camera that clips through a wall on a pavement is worse than no walking at all, so the same ray that
     * stops the feet is asked here too.
     */
    camera(target = [0, 0, 0]) {
      const scale = height / 1.78;
      let back = CAM_BACK;
      const up = CAM_UP * scale + foot.pos[1] - land;
      if (physics && typeof physics.raycast === 'function') {
        const c = Math.cos(foot.look.pitch);
        const bx = -Math.sin(foot.look.yaw) * c, by = Math.sin(foot.look.pitch), bz = -Math.cos(foot.look.yaw) * c;
        // The eye's own height, because that is where the eye is: a cast from the hip walks the camera
        // straight through a wall over its head. Low furniture is the price, and a shoulder camera that
        // ducked under every kerb would be worse than one that clips a bench.
        cast[0] = foot.pos[0]; cast[1] = foot.pos[1] + EYE * scale; cast[2] = foot.pos[2];
        const hit = physics.raycast(cast, [bx, by, bz], back + 0.35, null);
        if (hit.hit && hit.dist < back) back = Math.max(0.55, hit.dist - 0.35);
      }
      target[0] = foot.pos[0] - Math.sin(foot.look.yaw) * back;
      target[1] = foot.pos[1] + EYE * scale + up * 0.12 + back * Math.sin(-foot.look.pitch);
      target[2] = foot.pos[2] - Math.cos(foot.look.yaw) * back;
      return target;
    },
    snapshot() {
      return {
        state: foot.state, gait: foot.gait, stamina: foot.stamina, moving: foot.moving,
        pos: [foot.pos[0], foot.pos[1], foot.pos[2]], yaw: foot.yaw, grounded: foot.grounded,
        near: foot.near ? Math.round(foot.near.distance * 100) / 100 : null, out: foot.out,
        body: !!foot.person, borrowed: foot.borrowed, surface: foot.surface,
      };
    },
  };
  return foot;
}
