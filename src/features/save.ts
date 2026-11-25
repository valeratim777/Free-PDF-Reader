// Producing the final PDF and getting it to the user (file, download or share sheet).
import { store } from '../store';
import { pdfjs, docOptions } from '../pdfjs';
import { pageInfo } from '../pages';
import type { Rect } from '../model';
import { busy, downloadBlob, toast } from '../ui/dom';
import { isNativeApp, nativeSaveAs, nativeShare, nativeWriteBack, saveToDocuments } from './native';
import { noteSaved } from './recent';
import { t } from '../i18n';

export interface SaveOptions {
  flattenForms?: boolean;
  /** Skip password protection (e.g. for printing). */
  noProtection?: boolean;
}

/** Renders pages of a finished PDF as images with the given areas painted black (true redaction). */
function makeRasterizer() {
  let cached: { bytes: Uint8Array; doc: Promise<Awaited<ReturnType<typeof loadExported>>> } | null = null;
  const rasterize = async (bytes: Uint8Array, pageIndex: number, rects: Rect[]): Promise<{ bytes: Uint8Array; mime: 'image/jpeg' }> => {
    if (!cached || cached.bytes !== bytes) {
      if (cached) void (await cached.doc).loadingTask.destroy();
      cached = { bytes, doc: loadExported(bytes.slice()) };
    }
    const page = await (await cached.doc).getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 2, rotation: 0 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvas, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE, background: '#ffffff' }).promise;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    for (const r of rects) {
      const [x1, y1] = vp.convertToViewportPoint(r.x1, r.y1);
      const [x2, y2] = vp.convertToViewportPoint(r.x2, r.y2);
      ctx.fillRect(Math.min(x1, x2) - 1, Math.min(y1, y2) - 1, Math.abs(x2 - x1) + 2, Math.abs(y2 - y1) + 2);
    }
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', 0.92));
    canvas.width = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg' };
  };
  const dispose = async () => {
    if (cached) await (await cached.doc).loadingTask.destroy();
    cached = null;
  };
  return { rasterize, dispose };
}

export async function exportPdf(opts: SaveOptions = {}): Promise<Uint8Array> {
  const { buildPdf } = await import('../export/exporter');
  const raster = makeRasterizer();
  try {
    return await buildPdf(
      {
        state: store.state,
        sources: store.sources,
        primary: store.primary,
        assets: store.assets,
        pageInfo: (p) => pageInfo(p),
      },
      {
        flattenForms: opts.flattenForms,
        protection: opts.noProtection ? null : store.protection,
        rasterize: raster.rasterize,
        producer: 'PDF Reader',
      },
    );
  } finally {
    await raster.dispose();
  }
}

export function suggestedName(suffix = ''): string {
  let name = store.fileName || t('untitled');
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return suffix ? name.replace(/\.pdf$/i, `${suffix}.pdf`) : name;
}

type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

