'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_NAME = 'cursor-credential.json';
const MAX_KEY_LENGTH = 8192;

function cursorCredentialPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.codex-overleaf', FILE_NAME);
}

function getCursorCredentialStatus(env = process.env) {
  return { configured: Boolean(readCursorApiKey(env)) };
}

function setCursorCredential(params = {}, env = process.env) {
  const filePath = cursorCredentialPath(env);
  const apiKey = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
  if (!apiKey) {
    fs.rmSync(filePath, { force: true });
    return { configured: false };
  }
  if (apiKey.length > MAX_KEY_LENGTH || /[\r\n]/.test(apiKey)) {
    throw credentialError('cursor_api_key_invalid', 'The Cursor API key is empty or too long.');
  }
  ensurePrivateDirectory(path.dirname(filePath));
  const temp = filePath + '.tmp-' + process.pid;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({ apiKey }) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(temp, 0o600);
  } catch (_error) {}
  fs.renameSync(temp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_error) {}
  const stored = readStoredCursorApiKey(env);
  if (stored !== apiKey) {
    throw credentialError('cursor_api_key_invalid', 'The Cursor API key could not be saved.');
  }
  return { configured: true };
}

function readCursorApiKey(env = process.env) {
  const explicit = String(env.CODEX_OVERLEAF_CURSOR_API_KEY || '').trim();
  if (explicit) return explicit;
  return readStoredCursorApiKey(env);
}

function readStoredCursorApiKey(env = process.env) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorCredentialPath(env), 'utf8'));
    const apiKey = typeof parsed?.apiKey === 'string' ? parsed.apiKey.trim() : '';
    return apiKey.length <= MAX_KEY_LENGTH ? apiKey : '';
  } catch (_error) {
    return '';
  }
}

function redactCursorSecret(value, env = process.env) {
  const key = readCursorApiKey(env);
  const text = String(value || '');
  return key ? text.split(key).join('[redacted]') : text;
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch (_error) {}
}

function credentialError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  getCursorCredentialStatus,
  readCursorApiKey,
  redactCursorSecret,
  setCursorCredential
};
