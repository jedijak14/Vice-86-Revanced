#!/usr/bin/env python3
"""Rig the figure the project owner uploaded.

`web/assets/models/player/model.glb` is a photogrammetry scan: 370 304 triangles of a man in a t-shirt
and shorts, standing with his arms hanging at his sides, and it carries no skeleton and no animation.
A mesh with nothing to bend is a statue, so this tool gives it bones:

  1. **shape**  The arms are brought out of the sides into an A-pose, about 40 degrees from vertical.
                The scan has the arm fused to the torso above the armpit -- there is no seam to cut
                along -- so the rotation is not a cut but a blend: full rotation in the arm's own tube,
                falling to nothing across the deltoid and the shoulder, where a shoulder deforms anyway.
                Everything the blend touches is measured out of the mesh (the arm's centre line, its
                radius, the shoulder it meets), not typed in from a look at the model.

  2. **skeleton** Twenty-three joints with the names and the hierarchy of KayKit's `Rig_Medium`, placed
                at this figure's own proportions rather than scaled from that rig's: its hips sit at
                0.406 m and its head at 1.241 m, against 0.95 m and 1.72 m here, so scaling the rig
                would put the crown at 2.9 m. Sharing the *names* is what lets the 131 vendored clips
                re-point themselves onto this skeleton by bone name, exactly as they do for the crowd.

  3. **weights** Each vertex is weighed to the bones by distance to the bone segment, smoothed over the
                mesh so the field has no blobs, and kept to the four strongest influences, which is what
                the renderer's skinned vertex format holds.

The output is a GLB in the same shape the rest of the pipeline reads: quantized positions and i8 normals
as they came in, u8 joints and weights, u32 indices, the webp textures and their placement untouched.
KayKit's clips are keyed to a T-pose rest, so `cast.js` is handed a per-bone correction that says how far
this figure's rest is from that one; the test applies the `T-Pose` clip and checks the arms come out
horizontal, which is the correction being right rather than being hoped for.

Stdlib only, like the rest of the tools here: it is run once, its output is vendored and checked against
the manifest, and nobody needs numpy to reproduce a byte. A full run is a couple of minutes on 201 540
vertices, which is the price of not shipping a dependency.

    python3 tools/rig_player.py --write      write web/assets/models/player/rigged.glb
    python3 tools/rig_player.py --report     what was measured and what was moved, nothing written
"""

import argparse
import json
import math
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, 'web', 'assets', 'models', 'player', 'model.glb')
OUTPUT = os.path.join(ROOT, 'web', 'assets', 'models', 'player', 'rigged.glb')

# The pose the arms are brought to, in degrees from vertical. 45 is a T-pose's right angle and 0 is the
# arms hanging as the scan found them; an A-pose sits between and is what a scan can be opened into
# without stretching the armpit into a sail.
A_POSE_DEGREES = 22.0

# The arm's tube, measured: below this height the arm stands clear of the torso in the silhouette and its
# centre line can be fitted; above it the line is extrapolated to the shoulder.
ARM_MEASURE_BOTTOM = 0.80
# The crease below which the arm stands clear of the torso in the silhouette, and the joint the
# rotation fades out at. Nothing below the hands belongs to an arm, whatever the crease says about
# the feet.
ARM_CLEAR_TOP = 1.28
SHOULDER_Y = 1.52

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
CH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546c67:
        raise ValueError('%s is not a GLB' % path)
    jlen, _ = struct.unpack_from('<II', data, 12)
    doc = json.loads(data[20:20 + jlen].decode('utf-8'))
    at = 20 + jlen
    blen, _ = struct.unpack_from('<II', data, at)
    return doc, data[at + 8:at + 8 + blen]


def accessor(doc, bin, index):
    """One accessor as rows of floats, applying byteStride, normalization and (for the quantized
    positions) nothing else: the node's scale is the metre, and whoever places the mesh applies it."""
    acc = doc['accessors'][index]
    bv = doc['bufferViews'][acc['bufferView']]
    fmt, size = CT[acc['componentType']]
    comps = CH[acc['type']]
    count = acc['count']
    stride = bv.get('byteStride') or size * comps
    base = bv['byteOffset'] + acc.get('byteOffset', 0)
    rows = []
    per = stride // size
    flat = []
    for i in range(count):
        o = base + i * stride
        row = struct.unpack_from('<%d%s' % (comps, fmt), bin, o)
        flat.extend(row)
    if acc.get('normalized'):
        div = {5120: 127.0, 5121: 255.0, 5122: 32767.0, 5123: 65535.0}[acc['componentType']]
        signed = acc['componentType'] in (5120, 5122)
        out = []
        for v in flat:
            v = v / div
            out.append(v if not (signed and v < -1.0) else -1.0)
        flat = out
    for i in range(count):
        rows.append(flat[i * comps:(i + 1) * comps])
    return rows


