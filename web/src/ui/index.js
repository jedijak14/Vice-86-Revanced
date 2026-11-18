// VICE '86 user interface: DOM and CSS over the game canvas (ARCHITECTURE 11.3).
//
//   import { createUI } from './ui/index.js';
//   const ui = createUI({ root, settings, actions });
//
// root      the overlay element (#ui in index.html), which already holds the static first-paint
//           copy of the loading screen.
// settings  the object from loadSettings(); edited in place by the menus.
// actions   callbacks into the game; every one is optional:
//             openGarage()                  Play was chosen on the title menu (the garage overlay is already up)
//             closeGarage()                 Back in the garage (the title menu is already up)
//             start()                       Drive was chosen in the garage (the UI has already hidden itself)
//             setCar(id)                    previous / next car in the garage; the game answers through setCarState
//             resume()                      leave the pause menu (the HUD is already back)
//             pause()                       the touch pause button
//             quitToMenu()                  Quit to title (the UI then shows the title menu)
//             applySettings(settings)       after every settings change, live
//             setPaint(index)               a colour of the car in the garage
//             setTime(presetName, hours)    dawn | morning | noon | afternoon | golden | dusk | night
//             setWeather(name)              clear | dynamic | rain | storm
//             touchInput(state), press(name)   touch controls, see touch.js
//             unlockAudio()                 first key press or pointer press on the page
//             uiSound(kind)                 'move' | 'adjust' | 'select' | 'back'
//
// Returned object:
//   loading(fraction, label)   show the loading screen at this progress
//   showTitle() showGarage() showPause() showHud() hideAll()      switch layer; all idempotent
//   error(title, detail)       fatal error panel; detail may be an Error
//   hud.update({ speed, rpm, redline, gear, headlamps, handbrake, clock, district, heading,
//                position, nitrous, boosting })   every frame while driving (see hud.js)
//   setMinimapPainter(fn(ctx, sizePx))
//   toast(text)
//   setCars(list, currentId)           the cars of the garage, [{ id, name, line }], and the one in the room
//   setCarState({ id, status, wanted }) status 'ready' | 'building' | 'failed'; id is the car in the room,
//                                      wanted the one being built or the one that failed
//   setPaints(paints, currentIndex, names)   colours of the car in the room, linear [r, g, b, finish] with finish
//                                      0 solid, 1 metallic, 2 pearl; names optional, parallel to paints
//   setDeviceInfo(info)                describeGraphics() result (+ autoPreset, refined) for the Graphics tab
//   setState({ time, weather, paint }) the game changed these itself (T and Y keys); re-sync the menus
//   setHidden(bool)                    suppress every layer except a fatal error (nohud=1)
//   screen                             'loading' | 'title' | 'garage' | 'pause' | 'hud' | 'error' | 'none'
//   menuOpen                           true while the title menu, the pause menu or the garage has the keyboard
//   dispose()                          remove the window listeners
//
// Keyboard: while a menu or the garage is open the UI handles navigation keys in the capture phase
// on window and stops them there, so the game's own key handlers never see them. With neither open
// the UI consumes no keys at all (Esc while driving belongs to the game, which calls showPause()).
// In the garage the UI takes the arrow keys, Enter and Esc and their gamepad equivalents; dragging,
// the wheel and the right stick are left to the game for turning the view.

import { createHud } from './hud.js';
import { createMenu } from './menu.js';
import { createGarage } from './garage.js';
import { createTouchControls, isTouchPrimary } from './touch.js';
import { createLoading, createErrorScreen, createToast } from './screens-system.js';
import { keyIntent, INTENT, createGamepadReader, pickGamepad } from './menu-model.js';
import { TIME_OPTIONS, WEATHER_OPTIONS, createSaver } from './settings.js';
import { fitDisplayType } from './type.js';
import { releasedCars } from '../vehicles/cars.js';
import { carSpec, describeSpec } from '../physics/specs.js';

