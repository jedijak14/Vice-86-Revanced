#!/usr/bin/env python3
"""Vendor public-domain 3D models into the release, and keep the books on them.

The game ships its people as rigged, animated glTF files rather than geometry built in code, and a
model that arrives in somebody else's repository has two obligations that a font does not: it must be
licensed for use, and it must be *the file that was licensed*. This tool is the only way assets enter
`web/assets/`, and it does four things about each one:

  * reads the repository's licence file and refuses the whole source unless that text is a licence we
    can ship under (CC0, MIT, BSD, Apache-2.0) -- checked against the text, not against GitHub's
    `license` field, which is `NOASSERTION` for most of the packs here;
  * records the git blob id, the commit it came from, the byte count and the sha256 of the bytes that
    land in the workspace, per file, in a manifest the game itself reads at run time;
  * packs glTF's multi-file form (a .gltf with a .bin and any number of .png siblings) into one .glb,
    because a folder of loose parts is a download that half-succeeds;
  * verifies, offline and later, that what is on disk is what was recorded.

    python3 tools/vendor_models.py --list no-limit
    python3 tools/vendor_models.py --fetch no-limit --include 'library/animations/*.glb'
    python3 tools/vendor_models.py --verify
    python3 tools/vendor_models.py --report

`--fetch` needs the `gh` CLI (authenticated) or plain HTTPS to api.github.com. Nothing is downloaded
that is not matched by `--include`, and `--only` narrows further; both are globs against the path in
the *source repository*, which is what `--list` prints.

Stdlib only. `pack_glb`, `read_glb`, the licence check and the manifest bookkeeping are importable so
the tests in tools/test_vendor_models.py can drive them without a network.
"""

from __future__ import annotations

import argparse
import base64
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSET_ROOT = os.path.join(ROOT, "web", "assets", "models")
CACHE = os.path.join(HERE, ".vendor-cache")
MANIFEST_NAME = "manifest.json"

# Sources we know about: where to look, what licence text to expect, and what to call the pack here.
SOURCES = {
    "no-limit": {
        "repo": "NoLimitNexus/game-models",
        "ref": "main",
        "pack": "kaykit-animation",
        # The clips are KayKit's Character Animations 1.1 and the repository carries KayKit's own CC0
        # text under `licenses/`. The repository's *own* models under `library/ours` are theirs with no
        # licence file next to them, so this source exists to take the animations and is told to refuse
        # the rest: a mirror's README is not a grant.
        "licencePaths": ["licenses/"],
        "forbid": ["library/ours/", "character.js"],
        "note": "KayKit Character Animations 1.1: 131 clips on the Rig_Medium humanoid skeleton (CC0, Kay Lousberg), mirrored by NoLimitNexus.",
    },
    "kaykit-adventurers": {
        "repo": "KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0",
        "ref": "main",
        "pack": "kaykit-adventures",
        "licence": ["CC0-1.0", "Creative Commons"],
        "note": "KayKit Character Pack: Adventures, textured rigged humanoids and gear.",
    },
    "quaternius-city": {
        "repo": "tilakpatell/tilakverse-assets",
        "ref": "main",
        "pack": "quaternius-city",
        "licence": ["CC0-1.0", "Creative Commons", "MIT"],
        "note": "Quaternius downtown, street and furniture packs, mirrored as downloaded.",
    },
}

