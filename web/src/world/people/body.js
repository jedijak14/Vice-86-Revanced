// People: the bodies of the street, authored with the traffic kit and hung on world/people/rig.js.
//
// Each drawn part is built in its own joint's frame, so the same shirt mesh serves a person standing,
// walking, hailing a taxi or throwing their hands up. That is what makes a crowd affordable: one set of
// meshes per outfit, made once at start-up, then posed by matrices for every body on the pavement.
//
// Everything here follows the release's own way of making a car: a MeshBuilder for the packed
// attributes, a Skin to orient triangles from node normals, and the kit's solids for what is worn.
// People take the vehicle family's flat materials, exactly as the patrol officer does
// (vehicles/traffic/officers.js), so they answer the street's lamps, shadows and reflection probe
// without a shader of their own.

import { MeshBuilder } from '../../core/mesh.js';
import { Skin } from '../../vehicles/traffic/skin.js';
import { box, rod, disc, lathe, X, Y, Z } from '../../vehicles/traffic/kit.js';
import { trim } from '../../vehicles/traffic/materials.js';
import { hexColor, m4translation, m4rotationX, m4mul, m4 } from '../../core/math.js';

const hex = (n) => hexColor(n);
const fabric = (rgb) => trim(0.86, rgb);
const leather = (rgb) => trim(0.45, rgb);
const bare = (rgb) => trim(0.78, rgb);
const HAIR = trim(0.7, hex(0x1b1712));
const SHOE = leather(hex(0x1d1e22));

/**
 * The outfits on the island. `bottom` is how far the leg covering goes: 'long' trousers, 'short' above
 * the knee, 'skirt' to mid-thigh. `hat` is 'cap', 'sun' or none. `bag` is a shoulder bag, the one thing
 * that reads across a street as "this person has somewhere to be".
 */
export const OUTFITS = Object.freeze([
  { id: 'shirt', name: 'Shirt and slacks', top: hex(0x2f6f8f), bottom: 'long', trouser: hex(0x3b3f47), hat: 'none', bag: true },
  { id: 'polo', name: 'Polo and shorts', top: hex(0xd8d3c4), bottom: 'short', trouser: hex(0x53412e), hat: 'cap', bag: false },
  { id: 'dress', name: 'Summer dress', top: hex(0xe06a86), bottom: 'skirt', trouser: hex(0xe06a86), hat: 'sun', bag: true },
  { id: 'singlet', name: 'Beach goer', top: hex(0xf2b23c), bottom: 'short', trouser: hex(0x1f4a6b), hat: 'none', bag: false },
  { id: 'coverall', name: 'Dock worker', top: hex(0x4a5a6a), bottom: 'long', trouser: hex(0x414d5a), hat: 'cap', bag: true },
  { id: 'suit', name: 'A man in a suit', top: hex(0x24262c), bottom: 'long', trouser: hex(0x22242a), hat: 'none', bag: true },
]);

/** Skin tones, taken in turn so a crowd is not one mould. */
export const SKIN_TONES = Object.freeze([hex(0xd9a878), hex(0x8a5c3b), hex(0x5c3a26), hex(0xefc9a4), hex(0xb8825a)]);

// ------------------------------------------------------------------------------------------ parts
// Every one of them is authored around the joint the rig hangs it from: the torso's origin is the chest
// joint, an arm's is the shoulder, a thigh's is the hip, a shin's is the knee. y is up, z is forward.

