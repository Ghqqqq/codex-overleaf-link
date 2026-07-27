(function initCodexOverleafDiffReviewPanel(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafDiffReviewPanel = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function diffReviewPanelFactory() {
  'use strict';

  const MAX_INITIAL_REVIEW_HUNKS = 20;
  const MAX_INITIAL_HUNK_LINES = 80;

  function createDiffReviewPanelController(deps = {}) {
    const root = deps.root || (typeof window !== 'undefined' ? window : globalThis);
    const document = deps.document || root.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const tr = typeof deps.tr === 'function' ? deps.tr : (key) => key;
    const callPageBridge = typeof deps.callPageBridge === 'function'
      ? deps.callPageBridge
      : () => Promise.resolve({ ok: false, reason: tr('diffHunkJumpFailed') });
    const getCurrentProjectId = typeof deps.getCurrentProjectId === 'function'
      ? deps.getCurrentProjectId
      : () => '';
    const getRunEvents = typeof deps.getRunEvents === 'function' ? deps.getRunEvents : () => null;
    const appendRunEvent = typeof deps.appendRunEvent === 'function' ? deps.appendRunEvent : () => {};
    const scrollLogToBottom = typeof deps.scrollLogToBottom === 'function' ? deps.scrollLogToBottom : () => {};

    function getReviewHunks() {
      return deps.reviewHunks ||
        root.CodexOverleafReviewHunks ||
        (typeof window !== 'undefined' ? window.CodexOverleafReviewHunks : null);
    }

    function createDiffReviewElement(syncChanges, options = {}) {
      const readonly = Boolean(options.readonly);
      const container = document.createElement('div');
      container.className = 'codex-diff-review';
      container.tabIndex = 0;
      container.setAttribute('role', 'region');
      container.setAttribute('data-diff-review-container', '');
      if (readonly) {
        container.dataset.readonly = 'true';
      }
      const reviewHunks = options.reviewHunks ||
        deps.reviewHunks ||
        root.CodexOverleafReviewHunks ||
        (typeof window !== 'undefined' ? window.CodexOverleafReviewHunks : null);
      const reviewModel = reviewHunks?.buildReviewModel?.(syncChanges) || { files: [], hunks: [] };
      const reviewFilesByIndex = new Map(reviewModel.files.map(file => [file.index, file]));
      const fileStates = new Map();
      const hunkStates = new Map();
      const fileViews = new Map();
      const hunkViews = new Map();
      const decisionListeners = new Set();
      let focusedHunkKey = null;
      let remainingInitialReviewHunks = MAX_INITIAL_REVIEW_HUNKS;

      function notifyDecisionChanged() {
        for (const listener of decisionListeners) {
          listener();
        }
      }

      function setDecisionStatus(actions, accepted) {
        const status = document.createElement('span');
        status.className = 'codex-diff-decision-label';
        status.textContent = accepted ? tr('diffAccepted') : tr('diffRejected');
        actions.replaceChildren(status);
      }

      function setHunkDecisionStatus(actions, accepted, hunk) {
        const status = document.createElement('span');
        status.className = 'codex-diff-hunk-status';
        status.setAttribute('data-diff-hunk-status', '');
        status.textContent = accepted ? tr('diffHunkAccepted') : tr('diffHunkRejected');
        actions.replaceChildren(status);
        // A mis-click must not be permanent: every decision stays reversible
        // until the review is applied.
        if (!readonly && hunk) {
          const revert = document.createElement('button');
          revert.type = 'button';
          revert.setAttribute('data-diff-hunk-revert', '');
          revert.textContent = tr('diffHunkRevert');
          revert.title = tr('diffHunkRevert');
          revert.setAttribute('aria-label', tr('diffHunkRevert'));
          revert.addEventListener('click', () => revertHunkDecision(hunk));
          actions.append(revert);
        }
      }

      function revertHunkDecision(hunk) {
        if (readonly || hunkStates.get(hunk.decisionKey) === null) {
          return;
        }
        hunkStates.set(hunk.decisionKey, null);
        const view = hunkViews.get(hunk.decisionKey);
        if (view) {
          view.hunkEl.dataset.decision = 'pending';
          setHunkCollapsed(view, false);
          renderPendingHunkActions(view.actions, hunk);
        }
        const fileView = fileViews.get(hunk.path);
        const fileModel = reviewModel.files.find(file => file.path === hunk.path);
        if (fileView && fileModel) {
          updateReviewableFileDecision(fileView, fileModel);
        }
        notifyDecisionChanged();
      }

      function renderPendingHunkActions(actions, reviewHunk) {
        const acceptHunkBtn = document.createElement('button');
        acceptHunkBtn.type = 'button';
        acceptHunkBtn.setAttribute('data-diff-hunk-accept', '');
        acceptHunkBtn.textContent = '✓';
        acceptHunkBtn.title = tr('diffHunkAccept');
        acceptHunkBtn.setAttribute('aria-label', tr('diffHunkAccept'));
        const rejectHunkBtn = document.createElement('button');
        rejectHunkBtn.type = 'button';
        rejectHunkBtn.setAttribute('data-diff-hunk-reject', '');
        rejectHunkBtn.textContent = '✗';
        rejectHunkBtn.title = tr('diffHunkReject');
        rejectHunkBtn.setAttribute('aria-label', tr('diffHunkReject'));
        const jumpHunkBtn = document.createElement('button');
        jumpHunkBtn.type = 'button';
        jumpHunkBtn.setAttribute('data-diff-hunk-jump', '');
        jumpHunkBtn.textContent = '↗';
        jumpHunkBtn.title = tr('diffHunkJump');
        jumpHunkBtn.setAttribute('aria-label', tr('diffHunkJump'));
        acceptHunkBtn.addEventListener('click', () => decideHunkChange(reviewHunk, true));
        rejectHunkBtn.addEventListener('click', () => decideHunkChange(reviewHunk, false));
        jumpHunkBtn.addEventListener('click', () => jumpToHunk(reviewHunk));
        actions.replaceChildren(acceptHunkBtn, rejectHunkBtn, jumpHunkBtn);
      }

      function setHunkCollapsed(view, collapsed) {
        if (view?.hunkEl) {
          view.hunkEl.dataset.collapsed = collapsed ? 'true' : 'false';
        }
      }

      function setHunkDecisionView(hunk, accepted, options = {}) {
        const hunkView = hunkViews.get(hunk.decisionKey);
        if (!hunkView) {
          return;
        }
        hunkView.hunkEl.dataset.decision = accepted ? 'accepted' : 'rejected';
        setHunkDecisionStatus(hunkView.actions, accepted, hunk);
        if (options.collapse) {
          setHunkCollapsed(hunkView, true);
        }
      }

      function setHunkJumpStatus(view, status, message = '') {
        if (!view) {
          return;
        }
        view.hunkEl.dataset.jumpStatus = status;
        let statusEl = view.hunkEl.querySelector?.('[data-diff-hunk-jump-status]');
        if (!statusEl) {
          statusEl = document.createElement('span');
          statusEl.className = 'codex-diff-hunk-jump-status';
          statusEl.setAttribute('data-diff-hunk-jump-status', '');
          view.actions.append(statusEl);
        }
        statusEl.textContent = message;
      }

      function setHunkFocused(hunkEl, focused) {
        hunkEl.dataset.focused = focused ? 'true' : 'false';
        const baseClass = 'codex-diff-hunk';
        hunkEl.className = focused ? `${baseClass} codex-diff-hunk-focused` : baseClass;
      }

      function getFocusableHunks() {
        return Array.from(hunkViews.values()).filter(view => view.reviewHunk);
      }

      function focusHunkByIndex(index) {
        const hunks = getFocusableHunks();
        if (!hunks.length) {
          return false;
        }
        const nextIndex = Math.max(0, Math.min(index, hunks.length - 1));
        const next = hunks[nextIndex];
        if (focusedHunkKey && focusedHunkKey !== next.reviewHunk.decisionKey) {
          const previous = hunkViews.get(focusedHunkKey);
          if (previous) {
            setHunkFocused(previous.hunkEl, false);
          }
        }
        focusedHunkKey = next.reviewHunk.decisionKey;
        setHunkFocused(next.hunkEl, true);
        return true;
      }

      function moveFocusedHunk(delta) {
        const hunks = getFocusableHunks();
        if (!hunks.length) {
          return false;
        }
        const currentIndex = Math.max(0, hunks.findIndex(view => view.reviewHunk.decisionKey === focusedHunkKey));
        return focusHunkByIndex(currentIndex + delta);
      }

      function getFocusedHunk() {
        if (!focusedHunkKey) {
          focusHunkByIndex(0);
        }
        return hunkViews.get(focusedHunkKey)?.reviewHunk || null;
      }

      function focusNextPendingHunkAfter(decisionKey) {
        const hunks = getFocusableHunks();
        if (!hunks.length) {
          return false;
        }
        const startIndex = hunks.findIndex(view => view.reviewHunk.decisionKey === decisionKey);
        const anchorIndex = startIndex >= 0 ? startIndex : -1;
        for (let offset = 1; offset <= hunks.length; offset += 1) {
          const index = (anchorIndex + offset) % hunks.length;
          const view = hunks[index];
          if (hunkStates.get(view.reviewHunk.decisionKey) === null) {
            const focused = focusHunkByIndex(index);
            view.hunkEl.scrollIntoView?.({ block: 'nearest' });
            return focused;
          }
        }
        if (focusedHunkKey) {
          const previous = hunkViews.get(focusedHunkKey);
          if (previous) {
            setHunkFocused(previous.hunkEl, false);
          }
          focusedHunkKey = null;
        }
        return false;
      }

      function getHunkJumpRange(reviewHunk) {
        const from = Number(reviewHunk?.startOffset);
        const to = Number(reviewHunk?.endOffset);
        return {
          path: reviewHunk?.path,
          from: Number.isInteger(from) && from >= 0 ? from : 0,
          to: Number.isInteger(to) && to >= 0 ? to : (Number.isInteger(from) && from >= 0 ? from : 0)
        };
      }

      async function jumpToHunk(reviewHunk) {
        if (!reviewHunk) {
          return;
        }
        const { path, from, to } = getHunkJumpRange(reviewHunk);
        const view = hunkViews.get(reviewHunk.decisionKey);
        setHunkJumpStatus(view, 'pending', '');
        try {
          const result = await callPageBridge('jumpToPosition', {
            path,
            from,
            to,
            runProjectId: getCurrentProjectId()
          });
          if (result?.ok === false) {
            setHunkJumpStatus(view, 'failed', result.reason || tr('diffHunkJumpFailed'));
          } else {
            setHunkJumpStatus(view, 'done', '');
          }
        } catch (error) {
          setHunkJumpStatus(view, 'failed', error?.message || tr('diffHunkJumpFailed'));
        }
      }

      function isDiffReviewEditableTarget(target) {
        const tagName = String(target?.tagName || '').toUpperCase();
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT' ||
            tagName === 'BUTTON' || tagName === 'SUMMARY') {
          return true;
        }
        if (tagName === 'A' && target?.getAttribute?.('href')) {
          return true;
        }
        const role = String(target?.getAttribute?.('role') || '').toLowerCase();
        if (['button', 'link', 'menuitem', 'checkbox', 'radio', 'switch', 'tab'].includes(role)) {
          return true;
        }
        if (target?.isContentEditable || target?.getAttribute?.('contenteditable') === 'true') {
          return true;
        }
        return Boolean(target?.closest?.(
          'input, textarea, select, button, summary, a[href], [contenteditable="true"], [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"]'
        ));
      }

      function handleDiffReviewKeydown(event) {
        if (isDiffReviewEditableTarget(event.target)) {
          return;
        }
        let handled = false;
        switch (event.key) {
          case 'j':
            handled = moveFocusedHunk(1);
            break;
          case 'k':
            handled = moveFocusedHunk(-1);
            break;
          case 'a': {
            const hunk = getFocusedHunk();
            if (hunk && !readonly) {
              decideHunkChange(hunk, true);
              handled = true;
            }
            break;
          }
          case 'r': {
            const hunk = getFocusedHunk();
            if (hunk && !readonly) {
              decideHunkChange(hunk, false);
              handled = true;
            }
            break;
          }
          case 'Enter': {
            const hunk = getFocusedHunk();
            if (hunk) {
              jumpToHunk(hunk);
              handled = true;
            }
            break;
          }
          case 'Escape':
            if (focusedHunkKey) {
              const previous = hunkViews.get(focusedHunkKey);
              if (previous) {
                setHunkFocused(previous.hunkEl, false);
              }
              focusedHunkKey = null;
            }
            container.blur?.();
            handled = true;
            break;
          default:
            break;
        }
        if (handled) {
          event.preventDefault?.();
        }
      }

      function updateReviewableFileDecision(view, fileModel) {
        const decisions = fileModel.hunks.map(hunk => hunkStates.get(hunk.decisionKey));
        const allAccepted = decisions.every(value => value === true);
        const allRejected = decisions.every(value => value === false);
        if (allAccepted || allRejected) {
          view.card.dataset.accepted = allAccepted ? 'true' : 'false';
          view.card.dataset.decision = allAccepted ? 'accepted' : 'rejected';
          setDecisionStatus(view.actions, allAccepted);
          return;
        }
        view.card.dataset.decision = 'pending';
        delete view.card.dataset.accepted;
      }

      function decideHunkChange(hunk, accepted) {
        if (readonly || hunkStates.get(hunk.decisionKey) !== null) {
          return;
        }
        hunkStates.set(hunk.decisionKey, accepted);
        setHunkDecisionView(hunk, accepted, { collapse: true });
        focusNextPendingHunkAfter(hunk.decisionKey);
        const fileView = fileViews.get(hunk.path);
        const fileModel = reviewModel.files.find(file => file.path === hunk.path);
        if (fileView && fileModel) {
          updateReviewableFileDecision(fileView, fileModel);
        }
        notifyDecisionChanged();
      }

      function decideReviewableFilePendingHunks(fileModel, accepted) {
        let changed = false;
        for (const hunk of fileModel.hunks) {
          if (hunkStates.get(hunk.decisionKey) !== null) {
            continue;
          }
          hunkStates.set(hunk.decisionKey, accepted);
          setHunkDecisionView(hunk, accepted, { collapse: true });
          changed = true;
        }
        return changed;
      }

      function decidePendingChanges(accepted) {
        if (readonly) {
          return false;
        }
        let changed = false;
        for (const [path, value] of fileStates.entries()) {
          if (value !== null) {
            continue;
          }
          fileStates.set(path, accepted);
          const view = fileViews.get(path);
          if (view) {
            view.card.dataset.accepted = accepted ? 'true' : 'false';
            view.card.dataset.decision = accepted ? 'accepted' : 'rejected';
            setDecisionStatus(view.actions, accepted);
          }
          changed = true;
        }
        for (const fileModel of reviewModel.files) {
          if (!fileModel.reviewable) {
            continue;
          }
          changed = decideReviewableFilePendingHunks(fileModel, accepted) || changed;
          const fileView = fileViews.get(fileModel.path);
          if (fileView) {
            updateReviewableFileDecision(fileView, fileModel);
          }
        }
        focusNextPendingHunkAfter(focusedHunkKey);
        if (changed) {
          notifyDecisionChanged();
        }
        return changed;
      }

      function decideFileChange(path, accepted) {
        if (readonly) {
          return;
        }
        const view = fileViews.get(path);
        if (!view) {
          return;
        }
        const fileModel = view.fileModel;
        if (fileModel?.reviewable) {
          const changed = decideReviewableFilePendingHunks(fileModel, accepted);
          updateReviewableFileDecision(view, fileModel);
          focusNextPendingHunkAfter(focusedHunkKey);
          if (changed) {
            notifyDecisionChanged();
          }
          return;
        }
        if (fileStates.get(path) !== null) {
          return;
        }
        fileStates.set(path, accepted);
        view.card.dataset.accepted = accepted ? 'true' : 'false';
        view.card.dataset.decision = accepted ? 'accepted' : 'rejected';
        setDecisionStatus(view.actions, accepted);
        notifyDecisionChanged();
      }

      function getPendingCount() {
        let count = 0;
        for (const value of fileStates.values()) {
          if (value === null) {
            count += 1;
          }
        }
        for (const value of hunkStates.values()) {
          if (value === null) {
            count += 1;
          }
        }
        return count;
      }

      function getDecisions() {
        const decisions = {};
        for (const [path, value] of fileStates.entries()) {
          decisions[reviewHunks?.normalizeReviewDecisionKey?.(path) || `${path}::file`] = value;
        }
        for (const [key, value] of hunkStates.entries()) {
          decisions[key] = value;
        }
        return decisions;
      }

      function getAcceptedChanges() {
        const decisions = getDecisions();
        if (reviewHunks?.buildAcceptedSyncChanges) {
          return reviewHunks.buildAcceptedSyncChanges(syncChanges, decisions);
        }
        return syncChanges.filter(change => fileStates.get(change.path) === true);
      }

      function createDiffLineElement(line) {
        const lineEl = document.createElement('div');
        lineEl.className = 'codex-diff-line';
        lineEl.dataset.type = line.type;
        lineEl.setAttribute('data-diff-line', '');
        lineEl.textContent = line.text;
        return lineEl;
      }

      function createPatchDiffLines(patch = {}) {
        const lines = [];
        appendPatchDiffText(lines, 'remove', patch.expected);
        appendPatchDiffText(lines, 'add', patch.insert);
        return lines;
      }

      function appendPatchDiffText(lines, type, text) {
        const value = String(text ?? '');
        if (!value) {
          return;
        }
        for (const line of value.split('\n')) {
          lines.push({ type, text: line });
        }
      }

      function getReviewDisplayHunk(change, diffHunks, fileModel, hunkIndex) {
        const diffHunk = diffHunks[hunkIndex] || { lines: [] };
        if (!fileModel?.reviewable) {
          return diffHunk;
        }
        if (diffHunks.length === fileModel.hunks.length && Array.isArray(diffHunk.lines) && diffHunk.lines.length) {
          return diffHunk;
        }
        const patchIndex = fileModel.hunks[hunkIndex]?.patchIndexes?.[0] ?? hunkIndex;
        const patch = Array.isArray(change.patches) ? change.patches[patchIndex] : null;
        const patchLines = createPatchDiffLines(patch);
        return patchLines.length ? { ...diffHunk, lines: patchLines } : diffHunk;
      }

      function appendHunkLines(hunkEl, lines = []) {
        const lineWrap = document.createElement('div');
        lineWrap.className = 'codex-diff-hunk-lines';
        const normalizedLines = Array.isArray(lines) ? lines : [];

        function renderLines(expanded) {
          const visibleLines = expanded ? normalizedLines : normalizedLines.slice(0, MAX_INITIAL_HUNK_LINES);
          const children = visibleLines.map(createDiffLineElement);
          if (!expanded && normalizedLines.length > MAX_INITIAL_HUNK_LINES) {
            const expandBtn = document.createElement('button');
            expandBtn.type = 'button';
            expandBtn.className = 'codex-diff-hunk-expand';
            expandBtn.setAttribute('data-diff-hunk-expand', '');
            expandBtn.textContent = tr('diffHunkExpandLines', {
              count: normalizedLines.length - MAX_INITIAL_HUNK_LINES
            });
            expandBtn.addEventListener('click', () => renderLines(true));
            children.push(expandBtn);
          }
          lineWrap.replaceChildren(...children);
        }

        renderLines(false);
        hunkEl.append(lineWrap);
      }

      function createDiffHunkElement(hunk, reviewHunk, fileModel, hunkIndex) {
        const hunkEl = document.createElement('div');
        hunkEl.className = 'codex-diff-hunk';
        hunkEl.setAttribute('data-diff-review-hunk', '');
        hunkEl.dataset.hunkIndex = String(hunkIndex);
        if (reviewHunk) {
          // Orientation header: reviewers need "what changed where" — the
          // start line was always computed (reviewHunks) but never shown.
          if (Number.isFinite(Number(reviewHunk.startLine)) && Number(reviewHunk.startLine) > 0) {
            const location = document.createElement('div');
            location.className = 'codex-diff-hunk-location';
            location.textContent = tr('diffHunkLocation', {
              line: String(reviewHunk.startLine),
              count: String(reviewHunk.lineCount || 1)
            });
            hunkEl.append(location);
          }
          const hunkDecision = hunkStates.get(reviewHunk.decisionKey);
          hunkEl.dataset.decision = readonly ? 'accepted' : (hunkDecision === true ? 'accepted' : hunkDecision === false ? 'rejected' : 'pending');
          if (!readonly && (hunkDecision === true || hunkDecision === false)) {
            hunkEl.dataset.collapsed = 'true';
          }
          setHunkFocused(hunkEl, focusedHunkKey === reviewHunk.decisionKey);
          const hunkActions = document.createElement('div');
          hunkActions.className = 'codex-diff-hunk-actions';
          if (readonly || hunkDecision === true || hunkDecision === false) {
            setHunkDecisionStatus(hunkActions, readonly ? true : hunkDecision, readonly ? null : reviewHunk);
          } else {
            renderPendingHunkActions(hunkActions, reviewHunk);
          }
          hunkEl.append(hunkActions);
          hunkViews.set(reviewHunk.decisionKey, { hunkEl, actions: hunkActions, reviewHunk });
        } else if (!readonly && fileModel && !fileModel.reviewable && hunkIndex === 0) {
          const fallback = document.createElement('div');
          fallback.className = 'codex-diff-fallback-label';
          fallback.textContent = tr('diffFallbackFileOnly');
          hunkEl.append(fallback);
        }
        appendHunkLines(hunkEl, hunk.lines);
        return hunkEl;
      }

      for (const [changeIndex, change] of syncChanges.entries()) {
        const fileModel = reviewFilesByIndex.get(changeIndex);
        if (fileModel?.reviewable) {
          for (const hunk of fileModel.hunks) {
            hunkStates.set(hunk.decisionKey, readonly ? true : null);
          }
        } else {
          fileStates.set(change.path, readonly ? true : null);
        }
        const card = document.createElement('div');
        card.className = 'codex-diff-file';
        card.dataset.path = change.path;
        card.dataset.decision = readonly ? 'accepted' : 'pending';
        if (readonly) {
          card.dataset.accepted = 'true';
        }

        const header = document.createElement('div');
        header.className = 'codex-diff-file-header';
        const pathEl = document.createElement('span');
        pathEl.className = 'codex-diff-file-path';
        pathEl.textContent = change.type === 'delete' ? `[delete] ${change.path}` : change.path;
        pathEl.title = change.path;
        const actions = document.createElement('div');
        actions.className = 'codex-diff-file-actions';

        if (readonly) {
          const status = document.createElement('span');
          status.className = 'codex-diff-readonly-label';
          status.textContent = tr('diffWritten');
          actions.append(status);
        } else {
          const acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.dataset.diffAccept = '';
          acceptBtn.textContent = '✓';
          acceptBtn.title = tr('diffAccept');
          acceptBtn.setAttribute('aria-label', tr('diffAccept'));
          const rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.dataset.diffReject = '';
          rejectBtn.textContent = '✗';
          rejectBtn.title = tr('diffReject');
          rejectBtn.setAttribute('aria-label', tr('diffReject'));

          acceptBtn.addEventListener('click', () => decideFileChange(change.path, true));
          rejectBtn.addEventListener('click', () => decideFileChange(change.path, false));

          actions.append(acceptBtn, rejectBtn);
        }

        header.append(pathEl, actions);
        card.append(header);

        const diffHunks = Array.isArray(change.diff) ? change.diff : [];
        if (diffHunks.length || fileModel?.reviewable) {
          const body = document.createElement('div');
          body.className = 'codex-diff-body';
          const hunkCount = fileModel?.reviewable ? Math.max(diffHunks.length, fileModel.hunks.length) : diffHunks.length;
          const initialHunkCount = Math.min(hunkCount, remainingInitialReviewHunks);
          remainingInitialReviewHunks -= initialHunkCount;
          function renderHunks(visibleCount) {
            const children = [];
            for (let hunkIndex = 0; hunkIndex < visibleCount; hunkIndex += 1) {
              const reviewHunk = fileModel?.reviewable ? fileModel.hunks[hunkIndex] : null;
              const hunk = getReviewDisplayHunk(change, diffHunks, fileModel, hunkIndex);
              children.push(createDiffHunkElement(hunk, reviewHunk, fileModel, hunkIndex));
            }
            if (visibleCount < hunkCount) {
              const showMoreBtn = document.createElement('button');
              showMoreBtn.type = 'button';
              showMoreBtn.className = 'codex-diff-show-more-hunks';
              showMoreBtn.setAttribute('data-diff-show-more-hunks', '');
              showMoreBtn.textContent = tr('diffShowMoreHunks', {
                count: hunkCount - visibleCount
              });
              showMoreBtn.addEventListener('click', () => renderHunks(hunkCount));
              children.push(showMoreBtn);
            }
            body.replaceChildren(...children);
          }
          renderHunks(initialHunkCount);
          card.append(body);
        }

        container.append(card);
        fileViews.set(change.path, { card, actions, fileModel });
      }

      container.addEventListener('keydown', handleDiffReviewKeydown);

      return {
        container,
        fileStates,
        decideFileChange,
        decidePendingChanges,
        getPendingCount,
        getDecisions,
        getAcceptedChanges,
        onDecision(callback) {
          decisionListeners.add(callback);
          return () => decisionListeners.delete(callback);
        }
      };
    }

    function renderDiffReview(syncChanges) {
      return new Promise(resolve => {
        const review = createDiffReviewElement(syncChanges);
        const { container } = review;
        let finished = false;

        const toolbar = document.createElement('div');
        toolbar.className = 'codex-diff-toolbar';
        const summary = document.createElement('span');
        summary.className = 'codex-diff-toolbar-summary';
        const rejectAllBtn = document.createElement('button');
        rejectAllBtn.type = 'button';
        rejectAllBtn.textContent = tr('diffRejectAll');
        const acceptAllBtn = document.createElement('button');
        acceptAllBtn.type = 'button';
        acceptAllBtn.dataset.diffAcceptAll = '';
        acceptAllBtn.textContent = tr('diffAcceptAll');

        function finish(accepted) {
          if (finished) {
            return;
          }
          finished = true;
          container.remove();
          resolve(accepted);
        }

        function updateSummary() {
          const pending = review.getPendingCount();
          summary.textContent = pending ? tr('diffPendingCount', { count: pending }) : tr('diffSelectionDone');
        }

        function finishIfAllDecided() {
          updateSummary();
          if (review.getPendingCount() === 0) {
            const reviewHunks = getReviewHunks();
            // Report what was rejected BEFORE resolving: the run's completion
            // report uses these summaries for the "redo rejected changes"
            // action. Failure here must never block the accept path.
            if (typeof deps.onRejectedHunks === 'function' && reviewHunks?.buildRejectedHunkSummaries) {
              try {
                deps.onRejectedHunks(reviewHunks.buildRejectedHunkSummaries(syncChanges, review.getDecisions()));
              } catch (error) {
                // Summaries are best-effort decoration on the report.
              }
            }
            finish(reviewHunks?.buildAcceptedSyncChanges
              ? reviewHunks.buildAcceptedSyncChanges(syncChanges, review.getDecisions())
              : review.getAcceptedChanges());
          }
        }

        acceptAllBtn.addEventListener('click', () => {
          review.decidePendingChanges(true);
          finishIfAllDecided();
        });
        rejectAllBtn.addEventListener('click', () => {
          review.decidePendingChanges(false);
          finishIfAllDecided();
        });
        review.onDecision(finishIfAllDecided);

        updateSummary();
        toolbar.append(summary, rejectAllBtn, acceptAllBtn);
        container.append(toolbar);

        const events = getRunEvents();
        if (events) {
          events.append(container);
          scrollLogToBottom();
        }
      });
    }

    function renderReadOnlyDiffReview(syncChanges, title = tr('diffWrittenChangesTitle')) {
      const visibleChanges = (syncChanges || []).filter(change => change?.diff?.length);
      let events = getRunEvents();
      if (!visibleChanges.length || !events) {
        return;
      }

      appendRunEvent({
        title,
        status: 'completed'
      });
      const { container } = createDiffReviewElement(visibleChanges, { readonly: true });
      events = getRunEvents() || events;
      events.append(container);
      scrollLogToBottom();
    }

    return {
      createDiffReviewElement,
      renderDiffReview,
      renderReadOnlyDiffReview
    };
  }

  return {
    createDiffReviewPanelController,
    _private: {
      MAX_INITIAL_REVIEW_HUNKS,
      MAX_INITIAL_HUNK_LINES
    }
  };
});
