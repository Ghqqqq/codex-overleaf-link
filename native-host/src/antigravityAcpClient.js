'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createProcessStopIdentity,
  stopCodexAppServer
} = require('./codexSessionTiming');
const { sanitizeProviderMessage } = require('./providerRedaction');

const MAX_ACP_FRAME_CHARS = 16 * 1024 * 1024;
const MAX_ACP_STDERR_CHARS = 64 * 1024;
const EOF_EXIT_GRACE_MS = 120;
const CHILD_EXIT_DRAIN_MS = 200;

function acpError(message, code = 'ACP_TRANSPORT_CLOSED', extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function buildSpawnSpec(executable, geminiDir, platform = process.platform) {
  const args = ['acp', '--gemini-dir', geminiDir];
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(String(executable || ''))) {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || process.env.windir || process.env.WINDIR;
    const comspec = systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, 'System32', 'cmd.exe')
      : (process.env.ComSpec || 'cmd.exe');
    const quoteCmd = value => `"${String(value).replace(/"/g, '""')}"`;
    const commandString = `"${quoteCmd(executable)} acp --gemini-dir ${quoteCmd(geminiDir)}"`;
    return {
      command: comspec,
      args: ['/d', '/s', '/c', commandString],
      windowsVerbatimArguments: true
    };
  }
  return { command: executable, args, windowsVerbatimArguments: false };
}

