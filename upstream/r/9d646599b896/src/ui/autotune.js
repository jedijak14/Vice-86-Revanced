// Auto preset bookkeeping for the boot sequence: classify the device, fill in the concrete
// graphics fields, collect frame times while the menu scene runs, move the preset once, and
// remember the outcome per GPU so later visits start where the last measurement ended.
//
//   const tuner = createAutoTuner({ settings, caps: renderer.caps });
//   renderer.setQuality(settings.graphics);  ui.setDeviceInfo(tuner.info);
//   // every rendered frame, until tuner.done:
//   if (tuner.sample(frameMs, stats.gpuMs)) { actions.applySettings(settings); ui.setDeviceInfo(tuner.info); }
//
// While tuner.measuring is true the game should render at the preset's fixed resolution scale
// (dynamic resolution held off), otherwise the scaler hides the very thing being measured.

import { describeGraphics, refineFromTimings, readEnvironment } from './detect.js';
import { resolveAuto, isPresetName, browserStorage, readStored, writeStored } from './settings.js';

export const AUTO_STORAGE_KEY = 'vice86.auto';

/** Frames collected before deciding: four seconds at 60 Hz, of which the first 15% are discarded. */
export const AUTO_SAMPLE_COUNT = 240;

/** The preset an earlier session settled on for this exact renderer string, or null. */
export function recallAuto(renderer, storage = browserStorage()) {
  const memo = readStored(storage, AUTO_STORAGE_KEY);
  if (!memo || typeof memo !== 'object' || memo.renderer !== renderer || !isPresetName(memo.preset)) return null;
  return memo.preset;
}

/** Stores the refined preset against the renderer string. Returns whether the write succeeded. */
export function rememberAuto(renderer, preset, storage = browserStorage()) {
  return writeStored(storage, AUTO_STORAGE_KEY, { renderer, preset });
}

/**
 * options: { settings, caps, env?, storage?, sampleCount? }
 * Returns {
 *   info       describeGraphics result plus { autoPreset, refined } for ui.setDeviceInfo
 *   measuring  true while samples are still wanted
 *   done       true once the single adjustment has been made (or was never needed)
 *   sample(frameMs, gpuMs = -1) -> true exactly once, when the preset moved and settings changed
 * }
 * If the player picks a fixed preset while measuring, the measurement is abandoned and nothing is stored.
 */
export function createAutoTuner({ settings, caps, env = readEnvironment(), storage = browserStorage(), sampleCount = AUTO_SAMPLE_COUNT }) {
  const description = describeGraphics(caps, env);
  // An empty renderer string identifies nothing, so nothing is remembered against it.
  const remembered = description.renderer ? recallAuto(description.renderer, storage) : null;
  const info = { ...description, autoPreset: remembered || description.preset, refined: remembered !== null };
  resolveAuto(settings, info.autoPreset);

  const samples = Array.from({ length: sampleCount }, () => ({ ms: 0, gpuMs: -1 }));
  let filled = 0;

  const tuner = {
    info,
    measuring: remembered === null && settings.graphics.preset === 'auto',
    get done() { return !tuner.measuring; },

    sample(frameMs, gpuMs = -1) {
      if (!tuner.measuring) return false;
      if (settings.graphics.preset !== 'auto') { tuner.measuring = false; return false; }
      const slot = samples[filled++];
      slot.ms = frameMs;
      slot.gpuMs = gpuMs;
      if (filled < sampleCount) return false;

      tuner.measuring = false;
      const refined = refineFromTimings(samples, {
        current: info.autoPreset, ceiling: info.ceiling, frameCap: settings.graphics.frameCap,
      });
      const moved = refined !== info.autoPreset;
      info.autoPreset = refined;
      info.refined = true;
      if (info.renderer) rememberAuto(info.renderer, refined, storage);
      if (moved) resolveAuto(settings, refined);
      return moved;
    },
  };
  return tuner;
}
