// Steps 1 and 2: the printable template, and turning a photo into item outlines.
import { Point, Rect, SHEETS, SheetSpec, TEMPLATE_GRID, ignoreZones, markerCenters, workRegion } from '../sheet';
import { downloadTemplateSvg, openPrintableTemplate, templateSvg } from '../template';
import { RGBAImage } from '../vision/image';
import { detectMarkers } from '../vision/markers';
import { rectify } from '../vision/homography';
import { dewarpByGrid } from '../vision/dewarp';
import { DetectedOutline, SegmentResult, segmentItems } from '../vision/segment';
import { PathNode, bboxOf, flatten, pathFromPolygon, polygonArea } from '../vision/path';
import { Tool, TraceShape, TraceView } from './traceView';
import { bestOrientation, centreLoops } from '../layout';
import { $, esc, fmt } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { PALETTE, S, addItem, arrange } from './store';
import { UndoTarget, updateChrome } from './persistence';

const PPM = 4; // pixels per mm in the rectified image

export interface Detected extends TraceShape {
  outline: DetectedOutline;
  name: string;
  depth: number;
  /** Changed by hand: kept as it is when detection re-runs. */
  edited: boolean;
  /** Drawn by hand rather than detected. */
  traced: boolean;
}

let sheet: SheetSpec = SHEETS.a4;
let photo: RGBAImage | null = null;
let photoSrc: HTMLCanvasElement | null = null;
let corners: Point[] = [];
let markersFound = true;
let rectified: RGBAImage | null = null;
let segResult: SegmentResult | null = null;
let rectOrigin: Point = { x: 0, y: 0 };
let segIgnore: Rect[] = [];
let rectImage: HTMLCanvasElement | null = null;
let nextId = 1;
let view: TraceView<Detected> | null = null;
/** How much the grid had to straighten the sheet (paper curl, lens distortion), mm. */
let gridCorrection = 0;
/** Detection method: from where the grid is hidden (current template), or by brightness. */
let method: 'grid' | 'brightness' = 'brightness';
export let detected: Detected[] = [];

const AUTO_KEY = 'gt.autoDetect';
const autoDetect = () => $<HTMLInputElement>('auto-detect').checked;
const refMode = () => $<HTMLSelectElement>('ref-mode').value as 'template' | 'manual';
const colour = (d: Detected) => PALETTE[(d.id - 1) % PALETTE.length];

function status(msg: string, kind: '' | 'ok' | 'warn' = '') {
  const el = $('photo-status');
  el.className = `status-chip ${kind}`;
  el.innerHTML = msg ? `${icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info')}<span>${esc(msg)}</span>` : '';
}

// ------------------------------------------------------------------ undo (Photo step)
type Snap = Pick<Detected, 'id' | 'paths' | 'use' | 'name' | 'depth' | 'edited' | 'traced'>[];
const snap = (): string =>
  JSON.stringify(detected.map(({ id, paths, use, name, depth, edited, traced }) => ({ id, paths, use, name, depth, edited, traced })));
const history = {
  undo: [] as string[],
  redo: [] as string[],
  push() {
    this.undo.push(snap());
    if (this.undo.length > 100) this.undo.shift();
    this.redo = [];
    updateChrome();
  },
  clear() {
    this.undo = [];
    this.redo = [];
    updateChrome();
  },
};
function restore(json: string) {
  const sel = view?.selected ?? null;
  detected = (JSON.parse(json) as Snap).map((d) => makeShape(d.paths, d));
  if (view) {
    view.active = null;
    if (!detected.some((d) => d.id === sel)) view.select(null);
  }
  renderDetected();
  drawRectified();
  updateChrome();
}
/** Undo / redo of outline edits; false when there's nothing to undo. */
export function captureUndo(): boolean {
  const s = history.undo.pop();
  if (s === undefined) return false;
  history.redo.push(snap());
  restore(s);
  return true;
}
export function captureRedo(): boolean {
  const s = history.redo.pop();
  if (s === undefined) return false;
  history.undo.push(snap());
  restore(s);
  return true;
}
export const captureUndoTarget: UndoTarget = {
  undo: captureUndo,
  redo: captureRedo,
  canUndo: () => history.undo.length > 0,
  canRedo: () => history.redo.length > 0,
};
/** Keys for the tracing view (when the Photo step is showing). */
export const captureKey = (e: KeyboardEvent) => !!view && !!rectified && view.key(e);
/** Client coordinates of a point in sheet mm on the tracing view (for tests). */
export const traceClientPoint = (x: number, y: number) => view?.clientPoint(x, y);

