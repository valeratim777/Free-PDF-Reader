import { pdfjs, type PDFPageProxy } from '../pdfjs';
import type { DocPage, Pt, Rect } from '../model';
import { store } from '../store';
import { pageInfo, pageProxy, totalRotation } from '../pages';
import { rawTextContent } from '../text';
import { renderAnn, renderNumber, renderWatermark, svg } from '../annotations/render';
import { visualFrame } from '../decor';
import { normRect } from '../geometry';
import { buildFormLayer, syncFormLayer, type AnnotData } from './forms';

export type Viewport = ReturnType<PDFPageProxy['getViewport']>;

const MAX_CANVAS_PIXELS = 16_000_000;

export interface PageHooks {
  onRendered(pv: PageView): void;
  onLink(pv: PageView, dest: unknown): void;
}

/** One page in the continuous viewer, with its stacked layers. */
export class PageView {
  readonly div: HTMLDivElement;
  readonly textDiv: HTMLDivElement;
  readonly svgEl: SVGSVGElement;
  readonly annG: SVGGElement;
  readonly searchDiv: HTMLDivElement;
  readonly formDiv: HTMLDivElement;
  readonly captureDiv: HTMLDivElement;
  readonly uiDiv: HTMLDivElement;
  canvas: HTMLCanvasElement | null = null;
  page: DocPage;
  index = 0;
  total = 1;
  viewport!: Viewport;
  scale = 0;
  /** Annotation hidden while it is being edited in place. */
  hiddenAnn: string | null = null;
  textReady = false;
  private renderedKey = '';
  private pendingKey = '';
  private task: { cancel(): void; promise: Promise<unknown> } | null = null;
  private textLayer: InstanceType<typeof pdfjs.TextLayer> | null = null;
  private annots: AnnotData[] | null = null;

  constructor(
    page: DocPage,
    private hooks: PageHooks,
  ) {
    this.page = page;
    this.div = document.createElement('div');
    this.div.className = 'page';
    this.div.dataset.id = page.id;
    this.textDiv = layer('textLayer');
    this.svgEl = svg('svg', { class: 'annLayer' });
    this.annG = svg('g');
    this.svgEl.appendChild(this.annG);
    this.searchDiv = layer('searchLayer');
    this.formDiv = layer('formLayer');
    this.captureDiv = layer('captureLayer');
    this.uiDiv = layer('uiLayer');
    const loader = layer('pageLoader');
    this.div.append(loader, this.textDiv, this.svgEl, this.searchDiv, this.formDiv, this.captureDiv, this.uiDiv);
  }

  get proxy(): PDFPageProxy {
    return pageProxy(this.page);
  }

  get rotation(): number {
    return totalRotation(this.page);
  }

  get isPrimary(): boolean {
    return this.page.src === store.primary;
  }

  /** Updates size for a new scale or page rotation. Cheap; rendering happens later. */
  update(page: DocPage, scale: number): void {
    const rotChanged = page.rot !== this.page.rot;
    this.page = page;
    if (!rotChanged && scale === this.scale && this.viewport) return;
    this.scale = scale;
    this.viewport = this.proxy.getViewport({ scale, rotation: this.rotation });
    const { width, height } = this.viewport;
    this.div.style.width = `${Math.floor(width)}px`;
    this.div.style.height = `${Math.floor(height)}px`;
    this.div.style.setProperty('--total-scale-factor', String(scale));
    this.div.style.setProperty('--scale-round-x', '1px');
    this.div.style.setProperty('--scale-round-y', '1px');
    if (rotChanged) {
      this.release();
    } else if (this.textLayer) {
      this.textLayer.update({ viewport: this.viewport });
    }
    this.searchDiv.replaceChildren();
    this.drawOverlay();
    if (this.annots) this.buildForms();
  }

  get needsRender(): boolean {
    return this.renderedKey !== this.key();
  }

  get busy(): boolean {
    return this.pendingKey !== '';
  }

