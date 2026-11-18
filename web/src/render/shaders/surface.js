// Program assembly for geometry: surface family x draw kind x pass.
//
//   kinds   'static'     tile meshes; position = uOffset + vertex
//           'instanced'  prototypes; per-instance position, yaw, scale and (seed, tint, extra) from the instance buffer
//           'dynamic'    vehicles and other moving objects; uModel / uPrevModel
//   passes  'gbuffer'    calls the family's surface() and packs the G-buffer
//           'shadow'     depth only; families with alphaTest evaluate surface() here as well, for the cut-outs
//           'forward'    GLASS: surface() and then lighting, alpha blended
//           'view'       second views (road mirror, probe faces): surface() and then lighting, opaque
//   groups  a family may split its materials into groups: each group is a program of its own whose
//           surface() handles only that group's materials, and the scene draws each group's triangles
//           with it. Microsoft's HLSL compiler, which Chrome on Windows runs on every shader, takes time
//           that grows faster than the number of materials in one shader: twenty materials in one program
//           cost it half a minute, the same twenty in programs of one to three a second each.
//           A family module declares them, next to `fragment` (which stays the whole family), as
//             groups: [[id, ...], ...]              the values of material byte 0 of each group, each once
//             fragmentFor(group) -> source          surface() for groups[i]
//             groupOf(byte) -> index (optional)     for groups that are not lists of byte values
//           The group of a triangle is decided by material byte 0 of its last vertex alone.
//
// All positions are camera-relative: the CPU subtracts the camera from tile origins, instance batch origins
// and model matrices in double precision, so the GPU only ever sees small numbers.

import { surfacePrelude } from './contract.js';
import { LIB } from './lib.js';
import { HEAD, DEPTH, GBUFFER_WRITE } from '../host.js';
import { LIGHTING, SCENE_PROBE, RAIN_COVER, MAX_REFLECTED } from './common.js';

export const KINDS = Object.freeze(['static', 'instanced', 'dynamic']);

/**
 * How many tile meshes one buffer of merged tiles holds (tileclusters.js). Where tiles are merged, a
 * 'static' vertex shader takes an offset per merged mesh instead of one, and each vertex says which is its
 * own in the spare fourth component of its normal: 0 in every mesh as built, so a mesh drawn by itself
 * uses the first offset.
 */
export const TILE_SLOTS = 32;

/** Vertex attribute locations (mesh layout from core/ids.js, then the two instance attributes). */
export const ATTRIB = Object.freeze({ position: 0, normal: 1, color: 2, material: 3, uv: 4, instancePosYaw: 5, instanceParams: 6 });

// Families whose instanced draws receive the instance yaw in objB.x (objB is otherwise 0 for instances):
// plants rotate the wind into mesh axes with it, so every palm leans the same way downwind. The trunk
// (solid) and the crown (foliage) of one instance must sway identically, hence both.
const INSTANCE_YAW_FAMILIES = new Set(['foliage', 'solid']);

const VARYINGS = (dir) => /* glsl */`
${dir} vec3 vRel;        // camera-relative world position
${dir} vec3 vLocal;      // mesh-local position before deformation
${dir} vec3 vNormal;
${dir} vec2 vUv;
${dir} vec4 vColor;      // linear rgb, a = baked occlusion
flat ${dir} vec4 vMat;
flat ${dir} vec4 vObjA;
flat ${dir} vec4 vObjB;
${dir} vec3 vClipNow;    // xyw of the unjittered clip position, for motion vectors
${dir} vec3 vClipPrev;
`;

/**
 * Vertex shader. `shadow` projects with uShadowViewProj and flattens casters that lie in front of the
 * cascade's near plane onto it; `lean` drops the varyings a depth-only fragment shader never reads;
 * `tileSlots` (0 or TILE_SLOTS) makes the 'static' kind take an offset per merged tile mesh.
 */
