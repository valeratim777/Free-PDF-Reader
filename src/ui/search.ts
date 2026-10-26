import { store } from '../store';
import { t } from '../i18n';
import { pageText, type PageText } from '../text';
import type { Viewer } from '../viewer/viewer';
import type { PageView } from '../viewer/pageView';
import { ChevronDown, ChevronUp, X } from 'lucide';
import { h, iconButton } from './dom';

interface Match {
  pageId: string;
  start: number;
  end: number;
}

/** Full-text search across all pages with highlighting in the text layer. */
export class Search {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private caseBox: HTMLInputElement;
  private wordBox: HTMLInputElement;
  private matches: Match[] = [];
  private index = -1;
  /** Scroll to the current match once its page is painted. */
  private reveal = false;
  private runId = 0;
  private timer = 0;
  private texts = new Map<string, PageText>();

  constructor(private viewer: Viewer) {
    this.input = h('input', { type: 'search', placeholder: t('search'), enterkeyhint: 'search' });
    this.count = h('span.search-count');
    this.caseBox = h('input', { type: 'checkbox' });
    this.wordBox = h('input', { type: 'checkbox' });
    this.el = h(
      'div#searchbar',
      {},
      this.input,
      this.count,
      iconButton(ChevronUp, t('prevPage'), () => this.step(-1)),
      iconButton(ChevronDown, t('nextPage'), () => this.step(1)),
      h('label.search-opt', {}, this.caseBox, 'Aa'),
      h('label.search-opt', { title: t('wholeWord') }, this.wordBox, '|ab|'),
      iconButton(X, t('close'), () => this.close()),
    );
    this.caseBox.title = t('matchCase');
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), 250);
    });
    this.caseBox.addEventListener('change', () => void this.run());
    this.wordBox.addEventListener('change', () => void this.run());
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = 0;
          void this.run().then(() => this.step(0));
        } else this.step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return this.el.classList.contains('show');
  }

  open(): void {
    this.el.classList.add('show');
    const sel = window.getSelection()?.toString().trim();
    if (sel && sel.length < 80 && !sel.includes('\n')) {
      this.input.value = sel;
      void this.run();
    }
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.el.classList.remove('show');
    this.matches = [];
    this.index = -1;
    this.count.textContent = '';
    for (const v of this.viewer.order) v.searchDiv.replaceChildren();
  }

  /** Document changed: cached results may point to removed pages. */
  invalidate(): void {
    this.texts.clear();
    if (this.isOpen && this.input.value) void this.run(false);
  }

  private async run(jump = true): Promise<void> {
    this.timer = 0;
    const id = ++this.runId;
    const q = this.input.value;
    this.matches = [];
    this.index = -1;
    for (const v of this.viewer.order) v.searchDiv.replaceChildren();
    if (!q.trim()) {
      this.count.textContent = '';
      return;
    }
    const cs = this.caseBox.checked;
    const needle = cs ? q : q.toLowerCase();
    const whole = this.wordBox.checked;
    const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
    const pages = store.state.pages;
    // Start at the current page so the first hit is close to the reader.
    for (let k = 0; k < pages.length; k++) {
      const p = pages[k];
      let pt = this.texts.get(`${p.src}:${p.index}`);
      if (!pt) {
        pt = await pageText(p);
        this.texts.set(`${p.src}:${p.index}`, pt);
      }
      if (id !== this.runId) return;
      const hay = cs ? pt.text : pt.text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        from = at + Math.max(1, needle.length);
        if (whole && (isWord(hay[at - 1]) || isWord(hay[at + needle.length]))) continue;
        this.matches.push({ pageId: p.id, start: at, end: at + needle.length });
      }
      if (k % 20 === 0) this.updateCount();
    }
    this.updateCount();
    if (jump && this.matches.length) {
      const cur = this.viewer.current;
      const order = new Map(pages.map((p, i) => [p.id, i]));
      const i = this.matches.findIndex((m) => order.get(m.pageId)! >= cur);
      this.select(i >= 0 ? i : 0);
    }
    for (const v of this.viewer.order) this.paint(v);
  }

  private updateCount(): void {
    const n = this.matches.length;
    this.count.textContent = n ? `${this.index + 1 || '–'} / ${n}` : this.input.value ? t('noResults') : '';
  }

  step(dir: number): void {
    if (!this.matches.length) return;
    const n = this.matches.length;
    this.select((((this.index < 0 ? 0 : this.index + dir) % n) + n) % n);
  }

  private select(i: number): void {
    const prev = this.matches[this.index];
    this.index = i;
    this.reveal = true;
    this.updateCount();
    const m = this.matches[i];
    const pi = store.pageIndex(m.pageId);
    if (pi < 0) return;
    if (prev && prev.pageId !== m.pageId) {
      const pv = this.viewer.views.get(prev.pageId);
      if (pv) this.paint(pv);
    }
    const pv = this.viewer.views.get(m.pageId);
    if (pv && pv.textReady) {
      this.paint(pv);
    } else {
      this.viewer.scrollToPage(pi);
    }
  }

  /** Draws highlight boxes for matches on a page whose text layer is ready. */
  paint(pv: PageView): void {
    pv.searchDiv.replaceChildren();
    if (!this.isOpen || !this.matches.length || !pv.textReady) return;
    const pt = this.texts.get(`${pv.page.src}:${pv.page.index}`);
    if (!pt) return;
    const divs = pv.textDivs;
    const pageRect = pv.div.getBoundingClientRect();
    const sx = pageRect.width / pv.div.offsetWidth || 1;
    const current = this.matches[this.index];
    for (const m of this.matches) {
      if (m.pageId !== pv.page.id) continue;
      const range = toRange(pt, divs, m.start, m.end);
      if (!range) continue;
      const isCur = m === current;
      let first: HTMLElement | null = null;
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const box = h('div', {
          class: `hit${isCur ? ' current' : ''}`,
          style: `left:${(r.left - pageRect.left) / sx}px;top:${(r.top - pageRect.top) / sx}px;width:${r.width / sx}px;height:${r.height / sx}px`,
        });
        first ??= box;
        pv.searchDiv.append(box);
      }
      if (isCur && first && this.reveal) {
        this.reveal = false;
        this.viewer.revealBox(pv, { left: parseFloat(first.style.left), top: parseFloat(first.style.top), width: parseFloat(first.style.width), height: parseFloat(first.style.height) });
      }
    }
  }
}

function locate(pt: PageText, divs: HTMLElement[], offset: number, end: boolean): { node: Node; off: number } | null {
  // Find the item containing `offset`; offsets that fall on inserted line breaks
  // snap to the neighbouring item.
  let i = 0;
  let lo = 0;
  let hi = pt.offsets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pt.offsets[mid] <= offset) {
      i = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  let local = offset - pt.offsets[i];
  if (local > pt.items[i].str.length) {
    if (end) local = pt.items[i].str.length;
    else if (i + 1 < pt.items.length) {
      i++;
      local = 0;
    } else local = pt.items[i].str.length;
  }
  const div = divs[i];
  const node = div?.firstChild;
  if (!div || !div.isConnected || !node) return null;
  return { node, off: Math.min(local, node.textContent?.length ?? 0) };
}

function toRange(pt: PageText, divs: HTMLElement[], start: number, end: number): Range | null {
  const a = locate(pt, divs, start, false);
  const b = locate(pt, divs, end, true);
  if (!a || !b) return null;
  const r = document.createRange();
  try {
    r.setStart(a.node, a.off);
    r.setEnd(b.node, b.off);
  } catch {
    return null;
  }
  return r;
}
