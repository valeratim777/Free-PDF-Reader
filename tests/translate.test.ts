import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fitText, isTranslatable, joinLines, pageBlocks, placeText, roomFor, wrapText, type TextItemIn } from '../src/translate/layout';
import { analyzeInk } from '../src/colors';
import { batches, googleEngine, MAX_QUERY, parseGoogle, splitLong, TranslateError, type HttpGet } from '../src/translate/engines';
import { fontFor, pdfWritable } from '../src/translate/languages';
import { boxFrame, rectFromFrame } from '../src/geometry';

/** A text run as pdf.js reports it: horizontal, `size` points, ~0.5 em per character. */
function run(str: string, x: number, y: number, size = 10, fontName = 'f1'): TextItemIn {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size, fontName };
}

/** Lines of a left-aligned paragraph, 12 pt apart. */
function para(lines: string[], x: number, y: number, size = 10, font = 'f1'): TextItemIn[] {
  return lines.map((l, i) => run(l, x, y - i * size * 1.2, size, font));
}

const measure = (s: string) => s.length * 0.5;

describe('paragraphs of a page', () => {
  it('joins wrapped lines into one paragraph and keeps separate paragraphs apart', () => {
    const items = [
      ...para(['The quick brown fox jumps over the lazy', 'dog and keeps running far away into', 'the forest.'], 50, 700),
      // A blank line between paragraphs.
      ...para(['Another paragraph starts here and goes on', 'for a second line.'], 50, 650),
    ];
    const blocks = pageBlocks(items);
    expect(blocks.map((b) => b.text)).toEqual([
      'The quick brown fox jumps over the lazy dog and keeps running far away into the forest.',
      'Another paragraph starts here and goes on for a second line.',
    ]);
    expect(blocks[0].lines).toHaveLength(3);
    expect(blocks[0].align).toBe('left');
    expect(blocks[0].rot).toBe(0);
  });

  it('puts words split by pdf.js back together on one line', () => {
    const items = [run('Hello', 50, 700), run('world', 50 + 5 * 5 + 3, 700), run('again.', 50 + 10 * 5 + 6, 700)];
    expect(pageBlocks(items).map((b) => b.text)).toEqual(['Hello world again.']);
  });

  it('keeps the two columns of a page apart', () => {
    const left = para(['Left column text that is long', 'and wraps onto a second line', 'here.'], 50, 700);
    const right = para(['Right column text that is long', 'and also wraps onto the next', 'line.'], 330, 700);
    const blocks = pageBlocks([...left, ...right]);
    expect(blocks.map((b) => b.text)).toEqual([
      'Left column text that is long and wraps onto a second line here.',
      'Right column text that is long and also wraps onto the next line.',
    ]);
  });

  it('separates a heading in another font and list items', () => {
    const items = [
      run('Introduction', 50, 720, 10, 'bold'),
      ...para(['This text follows the heading and is long', 'enough to wrap.'], 50, 708),
      ...para(['• first point of the list', '• second point of the list'], 50, 670),
    ];
    expect(pageBlocks(items).map((b) => b.text)).toEqual([
      'Introduction',
      'This text follows the heading and is long enough to wrap.',
      '• first point of the list',
      '• second point of the list',
    ]);
  });

  it('does not merge table rows that were broken on purpose', () => {
    // A line ends early although the next word would have fitted.
    expect(pageBlocks(para(['Name', 'Date of birth', 'Address of the place of residence'], 50, 700)).map((b) => b.text)).toEqual([
      'Name',
      'Date of birth',
      'Address of the place of residence',
    ]);
    // Rows further apart than the lines of the paragraphs on the page.
    const rows = ['Name', 'Date of birth', 'Place of residence'].map((l, i) => run(l, 50, 600 - i * 18));
    const text = para(['Some ordinary paragraph text that wraps', 'onto a second line of the page and', 'then a third one.'], 50, 700);
    expect(pageBlocks([...text, ...rows]).map((b) => b.text)).toEqual([
      'Some ordinary paragraph text that wraps onto a second line of the page and then a third one.',
      'Name',
      'Date of birth',
      'Place of residence',
    ]);
  });

  it('keeps short lines set wide apart (a table column) separate', () => {
    const rows = ['North', 'South', 'West'].map((l, i) => run(l, 72, 500 - i * 20, 11));
    expect(pageBlocks(rows).map((b) => b.text)).toEqual(['North', 'South', 'West']);
  });

  it('starts a new paragraph after a short last line', () => {
    const items = para(['A first paragraph that fills the whole', 'line and then ends.', 'A second paragraph with the same spacing', 'below it.'], 50, 700);
    expect(pageBlocks(items).map((b) => b.text)).toEqual([
      'A first paragraph that fills the whole line and then ends.',
      'A second paragraph with the same spacing below it.',
    ]);
  });

  it('joins words hyphenated at the end of a line', () => {
    expect(joinLines(['This is an exam-', 'ple of hyphen-', 'ation.'])).toBe('This is an example of hyphenation.');
    expect(joinLines(['North-', 'West'])).toBe('North- West');
  });

  const wide = 'Body text that spans the full width of the page area from the left margin to the right one.';

  it('recognizes centered lines', () => {
    const items = [run('A centered title', 224, 760, 14), ...para([wide, 'on several lines below the title.'], 50, 700)];
    const [title] = pageBlocks(items);
    expect(title.text).toBe('A centered title');
    expect(title.align).toBe('center');
  });

  it('handles text turned by 90 degrees', () => {
    // Baseline going up the page (as on a page rotated for landscape).
    const items: TextItemIn[] = [
      { str: 'Sideways text that wraps', transform: [0, 10, -10, 0, 300, 100], width: 120, height: 10, fontName: 'f1' },
      { str: 'onto a second line.', transform: [0, 10, -10, 0, 312, 100], width: 95, height: 10, fontName: 'f1' },
    ];
    const [b] = pageBlocks(items);
    expect(b.rot).toBe(90);
    expect(b.text).toBe('Sideways text that wraps onto a second line.');
    // The block spans from the first baseline leftwards (up in the text) to the second line.
    expect(b.rect.y1).toBeCloseTo(100);
    expect(b.rect.y2).toBeCloseTo(220);
    const placed = placeText(b, fitText('Текст сбоку, который переносится на вторую строку.', b, measure));
    const r = rectFromFrame(placed[0].origin.x, placed[0].origin.y, placed[0].width, placed[0].height, b.rot);
    const f = boxFrame(r, b.rot);
    // Same corner back, and the box lies over the original text.
    expect(f.ox).toBeCloseTo(placed[0].origin.x);
    expect(f.oy).toBeCloseTo(placed[0].origin.y);
    expect(r.y1).toBeCloseTo(100);
    expect(r.x2).toBeGreaterThan(300);
  });

  it('skips slanted and empty text and knows what is worth translating', () => {
    const items: TextItemIn[] = [{ str: 'Slanted', transform: [7, 7, -7, 7, 100, 100], width: 40, height: 10 }, { str: '   ', transform: [10, 0, 0, 10, 0, 0], width: 5 }];
    expect(pageBlocks(items)).toEqual([]);
    expect(isTranslatable('Page 12')).toBe(true);
    expect(isTranslatable('12.05.2024 — 3 / 4')).toBe(false);
  });
});

