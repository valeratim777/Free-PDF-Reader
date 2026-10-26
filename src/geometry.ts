import type { Annotation, Pt, QuarterTurn, Rect } from './model';

/** 2D affine matrix [a, b, c, d, e, f] — same convention as PDF and SVG. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function mul(m: Mat, n: Mat): Mat {
  // Returns m · n (apply n first, then m).
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function translateM(x: number, y: number): Mat {
  return [1, 0, 0, 1, x, y];
}

export function rotateM(deg: number): Mat {
  const r = (deg * Math.PI) / 180;
  const c = round6(Math.cos(r));
  const s = round6(Math.sin(r));
  return [c, s, -s, c, 0, 0];
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

export function rectW(r: Rect): number {
  return r.x2 - r.x1;
}

export function rectH(r: Rect): number {
  return r.y2 - r.y1;
}

export function unionRect(a: Rect, b: Rect): Rect {
  return { x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) };
}

export function inflate(r: Rect, d: number): Rect {
  return { x1: r.x1 - d, y1: r.y1 - d, x2: r.x2 + d, y2: r.y2 + d };
}

export function normTurn(deg: number): QuarterTurn {
  const v = (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
  return v as QuarterTurn;
}

/**
 * Local frame of an upright box. Content is laid out in (u, v) coordinates with
 * u to the right and v pointing *down*, size w × h. `rot` is the counter-clockwise
 * rotation (in user space) that makes the content look upright on screen.
 */
export interface Frame {
  ox: number;
  oy: number;
  w: number;
  h: number;
  cos: number;
  sin: number;
}

export function boxFrame(r: Rect, rot: QuarterTurn): Frame {
  const W = rectW(r);
  const H = rectH(r);
  switch (rot) {
    case 90:
      return { ox: r.x1, oy: r.y1, w: H, h: W, cos: 0, sin: 1 };
    case 180:
      return { ox: r.x2, oy: r.y1, w: W, h: H, cos: -1, sin: 0 };
    case 270:
      return { ox: r.x2, oy: r.y2, w: H, h: W, cos: 0, sin: -1 };
    default:
      return { ox: r.x1, oy: r.y2, w: W, h: H, cos: 1, sin: 0 };
  }
}

/** Inverse of boxFrame: given the content origin and its upright size, the user-space rect. */
export function rectFromFrame(ox: number, oy: number, w: number, h: number, rot: QuarterTurn): Rect {
  switch (rot) {
    case 90:
      return { x1: ox, y1: oy, x2: ox + h, y2: oy + w };
    case 180:
      return { x1: ox - w, y1: oy, x2: ox, y2: oy + h };
    case 270:
      return { x1: ox - h, y1: oy - w, x2: ox, y2: oy };
    default:
      return { x1: ox, y1: oy - h, x2: ox + w, y2: oy };
  }
}

/** Matrix mapping frame coordinates (u right, v down) to user space. */
export function frameMatrixDown(f: Frame): Mat {
  return [f.cos, f.sin, f.sin, -f.cos, f.ox, f.oy];
}

/** Matrix mapping frame coordinates (u right, y up) to user space — what a PDF content stream wants. */
export function frameMatrixUp(f: Frame): Mat {
  return [f.cos, f.sin, -f.sin, f.cos, f.ox, f.oy];
}

/**
 * The page as the reader sees it: given the page's view box and its total
 * rotation (clockwise on screen, as in /Rotate), returns a frame whose u/v axes
 * follow the visual page.
 */
export function pageFrame(view: [number, number, number, number], rotation: number): Frame {
  const r: Rect = normRect(view[0], view[1], view[2], view[3]);
  // A clockwise display rotation is compensated by a counter-clockwise content rotation.
  return boxFrame(r, normTurn(rotation));
}

