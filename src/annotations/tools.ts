import { store } from '../store';
import { t } from '../i18n';
import { uid, type Annotation, type AnnType, type FontKey, type LineAnn, type MarkupAnn, type NoteAnn, type Pt, type Rect, type TextAnn } from '../model';
import {
  annBBox,
  boxFrame,
  hitAnn,
  inflate,
  normRect,
  normTurn,
  rectFromFrame,
  rectH,
  rectW,
  scaleAnn,
  simplify,
  textBlockSize,
  translateAnn,
} from '../geometry';
import { cssFont, ensureCssFont, measureLines } from '../fonts';
import { stampBox } from '../decor';
import { renderAnn } from './render';
import type { Viewer } from '../viewer/viewer';
import type { PageView } from '../viewer/pageView';
import { h, toast } from '../ui/dom';
import { rawTextContent } from '../text';

export type Tool =
  | 'select'
  | 'hand'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'pen'
  | 'marker'
  | 'text'
  | 'edittext'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'note'
  | 'image'
  | 'signature'
  | 'stamp'
  | 'whiteout'
  | 'redact'
  | 'eraser';

/** Tools that draw on the page and therefore capture pointer input. */
export const CAPTURE_TOOLS = new Set<Tool>(['pen', 'marker', 'text', 'rect', 'ellipse', 'line', 'arrow', 'note', 'whiteout', 'redact', 'eraser']);
/** Tools that work with the PDF's own text. */
export const TEXT_TOOLS = new Set<Tool>(['select', 'highlight', 'underline', 'strike', 'edittext']);

export interface ToolSettings {
  color: string;
  opacity: number;
  width: number;
  fill: string | null;
  font: FontKey;
  size: number;
  bold: boolean;
}

const BASE: ToolSettings = { color: '#dc2626', opacity: 1, width: 2, fill: null, font: 'sans', size: 14, bold: false };

const DEFAULTS: Partial<Record<Tool, Partial<ToolSettings>>> = {
  highlight: { color: '#facc15', opacity: 0.45 },
  underline: { color: '#16a34a' },
  strike: { color: '#dc2626' },
  pen: { color: '#1d4ed8', width: 2 },
  marker: { color: '#facc15', opacity: 0.4, width: 14 },
  text: { color: '#111827', size: 14 },
  rect: { color: '#dc2626', width: 2 },
  ellipse: { color: '#dc2626', width: 2 },
  line: { color: '#dc2626', width: 2 },
  arrow: { color: '#dc2626', width: 2 },
  note: { color: '#fde047' },
  stamp: { color: '#dc2626', size: 18 },
  whiteout: { color: '#ffffff' },
  redact: { color: '#000000' },
  image: {},
  signature: {},
};

const TYPE_TOOL: Record<AnnType, Tool> = {
  ink: 'pen',
  marker: 'marker',
  rect: 'rect',
  ellipse: 'ellipse',
  line: 'line',
  arrow: 'arrow',
  highlight: 'highlight',
  underline: 'underline',
  strike: 'strike',
  text: 'text',
  note: 'note',
  image: 'image',
  signature: 'signature',
  stamp: 'stamp',
  whiteout: 'whiteout',
  redact: 'redact',
};

export function toolOfType(type: AnnType): Tool {
  return TYPE_TOOL[type];
}

type Gesture =
  | { kind: 'draw'; pv: PageView; tool: Tool; pts: Pt[]; id: number; preview: SVGElement | null }
  | { kind: 'move'; pv: PageView; orig: Annotation; start: Pt; id: number; moved: boolean; wasSelected: boolean }
  | { kind: 'resize'; pv: PageView; orig: Annotation; fixed: Pt; keepAspect: boolean; id: number }
  | { kind: 'endpoint'; pv: PageView; orig: LineAnn; which: 'p1' | 'p2'; id: number }
  | { kind: 'erase'; pv: PageView; id: number };

function loadSettings(): Record<string, ToolSettings> {
  const out: Record<string, ToolSettings> = {};
  let saved: Record<string, Partial<ToolSettings>> = {};
  try {
    saved = JSON.parse(localStorage.getItem('pr.tools') || '{}');
  } catch {
    /* ignore */
  }
  for (const k of Object.keys(DEFAULTS)) out[k] = { ...BASE, ...DEFAULTS[k as Tool], ...(saved[k] ?? {}) };
  return out;
}

