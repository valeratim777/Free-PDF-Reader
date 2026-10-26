// Layout of document-wide decorations (watermark, page numbers) in the visual
// frame of a page. Shared by the on-screen preview and the PDF writer.
import type { NumberPosition, PageNumbering } from './model';
import { pageFrame, type Frame } from './geometry';

export const NUMBER_MARGIN = 24;

export interface NumberLayout {
  x: number;
  /** Baseline, measured downward from the top of the visual page. */
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

export function numberLayout(f: Frame, pos: NumberPosition, size: number): NumberLayout {
  const top = pos.startsWith('top');
  const y = top ? NUMBER_MARGIN + size * 0.8 : f.h - NUMBER_MARGIN;
  if (pos.endsWith('left')) return { x: NUMBER_MARGIN, y, anchor: 'start' };
  if (pos.endsWith('right')) return { x: f.w - NUMBER_MARGIN, y, anchor: 'end' };
  return { x: f.w / 2, y, anchor: 'middle' };
}

export function numberText(n: PageNumbering, index: number, total: number): string {
  return n.format.split('{n}').join(String(index + n.start)).split('{total}').join(String(total + n.start - 1));
}

export function visualFrame(view: number[], rotation: number): Frame {
  return pageFrame([view[0], view[1], view[2], view[3]], rotation);
}

/** Geometry of a stamp box for a label of the given width at font size `size`. */
export function stampBox(textWidth: number, size: number): { w: number; h: number; padX: number; baseline: number; border: number; radius: number } {
  const padX = size * 0.6;
  const h = size * 1.7;
  return { w: textWidth + padX * 2, h, padX, baseline: h / 2 + size * 0.36, border: Math.max(1, size * 0.12), radius: size * 0.35 };
}
