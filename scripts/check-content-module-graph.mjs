#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTENT_BUNDLE_META_RELATIVE_PATH,
  CONTENT_BUNDLE_RELATIVE_PATH,
  buildContentBundle
} from './build-content-bundle.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = buildContentBundle({ rootDir });
const bundle = fs.readFileSync(path.join(rootDir, CONTENT_BUNDLE_RELATIVE_PATH), 'utf8');
const metadata = JSON.parse(fs.readFileSync(path.join(rootDir, CONTENT_BUNDLE_META_RELATIVE_PATH), 'utf8'));
const errors = [];

if (
  metadata.outputDigest !== result.metadata.outputDigest ||
  metadata.sourceDigest !== result.metadata.sourceDigest
) {
  errors.push('Generated content bundle metadata does not match the bundle bytes.');
}
if (JSON.stringify(metadata.inputs) !== JSON.stringify(result.metadata.inputs)) {
  errors.push('Generated content bundle input inventory is not deterministic.');
}
for (const builtin of ['node:fs', 'node:path', 'node:child_process', 'node:crypto']) {
  if (bundle.includes(builtin)) {
    errors.push(`Browser bundle contains Node builtin ${builtin}.`);
  }
}
if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(bundle)) {
  errors.push('Browser bundle contains dynamic code evaluation.');
}
if (metadata.byteLength > 6 * 1024 * 1024) {
  errors.push(`Browser bundle exceeds the 6 MiB architecture ceiling: ${metadata.byteLength} bytes.`);
}
errors.push(...findImplicitGlobalConsumers());
errors.push(...findSelfAssignments());

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Content module graph is valid: ${metadata.inputs.length} inputs, ${metadata.byteLength} bytes.`);
}

function findSelfAssignments() {
  const sourceRoots = [
    path.join(rootDir, 'extension', 'src', 'shared'),
    path.join(rootDir, 'extension', 'src', 'content')
  ];
  const violations = [];
  const selfAssignmentPattern = /^\s*(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\1\s*;\s*(?:\/\/.*)?$/;

  for (const sourceRoot of sourceRoots) {
    for (const filePath of walkJavaScriptFiles(sourceRoot)) {
      if (filePath.includes(`${path.sep}generated${path.sep}`)) {
        continue;
      }
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const match = line.match(selfAssignmentPattern);
        if (!match) {
          return;
        }
        violations.push(
          path.relative(rootDir, filePath) + ":" + (index + 1) + ": self-assignment shadows injected dependency " + match[1] + "."
        );
      });
    }
  }
  return violations;
}

function findImplicitGlobalConsumers() {
  const sourceRoots = [
    path.join(rootDir, 'extension', 'src', 'shared'),
    path.join(rootDir, 'extension', 'src', 'content')
  ];
  const excludedFiles = new Set([
    path.join(rootDir, 'extension', 'src', 'content', 'contentScript.js'),
    path.join(rootDir, 'extension', 'src', 'content', 'legacyGlobalRegistry.js'),
    path.join(rootDir, 'extension', 'src', 'content', 'moduleRegistryKernel.js')
  ]);
  const violations = [];
  const globalReferencePattern = /(?:window|root|globalThis)(?:\.|\?\.)CodexOverleaf[A-Za-z0-9_$]+/g;

  for (const sourceRoot of sourceRoots) {
    for (const filePath of walkJavaScriptFiles(sourceRoot)) {
      if (excludedFiles.has(filePath) || filePath.includes(`${path.sep}generated${path.sep}`)) {
        continue;
      }
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        const references = line.match(globalReferencePattern);
        if (!references) {
          return;
        }
        const isCompatibilityPublication =
          /(?:window|root|globalThis)(?:\.|\?\.)CodexOverleaf[A-Za-z0-9_$]+\s*=/.test(line);
        const isRegistryDefinition =
          /(?:window|root|globalThis)(?:\.|\?\.)CodexOverleafModuleRegistry\.define\s*\(/.test(line);
        if (!isCompatibilityPublication && !isRegistryDefinition) {
          violations.push(
            `Implicit content dependency ${references.join(', ')} at ${path.relative(rootDir, filePath)}:${index + 1}.`
          );
        }
      });
    }
  }
  return violations;
}

function walkJavaScriptFiles(directoryPath) {
  const files = [];
  for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(entryPath);
    }
  }
  return files.sort();
}
