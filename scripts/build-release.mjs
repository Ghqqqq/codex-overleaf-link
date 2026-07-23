#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildManagedExtensionTree } = require('../native-host/src/managedInstall.js');
const { buildRuntimeFileManifest } = require('../native-host/src/runtimeInstaller.js');
const { createUpdateBundleArchive } = require('../native-host/src/updateArchive.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_OUTPUT_MARKER = '.codex-overleaf-release-output';
const BUILD_RELEASE_USAGE = 'Usage: node scripts/build-release.mjs [--output <path>]';
const DEFAULT_RELEASE_DATE = '2026-05-06';
const NATIVE_UNINSTALL_HELPER_ARTIFACTS = [
  { source: 'native-host/src/nativeHostPlatform.js', name: 'nativeHostPlatform.js' },
  { source: 'native-host/src/manifest.js', name: 'manifest.js' },
  { source: 'native-host/src/runtimeInstaller.js', name: 'runtimeInstaller.js' }
];

function main() {
  try {
    const args = parseBuildReleaseArgs(process.argv.slice(2));
    const result = buildRelease({
      rootDir: repoRoot,
      outputDir: args.output
    });
    console.log(`Built release artifacts in ${result.outputDir}`);
  } catch (error) {
    console.error(`Release build failed: ${error.message}`);
    process.exit(1);
  }
}

export function buildRelease(options = {}) {
  const rootDir = path.resolve(options.rootDir || repoRoot);
  const pkg = readJson(path.join(rootDir, 'package.json'));
  const version = pkg.version;
  if (!version) {
    throw new Error('package.json must define a version.');
  }
  const stableReleaseRef = `v${version}`;
  const releaseRef = String(
    options.releaseRef || process.env.CODEX_OVERLEAF_RELEASE_REF || stableReleaseRef
  ).trim();
  const escapedVersion = escapeRegExp(version);
  if (!new RegExp(`^v${escapedVersion}(?:-rc\\.[1-9]\\d*)?$`).test(releaseRef)) {
    throw new Error(`Release ref ${releaseRef || '(empty)'} must be ${stableReleaseRef} or an ${stableReleaseRef}-rc.N tag.`);
  }
  const releaseChannel = releaseRef === stableReleaseRef ? 'stable' : 'prerelease';

  const outputDir = path.resolve(options.outputDir || getDefaultReleaseOutputDir({ rootDir, version }));
  const extensionZipName = `codex-overleaf-link-extension-v${version}.zip`;
  const nativeTarballName = `codex-overleaf-native-host-v${version}.tar.gz`;
  const npmTarballName = getNpmTarballName(pkg);
  const updateBundleName = `codex-overleaf-update-v${version}.tar.gz`;
  const extensionZipPath = path.join(outputDir, extensionZipName);
  const nativeTarballPath = path.join(outputDir, nativeTarballName);
  const npmTarballPath = path.join(outputDir, npmTarballName);
  const updateBundlePath = path.join(outputDir, updateBundleName);
  const trackedFiles = getGitTrackedFiles(rootDir);
  const headTrackedFiles = getGitHeadTrackedFiles(rootDir);
  const releaseInputFiles = getReleaseInputFilesForProvenance({
    headTrackedFiles,
    indexTrackedFiles: trackedFiles
  });

  assertSafeReleaseOutputDir({ rootDir, outputDir });
  assertRequiredReleaseFilesTracked({ trackedFiles, version });
  if (!options.allowDirtyReleaseInputs && process.env.CODEX_OVERLEAF_ALLOW_DIRTY_RELEASE_INPUTS !== '1') {
    assertCleanTrackedReleaseInputs({ rootDir, relativePaths: releaseInputFiles });
  }
  prepareReleaseOutputDir({ rootDir, outputDir });

  createExtensionZip({ rootDir, outputPath: extensionZipPath, trackedFiles, releaseRef, releaseChannel });
  createNativeTarball({ rootDir, outputPath: nativeTarballPath, trackedFiles });
  createNpmTarball({ rootDir, outputPath: npmTarballPath, expectedName: npmTarballName, trackedFiles });
  createCoordinatedUpdateBundle({
    rootDir,
    outputPath: updateBundlePath,
    trackedFiles,
    version,
    releaseRef,
    releaseChannel
  });

  const copiedInstallPath = path.join(outputDir, 'install.sh');
  const copiedWindowsInstallPath = path.join(outputDir, 'install.ps1');
  const copiedUninstallPath = path.join(outputDir, 'uninstall-native-host.mjs');
  writeVersionPinnedInstallScript({
    sourcePath: path.join(rootDir, 'install.sh'),
    targetPath: copiedInstallPath,
    releaseRef
  });
  writeVersionPinnedPowerShellInstallScript({
    sourcePath: path.join(rootDir, 'install.ps1'),
    targetPath: copiedWindowsInstallPath,
    releaseRef
  });
  writeTopLevelUninstallScript({
    rootDir,
    sourcePath: path.join(rootDir, 'scripts/uninstall-native-host.mjs'),
    targetPath: copiedUninstallPath
  });
  writeTopLevelNativeHelperAssets({ rootDir, outputDir, trackedFiles });

  const releaseNotes = getReleaseNotesForBuild({ rootDir, version });
  fs.writeFileSync(path.join(outputDir, 'release-notes.md'), releaseNotes, 'utf8');

  const payloadArtifactNames = [
    extensionZipName,
    nativeTarballName,
    npmTarballName,
    updateBundleName,
    'install.sh',
    'install.ps1',
    'uninstall-native-host.mjs',
    ...NATIVE_UNINSTALL_HELPER_ARTIFACTS.map((artifact) => artifact.name)
  ];
  const manifest = {
    schemaVersion: 2,
    repository: 'Ghqqqq/codex-overleaf-link',
    channel: releaseChannel,
    version,
    tag: releaseRef,
    bootstrapProtocol: 2,
    gitCommit: getGitCommit(rootDir),
    createdAt: new Date().toISOString(),
    updateBundle: describeArtifact(updateBundlePath, updateBundleName),
    artifacts: payloadArtifactNames.map((name) => describeArtifact(path.join(outputDir, name), name))
  };
  fs.writeFileSync(path.join(outputDir, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const checksumNames = [
    ...payloadArtifactNames,
    'release-manifest.json',
    'release-notes.md'
  ];
  const checksums = checksumNames
    .map((name) => `${sha256(path.join(outputDir, name))}  ${name}`)
    .join('\n');
  fs.writeFileSync(path.join(outputDir, 'SHA256SUMS'), `${checksums}\n`, 'utf8');

  return {
    outputDir,
    version,
    releaseRef,
    artifacts: [
      ...payloadArtifactNames,
      'release-manifest.json',
      'release-notes.md',
      'SHA256SUMS'
    ]
  };
}

export function extractReleaseNotes(changelog, version) {
  const headingPattern = new RegExp(`^## v${escapeRegExp(version)} - .*$`, 'm');
  const headingMatch = changelog.match(headingPattern);
  if (!headingMatch || headingMatch.index === undefined) {
    throw new Error(`CHANGELOG.md does not contain a release section for v${version}.`);
  }

  const rest = changelog.slice(headingMatch.index);
  const bodyAndFollowingSections = rest.slice(headingMatch[0].length);
  const nextHeadingMatch = bodyAndFollowingSections.match(/\n## /);
  const body = (nextHeadingMatch
    ? bodyAndFollowingSections.slice(0, nextHeadingMatch.index)
    : bodyAndFollowingSections
  ).trim();
  if (!body) {
    throw new Error(`CHANGELOG.md release section for v${version} is empty.`);
  }
  return `${headingMatch[0]}\n\n${body}\n`;
}

export function getDefaultReleaseOutputDir({ rootDir, version }) {
  return path.join(rootDir, 'dist/releases', `v${version}`);
}

export function assertSafeReleaseOutputDir({ rootDir, outputDir }) {
  if (!outputDir) {
    throw new Error('Refusing to use unsafe release output directory: output path is required.');
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedOutput = path.resolve(outputDir);
  const filesystemRoot = path.parse(resolvedOutput).root;
  const homeDir = path.resolve(os.homedir());

  if (
    resolvedOutput === filesystemRoot ||
    resolvedOutput === homeDir ||
    isSamePathOrAncestor(resolvedOutput, resolvedRoot)
  ) {
    throw new Error(`Refusing to use unsafe release output directory: ${resolvedOutput}`);
  }

  if (!fs.existsSync(resolvedOutput)) {
    return;
  }

  const outputStats = fs.statSync(resolvedOutput);
  if (!outputStats.isDirectory()) {
    throw new Error(`Refusing to use unsafe release output directory because it is not a directory: ${resolvedOutput}`);
  }

  const entries = fs.readdirSync(resolvedOutput);
  if (entries.length > 0 && !entries.includes(RELEASE_OUTPUT_MARKER)) {
    throw new Error(
      `Refusing to use non-empty release output directory without ${RELEASE_OUTPUT_MARKER}: ${resolvedOutput}`
    );
  }
}

export function parseBuildReleaseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`--output requires a path value.\n${BUILD_RELEASE_USAGE}`);
      }
      parsed.output = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}\n${BUILD_RELEASE_USAGE}`);
    }
  }
  return parsed;
}

export function assertCleanTrackedReleaseInputs({ rootDir, relativePaths }) {
  const dirtyFiles = getDirtyTrackedFiles({
    rootDir,
    relativePaths: [...new Set(relativePaths.map(validateTrackedRelativePath))].sort()
  });
  if (dirtyFiles.length === 0) {
    return;
  }

  throw new Error([
    'Tracked release input files have uncommitted changes:',
    ...dirtyFiles.map((relativePath) => `- ${relativePath}`),
    'Commit or stash these changes before building release artifacts.'
  ].join('\n'));
}

export function assertRequiredReleaseFilesTracked({ trackedFiles, version }) {
  for (const relativePath of getRequiredReleaseTrackedFiles(version)) {
    if (!trackedFiles.has(relativePath)) {
      throw new Error(`Required release file is not git-tracked: ${relativePath}`);
    }
  }
}

function getRequiredReleaseTrackedFiles(version) {
  return [
    'package.json',
    'install.sh',
    'install.ps1',
    'scripts/codex-json-agent.mjs',
    'scripts/uninstall-native-host.mjs',
    ...NATIVE_UNINSTALL_HELPER_ARTIFACTS.map((artifact) => artifact.source),
    'package-lock.json',
    'README.md',
    'LICENSE',
    'scripts/install-native-host.mjs',
    'scripts/verify-npm-package.mjs',
    'scripts/install-managed.mjs',
    'scripts/uninstall-managed.mjs',
    'scripts/sign-release-manifest.mjs',
    'extension/bootstrap/manifest.template.json',
    'extension/runtime-manifest.json'
  ];
}

function prepareReleaseOutputDir({ rootDir, outputDir }) {
  assertSafeReleaseOutputDir({ rootDir, outputDir });
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, RELEASE_OUTPUT_MARKER), 'codex-overleaf release output\n', 'utf8');
}

function isSamePathOrAncestor(candidateAncestor, targetPath) {
  const relative = path.relative(candidateAncestor, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function createExtensionZip({ rootDir, outputPath, trackedFiles, releaseRef, releaseChannel }) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-managed-extension-'));
  try {
    const version = readJson(path.join(rootDir, 'package.json')).version;
    buildManagedExtensionTree({
      packageRoot: rootDir,
      targetRoot: stagingRoot,
      version,
      releaseRef,
      releaseChannel,
      allowedFiles: trackedFiles
    });
    runRequiredCommand('zip', ['-qr', outputPath, '.'], { cwd: stagingRoot });
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function createCoordinatedUpdateBundle({ rootDir, outputPath, trackedFiles, version, releaseRef, releaseChannel }) {
  const managedExtensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-extension-'));
  try {
    buildManagedExtensionTree({
      packageRoot: rootDir,
      targetRoot: managedExtensionRoot,
      version,
      releaseRef,
      releaseChannel,
      allowedFiles: trackedFiles
    });
    const entries = [];
    for (const filePath of walkRegularFiles(path.join(managedExtensionRoot, 'runtime'))) {
      const relative = path.relative(path.join(managedExtensionRoot, 'runtime'), filePath).replace(/\\/g, '/');
      entries.push({ sourcePath: filePath, archivePath: `extension-runtime/${relative}` });
    }
    for (const entry of buildRuntimeFileManifest({ packageRoot: rootDir, allowedFiles: trackedFiles })) {
      entries.push({ sourcePath: entry.sourcePath, archivePath: `native-runtime/${entry.relativePath}` });
    }
    createUpdateBundleArchive({ outputPath, entries });
  } finally {
    fs.rmSync(managedExtensionRoot, { recursive: true, force: true });
  }
}

function walkRegularFiles(root) {
  const files = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, dirent.name);
    if (dirent.isDirectory()) files.push(...walkRegularFiles(child));
    else if (dirent.isFile()) files.push(child);
    else throw new Error(`Update bundle source contains unsupported entry: ${child}`);
  }
  return files;
}

function createNativeTarball({ rootDir, outputPath, trackedFiles }) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-native-release-'));
  try {
    for (const relativePath of getNativeTarballFiles(trackedFiles)) {
      copyTrackedFile({ rootDir, stagingRoot, relativePath, trackedFiles });
    }

    runRequiredCommand('tar', [
      '-czf',
      outputPath,
      '-C',
      stagingRoot,
      'package.json',
      'native-host',
      'extension',
      'scripts',
      'install.sh',
      'install.ps1'
    ]);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function createNpmTarball({ rootDir, outputPath, expectedName, trackedFiles }) {
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-npm-release-'));
  const expectedRootTarballPath = path.join(rootDir, expectedName);
  const generatedTarballs = new Set([path.resolve(expectedRootTarballPath)]);
  fs.rmSync(expectedRootTarballPath, { force: true });

  try {
    for (const relativePath of getNpmPackageReleaseInputFiles(trackedFiles)) {
      copyTrackedFile({ rootDir, stagingRoot, relativePath, trackedFiles });
    }

    runRequiredCommand('npm', ['run', '--silent', 'verify:npm-package'], { cwd: stagingRoot });
    const packOutput = runRequiredCommand('npm', ['pack', '--ignore-scripts', '--json'], { cwd: stagingRoot });
    const packuments = parseNpmPackJson(packOutput);
    if (packuments.length !== 1) {
      throw new Error(`npm pack must produce exactly one tarball; got ${packuments.length}.`);
    }

    const [{ filename }] = packuments;
    if (filename !== expectedName) {
      throw new Error(`npm pack produced ${filename || '<missing>'}; expected ${expectedName}.`);
    }

    const tarballPath = path.resolve(stagingRoot, filename);
    generatedTarballs.add(tarballPath);
    if (!fs.existsSync(tarballPath)) {
      throw new Error(`npm pack did not create expected tarball: ${filename}`);
    }

    copyFile(tarballPath, outputPath);
  } finally {
    for (const tarballPath of generatedTarballs) {
      if (path.resolve(tarballPath) !== path.resolve(outputPath)) {
        fs.rmSync(tarballPath, { force: true });
      }
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function parseNpmPackJson(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`Unable to parse npm pack --json output: ${error.message}`);
  }
  return Array.isArray(parsed) ? parsed : [parsed];
}

function getGitTrackedFiles(rootDir) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('Required command "git" was not found on PATH.');
  }
  if (result.status !== 0) {
    throw new Error(`Unable to list git-tracked files: ${result.stderr || result.stdout}`);
  }
  return new Set(result.stdout.split('\0').filter(Boolean).map(validateTrackedRelativePath));
}

function getGitHeadTrackedFiles(rootDir) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('Required command "git" was not found on PATH.');
  }
  if (result.status !== 0) {
    throw new Error(`Unable to list HEAD-tracked files: ${result.stderr || result.stdout}`);
  }
  return new Set(result.stdout.split('\0').filter(Boolean).map(validateTrackedRelativePath));
}

function getReleaseInputFilesForProvenance({ headTrackedFiles, indexTrackedFiles }) {
  return [...new Set([
    ...getReleaseInputFiles(headTrackedFiles),
    ...getReleaseInputFiles(indexTrackedFiles)
  ])].sort();
}

function getReleaseInputFiles(trackedFiles) {
  return [...new Set([
    'CHANGELOG.md',
    ...getNativeTarballFiles(trackedFiles),
    ...getNpmPackageReleaseInputFiles(trackedFiles),
    ...getExtensionArchiveFiles(trackedFiles).map((relativePath) => `extension/${relativePath}`)
  ])].sort();
}

function getDirtyTrackedFiles({ rootDir, relativePaths }) {
  if (relativePaths.length === 0) {
    return [];
  }

  const result = spawnSync('git', ['status', '--porcelain=v1', '-z', '--', ...relativePaths], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error('Required command "git" was not found on PATH.');
  }
  if (result.status !== 0) {
    throw new Error(`Unable to inspect release input status: ${result.stderr || result.stdout}`);
  }
  return parseDirtyTrackedStatus(result.stdout);
}

function parseDirtyTrackedStatus(output) {
  const entries = output.split('\0').filter(Boolean);
  const dirtyFiles = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const relativePath = entry.slice(3);
    if (status === '??') {
      continue;
    }
    dirtyFiles.push(validateTrackedRelativePath(relativePath));
    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
    }
  }
  return [...new Set(dirtyFiles)].sort();
}

function getExtensionArchiveFiles(trackedFiles) {
  const files = [...trackedFiles]
    .filter((relativePath) => (
      relativePath === 'extension/manifest.json' ||
      relativePath === 'extension/popup.html' ||
      relativePath === 'extension/runtime-manifest.json' ||
      relativePath.startsWith('extension/bootstrap/') ||
      relativePath.startsWith('extension/src/') ||
      relativePath.startsWith('extension/styles/') ||
      relativePath.startsWith('extension/assets/')
    ))
    .map((relativePath) => relativePath.slice('extension/'.length))
    .sort();

  for (const requiredFile of ['manifest.json', 'popup.html']) {
    if (!files.includes(requiredFile)) {
      throw new Error(`Required extension release file is not git-tracked: extension/${requiredFile}`);
    }
  }
  return files;
}

function getNativeTarballFiles(trackedFiles) {
  const files = [
    'package.json',
    'install.sh',
    'install.ps1',
    'scripts/codex-json-agent.mjs',
    'scripts/uninstall-native-host.mjs',
    'native-host/src/nativeHostPlatform.js',
    ...[...trackedFiles].filter((relativePath) => (
      relativePath.startsWith('native-host/src/') ||
      relativePath.startsWith('extension/src/shared/')
    ))
  ];
  return [...new Set(files.map(validateTrackedRelativePath))].sort();
}

function getNpmPackageReleaseInputFiles(trackedFiles) {
  const files = [
    'package.json',
    'package-lock.json',
    'README.md',
    'LICENSE',
    'scripts/codex-json-agent.mjs',
    'scripts/install-native-host.mjs',
    'scripts/uninstall-native-host.mjs',
    'scripts/install-managed.mjs',
    'scripts/uninstall-managed.mjs',
    'scripts/verify-npm-package.mjs',
    ...[...trackedFiles].filter((relativePath) => (
      relativePath.startsWith('bin/') ||
      relativePath.startsWith('native-host/src/') ||
      relativePath.startsWith('extension/')
    ))
  ];
  return [...new Set(files.map(validateTrackedRelativePath).filter((relativePath) => trackedFiles.has(relativePath)))].sort();
}

function copyTrackedFile({ rootDir, stagingRoot, relativePath, trackedFiles, targetRelativePath }) {
  const validatedRelativePath = validateTrackedRelativePath(relativePath);
  const validatedTargetRelativePath = validateTrackedRelativePath(targetRelativePath || relativePath);
  if (!trackedFiles.has(validatedRelativePath)) {
    throw new Error(`Required release file is not git-tracked: `);
  }
  copyFile(path.join(rootDir, validatedRelativePath), path.join(stagingRoot, validatedTargetRelativePath));
}

function validateTrackedRelativePath(relativePath) {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split('/').includes('..')
  ) {
    throw new Error(`Invalid git-tracked release path: ${relativePath}`);
  }
  return relativePath;
}

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode & 0o777);
}

function getReleaseNotesForBuild({ rootDir, version }) {
  const changelog = fs.readFileSync(path.join(rootDir, 'CHANGELOG.md'), 'utf8');
  let notes;
  try {
    notes = extractReleaseNotes(changelog, version);
  } catch (error) {
    if (version === '0.5.0') {
      notes = `## v${version} - ${DEFAULT_RELEASE_DATE}\n\nRelease notes pending.\n`;
    } else {
      throw error;
    }
  }
  return appendNpmReleaseGuidance(notes, version);
}

