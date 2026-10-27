import { store } from '../store';
import { t } from '../i18n';
import { pageText, type PageText } from '../text';
import type { Viewer } from '../viewer/viewer';
import type { PageView } from '../viewer/pageView';
import { CaseSensitive, ChevronDown, ChevronUp, List, WholeWord, X } from 'lucide';
import { h, icon, iconButton } from './dom';

interface Match {
  pageId: string;
  start: number;
  end: number;
}

/** The list shows this many hits; the arrows still step through all of them. */
const LIST_LIMIT = 500;
const narrow = matchMedia('(max-width: 760px)');

/** Full-text search across all pages with highlighting in the text layer. */
export class Search {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private count: HTMLElement;
  private matchCase = false;
  private wholeWord = false;
  private matches: Match[] = [];
  private index = -1;
  /** Scroll to the current match once its page is painted. */
  private reveal = false;
  private runId = 0;
  private timer = 0;
  private texts = new Map<string, PageText>();
  private list: HTMLElement;
  private listBtn: HTMLButtonElement;
  private listOpen = true;
  private rows: HTMLElement[] = [];
  private scanned = 0;

  constructor(private viewer: Viewer) {
    this.input = h('input', { type: 'search', placeholder: t('search'), enterkeyhint: 'search' });
    this.count = h('span.search-count');
    this.list = h('div.search-results', { role: 'listbox', 'aria-label': t('searchResults') });
    this.listBtn = h(
      'button.icon-btn.search-list-btn',
      { type: 'button', title: t('searchResults'), 'aria-label': t('searchResults'), 'aria-pressed': 'true', onclick: () => this.toggleList() },
      icon(List, 18),
    );
    try {
      this.listOpen = localStorage.getItem('pr.searchList') !== '0';
    } catch {
      /* ignore */
    }
    const toggle = (ic: Parameters<typeof icon>[0], label: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = h('button.icon-btn.search-opt', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false' }, icon(ic, 18));
      b.addEventListener('click', () => {
        set(!get());
        b.classList.toggle('active', get());
        b.setAttribute('aria-pressed', String(get()));
        void this.run();
      });
      return b;
    };
    this.el = h(
      'div#searchbar',
      {},
      h(
        'div.search-row',
        {},
        this.input,
        this.count,
        iconButton(ChevronUp, `${t('prevMatch')} (Shift+Enter)`, () => this.step(-1)),
        iconButton(ChevronDown, `${t('nextMatch')} (Enter)`, () => this.step(1)),
        this.listBtn,
        toggle(CaseSensitive, t('matchCase'), () => this.matchCase, (v) => (this.matchCase = v)),
        toggle(WholeWord, t('wholeWord'), () => this.wholeWord, (v) => (this.wholeWord = v)),
        iconButton(X, t('close'), () => this.close()),
      ),
      this.list,
    );
    this.syncListVisibility();
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });
    this.input.addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.run(), 250);
    });
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
    this.runId++;
    this.matches = [];
    this.index = -1;
    this.count.textContent = '';
    this.rows = [];
    this.list.replaceChildren();
    this.syncListVisibility();
    for (const v of this.viewer.order) v.searchDiv.replaceChildren();
  }

  private toggleList(open = !this.listOpen): void {
    this.listOpen = open;
    try {
      localStorage.setItem('pr.searchList', open ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.syncListVisibility();
    if (open) this.rows[this.index]?.scrollIntoView({ block: 'nearest' });
  }

  private syncListVisibility(): void {
    const show = this.listOpen && !!this.input.value.trim();
    this.list.classList.toggle('show', show);
    this.listBtn.classList.toggle('active', this.listOpen);
    this.listBtn.setAttribute('aria-pressed', String(this.listOpen));
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
    this.scanned = 0;
    for (const v of this.viewer.order) v.searchDiv.replaceChildren();
    this.syncListVisibility();
    if (!q.trim()) {
      this.count.textContent = '';
      this.rows = [];
      this.list.replaceChildren();
      return;
    }
    const cs = this.matchCase;
    const needle = cs ? q : q.toLowerCase();
    const whole = this.wholeWord;
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
      this.scanned = k + 1;
      if (k % 20 === 0) {
        this.updateCount();
        this.renderList();
      }
    }
    this.updateCount();
    this.renderList();
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

  /** The full list of hits with a bit of surrounding text, grouped by page. */
  private renderList(): void {
    const pages = store.state.pages;
    const order = new Map(pages.map((p, i) => [p.id, i]));
    const total = this.matches.length;
    const done = this.scanned >= pages.length;
    const head = h(
      'div.sr-head',
      {},
      total
        ? t('searchSummary', { n: total, p: new Set(this.matches.map((m) => m.pageId)).size })
        : done
          ? t('noResults')
          : t('searching'),
      !done ? h('span.sr-progress', {}, ` ${this.scanned}/${pages.length}`) : null,
    );
    this.rows = [];
    const out: Node[] = [head];
    let lastPage = '';
    for (let i = 0; i < Math.min(total, LIST_LIMIT); i++) {
      const m = this.matches[i];
      if (m.pageId !== lastPage) {
        lastPage = m.pageId;
        out.push(h('div.sr-page', {}, `${t('page')} ${(order.get(m.pageId) ?? 0) + 1}`));
      }
      const row = h(
        'button.sr-item',
        { type: 'button', role: 'option', onclick: () => this.pick(i) },
        ...this.snippet(m),
      );
      if (i === this.index) row.classList.add('current');
      this.rows.push(row);
      out.push(row);
    }
    if (total > LIST_LIMIT) out.push(h('div.sr-more', {}, t('searchMore', { n: total - LIST_LIMIT })));
    this.list.replaceChildren(...out);
  }

  private snippet(m: Match): (Node | string)[] {
    const pg = store.page(m.pageId);
    const text = pg ? this.texts.get(`${pg.src}:${pg.index}`)?.text ?? '' : '';
    let a = Math.max(0, m.start - 40);
    let b = Math.min(text.length, m.end + 70);
    // Start and end on word boundaries so the context reads naturally.
    if (a > 0) {
      const sp = text.slice(a, m.start).search(/\s/);
      if (sp >= 0) a += sp + 1;
    }
    if (b < text.length) {
      const sp = text.slice(m.end, b).lastIndexOf(' ');
      if (sp > 10) b = m.end + sp;
    }
    const clean = (x: string) => x.replace(/\s+/g, ' ');
    return [
      (a > 0 ? '…' : '') + clean(text.slice(a, m.start)).trimStart(),
      h('mark', {}, clean(text.slice(m.start, m.end))),
      clean(text.slice(m.end, b)).trimEnd() + (b < text.length ? '…' : ''),
    ];
  }

  private pick(i: number): void {
    this.select(i);
    // On a phone the list covers the page: fold it so the hit is visible.
    if (narrow.matches) {
      this.listOpen = false;
      this.syncListVisibility();
    }
  }

  step(dir: number): void {
    if (!this.matches.length) return;
    const n = this.matches.length;
    this.select((((this.index < 0 ? 0 : this.index + dir) % n) + n) % n);
  }

  private select(i: number): void {
    const prev = this.matches[this.index];
    this.rows[this.index]?.classList.remove('current');
    this.index = i;
    this.reveal = true;
    this.updateCount();
    const row = this.rows[i];
    if (row) {
      row.classList.add('current');
      if (this.list.classList.contains('show')) row.scrollIntoView({ block: 'nearest' });
    }
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