  private key(): string {
    return `${this.scale}:${this.rotation}`;
  }

  async render(): Promise<void> {
    const key = this.key();
    if (this.renderedKey === key || this.pendingKey === key) return;
    this.task?.cancel();
    this.pendingKey = key;
    const vp = this.viewport;
    const dpr = window.devicePixelRatio || 1;
    let out = dpr;
    if (vp.width * vp.height * out * out > MAX_CANVAS_PIXELS) out = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.className = 'pageCanvas';
    canvas.width = Math.max(1, Math.floor(vp.width * out));
    canvas.height = Math.max(1, Math.floor(vp.height * out));
    const task = this.proxy.render({
      canvas,
      viewport: vp,
      transform: out !== 1 ? [out, 0, 0, out, 0, 0] : undefined,
      annotationMode: this.isPrimary ? pdfjs.AnnotationMode.ENABLE_FORMS : pdfjs.AnnotationMode.ENABLE,
      background: '#ffffff',
    });
    this.task = task;
    try {
      await task.promise;
    } catch (e) {
      if (this.pendingKey === key) this.pendingKey = '';
      if ((e as Error)?.name !== 'RenderingCancelledException') console.warn('render failed', e);
      return;
    }
    if (this.pendingKey !== key) return;
    this.task = null;
    this.pendingKey = '';
    this.canvas?.remove();
    this.canvas = canvas;
    this.div.insertBefore(canvas, this.div.firstChild);
    this.div.classList.add('rendered');
    this.renderedKey = key;
    await Promise.all([this.renderText(), this.loadAnnots()]);
    this.hooks.onRendered(this);
  }

  private async renderText(): Promise<void> {
    if (this.textLayer) return;
    this.textReady = false;
    const content = await rawTextContent(this.page);
    if (this.textLayer || !this.canvas) return;
    this.textDiv.replaceChildren();
    const tl = new pdfjs.TextLayer({
      textContentSource: content as never,
      container: this.textDiv,
      viewport: this.viewport,
    });
    this.textLayer = tl;
    try {
      await tl.render();
      this.textReady = true;
    } catch {
      /* cancelled */
    }
  }

  get textDivs(): HTMLElement[] {
    return this.textLayer?.textDivs ?? [];
  }

  private async loadAnnots(): Promise<void> {
    if (!this.annots) {
      try {
        this.annots = (await this.proxy.getAnnotations({ intent: 'display' })) as AnnotData[];
      } catch {
        this.annots = [];
      }
    }
    this.buildForms();
  }

  private buildForms(): void {
    if (!this.annots) return;
    buildFormLayer(this.formDiv, this.annots, this.viewport, this.isPrimary, (dest) => this.hooks.onLink(this, dest));
  }

  syncForms(): void {
    if (this.annots) syncFormLayer(this.formDiv, this.annots);
  }

