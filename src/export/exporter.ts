// Writes the working document (page list + annotations + form values + decorations)
// into a real PDF file using pdf-lib. Kept free of DOM/global state so it can be tested.
import {
  BlendMode,
  EncryptedPDFError,
  LineCapStyle,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFPageTree,
  PDFRadioGroup,
  PDFRef,
  PDFString,
  PDFTextField,
  closePath,
  concatTransformationMatrix,
  degrees,
  fillAndStroke,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setFillingRgbColor,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import type { Annotation, Asset, DocPage, DocState, FontKey, NoteAnn, Rect } from '../model';
import {
  arrowHead,
  baselineOf,
  boxFrame,
  frameMatrixUp,
  markupThickness,
  mul,
  NOTE_SIZE,
  rectH,
  rectW,
  rotateM,
  smoothPath,
  translateM,
  type Mat,
} from '../geometry';
import { fontBytes } from '../fonts';
import { numberLayout, numberText, stampBox, visualFrame } from '../decor';

export interface SourceData {
  bytes: Uint8Array;
  password?: string;
}

export interface Protection {
  userPassword: string;
  ownerPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowEdit: boolean;
}

export interface Raster {
  bytes: Uint8Array;
  mime: 'image/jpeg' | 'image/png';
}

export interface ExportInput {
  state: DocState;
  sources: Map<string, SourceData>;
  primary: string | null;
  assets: Map<string, Asset>;
  /** View box and own rotation of a page. */
  pageInfo(p: DocPage): { view: [number, number, number, number]; rotate: number };
}

export interface ExportOptions {
  flattenForms?: boolean;
  protection?: Protection | null;
  /** Renders a page to an image with the given areas blacked out (needed for redaction). */
  /** Renders page `pageIndex` of `pdf` to an image with the given areas painted black. */
  rasterize?: (pdf: Uint8Array, pageIndex: number, redactions: Rect[]) => Promise<Raster>;
  producer?: string;
}

function hexToRgb(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return rgb(0, 0, 0);
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

function rgbArray(hex: string): number[] {
  const c = hexToRgb(hex) as unknown as { red: number; green: number; blue: number };
  return [c.red, c.green, c.blue];
}

export async function loadPdfLib(data: SourceData): Promise<PDFDocument> {
  const opts = { updateMetadata: false } as const;
  if (data.password !== undefined) return PDFDocument.load(data.bytes, { ...opts, password: data.password });
  try {
    return await PDFDocument.load(data.bytes, opts);
  } catch (e) {
    // Files that are only owner-password protected open with an empty user password.
    if (e instanceof EncryptedPDFError || /encrypt/i.test(String((e as Error)?.message))) {
      return PDFDocument.load(data.bytes, { ...opts, password: '' });
    }
    throw e;
  }
}

class Resources {
  private fonts = new Map<string, Promise<PDFFont>>();
  private images = new Map<string, Promise<PDFImage>>();
  constructor(
    private doc: PDFDocument,
    private assets: Map<string, Asset>,
  ) {}

  font(key: FontKey, bold: boolean): Promise<PDFFont> {
    const id = `${key}-${bold}`;
    let f = this.fonts.get(id);
    if (!f) {
      f = fontBytes(key, bold).then((b) => this.doc.embedFont(b, { subset: true }));
      this.fonts.set(id, f);
    }
    return f;
  }

  image(assetId: string): Promise<PDFImage> | null {
    const asset = this.assets.get(assetId);
    if (!asset) return null;
    let p = this.images.get(assetId);
    if (!p) {
      p = asset.mime === 'image/png' ? this.doc.embedPng(asset.bytes) : this.doc.embedJpg(asset.bytes);
      this.images.set(assetId, p);
    }
    return p;
  }
}

function withMatrix(page: PDFPage, m: Mat, fn: () => void): void {
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]));
  fn();
  page.pushOperators(popGraphicsState());
}

