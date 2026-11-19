// Device classification for the Auto graphics preset.
//
// Two steps (ARCHITECTURE 11.2):
//   1. detectGraphics(caps): before the first frame, estimate what the device can do from the
//      unmasked WebGL renderer string, then temper that with memory, core count and how many
//      pixels the screen asks for.
//   2. refineFromTimings(samples): after a few seconds of real frames, move the preset once.
//
// The renderer string is matched against RULES, a table of [family, pattern, score]. A score is a
// rough relative performance figure on a scale where a GeForce GTX 1060 is 10, a current
// integrated laptop GPU is 3 to 9 and an RTX 4090 is about 55. Model lines that follow a
// numbering scheme (GeForce, Radeon RX, Apple M, Adreno) are scored by formula from generation and
// class rather than one row per card, so cards released after this table was written still land
// in a sensible place. Precision is not the aim: the estimate only has to pick the right one of
// four presets most of the time, and step 2 corrects the rest.

import { PRESETS, PRESET_NAMES, FALLBACK_PRESET, isPresetName } from './settings.js';

// ---------------------------------------------------------------- scoring formulas

/** Interpolates in a sorted [[x, y], ...] table, clamping at both ends. */
function fromTable(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
    }
  }
  return table[table.length - 1][1];
}

/** Looks up the entry with the largest key not above x in a sorted [[key, value], ...] table. */
function stepTable(table, x) {
  let value = table[0][1];
  for (const [key, v] of table) { if (x >= key) value = v; else break; }
  return value;
}

// GeForce: score of the x60 card of each generation, and the factor of each class within one.
const GEFORCE_X60 = [[4, 2.5], [5, 3], [6, 4.5], [7, 5.5], [8, 5.5], [9, 6.5], [10, 10], [16, 13], [20, 16.5], [30, 21], [40, 25], [50, 30]];
const GEFORCE_CLASS = [[0, 0.2], [10, 0.25], [20, 0.28], [30, 0.35], [40, 0.45], [50, 0.65], [60, 1], [70, 1.35], [80, 1.7], [90, 2.2]];
const GEFORCE_MX = [[100, 2], [150, 3.5], [300, 4.2], [400, 5.5], [500, 6.5]];

function geforce(m) {
  const prefix = (m[1] || '').toLowerCase();
  const number = Number(m[2]);
  const mobile = Boolean(m[3]) || /laptop|max-q|mobile/i.test(m.input);
  const suffix = (m[4] || '').toLowerCase().replace(/\s+/g, ' ');
  if (prefix === 'mx') return stepTable(GEFORCE_MX, number);
  // GeForce 6000 to 9000 of the 2000s carry four digits and no GTX/RTX prefix.
  if (number >= 5000 && prefix !== 'rtx' && prefix !== 'gtx') return 0.8;
  const generation = Math.floor(number / 100);
  const last = GEFORCE_X60[GEFORCE_X60.length - 1];
  const base = generation > last[0]
    ? last[1] * Math.pow(1.18, (generation - last[0]) / 10)   // generations newer than the table
    : stepTable(GEFORCE_X60, generation);
  let score = base * stepTable(GEFORCE_CLASS, number % 100);
  if (suffix === 'ti super') score *= 1.2; else if (suffix === 'ti') score *= 1.15; else if (suffix === 'super') score *= 1.1;
  return mobile ? score * 0.8 : score;
}

// Radeon RX four-digit lines: score of the x600 card per generation, class factor by the hundreds digit.
const RADEON_X600 = [[5, 15], [6, 19], [7, 23], [8, 26], [9, 29]];
const RADEON_CLASS = [[0, 0.3], [4, 0.47], [5, 0.55], [6, 1], [7, 1.35], [8, 1.75], [9, 2.05]];

function radeonRx(m) {
  const number = Number(m[1]);
  const generation = Math.floor(number / 1000);
  const last = RADEON_X600[RADEON_X600.length - 1];
  const base = generation > last[0] ? last[1] * Math.pow(1.15, generation - last[0]) : stepTable(RADEON_X600, generation);
  let score = base * stepTable(RADEON_CLASS, Math.floor((number % 1000) / 100));
  const suffix = (m[3] || '').toLowerCase();
  if (suffix === 'xtx') score *= 1.25; else if (suffix === 'xt') score *= 1.12;
  return m[2] ? score * 0.85 : score;   // M and S suffixes are laptop parts
}

