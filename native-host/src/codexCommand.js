'use strict';

function resolveCodexCommand(env = process.env) {
  if (
    env.CODEX_OVERLEAF_ENV_READY === '1' ||
    Object.prototype.hasOwnProperty.call(env, 'CODEX_OVERLEAF_CODEX_PATH')
  ) {
    return env.CODEX_OVERLEAF_CODEX_PATH || '';
  }
  return 'codex';
}

function shouldUseShellForCommand(command, env = process.env) {
  const platform = env.CODEX_OVERLEAF_PLATFORM || process.platform;
  if (platform !== 'win32') {
    return false;
  }
  const text = String(command || '');
  return text === 'codex' || /\.(?:cmd|bat)$/i.test(text);
}

module.exports = {
  resolveCodexCommand,
  shouldUseShellForCommand
};
