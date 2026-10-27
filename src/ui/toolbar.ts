import type { IconNode } from 'lucide';
import {
  ArrowUpRight,
  Brush,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  EllipsisVertical,
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
  Scan,
  Search,
  Shapes,
  Signature,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  TextCursorInput,
  Type,
  Underline,
  Undo2,
  ZoomIn,
  ZoomOut,
  X,
} from 'lucide';
import { t, type Key } from '../i18n';
import { store } from '../store';
import { SYMBOL_TOOLS, toolOfType, type Tool, type Tools } from '../annotations/tools';
import type { Viewer, ZoomMode } from '../viewer/viewer';
import { h, icon, iconButton, openMenu, type MenuItem } from './dom';
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
  help(): void;
}

export interface ToolInfo {
  icon: IconNode;
  /** Full name (tooltips, menus, help). */
  label: Key;
  /** Short name under the toolbar icon. */
  short: Key;
  desc: Key;
  /** Single-key shortcut. */
  key?: string;
  hint?: Key;
}

export const TOOL_INFO: Record<Tool, ToolInfo> = {
  select: { icon: MousePointer2, label: 'toolSelect', short: 'shortSelect', desc: 'descSelect', key: 'V' },
  hand: { icon: Hand, label: 'toolHand', short: 'shortHand', desc: 'descHand', key: 'H', hint: 'hintHand' },
  highlight: { icon: Highlighter, label: 'toolHighlight', short: 'shortHighlight', desc: 'descHighlight', key: 'L', hint: 'hintMarkup' },
  underline: { icon: Underline, label: 'toolUnderline', short: 'shortUnderline', desc: 'descUnderline', hint: 'hintMarkupText' },
  strike: { icon: Strikethrough, label: 'toolStrike', short: 'shortStrike', desc: 'descStrike', hint: 'hintMarkupText' },
  note: { icon: StickyNote, label: 'toolNote', short: 'shortNote', desc: 'descNote', key: 'N', hint: 'hintNote' },
  text: { icon: Type, label: 'toolText', short: 'shortText', desc: 'descText', key: 'T', hint: 'hintText' },
  edittext: { icon: TextCursorInput, label: 'toolEditText', short: 'shortEdit', desc: 'descEditText', key: 'E', hint: 'editTextHint' },
  pen: { icon: PenLine, label: 'toolPen', short: 'shortPen', desc: 'descPen', key: 'P', hint: 'hintDraw' },
  marker: { icon: Brush, label: 'toolMarker', short: 'shortMarker', desc: 'descMarker', key: 'M', hint: 'hintDraw' },
  eraser: { icon: Eraser, label: 'toolEraser', short: 'shortEraser', desc: 'descEraser', key: 'X', hint: 'hintEraser' },
  rect: { icon: Square, label: 'toolRect', short: 'toolRect', desc: 'descShapes', key: 'R', hint: 'hintShape' },
  ellipse: { icon: Circle, label: 'toolEllipse', short: 'toolEllipse', desc: 'descShapes', hint: 'hintShape' },
  line: { icon: Minus, label: 'toolLine', short: 'toolLine', desc: 'descShapes', hint: 'hintShape' },
  arrow: { icon: ArrowUpRight, label: 'toolArrow', short: 'toolArrow', desc: 'descShapes', key: 'A', hint: 'hintShape' },
  signature: { icon: Signature, label: 'toolSignature', short: 'shortSign', desc: 'descSign', key: 'S', hint: 'placeHint' },
  image: { icon: ImagePlus, label: 'toolImage', short: 'toolImage', desc: 'descImage', key: 'I', hint: 'placeHint' },
  stamp: { icon: Stamp, label: 'toolStamp', short: 'toolStamp', desc: 'descStamp', hint: 'placeHint' },
  whiteout: { icon: RectangleHorizontal, label: 'toolWhiteout', short: 'toolWhiteout', desc: 'descWhiteout', key: 'W', hint: 'hintWhiteout' },
  redact: { icon: EyeOff, label: 'toolRedact', short: 'toolRedact', desc: 'descRedact', hint: 'redactHint' },
  snapshot: { icon: Scan, label: 'toolSnapshot', short: 'shortSnapshot', desc: 'descSnapshot', key: 'G', hint: 'hintSnapshot' },
  checkmark: { icon: Check, label: 'toolCheck', short: 'shortCheck', desc: 'descSymbols', hint: 'hintSymbol' },
  crossmark: { icon: X, label: 'toolCross', short: 'shortCross', desc: 'descSymbols', hint: 'hintSymbol' },
  datemark: { icon: CalendarDays, label: 'toolDate', short: 'shortDate', desc: 'descSymbols', hint: 'hintSymbol' },
};