# What a licence has to say for us to ship the file. Matched case-insensitively against the text.
LICENCE_MARKS = [
    ("CC0", ("cc0", "public domain", "no rights reserved")),
    ("MIT", ("mit license", "permission is hereby granted, free of charge")),
    ("BSD", ("bsd-2-clause", "bsd 2-clause", "redistribution and use in source")),
    ("Apache-2.0", ("apache license, version 2", "apache-2.0")),
]


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob_sha(data: bytes) -> str:
    """git's own blob id: lets a reviewer check a vendored byte against the repository with plain git."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def classify_licence(text: str):
    """Which permissive licence this text is, or None. Checked against words in the file, not labels."""
    low = text.lower()
    for name, marks in LICENCE_MARKS:
        if any(m in low for m in marks):
            return name
    return None


# ───────────────────────────────────────────────── glTF <-> GLB packing

def _chunk(kind: bytes, payload: bytes) -> bytes:
    pad = (-len(payload)) % 4
    return len(payload).to_bytes(4, "little") + kind + payload + b" " * pad


def read_glb(data: bytes):
    """(json_dict, list_of_bin_chunks) from a GLB. Tolerates an absent BIN chunk."""
    if data[:4] != b"glTF":
        raise ValueError("not a glTF binary")
    version, length = int.from_bytes(data[4:8], "little"), int.from_bytes(data[8:12], "little")
    if version != 2:
        raise ValueError("only glTF 2.0 is packed, found version %d" % version)
    pos, json_body, bins = 12, None, []
    while pos + 8 <= min(length, len(data)):
        size = int.from_bytes(data[pos:pos + 4], "little")
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + size]
        if kind == b"JSON":
            json_body = json.loads(body.decode("utf-8"))
        elif kind == b"BIN\x00":
            bins.append(body)
        pos += 8 + size
    if json_body is None:
        raise ValueError("GLB has no JSON chunk")
    return json_body, (bins[0] if bins else b"")


def pack_glb(gltf_json: dict, resolve_external) -> bytes:
    """
    A single-file GLB from a .gltf plus its .bin and its images.

    `resolve_external(uri) -> bytes|None` supplies whatever the document points at. Every buffer and
    every image is folded into one binary chunk -- a texture that 404s is a grey pedestrian on the
    street and a .bin that 404s is no model at all -- so the shipped file cannot half-arrive.
    """
    doc = json.loads(json.dumps(gltf_json))          # work on a copy; the caller keeps its own
    blob = bytearray()

    def append(data: bytes) -> int:
        while len(blob) % 4:
            blob.append(0)
        off = len(blob)
        blob.extend(data)
        return off

    buffer_base = {}
    for i, buf in enumerate(doc.get("buffers", [])):
        uri = buf.get("uri")
        if uri is None:
            raise ValueError("buffer %d is already embedded; only external buffers are packed" % i)
        data = resolve_external(uri)
        if data is None:
            raise ValueError("missing buffer %r" % uri)
        buffer_base[i] = append(data)
        buf.pop("uri")
        buf["byteLength"] = len(data)

    for view in doc.get("bufferViews", []):
        base = buffer_base.get(view["buffer"])
        if base is None:
            continue                                  # an embedded buffer: nothing moved it
        view["byteOffset"] = base + view.get("byteOffset", 0)
        view["buffer"] = 0

    for im in doc.get("images", []):
        uri = im.get("uri")
        if uri is None or im.get("bufferView") is not None:
            continue
        data = resolve_external(uri)
        if data is None:
            raise ValueError("missing image %r" % uri)
        ext = uri.rsplit(".", 1)[-1].lower()
        im["mimeType"] = "image/png" if ext == "png" else "image/jpeg"
        im.pop("uri")
        off = append(data)
        doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": off, "byteLength": len(data)})
        im["bufferView"] = len(doc["bufferViews"]) - 1

    if doc.get("buffers"):
        doc["buffers"] = [{"byteLength": len(blob)}]
    while len(blob) % 4:
        blob.append(0)
    json_bytes = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    body = bytes(blob)
    total = 12 + 8 + len(json_bytes) + (8 + len(body) if len(body) else 0)
    out = b"glTF" + (2).to_bytes(4, "little") + total.to_bytes(4, "little")
    out += _chunk(b"JSON", json_bytes)
    if len(body):
        out += _chunk(b"BIN\x00", body)
    return out


def slim_glb(data: bytes, drop_morphs=True, drop_animations=True, drop_cameras=True):
    """
    Rebuild a GLB around only what the game will read, and report what that saved.

    The packs are authored in Blender and exported for engines: a character file carries facial morph
    targets and its own idle/walk clips, and a page that streams one per pedestrian has no use for
    either. Dropping a reference is not enough -- the bytes stay -- so the binary chunk is rebuilt from
    the buffer views that survive, and only those are copied.
    """
    doc, bin0 = read_glb(data)
    stats = {"before": len(data)}
    keep_views, drop = set(), []
    needed = set()

    def need_accessor(i):
        if i is None:
            return
        needed.add(i)

    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            if drop_morphs and prim.get("targets"):
                drop.append("morph targets on %s" % mesh.get("name", "mesh"))
                prim.pop("targets")
                if doc["meshes"]:
                    doc.setdefault("extensionsUsed", None)
            for name, acc in (prim.get("attributes") or {}).items():
                need_accessor(acc)
            need_accessor(prim.get("indices"))
    for skin in doc.get("skins", []):
        need_accessor(skin.get("inverseBindMatrices"))
    kept_anims = []
    for anim in doc.get("animations", []):
        if drop_animations:
            drop.append("clip %r" % anim.get("name", "?"))
            continue
        kept_anims.append(anim)
        for channel in anim.get("channels", []):
            sampler = anim.get("samplers", [])[channel["sampler"]]
            need_accessor(sampler.get("input"))
            need_accessor(sampler.get("output"))
    if drop_animations and doc.get("animations"):
        doc.pop("animations")
    if drop_cameras and doc.get("cameras"):
        doc.pop("cameras")
        drop.append("cameras")
    if kept_anims:
        doc["animations"] = kept_anims
    for im in doc.get("images", []):
        if im.get("bufferView") is not None:
            keep_views.add(im["bufferView"])

    views = doc.get("bufferViews", [])
    for acc in (doc.get("accessors") or []):
        if acc.get("bufferView") is None:
            continue
        # An accessor only stays if nothing that survived refers to it: prune in two passes, since
        # materials and textures were not touched above and may still point at views (images do).
    used_views = set(keep_views)
    for acc_index in needed:
        acc = doc["accessors"][acc_index]
        if acc.get("bufferView") is not None:
            used_views.add(acc["bufferView"])
    keep_acc = sorted(needed)
    new_of_acc = {old_i: n for n, old_i in enumerate(keep_acc)}

    blob = bytearray()
    new_views = []
    new_of_view = {}
    for old_i in sorted(used_views):
        v = dict(views[old_i])
        src = bin0[v["byteOffset"]: v["byteOffset"] + v["byteLength"]]
        while len(blob) % 4:
            blob.append(0)
        new_of_view[old_i] = len(new_views)
        v["byteOffset"] = len(blob)
        v.pop("byteStride", None)
        blob.extend(src)
        new_views.append(v)
    for mesh in doc.get("meshes", []):
        for prim in mesh.get("primitives", []):
            for name in list(prim.get("attributes") or {}):
                prim["attributes"][name] = new_of_acc[prim["attributes"][name]]
            if prim.get("indices") is not None:
                prim["indices"] = new_of_acc[prim["indices"]]
    for skin in doc.get("skins", []):
        if skin.get("inverseBindMatrices") is not None:
            skin["inverseBindMatrices"] = new_of_acc[skin["inverseBindMatrices"]]
    for anim in doc.get("animations", []):
        for sampler in anim.get("samplers", []):
            for key in ("input", "output"):
                if sampler.get(key) is not None:
                    sampler[key] = new_of_acc[sampler[key]]
    for im in doc.get("images", []):
        if im.get("bufferView") is not None:
            im["bufferView"] = new_of_view[im["bufferView"]]
    doc["accessors"] = [dict(doc["accessors"][i]) for i in keep_acc]
    for acc in doc["accessors"]:
        if acc.get("bufferView") is not None:
            acc["bufferView"] = new_of_view[acc["bufferView"]]
    doc["bufferViews"] = new_views
    doc["buffers"] = [{"byteLength": len(blob)}]
    while len(blob) % 4:
        blob.append(0)
    json_bytes = json.dumps(doc, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    while len(json_bytes) % 4:
        json_bytes += b" "
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    out = b"glTF" + (2).to_bytes(4, "little") + total.to_bytes(4, "little")
    out += _chunk(b"JSON", json_bytes) + _chunk(b"BIN\x00", bytes(blob))
    stats["after"] = len(out)
    return out, {"saved": len(data) - len(out), "dropped": sorted(set(drop))}


# ───────────────────────────────────────────────── GitHub reads

def _gh(api_path: str, *, binary=False):
    """`gh api` first: it is authenticated, and the anonymous rate limit dies on a recursive tree."""
    cmd = ["gh", "api", api_path]
    if not shutil.which("gh"):
        url = "https://api.github.com/" + api_path
        with urllib.request.urlopen(url, timeout=90) as r:
            body = r.read()
        return body if binary else json.loads(body)
    out = subprocess.run(cmd, capture_output=True, check=True)
    return out.stdout if binary else json.loads(out.stdout)


def tree(source: str, refresh=False):
    """The repository's recursive tree, cached: one API call per source per run."""
    cfg = SOURCES[source]
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, "%s-%s.tree.json" % (cfg["repo"].replace("/", "-"), cfg["ref"]))
    if os.path.exists(path) and not refresh:
        with open(path, "rb") as fh:
            return json.load(fh)
    data = _gh("repos/%s/git/trees/%s?recursive=1" % (cfg["repo"], cfg["ref"]))
    with open(path, "w") as fh:
        json.dump(data, fh)
    return data


