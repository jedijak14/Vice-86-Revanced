// The driving HUD: two discs of the same size mirrored in the bottom corners, a clock, and
// transient text. Nothing has a panel behind it; the minimap is the only filled shape.
//
//   bottom right   rev dial: thin arcs open at the bottom, speed in three fixed cells, unit, the
//                  gear in the arc's opening, state icons under it, and a slim nitrous arc on the
//                  left shoulder (pulses while boosting, dims when empty)
//   bottom left    round heading-up minimap painted by the game, north marker on the rim, the
//                  current district in small capitals underneath
//   top left       24-hour clock, and the district name as a banner for a few seconds on entry
//
// update() runs every frame. It computes the view model (hud-model.js) and pushes each field
// through a cached writer, so a frame in which nothing visible changed performs no DOM writes at
// all. Nothing in update() reads layout. The only layout read in this file is the minimap's size,
// taken from a ResizeObserver entry (or once per window resize where that is unavailable).
// Per-frame writes are limited to: digit text nodes inside fixed-size cells, two
// stroke-dashoffsets, two rotations held in custom properties, and the minimap canvas.

import { el, svg, textWriter, classWriter, styleWriter, attrWriter } from './dom.js';
import { icon } from './icons.js';
import {
  DIAL, NITROUS_ARC, ARC_STEPS, NITROUS_STEPS, MAP_OVERSCAN, MAP_PLAYER_Y, arcPath, tickPath, turnBetween,
  unitLabel, createHudModel, updateHudModel, minimapDue,
} from './hud-model.js';

/** Backing-store pixels per CSS pixel for the minimap; beyond 2 the extra detail is invisible at this size. */
const MAP_MAX_PIXEL_RATIO = 2;

const DIGITS = '0123456789';

/** Pre-built dash offsets (1 = empty), so a frame never formats a number. */
const offsets = (steps, places) => Array.from({ length: steps + 1 }, (_, i) => (1 - i / steps).toFixed(places));
const ARC_OFFSETS = offsets(ARC_STEPS, 4);
const NITROUS_OFFSETS = offsets(NITROUS_STEPS, 2);

function buildGauge(doc) {
  // Drawn around the origin, ten units to one layout unit; the view box leaves room for the
  // nitrous arc outside the rev arc.
  const track = arcPath(0, 0, DIAL.radius, DIAL.start, DIAL.sweep);
  const zone = arcPath(0, 0, DIAL.radius, DIAL.start + DIAL.sweep - DIAL.redZone, DIAL.redZone);
  // pathLength normalises the dash pattern, so the offset is simply 1 - fraction.
  const value = svg(doc, 'path', { class: 'gauge__value', d: track, pathLength: 1 });
  const ticks = svg(doc, 'path', { class: 'gauge__ticks', d: '' });
  const nitrousTrack = arcPath(0, 0, NITROUS_ARC.radius, NITROUS_ARC.start, NITROUS_ARC.sweep);
  const nitrous = svg(doc, 'path', { class: 'gauge__nitrous', d: nitrousTrack, pathLength: 1 });
  const dial = svg(doc, 'svg', { class: 'gauge__dial', viewBox: '-130 -130 260 260', 'aria-hidden': 'true' },
    svg(doc, 'path', { class: 'gauge__shade', d: track }),
    svg(doc, 'path', { class: 'gauge__track', d: track }),
    svg(doc, 'path', { class: 'gauge__zone', d: zone }),
    ticks,
    value,
    svg(doc, 'path', { class: 'gauge__shade gauge__shade--nitrous', d: nitrousTrack }),
    svg(doc, 'path', { class: 'gauge__nitrous-track', d: nitrousTrack }),
    nitrous);

  const digits = [0, 1, 2].map(() => el(doc, 'span', 'gauge__digit'));
  const unit = el(doc, 'div', 'gauge__unit');
  const gear = el(doc, 'div', 'gauge__gear');
  const lamps = icon(doc, 'headlamps', 'gauge__state');
  const brake = icon(doc, 'handbrake', 'gauge__state gauge__state--warn');
  const root = el(doc, 'div', 'hud__gauge gauge',
    dial, el(doc, 'div', 'gauge__speed', ...digits), unit, gear,
    el(doc, 'div', 'gauge__states', lamps, brake),
    el(doc, 'div', 'gauge__nitrous-label', 'N\u2082O'));
  return { root, value, ticks, nitrous, digits, unit, gear, lamps, brake };
}