function appendNpmReleaseGuidance(releaseNotes, version) {
  return `${releaseNotes.trimEnd()}\n\n### npm native host package\n\n` +
    'Install the managed extension and native host once to enable signed automatic stable updates:\n\n' +
    '```bash\n' +
    `npm exec --yes codex-overleaf-link@${version} -- install-managed\n` +
    '```\n\n' +
    'The legacy native-only installer remains available for unmanaged extension directories:\n\n' +
    '```bash\n' +
    `npm exec --yes codex-overleaf-link@${version} -- install-native\n` +
    '```\n\n' +
    'Run native diagnostics with the same pinned package:\n\n' +
    '```bash\n' +
    `npm exec --yes codex-overleaf-link@${version} -- doctor\n` +
    '```\n\n' +
    'Uninstall the native host with the same pinned package:\n\n' +
    '```bash\n' +
    `npm exec --yes codex-overleaf-link@${version} -- uninstall-native\n` +
    '```\n';
}

function writeVersionPinnedInstallScript({ sourcePath, targetPath, releaseRef }) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const patched = source.replace(
    'REF="${CODEX_OVERLEAF_REF:-main}"',
    `REF="\${CODEX_OVERLEAF_REF:-${releaseRef}}"`
  );
  if (patched === source) {
    throw new Error('Unable to pin release install.sh default ref.');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, patched, 'utf8');
  fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
}