export interface ToolGroup {
  id: string;
  tools: Tool[];
  /** Fixed label/icon for groups whose variants are too different to name the button after. */
  label?: Key;
  icon?: IconNode;
  /** Every variant starts its own dialog, so the button always asks which one. */
  menuOnly?: boolean;
}

/** Toolbar layout, ordered by how often people need the tools. */
export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'select', tools: ['select', 'hand', 'snapshot'] },
  { id: 'markup', tools: ['highlight', 'underline', 'strike'] },
  { id: 'note', tools: ['note'] },
  { id: 'text', tools: ['text'] },
  { id: 'edit', tools: ['edittext'] },
  { id: 'draw', tools: ['pen', 'marker', 'eraser'] },
  { id: 'shapes', tools: ['rect', 'ellipse', 'line', 'arrow'], label: 'groupShapes', icon: Shapes },
  { id: 'sign', tools: ['signature'] },
  { id: 'insert', tools: ['image', 'stamp', 'checkmark', 'crossmark', 'datemark'], label: 'groupInsert', icon: ImagePlus, menuOnly: true },
  { id: 'hide', tools: ['whiteout', 'redact'], label: 'groupHide', icon: EyeOff },
];

export function groupOf(tool: Tool): ToolGroup | undefined {
  return TOOL_GROUPS.find((g) => g.tools.includes(tool));
}

export function toolTitle(tool: Tool): string {
  const i = TOOL_INFO[tool];
  return i.key ? `${t(i.label)} (${i.key})` : t(i.label);
}

const LOGO = `<svg class="brand-logo" viewBox="0 0 64 64" aria-hidden="true"><rect x="8" y="4" width="40" height="52" rx="6" fill="#2563eb"/><path d="M36 4v12a4 4 0 0 0 4 4h12" fill="#93c5fd"/><rect x="16" y="28" width="32" height="18" rx="4" fill="#fff"/><text x="32" y="41.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-weight="700" font-size="11" fill="#2563eb">PDF</text></svg>`;

export function logo(cls = 'brand-logo'): HTMLElement {
  const span = h('span', { style: 'display:inline-flex' });
  span.innerHTML = LOGO.replace('class="brand-logo"', `class="${cls}"`);
  return span;
}

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';

export class TopBar {
  readonly el: HTMLElement;
  private fileName = h('div.file-name');
  private pageInput = h('input.page-input', { type: 'text', inputmode: 'numeric', 'aria-label': t('goToPage') });
  private pageTotal = h('span.page-total');
  private zoomBtn = h('button.zoom-btn', { type: 'button', title: t('autoZoom'), 'aria-haspopup': 'menu' });
  private undoBtn: HTMLButtonElement;
  private redoBtn: HTMLButtonElement;
  private saveBtn: HTMLButtonElement;