describe('fitting the translation', () => {
  const block = pageBlocks(para(['The quick brown fox jumps over the lazy', 'dog and runs.'], 50, 700))[0];

  it('keeps the original size when the translation fits', () => {
    const fit = fitText('Short text.', block, measure);
    expect(fit.size).toBe(10);
    expect(fit.lines).toEqual(['Short text.']);
  });

  it('wraps to the paragraph width and shrinks the font when needed', () => {
    const long = 'Быстрая коричневая лиса перепрыгивает через ленивую собаку и убегает далеко-далеко в лес.';
    const fit = fitText(long, block, measure);
    expect(fit.size).toBeLessThan(10);
    expect(fit.size).toBeGreaterThanOrEqual(5.5 - 1e-9);
    const width = block.u1 - block.u0;
    for (const w of fit.widths) expect(w).toBeLessThanOrEqual(width * 1.01 + 1e-6);
    // Fits into the original height (with a little slack).
    expect((fit.lines.length - 1) * 1.2 * fit.size + 0.25 * fit.size).toBeLessThanOrEqual(block.lines[0].base - block.bottom + 3);
  });

  it('lets a single line spread into the free space beside it instead of shrinking', () => {
    const items = [run('Main goals:', 72, 600), ...para(['A paragraph below the heading that is long', 'enough to wrap.'], 72, 586)];
    const blocks = pageBlocks(items);
    const [label] = blocks;
    const room = roomFor(label, blocks, [0, 0, 595, 842]);
    expect(room.right).toBeCloseTo(595 - 28);
    // Blocked by the paragraph right below it: hardly any room to grow down.
    expect(label.bottom - room.bottom).toBeLessThan(2);
    const longer = 'Основные цели на следующий квартал:';
    expect(fitText(longer, label, measure).size).toBeLessThan(10);
    const fit = fitText(longer, label, measure, room);
    expect(fit.size).toBe(10);
    expect(fit.lines).toHaveLength(1);
  });

  it('lets a paragraph grow a little into empty space below it', () => {
    const [b] = pageBlocks(para(['Short paragraph at the end of the page', 'that has two lines.'], 72, 300));
    const room = roomFor(b, [b], [0, 0, 595, 842]);
    expect(room.bottom).toBeLessThan(b.bottom);
    expect(room.bottom).toBeGreaterThanOrEqual(b.bottom - 0.5 * (b.top - b.bottom) - 12 - 1e-9);
    // A bit longer: the font gets slightly smaller and the paragraph keeps its two lines.
    const text = 'Короткий абзац в конце страницы, у которого после перевода стало три строки.';
    const gentle = fitText(text, b, measure, room);
    expect(gentle.size).toBeLessThan(10);
    expect(gentle.size).toBeGreaterThanOrEqual(8.5);
    expect(gentle.lines).toHaveLength(2);
    // Much longer: the free space below is used at the original size.
    const long = text + ' Ещё одно предложение, чтобы текст точно не уместился.';
    expect(fitText(long, b, measure).size).toBeLessThan(8.5);
    const grown = fitText(long, b, measure, room);
    expect(grown.size).toBe(10);
    expect(grown.lines.length).toBeGreaterThan(2);
  });

  it('wraps words and cuts words longer than a line', () => {
    expect(wrapText('one two three four', 4, measure)).toEqual(['one two', 'three', 'four']);
    expect(wrapText('abcdefghij', 2, measure)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('places centered lines one by one around the center', () => {
    const body = 'Body text that spans the full width of the page area from the left margin to the right one.';
    const items = [run('A centered title', 224, 760, 14), ...para([body, 'below.'], 50, 700)];
    const [title] = pageBlocks(items);
    expect(title.align).toBe('center');
    const fit = fitText('Заголовок', title, measure);
    const [p] = placeText(title, fit);
    expect(p.origin.x + p.width / 2).toBeCloseTo((title.u0 + title.u1) / 2);
    // The first baseline stays where the original one was.
    expect(p.origin.y - 0.95 * fit.size).toBeCloseTo(760);
  });
});

describe('on a real PDF read by pdf.js', () => {
  it('finds the paragraphs', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595, 842]);
    page.drawText('Annual report', { x: 72, y: 760, size: 18, font: bold });
    const body = [
      'Our company had a good year. Sales grew in every region and',
      'we opened three new offices. The team grew to forty people.',
    ];
    body.forEach((l, i) => page.drawText(l, { x: 72, y: 720 - i * 14, size: 11, font }));
    page.drawText('Thank you for your trust.', { x: 72, y: 670, size: 11, font });
    const side = doc.addPage([842, 595]);
    side.setRotation(degrees(90));
    side.drawText('Rotated page text', { x: 300, y: 100, size: 12, font, rotate: degrees(90) });
    const pdf = await pdfjs.getDocument({ data: await doc.save(), useSystemFonts: false, disableFontFace: true }).promise;
    const tc = await (await pdf.getPage(1)).getTextContent();
    const blocks = pageBlocks(tc.items as TextItemIn[], tc.styles);
    expect(blocks.map((b) => b.text)).toEqual([
      'Annual report',
      'Our company had a good year. Sales grew in every region and we opened three new offices. The team grew to forty people.',
      'Thank you for your trust.',
    ]);
    expect(blocks[1].size).toBeCloseTo(11);
    expect(blocks[1].rect.x1).toBeCloseTo(72, 0);
    const tc2 = await (await pdf.getPage(2)).getTextContent();
    const [rotated] = pageBlocks(tc2.items as TextItemIn[], tc2.styles);
    expect(rotated.text).toBe('Rotated page text');
    expect(rotated.rot).toBe(90);
    await pdf.loadingTask.destroy();
  });
});

