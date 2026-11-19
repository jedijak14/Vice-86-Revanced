# Audio

Rendered by `tools/make_audio.py` (seed `1447641925`), 22 files, 1.93 MB, 48000 Hz, 16-bit signed PCM, mono, little-endian WAV.

These are recordings in the sense that matters to the game: real audio files, decoded into `AudioBuffer`s and played back. What the browser does with them is level, pan, one rate change of no more than a fifth, and a muffle for a closed cabin. The synthesiser in `web/src/audio/dsp` is not asked for an engine any more while these load; `P.SAMPLES` tells it that the recordings are in charge, and the engine voice and horn fade out instead of doubling up.

| file | seconds | loop | ref rpm | peak | RMS | bytes |
| --- | --- | --- | --- | --- | --- | --- |
| `v8_idle.wav` | 1.0769 | yes | 780.0 | 0.912 | 0.3129 | 103,428 |
| `v8_cruise.wav` | 1.1539 | yes | 2600.0 | 0.912 | 0.2521 | 110,814 |
| `v8_redline.wav` | 1.1593 | yes | 5900.0 | 0.912 | 0.3396 | 111,338 |
| `v12_idle.wav` | 1.1707 | yes | 820.0 | 0.912 | 0.5248 | 112,434 |
| `v12_cruise.wav` | 1.1647 | yes | 3400.0 | 0.912 | 0.3655 | 111,856 |
| `v12_redline.wav` | 1.1514 | yes | 7400.0 | 0.912 | 0.4639 | 110,574 |
| `flat12_idle.wav` | 1.0909 | yes | 880.0 | 0.912 | 0.3134 | 104,772 |
| `flat12_cruise.wav` | 1.1429 | yes | 4200.0 | 0.912 | 0.3456 | 109,758 |
| `flat12_redline.wav` | 1.1442 | yes | 8600.0 | 0.912 | 0.3979 | 109,886 |
| `flat6t_idle.wav` | 1.1294 | yes | 850.0 | 0.912 | 0.4163 | 108,468 |
| `flat6t_cruise.wav` | 1.1613 | yes | 3100.0 | 0.912 | 0.3517 | 111,528 |
| `flat6t_redline.wav` | 1.1471 | yes | 6800.0 | 0.912 | 0.43 | 110,162 |
| `horn.wav` | 0.524 | one-shot | — | 0.871 | 0.4461 | 50,348 |
| `horn_low.wav` | 0.624 | one-shot | — | 0.871 | 0.4409 | 59,948 |
| `starter.wav` | 1.05 | one-shot | — | 0.8414 | 0.2658 | 100,844 |
| `shift.wav` | 0.26 | one-shot | — | 0.7079 | 0.0516 | 25,004 |
| `door.wav` | 0.85 | one-shot | — | 0.7943 | 0.0894 | 81,644 |
| `hit_thud.wav` | 0.3 | one-shot | — | 0.8318 | 0.2337 | 28,844 |
| `hit_metal.wav` | 0.55 | one-shot | — | 0.8318 | 0.1619 | 52,844 |
| `hit_glass.wav` | 0.7 | one-shot | — | 0.8318 | 0.0984 | 67,244 |
| `hit_scrape.wav` | 0.9 | one-shot | — | 0.8318 | 0.0418 | 86,444 |
| `splash.wav` | 0.6 | one-shot | — | 0.8318 | 0.086 | 57,644 |

## What each sound is made of

| engine | cylinders | firing pattern (crank degrees per 720°) | exhaust note | description |
| --- | --- | --- | --- | --- |
| `v8` | 8 | 0, 22, 90, 112, 180, 202, 270, 292 | 46 Hz | front-engine V8, cross-plane crank: a lopey idle, four groups of two fires per cycle |
| `v12` | 12 | 0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660 | 62 Hz | V12: twelve even fires per cycle, a smooth buzz, a turbo-soft top end |
| `flat12` | 12 | -4, 64, 116, 184, 236, 304, 356, 424, 476, 544, 596, 664 | 54 Hz | rear flat-12: sings rather than rumbles, lid lifted a touch at 8 600 rpm |
| `flat6t` | 6 | 0, 118, 240, 360, 478, 600 | 40 Hz | turbo flat-6: a low thump under a boost whistle that opens up on part throttle |

## Licence

CC0 1.0 Universal. Rendered from numbers by this repository's own tool, from no third-party recording: nothing to credit and nothing to take back.
