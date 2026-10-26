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

PDF.js also bundles CMaps, standard font data and WebAssembly decoders (OpenJPEG,
JBIG2, QCMS); see the `LICENSE*` files in `node_modules/pdfjs-dist/` for details.
