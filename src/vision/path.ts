// Editable closed outlines: nodes joined by cubic Bézier segments. A corner node has its handles
// on the node (straight segments either side unless the neighbour curves); a smooth node has
// handles on a common line, so the curve passes through it without a kink.
import type { Point } from '../sheet';
import { simplifyClosed } from './contour';

export interface PathNode {
  x: number;
  y: number;
  smooth: boolean;
  /** Incoming and outgoing handle positions (absolute, mm). */
  inX: number;
  inY: number;
  outX: number;
  outY: number;
}

const node = (x: number, y: number, smooth = false): PathNode => ({ x, y, smooth, inX: x, inY: y, outX: x, outY: y });
const prevI = (n: number, i: number) => (i - 1 + n) % n;
const nextI = (n: number, i: number) => (i + 1) % n;

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** The four control points of segment i (from node i to node i+1). */
export function segment(nodes: PathNode[], i: number): [Point, Point, Point, Point] {
  const a = nodes[i], b = nodes[nextI(nodes.length, i)];
  return [{ x: a.x, y: a.y }, { x: a.outX, y: a.outY }, { x: b.inX, y: b.inY }, { x: b.x, y: b.y }];
}

/** Polygon approximating the path, with points about `step` mm apart along curves. */
export function flatten(nodes: PathNode[], step = 0.4): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const [p0, p1, p2, p3] = segment(nodes, i);
    const straight = p1.x === p0.x && p1.y === p0.y && p2.x === p3.x && p2.y === p3.y;
    const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const n = straight ? 1 : Math.max(2, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push(cubic(p0, p1, p2, p3, k / n));
  }
  return out;
}

/** Gives node i handles along the line through its neighbours (Catmull-Rom style). */
export function autoSmooth(nodes: PathNode[], i: number) {
  const n = nodes.length;
  const p = nodes[i], a = nodes[prevI(n, i)], b = nodes[nextI(n, i)];
  let tx = b.x - a.x, ty = b.y - a.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const dIn = Math.hypot(p.x - a.x, p.y - a.y) / 3, dOut = Math.hypot(b.x - p.x, b.y - p.y) / 3;
  p.smooth = true;
  p.inX = p.x - tx * dIn;
  p.inY = p.y - ty * dIn;
  p.outX = p.x + tx * dOut;
  p.outY = p.y + ty * dOut;
}

export function makeCorner(nodes: PathNode[], i: number) {
  const p = nodes[i];
  p.smooth = false;
  p.inX = p.outX = p.x;
  p.inY = p.outY = p.y;
}

/**
 * Turns a traced polygon into a compact editable path: the polygon is simplified (to within
 * `tolerance` mm), gentle bends become smooth nodes and sharp ones corners.
 */
export function pathFromPolygon(points: Point[], tolerance = 0.4): PathNode[] {
  let pts = simplifyClosed(points, tolerance);
  if (pts.length < 3) pts = points.slice(0, Math.max(3, points.length));
  const nodes = pts.map((p) => node(p.x, p.y));
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[prevI(n, i)], p = nodes[i], b = nodes[nextI(n, i)];
    const a1 = Math.atan2(p.y - a.y, p.x - a.x), a2 = Math.atan2(b.y - p.y, b.x - p.x);
    let turn = Math.abs(a2 - a1);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    if (turn < (40 * Math.PI) / 180) autoSmooth(nodes, i);
  }
  return nodes;
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): PathNode[] {
  const [l, r] = x0 < x1 ? [x0, x1] : [x1, x0], [t, b] = y0 < y1 ? [y0, y1] : [y1, y0];
  return [node(l, t), node(r, t), node(r, b), node(l, b)];
}

export function circlePath(cx: number, cy: number, r: number): PathNode[] {
  const k = 0.5523 * r;
  return [
    { x: cx + r, y: cy, smooth: true, inX: cx + r, inY: cy - k, outX: cx + r, outY: cy + k },
    { x: cx, y: cy + r, smooth: true, inX: cx + k, inY: cy + r, outX: cx - k, outY: cy + r },
    { x: cx - r, y: cy, smooth: true, inX: cx - r, inY: cy + k, outX: cx - r, outY: cy - k },
    { x: cx, y: cy - r, smooth: true, inX: cx - k, inY: cy - r, outX: cx + k, outY: cy - r },
  ];
}

/** Closest point on the path: segment index, parameter and distance. */
export function nearestOnPath(nodes: PathNode[], p: Point): { seg: number; t: number; dist: number; point: Point } {
  let best = { seg: 0, t: 0, dist: Infinity, point: p };
  for (let i = 0; i < nodes.length; i++) {
    const [p0, p1, p2, p3] = segment(nodes, i);
    const n = 40;
    for (let k = 0; k <= n; k++) {
      const q = cubic(p0, p1, p2, p3, k / n);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < best.dist) best = { seg: i, t: k / n, dist: d, point: q };
    }
  }
  return best;
}

/** Inserts a node on segment `seg` at parameter t without changing the curve's shape. */
export function splitSegment(nodes: PathNode[], seg: number, t: number): number {
  const n = nodes.length;
  const a = nodes[seg], b = nodes[nextI(n, seg)];
  const [p0, p1, p2, p3] = segment(nodes, seg);
  const lerp = (u: Point, v: Point) => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t });
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2), s = lerp(r0, r1);
  const straight = p1.x === p0.x && p1.y === p0.y && p2.x === p3.x && p2.y === p3.y;
  a.outX = q0.x;
  a.outY = q0.y;
  b.inX = q2.x;
  b.inY = q2.y;
  const mid: PathNode = straight
    ? node(s.x, s.y)
    : { x: s.x, y: s.y, smooth: true, inX: r0.x, inY: r0.y, outX: r1.x, outY: r1.y };
  if (straight) {
    a.outX = a.x;
    a.outY = a.y;
    b.inX = b.x;
    b.inY = b.y;
  }
  nodes.splice(seg + 1, 0, mid);
  return seg + 1;
}

/** Moves a node, carrying its handles with it. */
export function moveNode(nd: PathNode, x: number, y: number) {
  const dx = x - nd.x, dy = y - nd.y;
  nd.x = x;
  nd.y = y;
  nd.inX += dx;
  nd.inY += dy;
  nd.outX += dx;
  nd.outY += dy;
}

/** Moves one handle; a smooth node keeps the other handle opposite (keeping its length). */
export function moveHandle(nd: PathNode, which: 'in' | 'out', x: number, y: number) {
  if (which === 'in') {
    nd.inX = x;
    nd.inY = y;
  } else {
    nd.outX = x;
    nd.outY = y;
  }
  if (!nd.smooth) return;
  const [ox, oy] = which === 'in' ? [nd.outX, nd.outY] : [nd.inX, nd.inY];
  const len = Math.hypot(ox - nd.x, oy - nd.y);
  const dx = nd.x - x, dy = nd.y - y, dl = Math.hypot(dx, dy) || 1;
  const nx = nd.x + (dx / dl) * len, ny = nd.y + (dy / dl) * len;
  if (which === 'in') {
    nd.outX = nx;
    nd.outY = ny;
  } else {
    nd.inX = nx;
    nd.inY = ny;
  }
}

export function translatePath(nodes: PathNode[], dx: number, dy: number) {
  for (const nd of nodes) moveNode(nd, nd.x + dx, nd.y + dy);
}

export function bboxOf(points: Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
}
