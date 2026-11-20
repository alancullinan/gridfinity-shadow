// Item detection from where the printed grid is hidden.
//
// Along every grid line we record, pixel by pixel, whether the line is visible or covered. An
// item covers the lines it lies on whatever its colour or shine, and a shadow doesn't, so this is
// robust to pale or polished items and to shadows. Inside each grid square, the four surrounding
// lines' covered/visible profiles are blended with a Coons patch (transfinite interpolation),
// which reproduces edges crossing the square exactly and interpolates diagonal edges smoothly
// between the precise points where they cross the lines.
import type { GridSpec } from './dewarp';
import type { RGBAImage } from './image';

export interface GridOccupancy {
  /** Per pixel: 0 = paper … 1 = item; −1 outside the printed grid. */
  value: Float32Array;
  /** Per pixel: 1 where a grid line is drawn and visible. */
  line: Uint8Array;
}

/** Removes runs of `value` shorter than `min` in a 0/1 array (in place). */
function dropShortRuns(a: Uint8Array, value: 0 | 1, min: number) {
  let start = -1;
  for (let i = 0; i <= a.length; i++) {
    const v = i < a.length ? a[i] : 255;
    if (v === value) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      // Only interior runs: a run touching the end of the line is kept as is.
      if (i - start < min && start > 0 && i < a.length) for (let k = start; k < i; k++) a[k] = value === 1 ? 0 : 1;
      start = -1;
    }
  }
}

/**
 * @param ignored pixels to treat as paper (corner markers etc.)
 */
export function gridOccupancy(img: RGBAImage, ppm: number, grid: GridSpec, ignored: Uint8Array): GridOccupancy {
  const { width: w, height: h } = img;
  const pitch = grid.pitch * ppm;
  const majorEvery = grid.majorEvery ?? 0;
  // Expected line positions (the image has been straightened, so they're exact to a pixel or so).
  const positions = (len: number, offsetMm: number) => {
    const out: { pos: number; major: boolean }[] = [];
    const first = offsetMm * ppm;
    let k0 = Math.ceil((0 - first) / pitch);
    for (let k = k0; first + k * pitch <= len - 1; k++) {
      const pos = first + k * pitch;
      if (pos >= 0) out.push({ pos, major: majorEvery > 1 && ((k % majorEvery) + majorEvery) % majorEvery === 0 });
    }
    return out;
  };
  const xs = positions(w, grid.offsetX), ys = positions(h, grid.offsetY);

  // Darkest channel: dips for grey, black and cyan lines alike.
  const bright = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) bright[i] = Math.min(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  const drawn = new Uint8Array(w * h); // visible line pixels, for the caller

  /**
   * Covered (1) / visible (0) along a line. The line counts as visible at a point if it's clearly
   * darker than the paper just beside it on the darker side: robust across shadow edges, while a
   * dark item running alongside (darker than the line) or over it reads as covered.
   */
  const occupancy = (p: { pos: number; major: boolean }, vertical: boolean) => {
    const len = vertical ? h : w;
    const across = vertical ? w : h;
    const hw = p.major ? Math.max(2, Math.round(0.6 * ppm)) : Math.max(1, Math.round(0.35 * ppm));
    const gap = Math.max(2, Math.round(0.6 * ppm));
    const c = Math.round(p.pos);
    const at = (t: number, q: number) => (vertical ? t * w + q : q * w + t);
    const occ = new Uint8Array(len);
    for (let t = 0; t < len; t++) {
      let lineV = Infinity, ign = false;
      for (let d = -hw; d <= hw; d++) {
        const q = c + d;
        if (q < 0 || q >= across) continue;
        const i = at(t, q);
        if (ignored[i]) ign = true;
        lineV = Math.min(lineV, bright[i]);
      }
      let sideA = 0, sideB = 0;
      for (let d = hw + 1; d <= hw + gap; d++) {
        if (c - d >= 0) sideA = Math.max(sideA, bright[at(t, c - d)]);
        if (c + d < across) sideB = Math.max(sideB, bright[at(t, c + d)]);
      }
      const side = Math.min(sideA, sideB);
      const visible = side > 35 && lineV < side * 0.86;
      if (visible) for (let d = -hw; d <= hw; d++) if (c + d >= 0 && c + d < across && bright[at(t, c + d)] < side * 0.86) drawn[at(t, c + d)] = 1;
      occ[t] = visible || ign ? 0 : 1;
    }
    // Short gaps in a visible line are noise; short visible bits inside a covered stretch are
    // line-like texture on the item (print, ticks).
    dropShortRuns(occ, 1, Math.max(2, Math.round(0.6 * ppm)));
    dropShortRuns(occ, 0, Math.max(3, Math.round(1.5 * ppm)));
    return occ;
  };
  const occH = ys.map((p) => occupancy(p, false));
  const occV = xs.map((p) => occupancy(p, true));

  // Index of the line at or before each row / column.
  const before = (len: number, ps: { pos: number }[]) => {
    const idx = new Int32Array(len).fill(-1);
    let k = -1;
    for (let q = 0; q < len; q++) {
      while (k + 1 < ps.length && ps[k + 1].pos <= q) k++;
      idx[q] = k;
    }
    return idx;
  };
  const rowK = before(h, ys), colK = before(w, xs);

  const value = new Float32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const k = rowK[y];
    if (k < 0 || k + 1 >= ys.length) continue;
    const y0 = ys[k].pos, y1 = ys[k + 1].pos;
    const s = (y - y0) / (y1 - y0);
    const T = occH[k], B = occH[k + 1];
    for (let x = 0; x < w; x++) {
      const j = colK[x];
      if (j < 0 || j + 1 >= xs.length) continue;
      const x0 = xs[j].pos, x1 = xs[j + 1].pos;
      const t = (x - x0) / (x1 - x0);
      const L = occV[j][y], R = occV[j + 1][y];
      const top = T[x], bottom = B[x];
      // Corners: where the lines cross (average of both lines' readings there).
      const xi0 = Math.round(x0), xi1 = Math.min(w - 1, Math.round(x1));
      const yi0 = Math.round(y0), yi1 = Math.min(h - 1, Math.round(y1));
      const c00 = (T[xi0] + occV[j][yi0]) / 2, c10 = (T[xi1] + occV[j + 1][yi0]) / 2;
      const c01 = (B[xi0] + occV[j][yi1]) / 2, c11 = (B[xi1] + occV[j + 1][yi1]) / 2;
      const coons =
        (1 - t) * L + t * R + (1 - s) * top + s * bottom -
        ((1 - t) * (1 - s) * c00 + t * (1 - s) * c10 + (1 - t) * s * c01 + t * s * c11);
      value[y * w + x] = Math.min(1, Math.max(0, coons));
    }
  }
  return { value, line: drawn };
}
