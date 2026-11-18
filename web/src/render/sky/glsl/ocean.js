// Ocean surface. One camera-centred mesh, displaced by the long waves and shaded per pixel by all of them.
// Sources are BODIES; index.js prepends the host head, the Frame block, lib.js and the chunks it needs.
//
// The water stage is forward lit: this shader produces the refracted sea bed, the colour of the water body, foam and the
// direct highlights. Environment and screen-space reflection, and fog, are added by the renderer from the surface
// description written at the end (host.js section 5).

/** Number of wave trains in the full set (waves.js fills the uniforms). */
export const WAVE_COUNT = 28;
/** The longest waves also get a second, time-lagged evaluation: the foam a breaking crest leaves behind. */
const LAG_WAVES = 12;

/** Wave table, shore map and the motions tied to the shore. Shared by the vertex and fragment stages. */
export const OCEAN_COMMON = /* glsl */`
uniform vec4 uWaveA[${WAVE_COUNT}];    // xy = wave vector (rad/m, direction of travel), z = amplitude on the open sea (m), w = phase at the camera (rad)
uniform vec4 uWaveB[${WAVE_COUNT}];    // x = wavelength (m), y = share kept in sheltered water, z = phase lag of the foam trail (rad), w = crest sharpening
uniform int uWaveCount;
uniform sampler2D uSkyShore;           // r = distance to the shore (m, positive over water), g = 0 sand / 0.5 rock / 1 wall, b = exposure to the open sea 0..1

vec3 skyShore(vec2 wxz) {
  if (uSkyCoast.z <= 0.0) return vec3(1.0e4, 0.0, 1.0);
  return textureLod(uSkyShore, (wxz - uSkyCoast.xy) * uSkyCoast.zw, 0.0).rgb;
}
// Share of a wave train's open-sea amplitude that exists at a place: long waves do not get into the bay or the canals,
// and no wave survives closer to the shore than a fraction of its own length (there the breakers take over).
float skyWaveGain(vec4 b, float exposure, float shoreDist) {
  float open = smoothstep(0.12, 0.85, exposure);
  return mix(b.y * mix(0.35, 1.0, saturate(exposure * 6.0)), 1.0, open) * smoothstep(0.0, 1.0, shoreDist / (0.3 * b.x + 0.8));
}
// Swash: the level of the water at the beach rises quickly and drains slowly, out of step along the shore, so the
// waterline runs up the sand in lobes. Returns metres to add to the surface.
float skySwash(vec2 wxz, vec3 shore) {
  float near = 1.0 - smoothstep(4.0, 24.0, shore.x);
  if (near <= 0.0) return 0.0;
  float lobe = textureLod(uSkyNoise, wxz * (1.0 / 210.0), 0.0).b;
  float s = fract(uSkySea.z * (1.0 / 7.5) + lobe * 1.3);
  float level = s < 0.3 ? smoothstep(0.0, 0.3, s) : 1.0 - smoothstep(0.3, 1.0, s);
  float reach = (0.07 + 0.30 * uSkySea.y) * mix(0.25, 1.0, smoothstep(0.1, 0.8, shore.z));
  return (level - 0.3) * reach * near;
}
// Breakers: crests parallel to the shore that steepen, break and run in as foam on the ocean side.
// x = height (m), y = foam 0..1, z = d(height) / d(distance to shore).
vec3 skyBreaker(vec2 wxz, vec3 shore) {
  float d = shore.x, zone = smoothstep(62.0, 34.0, d) * smoothstep(1.0, 7.0, d) * smoothstep(0.45, 0.8, shore.z) * (1.0 - smoothstep(0.6, 0.9, shore.y));
  if (zone <= 0.0) return vec3(0.0);
  const float SPACING = 17.0;
  float ph = d * (1.0 / SPACING) + uSkySea.z * (1.0 / 6.5), crest = floor(ph), x = ph - crest;
  // each crest is broken into stretches along the shore, different for every crest
  float stretch = smoothstep(0.34, 0.62, textureLod(uSkyNoise, wxz * (1.0 / 150.0) + crest * vec2(0.37, 0.61), 0.0).b);
  float rise = smoothstep(0.26, 0.40, x), fall = 1.0 - smoothstep(0.40, 0.98, x), shape = rise * fall * sqrt(fall);
  float h = (0.16 + 0.85 * uSkySea.y) * zone * mix(0.35, 1.0, stretch);
  float breaking = smoothstep(40.0, 24.0, d) * stretch;
  // a solid white front where the crest tips over, thinning quickly into the lace it leaves behind
  // (the lip does not tip over along a ruled line: its place wanders by a metre or so along the crest)
  float xf = x + (textureLod(uSkyNoise, wxz * (1.0 / 19.0) + crest * 0.23, 0.0).b - 0.5) * 0.09;
  float foam = breaking * smoothstep(0.33, 0.42, xf) * mix(0.4 * (1.0 - smoothstep(0.5, 0.97, xf)), 0.92, exp(-max(xf - 0.42, 0.0) * 16.0));
  // slope by a small step in the phase (the profile is piecewise smooth)
  float x2 = x + 0.02, shape2 = smoothstep(0.26, 0.40, x2) * pow(1.0 - smoothstep(0.40, 0.98, x2), 1.5);
  return vec3(h * shape, foam, h * (shape2 - shape) / (0.02 * SPACING));
}
`;

