// Building the generated models (the player's car, the traffic types, the garage set) off the
// main thread.
//
// The models are generated from code and take a noticeable fraction of a second each, so
// they are built in a worker while the page keeps drawing, and arrive as plain data with
// their buffers transferred. Where module workers are not available, or the
// worker fails to start, the same builders run on the page instead: slower to load, but the
// game still starts.
//
// Only one player car is ever built at a time: the one chosen at boot, and later the one the
// Garage asks for (`buildCarModel`). The others stay unloaded, so adding cars to the registry
// costs nothing at start-up.

import { carById, carOrDefault, DEFAULT_CAR } from '../vehicles/cars.js';
import { createLampRig } from './lamps.js';

const reason = (error) => (error && error.message ? error.message : String(error));

const isVector = (v) => (Array.isArray(v) || ArrayBuffer.isView(v)) && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const isMesh = (m) => Boolean(m) && m.vertices instanceof ArrayBuffer && m.indices instanceof Uint32Array && Array.isArray(m.groups);
/** Parts a car cannot be drawn without, and parts it may leave out. */
const REQUIRED_PARTS = ['body', 'wheelFront'];
const OPTIONAL_PARTS = [
  'glass', 'wheelRear', 'caliperFront', 'caliperRear', 'wheelFrontBlur', 'wheelRearBlur',
  'wheelFrontRight', 'wheelRearRight', 'wheelFrontBlurRight', 'wheelRearBlurRight', 'lampPodLeft', 'lampPodRight',
];
/** Lists of lamps, each entry of which has a place on the car. */
const LAMP_LISTS = ['headlamps', 'fogLamps', 'plateLamps', 'tailLamps', 'brakeLamps', 'reverseLamps'];

/**
 * Checks that a car's model holds what the game reads from it (design/ARCHITECTURE.md 10.1),
 * before anything of the car in the scene is given up for it. A model still being made is
 * the usual offender; what is wrong with it is said in one line, for its modeller.
 * @param {object} model  what a car's `build()` returned
 * @throws {Error} naming everything that is missing or malformed
 */
export function checkCarModel(model) {
  if (!model || typeof model !== 'object') throw new Error('the builder returned no model');
  const wrong = [];
  const parts = model.parts || {};
  // An optional part may be there and empty (not modelled yet): the game leaves it out.
  for (const name of REQUIRED_PARTS) if (!isMesh(parts[name]) || parts[name].indices.length === 0) wrong.push(`parts.${name}`);
  for (const name of OPTIONAL_PARTS) if (parts[name] && !isMesh(parts[name])) wrong.push(`parts.${name}`);
  const dims = model.dims || {};
  for (const name of ['length', 'width', 'height', 'wheelbase', 'wheelRadiusFront', 'wheelRadiusRear']) {
    if (!(dims[name] > 0) || !Number.isFinite(dims[name])) wrong.push(`dims.${name}`);
  }
  const collider = model.collider || {};
  if (!isVector(collider.halfExtents)) wrong.push('collider.halfExtents');
  if (!isVector(collider.centre)) wrong.push('collider.centre');
  const anchors = model.anchors || {};
  const wheels = anchors.wheels || {};
  for (const name of ['fl', 'fr', 'rl', 'rr']) if (!isVector(wheels[name])) wrong.push(`anchors.wheels.${name}`);
  for (const list of LAMP_LISTS) {
    if (anchors[list] === undefined) continue;
    if (!Array.isArray(anchors[list]) || !anchors[list].every((lamp) => lamp && isVector(lamp.pos))) wrong.push(`anchors.${list}`);
  }
  const indicators = anchors.indicators || {};
  for (const name in indicators) if (!isVector(indicators[name])) wrong.push(`anchors.indicators.${name}`);
  if (anchors.exhausts !== undefined && !(Array.isArray(anchors.exhausts) && anchors.exhausts.every((pipe) => pipe && isVector(pipe.pos) && isVector(pipe.dir)))) wrong.push('anchors.exhausts');
  if (anchors.bonnetCam !== undefined && !isVector(anchors.bonnetCam)) wrong.push('anchors.bonnetCam');
  const pods = anchors.lampPods || {};
  for (const side in pods) if (!pods[side] || !isVector(pods[side].hinge) || !isVector(pods[side].axis) || !Number.isFinite(pods[side].openAngle)) wrong.push(`anchors.lampPods.${side}`);
  if (model.paints !== undefined && !(Array.isArray(model.paints) && model.paints.length > 0 && model.paints.every(isVector))) wrong.push('paints');
  if (wrong.length > 0) throw new Error(`its model does not follow the contract of design/CARS.md (${wrong.join(', ')})`);
  // What the checks above do not name, the lamp rules find by running: they are plain arithmetic on the anchors.
  createLampRig(model);
}