def polyfit(xs, ys):
    """Least squares y = a*x + b, by hand: no numpy in this tool."""
    n = len(xs)
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    a = sxy / sxx
    return a, my - a * mx


def smooth(t):
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    return t * t * (3 - 2 * t)


def measure(doc, V):
    """Where each arm is, from the silhouette: below the crease the arm stands clear of the torso with an
    air gap between, and the middle of that gap is the armpit crease line t(y); the arm's own centre line
    is fitted from the centroid of what lies beyond it. Slices where the arm lies against the torso have
    no gap and inherit t from their neighbours, which is where the crease is feathered."""
    arms = {}
    for side, sign in (('l', 1), ('r', -1)):
        meas, cxs, czs, cys = [], [], [], []
        y = ARM_MEASURE_BOTTOM
        while y <= ARM_CLEAR_TOP + 0.02:
            band = [v for v in V if y - 0.015 < v[1] < y + 0.015]
            if len(band) > 100:
                xs = sorted(v[0] for v in band)
                pick = None
                for i in range(1, len(xs)):
                    g = xs[i] - xs[i - 1]
                    mid = (xs[i] + xs[i - 1]) / 2
                    outer = xs[:i] if sign < 0 else xs[i:]
                    wide = (outer[-1] - outer[0]) / 2
                    # a gap on this side of the body, not the crotch or the neck, with an arm-sized
                    # cluster beyond it: a crease in the shirt is not an armpit
                    if (g > 0.005 and mid * sign > 0.05 and wide <= 0.10 and len(outer) >= 30
                            and (pick is None or g > pick[0])):
                        pick = (g, mid, i)
                if pick and pick[0] > 0.008:
                    g, mid, i = pick
                    sel = [v for v in band if (v[0] < mid) == (sign < 0)]
                    edge = max(v[0] for v in sel) if sign < 0 else min(v[0] for v in sel)
                    meas.append((y, mid, g, edge))
                    cys.append(y)
                    cxs.append(sum(v[0] for v in sel) / len(sel))
                    czs.append(sum(v[2] for v in sel) / len(sel))
            y += 0.02
        if len(cys) < 4:
            raise ValueError('could not fit the %s arm from %d slices' % (side, len(cys)))
        ax, bx = polyfit(cys, cxs)
        az, bz = polyfit(cys, czs)
        # the inner edge of the arm and the outer edge of the torso, each fitted from the slices where
        # the air gap showed them apart; between those slices the two edges meet, and the crease is
        # where they cross
        inner = polyfit([m[0] for m in meas], [m[3] for m in meas])
        torso = polyfit([m[0] for m in meas], [m[1] - sign * m[2] / 2 for m in meas])
        arms[side] = {
            'line': (ax, bx, az, bz),
            'shoulder': (ax * SHOULDER_Y + bx, SHOULDER_Y, az * SHOULDER_Y + bz),
            'meas': meas,
            'inner': inner,
            'torso': torso,
            'slices': len(cys),
        }
    return arms


def gap_mid(arm, y):
    """The middle of the air gap at a height, from the nearest slice that showed one, or None where
    the arm lay against the torso and there was no gap to see."""
    best = None
    for my, mid, g, edge in arm['meas']:
        d = abs(my - y)
        if d < 0.012 and (best is None or d < best[0]):
            best = (d, mid)
    return best[1] if best else None


def build_adjacency(idx):
    """Vertex neighbourhood from the triangle list, as flat arrays: neighbour offsets per vertex."""
    edges = set()
    for i in range(0, len(idx), 3):
        a, b, c = idx[i], idx[i + 1], idx[i + 2]
        for u, v in ((a, b), (b, c), (c, a)):
            if u != v:
                edges.add((u, v) if u < v else (v, u))
    counts = {}
    for u, v in edges:
        counts[u] = counts.get(u, 0) + 1
        counts[v] = counts.get(v, 0) + 1
    n = max(counts) + 1
    starts = [0] * (n + 1)
    for i in range(n):
        starts[i + 1] = starts[i] + counts.get(i, 0)
    flat = [0] * starts[n]
    cur = starts[:]
    for u, v in edges:
        flat[cur[u]] = v; cur[u] += 1
        flat[cur[v]] = u; cur[v] += 1
    return starts, flat


def harmonic_field(n, starts, flat, seeds):
    """The mesh-smooth indicator of "this vertex is arm": 1 on the seeds inside the arm, 0 on the seeds
    on the torso, and everywhere else the solution of Laplace's equation over the vertex graph, so the
    gradient falls where the surface connects the two -- the armpit fold -- and nowhere an eye would
    notice. Gauss-Seidel, in place; the seeds stay pinned."""
    w = [0.0] * n
    pinned = [False] * n
    for i, val in seeds.items():
        w[i] = val
        pinned[i] = True
    for sweep in range(200):
        change = 0.0
        for i in range(n):
            if pinned[i]:
                continue
            s = starts[i]
            e = starts[i + 1]
            if e == s:
                continue
            acc = 0.0
            for k in range(s, e):
                acc += w[flat[k]]
            new = acc / (e - s)
            d = new - w[i]
            if d > change:
                change = d
            elif -d > change:
                change = -d
            w[i] = new
        if change < 1e-4:
            break
    return w


