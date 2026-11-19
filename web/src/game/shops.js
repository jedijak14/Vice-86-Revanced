// Shopfronts, and what happens when a man walks up to one.
//
// A 1986 street is a row of places you can buy things in, and this city draws them as facades: painted
// windows, a fascia, and nothing behind. Two things follow. The plan's lots are indexed for the ones that
// have a till — a shop_row, a strip mall, a diner — and each gets a *door*, found by walking out from the
// lot's face until the field says pavement, which is how a frontage is recognised rather than guessed.
// Then the loop at the door is owned here: what a bag costs, what a till holds, what it takes to empty one,
// and what the street does about it.
//
// A hold-up is a transaction with three parties, so all three are settled here in numbers and never in
// pixels: the purse (game/money.js) takes what was in the drawer, the record (game/wanted.js) takes the
// charge, and the crowd (game/crowd.js) is frightened by what it saw. The till is the clock's business too:
// a drawer at nine in the morning is not a drawer at closing time, which is the one thing about a shop that
// makes the hour worth watching. The room itself is world/shops/interior.js, and the renderer's half of it
// is game/shoproom.js — whoever opens a door hands the room to that, and this file never looks at one.

import { TILL_RANGE, formatCash } from './money.js';
import { ROOM, TILL } from '../world/shops/interior.js';

/** Archetypes with a till, listed as often as they should be drawn: a shop_row is mostly a corner store. */
export const STOREFRONTS = Object.freeze({
  shop_row: ['convenience', 'convenience', 'liquor', 'grocery'],
  deco_shop: ['convenience', 'liquor', 'pawn'],
  strip_mall: ['grocery', 'convenience', 'pawn'],
  diner: ['diner'],
  gas_station: ['convenience', 'diner'],
  gun_store: ['gun'],
  dealership: ['dealership'],
});

/**
 * What each kind of shop is, sells, and holds behind the counter.
 * `hours` is [open, close) on the clock's dial, and a close past 24 is a shop that shuts in the morning;
 * `price` is the bag of things you came in for; `take` is the share of the drawer a hold-up walks off with;
 * `goods` is the shelf, which is where a purse becomes a gun or a magazine.
 */
export const SHOPS = Object.freeze({
  convenience: {
    name: 'Corner Store', sign: 'OPEN 24 HRS', hours: [0, 24], price: 6, take: 0.34,
    goods: [{ label: 'a bag of sandwiches', cash: 6, wind: 1 }, { label: 'a hot dog', cash: 3, wind: 0.5 }],
  },
  grocery: {
    name: 'Paloma Market', sign: 'OPEN 7-10', hours: [7, 22], price: 18, take: 0.3,
    goods: [{ label: 'a sack of groceries', cash: 18, wind: 1 }, { label: 'two dozen eggs', cash: 7, wind: 0.6 }],
  },
  liquor: {
    name: 'Bottles & Cases', sign: 'OPEN 10-2', hours: [10, 26], price: 14, take: 0.42,
    goods: [{ label: 'a six-pack', cash: 14, wind: 0.4 }, { label: 'a bottle of rye', cash: 26, wind: 0.3 }],
  },
  pawn: {
    name: 'Gold & Guns', sign: 'OPEN 9-6', hours: [9, 18], price: 40, take: 0.55,
    goods: [
      { label: 'a box of shells', cash: 60, ammo: 24 },
      { label: 'a 12-gauge', cash: 520, weapon: 'shotgun' },
      { label: 'a machine pistol', cash: 940, weapon: 'smg' },
    ],
  },
  diner: {
    name: 'Chrome Diner', sign: 'OPEN ALL NIGHT', hours: [0, 24], price: 9, take: 0.26,
    goods: [{ label: 'breakfast, two eggs', cash: 9, wind: 1 }, { label: 'bottomless coffee', cash: 2, wind: 0.3 }],
  },
  // Gator Arms: the counter where a purse becomes a gun. The shelf is the weapon table the street
  // already carries (game/weapons.js), priced so that the short .38 is an afternoon's takings and the
  // rifle is a career of them.
  gun: {
    name: 'Gator Arms', sign: 'GUN SHOP \u00b7 OPEN 9-9', hours: [9, 21], price: 30, take: 0.6,
    goods: [
      { label: 'a box of shells', cash: 60, ammo: 24 },
      { label: 'a short .38', cash: 340, weapon: 'pistol' },
      { label: 'a 12-gauge', cash: 520, weapon: 'shotgun' },
      { label: 'a machine pistol', cash: 940, weapon: 'smg' },
    ],
  },
  // Sunshine Autos: a forecourt with the cars on it. The counter sells keys and paperwork; the cars
  // themselves are parked on the asphalt and can simply be taken, which the street treats as the theft
  // of a car that somebody was standing next to (game/game.js, the carjack).
  dealership: {
    name: 'Sunshine Autos', sign: 'NEW \u00b7 USED \u00b7 FORECOURT', hours: [8, 19], price: 40, take: 0.5,
    goods: [
      { label: 'the keys to the forecourt car', cash: 2400, wind: 1 },
      { label: 'a can of wax', cash: 12, wind: 0.4 },
    ],
  },
});

