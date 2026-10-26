import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { buildPdf, blankPdf, extractPages, type ExportInput } from '../src/export/exporter';
import { setFontLoader } from '../src/fonts';
import { emptyState, type Annotation, type DocPage, type DocState } from '../src/model';

const fontDir = join(__dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf');

beforeAll(() => {
  setFontLoader(async (file) => new Uint8Array(readFileSync(join(fontDir, file))));
});

async function samplePdf(opts: { pages?: number; rotate?: number; form?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 2); i++) {
    const p = doc.addPage([600, 800]);
    p.drawText(`Original page ${i + 1}`, { x: 50, y: 700, size: 20, font });
    if (opts.rotate) p.setRotation(degrees(opts.rotate));
  }
  if (opts.form) {
    const form = doc.getForm();
    const tf = form.createTextField('name');
    tf.addToPage(doc.getPage(0), { x: 50, y: 500, width: 200, height: 24 });
    const cb = form.createCheckBox('agree');
    cb.addToPage(doc.getPage(0), { x: 50, y: 450, width: 16, height: 16 });
  }
  return doc.save();
}

async function infos(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const mb = p.getMediaBox();
    return { view: [mb.x, mb.y, mb.x + mb.width, mb.y + mb.height] as [number, number, number, number], rotate: p.getRotation().angle };
  });
}

async function makeInput(bytes: Uint8Array, state: Partial<DocState> & { pages: DocPage[] }): Promise<ExportInput> {
  const inf = await infos(bytes);
  return {
    state: { ...emptyState(), ...state },
    sources: new Map([['s1', { bytes }]]),
    primary: 's1',
    assets: new Map(),
    pageInfo: (p) => inf[p.index],
  };
}

async function textOf(bytes: Uint8Array, password?: string): Promise<string[]> {
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), password, useSystemFonts: false, disableFontFace: true }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await pdf.loadingTask.destroy();
  return out;
}

const base = { color: '#ff0000', opacity: 1, created: 0 };

