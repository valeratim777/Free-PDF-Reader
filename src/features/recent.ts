// Recently opened files, kept on this device so they reopen with one tap at the
// page where reading stopped. Nothing leaves the device.
import { store } from '../store';
import { drawThumb } from '../ui/thumbs';

const DB = 'pdf-reader-recent';
const MAX_ITEMS = 10;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;

export interface RecentFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  /** Last page the reader was on (0-based). */
  page: number;
  openedAt: number;
  thumb: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      for (const s of ['meta', 'bytes']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** The entry of the document that is open now (null for new or merged documents). */
let currentId: string | null = null;
let pageTimer = 0;

export async function listRecent(): Promise<RecentFile[]> {
  try {
    const all = (await run<RecentFile[]>(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) ?? [];
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function recentBytes(id: string): Promise<Uint8Array | null> {
  try {
    return (await run<Uint8Array>(['bytes'], 'readonly', (t) => t.objectStore('bytes').get(id))) ?? null;
  } catch {
    return null;
  }
}

export async function removeRecent(id: string): Promise<void> {
  if (id === currentId) currentId = null;
  await run(['meta', 'bytes'], 'readwrite', (t) => {
    t.objectStore('meta').delete(id);
    t.objectStore('bytes').delete(id);
  }).catch(() => {});
}

export async function clearRecent(): Promise<void> {
  currentId = null;
  await run(['meta', 'bytes'], 'readwrite', (t) => {
    t.objectStore('meta').clear();
    t.objectStore('bytes').clear();
  }).catch(() => {});
}

async function thumbnail(): Promise<string> {
  const p = store.state.pages[0];
  if (!p) return '';
  try {
    const c = document.createElement('canvas');
    await drawThumb(p, c, 72);
    return c.toDataURL('image/jpeg', 0.7);
  } catch {
    return '';
  }
}

async function prune(): Promise<void> {
  const list = await listRecent();
  let total = 0;
  for (const [i, r] of list.entries()) {
    total += r.size;
    if (i >= MAX_ITEMS || total > MAX_TOTAL) await removeRecent(r.id);
  }
}

/**
 * Records the document that was just opened from a file and returns the page to
 * continue reading from (0 when it is new to the list).
 */
export async function rememberOpened(bytes: Uint8Array, name: string): Promise<number> {
  currentId = null;
  if (bytes.length > MAX_FILE) return 0;
  try {
    const list = await listRecent();
    const known = list.find((r) => r.name === name && r.size === bytes.length);
    const entry: RecentFile = {
      id: known?.id ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      size: bytes.length,
      pages: store.state.pages.length,
      page: known && known.page < store.state.pages.length ? known.page : 0,
      openedAt: Date.now(),
      thumb: (await thumbnail()) || known?.thumb || '',
    };
    await run(['meta', 'bytes'], 'readwrite', (t) => {
      t.objectStore('meta').put(entry, entry.id);
      if (!known) t.objectStore('bytes').put(bytes, entry.id);
    });
    currentId = entry.id;
    await prune();
    return entry.page;
  } catch (e) {
    console.warn('recent files', e);
    return 0;
  }
}

/** A restored session continues its entry when the file name matches. */
export async function resumeEntry(name: string): Promise<void> {
  currentId = (await listRecent()).find((r) => r.name === name)?.id ?? null;
}

export function forgetCurrent(): void {
  currentId = null;
}

/** The saved version replaces the stored copy, so reopening shows the edits. */
export async function noteSaved(bytes: Uint8Array, name: string): Promise<void> {
  const id = currentId;
  if (!id) return;
  if (bytes.length > MAX_FILE) {
    await removeRecent(id);
    return;
  }
  try {
    const meta = await run<RecentFile>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id));
    if (!meta) return;
    const next: RecentFile = { ...meta, name, size: bytes.length, pages: store.state.pages.length, openedAt: Date.now(), thumb: (await thumbnail()) || meta.thumb };
    await run(['meta', 'bytes'], 'readwrite', (t) => {
      t.objectStore('meta').put(next, id);
      t.objectStore('bytes').put(bytes, id);
    });
  } catch (e) {
    console.warn('recent files', e);
  }
}

/** Remembers the reading position (debounced). */
export function notePage(page: number): void {
  const id = currentId;
  if (!id) return;
  clearTimeout(pageTimer);
  pageTimer = window.setTimeout(async () => {
    try {
      const meta = await run<RecentFile>(['meta'], 'readonly', (t) => t.objectStore('meta').get(id));
      if (meta && meta.page !== page) await run(['meta'], 'readwrite', (t) => t.objectStore('meta').put({ ...meta, page }, id));
    } catch {
      /* ignore */
    }
  }, 800);
}