def blob(source: str, sha: str) -> bytes:
    cfg = SOURCES[source]
    raw = _gh("repos/%s/git/blobs/%s" % (cfg["repo"], sha))
    return base64.b64decode(raw["content"]) if isinstance(raw, dict) else raw


def find_files(source: str, include, exclude=(), only=()):
    cfg = SOURCES[source]
    entries = tree(source).get("tree", [])
    by_path = {e["path"]: e for e in entries if e.get("type") == "blob"}
    hits, blocked_hits = [], []
    for path, e in sorted(by_path.items()):
        if not any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(os.path.basename(path), g) for g in include):
            continue
        if exclude and any(fnmatch.fnmatch(path, g) or fnmatch.fnmatch(os.path.basename(path), g) for g in exclude):
            continue
        if only and not any(name in path for name in only):
            continue
        if any(path.startswith(blocked) for blocked in cfg.get("forbid", ())):
            blocked_hits.append(path)
            continue
        hits.append({"path": path, "sha": e["sha"], "size": e.get("size", 0)})
    if blocked_hits:
        print("  %d file(s) refused as unlicensed for reuse: %s%s"
              % (len(blocked_hits), ", ".join(blocked_hits[:4]), " ..." if len(blocked_hits) > 4 else ""), file=sys.stderr)
    return cfg, by_path, hits


