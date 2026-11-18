// Menu rows: the visible controls that the menu screens are assembled from.
//
// Every row has the same small interface so the menu can treat them alike:
//   el          the row's element
//   focusable   whether up / down can stop on it
//   help        one sentence explaining the option, shown at the foot of the page while focused
//   intent(i)   handle LEFT, RIGHT or ACCEPT for this row; returns true when it did something
//   refresh()   re-read the bound value and redraw
//   requestFocus  set by the menu; rows call it when the pointer reaches them
//
// Rows never keep a copy of a value: they read it through their binding ({ get, set }) every time,
// so a preset change or a value changed elsewhere shows up on the next refresh.
//
// Controls are plain elements with ARIA roles rather than native buttons: the menu handles every
// key itself, and native buttons would activate a second time on Enter and Space.

import { el, attrs } from './dom.js';
import { icon } from './icons.js';
import { INTENT } from './menu-model.js';
import { formatValue, stepValue, valueFraction, sanitizeValue } from './settings.js';

/** Wires the pointer behaviour common to all rows: hovering or pressing a row focuses it. */
function focusOnPointer(row) {
  const ask = () => { if (row.requestFocus) row.requestFocus(row); };
  row.el.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') ask(); });
  row.el.addEventListener('pointerdown', ask);
  return row;
}

/** A clickable element that is not a native button (see the note at the top of the file). */
export function pressable(doc, className, label, onPress, ...children) {
  const node = el(doc, 'span', className, ...children);
  attrs(node, { role: 'button', 'aria-label': label });
  node.addEventListener('click', (event) => { event.stopPropagation(); onPress(); });
  return node;
}

/**
 * A line of key hints: parts is [[keys, label, className?]], each key name in an outlined box
 * followed by what it does.
 */
export function hintLine(doc, className, parts) {
  const line = el(doc, 'div', `menu__hint ${className}`.trim());
  for (const [keys, label, extra] of parts) {
    line.appendChild(el(doc, 'span', `menu__hint-item ${extra || ''}`.trim(), ...keys.map((name) => el(doc, 'kbd', 'key', name)), label));
  }
  return line;
}

// ---------------------------------------------------------------- plain rows

/** Non-interactive text. `update(node)` is called on refresh to fill it in. */
export function noteRow(doc, className, update) {
  const node = el(doc, 'div', `row-note ${className || ''}`.trim());
  return { el: node, focusable: false, help: '', intent: () => false, refresh() { update(node); } };
}

/**
 * A menu item that does something. options: { label, detail?, help?, onAccept, enabled?: () => boolean, large? }.
 * `detail` may be a function returning the current text shown at the right (for example the chosen time of day).
 */
export function actionRow(doc, { label, detail, help = '', onAccept, enabled, large = false }) {
  const detailNode = detail ? el(doc, 'span', 'row__detail') : null;
  const node = el(doc, 'div', `row row--action${large ? ' row--large' : ''}`, el(doc, 'span', 'row__label', label), detailNode);
  attrs(node, { role: 'button', tabindex: -1 });
  const row = {
    el: node,
    focusable: true,
    help,
    intent(intent) {
      if (intent !== INTENT.ACCEPT || !row.focusable) return false;
      onAccept();
      return true;
    },
    refresh() {
      row.focusable = enabled ? Boolean(enabled()) : true;
      node.classList.toggle('is-disabled', !row.focusable);
      node.setAttribute('aria-disabled', String(!row.focusable));
      if (detailNode) detailNode.textContent = typeof detail === 'function' ? detail() : detail;
    },
  };
  node.addEventListener('click', () => row.intent(INTENT.ACCEPT));
  return focusOnPointer(row);
}

// ---------------------------------------------------------------- option rows (one settings field)

/** A switch, shown as the word ON or OFF. */
function toggleControl(doc, field, binding) {
  const value = el(doc, 'span', 'row__value row__value--switch');
  const node = el(doc, 'div', 'row row--toggle', el(doc, 'span', 'row__label', field.label), el(doc, 'span', 'row__control', value));
  attrs(node, { role: 'switch', tabindex: -1 });
  const row = {
    el: node,
    intent(intent) {
      const now = Boolean(binding.get());
      const next = intent === INTENT.ACCEPT ? !now : intent === INTENT.RIGHT ? true : intent === INTENT.LEFT ? false : now;
      if (next === now) return false;
      binding.set(next);
      return true;
    },
    refresh() {
      const on = Boolean(binding.get());
      value.classList.toggle('is-on', on);
      value.textContent = on ? 'On' : 'Off';
      node.setAttribute('aria-checked', String(on));
    },
  };
  node.addEventListener('click', () => row.intent(INTENT.ACCEPT));
  return row;
}

/** Continuous slider: click or drag anywhere on it. */
function sliderMeter(doc, field, binding) {
  const node = el(doc, 'span', 'slider', el(doc, 'span', 'slider__fill'), el(doc, 'span', 'slider__knob'));
  let dragging = null;
  let left = 0, width = 0;
  const setFrom = (clientX) => {
    const fraction = Math.min(1, Math.max(0, (clientX - left) / width));
    const value = sanitizeValue(field, field.min + fraction * (field.max - field.min));
    if (value !== undefined && value !== binding.get()) binding.set(value);
  };
  node.addEventListener('pointerdown', (event) => {
    const box = node.getBoundingClientRect();
    if (!(box.width > 0)) return;
    left = box.left; width = box.width;
    dragging = event.pointerId;
    if (node.setPointerCapture) node.setPointerCapture(event.pointerId);
    setFrom(event.clientX);
    event.preventDefault();
  });
  node.addEventListener('pointermove', (event) => { if (event.pointerId === dragging) setFrom(event.clientX); });
  const stop = (event) => { if (event.pointerId === dragging) dragging = null; };
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
  return {
    el: node,
    draw(value) { node.style.setProperty('--fill', valueFraction(field, value).toFixed(4)); },
  };
}