function buildMap(doc) {
  // The canvas overhangs the disc and is centred on the player's marker (see MAP_OVERSCAN), so
  // turning it about its own centre turns the map about the car.
  const canvas = el(doc, 'canvas', 'hud__map-canvas');
  const size = `${MAP_OVERSCAN * 100}%`, half = `${MAP_OVERSCAN * -50}%`, down = `${MAP_PLAYER_Y * 100}%`;
  canvas.style.setProperty('width', size);
  canvas.style.setProperty('height', size);
  canvas.style.setProperty('top', down);
  canvas.style.setProperty('margin', `${half} 0 0 ${half}`);
  const north = el(doc, 'div', 'hud__north', el(doc, 'span', 'hud__north-mark', 'N'));
  // The player's marker never moves: the map turns underneath it.
  const car = svg(doc, 'svg', { class: 'hud__car', viewBox: '0 0 34 34', 'aria-hidden': 'true' },
    svg(doc, 'circle', { class: 'hud__car-halo', cx: 17, cy: 17, r: 17 }),
    svg(doc, 'path', { class: 'hud__car-arrow', d: 'M17 5 26 29 17 24.5 8 29Z' }));
  car.style.setProperty('top', down);
  const root = el(doc, 'div', 'hud__map', el(doc, 'div', 'hud__map-view', canvas), el(doc, 'div', 'hud__rim'), car, north);
  return { root, canvas, north };
}

const WANTED_STARS = 5;

function buildPolice(doc) {
  // The wanted level as five stars, and one line of what the dispatch is doing about it. The stars
  // are the record a driver carries; the line is the incident in front of him, and both are read
  // from the same row so that the eye goes to one place for the police.
  const pips = [];
  for (let i = 0; i < WANTED_STARS; i++) pips.push(el(doc, 'i', 'hud__star', icon(doc, 'star')));
  const text = el(doc, 'span', 'hud__police-text');
  const root = el(doc, 'div', 'hud__police',
    el(doc, 'span', 'hud__police-label', 'Paloma PD'), el(doc, 'span', 'hud__police-pips', ...pips), text);
  return { root, pips, text };
}

/**
 * The three rows under the police line: a job in hand, a race in hand, and who else is on the
 * street with you. Built once, shown by class, and each row carries its own symbol so that the line
 * reads from across the car without being read.
 */
function buildRows(doc) {
  const build = (name, iconName, label) => {
    const text = el(doc, 'span', `hud__${name}-text`);
    const root = el(doc, 'div', `hud__row hud__row--${name}`, icon(doc, iconName, 'hud__row-icon'), el(doc, 'span', 'hud__row-label', label), text);
    return { root, text };
  };
  return {
    mission: build('mission', 'target', 'Job'),
    race: build('race', 'flag', 'Race'),
    crew: build('crew', 'link', 'Room'),
    purse: build('purse', 'jobs', 'Purse'),
    foot: build('foot', 'person', 'On foot'),
    vitals: build('vitals', 'pulse', 'Vitals'),
    radio: build('radio', 'radio', 'Radio'),
    watch: build('watch', 'camera', 'Eyes'),
    jail: build('jail', 'lock', 'Custody'),
    root: null,
  };
}

function buildClock(doc) {
  const cell = () => el(doc, 'span', 'hud__clock-digit');
  const digits = [cell(), cell(), cell(), cell()];
  const root = el(doc, 'div', 'hud__clock', digits[0], digits[1], el(doc, 'span', 'hud__colon', ':'), digits[2], digits[3]);
  return { root, digits };
}

/**
 * options: { doc, parent, settings, win?, now? }
 * Returns { el, update(input), show(), hide(), visible, setMinimapPainter(fn) }.
 */
