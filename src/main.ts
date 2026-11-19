import Module, { Manifold, ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { TEMPLATE_GRID, Point, Rect, SHEETS, SheetSpec, ignoreZones, markerCenters, workRegion } from './sheet';
import { downloadTemplateSvg, openPrintableTemplate } from './template';
import { RGBAImage } from './vision/image';
import { detectMarkers } from './vision/markers';
import { rectify } from './vision/homography';
import { DetectedOutline, SegmentResult, segmentItems } from './vision/segment';
import {
  BinSettings,
  GF,
  Item,
  NotchSide,
  autoArrange,
  bestOrientation,
  binOuterSize,
  centreLoops,
  defaultSettings,
  fitBinToItems,
  notchCentre,
  placedLoops,
} from './layout';
import { buildBin, toStl } from './gridfinity';
import { Preview } from './preview';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PPM = 4; // pixels per mm in the rectified image
const COLORS = ['#e6194b', '#3cb44b', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#469990', '#9a6324', '#800000'];

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------
let wasm: ManifoldToplevel | null = null;
let sheet: SheetSpec = SHEETS.a4;
let photo: RGBAImage | null = null;
let photoCanvasSrc: HTMLCanvasElement | null = null;
let corners: Point[] = [];
let markersFound = true;
let rectified: RGBAImage | null = null;
let segResult: SegmentResult | null = null;
let rectOrigin: Point = { x: 0, y: 0 };
let segIgnore: Rect[] = [];
/** Brush corrections on the top-down image: 1 = item, -1 = paper, 0 = automatic. */
let edits: Int8Array | null = null;

interface Detected {
  outline: DetectedOutline;
  use: boolean;
  name: string;
  depth: number;
}
let detected: Detected[] = [];
const items: Item[] = [];
let nextId = 1;
const settings: BinSettings = defaultSettings();
let currentModel: Manifold | null = null;
let preview: Preview | null = null;

// ---------------------------------------------------------------------------------------
// Step 1: template
// ---------------------------------------------------------------------------------------
$<HTMLSelectElement>('paper').addEventListener('change', (e) => {
  sheet = SHEETS[(e.target as HTMLSelectElement).value as SheetSpec['id']];
  if (photo) processPhoto();
});
$('print-template').addEventListener('click', () => openPrintableTemplate(sheet));
$('download-template').addEventListener('click', () => downloadTemplateSvg(sheet));

// ---------------------------------------------------------------------------------------
// Step 2: photo
// ---------------------------------------------------------------------------------------
const refMode = () => $<HTMLSelectElement>('ref-mode').value as 'template' | 'manual';
const status = (msg: string) => ($('photo-status').textContent = msg);

$<HTMLSelectElement>('ref-mode').addEventListener('change', () => {
  $('manual-size').hidden = refMode() !== 'manual';
  if (photo) {
    initCorners();
    processPhoto();
  }
});
for (const id of ['ref-w', 'ref-h']) $(id).addEventListener('change', () => photo && processPhoto());

const onPhotoPicked = async (e: Event) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  status('Loading photo…');
  try {
    await loadPhoto(file);
    initCorners();
    $('photo-views').hidden = false;
    processPhoto();
  } catch (err) {
    console.error(err);
    status(`Could not read that image: ${(err as Error).message}`);
  }
  (e.target as HTMLInputElement).value = '';
};
// "Take photo" opens the camera directly; "Choose photo" opens the library / files.
$('photo-input').addEventListener('change', onPhotoPicked);
$('photo-choose').addEventListener('change', onPhotoPicked);

async function loadPhoto(file: Blob) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  photo = ctx.getImageData(0, 0, c.width, c.height);
  photoCanvasSrc = c;
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
  if (refMode() === 'template') {
    return { sheetPts: markerCenters(sheet), region: workRegion(sheet), ignore: ignoreZones(sheet) };
  }
  const w = Math.max(10, +$<HTMLInputElement>('ref-w').value || 180);
  const h = Math.max(10, +$<HTMLInputElement>('ref-h').value || 250);
  return {
    sheetPts: [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }],
    region: { x: 0, y: 0, w, h },
    ignore: [],
  };
}

