// The street talks. Not with a synthesiser pretending to be a person: with two recorded voices, a
// man and a woman, banked as files in web/assets/voice/ and played back the way the engine samples
// are - decoded once, positioned in the world, and varied per speaker so that no two pedestrians
// deliver a line the same way.
//
// The line space is combinatorial on purpose. A context picks a template, a template picks a
// recorded variant for the speaker's gender, and a prosody seed - sixteen bits of it, per utterance,
// from the pedestrian's own identity - picks rate, lift and distance band. Five contexts, two
// genders, one variant each today and a prosody space of 65536 times four distance bands is already
// 2.6 million distinct audible renderings, and every new recorded variant multiplies it again. The
// bank grows; the space grows with it; `voiceLineSpace()` is the number, and a test holds it above
// a million.
//
// What a line *says* is chosen by what is happening: a car taken off the street gets the witness
// bark - the exact sentence the brief wrote, in both voices - a thrown-out driver gets the owner's
// scream, gunfire gets panic, a chased thief gets outrage, and a passer-by on a quiet pavement gets
// the weather. The subtitle row shows the words; the audio is the voice.

/** The recorded bank, by id: what was said, so the subtitle can show it without listening. */
export const LINE_TEXTS = Object.freeze({
  m_carjack: 'What are you doing?! I\'m calling the cops!',
  m_owner: 'What are you doing?! That\'s my car! Get out of it!',
  m_shots: 'Shots! Get down! Somebody call it in!',
  m_chase: 'Hey! Stop! Stop, that\'s mine!',
  m_greet: 'Morning. Watch the puddles, eh.',
  f_carjack: 'What are you doing?! I\'m calling the cops!',
  f_owner: 'What are you doing?! Hey, that\'s my car! Give it back!',
  f_shots: 'Gunshots! Oh god, get down, get down!',
  f_chase: 'Stop! Hey, stop, that\'s my car!',
  f_greet: 'Hey there. Nice day for it, isn\'t it?',
});

/**
 * Contexts: what can happen, and which recording each gender answers it with. Variants are arrays
 * because the bank grows - a second witness bark recorded tomorrow is one entry here and a
 * multiplication of the space.
 */
export const CONTEXTS = Object.freeze({
  carjack: Object.freeze({ m: ['m_carjack'], f: ['f_carjack'] }),
  owner: Object.freeze({ m: ['m_owner'], f: ['f_owner'] }),
  shots: Object.freeze({ m: ['m_shots'], f: ['f_shots'] }),
  chase: Object.freeze({ m: ['m_chase'], f: ['f_chase'] }),
  greet: Object.freeze({ m: ['m_greet'], f: ['f_greet'] }),
});

/** Sixteen bits of prosody per utterance, and four distance bands the gain and muffle choose from. */
export const PROSODY_SEEDS = 65536;
export const DISTANCE_BANDS = 4;

/** Distinct audible renderings the street can produce today. Grows with every recorded variant. */
export function voiceLineSpace() {
  let n = 0;
  for (const key of Object.keys(CONTEXTS)) {
    const c = CONTEXTS[key];
    n += c.m.length * PROSODY_SEEDS * DISTANCE_BANDS + c.f.length * PROSODY_SEEDS * DISTANCE_BANDS;
  }
  return n;
}

const hash32 = (a, b) => {
  let h = (a | 0) ^ Math.imul(b | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
};

/**
 * Which recording, and how delivered, for one utterance. Pure: a test can hear the same choice
 * twice, and a pedestrian's identity is the seed, so the same man always talks like himself.
 * @returns {{id: string, text: string, rate: number, band: number}}
 */
export function pickLine(context, gender, seed = 1) {
  const c = CONTEXTS[context] || CONTEXTS.greet;
  const variants = c[gender === 'f' ? 'f' : 'm'];
  const h = hash32(seed, context.length * 7919 + variants.length);
  const id = variants[h % variants.length];
  const pros = hash32(seed ^ 0x5bf03635, h);
  // Rate within six percent either side: the difference between two people reading the same line,
  // not the difference between a person and a tape running slow.
  const rate = 0.94 + ((pros >>> 8) % 1000) / 1000 * 0.12;
  const band = (pros >>> 24) % DISTANCE_BANDS;
  return { id, text: LINE_TEXTS[id] || '', rate, band };
}

/**
 * @param {{context?: function(): AudioContext|null, manifest?: object, fetch?: function}} deps
 */
export function createVoice(deps = {}) {
  const ctxOf = deps.context || (() => null);
  const fetchOf = deps.fetch || (typeof fetch === 'function' ? fetch : null);
  const buffers = new Map();
  let manifest = deps.manifest || null;
  let primed = false, priming = null;

  /** Decode the whole bank once, after the page's audio is unlocked. Silent until then. */
  function prime() {
    if (primed || priming || !fetchOf) return Promise.resolve(false);
    priming = (async () => {
      try {
        if (!manifest) {
          const res = await fetchOf('assets/voice/manifest.json');
          manifest = await res.json();
        }
        const ctx = ctxOf();
        if (!ctx || !manifest) return false;
        for (const name of Object.keys(manifest.files)) {
          const res = await fetchOf(`assets/voice/${name}`);
          const buf = await res.arrayBuffer();
          buffers.set(name.replace(/\.wav$/, ''), await ctx.decodeAudioData(buf));
        }
        primed = true;
        return true;
      } catch {
        return false;
      }
    })();
    return priming;
  }

  /**
   * Say a line at a place in the world.
   * @param {string} context   a CONTEXTS key
   * @param {string} gender    'm' | 'f'
   * @param {{x?: number, z?: number, lx?: number, lz?: number, seed?: number, gain?: number}} at
   * @returns {{text: string, seconds: number}|null} the words, for the subtitle row
   */
  function say(context, gender, at = {}) {
    const line = pickLine(context, gender, at.seed === undefined ? 1 : at.seed);
    const ctx = ctxOf();
    const buf = buffers.get(line.id);
    if (!ctx || !buf) return { text: line.text, seconds: 0 };
    const dx = (at.x || 0) - (at.lx || 0), dz = (at.z || 0) - (at.lz || 0);
    const dist = Math.hypot(dx, dz);
    // Four bands: beside you, across the street, down the block, shouting distance. Each is a gain
    // and a little less top end, because a voice carried is a voice muffled.
    const band = Math.min(3, Math.floor(dist / 12));
    const gain = (at.gain === undefined ? 1 : at.gain) * [1, 0.62, 0.34, 0.18][band];
    const when = ctx.currentTime + 0.02;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = line.rate * (1 + band * 0.004);
    const g = ctx.createGain();
    g.gain.value = gain;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = [16000, 9000, 5200, 3000][band];
    let node = g;
    src.connect(lpf); lpf.connect(g);
    if (ctx.createStereoPanner) {
      const pan = ctx.createStereoPanner();
      const az = Math.atan2(dx, dz) - (at.lyaw || 0);
      pan.pan.value = Math.max(-1, Math.min(1, Math.sin(az) * 0.8));
      g.connect(pan); node = pan;
    }
    node.connect(ctx.destination);
    src.start(when);
    return { text: line.text, seconds: buf.duration / line.rate };
  }

  return {
    prime, say, pickLine,
    get ready() { return primed; },
    get loaded() { return buffers.size; },
  };
}
