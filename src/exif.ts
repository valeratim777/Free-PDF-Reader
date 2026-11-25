// Phone cameras store photos sideways and note in the file (EXIF "Orientation") how
// to turn them. Browsers apply that when showing a photo, but a PDF shows the stored
// pixels as they are, so the app turns the pixels itself before putting a photo into a PDF.

export interface JpegInfo {
  /** EXIF orientation 1–8 (1 = as stored). */
  orientation: number;
  /** Size of the stored pixels (before turning). */
  width: number;
  height: number;
}

/** Reads the orientation and stored size from a JPEG file; null if it is not a readable JPEG. */
export function jpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation = 1;
  let width = 0;
  let height = 0;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan data
    if (marker >= 0xd0 && marker <= 0xd7) {
      i += 2;
      continue;
    }
    const len = view.getUint16(i + 2);
    const start = i + 4;
    if (len < 2 || start + len - 2 > bytes.length) break;
    if (marker === 0xe1 && len >= 8 && view.getUint32(start) === 0x45786966) {
      // "Exif\0\0", then a TIFF header
      const o = exifOrientation(view, start + 6, start + len - 2);
      if (o) orientation = o;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && len >= 7) {
      height = view.getUint16(start + 1);
      width = view.getUint16(start + 3);
    }
    i = start + len - 2;
  }
  if (!width || !height) return null;
  return { orientation, width, height };
}

function exifOrientation(view: DataView, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return null;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return null;
  const count = view.getUint16(ifd, little);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > end) return null;
    if (view.getUint16(e, little) === 0x0112) {
      const v = view.getUint16(e + 8, little);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** Orientations 5–8 swap width and height. */
export function swapsSides(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

/**
 * Draws stored pixels upright onto a canvas context of the turned size (w × h are the
 * upright size): the transform for each EXIF orientation.
 */
export function orientContext(ctx: CanvasRenderingContext2D, orientation: number, w: number, h: number): void {
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, w, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, w, h);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, h);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, w, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, w, h);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, h);
      break;
    default:
      break;
  }
}