// Intents that must not auto-repeat while a key is held down.
const NO_REPEAT = new Set([INTENT.ACCEPT, INTENT.BACK, INTENT.TAB_PREV, INTENT.TAB_NEXT]);

export function createUI({ root, settings, actions = {}, window: win = root.ownerDocument.defaultView, storage }) {
  const doc = root.ownerDocument;
  const clock = () => (win && win.performance ? win.performance.now() : Date.now());
  fitDisplayType(root);   // before anything is built: the one layout read the interface makes

  let screen = 'none';
  let touchMode = isTouchPrimary(win);
  let menuOpenedAt = 0;
  let audioUnlocked = false;
  const saver = createSaver(settings, storage, win);

  const loading = createLoading({ doc, parent: root, win });
  const toast = createToast({ doc, parent: root, win });
  const hud = createHud({ doc, parent: root, settings, win, now: clock });
  const touch = createTouchControls({ doc, parent: root, actions });
  const menu = createMenu({
    doc, parent: root, settings, actions, save: saver.schedule,
    onPlay() {
      setScreen('garage');
      unlockAudio();
      if (actions.openGarage) actions.openGarage();
    },
    onResume() {
      setScreen('hud');
      if (actions.resume) actions.resume();
    },
    onQuit() {
      if (actions.quitToMenu) actions.quitToMenu();
      setScreen('title');
    },
  });
  const garage = createGarage({
    doc, parent: root, settings, actions, save: saver.schedule,
    describe: (id) => describeSpec(carSpec(id)),
    onDrive() {
      setScreen('none');
      if (actions.start) actions.start();
    },
    onBack() {
      setScreen('title');
      if (actions.closeGarage) actions.closeGarage();
    },
  });
  // Until the game says otherwise (setCars), the garage holds the finished cars of the registry.
  garage.setCars(releasedCars().map(({ id, name, line }) => ({ id, name, line })), settings.game.car);
  const errorScreen = createErrorScreen({ doc, parent: root, win });

  /** The layer that has the keyboard and the gamepad, or null. */
  const navigable = () => (menu.isOpen ? menu : garage.isOpen ? garage : null);

  root.classList.toggle('is-touch', touchMode);
  if (loading.visible) screen = 'loading';
  root.setAttribute('data-screen', screen);

  /** The one place layers are switched. */
  function setScreen(next) {
    if (screen === 'error') return;          // a fatal error is final
    if (next === screen) return;
    screen = next;
    root.setAttribute('data-screen', next);

    if (next === 'loading') loading.show(); else loading.hide();
    if (next === 'hud') hud.show(); else hud.hide();
    touch.setActive(next === 'hud' && touchMode);
    if (next === 'title' || next === 'pause') menu.open(next); else menu.close();
    if (next === 'garage') garage.open(); else garage.close();
    if (navigable()) {
      menuOpenedAt = clock();
      startPolling();
    } else {
      saver.flush();
    }
  }

  /** Which prompts are shown: those of the device last used ('keys', 'pad' or 'touch'). */
  let inputMode = '';
  function setInputMode(mode) {
    if (mode === inputMode) return;
    inputMode = mode;
    root.setAttribute('data-input', mode);
  }
  setInputMode(touchMode ? 'touch' : 'keys');

  function setTouchMode(on) {
    if (on === touchMode) return;
    touchMode = on;
    root.classList.toggle('is-touch', on);
    touch.setActive(screen === 'hud' && on);
    setInputMode(on ? 'touch' : 'keys');
  }

  function unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    if (actions.unlockAudio) actions.unlockAudio();
  }

  // ---- window listeners
  function onKeyDown(event) {
    unlockAudio();
    // A keyboard in use on a laptop with a touch screen: put the touch controls away again.
    if (touchMode && !isTouchPrimary(win)) setTouchMode(false);
    const layer = navigable();
    if (!layer) return;
    // The key press that opened the menu (Esc to pause) may still be travelling through the
    // game's listeners; it must not also act on the menu it just opened.
    if (event.timeStamp > 0 && event.timeStamp < menuOpenedAt) return;
    const intent = keyIntent(event);
    if (!intent) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Nothing repeats in the garage: a held key would run through the cars faster than they can be shown.
    if (event.repeat && (layer === garage || NO_REPEAT.has(intent))) return;
    if (!touchMode) setInputMode('keys');
    layer.intent(intent);
  }

  // ---- gamepad: polled only while a menu or the garage is open
  const reader = createGamepadReader();
  const padIntents = [];
  let polling = null;
  function poll() {
    polling = null;
    if (!navigable()) return;
    const pads = win.navigator && win.navigator.getGamepads ? win.navigator.getGamepads() : null;
    padIntents.length = 0;
    reader.read(pickGamepad(pads), clock(), padIntents);
    if (padIntents.length > 0) setInputMode('pad');
    for (let i = 0; i < padIntents.length; i++) {
      const layer = navigable();
      if (!layer) break;
      layer.intent(padIntents[i]);
    }
    if (navigable()) polling = win.requestAnimationFrame(poll);
  }
  /** Called when a layer opens: whatever is held on the pad right now (the press that opened it) is ignored. */
  function startPolling() {
    reader.reset();
    if (polling === null && win && win.requestAnimationFrame) polling = win.requestAnimationFrame(poll);
  }

  function onPointerDown(event) {
    unlockAudio();
    if (event.pointerType === 'touch') setTouchMode(true);
    else if (event.pointerType === 'mouse' && !touchMode) setInputMode('keys');
  }

  function onVisibility() {
    if (doc.visibilityState !== 'hidden') return;
    touch.reset();     // a finger cannot be lifted from a hidden page
    saver.flush();
  }

  const listeners = [
    [win, 'keydown', onKeyDown, true],
    [win, 'pointerdown', onPointerDown, true],
    [win, 'pagehide', saver.flush, false],
    [doc, 'visibilitychange', onVisibility, false],
  ];
  for (const [target, type, handler, capture] of listeners) {
    if (target && target.addEventListener) target.addEventListener(type, handler, capture);
  }

  const ui = {
    hud: { update: hud.update },

    get screen() { return screen; },
    get menuOpen() { return navigable() !== null; },

    loading(fraction, label) {
      setScreen('loading');
      loading.set(fraction, label);
    },
    showTitle() { setScreen('title'); },
    showGarage() { setScreen('garage'); },
    showPause() { setScreen('pause'); },
    showHud() { setScreen('hud'); },
    hideAll() { setScreen('none'); },

    error(title, detail) {
      setScreen('none');
      screen = 'error';
      root.setAttribute('data-screen', 'error');
      errorScreen.show(title, detail);
    },

    toast(text) { toast.show(text); },
    setMinimapPainter(fn) { hud.setMinimapPainter(fn); },
    setCars(list, currentId) { garage.setCars(list, currentId); },
    setCarState(state) { garage.setCarState(state); },
    setPaints(paints, currentIndex, names) { garage.setPaints(paints, currentIndex, names); },
    setDeviceInfo(info) { menu.setDeviceInfo(info); },

    setState({ time, weather, paint } = {}) {
      if (TIME_OPTIONS.some((o) => o.value === time)) settings.game.startTime = time;
      if (WEATHER_OPTIONS.some((o) => o.value === weather)) settings.game.weather = weather;
      if (Number.isInteger(paint) && paint >= 0) settings.game.paint = paint;
      menu.refresh();
      garage.refresh();
    },

    setHidden(hidden) { root.classList.toggle('is-hidden', Boolean(hidden)); },

    dispose() {
      for (const [target, type, handler, capture] of listeners) {
        if (target && target.removeEventListener) target.removeEventListener(type, handler, capture);
      }
      menu.close();
      garage.close();
      saver.flush();
    },
  };
  return ui;
}
