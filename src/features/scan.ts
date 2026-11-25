// "Scan document": photos of paper pages taken with the phone's camera become a PDF.
// Each photo can be turned or removed, and a filter makes the paper white and the
// text crisp ("Document"), just grey, or keeps the colors brighter.
import { Camera, ImagePlus, RotateCw, Trash2 } from 'lucide';
import { busy, dialog, h, icon, pickFiles, toast } from '../ui/dom';
import { imageToAsset } from './documents';
import type { Asset } from '../model';
import { t } from '../i18n';

type Filter = 'document' | 'gray' | 'color' | 'original';
type Picture = Omit<Asset, 'id' | 'url'>;

interface Shot {
  pic: Picture;
  /** Extra clockwise quarter turns. */
  turns: number;
  url: string;
}

/** Longest side of a scanned page (about 250 dpi on A4). */
const PAGE_SIDE = 2400;

async function toShots(files: File[]): Promise<Shot[]> {
  const out: Shot[] = [];
  for (const f of files) {
    try {
      const pic = await imageToAsset(f);
      out.push({ pic, turns: 0, url: URL.createObjectURL(new Blob([pic.bytes.slice()], { type: pic.mime })) });
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  }
  return out;
}

/** Asks for photos and returns the finished PDF, or null when cancelled. */
export async function scanDocument(): Promise<Uint8Array | null> {
  const shots = await toShots(await pickFiles('image/*', false, true));
  if (!shots.length) return null;
  let filter: Filter = 'document';
  const grid = h('div.scan-grid');
  const render = () => {
    grid.replaceChildren(
      ...shots.map((s, i) =>
        h(
          'div.scan-item',
          {},
          h('img', { src: s.url, alt: `${t('page')} ${i + 1}`, style: `transform: rotate(${s.turns * 90}deg)` }),
          h('span.scan-num', {}, String(i + 1)),
          h(
            'div.scan-tools',
            {},
            h(
              'button.icon-btn',
              { type: 'button', title: t('rotate'), 'aria-label': t('rotate'), onclick: () => ((s.turns = (s.turns + 1) % 4), render()) },
              icon(RotateCw, 16),
            ),
            h(
              'button.icon-btn',
              {
                type: 'button',
                title: t('delete'),
                'aria-label': t('delete'),
                onclick: () => {
                  URL.revokeObjectURL(s.url);
                  shots.splice(i, 1);
                  render();
                },
              },
              icon(Trash2, 16),
            ),
          ),
        ),
      ),
    );
  };
  const add = async (camera: boolean) => {
    const more = await toShots(await pickFiles('image/*', !camera, camera));
    shots.push(...more);
    render();
  };
  const filters = h('div.seg', { role: 'radiogroup', 'aria-label': t('scanFilter') });
  const renderFilters = () =>
    filters.replaceChildren(
      ...(['document', 'gray', 'color', 'original'] as Filter[]).map((f) =>
        h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(f === filter),
            class: f === filter ? 'active' : '',
            onclick: () => ((filter = f), renderFilters()),
          },
          t(f === 'document' ? 'scanDocumentFilter' : f === 'gray' ? 'scanGray' : f === 'color' ? 'scanColor' : 'scanOriginal'),
        ),
      ),
    );
  renderFilters();
  render();
  const ok = await dialog<boolean>({
    title: t('scanTitle'),
    wide: true,
    body: h(
      'div',
      {},
      grid,
      h(
        'div.row.scan-add',
        {},
        h('button.btn', { type: 'button', onclick: () => void add(true) }, icon(Camera, 18), t('scanMore')),
        h('button.btn', { type: 'button', onclick: () => void add(false) }, icon(ImagePlus, 18), t('scanFromGallery')),
      ),
      h('div.field', {}, h('span', {}, t('scanFilter')), filters),
    ),
    dismissValue: false,
    actions: [
      { label: t('cancel'), value: false },
      { label: t('scanCreate'), value: () => (shots.length ? true : undefined), primary: true },
    ],
  });
  try {
    if (!ok || !shots.length) return null;
    busy(true, t('scanWorking'));
    const pages: (Picture & { pt: { w: number; h: number } })[] = [];
    for (const s of shots) pages.push(await finishPage(s, filter));
    const { imagesToPdf } = await import('../export/exporter');
    return await imagesToPdf(pages, 'a4');
  } finally {
    busy(false);
    for (const s of shots) URL.revokeObjectURL(s.url);
  }
}

