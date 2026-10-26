// The "legacy" build carries polyfills, so older phones and tablets work too.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy };

function assetUrl(path: string): string {
  return new URL(path, document.baseURI).href;
}

export const docOptions = () => ({
  cMapUrl: assetUrl('pdfjs/cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
  wasmUrl: assetUrl('pdfjs/wasm/'),
  iccUrl: assetUrl('pdfjs/iccs/'),
  enableXfa: false,
});

export type PasswordAsker = (retry: boolean) => Promise<string | null>;

export class PasswordCancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/** Loads a document with pdf.js, asking for a password when needed. */
export async function loadPdf(
  bytes: Uint8Array,
  askPassword: PasswordAsker,
): Promise<{ pdf: PDFDocumentProxy; password?: string }> {
  let password: string | undefined;
  const task = pdfjs.getDocument({ ...docOptions(), data: bytes.slice() });
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const retry = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD;
    askPassword(retry).then((pw) => {
      if (pw === null) {
        task.destroy();
        return;
      }
      password = pw;
      update(pw);
    });
  };
  try {
    const pdf = await task.promise;
    return { pdf, password };
  } catch (e) {
    if (task.destroyed) throw new PasswordCancelled();
    throw e;
  }
}