// Radeon RX 400 / 500 and the Radeon Pro 400 / 500 parts in older MacBooks and iMacs.
const POLARIS_CLASS = [[0, 1.5], [40, 2], [50, 3], [55, 3.6], [60, 4.5], [70, 8.5], [80, 10.5], [90, 11.5]];
const polaris = (m) => stepTable(POLARIS_CLASS, Number(m[1]) % 100) * (/pro/i.test(m[0]) ? 0.85 : 1) * (m[1][0] === '4' ? 0.93 : 1);

// Radeon integrated graphics named by a three-digit number and M (610M to 890M).
const RADEON_MOBILE_IGPU = [[600, 3], [660, 6], [680, 8], [700, 5], [740, 6], [760, 8], [780, 9], [800, 7], [860, 9], [880, 10], [890, 11]];
const VEGA_IGPU = [[0, 1.8], [6, 2.6], [8, 3.2], [10, 3.4], [11, 3.8]];

const RADEON_R = (m) => {
  const series = Number(m[1]);
  if (series >= 9) return /fury|\b[23]9\d/i.test(m.input) ? 10 : /\b[23]8\d/i.test(m.input) ? 7 : 5.5;
  return series >= 7 ? 3 : series === 5 ? 1.5 : 1.3;
};
const RADEON_HD = (m) => stepTable([[0, 1.2], [7, 2.5], [8, 4], [9, 5]], Math.floor((Number(m[1]) % 1000) / 100));

// Intel.
const ARC_DISCRETE = (m) => {
  const number = Number(m[2]);
  const score = m[1].toLowerCase() === 'b'
    ? stepTable([[0, 20], [575, 23]], number)
    : stepTable([[0, 5], [350, 7], [500, 16], [700, 18], [760, 20]], number);
  return m[3] ? score * 0.8 : score;
};
const INTEL_UHD = (m) => (m[1] ? stepTable([[0, 0.9], [615, 1.6], [700, 1.8], [750, 2.4]], Number(m[1])) : 2.2);
const INTEL_HD = (m) => {
  if (!m[1]) return 0.6;
  const number = Number(m[1]);
  return number >= 1000
    ? stepTable([[0, 0.5], [2500, 0.7], [4200, 0.9], [5300, 1.1]], number)
    : stepTable([[0, 0.4], [500, 0.6], [510, 1], [520, 1.3], [600, 1.1], [620, 1.5]], number);
};

// Apple.
const APPLE_M_VARIANT = { pro: 1.9, max: 2.9, ultra: 4.5 };
const appleM = (m) => 8.5 * Math.pow(1.18, Number(m[1]) - 1) * (APPLE_M_VARIANT[(m[2] || '').toLowerCase()] || 1);
const appleA = (m) => {
  const generation = Number(m[1]);
  const score = generation <= 9 ? 1 : Math.min(10, 1.6 * Math.pow(1.2, generation - 10));
  return /a\d+[xz]/i.test(m[0]) ? score * 1.6 : score;   // the iPad X and Z variants
};

// Adreno: flagship score per hundred series, factor by the tens digit within it.
const ADRENO_SERIES = [[3, 0.5], [4, 0.8], [5, 1.3], [6, 2.6], [7, 5.2], [8, 9]];
const ADRENO_CLASS = [[0, 0.45], [30, 1], [40, 1.25], [50, 1.5], [60, 1.7], [80, 1.5]];
const adreno = (m) => {
  const number = Number(m[1]);
  return stepTable(ADRENO_SERIES, Math.floor(number / 100)) * stepTable(ADRENO_CLASS, number % 100);
};

const MALI_G = new Map([
  [31, 0.3], [51, 0.6], [52, 0.8], [57, 1.2], [68, 1.6], [71, 1.5], [72, 1.8], [76, 2.6], [77, 3.2], [78, 3.6],
  [310, 0.5], [510, 1.5], [610, 3.2], [615, 3.4], [620, 3.6], [625, 4], [710, 5.2], [715, 6], [720, 7], [725, 8],
]);
const maliG = (m) => {
  const number = Number(m[1]);
  return MALI_G.get(number) ?? (number >= 700 ? 6 : number >= 100 ? 3 : 1);
};

