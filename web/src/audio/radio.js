// The radio: three stations, synthesised live, none of them bought.
//
// A car radio in a city with no recordings is a radio with no music, so the music is made the way the
// engines are made: from nothing, on purpose, in code. What is here is the *score* — a pure function of
// (station, bar number, random) that returns the notes one bar of one station contains — and a thin host
// binding that turns those notes into oscillators and noise on the page's AudioContext. The score is
// pure so that a test can hold a bar of lofi in its hands and argue with the swing; the binding is thin
// so that a page without audio is a page with a silent radio, not a crashed one.
//
// The stations:
//   kbay      "KBAY 89.1 · lofi to drive to" — 72 bpm, swung hats, Rhodes-ish keys on a ii-V-I-ish loop in
//             A minor, a sine bass that stays under the wheels, vinyl crackle and a tape that wows.
//   cruise    "Night Cruise" — 96 bpm synthwave: four on the floor, octave bass, a detuned saw pad and an
//             arpeggio that owes everything to the eighties and nothing to anybody's licence.
//   bayou     "Bayou FM" — 140 bpm of swung small-combo jazz: walking bass, shell voicings, a ride cymbal
//             that keeps the swing honest.
//
// Track titles are generated from each station's own word bank, sixteen bars at a time, because a radio
// that cannot tell you what it is playing is a speaker, not a radio.

/** midi note to hertz; 69 is the A above middle C, 440 Hz, as it is everywhere. */
export const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/** The stations, in the order the dial finds them. */
export const STATIONS = Object.freeze([
  Object.freeze({ id: 'kbay', name: 'KBAY 89.1', tagline: 'lofi to drive to', bpm: 72, swing: 0.16 }),
  Object.freeze({ id: 'cruise', name: 'Night Cruise', tagline: 'synthwave until sunrise', bpm: 96, swing: 0 }),
  Object.freeze({ id: 'bayou', name: 'Bayou FM', tagline: 'small combo, big water', bpm: 140, swing: 0.34 }),
]);

const WORDS = Object.freeze({
  kbay: [['Rain on', 'Late', 'Paper', 'Warm', 'Slow', 'Blue', 'Taped', 'Quiet'],
    ['Canvas', 'Corridors', 'Headlights', 'Static', 'Sunday', 'Neon', 'Cassette', 'Harbour']],
  cruise: ['Midnight Overpass', 'Chrome Horizon', 'Palms in Reverse', 'Voltage Dreams', 'Ocean Drive Rewind', 'Glass Coast'],
  bayou: ['Second Line Sunday', 'Magnolia Stomp', 'Brass and Biscuits', 'Riverboat Shuffle', 'Creole Moon', 'Tin Roof Bluesette'],
});

/** Chord vocabularies, as midi note stacks. Sevenths and ninths, because triads sound like a jingle. */
const CHORDS = Object.freeze({
  kbay: [[57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65], [52, 56, 59, 62]],   // Am7 Fmaj7 Gm7? no: G7-ish colour
  cruise: [[42, 49, 54, 57], [41, 48, 53, 56], [44, 51, 56, 59], [40, 47, 52, 55]],
  bayou: [[45, 52, 59, 62], [41, 48, 55, 58], [43, 50, 57, 60], [40, 47, 54, 57]],
});

/**
 * One bar of one station, as a list of note events.
 * @param {string} id      a STATIONS id
 * @param {number} bar     which bar of the set: the progression and the title walk on it
 * @param {(n: number) => number} rng  unit random, injected so a test can hear the same bar twice
 * @returns {{station: object, beat: number, title: string|null, notes: object[]}}
 *   notes carry `t` in seconds from the bar's downbeat, `dur`, `freq`, a `voice` the host knows how to
 *   build, and a `gain`.
 */