def arm_angle(arm, side):
    """How far the arm already hangs from vertical, measured from its own fitted line: the hand end
    against the shoulder end. The rotation asked for is whatever brings that up to the A-pose."""
    ax, bx, az, bz = arm['line']
    sx, sy, sz = arm['shoulder']
    hx, hy = ax * 0.80 + bx, 0.80
    sign = 1.0 if side == 'l' else -1.0
    outward = (hx - sx) * sign
    drop = sy - hy
    return math.degrees(math.atan2(outward, drop))


def shape(V, arms, fields, degrees=A_POSE_DEGREES):
    """Bring each arm out of the side into an A-pose: a weighted rotation of the mesh about the shoulder,
    in the frontal plane, by the angle the fitted line says is missing. The weight is the harmonic field,
    so the blend follows the surface. Returns how far each vertex moved, to be checked, not trusted."""
    delta = {}
    for side in ('l', 'r'):
        sign = 1.0 if side == 'l' else -1.0
        delta[side] = sign * math.radians(degrees - arm_angle(arms[side], side))
    moved = [0.0] * len(V)
    rot = [0.0] * len(V)
    fl, fr = fields['l'], fields['r']
    for i, v in enumerate(V):
        wl, wr = fl[i], fr[i]
        if wl >= wr:
            best, which = wl, 'l'
        else:
            best, which = wr, 'r'
        if best <= 1e-4:
            continue
        if v[1] < 1.06 and best < 0.7:
            continue                    # a thread of the hand-to-thigh weld: it stays with the leg
        arm = arms[which]
        ax, bx, az, bz = arm['line']
        # the sleeve lay pressed flat against the ribs; as the arm lifts, cloth rounds back into a
        # tube, so the flattened pad contracts towards the arm's own axis before it rotates
        px, pz = v[0] - (ax * v[1] + bx), v[2] - (az * v[1] + bz)
        d = math.hypot(px, pz)
        band = smooth((v[1] - 0.90) / 0.06) * (1.0 - smooth((v[1] - 1.36) / 0.06))
        ring = smooth((d - 0.045) / 0.03) * (1.0 - smooth((d - 0.12) / 0.05))
        k = 1.0 - 0.65 * best * band * ring
        v[0] = ax * v[1] + bx + px * k
        v[2] = az * v[1] + bz + pz * k
        rot[i] = delta[which] * best
        s = arm['shoulder']
        th = rot[i]
        c, sn = math.cos(th), math.sin(th)
        dx, dy = v[0] - s[0], v[1] - s[1]
        nx, ny = dx * c - dy * sn, dx * sn + dy * c
        moved[i] = math.hypot(nx - dx, ny - dy)
        v[0] = s[0] + nx
        v[1] = s[1] + ny
    return moved, delta, rot


