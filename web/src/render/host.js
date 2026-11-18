// Host interface: what the renderer offers to modules that draw inside its frame (sky dome, environment
// probe, ocean, rain, lightning live in src/render/sky/ and are written against this file only).
//
// ----------------------------------------------------------------------------------------------------
// 1. How the sky module plugs in
// ----------------------------------------------------------------------------------------------------
// The renderer imports `src/render/sky/index.js` itself while booting and calls
//
//     export async function createSky(host) -> {
//       glsl: string,          // GLSL chunk included by the renderer's own shaders, see section 4
//       dispose?(): void,
//       ...anything else       // the whole object is exposed to the game as `renderer.sky`
//     }
//
// If the module is missing or throws, a built-in fallback (src/render/fallback.js) takes its place, so
// the renderer always boots. The game never has to wire the sky; it only passes `frame.env`.
//
// ----------------------------------------------------------------------------------------------------
// 2. The host object
// ----------------------------------------------------------------------------------------------------
//   host.gl                      WebGL2RenderingContext
//   host.caps                    { vendor, renderer, maxTextureSize, maxDrawBuffers, floatLinear, timerQuery, tierHint }
//   host.glsl                    the GLSL chunks exported below (HEAD, FULLSCREEN_VS, FULLSCREEN_VS_FAR, FRAME_BLOCK,
//                                DEPTH, GBUFFER_WRITE, GBUFFER_READ, SURFACE_WRITE_LIT, LIGHTING, SCENE_PROBE, RAIN_COVER)
//   host.createProgram(name, vertexSource, fragmentSource) -> Program
//        Complete sources including `#version 300 es` (use host.glsl.HEAD). The program is compiled
//        asynchronously where KHR_parallel_shader_compile exists, is part of renderer warm-up and is
//        rebuilt after a context restore. Uniform blocks are bound by name: `Frame` to binding 0, `Sky` to
//        binding 1, `Lighting` to binding 2. Errors are thrown as readable Errors naming the program, with
//        the offending source lines.
//          program.use()          useProgram, and binds every SHARED TEXTURE (section 3) the program
//                                 declares to a texture unit fixed at link time. Call it before each draw batch.
//                                 Returns false while the program is still compiling: skip the draw.
//          program.loc(name)      cached WebGLUniformLocation, or null
//          program.ready          false while still compiling (warm-up waits for it)
//          program.handle         the WebGLProgram (valid after ready)
//   host.drawFullscreen()        draws one triangle covering the viewport; pair with FULLSCREEN_VS (gives `vUv`).
//                                Leaves no vertex array bound.
//   host.shareTexture(name, target, texture)
//        Publishes a texture under a sampler name (e.g. 'uEnvMap', gl.TEXTURE_CUBE_MAP, tex). From then on
//        every program made by host.createProgram that declares a sampler of that name gets it bound by
//        program.use(), the renderer's lighting and reflection shaders included. Call again to replace.
//   host.registerPass(stage, fn) -> unregister()
//        fn(ctx) runs every frame at `stage` (section 5).
//   host.targets                 live object, textures change on resize or quality change, never cache them:
//        { width, height,        render resolution in pixels (after resolution scale and dynamic resolution)
//          lit,                  RGBA16F, linear scene-referred radiance (the HDR image being built)
//          depth,                DEPTH_COMPONENT24, hardware depth, standard [0,1] range, 1 = far plane
//          sceneDepth,           R32F, view-space depth in metres (see DEPTH chunk); NEAREST only
//          sceneColor,           RGBA16F, LAST frame's finished HDR image (after reflections, fog, glass and
//                                particles; before bloom and tone mapping). LINEAR. Its size may differ from
//                                width x height: always sample it with normalised uv.
//          sceneOpaque,          RGBA16F, THIS frame's lit opaque scene before water (refraction source)
//          gbuffer: [t0..t3] }   see GBUFFER_READ
//   host.onRestore(fn)           fn() after a lost context has been restored: recreate your textures and buffers,
//                                call shareTexture again. Programs from host.createProgram are rebuilt for you.
//   host.SKY_BLOCK_BINDING = 1   uniform buffer binding point reserved for the sky module. Declare
//                                `layout(std140) uniform Sky { ... };` inside your chunk, create the buffer yourself,
//                                gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, buffer) once, and bufferSubData it in `prepare`.
//                                Bindings 0 (Frame) and 2 (Lighting) belong to the renderer: never rebind them.
//
// ----------------------------------------------------------------------------------------------------
// 3. Shared textures (bound by name by program.use())
// ----------------------------------------------------------------------------------------------------
//   uNoiseTex     sampler2D             256x256 RGBA8 tiling noise (contract.js)
//   uAtlasTex     sampler2D             sign atlas (contract.js)
//   uSceneDepth   sampler2D             targets.sceneDepth
//   uSceneColor   sampler2D             targets.sceneColor (previous frame; reproject with uPrevViewProj)
//   uSceneOpaque  sampler2D             targets.sceneOpaque (valid in the `water` stage and later)
//   uGBuffer0..3  sampler2D             targets.gbuffer
//   uShadowMap    sampler2DArrayShadow  sun / moon cascades   } used through the LIGHTING chunk
//   uLightData    sampler2D             local light records   }
//   uLightCells   usampler2D            light grid            }
//   uSceneProbe   samplerCube           scene reflection probe: used through the SCENE_PROBE chunk, which a shader
//                                       includes after the sky chunk and LIGHTING to get
//                                       vec3 sceneSpecular(vec3 rel, vec3 R, float roughness): what a surface at
//                                       camera-relative `rel` mirrors along R (street, lamps, buildings, sky).
//                                       Use it wherever envSpecular would be used for a reflection. For two
//                                       lobes along the same R: vec3 aim = sceneAim(rel, R), then
//                                       sceneRadiance(aim, roughness) for each.
//   uRainCover    sampler2D             height map of what stands over the ground within 32 m of the camera: used
//                                       through the RAIN_COVER chunk (vertex or fragment shader, after the Frame
//                                       block; it needs nothing else), which gives
//                                       float rainCover(vec3 rel): 1 = open sky above the camera-relative point,
//                                       0 = under a roof, deck, awning or porch; always 1 while it is dry and
//                                       beyond the map. Surface families have it without including anything.
//   plus anything published with host.shareTexture. Names starting with `uSky` or `uEnv` are reserved for the sky module.
//   A stage must not sample a texture that is attached to the framebuffer bound for that stage (WebGL forbids
//   feedback): see the table in section 5 for what is attached.
//
// ----------------------------------------------------------------------------------------------------
// 4. The GLSL chunk the sky module returns (`glsl`)
// ----------------------------------------------------------------------------------------------------
// It is pasted into the renderer's lighting, reflection, fog, glass, glow and particle shaders AFTER
// `surfacePrelude(LIB, 'frag')`, so the Frame block, PI, saturate and the lib.js helpers exist. It must define:
//
//   vec3 envSpecular(vec3 dir, float roughness);
//        Pre-filtered sky radiance arriving from world direction `dir` (unit), blurred for a GGX lobe of the
//        given perceptual roughness (0 = mirror, 1 = fully diffuse). Scene units. Must be valid for dir.y < 0
//        (return a plausible dark ground bounce there). Must NOT contain the sun or moon disc: the renderer
//        adds the analytic highlight of the dominant light itself; keep the aureole and clouds.
//   vec3 envDiffuse(vec3 n);
//        Cosine-weighted mean sky radiance around normal `n` (irradiance / PI). The renderer computes
//        diffuse ambient = albedo * envDiffuse(N) * occlusion.
//   vec4 skyFog(vec3 rel);
//        Height fog plus aerial perspective between the camera and the point at camera-relative world
//        position `rel` (metres; world position = rel + uCamPos.xyz). rgb = in-scattered radiance to add,
//        a = transmittance. The renderer applies `colour = colour * f.a + f.rgb` to opaque and water pixels
//        after reflections, to glass, to particles and to glow sprites. The sky dome applies its own haze.
//
// Optional: `#define SKY_CLOUD_SHADOW 1` together with `float skyCloudShadow(vec3 rel)` (0..1): the renderer
// multiplies it into the sun term of opaque surfaces, glass and particles.
//
// The chunk may declare the `Sky` uniform block and samplers that the module published with
// host.shareTexture. Every global identifier in it must start with `sky`, `uSky`, `env`, `uEnv` or `fog`
// so that it cannot collide with renderer or lib.js names. No `#version`, no precision statements, no outputs.
// It is only ever compiled into fragment shaders. Lightning: the renderer adds the flash to ambient light
// from `uWind.w`; the chunk should not.
//
// ----------------------------------------------------------------------------------------------------
// 5. Stages
// ----------------------------------------------------------------------------------------------------
// ctx = { gl, frame, env, time, dt, frameIndex, width, height,
//         camera: { position /*Float64Array(3), world*/, view, proj, viewProj /*camera-relative, no jitter*/, fovY, near, far },
//         quality /* resolved quality, see quality.js */, framebuffer /* the framebuffer bound for this stage */ }
// On entry the stage's framebuffer and viewport are bound and GL state is as listed. A pass may change
// program, textures, blend, depth, cull and scissor state freely; the renderer restores what it needs afterwards.
// It must leave ctx.framebuffer bound, no vertex array bound and pixelStorei state at its defaults when it returns.
//
// Frame order:  prepare -> shadows -> opaque G-buffer -> ambient occlusion -> deferred lighting -> [copy to
//   sceneOpaque] -> WATER -> BACKGROUND -> reflections + fog -> glass -> PARTICLES -> spray, glows -> temporal AA -> post.
//
//   stage        framebuffer / state on entry
//   -----------  ---------------------------------------------------------------------------------------------
//   'prepare'    none bound; the Frame block is already filled. Update the Sky buffer, advance the environment
//                probe (render into your own targets), simulate.
//   'water'      colour 0 = targets.lit, colour 1..3 = G-buffer attachments 1..3, depth = targets.depth.
//                Depth test LESS, depth write ON, blending off, culling off. The ocean is a FORWARD-LIT surface that
//                also describes itself to the later passes: light it yourself (sun, local lights and shadows through
//                the LIGHTING chunk; refraction from uSceneOpaque; depth fog from uSceneDepth, which still holds the
//                opaque scene only) and finish with writeLitSurface() from SURFACE_WRITE_LIT. Do NOT add environment
//                or screen-space reflection and do NOT apply skyFog: the reflection pass that follows does both for
//                every pixel from the SurfOut you wrote: o.coat = strength of the water surface
//                (lower it on foam), o.coatRough = its roughness. writeLitSurface marks the pixel as open water,
//                which gets a single lobe with f0 = 0.02, traced in screen space with environment fallback, and
//                no occlusion (attachment 0 is out of reach here, so albedo and occlusion are ignored).
//                Samplers allowed here: uSceneOpaque, uSceneDepth, uSceneColor, uGBuffer0; not uGBuffer1..3.
//                If no pass is registered for this stage the copy to sceneOpaque is skipped.
//   'background' targets.lit + depth. Depth test LEQUAL, depth write OFF, blending off. Draw the sky dome at
//                the far plane (FULLSCREEN_VS_FAR puts z at 1, so only pixels with nothing in front are shaded).
//                Output linear radiance, alpha 1. uSceneDepth is stale for water pixels here; do not rely on it.
//   'particles'  targets.lit + depth. Depth test LEQUAL, depth write OFF, blending ON with
//                (ONE, ONE_MINUS_SRC_ALPHA): output premultiplied colour. Rain streaks, splashes.
//                uSceneDepth includes water. Apply skyFog yourself.
//
// Motion vectors of the sky are derived by the renderer from camera rotation; nothing to do.
//
// ----------------------------------------------------------------------------------------------------
// 6. G-buffer layout (WebGL2 guarantees 4 colour attachments; this is the whole surface description)
// ----------------------------------------------------------------------------------------------------
//   attachment 0  RGBA8     rgb = sqrt(albedo) (gamma 2 keeps dark tones), a = occlusion
//   attachment 1  RGBA16F   rg = octahedral normal in [-1,1], ba = motion vector (uv now - uv previous frame, no jitter)
//   attachment 2  RGBA8     r = roughness, g = metal, b = coat strength, a = coat roughness
//   attachment 3  RGBA16F   rgb = emissive radiance, a = wet in [0,1], or 2 + sss for translucent foliage,
//                           or 4 for open water (written by the 'water' stage through writeLitSurface)
//   depth         DEPTH_COMPONENT24

