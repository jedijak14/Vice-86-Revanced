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
LD_LIBRARY_PATH=/tmp/chromium-libs node tools/browser-check.mjs --minutes=5 --heat=2
```

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
