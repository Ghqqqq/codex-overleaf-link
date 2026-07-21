#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const currentTag = `v${pkg.version}`;
const protectedPaths = [
  'extension/bootstrap',
  'extension/assets',
  'extension/popup.html',
  'native-host/src/managedLauncherRuntime.js',
  'native-host/src/nativeHostPlatform.js',
  'native-host/src/manifest.js',
  'scripts/install-managed.mjs',
  'scripts/install-native-host.mjs'
];

const baseRef = process.env.CODEX_OVERLEAF_UPDATE_BASE_REF || findPreviousStableTag();
if (!baseRef) {
  throw new Error('No previous stable tag is available. Fetch full tag history or set CODEX_OVERLEAF_UPDATE_BASE_REF.');
}

const changed = git([
  'diff',
  '--name-only',
  `${baseRef}..HEAD`,
  '--',
  ...protectedPaths
]).split('\n').map(value => value.trim()).filter(Boolean);
if (changed.length) {
  throw new Error([
    `Managed update boundary changed since ${baseRef}:`,
    ...changed.map(value => `- ${value}`),
    'These files are outside the signed runtime bundle. Keep the protocol-1 bridge immutable, or require an explicit managed reinstall/protocol migration.'
  ].join('\n'));
}

const previousPackage = JSON.parse(git(['show', `${baseRef}:package.json`]));
const dependencyKeys = ['dependencies', 'optionalDependencies', 'peerDependencies'];
for (const key of dependencyKeys) {
  const before = stableJson(previousPackage[key] || {});
  const after = stableJson(pkg[key] || {});
  if (before !== after) {
    throw new Error(`${key} changed since ${baseRef}. The runtime-only updater does not install node_modules; use a managed reinstall or package dependencies inside the signed runtime.`);
  }
}

console.log(`Managed update boundary is compatible: ${baseRef} -> ${currentTag}.`);

function findPreviousStableTag() {
  const tags = git(['tag', '--merged', 'HEAD', '--sort=-v:refname'])
    .split('\n')
    .map(value => value.trim())
    .filter(value => /^v\d+\.\d+\.\d+$/.test(value) && value !== currentTag);
  return tags[0] || '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}
