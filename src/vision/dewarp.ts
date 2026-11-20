// Uses the printed grid as a dense calibration target. The four corner markers fix the
// perspective, but a sheet that isn't perfectly flat (curl, bowing) or a lens with some
// distortion still bends the grid by a few millimetres in the middle. This measures how far the
// grid lines actually are from where they should be across the sheet, fills in the parts hidden
// by items, and resamples the image so every line lands where it belongs. That keeps item
// measurements accurate everywhere and lets the shadow detection rely on exact line positions.
import { RGBAImage, createImage, ridgeMask } from './image';

export interface GridSpec {
  /** Line spacing in mm. */
  pitch: number;
  /** Position of one line from the image origin, mm. */
  offsetX: number;
  offsetY: number;
}

export interface DewarpResult {
  image: RGBAImage;
  /** Largest correction applied, in mm (for diagnostics). */
  maxShiftMm: number;
  /** Fraction of the sheet where the grid could be measured. */
  coverage: number;
  /** Displacement fields (pixels) on the coarse block grid, for diagnostics. */
  field?: { nx: number; ny: number; dx: Float32Array; dy: Float32Array; confX: Float32Array; confY: Float32Array; rawX: Float32Array; rawY: Float32Array };
}

/** Grid-line pixels for any line colour: thin stripes darker than the paper right next to them. */
export function lineMask(img: RGBAImage, ppm: number): Uint8Array {
  const { width: w, height: h, data } = img;
  const bright = new Float32Array(w * h);
  // The darkest channel dips for grey/black lines and for cyan ones (which remove red).
  for (let i = 0; i < w * h; i++) bright[i] = Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const ridge = ridgeMask(bright, w, h, Math.max(2, Math.round(ppm * 0.75)), 0.86, 50);
  for (let i = 0; i < w * h; i++) {
    if (!ridge[i]) continue;
    const R = data[i * 4], G = data[i * 4 + 1], B = data[i * 4 + 2];
    const grey = Math.max(R, G, B) - Math.min(R, G, B) < 0.18 * Math.max(40, Math.max(R, G, B));
    const cyan = R < 0.9 * ((G + B) / 2) && Math.abs(G - B) < 0.15 * Math.max(G, B);
    if (!grey && !cyan) ridge[i] = 0;
  }
  return ridge;
}

/**
 * Measures the grid's displacement field and returns a corrected image, or null if the grid
 * can't be seen well enough (the image is then best used as it is).
 */
