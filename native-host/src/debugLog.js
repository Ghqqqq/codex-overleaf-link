'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getCodexOverleafHome,
  getNativeHostPlatform
} = require('./nativeHostPlatform');

const MAX_FIELD_LENGTH = 8000;
const MAX_DEBUG_LOG_BYTES = 8 * 1024 * 1024;

function getDebugLogDir(options = {}) {
  return getCodexOverleafHome(options);
}

function getDebugLogPath(options = {}) {
  const platformPath = getNativeHostPlatform(options) === 'win32' ? path.win32 : path.posix;
  return platformPath.join(getDebugLogDir(options), 'native-host.log');
}

function logDebug(event, detail = {}, options = {}) {
  try {
    const logDir = getDebugLogDir(options);
    const logPath = getDebugLogPath(options);
    const record = `${JSON.stringify({
      time: new Date().toISOString(),
      event,
      detail: sanitize(detail)
    })}\n`;
    const recordBytes = Buffer.byteLength(record, 'utf8');
    if (recordBytes > MAX_DEBUG_LOG_BYTES) return;
    fs.mkdirSync(logDir, { recursive: true });
    try {
      const size = fs.statSync(logPath).size;
      if (size > MAX_DEBUG_LOG_BYTES) {
        // Discard oversized legacy logs instead of retaining a huge .1 copy.
        fs.truncateSync(logPath, 0);
      } else if (size + recordBytes > MAX_DEBUG_LOG_BYTES) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.appendFileSync(logPath, record, 'utf8');
    // Concurrent Hosts can cross the cap between stat and append/rename.
    // Logging is best-effort: drop an oversized raced file rather than grow it.
    for (const file of [logPath, `${logPath}.1`]) {
      try {
        if (fs.statSync(file).size > MAX_DEBUG_LOG_BYTES) fs.truncateSync(file, 0);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch {
    // Debug logging must never break the native messaging host.
  }
}

function truncateText(value, limit = MAX_FIELD_LENGTH) {
  const text = String(value || '');
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function sanitize(value) {
  if (typeof value === 'string') {
    return truncateText(value);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitize);
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'content') {
      result[key] = `[${String(item || '').length} chars]`;
    } else if (key === 'files' && Array.isArray(item)) {
      result[key] = item.map(file => ({
        path: file?.path,
        contentLength: String(file?.content || '').length
      }));
    } else {
      result[key] = sanitize(item);
    }
  }
  return result;
}

module.exports = {
  getDebugLogDir,
  getDebugLogPath,
  get LOG_PATH() {
    return getDebugLogPath();
  },
  logDebug,
  truncateText
};
