// The garage overlay: what is drawn over the 3D garage while the player chooses a car and a colour.
//
// Everything sits at the edges of the frame so that the car and its reflection stay clear: the
// car's name at the upper left, an arrow at each side edge, the statistics at the lower left, the
// colours and Drive at the lower right, the prompts along the foot (on an upright screen the
// statistics, the colours and Drive stack at the bottom). The layer itself takes no
// pointer events; only its buttons do, so a drag that starts anywhere else reaches the canvas and
// turns the view.
//
// The game owns the state (which car is in the room, whether one is being built, the colours of
// the car and which is on it) and pushes it in through setCars, setCarState and setPaints. The
// overlay asks for changes through actions.setCar(id) and actions.setPaint(index) and draws what
// it is told. Statistics come from the physics specification through `describe`.

import { el, attrs, textWriter, classWriter, styleWriter, attrWriter } from './dom.js';
import { icon } from './icons.js';
import { pressable, hintLine } from './controls.js';
import { INTENT } from './menu-model.js';
import { garageView, carStats, stepCar, swatchColumns, paintCss, paintFinish, paintCaption, GARAGE_PROMPTS, STAT_COUNT } from './garage-model.js';

/**
 * options: { doc, parent, settings, actions, describe, save, onDrive, onBack }
 *   describe(id)   the statistics of a car: describeSpec(carSpec(id))
 *   save()         schedule a write of the settings
 *   onDrive / onBack   the UI-level transitions (index.js switches layers, then calls the game)
 * Returns { el, isOpen, open(), close(), intent(i), refresh(), setCars(list, id),
 *           setCarState(state), setPaints(list, index, names) }.
 */
