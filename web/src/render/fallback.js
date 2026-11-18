// Stand-ins that keep the renderer running when a module is missing or broken: a plain surface family
// (vertex colour, sensible roughness) and a minimal analytic sky. Both are deliberately simple; they
// exist so that a failure in one owner's module shows up as "that surface looks plain" in a running
// game rather than as a black screen.

import { HEAD, FULLSCREEN_VS_FAR, SKY_BLOCK_BINDING } from './host.js';
import { FRAME_BLOCK } from './shaders/contract.js';

/** Family used in place of any surface family that failed to load or compile. */
export function fallbackFamily(name) {
  if (name === 'glass') {
    return { name, alphaTest: false, twoSided: false, deform: '', fragment: /* glsl */`
void surface(in SurfIn s, inout SurfOut o) {
  o.albedo = s.color * 0.15; o.rough = 0.04; o.alpha = 0.35;
}` };
  }
  return { name, alphaTest: false, twoSided: name === 'foliage', deform: '', fragment: /* glsl */`
void surface(in SurfIn s, inout SurfOut o) {
  o.albedo = s.color; o.rough = 0.75;
}` };
}

const SKY_GLSL = /* glsl */`
layout(std140) uniform Sky {
  vec4 uSkyZenith;     // rgb = radiance overhead
  vec4 uSkyHorizon;    // rgb = radiance at the horizon
  vec4 uSkyGround;     // rgb = radiance from below the horizon
  vec4 uSkyFogColor;   // rgb = fog in-scatter colour, a = density per metre at sea level
  vec4 uSkyFogShape;   // x = height falloff per metre
};
vec3 skyGradient(vec3 dir, float blur) {
  float up = dir.y;
  vec3 above = mix(uSkyHorizon.rgb, uSkyZenith.rgb, pow(saturate(up), 0.45));
  // The wider the lobe, the more of the opposite hemisphere it sees: soften the horizon accordingly.
  return mix(uSkyGround.rgb, above, smoothstep(-0.04 - blur, 0.04 + blur, up));
}
vec3 envSpecular(vec3 dir, float roughness) { return skyGradient(dir, roughness * roughness); }
vec3 envDiffuse(vec3 n) { return skyGradient(n, 1.0); }
vec4 skyFog(vec3 rel) {
  float dist = length(rel), y0 = uCamPos.y, dy = rel.y;
  // Exponential height fog integrated analytically along the view ray.
  float k = uSkyFogShape.x, slope = abs(dy) > 0.01 ? (1.0 - exp(-k * dy)) / (k * dy) : 1.0;
  float optical = uSkyFogColor.a * exp(-k * max(y0, 0.0)) * dist * slope;
  float transmittance = exp(-optical);
  return vec4(uSkyFogColor.rgb * (1.0 - transmittance), transmittance);
}
`;

/**
 * Last resort: the sky functions from the Frame block alone, with no uniform block or texture of their own.
 * Used to rebuild a renderer program when the sky module's chunk does not compile on this device, so that
 * a broken chunk costs the look of the sky lighting and not the whole frame.
 */
export const PLAIN_SKY_GLSL = /* glsl */`
vec3 skyPlain(vec3 dir, float blur) {
  // Level of the sky set from the dominant light: a sunlit sky is about a sixteenth of the sun's irradiance.
  vec3 zenith = mix(vec3(0.012, 0.016, 0.03), uSunColor.rgb * vec3(0.03, 0.05, 0.085), uSunDir.w);
  vec3 above = mix(zenith * 1.6 + 0.01 * uSwitch.w * vec3(1.0, 0.6, 0.35), zenith, pow(saturate(dir.y), 0.45));
  return mix(zenith * 0.25, above, smoothstep(-0.04 - blur, 0.04 + blur, dir.y));
}
vec3 envSpecular(vec3 dir, float roughness) { return skyPlain(dir, roughness * roughness); }
vec3 envDiffuse(vec3 n) { return skyPlain(n, 1.0); }
vec4 skyFog(vec3 rel) {
  float transmittance = exp(-length(rel) * 0.00012 * (1.0 + 6.0 * uWeather.x));
  return vec4(skyPlain(normalize(vec3(rel.x, 0.0, rel.z) + 1e-4), 1.0) * (1.0 - transmittance), transmittance);
}
`;

/** Minimal sky module with the same shape as src/render/sky/index.js. */
export function createFallbackSky(host) {
  const gl = host.gl, data = new Float32Array(20);
  let buffer = null;
  const allocate = () => {
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer); gl.bufferData(gl.UNIFORM_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, SKY_BLOCK_BINDING, buffer);
  };
  allocate();
  host.onRestore(allocate);

  const dome = host.createProgram('fallback sky', FULLSCREEN_VS_FAR, HEAD + '#define saturate(x) clamp(x, 0.0, 1.0)\n' + FRAME_BLOCK + SKY_GLSL + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 p = uInvViewProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dir = normalize(p.xyz / p.w);
  vec3 c = skyGradient(dir, 0.0);
  float disc = smoothstep(0.99985, 0.99995, dot(dir, uSunDir.xyz));
  c += uSunColor.rgb * disc * mix(0.4, 8.0, uSunDir.w);
  outColor = vec4(c, 1.0);
}`);

  host.registerPass('prepare', (ctx) => {
    const env = ctx.env || {}, sky = env.ambientSky || [0.5, 0.7, 1.0], ground = env.ambientGround || [0.1, 0.1, 0.1], fog = env.fogColor || sky;
    for (let i = 0; i < 3; i++) {
      data[i] = sky[i]; data[4 + i] = sky[i] * 0.7 + fog[i] * 0.5; data[8 + i] = ground[i]; data[12 + i] = fog[i];
    }
    data[15] = env.fogDensity || 0; data[16] = 1 / Math.max(1, env.fogHeight || 200);
    gl.bindBuffer(gl.UNIFORM_BUFFER, buffer); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, data);
  });
  host.registerPass('background', () => { if (dome.use()) host.drawFullscreen(); });
  // The same methods as the real module, so that callers need not ask which one they got.
  return { glsl: SKY_GLSL, fallback: true, ready: true, setShoreField() {}, setCity() {}, invalidate() {}, dispose() { gl.deleteBuffer(buffer); } };
}
