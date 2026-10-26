import { describe, expect, it } from 'vitest';
import { annBBox, apply, boxFrame, frameMatrixDown, frameMatrixUp, hitAnn, normRect, rectFromFrame, scaleAnn, smoothPath, translateAnn } from '../src/geometry';
import type { Annotation, QuarterTurn } from '../src/model';

describe('box frames', () => {
  const r = normRect(100, 200, 160, 230);
  for (const rot of [0, 90, 180, 270] as QuarterTurn[]) {
    it(`round-trips rect ↔ frame at ${rot}°`, () => {
      const f = boxFrame(r, rot);
      expect(rectFromFrame(f.ox, f.oy, f.w, f.h, rot)).toEqual(r);
      // Both matrices put the frame origin at (ox, oy) and keep the box inside the rect.
      const down = frameMatrixDown(f);
      const up = frameMatrixUp(f);
      for (const [u, v] of [
        [0, 0],
        [f.w, 0],
        [0, f.h],
        [f.w, f.h],
      ]) {
        const a = apply(down, u, v);
        const b = apply(up, u, -v);
        expect(a.x).toBeCloseTo(b.x);
        expect(a.y).toBeCloseTo(b.y);
        expect(a.x).toBeGreaterThanOrEqual(r.x1 - 1e-9);
        expect(a.x).toBeLessThanOrEqual(r.x2 + 1e-9);
        expect(a.y).toBeGreaterThanOrEqual(r.y1 - 1e-9);
        expect(a.y).toBeLessThanOrEqual(r.y2 + 1e-9);
      }
    });
  }

  it('reads upright: u runs along +x at 0° and +y at 90°', () => {
    expect(boxFrame(r, 0)).toMatchObject({ cos: 1, sin: 0, ox: 100, oy: 230 });
    expect(boxFrame(r, 90)).toMatchObject({ cos: 0, sin: 1, ox: 100, oy: 200 });
  });
});

const base = { pageId: 'p', color: '#000', opacity: 1, created: 0 };

describe('annotation transforms', () => {
  it('moves and scales shapes', () => {
    const a: Annotation = { ...base, id: 'a', type: 'rect', rect: normRect(0, 0, 10, 10), width: 0, fill: '#fff' };
    expect(annBBox(translateAnn(a, 5, -5))).toEqual(normRect(5, -5, 15, 5));
    expect(annBBox(scaleAnn(a, normRect(0, 0, 10, 10), normRect(0, 0, 20, 40)))).toEqual(normRect(0, 0, 20, 40));
  });

  it('scales text by font size and keeps its origin corner', () => {
    const a: Annotation = { ...base, id: 't', type: 'text', rect: normRect(0, 0, 50, 20), rot: 0, text: 'x', font: 'sans', bold: false, size: 10, bg: null, pad: 1 };
    const s = scaleAnn(a, a.rect, normRect(0, -20, 100, 20));
    expect(s.type === 'text' && s.size).toBe(20);
    expect(s.type === 'text' && s.rect).toEqual(normRect(0, -20, 100, 20));
  });

  it('hit-tests strokes with tolerance', () => {
    const line: Annotation = { ...base, id: 'l', type: 'line', p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, width: 2 };
    expect(hitAnn(line, { x: 50, y: 3 }, 3)).toBe(true);
    expect(hitAnn(line, { x: 50, y: 10 }, 3)).toBe(false);
    const hollow: Annotation = { ...base, id: 'r', type: 'rect', rect: normRect(0, 0, 100, 100), width: 2, fill: null };
    expect(hitAnn(hollow, { x: 50, y: 50 }, 3)).toBe(false);
    expect(hitAnn(hollow, { x: 1, y: 50 }, 3)).toBe(true);
  });

  it('flips paths for pdf-lib', () => {
    expect(smoothPath([{ x: 1, y: 2 }, { x: 3, y: 4 }], true)).toBe('M1 -2 L3 -4');
  });
});
