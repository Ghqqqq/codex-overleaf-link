#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const currentVersion = pkg.version;
const currentTag = `v${currentVersion}`;
const releaseDir = path.join(rootDir, 'dist', 'releases', currentTag);
const baseTag = process.env.CODEX_OVERLEAF_UPDATE_BASE_REF || findPreviousStableTag();
if (!baseTag) throw new Error('No previous stable tag is available for the managed update hop rehearsal.');
const baseVersion = baseTag.slice(1);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-update-hop-'));

try {
  const baseExtensionZip = path.join(tempRoot, `extension-${baseVersion}.zip`);
  const baseNativeTar = path.join(tempRoot, `native-${baseVersion}.tar.gz`);
  await downloadReleaseAsset(baseTag, `codex-overleaf-link-extension-v${baseVersion}.zip`, baseExtensionZip);
  await downloadReleaseAsset(baseTag, `codex-overleaf-native-host-v${baseVersion}.tar.gz`, baseNativeTar);

  const extensionRoot = path.join(tempRoot, 'managed-extension');
  const oldSourceRoot = path.join(tempRoot, 'old-source');
  const nativeRoot = path.join(tempRoot, 'managed-native');
  fs.mkdirSync(extensionRoot, { recursive: true });
  fs.mkdirSync(oldSourceRoot, { recursive: true });
  run('unzip', ['-q', baseExtensionZip, '-d', extensionRoot]);
  run('tar', ['-xzf', baseNativeTar, '-C', oldSourceRoot]);

  const oldVersionRoot = path.join(nativeRoot, 'versions', baseVersion);
  fs.mkdirSync(path.dirname(oldVersionRoot), { recursive: true });
  fs.cpSync(oldSourceRoot, oldVersionRoot, { recursive: true });
  fs.writeFileSync(path.join(nativeRoot, 'active-version'), `${baseVersion}\n`);
  const extensionMarkerPath = path.join(extensionRoot, '.codex-overleaf-managed-extension.json');
  const installedExtensionMarker = fs.existsSync(extensionMarkerPath)
    ? JSON.parse(fs.readFileSync(extensionMarkerPath, 'utf8'))
    : null;
  const baseBootstrapProtocol = Number(installedExtensionMarker?.bootstrapProtocol || 1);
  writeJson(
    path.join(nativeRoot, '.codex-overleaf-managed-native.json'),
    marker('native', baseVersion, baseBootstrapProtocol)
  );
  if (!fs.existsSync(extensionMarkerPath)) {
    writeJson(extensionMarkerPath, marker('extension', baseVersion, baseBootstrapProtocol));
  }

  const manifestBytes = fs.readFileSync(path.join(releaseDir, 'release-manifest.json'));
  const targetManifest = JSON.parse(manifestBytes);
  const signatureBytes = fs.readFileSync(path.join(releaseDir, 'release-manifest.sig'));
  const bundlePath = path.join(releaseDir, `codex-overleaf-update-v${currentVersion}.tar.gz`);
  const bundleBytes = fs.readFileSync(bundlePath);
  const oldUpdateManager = require(path.join(oldSourceRoot, 'native-host', 'src', 'updateManager.js'));
  const env = {
    ...process.env,
    CODEX_OVERLEAF_MANAGED: '1',
    CODEX_OVERLEAF_MANAGED_EXTENSION_ROOT: extensionRoot,
    CODEX_OVERLEAF_MANAGED_NATIVE_ROOT: nativeRoot
  };
  const fetch = createReleaseFetch({ manifestBytes, signatureBytes, bundleBytes });
  const invokeRaw = (method, params = {}) => oldUpdateManager.handleUpdateRequest({
    id: crypto.randomUUID(),
    method,
    params
  }, {
      env,
      fetch,
      getWorkState: () => ({ projectLocks: 0, runControllers: 0 })
    });
  const invoke = async (method, params = {}) => {
    const response = await invokeRaw(method, params);
    if (!response?.ok) throw new Error(`${method} failed: ${response?.error?.code}: ${response?.error?.message}`);
    return response.result;
  };

  if (targetManifest.bootstrapProtocol !== baseBootstrapProtocol) {
    if (targetManifest.bootstrapProtocol !== baseBootstrapProtocol + 1) {
      throw new Error(`Bootstrap migrations must increase by one: ${baseBootstrapProtocol} -> ${targetManifest.bootstrapProtocol}.`);
    }
    const rejected = await invokeRaw('update.check', { currentVersion: baseVersion });
    if (rejected?.ok || rejected?.error?.code !== 'update_bootstrap_upgrade_required') {
      throw new Error('Previous updater did not fail closed for the declared Bootstrap protocol migration.');
    }
    console.log(
      `Managed update baseline migration passed: ${baseTag} protocol ${baseBootstrapProtocol} rejects ` +
      `${currentTag} protocol ${targetManifest.bootstrapProtocol} and requires managed reinstall.`
    );
  } else {
    const checked = await invoke('update.check', { currentVersion: baseVersion });
    if (!checked.available || checked.latestVersion !== currentVersion) {
      throw new Error('Previous updater did not accept the current signed candidate.');
    }
    const authorizationId = crypto.randomUUID();
    await invoke('update.authorize', { authorizationId, currentVersion: baseVersion, targetVersion: currentVersion });
    const staged = await invoke('update.stage');
    const applied = await invoke('update.apply', { transactionId: staged.transactionId });
    if (applied.state !== 'awaiting_health') {
      throw new Error(`Previous updater ended in unexpected state: ${applied.state}`);
    }

    const activeVersion = fs.readFileSync(path.join(nativeRoot, 'active-version'), 'utf8').trim();
    const extensionManifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, 'manifest.json'), 'utf8'));
    if (activeVersion !== currentVersion || extensionManifest.version !== currentVersion) {
      throw new Error(`Managed pair did not activate together: extension=${extensionManifest.version}, native=${activeVersion}.`);
    }
    if (extensionManifest.background?.service_worker !== 'bootstrap/background.js') {
      throw new Error('Managed update replaced the immutable bootstrap entry point.');
    }
    const committed = await invoke('update.confirm', {
      transactionId: staged.transactionId,
      extensionVersion: currentVersion,
      nativeVersion: currentVersion
    });
    if (committed.state !== 'committed') {
      throw new Error(`Previous updater did not commit the healthy pair: ${committed.state}`);
    }
    console.log(`Managed update hop passed with the real ${baseTag} updater: ${baseVersion} -> ${currentVersion}.`);
  }
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function createReleaseFetch({ manifestBytes, signatureBytes, bundleBytes }) {
  return async (url, options = {}) => {
    const value = String(url || '');
    if (options.method === 'HEAD') {
      return response(Buffer.alloc(0), `https://github.com/Ghqqqq/codex-overleaf-link/releases/tag/${currentTag}`, 200);
    }
    if (value.endsWith('/release-manifest.json')) return response(manifestBytes, value, 200);
    if (value.endsWith('/release-manifest.sig')) return response(signatureBytes, value, 200);
    if (value.endsWith(`/codex-overleaf-update-v${currentVersion}.tar.gz`)) return response(bundleBytes, value, 200);
    return response(Buffer.alloc(0), value, 404);
  };
}

function response(bytes, url, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: name => String(name).toLowerCase() === 'content-length' ? String(bytes.length) : '' },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
}

async function downloadReleaseAsset(tag, name, target) {
  const url = `https://github.com/Ghqqqq/codex-overleaf-link/releases/download/${tag}/${name}`;
  const result = await fetch(url, { redirect: 'follow' });
  if (!result.ok) throw new Error(`Unable to download ${name}: HTTP ${result.status}`);
  const bytes = Buffer.from(await result.arrayBuffer());
  if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error(`Downloaded asset has an invalid size: ${name}`);
  fs.writeFileSync(target, bytes);
}

function marker(kind, version, bootstrapProtocol) {
  return { managedBy: 'codex-overleaf-link', kind, version, bootstrapProtocol, updatedAt: new Date().toISOString() };
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function findPreviousStableTag() {
  return git(['tag', '--merged', 'HEAD', '--sort=-v:refname'])
    .split('\n')
    .map(value => value.trim())
    .find(value => /^v\d+\.\d+\.\d+$/.test(value) && value !== currentTag) || '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: rootDir, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}
