// Shopfronts: which lots become shops, what a door costs, and what a till gives up.
//
// The room is not in here — world/shops/interior.js owns its walls, and whoever opens a door owns its
// meshes. What is tested is the part that decides: which lots have a frontage, what E means at each of the
// three places in a shop, how the drawer fills through the trading day, and what changed in the purse, the
// record and the crowd afterwards.

import test from 'node:test';
import assert from 'node:assert/strict';

import { indexShops, isOpen, tradeProgress, createShops, SHOPS, HOLD_SECONDS } from '../../web/src/game/shops.js';
import { ROOM, TILL } from '../../web/src/world/shops/interior.js';
import { createPurse } from '../../web/src/game/money.js';

/**
 * A street with four lots on it: a row of shops with pavement in front, a strip mall further up the same
 * pavement, a diner whose frontage turns out to be a road and a car park, and a bungalow that was never
 * going to be a shop. The field answers `kind` at a point, the way the plan's does, and `yaw 0` faces +Z —
 * so the pavement band in front of a lot lies at greater z than the lot's own face.
 */
function plan() {
  const lots = [
    { id: 0, x: 0, z: 0, yaw: 0, width: 18, depth: 12, archetype: 'shop_row' },
    { id: 1, x: 0, z: 200, yaw: 0, width: 24, depth: 16, archetype: 'strip_mall' },
    { id: 2, x: 100, z: 0, yaw: 0, width: 16, depth: 14, archetype: 'diner' },
    { id: 3, x: -100, z: 0, yaw: 0, width: 12, depth: 12, archetype: 'bungalow' },
  ];
  const field = (x, z) => {
    if (x > -20 && x < 20 && (z > 6 && z < 12)) return { kind: 'pavement' };
    if (x > -20 && x < 20 && (z > 208 && z < 214)) return { kind: 'pavement' };
    if (x > 80 && x < 120 && z > 6 && z < 40) return { kind: 'road' };
    return { kind: 'lot' };
  };
  return { lots, field };
}

const rng = () => 0.5;
/** A man standing at the till, and one standing in the doorway, in the room's own frame. */
const AT_TILL = { x: TILL.x, z: TILL.z, hour: 12 };
const AT_DOOR = { x: 0, z: ROOM.depth / 2, hour: 12 };
const AT_SHELF = { x: -3, z: 3, hour: 12 };

function harness({ cash = 200, armed = false, hour = 12 } = {}) {
  const plan0 = plan();
  const added = [], toasts = [], buys = [], alarms = [];
  let entered = 0, exited = 0, frightened = 0;
  const purse = createPurse({});
  if (cash) purse.add(cash, 'found');
  const gun = { armed, id: armed ? 'pistol' : null, issued: 0, issue(n) { this.issued += n; return this.issued; } };
  const wanted = { stars: 1, add(cause, amount) { added.push([cause, amount === undefined ? 1 : amount]); return true; } };
  const crowd = { frighten() { frightened++; return 3; }, strike() { return true; } };
  const shops = createShops({
    plan: plan0, field: plan0.field, rng,
    purse, wanted, crowd, gun,
    toast: (text) => toasts.push(text),
    onEnter: () => { entered++; }, onExit: () => { exited++; },
    onAlarm: (shop, stars) => alarms.push([shop.name, stars]),
    onBuy: (shop, good) => buys.push([shop.kind, good.label]),
  });
  shops.trade(hour);
  return {
    shops, purse, gun, added, toasts, buys, alarms, hour,
    get entered() { return entered; }, get exited() { return exited; }, get frightened() { return frightened; },
  };
}

test('a lot is a shop when its frontage turns out to be pavement, and not otherwise', () => {
  const plan0 = plan();
  const list = indexShops(plan0, { field: plan0.field, rng, limit: 40 });
  assert.equal(list.length, 2, 'only the two lots with pavement in front of them have doors');
  const a = list[0];
  // The door is on the shop's own face, not in the middle of the pavement: half the depth, plus a little.
  assert.ok(Math.abs(a.x) < 1e-6, `the door drifted ${a.x} m along the front`);
  assert.ok(a.z > 6 && a.z < 7.5, `the door is at z ${a.z}, which is not on the shopfront`);
  assert.equal(a.yaw, 0, 'a door facing +Z should look down +Z');
  assert.ok(SHOPS[a.kind], `a kind nobody sells: ${a.kind}`);
  assert.ok(a.weight > 0.6 && a.weight < 1.4, `a till with no trade of its own: ${a.weight}`);
  assert.equal(list.some((s) => s.lot.id === 2), false, 'the diner was indexed off its car park');
  assert.equal(list.some((s) => s.lot.id === 3), false, 'a bungalow is not a shop');
});

test('the hours are the shop’s own, and the drawer fills with the trading day', () => {
  assert.equal(isOpen('pawn', 3), false, 'a pawn shop at three in the morning');
  assert.equal(isOpen('pawn', 12), true);
  assert.equal(isOpen('liquor', 1), true, 'a till that shuts at two is open at one');
  assert.equal(isOpen('liquor', 3), false);
  assert.equal(isOpen('convenience', 4), true, 'the corner store is the one that is always open');
  assert.ok(tradeProgress('pawn', 9) < 0.02, 'a pawn shop at opening has been trading all day');
  assert.ok(tradeProgress('pawn', 18) > 0.98, 'and by closing it has taken nothing');
  const h = harness({ hour: 12 });
  const shop = h.shops.list[0];
  const noon = shop.till;
  assert.ok(noon > 0, 'the tills were never filled by the clock');
  assert.equal(h.shops.trade(12), 0, 'the drawer moved on its own while the hour stood still');
  h.shops.trade(23.9);
  assert.ok(shop.till > noon, `a drawer at midnight is not fuller than one at noon (${shop.till} vs ${noon})`);
  // The day turns over for a late shop when its own hour comes round again, not at some other shop's.
  const before = shop.till, robbed = (h.shops.trade(9), shop.robbed = 1, shop.robbed);
  assert.equal(robbed, 1);
  h.shops.trade(10);
  assert.equal(shop.robbed, 0, 'the shop is still marked robbed after its own new day');
  assert.ok(shop.till < before, `the drawer opened the day full (${shop.till} against ${before})`);
});