export function authorName(): string {
  try {
    return localStorage.getItem('pr.author') || '';
  } catch {
    return '';
  }
}

/** Measures a text annotation and returns it with an updated rect (origin kept). */
export function relayoutText(a: TextAnn): TextAnn {
  const f = boxFrame(a.rect, a.rot);
  const { w, h: hh } = textBlockSize(measureLines(a.text || ' ', a.font, a.bold, a.size), a.size, a.pad);
  return { ...a, rect: rectFromFrame(f.ox, f.oy, w, hh, a.rot) };
}

export function stampRect(label: string, size: number, ox: number, oy: number, rot: TextAnn['rot']): Rect {
  const [tw] = measureLines(label, 'sans', true, size);
  const b = stampBox(tw, size);
  return rectFromFrame(ox, oy, b.w, b.h, rot);
}

/** Owns the active tool, the selection, and all pointer interaction on pages. */
export class Tools extends EventTarget {
  tool: Tool = 'select';
  settings = loadSettings();
  selected: string | null = null;
  private gesture: Gesture | null = null;
  private editor: { finish(commit: boolean): void; layout(): void; pv: PageView } | null = null;
  private placing: ((pv: PageView, at: Pt) => void) | null = null;
  private selPopup: HTMLElement | null = null;
  private selTimer = 0;

  constructor(private viewer: Viewer) {
    super();
    const pages = viewer.pagesEl;
    pages.addEventListener('pointerdown', (e) => this.onDown(e));
    pages.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', (e) => this.onCancel(e));
    document.addEventListener('selectionchange', () => this.onSelectionChange());
    viewer.addEventListener('zoom', () => {
      this.editor?.layout();
      this.refreshSelection();
      this.hideSelPopup();
    });
    viewer.scroller.addEventListener('pinchstart', () => this.cancelGesture());
  }

  // ---- tool & settings ----

