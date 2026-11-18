// Paloma PD uniform, built in metres in the traffic model worker. The driver
// is baked into the cruiser LODs; a separate shared mesh stands on the kerb.
// All surfaces go through the same Skin/MeshBuilder packing as the cars.
import { MeshBuilder } from '../../core/mesh.js';
import { Skin } from './skin.js';
import { box, disc, rod, X, Y, Z } from './kit.js';
import { interior, trim, rim } from './materials.js';

const shirt = interior(2, [0.32, 0.46, 0.56]), navy = interior(2, [0.09, 0.14, 0.22]);
const leather = trim(0.4, [0.08, 0.085, 0.10]), brass = rim([0.92, 0.72, 0.33], 0.34, 0.7);
const skins = [interior(0, [0.69, 0.43, 0.32]), interior(0, [0.47, 0.29, 0.21])];

// Elliptical lathed profiles rather than square heads and cubic torsos. Each
// row defines height, half width, half depth, and an optional forward shift.
function profile(sk, mat, origin, rows, sides) {
  let previous;
  for (let j = 0; j < rows.length; j++) {
    const [h, w, d, offset = 0] = rows[j], ring = [];
    const lo = rows[Math.max(0, j - 1)], hi = rows[Math.min(j + 1, rows.length - 1)];
    for (let k = 0; k < sides; k++) {
      const a = k * 2 * Math.PI / sides, c = Math.cos(a), s = Math.sin(a);
      const nx = c * d, nz = s * w;
      const ny = -((hi[1] - lo[1]) * c * nx + (hi[2] - lo[2]) * s * nz) / Math.max(0.001, hi[0] - lo[0]);
      const length = Math.hypot(nx, ny, nz) || 1;
      ring.push(sk.raw(origin[0] + c * w, origin[1] + h, origin[2] + offset + s * d, nx / length, ny / length, nz / length));
    }
    if (previous) for (let k = 0; k < sides; k++) {
      const n = (k + 1) % sides;
      sk.quad(previous[k], previous[n], ring[n], ring[k], mat);
    }
    previous = ring;
  }
}

export function drawOfficer(sk, eye, seated, detail = 0, variant = 0) {
  const at = (x, y, z) => [eye[0] + x, eye[1] + y, eye[2] + z];
  const skin = skins[variant % skins.length], sides = detail === 0 ? 12 : 7;
  profile(sk, shirt, eye, [[-0.70,.14,.11],[-.44,.195,.125],[-.28,.215,.11],[-.19,.09,.08]], sides);
  profile(sk, skin, eye, [[-.23,.056,.06],[-.15,.057,.058],[-.12,.075,.085,.013],[-.055,.089,.10],
    [.033,.094,.101],[.092,.084,.088],[.115,.025,.035]], sides);
  profile(sk, navy, eye, [[.058,.096,.109],[.084,.107,.12],[.122,.119,.122],[.146,.085,.09],[.149,.001,.001]], sides);
  // Patent-leather peak, cap band, gold cap pin and a shield on the shirt.
  profile(sk, leather, at(0,0,.058), [[.058,.10,.102],[.067,.102,.105]], sides);
  box(sk, leather, at(0,.061,.106), [.076,.006,.043]);
  disc(sk, brass, at(0,.095,.119), Z, X, Y, .013, 6);
  disc(sk, brass, at(.083,-.307,.105), Z, X, Y, .023, 7);
  box(sk, navy, at(0,-.32,.115), [.018,.091,.009]);
  for (const side of [-1, 1]) {
    const shoulder = at(side * .18,-.285,0), elbow = at(side * .235,-.49,.025);
    const hand = seated ? at(side * .145,-.35,.27) : at(side * .14,-.60,.12);
    rod(sk, shirt, shoulder, elbow, .058, sides - 2);
    rod(sk, skin, elbow, hand, .042, sides - 2);
    box(sk, skin, hand, [.04,.044,.035]);
    if (detail === 0) {
      box(sk, navy, at(side * .152,-.257,.004), [.052,.011,.041]);
      box(sk, leather, at(side * .045,.002,.098), [.037,.019,.008]);
    }
  }
  if (seated) return; // the wheel, dashboard and bench hide the lower body
  profile(sk, leather, eye, [[-.722,.152,.113],[-.667,.155,.117]], sides);
  box(sk, brass, at(0,-.695,.117), [.027,.018,.008]);
  box(sk, leather, at(-.164,-.71,.015), [.035,.06,.041]);
  rod(sk, leather, at(-.17,-.655,.02), at(-.17,-.57,.02), .007, 5);
  for (const side of [-1,1]) {
    const hip = at(side * .085,-.707,0), knee = at(side * .101,-1.14,side * .034);
    const ankle = at(side * .12,-1.55,side * .061);
    rod(sk, navy, hip, knee, .094, 9);
    rod(sk, navy, knee, ankle, .072, 9);
    box(sk, leather, [ankle[0], eye[1] - 1.576, ankle[2] + .039], [.075,.054,.13]);
  }
}

export function buildFootOfficer() {
  const mb = new MeshBuilder(1600);
  drawOfficer(new Skin(mb), [0, 1.63, 0], false, 0, 1);
  return mb.finish();
}
