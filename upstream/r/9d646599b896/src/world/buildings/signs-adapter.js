// Sign atlas access for buildings. The atlas layout belongs to src/world/signs.js (materials owner); buildings only
// size their sign faces from the returned aspect ratio and map the returned uv rectangle.
//
// Generators and their tests must run on a partial tree (geometry previews, node tests before the atlas exists):
// then every sign keeps the aspect ratio agreed for its category and maps the whole atlas, so shapes, sizes, lights
// and budgets stay right. `atlasPresent` tells tests which case they ran.

const atlas = await import('../signs.js').catch(() => null);

// width / height per category, as agreed with the atlas owner
const ASPECT = { hotel: 5, 'hotel-blade': 0.25, motel: 3, diner: 3.5, bar: 2.5, club: 3, cafe: 3, shop: 4, market: 4, pharmacy: 4, bank: 5, cinema: 3, office: 6, garage: 4,
  gas: 2, warehouse: 6, hospital: 5, police: 5, parking: 1.5, billboard: 2, 'billboard-wide': 3.5, poster: 0.67 };
const UNLIT = new Set(['warehouse', 'office', 'garage']);
const GLOWS = [[1, 0.25, 0.55], [0.25, 0.75, 1], [1, 0.75, 0.35], [0.4, 1, 0.8], [1, 0.2, 0.15], [0.7, 0.4, 1]];
// category names use hyphens; landmark ids are the layout's own and pass through untouched
const norm = (c) => (c.startsWith('landmark:') ? c : c.replace(/_/g, '-'));

function standIn(category, seed) {
  const c = norm(category), land = c.startsWith('landmark:');
  if (land && seed > 1) return null;
  const aspect = land ? (seed === 1 ? 0.25 : 5) : (ASPECT[c] ?? 4), lit = !UNLIT.has(c);
  return { uv: [0, 0, 1, 1], aspect, glow: GLOWS[(seed >>> 0) % GLOWS.length], id: `${c}:${seed}`, text: land ? c.slice(9) : c, vertical: aspect < 0.6, lit, decal: false, emissiveCode: lit ? 68 : 0 };
}

/** True when the real atlas module is loaded. */
export const atlasPresent = !!atlas;
/**
 * Atlas entry: { uv: [u0, v0, u1, v1] (top-left to bottom-right as read), aspect (width / height), glow (linear rgb,
 * max component 1), id, text, vertical, lit, decal, emissiveCode }, or null for an unknown landmark sign.
 */
export const pickSign = (category, seed) => (atlas ? atlas.pickSign(norm(category), seed >>> 0) : standIn(category, seed >>> 0));
