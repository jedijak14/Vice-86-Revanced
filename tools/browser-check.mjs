#!/usr/bin/env node
// Browser check for the vendored release plus the police work: boots the page in headless
// Chromium, drives it, and reports what the game says about itself. It is a soak of the *whole*
// page (module graph, workers, shaders, tile streaming, HUD) rather than of one module: the Node
// tests under test/ cover the dispatch's judgements.
//
//   node tools/browser-check.mjs --url=http://127.0.0.1:5173 --minutes=6 --heat=2
//
// Options:
//   --url      base of the served page (default http://127.0.0.1:5173)
//   --minutes  how long to watch (default 4)
//   --heat     order an incident after a minute of driving, 1..3; 0 leaves the game alone
//   --traffic  the traffic setting 0..3 (default 2)
//   --race     0 to leave the street races alone, 1 to start one (default 1)
//   --drive    1 to keep the car moving and steering for the whole check (default 0: drive, brake, stop)
//   --quality  low | medium | high | ultra (default low)
//   --seed     simulation seed (default 7)
//   --chromium path to the Chromium executable (default $CHROMIUM_PATH or /tmp/chromium)
//   --playwright path to a playwright-core module directory (default $PLAYWRIGHT_PATH
//                or /tmp/vice-browser-tools/node_modules/playwright-core)
//   --shot     where to write the final screenshot (default /tmp/vice-police.png)
//   --query    extra query parameters for the page, verbatim (e.g. webgl2=force)
//
// A Linux build of Chromium needs libnss3 and its friends; on a machine without them, point
// LD_LIBRARY_PATH at a directory that holds them (the @sparticuz/chromium package ships them in
// its al2023 archive). Nothing here downloads anything.
//
// Exits 1 if the page reported an error, 2 if the harness itself failed, 0 otherwise. A page that
// never reached the driving phase is an error too.

import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const base = opt('url', 'http://127.0.0.1:5173');
const minutes = Math.max(0.5, Number(opt('minutes', 4)) || 4);
const heat = Math.max(0, Math.min(3, Number(opt('heat', 2)) || 0));
const traffic = Math.max(0, Math.min(3, Number(opt('traffic', 2)) || 0));
const quality = opt('quality', 'low');
const seed = Number(opt('seed', 7)) | 0;
const race = Math.max(0, Math.min(1, Number(opt('race', 1)) | 0));
const drive = Math.max(0, Math.min(1, Number(opt('drive', 0)) | 0));
/** Walk on the pavement at the end of the check (--foot=1): out of the car, a run, a magazine, back in. */
const footOn = Math.max(0, Math.min(1, Number(opt('foot', 0)) | 0)) === 1;
const executablePath = opt('chromium', process.env.CHROMIUM_PATH || '/tmp/chromium');
const shot = opt('shot', '/tmp/vice-police.png');
/** Raw extra query parameters, for flags the harness has no option of its own for: --query=webgl2=force */
const query = opt('query', '');
/** Put the street at an hour of its own before the soak: `--time=night` is how a lighting pass sees what the
 *  city does after ten o'clock without waiting an hour for the clock to get there. */
const hourWanted = opt('time', '');
const require = createRequire(import.meta.url);
const pwPath = opt('playwright', process.env.PLAYWRIGHT_PATH || '/tmp/vice-browser-tools/node_modules/playwright-core');
const { chromium } = require(pwPath);

// SwiftShader: the software GL that ships with Chromium, which is what a container without a GPU
// has. `--enable-unsafe-swiftshader` is what lets WebGL 2 be created on it at all.
const ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', '--mute-audio', '--hide-scrollbars',
];

