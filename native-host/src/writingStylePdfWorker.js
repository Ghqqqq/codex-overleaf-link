'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const root = path.join(__dirname, 'vendor', 'pdfjs');
  const pdf = await import(pathToFileURL(path.join(root, 'pdf.mjs')).href);
  pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(root, 'pdf.worker.mjs')).href;
  const task = pdf.getDocument({ data: new Uint8Array(workerData.bytes),
    isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
    cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages = [];
    const count = Math.min(document.numPages, 80);
    for (let number = 1; number <= count; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let line = '', lines = [];
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        line += item.str + (item.str.endsWith(' ') ? '' : ' ');
        if (item.hasEOL) { lines.push(line.trim()); line = ''; }
      }
      if (line.trim()) lines.push(line.trim());
      pages.push({ number, lines });
      page.cleanup();
    }
    parentPort.postMessage({ ok: true, pages, totalPages: document.numPages });
  } finally { await task.destroy(); }
})().catch(error => parentPort.postMessage({ ok: false,
  error: String(error?.message || 'PDF text extraction failed.').slice(0, 300) }));

