// FOLIAGE surface family: palm fronds, broadleaf clusters, grass and flowers.
//
// Geometry supplies cards (strips that follow the hang of the leaflets, cluster cards, blade cards) and this
// shader cuts the individual leaflets, leaves, blades and petals out of them procedurally:
//   uv           = (0..1 across the card, 0..1 from the stem to the tip)
//   material id  = FOLIAGE.FROND | LEAF | GRASS | FLOWER
//   FROND  p0 = kind (0 coconut, 1 royal, 2 fan blade, 3 date, 4 strands of a flower or fruit spray)
//          p1 = leaflets (or fan segments) across the card; 255 = opaque tissue (rachis, stalk, spear, fruit)
//          p2 = wind phase of the whole frond in the high nibble, pattern seed in the low nibble
//   LEAF   p0 = leaf shape (0 round sea grape, 1 elliptic fig, 2 lanceolate croton, 3 small hedge leaf,
//               4 sea grape scrub seen from close by: leathery discs of every size, tilted every way and overlapping)
//          p1 = leaves across the card; 0 = opaque leafy mass (canopy cores and far levels; uv in metres), p2 = seed
//   GRASS  p0 = kind + 8 * (cut-off distance / 5 m, 0 = never fades): kind 0 blades of a bunch grass, 1 stalks that
//               end in a seed head, 2 broad weed leaves, 3 blades of mown turf; p1 = blades across, p2 = seed
//   FLOWER p0 = 0 large five-petalled flowers, 1 dense heads of small flowers; p1 = cells across, p2 = seed
//   vertex colour = albedo of the upper leaf surface; vertex alpha = sway weight (0 where the part is anchored)
//
// Coverage is box-filtered over the pixel footprint, and blends to the mean coverage of the card (raised a
// little) once a leaflet is narrower than a pixel, so crowns keep their mass with distance instead of
// dissolving, and nothing depends on sub-pixel luck from frame to frame.

import { FOLIAGE } from '../../core/ids.js';

/**
 * Whole-plant sway, shared with SOLID.TRUNK (which prepends this string to its own deform) so crowns stay
 * on their trunks. Returns a mesh-local offset; zero for static tile geometry (objA.w == 0).
 * objB.x is the instance yaw when the renderer supplies it, so every palm leans the same way downwind.
 */
export const PLANT_SWAY = /* glsl */`
vec2 folLocalWind(float yaw) {
  float c = cos(yaw), s = sin(yaw);
  return vec2(c * uWind.x - s * uWind.y, s * uWind.x + c * uWind.y);
}
float folGust(vec3 origin, float time) {
  // gust fronts travel downwind across the city, so neighbouring plants answer one after another
  return 0.55 + 0.45 * sin(time * 0.7 - dot(origin.xz, uWind.xy) * 0.02) + uWind.z * (0.5 + 0.5 * sin(time * 0.23 + origin.x * 0.013));
}
vec3 folPlantSway(vec3 p, vec4 objA, vec4 objB, vec3 origin, float time) {
  if (objA.w <= 0.0) return vec3(0.0);
  vec2 wind = folLocalWind(objB.x);
  float speed = min(length(wind), 16.0);
  if (speed < 1e-3) return vec3(0.0);
  vec2 dir = wind / speed;
  float h = max(p.y, 0.0) * 0.1, flex = h * h * objA.w;            // a cantilever: deflection grows with height squared
  float ph = objA.x * 6.2831853 * 3.0;
  float lean = 0.012 * speed + 0.016 * speed * folGust(origin, time) * sin(time * 0.9 + ph);
  float cross = 0.007 * speed * sin(time * 0.63 + ph * 1.7);
  return vec3(dir.x * lean - dir.y * cross, -0.5 * flex * lean * lean * 0.1, dir.y * lean + dir.x * cross) * flex;
}
`;

