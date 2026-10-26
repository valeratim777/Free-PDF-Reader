// Copies runtime assets that pdf.js and the text tools need into public/.
// Runs automatically before `dev` and `build`.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');
const pub = join(root, 'public');

const pdfjs = join(nm, 'pdfjs-dist');
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const src = join(pdfjs, dir);
  if (existsSync(src)) cpSync(src, join(pub, 'pdfjs', dir), { recursive: true });
}
cpSync(join(pdfjs, 'LICENSE'), join(pub, 'pdfjs', 'LICENSE.txt'));

const fontsSrc = join(nm, 'dejavu-fonts-ttf', 'ttf');
const fontsDst = join(pub, 'fonts');
mkdirSync(fontsDst, { recursive: true });
for (const f of [
  'DejaVuSans.ttf',
  'DejaVuSans-Bold.ttf',
  'DejaVuSerif.ttf',
  'DejaVuSerif-Bold.ttf',
  'DejaVuSansMono.ttf',
  'DejaVuSansMono-Bold.ttf',
]) {
  cpSync(join(fontsSrc, f), join(fontsDst, f));
}
cpSync(join(nm, 'dejavu-fonts-ttf', 'LICENSE'), join(fontsDst, 'LICENSE.txt'));
console.log('assets copied');
