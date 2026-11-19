import type { Point } from '../sheet';
import { RGBAImage, createImage } from './image';

export type Mat3 = number[]; // row-major 3x3

/** Solves A x = b in place with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [b[c], b[piv]] = [b[piv], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new Error('Degenerate point configuration');
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Homography mapping each src[i] to dst[i] (exactly four correspondences). */
export function computeHomography(src: Point[], dst: Point[]): Mat3 {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(H: Mat3, p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/**
 * Produces a top-down image of a rectangle on the sheet.
 * @param imagePts the four reference points in the photo (pixels)
 * @param sheetPts the same four points on the sheet (mm)
 * @param region area of the sheet to output (mm)
 * @param ppm output pixels per millimetre
 */
export function rectify(
  photo: RGBAImage,
  imagePts: Point[],
  sheetPts: Point[],
  region: { x: number; y: number; w: number; h: number },
  ppm: number,
): RGBAImage {
  const H = computeHomography(sheetPts, imagePts); // sheet mm -> photo px
  const W = Math.round(region.w * ppm);
  const Hh = Math.round(region.h * ppm);
  const out = createImage(W, Hh);
  const sw = photo.width, sh = photo.height, sd = photo.data;
  for (let y = 0; y < Hh; y++) {
    const my = region.y + (y + 0.5) / ppm;
    for (let x = 0; x < W; x++) {
      const mx = region.x + (x + 0.5) / ppm;
      const w = H[6] * mx + H[7] * my + H[8];
      const px = (H[0] * mx + H[1] * my + H[2]) / w - 0.5;
      const py = (H[3] * mx + H[4] * my + H[5]) / w - 0.5;
      const o = (y * W + x) * 4;
      if (px < 0 || py < 0 || px > sw - 1 || py > sh - 1) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 255;
        out.data[o + 3] = 255;
        continue;
      }
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
      const fx = px - x0, fy = py - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sd[i00 + c] * (1 - fx) + sd[i10 + c] * fx;
        const bot = sd[i01 + c] * (1 - fx) + sd[i11 + c] * fx;
        out.data[o + c] = top * (1 - fy) + bot * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}
