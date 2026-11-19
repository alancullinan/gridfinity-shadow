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

/** The region of the sheet that gets rectified and searched for items. */
export function workRegion(sheet: SheetSpec): Rect {
  return {
    x: SHEET_MARGIN,
    y: SHEET_MARGIN,
    w: sheet.width - 2 * SHEET_MARGIN,
    h: sheet.height - 2 * SHEET_MARGIN,
  };
}

/** Areas (markers plus a little padding) that must be ignored when looking for items. */
export function ignoreZones(sheet: SheetSpec): Rect[] {
  const pad = 3;
  return markerCenters(sheet).map((c) => ({
    x: c.x - MARKER_SIZE / 2 - pad,
    y: c.y - MARKER_SIZE / 2 - pad,
    w: MARKER_SIZE + 2 * pad,
    h: MARKER_SIZE + 2 * pad,
  }));
}
