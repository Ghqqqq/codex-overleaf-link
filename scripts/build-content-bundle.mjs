#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRootDir = path.resolve(path.dirname(scriptPath), '..');

export const CONTENT_BUNDLE_RELATIVE_PATH = 'extension/src/content/generated/content.bundle.js';
export const CONTENT_BUNDLE_META_RELATIVE_PATH = 'extension/src/content/generated/content.bundle.meta.json';
export const CONTENT_BUNDLE_GENERATED_FILES = Object.freeze([
  CONTENT_BUNDLE_RELATIVE_PATH,
  CONTENT_BUNDLE_META_RELATIVE_PATH
]);

const BUILD_OPTIONS = Object.freeze({
  bundle: true,
  // Chrome's dynamic content-script loader rejects raw Unicode
  // noncharacters (for example U+FFFF from vendor regex ranges) with a
  // misleading "not UTF-8" error. Keep the runtime source ASCII-only while
  // preserving the original JavaScript values through escape sequences.
  charset: 'ascii',
  format: 'iife',
  legalComments: 'eof',
  minify: false,
  platform: 'browser',
  sourcemap: false,
  target: ['es2020'],
  treeShaking: true
});

export function buildContentBundle(options = {}) {
  const rootDir = path.resolve(options.rootDir || defaultRootDir);
  const entryPath = path.join(rootDir, 'extension/entries/content-entry.mjs');
  const outputPath = path.join(rootDir, CONTENT_BUNDLE_RELATIVE_PATH);
  const metadataPath = path.join(rootDir, CONTENT_BUNDLE_META_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const entrySource = fs.readFileSync(entryPath, 'utf8');
  const importedRelativePaths = [...entrySource.matchAll(/^import\s+['"]\.\.\/([^'"]+)['"];\s*$/gm)]
    .map(match => `extension/${match[1]}`.replace(/\\/g, '/'));
  if (!importedRelativePaths.length) {
    throw new Error('Content bundle entry must declare at least one side-effect import.');
  }
  const entryBody = entrySource.replace(/^import\s+['"]\.\.\/[^'"]+['"];\s*$/gm, '');
  const compatibilitySource = importedRelativePaths.map(relativePath => {
    const source = fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
    return [
      `/* ${relativePath} */`,
      ';(function runClassicContentModule(module, exports, require) {',
      source,
      '}).call(globalThis, undefined, undefined, undefined);'
    ].join('\n');
  }).join('\n\n');

  const result = buildSync({
    ...BUILD_OPTIONS,
    absWorkingDir: rootDir,
    outfile: outputPath,
    stdin: {
      contents: `${compatibilitySource}\n\n/* content entry bootstrap */\n${entryBody}`,
      loader: 'js',
      resolveDir: rootDir,
      sourcefile: 'extension/entries/content-entry.mjs'
    },
    metafile: true,
    logLevel: options.logLevel || 'silent'
  });

  const inputs = [
    'extension/entries/content-entry.mjs',
    ...importedRelativePaths
  ].sort();
  const sourceHash = crypto.createHash('sha256');
  for (const relativePath of inputs) {
    sourceHash.update(relativePath);
    sourceHash.update('\0');
    sourceHash.update(fs.readFileSync(path.join(rootDir, relativePath)));
    sourceHash.update('\0');
  }
  sourceHash.update(JSON.stringify(BUILD_OPTIONS));
  sourceHash.update('\0');
  sourceHash.update(readPinnedEsbuildVersion(rootDir));

  const outputBytes = fs.readFileSync(outputPath);
  const outputText = outputBytes.toString('utf8');
  for (let offset = 0; offset < outputText.length;) {
    const codePoint = outputText.codePointAt(offset);
    const isUnicodeNoncharacter =
      (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
      (codePoint & 0xffff) === 0xfffe ||
      (codePoint & 0xffff) === 0xffff;
    if (isUnicodeNoncharacter) {
      fs.rmSync(outputPath, { force: true });
      fs.rmSync(metadataPath, { force: true });
      throw new Error(
        `Content bundle contains raw Unicode noncharacter U+${codePoint
          .toString(16)
          .toUpperCase()} at UTF-16 offset ${offset}; ` +
        'Chrome would reject the dynamic content script as invalid UTF-8.'
      );
    }
    offset += codePoint > 0xffff ? 2 : 1;
  }
  const metadata = {
    schemaVersion: 1,
    entry: 'extension/entries/content-entry.mjs',
    output: CONTENT_BUNDLE_RELATIVE_PATH,
    sourceDigest: sourceHash.digest('hex'),
    outputDigest: crypto.createHash('sha256').update(outputBytes).digest('hex'),
    byteLength: outputBytes.length,
    inputs
  };
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return {
    rootDir,
    outputPath,
    metadataPath,
    metadata,
    generatedFiles: [...CONTENT_BUNDLE_GENERATED_FILES]
  };
}

function readPinnedEsbuildVersion(rootDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const version = String(pkg.devDependencies?.esbuild || '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('package.json must pin esbuild to an exact semantic version.');
  }
  return version;
}

if (path.resolve(process.argv[1] || '') === scriptPath) {
  try {
    const result = buildContentBundle({ rootDir: defaultRootDir, logLevel: 'info' });
    console.log(
      `Built ${path.relative(defaultRootDir, result.outputPath)} ` +
      `(${result.metadata.byteLength} bytes, ${result.metadata.inputs.length} inputs).`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
