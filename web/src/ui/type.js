// Display type without font files.
//
// The interface is designed around a condensed bold face, and style.css names the one each
// platform ships with. Some machines have none of them (a plain Linux install has only wide
// faces), and there the same text would run a third wider: three speed digits no longer fit their
// cells and every heading outgrows its place. So the width of the face that actually resolved is
// measured once, and when it is not condensed the style sheet narrows it:
//
//   --squeeze   1 for a condensed face, otherwise the factor (down to MIN_SQUEEZE) that brings the
//               face's capitals to CONDENSED_ADVANCE. style.css sets display type at
//               font-size * squeeze and stretches it back to full height with scaleY(1 / squeeze),
//               so the line keeps its height and only the width changes.
//   --cell      width of one digit cell (speed, clock) in ems of the nominal size: MIN_CELL, or
//               wider when the face's figures need it.
//
// index.html carries a copy of fitDisplayType as an inline script so the loading screen is right
// on its first paint; test/ui/type.test.mjs keeps the two in step.

/** The probe strings: twelve capitals of ordinary width, and the ten figures. */
export const PROBE_CAPS = 'HAMBURGEVONS';
export const PROBE_DIGITS = '0123456789';
/** The probe's font size in CSS px (set on .ui__probe in style.css). */
export const PROBE_PX = 100;

/** Mean advance of the probe capitals, in ems, that wide faces are narrowed to. */
export const CONDENSED_ADVANCE = 0.58;
/** A face whose capitals are no wider than this is condensed already and is left alone. */
export const CONDENSED_ENOUGH = 0.62;
/** Narrowing a face further than this distorts it more than it helps. */
export const MIN_SQUEEZE = 0.72;

export const MIN_CELL = 0.5;
export const MAX_CELL = 0.6;
/** Air added to a figure's own advance to make its cell. */
export const CELL_MARGIN = 0.03;

const round = (value) => Math.round(value * 1000) / 1000;

/** Width factor for a face whose probe capitals advance `capsAdvance` ems on average. */
export function squeezeFor(capsAdvance) {
  if (!(capsAdvance > CONDENSED_ENOUGH)) return 1;   // also NaN and 0: nothing could be measured
  return round(Math.max(MIN_SQUEEZE, CONDENSED_ADVANCE / capsAdvance));
}

/** Digit cell width in nominal ems for figures advancing `digitAdvance` ems before narrowing. */
export function cellFor(digitAdvance, squeeze) {
  if (!(digitAdvance > 0)) return MIN_CELL;
  return round(Math.min(MAX_CELL, Math.max(MIN_CELL, digitAdvance * squeeze + CELL_MARGIN)));
}

/**
 * Measures the display face in `root` (the .ui element) and sets --squeeze and --cell on it.
 * Returns { squeeze, cell }. Two layout reads, once, before anything is on screen.
 */
export function fitDisplayType(root) {
  const doc = root.ownerDocument;
  const probe = doc.createElement('span');
  probe.className = 'ui__probe';
  root.appendChild(probe);
  const advance = (text) => {
    probe.textContent = text;
    const box = typeof probe.getBoundingClientRect === 'function' ? probe.getBoundingClientRect() : null;
    return box ? box.width / (PROBE_PX * text.length) : 0;
  };
  const squeeze = squeezeFor(advance(PROBE_CAPS));
  const cell = cellFor(advance(PROBE_DIGITS), squeeze);
  root.removeChild(probe);
  root.style.setProperty('--squeeze', String(squeeze));
  root.style.setProperty('--cell', String(cell));
  return { squeeze, cell };
}