describe('buildPdf', () => {
  it('reorders, duplicates, rotates and drops pages', async () => {
    const bytes = await samplePdf({ pages: 3 });
    const input = await makeInput(bytes, {
      pages: [
        { id: 'a', src: 's1', index: 2, rot: 90 },
        { id: 'b', src: 's1', index: 0, rot: 0 },
        { id: 'c', src: 's1', index: 0, rot: 180 },
      ],
    });
    const out = await buildPdf(input);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([90, 0, 180]);
    const text = await textOf(out);
    expect(text[0]).toContain('Original page 3');
    expect(text[1]).toContain('Original page 1');
    expect(text[2]).toContain('Original page 1');
  });

  it('writes Cyrillic text annotations and decorations as real text', async () => {
    const bytes = await samplePdf({ pages: 1 });
    const anns: Annotation[] = [
      { ...base, id: 't1', pageId: 'p', type: 'text', rect: { x1: 100, y1: 300, x2: 300, y2: 330 }, rot: 0, text: 'Привет, мир!\nSecond line', font: 'sans', bold: false, size: 14, bg: '#ffffff', pad: 2 },
      { ...base, id: 's1', pageId: 'p', type: 'stamp', rect: { x1: 300, y1: 100, x2: 450, y2: 140 }, rot: 0, label: 'УТВЕРЖДЕНО', size: 18 },
      { ...base, id: 'i1', pageId: 'p', type: 'ink', strokes: [[{ x: 10, y: 10 }, { x: 50, y: 60 }, { x: 90, y: 20 }]], width: 2 },
      { ...base, id: 'r1', pageId: 'p', type: 'rect', rect: { x1: 10, y1: 10, x2: 60, y2: 60 }, width: 2, fill: '#00ff00' },
      { ...base, id: 'e1', pageId: 'p', type: 'ellipse', rect: { x1: 10, y1: 10, x2: 60, y2: 60 }, width: 2, fill: null },
      { ...base, id: 'l1', pageId: 'p', type: 'arrow', p1: { x: 10, y: 10 }, p2: { x: 100, y: 100 }, width: 2 },
      { ...base, id: 'h1', pageId: 'p', type: 'highlight', rects: [{ x1: 50, y1: 690, x2: 200, y2: 720 }], rot: 0, opacity: 0.4 },
      { ...base, id: 'u1', pageId: 'p', type: 'underline', rects: [{ x1: 50, y1: 690, x2: 200, y2: 720 }], rot: 0 },
      { ...base, id: 'n1', pageId: 'p', type: 'note', at: { x: 500, y: 700 }, text: 'Комментарий' },
      { ...base, id: 'w1', pageId: 'p', type: 'whiteout', rect: { x1: 400, y1: 400, x2: 450, y2: 450 }, color: '#ffffff' },
    ];
    const input = await makeInput(bytes, {
      pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }],
      anns,
      watermark: { text: 'ЧЕРНОВИК', size: 60, color: '#888888', opacity: 0.3, angle: 45 },
      numbering: { format: 'Стр. {n} из {total}', position: 'bottom-center', size: 10, start: 1, color: '#000000' },
      meta: { title: 'Заголовок', author: 'Автор', subject: '', keywords: 'a, b' },
    });
    const out = await buildPdf(input);
    const [text] = await textOf(out);
    expect(text).toContain('Привет, мир!');
    expect(text).toContain('Second line');
    expect(text).toContain('УТВЕРЖДЕНО');
    expect(text).toContain('ЧЕРНОВИК');
    expect(text).toContain('Стр. 1 из 1');
    expect(text).toContain('Original page 1');

    const pdf = await pdfjs.getDocument({ data: out.slice() }).promise;
    const page = await pdf.getPage(1);
    const annots = await page.getAnnotations();
    const note = annots.find((a: { subtype: string }) => a.subtype === 'Text') as { contentsObj: { str: string } } | undefined;
    expect(note?.contentsObj.str).toBe('Комментарий');
    const meta = await pdf.getMetadata();
    expect((meta.info as { Title: string }).Title).toBe('Заголовок');
    await pdf.loadingTask.destroy();
  });

  it('keeps upright text on rotated pages', async () => {
    const bytes = await samplePdf({ pages: 1, rotate: 90 });
    const input = await makeInput(bytes, {
      pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }],
      anns: [{ ...base, id: 't', pageId: 'p', type: 'text', rect: { x1: 100, y1: 100, x2: 130, y2: 300 }, rot: 90, text: 'Upright', font: 'serif', bold: true, size: 20, bg: null, pad: 2 }],
    });
    const out = await buildPdf(input);
    const pdf = await pdfjs.getDocument({ data: out.slice() }).promise;
    const page = await pdf.getPage(1);
    expect(page.rotate).toBe(90);
    const tc = await page.getTextContent();
    const item = tc.items.find((i) => 'str' in i && i.str === 'Upright') as { transform: number[] } | undefined;
    expect(item).toBeTruthy();
    // Text direction in user space is +y (rotated 90° counter-clockwise), so the page's 90° clockwise display makes it upright.
    expect(Math.round(item!.transform[0])).toBe(0);
    expect(item!.transform[1]).toBeGreaterThan(0);
    await pdf.loadingTask.destroy();
  });

  it('fills form fields (including Cyrillic) and removes them when flattening', async () => {
    const bytes = await samplePdf({ pages: 1, form: true });
    const input = await makeInput(bytes, {
      pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }],
      form: { name: 'Иван Петров', agree: 'Yes' },
    });
    const out = await buildPdf(input);
    const doc = await PDFDocument.load(out);
    const form = doc.getForm();
    expect(form.getTextField('name').getText()).toBe('Иван Петров');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);

    const flat = await buildPdf(input, { flattenForms: true });
    const fdoc = await PDFDocument.load(flat);
    expect(fdoc.getForm().getFields().length).toBe(0);
    const [text] = await textOf(flat);
    expect(text).toContain('Иван Петров');
  });

  it('merges pages from a second document', async () => {
    const a = await samplePdf({ pages: 1 });
    const b = await samplePdf({ pages: 2 });
    const input = await makeInput(a, {
      pages: [
        { id: 'x', src: 's1', index: 0, rot: 0 },
        { id: 'y', src: 's2', index: 1, rot: 0 },
      ],
    });
    input.sources.set('s2', { bytes: b });
    const binf = await infos(b);
    const pageInfo = input.pageInfo;
    input.pageInfo = (p) => (p.src === 's2' ? binf[p.index] : pageInfo(p));
    const out = await buildPdf(input);
    const text = await textOf(out);
    expect(text).toHaveLength(2);
    expect(text[1]).toContain('Original page 2');
  });

  it('encrypts with a password', async () => {
    const bytes = await samplePdf({ pages: 1 });
    const input = await makeInput(bytes, { pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }] });
    const out = await buildPdf(input, {
      protection: { userPassword: 'секрет1', ownerPassword: '', allowPrint: true, allowCopy: false, allowEdit: false },
    });
    await expect(pdfjs.getDocument({ data: out.slice() }).promise).rejects.toThrow();
    const text = await textOf(out, 'секрет1');
    expect(text[0]).toContain('Original page 1');
  });

  it('opens an encrypted source with its password and saves it decrypted', async () => {
    const bytes = await samplePdf({ pages: 1 });
    const encrypted = await buildPdf(await makeInput(bytes, { pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }] }), {
      protection: { userPassword: 'pw', ownerPassword: 'owner', allowPrint: true, allowCopy: true, allowEdit: true },
    });
    const input = await makeInput(bytes, { pages: [{ id: 'p', src: 's1', index: 0, rot: 0 }] });
    input.sources.set('s1', { bytes: encrypted, password: 'pw' });
    const out = await buildPdf(input);
    const text = await textOf(out);
    expect(text[0]).toContain('Original page 1');
  });

  it('creates blank documents and extracts pages', async () => {
    const blank = await blankPdf(595.28, 841.89, 2);
    expect((await PDFDocument.load(blank)).getPageCount()).toBe(2);
    const src = await samplePdf({ pages: 3 });
    const part = await extractPages({ bytes: src }, [2]);
    expect(await textOf(part)).toEqual([expect.stringContaining('Original page 3')]);
  });
});

