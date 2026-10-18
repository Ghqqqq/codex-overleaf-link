(function initCompileBridge(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafCompileBridge = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function compileBridgeFactory() {
  'use strict';

  const COMPILE_TEMPLATE_TTL_MS = 5 * 60 * 1000;
  const MAX_RECENT_COMPILE_CAPTURES = 8;
  const COMPILE_LOG_MAX_AGE_MS = 30000;
  const GLOBAL_STATE_KEY = '__codexOverleafCompileBridgeState';
  const FETCH_WRAPPER_REVISION = '2026-10-17-compile-capture-v4';

  function create(deps = {}) {
    const pageWindow = deps.window || window;
    const pageDocument = deps.document || document;
    let installed = false;
    const previousState = pageWindow[GLOBAL_STATE_KEY];
    // A buried wrapper still closes over its old state. Isolate its counters and
    // late responses while keeping the other script's fetch chain intact.
    const replaceWrapper = previousState?.wrappedFetch
      && (previousState.wrapperRevision !== FETCH_WRAPPER_REVISION || pageWindow.fetch !== previousState.wrappedFetch);
    const state = replaceWrapper ? { ...previousState, inputListenerInstalled: false } : previousState || {
      capturedRequestTemplate: null,
      lastCompileResponse: null,
      lastCompileAt: 0,
      lastCompileSourceChangeTimestamp: 0,
      lastKnownSourceEditTimestamp: 0,
      originalFetch: null,
      wrappedFetch: null,
      inputListenerInstalled: false
    };
    if (replaceWrapper && previousState.inputListener) {
      pageDocument.removeEventListener?.('input', previousState.inputListener, true);
    }
    state.compileRequestSequence ||= 0;
    // Keep completed captures isolated from a detached older wrapper.
    state.recentCompileCaptures = (state.recentCompileCaptures || []).slice(0, MAX_RECENT_COMPILE_CAPTURES);
    // Busy tokens alone survive reinjection: old requests can release their own
    // tokens without advancing the new wrapper's capture counters or results.
    state.inFlightCompileRequests ||= new Set();
    pageWindow[GLOBAL_STATE_KEY] = state;

    function install() {
      if (installed) {
        return;
      }
      installed = true;
      interceptCompileRequests();
      if (typeof pageDocument.addEventListener === 'function' && state.inputListenerInstalled !== true) {
        pageDocument.addEventListener('input', markSourceEditFromInput, true);
        state.inputListener = markSourceEditFromInput;
        state.inputListenerInstalled = true;
      }
    }

    function interceptCompileRequests() {
      if (state.wrapperRevision === FETCH_WRAPPER_REVISION && state.wrappedFetch && pageWindow.fetch === state.wrappedFetch) {
        return;
      }
      if (!state.originalFetch || pageWindow.fetch !== state.wrappedFetch) {
        state.originalFetch = pageWindow.fetch;
      }
      const originalFetch = state.originalFetch;
      state.wrapperRevision = FETCH_WRAPPER_REVISION;
      state.wrappedFetch = async function codexOverleafCompileFetchWrapper(...args) {
        const [resource, init] = args;
        const url = typeof resource === 'string' ? resource : (resource?.url || '');
        const method = (init?.method || resource?.method || 'GET').toUpperCase();
        const isCompileRequest = /\/project\/[^/]+\/compile(?:[?#]|$)/.test(url) && method === 'POST';
        const captureId = isCompileRequest ? ++state.compileRequestSequence : 0;
        const compileSourceChangeTimestamp = isCompileRequest ? state.lastKnownSourceEditTimestamp : 0;
        const pendingRequest = isCompileRequest ? {} : null;

        if (isCompileRequest) {
          state.capturedRequestTemplate = {
            url,
            method: 'POST',
            capturedAt: Date.now(),
            headers: init?.headers ? (
              init.headers instanceof Headers
                ? Object.fromEntries(init.headers.entries())
                : { ...init.headers }
            ) : {},
            body: init?.body || null
          };
        }

        if (pendingRequest) state.inFlightCompileRequests.add(pendingRequest);
        try {
          const response = await originalFetch.apply(this, args);

          if (isCompileRequest && response.ok) {
            try {
              const clone = response.clone();
              const json = await clone.json();
              const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
              if (CompileAdapter) {
                const capture = {
                  compile: { ...CompileAdapter.parseCompileResponse(json), captureId },
                  compiledAt: Date.now(),
                  sourceChangeTimestamp: compileSourceChangeTimestamp
                };
                state.recentCompileCaptures = [capture, ...state.recentCompileCaptures]
                  .sort((a, b) => b.compile.captureId - a.compile.captureId).slice(0, MAX_RECENT_COMPILE_CAPTURES);
                // Preserve request order even if an older response finishes last.
                if (captureId > (state.lastCompileResponse?.captureId || 0)) {
                  state.lastCompileResponse = capture.compile;
                  state.lastCompileAt = capture.compiledAt;
                  state.lastCompileSourceChangeTimestamp = capture.sourceChangeTimestamp;
                }
              }
            } catch (_e) { /* ignore parse errors */ }
          }
          return response;
        } finally {
          if (pendingRequest) state.inFlightCompileRequests.delete(pendingRequest);
        }
      };
      pageWindow.fetch = state.wrappedFetch;
    }

    async function triggerCompile(params = {}) {
      const sourceAtTrigger = state.lastKnownSourceEditTimestamp;
      const saveResult = await waitForCompileSaveState(params);
      // Current Overleaf shows no save indicator while idle; a quiet editor is
      // the same weaker evidence the update-idle check accepts.
      if (params.requireVerifiedSave !== false && !['verified_saved', 'verified_quiet'].includes(saveResult.state)) {
        return {
          ok: false,
          reason: saveResult.reason || 'Overleaf save state was not verified.',
          saveStateVerified: false,
          saveState: saveResult.state || 'unknown_timeout'
        };
      }
      const saveMetadata = buildSaveStateMetadata(saveResult);
      const startCaptureId = state.compileRequestSequence;
      const template = state.capturedRequestTemplate;
      const button = findOverleafCompileButton();
      // Busy UI or observed requests forbid the template fallback too. Waiting
      // can reuse the in-flight result or click the main button once it is idle.
      if (isCompileBusy(button) || (button && (params.preferUiClick === true || !isFreshCapturedRequestTemplate(template)))) {
        const captured = await waitForCapturedCompile(params.captureTimeoutMs || 60000, sourceAtTrigger);
        return {
          ok: true,
          compile: captured.compile || { ok: true, status: 'triggered' },
          resultCaptured: captured.ok,
          reason: captured.reason || '',
          ...saveMetadata,
          ...(captured.clicked ? { triggeredBy: 'overleaf-button' } : {})
        };
      }
      if (!template || !isFreshCapturedRequestTemplate(template)) {
        return {
          ok: false,
          reason: template
            ? 'Stored compile request template expired. Please click Overleaf Recompile once, then retry.'
            : 'No Overleaf Recompile button or compile request template is available.',
          ...saveMetadata
        };
      }

      try {
        const response = await pageWindow.fetch(template.url, {
          method: template.method,
          headers: template.headers,
          body: template.body,
          credentials: 'same-origin'
        });
        if (!response.ok) {
          return {
            ok: false,
            reason: `Compile request failed with status ${response.status}`,
            ...saveMetadata
          };
        }
        const captured = findEligibleCapture(sourceAtTrigger, startCaptureId)?.compile;
        return {
          ok: true,
          compile: captured || { ok: false, status: 'triggered' },
          resultCaptured: Boolean(captured),
          reason: captured ? '' : 'compile_capture_missing',
          ...saveMetadata
        };
      } catch (error) {
        return {
          ok: false,
          reason: `Compile request error: ${error.message}`,
          ...saveMetadata
        };
      }
    }

    async function waitForCompileSaveState(params = {}) {
      if (typeof deps.waitForSaveState !== 'function') {
        return {
          ok: false,
          state: 'unavailable',
          reason: 'Overleaf save-state checker is unavailable.'
        };
      }
      try {
        return normalizeSaveStateResult(
          await deps.waitForSaveState({ deadlineMs: resolveWaitForSaveMs(params.waitForSaveMs),
            // Only a caller that requires save evidence may settle for a quiet editor.
            allowQuietEditorFallback: params.requireVerifiedSave !== false, quietFallbackMs: 1000 })
        );
      } catch (error) {
        return {
          ok: false,
          state: 'unavailable',
          reason: `Overleaf save-state checker failed: ${error.message}`
        };
      }
    }

    function resolveWaitForSaveMs(value) {
      if (value == null) {
        return 5000;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : 5000;
    }

    function normalizeSaveStateResult(result = {}) {
      if (result.ok === true && !result.state) {
        return {
          ...result,
          state: 'verified_saved'
        };
      }
      if (result.state === 'verified_saved') {
        return {
          ...result,
          ok: true,
          state: 'verified_saved'
        };
      }
      return {
        ...result,
        ok: false,
        state: result.state || 'unknown_timeout'
      };
    }

    function buildSaveStateMetadata(saveResult = {}) {
      const saveState = saveResult.state || 'unknown_timeout';
      return {
        saveStateVerified: saveState === 'verified_saved',
        saveState
      };
    }

    async function getCompileLog(params = {}) {
      const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
      if (!CompileAdapter) {
        return { ok: false, reason: 'CompileAdapter not loaded' };
      }

      const maxAgeMs = params.maxAgeMs ?? COMPILE_LOG_MAX_AGE_MS;
      let capture = params.captureId != null
        ? state.recentCompileCaptures.find(item => item.compile.captureId === params.captureId)
        : state.recentCompileCaptures[0];
      const needsFreshCompile = !capture?.compile.ok || Boolean(captureFreshnessReason(capture, maxAgeMs));

      // A named capture must never silently switch to another compile's log.
      if (needsFreshCompile && params.captureId == null && params.triggerIfStale !== false) {
        const compileResult = await triggerCompile({ waitForSaveMs: resolveWaitForSaveMs(params.waitForSaveMs) });
        if (!compileResult.ok || !compileResult.resultCaptured) {
          return {
            ok: false,
            reason: `Could not get fresh compile: ${compileResult.reason}`,
            saveStateVerified: compileResult.saveStateVerified,
            saveState: compileResult.saveState
          };
        }
        capture = state.recentCompileCaptures.find(item => item.compile.captureId === compileResult.compile?.captureId);
      }

      if (!capture) return { ok: false, reason: 'compile_capture_missing' };
      const { compile: compiled, compiledAt } = capture;
      const freshnessReason = captureFreshnessReason(capture, maxAgeMs);
      if (freshnessReason) return { ok: false, captureId: compiled.captureId, fresh: false, reason: freshnessReason };
      if (!compiled?.ok || !compiled.logUrl) {
        return { ok: false, reason: compiled?.reason || 'No compile log URL available' };
      }

      const candidates = [];
      if (compiled.build && compiled.pdfDownloadDomain) {
        // pdfDownloadDomain already includes Overleaf's outputUrlPrefix.
        candidates.push({ route: 'download', url: `${compiled.pdfDownloadDomain}${compiled.logUrl}` });
      }
      try {
        const url = new URL(compiled.logUrl, pageWindow.location.origin);
        if (url.origin === pageWindow.location.origin) {
          if (compiled.clsiServerId) url.searchParams.set('clsiserverid', compiled.clsiServerId);
          if (!candidates.some(candidate => candidate.url === url.href)) candidates.push({ route: 'origin', url: url.href });
        }
      } catch (_error) { /* invalid log URL is reported below */ }
      const failures = [];
      for (const { route, url } of candidates) {
        try {
          const credentials = new URL(url).origin === pageWindow.location.origin ? 'same-origin' : 'omit';
          const response = await pageWindow.fetch(url, { credentials, cache: 'no-store' });
          if (!response.ok) {
            failures.push(`${route} HTTP ${response.status}`);
            continue;
          }
          const logContent = await response.text();
          const parsed = CompileAdapter.parseLogErrors(logContent);
          const reason = captureFreshnessReason(capture, maxAgeMs);
          return {
            ok: logContent.trim().length > 0,
            captureId: compiled.captureId,
            log: CompileAdapter.truncateLogForContext(logContent),
            errors: parsed.errors,
            warnings: parsed.warnings,
            compiledAt,
            fresh: !reason,
            reason: reason || (logContent.trim() ? '' : 'compile_log_empty')
          };
        } catch (_error) {
          failures.push(`${route} network error`);
        }
      }
      const reason = captureFreshnessReason(capture, maxAgeMs);
      return { ok: false, captureId: compiled.captureId, fresh: !reason,
        reason: reason || (failures.length ? `compile_log_fetch: ${failures.join('; ')}` : 'compile_log_url_invalid') };
    }

    function captureFreshnessReason(capture, maxAgeMs = COMPILE_LOG_MAX_AGE_MS) {
      if (!capture) return 'compile_capture_missing';
      if (!(capture.sourceChangeTimestamp >= state.lastKnownSourceEditTimestamp)) return 'compile_log_stale_source';
      if (!(Date.now() - capture.compiledAt <= maxAgeMs)) return 'compile_log_expired';
      return '';
    }

    function findEligibleCapture(sourceAtTrigger, afterCaptureId = 0) {
      return state.recentCompileCaptures.find(capture => capture.compile.captureId > afterCaptureId
        && capture.sourceChangeTimestamp >= sourceAtTrigger && !captureFreshnessReason(capture));
    }

    function getCompileState() {
      return {
        ok: true,
        hasCapturedTemplate: Boolean(state.capturedRequestTemplate),
        capturedTemplateAgeMs: state.capturedRequestTemplate?.capturedAt
          ? Date.now() - state.capturedRequestTemplate.capturedAt
          : null,
        lastCompileAt: state.lastCompileAt,
        lastCompileOk: state.lastCompileResponse?.ok || false,
        lastCompileSourceChangeTimestamp: state.lastCompileSourceChangeTimestamp,
        lastKnownSourceEditTimestamp: state.lastKnownSourceEditTimestamp
      };
    }

    function isFreshCapturedRequestTemplate(template) {
      return Boolean(template?.capturedAt && Date.now() - template.capturedAt <= COMPILE_TEMPLATE_TTL_MS);
    }

    function markSourceEdited(timestamp = Date.now()) {
      state.lastKnownSourceEditTimestamp = Math.max(timestamp, state.lastKnownSourceEditTimestamp + 1);
    }

    function markSourceEditFromInput(event) {
      const target = event.target;
      if (!target || target.closest?.('#codex-overleaf-panel')) {
        return;
      }
      if (!isLikelyEditorInputTarget(target)) {
        return;
      }
      const CompileAdapter = pageWindow.CodexOverleafCompileAdapter;
      if (!CompileAdapter?.isCompilableFile(deps.getActiveFilePath?.())) {
        return;
      }
      markSourceEdited();
    }

    function clickOverleafCompileButton(button) {
      if (!button || isCompileBusy(button)) return false;
      if (typeof button.click === 'function') {
        button.click();
        return true;
      }
      if (typeof button.dispatchEvent === 'function') {
        const EventCtor = pageWindow.MouseEvent || pageWindow.Event;
        if (EventCtor) {
          button.dispatchEvent(new EventCtor('click', { bubbles: true, cancelable: true }));
          return true;
        }
      }
      return false;
    }

    function findOverleafCompileButton() {
      if (typeof pageDocument.querySelectorAll !== 'function') return null;
      const nodes = Array.from(pageDocument.querySelectorAll('button, [role="button"]')).filter(isCompileControl);
      // Keep the main button selected while busy; never fall through to the
      // enabled split toggle, menu entries or another label containing "compile".
      return nodes.find(node => node.classList?.contains('compile-button'))
        || nodes.find(node => /^(?:recompile|compile|重新编译|编译)$/i.test(compileButtonLabel(node))) || null;
    }

    function isCompileControl(node) {
      const extensionRoot = node.closest?.('#codex-overleaf-panel, [data-codex-overleaf-root], [id^="codex-"], [class^="codex-"], [class*=" codex-"]');
      // The extension's mounted-state classes on html/body are not UI roots.
      if (extensionRoot && !['HTML', 'BODY'].includes(extensionRoot.tagName)) return false;
      if (node.closest?.('.compile-dropdown-toggle, #pdf-recompile-dropdown, .dropdown-menu, [role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [hidden], [inert], [aria-hidden="true"]')) return false;
      const popup = node.getAttribute?.('aria-haspopup');
      if ((popup && popup !== 'false') || node.getAttribute?.('data-toggle') === 'dropdown'
        || node.getAttribute?.('data-bs-toggle') === 'dropdown') return false;
      return !/^(?:stop\b|停止编译|终止编译)/i.test(compileButtonLabel(node));
    }

    function compileButtonLabel(node) {
      return [node?.textContent, node?.innerText, node?.getAttribute?.('aria-label'), node?.getAttribute?.('title')]
        .map(value => String(value || '').replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    }

    function isCompileBusy(button) {
      return state.inFlightCompileRequests.size > 0 || Boolean(button && (isDisabled(button)
        || /^(?:compiling|正在编译|编译中)\s*[.。…]*$/i.test(compileButtonLabel(button))));
    }

    function isDisabled(node) {
      return Boolean(node.disabled
        || node.getAttribute?.('disabled') != null
        || node.getAttribute?.('aria-disabled') === 'true');
    }

    async function waitForCapturedCompile(timeoutMs, sourceAtTrigger) {
      const deadline = Date.now() + timeoutMs;
      let clicked = false;
      while (true) {
        const capture = findEligibleCapture(sourceAtTrigger);
        if (capture) return { ok: true, compile: capture.compile, clicked };
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        if (!clicked) clicked = clickOverleafCompileButton(findOverleafCompileButton());
        await delay(Math.min(100, remainingMs));
      }
      return { ok: false, clicked, reason: clicked
        ? 'Clicked Overleaf Recompile, but no compile result was captured.' : 'compile_capture_missing' };
    }

    return {
      getCompileLog,
      getCompileState,
      install,
      markSourceEdited,
      state,
      triggerCompile
    };
  }

  function isLikelyEditorInputTarget(target) {
    return Boolean(target.matches?.('textarea, [contenteditable="true"], .cm-content, .CodeMirror-code')
      || target.closest?.('.cm-content, .CodeMirror-code, .cm-editor, .CodeMirror'));
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    COMPILE_TEMPLATE_TTL_MS,
    create,
    isLikelyEditorInputTarget
  };
});
