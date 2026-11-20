import { describe, expect, it } from 'vitest';
import { TEMPLATE_GRID, SHEETS, markerCenters, workRegion, ignoreZones, MARKER_SIZE, GRID_PITCH } from '../src/sheet';
import { computeHomography, applyHomography, rectify } from '../src/vision/homography';
import { dewarpByGrid } from '../src/vision/dewarp';
import { detectMarkers } from '../src/vision/markers';
import { segmentItems } from '../src/vision/segment';
import { createImage, RGBAImage } from '../src/vision/image';

// A harder synthetic photo: soft cast shadows offset down-right of each item, a mid-grey
// item, thin grid lines as printed, supersampling and a camera blur.
const sheet = SHEETS.a4;

const sdRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => {
  const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
  const outside = Math.hypot(dx, dy);
  const inside = Math.min(x - x0, x1 - x, y - y0, y1 - y);
  return outside > 0 ? outside : -inside;
};
const sdCircle = (x: number, y: number, cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) - r;

type Shape = { sd: (x: number, y: number) => number; colour: [number, number, number] };
const shapes: Shape[] = [
  { sd: (x, y) => sdRect(x, y, 40, 60, 120, 90), colour: [45, 45, 50] }, // black, 80 x 30
  { sd: (x, y) => sdCircle(x, y, 140, 200, 20), colour: [200, 40, 40] }, // red disc, 40
  { sd: (x, y) => sdRect(x, y, 140, 40, 180, 70), colour: [150, 152, 150] }, // mid-grey, 40 x 30
  { sd: (x, y) => sdRect(x, y, 40, 150, 70, 250), colour: [230, 190, 40] }, // yellow, 30 x 100
];
const SHADOW_OFFSET = { x: 5, y: 6 };
const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function sheetColour(x: number, y: number): [number, number, number] | null {
  if (x < 0 || y < 0 || x > sheet.width || y > sheet.height) return null;
  for (const c of markerCenters(sheet))
    if (Math.abs(x - c.x) <= MARKER_SIZE / 2 && Math.abs(y - c.y) <= MARKER_SIZE / 2) return [15, 15, 15];
  for (const s of shapes) if (s.sd(x, y) <= 0) return s.colour;
  let c: [number, number, number] = [245, 245, 240];
  const m = 10;
  if (x >= m && x <= sheet.width - m && y >= m && y <= sheet.height - m) {
    const ix = Math.round((x - m) / GRID_PITCH), iy = Math.round((y - m) / GRID_PITCH);
    const dx = Math.abs(x - m - ix * GRID_PITCH), dy = Math.abs(y - m - iy * GRID_PITCH);
    const hx = ix % 2 === 0 ? 0.15 : 0.075, hy = iy % 2 === 0 ? 0.15 : 0.075;
    if (dx < hx || dy < hy) c = [110, 200, 235];
  }
  // Soft shadow: darkest (x0.5) under the item, fading over a 4 mm penumbra.
  let shade = 1;
  for (const s of shapes) {
    const d = s.sd(x - SHADOW_OFFSET.x, y - SHADOW_OFFSET.y);
    shade = Math.min(shade, 0.5 + 0.5 * smooth(-2, 2, d));
  }
  return [c[0] * shade, c[1] * shade, c[2] * shade];
}

function blur(img: RGBAImage): RGBAImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            s += img.data[(yy * w + xx) * 4 + c];
            n++;
          }
        out.data[o + c] = s / n;
      }
      out.data[o + 3] = 255;
    }
  return out;
}

function synthPhoto() {
  const W = 1500, H = 2000;
  const quad = [{ x: 220, y: 180 }, { x: 1310, y: 260 }, { x: 1420, y: 1850 }, { x: 90, y: 1760 }];
  const corners = [{ x: 0, y: 0 }, { x: sheet.width, y: 0 }, { x: sheet.width, y: sheet.height }, { x: 0, y: sheet.height }];
  const P = computeHomography(quad, corners);
  const img = createImage(W, H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = applyHomography(P, { x: x + sx, y: y + sy });
        const c = sheetColour(p.x, p.y) ?? [90, 80, 70];
        for (let k = 0; k < 3; k++) acc[k] += c[k] / 4;
      }
      const light = 0.8 + 0.2 * (x / W);
      const o = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = acc[k] * light;
      img.data[o + 3] = 255;
    }
  return blur(img);
}

