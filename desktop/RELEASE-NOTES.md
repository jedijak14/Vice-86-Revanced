## What is in the window

The whole street, the way the browser build has it — the city, the traffic, the water and the
boats, the aeroplanes on the apron, the motorcycles on the kerb, the pedestrians and the police,
the radio, the turning day — in a real desktop frame that starts in one double-click and asks for
nothing else.

- **Run it:** unzip anywhere, run `Vice-86-Revanced.exe`. No installer, no runtime to add, no
  internet after the first start: every asset ships in the folder.
- **Why a desktop build runs smoother:** the page gets the machine's own GPU through Chromium's
  hardware path with no browser chrome, no tabs competing for frames, and a window that owns the
  screen. Pair it with the **Ultra High** preset if the card has room, or leave it on Auto.
- **Controls** are the page's: WASD or arrows to drive, F to get in and out, M for the radio,
  T for the hour, C for the camera. The full list is in the pause menu, and it changes with what
  you are sitting in — a cockpit and a saddle each have their own.

## New in 0.11

- **The airport flies.** Three airframes on the apron at the end of runway 18/36 — a trainer, a
  twin commuter and a jet — each with its own stall speed, flap settings, gear limits and fuel
  burn. Walk out to one, climb in at the pilot's seat, and take off: the roll is as long as the
  physics says it is, and a jet's never-exceed speed is one you can actually reach.
- **Motorcycles on the kerb.** Twelve parked machines in three kinds — scooter, roadster and
  cruiser — that you can wheel out and ride. A turn is a fall you keep catching, so the lean and
  the corner are the same equation, and the tyres decide how much of one you may ask for.
- **A cockpit and a saddle each get their own instruments**, on the same panel the car's dials
  are on: airspeed, altitude, vertical speed and heading in the air; road speed, gear, tacho,
  lean angle and fuel on two wheels.

## Fixed in 0.11.5

- **The game no longer stops when you first get out of a car.** The harbour fleet was reading each
  landmark's original `pos: [x, z]` layout field, but the page-side world plan has already flattened
  it to separate `x` and `z` fields. That left `pos` undefined and crashed while the game tried to
  place boats. Boat placement now accepts the page-side plan shape (and safely skips malformed records).

## Fixed in 0.11.4

- **A graphics driver that resets itself no longer ends the game.** Windows resets a card that has
  taken too long over something — a TDR — and the browser loses its WebGL context while it happens.
  The card comes back, the renderer rebuilds the street and the drive carries on: that is what the
  code was written to do. But one five-second allowance covered the whole of it, armed when the card
  went away and cleared only once the rebuild of the entire city had finished, so a reset that took
  its time — which is what a reset does on a card that was already struggling — was reported as
  "the graphics card did not come back" with the game stopped behind it. The two waits are separate
  now, and each is long enough for what it is waiting for: thirty seconds for the driver, twenty for
  the picture to be rebuilt.
- **A recovery hands the drive back.** The game paused itself when the card went away and never
  unpaused, so even a recovery that worked left the player on a pause screen they had not asked for,
  with the street standing still behind it. It now carries on where it stopped — and only where the
  loss is what paused it: a pause of the player's own is still theirs to lift, and a card lost while
  standing in the showroom does not put them out on the street.

## Fixed in 0.11.3

- **People are the height they were asked to be.** A citizen is lofted as prisms run between the
  skeleton's joints, while the vendored mesh that shares that skeleton is drawn well outside them —
  2.19 units of mesh against 1.82 of citizen — and citizens inherited the mesh's number as the height
  they are scaled by. That number is the divisor every figure is measured against, so a pedestrian the
  street asked to be 1.78 m was drawn at 1.48 m: a crowd that came up to the roof of the car parked
  beside it, and a player who shrank by a third of a metre getting out of his own car. A cap is still
  not a reason to shrink the person wearing it — the body is measured without its headwear, so an
  officer's hat rides along above the crown instead of counting toward it.
- **And the camera is back at your eye.** The walker's eye is a fixed 1.68 m above the pavement, which
  is right for a 1.78 m man and was twenty centimetres above the head of the 1.48 m one. Since 0.11.2
  is the first build that gave you a body on foot at all, that is the build in which the mismatch
  became something you could see: the view was looking down at the top of your own head.

## Fixed in 0.11.2

- **You get out of a car as a person now.** The street keeps a shelf of bodies to lend — one mesh
  uploaded and reused, because building a pedestrian costs a few thousand vertices — and the two
  functions that lend from it and take back to it were never put on the object the rest of the game
  was handed. Every caller checked before asking, so nothing threw and nothing logged: the check
  simply failed, and you stepped out onto the pavement invisible. The same shelf is where a
  carjacked driver and the officers who walk you down come from, so a wanted level also never sent
  anybody after you on foot, and a car you took with a man in it never had a man thrown out of it.
- **Getting out of a boat, an aeroplane or a motorcycle leaves you standing, and looking.** Those
  three put you down in the right place and then stopped: your body stayed parked on the shelf, and
  the camera stayed on the chase rig with the picture still bolted to a machine you were standing
  beside, so dragging the view spun a turntable that had nothing on it. One routine now stands a man
  up whichever machine he has just left — body, camera, neck and the .38 under the seat — because
  four copies of it is how three went stale.
- **Climbing back into a boat takes the camera with you.** Untying her left the view on the free
  camera the pavement uses, which follows nothing at all once the gunwale is moving.
- **Pedestrians are solid.** A limb is lofted as a ring of quads, and the code that drew them drew
  the second triangle of each quad as the first one wound backwards — which the renderer culls, so
  half of every wall was missing. Arms, legs and torsos were spiral gaps with the far pavement
  showing through them.
- **Pedestrians wear their own colours.** A wardrobe is a grade laid over the vendored fantasy
  shelf, whose painted colours are all one costume-department brown; a citizen's vertex colours
  *are* its clothes and its face, chosen per person. Grading them anyway turned warm skin teal,
  cream tees blue and a policeman's navy olive, and washed a street of individuals back into a
  single palette.
- **And they wear them on the right vertex.** A mesh builder's colour is authoring state,
  snapshotted into each vertex at the moment it is pushed — and it was being set *after* the vertex,
  so every one of them wore the colour of the one before it and the first was left white. A speck at
  the root of the body, and a vertex of hair in skin tone down the seam of every part.