export function createHud({ doc, parent, settings, win = doc.defaultView, now = () => performance.now() }) {
  const gauge = buildGauge(doc);
  const map = buildMap(doc);
  const clock = buildClock(doc);
  const police = buildPolice(doc);
  const rows = buildRows(doc);
  const banner = el(doc, 'div', 'hud__banner');
  const place = el(doc, 'div', 'hud__place');
  rows.root = el(doc, 'div', 'hud__rows', rows.mission.root, rows.race.root, rows.crew.root, rows.purse.root, rows.foot.root, rows.vitals.root, rows.radio.root, rows.watch.root, rows.jail.root);

  const root = el(doc, 'div', 'hud', el(doc, 'div', 'hud__top', clock.root, police.root, rows.root, banner), map.root, place, gauge.root);
  root.setAttribute('aria-hidden', 'true');   // a visual instrument cluster; nothing here is read out
  parent.appendChild(root);

  const model = createHudModel();
  const write = {
    digits: gauge.digits.map((node) => textWriter(node)),
    unit: textWriter(gauge.unit),
    gear: textWriter(gauge.gear),
    shift: classWriter(gauge.gear, 'is-shift'),
    arc: styleWriter(gauge.value, 'stroke-dashoffset'),
    ticks: attrWriter(gauge.ticks, 'd'),
    hot: classWriter(gauge.root, 'is-hot'),
    limit: classWriter(gauge.root, 'is-limit'),
    clock: clock.digits.map((node) => textWriter(node)),
    flowing: classWriter(clock.root, 'is-flowing'),
    banner: textWriter(banner),
    bannerOn: classWriter(banner, 'is-on'),
    place: textWriter(place),
    police: textWriter(police.text),
    policeOn: classWriter(police.root, 'is-on'),
    policePip: police.pips.map((node) => classWriter(node, 'is-on')),
    row: ['mission', 'race', 'crew', 'purse', 'foot', 'vitals', 'radio', 'watch', 'jail'].map((name) => textWriter(rows[name].text)),
    rowOn: ['mission', 'race', 'crew', 'purse', 'foot', 'vitals', 'radio', 'watch', 'jail'].map((name) => classWriter(rows[name].root, 'is-on')),
    lamps: classWriter(gauge.lamps, 'is-on'),
    brake: classWriter(gauge.brake, 'is-on'),
    nitrous: styleWriter(gauge.nitrous, 'stroke-dashoffset'),
    boosting: classWriter(gauge.root, 'is-boosting'),
    nitrousEmpty: classWriter(gauge.root, 'is-nitrous-empty'),
    steady: classWriter(root, 'is-steady'),
  };
  // Values compared as numbers before any string is built for them.
  let shownMinute = -1;
  let shownRedline = -1;
  let shownNorth = NaN;
  let shownTurn = 0;
  let paintedNorth = 0;

  // ---- minimap
  let painter = null;
  let painterFailed = false;
  let context = null;
  let mapPixels = 0;
  const lastPaint = { time: -Infinity, x: 0, z: 0, heading: 0 };

  /** cssSize: width of the disc in CSS pixels. The canvas behind it is larger by MAP_OVERSCAN. */
  function sizeMap(cssSize) {
    if (!(cssSize > 0)) return;   // the layer is hidden; the observer reports again when it shows
    const ratio = Math.min((win && win.devicePixelRatio) || 1, MAP_MAX_PIXEL_RATIO);
    const pixels = Math.round(cssSize * MAP_OVERSCAN * ratio);
    if (pixels === mapPixels) return;
    mapPixels = pixels;
    map.canvas.width = pixels;    // resizing clears the canvas
    map.canvas.height = pixels;
    lastPaint.time = -Infinity;
  }

  if (win && typeof win.ResizeObserver === 'function') {
    new win.ResizeObserver((entries) => sizeMap(entries[entries.length - 1].contentRect.width)).observe(map.root);
  } else if (win && typeof win.addEventListener === 'function') {
    win.addEventListener('resize', () => { if (hud.visible) sizeMap(map.root.clientWidth); });
  }

  function paintMap() {
    if (!context) context = map.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, mapPixels, mapPixels);
    context.save();
    try {
      painter(context, mapPixels);
    } catch (error) {
      // A painter that throws would throw every frame; report it once and stop calling it.
      painterFailed = true;
      console.error('Minimap painter failed', error);
    }
    context.restore();
    paintedNorth = model.north;
  }

  const hud = {
    el: root,
    visible: false,

    show() {
      if (hud.visible) return;
      hud.visible = true;
      root.classList.add('is-on');
      if (!(win && typeof win.ResizeObserver === 'function')) sizeMap(map.root.clientWidth);
      lastPaint.time = -Infinity;
    },

    hide() {
      if (!hud.visible) return;
      hud.visible = false;
      root.classList.remove('is-on');
    },

    /**
     * fn(ctx, sizePx): draws the map with the car at the centre and forward up, on a cleared square
     * canvas of sizePx pixels. The disc shows a circle 1 / MAP_OVERSCAN of that square across, placed
     * so the car is MAP_PLAYER_Y of the way down it; the HUD draws the car's marker and the round clip.
     */
    setMinimapPainter(fn) {
      painter = typeof fn === 'function' ? fn : null;
      painterFailed = false;
      lastPaint.time = -Infinity;
    },

    /** Called every frame while driving. See ARCHITECTURE 11.3 for the fields. */
    update(input) {
      if (!hud.visible) return;
      const t = now();
      updateHudModel(model, input, settings.game.units, t);

      // Speed: right-aligned in three fixed-width cells, no leading zeros.
      const speed = model.speed;
      write.digits[0](speed < 100 ? '' : DIGITS[(speed / 100) | 0]);
      write.digits[1](speed < 10 ? '' : DIGITS[((speed / 10) | 0) % 10]);
      write.digits[2](DIGITS[speed % 10]);
      write.unit(unitLabel(model.units));
      write.gear(model.gear);
      write.shift(model.shift);

      write.arc(ARC_OFFSETS[model.arc]);
      if (model.redline !== shownRedline) {
        shownRedline = model.redline;
        write.ticks(tickPath(model.redline));
      }
      write.hot(model.hot);
      write.limit(model.limit);

      const minute = model.minute;
      if (minute !== shownMinute && minute >= 0) {
        shownMinute = minute;
        const hour = (minute / 60) | 0, past = minute % 60;
        write.clock[0](DIGITS[(hour / 10) | 0]);
        write.clock[1](DIGITS[hour % 10]);
        write.clock[2](DIGITS[(past / 10) | 0]);
        write.clock[3](DIGITS[past % 10]);
      }
      write.flowing(settings.game.timeFlow > 0);

      write.banner(model.district);
      write.bannerOn(model.districtOn);
      write.place(model.place);
      write.police(model.police);
      write.policeOn(Boolean(model.police));
      // Stars, not pips: the wanted level is what the row carries, and the line beside it says what
      // the agency is doing about it. A star that is lit is the department's own gold.
      for (let i = 0; i < police.pips.length; i++) write.policePip[i](model.stars > i);
      const lines = [model.mission, model.race, model.crew, model.purse, model.foot, model.vitals, model.radio, model.watch, model.jail];
      for (let i = 0; i < lines.length; i++) {
        write.row[i](lines[i]);
        write.rowOn[i](Boolean(lines[i]));
      }
      write.lamps(model.headlamps);
      write.brake(model.handbrake);
      write.nitrous(NITROUS_OFFSETS[model.nitrous]);
      write.boosting(model.boosting);
      write.nitrousEmpty(model.nitrous === 0);
      write.steady(Boolean(settings.game.reduceFlashing));

      // One custom property turns the rim marker and counter-turns its letter (see style.css).
      if (model.north !== shownNorth) {
        shownNorth = model.north;
        map.north.style.setProperty('--north', `${model.north}deg`);
      }

      const painting = painter && !painterFailed && mapPixels > 0;
      if (painting && minimapDue(lastPaint, t, input.position, input.heading || 0)) paintMap();
      // Between repaints the canvas element itself turns with the car.
      const turn = painting ? turnBetween(paintedNorth, model.north) : 0;
      if (turn !== shownTurn) {
        shownTurn = turn;
        map.canvas.style.setProperty('--turn', `${turn}deg`);
      }
    },
  };
  return hud;
}
