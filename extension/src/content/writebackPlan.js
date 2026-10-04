(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CodexOverleafModuleRegistry.define('WritebackPlan', [], factory);
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  // Input validation, user approval, and audit projection precede page mutation.
  function create(deps = {}) {
    const { tx, tr, normalizeSafeProjectPath, GovernanceRules, getGovernanceRulesForCurrentProject,
      showPluginConfirm, formatOperationFiles, getAppliedEntries, getSkippedEntries } = deps;

  function partitionUnsafeProjectPathOperations(operations = []) {
    const safe = [];
    const skipped = [];
    for (const operation of operations || []) {
      const normalized = normalizeOperationProjectPaths(operation);
      const invalid = getInvalidOperationProjectPath(normalized);
      if (invalid) {
        skipped.push({
          operation: normalized,
          result: {
            ok: false,
            code: 'invalid_project_path',
            reason: tx(`Invalid ${invalid}. Codex did not write this file.`, `路径无效：${invalid}。Codex 没有写入这个文件。`)
          }
        });
        continue;
      }
      safe.push(normalized);
    }
    return { safe, skipped };
  }

  function normalizeOperationProjectPaths(operation = {}) {
    if (!operation || typeof operation !== 'object') {
      return operation;
    }
    const normalized = { ...operation };
    if (typeof operation.path === 'string') {
      normalized.path = normalizeSafeProjectPath(operation.path);
      if (!normalized.path) {
        normalized.invalidProjectPath = true;
      }
    }
    if (typeof operation.to === 'string') {
      normalized.to = normalizeSafeProjectPath(operation.to);
      if (!normalized.to) {
        normalized.invalidProjectDestinationPath = true;
      }
    }
    if (typeof operation.destinationPath === 'string') {
      normalized.destinationPath = normalizeSafeProjectPath(operation.destinationPath);
      if (!normalized.destinationPath) {
        normalized.invalidProjectDestinationPath = true;
      }
    }
    return normalized;
  }

  function getInvalidOperationProjectPath(operation = {}) {
    if (operation.invalidProjectPath || (requiresOperationPath(operation) && !operation.path)) {
      return 'operation path';
    }
    if (operation.invalidProjectDestinationPath || (requiresOperationDestinationPath(operation) && !(operation.to || operation.destinationPath))) {
      return 'operation destination path';
    }
    return '';
  }

  function requiresOperationPath(operation = {}) {
    return ['edit', 'create', 'delete', 'rename', 'move', 'binary-create', 'overwrite-binary'].includes(operation.type);
  }

  function requiresOperationDestinationPath(operation = {}) {
    return operation.type === 'rename' || operation.type === 'move';
  }


  function evaluateGovernedOperations(operations = []) {
    if (!GovernanceRules?.evaluateGovernedOperations) {
      return { allowed: operations || [], blocked: [], rules: getGovernanceRulesForCurrentProject() };
    }
    return GovernanceRules.evaluateGovernedOperations(operations, getGovernanceRulesForCurrentProject());
  }

  function buildGovernanceSkippedApplyResult(blockedItems = []) {
    return {
      ok: blockedItems.length === 0,
      applied: [],
      skipped: (blockedItems || []).map(item => ({
        operation: item.operation,
        result: {
          ok: false,
          code: 'governance_blocked',
          reason: formatGovernanceBlockedReason(item),
          reasonKey: item.reason || 'governance_blocked'
        }
      }))
    };
  }

  function formatGovernanceBlockedReason(item = {}) {
    if (item.reason === 'readonly') {
      return tx(
        'Project governance marked this path read-only, so Codex did not write it.',
        '项目治理规则将此路径标记为只读，因此 Codex 没有写入。'
      );
    }
    if (item.reason === 'writable_allowlist') {
      return tx(
        'Project governance allows writes only to configured writable patterns, and this path is outside that allowlist.',
        '项目治理规则只允许写入配置的可写路径，此路径不在允许范围内。'
      );
    }
    return tx('Project governance blocked this write.', '项目治理规则阻止了此写入。');
  }

  function filterSyncChangesByOperations(syncChanges = [], operations = []) {
    const allowedPaths = new Set((operations || []).map(operation => operation.path).filter(Boolean));
    return (syncChanges || []).filter(change => allowedPaths.has(change?.path));
  }

  function mergeApplyResultSkipped(result = {}, skipped = []) {
    if (!skipped.length) {
      return result;
    }
    return {
      ...(result || {}),
      ok: false,
      applied: Array.isArray(result?.applied) ? result.applied : [],
      skipped: [
        ...getSkippedEntries(result),
        ...skipped
      ]
    };
  }

  async function confirmBinaryOperations(operations = []) {
    const binaryOperations = (operations || []).filter(operation => operation.type === 'binary-create' || operation.type === 'overwrite-binary');
    if (!binaryOperations.length) {
      return { operations, skipped: [] };
    }
    const approved = await showPluginConfirm({
      title: tr('binaryAssetConfirmTitle'),
      message: tr('binaryAssetConfirmMessage', { files: formatOperationFiles(binaryOperations) }),
      confirmLabel: tr('binaryAssetConfirm'),
      cancelLabel: tr('binaryAssetCancel'),
      destructive: true
    });
    if (approved) {
      return { operations, skipped: [] };
    }
    return {
      operations: operations.filter(operation => operation.type !== 'binary-create' && operation.type !== 'overwrite-binary'),
      skipped: binaryOperations.map(operation => ({
        operation,
        result: {
          ok: false,
          code: 'binary_confirmation_rejected',
          reason: tx('Binary asset writeback requires explicit confirmation and was skipped.', '二进制资源写回需要显式确认，已跳过。')
        }
      }))
    };
  }

  function buildAuditDiffSummary(operations = []) {
    const changedFiles = new Set();
    let binaryFilesChanged = 0;
    for (const operation of operations || []) {
      if (operation?.path) {
        changedFiles.add(operation.path);
      }
      if (operation?.type === 'binary-create' || operation?.type === 'overwrite-binary') {
        binaryFilesChanged++;
      }
    }
    return {
      filesChanged: changedFiles.size,
      additions: 0,
      deletions: 0,
      binaryFilesChanged
    };
  }

  function buildAuditSummaryFromApply({ operations = [], applyResults = [], blockedFiles = [], resultStatus = 'completed', saveVerification = null } = {}) {
    const appliedFiles = [];
    const skippedFiles = [];
    for (const result of applyResults || []) {
      for (const item of getAppliedEntries(result)) {
        appliedFiles.push(summarizeOperationForAudit(item.operation, item.result, 'applied'));
      }
      for (const item of getSkippedEntries(result)) {
        skippedFiles.push(summarizeOperationForAudit(item.operation, item.result, 'skipped'));
      }
    }
    return {
      changedFiles: (operations || []).map(operation => summarizeOperationForAudit(operation, {}, 'changed')),
      ['diffSummary']: buildAuditDiffSummary(operations),
      blockedFiles,
      appliedFiles,
      skippedFiles,
      resultStatus,
      saveVerification
    };
  }

  // Tolerates `operation` and `result` being null in addition to undefined.
  // Default-parameter values fire only for `undefined`, but the v1.3.8
  // write-guard (pageBridge.runWriteGuard / writebackRouter.checkWritebackRunProjectId)
  // emits batch-level skips with `operation: null` — there is no specific
  // op to attribute the block to. Without this normalization the audit pass
  // crashed with "Cannot read properties of null (reading 'path')", the
  // outer-catch swallowed the partial-sync conclusion, and the user saw the
  // misleading "local Codex returned no usable result" fallback.
  function summarizeOperationForAudit(operation, result, status = '') {
    const op = operation || {};
    const res = result || {};
    return {
      path: op.path || op.from || op.to || '',
      destinationPath: op.destinationPath || op.to || '',
      type: op.type || '',
      reason: res.reasonKey || res.code || res.reason || op.reasonKey || op.reason || '',
      status,
      size: op.size
    };
  }

    return { partitionUnsafeProjectPathOperations, normalizeOperationProjectPaths, getInvalidOperationProjectPath, evaluateGovernedOperations, buildGovernanceSkippedApplyResult, filterSyncChangesByOperations, mergeApplyResultSkipped, confirmBinaryOperations, buildAuditSummaryFromApply, summarizeOperationForAudit };
  }
  return { create };
});
