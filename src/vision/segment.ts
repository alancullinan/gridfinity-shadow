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
  /** See InkOptions.shadowLevel. */
  shadowLevel?: number;
  /** See InkOptions.grid. */
  grid?: InkOptions['grid'];
  /** Manual corrections per rectified pixel: 1 = force item, -1 = force paper, 0 = automatic. */
  edits?: Int8Array;
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

export interface InkOptions {
  /** Pixels per millimetre. */
  ppm: number;
  /**
   * Neutral (colourless) darkening below this is treated as shadow when the printed grid
   * cannot be used to tell shadow from item.
   */
  shadowLevel?: number;
  /** Printed grid, if known: line pitch and the position of one line, in mm from the image origin. */
  grid?: { pitch: number; offsetX: number; offsetY: number };
}

/**
 * For each expected grid line, finds where it actually is (within ±1.5 mm, to absorb small
 * print and lens errors) using the line mask, and records along its length whether it is
 * visible. Returns null when the grid cannot be seen well enough to use.
 */
function gridVisibility(line: Float32Array, w: number, h: number, ppm: number, grid: NonNullable<InkOptions['grid']>) {
  const pitch = grid.pitch * ppm;
  const search = Math.round(1.5 * ppm);
  const band = Math.max(1, Math.round(0.5 * ppm));
  const locate = (len: number, offset: number, profile: Float32Array) => {
    const pos: number[] = [];
    const first = offset * ppm - Math.floor((offset * ppm) / pitch) * pitch;
    for (let e = first; e < len; e += pitch) {
      let best = -1, bestV = -1;
      for (let d = -search; d <= search; d++) {
        const q = Math.round(e + d);
        if (q < 0 || q >= len) continue;
        const v = profile[q] + 0.5 * ((profile[q - 1] ?? 0) + (profile[q + 1] ?? 0));
        if (v > bestV) {
          bestV = v;
          best = q;
        }
      }
      if (best >= 0) pos.push(best);
    }
    return pos;
  };
  const colSum = new Float32Array(w), rowSum = new Float32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = line[y * w + x];
      colSum[x] += v;
      rowSum[y] += v;
    }
  const xs = locate(w, grid.offsetX, colSum);
  const ys = locate(h, grid.offsetY, rowSum);
  // The grid is usable if most lines are clearly present along a good part of their length.
  const seen = (sum: Float32Array, pos: number[], len: number) => pos.filter((q) => sum[q] > len * 0.25).length;
  if (seen(colSum, xs, h) < xs.length * 0.5 || seen(rowSum, ys, w) < ys.length * 0.5) return null;

  // visV[k][y]: vertical line k visible at row y; visH[k][x]: horizontal line k visible at column x.
  const visV = xs.map((x0) => {
    const v = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let x = Math.max(0, x0 - band); x <= Math.min(w - 1, x0 + band); x++) if (line[yy * w + x]) { any = 1; break; }
      }
      v[y] = any;
    }
    return v;
  });
  const visH = ys.map((y0) => {
    const v = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      let any = 0;
      for (let dx = -1; dx <= 1 && !any; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        for (let y = Math.max(0, y0 - band); y <= Math.min(h - 1, y0 + band); y++) if (line[y * w + xx]) { any = 1; break; }
      }
      v[x] = any;
    }
    return v;
  });
  // Index of the line at or before each column / row (-1 if none).
  const before = (len: number, pos: number[]) => {
    const idx = new Int32Array(len).fill(-1);
    let k = -1;
    for (let q = 0; q < len; q++) {
      while (k + 1 < pos.length && pos[k + 1] <= q) k++;
      idx[q] = k;
    }
    return idx;
  };
  const colIdx = before(w, xs), rowIdx = before(h, ys);
  /** True if the grid is visible around (x, y) in both directions, i.e. this is paper (maybe shadowed). */
  return (x: number, y: number): boolean => {
    const ky = rowIdx[y];
    const up = ky >= 0 && visH[ky][x] === 1;
    const down = ky + 1 < ys.length && visH[ky + 1][x] === 1;
    if (!up && !down) return false;
    const kx = colIdx[x];
    const left = kx >= 0 && visV[kx][y] === 1;
    const right = kx + 1 < xs.length && visV[kx + 1][y] === 1;
    return left || right;
  };
}

