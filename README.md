# Gridfinity Tracer

Photograph your items on a printed grid and get a [Gridfinity](https://gridfinity.xyz/) bin with a pocket shaped to each one. Everything runs in the browser, and nothing is uploaded.

## How it works

1. **Print the template** (A4 or US Letter) from the app. It has a light-cyan 5 mm grid and four black corner markers. Print at 100% and check the 100 mm bar.
2. **Photograph** one or more items lying on the sheet. The app finds the markers, corrects perspective to a true top-down view at 0.25 mm per pixel, evens out the lighting, filters out the cyan grid and traces each item's outline.
   - **Shadows** are told apart from items by checking whether the printed grid lines are still visible at that spot (they show through a shadow, but not through an item) and by colour (shadows don't change it). A touch-up brush can erase or add areas by hand.
   - Using your own squared paper instead: choose *Own paper*, drag the four handles onto the corners of a rectangle you know the size of, and enter that size.
3. **Arrange**: items are rotated to their tightest orientation and packed into the smallest bin that fits your printer bed (or, if they can't fit, the most compact bigger bin, with a warning). The bin also resizes when you move items by hand. Drag to move, Shift-drag to rotate, set the depth of each item and add finger notches.
4. **Download** a binary STL: standard 42 × 42 × 7 mm Gridfinity base profile, optional magnet holes and stacking lip, pockets offset by your clearance.

## Development

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (geometry + vision on a synthetic photo)
npm run build      # static site in dist/

# browser smoke test (needs Playwright + Chromium, dev server running on :5173)
node e2e/smoke.mjs e2e-out
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
| `src/preview.ts` | three.js preview |

## Ideas / roadmap

- Several photos merged into one bin (works now: add items from each photo in turn)
- Per-item depth from a side photo; stepped pockets
- Better packing (nesting non-rectangular shapes)
- Outline editing (paint to add or remove areas)
- Labels, lightweight hollow bins, 3MF export
- Tolerance test print
