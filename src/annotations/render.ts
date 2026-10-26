// Builds SVG for annotations. The caller places the result inside a group whose
// transform is the page viewport matrix, so everything here is in user space.
import type { Annotation, Asset, MarkupAnn, PageNumbering, Watermark } from '../model';
import {
  arrowHead,
  baselineOf,
  boxFrame,
  frameMatrixDown,
  markupThickness,
  NOTE_SIZE,
  rectH,
  rectW,
  smoothPath,
  type Frame,
} from '../geometry';
import { cssFont } from '../fonts';
import { numberLayout, numberText, stampBox } from '../decor';

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  children: SVGElement[] = [],
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(c);
  return el;
}

const m = (f: Frame) => `matrix(${frameMatrixDown(f).join(' ')})`;

export function renderAnn(a: Annotation, assets: Map<string, Asset>): SVGGElement {
  const g = svg('g', { class: `ann ann-${a.type}`, 'data-id': a.id });
  switch (a.type) {
    case 'ink':
    case 'marker': {
      const style = a.type === 'marker' ? 'mix-blend-mode:multiply' : '';
      for (const s of a.strokes) {
        g.appendChild(
          svg('path', {
            d: smoothPath(s),
            fill: 'none',
            stroke: a.color,
            'stroke-width': a.width,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
            'stroke-opacity': a.opacity,
            style,
          }),
        );
      }
      break;
    }
    case 'rect':
    case 'ellipse': {
      const r = a.rect;
      const common = {
        fill: a.fill ?? 'none',
        'fill-opacity': a.opacity,
        stroke: a.width > 0 ? a.color : 'none',
        'stroke-width': a.width,
        'stroke-opacity': a.opacity,
      };
      if (a.type === 'rect') {
        g.appendChild(svg('rect', { x: r.x1, y: r.y1, width: rectW(r), height: rectH(r), ...common }));
      } else {
        g.appendChild(
          svg('ellipse', { cx: (r.x1 + r.x2) / 2, cy: (r.y1 + r.y2) / 2, rx: rectW(r) / 2, ry: rectH(r) / 2, ...common }),
        );
      }
      break;
    }
    case 'line':
    case 'arrow': {
      g.appendChild(
        svg('line', {
          x1: a.p1.x,
          y1: a.p1.y,
          x2: a.p2.x,
          y2: a.p2.y,
          stroke: a.color,
          'stroke-width': a.width,
          'stroke-linecap': 'round',
          'stroke-opacity': a.opacity,
        }),
      );
      if (a.type === 'arrow') {
        const h = arrowHead(a.p1, a.p2, a.width);
        g.appendChild(
          svg('polygon', {
            points: h.map((p) => `${p.x},${p.y}`).join(' '),
            fill: a.color,
            'fill-opacity': a.opacity,
            stroke: a.color,
            'stroke-width': a.width,
            'stroke-linejoin': 'round',
            'stroke-opacity': a.opacity,
          }),
        );
      }
      break;
    }
    case 'highlight':
    case 'underline':
    case 'strike':
      renderMarkup(g, a);
      break;
    case 'text': {
      const f = boxFrame(a.rect, a.rot);
      const inner = svg('g', { transform: m(f) });
      if (a.bg) inner.appendChild(svg('rect', { x: 0, y: 0, width: f.w, height: f.h, fill: a.bg }));
      a.text.split('\n').forEach((line, i) => {
        const tx = svg('text', {
          x: a.pad,
          y: baselineOf(i, a.size, a.pad),
          fill: a.color,
          'fill-opacity': a.opacity,
          'font-size': a.size,
          'font-weight': a.bold ? 700 : 400,
          style: `font-family:${cssFont(a.font)};white-space:pre`,
        });
        tx.textContent = line;
        inner.appendChild(tx);
      });
      g.appendChild(inner);
      break;
    }
    case 'note':
      g.appendChild(noteIcon(a.at.x, a.at.y, a.color));
      break;
    case 'image':
    case 'signature': {
      const f = boxFrame(a.rect, a.rot);
      const asset = assets.get(a.assetId);
      const inner = svg('g', { transform: m(f) });
      if (asset) {
        inner.appendChild(
          svg('image', { href: asset.url, x: 0, y: 0, width: f.w, height: f.h, preserveAspectRatio: 'none', opacity: a.opacity }),
        );
      } else {
        inner.appendChild(svg('rect', { x: 0, y: 0, width: f.w, height: f.h, fill: '#ccc' }));
      }
      g.appendChild(inner);
      break;
    }
    case 'stamp': {
      const f = boxFrame(a.rect, a.rot);
      const b = stampBox(0, a.size);
      const inner = svg('g', { transform: m(f), opacity: a.opacity });
      inner.appendChild(
        svg('rect', {
          x: b.border / 2,
          y: b.border / 2,
          width: f.w - b.border,
          height: f.h - b.border,
          rx: b.radius,
          fill: 'none',
          stroke: a.color,
          'stroke-width': b.border,
        }),
      );
      const tx = svg('text', {
        x: f.w / 2,
        y: b.baseline,
        'text-anchor': 'middle',
        fill: a.color,
        'font-size': a.size,
        'font-weight': 700,
        style: `font-family:${cssFont('sans')};white-space:pre`,
      });
      tx.textContent = a.label;
      inner.appendChild(tx);
      g.appendChild(inner);
      break;
    }
    case 'whiteout':
      g.appendChild(svg('rect', { x: a.rect.x1, y: a.rect.y1, width: rectW(a.rect), height: rectH(a.rect), fill: a.color }));
      break;
    case 'redact':
      g.appendChild(
        svg('rect', {
          x: a.rect.x1,
          y: a.rect.y1,
          width: rectW(a.rect),
          height: rectH(a.rect),
          fill: '#000',
          stroke: '#e11d48',
          'stroke-width': 1,
          'stroke-dasharray': '4 2',
          'vector-effect': 'non-scaling-stroke',
        }),
      );
      break;
  }
  return g;
}

