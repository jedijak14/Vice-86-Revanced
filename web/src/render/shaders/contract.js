// The GLSL contract between surface families and the renderer.
// A family describes WHAT a surface is (albedo, normal, roughness, emission ...). The renderer decides
// how it is lit. Families never compute lighting, fog or tone mapping.
//
// A family module (src/render/families/<name>.js) exports:
//   export default {
//     name: 'ground',
//     fragment: `void surface(in SurfIn s, inout SurfOut o) { ... }`,      // required; may declare helpers above it
//     deform:   `void deform(inout vec3 p, inout vec3 n, in DeformIn d) { ... }`, // optional vertex animation (mesh-local space)
//     alphaTest: false,   // true: the renderer discards where o.alpha < 0.5 (after dithering) and uses surface() in the shadow pass
//     twoSided: false,
//   };
// Check a family without a GPU:  node tools/glslcheck.mjs src/render/families/<name>.js

/** Per-frame globals. Bound once per frame; identical in every program (std140, binding 0). */
export const FRAME_BLOCK = /* glsl */`
layout(std140) uniform Frame {
  mat4 uViewProj;        // camera-relative, jittered
  mat4 uViewProjStable;  // camera-relative, no jitter
  mat4 uPrevViewProj;    // previous frame, relative to the CURRENT camera position, no jitter
  mat4 uView;            // rotation only (camera-relative)
  mat4 uInvViewProj;     // inverse of uViewProjStable
  vec4 uCamPos;          // xyz = camera position in world metres
  vec4 uTime;            // x = seconds since start, y = frame delta, z = frame index, w = time of day in hours [0,24)
  vec4 uWeather;         // x = rain intensity 0..1, y = surface wetness 0..1, z = puddle fill 0..1, w = cloud cover 0..1
  vec4 uWind;            // xy = wind velocity on the ground plane (x, z) in m/s, z = gust 0..1, w = lightning flash 0..1
  vec4 uSwitch;          // x = street lamps 0..1, y = neon and signs 0..1, z = interior window lights 0..1, w = night factor 0..1
  vec4 uSunDir;          // xyz = unit direction TOWARDS the dominant light (sun by day, moon by night), w = 1 sun, 0 moon
  vec4 uSunColor;        // rgb = dominant light irradiance colour, w = exposure
  vec4 uViewport;        // xy = render size in pixels, zw = 1 / size
  vec4 uQuality;         // x = detail level 0..1 (families may skip micro detail below 0.5), yzw reserved
};
`;

/** What the renderer hands to surface(). */
export const SURFACE_STRUCTS = /* glsl */`
struct SurfIn {
  vec3 wpos;    // world position, metres
  vec3 lpos;    // mesh-local position (stable on moving and instanced objects; equals tile-local on statics)
  vec3 N;       // unit geometric normal, world space, already flipped to face the viewer on two-sided surfaces
  vec3 V;       // unit vector from the surface to the camera
  vec2 uv;      // vertex uv (family-defined meaning)
  vec3 color;   // vertex colour converted to linear
  float occ;    // baked occlusion 0..1 from the vertex alpha
  vec4 mat;     // [material id, p0, p1, p2] as floats 0..255 (flat-interpolated)
  vec4 objA;    // per-object parameters (see ARCHITECTURE.md "Object parameters")
  vec4 objB;
  float dist;   // distance from the camera, metres
  bool front;   // gl_FrontFacing
};
struct SurfOut {
  vec3 albedo;    // linear base colour. Default: s.color
  vec3 N;         // unit shading normal, world space. Default: s.N
  float rough;    // perceptual roughness 0..1. Default 0.7
  float metal;    // 0..1. Default 0
  float ao;       // extra occlusion 0..1. Default: s.occ
  vec3 emissive;  // emitted radiance, linear, scene units (see "Light units"). Default 0
  float coat;     // clear-coat strength 0..1: a second sharp dielectric lobe (car paint, lacquer, standing water). Default 0
  float coatRough;// roughness of the coat lobe. Default 0.04
  float wet;      // 0..1 how mirror-like and water-covered this pixel is; drives screen-space reflections. Default 0
  float sss;      // 0..1 leaf translucency (FOLIAGE). Default 0
  float alpha;    // coverage for alpha-tested families, opacity for GLASS. Default 1
};
struct DeformIn {
  vec4 mat;     // [material id, p0, p1, p2]
  vec2 uv;
  vec3 color;   // linear vertex colour
  float occ;
  vec4 objA; vec4 objB;
  vec3 origin;  // world position of the object's origin (instance position, or tile origin)
  float time;   // seconds; deform() is evaluated twice (now and previous frame) to get motion vectors
};
`;

/** Textures every surface program can sample. */
export const SURFACE_SAMPLERS = /* glsl */`
uniform sampler2D uNoiseTex;   // 256x256 RGBA8, tiling. r,g = two independent value-noise fields, b = blue noise, a = cell noise. Linear filter, mipmapped.
uniform sampler2D uAtlasTex;   // sign atlas, sRGB colour in rgb (already linearised by the sampler), a = mask / glow amount
`;

/**
 * Everything that precedes a family's code. stage: 'frag' | 'vert'.
 * The fragment stage defines VICE_FRAGMENT (derivative helpers exist only there); the vertex stage defines VICE_VERTEX.
 */
export function surfacePrelude(lib, stage = 'frag') {
  return (stage === 'frag' ? '#define VICE_FRAGMENT 1\n' : '#define VICE_VERTEX 1\n') + FRAME_BLOCK + SURFACE_STRUCTS + SURFACE_SAMPLERS + lib;
}