export function createGarage({ doc, parent, settings, actions, describe, save, onDrive, onBack }) {
  let cars = [];
  let state = { id: settings.game.car, status: 'ready', wanted: null };
  let paints = [];
  let paintNames = null;
  let chips = [];
  let marked = -1;   // index of the chip drawn as chosen, -1 after the chips were rebuilt

  const sound = (kind) => { if (actions.uiSound) actions.uiSound(kind); };

  // ---- upper left: where you are, and the car
  const back = pressable(doc, 'garage__back', 'Back', () => garage.intent(INTENT.BACK), icon(doc, 'back'), el(doc, 'span', 'garage__back-text', 'Back'));
  const count = el(doc, 'span', 'garage__count');
  const name = el(doc, 'h2', 'garage__name');
  const line = el(doc, 'div', 'garage__line');
  const note = el(doc, 'div', 'garage__note');
  attrs(note, { role: 'status', 'aria-live': 'polite' });
  const head = el(doc, 'div', 'garage__head', back, el(doc, 'div', 'garage__place', el(doc, 'span', 'garage__kicker', 'Garage'), count), name, line, note);

  // ---- side edges: previous and next car
  const previous = pressable(doc, 'garage__arrow garage__arrow--previous', 'Previous car', () => garage.intent(INTENT.LEFT), icon(doc, 'previous'));
  const next = pressable(doc, 'garage__arrow garage__arrow--next', 'Next car', () => garage.intent(INTENT.RIGHT), icon(doc, 'next'));

  // ---- lower left: statistics
  const statRows = [];
  const stats = el(doc, 'div', 'garage__stats');
  for (let i = 0; i < STAT_COUNT; i++) {
    const label = el(doc, 'span', 'stat__label');
    const value = el(doc, 'span', 'stat__value');
    const unit = el(doc, 'span', 'stat__unit');   // a part of the figure: sized against it, not on its own
    const fill = el(doc, 'span', 'stat__fill');
    stats.appendChild(el(doc, 'div', 'stat', label, el(doc, 'span', 'stat__figure', value, unit), el(doc, 'span', 'stat__bar', fill)));
    statRows.push({ label: textWriter(label), value: textWriter(value), unit: textWriter(unit), fill: styleWriter(fill, '--fill') });
  }
  const layout = el(doc, 'div', 'garage__layout');
  stats.appendChild(layout);

  // ---- lower right: colours and Drive
  const swatches = el(doc, 'div', 'garage__swatches');
  attrs(swatches, { role: 'radiogroup', 'aria-label': 'Colour' });
  const caption = el(doc, 'div', 'garage__caption');
  const drive = pressable(doc, 'garage__drive', 'Drive', () => garage.intent(INTENT.ACCEPT), 'Drive');
  const side = el(doc, 'div', 'garage__side', el(doc, 'div', 'garage__label', 'Colour'), swatches, caption, drive);

  // ---- foot: prompts for the device in use (CSS shows one line, or none on a touch screen)
  const prompts = el(doc, 'div', 'garage__prompts',
    hintLine(doc, 'garage__prompt--keys', GARAGE_PROMPTS.keys),
    hintLine(doc, 'garage__prompt--pad', GARAGE_PROMPTS.pad));

  const root = el(doc, 'div', 'garage', head, previous, next, el(doc, 'div', 'garage__foot', stats, side), prompts);
  attrs(root, { role: 'region', 'aria-label': 'Garage' });
  parent.appendChild(root);

  const write = {
    name: textWriter(name), line: textWriter(line), count: textWriter(count), note: textWriter(note),
    layout: textWriter(layout), caption: textWriter(caption),
    choice: classWriter(root, 'has-choice'), building: classWriter(root, 'is-building'), failed: classWriter(root, 'is-failed'),
    driveOff: classWriter(drive, 'is-disabled'), driveAria: attrWriter(drive, 'aria-disabled'),
  };

  const paintIndex = () => Math.min(settings.game.paint, paints.length - 1);
  const canDrive = () => state.status !== 'building';

  /** Asks the game for the car `delta` places on. The row answers at once; the room follows. */
  function stepCarBy(delta) {
    if (cars.length < 2 || !actions.setCar) return false;
    const id = stepCar(cars, garageView(cars, state).car.id, delta);
    state = { id: state.id, status: 'building', wanted: id };
    actions.setCar(id);
    sound('move');
    garage.refresh();
    return true;
  }

  function choosePaint(index) {
    if (state.status === 'building' || index === paintIndex() || !paints[index]) return false;
    settings.game.paint = index;
    if (actions.setPaint) actions.setPaint(index);   // the game sounds the change of colour itself
    save();
    garage.refresh();
    return true;
  }

  function buildSwatches() {
    chips = paints.map((paint, index) => {
      const chip = el(doc, 'span', `garage__swatch garage__swatch--${paintFinish(paint).key}`);
      chip.style.setProperty('--paint', paintCss(paint));
      attrs(chip, { role: 'radio', 'aria-label': paintCaption(paints, index, paintNames) });
      chip.addEventListener('click', () => choosePaint(index));
      return chip;
    });
    swatches.replaceChildren(...chips);
    swatches.style.setProperty('--columns', String(swatchColumns(chips.length)));
    marked = -1;
  }

  const garage = {
    el: root,
    isOpen: false,

    open() {
      if (garage.isOpen) return;
      garage.isOpen = true;
      root.classList.add('is-on');
      garage.refresh();
    },

    close() {
      if (!garage.isOpen) return;
      garage.isOpen = false;
      root.classList.remove('is-on');
    },

    /** Handles one navigation intent. Returns true when it had an effect. */
    intent(intent) {
      if (!garage.isOpen) return false;
      switch (intent) {
        case INTENT.LEFT:
        case INTENT.TAB_PREV: return stepCarBy(-1);
        case INTENT.RIGHT:
        case INTENT.TAB_NEXT: return stepCarBy(1);
        case INTENT.UP: return paints.length > 1 && choosePaint((paintIndex() - 1 + paints.length) % paints.length);
        case INTENT.DOWN: return paints.length > 1 && choosePaint((paintIndex() + 1) % paints.length);
        case INTENT.ACCEPT:
          if (!canDrive()) return false;
          sound('select');
          onDrive();
          return true;
        case INTENT.BACK:
          sound('back');
          onBack();
          return true;
        default:
          return false;
      }
    },

    /** Redraws from the current state. Every write is skipped when the value has not changed. */
    refresh() {
      if (!garage.isOpen) return;
      const view = garageView(cars, state);
      write.choice(cars.length > 1);
      write.building(view.building);
      write.failed(state.status === 'failed');
      write.driveOff(!canDrive());
      write.driveAria(String(!canDrive()));
      write.name(view.car ? view.car.name : '');
      write.line(view.car ? view.car.line : '');
      write.count(view.position);
      write.note(view.note);

      if (view.car) {
        const figures = carStats(cars, view.car.id, describe, settings.game.units);
        for (let i = 0; i < STAT_COUNT; i++) {
          const row = figures.rows[i];
          statRows[i].label(row.label);
          statRows[i].value(row.value);
          statRows[i].unit(row.unit);
          statRows[i].fill(row.fraction === null ? '0' : row.fraction.toFixed(3));
        }
        write.layout(figures.layout);
      }

      const chosen = paintIndex();
      if (chosen !== marked) {
        chips.forEach((chip, index) => {
          chip.classList.toggle('is-on', index === chosen);
          chip.setAttribute('aria-checked', String(index === chosen));
        });
        marked = chosen;
      }
      write.caption(paintCaption(paints, chosen, paintNames));
    },

    /** The cars to choose from, [{ id, name, line }], and the one in the room. */
    setCars(list, id) {
      cars = Array.isArray(list) ? list : [];
      state = { id, status: 'ready', wanted: null };
      garage.refresh();
    },

    /** { id, status: 'ready' | 'building' | 'failed', wanted }: see garage-model.js. */
    setCarState(next) {
      state = { id: next.id, status: next.status, wanted: next.wanted === undefined ? null : next.wanted };
      garage.refresh();
    },

    /** The colours of the car in the room (linear [r, g, b, finish]), the one on it, and their names if they have any. */
    setPaints(list, index, names) {
      paints = Array.isArray(list) ? list : [];
      paintNames = Array.isArray(names) ? names : null;
      if (Number.isInteger(index) && index >= 0 && index < paints.length) settings.game.paint = index;
      buildSwatches();
      garage.refresh();
    },
  };
  return garage;
}