/** Seconds of standing on a till with a gun in it before the money is in your hand. */
export const HOLD_SECONDS = 3.6;
/** Metres: how near the till the threat has to reach, and how near the door to be going out by it. */
export const TILL_REACH = 2.2, DOOR_REACH = 2.6;

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const specOf = (kind) => SHOPS[kind] || SHOPS.convenience;

/** Whether a shop of this kind trades at this hour of the clock. */
export function isOpen(kind, hour) {
  const hours = specOf(kind).hours;
  const h = ((hour % 24) + 24) % 24;
  return hours[1] > 24 ? h >= hours[0] || h < hours[1] - 24 : h >= hours[0] && h < hours[1];
}

/**
 * How far into its trading day a shop is: 0 when the door opens and 1 when it shuts, clamped at both ends
 * (a pawn shop at three in the morning still has yesterday's takings in the drawer, and it is shut).
 */
export function tradeProgress(kind, hour) {
  const [open, close] = specOf(kind).hours;
  const span = Math.max(1, close - open);
  let into = ((hour % 24) + 24) % 24 - open;
  if (into < 0) into += 24;
  return clamp01(into / span);
}

/** What the drawer holds at this point of the day, in the shop's own weight of trade. */
export function drawerAt(kind, progress, weight) {
  const range = TILL_RANGE[kind] || TILL_RANGE.grocery;
  return Math.round((range[0] + (range[1] - range[0]) * clamp01(progress)) * weight);
}

/**
 * The four faces of a lot, in the city's own convention: `yaw 0` faces +Z, so the depth runs along
 * (sin yaw, cos yaw) and the width along (cos yaw, -sin yaw).
 */
const FACES = [[0, 1], [0, -1], [1, 1], [1, -1]];

/**
 * Where a lot's door is: the face whose frontage turns out to be pavement, and the point on it just clear
 * of the wall. A face that runs at a road, a car park or the sea is not a frontage, and a lot with no
 * frontage at all has no door and is not a shop.
 * @param {object} lot      {x, z, yaw, width, depth}
 * @param {(x: number, z: number) => {kind: string}} field  the plan's answer at a point
 */
export function findDoor(lot, field) {
  if (typeof field !== 'function') return null;
  const cos = Math.cos(lot.yaw), sin = Math.sin(lot.yaw);
  let best = null;
  for (const [axis, side] of FACES) {
    const nx = (axis ? cos : sin) * side, nz = (axis ? -sin : cos) * side;
    const half = (axis ? lot.width : lot.depth) / 2;
    for (let step = 0.8; step <= 11; step += 0.6) {
      const kind = field(lot.x + nx * (half + step), lot.z + nz * (half + step)).kind;
      // A frontage meets the pavement, and the kerb counts: a shop whose forecourt is a car park is a shop
      // you cross a car park to, which is a different thing and not worth a door.
      if (kind === 'pavement' || kind === 'kerb') {
        if (!best || step < best.reach) {
          best = { reach: step, x: lot.x + nx * (half + 0.2), z: lot.z + nz * (half + 0.2), yaw: Math.atan2(nx, nz) };
        }
        break;
      }
      if (kind === 'water' || kind === 'road' || kind === 'junction' || kind === 'bridge') break;
    }
  }
  return best;
}

/**
 * Indexes a plan's storefronts. `limit` keeps the whole city from being shopped: the first `limit` doors
 * the plan offers, in the order the streets were laid out in.
 * @param {object} plan                       planFromData's plan, whose `data` carries the lots
 * @param {{field?: Function, rng?: Function, limit?: number}} [options]
 */
