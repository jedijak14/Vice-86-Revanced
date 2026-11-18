// The sign catalogue: every piece of lettering in the city and where it lives in the sign atlas.
//
// Shared by the world worker (which only needs rectangles, aspect ratios and glow colours to build geometry and
// place lights) and by the page (src/render/atlas.js paints each entry into its rectangle). Nothing here touches
// a canvas, and nothing depends on call order: the catalogue is built once from the tables below, so both sides
// always agree.
//
// Atlas conventions (see also atlas.js):
//   - nominal size ATLAS_SIZE x ATLAS_SIZE pixels, origin top-left, v grows downwards (canvas rows)
//   - uv = [u0, v0, u1, v1] = top-left and bottom-right corners of the entry
//   - every rectangle is aligned to 4 pixels and separated from its neighbours by PAD pixels, so the atlas can be
//     built at 1/2 or 1/4 size and still mip cleanly
//
// All business names are invented (design/brief/architecture.md section 10, plus a few added here in the same
// vein). Landmark signs print the stand-in `gameName` of design/map/layout.json; district and street names are the
// lore names from the same file.

import { hashString } from '../core/math.js';

export const ATLAS_SIZE = 4096;
const PAD = 8;

// ---------------------------------------------------------------- how each kind of sign is made
// w, h      size in atlas pixels (multiples of 8)
// mode      'lit'    internally lit or neon: SOLID.SIGN with an intensity code, atlas alpha is the lit mask
//           'paint'  an opaque painted or printed face lit by the sun and by floodlights (code 0)
//           'decal'  lettering painted straight onto a wall or a container: atlas alpha is the paint coverage (code 1)
// code      suggested emissive intensity code for lit faces (radiance = 0.25 * 2^(code/16): 58 = 3.1, 64 = 4, 72 = 5.7)
// styles    the painters in atlas.js this category may use; one is chosen per entry from its id
const KINDS = {
  hotel: { w: 440, h: 88, mode: 'lit', code: 64, styles: ['fascia-neon', 'fascia-channel', 'fascia-display'] },
  'hotel-blade': { w: 96, h: 384, mode: 'lit', code: 64, styles: ['blade'] },
  motel: { w: 336, h: 112, mode: 'lit', code: 62, styles: ['script-neon', 'roadside'] },
  bar: { w: 320, h: 128, mode: 'lit', code: 64, styles: ['script-neon', 'script-neon', 'marquee'] },
  club: { w: 320, h: 128, mode: 'lit', code: 66, styles: ['marquee', 'script-neon', 'fascia-display'] },
  cafe: { w: 320, h: 128, mode: 'lit', code: 60, styles: ['script-neon', 'acrylic'] },
  diner: { w: 320, h: 128, mode: 'lit', code: 62, styles: ['roadside', 'marquee'] },
  shop: { w: 352, h: 88, mode: 'lit', code: 58, styles: ['acrylic', 'acrylic-dark'] },
  'shop-latin': { w: 312, h: 104, mode: 'decal', styles: ['brush'] },
  'shop-haiti': { w: 312, h: 104, mode: 'decal', styles: ['brush'] },
  market: { w: 352, h: 88, mode: 'lit', code: 58, styles: ['acrylic'] },
  pharmacy: { w: 352, h: 88, mode: 'lit', code: 60, styles: ['acrylic'] },
  bank: { w: 432, h: 72, mode: 'lit', code: 60, styles: ['rooftop'] },
  office: { w: 432, h: 72, mode: 'lit', code: 58, styles: ['rooftop'] },
  cinema: { w: 432, h: 144, mode: 'lit', code: 66, styles: ['cinema'] },
  garage: { w: 352, h: 88, mode: 'paint', styles: ['workshop'] },
  gas: { w: 288, h: 144, mode: 'lit', code: 62, styles: ['gas'] },
  warehouse: { w: 400, h: 80, mode: 'decal', styles: ['stencil'] },
  hospital: { w: 352, h: 88, mode: 'lit', code: 62, styles: ['civic'] },
  police: { w: 352, h: 88, mode: 'lit', code: 60, styles: ['civic'] },
  parking: { w: 256, h: 128, mode: 'lit', code: 60, styles: ['civic'] },
  billboard: { w: 480, h: 240, mode: 'paint', styles: ['billboard'] },
  'billboard-wide': { w: 728, h: 208, mode: 'paint', styles: ['billboard'] },
  poster: { w: 176, h: 264, mode: 'lit', code: 58, styles: ['billboard'] },
  bench: { w: 288, h: 96, mode: 'paint', styles: ['bench'] },
  window: { w: 224, h: 112, mode: 'lit', code: 68, styles: ['window-neon'] },
  'street-name': { w: 288, h: 48, mode: 'paint', styles: ['street'] },
  direction: { w: 312, h: 104, mode: 'paint', styles: ['guide'] },
  stop: { w: 128, h: 128, mode: 'paint', styles: ['stop'] },
  speed: { w: 128, h: 160, mode: 'paint', styles: ['speed'] },
  oneway: { w: 192, h: 64, mode: 'paint', styles: ['oneway'] },
  notice: { w: 192, h: 128, mode: 'paint', styles: ['notice'] },
  newsbox: { w: 128, h: 96, mode: 'paint', styles: ['newsbox'] },
  container: { w: 384, h: 96, mode: 'decal', styles: ['container'] },
  plate: { w: 128, h: 64, mode: 'paint', styles: ['plate'] },
  landmark: { w: 400, h: 80, mode: 'lit', code: 62, styles: [] },
  'landmark-blade': { w: 88, h: 352, mode: 'lit', code: 64, styles: ['blade'] },
};

