import { afterEach, describe, expect, it, vi } from 'vitest';
import { History, deleteFromLibrary, listSaved, loadAutosave, makeDesign, parseDesign, saveAutosave, saveToLibrary } from '../src/storage';
import { Item, defaultSettings } from '../src/layout';

const sq = [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 }];
const item = (id: number): Item => ({
  id, name: `Item ${id}`, loops: [sq], depth: 12, x: 3, y: -4, rotation: 15,
  notches: [{ x: 0, y: -5 }],
  zones: [{ kind: 'rect', x: 1, y: 0, w: 4, h: 6, rotation: 10, depth: 18 }],
});

function fakeStorage(opts: { full?: boolean } = {}) {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.full) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, v);
    },
  });
  return data;
}
afterEach(() => vi.unstubAllGlobals());

describe('design files', () => {
  it('round-trips a design exactly', () => {
    const s = { ...defaultSettings(), magnets: true, rimEdge: { type: 'chamfer' as const, size: 0.8 } };
    const d = makeDesign('Spanners', [item(1), item(2)], s);
    const back = parseDesign(JSON.parse(JSON.stringify(d)));
    expect(back.name).toBe('Spanners');
    expect(back.settings).toEqual(s);
    expect(back.items).toEqual([item(1), item(2)]);
  });
  it('rejects things that are not design files', () => {
    expect(() => parseDesign(null)).toThrow(/isn't a design/);
    expect(() => parseDesign({ hello: 1 })).toThrow(/wasn't made by this app/);
    expect(() => parseDesign({ app: 'gridfinity-tracer', version: 99 })).toThrow(/newer version/);
  });
  it('fills in fields missing from older files and drops broken parts', () => {
    const old = {
      app: 'gridfinity-tracer',
      version: 1,
      name: 'Old',
      settings: { clearance: 0.5, unitsX: 'x', rimEdge: { type: 'weird' } },
      items: [
        { name: 'No notches or zones', loops: [sq], depth: 10, x: 0, y: 0, rotation: 0 },
        { name: 'Bad loops', loops: [[{ x: 1 }]] },
        'junk',
        { name: 'Bad zone', loops: [sq], zones: [{ kind: 'hexagon' }, { kind: 'circle', w: 8, depth: 5 }] },
      ],
    };
    const d = parseDesign(old);
    const def = defaultSettings();
    expect(d.settings.clearance).toBe(0.5);
    expect(d.settings.unitsX).toBe(def.unitsX);
    expect(d.settings.rimEdge).toEqual(def.rimEdge);
    expect(d.settings.fingerDepth).toBe(def.fingerDepth);
    expect(d.items.map((i) => i.name)).toEqual(['No notches or zones', 'Bad zone']);
    expect(d.items[0].notches).toEqual([]);
    expect(d.items[0].zones).toEqual([]);
    expect(d.items[1].zones).toHaveLength(1);
    expect(d.items.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('browser storage', () => {
  it('autosaves and restores', () => {
    fakeStorage();
    expect(loadAutosave()).toBeNull();
    expect(saveAutosave(makeDesign('A', [item(1)], defaultSettings()))).toBe(true);
    expect(loadAutosave()!.items).toEqual([item(1)]);
  });
  it('keeps a named library: save, overwrite by name, list newest first, delete', async () => {
    fakeStorage();
    saveToLibrary(makeDesign('One', [item(1)], defaultSettings()));
    await new Promise((r) => setTimeout(r, 5));
    saveToLibrary(makeDesign('Two', [item(1), item(2)], defaultSettings()));
    expect(listSaved().map((e) => [e.name, e.itemCount])).toEqual([['Two', 2], ['One', 1]]);
    saveToLibrary(makeDesign('One', [], defaultSettings())); // overwrite
    expect(listSaved().map((e) => [e.name, e.itemCount])).toEqual([['One', 0], ['Two', 2]]);
    deleteFromLibrary('Two');
    expect(listSaved().map((e) => e.name)).toEqual(['One']);
  });
  it('reports failure instead of crashing when storage is full or missing', () => {
    fakeStorage({ full: true });
    expect(saveAutosave(makeDesign('A', [item(1)], defaultSettings()))).toBe(false);
    expect(saveToLibrary(makeDesign('A', [], defaultSettings()))).toBe(false);
    vi.unstubAllGlobals();
    vi.stubGlobal('localStorage', undefined);
    expect(loadAutosave()).toBeNull();
    expect(listSaved()).toEqual([]);
  });
});

describe('undo history', () => {
  it('undoes and redoes, skips duplicates, and drops redo after a new change', () => {
    const h = new History();
    h.reset('a');
    expect(h.canUndo).toBe(false);
    expect(h.commit('a')).toBe(false); // unchanged
    h.commit('b');
    h.commit('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe('b');
    h.commit('d'); // new branch: 'c' is gone
    expect(h.canRedo).toBe(false);
    expect(h.undo()).toBe('b');
  });
  it('keeps a bounded number of steps', () => {
    const h = new History(3);
    h.reset('0');
    for (const s of ['1', '2', '3', '4']) h.commit(s);
    expect([h.undo(), h.undo(), h.undo()]).toEqual(['3', '2', null]);
  });
});
