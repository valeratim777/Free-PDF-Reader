// Text of a PDF page as paragraphs, and translated text fitted back into them.
//
// pdf.js hands out the page text as small runs (a word, a part of a line).
// Translating them one by one would cut sentences apart, so runs are joined into
// lines and lines into paragraphs ("blocks"); each block is translated as a
// whole and the translation is laid out in the space the original took, with
// the same alignment and a font size reduced just enough to fit.
//
// No DOM in here: text measuring is passed in, so this is covered by unit tests.
import type { Pt, QuarterTurn, Rect } from '../model';
import { normRect, normTurn, TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../geometry';

/** The parts of a pdf.js text item that are used here. */
export interface TextItemIn {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  fontName?: string;
}

/** The parts of a pdf.js text style that are used here. */
export interface TextStyleIn {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

/** One line of text, in the coordinates of its writing direction: u along the baseline, v up. */
export interface TextLine {
  u0: number;
  u1: number;
  base: number;
  top: number;
  bottom: number;
  size: number;
  text: string;
  /** pdf.js name of the font most of the line is set in. */
  font: string;
}

export type Align = 'left' | 'center' | 'right';

export interface TextBlock {
  /** Direction of the text (counter-clockwise, user space). */
  rot: QuarterTurn;
  lines: TextLine[];
  text: string;
  size: number;
  font: string;
  align: Align;
  u0: number;
  u1: number;
  top: number;
  bottom: number;
  /** The area the original text covers, in user space. */
  rect: Rect;
  /** Position of the block's first run in the page's content (reading order). */
  order: number;
}

interface Run {
  u0: number;
  u1: number;
  base: number;
  top: number;
  bottom: number;
  size: number;
  str: string;
  font: string;
  order: number;
}

const COS: Record<QuarterTurn, number> = { 0: 1, 90: 0, 180: -1, 270: 0 };
const SIN: Record<QuarterTurn, number> = { 0: 0, 90: 1, 180: 0, 270: -1 };

/** Point given in the frame of text direction `rot` → user space. */
export function toUser(rot: QuarterTurn, u: number, v: number): Pt {
  const c = COS[rot];
  const s = SIN[rot];
  return { x: u * c - v * s, y: u * s + v * c };
}

function toFrame(rot: QuarterTurn, x: number, y: number): { u: number; v: number } {
  const c = COS[rot];
  const s = SIN[rot];
  return { u: x * c + y * s, v: -x * s + y * c };
}

function frameRect(rot: QuarterTurn, u0: number, u1: number, bottom: number, top: number): Rect {
  const a = toUser(rot, u0, bottom);
  const b = toUser(rot, u1, top);
  return normRect(a.x, a.y, b.x, b.y);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

function toRuns(items: TextItemIn[], styles: Record<string, TextStyleIn>): Map<QuarterTurn, Run[]> {
  const out = new Map<QuarterTurn, Run[]>();
  items.forEach((it, order) => {
    const str = it.str;
    const m = it.transform;
    if (typeof str !== 'string' || !str.trim() || !m || m.length < 6) return;
    const style = styles[it.fontName ?? ''] ?? {};
    if (style.vertical) return;
    const [a, b, c, d, e, f] = m;
    const size = Math.hypot(c, d) || it.height || 0;
    const width = it.width ?? 0;
    if (!(size > 0.5) || !(width > 0)) return;
    // Only text that runs along a page edge; slanted text stays as it is.
    const ang = (Math.atan2(b, a) * 180) / Math.PI;
    const rot = normTurn(ang);
    if (Math.abs(((((ang - rot) % 360) + 540) % 360) - 180) > 3) return;
    // Mirrored text (its "up" pointing down) is skipped as well.
    const up = toFrame(rot, c, d);
    if (up.v <= 0) return;
    const p = toFrame(rot, e, f);
    const asc = clamp(style.ascent || 0.8, 0.5, 1.15);
    const desc = clamp(style.descent || -0.2, -0.45, 0);
    const list = out.get(rot) ?? [];
    list.push({ u0: p.u, u1: p.u + width, base: p.v, top: p.v + asc * size, bottom: p.v + desc * size, size, str, font: it.fontName ?? '', order });
    out.set(rot, list);
  });
  return out;
}

/** Joins runs that share a baseline (with superscripts) and sit close together into lines. */
function buildLines(runs: Run[]): { line: TextLine; order: number }[] {
  const sorted = [...runs].sort((p, q) => q.base - p.base || p.u0 - q.u0);
  const groups: { runs: Run[]; base: number; size: number; u0: number; u1: number }[] = [];
  for (const r of sorted) {
    let best: (typeof groups)[number] | null = null;
    let bestD = Infinity;
    for (let i = groups.length - 1; i >= Math.max(0, groups.length - 60); i--) {
      const g = groups[i];
      const big = Math.max(g.size, r.size);
      const dv = Math.abs(g.base - r.base);
      if (dv > 0.4 * big) continue;
      // Columns and table cells are separated by wider gaps than words.
      const gap = 1.5 * big;
      if (r.u0 > g.u1 + gap || r.u1 < g.u0 - gap) continue;
      if (dv < bestD) {
        best = g;
        bestD = dv;
      }
    }
    if (best) {
      best.runs.push(r);
      best.u0 = Math.min(best.u0, r.u0);
      best.u1 = Math.max(best.u1, r.u1);
      if (r.size > best.size * 1.05) {
        best.size = r.size;
        best.base = r.base;
      }
    } else groups.push({ runs: [r], base: r.base, size: r.size, u0: r.u0, u1: r.u1 });
  }

  return groups.map((g) => {
    const rs = g.runs.sort((p, q) => p.u0 - q.u0);
    let text = '';
    let end = -Infinity;
    let prev: Run | null = null;
    const kept: Run[] = [];
    for (const r of rs) {
      if (prev) {
        // The same text printed twice on top of itself (fake bold, shadows) is read once.
        const overlap = Math.min(prev.u1, r.u1) - Math.max(prev.u0, r.u0);
        if (r.str === prev.str && overlap > 0.5 * (r.u1 - r.u0)) continue;
        const gap = r.u0 - end;
        if (gap > 0.12 * Math.min(prev.size, r.size) && !/\s$/.test(text) && !/^\s/.test(r.str)) text += ' ';
      }
      text += r.str;
      end = Math.max(end, r.u1);
      prev = r;
      kept.push(r);
    }
    // The main text of the line decides its baseline, size and font (not a superscript or an icon).
    const big = Math.max(...kept.map((r) => r.size));
    const main = kept.filter((r) => r.size >= big * 0.8);
    const chars = new Map<string, number>();
    for (const r of main) chars.set(r.font, (chars.get(r.font) ?? 0) + r.str.length);
    const font = [...chars.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const anchor = main.reduce((a, b) => (b.str.length > a.str.length ? b : a));
    return {
      line: {
        u0: Math.min(...kept.map((r) => r.u0)),
        u1: Math.max(...kept.map((r) => r.u1)),
        base: anchor.base,
        top: Math.max(...kept.map((r) => r.top)),
        bottom: Math.min(...kept.map((r) => r.bottom)),
        size: median(main.map((r) => r.size)),
        text: text.replace(/\s+/g, ' ').trim(),
        font,
      },
      order: Math.min(...kept.map((r) => r.order)),
    };
  });
}

const LIST_START = /^(?:[•◦▪▫■□●○‣⁃∙·*►▶✓✔–—-]\s|\(?\d{1,3}[.)]\s|\(?[a-zа-я][.)]\s)/iu;
const SENTENCE_END = /[.!?…:;»"”)\]]$/u;

/** Words broken over two lines with a hyphen are joined back together. */
export function joinLines(lines: string[]): string {
  let text = '';
  for (const l of lines) {
    if (!text) text = l;
    else if (/\p{L}[-­]$/u.test(text) && /^\p{Ll}/u.test(l)) text = text.slice(0, -1) + l;
    else text += ' ' + l;
  }
  return text.replace(/­/g, '').replace(/\s+/g, ' ').trim();
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values);
}

function detectAlign(lines: TextLine[], areaL: number, areaR: number): Align {
  const size = median(lines.map((l) => l.size));
  if (lines.length >= 2) {
    // The last line of a paragraph is usually shorter, so only edges of full lines count.
    const full = lines.length > 2 ? lines.slice(0, -1) : lines;
    if (spread(full.map((l) => l.u0)) <= 0.6 * size) return 'left';
    if (spread(lines.map((l) => (l.u0 + l.u1) / 2)) <= 0.6 * size) return 'center';
    if (spread(lines.map((l) => l.u1)) <= 0.6 * size) return 'right';
    return 'left';
  }
  const l = lines[0];
  const w = areaR - areaL;
  if (w <= 0) return 'left';
  const c = (l.u0 + l.u1) / 2;
  if (l.u0 - areaL > 2 * l.size && Math.abs(c - (areaL + areaR) / 2) < 0.025 * w) return 'center';
  if (Math.abs(l.u1 - areaR) < 0.6 * l.size && l.u0 - areaL > 0.4 * w) return 'right';
  return 'left';
}

interface Draft {
  lines: TextLine[];
  u0: number;
  u1: number;
  pitch: number;
  open: boolean;
  order: number;
}

function startsNewParagraph(b: Draft, ln: TextLine): boolean {
  const last = b.lines[b.lines.length - 1];
  const size = last.size;
  if (LIST_START.test(ln.text)) return true;
  // Short lines set wide apart: rows of a table or a form rather than a wrapped paragraph.
  if (last.base - ln.base > 1.6 * size && last.text.split(' ').length <= 3) return true;
  // A one-line heading in its own font followed by body text.
  if (b.lines.length === 1 && last.font !== ln.font) return true;
  // A line that ends early although the next word would have fitted was broken on
  // purpose (table rows, form labels, addresses), not wrapped.
  if (Math.abs(ln.u0 - last.u0) < 0.6 * size) {
    const firstWord = ln.text.split(' ')[0];
    const charW = (ln.u1 - ln.u0) / Math.max(1, ln.text.length);
    if (Math.max(b.u1, ln.u1) - last.u1 > (firstWord.length + 1) * charW + 0.5 * size) return true;
  }
  if (!SENTENCE_END.test(last.text)) return false;
  // The previous paragraph ended with a short line, or this one starts with an indent.
  if (last.u1 < b.u1 - Math.max(2 * size, 0.12 * (b.u1 - b.u0))) return true;
  return ln.u0 > b.u0 + 0.8 * size && spread(b.lines.map((l) => l.u0)) < 0.3 * size;
}

/** Usual distance between lines of a paragraph on this page, relative to the font size. */
function typicalPitch(lines: TextLine[]): number {
  const ratios: number[] = [];
  for (const a of lines) {
    let best = Infinity;
    for (const b of lines) {
      const dy = a.base - b.base;
      if (dy <= 0.3 * a.size || dy >= best) continue;
      if (Math.max(a.size, b.size) / Math.min(a.size, b.size) > 1.2) continue;
      if (Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) <= 0) continue;
      best = dy;
    }
    const r = best / a.size;
    if (r >= 0.8 && r <= 3) ratios.push(r);
  }
  // The most common spacing; on a tie the tighter one (paragraph lines rather than table rows).
  const bins = new Map<number, number>();
  for (const r of ratios) bins.set(Math.round(r / 0.05), (bins.get(Math.round(r / 0.05)) ?? 0) + 1);
  let best = 0;
  let count = 0;
  for (const [k, n] of bins) {
    if (n > count || (n === count && k < best)) {
      best = k;
      count = n;
    }
  }
  return count ? best * 0.05 : 1.25;
}

function buildBlocks(entries: { line: TextLine; order: number }[], rot: QuarterTurn): TextBlock[] {
  const sorted = [...entries].sort((p, q) => q.line.base - p.line.base || p.line.u0 - q.line.u0);
  // Lines further apart than usual belong to different paragraphs.
  const maxPitch = clamp(typicalPitch(sorted.map((e) => e.line)) * 1.3, 1.4, 2.6);
  const drafts: Draft[] = [];
  for (const { line: ln, order } of sorted) {
    let best: Draft | null = null;
    let bestDy = Infinity;
    for (const b of drafts) {
      if (!b.open) continue;
      const last = b.lines[b.lines.length - 1];
      const big = Math.max(last.size, ln.size);
      const dy = last.base - ln.base;
      if (dy <= 0.3 * big || dy > maxPitch * big) continue;
      if (big / Math.min(last.size, ln.size) > 1.2) continue;
      // Lines of one paragraph are evenly spaced; a bigger gap starts the next one.
      if (b.lines.length >= 2 && (dy > b.pitch * 1.3 + 0.5 || dy < b.pitch * 0.75 - 0.5)) continue;
      const overlap = Math.min(b.u1, ln.u1) - Math.max(b.u0, ln.u0);
      if (overlap < 0.3 * Math.min(b.u1 - b.u0, ln.u1 - ln.u0)) continue;
      if (startsNewParagraph(b, ln)) continue;
      if (dy < bestDy) {
        best = b;
        bestDy = dy;
      }
    }
    let target: Draft;
    if (best) {
      if (best.lines.length === 1) best.pitch = bestDy;
      best.lines.push(ln);
      best.u0 = Math.min(best.u0, ln.u0);
      best.u1 = Math.max(best.u1, ln.u1);
      best.order = Math.min(best.order, order);
      target = best;
    } else {
      target = { lines: [ln], u0: ln.u0, u1: ln.u1, pitch: 0, open: true, order };
      drafts.push(target);
    }
    // A line under another paragraph ends that paragraph: later lines cannot jump over it.
    for (const b of drafts) {
      if (b === target || !b.open) continue;
      const overlap = Math.min(b.u1, ln.u1) - Math.max(b.u0, ln.u0);
      if (overlap > 0 && b.lines[b.lines.length - 1].base > ln.base) b.open = false;
    }
  }

  const all = drafts.flatMap((d) => d.lines);
  const areaL = Math.min(...all.map((l) => l.u0));
  const areaR = Math.max(...all.map((l) => l.u1));
  return drafts.map((d) => {
    const u0 = d.u0;
    const u1 = d.u1;
    const top = Math.max(...d.lines.map((l) => l.top));
    const bottom = Math.min(...d.lines.map((l) => l.bottom));
    const chars = new Map<string, number>();
    for (const l of d.lines) chars.set(l.font, (chars.get(l.font) ?? 0) + l.text.length);
    return {
      rot,
      lines: d.lines,
      text: joinLines(d.lines.map((l) => l.text)),
      size: median(d.lines.map((l) => l.size)),
      font: [...chars.entries()].sort((a, b) => b[1] - a[1])[0][0],
      align: detectAlign(d.lines, areaL, areaR),
      u0,
      u1,
      top,
      bottom,
      rect: frameRect(rot, u0, u1, bottom, top),
      order: d.order,
    };
  });
}

/** Paragraphs of a page in reading order. */
export function pageBlocks(items: TextItemIn[], styles: Record<string, TextStyleIn> = {}): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const [rot, runs] of toRuns(items, styles)) blocks.push(...buildBlocks(buildLines(runs), rot));
  return blocks.sort((a, b) => a.order - b.order);
}

/** Worth sending to a translator: has words, not just numbers or symbols. */
export function isTranslatable(text: string): boolean {
  return /\p{L}{2,}/u.test(text);
}

/** Width of `text` at font size 1. */
export type Measure = (text: string) => number;

/** Breaks text into lines no wider than `maxW` (in units of `measure`). */
export function wrapText(text: string, maxW: number, measure: Measure): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const space = measure(' ');
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  const pushLong = (word: string) => {
    // A word longer than the line (a web address…) is cut where it has to be.
    let piece = '';
    for (const ch of word) {
      if (piece && measure(piece + ch) > maxW) {
        lines.push(piece);
        piece = '';
      }
      piece += ch;
    }
    cur = piece;
    curW = measure(piece);
  };
  for (const w of words) {
    const ww = measure(w);
    if (!cur) {
      if (ww > maxW) pushLong(w);
      else {
        cur = w;
        curW = ww;
      }
    } else if (curW + space + ww <= maxW) {
      cur += ' ' + w;
      curW += space + ww;
    } else {
      lines.push(cur);
      cur = '';
      curW = 0;
      if (ww > maxW) pushLong(w);
      else {
        cur = w;
        curW = ww;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export interface Fitted {
  size: number;
  lines: string[];
  widths: number[];
}

/** Smallest the text may get relative to the original size before it is allowed to overflow. */
const MIN_SCALE = 0.55;
/** Distance kept from the edges of the page when a translation spreads out. */
const PAGE_MARGIN = 28;

/** Free space around a block, in its frame: how far left, right and down a longer translation may spread. */
export interface Room {
  left: number;
  right: number;
  bottom: number;
}

/**
 * Where the translation of `b` may go without running into other text or off
 * the page (`view`: the page box in user space). Growing down is limited to
 * half the block's height plus a line.
 */
export function roomFor(b: TextBlock, all: TextBlock[], view?: number[]): Room {
  const size = b.size;
  let left: number;
  let right: number;
  let bottom: number;
  if (view && view.length >= 4) {
    const p = toFrame(b.rot, view[0], view[1]);
    const q = toFrame(b.rot, view[2], view[3]);
    left = Math.min(p.u, q.u) + PAGE_MARGIN;
    right = Math.max(p.u, q.u) - PAGE_MARGIN;
    bottom = Math.min(p.v, q.v) + PAGE_MARGIN;
  } else {
    const same = all.filter((o) => o.rot === b.rot);
    left = Math.min(...same.map((o) => o.u0));
    right = Math.max(...same.map((o) => o.u1));
    bottom = b.bottom;
  }
  for (const o of all) {
    if (o === b || o.rot !== b.rot) continue;
    if (Math.min(o.top, b.top) - Math.max(o.bottom, b.bottom) > 0) {
      // Text beside the block on the same lines.
      if (o.u0 >= b.u1 - 1) right = Math.min(right, o.u0 - 0.6 * size);
      else if (o.u1 <= b.u0 + 1) left = Math.max(left, o.u1 + 0.6 * size);
    } else if (o.top <= b.bottom + 1 && Math.min(o.u1, b.u1) - Math.max(o.u0, b.u0) > 0) {
      // Text below the block: keep some of the gap.
      bottom = Math.max(bottom, o.top + 0.5 * size);
    }
  }
  const lowest = b.bottom - 0.5 * (b.top - b.bottom) - TEXT_LINE_HEIGHT * size;
  return { left: Math.min(left, b.u0), right: Math.max(right, b.u1), bottom: Math.min(b.bottom, Math.max(bottom, lowest)) };
}

/** A translation may first get this much smaller to stay within the original lines. */
const GENTLE_SCALE = 0.85;

/**
 * Lays out `text` in the space of `block`: first baseline where the original one
 * was, wrapped to the paragraph's width (a single line may use the free `room`
 * beside it). The font gets a little smaller if that keeps the translation within
 * the original height; otherwise the free room below is used, and only then is
 * the font reduced further.
 */
export function fitText(
  text: string,
  block: Pick<TextBlock, 'u0' | 'u1' | 'bottom' | 'size' | 'lines' | 'align'>,
  measure: Measure,
  room?: Room,
): Fitted {
  const s0 = block.size;
  let width = block.u1 - block.u0;
  if (room && block.lines.length === 1) {
    const c = (block.u0 + block.u1) / 2;
    const free = block.align === 'left' ? room.right - block.u0 : block.align === 'right' ? block.u1 - room.left : 2 * Math.min(c - room.left, room.right - c);
    width = Math.max(width, free);
  }
  width = Math.max(width, s0 * 2);
  const base = block.lines[0].base;
  const layout = (s: number): Fitted => {
    const lines = wrapText(text, (width * 1.01) / s, measure);
    return { size: s, lines, widths: lines.map((l) => measure(l) * s) };
  };
  // Height from the first baseline to the bottom of the last line.
  const need = (f: Fitted) => (f.lines.length - 1) * TEXT_LINE_HEIGHT * f.size + (TEXT_LINE_HEIGHT - TEXT_BASELINE) * f.size;
  const attempt = (space: number, minScale: number): Fitted | null => {
    for (let s = s0; ; s = Math.max(s0 * minScale, s * 0.95)) {
      const f = layout(s);
      if (need(f) <= space) return f;
      if (s <= s0 * minScale) return null;
    }
  };
  const inside = base - block.bottom + 0.3 * s0;
  if (!room) return attempt(inside, MIN_SCALE) ?? layout(s0 * MIN_SCALE);
  return attempt(inside, GENTLE_SCALE) ?? attempt(base - room.bottom + 0.15 * s0, MIN_SCALE) ?? layout(s0 * MIN_SCALE);
}

export interface Placed {
  /** Top-left corner of the text box in user space. */
  origin: Pt;
  text: string;
  width: number;
  height: number;
}

/** Text boxes for the fitted translation: one box, or one per line when the original was centered or right-aligned. */
export function placeText(block: Pick<TextBlock, 'rot' | 'u0' | 'u1' | 'lines' | 'align'>, fit: Fitted): Placed[] {
  const s = fit.size;
  const vTop = block.lines[0].base + TEXT_BASELINE * s;
  const lineH = TEXT_LINE_HEIGHT * s;
  if (block.align === 'left' || fit.lines.length === 0) {
    const o = toUser(block.rot, block.u0, vTop);
    return [{ origin: o, text: fit.lines.join('\n'), width: Math.max(s * 0.5, ...fit.widths), height: fit.lines.length * lineH }];
  }
  return fit.lines.map((text, i) => {
    const w = fit.widths[i];
    const u = block.align === 'center' ? (block.u0 + block.u1) / 2 - w / 2 : block.u1 - w;
    return { origin: toUser(block.rot, u, vTop - i * lineH), text, width: Math.max(s * 0.5, w), height: lineH };
  });
}
