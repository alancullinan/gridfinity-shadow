import { describe, expect, it, beforeAll } from 'vitest';
import Module, { ManifoldToplevel } from 'manifold-3d';
import { buildBin, toStl } from '../src/gridfinity';
import { Item, autoArrange, defaultSettings, requiredHeightUnits } from '../src/layout';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const rect = (w: number, h: number) => [[{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]];
const item = (id: number, w: number, h: number, depth = 10): Item => ({ id, name: `i${id}`, loops: rect(w, h), depth, x: 0, y: 0, rotation: 0, notch: 'none' });

describe('layout', () => {
  it('fits a single small item in a 1x1 bin', () => {
    const s = defaultSettings();
    expect(autoArrange([item(1, 30, 20)], s)).toBe(true);
    expect([s.unitsX, s.unitsY]).toEqual([1, 1]);
  });
  it('packs several items into few cells without overlap', () => {
    const s = defaultSettings();
    const items = [item(1, 120, 20), item(2, 60, 30), item(3, 50, 25), item(4, 20, 20)];
    expect(autoArrange(items, s)).toBe(true);
    expect(s.unitsX * s.unitsY).toBeLessThanOrEqual(8);
    expect(Math.max(s.unitsX, s.unitsY)).toBeLessThanOrEqual(5);
    const r = buildBin(wasm, items, s);
    expect(r.warnings).toEqual([]);
    r.manifold.delete();
  });
  it('computes height units from depth', () => {
    const s = defaultSettings();
    expect(requiredHeightUnits([item(1, 10, 10, 20)], s)).toBe(4); // 4.75+1.2+20 = 25.95 -> 4u
  });
});

describe('bin geometry', () => {
  it('builds a valid, watertight 2x1 bin with a pocket and notch', () => {
    const s = { ...defaultSettings(), autoSize: false, unitsX: 2, unitsY: 1, unitsZ: 3, magnets: true };
    const it1 = { ...item(1, 60, 20, 15), notch: 'bottom' as const };
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
