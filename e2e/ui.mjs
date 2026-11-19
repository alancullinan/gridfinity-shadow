// End-to-end test of the editor UI: tabs, capture, selection, dragging, handles, panels,
// keyboard shortcuts, designs, undo and download. Needs the dev server on :5173 and a photo
// made by e2e/smoke.mjs (pass its path), e.g.:
//   npx vite --port 5173 &  node e2e/smoke.mjs out && node e2e/ui.mjs out/photo.png
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const photo = process.argv[2];
const URL = 'http://localhost:5173/';
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('dialog', (d) => d.accept());
const gt = (fn, arg) => page.evaluate(fn, arg);
const settle = (ms = 450) => page.waitForTimeout(ms);
const item0 = () => gt(() => JSON.parse(JSON.stringify(window.__gt.items[0])));
const at = async (x, y) => gt(([x, y]) => window.__gt.clientPoint(x, y), [x, y]);
async function drag(from, to, steps = 8) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up();
  await settle();
}

await page.goto(URL);
await page.waitForFunction(() => document.body.dataset.modelReady);

// --- Template tab
check('starts on the Template tab', await page.isVisible('#view-template'));
await page.click('[data-paper="letter"]');
check('paper switch updates the preview', (await page.textContent('#template-preview')).includes('US Letter'));
await page.click('[data-paper="a4"]');

// --- Photo tab
await page.click('#tab-capture');
check('Photo tab shows the drop zone first', await page.isVisible('#capture-empty'));
await page.setInputFiles('#photo-choose', photo);
await page.waitForFunction(() => window.__gt.detected.length > 0);
check('outlines detected', (await gt(() => window.__gt.detected.length)) === 4, await page.textContent('#photo-status'));
await page.locator('#detected-body .det').first().locator('input[type=checkbox]').uncheck();
check('unchecking updates the add button', (await page.textContent('#add-items')).includes('Add 3 items'));
await page.locator('#detected-body .det').first().locator('input[type=checkbox]').check();
await page.click('#add-items');
await page.waitForFunction(() => window.__gt.items.length === 4 && document.body.dataset.modelReady);
await settle(900);
check('adding switches to the Design tab', await page.isVisible('#view-design'));
check('items list shows 4 rows', (await page.locator('#item-list .item-row').count()) === 4);
check('model info shown', /u\s+·/.test(await page.textContent('#model-info')), await page.textContent('#model-info'));

// --- Selection and dragging on the canvas
let it = await item0();
await page.mouse.click(...Object.values(await at(it.x, it.y)));
await settle();
check('clicking an item selects it', (await gt(() => window.__gt.sel.item)) === it.id);
check('properties show the selected item', (await page.inputValue('[data-key="item.name"]')) === it.name);
// Item 0 is the long bar along the bottom. Drag it up by 10 mm (there's room): it moves exactly.
const y0 = it.y;
const othersBefore = await gt(() => window.__gt.items.slice(1).map((i) => [i.x, i.y]));
await drag(await at(it.x, it.y), await at(it.x, it.y - 10));
it = await item0();
check('dragging moves the item 10 mm', Math.abs(it.y - (y0 - 10)) < 0.3, `dy=${(it.y - y0).toFixed(2)}`);
// Drag it far right, past the wall: it stops at the edge and nothing else moves.
await drag(await at(it.x, it.y), await at(it.x + 60, it.y));
const units = await gt(() => [window.__gt.settings.unitsX, window.__gt.settings.unitsY]);
const othersAfter = await gt(() => window.__gt.items.slice(1).map((i) => [i.x, i.y]));
check('the bin wall stops a dragged item', JSON.stringify(units) === '[6,3]' && (await item0()).x < 10, `x=${(await item0()).x.toFixed(2)} units=${units}`);
check('dragging one item never moves the others', JSON.stringify(othersBefore) === JSON.stringify(othersAfter));
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await settle();
check('Ctrl+Z undoes the moves and keeps the selection', Math.abs((await item0()).y - y0) < 0.01 && (await gt(() => window.__gt.sel.item)) === it.id);

