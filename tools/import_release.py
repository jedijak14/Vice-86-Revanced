#!/usr/bin/env python3
"""Verify and refresh the vendored public runtime of VICE '86, without executing downloaded code.

The playable tree is `web/`: the release's own files, byte for byte, plus this fork's modules.
`--verify` (the default) is offline: it checks every byte of the pinned release against
`tools/upstream-lock.json`, checks that nothing a module refers to is missing, and lists what the
fork added. It needs Python 3.9 and no packages.

`--import` downloads the release again into a staging directory (`--out`, default
`.vice-snapshot/`) with the raw bytes and a fresh lock; `--sync` then copies a verified staging
snapshot into `web/`, rewriting the shell's asset paths and leaving any file this fork has changed
alone unless `--force`. Nothing is fetched during verification, so a checkout can be checked on a
machine with no network at all.

The release is pinned by its version id. If the live site no longer serves that id, `--import`
refuses to run rather than mix two releases: use the snapshot that is already committed.
"""

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit
import zipfile

ORIGIN = 'https://heat.pplx.app/'
RELEASE = '9d646599b896'
PREFIX = 'r/' + RELEASE + '/'
ENTRY = PREFIX + 'src/main.js'
STYLE = PREFIX + 'style.css'
MANIFEST = 'release-lock.json'
WEB = Path('web')
LOCK = Path('tools/upstream-lock.json')
# The shell is the one release file the fork edits: the two asset paths are made relative to
# `web/` and the engine's own name is added under the wordmark. Everything else is copied as it is.
SHELL = 'index.html'

# This release expresses worker entry points, the city layout, the optional
# world builders and the lazy garage models as module-relative literals. A
# walker of `import ... from` alone silently drops all four of those groups.
REFERENCE = re.compile(r'''(['\"`])(\.{1,2}/[A-Za-z0-9_./-]+\.(?:[cm]?js|json|css|glsl|vert|frag|wasm))\1''')
SCRIPT_TYPE = ('.js', '.mjs', '.cjs', '.css')
# The deployed app has no media assets. Do not copy other pages or third-party URLs.
SAFE_PATH = re.compile(r'^[A-Za-z0-9_./-]+$')
MAX_FILE = 20 * 1024 * 1024
MAX_FILES = 2500


def dependencies(path, body):
    if not path.endswith(SCRIPT_TYPE):
        return set()
    source = body.decode('utf-8')
    # Ignore documentation examples; actual runtime paths are quoted literals.
    source = re.sub(r'/\*[\s\S]*?\*/|(?m:^\s*//[^\n]*)', '', source)
    result = set()
    # Some wasm-bindgen builds use a bare filename in new URL(..., import.meta.url).
    url_files = re.findall(r'''new\s+URL\(\s*['\"]([\w.-]+\.wasm)['\"]\s*,\s*import\.meta\.url''', source)
    references = [m[2] for m in REFERENCE.finditer(source)]
    if path.endswith('src/render/index.js'):
        # createRenderer imports ./families/${name}.js for each FAMILY_NAMES entry.
        references.extend(f'./families/{name}.js' for name in
                          ('solid', 'ground', 'facade', 'vehicle', 'foliage', 'glass'))
    if path.endswith('vendor/rapier/rapier.mjs'):
        # This is the bundled compat build. Its WebAssembly binding table
        # contains './rapier_wasm3d_bg.js' as a *key*, not a module import.
        references = [ref for ref in references if ref != './rapier_wasm3d_bg.js']
    for specifier in [*references, *url_files]:
        resolved = urlsplit(urljoin(ORIGIN + path, specifier))
        name = resolved.path.lstrip('/')
        if resolved.netloc != urlsplit(ORIGIN).netloc or not name.startswith(PREFIX):
            raise ValueError(f'Dependency outside pinned release: {path} -> {specifier}')
        result.add(name)
    return result


def download(path):
    url = ORIGIN + path
    request = urllib.request.Request(url, headers={'User-Agent': 'VICE86-Revanced source import/1.0'})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                if urlsplit(response.geturl()).netloc != urlsplit(ORIGIN).netloc:
                    raise ValueError(f'Unexpected redirect at {url}')
                data = response.read(MAX_FILE + 1)
                if len(data) > MAX_FILE or not data:
                    raise ValueError(f'Invalid file size at {url}')
                if path.endswith(SCRIPT_TYPE) and (data.lstrip().startswith((b'<!', b'<html', b'{"detail"'))):
                    raise ValueError(f'Expected source code at {url}, got an error document')
                if path.endswith('.json'):
                    json.loads(data)
                return data
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise RuntimeError(f'{url}: HTTP {error.code}') from error
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == 2:
                raise RuntimeError(f'Could not download {url}: {error}') from error
        time.sleep(1 + attempt)