/** Rounded rectangle as an SVG path in a v-down coordinate system. */
function roundedRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.4477;
  return [
    `M${x + r} ${y}`,
    `H${x + w - r}`,
    `C${x + w - k} ${y} ${x + w} ${y + k} ${x + w} ${y + r}`,
    `V${y + h - r}`,
    `C${x + w} ${y + h - k} ${x + w - k} ${y + h} ${x + w - r} ${y + h}`,
    `H${x + r}`,
    `C${x + k} ${y + h} ${x} ${y + h - k} ${x} ${y + h - r}`,
    `V${y + r}`,
    `C${x} ${y + k} ${x + k} ${y} ${x + r} ${y}`,
    'Z',
  ].join(' ');
}

async function drawAnnotation(doc: PDFDocument, page: PDFPage, a: Annotation, res: Resources): Promise<void> {
  const color = hexToRgb(a.color);
  switch (a.type) {
    case 'ink':
    case 'marker':
      for (const s of a.strokes) {
        page.drawSvgPath(smoothPath(s, true), {
          x: 0,
          y: 0,
          borderColor: color,
          borderWidth: a.width,
          borderOpacity: a.opacity,
          borderLineCap: LineCapStyle.Round,
          blendMode: a.type === 'marker' ? BlendMode.Multiply : undefined,
        });
      }
      return;
    case 'rect':
    case 'ellipse': {
      const r = a.rect;
      const stroked = a.width > 0;
      const opts = {
        borderColor: stroked ? color : undefined,
        borderWidth: stroked ? a.width : 0,
        borderOpacity: a.opacity,
        color: a.fill ? hexToRgb(a.fill) : undefined,
        opacity: a.opacity,
      };
      if (!stroked && !a.fill) return;
      if (a.type === 'rect') page.drawRectangle({ x: r.x1, y: r.y1, width: rectW(r), height: rectH(r), ...opts });
      else page.drawEllipse({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2, xScale: rectW(r) / 2, yScale: rectH(r) / 2, ...opts });
      return;
    }
    case 'line':
    case 'arrow':
      page.drawLine({ start: a.p1, end: a.p2, thickness: a.width, color, opacity: a.opacity, lineCap: LineCapStyle.Round });
      if (a.type === 'arrow') {
        const hd = arrowHead(a.p1, a.p2, a.width);
        const d = `M${hd[0].x} ${-hd[0].y} L${hd[1].x} ${-hd[1].y} L${hd[2].x} ${-hd[2].y} Z`;
        page.drawSvgPath(d, { x: 0, y: 0, color, opacity: a.opacity, borderColor: color, borderWidth: a.width, borderOpacity: a.opacity });
      }
      return;
    case 'highlight':
      for (const r of a.rects) {
        page.drawRectangle({ x: r.x1, y: r.y1, width: rectW(r), height: rectH(r), color, opacity: a.opacity, blendMode: BlendMode.Multiply });
      }
      return;
    case 'underline':
    case 'strike':
      for (const r of a.rects) {
        const f = boxFrame(r, a.rot);
        const th = markupThickness(f.h);
        const v = a.type === 'underline' ? f.h - th / 2 : f.h * 0.55;
        withMatrix(page, frameMatrixUp(f), () =>
          page.drawLine({ start: { x: 0, y: -v }, end: { x: f.w, y: -v }, thickness: th, color, opacity: a.opacity }),
        );
      }
      return;
    case 'text': {
      const f = boxFrame(a.rect, a.rot);
      const font = await res.font(a.font, a.bold);
      withMatrix(page, frameMatrixUp(f), () => {
        if (a.bg) page.drawRectangle({ x: 0, y: -f.h, width: f.w, height: f.h, color: hexToRgb(a.bg) });
        a.text.split('\n').forEach((line, i) => {
          if (!line) return;
          page.drawText(line, { x: a.pad, y: -baselineOf(i, a.size, a.pad), size: a.size, font, color, opacity: a.opacity });
        });
      });
      return;
    }
    case 'note':
      addNoteAnnotation(doc, page, a);
      return;
    case 'image':
    case 'signature': {
      const imgP = res.image(a.assetId);
      if (!imgP) return;
      const img = await imgP;
      const f = boxFrame(a.rect, a.rot);
      withMatrix(page, frameMatrixUp(f), () => page.drawImage(img, { x: 0, y: -f.h, width: f.w, height: f.h, opacity: a.opacity }));
      return;
    }
    case 'stamp': {
      const f = boxFrame(a.rect, a.rot);
      const font = await res.font('sans', true);
      const tw = font.widthOfTextAtSize(a.label, a.size);
      const b = stampBox(tw, a.size);
      withMatrix(page, frameMatrixUp(f), () => {
        page.drawSvgPath(roundedRect(b.border / 2, b.border / 2, f.w - b.border, f.h - b.border, b.radius), {
          x: 0,
          y: 0,
          borderColor: color,
          borderWidth: b.border,
          borderOpacity: a.opacity,
        });
        page.drawText(a.label, { x: (f.w - tw) / 2, y: -b.baseline, size: a.size, font, color, opacity: a.opacity });
      });
      return;
    }
    case 'whiteout':
    case 'redact':
      page.drawRectangle({ x: a.rect.x1, y: a.rect.y1, width: rectW(a.rect), height: rectH(a.rect), color: a.type === 'redact' ? rgb(0, 0, 0) : color });
      return;
  }
}

