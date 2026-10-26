// Signatures, stamps and pictures placed on pages.
import { store } from '../store';
import { uid, type Pt, type QuarterTurn } from '../model';
import { boxFrame, normTurn, rectFromFrame } from '../geometry';
import { ensureCssFont } from '../fonts';
import { authorName, stampRect, type Tools } from '../annotations/tools';
import type { PageView } from '../viewer/pageView';
import { dialog, h, pickFiles, toast } from '../ui/dom';
import { imageToAsset, registerAsset } from './documents';
import { t } from '../i18n';

/** Origin of a w×h box (upright for rotation `rot`) centered on `at`. */
function centeredOrigin(at: Pt, w: number, hh: number, rot: QuarterTurn): Pt {
  const { cos, sin } = boxFrame({ x1: 0, y1: 0, x2: 1, y2: 1 }, rot);
  // origin + (w/2)·U + (h/2)·V = at, with U = (cos, sin), V = (sin, -cos)
  return { x: at.x - (w / 2) * cos - (hh / 2) * sin, y: at.y - (w / 2) * sin + (hh / 2) * cos };
}

function placeImage(tools: Tools, assetId: string, aspect: number, type: 'image' | 'signature', targetW: number): void {
  tools.placeNext((pv: PageView, at: Pt) => {
    const rot = normTurn(pv.rotation);
    const w = targetW;
    const hh = w / aspect;
    const o = centeredOrigin(at, w, hh, rot);
    const a = {
      id: uid('a'),
      pageId: pv.page.id,
      color: '#000000',
      opacity: 1,
      created: Date.now(),
      author: authorName() || undefined,
      type,
      rect: rectFromFrame(o.x, o.y, w, hh, rot),
      rot,
      assetId,
    };
    store.addAnn(a);
    tools.setTool('select');
    tools.select(a.id);
  });
}

export async function insertImage(tools: Tools): Promise<void> {
  const [file] = await pickFiles('image/*', false);
  if (!file) return tools.setTool('select');
  try {
    const asset = registerAsset(await imageToAsset(file));
    const w = Math.min(240, (asset.width * 72) / 96);
    placeImage(tools, asset.id, asset.width / asset.height, 'image', Math.max(24, w));
  } catch (e) {
    toast(String((e as Error).message), 'error');
    tools.setTool('select');
  }
}

// ---- signatures ----

const SIG_KEY = 'pr.signatures';

function savedSignatures(): string[] {
  try {
    return JSON.parse(localStorage.getItem(SIG_KEY) || '[]');
  } catch {
    return [];
  }
}

function storeSignatures(list: string[]): void {
  try {
    localStorage.setItem(SIG_KEY, JSON.stringify(list.slice(0, 6)));
  } catch {
    /* quota */
  }
}

/** Crops transparent margins. */
function trim(c: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = c.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 < 0) return null;
  const pad = 4;
  x1 = Math.max(0, x1 - pad);
  y1 = Math.max(0, y1 - pad);
  x2 = Math.min(width - 1, x2 + pad);
  y2 = Math.min(height - 1, y2 + pad);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext('2d')!.drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

