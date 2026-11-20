// Interactive top-down view on the Photo step: shows the straightened photo with the item
// outlines as editable curves, and lets you edit them or trace new ones (pen, rectangle, circle).
import type { Point } from '../sheet';
import { pointInLoops } from './layoutView';
import {
  PathNode,
  autoSmooth,
  bboxOf,
  circlePath,
  flatten,
  makeCorner,
  moveHandle,
  moveNode,
  nearestOnPath,
  rectPath,
  splitSegment,
  translatePath,
} from '../vision/path';
import { fmt } from '../ui/dom';

export type Tool = 'edit' | 'pen' | 'rect' | 'circle';

/** An outline on the Photo step, as the user sees and edits it. */
export interface TraceShape {
  id: number;
  /** One closed path per loop (outer outline and any holes), sheet mm. */
  paths: PathNode[][];
  /** The paths flattened to polygons (kept up to date by the host). */
  loops: Point[][];
  use: boolean;
}

export interface TraceHost<T extends TraceShape> {
  shapes(): T[];
  colour(s: T): string;
  /** Called once before a change, so it can be undone. */
  beginChange(): void;
  /** A shape's paths changed (call after every step of a drag). */
  shapeChanged(s: T, final: boolean): void;
  /** A new shape was drawn. */
  addShape(paths: PathNode[][]): T;
  removeShape(s: T): void;
  selectionChanged(id: number | null): void;
  toolChanged(t: Tool): void;
}

type Drag =
  | { kind: 'node'; loop: number; idx: number; started: boolean }
  | { kind: 'handle'; loop: number; idx: number; which: 'in' | 'out'; started: boolean }
  | { kind: 'shape'; last: Point; started: boolean }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number; moved: boolean }
  | { kind: 'pen'; sx: number; sy: number }
  | { kind: 'draw'; start: Point; now: Point };

const NODE_HIT = 9; // px
const SEG_HIT = 7;
const MIN_SHAPE = 2; // mm

export class TraceView<T extends TraceShape> {
  tool: Tool = 'edit';
  selected: number | null = null;
  /** The node being edited in the selected shape. */
  active: { loop: number; idx: number } | null = null;
  private ctx: CanvasRenderingContext2D;
  private image: HTMLCanvasElement | null = null;
  private origin: Point = { x: 0, y: 0 };
  private sizeMm = { w: 1, h: 1 };
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag: Drag | null = null;
  private pen: PathNode[] = [];
  private cursor: Point | null = null;
  private raf = 0;

