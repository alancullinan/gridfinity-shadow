// Design persistence: the design file format, validation of loaded data, and safe access to
// browser storage (which can be unavailable or full).
import type { Point } from './sheet';
import { BinSettings, DepthZone, Item, defaultSettings } from './layout';

export const APP_ID = 'gridfinity-tracer';
export const FORMAT_VERSION = 1;

export interface Design {
  app: typeof APP_ID;
  version: number;
  name: string;
  savedAt: string;
  settings: BinSettings;
  items: Item[];
}

export interface SavedEntry {
  name: string;
  savedAt: string;
  itemCount: number;
  design: Design;
}

const AUTOSAVE_KEY = 'gt:autosave';
const LIBRARY_KEY = 'gt:designs';

export function makeDesign(name: string, items: Item[], settings: BinSettings): Design {
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    name,
    savedAt: new Date().toISOString(),
    settings: structuredClone(settings),
    items: structuredClone(items),
  };
}

// --- Validation ------------------------------------------------------------------------
// Loaded files may be hand-edited, from an older version, or not ours at all. Everything is
// checked and missing fields fall back to defaults, so a bad file can't break the app.

const num = (v: unknown, fallback: number, min = -Infinity, max = Infinity): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v.slice(0, 200) : fallback);

function point(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

function zone(v: unknown): DepthZone | null {
  if (!v || typeof v !== 'object') return null;
  const z = v as Record<string, unknown>;
  const kind = z.kind === 'circle' ? 'circle' : z.kind === 'rect' ? 'rect' : null;
  if (!kind) return null;
  return {
    kind,
    x: num(z.x, 0),
    y: num(z.y, 0),
    w: num(z.w, 10, 0.5, 1000),
    h: num(z.h, 10, 0.5, 1000),
    rotation: num(z.rotation, 0),
    depth: num(z.depth, 10, 0.5, 300),
  };
}

function item(v: unknown, id: number): Item | null {
  if (!v || typeof v !== 'object') return null;
  const it = v as Record<string, unknown>;
  if (!Array.isArray(it.loops)) return null;
  const loops = it.loops
    .filter(Array.isArray)
    .map((l: unknown[]) => l.map(point).filter((p): p is Point => !!p))
    .filter((l) => l.length >= 3);
  if (!loops.length) return null;
  return {
    id,
    name: str(it.name, ""),
    loops,
    depth: num(it.depth, 12, 0.5, 300),
    x: num(it.x, 0),
    y: num(it.y, 0),
    rotation: num(it.rotation, 0),
    notches: Array.isArray(it.notches) ? it.notches.map(point).filter((p): p is Point => !!p) : [],
    zones: Array.isArray(it.zones) ? it.zones.map(zone).filter((z): z is DepthZone => !!z) : [],
  };
}

function edge(v: unknown, fallback: BinSettings['rimEdge']): BinSettings['rimEdge'] {
  if (!v || typeof v !== 'object') return { ...fallback };
  const e = v as Record<string, unknown>;
  const type = e.type === 'none' || e.type === 'chamfer' || e.type === 'fillet' ? e.type : fallback.type;
  return { type, size: num(e.size, fallback.size, 0, 10) };
}

function settingsFrom(v: unknown): BinSettings {
  const d = defaultSettings();
  if (!v || typeof v !== 'object') return d;
  const s = v as Record<string, unknown>;
  return {
    autoSize: typeof s.autoSize === 'boolean' ? s.autoSize : d.autoSize,
    unitsX: Math.round(num(s.unitsX, d.unitsX, 1, 20)),
    unitsY: Math.round(num(s.unitsY, d.unitsY, 1, 20)),
    unitsZ: Math.round(num(s.unitsZ, d.unitsZ, 0, 40)),
    clearance: num(s.clearance, d.clearance, 0, 10),
    spacing: num(s.spacing, d.spacing, 0.8, 20),
    magnets: typeof s.magnets === 'boolean' ? s.magnets : d.magnets,
    lip: typeof s.lip === 'boolean' ? s.lip : d.lip,
    fingerRadius: num(s.fingerRadius, d.fingerRadius, 4, 25),
    fingerDepth: num(s.fingerDepth, d.fingerDepth, 0, 300),
    floor: num(s.floor, d.floor, 0.4, 10),
    maxUnits: Math.round(num(s.maxUnits, d.maxUnits, 1, 20)),
    rimEdge: edge(s.rimEdge, d.rimEdge),
    stepEdge: edge(s.stepEdge, d.stepEdge),
  };
}

/** Parses and validates a design from unknown data. Throws with a readable message if unusable. */
export function parseDesign(data: unknown): Design {
  if (!data || typeof data !== 'object') throw new Error("This isn't a design file.");
  const d = data as Record<string, unknown>;
  if (d.app !== APP_ID) throw new Error("This file wasn't made by this app.");
  if (typeof d.version === 'number' && d.version > FORMAT_VERSION)
    throw new Error('This design was made by a newer version of the app. Reload the page to update.');
  const rawItems = Array.isArray(d.items) ? d.items : [];
  const items = rawItems
    .map((it) => item(it, 0))
    .filter((it): it is Item => !!it)
    .map((it, i) => ({ ...it, id: i + 1, name: it.name || `Item ${i + 1}` }));
  return {
    app: APP_ID,
    version: FORMAT_VERSION,
    name: str(d.name, 'Untitled'),
    savedAt: str(d.savedAt, new Date().toISOString()),
    settings: settingsFrom(d.settings),
    items,
  };
}

// --- Browser storage ---------------------------------------------------------------------

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** Returns false if storage is unavailable or full. */
function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function saveAutosave(design: Design): boolean {
  return write(AUTOSAVE_KEY, design);
}

export function loadAutosave(): Design | null {
  const raw = read(AUTOSAVE_KEY);
  if (!raw) return null;
  try {
    return parseDesign(raw);
  } catch {
    return null;
  }
}

export function listSaved(): SavedEntry[] {
  const raw = read(LIBRARY_KEY);
  if (!Array.isArray(raw)) return [];
  const out: SavedEntry[] = [];
  for (const e of raw) {
    try {
      const design = parseDesign((e as { design?: unknown })?.design);
      out.push({ name: design.name, savedAt: design.savedAt, itemCount: design.items.length, design });
    } catch {
      // Skip damaged entries.
    }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Saves (or overwrites, by name) a design in the library. Returns false if storage failed. */
export function saveToLibrary(design: Design): boolean {
  const others = listSaved().filter((e) => e.name !== design.name);
  return write(LIBRARY_KEY, [{ design }, ...others.map((e) => ({ design: e.design }))]);
}

export function deleteFromLibrary(name: string): boolean {
  return write(
    LIBRARY_KEY,
    listSaved()
      .filter((e) => e.name !== name)
      .map((e) => ({ design: e.design })),
  );
}

// --- Undo / redo -------------------------------------------------------------------------

/** Snapshot history. Snapshots are JSON strings, so identical states are easy to skip. */
export class History {
  private stack: string[] = [];
  private index = -1;
  constructor(private limit = 200) {}

  /** Records a state if it differs from the current one. Returns true if something was added. */
  commit(snapshot: string): boolean {
    if (this.stack[this.index] === snapshot) return false;
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }
  undo(): string | null {
    if (this.index <= 0) return null;
    return this.stack[--this.index];
  }
  redo(): string | null {
    if (this.index >= this.stack.length - 1) return null;
    return this.stack[++this.index];
  }
  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.stack.length - 1;
  }
  /** Starts over from a single state (e.g. after loading a design). */
  reset(snapshot: string) {
    this.stack = [snapshot];
    this.index = 0;
  }
}
