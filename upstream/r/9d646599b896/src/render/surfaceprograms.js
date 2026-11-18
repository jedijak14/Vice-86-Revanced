// The programs of the surface families, built as the scene comes to need them.
//
// A family's materials are split into groups, each a program of its own (shaders/surface.js says why), and
// every group needs a program per draw kind and per pass: several hundred combinations, of which a street
// uses a few dozen. So nothing is built ahead. The scene reports each (family, kind, group) an added object
// carries (want); the programs of the passes that draw that object's world are then created, and are compiled
// a few at a time (gl.js), those of the second views after all others. A linked program is still not drawn with: on Direct3D the driver compiles a shader a second
// time, on the thread that also presents the frame, the first time it is drawn into a target layout or with
// a vertex layout it had not assumed. That first draw is made here instead, one program at a time, with a
// triangle that covers nothing (tick), and only then does the program appear in the tables the scene draws
// from. Triangles whose program is not there yet are left out of the frame.
//
// The split costs a draw call per group where one per family did. Second views get that back: they draw
// into one colour target, and a program that does compiles in full on the driver's worker thread however
// long it takes, with no second compile at its first draw. So a split family also gets one program of all
// its materials per draw kind for those views (viewWhole), compiled one at a time once the game has been
// played for a while with nothing else to compile (gl.js: COMPILE_SPARE) and used from the frame it is
// ready; until then, and if it cannot be built, the groups are drawn.

import { FAMILY, FAMILY_NAMES } from '../core/ids.js';
import { Program, COMPILE_FIRST, COMPILE_AFTER, COMPILE_SPARE, createTexture, createFramebuffer } from './gl.js';
import { KINDS, WHOLE_FAMILY } from './shaders/surface.js';

export const PASS_GBUFFER = 0, PASS_VIEW = 1, PASS_SHADOW = 2, PASS_FORWARD = 3;
const PASS_NAMES = Object.freeze(['gbuffer', 'view', 'shadow', 'forward']);

/** The two worlds a frame can show (scene.js): an object belongs to one, and so do the passes that draw it. */
export const WORLD_STREET = 0, WORLD_ROOM = 1;

// Edge of the targets the first draws go to. Nothing is rasterised; only the layout matters.
const WARM_SIZE = 4;

export class SurfacePrograms {
  /**
   * families: name -> normalised family (shaders/surface.js); forwardFamily: the name of the blended one.
   * sourceOf(name, kind, pass, group, plain) -> { key, vertex, fragment }: the sources of one program;
   * plain = true asks for the stand-in used when the family's own shader fails on this device.
   */
  constructor(ctx, families, forwardFamily, sourceOf) {
    this.ctx = ctx; this.sourceOf = sourceOf;
    this.forwardFamily = FAMILY_NAMES.indexOf(forwardFamily);
    this.groupCount = []; this.groupOf = []; this.twoSided = [];
    // What the scene draws with: a program is entered once it has linked and been drawn once. Until then null.
    this.gbuffer = []; this.view = []; this.forward = [];       // gbuffer, view: [family][kind][group]; forward: [kind][group]
    this.viewWhole = [];                                         // [family][kind]: all the groups of a split family at once
    this.shadow = [];                                            // [class][kind]
    // Depth-only programs are shared by every family and group whose shadow sources are the same text.
    this.shadowClass = [];                                       // [family][group] -> class, -1 = casts none
    this.shadowOwner = [];                                       // [class] -> the one family that uses it, -1 when several do
    this._shadowSource = [];                                     // [class] -> { family, group } to build it from
    const classBySource = new Map();
    for (let f = 0; f < FAMILY.COUNT; f++) {
      const name = FAMILY_NAMES[f], family = families[name], groups = family.groupFragments.length;
      this.groupCount.push(groups); this.groupOf.push(family.groupOf); this.twoSided.push(family.twoSided);
      const table = () => KINDS.map(() => new Array(groups).fill(null));
      this.gbuffer.push(table()); this.view.push(table()); this.viewWhole.push(KINDS.map(() => null));
      if (f === this.forwardFamily) this.forward = table();
      const classes = new Int32Array(groups).fill(-1);
      this.shadowClass.push(classes);
      if (f === this.forwardFamily) continue;
      // An opaque family's depth-only fragment shader is empty whatever the group; a cut-out one runs its materials.
      for (let group = 0; group < (family.alphaTest ? groups : 1); group++) {
        const signature = KINDS.map((kind) => { const s = sourceOf(name, kind, 'shadow', group, false); return s.vertex + s.fragment; }).join('\u0000');
        let cls = classBySource.get(signature);
        if (cls === undefined) {
          cls = this.shadow.length; classBySource.set(signature, cls);
          this.shadow.push(KINDS.map(() => null)); this.shadowOwner.push(f); this._shadowSource.push({ family: f, group });
        } else if (this.shadowOwner[cls] !== f) this.shadowOwner[cls] = -1;
        if (family.alphaTest) classes[group] = cls; else classes.fill(cls);
      }
    }
    // Bits of the groups wanted, per world, family and kind; and which passes draw each world.
    this._wanted = [new Int32Array(FAMILY.COUNT * KINDS.length), new Int32Array(FAMILY.COUNT * KINDS.length)];
    this._viewPass = [false, false];
    this._made = new Set();              // slots a program has been created for
    this._entries = [];                  // every program created: { program, pass, kind, table, index, spare }
    this._queue = [];                    // those not yet drawn for the first time
    this._warming = null; this._fence = null;
    this._targets = null;
    /** Counts the programs that have become drawable: a view that keeps what it drew (a room's reflection cube) compares it. */
    this.generation = 0;
  }

