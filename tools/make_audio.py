#!/usr/bin/env python3
"""Render the car's own sounds into `web/assets/audio/` as real audio files, and keep the books.

The vendored release built every mechanical sound at run time: an AudioWorklet running a synthesiser
written in stringified JavaScript, oscillating and filtering in the audio callback. That is a fine piece
of engineering and it is the wrong answer for a car, for three reasons. A synthetic engine has no
history in it -- no cylinder that fired a fraction weakly, no pipe that rings, no loose bracket -- and the
ear knows that. The worklet is the most fragile thing in the page: a Blob module URL, a `registerProcessor`
race, an autoplay policy, and the sound is simply not there, which is what "add back the engine sound"
means when the game believes it is playing one. And an AudioWorklet costs a core on a phone.

So this tool makes the sounds *offline*, once, as WAV files that the game plays back: 16-bit mono at
32 kHz, a seamless loop per engine per rpm band, and short transients for horn, starter, gearbox, door
and impacts. They are synthesised here -- there is no microphone in a repository -- but from a model of
the machine rather than a beep: pulses at the crank's own firing intervals, a pipe that rings at its own
note, an induction drone whose harmonics are the engine's order numbers, exhaust turbulence that rides on
each pulse, a turbo whine that tracks the rpm, cycle-to-cycle weak fires and idle lope. Then the browser
does the small part it is good at: crossfade between rpm bands, pitch a band by no more than a fifth,
muffle it behind a closed cabin, and pan an impact.

    python3 tools/make_audio.py --write            # render everything (about a second per file)
    python3 tools/make_audio.py --only=v8,shifter  # a subset, by file prefix
    python3 tools/make_audio.py --verify           # bytes on disk against the manifest
    python3 tools/make_audio.py --report --write   # docs/AUDIO.md

Stdlib only, and deterministic: the same seed renders the same bytes, which is what makes `--verify`
worth running and lets a reviewer re-render one file and diff it.

Licence: everything written here is made by this repository from numbers. It carries no third-party
audio, and the manifest says so; `docs/AUDIO.md` repeats it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "web", "assets", "audio")
MANIFEST_NAME = "manifest.json"

# 32 kHz: the highest content in a car's exhaust is a hiss around 8 kHz, and 32 kHz leaves room for the
# filters without carrying 6 kHz of nothing. Mono because a loop that is panned around the listener beats
# one that is stereo and stuck 1.4 m to the left of the car.
SAMPLE_RATE = 48000   # the quality pass: hats, crackle and formants above 16 kHz survive
# How far a filter is warmed up on a loop's own tail before the loop proper, in pole time constants.
# Twenty is e^-20 = 2e-9 of the start-up transient left, which is below a 16-bit sample's own noise.
WARM_TIME_CONSTANTS = 20.0
WARM_MAX_SAMPLES = 1 << 16
# How much of an engine loop is spent hiding the join in its turbulence: long enough that no ear catches
# it, short enough that a one-second loop is still a second of engine.
LOOP_FADE_SECONDS = 0.045
SEED = 0x56494345   # "VICE" in ASCII, and fixed: a re-render must be byte-identical or `--verify` is theatre.

# ─────────────────────────────────────────────────────────────────────────── the engines

# Four cars, named the way `audio/index.js` names them, because `setCar({ voice })` has to find a file.
# `cyl` and `pattern` are the crankshaft: a firing pattern is the sequence of crank-angle offsets within
# one 720° cycle, and it is the whole difference between a flat-12's buzz and a cross-plane V8's lope.
# `pipe` is the exhaust's resonant note in Hz -- the pitch each pulse rings at, which is why a V8 idles at
# a note you could hum and a V12 does not.
ENGINES = {
    "v8": {
        "cyl": 8,
        "pattern": [0, 22, 90, 112, 180, 202, 270, 292],   # four even groups, a pair of close fires each
        "pipe": 46.0,
        "orders": 3.2,          # how much of the sound is the firing frequency and its multiples
        "whine": 0.0,
        "lash": 0.05,           # valve gear: a tick at twice the firing rate
        "lope": 0.16,           # cycle-to-cycle wobble at idle: the rumble's whole personality
        "drive": 1.9,
        "rpm": {"idle": 780, "cruise": 2600, "redline": 5900},
        "note": "front-engine V8, cross-plane crank: a lopey idle, four groups of two fires per cycle",
    },
    "v12": {
        "cyl": 12,
        "pattern": [i * 60.0 for i in range(12)],           # even as a sewing machine
        "pipe": 62.0,
        "orders": 4.6,
        "whine": 0.10,
        "lash": 0.03,
        "lope": 0.05,
        "drive": 1.35,
        "rpm": {"idle": 820, "cruise": 3400, "redline": 7400},
        "note": "V12: twelve even fires per cycle, a smooth buzz, a turbo-soft top end",
    },
    "flat12": {
        "cyl": 12,
        "pattern": [i * 60.0 + (4.0 if i % 2 else -4.0) for i in range(12)],
        "pipe": 54.0,
        "orders": 5.1,
        "whine": 0.06,
        "lash": 0.07,
        "lope": 0.07,
        "drive": 1.25,
        "rpm": {"idle": 880, "cruise": 4200, "redline": 8600},
        "note": "rear flat-12: sings rather than rumbles, lid lifted a touch at 8 600 rpm",
    },
    "flat6t": {
        "cyl": 6,
        "pattern": [0, 118, 240, 360, 478, 600],
        "pipe": 40.0,
        "orders": 2.6,
        "whine": 0.34,          # one turbo, wound up and audible
        "lash": 0.06,
        "lope": 0.09,
        "drive": 1.6,
        "rpm": {"idle": 850, "cruise": 3100, "redline": 6800},
        "note": "turbo flat-6: a low thump under a boost whistle that opens up on part throttle",
    },
}

BANDS = ("idle", "cruise", "redline")

# What each band sounds like, in the numbers that matter. A redline loop is louder, brighter and drier;
# an idle loop is the one with the exhaust falling off at the end of every pulse.
BAND_MIX = {
    "idle": {"load": 0.18, "sizzle": 0.35, "induction": 0.5, "ring_q": 11.0, "decay": 1.0},
    "cruise": {"load": 0.62, "sizzle": 0.72, "induction": 0.9, "ring_q": 8.0, "decay": 0.7},
    "redline": {"load": 1.0, "sizzle": 1.0, "induction": 1.15, "ring_q": 5.5, "decay": 0.5},
}


# ─────────────────────────────────────────────────────────────────────────── tiny DSP

def biquad(kind: str, f0: float, q: float, gain_db: float = 0.0, sr: int = SAMPLE_RATE):
    """RBJ cookbook coefficients as (b0, b1, b2, a1, a2), normalised so a0 = 1."""
    f0 = min(max(f0, 4.0), sr * 0.48)
    w = 2.0 * math.pi * f0 / sr
    cw, sw = math.cos(w), math.sin(w)
    alpha = sw / (2.0 * max(q, 0.05))
    a = 10.0 ** (gain_db / 40.0)
    if kind == "lowpass":
        b0, b1, b2 = (1 - cw) / 2, 1 - cw, (1 - cw) / 2
    elif kind == "highpass":
        b0, b1, b2 = (1 + cw) / 2, -(1 + cw), (1 + cw) / 2
    elif kind == "bandpass":
        b0, b1, b2 = alpha, 0.0, -alpha
    elif kind == "peaking":
        b0, b1, b2 = 1 + alpha * a, -2 * cw, 1 - alpha * a
    elif kind == "notch":
        b0, b1, b2 = 1.0, -2 * cw, 1.0
    else:
        raise ValueError(f"unknown filter kind {kind!r}")
    a0, a1, a2 = 1 + alpha, -2 * cw, 1 - alpha
    return (b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)


def run_filter(coeffs, data: list, out: list | None = None, state: list | None = None) -> list:
    """
    One pass of a biquad over `data`, direct form I. Long, flat, and the same every time it runs.

    `state` is the filter's memory as [x1, x2, y1, y2], read on the way in and written on the way out,
    so a caller can carry it from the end of one pass to the beginning of the next. Without it the pass
    starts from silence, which is right for a one-shot and wrong for a loop: see periodic_filter.
    """
    b0, b1, b2, a1, a2 = coeffs
    n = len(data)
    y = out if out is not None and len(out) == n else [0.0] * n
    if state is None:
        x1 = x2 = y1 = y2 = 0.0
    else:
        x1, x2, y1, y2 = state[0], state[1], state[2], state[3]
    for i in range(n):
        x = data[i]
        v = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1 = x1, x
        y2, y1 = y1, v
        y[i] = v
    if state is not None:
        state[0], state[1], state[2], state[3] = x1, x2, y1, y2
    return y


def warm_samples(coeffs, n: int, constants: float = WARM_TIME_CONSTANTS) -> int:
    """
    How far to warm a filter up before it can be trusted, from its own poles. The pole radius is
    sqrt(a2) for a biquad, one time constant is -1/ln(radius) samples, and twenty of them leave e^-20 of
    the start-up transient -- below a 16-bit sample's own noise. A fixed number would be wrong: the
    pipe's peaking filter at 46 Hz and Q 5.5 remembers for 1 370 samples, while the 5.2 kHz low pass
    forgets in four.
    """
    a2 = coeffs[4]
    if not (a2 > 0):
        return min(n - 1, 64)
    radius = math.sqrt(a2)
    if radius >= 1.0:
        return min(n - 1, WARM_MAX_SAMPLES)
    tau = -1.0 / math.log(radius)
    return max(32, min(n - 1, int(constants * tau), WARM_MAX_SAMPLES))


def periodic_filter(coeffs, data: list, passes: int = 2, periodic: bool = True,
                    warm: int | None = None) -> list:
    """
    Filter a loop so that what comes out is a loop too.

    A recursive filter has a memory, and the memory a periodic signal would have at the start of the
    loop is not silence: start from silence and the head of the file carries a start-up transient the
    tail does not, which is a step at the join and a tick once every time round.

    The memory is found by warming the filter up on the loop's own tail before the loop begins -- for a
    periodic signal, the last `warm` samples really are what precedes the first one -- and then throwing
    the warm-up away. What is left is the filter's steady state, so the output repeats with the input.

    Two things this must not do, both of which look plausible and are wrong:

      Carrying the memory from one pass to the next is not enough. The first pass filters the loop with
      the wrong memory and hands its head transient on; the passes after it filter the transient.
      Re-running the whole cascade until the output stops moving never stops: each run applies the
      filter again, so the signal keeps changing (a highpass run six times is a much steeper highpass),
      and the "convergence" test measures the wrong thing.
      The *input* memory of a pass is that pass's own input's tail, not the previous pass's.

    So: one application per pass, each warmed on its own input's tail. `passes` cascades identical
    sections, which is what makes a two-pass highpass 12 dB an octave rather than six.

    `periodic=False` is for one-shots, which have no tail to join up with and want the honest thing: a
    filter that starts from silence. See shape_filter.
    """
    n = len(data)
    steps = max(1, passes)
    if not periodic or n < 8:
        src = data
        for _ in range(steps):
            src = run_filter(coeffs, src)
        return src
    w = warm_samples(coeffs, n) if warm is None else min(warm, n - 1)
    src = data
    for _ in range(steps):
        warmed = run_filter(coeffs, src[n - w:] + list(src))
        src = warmed[w:]
    return src


def shape_filter(coeffs, data: list, passes: int = 2) -> list:
    """The same shaping as periodic_filter, for a sound that is not a loop: starts from silence."""
    return periodic_filter(coeffs, data, passes, periodic=False)


def dc_blocker(data: list, r: float = 0.995, passes: int = 2, periodic: bool = True,
               warm: int | None = None) -> list:
    """Takes the DC out. Same warm-up rule as periodic_filter, and the same reason for it."""
    n = len(data)
    steps = max(1, passes)
    if not periodic or n < 8:
        y1 = 0.0
        for _ in range(steps):
            x1 = 0.0
            for i, x in enumerate(data):
                y = x - x1 + r * y1
                data[i] = y
                x1, y1 = x, y
        return data
    # A dc blocker is a one-pole highpass at r, so its memory is measured the same way as a biquad's.
    w = max(32, min(n - 1, int(WARM_TIME_CONSTANTS / -math.log(r)))) if warm is None else min(warm, n - 1)
    for _ in range(steps):
        ext = data[n - w:] + list(data)
        y1 = 0.0
        x1 = 0.0
        out = [0.0] * len(ext)
        for i, x in enumerate(ext):
            y = x - x1 + r * y1
            out[i] = y
            x1, y1 = x, y
        data = out[w:]
    return data


def rms(data) -> float:
    return math.sqrt(sum(v * v for v in data) / max(1, len(data)))


def peak(data) -> float:
    return max((abs(v) for v in data), default=0.0)


def normalize(data, target_peak_db: float = -1.0, target_rms_db: float | None = None) -> list:
    """Scale to a peak ceiling, and to an RMS target when there is room for it (never clipping)."""
    p = peak(data)
    if p > 1e-12:
        goal = 10.0 ** (target_peak_db / 20.0)
        s = goal / p
        data = [v * s for v in data]
    if target_rms_db is not None:
        want = 10.0 ** (target_rms_db / 20.0)
        r = rms(data)
        if r > 1e-12 and r < want:                 # only ever bring it up, and never past the ceiling
            s = min(want / r, (10.0 ** (target_peak_db / 20.0)) / max(peak(data), 1e-12))
            data = [v * s for v in data]
    return data


def soft_clip(data, drive: float) -> list:
    if drive <= 1.0001:
        return data
    return [math.tanh(drive * v) / math.tanh(drive) for v in data]


def dither16(data, rng: random.Random) -> bytes:
    """Float −1..1 → little-endian 16-bit PCM with a triangle dither, so a quiet loop stays smooth."""
    out = bytearray(len(data) * 2)
    for i, v in enumerate(data):
        s = max(-1.0, min(1.0, v))
        q = s * 32767.0 + (rng.random() - rng.random()) * 0.75
        out[2 * i:2 * i + 2] = struct.pack("<h", int(max(-32768, min(32767, round(q)))))
    return bytes(out)


def noise_array(n: int, rng: random.Random, pink: bool = False) -> list:
    """White, or pink by Paul Kellet's filter when the source is a bed rather than a pulse."""
    if not pink:
        return [rng.random() * 2.0 - 1.0 for _ in range(n)]
    b0 = b1 = b2 = b3 = b4 = b5 = b6 = 0.0
    out = []
    for _ in range(n):
        w = rng.random() * 2.0 - 1.0
        b0 = 0.99886 * b0 + w * 0.0555179
        b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.96900 * b2 + w * 0.1538520
        b3 = 0.86650 * b3 + w * 0.3104856
        b4 = 0.55000 * b4 + w * 0.5329522
        b5 = -0.7616 * b5 - w * 0.0168980
        out.append((b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11)
        b6 = 0.115926 * w
    return out


def add_wrapped(buf: list, start: int, kernel: list, gain: float = 1.0) -> None:
    """`buf[i] += kernel * gain`, wrapping at the end of the loop: a pulse that runs off the tail comes
    back in at the head, which is what makes a loop of a repeating machine."""
    n = len(buf)
    k = len(kernel)
    j = start
    for i in range(k):
        buf[j] += kernel[i] * gain
        j += 1
        if j >= n:
            j = 0


def fade_tail(buf: list, seconds: float = 0.012, sr: int = SAMPLE_RATE) -> list:
    """
    Bring a one-shot to zero over its last few milliseconds. Its attack is the whole point and must stay
    instantaneous, but a buffer that stops on a non-zero sample clicks when it ends, and the game plays
    these from `AudioBufferSourceNode`s that stop exactly at the end.
    """
    n = len(buf)
    fade = max(1, min(n, int(seconds * sr)))
    for i in range(fade):
        buf[n - fade + i] *= (fade - i) / fade
    return buf


def crossfade_loop(buf: list, fade_seconds: float = LOOP_FADE_SECONDS, sr: int = SAMPLE_RATE) -> list:
    """
    Make a loop whose ends join without a click. The pulses and the drone in an engine loop are periodic
    by construction; the turbulence under them is random, and a random bed has a step at the join that the
    ear hears as a tick every time round. So the loop is shortened by one fade and the head is an
    equal-power blend of what was there and what would have followed it:

        out[i] = buf[i]·sin(w) + buf[i + M]·cos(w),  w ramping 0 → π/2 over the fade

    At the start of the fade w is 0, so `out[0]` is `buf[M]`, which is exactly the sample that follows
    the loop's last one: the wrap is continuous. At the end of the fade w is π/2, so `out[F-1]` is
    `buf[F-1]` and the next sample is `buf[F]`: the middle is continuous too. Equal power, not equal
    amplitude, so the fade does not dip the level of a noise bed.
    """
    n = len(buf)
    fade = max(2, int(fade_seconds * sr))
    if fade * 4 > n:
        return buf
    m = n - fade
    out = buf[:m]                            # keep the head, drop the tail it is blended with
    quarter = math.pi / 2.0
    for i in range(fade):
        w = quarter * (i / fade)
        out[i] = buf[i] * math.sin(w) + buf[i + m] * math.cos(w)
    return out


# ─────────────────────────────────────────────────────────────────────────── the engine

def engine_band_samples(kind: str, band: str, rng: random.Random,
                        target_seconds: float = 1.15, sr: int = SAMPLE_RATE):
    """
    One full-range loop: a given engine at a given rpm.

    Returns (samples, info). The model, in the order it is added up:

      firing pulses   one per fire, at the crank-angle pattern's own intervals: a burst of noise through
                      the exhaust's note, decaying at a rate that goes with rpm;
      pipe ring       a decaying sine at the pipe's note, which is the pitch you can hum out of a rumble;
      induction       a drone at the firing frequency and its harmonics, breathier the harder it is asked;
      bed             pink noise through the whole mid range: turbulence, and everything not modelled;
      lash            a tick at twice the firing rate, from the valve gear;
      whine           the turbo's own note, wound up by rpm, only where there is a turbo;
      lope            cycle-to-cycle amplitude wobble, which is what keeps it from being a loop of a tone.
    """
    spec = ENGINES[kind]
    mix = BAND_MIX[band]
    rpm = float(spec["rpm"][band])
    cyl = int(spec["cyl"])
    fc = rpm / 60.0                       # crank revolutions per second
    cycle_seconds = 2.0 / fc              # one 720° four-stroke cycle
    cycles = max(2, int(round(target_seconds / cycle_seconds)))
    total = cycles * cyl                  # fires in the loop
    # The file is a whole number of crank cycles, and that is what makes it a loop rather than a snippet:
    # every periodic part of it -- the fires, the induction drone, the turbo whistle -- joins up with
    # itself exactly, and the only thing left to hide is the random turbulence underneath, which the
    # crossfade blends away. The pitch of the file is therefore the pitch of this many cycles in this
    # many samples, which the manifest reports as refRpm: the game pitches a band by rpm/refRpm and gets
    # the rpm it asked for, so a rounding of a few samples here cannot put the engine out of tune.
    length = max(64, int(round(cycles * cycle_seconds * sr)))
    cycle_seconds = length / cycles / sr
    fc = 2.0 / cycle_seconds              # crank revolutions a second, and the rate the fires follow
    fade = max(2, int(LOOP_FADE_SECONDS * sr))

    buf = [0.0] * length

    # The kernels get built once per band and reused: every fire is the same shape at a different gain.
    # The pipe's ring-out is bounded by the gap between fires, because that is what a pipe does: at idle
    # the gap is long and the note rings on into it, which is the rumble; at redline the next fire arrives
    # before the last one has died, so the pulses stay distinct and what is heard is the firing tone and
    # its harmonics. Letting a fixed ring time overrun the gap instead smears the pulses into the crank's
    # own cycle rate -- a 49 Hz fundamental on a V8 at 6 000 rpm -- and the low end eats the whole mix.
    fire_interval = cycle_seconds / cyl
    ring_tau = min(0.0115 * mix["decay"], 0.55 * fire_interval) * sr
    ring_len = max(16, int(ring_tau * 5))
    n_ring = noise_array(ring_len, rng)
    ring_kernel = []
    for i in range(ring_len):
        env = math.exp(-i / ring_tau)
        ring_kernel.append(env * math.sin(2.0 * math.pi * spec["pipe"] * i / sr) * 0.85 + n_ring[i] * env * 0.5)
    snap_len = max(6, int(0.0045 * sr))
    n_snap = noise_array(snap_len, rng)
    snap_kernel = [n_snap[i] * math.exp(-i / (0.0016 * sr)) for i in range(snap_len)]

    # Idle lope and the occasional weak fire: one value per fire, repeated when the loop repeats.
    lope = [1.0 + spec["lope"] * math.sin(2.0 * math.pi * k / max(1, cycles) + 0.7)
            + (rng.random() - 0.5) * 0.14 for k in range(total)]
    fires_per_cycle = len(spec["pattern"])
    for k in range(total):
        # This fire's crank angle, in degrees, is where it sits in the 720° cycle that contains it;
        # degrees into samples against the loop's own cycle length puts it on the timeline.
        deg = spec["pattern"][k % fires_per_cycle] + 720.0 * (k // fires_per_cycle)
        at = int(round(deg / 720.0 * cycle_seconds * sr)) % length
        amp = lope[k]
        add_wrapped(buf, at, ring_kernel, gain=1.0 * amp)
        add_wrapped(buf, at, snap_kernel, gain=(0.20 + 0.45 * mix["sizzle"]) * amp)

    # Induction drone, valve lash and the bed. Every tonal part is written as a whole number of cycles
    # over the loop, because a component at 6.7 times the firing rate -- which is what a camshaft's tick
    # wants to be -- lands a fraction of a turn away from where it started and puts a step at the join
    # that is louder than anything else in the file. Rounding to whole cycles costs nothing audible.
    drone = [0.0] * length
    lash = [0.0] * length
    order = spec["orders"]
    ff = fc * cyl / 2.0                   # firing frequency: the note the exhaust pulses play
    lash_low = int(round(2.0 * ff * length / sr))
    lash_high = int(round(6.7 * ff * length / sr))
    two_pi_over_length = 2.0 * math.pi / length
    for i in range(length):
        ph = 2.0 * math.pi * ff * i / sr
        v = 0.0
        for h in range(1, 7):
            v += math.sin(ph * h + h * 0.6) / (h ** (1.25 - 0.06 * band_index(band)))
        drone[i] = v * 0.06 * order * mix["induction"]
        lash[i] = (math.sin(lash_low * two_pi_over_length * i) * 0.5
                   + math.sin(lash_high * two_pi_over_length * i) * 0.5) * spec["lash"] * 0.05
    # The turbulence is the one part of an engine loop that is not periodic: it is noise, and noise does
    # not join up with itself. So it is made one fade longer than the loop and crossfaded down on its own
    # before it is mixed under the fires. Everything else in the file repeats exactly, which leaves the
    # join carrying nothing -- and blending the whole buffer instead would have mixed each periodic part
    # with a copy of itself, which is not a crossfade but a bump of up to √2 at the head of every loop.
    bed = noise_array(length + fade, rng, pink=True)
    bed = crossfade_loop(bed, LOOP_FADE_SECONDS, sr)      # seamless first, while it is still raw noise
    bed = periodic_filter(biquad("bandpass", 620.0, 0.55, sr=sr), bed)   # then filtered as a loop
    bed_gain = 0.035 + 0.05 * mix["load"]
    for i in range(length):
        buf[i] = buf[i] * 0.85 + drone[i] + lash[i] + bed[i] * bed_gain

    # Turbo whistle: a tone that climbs with rpm. The number of cycles is rounded to a whole number that
    # fits the loop, so the whistle joins up at the seam instead of clicking there.
    if spec["whine"] > 0:
        whine = [0.0] * length
        whine_hz = 2400.0 * (0.55 + 0.45 * (rpm / spec["rpm"]["redline"]))
        cycles_wh = max(1, int(round(whine_hz * length / sr)))
        gain = spec["whine"] * (0.35 + 0.65 * mix["load"])
        for i in range(length):
            ph = 2.0 * math.pi * cycles_wh * i / length
            whine[i] = (math.sin(ph) * 0.7 + math.sin(2.0 * ph) * 0.2) * gain
        buf = [buf[i] + whine[i] for i in range(length)]

    # Colour: the pipe's note gets a louder say, the whole thing is band-limited and driven. The pipe
    # matters most at idle, where the firing rate sits right on top of its resonance; by redline the
    # exhaust is blowing straight through it and the sound is the firing tone and its harmonics, so the
    # boost is wound back and a little presence is put back where the ear expects the scream.
    pipe_gain = 7.5 * (1.0 - 0.30 * band_index(band))
    buf = periodic_filter(biquad("peaking", spec["pipe"], mix["ring_q"] * 0.5, pipe_gain, sr), buf)
    buf = periodic_filter(biquad("lowpass", 5200.0, 0.72, sr=sr), buf)
    if band == "redline":
        buf = periodic_filter(biquad("peaking", 2600.0, 0.9, 3.0, sr), buf)
    if band == "cruise":
        buf = periodic_filter(biquad("peaking", 1800.0, 0.8, 1.6, sr), buf)
    if band == "idle":
        buf = periodic_filter(biquad("lowpass", 1500.0, 0.7, sr=sr), buf)
    buf = soft_clip(buf, spec["drive"] + (0.35 if band == "redline" else 0.0))
    buf = dc_blocker(buf)
    # Last, and after everything that can leave a DC offset behind: three passes of the high pass. Two
    # things come of it. 36 dB an octave below 42 Hz, so the bottom of the turbulence is not headroom
    # spent on nothing a car speaker can move. And a filter run to its steady state on a periodic input,
    # so the file ends where it begins: `periodic_filter` is why the loop has no join to hear.
    buf = periodic_filter(biquad("highpass", 42.0, 0.707, sr=sr), buf, passes=3)
    targets = {"idle": -19.0, "cruise": -17.0, "redline": -16.5}
    buf = normalize(buf, target_peak_db=-0.8, target_rms_db=targets[band])
    # Report the loop the file actually is, not the one that was asked for: it is a whole number of crank
    # cycles in a whole number of samples, and the game pitches a band by dividing the live rpm by this,
    # so the number has to be the pitch of the recording rather than the rpm it was aimed at.
    loop_seconds = len(buf) / sr
    loop_rpm = 60.0 * 2.0 * cycles / loop_seconds       # one 720° cycle is two crank revolutions
    info = {
        "rpm": round(loop_rpm, 1), "firesPerSecond": round(cyl * loop_rpm / 120.0, 2),
        "cylinders": cyl, "cycles": cycles, "seconds": round(loop_seconds, 4),
    }
    return buf, info


def band_index(band: str) -> int:
    return {"idle": 0, "cruise": 1, "redline": 2}[band]


# ─────────────────────────────────────────────────────────────────────────── the transients

def horn_samples(low: bool = False, rng: random.Random | None = None) -> tuple[list, dict]:
    """
    An electric horn: two reeds a minor third apart, each with its own bite and a noise band on top,
    attacked in 14 ms (the diaphragm snapping over) and released over 40 ms with the reeds ringing down
    at different rates, which is the part that makes it a horn rather than a chord.
    """
    sr = SAMPLE_RATE
    rng = rng or random.Random(SEED)
    f1, f2 = (233.0, 311.0) if low else (392.0, 466.0)
    hold = 0.46 if not low else 0.56
    attack, release = 0.014, 0.05
    n = int((attack + hold + release) * sr)
    noise = noise_array(n, rng)
    noise = shape_filter(biquad("bandpass", (f1 + f2) * 0.9, 1.6, sr=sr), noise)
    buf = []
    for i in range(n):
        t = i / sr
        if t < attack:
            env = (t / attack) ** 0.6
        elif t > attack + hold:
            env = math.exp(-(t - attack - hold) / (release * 0.42))
        else:
            env = 1.0 + 0.02 * math.sin(2.0 * math.pi * 6.0 * t)      # the buzz of a real reed
        # The first 8 ms of each reed is where the "honk" lives: a brighter, faster-decaying partial set.
        bite = math.exp(-t / 0.008)
        s = 0.0
        for (f, w) in ((f1, 1.0), (f2, 0.85)):
            s += w * (math.sin(2 * math.pi * f * t) * 0.55
                      + math.sin(4 * math.pi * f * t) * 0.30 * (0.35 + bite)
                      + math.sin(6 * math.pi * f * t) * 0.13 * (0.2 + bite))
        s += noise[i] * (0.16 + 0.3 * bite)
        buf.append(s * env)
    tail = int(0.02 * sr)
    for i in range(tail):                                          # the last thing heard is the room
        buf[n - 1 - i] *= i / tail
    buf = shape_filter(biquad("highpass", 120.0, 0.7, sr=sr), buf)
    buf = soft_clip(buf, 1.15)
    buf = normalize(buf, target_peak_db=-1.2, target_rms_db=-15.0)
    return buf, {"reeds": [f1, f2], "seconds": round(n / sr, 4)}


def starter_samples(rng: random.Random) -> tuple[list, dict]:
    """
    A starter crank: a toothed grind whose rate rises as the engine catches, three or four failed fires,
    then the catch -- a thump and a rush up to idle -- and the starter's own note stopping a beat later.
    """
    sr = SAMPLE_RATE
    dur = 1.05
    n = int(dur * sr)
    noise = noise_array(n, rng)
    whine = [0.0] * n
    grind = shape_filter(biquad("bandpass", 620.0, 1.1, sr=sr), noise)
    thump = shape_filter(biquad("lowpass", 180.0, 0.8, sr=sr), noise)
    for i in range(n):
        t = i / sr
        # 12 teeth a revolution, the motor at 22 Hz, and it speeds up by a fifth as compression is passed.
        teeth = 0.5 + 0.5 * math.sin(2.0 * math.pi * 264.0 * t * (1.0 + 0.16 * min(1.0, t / 0.7)))
        motor = math.sin(2.0 * math.pi * 22.0 * t) * 0.4
        catch_at = 0.72
        env = 1.0 if t < catch_at else max(0.0, 1.0 - (t - catch_at) / 0.16)
        whine[i] = (teeth * 0.55 + motor) * env * (0.55 + 0.45 * min(1.0, t / 0.25))
        whine[i] += grind[i] * 0.25 * env
    # The failed fires: short bursts of compression noise just before the catch.
    for k, at in enumerate([0.20, 0.36, 0.52]):
        start = int(at * sr)
        kernel = [thump[j] * math.exp(-j / (0.006 * sr)) for j in range(int(0.02 * sr))]
        for j, v in enumerate(kernel):
            if start + j < n:
                whine[start + j] += v * (0.5 + 0.3 * k)
    # The catch: a low thump and a rev that climbs, then settles.
    start = int(0.72 * sr)
    for i in range(start, n):
        t = (i - start) / sr
        rpm = 620.0 + 900.0 * math.exp(-t / 0.12)
        whine[i] += math.sin(2.0 * math.pi * rpm * t) * math.exp(-t / 0.28) * 0.5 + thump[i] * math.exp(-t / 0.1) * 0.8
    whine = shape_filter(biquad("highpass", 60.0, 0.7, sr=sr), whine)
    whine = soft_clip(whine, 1.4)
    buf = normalize(whine, target_peak_db=-1.5, target_rms_db=-18.0)
    return buf, {"catchAt": 0.72, "seconds": round(n / sr, 4)}


def shift_samples(rng: random.Random) -> tuple[list, dict]:
    """A gearbox: the torque going away for 40 ms, a dog-nose click, and the drive taking up again."""
    sr = SAMPLE_RATE
    n = int(0.26 * sr)
    noise = noise_array(n, rng)
    click = shape_filter(biquad("bandpass", 2400.0, 2.2, sr=sr), noise)
    body = shape_filter(biquad("lowpass", 420.0, 0.9, sr=sr), noise)
    buf = []
    for i in range(n):
        t = i / sr
        knock = math.exp(-abs(t - 0.075) / 0.006)             # the dogs finding each other
        take = math.exp(-abs(t - 0.15) / 0.02) * (1.0 if t > 0.15 else 0.2)   # drive coming back on
        buf.append((click[i] * knock * 0.75 + body[i] * (0.18 * knock + 0.5 * take) * 0.7)
                   * (0.15 + 0.85 * min(1.0, t / 0.02)))
    buf = normalize(buf, target_peak_db=-3.0)
    return buf, {"seconds": round(n / sr, 4)}


def door_samples(rng: random.Random) -> tuple[list, dict]:
    """
    A car door: the handle's click, the door swinging on its checks (a filtered whoosh), and the slam --
    a latch strike, a panel ring around 240 Hz, and the whole car moving a little at 55 Hz.
    """
    sr = SAMPLE_RATE
    n = int(0.85 * sr)
    noise = noise_array(n, rng)
    whoosh = shape_filter(biquad("bandpass", 900.0, 0.7, sr=sr), noise)
    panel = [0.0] * n
    latch = shape_filter(biquad("highpass", 1800.0, 1.2, sr=sr), noise)
    slam_start = int(0.30 * sr)
    for i in range(n):
        t = i / sr
        swing = math.exp(-abs(t - 0.16) / 0.09)
        panel[i] = whoosh[i] * swing * 0.30
    for j in range(int(0.35 * sr)):
        i = slam_start + j
        if i >= n:
            break
        env = math.exp(-j / (0.02 * sr))
        ring = math.exp(-j / (0.055 * sr))
        panel[i] += (latch[j] * env * 0.55
                     + math.sin(2 * math.pi * 236.0 * j / sr) * ring * 0.4
                     + math.sin(2 * math.pi * 55.0 * j / sr) * math.exp(-j / (0.09 * sr)) * 0.55)
    panel = shape_filter(biquad("highpass", 45.0, 0.7, sr=sr), panel)
    buf = normalize(soft_clip(panel, 1.25), target_peak_db=-2.0, target_rms_db=-21.0)
    return buf, {"slamAt": 0.30, "seconds": round(n / sr, 4)}


def impact_samples(kind: str, rng: random.Random) -> tuple[list, dict]:
    """Thud, metal, glass, scrape, splash: one transient each, built from the material's own resonances."""
    sr = SAMPLE_RATE
    specs = {
        "thud": {"dur": 0.30, "tone": [(60.0, 0.10), (128.0, 0.05)], "noise": ("lowpass", 260.0, 0.8), "gain": 1.0},
        "metal": {"dur": 0.55, "tone": [(430.0, 0.14), (1180.0, 0.09), (2650.0, 0.05)], "noise": ("bandpass", 1700.0, 1.1), "gain": 0.9},
        "glass": {"dur": 0.70, "tone": [(2100.0, 0.06), (3400.0, 0.05), (5200.0, 0.03)], "noise": ("highpass", 2600.0, 0.8), "gain": 0.8},
        "scrape": {"dur": 0.90, "tone": [], "noise": ("bandpass", 1400.0, 0.6), "gain": 0.7, "hold": 0.55},
        "splash": {"dur": 0.60, "tone": [(180.0, 0.05)], "noise": ("bandpass", 1500.0, 0.4), "gain": 0.75, "hold": 0.3},
    }
    s = specs[kind]
    n = int(s["dur"] * sr)
    noise = noise_array(n, rng, pink=(kind in ("thud", "scrape")))
    shaped = shape_filter(biquad(s["noise"][0], s["noise"][1], s["noise"][2], sr=sr), noise)
    hold = s.get("hold", 0.0)
    buf = []
    for i in range(n):
        t = i / sr
        env = math.exp(-t / 0.028)
        if hold:
            env *= (1.0 - smooth01(t, hold)) + smooth01(t, hold) * math.exp(-(t - hold) / 0.22)
        v = shaped[i] * env * (0.75 if hold else 1.0)
        for (f, tau) in s["tone"]:
            v += math.sin(2.0 * math.pi * f * t) * math.exp(-t / tau) * 0.5
        buf.append(v * s["gain"])
    buf = shape_filter(biquad("highpass", 42.0, 0.7, sr=sr), buf)
    buf = normalize(soft_clip(buf, 1.3), target_peak_db=-1.6, target_rms_db=-19.0)
    return buf, {"seconds": round(n / sr, 4), "kind": kind}


def smooth01(t: float, centre: float) -> float:
    if t <= centre - 0.05:
        return 0.0
    if t >= centre + 0.05:
        return 1.0
    x = (t - (centre - 0.05)) / 0.1
    return x * x * (3.0 - 2.0 * x)


# ─────────────────────────────────────────────────────────────────────────── the file set

def render_file(name: str, rng: random.Random) -> tuple[list, dict]:
    """Every file the game can ask for, by name. `--only` matches the prefix before the first underscore."""
    if name.startswith("horn") and name != "horn_low":
        return horn_samples(rng=random.Random(SEED ^ 0x0a))
    if name == "horn_low":
        return horn_samples(low=True, rng=random.Random(SEED ^ 0x0b))
    if name == "starter":
        return starter_samples(rng)
    if name == "shift":
        return shift_samples(rng)
    if name == "door":
        return door_samples(rng)
    if name.startswith("hit_"):
        return impact_samples(name[4:], rng)
    if name == "splash":
        return impact_samples("splash", rng)
    engine, band = name.split("_", 1)
    return engine_band_samples(engine, band, rng)


def all_names() -> list[str]:
    names = [f"{e}_{b}" for e in ENGINES for b in BANDS]
    names += ["horn", "horn_low", "starter", "shift", "door",
              "hit_thud", "hit_metal", "hit_glass", "hit_scrape", "splash"]
    return names


def wav_bytes(samples: list, rng: random.Random, sr: int = SAMPLE_RATE) -> bytes:
    frames = dither16(samples, rng)
    import io
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(frames)
    return bio.getvalue()


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def loop_is_seamless(samples: list, tol: float = 1.6) -> bool:
    """
    Whether the loop's join is a step the ear can find.

    The yardstick is the biggest step *inside* the file: in a truly periodic signal the step across the
    join is just another sample-to-sample step, so the ratio sits at or below 1 no matter how busy the
    content is. Anything well over 1 means the join is a discontinuity the signal itself never makes --
    a click, once every time round. Measuring against the median or a percentile instead is what makes a
    quiet idle loop look broken and a loud redline one look fine; the maximum is the honest comparison.
    """
    n = len(samples)
    if n < 64:
        return True
    seam = abs(samples[0] - samples[-1])
    biggest = 0.0
    for i in range(n - 1):
        d = samples[i + 1] - samples[i]
        if d < 0:
            d = -d
        if d > biggest:
            biggest = d
    return seam <= max(biggest * tol, 1e-4)


def loop_seam_ratio(samples: list) -> float:
    """The number loop_is_seamless judges, for the report: join step over the biggest step inside."""
    n = len(samples)
    if n < 64:
        return 0.0
    seam = abs(samples[0] - samples[-1])
    biggest = 0.0
    for i in range(n - 1):
        d = samples[i + 1] - samples[i]
        if d < 0:
            d = -d
        if d > biggest:
            biggest = d
    return seam / biggest if biggest > 0 else 0.0


def build(names: list[str], out_dir: str, write: bool = True) -> dict:
    """Render the named files, write them, and return the manifest the game reads."""
    entries = []
    for i, name in enumerate(names):
        rng = random.Random(SEED + 7919 * i)                 # per file, so one file's bytes never move another's
        samples, info = render_file(name, rng)
        loop = name.endswith(("_idle", "_cruise", "_redline"))
        if not loop:
            samples = fade_tail(samples)     # a one-shot must reach zero, or it clicks when it stops
        payload = wav_bytes(samples, random.Random(SEED + 13 * i))
        path = os.path.join(out_dir, f"{name}.wav")
        ok = loop_is_seamless(samples) if loop else None    # a one-shot has no seam to measure
        if write:
            os.makedirs(out_dir, exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(payload)
        entry = {
            "name": f"{name}.wav",
            "bytes": len(payload),
            "sha256": sha256(payload),
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
            "seconds": round(len(samples) / SAMPLE_RATE, 4),
            "loop": loop,
            "seamless": ok,
            "peak": round(peak(samples), 4),
            "rms": round(rms(samples), 4),
        }
        if "rpm" in info:
            entry["refRpm"] = info["rpm"]
            entry["firesPerSecond"] = info["firesPerSecond"]
            entry["cylinders"] = info["cylinders"]
        entry["render"] = info
        entries.append(entry)
    return {
        "generator": "tools/make_audio.py",
        "seed": SEED,
        "sampleRate": SAMPLE_RATE,
        "encoding": "16-bit signed PCM, mono, little-endian WAV",
        "licence": "CC0 1.0 Universal",
        "licenceNote": ("Rendered from numbers by this repository's own tool, from no third-party "
                        "recording: nothing to credit and nothing to take back."),
        "engines": {k: {kk: vv for kk, vv in v.items() if kk != "pattern"} for k, v in ENGINES.items()},
        "files": entries,
        "totalBytes": sum(e["bytes"] for e in entries),
    }


def read_manifest(out_dir: str = OUT_DIR) -> dict | None:
    path = os.path.join(out_dir, MANIFEST_NAME)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def verify(out_dir: str = OUT_DIR) -> list[str]:
    """Every file the manifest lists, on disk, with the bytes it promised. Returns what is wrong."""
    doc = read_manifest(out_dir)
    if doc is None:
        return [f"no manifest at {os.path.join(out_dir, MANIFEST_NAME)}: run tools/make_audio.py --write"]
    problems = []
    listed = set(all_names())
    seen = set()
    for e in doc["files"]:
        path = os.path.join(out_dir, e["name"])
        seen.add(e["name"])
        if not os.path.exists(path):
            problems.append(f"{e['name']}: listed but not on disk")
            continue
        with open(path, "rb") as fh:
            data = fh.read()
        if len(data) != e["bytes"]:
            problems.append(f"{e['name']}: {len(data)} bytes on disk, {e['bytes']} in the manifest")
        if sha256(data) != e["sha256"]:
            problems.append(f"{e['name']}: sha256 does not match the manifest")
    want = {f"{n}.wav" for n in listed}
    for missing in sorted(want - seen):
        problems.append(f"{missing}: the tool would render it and the manifest does not list it")
    return problems


def report(doc: dict) -> str:
    lines = [
        "# Audio",
        "",
        f"Rendered by `tools/make_audio.py` (seed `{doc['seed']}`), {len(doc['files'])} files, "
        f"{doc['totalBytes'] / 1e6:.2f} MB, {doc['sampleRate']} Hz, {doc['encoding']}.",
        "",
        "These are recordings in the sense that matters to the game: real audio files, decoded into "
        "`AudioBuffer`s and played back. What the browser does with them is level, pan, one rate change "
        "of no more than a fifth, and a muffle for a closed cabin. The synthesiser in `web/src/audio/dsp` "
        "is not asked for an engine any more while these load; `P.SAMPLES` tells it that the "
        "recordings are in charge, and the engine voice and horn fade out instead of doubling up.",
        "",
        "| file | seconds | loop | ref rpm | peak | RMS | bytes |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for e in doc["files"]:
        lines.append(
            f"| `{e['name']}` | {e['seconds']} | {'yes' if e['loop'] else 'one-shot'} | "
            f"{e.get('refRpm', '—')} | {e['peak']} | {e['rms']} | {e['bytes']:,} |")
    lines += [
        "",
        "## What each sound is made of",
        "",
        "| engine | cylinders | firing pattern (crank degrees per 720°) | exhaust note | description |",
        "| --- | --- | --- | --- | --- |",
    ]
    for key, spec in ENGINES.items():
        pattern = ", ".join(f"{v:g}" for v in spec["pattern"])
        lines.append(f"| `{key}` | {spec['cyl']} | {pattern} | {spec['pipe']:g} Hz | {spec['note']} |")
    lines += [
        "",
        "## Licence",
        "",
        f"{doc['licence']}. {doc['licenceNote']}",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0], allow_abbrev=False)
    ap.add_argument("--write", action="store_true", help="render and write the files and the manifest")
    ap.add_argument("--only", default="", help="comma-separated file prefixes (v8, horn, hit_thud)")
    ap.add_argument("--verify", action="store_true", help="check what is on disk against the manifest")
    ap.add_argument("--list", action="store_true", help="print the names this tool would render")
    ap.add_argument("--report", action="store_true", help="print docs/AUDIO.md")
    ap.add_argument("--out", default=OUT_DIR, help="where the files go")
    args = ap.parse_args(argv)

    if args.list:
        for n in all_names():
            print(n)
        return 0
    if args.report:
        doc = read_manifest(args.out) or build(all_names(), args.out, write=False)
        text = report(doc)
        if args.write:
            with open(os.path.join(ROOT, "docs", "AUDIO.md"), "w", encoding="utf-8") as fh:
                fh.write(text)
            print(f"docs/AUDIO.md: {len(doc['files'])} file(s), {doc['totalBytes'] / 1e6:.2f} MB")
            return 0
        print(text)
        return 0
    if args.verify:
        problems = verify(args.out)
        for p in problems:
            print(f"  {p}")
        print(f"audio: {'OK — ' + str(len(read_manifest(args.out)['files'])) + ' file(s) accounted for' if not problems else str(len(problems)) + ' problem(s)'}")
        return 1 if problems else 0

    names = all_names()
    if args.only:
        wanted = [w.strip() for w in args.only.split(",") if w.strip()]
        names = [n for n in names if any(n == w or n.startswith(w + "_") or n.startswith(w) for w in wanted)]
        if not names:
            print(f"nothing matches --only={args.only}; this tool knows: {', '.join(all_names())}", file=sys.stderr)
            return 2
    doc = build(names, args.out, write=args.write)
    for e in doc["files"]:
        flag = "   <-- seam too big for a loop" if e["seamless"] is False else ""
        print(f"  {e['name']:<18} {e['seconds']:>7.3f}s  {'loop' if e['loop'] else 'shot'}  "
              f"peak {e['peak']:.3f}  rms {e['rms']:.3f}  {e['bytes']:>9,} B{flag}")
    total = doc["totalBytes"]
    verb = "wrote" if args.write else "would write"
    print(f"{verb} {len(doc['files'])} file(s), {total / 1e6:.2f} MB into {os.path.relpath(args.out, ROOT)}")
    if args.write:
        with open(os.path.join(args.out, MANIFEST_NAME), "w", encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1)
            fh.write("\n")
        print(f"  {os.path.relpath(os.path.join(args.out, MANIFEST_NAME), ROOT)} written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
