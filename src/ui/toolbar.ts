import type { IconNode } from 'lucide';
import {
  ArrowUpRight,
  Brush,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  Eraser,
  EyeOff,
  FolderOpen,
  Hand,
  Highlighter,
  ImagePlus,
  LayoutGrid,
  Minus,
  MousePointer2,
  PanelLeft,
  PenLine,
  Printer,
  RectangleHorizontal,
  Redo2,
  Save,
  Search,
  Signature,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Trash2,
  Type,
  Underline,
  Undo2,
  EllipsisVertical,
  ZoomIn,
  ZoomOut,
  SquarePen,
} from 'lucide';
import { t, type Key } from '../i18n';
import { store } from '../store';
import type { Tool, Tools } from '../annotations/tools';
import type { Viewer } from '../viewer/viewer';
import { h, iconButton } from './dom';
import type { FontKey } from '../model';

export interface ToolbarActions {
  open(): void;
  save(): void;
  print(): void;
  more(anchor: HTMLElement): void;
  search(): void;
  toggleSidebar(): void;
  organize(): void;
  chooseTool(tool: Tool): void;
}

export const TOOL_DEFS: { tool: Tool; icon: IconNode; label: Key; group: number }[] = [
  { tool: 'select', icon: MousePointer2, label: 'toolSelect', group: 0 },
  { tool: 'hand', icon: Hand, label: 'toolHand', group: 0 },
  { tool: 'highlight', icon: Highlighter, label: 'toolHighlight', group: 1 },
  { tool: 'underline', icon: Underline, label: 'toolUnderline', group: 1 },
  { tool: 'strike', icon: Strikethrough, label: 'toolStrike', group: 1 },
  { tool: 'text', icon: Type, label: 'toolText', group: 2 },
  { tool: 'edittext', icon: TextCursorInput, label: 'toolEditText', group: 2 },
  { tool: 'note', icon: StickyNote, label: 'toolNote', group: 2 },
  { tool: 'pen', icon: PenLine, label: 'toolPen', group: 3 },
  { tool: 'marker', icon: Brush, label: 'toolMarker', group: 3 },
  { tool: 'eraser', icon: Eraser, label: 'toolEraser', group: 3 },
  { tool: 'rect', icon: Square, label: 'toolRect', group: 4 },
  { tool: 'ellipse', icon: Circle, label: 'toolEllipse', group: 4 },
  { tool: 'line', icon: Minus, label: 'toolLine', group: 4 },
  { tool: 'arrow', icon: ArrowUpRight, label: 'toolArrow', group: 4 },
  { tool: 'signature', icon: Signature, label: 'toolSignature', group: 5 },
  { tool: 'image', icon: ImagePlus, label: 'toolImage', group: 5 },
  { tool: 'stamp', icon: Stamp, label: 'toolStamp', group: 5 },
  { tool: 'whiteout', icon: RectangleHorizontal, label: 'toolWhiteout', group: 6 },
  { tool: 'redact', icon: EyeOff, label: 'toolRedact', group: 6 },
];

const LOGO = `<svg class="brand-logo" viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="4" width="40" height="52" rx="6" fill="#2563eb"/><path d="M36 4v12a4 4 0 0 0 4 4h12" fill="#93c5fd"/><path d="M36 4l16 16v30a6 6 0 0 1-6 6" fill="none"/><rect x="16" y="28" width="32" height="18" rx="4" fill="#fff"/><text x="32" y="41.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="11" fill="#2563eb">PDF</text></svg>`;

export function logo(cls = 'brand-logo'): HTMLElement {
  const span = h('span', { style: 'display:inline-flex' });
  span.innerHTML = LOGO.replace('class="brand-logo"', `class="${cls}"`);
  return span;
}

export class TopBar {
  readonly el: HTMLElement;
  private fileName = h('div.file-name');
  private pageInput = h('input.page-input', { type: 'text', inputmode: 'numeric', 'aria-label': t('goToPage') });
  private pageTotal = h('span', { style: 'color:var(--muted)' });
  private zoomSel = h('select.zoom-select', { 'aria-label': t('zoomIn') });
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;

