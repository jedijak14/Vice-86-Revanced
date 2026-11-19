// The street's voices: what the bank holds, how a line is chosen, and how much of a street it can
// say. These are the numbers the brief asked for - a million lines' worth of distinct audible
// renderings, each gender answering a carjacking in its own recorded voice - held here so that a
// smaller bank, a lost variant or a prosody space that quietly collapsed is a failed test rather
// than a quieter street.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CONTEXTS, LINE_TEXTS, PROSODY_SEEDS, DISTANCE_BANDS, voiceLineSpace, pickLine, createVoice,
} from '../../web/src/audio/voice.js';

const here = dirname(fileURLToPath(import.meta.url));
const bankDir = join(here, '..', '..', 'web', 'assets', 'voice');

test('the recorded bank holds both genders for every context', () => {
  const manifest = JSON.parse(readFileSync(join(bankDir, 'manifest.json'), 'utf8'));
  for (const key of Object.keys(CONTEXTS)) {
    for (const gender of ['m', 'f']) {
      for (const id of CONTEXTS[key][gender]) {
        assert.ok(manifest.files[`${id}.wav`], `the bank is missing ${id}.wav`);
        assert.ok(LINE_TEXTS[id], `${id} has no words to subtitle`);
        const f = manifest.files[`${id}.wav`];
        assert.ok(f.seconds > 0.5 && f.seconds < 8, `${id} should be a spoken line, not ${f.seconds}s`);
        assert.equal(f.channels, 1, `${id} should be mono`);
      }
    }
  }
});

test('the witness bark is the sentence the street was told to say, in both voices', () => {
  assert.equal(LINE_TEXTS.m_carjack, "What are you doing?! I'm calling the cops!");
  assert.equal(LINE_TEXTS.f_carjack, "What are you doing?! I'm calling the cops!");
  // The owner's scream is its own recording, not the witness bark played again.
  assert.notEqual(LINE_TEXTS.m_owner, LINE_TEXTS.m_carjack);
  assert.notEqual(LINE_TEXTS.f_owner, LINE_TEXTS.f_carjack);
});

test('the line space is over a million distinct audible renderings', () => {
  const space = voiceLineSpace();
  assert.ok(space > 1_000_000, `the street can only say ${space} things`);
  assert.equal(space, Object.keys(CONTEXTS).length * 2 * PROSODY_SEEDS * DISTANCE_BANDS);
});

test('a line is chosen by the speaker, and the same speaker always talks the same way', () => {
  const a = pickLine('carjack', 'm', 1234);
  const b = pickLine('carjack', 'm', 1234);
  assert.deepEqual(a, b, 'the same man should not deliver a line two ways');
  assert.equal(a.id, 'm_carjack');
  assert.ok(a.rate >= 0.94 && a.rate <= 1.06, `rate ${a.rate} is outside a person's range`);
  assert.ok(a.band >= 0 && a.band < DISTANCE_BANDS);
  // The genders never share a recording.
  assert.equal(pickLine('carjack', 'f', 1234).id, 'f_carjack');
  assert.equal(pickLine('owner', 'f', 7).id, 'f_owner');
  // An unknown context falls back to the pavement's small talk rather than saying nothing.
  assert.equal(pickLine('nonsense', 'm', 3).id, 'm_greet');
});

test('prosody actually varies across speakers, so no two of them read a line alike', () => {
  const rates = new Set();
  for (let seed = 0; seed < 64; seed++) rates.add(pickLine('shots', seed % 2 ? 'f' : 'm', seed).rate);
  assert.ok(rates.size > 32, `only ${rates.size} distinct deliveries out of 64 speakers`);
});

test('the player decodes the bank once and says a line with its words', async () => {
  // No AudioContext here: the player must still hand back the words for the subtitle row, and must
  // not throw when the page has not unlocked its audio yet.
  const v = createVoice({ context: () => null, manifest: { files: {} } });
  const said = v.say('carjack', 'f', { x: 4, z: 0, lx: 0, lz: 0, seed: 9 });
  assert.equal(said.text, LINE_TEXTS.f_carjack);
  assert.equal(said.seconds, 0, 'nothing was decoded, so nothing plays');
  assert.equal(v.ready, false);
});
