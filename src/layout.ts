import type { Point } from './sheet';

export type NotchSide = 'none' | 'top' | 'bottom' | 'left' | 'right';

export interface Item {
  id: number;
  name: string;
  /** Outline loops in mm, centred on the item's bounding-box centre, y pointing down (as photographed). */
  loops: Point[][];
  /** Pocket depth in mm. */
  depth: number;
  /** Centre position in the bin, mm from the bin centre, y pointing down (top view). */
  x: number;
  y: number;
  /** Rotation in degrees (clockwise in the top view). */
  rotation: number;
  notch: NotchSide;
}

export interface BinSettings {
  autoSize: boolean;
  unitsX: number;
  unitsY: number;
  /** Height in 7 mm units; 0 means automatic. */
  unitsZ: number;
  clearance: number;
  /** Minimum wall between pockets, mm. */
  spacing: number;
  magnets: boolean;
  lip: boolean;
  fingerRadius: number;
  /** Minimum solid material under the deepest pocket, mm (above the base profile). */
  floor: number;
  /** Largest bin side (in grid units) the printer bed can take. */
  maxUnits: number;
}

export const GF = {
  pitch: 42,
  heightUnit: 7,
  clearance: 0.5, // total; bins are 41.5 mm per 1 unit
  cornerRadius: 3.75,
  baseHeight: 4.75,
  lipHeight: 4.4,
  /** Pockets must stay at least this far from the bin's outer edge (clear of the stacking lip). */
  edgeMargin: 3.0,
};

export function defaultSettings(): BinSettings {
  return {
    autoSize: true,
    unitsX: 2,
    unitsY: 2,
    unitsZ: 0,
    clearance: 1.0,
    spacing: 2.0,
    magnets: false,
    lip: true,
    fingerRadius: 10,
    floor: 1.2,
    maxUnits: 5,
  };
}

export function binOuterSize(units: number): number {
  return units * GF.pitch - GF.clearance;
}

