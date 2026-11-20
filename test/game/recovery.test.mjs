// What the game does while the graphics card is away, and when it comes back.
//
// The bug this pins: the deadline used to be armed once, when the context was lost, and cleared only on
// the last line of the renderer's rebuild -- so the driver's recovery and the re-upload of the whole city
// were charged to one five-second allowance between them. On Windows a driver reset (a TDR) alone can
// take longer than that, and a card which came back and was busy rebuilding the street was reported to
// the player as a card that never came back at all. A recoverable reset read as a fatal 3D graphics
// failure, intermittently, and with no way to see it from a test until the two waits were separated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createContextRecovery, CARD_MS, REBUILD_MS, WAIT_CARD, WAIT_REBUILD,
} from '../../web/src/game/recovery.js';

/** Timers the test advances by hand, so a wait of thirty seconds costs nothing. */
function fakeTimers() {
  let now = 0, next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {                       // a callback may arm another timer, which may also be due
        let due = null;
        for (const [id, entry] of pending) if (entry.at <= target && (!due || entry.at < due.entry.at)) due = { id, entry };
        if (!due) break;
        pending.delete(due.id); now = due.entry.at; due.entry.fn();
      }
      now = target;
    },
    get outstanding() { return pending.size; },
  };
}

/** `pause()` only takes from 'driving', as the real one does (game/state.js: ALLOWED). */
function fakeGame(name = 'driving') {
  const game = {
    calls: [],
    phase: { name },
    pause() { game.calls.push('pause'); if (game.phase.name === 'driving') game.phase.name = 'paused'; },
    resume() { game.calls.push('resume'); if (game.phase.name === 'paused') game.phase.name = 'driving'; },
  };
  return game;
}

function harness(phase = 'driving') {
  const timers = fakeTimers();
  const reports = [];
  const game = fakeGame(phase);
  const pacer = { paused: false, restarts: 0, restart() { pacer.restarts++; } };
  const recovery = createContextRecovery({
    timers,
    report: (error, what) => reports.push({ message: error.message, what }),
    message: () => new Error('The WebGL context was lost. Last shader program compiled or first drawn: vehicle.gbuffer.'),
    game,
    pacer,
  });
  return { timers, reports, game, pacer, recovery };
}

/** The whole of a recovery: the card goes away, comes back, and the renderer rebuilds the picture. */
const fullRecovery = (h, cardMs, rebuildMs) => {
  h.recovery.lost();
  h.timers.advance(cardMs);
  h.recovery.restoring();
  h.timers.advance(rebuildMs);
  h.recovery.restored();
};

test('a slow driver reset followed by a slow rebuild recovers, and is not reported as a failure', () => {
  const h = harness();
  // Nine seconds for the card and nine for the rebuild: eighteen in all, which the old single
  // five-second allowance would have called a card that never came back.
  fullRecovery(h, 9000, 9000);

  assert.deepEqual(h.reports, [], 'a card that came back must not be reported as one that did not');
  assert.equal(h.pacer.paused, false, 'frames are asked for again');
  assert.equal(h.pacer.restarts, 1, 'the schedule restarts from now rather than bursting to catch up');
  assert.deepEqual(h.game.calls, ['pause', 'resume']);
  assert.equal(h.game.phase.name, 'driving', 'the drive the loss interrupted carries on');
  assert.equal(h.timers.outstanding, 0, 'no wait is left armed');
});

test('the rebuild is not charged to the card\'s allowance', () => {
  const h = harness();
  h.recovery.lost();
  h.timers.advance(CARD_MS - 1000);
  h.recovery.restoring();                    // the card is back with a second of its allowance unused
  // The rebuild may now take its whole allowance even though the card's is nearly spent: the wait was
  // replaced, not added to. Under the old code this is where the fatal report fired.
  h.timers.advance(REBUILD_MS - 1000);
  assert.deepEqual(h.reports, [], 'the deadline moved when the card came back');
  assert.equal(h.timers.outstanding, 1, 'only one wait is ever outstanding');

  h.recovery.restored();
  assert.deepEqual(h.reports, []);
  assert.equal(h.game.phase.name, 'driving');
});

test('a card that never comes back is reported, as the wait for the card', () => {
  const h = harness();
  h.recovery.lost();
  h.timers.advance(CARD_MS);

  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].what, WAIT_CARD);
  assert.match(h.reports[0].message, /context was lost/);
  assert.equal(h.pacer.paused, true, 'the game stays stopped: there is no picture to draw into');
  assert.equal(h.timers.outstanding, 0);
});

test('a rebuild that never finishes is reported, as the wait for the rebuild', () => {
  const h = harness();
  h.recovery.lost();
  h.recovery.restoring();
  h.timers.advance(REBUILD_MS);

  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].what, WAIT_REBUILD, 'the player is told which stage failed');
});

test('the card is given long enough for a driver reset, not for a typical one', () => {
  // The whole defect was an allowance shorter than a Windows TDR. These floors are the invariant: a
  // reset of the card is measured in seconds on a machine that was already struggling, and the rebuild
  // re-uploads every mesh the city kept.
  assert.ok(CARD_MS >= 15000, `the card's allowance must cover a slow driver reset, was ${CARD_MS}`);
  assert.ok(REBUILD_MS >= 5000, `the rebuild's allowance must cover a whole city, was ${REBUILD_MS}`);
});

test('a loss in the showroom does not put the player out on the street', () => {
  const h = harness('garage');
  fullRecovery(h, 1000, 1000);

  // 'garage' to 'driving' is an allowed move, so resuming blindly would start a drive the player never
  // asked for. `pause()` did not take either: the showroom was never paused by the loss.
  assert.deepEqual(h.game.calls, ['pause'], 'resume is not called');
  assert.equal(h.game.phase.name, 'garage');
  assert.equal(h.pacer.paused, false, 'frames do run again');
  assert.deepEqual(h.reports, []);
});

test("a pause of the player's own survives the recovery", () => {
  const h = harness('paused');
  fullRecovery(h, 1000, 1000);

  assert.deepEqual(h.game.calls, ['pause'], 'his pause is his to lift');
  assert.equal(h.game.phase.name, 'paused');
  assert.equal(h.pacer.paused, false);
});

test('a second reset before the first has finished is waited for on its own', () => {
  const h = harness();
  h.recovery.lost();
  h.timers.advance(20000);
  h.recovery.restoring();
  h.recovery.lost();                         // the card goes away again mid-rebuild
  assert.equal(h.timers.outstanding, 1, 'the second wait replaces the first');

  h.timers.advance(2000);
  h.recovery.restoring();
  h.timers.advance(2000);
  h.recovery.restored();

  assert.deepEqual(h.reports, []);
  assert.equal(h.game.phase.name, 'driving');
  assert.equal(h.timers.outstanding, 0);
});
