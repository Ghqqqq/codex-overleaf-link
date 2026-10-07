import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function isolatedHopEnvironment(tempRoot, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|^CODEX|^NODE_OPTIONS$/i.test(key)));
  const directories = {
    HOME: 'home', USERPROFILE: 'home', CODEX_HOME: 'codex',
    CODEX_OVERLEAF_CODEX_HOME: 'plugin', CODEX_OVERLEAF_USER_CODEX_HOME: 'user-codex',
    CODEX_OVERLEAF_MIRROR_ROOT: 'mirror', npm_config_cache: 'cache', TMPDIR: 'tmp'
  };
  for (const [key, name] of Object.entries(directories)) {
    env[key] = path.join(tempRoot, name);
    fs.mkdirSync(env[key], { recursive: true });
  }
  return env;
}

// Trust injection is restricted to the disposable rehearsal process. Signed
// package bytes and installed target sources remain identical to the release.
export function writeTestTrustPreload({ tempRoot, targetRoot, keyId, publicKeyPem }) {
  const preload = path.join(tempRoot, 'local-test-trust.cjs');
  const trustPath = path.join(targetRoot, 'native-host', 'src', 'updateTrust.js');
  fs.writeFileSync(preload, [
    "'use strict';",
    `const trust = require(${JSON.stringify(trustPath)});`,
    'const verify = trust.verifySignedReleaseManifest;',
    'trust.verifySignedReleaseManifest = (manifest, signature, options = {}) =>',
    `  verify(manifest, signature, { ...options, publicKeys: ${JSON.stringify({ [keyId]: publicKeyPem })} });`,
    ''
  ].join('\n'), { mode: 0o600 });
  return preload;
}

export function startNativeSession({ launcherPath, env, timeoutMs = 15000 }) {
  const child = spawn(process.execPath, [launcherPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const calls = [];
  let buffered = Buffer.alloc(0);
  let stderr = '';
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(`Native process exited (${code ?? signal}): ${stderr}`));
    }
    pending.clear();
    resolve();
  }));
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  child.on('error', error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  });
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (length > 16 * 1024 * 1024) { child.kill(); return; }
      if (buffered.length < length + 4) return;
      let response;
      try { response = JSON.parse(buffered.subarray(4, length + 4).toString()); }
      catch (_) { stderr += '\nNative emitted an invalid JSON frame.'; child.kill(); return; }
      buffered = buffered.subarray(length + 4);
      const item = pending.get(response.id);
      if (!item || response.event) continue;
      pending.delete(response.id);
      clearTimeout(item.timer);
      item.resolve(response);
    }
  });
  function request(message) {
    if (exited) return Promise.reject(new Error(`Native is unavailable: ${stderr}`));
    const payload = { ...message, id: crypto.randomUUID() };
    calls.push(payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(payload.id);
        reject(new Error(`Native ${payload.method} timed out: ${stderr}`));
      }, timeoutMs);
      pending.set(payload.id, { resolve, reject, timer });
      const bytes = Buffer.from(JSON.stringify(payload));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(bytes.length);
      child.stdin.write(Buffer.concat([header, bytes]));
    });
  }
  return {
    calls, request,
    async invoke(method, params = {}) {
      const response = await request({ method, params });
      if (!response?.ok) throw new Error(`${method} failed: ${response?.error?.code}: ${response?.error?.message}`);
      return response.result;
    },
    async close() {
      child.stdin.end();
      let timer;
      await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 7000); })]);
      clearTimeout(timer);
      if (!exited) { child.kill('SIGTERM'); await exit; }
    }
  };
}

export function assertBootstrapSnapshot(extensionRoot, descriptor, expected) {
  if (!['source', 'target'].includes(expected)) throw new Error('Unknown Bootstrap snapshot kind.');
  const key = expected === 'source' ? 'sourceSha256' : 'targetSha256';
  const paths = new Set(descriptor.files.map(file => file.path));
  for (const file of descriptor.files) {
    if (!/^bootstrap\/[a-zA-Z0-9._-]+$/.test(file.path)) throw new Error('Invalid Bootstrap snapshot path.');
    const filename = path.join(extensionRoot, file.path);
    const observed = fs.existsSync(filename)
      ? crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') : null;
    if (observed !== file[key]) throw new Error(`Bootstrap ${expected} hash mismatch: ${file.path}`);
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (!entry.isFile() || !paths.has(path.relative(extensionRoot, filename).replace(/\\/g, '/'))) {
        throw new Error(`Unexpected Bootstrap entry: ${filename}`);
      }
    }
  }
  visit(path.join(extensionRoot, 'bootstrap'));
}

export async function stopHopWatchdogs(nativeRoot) {
  const directory = path.join(nativeRoot, 'updates', 'bootstrap-migrations');
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let heartbeat;
    try { heartbeat = JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'watchdog.json'), 'utf8')); }
    catch (_) { continue; }
    if (heartbeat.transactionId !== entry.name || !Number.isInteger(heartbeat.pid) || heartbeat.pid < 1) continue;
    // Only a monitor created inside this unique rehearsal tree is eligible.
    try { process.kill(heartbeat.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(heartbeat.pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
