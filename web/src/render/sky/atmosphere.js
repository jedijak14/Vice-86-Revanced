// Atmosphere model shared by the CPU (environment derivation, lookup tables) and the GPU (sky-view pass, clouds, ocean).
//
// One description of the air over the city feeds everything that needs a light colour: the sun and moon irradiance
// reaching the ground, the sky radiance behind the skyline, the fog tint, the ambient probe. The numbers below are a
// standard spherical-shell model: Rayleigh air, Mie aerosol and an ozone layer, which is what turns the zenith deep
// blue after sunset. The thick humid haze near the ground is NOT here: it is the fog layer of environment.js.
//
// Lengths inside this file are KILOMETRES (the planet radius does not survive float32 in metres). Everything the rest
// of the game sees is converted to metres at the boundary.
//
// Two tables are built once on the CPU and uploaded as textures:
//   transmittance (256 x 64, rgb): fraction of light surviving from a point at radius r along a ray with zenith cosine mu
//                                  to the top of the atmosphere.  u, v follow the usual horizon-aware mapping below.
//   multiScatter  (32 x 32, rgb):  isotropic higher-order in-scatter per unit of light irradiance, by sun zenith cosine
//                                  (u) and altitude (v).
// The GPU then integrates single scattering per frame into a small sky-view texture (see glsl/atmosphere.js) and the
// same integral exists here in JavaScript (`skyRadiance`) so that pure-JS consumers agree with the picture.

export const ATMOSPHERE = Object.freeze({
  groundRadius: 6360,
  topRadius: 6460,
  rayleigh: Object.freeze([5.802e-3, 13.558e-3, 33.1e-3]),   // scattering per km at sea level, rgb
  rayleighScaleHeight: 8,
  mieScattering: 2.0e-2,                                      // trade-wind air aloft: a pale horizon, a compact glow round the sun
  mieAbsorption: 1.18e-2,                                     // dark for sea air, on purpose: a dim low sun without a sky-wide glare
  mieScaleHeight: 1.2,
  mieG: 0.84,
  // Absorption per km at the layer centre. The red value is for the orange-red of display primaries (about 610 nm,
  // close to the peak of the Chappuis band), not the 680 nm often tabulated: twilight zeniths come out blue, not purple.
  ozone: Object.freeze([2.0e-3, 2.4e-3, 0.09e-3]),
  ozoneCentre: 25,
  ozoneHalfWidth: 15,
  groundAlbedo: 0.14,                                         // sea and dark city seen from above
  observerAltitude: 0.06,                                     // km; the camera never leaves the first few hundred metres
  /** Irradiance of the sun above the atmosphere in scene units (ARCHITECTURE 4.6: about 100 at the ground at noon). */
  sunIrradiance: Object.freeze([120, 121, 122]),
  /**
   * Calibration of the scattered light, applied identically on the CPU (`gradeSky`) and in the sky-view lookup.
   * The aerosol above is thinner than humid coastal air (its glare round a low sun would swamp the picture), which
   * leaves the sky too dark against the sun: the gain puts the sun to sky ratio on level ground near 7:1 at noon,
   * the clear-day end of what is measured outdoors, so that shadows stay firm. The chroma is a small lift only:
   * a photograph of this sky is blue, not ultramarine.
   */
  skyGain: 1.6,
  skyChroma: 1.15,
  sunAngularRadius: 0.275 * Math.PI / 180,                    // the real disc; bloom makes the aureole
  moonAngularRadius: 0.39 * Math.PI / 180,                    // one and a half times the real disc, as the eye remembers a low moon
});

export const TRANSMITTANCE_SIZE = Object.freeze([256, 64]);
export const MULTISCATTER_SIZE = Object.freeze([32, 32]);

const A = ATMOSPHERE;
const RG = A.groundRadius, RT = A.topRadius, RG2 = RG * RG, RT2 = RT * RT;
const H_ATM = Math.sqrt(RT2 - RG2);
const BR = A.rayleigh, BO = A.ozone, BMS = A.mieScattering, BME = A.mieScattering + A.mieAbsorption;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Distance in km from radius r along zenith cosine mu to the top of the atmosphere. */
export function distanceToTop(r, mu) {
  const disc = r * r * (mu * mu - 1) + RT2;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
}
/** Cosine of the zenith angle of the geometric horizon seen from radius r (negative above the ground). */
export function horizonCos(r) { return -Math.sqrt(Math.max(0, 1 - RG2 / (r * r))); }

