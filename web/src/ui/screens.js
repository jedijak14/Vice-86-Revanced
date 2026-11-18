// The content of every menu screen, as lists of rows (controls.js). No layout or input handling
// here: menu.js mounts these lists, moves focus through them and routes intents to the rows.
//
// A screen is { id, title, kind: 'root' | 'panel', wide?, tabs?: [label], build(tabIndex) -> rows }.
// A panel replaces the root list in the left column; a wide panel (settings, controls) takes the
// whole screen behind a deeper scrim.
// build is called once per tab, the first time it is shown.

import { el } from './dom.js';
import { actionRow, optionRow, noteRow, segmentRow } from './controls.js';
import { SCHEMA, TIME_OPTIONS, WEATHER_OPTIONS, fieldOf, formatValue, hasMenuRow } from './settings.js';

// ---------------------------------------------------------------- controls reference
//
// Mirrors the bindings in src/game/input.js (test/ui/help.test.mjs checks the two agree).

export const KEYBOARD_HELP = Object.freeze([
  { action: 'throttle', label: 'Throttle', keys: ['W', '\u2191'] },
  { action: 'brake', label: 'Brake and reverse', keys: ['S', '\u2193'] },
  { action: 'steer', label: 'Steer', keys: ['A', 'D', '\u2190', '\u2192'] },
  { action: 'handbrake', label: 'Handbrake', keys: ['Space'] },
  { action: 'boost', label: 'Nitrous', keys: ['Shift'] },
  { action: 'lookBack', label: 'Look back', keys: ['Q'] },
  { action: 'horn', label: 'Horn', keys: ['G'] },
  { action: 'camera', label: 'Change camera', keys: ['C'] },
  { action: 'headlamps', label: 'Headlamps', keys: ['H'] },
  { action: 'time', label: 'Next time of day', keys: ['T'] },
  { action: 'weather', label: 'Change weather', keys: ['Y'] },
  { action: 'recover', label: 'Recover to road', keys: ['R'] },
  { action: 'pause', label: 'Pause', keys: ['Esc', 'P'] },
]);

export const GAMEPAD_HELP = Object.freeze([
  { action: 'throttle', label: 'Throttle', keys: ['RT'] },
  { action: 'brake', label: 'Brake and reverse', keys: ['LT'] },
  { action: 'steer', label: 'Steer', keys: ['Left stick'] },
  { action: 'handbrake', label: 'Handbrake', keys: ['A'] },
  { action: 'boost', label: 'Nitrous', keys: ['X', 'LB'] },
  { action: 'lookBack', label: 'Look back', keys: ['B'] },
  { action: 'horn', label: 'Horn', keys: ['L3'] },
  { action: 'camera', label: 'Change camera', keys: ['Y'] },
  { action: 'headlamps', label: 'Headlamps', keys: ['D-pad \u2190'] },
  { action: 'time', label: 'Next time of day', keys: ['D-pad \u2191'] },
  { action: 'weather', label: 'Change weather', keys: ['D-pad \u2193'] },
  { action: 'recover', label: 'Recover to road', keys: ['Back'] },
  { action: 'pause', label: 'Pause', keys: ['Start'] },
]);

const MENU_HELP = Object.freeze([
  { label: 'Move', keys: ['\u2191', '\u2193'], pad: ['D-pad', 'Left stick'] },
  { label: 'Change value', keys: ['\u2190', '\u2192'], pad: ['D-pad', 'Left stick'] },
  { label: 'Select', keys: ['Enter'], pad: ['A'] },
  { label: 'Back', keys: ['Esc'], pad: ['B'] },
  { label: 'Switch tab', keys: ['Q', 'E'], pad: ['LB', 'RB'] },
]);

function bindingTable(doc, title, entries, column) {
  const table = el(doc, 'div', 'keys');
  table.appendChild(el(doc, 'div', 'keys__title', title));
  for (const entry of entries) {
    const caps = el(doc, 'span', 'keys__caps', ...entry[column].map((key) => el(doc, 'kbd', 'key', key)));
    table.appendChild(el(doc, 'div', 'keys__row', el(doc, 'span', 'keys__label', entry.label), caps));
  }
  return table;
}

function staticRow(node) {
  return { el: node, focusable: false, help: '', intent: () => false, refresh() {} };
}

// ---------------------------------------------------------------- screens

/**
 * ctx (provided by menu.js):
 *   doc, settings, actions
 *   open(id)                         open a panel beside the root list
 *   change(section, key, value)      set one option, apply it live and save
 *   play(), resume(), quit(), recover()
 *   deviceInfo()                     result of describeGraphics plus { autoPreset, refined }, or null
 */
