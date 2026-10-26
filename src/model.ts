// Core data types. All annotation geometry is stored in PDF user space
// (points, y axis pointing up) of the page it belongs to, so the same numbers
// can be used both for on-screen rendering and for writing the final PDF.

export interface Pt {
  x: number;
  y: number;
}

/** Axis-aligned rectangle in user space, always normalized (x1 < x2, y1 < y2). */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Quarter-turn rotation (degrees, counter-clockwise in user space). */
export type QuarterTurn = 0 | 90 | 180 | 270;

export type FontKey = 'sans' | 'serif' | 'mono';

interface AnnBase {
  id: string;
  pageId: string;
  color: string;
  opacity: number;
  author?: string;
  created: number;
}

export interface InkAnn extends AnnBase {
  type: 'ink' | 'marker';
  strokes: Pt[][];
  width: number;
}

export interface ShapeAnn extends AnnBase {
  type: 'rect' | 'ellipse';
  rect: Rect;
  width: number;
  fill: string | null;
}

export interface LineAnn extends AnnBase {
  type: 'line' | 'arrow';
  p1: Pt;
  p2: Pt;
  width: number;
}

export interface MarkupAnn extends AnnBase {
  type: 'highlight' | 'underline' | 'strike';
  rects: Rect[];
  rot: QuarterTurn;
  text?: string;
}

export interface TextAnn extends AnnBase {
  type: 'text';
  rect: Rect;
  rot: QuarterTurn;
  text: string;
  font: FontKey;
  bold: boolean;
  size: number;
  bg: string | null;
  pad: number;
}

export interface NoteAnn extends AnnBase {
  type: 'note';
  at: Pt;
  text: string;
}

export interface ImageAnn extends AnnBase {
  type: 'image' | 'signature';
  rect: Rect;
  rot: QuarterTurn;
  assetId: string;
}

export interface StampAnn extends AnnBase {
  type: 'stamp';
  rect: Rect;
  rot: QuarterTurn;
  label: string;
  size: number;
}

export interface CoverAnn extends AnnBase {
  type: 'whiteout' | 'redact';
  rect: Rect;
}

export type Annotation =
  | InkAnn
  | ShapeAnn
  | LineAnn
  | MarkupAnn
  | TextAnn
  | NoteAnn
  | ImageAnn
  | StampAnn
  | CoverAnn;

export type AnnType = Annotation['type'];

/** A page of the working document: a reference into one of the loaded sources. */
export interface DocPage {
  id: string;
  src: string;
  index: number;
  /** Rotation added by the user on top of the page's own /Rotate. */
  rot: QuarterTurn;
}

export type FormValue = string | string[];

export interface Watermark {
  text: string;
  size: number;
  color: string;
  opacity: number;
  angle: number;
}

export type NumberPosition = 'bottom-center' | 'bottom-right' | 'bottom-left' | 'top-center' | 'top-right' | 'top-left';

export interface PageNumbering {
  format: string;
  position: NumberPosition;
  size: number;
  start: number;
  color: string;
}

export interface DocMeta {
  title: string;
  author: string;
  subject: string;
  keywords: string;
}

/** Everything that is undoable lives here. */
export interface DocState {
  pages: DocPage[];
  anns: Annotation[];
  form: Record<string, FormValue>;
  watermark: Watermark | null;
  numbering: PageNumbering | null;
  meta: DocMeta | null;
}

export interface Asset {
  id: string;
  mime: 'image/png' | 'image/jpeg';
  bytes: Uint8Array;
  width: number;
  height: number;
  url: string;
}

export function emptyState(): DocState {
  return { pages: [], anns: [], form: {}, watermark: null, numbering: null, meta: null };
}

let counter = 0;
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}${counter}`;
}
