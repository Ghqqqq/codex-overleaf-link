'use strict';

const { spawn } = require('node:child_process');
const { version: PACKAGE_VERSION } = require('../../package.json');
const { buildCodexHomeEnv } = require('./codexHome');
const { resolveCodexCommand, shouldUseShellForCommand } = require('./codexCommand');
const { buildCodexAppServerArgs } = require('./codexSessionRunner');

function forkCodexThread(params = {}, env = process.env) {
  const threadId = cleanId(params.threadId, 'threadId');
  const lastTurnId = cleanId(params.lastTurnId, 'lastTurnId');
  const childEnv = buildCodexHomeEnv(env, {
    loadCodexLocalSkills: params.loadCodexLocalSkills !== false,
    loadCodexOverleafSkills: params.loadCodexOverleafSkills !== false
  });
  const command = resolveCodexCommand(childEnv);
  if (!command) return Promise.reject(codedError('codex_not_found', 'Codex CLI was not found.'));

  return new Promise((resolve, reject) => {
    const child = spawn(command, buildCodexAppServerArgs({
      speedTier: params.speedTier || 'standard',
      loadCodexLocalSkills: params.loadCodexLocalSkills !== false
    }), {
      env: childEnv,
      shell: shouldUseShellForCommand(command, childEnv),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const pending = new Map();
    let nextId = 1;
    let buffer = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(codedError('codex_thread_fork_timeout', 'Codex thread fork timed out.')), 30000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) if (line.trim()) handleMessage(line);
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', finish);
    child.on('close', code => {
      if (!settled) finish(codedError('codex_thread_fork_failed', stderr || `Codex app-server exited with code ${code}.`));
    });

    (async () => {
      await request('initialize', {
        clientInfo: { name: 'codex-overleaf-link', version: PACKAGE_VERSION },
        capabilities: null
      });
      notify('initialized');
      const result = await request('thread/fork', { threadId, lastTurnId });
      const forkedThreadId = result?.thread?.id || result?.threadId || '';
      if (!forkedThreadId || forkedThreadId === threadId) {
        throw codedError('codex_thread_fork_invalid_response', 'Codex app-server did not return a new thread id.');
      }
      finish(null, { threadId: forkedThreadId, sourceThreadId: threadId, lastTurnId });
    })().catch(finish);

    function request(method, requestParams) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ id, method, params: requestParams })}\n`);
      return new Promise((resolveRequest, rejectRequest) => pending.set(id, { resolve: resolveRequest, reject: rejectRequest }));
    }
    function notify(method, requestParams) {
      child.stdin.write(`${JSON.stringify({ method, params: requestParams })}\n`);
    }
    function handleMessage(line) {
      let message;
      try { message = JSON.parse(line); } catch (_error) { return; }
      if (Object.prototype.hasOwnProperty.call(message, 'id') && (message.result !== undefined || message.error)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(codedError('codex_thread_fork_failed', message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      } else if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported during thread fork' } })}\n`);
      }
    }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const waiter of pending.values()) waiter.reject(error || codedError('codex_thread_fork_closed', 'Fork process closed.'));
      pending.clear();
      try { child.stdin.end(); } catch (_error) { /* best effort */ }
      try { child.kill(); } catch (_error) { /* best effort */ }
      if (error) reject(error); else resolve(result);
    }
  });
}

function cleanId(value, field) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) throw codedError('codex_thread_fork_invalid', `${field} is required.`);
  return id;
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
module.exports = { forkCodexThread };