// ---------------------------------------------------------------- the words
// A row is "Text" or "Text|second line" or "Text|second line|art", where art names a small drawing or a
// billboard illustration in atlas.js.
const WORDS = {
  hotel: ['The Coral Regent', 'Hotel Marisol', 'The Sandpiper Arms', 'Tradewind Court', 'The Pelican Royale', 'Hotel Solaire', 'The Aquamarine',
    'Seafoam Terrace', 'The Tangerine', 'Hotel Lido Azul', 'The Starboard', "The Mariner's Rest", 'Hotel Biscay', 'The Catalina Arms', 'Palm Regency',
    'The Sunray', 'Hotel Calypso', 'The Driftwood Plaza', 'The Neptune Court', 'Hotel Altamar', 'The Portside', 'The Wavecrest', 'Hotel Flamenco',
    'The Sea Lantern', 'The Coquina', 'The Windward', 'Hotel Tropicaire', 'The Parkside Royal', 'The Beachcomber Arms', 'The Sunburst', 'Hotel Majestique',
    'The Crescent Tide', 'The Ocean Gem', 'The Leeward', 'The Mango Court', 'The Silver Tarpon'],
  'hotel-blade': ['Coral', 'Marisol', 'Solaire', 'Tangerine', 'Starboard', 'Biscay', 'Calypso', 'Neptune', 'Altamar', 'Coquina', 'Windward', 'Sunburst', 'Leeward', 'Tarpon'],
  motel: ['Sea Breeze|Motor Court|palm', 'Sand Dollar|Motel', 'North Star|Motor Inn|star', 'Sun and Surf|Motel|sun', 'Tiki Palms|Motel|palm', 'Gulfstream|Lodge', 'Beachway|Apartments',
    'Hotel El Faro|Habitaciones', 'La Perla del Sur|Hotel'],
  bar: ['Pink Pelican|Lounge|flamingo', 'The Rum Reef|Cocktails|glass', 'The Lime Twist|Bar|glass', 'The Tiki Torch|Cocktails|palm', 'Moonwake|Lounge|moon', 'The Sax Parlour|Live Jazz|note',
    'Conch Shell|Bar', 'The Jade Gecko|Cocktails', 'Starlite Room|Lounge|star', 'Zanzibar Room|Dancing'],
  club: ['Club Tropico|Dancing Nightly|palm', 'Neon Tide|Disco', 'Velvet Flamingo|Club|flamingo', 'Club Sirocco|Members', 'Paradiso|Disco|star', 'Club Electra|Live Tonight|bolt',
    'Cabana 9|Beach Club', 'Wavelength|Discotheque', 'Midnight Mango|Late Bar|moon', 'El Cocotero|Club Nocturno|palm'],
  cafe: ['Sundial Cafe|Espresso|sun', 'Cafe Aurora|Open Late', 'Sunny Side|Cafe|sun', 'El Cortadito|Cafe Cubano|cup', 'Kafe Ti Zwazo|Kafe - Pate|cup'],
  diner: ['Deco Diner|Open 24 Hours', 'The Chrome Spoon|Diner', 'La Palma|Cafeteria|palm', 'El Malecon|Restaurante', 'Lakay|Restaurant'],
  shop: ['Seaside Hardware|Tools - Paint - Keys', 'Coral Cleaners|One Hour Service', 'Lucky Seven Liquors|Beer - Wine - Ice', 'Paradise Pawn|Buy - Sell - Loan',
    'Deco Bowl|24 Lanes', 'Ocean Reef Realty|Sales and Rentals', 'Surfside Records|Tapes - Albums', 'Bayview Bait and Tackle|Live Shrimp', 'Sunset Camera|Film - One Hour Photo',
    'Tropic Tan Swimwear|Beach Fashions'],
  'shop-latin': ['Panaderia La Estrella|Pan Caliente|star', 'El Gallo de Oro|Comidas Criollas|rooster', 'Lavanderia La Burbuja|Lavado y Secado|bubbles', 'Joyeria El Diamante|Oro - Plata|diamond',
    'Barberia El Campeon|Cortes|pole', 'Tabacos Vuelta Arriba|Hechos a Mano|cigar', 'Fruteria El Mamey|Jugos Naturales|fruit', 'Discos Sabor|Musica|note', 'Muebleria La Nueva|Credito',
    'Ferreteria El Martillo|Llaves|hammer', 'Carniceria La Vaquita|Carnes Frescas', 'Dulceria La Colmena|Dulces|bee', 'Botanica La Caridad|Velas - Flores|candle',
    'Las Orquideas|Salon de Belleza|flower', 'Ponchera El Tigre|Gomas', 'Licoreria La Copa|Envios|glass', 'La Doble Nueve|Club de Domino|domino'],
  'shop-haiti': ['Boulangerie Bel Fle|Pen Cho|flower', 'Botanica Twa Etwal|Lwil - Balenn|star', 'Arc-en-Ciel|Blanchisserie|rainbow', 'Salon Bel Cheve|Coiffure', 'Tap Tap Transfer|Envios - Kago',
    'Radyo Lakou Records|Mizik|note', 'Bon Gout Bakery|Fresh Daily|cup', 'Ti Kay Grocery|Open 7 Days|fruit'],
  market: ['Mercado Los Hermanos|Abierto', 'Marche Soleil|Fruits - Legumes', 'Bodega El Sol|Cambio de Cheques', 'La Belle Etoile|Epicerie'],
  pharmacy: ['Poinciana Drugs|Prescriptions', 'Farmacia San Lazaro|Recetas - Se Habla Ingles', 'Beachside Pharmacy|Open Sundays'],
  bank: ['Suncoast Federal', 'Tropibank', 'Gulfstream Savings', 'Biscay National Bank', 'Pan-Caribbean Trust', 'Coral State Bank', 'Verano Bay Financial'],
  office: ['Orbit Communications', 'Sunstate Insurance', 'Palmetto Power and Light', 'Hotel Centurion', 'Aerovia del Sol', 'Caribe Star Lines', 'Bay Plaza'],
  cinema: ['Cine Riviera|Hoy: Noche de Neon - El Ultimo Puente', 'The Coral Screen|Now Showing: Causeway Heat - Palm Shadows', 'Mangrove Twin|Twin Screens: Midnight Marina - Sunset Run'],
  garage: ['Taller El Rapido|Mecanica General', 'Causeway Auto Repair|Brakes - Tune Ups', 'Palm Avenue Body Shop|Paint and Collision', 'Bayside Brake and Tire|Alignment'],
  gas: ['Daybreak|Regular  Unleaded|sun', 'Pelican|Self Serve|bird', 'Coastline|Gas - Diesel|wave'],
  warehouse: ['Tradewind Freight|Receiving', 'Mangrove Marine Supply|Chandlers', 'Southern Cross Shipping|Pier 4', 'Coral Stevedoring|Gate 2', 'Banana Reef Imports|Produce',
    'Gulfline Cold Storage|Dock 7', 'Tri-County Rebar|Steel Yard', 'Sunbelt Container Lines|Terminal', 'Pelican Bonded Warehouse|No Admittance', 'Isla Cargo|Shed 3'],
  hospital: ['Emergency|Ambulance Entrance|cross', 'Hospital|Main Entrance|cross'],
  police: ['Police|Costa Verano Metro|shield', 'Metro Police|Precinct|shield'],
  parking: ['Park|Public Parking', 'Parking|Hourly - Daily', 'Garage|Enter'],
  billboard: ['Sunset Strip|Costa Verano after dark|sunset', 'Dos Palmas|Aged island rum|rum', 'Aerovia del Sol|Nassau - San Juan - Kingston daily|airline', 'Riff Radio 99.5|Rocks the beach|radio',
    'Solbrisa|Deep tropical tan oil|lotion', 'Daybreak Motors|The new turbo coupes are here|car', 'Tropibank|Your money likes it here|bank', 'Mirador Shades|See the heat|shades',
    'Flamingo Car Wash|Shine in five minutes|carwash', 'Club Electra|Paloma Drive - Open till five|cocktail'],
  'billboard-wide': ['Costa Verano|Welcome to the sun|sunset', 'Caribe Star Lines|Seven nights from Southport|ship', 'Channel 86 News|First at six and eleven|radio', 'Daybreak Motors|Zero to the beach in six seconds|car',
    'Dos Palmas|The rum of the islands|rum', 'Aerovia del Sol|Fly the sun route|airline'],
  poster: ['Neon Tide|Live at Club Electra|cocktail', 'Causeway Heat|Coming this summer|car', 'Kiwi Fizz|Stay cool|lotion', 'Seastar Key|Homes on the bay|sunset',
    'Riff Radio|99.5 FM|radio', 'Solbrisa|Tan deeper|lotion', 'Caribe Star|Cruise tonight|ship', 'Mirador|Shades|shades'],
  bench: ['Ocean Reef Realty|555-0142', 'Paradise Pawn|Cash today - 555-0177', 'Coral Cleaners|In by nine, out by five', 'Sunrise Cabs|555-0199', 'Poinciana Drugs|We deliver', 'Tropibank|Free checking'],
  // signs hung inside the glass at eye level; rows with a second line are a brewer's or distiller's mark (all invented)
  window: ['Open||', 'Cocktails||', '||glass', '||palm', '||flamingo', 'Abierto||', 'Beer||', 'Cafe||cup', 'Tarpon|Lager', 'Marea|Cerveza|sun', 'Gulf Gold|Beer|star',
    'Dos Palmas|Rum|palm', 'Vacancy||', 'Liquor||', 'Kiwi Fizz|Ice cold'],
  direction: ['Southpoint Beach|up', 'Midbeach|up', 'Coral Point|right', 'Downtown|left', 'Little Santiago|left', 'Little Jacmel|left', 'Southport|down', 'Seastar Key|right',
    'Palm Links|right', 'Shrimp Key|up', 'Airport|left|plane', 'Beach|right', 'Bridges|up', 'Fort Mangrove|left'],
  stop: ['Stop'],
  speed: ['25', '35', '45'],
  oneway: ['One Way|left', 'One Way|right'],
  notice: ['Phone||phone', 'Bus Stop|Metro Transit|bus-stop', 'Lifeguard|On duty 9 to 5|lifeguard', 'Beach Rules|No glass - No fires - No vehicles|beach-rules', 'No Parking|Tow-away zone|no-parking',
    'Mail|Costa Verano Mail - Collection - Mon-Sat  9 AM  1 PM  5 PM|mail'],
  newsbox: ['Verano Courier|Storm misses coast', 'Beach Bulletin|Hotel row gets new lights', 'El Faro Diario|Calor sin tregua', 'Bay Weekly|Free'],
  container: ['Sunbelt|SBCL 204117', 'Isla Cargo|ISLU 771302', 'Caribe Star|CSLU 310446', 'Tradewind|TWFU 482250', 'Southern Cross|SXSU 119073', 'Gulfline|GLCU 660581'],
};

