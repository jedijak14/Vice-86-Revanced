// Patrol liveries: the paint a police car wears over a body that was already built for the street.
//
// Paloma PD does not have a car of its own shape. What it has is the fleet of saloons and mid-size
// sedans the island already drives, in the colours of the agency: doors and roof left white, the rest
// of the body in the department's green, tan over black for the county, and nothing at all for an
// unmarked car. A livery is a set of material pickers, which is what `specs.js` asks for:
// `side(z, y)` for the flank, `band(x, y, z)` for the panel bands and `cabin(x, y, z)` for the roof
// and pillars. Returning null leaves that place wearing the body paint.
//
// The pickers are given the spec's own `z` mapper, the one that turns a length along the body into the
// axis the shell is built on; every seam is therefore stated in the same units the body's own doors
// are, which is what lets one livery fit a 5.4 m saloon and a 4.78 m one unchanged.

import * as mt from './materials.js';

const hex = mt.hex;

/** The department's colours. `patrolGreen` is the release's own; the rest are its neighbours. */
export const PATROL_COLOURS = Object.freeze({
  white: hex(0xe8e6da),
  offWhite: hex(0xd9d6c8),
  black: hex(0x1c1d20),
  tan: hex(0xb99a6a),
  green: hex(0x1f4a3c),
  navy: hex(0x1b2540),
  gold: hex(0xc8a24a),
});

/**
 * A livery for a marked unit.
 *
 * @param {Function} z      the spec's mapper from a length along the body to the shell's axis
 * @param {object} [opts]
 * @param {number[]} [opts.doors]  the front and rear door seams, in the same units as the spec's own
 *                                 door list: the white shows between them
 * @param {'marked'|'twoTone'|'county'} [opts.scheme]
 * @param {number} [opts.beltY]   the height the two-tone's white starts at
 */
export function patrol(z, { doors = [1.665, 3.665], scheme = 'marked', beltY = 0.72 } = {}) {
  const C = PATROL_COLOURS;
  const white = mt.fixed(C.white);
  const tan = mt.fixed(C.tan, true);
  const accent = scheme === 'county' ? tan : white;
  if (scheme === 'twoTone') {
    // The whole upper flank and the roof are white, the wings keep the body colour.
    return { side: (zz, y) => (y > beltY ? accent : null), band: () => null, cabin: () => accent };
  }
  const [front, rear] = doors;
  return {
    side: (zz) => (zz < z(front) && zz > z(rear) ? accent : null),
    band: () => null,
    cabin: () => accent,
  };
}

/**
 * An unmarked car: nothing. It is a civilian body with a radio, and the point of it is that it reads as
 * one until it puts a bumper in your mirror. The traffic module still offers a bar to such a unit (see
 * `unit.lightBar`); a car built without the bar geometry has no glass to light, which is the correct
 * answer rather than a missing feature.
 */
export const unmarked = () => ({ side: () => null, band: () => null, cabin: () => null });

/** The department's gold stripe along the boot lid, for the marked schemes that carry one. */
export const goldStrip = { mat: () => mt.fixed(PATROL_COLOURS.gold, true), y: 0.5 - 0.03, h: 0.03, proud: 0.0022, flat: true, lod: 0, step: 0.9 };

/**
 * The four ways the agency paints its cars, in the order the garage and the spawner offer them.
 * `paints` is a name from the spec's PAINT chart, `bar` whether the roof carries the light rig.
 */
export const SCHEMES = Object.freeze([
  { id: 'marked', name: 'Marked unit', paint: 'patrolGreen', bar: true, livery: patrol },
  { id: 'twoTone', name: 'Two-tone patrol', paint: 'patrolGreen', bar: true, livery: (z) => patrol(z, { scheme: 'twoTone' }) },
  { id: 'county', name: 'County patrol', paint: 'patrolGreen', bar: true, livery: (z) => patrol(z, { scheme: 'county' }) },
  { id: 'unmarked', name: 'Unmarked radio car', paint: 'charcoal', bar: false, livery: unmarked },
]);

/** By id, for a saved setting or a script. */
export const schemeById = (id) => SCHEMES.find((s) => s.id === id) || SCHEMES[0];

export const SCHEME_NAMES = Object.freeze(SCHEMES.map((s) => s.id));
