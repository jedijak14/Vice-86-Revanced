// Citizens: the people on the pavement, built rather than borrowed.
//
// The vendored cast is a shelf of fantasy adventurers — a barbarian, a knight, a mage — because that is
// the only CC0 shelf of rigged bodies we could reach, and a street of knights is a street nobody lives
// on. No mirror we are allowed to fetch carries modern citizens (the Quaternius people packs exist only
// as release binaries on hosts this sandbox cannot touch, and an empty LICENSE-only mirror is not a
// source), so the citizens are made the way this project makes its cars, its boats and its swim stroke:
// procedurally, from a seed, in the metre and on the skeleton the street already owns.
//
// A citizen is a low-poly body in modern clothes — tee or jacket or dress, trousers or shorts, trainers,
// hair or cap or beanie, six skin tones and a wardrobe of fourteen ordinary colours — lofted as tapered
// prisms along the *vendored skeleton's own bind pose*, and skinned rigidly part-by-part to its bones.
// Same bones, same names, same clips: a citizen walks, runs, sits, swims and takes a bullet with the
// KayKit animation library, because to the animation a citizen *is* a KayKit body wearing different
// clothes. The police are citizens in uniform: navy shirt and trousers, peaked cap, belt, and a badge
// the size a badge is at forty metres.
//
// Nothing here is fetched. The whole population of the city is a few thousand triangles of procedure.

/** Six skin tones, from pale to deep, in sRGB 0..1. */
const SKIN = [
  [0.88, 0.73, 0.62], [0.80, 0.62, 0.48], [0.66, 0.46, 0.33],
  [0.48, 0.31, 0.21], [0.33, 0.21, 0.14], [0.93, 0.82, 0.72],
];
/** Fourteen ordinary colours: the high street, not the costume department. */
const CLOTH = [
  [0.20, 0.24, 0.32], [0.42, 0.44, 0.46], [0.72, 0.70, 0.66], [0.35, 0.20, 0.18],
  [0.16, 0.32, 0.30], [0.55, 0.30, 0.34], [0.85, 0.83, 0.78], [0.24, 0.28, 0.22],
  [0.62, 0.48, 0.30], [0.30, 0.34, 0.42], [0.50, 0.20, 0.24], [0.22, 0.22, 0.24],
  [0.78, 0.62, 0.30], [0.36, 0.42, 0.52],
];
const HAIR = [[0.10, 0.08, 0.06], [0.24, 0.16, 0.09], [0.45, 0.32, 0.16], [0.75, 0.72, 0.66], [0.05, 0.05, 0.06]];
/** The uniform: navy shirt, darker trousers, black belt, brass badge. */
const POLICE = Object.freeze({
  shirt: [0.13, 0.17, 0.26], trousers: [0.09, 0.10, 0.15], cap: [0.10, 0.12, 0.20],
  belt: [0.05, 0.05, 0.06], badge: [0.85, 0.70, 0.25],
});

/** mulberry32: small, fast, and the same citizen every time for the same seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * One citizen, as a character record in the cast's own shape: the arrays a person is skinned from, hung
 * off the vendored skeleton of `base` — the same rig, the same rest, the same clips.
 * @param {object} base   a character record from cast.js, for its rig, gltf and authored metre
 * @param {number} seed
 * @param {{police?: boolean, name?: string}} [opts]
 */