// The game's road names (gameName in design/map/layout.json; a test keeps them in step) with their suffix split off,
// as printed on street-name blades. Numbered blades serve the '<district> Street n' grid.
const STREETS = ['Paloma|Dr', 'Poinciana|Ave', 'West|Ave', 'Mangrove|Ave', 'Bayfront|Dr', 'Central|Ave', 'Marina|Dr', 'Coral Point|Blvd', 'Southport|Blvd', 'Seastar|Cres', 'Airport|Loop',
  'Port|Loop', 'Northgate|Loop', 'Downtown North|Loop', 'South Bridge|Rd', 'North Bridge|Rd', 'Fairway Bridge|Rd', 'Island Bridge|Rd',
  '1|St', '2|St', '3|St', '4|St', '5|St', '6|St', '7|St', '8|St', '9|St', '10|St', '11|St', '12|St'];

// Landmark id -> [stand-in name printed on the sign, kind]. Mirrors design/map/layout.json (a test keeps them in step).
const LANDMARKS = {
  ocean_view_hotel: ['Solara Hotel', 'hotel'], lighthouse: ['Southpoint Light', 'lighthouse'], pole_position_club: ['Pit Lane Lounge', 'club'], washington_mall: ['Beachside Galleria', 'mall'],
  ocean_view_hospital: ['Seabreeze Medical', 'hospital'], ammu_nation_ocean_beach: ['Gator Arms', 'gunshop'], pay_n_spray_ocean_beach: ['Spray and Go', 'garage'], marina: ['Bayside Marina', 'marina'],
  police_washington_beach: ['Metro Police Beach Precinct', 'police'], rosenberg_office: ['Beachfront Legal', 'office'], bunch_of_tools: ['Nuts and Bolts Hardware', 'shop'],
  star_view_heights: ['Starlight Heights', 'tower'], malibu_club: ['Club Marlin', 'club'], north_point_mall: ['Northgate Mall', 'mall'], shady_palms_hospital: ['Palm Shade Hospital', 'hospital'],
  el_swanko_casa: ['Casa Elegante', 'house'], police_vice_point: ['Metro Police North Beach', 'police'], links_view_apartment: ['Fairway View Apartments', 'apartments'],
  pay_n_spray_vice_point: ['Spray and Go', 'garage'], leaf_links_clubhouse: ['Palm Links Golf Club', 'clubhouse'], interglobal_films: ['Panorama Pictures', 'studio'],
  prawn_mansions: ['Shrimp Key Mansions', 'ruin'], vercetti_estate: ['Seastar Manor', 'mansion'], hyman_memorial_stadium: ['Bayfront Memorial Stadium', 'stadium'], hyman_condo: ['Bayfront Condos', 'tower'],
  vcn_building: ['Channel 86 News Tower', 'tower'], ammu_nation_downtown: ['Gator Arms Downtown', 'gunshop'], schuman_health_care: ['Downtown General', 'hospital'],
  police_downtown: ['Metro Police Headquarters', 'police'], fire_station: ['Fire Station 1', 'firestation'], greasy_chopper: ['The Rusty Sprocket', 'bar'], moist_palms_hotel: ['Dewy Palms Hotel', 'hotel'],
  v_rock: ['Riff Radio Studio', 'studio'], downtown_tower_a: ['Meridian Tower', 'tower'], downtown_tower_b: ['Bayline Center', 'tower'], kaufman_cabs: ['Sunrise Cabs', 'depot'],
  print_works: ['Palmetto Press', 'factory'], junkyard: ['Metro Scrap', 'junkyard'], phils_place: ['The Trailer Lot', 'compound'], auntie_poulets: ['The Stilt Shack', 'house'],
  pay_n_spray_little_haiti: ['Spray and Go', 'garage'], cafe_robina: ['Cafe Colibri', 'cafe'], cherry_popper: ['Double Scoop Ice Cream', 'factory'], sunshine_autos: ['Daybreak Motors', 'showroom'],
  west_haven_hospital: ['Westside Community Clinic', 'hospital'], police_little_havana: ['Metro Police West Precinct', 'police'], laundromat: ['Suds Laundry', 'shop'],
  viceport_docks: ['Southport Docks', 'docks'], boatyard: ['Tidewater Boatyard', 'boatyard'], port_authority: ['Southport Authority', 'office'], pay_n_spray_viceport: ['Spray and Go', 'garage'],
  eight_ball_bomb_shop: ['Short Fuse Garage', 'garage'], airport_terminal_south: ['Flamingo International Terminal A', 'terminal'],
  airport_terminal_north: ['Flamingo International Terminal B', 'terminal'], airport_hangars: ['Flamingo hangars', 'hangar'], fort_baxter: ['Fort Mangrove', 'military'],
};
// How each kind of landmark letters its name, and whether it also has a vertical blade (variant 1).
const LANDMARK_STYLE = {
  hotel: ['fascia-neon', true], club: ['script-neon', true], bar: ['script-neon', true], cafe: ['script-neon', false], tower: ['rooftop', true], office: ['rooftop', false],
  stadium: ['rooftop', false], terminal: ['rooftop', false], mall: ['fascia-display', false], showroom: ['fascia-display', false], studio: ['marquee', false],
  hospital: ['civic', false], police: ['civic', false], firestation: ['civic', false], shop: ['acrylic', false], gunshop: ['acrylic-dark', false], garage: ['workshop', false],
  depot: ['workshop', false], marina: ['roadside', false], clubhouse: ['plaque', false], house: ['plaque', false], mansion: ['plaque', false], ruin: ['plaque', false],
  lighthouse: ['plaque', false], apartments: ['fascia-channel', false], compound: ['stencil', false], factory: ['stencil', false], junkyard: ['stencil', false], docks: ['stencil', false],
  boatyard: ['stencil', false], hangar: ['stencil', false], military: ['stencil', false],
};
const UNLIT_STYLES = { stencil: 'decal', workshop: 'paint', plaque: 'paint' };

