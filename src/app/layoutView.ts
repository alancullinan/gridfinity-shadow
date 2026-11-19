// Interactive top view of the bin: draws the design and handles selection, dragging,
// rotation, notch and depth-zone handles, zoom and pan.
import type { Point } from '../sheet';
import {
  DepthZone,
  GF,
  Item,
  binOuterSize,
  clampToBin,
  nearestOnLoops,
  placedLoops,
  placedNotches,
  placedZone,
  toItemCoords,
  transformPoint,
  zoneHandle,
} from '../layout';
import { S, changed, colorOf, on, select, selectedItem } from './store';

type Drag =
  | { kind: 'item'; item: Item; start: Point; x0: number; y0: number }
  | { kind: 'rotate'; item: Item }
  | { kind: 'notch'; item: Item; index: number }
  | { kind: 'zone-move'; item: Item; zone: DepthZone; start: Point; x0: number; y0: number }
  | { kind: 'zone-resize'; item: Item; zone: DepthZone }
  | { kind: 'pan'; px0: number; py0: number };

export function pointInLoops(p: Point, loops: Point[][]): boolean {
  let inside = false;
  for (const l of loops)
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      if (l[i].y > p.y !== l[j].y > p.y && p.x < ((l[j].x - l[i].x) * (p.y - l[i].y)) / (l[j].y - l[i].y) + l[i].x)
        inside = !inside;
    }
  return inside;
}

/** Bounding box of an item's outline in its own coordinates. */
function localBox(it: Item) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of it.loops)
    for (const p of l) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  return { minX, minY, maxX, maxY };
}

export const normDeg = (d: number) => ((Math.round(d * 10) / 10) % 360 + 360) % 360;

