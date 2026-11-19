// Left panel (items list) and right panel (Item / Bin properties).
import { DepthZone, Item, defaultZone, requiredHeightUnits, suggestNotch } from '../layout';
import { icon } from '../ui/icons';
import { $, esc, fmt, renderKeepingFocus } from '../ui/dom';
import { S, arrange, changed, colorOf, duplicateItem, indexOfItem, on, removeItem, select, selectedItem } from './store';
import { normDeg } from './layoutView';

type PropsTab = 'item' | 'bin';
let tab: PropsTab = 'bin';

const outlineSize = (it: Item) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of it.loops)
    for (const p of l) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  return { w: maxX - minX, h: maxY - minY };
};

// ------------------------------------------------------------------ small builders
const field = (label: string, control: string) =>
  `<div class="field"><span class="field-label">${label}</span><div class="field-control">${control}</div></div>`;
const num = (key: string, value: number, unit: string, o: { min?: number; max?: number; step?: number; disabled?: boolean; prefix?: boolean } = {}) =>
  `<label class="num${o.prefix ? ' prefix' : ''}"><input type="number" data-key="${key}" value="${fmt(value, 1)}"` +
  `${o.min !== undefined ? ` min="${o.min}"` : ''}${o.max !== undefined ? ` max="${o.max}"` : ''} step="${o.step ?? 1}"` +
  `${o.disabled ? ' disabled' : ''} aria-label="${esc(unit)}"><span>${unit}</span></label>`;
const toggle = (key: string, label: string, checked: boolean, note = '') =>
  `<label class="switch"><span class="field-label">${label}${note ? `<small>${note}</small>` : ''}</span><input type="checkbox" role="switch" data-key="${key}" ${checked ? 'checked' : ''}></label>`;
const edgeControl = (which: 'rim' | 'step') => {
  const e = which === 'rim' ? S.settings.rimEdge : S.settings.stepEdge;
  const opts = (['none', 'chamfer', 'fillet'] as const)
    .map((t) => `<button type="button" data-act="edge" data-v="${which}:${t}" aria-pressed="${e.type === t}">${t[0].toUpperCase() + t.slice(1)}</button>`)
    .join('');
  return `<div class="seg sm">${opts}</div>`;
};

// ------------------------------------------------------------------ items list
function renderList() {
  const list = $('item-list');
  $('item-count').textContent = S.items.length ? String(S.items.length) : '';
  $('tab-design-count').textContent = S.items.length ? String(S.items.length) : '';
  list.innerHTML = S.items
    .map((it, idx) => {
      const { w, h } = outlineSize(it);
      const badges = [
        it.notches.length ? `<span title="${it.notches.length} finger notch${it.notches.length > 1 ? 'es' : ''}">${icon('notch')}${it.notches.length}</span>` : '',
        it.zones.length ? `<span title="${it.zones.length} depth zone${it.zones.length > 1 ? 's' : ''}">${icon('zone')}${it.zones.length}</span>` : '',
      ].join('');
      return `<button class="item-row${S.sel.item === it.id ? ' selected' : ''}" role="option" aria-selected="${S.sel.item === it.id}" data-id="${it.id}">
        <span class="swatch" style="background:${colorOf(idx)}"></span>
        <span class="item-row-text"><span class="item-row-name">${esc(it.name || 'Untitled item')}</span>
        <span class="item-row-meta">${fmt(w)} × ${fmt(h)} mm · ${fmt(it.depth)} deep</span></span>
        <span class="item-row-badges">${badges}</span></button>`;
    })
    .join('');
  $('stage-empty').hidden = S.items.length > 0;
}

