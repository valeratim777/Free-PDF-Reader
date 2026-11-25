import { describe, expect, it } from 'vitest';
import { annBBox, boxFrame, canRotate, rotateAnn } from '../src/geometry';
import { jpegInfo, swapsSides } from '../src/exif';
import { cleanUp } from '../src/features/scan';
import type { Annotation, ImageAnn, InkAnn, LineAnn } from '../src/model';

const base = { id: 'a', pageId: 'p', color: '#000', opacity: 1, created: 0 };

describe('turning marks a quarter turn', () => {
  const img: ImageAnn = { ...base, type: 'image', rect: { x1: 100, y1: 200, x2: 300, y2: 300 }, rot: 0, assetId: 'x' };

  it('turns a picture clockwise around its center, keeping its proportions', () => {
    const r = rotateAnn(img);
    expect(r.rot).toBe(270);
    // Center stays, width and height swap.
    expect(r.rect).toEqual({ x1: 150, y1: 150, x2: 250, y2: 350 });
    const before = boxFrame(img.rect, img.rot);
    const after = boxFrame(r.rect, r.rot);
    expect(after.w).toBeCloseTo(before.w);
    expect(after.h).toBeCloseTo(before.h);
    // Clockwise on screen: the picture's "right" (u axis) now points down the page (y decreases).
    expect(after.cos).toBeCloseTo(0);
    expect(after.sin).toBeCloseTo(-1);
  });

  it('comes back after four turns, either way', () => {
    let a: Annotation = img;
    for (let i = 0; i < 4; i++) a = rotateAnn(a);
    expect(a).toEqual(img);
    expect(rotateAnn(rotateAnn(img), false)).toEqual(img);
  });

  it('turns drawings and lines by their points', () => {
    const ink: InkAnn = { ...base, type: 'ink', width: 2, strokes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] };
    const r = rotateAnn(ink);
    // Horizontal stroke becomes vertical, around the same center (5, 0).
    expect(r.strokes[0][0].x).toBeCloseTo(5);
    expect(r.strokes[0][1].x).toBeCloseTo(5);
    expect(r.strokes[0][0].y).toBeCloseTo(5);
    expect(r.strokes[0][1].y).toBeCloseTo(-5);
    const line: LineAnn = { ...base, type: 'line', width: 1, p1: { x: 0, y: 0 }, p2: { x: 0, y: 10 } };
    const l = rotateAnn(line);
    expect(Math.abs(l.p2.x - l.p1.x)).toBeCloseTo(10);
    expect(Math.abs(l.p2.y - l.p1.y)).toBeCloseTo(0);
    expect(annBBox(l).x1 + annBBox(l).x2).toBeCloseTo(annBBox(line).x1 + annBBox(line).x2);
  });

  it('leaves text markups and notes alone', () => {
    expect(canRotate({ ...base, type: 'highlight', rects: [], rot: 0 })).toBe(false);
    expect(canRotate({ ...base, type: 'note', at: { x: 0, y: 0 }, text: '' })).toBe(false);
    expect(canRotate(img)).toBe(true);
  });
});

/** A minimal JPEG header: SOI, APP1 with an Exif orientation, SOF0 with the size, EOI. */
function fakeJpeg(orientation: number, w: number, h: number, little: boolean): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (little ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  tiff.push(...u16(1)); // one entry
  tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0);
  tiff.push(...u32(0));
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const sof = [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1,
    0xff, 0xc0, (sof.length + 2) >> 8, (sof.length + 2) & 255, ...sof,
    0xff, 0xd9,
  ]);
}

describe('photo orientation (EXIF)', () => {
  it('reads the orientation and the stored size', () => {
    expect(jpegInfo(fakeJpeg(6, 4000, 3000, true))).toEqual({ orientation: 6, width: 4000, height: 3000 });
    expect(jpegInfo(fakeJpeg(3, 640, 480, false))).toEqual({ orientation: 3, width: 640, height: 480 });
  });

  it('treats files without Exif as upright and rejects non-JPEG data', () => {
    const plain = fakeJpeg(1, 10, 20, true);
    expect(jpegInfo(plain)?.orientation).toBe(1);
    expect(jpegInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('knows which orientations swap width and height', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].filter(swapsSides)).toEqual([5, 6, 7, 8]);
  });
});

describe('scan clean-up', () => {
  /** A grey "paper" whose light falls off to one side, with a dark stroke of "ink". */
  function photo(): ImageData {
    const width = 512;
    const height = 96;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const paper = 200 - (x * 60) / width; // shadow towards the right
        const ink = x >= 250 && x < 254 && y > 20 && y < 70;
        const v = ink ? 40 : paper;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
      }
    return { width, height, data, colorSpace: 'srgb' } as ImageData;
  }

  it('turns uneven paper white and keeps the ink dark', () => {
    const img = photo();
    cleanUp(img, 'document');
    const at = (x: number, y: number) => img.data[(y * img.width + x) * 4];
    expect(at(5, 5)).toBeGreaterThan(235);
    expect(at(500, 80)).toBeGreaterThan(235);
    expect(at(251, 45)).toBeLessThan(40);
  });
});
