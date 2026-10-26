// Loading documents into the store: opening, inserting/merging, creating new ones.
import { store, type Source } from '../store';
import { emptyState, uid, type Asset, type DocPage, type DocState } from '../model';
import { loadPdf, PasswordCancelled } from '../pdfjs';
import { clearPages, measureSource, pageInfo } from '../pages';
import { clearText } from '../text';
import { clearThumbs } from '../ui/thumbs';
import { promptDialog } from '../ui/dom';
import { t } from '../i18n';

export class NotPdfError extends Error {}

async function askPassword(retry: boolean): Promise<string | null> {
  return promptDialog(t('passwordRequired'), retry ? t('passwordWrong') : t('enterPassword'), '', 'password', t('openAction'));
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  return head.includes('%PDF');
}

/** Loads bytes as a new source. Returns null if the user cancelled a password prompt. */
export async function addSource(bytes: Uint8Array, name: string, id = uid('s')): Promise<Source | null> {
  if (!looksLikePdf(bytes)) throw new NotPdfError(t('notPdf'));
  let loaded;
  try {
    loaded = await loadPdf(bytes, askPassword);
  } catch (e) {
    if (e instanceof PasswordCancelled) return null;
    throw e;
  }
  const src: Source = { id, name, bytes, password: loaded.password, pdf: loaded.pdf };
  store.sources.set(src.id, src);
  await measureSource(src);
  return src;
}

export function pagesOf(src: Source): DocPage[] {
  return Array.from({ length: src.pdf.numPages }, (_, index) => ({ id: uid('p'), src: src.id, index, rot: 0 as const }));
}

/** Replaces the current document. */
export async function openBytes(bytes: Uint8Array, name: string, handle: FileSystemFileHandle | null = null, state?: DocState): Promise<boolean> {
  store.reset();
  clearPages();
  clearText();
  clearThumbs();
  const src = await addSource(bytes, name);
  if (!src) return false;
  store.primary = src.id;
  store.fileName = name;
  store.fileHandle = handle;
  store.state = state ?? { ...emptyState(), pages: pagesOf(src) };
  store.dirty = false;
  store.emit({ kind: 'all' });
  return true;
}

/** Inserts all pages of another PDF at `at` (default: end). Undoable. */
export async function insertBytes(bytes: Uint8Array, name: string, at?: number): Promise<number> {
  const src = await addSource(bytes, name);
  if (!src) return 0;
  const pages = pagesOf(src);
  store.commit('pages', (s) => s.pages.splice(at ?? s.pages.length, 0, ...pages));
  return pages.length;
}

export async function fileBytes(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** Decodes any browser-supported image into PNG or JPEG bytes plus its size. */
export async function imageToAsset(blob: Blob): Promise<Omit<Asset, 'id' | 'url'>> {
  const bmp = await createImageBitmap(blob);
  const width = bmp.width;
  const height = bmp.height;
  if (blob.type === 'image/jpeg' || blob.type === 'image/png') {
    bmp.close();
    return { mime: blob.type, bytes: await fileBytes(blob), width, height };
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  const png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
  return { mime: 'image/png', bytes: await fileBytes(png), width, height };
}

export function registerAsset(a: Omit<Asset, 'id' | 'url'>, id = uid('img')): Asset {
  const asset: Asset = { ...a, id, url: URL.createObjectURL(new Blob([a.bytes.slice()], { type: a.mime })) };
  store.assets.set(asset.id, asset);
  return asset;
}

export async function imagesToPdfBytes(files: Blob[]): Promise<Uint8Array> {
  const { imagesToPdf } = await import('../export/exporter');
  const images = [];
  for (const f of files) images.push(await imageToAsset(f));
  return imagesToPdf(images);
}

export async function blankPdfBytes(w?: number, h?: number, count = 1): Promise<Uint8Array> {
  const { blankPdf } = await import('../export/exporter');
  return blankPdf(w, h, count);
}

export function pageSizeOf(p: DocPage): { w: number; h: number } {
  const i = pageInfo(p);
  return { w: i.width, h: i.height };
}
