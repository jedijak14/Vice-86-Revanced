// Web Audio hosting of the synth core. Preferred: an AudioWorkletNode whose module is the DSP
// source stringified into a Blob URL (no separate file to serve, no build step). Fallback when
// worklets are unavailable or the module fails to load: a ScriptProcessorNode running the same
// core on the main thread. When there is no AudioContext at all, the host is a silent no-op.
// Everything here is wrapped so that a failure anywhere degrades to silence, never to a throw.

import { createDsp, workletSource, PROCESSOR_NAME } from './dsp/index.js';

const FALLBACK_BLOCK = 1024;

/**
 * @param {{ seed: number, scope?: object }} options
 *        `scope` is where AudioContext is looked up (defaults to globalThis); tests pass a mock.
 */
export function createHost(options) {
  const scope = options.scope || globalThis;
  const AudioContextCtor = scope.AudioContext || scope.webkitAudioContext;
  const host = {
    available: !!AudioContextCtor,
    ready: false,
    mode: 'none',                   // 'worklet' | 'script' | 'none'
    context: null,
    stats: null,                    // last stats report from the synth, if any
    /** The bus everything is heard through, for the few sounds made on this side of the
     * worklet (a patrol siren); null until unlock() has run. */
    get output() { return master; },
    unlock, setMaster, postState, postEvent, suspend, resume, dispose, pollStats,
  };
  let context = null, master = null, node = null, synth = null, unlocking = false, disposed = false;
  let pendingEvents = [];

  function unlock() {
    if (!host.available || disposed || unlocking || host.ready) { if (context && context.state === 'suspended') safe(() => context.resume()); return; }
    unlocking = true;
    try {
      context = host.context = new AudioContextCtor({ latencyHint: 'interactive' });
      master = context.createGain(); master.gain.value = 0; master.connect(context.destination);
      safe(() => context.resume());
      const useWorklet = !!(context.audioWorklet && scope.AudioWorkletNode && scope.Blob && scope.URL && scope.URL.createObjectURL);
      if (useWorklet) {
        const url = scope.URL.createObjectURL(new scope.Blob([workletSource()], { type: 'text/javascript' }));
        const done = () => { safe(() => scope.URL.revokeObjectURL(url)); };
        Promise.resolve(context.audioWorklet.addModule(url)).then(() => {
          done();
          if (disposed) return;
          try { buildWorklet(); } catch (err) { buildScript(err); }
        }, (err) => { done(); if (!disposed) buildScript(err); });
      } else buildScript(null);
    } catch (err) {
      unlocking = false; host.available = false;
    }
  }

  function buildWorklet() {
    node = new scope.AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { seed: options.seed | 0 },
    });
    node.port.onmessage = (e) => { if (e.data && e.data.stats) host.stats = e.data.stats; };
    node.connect(master);
    host.mode = 'worklet';
    finish();
  }

  /** The fallback graph. `reason` is the worklet failure, kept out of the console unless something else fails too. */
  function buildScript(reason) {
    try {
      if (!context.createScriptProcessor) throw new Error('no ScriptProcessorNode');
      const K = createDsp();
      synth = new K.ViceSynth(context.sampleRate, options.seed | 0);
      node = context.createScriptProcessor(FALLBACK_BLOCK, 0, 2);
      node.onaudioprocess = (e) => {
        const out = e.outputBuffer;
        synth.process(out.getChannelData(0), out.getChannelData(1), out.length);
      };
      node.connect(master);
      host.mode = 'script';
      finish();
    } catch (err) {
      unlocking = false; host.available = false; host.mode = 'none';
      if (reason) console.warn('audio: worklet failed and fallback failed', reason, err); else console.warn('audio: fallback failed', err);
    }
  }

  function finish() {
    host.ready = true; unlocking = false;
    for (const ev of pendingEvents) postEvent(ev[0], ev[1], ev[2], ev[3], ev[4]);
    pendingEvents.length = 0;
    setMaster(masterTarget);
  }

  let masterTarget = 1;
  /** Master volume, ramped over 30 ms. */
  function setMaster(v) {
    masterTarget = v;
    if (!master) return;
    safe(() => {
      const t = context.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setTargetAtTime(v, t, 0.03);
    });
  }

  /** Sends the state vector. The array is cloned by postMessage; the caller keeps reusing it. */
  function postState(values) {
    if (!host.ready) return;
    if (synth) synth.setState(values); else safe(() => node.port.postMessage(values));
  }

  function postEvent(code, a = 0, b = 0, c = 0, d = 0) {
    if (!host.ready) { if (!disposed && pendingEvents.length < 32) pendingEvents.push([code, a, b, c, d]); return; }
    if (synth) synth.event(code, a, b, c, d);
    else safe(() => node.port.postMessage({ ev: [code, a, b, c, d] }));
  }

  /** Asks the synth for a stats report; the worklet answers asynchronously into host.stats. */
  function pollStats() {
    if (!host.ready) return;
    if (synth) host.stats = synth.stats; else safe(() => node.port.postMessage({ stats: true }));
  }

  function suspend() { if (context) safe(() => context.suspend()); }
  function resume() { if (context) safe(() => context.resume()); }
  function dispose() {
    disposed = true; host.ready = false;
    if (node) safe(() => node.disconnect());
    if (master) safe(() => master.disconnect());
    if (context) safe(() => context.close());
    node = master = context = synth = null; host.context = null; host.mode = 'none';
  }

  return host;
}

/** Runs a Web Audio call that may legitimately fail (closed context, autoplay policy) and ignores the failure. */
function safe(fn) { try { const r = fn(); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (err) { /* degraded, not fatal */ } }