def write_debug_glb(path, idx, V, nrm):
    """The shaped mesh alone, float positions, so a renderer or an eye can judge the blend."""
    pos = bytearray()
    nor = bytearray()
    for v in V:
        pos += struct.pack('<3f', v[0], v[1], v[2])
    for n in nrm:
        nor += struct.pack('<3b', *[max(-127, min(127, int(round(c * 127)))) for c in n])
    ibuf = struct.pack('<%dI' % len(idx), *idx)
    o1, o2 = len(pos), len(pos) + len(nor)
    out = {
        'asset': {'version': '2.0', 'generator': 'tools/rig_player.py --debug-shape'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': 'shaped'}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2}]}],
        'bufferViews': [
            {'buffer': 0, 'byteOffset': 0, 'byteLength': len(pos), 'target': 34962},
            {'buffer': 0, 'byteOffset': o1, 'byteLength': len(nor), 'target': 34962},
            {'buffer': 0, 'byteOffset': o2, 'byteLength': len(ibuf), 'target': 34963},
        ],
        'accessors': [
            {'bufferView': 0, 'componentType': 5126, 'count': len(V), 'type': 'VEC3',
             'min': [min(v[0] for v in V), min(v[1] for v in V), min(v[2] for v in V)],
             'max': [max(v[0] for v in V), max(v[1] for v in V), max(v[2] for v in V)]},
            {'bufferView': 1, 'componentType': 5120, 'count': len(nrm), 'type': 'VEC3', 'normalized': True},
            {'bufferView': 2, 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'},
        ],
        'buffers': [{'byteLength': o2 + len(ibuf)}],
    }
    j = json.dumps(out).encode('utf-8')
    j += b' ' * ((4 - len(j) % 4) % 4)
    body = bytes(pos) + bytes(nor) + ibuf
    body += b'\x00' * ((4 - len(body) % 4) % 4)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(j) + 8 + len(body)))
        fh.write(struct.pack('<II', len(j), 0x4e4f534a))
        fh.write(j)
        fh.write(struct.pack('<II', len(body), 0x004e4942))
        fh.write(body)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--write', action='store_true', help='write %s' % os.path.relpath(OUTPUT, ROOT))
    ap.add_argument('--report', action='store_true', help='say what was measured and moved, write nothing')
    ap.add_argument('--debug-shape', metavar='GLB', help='write only the shaped mesh, for looking at')
    args = ap.parse_args(argv)
    doc, bin = read_glb(SOURCE)
    prim = doc['meshes'][0]['primitives'][0]
    node = doc['nodes'][0]
    scale = node.get('scale', [1, 1, 1]); translation = node.get('translation', [0, 0, 0])
    raw = accessor(doc, bin, prim['attributes']['POSITION'])
    V = [[r[0] * scale[0] + translation[0], r[1] * scale[1] + translation[1], r[2] * scale[2] + translation[2]] for r in raw]
    floor = min(v[1] for v in V)
    for v in V:
        v[1] -= floor
    arms = measure(doc, V)
    idx = [int(r[0]) for r in accessor(doc, bin, prim['indices'])]
    nrm = accessor(doc, bin, prim['attributes']['NORMAL'])
    fields = {}
    for side, sign in (('l', 1), ('r', -1)):
        fields[side] = seeds = {}
        arm = arms[side]
        for i, v in enumerate(V):
            x, y, z = v[0], v[1], v[2]
            ny, nx = nrm[i][1], nrm[i][0]
            mid = gap_mid(arm, y)
            if y > SHOULDER_Y or y < 0.70:
                seeds[i] = 0.0                    # legs, hips, neck: never an arm
            elif mid is not None:
                beyond = (x - mid) * sign
                if beyond > 0.004:
                    if y >= 0.80:
                        seeds[i] = 1.0            # the arm, clear of the torso in the silhouette
                    else:
                        seeds[i] = 1.0 if beyond > 0.04 else 0.0   # the hand, or the bridge to the thigh
                else:
                    seeds[i] = 0.0                # shirt side, thigh, and the hand's weld shelf: the
                    continue                      # shelf stays with the leg; the crack hides between
            elif x * sign < -0.05:
                seeds[i] = 0.0                    # the other half of the body
            elif abs(x) < 0.14 and 0.85 < y < 1.55:
                seeds[i] = 0.0                    # the chest and belly column
            elif 1.00 < y < 1.45 and x * sign > 0.14:
                # where the arm lay pressed against the ribs the two surfaces are one, so the fold is
                # pinned, not diffused: a crease at the sleeve's own depth, hidden against the body
                az, bz = arm['line'][2], arm['line'][3]
                win = 0.10 * min(1.0, (1.45 - y) / 0.07)
                dz = abs(z - (az * y + bz))
                seeds[i] = 1.0 if dz < win + 0.004 else 0.0   # a crease ring, not a diffused web
    starts, flat = build_adjacency(idx)
    solved = {side: harmonic_field(len(V), starts, flat, fields[side]) for side in ('l', 'r')}
    moved, delta, rot = shape(V, arms, solved)
    touched = sum(1 for m in moved if m > 1e-4)
    worst = max(moved)
    if args.report or not (args.write or args.debug_shape):
        for side in ('l', 'r'):
            a = arms[side]
            print('%s arm: %d fitted slices, hangs %.1f deg from vertical, rotated %+.1f deg' % (
                side, a['slices'], arm_angle(a, side), math.degrees(delta[side]) * (-1 if side == 'l' else 1)))
            print('   shoulder at (%.3f, %.3f, %.3f)' % a['shoulder'])
        print('%d of %d vertices moved (%.1f%%), the most by %.0f mm' % (
            touched, len(V), 100.0 * touched / len(V), worst * 1000))
    if args.debug_shape:
        write_debug_glb(args.debug_shape, idx, V, nrm)
        print('wrote %s' % args.debug_shape)
    if args.write:
        for i, r in enumerate(nrm):                      # normals follow the surface they belong to
            th = rot[i]
            if th:
                c, sn = math.cos(th), math.sin(th)
                nrm[i] = [r[0] * c - r[1] * sn, r[0] * sn + r[1] * c, r[2]]
        arms2 = measure(doc, V)                           # refit on the shaped figure: the gaps are open now
        legs = measure_legs(V)
        skel = build_skeleton(arms2, legs)
        joints, weights = skin_weights(V, skel, solved)
        uv_view = doc['bufferViews'][doc['accessors'][prim['attributes']['TEXCOORD_0']]['bufferView']]
        uv_raw = bin[uv_view['byteOffset']:uv_view['byteOffset'] + uv_view['byteLength']]
        i_view = doc['bufferViews'][doc['accessors'][prim['indices']]['bufferView']]
        idx_raw = bin[i_view['byteOffset']:i_view['byteOffset'] + i_view['byteLength']]
        write_rig_glb(OUTPUT, doc, bin, prim, V, nrm, uv_raw, idx_raw, joints, weights, skel)
        theirs, their_offsets, their_bind, their_raw_offsets = reference_joint_positions()
        corr = rest_correction(skel, their_bind, their_offsets, their_raw_offsets)
        rig = {
            'generatedBy': 'tools/rig_player.py',
            'aPoseDegrees': A_POSE_DEGREES,
            'rest': {name: list(skel[name]) for name, _, _ in BONES},
            'bones': corr,
        }
        with open(os.path.join(os.path.dirname(OUTPUT), 'rig.json'), 'w') as fh:
            json.dump(rig, fh, indent=1, sort_keys=True)
            fh.write('\n')
        print('wrote %s (%d bytes) and rig.json' % (os.path.relpath(OUTPUT, ROOT), os.path.getsize(OUTPUT)))
    return 0