/** A value stepped with left and right: a slider with its number for a range, otherwise the value between two arrows. */
function stepperControl(doc, field, binding) {
  const slider = field.kind === 'range' ? sliderMeter(doc, field, binding) : null;
  const value = el(doc, 'span', 'row__value');
  const step = (direction) => {
    const now = binding.get();
    const next = stepValue(field, now, direction);
    if (next === now) return false;
    binding.set(next);
    return true;
  };
  const less = pressable(doc, 'row__step', `${field.label}: lower`, () => step(-1), icon(doc, 'chevronLeft'));
  const more = pressable(doc, 'row__step', `${field.label}: higher`, () => step(1), icon(doc, 'chevronRight'));
  const control = slider ? el(doc, 'span', 'row__control', slider.el, value) : el(doc, 'span', 'row__control', less, value, more);
  const node = el(doc, 'div', `row row--${field.kind}`, el(doc, 'span', 'row__label', field.label), control);
  attrs(node, slider
    ? { role: 'slider', tabindex: -1, 'aria-valuemin': field.min, 'aria-valuemax': field.max }
    : { role: 'spinbutton', tabindex: -1 });
  return {
    el: node,
    intent(intent) {
      if (intent === INTENT.LEFT) return step(-1);
      if (intent === INTENT.RIGHT || intent === INTENT.ACCEPT) {
        // Accept walks forward and wraps, so a single button can reach every value.
        if (step(1)) return true;
        if (intent === INTENT.ACCEPT && !slider) {
          const first = field.kind === 'level' ? 0 : field.options[0].value;
          if (first !== binding.get()) { binding.set(first); return true; }
        }
      }
      return false;
    },
    refresh() {
      const now = binding.get();
      const text = formatValue(field, now);
      value.textContent = text;
      node.setAttribute('aria-valuetext', text);
      if (slider) {
        slider.draw(now);
        node.setAttribute('aria-valuenow', String(now));
      } else {
        less.classList.toggle('is-off', stepValue(field, now, -1) === now);
        more.classList.toggle('is-off', stepValue(field, now, 1) === now);
      }
    },
  };
}

/** A two-step level labelled Off and On is a switch in everything but its stored type. */
const isSwitchLevel = (field) => field.kind === 'level' && field.labels.length === 2 && field.labels[0] === 'Off';

/** The row for one settings field, with the control that suits its kind. binding: { get, set }. */
export function optionRow(doc, field, binding) {
  const row = field.kind === 'toggle' ? toggleControl(doc, field, binding)
    : isSwitchLevel(field) ? toggleControl(doc, field, { get: () => binding.get() === 1, set: (on) => binding.set(on ? 1 : 0) })
      : stepperControl(doc, field, binding);
  row.el.setAttribute('aria-label', field.label);
  row.focusable = true;
  row.help = field.help || '';
  return focusOnPointer(row);
}

// ---------------------------------------------------------------- pick-one rows

/**
 * A row of items of which exactly one is chosen. Left and right move the choice and apply it at
 * once; clicking an item chooses it.
 *
 * options: { label, help?, className?, count: () => number, selected: () => index, choose(index), item(doc, index) -> node }
 * `item` builds the element of one entry; rebuild() must be called when the number of entries changes.
 */
export function pickRow(doc, { label, help = '', className = '', count, selected, choose, item }) {
  const list = el(doc, 'div', `pick ${className}`.trim());
  attrs(list, { role: 'radiogroup', 'aria-label': label });
  const node = el(doc, 'div', 'row row--pick', el(doc, 'span', 'row__label', label), list);
  node.setAttribute('tabindex', -1);
  let items = [];
  const row = {
    el: node,
    focusable: true,
    help,
    intent(intent) {
      const total = count();
      if (total === 0) return false;
      const now = selected();
      let next = now;
      if (intent === INTENT.LEFT) next = Math.max(0, now - 1);
      else if (intent === INTENT.RIGHT) next = Math.min(total - 1, now + 1);
      else if (intent === INTENT.ACCEPT) next = (now + 1) % total;
      if (next === now) return false;
      choose(next);
      return true;
    },
    rebuild() {
      items = [];
      const total = count();
      for (let i = 0; i < total; i++) {
        const entry = item(doc, i);
        attrs(entry, { role: 'radio' });
        entry.addEventListener('click', () => { if (selected() !== i) choose(i); });
        items.push(entry);
      }
      list.replaceChildren(...items);
      row.focusable = total > 0;
      row.refresh();
    },
    refresh() {
      const now = selected();
      items.forEach((entry, i) => {
        entry.classList.toggle('is-on', i === now);
        entry.setAttribute('aria-checked', String(i === now));
      });
    },
  };
  row.rebuild();
  return focusOnPointer(row);
}

/** pickRow over a fixed list of { value, label } with text pills. binding: { get, set }. */
export function segmentRow(doc, { label, help, options, binding }) {
  return pickRow(doc, {
    label, help, className: 'pick--segment',
    count: () => options.length,
    selected: () => options.findIndex((o) => o.value === binding.get()),
    choose: (index) => binding.set(options[index].value),
    item: (d, index) => el(d, 'span', 'pick__pill', options[index].label),
  });
}
