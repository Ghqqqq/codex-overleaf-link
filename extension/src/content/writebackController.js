(function initCodexOverleafWritebackController(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafWritebackController = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function writebackControllerFactory() {
  'use strict';

  function buildSyncApplyOperations(syncChanges = [], project = {}) {
    const existingPaths = new Set((project.files || []).map(file => file.path));
    return (syncChanges || []).map(change => {
      if (change.type === 'binary-create' || change.type === 'overwrite-binary') {
        return {
          type: change.type,
          path: change.path,
          contentBase64: change.contentBase64 || '',
          size: Number.isFinite(Number(change.size)) ? Number(change.size) : undefined,
          previousExists: change.previousExists === true,
          previousKind: change.previousKind || '',
          previousSize: Number.isFinite(Number(change.previousSize)) ? Number(change.previousSize) : undefined,
          reasonKey: change.type === 'overwrite-binary' ? 'localWorkspaceBinaryOverwrite' : 'localWorkspaceBinaryCreate',
          reason: change.type === 'overwrite-binary'
            ? 'Synced a binary asset replacement from the local Codex workspace.'
            : 'Synced a new binary asset from the local Codex workspace.'
        };
      }
      if (change.type === 'delete') {
        return {
          type: 'delete',
          path: change.path,
          reasonKey: 'localWorkspaceDelete',
          reason: 'Local Codex workspace deleted this file.'
        };
      }
      if (change.type === 'write' && existingPaths.has(change.path)) {
        const patches = getSyncChangePatches(change);
        if (patches.length) {
          return {
            type: 'edit',
            path: change.path,
            patches,
            reasonKey: 'localWorkspacePatch',
            reasonParams: { count: patches.length },
            reason: `Synced ${patches.length} local Codex workspace edit${patches.length === 1 ? '' : 's'}.`
          };
        }
        return {
          type: 'edit',
          path: change.path,
          replaceAll: String(change.content ?? ''),
          reasonKey: 'localWorkspaceContent',
          reason: 'Synced file content from the local Codex workspace.'
        };
      }
      return {
        type: 'create',
        path: change.path,
        content: change.content || '',
        reasonKey: 'localWorkspaceCreate',
        reason: 'Synced a new file from the local Codex workspace.'
      };
    }).filter(operation => operation.path);
  }

  function getSyncChangePatches(change = {}) {
    const normalized = normalizeTextPatches(change.patches);
    if (normalized.length) {
      return normalized;
    }
    if (typeof change.previousContent === 'string' && typeof change.content === 'string') {
      return computeSingleTextPatch(change.previousContent, change.content);
    }
    return [];
  }

  function normalizeTextPatches(patches) {
    const normalized = [];
    for (const patch of patches || []) {
      const from = Number(patch?.from);
      const to = Number(patch?.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
        continue;
      }
      normalized.push({
        from,
        to,
        expected: String(patch.expected ?? ''),
        insert: String(patch.insert ?? '')
      });
    }
    return normalized.sort((left, right) => left.from - right.from);
  }

  function computeSingleTextPatch(oldText, newText) {
    if (oldText === newText) {
      return [];
    }
    let prefix = 0;
    const sharedLength = Math.min(oldText.length, newText.length);
    while (prefix < sharedLength && oldText[prefix] === newText[prefix]) {
      prefix += 1;
    }

    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > prefix && newEnd > prefix && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }

    return [
      {
        from: prefix,
        to: oldEnd,
        expected: oldText.slice(prefix, oldEnd),
        insert: newText.slice(prefix, newEnd)
      }
    ];
  }

  function getAppliedOperationPaths(applied = {}) {
    const paths = [];
    for (const item of getAppliedEntries(applied)) {
      const operation = item?.operation || {};
      if (operation.path) {
        paths.push(operation.path);
      }
      if ((operation.type === 'rename' || operation.type === 'move') && operation.to) {
        paths.push(operation.to);
      }
    }
    return Array.from(new Set(paths.filter(Boolean)));
  }

  function getAppliedEntries(applied = {}) {
    return Array.isArray(applied?.applied) ? applied.applied : [];
  }

  function mergeVerifiedAppliedFiles(freshProject = {}, originalProject = {}, applied = {}) {
    const filesByPath = new Map((freshProject.files || []).map(file => [file.path, { ...file }]));
    const originalByPath = new Map((originalProject.files || []).map(file => [file.path, file]));

    for (const item of getAppliedEntries(applied)) {
      const operation = item?.operation || {};
      const result = item?.result || {};
      if (!operation.path) {
        continue;
      }

      if (operation.type === 'delete') {
        filesByPath.delete(operation.path);
        continue;
      }

      if ((operation.type === 'rename' || operation.type === 'move') && operation.to) {
        const previous = filesByPath.get(operation.path) || originalByPath.get(operation.path);
        filesByPath.delete(operation.path);
        filesByPath.set(operation.to, {
          ...(previous || {}),
          path: operation.to,
          kind: 'text',
          content: result.verifiedContent || previous?.content || '',
          source: 'verified-writeback'
        });
        continue;
      }

      if (operation.type === 'create') {
        filesByPath.set(operation.path, {
          path: operation.path,
          kind: 'text',
          content: result.verifiedContent || operation.content || '',
          source: 'verified-writeback'
        });
        continue;
      }

      if (operation.type === 'edit' && typeof result.verifiedContent === 'string') {
        filesByPath.set(operation.path, {
          ...(filesByPath.get(operation.path) || originalByPath.get(operation.path) || {}),
          path: operation.path,
          kind: 'text',
          content: result.verifiedContent,
          source: 'verified-writeback'
        });
      }
    }

    return {
      ...freshProject,
      files: Array.from(filesByPath.values())
    };
  }

  function formatUnsupportedLocalChangeSummary(changes = [], locale = 'en') {
    if (!changes.length) {
      return '';
    }
    const isEnglish = locale === 'en';
    const visibleChanges = changes.slice(0, 5);
    const lines = [
      isEnglish
        ? 'Codex generated these local files, but the extension did not sync them back to Overleaf:'
        : 'Codex 在本地生成了这些文件，但插件没有同步回 Overleaf：',
      ...visibleChanges.map(change => {
        const path = change.path || (isEnglish ? 'unnamed file' : '未命名文件');
        const reason = formatUnsupportedLocalChangeReason(change, locale);
        return isEnglish ? `- ${path}: ${reason}` : `- ${path}：${reason}`;
      })
    ];
    if (changes.length > visibleChanges.length) {
      const hiddenCount = changes.length - visibleChanges.length;
      lines.push(isEnglish
        ? `${hiddenCount} more file${hiddenCount === 1 ? '' : 's'} not shown.`
        : `另外 ${hiddenCount} 个文件未显示。`);
    }
    return lines.join('\n');
  }

  function formatUnsupportedLocalChangeReason(changeOrReason, locale = 'en') {
    const isEnglish = locale === 'en';
    const change = typeof changeOrReason === 'object' && changeOrReason
      ? changeOrReason
      : { reason: changeOrReason };
    const reason = change.reason;
    if (reason === 'generated_artifact') {
      return isEnglish
        ? 'LaTeX build artifact; not written back by default.'
        : 'LaTeX 构建产物，默认不写回。';
    }
    if (reason === 'unsupported_non_text_file') {
      return isEnglish
        ? 'Non-text file; automatic writeback is not supported yet.'
        : '非文本文件，暂不支持自动写回。';
    }
    if (reason === 'binary_payload_exceeds_native_message_limit') {
      return formatBinaryPayloadLimitReason(change, locale);
    }
    if (reason === 'subagent_unauthorized_edit') {
      return isEnglish
        ? "A subagent's change to this file was withheld from Overleaf — it either fell outside the subagent's assigned files or the subagent did not finish cleanly."
        : '子代理对该文件的改动未写回 Overleaf——它可能超出了被分配的文件范围，或没有正常完成。';
    }
    return isEnglish
      ? 'This file type is not supported for automatic writeback yet.'
      : '当前类型暂不支持自动写回。';
  }

  function formatBinaryPayloadLimitReason(change = {}, locale = 'en') {
    const isEnglish = locale === 'en';
    const size = formatBytes(change.size);
    const limit = formatBytes(change.limit || change.aggregateLimit || change.nativeOutputLimit);
    if (isEnglish) {
      const sizeText = size ? ` (${size})` : '';
      const limitText = limit ? ` or reduce it below ${limit}` : '';
      return `Binary change is too large to send through native messaging${sizeText}. Upload it in Overleaf${limitText}.`;
    }
    const sizeText = size ? `（${size}）` : '';
    const limitText = limit ? `，或减小到 ${limit} 以下` : '';
    return `二进制改动过大，无法通过 Native Messaging 返回${sizeText}。请在 Overleaf 中手动上传${limitText}。`;
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) {
      return '';
    }
    if (bytes < 1024) {
      return `${bytes} bytes`;
    }
    const kib = bytes / 1024;
    if (kib < 1024) {
      return `${formatByteNumber(kib)} KB`;
    }
    return `${formatByteNumber(kib / 1024)} MB`;
  }

  function formatByteNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  function getAppliedSyncChanges(syncChanges = [], applied = {}) {
    const appliedPaths = new Set(getAppliedEntries(applied)
      .map(item => item.operation?.path || item.operation?.to || item.operation?.from)
      .filter(Boolean));
    return (syncChanges || []).filter(change => appliedPaths.has(change.path));
  }

  return {
    buildSyncApplyOperations,
    computeSingleTextPatch,
    formatUnsupportedLocalChangeSummary,
    getAppliedOperationPaths,
    getAppliedSyncChanges,
    getSyncChangePatches,
    mergeVerifiedAppliedFiles,
    normalizeTextPatches
  };
});