// ------------------------------------------------------------------ properties
function itemProps(it: Item): string {
  const idx = indexOfItem(it.id);
  const { w, h } = outlineSize(it);
  const zi = S.sel.zone;
  const zone = zi !== null ? it.zones[zi] : undefined;
  const notches = it.notches.length
    ? `<div class="rows">${it.notches
        .map((_, i) => `<div class="row-item">${icon('notch')}<span class="name">Notch ${i + 1}</span><button class="icon-btn sm ghost danger" data-act="del-notch" data-v="${i}" title="Remove notch" aria-label="Remove notch ${i + 1}">${icon('x')}</button></div>`)
        .join('')}</div><p class="field-note">Drag a notch's white dot along the edge in the layout.</p>`
    : `<p class="field-note">A scoop at the edge so you can lift the item out.</p>`;
  const zones = it.zones.length
    ? `<div class="rows">${it.zones
        .map(
          (z, i) => `<div class="row-item clickable${zi === i ? ' selected' : ''}" data-act="sel-zone" data-v="${i}" role="button" tabindex="0">
            ${icon(z.kind === 'rect' ? 'square' : 'circle')}<span class="name">Zone ${i + 1}</span>
            <span class="chip ${z.depth >= it.depth ? 'deep' : 'shallow'}">${fmt(z.depth)} mm</span>
            <button class="icon-btn sm ghost danger" data-act="del-zone" data-v="${i}" title="Remove zone" aria-label="Remove zone ${i + 1}">${icon('x')}</button></div>
            ${zi === i && zone ? zoneFields(zone) : ''}`,
        )
        .join('')}</div>`
    : `<p class="field-note">Make part of the pocket deeper (under a handle) or shallower (a raised step).</p>`;
  return `
    <div class="props-head">
      <span class="swatch lg" style="background:${colorOf(idx)}"></span>
      <input type="text" data-key="item.name" value="${esc(it.name)}" aria-label="Item name" placeholder="Item name">
      <button class="icon-btn ghost" data-act="dup" title="Duplicate (Ctrl+D)" aria-label="Duplicate">${icon('copy')}</button>
      <button class="icon-btn ghost danger" data-act="del-item" title="Delete (Del)" aria-label="Delete item">${icon('trash')}</button>
    </div>
    <div class="props-meta">Outline ${fmt(w)} × ${fmt(h)} mm</div>
    <section class="group">
      <h4>Pocket</h4>
      ${field('Depth', num('item.depth', it.depth, 'mm', { min: 0.5, max: 300, step: 0.5 }))}
      ${field(
        'Rotation',
        `${num('item.rotation', normDeg(it.rotation), '°', { step: 1 })}
         <button class="icon-btn sm" data-act="rot" data-v="-90" title="Rotate 90° left (Shift+R)" aria-label="Rotate 90° left">${icon('rotateCcw')}</button>
         <button class="icon-btn sm" data-act="rot" data-v="90" title="Rotate 90° right (R)" aria-label="Rotate 90° right">${icon('rotateCw')}</button>`,
      )}
      ${field('Position', `${num('item.x', it.x, 'X', { step: 0.5, prefix: true })}${num('item.y', it.y, 'Y', { step: 0.5, prefix: true })}`)}
    </section>
    <section class="group">
      <div class="group-head"><h4>Finger notches</h4><button class="btn xs" data-act="add-notch">${icon('plus')}Add</button></div>
      ${notches}
    </section>
    <section class="group">
      <div class="group-head"><h4>Depth zones</h4>
        <div class="group-actions"><button class="btn xs" data-act="add-zone" data-v="rect" title="Add a rectangular zone">${icon('square')}Rect</button><button class="btn xs" data-act="add-zone" data-v="circle" title="Add a round zone">${icon('circle')}Circle</button></div></div>
      ${zones}
    </section>`;
}

function zoneFields(z: DepthZone): string {
  const size =
    z.kind === 'circle'
      ? field('Diameter', num('zone.w', z.w, 'mm', { min: 1, step: 0.5 }))
      : field('Width', num('zone.w', z.w, 'mm', { min: 1, step: 0.5 })) + field('Height', num('zone.h', z.h, 'mm', { min: 1, step: 0.5 }));
  return `<div class="zone-fields">
    ${field('Depth', num('zone.depth', z.depth, 'mm', { min: 0.5, max: 300, step: 0.5 }))}
    ${size}
    ${z.kind === 'rect' ? field('Rotation', num('zone.rotation', normDeg(z.rotation), '°', { step: 5 })) : ''}
  </div>`;
}