// ---------------------------------------------------------------- the table
//
// First match wins, so specific rows come before the catch-all of their vendor. Families:
//   software    CPU rasteriser or remote/virtual adapter
//   integrated  shares memory with the CPU (laptops, small desktops)
//   discrete    separate desktop or laptop card
//   apple       Apple silicon Macs
//   mobile      phones and tablets (thermally limited however fast the first minute is)
// Patterns are tested against the raw string with (R), (TM) and similar marks removed.

const rule = (family, pattern, score) => ({ family, pattern, score: typeof score === 'function' ? score : () => score });

export const RULES = Object.freeze([
  // Software and virtual adapters.
  rule('software', /swiftshader|llvmpipe|softpipe|lavapipe|software|basic render|\bwarp\b|mesa offscreen/i, 0),
  rule('software', /vmware|svga3d|virgl|virtualbox|parallels|\bqxl\b|citrix|microsoft remote/i, 0.8),

  // NVIDIA: the console chip first, then workstation and halo cards, then the numbered GeForce lines.
  rule('mobile', /tegra/i, 2.5),
  rule('discrete', /rtx\s*(\d)\d{3}\s*(?:sff\s*)?ada/i, (m) => stepTable([[0, 20], [4, 33], [5, 45], [6, 55]], Number(m[1]))),
  rule('discrete', /rtx\s*(?:pro\s*)?a(\d)\d{3}/i, (m) => stepTable([[0, 13], [2, 17], [3, 20], [4, 28], [5, 36], [6, 45]], Number(m[1]))),
  rule('discrete', /quadro\s*rtx\s*(\d)\d{3}/i, (m) => stepTable([[0, 18], [4, 22], [5, 27], [6, 31]], Number(m[1]))),
  rule('discrete', /quadro\s*p(\d{3,4})/i, (m) => stepTable([[0, 2.5], [500, 3.5], [1000, 5], [2000, 9.5], [3000, 13], [5000, 17], [6000, 20]], Number(m[1]))),
  rule('discrete', /titan/i, 22),
  rule('discrete', /(?:geforce|nvidia)\s*(rtx|gtx|gts|gt|mx)?\s*(\d{3,4})(m\b|mx\b)?\s*(ti\s*super|ti|super)?/i, geforce),
  rule('discrete', /quadro|\bnvs\b/i, 3),
  rule('discrete', /nvidia|geforce/i, 6),

  // Samsung's Radeon-based phone GPU must not fall into the AMD rows.
  rule('mobile', /xclipse\s*(\d{3})/i, (m) => fromTable([[920, 5], [940, 6.5], [960, 8]], Number(m[1]))),

  // AMD discrete.
  rule('discrete', /radeon\s*(?:rx|pro)\s*w?(\d{4})(m|s)?\s*(xtx|xt)?/i, radeonRx),
  rule('discrete', /(?:rx|pro)\s*vega\s*(\d{2})/i, (m) => (Number(m[1]) >= 48 ? 14 + (Number(m[1]) - 48) / 4 : 7.5)),
  rule('discrete', /rx\s*vega/i, 15),
  rule('discrete', /radeon\s*vii\b/i, 25),
  // AMD integrated, before the three-digit discrete row that would also match "Radeon 780M".
  rule('integrated', /radeon\s*8(\d{2})0s/i, (m) => stepTable([[0, 11], [5, 20], [6, 25]], Number(m[1]))),
  rule('integrated', /radeon\s*(\d{3})m\b/i, (m) => stepTable(RADEON_MOBILE_IGPU, Number(m[1]))),
  rule('integrated', /vega\s*(\d{1,2})\b/i, (m) => stepTable(VEGA_IGPU, Number(m[1]))),
  rule('integrated', /vangogh|van gogh|custom gpu 0(?:405|932)/i, 4.5),
  rule('discrete', /radeon\s*(?:rx|pro)?\s*([45]\d{2})x?\b/i, polaris),
  rule('discrete', /radeon\s*r(\d)\b/i, RADEON_R),
  rule('discrete', /radeon\s*hd\s*(\d{4})/i, RADEON_HD),
  rule('integrated', /radeon\s*graphics/i, 3.5),
  rule('discrete', /radeon|firepro|\bamd\b|\bati\b/i, 4),

  // Intel.
  rule('discrete', /\barc\s*(?:pro\s*)?([ab])(\d{3})(m)?/i, ARC_DISCRETE),
  rule('integrated', /\barc\s*(\d{3})v/i, (m) => (Number(m[1]) >= 140 ? 8.5 : 7)),
  rule('integrated', /\barc\s*graphics/i, 7),
  rule('integrated', /iris\s*xe\s*max/i, 4.5),
  rule('integrated', /iris\s*xe|\bxe\s*graphics/i, 4),
  rule('integrated', /iris/i, 2.5),
  rule('integrated', /uhd\s*graphics\s*(\d{3})?/i, INTEL_UHD),
  rule('integrated', /hd\s*graphics\s*p?(\d{3,4})?/i, INTEL_HD),
  rule('integrated', /intel\s*graphics/i, 2.5),   // the unnumbered name on recent low-power chips
  rule('integrated', /intel/i, 1.5),

  // Apple. A masked "Apple GPU" (Safari) is resolved from the environment in describeGraphics.
  rule('apple', /apple\s*m(\d+)\s*(pro|max|ultra)?/i, appleM),
  rule('mobile', /apple\s*a(\d{1,2})[xz]?\b/i, appleA),
  rule('apple-masked', /apple\s*gpu/i, 0),

  // Phones, tablets and Arm laptops.
  rule('integrated', /adreno.*?x1-?(\d{2})/i, (m) => (Number(m[1]) >= 85 ? 8 : 4.5)),
  rule('mobile', /adreno\D*(\d{3})/i, adreno),
  rule('mobile', /immortalis-g(\d{3})/i, (m) => stepTable([[0, 6.5], [720, 8], [900, 10]], Number(m[1]))),
  rule('mobile', /mali-g(\d{2,3})/i, maliG),
  rule('mobile', /mali/i, 0.5),
  rule('mobile', /powervr/i, (m) => (/ge8\d{3}/i.test(m.input) ? 0.4 : 1)),
  rule('mobile', /videocore|vivante|adreno/i, 0.4),
]);

