import { store } from '../store';
import { t, type Key } from '../i18n';
import { visualSize } from '../pages';
import type { Annotation } from '../model';
import type { Viewer } from '../viewer/viewer';
import type { Tools } from '../annotations/tools';
import { annBBox } from '../geometry';
import { drawThumb } from './thumbs';
import { h, icon } from './dom';
import { Trash2 } from 'lucide';

type Tab = 'thumbs' | 'outline' | 'comments';

interface OutlineNode {
  title: string;
  dest: unknown;
  url?: string | null;
  items: OutlineNode[];
}

const TYPE_LABEL: Record<Annotation['type'], Key> = {
  ink: 'toolPen',
  marker: 'toolMarker',
  rect: 'toolRect',
  ellipse: 'toolEllipse',
  line: 'toolLine',
  arrow: 'toolArrow',
  highlight: 'toolHighlight',
  underline: 'toolUnderline',
  strike: 'toolStrike',
  text: 'toolText',
  note: 'toolNote',
  image: 'toolImage',
  signature: 'toolSignature',
  stamp: 'toolStamp',
  whiteout: 'toolWhiteout',
  redact: 'toolRedact',
};

export class Sidebar {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tab: Tab = 'thumbs';
  private tabs: Record<Tab, HTMLButtonElement>;
  private io: IntersectionObserver | null = null;
  private thumbEls: HTMLElement[] = [];
  private outlineCache: { src: string; nodes: OutlineNode[] } | null = null;

  constructor(
    private viewer: Viewer,
    private tools: Tools,
    private goToDest: (dest: unknown) => void,
  ) {
    this.body = h('div.side-body');
    const mk = (tab: Tab, label: string) => h('button', { type: 'button', onclick: () => this.show(tab) }, label);
    this.tabs = { thumbs: mk('thumbs', t('thumbnails')), outline: mk('outline', t('outline')), comments: mk('comments', t('comments')) };
    this.el = h('aside#sidebar', {}, h('div.side-tabs', {}, this.tabs.thumbs, this.tabs.outline, this.tabs.comments), this.body);
    viewer.addEventListener('pagechange', () => this.markCurrent());
  }

  get isOpen(): boolean {
    return document.body.classList.contains('sidebar-open');
  }