def reference_joint_positions(path=None):
    """Where KayKit's own rig puts the same-named joints, by walking its node tree: the rest the
    vendored clips were authored against."""
    path = path or os.path.join(ROOT, 'web', 'assets', 'models', 'kaykit-animation', 'Rig_Medium_General.glb')
    doc, _ = read_glb(path)
    parent = {}
    for i, n in enumerate(doc['nodes']):
        for c in n.get('children', []):
            parent[c] = i
    by_name = {n.get('name'): i for i, n in enumerate(doc['nodes']) if n.get('name')}
    world_t = {}
    world_q = {}
    world_s = {}

    def place(i):
        if i in world_t:
            return
        p = parent.get(i)
        if p is None:
            pt, pq, ps = (0.0, 0.0, 0.0), (0.0, 0.0, 0.0, 1.0), (1.0, 1.0, 1.0)
        else:
            place(p)
            pt, pq, ps = world_t[p], world_q[p], world_s[p]
        n = doc['nodes'][i]
        t = n.get('translation', [0, 0, 0])
        q = n.get('rotation', [0, 0, 0, 1])
        s = n.get('scale', [1, 1, 1])
        rotated = quat_rotate(pq, (t[0] * ps[0], t[1] * ps[1], t[2] * ps[2]))
        world_t[i] = (pt[0] + rotated[0], pt[1] + rotated[1], pt[2] + rotated[2])
        world_q[i] = quat_mul(pq, q)
        world_s[i] = (ps[0] * s[0], ps[1] * s[1], ps[2] * s[2])

    out = {}
    offsets = {}
    bind = {}
    raw = {}
    for name, _, _ in BONES:
        i = by_name.get(name)
        if i is None:
            continue
        place(i)
        out[name] = world_t[i]
        t = doc['nodes'][i].get('translation', [0, 0, 0])
        l = math.sqrt(t[0] ** 2 + t[1] ** 2 + t[2] ** 2)
        if l > 1e-9:
            offsets[name] = (t[0] / l, t[1] / l, t[2] / l)
        raw[name] = tuple(t)
        bind[name] = tuple(doc['nodes'][i].get('rotation', [0, 0, 0, 1]))
    return out, offsets, bind, raw