export function dewarpByGrid(
  img: RGBAImage,
  ppm: number,
  grid: GridSpec,
  /** Areas to leave out of the measurement (e.g. the corner markers), mm from the image origin. */
  ignore: { x: number; y: number; w: number; h: number }[] = [],
): DewarpResult | null {
  const { width: w, height: h } = img;
  const line = lineMask(img, ppm);
  for (const z of ignore) {
    const pad = 2 * ppm;
    for (let y = Math.max(0, Math.floor(z.y * ppm - pad)); y < Math.min(h, Math.ceil((z.y + z.h) * ppm + pad)); y++)
      for (let x = Math.max(0, Math.floor(z.x * ppm - pad)); x < Math.min(w, Math.ceil((z.x + z.w) * ppm + pad)); x++) line[y * w + x] = 0;
  }
  const pitch = grid.pitch * ppm;
  const half = Math.floor(pitch / 2);
  const block = Math.round(pitch * 2); // measuring window (10 mm)
  const step = Math.round(pitch); // field resolution (5 mm)
  const nx = Math.floor((w - 1) / step) + 1, ny = Math.floor((h - 1) / step) + 1;
  const ox = ((grid.offsetX * ppm) % pitch + pitch) % pitch, oy = ((grid.offsetY * ppm) % pitch + pitch) % pitch;

  /**
   * For each block, the shift (−pitch/2 … pitch/2) of the actual lines from the expected ones,
   * and how clearly the lines show (0 = can't tell).
   */
  const measure = (vertical: boolean) => {
    const shift = new Float32Array(nx * ny), conf = new Float32Array(nx * ny);
    const prof = new Float32Array(block + 1);
    for (let by = 0; by < ny; by++)
      for (let bx = 0; bx < nx; bx++) {
        const cx = bx * step, cy = by * step;
        const x0 = Math.max(0, cx - block / 2), x1 = Math.min(w - 1, cx + block / 2);
        const y0 = Math.max(0, cy - block / 2), y1 = Math.min(h - 1, cy + block / 2);
        // Profile across the lines: column sums for vertical lines, row sums for horizontal.
        const a0 = vertical ? x0 : y0, a1 = vertical ? x1 : y1;
        const along = vertical ? y1 - y0 + 1 : x1 - x0 + 1;
        prof.fill(0);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (line[y * w + x]) prof[(vertical ? x : y) - a0]++;
        const origin = vertical ? ox : oy;
        let best = 0, bestScore = -1, total = 0;
        const scores: number[] = [];
        for (let s = -half; s < half; s++) {
          let score = 0, n = 0;
          for (let e = origin + Math.ceil((a0 - origin - s) / pitch) * pitch + s; e <= a1; e += pitch) {
            const q = Math.round(e) - a0;
            score += (prof[q] ?? 0) + 0.5 * ((prof[q - 1] ?? 0) + (prof[q + 1] ?? 0));
            n++;
          }
          score = n ? score / n : 0;
          scores.push(score);
          total += score;
          if (score > bestScore) (bestScore = score), (best = s);
        }
        const mean = total / scores.length;
        // Sub-pixel refinement: fit a parabola through the best score and its neighbours.
        const bi = best + half;
        if (bi > 0 && bi < scores.length - 1) {
          const l = scores[bi - 1], m = scores[bi], r = scores[bi + 1];
          const den = l - 2 * m + r;
          if (den < 0) best += Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
        }
        // Confident when the best phase stands out clearly and the lines run most of the window.
        const c = bestScore > along * 0.45 && bestScore > mean * 2.2 ? Math.min(1, bestScore / along) : 0;
        shift[by * nx + bx] = best;
        conf[by * nx + bx] = c;
      }
    return { shift, conf };
  };

  /**
   * Turns per-block shifts (only known up to whole grid squares) into a smooth field: unwrap from
   * the corners outwards (the markers make the corners exact), then fill hidden blocks.
   */
  const solve = ({ shift, conf }: { shift: Float32Array; conf: Float32Array }) => {
    const val = new Float32Array(nx * ny);
    const known = new Uint8Array(nx * ny);
    const queue: number[] = [];
    // Seeds: confident blocks nearest each corner, taken at their wrapped value (close to 0).
    for (const [sx, sy] of [[0, 0], [nx - 1, 0], [0, ny - 1], [nx - 1, ny - 1]]) {
      let bestI = -1, bestD = Infinity;
      for (let by = 0; by < ny; by++)
        for (let bx = 0; bx < nx; bx++) {
          const i = by * nx + bx;
          const d = Math.hypot(bx - sx, by - sy);
          if (conf[i] > 0 && d < bestD && d < 6) (bestD = d), (bestI = i);
        }
      if (bestI >= 0 && !known[bestI]) {
        val[bestI] = shift[bestI];
        known[bestI] = 1;
        queue.push(bestI);
      }
    }
    if (!queue.length) return null;
    // Breadth-first over confident blocks, picking the wrap closest to the neighbour.
    for (let qi = 0; qi < queue.length; qi++) {
      const i = queue[qi], bx = i % nx, by = (i - bx) / nx;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const j = y * nx + x;
        if (known[j] || conf[j] <= 0) continue;
        const k = Math.round((val[i] - shift[j]) / pitch);
        const v = shift[j] + k * pitch;
        if (Math.abs(v - val[i]) > pitch * 0.3) continue; // inconsistent: leave for filling
        val[j] = v;
        known[j] = 1;
        queue.push(j);
      }
    }
    const coverage = queue.length / (nx * ny);
    // Fill unknown blocks smoothly from their neighbours (Laplace relaxation).
    let fillStart = 0;
    for (let i = 0; i < nx * ny; i++) if (known[i]) fillStart += val[i];
    const avg = fillStart / queue.length;
    for (let i = 0; i < nx * ny; i++) if (!known[i]) val[i] = avg;
    for (let iter = 0; iter < 300; iter++) {
      for (let by = 0; by < ny; by++)
        for (let bx = 0; bx < nx; bx++) {
          const i = by * nx + bx;
          if (known[i]) continue;
          let s = 0, n = 0;
          if (bx > 0) (s += val[i - 1]), n++;
          if (bx < nx - 1) (s += val[i + 1]), n++;
          if (by > 0) (s += val[i - nx]), n++;
          if (by < ny - 1) (s += val[i + nx]), n++;
          val[i] = s / n;
        }
    }
    // Light smoothing to remove measurement jitter.
    const sm = new Float32Array(nx * ny);
    for (let by = 0; by < ny; by++)
      for (let bx = 0; bx < nx; bx++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = bx + dx, y = by + dy;
            if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
            s += val[y * nx + x];
            n++;
          }
        sm[by * nx + bx] = s / n;
      }
    return { field: sm, coverage };
  };

  const mX = measure(true), mY = measure(false);
  const fx = solve(mX);
  const fy = solve(mY);
  if (!fx || !fy || fx.coverage < 0.25 || fy.coverage < 0.25) return null;

  // Resample: the line expected at x actually sits at x + dx, so output(x, y) = input(x + dx, y + dy).
  const sampleField = (f: Float32Array, x: number, y: number) => {
    const gx = Math.min(nx - 1.001, x / step), gy = Math.min(ny - 1.001, y / step);
    const x0 = Math.floor(gx), y0 = Math.floor(gy), tx = gx - x0, ty = gy - y0;
    const a = f[y0 * nx + x0], b = f[y0 * nx + x0 + 1], c = f[(y0 + 1) * nx + x0], d = f[(y0 + 1) * nx + x0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
  // A correction bigger than half a grid square means the measurement went wrong somewhere.
  let peak = 0;
  for (let i = 0; i < nx * ny; i++) peak = Math.max(peak, Math.abs(fx.field[i]), Math.abs(fy.field[i]));
  if (peak > pitch * 0.9) return null;
  const out = createImage(w, h);
  const src = img.data;
  let maxShift = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = sampleField(fx.field, x, y), dy = sampleField(fy.field, x, y);
      maxShift = Math.max(maxShift, Math.hypot(dx, dy));
      const sx = Math.min(w - 1.001, Math.max(0, x + dx)), sy = Math.min(h - 1.001, Math.max(0, y + dy));
      const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => src[(yy * w + xx) * 4 + c];
        out.data[o + c] =
          (p(y0, x0) * (1 - tx) + p(y0, x0 + 1) * tx) * (1 - ty) + (p(y0 + 1, x0) * (1 - tx) + p(y0 + 1, x0 + 1) * tx) * ty;
      }
      out.data[o + 3] = 255;
    }
  return {
    image: out,
    maxShiftMm: maxShift / ppm,
    coverage: Math.min(fx.coverage, fy.coverage),
    field: { nx, ny, dx: fx.field, dy: fy.field, confX: mX.conf, confY: mY.conf, rawX: mX.shift, rawY: mY.shift },
  };
}
