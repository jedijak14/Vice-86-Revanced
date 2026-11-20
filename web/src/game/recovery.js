// What the game does while the graphics card is away, and when it comes back.
//
// A WebGL context is lost when the driver resets itself -- on Windows a TDR, which is what takes the
// picture away under Electron's Direct3D -- and the browser says so with `webglcontextlost`, then, if
// the card recovers, with `webglcontextrestored`. The renderer rebuilds its own objects between the two
// and reports both ends (render/index.js: onLost, onRestored).
//
// There are two waits here and not one, because they fail for different reasons and take different
// lengths of time:
//
//   * waiting for the card covers the driver's own recovery, which ends the moment the browser fires
//     `webglcontextrestored`. It is bounded by the card and the driver, and on a machine that was
//     already struggling it is routinely several seconds.
//   * waiting for the rebuild covers the renderer re-uploading every mesh the city kept afterwards.
//     That is bounded by the size of the world, and it is not the card still missing.
//
// Charging the rebuild to the card's allowance is the mistake this module exists to prevent: the deadline
// used to be armed once, on the loss, and cleared only on the last line of the renderer's rebuild, so a
// card that came back and was busy rebuilding the street was reported to the player as a card that never
// came back at all. A recoverable driver reset read as a fatal 3D graphics failure.
//
// Both waits are nets for a picture that never returns, not a race the graphics card is expected to win.

/** Which wait failed, in the words the player reads. */
export const WAIT_CARD = 'waiting for the graphics card to come back';
export const WAIT_REBUILD = 'rebuilding the picture after the graphics card came back';

/**
 * How long the driver's recovery may take before the game gives up. It has to cover a slow recovery
 * rather than a typical one, because too short a wait reports a card that is coming back as one that
 * never did.
 */
export const CARD_MS = 30000;

/** How long the renderer's own rebuild may take once the context is back. */
export const REBUILD_MS = 20000;

/**
 * @param {object} deps
 * @param {{setTimeout: Function, clearTimeout: Function}} deps.timers  the window's
 * @param {(error: Error, what: string) => void} deps.report  the fatal report, given which wait failed
 * @param {() => Error} deps.message  what to report: the context loss, with the last shader named
 * @param {{phase: {name: string}, pause: Function, resume: Function}} deps.game
 * @param {{paused: boolean, restart: Function}} deps.pacer
 * @returns {{lost: Function, restoring: Function, restored: Function}} the renderer's three callbacks
 */
export function createContextRecovery({ timers, report, message, game, pacer }) {
  let timer = 0;
  // Whether this loss is what paused the drive. `pause()` only takes from 'driving', so 'garage' and
  // 'title' are left as they are -- and resuming blindly on the way back would put a player who was
  // standing in the showroom out on the street, because 'garage' to 'driving' is an allowed move.
  let pausedByLoss = false;

  /** Arms the fatal report, replacing any wait already running: only one is ever outstanding. */
  const waitOn = (ms, what) => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer = 0; report(message(), what); }, ms);
  };

  return {
    /** Whether the loss paused a drive the recovery is expected to hand back. */
    get pausedByLoss() { return pausedByLoss; },
    /** Whether a wait is armed: a fatal report is pending if the next stage does not arrive. */
    get waiting() { return timer !== 0; },

    lost() {
      pacer.paused = true;                       // stop asking for frames while the card is away
      // Sticky across repeated losses: a second reset during the recovery finds the drive already
      // paused by the first, and re-reading the phase then would forget that the loss is what paused
      // it, so the drive would never be handed back at all.
      if (game.phase.name === 'driving') pausedByLoss = true;
      game.pause();
      waitOn(CARD_MS, WAIT_CARD);
    },

    /** The context is back; the renderer is now rebuilding the picture, which is a different wait. */
    restoring() {
      waitOn(REBUILD_MS, WAIT_REBUILD);
    },

    restored() {
      timers.clearTimeout(timer); timer = 0;
      pacer.paused = false; pacer.restart();
      // The drive the loss interrupted carries on where it stopped; a pause of the player's own is
      // theirs to lift, and a showroom or a title screen was never paused by this at all.
      if (pausedByLoss) { pausedByLoss = false; game.resume(); }
    },
  };
}