/** Adds a real PDF comment (Text annotation) with its own icon appearance. */
function addNoteAnnotation(doc: PDFDocument, page: PDFPage, a: NoteAnn): void {
  const ctx = doc.context;
  const [r, g, b] = rgbArray(a.color);
  const s = NOTE_SIZE;
  const ap = ctx.formXObject(
    [
      setFillingRgbColor(r, g, b),
      setStrokingRgbColor(0.2, 0.2, 0.2),
      setLineWidth(1),
      moveTo(2, s - 2),
      lineTo(s - 2, s - 2),
      lineTo(s - 2, 6),
      lineTo(9, 6),
      lineTo(4, 1),
      lineTo(4, 6),
      lineTo(2, 6),
      closePath(),
      fillAndStroke(),
      moveTo(5, s - 6),
      lineTo(s - 5, s - 6),
      moveTo(5, s - 10),
      lineTo(s - 5, s - 10),
      stroke(),
    ],
    { BBox: [0, 0, s, s], Matrix: [1, 0, 0, 1, 0, 0] },
  );
  const apRef = ctx.register(ap);
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [a.at.x, a.at.y - s, a.at.x + s, a.at.y],
    Contents: PDFHexString.fromText(a.text),
    T: PDFHexString.fromText(a.author ?? ''),
    M: PDFString.fromDate(new Date(a.created)),
    Name: 'Comment',
    C: [r, g, b],
    F: 4,
    Open: false,
    AP: { N: apRef },
  });
  page.node.addAnnot(ctx.register(annot));
}

async function drawDecorations(page: PDFPage, view: number[], rotation: number, state: DocState, index: number, total: number, res: Resources): Promise<void> {
  const { watermark: w, numbering: n } = state;
  if (!w && !n) return;
  const f = visualFrame(view, rotation);
  const base = frameMatrixUp(f);
  if (w && w.text) {
    const font = await res.font('sans', true);
    const tw = font.widthOfTextAtSize(w.text, w.size);
    const m = mul(base, mul(translateM(f.w / 2, -f.h / 2), rotateM(w.angle)));
    withMatrix(page, m, () =>
      page.drawText(w.text, { x: -tw / 2, y: -w.size * 0.35, size: w.size, font, color: hexToRgb(w.color), opacity: w.opacity }),
    );
  }
  if (n) {
    const font = await res.font('sans', false);
    const text = numberText(n, index, total);
    const tw = font.widthOfTextAtSize(text, n.size);
    const l = numberLayout(f, n.position, n.size);
    const x = l.anchor === 'start' ? l.x : l.anchor === 'middle' ? l.x - tw / 2 : l.x - tw;
    withMatrix(page, base, () => page.drawText(text, { x, y: -l.y, size: n.size, font, color: hexToRgb(n.color) }));
  }
}

