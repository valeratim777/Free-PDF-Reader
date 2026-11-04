// Removes the original text under translated paragraphs from a page's content
// stream, so the saved translation does not carry the old text hidden under
// its covers (it would turn up when copying or searching in other programs).
//
// Deliberately cautious: a text-showing operator is removed only when its
// starting point is known exactly (it directly follows Td/TD/Tm/T*), nothing
// else is shown after it before the next positioning (so no following text
// shifts), it lies inside one of the given areas, and it holds no big jumps
// (which would mean it reaches into other areas). Anything unclear is kept: it
// stays hidden under the cover, as before. Streams with inline images, or that
// cannot be read, are not touched at all.
import type { Rect } from '../model';
import { IDENTITY, apply, mul, type Mat } from '../geometry';

type Arg = number | string | boolean | null | Arg[] | { kind: 'str' | 'dict' };

interface Op {
  op: string;
  args: Arg[];
  /** Byte range of the operands and the operator. */
  start: number;
  end: number;
}

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

class Unsupported extends Error {}

function skipLiteral(b: Uint8Array, i: number): number {
  let depth = 0;
  for (; i < b.length; i++) {
    const c = b[i];
    if (c === 92) i++; // backslash escape
    else if (c === 40) depth++;
    else if (c === 41 && --depth === 0) return i + 1;
  }
  throw new Unsupported('unterminated string');
}

function skipHex(b: Uint8Array, i: number): number {
  const j = b.indexOf(62, i + 1);
  if (j < 0) throw new Unsupported('unterminated hex string');
  return j + 1;
}

/** Skips a << … >> dictionary (with nested dictionaries and strings). */
function skipDict(b: Uint8Array, i: number): number {
  let depth = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === 60 && b[i + 1] === 60) {
      depth++;
      i += 2;
    } else if (c === 62 && b[i + 1] === 62) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else if (c === 40) i = skipLiteral(b, i);
    else if (c === 60) i = skipHex(b, i);
    else i++;
  }
  throw new Unsupported('unterminated dictionary');
}

function parse(b: Uint8Array): Op[] {
  const ops: Op[] = [];
  let args: Arg[] = [];
  let start = -1;
  const arrays: Arg[][] = [];
  const push = (v: Arg, at: number) => {
    if (arrays.length) arrays[arrays.length - 1].push(v);
    else {
      if (start < 0) start = at;
      args.push(v);
    }
  };
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (isWhite(c)) {
      i++;
      continue;
    }
    if (c === 37) {
      while (i < b.length && b[i] !== 10 && b[i] !== 13) i++;
      continue;
    }
    const at = i;
    if (c === 40) {
      i = skipLiteral(b, i);
      push({ kind: 'str' }, at);
    } else if (c === 60) {
      if (b[i + 1] === 60) {
        i = skipDict(b, i);
        push({ kind: 'dict' }, at);
      } else {
        i = skipHex(b, i);
        push({ kind: 'str' }, at);
      }
    } else if (c === 91) {
      if (!arrays.length && start < 0) start = at;
      arrays.push([]);
      i++;
    } else if (c === 93) {
      const arr = arrays.pop();
      if (!arr) throw new Unsupported('unbalanced array');
      i++;
      push(arr, at);
    } else if (c === 47) {
      i++;
      while (i < b.length && !isWhite(b[i]) && !isDelim(b[i])) i++;
      push(String.fromCharCode(...b.subarray(at, i)), at);
    } else if (c === 41 || c === 62 || c === 123 || c === 125) {
      throw new Unsupported('unexpected delimiter');
    } else {
      while (i < b.length && !isWhite(b[i]) && !isDelim(b[i])) i++;
      const word = String.fromCharCode(...b.subarray(at, i));
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) push(parseFloat(word), at);
      else if (word === 'true' || word === 'false') push(word === 'true', at);
      else if (word === 'null') push(null, at);
      else {
        if (arrays.length) throw new Unsupported('operator inside an array');
        // Inline images hold raw bytes that cannot be scanned reliably.
        if (word === 'BI' || word === 'ID') throw new Unsupported('inline image');
        ops.push({ op: word, args, start: start < 0 ? at : start, end: i });
        args = [];
        start = -1;
      }
    }
  }
  if (arrays.length) throw new Unsupported('unbalanced array');
  return ops;
}

