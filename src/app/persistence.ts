// Undo/redo history, autosave, the Designs dialog (save / open / delete / export / import).
import { BinSettings, Item, defaultSettings } from '../layout';
import {
  Design,
  History,
  deleteFromLibrary,
  listSaved,
  loadAutosave,
  makeDesign,
  parseDesign,
  saveAutosave,
  saveToLibrary,
} from '../storage';
import { $, downloadBlob, esc, safeName } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { S, changed, emit, on } from './store';

const history = new History();
let commitTimer = 0;
let lastAutosaved = '';
let saveFailed = false;

/** The state undo and autosave track (no timestamps, so equal states compare equal). */
const snapshot = () => JSON.stringify({ name: S.designName, settings: S.settings, items: S.items });

function scheduleCommit() {
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commitNow, 300);
  setSaveState('pending');
}

/** Records the current state as an undo step (if it changed) and autosaves it. */
export function commitNow() {
  clearTimeout(commitTimer);
  const snap = snapshot();
  history.commit(snap);
  // Autosave whenever the design differs from what was last saved, including after undo/redo.
  if (snap !== lastAutosaved) {
    if (saveAutosave(makeDesign(S.designName, S.items, S.settings))) {
      lastAutosaved = snap;
      saveFailed = false;
    } else if (!saveFailed) {
      saveFailed = true;
      toast("Couldn't autosave: browser storage is unavailable or full. Use Designs → Export file to keep a copy.", 'warn', 6000);
    }
  }
  setSaveState(saveFailed ? 'failed' : 'saved');
  updateChrome();
}

function setSaveState(state: 'pending' | 'saved' | 'failed') {
  const el = $('save-state');
  el.innerHTML =
    state === 'failed' ? `${icon('alert')}Not saved` : state === 'pending' ? 'Saving…' : `${icon('check')}Saved in this browser`;
}