  constructor(private canvas: HTMLCanvasElement, private host: TraceHost<T>) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.redraw()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.redraw();
    });
    canvas.addEventListener('dblclick', (e) => this.dblclick(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------------------------------------------------------------- public API
  setImage(img: HTMLCanvasElement, origin: Point, ppm: number) {
    const sizeChanged = !this.image || img.width !== this.image.width || img.height !== this.image.height;
    this.image = img;
    this.origin = origin;
    this.sizeMm = { w: img.width / ppm, h: img.height / ppm };
    if (sizeChanged) this.fit();
    this.redraw();
  }

  fit() {
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.redraw();
  }

  zoomBy(f: number, about?: { x: number; y: number }) {
    const r = this.canvas.getBoundingClientRect();
    const sx = about?.x ?? r.width / 2, sy = about?.y ?? r.height / 2;
    const m = this.toMm(sx, sy);
    this.zoom = Math.min(40, Math.max(0.5, this.zoom * f));
    this.layout();
    this.panX = sx - (m.x - this.origin.x) * this.scale - (r.width - this.sizeMm.w * this.scale) / 2;
    this.panY = sy - (m.y - this.origin.y) * this.scale - (r.height - this.sizeMm.h * this.scale) / 2;
    this.redraw();
  }

  setTool(t: Tool) {
    if (this.pen.length) this.finishPen(false);
    this.tool = t;
    this.canvas.style.cursor = t === 'edit' ? 'default' : 'crosshair';
    this.host.toolChanged(t);
    this.redraw();
  }

  select(id: number | null) {
    if (this.selected === id) return;
    this.selected = id;
    this.active = null;
    this.host.selectionChanged(id);
    this.redraw();
  }

  /** Converts a point in sheet mm to client coordinates (for tests). */
  clientPoint(x: number, y: number) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.toScreen({ x, y });
    return { x: r.left + s.x, y: r.top + s.y };
  }

  /** Keyboard handling; returns true if the key was used. */
  key(e: KeyboardEvent): boolean {
    if (this.tool === 'pen' && this.pen.length) {
      if (e.key === 'Enter') return this.finishPen(true), true;
      if (e.key === 'Escape') return this.finishPen(false), true;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        this.pen.pop();
        this.redraw();
        return true;
      }
    }
    const shape = this.selectedShape();
    switch (e.key) {
      case 'Escape':
        if (this.tool !== 'edit') this.setTool('edit');
        else if (this.active) (this.active = null), this.redraw();
        else if (shape) this.select(null);
        else return false;
        return true;
      case 'Delete':
      case 'Backspace':
        if (!shape) return false;
        this.host.beginChange();
        if (this.active) this.deleteNode(shape, this.active.loop, this.active.idx);
        else {
          this.host.removeShape(shape);
          this.select(null);
        }
        return true;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        if (!shape) return false;
        const step = e.shiftKey ? 2 : 0.25;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        this.host.beginChange();
        if (this.active) {
          const nd = shape.paths[this.active.loop][this.active.idx];
          moveNode(nd, nd.x + dx, nd.y + dy);
        } else for (const p of shape.paths) translatePath(p, dx, dy);
        this.host.shapeChanged(shape, true);
        this.redraw();
        return true;
      }
      case 'v':
      case 'V':
        return this.setTool('edit'), true;
      case 'p':
      case 'P':
        return this.setTool('pen'), true;
      case 'r':
      case 'R':
        return this.setTool('rect'), true;
      case 'c':
      case 'C':
        return this.setTool('circle'), true;
      case 'f':
      case 'F':
        return this.fit(), true;
      case '+':
      case '=':
        return this.zoomBy(1.25), true;
      case '-':
        return this.zoomBy(0.8), true;
    }
    return false;
  }

  redraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  // ---------------------------------------------------------------- geometry
  private layout() {
    const r = this.canvas.getBoundingClientRect();
    const base = Math.min(r.width / this.sizeMm.w, r.height / this.sizeMm.h) * 0.96;
    this.scale = Math.max(0.01, base * this.zoom);
    this.ox = (r.width - this.sizeMm.w * this.scale) / 2 + this.panX;
    this.oy = (r.height - this.sizeMm.h * this.scale) / 2 + this.panY;
  }
  private toScreen(p: Point) {
    return { x: this.ox + (p.x - this.origin.x) * this.scale, y: this.oy + (p.y - this.origin.y) * this.scale };
  }
  private toMm(sx: number, sy: number): Point {
    return { x: (sx - this.ox) / this.scale + this.origin.x, y: (sy - this.oy) / this.scale + this.origin.y };
  }
  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private selectedShape(): T | null {
    return this.host.shapes().find((s) => s.id === this.selected) ?? null;
  }
  private dist(a: Point, sx: number, sy: number) {
    const s = this.toScreen(a);
    return Math.hypot(s.x - sx, s.y - sy);
  }

  /** Handles shown (and draggable) on the selected shape: those of the active node and its neighbours. */
  private visibleHandles(shape: T) {
    const out: { loop: number; idx: number; which: 'in' | 'out' }[] = [];
    if (!this.active) return out;
    const path = shape.paths[this.active.loop];
    if (!path) return out;
    const n = path.length, i = this.active.idx;
    const add = (idx: number, which: 'in' | 'out') => {
      const nd = path[idx];
      const hx = which === 'in' ? nd.inX : nd.outX, hy = which === 'in' ? nd.inY : nd.outY;
      if (hx !== nd.x || hy !== nd.y) out.push({ loop: this.active!.loop, idx, which });
    };
    add(i, 'in');
    add(i, 'out');
    add((i - 1 + n) % n, 'out');
    add((i + 1) % n, 'in');
    return out;
  }

  private hitNode(shape: T, sx: number, sy: number) {
    let best: { loop: number; idx: number } | null = null, bestD = NODE_HIT;
    shape.paths.forEach((path, loop) =>
      path.forEach((nd, idx) => {
        const d = this.dist(nd, sx, sy);
        if (d < bestD) (bestD = d), (best = { loop, idx });
      }),
    );
    return best as { loop: number; idx: number } | null;
  }

  private hitHandle(shape: T, sx: number, sy: number) {
    for (const h of this.visibleHandles(shape)) {
      const nd = shape.paths[h.loop][h.idx];
      const p = h.which === 'in' ? { x: nd.inX, y: nd.inY } : { x: nd.outX, y: nd.outY };
      if (this.dist(p, sx, sy) < NODE_HIT) return h;
    }
    return null;
  }

  private hitSegment(shape: T, sx: number, sy: number) {
    const m = this.toMm(sx, sy);
    let best: { loop: number; seg: number; t: number } | null = null, bestD = SEG_HIT / this.scale;
    shape.paths.forEach((path, loop) => {
      const r = nearestOnPath(path, m);
      if (r.dist < bestD) (bestD = r.dist), (best = { loop, seg: r.seg, t: r.t });
    });
    return best as { loop: number; seg: number; t: number } | null;
  }

  private shapeAt(sx: number, sy: number): T | null {
    const m = this.toMm(sx, sy);
    const shapes = this.host.shapes();
    // The selected shape first (it's drawn on top), then the smallest one containing the point.
    const sel = this.selectedShape();
    if (sel && (pointInLoops(m, sel.loops) || this.hitSegment(sel, sx, sy))) return sel;
    let best: T | null = null, bestA = Infinity;
    for (const s of shapes) {
      if (!pointInLoops(m, s.loops) && !s.paths.some((p) => nearestOnPath(p, m).dist < SEG_HIT / this.scale)) continue;
      const b = bboxOf(s.loops.flat());
      if (b.w * b.h < bestA) (bestA = b.w * b.h), (best = s);
    }
    return best;
  }

  private deleteNode(shape: T, loop: number, idx: number) {
    const path = shape.paths[loop];
    if (path.length > 3) {
      path.splice(idx, 1);
      this.active = null;
      this.host.shapeChanged(shape, true);
    } else if (shape.paths.length > 1) {
      shape.paths.splice(loop, 1);
      this.active = null;
      this.host.shapeChanged(shape, true);
    } else {
      this.host.removeShape(shape);
      this.select(null);
    }
    this.redraw();
  }

  // ---------------------------------------------------------------- pointer
  private down(e: PointerEvent) {
    if (!this.image) return;
    const { x: sx, y: sy } = this.local(e);
    this.canvas.setPointerCapture(e.pointerId);
    // Middle or right button, or Space held: pan with any tool.
    if (e.button === 1 || e.button === 2) {
      this.drag = { kind: 'pan', sx, sy, px: this.panX, py: this.panY, moved: true };
      return;
    }
    const m = this.toMm(sx, sy);
    if (this.tool === 'pen') {
      if (this.pen.length >= 3 && this.dist(this.pen[0], sx, sy) < NODE_HIT + 2) return this.finishPen(true);
      this.pen.push({ x: m.x, y: m.y, smooth: false, inX: m.x, inY: m.y, outX: m.x, outY: m.y });
      this.drag = { kind: 'pen', sx, sy };
      this.redraw();
      return;
    }
    if (this.tool === 'rect' || this.tool === 'circle') {
      this.drag = { kind: 'draw', start: m, now: m };
      return;
    }
    const sel = this.selectedShape();
    if (sel) {
      const h = this.hitHandle(sel, sx, sy);
      if (h) return void (this.drag = { kind: 'handle', ...h, started: false });
      const n = this.hitNode(sel, sx, sy);
      if (n) {
        this.active = n;
        this.drag = { kind: 'node', ...n, started: false };
        this.redraw();
        return;
      }
    }
    const shape = this.shapeAt(sx, sy);
    if (shape) {
      if (shape.id !== this.selected) this.select(shape.id);
      else if (this.active) (this.active = null), this.redraw();
      this.drag = { kind: 'shape', last: m, started: false };
      return;
    }
    this.drag = { kind: 'pan', sx, sy, px: this.panX, py: this.panY, moved: false };
  }

  private move(e: PointerEvent) {
    const { x: sx, y: sy } = this.local(e);
    const m = this.toMm(sx, sy);
    this.cursor = m;
    const d = this.drag;
    if (!d) {
      this.hover(sx, sy);
      if (this.tool !== 'edit') this.redraw();
      return;
    }
    const shape = this.selectedShape();
    switch (d.kind) {
      case 'pan':
        if (!d.moved && Math.hypot(sx - d.sx, sy - d.sy) < 3) return;
        d.moved = true;
        this.panX = d.px + sx - d.sx;
        this.panY = d.py + sy - d.sy;
        this.canvas.style.cursor = 'grabbing';
        break;
      case 'pen': {
        const nd = this.pen[this.pen.length - 1];
        if (Math.hypot(sx - d.sx, sy - d.sy) < 4) return;
        // Dragging out from a new node gives it curve handles.
        nd.smooth = true;
        nd.outX = m.x;
        nd.outY = m.y;
        nd.inX = 2 * nd.x - m.x;
        nd.inY = 2 * nd.y - m.y;
        break;
      }
      case 'draw':
        d.now = m;
        break;
      case 'node':
      case 'handle':
      case 'shape': {
        if (!shape) return;
        if (!d.started) {
          this.host.beginChange();
          d.started = true;
        }
        if (d.kind === 'node') moveNode(shape.paths[d.loop][d.idx], m.x, m.y);
        else if (d.kind === 'handle') moveHandle(shape.paths[d.loop][d.idx], d.which, m.x, m.y);
        else {
          for (const p of shape.paths) translatePath(p, m.x - d.last.x, m.y - d.last.y);
          d.last = m;
        }
        this.host.shapeChanged(shape, false);
        break;
      }
    }
    this.redraw();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.kind === 'pan') {
      this.canvas.style.cursor = this.tool === 'edit' ? 'default' : 'crosshair';
      if (!d.moved && this.tool === 'edit') this.select(null); // a click on empty paper
    } else if (d.kind === 'draw') {
      const { start: a, now: b } = d;
      let paths: PathNode[][] | null = null;
      if (this.tool === 'rect' && Math.abs(b.x - a.x) >= MIN_SHAPE && Math.abs(b.y - a.y) >= MIN_SHAPE)
        paths = [rectPath(a.x, a.y, b.x, b.y)];
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      if (this.tool === 'circle' && r >= MIN_SHAPE / 2) paths = [circlePath(a.x, a.y, r)];
      if (paths) {
        this.host.beginChange();
        const s = this.host.addShape(paths);
        this.tool = 'edit';
        this.canvas.style.cursor = 'default';
        this.host.toolChanged('edit');
        this.select(s.id);
      }
    } else if ((d.kind === 'node' || d.kind === 'handle' || d.kind === 'shape') && d.started) {
      const shape = this.selectedShape();
      if (shape) this.host.shapeChanged(shape, true);
    }
    this.redraw();
  }

  private dblclick(e: MouseEvent) {
    const { x: sx, y: sy } = this.local(e);
    if (this.tool === 'pen') {
      // The double-click's two clicks each placed a node: drop the duplicate and close.
      const n = this.pen.length;
      if (n >= 2 && Math.hypot(this.pen[n - 1].x - this.pen[n - 2].x, this.pen[n - 1].y - this.pen[n - 2].y) * this.scale < 6) this.pen.pop();
      this.finishPen(true);
      return;
    }
    if (this.tool !== 'edit') return;
    const shape = this.selectedShape();
    if (!shape) return;
    const n = this.hitNode(shape, sx, sy);
    if (n) {
      // Toggle corner / smooth.
      this.host.beginChange();
      const path = shape.paths[n.loop];
      if (path[n.idx].smooth) makeCorner(path, n.idx);
      else autoSmooth(path, n.idx);
      this.active = n;
      this.host.shapeChanged(shape, true);
      this.redraw();
      return;
    }
    const seg = this.hitSegment(shape, sx, sy);
    if (seg) {
      this.host.beginChange();
      const idx = splitSegment(shape.paths[seg.loop], seg.seg, Math.min(0.98, Math.max(0.02, seg.t)));
      this.active = { loop: seg.loop, idx };
      this.host.shapeChanged(shape, true);
      this.redraw();
    }
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    this.zoomBy(f, this.local(e));
  }

  private hover(sx: number, sy: number) {
    if (this.tool !== 'edit') return;
    const sel = this.selectedShape();
    let cur = 'default';
    if (sel && (this.hitHandle(sel, sx, sy) || this.hitNode(sel, sx, sy))) cur = 'pointer';
    else if (this.shapeAt(sx, sy)) cur = 'move';
    else cur = 'grab';
    this.canvas.style.cursor = cur;
  }

  private finishPen(close: boolean) {
    const nodes = this.pen;
    this.pen = [];
    this.drag = null;
    if (close && nodes.length >= 3) {
      this.host.beginChange();
      const s = this.host.addShape([nodes]);
      this.tool = 'edit';
      this.canvas.style.cursor = 'default';
      this.host.toolChanged('edit');
      this.select(s.id);
    }
    this.redraw();
  }

  // ---------------------------------------------------------------- drawing
  private tracePath(path: PathNode[], closed = true) {
    const ctx = this.ctx;
    const n = path.length;
    if (!n) return;
    const p0 = this.toScreen(path[0]);
    ctx.moveTo(p0.x, p0.y);
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = path[i], b = path[(i + 1) % n];
      const c1 = this.toScreen({ x: a.outX, y: a.outY }), c2 = this.toScreen({ x: b.inX, y: b.inY }), e = this.toScreen(b);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
    }
    if (closed) ctx.closePath();
  }

  private label(text: string, x: number, y: number, bg: string) {
    const ctx = this.ctx;
    ctx.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 20, 5);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y + 0.5);
  }

  private draw() {
    const c = this.canvas, ctx = this.ctx;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) (c.width = W), (c.height = H);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.image) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.layout();
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#2563eb';

    // The photo, slightly faded so the outlines stand out.
    const tl = this.toScreen(this.origin);
    ctx.imageSmoothingEnabled = this.scale < 8;
    ctx.drawImage(this.image, tl.x, tl.y, this.sizeMm.w * this.scale, this.sizeMm.h * this.scale);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(tl.x, tl.y, this.sizeMm.w * this.scale, this.sizeMm.h * this.scale);

    const shapes = this.host.shapes();
    const sel = this.selectedShape();
    shapes.forEach((s, i) => {
      const col = this.host.colour(s);
      ctx.beginPath();
      for (const p of s.paths) this.tracePath(p);
      ctx.fillStyle = col + (s.use ? (s === sel ? '30' : '44') : '14');
      ctx.fill('evenodd');
      ctx.setLineDash(s.use ? [] : [7, 5]);
      ctx.lineWidth = s === sel ? 1.5 : 2.25;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.setLineDash([]);
      if (s !== sel) {
        const b = bboxOf(s.loops.flat());
        const p = this.toScreen({ x: b.x, y: b.y });
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 11px ${getComputedStyle(document.body).fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(i + 1), p.x, p.y + 0.5);
      }
    });

    // The selected shape: nodes, handles and its size.
    if (sel) {
      const col = this.host.colour(sel);
      const b = bboxOf(sel.loops.flat());
      const t = this.toScreen({ x: b.x + b.w / 2, y: b.y });
      this.label(`${fmt(b.w)} × ${fmt(b.h)} mm`, t.x, Math.max(14, t.y - 16), col);
      for (const h of this.visibleHandles(sel)) {
        const nd = sel.paths[h.loop][h.idx];
        const p = this.toScreen(nd), q = this.toScreen(h.which === 'in' ? { x: nd.inX, y: nd.inY } : { x: nd.outX, y: nd.outY });
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(q.x, q.y);
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
      }
      sel.paths.forEach((path, loop) =>
        path.forEach((nd, idx) => {
          const p = this.toScreen(nd);
          const on = this.active?.loop === loop && this.active.idx === idx;
          const sz = on ? 5 : 3.75;
          ctx.beginPath();
          if (nd.smooth) ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
          else ctx.rect(p.x - sz, p.y - sz, sz * 2, sz * 2);
          ctx.fillStyle = on ? accent : '#fff';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = on ? '#fff' : col;
          ctx.stroke();
        }),
      );
    }

    // Tools in progress.
    const d = this.drag;
    if (this.tool === 'pen' && this.pen.length) {
      ctx.beginPath();
      this.tracePath(this.pen, false);
      const last = this.pen[this.pen.length - 1];
      if (this.cursor && d?.kind !== 'pen') {
        const a = this.toScreen({ x: last.outX, y: last.outY }), e = this.toScreen(this.cursor);
        ctx.quadraticCurveTo(a.x, a.y, e.x, e.y);
      }
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.75;
      ctx.stroke();
      this.pen.forEach((nd, i) => {
        const p = this.toScreen(nd);
        ctx.beginPath();
        ctx.arc(p.x, p.y, i === 0 ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? accent : '#fff';
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
      if (last.smooth) {
        const p = this.toScreen(last), q1 = this.toScreen({ x: last.inX, y: last.inY }), q2 = this.toScreen({ x: last.outX, y: last.outY });
        ctx.beginPath();
        ctx.moveTo(q1.x, q1.y);
        ctx.lineTo(q2.x, q2.y);
        ctx.lineWidth = 1;
        ctx.stroke();
        for (const q of [q1, q2]) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = accent;
          ctx.fill();
        }
        void p;
      }
      if (this.cursor && d?.kind !== 'pen') {
        const len = Math.hypot(this.cursor.x - last.x, this.cursor.y - last.y);
        const e = this.toScreen(this.cursor);
        this.label(`${fmt(len)} mm`, e.x, e.y - 22, accent);
      }
    }
    if (d?.kind === 'draw') {
      const a = d.start, b = d.now;
      ctx.beginPath();
      let text = '';
      if (this.tool === 'rect') {
        this.tracePath(rectPath(a.x, a.y, b.x, b.y));
        text = `${fmt(Math.abs(b.x - a.x))} × ${fmt(Math.abs(b.y - a.y))} mm`;
      } else {
        const rr = Math.hypot(b.x - a.x, b.y - a.y);
        this.tracePath(circlePath(a.x, a.y, rr));
        text = `Ø ${fmt(rr * 2)} mm`;
      }
      ctx.fillStyle = accent + '22';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.75;
      ctx.stroke();
      const e = this.toScreen(b);
      this.label(text, e.x, e.y - 22, accent);
    }
  }
}
