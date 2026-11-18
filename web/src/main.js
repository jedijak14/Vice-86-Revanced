// VICE '86 entry point: the boot sequence.
//
// Order: UI shell and settings, renderer (which tells what the device can do), physics, then
// the world, the vehicle models and the texture atlas side by side, the game on top of them,
// the title scene's tiles, shader warm-up, and finally the frame loop with the title screen.
//
// Every stage reports real progress to the loading screen and runs inside one try block: a
// failure anywhere names the stage and ends on the error panel instead of a black page.
//
// `boot(env)` takes its surroundings as an argument (window, document, module loaders), so the
// same sequence runs in Node against mocks. The page calls it with the real ones at the bottom
// of this file.

import { FramePacer, runFrameLoop } from './game/loop.js';
import { createInput } from './game/input.js';
import { createGame } from './game/game.js';
import { buildVehicleModels, buildCarModel, buildGarageSet } from './game/models.js';
import { chooseCar } from './game/garage.js';
import { parseOptions, createHooks } from './game/automation.js';

/** Where each module comes from. Tests replace entries; the page uses these. */
const DEFAULT_LOADERS = Object.freeze({
  ui: () => import('./ui/index.js'),
  settings: () => import('./ui/settings.js'),
  autotune: () => import('./ui/autotune.js'),
  renderer: () => import('./render/index.js'),
  atlas: () => import('./render/atlas.js'),
  sky: () => import('./render/sky/environment.js'),
  lightning: () => import('./render/sky/lightning.js'),
  physics: () => import('./physics/index.js'),
  world: () => import('./world/index.js'),
  audio: () => import('./audio/index.js'),
});

// How long a lost WebGL context may take to come back before the game gives up and says so.
const CONTEXT_RESTORE_MS = 5000;
// Share of the loading bar at which each stage ends.
const PROGRESS = Object.freeze({ shell: 0.03, renderer: 0.1, physics: 0.16, assets: 0.72, scene: 0.9, warmup: 0.98 });
// Within the assets stage, which runs three jobs at once: their shares of that stretch.
const ASSET_SHARE = Object.freeze({ world: 0.55, models: 0.3, atlas: 0.15 });
const SCENE_TIMEOUT_SECONDS = 25; // the title scene is shown with whatever has loaded by then
const SCENE_RADIUS = 140; // m around the car that must be loaded (the same as the game holds a fade for)
const BLACK_FRAMES = 3; // frames drawn behind the loading screen after warm-up, before the title
const LOW_ATLAS_SIZE = 2048, ATLAS_SIZE = 4096;
const WHEEL_LINE_PIXELS = 16; // a wheel that reports lines or pages instead of pixels

/**
 * Starts the game.
 * @param {object} env
 * @param {Window} env.window
 * @param {Document} env.document
 * @param {object} [env.loaders]       replacements for DEFAULT_LOADERS entries
 * @param {Function|null} [env.createWorker]  for the vehicle model worker (see models.js)
 * @param {Function} [env.buildModels]  replaces buildVehicleModels (tests)
 * @param {Function} [env.buildCar]     replaces buildCarModel (tests)
 * @param {Function} [env.buildGarage]  replaces buildGarageSet (tests)
 * @returns {Promise<{game: object|null, hooks: object, stop: () => void}>}
 */