function renderMarkup(g: SVGGElement, a: MarkupAnn): void {
  for (const r of a.rects) {
    if (a.type === 'highlight') {
      g.appendChild(
        svg('rect', {
          x: r.x1,
          y: r.y1,
          width: rectW(r),
          height: rectH(r),
          fill: a.color,
          'fill-opacity': a.opacity,
          style: 'mix-blend-mode:multiply',
        }),
      );
      continue;
    }
    const f = boxFrame(r, a.rot);
    const th = markupThickness(f.h);
    const v = a.type === 'underline' ? f.h - th / 2 : f.h * 0.55;
    const inner = svg('g', { transform: m(f) });
    inner.appendChild(
      svg('line', { x1: 0, y1: v, x2: f.w, y2: v, stroke: a.color, 'stroke-width': th, 'stroke-opacity': a.opacity }),
    );
    g.appendChild(inner);
  }
}

/** Speech-bubble icon whose top-left corner sits at (x, y) in user space. */
export function noteIcon(x: number, y: number, color: string): SVGGElement {
  const s = NOTE_SIZE;
  const g = svg('g', { transform: `translate(${x} ${y}) scale(1 -1)` });
  g.appendChild(
    svg('path', {
      d: `M2 2 H${s - 2} V${s - 6} H9 L4 ${s - 1} V${s - 6} H2 Z`,
      fill: color,
      stroke: '#333',
      'stroke-width': 1,
      'stroke-linejoin': 'round',
    }),
  );
  g.appendChild(svg('path', { d: `M5 6 H${s - 5} M5 10 H${s - 5}`, stroke: '#333', 'stroke-width': 1.2 }));
  return g;
}

export function renderWatermark(f: Frame, w: Watermark): SVGGElement {
  const g = svg('g', { transform: `${m(f)} translate(${f.w / 2} ${f.h / 2}) rotate(${-w.angle})`, 'pointer-events': 'none' });
  const tx = svg('text', {
    x: 0,
    y: w.size * 0.35,
    'text-anchor': 'middle',
    fill: w.color,
    'fill-opacity': w.opacity,
    'font-size': w.size,
    'font-weight': 700,
    style: `font-family:${cssFont('sans')};white-space:pre`,
  });
  tx.textContent = w.text;
  g.appendChild(tx);
  return g;
}

export function renderNumber(f: Frame, n: PageNumbering, index: number, total: number): SVGGElement {
  const l = numberLayout(f, n.position, n.size);
  const g = svg('g', { transform: m(f), 'pointer-events': 'none' });
  const tx = svg('text', {
    x: l.x,
    y: l.y,
    'text-anchor': l.anchor,
    fill: n.color,
    'font-size': n.size,
    style: `font-family:${cssFont('sans')};white-space:pre`,
  });
  tx.textContent = numberText(n, index, total);
  g.appendChild(tx);
  return g;
}
