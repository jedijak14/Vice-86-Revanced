// GLASS surface family: vehicle glazing and clear lamp covers, forward-blended after lighting
// (design/ARCHITECTURE.md section 5.6). o.alpha is the opacity seen square-on; the renderer raises it with the
// Fresnel term and adds the sky and screen reflections, so this family only describes the pane itself.
//
//   TINTED      windows. Vertex colour = tint hue, p0 = tint strength x 255 (50 windscreen, 70 side glass).
//               p1 > 0 marks a wiped windscreen: uv is then the position on the pane in metres from the wiper
//               spindle (x across, y up the glass), p1 = outer and p2 = inner radius of the swept band in cm.
//   CLEAR       untinted glass.
//   LAMP_COVER  p0 = 0 a smooth smoked cover; p0 = 1 a fluted headlamp lens (uv in metres) that glows with objB.x.
//   LAMP_LENS   a moulded lens in front of a modelled reflector and bulb. Vertex colour = lens colour, uv in metres
//               from the bulb axis, p0 = optics (lensOptics kinds 0..4), p1 = the lamp circuit that lights it
//               (lampLevel), p2 = density x 255: how much of what is behind the lens it hides (clear 30, amber 150,
//               red 190). Blending is 'over', so the parts behind a coloured lens are modelled in its colour.
//
// Rain stands in beads on the outside face, runs on steep panes and is cleared inside the wiper's sweep while it
// is raining. Road film (objA.w) fogs the lower edge of the glass.

import { GLASS } from '../../core/ids.js';
import { LAMP_RADIANCE, LAMP_GLSL } from './vehicle.js';

const IDS = Object.entries(GLASS).map(([name, id]) => `const int G_${name} = ${id};`).join('\n');

const fragment = LAMP_GLSL + /* glsl */`
${IDS}
const float WIPER_HALF_SWEEP = 1.25;      // radians either side of straight up the glass
const float GLASS_FLUTE = 0.006;          // pitch of the headlamp lens flutes, metres

// 1 inside the band a wiper keeps clear. q = position from the spindle in metres, radii in metres.
float wiperSweep(vec2 q, float outer, float inner, float w) {
  float r = length(q), a = abs(atan(q.x, q.y));
  return aastep(inner, r, w) * aastep(r, outer, w) * aastep(a, WIPER_HALF_SWEEP, w / max(r, 0.05));
}

void surface(in SurfIn s, inout SurfOut o) {
  SurfFrame f = planeFrame(s); SurfFrame u = uvFrame(s, s.uv);
  int id = int(s.mat.x + 0.5); float p0 = s.mat.y;
  float steep = 1.0 - abs(s.N.y);
  // rain and dust only reach the outside face, and not the underside of anything
  float sky = (s.front ? 1.0 : 0.0) * saturate(s.occ * 1.6 - 0.4) * smoothstep(-0.4, 0.05, s.N.y);
  float amount = uWeather.y * sky;
  o.rough = 0.03; o.metal = 0.0; o.coat = 0.0;

  if (id == G_TINTED) {
    float tint = p0 / 255.0;
    // A pane is modelled with both its faces, so each carries half of the tint: a windscreen passes about three
    // quarters of the light, as the law asks of it, and the cabin shows through.
    o.albedo = s.color * 0.03; o.alpha = min(0.05 + 0.5 * tint, 0.92);
    if (s.mat.z > 0.5) {
      float swept = wiperSweep(s.uv, s.mat.z * 0.01, s.mat.w * 0.01, u.px);
      amount *= 1.0 - 0.85 * swept * smoothstep(0.02, 0.15, uWeather.x);
      sky *= 1.0 - 0.8 * swept;                                               // the blade also clears the road film
    }
  } else if (id == G_LAMP_COVER) {
    if (p0 > 0.5) {
      float x = fract(s.uv.x / GLASS_FLUTE) - 0.5, fade = 1.0 - smoothstep(0.25, 0.9, u.px / GLASS_FLUTE);
      float fill = 1.0 - 1.3 * abs(x) * fade;
      o.N = slopeNormal(o.N, u, vec2(x * 1.2 * fade, 0.0));
      o.albedo = s.color * 0.06; o.alpha = mix(0.34, 0.14, fill);              // flute flanks show the housing, crowns the bowl
      o.emissive = vec3(1.0, 0.92, 0.78) * s.objB.x * ${(LAMP_RADIANCE.head * 0.3).toFixed(1)} * fill;
    } else { o.albedo = s.color * 0.2; o.alpha = 0.42; }
  } else if (id == G_LAMP_LENS) {
    float fill, density = s.mat.w / 255.0; vec2 slope = lensOptics(int(p0 + 0.5), s.uv, u.px, fill);
    o.N = slopeNormal(o.N, u, slope * 0.25);
    // the flanks of each element turn the eye into the plastic itself; its crown looks through to the reflector
    o.albedo = s.color * mix(0.45, 0.25, fill); o.alpha = mix(min(density * 1.6 + 0.15, 1.0), density, fill);
    // lit, the moulding scatters part of the beam: the whole lens glows in its colour around the bulb's own image
    // and more of it near the bulb than at the edges, where a mapped lens (uv in metres from the bulb axis) says so
    float level = lampLevel(int(s.mat.z + 0.5), s.objB), focus = lampFocus(level);
    float spread = u.px > 0.0 ? mix(0.45, 1.0, bulbFalloff(length(s.uv), 0.04)) : 1.0;
    o.emissive = lensHue(s.color) * level * (0.1 + 0.3 * fill * fill) * mix(0.5, 1.0, density) * spread * mix(1.0, 0.3, focus);
  } else { o.albedo = s.color * 0.02; o.alpha = 0.06; }

  // road film (the fraction of objA.w; its whole part is the paint finish): a haze that is thickest low down
  float soil = fract(s.objA.w);
  if (soil > 0.0) {
    vec4 cloud = noiseTexGrad(f.p * 70.0, f.dx * 70.0, f.dy * 70.0);
    float film = soil * sky * (0.12 + 0.5 * (1.0 - smoothstep(0.3, 0.3 + 0.7 * soil, s.lpos.y + (cloud.r - 0.5) * 0.2)));
    o.albedo = mix(o.albedo, vec3(0.19, 0.155, 0.115), film); o.alpha = mix(o.alpha, 1.0, film * 0.6); o.rough = mix(o.rough, 0.6, film);
  }

  // drops are small lenses: they bend the view and each carries its own highlight
  vec4 beads = waterBeads(f.p * 1.7, steep, f.px * 1.7, amount * 0.75);       // the same fine beads as on the paint
  o.N = slopeNormal(o.N, f, beads.xy);
  o.alpha = mix(o.alpha, max(o.alpha, 0.5), beads.z * 0.6);
}
`;

export default { name: 'glass', fragment, twoSided: true };
