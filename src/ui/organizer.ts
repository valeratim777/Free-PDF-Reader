// Full-screen page organizer: select, reorder by dragging, rotate, delete,
// duplicate, insert blank pages or other files, extract and split.
import { zipSync } from 'fflate';
import { store } from '../store';
import { t } from '../i18n';
import { uid, type DocPage, type QuarterTurn } from '../model';
import { visualSize } from '../pages';
import { drawThumb } from './thumbs';
import { busy, dialog, downloadBlob, field, h, iconButton, pickFiles, select, toast } from './dom';
import { blankPdfBytes, fileBytes, imagesToPdfBytes, insertBytes } from '../features/documents';
import { exportPdf, suggestedName } from '../features/save';
import { Check, Copy, FileDown, FilePlus, Files, RotateCcw, RotateCw, Scissors, Trash2, X } from 'lucide';

const TILE_W = 130;

export function openOrganizer(onClose: (focusIndex: number) => void, startIndex = 0): void {
  const selected = new Set<string>();
  let anchor: string | null = null;
  const grid = h('div.org-grid');
  const count = h('span', { style: 'color:var(--muted);font-size:13px;margin:0 8px;white-space:nowrap' });
  let io: IntersectionObserver | null = null;

  const needSel = (): DocPage[] | null => {
    const pages = store.state.pages.filter((p) => selected.has(p.id));
    if (!pages.length) {
      toast(t('pagesSelectedNone'));
      return null;
    }
    return pages;
  };

  const rotate = (delta: number) => {
    const pages = needSel();
    if (!pages) return;
    store.commit('pages', (s) => {
      for (const p of s.pages) if (selected.has(p.id)) p.rot = ((((p.rot + delta) % 360) + 360) % 360) as QuarterTurn;
    });
  };

  const remove = () => {
    const pages = needSel();
    if (!pages) return;
    if (pages.length >= store.state.pages.length) {
      toast(t('pagesSelectedNone'));
      return;
    }
    const ids = new Set(pages.map((p) => p.id));
    store.commit('pages', (s) => {
      s.pages = s.pages.filter((p) => !ids.has(p.id));
      s.anns = s.anns.filter((a) => !ids.has(a.pageId));
    });
    selected.clear();
  };

  const duplicate = () => {
    const pages = needSel();
    if (!pages) return;
    store.commit('pages', (s) => {
      const out: DocPage[] = [];
      for (const p of s.pages) {
        out.push(p);
        if (selected.has(p.id)) {
          const copy = { ...p, id: uid('p') };
          out.push(copy);
          // Annotations come along with the copy.
          for (const a of s.anns.filter((x) => x.pageId === p.id)) s.anns.push({ ...structuredClone(a), id: uid('a'), pageId: copy.id });
        }
      }
      s.pages = out;
    });
  };

  const insertAt = () => {
    const idx = store.state.pages.findLastIndex((p) => selected.has(p.id));
    return idx >= 0 ? idx + 1 : store.state.pages.length;
  };

  const insertBlank = async () => {
    const size = select(
      [
        ['same', `${t('currentPage')}`],
        ['a4', 'A4'],
        ['letter', 'Letter'],
        ['a3', 'A3'],
        ['a5', 'A5'],
      ],
      'same',
    );
    const orient = select(
      [
        ['portrait', t('portrait')],
        ['landscape', t('landscape')],
      ],
      'portrait',
    );
    const ok = await dialog<boolean>({
      title: t('insertBlank'),
      body: h('div', {}, field(t('blankPageSize'), size), field(t('orientation'), orient)),
      actions: [
        { label: t('cancel'), value: false },
        { label: t('ok'), value: true, primary: true },
      ],
    });
    if (!ok) return;
    const sizes: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792], a3: [841.89, 1190.55], a5: [419.53, 595.28] };
    let [w, hh] = sizes[size.value] ?? [0, 0];
    if (size.value === 'same') {
      const ref = store.state.pages[Math.max(0, insertAt() - 1)];
      const vs = ref ? visualSize(ref) : { w: 595.28, h: 841.89 };
      [w, hh] = [vs.w, vs.h];
    } else if ((orient.value === 'landscape') !== w > hh) [w, hh] = [hh, w];
    await insertBytes(await blankPdfBytes(w, hh), 'blank.pdf', insertAt());
  };

  const insertFile = async () => {
    const files = await pickFiles('application/pdf,.pdf,image/*', true);
    if (!files.length) return;
    busy(true);
    try {
      let at = insertAt();
      const images = files.filter((f) => f.type.startsWith('image/'));
      for (const f of files.filter((f) => !f.type.startsWith('image/'))) at += await insertBytes(await fileBytes(f), f.name, at);
      if (images.length) await insertBytes(await imagesToPdfBytes(images), 'images.pdf', at);
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      busy(false);
    }
  };

  const extract = async (pagesIdx: number[], name: string) => {
    const { extractPages } = await import('../export/exporter');
    const all = await exportPdf();
    return { name, bytes: await extractPages({ bytes: all }, pagesIdx) };
  };

  const extractSelected = async () => {
    const pages = needSel();
    if (!pages) return;
    busy(true);
    try {
      const idx = store.state.pages.map((p, i) => (selected.has(p.id) ? i : -1)).filter((i) => i >= 0);
      const r = await extract(idx, suggestedName('-extract'));
      downloadBlob(new Blob([r.bytes.slice()], { type: 'application/pdf' }), r.name);
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      busy(false);
    }
  };

  const splitAll = async () => {
    busy(true);
    try {
      const { extractPages } = await import('../export/exporter');
      const all = await exportPdf();
      const base = suggestedName().replace(/\.pdf$/i, '');
      const files: Record<string, Uint8Array> = {};
      const n = store.state.pages.length;
      for (let i = 0; i < n; i++) files[`${base}-${String(i + 1).padStart(String(n).length, '0')}.pdf`] = await extractPages({ bytes: all }, [i]);
      downloadBlob(new Blob([zipSync(files).slice()], { type: 'application/zip' }), `${base}-pages.zip`);
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      busy(false);
    }
  };

  const bar = h(
    'div.org-bar',
    {},
    iconButton(X, t('close'), () => close()),
    h('span.title', {}, t('organize')),
    count,
    h('span', { style: 'flex:1' }),
    iconButton(Check, t('selectAll'), () => {
      if (selected.size === store.state.pages.length) selected.clear();
      else store.state.pages.forEach((p) => selected.add(p.id));
      render();
    }),
    iconButton(RotateCcw, t('rotateLeft'), () => rotate(-90)),
    iconButton(RotateCw, t('rotateRight'), () => rotate(90)),
    iconButton(Copy, t('duplicate'), duplicate),
    iconButton(Trash2, t('delete'), remove),
    iconButton(FilePlus, t('insertBlank'), () => void insertBlank()),
    iconButton(Files, t('insertFile'), () => void insertFile()),
    iconButton(FileDown, t('extract'), () => void extractSelected()),
    iconButton(Scissors, t('splitAll'), () => void splitAll()),
    h('button.btn.btn-primary.btn-small', { type: 'button', onclick: () => close(), style: 'margin-left:6px' }, t('done')),
  );
  const root = h('div#organizer', {}, bar, h('div.org-hint', {}, t('dragToReorder')), grid);
  document.body.append(root);

  const tiles = new Map<string, HTMLElement>();

  function render(): void {
    io?.disconnect();
    for (const id of [...selected]) if (!store.page(id)) selected.delete(id);
    count.textContent = selected.size ? t('selectedN', { n: selected.size }) : '';
    const pages = store.state.pages;
    const els = pages.map((p, i) => {
      let tile = tiles.get(p.id);
      const { w, h: hh } = visualSize(p);
      const k = Math.min(TILE_W / w, (TILE_W * 1.3) / hh);
      const rotKey = String(p.rot);
      if (!tile || tile.dataset.rot !== rotKey) {
        tile = h('div.org-tile', { 'data-id': p.id }, h('div.thumb-img'), h('div.num'), h('div.check-mark', {}, '✓'));
        tile.dataset.rot = rotKey;
        tile.dataset.drawn = '';
        tiles.set(p.id, tile);
        attachDrag(tile);
      }
      const box = tile.querySelector<HTMLElement>('.thumb-img')!;
      box.style.width = `${Math.round(w * k)}px`;
      box.style.height = `${Math.round(hh * k)}px`;
      tile.querySelector('.num')!.textContent = String(i + 1);
      tile.classList.toggle('selected', selected.has(p.id));
      return tile;
    });
    grid.replaceChildren(...els);
    io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (!e.isIntersecting || el.dataset.drawn) continue;
          const p = store.page(el.dataset.id ?? '');
          if (!p) continue;
          el.dataset.drawn = '1';
          const c = h('canvas');
          el.querySelector('.thumb-img')!.replaceChildren(c);
          const { w } = visualSize(p);
          void drawThumb(p, c, Math.min(TILE_W, w * Math.min(TILE_W / w, (TILE_W * 1.3) / visualSize(p).h)));
        }
      },
      { root: grid, rootMargin: '400px 0px' },
    );
    els.forEach((el) => io!.observe(el));
  }

  const toggleSelect = (id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; pointerType?: string }) => {
    const pages = store.state.pages;
    if (e.shiftKey && anchor) {
      const a = pages.findIndex((p) => p.id === anchor);
      const b = pages.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selected.add(pages[i].id);
    } else if (e.ctrlKey || e.metaKey || e.pointerType !== 'mouse') {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      anchor = id;
    } else {
      const only = selected.size === 1 && selected.has(id);
      selected.clear();
      if (!only) selected.add(id);
      anchor = id;
    }
    render();
  };

  // ---- drag to reorder (pointer events: works with mouse, pen and touch) ----
  function attachDrag(tile: HTMLElement): void {
    let start: { x: number; y: number; id: number } | null = null;
    let dragging = false;
    let pressTimer = 0;
    let ghost: HTMLElement | null = null;
    let marker: HTMLElement | null = null;
    let dropIndex = -1;

    const begin = () => {
      dragging = true;
      const id = tile.dataset.id!;
      if (!selected.has(id)) {
        selected.clear();
        selected.add(id);
        // Only update classes: re-inserting the tile would drop its pointer capture.
        for (const [tid, el] of tiles) el.classList.toggle('selected', selected.has(tid));
        count.textContent = t('selectedN', { n: selected.size });
      }
      ghost = tile.cloneNode(true) as HTMLElement;
      ghost.classList.add('drag-ghost');
      ghost.style.width = `${tile.offsetWidth}px`;
      document.body.append(ghost);
      for (const sid of selected) tiles.get(sid)?.classList.add('dragging');
      marker = h('div.drop-marker');
      grid.append(marker);
      navigator.vibrate?.(15);
    };

    tile.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dragging = false;
      if (e.pointerType === 'touch') {
        // Long-press starts a drag on touch screens so normal swipes still scroll.
        pressTimer = window.setTimeout(() => {
          if (!start) return;
          tile.setPointerCapture(start.id);
          tile.style.touchAction = 'none';
          begin();
          move(start.x, start.y);
        }, 350);
      }
    });

    const move = (x: number, y: number) => {
      if (!ghost || !marker) return;
      ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
      ghost.style.top = `${y - 40}px`;
      const el = document.elementFromPoint(x, y)?.closest('.org-tile') as HTMLElement | null;
      if (!el || el.classList.contains('drag-ghost')) return;
      const r = el.getBoundingClientRect();
      const after = x > r.left + r.width / 2;
      const i = store.pageIndex(el.dataset.id ?? '');
      dropIndex = i + (after ? 1 : 0);
      const g = grid.getBoundingClientRect();
      marker.style.left = `${(after ? r.right + 6 : r.left - 10) - g.left + grid.scrollLeft}px`;
      marker.style.top = `${r.top - g.top + grid.scrollTop}px`;
      marker.style.height = `${r.height}px`;
      // Auto-scroll near the edges.
      if (y < g.top + 50) grid.scrollTop -= 12;
      else if (y > g.bottom - 50) grid.scrollTop += 12;
    };

    tile.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      const d = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      if (!dragging) {
        if (e.pointerType === 'touch') {
          if (d > 10) {
            clearTimeout(pressTimer);
            start = null;
          }
          return;
        }
        if (d < 6) return;
        tile.setPointerCapture(e.pointerId);
        begin();
      }
      e.preventDefault();
      move(e.clientX, e.clientY);
    });

    const finish = (e: PointerEvent, cancelled: boolean) => {
      clearTimeout(pressTimer);
      if (!start || e.pointerId !== start.id) return;
      const wasDragging = dragging;
      start = null;
      dragging = false;
      tile.style.touchAction = '';
      ghost?.remove();
      marker?.remove();
      ghost = marker = null;
      document.querySelectorAll('.org-tile.dragging').forEach((el) => el.classList.remove('dragging'));
      if (!wasDragging) {
        if (!cancelled) toggleSelect(tile.dataset.id!, e);
        return;
      }
      if (cancelled || dropIndex < 0) return render();
      const moving = store.state.pages.filter((p) => selected.has(p.id));
      const before = store.state.pages.slice(0, dropIndex).filter((p) => !selected.has(p.id)).length;
      store.commit('pages', (s) => {
        const rest = s.pages.filter((p) => !selected.has(p.id));
        rest.splice(before, 0, ...moving);
        s.pages = rest;
      });
      dropIndex = -1;
    };
    tile.addEventListener('pointerup', (e) => finish(e, false));
    tile.addEventListener('pointercancel', (e) => finish(e, true));
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
    // Once a long-press drag started, keep the browser from scrolling instead.
    tile.addEventListener(
      'touchmove',
      (e) => {
        if (dragging) e.preventDefault();
      },
      { passive: false },
    );
  }

  const onChange = () => {
    if (root.isConnected) render();
  };
  store.addEventListener('change', onChange);

  const onKey = (e: KeyboardEvent) => {
    if (document.querySelector('.modal-backdrop')) return;
    if (e.key === 'Escape') close();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement)) remove();
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      store.state.pages.forEach((p) => selected.add(p.id));
      render();
    } else return;
    e.stopPropagation();
  };
  document.addEventListener('keydown', onKey, true);

  function close(): void {
    document.querySelectorAll('.drag-ghost').forEach((g) => g.remove());
    store.removeEventListener('change', onChange);
    document.removeEventListener('keydown', onKey, true);
    io?.disconnect();
    root.remove();
    const firstSel = store.state.pages.findIndex((p) => selected.has(p.id));
    onClose(firstSel >= 0 ? firstSel : startIndex);
  }

  render();
  const cur = store.state.pages[startIndex];
  if (cur) tiles.get(cur.id)?.scrollIntoView({ block: 'center' });
}