/**
 * Every ArrayBuffer reachable from `value`, each once: the transfer list for postMessage.
 * @param {any} value
 * @returns {ArrayBuffer[]}
 */
export function collectTransferables(value) {
  const buffers = new Set();
  const seen = new Set();
  const visit = (v) => {
    if (v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) buffers.add(v);
    else if (ArrayBuffer.isView(v)) buffers.add(v.buffer);
    else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) visit(v[i]);
    else for (const key in v) visit(v[key]);
  };
  visit(value);
  return [...buffers];
}

/**
 * Loads one player car's module and builds its model on the calling thread.
 * @param {string} id  a registry id (src/vehicles/cars.js)
 * @returns {Promise<object>} the vehicle model record (ARCHITECTURE 10.1); rejects when the
 *   car is unknown, its module cannot be loaded, its builder throws or its model is incomplete
 */
export async function buildCarHere(id) {
  const entry = carById(id);
  if (!entry) throw new Error(`There is no car called '${id}'`);
  const build = await entry.load();
  if (typeof build !== 'function') throw new Error(`The ${entry.name} has no build function`);
  const model = build();
  checkCarModel(model);
  return model;
}

/**
 * Builds the chosen player car and the traffic types on the calling thread. Shared by the
 * worker and the fallback.
 *
 * A player car is essential, the chosen one is not: a car that cannot be loaded or built (a
 * model still being made, say) is replaced by the default car, with a warning. The traffic
 * types are not essential either: a city with empty streets can still be driven, so if they
 * cannot be loaded the game starts without them and says so (`warnings`, which the page
 * writes to the console).
 * @param {(fraction: number) => void} onProgress
 * @param {string} [carId]  registry id; unknown ids select the default car
 * @returns {Promise<{car: object, carId: string, traffic: object[], warnings: string[]}>}
 *   carId is the car that was really built
 */
export async function buildModelsHere(onProgress, carId = DEFAULT_CAR) {
  const warnings = [];
  const wanted = carOrDefault(carId);
  const trafficLoading = import('../vehicles/traffic/index.js').catch((error) => {
    warnings.push('Traffic vehicles could not be loaded, the streets will be empty: ' + reason(error));
    return null;
  });
  let id = wanted.id;
  let car;
  try {
    car = await buildCarHere(id);
  } catch (error) {
    if (id === DEFAULT_CAR) throw error;
    warnings.push(`The ${wanted.name} could not be built, the ${carOrDefault(DEFAULT_CAR).name} takes its place: ${reason(error)}`);
    id = DEFAULT_CAR;
    car = await buildCarHere(id);
  }
  onProgress(0.55);
  const trafficModule = await trafficLoading;
  let traffic = [];
  if (trafficModule) {
    try {
      traffic = trafficModule.buildTrafficModels();
    } catch (error) {
      warnings.push('Traffic vehicles could not be built, the streets will be empty: ' + reason(error));
    }
  }
  onProgress(1);
  return { car, carId: id, traffic, warnings };
}

/**
 * Runs one request in a fresh model worker and resolves with its answer.
 * @param {(() => Worker) | null} createWorker  null or a throwing function selects `here`
 * @param {object} request  the message for the worker (models.worker.js)
 * @param {(fraction: number) => void} onProgress
 * @param {() => Promise<object>} here  the same work on the page, shaped like the worker's answer
 * @returns {Promise<object>} the worker's 'done' message, or what `here` resolved to, with
 *   `inWorker` saying which
 */