/**
 * Soft earth shadow for a light with zenith cosine mu seen from radius r: 1 when the body clears the horizon, 0 when the
 * planet is in the way. The half-degree ramp stands in for the size of the disc and for refraction, and removes banding.
 */
export function planetShadow(r, mu) {
  const t = clamp01((mu - horizonCos(r) + 0.006) / 0.012);
  return t * t * (3 - 2 * t);
}

// Scratch for densities: [rayleigh, mie, ozone] relative to their reference values.
function rayleighDensity(h) { return Math.exp(-h / A.rayleighScaleHeight); }
function mieDensity(h) { return Math.exp(-h / A.mieScaleHeight); }
function ozoneDensity(h) { return Math.max(0, 1 - Math.abs(h - A.ozoneCentre) / A.ozoneHalfWidth); }

/** Map (r, mu) to transmittance table coordinates in 0..1. Valid for rays that do not hit the ground. */
export function transmittanceUv(r, mu, out) {
  const rho = Math.sqrt(Math.max(0, r * r - RG2));
  const d = distanceToTop(r, mu), dMin = RT - r, dMax = rho + H_ATM;
  out[0] = clamp01((d - dMin) / (dMax - dMin));
  out[1] = clamp01(rho / H_ATM);
  return out;
}

/** Build the transmittance table. Returns { data: Float32Array (rgba), width, height }. */
export function buildTransmittanceLut() {
  const [W, Ht] = TRANSMITTANCE_SIZE, data = new Float32Array(W * Ht * 4), STEPS = 40;
  for (let j = 0; j < Ht; j++) {
    const rho = H_ATM * (j + 0.5) / Ht, r = Math.sqrt(rho * rho + RG2), dMin = RT - r, dMax = rho + H_ATM;
    for (let i = 0; i < W; i++) {
      const d = dMin + (dMax - dMin) * (i + 0.5) / W;
      const mu = d < 1e-6 ? 1 : Math.max(-1, Math.min(1, (H_ATM * H_ATM - rho * rho - d * d) / (2 * r * d)));
      let oR = 0, oM = 0, oO = 0; const dt = d / STEPS;
      for (let s = 0; s < STEPS; s++) {
        const t = (s + 0.5) * dt, h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - RG;
        oR += rayleighDensity(h); oM += mieDensity(h); oO += ozoneDensity(h);
      }
      oR *= dt; oM *= dt; oO *= dt;
      const o = (j * W + i) * 4;
      data[o] = Math.exp(-(BR[0] * oR + BME * oM + BO[0] * oO));
      data[o + 1] = Math.exp(-(BR[1] * oR + BME * oM + BO[1] * oO));
      data[o + 2] = Math.exp(-(BR[2] * oR + BME * oM + BO[2] * oO));
      data[o + 3] = 1;
    }
  }
  return { data, width: W, height: Ht };
}

