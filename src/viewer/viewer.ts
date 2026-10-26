import { store } from '../store';
import { visualSize } from '../pages';
import { PageView, type PageHooks } from './pageView';

export type ZoomMode = 'auto' | 'width' | 'page' | 'custom';

const PAD = 16;
const GAP = 12;
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;

/** Continuous vertical scroll viewer with lazy page rendering. */
export class Viewer extends EventTarget {
  readonly scroller: HTMLElement;
  readonly pagesEl: HTMLElement;
  views = new Map<string, PageView>();
  order: PageView[] = [];
  scale = 1;
  mode: ZoomMode = 'auto';
  current = 0;
  private visible = new Set<PageView>();
  private io: IntersectionObserver;
  private renderTimer = 0;
  private rendering = 0;
  private scrollRaf = 0;

  constructor(scroller: HTMLElement, private hooks: PageHooks) {
    super();
    this.scroller = scroller;
    this.pagesEl = document.createElement('div');
    this.pagesEl.className = 'pages';
    scroller.appendChild(this.pagesEl);
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: scroller,
      rootMargin: '120% 0px 120% 0px',
    });
    scroller.addEventListener('scroll', () => {
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        this.updateCurrent();
      });
    });
    new ResizeObserver(() => {
      if (this.mode !== 'custom' && this.order.length) this.applyScale(this.fitScale(this.mode));
    }).observe(scroller);
  }

  /** Synchronizes page views with the document's page list. */
  rebuild(): void {
    const pages = store.state.pages;
    const keep = new Set(pages.map((p) => p.id));
    for (const [id, v] of this.views) {
      if (!keep.has(id)) {
        this.io.unobserve(v.div);
        this.visible.delete(v);
        v.destroy();
        this.views.delete(id);
      }
    }
    if (!pages.length) {
      this.order = [];
      this.pagesEl.replaceChildren();
      return;
    }
    const scale = this.mode === 'custom' ? this.scale : this.fitScale(this.mode, pages[0].id);
    this.scale = scale;
    const order: PageView[] = [];
    pages.forEach((p, i) => {
      let v = this.views.get(p.id);
      if (!v) {
        v = new PageView(p, this.hooks);
        this.views.set(p.id, v);
        this.io.observe(v.div);
      }
      v.index = i;
      v.total = pages.length;
      v.update(p, scale);
      order.push(v);
    });
    // Reorder DOM only where needed.
    order.forEach((v, i) => {
      if (this.pagesEl.children[i] !== v.div) this.pagesEl.insertBefore(v.div, this.pagesEl.children[i] ?? null);
    });
    this.order = order;
    for (const v of order) v.drawOverlay();
    this.current = Math.min(this.current, order.length - 1);
    this.scheduleRender();
    this.updateCurrent();
  }

  get currentView(): PageView | undefined {
    return this.order[this.current];
  }

  fitScale(mode: ZoomMode, pageId?: string): number {
    const p = store.state.pages.find((x) => x.id === pageId) ?? store.state.pages[this.current] ?? store.state.pages[0];
    if (!p) return 1;
    const { w, h } = visualSize(p);
    const sw = this.scroller.clientWidth - PAD * 2;
    const sh = this.scroller.clientHeight - PAD * 2;
    if (mode === 'width') return clamp(Math.min(sw / w, 4));
    if (mode === 'page') return clamp(Math.min(sw / w, sh / h));
    if (mode === 'auto') {
      // Portrait pages: fit the width but don't blow them up on big screens;
      // landscape pages: show the whole page.
      return clamp(w > h ? Math.min(sw / w, sh / h) : Math.min(sw / w, 1.25));
    }
    return this.scale;
  }

  setMode(mode: ZoomMode): void {
    this.mode = mode;
    if (mode !== 'custom') {
      this.applyScale(this.fitScale(mode));
      this.centerCurrent();
    }
    this.emitZoom();
  }

  /** Centers the current page horizontally (pages of mixed widths overflow). */
  centerCurrent(): void {
    const v = this.order[this.current];
    if (!v) return;
    const s = this.scroller;
    s.scrollLeft = v.div.offsetLeft + v.div.offsetWidth / 2 - s.clientWidth / 2;
  }

  zoomTo(scale: number, anchor?: { x: number; y: number }): void {
    this.mode = 'custom';
    this.applyScale(clamp(scale), anchor);
    this.emitZoom();
  }

  zoomBy(factor: number, anchor?: { x: number; y: number }): void {
    this.zoomTo(this.scale * factor, anchor);
  }

  private emitZoom(): void {
    this.dispatchEvent(new Event('zoom'));
  }

  /** Changes the scale while keeping the point under `anchor` (scroller-relative px) fixed. */
  applyScale(scale: number, anchor?: { x: number; y: number }): void {
    if (!this.order.length) {
      this.scale = scale;
      return;
    }
    const ax = anchor?.x ?? this.scroller.clientWidth / 2;
    const ay = anchor?.y ?? this.scroller.clientHeight / 2;
    const cx = this.scroller.scrollLeft + ax;
    const cy = this.scroller.scrollTop + ay;
    const ref = this.viewAtContentY(cy) ?? this.order[this.current];
    const relX = (cx - ref.div.offsetLeft) / (ref.div.offsetWidth || 1);
    const relY = (cy - ref.div.offsetTop) / (ref.div.offsetHeight || 1);
    this.scale = scale;
    for (const v of this.order) v.update(v.page, scale);
    this.scroller.scrollLeft = ref.div.offsetLeft + relX * ref.div.offsetWidth - ax;
    this.scroller.scrollTop = ref.div.offsetTop + relY * ref.div.offsetHeight - ay;
    this.emitZoom();
    this.scheduleRender(120);
  }

  private viewAtContentY(y: number): PageView | undefined {
    let lo = 0;
    let hi = this.order.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const d = this.order[mid].div;
      if (y < d.offsetTop - GAP / 2) hi = mid - 1;
      else if (y > d.offsetTop + d.offsetHeight + GAP / 2) lo = mid + 1;
      else return this.order[mid];
    }
    return this.order[Math.max(0, Math.min(this.order.length - 1, lo))];
  }

  private updateCurrent(): void {
    if (!this.order.length) return;
    const y = this.scroller.scrollTop + this.scroller.clientHeight * 0.35;
    const v = this.viewAtContentY(y);
    const i = v ? this.order.indexOf(v) : 0;
    if (i !== this.current) {
      this.current = i;
      this.dispatchEvent(new Event('pagechange'));
    }
  }

  scrollToPage(i: number, opts: { userY?: number; userX?: number; smooth?: boolean } = {}): void {
    const v = this.order[Math.max(0, Math.min(this.order.length - 1, i))];
    if (!v) return;
    let top = v.div.offsetTop - PAD / 2;
    let left = v.div.offsetWidth <= this.scroller.clientWidth ? v.div.offsetLeft + v.div.offsetWidth / 2 - this.scroller.clientWidth / 2 : this.scroller.scrollLeft;
    if (opts.userY !== undefined) {
      const p = v.toView({ x: opts.userX ?? 0, y: opts.userY });
      top = v.div.offsetTop + p.y - 40;
      if (opts.userX !== undefined) left = v.div.offsetLeft + p.x - this.scroller.clientWidth / 2;
    }
    this.scroller.scrollTo({ top, left, behavior: opts.smooth ? 'smooth' : 'auto' });
    this.current = this.order.indexOf(v);
    this.dispatchEvent(new Event('pagechange'));
  }

  /** Scrolls so that a box (CSS px relative to the page) is visible. */
  revealBox(v: PageView, box: { left: number; top: number; width: number; height: number }): void {
    const s = this.scroller;
    const top = v.div.offsetTop + box.top;
    const left = v.div.offsetLeft + box.left;
    if (top < s.scrollTop + 40 || top + box.height > s.scrollTop + s.clientHeight - 40) {
      s.scrollTop = top - s.clientHeight / 3;
    }
    if (left < s.scrollLeft || left + box.width > s.scrollLeft + s.clientWidth) {
      s.scrollLeft = left - s.clientWidth / 3;
    }
  }

  viewOf(el: EventTarget | null): PageView | undefined {
    const div = (el as Element | null)?.closest?.('.page') as HTMLElement | null;
    return div ? this.views.get(div.dataset.id ?? '') : undefined;
  }

  viewAtPoint(clientX: number, clientY: number): PageView | undefined {
    for (const v of this.visible) {
      const r = v.div.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return v;
    }
    return undefined;
  }

  redrawOverlays(pageIds?: string[]): void {
    if (pageIds) {
      for (const id of pageIds) this.views.get(id)?.drawOverlay();
    } else {
      for (const v of this.order) v.drawOverlay();
    }
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const e of entries) {
      const v = this.views.get((e.target as HTMLElement).dataset.id ?? '');
      if (!v) continue;
      if (e.isIntersecting) this.visible.add(v);
      else {
        this.visible.delete(v);
        v.release();
      }
    }
    this.scheduleRender();
  }

  scheduleRender(delay = 0): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.pump(), delay);
  }

  private pump(): void {
    const todo = [...this.visible]
      .filter((v) => v.needsRender && !v.busy)
      .sort((a, b) => Math.abs(a.index - this.current) - Math.abs(b.index - this.current));
    while (this.rendering < 2 && todo.length) {
      const v = todo.shift()!;
      this.rendering++;
      v.render().finally(() => {
        this.rendering--;
        this.pump();
      });
    }
  }
}

function clamp(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

export { PAD as VIEWER_PAD, GAP as VIEWER_GAP };