export function surfaceVertex(family, kind, { shadow = false, lean = false, view = false, tileSlots = 0 } = {}) {
  const deform = family.deform ? family.deform : '';
  const merged = tileSlots > 0 && kind === 'static';
  const offsetUniform = merged
    ? `uniform vec3 uOffset[${tileSlots}];             // origin minus camera position of each tile mesh in the buffer drawn`
    : 'uniform vec3 uOffset;                      // tile or batch origin minus camera position';
  // The offset of a 'static' vertex: its own mesh's among the merged ones, or the only one there is.
  const pickOffset = merged ? '  vec3 tileOffset = uOffset[int(aNrm.w * 32767.0 + 0.5)];\n' : '';
  const offset = merged ? 'tileOffset' : 'uOffset';
  return HEAD + `#define KIND_${kind.toUpperCase()} 1\n${deform ? '#define HAS_DEFORM 1\n' : ''}${shadow ? '#define PASS_SHADOW 1\n' : ''}${view ? '#define PASS_VIEW 1\n' : ''}${lean ? '#define LEAN 1\n' : ''}`
    + surfacePrelude(LIB, 'vert') + '\n' + deform + /* glsl */`
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aNrm;
layout(location = 2) in vec4 aCol;
layout(location = 3) in vec4 aMat;
layout(location = 4) in vec2 aUv;
#ifdef KIND_INSTANCED
layout(location = 5) in vec4 iPosYaw;      // xyz relative to the batch origin, w = yaw
layout(location = 6) in vec4 iParams;      // scale, seed, tint, extra
uniform vec4 uLod;                         // x = lodNear, y = lodFar (metres from the camera); z, w = bias of this pass towards coarser levels
uniform vec3 uLodCentre;                   // mesh bounds centre, mesh-local
#endif
#ifdef KIND_DYNAMIC
uniform mat4 uModel;                       // model to camera-relative world
uniform mat4 uPrevModel;                   // last frame's model matrix, relative to the CURRENT camera position
uniform vec4 uObjA;
uniform vec4 uObjB;
#else
${offsetUniform}
#endif
#ifdef PASS_SHADOW
uniform mat4 uShadowViewProj;              // camera-relative world to the cascade's clip space
#endif
#ifdef PASS_VIEW
uniform mat4 uAltViewProj;                 // camera-relative world to the clip space of a second view (road mirror, probe face)
#endif
#ifndef LEAN
${VARYINGS('out')}
#endif

void main() {
  vec3 p = aPos, n = aNrm.xyz;
  vec4 objA = vec4(0.0), objB = vec4(0.0);
${pickOffset}#if defined(KIND_INSTANCED)
  float cy = cos(iPosYaw.w), sy = sin(iPosYaw.w), scale = iParams.x;
  mat3 turn = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  vec3 base = uOffset + iPosYaw.xyz;
  // Per-instance level of detail: instances outside this batch's distance band collapse to nothing.
  float lodDist = length(base + turn * (uLodCentre * scale));
  lodDist += min(lodDist * uLod.z, uLod.w);                 // shadow, probe and mirror passes change level sooner
  if (lodDist < uLod.x || lodDist >= uLod.y) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; }
  objA = vec4(iParams.y, iParams.z, iParams.w, scale);
${INSTANCE_YAW_FAMILIES.has(family.name) ? '  objB.x = iPosYaw.w;\n' : ''}  vec3 origin = base + uCamPos.xyz;
#elif defined(KIND_DYNAMIC)
  objA = uObjA; objB = uObjB;
  vec3 origin = uModel[3].xyz + uCamPos.xyz;
#else
  vec3 origin = ${offset} + uCamPos.xyz;
#endif

  vec3 pPrev = p;
#ifdef HAS_DEFORM
  DeformIn d;
  d.mat = aMat; d.uv = aUv; d.color = srgbToLinear(aCol.rgb); d.occ = aCol.a; d.objA = objA; d.objB = objB; d.origin = origin;
  vec3 nPrev = n;
  d.time = uTime.x - uTime.y; deform(pPrev, nPrev, d);
  d.time = uTime.x; deform(p, n, d);
#endif

#if defined(KIND_INSTANCED)
  vec3 rel = base + turn * (p * scale), relPrev = base + turn * (pPrev * scale);
  vec3 normal = turn * n;
#elif defined(KIND_DYNAMIC)
  vec3 rel = (uModel * vec4(p, 1.0)).xyz, relPrev = (uPrevModel * vec4(pPrev, 1.0)).xyz;
  vec3 normal = mat3(uModel) * n;
#else
  vec3 rel = ${offset} + p, relPrev = ${offset} + pPrev;
  vec3 normal = n;
#endif

#ifdef PASS_SHADOW
  gl_Position = uShadowViewProj * vec4(rel, 1.0);
  gl_Position.z = max(gl_Position.z, -0.9995);
#elif defined(PASS_VIEW)
  gl_Position = uAltViewProj * vec4(rel, 1.0);
#else
  gl_Position = uViewProj * vec4(rel, 1.0);
#endif
#ifndef LEAN
  vRel = rel; vLocal = aPos; vNormal = normal; vUv = aUv;
  vColor = vec4(srgbToLinear(aCol.rgb), aCol.a);
  vMat = aMat; vObjA = objA; vObjB = objB;
  vClipNow = (uViewProjStable * vec4(rel, 1.0)).xyw;
  vClipPrev = (uPrevViewProj * vec4(relPrev, 1.0)).xyw;
#endif
}`;
}