export function indexShops(plan, { field, rng = Math.random, limit = 140 } = {}) {
  const lots = (plan && (plan.lots || (plan.data && plan.data.lots))) || [];
  const list = [];
  for (const lot of lots) {
    const kinds = STOREFRONTS[lot.archetype];
    if (!kinds) continue;
    const door = findDoor(lot, field);
    if (!door) continue;
    const kind = kinds[Math.min(kinds.length - 1, Math.floor(rng() * kinds.length))];
    const spec = specOf(kind);
    list.push({
      id: list.length, kind, name: spec.name, sign: spec.sign, hours: spec.hours, price: spec.price,
      take: spec.take, goods: spec.goods, lot, x: door.x, z: door.z, yaw: door.yaw,
      // How busy this counter is, drawn once: the corner store that never sells anything is a shop the
      // street has forgotten, and a till that grows every frame at random is not a till but a slot machine.
      weight: 0.7 + 0.6 * rng(), progress: -1, till: 0, taken: 0, sales: 0, robbed: 0,
    });
    if (list.length >= limit) break;
  }
  return list;
}

/**
 * The shop at a door, and the transaction it is in.
 * @param {{
 *   plan?: object, field?: Function, rng?: Function, list?: object[],
 *   purse?: object,          game/money.js's purse
 *   wanted?: object,         game/wanted.js's ledger
 *   crowd?: object,          game/crowd.js
 *   gun?: object,            game/weapons.js
 *   toast?: (text: string) => void,
 *   onEnter?: (shop) => void, onExit?: (shop) => void,
 *   onAlarm?: (shop, stars) => void, onBuy?: (shop, good) => void,
 * }} deps
 */