export function buildScreens(ctx) {
  const { doc, settings } = ctx;
  const bind = (section, key) => ({ get: () => settings[section][key], set: (value) => ctx.change(section, key, value) });
  const worldSummary = () => `${formatValue(fieldOf('game', 'startTime'), settings.game.startTime)} \u00b7 ${formatValue(fieldOf('game', 'weather'), settings.game.weather)}`;

  const link = (label, id, extra) => actionRow(doc, { label, large: true, onAccept: () => ctx.open(id), ...extra });
  // The entries the title and pause menus have in common; each menu gets its own row objects.
  const commonRows = () => [
    link('Time and weather', 'world', { detail: worldSummary }),
    link('Settings', 'settings'),
    link('Controls', 'controls'),
  ];

  const title = {
    id: 'title', kind: 'root',
    build: () => [
      actionRow(doc, { label: 'Play', large: true, onAccept: ctx.play }),
      ...commonRows(),
    ],
  };

  const pause = {
    id: 'pause', kind: 'root', title: 'Paused',
    build: () => [
      actionRow(doc, { label: 'Resume', large: true, onAccept: ctx.resume }),
      ...commonRows(),
      actionRow(doc, { label: 'Recover to road', large: true, onAccept: ctx.recover }),
      actionRow(doc, { label: 'Quit to menu', large: true, onAccept: ctx.quit }),
    ],
  };

  const world = {
    id: 'world', kind: 'panel', title: 'Time and weather',
    build: () => [
      segmentRow(doc, { label: 'Time', options: TIME_OPTIONS, binding: bind('game', 'startTime'), help: 'Sets the clock now. It keeps running from there at the pace chosen under Settings, Game.' }),
      segmentRow(doc, { label: 'Weather', options: WEATHER_OPTIONS, binding: bind('game', 'weather'), help: fieldOf('game', 'weather').help }),
    ],
  };

  const optionRows = (section) => SCHEMA[section].filter(hasMenuRow).map((f) => optionRow(doc, f, bind(section, f.key)));

  function graphicsRows() {
    const presetField = fieldOf('graphics', 'preset');
    const preset = segmentRow(doc, { label: presetField.label, options: presetField.options, binding: bind('graphics', 'preset'), help: presetField.help });
    // The device note is read-only: the GPU's name and what Auto made of it.
    const device = noteRow(doc, 'device', (node) => {
      const lines = describeDevice(ctx.deviceInfo(), settings.graphics.preset);
      node.replaceChildren(el(doc, 'span', 'device__name', lines[0]), el(doc, 'span', 'device__line', lines[1]));
      preset.help = lines.length > 2 ? `${presetField.help} ${lines[2]}` : presetField.help;
    });
    return [preset, device, ...SCHEMA.graphics.filter((f) => f.key !== 'preset').map((f) => optionRow(doc, f, bind('graphics', f.key)))];
  }

  const keyList = () => [
    staticRow(bindingTable(doc, 'Keyboard', KEYBOARD_HELP, 'keys')),
    staticRow(bindingTable(doc, 'Controller', GAMEPAD_HELP, 'keys')),
  ];

  const settingsScreen = {
    id: 'settings', kind: 'panel', title: 'Settings', wide: true,
    tabs: ['Graphics', 'Audio', 'Controls', 'Game'],
    build: (tab) => {
      if (tab === 0) return graphicsRows();
      const rows = optionRows(['graphics', 'audio', 'controls', 'game'][tab]);
      return tab === 2 ? [...rows, ...keyList()] : rows;
    },
  };

  const controls = {
    id: 'controls', kind: 'panel', title: 'Controls', wide: true,
    build: () => [
      ...keyList(),
      staticRow(bindingTable(doc, 'Menus, keyboard', MENU_HELP, 'keys')),
      staticRow(bindingTable(doc, 'Menus, controller', MENU_HELP, 'pad')),
      staticRow(el(doc, 'p', 'row-note', 'On a touch screen: slide a thumb along the strip at the lower left to steer; the pedals are at the lower right, with the handbrake above the brake and nitrous beside them.')),
    ],
  };

  return { title, pause, world, settings: settingsScreen, controls };
}

const PRESET_LABEL = { ultraLow: 'Ultra Low', low: 'Low', medium: 'Medium', high: 'High', ultra: 'Ultra' };

/**
 * Lines for the device note on the Graphics tab: the GPU name, what Auto chose and on what
 * evidence, and (third line, when known) why. `info` is null until the game has reported the device.
 */
export function describeDevice(info, currentPreset) {
  if (!info) return ['Graphics device not reported', 'Auto uses Medium until the device has been identified.'];
  const chosen = PRESET_LABEL[info.autoPreset || info.preset] || 'Medium';
  // What the device *is* is the whole of this line. The renderer's name used to be printed in front of
  // it, which told a person reading their own settings panel nothing they could act on.
  const basis = info.refined ? 'confirmed by measured frame times' : 'estimated from the hardware, to be checked against measured frame times';
  const verb = currentPreset === 'auto' ? 'Auto is using' : 'Auto would use';
  const lines = [info.label || 'Unknown graphics device', `${verb} ${chosen}: ${basis}.`];
  if (info.reasons && info.reasons.length) lines.push(info.reasons.join(' '));
  return lines;
}
