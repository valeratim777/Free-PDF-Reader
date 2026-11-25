// Loading documents into the store: opening, inserting/merging, creating new ones.
import { store, type Source } from '../store';
import { emptyState, uid, type Asset, type DocPage, type DocState } from '../model';
import { loadPdf, PasswordCancelled } from '../pdfjs';
import { clearPages, measureSource, pageInfo } from '../pages';
import { clearText } from '../text';
import { clearThumbs } from '../ui/thumbs';
import { promptDialog } from '../ui/dom';
import { t } from '../i18n';
import { jpegInfo, orientContext, swapsSides } from '../exif';

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

/** Longest side a picture keeps when it has to be re-encoded (enough for printing a full page). */
const MAX_SIDE = 4000;

function sniff(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

/**
 * Decodes any browser-supported image into PNG or JPEG bytes plus its size. Photos are
 * turned upright as the camera intended (EXIF orientation), and very large ones are
 * scaled down so the PDF stays a sensible size.
 */
export async function imageToAsset(blob: Blob): Promise<Omit<Asset, 'id' | 'url'>> {
  const bytes = await fileBytes(blob);
  const kind = sniff(bytes);
  const info = kind === 'image/jpeg' ? jpegInfo(bytes) : null;
  const orientation = info?.orientation ?? 1;
  const bmp = await createImageBitmap(blob);
  // Current browsers already turn the picture when decoding; older ones show the stored pixels.
  const turned = !info || !swapsSides(orientation) || info.width === info.height || !(bmp.width === info.width && bmp.height === info.height);
  const width = !turned ? bmp.height : bmp.width;
  const height = !turned ? bmp.width : bmp.height;
  if (kind && orientation === 1 && Math.max(width, height) <= MAX_SIDE) {
    bmp.close();
    return { mime: kind, bytes, width, height };
  }
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width * k));
  c.height = Math.max(1, Math.round(height * k));
  const ctx = c.getContext('2d')!;
  ctx.scale(c.width / width, c.height / height);
  if (!turned) orientContext(ctx, orientation, width, height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const mime = kind === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const out = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), mime, 0.9));
  c.width = 0;
  return { mime, bytes: await fileBytes(out), width: Math.round(width * k), height: Math.round(height * k) };
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