function processPhoto() {
  if (!photo) return;
  const { sheetPts, region, ignore } = reference();
  try {
    rectified = rectify(photo, corners, sheetPts, region, PPM);
  } catch {
    status('The corner handles form an invalid shape. Drag them onto the reference corners.');
    return;
  }
  rectOrigin = { x: region.x, y: region.y };
  segIgnore = ignore;
  edits = new Int8Array(rectified.width * rectified.height);
  runSegmentation();
}

/** Re-runs item detection on the current top-down image (after threshold changes or brush edits). */
function runSegmentation() {
  if (!rectified) return;
  const threshold = +$<HTMLInputElement>('threshold').value;
  // The printed template's grid starts at the work region's corner; own paper has no known grid.
  const grid = refMode() === 'template' ? TEMPLATE_GRID : undefined;
  segResult = segmentItems(rectified, { ppm: PPM, origin: rectOrigin, ignore: segIgnore, threshold, grid, edits: edits ?? undefined, smoothMm: +$<HTMLInputElement>('smoothing').value });
  const prev = detected;
  detected = segResult.outlines.map((outline, i) => ({
    outline,
    use: prev[i]?.use ?? true,
    name: prev[i]?.name ?? `Item ${i + 1}`,
    depth: prev[i]?.depth ?? 12,
  }));
  const markerMsg =
    refMode() === 'template'
      ? !markersFound
        ? 'Could not find the four black markers. Drag handles 1–4 onto their centres (1 = top-left of the sheet). '
        : 'Markers found. '
      : 'Drag handles 1–4 onto the corners of your reference rectangle (1→2 is the width). ';
  status(`${markerMsg}${detected.length} outline${detected.length === 1 ? '' : 's'} detected.`);
  drawPhoto();
  drawRectified();
  renderDetected();
}

const photoCanvas = $<HTMLCanvasElement>('photo-canvas');
const rectCanvas = $<HTMLCanvasElement>('rect-canvas');
function photoScale() {
  return photo ? Math.min(1, 1100 / Math.max(photo.width, photo.height)) : 1;
}
function drawPhoto() {
  if (!photo || !photoCanvasSrc) return;
  const s = photoScale();
  photoCanvas.width = Math.round(photo.width * s);
  photoCanvas.height = Math.round(photo.height * s);
  const ctx = photoCanvas.getContext('2d')!;
  ctx.drawImage(photoCanvasSrc, 0, 0, photoCanvas.width, photoCanvas.height);
  ctx.strokeStyle = '#ff2d8a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  corners.forEach((p, i) => (i ? ctx.lineTo(p.x * s, p.y * s) : ctx.moveTo(p.x * s, p.y * s)));
  ctx.closePath();
  ctx.stroke();
  const r = Math.max(10, photoCanvas.width / 60);
  corners.forEach((p, i) => {
    ctx.fillStyle = 'rgba(255,45,138,0.35)';
    ctx.strokeStyle = '#ff2d8a';
    ctx.beginPath();
    ctx.arc(p.x * s, p.y * s, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${r}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), p.x * s, p.y * s);
  });
}

