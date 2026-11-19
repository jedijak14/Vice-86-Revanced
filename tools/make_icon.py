#!/usr/bin/env python3
"""Draw the desktop icon and write it as a real multi-size .ico.

The rest of this project synthesises what it needs — engines, hulls, citizens, music — rather than
downloading it, and the icon is the last thing left that came from nowhere. So it is drawn here: a
dusk skyline over wet asphalt, in code, at every size Windows asks for, and written as an ICO with
PNG payload at 256 and 32-bit BMP payload below it (the spec's own recommendation, and the shape
rcedit expects when it stamps the executable).

Everything is stdlib: zlib for the PNG streams, struct for the containers. The picture is drawn at
4x and box-filtered down, so the small sizes are not the large size with the detail thrown away.

    python3 tools/make_icon.py            # write desktop/build/icon.ico
    python3 tools/make_icon.py --check    # draw, then verify what is on disk matches
"""

from __future__ import annotations

import hashlib
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "desktop", "build", "icon.ico")
SUPER = 4                      # draw at 4x, box-filter down
SIZES = (256, 64, 48, 32, 16)  # what goes in the file, largest first

# The palette, as the sky actually is at the hour the game starts: a low sun behind the buildings,
# the road still holding the day's light, and windows already on.
SKY_TOP = (16, 14, 42)
SKY_LOW = (214, 96, 58)
SUN = (255, 196, 108)
HAZE = (96, 60, 96)
BUILDING = (10, 10, 20)
BUILDING_LIT = (26, 24, 40)
WINDOW = (255, 214, 132)
NEON = (92, 226, 255)
ROAD = (24, 22, 32)
DASH = (226, 214, 186)


def clamp(v: float, lo: float = 0.0, hi: float = 255.0) -> float:
    return lo if v < lo else hi if v > hi else v


def mix(a, b, t: float):
    t = clamp(t, 0.0, 1.0)
    return tuple(int(round(clamp(a[i] + (b[i] - a[i]) * t))) for i in range(3))


