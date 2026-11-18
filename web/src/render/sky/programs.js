// Complete shader sources of the sky module, assembled from the bodies in glsl/ and the host's chunks.
// Pure strings: index.js compiles them through the host, the tests validate every one without a GPU.
import { surfacePrelude } from '../shaders/contract.js';
import { LIB } from '../shaders/lib.js';
import { SKY_ATMOSPHERE, SKY_BLOCK, SKY_CHUNK, SKY_PHASE } from './glsl/common.js';
import { SKY_CITY_LIGHT, SKY_CLOUD_FS, SKY_CLOUD_LOOKUP, SKY_CLOUD_MAPPING, SKY_CLOUD_VOLUME } from './glsl/clouds.js';
import { SKY_DOME_FS, SKY_DOME_LIB, SKY_IRRADIANCE_FS, SKY_PREFILTER_FS, SKY_PROBE_FS, SKY_VIEW_FS } from './glsl/dome.js';
import { OCEAN_COMMON, OCEAN_FS, OCEAN_VS } from './glsl/ocean.js';
import { BOLT_FS, BOLT_VS, RAIN_FS, RAIN_VS, SPLASH_FS, SPLASH_VS } from './glsl/rain.js';

/**
 * hostGlsl: host.glsl (HEAD, FULLSCREEN_VS, FULLSCREEN_VS_FAR, DEPTH, SURFACE_WRITE_LIT, LIGHTING).
 * Returns { name: { vs, fs } } for every program the module links.
 */
export function skyPrograms(hostGlsl) {
  const g = hostGlsl;
  const frag = g.HEAD + surfacePrelude(LIB, 'frag'), vert = g.HEAD + surfacePrelude(LIB, 'vert');
  // the rain cover test is optional in the host: the define switches the calls on in the bodies
  const cover = g.RAIN_COVER ? '#define HOST_RAIN_COVER 1\n' + g.RAIN_COVER : '';
  const sky = frag + SKY_CHUNK + SKY_ATMOSPHERE + SKY_CITY_LIGHT, dome = sky + SKY_CLOUD_LOOKUP + SKY_DOME_LIB;
  // filters read only their source cube: no Frame-dependent chunk, so they never need relinking against the sky
  const filter = g.HEAD + '#define VICE_FRAGMENT 1\nconst float PI = 3.141592653589793, TAU = 6.283185307179586;\n';
  const particleFs = frag + g.DEPTH + g.LIGHTING + SKY_CHUNK;
  return {
    skyView: { vs: g.FULLSCREEN_VS, fs: frag + SKY_BLOCK + SKY_PHASE + SKY_ATMOSPHERE + SKY_VIEW_FS },
    clouds: { vs: g.FULLSCREEN_VS, fs: sky + SKY_CLOUD_MAPPING + SKY_CLOUD_VOLUME + SKY_CLOUD_FS },
    dome: { vs: g.FULLSCREEN_VS_FAR, fs: dome + SKY_DOME_FS },
    probe: { vs: g.FULLSCREEN_VS, fs: dome + SKY_PROBE_FS },
    prefilter: { vs: g.FULLSCREEN_VS, fs: filter + SKY_PREFILTER_FS },
    irradiance: { vs: g.FULLSCREEN_VS, fs: filter + SKY_IRRADIANCE_FS },
    ocean: {
      vs: vert + SKY_BLOCK + 'uniform sampler2D uSkyNoise;\n' + OCEAN_COMMON + OCEAN_VS,
      fs: frag + g.DEPTH + g.LIGHTING + g.SURFACE_WRITE_LIT + SKY_CHUNK + OCEAN_COMMON + OCEAN_FS,
    },
    rain: { vs: vert + cover + RAIN_VS, fs: particleFs + RAIN_FS },
    splash: { vs: vert + g.DEPTH + cover + SPLASH_VS, fs: particleFs + SPLASH_FS },
    bolt: { vs: vert + BOLT_VS, fs: frag + SKY_CHUNK + BOLT_FS },
  };
}
