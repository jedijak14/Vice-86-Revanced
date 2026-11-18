# Vice-86-Revanced

A fork of **VICE '86 — Paloma Drive**, the 1986 driving game that ships at
<https://heat.pplx.app/>, with **Paloma PD** built on top of it: uniformed officers, patrol cars
that work a beat, witnessed violations, pursuits, searches and traffic stops.

Nothing here is a rewrite. The game's own WebGL 2 renderer, physics, procedural models, world
streaming, audio and UI are the shipped release, checked into this branch file for file; the police
are added to that code, in that code's style, using its own renderer, lane graph and physics world.

## The engine

The renderer the whole game draws through is the release's own custom WebGL 2 deferred renderer in
`web/src/render/` (G-buffers, shadow maps, reflection probes, ocean, sky, rain, TAA, bloom, tone
mapping — no Three.js, no Babylon, no post-processing library). In this fork it has a name:

> **Paloma Engine** — WebGL 2, deferred, release `9d646599b896`.

It is stated in `web/src/render/identity.js`, on the title treatment under the wordmark, on the
Settings ▸ Graphics device note, and to scripts as `window.__vice.engine` / `renderer.engine`.

## What was added for the police

| File | What it is |
| --- | --- |
| `web/src/game/police.js` | The dispatch: what counts as an offence, how many units are sent, where they are sent to, when it is over. |
| `web/src/vehicles/traffic/officers.js` | The officer's uniform and body, built in code with the release's own geometry kit (`Skin`, `box`, `rod`, `disc`, lathed profiles) — no meshes, no downloads. |
| `web/src/audio/siren.js` | The wail: two oscillators and a band-pass, spatialised by the release's own audio module. |
| `web/src/render/identity.js` | The engine's name. |
| `web/src/game/traffic.js` | Patrol units, the beat, roof bars, and the officers on the ground. |
| `web/src/game/drivers.js` | `TrafficSim.setRoute`, so a driver can be ordered along a route instead of choosing one. |
| `web/src/game/game.js`, `hud.js`, `ui/hud*.js`, `style.css` | The dispatch's one line in the HUD, and the toast it speaks. |

The details — what the model is, and why it is built this way — are in
[docs/PALOMA-PD.md](docs/PALOMA-PD.md).

## What was added for the street

The release ships a city with cars in it and nobody on the pavements. This is the rest of the street:

| File | What it is |
| --- | --- |
| `web/src/game/crowd.js` | The people: where they walk, how they answer a car, when they wave a cab down, and the limbs the near ones get. |
| `web/src/core/gltf.js` | A GLB reader: nodes, one skin, one base-colour texture, animation channels. Refuses what it cannot read. |
| `web/src/core/animate.js` | Clip sampling and the rig solve, with the walk clock driven by metres travelled so nobody skates. |
| `web/src/world/people/cast.js` | The cast: five rigged bodies from the vendored packs, one shared clip library, and a person as a mesh whose vertices are rewritten each frame. |
| `web/src/game/wanted.js` | The wanted record: what each thing you did costs, how the stars ladder up, and how they cool off. |
| `web/src/game/foot.js` | On foot: a third-person walker with a run, a crouch, a wind, and a car to climb back into. |
| `web/src/game/weapons.js` | The guns: magazines, a reload, hitscan fired against the crowd, and what a carried gun remembers. |
| `web/src/game/shops.js` | Shopfronts: which lots have a door, what a bag costs, what a till holds, and when a hold-up is over. |
| `web/src/game/shoproom.js` | The room behind a door: the set baked into the world at the lot's own yaw, with its lamps and its walls. |
| `web/src/game/money.js` | The purse: what a race paid and a till took, in bills, and where every dollar came from. |
| `web/src/game/races.js` | Point-to-point races taken from a kerb — the course walked out of the lane graph, the gates judged by crossing a line. |
| `web/src/vehicles/traffic/liveries.js` | Paint for the patrol fleet (marked, two-tone, county, unmarked) on the release's own car bodies. |
| `web/src/game/game.js`, `game/hud.js`, `ui/*` | The HUD's three rows — the job, the race, the crew — the stars beside them, and `V` to take a race. |

The details are in [docs/STREET-LIFE.md](docs/STREET-LIFE.md).

## Layout

```
web/                     the playable tree: the release, plus this fork's modules
  index.html               the shell (relative asset paths, the engine credit)
  src/                     ES modules, loaded as they are: no build step
  design/map/layout.json   the city plan the world worker reads
  vendor/rapier/           Rapier WASM (Apache-2.0; its license is beside it)
  style.css
tools/import_release.py    verifies the vendored bytes; refreshes them from the pinned release
tools/browser-check.mjs    headless boot and soak on SwiftShader
test/                      Node tests for what this fork added
docs/PALOMA-PD.md          the police, as built
```

## Running it

The game is plain ES modules. Serve the `web/` directory and open it — any static server will do:

```sh
python3 -m http.server 5173 --bind 0.0.0.0 --directory web
# http://127.0.0.1:5173/index.html?autostart=1&traffic=2
```

It needs WebGL 2 with float render targets and WebAssembly, and boots by itself. `?autostart=1`
skips the title, `?drive=auto` lets the game drive itself, `?traffic=0..3` sets how many cars are
on the road, `?quality=low|medium|high|ultra` overrides the picture, `?seed=`, `?pos=`, `?time=`,
`?weather=` and `?mute=` place and dress the scene. See `web/src/ui/screens-system.js` for keys.

## Checking it

```sh
python3 tools/import_release.py --verify   # offline: the release bytes, the closure, and what is ours
node --test                                # the dispatch's judgements and the officer's geometry
python3 tools/vendor_models.py --verify    # every model byte against its manifest, and its licence
python3 tools/test_vendor_models.py        # the packing and the licence gate themselves
LD_LIBRARY_PATH=/tmp/chromium-libs node tools/browser-check.mjs --minutes=5 --heat=2
```

`--foot=1` adds the pavement to that last check: the car is braked to a stop, the man steps out, runs, empties a
magazine into the street, reloads, walks into a shop and backs out of it again, and each of those is a line the
harness fails on rather than a screenshot to squint at. `?memory=low` in `--query=` runs the whole page in the
small-memory budget an iPad gets.

The last one boots the page in headless Chromium on SwiftShader and reports page errors, missing
requests, what the dispatch says and what the HUD shows; it needs a Chromium build and its
`libnss3` friends on disk and downloads nothing. A software renderer runs the simulation at a small
fraction of real time, so a browser check watches state rather than waiting out a whole pursuit —
the state machine is covered by the Node tests, which run in milliseconds.

`--verify` prints, for the tree above:

```
web: 264 release files for 9d646599b896, 250 byte for byte and 14 changed by this fork, 4 added, 268 files in all
```

`--import` re-downloads the pinned release into `.vice-snapshot/` and `--sync` copies it back into
`web/`, holding back any file this fork has changed unless `--force`. The release id is pinned in
`tools/import_release.py`; if the live site no longer serves it, the tool refuses rather than
mixing two releases.

## Licence

The repository's own licence is the Unlicense. That covers what this fork wrote. The vendored game
code is the shipped release of VICE '86 as published at heat.pplx.app, with no licence statement
served alongside it, so treat `web/src` as *not* freely licensed: the source here is kept for study
and for this fork, not for redistribution. The one exception is documented: `web/vendor/rapier/`
carries its Apache-2.0 licence file, which the vendoring tool checks is present.