{
  let dragIdx = -1;
  const toImg = (e: PointerEvent): Point => {
    const b = photoCanvas.getBoundingClientRect();
    const s = photoScale();
    return {
      x: ((e.clientX - b.left) / b.width) * photoCanvas.width / s,
      y: ((e.clientY - b.top) / b.height) * photoCanvas.height / s,
    };
  };
  photoCanvas.addEventListener('pointerdown', (e) => {
    if (!photo) return;
    const p = toImg(e);
    const b = photoCanvas.getBoundingClientRect();
    const tol = (40 * photo.width) / b.width;
    let best = -1, bestD = tol;
    corners.forEach((c, i) => {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      dragIdx = best;
      photoCanvas.setPointerCapture(e.pointerId);
    }
  });
  photoCanvas.addEventListener('pointermove', (e) => {
    if (dragIdx < 0) return;
    corners[dragIdx] = toImg(e);
    drawPhoto();
  });
  const end = () => {
    if (dragIdx < 0) return;
    dragIdx = -1;
    markersFound = true;
    processPhoto();
  };
  photoCanvas.addEventListener('pointerup', end);
  photoCanvas.addEventListener('pointercancel', end);
}

$<HTMLInputElement>('threshold').addEventListener('input', (e) => {
  $('threshold-val').textContent = (e.target as HTMLInputElement).value;
});
$<HTMLInputElement>('threshold').addEventListener('change', () => runSegmentation());
$<HTMLInputElement>('smoothing').addEventListener('input', (e) => {
  $('smoothing-val').textContent = `${(e.target as HTMLInputElement).value} mm`;
});
$<HTMLInputElement>('smoothing').addEventListener('change', () => runSegmentation());

// Touch-up brush on the top-down view.
type BrushMode = 'off' | 'erase' | 'add';
let brushMode: BrushMode = 'off';
const brushButtons = document.querySelectorAll<HTMLButtonElement>('[data-brush]');
brushButtons.forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.brush as BrushMode;
    brushMode = brushMode === mode ? 'off' : mode;
    brushButtons.forEach((o) => o.classList.toggle('active', o.dataset.brush === brushMode));
    rectCanvas.style.cursor = brushMode === 'off' ? '' : 'crosshair';
  }),
);
$('brush-clear').addEventListener('click', () => {
  if (!edits) return;
  edits.fill(0);
  runSegmentation();
});
{
  let painting = false;
  const paint = (e: PointerEvent) => {
    if (!edits || !rectified) return;
    const b = rectCanvas.getBoundingClientRect();
    const cx = ((e.clientX - b.left) / b.width) * rectCanvas.width;
    const cy = ((e.clientY - b.top) / b.height) * rectCanvas.height;
    const r = (+$<HTMLInputElement>('brush-size').value / 2) * PPM;
    const val = brushMode === 'erase' ? -1 : 1;
    const w = rectified.width, h = rectified.height;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) edits[y * w + x] = val;
    const ctx = rectCanvas.getContext('2d')!;
    ctx.fillStyle = brushMode === 'erase' ? 'rgba(255,255,255,0.7)' : 'rgba(255,45,138,0.6)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  rectCanvas.addEventListener('pointerdown', (e) => {
    if (brushMode === 'off') return;
    painting = true;
    rectCanvas.setPointerCapture(e.pointerId);
    paint(e);
  });
  rectCanvas.addEventListener('pointermove', (e) => painting && paint(e));
  const end = () => {
    if (!painting) return;
    painting = false;
    runSegmentation();
  };
  rectCanvas.addEventListener('pointerup', end);
  rectCanvas.addEventListener('pointercancel', end);
}