def licence_of(source: str, by_path):
    cfg = SOURCES[source]
    cfg = SOURCES[source]
    dirs = tuple(cfg.get("licencePaths") or ())
    want = re.compile(r"(?i)(^|/)(legal|licenses|licence|license)(/|$)|(^|/)(license|licence|copying|notice|unlicense)(\.(txt|md))?$")
    found = [p for p in by_path if (p.startswith(dirs) if dirs else False) or want.search(p)]
    texts = []
    for path in sorted(found, key=lambda p: (p.count("/"), p))[:4]:
        texts.append((path, blob(source, by_path[path]["sha"]).decode("utf-8", "replace")))
    if not texts:
        return None, "no licence file found in the repository"
    for path, text in texts:
        kind = classify_licence(text)
        if kind:
            return {"kind": kind, "path": path, "sha256": sha256(text.encode("utf-8")), "bytes": len(text.encode("utf-8"))}, None
    return None, "no licence we can ship: %s" % ", ".join(p for p, _ in texts)


# ───────────────────────────────────────────────── manifests

def manifest_path(pack: str) -> str:
    return os.path.join(ASSET_ROOT, pack, MANIFEST_NAME)


def read_manifest(pack: str):
    path = manifest_path(pack)
    if not os.path.exists(path):
        return {"pack": pack, "files": []}
    with open(path) as fh:
        return json.load(fh)


def write_manifest(pack: str, doc: dict):
    os.makedirs(os.path.join(ASSET_ROOT, pack), exist_ok=True)
    doc.setdefault("pack", pack)
    doc["files"] = sorted(doc.get("files", []), key=lambda f: f["local"])
    doc["totalBytes"] = sum(f["bytes"] for f in doc["files"])
    doc["generatedBy"] = "tools/vendor_models.py"
    with open(manifest_path(pack), "w") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")


def top_manifest():
    """One file the game can read: every pack, its licence, and what it weighs."""
    packs = []
    for name in sorted(os.listdir(ASSET_ROOT)) if os.path.isdir(ASSET_ROOT) else []:
        if not os.path.exists(manifest_path(name)):
            continue
        m = read_manifest(name)
        packs.append({"pack": name, "source": m.get("source"), "ref": m.get("ref"), "licence": m.get("licence", {}).get("kind"),
                      "files": [f["local"] for f in m["files"]], "fileCount": len(m["files"]),
                      "bytes": m["totalBytes"], "note": m.get("note")})
    doc = {"schema": 1, "packs": packs, "totalBytes": sum(p["bytes"] for p in packs)}
    os.makedirs(ASSET_ROOT, exist_ok=True)
    with open(os.path.join(ASSET_ROOT, MANIFEST_NAME), "w") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")
    return doc