describe('colors of the original text', () => {
  it('reads background and text colors exactly', () => {
    const w = 20;
    const h = 12;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const ink = i % w >= 5 && i % w < 7;
      data.set(ink ? [200, 20, 20, 255] : [255, 255, 255, 255], i * 4);
    }
    const ink = analyzeInk(data, w, h, 10);
    expect(ink.bg).toBe('#ffffff');
    expect(ink.fg).toBe('#c81414');
    expect(ink.stem).toBeCloseTo(0.2);
  });
});

describe('languages', () => {
  it('knows which translations can be written into the PDF', () => {
    expect(pdfWritable('de')).toBe(true);
    expect(pdfWritable('ru')).toBe(true);
    expect(pdfWritable('ja')).toBe(false);
    expect(pdfWritable('ar')).toBe(false);
    expect(fontFor('vi', 'mono')).toBe('sans');
    expect(fontFor('de', 'mono')).toBe('mono');
  });
});

describe('Google Translate', () => {
  afterEach(() => vi.useRealTimers());

  /** Answers like the service: each line "translated" to upper case. */
  function fakeGoogle(log: string[] = []): HttpGet {
    return async (url) => {
      const u = new URL(url);
      const q = u.searchParams.get('q')!;
      log.push(q);
      const segs = q.split('\n').map((line, i, all) => [line.toUpperCase() + (i < all.length - 1 ? '\n' : ''), line, null, null, 10]);
      return { status: 200, body: JSON.stringify([segs, null, u.searchParams.get('sl') === 'auto' ? 'en' : u.searchParams.get('sl')]) };
    };
  }

  it('reads the translation out of the response', () => {
    expect(parseGoogle('[[["Привет, ","Hello, ",null,null,10],["мир.","world.",null,null,10]],null,"en"]')).toBe('Привет, мир.');
    expect(() => parseGoogle('{"error":1}')).toThrow(TranslateError);
  });

  it('sends several paragraphs in one request and keeps their order', async () => {
    const log: string[] = [];
    const engine = googleEngine('auto', 'ru', fakeGoogle(log));
    const out = await engine.translate(['first one', 'second\nline', 'third'], new AbortController().signal);
    expect(out).toEqual(['FIRST ONE', 'SECOND LINE', 'THIRD']);
    expect(log).toEqual(['first one\nsecond line\nthird']);
  });

  it('splits long texts and big batches over several requests', async () => {
    const log: string[] = [];
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const pieces = splitLong(long);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(encodeURIComponent(p).length).toBeLessThanOrEqual(MAX_QUERY);
    expect(pieces.join(' ')).toBe(long);
    const engine = googleEngine('en', 'de', fakeGoogle(log));
    const [res, other] = await engine.translate([long, 'tail'], new AbortController().signal);
    expect(res).toBe(long.toUpperCase());
    expect(other).toBe('TAIL');
    expect(log.length).toBeGreaterThan(1);
    expect(batches(['a', 'b', 'c'], 5)).toEqual([[0, 1], [2]]);
  });

  it('falls back to one request per paragraph when lines get merged', async () => {
    const http: HttpGet = async (url) => {
      const q = new URL(url).searchParams.get('q')!;
      // Pretend the service joined all lines into one.
      return { status: 200, body: JSON.stringify([[[q.replace(/\n/g, ' ').toUpperCase(), q]]]) };
    };
    const out = await googleEngine('auto', 'ru', http).translate(['one', 'two'], new AbortController().signal);
    expect(out).toEqual(['ONE', 'TWO']);
  });

  it('waits and retries when the service is busy, then reports the limit', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const busyOnce: HttpGet = async (url) => (++calls === 1 ? { status: 429, body: '' } : fakeGoogle()(url, new AbortController().signal));
    const p = googleEngine('auto', 'ru', busyOnce).translate(['hello'], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toEqual(['HELLO']);

    const alwaysBusy: HttpGet = async () => ({ status: 429, body: '' });
    const q = googleEngine('auto', 'ru', alwaysBusy).translate(['hello'], new AbortController().signal);
    const caught = q.catch((e) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    const err = await caught;
    expect(err).toBeInstanceOf(TranslateError);
    expect((err as TranslateError).code).toBe('limit');
  });

  it('reports a missing connection', async () => {
    vi.useFakeTimers();
    const offline: HttpGet = async () => {
      throw new TypeError('Failed to fetch');
    };
    const caught = googleEngine('auto', 'ru', offline)
      .translate(['hello'], new AbortController().signal)
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await caught) as TranslateError).code).toBe('offline');
  });

  it('stops the other requests when one fails', async () => {
    let aborted = 0;
    let calls = 0;
    const http: HttpGet = (url, signal) => {
      calls++;
      if (calls === 1) return Promise.resolve({ status: 400, body: '' });
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => {
          aborted++;
          reject(new DOMException('Aborted', 'AbortError'));
        }),
      );
    };
    const big = 'x'.repeat(3000);
    const err = await googleEngine('auto', 'ru', http)
      .translate([big, big, big], new AbortController().signal)
      .catch((e) => e);
    expect((err as TranslateError).code).toBe('service');
    expect(aborted).toBe(1);
    expect(calls).toBe(2);
  });

  it('stops when cancelled', async () => {
    const ctrl = new AbortController();
    const slow: HttpGet = (_url, signal) =>
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    const p = googleEngine('auto', 'ru', slow).translate(['hello'], ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});
