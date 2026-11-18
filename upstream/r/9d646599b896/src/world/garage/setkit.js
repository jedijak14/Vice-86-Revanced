// The modelling kit of the garage: the props kit plus the interior surfaces and the flat gridded sheets a room is
// made of. Everything in the set is seen from a few metres, so curves are tessellated for that distance.

import { CHANNEL, FAMILY, SOLID } from '../../core/ids.js';
import { Kit, radianceCode, vcross, vnorm } from '../props/kit.js';

// Interior surfaces of the SOLID family (owner: materials). uv conventions are theirs:
//   EPOXY        uv = floor metres; p0 roughness of the fresh coat, p1 wear
//   BLOCK        uv = (metres along the wall, metres above the floor); p0 paint roughness, p1 wear
//   GLASS_BLOCK  uv = metres; colour = the light behind; p0 radiance code, p1 channel
//   PEGBOARD     uv = metres; p0 roughness, p1 wear
const EPOXY = 20, BLOCK = 21, GLASS_BLOCK = 22, PEGBOARD = 23;
/** RUBBER p1 patterns. */
export const RUBBER_PATTERN = Object.freeze({ plain: 0, fineRib: 1, broadRib: 2, coin: 3 });
/** METAL_BARE kinds beyond the props' four: 4 brushed stainless, 5 turned stainless (uv = angle, metres across). */
export const STEEL = Object.freeze({ brushed: 4, turned: 5 });

export class SetKit extends Kit {
  constructor(detail = 2, seed = 7) { super(0, detail, seed, 1.0); }
  child() { return new SetKit(this.detail, this.seedByte); }

  // Low draws small bevels as sharp edges: from the turntable they are under a pixel
  bar(a, b, w, h, opts = {}) { return super.bar(a, b, w, h, this.detail === 0 && opts.r < 0.008 ? { ...opts, r: 0 } : opts); }

  // the light behind a glass block is not a paint: it keeps its full colour
  glassBlock(color, radiance) { this.b.family(FAMILY.SOLID).material(GLASS_BLOCK, radianceCode(radiance), CHANNEL.ALWAYS, this.seedByte).color(color[0], color[1], color[2]).occlusion(1); return this; }

  epoxy(color, rough = 0.12, wear = 0.45) { return this._m(EPOXY, color, rough * 255, wear * 255); }
  block(color, rough = 0.36, wear = 0.4) { return this._m(BLOCK, color, rough * 255, wear * 255); }
  pegboard(color, rough = 0.7, wear = 0.4) { return this._m(PEGBOARD, color, rough * 255, wear * 255); }
  mat(color, pattern, rough = 0.85) { return this._m(SOLID.RUBBER, color, rough * 255, pattern); }

  /**
   * A flat rectangular surface cut into a grid, so that bands of colour can follow the cell edges and baked
   * occlusion can grade across it. Points are origin + u * U + v * V and it faces U x V.
   *   us, vs      ascending cell edges
   *   cell(u, v)  called with the cell centre; sets the material and colour, or returns false to leave a hole
   *   occ(u, v)   baked occlusion at a vertex, 0..1
   *   uv(u, v)    surface coordinates (default: u, v)
   */
  sheet(origin, U, V, us, vs, cell, occ = null, uv = null) {
    const b = this.b, N = vnorm(vcross(U, V));
    const put = (u, v) => {
      if (occ) b.occlusion(occ(u, v));
      const t = uv ? uv(u, v) : [u, v];
      return b.vertex(origin[0] + U[0] * u + V[0] * v, origin[1] + U[1] * u + V[1] * v, origin[2] + U[2] * u + V[2] * v, N[0], N[1], N[2], t[0], t[1]);
    };
    for (let j = 0; j < vs.length - 1; j++) for (let i = 0; i < us.length - 1; i++) {
      if (cell((us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2) === false) continue;
      b.quad(put(us[i], vs[j]), put(us[i + 1], vs[j]), put(us[i + 1], vs[j + 1]), put(us[i], vs[j + 1]));
    }
    return this;
  }
}

/** Ascending, de-duplicated list of edges: a regular pitch from a to b plus the given extra edges inside it. */
export function edges(a, b, pitch, extra = []) {
  const n = Math.max(1, Math.round((b - a) / pitch)), out = [];
  for (let i = 0; i <= n; i++) out.push(a + (b - a) * i / n);
  for (const e of extra) if (e > a + 1e-6 && e < b - 1e-6) out.push(e);
  out.sort((p, q) => p - q);
  return out.filter((e, i) => i === 0 || e - out[i - 1] > 1e-4);
}
