#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED_PACKAGE_NAME = 'codex-overleaf-link';
const EXPECTED_PACKAGE_LOCK_VERSION = 3;
export const FORBIDDEN_TRACKED_PATH_PATTERNS = [
  /^\.local\//,
  /^ROADMAP\.md$/,
  /^docs\//,
  /^dist\//,
  /^build\//,
  /^native-host\/bin\//,
  /^scripts\/npm-package-files-v[^/]+\.txt$/,
  /^\.worktrees\//,
  /^worktrees\//,
  /\.(pem|key|p12|crx|sqlite|log)$/i
];
const PACKAGED_SOURCE_TREE_PREFIXES = [
  'extension/',
  'native-host/',
  'scripts/'
];
const FORBIDDEN_PACKAGED_SOURCE_PATH_TOKENS = new Set([
  'credential',
  'credentials',
  'debug',
  'env',
  'internal',
  'local',
  'localonly',
  'plan',
  'private',
  'secret',
  'secrets',
  'spec'
]);
export function collectReleaseVerificationErrors(options = {}) {
  const rootDir = path.resolve(options.rootDir || getRepoRoot());
  const releaseDate = options.releaseDate;
  const sourceHygieneOnly = options.sourceHygieneOnly === true;
  const errors = [];
  const pkg = readJsonFile(rootDir, 'package.json', errors);
  const packageLock = readJsonFile(rootDir, 'package-lock.json', errors);
  const manifest = readJsonFile(rootDir, 'extension/manifest.json', errors);
  const readme = sourceHygieneOnly ? '' : readTextFile(rootDir, 'README.md', errors);
  const changelog = sourceHygieneOnly ? '' : readTextFile(rootDir, 'CHANGELOG.md', errors);
  const compatibility = readTextFile(rootDir, 'extension/src/shared/compatibility.js', errors);

  if (errors.length > 0) {
    return errors;
  }

  const version = pkg.version;
  errors.push(...collectPackageMetadataErrors({ rootDir, pkg, packageLock }));
  if (!version) {
    errors.push('package.json must define a release version.');
  }

  if (manifest.version !== version) {
    errors.push(
      `extension/manifest.json version ${formatValue(manifest.version)} must match package.json version ${version}.`
    );
  }

  // The runtime compatibility BUILD_TARGET_VERSION is the one version surface
  // the release gate previously did not check (only unit tests did), so a
  // partial bump could pass `verify:release`. Make the gate single-source.
  if (version) {
    const buildTargetMatch = compatibility.match(/BUILD_TARGET_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (!buildTargetMatch) {
      errors.push('extension/src/shared/compatibility.js must define BUILD_TARGET_VERSION.');
    } else if (buildTargetMatch[1] !== version) {
      errors.push(
        `extension/src/shared/compatibility.js BUILD_TARGET_VERSION ${formatValue(buildTargetMatch[1])} must match package.json version ${version}.`
      );
    }
  }

  if (version && !sourceHygieneOnly) {
    const expectedBadge = `version-${version}-blue`;
    if (!readme.includes(expectedBadge)) {
      errors.push(`README.md must contain the release badge fragment "${expectedBadge}".`);
    }

    const pinnedNpmInstallCommand = `npm exec --yes ${EXPECTED_PACKAGE_NAME}@${version} -- install-native`;
    if (!readme.includes(pinnedNpmInstallCommand)) {
      errors.push(`README.md must contain the pinned npm install command "${pinnedNpmInstallCommand}".`);
    }

    const changelogHeadingPattern = releaseDate
      ? new RegExp(`^## v${escapeRegExp(version)} - ${escapeRegExp(releaseDate)}$`, 'm')
      : new RegExp(`^## v${escapeRegExp(version)} - \\d{4}-\\d{2}-\\d{2}$`, 'm');
    if (!changelogHeadingPattern.test(changelog)) {
      const expectedHeading = releaseDate
        ? `## v${version} - ${releaseDate}`
        : `## v${version} - YYYY-MM-DD`;
      errors.push(`CHANGELOG.md must contain the release heading "${expectedHeading}".`);
    }
  }

  errors.push(...collectForbiddenTrackedPathErrors(rootDir, options.trackedFiles));
  errors.push(...collectInstallerArtifactErrors(rootDir));
  return errors;
}

export function collectSourceVerificationErrors(options = {}) {
  return collectReleaseVerificationErrors({
    ...options,
    sourceHygieneOnly: true
  });
}

function collectPackageMetadataErrors({ rootDir, pkg, packageLock }) {
  const errors = [];
  const version = pkg.version;

  if (pkg.name !== EXPECTED_PACKAGE_NAME) {
    errors.push(`package.json name ${formatValue(pkg.name)} must be ${EXPECTED_PACKAGE_NAME}.`);
  }
  if (typeof pkg.packageManager !== 'string' || pkg.packageManager.trim() === '') {
    errors.push('package.json must define packageManager for reproducible npm release tooling.');
  }
  if (!pkg.repository || pkg.repository.type !== 'git' || pkg.repository.url !== 'git+https://github.com/Ghqqqq/codex-overleaf-link.git') {
    errors.push('package.json must define repository.url as git+https://github.com/Ghqqqq/codex-overleaf-link.git for npm provenance.');
  }
  if (packageLock.lockfileVersion !== EXPECTED_PACKAGE_LOCK_VERSION) {
    errors.push(
      `package-lock.json lockfileVersion ${formatValue(packageLock.lockfileVersion)} must be ${EXPECTED_PACKAGE_LOCK_VERSION}.`
    );
  }

  if (version) {
    if (packageLock.name !== EXPECTED_PACKAGE_NAME) {
      errors.push(`package-lock.json name ${formatValue(packageLock.name)} must be ${EXPECTED_PACKAGE_NAME}.`);
    }
    if (packageLock.version !== version) {
      errors.push(`package-lock.json version ${formatValue(packageLock.version)} must match package.json version ${version}.`);
    }
    const rootPackage = packageLock.packages && packageLock.packages[''];
    if (!rootPackage || typeof rootPackage !== 'object') {
      errors.push('package-lock.json must include a root packages[""] entry.');
    } else {
      if (rootPackage.name !== EXPECTED_PACKAGE_NAME) {
        errors.push(`package-lock.json root package name ${formatValue(rootPackage.name)} must be ${EXPECTED_PACKAGE_NAME}.`);
      }
      if (rootPackage.version !== version) {
        errors.push(`package-lock.json root package version ${formatValue(rootPackage.version)} must match package.json version ${version}.`);
      }
    }

  }

  return errors;
}

export function collectForbiddenTrackedPathErrors(rootDir, trackedFiles = readGitTrackedFiles(rootDir)) {
  const errors = [];
  for (const trackedFile of trackedFiles) {
    const relativePath = normalizeTrackedPath(trackedFile);
    if (isForbiddenTrackedReleasePath(relativePath)) {
      errors.push(`Tracked release input must not include internal/private path: ${relativePath}`);
    }
  }
  return errors;
}

export function collectInstallerArtifactErrors(rootDir) {
  const errors = [];
  for (const relativePath of ['install.sh', 'install.ps1', 'scripts/install-native-host.mjs']) {
    if (!fs.existsSync(path.join(rootDir, relativePath))) {
      errors.push(`${relativePath} is required for release verification.`);
    }
  }
  return errors;
}

function readJsonFile(rootDir, relativePath, errors) {
  const fullPath = path.join(rootDir, relativePath);
  try {
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch (error) {
    errors.push(`Unable to read valid JSON from ${relativePath}: ${error.message}`);
    return {};
  }
}

function readTextFile(rootDir, relativePath, errors) {
  const fullPath = path.join(rootDir, relativePath);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (error) {
    errors.push(`Unable to read ${relativePath}: ${error.message}`);
    return '';
  }
}

function formatValue(value) {
  return value === undefined ? '<missing>' : String(value);
}

function normalizeTrackedPath(relativePath) {
  return String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
}

function isForbiddenTrackedReleasePath(relativePath) {
  return FORBIDDEN_TRACKED_PATH_PATTERNS.some((pattern) => pattern.test(relativePath))
    || isForbiddenPackagedSourceTreePath(relativePath);
}

function isForbiddenPackagedSourceTreePath(relativePath) {
  if (!PACKAGED_SOURCE_TREE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }

  return relativePath
    .toLowerCase()
    .split('/')
    .some((component) => getPathComponentTokens(component)
      .some((token) => FORBIDDEN_PACKAGED_SOURCE_PATH_TOKENS.has(token)));
}

function getPathComponentTokens(component) {
  return component
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function readGitTrackedFiles(rootDir) {
  const insideWorkTree = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (insideWorkTree.status !== 0) {
    return [];
  }

  const result = spawnSync('git', ['ls-files'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`Unable to list git-tracked files: ${result.stderr || result.stdout}`.trim());
  }
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') {
      parsed.rootDir = argv[index + 1];
      index += 1;
    } else if (arg === '--release-date') {
      parsed.releaseDate = argv[index + 1];
      index += 1;
    } else if (arg === '--source-hygiene-only') {
      parsed.sourceHygieneOnly = true;
    }
  }
  return parsed;
}

function getRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const errors = collectReleaseVerificationErrors(args);
  // v1.8.1: the architecture budget is part of release verification — twice
  // now a late fix pushed a file past its ceiling AFTER the last local
  // budget run, and only CI's --enforce-target gate caught it (post-tag).
  try {
    const budget = await import('./check-architecture-budget.mjs');
    const results = budget.collectArchitectureBudgetResults({ rootDir: path.resolve(args.rootDir || getRepoRoot()) });
    for (const result of results) {
      if (!result.targetMet) {
        errors.push(`architecture budget: ${result.path} has ${result.lineCount} lines; limit is ${result.ceiling}`);
      }
    }
  } catch (error) {
    errors.push(`architecture budget check failed to run: ${error.message}`);
  }
  if (errors.length > 0) {
    console.error('Release verification failed:');
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(args.rootDir || getRepoRoot()), 'package.json'), 'utf8'));
  const label = args.sourceHygieneOnly ? 'Source verification' : 'Release verification';
  console.log(`${label} passed for v${pkg.version}.`);
}

if (
  process.env.CODEX_OVERLEAF_TEST_IMPORT !== '1' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