// --- Keyboard: rotate, nudge
const r0 = (await item0()).rotation;
await page.keyboard.press('r');
await settle();
check('R rotates 90°', ((await item0()).rotation - r0 + 360) % 360 === 90);
await page.keyboard.press('[');
await settle();
check('[ rotates −15°', ((await item0()).rotation - r0 + 360) % 360 === 75);
await page.keyboard.press('Control+z');
await page.keyboard.press('Control+z');
await settle();
const ny = (await item0()).y;
await page.keyboard.press('Shift+ArrowUp');
await settle();
check('Shift+Arrow nudges 10 mm', Math.abs((await item0()).y - (ny - 10)) < 0.01);
await page.keyboard.press('Control+z');
await settle();

// --- Rotation handle
it = await item0();
const handle = await gt(() => {
  const i = window.__gt.items[0];
  let minX = 1e9, maxX = -1e9, minY = 1e9;
  for (const l of i.loops) for (const p of l) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); }
  // Handle sits 28 px above the local top edge; convert via two client points to find mm/px.
  const a = window.__gt.clientPoint(0, 0), b = window.__gt.clientPoint(1, 0);
  const off = 28 / (b.x - a.x);
  const lx = (minX + maxX) / 2, ly = minY - off, r = (i.rotation * Math.PI) / 180;
  return { x: i.x + lx * Math.cos(r) - ly * Math.sin(r), y: i.y + lx * Math.sin(r) + ly * Math.cos(r) };
});
const hp = await at(handle.x, handle.y);
const cp = await at(it.x, it.y);
// Drag the handle a quarter turn around the item centre.
const rr = Math.hypot(hp.x - cp.x, hp.y - cp.y);
const ang = Math.atan2(hp.y - cp.y, hp.x - cp.x) + Math.PI / 2;
await drag(hp, { x: cp.x + rr * Math.cos(ang), y: cp.y + rr * Math.sin(ang) }, 12);
check('rotation handle rotates by ~90°', ((await item0()).rotation - it.rotation + 360) % 360 === 90, `${it.rotation} -> ${(await item0()).rotation}`);
await page.keyboard.press('Control+z');
await settle();

// --- Notches
await page.click('[data-act="add-notch"]');
await settle();
it = await item0();
check('Add notch adds one', it.notches.length === 1);
const np = await gt(() => {
  const i = window.__gt.items[0], n = i.notches[0], r = (i.rotation * Math.PI) / 180;
  return { x: i.x + n.x * Math.cos(r) - n.y * Math.sin(r), y: i.y + n.x * Math.sin(r) + n.y * Math.cos(r) };
});
await drag(await at(np.x, np.y), await at(np.x, np.y + 30));
check('dragging the notch handle slides it along the edge', JSON.stringify((await item0()).notches[0]) !== JSON.stringify(it.notches[0]));