export function transformPoint(p: Point, item: Pick<Item, 'x' | 'y' | 'rotation'>): Point {
  const a = (item.rotation * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return { x: item.x + p.x * c - p.y * s, y: item.y + p.x * s + p.y * c };
}

export function placedLoops(item: Item): Point[][] {
  return item.loops.map((l) => l.map((p) => transformPoint(p, item)));
}

function rotatedBBox(loops: Point[][], deg: number) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops)
    for (const p of l) {
      const x = p.x * c - p.y * s, y = p.x * s + p.y * c;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** Rotation (deg) giving the smallest bounding box, with the long side horizontal. */
export function bestOrientation(loops: Point[][]): number {
  let best = 0, bestArea = Infinity;
  for (let d = 0; d < 180; d += 1) {
    const b = rotatedBBox(loops, d);
    if (b.w * b.h < bestArea - 1e-6) {
      bestArea = b.w * b.h;
      best = d;
    }
  }
  const b = rotatedBBox(loops, best);
  return b.h > b.w ? best + 90 : best;
}

/** Re-centres loops on their bounding-box centre. Returns the shift that was applied. */
export function centreLoops(loops: Point[][]): { loops: Point[][]; centre: Point } {
  const b = rotatedBBox(loops, 0);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return { loops: loops.map((l) => l.map((p) => ({ x: p.x - cx, y: p.y - cy }))), centre: { x: cx, y: cy } };
}

interface Box {
  item: Item;
  rot: number;
  w: number;
  h: number;
  /** Offset from bbox centre to item origin after rotation. */
  ox: number;
  oy: number;
}

function makeBox(item: Item, rot: number, pad: number): Box {
  const b = rotatedBBox(item.loops, rot);
  return { item, rot, w: b.w + pad, h: b.h + pad, ox: -(b.minX + b.maxX) / 2, oy: -(b.minY + b.maxY) / 2 };
}

/** Shelf packing into a given inner width. Returns placements and used height, or null if something doesn't fit. */
function shelfPack(items: Item[], innerW: number, pad: number) {
  const boxes = items.map((it) => {
    const r0 = ((it.rotation % 360) + 360) % 360;
    let b = makeBox(it, r0, pad);
    if (b.w > innerW) {
      const alt = makeBox(it, r0 + 90, pad);
      if (alt.w <= innerW) b = alt;
    }
    return b;
  });
  if (boxes.some((b) => b.w > innerW + 1e-6)) return null;
  boxes.sort((a, b) => b.h - a.h);
  const shelves: { y: number; h: number; x: number; boxes: { b: Box; x: number }[] }[] = [];
  for (const b of boxes) {
    let shelf = shelves.find((s) => s.x + b.w <= innerW + 1e-6 && b.h <= s.h + 1e-6);
    if (!shelf) {
      const y = shelves.reduce((acc, s) => acc + s.h, 0);
      shelf = { y, h: b.h, x: 0, boxes: [] };
      shelves.push(shelf);
    }
    shelf.boxes.push({ b, x: shelf.x });
    shelf.x += b.w;
  }
  const usedH = shelves.reduce((acc, s) => acc + s.h, 0);
  const usedW = Math.max(...shelves.map((s) => s.x));
  return { shelves, usedH, usedW };
}

/**
 * Arranges the items. With settings.autoSize the bin size is chosen to use the fewest grid
 * cells; otherwise items are packed into the configured size. Mutates the items' x, y,
 * rotation and the settings' unitsX/unitsY. Returns false if they don't fit.
 */
export function autoArrange(items: Item[], settings: BinSettings): boolean {
  if (!items.length) return true;
  const pad = 2 * settings.clearance + settings.spacing;
  const margin = 2 * GF.edgeMargin - settings.spacing; // spacing on the outside is already included in pad
  type Result = { n: number; m: number; pack: NonNullable<ReturnType<typeof shelfPack>> };
  let best: Result | null = null;
  const tryN = settings.autoSize
    ? Array.from({ length: Math.max(1, settings.maxUnits) }, (_, i) => i + 1)
    : [settings.unitsX];
  for (const n of tryN) {
    const innerW = binOuterSize(n) - margin;
    const pack = shelfPack(items, innerW, pad);
    if (!pack) continue;
    const m = settings.autoSize
      ? Math.max(1, Math.ceil((pack.usedH + margin + GF.clearance) / GF.pitch - 1e-9))
      : settings.unitsY;
    if (settings.autoSize && m > settings.maxUnits) continue;
    if (!settings.autoSize && pack.usedH > binOuterSize(m) - margin + 1e-6) continue;
    if (
      !best ||
      n * m < best.n * best.m ||
      (n * m === best.n * best.m && Math.abs(n - m) < Math.abs(best.n - best.m))
    )
      best = { n, m, pack };
  }
  if (!best) return false;
  settings.unitsX = best.n;
  settings.unitsY = best.m;
  const { shelves, usedH } = best.pack;
  const top = -usedH / 2;
  for (const s of shelves) {
    const rowW = s.x;
    const left = -rowW / 2;
    for (const { b, x } of s.boxes) {
      b.item.rotation = b.rot;
      b.item.x = left + x + b.w / 2 + b.ox;
      b.item.y = top + s.y + s.h / 2 + b.oy;
    }
  }
  return true;
}

/** Centre of the finger notch for an item, in bin top-view coordinates, or null. */
export function notchCentre(item: Item): Point | null {
  if (item.notch === 'none') return null;
  const dir = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } }[item.notch];
  const loops = placedLoops(item);
  const o = { x: item.x, y: item.y };
  // Furthest intersection of a ray from the item centre with the outline.
  let bestT = 0;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i], b = l[(i + 1) % l.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const den = dir.x * ey - dir.y * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - o.x) * ey - (a.y - o.y) * ex) / den;
      const u = ((a.x - o.x) * dir.y - (a.y - o.y) * dir.x) / den;
      if (t > bestT && u >= 0 && u <= 1) bestT = t;
    }
  }
  return { x: o.x + dir.x * bestT, y: o.y + dir.y * bestT };
}

export function requiredHeightUnits(items: Item[], settings: BinSettings): number {
  const deepest = Math.max(0, ...items.map((i) => i.depth));
  return Math.max(2, Math.ceil((GF.baseHeight + settings.floor + deepest) / GF.heightUnit - 1e-9));
}