const BODY = /* glsl */`
// ---- shared leaf optics: waxy upper side, paler matte underside, light coming through the blade
vec3 folInstanceTint(vec3 c, vec4 objA) {
  if (objA.w <= 0.0) return c;
  c *= mix(vec3(0.88, 0.97, 0.9), vec3(1.16, 1.06, 0.82), objA.y);    // deep green to sun-yellowed
  return c * (0.9 + 0.2 * fract(objA.x * 7.31));
}
// 1 while the sun is the light, 0 under the moon and the street lamps. Sunlight is shadowed leaf by leaf, but
// lamps cast no shadows inside a crown: with daytime translucency and openness every leaf would answer every
// lamp from both sides and the whole crown would glow. At night a leaf is all but opaque and the crown is
// treated as the dense, self-shading mass it is, so a lamp picks out a dim rim of the nearest fronds.
float folDay() { return saturate(luma(uSunColor.rgb) / 6.0) * uSunDir.w; }
void folLeafOptics(in SurfIn s, inout SurfOut o, vec3 top, float dry, float gloss, float pale) {
  vec3 c = s.front ? top : mix(top, top * vec3(1.55, 1.35, 1.55), pale * (1.0 - dry));
  float day = folDay();
  // measured leaves are dark: nothing living reflects more than about a fifth of the light in any channel
  c = min(c * 0.85, mix(vec3(0.22), vec3(0.45), dry));
  // seen against the sun a living leaf turns yellow-green with the light it lets through; a dead one does not
  float back = saturate(dot(-o.N, uSunDir.xyz)) * day;
  o.albedo = mix(c, c * vec3(1.25, 1.45, 0.6) + vec3(0.01, 0.02, 0.0), back * 0.65 * (1.0 - dry));
  o.rough = s.front ? mix(gloss, 0.86, dry) : 0.78;
  o.sss = mix(0.85, 0.22, dry) * mix(0.12, 1.0, day);
}
float folDryness(vec3 c) { return saturate((c.r - c.g) * 8.0); }

// ---- palm fronds
// x = fill of the pitch at the widest point, y = taper power, z = sideways curl in pitches, w = fold depth
vec4 folFrondKind(float kind) {
  if (kind < 0.5) return vec4(0.97, 1.7, 1.5, 0.55);     // coconut: broad lax straps
  if (kind < 1.5) return vec4(0.76, 1.5, 1.1, 0.45);     // royal: finer, plumed
  if (kind < 3.5) return vec4(0.62, 1.25, 0.25, 0.75);   // date: narrow, stiff, sharply folded
  return vec4(0.36, 3.0, 1.6, 0.0);                      // strands of a flower or fruit spray
}
// Width of a strap leaflet along its length t (0 root .. 1 tip): narrow where it joins, long acute tip.
float folBlade(float t, float power) {
  return t >= 1.0 ? 0.0 : (0.6 + 0.4 * smoothstep(0.0, 0.1, t)) * pow(1.0 - pow(saturate(t), power), 0.75);
}
void folSolidTissue(in SurfIn s, inout SurfOut o) {
  float streak = noiseTex(vec2(s.uv.x * 37.0, s.uv.y * 3.0) * 16.0).r;
  o.albedo = s.color * (0.86 + 0.28 * streak);
  o.rough = 0.56; o.sss = 0.12; o.ao = 0.8; o.alpha = 1.0;
}
void folFeather(in SurfIn s, inout SurfOut o, float kind, float count, float seed) {
  vec4 K = folFrondKind(kind);
  float v = s.uv.y, x = s.uv.x * count, w = max(fwidth(x), 1e-4);
  float i0 = floor(x), cov = 0.0, across = 0.0, along = v; vec3 rnd = vec3(0.5);
  for (int k = -1; k <= 1; k++) {
    float i = i0 + float(k);
    if (i < 0.0 || i > count - 0.5) continue;
    vec3 h = hash32(vec2(i, seed * 17.0 + count));
    float len = h.z < 0.06 ? 0.45 : 0.8 + 0.2 * h.x;                 // a few leaflets are broken short
    float t = v / len, hw = 0.5 * K.x * folBlade(t, K.y);
    float c = i + 0.5 + (h.y - 0.5) * K.z * v * v;                   // lax leaflets wander across their neighbours
    float a = aaline(x - c, hw, w);
    if (a > cov) { cov = a; across = (x - c) / max(hw, 1e-3); along = t; rnd = h; }
  }
  float far = smoothstep(0.45, 1.4, w), detail = 1.0 - far;
  o.alpha = mix(cov, min(1.0, K.x * folBlade(v / 0.92, K.y) * 1.35), far);

  float dry = folDryness(s.color);
  vec3 top = folInstanceTint(s.color, s.objA) * mix(1.0, 0.78 + 0.44 * rnd.x, detail);
  top = mix(top, top * vec3(1.5, 1.42, 0.85), (1.0 - smoothstep(0.0, 0.25, abs(across))) * 0.5 * detail);   // midrib
  top = mix(top, vec3(0.42, 0.3, 0.12), smoothstep(0.82, 1.0, along) * 0.55 * (1.0 - dry));                 // scorched tips
  if (K.w > 0.0) {
    SurfFrame f = uvFrame(s, vec2(x, v));
    vec3 T = f.T / max(length(f.T), 1e-5);
    o.N = normalize(o.N + T * sign(across) * K.w * detail * (s.front ? 1.0 : -1.0));
  }
  folLeafOptics(s, o, top, dry, 0.42, 1.0);
  // the depths of the crown and the roots of the leaflets see less sky
  o.ao = mix(0.62, 1.0, saturate(s.occ * 1.3)) * mix(0.8, 1.0, smoothstep(0.0, 0.5, v));
}
void folFan(in SurfIn s, inout SurfOut o, float count, float seed) {
  float r = s.uv.y, x = s.uv.x * count, w = max(fwidth(x), 1e-4);
  float i0 = floor(x), cov = 0.0, across = 0.0, along = 0.0; vec3 rnd = vec3(0.5);
  for (int k = -1; k <= 1; k++) {
    float i = i0 + float(k);
    if (i < 0.0 || i > count - 0.5) continue;
    vec3 h = hash32(vec2(i, seed * 17.0 + count));
    // segments are joined into one pleated sheet up to 'split', then free and tapering to a thread
    float split = 0.42 + 0.16 * h.x, len = 0.86 + 0.14 * h.y, t = saturate((r - split) / (len - split));
    float hw = r > len ? 0.0 : 0.5 * (1.0 - 0.94 * pow(t, 1.25)) + step(r, split) * 0.02;
    float a = aaline(x - (i + 0.5 + (h.z - 0.5) * 0.5 * t * t), hw, w);
    if (a > cov) { cov = a; across = (x - (i + 0.5)) * 2.0; along = t; rnd = h; }
  }
  float far = smoothstep(0.45, 1.4, w), detail = 1.0 - far;
  float mean = 1.0 - 0.9 * pow(saturate((r - 0.5) / 0.45), 1.25);
  o.alpha = mix(cov, min(1.0, mean * 1.5), far);

  float dry = folDryness(s.color);
  vec3 top = folInstanceTint(s.color, s.objA) * mix(1.0, 0.88 + 0.24 * rnd.x, detail);
  top = mix(top, top * vec3(1.45, 1.4, 0.9), (1.0 - smoothstep(0.0, 0.3, abs(across))) * 0.45 * detail);
  top = mix(top, vec3(0.46, 0.36, 0.2), smoothstep(0.6, 1.0, along) * 0.5 * (1.0 - dry));                   // frayed, dry segment tips
  SurfFrame f = uvFrame(s, vec2(x, r));
  vec3 T = f.T / max(length(f.T), 1e-5);
  o.N = normalize(o.N + T * sign(across) * 0.6 * detail * (s.front ? 1.0 : -1.0));                          // pleats
  folLeafOptics(s, o, top, dry, 0.5, 1.0);
  o.ao = mix(0.55, 1.0, smoothstep(0.05, 0.6, r)) * mix(0.7, 1.0, saturate(s.occ * 1.4));
}

// ---- broadleaf clusters
void folLeaves(in SurfIn s, inout SurfOut o, float shape, float cells, float seed, float facing) {
  vec3 tint = folInstanceTint(s.color, s.objA);
  float dry = folDryness(s.color);
  // An opaque leafy mass (the inside of a canopy or hedge, a whole crown far away) has its uv in metres and is
  // tiled with leaves at their real size over dark gaps, so it reads as depth between the leaf cards.
  bool scrub = shape > 3.5, round_ = shape < 0.5 || scrub, mass = cells < 0.5, filled = mass || (shape > 2.5 && !scrub);
  // The card normals are bent towards the outside of the canopy so it shades as one volume, whichever way a card faces.
  if (!s.front) o.N = -o.N;
  if (mass) cells = round_ ? 4.5 : shape < 1.5 ? 8.0 : shape < 2.5 ? 6.0 : 13.0;
  vec2 dims = round_ ? vec2(0.5, 0.56) : shape < 1.5 ? vec2(0.3, 0.64) : shape < 2.5 ? vec2(0.21, 0.74) : vec2(0.32, 0.5);
  if (mass) dims *= 1.3;                                                                // packed close: little is seen between them
  vec2 p = s.uv * cells, cell0 = floor(p);
  float w = max(max(fwidth(p.x), fwidth(p.y)), 1e-4), cov = 0.0, best = 0.0;
  vec2 q = vec2(0.0), lie = vec2(0.0, 1.0); vec3 rnd = vec3(0.5);
  // Scrub is looked at from a few metres, where one leaf per cell reads as a tiling. It gets two, of every size,
  // lying at every angle (so foreshortened to ellipses) and free to cover each other; the distances to all of
  // them are kept so that a leaf can be shaded by the ones lying over it.
  float flat_ = 1.0, edge[18], rank[18];
  for (int n = 0; n < 2; n++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    int slot = n * 9 + (j + 1) * 3 + i + 1;
    edge[slot] = 9.0; rank[slot] = 0.0;
    if (n > 0 && !scrub) continue;
    vec2 cell = cell0 + vec2(float(i), float(j));
    vec3 h = hash32(cell + seed * 31.0 + float(n) * vec2(19.7, 7.3));
    vec2 c = cell + 0.5 + (h.xy - 0.5) * (scrub ? 1.0 : 0.7), e = c / cells * 2.0 - 1.0;
    // leaves whose centre falls outside a ragged outline are absent, so no two clusters share a silhouette
    if (!filled && dot(e, e) > 0.55 + 0.4 * h.z) continue;
    // leaves point away from the twig at the bottom of the card, each turned a little differently
    vec2 dir = filled ? vec2(0.0, 1.0) : normalize(c / cells - vec2(0.5, -0.25));
    float turn = (fract(h.z * 7.0) - 0.5) * (filled ? 6.2832 : scrub ? 4.4 : 1.7), ct = cos(turn), st = sin(turn);
    dir = vec2(dir.x * ct - dir.y * st, dir.x * st + dir.y * ct);
    vec2 size = dims; float turned = 1.0;
    if (scrub) { turned = (mass ? 0.6 : 0.36) + (mass ? 0.4 : 0.64) * fract(h.x * 13.0 + h.y * 5.0); size *= mix(0.5, 1.0, fract(h.y * 9.0)) * vec2(1.0, turned); }
    vec2 d = p - c, l = vec2(dot(d, vec2(dir.y, -dir.x)), dot(d, dir)), u = l / size;
    float sd = (length(u) - 1.0) * size.x;
    // sea grape leaves are heart-based: a notch where the stalk joins, and a margin that is never a true circle
    if (scrub) sd = max(sd + 0.045 * size.x * sin(atan(u.x, u.y) * 5.0 + h.x * 40.0), ((-u.y - 0.6) * 0.5 - abs(u.x)) * size.x);
    float a = saturate(0.5 - sd / w), z = a * (0.5 + h.x);
    edge[slot] = sd; rank[slot] = h.x;
    if (z > best) { best = z; cov = a; q = u; rnd = h; lie = dir; flat_ = turned; }
  }
  float shaded = 0.0;
  if (scrub) for (int k = 0; k < 18; k++) if (rank[k] > rnd.x) shaded = max(shaded, 1.0 - smoothstep(-0.02, 0.2, edge[k]));
  float far = smoothstep(0.35, 1.2, w), detail = 1.0 - far;
  vec2 e = s.uv * 2.0 - 1.0;
  // Towards its outline and on its underside a mass thins into separate leaves, so that its silhouette is foliage
  // and not a polygon, and a crown seen from below is leaves against the sky rather than a dark belly.
  // Too far away to tell leaves apart, the outline still breaks up into the clumps they hang in.
  float rim = max(1.0 - smoothstep(0.15, 0.5, abs(dot(s.N, s.V))), (1.0 - smoothstep(-0.6, -0.15, s.N.y)) * detail);
  vec2 cp = s.uv * 1.3 + seed;
  float cw = max(max(fwidth(cp.x), fwidth(cp.y)), 0.05);
  float clump = mix(saturate(0.5 + (vnoise(cp) - 0.42) / cw), 1.0, smoothstep(0.5, 1.5, cw));
  o.alpha = mass ? mix(1.0, mix(clump, cov, detail), rim) : mix(cov, filled ? 1.0 : 1.0 - smoothstep(0.62, 0.9, dot(e, e)), far);
  // a spray seen along its own plane would smear its leaves into streaks; it is the other sprays one sees there
  if (scrub && !mass) o.alpha *= smoothstep(0.1, 0.35, facing);

  vec3 top = tint * mix(1.0, 0.72 + 0.56 * rnd.x, detail);
  float rib = (1.0 - smoothstep(0.0, 0.1, abs(q.x))) * detail;
  float veins = (1.0 - smoothstep(0.0, 0.16, abs(fract(q.y * 3.0 + abs(q.x) * 1.6) - 0.5))) * detail * smoothstep(0.02, 0.07, w > 0.0 ? 0.25 / w : 1.0) * 0.5;
  vec3 veinColor = top * vec3(1.5, 1.4, 0.95);
  if (scrub) {
    // from yellow-green new growth to blue-green old leaves, a few bronze young ones and a few gone red
    float age = fract(rnd.y * 9.0 + rnd.z * 3.0);
    top *= mix(vec3(1.0), mix(vec3(1.2, 1.06, 0.6), vec3(0.74, 0.94, 1.04), age) * (0.82 + 0.5 * rnd.z), detail);
    top = mix(top, vec3(0.17, 0.07, 0.03), max(step(0.975, age) * 0.7, step(0.985, rnd.y) * 0.9) * detail);
    // the veins fan out from the stalk, pale on the blade and red towards the base
    vec2 fromStalk = q - vec2(0.0, -0.62);
    float ray = abs(fract(atan(fromStalk.x, fromStalk.y) * 2.3 + 0.5) - 0.5) * length(fromStalk);
    veins = (1.0 - smoothstep(0.0, 0.05, ray)) * (1.0 - smoothstep(0.6, 1.0, length(q))) * detail * 0.75;
    rib = max(rib * 0.7, veins);
    veinColor = mix(top * vec3(1.7, 1.5, 0.9) + 0.02, vec3(0.42, 0.1, 0.05), (1.0 - smoothstep(-0.7, 0.2, q.y)) * 0.7);
    top *= 1.0 - 0.5 * shaded * detail;                                                  // under another leaf
  } else if (shape < 0.5) {
    veinColor = mix(top, vec3(0.5, 0.12, 0.06), 0.6);                                   // sea grape: red veins,
    top = mix(top, vec3(0.3, 0.1, 0.04), step(0.975, rnd.y) * detail * 0.85);              // and the odd leaf turned red before it falls
  } else if (shape > 1.5 && shape < 2.5) {
    // croton: every leaf its own mix of green, yellow and red
    vec3 hot = rnd.y < 0.5 ? vec3(0.62, 0.42, 0.03) : vec3(0.48, 0.05, 0.03);
    top = mix(top, hot, smoothstep(0.35, 0.75, rnd.z) * detail * 0.85);
    veinColor = vec3(0.7, 0.5, 0.05);
  }
  top = mix(top, veinColor, max(rib, veins) * 0.6);
  SurfFrame f = uvFrame(s, p);
  vec3 T = f.T / max(length(f.T), 1e-5), B = f.B / max(length(f.B), 1e-5);
  // each leaf faces its own way and is creased along its midrib, so the sun glints off parts of leaves, not whole discs
  o.N = normalize(o.N + (T * (rnd.x - 0.5 + 0.7 * q.x) + B * (rnd.y - 0.5 + 0.3 * q.y)) * 0.7 * detail);
  // a leaf that is seen foreshortened is tipped over along its own length, and takes the light accordingly
  if (scrub) o.N = normalize(o.N + (T * lie.x + B * lie.y) * sqrt(1.0 - flat_ * flat_) * (rnd.z < 0.5 ? -0.8 : 0.8) * detail);
  // sprays turn their leaves to the light whichever way the card faces, so the underside colour shows only faintly
  folLeafOptics(s, o, top, dry, scrub ? 0.46 + 0.2 * rnd.y : shape < 0.5 ? 0.6 : 0.52, 0.2);
  o.ao = mix(0.5, 1.0, saturate(s.occ * 1.2));
  if (mass) {
    // between the leaves one looks at deeper, shaded leaves
    float lit = mix(0.8, cov, detail), deep = (scrub ? 0.42 : 0.3) + 0.25 * noiseTex(s.uv * 40.0).r;
    o.albedo *= mix(deep, 1.0, lit); o.rough = mix(0.9, o.rough, lit); o.sss *= 0.4 * lit; o.ao = mix(0.7, 0.92, lit);
  }
}

// ---- grass, seed-head grasses and broad-leaved weeds
void folGrass(in SurfIn s, inout SurfOut o, float p0, float count, float seed, float facing) {
  float kind = mod(p0, 8.0), reach = floor(p0 / 8.0) * 5.0, v = s.uv.y;
  bool turf = kind > 2.5, blade = kind < 0.5 || turf;
  // Bunch grasses are gathered at the root and fan out to the full width of the card at the tips; mown turf
  // stands evenly. The fan is drawn here rather than built as a trapezoid, whose two triangles would put a
  // kink in every blade.
  float x = ((s.uv.x - 0.5) / (turf ? 1.0 : mix(0.45, 1.0, v)) + 0.5) * count, w = max(fwidth(x), 1e-4);
  float i0 = floor(x), cov = 0.0, along = v, across = 0.0, head = 0.0; vec3 rnd = vec3(0.5);
  // The card normal leans towards the vertical so a tuft takes the light of the ground under it, from either side;
  // turf takes exactly that light, or a low sun would pick out every card against the lawn it stands on.
  if (!s.front) o.N = -o.N;
  if (turf) o.N = normalize(o.N + vec3(0.0, 4.0, 0.0));
  for (int k = -2; k <= 2; k++) {
    float i = i0 + float(k);
    if (i < 0.0 || i > count - 0.5) continue;
    vec3 h = hash32(vec2(i, seed * 13.0 + count));
    float len = 0.45 + 0.55 * h.x, t = v / len, hw = 0.0, isHead = 0.0;
    if (t < 1.0) {
      if (blade) hw = 0.34 * (1.0 - t * t);
      else if (kind < 1.5) {                                                                     // a stalk and its seed head
        isHead = smoothstep(0.58, 0.66, t);
        hw = mix(0.06, 0.25 * pow(sin(3.14159 * saturate((t - 0.6) / 0.4)), 0.6) * (0.6 + 0.4 * step(0.5, fract(t * 18.0 + h.y))), isHead);
      } else {                                                                                   // a weed leaf: lanceolate, with a nibbled wavy margin
        hw = 0.44 * pow(sin(3.14159 * saturate(t * 0.9 + 0.05)), 1.1) * (0.86 + 0.14 * sin(t * 31.0 + h.y * 40.0) * sin(t * 13.0 + h.x * 9.0));
      }
    }
    float c = i + 0.5 + (h.y - 0.5) * 2.2 * v + (h.z - 0.5) * 1.6 * v * v;                       // every blade leans and curls its own way
    float a = aaline(x - c, hw, w);
    if (a > cov) { cov = a; along = t; across = (x - c) / max(hw, 1e-3); rnd = h; head = isHead; }
  }
  // Once the blades are finer than the pixels the card carries their mean coverage instead, as an alpha the
  // dithered test turns into just that share of pixels: the grass thins towards its tips and never becomes a slab.
  float far = smoothstep(0.45, 1.4, w), detail = 1.0 - far;
  float mean = kind > 0.5 && kind < 1.5 ? 0.46 : 0.25 + 0.58 * (1.0 - v * v);
  o.alpha = mix(cov, mean, far);
  // A card seen along its own plane is a streak, not grass: it bows out and the cards that face the eye carry
  // the tuft. Near the cut-off distance the whole tuft thins away into the ground under it, so no ring shows.
  o.alpha *= smoothstep(0.07, 0.3, facing);
  if (reach > 0.0) o.alpha *= 1.0 - smoothstep(0.55, 0.95, s.dist / reach);

  vec3 top = folInstanceTint(s.color, s.objA) * mix(1.0, 0.8 + 0.4 * rnd.x, detail);
  if (blade) top = mix(top, top * vec3(1.4, 1.25, 0.75), smoothstep(0.35, 1.0, along) * (turf ? 0.15 : 0.3));   // lighter, yellower towards the tips
  else if (kind > 1.5) {
    // midrib and side veins of a broad leaf, darker and duller between them
    float rib = 1.0 - smoothstep(0.0, 0.12, abs(across)), vein = 1.0 - smoothstep(0.0, 0.3, abs(fract(along * 9.0 - abs(across) * 1.6) - 0.5) * 2.0);
    top *= mix(0.82, 1.08, max(rib, vein * 0.5) * detail) * (0.9 + 0.2 * rnd.y);
  }
  top = mix(top, vec3(0.31, 0.27, 0.13), step(turf ? 0.96 : 0.9, rnd.z) * (turf ? 0.5 : 0.8) * detail);   // dead straw among the green
  top = mix(top, vec3(0.5, 0.36, 0.14) * (0.8 + 0.4 * rnd.x), head);                             // ripe seed heads
  float dry = max(folDryness(s.color), head);
  folLeafOptics(s, o, top, dry, 0.68, 0.2);                                                      // a blade is the same green on both sides
  // Thin blades wrap less light round than a broad leaf, and a lawn must not outshine the ground it grows from
  // with the sun behind the eye. Looking into a low sun is another matter: the upper blades are lit through
  // and glow, which the upward shading normal of a tuft cannot tell, so the view direction does.
  o.sss *= turf ? 0.4 : 0.6;
  float against = saturate(dot(-s.V, uSunDir.xyz));
  o.albedo *= 1.0 + vec3(1.3, 1.0, 0.1) * against * against * smoothstep(0.1, 0.7, v) * folDay() * (1.0 - dry);
  o.ao = mix(turf ? 0.72 : 0.4, 1.0, smoothstep(0.0, 0.55, v));                                  // dark where the blades crowd at the ground
}

// ---- flowers scattered over a card
void folFlowers(in SurfIn s, inout SurfOut o, float kind, float cells, float seed) {
  vec2 p = s.uv * cells, cell0 = floor(p - 0.5);
  float w = max(max(fwidth(p.x), fwidth(p.y)), 1e-4), cov = 0.0, rad = 1.0, core = 0.0, rnd = 0.5;
  if (!s.front) o.N = -o.N;                                                                      // shaded with the bush, like the leaves
  for (int j = 0; j <= 1; j++) for (int i = 0; i <= 1; i++) {
    vec2 cell = cell0 + vec2(float(i), float(j));
    vec3 h = hash32(cell + seed * 29.0);
    if (h.z > (kind < 0.5 ? 0.42 : 0.7)) continue;                                               // most cells carry no flower
    vec2 d = p - (cell + 0.5 + (h.xy - 0.5) * 0.5);
    float r = length(d), ang = atan(d.y, d.x) + h.x * 6.2832, size, edge;
    if (kind < 0.5) { size = 0.44; edge = size * (0.62 + 0.38 * pow(abs(cos(ang * 2.5)), 0.7)); } // five broad petals
    else { size = 0.4; edge = size * (0.8 + 0.2 * cos(ang * 9.0)); }                             // a domed head of florets
    float a = saturate(0.5 + (edge - r) / w);
    if (a > cov) { cov = a; rad = r / size; core = ang; rnd = h.y; }
  }
  float far = smoothstep(0.5, 1.6, w);
  o.alpha = mix(cov, 0.0, far * 0.35);                                                           // far away the bloom is a speckle of colour
  vec3 c = s.color * (0.8 + 0.4 * rnd);
  if (kind < 0.5) {
    c *= 0.72 + 0.28 * smoothstep(0.0, 0.7, rad) - 0.12 * pow(abs(sin(core * 2.5)), 8.0);        // dark throat, creases between petals
    c = mix(c, vec3(0.85, 0.7, 0.12), 1.0 - smoothstep(0.08, 0.16, rad));                        // stamen column
  } else c *= 0.8 + 0.3 * step(0.5, fract(rad * 3.0 + core * 1.43));                             // florets
  o.albedo = min(c * 0.72, vec3(0.6)); o.rough = 0.6;                                            // petals are matt and never pure pigment
  o.sss = 0.7 * folDay();
  o.ao = mix(0.75, 1.0, saturate(s.occ * 1.2));
}

void surface(in SurfIn s, inout SurfOut o) {
  float id = s.mat.x, p0 = s.mat.y, p1 = s.mat.z, seed = mod(s.mat.w, 16.0);
  // How squarely the card itself (not its bent shading normal) faces the eye, from the camera-relative position
  // so it stays exact far from the origin. Taken here, outside the branches on the material.
  vec3 rel = -s.V * s.dist, face = cross(dFdx(rel), dFdy(rel));
  float facing = abs(dot(face, s.V)) / max(length(face), 1e-12);
  o.ao = 1.0;                                    // the vertex alpha of this family is the sway weight, not occlusion
`;
const FINISH = /* glsl */`  o.ao *= mix(0.3, 1.0, folDay());
  applyWetness(o, o.N, 0.25, 1.0);
}
`;