function updateChrome() {
  $<HTMLButtonElement>('undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = !history.canRedo;
  const input = $<HTMLInputElement>('design-name');
  if (document.activeElement !== input) input.value = S.designName;
  document.title = `${S.designName} · Gridfinity Tracer`;
}

/** Replaces the whole design and refreshes everything. */
export function applyState(state: { name: string; settings: BinSettings; items: Item[] }, keepSelection = false) {
  const prevSel = S.sel;
  S.items.length = 0;
  S.items.push(...structuredClone(state.items));
  S.nextId = Math.max(0, ...S.items.map((i) => i.id)) + 1;
  Object.assign(S.settings, structuredClone(state.settings));
  S.designName = state.name;
  S.layoutWarnings = [];
  // Undo/redo keep the selection when the selected item (and zone) still exist.
  const keep = keepSelection && prevSel.item !== null ? S.items.find((i) => i.id === prevSel.item) : undefined;
  S.sel = keep ? { item: keep.id, zone: prevSel.zone !== null && prevSel.zone < keep.zones.length ? prevSel.zone : null } : { item: null, zone: null };
  emit('selection');
  emit('meta');
  changed();
  updateChrome();
}

export function undo() {
  commitNow();
  const s = history.undo();
  if (s) applyState(JSON.parse(s), true);
  updateChrome();
}
export function redo() {
  commitNow();
  const s = history.redo();
  if (s) applyState(JSON.parse(s), true);
  updateChrome();
}

/** Loads a design as a single undoable step. */
function load(design: Design | { name: string; settings: BinSettings; items: Item[] }) {
  commitNow();
  applyState(design);
  commitNow();
}

export function newDesign() {
  load({ name: 'Untitled', settings: defaultSettings(), items: [] });
  toast('Started a new design. Undo brings the previous one back.', 'info');
}

export function importDesignFile(file: File, after?: () => void) {
  file
    .text()
    .then((text) => {
      const design = parseDesign(JSON.parse(text));
      load(design);
      after?.();
      toast(`Opened "${design.name}" (${design.items.length} item${design.items.length === 1 ? '' : 's'}).`, 'success');
    })
    .catch((err) => {
      const msg = err instanceof SyntaxError ? "it isn't valid JSON." : (err as Error).message;
      $('designs-status').textContent = `Couldn't import that file: ${msg}`;
      toast(`Couldn't open that file: ${msg}`, 'error', 5000);
    });
}

/** Ctrl+S: save under the current name (asks for a name first if it's still Untitled). */
export function quickSave() {
  if (S.designName === 'Untitled') return openDialog(true);
  commitNow();
  if (saveToLibrary(makeDesign(S.designName, S.items, S.settings))) toast(`Saved "${S.designName}".`, 'success');
  else toast("Couldn't save: browser storage is unavailable or full. Use Export file instead.", 'error', 5000);
}

// ------------------------------------------------------------------ dialog
const dialog = () => $<HTMLDialogElement>('designs-dialog');

function renderLibrary() {
  const list = $('designs-list');
  list.innerHTML = listSaved()
    .map(
      (e, i) => `<div class="design-row">
        <div class="info"><b>${esc(e.name)}</b><span class="hint">${esc(new Date(e.savedAt).toLocaleString())} · ${e.itemCount} item${e.itemCount === 1 ? '' : 's'}</span></div>
        <button type="button" class="btn sm" data-open="${i}">Open</button>
        <button type="button" class="icon-btn sm ghost danger" data-del="${i}" title="Delete" aria-label="Delete ${esc(e.name)}">${icon('trash')}</button>
      </div>`,
    )
    .join('');
}

export function openDialog(focusName = false) {
  const input = $<HTMLInputElement>('design-name-input');
  input.value = S.designName === 'Untitled' ? '' : S.designName;
  $('designs-status').textContent = '';
  renderLibrary();
  dialog().showModal();
  if (focusName) input.focus();
}

export function initPersistence() {
  on('changed', scheduleCommit);
  on('meta', scheduleCommit);

  const nameInput = $<HTMLInputElement>('design-name');
  nameInput.addEventListener('input', () => {
    S.designName = nameInput.value.trim() || 'Untitled';
    document.title = `${S.designName} · Gridfinity Tracer`;
    scheduleCommit();
  });
  nameInput.addEventListener('blur', () => (nameInput.value = S.designName));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur();
  });

  $('undo').addEventListener('click', undo);
  $('redo').addEventListener('click', redo);
  $('new-design').addEventListener('click', newDesign);
  $('open-designs').addEventListener('click', () => openDialog());

  $('designs-list').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-open],[data-del]');
    if (!t) return;
    const entry = listSaved()[+(t.dataset.open ?? t.dataset.del!)];
    if (!entry) return;
    if (t.dataset.open !== undefined) {
      load(entry.design);
      dialog().close();
      toast(`Opened "${entry.name}". Undo goes back to what you had.`, 'success');
    } else if (confirm(`Delete the saved design "${entry.name}"? This can't be undone.`)) {
      deleteFromLibrary(entry.name);
      renderLibrary();
    }
  });

  $('save-design').addEventListener('click', () => {
    const name = $<HTMLInputElement>('design-name-input').value.trim() || 'Untitled';
    if (listSaved().some((e) => e.name === name) && name !== S.designName && !confirm(`Replace the saved design "${name}"?`)) return;
    S.designName = name;
    emit('meta');
    commitNow();
    if (saveToLibrary(makeDesign(name, S.items, S.settings))) {
      $('designs-status').textContent = `Saved "${name}".`;
      toast(`Saved "${name}".`, 'success');
    } else $('designs-status').textContent = "Couldn't save: browser storage is unavailable or full. Use Export file instead.";
    renderLibrary();
  });
  $('design-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('save-design').click();
    }
  });

  $('export-design').addEventListener('click', () => {
    const name = $<HTMLInputElement>('design-name-input').value.trim() || S.designName;
    const blob = new Blob([JSON.stringify(makeDesign(name, S.items, S.settings), null, 1)], { type: 'application/json' });
    downloadBlob(blob, `${safeName(name)}.gridfinity.json`);
    $('designs-status').textContent = 'Exported. Keep the file to open this design later or on another computer.';
  });

  $<HTMLInputElement>('import-design').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) importDesignFile(file, () => dialog().close());
  });
}

/** Restores the autosaved design, if any. Returns true if one was restored. */
export function restoreAutosave(): boolean {
  const restored = loadAutosave();
  const ok = !!restored && (restored.items.length > 0 || restored.name !== 'Untitled');
  if (ok) applyState(restored!);
  history.reset(snapshot());
  lastAutosaved = snapshot();
  setSaveState('saved');
  updateChrome();
  return ok;
}
