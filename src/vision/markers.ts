import type { Point } from '../sheet';
import { RGBAImage, boxBlur, downscale, labelComponents, luminance } from './image';

interface Candidate {
  c: Point;
  area: number;
}

function convexHullArea(pts: Point[]): number {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return 0;
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Point[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return Math.abs(polygonArea(hull));
}

export function polygonArea(p: Point[]): number {
  let a = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j].x + p[i].x) * (p[j].y - p[i].y);
  return a / 2;
}

function isConvexQuad(q: Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    const s = Math.sign(cr);
    if (s === 0) return false;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Orders four points clockwise (in image coordinates) starting nearest the top-left. */
function orderClockwise(pts: Point[]): Point[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]);
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Finds the four black corner markers of the printed template.
 * Returns their centres in photo pixels ordered to match the sheet's TL, TR, BR, BL
 * (the sheet is portrait, so if the photo shows it sideways the order is rotated),
 * or null if no plausible set is found.
 */
export function detectMarkers(photo: RGBAImage, portraitSheet = true): Point[] | null {
  const { img, scale } = downscale(photo, 1000);
  const w = img.width, h = img.height;
  const lum = luminance(img);
  const local = boxBlur(lum, w, h, Math.round(Math.max(w, h) / 25));
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = lum[i] < local[i] * 0.55 && lum[i] < 110 ? 1 : 0;
  const { labels, comps } = labelComponents(mask, w, h);

  const maxDim = Math.max(w, h);
  const minArea = (maxDim * 0.012) ** 2;
  const maxArea = (maxDim * 0.12) ** 2;
  const candidates: Candidate[] = [];
  for (const c of comps) {
    if (c.area < minArea || c.area > maxArea) continue;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (Math.max(bw, bh) / Math.min(bw, bh) > 2.2) continue;
    if (c.area / (bw * bh) < 0.45) continue;
    // Solidity: area vs convex hull of the row extents.
    const pts: Point[] = [];
    for (let y = c.minY; y <= c.maxY; y++) {
      let lo = -1, hi = -1;
      for (let x = c.minX; x <= c.maxX; x++) {
        if (labels[y * w + x] === c.label) {
          if (lo < 0) lo = x;
          hi = x;
        }
      }
      if (lo >= 0) {
        pts.push({ x: lo, y }, { x: hi + 1, y }, { x: lo, y: y + 1 }, { x: hi + 1, y: y + 1 });
      }
    }
    if (c.area / convexHullArea(pts) < 0.88) continue;
    candidates.push({ c: { x: (c.cx + 0.5) * scale, y: (c.cy + 0.5) * scale }, area: c.area });
  }
  if (candidates.length < 4) return null;

  // Keep the largest few to bound the search, then choose the convex quad with the largest area
  // whose four blobs have similar sizes.
  candidates.sort((a, b) => b.area - a.area);
  const cand = candidates.slice(0, 24);
  let best: Point[] | null = null;
  let bestArea = 0;
  const n = cand.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const set = [cand[a], cand[b], cand[c], cand[d]];
          const areas = set.map((s) => s.area);
          if (Math.max(...areas) / Math.min(...areas) > 5) continue;
          const q = orderClockwise(set.map((s) => s.c));
          if (!isConvexQuad(q)) continue;
          const area = Math.abs(polygonArea(q));
          if (area > bestArea) {
            bestArea = area;
            best = q;
          }
        }
  if (!best) return null;
  if (bestArea < (photo.width * photo.height) * 0.08) return null;

  // Decide which side of the quad is the sheet's short (top) edge.
  const horiz = dist(best[0], best[1]) + dist(best[2], best[3]);
  const vert = dist(best[1], best[2]) + dist(best[3], best[0]);
  if (portraitSheet ? horiz > vert : horiz < vert) {
    best = [best[3], best[0], best[1], best[2]];
  }
  return best;
}
