#!/usr/bin/env python3
"""
Tests for the vendor tool: the parts of it that keep the fork's promise about its assets.

The game refuses to draw a model that is not in the manifest, and the manifest refuses to gain a file
whose licence text the tool has read and classified. Those two refusals are the whole of "no placeholder
art and no borrowed bytes we cannot ship", so they are worth testing without a browser, a GPU or a
network. Nothing here reaches out: the checks run over the bytes already vendored in web/assets/models
and over GLBs built in memory.

    python3 tools/test_vendor_models.py
"""

import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import vendor_models as vm  # noqa: E402  (the tool is a sibling script, not a package)

PASSED = 0
FAILED = []


def check(label, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        return
    FAILED.append("%s%s" % (label, (": " + detail) if detail else ""))


def eq(label, got, want):
    check(label, got == want, "got %r, want %r" % (got, want))


def chunk(kind, payload, pad=b" "):
    # A GLB chunk's length includes its own padding: the spec says so, and the game's loader says so.
    padded = payload + pad * ((-len(payload)) % 4)
    return len(padded).to_bytes(4, "little") + kind + padded


def build_glb(gltf):
    """A GLB from a dict and an optional `__bin` bytes entry, the way the packer wants it."""
    body = dict(gltf)
    bins = body.pop("__bin", b"")
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    json_chunk = chunk(b"JSON", data)
    bin_chunk = chunk(b"BIN\x00", bins, b"\x00") if bins else b""
    total = 12 + len(json_chunk) + len(bin_chunk)
    # The GLB header is twelve bytes and no more: magic, version, total length. The chunks follow at 12.
    return b"glTF" + struct.pack("<II", 2, total) + json_chunk + bin_chunk


# ─────────────────────────────────────────────────────────── the licence gate

CC0 = """CC0 1.0 Universal

THE PERSON WHO ASSOCIATED A CC0 WORK WITH THIS DEED HAS DEDICATED THE WORK
TO THE PUBLIC DOMAIN.
"""
RESERVED = """Copyright (c) 2024 Somebody Ltd

All rights reserved. No part of this work may be reproduced, distributed,
or transmitted in any form without the prior written permission of the
copyright owner.
"""
MIT = """MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
"""

eq("CC0 is recognised", vm.classify_licence(CC0), "CC0")
eq("MIT is recognised", vm.classify_licence(MIT), "MIT")
eq("an all-rights-reserved notice is not a licence the game can ship", vm.classify_licence(RESERVED), None)
eq("an empty licence is not a licence", vm.classify_licence(""), None)
eq("a licence file that is only a name is not a licence", vm.classify_licence("License\n"), None)
check("a CC0-with-a-copyright line still ships", vm.classify_licence("Copyright 2024\n" + CC0) == "CC0")

# ─────────────────────────────────────────────────────────────── glb packing

glb = build_glb({
    "asset": {"version": "2.0"},
    "meshes": [{"name": "body", "primitives": [{"attributes": {"POSITION": 0}, "targets": [{"POSITION": 1}]}]}],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3"},
        {"bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3"},
    ],
    "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": 36},
        {"buffer": 0, "byteOffset": 36, "byteLength": 36},
    ],
    "buffers": [{"byteLength": 72}],
    "animations": [{"name": "Walk", "channels": [], "samplers": []}],
    "cameras": [{"name": "Camera", "type": "perspective"}],
    "__bin": bytes(72),
})
body, binchunk = vm.read_glb(glb)
check("a built GLB reads back", body["asset"]["version"] == "2.0")
eq("the BIN chunk came along", len(binchunk), 72)

trimmed, report = vm.slim_glb(glb)
tb, _ = vm.read_glb(trimmed)
prim = tb["meshes"][0]["primitives"][0]
check("the morph target the game cannot use is gone", not prim.get("targets"), json.dumps(prim))
check("the clip is gone", not tb.get("animations"), json.dumps(tb.get("animations")))
check("the camera is gone", not tb.get("cameras"), json.dumps(tb.get("cameras")))
check("the mesh itself survived the trim", "POSITION" in prim["attributes"] and len(tb["accessors"]) == 1,
      json.dumps(prim["attributes"]) + " / " + str(len(tb["accessors"])))
check("the bytes of a dropped accessor went with it", len(trimmed) < len(glb), "%d against %d" % (len(trimmed), len(glb)))
check("the report says what it dropped, in words a reviewer can read",
      any("morph" in d for d in report["dropped"]) and any("Walk" in d for d in report["dropped"])
      and "cameras" in report["dropped"], json.dumps(report))
eq("the report's saving is the difference in bytes", report["saved"], len(glb) - len(trimmed))
check("a slim GLB is still a GLB the loader will accept", trimmed[:4] == b"glTF")

