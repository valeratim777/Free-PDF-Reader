// Lets people using the installed apps (Windows, Android) know when a newer
// version has been published, with a direct link to the matching download.
// Only the public release list is fetched; nothing about the user is sent.
import { Download, X } from 'lucide';
import { h, icon, toast } from '../ui/dom';
import { t } from '../i18n';
import { desktopBridge, isNativeApp, openExternal } from './native';

export const APP_VERSION = __APP_VERSION__;
const REPO = 'valeratim777/Free-PDF-Reader';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 12 * 60 * 60 * 1000;

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
}

/** True for the Windows/desktop and Android apps; the web version updates by itself. */
export function isInstalledApp(): boolean {
  return isNativeApp() || !!desktopBridge();
}

/** True when version `a` is newer than `b` ("1.10.0" > "1.9.2"). */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

function stored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** The file to download for this installation, or the release page. */
async function downloadUrl(rel: Release): Promise<string> {
  let pattern: RegExp | null = null;
  if (isNativeApp()) pattern = /\.apk$/i;
  else {
    const info = await desktopBridge()
      ?.appInfo?.()
      .catch(() => null);
    if (info?.platform === 'win32') pattern = info.portable ? /portable\.exe$/i : /setup.*\.exe$/i;
  }
  const asset = pattern ? rel.assets.find((a) => pattern!.test(a.name)) : undefined;
  return asset?.browser_download_url ?? rel.html_url;
}

function showBanner(version: string, url: string): void {
  document.querySelector('.update-banner')?.remove();
  const bar = h(
    'div.update-banner',
    { role: 'status' },
    icon(Download, 20),
    h('span.update-text', {}, t('updateAvailable', { v: version })),
    h(
      'button.btn.btn-primary.btn-small',
      {
        type: 'button',
        onclick: () => {
          openExternal(url);
          bar.remove();
        },
      },
      t('updateDownload'),
    ),
    h(
      'button.icon-btn',
      {
        type: 'button',
        title: t('close'),
        'aria-label': t('close'),
        onclick: () => {
          store('pr.updateDismissed', version);
          bar.remove();
        },
      },
      icon(X, 16),
    ),
  );
  document.body.append(bar);
}

/**
 * Looks for a newer release. Automatic checks run in the installed apps at most
 * twice a day and stay quiet unless there is something new.
 */
export async function checkForUpdates(manual = false): Promise<void> {
  if (!manual) {
    if (!isInstalledApp()) return;
    if (Date.now() - (parseInt(stored('pr.updateChecked'), 10) || 0) < CHECK_EVERY) return;
  }
  let rel: Release;
  try {
    const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rel = (await res.json()) as Release;
    store('pr.updateChecked', String(Date.now()));
  } catch {
    if (manual) toast(t('updateCheckFailed'), 'error');
    return;
  }
  const version = rel.tag_name.replace(/^v/i, '');
  if (!isNewer(version, APP_VERSION)) {
    if (manual) toast(t('upToDate', { v: APP_VERSION }), 'success');
    return;
  }
  if (!manual && stored('pr.updateDismissed') === version) return;
  showBanner(version, await downloadUrl(rel));
}