// ---------------------------------------------------------------- environment

/** Device facts beyond the GPU, read defensively from the browser. Every field may be undefined. */
export function readEnvironment() {
  const nav = globalThis.navigator || {};
  const scr = globalThis.screen || {};
  const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  const platform = typeof nav.platform === 'string' ? nav.platform : '';
  const touchPoints = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  return {
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    // Safari implements no `deviceMemory` at all, so on an iPad the number is missing rather than large.
    // iPadOS also reports itself as a Macintosh, which is why the touch points are the tell (the same test
    // every iOS browser check uses): a Mac with a touchscreen is not a thing Safari can pretend to be.
    ios: /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1),
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    screenWidth: typeof scr.width === 'number' ? scr.width : undefined,
    screenHeight: typeof scr.height === 'number' ? scr.height : undefined,
    devicePixelRatio: typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : undefined,
    touch: typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints > 0 : undefined,
  };
}

// ---------------------------------------------------------------- renderer string

/**
 * Reduces a raw renderer string to a name fit to show a player:
 * "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)" -> "NVIDIA GeForce RTX 3070".
 */
export function cleanRendererName(raw) {
  let name = String(raw || '').trim();
  const angle = /^ANGLE \((.*)\)$/.exec(name);
  if (angle) {
    // ANGLE (vendor, device, backend). The device may itself contain commas inside parentheses.
    const parts = splitTopLevel(angle[1]).map((p) => p.trim());
    // A vendor such as "Samsung Electronics Co., Ltd." spills into the second field.
    const device = parts.length >= 3 && /^(?:ltd|inc|corp)\.?$/i.test(parts[1]) ? 2 : 1;
    name = parts.length > device ? parts[device] : parts[0];
    // Some Android drivers nest a second wrapper: "ANGLE (Samsung Xclipse 920) on Vulkan 1.1.179".
    const nested = /^ANGLE \(([^()]*)\)/.exec(name);
    if (nested) name = nested[1];
  }
  name = name
    .replace(/^ANGLE Metal Renderer:\s*/i, '')
    .replace(/^Vulkan [\d.]+ \((.*)\)$/i, '$1')
    .replace(/\((?:R|TM|C)\)/gi, '')
    .replace(/,? or similar$/i, '')
    .replace(/\s+Direct3D.*$/i, '')
    .replace(/\s+OpenGL Engine$/i, '')
    .replace(/\/PCIe.*$/i, '')
    .replace(/^Mesa (?:DRI )?/i, '')
    .replace(/\s*\(0x[0-9a-f]+\)/gi, '');
  // Driver codenames and build details in trailing parentheses: "(KBL GT2)", "(radeonsi, navi23, LLVM ...)".
  let previous;
  do { previous = name; name = name.replace(/\s*\([^()]*\)\s*$/, ''); } while (name !== previous && name.length > 0);
  // Vulkan drivers repeat the vendor: "NVIDIA NVIDIA GeForce RTX 3090".
  return name.replace(/\s+/g, ' ').trim().replace(/^(\S+) \1(?= )/i, '$1');
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Matches a renderer string against RULES.
 * Returns { family, score } or { family: 'unknown', score: -1 } when nothing matches.
 */
export function classifyRenderer(raw) {
  const text = String(raw || '').replace(/\((?:R|TM|C)\)/gi, '');
  for (const r of RULES) {
    const m = r.pattern.exec(text);
    if (m) return { family: r.family, score: r.score(m) };
  }
  return { family: 'unknown', score: -1 };
}

// ---------------------------------------------------------------- detection

/** Score a preset needs on a 1080p screen. Ultra Low needs nothing: it is the floor Auto can fall to. */
export const PRESET_MIN_SCORE = Object.freeze({ ultraLow: 0, low: 3, medium: 5, high: 14, ultra: 27, ultraHigh: 48 });

const REFERENCE_PIXELS = 1920 * 1080;
const rank = (preset) => PRESET_NAMES.indexOf(preset);
const lower = (a, b) => (rank(a) <= rank(b) ? a : b);

/**
 * How much heavier than 1080p a preset is on this screen, as a factor on the score it needs.
 * A preset's own resolution scale and pixel-ratio limit are applied first, so Low on a 4K laptop
 * is judged on the pixels Low would really render. The square root reflects that roughly half of
 * a frame's cost scales with pixels and that dynamic resolution takes up part of the difference.
 */
function pixelLoad(preset, env) {
  if (!(env.screenWidth > 0) || !(env.screenHeight > 0)) return 1;
  const table = PRESETS[preset];
  const ratio = Math.min(env.devicePixelRatio > 0 ? env.devicePixelRatio : 1, table.maxPixelRatio);
  const pixels = env.screenWidth * env.screenHeight * ratio * ratio * table.resolutionScale * table.resolutionScale;
  return Math.sqrt(Math.max(1, pixels / REFERENCE_PIXELS));
}

/**
 * Full classification.
 *
 * caps: the renderer's caps ({ renderer: unmasked renderer string, tierHint?, ... }).
 * env:  see readEnvironment(); pass explicitly in tests.
 *
 * Returns {
 *   preset    starting preset for Auto
 *   ceiling   highest preset timing refinement may move to on this class of device
 *   family    'software' | 'integrated' | 'discrete' | 'apple' | 'mobile' | 'unknown'
 *   score     relative performance estimate, -1 when the GPU is not recognised
 *   renderer  the raw string, label: a cleaned name for display
 *   reasons   short sentences explaining the choice, for the settings screen
 * }
 */
export function describeGraphics(caps, env = readEnvironment()) {
  const renderer = String((caps && caps.renderer) || '');
  const label = cleanRendererName(renderer) || 'Unknown graphics device';
  let { family, score } = classifyRenderer(renderer);
  const reasons = [];

  if (family === 'apple-masked') {
    // Safari reports only "Apple GPU". Touch means iPhone or iPad; otherwise an Apple silicon
    // Mac, where ten or more cores means a Pro, Max or Ultra chip.
    if (env.touch) { family = 'mobile'; score = 4; }
    else { family = 'apple'; score = env.hardwareConcurrency >= 10 ? 16 : 9; }
    reasons.push('The browser hides the exact Apple GPU model, so the estimate is cautious.');
  }

  let preset;
  let ceiling = 'ultra';

  if (family === 'unknown') {
    // No usable string (blocked by privacy settings, or a GPU the table has never seen).
    const hint = caps && isPresetName(caps.tierHint) ? caps.tierHint : null;
    const strongHost = !env.touch && env.hardwareConcurrency >= 8 && !(env.deviceMemory < 8);
    preset = hint || (strongHost ? FALLBACK_PRESET : 'ultraLow');
    reasons.push(renderer ? 'Unrecognised graphics device; starting cautiously.' : 'The browser does not reveal the graphics device; starting cautiously.');
  } else {
    preset = 'ultraLow';
    for (const name of PRESET_NAMES) {
      if (score >= PRESET_MIN_SCORE[name] * pixelLoad(name, env)) preset = name;
    }
    if (family === 'software') {
      ceiling = 'ultraLow';
      reasons.push('Software rendering: hardware acceleration is off or unavailable in this browser, so Auto will not go above Ultra Low.');
    } else if (family === 'mobile') {
      ceiling = 'medium';
      reasons.push('Phone or tablet graphics.');
    } else if (family === 'integrated') {
      reasons.push('Integrated graphics.');
    } else if (family === 'apple') {
      reasons.push('Apple silicon.');
    } else {
      reasons.push('Dedicated graphics card.');
    }
    const unconstrained = stepPresetByScore(score);
    if (rank(preset) < rank(unconstrained)) reasons.push('Lowered for the number of pixels on this screen.');
  }

  // Memory and cores bound what the rest of the game (streaming, traffic, physics) can keep up with.
  if (env.deviceMemory <= 2) { ceiling = lower(ceiling, 'ultraLow'); reasons.push('2 GB of memory or less limits Auto to Ultra Low.'); }
  else if (env.deviceMemory <= 4) { ceiling = lower(ceiling, 'medium'); reasons.push('4 GB of memory limits Auto to Medium.'); }
  if (env.hardwareConcurrency <= 2) { ceiling = lower(ceiling, 'ultraLow'); reasons.push('Two processor cores or fewer limit Auto to Ultra Low.'); }
  else if (env.hardwareConcurrency <= 4) { ceiling = lower(ceiling, 'high'); reasons.push('Four processor cores limit Auto to High.'); }

  preset = lower(preset, ceiling);
  // Memory of its own, apart from how fast the machine is. A 3 GB iPad shares those bytes with the OS, the
  // tab and the picture, and what fills them first is the big buffers: the sign atlas, the render targets,
  // the tiles of city held around the car. Those are what `lowMemory` shrinks (render/quality.js and
  // world/index.js), and shrinking them costs a little sharpness rather than a lot of the street.
  // An iPad or iPhone that reports no memory is treated as small, because the ones that need this most and
  // the ones that do not differ by 8 GB and the browser will not say which is which; a desktop that reports
  // nothing is left alone, since a desktop with 16 GB and a hidden number is the common case.
  const lowMemory = (env.deviceMemory !== undefined ? env.deviceMemory <= 4 : env.ios === true)
    || family === 'software';
  if (lowMemory) {
    reasons.push(env.deviceMemory !== undefined
      ? `${env.deviceMemory} GB of memory: the city is held in a small-memory budget.`
      : 'An iOS device that will not say its memory: held in a small-memory budget.');
  }
  // A device without 32-bit float render targets is not a broken device — the renderer builds the frame in
  // 16-bit float on it (render/gl.js). The note is here because on an older iPad that line is the proof that
  // the game noticed and coped, rather than the person having to read a console.
  if (caps && caps.floatSupport === 'half') reasons.push('HDR is drawn in 16-bit float: this device has no 32-bit float render targets, and the renderer works around it.');
  return { preset, ceiling, family, score, renderer, label, reasons, lowMemory };
}

/** Preset by score alone, ignoring the screen. */
function stepPresetByScore(score) {
  let preset = 'ultraLow';
  for (const name of PRESET_NAMES) if (score >= PRESET_MIN_SCORE[name]) preset = name;
  return preset;
}

let lastDetected = FALLBACK_PRESET;

/** Starting preset for Auto on this device: one of PRESET_NAMES, weakest first from 'ultraLow'. */
export function detectGraphics(caps, env = readEnvironment()) {
  lastDetected = describeGraphics(caps, env).preset;
  return lastDetected;
}

// ---------------------------------------------------------------- refinement from frame times

const TARGET_MS = 1000 / 60;

/** Fewer samples than this say too little; the preset is left alone. */
export const MIN_TIMING_SAMPLES = 90;

/** Frame times above this are a hidden tab or a debugger pause, not rendering. */
const DISCONTINUITY_MS = 250;

/**
 * Summary of a run of frame times: { count, mean, p90, gpuP90 }.
 * The first 15% are dropped as warm-up (shader compilation, first tile uploads) and the slowest
 * 5% of the rest as hitches, so the figures describe steady-state rendering. gpuP90 is -1 unless
 * at least half of the samples carried a GPU time.
 */
export function analyseTimings(samples) {
  const frame = [], gpu = [];
  const count = samples ? samples.length : 0;
  for (let i = Math.floor(count * 0.15); i < count; i++) {
    const s = samples[i];
    const ms = typeof s === 'number' ? s : s && s.ms;
    if (!(ms > 0) || ms > DISCONTINUITY_MS) continue;
    frame.push(ms);
    const g = typeof s === 'number' ? -1 : s.gpuMs;
    if (g > 0) gpu.push(g);
  }
  frame.sort((a, b) => a - b);
  gpu.sort((a, b) => a - b);
  const steady = frame.slice(0, Math.max(1, Math.floor(frame.length * 0.95)));
  let sum = 0;
  for (const ms of steady) sum += ms;
  const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -1);
  return {
    count: frame.length,
    mean: steady.length ? sum / steady.length : -1,
    p90: percentile(steady, 0.9),
    gpuP90: gpu.length > 0 && gpu.length * 2 >= frame.length ? percentile(gpu, 0.9) : -1,
  };
}