  toggle(force?: boolean): void {
    const open = force ?? !this.isOpen;
    document.body.classList.toggle('sidebar-open', open);
    try {
      if (window.innerWidth > 760) localStorage.setItem('pr.sidebar', open ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (open) this.render();
  }

  show(tab: Tab): void {
    this.tab = tab;
    this.render();
  }

  /** Re-renders the visible tab (called on document changes). */
  render(): void {
    if (!this.isOpen) return;
    for (const [k, b] of Object.entries(this.tabs)) b.classList.toggle('active', k === this.tab);
    this.io?.disconnect();
    this.io = null;
    if (this.tab === 'thumbs') this.renderThumbs();
    else if (this.tab === 'outline') void this.renderOutline();
    else this.renderComments();
  }

  private closeOnMobile(): void {
    if (window.innerWidth <= 760) this.toggle(false);
  }

  private renderThumbs(): void {
    const width = 150;
    this.thumbEls = store.state.pages.map((p, i) => {
      const { w, h: hh } = visualSize(p);
      const box = h('div.thumb-img', { style: `width:${width}px;height:${Math.round((width * hh) / w)}px` });
      const el = h('div.thumb', { 'data-i': i, onclick: () => (this.viewer.scrollToPage(i), this.closeOnMobile()) }, box, String(i + 1));
      return el;
    });
    this.body.replaceChildren(...this.thumbEls);
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          this.io?.unobserve(el);
          const i = +(el.dataset.i ?? 0);
          const p = store.state.pages[i];
          if (!p) continue;
          const c = h('canvas');
          el.querySelector('.thumb-img')!.replaceChildren(c);
          void drawThumb(p, c, width);
        }
      },
      { root: this.body, rootMargin: '300px 0px' },
    );
    for (const el of this.thumbEls) this.io.observe(el);
    this.markCurrent(true);
  }

  private markCurrent(scroll = false): void {
    if (this.tab !== 'thumbs' || !this.isOpen) return;
    this.thumbEls.forEach((el, i) => el.classList.toggle('current', i === this.viewer.current));
    const cur = this.thumbEls[this.viewer.current];
    if (cur) {
      const b = this.body;
      if (scroll || cur.offsetTop < b.scrollTop || cur.offsetTop + cur.offsetHeight > b.scrollTop + b.clientHeight) {
        b.scrollTop = cur.offsetTop - b.clientHeight / 3;
      }
    }
  }

  private async renderOutline(): Promise<void> {
    const primary = store.primary;
    if (!primary) return;
    let nodes: OutlineNode[] = [];
    if (this.outlineCache?.src === primary) nodes = this.outlineCache.nodes;
    else {
      nodes = ((await store.source(primary).pdf.getOutline().catch(() => null)) ?? []) as OutlineNode[];
      this.outlineCache = { src: primary, nodes };
    }
    if (this.tab !== 'outline') return;
    if (!nodes.length) {
      this.body.replaceChildren(h('div.empty', {}, t('noOutline')));
      return;
    }
    const build = (list: OutlineNode[]): HTMLElement =>
      h(
        'div',
        {},
        ...list.map((n) =>
          h(
            'div',
            {},
            h(
              'button.outline-item',
              {
                type: 'button',
                onclick: () => {
                  if (n.url) window.open(n.url, '_blank', 'noopener');
                  else this.goToDest(n.dest);
                  this.closeOnMobile();
                },
              },
              n.title,
            ),
            n.items?.length ? h('div.outline-children', {}, build(n.items)) : null,
          ),
        ),
      );
    this.body.replaceChildren(build(nodes));
  }

  private renderComments(): void {
    const pages = store.state.pages;
    const order = new Map(pages.map((p, i) => [p.id, i]));
    const anns = store.state.anns
      .filter((a) => order.has(a.pageId) && a.type !== 'whiteout')
      .sort((a, b) => order.get(a.pageId)! - order.get(b.pageId)! || annBBox(b).y2 - annBBox(a).y2);
    if (!anns.length) {
      this.body.replaceChildren(h('div.empty', {}, t('noComments')));
      return;
    }
    this.body.replaceChildren(
      ...anns.map((a) => {
        const text = a.type === 'note' || a.type === 'text' ? a.text : 'text' in a && a.text ? `“${a.text}”` : a.type === 'stamp' ? a.label : '';
        return h(
          'div.comment-item',
          {
            onclick: () => {
              const i = order.get(a.pageId)!;
              const bb = annBBox(a);
              this.viewer.scrollToPage(i, { userY: bb.y2, userX: (bb.x1 + bb.x2) / 2 });
              this.tools.setTool('select');
              this.tools.select(a.id);
              this.closeOnMobile();
            },
          },
          h(
            'div.ci-head',
            {},
            h('span.ci-dot', { style: `background:${a.type === 'redact' ? '#000' : a.color}` }),
            h('span', {}, t(TYPE_LABEL[a.type])),
            h('span', { style: 'margin-left:auto' }, t('commentOnPage', { n: order.get(a.pageId)! + 1 })),
            h(
              'button.icon-btn.ci-delete',
              {
                type: 'button',
                title: t('delete'),
                'aria-label': t('delete'),
                onclick: (e: Event) => {
                  e.stopPropagation();
                  if (this.tools.selected === a.id) this.tools.select(null);
                  store.removeAnns([a.id]);
                },
              },
              icon(Trash2, 16),
            ),
          ),
          a.author ? h('div.ci-head', {}, a.author) : null,
          text ? h('div.ci-text', {}, text) : null,
        );
      }),
    );
  }

  /** Only the comments list depends on annotations. */
  annotationsChanged(): void {
    if (this.tab === 'comments') this.render();
  }

  resetOutline(): void {
    this.outlineCache = null;
  }
}