  /** How many programs the picture needs that cannot be drawn with yet (those it merely draws faster with are not counted). */
  get pending() {
    let pending = this._warming && !this._warming.spare ? 1 : 0;
    for (let i = 0; i < this._queue.length; i++) if (!this._queue[i].spare) pending++;
    return pending;
  }

  /** The scene holds an object of `world` whose mesh has triangles of this family and group, drawn as `kind`. */
  want(family, kind, group, world) {
    const wanted = this._wanted[world], slot = family * KINDS.length + kind, bit = 1 << group;
    if (wanted[slot] & bit) return;
    wanted[slot] |= bit;
    this._createFor(family, kind, group, world);
  }

  /** Whether second views (reflection probe, mirror) are drawn of `world` at the current quality. */
  setViewPass(world, on) {
    if (this._viewPass[world] === on) return;
    this._viewPass[world] = on;
    if (!on) return;
    const wanted = this._wanted[world];
    for (let slot = 0; slot < wanted.length; slot++) {
      const family = (slot / KINDS.length) | 0, kind = slot % KINDS.length;
      for (let group = 0; group < this.groupCount[family]; group++) if (wanted[slot] & (1 << group)) this._create(PASS_VIEW, family, kind, group);
    }
  }

  _createFor(family, kind, group, world) {
    if (family === this.forwardFamily) this._create(PASS_FORWARD, family, kind, group);
    else { this._create(PASS_GBUFFER, family, kind, group); this._create(PASS_SHADOW, family, kind, group); }
    if (this._viewPass[world]) this._create(PASS_VIEW, family, kind, group);
  }

