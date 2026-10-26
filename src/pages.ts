// Page geometry cache. Every page of every loaded source is measured once so the
// viewer can lay out all pages before any of them is rendered.
import type { PDFPageProxy } from './pdfjs';
import { store, type Source } from './store';
import type { DocPage } from './model';

export interface PageInfo {
  view: [number, number, number, number];
  /** The page's own /Rotate value. */
  rotate: number;
  width: number;
  height: number;
}

const infos = new Map<string, PageInfo>();
const proxies = new Map<string, Promise<PDFPageProxy>>();
const resolved = new Map<string, PDFPageProxy>();

const key = (src: string, index: number) => `${src}:${index}`;

export async function measureSource(src: Source): Promise<void> {
  const n = src.pdf.numPages;
  const batch = 16;
  for (let start = 0; start < n; start += batch) {
    const jobs: Promise<void>[] = [];
    for (let i = start; i < Math.min(n, start + batch); i++) {
      jobs.push(
        pdfPage(src.id, i).then((p) => {
          resolved.set(key(src.id, i), p);
          const v = p.view as number[];
          infos.set(key(src.id, i), {
            view: [v[0], v[1], v[2], v[3]],
            rotate: ((p.rotate % 360) + 360) % 360,
            width: Math.abs(v[2] - v[0]),
            height: Math.abs(v[3] - v[1]),
          });
        }),
      );
    }
    await Promise.all(jobs);
  }
}

export function pdfPage(src: string, index: number): Promise<PDFPageProxy> {
  const k = key(src, index);
  let p = proxies.get(k);
  if (!p) {
    p = store.source(src).pdf.getPage(index + 1);
    proxies.set(k, p);
  }
  return p;
}

/** The pdf.js page object; available synchronously once the source was measured. */
export function pageProxy(p: Pick<DocPage, 'src' | 'index'>): PDFPageProxy {
  const proxy = resolved.get(key(p.src, p.index));
  if (!proxy) throw new Error(`Page ${p.src}:${p.index} not loaded`);
  return proxy;
}

export function pageInfo(p: Pick<DocPage, 'src' | 'index'>): PageInfo {
  const i = infos.get(key(p.src, p.index));
  if (!i) throw new Error(`Page ${p.src}:${p.index} not measured`);
  return i;
}

/** Total clockwise rotation used for display. */
export function totalRotation(p: DocPage): number {
  return (pageInfo(p).rotate + p.rot) % 360;
}

/** Visual (rotated) size of a page in points. */
export function visualSize(p: DocPage): { w: number; h: number } {
  const i = pageInfo(p);
  return totalRotation(p) % 180 === 0 ? { w: i.width, h: i.height } : { w: i.height, h: i.width };
}

export function forgetSource(src: string): void {
  for (const k of [...infos.keys()]) if (k.startsWith(`${src}:`)) infos.delete(k);
  for (const k of [...proxies.keys()]) if (k.startsWith(`${src}:`)) proxies.delete(k);
  for (const k of [...resolved.keys()]) if (k.startsWith(`${src}:`)) resolved.delete(k);
}

export function clearPages(): void {
  infos.clear();
  proxies.clear();
  resolved.clear();
}
