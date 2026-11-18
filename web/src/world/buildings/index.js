// Buildings: `buildBuilding(lot, level)` and the archetype table (design/ARCHITECTURE.md section 9.4).
// The published interface, the lot record and the lot-local frame are described in README.md beside this file.

import { clamp } from '../../core/math.js';
import { Kit, placeRecords } from './kit.js';
import { decoHotel } from './deco.js';
import { decoApartment, decoShop } from './deco2.js';
import { motel, hotelTower } from './resort.js';
import { officeTower, officeBlock, parkingGarage } from './downtown.js';
import { warehouse, hangar } from './industrial.js';
import { stripMall, diner, shopRow, bungalow, villa, mansion, gasStation } from './low.js';

const DISTRICT_STYLE = { downtown: 'downtown', little_haiti: 'residential_poor', little_havana: 'latin_quarter', viceport: 'industrial_port', escobar_international: 'airport', fort_baxter: 'military',
  vice_point: 'hotel_strip', washington_beach: 'beach_resort', ocean_beach: 'artdeco_beach', starfish_island: 'mansion_island', prawn_island: 'studio_island', leaf_links: 'golf', leaf_links_north: 'golf' };
/** District style of a district id (a style name passes through). */
export const styleOf = (districtOrStyle) => DISTRICT_STYLE[districtOrStyle] ?? districtOrStyle;

const A = (name, build, minWidth, maxWidth, minDepth, maxDepth, f0, f1, floorHeight, groundHeight, top, groundCover, margin, variants, styles, cornerOnly = false) =>
  [name, Object.freeze({ name, build, styles: Object.freeze(styles), minWidth, maxWidth, minDepth, maxDepth, floors: Object.freeze([f0, f1]), floorHeight, groundHeight, top, groundCover, margin: Object.freeze({ front: margin[0], side: margin[1], back: margin[2] }), cornerOnly, variants })];