/** Bilinear lookup in an rgba float table with clamped edges (the same filter the GPU applies). */
export function sampleLut(lut, u, v, out) {
  const W = lut.width, Ht = lut.height, d = lut.data;
  const x = Math.min(Math.max(u * W - 0.5, 0), W - 1), y = Math.min(Math.max(v * Ht - 0.5, 0), Ht - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, W - 1), y1 = Math.min(y0 + 1, Ht - 1), fx = x - x0, fy = y - y0;
  const a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, e = (y1 * W + x1) * 4;
  for (let k = 0; k < 3; k++) out[k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
  return out;
}

const uvScratch = [0, 0];
/** Transmittance from radius r along mu to space, including the earth's shadow. */
export function transmittanceToLight(lut, r, mu, out) {
  transmittanceUv(r, mu, uvScratch); sampleLut(lut, uvScratch[0], uvScratch[1], out);
  const s = planetShadow(r, mu); out[0] *= s; out[1] *= s; out[2] *= s; return out;
}

/** Map (altitude, light zenith cosine) to multi-scatter table coordinates. */
export function multiScatterUv(h, mu, out) { out[0] = clamp01(mu * 0.5 + 0.5); out[1] = clamp01(Math.sqrt(Math.max(h, 0) / (RT - RG))); return out; }

/**
 * Build the multiple-scattering table: light that has bounced at least twice is treated as isotropic and summed as a
 * geometric series, which is what fills the twilight sky with blue once direct paths are in the earth's shadow.
 */
export function buildMultiScatterLut(transmittance) {
  const [W, Ht] = MULTISCATTER_SIZE, data = new Float32Array(W * Ht * 4);
  const DIRS = 6, STEPS = 16, T = [0, 0, 0], sunT = [0, 0, 0], L2 = [0, 0, 0], F = [0, 0, 0];
  for (let j = 0; j < Ht; j++) {
    const fv = (j + 0.5) / Ht, h = fv * fv * (RT - RG), r = RG + Math.max(h, 0.001);
    for (let i = 0; i < W; i++) {
      const muS = (i + 0.5) / W * 2 - 1, sx = Math.sqrt(Math.max(0, 1 - muS * muS)), sy = muS;   // light in the x-y plane, y up
      L2[0] = L2[1] = L2[2] = 0; F[0] = F[1] = F[2] = 0;
      for (let a = 0; a < DIRS; a++) for (let b = 0; b < DIRS; b++) {
        // stratified sphere directions
        const cosT = 1 - 2 * (a + 0.5) / DIRS, sinT = Math.sqrt(1 - cosT * cosT), phi = 2 * Math.PI * (b + 0.5) / DIRS;
        const dx = sinT * Math.cos(phi), dy = cosT, dz = sinT * Math.sin(phi);
        // ray from (0, r, 0); ends at the ground or the top
        const disc = r * r * (dy * dy - 1) + RG2, hitsGround = dy < 0 && disc >= 0;
        const tMax = hitsGround ? Math.max(0, -r * dy - Math.sqrt(disc)) : distanceToTop(r, dy), dt = tMax / STEPS;
        T[0] = T[1] = T[2] = 1;
        for (let s = 0; s < STEPS; s++) {
          const t = (s + 0.5) * dt, px = dx * t, py = r + dy * t, pz = dz * t, pr = Math.sqrt(px * px + py * py + pz * pz), ph = pr - RG;
          const dR = rayleighDensity(ph), dM = mieDensity(ph), dO = ozoneDensity(ph);
          transmittanceToLight(transmittance, pr, (px * sx + py * sy) / pr, sunT);
          for (let k = 0; k < 3; k++) {
            const sca = BR[k] * dR + BMS * dM, ext = BR[k] * dR + BME * dM + BO[k] * dO, seg = Math.exp(-ext * dt);
            const w = T[k] * (1 - seg) / Math.max(ext, 1e-9);
            L2[k] += w * sca * sunT[k] / (4 * Math.PI);   // second order with an isotropic phase function
            F[k] += w * sca;                              // fraction scattered again
            T[k] *= seg;
          }
        }
        if (hitsGround) {
          // light reflected by the ground towards this point
          const gx = dx * tMax, gy = r + dy * tMax, gz = dz * tMax, gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
          const muG = (gx * sx + gy * sy) / gr; transmittanceToLight(transmittance, gr, muG, sunT);
          for (let k = 0; k < 3; k++) L2[k] += T[k] * sunT[k] * Math.max(muG, 0) * A.groundAlbedo / Math.PI;
        }
      }
      const o = (j * W + i) * 4, n = 1 / (DIRS * DIRS);
      for (let k = 0; k < 3; k++) data[o + k] = (L2[k] * n) / (1 - Math.min(F[k] * n, 0.98));
      data[o + 3] = 1;
    }
  }
  return { data, width: W, height: Ht };
}

let cachedLuts = null;
/** Both tables, built on first use and shared by every consumer. */
export function atmosphereLuts() {
  if (!cachedLuts) { const transmittance = buildTransmittanceLut(); cachedLuts = { transmittance, multiScatter: buildMultiScatterLut(transmittance) }; }
  return cachedLuts;
}

/** Saturate a scattered-light colour about its luminance in place (ATMOSPHERE.skyChroma). The GLSL twin is in glsl/common.js. */
export function gradeSky(c) {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (let k = 0; k < 3; k++) c[k] = Math.max(l + (c[k] - l) * A.skyChroma, 0);
  return c;
}

export const rayleighPhase = (c) => 3 / (16 * Math.PI) * (1 + c * c);
/** Cornette-Shanks phase function for the aerosol. */
export function miePhase(c, g = A.mieG) {
  const g2 = g * g;
  return 3 / (8 * Math.PI) * (1 - g2) * (1 + c * c) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * c, 1e-4), 1.5));
}

