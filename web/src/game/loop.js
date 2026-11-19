// Timekeeping: a fixed-step accumulator for the simulation and a frame pacer for the display.
//
// The simulation (physics, traffic) advances in whole 120 Hz steps. A display frame is rarely a
// whole number of steps, so the remainder is carried over and reported as `alpha`, the position
// of the render time between the last two simulated states. Everything drawn is interpolated
// with it, which is what keeps motion smooth on 50, 60, 144 and 240 Hz screens alike.
//
// The game owns this accumulator (rather than leaving it inside the physics module) because it
// has to know the step count before it steps: traffic drivers integrate over exactly the same
// interval and hand their end-of-interval poses to physics.

export const FIXED_DT = 1 / 120;

/** Most steps taken for one frame. Below 12 frames per second the game slows down instead of spiralling. */
export const MAX_STEPS_PER_FRAME = 10;

/**
 * A frame longer than this was not a slow frame but a suspended tab, a debugger stop or a system sleep.
 *
 * It used to be 0.25 s, and that turned a slow machine into a stopped one: below four frames a second every
 * frame looked like a suspension, so the game was handed 1/60 of a second for a frame that took a quarter of
 * one, and the street ran at a twentieth of real time — measured, not imagined, on a 3.75 fps software boot
 * where the game drew 16 frames in 66 seconds and the street clock moved by half a second. A device that is
 * merely slow must be allowed to be slow: `MAX_FRAME_DT` and the step cap below are what keep a long frame
 * from teleporting the world, and they already do that job at any rate. So the threshold has to sit well
 * above what a struggling GPU can take a single frame to draw, and only mean "nobody was watching".
 */
export const SUSPEND_THRESHOLD = 2;
/** Simulated time granted to the first frame after a suspension. */
export const RESUME_DT = 1 / 60;
/** Longest frame time passed on to cameras and effects. */
export const MAX_FRAME_DT = 0.1;
/** How early, at most, a capped frame may be shown: the jitter of display timestamps. */
const CAP_TOLERANCE = 0.0015;

export class FixedStepper {
  /**
   * @param {number} [fixedDt]   step length, seconds
   * @param {number} [maxSteps]  cap on steps per advance; time beyond it is dropped, not queued
   */
  constructor(fixedDt = FIXED_DT, maxSteps = MAX_STEPS_PER_FRAME) {
    this.fixedDt = fixedDt;
    this.maxSteps = maxSteps;
    /** Fraction of a step by which the render time is ahead of the last simulated state, 0..1. */
    this.alpha = 0;
    /** Total steps taken since the last reset. */
    this.steps = 0;
    this._acc = 0;
  }

  /**
   * Adds `dt` seconds and returns how many fixed steps are now due.
   * @param {number} dt  seconds, >= 0
   * @returns {number}
   */
  advance(dt) {
    if (!(dt > 0)) return 0;
    const h = this.fixedDt;
    this._acc += dt;
    // The small bias keeps a frame that is an exact multiple of the step (60 Hz = 2 steps)
    // from alternating between n - 1 and n + 1 because of rounding.
    let n = Math.floor(this._acc / h + 1e-6);
    if (n > this.maxSteps) {
      // Drop whole steps only. Keeping the fraction keeps the interpolation phase continuous.
      this._acc -= (n - this.maxSteps) * h;
      n = this.maxSteps;
    }
    this._acc -= n * h;
    if (this._acc < 0) this._acc = 0;
    this.alpha = Math.min(this._acc / h, 1);
    this.steps += n;
    return n;
  }

  /** Simulated seconds since the last reset. */
  get time() {
    return this.steps * this.fixedDt;
  }

  reset() {
    this._acc = 0;
    this.alpha = 0;
    this.steps = 0;
  }
}

/**
 * Turns raw frame timestamps into frame deltas: measures, removes suspensions, applies the
 * frame cap and the pause state. It does not schedule anything itself, so it runs the same
 * under requestAnimationFrame and under a test that feeds timestamps.
 */
export class FramePacer {
  constructor() {
    this.paused = false;
    /** 0 = uncapped, otherwise frames per second. */
    this.frameCap = 0;
    /** Unclamped duration of the last presented frame in milliseconds, for statistics. */
    this.lastFrameMs = 0;
    /** True on the first frame after a suspension, so the game can skip history-based effects. */
    this.resumed = false;
    this._last = -1;
    /** When the next capped frame is due, seconds. */
    this._due = 0;
  }

  /**
   * Call once per display refresh with a monotonic time in seconds.
   * @returns {number} frame delta in seconds for cameras and effects, or -1 if this refresh
   *                   should be skipped because of the frame cap
   */
  frame(now) {
    if (this._last < 0) {
      this._last = now;
      this._due = now + (this.frameCap > 0 ? 1 / this.frameCap : 0);
      this.lastFrameMs = RESUME_DT * 1000;
      return RESUME_DT;
    }
    let dt = now - this._last;
    if (this.frameCap > 0) {
      // Capped frames follow a schedule rather than a minimum gap: a gap test drops every
      // other refresh when the cap equals the display rate and the timestamps jitter, and
      // drifts below the cap on displays that are not a multiple of it.
      const interval = 1 / this.frameCap;
      if (dt >= 0 && now < this._due - Math.min(CAP_TOLERANCE, interval * 0.25)) return -1;
      // After a stall (or a clock that went backwards) the schedule restarts from now instead
      // of bursting to catch up.
      this._due = dt < 0 || now - this._due > interval ? now + interval : this._due + interval;
    }
    this._last = now;
    this.lastFrameMs = dt * 1000;
    this.resumed = dt > SUSPEND_THRESHOLD || dt < 0;
    if (this.resumed) dt = RESUME_DT;
    return dt > MAX_FRAME_DT ? MAX_FRAME_DT : dt;
  }

  /** Forget the last timestamp: the next frame starts a fresh measurement (after a long blocking operation). */
  restart() {
    this._last = -1;
  }
}

/**
 * Drives a frame callback from requestAnimationFrame.
 * @param {{ requestFrame: (cb: (ms: number) => void) => number, cancelFrame: (id: number) => void }} host
 * @param {FramePacer} pacer
 * @param {(dt: number) => void} onFrame   receives the paced frame delta in seconds
 * @param {(error: Error) => void} onError called once if a frame throws; the loop then stops
 */
export function runFrameLoop(host, pacer, onFrame, onError) {
  let id = 0;
  let running = true;
  const tick = (ms) => {
    if (!running) return;
    id = host.requestFrame(tick);
    const dt = pacer.frame(ms / 1000);
    if (dt < 0) return;
    try {
      onFrame(dt);
    } catch (error) {
      running = false;
      host.cancelFrame(id);
      onError(error);
    }
  };
  id = host.requestFrame(tick);
  return {
    stop() {
      running = false;
      host.cancelFrame(id);
    },
  };
}
