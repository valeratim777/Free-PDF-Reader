// Printing and exporting pages as images or text.
import { zipSync } from 'fflate';
import { store } from '../store';
import { exportPdf, loadExported, share, suggestedName } from './save';
import { isNativeApp } from './native';
import { pageText } from '../text';
import { busy, dialog, downloadBlob, field, h, select, toast } from '../ui/dom';
import { t } from '../i18n';

async function renderPages(bytes: Uint8Array, pages: number[], dpi: number, mime: string, quality = 0.92): Promise<Blob[]> {
  const pdf = await loadExported(bytes);
  const out: Blob[] = [];
  try {
    for (const n of pages) {
      const page = await pdf.getPage(n + 1);
      const vp = page.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas');
      const maxPx = 40_000_000;
      const k = Math.min(1, Math.sqrt(maxPx / (vp.width * vp.height)));
      const v2 = k < 1 ? page.getViewport({ scale: (dpi / 72) * k }) : vp;
      c.width = Math.ceil(v2.width);
      c.height = Math.ceil(v2.height);
      await page.render({ canvas: c, viewport: v2, background: '#ffffff' }).promise;
      out.push(await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), mime, quality)));
      c.width = 0;
      page.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

export async function printDocument(): Promise<void> {
  if (!store.isOpen) return;
  // Android's WebView has no print dialog; the share sheet offers "Print" instead.
  if (isNativeApp()) {
    toast(t('printViaShare'));
    return share();
  }
  busy(true, t('loading'));
  const root = document.getElementById('print-root')!;
  const urls: string[] = [];
  try {
    const bytes = await exportPdf({ noProtection: true });
    const blobs = await renderPages(bytes, store.state.pages.map((_, i) => i), 150, 'image/jpeg', 0.95);
    root.replaceChildren();
    for (const b of blobs) {
      const url = URL.createObjectURL(b);
      urls.push(url);
      root.append(h('div.print-page', {}, h('img', { src: url, alt: '' })));
    }
    await Promise.all(Array.from(root.querySelectorAll('img')).map((img) => img.decode().catch(() => {})));
  } catch (e) {
    toast(String((e as Error).message), 'error');
    return;
  } finally {
    busy(false);
  }
  const cleanup = () => {
    root.replaceChildren();
    urls.forEach((u) => URL.revokeObjectURL(u));
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

export async function exportImagesDialog(current: number): Promise<void> {
  if (!store.isOpen) return;
  const fmt = select(
    [
      ['image/png', 'PNG'],
      ['image/jpeg', 'JPEG'],
    ],
    'image/png',
  );
  const dpi = select(
    [
      ['72', '72'],
      ['150', '150'],
      ['300', '300'],
    ],
    '150',
  );
  const range = select(
    [
      ['current', t('currentPage')],
      ['all', t('allPages')],
    ],
    'current',
  );
  const ok = await dialog<boolean>({
    title: t('exportImages'),
    body: h('div', {}, field(t('format'), fmt), field(t('resolution'), dpi), field(t('pages'), range)),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('download'), value: true, primary: true },
    ],
  });
  if (!ok) return;
  busy(true);
  try {
    const bytes = await exportPdf({ noProtection: true });
    const pages = range.value === 'all' ? store.state.pages.map((_, i) => i) : [current];
    const blobs = await renderPages(bytes, pages, +dpi.value, fmt.value);
    const ext = fmt.value === 'image/png' ? 'png' : 'jpg';
    const base = suggestedName().replace(/\.pdf$/i, '');
    if (blobs.length === 1) {
      downloadBlob(blobs[0], `${base}-${pages[0] + 1}.${ext}`);
    } else {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < blobs.length; i++) files[`${base}-${pages[i] + 1}.${ext}`] = new Uint8Array(await blobs[i].arrayBuffer());
      const zip = zipSync(files, { level: 0 });
      downloadBlob(new Blob([zip.slice()], { type: 'application/zip' }), `${base}-images.zip`);
    }
  } catch (e) {
    toast(String((e as Error).message), 'error');
  } finally {
    busy(false);
  }
}

export async function exportText(): Promise<void> {
  if (!store.isOpen) return;
  busy(true);
  try {
    const parts: string[] = [];
    for (let i = 0; i < store.state.pages.length; i++) {
      const pt = await pageText(store.state.pages[i]);
      parts.push(`--- ${t('page')} ${i + 1} ---\n${pt.text.trim()}\n`);
    }
    downloadBlob(new Blob([parts.join('\n')], { type: 'text/plain;charset=utf-8' }), suggestedName().replace(/\.pdf$/i, '.txt'));
  } finally {
    busy(false);
  }
}