  /** Frees the canvas and text layer of a page that scrolled far away. */
  release(): void {
    this.task?.cancel();
    this.task = null;
    this.pendingKey = '';
    this.renderedKey = '';
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
      this.canvas.remove();
      this.canvas = null;
    }
    this.textLayer?.cancel();
    this.textLayer = null;
    this.textReady = false;
    this.textDiv.replaceChildren();
    this.searchDiv.replaceChildren();
    this.div.classList.remove('rendered');
  }

  drawOverlay(): void {
    if (!this.viewport) return;
    const { width, height, transform } = this.viewport;
    this.svgEl.setAttribute('width', String(width));
    this.svgEl.setAttribute('height', String(height));
    this.annG.setAttribute('transform', `matrix(${transform.join(' ')})`);
    const nodes: SVGElement[] = [];
    for (const a of store.annsOf(this.page.id)) {
      if (a.id === this.hiddenAnn) continue;
      nodes.push(renderAnn(a, store.assets));
    }
    const { watermark, numbering } = store.state;
    if (watermark || numbering) {
      const f = visualFrame(pageInfo(this.page).view, this.rotation);
      if (watermark) nodes.push(renderWatermark(f, watermark));
      if (numbering) nodes.push(renderNumber(f, numbering, this.index, this.total));
    }
    this.annG.replaceChildren(...nodes);
  }

  // ---- coordinate helpers ----

  /** Client (screen) coordinates → user space of this page. */
  toUser(clientX: number, clientY: number): Pt {
    const r = this.div.getBoundingClientRect();
    const sx = r.width / this.viewport.width || 1;
    const sy = r.height / this.viewport.height || 1;
    const [x, y] = this.viewport.convertToPdfPoint((clientX - r.left) / sx, (clientY - r.top) / sy);
    return { x, y };
  }

  /** User space → CSS pixels relative to the page's top-left corner. */
  toView(p: Pt): { x: number; y: number } {
    const [x, y] = this.viewport.convertToViewportPoint(p.x, p.y);
    return { x, y };
  }

  /** A user-space rect → CSS pixel box relative to the page. */
  rectToView(r: Rect): { left: number; top: number; width: number; height: number } {
    const a = this.toView({ x: r.x1, y: r.y1 });
    const b = this.toView({ x: r.x2, y: r.y2 });
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  }

  /** A client rect (e.g. from a DOM Range) → user-space rect. */
  clientRectToUser(cr: DOMRect | { left: number; top: number; right: number; bottom: number }): Rect {
    const a = this.toUser(cr.left, cr.top);
    const b = this.toUser(cr.right, cr.bottom);
    return normRect(a.x, a.y, b.x, b.y);
  }

  /**
   * Reads the rendered page inside `r`: background and text colors, and the
   * typical stroke width relative to `fontSize` (≈0.08 regular, ≈0.18 bold).
   */
  sampleColors(r: Rect, fontSize = 0): { bg: string; fg: string; stem: number } | null {
    if (!this.canvas) return null;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    const v = this.rectToView(r);
    const k = this.canvas.width / this.viewport.width;
    const x = Math.max(0, Math.floor(v.left * k));
    const y = Math.max(0, Math.floor(v.top * k));
    const w = Math.max(1, Math.min(this.canvas.width - x, Math.ceil(v.width * k)));
    const h = Math.max(1, Math.min(this.canvas.height - y, Math.ceil(v.height * k)));
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(x, y, w, h).data;
    } catch {
      return null;
    }
    // Background: the most frequent color; foreground: the color farthest from it.
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const c = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let bgKey = 0;
    let best = -1;
    for (const [c, n] of counts)
      if (n > best) {
        best = n;
        bgKey = c;
      }
    const bg = [((bgKey >> 10) & 31) * 8 + 4, ((bgKey >> 5) & 31) * 8 + 4, (bgKey & 31) * 8 + 4];
    let fg = [0, 0, 0];
    let far = -1;
    for (let i = 0; i < data.length; i += 4) {
      const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
      if (d > far) {
        far = d;
        fg = [data[i], data[i + 1], data[i + 2]];
      }
    }
    const hex = (c: number[]) => '#' + c.map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('');
    // Horizontal runs of "ink" pixels approximate the vertical stem width.
    const runs: number[] = [];
    const inkAt = (i: number) => Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > far * 0.5;
    for (let row = 0; row < h; row++) {
      let run = 0;
      for (let col = 0; col < w; col++) {
        if (inkAt((row * w + col) * 4)) run++;
        else if (run) {
          runs.push(run);
          run = 0;
        }
      }
      if (run) runs.push(run);
    }
    runs.sort((a, b) => a - b);
    const fontPx = fontSize * this.viewport.scale * k;
    const stem = runs.length > 10 && fontPx > 0 ? runs[Math.floor(runs.length / 2)] / fontPx : 0;
    return { bg: hex(bg), fg: far < 60 ? '#000000' : hex(fg), stem };
  }

  destroy(): void {
    this.release();
    this.div.remove();
  }
}

function layer(cls: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