# ───────────────────────────────────────────────── commands

def cmd_list(args):
    cfg, by_path, hits = find_files(args.source, args.include, args.exclude, args.only)
    total = sum(h["size"] for h in hits)
    print("%s @ %s: %d file(s) matched, %.2f MB in the source" % (cfg["repo"], cfg["ref"], len(hits), total / 1e6))
    for h in hits[: args.limit]:
        print("  %9d  %s" % (h["size"], h["path"]))
    if len(hits) > args.limit:
        print("  … %d more (raise --limit)" % (len(hits) - args.limit))
    if not hits:
        print("  nothing matched: run with --include against the paths this prints", file=sys.stderr)
        return 1
    return 0


def cmd_fetch(args):
    cfg, by_path, hits = find_files(args.source, args.include, args.exclude, args.only)
    if not hits:
        print("refusing to fetch nothing", file=sys.stderr)
        return 1
    lic, why = licence_of(args.source, by_path)
    if not lic:
        print("refused: %s" % why, file=sys.stderr)
        return 1
    print("%s: %s at %s" % (cfg["repo"], lic["kind"], lic["path"]))
    manifest = read_manifest(cfg["pack"])
    manifest.update({"source": cfg["repo"], "ref": cfg["ref"], "licence": lic, "note": cfg["note"]})
    known = {f["local"]: f for f in manifest["files"]}
    want_bytes = sum(h["size"] for h in hits)
    if args.max_mb and want_bytes > args.max_mb * 1e6:
        print("refused: %.2f MB matched, --max-mb is %s" % (want_bytes / 1e6, args.max_mb), file=sys.stderr)
        return 1
    # A .gltf is only half a model: its .bin and its textures sit in the same folder, so keep every
    # one of those addressable by path while packing, whether or not it matched --include.
    loose = {p: e for p, e in by_path.items() if p.endswith((".bin", ".png", ".jpg", ".jpeg"))}
    hits = [h for h in hits if h["path"].endswith((".gltf", ".glb"))]
    fetched = 0
    for h in [x for x in hits if x["path"].endswith((".gltf", ".glb"))]:
        name = os.path.splitext(os.path.basename(h["path"]))[0] + ".glb"
        rel = os.path.join(cfg["pack"], name)
        data = blob(args.source, h["sha"])
        if h["path"].endswith(".gltf"):
            doc = json.loads(data.decode("utf-8"))
            base = os.path.dirname(h["path"])

            def resolve(uri, _base=base):
                key = os.path.normpath(os.path.join(_base, uri)).replace(os.sep, "/")
                e = loose.get(key)
                return blob(args.source, e["sha"]) if e else None
            try:
                data = pack_glb(doc, resolve)
            except ValueError as err:
                print("  skipped %s: %s" % (h["path"], err), file=sys.stderr)
                continue
        if args.slim:
            before = len(data)
            data, rep = slim_glb(data)
            slim_report = rep["dropped"]
            print("      slimmed %.1f KB \u2192 %.1f KB (%.0f%% off: %s)" % (before / 1024, len(data) / 1024, 100 * (before - len(data)) / before, "; ".join(slim_report) or "nothing extra"))
        out = os.path.join(ASSET_ROOT, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as fh:
            fh.write(data)
        known[rel] = {"local": rel, "source": h["path"], "bytes": len(data), "sha256": sha256(data),
                      "gitBlob": git_blob_sha(data), "srcBytes": h["size"]}
        fetched += 1
        print("  %-46s %8.1f KB  %s" % (rel, len(data) / 1024, sha256(data)[:12]))
    manifest["files"] = list(known.values())
    write_manifest(cfg["pack"], manifest)
    top_manifest()
    print("%d file(s) into web/assets/models/%s" % (fetched, cfg["pack"]))
    return 0


def cmd_verify(args):
    bad, checked = [], 0
    packs = args.packs or sorted(p for p in (os.listdir(ASSET_ROOT) if os.path.isdir(ASSET_ROOT) else []) if os.path.exists(manifest_path(p)))
    for pack in packs:
        m = read_manifest(pack)
        for f in m["files"]:
            path = os.path.join(ASSET_ROOT, f["local"])
            checked += 1
            if not os.path.exists(path):
                bad.append("%s: missing" % f["local"])
                continue
            data = open(path, "rb").read()
            if sha256(data) != f["sha256"]:
                bad.append("%s: bytes differ from the manifest" % f["local"])
            elif git_blob_sha(data) != f.get("gitBlob"):
                bad.append("%s: git blob id differs" % f["local"])
        if m.get("licence", {}).get("sha256"):
            pass
    print("%d file(s) in %d pack(s): %s" % (checked, len(packs), "all accounted for" if not bad else "%d PROBLEM(S)" % len(bad)))
    for b in bad:
        print("  " + b, file=sys.stderr)
    return 1 if bad else 0


def cmd_report(args):
    doc = top_manifest()
    lines = ["# Asset accounting", "",
             "Every 3D model, animation and texture the shipped page can ask for, with where it came",
             "from and what it weighs. `tools/vendor_models.py --verify` re-checks these bytes.", ""]
    if not doc["packs"]:
        lines += ["No packs are vendored yet: `python3 tools/vendor_models.py --fetch <source>`.", ""]
    for p in doc["packs"]:
        m = read_manifest(p["pack"])
        lines += ["## %s" % p["pack"], "",
                  "- source: `%s` at `%s`" % (p["source"], p["ref"]),
                  "- licence: **%s** (`%s` in the source repository)" % (p["licence"], m["licence"]["path"]),
                  "- %d file(s), %.2f MB" % (p.get("fileCount", len(p["files"])), p["bytes"] / 1e6),
                  "- %s" % p["note"], "",
                  "| file | bytes | sha256 | from |", "| --- | ---: | --- | --- |"]
        for f in m["files"]:
            lines.append("| `%s` | %s | `%s` | `%s` |" % (f["local"], f["bytes"], f["sha256"][:12], f["source"]))
        lines.append("")
    lines += ["Total in the shipped page: **%.2f MB** of model data across %d pack(s)."
              % (doc["totalBytes"] / 1e6, len(doc["packs"])), ""]
    text = "\n".join(lines)
    if args.write:
        with open(os.path.join(ROOT, "docs", "ASSETS.md"), "w") as fh:
            fh.write(text)
        print("wrote docs/ASSETS.md (%d lines)" % text.count("\n"))
    else:
        print(text)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", dest="list_source", metavar="SOURCE", choices=sorted(SOURCES), help="what a source has, no writes")
    ap.add_argument("--fetch", dest="fetch_source", metavar="SOURCE", choices=sorted(SOURCES), help="download and vendor into web/assets/models")
    ap.add_argument("--verify", action="store_true", help="check the workspace against every manifest")
    ap.add_argument("--report", action="store_true", help="print the asset accounting")
    ap.add_argument("--write", action="store_true", help="with --report, write docs/ASSETS.md")
    ap.add_argument("--include", action="append", default=[], help="glob of paths to take (repeatable)")
    ap.add_argument("--exclude", action="append", default=["*.blend", "*.fbx", "*.unity", "*.meta", "*.import"])
    ap.add_argument("--only", action="append", default=[], help="substring a path must contain")
    ap.add_argument("--max-mb", type=float, default=14.0, help="refuse a fetch bigger than this")
    ap.add_argument("--limit", type=int, default=40, help="rows --list prints")
    ap.add_argument("--packs", action="append", default=[], help="with --verify, only these packs")
    ap.add_argument("--refresh", action="store_true", help="re-read the remote tree instead of the cache")
    ap.add_argument("--slim", action="store_true", help="strip morph targets, clips and unused bytes from character files")
    args = ap.parse_args(argv)
    if args.list_source or args.fetch_source:
        args.source = args.list_source or args.fetch_source
        tree(args.source, refresh=args.refresh)      # one API call, cached under tools/.vendor-cache
        if args.list_source:
            return cmd_list(args)
        if not args.include:
            print("--fetch needs at least one --include glob", file=sys.stderr)
            return 2
        return cmd_fetch(args)
    if args.verify:
        return cmd_verify(args)
    if args.report:
        return cmd_report(args)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
