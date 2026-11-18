// The list of every shader program the renderer uses, as plain sources. Kept apart from the GL code so
// that the same list can be compiled by the browser and validated offline (test/render/shaders.test.mjs).

import { FAMILY_NAMES } from '../core/ids.js';
import { FULLSCREEN_VS, FULLSCREEN_VS_FAR } from './host.js';
import { familyPrograms } from './shaders/surface.js';
import { LINEAR_DEPTH_FS, AO_FS, AO_BLUR_FS, lightingFragment } from './shaders/lighting.js';
import { SSR_TRACE_FS, MIRROR_LEVEL_FS, reflectionFragment } from './shaders/reflect.js';
import { TAA_FS, COPY_FS, BLUR_TILE_FS, BLUR_NEIGHBOUR_FS, MOTION_BLUR_FS, MOTION_BLUR_APPLY_FS, DEPTH_OF_FIELD_FS, BLOOM_PREFILTER_FS, BLOOM_DOWN_FS, BLOOM_UP_FS, EXPOSURE_FS, TONEMAP_FS, PRESENT_FS, DEBUG_FS } from './shaders/post.js';
import { GLOW_VS, glowFragment, GLOW_VIEW_VS, glowViewFragment, PARTICLE_VS, particleFragment } from './shaders/forward.js';
import { FLAME_VS, FLAME_FS } from './shaders/flame.js';
import { probeSkyFragment, PROBE_FILTER_FS } from './shaders/probe.js';

/** Family drawn in the forward pass instead of the G-buffer. */
export const FORWARD_FAMILY = 'glass';

/**
 * Programs that do not depend on surface families. skyGlsl: the sky module's chunk.
 * Returns [{ key, vertex, fragment, usesSky }]; usesSky marks the ones that include the chunk.
 */
export function fixedPrograms(skyGlsl) {
  return [
    { key: 'linearDepth', vertex: FULLSCREEN_VS, fragment: LINEAR_DEPTH_FS },
    { key: 'ao', vertex: FULLSCREEN_VS, fragment: AO_FS },
    { key: 'aoBlur', vertex: FULLSCREEN_VS, fragment: AO_BLUR_FS },
    { key: 'lighting', vertex: FULLSCREEN_VS_FAR, fragment: lightingFragment(skyGlsl), usesSky: true },
    { key: 'ssrTrace', vertex: FULLSCREEN_VS, fragment: SSR_TRACE_FS },
    { key: 'reflection', vertex: FULLSCREEN_VS_FAR, fragment: reflectionFragment(skyGlsl), usesSky: true },
    { key: 'probeSky', vertex: FULLSCREEN_VS, fragment: probeSkyFragment(skyGlsl), usesSky: true },
    { key: 'probeFilter', vertex: FULLSCREEN_VS, fragment: PROBE_FILTER_FS },
    { key: 'mirrorLevel', vertex: FULLSCREEN_VS, fragment: MIRROR_LEVEL_FS },
    { key: 'glow', vertex: GLOW_VS, fragment: glowFragment(skyGlsl), usesSky: true },
    { key: 'glowView', vertex: GLOW_VIEW_VS, fragment: glowViewFragment(skyGlsl), usesSky: true },
    { key: 'particle', vertex: PARTICLE_VS, fragment: particleFragment(skyGlsl), usesSky: true },
    { key: 'flame', vertex: FLAME_VS, fragment: FLAME_FS },
    { key: 'taa', vertex: FULLSCREEN_VS, fragment: TAA_FS },
    { key: 'copy', vertex: FULLSCREEN_VS, fragment: COPY_FS },
    { key: 'blurTile', vertex: FULLSCREEN_VS, fragment: BLUR_TILE_FS },
    { key: 'blurNeighbour', vertex: FULLSCREEN_VS, fragment: BLUR_NEIGHBOUR_FS },
    { key: 'motionBlur', vertex: FULLSCREEN_VS, fragment: MOTION_BLUR_FS },
    { key: 'blurApply', vertex: FULLSCREEN_VS, fragment: MOTION_BLUR_APPLY_FS },
    { key: 'depthOfField', vertex: FULLSCREEN_VS, fragment: DEPTH_OF_FIELD_FS },
    { key: 'bloomPrefilter', vertex: FULLSCREEN_VS, fragment: BLOOM_PREFILTER_FS },
    { key: 'bloomDown', vertex: FULLSCREEN_VS, fragment: BLOOM_DOWN_FS },
    { key: 'bloomUp', vertex: FULLSCREEN_VS, fragment: BLOOM_UP_FS },
    { key: 'exposure', vertex: FULLSCREEN_VS, fragment: EXPOSURE_FS },
    { key: 'tonemap', vertex: FULLSCREEN_VS, fragment: TONEMAP_FS },
    { key: 'present', vertex: FULLSCREEN_VS, fragment: PRESENT_FS },
    { key: 'debug', vertex: FULLSCREEN_VS, fragment: DEBUG_FS },
  ];
}

/**
 * Programs of the surface families: family x draw kind x pass.
 * families: Map or object of name -> normalised family. Returns [{ key, family, kind, pass, vertex, fragment }].
 */
export function surfacePrograms(families, skyGlsl) {
  const out = [];
  for (const name of FAMILY_NAMES) {
    const family = families[name];
    for (const p of familyPrograms(family, { forward: name === FORWARD_FAMILY, skyGlsl })) out.push({ ...p, family: name });
  }
  return out;
}
