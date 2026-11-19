// The cell: bail priced from the stars you arrived with, a guard on a loop, and two doors out —
// one of them honest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createJail, BAIL_PER_STAR, ESCAPE_SECONDS, GUARD_PENALTY } from '../../web/src/game/jail.js';
import { WantedLedger } from '../../web/src/game/wanted.js';

const fakePurse = (cash) => {
  const purse = { cash, lost: [], lose(d, p) { purse.cash -= d; purse.lost.push([d, p]); } };
  return purse;
};
const fakeFoot = () => ({ pos: [0, 0, 0], yaw: 0, placed: [], place(x, y, z, yaw) { this.pos = [x, y, z]; this.yaw = yaw; this.placed.push([x, z]); } });

const setup = (cash = 5000) => {
  const notes = [];
  const wanted = new WantedLedger();
  const foot = fakeFoot();
  const jail = createJail({
    purse: fakePurse(cash), wanted, foot, camera: { snap() {} }, audio: { door() {} },
    toast: (t) => notes.push(t),
    plan: { landmarks: [{ kind: 'police_vice_point', x: 0, z: 0, yaw: 0 }] },
  });
  return { jail, wanted, foot, notes };
};

test('an arrest prices the bail from the stars and empties the ledger', () => {
  const { jail, wanted, foot } = setup();
  wanted.add('shots fired'); wanted.add('person shot');
  const stars = wanted.stars;
  assert.ok(stars > 0);
  assert.equal(jail.bust(stars), true);
  assert.equal(jail.jailed, true);
  assert.equal(jail.bail, BAIL_PER_STAR * stars);
  assert.equal(wanted.stars, 0, 'a man in a cell is not a man the street is chasing');
  assert.ok(foot.placed.length === 1, 'and he was walked to the yard');
  assert.equal(jail.bust(stars), false, 'the door does not close twice');
});

test('bail is the honest door: it costs the purse and clears the record', () => {
  const { jail, wanted, notes } = setup(5000);
  jail.bust(2);
  assert.equal(jail.payBail(), true);
  assert.equal(jail.jailed, false);
  assert.equal(wanted.stars, 0);
  const poor = setup(10);
  poor.jail.bust(3);
  assert.equal(poor.jail.payBail(), false, 'a purse with ten dollars in it pays no bail');
  assert.equal(poor.jail.jailed, true, 'and the door stays shut');
  assert.ok(notes.length > 0);
});

test('the wall is free but slow, and a guard who sees it raises the bail', () => {
  const { jail, wanted, foot } = setup();
  jail.bust(1);
  const site = jail.site;
  // Stand the walker where the guard never walks: far corner of the yard.
  foot.pos = [site.cell[0] + 40, 0, site.cell[2] + 40];
  let out = null;
  for (let t = 0; t < ESCAPE_SECONDS + 1 && !out; t += 0.25) out = jail.step(0.25, true);
  assert.equal(out, 'escaped', 'nine seconds of held breathing opens the bars');
  assert.equal(jail.jailed, false);
  assert.ok(wanted.stars > 0, 'over the wall is a charge of its own');

  const caught = setup();
  caught.jail.bust(1);
  caught.foot.pos = [site.cell[0], 0, site.cell[2]];   // the guard's own loop passes the cell
  const bail0 = caught.jail.bail;
  let seen = false;
  for (let t = 0; t < 40 && !seen; t += 0.25) {
    caught.jail.step(0.25, true);
    if (caught.jail.bail > bail0) seen = true;
  }
  assert.ok(seen, 'sooner or later the guard is close and the bars give him away');
  assert.equal(caught.jail.escape, 0, 'the work is lost');
  assert.equal(caught.jail.bail, bail0 + GUARD_PENALTY, 'and bent bars are evidence');
});

test('letting go lets the bars spring back', () => {
  const { jail, foot } = setup();
  jail.bust(1);
  foot.pos = [jail.site.cell[0] + 40, 0, jail.site.cell[2] + 40];
  jail.step(1, true);
  const part = jail.escape;
  assert.ok(part > 0);
  jail.step(2, false);
  assert.ok(jail.escape < part, 'half as fast as they bent, but they spring back');
});