// Builds SurfIn and the default SurfOut from the varyings, then calls the family.
// A second view (view = true: the road mirror, a face of the reflection probe) looks from its own eye,
// and a mirror image has its winding, and with it the meaning of gl_FrontFacing, reversed.
const CALL_SURFACE = (family, view = false) => /* glsl */`
${view ? `uniform vec4 uAltEye;     // xyz = eye of this view relative to the camera, w = 1 for a mirror image
uniform vec4 uAltClip;    // x = camera-relative height below which nothing is drawn, y = 1: alpha receives 1 / distance from the eye` : ''}
void runSurface(out SurfIn s, out SurfOut o) {
  s.wpos = vRel + uCamPos.xyz; s.lpos = vLocal;
  s.N = normalize(vNormal);
  bool front = ${view ? '(uAltEye.w > 0.5) != gl_FrontFacing' : 'gl_FrontFacing'};
  ${family.twoSided ? 'if (!front) s.N = -s.N;' : ''}
  vec3 toEye = ${view ? 'uAltEye.xyz - vRel' : '-vRel'};
  s.dist = length(toEye); s.V = toEye / max(s.dist, 1e-5);
  s.uv = vUv; s.color = vColor.rgb; s.occ = vColor.a; s.mat = vMat; s.objA = vObjA; s.objB = vObjB; s.front = front;
  o.albedo = s.color; o.N = s.N; o.rough = 0.7; o.metal = 0.0; o.ao = s.occ; o.emissive = vec3(0.0);
  o.coat = 0.0; o.coatRough = 0.04; o.wet = 0.0; o.sss = 0.0; o.alpha = 1.0;
  surface(s, o);
}
// Alpha test threshold. Under temporal AA the threshold is dithered (uQuality.y = amplitude, uQuality.z =
// noise phase) so that cut-out edges resolve to soft coverage instead of crawling.
bool cutOut(float alpha) {
  float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy + uQuality.z * 5.588238, vec2(0.06711056, 0.00583715))));
  return alpha < 0.5 + (n - 0.5) * uQuality.y;
}
`;

// Detail that the pixel grid cannot show must not reach the lighting pass. Where the shading normal changes
// faster than once per pixel (road aggregate seen at a grazing angle, distant corrugated roofs), one normal
// per pixel turns a headlamp's reflection into salt-and-pepper noise several stops too bright, because every
// pixel is lit as if the whole of it faced the lamp. Two corrections, both from screen-space derivatives:
//  - the family's detail (shading normal minus the interpolated one) is faded out as it passes the pixel
//    frequency, the way a mip chain would average a normal map back to the surface normal;
//  - the spread of normals inside the pixel is folded into the roughness (after Tokuyoshi and Kaplanyan,
//    "Improved Geometric Specular Antialiasing"), so the highlight gets wider and dimmer instead of sparkling.
const SPECULAR_AA = /* glsl */`
void antialiasSpecular(inout SurfOut o, vec3 smoothN) {
  vec3 N = normalize(o.N), dx = dFdx(N), dy = dFdy(N);
  float kernel = min(0.5 * (dot(dx, dx) + dot(dy, dy)), 0.18);      // variance of the lobe, capped
  float a = o.rough * o.rough, c = o.coatRough * o.coatRough;         // GGX width is roughness squared
  o.rough = sqrt(sqrt(min(a * a + kernel, 1.0)));
  o.coatRough = sqrt(sqrt(min(c * c + kernel, 1.0)));
  // The detail is unresolved where it changes by about its own size from one pixel to the next. Measured
  // relative to its size, because under a lamp two degrees above the road a tilt of three degrees is already
  // the difference between lit and black.
  vec3 detail = N - smoothN, ddx = dFdx(detail), ddy = dFdy(detail);
  float change = (dot(ddx, ddx) + dot(ddy, ddy)) / max(dot(detail, detail), 1e-5);
  o.N = normalize(mix(N, smoothN, smoothstep(0.25, 2.0, change)));
}
`;

/**
 * In place of a group number: every material of the family in one program, as the family module wrote it.
 * What a family that is split is drawn with where such a program can be had cheaply (surfaceprograms.js).
 */
export const WHOLE_FAMILY = -1;

const materialsOf = (family, group) => (group === WHOLE_FAMILY ? family.fragment : family.groupFragments[group]);

export function gbufferFragment(family, group = 0) {
  return HEAD + surfacePrelude(LIB, 'frag') + RAIN_COVER + materialsOf(family, group) + '\n' + VARYINGS('in') + GBUFFER_WRITE + CALL_SURFACE(family) + SPECULAR_AA + /* glsl */`