function binProps(): string {
  const s = S.settings;
  const needZ = requiredHeightUnits(S.items, s);
  return `
    <section class="group">
      <h4>Size</h4>
      ${toggle('s.autoSize', 'Auto size', s.autoSize, 'Grow the bin to fit the items')}
      ${field('Width', num('s.unitsX', s.unitsX, 'u', { min: 1, max: 20, disabled: s.autoSize }))}
      ${field('Depth', num('s.unitsY', s.unitsY, 'u', { min: 1, max: 20, disabled: s.autoSize }))}
      ${field(`Height<small>0 = auto (now ${Math.max(needZ, s.unitsZ)}u)</small>`, num('s.unitsZ', s.unitsZ, 'u', { min: 0, max: 40 }))}
      ${field('Printer bed limit', num('s.maxUnits', s.maxUnits, 'u', { min: 1, max: 20 }))}
    </section>
    <section class="group">
      <h4>Base &amp; top</h4>
      ${toggle('s.magnets', 'Magnet holes', s.magnets, '6 × 2 mm, four per cell')}
      ${toggle('s.lip', 'Stacking lip', s.lip)}
    </section>
    <section class="group">
      <h4>Pockets</h4>
      ${field('Clearance', num('s.clearance', s.clearance, 'mm', { min: 0, max: 5, step: 0.1 }))}
      ${field('Wall between pockets', num('s.spacing', s.spacing, 'mm', { min: 0.8, max: 10, step: 0.1 }))}
      ${field('Finger notch radius', num('s.fingerRadius', s.fingerRadius, 'mm', { min: 4, max: 25, step: 0.5 }))}
      ${field('Finger notch depth<small>0 = auto</small>', num('s.fingerDepth', s.fingerDepth, 'mm', { min: 0, max: 150, step: 0.5 }))}
    </section>
    <section class="group">
      <h4>Edges</h4>
      ${field('Pocket rims', edgeControl('rim'))}
      ${s.rimEdge.type !== 'none' ? field('', num('s.rimEdge.size', s.rimEdge.size, 'mm', { min: 0.2, max: 5, step: 0.1 })) : ''}
      ${field('Depth steps', edgeControl('step'))}
      ${s.stepEdge.type !== 'none' ? field('', num('s.stepEdge.size', s.stepEdge.size, 'mm', { min: 0.2, max: 5, step: 0.1 })) : ''}
    </section>`;
}

function renderProps() {
  const props = $('props');
  $('ptab-item').setAttribute('aria-selected', String(tab === 'item'));
  $('ptab-bin').setAttribute('aria-selected', String(tab === 'bin'));
  renderKeepingFocus(props, () => {
    if (tab === 'bin') props.innerHTML = binProps();
    else {
      const it = selectedItem();
      props.innerHTML = it
        ? itemProps(it)
        : `<div class="props-placeholder">${icon('pointer')}<b>No item selected</b><span>Click an item in the layout or the list to edit it.</span></div>`;
    }
  });
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // After the current event, so focus has already moved (e.g. on Tab) before re-rendering.
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
    renderProps();
  });
}

