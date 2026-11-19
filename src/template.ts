import { GRID_PITCH, MARKER_SIZE, SHEET_MARGIN, SheetSpec, markerCenters } from './sheet';

/**
 * Builds the printable template as an SVG string sized in real millimetres.
 * Grid lines are light cyan so they can be filtered out; markers are solid black
 * so they are easy to find in a photo.
 */
export function templateSvg(sheet: SheetSpec): string {
  const { width: W, height: H } = sheet;
  const m = SHEET_MARGIN;
  const parts: string[] = [];
  let i = 0;
  for (let x = m; x <= W - m + 1e-6; x += GRID_PITCH, i++) {
    const major = i % 2 === 0;
    parts.push(
      `<line x1="${x.toFixed(2)}" y1="${m}" x2="${x.toFixed(2)}" y2="${(H - m).toFixed(2)}" stroke-width="${major ? 0.3 : 0.15}"/>`,
    );
  }
  i = 0;
  for (let y = m; y <= H - m + 1e-6; y += GRID_PITCH, i++) {
    const major = i % 2 === 0;
    parts.push(
      `<line x1="${m}" y1="${y.toFixed(2)}" x2="${(W - m).toFixed(2)}" y2="${y.toFixed(2)}" stroke-width="${major ? 0.3 : 0.15}"/>`,
    );
  }
  const markers = markerCenters(sheet)
    .map(
      (c) =>
        `<rect x="${c.x - MARKER_SIZE / 2 - 1.5}" y="${c.y - MARKER_SIZE / 2 - 1.5}" width="${MARKER_SIZE + 3}" height="${MARKER_SIZE + 3}" fill="#fff"/>` +
        `<rect x="${c.x - MARKER_SIZE / 2}" y="${c.y - MARKER_SIZE / 2}" width="${MARKER_SIZE}" height="${MARKER_SIZE}" fill="#000"/>`,
    )
    .join('');
  const barY = H - m + 3.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fff"/>
<g stroke="#5bc6f0" fill="none">${parts.join('')}</g>
${markers}
<text x="${W / 2}" y="${m - 3.5}" font-family="sans-serif" font-size="3.2" text-anchor="middle" fill="#555">Gridfinity Tracer · ${sheet.name} · print at 100% / actual size · ${GRID_PITCH} mm grid</text>
<rect x="${W / 2 - 50}" y="${barY}" width="100" height="1.2" fill="#555"/>
<text x="${W / 2 + 52}" y="${barY + 1.2}" font-family="sans-serif" font-size="2.6" fill="#555">← this bar should measure 100 mm</text>
</svg>`;
}

/** Opens the template in a new window, ready to print. */
export function openPrintableTemplate(sheet: SheetSpec): void {
  const svg = templateSvg(sheet);
  const page = sheet.id === 'a4' ? 'A4' : 'letter';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Gridfinity Tracer template</title>
<style>@page{size:${page} portrait;margin:0}html,body{margin:0;padding:0;background:#fff}svg{display:block}
.hint{font:14px sans-serif;padding:8px 12px;background:#fffbe6;border-bottom:1px solid #e5d58a}
@media print{.hint{display:none}}</style></head><body>
<div class="hint">Print with scaling set to <b>100% / Actual size</b> (no "fit to page"). Use your browser's Print dialog (Ctrl/Cmd + P).</div>
${svg}<script>setTimeout(()=>window.print(),400)</script></body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  window.open(URL.createObjectURL(blob), '_blank');
}

/** Downloads the template as an SVG file. */
export function downloadTemplateSvg(sheet: SheetSpec): void {
  const blob = new Blob([templateSvg(sheet)], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gridfinity-tracer-template-${sheet.id}.svg`;
  a.click();
}