void main() {
  SurfIn s; SurfOut o;
  runSurface(s, o);
  ${family.alphaTest ? 'if (cutOut(o.alpha)) discard;' : ''}
  antialiasSpecular(o, s.N);
  vec2 velocity = (vClipNow.xy / vClipNow.z - vClipPrev.xy / vClipPrev.z) * 0.5;
  writeGBuffer(o, velocity);
}`;
}

/** Shadow pass fragment shader: empty for opaque families, surface() and the alpha test for cut-out ones. */
export function shadowFragment(family, group = 0) {
  if (!family.alphaTest) return HEAD + 'void main() {}';
  return HEAD + surfacePrelude(LIB, 'frag') + RAIN_COVER + materialsOf(family, group) + '\n' + VARYINGS('in') + CALL_SURFACE(family) + /* glsl */`
void main() {
  SurfIn s; SurfOut o;
  runSurface(s, o);
  if (o.alpha < 0.5) discard;
}`;
}

/** Forward pass for GLASS: the family describes the pane, this lights it. skyGlsl: the sky module's chunk. */
export function forwardFragment(family, skyGlsl, group = 0) {
  return HEAD + surfacePrelude(LIB, 'frag') + DEPTH + skyGlsl + LIGHTING + SCENE_PROBE + RAIN_COVER + materialsOf(family, group) + '\n' + VARYINGS('in') + CALL_SURFACE(family) + /* glsl */`