import { FRAME_BLOCK } from './shaders/contract.js';
import { LIGHTING, SCENE_PROBE, RAIN_COVER } from './shaders/common.js';

/** Uniform buffer binding points. */
export const FRAME_BLOCK_BINDING = 0;
export const SKY_BLOCK_BINDING = 1;

/** Stages accepted by host.registerPass, in the order they run. */
export const STAGES = Object.freeze(['prepare', 'water', 'background', 'particles']);

/** linear depth written for pixels with nothing in front of the far plane; test `depth > SKY_DEPTH * 0.5`. */
export const SKY_DEPTH = 1.0e6;

/** First lines of every shader. */
export const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
precision highp sampler2DShadow;
precision highp sampler2DArrayShadow;
precision highp samplerCube;
precision highp usampler2D;
precision highp sampler3D;
`;

/** Vertex shader for host.drawFullscreen(): `in vec2 vUv` (0..1, origin bottom left) in the fragment shader. Depth 0. */
export const FULLSCREEN_VS = HEAD + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Same, but on the far plane (depth exactly 1): with depth func LEQUAL only untouched pixels are shaded. */
export const FULLSCREEN_VS_FAR = HEAD + `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

/**
 * Depth access. Needs the Frame block. uSceneDepth stores positive view-space depth in metres (distance
 * along the camera's forward axis, not along the ray); pixels with no geometry hold SKY_DEPTH.
 */
