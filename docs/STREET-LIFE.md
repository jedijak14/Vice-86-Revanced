# The street: the crowd, the stars, and a race from the kerb

Everything here is added on the fork's terms — the lane graph says where the pavements are, the traffic
geometry kit makes the bodies, the physics module owns the cars, and nothing in these files has a
collider or a download behind it.

## The crowd (`game/crowd.js`, `world/people/`)

A person is placed on a lane of the graph that is not a junction connector, marched outboard from its
centre line until the plan's carriageway distance says the kerb is behind them, and walked along it.
They wait at the ends and turn back: nobody here crosses a junction, which is why nobody can step out
in front of a car. The only threat they answer to is the player's own car — `threat(distance, speed,
bearing)` is 0 beyond 9 m and under 2.2 m/s, so a parked car and a distant one are the same thing.

Somebody at the kerb sometimes decides they need a cab (`HAIL_ODDS` per six seconds of waiting) and
holds up a mark — a card on a post, drawn from the same kit, worn by the person rather than kept in a
list, so a pedestrian who leaves the street takes the sign with them. A hail is a request, not a vigil:
after `HAIL_PATIENCE` seconds the arm comes down and the mark goes with it.

Far people are one merged mesh with a walk cycle baked into the vertices; near ones (within
`ARTICULATE_AT`) get nine posed parts each, and the number of those is capped by the quality preset,
because posing limbs is the expensive part of a pedestrian and it is the part nobody sees at 40 m.

## The wanted record (`game/wanted.js`)

The dispatch (`game/police.js`) reports incidents; this is what the driver owes. Offences carry points
(`speeding` 1, `collision` 2, `patrol car struck` 4, `hit and run` 5) and the stars are ladders, not
counts: `STAR_STEPS = [3,7,13,22,34]`. Repeating the same thing is discounted after 30 s; points decay
towards the next star when nothing has happened for `ACTIVE_SECONDS`, and the whole record forgives at a
rate that scales with the level (`FORGIVE_SECONDS + FORGIVE_PER_STAR × stars`). One offence never buys a
star — the ladder is the point.

`snapshot().since` is `Infinity` before the first offence, which serialises to `null`: read it as
"nothing has happened", not as a countdown.

## Races (`game/races.js`)

A race is taken from a kerb, not from a menu: `offer(x, z)` looks for the nearest junction-free road
lane near the car, `buildRoute` walks a course out of the graph until it has `target` metres of it, and
the gates are placed along that course. A gate is crossed by *changing side of a line* between two
frames (`crossing`), with a reach test so a car cannot skip a gate by cutting a corner, and the
placement is resynced rather than judged on the first frame after the start.

Junctions are walked *through*: on the shipped plan every road lane's successor is a connector, so a
route that refuses connectors dies after one lane. The walk follows them, the gates never sit on one,
and the connector is in the route's `map` so traffic driving the course is told how to cross it.

Rivals are ordinary traffic handed the route (`traffic.fieldForRace`). A car in a race is marked, so the
traffic's own forgetfulness keeps it on the road while the course holds it; a car the street takes back
after that is marked out of the race rather than left as a phantom entry on the board, and the board
says how many cars are still running.

## The HUD rows

`game/hud.js` is the only thing between the street and the UI, and it passes the status bag out field by
field. That mattered: it used to hand the whole bag to the model as `police`, which left `wanted`,
`race`, `mission` and `net` unset — a wanted level the driver cannot see, however correct the ledger
behind it is. The rows are `.hud__star.is-on` for the stars and one text line each for the job, the race
and the crew; `tools/browser-check.mjs` reads both the ledger and the DOM and warns when they disagree.

## Checking it

    node --test                                                  # 46 tests
    node tools/browser-check.mjs --minutes=3 --heat=2 --traffic=2 --quality=medium \
         --race=1 --drive=1 --size=420x260 --shot=/tmp/vice.png

The page check is what found the two bugs the unit tests could not: a route that could not cross a
junction (no race was ever offered on the real island, while every graph-level test passed) and the
HUD's unset fields. Under SwiftShader a soak runs at 5–15 fps, so driving-dependent behaviour needs
`--drive=1` — inputs land every 1.5 s of wall time otherwise, and a parked car is the normal case.
