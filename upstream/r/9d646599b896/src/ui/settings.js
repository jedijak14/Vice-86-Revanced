// Settings: schema, defaults, graphics presets, validation, migration and persistence.
//
// The settings object has the shape fixed in ARCHITECTURE 11.2 (plus `game.paint`, the chosen
// factory colour index). One object lives for the whole session: the game passes it to createUI,
// the menus mutate it in place and hand the same reference to `actions.applySettings`.
//
// Everything here is plain data and pure functions so it can be tested without a DOM. Storage is
// injected (any object with getItem / setItem) and every access is guarded, because localStorage
// throws in sandboxed frames, in private modes with a zero quota, and when cookies are blocked.

export const SETTINGS_VERSION = 1;
export const STORAGE_KEY = 'vice86.settings';

/** Concrete presets, weakest first. The order is the scale Auto moves along. */
export const PRESET_NAMES = Object.freeze(['low', 'medium', 'high', 'ultra']);
/** Every value the preset selector can show. */
export const PRESET_CHOICES = Object.freeze(['auto', 'low', 'medium', 'high', 'ultra', 'custom']);

/** Named times of day (ARCHITECTURE section 8). `hours` is passed to actions.setTime as a convenience. */
export const TIME_OPTIONS = Object.freeze([
  { value: 'dawn', label: 'Dawn', hours: 6.2 },
  { value: 'morning', label: 'Morning', hours: 9.0 },
  { value: 'noon', label: 'Noon', hours: 12.5 },
  { value: 'afternoon', label: 'Afternoon', hours: 16.0 },
  { value: 'golden', label: 'Golden hour', hours: 18.6 },
  { value: 'dusk', label: 'Dusk', hours: 19.6 },
  { value: 'night', label: 'Night', hours: 22.5 },
]);

export const WEATHER_OPTIONS = Object.freeze([
  { value: 'clear', label: 'Clear' },
  { value: 'dynamic', label: 'Dynamic' },
  { value: 'rain', label: 'Rain' },
  { value: 'storm', label: 'Storm' },
]);

// ---------------------------------------------------------------- field descriptors
//
// kind 'level'  : integer 0..labels.length-1, one label per step
// kind 'range'  : number in [min, max] snapped to `step`
// kind 'toggle' : boolean
// kind 'choice' : one of options[].value (strings or numbers)
// kind 'index'  : non-negative integer (the garage swatches edit it)
// kind 'id'     : a short name kept as stored; whoever reads it checks it against what exists
// kind 'indexes': a record of name -> non-negative integer, such as the colour chosen for each car
// The last three have no row in the settings pages (hasMenuRow).

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const percent = (v) => `${Math.round(v * 100)}%`;
const level = (key, label, labels, fallback, help) => ({ key, kind: 'level', label, labels, default: fallback, help });
const toggle = (key, label, fallback, help) => ({ key, kind: 'toggle', label, default: fallback, help });
const range = (key, label, min, max, step, fallback, format, help) => ({ key, kind: 'range', label, min, max, step, default: fallback, format, help });
const choice = (key, label, options, fallback, help) => ({ key, kind: 'choice', label, options, default: fallback, help });

/** Whether a field is edited on the settings pages (the rest are edited elsewhere, or by the game). */
export const hasMenuRow = (field) => field.kind !== 'index' && field.kind !== 'id' && field.kind !== 'indexes';

const MAX_PAINT_INDEX = 255;
/** Longest stored name, and most entries in a stored record: a corrupt store cannot grow without bound. */
const MAX_ID_LENGTH = 40;
const MAX_RECORD_ENTRIES = 64;
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;

const OFF_LOW_MED_HIGH = ['Off', 'Low', 'Medium', 'High'];
const OFF_LOW_HIGH = ['Off', 'Low', 'High'];
const LOW_TO_ULTRA = ['Low', 'Medium', 'High', 'Ultra'];

