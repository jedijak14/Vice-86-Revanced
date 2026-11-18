// The purse: the money the player is carrying, and what it is good for.
//
// A 1986 Florida street is a place where a man's cash matters in a way it no longer does: no cards in a
// corner store's till, a bottle of milk on the counter for ninety-eight cents, a hold-up paid out in tens and
// twenties off a belt. The release had no wallet at all — you could not be robbed, could not buy, and a race
// won nothing — so the purse is what makes the street's other economy (game/shops.js, game/races.js, the
// garage) worth walking into.
//
// Like everything else in the fork the ledger is arithmetic and nothing more: it draws no text, keeps no DOM
// node and does not know what a till is. `createPurse` is a number with a memory — the memory being where the
// money came from, which is what a stats screen and a police shakedown both read.

/** Bills a Florida till counts in, 1986. Larger notes are not in circulation here. */
export const DENOMS = Object.freeze([100, 50, 20, 10, 5, 1]);
/** What a wallet on a pavement is worth: cash, and the small change a person carries loose. */
export const COINS_PER_NOTE = 0.14;

/**
 * The purse's own persistence. `storage` is the injected one (any getItem/setItem pair), because a test and
 * a browser do not have the same notion of a hard drive, and a private window has neither.
 */
const KEY = 'vice86.purse';

/**
 * Dollars to the string a shop front would paint: a leading sign, and cents only when there are cents,
 * because a till's price is either even or it is not.
 */
export function formatCash(amount) {
  const negative = amount < 0;
  const value = Math.abs(Math.round((+amount || 0) * 100));   // the amount is in dollars
  const dollars = Math.floor(value / 100), cents = value % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${grouped}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
}

/**
 * How a pile of cash lies in a wallet: greedy from the top, which is how a man folds it. `amount` is in
 * dollars; only whole dollars are broken down into bills, and the odd cents ride in the pocket and are
 * reported as `coins`, so the parts add up to the whole rather than being rounded away.
 */
export function breakdown(amount) {
  const cents = Math.max(0, Math.round((+amount || 0) * 100));
  let left = Math.floor(cents / 100);               // whole dollars, the only thing a bill is worth
  const coins = cents % 100;
  const bills = [];
  for (const d of DENOMS) {
    const n = Math.floor(left / d);
    if (n) { bills.push({ denom: d, count: n, value: n * d }); left -= n * d; }
  }
  return { bills, coins, notes: bills.reduce((n, b) => n + b.count, 0) };
}

/** The largest pile of notes a till can hand over, given what the shop takes in a day. */
export function tillFor(kind, rng = Math.random, { day = 1, till = null } = {}) {
  const [lo, hi] = TILL_RANGE[kind] || TILL_RANGE.grocery;
  const cash = (lo + (hi - lo) * clamp01(day)) * (0.7 + 0.6 * rng());
  return till === null ? Math.round(cash) : Math.round(Math.min(till, cash));
}

/** What each counter is worth behind, per day of takings, in dollars. A grocery takes more and pays less. */
export const TILL_RANGE = Object.freeze({
  convenience: [90, 260],
  grocery: [240, 720],
  liquor: [140, 400],
  pawn: [300, 900],
});

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/**
 * @param {{cash?: number, storage?: {getItem: Function, setItem: Function}|null, save?: boolean}} [options]
 *   cash: what the player starts with; storage: where to keep it (null = nowhere, nothing is persisted)
 */