/**
 * The haze of a low sun (environment.lowSunTone): coarse droplets in humid sea air, a wide Henyey-Greenstein lobe
 * (g = 0.35) scaled up threefold so that it carries the reddened light round the sky without a glare of its own.
 * Written as the three numbers the shader needs: scale / (offset - slope * cos)^1.5. GLSL twin: skyHazePhase.
 */
export const HAZE_LOBE = Object.freeze((() => { const g = 0.35; return { scale: 3 * (1 - g * g) / (4 * Math.PI), offset: 1 + g * g, slope: 2 * g }; })());
export const hazePhase = (c) => HAZE_LOBE.scale / Math.pow(HAZE_LOBE.offset - HAZE_LOBE.slope * c, 1.5);

const tScratch = [0, 0, 0], msScratch = [0, 0, 0], trScratch = [1, 1, 1];
/**
 * Sky radiance per unit light irradiance for a view direction and one light, both given as unit vectors in the local
 * frame (y up), seen by the standard observer. Writes six numbers to `out`:
 *   out[0..2] = everything smooth: Rayleigh single scattering (with its phase) and multiple scattering;
 *   out[3..5] = aerosol single scattering WITHOUT its phase function (multiply by miePhase(cos angle to the light)).
 * This is the CPU twin of the sky-view fragment shader; keep the two in step.
 */
export function skyRadiance(luts, vx, vy, vz, lx, ly, lz, out, steps = 40) {
  const r0 = RG + A.observerAltitude, cosVL = vx * lx + vy * ly + vz * lz, pR = rayleighPhase(cosVL);
  const tMax = distanceToTop(r0, Math.max(vy, 0));
  for (let k = 0; k < 6; k++) out[k] = 0;
  trScratch[0] = trScratch[1] = trScratch[2] = 1;
  let tPrev = 0;
  for (let s = 0; s < steps; s++) {
    // quadratic spacing: most of the detail is in the dense air near the observer
    const f1 = (s + 1) / steps, tNext = tMax * f1 * f1, dt = tNext - tPrev, t = tPrev + dt * 0.5; tPrev = tNext;
    const px = vx * t, py = r0 + Math.max(vy, 0) * t, pz = vz * t, pr = Math.sqrt(px * px + py * py + pz * pz), ph = pr - RG;
    const muL = (px * lx + py * ly + pz * lz) / pr;
    const dR = rayleighDensity(ph), dM = mieDensity(ph), dO = ozoneDensity(ph);
    transmittanceToLight(luts.transmittance, pr, muL, tScratch);
    multiScatterUv(ph, muL, uvScratch); sampleLut(luts.multiScatter, uvScratch[0], uvScratch[1], msScratch);
    for (let k = 0; k < 3; k++) {
      const scaR = BR[k] * dR, scaM = BMS * dM, ext = scaR + BME * dM + BO[k] * dO, seg = Math.exp(-ext * dt);
      const w = trScratch[k] * (1 - seg) / Math.max(ext, 1e-9);
      out[k] += w * (scaR * pR * tScratch[k] + (scaR + scaM) * msScratch[k]);
      out[k + 3] += w * scaM * tScratch[k];
      trScratch[k] *= seg;
    }
  }
  return out;
}