  _create(pass, family, kind, group) {
    let table, index, from = family, fromGroup = group;
    if (pass === PASS_SHADOW) {
      const cls = this.shadowClass[family][group];
      if (cls < 0) return;
      table = this.shadow[cls]; index = kind; from = this._shadowSource[cls].family; fromGroup = this._shadowSource[cls].group;
    } else if (group === WHOLE_FAMILY) {
      table = this.viewWhole[family]; index = kind;
    } else {
      table = (pass === PASS_GBUFFER ? this.gbuffer[family] : pass === PASS_VIEW ? this.view[family] : this.forward)[kind]; index = group;
    }
    const spare = group === WHOLE_FAMILY;
    const slot = ((pass * FAMILY.COUNT + from) * KINDS.length + kind) * 256 + (spare ? 255 : fromGroup);
    if (this._made.has(slot)) return;
    this._made.add(slot);
    const name = FAMILY_NAMES[from], sourceOf = this.sourceOf;
    const source = sourceOf(name, KINDS[kind], PASS_NAMES[pass], fromGroup, false);
    // A whole family that fails to build is done without; a group is replaced by the family's plain stand-in.
    const plain = spare ? null : () => { const q = sourceOf(name, KINDS[kind], PASS_NAMES[pass], fromGroup, true); return [q.vertex, q.fragment]; };
    // A second view of the scene can do without a material for a moment; the picture itself cannot: views compile after it.
    const order = spare ? COMPILE_SPARE : pass === PASS_VIEW ? COMPILE_AFTER : COMPILE_FIRST;
    const entry = { program: new Program(this.ctx, source.key, source.vertex, source.fragment, plain, order), pass, kind, table, index, spare };
    this._entries.push(entry); this._queue.push(entry);
    if (pass === PASS_VIEW && !spare && this.groupCount[family] > 1) this._create(PASS_VIEW, family, kind, WHOLE_FAMILY);
  }

  /** One small framebuffer per target layout a surface program is drawn into, indexed by pass. */
  _warmTargets() {
    if (this._targets) return this._targets;
    const gl = this.ctx.gl, textures = [];
    const make = (internal) => { const t = createTexture(gl, { internal, width: WARM_SIZE, height: WARM_SIZE }); textures.push(t); return t; };
    const depth = make(gl.DEPTH_COMPONENT24);
    const gbuffer = createFramebuffer(gl, 'first draw, G-buffer', [make(gl.RGBA8), make(gl.RGBA16F), make(gl.RGBA8), make(gl.RGBA16F)], depth);
    const colour = createFramebuffer(gl, 'first draw, one colour', [make(gl.RGBA16F)], depth);
    const depthOnly = createFramebuffer(gl, 'first draw, depth', [], depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._targets = { textures, framebuffers: [gbuffer, colour, depthOnly], byPass: [gbuffer, colour, depthOnly, colour] };
    return this._targets;
  }

  /**
   * Call once per frame, and repeatedly while loading. Takes at most one linked program through its first
   * draw, and enters it in the tables when the GPU reports that draw done: the fence is what keeps two
   * compiles from ever queueing up behind each other on the driver's thread. scene: the Scene, which owns
   * the vertex layouts. Returns `pending`.
   */
  tick(scene) {
    const gl = this.ctx.gl, queue = this._queue;
    if (this._fence) {
      if (gl.clientWaitSync(this._fence, 0, 0) === gl.TIMEOUT_EXPIRED) return this.pending;
      gl.deleteSync(this._fence); this._fence = null;
      const done = this._warming; this._warming = null;
      done.table[done.index] = done.program; this.generation++;
    }
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (!entry.program.use()) continue;                     // still linking
      this.ctx.lastProgram = entry.program.name + ' (first draw)';
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._warmTargets().byPass[entry.pass]);
      scene.drawNothing(entry.kind);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
      // No fence means the context has just been lost: the program stays queued and is drawn again once it is back.
      if (this._fence) { queue.splice(i, 1); this._warming = entry; }
      break;
    }
    return this.pending;
  }

  /** The context was lost: every program is being rebuilt (index.js) and has to be drawn for the first time again. */
  forget() {
    const queue = this._queue;
    queue.length = 0;
    for (const entry of this._entries) { entry.table[entry.index] = null; queue.push(entry); }
    this._warming = null; this._fence = null; this._targets = null;
  }

  dispose() {
    const gl = this.ctx.gl;
    if (this._fence) gl.deleteSync(this._fence);
    if (this._targets) { for (const f of this._targets.framebuffers) gl.deleteFramebuffer(f); for (const t of this._targets.textures) gl.deleteTexture(t); }
    this._fence = null; this._targets = null;
  }
}
