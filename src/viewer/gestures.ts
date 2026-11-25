// Pinch-to-zoom and two-finger pan on touch screens, double tap to zoom, swipe to
// turn pages (page-by-page mode), Ctrl+wheel zoom and drag-to-pan with the hand tool.
import type { Viewer } from './viewer';

export interface GestureOptions {
  isHandTool(): boolean;
  /** Whether one-finger taps and swipes are for the viewer (not for drawing or editing). */
  canTap(target: EventTarget | null): boolean;
  /** A single tap that was not part of a double tap. */
  onTap?(target: EventTarget | null): void;
}

export function installGestures(viewer: Viewer, opts: GestureOptions): void {
  const isHandTool = () => opts.isHandTool();
  const scroller = viewer.scroller;
  const pages = viewer.pagesEl;

  // ---- Ctrl/Cmd + wheel (and trackpad pinch, which browsers report as ctrl+wheel) ----
  let wheelAcc = 1;
  let wheelTimer = 0;
  let wheelAnchor = { x: 0, y: 0 };
  scroller.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = scroller.getBoundingClientRect();
      wheelAnchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      wheelAcc *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
      if (!wheelTimer) {
        wheelTimer = requestAnimationFrame(() => {
          wheelTimer = 0;
          const f = wheelAcc;
          wheelAcc = 1;
          viewer.zoomBy(f, wheelAnchor);
        });
      }
    },
    { passive: false },
  );

  // ---- touch pinch / two-finger pan ----
  let pinch: {
    d0: number;
    mx0: number;
    my0: number;
    sl0: number;
    st0: number;
    k: number;
    mx: number;
    my: number;
  } | null = null;

  const mid = (t: TouchList) => {
    const r = scroller.getBoundingClientRect();
    return {
      x: (t[0].clientX + t[1].clientX) / 2 - r.left,
      y: (t[0].clientY + t[1].clientY) / 2 - r.top,
      d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
    };
  };

  scroller.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const m = mid(e.touches);
        pinch = { d0: m.d || 1, mx0: m.x, my0: m.y, sl0: scroller.scrollLeft, st0: scroller.scrollTop, k: 1, mx: m.x, my: m.y };
        scroller.dispatchEvent(new CustomEvent('pinchstart'));
      }
    },
    { passive: false },
  );

  scroller.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const m = mid(e.touches);
      const k = Math.max(0.2 / viewer.scale, Math.min(8 / viewer.scale, m.d / pinch.d0));
      pinch.k = k;
      pinch.mx = m.x;
      pinch.my = m.y;
      // Preview with a CSS transform; the real re-layout happens on release.
      const ox = pinch.sl0 + pinch.mx0;
      const oy = pinch.st0 + pinch.my0;
      pages.style.transformOrigin = `${ox}px ${oy}px`;
      pages.style.transform = `translate(${m.x - pinch.mx0}px, ${m.y - pinch.my0}px) scale(${k})`;
    },
    { passive: false },
  );

  const endPinch = () => {
    if (!pinch) return;
    const p = pinch;
    pinch = null;
    pages.style.transform = '';
    pages.style.transformOrigin = '';
    // Pan by the midpoint movement first, then zoom around the new midpoint.
    scroller.scrollLeft = p.sl0 - (p.mx - p.mx0);
    scroller.scrollTop = p.st0 - (p.my - p.my0);
    if (Math.abs(p.k - 1) > 0.01) viewer.zoomTo(viewer.scale * p.k, { x: p.mx, y: p.my });
  };
  scroller.addEventListener('touchend', (e) => e.touches.length < 2 && endPinch());
  scroller.addEventListener('touchcancel', endPinch);

  // ---- one finger: double tap zooms, a sideways swipe turns the page ----
  let touch: { x: number; y: number; t: number; sl: number; multi: boolean } | null = null;
  let lastTap: { x: number; y: number; t: number } | null = null;
  let tapTimer = 0;
  scroller.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length > 1) {
        if (touch) touch.multi = true;
        clearTimeout(tapTimer);
        lastTap = null;
        return;
      }
      const t0 = e.touches[0];
      touch = { x: t0.clientX, y: t0.clientY, t: performance.now(), sl: scroller.scrollLeft, multi: false };
    },
    { passive: true },
  );
  scroller.addEventListener('touchcancel', () => (touch = null));
  scroller.addEventListener('touchend', (e) => {
    const s = touch;
    if (!s || e.touches.length) return;
    touch = null;
    if (s.multi || !opts.canTap(e.target)) {
      lastTap = null;
      return;
    }
    const t1 = e.changedTouches[0];
    const dx = t1.clientX - s.x;
    const dy = t1.clientY - s.y;
    const dt = performance.now() - s.t;
    const selecting = !!window.getSelection()?.toString();
    if (viewer.paged && !selecting && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) {
      // Only when the page is not wider than the screen in that direction (zoomed in).
      const maxLeft = scroller.scrollWidth - scroller.clientWidth;
      const atEdge = dx < 0 ? s.sl >= maxLeft - 2 : s.sl <= 2;
      if (atEdge) {
        lastTap = null;
        viewer.scrollToPage(viewer.current + (dx < 0 ? 1 : -1));
        return;
      }
    }
    if (Math.hypot(dx, dy) > 10 || dt > 350 || selecting) {
      lastTap = null;
      return;
    }
    const now = performance.now();
    if (lastTap && now - lastTap.t < 330 && Math.hypot(t1.clientX - lastTap.x, t1.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer);
      lastTap = null;
      e.preventDefault();
      doubleTap(t1.clientX, t1.clientY);
      return;
    }
    lastTap = { x: t1.clientX, y: t1.clientY, t: now };
    const target = e.target;
    clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => {
      lastTap = null;
      opts.onTap?.(target);
    }, 330);
  });

  /** Zooms in twice around the tapped point, or back to the fitted size. */
  const doubleTap = (x: number, y: number) => {
    const r = scroller.getBoundingClientRect();
    const anchor = { x: x - r.left, y: y - r.top };
    const fitMode = viewer.paged ? 'page' : 'auto';
    const fit = viewer.fitScale(fitMode);
    if (viewer.scale > fit * 1.3) viewer.setMode(fitMode);
    else viewer.zoomTo(viewer.scale * 2.2, anchor);
  };

  // ---- hand tool: drag to scroll with a mouse or pen ----
  let drag: { x: number; y: number; sl: number; st: number; id: number } | null = null;
  scroller.addEventListener('pointerdown', (e) => {
    if (!isHandTool() || e.pointerType === 'touch' || e.button !== 0) return;
    if ((e.target as Element).closest('.formLayer input, .formLayer select, .formLayer textarea, a')) return;
    drag = { x: e.clientX, y: e.clientY, sl: scroller.scrollLeft, st: scroller.scrollTop, id: e.pointerId };
    scroller.setPointerCapture(e.pointerId);
    scroller.classList.add('grabbing');
    e.preventDefault();
  });
  scroller.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    scroller.scrollLeft = drag.sl - (e.clientX - drag.x);
    scroller.scrollTop = drag.st - (e.clientY - drag.y);
  });
  const stop = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    scroller.classList.remove('grabbing');
  };
  scroller.addEventListener('pointerup', stop);
  scroller.addEventListener('pointercancel', stop);
}