/**
 * Per-pixel "ink" value 0..1 used for thresholding: how sure we are that a pixel is part of an
 * item rather than paper. Handles shadows with two cues:
 *  - shadows darken the paper without changing its colour, so coloured pixels are items;
 *  - the cyan grid stays visible through a shadow but is hidden by an item, so colourless
 *    darkening where grid lines are still visible is shadow.
 */
export function inkMap(img: RGBAImage, ignored: Uint8Array, opts: InkOptions): Float32Array {
  const { width: w, height: h, data } = img;
  const { ppm } = opts;
  const shadowLevel = opts.shadowLevel ?? 0.35;
  const paper = paperModel(img, ignored, Math.max(8, Math.round(ppm * 8)));
  // Evaluate the paper model on a coarse grid and interpolate, which is much faster.
  const step = 8;
  const gw = Math.ceil(w / step) + 1, gh = Math.ceil(h / step) + 1;
  const grid = new Float32Array(gw * gh * 3);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++)
      for (let c = 0; c < 3; c++) grid[(gy * gw + gx) * 3 + c] = paper(gx * step, gy * step, c);

  const n = w * h;
  const dark = new Float32Array(n); // 1 - brightness relative to paper, ignoring the red channel
  const chroma = new Float32Array(n); // how coloured the pixel is relative to paper
  const line = new Float32Array(n); // 1 where a cyan grid line is visible (in light or shadow)
  const p = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const gy = y / step, gy0 = Math.floor(gy), fy = gy - gy0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ignored[i]) continue;
      const gx = x / step, gx0 = Math.floor(gx), fx = gx - gx0;
      for (let c = 0; c < 3; c++) {
        const a = grid[(gy0 * gw + gx0) * 3 + c], b = grid[(gy0 * gw + gx0 + 1) * 3 + c];
        const d = grid[((gy0 + 1) * gw + gx0) * 3 + c], e = grid[((gy0 + 1) * gw + gx0 + 1) * 3 + c];
        p[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
      const nr = data[i * 4] / p[0];
      const ng = data[i * 4 + 1] / p[1];
      const nb = data[i * 4 + 2] / p[2];
      const v = Math.min(ng, nb);
      dark[i] = Math.max(0, 1 - v);
      // Cyan lines lower red only, so red falling short of green/blue is not "colour"; red
      // exceeding them (red/orange/brown items) and green/blue disagreeing (yellow, green,
      // blue items) is.
      const gb = Math.abs(ng - nb);
      chroma[i] = gb + Math.max(0, nr - Math.max(ng, nb));
      const mean = (ng + nb) / 2;
      line[i] = mean > 0.15 && gb < 0.12 && nr / mean < 0.9 ? 1 : 0;
    }
  }

  const onPaper = opts.grid ? gridVisibility(line, w, h, ppm, opts.grid) : null;

  const ink = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ignored[i]) continue;
      const d = dark[i];
      const colourInk = Math.min(1, chroma[i] * 2);
      let neutralInk: number;
      if (d > 0.7) neutralInk = d; // nearly black: always an item
      else if (onPaper) neutralInk = onPaper(x, y) ? d * 0.3 : d; // grid visible -> paper or shadow
      else neutralInk = d > shadowLevel ? d : d * 0.3;
      ink[i] = Math.max(colourInk, neutralInk);
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
  const ink = inkMap(img, ignored, { ppm, shadowLevel: opts.shadowLevel, grid: opts.grid });
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = !ignored[i] && ink[i] > opts.threshold ? 1 : 0;
  // Remove thin grid-line remnants and speckle, then close small gaps and fill holes.
  const rOpen = Math.max(1, Math.round(ppm * 0.4));
  const rClose = Math.max(1, Math.round(ppm * 0.75));
  mask = morph(morph(mask, w, h, rOpen, false), w, h, rOpen, true);
  mask = morph(morph(mask, w, h, rClose, true), w, h, rClose, false);
  if (opts.edits) {
    const e = opts.edits;
    for (let i = 0; i < w * h; i++) if (e[i]) mask[i] = e[i] > 0 ? 1 : 0;
  }
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
