// Exhaust flames (ARCHITECTURE 16): nitrous jets and after-fire bursts.
//
// A flame is glowing gas, so it is rendered as one: the vertex shader places a box around the jet and the
// fragment shader marches the view ray through it, integrating an animated procedural emission field in
// the jet's own frame. That gives a real volume from every angle, including the chase camera looking
// almost straight down the jet, where ribbons or a sprite would fall apart. The march stops at the scene
// depth, so the flame sinks softly into the bumper or the road instead of cutting a line.
//
// The pass runs after temporal AA on the resolved image (the gas has no hard edges to antialias and no
// motion vector to reproject it with). It writes without blending:
//   rgb = scene behind, displaced by heat haze, + emitted radiance
//   a   = blur mask for the motion blur that follows (0 where the flame is, so the road streaking past
//         under it does not smear it)
// uFlameSource is a copy of the image being drawn into (WebGL cannot read the target it writes).

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH } from '../host.js';

/** Extent of the box around a jet, in units of the jet (see FLAME_VS). The haze reaches beyond and above the flame. */
export const FLAME_HULL = Object.freeze({ side: 3.2, rise: 5.0, back: 0.08, front: 1.35 });
/** Half-width, in jet radii, of the tube around the axis that the burning gas never leaves. */
const FLAME_TUBE = 2.0;

/**
 * Unit cube (attribute 0, corners in [0,1]^3) stretched over the hull.
 * uFlameOrigin = (camera-relative pipe exit, jet length in metres), uFlameAxis = (unit direction, jet radius),
 * uFlameSide / uFlameUp = unit vectors completing the jet frame (up is the one nearest to world up).
 */
export const FLAME_VS = HEAD + surfacePrelude(LIB, 'vert') + /* glsl */`
layout(location = 0) in vec3 aCorner;
uniform vec4 uFlameOrigin;
uniform vec4 uFlameAxis;
uniform vec3 uFlameSide;
uniform vec3 uFlameUp;
out vec3 vRel;
void main() {
  float radius = uFlameAxis.w, len = uFlameOrigin.w;
  vec3 local = vec3((aCorner.x * 2.0 - 1.0) * ${FLAME_HULL.side.toFixed(2)} * radius,
                    mix(-${FLAME_HULL.side.toFixed(2)}, ${FLAME_HULL.rise.toFixed(2)}, aCorner.y) * radius,
                    mix(-${FLAME_HULL.back.toFixed(2)}, ${FLAME_HULL.front.toFixed(2)}, aCorner.z) * len);
  vRel = uFlameOrigin.xyz + uFlameSide * local.x + uFlameUp * local.y + uFlameAxis.xyz * local.z;
  gl_Position = uViewProjStable * vec4(vRel, 1.0);        // the image is already resolved: no sub-pixel jitter
}`;

/**
 * uFlameParams = (strength 0..1, kind: 0 nitrous / 1 after-fire, seed, peak radiance),
 * uFlameScreen = (1 / target size, pixels per metre at depth 1, haze strength).
 */
