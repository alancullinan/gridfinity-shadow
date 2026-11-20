/** Minimal RGBA image, structurally compatible with the browser's ImageData. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Luminance in 0..255 for every pixel. */
export function luminance(img: RGBAImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    out[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  }
  return out;
}

/** Box-filter area downscale so the longest side is at most maxDim. */
export function downscale(img: RGBAImage, maxDim: number): { img: RGBAImage; scale: number } {
  const s = Math.max(img.width, img.height) / maxDim;
  if (s <= 1) return { img, scale: 1 };
  const w = Math.round(img.width / s);
  const h = Math.round(img.height / s);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * s);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * s)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * s);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * s)));
      let r = 0, g = 0, b = 0, c = 0;
      for (let yy = y0; yy < y1; yy++) {
        let p = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, p += 4) {
          r += img.data[p];
          g += img.data[p + 1];
          b += img.data[p + 2];
          c++;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / c;
      out.data[o + 1] = g / c;
      out.data[o + 2] = b / c;
      out.data[o + 3] = 255;
    }
  }
  return { img: out, scale: img.width / w };
}

/** Mean filter over a (2r+1)² window using an integral image. */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s =
        integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

export interface Component {
  label: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
}

/** 8-connected component labelling of a binary mask. Labels start at 1. */
export function labelComponents(mask: Uint8Array, w: number, h: number): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const comps: Component[] = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = next++;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    const c: Component = { label, area: 0, minX: w, minY: h, maxX: 0, maxY: 0, cx: 0, cy: 0 };
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w, y = (p - x) / w;
      c.area++;
      c.cx += x;
      c.cy += y;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !labels[q]) {
            labels[q] = label;
            stack[sp++] = q;
          }
        }
      }
    }
    c.cx /= c.area;
    c.cy /= c.area;
    comps.push(c);
  }
  return { labels, comps };
}

/** Separable square erosion (op = min) or dilation (op = max) of a binary mask. */
export function morph(mask: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const target = dilate ? 1 : 0;
  // Horizontal pass using running counts.
  for (let y = 0; y < h; y++) {
    let count = 0;
    const row = y * w;
    for (let x = -r; x < w; x++) {
      const add = x + r;
      if (add < w && (mask[row + add] ? 1 : 0) === target) count++;
      const rem = x - r - 1;
      if (rem >= 0 && (mask[row + rem] ? 1 : 0) === target) count--;
      if (x >= 0) tmp[row + x] = dilate ? (count > 0 ? 1 : 0) : count > 0 ? 0 : 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h; y++) {
      const add = y + r;
      if (add < h && tmp[add * w + x] === target) count++;
      const rem = y - r - 1;
      if (rem >= 0 && tmp[rem * w + x] === target) count--;
      if (y >= 0) out[y * w + x] = dilate ? (count > 0 ? 1 : 0) : count > 0 ? 0 : 1;
    }
  }
  return out;
}

/** Fills enclosed holes: anything background not reachable from the border becomes foreground. */
export function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (p: number) => {
    if (!mask[p] && !outside[p]) {
      outside[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % w, y = (p - x) / w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (y > 0) push(p - w);
    if (y < h - 1) push(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

/**
 * Thin dark lines: pixels darker (by `ratio`) than the paper on both sides of them, within r
 * pixels, either left/right (a vertical line) or above/below (a horizontal line). Unlike a simple
 * "darker than nearby" test, an item's edge (paper on one side only) doesn't count.
 * @param minPaper the brighter sides must be at least this bright (same units as `bright`)
 */
export function ridgeMask(
  bright: Float32Array,
  w: number,
  h: number,
  r: number,
  ratio: number,
  minPaper: number,
  /** If given, receives the paper brightness beside each line pixel (the dimmer side). */
  sideOut?: Float32Array,
): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = bright[i];
      let l = 0, rt = 0, u = 0, d = 0;
      for (let k = 1; k <= r; k++) {
        if (x - k >= 0) l = Math.max(l, bright[i - k]);
        if (x + k < w) rt = Math.max(rt, bright[i + k]);
        if (y - k >= 0) u = Math.max(u, bright[i - k * w]);
        if (y + k < h) d = Math.max(d, bright[i + k * w]);
      }
      // A line has similar paper on both sides; an item's edge (paper on one side only) doesn't.
      const vOk = Math.min(l, rt) >= 0.7 * Math.max(l, rt), hOk = Math.min(u, d) >= 0.7 * Math.max(u, d);
      const vSide = vOk ? Math.min(l, rt) : 0, hSide = hOk ? Math.min(u, d) : 0;
      const side = Math.max(vSide, hSide);
      if (side > minPaper && b < side * ratio) {
        out[i] = 1;
        if (sideOut) {
          // A trustworthy paper sample only if both sides agree closely (not at a shadow's edge).
          const [p, q] = vSide >= hSide ? [l, rt] : [u, d];
          sideOut[i] = Math.min(p, q) >= 0.85 * Math.max(p, q) ? side : -1;
        }
      }
    }
  return out;
}