class AntigravityAcpClient {
  constructor(executable, {
    cwd,
    geminiDir,
    env = process.env,
    timeoutMs = 30000,
    onNotification = null,
    onRequest = null,
    onActivity = null,
    onProcessStarted = null
  } = {}) {
    if (!executable) {
      throw acpError('Antigravity executable path is required.', 'antigravity_not_found');
    }
    if (!geminiDir || !path.isAbsolute(geminiDir)) {
      throw acpError('Antigravity isolated gemini directory must be an absolute path.', 'ACP_INVALID_CONFIG');
    }
    fs.mkdirSync(geminiDir, { recursive: true, mode: 0o700 });
    const resolvedCwd = path.resolve(cwd || process.cwd());
    fs.mkdirSync(resolvedCwd, { recursive: true });

    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.onActivity = onActivity;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.frameParts = [];
    this.frameLength = 0;
    this.failure = null;
    this.closed = false;
    this.closePromise = null;
    this.processGroup = process.platform !== 'win32';

    const spec = buildSpawnSpec(executable, geminiDir, process.platform);
    this.child = spawn(spec.command, spec.args, {
      cwd: resolvedCwd,
      env,
      shell: false,
      detached: this.processGroup,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.stopIdentity = createProcessStopIdentity(this.child, { processGroup: this.processGroup });
    try {
      onProcessStarted?.(this.stopIdentity);
    } catch (error) {
      this.fail(error);
    }

    this.stdoutEofTimer = null;
    const formatSanitizedStderrSuffix = () => {
      const trimmed = this.stderr.trim();
      if (!trimmed) return '';
      return `: ${sanitizeProviderMessage(trimmed, [], 1000)}`;
    };

    this.exitPromise = new Promise(resolve => {
      let drainTimer = null;
      const failExited = (code, signal) => {
        clearTimeout(this.stdoutEofTimer);
        this.stdoutEofTimer = null;
        const suffix = formatSanitizedStderrSuffix();
        this.fail(acpError(
          `Antigravity ACP exited before completing the request (${signal || `code ${code}`})${suffix}`,
          'ACP_PROCESS_EXITED'
        ));
      };
      this.child.once('error', error => {
        clearTimeout(this.stdoutEofTimer);
        this.stdoutEofTimer = null;
        const notFound = error?.code === 'ENOENT';
        const safeMessage = sanitizeProviderMessage(error?.message || 'spawn failed', [], 1000);
        this.fail(acpError(
          notFound
            ? 'Antigravity CLI (`agy`) was not found.'
            : `Cannot start Antigravity ACP: ${safeMessage}`,
          notFound ? 'antigravity_not_found' : 'ACP_SPAWN_FAILED',
          { cause: error }
        ));
        resolve();
      });
      this.child.once('exit', (code, signal) => {
        drainTimer = setTimeout(() => {
          failExited(code, signal);
          try { this.child.stdout?.destroy(); } catch (_error) {}
          try { this.child.stderr?.destroy(); } catch (_error) {}
          resolve();
        }, CHILD_EXIT_DRAIN_MS);
      });
      this.child.once('close', (code, signal) => {
        clearTimeout(drainTimer);
        failExited(code, signal);
        resolve();
      });
    });

    this.child.stdin.on('error', error => {
      if (!this.closed) {
        this.fail(acpError(`Antigravity ACP stdin error: ${sanitizeProviderMessage(error?.message || 'write error', [], 1000)}`));
      }
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.onActivity?.();
      this.read(chunk);
    });
    this.child.stdout.on('end', () => {
      if (this.closed) return;
      if (this.frameParts.some(part => part.trim())) {
        this.fail(acpError('Antigravity ACP ended with an incomplete JSON-RPC frame.', 'ACP_INVALID_FRAME'));
        return;
      }
      clearTimeout(this.stdoutEofTimer);
      this.stdoutEofTimer = setTimeout(() => {
        this.stdoutEofTimer = null;
        if (!this.closed) {
          this.fail(acpError(`Antigravity ACP closed stdout before completing pending requests${formatSanitizedStderrSuffix()}.`));
        }
      }, CHILD_EXIT_DRAIN_MS);
    });
    this.child.stdout.on('error', error => {
      if (!this.closed) {
        this.fail(acpError(`Antigravity ACP stdout error: ${sanitizeProviderMessage(error?.message || 'read error', [], 1000)}`));
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.onActivity?.();
      this.stderr = (this.stderr + chunk).slice(-MAX_ACP_STDERR_CHARS);
    });
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  fail(error) {
    if (!this.failure) {
      this.failure = error instanceof Error ? error : acpError(String(error || 'Antigravity ACP failed.'));
    }
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(this.failure);
    }
    this.pending.clear();
    for (const entry of this.serverRequests.values()) {
      entry.controller.abort();
    }
  }

  read(chunk) {
    if (this.failure || this.closed) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf('\n', offset);
      const end = newline < 0 ? chunk.length : newline;
      this.frameLength += end - offset;
      if (this.frameLength > MAX_ACP_FRAME_CHARS) {
        this.fail(acpError('Antigravity ACP frame exceeds the size limit.', 'ACP_INVALID_FRAME'));
        return;
      }
      this.frameParts.push(chunk.slice(offset, end));
      if (newline < 0) return;
      const rawLine = this.frameParts.join('');
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      this.frameParts = [];
      this.frameLength = 0;
      offset = newline + 1;
      if (!line.trim()) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch (_error) {
        this.fail(acpError('Antigravity ACP wrote invalid JSON to stdout.', 'ACP_INVALID_FRAME'));
        return;
      }
      if (!message || Array.isArray(message) || typeof message !== 'object' || message.jsonrpc !== '2.0') {
        this.fail(acpError('Antigravity ACP sent an invalid JSON-RPC 2.0 frame.', 'ACP_INVALID_FRAME'));
        return;
      }
      if (message.id === null) {
        if (message.error && typeof message.error === 'object') {
          this.fail(acpError(
            sanitizeProviderMessage(String(message.error.message || 'Antigravity ACP returned an unattributed JSON-RPC error.'), [], 2000),
            'ACP_RPC_ERROR',
            { rpcCode: message.error.code, rpcData: message.error.data }
          ));
        } else {
          this.fail(acpError('Antigravity ACP sent an invalid JSON-RPC frame with null id.', 'ACP_INVALID_FRAME'));
        }
        return;
      }
      if (message.id !== undefined && !(typeof message.id === 'string' || (typeof message.id === 'number' && Number.isFinite(message.id)))) {
        this.fail(acpError('Antigravity ACP sent an invalid JSON-RPC identifier.', 'ACP_INVALID_FRAME'));
        return;
      }

      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          // Do not await here: server-to-client requests must never block reading subsequent frames.
          void this.handleServerRequest(message);
        } else if (message.method === '$/cancel_request') {
          this.serverRequests.get(message.params?.requestId)?.controller.abort();
        } else {
          try {
            this.onNotification?.(message);
          } catch (error) {
            this.fail(error);
            return;
          }
        }
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        pending.cleanup();
        if (message.error) {
          pending.reject(acpError(
            sanitizeProviderMessage(String(message.error.message || 'Antigravity ACP request failed.'), [], 2000),
            'ACP_RPC_ERROR',
            { rpcCode: message.error.code, rpcData: message.error.data }
          ));
        } else if (Object.prototype.hasOwnProperty.call(message, 'result')) {
          try {
            pending.onResponse?.(message.result);
            pending.resolve(message.result);
          } catch (error) {
            pending.reject(error);
          }
        } else {
          pending.reject(acpError('Antigravity ACP response had neither result nor error.', 'ACP_INVALID_FRAME'));
        }
      } else {
        this.fail(acpError('Antigravity ACP sent an unrecognized JSON-RPC frame.', 'ACP_INVALID_FRAME'));
        return;
      }
    }
  }

