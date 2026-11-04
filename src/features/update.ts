// Lets people using the installed apps (Windows, Android) know when a newer
// version has been published. The Windows installer version and the Android app
// update themselves in place with one button: the new installer / .apk is
// downloaded from the project's releases, checked against the checksum GitHub
// publishes, and installed over the current app. The portable .exe and the Mac
// app get a direct link to the matching download instead.
// Only the public release list is fetched; nothing about the user is sent.
import { Download, X } from 'lucide';
import { h, icon, toast } from '../ui/dom';
import { t } from '../i18n';
import { store as doc } from '../store';
import { desktopBridge, isNativeApp, openExternal } from './native';
import { flushSession } from './session';

export const APP_VERSION = __APP_VERSION__;
const REPO = 'valeratim777/Free-PDF-Reader';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CHECK_EVERY = 12 * 60 * 60 * 1000;

interface Asset {
  name: string;
  browser_download_url: string;
  /** "sha256:…", published by GitHub for release files. */
  digest?: string | null;
}

interface Release {
  tag_name: string;
  html_url: string;
  assets: Asset[];
}

interface AndroidUpdater {
  install(o: { url: string; sha256: string }): Promise<void>;
  addListener(event: 'progress', cb: (p: { loaded: number; total: number }) => void): Promise<{ remove(): Promise<void> }>;
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

/** Hex SHA-256 from GitHub's "sha256:…" digest, or '' when there is none. */
export function sha256Of(asset: Pick<Asset, 'digest'>): string {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '');
  return m ? m[1].toLowerCase() : '';
}

type Install = (onProgress: (fraction: number) => void) => Promise<void>;

/** The file for this installation (or the release page) and, where possible, how to install it in place. */
async function updatePlan(rel: Release): Promise<{ url: string; install: Install | null }> {
  let pattern: RegExp | null = null;
  let canInstall = false;
  const desktop = desktopBridge();
  if (isNativeApp()) {
    pattern = /\.apk$/i;
    canInstall = true;
  } else {
    const info = await desktop?.appInfo?.().catch(() => null);
    if (info?.platform === 'win32') {
      pattern = info.portable ? /portable\.exe$/i : /setup.*\.exe$/i;
      canInstall = !info.portable && !!desktop?.installUpdate;
    } else if (info?.platform === 'darwin') pattern = /\.dmg$/i;
  }
  const asset = pattern ? rel.assets.find((a) => pattern!.test(a.name)) : undefined;
  if (!asset) return { url: rel.html_url, install: null };
  const url = asset.browser_download_url;
  const sha256 = sha256Of(asset);
  if (!canInstall) return { url, install: null };
  if (isNativeApp()) {
    return {
      url,
      install: async (onProgress) => {
        const { registerPlugin } = await import('@capacitor/core');
        const updater = registerPlugin<AndroidUpdater>('Updater');
        const sub = await updater.addListener('progress', (p) => onProgress(p.total > 0 ? p.loaded / p.total : 0));
        try {
          await updater.install({ url, sha256 });
        } finally {
          await sub.remove();
        }
      },
    };
  }
  return {
    url,
    install: async (onProgress) => {
      desktop!.onUpdateProgress?.(onProgress);
      await desktop!.installUpdate!(url, sha256);
    },
  };
}

function showBanner(version: string, plan: { url: string; install: Install | null }): void {
  document.querySelector('.update-banner')?.remove();
  const text = h('span.update-text', {}, t('updateAvailable', { v: version }));
  const action = h('button.btn.btn-primary.btn-small', { type: 'button' }, plan.install ? t('updateInstall') : t('updateDownload'));
  const close = h(
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
  );
  const bar = h('div.update-banner', { role: 'status' }, icon(Download, 20), text, action, close);
  const download = () => {
    openExternal(plan.url);
    bar.remove();
  };
  action.addEventListener('click', async () => {
    if (!plan.install) return download();
    action.disabled = true;
    close.hidden = true;
    text.textContent = t('updateDownloading', { p: 0 });
    try {
      // The open document and its edits are kept for "Continue" after the restart.
      if (doc.isOpen) {
        await flushSession();
        doc.dirty = false;
      }
      await plan.install((f) => {
        const pct = Math.round(Math.min(1, Math.max(0, f)) * 100);
        text.textContent = f >= 1 ? t('updateInstalling') : t('updateDownloading', { p: pct });
      });
      if (isNativeApp()) {
        // The system installer is on screen now; if it is closed, the button tries again.
        text.textContent = t('updateConfirm');
        action.textContent = t('updateInstall');
        action.disabled = false;
        close.hidden = false;
      } else text.textContent = t('updateInstalling');
    } catch (e) {
      console.warn('update', e);
      toast(t('updateFailed', { msg: String((e as Error)?.message ?? e) }), 'error', 7000);
      download();
    }
  });
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
  showBanner(version, await updatePlan(rel));
}
