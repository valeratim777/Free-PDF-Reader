// Integration with the native shells: the Android app (Capacitor) and the
// desktop app (Electron). In a normal browser none of this runs.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

interface DesktopFile {
  name: string;
  data: Uint8Array;
}

interface DesktopBridge {
  pendingFiles(): Promise<DesktopFile[]>;
  onOpenFile(cb: (f: DesktopFile) => void): void;
  appInfo?(): Promise<{ version: string; portable: boolean; platform: string }>;
  httpGet?(url: string): Promise<{ status: number; body: string }>;
  installUpdate?(url: string, sha256: string): Promise<boolean>;
  onUpdateProgress?(cb: (fraction: number) => void): void;
}

export function isNativeApp(): boolean {
  return !!(window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.();
}

export function desktopBridge(): DesktopBridge | null {
  return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

/** Opens a web address in the system browser (the apps never navigate away from themselves). */
export function openExternal(url: string): void {
  if (isNativeApp()) {
    // The Android shell hands any outside address to the browser instead of loading it.
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    a.click();
    return;
  }
  window.open(url, '_blank', 'noopener');
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject);
  });
}

/**
 * GET request to an outside service (online translation). The apps send it
 * natively, where the browser's cross-origin rules do not get in the way; the
 * website uses fetch. No cookies or referrer are sent.
 */
export async function httpGet(url: string, signal: AbortSignal): Promise<{ status: number; body: string }> {
  const desktop = desktopBridge();
  if (desktop?.httpGet) return abortable(desktop.httpGet(url), signal);
  if (isNativeApp()) {
    const { CapacitorHttp } = await import('@capacitor/core');
    const u = new URL(url);
    const r = await abortable(
      CapacitorHttp.get({ url: `${u.origin}${u.pathname}`, params: Object.fromEntries(u.searchParams), responseType: 'text', connectTimeout: 15000, readTimeout: 30000 }),
      signal,
    );
    return { status: r.status, body: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
  }
  const r = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  return { status: r.status, body: await r.text() };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------- the app's own Android plugin (android/.../FilesPlugin.java) ----------------

/** A file the Android app copied into its cache: from another app or from the system picker. */
export interface NativeFile {
  /** file:// address in the app's cache. */
  path: string;
  name: string;
  mime: string;
  size: number;
  /** The original document (content://…). */
  uri: string;
  /** Whether "Save" may write back into the original. */
  writable: boolean;
}

interface Batch {
  files: NativeFile[];
  source: 'view' | 'share';
  error?: string;
}

interface FilesPlugin {
  takePending(): Promise<{ batches: Batch[] }>;
  pickPdf(): Promise<{ file?: NativeFile; cancelled?: boolean }>;
  writeBack(o: { uri: string; path: string }): Promise<void>;
  saveAs(o: { path: string; name: string; mime: string }): Promise<{ uri?: string; name?: string; cancelled?: boolean }>;
  print(o: { path: string; name: string }): Promise<void>;
  keepScreenOn(o: { on: boolean }): Promise<void>;
  addListener(event: 'filesReceived', cb: () => void): Promise<unknown>;
}

let filesPlugin: Promise<FilesPlugin> | null = null;

function files(): Promise<FilesPlugin> {
  filesPlugin ??= import('@capacitor/core').then(({ registerPlugin }) => registerPlugin<FilesPlugin>('Files'));
  return filesPlugin;
}

/** Writes a blob into the app's cache and returns its file:// address. */
async function toCache(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const safe = name.replace(/[\\/:*?"<>|%#]/g, '_');
  const res = await Filesystem.writeFile({ path: `out/${safe}`, data: await toBase64(blob), directory: Directory.Cache, recursive: true });
  return res.uri;
}

/** Reads a file the Android app put in its cache, then removes the copy. */
export async function readNativeFile(f: NativeFile): Promise<File> {
  const type = f.mime || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '');
  let blob: Blob;
  try {
    const { Capacitor } = await import('@capacitor/core');
    const r = await fetch(Capacitor.convertFileSrc(f.path));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    blob = await r.blob();
  } catch {
    const { Filesystem } = await import('@capacitor/filesystem');
    const r = await Filesystem.readFile({ path: f.path });
    blob =
      typeof r.data === 'string' ? new Blob([Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))]) : (r.data as Blob);
  }
  void import('@capacitor/filesystem').then(({ Filesystem }) => Filesystem.deleteFile({ path: f.path }).catch(() => {}));
  return new File([blob], f.name, { type });
}

/** The system "Open" picker for a PDF. Null when cancelled; throws when the picker is not available. */
export async function nativePickPdf(): Promise<{ file: File; doc: { uri: string; writable: boolean } } | null> {
  const r = await (await files()).pickPdf();
  if (!r.file) return null;
  return { file: await readNativeFile(r.file), doc: { uri: r.file.uri, writable: r.file.writable } };
}

/** Writes the saved PDF back into the document it was opened from. */
export async function nativeWriteBack(uri: string, blob: Blob, name: string): Promise<void> {
  await (await files()).writeBack({ uri, path: await toCache(blob, name) });
}

/** "Save as": the system asks where. Null when the person cancelled. */
export async function nativeSaveAs(blob: Blob, name: string, mime: string): Promise<{ uri: string; name: string } | null> {
  const r = await (await files()).saveAs({ path: await toCache(blob, name), name, mime });
  return r.uri ? { uri: r.uri, name: r.name || name } : null;
}

/** Prints a PDF with the Android print dialog (printers, "Save as PDF"). */
export async function nativePrint(blob: Blob, name: string): Promise<void> {
  await (await files()).print({ path: await toCache(blob, name), name });
}

export function keepScreenOn(on: boolean): void {
  if (isNativeApp()) {
    void files()
      .then((f) => f.keepScreenOn({ on }))
      .catch(() => {});
    return;
  }
  // Browsers: the Screen Wake Lock API, while the page is visible.
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  if (!nav.wakeLock) return;
  wakeWanted = on;
  if (!on) {
    void wakeLock?.release().catch(() => {});
    wakeLock = null;
    return;
  }
  if (!wakeLock) {
    void nav.wakeLock
      .request('screen')
      .then((l) => (wakeLock = l))
      .catch(() => {});
  }
  if (!wakeListener) {
    wakeListener = true;
    document.addEventListener('visibilitychange', () => {
      // The browser releases the lock when the page is hidden.
      if (document.visibilityState === 'visible' && wakeWanted) {
        wakeLock = null;
        keepScreenOn(true);
      }
    });
  }
}

let wakeLock: { release(): Promise<void> } | null = null;
let wakeWanted = false;
let wakeListener = false;

/** Opens the Android share sheet with the file (send, save to Drive, print…). */
export async function nativeShare(blob: Blob, name: string): Promise<void> {
  const { Share } = await import('@capacitor/share');
  await Share.share({ title: name, files: [await toCache(blob, name)] });
}

/**
 * Saves a file made by the app (exported pages, text, ZIP…): the system asks where.
 * Returns the name it was saved under, or '' when cancelled. If the picker is not
 * available, the file goes to Documents/PDF Reader, and failing that to the share sheet.
 */
export async function nativeSave(blob: Blob, name: string): Promise<string> {
  try {
    const r = await nativeSaveAs(blob, name, blob.type || 'application/octet-stream');
    return r ? r.name : '';
  } catch (e) {
    console.warn('save picker', e);
  }
  return saveToDocuments(blob, name);
}

/** Writes into Documents/PDF Reader and returns that path; the share sheet opens if that is not allowed. */
export async function saveToDocuments(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    await Filesystem.writeFile({ path: `PDF Reader/${name}`, data: await toBase64(blob), directory: Directory.Documents, recursive: true });
    return `Documents/PDF Reader/${name}`;
  } catch {
    await nativeShare(blob, name);
    return '';
  }
}