const nums = (args: Arg[], n: number): number[] | null => {
  const tail = args.slice(-n);
  return tail.length === n && tail.every((a) => typeof a === 'number') ? (tail as number[]) : null;
};

function inside(p: { x: number; y: number }, rects: Rect[]): boolean {
  return rects.some((r) => p.x >= r.x1 - 0.5 && p.x <= r.x2 + 0.5 && p.y >= r.y1 - 0.5 && p.y <= r.y2 + 0.5);
}

/** A TJ array with a jump of more than an em reaches over a gap, maybe into another area. */
function hasJump(args: Arg[]): boolean {
  const arr = args[args.length - 1];
  return !Array.isArray(arr) || arr.some((a) => typeof a === 'number' && Math.abs(a) > 1000);
}

/**
 * The content stream without the text that starts inside `rects` (user space),
 * or null when nothing could be removed or the stream is not safe to change.
 */
export function stripText(content: Uint8Array, rects: Rect[]): Uint8Array | null {
  if (!rects.length) return null;
  let ops: Op[];
  try {
    ops = parse(content);
  } catch {
    return null;
  }

  let ctm: Mat = IDENTITY;
  let tm: Mat = IDENTITY;
  let tlm: Mat = IDENTITY;
  let leading = 0;
  let rise = 0;
  const stack: { ctm: Mat; leading: number; rise: number }[] = [];
  // The text shown since the last positioning: removable only if it is a single operator.
  let known = false;
  let chain: { index: number; ok: boolean }[] = [];
  const replace = new Map<number, string>();

  const settle = () => {
    if (chain.length === 1 && chain[0].ok) {
      const k = chain[0].index;
      const o = ops[k];
      if (o.op === "'") replace.set(k, 'T*');
      else if (o.op === '"') {
        // Keeps the word and character spacing it sets.
        const [aw, ac] = o.args;
        replace.set(k, typeof aw === 'number' && typeof ac === 'number' ? `${aw} Tw ${ac} Tc T*` : 'T*');
      } else replace.set(k, '');
    }
    chain = [];
  };
  const moveTo = (m: Mat) => {
    settle();
    tlm = m;
    tm = m;
    known = true;
  };
  const nextLine = () => moveTo(mul(tlm, [1, 0, 0, 1, 0, -leading]));

  for (let k = 0; k < ops.length; k++) {
    const { op, args } = ops[k];
    switch (op) {
      case 'q':
        stack.push({ ctm, leading, rise });
        break;
      case 'Q': {
        const s = stack.pop();
        if (s) ({ ctm, leading, rise } = s);
        break;
      }
      case 'cm': {
        const m = nums(args, 6);
        if (m) ctm = mul(ctm, m as Mat);
        break;
      }
      case 'BT':
        settle();
        tm = tlm = IDENTITY;
        known = true;
        break;
      case 'ET':
        settle();
        known = false;
        break;
      case 'Td':
      case 'TD': {
        const m = nums(args, 2);
        if (!m) return null;
        if (op === 'TD') leading = -m[1];
        moveTo(mul(tlm, [1, 0, 0, 1, m[0], m[1]]));
        break;
      }
      case 'Tm': {
        const m = nums(args, 6);
        if (!m) return null;
        moveTo(m as Mat);
        break;
      }
      case 'T*':
        nextLine();
        break;
      case 'TL': {
        const m = nums(args, 1);
        if (m) leading = m[0];
        break;
      }
      case 'Ts': {
        const m = nums(args, 1);
        if (m) rise = m[0];
        break;
      }
      case "'":
      case '"':
      case 'Tj':
      case 'TJ': {
        if (op === "'" || op === '"') nextLine();
        if (known) {
          const t = apply(tm, 0, rise);
          const p = apply(ctm, t.x, t.y);
          chain.push({ index: k, ok: inside(p, rects) && (op !== 'TJ' || !hasJump(args)) });
          known = false;
        } else chain.push({ index: k, ok: false });
        break;
      }
      default:
        break;
    }
  }
  settle();
  if (!replace.size) return null;

  // Copy the stream, leaving out (or rewriting) the removed operators.
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const [k, text] of [...replace.entries()].sort((a, b) => a[0] - b[0])) {
    const o = ops[k];
    parts.push(content.subarray(pos, o.start), enc.encode(` ${text} `));
    pos = o.end;
  }
  parts.push(content.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