export async function signatureFlow(tools: Tools): Promise<void> {
  const colors = ['#111827', '#1e3a8a', '#b91c1c'];
  let color = colors[1];
  let mode: 'draw' | 'type' | 'image' = 'draw';

  // draw pad
  const pad = h('canvas.sig-pad');
  let drawn = false;
  let last: { x: number; y: number } | null = null;
  const ctx = () => pad.getContext('2d')!;
  const resizePad = () => {
    const r = pad.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    pad.width = Math.max(1, Math.round(r.width * dpr));
    pad.height = Math.max(1, Math.round(r.height * dpr));
    const c = ctx();
    c.scale(dpr, dpr);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    drawn = false;
  };
  const pos = (e: PointerEvent) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    last = pos(e);
    const c = ctx();
    c.strokeStyle = color;
    c.fillStyle = color;
    c.beginPath();
    c.arc(last.x, last.y, 1.2, 0, Math.PI * 2);
    c.fill();
    drawn = true;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const c = ctx();
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      const p = pos(ev);
      const speed = Math.hypot(p.x - last.x, p.y - last.y);
      c.lineWidth = Math.max(1.4, 3.2 - speed * 0.08);
      c.strokeStyle = color;
      c.beginPath();
      c.moveTo(last.x, last.y);
      c.lineTo(p.x, p.y);
      c.stroke();
      last = p;
    }
  });
  const endStroke = () => (last = null);
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);

  // typed
  const nameInput = h('input.input', { placeholder: t('sigTypeHint'), value: authorName() });
  const typedPreview = h('div.sig-typed', {}, nameInput.value || ' ');
  nameInput.addEventListener('input', () => (typedPreview.textContent = nameInput.value || ' '));

  // image
  let uploaded: Blob | null = null;
  const uploadPreview = h('div.sig-typed', { style: 'font-family:inherit;font-size:14px' }, '—');
  const uploadBtn = h('button.btn', { type: 'button' }, t('sigUpload'));
  uploadBtn.addEventListener('click', async () => {
    const [f] = await pickFiles('image/*', false);
    if (!f) return;
    uploaded = f;
    uploadPreview.replaceChildren(h('img', { src: URL.createObjectURL(f), style: 'max-height:120px;max-width:100%' }));
  });

  const panes = {
    draw: h('div', {}, pad, h('div.color-row', {})),
    type: h('div', {}, nameInput, h('div', { style: 'height:10px' }), typedPreview, h('div.color-row', {})),
    image: h('div', {}, uploadBtn, h('div', { style: 'height:10px' }), uploadPreview),
  };
  const colorRows = [panes.draw.querySelector('.color-row')!, panes.type.querySelector('.color-row')!];
  const renderColors = () => {
    for (const row of colorRows) {
      row.replaceChildren(
        ...colors.map((c) =>
          h('button', {
            type: 'button',
            class: `swatch${c === color ? ' active' : ''}`,
            style: `background:${c}`,
            onclick: () => {
              color = c;
              typedPreview.style.color = c;
              renderColors();
            },
          }),
        ),
        h('span', { style: 'flex:1' }),
        row === colorRows[0] ? h('button.btn.btn-small', { type: 'button', onclick: () => resizePad() }, t('sigClear')) : '',
      );
    }
  };
  renderColors();
  typedPreview.style.color = color;

  const tabs = h('div.sig-tabs');
  const content = h('div');
  const setMode = (m: typeof mode) => {
    mode = m;
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
    content.replaceChildren(panes[m]);
    if (m === 'draw') requestAnimationFrame(resizePad);
  };
  for (const [m, label] of [
    ['draw', t('sigDraw')],
    ['type', t('sigType')],
    ['image', t('sigUpload')],
  ] as const) {
    tabs.append(h('button.btn.btn-small', { type: 'button', 'data-mode': m, onclick: () => setMode(m) }, label));
  }

  let chosen: string | null = null;
  const savedBox = h('div.sig-saved');
  const renderSaved = (close?: () => void) => {
    const list = savedSignatures();
    savedBox.replaceChildren(
      ...list.map((url, i) => {
        const item = h('div.sig-item', { title: t('sigUse') }, h('img', { src: url, alt: '' }));
        const del = h('button', { type: 'button', title: t('delete') }, '✕');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          storeSignatures(list.filter((_, j) => j !== i));
          renderSaved(close);
        });
        item.append(del);
        item.addEventListener('click', () => {
          chosen = url;
          close?.();
        });
        return item;
      }),
    );
  };

  const produce = async (): Promise<string | undefined> => {
    if (mode === 'draw') {
      if (!drawn) return undefined;
      const tr = trim(pad);
      return tr?.toDataURL('image/png');
    }
    if (mode === 'type') {
      const text = nameInput.value.trim();
      if (!text) return undefined;
      const c = document.createElement('canvas');
      const fontSize = 96;
      const family = getComputedStyle(typedPreview).fontFamily;
      const x = c.getContext('2d')!;
      x.font = `${fontSize}px ${family}`;
      c.width = Math.ceil(x.measureText(text).width + 40);
      c.height = Math.ceil(fontSize * 1.6);
      const y = c.getContext('2d')!;
      y.font = `${fontSize}px ${family}`;
      y.fillStyle = color;
      y.textBaseline = 'middle';
      y.fillText(text, 20, c.height / 2);
      return trim(c)?.toDataURL('image/png');
    }
    if (!uploaded) return undefined;
    const a = await imageToAsset(uploaded);
    const blob = new Blob([a.bytes.slice()], { type: a.mime });
    return await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.readAsDataURL(blob);
    });
  };

  const body = h('div', {}, tabs, content, h('div', { style: 'margin-top:12px;font-size:13px;color:var(--muted)' }, savedSignatures().length ? t('sigSaved') : ''), savedBox);
  const result = await dialog<string | null>({
    title: t('signatureTitle'),
    body,
    wide: false,
    dismissValue: null,
    onOpen: (box) => {
      setMode('draw');
      renderSaved(() => (box.querySelector('.btn-primary') as HTMLButtonElement)?.click());
    },
    actions: [
      { label: t('cancel'), value: null },
      {
        label: t('sigUse'),
        primary: true,
        value: async () => {
          if (chosen) return chosen;
          const url = await produce();
          if (!url) return undefined;
          storeSignatures([url, ...savedSignatures().filter((s) => s !== url)]);
          return url;
        },
      },
    ],
  });
  if (!result) {
    tools.setTool('select');
    return;
  }
  const asset = registerAsset(await imageToAsset(await dataUrlToBlob(result)));
  const w = Math.min(180, Math.max(60, (asset.width * 72) / 96 / 2.5));
  placeImage(tools, asset.id, asset.width / asset.height, 'signature', w);
}

