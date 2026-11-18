// Menu controller: the title menu, the pause menu and their panels (time and weather, settings,
// controls reference).
//
// Layout: the root list (title or pause) sits in a column at the left over the live scene. A
// screen the player goes into replaces the list in that column (time and weather), or
// takes the whole screen for the long pages (settings, controls). Screens form a stack; back pops it.
//
// Input: every device is reduced to the intents in menu-model.js and handled by intent() below.
// index.js feeds keyboard and gamepad intents; rows handle their own pointer events and call back
// in here.
//
// Settings: every change goes through change(), which updates the settings object in place,
// notifies the game (actions.applySettings, plus setTime / setWeather for the options that have a
// dedicated action) and saves shortly afterwards.

import { el, attrs } from './dom.js';
import { hintLine } from './controls.js';
import { icon } from './icons.js';
import { wordmark } from './wordmark.js';
import { INTENT, nextFocusable, firstFocusable } from './menu-model.js';
import { buildScreens } from './screens.js';
import { applyPreset, setOption, TIME_OPTIONS, FALLBACK_PRESET } from './settings.js';

/** Pixels a panel without focusable rows scrolls per up / down press. */
const SCROLL_STEP = 80;

/**
 * options: { doc, parent, settings, actions, save, onResume, onPlay, onQuit }
 *   save()   schedule a write of the settings
 *   onResume / onPlay / onQuit are the UI-level transitions (index.js switches layers and then
 *   calls the game's action).
 * Returns { el, isOpen, root, open(rootId), close(), intent(i), refresh(), setDeviceInfo(info) }.
 */
