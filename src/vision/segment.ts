import type { Point, Rect } from '../sheet';
import { RGBAImage, fillHoles, labelComponents, morph } from './image';
import { simplifyClosed, traceLoops } from './contour';
import { polygonArea } from './markers';

export interface DetectedOutline {
  /** Closed loops in sheet millimetres. */
  loops: Point[][];
  areaMm2: number;
  bbox: Rect;
}

export interface SegmentResult {
  mask: Uint8Array;
  width: number;
  height: number;
  outlines: DetectedOutline[];
}

export interface SegmentOptions {
  /** Pixels per millimetre of the rectified image. */
  ppm: number;
  /** Sheet position (mm) of the rectified image's top-left corner. */
  origin: Point;
  /** Sheet areas to ignore (markers etc.), in mm. */
  ignore: Rect[];
  /** 0..1, how different from the paper a pixel must be to count as an item. */
  threshold: number;
  /** Smallest item to keep, in mm². */
  minAreaMm2?: number;
}

function solveSmall(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

/**
 * Estimates the paper colour across the image (to cancel uneven lighting) by fitting a
 * quadratic surface per channel to bright block percentiles, rejecting blocks covered by items.
 */
function paperModel(img: RGBAImage, ignored: Uint8Array, block: number): ((x: number, y: number, c: number) => number) {
  const { width: w, height: h, data } = img;
  const samples: { x: number; y: number; v: number[] }[] = [];
  const hist = new Uint32Array(256 * 3);
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      hist.fill(0);
      let n = 0;
      for (let y = by; y < Math.min(h, by + block); y++)
        for (let x = bx; x < Math.min(w, bx + block); x++) {
          const i = y * w + x;
          if (ignored[i]) continue;
          n++;
          for (let c = 0; c < 3; c++) hist[c * 256 + data[i * 4 + c]]++;
        }
      if (n < block * block * 0.5) continue;
      const v = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        let acc = 0;
        const target = n * 0.8;
        for (let k = 0; k < 256; k++) {
          acc += hist[c * 256 + k];
          if (acc >= target) {
            v[c] = k;
            break;
          }
        }
      }
      samples.push({ x: (bx + block / 2) / w, y: (by + block / 2) / h, v });
    }
  }
  const basis = (x: number, y: number) => [1, x, y, x * x, x * y, y * y];
  const coeffs: number[][] = [];
  for (let c = 0; c < 3; c++) {
    let active = samples.slice();
    let coef: number[] | null = null;
    for (let iter = 0; iter < 4 && active.length >= 6; iter++) {
      const A = Array.from({ length: 6 }, () => new Array(6).fill(0));
      const b = new Array(6).fill(0);
      for (const s of active) {
        const f = basis(s.x, s.y);
        for (let i = 0; i < 6; i++) {
          b[i] += f[i] * s.v[c];
          for (let j = 0; j < 6; j++) A[i][j] += f[i] * f[j];
        }
      }
      coef = solveSmall(A, b);
      if (!coef) break;
      const fit = (s: { x: number; y: number }) => basis(s.x, s.y).reduce((acc, f, i) => acc + f * coef![i], 0);
      active = samples.filter((s) => s.v[c] >= fit(s) * 0.88);
    }
    if (!coef) {
      const vals = samples.map((s) => s.v[c]).sort((a, b) => a - b);
      coef = [vals.length ? vals[Math.floor(vals.length * 0.75)] : 255, 0, 0, 0, 0, 0];
    }
    coeffs.push(coef);
  }
  return (x, y, c) => {
    const f = basis(x / w, y / h);
    let v = 0;
    for (let i = 0; i < 6; i++) v += f[i] * coeffs[c][i];
    return Math.max(20, v);
  };
}