test('a bag at the counter costs the price, and the till keeps most of it', () => {
  const h = harness({ cash: 200 });
  const shop = h.shops.list[0];
  const before = h.purse.cash;
  assert.equal(h.shops.press(shop, AT_DOOR), true, 'the door did not answer');
  assert.equal(h.shops.inside, shop, 'he never got in');
  assert.equal(h.entered, 1, 'nobody was told he went in');
  const line = h.shops.offer(shop, AT_TILL);
  assert.equal(line.action, 'buy', `unarmed at the till, E means ${line.action}`);
  assert.equal(h.shops.press(shop, AT_TILL), true);
  assert.equal(h.purse.cash, before - shop.price, 'the bag was taken without being paid for');
  assert.ok(h.purse.spent.shops >= shop.price, 'the spend is not in the purse’s ledger');
  assert.ok(shop.till > 0, 'his money did not go into the drawer at all');
  // The bag is a purchase like anything else on the shelf, and it is reported as one: game.js refills the
  // walker's wind from it, which is the only thing a shop can give a man who is not buying a gun.
  assert.equal(h.buys.length, 1, 'the counter did not say what it sold');
  assert.equal(h.buys[0][1], 'a bag');
  assert.equal(h.shops.press(shop, AT_DOOR), true, 'the door did not let him out');
  assert.equal(h.shops.inside, null);
  assert.equal(h.exited, 1, 'leaving was not reported to the game');
});

test('a gun in hand changes what the counter is, and the till is what it pays', () => {
  const h = harness({ cash: 0, armed: true });
  const shop = h.shops.list[0];
  h.shops.press(shop, AT_DOOR);
  const offer = h.shops.offer(shop, AT_TILL);
  assert.equal(offer.action, 'rob', 'armed at the till and the offer is not a hold-up');
  assert.match(offer.label, /\$/, 'the offer does not say what is in the drawer');
  const drawer = shop.till;
  assert.ok(drawer > 0, 'there was nothing in it to take');
  assert.equal(h.shops.press(shop, AT_TILL), true);
  assert.equal(h.shops.step(0.5, true), null, 'the hold-up finished in half a second');
  assert.ok(h.shops.snapshot().holding, 'the threat stopped being held mid-way');
  const line = h.shops.step(HOLD_SECONDS, true);
  assert.ok(line, 'the till never came open');
  const took = Math.round(drawer * shop.take);
  assert.equal(h.purse.cash, took, `the purse got ${h.purse.cash} and not the $${took} that was offered`);
  assert.equal(h.purse.earned.taken, took, 'the money is not marked as taken');
  assert.equal(shop.till, 0, 'an emptied till still has money in it');
  assert.ok(h.added.some(([cause]) => cause === 'shop held up'), 'the record was never told');
  assert.equal(h.alarms.length, 1, 'the alarm was not raised, or was raised twice');
  assert.ok(h.frightened >= 1, 'nobody on the pavement saw it happen');
  // The same counter, immediately after, has nothing left to take.
  assert.equal(h.shops.offer(shop, AT_TILL).action, 'buy', 'a till emptied today is offered again');
});

test('a threat can be stood down, and giving up takes longer than starting', () => {
  const h = harness({ cash: 0, armed: true });
  const shop = h.shops.list[0];
  h.shops.press(shop, AT_DOOR);
  h.shops.press(shop, AT_TILL);
  assert.equal(h.shops.step(0.2, false), null, 'a holstered gun ended it in one frame');
  const said = h.shops.step(HOLD_SECONDS * 4, false);
  assert.match(String(said), /gun away/, 'giving up was not said out loud');
  assert.equal(h.purse.cash, 0, 'he took the till after all');
  assert.ok(shop.till > 0, 'the drawer was emptied by a hold-up that never happened');
});

test('the shelf behind the counter sells the cheapest thing he can afford', () => {
  const h = harness({ cash: 70 });
  const pawn = Object.assign(h.shops.list[0], {
    kind: 'pawn', name: SHOPS.pawn.name, price: SHOPS.pawn.price, take: SHOPS.pawn.take,
    goods: SHOPS.pawn.goods, hours: SHOPS.pawn.hours,
  });
  h.shops.trade(12);
  h.shops.press(pawn, AT_DOOR);
  const line = h.shops.offer(pawn, AT_SHELF);
  assert.equal(line.action, 'goods', `at the shelves the offer is ${line.action}`);
  assert.match(line.label, /\$60/, 'a purse of $70 was offered something it cannot pay for');
  assert.equal(h.shops.press(pawn, AT_SHELF), true);
  assert.equal(h.gun.issued, 24, 'the shells never went in the bag');
  assert.equal(h.purse.cash, 10, `the box of shells cost ${70 - h.purse.cash}`);
  // Now the only thing left on the shelf is what he cannot afford, and the counter offers him the door.
  assert.equal(h.shops.offer(pawn, AT_SHELF).action, 'leave', 'he was offered a 12-gauge he cannot buy');
});