def draw(size: int) -> bytes:
    """`size`x`size` RGBA pixels, row-major, drawn at SUPER x and box-filtered down."""
    s = size * SUPER
    buf = bytearray(s * s * 4)
    horizon = 0.62 * s
    sun_x, sun_y, sun_r = 0.35 * s, 0.34 * s, 0.13 * s

    def put(x: int, y: int, rgb, a: int = 255) -> None:
        i = (y * s + x) * 4
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = a

    # Sky: a vertical gradient with the sun bleeding into it near the horizon.
    for y in range(int(horizon) + 1):
        t = y / horizon
        base = mix(SKY_TOP, SKY_LOW, t ** 1.35)
        haze = mix(base, HAZE, 0.28 * (1.0 - abs(t - 0.82) / 0.82))
        for x in range(s):
            d = ((x - sun_x) ** 2 + ((y - sun_y) * 1.15) ** 2) ** 0.5
            glow = clamp(1.0 - d / (sun_r * 2.6)) ** 2.2
            disc = 1.0 if d < sun_r else clamp(1.0 - (d - sun_r) / (0.02 * s))
            band = clamp(1.0 - abs(y - horizon) / (0.18 * s)) ** 2.0
            c = mix(haze, SUN, max(glow * 0.75, disc, band * 0.5))
            put(x, y, c)

    # Water below the skyline, then the road over it: the icon reads as a city with a shore.
    for y in range(int(horizon) + 1, s):
        t = (y - horizon) / (s - horizon)
        base = mix(SKY_LOW, ROAD, 0.35 + 0.65 * t)
        for x in range(s):
            d = ((x - sun_x) ** 2 + ((y - sun_y) * 0.5) ** 2) ** 0.5
            glint = clamp(1.0 - d / (sun_r * 2.2)) ** 3.0
            put(x, y, mix(base, SUN, glint * 0.5 * (1.0 - t)))

    # Skyline: two rows of blocks, the far row hazier, the near row darker and taller on the right.
    blocks = [
        (0.00, 0.10, 0.30, HAZE, 0.0), (0.09, 0.20, 0.42, HAZE, 0.0), (0.18, 0.26, 0.24, HAZE, 0.0),
        (0.25, 0.36, 0.50, HAZE, 0.0), (0.35, 0.44, 0.34, HAZE, 0.0), (0.43, 0.55, 0.46, HAZE, 0.0),
        (0.54, 0.63, 0.28, HAZE, 0.0), (0.62, 0.74, 0.40, HAZE, 0.0), (0.73, 0.82, 0.30, HAZE, 0.0),
        (0.81, 0.92, 0.52, HAZE, 0.0), (0.91, 1.00, 0.32, HAZE, 0.0),
        (0.02, 0.16, 0.40, BUILDING, 1.0), (0.15, 0.30, 0.58, BUILDING_LIT, 1.0),
        (0.29, 0.42, 0.36, BUILDING, 1.0), (0.41, 0.58, 0.66, BUILDING_LIT, 1.0),
        (0.57, 0.70, 0.44, BUILDING, 1.0), (0.69, 0.86, 0.72, BUILDING_LIT, 1.0),
        (0.85, 0.99, 0.48, BUILDING, 1.0),
    ]
    for x0, x1, top, colour, near in blocks:
        left, right, roof = int(x0 * s), int(x1 * s), int(horizon - top * 0.62 * s)
        for y in range(max(roof, 0), int(horizon) + 1):
            for x in range(left, min(right, s)):
                put(x, y, colour)
        if near:
            # Lit windows on a 5x7 cell grid, deterministic: every fourth window dark, so the
            # skyline is inhabited rather than a wall of light.
            cw, ch = max(2, int(0.028 * s)), max(3, int(0.042 * s))
            gx = max(1, (right - left) // (cw * 2))
            gy = max(1, (int(horizon) - roof) // (ch * 2))
            for i in range(gx):
                for j in range(gy):
                    wx = left + cw // 2 + i * ((right - left - cw) // gx)
                    wy = roof + ch // 2 + j * ((int(horizon) - roof - ch) // gy)
                    if (i * 7 + j * 3 + int(x0 * 100)) % 4 == 0:
                        continue
                    for y in range(wy, min(wy + ch, int(horizon))):
                        for x in range(wx, min(wx + cw, right)):
                            put(x, y, WINDOW)

    # One neon sign, because it is that kind of city.
    nx, ny, nw, nh = int(0.455 * s), int(0.44 * s), int(0.05 * s), int(0.16 * s)
    for y in range(ny, ny + nh):
        for x in range(nx, nx + nw):
            if x < nx + 2 or x >= nx + nw - 2 or y < ny + 2 or y >= ny + nh - 2:
                put(x, y, NEON)

    # The road: a perspective wedge from the horizon to the bottom edge, with dashes down the middle.
    for y in range(int(horizon), s):
        t = (y - horizon) / (s - horizon)
        half = 0.04 * s + t * 0.62 * s
        for x in range(max(0, int(s / 2 - half)), min(s, int(s / 2 + half))):
            put(x, y, mix(ROAD, (46, 40, 56), 0.35 * t))
        band = int((y * 0.035) % 3)
        if band == 0 and t > 0.06:
            w = int(0.012 * s + t * 0.05 * s)
            for x in range(int(s / 2 - w / 2), int(s / 2 + w / 2)):
                if 0 <= x < s:
                    put(x, y, mix(DASH, ROAD, 0.25 * t))

    # A rounded mask: an app icon is not a square of sky.
    r = s * 0.19
    for y in range(s):
        for x in range(s):
            cx = min(x, s - 1 - x) - r
            cy = min(y, s - 1 - y) - r
            if cx < 0 and cy < 0 and (cx * cx + cy * cy) > r * r:
                put(x, y, (0, 0, 0), 0)

    # Box-filter down to the requested size.
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            a = r_ = g = b = 0
            for dy in range(SUPER):
                for dx in range(SUPER):
                    i = (((y * SUPER + dy) * s) + (x * SUPER + dx)) * 4
                    alpha = buf[i + 3]
                    r_ += buf[i] * alpha; g += buf[i + 1] * alpha; b += buf[i + 2] * alpha; a += alpha
            j = (y * size + x) * 4
            out[j + 3] = a // (SUPER * SUPER)
            if a:
                out[j] = r_ // a; out[j + 1] = g // a; out[j + 2] = b // a
    return bytes(out)


def png(size: int, rgba: bytes) -> bytes:
    """An RGBA PNG, filter 0 on every row: the icon is a drawing, not a photograph."""
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def bmp(size: int, rgba: bytes) -> bytes:
    """A 32-bit BGRA icon image: XOR bitmap, then the 1-bit AND mask, both bottom-up."""
    xor = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            i = (y * size + x) * 4
            a = rgba[i + 3]
            # Premultiply: an ICO's alpha is honoured, but a masked-out pixel should still be black.
            xor += bytes((rgba[i + 2] * a // 255, rgba[i + 1] * a // 255, rgba[i] * a // 255, a))
    row = (size + 31) // 32 * 4
    and_ = bytearray()
    for y in range(size - 1, -1, -1):
        line = bytearray(row)
        for x in range(size):
            if rgba[(y * size + x) * 4 + 3] < 128:
                line[x // 8] |= 0x80 >> (x % 8)
        and_ += line
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, len(xor) + len(and_), 0, 0, 0, 0)
    return header + bytes(xor) + bytes(and_)


def build() -> bytes:
    """The whole file: one directory, then each size's payload in order."""
    payloads = []
    for size in SIZES:
        rgba = draw(size)
        payloads.append(png(size, rgba) if size >= 256 else bmp(size, rgba))
    count = len(SIZES)
    head = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count
    entries = b""
    for size, payload in zip(SIZES, payloads):
        w = 0 if size >= 256 else size          # the spec's own shorthand for 256
        entries += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(payload), offset)
        offset += len(payload)
    return head + entries + b"".join(payloads)


def main(argv: list[str]) -> int:
    data = build()
    digest = hashlib.sha256(data).hexdigest()
    if "--check" in argv:
        if not os.path.exists(OUT):
            print(f"{OUT}: missing")
            return 1
        same = hashlib.sha256(open(OUT, "rb").read()).hexdigest() == digest
        print(f"{OUT}: {'matches' if same else 'STALE'}  {len(data):,} B  sha256 {digest[:16]}")
        return 0 if same else 1
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(data)
    print(f"{OUT}: wrote {len(data):,} B for {SIZES}  sha256 {digest[:16]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