export class LayoutView {
  private ctx: CanvasRenderingContext2D;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  /** screen (css px) = origin + mm * scale */
  private scale = 1;
  private ox = 0;
  private oy = 0;
  private drag: Drag | null = null;
  private down: { x: number; y: number; moved: boolean } | null = null;
  private raf = 0;
  private hoverItem: number | null = null;
  /** Rotation angle shown next to the handle while rotating. */
  private rotLabel: { p: Point; text: string } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    on('changed', () => this.draw());
    on('selection', () => this.draw());
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.draw());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => {
      if (!this.drag && this.hoverItem !== null) {
        this.hoverItem = null;
        this.draw();
      }
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', (e) => {
      if (!this.hitItem(this.toMm(e))) this.fit();
    });
  }

  fit() {
    this.zoom = 1;
    this.panX = this.panY = 0;
    this.draw();
  }

  draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.paint());
  }

  /** Client (page) coordinates of a layout point in mm; used by tests. */
  clientPoint(p: Point): Point {
    const b = this.canvas.getBoundingClientRect();
    return { x: b.left + this.ox + p.x * this.scale, y: b.top + this.oy + p.y * this.scale };
  }

  // ---------------------------------------------------------------- coordinates
  private toMm(e: { clientX: number; clientY: number }): Point {
    const b = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - b.left - this.ox) / this.scale, y: (e.clientY - b.top - this.oy) / this.scale };
  }
  private sx = (x: number) => this.ox + x * this.scale;
  private sy = (y: number) => this.oy + y * this.scale;

  private rotHandle(it: Item): { base: Point; handle: Point } {
    const b = localBox(it);
    const cx = (b.minX + b.maxX) / 2;
    return {
      base: transformPoint({ x: cx, y: b.minY }, it),
      handle: transformPoint({ x: cx, y: b.minY - 28 / this.scale }, it),
    };
  }

  private hitItem(p: Point): Item | null {
    for (let i = S.items.length - 1; i >= 0; i--) if (pointInLoops(p, placedLoops(S.items[i]))) return S.items[i];
    return null;
  }

  /** What a pointer at p would grab, in priority order. */
  private hitTest(p: Point): Drag | null {
    const tol = 9 / this.scale;
    const it = selectedItem();
    if (it) {
      const notches = placedNotches(it);
      for (let i = 0; i < notches.length; i++)
        if (Math.hypot(notches[i].x - p.x, notches[i].y - p.y) < tol) return { kind: 'notch', item: it, index: i };
      const { handle } = this.rotHandle(it);
      if (Math.hypot(handle.x - p.x, handle.y - p.y) < tol * 1.3) return { kind: 'rotate', item: it };
      if (S.sel.zone !== null && it.zones[S.sel.zone]) {
        const z = it.zones[S.sel.zone];
        const h = zoneHandle(it, z);
        if (Math.hypot(h.x - p.x, h.y - p.y) < tol) return { kind: 'zone-resize', item: it, zone: z };
        if (pointInLoops(p, [placedZone(it, z)]))
          return { kind: 'zone-move', item: it, zone: z, start: toItemCoords(p, it), x0: z.x, y0: z.y };
      }
    }
    const hit = this.hitItem(p);
    if (hit) return { kind: 'item', item: hit, start: p, x0: hit.x, y0: hit.y };
    return null;
  }

  // ---------------------------------------------------------------- pointer handling
  private onDown(e: PointerEvent) {
    if (e.button === 1 || e.button === 2) {
      if (e.button === 1) {
        e.preventDefault();
        this.drag = { kind: 'pan', px0: this.panX, py0: this.panY };
        this.down = { x: e.clientX, y: e.clientY, moved: false };
        this.canvas.setPointerCapture(e.pointerId);
      }
      return;
    }
    const p = this.toMm(e);
    this.down = { x: e.clientX, y: e.clientY, moved: false };
    const hit = this.hitTest(p);
    if (hit?.kind === 'item' && S.sel.item !== hit.item.id) select(hit.item.id, null);
    this.drag = hit ?? { kind: 'pan', px0: this.panX, py0: this.panY };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = this.drag.kind === 'pan' ? 'grabbing' : this.cursorFor(this.drag);
  }

  private onMove(e: PointerEvent) {
    const p = this.toMm(e);
    if (!this.drag || !this.down) {
      this.updateHover(p);
      return;
    }
    if (!this.down.moved && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 3) this.down.moved = true;
    if (!this.down.moved) return;
    const d = this.drag;
    switch (d.kind) {
      case 'pan':
        this.panX = d.px0 + (e.clientX - this.down.x);
        this.panY = d.py0 + (e.clientY - this.down.y);
        break;
      case 'item':
        d.item.x = d.x0 + p.x - d.start.x;
        d.item.y = d.y0 + p.y - d.start.y;
        clampToBin(d.item, S.settings); // the bin wall stops the item
        break;
      case 'rotate': {
        const raw = (Math.atan2(p.y - d.item.y, p.x - d.item.x) * 180) / Math.PI + 90;
        const snap = e.altKey ? 1 : e.shiftKey ? 15 : 5;
        d.item.rotation = normDeg(Math.round(raw / snap) * snap);
        this.rotLabel = { p, text: `${normDeg(d.item.rotation)}°` };
        break;
      }
      case 'notch':
        d.item.notches[d.index] = toItemCoords(nearestOnLoops(placedLoops(d.item), p), d.item);
        break;
      case 'zone-move': {
        const q = toItemCoords(p, d.item);
        d.zone.x = d.x0 + q.x - d.start.x;
        d.zone.y = d.y0 + q.y - d.start.y;
        break;
      }
      case 'zone-resize': {
        const l = toItemCoords(toItemCoords(p, d.item), d.zone);
        if (d.zone.kind === 'circle') d.zone.w = d.zone.h = Math.max(2, 2 * Math.hypot(l.x, l.y));
        else {
          d.zone.w = Math.max(2, 2 * Math.abs(l.x));
          d.zone.h = Math.max(2, 2 * Math.abs(l.y));
        }
        break;
      }
    }
    this.draw();
  }

  private onUp(e: PointerEvent) {
    const d = this.drag, down = this.down;
    this.drag = null;
    this.down = null;
    this.rotLabel = null;
    if (!d || !down) return;
    const p = this.toMm(e);
    if (!down.moved) {
      // A click (no drag): select.
      if (d.kind === 'pan') select(null);
      else if (d.kind === 'item') {
        // Clicking inside one of the selected item's zones selects that zone.
        const zi = [...d.item.zones.keys()].reverse().find((i) => pointInLoops(p, [placedZone(d.item, d.item.zones[i])]));
        select(d.item.id, zi ?? null);
      }
      this.updateHover(p);
      this.draw();
      return;
    }
    if (d.kind === 'pan') {
      this.updateHover(p);
      return;
    }
    changed({ refit: d.kind === 'item' || d.kind === 'rotate' || d.kind === 'notch' });
    this.updateHover(p);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const b = this.canvas.getBoundingClientRect();
    const mx = e.clientX - b.left, my = e.clientY - b.top;
    const before = { x: (mx - this.ox) / this.scale, y: (my - this.oy) / this.scale };
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
    this.zoom = Math.min(12, Math.max(0.3, this.zoom * factor));
    // Keep the point under the cursor fixed: recompute the transform, then adjust the pan.
    this.computeTransform();
    this.panX += mx - (this.ox + before.x * this.scale);
    this.panY += my - (this.oy + before.y * this.scale);
    this.draw();
  }

  private cursorFor(d: Drag | null): string {
    if (!d) return 'grab';
    return { item: 'move', rotate: 'grab', notch: 'ew-resize', 'zone-move': 'move', 'zone-resize': 'nwse-resize', pan: 'grab' }[d.kind];
  }

  private updateHover(p: Point) {
    const hit = this.hitTest(p);
    this.canvas.style.cursor = this.cursorFor(hit);
    const hoverId = hit?.kind === 'item' ? hit.item.id : null;
    if (hoverId !== this.hoverItem) {
      this.hoverItem = hoverId;
      this.draw();
    }
  }

  // ---------------------------------------------------------------- drawing
  private computeTransform() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const W = binOuterSize(S.settings.unitsX), D = binOuterSize(S.settings.unitsY);
    const pad = Math.min(64, Math.max(28, Math.min(cw, ch) * 0.09));
    const base = Math.max(0.05, Math.min((cw - 2 * pad) / W, (ch - 2 * pad) / D));
    this.scale = base * this.zoom;
    this.ox = cw / 2 + this.panX;
    this.oy = ch / 2 + this.panY;
  }

  private paint() {
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.computeTransform();
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const font = getComputedStyle(document.body).fontFamily;
    const { sx, sy, scale } = this;
    const s = S.settings;
    const W = binOuterSize(s.unitsX), D = binOuterSize(s.unitsY);

    ctx.fillStyle = v('--canvas-bg');
    ctx.fillRect(0, 0, cw, ch);

    // Dot grid (10 mm, coarser when zoomed out).
    let step = 10;
    while (step * scale < 14) step *= 5;
    ctx.fillStyle = v('--grid-dot');
    const x0 = Math.floor(-this.ox / scale / step) * step, x1 = (cw - this.ox) / scale;
    const y0 = Math.floor(-this.oy / scale / step) * step, y1 = (ch - this.oy) / scale;
    for (let gx = x0; gx <= x1; gx += step) for (let gy = y0; gy <= y1; gy += step) ctx.fillRect(sx(gx) - 0.75, sy(gy) - 0.75, 1.5, 1.5);

    // Bin.
    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.beginPath();
      ctx.roundRect(sx(x), sy(y), w * scale, h * scale, Math.max(0, r * scale));
    };
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 6;
    rr(-W / 2, -D / 2, W, D, GF.cornerRadius);
    ctx.fillStyle = v('--bin-fill');
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = v('--bin-stroke');
    ctx.stroke();
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = v('--cell-line');
    ctx.beginPath();
    for (let i = 1; i < s.unitsX; i++) {
      const x = sx((i - s.unitsX / 2) * GF.pitch);
      ctx.moveTo(x, sy(-D / 2));
      ctx.lineTo(x, sy(D / 2));
    }
    for (let j = 1; j < s.unitsY; j++) {
      const y = sy((j - s.unitsY / 2) * GF.pitch);
      ctx.moveTo(sx(-W / 2), y);
      ctx.lineTo(sx(W / 2), y);
    }
    ctx.stroke();
    rr(-W / 2 + GF.edgeMargin, -D / 2 + GF.edgeMargin, W - 2 * GF.edgeMargin, D - 2 * GF.edgeMargin, 0.75);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dimensions.
    ctx.font = `500 11px ${font}`;
    ctx.fillStyle = v('--muted');
    ctx.strokeStyle = v('--border-strong');
    ctx.lineWidth = 1;
    const dimY = sy(-D / 2) - 18, dimX = sx(-W / 2) - 18;
    ctx.beginPath();
    ctx.moveTo(sx(-W / 2), dimY);
    ctx.lineTo(sx(W / 2), dimY);
    ctx.moveTo(sx(-W / 2), dimY - 4);
    ctx.lineTo(sx(-W / 2), dimY + 4);
    ctx.moveTo(sx(W / 2), dimY - 4);
    ctx.lineTo(sx(W / 2), dimY + 4);
    ctx.moveTo(dimX, sy(-D / 2));
    ctx.lineTo(dimX, sy(D / 2));
    ctx.moveTo(dimX - 4, sy(-D / 2));
    ctx.lineTo(dimX + 4, sy(-D / 2));
    ctx.moveTo(dimX - 4, sy(D / 2));
    ctx.lineTo(dimX + 4, sy(D / 2));
    ctx.stroke();
    const label = (text: string, x: number, y: number, rot = 0) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = v('--canvas-bg');
      ctx.fillRect(-w / 2, -8, w, 16);
      ctx.fillStyle = v('--muted');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    label(`${W.toFixed(1)} mm · ${s.unitsX}u`, sx(0), dimY);
    label(`${D.toFixed(1)} mm · ${s.unitsY}u`, dimX, sy(0), -Math.PI / 2);

    // Items.
    const traceLoops = (loops: Point[][]) => {
      ctx.beginPath();
      for (const l of loops) {
        l.forEach((p, k) => (k ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
        ctx.closePath();
      }
    };
    const sel = selectedItem();
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    S.items.forEach((it, idx) => {
      const color = colorOf(idx);
      const loops = placedLoops(it);
      const isSel = sel === it, isHover = this.hoverItem === it.id && !isSel;
      // Clearance (and rim) band.
      const band = s.clearance + (s.rimEdge.type === 'none' ? 0 : s.rimEdge.size);
      traceLoops(loops);
      ctx.lineJoin = 'round';
      if (band > 0) {
        ctx.lineWidth = 2 * band * scale;
        ctx.strokeStyle = color + '30';
        ctx.stroke();
      }
      ctx.fillStyle = color + (isSel ? '52' : isHover ? '48' : '3a');
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      if (isSel) {
        // Selection: an accent outline just outside the item.
        ctx.save();
        ctx.lineWidth = 5;
        ctx.strokeStyle = v('--accent') + '55';
        ctx.stroke();
        ctx.lineWidth = 2;
        ctx.strokeStyle = v('--accent');
        ctx.stroke();
        ctx.restore();
      }

      // Depth zones (only shaded inside the outline).
      it.zones.forEach((z, zi) => {
        const poly = placedZone(it, z);
        const tracePoly = () => {
          ctx.beginPath();
          poly.forEach((p, k) => (k ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
          ctx.closePath();
        };
        ctx.save();
        traceLoops(loops);
        ctx.clip();
        tracePoly();
        ctx.fillStyle = z.depth >= it.depth ? 'rgba(15, 18, 24, 0.38)' : 'rgba(255, 255, 255, 0.7)';
        ctx.fill();
        ctx.restore();
        const zSel = isSel && S.sel.zone === zi;
        tracePoly();
        ctx.setLineDash(zSel ? [] : [4, 3]);
        ctx.lineWidth = zSel ? 2 : 1.2;
        ctx.strokeStyle = zSel ? v('--accent') : dark ? 'rgba(255,255,255,0.7)' : 'rgba(20,23,28,0.6)';
        ctx.stroke();
        ctx.setLineDash([]);
        const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
        ctx.font = `600 10.5px ${font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const t = `${z.depth} mm`;
        const tw = ctx.measureText(t).width + 8;
        ctx.fillStyle = z.depth >= it.depth ? 'rgba(20,23,28,0.85)' : 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        ctx.roundRect(sx(c.x) - tw / 2, sy(c.y) - 8, tw, 16, 8);
        ctx.fill();
        ctx.fillStyle = z.depth >= it.depth ? '#fff' : '#14171c';
        ctx.fillText(t, sx(c.x), sy(c.y) + 0.5);
      });

      // Finger notches.
      for (const nc of placedNotches(it)) {
        ctx.beginPath();
        ctx.arc(sx(nc.x), sy(nc.y), s.fingerRadius * scale, 0, Math.PI * 2);
        ctx.fillStyle = color + '24';
        ctx.fill();
        ctx.setLineDash([4, 3]);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Name label.
      ctx.font = `600 12px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const name = it.name || 'Untitled item';
      const nw = ctx.measureText(name).width + 14;
      ctx.fillStyle = dark ? 'rgba(18,21,27,0.82)' : 'rgba(255,255,255,0.88)';
      ctx.beginPath();
      ctx.roundRect(sx(it.x) - nw / 2, sy(it.y) - 10, nw, 20, 10);
      ctx.fill();
      ctx.fillStyle = v('--text');
      ctx.fillText(name, sx(it.x), sy(it.y) + 0.5);
    });

    // Selection overlay and handles (drawn last, on top).
    if (sel) {
      const accent = v('--accent');
      const { base, handle } = this.rotHandle(sel);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(sx(base.x), sy(base.y));
      ctx.lineTo(sx(handle.x), sy(handle.y));
      ctx.stroke();
      const dot = (p: Point, r: number, fill: string, stroke: string) => {
        ctx.beginPath();
        ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      };
      dot(handle, 6.5, '#fff', accent);
      for (const nc of placedNotches(sel)) dot(nc, 5.5, '#fff', accent);
      if (S.sel.zone !== null && sel.zones[S.sel.zone]) {
        const h = zoneHandle(sel, sel.zones[S.sel.zone]);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.rect(sx(h.x) - 5, sy(h.y) - 5, 10, 10);
        ctx.fill();
        ctx.stroke();
      }
      if (this.rotLabel) {
        ctx.font = `600 11px ${font}`;
        const t = this.rotLabel.text;
        const tw = ctx.measureText(t).width + 12;
        const lx = sx(this.rotLabel.p.x) + 14, ly = sy(this.rotLabel.p.y) - 14;
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.roundRect(lx, ly - 10, tw, 20, 6);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(t, lx + 6, ly + 0.5);
      }
    }
  }
}