function applyForm(doc: PDFDocument, values: DocState['form'], font: PDFFont, flatten: boolean): void {
  const form = doc.getForm();
  for (const [name, value] of Object.entries(values)) {
    let field;
    try {
      field = form.getField(name);
    } catch {
      continue;
    }
    const first = Array.isArray(value) ? (value[0] ?? '') : value;
    try {
      if (field instanceof PDFTextField) {
        let v = Array.isArray(value) ? value.join(', ') : value;
        const max = field.getMaxLength();
        if (max !== undefined) v = v.slice(0, max);
        field.setText(v);
        field.updateAppearances(font);
      } else if (field instanceof PDFCheckBox) {
        if (!first || first === 'Off') field.uncheck();
        else field.check();
      } else if (field instanceof PDFRadioGroup) {
        if (!first || first === 'Off') field.clear();
        else {
          const opts = field.getOptions();
          if (opts.includes(first)) field.select(first);
          else if (/^\d+$/.test(first) && opts[+first] !== undefined) field.select(opts[+first]);
        }
      } else if (field instanceof PDFDropdown) {
        if (first) field.select(first);
        else field.clear();
        field.updateAppearances(font);
      } else if (field instanceof PDFOptionList) {
        const list = (Array.isArray(value) ? value : [value]).filter(Boolean);
        if (list.length) field.select(list);
        else field.clear();
        field.updateAppearances(font);
      }
    } catch (e) {
      console.warn(`Form field "${name}" could not be set`, e);
    }
  }
  if (flatten) form.flatten({ updateFieldAppearances: false });
}

function pinInheritedAttributes(page: PDFPage): void {
  const node = page.node;
  for (const k of ['MediaBox', 'CropBox', 'Rotate', 'Resources']) {
    const name = PDFName.of(k);
    if (!node.get(name)) {
      const v = node.getInheritableAttribute(name);
      if (v) node.set(name, v);
    }
  }
}

/** Replaces the document's page tree with a flat list of the given pages. */
function setPageOrder(doc: PDFDocument, pages: PDFPage[]): void {
  const ctx = doc.context;
  const rootRef = doc.catalog.get(PDFName.of('Pages')) as PDFRef;
  const root = doc.catalog.Pages();
  // Forget intermediate tree nodes; every page now hangs directly off the root.
  const stale: PDFRef[] = [];
  root.traverse((node, ref) => {
    if (node instanceof PDFPageTree) stale.push(ref);
  });
  for (const ref of stale) ctx.delete(ref);
  root.set(PDFName.of('Kids'), ctx.obj(pages.map((p) => p.ref)));
  root.set(PDFName.of('Count'), PDFNumber.of(pages.length));
  for (const p of pages) p.node.set(PDFName.of('Parent'), rootRef);
  // pdf-lib caches the page list; reset it so later lookups see the new order.
  const internal = doc as unknown as { pageCount?: number; pageCache: { invalidate(): void }; pageMap: Map<unknown, PDFPage> };
  internal.pageCount = pages.length;
  internal.pageCache.invalidate();
  for (const p of pages) internal.pageMap.set(p.node, p);
}

