// The criminal system's back half: what happens after the handcuffs.
//
// An arrest is not a fine any more. It is a cell in the yard behind the nearest police landmark,
// a bail figure that scales with the stars you arrived with, and two doors out of it: the honest
// one (pay the bail, walk out the front steps, the record waiting for court) and the other one
// (hold Space against the bars while a guard walks his loop, and go over the wall with the whole
// city looking). The guard is a point on a lissajous in the yard, which is exactly as much guard
// as a yard this size needs: he sees the bars move when he is close, and when he sees them the
// work is lost and the bail goes up, because a bent bar is a conversation with a judge.
//
// Everything the cell touches is injected — purse, ledger, feet, camera, audio, the toast voice —
// so the whole thing is testable with fakes and none of it reaches into the game behind its back.

/** Dollars of bail per star you were carrying when they closed the door. */
export const BAIL_PER_STAR = 400;
/** Seconds of held breathing against the bars before they give. */
export const ESCAPE_SECONDS = 9;
/** How close the guard can be and still catch the bars moving. */
export const GUARD_SEE = 7;
/** What a caught attempt adds to the bail: the bar is bent now, and bent bars are evidence. */
export const GUARD_PENALTY = 150;

/**
 * @param {{purse?: object, wanted?: object, foot?: object, camera?: object, audio?: object,
 *          toast?: (t: string) => void, plan?: object}} deps
 */
export function createJail({ purse = null, wanted = null, foot = null, camera = null, audio = null, toast = () => {}, plan = null } = {}) {
  const mark = ((plan && plan.landmarks) || []).find((m) => String(m.kind || '').startsWith('police'));
  const hx = mark ? mark.x : 0, hz = mark ? mark.z : 0, hyaw = mark ? mark.yaw : 0;
  const fwd = [Math.sin(hyaw), Math.cos(hyaw)];
  const right = [Math.cos(hyaw), -Math.sin(hyaw)];
  // The yard is behind the house, six metres off its spine; the steps out front are the honest door.
  const cell = [hx - fwd[0] * 12 + right[0] * 6, 0, hz - fwd[1] * 12 + right[1] * 6];
  const gate = [hx + fwd[0] * 16, 0, hz + fwd[1] * 16];
  const wall = [hx - fwd[0] * 26 + right[0] * 6, 0, hz - fwd[1] * 26 + right[1] * 6];

  let state = 'free';
  let bail = 0, escape = 0, guardT = 0, guardNear = false;

  const put = (p, yaw) => { if (foot && foot.place) foot.place(p[0], p[1], p[2], yaw); if (camera && camera.snap) camera.snap(); };

  const jail = {
    get jailed() { return state === 'jailed'; },
    get bail() { return bail; },
    /** 0..1 of the way through the bars. */
    get escape() { return escape; },
    get guardNear() { return guardNear; },
    /** Where the cell, the steps and the wall are, for anyone who wants to draw them. */
    get site() { return { cell, gate, wall }; },

    /**
     * The door closes. Stars are what the bail is priced from; the ledger empties because a man in
     * a cell is not a man the street is currently chasing.
     * @returns {boolean} true if this call is the one that put him inside
     */
    bust(stars) {
      if (state === 'jailed') return false;
      state = 'jailed';
      bail = BAIL_PER_STAR * Math.max(1, stars | 0);
      escape = 0; guardT = 0; guardNear = false;
      if (wanted && wanted.clear) wanted.clear();
      put(cell, hyaw);
      if (audio && audio.door) audio.door(true);
      toast(`Busted · bail is $${bail}, or the wall is free`);
      return true;
    },

    /**
     * One step of custody.
     * @param {number} dt    seconds
     * @param {boolean} held whether the player is holding the bars (Space)
     * @returns {'escaped'|null}
     */
    step(dt, held) {
      if (state !== 'jailed') return null;
      guardT += dt;
      const gx = cell[0] + Math.sin(guardT * 0.35) * 8;
      const gz = cell[2] + Math.cos(guardT * 0.22) * 5;
      guardNear = foot ? Math.hypot(gx - foot.pos[0], gz - foot.pos[2]) < GUARD_SEE : false;
      if (held) {
        escape += dt / ESCAPE_SECONDS;
        if (guardNear) {
          escape = 0;
          bail += GUARD_PENALTY;
          toast(`A guard saw the bars move · bail is $${bail} now`);
          return null;
        }
        if (escape >= 1) {
          state = 'free';
          put(wall, hyaw + Math.PI);
          if (wanted && wanted.add) wanted.add('jail break', 3);
          if (audio && audio.door) audio.door(true);
          toast('Over the wall · the whole city is looking now');
          return 'escaped';
        }
        return null;
      }
      // Let go and the bars spring back, half as fast as they bent.
      escape = Math.max(0, escape - dt / (ESCAPE_SECONDS * 2));
      return null;
    },

    /** The honest door. @returns {boolean} true if the purse carried it */
    payBail() {
      if (state !== 'jailed') return false;
      if (!purse || purse.cash < bail) { toast(`Bail is $${bail} · the purse says no`); return false; }
      purse.lose(bail, 'bail');
      state = 'free';
      escape = 0;
      if (wanted && wanted.clear) wanted.clear();
      put(gate, hyaw);
      toast(`Bail paid · $${bail}, and the record waits for court`);
      return true;
    },

    snapshot() { return { jailed: state === 'jailed', bail, escape, guardNear }; },
  };
  return jail;
}
