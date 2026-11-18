// Rain streaks, ground splashes and the lightning bolt: the `particles` stage (premultiplied alpha, depth test on,
// depth write off). Sources are BODIES; index.js prepends the host head, the Frame block, lib.js and the chunks.

/** The box of air around the camera that holds the streaks, metres. Fall speeds are whole multiples of RAIN_BOX.y / RAIN_PERIOD. */
export const RAIN_BOX = Object.freeze([26, 16, 26]);
/** Seconds after which the fall clock wraps: every fall speed below travels a whole number of boxes in this time. */
export const RAIN_PERIOD = 16;
/** Share of the 10 m wind a falling drop has near the ground: keeps a storm's rain leaning about 30 degrees, not lying flat. */
export const RAIN_WIND_SHARE = 0.4;

const RAIN_SHADE = /* glsl */`
// Light a raindrop sends to the eye: it is a lens, so it shows the bright sky and lamps behind and around it.
vec3 skyRainLight(vec3 rel, vec3 V, vec3 N) {
  vec3 L = uSunDir.xyz;
  vec3 c = envDiffuse(vec3(0.0, 1.0, 0.0)) * 0.55 + envSpecular(-V, 0.6) * 0.45;
  c += uSunColor.rgb * (0.02 + 0.35 * pow(saturate(dot(-V, L)), 6.0)) * (1.0 - uSkySunLight.w);
  c += localLights(rel, N, V, vec3(0.9), vec3(0.0), 1.0);
  // lightning: in exposed units, as the renderer sets its flash on the ground
  return c + vec3(0.86, 0.90, 1.0) * (uSkyFogParams.z * 1.6 / uSunColor.w);
}
`;

