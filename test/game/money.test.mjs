import test from 'node:test';
import assert from 'node:assert/strict';

import { createPurse, formatCash, breakdown, tillFor, DENOMS } from '../../web/src/game/money.js';

test('the purse is a whole number of cents, whatever it is handed', () => {
  const purse = createPurse({ cash: 12.345 });
  assert.equal(purse.cents, 1235, `${purse.cents} cents for twelve dollars and a fraction of a cent`);
  assert.equal(purse.cash, 12.35);
  purse.add(0.004);                       // rounds to nothing: a half-cent offer is not a payment
  assert.equal(purse.cents, 1235);
  purse.add(-40);
  assert.equal(purse.cents, 1235, 'a negative gift took money away');
});

test('a counter either pays or it does not', () => {
  const purse = createPurse({ cash: 40 });
  assert.ok(purse.canPay(39.99));
  assert.ok(!purse.canPay(40.01));
  assert.equal(purse.pay(40.01, 'shops'), false, 'an unaffordable order was filled');
  assert.equal(purse.cash, 40);
  assert.equal(purse.pay(19.5, 'shops'), true);
  assert.equal(purse.cash, 20.5);
  assert.equal(purse.snapshot().spent.shops, 19.5);
  assert.ok(purse.earned.shops === undefined, 'a purpose invented a field on the ledger');
});

test('money is remembered by where it came from', () => {
  const purse = createPurse();
  purse.add(500, 'races');
  purse.add(240, 'taken');
  purse.add(5, 'a stranger on Biscayne Row');      // unregistered: `other`, not lost
  const s = purse.snapshot();
  assert.equal(s.cash, 745);
  assert.equal(s.earned.races, 500);
  assert.equal(s.earned.taken, 240);
  assert.equal(s.earned.other, 5, 'an unknown source was thrown away');
  assert.equal(s.best, 500, 'the best haul is the biggest single pile, not the balance');
});

test('a purse cannot go below empty, and only what was there is lost', () => {
  const purse = createPurse({ cash: 12 });
  assert.equal(purse.lose(40), 12);
  assert.equal(purse.cents, 0);
  assert.equal(purse.lose(5), 0, 'a shakedown of an empty wallet was reported as money');
  assert.ok(purse.empty);
});

test('a pile of cash is how a man folds it', () => {
  const { bills, coins, notes } = breakdown(1234.56);
  assert.equal(coins, 56);
  let sum = coins / 100;
  for (const b of bills) sum += b.value;
  assert.equal(Math.round(sum * 100), 123456, `the parts add up to ${sum} instead of the wallet`);
  assert.equal(notes, 18);
  const descending = bills.every((b, i) => i === 0 || b.denom < bills[i - 1].denom);
  assert.ok(descending, 'bills were not counted out largest first');
  // Greedy in the only sense that matters at a counter: no denomination could be swapped for a bigger one.
  for (const b of bills) {
    const bigger = DENOMS[DENOMS.indexOf(b.denom) - 1];
    if (bigger === undefined) continue;
    assert.ok(b.count < bigger / b.denom, `${b.count} ${b.denom}s should have been ${bigger}s`);
  }
  assert.deepEqual(breakdown(0).bills, [], 'an empty wallet had bills in it');
});

test('money reads the way a shop front paints it', () => {
  assert.equal(formatCash(0), '$0');
  assert.equal(formatCash(1), '$1');
  assert.equal(formatCash(1.5), '$1.50');
  assert.equal(formatCash(1234), '$1,234');
  assert.equal(formatCash(1234.06), '$1,234.06');
  assert.equal(formatCash(-20), '-$20');
  assert.equal(formatCash(1234567.891), '$1,234,567.89');
});

test('a till pays what the kind of shop takes in, and never more than it holds', () => {
  let rng = 0.5;
  const fixed = () => (rng = (rng * 9301 + 49297) % 233280 / 233280);
  for (const kind of ['convenience', 'grocery', 'liquor', 'pawn']) {
    const taken = tillFor(kind, fixed, { day: 1 });
    assert.ok(taken > 0, `the ${kind} till was empty`);
    assert.ok(taken <= 900 + 1, `the ${kind} till held ${taken}, which is more than any of them takes`);
    assert.ok(tillFor(kind, fixed, { day: 0 }) <= taken, 'an early morning paid out more than closing time');
  }
  assert.equal(tillFor('grocery', () => 0.5, { till: 30 }), 30, 'a till of thirty paid out more than thirty');
});

test('the purse keeps itself, where there is somewhere to keep it', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const a = createPurse({ storage, cash: 4 });
  a.add(201);
  const b = createPurse({ storage });
  assert.ok(b.load(), 'a saved purse was not found');
  assert.equal(b.cash, 205);
  // A storage that throws (a private window) is a purse with no memory, not a broken game.
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const c = createPurse({ storage: broken, cash: 3 });
  assert.equal(c.load(), false);
  c.add(10);
  assert.equal(c.cash, 13);
});
