// Assembles the DSP namespace from the define* functions and produces the AudioWorklet module
// source: the same functions stringified into one script, plus the processor glue. The page
// turns that string into a Blob URL (host.js); the tests evaluate it in a bare VM context.

import { defineKernel } from './kernel.js';
import { defineTables } from './tables.js';
import { defineVoices } from './voices.js';
import { defineEngine } from './engine.js';
import { defineRoad } from './road.js';
import { defineWorld } from './world.js';
import { defineAmbience } from './ambience.js';
import { defineGarage } from './garage.js';
import { defineFx } from './fx.js';
import { defineSynth } from './synth.js';

/** Order matters: later modules use classes defined by earlier ones. */
export const DEFINITIONS = [
  defineKernel, defineTables, defineVoices, defineEngine, defineRoad, defineWorld, defineAmbience, defineGarage, defineFx, defineSynth,
];

/** Builds a fresh namespace with every DSP class. */
export function createDsp() {
  const K = {};
  for (const define of DEFINITIONS) define(K);
  return K;
}

/** Name the worklet processor is registered under. */
export const PROCESSOR_NAME = 'vice-synth';

/**
 * Glue that runs inside the AudioWorkletGlobalScope. Written as a function so that it can be
 * stringified like the define* functions; it is never called on the page.
 * Messages from the page: a Float32Array is the state vector; { ev: [code, a, b, c, d] } is an
 * event; { stats: true } asks for a stats report, answered with { stats: {...} }.
 */
function workletMain(K) {
  class ViceProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const opts = (options && options.processorOptions) || {};
      this.synth = new K.ViceSynth(sampleRate, opts.seed | 0);
      this.port.onmessage = (e) => {
        const d = e.data;
        if (d instanceof Float32Array) this.synth.setState(d);
        else if (d && d.ev) this.synth.event(d.ev[0], d.ev[1], d.ev[2], d.ev[3], d.ev[4]);
        else if (d && d.stats) this.port.postMessage({ stats: this.synth.stats });
      };
    }
    process(inputs, outputs) {
      const out = outputs[0];
      if (out && out.length) this.synth.process(out[0], out.length > 1 ? out[1] : out[0], out[0].length);
      return true;
    }
  }
  registerProcessor('vice-synth', ViceProcessor);
}

/** The complete AudioWorklet module as a string. */
export function workletSource() {
  const parts = ['"use strict";', 'const K = {};'];
  for (const define of DEFINITIONS) parts.push(`(${define.toString()})(K);`);
  parts.push(`(${workletMain.toString()})(K);`);
  return parts.join('\n');
}