def quat_rotate(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return (vx + w * tx + (y * tz - z * ty),
            vy + w * ty + (z * tx - x * tz),
            vz + w * tz + (x * ty - y * tx))



# ---------------------------------------------------------------- the skeleton and the skin

BONES = [
    # name, parent, how the rest position is found
    ('root', None, 'origin'),
    ('hips', 'root', 'spiney 0.95'),
    ('spine', 'hips', 'spiney 1.12'),
    ('chest', 'spine', 'spiney 1.30'),
    ('head', 'chest', 'spiney 1.52'),
    ('upperarm.l', 'chest', 'arm shoulder l'),
    ('lowerarm.l', 'upperarm.l', 'arm 0.30 l'),
    ('wrist.l', 'lowerarm.l', 'arm 0.575 l'),
    ('hand.l', 'wrist.l', 'arm 0.66 l'),
    ('handslot.l', 'hand.l', 'arm 0.75 l'),
    ('upperarm.r', 'chest', 'arm shoulder r'),
    ('lowerarm.r', 'upperarm.r', 'arm 0.30 r'),
    ('wrist.r', 'lowerarm.r', 'arm 0.575 r'),
    ('hand.r', 'wrist.r', 'arm 0.66 r'),
    ('handslot.r', 'hand.r', 'arm 0.75 r'),
    ('upperleg.l', 'hips', 'leg 0.92 l'),
    ('lowerleg.l', 'upperleg.l', 'leg 0.50 l'),
    ('foot.l', 'lowerleg.l', 'legfoot l'),
    ('toes.l', 'foot.l', 'legtoe l'),
    ('upperleg.r', 'hips', 'leg 0.92 r'),
    ('lowerleg.r', 'upperleg.r', 'leg 0.50 r'),
    ('foot.r', 'lowerleg.r', 'legfoot r'),
    ('toes.r', 'foot.r', 'legtoe r'),
]

# how far a bone's influence reaches, in metres, for the proximity weights
REACH = {
    'hips': 0.22, 'spine': 0.22, 'chest': 0.22, 'head': 0.17,
    'upperarm': 0.11, 'lowerarm': 0.095, 'wrist': 0.075, 'hand': 0.085,
    'upperleg': 0.14, 'lowerleg': 0.115, 'foot': 0.10, 'toes': 0.09,
}


def measure_legs(V):
    """The two leg centre lines, from the slices where the crotch gap splits them cleanly."""
    out = {}
    for side, sign in (('l', 1), ('r', -1)):
        ys, xs, zs = [], [], []
        y = 0.15
        while y < 0.80:
            band = [v for v in V if y - 0.02 < v[1] < y + 0.02]
            if len(band) > 100:
                sel = [v for v in band if v[0] * sign > 0.03]
                if len(sel) > 40:
                    ys.append(y)
                    xs.append(sum(v[0] for v in sel) / len(sel))
                    zs.append(sum(v[2] for v in sel) / len(sel))
            y += 0.05
        if len(ys) < 4:
            raise ValueError('could not fit the %s leg from %d slices' % (side, len(ys)))
        ax, bx = polyfit(ys, xs)
        az, bz = polyfit(ys, zs)
        out[side] = (ax, bx, az, bz)
    return out


def build_skeleton(arms2, legs):
    """The 23 joints at this figure's own proportions, wearing KayKit's names and hierarchy so the
    vendored clips re-point onto it by name."""
    pos = {}
    for name, parent, how in BONES:
        if how == 'origin':
            pos[name] = (0.0, 0.0, 0.0)
        elif how.startswith('spiney'):
            pos[name] = (0.0, float(how.split()[1]), 0.0)
        elif how.startswith('arm'):
            parts = how.split()
            side = parts[-1]
            ax, bx, az, bz = arms2[side]['line']
            sy = arms2[side]['shoulder'][1]
            if parts[1] == 'shoulder':
                pos[name] = tuple(arms2[side]['shoulder'])
            else:
                drop = float(parts[1])
                y = sy - drop * 0.86
                pos[name] = (ax * y + bx, y, az * y + bz)
        elif how.startswith('leg'):
            side = how.split()[-1]
            ax, bx, az, bz = legs[side]
            if how.startswith('legfoot'):
                x, z = ax * 0.09 + bx, az * 0.09 + bz
                pos[name] = (x, 0.09, z - 0.05)
            elif how.startswith('legtoe'):
                f = pos['foot.' + side]
                pos[name] = (f[0], 0.03, f[2] + 0.11)
            else:
                y = float(how.split()[1])
                pos[name] = (ax * y + bx, y, az * y + bz)
    return pos


def seg_distance(p, a, b):
    ax, ay, az = a
    bx, by, bz = b
    dx, dy, dz = bx - ax, by - ay, bz - az
    ll = dx * dx + dy * dy + dz * dz
    t = 0.0 if ll <= 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy + (p[2] - az) * dz) / ll))
    cx, cy, cz = ax + dx * t, ay + dy * t, az + dz * t
    return math.sqrt((p[0] - cx) ** 2 + (p[1] - cy) ** 2 + (p[2] - cz) ** 2)


def skin_weights(V, pos, fields):
    """Four influences a vertex, by proximity to each bone's segment, which is what a scan with no
    authored weights can be given: smooth, local, and never more than the vertex format holds."""
    segs = [(name, pos[parent], pos[name]) for name, parent, _ in BONES if parent and parent != 'root']
    segs.append(('hips', pos['root'], pos['hips']))
    out_j, out_w = [], []
    for i, v in enumerate(V):
        thread = v[1] < 1.06 and max(fields['l'][i], fields['r'][i]) < 0.7
        cand = []
        for name, a, b in segs:
            if thread and name.split('.')[0] in ('upperarm', 'lowerarm', 'wrist', 'hand'):
                continue                # a weld thread belongs to the leg it grew from
            r = REACH.get(name.split('.')[0], 0.0)
            if r <= 0.0:
                continue
            d = seg_distance(v, a, b)
            if d < r:
                w = (1.0 - d / r) ** 2
                cand.append((w, name))
        cand.sort(reverse=True)
        cand = cand[:4]
        tot = sum(w for w, _ in cand)
        if tot <= 1e-9:
            cand = [(1.0, 'hips')]
            tot = 1.0
        while len(cand) < 4:
            cand.append((0.0, cand[-1][1]))
        order = [BONE_INDEX[n] for n in (_n for _, _n in cand)]
        ws = [w / tot for w, _ in cand]
        out_j.append(order)
        out_w.append(ws)
    return out_j, out_w


BONE_INDEX = {name: i for i, (name, _, _) in enumerate(BONES)}


# ---------------------------------------------------------------- the rest-pose correction