export async function buildPdf(input: ExportInput, opts: ExportOptions = {}): Promise<Uint8Array> {
  const { state, sources, primary } = input;
  const pages = state.pages;
  if (!pages.length) throw new Error('Document has no pages');
  const usesPrimary = !!primary && pages.some((p) => p.src === primary);

  const loaded = new Map<string, Promise<PDFDocument>>();
  const load = (id: string) => {
    let d = loaded.get(id);
    if (!d) {
      const data = sources.get(id);
      if (!data) throw new Error(`Missing source ${id}`);
      d = loadPdfLib(data);
      loaded.set(id, d);
    }
    return d;
  };

  const base = usesPrimary ? await load(primary!) : await PDFDocument.create();
  base.registerFontkit(fontkit);
  const res = new Resources(base, input.assets);

  // 1. Form values (on the original pages, before restructuring).
  if (usesPrimary && (Object.keys(state.form).length || opts.flattenForms)) {
    applyForm(base, state.form, await res.font('sans', false), !!opts.flattenForms);
  }

  // 2. Collect the final page objects.
  const original = usesPrimary ? base.getPages() : [];
  original.forEach(pinInheritedAttributes);

  const usedOriginal = new Set<number>();
  type Need = { kind: 'orig'; index: number } | { kind: 'copy'; src: string; index: number };
  const needs: Need[] = pages.map((p) => {
    if (p.src === primary && usesPrimary && !usedOriginal.has(p.index)) {
      usedOriginal.add(p.index);
      return { kind: 'orig', index: p.index };
    }
    return { kind: 'copy', src: p.src, index: p.index };
  });

  // Copy pages in batches per source so shared resources (fonts, images) are copied
  // once. A page needed twice from the same source goes into a later batch, because
  // within one batch pdf-lib would hand back the very same copy.
  const batches = new Map<string, { src: string; indices: number[] }>();
  const seen = new Map<string, number>();
  const batchOf: (string | null)[] = needs.map((n) => {
    if (n.kind !== 'copy') return null;
    const k = `${n.src}:${n.index}`;
    const round = seen.get(k) ?? 0;
    seen.set(k, round + 1);
    const id = `${n.src}#${round}`;
    if (!batches.has(id)) batches.set(id, { src: n.src, indices: [] });
    batches.get(id)!.indices.push(n.index);
    return id;
  });
  const copied = new Map<string, PDFPage[]>();
  for (const [id, b] of batches) {
    const from = b.src === primary && usesPrimary ? base : await load(b.src);
    copied.set(id, await base.copyPages(from, b.indices));
  }
  const finalPages = needs.map((n, i) => (n.kind === 'orig' ? original[n.index] : copied.get(batchOf[i]!)!.shift()!));

  // 3. Rebuild the page tree in the new order.
  setPageOrder(base, finalPages);
  if (usesPrimary) dropOrphanFields(base);

  // 4. Rotation, annotations and decorations.
  const hasDecor = !!(state.watermark || state.numbering);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pg = finalPages[i];
    const info = input.pageInfo(p);
    const rotation = (info.rotate + p.rot) % 360;
    pg.setRotation(degrees(rotation));
    const anns = state.anns.filter((a) => a.pageId === p.id);
    if (!anns.length && !hasDecor) continue;
    pg.translateContent(0, 0); // isolates the original content's graphics state
    for (const a of anns) await drawAnnotation(base, pg, a, res);
    await drawDecorations(pg, info.view, rotation, state, i, pages.length, res);
  }

  // 5. Metadata.
  if (state.meta) {
    base.setTitle(state.meta.title, { showInWindowTitleBar: !!state.meta.title });
    base.setAuthor(state.meta.author);
    base.setSubject(state.meta.subject);
    base.setKeywords(state.meta.keywords ? state.meta.keywords.split(/\s*[,;]\s*/).filter(Boolean) : []);
  }
  base.setProducer(opts.producer ?? 'PDF Reader');
  base.setModificationDate(new Date());

  // 6. Redaction: pages with redacted areas are re-rendered from the finished
  //    document (so filled forms and markups survive) and replaced by images,
  //    which removes the hidden text and graphics for good.
  let doc = base;
  const redacted = pages
    .map((p, i) => ({ i, rects: state.anns.filter((a) => a.pageId === p.id && a.type === 'redact').map((a) => (a as { rect: Rect }).rect) }))
    .filter((r) => r.rects.length);
  if (redacted.length && opts.rasterize) {
    const firstPass = await base.save({ useObjectStreams: false, updateFieldAppearances: false });
    doc = await PDFDocument.load(firstPass, { updateMetadata: false });
    for (const r of redacted) await replaceWithImage(doc, r.i, await opts.rasterize(firstPass, r.i, r.rects));
    dropOrphanFields(doc);
  }

  // 7. Security.
  const pr = opts.protection;
  if (pr && (pr.userPassword || pr.ownerPassword)) {
    doc.encrypt({
      userPassword: pr.userPassword,
      ownerPassword: pr.ownerPassword || pr.userPassword,
      permissions: {
        printing: pr.allowPrint ? 'highResolution' : false,
        copying: pr.allowCopy,
        modifying: pr.allowEdit,
        annotating: pr.allowEdit,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: pr.allowEdit,
      },
    });
  }

  return doc.save({ useObjectStreams: true, updateFieldAppearances: false });
}