export async function boot(env) {
  const win = env.window, doc = env.document;
  const loaders = { ...DEFAULT_LOADERS, ...(env.loaders || {}) };
  const now = () => win.performance.now();
  const options = parseOptions(win.location ? win.location.search : '');
  const automation = createHooks();
  const hooks = automation.hooks;
  win.__vice = hooks;

  const canvas = doc.getElementById('game');
  const root = doc.getElementById('ui');
  let ui = null, game = null, audio = null, renderer = null, loop = null, input = null;
  let stage = 'starting';
  let failed = false;
  const cleanups = [];
  const listen = (target, type, handler, opts) => {
    target.addEventListener(type, handler, opts);
    cleanups.push(() => target.removeEventListener(type, handler, opts));
  };

  // Modules that recover from a fault (a shader rebuilt from its fallback, a render pass
  // switched off) report it on the console and carry on. A script watching `__vice.errors`
  // has to see those too, so console errors are copied there for as long as the game runs.
  const consoleError = win.console.error;
  const describe = (value) => (value && value.stack ? value.stack : String(value));
  win.console.error = (...args) => {
    automation.fail(`console: ${args.map(describe).join(' ')}`);
    consoleError.apply(win.console, args);
  };
  cleanups.push(() => { win.console.error = consoleError; });

  /** A fatal error: stop, record it, and put it in front of the player in words. */
  function fail(error, where) {
    if (failed) return;
    failed = true;
    const reason = error && error.message ? error.message : String(error);
    hooks.errors.push(`${where}: ${error && error.stack ? error.stack : reason}`);
    hooks.phase = 'error';
    if (loop) loop.stop();
    if (game) game.phase.to('error');
    if (audio) audio.suspend();
    // The one place a console error is wanted: a fatal error must be findable in the console too.
    consoleError.call(win.console, `VICE '86 stopped while ${where}:`, error);
    const title = `The game stopped while ${where}`;
    if (ui) {
      ui.error(title, error);
    } else if (root) {
      // The UI never started: use the static loading screen that index.html put on the page.
      const label = root.querySelector('.loading__label');
      const panel = root.querySelector('.loading');
      if (label) label.textContent = `${title}: ${reason}`;
      if (panel) panel.classList.add('is-failed');
    }
  }

  /** Errors that reach the window without passing through the boot or the frame loop. */
  listen(win, 'error', (event) => {
    if (event && event.message) automation.fail(`window: ${event.message}`);
  });
  listen(win, 'unhandledrejection', (event) => {
    const reason = event && event.reason;
    automation.fail(`promise: ${reason && reason.stack ? reason.stack : String(reason)}`);
  });

  const progress = (fraction, label) => { if (ui) ui.loading(fraction, label); };
  /** Lets the page paint the loading bar between two blocking pieces of work. */
  const breathe = () => new Promise((resolve) => win.setTimeout(resolve, 0));
  const nextFrame = () => new Promise((resolve) => win.requestAnimationFrame(resolve));

  try {
    // ---- UI shell and settings
    stage = 'starting the interface';
    const [uiModule, settingsModule, autotuneModule] = await Promise.all([loaders.ui(), loaders.settings(), loaders.autotune()]);
    const settings = settingsModule.loadSettings();
    if (options.quality) settingsModule.applyPreset(settings, options.quality);
    const actions = {
      start: () => game && game.start(),
      openGarage: () => game && game.openGarage(),
      closeGarage: () => game && game.closeGarage(),
      resume: () => game && game.resume(),
      pause: () => game && game.pause(),
      quitToMenu: () => game && game.quitToMenu(),
      setPaint: (index) => game && game.setPaint(index),
      // Resolves with the id of the car in the scene once the change is done (see game.setCar).
      setCar: (id) => (game ? game.setCar(id) : Promise.resolve(null)),
      // On the title screen the choice is where the drive will start; the dusk scene stays.
      setTime: (name) => { if (game && game.phase.name !== 'title') game.setTime(name); },
      setWeather: (name) => game && game.setWeather(name),
      applySettings: () => game && game.applySettings(),
      touchInput: (state) => input && input.setTouch(state),
      press: (name) => input && input.press(name),
      unlockAudio: () => { if (audio && !options.mute) audio.unlock(); },
      uiSound: (kind) => { if (audio) audio.ui(kind); },
    };
    ui = uiModule.createUI({ root, settings, actions, window: win });
    if (options.nohud) ui.setHidden(true);
    progress(PROGRESS.shell, 'Checking the graphics hardware');
    await breathe();

    // ---- renderer and device detection
    stage = 'starting the renderer';
    const rendererModule = await loaders.renderer();
    renderer = await rendererModule.createRenderer(canvas, {
      settings, split: options.split, forceWebGL2: options.webgl2 === 'force',
    });
    hooks.render = { split: renderer.split };
    // A context lost while loading (a graphics driver that gave up on a shader) must not leave the loading
    // screen standing: stop and say so, with the shader the renderer was busy with.
    const contextLost = () => new Error(`The WebGL context was lost. Last shader program compiled or first drawn: ${renderer.lastProgram || 'none'}.`);
    renderer.onContextLost = () => fail(contextLost(), stage);
    // A forced preset (quality=) is neither measured nor adjusted.
    const tuner = options.quality ? null : autotuneModule.createAutoTuner({ settings, caps: renderer.caps });
    if (tuner) ui.setDeviceInfo(tuner.info);
    progress(PROGRESS.renderer, 'Starting the physics');
    await breathe();

    // ---- physics
    stage = 'starting the physics';
    const physicsModule = await loaders.physics();
    const physics = await physicsModule.createPhysics();
    progress(PROGRESS.physics, 'Building the city');

    // ---- world, vehicle models and atlas, side by side
    stage = 'building the city';
    const done = { world: 0, models: 0, atlas: 0 };
    const assetProgress = (label) => {
      const share = done.world * ASSET_SHARE.world + done.models * ASSET_SHARE.models + done.atlas * ASSET_SHARE.atlas;
      progress(PROGRESS.physics + (PROGRESS.assets - PROGRESS.physics) * share, label);
    };
    // Tiles can arrive before the game exists; they are handed over once it does.
    const earlyTiles = [];
    const worldReady = loaders.world().then((worldModule) => worldModule.createWorld({
      renderer, physics, settings,
      onProgress: (fraction, label) => { done.world = fraction; assetProgress(label || 'Building the city'); },
      onTileLoaded: (tile) => {
        if (game) { game.tileLoaded(tile); return; }
        // A tile rebuilt before the game exists replaces its earlier arrival.
        const i = earlyTiles.findIndex((early) => early.key === tile.key);
        if (i >= 0) earlyTiles[i] = tile; else earlyTiles.push(tile);
      },
      onTileReleased: (key) => {
        if (game) { game.tileReleased(key); return; }
        const i = earlyTiles.findIndex((tile) => tile.key === key);
        if (i >= 0) earlyTiles.splice(i, 1);
      },
    })).then((world) => { done.world = 1; assetProgress('Building the city'); return world; });
    const workerOption = env.createWorker !== undefined ? { createWorker: env.createWorker } : {};
    const modelsReady = (env.buildModels || buildVehicleModels)({
      car: chooseCar(options.car, settings.game.car),
      onProgress: (fraction) => { done.models = fraction; assetProgress('Building the cars'); },
      ...workerOption,
    });
    const atlasReady = loaders.atlas().then(async (atlasModule) => {
      await breathe();
      const atlas = atlasModule.buildAtlas({ size: settings.graphics.preset === 'low' ? LOW_ATLAS_SIZE : ATLAS_SIZE });
      renderer.setAtlas(atlas);
      done.atlas = 1;
      assetProgress('Painting the surfaces');
    });
    const skyReady = Promise.all([loaders.sky(), loaders.lightning()]);
    const audioReady = loaders.audio();
    const [world, models, , [skyModule, lightningModule], audioModule] = await Promise.all([worldReady, modelsReady, atlasReady, skyReady, audioReady]);
    progress(PROGRESS.assets, 'Parking the car');

    // The sea needs the coast to break waves on, and the night sky the extent of the city
    // that lights its clouds. Both come from the plan; a renderer without them has no use for it.
    const skyDome = renderer.sky;
    if (skyDome && typeof skyDome.setShoreField === 'function' && world.plan.coast) skyDome.setShoreField(world.plan.coast);
    if (skyDome && typeof skyDome.setCity === 'function' && world.plan.bounds) {
      const [minX, minZ, maxX, maxZ] = world.plan.bounds;
      skyDome.setCity((minX + maxX) / 2, (minZ + maxZ) / 2, Math.min(maxX - minX, maxZ - minZ) / 2);
    }
    // ...and how brightly each district is lit, for the glow over it at night
    if (skyDome && typeof skyDome.setCityGlow === 'function' && typeof world.plan.districtAt === 'function') {
      skyDome.setCityGlow((x, z) => { const d = world.plan.districtAt(x, z); return d ? skyModule.districtLights(d.style) : 0; });
    }

    // ---- the game
    stage = 'preparing the car and the traffic';
    audio = audioModule.createAudio(options.seed === null ? {} : { seed: options.seed });
    input = createInput({
      keyTarget: win,
      getGamepads: () => (win.navigator && typeof win.navigator.getGamepads === 'function' ? win.navigator.getGamepads() : null),
    });
    const pacer = new FramePacer();
    game = createGame({
      renderer, physics, world, audio, ui, settings, models, options, input, tuner, now,
      buildCar: (id) => (env.buildCar || buildCarModel)(id, workerOption),
      buildGarage: (detail) => (env.buildGarage || buildGarageSet)({ detail, ...workerOption }),
      saveSettings: () => settingsModule.saveSettings(settings),
      sky: { deriveEnvironment: skyModule.deriveEnvironment, TIME_PRESETS: skyModule.TIME_PRESETS, createLightning: lightningModule.createLightning },
      onPhase: (phase) => { hooks.phase = phase; },
      onReady: () => { hooks.ready = true; },
      onSettings: (s) => { pacer.frameCap = s.graphics.frameCap || 0; },
    });
    for (const tile of earlyTiles) game.tileLoaded(tile);
    earlyTiles.length = 0;
    game.prepareTitle();
    automation.attach(game);

    // ---- the tiles of the first scene
    stage = 'loading the first scene';
    const sceneStart = now();
    let last = sceneStart;
    while (!world.isReady(game.player.pos, SCENE_RADIUS)) {
      const t = now(), elapsed = (t - sceneStart) / 1000;
      if (elapsed > SCENE_TIMEOUT_SECONDS) break;
      world.update(game.camera.position, Math.min(0.1, (t - last) / 1000));
      last = t;
      const pending = world.stats ? world.stats.tilesPending : 0, loaded = world.stats ? world.stats.tilesLoaded : 0;
      const share = loaded + pending > 0 ? loaded / (loaded + pending) : elapsed / SCENE_TIMEOUT_SECONDS;
      progress(PROGRESS.assets + (PROGRESS.scene - PROGRESS.assets) * share, 'Loading the streets');
      await nextFrame();
    }
    progress(PROGRESS.scene, 'Compiling shaders (first run only)');
    await breathe();

    // ---- shader warm-up, then a few frames behind the loading screen
    stage = 'preparing the shaders';
    await renderer.warmup((fraction) => progress(PROGRESS.scene + (PROGRESS.warmup - PROGRESS.scene) * fraction, 'Compiling shaders (first run only)'));
    // The context was lost and came back meanwhile: the player is looking at the error, not at a game to start.
    if (failed) throw new Error('stopped before the first frame');
    progress(PROGRESS.warmup, 'Ready');
    for (let i = 0; i < BLACK_FRAMES; i++) {
      game.frame(1 / 60);
      await nextFrame();
    }

    // ---- page events
    listen(win, 'resize', () => renderer.resize());
    // The picture itself is a control in the garage: a drag turns the view, the wheel and a
    // pinch move it closer. The input module takes them only while the garage asks for them.
    const pointer = (type) => (event) => {
      if (type === 'down' && typeof canvas.setPointerCapture === 'function') canvas.setPointerCapture(event.pointerId);
      input.handlePointer(type, event.pointerId, event.clientX, event.clientY, canvas.clientHeight);
    };
    listen(canvas, 'pointerdown', pointer('down'));
    listen(canvas, 'pointermove', pointer('move'));
    listen(canvas, 'pointerup', pointer('up'));
    listen(canvas, 'pointercancel', pointer('up'));
    listen(canvas, 'wheel', (event) => {
      if (!input.looking) return;
      event.preventDefault();
      input.handleWheel(event.deltaMode === 0 ? event.deltaY : event.deltaY * WHEEL_LINE_PIXELS);
    }, { passive: false });
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) {
        // Nobody is watching: stop the drive where it is and let the sound card rest.
        game.pause();
        input.releaseKeys();
        audio.suspend();
      } else {
        audio.resume();
        pacer.restart();
      }
    });
    // The renderer rebuilds its own objects; the game only has to stop asking for frames meanwhile.
    // A context that does not come back is an error like any other, not a frozen picture.
    let restoreTimer = 0;
    renderer.onContextLost = () => {
      pacer.paused = true; game.pause();
      restoreTimer = win.setTimeout(() => fail(contextLost(), 'waiting for the graphics card to come back'), CONTEXT_RESTORE_MS);
    };
    renderer.onContextRestored = () => { win.clearTimeout(restoreTimer); pacer.paused = false; pacer.restart(); };

    // ---- go
    stage = 'running';
    game.begin();
    loop = runFrameLoop(
      { requestFrame: (cb) => win.requestAnimationFrame(cb), cancelFrame: (id) => win.cancelAnimationFrame(id) },
      pacer,
      (dt) => { if (!pacer.paused) game.frame(dt, pacer.lastFrameMs); },
      (error) => fail(error, 'running'),
    );
  } catch (error) {
    fail(error, stage);
  }

  return {
    game,
    hooks,
    stop() {
      if (loop) loop.stop();
      for (const cleanup of cleanups) cleanup();
      if (input) input.dispose();
      if (game) game.dispose();
      if (ui) ui.dispose();
    },
  };
}

// On the page: start. Under Node (tests) the module is only imported.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot({ window, document });
}