const TOOL_HINTS: Record<Tool, string> = {
  edit: 'Drag a shape to move it, or its points to reshape it. Double-click the outline to add a point, a point to switch corner / curve. Del removes.',
  pen: 'Click to place corners, click and drag for curves. Click the first point (or press Enter) to close the shape. Esc cancels.',
  rect: 'Drag to draw a rectangle.',
  circle: 'Drag from the centre to draw a circle.',
};
function syncTool(t: Tool) {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  $('trace-hint').textContent = TOOL_HINTS[t];
}
/** Updates just the size in a shape's row while it's being dragged. */
function updateRowSize(d: Detected) {
  const row = $('detected-body').querySelector(`[data-i="${detected.indexOf(d)}"] .det-meta span`);
  if (row) row.textContent = `${fmt(d.outline.bbox.w)} × ${fmt(d.outline.bbox.h)} mm · edited`;
}

// ------------------------------------------------------------------ template
function renderTemplatePreview() {
  $('template-preview').innerHTML = templateSvg(sheet);
}

// ------------------------------------------------------------------ photo loading
export async function loadPhotoFile(file: Blob) {
  status('Loading photo…');
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    photo = ctx.getImageData(0, 0, c.width, c.height);
    photoSrc = c;
    $('capture-empty').hidden = true;
    $('capture-work').hidden = false;
    detected = [];
    history.clear();
    view?.select(null);
    initCorners();
    processPhoto();
    // Tracing by hand: have the pen ready.
    if (!autoDetect()) view?.setTool('pen');
  } catch (err) {
    console.error(err);
    status(`Couldn't read that image: ${(err as Error).message}`, 'warn');
  }
}

function initCorners() {
  if (!photo) return;
  if (refMode() === 'template') {
    const found = detectMarkers(photo, sheet.height >= sheet.width);
    markersFound = !!found;
    if (found) {
      corners = found;
      return;
    }
  }
  const w = photo.width, h = photo.height, m = 0.12;
  corners = [
    { x: w * m, y: h * m },
    { x: w * (1 - m), y: h * m },
    { x: w * (1 - m), y: h * (1 - m) },
    { x: w * m, y: h * (1 - m) },
  ];
}

function reference(): { sheetPts: Point[]; region: Rect; ignore: Rect[] } {
  if (refMode() === 'template') return { sheetPts: markerCenters(sheet), region: workRegion(sheet), ignore: ignoreZones(sheet) };
  const w = Math.max(10, +$<HTMLInputElement>('ref-w').value || 180);
  const h = Math.max(10, +$<HTMLInputElement>('ref-h').value || 250);
  return { sheetPts: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], region: { x: 0, y: 0, w, h }, ignore: [] };
}

function processPhoto() {
  if (!photo) return;
  const { sheetPts, region, ignore } = reference();
  try {
    rectified = rectify(photo, corners, sheetPts, region, PPM);
  } catch {
    status('The corner handles form an invalid shape. Drag them onto the reference corners.', 'warn');
    drawPhoto();
    return;
  }
  // With the printed template, use its grid to undo paper curl and lens distortion.
  method = 'brightness';
  if (refMode() === 'template') {
    const markers = ignore.map((z) => ({ x: z.x - region.x, y: z.y - region.y, w: z.w, h: z.h })).filter((z) => z.w < 30 && z.h < 30);
    const dw = dewarpByGrid(rectified, PPM, TEMPLATE_GRID, markers);
    gridCorrection = dw ? dw.maxShiftMm : 0;
    method = dw?.boldLines ? 'grid' : 'brightness';
    if (dw) rectified = dw.image;
  }
  rectOrigin = { x: region.x, y: region.y };
  segIgnore = ignore;
  rectImage = document.createElement('canvas');
  rectImage.width = rectified.width;
  rectImage.height = rectified.height;
  rectImage.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rectified.data), rectified.width, rectified.height), 0, 0);
  view?.setImage(rectImage, rectOrigin, PPM);
  runSegmentation();
}