  constructor(
    private viewer: Viewer,
    actions: ToolbarActions,
  ) {
    this.undoBtn = iconButton(Undo2, `${t('undo')} (Ctrl+Z)`, () => store.undo(), 'doc-only');
    this.redoBtn = iconButton(Redo2, `${t('redo')} (Ctrl+Y)`, () => store.redo(), 'doc-only');
    const more = iconButton(EllipsisVertical, t('more'), () => actions.more(more));
    this.pageInput.addEventListener('change', () => {
      const n = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(n)) viewer.scrollToPage(n - 1);
      this.update();
    });
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.zoomSel.addEventListener('change', () => {
      const v = this.zoomSel.value;
      if (v === 'auto' || v === 'width' || v === 'page') viewer.setMode(v);
      else viewer.zoomTo(parseFloat(v));
    });
    const brand = h('div.brand', {}, logo(), h('span', {}, t('appName')));
    this.el = h(
      'header#topbar',
      {},
      iconButton(PanelLeft, t('sidebar'), () => actions.toggleSidebar(), 'doc-only'),
      brand,
      iconButton(FolderOpen, `${t('open')} (Ctrl+O)`, () => actions.open()),
      iconButton(Save, `${t('save')} (Ctrl+S)`, () => actions.save(), 'doc-only'),
      iconButton(Printer, `${t('print')} (Ctrl+P)`, () => actions.print(), 'doc-only desktop-only'),
      this.fileName,
      h(
        'div.page-nav.doc-only.desktop-only',
        {},
        iconButton(ChevronLeft, t('prevPage'), () => viewer.scrollToPage(viewer.current - 1)),
        this.pageInput,
        this.pageTotal,
        iconButton(ChevronRight, t('nextPage'), () => viewer.scrollToPage(viewer.current + 1)),
      ),
      h('div.sep.doc-only.desktop-only'),
      h(
        'div.group.doc-only.desktop-only',
        {},
        iconButton(ZoomOut, t('zoomOut'), () => viewer.zoomBy(1 / 1.2)),
        this.zoomSel,
        iconButton(ZoomIn, t('zoomIn'), () => viewer.zoomBy(1.2)),
      ),
      h('div.sep.doc-only.desktop-only'),
      iconButton(Search, `${t('search')} (Ctrl+F)`, () => actions.search(), 'doc-only'),
      this.undoBtn,
      this.redoBtn,
      iconButton(LayoutGrid, t('organize'), () => actions.organize(), 'doc-only desktop-only'),
      more,
    );
    viewer.addEventListener('pagechange', () => this.update());
    viewer.addEventListener('zoom', () => this.updateZoom());
  }

  update(): void {
    const n = store.state.pages.length;
    if (document.activeElement !== this.pageInput) this.pageInput.value = n ? String(this.viewer.current + 1) : '';
    this.pageTotal.textContent = `/ ${n}`;
    this.fileName.replaceChildren(store.dirty ? h('span.dirty', {}, '● ') : '', store.fileName);
    this.fileName.title = store.fileName;
    this.undoBtn.disabled = !store.canUndo();
    this.redoBtn.disabled = !store.canRedo();
    document.title = store.fileName ? `${store.dirty ? '• ' : ''}${store.fileName} — ${t('appName')}` : t('appName');
    this.updateZoom();
  }

  private updateZoom(): void {
    const pct = Math.round(this.viewer.scale * 100);
    const opts: [string, string][] = [
      ['auto', t('autoZoom')],
      ['width', t('fitWidth')],
      ['page', t('fitPage')],
      ...[50, 75, 100, 125, 150, 200, 300, 400].map((p) => [String(p / 100), `${p}%`] as [string, string]),
    ];
    const value = this.viewer.mode === 'custom' ? String(this.viewer.scale) : this.viewer.mode;
    if (this.viewer.mode === 'custom' && !opts.some((o) => o[0] === value)) opts.push([value, `${pct}%`]);
    this.zoomSel.replaceChildren(...opts.map(([v, l]) => new Option(v === this.viewer.mode ? `${l} (${pct}%)` : l, v, false, v === value)));
  }
}

export class ToolBar {
  readonly el: HTMLElement;
  private buttons = new Map<Tool, HTMLButtonElement>();

  constructor(
    private tools: Tools,
    actions: ToolbarActions,
  ) {
    this.el = h('div#toolbar', { role: 'toolbar' });
    let group = -1;
    for (const d of TOOL_DEFS) {
      if (d.group !== group && group >= 0) this.el.append(h('div.sep'));
      group = d.group;
      const b = iconButton(d.icon, t(d.label), () => actions.chooseTool(d.tool));
      b.dataset.tool = d.tool;
      this.buttons.set(d.tool, b);
      this.el.append(b);
    }
    this.el.append(h('div.sep.mobile-only'), iconButton(LayoutGrid, t('organize'), () => actions.organize(), 'mobile-only'));
    tools.addEventListener('change', () => this.update());
  }

