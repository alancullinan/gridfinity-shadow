# Gridfinity Tracer

Photograph your items on a printed grid and get a [Gridfinity](https://gridfinity.xyz/) bin with a pocket shaped to each one. Everything runs in the browser, and nothing is uploaded.

## How it works

1. **Print the template** (A4 or US Letter) from the app: a mid-grey 5 mm grid (0.45 mm lines) with a bold line every 25 mm, distance labels and four black corner markers. Print at 100% and check the 100 mm bar. The bold lines let the app straighten a curled sheet by up to about 10 mm; older prints still work.
2. **Photograph** one or more items lying on the sheet. The app finds the markers, corrects perspective to a true top-down view at 0.25 mm per pixel, evens out the lighting, filters out the cyan grid and traces each item's outline.
   - **Straightening:** the printed grid is used as a dense calibration target. If the sheet isn't perfectly flat (curl, bowing) or the lens distorts, the image is un-bent so every grid line lands where it belongs, keeping measurements accurate across the sheet.
   - **Shadows** are told apart from items by checking whether the printed grid lines are still visible (they show through a shadow but not through an item), and by comparing each spot with the local paper brightness measured beside visible lines, so shadowed paper matches its surroundings. Grid lines of any colour work (many printers print the cyan grid grey). Every outline can then be edited by hand (drag points and curve handles), or traced from scratch with the pen, rectangle and circle tools.
   - Using your own squared paper instead: choose *Own paper*, drag the four handles onto the corners of a rectangle you know the size of, and enter that size.
3. **Design** (best on a computer): a workspace with the items list, the layout and a live 3D preview side by side, and a properties panel. Click an item to select it; drag to move, use the round handle to rotate, and press **?** for keyboard shortcuts. items are rotated to their tightest orientation and packed into the smallest bin that fits your printer bed (or, if they can't fit, the most compact bigger bin, with a warning). The bin also resizes when you move items by hand. Drag to move, Shift-drag to rotate, set the depth of each item, add finger notches (drag them anywhere along the edge) and add **depth zones**: rectangles or circles that make part of a pocket deeper (e.g. under a handle) or shallower. Pocket rims and depth steps can be filleted or chamfered.
4. **Save** your work: designs autosave in the browser, can be saved by name, and exported/imported as files. Undo/redo (Ctrl+Z / Ctrl+Shift+Z) covers every design change.
5. **Download** a binary STL: standard 42 × 42 × 7 mm Gridfinity base profile, optional magnet holes and stacking lip, pockets offset by your clearance.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (geometry + vision on a synthetic photo)
npm run build      # static site in dist/

# browser tests (need Playwright + Chromium, dev server running on :5173)
node e2e/smoke.mjs e2e-out          # photo -> outlines -> bin -> STL
node e2e/ui.mjs e2e-out/photo.png   # editor: selection, handles, shortcuts, designs, undo
```

Pushing to `main` runs the tests and deploys to GitHub Pages. Enable it once under *Settings → Pages → Source: GitHub Actions*.

### Code map

| Path | What |
|---|---|
| `src/sheet.ts`, `src/template.ts` | Template geometry and printable SVG |
| `src/vision/markers.ts` | Corner-marker detection |
| `src/vision/homography.ts` | Perspective correction |
| `src/vision/segment.ts`, `contour.ts` | Lighting model, grid removal, outlines |
| `src/layout.ts` | Item model, auto-orientation, packing, notches |
| `src/gridfinity.ts` | Bin geometry with [manifold-3d](https://github.com/elalish/manifold), STL export |
| `src/main.ts` | App entry: tabs, model generation, shortcuts, drag & drop |
| `src/app/store.ts` | Design state, selection and change events |
| `src/app/capture.ts` | Template and photo steps |
| `src/app/layoutView.ts` | Interactive layout canvas (selection, handles, zoom/pan) |
| `src/app/panels.ts` | Items list and Item / Bin properties |
| `src/app/persistence.ts` | Undo/redo, autosave, Designs dialog |
| `src/ui/*` | Icons, toasts, DOM helpers |
| `src/preview.ts` | three.js preview (on-demand rendering, smooth fillet shading) |
| `src/storage.ts` | Design file format, validation, autosave/library, undo history |

## Ideas / roadmap

- Per-item depth from a side photo
- Better packing (nesting non-rectangular shapes)
- Outline editing (paint to add or remove areas)
- Labels, lightweight hollow bins, 3MF export
- Tolerance test print