export function createMenu({ doc, parent, settings, actions, save, onResume, onPlay, onQuit }) {
  let deviceInfo = null;

  // ---- structure
  const brand = el(doc, 'div', 'menu__brand', wordmark(doc));
  const heading = el(doc, 'div', 'menu__heading');       // "Paused" over the pause list
  const rootList = el(doc, 'div', 'menu__list');
  const nav = el(doc, 'div', 'menu__nav', heading, rootList);

  const panelTitle = el(doc, 'h2', 'panel__title');
  const backButton = el(doc, 'span', 'panel__back', icon(doc, 'back'), el(doc, 'span', 'panel__back-text', 'Back'));
  attrs(backButton, { role: 'button', 'aria-label': 'Back' });
  const tabBar = el(doc, 'div', 'panel__tabs');
  attrs(tabBar, { role: 'tablist' });
  const body = el(doc, 'div', 'panel__body');
  const panel = el(doc, 'div', 'menu__panel', el(doc, 'div', 'panel__head', backButton, panelTitle), tabBar, body);
  attrs(panel, { role: 'dialog', 'aria-modal': 'true' });

  // One sentence about the focused row, and the key hints (CSS hides them where touch is primary).
  const help = el(doc, 'div', 'menu__desc');
  attrs(help, { 'aria-live': 'polite' });
  const hints = el(doc, 'div', 'menu__hints',
    hintLine(doc, 'menu__hint--list', [[['Enter'], 'select'], [['Esc'], 'back'], [['\u2191', '\u2193'], 'move']]),
    hintLine(doc, 'menu__hint--page', [[['\u2190', '\u2192'], 'change'], [['Q', 'E'], 'tab', 'menu__hint-item--tabs'], [['Esc'], 'back']]));

  const root = el(doc, 'div', 'menu', brand, nav, panel, help, hints);
  parent.appendChild(root);

  // ---- screens and their mounted row lists
  const sound = (kind) => { if (actions.uiSound) actions.uiSound(kind); };

  const ctx = {
    doc, settings, actions,
    open: (id) => openPanel(id),
    change,
    play: () => onPlay(),
    resume: () => onResume(),
    quit: () => onQuit(),
    recover: () => { if (actions.press) actions.press('recover'); onResume(); },
    deviceInfo: () => deviceInfo,
  };
  const screens = buildScreens(ctx);

  // One mounted list per screen and tab: { rows, el }. Built on first use.
  const lists = new Map();
  function listFor(screen, tab) {
    const key = `${screen.id}:${tab}`;
    let list = lists.get(key);
    if (!list) {
      const rows = screen.build(tab);
      const container = el(doc, 'div', 'rows');
      for (const row of rows) {
        row.requestFocus = focusRow;
        container.appendChild(row.el);
      }
      list = { rows, el: container };
      lists.set(key, list);
    }
    return list;
  }

  // ---- state
  const stack = [];          // [{ screen, tab, focus }]
  let current = null;        // the mounted list of the top of the stack
  let tabNodes = [];

  const top = () => stack[stack.length - 1];
  const flags = () => current.rows.map((row) => row.focusable);

  function refreshList(list) {
    for (const row of list.rows) row.refresh();
  }

  function setFocus(index, scroll = true) {
    const entry = top();
    const previous = current.rows[entry.focus];
    if (previous) previous.el.classList.remove('is-focus');
    entry.focus = index;
    const row = current.rows[index];
    help.textContent = row ? row.help : '';
    if (!row) return;
    row.el.classList.add('is-focus');
    if (row.el.focus) row.el.focus({ preventScroll: true });
    if (scroll && entry.screen.kind === 'panel' && row.el.scrollIntoView) row.el.scrollIntoView({ block: 'nearest' });
  }

  function focusRow(row) {
    if (!current || !row.focusable) return;
    const index = current.rows.indexOf(row);
    // Pointer focus must not scroll: the list would run away from under the cursor.
    if (index >= 0 && index !== top().focus) setFocus(index, false);
  }

  /** Shows the top of the stack: mounts its list, restores focus, updates the chrome around it. */
  function show() {
    const entry = top();
    const { screen } = entry;
    const isPanel = screen.kind === 'panel';
    const rootScreen = stack[0].screen;

    root.setAttribute('data-root', rootScreen.id);
    root.setAttribute('data-page', screen.id);
    root.classList.toggle('has-panel', isPanel);
    root.classList.toggle('has-tabs', isPanel && Boolean(screen.tabs));
    panel.classList.toggle('is-wide', Boolean(screen.wide));
    heading.textContent = rootScreen.title || '';

    // The root list stays mounted while a panel is open (CSS hides it), so popping back is immediate.
    const rootMounted = listFor(rootScreen, 0);
    if (rootList.firstChild !== rootMounted.el) rootList.replaceChildren(rootMounted.el);
    refreshList(rootMounted);

    if (isPanel) {
      panelTitle.textContent = screen.title;
      panel.setAttribute('aria-label', screen.title);
      const tabs = screen.tabs || [];
      tabNodes = tabs.map((label, i) => {
        const tab = el(doc, 'span', 'panel__tab', label);
        attrs(tab, { role: 'tab', 'aria-selected': String(i === entry.tab) });
        tab.classList.toggle('is-on', i === entry.tab);
        tab.addEventListener('click', () => setTab(i));
        return tab;
      });
      tabBar.replaceChildren(...tabNodes);
      tabBar.classList.toggle('is-on', tabs.length > 0);
      current = listFor(screen, entry.tab);
      body.replaceChildren(current.el);
      body.scrollTop = 0;
    } else {
      current = rootMounted;
    }

    refreshList(current);
    const focusable = flags();
    setFocus(focusable[entry.focus] ? entry.focus : firstFocusable(focusable));
  }

  const unfocus = (list, index) => { const row = list && list.rows[index]; if (row) row.el.classList.remove('is-focus'); };

  /** Opens a screen over the root list. Only the root list can open one, so the stack is two deep. */
  function openPanel(id) {
    const screen = screens[id];
    if (!screen) throw new Error(`Unknown menu screen: ${id}`);
    if (stack.length > 1) {
      unfocus(current, top().focus);
      stack.length = 1;
    }
    stack.push({ screen, tab: 0, focus: -1 });
    sound('select');
    show();
  }

  function pop() {
    if (stack.length <= 1) return false;
    unfocus(current, top().focus);
    stack.pop();
    sound('back');
    show();
    return true;
  }

  function setTab(index) {
    const entry = top();
    const count = entry.screen.tabs ? entry.screen.tabs.length : 0;
    if (count === 0) return false;
    const next = Math.min(count - 1, Math.max(0, index));
    if (next === entry.tab) return false;
    unfocus(current, entry.focus);
    entry.tab = next;
    entry.focus = -1;
    sound('move');
    show();
    return true;
  }

  // ---- settings changes
  /** Sets one option, redraws, tells the game, saves. The single path for every settings edit. */
  function change(section, key, value) {
    if (section === 'graphics' && key === 'preset') {
      if (settings.graphics.preset === value) return;
      applyPreset(settings, value, deviceInfo ? deviceInfo.autoPreset : FALLBACK_PRESET);
    } else if (!setOption(settings, section, key, value)) {
      return;
    }
    if (section === 'game' && key === 'startTime' && actions.setTime) {
      actions.setTime(value, TIME_OPTIONS.find((o) => o.value === value).hours);
    } else if (section === 'game' && key === 'weather' && actions.setWeather) {
      actions.setWeather(value);
    }
    if (actions.applySettings) actions.applySettings(settings);
    save();
    sound('adjust');
    menu.refresh();
  }

  backButton.addEventListener('click', () => menu.intent(INTENT.BACK));

  const menu = {
    el: root,
    isOpen: false,
    /** 'title' or 'pause' while open, otherwise null. */
    root: null,

    /** Opens the title or pause menu at its top level. Calling it again for the same root is a no-op. */
    open(rootId) {
      if (menu.isOpen && menu.root === rootId) return;
      for (const entry of stack) unfocus(lists.get(`${entry.screen.id}:${entry.tab}`), entry.focus);
      stack.length = 0;
      stack.push({ screen: screens[rootId], tab: 0, focus: -1 });
      menu.isOpen = true;
      menu.root = rootId;
      root.classList.add('is-on');
      show();
    },

    close() {
      if (!menu.isOpen) return;
      menu.isOpen = false;
      menu.root = null;
      root.classList.remove('is-on');
    },

    /** Handles one navigation intent. Returns true when it had an effect. */
    intent(intent) {
      if (!menu.isOpen) return false;
      const entry = top();
      switch (intent) {
        case INTENT.UP:
        case INTENT.DOWN: {
          const delta = intent === INTENT.DOWN ? 1 : -1;
          const next = nextFocusable(flags(), entry.focus, delta);
          if (next < 0) { body.scrollTop += delta * SCROLL_STEP; return true; }   // a reference page: scroll it
          if (next === entry.focus) return false;
          setFocus(next);
          sound('move');
          return true;
        }
        case INTENT.LEFT:
        case INTENT.RIGHT:
        case INTENT.ACCEPT: {
          const row = current.rows[entry.focus];
          return Boolean(row && row.intent(intent));
        }
        case INTENT.TAB_PREV: return setTab(entry.tab - 1);
        case INTENT.TAB_NEXT: return setTab(entry.tab + 1);
        case INTENT.BACK:
          if (pop()) return true;
          if (menu.root === 'pause') { onResume(); return true; }
          return false;
        case INTENT.MENU:
          if (menu.root === 'pause') { onResume(); return true; }
          return false;
        default:
          return false;
      }
    },

    /** Re-reads every visible value (after a change here, or when the game changed something). */
    refresh() {
      if (!menu.isOpen) return;
      refreshList(listFor(stack[0].screen, 0));
      if (current) refreshList(current);
      const focusable = flags();
      if (!focusable[top().focus]) setFocus(firstFocusable(focusable));
    },

    setDeviceInfo(info) {
      deviceInfo = info || null;
      menu.refresh();
    },
  };
  return menu;
}