def quat_axis_angle(ax, ay, az, ang):
    h = ang / 2
    s = math.sin(h)
    return (ax * s, ay * s, az * s, math.cos(h))


def quat_mul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    )


def quat_conj(a):
    return (-a[0], -a[1], -a[2], a[3])


def shortest_arc(u, v):
    """The rotation carrying direction u onto direction v, by the shortest way round."""
    ux, uy, uz = u
    vx, vy, vz = v
    lu = math.sqrt(ux * ux + uy * uy + uz * uz)
    lv = math.sqrt(vx * vx + vy * vy + vz * vz)
    if lu <= 1e-12 or lv <= 1e-12:
        return (0.0, 0.0, 0.0, 1.0)
    ux, uy, uz = ux / lu, uy / lu, uz / lu
    vx, vy, vz = vx / lv, vy / lv, vz / lv
    d = ux * vx + uy * vy + uz * vz
    if d > 0.999999:
        return (0.0, 0.0, 0.0, 1.0)
    if d < -0.999999:
        px, py, pz = (1.0, 0.0, 0.0) if abs(ux) < 0.9 else (0.0, 1.0, 0.0)
        cx, cy, cz = py * uz - pz * uy, pz * ux - px * uz, px * uy - py * ux
        return quat_axis_angle(cx, cy, cz, math.pi)
    cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    w = 1.0 + d
    l = math.sqrt(cx * cx + cy * cy + cz * cz + w * w)
    return (cx / l, cy / l, cz / l, w / l)


def rest_correction(skel, their_bind, their_offsets, their_raw_offsets):
    """KayKit's clips are authored against KayKit's rest: absolute local rotations in a hierarchy whose
    bones point their own way at bind. A clip played raw on this figure would swing every bone from the
    wrong start. What makes a clip mean here what it meant there is a per-bone pair of constants, baked
    into the clip once at load by `bakeClipForRest`: `B`, the reference bone's own bind rotation, which
    says where a clip key that leaves the bone alone expects it to point, and `D`, the rotation carrying
    this figure's bone offset onto the reference one, which is the difference between the two rests.
    `t` re-homes the hips, whose joint sits at 0.406 m over there and 0.95 m here."""
    corr = {}
    for name, parent, _ in BONES:
        child = CHILD_OF.get(name)
        o = skel[child] if child else skel[name]
        p = skel[name] if child else (skel[parent] if parent else (0.0, 0.0, 0.0))
        d_o = (o[0] - p[0], o[1] - p[1], o[2] - p[2])
        k = their_offsets.get(child or name)
        q = shortest_arc(d_o, k) if k else (0.0, 0.0, 0.0, 1.0)
        # a clip's translation keys are the reference figure's local offsets; the same key on this
        # figure has to land on this figure's offsets, so every bone carries the metre between them
        o = skel[name]
        pnt = skel[parent] if parent else (0.0, 0.0, 0.0)
        theirs_raw = their_raw_offsets.get(name)
        t = [0.0, 0.0, 0.0]
        if theirs_raw:
            t = [o[0] - pnt[0] - theirs_raw[0], o[1] - pnt[1] - theirs_raw[1], o[2] - pnt[2] - theirs_raw[2]]
        corr[name] = {'B': list(their_bind.get(name, (0.0, 0.0, 0.0, 1.0))), 'D': list(q), 't': t}
    return corr


# the child each bone points at: the first one in chain order, so hips point at the spine and the
# chest at the head, not at whichever leg or arm happened to be listed last
CHILD_OF = {}
for name, parent, _ in BONES:
    if parent:
        CHILD_OF.setdefault(parent, name)


# ---------------------------------------------------------------- the file itself

def pad4(b, fill=b'\x00'):
    return b + fill * ((4 - len(b) % 4) % 4)