  constructor(
    private viewer: Viewer,
    actions: ToolbarActions,
  ) {
    this.undoBtn = iconButton(Undo2, `${t('undo')} (${MOD}Z)`, () => store.undo(), 'doc-only');
    this.redoBtn = iconButton(Redo2, `${t('redo')} (${MOD}Y)`, () => store.redo(), 'doc-only');
    const more = iconButton(EllipsisVertical, t('more'), () => actions.more(more));
    more.setAttribute('aria-haspopup', 'menu');
    this.saveBtn = h(
      'button.btn.btn-primary.save-btn.doc-only',
      { type: 'button', title: `${t('save')} (${MOD}S)`, 'aria-label': t('save'), onclick: () => actions.save() },
      icon(Save, 18),
      h('span.save-label', {}, t('save')),
    );
    this.pageInput.addEventListener('change', () => {
      const n = parseInt(this.pageInput.value, 10);
      if (Number.isFinite(n)) viewer.scrollToPage(n - 1);
      this.update();
    });
    this.pageInput.addEventListener('focus', () => this.pageInput.select());
    this.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.pageInput.blur();
    });
    this.zoomBtn.addEventListener('click', () => this.zoomMenu());
    const brand = h('div.brand', {}, logo(), h('span', {}, t('appName')));
    this.el = h(
      'header#topbar',
      {},
      h(
        'div.bar-left',
        {},
        iconButton(PanelLeft, t('sidebar'), () => actions.toggleSidebar(), 'doc-only'),
        brand,
        iconButton(FolderOpen, `${t('open')} (${MOD}O)`, () => actions.open()),
        this.fileName,
      ),
      h(
        'div.bar-center.doc-only.desktop-only',
        {},
        h(
          'div.page-nav',
          {},
          iconButton(ChevronLeft, t('prevPage'), () => viewer.scrollToPage(viewer.current - 1)),
          this.pageInput,
          this.pageTotal,
          iconButton(ChevronRight, t('nextPage'), () => viewer.scrollToPage(viewer.current + 1)),
        ),
        h('div.sep'),
        h(
          'div.group',
          {},
          iconButton(ZoomOut, `${t('zoomOut')} (${MOD}−)`, () => viewer.zoomBy(1 / 1.2)),
          this.zoomBtn,
          iconButton(ZoomIn, `${t('zoomIn')} (${MOD}+)`, () => viewer.zoomBy(1.2)),
        ),
      ),
      h(
        'div.bar-right',
        {},
        iconButton(Search, `${t('search')} (${MOD}F)`, () => actions.search(), 'doc-only'),
        this.undoBtn,
        this.redoBtn,
        iconButton(Printer, `${t('print')} (${MOD}P)`, () => actions.print(), 'doc-only desktop-only'),
        iconButton(CircleHelp, `${t('help')} (?)`, () => actions.help(), 'desktop-only'),
        this.saveBtn,
        more,
      ),
    );
    viewer.addEventListener('pagechange', () => this.update());
    viewer.addEventListener('zoom', () => this.updateZoom());
  }

  update(): void {
    const n = store.state.pages.length;
    if (document.activeElement !== this.pageInput) this.pageInput.value = n ? String(this.viewer.current + 1) : '';
    this.pageTotal.textContent = `${t('pageOf')} ${n}`;
    this.fileName.replaceChildren(store.dirty ? h('span.dirty', { title: t('unsavedChanges') }, '●') : '', h('span', {}, store.fileName));
    this.fileName.title = store.fileName;
    this.undoBtn.disabled = !store.canUndo();
    this.redoBtn.disabled = !store.canRedo();
    this.saveBtn.classList.toggle('is-dirty', store.dirty);
    document.title = store.fileName ? `${store.dirty ? '• ' : ''}${store.fileName} — ${t('appName')}` : t('appName');
    this.updateZoom();
  }

  private updateZoom(): void {
    this.zoomBtn.replaceChildren(h('span', {}, `${Math.round(this.viewer.scale * 100)}%`), icon(ChevronDown, 14));
  }

  private zoomMenu(): void {
    const v = this.viewer;
    const mode = (m: ZoomMode, label: Key, hint?: string): MenuItem => ({ label: t(label), hint, checked: v.mode === m, action: () => v.setMode(m) });
    const items: MenuItem[] = [
      mode('auto', 'autoZoom', `${MOD}0`),
      mode('width', 'fitWidth'),
      mode('page', 'fitPage'),
      ...[50, 75, 100, 125, 150, 200, 300, 400].map((p, i) => ({
        label: `${p}%`,
        checked: v.mode === 'custom' && Math.round(v.scale * 100) === p,
        separatorBefore: i === 0,
        action: () => v.zoomTo(p / 100),
      })),
    ];
    openMenu(this.zoomBtn, items);
  }
}