function runModelWorker(createWorker, request, onProgress, here) {
  const onPage = () => here().then((answer) => ({ ...answer, inWorker: false }));
  let worker = null;
  try {
    worker = createWorker ? createWorker() : null;
  } catch {
    // No module workers here (or blocked by policy): build on the page.
    worker = null;
  }
  if (!worker) return onPage();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      fn(value);
    };
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') onProgress(message.fraction);
      else if (message.type === 'done') finish(resolve, { ...message, inWorker: true });
      // The builders themselves failed: running them again on the page would fail the same way.
      else if (message.type === 'error') finish(reject, new Error('Vehicle models: ' + message.message));
    };
    // The worker script could not be loaded or started: that says nothing about the builders.
    worker.onerror = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      finish((value) => value.then(resolve, reject), onPage());
    };
    worker.postMessage(request);
  });
}

/**
 * The models the game starts with: the chosen player car and the traffic.
 * @param {{car?: string, onProgress?: (fraction: number) => void,
 *          createWorker?: (() => Worker) | null}} [options]
 *   car: registry id of the player's car; createWorker: makes the module worker
 * @returns {Promise<{car: object, carId: string, traffic: object[], builtInWorker: boolean}>}
 */
export function buildVehicleModels({ car = DEFAULT_CAR, onProgress = () => {}, createWorker = defaultWorker } = {}) {
  return runModelWorker(createWorker, { type: 'build', car }, onProgress, () => buildModelsHere(onProgress, car)).then((answer) => {
    for (const warning of answer.warnings || []) console.warn(warning);
    return { car: answer.car, carId: answer.carId, traffic: answer.traffic, builtInWorker: answer.inWorker };
  });
}

/**
 * One player car, built on demand (the Garage). Nothing takes its place if it fails: the
 * caller keeps the car it has.
 * @param {string} id  registry id
 * @param {{createWorker?: (() => Worker) | null}} [options]
 * @returns {Promise<object>} the vehicle model record; rejects when the car cannot be loaded or built
 */
export function buildCarModel(id, { createWorker = defaultWorker } = {}) {
  return runModelWorker(createWorker, { type: 'car', id }, () => {}, () => buildCarHere(id).then((car) => ({ car })))
    .then((answer) => answer.car);
}

/**
 * Builds the garage set on the calling thread: the real one, or the bare stand-in room when
 * the set cannot be loaded or built, so that Play always leads somewhere.
 * @param {number} detail  the set's level of detail
 * @returns {Promise<{set: object, warning: string|null}>} set.standIn says which it is
 */
export async function buildGarageHere(detail) {
  try {
    const { buildGarage } = await import('../world/garage/index.js');
    return { set: buildGarage({ detail }), warning: null };
  } catch (error) {
    const { buildGarage } = await import('./standInGarage.js');
    return { set: buildGarage(), warning: 'The garage set could not be built, a bare room takes its place: ' + reason(error) };
  }
}

/**
 * The garage set (design/GARAGE.md) and the functions that turn it into light and glow records.
 * @param {{detail?: number, createWorker?: (() => Worker) | null}} [options]
 * @returns {Promise<{set: object, lightRecords: Function, glowRecords: Function}>}
 */
export async function buildGarageSet({ detail = 2, createWorker = defaultWorker } = {}) {
  const answer = await runModelWorker(createWorker, { type: 'garage', detail }, () => {}, () => buildGarageHere(detail));
  if (answer.warning) console.warn(answer.warning);
  // The record functions cannot cross from the worker; they come from the module that built the set.
  const { lightRecords, glowRecords } = await (answer.set.standIn ? import('./standInGarage.js') : import('../world/garage/index.js'));
  return { set: answer.set, lightRecords, glowRecords };
}

function defaultWorker() {
  if (typeof Worker !== 'function') return null;
  return new Worker(new URL('./models.worker.js', import.meta.url), { type: 'module', name: 'vehicle-models' });
}