const t0 = Date.now();
let wallSeconds = 0;            // real time the page was live, for the street-clock comparison above
const log = (...a) => console.log(`+${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);

const browser = await chromium.launch({ executablePath, args: ARGS });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [], warnings = [], failedRequests = [], badResponses = [];
let raceStarted = false;        // so a board with nobody on it can be complained about at the end
let lastRaceBoard = null, raceSeenOnce = false;
let raceTimedButScoredNothing = false;   // and so can one that is running but crediting nothing
page.on('pageerror', (e) => errors.push(`pageerror: ${e && e.stack ? String(e.stack).split('\n').slice(0, 2).join(' | ') : e}`));
page.on('console', (m) => {
  const text = `${m.type()}: ${m.text()}`;
  if (m.type() === 'error') errors.push(text);
  else if (m.type() === 'warning') warnings.push(text);
});
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure() && r.failure().errorText}`));
page.on('response', (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

const url = `${base}/index.html?autostart=1&traffic=${traffic}&quality=${quality}&seed=${seed}&mute=1${query ? `&${query}` : ''}`;
log('opening', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

const read = () => page.evaluate(() => {
  const hud = document.querySelector('.hud__police');
  const p = window.__vice.police();
  const s = window.__vice.stats();
  const stars = document.querySelectorAll('.hud__star.is-on').length;
  const row = document.querySelector('.hud__row.is-on');
  const race = window.__vice.race ? window.__vice.race() : null;
  const board = race && race.board;
  return {
    phase: window.__vice.phase,
    ready: window.__vice.ready,
    errors: window.__vice.errors.length,
    engine: window.__vice.engine,
    car: window.__vice.car(),
    police: p,
    hud: hud ? { text: hud.textContent.trim(), on: hud.classList.contains('is-on'), pips: stars } : null,
    engineLine: (() => { const n = document.querySelector('.wordmark__engine'); return n ? n.textContent.trim() : null; })(),
    stats: { fps: s.fps, traffic: s.traffic, parked: s.parked, tiles: s.tilesLoaded, pending: s.tilesPending, street: s.streetSeconds,
      onFoot: s.onFoot, cash: s.cash, gun: s.gun, foot: s.foot },
    hudLine: ['mission', 'race', 'crew', 'purse', 'foot'].reduce((out, n) => {
      const e = document.querySelector(`.hud__${n}-text`);
      if (e && e.textContent.trim()) out[n] = e.textContent.trim();
      return out;
    }, {}),
    gpu: s.renderer || s.gpu || null,
    // The street's own population and the record, both read from the game rather than the DOM, plus
    // what the HUD actually rendered: a row that never lights up is a feature that does not exist.
    wanted: window.__vice.wanted ? window.__vice.wanted() : null,
    crowd: window.__vice.crowd ? window.__vice.crowd() : null,
    hudStars: stars,
    hudStarTotal: document.querySelectorAll('.hud__star').length,
    hudRow: row ? row.textContent.trim() : '',
    hudRows: [...document.querySelectorAll('.hud__row')].filter((e) => e.classList.contains('is-on')).length,
    race: board ? { active: board.active, finished: board.finished, gates: board.total, passed: board.passed, ms: board.elapsedMs, name: board.name, field: board.field, running: board.running, offer: race.offer ? race.offer.tier.name : null } : null,
  };
});

let reached = false;
try {
  await page.waitForFunction(() => window.__vice && window.__vice.phase === 'driving' && window.__vice.car(), null, { timeout: 300_000, polling: 500 });
  reached = true;
} catch {
  errors.push('the game never reached the driving phase');
}

if (reached && hourWanted) {
  const moved = await page.evaluate((name) => {
    if (!window.__vice || !window.__vice.setTime) return null;
    const ok = window.__vice.setTime(name);
    const s = window.__vice.shop ? window.__vice.shop() : null;      // the shop report carries the hour
    return { ok, hour: s ? s.hour : null };
  }, hourWanted);
  log('time', `--time=${hourWanted}: ${moved && moved.hour !== null ? `the street is at ${moved.hour.toFixed(1)} h` : `the hour did not move (${JSON.stringify(moved)})`}`);
}

let peak = 0, officers = 0, ordered = false, last = '';
let raced = false, raceRead = false, driveStep = 0;
const driveOn = drive > 0;
const raceOn = race > 0;
let since0 = 0;
const deadline = t0 + minutes * 60_000;
while (Date.now() < deadline && reached) {
  const s = await read();
  wallSeconds = (Date.now() - t0) / 1000;
  const p = s.police;
  if (p) {
    peak = Math.max(peak, p.heat);
    officers = Math.max(officers, p.officers);
    const near = p.units.length ? Math.min(...p.units.map((u) => Math.hypot(u.position[0] - s.car.position[0], u.position[2] - s.car.position[2]))) : -1;
    const line = `heat ${p.heat} ${p.mode}, ${p.responding}/${p.units.length} responding, ${p.officers} on foot, nearest unit ${Math.round(near)} m, ${s.stats.traffic} cars, ${Math.round(s.car.speed * 3.6)} km/h, hud "${s.hud && s.hud.text}" ${s.hud && s.hud.on ? 'on' : 'off'}`;
    if (line !== last) { last = line; log(line); }
  }
  // A race is taken from the kerb, so the check has to be standing where one can be laid: the game
  // refreshes the offer about once a second of driving, and the start uses whatever it found.
  if (!raced && raceOn && since0 > 90_000) {
    const offer = await page.evaluate(() => window.__vice.race().offer);
    if (offer) {
      raced = true;
      log('starting a street race:', offer.tier && offer.tier.name);
      raceStarted = true;
      await page.evaluate((tier) => window.__vice.startRace(tier), (offer.tier && offer.tier.id) || 'local');
    } else if (since0 > 150_000) {
      raced = true;
      errors.push('the street never offered a race from the kerb');
    }
  }
  // While a race is live the board is read every poll: one sample at an arbitrary moment cannot tell a
  // clock that is running from a meeting that is stuck on its countdown, and a stuck countdown is exactly
  // what a single "active: true" looks like from the outside.
  if (raced && since0 > 150_000 && (raceRead || !raceSeenOnce)) raceSeenOnce = true;
  if (raced && since0 > 150_000) {
    raceRead = true;
    const b = await page.evaluate(() => window.__vice.race().board);
    log('race board', JSON.stringify({ active: b.active, cd: Math.round(b.countdown * 10) / 10, gates: b.total, passed: b.passed, place: b.place, of: b.field, run: b.running, ms: Math.round(b.elapsedMs), next: b.toNext, last: b.last }));
    if (b.active && b.ms > 8000 && !b.passed) raceTimedButScoredNothing = true;
    if (!b.active && !b.finished && !raceRead) errors.push('the race stopped being a race');
    log('street clock', `wall ${Math.round(since0 / 1000)}s`);
    if (b.active) lastRaceBoard = b;
    else if (lastRaceBoard && lastRaceBoard.active && lastRaceBoard.ms > 8000 && !lastRaceBoard.passed) {
      errors.push(`the race ran for ${Math.round(lastRaceBoard.ms / 1000) + 's and credited nothing'}`);
    }
    if (!b.active) { await page.evaluate(() => window.__vice.abortRace()); raceRead = 'done'; }
  }
  if (!ordered && heat > 0 && Date.now() - t0 > 60_000) {
    ordered = true;
    log(`ordering an incident at level ${heat}`);
    await page.evaluate((level) => window.__vice.dispatch(level, 'Check · Patrol car ordered to pull you over'), heat);
  }
  // Throttle, then the brake, then nothing at all: the point is to be seen doing something while
  // an officer can see it, and then to sit still with a unit behind you, which is the shape of a
  // traffic stop. Holding the brake any longer would drive the car backwards out of its own stop.
  // With --drive the car is kept moving for the whole check, and steered in long sweeps: a moving car
  // is the only way the crowd gets close enough to grow limbs, and the only way a street race, a red
  // light and a speeding charge can happen by themselves rather than being ordered.
  const since = Date.now() - t0;
  since0 = since;
  if (driveOn) driveStep = (driveStep + 1) % 240;
  const steer = driveOn ? (driveStep < 70 ? 0.55 : driveStep < 150 ? -0.7 : 0) : 0;
  const pedal = driveOn
    ? { throttle: 0.9, steer }
    : since < 45_000 ? { throttle: 1 } : since < 75_000 ? { brake: 0.7 } : null;
  await page.evaluate((axis) => window.__vice.input(axis), pedal);
  await page.waitForTimeout(1_500);
}
await page.evaluate(() => window.__vice.input(null));

// ---- the man on the pavement (--foot=1): out of the car, a run down it, a magazine emptied and reloaded.
// The same page, the same camera, no restart: if walking is going to break the drive, it breaks here, and
// if the walker never moves this is where it shows — a unit test has no world in it and no GLB on disk.
if (footOn && reached) {
  const at = () => page.evaluate(() => window.__vice.stats());
  const spot = (s) => (s.foot && s.foot.pos ? [s.foot.pos[0], s.foot.pos[2]] : null);
  // A man steps out of a stopped car, so bring the car to a stop first — and on a machine this slow that
  // takes longer than it looks: the street is given a fifth of a second per wall second here.
  await page.evaluate(() => window.__vice.input({ brake: 1 }));
  for (let i = 0; i < 14; i++) {
    const s = await page.evaluate(() => window.__vice.car());
    if (s && Math.abs(s.speed) < 0.4) break;
    await page.waitForTimeout(1_500);
  }
  await page.evaluate(() => window.__vice.input(null));
  // Then wait for the street to be showing: a scene change is a fade, and a fade swallows a key on purpose.
  for (let i = 0; i < 30; i++) {
    const s = await at();
    if (s.transition === 'none') break;
    await page.waitForTimeout(1_500);
  }
  await page.waitForTimeout(1_000);
  let out = await at();
  // Press until the game answers. A press during a fade is dropped on purpose (the key belongs to the
  // picture the player is watching, not to the one arriving), and on a software renderer a fade takes a
  // minute of wall time, so "press once and look" is a test of timing rather than of walking.
  // Press when the game is idle, wait when it is not: a press during a fade is dropped on purpose, and a
  // soak that counts those drops as attempts learns about the fade rather than about walking. Each try is
  // logged, because "the man never left the car" is worth more with the fade and the hold beside it.
  for (let i = 0; i < 30 && !out.onFoot; i++) {
    const now = await at();
    if (now.transition === 'none') await page.evaluate(() => window.__vice.press('foot'));
    await page.waitForTimeout(2_000);
    out = await at();
    log('foot', `try ${i + 1}: transition ${out.transition}, dark for ${out.transitionHeld}s, fade ${out.frameFade}, pending ${out.transitionBusy}, onFoot ${out.onFoot} · frame ${out.frames}, dt ${out.pacedDt}s real ${out.realDt}s sim ${out.simDt}s, street ${out.streetSeconds}s`);
  }
  const pageErrors = await page.evaluate(() => window.__vice.errors.map((e) => String(e).slice(0, 200)));
  log('foot', `press answered: onFoot ${JSON.stringify(out.onFoot)}, transition ${out.transition}, fade ${out.frameFade}, car ${JSON.stringify((await page.evaluate(() => window.__vice.car())).speed)}, foot ${JSON.stringify(out.foot)}, page errors ${pageErrors.length}`);
  if (pageErrors.length) log('foot', 'errors: ' + pageErrors.slice(-3).join(' || '));
  if (!out.onFoot) errors.push('foot: ' + ('the man never left the car (stats.onFoot is false after a press of "foot")'));
  else {
    const before = spot(out);
    await page.evaluate(() => window.__vice.input({ throttle: 1, boost: 1 }));
    for (let i = 0; i < 10; i++) await page.waitForTimeout(1_500);
    const walked = await at();
    const after = spot(walked);
    const metres = before && after ? Math.hypot(after[0] - before[0], after[1] - before[1]) : 0;
    const f = walked.foot || {};
    // Judged against the street's clock, not the wall's: on a software renderer the sim is given a fraction
    // of each frame (game/loop.js refuses to teleport the world after a stall), so fifteen seconds of wall
    // time here can be half a second of walking. Distance per *simulated* second is the honest measure.
    const simSeconds = Math.max(0, (walked.streetSeconds || 0) - (out.streetSeconds || 0));
    const pace = simSeconds > 0 ? metres / simSeconds : 0;
    log('foot', `ran ${metres.toFixed(2)} m in ${simSeconds.toFixed(2)} s of street time (${pace.toFixed(2)} m/s) · state ${f.state} · stamina ${Math.round((f.stamina || 0) * 100)}% · body ${f.body ? 'drawn' : 'none'} · near ${f.near === null || f.near === undefined ? 'nothing' : `${f.near} m`}`);
    if (simSeconds < 0.3) warnings.push(`the street gave the walker only ${simSeconds.toFixed(2)} s of clock, which is too little to measure a pace on`);
    else if (!(pace > 0.9)) errors.push('foot: ' + (`the walker covered ${metres.toFixed(2)} m in ${simSeconds.toFixed(2)} s of running (${pace.toFixed(2)} m/s): the feet do not move the man`));
    // The trigger, held: the gun's own cooldown is what sets the pace, until the magazine is gone.
    await page.evaluate(() => window.__vice.input({ handbrake: 1 }));
    for (let i = 0; i < 6; i++) await page.waitForTimeout(1_500);
    const firing = await at();
    const g0 = firing.gun || {};
    const wantedAfter = await page.evaluate(() => (window.__vice.wanted ? window.__vice.wanted() : null));
    log('gun', `${g0.shots} shots · ${g0.magazine} left in the magazine · ${g0.hits} struck · state ${g0.state} · stars ${wantedAfter && wantedAfter.stars}`);
    if (!(g0.shots > 0)) errors.push('gun: ' + ('the trigger was held on the pavement and the gun never fired (gun.shots stayed 0)'));
    if (g0.shots > 0 && !(wantedAfter && wantedAfter.points > 0)) errors.push('gun: ' + ('shots were fired and the wanted record never heard about it'));
    // Reload, then back into the car: the handover has to work in both directions.
    await page.evaluate(() => window.__vice.input(null));
    await page.evaluate(() => window.__vice.press('recover'));
    for (let i = 0; i < 4; i++) await page.waitForTimeout(1_500);
    const reloaded = await at();
    log('gun', `after R: ${reloaded.gun.magazine}/${reloaded.gun.reserve} · state ${reloaded.gun.state} · the pocket says ${reloaded.cash}`);
    if (reloaded.gun.magazine <= g0.magazine) errors.push('gun: ' + (`R did not move a magazine: it went from ${g0.magazine} to ${reloaded.gun.magazine}`));
    // A door: the room has to go up on the same frame the man arrives in it, so this is where a mistake in
    // the interior plumbing shows — a bad mesh, a light list the renderer refused, a room the camera is lost in.
    let door = await page.evaluate(() => window.__vice.shop());
    // A soak ends where the drive ended, and the drive does not know about shops. So if nothing is within
    // sight of the kerb he stopped on, take the closest door the island has and put his feet beside it: a
    // check that only runs when the parking was lucky is a check on the parking, not on the plumbing.
    if (door && door.onFoot && !door.name) {
      const far = await page.evaluate(() => (window.__vice.nearestShop ? window.__vice.nearestShop() : null));
      if (far && Number.isFinite(far.x) && Number.isFinite(far.z)) {
        log('shop', `no door within sight; the nearest is ${far.name} at ${far.metres} m (${far.open ? 'open' : 'shut'})`);
        await page.evaluate(([x, z]) => window.__vice.walkTo(x, z), [far.x, far.z]);
        await page.waitForTimeout(1_500);
        door = await page.evaluate(() => window.__vice.shop());
      }
    }
    if (!door || !door.count) warnings.push('there is no shop on the island to walk into (shops.count was 0)');
    else if (!door.onFoot) warnings.push('foot: the man was back in the car before the door could be tried');
    else {
      await page.evaluate(([x, z]) => window.__vice.walkTo(x, z), [door.x, door.z]);
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.__vice.press('shop'));
      let gone = null;
      for (let i = 0; i < 24; i++) {
        gone = await page.evaluate(() => window.__vice.shop());
        if (gone && gone.inside) break;
        await page.waitForTimeout(1_500);
      }
      const seen = await at();
      log('shop', `${gone.name} (${gone.kind}, ${gone.action}) · inside ${JSON.stringify(gone.inside)} · room ${gone.room} · offer "${gone.label}" · cash ${seen.cash} · street ${seen.streetSeconds}s in ${seen.frames} frames`);
      if (!gone || !gone.inside) errors.push('shop: ' + (`the door was pressed at ${door.name} and he never got inside (inside ${gone && gone.inside}, transition ${seen.transition}, fade ${seen.frameFade})`));
      else {
        const stats = await page.evaluate(() => window.__vice.stats());
        log('shop', `inside: room ${gone.room}, lights ${gone.lights}, hold ${gone.holding} at ${Math.round((gone.progress || 0) * 100)}%, tiles ${stats.tilesLoaded}, street clock ${(stats.streetSeconds || 0).toFixed(2)} s`);
        await page.evaluate(() => window.__vice.press('shop'));   // and back out the same way he came in
        for (let i = 0; i < 16; i++) {
          const s = await page.evaluate(() => window.__vice.shop());
          if (s && !s.inside) break;
          await page.waitForTimeout(1_500);
        }
        const back = await page.evaluate(() => window.__vice.shop());
        if (back && back.inside) errors.push('shop: ' + 'the door let him in and would not let him out');
        else log('shop', 'back on the pavement');
      }
    }
    const lines = await page.evaluate(() => {
      const grab = (n) => { const e = document.querySelector(`.hud__${n}-text`); return e ? e.textContent.trim() : ''; };
      return { purse: grab('purse'), foot: grab('foot') };
    });
    log('hud', `purse row ${JSON.stringify(lines.purse)} · foot row ${JSON.stringify(lines.foot)}`);
    if (!lines.foot) errors.push('hud: ' + ('the foot row never lit up while the man was on the pavement'));
    await page.evaluate(() => window.__vice.press('foot'));
    await page.waitForTimeout(2_500);
    const backIn = await at();
    if (backIn.onFoot) errors.push('foot: ' + ('he never got back in the car'));
    else log('foot', 'back in the car, and the camera is the chase rig again');
  }
}

const final = reached ? await read() : null;
if (final) {
  log('final', JSON.stringify({ phase: final.phase, ready: final.ready, engine: final.engine, engineLine: final.engineLine, police: final.police && { ...final.police, units: final.police.units.length }, crowd: final.crowd, wanted: final.wanted, hudStars: final.hudStars, hudLine: final.hudLine, hudRow: final.hudRow, race: final.race, hudStarTotal: final.hudStarTotal, hudRows: final.hudRows, hud: final.hud, stats: final.stats }));
  // The title carries the game's mark and nothing else: no renderer credit printed over it. The
  // probe reads the node that used to hold it, so the check fails if it ever comes back.
  if (final.engineLine !== null) bad('wordmark', `the engine is printed on the title again: ${JSON.stringify(final.engineLine)}`);
  const cr = await page.evaluate(() => (window.__vice.crowdRender ? window.__vice.crowdRender() : null));
  if (final.crowd && final.crowd.cast === true && final.crowd.articulated > 0) {
    if (!cr || cr.rendered <= 0) bad('models', `the cast loaded and ${final.crowd.articulated} body/bodies were promoted, but none reached the camera`);
    else if (!(cr.triangles > 0)) bad('models', `${cr.rendered} people were drawn with no triangles at all (crowdRender ${JSON.stringify(cr)})`);
    else log('render', `${cr.rendered} of ${final.crowd.peds} people drawn, ${cr.triangles} triangles, ${final.crowd.bodies} bodies in hand`);
  }
  // The people are a download now: five rigged bodies and a clip library. A page that never got them has
  // an empty pavement and no error to show for it, so this is a hard failure, not a shrug.
  if (final.crowd && final.phase === 'driving') {
    if (final.crowd.cast !== true) bad('models', `the cast never loaded (crowd.cast=${JSON.stringify(final.crowd.cast)}): the pavements are empty`);
    else if (final.crowd.articulated === 0 && final.crowd.peds > 0) bad('models', `${final.crowd.peds} people on the street and not one of them has a body`);
    else if (final.crowd.peds > 0 && final.crowd.bodies < final.crowd.articulated) bad('models', 'a body count below the articulated count means people are being drawn without a person');
  }
  // The street has to be *inhabited*: a crowd of zero at traffic 2 is a bug, not a quiet evening.
  if (final.crowd && traffic > 0 && final.crowd.peds === 0 && final.phase === 'driving') warnings.push(`nobody on the pavements (${JSON.stringify(final.crowd)})`);
  // Limbs are the visible part of the rig: with a moving car and medium quality somebody has to have them.
  if (driveOn && final.crowd && final.crowd.peds > 4 && final.crowd.articulated === 0) warnings.push(`nobody has limbs (${JSON.stringify(final.crowd)})`);
  if (final.crowd && final.crowd.streets === 0) warnings.push('the crowd found no street to walk on');
  if (final.wanted && final.wanted.stars > 0 && final.hudStars === 0 && minutes >= 1) warnings.push(`the ledger says ${final.wanted.stars} stars and the HUD shows none`);
  if (raceTimedButScoredNothing) warnings.push('the race clock ran but no gate was ever credited');
  // The clock first, because almost everything else on this list depends on it. `frame()` is paced, and
  // under a software rasteriser the pacer hands the game very few frames: the street then gets a trickle
  // of simulated time while the wall keeps moving. A countdown that never falls, a crowd with no limbs,
  // a wanted record that never cools and a race that credits no gate are all the same finding, and it is
  // about this machine rather than the game — so it is said here, in one line, before the rest are
  // complained about separately.
  const street = (final.stats && final.stats.street) || 0;
  if (reached && wallSeconds > 60 && street < wallSeconds * 0.2) {
    warnings.push(`this machine gave the street ${street.toFixed(1)}s of simulated time in ${Math.round(wallSeconds)}s of wall`
      + ' — rates (countdowns, cool-off, walk cycles, gate timing) cannot be measured here; prove them in node --test');
  }
  if (lastRaceBoard && lastRaceBoard.active && lastRaceBoard.cd > 0.2 && street > 30) {
    warnings.push(`the meeting never got off its countdown (${lastRaceBoard.cd}s left) with ${street.toFixed(0)}s of street clock`
      + ' — the countdown is not being stepped');
  }
  if (raceStarted && final.race && final.race.field === 1) warnings.push('the race started with no opponents on the grid');
  if (final.hudStarTotal !== 5 && final.hudStarTotal !== 0) warnings.push(`the HUD built ${final.hudStarTotal} star slots`);
  log('peak heat', peak, '| officers out at some point:', officers);
  try {
    // 'allow', not 'disabled': the game loop repaints forever, and waiting for animations to settle while
    // a software renderer needs most of a minute per frame only ever ends in a timeout.
    await page.screenshot({ path: shot, timeout: 600_000, animations: 'allow', caret: 'hide' });
    log('screenshot', shot);
  } catch (error) {
    warnings.push(`screenshot: ${error.message}`);
  }
}

// What the *page* says happened, read before the browser goes away. This is the line that tells a stage that
// stopped answering apart from a stage that was never wired: main.js catches a frame that throws, stops asking
// for frames and writes the stack into `__vice.errors` — after which every press this script sends is answered
// by a world that is no longer moving, which looks exactly like a bug in the thing being pressed.
const pageFaults = await page.evaluate(() => (window.__vice && window.__vice.errors ? window.__vice.errors.map((e) => String(e).slice(0, 400)) : []));
const pagePhase = await page.evaluate(() => (window.__vice && window.__vice.hooks ? window.__vice.hooks.phase : null));
if (pageFaults.length) errors.push(`the page faulted (${pageFaults.length}), phase ${pagePhase}: ${pageFaults.slice(-2).join(' || ')}`);
else if (pagePhase === 'error') errors.push(`the page reported an error phase with nothing in __vice.errors`);
await browser.close();
const report = (name, list) => {
  log(name, list.length);
  list.slice(0, 20).forEach((e) => console.log('   ', e));
};
report('page faults', pageFaults);
report('check failures', errors);
report('404s and worse', badResponses);
report('failed requests', failedRequests);
report('warnings', warnings);
process.exit(errors.length || !reached ? 1 : 0);
