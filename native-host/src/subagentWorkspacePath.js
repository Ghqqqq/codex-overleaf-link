'use strict';

const path = require('node:path');
const { SUBAGENT_QUEUE_DIR } = require('./mirrorWorkspace');

  function safeWorkspaceRelativePath(value) {
    if (typeof value !== 'string' || !value.trim()) {
      return null;
    }
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized || path.isAbsolute(normalized)) {
      return null;
    }
    let segments = normalized.split('/');
    if (segments.some(segment => segment === '..' || segment === '')) {
      return null;
    }
    // All consumers use the same identity, including control guards and locks.
    segments = segments.filter(segment => segment !== '.');
    if (!segments.length) return null;
    if (segments[0] === SUBAGENT_QUEUE_DIR) {
      // The queue control plane (jobs/results/logs/broker.json) is never
      // ownable — but the work/ scratch zone IS: single-file fan-out slices
      // live there (v1.6.1 scatter-gather), excluded from writeback by the
      // mirror-scan rule yet fully owned/hashed like any other job file.
      if (segments[1] === 'work' && segments.length >= 3) {
        return segments.join('/');
      }
      return null;
    }
    return segments.join('/');
  }

module.exports = { safeWorkspaceRelativePath };
