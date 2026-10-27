// "Reduce file size": pages are re-rendered as compressed pictures. Big savings
// for scans and photos; the trade-off (no selectable text) is stated up front.
import { store } from '../store';
import { busy, dialog, downloadBlob, field, h, select, toast } from '../ui/dom';
import { getLang, t } from '../i18n';
import { canShareFiles, exportPdf, loadExported, suggestedName } from './save';
import { isNativeApp, nativeShare } from './native';

const LEVELS = {
  strong: { dpi: 72, quality: 0.55 },
  medium: { dpi: 110, quality: 0.7 },
  light: { dpi: 150, quality: 0.82 },
};

function fmtSize(n: number): string {
  const mb = n / 1024 / 1024;
  const fmt = new Intl.NumberFormat(getLang(), { maximumFractionDigits: mb < 10 ? 1 : 0 });
  return mb >= 1 ? `${fmt.format(mb)} ${t('unitMB')}` : `${fmt.format(n / 1024)} ${t('unitKB')}`;
}

async function compress(bytes: Uint8Array, dpi: number, quality: number): Promise<Uint8Array> {
  // pdf.js takes ownership of the buffer it is given; keep the original for the size comparison.
  const pdf = await loadExported(bytes.slice());
  const pages = [];
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      busy(true, `${t('compressing')} ${i}/${pdf.numPages}`);
      const pg = await pdf.getPage(i);
      const unit = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: dpi / 72 });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      await pg.render({ canvas: c, viewport: vp, background: '#ffffff' }).promise;
      const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
      pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/jpeg', width: c.width, height: c.height, pt: { w: unit.width, h: unit.height } });
      c.width = 0;
      pg.cleanup();
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  const { imagesToPdf } = await import('../export/exporter');
  return imagesToPdf(pages);
}

export async function compressDialog(): Promise<void> {
  if (!store.isOpen) return;
  const level = select(
    [
      ['strong', t('compressStrong')],
      ['medium', t('compressMedium')],
      ['light', t('compressLight')],
    ],
    'medium',
  );
  const go = await dialog<boolean>({
    title: t('compressTitle'),
    body: h('div', {}, h('p', { style: 'margin-top:0' }, t('compressInfo')), field(t('compressLevel'), level)),
    actions: [
      { label: t('cancel'), value: false },
      { label: t('compressRun'), value: true, primary: true },
    ],
  });
  if (!go) return;
  const { dpi, quality } = LEVELS[level.value as keyof typeof LEVELS];
  let before: Uint8Array;
  let after: Uint8Array;
  busy(true, t('compressing'));
  try {
    before = await exportPdf({ noProtection: true });
    after = await compress(before, dpi, quality);
  } catch (e) {
    toast(t('errorSave', { msg: (e as Error).message }), 'error', 6000);
    return;
  } finally {
    busy(false);
  }
  if (after.length >= before.length * 0.95) {
    await dialog({
      title: t('compressTitle'),
      body: h('p', {}, t('compressNoGain', { size: fmtSize(before.length) })),
      actions: [{ label: t('ok'), value: true, primary: true }],
    });
    return;
  }
  const name = suggestedName('-compressed');
  const file = new File([after.slice()], name, { type: 'application/pdf' });
  const saved = Math.round((1 - after.length / before.length) * 100);
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
  await dialog<boolean>({
    title: t('compressTitle'),
    body: h(
      'div',
      {},
      h('p.compress-result', {}, `${fmtSize(before.length)} → `, h('b', {}, fmtSize(after.length)), ` (−${saved}%)`),
      store.protection ? h('p', { style: 'color:var(--muted)' }, t('compressNoPassword')) : null,
    ),
    actions: [
      { label: t('cancel'), value: false },
      ...(canShareFiles() ? [{ label: t('share'), value: share }] : []),
      { label: t('saveCopy'), value: () => (downloadBlob(file, name), true), primary: true },
    ],
  });
}
