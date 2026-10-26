// Small page previews for the sidebar and the page organizer.
import type { DocPage } from '../model';
import { pdfPage, totalRotation } from '../pages';

const cache = new Map<string, HTMLCanvasElement>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const MAX_CACHE = 400;

function pump(): void {
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

/** Draws a thumbnail of `page` into `target` (fit to `width` × `height` CSS px). */
export function drawThumb(page: DocPage, target: HTMLCanvasElement, width: number): Promise<void> {
  const rotation = totalRotation(page);
  const key = `${page.src}:${page.index}:${rotation}:${width}`;
  const hit = cache.get(key);
  if (hit) {
    copy(hit, target);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    queue.push(async () => {
      try {
        const p = await pdfPage(page.src, page.index);
        const base = p.getViewport({ scale: 1, rotation });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const scale = (width / base.width) * dpr;
        const vp = p.getViewport({ scale, rotation });
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(vp.width));
        c.height = Math.max(1, Math.round(vp.height));
        await p.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
        cache.set(key, c);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
        copy(c, target);
      } catch {
        /* page may have been removed meanwhile */
      }
      resolve();
    });
    pump();
  });
}

function copy(src: HTMLCanvasElement, dst: HTMLCanvasElement): void {
  dst.width = src.width;
  dst.height = src.height;
  dst.getContext('2d')?.drawImage(src, 0, 0);
}

export function clearThumbs(): void {
  cache.clear();
  queue.length = 0;
}