export function buildCitizen(base, seed, opts = {}) {
  const r = rng(seed * 2654435761 + 11);
  const police = !!opts.police;
  const worlds = base.gltf.worldMatrices();
  const J = (name) => {
    const i = base.rig.node(name);
    return i < 0 ? [0, 0, 0] : [worlds[i * 16 + 12], worlds[i * 16 + 13], worlds[i * 16 + 14]];
  };
  const hips = J('hips'), spine = J('spine'), chest = J('chest'), head = J('head');
  const uaL = J('upperarm.l'), uaR = J('upperarm.r');
  const shoulder = Math.max(0.12, Math.hypot(uaL[0] - uaR[0], uaL[2] - uaR[2]) / 2);
  const crown = head[1] + (chest[1] - spine[1]) * 1.5;      // the top of the head, in the bind's metre
  const build = Math.min(1.25, 0.85 + r() * 0.4);            // 0.85 slight .. 1.25 heavy
  const skin = police ? SKIN[Math.floor(r() * SKIN.length)] : pick(r, SKIN);
  const top = police ? POLICE.shirt : pick(r, CLOTH);
  const bottom = police ? POLICE.trousers : pick(r, CLOTH);
  const shoe = [0.10 + r() * 0.1, 0.10 + r() * 0.1, 0.11 + r() * 0.1];
  const hair = pick(r, HAIR);
  const style = police ? 'cap' : ['tee', 'jacket', 'tee', 'dress', 'tee', 'jacket'][Math.floor(r() * 6)];
  const hairStyle = police ? 'cap' : ['short', 'short', 'long', 'bun', 'cap', 'none'][Math.floor(r() * 6)];

  const positions = [], normals = [], colors = [], joints = [], weights = [], tris = [], sways = [];
  const b = { positions, normals, colors, joints, weights, tris };

  /** A tapered prism from `a` to `b`, `sides` around, radii r0/r1, rigidly on one bone. */
  function limb(a, ax, r0, r1, col, bone, sides = 8, capTop = true, capBot = true, squash = 1, swayV = 0) {
    const y = norm3([ax[0] - a[0], ax[1] - a[1], ax[2] - a[2]]);
    let up = Math.abs(y[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
    const x = norm3(cross(up, y));
    const z = cross(x, y);
    const ring = (c, rad, extra) => {
      const first = positions.length / 3;
      for (let i = 0; i < sides; i++) {
        const t = (i / sides) * Math.PI * 2;
        const ct = Math.cos(t) * rad, st = Math.sin(t) * rad * squash;
        const p = [c[0] + x[0] * ct + z[0] * st + (extra ? extra[0] : 0),
          c[1] + x[1] * ct + z[1] * st + (extra ? extra[1] : 0),
          c[2] + x[2] * ct + z[2] * st + (extra ? extra[2] : 0)];
        const n = norm3([x[0] * ct + z[0] * st, x[1] * ct + z[1] * st, x[2] * ct + z[2] * st]);
        positions.push(...p); normals.push(...(n.length ? n : [0, 1, 0])); sways.push(swayV);
        colors.push(col[0] * 255, col[1] * 255, col[2] * 255);
        joints.push(bone, 0, 0, 0); weights.push(255, 0, 0, 0);
      }
      return first;
    };
    const A = ring(a, r0), B = ring(ax, r1);
    // Double-wound: the renderer culls back faces, and a prism seen from inside a sleeve is still a
    // surface somebody is looking at.
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tris.push(A + i, A + j, B + j, A + i, B + j, A + j);
    }
    if (capBot) for (let i = 1; i + 1 < sides; i++) tris.push(A, A + i + 1, A + i, A, A + i, A + i + 1);
    if (capTop) for (let i = 1; i + 1 < sides; i++) tris.push(B, B + i, B + i + 1, B, B + i + 1, B + i);
  }
  /** An axis-aligned box by centre and half-extents, rigidly on one bone: 24 verts, honest normals. */
  function box(c, hx, hy, hz, col, bone, swayV = 0) {
    const first = positions.length / 3;
    const corners = [
      [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1],
      [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1],
    ];
    const faces = [
      [0, 1, 2, 3, [0, -1, 0]], [7, 6, 5, 4, [0, 1, 0]], [1, 5, 6, 2, [1, 0, 0]],
      [3, 2, 6, 7, [-1, 0, 0]], [2, 6, 5, 1, [0, 0, 1]], [0, 3, 7, 4, [0, 0, -1]],
    ];
    for (const [a0, a1, a2, a3, n] of faces) {
      for (const vi of [a0, a1, a2, a0, a2, a3]) {
        const [sx, sy, sz] = corners[vi];
        positions.push(c[0] + sx * hx, c[1] + sy * hy, c[2] + sz * hz); sways.push(swayV);
        normals.push(n[0], n[1], n[2]);
        colors.push(col[0] * 255, col[1] * 255, col[2] * 255);
        joints.push(bone, 0, 0, 0); weights.push(255, 0, 0, 0);
      }
    }
    for (let i = 0; i < 36; i += 3) tris.push(first + i, first + i + 1, first + i + 2, first + i, first + i + 2, first + i + 1);
  }
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
  const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
  const mid = (p, q, t = 0.5) => [lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t)];

  const bi = (name) => Math.max(0, base.rig.joints.indexOf(base.rig.node(name)));
  const torsoTop = mid(chest, head, 0.35);
  // Pelvis, belly, chest: three prisms, the middle one carrying the shoulders' width.
  limb(mid(hips, spine, 0.2), mid(hips, spine, 0.9), 0.13 * build, 0.125 * build, bottom, bi('hips'), 8, true, true, 0.8);
  limb(mid(hips, spine, 0.9), mid(spine, chest, 0.5), 0.125 * build, 0.135 * build, top, bi('spine'), 8, false, false, 0.75);
  limb(mid(spine, chest, 0.5), torsoTop, 0.135 * build, shoulder * 0.62, top, bi('chest'), 8, true, false, 0.72);
  // Neck and head.
  limb(mid(chest, head, 0.55), mid(chest, head, 0.9), 0.05, 0.05, skin, bi('chest'), 6);
  const headR = 0.095 * (0.94 + r() * 0.12);
  limb(mid(chest, head, 0.9), [head[0], crown - headR * 0.55, head[2]], headR, headR * 0.92, skin, bi('head'), 8, true, false, 1.08);
  // Hair and hats sit on the skull.
  if (hairStyle === 'short' || hairStyle === 'long' || hairStyle === 'bun') {
    limb([head[0], crown - headR * 0.75, head[2]], [head[0], crown + headR * 0.28, head[2]], headR * 1.06, headR * 0.7, hair, bi('head'), 8, true, false, 1.1, 1);
    if (hairStyle === 'long') limb([head[0], crown - headR * 0.6, head[2] - headR * 0.7], [head[0], chest[1] + 0.06, head[2] - headR * 0.8], headR * 0.8, headR * 0.5, hair, bi('head'), 6, true, true, 0.5, 1);
    if (hairStyle === 'bun') box([head[0], crown + headR * 0.1, head[2] - headR * 0.95], headR * 0.35, headR * 0.35, headR * 0.35, hair, bi('head'), 0.8);
  }
  if (hairStyle === 'cap' || police) {
    const capCol = police ? POLICE.cap : pick(r, CLOTH);
    limb([head[0], crown - headR * 0.5, head[2]], [head[0], crown + headR * (police ? 0.5 : 0.3), head[2]], headR * 1.08, headR * (police ? 0.82 : 0.6), capCol, bi('head'), 8, true, false, 1.1, 0.25);
    box([head[0], crown - headR * 0.42, head[2] + headR * 1.15], headR * 0.85, headR * 0.1, headR * 0.55, police ? POLICE.cap : capCol, bi('head'));
  }
  // Arms: sleeve over the upper arm (short for a tee, long for a jacket), forearm, hand.
  for (const [side, tag] of [[1, 'l'], [-1, 'r']]) {
    const ua = J(`upperarm.${tag}`), la = J(`lowerarm.${tag}`), wr = J(`wrist.${tag}`), ha = J(`hand.${tag}`);
    const sleeve = style === 'jacket' || police ? wr : mid(ua, la, 0.55);
    const sleeveCol = style === 'tee' && !police ? top : top;
    limb(ua, sleeve, shoulder * 0.42 * build, shoulder * 0.34, sleeveCol, bi(`upperarm.${tag}`), 8, true, style !== 'tee' || police, 1, style === 'jacket' || police ? 0.5 : 0);
    if (style === 'tee' && !police) limb(mid(ua, la, 0.55), la, shoulder * 0.33, shoulder * 0.30, skin, bi(`upperarm.${tag}`), 8, false, false);
    limb(la, wr, shoulder * 0.30, shoulder * 0.24, style === 'jacket' || police ? top : skin, bi(`lowerarm.${tag}`), 8, false, false);
    limb(wr, ha, shoulder * 0.24, shoulder * 0.2, skin, bi(`wrist.${tag}`), 6, false, false);
    limb(ha, [ha[0] + (ha[0] - wr[0]) * 0.8, ha[1] + (ha[1] - wr[1]) * 0.8, ha[2] + (ha[2] - wr[2]) * 0.8], shoulder * 0.2, shoulder * 0.16, skin, bi(`hand.${tag}`), 6, true, false);
    // Legs: trousers or bare, shoes either way.
    const ul = J(`upperleg.${tag}`), ll = J(`lowerleg.${tag}`), ft = J(`foot.${tag}`), to = J(`toes.${tag}`);
    const bare = style === 'dress' || (!police && r() < 0.22);
    limb(ul, ll, 0.085 * build, 0.065, bare ? skin : bottom, bi(`upperleg.${tag}`), 8, true, false);
    limb(ll, ft, 0.062, 0.045, bare ? skin : bottom, bi(`lowerleg.${tag}`), 8, false, false);
    limb([ft[0], ft[1] - 0.10, ft[2] - 0.01], [to[0], ft[1] - 0.11, to[2] + 0.04], 0.06, 0.055, shoe, bi(`foot.${tag}`), 6, true, true, 0.5);
  }
  if (style === 'dress') {
    limb(mid(hips, spine, 0.4), mid(hips, spine, 0.4).map((v, i) => i === 1 ? v - 0.34 : v), 0.14 * build, 0.2, top, bi('hips'), 8, false, true, 0.85, 0.55);
  }
  if (police) {
    // Belt, badge, and the radio on the shoulder strap: the uniform's punctuation.
    box([hips[0], hips[1] + 0.05, hips[2]], 0.14 * build, 0.03, 0.11 * build, POLICE.belt, bi('hips'));
    box([chest[0] + shoulder * 0.45, chest[1] + 0.06, chest[2] + 0.12], 0.02, 0.03, 0.012, POLICE.badge, bi('chest'));
    box([chest[0] - shoulder * 0.5, chest[1] + 0.1, chest[2] + 0.1], 0.025, 0.05, 0.02, POLICE.belt, bi('chest'));
  }

  const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < bounds[k]) bounds[k] = positions[i + k];
      if (positions[i + k] > bounds[k + 3]) bounds[k + 3] = positions[i + k];
    }
  }
  return {
    name: opts.name || (police ? `officer${seed}` : `citizen${seed}`),
    gltf: base.gltf, rig: base.rig, texture: null,
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    colors, joints: new Uint8Array(joints), weights: new Uint8Array(weights),
    triangles: Int32Array.from(tris), vertexCount: positions.length / 3, sway: Float32Array.from(sways),
    bounds, authored: base.authored, bodyHeight: base.authored, heightScale: 1,
    police, citizen: true, style,
  };
}

/**
 * A street's worth of citizens plus the officers who keep it: the crowd's new shelf.
 * @param {object} base       a vendored character record, for the skeleton everything hangs off
 * @param {{citizens?: number, officers?: number, seed?: number}} [opts]
 */
export function buildCitizens(base, opts = {}) {
  const n = opts.citizens ?? 10, officers = opts.officers ?? 2, seed = opts.seed || 7;
  const out = [];
  for (let i = 0; i < n; i++) out.push(buildCitizen(base, seed + i * 31));
  for (let i = 0; i < officers; i++) out.push(buildCitizen(base, seed + 977 + i * 57, { police: true }));
  return out;
}