export function radioBar(id, bar, rng = Math.random) {
  const station = STATIONS.find((s) => s.id === id) || STATIONS[0];
  const beat = 60 / station.bpm;
  const swing = station.swing * beat;
  const chord = CHORDS[station.id][bar % 4];
  const notes = [];
  const at = (b, off = 0) => b * beat + (off ? swing : 0);
  const push = (t, dur, freq, voice, gain = 0.2) => notes.push({ t, dur, freq, voice, gain });

  if (station.id === 'kbay') {
    // Keys: the chord spread over the bar, twice, with the seventh arriving late like a thought.
    for (let i = 0; i < 4; i++) {
      const n = chord[(i + (bar >> 2)) % chord.length];
      push(at(i) + (i === 3 ? swing : 0), beat * 0.9, hz(n + 12), 'key', 0.16);
      if (i === 1) push(at(1.5, 1), beat * 0.5, hz(chord[3] + 12), 'key', 0.12);
    }
    push(at(0), beat * 1.8, hz(chord[0] - 12), 'bass', 0.3);
    push(at(2.5, 1), beat * 1.2, hz(chord[0] - 12 + (bar % 2 ? 7 : 0)), 'bass', 0.24);
    push(at(0), 0.12, 55, 'kick', 0.5);
    push(at(2), 0.12, 52, 'kick', 0.42);
    push(at(1, 1), 0.16, 1800, 'snare', 0.16);
    push(at(3, 1), 0.16, 1800, 'snare', 0.14);
    for (let b = 0; b < 4; b++) push(at(b, b % 2 === 1), 0.05, 7000, 'hat', 0.07 + rng(1) * 0.03);
    for (let k = 0; k < 3; k++) push(rng(2) * beat * 4, 0.02, 3000 + rng(3) * 3000, 'crackle', 0.03);
  } else if (station.id === 'cruise') {
    for (let b = 0; b < 4; b++) push(at(b), 0.14, 50, 'kick', 0.5);
    for (let e = 0; e < 8; e++) push(at(e * 0.5), 0.22, hz(chord[0] - 12 + (e % 2 ? 12 : 0)), 'bass', 0.26);
    for (const n of chord) push(at(0), beat * 3.8, hz(n + 12), 'pad', 0.07);
    for (let s = 0; s < 8; s++) {
      const n = chord[s % chord.length] + 24;
      push(at(s * 0.5), 0.2, hz(n), 'arp', 0.09);
    }
    push(at(1, 0), 0.18, 2400, 'snare', 0.14);
    push(at(3, 0), 0.18, 2400, 'snare', 0.14);
    for (let b = 0; b < 4; b++) push(at(b) + beat * 0.5, 0.04, 8000, 'hat', 0.06);
  } else {
    // Walking bass: root, third, fifth, an approach note that lies about where it is going.
    const walk = [chord[0], chord[1] - 12, chord[2] - 12, chord[0] - 12 + (bar % 2 ? 5 : 7)];
    for (let b = 0; b < 4; b++) push(at(b), beat * 0.85, hz(walk[b] - 12), 'bass', 0.3);
    for (const n of [chord[0], chord[2], chord[3]]) push(at(0.5), beat * 3.2, hz(n + 12), 'pad', 0.06);
    // The ride: ding, ding-a-ding, with the swing carrying the middle note.
    push(at(0), 0.3, 6000, 'ride', 0.08);
    push(at(1.66, 1), 0.25, 6000, 'ride', 0.06);
    push(at(2), 0.3, 6000, 'ride', 0.08);
    push(at(3.66, 1), 0.25, 6000, 'ride', 0.06);
    push(at(1), 0.1, 200, 'hat', 0.1);
    push(at(3), 0.1, 200, 'hat', 0.1);
    if (rng(4) < 0.5) push(at(2, 1) * 1.0, 0.4, hz(chord[3] + 24), 'key', 0.1);
  }
  notes.sort((a, b) => a.t - b.t);
  const title = bar % 16 === 0 ? titleFor(station, bar, rng) : null;
  return { station, beat, title, notes };
}

/** A track title, from the station's own bank: sixteen bars of a thing, then the next thing. */
export function titleFor(station, bar, rng = Math.random) {
  const bank = WORDS[station.id];
  if (!Array.isArray(bank[0])) return bank[(bar / 16 | 0) % bank.length];
  const a = bank[0][Math.floor(rng(5) * bank[0].length) % bank[0].length];
  const b = bank[1][Math.floor(rng(6) * bank[1].length) % bank[1].length];
  return `${a} ${b}`;
}

/**
 * The dial: holds the station, walks the bars, and hands each note to whoever can sound it.
 * @param {{context?: function(): AudioContext|null, volume?: number}} deps
 */
