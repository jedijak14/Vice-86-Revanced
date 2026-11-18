// Landmarks: the named places of design/map/layout.json. `buildLandmark(landmark, level)` returns the same record as
// `buildBuilding` (see ../buildings/README.md) in the landmark's own lot frame: origin at its centre on the ground,
// +Z towards its front, the footprint's first number along X.

import { hashInts } from '../../core/math.js';
import { Kit, placeRecords } from '../buildings/kit.js';
import { TRIM, NEON } from '../buildings/palette.js';
import { nameMap, DEG } from './common.js';
import * as C from './civic.js';
import * as S from './special.js';

/** Lot record of a landmark, in the form the planner uses for every lot. */
export const landmarkLot = (m) => ({ id: 'landmark:' + m.id, x: m.pos[0], z: m.pos[1], yaw: Math.PI - m.yawDeg * DEG, width: m.footprint[0], depth: m.footprint[1], district: m.district, archetype: 'landmark',
  floors: Math.max(1, Math.round(m.heightM / 3.4)), seed: hashInts(m.pos[0] * 10 | 0, m.pos[1] * 10 | 0, 7), landmark: { id: m.id, kind: m.kind, gameName: m.gameName, heightM: m.heightM } });

const BLUE_WHITE = { wall: [0.82, 0.88, 0.93], trim: TRIM.PALE_BLUE }, CREAM_BLUE = { wall: [0.92, 0.88, 0.78], trim: TRIM.PERIWINKLE };
/** One recipe per place. Places the layout may add later fall back on their kind. */
const RECIPES = {
  ocean_view_hotel: C.oceanHotel, lighthouse: S.lighthouse,
  pole_position_club: (k, m) => C.club(k, m, { wall: [0.60, 0.36, 0.41], trim: TRIM.FLAMINGO, neon: NEON.pink, neon2: NEON.azure, blade: true, band: [0.2, 0.2, 0.24], chequer: true }),
  malibu_club: C.beachClub,
  washington_mall: S.courtMall, north_point_mall: S.hMall,
  ocean_view_hospital: (k, m) => C.hospital(k, m, { wall: [0.94, 0.94, 0.92], trim: TRIM.PALE_BLUE, band: [0.3, 0.5, 0.75], windows: 'RIBBON' }),
  shady_palms_hospital: (k, m) => C.hospital(k, m, { wall: [0.92, 0.87, 0.74], trim: TRIM.STRAW, band: [0.45, 0.32, 0.22] }),
  schuman_health_care: (k, m) => C.hospital(k, m, { wall: [0.94, 0.94, 0.93], trim: TRIM.SLATE, band: [0.75, 0.76, 0.78], pad: true }),
  west_haven_hospital: (k, m) => C.hospital(k, m, { wall: [0.91, 0.66, 0.58], trim: TRIM.WHITE, band: [0.94, 0.92, 0.88], age: 2 }),
  ammu_nation_ocean_beach: C.gunShop, ammu_nation_downtown: C.gunShop,
  pay_n_spray_ocean_beach: C.sprayShop, pay_n_spray_vice_point: C.sprayShop, pay_n_spray_little_haiti: C.sprayShop, pay_n_spray_viceport: C.sprayShop, eight_ball_bomb_shop: C.sprayShop,
  marina: C.marina, rosenberg_office: C.lawOffice, bunch_of_tools: C.hardware, star_view_heights: C.pinkCondo,
  police_washington_beach: (k, m) => C.police(k, m, { ...BLUE_WHITE, pad: true }), police_vice_point: (k, m) => C.police(k, m, CREAM_BLUE),
  police_downtown: (k, m) => C.police(k, m, { wall: [0.7, 0.7, 0.68], trim: TRIM.SLATE, glass: true }), police_little_havana: (k, m) => C.police(k, m, { wall: [0.9, 0.86, 0.74], trim: TRIM.NAVY }),
  el_swanko_casa: C.modernVilla, links_view_apartment: C.golfApartments, leaf_links_clubhouse: C.clubhouse, interglobal_films: S.filmStudio, prawn_mansions: C.ruins, vercetti_estate: C.estate,
  hyman_memorial_stadium: S.stadium, hyman_condo: C.courtCondo, vcn_building: C.newsTower, fire_station: C.fireStation, greasy_chopper: C.bikerBar, moist_palms_hotel: C.junctionHotel, v_rock: C.radioStudio,
  downtown_tower_a: C.tallestTower, downtown_tower_b: C.twinTower, kaufman_cabs: C.cabDepot, print_works: C.printWorks, junkyard: S.scrapyard, phils_place: S.trailerLot, auntie_poulets: C.stiltShack,
  cafe_robina: C.cafe, cherry_popper: C.iceCreamFactory, sunshine_autos: C.showroom, laundromat: C.laundromat, viceport_docks: S.docks, boatyard: S.boatyard, port_authority: C.portOffice,
  airport_terminal_south: S.terminalFan, airport_terminal_north: S.terminalBlock, airport_hangars: (k, m) => S.hangarRow(k, m, 1), fort_baxter: S.armyBase,
};
const BY_KIND = {
  hotel: C.oceanHotel, lighthouse: S.lighthouse, club: RECIPES.pole_position_club, mall: S.courtMall, hospital: RECIPES.ocean_view_hospital, gunshop: C.gunShop, garage: C.sprayShop, marina: C.marina,
  police: RECIPES.police_vice_point, office: C.lawOffice, shop: C.laundromat, tower: C.pinkCondo, house: C.modernVilla, apartments: C.golfApartments, clubhouse: C.clubhouse, studio: C.radioStudio, ruin: C.ruins,
  mansion: C.estate, stadium: S.stadium, firestation: C.fireStation, bar: C.bikerBar, depot: C.cabDepot, factory: C.printWorks, junkyard: S.scrapyard, compound: S.trailerLot, cafe: C.cafe, showroom: C.showroom,
  docks: S.docks, boatyard: S.boatyard, terminal: S.terminalBlock, hangar: (k, m) => S.hangarRow(k, m, 1), military: S.armyBase,
};

/** Ids with a recipe of their own. */
export const LANDMARK_IDS = Object.freeze(Object.keys(RECIPES));

/**
 * Build one landmark in its lot frame. landmark: a record of layout.landmarks; level: 0 near, 1 mid, 2 far.
 * Returns { mesh, lights, glows, colliders, signs, height, triangles }; colliders are the same at every level.
 */
export function buildLandmark(landmark, level = 0) {
  const k = new Kit(landmarkLot(landmark), level);
  k.signMap = nameMap(landmark.id);
  const recipe = RECIPES[landmark.id] ?? BY_KIND[landmark.kind] ?? C.laundromat;
  recipe(k, landmark);
  // what a car can hit must not change with distance: fences, cranes and stands drawn only near still collide when the
  // place is shown simplified, so the colliders always come from the near build
  if (level > 0) { const near = new Kit(k.lot, 0); near.signMap = k.signMap; recipe(near, landmark); k.colliders = near.colliders; }
  return k.result();
}
/**
 * Triangle allowances for one landmark, [near, mid, far]. A landmark is one object but may be a whole compound (the
 * docks, the base, a mall with its car parks), so the mid and far allowances of a single building (1,500 and 150)
 * scale with the footprint in units of a large building lot (4,000 m2), up to six of them. Near keeps the limit of
 * one building.
 */
export function landmarkBudget(landmark) {
  const lots = Math.min(6, Math.max(1, landmark.footprint[0] * landmark.footprint[1] / 4000));
  return [25000, Math.round(1500 * lots), Math.round(150 * lots)];
}
export { placeRecords };
