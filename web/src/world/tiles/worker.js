// The world worker: builds the plan and the prototypes once, then tiles on request.
// Loaded as a module worker by src/world/index.js. The message handling lives in `createTileServer` so that
// tests (and a page without workers) can run the very same code in-process.
//
// page -> worker   { type: 'init', detail, layout? , layoutUrl? }
//                  { type: 'tile', id, tx, tz, level, density }
// worker -> page   { type: 'progress', fraction, label }
//                  { type: 'ready', data, prototypes, notes, issues, timings }      (prototype meshes transferred)
//                  { type: 'tile', id, density, payload, ms }                               (all typed arrays transferred)
//                  { type: 'error', id?, message }

import { meshTransferables } from '../../core/mesh.js';
import { loadAdapters } from './adapters.js';
import { buildPlan } from '../plan/index.js';
import { buildTile } from './builder.js';

const LAYOUT_URL = new URL('../../../design/map/layout.json', import.meta.url);

/** post(message, transferList) delivers to the page. Returns { handle(message) }. */
export function createTileServer(post) {
  let plan = null, deps = null;
  const catalogue = new Map();
  const now = () => performance.now();

  async function init(message) {
    post({ type: 'progress', fraction: 0.05, label: 'Reading the map' }, []);
    deps = await loadAdapters();
    const layout = message.layout || await (await fetch(message.layoutUrl || LAYOUT_URL)).json();
    post({ type: 'progress', fraction: 0.15, label: 'Growing the palms' }, []);
    const prototypes = deps.prototypes(message.detail ?? 2), lenses = {};
    for (const p of prototypes) { catalogue.set(p.name, p); if (p.signalLenses) lenses[p.name] = p.signalLenses; }
    post({ type: 'progress', fraction: 0.45, label: 'Laying out the streets' }, []);
    plan = buildPlan(layout, deps, { signalLenses: lenses });
    post({ type: 'progress', fraction: 0.9, label: 'Building the city' }, []);
    // The page needs the meshes and the hand-over distances; the worker keeps the records placement uses.
    const transfer = [], shipped = prototypes.map((p) => {
      for (const lod of p.lods) transfer.push(...meshTransferables(lod.mesh));
      return { name: p.name, lods: p.lods.map((lod) => ({ mesh: lod.mesh, near: lod.near, far: lod.far })), castShadow: p.height > 0.6 };
    });
    post({ type: 'ready', data: plan.data, prototypes: shipped, notes: deps.notes, issues: plan.issues, timings: plan.timings }, transfer);
    for (const p of prototypes) p.lods = null;      // their buffers now belong to the page
  }

  function tile(message) {
    const t0 = now(), built = buildTile(plan, deps, catalogue, message.tx, message.tz, message.level, message.density);
    post({ type: 'tile', id: message.id, density: message.density, payload: built.payload, ms: now() - t0 }, built.transfer);
  }

  return {
    async handle(message) {
      try {
        if (message.type === 'init') await init(message);
        else if (message.type === 'tile') tile(message);
      } catch (err) {
        post({ type: 'error', id: message.id, message: `${message.type}: ${err && err.stack ? err.stack : err}` }, []);
      }
    },
  };
}

// Running as a worker: serve the page.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const server = createTileServer((message, transfer) => self.postMessage(message, transfer));
  self.onmessage = (event) => { server.handle(event.data); };
}