/**
 * Moves the Auto preset once from measured frame times and returns the preset to use.
 *
 * samples: frame times in milliseconds, either numbers or { ms, gpuMs } (gpuMs <= 0 when the GPU
 *          timer is unavailable). Measure at the preset's fixed resolution scale, with dynamic
 *          resolution held off, so the numbers describe the preset and not the scaler.
 * options: { current  preset the samples were measured at (default: the last detectGraphics result),
 *            ceiling  highest preset allowed (default 'ultra'),
 *            frameCap the active frame rate limit, 0 for none }
 *
 * Down: one step when the average falls below about 50 fps or more than a tenth of frames miss
 * their slot badly; two steps below 30 fps, because one step will not rescue that.
 * Up: one step, and only on evidence of real headroom. With vertical sync a frame time says
 * nothing about slack, so the evidence is either GPU time under 45% of the budget, or a
 * high-refresh display being held at over 100 fps.
 */
export function refineFromTimings(samples, options = {}) {
  const current = isPresetName(options.current) ? options.current : lastDetected;
  const ceiling = isPresetName(options.ceiling) ? options.ceiling : 'ultra';
  const cap = options.frameCap > 0 ? options.frameCap : 0;
  if (!samples || samples.length < MIN_TIMING_SAMPLES) return lower(current, ceiling);

  const t = analyseTimings(samples);
  if (t.count < MIN_TIMING_SAMPLES / 2) return lower(current, ceiling);

  const budget = cap ? Math.max(TARGET_MS, 1000 / cap) : TARGET_MS;
  let move = 0;
  if (t.mean > budget * 2) move = -2;
  else if (t.mean > budget * 1.2 || t.p90 > budget * 1.8) move = -1;
  else if (t.mean < budget * 1.1) {
    const gpuHeadroom = t.gpuP90 > 0 && t.gpuP90 < TARGET_MS * 0.45;
    const fastDisplay = !cap && t.p90 < TARGET_MS * 0.6;
    if (gpuHeadroom || fastDisplay) move = 1;
  }

  const index = Math.min(PRESET_NAMES.length - 1, Math.max(0, rank(current) + move));
  return lower(PRESET_NAMES[index], ceiling);
}
