// A single spatialised electronic wail, voiced by the nearest audible pursuit
// car. Shares the game's unlocked AudioContext and master bus. No samples.
export function createSiren(context, master) {
  const carrier = context.createOscillator(), sweep = context.createOscillator();
  const depth = context.createGain(), filter = context.createBiquadFilter();
  const gain = context.createGain(), pan = context.createStereoPanner?.();
  carrier.type = 'sawtooth'; carrier.frequency.value = 830;
  sweep.type = 'sine'; sweep.frequency.value = 0.58; depth.gain.value = 275;
  filter.type = 'lowpass'; filter.frequency.value = 1850; filter.Q.value = 0.65;
  gain.gain.value = 0;
  sweep.connect(depth); depth.connect(carrier.frequency);
  carrier.connect(filter); filter.connect(gain);
  if (pan) { gain.connect(pan); pan.connect(master); } else gain.connect(master);
  carrier.start(); sweep.start();
  return {
    update(level, balance) {
      const t = context.currentTime;
      gain.gain.setTargetAtTime(0.095 * level, t, 0.10);
      if (pan) pan.pan.setTargetAtTime(balance, t, 0.12);
    },
    dispose() {
      sweep.stop(); carrier.stop();
      for (const node of [sweep, depth, carrier, filter, gain, pan]) if (node) node.disconnect();
    },
  };
}
