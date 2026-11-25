// The reader's own bookmarks: pages marked to come back to later. They are kept on
// this device for each file (by name and page count) and are not written into the PDF.
import { store } from '../store';

const KEY = 'pr.bookmarks';
const MAX_FILES = 100;

interface Saved {
  /** Page numbers in the original file (0-based), so reordering pages keeps them right. */
  pages: number[];
  at: number;
}

function load(): Record<string, Saved> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function persist(all: Record<string, Saved>): void {
  const keys = Object.keys(all).sort((a, b) => all[b].at - all[a].at);
  for (const k of keys.slice(MAX_FILES)) delete all[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage full or blocked */
  }
}

function docKey(): string | null {
  const src = store.primary ? store.sources.get(store.primary) : undefined;
  return src ? `${src.name}|${src.pdf.numPages}` : null;
}

/** Positions (0-based, in the document as it is now) of the bookmarked pages, in order. */
export function bookmarkedPages(): number[] {
  const key = docKey();
  const saved = key ? load()[key] : undefined;
  if (!saved) return [];
  const want = new Set(saved.pages);
  const out: number[] = [];
  store.state.pages.forEach((p, i) => {
    if (p.src === store.primary && want.has(p.index)) out.push(i);
  });
  return out;
}

export function isBookmarked(pos: number): boolean {
  return bookmarkedPages().includes(pos);
}

/** Adds or removes the bookmark of a page; returns whether it is bookmarked now. Pages from other files cannot be. */
export function toggleBookmark(pos: number): boolean | null {
  const key = docKey();
  const p = store.state.pages[pos];
  if (!key || !p || p.src !== store.primary) return null;
  const all = load();
  const list = new Set(all[key]?.pages ?? []);
  const on = !list.has(p.index);
  if (on) list.add(p.index);
  else list.delete(p.index);
  if (list.size) all[key] = { pages: [...list].sort((a, b) => a - b), at: Date.now() };
  else delete all[key];
  persist(all);
  return on;
}