const GRAPHICS_FIELDS = [
  choice('preset', 'Preset', [
    { value: 'auto', label: 'Auto' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }, { value: 'ultra', label: 'Ultra' }, { value: 'custom', label: 'Custom' },
  ], 'auto', 'Auto reads your graphics hardware, picks a starting preset and corrects it once from measured frame times. Changing any option below switches to Custom.'),

  range('resolutionScale', 'Resolution scale', 0.5, 1, 0.05, 0.85, percent,
    'Internal rendering resolution as a share of the display resolution. The largest single lever on frame rate.'),
  toggle('dynamicResolution', 'Dynamic resolution', true,
    'Lowers the internal resolution for a moment when a frame runs long, then restores it.'),
  choice('maxPixelRatio', 'Max pixel ratio', [
    { value: 1, label: '1.0' }, { value: 1.25, label: '1.25' }, { value: 1.5, label: '1.5' }, { value: 2, label: '2.0' },
  ], 1, 'Upper limit on device pixels per CSS pixel. Above 1.0 only matters on high-density screens.'),
  choice('frameCap', 'Frame cap', [
    { value: 0, label: 'Off' }, { value: 30, label: '30' }, { value: 60, label: '60' },
  ], 0, 'Off follows the refresh rate of the screen. 30 saves battery and heat on laptops and phones.'),

  level('shadows', 'Shadows', OFF_LOW_MED_HIGH, 2, 'Sun and moon shadow resolution, range and filtering.'),
  level('ao', 'Ambient occlusion', OFF_LOW_HIGH, 1, 'Contact shading where surfaces meet.'),
  level('reflections', 'Reflections', OFF_LOW_MED_HIGH, 1,
    'Screen-space reflections on wet roads, paint and glass. Off falls back to the sky reflection alone.'),
  choice('antialiasing', 'Anti-aliasing', [
    { value: 'off', label: 'Off' }, { value: 'fxaa', label: 'FXAA' }, { value: 'taa', label: 'TAA' },
  ], 'taa', 'TAA is the cleanest in motion. FXAA is cheaper and slightly softer.'),
  level('bloom', 'Bloom', OFF_LOW_HIGH, 1, 'Glow around lamps, neon and the sun.'),
  level('motionBlur', 'Motion blur', OFF_LOW_MED_HIGH, 1, 'Blur from speed.'),
  level('lights', 'Lights', LOW_TO_ULTRA, 1, 'How many street and neon lights shade each part of the street, and how far away they stay on.'),
  level('drawDistance', 'Draw distance', LOW_TO_ULTRA, 1, 'How far full detail and the skyline are drawn.'),
  level('density', 'Density', LOW_TO_ULTRA, 1, 'Palms, planting, street furniture and small props.'),
  level('traffic', 'Traffic', OFF_LOW_MED_HIGH, 2, 'Moving and parked cars around you.'),
  level('particles', 'Particles', ['Low', 'Medium', 'High'], 1, 'Rain, tyre spray and smoke.'),
  level('volumetrics', 'Volumetrics', ['Off', 'On'], 0, 'Shafts of light through haze and rain.'),
  toggle('filmGrain', 'Film grain', true, 'Fine grain over the picture.'),
  toggle('chromaticAberration', 'Chromatic aberration', true, 'Slight colour fringing towards the edges of the frame.'),

  // Taste rather than cost: these two belong to no preset and do not switch the selector to Custom.
  range('bloomStrength', 'Bloom strength', 0, 2, 0.1, 1, percent, 'How strongly bright sources glow. 100% is the intended look.'),
  range('exposureBias', 'Exposure', -2, 2, 0.25, 0, (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} EV`,
    'Brightens or darkens the whole picture, in photographic stops.'),
];

const AUDIO_FIELDS = [
  range('master', 'Master', 0, 1, 0.05, 0.8, percent, 'Overall volume.'),
  range('effects', 'Effects', 0, 1, 0.05, 0.8, percent, 'Volume of the engine, tyres, weather and the city.'),
];

const CONTROLS_FIELDS = [
  range('steerSensitivity', 'Steering sensitivity', 0.5, 1.5, 0.05, 1, percent, 'How quickly the wheel follows keys, stick or touch.'),
  toggle('invertCameraY', 'Invert camera Y', false, 'Pushing the right stick up looks down.'),
  toggle('vibration', 'Vibration', true, 'Rumble on kerbs, slides and impacts where the controller supports it.'),
  toggle('automatic', 'Automatic gearbox', true, 'The gearbox shifts for you.'),
];

const GAME_FIELDS = [
  choice('units', 'Units', [{ value: 'kmh', label: 'KM/H' }, { value: 'mph', label: 'MPH' }], 'mph', 'Units of the speed readout.'),
  choice('timeFlow', 'Time flow', [
    { value: 0, label: 'Paused' }, { value: 1, label: 'Real time' }, { value: 10, label: '10\u00d7' }, { value: 60, label: '60\u00d7' },
  ], 10, 'How fast the clock runs. At 60\u00d7 a full day takes 24 minutes.'),
  choice('startTime', 'Start time', TIME_OPTIONS, 'dusk', 'The hour a drive starts at.'),
  choice('weather', 'Weather', WEATHER_OPTIONS, 'dynamic', 'Dynamic drifts between clear skies, showers and storms.'),
  toggle('reduceFlashing', 'Reduce flashing', false,
    'Holds the rev limiter and nitrous indicators steady instead of flashing, and softens lightning.'),
  // The garage: the car in use, the colour of that car, and the colour remembered for every car.
  // The game writes all three (it knows which cars and colours exist); the Garage shows them.
  { key: 'car', kind: 'id', label: 'Car', default: 'lucera', help: '' },
  { key: 'paint', kind: 'index', label: 'Paint', max: MAX_PAINT_INDEX, default: 0, help: '' },
  { key: 'paints', kind: 'indexes', label: 'Paint of each car', max: MAX_PAINT_INDEX, default: Object.freeze({}), help: '' },
];

/** The schema, section by section, in menu order. */
export const SCHEMA = Object.freeze({
  graphics: Object.freeze(GRAPHICS_FIELDS),
  audio: Object.freeze(AUDIO_FIELDS),
  controls: Object.freeze(CONTROLS_FIELDS),
  game: Object.freeze(GAME_FIELDS),
});

export const SECTION_NAMES = Object.freeze(Object.keys(SCHEMA));

const FIELD_INDEX = {};
for (const section of SECTION_NAMES) {
  FIELD_INDEX[section] = {};
  for (const field of SCHEMA[section]) FIELD_INDEX[section][field.key] = field;
}

/** Descriptor of one field, or undefined. */
export const fieldOf = (section, key) => (FIELD_INDEX[section] ? FIELD_INDEX[section][key] : undefined);

// ---------------------------------------------------------------- presets

/**
 * Concrete value of every performance-related graphics field for each preset (everything except
 * the selector itself and the two picture preferences, which a preset never touches).
 *
 * Low is for integrated graphics and phones: reduced resolution, no screen-space passes beyond
 * FXAA and bloom. Medium adds the full lighting model at modest settings. High is the reference
 * look at 1080p on a mid-range desktop card. Ultra spends whatever is left on range and density.
 * Every ordered field is non-decreasing from Low to Ultra (tested), so moving one preset up never
 * turns something down.
 */
export const PRESETS = Object.freeze({
  low: Object.freeze({
    resolutionScale: 0.7, dynamicResolution: true, maxPixelRatio: 1, frameCap: 0,
    shadows: 1, ao: 0, reflections: 0, lights: 0, volumetrics: 0,
    drawDistance: 0, density: 0, traffic: 1, particles: 0,
    antialiasing: 'fxaa', bloom: 1, motionBlur: 0, filmGrain: false, chromaticAberration: false,
  }),
  medium: Object.freeze({
    resolutionScale: 0.85, dynamicResolution: true, maxPixelRatio: 1, frameCap: 0,
    shadows: 2, ao: 1, reflections: 1, lights: 1, volumetrics: 0,
    drawDistance: 1, density: 1, traffic: 2, particles: 1,
    antialiasing: 'taa', bloom: 1, motionBlur: 1, filmGrain: true, chromaticAberration: false,
  }),
  high: Object.freeze({
    resolutionScale: 1, dynamicResolution: true, maxPixelRatio: 1.5, frameCap: 0,
    shadows: 3, ao: 2, reflections: 2, lights: 2, volumetrics: 1,
    drawDistance: 2, density: 2, traffic: 2, particles: 2,
    antialiasing: 'taa', bloom: 2, motionBlur: 2, filmGrain: true, chromaticAberration: true,
  }),
  ultra: Object.freeze({
    resolutionScale: 1, dynamicResolution: true, maxPixelRatio: 2, frameCap: 0,
    shadows: 3, ao: 2, reflections: 3, lights: 3, volumetrics: 1,
    drawDistance: 3, density: 3, traffic: 3, particles: 2,
    antialiasing: 'taa', bloom: 2, motionBlur: 3, filmGrain: true, chromaticAberration: true,
  }),
});

/** What Auto resolves to before a device has been classified. */
export const FALLBACK_PRESET = 'medium';

export const isPresetName = (name) => PRESET_NAMES.includes(name);

// ---------------------------------------------------------------- values

/**
 * Coerces `value` to something the field accepts, or returns undefined when nothing sensible can
 * be made of it. Numbers out of range are clamped rather than rejected: a level saved by a build
 * with one more step should land on the nearest step that exists here.
 */
export function sanitizeValue(field, value) {
  switch (field.kind) {
    case 'toggle':
      return typeof value === 'boolean' ? value : undefined;
    case 'level': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(field.labels.length - 1, Math.max(0, Math.round(value)));
    }
    case 'index': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return Math.min(field.max, Math.max(0, Math.round(value)));
    }
    case 'range': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      const clamped = Math.min(field.max, Math.max(field.min, value));
      const steps = Math.round((clamped - field.min) / field.step);
      // Rebuild from the step count and trim binary noise so 0.5 + 7 * 0.05 is 0.85 exactly.
      return Number((field.min + steps * field.step).toFixed(4));
    }
    case 'choice':
      return field.options.some((o) => o.value === value) ? value : undefined;
    case 'id':
      return isId(value) ? value : undefined;
    case 'indexes': {
      if (!isRecord(value)) return undefined;
      const clean = {};
      let kept = 0;
      for (const name of Object.keys(value)) {
        const index = value[name];
        if (!isId(name) || !Number.isInteger(index) || index < 0 || index > field.max) continue;
        if (++kept > MAX_RECORD_ENTRIES) break;
        clean[name] = index;
      }
      return clean;
    }
    default:
      return undefined;
  }
}

/** Text shown for a value of a field in menus. */
export function formatValue(field, value) {
  switch (field.kind) {
    case 'toggle': return value ? 'On' : 'Off';
    case 'level': return field.labels[value];
    case 'range': return field.format ? field.format(value) : String(value);
    case 'choice': {
      const option = field.options.find((o) => o.value === value);
      return option ? option.label : String(value);
    }
    default: return String(value);
  }
}

/** The value one step up (direction +1) or down (-1) from `value`, clamped; choices and levels do not wrap. */
export function stepValue(field, value, direction) {
  switch (field.kind) {
    case 'toggle': return direction > 0;
    case 'level': return Math.min(field.labels.length - 1, Math.max(0, value + direction));
    case 'range': return sanitizeValue(field, value + direction * field.step);
    case 'choice': {
      const at = field.options.findIndex((o) => o.value === value);
      const next = Math.min(field.options.length - 1, Math.max(0, (at < 0 ? 0 : at) + direction));
      return field.options[next].value;
    }
    default: return value;
  }
}

/** Position of `value` within the field as 0..1, for slider fills and step pips. */
export function valueFraction(field, value) {
  switch (field.kind) {
    case 'toggle': return value ? 1 : 0;
    case 'level': return field.labels.length > 1 ? value / (field.labels.length - 1) : 0;
    case 'range': return (value - field.min) / (field.max - field.min);
    case 'choice': {
      const at = field.options.findIndex((o) => o.value === value);
      return field.options.length > 1 ? Math.max(0, at) / (field.options.length - 1) : 0;
    }
    default: return 0;
  }
}

// ---------------------------------------------------------------- construction and validation

/** A fresh settings object with every field at its default. */
export function defaultSettings() {
  const settings = {};
  for (const section of SECTION_NAMES) {
    settings[section] = {};
    // A record default is copied: every settings object owns its own.
    for (const field of SCHEMA[section]) settings[section][field.key] = field.kind === 'indexes' ? { ...field.default } : field.default;
  }
  return settings;
}

/**
 * Builds a complete, valid settings object from anything. Recognised fields with usable values are
 * kept, everything else falls back to its default, unknown keys are dropped.
 *
 * A named preset is authoritative over the individual graphics fields: if the stored fields
 * disagree with the preset's table (because the table changed between builds, or the data was
 * edited by hand) the table wins, so "High" always means this build's High.
 */
export function validateSettings(raw) {
  const settings = defaultSettings();
  if (!isRecord(raw)) return settings;
  for (const section of SECTION_NAMES) {
    const source = raw[section];
    if (!isRecord(source)) continue;
    for (const field of SCHEMA[section]) {
      const value = sanitizeValue(field, source[field.key]);
      if (value !== undefined) settings[section][field.key] = value;
    }
  }
  const preset = settings.graphics.preset;
  if (isPresetName(preset)) Object.assign(settings.graphics, PRESETS[preset]);
  return settings;
}

// ---------------------------------------------------------------- presets on a settings object

/**
 * Selects a preset. Named presets copy their table. 'auto' copies the table of `autoPreset` (what
 * detection chose for this device) and keeps `preset` at 'auto'. 'custom' keeps the current values.
 */
export function applyPreset(settings, name, autoPreset = FALLBACK_PRESET) {
  const graphics = settings.graphics;
  if (isPresetName(name)) {
    Object.assign(graphics, PRESETS[name]);
    graphics.preset = name;
  } else if (name === 'auto') {
    Object.assign(graphics, PRESETS[isPresetName(autoPreset) ? autoPreset : FALLBACK_PRESET]);
    graphics.preset = 'auto';
  } else if (name === 'custom') {
    graphics.preset = 'custom';
  }
  return settings;
}

/** Fills the concrete graphics fields for the Auto preset; does nothing unless the preset is 'auto'. */
export function resolveAuto(settings, autoPreset) {
  if (settings.graphics.preset === 'auto') applyPreset(settings, 'auto', autoPreset);
  return settings;
}

/** Name of the preset whose table equals these graphics values, or 'custom'. */
export function matchPreset(graphics) {
  for (const name of PRESET_NAMES) {
    const table = PRESETS[name];
    let same = true;
    for (const key in table) if (graphics[key] !== table[key]) { same = false; break; }
    if (same) return name;
  }
  return 'custom';
}

/**
 * Sets one field after sanitising the value. Returns true when the stored value changed.
 * Editing any graphics option that presets control switches the preset to 'custom'.
 * The preset selector itself must go through applyPreset.
 */
export function setOption(settings, section, key, value) {
  const field = fieldOf(section, key);
  if (!field) return false;
  const clean = sanitizeValue(field, value);
  if (clean === undefined || settings[section][key] === clean) return false;
  settings[section][key] = clean;
  if (section === 'graphics' && key in PRESETS.low) settings.graphics.preset = 'custom';
  return true;
}

// ---------------------------------------------------------------- stored form and migration
//
// Stored form: { v: SETTINGS_VERSION, settings: { graphics, audio, controls, game } }.
// Builds before the version field wrote the bare settings object; that is version 0.

const MIGRATIONS = [
  // 0 -> 1: wrap the bare settings object in the versioned envelope.
  (data) => ({ v: 1, settings: data }),
];

/**
 * Turns whatever was read from storage into valid settings.
 * Returns { settings, status } with status:
 *   'ok'        current version, used as stored (after validation)
 *   'migrated'  older version brought forward
 *   'newer'     written by a newer build: the fields this build knows are kept
 *   'reset'     unusable data, defaults returned
 */
export function migrateStored(data) {
  if (!isRecord(data)) return { settings: defaultSettings(), status: 'reset' };

  let envelope = data;
  let version = data.v;
  if (version === undefined && SECTION_NAMES.some((s) => isRecord(data[s]))) version = 0;
  if (!Number.isInteger(version) || version < 0) return { settings: defaultSettings(), status: 'reset' };

  const status = version === SETTINGS_VERSION ? 'ok' : version < SETTINGS_VERSION ? 'migrated' : 'newer';
  for (let v = version; v < SETTINGS_VERSION; v++) envelope = MIGRATIONS[v](envelope);
  if (!isRecord(envelope.settings)) return { settings: defaultSettings(), status: 'reset' };
  return { settings: validateSettings(envelope.settings), status };
}

// ---------------------------------------------------------------- persistence

/** The page's localStorage, or null where it is missing or access is denied. */
export function browserStorage() {
  try {
    // The property getter itself throws a SecurityError in sandboxed and cookie-blocked frames.
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** Reads and parses one JSON entry. Returns undefined when absent, unreadable or not JSON. */
export function readStored(storage, key) {
  if (!storage) return undefined;
  try {
    const text = storage.getItem(key);
    return typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Writes one JSON entry. Returns false when storage is missing, full or refuses the write. */
export function writeStored(storage, key, value) {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads settings with the reason attached: { settings, status }, status being one of the
 * migrateStored values or 'empty' (nothing stored, or storage unavailable or unreadable).
 */
export function loadSettingsReport(storage = browserStorage()) {
  const data = readStored(storage, STORAGE_KEY);
  if (data === undefined) return { settings: defaultSettings(), status: 'empty' };
  return migrateStored(data);
}

/** Loads settings. Always returns a complete, valid object; never throws. */
export function loadSettings(storage = browserStorage()) {
  return loadSettingsReport(storage).settings;
}

/** Saves settings. Returns whether the write succeeded; never throws. */
export function saveSettings(settings, storage = browserStorage()) {
  return writeStored(storage, STORAGE_KEY, { v: SETTINGS_VERSION, settings });
}

/**
 * Writes settings a moment after the last change, so that dragging a slider is one write and not
 * fifty. Returns { schedule(), flush() }; flush writes at once if a write is pending.
 */
export function createSaver(settings, storage, win, delayMs = 400) {
  let timer = null;
  const write = () => { timer = null; saveSettings(settings, storage); };
  return {
    schedule() {
      if (!(win && win.setTimeout)) { write(); return; }
      if (timer !== null) win.clearTimeout(timer);
      timer = win.setTimeout(write, delayMs);
    },
    flush() {
      if (timer === null) return;
      win.clearTimeout(timer);
      write();
    },
  };
}