export const DEPTH = /* glsl */`
uniform highp sampler2D uSceneDepth;
const float SKY_DEPTH = 1.0e6;
// Camera-relative world-space ray through screen uv, scaled so that its view-space depth is 1:
// the point seen at uv with depth z is  viewRay(uv) * z  (camera-relative), world = that + uCamPos.xyz.
vec3 viewRay(vec2 uv) {
  vec4 p = uInvViewProj * vec4(uv * 2.0 - 1.0, 0.0, 1.0);
  vec3 d = p.xyz / p.w;
  vec3 fwd = -vec3(uView[0][2], uView[1][2], uView[2][2]);
  return d / dot(d, fwd);
}
// Pixel of the render target under uv, clamped to the target.
ivec2 scenePixel(vec2 uv) { return clamp(ivec2(uv * uViewport.xy), ivec2(0), ivec2(uViewport.xy) - 1); }
float sceneDepth(vec2 uv) { return texelFetch(uSceneDepth, scenePixel(uv), 0).r; }
bool isSky(float viewDepth) { return viewDepth > 0.5 * SKY_DEPTH; }
// View-space depth of a camera-relative point.
float viewDepthOf(vec3 rel) { return -(uView[0][2] * rel.x + uView[1][2] * rel.y + uView[2][2] * rel.z); }
`;

