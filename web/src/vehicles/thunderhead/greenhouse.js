// The greenhouse: the windscreen on its own sheet, the door glass and the hatch glass on the hull, each sunk in
// its opening with a printed border, a lining behind the frame and a seal round it; and the lining under the roof.
// The openings themselves are cut with the panels (body.js).

import { VEHICLE } from '../../core/ids.js';
import { patch } from '../hero/kit/solids.js';
import * as S from './spec.js';
import { REVEAL, GLASS_ROW, sideGlassEdges, hatchEdge } from './body.js';
import { pane, sunk, stations, hemRuns, frameRun, rubber, frit, TINT, LINING, LINING_DEPTH } from './glazing.js';

const MM = S.MM, P = S.PANE, B = S.B_OF;
/** Windscreen surround: width of the rubber moulding over the glass edge, and of the printed border under it. Metres. */
const MOULDING = 0.016, SCREEN_FRIT = 0.045;
/** How far the screen glass runs on under the cowl, as a share of its height. */
const UNDER_COWL = 0.035;
/** Chart row where the roof lining ends: on the lower half of the roof edge's roll, where the door glass's own lining takes over. */
const ROOF_LINING_ROW = B.E + 0.2;
/** The pane stops this share of the sheet short of the pillar line and the header, inside the frame's rebate. */
const EDGE_CLEAR = 0.003;

/**
 * What surrounds the windscreen along the pillar and the header: the moulding over the glass edge, the printed
 * border under the glass, and the returns that close the frame towards the cabin.
 */
function screenSurround(mb, hull, screen) {
  const sheet = screen.sheet;
  const ja = [0, 0, 0], jb = [0, 0, 0], run = [];
  for (let i = 0; i <= 10; i++) run.push([1, -UNDER_COWL + (1 + UNDER_COWL) * i / 10, 1, i === 10 ? 1 : 0]);   // up the pillar: [s, t, moves in s, moves in t]
  for (let i = 1; i <= 12; i++) run.push([1 - i / 12, 1, 0, 1]);
  /** The run moved `reach` metres into the glass and sunk `depth` under it. */
  const line = (reach, depth) => run.map(([s, t, ia, ib]) => {
    sheet.jac(s, t, ja, jb);
    return sunk(sheet, s - ia * reach / Math.hypot(...ja), t - ib * reach / Math.hypot(...jb), depth);
  });
  const out = sheet.normal(0.9, 0.9, [0, 0, 0]), inward = out.map((v) => -v), edge = sheet.pos(1, 0.5, [0, 0, 0]), mid = sheet.pos(0.5, 0.5, [0, 0, 0]);
  const toMiddle = [0, 1, 2].map((k) => mid[k] - edge[k]), under = (P.screen.depth + P.screen.thickness + 0.8) * MM;
  rubber(mb); patch(mb, [line(-0.001, -0.0015), line(MOULDING * 0.5, -0.0025), line(MOULDING, P.screen.depth * MM - 0.0012)], { facing: out, crease: 60 });
  frit(mb); patch(mb, [line(-0.004, under), line(SCREEN_FRIT, under)], { facing: out, crease: 60 });
  mb.material(VEHICLE.INTERIOR, 2, 0); mb.color(LINING); mb.occlusion(0.7);
  patch(mb, [line(SCREEN_FRIT, under), line(SCREEN_FRIT, LINING_DEPTH + 0.004)], { facing: toMiddle, crease: 60 });
  // ... and back out to the lining that lies under the frame itself, on the hull
  const underFrame = run.map(([s, t, ia]) => sunk(hull, ...(ia ? screen.pillar(t) : screen.header(s)), LINING_DEPTH));
  patch(mb, [line(SCREEN_FRIT, LINING_DEPTH + 0.004), underFrame], { facing: inward, crease: 60 });
}

/**
 * body: where the frames, linings and seals go; panes: the glass (in the reduced model the body itself, blacked
 * out); screen: screen.js; glazed: the prepared loops of the panels that border a pane (buildCoachwork).
 */
