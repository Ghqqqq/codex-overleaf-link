(function initCodexOverleafRunQueueScheduler(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/runInputQueue'));
  } else {
    root.CodexOverleafModuleRegistry.define('RunQueueScheduler', ['RunInputQueue'], factory);
  }
})(typeof window !== 'undefined' ? window : globalThis, function runQueueSchedulerFactory(Queue) {
  'use strict';

  function create(options = {}) {
    let scheduling = false;

    function dequeue(queue, itemId, context = {}) {
      const item = itemId ? queue.find(entry => entry.id === itemId) : null;
      if (item) {
        options.onDequeued?.(item, context);
      }
      return itemId ? Queue.remove(queue, itemId) : queue;
    }

    async function afterSettlement({ sessionId, status, queueItemId = '', continueQueue = false } = {}) {
      const originalQueue = options.getQueue?.(sessionId) || [];
      const shouldContinue = status === 'completed' || continueQueue;
      const shouldRemove = Boolean(queueItemId && shouldContinue);
      const claimedItem = shouldRemove
        ? originalQueue.find(item => item?.id === queueItemId)
        : null;
      if (shouldRemove) {
        await options.persist?.({
          queueMutation: {
            type: 'remove',
            sessionId,
            itemId: queueItemId,
            claimToken: claimedItem?.claimToken
          }
        });
        const latestQueue = options.getQueue?.(sessionId) || originalQueue;
        options.setQueue?.(
          sessionId,
          dequeue(latestQueue, queueItemId, {
            sessionId,
            reason: status === 'completed' ? 'completed' : 'continue_queue'
          })
        );
      }
      const canStart = shouldContinue ? options.canStart?.(sessionId) : true;
      const latestQueue = options.getQueue?.(sessionId) || originalQueue;
      const inactive = shouldContinue && canStart !== 'session_transition'
        && (canStart === false || options.isRunning?.())
        && latestQueue.some(item => item?.status === 'queued');
      if (!shouldContinue || inactive) {
        const reason = inactive ? 'session_inactive' : status || 'run_did_not_complete';
        const paused = latestQueue.length ? Queue.pauseAll(latestQueue, reason) : latestQueue;
        options.setQueue?.(sessionId, paused);
        try {
          await options.persist?.({
            queueMutation: { type: 'transition', sessionId }
          });
        } catch (error) {
          const latestQueue = options.getQueue?.(sessionId) || paused;
          options.setQueue?.(
            sessionId,
            Queue.pauseAll(latestQueue, reason)
          );
          throw error;
        }
      }
      options.onChange?.(sessionId);
      if (shouldContinue && !inactive) {
        scheduleOne(sessionId);
      }
    }

    function scheduleOne(sessionId) {
      if (scheduling || options.isRunning?.()) {
        return false;
      }
      const canStart = options.canStart?.(sessionId);
      if (canStart === false || canStart === 'session_transition') {
        return false;
      }
      const initialQueue = options.getQueue?.(sessionId) || [];
      if (!initialQueue.some(item => item?.status === 'queued')) {
        return false;
      }
      scheduling = true;
      let claimed = null;
      Promise.resolve(options.prepareClaim?.(sessionId))
        .then(() => {
          claimed = Queue.claimNext(options.getQueue?.(sessionId) || initialQueue, {
            randomUUID: options.randomUUID,
            resolveExecutionSnapshot: options.resolveExecutionSnapshot
          });
          if (!claimed.ok) {
            const error = new Error(claimed.error?.message || claimed.error?.code || 'queue_claim_failed');
            error.code = claimed.error?.code || 'queue_claim_failed';
            throw error;
          }
          options.setQueue?.(sessionId, claimed.queue);
          return options.persist?.({
            queueMutation: {
              type: 'claim',
              sessionId,
              itemId: claimed.item.id,
              claimToken: claimed.item.claimToken
            }
          });
        })
        .then(() => {
          options.onChange?.(sessionId);
          scheduling = false;
          return options.start?.(claimed.item, sessionId);
        })
        .catch(error => {
          scheduling = false;
          const paused = Queue.pauseAll(
            options.getQueue?.(sessionId) || claimed?.queue || initialQueue,
            error?.code || 'start_failed'
          );
          options.setQueue?.(sessionId, paused);
          options.onChange?.(sessionId);
          return Promise.resolve(options.persist?.({
            queueMutation: claimed?.item?.id
              ? {
                type: 'release',
                sessionId,
                itemId: claimed.item.id,
                claimToken: claimed.item.claimToken
              }
              : { type: 'transition', sessionId }
          })).catch(() => undefined);
        });
      return true;
    }

    async function markExecuting(sessionId, itemId, _runId) {
      const queue = options.getQueue?.(sessionId) || [];
      const item = queue.find(entry => entry?.id === itemId);
      try {
        await options.persist?.({
          queueMutation: { type: 'remove', sessionId, itemId, claimToken: item?.claimToken }
        });
      } catch (error) {
        const latestQueue = options.getQueue?.(sessionId) || queue;
        options.setQueue?.(
          sessionId,
          Queue.pauseAll(latestQueue, error?.code || 'queue_promotion_persistence_failed')
        );
        options.onChange?.(sessionId);
        try {
          await options.persist?.({
            queueMutation: { type: 'restore', sessionId, itemId, claimToken: item?.claimToken }
          });
        } catch (recoveryError) {
          if (error && typeof error === 'object') {
            error.persistenceRecoveryError = recoveryError?.message || String(recoveryError);
          }
        }
        throw error;
      }
      const latestQueue = options.getQueue?.(sessionId) || queue;
      options.setQueue?.(
        sessionId,
        dequeue(latestQueue, itemId, { sessionId, runId: _runId, reason: 'executing' })
      );
      options.onChange?.(sessionId);
    }

    async function resume(sessionId) {
      options.setQueue?.(sessionId, Queue.resumeAll(options.getQueue?.(sessionId) || []));
      await options.persist?.({
        queueMutation: { type: 'transition', sessionId }
      });
      options.onChange?.(sessionId);
      scheduleOne(sessionId);
    }

    return { afterSettlement, markExecuting, resume, scheduleOne };
  }

  function createCoordinator(options = {}) {
    let view = null;
    const guidanceAttempts = new Map();
    const guidanceKey = (sessionId, itemId) => JSON.stringify([sessionId, itemId]);
    const matchesGuidanceItem = (item, identity) => item?.id === identity.itemId
      && item.createdAt === identity.itemCreatedAt && item.text === identity.text
      && item.clientUserMessageId === identity.clientUserMessageId;
    const matchesGuidanceScope = expected => {
      const scope = options.getGuideScope?.();
      return !expected || ['projectId', 'accountScopeId', 'generation'].every(key => scope?.[key] === expected[key]);
    };
    const guideErrorKeys = {
      codex_turn_not_ready: 'queuedInputGuideNotReady',
      codex_turn_mismatch: 'queuedInputGuideTurnChanged',
      codex_steer_empty: 'queuedInputGuideEmpty',
      codex_steer_too_large: 'queuedInputGuideTooLarge'
    };
    function formatGuideError(error) {
      const key = guideErrorKeys[error?.code];
      return (key && options.tr?.(key)) || error?.message || options.tr?.('queuedInputGuideFailed');
    }
    const scheduler = create({
      getQueue: sessionId => options.getSession?.(sessionId)?.pendingInputs || [],
      setQueue: (sessionId, pendingInputs) => options.setQueue?.(sessionId, pendingInputs),
      persist: persistenceOptions => options.save?.(persistenceOptions),
      isRunning: () => Boolean(options.getCurrentRun?.()),
      canStart: sessionId => options.canStart?.(sessionId),
      start: (item, sessionId) => startQueuedInput(item, sessionId),
      onChange: () => render(),
      onDequeued: (item, context) => options.removeGuidance?.(item.id, {
        sessionId: context.sessionId,
        recordId: item.sourceRunId || ''
      }),
      prepareClaim: options.prepareClaim,
      resolveExecutionSnapshot: options.resolveExecutionSnapshot,
      randomUUID: options.randomUUID
    });

    function queueComposerInput() {
      options.readInputs?.();
      const text = String(options.getTask?.() || '').trim();
      if (!text) {
        return;
      }
      if (options.hasAttachments?.()) {
        options.toast?.(options.tr?.('queuedInputAttachmentsUnsupported'), 'warning');
        return;
      }
      const session = options.getActiveSession?.();
      const result = Queue.enqueue(session?.pendingInputs || [], {
        text,
        sourceRunId: options.getCurrentRun?.()?.recordId || '',
        payload: options.capturePayload?.() || {}
      }, {
        randomUUID: options.randomUUID
      });
      if (!result.ok) {
        options.toast?.(options.tr?.('queuedInputError_' + (result.error?.code || 'queue_full')), 'warning');
        return;
      }
      options.setQueue?.(session.id, result.queue);
      // A queued follow-up has not reached the active model turn yet. Keep it
      // exclusively in the queue UI until the user explicitly guides the
      // active turn, or until the scheduler promotes it to the next run.
      options.clearTask?.();
      render();
      options.saveSoon?.({
        queueMutation: { type: 'enqueue', sessionId: session.id, itemId: result.item.id }
      });
    }

    async function guide(itemId) {
      const session = options.getActiveSession?.();
      const item = (session?.pendingInputs || []).find(entry => entry.id === itemId);
      const run = options.getCurrentRun?.();
      const binding = run?.activeTurn;
      const initialScope = options.getGuideScope?.();
      const guideScope = initialScope ? { ...initialScope } : null;
      if (!session || !item || item.status !== 'queued' || !run || run.sessionId !== session.id || !binding?.threadId || !binding?.turnId) {
        options.toast?.(options.tr?.('queuedInputGuideUnavailable'), 'warning');
        return;
      }
      const identity = { requestId: run.nativeRequestId, threadId: binding.threadId, turnId: binding.turnId,
        projectKey: run.runProjectId, recordId: run.recordId, sessionId: session.id, sessionCreatedAt: session.createdAt,
        itemId, itemCreatedAt: item.createdAt, text: item.text, clientUserMessageId: item.clientUserMessageId };
      const attemptKey = guidanceKey(identity.sessionId, itemId);
      const attempt = { identity, scope: guideScope, previewToken: null };
      const sameScope = () => matchesGuidanceScope(guideScope);
      const ownedSession = () => {
        const latest = options.getSession?.(identity.sessionId);
        return sameScope() && latest?.createdAt === identity.sessionCreatedAt ? latest : null;
      };
      const ownedItemSession = (allowPaused = false) => {
        const latest = ownedSession();
        const current = latest?.pendingInputs?.find(entry => entry.id === itemId);
        return guidanceAttempts.get(attemptKey) === attempt
          && (current?.status === 'steering' || (allowPaused && current?.status === 'paused'))
          && matchesGuidanceItem(current, identity) ? latest : null;
      };
      function clearPreview() {
        const token = attempt.previewToken;
        attempt.previewToken = null;
        if (token) options.clearGuidancePreview?.(token);
      }
      const assertCurrent = () => {
        const currentRun = options.getCurrentRun?.();
        if (options.isGuideCancelled?.() || currentRun !== run || options.getActiveSession?.()?.id !== identity.sessionId
          || currentRun?.nativeRequestId !== identity.requestId
          || currentRun?.recordId !== identity.recordId || currentRun?.runProjectId !== identity.projectKey
          || currentRun?.activeTurn?.threadId !== identity.threadId || currentRun?.activeTurn?.turnId !== identity.turnId
          || !ownedItemSession()) {
          throw Object.assign(new Error(options.tr?.('queuedInputGuideUnavailable') || 'Guidance is no longer available for this turn.'), { code: 'codex_turn_mismatch' });
        }
      };
      async function restoreUnsent(error) {
        // No steer was dispatched. Restore only this attempt's still-owned item;
        // a concurrent removal, replacement or scope switch must stay untouched.
        clearPreview();
        const latest = ownedItemSession();
        if (latest) {
          options.setQueue?.(identity.sessionId, Queue.returnToQueue(latest.pendingInputs, itemId));
          render();
          try {
            await options.save?.({ queueMutation: { type: 'transition', sessionId: identity.sessionId, itemId } });
          } catch (recoveryError) {
            if (error && typeof error === 'object') error.persistenceRecoveryError = recoveryError?.message || String(recoveryError);
          }
        }
      }
      options.setQueue?.(session.id, Queue.markSteering(session.pendingInputs, itemId));
      guidanceAttempts.set(attemptKey, attempt);
      try {
        try {
          attempt.previewToken = options.previewGuidance?.(identity.text, {
            guidanceId: itemId, sessionId: identity.sessionId, recordId: identity.recordId,
            sessionCreatedAt: identity.sessionCreatedAt
          });
          render();
          const preflight = await options.preflightGuide?.({ task: identity.text, assertCurrent });
          assertCurrent();
          if (preflight?.blocked) throw Object.assign(new Error('Guidance was blocked before dispatch.'), { guidanceBlocked: true });
          await options.save?.({
            queueMutation: { type: 'transition', sessionId: identity.sessionId, itemId }
          });
          assertCurrent();
        } catch (error) {
          await restoreUnsent(error);
          if (error?.guidanceBlocked) return { ok: false, blocked: true };
          throw error;
        }
        let response;
        try {
          response = await options.sendSteer?.({
            requestId: identity.requestId,
            projectKey: identity.projectKey,
            threadId: identity.threadId,
            expectedTurnId: identity.turnId,
            clientUserMessageId: identity.clientUserMessageId,
            input: [{ type: 'text', text: identity.text }]
          }, { assertCurrent });
        } catch (error) {
          if (error?.requestDispatched === false) { await restoreUnsent(error); throw error; }
          clearPreview();
          const latest = ownedItemSession(true);
          if (latest) {
            const paused = latest.pendingInputs.map(entry => entry.id === itemId
              ? { ...entry, status: 'paused', pauseReason: 'steer_delivery_unknown' }
              : entry);
            options.setQueue?.(identity.sessionId, Queue.normalizeQueue(paused));
          }
          options.toast?.(formatGuideError(error), 'warning');
          render();
          if (latest) await options.save?.({
            queueMutation: { type: 'transition', sessionId: identity.sessionId, itemId }
          });
          return;
        }
        // Cancellation can pause the owned row while a dispatched steer is
        // awaiting acknowledgement. A confirmed receipt also consumes that
        // paused copy, so Resume cannot send an already accepted input again.
        const latest = ownedItemSession(Boolean(response?.ok));
        if (latest) options.setQueue?.(
          identity.sessionId,
          response?.ok ? Queue.remove(latest.pendingInputs, itemId)
            : Queue.returnToQueue(latest.pendingInputs, itemId, response?.error?.code || 'steer_failed')
        );
        if (response?.ok) {
          if (ownedSession() && typeof options.appendGuidance === 'function') {
            options.appendGuidance(identity.text, {
              guidanceId: itemId, sessionId: identity.sessionId, recordId: identity.recordId,
              sessionCreatedAt: identity.sessionCreatedAt, status: 'completed',
              timestamp: attempt.previewToken?.event?.timestamp
            });
          } else if (ownedSession() && options.getCurrentRun?.() === run) {
            options.appendEvent?.(options.tr?.('queuedInputGuided'), 'completed');
          }
        } else {
          options.toast?.(formatGuideError(response?.error), 'warning');
        }
        clearPreview();
        render();
        // A Native acknowledgement is final delivery evidence. A later local
        // save failure must not turn it into an unknown delivery or resend it.
        if (latest) await options.save?.({
          queueMutation: response?.ok
            ? { type: 'remove', sessionId: identity.sessionId, itemId }
            : { type: 'transition', sessionId: identity.sessionId, itemId }
        });
        else if (response?.ok && ownedSession()) await options.save?.();
      } finally {
        clearPreview();
        if (guidanceAttempts.get(attemptKey) === attempt) guidanceAttempts.delete(attemptKey);
        render();
      }
    }

    function remove(itemId) {
      const session = options.getActiveSession?.();
      if (!session) {
        return;
      }
      const item = (session.pendingInputs || []).find(entry => entry.id === itemId);
      if (item) {
        options.removeGuidance?.(item.id, {
          sessionId: session.id,
          recordId: item.sourceRunId || ''
        });
      }
      options.setQueue?.(session.id, Queue.remove(session.pendingInputs || [], itemId));
      render();
      options.saveSoon?.({
        queueMutation: { type: 'remove', sessionId: session.id, itemId }
      });
    }

    function resume() {
      const session = options.getActiveSession?.();
      if (session) {
        scheduler.resume(session.id).catch(error => options.toast?.(error.message, 'warning'));
      }
    }

    function render() {
      const container = options.getContainer?.();
      if (!container) {
        return;
      }
      if (!view || view.container !== container) {
        view = options.createView?.({
          container,
          tr: options.tr,
          onGuide: itemId => guide(itemId).catch(error => options.toast?.(formatGuideError(error), 'warning')),
          onRemove: remove,
          onResume: resume,
          onToast: message => options.toast?.(message, 'warning')
        });
        if (view) {
          view.container = container;
        }
      }
      const session = options.getActiveSession?.();
      const run = options.getCurrentRun?.();
      const visibleQueue = (session?.pendingInputs || []).filter(item => {
        const attempt = guidanceAttempts.get(guidanceKey(session.id, item.id));
        return !attempt?.previewToken || !['steering', 'paused'].includes(item.status)
          || !matchesGuidanceScope(attempt.scope)
          || session.createdAt !== attempt.identity.sessionCreatedAt || !matchesGuidanceItem(item, attempt.identity);
      });
      view?.render?.(visibleQueue, {
        running: Boolean(run),
        canGuide: Boolean(run?.activeTurn?.turnId)
      });
    }

    async function startQueuedInput(item, sessionId) {
      const assertCanStart = () => {
        const canStart = options.canStart?.(sessionId);
        if (canStart === false || canStart === 'session_transition' || options.getCurrentRun?.()) {
          const error = new Error('Queued input cannot start in the current session.');
          error.code = 'queue_session_not_active';
          throw error;
        }
      };
      assertCanStart();
      await options.applyQueuedInput?.(item);
      assertCanStart();
      await options.run?.(item);
    }

    return {
      guide,
      queueComposerInput,
      remove,
      render,
      resume,
      scheduler
    };
  }

  return { create, createCoordinator };
});
