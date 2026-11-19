import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { BinSettings, GF, Item, binOuterSize, placedLoops, placedNotches, placedZone, requiredHeightUnits } from './layout';

/** Tracks WASM objects so intermediates can be freed in one go. */
class Scope {
  private objs: { delete(): void }[] = [];
  t<T extends { delete(): void }>(o: T): T {
    this.objs.push(o);
    return o;
  }
  free(keep?: unknown) {
    for (const o of this.objs) if (o !== keep) o.delete();
    this.objs = [];
  }
}

export interface BinResult {
  manifold: Manifold;
  unitsZ: number;
  warnings: string[];
  size: [number, number, number];
}

const SEGS = 40;

export function buildBin(wasm: ManifoldToplevel, items: Item[], settings: BinSettings): BinResult {
  const { Manifold, CrossSection } = wasm;
  const s = new Scope();
  const warnings: string[] = [];

  const roundedRect = (w: number, h: number, r: number): CrossSection => {
    r = Math.max(0.01, Math.min(r, w / 2 - 0.01, h / 2 - 0.01));
    return s.t(s.t(CrossSection.square([w - 2 * r, h - 2 * r], true)).offset(r, 'Round', 2, SEGS));
  };
  /** Frustum between two rounded rectangles at heights z0 and z1. */
  const frustum = (w0: number, h0: number, r0: number, z0: number, w1: number, h1: number, r1: number, z1: number) => {
    const pts: [number, number, number][] = [];
    for (const poly of roundedRect(w0, h0, r0).toPolygons()) for (const p of poly) pts.push([p[0], p[1], z0]);
    for (const poly of roundedRect(w1, h1, r1).toPolygons()) for (const p of poly) pts.push([p[0], p[1], z1]);
    return s.t(Manifold.hull(pts));
  };

  const nx = settings.unitsX, ny = settings.unitsY;
  const needZ = requiredHeightUnits(items, settings);
  let nz = settings.unitsZ > 0 ? settings.unitsZ : needZ;
  if (nz < needZ) warnings.push(`Height ${nz}u is too shallow for the deepest pocket; using ${needZ}u.`);
  nz = Math.max(nz, needZ);
  const W = binOuterSize(nx), D = binOuterSize(ny), top = nz * GF.heightUnit;
  const R = GF.cornerRadius;

  // --- Base: one profiled foot per grid cell -----------------------------------------
  const cell = binOuterSize(1); // 41.5
  const foot0 = cell - 2 * (0.8 + 2.15); // 35.6
  const foot1 = foot0 + 2 * 0.8; // 37.2
  const footParts: Manifold[] = [];
  const oneFoot = Manifold.union([
    frustum(foot0, foot0, 0.8, 0, foot1, foot1, 1.6, 0.8),
    s.t(s.t(roundedRect(foot1, foot1, 1.6).extrude(1.8)).translate([0, 0, 0.8])),
    frustum(foot1, foot1, 1.6, 2.6, cell, cell, R, GF.baseHeight),
  ]);
  s.t(oneFoot);
  let foot = oneFoot;
  if (settings.magnets) {
    const holes = [-13, 13].flatMap((x) =>
      [-13, 13].map((y) => s.t(s.t(Manifold.cylinder(2.4, 3.25, 3.25, 32)).translate([x, y, -0.01]))),
    );
    foot = s.t(foot.subtract(s.t(Manifold.union(holes))));
  }
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++)
      footParts.push(s.t(foot.translate([(i - (nx - 1) / 2) * GF.pitch, (j - (ny - 1) / 2) * GF.pitch, 0])));

  // --- Body and stacking lip ---------------------------------------------------------
  const outline = roundedRect(W, D, R);
  const parts: Manifold[] = [...footParts, s.t(s.t(outline.extrude(top - GF.baseHeight)).translate([0, 0, GF.baseHeight]))];
  if (settings.lip) {
    const lipSolid = s.t(s.t(outline.extrude(GF.lipHeight)).translate([0, 0, top]));
    const ins = (d: number) => [W - 2 * d, D - 2 * d, Math.max(0.3, R - d)] as const;
    const z = (t: number) => top + t;
    const cavity = Manifold.union([
      frustum(...ins(2.6), z(-0.01), ...ins(1.9), z(0.7)),
      frustum(...ins(1.9), z(0.7), ...ins(1.9), z(2.5)),
      frustum(...ins(1.9), z(2.5), ...ins(-0.6), z(GF.lipHeight + 0.6)),
    ]);
    s.t(cavity);
    parts.push(s.t(lipSolid.subtract(cavity)));
  }
  let bin = s.t(Manifold.union(parts));

  // --- Pockets -----------------------------------------------------------------------
  const cutTop = top + GF.lipHeight + 1;
  const pocketShapes: CrossSection[] = [];
  const cuts: Manifold[] = [];
  let sumArea = 0;
  for (const item of items) {
    // Top view uses y down; the model uses y up, so flip.
    const polys = placedLoops(item).map((l) => l.map((p) => [p.x, -p.y] as [number, number]));
    const pocket = s.t(s.t(s.t(new CrossSection(polys, 'NonZero')).offset(settings.clearance, 'Round', 2, SEGS)).simplify(0.02));
    let shape = pocket;
    for (const nc of placedNotches(item)) {
      const circle = s.t(s.t(CrossSection.circle(settings.fingerRadius, SEGS)).translate([nc.x, -nc.y]));
      // Notches are cut separately so they can stop a little shallower than very deep pockets.
      const notchDepth = Math.min(item.depth, Math.max(8, item.depth * 0.8));
      cuts.push(s.t(s.t(circle.extrude(cutTop - (top - notchDepth))).translate([0, 0, top - notchDepth])));
      shape = s.t(shape.add(circle));
    }
    sumArea += shape.area();
    pocketShapes.push(shape);

    // Depth layers: the pocket at the item's depth, then each zone (clipped to the pocket) at its
    // own depth. Later layers win, so each layer only keeps the part no later layer covers.
    const layers: { region: CrossSection; depth: number }[] = [{ region: pocket, depth: item.depth }];
    item.zones.forEach((z, zi) => {
      const poly = placedZone(item, z).map((p) => [p.x, -p.y] as [number, number]);
      const region = s.t(pocket.intersect(s.t(new CrossSection([poly], 'NonZero'))));
      if (region.area() < 0.5) warnings.push(`Depth zone ${zi + 1} on "${item.name}" doesn't overlap its pocket.`);
      else layers.push({ region, depth: z.depth });
    });
    for (let li = 0; li < layers.length; li++) {
      let region = layers[li].region;
      if (li + 1 < layers.length) region = s.t(region.subtract(s.t(CrossSection.union(layers.slice(li + 1).map((l) => l.region)))));
      if (region.area() < 0.01) continue;
      const d = layers[li].depth;
      cuts.push(s.t(s.t(region.extrude(cutTop - (top - d))).translate([0, 0, top - d])));
    }
    // Bounds check against the usable area.
    const usable = roundedRect(W - 2 * GF.edgeMargin, D - 2 * GF.edgeMargin, Math.max(0.5, R - GF.edgeMargin));
    if (s.t(shape.subtract(usable)).area() > 0.5) warnings.push(`"${item.name}" sticks out past the bin's inner edge.`);
  }
  if (pocketShapes.length > 1) {
    const union = s.t(CrossSection.union(pocketShapes));
    if (sumArea - union.area() > 0.5) warnings.push('Some pockets overlap each other.');
  }
  if (cuts.length) bin = s.t(bin.subtract(s.t(Manifold.union(cuts))));

  s.free(bin);
  return { manifold: bin, unitsZ: nz, warnings, size: [W, D, top + (settings.lip ? GF.lipHeight : 0)] };
}

/** Binary STL from a manifold. */
export function toStl(m: Manifold): ArrayBuffer {
  const mesh = m.getMesh();
  const { numProp, vertProperties: v, triVerts: t } = mesh;
  const nTri = t.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const dv = new DataView(buf);
  const header = 'Gridfinity Tracer';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (let i = 0; i < nTri; i++) {
    const p = [0, 1, 2].map((k) => {
      const vi = t[i * 3 + k] * numProp;
      return [v[vi], v[vi + 1], v[vi + 2]];
    });
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1], wz = p[2][2] - p[0][2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const val of [nx, ny, nz, ...p[0], ...p[1], ...p[2]]) {
      dv.setFloat32(o, val, true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}
