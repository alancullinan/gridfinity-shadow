// Printable template sheet definition. All units are millimetres, origin at the
// top-left corner of the paper, y pointing down (same as SVG / image space).

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetSpec {
  id: 'a4' | 'letter';
  name: string;
  width: number;
  height: number;
}

export const SHEETS: Record<SheetSpec['id'], SheetSpec> = {
  a4: { id: 'a4', name: 'A4 (210 × 297 mm)', width: 210, height: 297 },
  letter: { id: 'letter', name: 'US Letter (8.5 × 11 in)', width: 215.9, height: 279.4 },
};

/** Distance from paper edge to the outer edge of the corner markers. */
export const SHEET_MARGIN = 10;
/** Side length of the solid black corner markers. */
export const MARKER_SIZE = 10;
/** Grid pitch printed on the template. */
export const GRID_PITCH = 5;
/** Every this many grid lines, a bold line (every 25 mm). Lets the software tell lines apart. */
export const MAJOR_EVERY = 5;
/** Printed line widths, mm: wide enough to survive camera blur and shadows. */
export const MINOR_LINE_MM = 0.45;
export const MAJOR_LINE_MM = 0.9;

/** Centres of the four corner markers, in order TL, TR, BR, BL. */
export function markerCenters(sheet: SheetSpec): Point[] {
  const c = SHEET_MARGIN + MARKER_SIZE / 2;
  return [
    { x: c, y: c },
    { x: sheet.width - c, y: c },
    { x: sheet.width - c, y: sheet.height - c },
    { x: c, y: sheet.height - c },
  ];
}

/**
 * How far the analysed region extends past the outermost grid lines, so those lines are fully
 * inside the image (they are used to tell shadows from items).
 */
export const REGION_PAD = 2;

/** The region of the sheet that gets rectified and searched for items. */
export function workRegion(sheet: SheetSpec): Rect {
  return {
    x: SHEET_MARGIN - REGION_PAD,
    y: SHEET_MARGIN - REGION_PAD,
    w: sheet.width - 2 * (SHEET_MARGIN - REGION_PAD),
    h: sheet.height - 2 * (SHEET_MARGIN - REGION_PAD),
  };
}

/** The template's grid as seen in the rectified work region. */
export const TEMPLATE_GRID = { pitch: GRID_PITCH, offsetX: REGION_PAD, offsetY: REGION_PAD, majorEvery: MAJOR_EVERY };

/** Areas (markers plus a little padding) that must be ignored when looking for items. */
export function ignoreZones(sheet: SheetSpec): Rect[] {
  const pad = 3;
  const markers = markerCenters(sheet).map((c) => ({
    x: c.x - MARKER_SIZE / 2 - pad,
    y: c.y - MARKER_SIZE / 2 - pad,
    w: MARKER_SIZE + 2 * pad,
    h: MARKER_SIZE + 2 * pad,
  }));
  // The thin margin outside the outermost grid lines (kept in the image so those lines are
  // fully visible) isn't part of the tracing area.
  const m = SHEET_MARGIN, b = REGION_PAD + 1.2, W = sheet.width, H = sheet.height;
  const border = [
    { x: m - REGION_PAD, y: m - REGION_PAD, w: W - 2 * (m - REGION_PAD), h: b },
    { x: m - REGION_PAD, y: H - m + REGION_PAD - b, w: W - 2 * (m - REGION_PAD), h: b },
    { x: m - REGION_PAD, y: m - REGION_PAD, w: b, h: H - 2 * (m - REGION_PAD) },
    { x: W - m + REGION_PAD - b, y: m - REGION_PAD, w: b, h: H - 2 * (m - REGION_PAD) },
  ];
  return [...markers, ...border];
}
