// Steps 1 and 2: the printable template, and turning a photo into item outlines.
import { Point, Rect, SHEETS, SheetSpec, TEMPLATE_GRID, ignoreZones, markerCenters, workRegion } from '../sheet';
import { downloadTemplateSvg, openPrintableTemplate, templateSvg } from '../template';
import { RGBAImage } from '../vision/image';
import { detectMarkers } from '../vision/markers';
import { rectify } from '../vision/homography';
import { dewarpByGrid } from '../vision/dewarp';
import { DetectedOutline, SegmentResult, segmentItems } from '../vision/segment';
import { bestOrientation, centreLoops } from '../layout';
import { $, esc, fmt } from '../ui/dom';
import { icon } from '../ui/icons';
import { toast } from '../ui/toast';
import { PALETTE, S, addItem, arrange } from './store';

const PPM = 4; // pixels per mm in the rectified image

export interface Detected {
  outline: DetectedOutline;
  use: boolean;
  name: string;
  depth: number;
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
/** Brush corrections on the top-down image: 1 = item, -1 = paper, 0 = automatic. */
let edits: Int8Array | null = null;
/** How much the grid had to straighten the sheet (paper curl, lens distortion), mm. */
let gridCorrection = 0;
export let detected: Detected[] = [];

const refMode = () => $<HTMLSelectElement>('ref-mode').value as 'template' | 'manual';
const colour = (i: number) => PALETTE[i % PALETTE.length];

function status(msg: string, kind: '' | 'ok' | 'warn' = '') {
  const el = $('photo-status');
  el.className = `status-chip ${kind}`;
  el.innerHTML = msg ? `${icon(kind === 'ok' ? 'check' : kind === 'warn' ? 'alert' : 'info')}<span>${esc(msg)}</span>` : '';
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
    initCorners();
    processPhoto();
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
  if (refMode() === 'template') {
    const markers = ignore.map((z) => ({ x: z.x - region.x, y: z.y - region.y, w: z.w, h: z.h })).filter((z) => z.w < 30 && z.h < 30);
    const dw = dewarpByGrid(rectified, PPM, TEMPLATE_GRID, markers);
    gridCorrection = dw ? dw.maxShiftMm : 0;
    if (dw) rectified = dw.image;
  }
  rectOrigin = { x: region.x, y: region.y };
  segIgnore = ignore;
  edits = new Int8Array(rectified.width * rectified.height);
  runSegmentation();
}

/** Re-runs item detection (after slider changes or brush edits). */
function runSegmentation() {
  if (!rectified) return;
  const grid = refMode() === 'template' ? TEMPLATE_GRID : undefined;
  segResult = segmentItems(rectified, {
    ppm: PPM,
    origin: rectOrigin,
    ignore: segIgnore,
    threshold: +$<HTMLInputElement>('threshold').value,
    grid,
    edits: edits ?? undefined,
    smoothMm: +$<HTMLInputElement>('smoothing').value,
  });
  const prev = detected;
  detected = segResult.outlines.map((outline, i) => ({
    outline,
    use: prev[i]?.use ?? true,
    name: prev[i]?.name ?? `Item ${S.items.length + i + 1}`,
    depth: prev[i]?.depth ?? 12,
  }));
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
  if (!rectified || !segResult) return;
  const canvas = rectCanvas();
  canvas.width = rectified.width;
  canvas.height = rectified.height;
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(rectified.data), rectified.width, rectified.height);
  // Fade the background so the detected items stand out.
  const m = segResult.mask;
  for (let i = 0; i < m.length; i++) {
    if (m[i]) continue;
    img.data[i * 4] = img.data[i * 4] * 0.55 + 115;
    img.data[i * 4 + 1] = img.data[i * 4 + 1] * 0.55 + 115;
    img.data[i * 4 + 2] = img.data[i * 4 + 2] * 0.55 + 115;
  }
  ctx.putImageData(img, 0, 0);
  const font = getComputedStyle(document.body).fontFamily;
  detected.forEach((d, i) => {
    const c = colour(i);
    ctx.lineJoin = 'round';
    for (const loop of d.outline.loops) {
      ctx.beginPath();
      loop.forEach((p, k) => {
        const x = (p.x - rectOrigin.x) * PPM, y = (p.y - rectOrigin.y) * PPM;
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = c + (d.use ? '40' : '14');
      ctx.fill();
      ctx.setLineDash(d.use ? [] : [10, 8]);
      ctx.lineWidth = 4;
      ctx.strokeStyle = c;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const b = d.outline.bbox;
    const x = (b.x - rectOrigin.x) * PPM, y = (b.y - rectOrigin.y) * PPM;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fillStyle = c;
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `700 20px ${font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), x, y + 1);
  });
}

function renderDetected() {
  const body = $('detected-body');
  const used = detected.filter((d) => d.use).length;
  $('detected-count').textContent = detected.length ? String(detected.length) : '';
  body.innerHTML = detected.length
    ? detected
        .map(
          (d, i) => `<div class="det${d.use ? '' : ' off'}" data-i="${i}">
            <input type="checkbox" data-f="use" ${d.use ? 'checked' : ''} aria-label="Use outline ${i + 1}">
            <span class="swatch" style="background:${colour(i)}"></span>
            <input type="text" data-f="name" value="${esc(d.name)}" aria-label="Name of outline ${i + 1}">
            <div class="det-meta"><span>${fmt(d.outline.bbox.w)} × ${fmt(d.outline.bbox.h)} mm</span>
            <label class="num narrow"><input type="number" data-f="depth" min="1" max="150" step="0.5" value="${d.depth}" aria-label="Depth of outline ${i + 1}"><span>mm</span></label></div>
          </div>`,
        )
        .join('')
    : `<p class="empty">No outlines yet.</p>`;
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
  bindSlider('threshold', 'threshold-val', (v) => (+v).toFixed(2), runSegmentation);
  bindSlider('smoothing', 'smoothing-val', (v) => `${v} mm`, runSegmentation);
  bindSlider('brush-size', 'brush-val', (v) => `${v} mm`);

  // Touch-up brush.
  type BrushMode = 'off' | 'erase' | 'add';
  let brush: BrushMode = 'off';
  const rc = rectCanvas();
  document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) =>
    b.addEventListener('click', () => {
      brush = b.dataset.brush as BrushMode;
      document.querySelectorAll('[data-brush]').forEach((o) => o.classList.toggle('active', o === b));
      rc.style.cursor = brush === 'off' ? '' : 'crosshair';
    }),
  );
  $('brush-clear').addEventListener('click', () => {
    if (!edits) return;
    edits.fill(0);
    runSegmentation();
  });
  let painting = false;
  const paint = (e: PointerEvent) => {
    if (!edits || !rectified) return;
    const b = rc.getBoundingClientRect();
    const cx = ((e.clientX - b.left) / b.width) * rc.width;
    const cy = ((e.clientY - b.top) / b.height) * rc.height;
    const r = (+$<HTMLInputElement>('brush-size').value / 2) * PPM;
    const val = brush === 'erase' ? -1 : 1;
    const w = rectified.width, h = rectified.height;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) edits[y * w + x] = val;
    const ctx = rc.getContext('2d')!;
    ctx.fillStyle = brush === 'erase' ? 'rgba(255,255,255,0.75)' : 'rgba(37,99,235,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  rc.addEventListener('pointerdown', (e) => {
    if (brush === 'off') return;
    painting = true;
    rc.setPointerCapture(e.pointerId);
    paint(e);
  });
  rc.addEventListener('pointermove', (e) => painting && paint(e));
  const endPaint = () => {
    if (!painting) return;
    painting = false;
    runSegmentation();
  };
  rc.addEventListener('pointerup', endPaint);
  rc.addEventListener('pointercancel', endPaint);

  // Detected outlines list.
  const body = $('detected-body');
  body.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const d = detected[+(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1)];
    if (!d) return;
    if (t.dataset.f === 'name') d.name = t.value;
    if (t.dataset.f === 'depth' && +t.value > 0) d.depth = +t.value;
  });
  body.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const d = detected[+(t.closest<HTMLElement>('[data-i]')?.dataset.i ?? -1)];
    if (!d || t.dataset.f !== 'use') return;
    d.use = t.checked;
    drawRectified();
    renderDetected();
  });

  $('add-items').addEventListener('click', () => {
    const chosen = detected.filter((d) => d.use);
    if (!chosen.length) return;
    for (const d of chosen) {
      const { loops } = centreLoops(d.outline.loops);
      addItem({ name: d.name, loops, depth: d.depth, x: 0, y: 0, rotation: bestOrientation(loops), notches: [], zones: [] });
    }
    arrange();
    toast(`Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} to the bin.`, 'success');
    opts.onAdded();
  });
}
