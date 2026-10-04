(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('RunRecoveryActions', [], factory);
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function create(deps = {}) {
    const { tx, failureNotice, refillComposerForRetry, openProjectFileForFailure, showNativeSetupGuidance,
      openStorageSettings, forceCancelStuckTaskForCurrentProject, getCurrentRunView, trackedChangeInFlight,
      openManualReviewFile, verifyManualReview, getCurrentProjectId, getAccountScopeId, checkCreatedDirectories } = deps;
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
    const context = failureNotice?.getRecoveryContext?.(report);
    if (appendManualReviewActions(context?.target || report, run, context?.failure || event?.failure)) return;
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
      'Sends a force-cancel to the native host that drops the project lock so a new run can start. Use this when refreshing the tab did not free the project.',
      '向 native host 发送强制取消请求，释放当前 Overleaf 项目的占用，让新的任务可以启动。刷新页面没用时使用。'
    );
    button.addEventListener('click', event => {
      event.stopPropagation();
      button.disabled = true;
      button.textContent = tx('Releasing…', '正在释放…');
      forceCancelStuckTaskForCurrentProject().then(result => {
        if (result?.ok) {
          button.textContent = tx('Force-released — you can retry the run.', '已释放，可以重试本轮任务。');
          return;
        }
        // The helper resolves (never throws) with a non-ok result when the
        // request was not delivered. Report the real outcome instead of a
        // blanket success, and re-enable the button so the user can retry.
        button.disabled = false;
        button.textContent = tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
      }).catch(() => {
        button.disabled = false;
        button.textContent = tx('Release failed — refresh the tab, then try again.', '释放失败，请刷新页面后重试。');
      });
    });
    report.append(button);
  }

  function appendManualReviewActions(target, run, failure) {
    if (!run || run.forkSnapshot || run.undoStatus === 'applied'
      || ['accepted', 'rejected'].includes(run.trackedChangeStatus)) return false;
    const safePath = value => typeof value === 'string' && value && !value.startsWith('/')
      && !/^[A-Za-z]:/.test(value) && !value.replace(/\\/g, '/').split('/').includes('..');
    const proof = run.manualReviewProof;
    const hasProof = proof?.v === 1 && Array.isArray(proof.files) && proof.files.length > 0;
    const paths = hasProof ? [...new Set(proof.files.map(file => file?.path).filter(safePath))]
      : failure?.code === 'tracked_changes_remain' && ['pending', 'needs_review'].includes(run.trackedChangeStatus)
        && safePath(failure.file) ? [failure.file] : [];
    if (!hasProof && !paths.length) return false;
    const busy = () => Boolean(getCurrentRunView?.()) || trackedChangeInFlight?.has(run.id) === true;
    const append = (kind, label, callback) => {
      const button = buildRecoveryButton('manual-review-' + kind, label,
        tx('Uses this run\'s original project and only reads or opens the review target.', '绑定本轮原项目，仅打开或只读核验审阅目标。'));
      button.dataset.manualReviewAction = kind;
      button.disabled = busy();
      button.addEventListener('click', async event => {
        event.stopPropagation();
        if (busy()) return;
        button.disabled = true;
        try { await callback(); }
        catch (_error) { /* The scope-bound runtime action owns feedback. */ }
        finally { button.disabled = busy(); }
      });
      target.append(button);
    };
    if (typeof openManualReviewFile === 'function') for (const file of paths) {
      append('open', tx(`Open ${file} for review`, `打开待核查文件：${file}`), () => openManualReviewFile(run.id, file));
    }
    if (hasProof && paths.length && typeof verifyManualReview === 'function') {
      append('verify', tx('Recheck review outcome', '重新核验审阅结果'), () => verifyManualReview(run.id));
    }
    // Never fall through to an action using the current project's generic
    // callback. Runtime callbacks above revalidate the proof and original run.
    return true;
  }

  function renderDirectoryCleanup(root, run) {
    const target = root.querySelector('[data-run-directory-cleanup]');
    if (!target) return;
    target.replaceChildren(); target.hidden = true;
    const pending = run?.pendingDirectoryCleanup;
    const current = () => pending?.v === 1 && typeof pending.projectId === 'string' && pending.projectId
      && typeof pending.accountScopeId === 'string' && pending.accountScopeId && pending.runId === run?.id
      && pending.projectId === getCurrentProjectId?.() && pending.accountScopeId === getAccountScopeId?.();
    if (!run || run.forkSnapshot || !current() || !Array.isArray(pending.directories)) return;
    const paths = [...new Set(pending.directories.filter(item => item?.projectId === pending.projectId
      && typeof item.path === 'string' && item.path && !item.path.startsWith('/') && !/^[A-Za-z]:/.test(item.path)
      && !item.path.replace(/\\/g, '/').split('/').includes('..')).map(item => item.path))];
    if (!paths.length) return;
    target.hidden = false; target.setAttribute('role', 'note');
    const message = document.createElement('p');
    message.textContent = tx('Folders remain for manual review. Checking only reads their status.', '文件夹仍待人工检查。检查只读取状态，不会删除文件夹。');
    const list = document.createElement('ul');
    for (const path of paths) { const item = document.createElement('li'); item.textContent = path; list.append(item); }
    target.append(message, list);
    if (typeof checkCreatedDirectories !== 'function') return;
    const busy = () => Boolean(getCurrentRunView?.()) || trackedChangeInFlight?.has(run.id) === true;
    const button = buildRecoveryButton('directory-cleanup-check', tx('Check remaining folders', '检查剩余目录'),
      tx('Read folder status in this run\'s original project. No folder will be deleted.', '只读核查本轮原项目中的目录状态，不会删除目录。'));
    button.setAttribute('data-run-directories-check', ''); button.disabled = busy();
    button.addEventListener('click', async event => {
      event.stopPropagation();
      if (!current() || busy()) return;
      button.disabled = true;
      try { await checkCreatedDirectories(run.id); }
      catch (_error) { /* The scope-bound runtime check owns feedback. */ }
      finally { button.disabled = busy() || !current(); }
    });
    target.append(button);
  }

    return { buildRecoveryButton, appendRecoveryActionForFailure, renderDirectoryCleanup };
  }
  return { create };
});