// ------------------------------------------------------------------ events
function onPropsChange(e: Event) {
  const t = e.target as HTMLInputElement;
  const key = t.dataset.key;
  if (!key) return;
  const s = S.settings;
  const it = selectedItem();
  const z = it && S.sel.zone !== null ? it.zones[S.sel.zone] : undefined;
  if (t.type === 'checkbox') {
    const on = t.checked;
    if (key === 's.autoSize') {
      s.autoSize = on;
      S.layoutWarnings = [];
      if (on) arrange();
      else changed();
    } else if (key === 's.magnets') (s.magnets = on), changed();
    else if (key === 's.lip') (s.lip = on), changed();
    return;
  }
  if (key === 'item.name') return; // handled on input
  const v = parseFloat(t.value);
  if (!Number.isFinite(v)) return scheduleRender(); // restore the previous value
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  switch (key) {
    case 'item.depth': if (it) (it.depth = clamp(v, 0.5, 300)), changed(); break;
    case 'item.rotation': if (it) (it.rotation = normDeg(v)), changed({ refit: true }); break;
    case 'item.x': if (it) (it.x = v), changed({ refit: true }); break;
    case 'item.y': if (it) (it.y = v), changed({ refit: true }); break;
    case 'zone.depth': if (z) (z.depth = clamp(v, 0.5, 300)), changed(); break;
    case 'zone.w': if (z) { z.w = Math.max(1, v); if (z.kind === 'circle') z.h = z.w; changed(); } break;
    case 'zone.h': if (z) (z.h = Math.max(1, v)), changed(); break;
    case 'zone.rotation': if (z) (z.rotation = normDeg(v)), changed(); break;
    case 's.unitsX': s.unitsX = Math.round(clamp(v, 1, 20)); S.layoutWarnings = []; changed(); break;
    case 's.unitsY': s.unitsY = Math.round(clamp(v, 1, 20)); S.layoutWarnings = []; changed(); break;
    case 's.unitsZ': s.unitsZ = Math.round(clamp(v, 0, 40)); changed(); break;
    case 's.maxUnits': s.maxUnits = Math.round(clamp(v, 1, 20)); changed({ refit: true }); break;
    case 's.clearance': s.clearance = clamp(v, 0, 5); changed({ refit: true }); break;
    case 's.spacing': s.spacing = clamp(v, 0.8, 10); changed({ refit: true }); break;
    case 's.fingerRadius': s.fingerRadius = clamp(v, 4, 25); changed({ refit: true }); break;
    case 's.fingerDepth': s.fingerDepth = clamp(v, 0, 150); changed(); break;
    case 's.rimEdge.size': s.rimEdge = { ...s.rimEdge, size: clamp(v, 0.2, 5) }; changed({ refit: true }); break;
    case 's.stepEdge.size': s.stepEdge = { ...s.stepEdge, size: clamp(v, 0.2, 5) }; changed(); break;
  }
}

function onPropsClick(e: Event) {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || !$('props').contains(el)) return;
  const it = selectedItem();
  const v = el.dataset.v ?? '';
  switch (el.dataset.act) {
    case 'dup': if (it) duplicateItem(it.id); break;
    case 'del-item': if (it) removeItem(it.id); break;
    case 'rot': if (it) (it.rotation = normDeg(it.rotation + +v)), changed({ refit: true }); break;
    case 'add-notch': if (it) it.notches.push(suggestNotch(it)), changed({ refit: true }); break;
    case 'del-notch': if (it) it.notches.splice(+v, 1), changed({ refit: true }); break;
    case 'add-zone':
      if (it) {
        it.zones.push(defaultZone(it, v as DepthZone['kind']));
        select(it.id, it.zones.length - 1);
        changed();
      }
      break;
    case 'sel-zone': if (it) select(it.id, S.sel.zone === +v ? null : +v); break;
    case 'del-zone':
      if (it) {
        it.zones.splice(+v, 1);
        select(it.id, null);
        changed();
      }
      break;
    case 'edge': {
      const [which, type] = v.split(':') as ['rim' | 'step', 'none' | 'chamfer' | 'fillet'];
      const key = which === 'rim' ? 'rimEdge' : 'stepEdge';
      S.settings[key] = { ...S.settings[key], type };
      changed({ refit: which === 'rim' });
      break;
    }
  }
}

export function setPropsTab(t: PropsTab) {
  tab = t;
  scheduleRender();
}

export function initPanels() {
  on('changed', scheduleRender);
  on('selection', () => {
    if (S.sel.item !== null) tab = 'item';
    scheduleRender();
  });
  $('item-list').addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.item-row');
    if (row) select(+row.dataset.id!, null);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-ptab]').forEach((b) =>
    b.addEventListener('click', () => setPropsTab(b.dataset.ptab as PropsTab)),
  );
  const props = $('props');
  props.addEventListener('change', onPropsChange);
  props.addEventListener('click', onPropsClick);
  props.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if ((e.key === 'Enter' || e.key === ' ') && t.dataset.act === 'sel-zone') {
      e.preventDefault();
      t.click();
    }
    // Enter in a number box applies the value right away.
    if (e.key === 'Enter' && t instanceof HTMLInputElement && t.type === 'number') t.dispatchEvent(new Event('change', { bubbles: true }));
  });
  props.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.key !== 'item.name') return;
    const it = selectedItem();
    if (!it) return;
    it.name = t.value;
    renderList();
    changed();
  });
  scheduleRender();
}