/** Files handed over by the system: "Open with"/"Share" on Android, double-click on desktop. */
export interface SystemFiles {
  files: File[];
  /** Android: the single document opened with "Open with" (for saving back). */
  doc?: { uri: string; writable: boolean };
  /** The file could not be read. */
  error?: string;
}

export async function listenForSystemFiles(open: (r: SystemFiles) => void): Promise<void> {
  const desktop = desktopBridge();
  if (desktop) {
    const toFile = (f: DesktopFile) => new File([f.data.slice()], f.name, { type: 'application/pdf' });
    desktop.onOpenFile((f) => open({ files: [toFile(f)] }));
    const [first] = await desktop.pendingFiles();
    if (first) open({ files: [toFile(first)] });
    return;
  }
  if (!isNativeApp()) return;
  const plugin = await files();
  // Each batch is handed out once, however many times the app is told about it.
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (;;) {
        const { batches } = await plugin.takePending();
        if (!batches.length) break;
        for (const b of batches) {
          if (b.error && !b.files.length) {
            open({ files: [], error: b.error });
            continue;
          }
          const list: File[] = [];
          for (const f of b.files) list.push(await readNativeFile(f));
          const one = b.files.length === 1 && b.source === 'view' ? b.files[0] : null;
          open({ files: list, doc: one ? { uri: one.uri, writable: one.writable } : undefined });
        }
      }
    } finally {
      draining = false;
    }
  };
  await plugin.addListener('filesReceived', () => void drain().catch((e) => console.warn('incoming files', e)));
  await drain();
}
