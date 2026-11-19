import { describe, expect, it } from 'vitest';
import { TEMPLATE_GRID, SHEETS, markerCenters, workRegion, ignoreZones, MARKER_SIZE, GRID_PITCH } from '../src/sheet';
import { computeHomography, applyHomography, rectify } from '../src/vision/homography';
import { detectMarkers } from '../src/vision/markers';
import { segmentItems } from '../src/vision/segment';
import { createImage } from '../src/vision/image';

const sheet = SHEETS.a4;

/** Colour of the printed sheet (plus test objects) at a point in mm. */
function sheetColour(x: number, y: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x > sheet.width || y > sheet.height) return null;
  for (const c of markerCenters(sheet)) {
    if (Math.abs(x - c.x) <= MARKER_SIZE / 2 && Math.abs(y - c.y) <= MARKER_SIZE / 2) return [10, 10, 10];
  }
  // Objects: dark grey rectangle 80 x 30 mm, red disc of 40 mm diameter, blue L shape.
  if (x >= 40 && x <= 120 && y >= 60 && y <= 90) return [60, 60, 65];
  if ((x - 140) ** 2 + (y - 200) ** 2 <= 20 ** 2) return [200, 40, 40];
  if ((x >= 30 && x <= 45 && y >= 150 && y <= 230) || (x >= 30 && x <= 90 && y >= 215 && y <= 230)) return [40, 70, 190];
  const m = 10;
  if (x >= m && x <= sheet.width - m && y >= m && y <= sheet.height - m) {
    const gx = ((x - m) % GRID_PITCH + GRID_PITCH) % GRID_PITCH, gy = ((y - m) % GRID_PITCH + GRID_PITCH) % GRID_PITCH;
    if (gx < 0.2 || gx > GRID_PITCH - 0.2 || gy < 0.2 || gy > GRID_PITCH - 0.2) return [110, 200, 235];
  }
  return [245, 245, 240];
}

function synthPhoto(rotate90 = false) {
  const W = 1500, H = 2000;
  // Where the sheet corners land in the photo: a perspective quad.
  let quad = [
    { x: 220, y: 180 },
    { x: 1310, y: 260 },
    { x: 1420, y: 1850 },
    { x: 90, y: 1760 },
  ];
  let w = W, h = H;
  if (rotate90) {
    // Sheet lying sideways in a landscape photo.
    quad = quad.map((p) => ({ x: p.y, y: W - p.x }));
    w = H;
    h = W;
  }
  const corners = [
    { x: 0, y: 0 },
    { x: sheet.width, y: 0 },
    { x: sheet.width, y: sheet.height },
    { x: 0, y: sheet.height },
  ];
  const photoToSheet = computeHomography(quad, corners);
  const img = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = applyHomography(photoToSheet, { x: x + 0.5, y: y + 0.5 });
      const c = sheetColour(p.x, p.y) ?? [90, 80, 70];
      const light = 0.75 + 0.25 * (x / w); // uneven lighting
      const o = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = c[k] * light;
      img.data[o + 3] = 255;
    }
  return img;
}

function analyse(rotate90: boolean) {
  const photo = synthPhoto(rotate90);
  const pts = detectMarkers(photo);
  expect(pts).not.toBeNull();
  const region = workRegion(sheet);
  const ppm = 4;
  const rect = rectify(photo, pts!, markerCenters(sheet), region, ppm);
  return segmentItems(rect, { ppm, origin: region, ignore: ignoreZones(sheet), threshold: 0.25, grid: TEMPLATE_GRID });
}

describe('vision pipeline', () => {
  for (const rot of [false, true]) {
    it(`finds the three items with correct sizes${rot ? ' (sheet rotated 90°)' : ''}`, () => {
      const res = analyse(rot);
      expect(res.outlines.length).toBe(3);
      const dims = res.outlines.map((o) => [o.bbox.w, o.bbox.h].sort((a, b) => b - a));
      const expected = [
        [80, 30],
        [80, 60],
        [40, 40],
      ];
      // Each expected size should be matched within 1 mm.
      for (const e of expected) {
        const ok = dims.some((d) => Math.abs(d[0] - e[0]) < 1 && Math.abs(d[1] - e[1]) < 1);
        expect(ok, `size ${e} in ${JSON.stringify(dims)}`).toBe(true);
      }
      const disc = res.outlines.find((o) => Math.abs(o.bbox.w - 40) < 1.5 && Math.abs(o.bbox.h - 40) < 1.5)!;
      expect(disc.areaMm2).toBeGreaterThan(Math.PI * 400 * 0.96);
      expect(disc.areaMm2).toBeLessThan(Math.PI * 400 * 1.04);
    });
  }
});
