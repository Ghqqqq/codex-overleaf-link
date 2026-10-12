#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContentBundle } from './build-content-bundle.mjs';

// The production entry and its imports must build. Runtime mounting is checked
// by the short Chrome acceptance; source spelling and file sizes are not gates.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { metadata } = buildContentBundle({ rootDir });
console.log(`Content bundle built: ${metadata.inputs.length} inputs, ${metadata.byteLength} bytes.`);
