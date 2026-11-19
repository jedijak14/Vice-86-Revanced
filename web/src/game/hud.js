// The HUD feed: what the driving HUD shows each frame, and the minimap painter.
//
// The UI owns the look of the HUD; this file only hands it values. The district is looked up
// a few times a second rather than every frame, because it only changes every few hundred
// metres and the lookup walks the plan's district outlines.

import { lerp, smoothstep } from '../core/math.js';

const DISTRICT_INTERVAL = 0.4; // s between district lookups
// Ground distance across the painted square, at rest and at speed. The UI's canvas overhangs the
// visible disc by about a sixth, so the disc itself shows roughly 250 m and 440 m.
const MAP_METRES = 300, MAP_METRES_FAST = 520;
const MAP_ZOOM_HALF_LIFE = 0.8; // s

/**
 * @param {{ui: object, world: object}} deps
 */
export function createHudFeed({ ui, world }) {
  const values = {
    speed: 0, rpm: 0, redline: 1, gear: 1, headlamps: false, handbrake: false, clock: 0,
    district: '', heading: 0, position: [0, 0, 0], nitrous: 1, boosting: false,
    /** The four lines the street writes: what the police are doing, what you owe them, and the two
     *  jobs in hand. Read in place by the HUD's view model (any of them may be null). */
    police: null,
    wanted: null,
    race: null,
    mission: null,
    net: null,
    purse: null,
    foot: null,
    flight: null,
    jail: null,
    watch: null,
    radio: null,
    voice: null,
  };
  let districtTimer = 0;
  let metres = MAP_METRES;

  /**
   * Painter given to the UI: the world's map as a square centred on the car, forward up. The UI
   * clips it to the disc and draws the car's marker over it.
   */
  function paintMinimap(ctx, sizePx) {
    world.drawMinimap(ctx, values.position[0], values.position[2], values.heading, metres, sizePx);
  }

  if (typeof world.drawMinimap === 'function') ui.setMinimapPainter(paintMinimap);

  return {
    values,

    /** The district name under the car right now ('' outside every district). */
    get district() { return values.district; },

    /**
     * @param {number} dt
     * @param {object} player   from createPlayer
     * @param {number} hours    time of day
     * @param {number} handbrake  0..1 as applied
     * @param {{level: number, boosting: boolean}} nitrous
     * @param {object|null} status  what the street is saying: the dispatch's status, the wanted
     *   record, and the job and race in hand (game/game.js builds it; see ui/hud-model.js for the
     *   fields). Every one of them may be missing, and the HUD draws an empty line for that.
     */
    update(dt, player, hours, handbrake, nitrous, status) {
      const vehicle = player.vehicle;
      values.speed = Math.abs(vehicle.speed);
      values.rpm = vehicle.rpm;
      values.redline = vehicle.redline;
      values.gear = vehicle.gear;
      values.headlamps = player.headlampsOn;
      values.handbrake = handbrake > 0.5;
      values.clock = hours;
      values.heading = player.yaw;
      values.position[0] = player.pos[0]; values.position[1] = player.pos[1]; values.position[2] = player.pos[2];
      values.nitrous = nitrous.level;
      values.boosting = nitrous.boosting;
      // The status object is passed out field by field, not whole: the HUD's view model looks for
      // `input.police`, `input.wanted` and the rest beside it, and handing it the bag they came in
      // leaves every one of those lines empty — a wanted level the driver cannot see is a feature
      // that does not exist, however correct the ledger behind it is.
      values.police = (status && status.police) || null;
      values.wanted = (status && status.wanted) || null;
      values.race = (status && status.race) || null;
      values.mission = (status && status.mission) || null;
      values.net = (status && status.net) || null;
      values.purse = (status && status.purse) || null;
      values.foot = (status && status.foot) || null;
      // The instruments of whatever he is riding that is not a car: an aeroplane or a motorcycle.
      values.flight = (status && status.flight) || null;
      // The rest of what the street writes: custody, the eyes on you, the dial, and the line
      // somebody on the pavement is saying out loud (audio/voice.js).
      values.jail = (status && status.jail) || null;
      values.watch = (status && status.watch) || null;
      values.radio = (status && status.radio) || null;
      values.voice = (status && status.voice) || null;
      districtTimer -= dt;
      if (districtTimer <= 0) {
        districtTimer = DISTRICT_INTERVAL;
        values.district = (typeof world.districtAt === 'function' && world.districtAt(player.pos[0], player.pos[2])) || '';
      }
      // See further ahead on the map when travelling fast.
      const wanted = lerp(MAP_METRES, MAP_METRES_FAST, smoothstep(15, 60, values.speed));
      metres = wanted + (metres - wanted) * Math.pow(0.5, dt / MAP_ZOOM_HALF_LIFE);
      ui.hud.update(values);
    },
  };
}
