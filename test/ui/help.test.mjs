// The controls screen and the bindings it documents, checked against each other.
//
// screens.js says at the top of its help lists that this file keeps the two in agreement, and a list of
// keys that has drifted from the bindings is worse than no list at all: it is the one place a player looks
// when a key does nothing, and being wrong there sends him away thinking the game is broken. So every key
// printed has to be a key that does something, and every binding has to be printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KEY_BINDINGS, PAD_BUTTONS, HELD_ACTIONS, PRESS_ACTIONS } from '../../web/src/game/input.js';
import { KEYBOARD_HELP, GAMEPAD_HELP, COCKPIT_HELP, SADDLE_HELP } from '../../web/src/ui/screens.js';

/** The cap a binding is printed as: `KeyW` is W, `ArrowUp` is an arrow, `Escape` is Esc. */
const ARROWS = { ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' };
const capOf = (code) => ARROWS[code]
  || (code.startsWith('Key') ? code.slice(3) : null)
  || ({ Escape: 'Esc', Space: 'Space', ShiftLeft: 'Shift', KeyP: 'P' })[code]
  || null;

/** Which actions the keyboard help is allowed to fold together: A and D are one row called `steer`. */
const FOLDED = { left: 'steer', right: 'steer' };

/** Every key the keyboard help prints, per action, and every action it prints at all. */
function documented(list, column = 'keys') {
  const byAction = new Map(), keys = new Set();
  for (const row of list) {
    if (row.action) byAction.set(row.action, row[column]);
    for (const k of row[column]) keys.add(k);
  }
  return { byAction, keys };
}

test('every key the keyboard help prints is a key that does something', () => {
  const printed = new Set();
  for (const row of KEYBOARD_HELP) for (const k of row.keys) printed.add(k);
  const bound = new Set();
  for (const code of Object.keys(KEY_BINDINGS)) {
    const cap = capOf(code);
    assert.ok(cap, `${code} has to be printable as a keycap, or the help cannot show it`);
    bound.add(cap);
  }
  const invented = [...printed].filter((k) => !bound.has(k));
  assert.deepEqual(invented, [], `the help prints ${invented.join(', ')}, which is bound to nothing`);
});

test('every binding the keyboard has is a binding the help mentions', () => {
  const { byAction } = documented(KEYBOARD_HELP);
  const missing = [];
  for (const [code, action] of Object.entries(KEY_BINDINGS)) {
    const named = FOLDED[action] || action;
    if (!byAction.has(named)) { missing.push(`${code} (${action})`); continue; }
    const cap = capOf(code);
    if (!byAction.get(named).includes(cap)) missing.push(`${code}: printed as nothing on the ${named} row`);
  }
  assert.deepEqual(missing, [], `a player reading the help would never know about ${missing.join(', ')}`);
});

test('the help names no action the input does not have, and holds no action out', () => {
  const actions = new Set([...HELD_ACTIONS, ...PRESS_ACTIONS, 'steer', 'left', 'right']);
  for (const list of [KEYBOARD_HELP, GAMEPAD_HELP]) {
    for (const row of list) {
      assert.ok(row.action, 'every row says which action it is');
      assert.ok(actions.has(row.action), `${row.action} is not an action the input knows about`);
      assert.ok(row.label && row.label.length > 2, `${row.action} has a label a person can read`);
      assert.ok(row.keys.length > 0, `${row.action} says what presses it`);
    }
  }
  // A pad has fewer buttons than a keyboard has keys, so it is not held to the same list — but everything
  // it does bind has to be documented, and every row has to be a real pad button.
  const padActions = new Set(Object.values(PAD_BUTTONS));
  const { byAction } = documented(GAMEPAD_HELP);
  const undocumented = [...padActions].filter((a) => !byAction.has(a));
  assert.deepEqual(undocumented, [], `a controller does ${undocumented.join(', ')} and the help does not say so`);
  const invented = [...byAction.keys()].filter((a) => !padActions.has(a) && !['throttle', 'brake', 'steer'].includes(a));
  assert.deepEqual(invented, [], `the controller help prints ${invented.join(', ')}, which no button does`);
});

test('the cockpit and the saddle reuse keys that exist, and say what they become', () => {
  // Neither list is a new binding: an aeroplane's flap lever is the headlamps key and its undercarriage is
  // the horn, which is exactly why they have to be written down. So every cap printed has to be a real
  // key, or the note is describing a lever nobody can pull.
  const bound = new Set(Object.keys(KEY_BINDINGS).map(capOf));
  for (const [name, list] of [['cockpit', COCKPIT_HELP], ['saddle', SADDLE_HELP]]) {
    assert.ok(list.length >= 5, `the ${name} is documented in ${list.length} rows, which is enough to fly by`);
    for (const row of list) {
      assert.ok(row.label.length > 4, `${name}: every row explains itself, not "${row.label}"`);
      for (const k of row.keys) assert.ok(bound.has(k), `${name}: ${k} is not a key the game listens to`);
    }
  }
  // And the two things a pilot cannot guess: which key is the undercarriage and which is the flaps.
  const cockpitKeys = new Map(COCKPIT_HELP.map((r) => [r.keys[0], r.label]));
  assert.match(cockpitKeys.get('G'), /undercarriage|gear/i, 'G is the undercarriage and the help says so');
  assert.match(cockpitKeys.get('H'), /flap/i, 'H is the flap lever and the help says so');
  const saddleKeys = new Map(SADDLE_HELP.map((r) => [r.keys[0], r.label]));
  assert.match(saddleKeys.get('R'), /pick|up/i, 'R picks a fallen motorcycle up and the help says so');
  assert.match(saddleKeys.get('W'), /throttle/i, 'and a motorcycle is throttled with the key a car is');
});
