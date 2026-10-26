// Keeps the open document and its edits in IndexedDB so work survives a closed
// tab or a mobile browser killing the page. Nothing leaves the device.
import { store } from '../store';
import type { Asset, DocState } from '../model';

const DB = 'pdf-reader';
const VERSION = 1;

interface SessionMeta {
  fileName: string;
  primary: string | null;
  state: DocState;
  sources: { id: string; name: string }[];
  assets: string[];
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of ['meta', 'sources', 'assets']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, storeName: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const savedSources = new Set<string>();
const savedAssets = new Set<string>();
let timer = 0;
let enabled = true;

export async function peekSession(): Promise<{ fileName: string; savedAt: number } | null> {
  try {
    const db = await open();
    const meta = await tx<SessionMeta>(db, 'meta', 'readonly', (s) => s.get('session'));
    db.close();
    return meta ? { fileName: meta.fileName, savedAt: meta.savedAt } : null;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  savedSources.clear();
  savedAssets.clear();
  try {
    const db = await open();
    for (const s of ['meta', 'sources', 'assets']) await tx(db, s, 'readwrite', (os) => os.clear());
    db.close();
  } catch {
    /* ignore */
  }
}

async function persist(): Promise<void> {
  if (!store.isOpen || !enabled) return;
  try {
    const db = await open();
    for (const src of store.sources.values()) {
      if (savedSources.has(src.id)) continue;
      await tx(db, 'sources', 'readwrite', (s) => s.put({ name: src.name, bytes: src.bytes }, src.id));
      savedSources.add(src.id);
    }
    for (const a of store.assets.values()) {
      if (savedAssets.has(a.id)) continue;
      const { url: _url, ...rest } = a;
      void _url;
      await tx(db, 'assets', 'readwrite', (s) => s.put(rest, a.id));
      savedAssets.add(a.id);
    }
    const meta: SessionMeta = {
      fileName: store.fileName,
      primary: store.primary,
      state: store.state,
      sources: [...store.sources.values()].map((s) => ({ id: s.id, name: s.name })),
      assets: [...store.assets.keys()],
      savedAt: Date.now(),
    };
    await tx(db, 'meta', 'readwrite', (s) => s.put(meta, 'session'));
    db.close();
  } catch (e) {
    console.warn('session save failed', e);
  }
}

export async function flushSession(): Promise<void> {
  clearTimeout(timer);
  await persist();
}

export function scheduleSessionSave(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => void persist(), 1200);
}

/** A new document replaces the stored session. */
export async function startSession(): Promise<void> {
  await clearSession();
  scheduleSessionSave();
}

export interface RestoredSession {
  fileName: string;
  primary: string | null;
  state: DocState;
  sources: { id: string; name: string; bytes: Uint8Array }[];
  assets: Omit<Asset, 'url'>[];
}

export async function loadSession(): Promise<RestoredSession | null> {
  try {
    const db = await open();
    const meta = await tx<SessionMeta>(db, 'meta', 'readonly', (s) => s.get('session'));
    if (!meta) return null;
    const sources = [];
    for (const s of meta.sources) {
      const rec = await tx<{ name: string; bytes: Uint8Array }>(db, 'sources', 'readonly', (os) => os.get(s.id));
      if (rec) sources.push({ id: s.id, name: rec.name, bytes: rec.bytes });
    }
    const assets = [];
    for (const id of meta.assets) {
      const rec = await tx<Omit<Asset, 'url'>>(db, 'assets', 'readonly', (os) => os.get(id));
      if (rec) assets.push(rec);
    }
    db.close();
    return { fileName: meta.fileName, primary: meta.primary, state: meta.state, sources, assets };
  } catch (e) {
    console.warn('session load failed', e);
    return null;
  }
}

export function markRestored(sourceIds: string[], assetIds: string[]): void {
  sourceIds.forEach((id) => savedSources.add(id));
  assetIds.forEach((id) => savedAssets.add(id));
}

export function setSessionEnabled(on: boolean): void {
  enabled = on;
}
