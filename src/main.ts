// App entry: wires the views together, generates the model, keyboard shortcuts, drag & drop.
import Module, { Manifold, ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { buildBin, toStl } from './gridfinity';
import { clampToBin } from './layout';
import { Preview, CameraView } from './preview';
import { $, downloadBlob, isTyping, safeName } from './ui/dom';
import { hydrateIcons, icon } from './ui/icons';
import { toast } from './ui/toast';
import { S, addItem, arrange, changed, duplicateItem, on, removeItem, select, selectedItem, testShape } from './app/store';
import { LayoutView, normDeg } from './app/layoutView';
import { initPanels } from './app/panels';
import { commitNow, importDesignFile, initPersistence, newDesign, openDialog, quickSave, redo, restoreAutosave, setUndoTarget, undo } from './app/persistence';
import { captureKey, captureRedo, captureUndo, captureUndoTarget, detected, initCapture, loadPhotoFile, traceClientPoint } from './app/capture';

hydrateIcons();

// ------------------------------------------------------------------ tabs
type Tab = 'template' | 'capture' | 'design';
let currentTab: Tab = 'template';
function setTab(tab: Tab) {
  currentTab = tab;
  for (const t of ['template', 'capture', 'design'] as Tab[]) {
    $(`view-${t}`).hidden = t !== tab;
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
  }
  if (tab === 'design') layout.draw();
  setUndoTarget(tab === 'capture' ? captureUndoTarget : null);
  window.scrollTo({ top: 0 });
}
document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as Tab)));
document.addEventListener('click', (e) => {
  const go = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
  if (go) setTab(go.dataset.goto as Tab);
});

// ------------------------------------------------------------------ design workspace
const layout = new LayoutView($<HTMLCanvasElement>('layout-canvas'));
const preview = new Preview($('viewer'));

type ViewMode = 'layout' | 'split' | '3d';
function setViewMode(mode: ViewMode) {
  $('stage-body').dataset.mode = mode;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  try {
    localStorage.setItem('gt:viewMode', mode);
  } catch {
    /* per-viewer convenience only */
  }
  layout.draw();
}
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode as ViewMode)));
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach((b) =>
  b.addEventListener('click', () => {
    preview.setView(b.dataset.cam as CameraView);
    document.querySelectorAll('[data-cam]').forEach((o) => o.classList.toggle('active', o === b));
  }),
);
$('fit-view').addEventListener('click', () => layout.fit());
$('arrange').addEventListener('click', () => {
  if (!S.items.length) return;
  arrange();
  layout.fit();
  toast('Packed the items into the smallest bin. Undo to go back.', 'info');
});
const addTest = () => {
  const it = addItem(testShape());
  arrange();
  select(it.id);
};
$('add-test').addEventListener('click', addTest);
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-act="add-test"]')) addTest();
});

function applyTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  preview.setTheme({ background: v('--canvas-bg'), gridMajor: v('--border-strong'), gridMinor: v('--border'), model: v('--model') });
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ------------------------------------------------------------------ model generation
let wasm: ManifoldToplevel | null = null;
let model: Manifold | null = null;
let regenTimer = 0;
on('changed', () => {
  clearTimeout(regenTimer);
  regenTimer = window.setTimeout(regenerate, 220);
});

function setWarnings(list: string[]) {
  $('warnings').innerHTML = list.map((w) => `<li>${icon('alert')}<span></span></li>`).join('');
  $('warnings').querySelectorAll('span').forEach((s, i) => (s.textContent = list[i]));
  const btn = $('warn-btn');
  btn.hidden = list.length === 0;
  $('warn-text').textContent = list.length === 1 ? list[0] : `${list.length} warnings`;
  if (!list.length) $('warnings').hidden = true;
}
$('warn-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const pop = $('warnings');
  pop.hidden = !pop.hidden;
  if (!pop.hidden) {
    const r = $('warn-btn').getBoundingClientRect();
    pop.style.left = `${Math.max(16, Math.min(r.left, window.innerWidth - pop.offsetWidth - 16))}px`;
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#warnings')) $('warnings').hidden = true;
});

function regenerate() {
  if (!wasm) return;
  try {
    const t0 = performance.now();
    const res = buildBin(wasm, S.items, S.settings);
    model?.delete();
    model = res.manifold;
    preview.show(model);
    setWarnings([...S.layoutWarnings, ...res.warnings]);
    const [w, d, h] = res.size;
    $('model-info').textContent = `${S.settings.unitsX} × ${S.settings.unitsY} × ${res.unitsZ}u  ·  ${w.toFixed(1)} × ${d.toFixed(1)} × ${h.toFixed(1)} mm`;
    $('gen-info').textContent = `${model.numTri().toLocaleString()} triangles · ${Math.round(performance.now() - t0)} ms`;
    $<HTMLButtonElement>('download-stl').disabled = false;
    document.body.dataset.modelReady = String(Date.now());
  } catch (err) {
    console.error(err);
    setWarnings([`Model generation failed: ${(err as Error).message}`]);
  }
}