def collect(root, read=download):
    """Copy the transitive closure and keep the upstream bytes untouched."""
    pending, done = {STYLE, ENTRY, PREFIX + 'vendor/rapier/LICENSE'}, {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as workers:
        while pending:
            batch = sorted(pending - done.keys())
            pending.clear()
            if len(done) + len(batch) > MAX_FILES:
                raise ValueError('Unexpectedly large release graph')
            for path, data in zip(batch, workers.map(read, batch)):
                dest = root / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)
                done[path] = hashlib.sha256(data).hexdigest()
                pending.update(dependencies(path, data) - done.keys())
            print(f'  {len(done)} release files copied', flush=True)
    return done


def read_lock(lock_path):
    lock = json.loads(Path(lock_path).read_text(encoding='utf-8'))
    if lock['release'] != RELEASE or lock['origin'] != ORIGIN:
        raise ValueError('Wrong upstream release')
    return lock


def check_closure(name, data, known):
    """Every file a module refers to has to be here, whoever wrote the module."""
    missing = dependencies(PREFIX + name, data) - {PREFIX + k for k in known}
    if missing:
        raise ValueError(f'{name} refers to files that are not in the tree: {sorted(missing)[:6]}')


def verify_playable(web=WEB, lock_path=LOCK):
    """The check of what this branch actually runs: `web/`.

    A fork edits things, so the release lock is not used as a tamper check here but as an
    inventory: every file it names has to be present and either byte-identical to the release or
    changed on purpose (listed), the closure of every module has to be on disk, and no release
    file may have vanished. `unchanged + modified` is the release; `ours` is what was added.
    """
    web, lock_path = Path(web), Path(lock_path)
    lock = read_lock(lock_path)
    on_disk = {p.relative_to(web).as_posix() for p in web.rglob('*') if p.is_file()}
    release_names, unchanged, modified, missing = set(), [], [], []
    for path, digest in lock['files'].items():
        if path != SHELL and (not SAFE_PATH.fullmatch(path) or not path.startswith(PREFIX) or '..' in PurePosixPath(path).parts):
            raise ValueError(f'Unsafe manifest path: {path}')
        name = SHELL if path == SHELL else path[len(PREFIX):]
        release_names.add(name)
        if name not in on_disk:
            missing.append(name)
        elif name == SHELL or hashlib.sha256((web / name).read_bytes()).hexdigest() != digest:
            modified.append(name)
        else:
            unchanged.append(name)
    if missing:
        raise ValueError(f'Release files are not in {web}: {sorted(missing)[:8]}')
    # The shell is edited on purpose (relative asset paths, the engine's name), so it is checked
    # for what it must still do rather than for its bytes.
    shell = (web / SHELL).read_text(encoding='utf-8')
    if PREFIX in shell:
        raise ValueError(f'{SHELL} still points into the release directory')
    for ref, target in (('./src/main.js', 'src/main.js'), ('./style.css', 'style.css')):
        if ref not in shell:
            raise ValueError(f'{SHELL} no longer loads {ref}')
        if target not in on_disk:
            raise ValueError(f'{SHELL} loads {ref}, which is not in {web}')
    for name in sorted(on_disk):
        if name.endswith(SCRIPT_TYPE):
            check_closure(name, (web / name).read_bytes(), on_disk)
    if 'vendor/rapier/LICENSE' not in on_disk:
        raise ValueError('The Rapier license is not beside the copy of Rapier it covers')
    required = ('src/main.js', 'style.css', 'src/render/index.js', 'src/world/tiles/worker.js',
                'src/game/models.worker.js', 'src/physics/index.js', 'design/map/layout.json',
                'src/vehicles/traffic/index.js', 'src/audio/dsp/index.js', 'src/world/garage/index.js',
                'src/render/families/solid.js', 'src/render/families/ground.js',
                'src/render/families/facade.js', 'src/render/families/vehicle.js',
                'src/render/families/foliage.js', 'src/render/families/glass.js',
                'vendor/rapier/rapier.mjs')
    for path in required:
        if path not in on_disk:
            raise ValueError(f'Incomplete runtime: missing {path}')
    return {
        'release': len(lock['files']), 'total': len(on_disk),
        'unchanged': unchanged, 'modified': sorted(modified), 'ours': sorted(on_disk - release_names),
    }


