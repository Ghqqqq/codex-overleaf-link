#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Expand files here so Node 20 and Windows do not depend on shell globbing.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--platform')) {
  throw new Error('Usage: node scripts/run-tests.mjs [--platform]. For a focused check, use node --test <files>.');
}
const directory = path.join(root, 'test', args.length ? 'platform' : '');
const files = fs.readdirSync(directory).filter(name => name.endsWith('.test.js')).sort()
  .map(name => path.join(directory, name));
if (!files.length) throw new Error('No contract tests found: ' + directory);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root, stdio: 'inherit'
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
