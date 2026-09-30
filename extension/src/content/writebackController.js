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
          assetRef: change.assetRef && typeof change.assetRef === 'object' ? { ...change.assetRef } : undefined,
          sha256: change.sha256 || change.assetRef?.sha256 || '',
          mimeType: change.mimeType || change.assetRef?.mimeType || '',
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
    if (reason === 'selection_scope_violation') {
      return isEnglish
        ? 'The local changes exceeded the captured selection. No changes from this task were written back.'
        : '本地改动超出了已附加的选区，本轮改动未写回。';
    }
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
    if (reason === 'subagent_unfinished_output') {
      return isEnglish
        ? 'The subagent did not finish; the main agent must review and adopt this file before it can sync.'
        : '子代理未正常完成，主代理需核对并接管该文件后才能同步。';
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


  // Verify the server revision independently of editor overlays. No writes or retries
  // of writes are performed here; a missing acknowledgement never becomes success.
  function buildSavedWritebackExpectations(applied = {}, project = {}) {
    const expected = new Map();
    const original = new Map((project.files || []).map(file => [file.path, file]));
    const unsupported = [];
    for (const entry of getAppliedEntries(applied)) {
      const operation = entry?.operation || {};
      const result = entry?.result || {};
      const path = operation.path;
      if (!path || result.ok === false) { unsupported.push(path || 'unknown'); continue; }
      if (operation.type === 'delete') { expected.set(path, { absent: true }); continue; }
      if (operation.type === 'rename' || operation.type === 'move') {
        const content = typeof result.verifiedContent === 'string'
          ? result.verifiedContent : original.get(path)?.content;
        if (!operation.to || typeof content !== 'string') { unsupported.push(path); continue; }
        if (operation.to !== path) expected.set(path, { absent: true });
        expected.set(operation.to, { content });
        continue;
      }
      if (operation.type === 'binary-create' || operation.type === 'overwrite-binary') {
        const hash = operation.sha256 || operation.assetRef?.sha256;
        if (/^[a-f0-9]{64}$/i.test(hash || '')) expected.set(path, { sha256: hash.toLowerCase() });
        else if (typeof operation.contentBase64 === 'string'
          && (operation.contentBase64 || !operation.assetRef || operation.size === 0)) {
          expected.set(path, { contentBase64: operation.contentBase64.replace(/\s/g, '') });
        } else unsupported.push(path);
        continue;
      }
      const content = typeof result.verifiedContent === 'string' ? result.verifiedContent
        : operation.type === 'create' && typeof operation.content === 'string' ? operation.content
          : operation.type === 'edit' && typeof operation.replaceAll === 'string' ? operation.replaceAll : undefined;
      if (typeof content === 'string') expected.set(path, { content });
      else unsupported.push(path);
    }
    return { expected, unsupported };
  }

  async function matchSavedWritebackSnapshot(snapshot, expectations, projectId) {
    if (snapshot?.id !== projectId || snapshot?.ok === false
      || snapshot?.capabilities?.method !== 'overleaf-zip'
      || snapshot.capabilities.fullProjectSnapshot !== true || !Array.isArray(snapshot.files)
      || snapshot.files.some(file => file?.source !== 'overleaf-zip')) {
      return { matched: false, reason: 'authoritative_snapshot_unavailable' };
    }
    if (!expectations.expected.size || expectations.unsupported.length) {
      return { matched: false, reason: 'expected_content_unavailable' };
    }
    const byPath = new Map(snapshot.files.map(file => [file.path, file]));
    for (const [path, expected] of expectations.expected) {
      const file = byPath.get(path);
      if (expected.absent) {
        if (file || snapshot.capabilities.skipped?.length) return { matched: false, reason: 'server_content_mismatch', path };
        continue;
      }
      if (!file) return { matched: false, reason: 'server_content_mismatch', path };
      if (typeof expected.content === 'string') {
        if (file.content !== expected.content) return { matched: false, reason: 'server_content_mismatch', path };
      } else {
        if (typeof file.contentBase64 !== 'string') return { matched: false, reason: 'server_binary_unavailable', path };
        if (expected.contentBase64 !== undefined) {
          if (file.contentBase64.replace(/\s/g, '') !== expected.contentBase64) return { matched: false, reason: 'server_content_mismatch', path };
        } else {
          const hash = await binaryDigest(file.contentBase64);
          if (!hash) return { matched: false, reason: 'binary_digest_unavailable', path };
          if (hash !== expected.sha256) return { matched: false, reason: 'server_content_mismatch', path };
        }
      }
    }
    return { matched: true };
  }

  async function confirmPostWriteSave(options = {}) {
    const { applied, project, runProjectId, assertCurrent, readSaveState, readSnapshot } = options;
    if (!runProjectId || typeof assertCurrent !== 'function') {
      return { verification: { ok: false, state: 'unavailable', signal: 'context_missing' } };
    }
    const now = options.now || Date.now;
    const deadline = now() + 90000;
    const attempts = [];
    const isInterruption = error => ['codex_cancelled', 'aborted_project_changed', 'editor_project_id_unavailable'].includes(error?.code)
      || error?.name === 'AbortError';
    const probe = async duration => {
      assertCurrent();
      try {
        const result = await readSaveState({ deadlineMs: Math.max(0, Math.min(duration, deadline - now())), requirePositiveSignal: true });
        assertCurrent();
        return result || { ok: false, state: 'unavailable', signal: 'unavailable' };
      } catch (error) {
        if (isInterruption(error)) throw error;
        assertCurrent();
        return { ok: false, state: 'unavailable', signal: 'unavailable', reason: String(error?.message || error).slice(0, 800) };
      }
    };
    const receiptExpectations = buildSavedWritebackExpectations(applied, project);
    assertCurrent();
    if (await receiptsConfirmExpectedFiles(applied, receiptExpectations, runProjectId)) {
      assertCurrent();
      return { verification: { ok: true, state: 'verified_saved', source: 'server-receipts' } };
    }
    const primary = await probe(1500);
    if (primary.ok === true && primary.state === 'verified_saved') {
      return { verification: { ...primary, source: 'save-indicator' } };
    }
    const expectations = buildSavedWritebackExpectations(applied, project);
    let lastReason = '';
    if (primary.signal !== 'offline' && expectations.expected.size && !expectations.unsupported.length) {
      for (let attempt = 0; attempt < 3 && deadline - now() > 1000; attempt++) {
        assertCurrent();
        try {
          const snapshot = await readSnapshot({
            force: true, maxAgeMs: 0, zipOnly: true, serverOnly: true,
            includeBinaryFiles: true, allowEditorNavigation: false, requireFullProject: true,
            zipTimeoutMs: Math.max(1, Math.min(30000, deadline - now())),
            saveCheckId: String(now()) + '-' + attempt + '-' + Math.random().toString(36).slice(2, 8)
          });
          assertCurrent();
          const match = await matchSavedWritebackSnapshot(snapshot, expectations, runProjectId);
          assertCurrent();
          attempts.push({ attempt: attempt + 1, result: match.matched ? 'matched' : match.reason, path: match.path || '' });
          if (match.matched) return {
            verification: { ok: true, state: 'verified_saved', source: 'overleaf-zip', recovered: true,
              primary: { state: primary.state, signal: primary.signal, reason: primary.reason }, attempts },
            snapshot
          };
          lastReason = match.reason;
        } catch (error) {
          if (isInterruption(error)) throw error;
          assertCurrent();
          lastReason = String(error?.message || error).slice(0, 800);
          attempts.push({ attempt: attempt + 1, result: 'snapshot_unavailable', reason: lastReason });
        }
      }
    }
    const final = primary.signal === 'offline' ? primary : await probe(2000);
    if (final.ok === true && final.state === 'verified_saved') {
      return { verification: { ...final, source: 'save-indicator', recovered: true, attempts } };
    }
    return { verification: {
      ok: false, state: final.state === 'unavailable' ? 'unavailable' : 'unknown_timeout',
      signal: final.signal || primary.signal || 'unavailable',
      reason: final.reason || primary.reason || 'No positive save evidence was available.',
      recoveryReason: lastReason || (expectations.unsupported.length ? 'expected_content_unavailable' : ''),
      attempts
    } };
  }

  async function bytesDigest(bytes) {
    if (!globalThis.crypto?.subtle) return '';
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function textDigest(content) {
    return typeof TextEncoder === 'function' ? bytesDigest(new TextEncoder().encode(content)) : '';
  }

  async function binaryDigest(contentBase64) {
    if (typeof contentBase64 !== 'string' || typeof atob !== 'function') return '';
    let bytes;
    try { bytes = Uint8Array.from(atob(contentBase64.replace(/\s/g, '')), value => value.charCodeAt(0)); }
    catch (_error) { return ''; }
    return bytesDigest(bytes);
  }

  async function receiptsConfirmExpectedFiles(applied, expectations, projectId) {
    if (!expectations.expected.size || expectations.unsupported.length) return false;
    const entries = getAppliedEntries(applied);
    for (const [path, expected] of expectations.expected) {
      if (typeof expected.content !== 'string') return false;
      const receipt = [...entries].reverse().find(entry => entry.operation?.path === path)?.result?.saveReceipt;
      if (receipt?.v !== 1 || receipt.source !== 'overleaf-zip' || receipt.projectId !== projectId
        || receipt.path !== path || !Number.isFinite(Date.parse(receipt.verifiedAt || ''))
        || !/^[a-f0-9]{64}$/.test(receipt.sha256 || '') || receipt.sha256 !== await textDigest(expected.content)) return false;
    }
    return true;
  }

  async function buildSaveCheck(applied, project, owner) {
    const expectations = buildSavedWritebackExpectations(applied, project);
    if (expectations.unsupported.length) return null;
    const files = [];
    for (const [path, expected] of expectations.expected) {
      if (expected.absent) files.push({ path, absent: true });
      else if (typeof expected.content === 'string') {
        const sha256 = await textDigest(expected.content);
        if (!sha256) return null;
        files.push({ path, sha256, kind: 'text' });
      } else {
        const sha256 = expected.sha256 || await binaryDigest(expected.contentBase64);
        if (!sha256) return null;
        files.push({ path, sha256, kind: 'binary' });
      }
    }
    return files.length ? { ...owner, v: 1, files } : null;
  }

  async function confirmSaveCheck(check, options) {
    if (!check?.projectId || !Array.isArray(check.files) || !check.files.length
      || check.files.some(file => !file?.path || (file.absent !== true && !/^[a-f0-9]{64}$/i.test(file.sha256 || '')))) {
      return { ok: false, state: 'unavailable', reason: 'expected_content_unavailable' };
    }
    const now = options.now || Date.now, deadline = now() + 90000;
    let reason = 'server_snapshot_unavailable';
    for (let attempt = 0; attempt < 3 && now() < deadline; attempt++) {
      options.assertCurrent();
      let snapshot;
      try {
        snapshot = await options.readSnapshot({ force: true, maxAgeMs: 0, zipOnly: true, serverOnly: true,
          includeBinaryFiles: true, allowEditorNavigation: false, requireFullProject: true,
          zipTimeoutMs: Math.min(30000, Math.max(1, deadline - now())), saveCheckId: String(now()) + '-' + attempt });
      } catch (error) {
        if (['codex_cancelled', 'aborted_project_changed', 'editor_project_id_unavailable'].includes(error?.code)
          || error?.name === 'AbortError') throw error;
        options.assertCurrent();
        continue;
      }
      options.assertCurrent();
      if (snapshot?.ok === false || snapshot?.id !== check.projectId
        || snapshot.capabilities?.fullProjectSnapshot !== true
        || snapshot.capabilities?.method !== 'overleaf-zip' || !Array.isArray(snapshot.files)) continue;
      const files = new Map(snapshot.files.map(file => [file.path, file]));
      let matched = true;
      for (const expected of check.files) {
        const file = files.get(expected.path);
        if (expected.absent) { if (file || snapshot.capabilities.skipped?.length) matched = false; continue; }
        if (!file || file.source !== 'overleaf-zip') { matched = false; continue; }
        const kind = typeof file.content === 'string' ? 'text'
          : typeof file.contentBase64 === 'string' ? 'binary' : '';
        if (!kind || (expected.kind && expected.kind !== kind)) { matched = false; continue; }
        const hash = kind === 'binary' ? await binaryDigest(file.contentBase64) : await textDigest(file.content);
        if (!hash || hash !== expected.sha256.toLowerCase()) matched = false;
      }
      options.assertCurrent();
      if (matched) return { ok: true, state: 'verified_saved', source: 'overleaf-zip' };
      reason = 'server_content_mismatch';
    }
    return { ok: false, state: 'unknown_timeout', reason };
  }

  return {
    confirmPostWriteSave,
    buildSaveCheck,
    confirmSaveCheck,
    buildSavedWritebackExpectations,
    matchSavedWritebackSnapshot,
    buildSyncApplyOperations,
    computeSingleTextPatch,
    formatUnsupportedLocalChangeSummary,
    formatUnsupportedLocalChangeReason,
    getAppliedOperationPaths,
    getAppliedSyncChanges,
    getSyncChangePatches,
    mergeVerifiedAppliedFiles,
    normalizeTextPatches
  };
});