/** Turns, scales and cleans up one photo, returning it as a JPEG. */
async function finishPage(s: Shot, filter: Filter): Promise<Picture & { pt: { w: number; h: number } }> {
  const bmp = await createImageBitmap(new Blob([s.pic.bytes.slice()], { type: s.pic.mime }));
  const k = Math.min(1, PAGE_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k);
  const hh = Math.round(bmp.height * k);
  const side = s.turns % 2 === 1;
  const c = document.createElement('canvas');
  c.width = side ? hh : w;
  c.height = side ? w : hh;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((s.turns * Math.PI) / 2);
  ctx.drawImage(bmp, -w / 2, -hh / 2, w, hh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  bmp.close();
  if (filter !== 'original') {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    cleanUp(img, filter);
    ctx.putImageData(img, 0, 0);
  }
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.85));
  // Page size larger than A4, so the photo is scaled to fill the A4 page (minus a small margin).
  const pt = 1000 / Math.max(c.width, c.height);
  const out = {
    mime: 'image/jpeg' as const,
    bytes: new Uint8Array(await blob.arrayBuffer()),
    width: c.width,
    height: c.height,
    pt: { w: c.width * pt, h: c.height * pt },
  };
  c.width = 0;
  return out;
}

/**
 * Evens out the lighting: the brightness of the paper around each point is estimated
 * (a blurred map of the brightest nearby pixels) and every pixel is divided by it, so
 * shadows and yellowish light turn into white paper. Then the contrast is raised.
 */
export function cleanUp(img: ImageData, filter: Exclude<Filter, 'original'>): void {
  const { width: W, height: H, data } = img;
  const bg = paperMap(img);
  const step = 16;
  const bw = Math.ceil(W / step);
  const bh = Math.ceil(H / step);
  for (let y = 0; y < H; y++) {
    // Bilinear sample of the coarse map.
    const fy = Math.min(bh - 1, Math.max(0, y / step - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(bw - 1, Math.max(0, x / step - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const tx = fx - x0;
      const top = bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx;
      const bot = bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx;
      const paper = Math.max(40, top * (1 - ty) + bot * ty);
      const i = (y * W + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (filter === 'color') {
        const kf = 245 / paper;
        data[i] = boost(r * kf);
        data[i + 1] = boost(g * kf);
        data[i + 2] = boost(b * kf);
        continue;
      }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let v = (lum / paper) * 255;
      if (filter === 'document') {
        // Paper to white, ink to near black, a soft edge in between.
        v = ((v - 95) / (225 - 95)) * 255;
        v = v < 0 ? 0 : v > 255 ? 255 : v;
        v = 255 * Math.pow(v / 255, 1.6);
      } else v = boost(v);
      const q = v < 0 ? 0 : v > 255 ? 255 : v;
      data[i] = data[i + 1] = data[i + 2] = q;
    }
  }
}

function boost(v: number): number {
  const o = (v - 20) * (255 / 225);
  return o < 0 ? 0 : o > 255 ? 255 : o;
}

/** Coarse map (one value per 16×16 block) of how bright the paper is around each block. */
function paperMap(img: ImageData): Float32Array {
  const { width: W, height: H, data } = img;
  const step = 16;
  const bw = Math.ceil(W / step);
  const bh = Math.ceil(H / step);
  let map: Float32Array = new Float32Array(bw * bh);
  // The brightest pixels of each block are paper (text is darker).
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = 0;
      for (let y = by * step; y < Math.min(H, by * step + step); y += 2) {
        for (let x = bx * step; x < Math.min(W, bx * step + step); x += 2) {
          const i = (y * W + x) * 4;
          const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (l > best) best = l;
        }
      }
      map[by * bw + bx] = best;
    }
  }
  // Spread the bright values (blocks full of text) and smooth the result.
  for (let pass = 0; pass < 2; pass++) map = filter3(map, bw, bh, Math.max);
  for (let pass = 0; pass < 3; pass++) map = filter3(map, bw, bh, (...v: number[]) => v.reduce((a, b) => a + b, 0) / v.length);
  return map;
}

function filter3(src: Float32Array, w: number, hh: number, f: (...v: number[]) => number): Float32Array {
  const out = new Float32Array(src.length);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const v: number[] = [];
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= hh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) v.push(src[yy * w + xx]);
        }
      }
      out[y * w + x] = f(...v);
    }
  }
  return out;
}