/** Removes form fields none of whose widgets are on a page any more. */
function dropOrphanFields(doc: PDFDocument): void {
  const present = new Set<string>();
  for (const pg of doc.getPages()) {
    const annots = pg.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef) present.add(ref.toString());
    }
  }
  try {
    const form = doc.getForm();
    for (const field of form.getFields()) {
      const refs = field.acroField.getWidgets().map((w) => doc.context.getObjectRef(w.dict)?.toString());
      if (refs.length && !refs.some((r) => r && present.has(r))) form.acroForm.removeField(field.acroField);
    }
  } catch (e) {
    console.warn('form cleanup skipped', e);
  }
}

/** Swaps page `i` for a single image of it, keeping size, rotation and comments. */
async function replaceWithImage(doc: PDFDocument, i: number, raster: Raster): Promise<void> {
  const old = doc.getPage(i);
  const media = old.getMediaBox();
  const crop = old.getCropBox();
  const x1 = Math.max(media.x, crop.x);
  const y1 = Math.max(media.y, crop.y);
  const x2 = Math.min(media.x + media.width, crop.x + crop.width);
  const y2 = Math.min(media.y + media.height, crop.y + crop.height);
  const rotation = old.getRotation().angle;
  const notes: PDFRef[] = [];
  const annots = old.node.Annots();
  for (let k = 0; annots && k < annots.size(); k++) {
    const ref = annots.get(k);
    const dict = doc.context.lookup(ref);
    if (ref instanceof PDFRef && dict instanceof PDFDict && dict.get(PDFName.of('Subtype'))?.toString() === '/Text') notes.push(ref);
  }
  const img = raster.mime === 'image/png' ? await doc.embedPng(raster.bytes) : await doc.embedJpg(raster.bytes);
  const pg = doc.insertPage(i, [x2 - x1, y2 - y1]);
  pg.setMediaBox(x1, y1, x2 - x1, y2 - y1);
  pg.drawImage(img, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  pg.setRotation(degrees(rotation));
  for (const ref of notes) {
    (doc.context.lookup(ref) as PDFDict).set(PDFName.of('P'), pg.ref);
    pg.node.addAnnot(ref);
  }
  doc.removePage(i + 1);
}

/** Creates a PDF from images (one page per image, page sized to the image). */
export async function imagesToPdf(images: { bytes: Uint8Array; mime: string; width: number; height: number }[], fit: 'image' | 'a4' = 'image'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const im of images) {
    const img = im.mime === 'image/png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    // 96 dpi screen pixels → points
    let w = (im.width * 72) / 96;
    let hh = (im.height * 72) / 96;
    if (fit === 'a4') {
      const [pw, ph] = im.width > im.height ? [842, 595] : [595, 842];
      const k = Math.min((pw - 40) / w, (ph - 40) / hh, 1);
      const page = doc.addPage([pw, ph]);
      page.drawImage(img, { x: (pw - w * k) / 2, y: (ph - hh * k) / 2, width: w * k, height: hh * k });
      continue;
    }
    w = Math.max(w, 1);
    hh = Math.max(hh, 1);
    doc.addPage([w, hh]).drawImage(img, { x: 0, y: 0, width: w, height: hh });
  }
  return doc.save();
}

export async function blankPdf(width = 595.28, height = 841.89, count = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([width, height]);
  return doc.save();
}

/** Copies the given pages of an existing PDF into a new file. */
export async function extractPages(data: SourceData, indices: number[]): Promise<Uint8Array> {
  const src = await loadPdfLib(data);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));
  return out.save({ useObjectStreams: true });
}