function drawRectified() {
  if (!rectified || !segResult) return;
  rectCanvas.width = rectified.width;
  rectCanvas.height = rectified.height;
  const ctx = rectCanvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(rectified.data), rectified.width, rectified.height);
  const m = segResult.mask;
  for (let i = 0; i < m.length; i++) {
    if (!m[i]) continue;
    img.data[i * 4] = img.data[i * 4] * 0.5 + 127;
    img.data[i * 4 + 1] *= 0.6;
    img.data[i * 4 + 2] = img.data[i * 4 + 2] * 0.6 + 60;
  }
  ctx.putImageData(img, 0, 0);
  detected.forEach((d, i) => {
    ctx.strokeStyle = COLORS[i % COLORS.length];
    ctx.lineWidth = 3;
    ctx.setLineDash(d.use ? [] : [8, 6]);
    for (const loop of d.outline.loops) {
      ctx.beginPath();
      loop.forEach((p, k) => {
        const x = (p.x - rectOrigin.x) * PPM, y = (p.y - rectOrigin.y) * PPM;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const b = d.outline.bbox;
    ctx.fillStyle = COLORS[i % COLORS.length];
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(String(i + 1), (b.x - rectOrigin.x) * PPM, (b.y - rectOrigin.y) * PPM - 6);
  });
}

function renderDetected() {
  $('detected').hidden = detected.length === 0;
  const body = $('detected-body');
  body.innerHTML = '';
  detected.forEach((d, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span> ${i + 1}</td>
      <td><input type="checkbox" ${d.use ? 'checked' : ''}></td>
      <td><input type="text"></td>
      <td>${d.outline.bbox.w.toFixed(1)} × ${d.outline.bbox.h.toFixed(1)}</td>
      <td><input type="number" min="1" max="150" step="0.5" value="${d.depth}"></td>`;
    const [use, name, depth] = tr.querySelectorAll('input');
    name.value = d.name;
    use.addEventListener('change', () => {
      d.use = use.checked;
      drawRectified();
    });
    name.addEventListener('input', () => (d.name = name.value));
    depth.addEventListener('input', () => (d.depth = +depth.value || d.depth));
    body.appendChild(tr);
  });
}

$('add-items').addEventListener('click', () => {
  const chosen = detected.filter((d) => d.use);
  if (!chosen.length) return;
  for (const d of chosen) {
    const { loops } = centreLoops(d.outline.loops);
    items.push({ id: nextId++, name: d.name, loops, depth: d.depth, x: 0, y: 0, rotation: bestOrientation(loops), notch: 'none' });
  }
  arrange();
  $('step-bin').scrollIntoView({ behavior: 'smooth' });
});

// ---------------------------------------------------------------------------------------
// Step 3: bin layout
// ---------------------------------------------------------------------------------------
const num = (id: string) => +$<HTMLInputElement>(id).value;
function readSettings() {
  settings.autoSize = $<HTMLInputElement>('auto-size').checked;
  settings.maxUnits = Math.max(1, num('max-units') || 5);
  settings.unitsX = Math.max(1, num('units-x') || 1);
  settings.unitsY = Math.max(1, num('units-y') || 1);
  settings.unitsZ = Math.max(0, num('units-z') || 0);
  settings.clearance = Math.max(0, num('clearance'));
  settings.spacing = Math.max(0.8, num('spacing') || 2);
  settings.fingerRadius = Math.max(4, num('finger') || 10);
  settings.magnets = $<HTMLInputElement>('magnets').checked;
  settings.lip = $<HTMLInputElement>('lip').checked;
  $<HTMLInputElement>('units-x').disabled = settings.autoSize;
  $<HTMLInputElement>('units-y').disabled = settings.autoSize;
}
function writeUnits() {
  $<HTMLInputElement>('units-x').value = String(settings.unitsX);
  $<HTMLInputElement>('units-y').value = String(settings.unitsY);
}
for (const id of ['units-x', 'units-y', 'units-z', 'clearance', 'spacing', 'finger', 'magnets', 'lip', 'max-units']) {
  $(id).addEventListener('change', () => {
    readSettings();
    if (settings.autoSize && ['clearance', 'spacing', 'max-units', 'finger'].includes(id)) arrange();
    else {
      if (!settings.autoSize) layoutWarnings = [];
      changed();
    }
  });
}
$('auto-size').addEventListener('change', () => {
  readSettings();
  layoutWarnings = [];
  if (settings.autoSize) arrange();
  else changed();
});

/** Layout problems, shown alongside the model's own warnings. */
let layoutWarnings: string[] = [];

function arrange() {
  readSettings();
  const r = autoArrange(items, settings);
  layoutWarnings = !r.ok
    ? [`The items don't fit in a ${settings.unitsX} × ${settings.unitsY} bin. Turn on auto size, make the bin bigger or reduce the clearance.`]
    : r.exceedsBed
      ? [`The items need a ${settings.unitsX} × ${settings.unitsY} bin, which is bigger than your ${settings.maxUnits}u bed limit. Check the outlines (a shadow can make one too big), or split the items across bins.`]
      : [];
  writeUnits();
  renderItems();
  changed();
}
$('arrange').addEventListener('click', arrange);
$('add-test').addEventListener('click', () => {
  const w = 60, h = 20;
  items.push({
    id: nextId++,
    name: `Test ${w}×${h}`,
    loops: [[{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }]],
    depth: 10,
    x: 0,
    y: 0,
    rotation: 0,
    notch: 'top',
  });
  arrange();
});

function renderItems() {
  const body = $('bin-items');
  body.innerHTML = '';
  $('empty-bin').hidden = items.length > 0;
  for (const it of items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><input type="text"></td>
      <td><input type="number" min="1" max="150" step="0.5" value="${it.depth}"></td>
      <td><select>${['none', 'top', 'bottom', 'left', 'right'].map((n) => `<option ${n === it.notch ? 'selected' : ''}>${n}</option>`).join('')}</select></td>
      <td><button data-r="-90" title="Rotate left">⟲</button> <button data-r="90" title="Rotate right">⟳</button></td>
      <td><button data-del title="Remove">✕</button></td>`;
    const [name, depth] = tr.querySelectorAll('input');
    name.value = it.name;
    name.addEventListener('input', () => (it.name = name.value));
    depth.addEventListener('change', () => {
      it.depth = Math.max(1, +depth.value || it.depth);
      changed();
    });
    tr.querySelector('select')!.addEventListener('change', (e) => {
      it.notch = (e.target as HTMLSelectElement).value as NotchSide;
      manualLayoutChanged();
    });
    tr.querySelectorAll<HTMLButtonElement>('button[data-r]').forEach((b) =>
      b.addEventListener('click', () => {
        it.rotation += +b.dataset.r!;
        manualLayoutChanged();
      }),
    );
    tr.querySelector('button[data-del]')!.addEventListener('click', () => {
      items.splice(items.indexOf(it), 1);
      renderItems();
      if (settings.autoSize) arrange();
      else changed();
    });
    body.appendChild(tr);
  }
}

const layoutCanvas = $<HTMLCanvasElement>('layout-canvas');
let layoutView = { scale: 1, cx: 0, cy: 0 };
function drawLayout() {
  const W = binOuterSize(settings.unitsX), D = binOuterSize(settings.unitsY);
  const cssW = layoutCanvas.clientWidth || 500;
  const pxW = Math.round(cssW * Math.min(2, devicePixelRatio));
  const margin = 12;
  const scale = Math.min((pxW - 2 * margin) / W, (pxW * 0.9 - 2 * margin) / D);
  layoutCanvas.width = pxW;
  layoutCanvas.height = Math.round(D * scale + 2 * margin);
  layoutView = { scale, cx: layoutCanvas.width / 2, cy: layoutCanvas.height / 2 };
  const ctx = layoutCanvas.getContext('2d')!;
  const tx = (x: number) => layoutView.cx + x * scale, ty = (y: number) => layoutView.cy + y * scale;
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  ctx.clearRect(0, 0, layoutCanvas.width, layoutCanvas.height);
  const rr = (w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.roundRect(tx(-w / 2), ty(-h / 2), w * scale, h * scale, r * scale);
  };
  rr(W, D, GF.cornerRadius);
  ctx.fillStyle = dark ? '#3a4150' : '#ffffff';
  ctx.fill();
  ctx.strokeStyle = dark ? '#7a8496' : '#9aa3b2';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = dark ? '#596273' : '#d0d5dd';
  for (let i = 1; i < settings.unitsX; i++) {
    const x = (i - settings.unitsX / 2) * GF.pitch;
    ctx.beginPath();
    ctx.moveTo(tx(x), ty(-D / 2));
    ctx.lineTo(tx(x), ty(D / 2));
    ctx.stroke();
  }
  for (let j = 1; j < settings.unitsY; j++) {
    const y = (j - settings.unitsY / 2) * GF.pitch;
    ctx.beginPath();
    ctx.moveTo(tx(-W / 2), ty(y));
    ctx.lineTo(tx(W / 2), ty(y));
    ctx.stroke();
  }
  rr(W - 2 * GF.edgeMargin, D - 2 * GF.edgeMargin, 0.75);
  ctx.strokeStyle = dark ? '#8890a0' : '#b8bec9';
  ctx.stroke();
  ctx.setLineDash([]);

  items.forEach((it, idx) => {
    const color = COLORS[idx % COLORS.length];
    ctx.beginPath();
    for (const loop of placedLoops(it)) {
      loop.forEach((p, k) => (k ? ctx.lineTo(tx(p.x), ty(p.y)) : ctx.moveTo(tx(p.x), ty(p.y))));
      ctx.closePath();
    }
    // Clearance shown as a thick stroke around the outline.
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, 2 * settings.clearance * scale);
    ctx.strokeStyle = color + '66';
    ctx.stroke();
    ctx.fillStyle = color + '99';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    const nc = notchCentre(it);
    if (nc) {
      ctx.beginPath();
      ctx.arc(tx(nc.x), ty(nc.y), settings.fingerRadius * scale, 0, Math.PI * 2);
      ctx.fillStyle = color + '55';
      ctx.fill();
    }
    ctx.fillStyle = dark ? '#fff' : '#111';
    ctx.font = `${Math.round(13 * Math.min(2, devicePixelRatio))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(it.name, tx(it.x), ty(it.y));
  });
}

function pointInLoops(p: Point, loops: Point[][]): boolean {
  let inside = false;
  for (const l of loops)
    for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
      if (l[i].y > p.y !== l[j].y > p.y && p.x < ((l[j].x - l[i].x) * (p.y - l[i].y)) / (l[j].y - l[i].y) + l[i].x)
        inside = !inside;
    }
  return inside;
}

{
  let drag: { item: Item; start: Point; x0: number; y0: number; rot0: number; rotate: boolean } | null = null;
  const toMm = (e: PointerEvent): Point => {
    const b = layoutCanvas.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * layoutCanvas.width;
    const py = ((e.clientY - b.top) / b.height) * layoutCanvas.height;
    return { x: (px - layoutView.cx) / layoutView.scale, y: (py - layoutView.cy) / layoutView.scale };
  };
  layoutCanvas.addEventListener('pointerdown', (e) => {
    const p = toMm(e);
    for (let i = items.length - 1; i >= 0; i--) {
      if (pointInLoops(p, placedLoops(items[i]))) {
        const it = items[i];
        drag = { item: it, start: p, x0: it.x, y0: it.y, rot0: it.rotation, rotate: e.shiftKey };
        layoutCanvas.setPointerCapture(e.pointerId);
        return;
      }
    }
  });
  layoutCanvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = toMm(e);
    const it = drag.item;
    if (drag.rotate) {
      const a0 = Math.atan2(drag.start.y - drag.y0, drag.start.x - drag.x0);
      const a1 = Math.atan2(p.y - drag.y0, p.x - drag.x0);
      it.rotation = drag.rot0 + Math.round(((a1 - a0) * 180) / Math.PI);
    } else {
      it.x = drag.x0 + p.x - drag.start.x;
      it.y = drag.y0 + p.y - drag.start.y;
    }
    drawLayout();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    manualLayoutChanged();
  };
  layoutCanvas.addEventListener('pointerup', end);
  layoutCanvas.addEventListener('pointercancel', end);
}
new ResizeObserver(() => drawLayout()).observe(layoutCanvas);

// ---------------------------------------------------------------------------------------
// Step 4: model
// ---------------------------------------------------------------------------------------
/** After a manual move or rotate: in auto-size mode, resize the bin around the arrangement. */
function manualLayoutChanged() {
  if (settings.autoSize) {
    fitBinToItems(items, settings);
    layoutWarnings =
      Math.max(settings.unitsX, settings.unitsY) > settings.maxUnits
        ? [`This arrangement needs a ${settings.unitsX} × ${settings.unitsY} bin, which is bigger than your ${settings.maxUnits}u bed limit.`]
        : [];
    writeUnits();
  }
  changed();
}

let regenTimer = 0;
function changed() {
  drawLayout();
  clearTimeout(regenTimer);
  regenTimer = window.setTimeout(regenerate, 250);
}

function setWarnings(w: string[]) {
  $('warnings').innerHTML = w.map((s) => `<li>${s.replace(/</g, '&lt;')}</li>`).join('');
}

function regenerate() {
  if (!wasm) return;
  try {
    const t0 = performance.now();
    const res = buildBin(wasm, items, settings);
    currentModel?.delete();
    currentModel = res.manifold;
    preview?.show(currentModel);
    setWarnings([...layoutWarnings, ...res.warnings]);
    const [w, d, h] = res.size;
    $('model-info').textContent = `${settings.unitsX} × ${settings.unitsY} × ${res.unitsZ}u · ${w.toFixed(1)} × ${d.toFixed(1)} × ${h.toFixed(1)} mm · ${currentModel.numTri().toLocaleString()} triangles · ${Math.round(performance.now() - t0)} ms`;
    $<HTMLButtonElement>('download-stl').disabled = false;
    document.body.dataset.modelReady = String(Date.now());
  } catch (err) {
    console.error(err);
    setWarnings([`Model generation failed: ${(err as Error).message}`]);
  }
}

$('download-stl').addEventListener('click', () => {
  if (!currentModel) return;
  const blob = new Blob([toStl(currentModel)], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const name = items.length === 1 ? items[0].name.replace(/[^\w-]+/g, '_') : 'bin';
  a.download = `gridfinity-${settings.unitsX}x${settings.unitsY}-${name}.stl`;
  a.click();
});

// ---------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------
(async () => {
  preview = new Preview($('viewer'));
  const applyTheme = () =>
    preview!.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#e9ecf1');
  applyTheme();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    applyTheme();
    drawLayout();
  });
  readSettings();
  renderItems();
  drawLayout();
  wasm = await Module({ locateFile: () => wasmUrl });
  wasm.setup();
  regenerate();
})();

// Exposed for automated tests.
(window as unknown as { __gt: unknown }).__gt = { items, settings, get detected() { return detected; } };