const SURFACE_ENCODE = /* glsl */`
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
  return n.y >= 0.0 ? n.xz : (1.0 - abs(n.zx)) * s;
}
// Motion vector of a point that does not move in the world. rel = camera-relative position.
vec2 staticVelocity(vec3 rel) {
  vec4 a = uViewProjStable * vec4(rel, 1.0), b = uPrevViewProj * vec4(rel, 1.0);
  return (a.xy / a.w - b.xy / b.w) * 0.5;
}
vec4 encodeNormalVelocity(in SurfOut o, vec2 velocity) { return vec4(octEncode(normalize(o.N)), velocity); }
vec4 encodeSpecular(in SurfOut o) { return vec4(clamp(o.rough, 0.0, 1.0), clamp(o.metal, 0.0, 1.0), clamp(o.coat, 0.0, 1.0), clamp(o.coatRough, 0.0, 1.0)); }
vec4 encodeEmissive(in SurfOut o) { return vec4(max(o.emissive, 0.0), o.sss > 0.0 ? 2.0 + clamp(o.sss, 0.0, 1.0) : clamp(o.wet, 0.0, 1.0)); }
`;

/**
 * G-buffer output for deferred surfaces. Needs SURFACE_STRUCTS and the Frame block.
 * Fill a SurfOut exactly as a surface family would, then call writeGBuffer(o, velocity).
 */