/** The archetype table. `build(kit, lot)` is internal; everything else is the published record (see README.md). */
export const ARCHETYPES = Object.freeze(Object.fromEntries([
  A('deco_hotel', decoHotel, 14, 34, 18, 42, 2, 7, 3.0, 4.0, 0.9, 'paved', [0.2, 0.6, 2.2], 7, { artdeco_beach: 10, beach_resort: 4 }),
  A('deco_apartment', decoApartment, 12, 30, 16, 40, 2, 4, 3.0, 3.5, 0.8, 'paved', [3, 1, 2.5], 4, { artdeco_beach: 6, beach_resort: 6, hotel_strip: 2 }),
  A('deco_shop', decoShop, 10, 44, 12, 30, 1, 2, 3.0, 4.0, 0.9, 'paved', [1.5, 0.15, 1.5], 3, { artdeco_beach: 4, beach_resort: 4, latin_quarter: 2 }),
  A('motel', motel, 28, 64, 22, 44, 1, 2, 2.75, 2.87, 0.6, 'asphalt', [2, 1, 1.2], 4, { hotel_strip: 4, beach_resort: 2, latin_quarter: 1, downtown: 1 }),
  A('hotel_tower', hotelTower, 30, 80, 24, 50, 8, 22, 3.0, 5.0, 4.0, 'paved', [6.5, 2, 2], 4, { hotel_strip: 8, beach_resort: 4, downtown: 2 }),
  A('office_tower', officeTower, 30, 70, 30, 70, 12, 45, 3.9, 6.0, 1.2, 'paved', [5.5, 1.5, 1.5], 6, { downtown: 8 }),
  A('office_block', officeBlock, 18, 54, 18, 44, 3, 12, 3.5, 4.6, 1.0, 'paved', [1.2, 0.6, 2], 4, { downtown: 6, beach_resort: 2, hotel_strip: 1, latin_quarter: 1 }),
  A('parking_garage', parkingGarage, 30, 70, 28, 46, 3, 8, 3.0, 3.0, 1.1, 'paved', [1.5, 0.8, 0.8], 3, { downtown: 4, hotel_strip: 2, airport: 2 }),
  A('strip_mall', stripMall, 34, 100, 26, 46, 1, 1, 4.4, 4.4, 0.8, 'asphalt', [1.5, 1, 1.5], 3, { latin_quarter: 4, residential_poor: 2, hotel_strip: 3, downtown: 1 }),
  A('diner', diner, 16, 30, 16, 30, 1, 1, 3.3, 3.3, 0.3, 'asphalt', [3.2, 2, 1.5], 3, { latin_quarter: 1, hotel_strip: 1, beach_resort: 1, artdeco_beach: 1 }),
  A('shop_row', shopRow, 8, 44, 12, 28, 1, 4, 3.0, 3.8, 0.7, 'paved', [1.0, 0.1, 2.5], 4, { latin_quarter: 10, residential_poor: 5, artdeco_beach: 2, beach_resort: 2 }),
  A('bungalow', bungalow, 9, 18, 12, 26, 1, 1, 2.9, 2.9, 1.6, 'lawn', [5.2, 1.5, 2], 3, { latin_quarter: 4, residential_poor: 8, hotel_strip: 3 }),
  A('villa', villa, 16, 30, 18, 34, 1, 2, 3.1, 3.1, 2.2, 'lawn', [6.5, 3, 1.2], 3, { hotel_strip: 5, beach_resort: 2, mansion_island: 2 }),
  A('mansion', mansion, 30, 70, 30, 70, 2, 3, 3.4, 3.4, 3.0, 'lawn', [0.5, 0.5, 0.5], 3, { mansion_island: 10, studio_island: 2 }),
  A('gas_station', gasStation, 26, 44, 22, 34, 1, 1, 3.6, 3.6, 0.5, 'asphalt', [3, 1.5, 1.5], 3, { latin_quarter: 1, hotel_strip: 1, residential_poor: 1, downtown: 1 }),
  A('warehouse', warehouse, 22, 90, 18, 60, 1, 2, 2.5, 7.0, 1.5, 'concrete', [2, 1.2, 1.2], 3, { industrial_port: 10, residential_poor: 3, airport: 2, studio_island: 3, military: 4 }),
  A('hangar', hangar, 34, 80, 34, 70, 1, 1, 10, 10, 4, 'concrete', [5, 1.5, 1.5], 3, { airport: 8, military: 5 }),
]));

/** Archetypes allowed in a district (id or style), heaviest first: [{ name, weight }]. */
export function archetypesFor(districtOrStyle) {
  const style = styleOf(districtOrStyle);
  return Object.values(ARCHETYPES).filter((a) => a.styles[style]).map((a) => ({ name: a.name, weight: a.styles[style] })).sort((a, b) => b.weight - a.weight);
}
/** Parapet or eaves height of an archetype with the given number of storeys, metres above the lot ground. */
export function buildingHeight(name, floors) {
  const a = ARCHETYPES[name]; if (!a) return floors * 3.2;
  const f = clamp(Math.round(floors), a.floors[0], a.floors[1]);
  return a.groundHeight + (f - 1) * a.floorHeight + a.top;
}

/**
 * Build one building in lot-local coordinates. level: 0 near, 1 mid, 2 far.
 * Returns { mesh, lights, glows, colliders, signs, height, triangles }.
 */
export function buildBuilding(lot, level = 0) {
  const a = ARCHETYPES[lot.archetype] ?? ARCHETYPES.shop_row ?? Object.values(ARCHETYPES)[0];
  const safe = { ...lot, seed: lot.seed >>> 0, width: clamp(lot.width, a.minWidth * 0.8, a.maxWidth * 1.5), depth: clamp(lot.depth, a.minDepth * 0.8, a.maxDepth * 1.5), floors: clamp(Math.round(lot.floors ?? a.floors[0]), a.floors[0], a.floors[1]), style: styleOf(lot.style ?? lot.district) };
  const k = new Kit(safe, clamp(level | 0, 0, 2));
  a.build(k, safe);
  return k.result();
}

export { placeRecords };