$('download-stl').addEventListener('click', () => {
  if (!model) return;
  const s = S.settings;
  const base = S.designName !== 'Untitled' ? safeName(S.designName) : S.items.length === 1 ? safeName(S.items[0].name, 'bin') : 'bin';
  downloadBlob(new Blob([toStl(model)], { type: 'model/stl' }), `gridfinity-${s.unitsX}x${s.unitsY}-${base}.stl`);
  toast('STL downloaded. Open it in your slicer.', 'success');
});

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = isTyping(e.target);
  if (document.querySelector('dialog[open]')) return;
  if (mod && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 's') {
      e.preventDefault();
      quickSave();
      return;
    }
    if (typing && (e.target as HTMLInputElement).type === 'text') return; // text boxes keep their own undo
    // On the Photo step, undo applies to outline edits.
    if (k === 'z' && !e.shiftKey) (e.preventDefault(), (currentTab === 'capture' && captureUndo()) || (currentTab !== 'capture' && undo()));
    else if ((k === 'z' && e.shiftKey) || k === 'y') (e.preventDefault(), (currentTab === 'capture' && captureRedo()) || (currentTab !== 'capture' && redo()));
    else if (k === 'd' && currentTab === 'design' && selectedItem()) (e.preventDefault(), duplicateItem(selectedItem()!.id));
    return;
  }
  if (typing && e.key === 'Escape') return void (e.target as HTMLElement).blur(); // Esc leaves a text box
  if (typing || e.altKey) return;
  if (e.key === '?') return void (document.getElementById('shortcuts-dialog') as HTMLDialogElement).showModal();
  if (currentTab === 'capture') {
    if (captureKey(e)) e.preventDefault();
    return;
  }
  if (currentTab !== 'design') return;
  const it = selectedItem();
  const zone = it && S.sel.zone !== null ? it.zones[S.sel.zone] : null;
  switch (e.key) {
    case 'Escape':
      if (zone) select(it!.id, null);
      else select(null);
      break;
    case 'Delete':
    case 'Backspace':
      if (zone) {
        it!.zones.splice(S.sel.zone!, 1);
        select(it!.id, null);
        changed();
      } else if (it) removeItem(it.id);
      else return;
      break;
    case 'r':
    case 'R':
      if (!it) return;
      it.rotation = normDeg(it.rotation + (e.shiftKey ? -90 : 90));
      changed({ refit: true });
      break;
    case '[':
    case ']':
      if (!it) return;
      it.rotation = normDeg(it.rotation + (e.key === ']' ? 15 : -15));
      changed({ refit: true });
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      if (!it) return;
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      if (zone) {
        // Zones live in the item's own (rotated) frame.
        const a = (-it.rotation * Math.PI) / 180;
        zone.x += dx * Math.cos(a) - dy * Math.sin(a);
        zone.y += dx * Math.sin(a) + dy * Math.cos(a);
        changed();
      } else {
        it.x += dx;
        it.y += dy;
        clampToBin(it, S.settings);
        changed({ refit: true });
      }
      break;
    }
    case 'f':
    case 'F':
      layout.fit();
      break;
    case '1':
      setViewMode('layout');
      break;
    case '2':
      setViewMode('split');
      break;
    case '3':
      setViewMode('3d');
      break;
    default:
      return;
  }
  e.preventDefault();
});
$('show-shortcuts').addEventListener('click', () => ($('shortcuts-dialog') as HTMLDialogElement).showModal());

// ------------------------------------------------------------------ drag & drop
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('drop-overlay').hidden = false;
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) (dragDepth = 0), ($('drop-overlay').hidden = true);
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const file = e.dataTransfer!.files[0];
  if (!file) return;
  if (file.type.startsWith('image/')) {
    setTab('capture');
    loadPhotoFile(file);
  } else if (file.name.endsWith('.json') || file.type === 'application/json') {
    importDesignFile(file, () => setTab('design'));
  } else toast("That file isn't a photo or a design file.", 'warn');
});

// ------------------------------------------------------------------ boot
initPanels();
initPersistence();
initCapture({ onAdded: () => setTab('design') });

let initialMode: ViewMode = window.innerWidth >= 1200 ? 'split' : 'layout';
try {
  const saved = localStorage.getItem('gt:viewMode') as ViewMode | null;
  if (saved && ['layout', 'split', '3d'].includes(saved)) initialMode = saved;
} catch {
  /* ignore */
}
setViewMode(initialMode);

const restored = restoreAutosave();
setTab(restored && S.items.length ? 'design' : 'template');
if (restored) toast(`Restored "${S.designName}" (${S.items.length} item${S.items.length === 1 ? '' : 's'}). Use New to start fresh.`, 'info', 5000);
changed();

(async () => {
  wasm = await Module({ locateFile: () => wasmUrl });
  wasm.setup();
  regenerate();
})();

// Exposed for automated tests.
(window as unknown as { __gt: unknown }).__gt = {
  items: S.items,
  settings: S.settings,
  get detected() {
    return detected;
  },
  get sel() {
    return S.sel;
  },
  undo,
  redo,
  commitNow,
  select,
  setTab,
  newDesign,
  openDialog,
  clientPoint: (x: number, y: number) => layout.clientPoint({ x, y }),
  traceClientPoint,
  captureUndo,
};
