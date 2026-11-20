import { GRID_PITCH, MAJOR_EVERY, MAJOR_LINE_MM, MARKER_SIZE, MINOR_LINE_MM, SHEET_MARGIN, SheetSpec, markerCenters } from './sheet';

/**
 * Builds the printable template as an SVG string sized in real millimetres.
 * Mid-grey 0.45 mm lines every 5 mm (printing the same on colour and black-and-white printers,
 * and staying visible through blur and shadow), with a bold line every 25 mm so lines can be
 * told apart even when the sheet isn't flat. Solid black corner markers fix the perspective.
 */
export function templateSvg(sheet: SheetSpec): string {
  const { width: W, height: H } = sheet;
  const m = SHEET_MARGIN;
  const minor: string[] = [], major: string[] = [], labels: string[] = [];
  let i = 0;
  for (let x = m; x <= W - m + 1e-6; x += GRID_PITCH, i++) {
    const line = `<line x1="${x.toFixed(2)}" y1="${m}" x2="${x.toFixed(2)}" y2="${(H - m).toFixed(2)}"/>`;
    (i % MAJOR_EVERY === 0 ? major : minor).push(line);
  }
  i = 0;
  for (let y = m; y <= H - m + 1e-6; y += GRID_PITCH, i++) {
    const line = `<line x1="${m}" y1="${y.toFixed(2)}" x2="${(W - m).toFixed(2)}" y2="${y.toFixed(2)}"/>`;
    if (i % MAJOR_EVERY === 0) {
      major.push(line);
      // Distance labels in the left margin, clear of the corner markers.
      if (y > m + MARKER_SIZE + 4 && y < H - m - MARKER_SIZE - 4)
        labels.push(`<text x="${m - 1.5}" y="${(y + 0.9).toFixed(2)}" text-anchor="end">${Math.round(y - m)}</text>`);
    } else minor.push(line);
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
<g stroke="#9a9a9a" stroke-width="${MINOR_LINE_MM}" fill="none">${minor.join('')}</g>
<g stroke="#6e6e6e" stroke-width="${MAJOR_LINE_MM}" fill="none">${major.join('')}</g>
<g font-family="sans-serif" font-size="2.4" fill="#888">${labels.join('')}</g>
${markers}
<text x="${W / 2}" y="${m - 3.5}" font-family="sans-serif" font-size="3.2" text-anchor="middle" fill="#555">Gridfinity Tracer · ${sheet.name} · print at 100% / actual size · ${GRID_PITCH} mm grid, bold every ${GRID_PITCH * MAJOR_EVERY} mm</text>
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