const LAST_KEY = 'pr.toolVariants';

export class ToolBar {
  readonly el: HTMLElement;
  private inner: HTMLElement;
  private buttons = new Map<string, HTMLButtonElement>();
  private last: Record<string, Tool> = {};

  constructor(
    private tools: Tools,
    private actions: ToolbarActions,
  ) {
    try {
      this.last = JSON.parse(localStorage.getItem(LAST_KEY) || '{}');
    } catch {
      /* ignore */
    }
    this.inner = h('div.toolbar-inner');
    this.el = h('nav#toolbar', { role: 'toolbar', 'aria-label': t('helpTools') }, this.inner);
    TOOL_GROUPS.forEach((g, i) => {
      if (i === 1 || i === 5 || i === 7) this.inner.append(h('div.sep'));
      const b = h('button.tool-btn', { type: 'button', 'data-group': g.id });
      if (g.tools.length > 1) b.setAttribute('aria-haspopup', 'menu');
      b.addEventListener('click', () => this.onGroup(g, b));
      this.buttons.set(g.id, b);
      this.inner.append(b);
    });
    this.inner.append(
      h('div.sep'),
      h(
        'button.tool-btn',
        { type: 'button', 'data-group': 'pages', title: t('descPages'), onclick: () => actions.organize() },
        icon(LayoutGrid, 22),
        h('span.tool-label', {}, t('groupPages')),
      ),
    );
    tools.addEventListener('change', () => this.update());
    // Edge fades show that the bar scrolls (phones).
    const fades = () => {
      const el = this.el;
      el.classList.toggle('more-left', el.scrollLeft > 4);
      el.classList.toggle('more-right', el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
    };
    this.el.addEventListener('scroll', fades, { passive: true });
    new ResizeObserver(fades).observe(this.el);
    this.update();
  }

  private variant(g: ToolGroup): Tool {
    if (g.tools.includes(this.tools.tool)) return this.tools.tool;
    const l = this.last[g.id];
    return l && g.tools.includes(l) ? l : g.tools[0];
  }

  private onGroup(g: ToolGroup, b: HTMLButtonElement): void {
    const active = g.tools.includes(this.tools.tool);
    if ((active || g.menuOnly) && g.tools.length > 1) {
      openMenu(
        b,
        g.tools.map((tool) => ({
          label: t(TOOL_INFO[tool].label),
          icon: TOOL_INFO[tool].icon,
          hint: TOOL_INFO[tool].key,
          checked: tool === this.tools.tool,
          action: () => this.choose(g, tool),
        })),
      );
      return;
    }
    this.choose(g, this.variant(g));
  }

  private choose(g: ToolGroup, tool: Tool): void {
    this.last[g.id] = tool;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify(this.last));
    } catch {
      /* ignore */
    }
    this.actions.chooseTool(tool);
  }

  update(): void {
    for (const g of TOOL_GROUPS) {
      const b = this.buttons.get(g.id)!;
      const tool = this.variant(g);
      const info = TOOL_INFO[tool];
      const active = g.tools.includes(this.tools.tool);
      const label = g.label ? t(g.label) : t(info.short);
      b.replaceChildren(icon(g.icon && (!active || g.menuOnly) ? g.icon : info.icon, 22), h('span.tool-label', {}, label));
      if (g.tools.length > 1) b.append(h('span.tool-caret', { 'aria-hidden': 'true' }));
      b.classList.toggle('active', active);
      b.setAttribute('aria-pressed', String(active));
      b.title = g.menuOnly
        ? g.tools.map((x) => toolTitle(x)).join(' · ')
        : g.tools.length > 1
          ? `${toolTitle(tool)}\n${t(info.desc)}\n▾ ${t('moreOptions')}`
          : `${toolTitle(tool)}\n${t(info.desc)}`;
      b.setAttribute('aria-label', g.menuOnly ? label : toolTitle(tool));
    }
    this.buttons.get(groupOf(this.tools.tool)?.id ?? '')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

const PALETTE = ['#dc2626', '#ea580c', '#facc15', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#111827', '#ffffff'];
const HIGHLIGHTS = ['#facc15', '#a3e635', '#22d3ee', '#f472b6', '#fb923c', '#c084fc'];
const isTouch = matchMedia('(pointer: coarse)').matches;
const CAPTURE = ['pen', 'marker', 'eraser', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'text', 'note', 'snapshot', 'checkmark', 'crossmark', 'datemark'];

const narrow = matchMedia('(max-width: 760px)');

export class PropsBar {
  readonly el: HTMLElement;
  private lastTool: Tool | null = null;
  private hintTimer = 0;

  constructor(
    private tools: Tools,
    private actions: ToolbarActions,
  ) {
    this.el = h('div#propsbar', { role: 'region', 'aria-label': t('properties') });
    tools.addEventListener('change', () => this.render());
    store.onChange(() => this.render());
  }

  render(): void {
    const key = this.tools.activeKey();
    const s = this.tools.current();
    const sel = this.tools.selected ? store.ann(this.tools.selected) : null;
    const tool = this.tools.tool;
    if (!sel && tool === 'select') {
      this.lastTool = tool;
      this.el.replaceChildren();
      this.el.classList.remove('show');
      document.getElementById('toolHint')?.classList.remove('show');
      return;
    }
    // Keep focus/drag on a slider from being destroyed mid-interaction.
    if (this.el.contains(document.activeElement) && document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'range') return;
    const parts: Node[] = [];
    const chipTool = sel ? toolOfType(sel.type) : tool;
    const info = TOOL_INFO[chipTool];
    parts.push(h('span.prop-chip', {}, icon(info.icon, 16), h('span', {}, t(info.label))));
    if (key && s) {
      const noColor = ['image', 'signature', 'redact', 'hand', 'eraser', 'edittext'].includes(key);
      if (!noColor) parts.push(this.colorPicker(key === 'highlight' || key === 'marker' ? HIGHLIGHTS : PALETTE, s.color, (c) => this.tools.applySetting('color', c)));
      if (['pen', 'marker', 'rect', 'ellipse', 'line', 'arrow'].includes(key)) {
        parts.push(this.range(t('width'), s.width, key === 'marker' ? 4 : 0.5, key === 'marker' ? 40 : 20, 0.5, (v) => this.tools.applySetting('width', v)));
      }
      if (key === 'rect' || key === 'ellipse') {
        const on = h('input', { type: 'checkbox', checked: !!s.fill });
        const col = h('input.color-input', { type: 'color', value: s.fill ?? '#fde68a', title: t('fill') });
        on.addEventListener('change', () => this.tools.applySetting('fill', on.checked ? col.value : null));
        col.addEventListener('change', () => {
          on.checked = true;
          this.tools.applySetting('fill', col.value);
        });
        parts.push(h('label.prop', {}, on, t('fill'), col));
      }
      if (!['whiteout', 'redact', 'note', 'hand', 'eraser', 'edittext'].includes(key) && !SYMBOL_TOOLS.has(key)) {
        parts.push(this.range(t('opacity'), Math.round(s.opacity * 100), 10, 100, 5, (v) => this.tools.applySetting('opacity', v / 100), '%'));
      }
      if (key === 'text') {
        const font = h(
          'select',
          { 'aria-label': t('font') },
          ...(['sans', 'serif', 'mono'] as FontKey[]).map((f) => new Option(t(f === 'sans' ? 'fontSans' : f === 'serif' ? 'fontSerif' : 'fontMono'), f, false, f === s.font)),
        );
        font.addEventListener('change', () => this.tools.applySetting('font', font.value as FontKey));
        parts.push(h('label.prop', {}, h('span.prop-name', {}, t('font')), font));
        parts.push(this.number(t('size'), s.size, 4, 144, (v) => this.tools.applySetting('size', v)));
        const bold = h(
          'button.icon-btn',
          { type: 'button', title: t('bold'), 'aria-pressed': String(s.bold), onclick: () => this.tools.applySetting('bold', !s.bold) },
          h('b', {}, 'B'),
        );
        bold.classList.toggle('active', s.bold);
        parts.push(bold);
      }
      if (key === 'stamp' && sel) parts.push(this.number(t('size'), s.size, 6, 96, (v) => this.tools.applySetting('size', v)));
      if (SYMBOL_TOOLS.has(key)) parts.push(this.number(t('size'), s.size, 6, 72, (v) => this.tools.applySetting('size', v)));
    }
    if (!sel) {
      const hintKey = TOOL_INFO[tool]?.hint;
      const hint = hintKey ? `${t(hintKey)}${isTouch && CAPTURE.includes(tool) ? ` ${t('hintTouchScroll')}` : ''}` : '';
      if (hint && !narrow.matches) parts.push(h('span.prop-hint', {}, hint));
      else parts.push(h('span.prop-spacer'));
      if (hint && narrow.matches && tool !== this.lastTool) this.flashHint(hint);
      parts.push(
        h('button.btn.btn-small.prop-done', { type: 'button', title: `${t('done')} (Esc)`, onclick: () => this.actions.chooseTool('select') }, icon(X, 16), h('span', {}, t('done'))),
      );
    }
    this.lastTool = tool;
    this.el.replaceChildren(...parts);
    this.el.classList.add('show');
  }

  /** On phones the hint floats over the page for a moment instead of taking toolbar space. */
  private flashHint(text: string): void {
    const host = document.getElementById('viewerWrap');
    if (!host) return;
    let el = document.getElementById('toolHint');
    if (!el) {
      el = h('div#toolHint', { role: 'status' });
      host.append(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => el!.classList.remove('show'), 4000);
  }

  private colorPicker(list: string[], value: string, onPick: (c: string) => void): HTMLElement {
    const wrap = h('div.prop', { role: 'group', 'aria-label': t('color') });
    const sw = h('div.swatches');
    for (const c of list) {
      sw.append(
        h('button', {
          type: 'button',
          class: `swatch${c.toLowerCase() === value.toLowerCase() ? ' active' : ''}`,
          style: `background:${c}`,
          title: c,
          'aria-label': c,
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
    const r = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    const out = h('span.prop-value', {}, `${value}${unit}`);
    r.addEventListener('input', () => (out.textContent = `${r.value}${unit}`));
    r.addEventListener('change', () => {
      on(+r.value);
      r.blur();
    });
    return h('label.prop', {}, h('span.prop-name', {}, label), r, out);
  }

  private number(label: string, value: number, min: number, max: number, on: (v: number) => void): HTMLElement {
    const n = h('input', { type: 'number', min, max, value: Math.round(value * 10) / 10, step: 1, 'aria-label': label });
    n.addEventListener('change', () => {
      const v = Math.max(min, Math.min(max, +n.value || value));
      on(v);
    });
    return h('label.prop', {}, h('span.prop-name', {}, label), n);
  }
}