export const RAIN_VS = /* glsl */`
uniform vec4 uRainShift;     // xyz = (wind drift - camera position) wrapped to the box, w = fall clock (s, wrapped to the period)
uniform vec4 uRainMotion;    // xyz = camera velocity (m/s), w = exposure time of a streak (s)
uniform vec4 uRainCentre;    // xyz = centre of the box relative to the camera, w = vertical field of view (radians)
out vec3 vRel; out vec2 vQuad; out float vFade;
void main() {
  const vec3 BOX = vec3(${RAIN_BOX.map((x) => x.toFixed(1)).join(', ')});
  int id = gl_VertexID / 6, corner = gl_VertexID - id * 6;
  vec2 q = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
  uint h = hashU(uint(id)), g = hashU(h);
  vec3 seed = vec3(float(h & 0x7ffu), float((h >> 11u) & 0x7ffu), float(h >> 22u)) * vec3(1.0 / 2047.0, 1.0 / 2047.0, 1.0 / 1023.0);
  float speed = (7.0 + float(g & 3u)) * (BOX.y / ${RAIN_PERIOD.toFixed(1)});   // 7 to 10 box heights per period, so the wrapped clock is seamless
  vec3 p = seed * BOX + uRainShift.xyz - vec3(0.0, speed * uRainShift.w, 0.0);
  vec3 head = mod(p - uRainCentre.xyz + 0.5 * BOX, BOX) - 0.5 * BOX + uRainCentre.xyz;
  // the streak is the path of the drop across the shutter, seen from the moving camera: this is what makes rain lean
  vec3 travel = (vec3(uWind.x * ${RAIN_WIND_SHARE}, -speed, uWind.y * ${RAIN_WIND_SHARE}) - uRainMotion.xyz) * uRainMotion.w;
  float len = length(travel); travel *= min(len, 3.0) / max(len, 1e-4);
  vec3 tail = head - travel, mid = head - 0.5 * travel;
  float dist = length(mid);
  vec3 side = normalize(cross(travel, mid) + vec3(1e-6, 0.0, 0.0));
  // never thinner than a pixel: widen instead and let the opacity carry the difference
  float pixel = dist * 2.0 * tan(0.5 * uRainCentre.w) * uViewport.w, width = max(0.0022, 0.75 * pixel);
  vec3 rel = mix(tail, head, q.y) + side * ((q.x - 0.5) * 2.0 * width);
  vec3 edge = 1.0 - smoothstep(0.38, 0.5, abs(head - uRainCentre.xyz) / BOX);
  vFade = edge.x * edge.y * edge.z * smoothstep(0.6, 2.2, dist) * (0.0022 / width) * (0.6 + 0.4 * float((g >> 2u) & 255u) * (1.0 / 255.0));
#ifdef HOST_RAIN_COVER
  vFade *= rainCover(head);
#endif
  vRel = rel; vQuad = q;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

export const RAIN_FS = RAIN_SHADE + /* glsl */`
in vec3 vRel; in vec2 vQuad; in float vFade;
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy * uViewport.zw;
  float z = viewDepthOf(vRel), behind = sceneDepth(uv) - z;
  float across = 1.0 - abs(vQuad.x * 2.0 - 1.0), along = smoothstep(0.0, 0.4, vQuad.y) * (1.0 - smoothstep(0.6, 1.0, vQuad.y));
  // Rain is a veil of many faint lines, not a few bright ones: no single streak is ever more than a third opaque,
  // and the nearest ones (a drop is under a pixel wide beyond a few metres) taper to nothing at both ends.
  float a = min(vFade * across * 26.0, 0.34) * along * smoothstep(0.0, 0.25, behind);
  if (a <= 0.002) discard;
  vec3 V = -normalize(vRel);
  vec4 fog = skyFog(vRel);
  // mostly added light, a little cover: a streak brightens what is behind it more than it hides it
  outColor = vec4(skyRainLight(vRel, V, V) * (a * 0.5 * fog.a) + fog.rgb * (a * 0.25), a * 0.25);
}`;

/** Splashes where drops hit: placed on whatever surface the depth buffer shows at a point of the ground grid. */
export const SPLASH_VS = /* glsl */`
uniform vec4 uSplash;        // x = cells per side, y = cell size (m), z = ground level the grid lies on (m), w = share of cells active 0..1
uniform sampler2D uGBuffer1;
out vec3 vRel; out vec2 vQuad; out float vLife; out float vNear;
vec3 skyOctDecode(vec2 e) {
  vec3 n = vec3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y); float t = max(-n.y, 0.0);
  n.x += n.x >= 0.0 ? -t : t; n.z += n.z >= 0.0 ? -t : t;
  return normalize(n);
}
void main() {
  int id = gl_VertexID / 6, corner = gl_VertexID - id * 6, side = int(uSplash.x);
  vec2 q = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
  vec2 cell = floor(uCamPos.xz / uSplash.y) + vec2(float(id - (id / side) * side), float(id / side)) - 0.5 * uSplash.x;
  float h = hash12(cell), t = uTime.x * (2.6 + 1.2 * h) + h * 9.0, cycle = floor(t), life = (t - cycle) * 1.6;
  vec3 r = hash32(cell + cycle * 17.0);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);            // outside the clip volume unless this drop is alive and lands on something
  vLife = life; vQuad = q; vRel = vec3(0.0); vNear = 0.0;
  if (life >= 1.0 || r.z > uSplash.w) return;
  vec3 ground = vec3((cell.x + r.x) * uSplash.y, uSplash.z, (cell.y + r.y) * uSplash.y) - uCamPos.xyz;
  vec4 clip = uViewProjStable * vec4(ground, 1.0);
  if (clip.w <= 0.3) return;
  vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return;
  ivec2 px = ivec2(uv * uViewport.xy);
  float z = texelFetch(uSceneDepth, px, 0).r;
  if (isSky(z)) return;
  vec3 hit = viewRay(uv) * z; float dist = length(hit);
  // only on surfaces that face the sky and are near enough to matter
  vec4 surface = texelFetch(uGBuffer1, px, 0);       // xy = normal, zw = how far the surface moved on screen this frame
  if (dist > 24.0 || skyOctDecode(surface.xy).y < 0.6) return;
  // ...and that stand still. The grid is fixed to the ground: on the bonnet of a moving car each frame would put the
  // splash on another spot, and the accumulated picture would show a crust of dots sliding over the paint. A surface
  // stands still when it moves on screen as a point fixed in the world would; what is left over is its slide across
  // the view (m/s), judged against the splash's own width over its life, with an allowance for the precision of
  // both vectors when the ground itself races past.
  vec4 now = uViewProjStable * vec4(hit, 1.0), was = uPrevViewProj * vec4(hit, 1.0);
  float held = 1.0;
  if (was.w > 0.05) {
    vec2 still = (now.xy / now.w - was.xy / was.w) * 0.5;
    float perSecond = z / max(uTime.y, 1.0e-3);
    float slide = length(viewRay(uv + surface.zw - still) - viewRay(uv)) * perSecond;
    float flow = length(viewRay(uv + still) - viewRay(uv)) * perSecond;
    held = 1.0 - smoothstep(0.3, 1.5, slide - 0.03 * flow);
    if (held <= 0.0) return;
  }
