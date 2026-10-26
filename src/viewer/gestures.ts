// Pinch-to-zoom and two-finger pan on touch screens, Ctrl+wheel zoom and
// drag-to-pan with the hand tool on desktop.
import type { Viewer } from './viewer';

export function installGestures(viewer: Viewer, isHandTool: () => boolean): void {
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