// ---- stamps ----

export async function stampFlow(tools: Tools): Promise<void> {
  const presets: [string, string][] = [
    [t('stampApproved'), '#15803d'],
    [t('stampRejected'), '#b91c1c'],
    [t('stampDraft'), '#2563eb'],
    [t('stampConfidential'), '#b91c1c'],
    [t('stampFinal'), '#15803d'],
    [t('stampReviewed'), '#7c3aed'],
    [t('stampPaid'), '#15803d'],
    [t('stampCopy'), '#4b5563'],
    [`${t('stampDate')}: ${new Date().toLocaleDateString()}`, '#2563eb'],
  ];
  const pick: { v: [string, string] | null } = { v: null };
  const grid = h('div.stamp-grid');
  const custom = h('input.input', { placeholder: t('stampCustom') });
  const customColor = h('input.color-input', { type: 'color', value: '#b91c1c' });
  const r = await dialog<boolean>({
    title: t('stampTitle'),
    body: h('div', {}, grid, h('div', { style: 'height:12px' }), h('div.row', { style: 'align-items:center' }, custom, h('div', { style: 'flex:none' }, customColor))),
    onOpen: (box) => {
      for (const p of presets) {
        grid.append(
          h(
            'button.stamp-option',
            {
              type: 'button',
              style: `color:${p[1]}`,
              onclick: () => {
                pick.v = p;
                (box.querySelector('.btn-primary') as HTMLButtonElement).click();
              },
            },
            p[0],
          ),
        );
      }
    },
    actions: [
      { label: t('cancel'), value: false },
      {
        label: t('ok'),
        primary: true,
        value: () => {
          if (!pick.v && custom.value.trim()) pick.v = [custom.value.trim(), customColor.value];
          return pick.v ? true : undefined;
        },
      },
    ],
  });
  if (!r || !pick.v) {
    tools.setTool('select');
    return;
  }
  const [label, color] = pick.v;
  await ensureCssFont('sans', true);
  tools.placeNext((pv, at) => {
    const rot = normTurn(pv.rotation);
    const size = tools.settings.stamp?.size ?? 18;
    const r0 = stampRect(label, size, 0, 0, rot);
    const f = boxFrame(r0, rot);
    const o = centeredOrigin(at, f.w, f.h, rot);
    const a = {
      id: uid('a'),
      pageId: pv.page.id,
      color,
      opacity: 1,
      created: Date.now(),
      author: authorName() || undefined,
      type: 'stamp' as const,
      rect: stampRect(label, size, o.x, o.y, rot),
      rot,
      label,
      size,
    };
    store.addAnn(a);
    tools.setTool('select');
    tools.select(a.id);
  });
}
