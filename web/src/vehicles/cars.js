// The player's cars.
//
// One entry per car the player can drive. The entry is light (no geometry): the Garage reads names from it on the
// page, and the model worker calls load() to fetch the one car that is wanted and build only that.
//
//   id        key used by settings, the URL (?car=), physics specs and tests
//   name      shown in the Garage and on the car
//   line      one line under the name
//   voice     engine sound id (src/audio)
//   released  true once the car is finished; unreleased cars are hidden from the Garage but can be driven by id
//   load()    resolves to the car's build function, ({detail, paint}) => model record (ARCHITECTURE 10.1)
//
// The import paths are written out in full so that tools which read the module graph can see them.

export const CARS = Object.freeze([
  Object.freeze({
    id: 'lucera', name: 'Lucera', line: 'Mid-engined V12 wedge', voice: 'v12', released: true,
    load: () => import('./hero/index.js').then((m) => m.buildHeroCar),
  }),
  Object.freeze({
    id: 'silvretta', name: 'Silvretta Turbo', line: 'Rear-engined turbo flat-six', voice: 'flat6t', released: true,
    load: () => import('./silvretta/index.js').then((m) => m.buildCar),
  }),
  Object.freeze({
    id: 'thunderhead', name: 'Thunderhead', line: 'Front-engined American V8', voice: 'v8', released: true,
    load: () => import('./thunderhead/index.js').then((m) => m.buildCar),
  }),
]);

export const DEFAULT_CAR = 'lucera';

/** The entry for an id, or null. */
export function carById(id) {
  return CARS.find((car) => car.id === id) || null;
}

/** The entry for an id, falling back to the default car when the id is unknown. */
export function carOrDefault(id) {
  return carById(id) || carById(DEFAULT_CAR);
}

/** The cars shown in the Garage. */
export function releasedCars() {
  return CARS.filter((car) => car.released);
}
