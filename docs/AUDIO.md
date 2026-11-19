# Audio

Rendered by `tools/make_audio.py` (seed `1447641925`), 22 files, 1.28 MB, 32000 Hz, 16-bit signed PCM, mono, little-endian WAV.

These are recordings in the sense that matters to the game: real audio files, decoded into `AudioBuffer`s and played back. What the browser does with them is level, pan, one rate change of no more than a fifth, and a muffle for a closed cabin. The synthesiser in `web/src/audio/dsp` is not asked for an engine any more while these load; `P.SAMPLES` tells it that the recordings are in charge, and the engine voice and horn fade out instead of doubling up.

| file | seconds | loop | ref rpm | peak | RMS | bytes |
| --- | --- | --- | --- | --- | --- | --- |
| `v8_idle.wav` | 1.0769 | yes | 780.0 | 0.912 | 0.3032 | 68,968 |
| `v8_cruise.wav` | 1.1538 | yes | 2600.0 | 0.912 | 0.2402 | 73,890 |
| `v8_redline.wav` | 1.1593 | yes | 5900.0 | 0.912 | 0.2819 | 74,240 |
| `v12_idle.wav` | 1.1707 | yes | 820.0 | 0.912 | 0.4866 | 74,970 |
| `v12_cruise.wav` | 1.1647 | yes | 3400.0 | 0.912 | 0.3291 | 74,586 |
| `v12_redline.wav` | 1.1513 | yes | 7400.0 | 0.912 | 0.464 | 73,730 |
| `flat12_idle.wav` | 1.0909 | yes | 880.0 | 0.912 | 0.3122 | 69,862 |
| `flat12_cruise.wav` | 1.1428 | yes | 4200.0 | 0.912 | 0.3847 | 73,186 |
| `flat12_redline.wav` | 1.1442 | yes | 8600.0 | 0.912 | 0.4566 | 73,272 |
| `flat6t_idle.wav` | 1.1294 | yes | 850.0 | 0.912 | 0.4405 | 72,326 |
| `flat6t_cruise.wav` | 1.1613 | yes | 3100.0 | 0.912 | 0.3515 | 74,366 |
| `flat6t_redline.wav` | 1.1471 | yes | 6800.0 | 0.912 | 0.435 | 73,456 |
| `horn.wav` | 0.524 | one-shot | — | 0.871 | 0.446 | 33,580 |
| `horn_low.wav` | 0.624 | one-shot | — | 0.871 | 0.4397 | 39,980 |
| `starter.wav` | 1.05 | one-shot | — | 0.8414 | 0.2746 | 67,244 |
| `shift.wav` | 0.26 | one-shot | — | 0.7079 | 0.0555 | 16,684 |
| `door.wav` | 0.85 | one-shot | — | 0.7943 | 0.0919 | 54,444 |
| `hit_thud.wav` | 0.3 | one-shot | — | 0.8318 | 0.2082 | 19,244 |
| `hit_metal.wav` | 0.55 | one-shot | — | 0.8318 | 0.1595 | 35,244 |
| `hit_glass.wav` | 0.7 | one-shot | — | 0.8318 | 0.0978 | 44,844 |
| `hit_scrape.wav` | 0.9 | one-shot | — | 0.8318 | 0.0464 | 57,644 |
| `splash.wav` | 0.6 | one-shot | — | 0.8318 | 0.1027 | 38,444 |

## What each sound is made of

| engine | cylinders | firing pattern (crank degrees per 720°) | exhaust note | description |
| --- | --- | --- | --- | --- |
| `v8` | 8 | 0, 22, 90, 112, 180, 202, 270, 292 | 46 Hz | front-engine V8, cross-plane crank: a lopey idle, four groups of two fires per cycle |
| `v12` | 12 | 0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660 | 62 Hz | V12: twelve even fires per cycle, a smooth buzz, a turbo-soft top end |
| `flat12` | 12 | -4, 64, 116, 184, 236, 304, 356, 424, 476, 544, 596, 664 | 54 Hz | rear flat-12: sings rather than rumbles, lid lifted a touch at 8 600 rpm |
| `flat6t` | 6 | 0, 118, 240, 360, 478, 600 | 40 Hz | turbo flat-6: a low thump under a boost whistle that opens up on part throttle |

## Licence

CC0 1.0 Universal. Rendered from numbers by this repository's own tool, from no third-party recording: nothing to credit and nothing to take back.
