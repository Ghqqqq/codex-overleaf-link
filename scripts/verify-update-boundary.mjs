#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_MANIFEST_PATH = 'extension/bootstrap/manifest.template.json';
const MANAGED_INSTALLER_PATH = 'scripts/install-managed.mjs';

if (process.env.CODEX_OVERLEAF_TEST_IMPORT !== '1') {
  verifyUpdateBoundary();
}

function verifyUpdateBoundary() {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const currentTag = `v${pkg.version}`;
  const protectedPaths = [
    'extension/bootstrap',
    'extension/assets',
    'extension/popup.html',
    'native-host/src/updateTrust.js',
    'native-host/src/managedLauncherRuntime.js',
    'native-host/src/nativeHostPlatform.js',
    'native-host/src/manifest.js',
    MANAGED_INSTALLER_PATH,
    'scripts/install-native-host.mjs'
  ];

  const baseRef = process.env.CODEX_OVERLEAF_UPDATE_BASE_REF || findPreviousStableTag(currentTag);
  if (!baseRef) {
    throw new Error('No previous stable tag is available. Fetch full tag history or set CODEX_OVERLEAF_UPDATE_BASE_REF.');
  }

  const changed = collectProtectedChanges(baseRef, protectedPaths);
  const incompatibleChanges = changed.filter(relativePath => {
    if (relativePath === BOOTSTRAP_MANIFEST_PATH) return false;
    if (relativePath !== MANAGED_INSTALLER_PATH) return true;
    return !isManagedInstallerCopyOnlyChange(
      git(['show', `${baseRef}:${relativePath}`]),
      fs.readFileSync(path.join(rootDir, relativePath), 'utf8')
    );
  });
  const previousPackage = JSON.parse(git(['show', `${baseRef}:package.json`]));
  const previousBootstrapProtocol = readBootstrapProtocol(`${baseRef}:native-host/src/updateTrust.js`);
  const currentBootstrapProtocol = readBootstrapProtocol(path.join(rootDir, 'native-host/src/updateTrust.js'));
  const protocolMigration = assertBootstrapProtocolTransition({
    previousPackageVersion: previousPackage.version, currentPackageVersion: pkg.version,
    previousBootstrapProtocol, currentBootstrapProtocol
  });
  if (incompatibleChanges.length && !protocolMigration) {
    throw new Error([
      `Managed update boundary changed since ${baseRef}:`,
      ...incompatibleChanges.map(value => `- ${value}`),
      `These files require an explicit Bootstrap protocol migration. Current protocol remains ${currentBootstrapProtocol}.`
    ].join('\n'));
  }

  if (changed.includes(BOOTSTRAP_MANIFEST_PATH)) {
    assertBootstrapManifestVersionTransition({
      previousManifest: materializePreviousBootstrapManifest(
        JSON.parse(git(['show', `${baseRef}:${BOOTSTRAP_MANIFEST_PATH}`])), previousPackage.version
      ),
      currentManifest: JSON.parse(fs.readFileSync(path.join(rootDir, BOOTSTRAP_MANIFEST_PATH), 'utf8')),
      previousPackageVersion: previousPackage.version,
      currentPackageVersion: pkg.version,
      previousBootstrapProtocol, currentBootstrapProtocol
    });
  }

  const dependencyKeys = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const key of dependencyKeys) {
    const before = stableJson(previousPackage[key] || {});
    const after = stableJson(pkg[key] || {});
    if (before !== after) {
      throw new Error(`${key} changed since ${baseRef}. The runtime-only updater does not install node_modules; use a managed reinstall or package dependencies inside the signed runtime.`);
    }
  }

  console.log(protocolMigration
    ? `Managed update boundary declares protocol migration ${previousBootstrapProtocol} -> ${currentBootstrapProtocol}: ${baseRef} -> ${currentTag}.`
    : `Managed update boundary is compatible: ${baseRef} -> ${currentTag}.`);
}

