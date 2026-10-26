import type { PDFDocumentProxy } from './pdfjs';
import { emptyState, type Annotation, type Asset, type DocPage, type DocState } from './model';

export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  password?: string;
  pdf: PDFDocumentProxy;
}

export interface Protection {
  userPassword: string;
  ownerPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowEdit: boolean;
}

export type ChangeKind = 'pages' | 'anns' | 'form' | 'doc' | 'all';

export interface ChangeDetail {
  kind: ChangeKind;
  /** Page ids whose annotations changed (only for kind 'anns'). */
  pageIds?: string[];
  fromHistory?: boolean;
}

const HISTORY_LIMIT = 150;

/** Holds the open document and the undo/redo history. */
export class Store extends EventTarget {
  state: DocState = emptyState();
  past: DocState[] = [];
  future: DocState[] = [];
  sources = new Map<string, Source>();
  assets = new Map<string, Asset>();
  primary: string | null = null;
  fileName = '';
  fileHandle: FileSystemFileHandle | null = null;
  protection: Protection | null = null;
  dirty = false;
  private transientBase: DocState | null = null;

  get isOpen(): boolean {
    return this.state.pages.length > 0;
  }

  reset(): void {
    for (const s of this.sources.values()) s.pdf.loadingTask.destroy().catch(() => {});
    for (const a of this.assets.values()) URL.revokeObjectURL(a.url);
    this.state = emptyState();
    this.past = [];
    this.future = [];
    this.sources.clear();
    this.assets.clear();
    this.primary = null;
    this.fileName = '';
    this.fileHandle = null;
    this.protection = null;
    this.dirty = false;
    this.transientBase = null;
    this.emit({ kind: 'all' });
  }

  emit(detail: ChangeDetail): void {
    this.dispatchEvent(new CustomEvent<ChangeDetail>('change', { detail }));
  }

  onChange(fn: (d: ChangeDetail) => void): void {
    this.addEventListener('change', (e) => fn((e as CustomEvent<ChangeDetail>).detail));
  }

  /** Applies an undoable change. */
  commit(kind: ChangeKind, fn: (s: DocState) => void, pageIds?: string[]): void {
    this.endTransient();
    this.pushHistory(structuredClone(this.state));
    fn(this.state);
    this.dirty = true;
    this.emit({ kind, pageIds });
  }

  /** Starts a gesture (drag, resize…) whose intermediate updates are not recorded individually. */
  beginTransient(): void {
    if (!this.transientBase) this.transientBase = structuredClone(this.state);
  }

  updateTransient(kind: ChangeKind, fn: (s: DocState) => void, pageIds?: string[]): void {
    this.beginTransient();
    fn(this.state);
    this.emit({ kind, pageIds });
  }

  endTransient(): void {
    if (!this.transientBase) return;
    const base = this.transientBase;
    this.transientBase = null;
    if (JSON.stringify(base) !== JSON.stringify(this.state)) {
      this.pushHistory(base);
      this.dirty = true;
    }
  }

  cancelTransient(): void {
    if (!this.transientBase) return;
    this.state = this.transientBase;
    this.transientBase = null;
    this.emit({ kind: 'all' });
  }

  private pushHistory(s: DocState): void {
    this.past.push(s);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  undo(): void {
    this.endTransient();
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state);
    this.state = prev;
    this.dirty = true;
    this.emit({ kind: 'all', fromHistory: true });
  }

  redo(): void {
    this.endTransient();
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state);
    this.state = next;
    this.dirty = true;
    this.emit({ kind: 'all', fromHistory: true });
  }

  // ---- convenience helpers ----

  page(id: string): DocPage | undefined {
    return this.state.pages.find((p) => p.id === id);
  }

  pageIndex(id: string): number {
    return this.state.pages.findIndex((p) => p.id === id);
  }

  ann(id: string): Annotation | undefined {
    return this.state.anns.find((a) => a.id === id);
  }

  annsOf(pageId: string): Annotation[] {
    return this.state.anns.filter((a) => a.pageId === pageId);
  }

  addAnn(a: Annotation): void {
    this.commit('anns', (s) => s.anns.push(a), [a.pageId]);
  }

  replaceAnn(a: Annotation, transient = false): void {
    const fn = (s: DocState) => {
      const i = s.anns.findIndex((x) => x.id === a.id);
      if (i >= 0) s.anns[i] = a;
    };
    if (transient) this.updateTransient('anns', fn, [a.pageId]);
    else this.commit('anns', fn, [a.pageId]);
  }

  removeAnns(ids: string[]): void {
    const pages = this.state.anns.filter((a) => ids.includes(a.id)).map((a) => a.pageId);
    if (!pages.length) return;
    this.commit('anns', (s) => (s.anns = s.anns.filter((a) => !ids.includes(a.id))), pages);
  }

  source(id: string): Source {
    const s = this.sources.get(id);
    if (!s) throw new Error(`Unknown source ${id}`);
    return s;
  }
}

export const store = new Store();