try:
    vm.read_glb(b"not a gltf at all")
    check("a file that is not a GLB is refused", False, "read_glb accepted junk")
except ValueError:
    check("a file that is not a GLB is refused", True)

# An external buffer reference is the failure the packer exists to prevent: the GLB would load and the
# geometry would 404, which in a game is an invisible pedestrian rather than an error.
external = {"asset": {"version": "2.0"}, "buffers": [{"uri": "body.bin", "byteLength": 72}]}
try:
    vm.pack_glb(external, lambda uri: None)
    check("a GLB that still points at a separate .bin is refused", False, "pack_glb allowed an external buffer")
except Exception as error:
    check("a GLB that still points at a separate .bin is refused", True, type(error).__name__)

packed = vm.pack_glb(external, lambda uri: bytes(72))
pb, pbin = vm.read_glb(packed)
eq("the external buffer was inlined", len(pbin), 72)
check("no URI is left pointing outside the file", "uri" not in pb["buffers"][0], json.dumps(pb["buffers"]))

# ─────────────────────────────────────────────────── the shipped manifests

top = vm.top_manifest()
check("the roll-up manifest exists", bool(top.get("packs")), "no packs: run --fetch, or the gate has nothing to allow")
listed = sum(p.get("fileCount", len(p["files"])) for p in top["packs"])
total = 0
for p in top["packs"]:
    pack_dir = os.path.join(vm.ASSET_ROOT, p["pack"])
    on_disk = sorted(f for f in os.listdir(pack_dir) if f.endswith(".glb"))
    eq("%s: every file on disk is in the manifest" % p["pack"],
       sorted(os.path.basename(f) for f in p["files"]), on_disk)
    pack_manifest = vm.read_manifest(p["pack"])
    lic = pack_manifest["licence"]
    check("%s: the licence the manifest names is one the game may ship" % p["pack"],
          lic.get("kind") in dict(vm.LICENCE_MARKS), str(lic.get("kind")))
    check("%s: a licence text was read and hashed, not a label typed in" % p["pack"],
          len(lic.get("sha256", "")) == 64 and lic.get("bytes", 0) > 0, json.dumps(lic))
    eq("%s: the manifest's own byte count is the sum of its files" % p["pack"],
       pack_manifest["totalBytes"], sum(f["bytes"] for f in pack_manifest["files"]))
    for f in pack_manifest["files"]:
        path = os.path.join(vm.ASSET_ROOT, f["local"])
        check("%s: the file the manifest lists is there" % f["local"], os.path.exists(path))
        if not os.path.exists(path):
            continue
        data = open(path, "rb").read()
        eq("%s: the bytes match the manifest" % f["local"], vm.sha256(data), f["sha256"])
        eq("%s: the git blob id matches" % f["local"], vm.git_blob_sha(data), f.get("gitBlob"))
        check("%s: a real GLB, version 2" % f["local"], data[:8] == b"glTF" + struct.pack("<I", 2))
        total += f["bytes"]

eq("the roll-up's byte count is the sum of the packs", top["totalBytes"], total)
eq("the file count is the sum of the packs", listed, sum(len(vm.read_manifest(p["pack"])["files"]) for p in top["packs"]))

# The run-time gate (world/people/cast.js) refuses any .glb the manifest does not name, so the two ways of
# counting the same thing have to agree, or the game draws nobody and the tool still reports success.
for pack in os.listdir(vm.ASSET_ROOT):
    dir_path = os.path.join(vm.ASSET_ROOT, pack)
    if not os.path.isdir(dir_path):
        continue
    on_disk = sorted(f for f in os.listdir(dir_path) if f.endswith(".glb"))
    named = sorted(os.path.basename(f["local"]) for f in vm.read_manifest(pack)["files"])
    eq("%s: no unaccounted-for bytes in the shipped page" % pack, on_disk, named)

# ────────────────────────────────────────────────────────────── the report

if os.path.exists(os.path.join(ROOT, "docs", "ASSETS.md")):
    doc = open(os.path.join(ROOT, "docs", "ASSETS.md")).read()
    missing = [f["local"] for p in top["packs"] for f in vm.read_manifest(p["pack"])["files"] if f["local"] not in doc]
    eq("docs/ASSETS.md names every shipped file", missing, [])
    check("docs/ASSETS.md gives a licence for every pack", doc.count("licence:") >= len(top["packs"]))
    check("docs/ASSETS.md counts the bytes", "Total in the shipped page" in doc)
else:
    check("docs/ASSETS.md exists", False, "run: python3 tools/vendor_models.py --report --write")

print("%d check(s) passed" % PASSED)
if FAILED:
    print("%d FAILED:" % len(FAILED))
    for f in FAILED:
        print("  - " + f)
    sys.exit(1)