/** Every material in dispatch order: its id and the GLSL statement that shades it. */
export const MATERIALS = Object.freeze([
  { id: FOLIAGE.FROND, call: `{
    if (p1 > 250.5) folSolidTissue(s, o);
    else if (p0 > 1.5 && p0 < 2.5) folFan(s, o, p1, seed);
    else folFeather(s, o, p0, p1, seed);
  }` },
  { id: FOLIAGE.LEAF, call: 'folLeaves(s, o, p0, p1, s.mat.w, facing);' },
  { id: FOLIAGE.GRASS, call: 'folGrass(s, o, p0, p1, s.mat.w, facing);' },
  { id: FOLIAGE.FLOWER, call: 'folFlowers(s, o, p0, p1, s.mat.w);' },
]);

/**
 * Which ids are compiled into one shader (see fragmentFor). The Direct3D compiler behind Chrome on Windows needs
 * time that grows with every material in the chain, and the browser kills a GPU process that is busy for too
 * long, so the renderer compiles one shader per group and draws the triangles of those ids with it.
 */
export const GROUPS = Object.freeze(MATERIALS.map((m) => Object.freeze([m.id])));

/** The else-if chain that runs the material of each listed id, in dispatch order. */
export function dispatchChain(ids) {
  const wanted = new Set(ids);
  for (const id of wanted) if (!MATERIALS.some((m) => m.id === id)) throw new Error(`foliage: no material with id ${id}`);
  return MATERIALS.filter((m) => wanted.has(m.id)).map((m, i) => `  ${i ? 'else ' : ''}if (abs(id - ${m.id}.0) < 0.5) ${m.call}\n`).join('');
}