export function createRadio(deps = {}) {
  const ctxOf = deps.context || (() => null);
  let index = 0, bar = 0, nextBarAt = 0, playing = false, title = '';
  let rngState = (deps.seed || 7) >>> 0;
  const rng = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 4294967296;
  };
  let noiseBuf = null;
  const noise = (ctx) => {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  };

  /** One note, as nodes: a keyboard voice, a drum voice, or a tape artefact. */
  function voice(ctx, n, when, vol) {
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const peak = n.gain * vol;
    if (n.voice === 'kick') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(n.freq * 2.4, when);
      o.frequency.exponentialRampToValueAtTime(n.freq, when + 0.09);
      g.gain.setValueAtTime(peak, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + n.dur + 0.12);
      o.connect(g); o.start(when); o.stop(when + n.dur + 0.15);
      return;
    }
    if (n.voice === 'snare' || n.voice === 'hat' || n.voice === 'ride' || n.voice === 'crackle') {
      const s = ctx.createBufferSource();
      s.buffer = noise(ctx);
      const f = ctx.createBiquadFilter();
      f.type = n.voice === 'hat' || n.voice === 'ride' || n.voice === 'crackle' ? 'highpass' : 'bandpass';
      f.frequency.value = n.freq;
      f.Q.value = n.voice === 'snare' ? 1.2 : 0.8;
      g.gain.setValueAtTime(peak, when);
      g.gain.exponentialRampToValueAtTime(0.001, when + (n.voice === 'ride' ? 0.35 : n.dur + 0.05));
      s.connect(f); f.connect(g); s.start(when); s.stop(when + 0.4);
      return;
    }
    // Tonal voices: keys are a pair of detuned triangles through a shelf, pads a pair of saws, bass a
    // sine with a click of triangle on it, arps a square an octave too bright to be honest.
    const o = ctx.createOscillator(), o2 = ctx.createOscillator();
    o.type = n.voice === 'pad' ? 'sawtooth' : n.voice === 'arp' ? 'square' : n.voice === 'bass' ? 'sine' : 'triangle';
    o2.type = o.type;
    o.frequency.value = n.freq;
    o2.frequency.value = n.freq * (1 + (n.voice === 'pad' ? 0.004 : 0.0015));
    // The tape wow: a slow half-cent drift on everything tonal, because a perfect radio is a digital one.
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = 0.7 + rng() * 0.4;
    lg.gain.value = n.freq * 0.003;
    lfo.connect(lg); lg.connect(o.detune); lg.connect(o2.detune);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = n.voice === 'bass' ? 400 : n.voice === 'key' ? 2200 : n.voice === 'pad' ? 1400 : 3200;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, when + n.dur + (n.voice === 'pad' ? 0.6 : 0.25));
    o.connect(f); o2.connect(f); f.connect(g);
    o.start(when); o2.start(when); lfo.start(when);
    o.stop(when + n.dur + 0.8); o2.stop(when + n.dur + 0.8); lfo.stop(when + n.dur + 0.8);
  }

  const radio = {
    get station() { return STATIONS[index]; },
    get title() { return title; },
    get playing() { return playing; },
    /** The dial: next station, bar and title reset with it, the way a real dial loses the thread. */
    next() {
      index = (index + 1) % STATIONS.length;
      bar = 0;
      nextBarAt = 0;
      title = titleFor(STATIONS[index], 0, rng);
      return radio.station;
    },
    start() { playing = true; nextBarAt = 0; if (!title) title = titleFor(radio.station, bar, rng); return radio; },
    stop() { playing = false; return radio; },
    /**
     * Called every frame with the clock: schedules a bar ahead of the audio clock, so the music is
     * never a frame late however bad the frame was.
     * @param {number} volume 0..1 of the radio's own knob
     */
    tick(volume = 0.5) {
      const ctx = ctxOf();
      if (!playing || !ctx) return 0;
      if (nextBarAt < ctx.currentTime) nextBarAt = ctx.currentTime + 0.05;
      let scheduled = 0;
      while (nextBarAt < ctx.currentTime + 0.6) {
        const b = radioBar(radio.station.id, bar, rng);
        if (b.title) title = b.title;
        const barLen = b.beat * 4;
        for (const n of b.notes) voice(ctx, n, nextBarAt + n.t, volume);
        scheduled += b.notes.length;
        nextBarAt += barLen;
        bar = (bar + 1) % 4096;
      }
      return scheduled;
    },
  };
  return radio;
}
