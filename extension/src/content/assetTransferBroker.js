(function initCodexOverleafAssetTransferBroker(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafAssetTransferBroker = api;
})(typeof window !== 'undefined' ? window : globalThis, function assetTransferBrokerFactory() {
  'use strict';

  const BINARY_TYPES = new Set(['binary-create', 'overwrite-binary']);

  function create(deps = {}) {
    const { callPageBridge, sendBackgroundNative } = deps;
    const now = deps.now || Date.now;
    const delay = deps.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    async function applyOperations(input = {}) {
      const results = [];
      let textBatch = [], blocked = false;
      async function flushTextBatch() {
        if (!textBatch.length) return;
        const operations = textBatch;
        textBatch = [];
        const response = await callPageBridge('applyOperations', {
          operations,
          baseFiles: input.baseFiles || [],
          requireReviewing: input.requireReviewing === true,
          requireEditing: input.requireEditing === true,
          retryCreates: input.retryCreates === true,
          runProjectId: input.runProjectId || ''
        });
        const recovered = response?.code === 'page_bridge_timeout' && response.requestId
          ? await recoverTextReceipt(response, operations, input.runProjectId || '')
          : response;
        const result = normalizeTextResult(recovered, operations);
        results.push(result);
        blocked = result.receiptUnconfirmed === true;
      }
      for (const operation of Array.isArray(input.operations) ? input.operations : []) {
        if (blocked) {
          results.push(normalizeTextResult({ ok: false, code: 'writeback_tail_not_started',
            error: 'An earlier writeback is unconfirmed. This operation was not dispatched.',
            changedDocument: false }, [operation]));
          continue;
        }
        if (!BINARY_TYPES.has(operation?.type)) {
          textBatch.push(operation);
          continue;
        }
        await flushTextBatch();
        if (blocked) {
          results.push(normalizeTextResult({ ok: false, code: 'writeback_tail_not_started',
            error: 'An earlier writeback is unconfirmed. This operation was not dispatched.',
            changedDocument: false }, [operation]));
          continue;
        }
        const binaryResult = await applyBinaryOperation(operation, input);
        results.push(binaryResult);
        blocked = binaryResult.receiptUnconfirmed === true;
      }
      await flushTextBatch();
      return mergeApplyResults(results);
    }

    async function recoverTextReceipt(timeout, operations, runProjectId) {
      const budget = Number.isFinite(deps.receiptTimeoutMs) ? Math.max(0, deps.receiptTimeoutMs)
        : Math.min(600000, Math.max(90000, operations.length * 60000));
      const deadline = now() + budget;
      let partial = {}, state = 'unavailable', recoveryError = '';
      do {
        let receipt;
        try {
          receipt = await callPageBridge('getWritebackReceipt', { requestId: timeout.requestId, runProjectId });
        } catch (error) {
          if (error?.code === 'codex_cancelled') throw error;
          recoveryError = error?.message || String(error);
          break;
        }
        if (!receipt?.ok || receipt.requestId !== timeout.requestId || receipt.runProjectId !== runProjectId) {
          recoveryError = receipt?.error || 'Writeback receipt identity could not be confirmed.';
          break;
        }
        state = receipt.state;
        partial = receipt.result || {};
        if (state === 'completed') return { ...partial,
          receiptRecovery: { requestId: timeout.requestId, recovered: true, initialError: timeout.error } };
        if (state !== 'running') break;
        if (now() >= deadline) break;
        await delay(Math.min(deps.receiptPollMs || 500, Math.max(1, deadline - now())));
      } while (now() <= deadline);
      return { ...partial, ok: false, code: timeout.code, error: timeout.error,
        requestId: timeout.requestId, receiptUnconfirmed: true, receiptState: state, recoveryError };
    }

    async function applyBinaryOperation(operation, input) {
      const transferId = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const assetRef = operation.assetRef || null;
      const safeOperation = sanitizeOperation(operation);
      let pageBegun = false, commitAttempted = false;
      try {
        const begin = await callPageBridge('binaryUploadBegin', {
          transferId,
          path: operation.path,
          size: Number(operation.size || assetRef?.size || 0),
          sha256: assetRef?.sha256 || operation.sha256 || '',
          mimeType: assetRef?.mimeType || operation.mimeType || 'application/octet-stream',
          overwrite: operation.type === 'overwrite-binary',
          runProjectId: input.runProjectId || ''
        });
        if (!begin?.ok) throw responseError(begin, 'binary_upload_begin_failed');
        pageBegun = true;
        if (assetRef?.token) {
          await streamNativeAsset(assetRef, transferId, input.runProjectId || '');
        } else if (typeof operation.contentBase64 === 'string' && operation.contentBase64) {
          const append = await callPageBridge('binaryUploadAppend', {
            transferId,
            offset: 0,
            contentBase64: operation.contentBase64,
            runProjectId: input.runProjectId || ''
          });
          if (!append?.ok) throw responseError(append, 'binary_upload_chunk_failed');
        } else {
          throw codedError('binary_asset_payload_missing', 'Binary asset payload is unavailable.');
        }
        commitAttempted = true;
        const committed = await callPageBridge('binaryUploadCommit', {
          transferId,
          runProjectId: input.runProjectId || ''
        });
        if (!committed?.ok) throw responseError(committed, committed?.code || 'binary_upload_failed');
        return { ok: true, applied: [{ operation: safeOperation, result: committed }], skipped: [] };
      } catch (error) {
        let changedDocument = error?.changedDocument === true
          || (commitAttempted && error?.changedDocument !== false);
        if (commitAttempted && changedDocument) {
          const deadline = now() + 30000;
          do {
            const receipt = await callPageBridge('binaryUploadStatus', {
              transferId, runProjectId: input.runProjectId || ''
            }).catch(() => null);
            if (!receipt?.ok || receipt.transferId !== transferId
              || receipt.runProjectId !== input.runProjectId) break;
            if (receipt.result?.ok === true) {
              return { ok: true, applied: [{ operation: safeOperation, result: receipt.result }], skipped: [],
                receiptRecovery: { transferId, recovered: true, initialError: error.message } };
            }
            if (receipt.state === 'completed' && receipt.changedDocument === false) {
              changedDocument = false;
              break;
            }
            if (now() >= deadline) break;
            await delay(Math.min(500, Math.max(1, deadline - now())));
          } while (now() <= deadline);
        }
        if (pageBegun && !commitAttempted) {
          await callPageBridge('binaryUploadAbort', { transferId, runProjectId: input.runProjectId || '' }).catch(() => null);
        }
        const code = error.code || 'binary_upload_failed';
        return {
          ok: false,
          receiptUnconfirmed: changedDocument,
          error: error.message || 'Binary asset upload failed.',
          code,
          applied: [],
          skipped: [{
            operation: safeOperation,
            path: operation.path,
            result: {
              ok: false,
              code,
              reason: error.message || 'Binary asset upload failed.',
              changedDocument,
              failure: { code, stage: 'write', file: operation.path, changedDocument }
            }
          }]
        };
      } finally {
        if (assetRef?.token) {
          await sendBackgroundNative({ method: 'asset.release', params: { token: assetRef.token } }).catch(() => null);
        }
      }
    }

    async function streamNativeAsset(assetRef, transferId, runProjectId) {
      let offset = 0;
      while (offset < Number(assetRef.size || 0)) {
        const response = await sendBackgroundNative({
          method: 'asset.readChunk',
          params: { token: assetRef.token, offset, length: assetRef.chunkSize || 196608 }
        });
        if (!response?.ok) throw responseError(response, response?.error?.code || 'asset_chunk_read_failed');
        const chunk = response.result || {};
        if (chunk.offset !== offset || typeof chunk.contentBase64 !== 'string' || chunk.nextOffset <= offset) {
          throw codedError('asset_chunk_sequence_invalid', 'Native asset chunks arrived out of sequence.');
        }
        const appended = await callPageBridge('binaryUploadAppend', {
          transferId,
          offset,
          contentBase64: chunk.contentBase64,
          runProjectId
        });
        if (!appended?.ok) throw responseError(appended, appended?.code || 'binary_upload_chunk_failed');
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      if (offset !== Number(assetRef.size || 0)) {
        throw codedError('asset_transfer_incomplete', 'Native asset transfer ended before the expected size.');
      }
    }

    return { applyOperations };
  }

  function normalizeTextResult(response, operations) {
    const result = response && typeof response === 'object' ? { ...response } : { ok: false };
    result.applied = Array.isArray(result.applied) ? result.applied : [];
    result.skipped = Array.isArray(result.skipped) ? result.skipped.slice() : [];
    const key = operation => [operation?.type, operation?.path, operation?.to || ''].join('\0');
    const known = new Map();
    for (const entry of [...result.applied, ...result.skipped]) {
      const id = key(entry.operation); known.set(id, (known.get(id) || 0) + 1);
    }
    const missing = [];
    for (const operation of operations) {
      const id = key(operation), count = known.get(id) || 0;
      if (count) known.set(id, count - 1); else missing.push(operation);
    }
    if (!missing.length && (result.ok !== false || result.skipped.length)) return result;
    const code = result.code || 'writeback_result_unconfirmed';
    const error = typeof result.error === 'string' ? result.error
      : result.error?.message || 'The page did not return a complete writeback result.';
    const changedDocument = result.changedDocument !== false;
    for (const operation of missing.length ? missing : [null]) {
      const reason = changedDocument
        ? 'Write status is unconfirmed; Overleaf may already contain changes. Check the project before retrying. ' + error
        : error;
      result.skipped.push({ operation, path: operation?.path || '', result: {
        ok: false, code, reason, changedDocument, failure: {
          code, stage: 'write', severity: 'warning', terminalState: 'needs_review', retryable: false,
          file: operation?.path || '', userMessage: reason,
          nextAction: 'Check the current Overleaf files and original writeback result before starting another write.',
          changedDocument, evidence: { requestId: result.requestId || '', receiptState: result.receiptState || '',
            transportError: error, recoveryError: result.recoveryError || '' }
        }
      } });
    }
    return { ...result, ok: false, code, error, receiptUnconfirmed: true };
  }

  function mergeApplyResults(results) {
    const merged = { ok: true, applied: [], skipped: [], trackedChanges: [] };
    for (const result of results) {
      merged.applied.push(...(Array.isArray(result?.applied) ? result.applied : []));
      merged.skipped.push(...(Array.isArray(result?.skipped) ? result.skipped : []));
      // Text writeback returns the Reviewing references captured by the page
      // bridge. They are lifecycle data, not diagnostics: dropping them makes
      // recordUndoFromApply classify a successful Track write as legacy Undo,
      // which hides Accept and prevents the lifecycle from surviving reload.
      merged.trackedChanges.push(...(Array.isArray(result?.trackedChanges) ? result.trackedChanges : []));
      if (result?.trackedChangeCaptures?.length) (merged.trackedChangeCaptures ||= []).push(...result.trackedChangeCaptures);
      if (result?.ok !== true) {
        merged.ok = false;
        for (const key of ['code', 'error', 'failure', 'requestId', 'receiptState', 'recoveryError', 'receiptUnconfirmed']) {
          if (result?.[key] !== undefined && merged[key] === undefined) merged[key] = result[key];
        }
      }
      if (result?.receiptRecovery) (merged.receiptRecoveries ||= []).push(result.receiptRecovery);
    }
    if (merged.trackedChangeCaptures?.some(capture => capture.state !== 'observed')) merged.trackedChanges = [];
    if (merged.skipped.length) merged.ok = false;
    return merged;
  }

  function sanitizeOperation(operation) {
    const { contentBase64, assetRef, ...safe } = operation || {};
    if (assetRef) {
      safe.asset = {
        path: assetRef.path || safe.path,
        size: assetRef.size,
        sha256: assetRef.sha256,
        mimeType: assetRef.mimeType
      };
    }
    return safe;
  }

  function responseError(response, fallbackCode) {
    const error = codedError(
      response?.code || response?.error?.code || fallbackCode,
      response?.reason || response?.error?.message || response?.error || 'Asset transfer failed.'
    );
    if (typeof response?.changedDocument === 'boolean') error.changedDocument = response.changedDocument;
    error.stage = response?.failure?.stage || 'write';
    return error;
  }
  function codedError(code, message) { const error = new Error(String(message || code)); error.code = code; return error; }
  return { create, mergeApplyResults };
});
