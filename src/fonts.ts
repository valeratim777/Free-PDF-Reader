import type { FontKey } from './model';

// Bundled DejaVu fonts cover Latin, Cyrillic, Greek and many other scripts, so
// text typed in any of these languages is written into the PDF correctly.
const FILES: Record<FontKey, [string, string]> = {
  sans: ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'],
  serif: ['DejaVuSerif.ttf', 'DejaVuSerif-Bold.ttf'],
  mono: ['DejaVuSansMono.ttf', 'DejaVuSansMono-Bold.ttf'],
};

export const CSS_FAMILY: Record<FontKey, string> = {
  sans: 'PR Sans',
  serif: 'PR Serif',
  mono: 'PR Mono',
};

export function cssFont(key: FontKey): string {
  const fallback = key === 'serif' ? 'serif' : key === 'mono' ? 'monospace' : 'sans-serif';
  return `"${CSS_FAMILY[key]}", ${fallback}`;
}

type Loader = (file: string) => Promise<Uint8Array>;

let loader: Loader = async (file) => {
  const res = await fetch(new URL(`fonts/${file}`, document.baseURI));
  if (!res.ok) throw new Error(`Font ${file}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/** Lets tests read fonts from disk instead of over HTTP. */
export function setFontLoader(fn: Loader): void {
  loader = fn;
}

const bytesCache = new Map<string, Promise<Uint8Array>>();

export function fontBytes(key: FontKey, bold: boolean): Promise<Uint8Array> {
  const file = FILES[key][bold ? 1 : 0];
  let p = bytesCache.get(file);
  if (!p) {
    p = loader(file);
    bytesCache.set(file, p);
    p.catch(() => bytesCache.delete(file));
  }
  return p;
}

const faceCache = new Map<string, Promise<void>>();

/** Registers the font with the browser so on-screen text matches the saved PDF. */
export function ensureCssFont(key: FontKey, bold: boolean): Promise<void> {
  const id = `${key}-${bold}`;
  let p = faceCache.get(id);
  if (!p) {
    p = fontBytes(key, bold).then(async (bytes) => {
      const face = new FontFace(CSS_FAMILY[key], bytes.slice().buffer, { weight: bold ? '700' : '400' });
      await face.load();
      document.fonts.add(face);
    });
    faceCache.set(id, p);
    p.catch(() => faceCache.delete(id));
  }
  return p;
}

export function isCssFontReady(key: FontKey, bold: boolean): boolean {
  return document.fonts.check(`${bold ? 'bold ' : ''}12px "${CSS_FAMILY[key]}"`);
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width of each line (in points) when rendered at `size` points. */
export function measureLines(text: string, key: FontKey, bold: boolean, size: number): number[] {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  ctx.font = `${bold ? 'bold ' : ''}100px ${cssFont(key)}`;
  return text.split('\n').map((line) => (ctx.measureText(line).width / 100) * size);
}