export function createShops(deps = {}) {
  const rng = typeof deps.rng === 'function' ? deps.rng : Math.random;
  const purse = deps.purse || null, wanted = deps.wanted || null, crowd = deps.crowd || null;
  const gun = deps.gun || null;
  const toast = deps.toast || (() => {});
  const list = deps.list || indexShops(deps.plan, { field: deps.field, rng, limit: deps.limit });
  /** The room the player is standing in, and how far the threat has gone. */
  let inside = null, hold = 0, bought = 0;

  const near = (a, b, x, z, radius) => Math.hypot(x - a, z - b) <= radius;
  const stock = (shop) => shop.goods.slice().sort((a, b) => a.cash - b.cash).find((g) => !purse || purse.canPay(g.cash)) || null;

  const shops = {
    list,
    get count() { return list.length; },

    /** The shop whose door is nearest this point, or null. Metres: a door is found from the pavement. */
    nearest(x, z, radius = 7) {
      let best = null, bd = radius;
      for (const s of list) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < bd) { bd = d; best = s; }
      }
      return best;
    },

    /**
     * The tills, once a second: the drawer fills through the trading day, and when the day turns over the
     * takings go to the bank and the shop starts empty again. Returns how many tills changed, which is what
     * a caller that wants to say something about a full drawer has to go on.
     */
    trade(hour) {
      let moved = 0;
      for (const s of list) {
        const p = tradeProgress(s.kind, hour);
        if (p + 1e-6 < s.progress) { s.taken = 0; s.sales = 0; s.robbed = 0; }
        s.progress = p;
        const till = Math.max(0, drawerAt(s.kind, p, s.weight) - s.taken + s.sales);
        if (till !== s.till) { s.till = till; moved++; }
      }
      return moved;
    },

    get inside() { return inside; },
    get holding() { return inside && hold > 0; },
    get progress() { return inside && hold > 0 ? 1 - hold / HOLD_SECONDS : 0; },

    /** What E means here, from where he is standing in the room (the room's own frame, not the world's). */
    offer(shop, at) {
      if (!shop) return null;
      if (!inside) return isOpen(shop.kind, at.hour) ? { action: 'enter', label: 'go in' } : { action: 'closed', label: 'closed' };
      // Where the door and the till are is the room's business (world/shops/interior.js), and the room is
      // the same shape behind every shopfront, so the anchors are the set's own rather than copies of them.
      if (near(0, ROOM.depth / 2, at.x, at.z, DOOR_REACH)) return { action: 'leave', label: 'back out' };
      if (near(TILL.x, TILL.z, at.x, at.z, TILL_REACH)) {
        if (shop.robbed || !isOpen(shop.kind, at.hour)) return { action: 'buy', label: `pay for a bag · ${formatCash(shop.price)}` };
        return gun && gun.armed
          ? { action: 'rob', label: `empty the till · ${formatCash(shop.till)} in the drawer` }
          : { action: 'buy', label: `pay for a bag · ${formatCash(shop.price)}` };
      }
      const good = stock(shop);
      return good ? { action: 'goods', label: `${good.label} · ${formatCash(good.cash)}` } : { action: 'leave', label: 'the counter' };
    },

    /**
     * The press of the key: one thing done, one line said.
     * @param {object} shop
     * @param {{x: number, z: number, hour: number}} at  where the man stands, in the room's own frame
     */
    press(shop, at) {
      if (!shop) return false;
      const offer = shops.offer(shop, at);
      if (!offer) return false;
      switch (offer.action) {
        case 'enter':
          inside = shop; hold = 0; bought = 0;
          if (deps.onEnter) deps.onEnter(shop);
          return true;
        case 'leave':
          return shops.leave();
        case 'closed':
          toast('Shut. There is a light on inside and nobody coming to the door');
          return true;
        case 'rob':
          hold = HOLD_SECONDS;
          toast('The clerk has his hands up and the drawer is open');
          return true;
        case 'buy': {
          const price = shop.price;
          if (purse && !purse.canPay(price)) { toast(`A bag costs ${formatCash(price)} and you have ${formatCash(purse.cash)}`); return true; }
          if (purse) purse.pay(price, 'shops');
          shop.sales += Math.round(price * 0.7);        // his sale is part of tomorrow's drawer
          shop.till += Math.round(price * 0.7);
          bought++;
          toast(`Bought a bag · ${formatCash(price)}`);
          if (deps.onBuy) deps.onBuy(shop, { label: 'a bag', cash: price, wind: 1 });
          return true;
        }
        case 'goods': {
          const good = stock(shop);
          if (!good) { toast('Nothing on the counter you can pay for'); return true; }
          if (purse) purse.pay(good.cash, 'shops');
          bought++;
          if (good.ammo && gun && gun.issue) gun.issue(good.ammo);
          if (good.weapon && gun) gun.equip(good.weapon);
          if (shop.kind === 'pawn') { shop.sales += Math.round(good.cash * 0.55); shop.till += Math.round(good.cash * 0.55); }
          if (deps.onBuy) deps.onBuy(shop, good);
          toast(good.weapon ? `He wraps it in newspaper · ${good.label}` : `${good.label.charAt(0).toUpperCase()}${good.label.slice(1)} · ${formatCash(good.cash)}`);
          return true;
        }
        default:
          return true;
      }
    },

    /** Back out into the street, whoever is asking — the door, or the world telling him the shop is closed. */
    leave() {
      if (!inside) return false;
      const shop = inside;
      inside = null; hold = 0;
      if (deps.onExit) deps.onExit(shop);
      return true;
    },

    /**
     * The room's own clock: a hold-up being stood through, and nothing else.
     * @param {number} dt      seconds of game time
     * @param {boolean} [keeping] whether the gun is still on the counter; false is a change of mind
     * @returns {string|null}  a line to say when something finished, null while it is merely going on
     */
    step(dt, keeping = true) {
      if (!inside) return null;
      if (hold <= 0) return null;
      if (!keeping) {
        hold = Math.max(0, hold - dt * 2.5);
        return hold === 0 ? 'He puts the gun away. The till stays shut' : null;
      }
      hold -= dt;
      if (hold > 0) return null;
      const shop = inside;
      const dollars = Math.max(0, Math.round(shop.till * shop.take));
      shop.taken += shop.till; shop.till = 0; shop.robbed = 1;
      if (purse) purse.add(dollars, 'taken');
      if (wanted) wanted.add('shop held up');
      // The street hears a hold-up through the door rather than through the wall: the people on the
      // pavement in front of it are the ones who see a man come out with a rolled-up wad.
      if (crowd) crowd.frighten(shop.x, shop.z, 30, 1);
      if (deps.onAlarm) deps.onAlarm(shop, wanted ? wanted.stars : 0);
      return dollars > 0 ? `The drawer, the register tape and ${formatCash(dollars)} in bills` : 'An empty till and a bell over the door';
    },

    /** What the HUD says about this room, in one line. */
    snapshot() {
      return { inside: inside ? inside.name : null, holding: hold > 0, progress: shops.progress, bought };
    },
  };
  return shops;
}
