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

## Fixed in 0.11.1

- **Every seat is on the left.** Getting into a car put your body at an undefined position,
  because the boarding sequence read a third component out of a two-number heading — so the seat,
  and the patch of dry land the game remembered you standing on, were both nonsense. Cars, boats,
  aeroplanes and motorcycles now each place you at the seat they actually have, on the side the
  steering wheel is already built on.
- **The pavement has people on it again.** A dropped arrow in the code that sorts the street's
  cast threw inside a promise that caught its own error and reported it as "the street could not
  load its people" — so there was nobody to walk among, and no police to send after you.
- **Firing a gun no longer throws.** The toast that names your witnesses read a variable that did
  not exist, on every shot.
- **The twin-engined commuter has two propellers.** Its nacelles drew one blade twice in the same
  place, turning a stub through their own cowls.
- **Walking goes the way you ask.** The keys that steer a car were handed to a pedestrian
  backwards, and then turned a second time on the way in, so holding one key walked him off at an
  angle to the hand asking. A left is now a left on foot, on two wheels, in a cockpit and in the
  driver's seat.
- **A leaning motorcycle carries its rider with it.** The saddle stayed where an upright machine
  would have had it, which hung him off the outside of the corner he was actually in.
- **An officer walks to the door he stopped**, not to where the cruiser's own heading said that
  door was — a cruiser is never parked exactly square behind the car it pulled over.
- **Ultra Low means Ultra Low.** Dropping the graphics preset mid-game stored a budget for how
  many bodies to animate and never applied it, so a slow machine kept drawing every one.
