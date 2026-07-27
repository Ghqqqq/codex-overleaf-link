(function initCodexOverleafRunQueueScheduler(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/runInputQueue'));
  } else {
    root.CodexOverleafRunQueueScheduler = factory(root.CodexOverleafRunInputQueue);
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
      const shouldRemove = Boolean(queueItemId && (status === 'completed' || continueQueue));
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
      } else {
        const paused = originalQueue.length
          ? Queue.pauseAll(originalQueue, status || 'run_did_not_complete')
          : originalQueue;
        options.setQueue?.(sessionId, paused);
        try {
          await options.persist?.({
            queueMutation: { type: 'transition', sessionId }
          });
        } catch (error) {
          const latestQueue = options.getQueue?.(sessionId) || paused;
          options.setQueue?.(
            sessionId,
            Queue.pauseAll(latestQueue, status || 'run_did_not_complete')
          );
          throw error;
        }
      }
      options.onChange?.(sessionId);
      if (status === 'completed' || continueQueue) {
        scheduleOne(sessionId);
      }
    }

    function scheduleOne(sessionId) {
      if (scheduling || options.isRunning?.() || options.canStart?.(sessionId) === false) {
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
    const scheduler = create({
      getQueue: sessionId => options.getSession?.(sessionId)?.pendingInputs || [],
      setQueue: (sessionId, pendingInputs) => options.setQueue?.(sessionId, pendingInputs),
      persist: persistenceOptions => options.save?.(persistenceOptions),
      isRunning: () => Boolean(options.getCurrentRun?.()),
      canStart: sessionId => options.canStart?.(sessionId) !== false,
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
      if (!session || !item || !run || run.sessionId !== session.id || !binding?.threadId || !binding?.turnId) {
        options.toast?.(options.tr?.('queuedInputGuideUnavailable'), 'warning');
        return;
      }
      options.setQueue?.(session.id, Queue.markSteering(session.pendingInputs, itemId));
      render();
      await options.save?.({
        queueMutation: { type: 'transition', sessionId: session.id, itemId }
      });
      try {
        const response = await options.sendSteer?.({
          requestId: run.nativeRequestId,
          projectKey: run.runProjectId,
          threadId: binding.threadId,
          expectedTurnId: binding.turnId,
          clientUserMessageId: item.clientUserMessageId,
          input: [{ type: 'text', text: item.text }]
        });
        const latest = options.getSession?.(session.id);
        options.setQueue?.(
          session.id,
          response?.ok
            ? Queue.remove(latest?.pendingInputs || [], itemId)
            : Queue.returnToQueue(latest?.pendingInputs || [], itemId, response?.error?.code || 'steer_failed')
        );
        if (response?.ok) {
          if (typeof options.appendGuidance === 'function') {
            options.appendGuidance(item.text, {
              guidanceId: item.id,
              sessionId: session.id,
              recordId: run.recordId,
              status: 'completed'
            });
          } else {
            options.appendEvent?.(options.tr?.('queuedInputGuided'), 'completed');
          }
        } else {
          options.toast?.(response?.error?.message || options.tr?.('queuedInputGuideFailed'), 'warning');
        }
        render();
        await options.save?.({
          queueMutation: response?.ok
            ? { type: 'remove', sessionId: session.id, itemId }
            : { type: 'transition', sessionId: session.id, itemId }
        });
      } catch (error) {
        const latest = options.getSession?.(session.id);
        const paused = (latest?.pendingInputs || []).map(entry => entry.id === itemId
          ? { ...entry, status: 'paused', pauseReason: 'steer_delivery_unknown' }
          : entry);
        options.setQueue?.(session.id, Queue.normalizeQueue(paused));
        options.toast?.(error?.message || options.tr?.('queuedInputGuideFailed'), 'warning');
        render();
        await options.save?.({
          queueMutation: { type: 'transition', sessionId: session.id, itemId }
        });
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
          onGuide: itemId => guide(itemId).catch(error => options.toast?.(error.message, 'warning')),
          onRemove: remove,
          onResume: resume
        });
        if (view) {
          view.container = container;
        }
      }
      const session = options.getActiveSession?.();
      const run = options.getCurrentRun?.();
      view?.render?.(session?.pendingInputs || [], {
        running: Boolean(run),
        canGuide: Boolean(run?.activeTurn?.turnId)
      });
    }

    async function startQueuedInput(item, sessionId) {
      if (options.canStart?.(sessionId) === false || options.getCurrentRun?.()) {
        const error = new Error('Queued input cannot start in the current session.');
        error.code = 'queue_session_not_active';
        throw error;
      }
      await options.applyQueuedInput?.(item);
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
