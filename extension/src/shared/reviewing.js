(function initReviewing(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafReviewing = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function reviewingFactory() {
  'use strict';

  const CONTROL_REVIEW_PATTERNS = [
    /\breviewing\b/i,
    /\btrack(?:ed)? changes?\s*(?:on|enabled)\b/i,
    /\bsuggest(?:ing|ions?)\s*(?:on|enabled)\b/i
  ];

  const INTERNAL_ACTIVE_REVIEW_PATTERNS = [
    /\b(?:mode|editingMode|reviewMode)\s*:\s*(?:reviewing|suggesting|track(?:ed)? changes?)\b/i
  ];

  const GENERIC_REVIEW_PATTERNS = [
    /\breview panel\b/i,
    /^\s*review\s*$/i
  ];

  function detectReviewingFromSignals(signals = {}) {
    if (signals.manualOverride === true) {
      return {
        ok: true,
        status: 'manual-override',
        source: 'user-confirmed'
      };
    }

    for (const control of signals.controls || []) {
      const controlText = normalize([
        control.text,
        control.innerText,
        control.ariaLabel,
        control.title,
        control.value,
        control.role,
        control.id,
        control.className,
        control.dataTestId,
        control.dataQa,
        control.dataOlName,
        control.ariaSelected,
        control.ariaCurrent,
        control.htmlSnippet,
        control.ariaPressed === 'true' ? 'pressed' : ''
      ].filter(Boolean).join(' '));

      if (matchesControlReview(controlText) && !isGenericReviewOnly(controlText)) {
        return {
          ok: true,
          status: 'detected',
          source: 'control-text'
        };
      }
    }

    for (const stateText of signals.internalStates || []) {
      const normalized = normalize(stateText);
      if (matchesInternalActiveReview(normalized)) {
        return {
          ok: true,
          status: 'detected',
          source: 'internal-state'
        };
      }
    }

    return {
      ok: false,
      status: 'not-detected',
      source: 'none'
    };
  }

  const UNAVAILABLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Keep all upgrade-dialog selectors here: Overleaf DOM acceptance may recalibrate them.
  const UPGRADE_MODAL_SELECTORS = Object.freeze({
    body: '.upgrade-track-changes-modal',
    modal: '.modal[role="dialog"], [role="dialog"][aria-modal="true"]',
    close: '.modal-header button.btn-close, .modal-header button.close'
  });

  function visible(node) {
    if (!node || !node.isConnected || node.hidden || node.getAttribute?.('aria-hidden') === 'true') return false;
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    return style?.display !== 'none' && style?.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function findUpgradeModal(doc) {
    for (const body of doc?.querySelectorAll(UPGRADE_MODAL_SELECTORS.body) || []) {
      const modal = body.closest(UPGRADE_MODAL_SELECTORS.modal);
      if (visible(body) && visible(modal)) return modal;
    }
    return null;
  }

  async function dismissUpgradeModal(modal, { delay, assertCurrent }) {
    const isOpen = () => visible(modal);
    const waitClosed = async () => {
      for (let i = 0; i < 6 && isOpen(); i++) { await delay(80); assertCurrent(); }
    };
    assertCurrent();
    const close = modal.querySelector(UPGRADE_MODAL_SELECTORS.close);
    if (visible(close) && !close.disabled) close.click();
    await waitClosed();
    if (isOpen()) {
      assertCurrent();
      const KeyboardEvent = modal.ownerDocument.defaultView.KeyboardEvent;
      modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await waitClosed();
    }
    return !isOpen();
  }

  // Page owns state/identity; this controller owns the click/poll/upgrade stop sequence.
  async function toggleMode(enabled, params, deps) {
    const { assertCurrent, delay, getState, isConfirmed, click, findControls, findOption } = deps;
    let attempted = false;
    const inspect = async () => {
      assertCurrent();
      const modal = findUpgradeModal(deps.document);
      if (enabled && modal) {
        const evidence = { upgradeModal: true, dismissed: await dismissUpgradeModal(modal, deps) };
        return { ok: false, code: 'reviewing_unavailable', attempted, evidence,
          failure: deps.buildFailure('reviewing_unavailable', {
            operationType: 'ensureReviewing', changedDocument: false, evidence
          }) };
      }
      const state = getState();
      return { ok: isConfirmed(enabled, state), attempted, reviewing: state.reviewing };
    };
    const poll = async waitMs => {
      let result = await inspect();
      for (let elapsed = 0; !result.ok && !result.code && elapsed < waitMs; elapsed += 120) {
        await delay(120);
        result = await inspect();
      }
      return result;
    };
    const waitMs = Number.isFinite(Number(params.waitMs)) ? Math.max(0, Number(params.waitMs)) : 1600;
    let result = await inspect();
    if (result.ok || result.code) return result;
    for (const control of [...new Set(findControls().filter(Boolean))]) {
      result = await inspect();
      if (result.ok || result.code) return result;
      assertCurrent(); click(control); attempted = true;
      result = await poll(Math.min(waitMs, 180));
      if (result.ok || result.code) return result;
      const option = findOption(enabled);
      if (option) {
        assertCurrent(); click(option);
        result = await poll(waitMs);
        if (result.ok || result.code) return result;
      }
    }
    result = await inspect();
    if (result.ok || result.code) return result;
    const option = findOption(enabled);
    if (option) {
      assertCurrent(); click(option); attempted = true;
      result = await poll(waitMs);
      if (result.ok || result.code) return result;
    }
    return inspect();
  }

  function knownUnavailable(record, now = Date.now()) {
    return record?.status === 'unavailable' && Number.isFinite(record.observedAt)
      && now >= record.observedAt && now - record.observedAt < UNAVAILABLE_TTL_MS;
  }

  // Content preflight invokes this before dispatch. Only explicit choices can lower the policy.
  async function resolveWritePolicy({ requireReviewing, knownUnavailable: unavailable }, deps) {
    deps.assertCurrent();
    let result = unavailable && requireReviewing
      ? { ok: false, code: 'reviewing_unavailable', evidence: { upgradeModal: true, remembered: true } }
      : await deps.ensureMode(requireReviewing);
    deps.assertCurrent();
    if (requireReviewing && result.ok) await deps.observe('available', 'reviewing_confirmed');
    if (requireReviewing && result.code === 'reviewing_unavailable') {
      if (!unavailable) await deps.observe('unavailable', 'upgrade_modal');
      deps.assertCurrent();
      const choice = await deps.choose(result);
      deps.assertCurrent();
      if (choice !== 'continue' && choice !== 'disable') return { ...result, ok: false };
      await deps.applyUntracked(choice);
      deps.assertCurrent();
      result = await deps.ensureMode(false);
      deps.assertCurrent();
      return { ...result, requireReviewing: false, trackingDecision: choice };
    }
    return { ...result, requireReviewing };
  }

  function matchesControlReview(text) {
    return CONTROL_REVIEW_PATTERNS.some(pattern => pattern.test(text));
  }

  function matchesInternalActiveReview(text) {
    return INTERNAL_ACTIVE_REVIEW_PATTERNS.some(pattern => pattern.test(text));
  }

  function isGenericReviewOnly(text) {
    return GENERIC_REVIEW_PATTERNS.some(pattern => pattern.test(text)) && !/\breviewing\b/i.test(text);
  }

  function normalize(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  return {
    detectReviewingFromSignals, findUpgradeModal, toggleMode, knownUnavailable, resolveWritePolicy, UNAVAILABLE_TTL_MS
  };
});