function torsoMesh(outfit, tone, female) {
  const mb = new MeshBuilder(900);
  const sk = new Skin(mb);
  const shirt = fabric(outfit.top), neck = bare(tone), belt = leather(hex(0x2b2118));
  box(sk, shirt, [0, 0.02, 0], [0.185, 0.2, 0.105], {});                    // the chest, squared at the shoulders
  box(sk, shirt, [0, -0.14, 0], [0.155, 0.06, 0.095], {});                  // the waist
  box(sk, shirt, [0, 0.17, 0], [0.155, 0.045, 0.1], {});                    // the shoulder line
  if (outfit.bottom === 'skirt') box(sk, fabric(outfit.trouser), [0, -0.225, 0], [0.19, 0.055, 0.13], {});
  else box(sk, belt, [0, -0.19, 0], [0.16, 0.022, 0.1], {});
  box(sk, neck, [0, 0.235, 0.005], [0.05, 0.04, 0.05], {});                 // the neck
  box(sk, neck, [0, 0.345, 0], [0.083, 0.093, 0.095], {});                  // the head
  for (const s of [-1, 1]) box(sk, neck, [s * 0.086, 0.345, -0.005], [0.008, 0.05, 0.055], {});   // ears
  box(sk, HAIR, [0, 0.402, -0.014], [0.089, 0.052, 0.09], {});
  if (female) box(sk, HAIR, [0, 0.29, -0.078], [0.075, 0.12, 0.028], {});    // hair down the back
  box(sk, trim(0.66, hex(0x14161a)), [0, 0.362, 0.094], [0.052, 0.012, 0.005], {});   // the brow
  if (outfit.hat === 'cap') {
    box(sk, fabric(outfit.trouser), [0, 0.45, 0.01], [0.092, 0.03, 0.098], {});
    box(sk, fabric(outfit.trouser), [0, 0.425, 0.112], [0.075, 0.012, 0.05], {});      // the peak
  } else if (outfit.hat === 'sun') {
    disc(sk, fabric(outfit.trouser), [0, 0.44, 0], Y, X, Z, 0.19, 14, 1, 0.075);
    box(sk, fabric(outfit.trouser), [0, 0.455, 0], [0.086, 0.028, 0.09], {});
  }
  return mb;
}

function armMesh(outfit, tone, left) {
  const mb = new MeshBuilder(520);
  const sk = new Skin(mb);
  rod(sk, fabric(outfit.top), [0, -0.02, 0], [0, -0.26, 0.005], 0.055, 8, true);       // sleeve
  rod(sk, bare(tone), [0, -0.26, 0.005], [0, -0.48, 0.02], 0.043, 7, true);            // forearm
  box(sk, bare(tone), [0, -0.535, 0.022], [0.038, 0.055, 0.03], {});                   // hand
  if (outfit.bag && left) {
    box(sk, leather(hex(0x4a3626)), [-0.055, -0.1, 0.075], [0.012, 0.17, 0.006], {});  // strap
    box(sk, leather(hex(0x4a3626)), [-0.2, -0.62, 0.02], [0.06, 0.075, 0.035], {});    // the bag
  }
  return mb;
}

function thighMesh(outfit, tone) {
  const mb = new MeshBuilder(430);
  const sk = new Skin(mb);
  const cloth = fabric(outfit.trouser);
  if (outfit.bottom === 'skirt') {
    rod(sk, bare(tone), [0, -0.03, 0], [0, -0.4, 0], 0.052, 7, true);
    lathe(sk, cloth, [0, -0.02, 0], Y, X, Z, [{ r: 0.13, h: 0, nr: 1, nh: 0.2 }, { r: 0.165, h: -0.17, nr: 1, nh: 0.25 }], 12);
  } else if (outfit.bottom === 'short') {
    rod(sk, cloth, [0, -0.02, 0], [0, -0.22, 0], 0.072, 8, true);
    rod(sk, bare(tone), [0, -0.22, 0], [0, -0.4, 0], 0.055, 7, true);
  } else {
    rod(sk, cloth, [0, -0.02, 0], [0, -0.4, 0.004], 0.075, 8, true);
    box(sk, cloth, [0, -0.2, 0.006], [0.078, 0.19, 0.082], {});       // the fall of a trouser leg
  }
  return mb;
}

function shinMesh(outfit, tone) {
  const mb = new MeshBuilder(430);
  const sk = new Skin(mb);
  const clothed = outfit.bottom === 'long';
  rod(sk, clothed ? fabric(outfit.trouser) : bare(tone), [0, -0.02, 0], [0, -0.3, 0.006], clothed ? 0.058 : 0.05, 7, true);
  box(sk, SHOE, [0, -0.35, 0.028], [0.045, 0.03, 0.055], {});         // over the instep
  box(sk, SHOE, [0, -0.385, 0.045], [0.048, 0.014, 0.1], {});         // the sole
  return mb;
}

/**
 * One person's parts, as MeshBuilders, unscaled: `scale` is applied by a transform so that a child is
 * the same geometry and not a second set of meshes.
 * @param {object} outfit  an entry of OUTFITS
 * @param {number} tone    an index into SKIN_TONES
 */