// --- Depth zones
await page.click('[data-act="add-zone"][data-v="rect"]');
await settle();
check('adding a zone selects it', (await gt(() => window.__gt.sel.zone)) === 0);
await page.fill('[data-key="zone.depth"]', '18');
await page.press('[data-key="zone.depth"]', 'Enter');
await settle(900);
check('zone depth field updates the zone', (await item0()).zones[0].depth === 18);
check('bin grows for the deeper zone', (await page.textContent('#model-info')).includes('× 4u'), await page.textContent('#model-info'));
await page.keyboard.press('Escape'); // leaves the depth box
await page.keyboard.press('Escape'); // deselects the zone
await settle();
check('Esc leaves a text box, then deselects the zone first', (await gt(() => window.__gt.sel)).zone === null && (await gt(() => window.__gt.sel)).item !== null);
// Tap inside the zone to select it, then drag it: the zone moves, the item doesn't.
it = await item0();
const zc = await gt(() => {
  const i = window.__gt.items[0], z = i.zones[0], r = (i.rotation * Math.PI) / 180;
  return { x: i.x + z.x * Math.cos(r) - z.y * Math.sin(r), y: i.y + z.x * Math.sin(r) + z.y * Math.cos(r) };
});
const zp = await at(zc.x, zc.y);
await page.mouse.click(zp.x, zp.y);
await settle();
check('tapping a zone selects it', (await gt(() => window.__gt.sel.zone)) === 0);
await drag(zp, { x: zp.x + 15, y: zp.y });
const after = await item0();
check('dragging a selected zone moves the zone, not the item', after.x === it.x && (after.zones[0].x !== it.zones[0].x || after.zones[0].y !== it.zones[0].y));
await page.keyboard.press('Delete');
await settle();
check('Delete removes the selected zone', (await item0()).zones.length === 0);

// --- Duplicate / delete item
await page.keyboard.press('Control+d');
await settle();
check('Ctrl+D duplicates the item', (await gt(() => window.__gt.items.length)) === 5);
await page.keyboard.press('Delete');
await settle();
check('Delete removes the item', (await gt(() => window.__gt.items.length)) === 4);

// --- Bin tab
await page.click('#ptab-bin');
await page.locator('[data-key="s.magnets"]').check();
await settle();
check('magnet switch updates settings', await gt(() => window.__gt.settings.magnets));
await page.click('[data-act="edge"][data-v="rim:chamfer"]');
await settle();
check('edge type control updates settings', (await gt(() => window.__gt.settings.rimEdge.type)) === 'chamfer');
await page.fill('[data-key="s.clearance"]', '0.6');
await page.press('[data-key="s.clearance"]', 'Tab');
await settle();
check('number field updates settings', (await gt(() => window.__gt.settings.clearance)) === 0.6);

// --- View modes
await page.click('[data-mode="3d"]');
check('3D view hides the layout', !(await page.isVisible('#layout-canvas')) && (await page.isVisible('#viewer')));
await page.click('[data-mode="split"]');
check('Split view shows both', (await page.isVisible('#layout-canvas')) && (await page.isVisible('#viewer')));

// --- Designs, New, Undo
await page.mouse.click(5, 300); // focus the page, not an input
await page.keyboard.press('Control+s');
await settle();
check('Ctrl+S on an untitled design opens Designs', await page.isVisible('#designs-dialog'));
await page.fill('#design-name-input', 'UI test');
await page.press('#design-name-input', 'Enter');
await settle();
check('design saved to the library', (await page.textContent('#designs-list')).includes('UI test'));
await page.click('#designs-dialog .dlg-foot button[value="close"]');
check('name shows in the app bar', (await page.inputValue('#design-name')) === 'UI test');
await page.click('#new-design');
await settle();
check('New empties the design', (await gt(() => window.__gt.items.length)) === 0 && (await page.isVisible('#stage-empty')));
await page.click('#undo');
await settle();
check('Undo brings it back', (await gt(() => window.__gt.items.length)) === 4);

// --- Download
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download-stl')]);
const file = '/tmp/ui-test.stl';
await dl.saveAs(file);
check('STL downloads', fs.statSync(file).size > 10000, `${dl.suggestedFilename()} ${fs.statSync(file).size} bytes`);

check('no console errors', errors.length === 0, errors.join(' | '));

// --- Phone width: no sideways scrolling on any tab
const phone = await browser.newPage({ ...devices['iPhone 13'] });
await phone.goto(URL);
await phone.waitForFunction(() => document.body.dataset.modelReady);
for (const tab of ['template', 'capture', 'design']) {
  await phone.evaluate((t) => window.__gt.setTab(t), tab);
  await phone.waitForTimeout(300);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`phone: no horizontal overflow on ${tab}`, overflow <= 0, `${overflow}px`);
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
