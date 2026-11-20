// End-to-end test of outline tracing on the Photo step: rectangle and circle tools, the pen,
// node dragging, inserting a point, deleting, undo, and adding traced shapes to the bin.
//   npx vite --port 5173 &  node e2e/smoke.mjs out && node e2e/trace.mjs out/photo.png [screenshot.png]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const [photo, shot] = process.argv.slice(2);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const gt = (fn, arg) => page.evaluate(fn, arg);
const at = (x, y) => gt(([x, y]) => window.__gt.traceClientPoint(x, y), [x, y]);
const shapes = () => gt(() => window.__gt.detected.map((d) => ({ id: d.id, w: +d.outline.bbox.w.toFixed(1), h: +d.outline.bbox.h.toFixed(1), x: d.outline.bbox.x, y: d.outline.bbox.y, traced: d.traced, edited: d.edited, nodes: d.paths[0].length })));
async function drag(a, b, steps = 10) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
  await page.waitForTimeout(80);
}

await page.goto('http://localhost:5173/');
await page.waitForFunction(() => document.body.dataset.modelReady);
await page.click('#tab-capture');
// Default: trace from scratch.
await page.setInputFiles('#photo-choose', photo);
await page.waitForFunction(() => /trace your items/.test(document.getElementById('photo-status').textContent));
check('auto-detect is off by default: no outlines, pen ready', (await gt(() => window.__gt.detected.length)) === 0 && (await page.locator('[data-tool="pen"].active').count()) === 1);
check('sliders hidden while tracing by hand', !(await page.isVisible('#threshold')));
await page.keyboard.press('Escape');
await page.check('#auto-detect');
await page.waitForFunction(() => window.__gt.detected.length > 0);
const auto = (await shapes()).length;
check('automatic outlines become editable paths', auto === 4 && (await shapes()).every((s) => s.nodes >= 3 && s.nodes < 80), JSON.stringify((await shapes()).map((s) => s.nodes)));

// Rectangle: drag on empty paper (bottom area of the A4 sheet).
await page.click('[data-tool="rect"]');
await drag(await at(120, 250), await at(160, 270));
let s = await shapes();
let rect = s.find((d) => d.traced);
check('rectangle tool draws to size', rect && Math.abs(rect.w - 40) < 0.6 && Math.abs(rect.h - 20) < 0.6, JSON.stringify(rect));
check('tool returns to Edit', await page.locator('[data-tool="edit"].active').count() === 1);
check('size label in list', (await page.textContent('#detected-body')).includes('40 × 20 mm'));

// Drag a corner node of the selected rectangle outwards.
await drag(await at(160, 270), await at(165, 275));
rect = (await shapes()).find((d) => d.id === rect.id);
check('dragging a node reshapes it', Math.abs(rect.w - 45) < 0.6 && Math.abs(rect.h - 25) < 0.6, JSON.stringify(rect));

// Undo the node drag.
await page.keyboard.press('Control+z');
rect = (await shapes()).find((d) => d.id === rect.id);
check('undo restores the shape', Math.abs(rect.w - 40) < 0.6, JSON.stringify(rect));

// Move the whole shape.
await drag(await at(140, 260), await at(150, 255));
rect = (await shapes()).find((d) => d.id === rect.id);
check('dragging the body moves it', Math.abs(rect.x - 130) < 0.6 && Math.abs(rect.y - 245) < 0.6, JSON.stringify(rect));

// Double-click on an edge inserts a point.
const mid = await at(150, 245);
await page.mouse.dblclick(mid.x, mid.y);
rect = (await shapes()).find((d) => d.id === rect.id);
check('double-click on an edge adds a point', rect.nodes === 5, String(rect.nodes));

// Pen: a triangle, closed by clicking the first point.
await page.click('[data-tool="pen"]');
for (const [x, y] of [[30, 250], [60, 250], [45, 275]]) {
  const p = await at(x, y);
  await page.mouse.click(p.x, p.y);
}
const first = await at(30, 250);
await page.mouse.click(first.x, first.y);
s = await shapes();
const tri = s.filter((d) => d.traced).find((d) => d.id !== rect.id);
check('pen draws a closed shape', tri && tri.nodes === 3 && Math.abs(tri.w - 30) < 0.6 && Math.abs(tri.h - 25) < 0.6, JSON.stringify(tri));

// Pen with a curve: click-drag makes a smooth node.
await page.keyboard.press('p');
const a = await at(80, 240), b = await at(100, 240), c = await at(100, 260);
await page.mouse.click(a.x, a.y);
await drag(b, await at(108, 248), 6);
await page.mouse.click(c.x, c.y);
await page.keyboard.press('Enter');
s = await shapes();
const curvy = s[s.length - 1];
const smooth = await gt((id) => window.__gt.detected.find((d) => d.id === id).paths[0].some((n) => n.smooth), curvy.id);
check('pen click-drag makes a curve; Enter closes', curvy.traced && curvy.nodes === 3 && smooth, JSON.stringify(curvy));

// Circle.
await page.keyboard.press('c');
await drag(await at(30, 200), await at(42, 200));
s = await shapes();
const circ = s[s.length - 1];
check('circle tool', Math.abs(circ.w - 24) < 0.6 && Math.abs(circ.h - 24) < 0.6, JSON.stringify(circ));

// Delete the selected circle.
await page.keyboard.press('Delete');
check('Delete removes the selected shape', (await shapes()).length === s.length - 1);
await page.keyboard.press('Control+z');
check('undo brings it back', (await shapes()).length === s.length);

// Re-running detection keeps traced shapes.
await page.locator('#threshold').fill('0.3');
await page.locator('#threshold').dispatchEvent('change');
await page.waitForTimeout(300);
check('traced shapes survive re-detection', (await shapes()).filter((d) => d.traced).length === 4);

// Zoom.
const before = await at(100, 100);
const ctr = await at(100, 150);
await page.mouse.move(ctr.x, ctr.y);
await page.mouse.wheel(0, -400);
await page.waitForTimeout(100);
const after = await at(100, 100);
check('wheel zooms about the cursor', Math.abs(after.y - ctr.y) > Math.abs(before.y - ctr.y) * 1.5);
if (shot) await page.screenshot({ path: shot });
await page.click('#trace-fit');

// Add to the bin.
const n = (await shapes()).length;
await page.click('#add-items');
await page.waitForFunction((n) => window.__gt.items.length === n && document.body.dataset.modelReady, n);
const items = await gt(() => window.__gt.items.map((i) => i.loops[0].length));
check('all shapes become bin items', items.length === n, JSON.stringify(items));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