/** Recomputes a shape's polygon outline from its editable paths. */
function refreshOutline(d: Detected) {
  d.loops = d.paths.map((p) => flatten(p));
  const pts = d.loops.flat();
  d.outline = {
    loops: d.loops,
    bbox: bboxOf(pts),
    areaMm2: d.loops.reduce((a, l, i) => a + (i === 0 ? 1 : -1) * polygonArea(l), 0),
  };
}

function makeShape(paths: PathNode[][], extra: Partial<Detected> = {}): Detected {
  const d: Detected = {
    id: extra.id ?? nextId++,
    paths,
    loops: [],
    outline: { loops: [], bbox: { x: 0, y: 0, w: 0, h: 0 }, areaMm2: 0 },
    use: true,
    name: `Item ${S.items.length + detected.length + 1}`,
    depth: 12,
    edited: false,
    traced: false,
    ...extra,
  };
  refreshOutline(d);
  return d;
}

const overlapRatio = (a: Rect, b: Rect) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.max(1e-6, Math.min(a.w * a.h, b.w * b.h)) : 0;
};

/** Re-runs item detection (after a new photo, corner or slider change). Hand-edited shapes stay. */
function runSegmentation() {
  if (!rectified) return;
  if (!autoDetect()) {
    // Tracing by hand: only the shapes drawn or edited by hand.
    segResult = null;
    detected = detected.filter((d) => d.edited || d.traced);
    if (view && view.selected !== null && !detected.some((d) => d.id === view!.selected)) view.select(null);
    if (refMode() === 'template' && !markersFound)
      status("Couldn't find the four black squares. Drag handles 1–4 onto their centres (1 = top-left of the sheet).", 'warn');
    else if (refMode() === 'manual') status('Drag handles 1–4 onto the corners of your reference rectangle (1 → 2 is the width).');
    else {
      const straightened = gridCorrection >= 0.5 ? ` · sheet straightened (up to ${gridCorrection.toFixed(1)} mm)` : '';
      status(`Template found${straightened} · trace your items in the top-down view`, 'ok');
    }
    drawPhoto();
    drawRectified();
    renderDetected();
    return;
  }
  const grid = refMode() === 'template' ? TEMPLATE_GRID : undefined;
  segResult = segmentItems(rectified, {
    ppm: PPM,
    origin: rectOrigin,
    ignore: segIgnore,
    threshold: +$<HTMLInputElement>('threshold').value,
    grid,
    smoothMm: +$<HTMLInputElement>('smoothing').value,
    method,
  });
  const kept = detected.filter((d) => d.edited || d.traced);
  const autos = detected.filter((d) => !d.edited && !d.traced);
  const fresh: Detected[] = [];
  segResult.outlines.forEach((outline) => {
    // An automatic outline that a hand-edited shape already covers is left out.
    if (kept.some((k) => overlapRatio(k.outline.bbox, outline.bbox) > 0.5)) return;
    const prev = autos.find((a) => overlapRatio(a.outline.bbox, outline.bbox) > 0.5);
    const paths = outline.loops.map((l) => pathFromPolygon(l, 0.35));
    const d = makeShape(paths, prev ? { id: prev.id, use: prev.use, name: prev.name, depth: prev.depth } : { name: `Item ${S.items.length + fresh.length + kept.length + 1}` });
    if (prev) autos.splice(autos.indexOf(prev), 1);
    fresh.push(d);
  });
  detected = [...fresh, ...kept].sort((a, b) => a.id - b.id);
  if (view && view.selected !== null && !detected.some((d) => d.id === view!.selected)) view.select(null);
  const n = detected.length;
  if (refMode() === 'template' && !markersFound)
    status("Couldn't find the four black squares. Drag handles 1–4 onto their centres (1 = top-left of the sheet).", 'warn');
  else if (refMode() === 'manual') status('Drag handles 1–4 onto the corners of your reference rectangle (1 → 2 is the width).');
  else {
    const straightened = gridCorrection >= 0.5 ? ` · sheet straightened (up to ${gridCorrection.toFixed(1)} mm)` : '';
    status(n ? `Template found${straightened} · ${n} outline${n === 1 ? '' : 's'} detected` : 'Template found, but no items detected. Try a higher sensitivity.', n ? 'ok' : 'warn');
  }
  drawPhoto();
  drawRectified();
  renderDetected();
}

// ------------------------------------------------------------------ drawing
const photoCanvas = () => $<HTMLCanvasElement>('photo-canvas');
const rectCanvas = () => $<HTMLCanvasElement>('rect-canvas');
const photoScale = () => (photo ? Math.min(1, 1400 / Math.max(photo.width, photo.height)) : 1);

