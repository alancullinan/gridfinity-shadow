// The design being edited, the current selection, and change notifications.
// UI modules read state from here, mutate it, then call changed() so everything
// (layout, panels, 3D model, undo history, autosave) updates.
import { BinSettings, Item, autoArrange, defaultSettings, fitBinToItems } from '../layout';

/** Item colours (a colour-blind-friendly categorical palette). */
export const PALETTE = ['#4e79a7', '#f28e2b', '#e15759', '#59a14f', '#b07aa1', '#76b7b2', '#edc948', '#ff9da7', '#9c755f', '#8cd17d'];
export const colorOf = (index: number) => PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];

export interface Selection {
  item: number | null;
  zone: number | null;
}

export const S = {
  items: [] as Item[],
  settings: defaultSettings() as BinSettings,
  designName: 'Untitled',
  nextId: 1,
  sel: { item: null, zone: null } as Selection,
  /** Problems with the arrangement (shown with the model's own warnings). */
  layoutWarnings: [] as string[],
};

/** changed: geometry or settings changed. selection: selection changed. meta: name changed. */
type EventName = 'changed' | 'selection' | 'meta';
const listeners = new Map<EventName, Set<() => void>>();
export function on(ev: EventName, fn: () => void) {
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev)!.add(fn);
}
export function emit(ev: EventName) {
  listeners.get(ev)?.forEach((fn) => fn());
}

export const selectedItem = (): Item | null =>
  S.sel.item === null ? null : (S.items.find((i) => i.id === S.sel.item) ?? null);
export const indexOfItem = (id: number) => S.items.findIndex((i) => i.id === id);

export function select(item: number | null, zone: number | null = null) {
  if (S.sel.item === item && S.sel.zone === zone) return;
  S.sel = { item, zone };
  emit('selection');
}

function bedWarning(prefix: string): string[] {
  const { unitsX, unitsY, maxUnits } = S.settings;
  return Math.max(unitsX, unitsY) > maxUnits
    ? [`${prefix} a ${unitsX} × ${unitsY} bin, which is bigger than your ${maxUnits}u printer bed limit.`]
    : [];
}

/**
 * Call after changing the design. With refit, and auto size on, the bin grows if something now
 * sticks out (items stay where they are).
 */
export function changed(opts: { refit?: boolean } = {}) {
  if (opts.refit && S.settings.autoSize) {
    fitBinToItems(S.items, S.settings);
    S.layoutWarnings = bedWarning('This arrangement needs');
  }
  // Drop a selection that no longer exists.
  const it = selectedItem();
  if (S.sel.item !== null && !it) S.sel = { item: null, zone: null };
  else if (it && S.sel.zone !== null && S.sel.zone >= it.zones.length) S.sel = { item: it.id, zone: null };
  emit('changed');
}

/** Packs every item into the smallest bin (or the fixed size). */
export function arrange() {
  const r = autoArrange(S.items, S.settings);
  S.layoutWarnings = !r.ok
    ? [`The items don't fit in a ${S.settings.unitsX} × ${S.settings.unitsY} bin. Turn on auto size, make the bin bigger or reduce the clearance.`]
    : r.exceedsBed
      ? [
          ...bedWarning('The items need'),
          'Check the outlines (a shadow can make one too big) or split the items across bins.',
        ]
      : [];
  changed();
}

export function addItem(item: Omit<Item, 'id'>): Item {
  const it = { ...item, id: S.nextId++ };
  S.items.push(it);
  return it;
}

export function removeItem(id: number) {
  const i = indexOfItem(id);
  if (i < 0) return;
  S.items.splice(i, 1);
  if (S.sel.item === id) select(null);
  changed();
}

export function duplicateItem(id: number) {
  const src = S.items.find((i) => i.id === id);
  if (!src) return;
  const copy = addItem({ ...structuredClone(src), name: `${src.name} copy`, x: src.x + 8, y: src.y + 8 });
  select(copy.id);
  changed({ refit: true });
}

export function testShape(): Omit<Item, 'id'> {
  const w = 60, h = 20;
  return {
    name: `Test ${w}×${h}`,
    loops: [[{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]],
    depth: 10,
    x: 0,
    y: 0,
    rotation: 0,
    notches: [{ x: 0, y: -h / 2 }],
    zones: [],
  };
}