/** The family's fragment source with only the listed ids dispatched (all of them by default). */
export function fragmentFor(ids = MATERIALS.map((m) => m.id)) {
  return BODY + dispatchChain(ids) + FINISH;
}


const deform = PLANT_SWAY + /* glsl */`
void deform(inout vec3 p, inout vec3 n, in DeformIn d) {
  float w = d.occ, id = d.mat.x;
  vec2 wind = folLocalWind(d.objB.x);
  float speed = min(length(wind), 16.0), k = speed / 12.0;
  vec2 dir = speed > 1e-3 ? wind / speed : vec2(1.0, 0.0);
  float gust = folGust(d.origin, d.time);
  float ph = d.objA.x * 40.0 + dot(d.origin.xz, vec2(0.11, 0.07));
  vec3 sway = folPlantSway(p, d.objA, d.objB, d.origin, d.time);
  if (id < 0.5) {
    // Frond: a springy lever. The whole leaf nods at its own phase and is pushed downwind; leaflet tips flutter.
    float fp = floor(d.mat.w / 16.0) * 0.3927 + ph, w2 = w * w;
    float nod = sin(d.time * (2.4 + 1.3 * fract(fp * 0.37)) + fp * 6.2832);
    p.y += w2 * (0.03 + 0.2 * k * gust) * nod - w2 * 0.12 * k * gust;
    p.xz += dir * w2 * k * (0.22 * gust + 0.08 * sin(d.time * 1.7 + fp * 3.1));
    if (d.mat.z < 250.5) {
      float near = 1.0 - smoothstep(25.0, 60.0, distance(d.origin + p * max(d.objA.w, 1.0), uCamPos.xyz));
      float tip = d.uv.y * d.uv.y * (0.35 + 0.65 * w);
      p += n * tip * near * (0.006 + 0.035 * k * gust) * sin(d.time * (13.0 + 6.0 * fract(d.mat.w * 0.619)) + d.mat.w * 2.4 + d.uv.x * 5.0 + fp);
    }
  } else if (id > 1.5 && id < 2.5) {
    // Grass: bends from the root, further in gusts, and shivers at the tips.
    float w2 = w * w, bend = k * (0.35 * gust + 0.12 * sin(d.time * 2.6 + ph + p.x * 1.3 + p.z * 1.7));
    float reach = p.y * 0.9;
    p.xz += dir * w2 * bend * reach;
    p.y -= w2 * bend * bend * reach * 0.5;
  } else {
    // Leaves and flowers on twigs: the outer canopy rocks with the gusts and trembles.
    p.xz += dir * w * k * (0.06 * gust + 0.03 * sin(d.time * 2.1 + ph + p.y * 0.9));
    p += n * w * (0.004 + 0.016 * k * gust) * sin(d.time * 9.0 + ph * 3.0 + dot(p, vec3(2.3, 1.7, 2.9)));
  }
  p += sway;
}
`;

export default { name: 'foliage', fragment: fragmentFor(), materials: MATERIALS, groups: GROUPS, fragmentFor, deform, alphaTest: true, twoSided: true };