export const GBUFFER_WRITE = /* glsl */`
layout(location = 0) out vec4 gOut0;
layout(location = 1) out vec4 gOut1;
layout(location = 2) out vec4 gOut2;
layout(location = 3) out vec4 gOut3;
` + SURFACE_ENCODE + /* glsl */`
void writeGBuffer(in SurfOut o, vec2 velocity) {
  gOut0 = vec4(sqrt(clamp(o.albedo, 0.0, 1.0)), clamp(o.ao, 0.0, 1.0));
  gOut1 = encodeNormalVelocity(o, velocity);
  gOut2 = encodeSpecular(o);
  gOut3 = encodeEmissive(o);
}
`;

/**
 * Output for the `water` stage: lit radiance plus the surface description the reflection, fog and
 * temporal passes read. writeLitSurface(radiance, o, staticVelocity(rel)).
 */
export const SURFACE_WRITE_LIT = /* glsl */`
layout(location = 0) out vec4 gOut0;
layout(location = 1) out vec4 gOut1;
layout(location = 2) out vec4 gOut2;
layout(location = 3) out vec4 gOut3;
` + SURFACE_ENCODE + /* glsl */`
void writeLitSurface(vec3 radiance, in SurfOut o, vec2 velocity) {
  gOut0 = vec4(max(radiance, 0.0), 1.0);
  gOut1 = encodeNormalVelocity(o, velocity);
  gOut2 = encodeSpecular(o);
  // Alpha 4 marks open water: the water stage cannot reach attachment 0, so the reflection pass must not
  // trust the albedo and occlusion stored there, and water has a single specular lobe (the film).
  gOut3 = vec4(max(o.emissive, 0.0), 4.0);
}
`;

/** G-buffer input. Declares uGBuffer0..3 and decodes one pixel. */
export const GBUFFER_READ = /* glsl */`
uniform sampler2D uGBuffer0;
uniform sampler2D uGBuffer1;
uniform sampler2D uGBuffer2;
uniform sampler2D uGBuffer3;
struct GPixel {
  vec3 albedo; float ao;
  vec3 N; vec2 velocity;
  float rough; float metal; float coat; float coatRough;
  vec3 emissive; float wet; float sss;
  float water;              // 1 on open water: albedo and ao are not meaningful, coat / coatRough describe the surface
};
vec3 octDecode(vec2 e) {
  vec3 n = vec3(e.x, 1.0 - abs(e.x) - abs(e.y), e.y);
  float t = max(-n.y, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.z += n.z >= 0.0 ? -t : t;
  return normalize(n);
}
GPixel readGBuffer(ivec2 px) {
  vec4 a = texelFetch(uGBuffer0, px, 0), b = texelFetch(uGBuffer1, px, 0), c = texelFetch(uGBuffer2, px, 0), d = texelFetch(uGBuffer3, px, 0);
  GPixel g;
  g.albedo = a.rgb * a.rgb; g.ao = a.a;
  g.N = octDecode(b.xy); g.velocity = b.zw;
  g.rough = c.r; g.metal = c.g; g.coat = c.b; g.coatRough = c.a;
  g.emissive = d.rgb;
  g.water = step(3.5, d.a);
  g.sss = d.a > 1.5 && d.a < 3.5 ? d.a - 2.0 : 0.0;
  g.wet = d.a > 3.5 ? 1.0 : (d.a > 1.5 ? 0.0 : d.a);
  if (g.water > 0.5) { g.albedo = vec3(0.0); g.ao = 1.0; }
  return g;
}
`;

export const HOST_GLSL = Object.freeze({ HEAD, FULLSCREEN_VS, FULLSCREEN_VS_FAR, FRAME_BLOCK, DEPTH, GBUFFER_WRITE, GBUFFER_READ, SURFACE_WRITE_LIT, LIGHTING, SCENE_PROBE, RAIN_COVER });