export function createPurse(options = {}) {
  const storage = options.storage === undefined ? null : options.storage;
  const purse = {
    /** Cents. Every number here is an integer: a wallet does not have fractions of a cent. */
    cents: 0,
    /** Where the money came from, in dollars, for the stats screen and a police report. */
    earned: { races: 0, jobs: 0, taken: 0, found: 0, other: 0 },
    spent: { shops: 0, repairs: 0, fines: 0, other: 0 },
    /** The biggest single haul so far — the number a player remembers. */
    best: 0,
    /** Whether the last change was a loss, so the HUD can flash it the right way. */
    lastDelta: 0,
    lastAt: -1,

    /** The purse in dollars, cents and all. Read it, do not cache it. */
    get cash() { return purse.cents / 100; },
    /** Whether there is any reason to be robbed. */
    get empty() { return purse.cents <= 0; },

    /**
     * Puts money in. `source` is one of the keys above (an unknown one lands in `other`, which is how a
     * mission that has not registered its own name still shows up in the ledger rather than vanishing).
     * @param {number} dollars
     * @param {string} [source]
     * @returns {number} what actually arrived, dollars
     */
    add(dollars, source = 'other') {
      const cents = Math.round((+dollars || 0) * 100);
      if (cents <= 0) return 0;
      purse.cents += cents;
      const key = purse.earned[source] === undefined ? 'other' : source;
      purse.earned[key] += cents / 100;
      purse.best = Math.max(purse.best, cents / 100);
      purse.lastDelta = cents / 100;
      purse.changed();
      return cents / 100;
    },

    /**
     * Takes money out, refusing the whole thing if the purse cannot cover it: a counter either pays or it
     * does not, and a purse that goes negative is a debt nobody agreed to.
     * @returns {boolean} whether it was paid
     */
    pay(dollars, purpose = 'other') {
      const cents = Math.round((+dollars || 0) * 100);
      if (!(cents > 0) || cents > purse.cents) return false;
      purse.cents -= cents;
      const key = purse.spent[purpose] === undefined ? 'other' : purpose;
      purse.spent[key] += cents / 100;
      purse.lastDelta = -cents / 100;
      purse.changed();
      return true;
    },

    /** Money a person loses without anyone paying it out (a shakedown, a mugging, a wallet in the water). */
    lose(dollars, purpose = 'fines') {
      const cents = Math.min(purse.cents, Math.round((+dollars || 0) * 100));
      if (!(cents > 0)) return 0;
      purse.cents -= cents;
      const key = purse.spent[purpose] === undefined ? 'other' : purpose;
      purse.spent[key] += cents / 100;
      purse.lastDelta = -cents / 100;
      purse.changed();
      return cents / 100;
    },

    /** Whether the purse could cover a price, for a counter that wants to say no before it takes the order. */
    canPay(dollars) { return Math.round((+dollars || 0) * 100) <= purse.cents; },

    /** What is in the wallet, in bills, for a hold-up that counts it out on the counter. */
    counts() { return breakdown(purse.cents / 100); },

    /** The purse's own numbers, in dollars, for a script or a stats screen. */
    snapshot() {
      return {
        cash: purse.cents / 100, notes: breakdown(purse.cents).notes, best: purse.best,
        earned: { ...purse.earned }, spent: { ...purse.spent },
        lastDelta: purse.lastDelta, lastAt: purse.lastAt,
      };
    },

    changed() {
      if (persist) purse.save();
    },
    /** Writes what the purse holds. Called on every change unless persistence is off. */
    save() {
      if (!storage || typeof storage.setItem !== 'function') return;
      try { storage.setItem(KEY, String(purse.cents)); } catch { /* a private window: the money is for today */ }
    },
    /** @returns {boolean} whether there was something to take up */
    load() {
      if (!storage || typeof storage.getItem !== 'function') return false;
      let raw = null;
      try { raw = storage.getItem(KEY); } catch { return false; }
      const cents = Math.round(+(raw === null || raw === '' ? NaN : raw));
      if (!Number.isFinite(cents) || cents < 0) return false;
      purse.cents = cents;
      return true;
    },
    /** Clears it — a new game, which is also what a corrupted purse degrades to rather than throwing. */
    reset(cash = options.startingCash ?? 0) {
      purse.cents = Math.max(0, Math.round((+cash || 0) * 100));
      purse.earned = { races: 0, jobs: 0, taken: 0, found: 0, other: 0 };
      purse.spent = { shops: 0, repairs: 0, fines: 0, other: 0 };
      purse.best = 0; purse.lastDelta = 0; purse.lastAt = -1;
      purse.changed();
    },
  };
  const persist = options.autosave !== false;
  if (options.cash !== undefined) purse.cents = Math.max(0, Math.round((+options.cash || 0) * 100));
  else if (options.startingCash !== undefined) purse.reset(options.startingCash);
  return purse;
}