export const OCEAN_VS = /* glsl */`
layout(location = 0) in vec2 aPos;     // polar mesh position, metres from the camera at mesh scale 1
uniform vec4 uOcean;                   // x = mesh scale, y = 1 displace / 0 flat, z = water level (m), w = vertex spacing as a share of the radius
out vec3 vRel;                         // camera-relative position
out vec2 vBase;                        // camera-relative xz before displacement (where the waves are evaluated)
out vec3 vWave;                        // x = wave height (m), y = swash level (m), z = breaker height (m)
void main() {
  vec2 base = aPos * uOcean.x, wxz = base + uCamPos.xz;
  float spacing = uOcean.w * length(base) + 0.02;
  vec3 shore = skyShore(wxz), d = vec3(0.0);
  if (uOcean.y > 0.5) {
    for (int i = 0; i < uWaveCount; i++) {
      vec4 a = uWaveA[i], b = uWaveB[i];
      // only waves the mesh can carry here; the weight is a smooth function of distance, so rings never pop
      float w = smoothstep(2.5, 6.0, b.x / spacing);
      if (w <= 0.0) break;                                   // sorted long to short
      float amp = a.z * w * skyWaveGain(b, shore.z, shore.x), th = dot(a.xy, base) + a.w;
      d.y += amp * sin(th);
      d.xz += a.xy * (b.x * (1.0 / TAU) * b.w * amp * cos(th));   // towards the crest: sharp crests, broad troughs
    }
  }
  float swash = skySwash(wxz, shore);
  float breaker = uOcean.y > 0.5 ? skyBreaker(wxz, shore).x * (1.0 - smoothstep(0.5, 2.2, spacing)) : 0.0;
  vRel = vec3(base.x + d.x, uOcean.z - uCamPos.y + d.y + swash + breaker, base.y + d.z);
  vBase = base; vWave = vec3(d.y, swash, breaker);
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;

/** Needs: Frame, lib, SURFACE_STRUCTS, DEPTH, LIGHTING, SURFACE_WRITE_LIT, the sky chunk, OCEAN_COMMON. */
export const OCEAN_FS = /* glsl */`
in vec3 vRel; in vec2 vBase; in vec3 vWave;
uniform sampler2D uSceneOpaque;
uniform vec4 uOcean;

struct SkyWaveField { vec2 slope; float fold; float lagFold; float height; float variance; };
// All wave trains at a point, each filtered against the footprint of the pixel ALONG ITS OWN direction of travel, so
// crests running away from the eye stay sharp to the horizon while those seen end-on melt into roughness.
SkyWaveField skyWaves(vec2 base, vec2 dx, vec2 dy, float exposure, float shoreDist) {
  SkyWaveField f; f.slope = vec2(0.0); f.fold = 0.0; f.lagFold = 0.0; f.height = 0.0; f.variance = 0.0;
  for (int i = 0; i < uWaveCount; i++) {
    vec4 a = uWaveA[i], b = uWaveB[i];
    float amp = a.z * skyWaveGain(b, exposure, shoreDist);
    if (amp < 1e-5) continue;
    vec2 dir = a.xy * (b.x * (1.0 / TAU));
    float span = (abs(dot(dir, dx)) + abs(dot(dir, dy))) / b.x, w = 1.0 - smoothstep(0.16, 0.45, span);
    float steep = amp * TAU / b.x;
    f.variance += 0.5 * steep * steep * (1.0 - w * w);
    if (w <= 0.0) continue;
    float th = dot(a.xy, base) + a.w, s = sin(th);
    f.slope += a.xy * (amp * w * cos(th));
    f.fold += b.w * steep * w * s;
    f.height += amp * w * s;
    if (i < ${LAG_WAVES}) f.lagFold += b.w * steep * w * sin(th + b.z);
  }
  return f;
}