layout(location = 0) out vec4 outColor;
void main() {
  SurfIn s; SurfOut o;
  runSurface(s, o);
  vec3 N = normalize(o.N), V = s.V;
  float alpha = saturate(o.alpha), NoV = abs(dot(N, V)) + 1e-4;
  LitSurface ls;
  ls.N = N; ls.V = V;
  // The tint film scatters light in proportion to its opacity; the reflection off the surface does not care how clear the pane is.
  ls.diffuse = o.albedo * (1.0 - o.metal) * alpha;
  ls.f0 = litBaseF0(o.albedo, o.metal, o.coat); ls.alpha = litAlpha(o.rough);
  ls.coat = o.coat; ls.coatAlpha = litAlpha(o.coatRough); ls.coatF0 = 0.04; ls.lacquer = o.coat; ls.sss = 0.0;

  float shadow = litSunShadow(vRel, N);
#ifdef SKY_CLOUD_SHADOW
  shadow *= skyCloudShadow(vRel);
#endif
  // Lamps as in the main image: baked occlusion stands in for the shadows they do not cast, and leaves
  // keep their ceiling, or every palm crown beside a street light would be a lantern in the reflection.
  vec3 colour = litKey(vRel, ls, shadow) + litLocal(vRel, ls) * mix(1.0, o.ao, 0.85);
  colour += ls.diffuse * (envDiffuse(N) + uAmbientBoost.rgb) * (o.ao * (1.0 - litFresnel1(ls.coatF0, NoV) * ls.coat));
  vec3 envBrdf = litEnvBrdf(ls.f0, o.rough, NoV);
  colour += sceneSpecular(vRel, reflect(-V, N), o.rough) * envBrdf * litSpecularOcclusion(NoV, o.ao, o.rough);
  colour += o.emissive;

  // Reflections make glass opaque at grazing angles: opacity rises with Fresnel.
  float opacity = mix(alpha, 1.0, saturate(envBrdf.g));
  vec4 fog = skyFog(vRel);
  outColor = vec4(colour * fog.a + fog.rgb * opacity, opacity);
}`;
}

/**
 * A second view of the scene, lit in one go: the wet-road mirror and the faces of the reflection probe.
 * The family describes the surface and this lights it forward, because a second G-buffer for a small
 * image that is then blurred would cost more than it gives. Sun with the cheap shadow lookup, lamps from
 * the grid, ambient from the sky, specular from the probe as it stood last frame (so mirrors in mirrors
 * converge over a few frames), emissive, fog. Alpha is coverage for the mirror (its target is cleared to 0)
 * and one over the distance from the eye in metres for the probe (0 = sky), which sceneAim reads.
 */
export function viewFragment(family, skyGlsl, group = 0) {
  return HEAD + surfacePrelude(LIB, 'frag') + DEPTH + skyGlsl + LIGHTING + SCENE_PROBE + RAIN_COVER + materialsOf(family, group) + '\n' + VARYINGS('in') + CALL_SURFACE(family, true) + /* glsl */`
