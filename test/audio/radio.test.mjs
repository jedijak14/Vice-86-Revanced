// The radio: a score you can hold. The host binding needs a page; the bar generator needs nothing, so
// the tests hear the music the way a conductor reads it — note by note, bar by bar.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { radioBar, titleFor, hz, STATIONS, createRadio } from '../../web/src/audio/radio.js';

const seeded = (s) => { let a = s >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; };

test('three stations, three temperaments, all of them in tune', () => {
  assert.equal(STATIONS.length, 3);
  for (const st of STATIONS) {
    const bar = radioBar(st.id, 2, seeded(5));
    assert.ok(bar.notes.length > 6, `${st.id} plays ${bar.notes.length} notes a bar: thin`);
    assert.equal(bar.beat, 60 / st.bpm);
    for (const n of bar.notes) {
      assert.ok(n.t >= 0 && n.t < bar.beat * 4 + 0.01, `${st.id}: a note at ${n.t}s is outside the bar`);
      assert.ok(n.dur > 0 && n.gain > 0);
      if (n.voice === 'key' || n.voice === 'bass' || n.voice === 'pad' || n.voice === 'arp') {
        assert.ok(n.freq > 30 && n.freq < 4200, `${st.id}: ${n.freq} Hz is not a note a car speaker owes`);
      }
    }
  }
  assert.ok(Math.abs(hz(69) - 440) < 1e-9, 'and A440 is still A440');
});

test('lofi swings and crackles; synthwave does not swing, and walks eights', () => {
  const lofi = radioBar('kbay', 0, seeded(3));
  const hats = lofi.notes.filter((n) => n.voice === 'hat');
  const beat = lofi.beat;
  const off = hats.filter((n) => Math.abs((n.t / beat) % 1 - 1.16) < 0.02 || Math.abs((n.t / beat) % 1 - 0.16) < 0.02);
  assert.ok(off.length >= 2, 'the off-beats land late: that is the swing');
  assert.ok(lofi.notes.some((n) => n.voice === 'crackle'), 'and the vinyl is on');
  const cruise = radioBar('cruise', 0, seeded(3));
  assert.ok(cruise.notes.every((n) => Math.abs((n.t / cruise.beat) * 2 - Math.round((n.t / cruise.beat) * 2)) < 1e-9),
    'synthwave is straight eights or it is not synthwave');
  assert.ok(cruise.notes.filter((n) => n.voice === 'kick').length === 4, 'four on the floor');
  const jazz = radioBar('bayou', 1, seeded(3));
  assert.ok(jazz.notes.some((n) => n.voice === 'ride'), 'the combo keeps time on the ride');
  const walk = jazz.notes.filter((n) => n.voice === 'bass');
  assert.equal(walk.length, 4, 'and the bassist walks four');
});

test('the same seed is the same bar, and the progression walks', () => {
  const a = radioBar('kbay', 4, seeded(9));
  const b = radioBar('kbay', 4, seeded(9));
  assert.deepEqual(a.notes, b.notes);
  const c = radioBar('kbay', 5, seeded(9));
  assert.notDeepEqual(c.notes, a.notes, 'the next bar is a different bar');
  const bass0 = radioBar('kbay', 0, seeded(1)).notes.find((n) => n.voice === 'bass').freq;
  const bass1 = radioBar('kbay', 1, seeded(1)).notes.find((n) => n.voice === 'bass').freq;
  assert.notEqual(bass0, bass1, 'the roots change with the chords');
});

test('titles arrive every sixteen bars and read like track names', () => {
  assert.equal(radioBar('cruise', 3, seeded(2)).title, null);
  const t = radioBar('cruise', 16, seeded(2)).title;
  assert.ok(typeof t === 'string' && t.length > 4, 'a title at the top of the set');
  const lofi = titleFor(STATIONS[0], 0, seeded(4));
  assert.ok(/^[A-Z][a-z]+ [A-Z]/.test(lofi), `"${lofi}" reads as a two-word lofi title`);
});

test('a radio with no page is a silent radio, not a crashed one', () => {
  const radio = createRadio({ context: () => null });
  radio.start();
  assert.equal(radio.tick(0.5), 0, 'nothing schedules without a context');
  assert.equal(radio.next().id, 'cruise', 'the dial still turns');
  assert.ok(radio.title.length > 0, 'and it still knows what it would be playing');
});
