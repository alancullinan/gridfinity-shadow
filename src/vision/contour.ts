import type { Point } from '../sheet';

/**
 * Traces the boundaries of all pixels with labels[i] === label as closed loops along pixel
 * edges. Diagonally touching pixels are kept joined (8-connectivity). Coordinates are in pixel
 * units with (0,0) the top-left corner of the first pixel.
 */
export function traceLoops(labels: Int32Array, w: number, h: number, label: number): Point[][] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === label;
  const sx: number[] = [], sy: number[] = [], ex: number[] = [], ey: number[] = [];
  const out = new Map<number, number[]>();
  const V = (x: number, y: number) => y * (w + 1) + x;
  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const id = sx.length;
    sx.push(x0); sy.push(y0); ex.push(x1); ey.push(y1);
    const k = V(x0, y0);
    const list = out.get(k);
    if (list) list.push(id);
    else out.set(k, [id]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (labels[y * w + x] !== label) continue;
      if (!inside(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inside(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inside(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inside(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  const used = new Uint8Array(sx.length);
  const loops: Point[][] = [];
  for (let e0 = 0; e0 < sx.length; e0++) {
    if (used[e0]) continue;
    const loop: Point[] = [];
    let e = e0;
    while (!used[e]) {
      used[e] = 1;
      loop.push({ x: sx[e], y: sy[e] });
      const cands = out.get(V(ex[e], ey[e]))!.filter((c) => !used[c] || c === e0);
      if (cands.length === 0) break;
      let nextE = cands[0];
      if (cands.length > 1) {
        const dx1 = ex[e] - sx[e], dy1 = ey[e] - sy[e];
        for (const c of cands) {
          const dx2 = ex[c] - sx[c], dy2 = ey[c] - sy[c];
          if (dx1 * dy2 - dy1 * dx2 < 0) nextE = c;
        }
      }
      if (nextE === e0) break;
      e = nextE;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x)) / len;
}

function dpOpen(pts: Point[], eps: number): Point[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpDist(pts[k], pts[i], pts[j]);
      if (d > maxD) {
        maxD = d;
        idx = k;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Douglas–Peucker simplification of a closed polygon. */
export function simplifyClosed(pts: Point[], eps: number): Point[] {
  if (pts.length < 4) return pts.slice();
  // Split at the two points farthest apart so both halves are well conditioned.
  let far = 0, best = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = dpOpen(pts.slice(0, far + 1), eps);
  const b = dpOpen(pts.slice(far).concat([pts[0]]), eps);
  return a.slice(0, -1).concat(b.slice(0, -1));
}

/** Resamples a closed polygon at (roughly) equal spacing along its perimeter. */
export function resampleClosed(pts: Point[], spacing: number): Point[] {
  const n = pts.length;
  let perimeter = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    perimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const count = Math.max(8, Math.round(perimeter / spacing));
  const step = perimeter / count;
  const out: Point[] = [];
  let seg = 0, segStart = 0;
  let segLen = Math.hypot(pts[1 % n].x - pts[0].x, pts[1 % n].y - pts[0].y);
  for (let k = 0; k < count; k++) {
    const d = k * step;
    while (d > segStart + segLen && seg < n - 1) {
      segStart += segLen;
      seg++;
      const a = pts[seg], b = pts[(seg + 1) % n];
      segLen = Math.hypot(b.x - a.x, b.y - a.y);
    }
    const a = pts[seg], b = pts[(seg + 1) % n];
    const t = segLen > 0 ? Math.min(1, (d - segStart) / segLen) : 0;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/**
 * Smooths a closed outline: resample evenly, then apply a circular Gaussian filter.
 * Removes pixel staircase and edge noise; corners become rounded with radius ~sigma.
 * @param sigma smoothing strength in the same units as the points
 */
export function smoothClosed(pts: Point[], sigma: number, spacing: number): Point[] {
  if (sigma <= 0 || pts.length < 4) return pts.slice();
  const p = resampleClosed(pts, spacing);
  const n = p.length;
  const s = sigma / spacing; // sigma in samples
  const r = Math.min(Math.floor(n / 2) - 1, Math.ceil(3 * s));
  if (r < 1) return p;
  const kernel: number[] = [];
  let sum = 0;
  for (let k = -r; k <= r; k++) {
    const v = Math.exp(-(k * k) / (2 * s * s));
    kernel.push(v);
    sum += v;
  }
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0, y = 0;
    for (let k = -r; k <= r; k++) {
      const q = p[(((i + k) % n) + n) % n];
      const wgt = kernel[k + r];
      x += q.x * wgt;
      y += q.y * wgt;
    }
    out[i] = { x: x / sum, y: y / sum };
  }
  return out;
}
