import { describe, expect, it, beforeAll } from 'vitest';
import Module, { ManifoldToplevel } from 'manifold-3d';
import { buildBin, toStl } from '../src/gridfinity';
import { DepthZone, Item, autoArrange, defaultSettings, fitBinToItems, nearestOnLoops, placedNotches, requiredHeightUnits, suggestNotch } from '../src/layout';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const rect = (w: number, h: number) => [[{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]];
const item = (id: number, w: number, h: number, depth = 10): Item => ({ id, name: `i${id}`, loops: rect(w, h), depth, x: 0, y: 0, rotation: 0, notches: [], zones: [] });

describe('layout', () => {
  it('fits a single small item in a 1x1 bin', () => {
    const s = defaultSettings();
    expect(autoArrange([item(1, 30, 20)], s).ok).toBe(true);
    expect([s.unitsX, s.unitsY]).toEqual([1, 1]);
  });
  it('packs several items into few cells without overlap', () => {
    const s = defaultSettings();
    const items = [item(1, 120, 20), item(2, 60, 30), item(3, 50, 25), item(4, 20, 20)];
    expect(autoArrange(items, s).ok).toBe(true);
    expect(s.unitsX * s.unitsY).toBeLessThanOrEqual(8);
    expect(Math.max(s.unitsX, s.unitsY)).toBeLessThanOrEqual(5);
    const r = buildBin(wasm, items, s);
    expect(r.warnings).toEqual([]);
    r.manifold.delete();
  });
  it('grows the bin for a large item', () => {
    const s = defaultSettings();
    expect(autoArrange([item(1, 100, 100)], s)).toEqual({ ok: true, exceedsBed: false });
    expect([s.unitsX, s.unitsY]).toEqual([3, 3]);
  });
  it('goes past the bed limit (with a flag) rather than leaving the bin too small', () => {
    const s = defaultSettings(); // maxUnits 5 = 207.5 mm
    const r = autoArrange([item(1, 230, 30)], s);
    expect(r).toEqual({ ok: true, exceedsBed: true });
    expect(Math.max(s.unitsX, s.unitsY)).toBe(6);
    const b = buildBin(wasm, [item(1, 230, 30)].map((i) => ({ ...i, rotation: s.unitsX >= s.unitsY ? 0 : 90 })), s);
    expect(b.warnings).toEqual([]);
    b.manifold.delete();
  });
  it('leaves room for finger notches', () => {
    const s = defaultSettings();
    const it1 = { ...item(1, 70, 25), notches: [{ x: 0, y: -12.5 }, { x: 35, y: 0 }] };
    autoArrange([it1], s);
    const b = buildBin(wasm, [it1], s);
    expect(b.warnings).toEqual([]);
    b.manifold.delete();
  });
  it('keeps manually placed items where they are when they fit', () => {
    const s = { ...defaultSettings(), unitsX: 3, unitsY: 2 };
    const items = [item(1, 30, 20)];
    items[0].x = 30; // towards the right of a 3 x 2 bin, still inside
    items[0].y = -15;
    fitBinToItems(items, s);
    expect([s.unitsX, s.unitsY]).toEqual([3, 2]); // no shrinking
    expect([items[0].x, items[0].y]).toEqual([30, -15]); // no snapping back to the middle
    const b = buildBin(wasm, items, s);
    expect(b.warnings).toEqual([]);
    b.manifold.delete();
  });
  it('grows the bin and nudges items only as much as needed when something sticks out', () => {
    const s = { ...defaultSettings(), unitsX: 2, unitsY: 1 };
    const items = [item(1, 30, 20), item(2, 30, 20)];
    items[0].x = -20;
    items[1].x = 60; // past the right edge of a 2-unit bin
    fitBinToItems(items, s);
    expect(s.unitsX).toBe(3);
    const b = buildBin(wasm, items, s);
    expect(b.warnings).toEqual([]);
    b.manifold.delete();
    // The gap between the two items is kept exactly.
    expect(items[1].x - items[0].x).toBeCloseTo(80);
  });
  it('places notches on the outline and rotates them with the item', () => {
    const it1 = { ...item(1, 60, 20), x: 10, y: 5, rotation: 90 };
    expect(nearestOnLoops(it1.loops, { x: 3, y: -40 })).toEqual({ x: 3, y: -10 });
    // Item rotated 90°: its top side in the view is its own left (-x) side.
    const n = suggestNotch(it1);
    expect(n.x).toBeCloseTo(-30);
    expect(n.y).toBeCloseTo(0);
    it1.notches.push(n);
    const p = placedNotches(it1)[0];
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(5 - 30);
    // A second suggestion goes to another side.
    const n2 = suggestNotch(it1);
    expect(Math.hypot(n2.x - n.x, n2.y - n.y)).toBeGreaterThan(15);
  });
  it('computes height units from depth', () => {
    const s = defaultSettings();
    expect(requiredHeightUnits([item(1, 10, 10, 20)], s)).toBe(4); // 4.75+1.2+20 = 25.95 -> 4u
  });
});

describe('depth zones', () => {
  const none = { type: 'none' as const, size: 0 };
  const fixed = { ...defaultSettings(), autoSize: false, unitsX: 2, unitsY: 1, unitsZ: 5, clearance: 0, rimEdge: none, stepEdge: none };
  const volumeOf = (it: Item) => {
    const r = buildBin(wasm, [it], fixed);
    const v = r.manifold.volume();
    const ok = (r.manifold as unknown as { status(): { value: number } }).status().value === 0;
    r.manifold.delete();
    return { v, ok, warnings: r.warnings };
  };
  const zone = (z: Partial<DepthZone>): DepthZone => ({ kind: 'rect', x: 0, y: 0, w: 10, h: 10, rotation: 0, depth: 10, ...z });
  const base = () => ({ ...item(1, 60, 20, 10) });

  it('cuts deeper inside a deeper zone, only where it overlaps the pocket', () => {
    const v0 = volumeOf(base()).v;
    // 20 x 30 zone at the left end: only 20 x 20 of it overlaps the 60 x 20 pocket.
    const r = volumeOf({ ...base(), zones: [zone({ x: -20, w: 20, h: 30, depth: 18 })] });
    expect(r.ok).toBe(true);
    expect(v0 - r.v).toBeCloseTo(20 * 20 * 8, -1);
    expect(r.warnings).toEqual([]);
  });
  it('leaves material inside a shallower zone', () => {
    const v0 = volumeOf(base()).v;
    const r = volumeOf({ ...base(), zones: [zone({ x: 20, w: 20, h: 20, depth: 4 })] });
    expect(r.v - v0).toBeCloseTo(20 * 20 * 6, -1);
  });
  it('lets later zones override earlier ones, including circles and rotation', () => {
    const v0 = volumeOf(base()).v;
    const deep = zone({ x: 0, w: 40, h: 20, depth: 16 });
    const shallow = zone({ kind: 'circle', x: 0, w: 10, depth: 10 }); // back to base depth in a 10 mm circle
    const r = volumeOf({ ...base(), zones: [deep, shallow] });
    const circleArea = Math.PI * 25 * 0.99; // 48-gon
    expect(v0 - r.v).toBeCloseTo((40 * 20 - circleArea) * 6, -1);
    // A rect rotated 90° within the item: 20 wide x 40 tall -> only 20 x 20 overlaps.
    const rot = volumeOf({ ...base(), zones: [zone({ w: 40, h: 20, rotation: 90, depth: 16 })] });
    expect(v0 - rot.v).toBeCloseTo(20 * 20 * 6, -1);
  });
  it('warns about a zone outside the pocket and raises the bin for deep zones', () => {
    const r = volumeOf({ ...base(), zones: [zone({ x: 100 })] });
    expect(r.warnings.join()).toMatch(/doesn't overlap/);
    const s = defaultSettings();
    expect(requiredHeightUnits([{ ...base(), zones: [zone({ depth: 30 })] }], s)).toBe(6);
  });
});

describe('edge chamfers and fillets', () => {
  const none = { type: 'none' as const, size: 0 };
  const cfg = (rim: typeof none | { type: 'chamfer' | 'fillet'; size: number }, step: typeof none | { type: 'chamfer' | 'fillet'; size: number } = none) => ({
    ...defaultSettings(), autoSize: false, unitsX: 2, unitsY: 1, unitsZ: 5, clearance: 0, rimEdge: rim, stepEdge: step,
  });
  const vol = (it: Item, s: ReturnType<typeof cfg>) => {
    const r = buildBin(wasm, [it], s);
    const ok = (r.manifold as unknown as { status(): { value: number } }).status().value === 0;
    const v = r.manifold.volume();
    r.manifold.delete();
    expect(ok).toBe(true);
    return v;
  };
  const bar = () => item(1, 60, 20, 10); // perimeter 160 mm

  it('chamfers the pocket rim (removes ~ perimeter × c²/2)', () => {
    const extra = vol(bar(), cfg(none)) - vol(bar(), cfg({ type: 'chamfer', size: 1 }));
    expect(extra).toBeGreaterThan(160 * 0.5 * 0.9);
    expect(extra).toBeLessThan(160 * 0.5 * 1.15);
  });
  it('fillets the rim (removes ~ perimeter × c²(1 − π/4))', () => {
    const extra = vol(bar(), cfg(none)) - vol(bar(), cfg({ type: 'fillet', size: 1 }));
    expect(extra).toBeGreaterThan(160 * 0.2146 * 0.85);
    expect(extra).toBeLessThan(160 * 0.2146 * 1.2);
  });
  it('rounds only the inside edge of a depth step, never past the step height', () => {
    // Deeper zone over the left 20 mm: its only edge inside the pocket is the 20 mm line at x = -10.
    const it = { ...bar(), zones: [{ kind: 'rect' as const, x: -20, y: 0, w: 20, h: 30, rotation: 0, depth: 15 }] };
    const extra = vol(it, cfg(none)) - vol(it, cfg(none, { type: 'chamfer', size: 1 }));
    expect(extra).toBeGreaterThan(20 * 0.5 * 0.8);
    expect(extra).toBeLessThan(20 * 0.5 * 1.3);
    // A 0.5 mm step with a 2 mm chamfer is limited to the step: ~ 20 × 0.5²/2 = 2.5 mm³.
    const low = { ...bar(), zones: [{ ...it.zones[0], depth: 10.5 }] };
    const small = vol(low, cfg(none)) - vol(low, cfg(none, { type: 'chamfer', size: 2 }));
    expect(small).toBeLessThan(4);
    expect(small).toBeGreaterThan(1);
  });
  it('rounds the top of a raised platform and stays valid with notches and zones together', () => {
    const plat = { ...bar(), zones: [{ kind: 'circle' as const, x: 0, y: 0, w: 12, h: 12, rotation: 0, depth: 4 }] };
    const extra = vol(plat, cfg(none)) - vol(plat, cfg(none, { type: 'fillet', size: 1 }));
    expect(extra).toBeGreaterThan(Math.PI * 12 * 0.2146 * 0.7); // circumference × fillet section
    const busy = { ...plat, notches: [{ x: 0, y: -10 }, { x: 30, y: 0 }], zones: [...plat.zones, { kind: 'rect' as const, x: -22, y: 0, w: 14, h: 30, rotation: 20, depth: 16 }] };
    vol(busy, cfg({ type: 'fillet', size: 1.5 }, { type: 'chamfer', size: 1 }));
  });
});

describe('finger notch depth', () => {
  it('uses the set depth (and the bin grows for it), or the automatic depth', () => {
    const base = { ...defaultSettings(), autoSize: false, unitsX: 2, unitsY: 1, unitsZ: 0, rimEdge: { type: 'none' as const, size: 0 }, stepEdge: { type: 'none' as const, size: 0 } };
    const it = { ...item(1, 60, 20, 10), notches: [{ x: 0, y: -10 }] };
    const v = (fingerDepth: number) => {
      const r = buildBin(wasm, [it], { ...base, unitsZ: 5, fingerDepth });
      const out = r.manifold.volume();
      r.manifold.delete();
      return out;
    };
    // Auto for a 10 mm pocket = 8 mm. Setting 4 mm leaves 4 mm more material in the notch's
    // part outside the pocket; 8 mm matches auto exactly.
    expect(v(8)).toBeCloseTo(v(0), 1);
    const outside = Math.PI * 100 / 2 - 2 * 1; // half the 10 mm-radius circle sits outside (minus clearance band)
    expect(v(4) - v(0)).toBeGreaterThan(outside * 4 * 0.8);
    expect(v(4) - v(0)).toBeLessThan(outside * 4 * 1.2);
    expect(requiredHeightUnits([it], { ...base, fingerDepth: 30 })).toBe(6);
  });
});

describe('bin geometry', () => {
  it('builds a valid, watertight 2x1 bin with a pocket and notch', () => {
    const s = { ...defaultSettings(), autoSize: false, unitsX: 2, unitsY: 1, unitsZ: 3, magnets: true };
    const it1 = { ...item(1, 60, 20, 15), notches: [{ x: 0, y: 10 }] };
    const r = buildBin(wasm, [it1], s);
    const m = r.manifold;
    expect((m as unknown as { status(): { value: number } }).status().value).toBe(0);
    expect(m.genus()).toBeGreaterThanOrEqual(0);
    const b = m.boundingBox();
    expect(b.max[0] - b.min[0]).toBeCloseTo(83.5, 1);
    expect(b.max[1] - b.min[1]).toBeCloseTo(41.5, 1);
    expect(b.max[2]).toBeCloseTo(r.unitsZ * 7 + 4.4, 1);
    // Volume must be less than a solid block of the same size because of the pocket.
    const solid = buildBin(wasm, [], s).manifold;
    const pocketVol = 62 * 22 * 15; // with clearance, ignoring rounded corners
    expect(solid.volume() - m.volume()).toBeGreaterThan(pocketVol * 0.9);
    expect(toStl(m).byteLength).toBe(84 + m.numTri() * 50);
    solid.delete();
    m.delete();
  });
  it('warns when a pocket does not fit', () => {
    const s = { ...defaultSettings(), autoSize: false, unitsX: 1, unitsY: 1 };
    const r = buildBin(wasm, [item(1, 60, 10)], s);
    expect(r.warnings.join()).toMatch(/sticks out/);
    r.manifold.delete();
  });
});