  send(payload) {
    if (this.failure) throw this.failure;
    if (this.closed || !this.child.stdin?.writable) {
      throw acpError('Antigravity ACP connection is closed.');
    }
    const frame = `${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`;
    if (this.child.stdin.writableLength + Buffer.byteLength(frame, 'utf8') > MAX_ACP_FRAME_CHARS) {
      throw acpError('Antigravity ACP stdin buffer limit exceeded.', 'ACP_BACKPRESSURE');
    }
    this.onActivity?.();
    this.child.stdin.write(frame);
  }

  request(method, params = {}, { timeoutMs = this.timeoutMs, signal = null, onResponse = null } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : acpError('Antigravity ACP request aborted.', 'codex_cancelled'));
        return;
      }
      const id = this.nextId++;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        this.pending.delete(id);
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : acpError('Antigravity ACP request aborted.', 'codex_cancelled'));
      };
      this.pending.set(id, { method, resolve, reject, cleanup, onResponse });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(acpError(`Antigravity ACP ${method} timed out after ${timeoutMs}ms.`, 'ACP_REQUEST_TIMEOUT'));
        }, timeoutMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  cancelPendingPermissions(sessionId) {
    for (const [id, entry] of this.serverRequests.entries()) {
      if (entry.method !== 'session/request_permission' || entry.replied) continue;
      if (sessionId && entry.params?.sessionId && entry.params.sessionId !== sessionId) continue;
      try {
        this.send({ id, result: { outcome: { outcome: 'cancelled' } } });
      } catch (_error) {
        // Ignore broken pipe during cancellation; process shutdown follows.
      }
      entry.replied = true;
      entry.controller.abort();
    }
  }

  async handleServerRequest(message) {
    if (this.serverRequests.has(message.id)) {
      this.fail(acpError('Antigravity ACP reused an active server request id.', 'ACP_INVALID_FRAME'));
      return;
    }
    const controller = new AbortController();
    const entry = {
      controller,
      method: message.method,
      params: message.params,
      replied: false
    };
    this.serverRequests.set(message.id, entry);
    try {
      if (!this.onRequest) {
        throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
      }
      const result = await this.onRequest(message, controller.signal);
      if (!entry.replied && !this.closed && !this.failure) {
        this.send({ id: message.id, result });
        entry.replied = true;
      }
    } catch (error) {
      if (!entry.replied && !this.closed && !this.failure) {
        const code = Number.isInteger(error?.rpcCode) ? error.rpcCode : -32603;
        const errorMessage = code === -32601
          ? 'Method not found'
          : 'Antigravity client rejected server request.';
        try {
          this.send({ id: message.id, error: { code, message: errorMessage } });
          entry.replied = true;
        } catch (sendError) {
          this.fail(sendError);
        }
      }
    } finally {
      if (this.serverRequests.get(message.id) === entry) {
        this.serverRequests.delete(message.id);
      }
    }
  }

  close({ interrupt = null, reason = null } = {}) {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (typeof interrupt === 'function' && !this.stopIdentity.isStopped()) {
        try {
          await interrupt();
        } catch (_error) {
          // Bounded OS termination below remains authoritative.
        }
      }
      this.closed = true;
      clearTimeout(this.stdoutEofTimer);
      this.stdoutEofTimer = null;
      this.fail(reason || acpError('Antigravity ACP connection closed.'));
      try {
        this.child.stdin?.end();
      } catch (_error) {}
      if (!this.stopIdentity.isStopped()) {
        let timer = null;
        try {
          await Promise.race([
            this.exitPromise,
            new Promise(resolve => { timer = setTimeout(resolve, EOF_EXIT_GRACE_MS); })
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await stopCodexAppServer(this.child, {
        reason: reason || this.failure,
        processGroup: this.processGroup
      });
    })();
    return this.closePromise;
  }
}

module.exports = {
  AntigravityAcpClient,
  MAX_ACP_FRAME_CHARS,
  MAX_ACP_STDERR_CHARS,
  acpError,
  buildSpawnSpec
};