function drawPhoto() {
  if (!photo || !photoSrc) return;
  const canvas = photoCanvas();
  const s = photoScale();
  canvas.width = Math.round(photo.width * s);
  canvas.height = Math.round(photo.height * s);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(photoSrc, 0, 0, canvas.width, canvas.height);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#2563eb';
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(2, canvas.width / 500);
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  corners.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);
  const r = Math.max(11, canvas.width / 55);
  corners.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r / 5);
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(r)}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x * s, p.y * s + 1);
  });
}

function drawRectified() {
  view?.redraw();
}

function renderDetected() {
  const body = $('detected-body');
  const used = detected.filter((d) => d.use).length;
  $('detected-count').textContent = detected.length ? String(detected.length) : '';
  body.innerHTML = detected.length
    ? detected
        .map(
          (d, i) => `<div class="det${d.use ? '' : ' off'}${view?.selected === d.id ? ' sel' : ''}" data-i="${i}">
            <input type="checkbox" data-f="use" ${d.use ? 'checked' : ''} aria-label="Use outline ${i + 1}">
            <span class="swatch" style="background:${colour(d)}"></span>
            <input type="text" data-f="name" value="${esc(d.name)}" aria-label="Name of outline ${i + 1}">
            <button class="icon-btn xs" data-act="del" title="Delete this outline" aria-label="Delete outline ${i + 1}">${icon('trash')}</button>
            <div class="det-meta"><span>${fmt(d.outline.bbox.w)} × ${fmt(d.outline.bbox.h)} mm${d.traced ? ' · traced' : d.edited ? ' · edited' : ''}</span>
            <label class="num narrow"><input type="number" data-f="depth" min="1" max="150" step="0.5" value="${d.depth}" aria-label="Depth of outline ${i + 1}"><span>mm</span></label></div>
          </div>`,
        )
        .join('')
    : `<p class="empty">No outlines yet. Trace each item with the Pen, Rectangle or Circle tool${autoDetect() ? '' : ', or turn on Auto-detect outlines above'}.</p>`;
  const btn = $<HTMLButtonElement>('add-items');
  btn.disabled = used === 0;
  btn.querySelector('span')!.textContent = used ? `Add ${used} item${used === 1 ? '' : 's'} to bin` : 'Add to bin';
}

