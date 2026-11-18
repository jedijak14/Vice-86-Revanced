// How the game keeps time on a machine that cannot keep up. These two classes decide what a slow device
// actually experiences — how much of the street a frame gets, and when a long frame is treated as nobody
// watching — so they are worth pinning down rather than trusting to a soak that takes ten minutes to say
// "the pedestrian moved at a twentieth speed". The number under test is not elegance; it is the difference
// between a low frame rate and a game that has quietly stopped.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT, MAX_STEPS_PER_FRAME, FramePacer, FixedStepper, runFrameLoop,
  SUSPEND_THRESHOLD, RESUME_DT, MAX_FRAME_DT,
} from '../../web/src/game/loop.js';

test('a slow frame is a slow frame, not a suspended tab', () => {
  // A struggling GPU can take a third of a second to draw one frame. That is not the tab being hidden, and
  // the pacer must not hand the game a single 60 Hz tick for it, or the whole street runs in slow motion.
  const pacer = new FramePacer();
  pacer.frame(0);                       // first frame: nothing to measure against
  const dt = pacer.frame(0.33);
  assert.ok(pacer.resumed === false, 'a 330 ms frame is not a suspension');
  assert.equal(dt, MAX_FRAME_DT, 'it is capped instead, which is what stops the world teleporting');
  assert.ok(pacer.lastFrameMs > 300, 'and the real duration is still reported for anything that waits on it');
});

test('a frame that is missing is a suspension, and the world is not teleported across it', () => {
  const pacer = new FramePacer();
  pacer.frame(0);
  pacer.frame(1);
  const after = pacer.frame(1 + SUSPEND_THRESHOLD + 30);      // alt-tabbed for half a minute
  assert.equal(pacer.resumed, true);
  assert.equal(after, RESUME_DT, 'the first frame back is one tick, not thirty seconds of physics');
  const next = pacer.frame(1 + SUSPEND_THRESHOLD + 30.2);      // 0.2 s later: a real frame, a long one
  assert.equal(pacer.resumed, false, 'and it is measured as a frame, not as another suspension');
  assert.equal(next, MAX_FRAME_DT, 'clamped, which is the whole of the protection it needs');
});

test('the step cap slows the game down rather than letting it spiral', () => {
  const stepper = new FixedStepper();
  const oneFrame = stepper.advance(10);                       // ten seconds handed over at once
  assert.equal(oneFrame, MAX_STEPS_PER_FRAME, 'at most the cap of steps is taken for a frame');
  assert.equal(stepper.time, MAX_STEPS_PER_FRAME * FIXED_DT, 'the rest is dropped, not queued up to be repaid');
  assert.equal(stepper.advance(0), 0, 'no time, no steps');
});

test('the step count is a whole number of steps and the remainder becomes alpha', () => {
  const stepper = new FixedStepper(1 / 120, 10);
  assert.equal(stepper.advance(1 / 60), 2, 'a 60 Hz frame is two 120 Hz steps');
  assert.equal(stepper.alpha, 0, 'exactly: nothing left over');
  stepper.reset();
  const steps = stepper.advance(1 / 100);                     // 1.2 steps
  assert.equal(steps, 1);
  assert.ok(stepper.alpha > 0.15 && stepper.alpha < 0.25, `the tenth of a second left over is the render phase (${stepper.alpha})`);
});

test('the frame cap skips refreshes it is not due for, and does not drift', () => {
  const pacer = new FramePacer();
  pacer.frameCap = 30;
  pacer.frame(0);
  assert.equal(pacer.frame(0.005), -1, '16 ms after a 33 ms frame was due, this refresh is not it');
  const due = pacer.frame(0.034);
  assert.ok(due > 0, 'at the schedule, it is');
  // A display faster than the cap must not turn the schedule into a ratchet: after a stall the schedule
  // restarts from now instead of trying to catch up on every frame it missed.
  pacer.frame(5);                                              // the frame after a five second gap
  assert.equal(pacer.frame(5.01), -1, 'the next refresh is early for the restarted schedule');
  assert.ok(pacer.frame(5.05) > 0, 'and the one after it is let through, at its real length');
});

test('a frame that throws stops the loop and is reported once', () => {
  // The loop's contract with the boot code: one error to the loading screen, and no second attempt at a
  // frame that already failed — an error dialog that repaints sixty times a second is not a diagnosis.
  let queued = null, cancelled = 0;
  const host = { requestFrame: (cb) => { queued = cb; return 7; }, cancelFrame: () => { cancelled++; } };
  const seen = [];
  runFrameLoop(host, new FramePacer(), () => { seen.push('frame'); throw new Error('a bad pass'); }, (error) => seen.push(error.message));
  queued(0);
  assert.deepEqual(seen, ['frame', 'a bad pass']);
  queued(0.5);
  assert.deepEqual(seen, ['frame', 'a bad pass'], 'the loop is done asking');
  assert.ok(cancelled > 0, 'and it cancelled the refresh it had already queued');
});

