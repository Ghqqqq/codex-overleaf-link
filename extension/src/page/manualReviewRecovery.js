(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../shared/manualReviewProof'));
  else root.CodexOverleafManualReviewRecovery = factory(root.CodexOverleafManualReviewProof);
})(typeof window !== 'undefined' ? window : globalThis, function (Proof) {
  'use strict';

  function create(deps = {}) {
    const crypto = deps.crypto || deps.window?.crypto || globalThis.crypto;
    const now = deps.now || Date.now;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    function fail(code, message) { throw Object.assign(new Error(message || code), { code }); }
    function assertScope(params, scope) {
      if (!scope.runProjectId || !scope.accountScopeId || params.runProjectId !== scope.runProjectId
        || params.accountScopeId !== scope.accountScopeId || deps.getProjectId?.() !== scope.runProjectId
        || (typeof deps.getAccountScopeId === 'function' && deps.getAccountScopeId() !== scope.accountScopeId))
        fail('manual_review_scope_changed');
      if (params.deadlineAt != null && (!Number.isFinite(params.deadlineAt) || now() >= params.deadlineAt))
        fail('manual_review_deadline_exceeded');
      const writeGuard = deps.checkWritebackRunProjectId?.(params);
      if (writeGuard) fail(writeGuard.code || 'manual_review_scope_changed');
      const guard = deps.assertCurrent?.(params);
      if (guard === false || (guard && guard !== true && guard.ok !== true))
        fail(guard?.code || 'manual_review_context_changed');
    }
    function postimages(params) {
      if (!Array.isArray(params.postFiles) || !params.postFiles.length || params.postFiles.length > 1000)
        fail('manual_review_postimage_unavailable');
      const files = new Map();
      for (const file of params.postFiles) {
        if (!Proof.safePath(file?.path) || typeof file.content !== 'string' || files.has(file.path))
          fail('manual_review_postimage_unavailable');
        files.set(file.path, file.content);
      }
      return files;
    }
    function snapshot(path, nativeDocId, text) {
      if (deps.getActiveFilePath?.() !== path || deps.readActiveEditorText?.() !== text)
        fail('manual_review_text_or_file_changed');
      const state = deps.prepareTrackedChangeCapture?.(path);
      if (state?.source !== 'native' || state.ready !== true || !state.nativeDocId
        || state.nativeDocId !== nativeDocId || !Array.isArray(state.refs)
        || state.refs.length > Proof.LIMITS.maxRefsPerFile) fail('manual_review_ledger_unavailable');
      const keys = [];
      for (const ref of state.refs) {
        const tuple = Proof.parseNativeKey(ref?.key);
        if (!tuple || ref.path !== path || ref.id !== tuple[0]) fail('manual_review_ledger_invalid');
        keys.push(ref.key);
      }
      if (new Set(keys).size !== keys.length) fail('manual_review_ledger_invalid');
      return keys.sort();
    }
    async function open(params, scope, path) {
      assertScope(params, scope);
      if (deps.getActiveFilePath?.() !== path) {
        const opened = await deps.openFileByPath?.(path);
        assertScope(params, scope);
        if (opened?.ok !== true) fail('manual_review_file_unavailable');
      }
      if (deps.getActiveFilePath?.() !== path) fail('manual_review_file_unavailable');
    }
    async function digest(text) {
      if (!crypto?.subtle?.digest) fail('manual_review_hash_unavailable');
      const Encoder = deps.window?.TextEncoder || globalThis.TextEncoder;
      const bytes = await crypto.subtle.digest('SHA-256', new Encoder().encode(text));
      return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    function rejected(path, code) {
      const messages = {
        manual_review_proof_unavailable: 'The saved manual-review proof is unavailable or invalid.',
        manual_review_scope_changed: 'The original project or account is no longer active.',
        manual_review_deadline_exceeded: 'The read-only review check reached its time limit.',
        manual_review_text_or_file_changed: 'The active file or its text no longer matches this run’s saved result.',
        manual_review_postimage_unavailable: 'This run’s original text checkpoint is unavailable.',
        manual_review_postimage_mismatch: 'The text checkpoint does not match the saved review proof.',
        manual_review_targets_remain: 'Some tracked changes from this run are still pending in Overleaf Review.',
        manual_review_unrelated_changes_changed: 'Other tracked changes differ from the saved review proof.',
        manual_review_ledger_changed: 'Tracked changes changed while the review check was running.',
        manual_review_file_unavailable: 'The original file could not be opened for the review check.',
        manual_review_ledger_unavailable: 'The original document’s complete tracked-change ledger is unavailable.'
      };
      const reason = (messages[code] || 'Manual review could not be verified.') + ' No review mutation was attempted; recovery evidence is retained.';
      return { ok: false, verified: false, changedDocument: false, code, applied: [], skipped: [{
        trackedChange: { path }, result: { ok: false, code, reason, changedDocument: false, failure: {
          code: 'tracked_changes_remain', stage: 'reviewing', severity: 'blocked', terminalState: 'blocked',
          file: path, operationType: 'review', changedDocument: false, userMessage: reason,
          nextAction: 'Inspect the original run’s file and its Overleaf Review entries, then check again. Recovery evidence is retained.',
          evidence: { originalCode: code, writeStarted: false }
        } }
      }] };
    }

    async function build(params = {}, plan) {
      try {
        const scope = { runProjectId: params.runProjectId, accountScopeId: params.accountScopeId };
        assertScope(params, scope);
        if (plan?.ok !== true || !Array.isArray(plan.files) || !plan.files.length || plan.files.length > Proof.LIMITS.maxFiles) return null;
        const post = postimages(params), paths = new Set(), inputs = [];
        // Validate and detach all plan data before any navigation or hashing.
        for (const file of plan.files) {
          if (!Proof.safePath(file?.path) || paths.has(file.path) || !post.has(file.path)
            || file.scope?.ok !== true || file.scope.merged || !Array.isArray(file.scope.targets)
            || !file.scope.targets.length || file.scope.targets.length > Proof.LIMITS.maxRefsPerFile) return null;
          paths.add(file.path);
          const targetKeys = [];
          for (const ref of file.scope.targets) {
            const tuple = Proof.parseNativeKey(ref?.key);
            if (!tuple || ref.path !== file.path || ref.id !== tuple[0]) return null;
            targetKeys.push(ref.key);
          }
          if (new Set(targetKeys).size !== targetKeys.length) return null;
          inputs.push({ path: file.path, nativeDocId: file.nativeDocId, targetKeys: targetKeys.sort() });
        }
        const files = [];
        for (const file of inputs) {
          await open(params, scope, file.path);
          assertScope(params, scope);
          const text = post.get(file.path), keys = snapshot(file.path, file.nativeDocId, text);
          if (file.targetKeys.some(key => !keys.includes(key))) return null;
          const postHash = await digest(text);
          assertScope(params, scope);
          if (!same(snapshot(file.path, file.nativeDocId, text), keys)) return null;
          const targets = new Set(file.targetKeys);
          files.push({ ...file, postHash, preservedKeys: keys.filter(key => !targets.has(key)) });
        }
        assertScope(params, scope);
        return Proof.normalize({ v: 1, id: crypto?.randomUUID?.(), ...scope, files });
      } catch (_error) { return null; }
    }

    async function verify(params = {}) {
      let path = '';
      try {
        const proof = Proof.normalize(params.manualReviewProof);
        if (!proof) return rejected(path, 'manual_review_proof_unavailable');
        assertScope(params, proof);
        const post = postimages(params), applied = [];
        for (const file of proof.files) {
          path = file.path;
          if (!post.has(path)) fail('manual_review_postimage_unavailable');
          await open(params, proof, path);
          assertScope(params, proof);
          const text = post.get(path), before = snapshot(path, file.nativeDocId, text);
          const postHash = await digest(text);
          assertScope(params, proof);
          const keys = snapshot(path, file.nativeDocId, text);
          if (postHash !== file.postHash) fail('manual_review_postimage_mismatch');
          if (!same(keys, before)) fail('manual_review_ledger_changed');
          if (file.targetKeys.some(key => keys.includes(key))) fail('manual_review_targets_remain');
          if (!same(keys, file.preservedKeys)) fail('manual_review_unrelated_changes_changed');
          applied.push(...file.targetKeys.map(key => ({ trackedChange: { path, key, id: Proof.parseNativeKey(key)[0] },
            result: { ok: true, verified: true, changedDocument: false, verifiedContent: text,
              method: 'overleaf-manual-review-verified', preservedTrackedChanges: true } })));
        }
        assertScope(params, proof);
        return { ok: true, verified: true, changedDocument: false, proofId: proof.id, applied, skipped: [] };
      } catch (error) { return rejected(path, error?.code || 'manual_review_unavailable'); }
    }

    return Object.freeze({ build, verify });
  }
  return Object.freeze({ create });
});