// Validate the checkout that packaging will consume, including staged, unstaged,
// and new protected files. A committed-history-only diff can miss the candidate.
export function collectProtectedChanges(baseRef, protectedPaths, readGit = git) {
  const tracked = readGit(['diff', '--name-only', baseRef, '--', ...protectedPaths]);
  const untracked = readGit(['ls-files', '--others', '--exclude-standard', '--', ...protectedPaths]);
  return [...new Set((tracked + '\n' + untracked).split('\n').map(value => value.trim()).filter(Boolean))].sort();
}

export function assertBootstrapProtocolTransition({
  previousPackageVersion, currentPackageVersion, previousBootstrapProtocol, currentBootstrapProtocol
}) {
  if (!Number.isInteger(previousBootstrapProtocol) || previousBootstrapProtocol < 1
    || !Number.isInteger(currentBootstrapProtocol) || currentBootstrapProtocol < previousBootstrapProtocol
    || currentBootstrapProtocol > previousBootstrapProtocol + 1) {
    throw new Error('Bootstrap protocol must remain stable or increase by exactly one.');
  }
  const migration = currentBootstrapProtocol === previousBootstrapProtocol + 1;
  if (migration) {
    const before = parseReleaseVersion(previousPackageVersion), after = parseReleaseVersion(currentPackageVersion);
    const advances = after.major > before.major || (after.major === before.major && after.minor > before.minor);
    if (!advances || after.patch !== 0) {
      throw new Error('Bootstrap protocol migrations require a new major/minor baseline with patch zero.');
    }
  }
  return migration;
}

function readBootstrapProtocol(source) {
  const content = source.includes(':') && !path.isAbsolute(source)
    ? git(['show', source])
    : fs.readFileSync(source, 'utf8');
  const match = content.match(/BOOTSTRAP_PROTOCOL\s*=\s*(\d+)/);
  const value = Number(match && match[1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Unable to read Bootstrap protocol from ${source}.`);
  }
  return value;
}

function parseReleaseVersion(value) {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid stable package version: ${value}.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

export function isManagedInstallerCopyOnlyChange(previousSource, currentSource) {
  // Permit this fixed human-readable message correction only. All other bytes,
  // including imports, argument parsing and install logic, must stay identical.
  const previousLine = "    'Future stable extension and native-host updates will install automatically when Overleaf is saved and idle.',";
  const currentLine = "    'Future signed stable updates are checked automatically. Choose Update now to authorize a version; installation waits until Overleaf is saved and idle.',";
  return previousSource.includes(previousLine) &&
    previousSource.replace(previousLine, currentLine) === currentSource;
}

// Historical managed installers stamp the package version onto the template.
// Compare that published manifest, retaining all non-version fields unchanged.
// The current candidate still has to declare its release version explicitly.
export function materializePreviousBootstrapManifest(template, packageVersion) {
  parseReleaseVersion(packageVersion);
  return { ...template, version: packageVersion };
}

export function assertBootstrapManifestVersionTransition({
  previousManifest,
  currentManifest,
  previousPackageVersion,
  currentPackageVersion,
  previousBootstrapProtocol,
  currentBootstrapProtocol
}) {
  if (previousManifest?.version !== previousPackageVersion || currentManifest?.version !== currentPackageVersion) {
    throw new Error('Bootstrap manifest versions must match their package release versions.');
  }

  const previousShape = { ...previousManifest, version: '<release-version>' };
  const currentShape = { ...currentManifest, version: '<release-version>' };
  const migration = previousBootstrapProtocol !== undefined || currentBootstrapProtocol !== undefined
    ? assertBootstrapProtocolTransition({ previousPackageVersion, currentPackageVersion,
      previousBootstrapProtocol, currentBootstrapProtocol }) : false;
  if (stableJson(previousShape) !== stableJson(currentShape) && !migration) {
    throw new Error('Bootstrap manifest changed beyond its release version. Use an explicit managed reinstall/protocol migration.');
  }
}

function findPreviousStableTag(currentTag) {
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
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
