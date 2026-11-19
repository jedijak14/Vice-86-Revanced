// The desktop icon is drawn by tools/make_icon.py, not downloaded, so the test holds the container
// to the same standard as everything else generated here: well-formed, self-consistent, small.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = readFileSync(path.join(here, '../../desktop/build/icon.ico'));

const SIZES = [256, 64, 48, 32, 16];

test('the icon is one directory and five images, largest first', () => {
  const [reserved, type, count] = [file.readUInt16LE(0), file.readUInt16LE(2), file.readUInt16LE(4)];
  assert.equal(reserved, 0);
  assert.equal(type, 1, 'type 1 is an icon, not a cursor');
  assert.equal(count, SIZES.length);
});

test('every entry is 32-bit, contiguous, and inside the file', () => {
  let offset = 6 + 16 * SIZES.length;
  for (let i = 0; i < SIZES.length; i++) {
    const at = 6 + 16 * i;
    const w = file[at] || 256, h = file[at + 1] || 256;
    const planes = file.readUInt16LE(at + 4), bits = file.readUInt16LE(at + 6);
    const size = file.readUInt32LE(at + 8), off = file.readUInt32LE(at + 12);
    assert.equal(w, SIZES[i], `entry ${i} is ${SIZES[i]} wide`);
    assert.equal(h, SIZES[i]);
    assert.equal(planes, 1);
    assert.equal(bits, 32, 'true colour with alpha, no palette');
    assert.equal(off, offset, `entry ${i} starts where the last one ended`);
    assert.ok(off + size <= file.length, `entry ${i} fits in the file`);
    offset += size;
  }
  assert.equal(offset, file.length, 'and nothing is left over');
});

test('256 is a PNG, the rest are BMPs with a doubled header height', () => {
  for (let i = 0; i < SIZES.length; i++) {
    const at = 6 + 16 * i;
    const size = file.readUInt32LE(at + 8), off = file.readUInt32LE(at + 12);
    const head = file.subarray(off, off + 4);
    if (SIZES[i] >= 256) {
      assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47], 'the big one is a PNG stream');
    } else {
      assert.equal(file.readUInt32LE(off), 40, 'a BITMAPINFOHEADER');
      assert.equal(file.readInt32LE(off + 8), SIZES[i] * 2, 'XOR and AND stacked, per the spec');
    }
  }
});

test('the icon earns its keep: under 64 KB for the whole family', () => {
  assert.ok(file.length < 64 * 1024, `${file.length} bytes is a whole icon set, not a texture`);
});
