// Sign atlas access for the props: one place that turns a (category, seed) or a fixed id into the atlas rectangle
// to print on a plate. The atlas layout belongs to src/world/signs.js; props only ever size their plates from the
// returned aspect ratio and map the returned uv rectangle.

import { pickSign, signById } from '../signs.js';

/** Atlas entry for a category: { uv: [u0, v0, u1, v1] (top-left to bottom-right), aspect, emissiveCode, decal, lit, glow }. */
export const signRect = (category, seed) => pickSign(category, seed);
/** Atlas entry with a fixed id (for plates whose wording matters, such as the telephone header); falls back to the category. */
export const signNamed = (id, category, seed = 0) => signById(id) || pickSign(category, seed);
/** Atlas entry with a fixed id, or null while the atlas does not have it: for wording that has no sensible stand-in. */
export const signIfPresent = (id) => signById(id);
