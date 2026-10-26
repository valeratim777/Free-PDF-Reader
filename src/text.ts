// Cached text content of pages (used by search, read-aloud and text export).
import type { DocPage } from './model';
import { pdfPage } from './pages';

export interface TextItemLite {
  str: string;
  hasEOL: boolean;
}

export interface PageText {
  items: TextItemLite[];
  /** Concatenated text; item i starts at offsets[i]. */
  text: string;
  offsets: number[];
}

type RawContent = { items: unknown[] };

const cache = new Map<string, Promise<{ raw: RawContent; page: PageText }>>();

function build(raw: RawContent): PageText {
  const items: TextItemLite[] = [];
  const offsets: number[] = [];
  let text = '';
  for (const it of raw.items as { str?: string; hasEOL?: boolean }[]) {
    if (typeof it.str !== 'string') continue;
    offsets.push(text.length);
    items.push({ str: it.str, hasEOL: !!it.hasEOL });
    text += it.str;
    if (it.hasEOL) text += '\n';
  }
  return { items, text, offsets };
}

function load(p: Pick<DocPage, 'src' | 'index'>) {
  const k = `${p.src}:${p.index}`;
  let c = cache.get(k);
  if (!c) {
    c = pdfPage(p.src, p.index)
      .then((pg) => pg.getTextContent())
      .then((raw) => ({ raw: raw as RawContent, page: build(raw as RawContent) }));
    cache.set(k, c);
    c.catch(() => cache.delete(k));
  }
  return c;
}

export async function pageText(p: Pick<DocPage, 'src' | 'index'>): Promise<PageText> {
  return (await load(p)).page;
}

/** The raw pdf.js text content (for building a text layer). */
export async function rawTextContent(p: Pick<DocPage, 'src' | 'index'>): Promise<RawContent> {
  return (await load(p)).raw;
}

export function clearText(): void {
  cache.clear();
}