function savePicker(): SavePicker | null {
  return (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker ?? null;
}

async function writeHandle(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const w = await (handle as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  await w.write(bytes.slice().buffer);
  await w.close();
}

/**
 * Asks where to save and writes the file. 'cancelled' when the user closed the dialog,
 * 'unavailable' when the browser refused to show it (embedded pages) so a download is used instead.
 */
async function pickAndWrite(picker: SavePicker, bytes: Uint8Array): Promise<'saved' | 'cancelled' | 'unavailable'> {
  busy(false);
  let h: FileSystemFileHandle;
  try {
    h = await picker({ suggestedName: suggestedName(), types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
  } catch (e) {
    return (e as Error).name === 'AbortError' ? 'cancelled' : 'unavailable';
  }
  busy(true, t('saving'));
  await writeHandle(h, bytes);
  store.fileHandle = h;
  store.fileName = h.name;
  return 'saved';
}

/**
 * Android: back into the opened file when the app may write there; otherwise the
 * system asks where to save (and later saves go to that file).
 */
async function saveNative(bytes: Uint8Array, asNew: boolean): Promise<'saved' | 'cancelled'> {
  const blob = new Blob([bytes.slice()], { type: 'application/pdf' });
  const doc = store.nativeDoc;
  if (!asNew && doc?.writable) {
    try {
      await nativeWriteBack(doc.uri, blob, suggestedName());
      return 'saved';
    } catch (e) {
      // E.g. the file was moved or the app lost access: ask where to save instead.
      console.warn('write back', e);
    }
  }
  let r: { uri: string; name: string } | null;
  try {
    r = await nativeSaveAs(blob, suggestedName(), 'application/pdf');
  } catch (e) {
    console.warn('save picker', e);
    const path = await saveToDocuments(blob, suggestedName());
    if (path) toast(t('savedTo', { path }), 'success', 5000);
    return path ? 'saved' : 'cancelled';
  }
  if (!r) return 'cancelled';
  store.nativeDoc = { uri: r.uri, writable: true };
  store.fileName = /\.pdf$/i.test(r.name) ? r.name : `${r.name}.pdf`;
  return 'saved';
}

/** Save: back to the opened file when possible; otherwise ask where (desktop) or download. */
export async function save(asNew = false): Promise<boolean> {
  if (!store.isOpen) {
    toast(t('nothingToSave'));
    return false;
  }
  busy(true, t('saving'));
  try {
    const bytes = await exportPdf();
    const picker = savePicker();
    const handle = store.fileHandle;
    if (isNativeApp()) {
      if ((await saveNative(bytes, asNew)) === 'cancelled') return false;
    } else if (!asNew && handle && 'createWritable' in handle) {
      await writeHandle(handle, bytes);
    } else {
      const r = picker ? await pickAndWrite(picker, bytes) : 'unavailable';
      if (r === 'cancelled') return false;
      if (r === 'unavailable') downloadBlob(new Blob([bytes.slice()], { type: 'application/pdf' }), suggestedName());
    }
    void noteSaved(bytes, store.fileName);
    store.dirty = false;
    store.emit({ kind: 'doc' });
    toast(t('saved'), 'success');
    return true;
  } catch (e) {
    console.error(e);
    toast(t('errorSave', { msg: (e as Error).message }), 'error', 6000);
    return false;
  } finally {
    busy(false);
  }
}

export async function download(): Promise<void> {
  if (!store.isOpen) return;
  busy(true, t('saving'));
  try {
    const bytes = await exportPdf();
    downloadBlob(new Blob([bytes.slice()], { type: 'application/pdf' }), suggestedName());
    void noteSaved(bytes, store.fileName);
    store.dirty = false;
    store.emit({ kind: 'doc' });
  } catch (e) {
    toast(t('errorSave', { msg: (e as Error).message }), 'error', 6000);
  } finally {
    busy(false);
  }
}

export function canShareFiles(): boolean {
  if (isNativeApp()) return true;
  try {
    const f = new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' });
    return !!navigator.canShare?.({ files: [f] });
  } catch {
    return false;
  }
}

export async function share(): Promise<void> {
  if (!store.isOpen) return;
  busy(true, t('saving'));
  let file: File;
  let bytes: Uint8Array;
  try {
    bytes = await exportPdf();
    file = new File([bytes.slice()], suggestedName(), { type: 'application/pdf' });
  } catch (e) {
    toast(t('errorSave', { msg: (e as Error).message }), 'error');
    return;
  } finally {
    busy(false);
  }
  try {
    if (isNativeApp()) await nativeShare(file, file.name);
    else await navigator.share({ files: [file], title: file.name });
    void noteSaved(bytes, store.fileName);
    store.dirty = false;
    store.emit({ kind: 'doc' });
  } catch (e) {
    if ((e as Error).name !== 'AbortError') downloadBlob(file, file.name);
  }
}

/** Loads exported bytes back with pdf.js (used for printing and image export). */
export async function loadExported(bytes: Uint8Array) {
  return pdfjs.getDocument({ ...docOptions(), data: bytes }).promise;
}