export function personParts(outfit = OUTFITS[0], tone = 0, scale = 1) {
  const skin = SKIN_TONES[Math.abs(tone | 0) % SKIN_TONES.length];
  const female = outfit.bottom === 'skirt';
  const parts = {
    torso: torsoMesh(outfit, skin, female),
    armL: armMesh(outfit, skin, true),
    armR: armMesh(outfit, skin, false),
    thighL: thighMesh(outfit, skin),
    thighR: thighMesh(outfit, skin),
    shinL: shinMesh(outfit, skin),
    shinR: shinMesh(outfit, skin),
  };
  if (scale !== 1) {
    const s = m4scalingOf(scale);
    for (const name in parts) parts[name].transform(s);
  }
  return parts;
}

function m4scalingOf(k) { const m = m4(); return m4scaling(m, k, k, k); }
function m4scaling(m, x, y, z) { m4translation(m, 0, 0, 0); m[0] = x; m[5] = y; m[10] = z; return m; }

/**
 * The meshes for one outfit, finished and ready for `renderer.createMesh`.
 * @returns {Record<string, object>} part name to the packed mesh the renderer wants
 */
export function buildPersonMeshes(outfit, tone, scale = 1) {
  const parts = personParts(outfit, tone, scale), out = {};
  for (const name in parts) out[name] = parts[name].finish();
  return out;
}

/**
 * A person frozen mid-stride, in one mesh: the far ranks of a crowd. Drawn as one object, it costs a
 * seventh of an articulated walker and reads the same at sixty metres, which is the whole trade.
 * @param {number} [phase] 0..1 into the two-step cycle
 */
export function buildPersonWhole(outfit = OUTFITS[0], tone = 0, phase = 0.25, scale = 1) {
  const parts = personParts(outfit, tone, scale);
  const merged = new MeshBuilder(2600);
  const swing = Math.sin(phase * Math.PI * 2) * 0.3;
  const put = (name, x, y, z, rx) => {
    let m = m4translation(m4(), x, y, z);
    if (rx) m = m4mul(m4(), m, m4rotationX(m4(), rx));
    merged.append(parts[name], m);
  };
  // The same rig the near crowd is driven by, solved once by hand and baked into the vertices.
  put('torso', 0, 1.33, 0, 0.03);
  put('armL', 0.205, 1.46, 0, -swing * 0.85 - 0.12);
  put('armR', -0.205, 1.46, 0, swing * 0.85 - 0.12);
  put('thighL', 0.095, 0.92, 0, swing);
  put('shinL', 0.095, 0.5, 0, -Math.max(0, -swing) * 0.8);
  put('thighR', -0.095, 0.92, 0, -swing);
  put('shinR', -0.095, 0.5, 0, -Math.max(0, swing) * 0.8);
  return merged.finish();
}

/** Every outfit's whole-body mesh: the crowd's usual LOD. */
export function buildWholeCrowd(phase = 0.25) {
  return OUTFITS.map((outfit, i) => buildPersonWhole(outfit, i, phase));
}

/**
 * The seated passenger a fare becomes once they are in your car: the torso and the arms only, turned
 * towards the road, because the door and the seat hide everything below the belt. This is the release's
 * own trick, the one it uses for the driver baked into a cruiser.
 */
export function buildSeatedPassenger(outfit = OUTFITS[1], tone = 0) {
  const parts = personParts(outfit, tone);
  const merged = new MeshBuilder(1400);
  const hips = m4translation(m4(), 0, 0.46, -0.02);
  merged.append(parts.torso, m4mul(m4(), hips, m4rotationX(m4(), 0.1)));
  const thigh = m4mul(m4(), m4translation(m4(), 0.095, 0.44, -0.02), m4rotationX(m4(), -1.42));
  merged.append(parts.thighL, thigh);
  merged.append(parts.shinL, m4mul(m4(), m4translation(m4(), 0.02, -0.42, 0.02), thigh));
  const thighR = m4mul(m4(), m4translation(m4(), -0.095, 0.44, -0.02), m4rotationX(m4(), -1.36));
  merged.append(parts.thighR, thighR);
  merged.append(parts.shinR, m4mul(m4(), m4translation(m4(), 0.02, -0.42, 0.02), thighR));
  // The shoulders sit where the torso puts them: the hip is on the seat at 0.46, the chest joint
  // 0.39 above that, and the arm bones hang from the top of the chest.
  for (const [name, x] of [['armL', 0.205], ['armR', -0.205]]) {
    merged.append(parts[name], m4mul(m4(), m4translation(m4(), x, 1.0, -0.02), m4rotationX(m4(), -0.62)));
  }
  return merged.finish();
}
