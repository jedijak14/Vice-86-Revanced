// What `?webgl2=force` is for: a device that could run the game being turned away by the *way* the
// game asked, and a device that cannot be told the truth rather than being let fail quietly.
// createContext is a pure function of a canvas, so it can be judged here with a fake GL.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createContext } from '../../web/src/render/gl.js';
import { parseOptions } from '../../web/src/game/automation.js';

/**
 * A stand-in for a browser's WebGL2 context: enough surface for createContext, and the two
 * capabilities the game refuses to run without are the knobs.
 */
function fakeGL({ float = true, drawBuffers = 8 } = {}) {
  const gl = {
    RENDERER: 0x1f01, VENDOR: 0x1f02, MAX_TEXTURE_SIZE: 0x0d33, MAX_DRAW_BUFFERS: 0x8824,
    getExtension(name) { return name === 'EXT_color_buffer_float' ? (float ? {} : null) : null; },
    getParameter(token) {
      if (token === gl.MAX_DRAW_BUFFERS) return drawBuffers;
      if (token === gl.MAX_TEXTURE_SIZE) return 8192;
      return 'Fake GPU';
    },
  };
  return gl;
}

/** A canvas that hands out a context only for a request it likes, the way a real driver does. */
function fakeCanvas(gl, { refuseAttrs = () => false } = {}) {
  const seen = [];
  return {
    seen,
    getContext(kind, attrs) {
      seen.push({ kind, attrs });
      if (refuseAttrs(attrs)) return null;
      return gl;
    },
  };
}

/** Runs `fn` with console.warn collected, since the forced path is expected to say something. */
function withWarns(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = original;
  }
}

test('a device without float render targets is refused, and told why', () => {
  const canvas = fakeCanvas(fakeGL({ float: false }));
  assert.throws(() => createContext(canvas), /EXT_color_buffer_float/);
});

test('forcing past a missing capability runs, at the lowest tier, and says so', () => {
  const canvas = fakeCanvas(fakeGL({ float: false }));
  const { result: ctx, warns } = withWarns(() => createContext(canvas, { force: true }));
  assert.ok(ctx.gl, 'a context came back');
  assert.equal(ctx.forced, true);
  assert.equal(ctx.floatTargets, false);
  assert.equal(ctx.caps.tierHint, 'ultraLow', 'a forced device starts at the bottom rung and climbs from there');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /WebGL2 was forced past/);
  assert.match(warns[0], /float render targets/);
});

test('too few draw buffers is likewise a refusal, not a forced crash', () => {
  const canvas = fakeCanvas(fakeGL({ drawBuffers: 2 }));
  assert.throws(() => createContext(canvas), /render targets/);
  const { result: ctx, warns } = withWarns(() => createContext(canvas, { force: true }));
  assert.equal(ctx.caps.maxDrawBuffers, 2);
  assert.match(warns[0], /2 draw buffer/);
});

test('forcing retries the request without the attributes a driver may refuse', () => {
  // A `high-performance` / desynchronised request is exactly what some software and power-managed
  // drivers answer with null, even though they can do WebGL2. Without forcing that is a dead end;
  // with it, the second, plainer question gets a context.
  const gl = fakeGL();
  const canvas = fakeCanvas(gl, { refuseAttrs: (attrs) => attrs.powerPreference === 'high-performance' });
  assert.throws(() => createContext(canvas), /does not provide/);
  assert.deepEqual(canvas.seen.map((s) => s.kind), ['webgl2'], 'a device that is refused is not asked for WebGL1 instead');
  canvas.seen.length = 0;
  const { result: ctx, warns } = withWarns(() => createContext(canvas, { force: true }));
  assert.equal(ctx.gl, gl);
  assert.equal(canvas.seen.length, 2, 'asked twice');
  assert.equal(canvas.seen[0].attrs.powerPreference, 'high-performance');
  assert.equal(canvas.seen[1].attrs.powerPreference, undefined);
  assert.match(warns[0], /context attributes/);
});

test('a device that answers normally asks once and is not warned at', () => {
  const canvas = fakeCanvas(fakeGL());
  const { result: ctx, warns } = withWarns(() => createContext(canvas));
  assert.equal(canvas.seen.length, 1);
  assert.equal(ctx.forced, false);
  assert.equal(ctx.floatTargets, true);
  assert.deepEqual(warns, []);
});

test('the query string is the only way in', () => {
  assert.equal(parseOptions('?webgl2=force').webgl2, 'force');
  assert.equal(parseOptions('?webgl2=FORCE').webgl2, 'force');
  assert.equal(parseOptions('').webgl2, null);
  assert.equal(parseOptions('?webgl2=off').webgl2, null, 'anything else is not guessed at');
  assert.equal(parseOptions('?webgl2=1').webgl2, null, 'a bare 1 does not force a device past a check');
});
