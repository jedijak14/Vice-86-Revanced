// Worker entry: builds models and posts them back with their buffers transferred. See
// models.js. One request per worker: 'build' (the chosen player car and the traffic), 'car'
// (one player car by id) or 'garage' (the garage set).

import { buildModelsHere, buildCarHere, buildGarageHere, collectTransferables } from './models.js';

const WORK = {
  build: (request) => buildModelsHere((fraction) => self.postMessage({ type: 'progress', fraction }), request.car),
  car: async (request) => ({ car: await buildCarHere(request.id) }),
  garage: (request) => buildGarageHere(request.detail),
};

self.onmessage = async (event) => {
  const request = event.data;
  const work = request && Object.hasOwn(WORK, request.type) ? WORK[request.type] : null;
  if (!work) return;
  try {
    const message = { type: 'done', ...(await work(request)) };
    self.postMessage(message, collectTransferables(message));
  } catch (error) {
    self.postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  }
};
