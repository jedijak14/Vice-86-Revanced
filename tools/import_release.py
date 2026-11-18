#!/usr/bin/env python3
"""Vendor the public runtime of VICE '86, without executing downloaded code.

Run with Python 3.9+ on a machine with access to heat.pplx.app. No packages
or credentials required. --zip also writes an archive suitable for transfer
to an offline checkout. The result is source, not a browser cache or bundle.
"""

import argparse
import concurrent.futures
import hashlib
import json
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

# This release expresses worker entry points, the city layout, the optional
# world builders and the lazy garage models as module-relative literals. A
# walker of `import ... from` alone silently drops all four of those groups.
REFERENCE = re.compile(r'''(['"`])(\.{1,2}/[A-Za-z0-9_./-]+\.(?:[cm]?js|json|css|glsl|vert|frag|wasm))\1''')
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
    for match in REFERENCE.finditer(source):
        resolved = urlsplit(urljoin(ORIGIN + path, match[2]))
        name = resolved.path.lstrip('/')
        if resolved.netloc != urlsplit(ORIGIN).netloc or not name.startswith(PREFIX):
            raise ValueError(f'Dependency outside pinned release: {path} -> {match[2]}')
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
    pending, done = {STYLE, ENTRY}, {}
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


def verify(root):
    lock = json.loads((root / MANIFEST).read_text(encoding='utf-8'))
    if lock['release'] != RELEASE or lock['origin'] != ORIGIN:
        raise ValueError('Wrong upstream release')
    for path, digest in lock['files'].items():
        if path != 'index.html' and (not SAFE_PATH.fullmatch(path) or not path.startswith(PREFIX) or '..' in PurePosixPath(path).parts):
            raise ValueError(f'Unsafe manifest path: {path}')
        data = (root / path).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f'Upstream byte mismatch: {path}')
        missing = dependencies(path, data) - lock['files'].keys()
        if missing:
            raise ValueError(f'{path} has unvendored dependencies: {missing}')
    for path in ('index.html', STYLE, ENTRY, *(PREFIX + p for p in (
        'src/render/index.js', 'src/world/tiles/worker.js', 'src/game/models.worker.js',
        'src/physics/index.js', 'vendor/rapier/rapier.mjs', 'design/map/layout.json',
        'src/vehicles/hero/index.js', 'src/vehicles/silvretta/index.js',
        'src/vehicles/thunderhead/index.js', 'src/vehicles/traffic/index.js',
        'src/audio/dsp/index.js', 'src/world/garage/index.js'))):
        if path not in lock['files']:
            raise ValueError(f'Incomplete runtime: missing {path}')
    return lock


def import_release(out):
    if out.exists():
        verify(out)
        print(f'Using verified snapshot in {out}')
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=out.parent, prefix='.vice-import-'))
    try:
        index = download('')
        if ENTRY.encode() not in index or STYLE.encode() not in index:
            raise ValueError(f'The live shell no longer names {RELEASE}; refusing to mix releases. Use the saved snapshot.')
        (tmp / 'index.html').write_bytes(index)
        files = collect(tmp)
        files['index.html'] = hashlib.sha256(index).hexdigest()
        lock = {'origin': ORIGIN, 'release': RELEASE, 'files': dict(sorted(files.items()))}
        (tmp / MANIFEST).write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')
        verify(tmp)
        tmp.rename(out)
        print(f'Verified and saved {len(files)} files to {out}')
    finally:
        if tmp.exists():
            shutil.rmtree(tmp)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path('upstream'), help='snapshot directory (default: upstream)')
    parser.add_argument('--zip', type=Path, metavar='FILE', help='also write a portable ZIP of the snapshot')
    parser.add_argument('--verify', action='store_true', help='offline integrity and dependency-closure check only')
    args = parser.parse_args()
    if args.verify:
        print(f"Verified {len(verify(args.out)['files'])} files for {RELEASE}")
    else:
        import_release(args.out)
    if args.zip:
        with zipfile.ZipFile(args.zip, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in [MANIFEST, *verify(args.out)['files']]:
                archive.write(args.out / path, 'upstream/' + path)
        print(f'Wrote {args.zip}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(str(error))