function writeVersionPinnedPowerShellInstallScript({ sourcePath, targetPath, releaseRef }) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const patched = source.replace(
    "$DefaultRef = 'main'",
    `$DefaultRef = '${releaseRef}'`
  );
  if (patched === source) {
    throw new Error('Unable to pin release install.ps1 default ref.');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, patched, 'utf8');
  fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
}

function writeTopLevelUninstallScript({ rootDir, sourcePath, targetPath }) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const patched = source
    .replace(
    "from '../native-host/src/nativeHostPlatform.js';",
    "from './nativeHostPlatform.js';"
    )
    .replace(
      "require('../native-host/src/runtimeInstaller.js')",
      "require('./runtimeInstaller.js')"
    )
    .replace(
      "if (path.resolve(process.argv[1] || '') === scriptPath) {\n  await main();\n}",
      [
        'function isDirectlyInvokedScript(argvPath, modulePath) {',
        '  if (!argvPath) {',
        '    return false;',
        '  }',
        '  const resolvedArgvPath = path.resolve(argvPath);',
        '  if (resolvedArgvPath === modulePath) {',
        '    return true;',
        '  }',
        '  try {',
        '    return fs.realpathSync(resolvedArgvPath) === fs.realpathSync(modulePath);',
        '  } catch {',
        '    return false;',
        '  }',
        '}',
        '',
        'if (isDirectlyInvokedScript(process.argv[1], scriptPath)) {',
        '  await main();',
        '}'
      ].join('\n')
    );
  if (patched === source) {
    throw new Error('Unable to rewrite top-level uninstall-native-host.mjs import path.');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, patched, 'utf8');
  fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
}

function writeTopLevelNativeHelperAssets({ rootDir, outputDir, trackedFiles }) {
  for (const artifact of NATIVE_UNINSTALL_HELPER_ARTIFACTS) {
    copyTrackedFile({
      rootDir,
      stagingRoot: outputDir,
      relativePath: artifact.source,
      targetRelativePath: artifact.name,
      trackedFiles
    });
  }
}

function getNpmTarballName(pkg) {
  return `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
}

function describeArtifact(filePath, name) {
  return {
    name,
    size: fs.statSync(filePath).size,
    sha256: sha256(filePath)
  };
}

function getGitCommit(rootDir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return 'unknown';
  }
  const commit = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(commit) ? commit : 'unknown';
}

function runRequiredCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1'
    },
    encoding: 'utf8'
  });
  if (result.error && result.error.code === 'ENOENT') {
    throw new Error(`Required command "${command}" was not found on PATH.`);
  }
  if (result.status !== 0) {
    throw new Error(`Command "${command} ${args.join(' ')}" failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

if (
  process.env.CODEX_OVERLEAF_TEST_IMPORT !== '1' &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