describe('shadows', () => {
  it('measures items without their cast shadows', () => {
    const photo = synthPhoto();
    const pts = detectMarkers(photo);
    expect(pts).not.toBeNull();
    const region = workRegion(sheet);
    let rect = rectify(photo, pts!, markerCenters(sheet), region, 4);
    const markers = ignoreZones(sheet).filter((z) => z.w < 30).map((z) => ({ x: z.x - region.x, y: z.y - region.y, w: z.w, h: z.h }));
    const dw = dewarpByGrid(rect, 4, TEMPLATE_GRID, markers);
    expect(dw, 'grid dewarp').not.toBeNull();
    expect(dw!.maxShiftMm).toBeLessThan(0.6);
    rect = dw!.image;
    const res = segmentItems(rect, { ppm: 4, origin: region, ignore: ignoreZones(sheet), threshold: 0.25, grid: TEMPLATE_GRID });
    const dims = res.outlines.map((o) => [+o.bbox.w.toFixed(1), +o.bbox.h.toFixed(1)]);
    console.log('detected:', JSON.stringify(dims), JSON.stringify(res.outlines.map((o) => [o.bbox.x, o.bbox.y].map((v) => +v.toFixed(1)))));
    const expected = [[80, 30], [40, 40], [40, 30], [30, 100]];
    for (const [ew, eh] of expected) {
      const ok = dims.some(([w, h]) => Math.abs(w - ew) < 1.5 && Math.abs(h - eh) < 1.5);
      expect(ok, `expected ${ew}x${eh} in ${JSON.stringify(dims)}`).toBe(true);
    }
    expect(res.outlines.length).toBe(4);

    // Outline smoothness: the disc's traced outline should hug a true circle.
    const ripple = (smoothMm: number) => {
      const r2 = segmentItems(rect, { ppm: 4, origin: region, ignore: ignoreZones(sheet), threshold: 0.25, grid: TEMPLATE_GRID, smoothMm });
      const disc = r2.outlines.find((o) => Math.abs(o.bbox.w - 40) < 1.5 && Math.abs(o.bbox.h - 40) < 1.5)!;
      const pts = disc.loops[0];
      // Area centroid (vertex averages are biased when vertices are unevenly spaced).
      let A = 0, cx = 0, cy = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length], c = a.x * b.y - b.x * a.y;
        A += c; cx += (a.x + b.x) * c; cy += (a.y + b.y) * c;
      }
      cx /= 3 * A; cy /= 3 * A;
      // Sample densely along the polygon edges (not just vertices) and measure radius deviation.
      const radii: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        for (let t = 0; t < 1; t += 0.1) radii.push(Math.hypot(a.x + (b.x - a.x) * t - cx, a.y + (b.y - a.y) * t - cy));
      }
      const mean = radii.reduce((a, r) => a + r, 0) / radii.length;
      // Radius by angle (degrees, 0..359), to separate overall shape error from ripple.
      const byAngle = new Array(360).fill(0).map(() => [] as number[]);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        for (let t = 0; t < 1; t += 0.05) {
          const x = a.x + (b.x - a.x) * t - cx, y = a.y + (b.y - a.y) * t - cy;
          byAngle[((Math.round((Math.atan2(y, x) * 180) / Math.PI) % 360) + 360) % 360].push(Math.hypot(x, y));
        }
      }
      const prof = byAngle.map((v) => (v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN));
      // Ripple: deviation from a 15-degree (≈5 mm of arc) moving average.
      let ripple = 0;
      for (let i = 0; i < 360; i++) {
        let s = 0, c = 0;
        for (let k = -7; k <= 7; k++) {
          const v = prof[(i + k + 360) % 360];
          if (!isNaN(v)) { s += v; c++; }
        }
        if (!isNaN(prof[i]) && c) ripple = Math.max(ripple, Math.abs(prof[i] - s / c));
      }
      const shape = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => +prof[a].toFixed(2));
      return { mean, ripple, shape, maxDev: Math.max(...radii.map((r) => Math.abs(r - mean))), points: pts.length };
    };
    const rough = ripple(0), smooth = ripple(1), appDefault = ripple(2);
    console.log('disc outline ripple: none', rough.ripple.toFixed(3), '| 1 mm', smooth.ripple.toFixed(3), '| 2 mm (app default)', appDefault.ripple.toFixed(3));
    // With the app's default 2 mm smoothing, ripple is around the facet size, far below print
    // resolution; lighter smoothing still clearly helps.
    expect(appDefault.ripple).toBeLessThan(0.08);
    expect(smooth.ripple).toBeLessThan(0.2);
    expect(smooth.ripple).toBeLessThan(rough.ripple / 2);
    expect(Math.abs(smooth.mean - 20)).toBeLessThan(0.4); // size preserved
  }, 30000);
});