// ---------------------------------------------------------------- colour
// Palettes are sRGB hex. `glow` is what the sign throws on its surroundings at night.
const NEON = { pink: '#ff2d8a', azure: '#2f8ff0', aqua: '#27e6e0', red: '#ff2a12', orange: '#ff6a14', violet: '#7a2cf0', yellow: '#ffd23c', green: '#3fe07c', white: '#f3f6ff' };
const NEON_PAIRS = [['pink', 'azure'], ['azure', 'pink'], ['red', 'azure'], ['aqua', 'pink'], ['orange', 'aqua'], ['pink', 'aqua'], ['azure', 'yellow'], ['violet', 'pink'], ['red', 'yellow'],
  ['aqua', 'orange'], ['yellow', 'red'], ['green', 'pink'], ['white', 'red'], ['pink', 'violet']];
const PANELS = ['#12263f', '#1b1b2e', '#0f2f33', '#2a1430', '#f1e4cf', '#f7c9c2', '#bfe6dc', '#f5e39a', '#c9dcf2', '#f4f1e8'];
const ACRYLIC = [['#f6f2e6', '#c8262c', '#1a1a1a'], ['#ffd84a', '#b3151c', '#1a1a1a'], ['#c8262c', '#fff6e0', '#ffd84a'], ['#1f5fb4', '#ffffff', '#ffd84a'], ['#f6f2e6', '#12407a', '#c8262c'],
  ['#0f7f6e', '#fff6e0', '#ffd84a'], ['#f29f1d', '#3a1606', '#fff6e0'], ['#f6f2e6', '#0f6b46', '#c8262c']];
