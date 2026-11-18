// Minimap geometry: land outlines, beaches, parks and road centre lines as flat number arrays, and a drawing
// routine for a 2D canvas context. Kept deliberately small: the page redraws it every frame.

/** Build the transferable minimap data from the layout and the network. */
export function buildMinimap(layout, net) {
  const flat = (polygon) => Float32Array.from(polygon.flat());
  return {
    land: layout.landmasses.map((l) => flat(l.polygon)),
    beaches: layout.beaches.map((b) => flat(b.polygon)),
    parks: layout.parks.filter((p) => p.kind === 'park' || p.kind === 'golf').map((p) => flat(p.polygon)),
    paved: layout.parks.filter((p) => p.kind !== 'park' && p.kind !== 'golf').map((p) => flat(p.polygon)),
    // Roads sorted narrow to wide so that main roads are drawn last, on top.
    roads: net.edges.map((e) => ({ pts: Float32Array.from(e.pts), width: e.hw * 2, bridge: !!net.roads[e.road].bridge, main: e.hw >= 8 })).sort((a, b) => a.width - b.width),
    landmarks: layout.landmarks.map((m) => ({ x: m.pos[0], z: m.pos[1], kind: m.kind })),
  };
}

const COLOURS = { sea: '#1d4a66', land: '#56606a', beach: '#c9b98a', park: '#4f7a4a', paved: '#6b7078', road: '#aeb4bb', main: '#e6e2d3', bridge: '#d9c9a0' };

/**
 * Draw the map centred on (centreX, centreZ), rotated so that `heading` (a yaw) points up, covering
 * `metresAcross` over `sizePx` pixels. The caller clips (round or square) and draws the player marker.
 */
export function drawMinimap(ctx, map, centreX, centreZ, heading, metresAcross, sizePx) {
  const scale = sizePx / metresAcross, reach = metresAcross * 0.75;
  ctx.save();
  ctx.fillStyle = COLOURS.sea; ctx.fillRect(0, 0, sizePx, sizePx);
  // World (x, z) to canvas: forward (sin yaw, cos yaw) maps to up.
  ctx.translate(sizePx / 2, sizePx / 2); ctx.rotate(heading - Math.PI); ctx.scale(scale, scale); ctx.translate(-centreX, -centreZ);
  const near = (p) => { for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - centreX) < reach && Math.abs(p[i + 1] - centreZ) < reach) return true; return false; };
  const trace = (p, close) => { ctx.beginPath(); ctx.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]); if (close) ctx.closePath(); };
  // Land outlines are large: draw them always (a polygon can cover the view without having a vertex in it).
  for (const [list, colour] of [[map.beaches, COLOURS.beach], [map.land, COLOURS.land], [map.parks, COLOURS.park], [map.paved, COLOURS.paved]]) {
    ctx.fillStyle = colour; for (const p of list) { trace(p, true); ctx.fill(); }
  }
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const r of map.roads) {
    if (!near(r.pts)) continue;
    ctx.strokeStyle = r.bridge ? COLOURS.bridge : r.main ? COLOURS.main : COLOURS.road; ctx.lineWidth = Math.max(r.width, 2.2 / scale);
    trace(r.pts, false); ctx.stroke();
  }
  ctx.restore();
}