#ifdef HOST_RAIN_COVER
  if (rainCover(hit) < 0.5) return;
#endif
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), -hit)), toEye = -hit / dist;
  // true size: a splash too far away to cover a few pixels fades out instead of being blown up into a blob
  float size = (0.02 + 0.022 * r.y) * (0.6 + 0.8 * life);
  vNear = (1.0 - smoothstep(10.0, 24.0, dist)) * held;
  vec3 rel = hit + right * ((q.x - 0.5) * 2.4 * size) + vec3(0.0, q.y * 1.5 * size, 0.0) + toEye * 0.03;
  vRel = rel;
  gl_Position = uViewProj * vec4(rel, 1.0);
}`;

export const SPLASH_FS = RAIN_SHADE + /* glsl */`
in vec3 vRel; in vec2 vQuad; in float vLife; in float vNear;
out vec4 outColor;
void main() {
  // Seen from the side a splash is a shallow bowl of spray: a crown thrown outwards that rises and thins, a short jet
  // in the middle, mist between them. Every part is a round falloff inside a round window: a splash is a few pixels
  // across, and anything separable or with an edge reads as a square or a pair of dots.
  float x = abs(vQuad.x * 2.0 - 1.0), y = vQuad.y, reach = 0.18 + 0.42 * vLife, rise = 0.25 + 0.4 * vLife;
  vec2 c = vec2(x / 0.9, (y - 0.3) / 0.6);
  float window = 1.0 - smoothstep(0.35, 1.0, dot(c, c));
  float crown = exp(-pow((x - reach) / 0.15, 2.0) - pow((y - 0.3 * rise) / 0.13, 2.0));
  float mist = exp(-pow(x / (reach + 0.1), 2.0) - pow(y / (0.45 * rise), 2.0)) * 0.6;
  float jet = exp(-pow(x / 0.1, 2.0) - pow((y - 0.2) / (0.12 + 0.3 * vLife), 2.0)) * (1.0 - vLife);
  // (it takes a few frames to rise: the picture is accumulated over time, and a one-frame flash would never show)
  float a = (crown * 0.6 + mist + jet * 0.5) * window * smoothstep(0.0, 0.12, vLife) * (1.0 - vLife * vLife) * vNear;
  if (a <= 0.004) discard;
  vec4 fog = skyFog(vRel);
  // spray scatters whatever light falls on it from above, and hides little of what is behind
  vec3 V = -normalize(vRel);
  outColor = vec4(skyRainLight(vRel, V, normalize(V + vec3(0.0, 1.5, 0.0))) * (min(a * 1.5, 1.0) * fog.a) + fog.rgb * (a * 0.12), a * 0.12);
}`;

/** The bolt: one instanced ribbon per segment (lightning.js buildBolt). */
export const BOLT_VS = /* glsl */`
layout(location = 0) in vec4 aStart;   // xyz world metres, w = brightness
layout(location = 1) in vec4 aEnd;
out vec2 vQuad; out float vBright; out vec3 vRel;
void main() {
  int corner = gl_VertexID;
  vec2 q = vec2(corner == 1 || corner == 2 || corner == 4 ? 1.0 : 0.0, corner == 2 || corner == 4 || corner == 5 ? 1.0 : 0.0);
  vec3 a = aStart.xyz - uCamPos.xyz, b = aEnd.xyz - uCamPos.xyz, p = mix(a, b, q.y);
  float bright = mix(aStart.w, aEnd.w, q.y), dist = length(p);
  vec3 side = normalize(cross(b - a, p));
  // the glowing channel is metres wide once bloom is counted; keep it a few pixels wide however far away
  float width = max(1.4 + 2.6 * bright, dist * 0.0022);
  vRel = p + side * ((q.x - 0.5) * 2.0 * width);
  vQuad = q; vBright = bright;
  gl_Position = uViewProj * vec4(vRel, 1.0);
}`;

export const BOLT_FS = /* glsl */`
in vec2 vQuad; in float vBright; in vec3 vRel;
out vec4 outColor;
void main() {
  float x = abs(vQuad.x * 2.0 - 1.0);
  float core = exp(-x * x * 90.0), halo = exp(-x * 5.5) * 0.06;
  float fog = skyFog(vRel).a;
  // added light only (alpha 0): it is far brighter than anything it covers
  outColor = vec4(vec3(0.70, 0.80, 1.0) * ((core + halo) * vBright * uSkyFogParams.z * 9000.0 * fog), 0.0);
}`;