export const FLAME_FS = HEAD + surfacePrelude(LIB, 'frag') + DEPTH + /* glsl */`
uniform sampler2D uFlameSource;
uniform vec4 uFlameOrigin;
uniform vec4 uFlameAxis;
uniform vec3 uFlameSide;
uniform vec3 uFlameUp;
uniform vec4 uFlameParams;
uniform vec4 uFlameScreen;
in vec3 vRel;
layout(location = 0) out vec4 outColor;

// How much hot air is at a point of the jet frame (p.z along the jet in units of its length, p.xy across it
// in units of its radius): a wide plume that drifts upwards as it leaves the pipe. It ends inside the hull on
// every side (the hull is 3.2 radii to the sides and 5 up), so the haze has no edge.
float flameHeat(vec3 p) {
  vec2 lifted = p.xy - vec2(0.0, 1.6 * p.z * p.z + 0.4);
  float plume = saturate(1.0 - dot(lifted, lifted) / (1.9 * 1.9));
  return plume * plume * smoothstep(-0.08, 0.1, p.z) * (1.0 - smoothstep(0.7, 1.3, p.z));
}

// Emission per unit of optical length at a point of the jet frame.
vec3 flameField(vec3 p, float strength, float kind, float seed) {
  float time = uTime.x, r = length(p.xy);
  // Turbulence carried downstream at gas speed, so that features travel along the jet instead of boiling in place.
  vec3 q = vec3(p.xy * 0.55, p.z * 2.4 - time * 9.0 + seed * 17.0);
  float n1 = vnoise3(q * 1.7), n2 = vnoise3(q * 4.1 + 7.3);
  if (p.z < 0.0) return vec3(0.0);

  if (kind < 0.5) {
    // ---- nitrous: an under-expanded supersonic jet. The gas overshoots, is squeezed back by the air
    // around it and overshoots again, leaving a chain of bright diamonds whose spacing grows with pressure.
    float reach = mix(0.42, 1.0, strength), x = p.z / reach;
    if (x > 1.25) return vec3(0.0);
    float pulse = 0.82 + 0.18 * sin(time * 53.0 + seed * 40.0) * sin(time * 31.0 + 1.7);
    float taper = mix(1.0, 0.3, saturate(x)) * (0.9 + 0.1 * pulse);
    float fade = 1.0 - smoothstep(0.55, 1.2, x + 0.25 * (n1 - 0.5));
    // Diamonds: the core swells and pinches along the jet; the pattern creeps and breathes a little.
    float cells = 5.2 / mix(0.75, 1.0, strength);
    float wave = abs(cos(PI * (x * cells - 0.08 * sin(time * 23.0 + seed * 9.0))));
    float coreRadius = 0.42 * taper * (0.22 + 0.78 * wave);
    float core = exp(-r * r / (coreRadius * coreRadius)) * (0.3 + 1.1 * wave * wave * wave) * (1.0 - smoothstep(0.5, 1.0, x)) * pulse;
    float bodyRadius = taper * (0.85 + 0.35 * (n1 - 0.5));
    float body = exp(-r * r / (bodyRadius * bodyRadius)) * fade * (0.7 + 0.6 * n2);
    // A thin shell where the jet shears against still air.
    float shell = exp(-pow((r - bodyRadius * 0.95) / (0.22 * taper), 2.0)) * fade * n2 * 0.5;
    // Blue-white where it is hottest, blue around that where the mixture burns clean, and amber where the
    // rest of the fuel finds air and burns sooty: downstream and outwards, along a ragged front.
    vec3 blue = vec3(0.08, 0.32, 1.0), amber = vec3(1.0, 0.40, 0.06);
    vec3 bodyColour = mix(blue, amber, smoothstep(0.3, 0.85, x + 0.4 * (n1 - 0.5) + 0.12 * r));
    // The glow dies out before the edge of the marched tube (FLAME_TUBE radii), which would otherwise show as a box.
    float window = 1.0 - smoothstep(1.1, 1.9, r);
    return (vec3(0.55, 0.9, 1.6) * core * 3.6 + bodyColour * (body * 1.3 + shell)) * (window * (0.35 + 0.65 * strength));
  }
  // ---- after-fire: unburnt fuel lighting in the pipe. A short ragged ball that tears apart as it leaves.
  float x = p.z / 0.9;
  if (x > 1.3) return vec3(0.0);
  float flicker = 0.7 + 0.3 * sin(time * 71.0 + seed * 50.0);
  float radius = (0.75 + 2.0 * x) * sqrt(max(1.0 - x, 0.0)) * (0.8 + 0.2 * flicker);
  float torn = n1 * 0.9 + n2 * 0.55;
  float density = saturate(1.35 - r / max(radius, 0.05) - torn * (0.5 + 1.1 * x)) * smoothstep(0.0, 0.06, x);
  // Hotter (yellow-white) at the pipe and in the thick of it, red where it thins out.
  float temperature = saturate(density * 1.4 + 0.5 * (1.0 - x) - 0.2);
  vec3 colour = mix(vec3(1.0, 0.16, 0.02), vec3(1.0, 0.55, 0.12), smoothstep(0.1, 0.6, temperature));
  colour = mix(colour, vec3(1.0, 0.9, 0.55), smoothstep(0.6, 1.0, temperature));
  return colour * density * (4.5 * strength * flicker);
}

// Where the ray o + t d is inside the box [lo, hi]: (entry clipped to the camera, exit).
vec2 slab(vec3 o, vec3 d, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / (abs(d) + 1e-6) * mix(vec3(-1.0), vec3(1.0), step(0.0, d));
  vec3 ta = (lo - o) * inv, tb = (hi - o) * inv, tNear = min(ta, tb), tFar = max(ta, tb);
  return vec2(max(max(tNear.x, tNear.y), max(tNear.z, 0.0)), min(tFar.x, min(tFar.y, tFar.z)));
}

void main() {
  vec2 screenUv = gl_FragCoord.xy * uFlameScreen.xy;
  vec3 scene = textureLod(uFlameSource, screenUv, 0.0).rgb;
  outColor = vec4(scene, 1.0);

  // The ray in the jet frame: z along the jet in jet lengths, xy across it in jet radii.
  float radius = uFlameAxis.w, len = uFlameOrigin.w;
  vec3 dirWorld = normalize(vRel), toOrigin = -uFlameOrigin.xyz;
  vec3 scale = vec3(1.0 / radius, 1.0 / radius, 1.0 / len);
  vec3 o = vec3(dot(toOrigin, uFlameSide), dot(toOrigin, uFlameUp), dot(toOrigin, uFlameAxis.xyz)) * scale;
  vec3 d = vec3(dot(dirWorld, uFlameSide), dot(dirWorld, uFlameUp), dot(dirWorld, uFlameAxis.xyz)) * scale;
  // The hull, clipped to the camera and to the first solid surface.
  float sceneZ = sceneDepth(screenUv), along = max(viewDepthOf(dirWorld), 1e-3), tScene = sceneZ / along;
  vec2 hull = slab(o, d, vec3(-${FLAME_HULL.side.toFixed(2)}, -${FLAME_HULL.side.toFixed(2)}, -${FLAME_HULL.back.toFixed(2)}), vec3(${FLAME_HULL.side.toFixed(2)}, ${FLAME_HULL.rise.toFixed(2)}, ${FLAME_HULL.front.toFixed(2)}));
  float t0 = hull.x, t1 = min(hull.y, tScene);
  if (t1 <= t0) return;

  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uTime.z * 5.588238, vec2(0.06711056, 0.00583715))));
  float strength = uFlameParams.x, kind = uFlameParams.y, seed = uFlameParams.z;
  // Two marches. The hot air fills the hull but is smooth, so a few steps do. The burning gas is thin and
  // detailed: it gets its own steps, spent only inside the tube it can occupy, or its edges would stipple.
  const int HAZE_STEPS = 6, FLAME_STEPS = 18;
  float heat = 0.0, dt = (t1 - t0) / float(HAZE_STEPS);
  for (int i = 0; i < HAZE_STEPS; i++) heat += flameHeat(o + d * (t0 + dt * (float(i) + noise)));
  heat *= dt / radius;
  vec3 emitted = vec3(0.0);
  vec2 tube = slab(o, d, vec3(-${FLAME_TUBE.toFixed(2)}, -${FLAME_TUBE.toFixed(2)}, 0.0), vec3(${FLAME_TUBE.toFixed(2)}, ${FLAME_TUBE.toFixed(2)}, 1.3));
  tube.y = min(tube.y, tScene);
  if (tube.y > tube.x) {
    dt = (tube.y - tube.x) / float(FLAME_STEPS);
    for (int i = 0; i < FLAME_STEPS; i++) emitted += flameField(o + d * (tube.x + dt * (float(i) + noise)), strength, kind, seed);
    emitted *= dt / radius;                                           // optical length of a step, in jet radii
  }

  // Heat haze: the image behind is displaced by a rising ripple, in proportion to the hot air looked through.
  vec3 mid = o + d * (0.5 * (t0 + t1));
  vec2 ripple = texture(uNoiseTex, vec2(mid.x * 0.11 + mid.z * 0.9, mid.y * 0.13 - uTime.x * 1.7) + seed).rg
              + texture(uNoiseTex, vec2(mid.x * 0.31 - mid.z * 1.7, mid.y * 0.29 - uTime.x * 2.9) + seed * 3.0).rg - 1.0;
  float haze = (1.0 - exp(-heat * 0.5)) * uFlameScreen.w * (0.4 + 0.6 * strength);
  vec2 offset = ripple * haze * 0.012 * uFlameScreen.z / max(sceneZ, 1.0) * uFlameScreen.xy;
  // Only what lies behind the hot air may be bent; never drag the car's own bodywork into the haze.
  if (sceneDepth(screenUv + offset) > t0 * along) scene = textureLod(uFlameSource, screenUv + offset, 0.0).rgb;

  // Thin gas shows its colour; thick gas saturates towards white-hot. This is what makes the core read as a core.
  vec3 glow = uFlameParams.w * (1.0 - exp(-emitted));
  float thickness = emitted.r + emitted.g + emitted.b;
  outColor = vec4(scene + glow, exp(-thickness * 2.5));
}`;