export function buildGreenhouse(body, panes, hull, screen, glazed, quality) {
  const ov = P.overlap, over = (x, row, mm) => hull.bOf(x, hull.arcOf(x, row) + mm);

  // --- windscreen
  const across = stations(0, 1 - EDGE_CLEAR, quality.cabin ? 0.05 : 0.2);
  pane(panes, screen.sheet, across, () => -UNDER_COWL, () => 1 - EDGE_CLEAR, { depth: P.screen.depth * MM, thickness: P.screen.thickness * MM, tint: TINT.screen, opacity: 50, cols: quality.cabin ? 12 : 4 });

  // --- door glass: under the roof panel's side, between the pillar and the hoop, down into the door
  const side = sideGlassEdges(hull), top = (x) => over(x, S.ROOF.sideRow, -ov), base = (x) => over(x, GLASS_ROW, ov);
  const upper = (x) => Math.min(base(x), Math.max(top(x), side.lead(x, ov)));
  const lower = (x) => Math.max(upper(x), Math.min(base(x), side.rear(x, ov)));
  pane(panes, hull, stations(side.leadX[0] - 2 * ov, S.HOOP_X + ov, quality.cabin ? 70 : 220, [side.leadX[1], S.DOOR.rearTopX]), upper, lower,
    { depth: P.side.depth * MM, thickness: P.side.thickness * MM, tint: TINT.side, opacity: 70, cols: quality.cabin ? 6 : 2 });

  // --- hatch glass: the dome between the hoop and the deck
  const hatch = hatchEdge(hull), cornerZ = hatch.rear[hatch.rear.length - 1][1];
  const hatchEdgeB = (x) => {
    const sideB = over(x, hatch.sideB(Math.max(S.HATCH_X, Math.min(hatch.cornerX, x))), ov), back = S.HATCH_END_X + ov - x;
    // behind the rear corners the bowed trailing edge takes over
    return back >= S.HATCH.bow ? sideB : Math.min(sideB, hull.solve(x, 0, cornerZ * Math.sqrt(Math.max(0, back) / S.HATCH.bow), 0, B.G));
  };
  pane(panes, hull, stations(S.HATCH_X - ov, S.HATCH_END_X + ov, quality.cabin ? 60 : 200, [hatch.cornerX]), () => 0, hatchEdgeB,
    { depth: P.hatch.depth * MM, thickness: P.hatch.thickness * MM, tint: TINT.side, opacity: 70, cols: quality.cabin ? 12 : 4 });
  if (!quality.cabin) return;

  // --- frames
  screenSurround(body, hull, screen);
  // Linings and borders are walked off over the hull, which between the pillar foot and the header is real only
  // behind the header line and below the pillar line: ahead of those it runs on in thin air, in front of the screen.
  const real = (a, b) => {
    if (a >= S.HEADER_CORNER_X) return true;
    if (b >= B.E) return hull.sec(a, b)[1] <= S.pillarY(a) - 3;
    const share = hull.sec(a, b)[0] / screen.cornerZ;
    return a >= S.HEADER_X + (S.HEADER_CORNER_X - S.HEADER_X) * share * share + 3;
  };
  const domain = { a: [S.PILLAR_FOOT_X, S.DECK_END_X], b: [0, B.G + 0.4], within: real }, seal = { width: P.seal.width * MM, proud: P.seal.proud * MM };
  const deepest = (Math.max(P.side.depth + P.side.thickness, P.hatch.depth + P.hatch.thickness)) * MM;
  for (const loop of glazed) for (const run of hemRuns(loop, REVEAL)) frameRun(body, hull, domain, run, deepest, seal);

  // --- belt seal: the rubber the door glass rises through, along the door's top edge
  rubber(body);
  const beltXs = stations(side.leadX[0] - 6, S.DOOR.rearTopX + 6, 60);
  patch(body, beltXs.map((x) => [sunk(hull, x, over(x, GLASS_ROW, -9), P.side.depth * MM - 0.0015), sunk(hull, x, over(x, GLASS_ROW, -7), -0.003), sunk(hull, x, over(x, GLASS_ROW, 1), -0.003), sunk(hull, x, over(x, GLASS_ROW, 5), 0)]),
    { facing: hull.normal(beltXs[beltXs.length >> 1], GLASS_ROW, [0, 0, 0]), crease: 50 });

  // --- lining under the roof panel, the header bar and the hoop
  body.material(VEHICLE.INTERIOR, 2, 0); body.color(LINING); body.occlusion(0.7);
  const shares = stations(0, 1, 0.125), rows = stations(0, 1, 0.1);
  const roof = rows.map((v) => shares.map((t) => {
    // from just behind the header line, whose chart row at this share of the width is not the lining's own
    const [hx, hb] = screen.header(t), x = hx + 4 + (S.HATCH_X + 20 - hx - 4) * v, edge = ROOF_LINING_ROW / B.E;
    return sunk(hull, x, hb * edge + (ROOF_LINING_ROW * t - hb * edge) * v, LINING_DEPTH);
  }));
  patch(body, roof, { facing: [0, -1, 0], crease: 60 });
}
