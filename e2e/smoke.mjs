// End-to-end smoke test: renders the printable template with some "items" on it in 3D
// perspective (as a stand-in for a phone photo), feeds it to the app, and checks the
// detected sizes and the generated model. Run with the dev server on :5173:
//   npx vite --port 5173 &  node e2e/smoke.mjs [outdir]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // CommonJS require honours NODE_PATH
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'e2e-out';
fs.mkdirSync(out, { recursive: true });
const URL = 'http://localhost:5173/';
const browser = await chromium.launch();

// 1. Make a fake photo.
const maker = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 });
await maker.goto(URL);
const svg = await maker.evaluate(async () => {
  const t = await import('/src/template.ts');
  const s = await import('/src/sheet.ts');
  return t.templateSvg(s.SHEETS.a4);
});
const K = 3.5; // css px per mm
const mm = (v) => `${v * K}px`;
await maker.setContent(`<html><body style="margin:0;background:#6d5a48;width:900px;height:1200px;overflow:hidden">
<div style="perspective:1400px;width:900px;height:1200px;display:grid;place-items:center">
 <div style="position:relative;width:${mm(210)};height:${mm(297)};transform:rotateX(16deg) rotateY(-5deg) rotateZ(-7deg);box-shadow:0 10px 40px #0006">
  <div style="position:absolute;inset:0">${svg.replace('width="210mm" height="297mm"', `width="${210 * K}" height="${297 * K}"`)}</div>
  <div style="position:absolute;left:${mm(40)};top:${mm(50)};width:${mm(90)};height:${mm(18)};background:#2b2f36;border-radius:${mm(4)};filter:drop-shadow(${mm(2)} ${mm(2.5)} ${mm(1.5)} rgba(0,0,0,0.45))"></div>
  <div style="position:absolute;left:${mm(130)};top:${mm(120)};width:${mm(30)};height:${mm(30)};background:#c0392b;border-radius:50%;filter:drop-shadow(${mm(2)} ${mm(2.5)} ${mm(1.5)} rgba(0,0,0,0.45))"></div>
  <svg style="position:absolute;left:0;top:0;filter:drop-shadow(${mm(2)} ${mm(2.5)} ${mm(1.5)} rgba(0,0,0,0.45))" width="${210 * K}" height="${297 * K}" viewBox="0 0 210 297">
    <path d="M40 150 h14 v70 h46 v14 h-60 z" fill="#d68910"/>
  </svg>
  <div style="position:absolute;left:${mm(170)};top:${mm(30)};width:${mm(25)};height:${mm(230)};background:#8d9299;border-radius:${mm(3)};${'filter:drop-shadow(' + mm(2) + ' ' + mm(2.5) + ' ' + mm(1.5) + ' rgba(0,0,0,0.45))'}"></div>
  <div style="position:absolute;inset:0;background:linear-gradient(120deg,#0000 40%,#0003)"></div>
 </div>
</div></body></html>`);
const photoPath = path.join(out, 'photo.png');
await maker.screenshot({ path: photoPath });

// 2. Feed it to the app.
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL);
await page.click('#tab-capture');
await page.setInputFiles('#photo-choose', photoPath);
await page.waitForFunction(() => window.__gt.detected.length > 0, null, { timeout: 20000 });
const status = await page.textContent('#photo-status');
const sizes = await page.evaluate(() =>
  window.__gt.detected.map((d) => [d.outline.bbox.w, d.outline.bbox.h].map((v) => +v.toFixed(1))),
);
console.log('status:', status);
console.log('detected bbox sizes (mm):', JSON.stringify(sizes));
await page.screenshot({ path: path.join(out, 'step2.png'), fullPage: true });

await page.click('#add-items');
await page.waitForFunction(() => document.body.dataset.modelReady && window.__gt.items.length > 0, null, { timeout: 20000 });
await page.waitForTimeout(800);
console.log('model:', await page.textContent('#model-info'));
console.log('warnings:', await page.textContent('#warnings'));
await page.screenshot({ path: path.join(out, 'step3-4.png'), fullPage: true });

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-stl')]);
const stlPath = path.join(out, 'bin.stl');
await dl.saveAs(stlPath);
console.log('stl bytes:', fs.statSync(stlPath).size);
console.log('errors:', errors.length ? errors : 'none');

// Expected: 90 x 18 rounded bar, 30 mm disc, 60 x 84 L-shape, 25 x 230 grey bar (all with shadows).
const expected = [[90, 18], [30, 30], [60, 84], [25, 230]];
let ok = sizes.length === 4;
const units = await page.evaluate(() => [window.__gt.settings.unitsX, window.__gt.settings.unitsY]);
console.log('bin units:', units.join(' x '));
if (Math.max(...units) < 6) ok = false; // the 230 mm bar needs at least 6 units
for (const [ew, eh] of expected) {
  const hit = sizes.some(([w, h]) => Math.abs(w - ew) < 1.5 && Math.abs(h - eh) < 1.5);
  if (!hit) ok = false;
  console.log(`expected ${ew}x${eh}:`, hit ? 'OK' : 'MISSING');
}
await browser.close();
process.exit(ok && !errors.length ? 0 : 1);