layout(location = 0) out vec4 outColor;
void main() {
  // Nothing below a mirror can be seen in it, and the road itself (and the paint lifted a hair above
  // it) must not hide what it reflects. WebGL2 has no clip planes, hence the discard.
  if (vRel.y < uAltClip.x) discard;
  SurfIn s; SurfOut o;
  runSurface(s, o);
  ${family.alphaTest ? 'if (o.alpha < 0.5) discard;' : ''}
  vec3 N = normalize(o.N), V = s.V;
  float NoV = abs(dot(N, V)) + 1e-4;
  LitSurface ls;
  ls.N = N; ls.V = V;
  ls.diffuse = o.albedo * (1.0 - o.metal);
  ls.coat = max(o.coat, o.wet); ls.coatAlpha = litAlpha(o.coatRough); ls.coatF0 = 0.04; ls.lacquer = o.coat; ls.sss = o.sss;
  ls.f0 = litBaseF0(o.albedo, o.metal, ls.coat); ls.alpha = litAlpha(o.rough);
  float shadow = litSunShadowCheap(vRel);
#ifdef SKY_CLOUD_SHADOW
  shadow *= skyCloudShadow(vRel);
#endif
  vec3 R = reflect(-V, N);
  float Fc = litCoatMirror(ls.coatF0, NoV, o.coat) * ls.coat;
  // Lamps as in the main image: baked occlusion stands in for the shadows they do not cast, and leaves
  // keep their ceiling, or every palm crown beside a street light would be a lantern in the reflection.
  vec3 colour = litKey(vRel, ls, shadow) + litLocal(vRel, ls) * mix(1.0, o.ao, 0.85);
  colour += ls.diffuse * (envDiffuse(N) + uAmbientBoost.rgb) * (o.ao * (1.0 - Fc));
  vec3 aim = sceneAim(vRel, R);
  vec3 specular = sceneRadiance(sceneAimFor(aim, vRel, R, o.rough), o.rough) * litEnvBrdf(ls.f0, o.rough, NoV) * litSpecularOcclusion(NoV, o.ao, o.rough);
  colour += mix(specular, sceneRadiance(sceneAimFor(aim, vRel, R, o.coatRough), o.coatRough), Fc);
  colour += o.emissive;
  // Clamped like the traced reflections, so that one lamp filament cannot become a firefly in the mips.
  vec4 fog = skyFog(vRel);
  outColor = vec4(min(colour * fog.a + fog.rgb, vec3(${MAX_REFLECTED})), uAltClip.y > 0.5 ? 1.0 / max(distance(vRel, uAltEye.xyz), 0.25) : 1.0);
}`;
}

/**
 * The most material groups one family may declare: a mesh keeps the groups it holds as bits of one integer,
 * and the loops over them stop when no higher bit is left, which a 32-bit shift cannot tell for bit 31.
 */
export const MAX_GROUPS = 31;

const HAS_SURFACE = /void\s+surface\s*\(/;

/**
 * The material groups a family module declares, or null when it declares none: { fragments, of, labels },
 * the fragment source of each group, the group of each value of material byte 0, and a short name per group.
 * A family names its groups in one of two ways: groups[i] is the list of the byte values of
 * group i, or groups[i] is the family's own business and groupOf(byte) gives the group. A byte that no group
 * claims goes to the last one. A declaration that cannot be used is reported and the family drawn as one
 * program: correct, and as slow to compile as it was.
 */
function declaredGroups(candidate, name) {
  const groups = candidate.groups;
  if (!Array.isArray(groups) || groups.length < 2) return null;
  const refuse = (why) => { console.warn(`Renderer: the material groups of the "${name}" family cannot be used (${why}); it is drawn as one program.`); return null; };
  if (groups.length > MAX_GROUPS) return refuse(`more than ${MAX_GROUPS} groups`);
  if (typeof candidate.fragmentFor !== 'function') return refuse('no fragmentFor()');
  const of = new Uint8Array(256).fill(groups.length - 1);
  let labels;
  if (typeof candidate.groupOf === 'function') {
    for (let byte = 0; byte < 256; byte++) { const group = candidate.groupOf(byte); if (Number.isInteger(group) && group >= 0 && group < groups.length) of[byte] = group; }
    labels = groups.map((group, i) => 'g' + i);
  } else {
    const seen = new Set();
    for (let group = 0; group < groups.length; group++) {
      const ids = groups[group];
      if (!Array.isArray(ids) || !ids.length) return refuse(`group ${group} is not a list of material ids`);
      for (const id of ids) {
        if (!Number.isInteger(id) || id < 0 || id > 255 || seen.has(id)) return refuse(`material id ${id} of group ${group} is not a byte or is listed twice`);
        seen.add(id); of[id] = group;
      }
    }
    // Named by its ids when they are few (solid/static/gbuffer/m6+17), so a log line says which materials a program holds.
    labels = groups.map((ids, i) => (ids.length <= 4 ? 'm' + ids.join('+') : 'g' + i));
  }
  const fragments = groups.map((group) => candidate.fragmentFor(group));
  if (!fragments.every((source) => typeof source === 'string' && HAS_SURFACE.test(source))) return refuse('fragmentFor() did not return a surface() for every group');
  return { fragments, of, labels };
}

/**
 * Whether a family's materials have to be split into their groups on this device. Only Direct3D needs it:
 * its shader compiler takes minutes over a whole family and the browser gives up on the graphics process
 * meanwhile, while every other backend compiles the whole family in a moment and would only pay for the
 * split with one draw call per group instead of one per family.
 * renderer: the driver's name as the browser tells it, '' when it hides it; then Windows is taken for Direct3D.
 */
export function needsMaterialGroups(renderer, userAgent) {
  if (/Direct3D|D3D11|D3D9/i.test(renderer)) return true;
  return renderer === '' && /Windows/i.test(userAgent);
}

/**
 * Normalise a family module's default export; null when it does not satisfy the contract.
 * split: false makes the family one group whatever it declares (needsMaterialGroups).
 * The result carries, besides the contract's fields: groupFragments (the fragment source of each material
 * group; one entry, the whole family, when it declares none), groupOf (material byte 0 -> group) and
 * groupLabels (a short name per group, null for a family that is one group).
 */
export function normaliseFamily(candidate, name, split = true) {
  if (!candidate || typeof candidate.fragment !== 'string' || !HAS_SURFACE.test(candidate.fragment)) return null;
  const declared = split ? declaredGroups(candidate, name) : null;
  return {
    name: candidate.name || name, fragment: candidate.fragment, deform: typeof candidate.deform === 'string' && candidate.deform.trim() ? candidate.deform : '',
    alphaTest: !!candidate.alphaTest, twoSided: !!candidate.twoSided,
    groupFragments: declared ? declared.fragments : [candidate.fragment], groupOf: declared ? declared.of : new Uint8Array(256), groupLabels: declared ? declared.labels : null,
  };
}

/** The passes a family is drawn in: glass is blended (`forward`), every other family goes through the G-buffer. */
export const familyPasses = (forward) => (forward ? ['view', 'forward'] : ['view', 'gbuffer', 'shadow']);

/**
 * Sources of one program: a family's material group (or WHOLE_FAMILY), for one draw kind and pass.
 * Returns { key, kind, pass, group, vertex, fragment }; the key ends in the group's name when the family
 * has groups, in "all" for the whole of such a family. tileSlots: see surfaceVertex.
 */
export function surfaceSource(family, kind, pass, group, skyGlsl = '', tileSlots = 0) {
  const key = `${family.name}/${kind}/${pass}` + (family.groupLabels ? '/' + (group === WHOLE_FAMILY ? 'all' : family.groupLabels[group]) : '');
  if (pass === 'view') return { key, kind, pass, group, vertex: surfaceVertex(family, kind, { view: true, tileSlots }), fragment: viewFragment(family, skyGlsl, group) };
  if (pass === 'forward') return { key, kind, pass, group, vertex: surfaceVertex(family, kind, { tileSlots }), fragment: forwardFragment(family, skyGlsl, group) };
  if (pass === 'gbuffer') return { key, kind, pass, group, vertex: surfaceVertex(family, kind, { tileSlots }), fragment: gbufferFragment(family, group) };
  return { key, kind, pass, group, vertex: surfaceVertex(family, kind, { shadow: true, lean: !family.alphaTest, tileSlots }), fragment: shadowFragment(family, group) };
}

/**
 * Sources of every program one family can need: every group x draw kind x pass. The renderer builds only
 * those its geometry asks for (surfaceprograms.js); this list is for the offline shader checks.
 * `forward` selects the glass set instead of the deferred one; every family has `view` programs for second
 * views (road mirror, probe faces), glass included (drawn there as an opaque pane). tileSlots: see surfaceVertex.
 */
export function familyPrograms(family, { forward = false, skyGlsl = '', tileSlots = 0 } = {}) {
  const out = [];
  for (let group = 0; group < family.groupFragments.length; group++) {
    for (const kind of KINDS) for (const pass of familyPasses(forward)) out.push(surfaceSource(family, kind, pass, group, skyGlsl, tileSlots));
  }
  return out;
}
