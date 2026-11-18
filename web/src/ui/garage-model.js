// Garage logic without a DOM: which car the overlay shows, its statistics as text and bar
// lengths, what a colour is called, and the prompts for each kind of input device.
//
// The numbers of a car come from the physics specification through `describe(id)`
// (describeSpec(carSpec(id)) in src/physics/specs.js). Nothing here holds a figure of its own.

import { linearToSrgb } from '../core/math.js';

const KMH_PER_MPH = 1.609344;
const LB_PER_KG = 2.2046226;

/** Finish of a paint entry [r, g, b, finish]: 0 solid, 1 metallic, 2 pearl (design/CARS.md). */
export const FINISHES = Object.freeze([
  Object.freeze({ key: 'solid', label: 'Solid' }),
  Object.freeze({ key: 'metallic', label: 'Metallic' }),
  Object.freeze({ key: 'pearl', label: 'Pearl' }),
]);

/** The finish of a paint entry; an entry without one, or with one this build does not know, is solid. */
export function paintFinish(paint) {
  return FINISHES[paint[3]] || FINISHES[0];
}

/** CSS colour of a linear-light [r, g, b] paint. */
export function paintCss(paint) {
  const channel = (v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(Math.min(1, Math.max(0, v))))) * 255);
  return `rgb(${channel(paint[0])} ${channel(paint[1])} ${channel(paint[2])})`;
}

/**
 * The line under the swatches: the colour's own name when the model gives one, otherwise its
 * place in the row, and the finish.
 */
export function paintCaption(paints, index, names) {
  if (paints.length === 0) return '';
  const at = Math.min(Math.max(0, index), paints.length - 1);
  const name = names && typeof names[at] === 'string' && names[at] ? names[at] : `Colour ${at + 1} of ${paints.length}`;
  return `${name} \u00b7 ${paintFinish(paints[at]).label}`;
}

/**
 * How many swatches stand in a row: all of them up to six, and beyond that as many as share the
 * colours evenly between the rows (8 colours make two rows of 4, not 6 and 2).
 */
export function swatchColumns(count) {
  return count <= 6 ? Math.max(1, count) : Math.ceil(count / Math.ceil(count / 6));
}

/** The id `delta` places on from `id` in the list, going round at the ends. */
export function stepCar(cars, id, delta) {
  if (cars.length === 0) return id;
  const at = Math.max(0, cars.findIndex((car) => car.id === id));
  return cars[(at + delta + cars.length) % cars.length].id;
}

/**
 * What the overlay shows for the state the game last reported.
 *   cars   [{ id, name, line }]
 *   state  { id, status: 'ready' | 'building' | 'failed', wanted }   id: the car in the room
 * Returns { car, position, building, note }: the entry to show (the wanted car while it is being
 * built, so the name answers the key press at once), "2 / 4" (empty with a single car), and one
 * line about a build in progress or one that failed.
 */
export function garageView(cars, state) {
  const building = state.status === 'building';
  const find = (id) => cars.find((entry) => entry.id === id);
  const car = (building && find(state.wanted)) || find(state.id) || cars[0] || null;
  const position = car && cars.length > 1 ? `${cars.indexOf(car) + 1} / ${cars.length}` : '';
  let note = '';
  if (building) note = 'Building';
  else if (state.status === 'failed') {
    const failed = find(state.wanted);
    note = `${failed ? failed.name : 'That car'} could not be built.`;
  }
  return { car, position, building, note };
}

// A statistic: how its bar is scaled ('most' fills the bar of the car with the largest value,
// 'least' the bar of the car with the smallest, so the quickest sprint has the longest bar) and
// how it is written for a specification in the player's units: [label, value, unit].
const STATS = [
  { key: 'power', scale: 'most', read: (s) => s.powerKw, show: (s, mph) => ['Power', String(Math.round(mph ? s.powerHp : s.powerKw)), mph ? 'hp' : 'kW'] },
  { key: 'weight', scale: 'most', read: (s) => s.massKg, show: (s, mph) => ['Weight', String(Math.round(mph ? s.massKg * LB_PER_KG : s.massKg)), mph ? 'lb' : 'kg'] },
  { key: 'topSpeed', scale: 'most', read: (s) => s.topSpeedKmh, show: (s, mph) => ['Top speed', String(Math.round(mph ? s.topSpeedKmh / KMH_PER_MPH : s.topSpeedKmh)), mph ? 'mph' : 'km/h'] },
  { key: 'sprint', scale: 'least', read: (s) => s.zeroTo100, show: (s, mph) => [mph ? '0\u201362 mph' : '0\u2013100 km/h', s.zeroTo100.toFixed(1), 's'] },
  { key: 'gears', scale: 'most', read: (s) => s.gears, show: (s) => ['Gearbox', String(s.gears), 'speed'] },
];
export const STAT_COUNT = STATS.length;

/**
 * The statistics of one car as rows of text, each with the length of its comparison bar.
 *   cars      the cars the bars are scaled across
 *   id        the car described
 *   describe  (id) => describeSpec(carSpec(id))
 *   units     'kmh' | 'mph' (settings.game.units)
 * Returns { rows: [{ key, label, value, unit, fraction }], layout }: STAT_COUNT rows, and where the
 * engine sits and which wheels it drives, in words. `fraction` is 0..1, or null when there is
 * nothing to compare with (a single car): the bars are then left out.
 */
export function carStats(cars, id, describe, units) {
  const spec = describe(id);
  const mph = units === 'mph';
  const others = cars.length > 1 ? cars.map((car) => describe(car.id)) : null;
  const rows = STATS.map((stat) => {
    const amount = stat.read(spec);
    let fraction = null;
    if (others) {
      const amounts = others.map(stat.read);
      fraction = stat.scale === 'most' ? amount / Math.max(...amounts) : Math.min(...amounts) / amount;
    }
    const [label, value, unit] = stat.show(spec, mph);
    return { key: stat.key, label, value, unit, fraction };
  });
  return { rows, layout: spec.layoutLabel };
}

/**
 * Prompts at the foot of the garage for the device in use: [[keys], label]. A touch screen has
 * none (its buttons are on the screen).
 */
export const GARAGE_PROMPTS = Object.freeze({
  keys: Object.freeze([
    [['\u2190', '\u2192'], 'car'], [['\u2191', '\u2193'], 'colour'], [['Drag'], 'turn view'], [['Enter'], 'drive'], [['Esc'], 'back'],
  ]),
  pad: Object.freeze([
    [['\u2190', '\u2192'], 'car'], [['\u2191', '\u2193'], 'colour'], [['RS'], 'turn view'], [['A'], 'drive'], [['B'], 'back'],
  ]),
});