  update(): void {
    for (const [tool, b] of this.buttons) b.classList.toggle('active', tool === this.tools.tool);
    this.buttons.get(this.tools.tool)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

const PALETTE = ['#dc2626', '#ea580c', '#facc15', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#111827', '#ffffff'];
const HIGHLIGHTS = ['#facc15', '#a3e635', '#22d3ee', '#f472b6', '#fb923c', '#c084fc'];

export class PropsBar {
  readonly el: HTMLElement;

  constructor(private tools: Tools) {
    this.el = h('div#propsbar');
    tools.addEventListener('change', () => this.render());
    store.onChange(() => this.render());
  }

  render(): void {
    const key = this.tools.activeKey();
    const s = this.tools.current();
    const sel = this.tools.selected ? store.ann(this.tools.selected) : null;
    const parts: Node[] = [];
    if (key && s) {
      const noColor = ['image', 'signature', 'redact'].includes(key);
      if (!noColor) parts.push(this.colorPicker(key === 'highlight' || key === 'marker' ? HIGHLIGHTS : PALETTE, s.color, (c) => this.tools.applySetting('color', c)));
      if (['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow'].includes(key)) {
        parts.push(this.range(t('width'), s.width, key === 'marker' ? 4 : 0.5, key === 'marker' ? 40 : 20, 0.5, (v) => this.tools.applySetting('width', v)));
      }
      if (key === 'rect' || key === 'ellipse') {
        const on = h('input', { type: 'checkbox', checked: !!s.fill });
        const col = h('input.color-input', { type: 'color', value: s.fill ?? '#fde68a' });
        on.addEventListener('change', () => this.tools.applySetting('fill', on.checked ? col.value : null));
        col.addEventListener('change', () => {
          on.checked = true;
          this.tools.applySetting('fill', col.value);
        });
        parts.push(h('label.prop', {}, on, t('fill'), col));
      }
      if (!['whiteout', 'redact', 'note'].includes(key)) {
        parts.push(this.range(t('opacity'), Math.round(s.opacity * 100), 10, 100, 5, (v) => this.tools.applySetting('opacity', v / 100), '%'));
      }
      if (key === 'text') {
        const font = h('select', {}, ...(['sans', 'serif', 'mono'] as FontKey[]).map((f) => new Option(t(f === 'sans' ? 'fontSans' : f === 'serif' ? 'fontSerif' : 'fontMono'), f, false, f === s.font)));
        font.addEventListener('change', () => this.tools.applySetting('font', font.value as FontKey));
        parts.push(h('label.prop', {}, t('font'), font));
        parts.push(this.number(t('size'), s.size, 4, 144, (v) => this.tools.applySetting('size', v)));
        const bold = h('button.icon-btn', { type: 'button', title: t('bold'), 'aria-pressed': String(s.bold), onclick: () => this.tools.applySetting('bold', !s.bold) }, h('b', {}, 'B'));
        bold.classList.toggle('active', s.bold);
        parts.push(bold);
      }
      if (key === 'stamp' && sel) parts.push(this.number(t('size'), s.size, 6, 96, (v) => this.tools.applySetting('size', v)));
    }
    if (sel) {
      parts.push(h('span', { style: 'flex:1' }));
      if (sel.type === 'text' || sel.type === 'note') {
        const edit = iconButton(SquarePen, t('toolEditText'), () => this.tools.edit(sel));
        parts.push(edit);
      }
      parts.push(iconButton(Copy, t('duplicate'), () => this.tools.duplicateSelected()));
      parts.push(iconButton(Trash2, t('delete'), () => this.tools.deleteSelected()));
    } else if (this.tools.tool === 'redact') {
      parts.push(h('span.prop', {}, t('redactHint')));
    } else if (['highlight', 'underline', 'strike'].includes(this.tools.tool)) {
      parts.push(h('span.prop', { class: 'desktop-only' }, t('markupHint')));
    } else if (this.tools.tool === 'edittext') {
      parts.push(h('span.prop', {}, t('editTextHint')));
    }
    this.el.replaceChildren(...parts);
    this.el.classList.toggle('show', parts.length > 0);
  }

  private colorPicker(list: string[], value: string, onPick: (c: string) => void): HTMLElement {
    const wrap = h('div.prop');
    const sw = h('div.swatches');
    for (const c of list) {
      sw.append(
        h('button', {
          type: 'button',
          class: `swatch${c.toLowerCase() === value.toLowerCase() ? ' active' : ''}`,
          style: `background:${c}`,
          title: c,
          onclick: () => onPick(c),
        }),
      );
    }
    const custom = h('input.color-input', { type: 'color', value, title: t('color') });
    custom.addEventListener('change', () => onPick(custom.value));
    wrap.append(sw, custom);
    return wrap;
  }

  private range(label: string, value: number, min: number, max: number, step: number, on: (v: number) => void, unit = ''): HTMLElement {
    const r = h('input', { type: 'range', min, max, step, value });
    const out = h('span', { style: 'min-width:34px;text-align:right' }, `${value}${unit}`);
    r.addEventListener('input', () => (out.textContent = `${r.value}${unit}`));
    r.addEventListener('change', () => on(+r.value));
    return h('label.prop', {}, label, r, out);
  }

  private number(label: string, value: number, min: number, max: number, on: (v: number) => void): HTMLElement {
    const n = h('input', { type: 'number', min, max, value: Math.round(value * 10) / 10, step: 1 });
    n.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, +n.value || value));
      on(v);
    });
    return h('label.prop', {}, label, n);
  }
}

