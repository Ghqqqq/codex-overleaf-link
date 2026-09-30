'use strict';

const { refreshCodexRuntimeEnv } = require('./nativeEnvironment');
const { getCodexRuntimeIdentityFromEnv, compareCodexVersions, buildCodexRuntimeEvent } = require('./codexRuntimeIdentity');
const { logDebug } = require('./debugLog');

const UPGRADE_CODE = 'codex_model_requires_newer_cli';
const STOP_CODES = new Set(['codex_cancelled', 'codex_process_stop_unconfirmed', 'thread_resume_failed']);

function rejectedModel(error, expectedModel) {
  if (!error || STOP_CODES.has(error.code)) return '';
  let current = error, inheritedStatus = 0;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const detail = current.error && typeof current.error === 'object' ? current.error : current;
    const status = Number(current.status || current.statusCode || inheritedStatus);
    const type = detail.type || detail.code;
    const message = String(detail.message || current.message || '');
    const match = /^The ['"]([^'"]+)['"] model requires a newer version of Codex\b/i.exec(message.trim());
    if (status === 400 && type === 'invalid_request_error' && match) {
      return !expectedModel || match[1] === expectedModel ? match[1] : '';
    }
    inheritedStatus = status;
    if (message.length <= 12000 && message.trim().startsWith('{')) {
      try { current = JSON.parse(message); continue; } catch (_) {}
    }
    if (detail !== current) current = detail;
    else break;
  }
  return '';
}

function formatModelUpgradeError(error, env, options = {}) {
  if (error?.code === UPGRADE_CODE) return error;
  const model = rejectedModel(error, options.model);
  if (!model) return null;
  const identity = getCodexRuntimeIdentityFromEnv(env);
  const selected = identity.selected || {};
  const version = selected.version || env.CODEX_OVERLEAF_CODEX_VERSION || 'unknown';
  const pinned = identity.selectedBy === 'explicit-path' || identity.selectedBy === 'legacy-path';
  const chinese = /^zh\b/i.test(String(options.locale || ''));
  const message = chinese
    ? '模型 ' + model + ' 要求更新的 Codex 运行时。本次使用 CLI ' + version + '。'
      + (pinned ? '当前 CLI 路径已手动固定，请更新该安装或调整固定路径后重试。'
        : options.retried ? '切换本机较新版本后仍被拒绝，请更新 Codex 后重试。'
          : '未找到可自动切换的更新版本，请更新 Codex 后重试。')
    : 'Model ' + model + ' requires a newer Codex runtime. This task used CLI ' + version + '. '
      + (pinned ? 'The CLI path is pinned. Update that installation or change the configured path, then retry.'
        : options.retried ? 'The newer local CLI was also rejected. Update Codex and retry.'
          : 'No newer local CLI was available for automatic recovery. Update Codex and retry.');
  return Object.assign(new Error(message), {
    code: UPGRADE_CODE,
    details: {
      model, codexVersion: version, codexSource: selected.source || '',
      codexPath: selected.displayPath || selected.path || '',
      pinned, recoveryAttempted: options.retried === true
    }
  });
}

// This runner is used only for the isolated, read-only style-generation job.
// Its model/provider/input remain unchanged; the one retry changes only CLI env.
function createRecoveringStyleRunner(options) {
  let currentEnv = options.env;
  let retried = false;
  return async function run(input) {
    if (input.signal?.aborted) throw input.signal.reason || Object.assign(new Error('Cancelled'), { code: 'codex_cancelled' });
    try {
      return await options.execute({ ...input, env: currentEnv });
    } catch (error) {
      if (input.signal?.aborted || !rejectedModel(error, input.model)) throw error;
      const previous = getCodexRuntimeIdentityFromEnv(currentEnv);
      let refreshed = currentEnv;
      try { refreshed = refreshCodexRuntimeEnv(currentEnv, { force: true }); }
      catch (_) { /* Keep the original failure if discovery itself is unavailable. */ }
      const next = getCodexRuntimeIdentityFromEnv(refreshed);
      const newer = next.selected?.path && compareCodexVersions(
        next.selected.version, previous.selected?.version || ''
      ) > 0;
      if (!retried && newer) {
        retried = true;
        currentEnv = refreshed;
        if (input.signal?.aborted) throw input.signal.reason || Object.assign(new Error('Cancelled'), { code: 'codex_cancelled' });
        logDebug('codex.runtime.model_retry_started', {
          model: input.model, previousVersion: previous.selected?.version || '',
          selectedVersion: next.selected.version, source: next.selected.source
        });
        const runtimeEvent = buildCodexRuntimeEvent(currentEnv);
        if (runtimeEvent && typeof options.emit === 'function') options.emit(runtimeEvent);
        try {
          const result = await options.execute({ ...input, env: currentEnv });
          logDebug('codex.runtime.model_retry_completed', { model: input.model, selectedVersion: next.selected.version });
          return result;
        } catch (retryError) {
          if (input.signal?.aborted) throw retryError;
          throw formatModelUpgradeError(retryError, currentEnv, {
            model: input.model, locale: options.locale, retried: true
          }) || retryError;
        }
      }
      throw formatModelUpgradeError(error, currentEnv, {
        model: input.model, locale: options.locale, retried
      }) || error;
    }
  };
}

module.exports = { createRecoveringStyleRunner, formatModelUpgradeError };