/** Smoothed SVG path through points (quadratic curves through midpoints). */
export function smoothPath(pts: Pt[], flipY = false): string {
  const fy = (y: number) => (flipY ? -y : y);
  const f = (n: number) => +n.toFixed(2);
  if (pts.length === 0) return '';
  if (pts.length === 1) {
    const p = pts[0];
    return `M${f(p.x)} ${f(fy(p.y))} L${f(p.x + 0.01)} ${f(fy(p.y))}`;
  }
  if (pts.length === 2) {
    return `M${f(pts[0].x)} ${f(fy(pts[0].y))} L${f(pts[1].x)} ${f(fy(pts[1].y))}`;
  }
  let d = `M${f(pts[0].x)} ${f(fy(pts[0].y))}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const n = pts[i + 1];
    const mx = (p.x + n.x) / 2;
    const my = (p.y + n.y) / 2;
    d += ` Q${f(p.x)} ${f(fy(p.y))} ${f(mx)} ${f(fy(my))}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${f(last.x)} ${f(fy(last.y))}`;
  return d;
}

/** Drops points closer than `minDist` to the previous one (keeps first and last). */
export function simplify(pts: Pt[], minDist: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) >= minDist) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Triangle for an arrow head at p2, pointing away from p1. */
export function arrowHead(p1: Pt, p2: Pt, width: number): Pt[] {
  const len = Math.max(width * 4, 8);
  const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
  const spread = Math.PI / 7;
  return [
    { x: p2.x, y: p2.y },
    { x: p2.x - len * Math.cos(ang - spread), y: p2.y - len * Math.sin(ang - spread) },
    { x: p2.x - len * Math.cos(ang + spread), y: p2.y - len * Math.sin(ang + spread) },
  ];
}

export const NOTE_SIZE = 20;

export function annBBox(a: Annotation): Rect {
  switch (a.type) {
    case 'ink':
    case 'marker': {
      let r: Rect | null = null;
      for (const s of a.strokes)
        for (const p of s) {
          const pr = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
          r = r ? unionRect(r, pr) : pr;
        }
      return inflate(r ?? { x1: 0, y1: 0, x2: 0, y2: 0 }, a.width / 2);
    }
    case 'line':
    case 'arrow':
      return inflate(normRect(a.p1.x, a.p1.y, a.p2.x, a.p2.y), a.width / 2);
    case 'highlight':
    case 'underline':
    case 'strike':
      return a.rects.reduce(unionRect);
    case 'note':
      return { x1: a.at.x, y1: a.at.y - NOTE_SIZE, x2: a.at.x + NOTE_SIZE, y2: a.at.y };
    default:
      return a.rect;
  }
}

function mapRect(r: Rect, fn: (p: Pt) => Pt): Rect {
  const a = fn({ x: r.x1, y: r.y1 });
  const b = fn({ x: r.x2, y: r.y2 });
  return normRect(a.x, a.y, b.x, b.y);
}

/** Returns a copy of the annotation moved by (dx, dy) in user space. */
export function translateAnn<T extends Annotation>(a: T, dx: number, dy: number): T {
  const mv = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  const c = structuredClone(a) as Annotation;
  switch (c.type) {
    case 'ink':
    case 'marker':
      c.strokes = c.strokes.map((s) => s.map(mv));
      break;
    case 'line':
    case 'arrow':
      c.p1 = mv(c.p1);
      c.p2 = mv(c.p2);
      break;
    case 'highlight':
    case 'underline':
    case 'strike':
      c.rects = c.rects.map((r) => mapRect(r, mv));
      break;
    case 'note':
      c.at = mv(c.at);
      break;
    default:
      c.rect = mapRect(c.rect, mv);
  }
  return c as T;
}

/**
 * Returns a copy of the annotation whose bounding box `from` is mapped onto `to`.
 * Text and stamps scale their font size instead of stretching.
 */
export function scaleAnn<T extends Annotation>(a: T, from: Rect, to: Rect): T {
  const sx = rectW(from) > 1e-6 ? rectW(to) / rectW(from) : 1;
  const sy = rectH(from) > 1e-6 ? rectH(to) / rectH(from) : 1;
  const mp = (p: Pt): Pt => ({ x: to.x1 + (p.x - from.x1) * sx, y: to.y1 + (p.y - from.y1) * sy });
  const c = structuredClone(a) as Annotation;
  switch (c.type) {
    case 'ink':
    case 'marker':
      c.strokes = c.strokes.map((s) => s.map(mp));
      break;
    case 'line':
    case 'arrow':
      c.p1 = mp(c.p1);
      c.p2 = mp(c.p2);
      break;
    case 'highlight':
    case 'underline':
    case 'strike':
      c.rects = c.rects.map((r) => mapRect(r, mp));
      break;
    case 'note':
      c.at = { x: to.x1, y: to.y2 };
      break;
    case 'text':
    case 'stamp': {
      const k = c.rot % 180 === 0 ? sy : sx;
      const f = boxFrame(c.rect, c.rot);
      const o = mp({ x: f.ox, y: f.oy });
      c.size = Math.max(4, c.size * k);
      if (c.type === 'text') c.pad = c.pad * k;
      c.rect = rectFromFrame(o.x, o.y, f.w * k, f.h * k, c.rot);
      break;
    }
    default:
      c.rect = mapRect(c.rect, mp);
  }
  return c as T;
}

/** Distance from point p to segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInRect(p: Pt, r: Rect, tol = 0): boolean {
  return p.x >= r.x1 - tol && p.x <= r.x2 + tol && p.y >= r.y1 - tol && p.y <= r.y2 + tol;
}

/** Hit test in user space; `tol` is the tolerance in points. */
export function hitAnn(a: Annotation, p: Pt, tol: number): boolean {
  switch (a.type) {
    case 'ink':
    case 'marker':
      return a.strokes.some((s) =>
        s.length === 1
          ? Math.hypot(s[0].x - p.x, s[0].y - p.y) <= tol + a.width / 2
          : s.some((q, i) => i > 0 && distToSegment(p, s[i - 1], q) <= tol + a.width / 2),
      );
    case 'line':
    case 'arrow':
      return distToSegment(p, a.p1, a.p2) <= tol + a.width / 2;
    case 'highlight':
    case 'underline':
    case 'strike':
      return a.rects.some((r) => pointInRect(p, r, tol));
    case 'rect':
    case 'ellipse':
      if (a.fill) return pointInRect(p, a.rect, tol);
      return pointInRect(p, a.rect, tol + a.width / 2) && !pointInRect(p, inflate(a.rect, -(tol + a.width / 2)), 0);
    default:
      return pointInRect(p, annBBox(a), tol);
  }
}

/** Thickness of underline / strikeout relative to the marked line height. */
export function markupThickness(h: number): number {
  return Math.max(0.8, h * 0.07);
}

/** Text layout constants shared by the on-screen renderer and the PDF writer. */
export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_BASELINE = 0.95;

export function textBlockSize(lineWidths: number[], size: number, pad: number): { w: number; h: number } {
  const w = Math.max(size * 0.5, ...lineWidths) + pad * 2;
  const h = Math.max(1, lineWidths.length) * size * TEXT_LINE_HEIGHT + pad * 2;
  return { w, h };
}

export function baselineOf(line: number, size: number, pad: number): number {
  return pad + size * (TEXT_BASELINE + TEXT_LINE_HEIGHT * line);
}