/** Per-pixel "ink" value 0..1 used for thresholding (exported for the debug overlay). */
export function inkMap(img: RGBAImage, ignored: Uint8Array, ppm: number): Float32Array {
  const { width: w, height: h, data } = img;
  const paper = paperModel(img, ignored, Math.max(8, Math.round(ppm * 8)));
  const ink = new Float32Array(w * h);
  // Evaluate the paper model on a coarse grid and interpolate, which is much faster.
  const step = 8;
  const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
  const grid = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++)
      for (let c = 0; c < 3; c++) grid[(gy * gw + gx) * 3 + c] = paper(gx * step, gy * step, c);
  for (let y = 0; y < h; y++) {
    const gy = y / step, gy0 = Math.floor(gy), fy = gy - gy0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ignored[i]) continue;
      const gx = x / step, gx0 = Math.floor(gx), fx = gx - gx0;
      const p = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const a = grid[(gy0 * gw + gx0) * 3 + c], b = grid[(gy0 * gw + gx0 + 1) * 3 + c];
        const d = grid[((gy0 + 1) * gw + gx0) * 3 + c], e = grid[((gy0 + 1) * gw + gx0 + 1) * 3 + c];
        p[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
      // The grid is printed in cyan, which mostly darkens the red channel, so ignore red
      // and look at how much green or blue is missing compared to the paper.
      const ng = data[i * 4 + 1] / p[1];
      const nb = data[i * 4 + 2] / p[2];
      ink[i] = Math.max(0, 1 - Math.min(ng, nb));
    }
  }
  return ink;
}

export function segmentItems(img: RGBAImage, opts: SegmentOptions): SegmentResult {
  const { width: w, height: h } = img;
  const { ppm, origin } = opts;
  const ignored = new Uint8Array(w * h);
  for (const z of opts.ignore) {
    const x0 = Math.max(0, Math.floor((z.x - origin.x) * ppm));
    const y0 = Math.max(0, Math.floor((z.y - origin.y) * ppm));
    const x1 = Math.min(w, Math.ceil((z.x + z.w - origin.x) * ppm));
    const y1 = Math.min(h, Math.ceil((z.y + z.h - origin.y) * ppm));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) ignored[y * w + x] = 1;
  }
  const ink = inkMap(img, ignored, ppm);
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = !ignored[i] && ink[i] > opts.threshold ? 1 : 0;
  // Remove thin grid-line remnants and speckle, then close small gaps and fill holes.
  const rOpen = Math.max(1, Math.round(ppm * 0.4));
  const rClose = Math.max(1, Math.round(ppm * 0.75));
  mask = morph(morph(mask, w, h, rOpen, false), w, h, rOpen, true);
  mask = morph(morph(mask, w, h, rClose, true), w, h, rClose, false);
  mask = fillHoles(mask, w, h);
  const { labels, comps } = labelComponents(mask, w, h);
  const minArea = (opts.minAreaMm2 ?? 30) * ppm * ppm;
  const outlines: DetectedOutline[] = [];
  for (const c of comps) {
    if (c.area < minArea) {
      for (let y = c.minY; y <= c.maxY; y++)
        for (let x = c.minX; x <= c.maxX; x++) if (labels[y * w + x] === c.label) mask[y * w + x] = 0;
      continue;
    }
    const loops = traceLoops(labels, w, h, c.label)
      .map((l) => simplifyClosed(l, 0.8))
      .filter((l) => l.length >= 3)
      .map((l) => l.map((p) => ({ x: origin.x + p.x / ppm, y: origin.y + p.y / ppm })))
      // Normalise to counter-clockwise in a y-up frame (positive area with this formula in y-down).
      .map((l) => (polygonArea(l) < 0 ? l.reverse() : l));
    if (!loops.length) continue;
    outlines.push({
      loops,
      areaMm2: c.area / (ppm * ppm),
      bbox: {
        x: origin.x + c.minX / ppm,
        y: origin.y + c.minY / ppm,
        w: (c.maxX - c.minX + 1) / ppm,
        h: (c.maxY - c.minY + 1) / ppm,
      },
    });
  }
  outlines.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  return { mask, width: w, height: h, outlines };
}
