(function initUndoOperations(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./staleGuard'));
  } else {
    root.CodexOverleafUndoOperations = factory(root.CodexOverleafStaleGuard);
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function undoOperationsFactory(StaleGuard) {
  'use strict';

  function buildUndoOperations(project, appliedOperations) {
    return buildUndoPlan(project, appliedOperations).undoOperations;
  }

  function getUndoUnavailableFiles(run = {}) {
    const payload = run.recoveryPayload || run;
    const files = new Map();
    for (const operation of payload.appliedOperations || []) {
      const reason = operation?.undoUnavailable;
      if (typeof reason?.path === 'string' && reason.path === operation?.path
        && ['stale_source_changed', 'snapshot_undo_unavailable'].includes(reason.code)) {
        files.set(reason.path, { path: reason.path, code: reason.code });
      }
    }
    return [...files.values()];
  }

  function withAvailableUndo(run = {}) {
    const unavailable = new Set(getUndoUnavailableFiles(run).map(item => item.path));
    if (!unavailable.size) return run;
    const result = { ...run };
    for (const field of ['undoOperations', 'undoBaseFiles', 'undoExpectedFiles', 'undoTrackedChanges', 'trackedChangeCaptures']) {
      result[field] = (run[field] || []).filter(item => !unavailable.has(item?.path) && !unavailable.has(item?.to));
    }
    return result;
  }

  // Fallback history keeps only bounded reasons, never document bytes or
  // authority to reconstruct a withheld checkpoint.
  function compactUnavailableUndoOperations(run = {}) {
    if (run.forkSnapshot || run.undoStatus === 'applied' || ['accepted', 'rejected'].includes(run.trackedChangeStatus)) return [];
    return getUndoUnavailableFiles(run).filter(item => item.path.length <= 1024).slice(0, 100)
      .map(item => ({ type: 'edit', path: item.path, undoUnavailable: item }));
  }

  function buildUndoPlan(project, appliedOperations) {
    const workingFilesByPath = new Map();
    for (const file of project?.files || []) {
      if (typeof file?.path === 'string' && typeof file.content === 'string') {
        workingFilesByPath.set(file.path, file.content);
      }
    }

    const sourceFilesByPath = new Map(workingFilesByPath);
    const undo = [];
    const inverseBases = new Map();
    const mappedPaths = new Set((appliedOperations || []).filter(operation => Array.isArray(operation?.appliedPatches))
      .map(operation => operation.path));
    const unavailable = new Map(getUndoUnavailableFiles({ appliedOperations }).map(item => [item.path, item.code]));
    const fullRestoreEditPaths = new Set();

    for (const operation of appliedOperations || []) {
      if (!operation || typeof operation.type !== 'string') {
        continue;
      }

      if (operation.type === 'edit') {
        if (!operation.path || !workingFilesByPath.has(operation.path)) {
          continue;
        }
        const currentBeforeEdit = workingFilesByPath.get(operation.path);
        if (!fullRestoreEditPaths.has(operation.path)) {
          const hasAppliedPatches = Array.isArray(operation.appliedPatches) && typeof operation.verifiedContent === 'string';
          const inversePatches = hasAppliedPatches
            ? buildVerifiedInversePatches(operation.appliedPatches, operation.verifiedContent)
            : buildInverseTextPatches(sourceFilesByPath.get(operation.path), operation.patches,
              operation.verifiedContent, operation.path);
          let inverse;
          if (inversePatches.length) {
            inverse = normalizeUndoOperation({
              type: 'edit',
              path: operation.path,
              patches: inversePatches,
              reason: 'Undo edit'
            });
          } else if (!hasAppliedPatches) {
            fullRestoreEditPaths.add(operation.path);
            inverse = normalizeUndoOperation({
              type: 'edit',
              path: operation.path,
              replaceAll: currentBeforeEdit,
              reason: 'Undo edit'
            });
          } else {
            unavailable.set(operation.path, 'snapshot_undo_unavailable');
          }
          if (inverse) {
            undo.push(inverse);
            if (typeof operation.verifiedContent === 'string') inverseBases.set(inverse, operation.verifiedContent);
          }
        }
      } else if (operation.type === 'create') {
        if (!operation.path) {
          continue;
        }
        undo.push(normalizeUndoOperation({
          type: 'delete',
          path: operation.path,
          reason: 'Undo create'
        }));
      } else if (operation.type === 'rename') {
        if (!operation.path || !operation.to) {
          continue;
        }
        undo.push(normalizeUndoOperation({
          type: 'rename',
          path: operation.to,
          to: operation.path,
          reason: 'Undo rename'
        }));
      } else if (operation.type === 'move') {
        if (!operation.path || !operation.to) {
          continue;
        }
        if (operation.moveProof && !operation.moveProof.targetEntityId) continue;
        undo.push(normalizeUndoOperation({
          type: 'move',
          path: operation.to,
          to: operation.path,
          ...(operation.moveProof ? { moveProof: { ...operation.moveProof,
            sourceEntityId: operation.moveProof.targetEntityId, targetEntityId: operation.moveProof.sourceEntityId } } : {}),
          reason: 'Undo move'
        }));
      } else if (operation.type === 'delete') {
        if (!operation.path || !workingFilesByPath.has(operation.path)) {
          continue;
        }
        undo.push(normalizeUndoOperation({
          type: 'create',
          path: operation.path,
          content: workingFilesByPath.get(operation.path),
          reason: 'Undo delete'
        }));
      }

      applyOperationToFiles(workingFilesByPath, operation);
      applyOperationToFiles(sourceFilesByPath, { ...operation, verifiedContent: undefined });
    }

    // Each inverse was measured in its own verified post-image. Compose in
    // reverse order against the latest image, preserving changes between
    // entries. Empty inverse insertions must never reuse an older offset.
    const composed = [];
    for (const inverse of undo.reverse()) {
      let operation = inverse;
      if (mappedPaths.has(inverse.path) && inverseBases.has(inverse)) {
        const current = workingFilesByPath.get(inverse.path);
        const base = StaleGuard.buildBaseFileLookup([{ path: inverse.path, content: inverseBases.get(inverse) }]);
        const fresh = StaleGuard.checkOperationFreshness(inverse, current, base);
        const prepared = fresh.ok && inverse.patches
          ? fresh.preparedPatches || StaleGuard.prepareOperationPatches(inverse, current, base) : fresh;
        if (typeof current !== 'string' || !prepared.ok) {
          unavailable.set(inverse.path, 'stale_source_changed');
          continue;
        }
        if (inverse.patches) operation = { ...inverse, patches: prepared.patches };
      }
      composed.push(operation);
      applyOperationToFiles(workingFilesByPath, operation);
    }
    return { undoOperations: composed.filter(operation => !unavailable.has(operation.path)),
      undoUnavailable: [...unavailable].map(([path, code]) => ({ path, code })) };
  }

  // Invert the ranges actually dispatched to C, not the original Native
  // coordinates in B. Verify against the observed post-image before storing
  // recovery; invalid evidence must not fall back to overwriting C with B.
  function buildVerifiedInversePatches(patches, postImage) {
    const beforeLength = patches.reduce((length, patch) =>
      length + Number(patch?.to) - Number(patch?.from) - String(patch?.insert ?? '').length, postImage.length);
    if (!Number.isSafeInteger(beforeLength) || beforeLength < 0) return [];
    const normalized = normalizeTextPatches(patches, beforeLength);
    if (!normalized.ok || normalized.patches.some(patch => patch.expected.length !== patch.to - patch.from)) return [];
    const inverse = invertPatches(normalized.patches);
    return applyTextPatches(postImage, inverse).ok ? inverse : [];
  }

  function invertPatches(patches) {
    let offset = 0;
    return patches.map(patch => {
      const from = patch.from + offset;
      offset += patch.insert.length - (patch.to - patch.from);
      return { from, to: from + patch.insert.length, expected: patch.insert, insert: patch.expected };
    });
  }

  function buildInverseTextPatches(textBeforeEdit, patches, verifiedContent, path) {
    if (!Array.isArray(patches) || !patches.length) {
      return [];
    }
    const normalized = normalizeTextPatches(patches, String(textBeforeEdit || '').length);
    if (!normalized.ok) {
      return [];
    }
    const applied = applyTextPatches(textBeforeEdit, normalized.patches);
    if (!applied.ok) {
      return [];
    }

    const inverse = invertPatches(normalized.patches);
    if (typeof verifiedContent !== 'string' || verifiedContent === applied.text) return inverse;
    // The stored checkpoint uses the verified editor post-image. Its inverse
    // must use those same offsets, while Native patches retain their source
    // representation for later operations in the batch.
    const prepared = StaleGuard.prepareStoredInversePatches({ type: 'edit', path, patches: inverse }, verifiedContent,
      StaleGuard.buildBaseFileLookup([{ path, content: applied.text }]));
    return prepared.ok && applyTextPatches(verifiedContent, prepared.patches).ok ? prepared.patches : [];
  }

  function selectExpectedFilesForTrackedUndo(project, operations = [], trackedChanges = [], previousExpectedFiles = []) {
    const checkpoint = buildUndoCheckpoint(project, operations);
    const unavailable = new Set(checkpoint.undoUnavailable.map(item => item.path));
    const mappedPaths = new Set(operations.filter(operation => Array.isArray(operation?.appliedPatches)).map(operation => operation.path));
    const paths = new Set();
    for (const change of trackedChanges || []) if (change?.path) paths.add(change.path);
    for (const operation of operations || []) {
      if (operation?.path) paths.add(operation.path);
      if (operation?.to) paths.add(operation.to);
    }
    const expectedByPath = new Map();
    for (const file of previousExpectedFiles || []) {
      if (paths.has(file?.path) && !unavailable.has(file.path) && !mappedPaths.has(file.path)
        && typeof file?.content === 'string' && !expectedByPath.has(file.path)) {
        expectedByPath.set(file.path, { path: file.path, content: file.content });
      }
    }
    // Reconstruct the pre-image with the same inverse patches as plain Undo.
    // This preserves the editor's unchanged line endings and collaborator
    // content, including when the ZIP baseline used a different representation.
    const hasVerifiedPatches = operations.some(operation => typeof operation?.verifiedContent === 'string'
      && Array.isArray(operation.patches) && operation.patches.length);
    const restored = hasVerifiedPatches ? buildExpectedFilesAfterOperations({ files: checkpoint.undoBaseFiles }, checkpoint.undoOperations) : new Map();
    for (const file of project?.files || []) {
      if (paths.has(file?.path) && !unavailable.has(file.path) && typeof file?.content === 'string' && !expectedByPath.has(file.path)) {
        expectedByPath.set(file.path, { path: file.path, content: restored.get(file.path) ?? file.content });
      }
    }
    return Array.from(expectedByPath.values());
  }

  function buildUndoCheckpoint(project, appliedOperations) {
    const { undoOperations, undoUnavailable } = buildUndoPlan(project, appliedOperations);
    const unavailable = new Map(undoUnavailable.map(item => [item.path, item]));
    const expectedFiles = buildExpectedFilesAfterOperations(project, appliedOperations);
    return {
      undoOperations,
      undoBaseFiles: filesMapToList(selectUndoBaseFiles(expectedFiles, undoOperations)),
      undoUnavailable,
      appliedOperations: (appliedOperations || []).map(operation => unavailable.has(operation?.path)
        ? { ...operation, undoUnavailable: unavailable.get(operation.path) } : operation)
    };
  }

  // File creation has its own inverse even when text edits use Reviewing.
  // Store post-images, never infer an empty pre-image for a missing file.
  function buildCreatedFileUndoCheckpoint(project, appliedOperations, previous = {}) {
    const originalPaths = new Set((project?.files || []).map(file => file?.path));
    const priorFiles = filesListToMap(previous.undoBaseFiles);
    const created = new Map();
    for (const operation of previous.undoOperations || []) {
      const proof = operation?.undoCreatedFile;
      if (operation?.type !== 'delete' || proof?.v !== 1) continue;
      if (proof.kind === 'text' && priorFiles.has(operation.path)) {
        created.set(operation.path, { kind: 'text', content: priorFiles.get(operation.path), createdDirectories: proof.createdDirectories });
      } else if (proof.kind === 'binary' && /^[a-f0-9]{64}$/i.test(proof.sha256 || '')) {
        created.set(operation.path, { kind: 'binary', sha256: proof.sha256.toLowerCase(), createdDirectories: proof.createdDirectories });
      }
    }
    for (const operation of appliedOperations || []) {
      if (!operation?.path) continue;
      const path = operation.path;
      if (operation.type === 'create' || operation.type === 'binary-create') {
        if (originalPaths.has(path) && !created.has(path)) continue;
        if (operation.type === 'create' && typeof operation.content === 'string') {
          created.set(path, { kind: 'text', content: typeof operation.verifiedContent === 'string'
            ? operation.verifiedContent : operation.content, createdDirectories: operation.createdDirectories });
        } else {
          const hash = operation.sha256 || operation.assetRef?.sha256;
          if (operation.previousExists !== true && /^[a-f0-9]{64}$/i.test(hash || '')) {
            created.set(path, { kind: 'binary', sha256: hash.toLowerCase(), createdDirectories: operation.createdDirectories });
          }
        }
      } else if (operation.type === 'edit' && created.get(path)?.kind === 'text') {
        const files = new Map([[path, created.get(path).content]]);
        applyOperationToFiles(files, operation);
        created.set(path, { ...created.get(path), kind: 'text', content: files.get(path) });
      } else if (['delete', 'rename', 'move', 'overwrite-binary'].includes(operation.type)) {
        // Existing rename/overwrite recovery retains ownership of these cases.
        created.delete(path);
        if (operation.to) created.delete(operation.to);
      }
    }
    const undoBaseFiles = [], undoOperations = [];
    for (const [path, proof] of Array.from(created).reverse()) {
      const undoCreatedFile = proof.kind === 'binary'
        ? { v: 1, kind: 'binary', sha256: proof.sha256 } : { v: 1, kind: 'text' };
      if (Array.isArray(proof.createdDirectories) && proof.createdDirectories.length) {
        undoCreatedFile.createdDirectories = proof.createdDirectories.map(item => ({ ...item }));
      }
      undoOperations.push({ ...normalizeUndoOperation({ type: 'delete', path, reason: 'Undo create' }), undoCreatedFile });
      if (proof.kind === 'text') undoBaseFiles.push({ path, content: proof.content });
    }
    // Reviewing has no text insertion/deletion refs for a native metadata move.
    // Keep its identity-bound inverse with the other file-level proofs.
    undoOperations.push(...buildUndoOperations(project, appliedOperations).filter(operation => operation.type === 'move' && operation.moveProof));
    return { undoOperations, undoBaseFiles };
  }

  function isFileUndoOperation(operation) {
    return operation?.undoCreatedFile?.v === 1
      || (operation?.type === 'move' && operation.moveProof?.v === 1)
      || (operation?.type === 'create' && typeof operation.content === 'string');
  }

  // A deleted original has no editor post-image. Its inverse is a guarded
  // file creation, backed by both the forward delete and the captured original.
  // This also recovers older Track-on records that omitted that inverse.
  function getFileUndoOperations(run = {}) {
    run = withAvailableUndo(run);
    const operations = (run.undoOperations || []).filter(isFileUndoOperation);
    const before = filesListToMap(run.undoExpectedFiles);
    const after = buildExpectedFilesAfterOperations({ files: run.undoExpectedFiles }, run.appliedOperations);
    const deleted = new Set((run.appliedOperations || []).filter(operation => operation?.type === 'delete'
      && before.has(operation.path) && !after.has(operation.path)).map(operation => operation.path));
    return [...operations.filter(operation => !deleted.has(operation.path)), ...Array.from(deleted, path =>
      normalizeUndoOperation({ type: 'create', path, content: before.get(path), reason: 'Undo delete' }))];
  }

  function prepareRunUndo(run = {}) {
    const original = run;
    run = withAvailableUndo(run);
    const files = getFileUndoOperations(run);
    const restored = new Set(files.filter(operation => operation.type === 'create').map(operation => operation.path));
    const pending = [...files], operations = [];
    for (const operation of run.undoOperations || []) {
      if (isFileUndoOperation(operation)) {
        const index = pending.findIndex(file => file.path === operation.path && file.type === operation.type);
        if (index >= 0) operations.push(...pending.splice(index, 1));
      } else if (!restored.has(operation.path)) operations.push(operation);
    }
    return { ...original, undoOperations: [...operations, ...pending],
      ...(run !== original ? { undoBaseFiles: run.undoBaseFiles, undoExpectedFiles: run.undoExpectedFiles } : {}) };
  }

  function textUndoRun(run = {}) {
    run = withAvailableUndo(run);
    const restored = new Set(getFileUndoOperations(run).flatMap(operation => operation.type === 'create' ? [operation.path]
      : operation.type === 'move' ? [operation.path, operation.to] : []));
    return { ...run,
      undoExpectedFiles: (run.undoExpectedFiles || []).filter(file => !restored.has(file.path)),
      undoTrackedChanges: (run.undoTrackedChanges || []).filter(ref => !restored.has(ref.path))
    };
  }

  function mergeFileUndoResult(textResult, fileResult, operations) {
    const applied = [...(textResult.applied || []), ...(fileResult.applied || [])];
    const skipped = [...(textResult.skipped || []), ...(fileResult.skipped || [])];
    for (const operation of operations) {
      if (!(fileResult.applied || []).some(entry => entry.operation?.path === operation.path
        && entry.operation?.type === operation.type && entry.result?.ok === true && entry.result?.verified === true
        && entry.result.verification === 'overleaf-zip')
        && !(fileResult.skipped || []).some(entry => entry.operation?.path === operation.path)) {
        skipped.push({ operation, result: { ok: false, code: 'undo_operation_failed',
          reason: 'The file restoration has no verified server receipt.' } });
      }
    }
    return { ...textResult, ok: textResult.ok !== false && fileResult.ok !== false && !skipped.length, applied, skipped };
  }

  // Consume only independently verified rollback receipts. Forward writes
  // remain audit evidence; recovery arrays describe only unfinished work.
  function advanceUndoCheckpoint(run = {}, result = {}, verifyText = () => false) {
    const operations = Array.isArray(run?.undoOperations) ? run.undoOperations : [];
    const applied = Array.isArray(result.applied) ? result.applied : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const failed = path => skipped.some(entry => {
      const target = entry?.operation?.path || entry?.trackedChange?.path || entry?.result?.failure?.file;
      return !target || target === path;
    });
    if (result.failure || result.error) return run;
    const textPaths = new Set((run.undoExpectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string' && !failed(file.path)
        && typeof verifyText === 'function' && verifyText(file) === true)
      .map(file => file.path));
    const deletedPaths = new Set(operations.filter(operation => operation?.type === 'delete'
      && operation.undoCreatedFile?.v === 1 && !failed(operation.path)
      && applied.some(entry => entry?.operation?.type === 'delete' && entry.operation.path === operation.path
        && JSON.stringify(entry.operation.undoCreatedFile) === JSON.stringify(operation.undoCreatedFile)
        && entry.result?.ok === true && entry.result.verified === true
        && entry.result.verification === 'overleaf-zip')).map(operation => operation.path));
    const restoredPaths = new Set(operations.filter(operation => operation?.type === 'create'
      && !failed(operation.path) && applied.some(entry => entry?.operation?.type === 'create'
        && entry.operation.path === operation.path && entry.operation.content === operation.content
        && entry.result?.ok === true && entry.result.verified === true
        && entry.result.verification === 'overleaf-zip')).map(operation => operation.path));
    const movedPaths = new Set(operations.filter(operation => operation?.type === 'move' && operation.moveProof?.v === 1
      && !failed(operation.path) && applied.some(entry => entry?.operation?.type === 'move'
        && entry.operation.path === operation.path && entry.operation.to === operation.to
        && JSON.stringify(entry.operation.moveProof) === JSON.stringify(operation.moveProof)
        && entry.result?.ok === true && entry.result.verified === true && entry.result.verification === 'overleaf-zip'))
      .flatMap(operation => [operation.path, operation.to]));
    for (const path of restoredPaths) textPaths.add(path);
    for (const path of movedPaths) textPaths.add(path);
    if (!textPaths.size && !deletedPaths.size) return run;
    const pending = operations.filter(operation => !restoredPaths.has(operation.path) && !(operation?.type === 'edit' && textPaths.has(operation.path))
      && !(operation?.type === 'move' && movedPaths.has(operation.path))
      && !(operation?.type === 'delete' && operation.undoCreatedFile?.v === 1 && deletedPaths.has(operation.path)));
    const needed = new Set(pending.flatMap(operation => [operation?.path, operation?.to]).filter(Boolean));
    return { ...run,
      undoOperations: pending,
      undoBaseFiles: (run.undoBaseFiles || []).filter(file => needed.has(file?.path)
        || (!textPaths.has(file?.path) && !deletedPaths.has(file?.path))),
      undoExpectedFiles: (run.undoExpectedFiles || []).filter(file => !textPaths.has(file?.path)),
      undoTrackedChanges: (run.undoTrackedChanges || []).filter(ref => !textPaths.has(ref?.path)),
      trackedChangeCaptures: (run.trackedChangeCaptures || []).filter(capture => !textPaths.has(capture?.path))
    };
  }

  function buildSnapshotRestoreUndo(run = {}) {
    run = withAvailableUndo(run);
    const undoOperations = Array.isArray(run.undoOperations) ? run.undoOperations : [];
    const originalByPath = buildOriginalFilesForSnapshotUndo(run, undoOperations);
    if (!originalByPath.size) {
      return {
        operations: undoOperations,
        snapshotRestore: false
      };
    }

    const restoredEditPaths = new Set();
    const operations = [];
    let snapshotRestore = false;
    for (const operation of undoOperations) {
      if (operation?.type === 'edit' && operation.path && originalByPath.has(operation.path)) {
        if (restoredEditPaths.has(operation.path)) {
          continue;
        }
        restoredEditPaths.add(operation.path);
        snapshotRestore = true;
        operations.push(normalizeUndoOperation({
          type: 'edit',
          path: operation.path,
          replaceAll: originalByPath.get(operation.path),
          reason: 'Undo edit'
        }));
        continue;
      }
      operations.push(operation);
    }

    return {
      operations,
      snapshotRestore
    };
  }

  function buildOriginalFilesForSnapshotUndo(run, undoOperations) {
    const expectedFiles = filesListToMap(run.undoExpectedFiles);
    if (expectedFiles.size) {
      return expectedFiles;
    }

    const editPaths = new Set((undoOperations || [])
      .filter(operation => operation?.type === 'edit' && operation.path)
      .map(operation => operation.path));
    if (!editPaths.size) {
      return new Map();
    }

    const workingFiles = filesListToMap(run.undoBaseFiles);
    if (!workingFiles.size) {
      return new Map();
    }
    for (const operation of undoOperations || []) {
      applyOperationToFiles(workingFiles, operation);
    }

    const originalByPath = new Map();
    for (const path of editPaths) {
      const content = workingFiles.get(path);
      if (typeof content === 'string') {
        originalByPath.set(path, content);
      }
    }
    return originalByPath;
  }

  function buildExpectedFilesAfterOperations(project, appliedOperations) {
    const filesByPath = new Map();
    for (const file of project?.files || []) {
      if (typeof file?.path === 'string' && typeof file.content === 'string') {
        filesByPath.set(file.path, file.content);
      }
    }

    for (const operation of appliedOperations || []) {
      applyOperationToFiles(filesByPath, operation);
    }

    return filesByPath;
  }

  function applyOperationToFiles(filesByPath, operation) {
    if (!operation || typeof operation.type !== 'string' || !operation.path) {
      return;
    }

    if (operation.type === 'edit') {
      const current = filesByPath.get(operation.path);
      if (typeof current !== 'string') {
        return;
      }
      // The writeback already verified the editor content it produced. When
      // that authoritative post-write content is available, trust it instead
      // of re-deriving the result by re-applying patches: a wide patch's
      // `expected` spans a whole paragraph, so it silently fails to re-apply
      // against any base that drifted even slightly from the patch's base,
      // and the result would otherwise collapse to the un-patched content.
      if (typeof operation.verifiedContent === 'string') {
        filesByPath.set(operation.path, operation.verifiedContent);
      } else if (typeof operation.replaceAll === 'string') {
        filesByPath.set(operation.path, operation.replaceAll);
      } else if (Array.isArray(operation.patches) && operation.patches.length) {
        const patched = applyTextPatches(current, operation.patches);
        if (patched.ok) {
          filesByPath.set(operation.path, patched.text);
        }
      } else if (typeof operation.find === 'string' && typeof operation.replace === 'string') {
        filesByPath.set(operation.path, current.split(operation.find).join(operation.replace));
      }
    } else if (operation.type === 'create') {
      filesByPath.set(operation.path, operation.content || '');
    } else if (operation.type === 'rename' || operation.type === 'move') {
      if (!operation.to || !filesByPath.has(operation.path)) {
        return;
      }
      const content = filesByPath.get(operation.path);
      filesByPath.delete(operation.path);
      filesByPath.set(operation.to, content);
    } else if (operation.type === 'delete') {
      filesByPath.delete(operation.path);
    }
  }

  function filesMapToList(filesByPath) {
    return Array.from(filesByPath.entries()).map(([path, content]) => ({
      path,
      content
    }));
  }

  function filesListToMap(files) {
    const filesByPath = new Map();
    for (const file of files || []) {
      if (typeof file?.path === 'string' && typeof file.content === 'string') {
        filesByPath.set(file.path, file.content);
      }
    }
    return filesByPath;
  }

  function selectUndoBaseFiles(expectedFilesByPath, undoOperations) {
    const neededPaths = new Set();
    for (const operation of undoOperations || []) {
      if (!operation?.path) {
        continue;
      }
      if (operation.type === 'edit' || operation.type === 'delete' || operation.type === 'rename' || operation.type === 'move') {
        neededPaths.add(operation.path);
      }
    }

    const selected = new Map();
    for (const [path, content] of expectedFilesByPath.entries()) {
      if (neededPaths.has(path)) {
        selected.set(path, content);
      }
    }
    return selected;
  }

  function normalizeUndoOperation(operation) {
    const normalized = {
      type: operation.type,
      path: operation.path,
      to: operation.to ?? null,
      find: null,
      replace: null,
      replaceAll: operation.replaceAll ?? null,
      content: operation.content ?? null,
      reason: operation.reason || null
    };
    if (Array.isArray(operation.patches) && operation.patches.length) {
      normalized.patches = operation.patches.map(patch => ({
        from: patch.from,
        to: patch.to,
        expected: String(patch.expected ?? ''),
        insert: String(patch.insert ?? '')
      }));
    }
    if (operation.type === 'move' && operation.moveProof?.v === 1) normalized.moveProof = JSON.parse(JSON.stringify(operation.moveProof));
    return normalized;
  }

  function applyTextPatches(text, patches) {
    const normalized = normalizeTextPatches(patches, text.length);
    if (!normalized.ok) {
      return normalized;
    }

    let next = text;
    for (const patch of normalized.patches.slice().sort((left, right) => right.from - left.from)) {
      if (next.slice(patch.from, patch.to) !== patch.expected) {
        return {
          ok: false,
          reason: 'Patch expected text did not match'
        };
      }
      next = next.slice(0, patch.from) + patch.insert + next.slice(patch.to);
    }
    return {
      ok: true,
      text: next
    };
  }

  function normalizeTextPatches(patches, length) {
    const normalized = [];
    let previousTo = 0;
    for (const rawPatch of patches || []) {
      const from = Number(rawPatch?.from);
      const to = Number(rawPatch?.to);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
        return {
          ok: false,
          reason: 'Invalid patch range'
        };
      }
      if (from < previousTo) {
        return {
          ok: false,
          reason: 'Overlapping patch ranges'
        };
      }
      previousTo = to;
      normalized.push({
        from,
        to,
        expected: String(rawPatch.expected ?? ''),
        insert: String(rawPatch.insert ?? '')
      });
    }
    return {
      ok: true,
      patches: normalized
    };
  }

  return {
    getUndoUnavailableFiles,
    withAvailableUndo,
    compactUnavailableUndoOperations,
    isFileUndoOperation,
    getFileUndoOperations,
    prepareRunUndo,
    textUndoRun,
    mergeFileUndoResult,
    buildUndoCheckpoint,
    buildCreatedFileUndoCheckpoint,
    advanceUndoCheckpoint,
    buildExpectedFilesAfterOperations,
    buildUndoOperations,
    selectExpectedFilesForTrackedUndo,
    buildSnapshotRestoreUndo
  };
});
