(function initCodexOverleafAssetTransferBroker(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexOverleafAssetTransferBroker = api;
})(typeof window !== 'undefined' ? window : globalThis, function assetTransferBrokerFactory() {
  'use strict';

  const BINARY_TYPES = new Set(['binary-create', 'overwrite-binary']);

  function create(deps = {}) {
    const { callPageBridge, sendBackgroundNative } = deps;

    async function applyOperations(input = {}) {
      const results = [];
      let textBatch = [];
      async function flushTextBatch() {
        if (!textBatch.length) return;
        results.push(await callPageBridge('applyOperations', {
          operations: textBatch,
          baseFiles: input.baseFiles || [],
          requireReviewing: input.requireReviewing === true,
          requireEditing: input.requireEditing === true,
          runProjectId: input.runProjectId || ''
        }));
        textBatch = [];
      }
      for (const operation of Array.isArray(input.operations) ? input.operations : []) {
        if (!BINARY_TYPES.has(operation?.type)) {
          textBatch.push(operation);
          continue;
        }
        await flushTextBatch();
        results.push(await applyBinaryOperation(operation, input));
      }
      await flushTextBatch();
      return mergeApplyResults(results);
    }

    async function applyBinaryOperation(operation, input) {
      const transferId = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const assetRef = operation.assetRef || null;
      const safeOperation = sanitizeOperation(operation);
      let pageBegun = false;
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
        const committed = await callPageBridge('binaryUploadCommit', {
          transferId,
          runProjectId: input.runProjectId || ''
        });
        if (!committed?.ok) throw responseError(committed, committed?.code || 'binary_upload_failed');
        return { ok: true, applied: [{ operation: safeOperation, result: committed }], skipped: [] };
      } catch (error) {
        if (pageBegun) {
          await callPageBridge('binaryUploadAbort', { transferId, runProjectId: input.runProjectId || '' }).catch(() => null);
        }
        const code = error.code || 'binary_upload_failed';
        return {
          ok: false,
          applied: [],
          skipped: [{
            operation: safeOperation,
            path: operation.path,
            result: {
              ok: false,
              code,
              reason: error.message || 'Binary asset upload failed.',
              changedDocument: false,
              failure: { code, stage: 'write', file: operation.path, changedDocument: false }
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
      if (result?.ok !== true) merged.ok = false;
    }
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
    return codedError(
      response?.code || response?.error?.code || fallbackCode,
      response?.reason || response?.error?.message || response?.error || 'Asset transfer failed.'
    );
  }
  function codedError(code, message) { const error = new Error(String(message || code)); error.code = code; return error; }
  return { create, mergeApplyResults };
});