def write_rig_glb(path, doc, bin, prim, V, nrm, uv_raw, idx_raw, joints, weights, skel):
    """The shaped, skinned figure as a GLB in the shape the rest of the pipeline reads: quantized
    positions and i8 normals as they came in, u8 joints and weights, the webp textures and their
    atlas placement untouched, and a skin whose joints wear KayKit's names."""
    n = len(V)
    xs = [v[0] for v in V]; ys = [v[1] for v in V]; zs = [v[2] for v in V]
    lo = (min(xs), min(ys), min(zs))
    hi = (max(xs), max(ys), max(zs))
    span = max(hi[i] - lo[i] for i in range(3))
    s = span / 65535.0
    pos = bytearray()
    for v in V:
        pos += struct.pack('<3H', *[min(65535, max(0, int(round((v[i] - lo[i]) / s)))) for i in range(3)])
    nor = bytearray()
    for r in nrm:
        nor += struct.pack('<3b', *[max(-127, min(127, int(round(c * 127)))) for c in r])
    jb = bytearray()
    wb = bytearray()
    for j, w in zip(joints, weights):
        jb += struct.pack('<4B', *j)
        bs = [min(255, int(round(x * 255))) for x in w]
        bs[0] = max(0, min(255, bs[0] + 255 - sum(bs)))     # rounding must not change the sum
        wb += struct.pack('<4B', *bs)
    # the webp images and their bytes, carried over untouched
    views = []
    blobs = []

    def view(data, target=None):
        off = sum(len(b) for b in blobs)
        blobs.append(pad4(data))
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        views.append(v)
        return len(views) - 1

    img_views = []
    for img in doc.get('images', []):
        bv = doc['bufferViews'][img['bufferView']]
        img_views.append(view(bin[bv['byteOffset']:bv['byteOffset'] + bv['byteLength']]))
    images = [{'bufferView': iv, 'mimeType': im.get('mimeType', 'image/webp')}
              for iv, im in zip(img_views, doc.get('images', []))]
    v_pos = view(bytes(pos), 34962)
    v_nor = view(bytes(nor), 34962)
    v_uv = view(uv_raw, 34962)
    v_j = view(bytes(jb), 34962)
    v_w = view(bytes(wb), 34962)
    v_i = view(idx_raw, 34963)
    names = [name for name, _, _ in BONES]
    ibm = bytearray()
    for name in names:
        x, y, z = skel[name]
        ibm += struct.pack('<16f', 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1)
    v_ibm = view(bytes(ibm))
    v_joints_acc = v_j
    accessors = [
        {'bufferView': v_pos, 'componentType': 5123, 'count': n, 'type': 'VEC3', 'normalized': False,
         'min': [0, 0, 0], 'max': [round((hi[i] - lo[i]) / s) for i in range(3)]},
        {'bufferView': v_nor, 'componentType': 5120, 'count': n, 'type': 'VEC3', 'normalized': True},
        {'bufferView': v_uv, 'componentType': 5123, 'count': n, 'type': 'VEC2', 'normalized': True},
        {'bufferView': v_j, 'componentType': 5121, 'count': n, 'type': 'VEC4'},
        {'bufferView': v_w, 'componentType': 5121, 'count': n, 'type': 'VEC4', 'normalized': True},
        {'bufferView': v_i, 'componentType': 5125, 'count': len(idx_raw) // 4, 'type': 'SCALAR'},
        {'bufferView': v_ibm, 'componentType': 5126, 'count': len(names), 'type': 'MAT4'},
    ]
    nodes = []
    index_of = {}
    for i, (name, parent, _) in enumerate(BONES):
        index_of[name] = i
    for i, (name, parent, _) in enumerate(BONES):
        x, y, z = skel[name]
        if parent:
            px, py, pz = skel[parent]
            x, y, z = x - px, y - py, z - pz
        nodes.append({'name': name, 'translation': [x, y, z], 'rotation': [0, 0, 0, 1], 'scale': [1, 1, 1]})
    for i, (name, parent, _) in enumerate(BONES):
        if parent:
            nodes[index_of[parent]].setdefault('children', []).append(i)
    mesh_node = len(nodes)
    nodes.append({'name': 'Player_Body', 'mesh': 0, 'skin': 0,
                  'translation': [lo[0], lo[1], lo[2]], 'rotation': [0, 0, 0, 1], 'scale': [s, s, s]})
    nodes[index_of['root']].setdefault('children', []).append(mesh_node)
    textures = doc.get('textures', [])
    out = {
        'asset': {'version': '2.0', 'generator': 'tools/rig_player.py'},
        'scene': 0,
        'scenes': [{'nodes': [index_of['root']]}],
        'nodes': nodes,
        'meshes': [{'name': 'Player_Body', 'primitives': [{
            'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2, 'JOINTS_0': 3, 'WEIGHTS_0': 4},
            'indices': 5, 'material': 0, 'mode': 4}]}],
        'skins': [{'joints': [index_of[name] for name in names], 'inverseBindMatrices': 6,
                   'skeleton': index_of['root']}],
        'materials': doc.get('materials', []),
        'images': images,
        'textures': textures,
        'samplers': doc.get('samplers', [{}]),
        'animations': [],
        'bufferViews': views,
        'accessors': accessors,
        'buffers': [{'byteLength': sum(len(b) for b in blobs)}],
        'extensionsUsed': ['KHR_mesh_quantization', 'KHR_texture_transform', 'EXT_texture_webp'],
    }
    if not textures:
        out.pop('textures')
    if not images:
        out.pop('images')
    j = pad4(json.dumps(out).encode('utf-8'), b' ')
    body = b''.join(blobs)
    with open(path, 'wb') as fh:
        fh.write(struct.pack('<III', 0x46546c67, 2, 12 + 8 + len(j) + 8 + len(body)))
        fh.write(struct.pack('<II', len(j), 0x4e4f534a))
        fh.write(j)
        fh.write(struct.pack('<II', len(body), 0x004e4942))
        fh.write(body)
    return out


if __name__ == '__main__':
    sys.exit(main())
