(function initCodexOverleafSaveState(root) {
  'use strict';

  function create(deps = {}) {
    const {
      delay,
      detectEditor,
      document,
      getActiveFilePath,
      readActiveEditorText
    } = deps;
    const pageWindow = deps.window || root;

    async function waitForSaveState(params = {}) {
      const deadlineMs = Number.isFinite(Number(params.deadlineMs)) ? Number(params.deadlineMs) : 5000;
      const pollInterval = Number.isFinite(Number(params.pollIntervalMs)) ? Number(params.pollIntervalMs) : 100;
      const quietFallbackMs = Number.isFinite(Number(params.quietFallbackMs)) ? Number(params.quietFallbackMs) : 1000;
      const deadline = Date.now() + Math.max(0, deadlineMs);
      let lastState = { state: 'unknown', reason: 'Overleaf save state has not been checked yet.' };
      let quietSignature = '';
      let quietSince = 0;

      do {
        let current;
        try {
          current = getOverleafSaveState();
        } catch (error) {
          return {
            ok: false,
            state: 'unavailable',
            reason: `Could not check Overleaf save state: ${error.message}`
          };
        }
        if (current.state === 'verified_saved') {
          return { ok: true, state: 'verified_saved', signal: 'saved' };
        }
        if (current.state === 'unavailable') {
          return {
            ok: false,
            state: 'unavailable',
            signal: current.signal || 'unavailable',
            reason: current.reason || 'Overleaf save state is unavailable.'
          };
        }
        const quietEligible = params.allowQuietEditorFallback === true
          && current.state === 'unknown'
          && /save indicator was not found/i.test(current.reason || '')
          && pageWindow.navigator?.onLine !== false
          && detectEditor()?.ok === true;
        if (quietEligible) {
          const text = String(readActiveEditorText() || '');
          const signature = `${getActiveFilePath()}:${text.length}:${text.slice(0, 80)}:${text.slice(-80)}`;
          if (signature === quietSignature && Date.now() - quietSince >= Math.max(0, quietFallbackMs)) {
            return { ok: true, state: 'verified_quiet', evidence: 'stable_editor_snapshot_without_save_indicator' };
          }
          if (signature !== quietSignature) {
            quietSignature = signature;
            quietSince = Date.now();
          }
        } else {
          quietSignature = '';
          quietSince = 0;
        }
        lastState = current;
        if (Date.now() >= deadline) {
          break;
        }
        await delay(Math.min(Math.max(1, pollInterval), Math.max(1, deadline - Date.now())));
      } while (Date.now() < deadline);

      return {
        ok: false,
        state: 'unknown_timeout',
        signal: lastState.signal || 'unavailable',
        observedState: lastState.state,
        reason: buildSaveStateTimeoutReason(lastState)
      };
    }

    function getOverleafSaveState() {
      if (pageWindow.navigator?.onLine === false) {
        return { state: 'unknown', signal: 'offline', reason: 'Overleaf is offline; saving cannot be confirmed.' };
      }
      if (!document || typeof document.querySelectorAll !== 'function') {
        return {
          state: 'unavailable',
          reason: 'Overleaf document is unavailable for save-state detection.'
        };
      }
      const selectors = [
        '.toolbar-header [class*="save" i]',
        '[class*="saving-status" i]',
        '[class*="save-status" i]',
        '[data-testid*="save" i]',
        '[aria-label*="save" i]',
        '[title*="saved" i]',
        '[role="status"]'
      ];
      let sawSaveCandidate = false;
      let sawVerifiedSaved = false;
      let sawNegativeState = false;
      let sawSavingState = false;
      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          if (isHiddenSaveIndicatorNode(el)) {
            continue;
          }
          const texts = readSaveIndicatorTexts(el);
          if (!texts.length) {
            continue;
          }
          const combinedText = texts.join(' ');
          if (isAnySaveIndicatorText(texts, combinedText, isNegativeSaveStateText)) {
            sawNegativeState = true;
            sawSaveCandidate = true;
            continue;
          }
          if (isAnySaveIndicatorText(texts, combinedText, isSavingStateText)) {
            sawSavingState = true;
            sawSaveCandidate = true;
            continue;
          }
          if (texts.some(isVerifiedSavedText)) {
            sawVerifiedSaved = true;
            continue;
          }
          if (isAnySaveIndicatorText(texts, combinedText, isSaveIndicatorCandidateText)) {
            sawSaveCandidate = true;
          }
        }
      }
      if (sawNegativeState) {
        return {
          state: 'unknown',
          signal: 'unsaved',
          reason: 'Overleaf save indicator reports changes are not saved.'
        };
      }
      if (sawSavingState) {
        return {
          state: 'saving',
          signal: 'saving',
          reason: 'Overleaf is still saving or syncing changes.'
        };
      }
      if (sawVerifiedSaved) {
        return { state: 'verified_saved' };
      }
      return {
        state: 'unknown',
        signal: sawSaveCandidate ? 'unrecognized' : 'missing',
        reason: sawSaveCandidate
          ? 'Overleaf save indicator was present, but did not verify that all changes are saved.'
          : 'Overleaf save indicator was not found.'
      };
    }

    function isHiddenSaveIndicatorNode(node) {
      if (!node) {
        return true;
      }
      if (node.closest?.('#codex-overleaf-panel')) return true;
      if (node.hidden === true || node.inert === true) {
        return true;
      }
      if (hasSaveIndicatorAttribute(node, 'hidden') || hasSaveIndicatorAttribute(node, 'inert')) {
        return true;
      }
      if (/^true$/i.test(String(node.getAttribute?.('aria-hidden') || ''))) {
        return true;
      }
      if (hasHiddenSaveIndicatorAncestor(node)) {
        return true;
      }
      if (isHiddenStyle(node.style)) {
        return true;
      }
      if (isHiddenStyle(getComputedStyleForSaveIndicator(node))) {
        return true;
      }
      return hasZeroSaveIndicatorLayout(node);
    }

    function hasHiddenSaveIndicatorAncestor(node) {
      if (typeof node.closest === 'function') {
        try {
          if (node.closest('[hidden],[inert],[aria-hidden="true"]')) {
            return true;
          }
        } catch (_error) {
          // Fall back to walking parentElement below.
        }
      }
      let current = node.parentElement;
      while (current) {
        if (current.hidden === true || current.inert === true) {
          return true;
        }
        if (hasSaveIndicatorAttribute(current, 'hidden') || hasSaveIndicatorAttribute(current, 'inert')) {
          return true;
        }
        if (/^true$/i.test(String(current.getAttribute?.('aria-hidden') || ''))) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    }

    function hasSaveIndicatorAttribute(node, attribute) {
      if (typeof node.hasAttribute === 'function') {
        try {
          return node.hasAttribute(attribute);
        } catch (_error) {
          return false;
        }
      }
      const value = node.getAttribute?.(attribute);
      return value != null && value !== '';
    }

    function isHiddenStyle(style) {
      if (!style) {
        return false;
      }
      return /^none$/i.test(String(style.display || ''))
        || /^(hidden|collapse)$/i.test(String(style.visibility || ''));
    }

    function getComputedStyleForSaveIndicator(node) {
      try {
        const ownerWindow = node.ownerDocument?.defaultView || null;
        return (ownerWindow || pageWindow)?.getComputedStyle?.(node) || null;
      } catch (_error) {
        return null;
      }
    }

    function hasZeroSaveIndicatorLayout(node) {
      if (typeof node.getClientRects !== 'function') {
        return false;
      }
      try {
        const rects = node.getClientRects();
        if (rects && rects.length > 0) {
          return false;
        }
        return node.offsetWidth === 0 && node.offsetHeight === 0;
      } catch (_error) {
        return false;
      }
    }

    function readSaveIndicatorTexts(node) {
      const parts = [
        node.textContent,
        node.innerText,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('value')
      ].map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return Array.from(new Set(parts));
    }

    function isAnySaveIndicatorText(texts, combinedText, predicate) {
      return predicate(combinedText) || texts.some(predicate);
    }

    function isNegativeSaveStateText(text) {
      return /\bnot\b[\s\S]{0,40}\bsaved\b|\b(?:unsaved|save failed|failed to save|could not save|unable to save)\b|未保存|保存失败/i.test(text);
    }

    function isSavingStateText(text) {
      return /\b(saving|syncing|compiling)\b|保存中|正在保存|同步中/i.test(text);
    }

    function isVerifiedSavedText(text) {
      if (isNegativeSaveStateText(text)) {
        return false;
      }
      return /^\s*(?:all changes saved|changes saved|saved)[\s.!]*$/i.test(text)
        || /已保存/i.test(text);
    }

    function isSaveIndicatorCandidateText(text) {
      return /\bsave\b|\bsaved\b|\bsaving\b|保存/i.test(text);
    }

    function buildSaveStateTimeoutReason(lastState = {}) {
      if (lastState.state === 'saving') {
        return `Timed out waiting for Overleaf to finish saving changes. ${lastState.reason || ''}`.trim();
      }
      return `Timed out waiting for a verified Overleaf save state. ${lastState.reason || ''}`.trim();
    }

    return {
      getOverleafSaveState,
      waitForSaveState
    };
  }

  async function confirmReviewWriteback({ params, result, readSnapshot, getProjectId, delay,
    now = Date.now, timeoutMs = 45000 }) {
    if (result?.ok !== true || result.skipped?.length) return result;
    const expected = new Map((params.expectedFiles || [])
      .filter(file => file?.path && typeof file.content === 'string').map(file => [file.path, file.content]));
    for (const entry of result.applied || []) {
      const path = entry.trackedChange?.path || entry.operation?.path;
      if (expected.has(path) && typeof entry.result?.verifiedContent === 'string') {
        expected.set(path, entry.result.verifiedContent);
      }
    }
    const deadline = now() + Math.max(0, timeoutMs);
    let attempts = 0;
    if (expected.size && typeof readSnapshot === 'function') {
      do {
        if (!params.runProjectId || getProjectId() !== params.runProjectId) break;
        try {
          const snapshot = await readSnapshot({ force: true, maxAgeMs: 0,
            zipTimeoutMs: Math.max(1, Math.min(8000, deadline - now())) });
          attempts++;
          if (getProjectId() !== params.runProjectId) break;
          if (snapshot?.ok === true && Array.from(expected).every(([path, content]) =>
            snapshot.files?.some(file => file.path === path && file.source === 'overleaf-zip'
              && file.content === content))) {
            return { ...result, saveVerification: { ok: true, state: 'verified_saved',
              source: 'overleaf-zip', attempts } };
          }
        } catch (_error) { /* A transient download failure grants no save proof. */ }
        if (now() >= deadline) break;
        await delay(Math.min(300, deadline - now()));
      } while (now() < deadline);
    }
    const reason = 'Undo changed the editor, but its saved server content could not be confirmed. Keep this page open and check Overleaf before retrying.';
    return { ...result, ok: false, saveVerification: { ok: false, state: 'unknown_timeout', attempts },
      skipped: [...(result.skipped || []), { trackedChange: { path: expected.keys().next().value || '' },
        result: { ok: false, code: 'undo_not_verified', reason, failure: {
          code: 'undo_not_verified', stage: 'verification', severity: 'needs_review',
          terminalState: 'needs_review', changedDocument: true, retryable: true, userMessage: reason
        } } }] };
  }

  const api = { create, confirmReviewWriteback };
  root.CodexOverleafSaveState = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