// ------------------------------------------------------------------ init
export function initCapture(opts: { onAdded: () => void }) {
  renderTemplatePreview();
  document.querySelectorAll<HTMLButtonElement>('[data-paper]').forEach((b) =>
    b.addEventListener('click', () => {
      sheet = SHEETS[b.dataset.paper as SheetSpec['id']];
      document.querySelectorAll('[data-paper]').forEach((o) => o.classList.toggle('active', o === b));
      renderTemplatePreview();
      if (photo) {
        initCorners();
        processPhoto();
      }
    }),
  );
  $('print-template').addEventListener('click', () => openPrintableTemplate(sheet));
  $('download-template').addEventListener('click', () => downloadTemplateSvg(sheet));

  const onPick = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) loadPhotoFile(file);
  };
  $('photo-input').addEventListener('change', onPick);
  $('photo-choose').addEventListener('change', onPick);

  $('ref-mode').addEventListener('change', () => {
    $('manual-size').hidden = refMode() !== 'manual';
    if (photo) {
      initCorners();
      processPhoto();
    }
  });
  for (const id of ['ref-w', 'ref-h']) $(id).addEventListener('change', () => photo && processPhoto());

  // Corner handles.
  const pc = photoCanvas();
  let dragIdx = -1;
  const toImg = (e: PointerEvent): Point => {
    const b = pc.getBoundingClientRect();
    const s = photoScale();
    return { x: (((e.clientX - b.left) / b.width) * pc.width) / s, y: (((e.clientY - b.top) / b.height) * pc.height) / s };
  };
  pc.addEventListener('pointerdown', (e) => {
    if (!photo) return;
    const p = toImg(e);
    const tol = (36 * photo.width) / pc.getBoundingClientRect().width;
    let best = -1, bestD = tol;
    corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) (bestD = d), (best = i);
    });
    if (best >= 0) {
      dragIdx = best;
      pc.setPointerCapture(e.pointerId);
    }
  });
  pc.addEventListener('pointermove', (e) => {
    if (dragIdx >= 0) {
      corners[dragIdx] = toImg(e);
      drawPhoto();
      return;
    }
    if (!photo) return;
    const p = toImg(e);
    const tol = (36 * photo.width) / pc.getBoundingClientRect().width;
    pc.style.cursor = corners.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < tol) ? 'grab' : 'default';
  });
  const endCorner = () => {
    if (dragIdx < 0) return;
    dragIdx = -1;
    markersFound = true;
    processPhoto();
  };
  pc.addEventListener('pointerup', endCorner);
  pc.addEventListener('pointercancel', endCorner);

  // Sliders.
  const bindSlider = (id: string, out: string, fmtV: (v: string) => string, apply?: () => void) => {
    const el = $<HTMLInputElement>(id);
    el.addEventListener('input', () => ($(out).textContent = fmtV(el.value)));
    if (apply) el.addEventListener('change', apply);
  };
  // Automatic detection on or off (remembered; off by default: trace by hand).
  const auto = $<HTMLInputElement>('auto-detect');
  try {
    auto.checked = localStorage.getItem(AUTO_KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  const syncAuto = () => ($('auto-opts').hidden = $('auto-opts').parentElement!.hidden = !auto.checked);
  syncAuto();
  auto.addEventListener('change', () => {
    try {
      localStorage.setItem(AUTO_KEY, auto.checked ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
    syncAuto();
    history.push();
    runSegmentation();
    if (!auto.checked && rectified) view?.setTool('pen');
  });
  bindSlider('threshold', 'threshold-val', (v) => (+v).toFixed(2), runSegmentation);
  bindSlider('smoothing', 'smoothing-val', (v) => `${v} mm`, runSegmentation);

  // Tracing view and tools.
  view = new TraceView<Detected>(rectCanvas(), {
    shapes: () => detected,
    colour,
    beginChange: () => history.push(),
    shapeChanged: (d, final) => {
      d.edited = true;
      refreshOutline(d);
      if (final) renderDetected();
      else updateRowSize(d);
    },
    addShape: (paths) => {
      const d = makeShape(paths, { traced: true });
      detected.push(d);
      renderDetected();
      return d;
    },
    removeShape: (d) => {
      detected = detected.filter((o) => o !== d);
      renderDetected();
    },
    selectionChanged: () => renderDetected(),
    toolChanged: (t) => syncTool(t),
  });
  if (rectImage) view.setImage(rectImage, rectOrigin, PPM);
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => view!.setTool(b.dataset.tool as Tool)),
  );
  $('trace-fit').addEventListener('click', () => view!.fit());
  $('trace-zoom-in').addEventListener('click', () => view!.zoomBy(1.4));
  $('trace-zoom-out').addEventListener('click', () => view!.zoomBy(1 / 1.4));
  syncTool('edit');

  // Detected outlines list.
  const body = $('detected-body');
  body.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const d = detected[+(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1)];
    if (!d) return;
    if (t.dataset.f === 'name') d.name = t.value;
    if (t.dataset.f === 'depth' && +t.value > 0) d.depth = +t.value;
  });
  body.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>('[data-i]');
    const d = detected[+(row?.dataset.i ?? -1)];
    if (!d) return;
    if (t.closest('[data-act="del"]')) {
      history.push();
      detected = detected.filter((o) => o !== d);
      if (view?.selected === d.id) view.select(null);
      renderDetected();
      drawRectified();
      return;
    }
    if (t.closest('input')) return;
    view?.select(d.id);
  });
  body.addEventListener('focusin', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
    const d = detected[+(row?.dataset.i ?? -1)];
    if (d && view && view.selected !== d.id) view.select(d.id);
  });
  body.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const d = detected[+(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1)];
    if (!d || t.dataset.f !== 'use') return;
    history.push();
    d.use = t.checked;
    drawRectified();
    renderDetected();
  });

  $('add-items').addEventListener('click', () => {
    const chosen = detected.filter((d) => d.use);
    if (!chosen.length) return;
    for (const d of chosen) {
      refreshOutline(d);
      const { loops } = centreLoops(d.outline.loops);
      addItem({ name: d.name, loops, depth: d.depth, x: 0, y: 0, rotation: bestOrientation(loops), notches: [], zones: [] });
    }
    arrange();
    toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to the bin.`, 'success');
    opts.onAdded();
  });
}
