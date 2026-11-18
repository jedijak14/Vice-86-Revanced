// Which car the player drives, which colour each car was left in, and the models of the cars
// already built.
//
// Two sources name a car: the saved setting (the Garage's choice) and, for one session, the
// page address (`?car=`) or a script (`__vice.setCar`). The Garage and the setting only ever
// hold finished cars; the address and scripts may also name an unreleased one, which is how
// a car is driven while it is still being made.

import { carById, DEFAULT_CAR } from '../vehicles/cars.js';

/**
 * The registry id to use for a requested one.
 * @param {any} id
 * @param {boolean} unreleased  whether unreleased cars may be chosen
 * @returns {string|null} null when there is no such car, or it may not be chosen
 */
export function allowedCar(id, unreleased) {
  const entry = typeof id === 'string' ? carById(id) : null;
  return entry && (entry.released || unreleased) ? entry.id : null;
}

/**
 * The car a session starts in.
 * @param {string|null} fromAddress  `?car=` (parseOptions), any registry id
 * @param {any} fromSettings         settings.game.car
 */
export function chooseCar(fromAddress, fromSettings) {
  return allowedCar(fromAddress, true) || allowedCar(fromSettings, false) || DEFAULT_CAR;
}

/**
 * Makes `settings.game.paints` (colour index by car id) usable. Before there was more than one
 * car, `settings.game.paint` was the default car's colour; it is carried over once.
 */
export function preparePaints(settings) {
  const game = settings.game;
  if (!game.paints || typeof game.paints !== 'object') game.paints = {};
  if (game.paints[DEFAULT_CAR] === undefined && Number.isInteger(game.paint) && game.paint >= 0) game.paints[DEFAULT_CAR] = game.paint;
}

/** The colour index a car was left in, 0 for a car never painted. */
export function paintOf(settings, id) {
  const index = settings.game.paints ? settings.game.paints[id] : undefined;
  return Number.isInteger(index) && index >= 0 ? index : 0;
}

/** Records the colour of the car now driven; `settings.game.paint` stays the current car's colour. */
export function rememberPaint(settings, id, index) {
  preparePaints(settings);
  settings.game.paints[id] = index;
  settings.game.paint = index;
}

/**
 * The cars the player cycles through, in registry order: the finished ones, and the cars
 * under test that were put in the scene this session, so that they have a place in the cycle.
 * @param {{id: string, released: boolean}[]} cars  the registry
 * @param {Set<string>} tested  ids of the unreleased cars shown this session
 * @returns {object[]} registry entries
 */
export function cycleOf(cars, tested) {
  return cars.filter((entry) => entry.released || tested.has(entry.id));
}

/** The id `delta` places from `id` in the cycle, wrapping round; `id` itself when it is not in it. */
export function stepCar(cycle, id, delta) {
  const i = cycle.findIndex((entry) => entry.id === id);
  if (i < 0 || cycle.length === 0) return id;
  return cycle[(((i + delta) % cycle.length) + cycle.length) % cycle.length].id;
}

/**
 * Which way a change of car goes round the cycle: +1 to the next car, -1 to the previous one,
 * 0 when the cycle does not say (the same car, or a car outside it). With two cars both
 * neighbours are the same car, and it counts as the next.
 */
export function cycleDirection(cycle, from, to) {
  if (from === to) return 0;
  if (stepCar(cycle, from, 1) === to) return 1;
  if (stepCar(cycle, from, -1) === to) return -1;
  const a = cycle.findIndex((entry) => entry.id === from), b = cycle.findIndex((entry) => entry.id === to);
  return a < 0 || b < 0 ? 0 : Math.sign(b - a);
}

/**
 * The models of the player cars built so far, and the building of more. A model is plain data
 * and is kept for the session once built, so going back to a car costs nothing; the GPU meshes
 * and the physics body exist only for the car in the scene.
 * @param {(id: string) => Promise<object>} build  builds one car's model (models.js)
 */
export function createCarCache(build) {
  const models = new Map();
  const building = new Map();
  /** Cars that failed in a background build: not tried again unasked. */
  const failed = new Set();
  let background = Promise.resolve();

  const cache = {
    /** Ids of the cars whose models are held. */
    get ids() { return [...models.keys()]; },
    has: (id) => models.has(id),
    put(id, model) { models.set(id, model); },
    /** Forgets a model that turned out to be unusable; it is built again only when asked for. */
    drop(id) {
      models.delete(id);
      failed.add(id);
    },

    /**
     * The model of a car, built now if it is not held. A build already running is joined.
     * @returns {Promise<object>} rejects when the car cannot be built
     */
    get(id) {
      if (models.has(id)) return Promise.resolve(models.get(id));
      if (!building.has(id)) {
        const job = Promise.resolve().then(() => build(id)).then((model) => {
          models.set(id, model);
          failed.delete(id);
          return model;
        }).finally(() => building.delete(id));
        building.set(id, job);
      }
      return building.get(id);
    },

    /**
     * Builds the given cars one after another while nothing waits for them (the neighbours
     * of the car on show). A car that cannot be built is left out quietly: the player hears
     * of it when asking for that car.
     */
    warm(ids) {
      for (const id of ids) {
        background = background.then(() => {
          if (models.has(id) || failed.has(id)) return null;
          return cache.get(id).catch(() => { failed.add(id); });
        });
      }
      return background;
    },
  };
  return cache;
}
