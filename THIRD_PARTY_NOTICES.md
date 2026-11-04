# Third-party notices

PDF Reader includes the following open-source components. Their license texts are
shipped inside the corresponding packages in `node_modules/` and, for the fonts,
in the built app under `fonts/LICENSE.txt`.

| Component | Copyright | License |
| --- | --- | --- |
| PDF.js (`pdfjs-dist`) | Mozilla Foundation and contributors | Apache License 2.0 |
| pdf-lib (`@cantoo/pdf-lib`) | Andrew Dillon, Cantoo and contributors | MIT |
| fontkit (`@cantoo/fontkit`) | Devon Govett, Cantoo and contributors | MIT |
| DejaVu Fonts (`dejavu-fonts-ttf`) | Bitstream, Inc.; DejaVu changes are in the public domain | Bitstream Vera Fonts license |
| Lucide icons (`lucide`) | Lucide Contributors (portions © Cole Bemis, Feather) | ISC |
| fflate | Arjun Barrett | MIT |
| ONNX Runtime Web (`onnxruntime-web`) — speech engine for "Read aloud" | Microsoft Corporation | MIT |
| Piper phonemizer for the web (`@diffusionstudio/piper-wasm`) | Konstantin Paulus; Piper © Michael Hansen | MIT |
| eSpeak NG (inside `piper_phonemize.wasm` / `.data`, used by "Read aloud") | eSpeak NG contributors | GPL-3.0 (source: https://github.com/rhasspy/espeak-ng) |

Voices for "Read aloud" are not part of the app: they are downloaded on first use from
https://huggingface.co/rhasspy/piper-voices (Piper models, MIT). Their recordings:
Ukrainian Tetiana, Mykyta, Lada — ukrainian_tts (OHF-Voice voice-datasets), CC0;
Russian Dmitri, Denis — CC0; English Kristin, John — public domain; Spanish
Sharvard — Sharvard corpus, CC BY 3.0 (University of Edinburgh); Spanish Davefx — CC0.

PDF.js also bundles CMaps, standard font data and WebAssembly decoders (OpenJPEG,
JBIG2, QCMS); see the `LICENSE*` files in `node_modules/pdfjs-dist/` for details.