const BRUSH = [['#c8262c', '#f5c518', '#101010'], ['#12407a', '#f5c518', '#c8262c'], ['#0f6b46', '#f29f1d', '#101010'], ['#101010', '#c8262c', '#f5c518'], ['#b3151c', '#12407a', '#f5c518'],
  ['#e0661a', '#12407a', '#101010'], ['#6a1b7a', '#f5c518', '#0f6b46']];

const hexToLinear = (hex) => [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
const normalised = (rgb) => { const m = Math.max(rgb[0], rgb[1], rgb[2], 1e-4); return rgb.map((v) => +(v / m).toFixed(3)); };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pick = (list, id, salt) => list[hashString(id + ':' + salt) % list.length];

function colours(style, id) {
  const [a, b] = pick(NEON_PAIRS, id, 'neon');
  switch (style) {
    case 'fascia-neon': case 'blade': case 'script-neon': case 'marquee': case 'fascia-display': case 'fascia-channel': case 'roadside': case 'window-neon': case 'cinema': {
      const panel = style === 'window-neon' ? '#0b0d12' : style === 'fascia-channel' || style === 'roadside' ? pick(PANELS.slice(4), id, 'panel') : pick(PANELS.slice(0, 4), id, 'panel');
      return { bg: panel, fg: NEON[a], accent: NEON[b], glow: NEON[a] };
    }
    case 'acrylic': { const [bg, fg, accent] = pick(ACRYLIC, id, 'acrylic'); return { bg, fg, accent, glow: bg }; }
    case 'acrylic-dark': { const [fg, bg, accent] = pick(ACRYLIC.slice(2, 6), id, 'acrylic'); return { bg: '#16181d', fg, accent, glow: fg === '#ffffff' ? bg : fg }; }
    case 'gas': { const [bg, fg, accent] = pick([['#f6f2e6', '#e0661a', '#12407a'], ['#f6f2e6', '#0f7f6e', '#c8262c'], ['#ffd84a', '#12407a', '#c8262c']], id, 'gas'); return { bg, fg, accent, glow: bg }; }
    case 'rooftop': { const fg = pick(['#f3f6ff', '#f3f6ff', '#ffd9a0', '#9fd8ff', '#ff5a3c'], id, 'roof'); return { bg: '#14161b', fg, accent: '#8a8f99', glow: fg }; }
    case 'civic': return { bg: '#f4f6f8', fg: '#12407a', accent: '#c8262c', glow: '#dfeaff' };
    case 'brush': { const [fg, accent, shadow] = pick(BRUSH, id, 'brush'); return { bg: fg, fg, accent, shadow, glow: '#ffffff' }; }
    case 'stencil': { const fg = pick(['#14161b', '#12305a', '#7a1f16', '#1f3d2c'], id, 'stencil'); return { bg: fg, fg, accent: fg, glow: '#ffffff' }; }
    case 'container': { const fg = pick(['#f1efe8', '#f1efe8', '#ffd84a', '#14161b'], id, 'box'); return { bg: fg, fg, accent: fg, glow: '#ffffff' }; }
    case 'workshop': case 'bench': case 'newsbox': {
      const [bg, fg, accent] = pick([['#f4f1e8', '#14161b', '#c8262c'], ['#f5c518', '#14161b', '#b3151c'], ['#f4f1e8', '#12305a', '#c8262c'], ['#f6ecd2', '#0f4f3a', '#c8262c']], id, 'sheet');
      return { bg, fg, accent, glow: '#ffffff' };
    }
    default: return { bg: '#f4f1e8', fg: '#14161b', accent: '#c8262c', glow: '#fff4dc' };
  }
}

// ---------------------------------------------------------------- catalogue
function makeEntry(category, kindName, row, index, style) {
  const kind = KINDS[kindName], [text, sub = '', art = ''] = row.split('|');
  const id = `${category}/${slug(text || art) || index}`;
  const chosen = style || pick(kind.styles, id, 'style'), mode = UNLIT_STYLES[chosen] || kind.mode;
  const palette = colours(chosen, id);
  return {
    id, category, text, sub, art, style: chosen, colors: palette, w: kind.w, h: kind.h, aspect: kind.w / kind.h,
    lit: mode === 'lit', decal: mode === 'decal', vertical: kind.h > kind.w * 2, emissiveCode: mode === 'lit' ? kind.code : mode === 'decal' ? 1 : 0,
    glow: mode === 'lit' ? normalised(hexToLinear(palette.glow)) : [1, 1, 1], rect: null, uv: null,
  };
}

function buildCatalogue() {
  const entries = [], seen = new Set();
  const add = (e) => {
    // two rows may share their wording (ONE WAY left and right): the second line then tells them apart
    if (seen.has(e.id)) e.id += '-' + slug(e.sub);
    if (seen.has(e.id)) throw new Error('duplicate sign id ' + e.id);
    seen.add(e.id); entries.push(e); return e;
  };
  for (const [category, rows] of Object.entries(WORDS)) rows.forEach((row, i) => add(makeEntry(category, category, row, i)));
  STREETS.forEach((row, i) => add(makeEntry('street-name', 'street-name', row, i)));
  // number plates: SOLID has no use for them, the vehicle family maps one per car
  for (let i = 0; i < 16; i++) {
    const h = hashString('plate' + i), L = 'ABCDEFGHJKLMNPRSTUVWXYZ', l = (k) => L[(h >>> (k * 5)) % L.length];
    add(makeEntry('plate', 'plate', `${l(0)}${l(1)}${l(2)} ${(h >>> 17) % 10}${(h >>> 21) % 10}${l(3)}|${i % 4 === 3 ? 'Seastar County' : 'Costa Verano'}`, i));
  }
  // landmarks: one fascia per distinct name, plus a blade where the building type carries one
  const landmarkIndex = {};
  for (const [lid, [name, kind]] of Object.entries(LANDMARKS)) {
    const [style, blade] = LANDMARK_STYLE[kind] || ['acrylic', false], key = 'landmark/' + slug(name);
    const face = entries.find((e) => e.id === key) || add(makeEntry('landmark', 'landmark', name, 0, style));
    let tall = null;
    if (blade) {
      // a blade has room for about nine letters: the whole distinctive part of the name if it fits, else its longest word
      const words = name.split(' ').filter((w) => !/^(The|Hotel|Tower|Center|Lounge|Club|Heights|Condos|News|86)$/.test(w));
      const word = words.join(' ').length <= 9 ? words.join(' ') : words.reduce((best, w) => (w.length > best.length ? w : best), '');
      const bid = 'landmark-blade/' + slug(word);
      tall = entries.find((e) => e.id === bid) || add(makeEntry('landmark-blade', 'landmark-blade', word, 0, 'blade'));
    }
    landmarkIndex[lid] = [face, tall];
  }
  pack(entries);
  return { entries, landmarkIndex };
}

/**
 * Skyline packing in a fixed order (tallest first, then widest, then id), so the layout depends only on the set of
 * entries and never on table order. Each rectangle goes to the lowest free position, leftmost on ties.
 */
function pack(entries) {
  const order = entries.slice().sort((a, b) => b.h - a.h || b.w - a.w || (a.id < b.id ? -1 : 1));
  let sky = [[0, 0, ATLAS_SIZE]];                                     // [x, y, width] runs of the top edge, left to right
  for (const e of order) {
    const w = e.w + PAD, h = e.h + PAD;
    let best = -1, bestY = Infinity;
    for (let i = 0; i < sky.length; i++) {
      if (sky[i][0] + w > ATLAS_SIZE) break;
      let y = 0, left = w;
      for (let j = i; left > 0 && j < sky.length; j++) { y = Math.max(y, sky[j][1]); left -= sky[j][2]; }
      if (left <= 0 && y < bestY) { best = i; bestY = y; }
    }
    if (best < 0 || bestY + h > ATLAS_SIZE) throw new Error('sign atlas is full at ' + e.id);
    const x = sky[best][0];
    e.rect = [x + PAD / 2, bestY + PAD / 2, e.w, e.h];
    e.uv = [e.rect[0] / ATLAS_SIZE, e.rect[1] / ATLAS_SIZE, (e.rect[0] + e.w) / ATLAS_SIZE, (e.rect[1] + e.h) / ATLAS_SIZE];
    // replace the runs under the new rectangle by one run at its bottom edge
    const next = sky.slice(0, best); next.push([x, bestY + h, w]);
    for (let j = best, end = x + w; j < sky.length; j++) {
      const [sx, sy, sw] = sky[j];
      if (sx + sw <= end) continue;
      next.push(sx < end ? [end, sy, sx + sw - end] : sky[j]);
    }
    sky = next;
  }
}

const { entries: ENTRIES, landmarkIndex: LANDMARK_SIGNS } = buildCatalogue();
const BY_ID = new Map(ENTRIES.map((e) => [e.id, Object.freeze(e)]));
const BY_CATEGORY = new Map();
for (const e of ENTRIES) { if (!BY_CATEGORY.has(e.category)) BY_CATEGORY.set(e.category, []); BY_CATEGORY.get(e.category).push(e); }

/** Every entry, in catalogue order: { id, category, text, sub, art, style, colors, rect: [x, y, w, h], uv, aspect, lit, decal, vertical, emissiveCode, glow }. */
export const SIGNS = Object.freeze(ENTRIES);
/** Category names accepted by pickSign (besides 'landmark:<layout id>'). */
export const SIGN_CATEGORIES = Object.freeze([...BY_CATEGORY.keys()].filter((c) => !c.startsWith('landmark')));
/** Landmark ids that have a sign. */
export const SIGN_LANDMARKS = Object.freeze(Object.keys(LANDMARKS));

/** The entry with this id, or null. */
export function signById(id) { return BY_ID.get(id) || null; }

/**
 * A sign of a category. `seed` selects the variant: integers walk the category in order (so 0, 1, 2 ... are all
 * different until the category runs out), fractions in 0..1 pick proportionally.
 * 'landmark:<layout id>' returns that landmark's own sign: variant 0 is the horizontal face, variant 1 the vertical
 * blade where the building type has one (otherwise the face again); unknown landmark ids return null.
 * Category names may use '_' for '-'. An unknown category falls back to 'shop'.
 * Returns { id, uv: [u0, v0, u1, v1], aspect, glow: [r, g, b], text, vertical, lit, decal, emissiveCode, ... }.
 */
export function pickSign(category, seed = 0) {
  const name = String(category);
  if (name.startsWith('landmark:')) {
    const pair = LANDMARK_SIGNS[name.slice(9)];
    return pair ? (Math.floor(seed) === 1 && pair[1]) || pair[0] : null;
  }
  const list = BY_CATEGORY.get(name.replace(/_/g, '-')) || BY_CATEGORY.get('shop'), n = list.length;
  const i = Number.isInteger(seed) ? ((seed % n) + n) % n : Math.min(n - 1, Math.floor((seed - Math.floor(seed)) * n));
  return list[i];
}
