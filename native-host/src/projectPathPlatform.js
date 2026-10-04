'use strict';

// Canonical project names stay literal. Reject names the local filesystem would
// reinterpret instead of attempting to escape, trim or rename them.
function isRepresentableProjectPath(value, platform = process.platform) {
  if (typeof value !== 'string' || !value) return false;
  if (platform !== 'win32') return true;
  return value.split('/').every(part => part && part !== '.' && part !== '..'
    && part.length <= 255 && !/[<>:"\\|?*\u0000-\u001f]/.test(part) && !/[ .]$/.test(part)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}

function assertProjectPathsForPlatform(paths, platform = process.platform) {
  const identities = new Map();
  for (const value of paths) {
    let valid = isRepresentableProjectPath(value, platform);
    if (valid && platform === 'win32') {
      const parts = value.split('/');
      for (let index = 1; index <= parts.length; index += 1) {
        const literal = parts.slice(0, index).join('/'), key = literal.toLowerCase();
        if (identities.has(key) && identities.get(key) !== literal) valid = false;
        identities.set(key, literal);
      }
    }
    if (!valid) throw Object.assign(new Error(`Project path cannot be represented faithfully on ${platform}: ${value}`),
      { code: 'project_path_unrepresentable', path: value });
  }
}

module.exports = { isRepresentableProjectPath, assertProjectPathsForPlatform };
