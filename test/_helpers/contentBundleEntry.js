'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const CONTENT_BUNDLE_ENTRY_PATH = path.join(ROOT, 'extension/entries/content-entry.mjs');
const CONTENT_BUNDLE_ENTRY_MARKER = 'entries/content-entry.mjs';
const CONTENT_BUNDLE_RUNTIME_PATH = 'src/content/generated/content.bundle.js';

function getContentBundleSourceOrder() {
  const source = fs.readFileSync(CONTENT_BUNDLE_ENTRY_PATH, 'utf8');
  const imports = [...source.matchAll(/^import\s+['"]\.\.\/([^'"]+)['"];\s*$/gm)]
    .map(match => match[1]);
  return [...imports, CONTENT_BUNDLE_ENTRY_MARKER];
}

module.exports = {
  CONTENT_BUNDLE_ENTRY_MARKER,
  CONTENT_BUNDLE_ENTRY_PATH,
  CONTENT_BUNDLE_RUNTIME_PATH,
  getContentBundleSourceOrder
};
