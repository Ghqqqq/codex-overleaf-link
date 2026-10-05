(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('RunRecoveryActions', [], factory);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function formatForceCancelOutcome(response, tx) {
    if (response?.ok !== true) return tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
    const result = response.result || response;
    if (result.lockReleased === true) return tx('Force-released — you can retry the run.', '已释放，可以重试本轮任务。');
    if (result.cancelled === true) return tx('Cancellation requested. Wait for the task to stop before retrying.', '已请求取消，请等待任务停止后再重试。');
    if (result.cancelled === false) return tx('No active task matched the release request.', '没有发现与释放请求匹配的活动任务。');
    if (result.sent === true) return tx('Cancellation request sent; release is not yet confirmed.', '取消请求已发送，释放状态尚未确认。');
    return tx('Release is not yet confirmed. Check the current task before retrying.', '释放状态尚未确认，请检查当前任务后再重试。');
  }

  function create(deps = {}) {
    const { tx, failureNotice, refillComposerForRetry, openProjectFileForFailure, showNativeSetupGuidance,
      openStorageSettings, forceCancelStuckTaskForCurrentProject } = deps;
    const document = deps.document || globalThis.document;
    const window = deps.window || globalThis.window;

  const RETRYABLE_FAILURE_CODES = new Set([
    'native_request_failed', 'codex_timeout', 'codex_no_usable_result',
    'codex_output_limit', 'stale_source_changed', 'patch_anchor_not_found',
    'target_editor_not_ready', 'write_timeout', 'partial_write_needs_review',
    'write_operation_failed'
  ]);
  const NATIVE_SETUP_FAILURE_CODES = new Set([
    'native_bridge_unavailable', 'native_protocol_incompatible'
  ]);
  const OPEN_FILE_FAILURE_CODES = new Set([
    'target_file_not_active', 'target_file_open_failed', 'target_file_not_found'
  ]);
  const STORAGE_FAILURE_CODES = new Set([
    'storage_quota_exceeded', 'run_state_persist_failed'
  ]);
  // A missing `codex` binary is fixed in the terminal, not the panel — the
  // action opens the README troubleshooting section (PATH / login checks).
  const CODEX_INSTALL_FAILURE_CODES = new Set(['codex_not_found']);
  const CODEX_CLI_TROUBLESHOOTING_URL = 'https://github.com/Ghqqqq/codex-overleaf-link#faq-and-troubleshooting';

  function buildRecoveryButton(failureCode, label, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-final-answer__recovery-action';
    button.dataset.recoveryFor = failureCode;
    button.textContent = label;
    if (title) {
      button.title = title;
    }
    return button;
  }

  function appendEditAndResend(report, run, actionKey) {
    const retry = buildRecoveryButton(actionKey,
      tx('Edit & resend', '编辑后重发'),
      tx('Put this run\u2019s task back into the composer so you can adjust and resend it.', '把本轮任务填回输入框，修改后可直接重发。'));
    retry.addEventListener('click', clickEvent => {
      clickEvent.stopPropagation();
      refillComposerForRetry(run || null);
    });
    report.append(retry);
  }

  function appendRecoveryActionForFailure(report, event, run) {
    const recovery = failureNotice?.prepareRecovery(report, { openFile: openProjectFileForFailure });
    const failure = recovery?.failure || event?.failure;
    const failureCode = failure?.code || '';
    if (recovery?.handled) return;
    report = recovery?.target || report;
    if (RETRYABLE_FAILURE_CODES.has(failureCode) && typeof refillComposerForRetry === 'function') {
      appendEditAndResend(report, run, failureCode);
      return;
    }
    if (NATIVE_SETUP_FAILURE_CODES.has(failureCode) && typeof showNativeSetupGuidance === 'function') {
      const fix = buildRecoveryButton(failureCode,
        tx('Fix the native host', '修复 native host'),
        tx('Opens the install/update guidance with the copyable command.', '打开安装/更新指引（含可复制命令）。'));
      fix.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        showNativeSetupGuidance();
      });
      report.append(fix);
      return;
    }
    if (OPEN_FILE_FAILURE_CODES.has(failureCode) && failure?.file && typeof openProjectFileForFailure === 'function') {
      const open = buildRecoveryButton(failureCode,
        tx(`Open ${failure.file} in Overleaf`, `在 Overleaf 打开 ${failure.file}`), '');
      open.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        openProjectFileForFailure(failure.file);
      });
      report.append(open);
      return;
    }
    if (STORAGE_FAILURE_CODES.has(failureCode) && typeof openStorageSettings === 'function') {
      const clean = buildRecoveryButton(failureCode,
        tx('Open history & storage cleanup', '打开历史与存储清理'), '');
      clean.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        openStorageSettings();
      });
      report.append(clean);
      return;
    }
    if (CODEX_INSTALL_FAILURE_CODES.has(failureCode)) {
      const guide = buildRecoveryButton(failureCode,
        tx('Codex CLI troubleshooting guide', '查看 Codex CLI 排查指引'),
        tx('Opens the README section on fixing a missing `codex` command (PATH / login).', '打开 README 中「找不到 codex 命令」的排查说明（PATH／登录）。'));
      guide.addEventListener('click', clickEvent => {
        clickEvent.stopPropagation();
        window.open(CODEX_CLI_TROUBLESHOOTING_URL, '_blank', 'noopener');
      });
      report.append(guide);
      return;
    }
    if (failureCode !== 'codex_project_locked') return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-final-answer__recovery-action';
    button.dataset.recoveryFor = failureCode;
    button.textContent = tx('Force-release the stuck task', '强制释放卡住的任务');
    button.title = tx(
      'Requests cancellation for this project. A sent request does not confirm that the task has stopped. Use this when refreshing the tab did not free the project.',
      '请求取消当前项目的任务；请求已发送不代表任务已经停止。刷新页面仍未解除占用时使用。'
    );
    button.addEventListener('click', event => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = tx('Releasing…', '正在释放…');
      forceCancelStuckTaskForCurrentProject().then(result => {
        button.textContent = formatForceCancelOutcome(result, tx);
        button.disabled = result?.ok === true;
      }).catch(() => {
        button.disabled = false;
        button.textContent = tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
      });
    });
    report.append(button);
  }

    return { buildRecoveryButton, appendRecoveryActionForFailure };
  }
  return { create, formatForceCancelOutcome };
});
