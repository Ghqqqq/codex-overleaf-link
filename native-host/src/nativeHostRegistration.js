'use strict';

const path = require('node:path');

// Query only the selected browser's current-user default registration value.
// An unreadable/missing value is unknown discovery evidence, never healthy.
function queryWindowsNativeHostRegistration(target, options = {}) {
  const env = options.env || process.env;
  const run = options.spawnSync || require('node:child_process').spawnSync;
  let result;
  try { result = run(env.CODEX_OVERLEAF_REG_EXE || 'reg.exe', ['query', target.registryKey, '/ve'], {
    env, encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024
  }); } catch (_) { return { verified: false, status: 'unavailable' }; }
  if (result.error || result.status !== 0) return { verified: false, status: 'unavailable' };
  const values = [...String(result.stdout || '').matchAll(/^\s*.+?\s+REG_SZ\s+(.+?)\s*$/gm)].map(match => match[1]);
  if (values.length !== 1 || !path.win32.isAbsolute(values[0])) return { verified: false, status: 'unavailable' };
  const matches = path.win32.normalize(values[0]).toLowerCase() === path.win32.normalize(target.manifestPath).toLowerCase();
  return { verified: matches, status: matches ? 'verified' : 'mismatch', registeredManifestPath: values[0] };
}

module.exports = { queryWindowsNativeHostRegistration };