// 1×1 red PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

describe('redaction', () => {
  it('replaces redacted pages by images and keeps the rest intact', async () => {
    const bytes = await samplePdf({ pages: 2, form: true });
    const calls: { index: number; rects: number }[] = [];
    const input = await makeInput(bytes, {
      pages: [
        { id: 'a', src: 's1', index: 0, rot: 0 },
        { id: 'b', src: 's1', index: 1, rot: 90 },
      ],
      anns: [
        { ...base, id: 'r', pageId: 'a', type: 'redact', rect: { x1: 40, y1: 690, x2: 300, y2: 730 }, color: '#000000' },
        { ...base, id: 'n', pageId: 'a', type: 'note', at: { x: 500, y: 700 }, text: 'kept' },
      ],
      form: { name: 'Секрет' },
    });
    const out = await buildPdf(input, {
      rasterize: async (pdf, index, rects) => {
        // The first pass must already contain the filled form value.
        expect((await textOf(pdf))[index]).toContain('Original page 1');
        calls.push({ index, rects: rects.length });
        return { bytes: PNG, mime: 'image/png' };
      },
    });
    expect(calls).toEqual([{ index: 0, rects: 1 }]);
    const text = await textOf(out);
    expect(text[0]).not.toContain('Original page 1');
    expect(text[1]).toContain('Original page 2');
    const doc = await PDFDocument.load(out);
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90]);
    expect(doc.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
    // Widgets of the replaced page are gone, the comment survived.
    expect(doc.getForm().getFields().length).toBe(0);
    const pdf = await pdfjs.getDocument({ data: out.slice() }).promise;
    const annots = await (await pdf.getPage(1)).getAnnotations();
    expect(annots.map((a: { subtype: string }) => a.subtype)).toEqual(['Text']);
    await pdf.loadingTask.destroy();
  });
});