  setTool(tool: Tool): void {
    this.finishEditing();
    this.placing = null;
    document.body.classList.remove('placing');
    if (tool !== 'select') this.select(null);
    this.tool = tool;
    document.body.dataset.tool = tool;
    if (tool === 'text') void ensureCssFont('sans', false);
    if (tool === 'edittext') toast(t('editTextHint'));
    if (tool === 'redact') toast(t('redactHint'), 'info', 5000);
    if (['highlight', 'underline', 'strike'].includes(tool)) {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this.selectionInPages(sel)) this.markupFromSelection(tool as MarkupAnn['type']);
    }
    this.dispatchEvent(new Event('change'));
  }

  /** Which settings the properties bar should show: the selection's, otherwise the tool's. */
  activeKey(): Tool | null {
    const a = this.selected ? store.ann(this.selected) : null;
    if (a) return toolOfType(a.type);
    return this.settings[this.tool] ? this.tool : null;
  }

  current(): ToolSettings | null {
    const k = this.activeKey();
    return k ? this.settings[k] : null;
  }

  applySetting<K extends keyof ToolSettings>(key: K, value: ToolSettings[K]): void {
    const k = this.activeKey();
    if (!k) return;
    this.settings[k][key] = value;
    try {
      localStorage.setItem('pr.tools', JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
    const a = this.selected ? store.ann(this.selected) : null;
    if (a) {
      const c = structuredClone(a) as Annotation;
      if (key === 'color') c.color = value as string;
      if (key === 'opacity') c.opacity = value as number;
      if (key === 'width' && 'width' in c) c.width = value as number;
      if (key === 'fill' && (c.type === 'rect' || c.type === 'ellipse')) c.fill = value as string | null;
      if (c.type === 'text' && (key === 'font' || key === 'size' || key === 'bold')) {
        (c as unknown as Record<string, unknown>)[key] = value;
        void ensureCssFont(c.font, c.bold).then(() => {
          const cur = store.ann(c.id);
          if (cur && cur.type === 'text') store.replaceAnn(relayoutText({ ...cur, [key]: value }));
        });
        return;
      }
      if (c.type === 'stamp' && key === 'size') {
        const f = boxFrame(c.rect, c.rot);
        c.size = value as number;
        c.rect = stampRect(c.label, c.size, f.ox, f.oy, c.rot);
      }
      store.replaceAnn(c);
    }
    this.dispatchEvent(new Event('change'));
  }

  // ---- selection ----

  select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.refreshSelection();
    this.dispatchEvent(new Event('change'));
  }

  deleteSelected(): void {
    if (!this.selected) return;
    const id = this.selected;
    this.select(null);
    store.removeAnns([id]);
  }

  duplicateSelected(): void {
    const a = this.selected ? store.ann(this.selected) : null;
    if (!a) return;
    const c = translateAnn({ ...structuredClone(a), id: uid('a'), created: Date.now() }, 12, -12);
    store.addAnn(c);
    this.select(c.id);
  }

  /** Moves the selection by (dx, dy) screen points. */
  nudge(dx: number, dy: number): void {
    const a = this.selected ? store.ann(this.selected) : null;
    const pv = a ? this.viewer.views.get(a.pageId) : null;
    if (!a || !pv) return;
    const r = pv.div.getBoundingClientRect();
    const s = this.viewer.scale;
    const u1 = pv.toUser(r.left, r.top);
    const u2 = pv.toUser(r.left + dx * s, r.top + dy * s);
    store.replaceAnn(translateAnn(a, u2.x - u1.x, u2.y - u1.y));
  }

  refreshSelection(): void {
    for (const v of this.viewer.order) v.uiDiv.querySelectorAll('.sel-box, .sel-handle').forEach((n) => n.remove());
    const a = this.selected ? store.ann(this.selected) : null;
    if (!a) {
      if (this.selected) {
        this.selected = null;
        this.dispatchEvent(new Event('change'));
      }
      return;
    }
    const pv = this.viewer.views.get(a.pageId);
    if (!pv) return;
    const box = pv.rectToView(annBBox(a));
    const pad = 4;
    const el = h('div.sel-box', {
      style: `left:${box.left - pad}px;top:${box.top - pad}px;width:${box.width + pad * 2}px;height:${box.height + pad * 2}px`,
    });
    el.addEventListener('pointerdown', (e) => this.startMove(e, pv, a));
    pv.uiDiv.append(el);
    if (a.type === 'line' || a.type === 'arrow') {
      for (const which of ['p1', 'p2'] as const) {
        const p = pv.toView(a[which]);
        const hd = h('div.sel-handle', { style: `left:${p.x}px;top:${p.y}px` });
        hd.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.gesture = { kind: 'endpoint', pv, orig: structuredClone(a), which, id: e.pointerId };
          store.beginTransient();
        });
        pv.uiDiv.append(hd);
      }
      return;
    }
    if (a.type === 'note' || a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') return;
    const bb = annBBox(a);
    const corners: Pt[] = [
      { x: bb.x1, y: bb.y1 },
      { x: bb.x2, y: bb.y1 },
      { x: bb.x2, y: bb.y2 },
      { x: bb.x1, y: bb.y2 },
    ];
    corners.forEach((c, i) => {
      const p = pv.toView(c);
      const hd = h('div.sel-handle', { style: `left:${p.x}px;top:${p.y}px` });
      hd.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const keepAspect = ['image', 'signature', 'text', 'stamp'].includes(a.type);
        this.gesture = { kind: 'resize', pv, orig: structuredClone(a), fixed: corners[(i + 2) % 4], keepAspect, id: e.pointerId };
        store.beginTransient();
      });
      pv.uiDiv.append(hd);
    });
  }

  // ---- pointer handling ----

  /** Arms one-shot placement: the next tap on a page calls `fn` with that point. */
  placeNext(fn: (pv: PageView, at: Pt) => void): void {
    this.placing = fn;
    document.body.classList.add('placing');
    toast(t('placeHint'));
  }

  private tol(pv: PageView): number {
    return 8 / pv.scale;
  }

  private hitTest(pv: PageView, p: Pt): Annotation | null {
    const anns = store.annsOf(pv.page.id);
    for (let i = anns.length - 1; i >= 0; i--) if (hitAnn(anns[i], p, this.tol(pv))) return anns[i];
    return null;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const target = e.target as HTMLElement;
    if (target.closest('.sel-box, .sel-handle, .text-editor, .note-editor')) return;
    const pv = this.viewer.viewOf(target);
    if (!pv) return;
    const p = pv.toUser(e.clientX, e.clientY);

    if (this.placing) {
      e.preventDefault();
      const fn = this.placing;
      this.placing = null;
      document.body.classList.remove('placing');
      fn(pv, p);
      return;
    }
    if (target.closest('.formLayer .form-field, .formLayer a')) return;
    this.finishEditing();

    switch (this.tool) {
      case 'select': {
        const hit = this.hitTest(pv, p);
        if (hit) {
          const was = this.selected === hit.id;
          this.select(hit.id);
          if (e.pointerType === 'mouse' || e.pointerType === 'pen') this.startMove(e, pv, hit, was);
          else if (was && (hit.type === 'text' || hit.type === 'note')) this.edit(hit);
        } else this.select(null);
        return;
      }
      case 'highlight':
      case 'underline':
      case 'strike':
        // Over real text the browser selects it; elsewhere (scans) draw a box instead.
        if (target.closest('.textLayer span') && target.textContent) return;
        if (this.tool !== 'highlight') return;
        e.preventDefault();
        this.startDraw(e, pv, p);
        return;
      case 'edittext': {
        const span = target.closest('.textLayer span') as HTMLElement | null;
        if (span && span.textContent?.trim()) {
          e.preventDefault();
          void this.editPdfText(pv, span);
        }
        return;
      }
      case 'text': {
        e.preventDefault();
        const hit = this.hitTest(pv, p);
        if (hit && hit.type === 'text') this.edit(hit);
        else this.newText(pv, p);
        return;
      }
      case 'note': {
        e.preventDefault();
        const hit = this.hitTest(pv, p);
        if (hit && hit.type === 'note') this.edit(hit);
        else this.newNote(pv, p);
        return;
      }
      case 'eraser':
        e.preventDefault();
        this.gesture = { kind: 'erase', pv, id: e.pointerId };
        store.beginTransient();
        this.eraseAt(pv, p);
        return;
      default:
        if (CAPTURE_TOOLS.has(this.tool)) {
          e.preventDefault();
          this.startDraw(e, pv, p);
        }
    }
  }

  private startDraw(e: PointerEvent, pv: PageView, p: Pt): void {
    this.gesture = { kind: 'draw', pv, tool: this.tool, pts: [p], id: e.pointerId, preview: null };
    this.updatePreview();
  }

  private startMove(e: PointerEvent, pv: PageView, a: Annotation, wasSelected = true): void {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();
    this.gesture = { kind: 'move', pv, orig: structuredClone(a), start: pv.toUser(e.clientX, e.clientY), id: e.pointerId, moved: false, wasSelected };
    store.beginTransient();
  }

  private onMove(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.id) return;
    const events = (e.getCoalescedEvents?.() ?? []).length ? e.getCoalescedEvents() : [e];
    const p = g.pv.toUser(e.clientX, e.clientY);
    switch (g.kind) {
      case 'draw':
        if (g.tool === 'pen' || g.tool === 'marker') {
          for (const ce of events) g.pts.push(g.pv.toUser(ce.clientX, ce.clientY));
        } else g.pts[1] = p;
        this.updatePreview();
        break;
      case 'move': {
        const dx = p.x - g.start.x;
        const dy = p.y - g.start.y;
        if (!g.moved && Math.hypot(dx, dy) * g.pv.scale < 3) return;
        g.moved = true;
        store.replaceAnn(translateAnn(g.orig, dx, dy), true);
        this.refreshSelection();
        break;
      }
      case 'resize': {
        let to = normRect(g.fixed.x, g.fixed.y, p.x, p.y);
        const from = annBBox(g.orig);
        if (g.keepAspect) {
          const k = Math.max(rectW(to) / (rectW(from) || 1), rectH(to) / (rectH(from) || 1), 0.05);
          const w = rectW(from) * k;
          const hh = rectH(from) * k;
          const x1 = p.x < g.fixed.x ? g.fixed.x - w : g.fixed.x;
          const y1 = p.y < g.fixed.y ? g.fixed.y - hh : g.fixed.y;
          to = { x1, y1, x2: x1 + w, y2: y1 + hh };
        }
        if (rectW(to) < 2 || rectH(to) < 2) return;
        let next = scaleAnn(g.orig, from, to);
        if (next.type === 'text') next = relayoutText(next);
        store.replaceAnn(next, true);
        this.refreshSelection();
        break;
      }
      case 'endpoint':
        store.replaceAnn({ ...g.orig, [g.which]: p }, true);
        this.refreshSelection();
        break;
      case 'erase':
        for (const ce of events) this.eraseAt(g.pv, g.pv.toUser(ce.clientX, ce.clientY));
        break;
    }
  }

  private onUp(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || e.pointerId !== g.id) {
      if (['highlight', 'underline', 'strike'].includes(this.tool) && e.pointerType !== 'touch') {
        setTimeout(() => {
          const sel = window.getSelection();
          if (sel && !sel.isCollapsed && this.selectionInPages(sel)) this.markupFromSelection(this.tool as MarkupAnn['type']);
        });
      }
      return;
    }
    this.gesture = null;
    switch (g.kind) {
      case 'draw':
        g.preview?.remove();
        this.finishDraw(g);
        break;
      case 'move':
        store.endTransient();
        if (!g.moved && g.wasSelected && (g.orig.type === 'text' || g.orig.type === 'note')) {
          const a = store.ann(g.orig.id);
          if (a) this.edit(a);
        }
        break;
      default:
        store.endTransient();
    }
    this.refreshSelection();
  }

  private onCancel(e: PointerEvent): void {
    if (this.gesture && e.pointerId === this.gesture.id) this.cancelGesture();
  }

  private cancelGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.kind === 'draw') g.preview?.remove();
    else store.endTransient();
    this.refreshSelection();
  }

  private onDblClick(e: MouseEvent): void {
    if (this.tool !== 'select') return;
    const pv = this.viewer.viewOf(e.target);
    if (!pv) return;
    const hit = this.hitTest(pv, pv.toUser(e.clientX, e.clientY));
    if (hit && (hit.type === 'text' || hit.type === 'note')) {
      e.preventDefault();
      this.edit(hit);
    }
  }

  private base(tool: Tool, pv: PageView) {
    const s = this.settings[tool];
    return { id: uid('a'), pageId: pv.page.id, color: s.color, opacity: s.opacity, created: Date.now(), author: authorName() || undefined };
  }

  private draft(g: Extract<Gesture, { kind: 'draw' }>): Annotation | null {
    const s = this.settings[g.tool] ?? BASE;
    const b = this.base(g.tool, g.pv);
    const p1 = g.pts[0];
    const p2 = g.pts[g.pts.length - 1];
    const rect = normRect(p1.x, p1.y, p2.x, p2.y);
    switch (g.tool) {
      case 'pen':
        return { ...b, type: 'ink', strokes: [g.pts], width: s.width };
      case 'marker':
        return { ...b, type: 'marker', strokes: [g.pts], width: s.width };
      case 'rect':
      case 'ellipse':
        return { ...b, type: g.tool, rect, width: s.width, fill: s.fill };
      case 'line':
      case 'arrow':
        return { ...b, type: g.tool, p1, p2, width: s.width };
      case 'whiteout':
        return { ...b, type: 'whiteout', rect, opacity: 1 };
      case 'redact':
        return { ...b, type: 'redact', rect, color: '#000000', opacity: 1 };
      case 'highlight':
        return { ...b, type: 'highlight', rects: [rect], rot: normTurn(g.pv.rotation) };
      default:
        return null;
    }
  }

  private updatePreview(): void {
    const g = this.gesture;
    if (!g || g.kind !== 'draw') return;
    const d = this.draft(g);
    g.preview?.remove();
    g.preview = null;
    if (!d || g.pts.length < 2) return;
    g.preview = renderAnn(d, store.assets);
    g.preview.classList.add('preview');
    g.pv.annG.appendChild(g.preview);
  }

  private finishDraw(g: Extract<Gesture, { kind: 'draw' }>): void {
    if (g.pts.length < 2) return;
    if (g.tool === 'pen' || g.tool === 'marker') g.pts = simplify(g.pts, 0.6 / g.pv.scale);
    const d = this.draft(g);
    if (!d) return;
    const bb = annBBox(d);
    const minSize = 3 / g.pv.scale;
    if (d.type === 'line' || d.type === 'arrow') {
      if (Math.hypot(d.p2.x - d.p1.x, d.p2.y - d.p1.y) < minSize * 2) return;
    } else if (d.type !== 'ink' && d.type !== 'marker' && (rectW(bb) < minSize || rectH(bb) < minSize)) return;
    store.addAnn(d);
  }

  private eraseAt(pv: PageView, p: Pt): void {
    const hit = this.hitTest(pv, p);
    if (hit) store.updateTransient('anns', (s) => (s.anns = s.anns.filter((a) => a.id !== hit.id)), [pv.page.id]);
  }

  // ---- text markup from a text selection ----

  private selectionInPages(sel: Selection): boolean {
    const n = sel.anchorNode;
    return !!n && this.viewer.pagesEl.contains(n) && !!(n.parentElement?.closest('.textLayer') || (n as Element).closest?.('.textLayer'));
  }

  /** Creates markups for the current text selection (one per page). Returns true if anything was created. */
  markupFromSelection(type: MarkupAnn['type']): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const range = sel.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) return false;
    const heights = rects.map((r) => r.height).sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const byPage = new Map<PageView, DOMRect[]>();
    for (const r of rects) {
      if (r.height > median * 2.5) continue;
      const pv = this.viewer.viewAtPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!pv) continue;
      if (!byPage.has(pv)) byPage.set(pv, []);
      byPage.get(pv)!.push(r);
    }
    const text = sel.toString();
    const created: Annotation[] = [];
    for (const [pv, list] of byPage) {
      const merged = mergeLineRects(list);
      const s = this.settings[type];
      created.push({
        ...this.base(type, pv),
        color: s.color,
        opacity: s.opacity,
        type,
        rects: merged.map((r) => pv.clientRectToUser(r)),
        rot: normTurn(pv.rotation),
        text,
      });
    }
    if (!created.length) return false;
    store.commit('anns', (st) => st.anns.push(...created), created.map((a) => a.pageId));
    sel.removeAllRanges();
    this.hideSelPopup();
    return true;
  }

  private onSelectionChange(): void {
    clearTimeout(this.selTimer);
    this.selTimer = window.setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !this.selectionInPages(sel) || !sel.toString().trim()) {
        this.hideSelPopup();
        return;
      }
      this.showSelPopup(sel);
    }, 250);
  }

  private hideSelPopup(): void {
    this.selPopup?.remove();
    this.selPopup = null;
  }

  private showSelPopup(sel: Selection): void {
    this.hideSelPopup();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const btn = (label: string, fn: () => void) =>
      h('button', { type: 'button', onpointerdown: (e: Event) => e.preventDefault(), onclick: fn }, label);
    const pop = h(
      'div.sel-popup',
      {},
      btn(t('copyText'), () => {
        void navigator.clipboard?.writeText(sel.toString()).then(() => toast(t('copied')));
        this.hideSelPopup();
      }),
      btn(t('highlightSelection'), () => this.markupFromSelection('highlight')),
      btn(t('underlineSelection'), () => this.markupFromSelection('underline')),
      btn(t('strikeSelection'), () => this.markupFromSelection('strike')),
    );
    document.body.append(pop);
    const top = r.top - pop.offsetHeight - 10 > 60 ? r.top - pop.offsetHeight - 10 : r.bottom + 34;
    pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 8, top)}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left + r.width / 2 - pop.offsetWidth / 2))}px`;
    this.selPopup = pop;
  }

  // ---- text boxes ----

  private newText(pv: PageView, p: Pt): void {
    const s = this.settings.text;
    const rot = normTurn(pv.rotation);
    const pad = Math.max(1, s.size * 0.15);
    // Put the click point at the left end of the first line's middle.
    const { cos, sin } = boxFrame({ x1: 0, y1: 0, x2: 1, y2: 1 }, rot);
    const down = pad + s.size * 0.6;
    const ox = p.x - pad * cos - down * sin;
    const oy = p.y - pad * sin + down * cos;
    const draft: TextAnn = relayoutText({
      ...this.base('text', pv),
      type: 'text',
      rect: rectFromFrame(ox, oy, 10, 10, rot),
      rot,
      text: '',
      font: s.font,
      bold: s.bold,
      size: s.size,
      bg: null,
      pad,
    });
    this.openTextEditor(pv, draft, true);
  }

  /** Replaces a run of the PDF's own text: covers it and puts an editable copy on top. */
  private async editPdfText(pv: PageView, span: HTMLElement): Promise<void> {
    const r = pv.clientRectToUser(span.getBoundingClientRect());
    const fontH = parseFloat(span.style.getPropertyValue('--font-height')) || rectH(r) * 0.85;
    const rot = normTurn(pv.rotation);
    // Match the original look: colors and stroke weight from the rendered page, family from pdf.js.
    const colors = pv.sampleColors(r, fontH) ?? { bg: '#ffffff', fg: '#000000', stem: 0 };
    const bold = colors.stem > 0.13;
    const family = await pdfFontFamily(pv, span);
    const font: FontKey = /mono|courier|consol/.test(family) ? 'mono' : /serif|times|georgia|roman|garamond/.test(family) && !/sans/.test(family) ? 'serif' : 'sans';
    const size = Math.max(4, Math.min(fontH, (rot % 180 === 0 ? rectH(r) : rectW(r)) * 1.05));
    const f = boxFrame(r, rot);
    const draft: TextAnn = relayoutText({
      ...this.base('text', pv),
      color: colors.fg,
      opacity: 1,
      type: 'text',
      rect: rectFromFrame(f.ox, f.oy, 10, 10, rot),
      rot,
      text: span.textContent ?? '',
      font,
      bold,
      size,
      bg: null,
      pad: 0,
    });
    const cover: Annotation = {
      ...this.base('whiteout', pv),
      type: 'whiteout',
      color: colors.bg,
      opacity: 1,
      rect: inflate(r, 0.6),
    };
    await ensureCssFont(font, bold);
    this.openTextEditor(pv, relayoutText(draft), true, [cover]);
  }

  edit(a: Annotation): void {
    const pv = this.viewer.views.get(a.pageId);
    if (!pv) return;
    if (a.type === 'text') this.openTextEditor(pv, a, false);
    else if (a.type === 'note') this.openNoteEditor(pv, a, false);
  }

  finishEditing(): void {
    this.editor?.finish(true);
  }

  private openTextEditor(pv: PageView, draft: TextAnn, isNew: boolean, extra: Annotation[] = []): void {
    this.finishEditing();
    this.select(null);
    const original = draft.text;
    let cur = draft;
    const ta = h('textarea.text-editor', { spellcheck: false, autocapitalize: 'off', placeholder: t('textHint') });
    ta.value = draft.text;
    pv.hiddenAnn = isNew ? null : draft.id;
    pv.drawOverlay();
    // Cover the original PDF text while it is being edited.
    const coverPreview = extra.map((c) => {
      const el = renderAnn(c, store.assets);
      pv.annG.appendChild(el);
      return el;
    });
    const layout = () => {
      const f = boxFrame(cur.rect, cur.rot);
      const o = pv.toView({ x: f.ox, y: f.oy });
      const u = pv.toView({ x: f.ox + f.cos, y: f.oy + f.sin });
      const ang = (Math.atan2(u.y - o.y, u.x - o.x) * 180) / Math.PI;
      const s = pv.scale;
      Object.assign(ta.style, {
        left: `${o.x}px`,
        top: `${o.y}px`,
        width: `${Math.max(f.w * s, cur.size * s) + 2}px`,
        height: `${f.h * s + 2}px`,
        transform: `rotate(${ang}deg)`,
        font: `${cur.bold ? 'bold ' : ''}${cur.size * s}px/1.2 ${cssFont(cur.font)}`,
        padding: `${cur.pad * s}px`,
        color: cur.color,
        background: cur.bg ?? 'transparent',
      });
    };
    const onInput = () => {
      cur = relayoutText({ ...cur, text: ta.value });
      layout();
    };
    ta.addEventListener('input', onInput);
    void ensureCssFont(cur.font, cur.bold).then(() => {
      if (this.editor === editor) onInput();
    });
    const finish = (commit: boolean) => {
      if (this.editor !== editor) return;
      this.editor = null;
      ta.remove();
      coverPreview.forEach((el) => el.remove());
      pv.hiddenAnn = null;
      const text = ta.value.replace(/\s+$/, '');
      if (!commit) {
        pv.drawOverlay();
        return;
      }
      if (isNew) {
        if (text && (text !== original || !extra.length)) {
          const a = relayoutText({ ...cur, text });
          store.commit('anns', (s) => s.anns.push(...extra, a), [pv.page.id]);
          if (!extra.length) this.select(a.id);
        } else pv.drawOverlay();
      } else if (!text) {
        store.removeAnns([cur.id]);
      } else if (text !== original) {
        store.replaceAnn(relayoutText({ ...cur, text }));
        this.select(cur.id);
      } else {
        pv.drawOverlay();
        this.select(cur.id);
      }
    };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        finish(true);
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => finish(true), 0));
    const editor = { finish, layout, pv };
    this.editor = editor;
    pv.uiDiv.append(ta);
    layout();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  // ---- sticky notes ----

  private newNote(pv: PageView, p: Pt): void {
    const note: NoteAnn = { ...this.base('note', pv), type: 'note', at: { x: p.x - 4, y: p.y + 4 }, text: '' };
    this.openNoteEditor(pv, note, true);
  }

  private openNoteEditor(pv: PageView, note: NoteAnn, isNew: boolean): void {
    this.finishEditing();
    this.select(null);
    const ta = h('textarea', { placeholder: t('noteHint'), rows: 5 });
    ta.value = note.text;
    const meta = h('div.note-meta', {}, note.author || authorName() || '', ' · ', new Date(note.created).toLocaleString());
    const keepFocus = (e: Event) => e.preventDefault();
    const del = h('button.btn.btn-small', { type: 'button', onpointerdown: keepFocus }, t('delete'));
    const ok = h('button.btn.btn-small.btn-primary', { type: 'button', onpointerdown: keepFocus }, t('ok'));
    const card = h('div.note-editor', {}, meta, ta, h('div.note-actions', {}, del, ok));
    const layout = () => {
      const pt = pv.toView(note.at);
      const w = 240;
      let left = pt.x + 26;
      if (left + w > pv.viewport.width) left = Math.max(0, pt.x - w - 6);
      card.style.left = `${left}px`;
      card.style.top = `${Math.max(0, pt.y)}px`;
    };
    if (!isNew) {
      pv.hiddenAnn = null;
    } else {
      // Show the icon while the first comment is typed.
      const el = renderAnn(note, store.assets);
      pv.annG.appendChild(el);
      card.addEventListener('remove-preview', () => el.remove());
    }
    const finish = (commit: boolean, remove = false) => {
      if (this.editor !== editor) return;
      this.editor = null;
      card.dispatchEvent(new Event('remove-preview'));
      card.remove();
      const text = ta.value.trim();
      if (remove) {
        if (!isNew) store.removeAnns([note.id]);
        return;
      }
      if (!commit) return;
      if (isNew) {
        if (text) store.addAnn({ ...note, text });
      } else if (text !== note.text) {
        store.replaceAnn({ ...note, text });
      }
    };
    del.addEventListener('click', () => finish(true, true));
    ok.addEventListener('click', () => finish(true));
    card.addEventListener('focusout', (e) => {
      if (!card.contains(e.relatedTarget as Node)) setTimeout(() => finish(true), 0);
    });
    card.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish(true);
    });
    card.addEventListener('pointerdown', (e) => e.stopPropagation());
    const editor = { finish: (c: boolean) => finish(c), layout, pv };
    this.editor = editor;
    pv.uiDiv.append(card);
    layout();
    ta.focus();
  }

  isEditing(): boolean {
    return !!this.editor;
  }
}

/** Generic family of a text-layer span as reported by pdf.js ("serif", "monospace"…). */
async function pdfFontFamily(pv: PageView, span: HTMLElement): Promise<string> {
  let family = (span.style.fontFamily || '').toLowerCase();
  try {
    const i = pv.textDivs.indexOf(span);
    const raw = (await rawTextContent(pv.page)) as { items: { fontName?: string }[]; styles?: Record<string, { fontFamily?: string }> };
    const fontName = raw.items[i]?.fontName;
    if (fontName) family += ` ${(raw.styles?.[fontName]?.fontFamily ?? '').toLowerCase()}`;
  } catch {
    /* keep the span's own family */
  }
  return family;
}

/** Merges per-glyph/per-span rectangles of a text selection into one box per line. */
export function mergeLineRects(list: DOMRect[]): DOMRect[] {
  const sorted = [...list].sort((a, b) => a.top - b.top || a.left - b.left);
  const out: DOMRect[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top);
      const sameLine = overlap > Math.min(last.height, r.height) * 0.5;
      const gap = r.left - last.right;
      if (sameLine && gap < Math.max(last.height, r.height) * 1.5 && r.right > last.left - 2) {
        const left = Math.min(last.left, r.left);
        const top = Math.min(last.top, r.top);
        out[out.length - 1] = new DOMRect(left, top, Math.max(last.right, r.right) - left, Math.max(last.bottom, r.bottom) - top);
        continue;
      }
    }
    out.push(r);
  }
  return out;
}
