import { describe, expect, it } from 'vitest';
import {
  bboxOf,
  circlePath,
  flatten,
  moveHandle,
  nearestOnPath,
  pathFromPolygon,
  polygonArea,
  rectPath,
  splitSegment,
} from '../src/vision/path';

describe('editable paths', () => {
  it('flattens a circle to the right area and size', () => {
    const pts = flatten(circlePath(50, 40, 20));
    expect(polygonArea(pts)).toBeGreaterThan(Math.PI * 400 * 0.99);
    expect(polygonArea(pts)).toBeLessThan(Math.PI * 400 * 1.01);
    const b = bboxOf(pts);
    expect(b.w).toBeCloseTo(40, 0);
    expect(b.h).toBeCloseTo(40, 0);
  });

  it('keeps rectangles exact', () => {
    const pts = flatten(rectPath(30, 20, 10, 5));
    expect(pts.length).toBe(4);
    expect(bboxOf(pts)).toEqual({ x: 10, y: 5, w: 20, h: 15 });
  });

  it('turns a traced polygon into a compact path that stays on it', () => {
    // A 60 x 30 stadium sampled every 0.5 mm, with a little noise.
    const poly = [];
    const perim = 2 * 30 + Math.PI * 30;
    for (let s = 0; s < perim; s += 0.5) {
      let x, y;
      if (s < 30) (x = 15 + s), (y = 0);
      else if (s < 30 + Math.PI * 15) {
        const a = -Math.PI / 2 + (s - 30) / 15;
        (x = 45 + 15 * Math.cos(a)), (y = 15 + 15 * Math.sin(a));
      } else if (s < 60 + Math.PI * 15) (x = 45 - (s - 30 - Math.PI * 15)), (y = 30);
      else {
        const a = Math.PI / 2 + (s - 60 - Math.PI * 15) / 15;
        (x = 15 + 15 * Math.cos(a)), (y = 15 + 15 * Math.sin(a));
      }
      poly.push({ x: x + Math.sin(s * 7) * 0.08, y: y + Math.cos(s * 5) * 0.08 });
    }
    const path = pathFromPolygon(poly);
    expect(path.length).toBeLessThan(40);
    const flat = flatten(path);
    for (const p of flat) {
      const d = Math.min(...poly.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      expect(d).toBeLessThan(0.8);
    }
    expect(Math.abs(polygonArea(flat) - polygonArea(poly)) / polygonArea(poly)).toBeLessThan(0.01);
  });

  it('splits a curve without changing it', () => {
    const path = circlePath(0, 0, 10);
    const before = flatten(path, 0.1);
    const i = splitSegment(path, 1, 0.3);
    expect(path.length).toBe(5);
    expect(path[i].smooth).toBe(true);
    for (const p of flatten(path, 0.1)) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(0.05);
    }
    expect(Math.abs(polygonArea(flatten(path, 0.1)) - polygonArea(before))).toBeLessThan(0.5);
  });

  it('splits a straight edge into two straight edges', () => {
    const path = rectPath(0, 0, 20, 10);
    splitSegment(path, 0, 0.5);
    expect(path.length).toBe(5);
    expect(path[1]).toMatchObject({ x: 10, y: 0, smooth: false });
    expect(flatten(path).length).toBe(5);
  });

  it('finds the nearest point on a path', () => {
    const r = nearestOnPath(rectPath(0, 0, 20, 10), { x: 5, y: -2 });
    expect(r.seg).toBe(0);
    expect(r.dist).toBeCloseTo(2, 1);
  });

  it('keeps a smooth node smooth when a handle moves', () => {
    const path = circlePath(0, 0, 10);
    const nd = path[0];
    moveHandle(nd, 'out', nd.x + 3, nd.y + 8);
    const a = Math.atan2(nd.outY - nd.y, nd.outX - nd.x), b = Math.atan2(nd.inY - nd.y, nd.inX - nd.x);
    expect(Math.abs(Math.abs(a - b) - Math.PI)).toBeLessThan(1e-6);
    expect(Math.hypot(nd.inX - nd.x, nd.inY - nd.y)).toBeCloseTo(5.523, 2);
  });
});