def verify_snapshot(out=Path('.vice-snapshot')):
    """The check of a staging snapshot: raw upstream bytes, nothing edited."""
    lock = read_lock(Path(out) / MANIFEST)
    for path, digest in lock['files'].items():
        if path != SHELL and (not SAFE_PATH.fullmatch(path) or not path.startswith(PREFIX) or '..' in PurePosixPath(path).parts):
            raise ValueError(f'Unsafe manifest path: {path}')
        data = (Path(out) / path).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f'Upstream byte mismatch: {path}')
        check_closure(path[len(PREFIX):] if path != SHELL else SHELL, data,
                      {p[len(PREFIX):] if p != SHELL else SHELL for p in lock['files']})
    return lock


def import_release(out):
    out = Path(out)
    if (out / MANIFEST).exists():
        verify_snapshot(out)
        print(f'Using verified snapshot in {out}')
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=out.parent, prefix='.vice-import-'))
    try:
        index = download('')
        if ENTRY.encode() not in index or STYLE.encode() not in index:
            raise ValueError(f'The live shell no longer names {RELEASE}; refusing to mix releases. Use the saved snapshot.')
        (tmp / SHELL).write_bytes(index)
        files = collect(tmp)
        files[SHELL] = hashlib.sha256(index).hexdigest()
        lock = {'origin': ORIGIN, 'release': RELEASE, 'files': dict(sorted(files.items()))}
        (tmp / MANIFEST).write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
        verify_snapshot(tmp)
        if out.exists():
            shutil.rmtree(out)
        tmp.rename(out)
        print(f'Verified and saved {len(files)} files to {out}')
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)


def sync_snapshot(out, web=WEB, lock_path=LOCK, force=False):
    """Puts a verified staging snapshot into the playable tree, leaving the fork's edits alone."""
    out, web, lock_path = Path(out), Path(web), Path(lock_path)
    lock = verify_snapshot(out)
    written, held = [], []
    for path, digest in lock['files'].items():
        name = SHELL if path == SHELL else path[len(PREFIX):]
        source = (out / path).read_bytes()
        if name == SHELL:
            source = source.replace(PREFIX.encode(), b'./')
        dest = web / name
        if dest.exists():
            current = dest.read_bytes()
            if current == source:
                continue
            if not force:
                held.append(name)
                continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(source)
        written.append(name)
    (lock_path).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(out / MANIFEST, lock_path)
    print(f'Wrote {len(written)} files into {web}; refreshed {lock_path.name}')
    if held:
        print(f'Held back {len(held)} file(s) the fork has changed (use --force to overwrite): {held[:8]}')
    result = verify_playable(web, lock_path)
    print(f"Release verified: {result['release']} locked files, {result['onDisk']} on disk, "
          f"{len(result['ours'])} of ours")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out', type=Path, default=Path('.vice-snapshot'), help='staging snapshot directory')
    parser.add_argument('--web', type=Path, default=WEB, help='playable tree (default: web)')
    parser.add_argument('--lock', type=Path, default=LOCK, help='the lock the playable tree is checked against')
    parser.add_argument('--zip', type=Path, metavar='FILE', help='write a portable ZIP of the staging snapshot')
    parser.add_argument('--import', dest='do_import', action='store_true', help='download the pinned release into --out')
    parser.add_argument('--sync', action='store_true', help='copy a verified --out into --web')
    parser.add_argument('--force', action='store_true', help='with --sync, overwrite files the fork has changed')
    parser.add_argument('--verify-snapshot', action='store_true', help='check the bytes in --out instead of --web')
    parser.add_argument('--verify', action='store_true', help='check --web against --lock (the default)')
    args = parser.parse_args()
    if args.do_import:
        import_release(args.out)
    if args.verify_snapshot:
        result = verify_snapshot(args.out)
        print(f"Verified {len(result['files'])} staged release files for {RELEASE}")
    if args.sync:
        sync_snapshot(args.out, args.web, args.lock, args.force)
    if not args.do_import and not args.verify_snapshot and not args.sync or args.verify:
        result = verify_playable(args.web, args.lock)
        print(f"{args.web}: {result['release']} release files for {RELEASE}, "
              f"{len(result['unchanged'])} byte for byte and {len(result['modified'])} changed by this fork, "
              f"{len(result['ours'])} added, {result['total']} files in all")
        for name in result['modified']:
            print(f'  fork change: {name}')
        for name in result['ours']:
            print(f'  fork module: {name}')
    if args.zip:
        if args.zip.exists():
            print(f'{args.zip} exists; leaving it alone')
        else:
            with zipfile.ZipFile(args.zip, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
                for path in [MANIFEST, *verify_snapshot(args.out)['files']]:
                    archive.write(args.out / path, 'upstream/' + path)
            print(f'Wrote {args.zip}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            message = str(error).replace('%', '%25').replace('\n', '%0A').replace('\r', '%0D')
            print('::error title=Source import::' + message, flush=True)
        raise SystemExit(str(error))
