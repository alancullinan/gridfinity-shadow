import type { Point, Rect } from '../sheet';
import { RGBAImage, fillHoles, gridLineMask, labelComponents, morph } from './image';
import { gridOccupancy } from './gridSegment';
import { simplifyClosed, smoothClosed, traceLoops } from './contour';
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
  /** Outline smoothing strength in mm (Gaussian sigma); 0 = off. Default 2. */
  smoothMm?: number;
  /** See InkOptions.shadowLevel. */
  shadowLevel?: number;
  /** See InkOptions.grid. */
  grid?: InkOptions['grid'];
  /**
   * With a known grid: 'grid' finds items where the printed grid is hidden (refined by image
   * evidence near edges); 'brightness' compares pixels with the local paper. 'grid' needs the
   * current template (bold lines; the faint lines of older prints aren't reliable enough).
   * Default 'brightness'.
   */
  method?: 'grid' | 'brightness';
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

/** Separable sliding-window maximum with a (2r+1)² square window. */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/**
 * Paper brightness (1 − darkness) across the image, averaged from samples (−1 = no sample) in
 * small cells and filled smoothly underneath items.
 */
function illuminationMap(sample: Float32Array, w: number, h: number, cell: number) {
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const sum = new Float32Array(cw * ch), cnt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = sample[y * w + x];
      if (v < 0) continue;
      const c = ((y / cell) | 0) * cw + ((x / cell) | 0);
      sum[c] += v;
      cnt[c]++;
    }
  const val = new Float32Array(cw * ch), known = new Uint8Array(cw * ch);
  let tot = 0, nk = 0;
  for (let c = 0; c < cw * ch; c++)
    if (cnt[c] >= cell * cell * 0.4) { // sparse samples are more likely texture on an item
      val[c] = sum[c] / cnt[c];
      known[c] = 1;
      tot += val[c];
      nk++;
    }
  const avg = nk ? tot / nk : 1;
  for (let c = 0; c < cw * ch; c++) if (!known[c]) val[c] = avg;
  for (let iter = 0; iter < 200; iter++)
    for (let cy = 0; cy < ch; cy++)
      for (let cx = 0; cx < cw; cx++) {
        const c = cy * cw + cx;
        if (known[c]) continue;
        let s = 0, k = 0;
        if (cx > 0) (s += val[c - 1]), k++;
        if (cx < cw - 1) (s += val[c + 1]), k++;
        if (cy > 0) (s += val[c - cw]), k++;
        if (cy < ch - 1) (s += val[c + cw]), k++;
        val[c] = s / k;
      }
  return (x: number, y: number) => {
    const gx = Math.min(cw - 1.001, Math.max(0, x / cell - 0.5)), gy = Math.min(ch - 1.001, Math.max(0, y / cell - 0.5));
    const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
    const x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
    const v = (val[y0 * cw + x0] * (1 - tx) + val[y0 * cw + x1] * tx) * (1 - ty) + (val[y1 * cw + x0] * (1 - tx) + val[y1 * cw + x1] * tx) * ty;
    return Math.max(0.05, v);
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
  grid?: { pitch: number; offsetX: number; offsetY: number; majorEvery?: number };
  /**
   * If given, set to 1 where the printed grid is hidden but should be visible and the pixel is at
   * least slightly darker than paper: strong evidence of an item even when it's pale or shiny.
   */
  hidden?: Uint8Array;
  /** If given, receives the paper-relative darkness and colour maps. */
  maps?: { dark?: Float32Array; chroma?: Float32Array; rel?: Float32Array };
  /** Filled with intermediate maps for debugging, if given. */
  debug?: { line?: Float32Array; paper?: Uint8Array; gridFound?: boolean; rel?: Float32Array; illum?: Float32Array; probe?: (x: number, y: number) => unknown };
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

  // Printed lines are rarely perfectly straight in a photo (paper curl, lens distortion). Find
  // the line in each short segment near where it should be, then fit a gentle curve through those
  // points, rejecting outliers (item edges and print that happen to be nearby).
  const segLen = Math.max(8, Math.round(pitch));
  // After un-bending (dewarpByGrid) lines are within a pixel or two of where they should be, so a
  // narrow search is enough and keeps nearby item edges from pulling the fit off.
  const near = Math.max(2, Math.round(0.75 * ppm));
  const trackLine = (p0: number, len: number, across: number, at: (a: number, c: number) => number) => {
    const pts: { a: number; c: number }[] = [];
    for (let s0 = 0; s0 < len; s0 += segLen) {
      const s1 = Math.min(len, s0 + segLen);
      let best = -1, bestC = -1;
      for (let d = -near; d <= near; d++) {
        const c = Math.round(p0 + d);
        if (c < 1 || c >= across - 1) continue;
        let cnt = 0;
        for (let a = s0; a < s1; a++) cnt += at(a, c) + 0.5 * (at(a, c - 1) + at(a, c + 1));
        if (cnt > bestC) (bestC = cnt), (best = c);
      }
      if (best >= 0 && bestC >= (s1 - s0) * 0.6) pts.push({ a: (s0 + s1) / 2, c: best });
    }
    // Robust quadratic fit c(a) = k0 + k1 t + k2 t², t = a / len.
    let coef: number[] = [p0, 0, 0];
    let use = pts;
    for (let iter = 0; iter < 4 && use.length >= 5; iter++) {
      const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
      for (const { a, c } of use) {
        const t = a / len, f = [1, t, t * t];
        for (let i = 0; i < 3; i++) {
          b[i] += f[i] * c;
          for (let j = 0; j < 3; j++) A[i][j] += f[i] * f[j];
        }
      }
      const sol = solveSmall(A, b);
      if (!sol) break;
      coef = sol;
      const fit = (a: number) => coef[0] + coef[1] * (a / len) + coef[2] * (a / len) ** 2;
      const next = pts.filter(({ a, c }) => Math.abs(c - fit(a)) <= 1.5);
      if (next.length === use.length) break;
      use = next;
    }
    const out = new Float32Array(len);
    for (let a = 0; a < len; a++) {
      const v = coef[0] + coef[1] * (a / len) + coef[2] * (a / len) ** 2;
      out[a] = Math.abs(v - p0) <= near ? v : p0; // never wander off the expected position
    }
    return out;
  };
  const pathV = xs.map((x0) => trackLine(x0, h, w, (a, c) => line[a * w + c]));
  const pathH = ys.map((y0) => trackLine(y0, w, h, (a, c) => line[c * w + a]));

  // A line counts as visible at a point only if it runs nearly unbroken for ±1.25 mm there: real
  // grid lines are continuous, while texture on an item (machining marks, print, edges) isn't.
  const runL = Math.max(2, Math.round(1.25 * ppm));
  const continuous = (has: Uint8Array) => {
    // Visible if the line runs nearly unbroken on either side of the point, so paper right up to
    // an item's edge still counts (its line continues away from the item).
    const len = has.length;
    const pre = new Int32Array(len + 1);
    for (let i = 0; i < len; i++) pre[i + 1] = pre[i] + has[i];
    const need = Math.ceil((runL + 1) * 0.8);
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const left = pre[i + 1] - pre[Math.max(0, i - runL)];
      const right = pre[Math.min(len, i + runL + 1)] - pre[i];
      out[i] = left >= need || right >= need ? 1 : 0;
    }
    return out;
  };
  // visV[k][y]: vertical line k visible at row y; visH[k][x]: horizontal line k visible at column x.
  const visV = pathV.map((path) => {
    const v = new Uint8Array(h);
    for (let y = 0; y < h; y++) {
      const x0 = Math.round(path[y]);
      let any = 0;
      for (let dy = -1; dy <= 1 && !any; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let x = Math.max(0, x0 - band); x <= Math.min(w - 1, x0 + band); x++) if (line[yy * w + x]) { any = 1; break; }
      }
      v[y] = any;
    }
    return continuous(v);
  });
  const visH = pathH.map((path) => {
    const v = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const y0 = Math.round(path[x]);
      let any = 0;
      for (let dx = -1; dx <= 1 && !any; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        for (let y = Math.max(0, y0 - band); y <= Math.min(h - 1, y0 + band); y++) if (line[y * w + xx]) { any = 1; break; }
      }
      v[x] = any;
    }
    return continuous(v);
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
  /**
   * How sure we are that (x, y) is paper (possibly shadowed): 2 = the grid is visible on all four
   * sides; 1 = visible on at least one side each way (paper, or an item's edge near paper);
   * 0 = hidden.
   */
  /**
   * 3 = hidden on all four sides (strong evidence of an item); 0 = hidden in one direction;
   * 1 = visible on at least one side each way (paper, or an item's edge); 2 = visible on all
   * four sides.
   */
  const classify = (x: number, y: number): 0 | 1 | 2 | 3 => {
    const ky = rowIdx[y], kx = colIdx[x];
    const up = ky >= 0 && visH[ky][x] === 1;
    const down = ky + 1 < ys.length && visH[ky + 1][x] === 1;
    const left = kx >= 0 && visV[kx][y] === 1;
    const right = kx + 1 < xs.length && visV[kx + 1][y] === 1;
    if (!up && !down && !left && !right) return 3;
    // (Lines visible both sides one way don't prove paper: a ruler's ticks look just like that.)
    if ((!up && !down) || (!left && !right)) return 0;
    return up && down && left && right ? 2 : 1;
  };
  /** True if (x, y) lies on a grid line that is visible there. */
  const onLine = (x: number, y: number): boolean => {
    const kx = colIdx[x], ky = rowIdx[y];
    for (const k of [kx, kx + 1]) if (k >= 0 && k < xs.length && visV[k][y] && Math.abs(pathV[k][y] - x) <= band) return true;
    for (const k of [ky, ky + 1]) if (k >= 0 && k < ys.length && visH[k][x] && Math.abs(pathH[k][x] - y) <= band) return true;
    return false;
  };
  /** Diagnostics: the four neighbouring lines' expected positions and visibility at (x, y). */
  const probe = (x: number, y: number) => {
    const ky = rowIdx[y], kx = colIdx[x];
    return { pathH: [pathH[ky]?.[x], pathH[ky + 1]?.[x]], pathV: [pathV[kx]?.[y], pathV[kx + 1]?.[y]], visH: [visH[ky]?.[x], visH[ky + 1]?.[x]], visV: [visV[kx]?.[y], visV[kx + 1]?.[y]] };
  };
  return { classify, onLine, probe };
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
  if (opts.maps) {
    opts.maps.dark = dark;
    opts.maps.chroma = chroma;
  }
  const line = new Float32Array(n); // 1 where a grid line is visible (in light or shadow)
  const bright = new Float32Array(n); // brightness relative to paper
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
      // Cyan lines (as designed): red dips while green and blue stay put.
      // (Reasonably bright with a clear red dip: dark bluish items must not match.)
      line[i] = mean > 0.3 && gb < 0.12 && nr / mean < 0.9 ? 1 : 0;
      bright[i] = Math.min(nr, ng, nb);
    }
  }
  // Lines of any colour (many printers print the grid grey or black): a thin stripe clearly
  // darker than the brightest paper right next to it. As a ratio it works the same in light and
  // in shadow, and it ignores dark areas (inside an item there's no bright paper nearby).
  const lineSide = new Float32Array(n).fill(-1);
  const ridge = gridLineMask(bright, w, h, ppm, 0.86, 0.3, lineSide);
  for (let i = 0; i < n; i++) if (!line[i] && !ignored[i] && ridge[i] && chroma[i] < 0.15) line[i] = 1;


  const onPaper = opts.grid ? gridVisibility(line, w, h, ppm, opts.grid) : null;
  if (opts.debug) {
    opts.debug.line = line;
    opts.debug.gridFound = !!onPaper;
    opts.debug.probe = onPaper?.probe;
    if (onPaper) {
      const paper = new Uint8Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) paper[y * w + x] = onPaper.classify(x, y);
      opts.debug.paper = paper;
    }
  }

  // With the grid visible, estimate the local paper brightness (shadows included) from spots that
  // are certainly paper, and judge everything else against it rather than against lit paper.
  let state: Uint8Array | null = null;
  let illum: ((x: number, y: number) => number) | null = null;
  if (onPaper) {
    state = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) state[y * w + x] = onPaper.classify(x, y);
    // Paper brightness samples: certain-paper pixels, plus the paper right beside every visible
    // grid line (lines stay visible in shadow right up to an item's edge).
    // Beside a line, take the dimmer side: where a line runs along a shadow's edge, the lit side
    // would make the shadow look darker than its paper.
    const sample = new Float32Array(n).fill(-1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (ignored[i]) continue;
        if (line[i]) {
          if (!onPaper.onLine(x, y) || lineSide[i] < 0) continue;
          const side = lineSide[i];
          sample[i] = side;
          // The paper within ~1 mm of a visible line is paper too: sample it where its brightness
          // agrees with the line's paper (so an item touching the line isn't included).
          const r = Math.max(2, Math.round(ppm * 0.9));
          for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
            for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) {
              const j = yy * w + xx;
              if (line[j] || ignored[j] || sample[j] >= 0) continue;
              const v = 1 - dark[j];
              if (v >= side * 0.9 && v <= side * 1.12) sample[j] = v;
            }
        } else if (state[i] === 2 && sample[i] < 0) sample[i] = 1 - dark[i];
      }
    const cell = Math.max(3, Math.round(1.5 * ppm));
    const first = illuminationMap(sample, w, h, cell);
    // Second pass: drop samples much darker than the map around them (texture on an item that
    // slipped through), then rebuild.
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (sample[i] >= 0 && sample[i] < 0.8 * first(x, y)) sample[i] = -1;
      }
    illum = illuminationMap(sample, w, h, cell);

  }

  const ink = new Float32Array(n);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (ignored[i]) continue;
      const d = dark[i];
      const colourInk = Math.min(1, chroma[i] * 2);
      let neutralInk: number;
      if (d > 0.7) neutralInk = d; // nearly black: always an item
      else if (state && illum) {
        // Darkness (or brightness, e.g. shiny steel) relative to the paper around it.
        const rel = 1 - (1 - d) / illum(x, y);
        const st = state[i];
        if (opts.maps) (opts.maps.rel ??= new Float32Array(n))[i] = rel;
        if (opts.debug) {
          (opts.debug.rel ??= new Float32Array(n))[i] = rel;
          (opts.debug.illum ??= new Float32Array(n))[i] = illum(x, y);
        }
        // Pixels on a visible grid line are darker than paper by design; never count them as item
        // evidence (otherwise lines running up to an item would stick out of it as spikes). Line-
        // like texture on an item (a ridged grip, print) isn't on a visible grid line, so it counts.
        if (line[i] && st > 0 && onPaper!.onLine(x, y)) neutralInk = d * 0.3;
        // Clearly darker than the paper around it: an item, even if line-like texture on it (a
        // ridged grip, a ruler's ticks) fooled the grid check.
        else if (rel > 0.4) neutralInk = Math.max(d, rel);
        else if (st === 2) neutralInk = d * 0.3; // grid visible all round: paper, maybe in shadow
        else if (st === 1) {
          // Near an item's edge: paper if it matches the local paper, otherwise item.
          neutralInk = d * 0.3;
          if (opts.hidden && (rel > 0.3 || rel < -0.35 || chroma[i] > 0.08)) opts.hidden[i] = 1;
        } else {
          neutralInk = Math.max(0, rel);
          // The grid is hidden here: an item if it differs from the paper around it. Hidden on all
          // four sides is strong evidence, so even a pale item barely darker than lit paper counts.
          const strong = st === 3 && (Math.abs(rel) > 0.04 || d > 0.08);
          if (opts.hidden && (strong || rel > 0.06 || rel < -0.25 || chroma[i] > 0.05)) opts.hidden[i] = 1;
        }
      } else neutralInk = d > shadowLevel ? d : d * 0.3;
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
  const hidden = new Uint8Array(w * h);
  const maps: { dark?: Float32Array; chroma?: Float32Array; rel?: Float32Array } = {};
  const ink = inkMap(img, ignored, { ppm, shadowLevel: opts.shadowLevel, grid: opts.grid, hidden, maps });
  if (opts.grid && opts.method === 'grid') {
    // Where the grid is hidden is an item; plus anything clearly dark or coloured (an item small
    // enough to touch no grid line); outside the printed grid, fall back to brightness.
    const occ = gridOccupancy(img, ppm, opts.grid, ignored);
    const dark = maps.dark!, chroma = maps.chroma!, rel = maps.rel;
    for (let i = 0; i < w * h; i++) {
      const v = occ.value[i];
      const strong = dark[i] > 0.7 || (chroma[i] > 0.15 && !occ.line[i]);
      let item = v >= 0.5;
      // Between the points where an edge crosses grid lines the shape is interpolated; there, let
      // the image decide: clearly unlike the local paper is item, clearly like it is paper.
      if (v > 0.12 && v < 0.88 && rel && !occ.line[i]) {
        const r = rel[i];
        if (r > 0.2 || r < -0.12 || chroma[i] > 0.08) item = true; // darker side needs more: shadows
        else if (Math.abs(r) < 0.05 && chroma[i] < 0.05) item = false;
      }
      hidden[i] = !ignored[i] && (item || strong || (v < 0 && ink[i] > opts.threshold)) ? 1 : 0;
      ink[i] = 0;
    }
  }
  // Hidden-grid evidence comes in solid patches on real items; drop isolated specks (e.g. where a
  // grid line meets a soft shadow edge) before using it.
  // (The grid method can leave line-wide spikes where a short stretch of line next to an item
  // reads as covered; a slightly larger radius removes those too.)
  const useGrid = !!opts.grid && opts.method === 'grid';
  const rSpeck = Math.max(1, Math.round(ppm * (useGrid ? 0.75 : 0.4)));
  const solidHidden = morph(morph(hidden, w, h, rSpeck, false), w, h, rSpeck, true);
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = !ignored[i] && (ink[i] > opts.threshold || solidHidden[i]) ? 1 : 0;
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
    const thinMm = Math.min(c.maxX - c.minX + 1, c.maxY - c.minY + 1) / ppm;
    if (c.area < minArea || thinMm < 2.5) {
      for (let y = c.minY; y <= c.maxY; y++)
        for (let x = c.minX; x <= c.maxX; x++) if (labels[y * w + x] === c.label) mask[y * w + x] = 0;
      continue;
    }
    const loops = traceLoops(labels, w, h, c.label)
      // Smooth away pixel steps and edge noise, then drop redundant points (~0.05 mm tolerance).
      .map((l) => simplifyClosed(smoothClosed(l, (opts.smoothMm ?? 2) * ppm, 0.5), Math.max(0.2, ppm * 0.05)))
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
