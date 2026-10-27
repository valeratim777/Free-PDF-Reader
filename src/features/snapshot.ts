// "Snapshot": a dragged area of a page, with everything drawn on it, as a picture
// to copy, save or send.
import { store } from '../store';
import { pageInfo } from '../pages';
import type { Rect } from '../model';
import { busy, dialog, downloadBlob, h, toast } from '../ui/dom';
import { t } from '../i18n';
import { canShareFiles, loadExported, suggestedName } from './save';
import { isNativeApp, nativeShare } from './native';

/** Longest side of the picture in pixels; small areas are rendered sharper. */
const MAX_SIDE = 3000;
const MAX_SCALE = 4;

async function renderArea(pageId: string, rect: Rect): Promise<Blob> {
  const idx = store.pageIndex(pageId);
  const page = store.page(pageId);
  if (!page) throw new Error('page');
  const { buildPdf } = await import('../export/exporter');
  const st = store.state;
  // Only this page is written, so the snapshot is quick even in long documents.
  const state = {
    ...st,
    pages: [page],
    anns: st.anns.filter((a) => a.pageId === pageId),
    numbering: st.numbering ? { ...st.numbering, start: st.numbering.start + idx } : null,
  };
  const bytes = await buildPdf({ state, sources: store.sources, primary: store.primary, assets: store.assets, pageInfo: (p) => pageInfo(p) });
  const pdf = await loadExported(bytes);
  try {
    const pg = await pdf.getPage(1);
    const unit = pg.getViewport({ scale: 1 });
    const [ax, ay] = unit.convertToViewportPoint(rect.x1, rect.y1);
    const [bx, by] = unit.convertToViewportPoint(rect.x2, rect.y2);
    const w = Math.abs(bx - ax);
    const hh = Math.abs(by - ay);
    const scale = Math.max(1, Math.min(MAX_SCALE, MAX_SIDE / Math.max(w, hh)));
    const vp = pg.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(hh * scale));
    await pg.render({
      canvas,
      viewport: vp,
      transform: [1, 0, 0, 1, -Math.min(ax, bx) * scale, -Math.min(ay, by) * scale],
      background: '#ffffff',
    }).promise;
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
    canvas.width = 0;
    return blob;
  } finally {
    await pdf.loadingTask.destroy();
  }
}

function canCopyImage(): boolean {
  return !!navigator.clipboard?.write && typeof ClipboardItem !== 'undefined';
}

export async function takeSnapshot(pageId: string, rect: Rect): Promise<void> {
  busy(true);
  let blob: Blob;
  try {
    blob = await renderArea(pageId, rect);
  } catch (e) {
    toast(String((e as Error).message), 'error');
    return;
  } finally {
    busy(false);
  }
  const name = `${suggestedName().replace(/\.pdf$/i, '')}-${t('page').toLowerCase()}${store.pageIndex(pageId) + 1}.png`;
  const url = URL.createObjectURL(blob);
  const file = new File([blob], name, { type: 'image/png' });
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(t('snapshotCopied'), 'success');
      return true;
    } catch {
      toast(t('snapshotCopyFailed'), 'error');
      return undefined;
    }
  };
  const share = async () => {
    try {
      if (isNativeApp()) await nativeShare(file, name);
      else await navigator.share({ files: [file], title: name });
      return true;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(String((e as Error).message), 'error');
      return undefined;
    }
  };
  const actions = [
    ...(canShareFiles() ? [{ label: t('share'), value: share }] : []),
    { label: t('saveImage'), value: () => (downloadBlob(blob, name), true) },
    ...(canCopyImage() ? [{ label: t('copyImage'), value: copy, primary: true }] : []),
  ];
  if (!actions.some((a) => 'primary' in a)) Object.assign(actions[actions.length - 1], { primary: true });
  await dialog<boolean>({
    title: t('toolSnapshot'),
    body: h('div.snapshot-preview', {}, h('img', { src: url, alt: t('toolSnapshot') })),
    actions,
    wide: true,
  });
  URL.revokeObjectURL(url);
}
