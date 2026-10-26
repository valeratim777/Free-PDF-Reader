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
}

export function isNativeApp(): boolean {
  return !!(window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor?.isNativePlatform?.();
}

export function desktopBridge(): DesktopBridge | null {
  return (window as unknown as { desktop?: DesktopBridge }).desktop ?? null;
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Opens the Android share sheet with the file (send, save to Drive, print…). */
export async function nativeShare(blob: Blob, name: string): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');
  const res = await Filesystem.writeFile({ path: name, data: await toBase64(blob), directory: Directory.Cache });
  await Share.share({ title: name, files: [res.uri] });
}

/**
 * Saves into Documents/PDF Reader on the phone and returns that path. When the
 * device doesn't allow it, the share sheet opens instead and '' is returned.
 */
export async function nativeSave(blob: Blob, name: string): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    await Filesystem.writeFile({ path: `PDF Reader/${name}`, data: await toBase64(blob), directory: Directory.Documents, recursive: true });
    return `Documents/PDF Reader/${name}`;
  } catch {
    await nativeShare(blob, name);
    return '';
  }
}

/** PDFs handed over by the system: "Open with" on Android, double-click on desktop. */
export async function listenForSystemFiles(open: (file: File) => void): Promise<void> {
  const desktop = desktopBridge();
  if (desktop) {
    const toFile = (f: DesktopFile) => new File([f.data.slice()], f.name, { type: 'application/pdf' });
    desktop.onOpenFile((f) => open(toFile(f)));
    const [first] = await desktop.pendingFiles();
    if (first) open(toFile(first));
    return;
  }
  if (!isNativeApp()) return;
  const { App } = await import('@capacitor/app');
  const { Filesystem } = await import('@capacitor/filesystem');
  const handle = async (url?: string) => {
    if (!url || !/^(content|file):/i.test(url)) return;
    const r = await Filesystem.readFile({ path: url });
    const bytes =
      typeof r.data === 'string' ? Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)) : new Uint8Array(await (r.data as Blob).arrayBuffer());
    const last = decodeURIComponent(url.split('/').pop() ?? '');
    const name = /\.pdf$/i.test(last) ? last.replace(/^.*[:/]/, '') : 'document.pdf';
    open(new File([bytes], name, { type: 'application/pdf' }));
  };
  void App.addListener('appUrlOpen', (e) => void handle(e.url));
  const launch = await App.getLaunchUrl();
  await handle(launch?.url);
}