// Foam is a sheet of bubbles that opens into a net of strings and then into single flecks as it spreads and bursts.
// amount 0..1 is how much of the sheet is left; the result is the share of the pixel it covers.
float skyLace(vec2 p, float amount) {
  vec2 warp = texture(uSkyNoise, p * 0.043).ba - 0.5;
  float cells = texture(uSkyNoise, p * 0.11 + warp * 0.3).g, fine = texture(uSkyNoise, p * 0.37 + warp * 0.5 + 0.41).g, froth = texture(uSkyNoise, p * 1.3 + 0.17).g;
  // high along the strings between the cells; the thresholds are the ends of this sum's range (0.28 .. 0.64)
  float net = 1.0 - (cells * 0.5 + fine * 0.32 + froth * 0.18), from = mix(0.66, 0.20, amount);
  return smoothstep(from, from + 0.08, net);
}
// Network of bright lines the waves focus onto the sea bed. Mean about 1.
float skyCaustics(vec2 p, float t) {
  vec2 a = texture(uSkyNoise, p * 0.075 + t * vec2(0.011, 0.007)).ba;
  vec2 b = texture(uSkyNoise, p * 0.105 - t * vec2(0.009, 0.013) + (a - 0.5) * 0.06).ab;
  float ridge = 1.0 - abs(a.x - b.x) * 3.2, ridge2 = 1.0 - abs(a.y - b.y) * 3.2;
  return 0.72 + 1.2 * pow(saturate(ridge), 6.0) * saturate(ridge2 + 0.35);
}
// Sparkle: the sea surface is a crowd of small facets, and a pixel shows the few that happen to mirror the light.
// One level of a lattice of cells; in each cell a facet catches the light with probability p and then shines 1 / p
// times as bright, so the mean over many cells is exactly 1 and the smooth highlight keeps its energy.
float skyGlintLevel(vec2 wxz, float cell, float perArea) {
  vec2 g = wxz / cell, id = floor(g);
  vec3 h = hash32(id + floor(cell * 4099.0));
  float p = min(perArea * cell * cell, 1.0);
  float lit = step(fract(h.x + uTime.x * (0.9 + 2.4 * h.y)), p);
  float spot = 1.0 - smoothstep(0.2, 0.44, length(g - id - 0.5 - (h.yz - 0.5) * 0.24));
  return mix(lit * spot * (1.0 / 0.33) / max(p, 1e-4), 1.0, smoothstep(0.3, 1.0, p));
}
float skyGlints(vec2 wxz, float pixel, float perArea) {
  float lod = log2(max(pixel * 1.7, 0.012)), l0 = floor(lod);
  return min(mix(skyGlintLevel(wxz, exp2(l0), perArea), skyGlintLevel(wxz, exp2(l0 + 1.0), perArea), lod - l0), 90.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy * uViewport.zw;
  vec3 rel = vRel; float dist = length(rel); vec3 V = -rel / dist;
  vec2 wxz = vBase + uCamPos.xz, dx = dFdx(vBase), dy = dFdy(vBase);
  float pixel = sqrt(max(abs(dx.x * dy.y - dx.y * dy.x), 1e-8));      // side of a square with the pixel's area on the water
  vec3 shore = skyShore(wxz);
  float exposure = shore.z, sandy = 1.0 - smoothstep(0.2, 0.45, shore.y);
  float seaState = uSkySea.y, quality = uSkySeaDir.z;

  // ---- surface shape
  SkyWaveField wf = skyWaves(vBase, dx, dy, exposure, shore.x);
  vec2 slope = wf.slope; float variance = wf.variance;
  // ripples below the wave table: two drifting noise layers, stronger where gusts darken the water
  vec2 windDir = uSkySeaDir.xy; float t = uSkySea.z;
  float gust = texture(uSkyNoise, (wxz - windDir * t * 3.0) * (1.0 / 320.0)).b;
  float ripple = (0.03 + 0.20 * saturate(uSkySea.x * 0.09) * smoothstep(0.25, 0.75, gust)) * mix(0.5, 1.0, exposure);
  float rippleSeen = 1.0 - smoothstep(0.02, 0.12, pixel);
  vec2 r1 = texture(uSkyNoise, wxz * 0.23 + windDir * t * 0.11).ba - 0.5, r2 = texture(uSkyNoise, wxz.yx * 0.57 - windDir.yx * t * 0.17 + 0.37).ab - 0.5;
  slope += (r1 + r2 * 0.7) * (ripple * 2.4 * rippleSeen);
  variance += ripple * ripple * (0.55 - 0.5 * rippleSeen * rippleSeen);
  vec3 breaker = skyBreaker(wxz, shore);
  if (breaker.x > 0.0) {
    vec3 sx = skyShore(wxz + vec2(5.0, 0.0)), sz = skyShore(wxz + vec2(0.0, 5.0));
    vec2 away = vec2(sx.x - shore.x, sz.x - shore.x); away /= max(length(away), 1e-3);
    slope += away * breaker.z * (1.0 - smoothstep(0.5, 3.0, pixel));
  }
  float rain = uSkyFogParams.w;
  if (rain > 0.0) {
    vec3 rings = rainRipples(wxz, pixel);
    slope += rings.xy * 1.6;
    variance += rain * (0.004 + 0.012 * smoothstep(0.012, 0.06, pixel));   // splash roughening: every drop dents the surface
  }
  vec3 N = normalize(vec3(-slope.x, max(1.0 - wf.fold, 0.2), -slope.y));
  // grazing views must not see the back of a wave: lift the normal until it faces the eye
  float facing = dot(N, V); if (facing < 0.02) N = normalize(N + V * (0.02 - facing));
  float alpha = sqrt(saturate(2.0 * variance) + 4.0e-4), rough = sqrt(alpha);

  // ---- what lies below: the sea bed through the surface
  float zWater = viewDepthOf(rel), zBed = sceneDepth(uv);
  vec3 ray = viewRay(uv);
  bool bedSeen = !isSky(zBed);
  float thickness = bedSeen ? max(zBed - zWater, 0.0) * length(ray) : 1.0e3;
  vec2 uvBed = uv;
  if (bedSeen) {
    vec3 nv = mat3(uView) * vec3(slope.x, 0.0, slope.y);
    vec2 bent = uv + nv.xy * vec2(uViewport.w * uViewport.x, 1.0) * (0.12 * min(thickness, 2.5) / max(zWater, 0.6));
    bent = clamp(bent, uViewport.zw, 1.0 - uViewport.zw);
    float zBent = sceneDepth(bent);
    // never fetch something that stands in front of the water (a pier leg, a hull)
    if (zBent > zWater && !isSky(zBent)) { uvBed = bent; zBed = zBent; ray = viewRay(bent); thickness = (zBed - zWater) * length(ray); }
  }
  float bedY = (ray * zBed).y, depth = bedSeen ? max(rel.y - bedY, 0.0) : 1.0e3;     // metres of water above the bed point
  // The bed mesh is a shallow shelf that stops offshore (34 m off a beach, 18 m off a sea wall), where the real floor
  // would go on down: let the deep water take over across the whole shelf, so that from above the turquoise grades
  // into blue instead of ending in a line. Without a coast map every bed is shown.
  float bedEnd = mix(34.0, 18.0, smoothstep(0.6, 0.9, shore.y));
  float bedShare = bedSeen ? 1.0 - step(1e-9, uSkyCoast.z) * smoothstep(0.25 * bedEnd, bedEnd + 12.0, shore.x) : 0.0;

  // ---- water body: clear turquoise shelf water on the ocean side, greener in the bay, murky in canals, deep blue offshore
  float open = smoothstep(0.12, 0.85, exposure), canal = 1.0 - smoothstep(0.04, 0.16, exposure), offshore = smoothstep(60.0, 240.0, shore.x) * open;
  vec3 absorb = mix(vec3(0.46, 0.115, 0.17), vec3(0.34, 0.058, 0.030), open); absorb = mix(absorb, vec3(0.62, 0.30, 0.44), canal);
  vec3 body = mix(vec3(0.010, 0.050, 0.042), vec3(0.008, 0.062, 0.080), open); body = mix(body, vec3(0.018, 0.040, 0.028), canal);
  body = mix(body, vec3(0.0035, 0.024, 0.062), offshore);
  // churned, silted water under a storm scatters grey: steel, not turquoise
  body = mix(body, vec3(0.022, 0.030, 0.032) * (0.5 + 0.5 * open), 0.8 * uSkyMoonLight.w);
  absorb = mix(absorb, vec3(0.40, 0.075, 0.022), offshore);
  vec3 L = uSunDir.xyz; float sunUp = max(L.y, 0.0);
  float shadow = sunShadow(rel) * skyCloudShadow(rel);
  vec3 sunE = uSunColor.rgb * shadow, skyE = PI * envDiffuse(vec3(0.0, 1.0, 0.0));
  vec3 lightIn = sunE * sunUp * 0.97 + skyE * 0.93;
  // path: down from the surface to the bed along the refracted sun, then up to the eye
  float pathIn = depth / max(sqrt(1.0 - 0.5625 * (1.0 - sunUp * sunUp)), 0.3);
  vec3 through = exp(-absorb * (thickness * 0.85 + pathIn * 0.6));
  vec3 bedColor = vec3(0.0);
  if (bedShare > 0.0) {
    bedColor = texture(uSceneOpaque, uvBed).rgb;
    // The bed was lit as if it stood in air, so facing a low sun it carries a mirror highlight that no submerged sand
    // has: hold it to what a pale bed can return diffusely (by night the lamps over the water are left alone).
    float bedLimit = 0.75 * luma(lightIn) * (1.0 / PI), bedLuma = luma(bedColor);
    bedColor *= mix(1.0, min(1.0, bedLimit / max(bedLuma, 1e-5)), saturate(luma(sunE) * 0.5));
    vec3 bedRel = ray * zBed;
    // only where a pixel is small enough to hold the lines: from a bridge they have merged into the even light they average to
    float focus = saturate(depth * 2.0) * (1.0 - smoothstep(2.0, 6.0, depth)) * smoothstep(0.04, 0.3, sunUp) * uSunDir.w * (1.0 - uSkySunLight.w) * (1.0 - smoothstep(0.04, 0.22, pixel));
    bedColor *= mix(1.0, skyCaustics(bedRel.xz + uCamPos.xz + L.xz * (depth / max(L.y, 0.3)), t), focus * 0.8 * shadow);
  }
  vec3 inScatter = body * lightIn * (1.0 / PI);
  vec3 water = mix(inScatter, bedColor * through + inScatter * (1.0 - through), bedShare);
  // light scattered forward through the thin top of a wave when the sun is behind it
  float backLit = pow(saturate(dot(V, -normalize(vec3(L.x, L.y * 0.3, L.z)))), 3.0);
  float crest = saturate(0.5 + (wf.height + vWave.z) * (1.2 / (0.15 + 1.2 * seaState))) * saturate(1.0 - N.y + 0.25);
  water += vec3(0.14, 0.36, 0.30) * body * 16.0 * sunE * (backLit * crest * 0.13 * (1.0 - canal));

  // ---- foam
  float lacePixel = 1.0 - smoothstep(0.15, 1.2, pixel);
  vec2 drift = wxz - windDir * t * 0.35;
  float capWind = smoothstep(4.5, 15.0, uSkySea.x) * mix(0.15, 1.0, open);
  float capLimit = mix(0.62, 0.20, capWind);
  float capNow = smoothstep(capLimit, capLimit + 0.16, wf.fold), capTrail = smoothstep(capLimit, capLimit + 0.16, wf.lagFold) * 0.55;
  float foam = max(capNow, capTrail) * capWind;
  // far away single caps are smaller than a pixel: keep their share as an even veil
  foam = mix(capWind * capWind * 0.10, foam, saturate(1.0 - variance * 14.0));
  foam = max(foam, breaker.y);
  // water's edge: a thin bright line where the sheet is a few centimetres deep, strings of foam behind it on sand,
  // a churning band against rock, walls, piles and hulls
  // (metres along the water from here to where the depth runs out, from the gradient of the depth across the pixel)
  vec2 depthStep = vec2(dFdx(depth), dFdy(depth));
  float jac = dx.x * dy.y - dx.y * dy.x;
  vec2 depthGrad = vec2(depthStep.x * dy.y - depthStep.y * dx.y, depthStep.y * dx.x - depthStep.x * dy.x) / (abs(jac) > 1e-9 ? jac : 1e-9);
  float run = depth / clamp(length(depthGrad), 0.06, 1.0);
  float edge = 0.0;
  if (bedSeen) {
    // sand: the froth the swash pushes ahead of itself, the lace it leaves on the sheet behind, and the thin lines
    // earlier waves left, which lie along lines of equal depth
    float line = (1.0 - smoothstep(0.05, 0.22 + pixel, run)) * mix(0.72, 1.0, 1.0 - smoothstep(0.02, 0.09, run));
    float sheet = (1.0 - smoothstep(0.2, 2.6, run)) * (0.22 + 0.28 * exposure);
    float contour = texture(uSkyNoise, vec2(depth * 2.6 + t * 0.02, 0.0) + wxz * 0.021).a;
    float strings = (1.0 - smoothstep(0.05, 0.42, depth)) * (1.0 - smoothstep(0.006, 0.02 + 0.03 * pixel, abs(contour - 0.56))) * 0.62;
    float churn = (1.0 - smoothstep(0.05, 0.28 + 0.55 * seaState, min(depth, thickness))) * (0.5 + 0.3 * sin(t * 1.7 + wxz.x * 0.4 + wxz.y * 0.3));
    edge = mix(churn, max(line, max(sheet, strings * mix(0.5, 1.0, exposure))), sandy * step(shore.x, 30.0));
  }
  foam = saturate(max(foam, edge));
  // beyond the distance where a pixel can hold the net, its mean cover
  float foamCover = foam > 0.0 ? mix(foam * foam * (3.0 - 2.0 * foam), skyLace(drift, foam), lacePixel) : 0.0;
  // a thin sheet is a single layer of bubbles with water showing between them
  foamCover *= 0.5 + 0.5 * smoothstep(0.2, 0.8, foam);
  // thick foam is white, thin lace lets the water through and reads greyer; the bubbles give it grain
  float grain = texture(uSkyNoise, drift * 0.9).g;
  vec3 foamLit = vec3(0.80, 0.85, 0.87) * (0.55 + 0.30 * foam + 0.25 * grain * lacePixel) * (sunE * (0.25 + 0.75 * saturate(dot(N, L))) * (1.0 / PI) + envDiffuse(N));

  // ---- direct highlights: sun glitter or moon path, and the lamps along the shore
  float nv = saturate(dot(N, V));
  float fresnel = 0.02 + (max(1.0 - rough, 0.02) - 0.02) * pow(1.0 - nv, 5.0);
  // what gets through a cloud deck is diffuse light, not a disc: no glitter path under an overcast
  float disc = (1.0 - uSkySunLight.w) * (1.0 - uSkySunLight.w);
  vec3 spec = sunSpecular(N, V, vec3(0.02), max(rough, 0.045)) * (shadow * disc);
  if (quality > 0.35) {
    // density of facets that mirror the light into the eye: the slope they need, against the spread of the slopes
    // the pixel cannot resolve; the light's disc sets how exact the slope has to be
    vec3 H = normalize(V + L); vec2 need = -H.xz / max(H.y, 0.05) - slope;
    float spread = max(variance, 6.0e-4), density = exp(-dot(need, need) / (2.0 * spread)) / (TAU * spread);
    spec *= mix(1.0, skyGlints(wxz, pixel, density * (5.0e-5 / 0.0016)), saturate(1.0 - foamCover * 2.0));
  }
  vec3 local = localLights(rel, N, V, body, vec3(0.02), max(rough, 0.06));

  // the reflection probe leaves lightning out (it is refreshed over many frames), so the sea mirrors the lit sky here
  vec3 flashed = vec3(0.86, 0.90, 1.0) * (fresnel * uSkyFogParams.z * 0.6 / uSunColor.w);
  vec3 radiance = mix(water * (1.0 - fresnel) + spec + local + flashed, foamLit, foamCover);
  SurfOut o;
  o.albedo = vec3(0.0); o.N = N; o.rough = 1.0; o.metal = 0.0; o.ao = 1.0; o.emissive = vec3(0.0);
  o.coat = 1.0 - 0.92 * foamCover; o.coatRough = mix(rough, 0.9, foamCover); o.wet = 1.0; o.sss = 0.0; o.alpha = 1.0;
  writeLitSurface(min(radiance, vec3(3.0e4)), o, staticVelocity(rel));
}`;
