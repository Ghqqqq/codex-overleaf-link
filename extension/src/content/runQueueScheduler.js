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
      let queue = options.getQueue?.(sessionId) || [];
      if (status === 'completed') {
        queue = dequeue(queue, queueItemId, { sessionId, reason: 'completed' });
      } else if (continueQueue) {
        queue = dequeue(queue, queueItemId, { sessionId, reason: 'continue_queue' });
      } else if (queue.length) {
        queue = Queue.pauseAll(queue, status || 'run_did_not_complete');
      }
      options.setQueue?.(sessionId, queue);
      await options.persist?.();
      options.onChange?.(sessionId);
      if (status === 'completed' || continueQueue) {
        scheduleOne(sessionId);
      }
    }

    function scheduleOne(sessionId) {
      if (scheduling || options.isRunning?.() || options.canStart?.(sessionId) === false) {
        return false;
      }
      const claimed = Queue.claimNext(options.getQueue?.(sessionId) || [], {
        randomUUID: options.randomUUID
      });
      if (!claimed.ok) {
        return false;
      }
      scheduling = true;
      options.setQueue?.(sessionId, claimed.queue);
      Promise.resolve(options.persist?.())
        .then(() => {
          options.onChange?.(sessionId);
          scheduling = false;
          return options.start?.(claimed.item, sessionId);
        })
        .catch(error => {
          scheduling = false;
          const paused = Queue.pauseAll(options.getQueue?.(sessionId) || claimed.queue, error?.code || 'start_failed');
          options.setQueue?.(sessionId, paused);
          options.onChange?.(sessionId);
          return options.persist?.();
        });
      return true;
    }

    async function markExecuting(sessionId, itemId, _runId) {
      const queue = options.getQueue?.(sessionId) || [];
      options.setQueue?.(
        sessionId,
        dequeue(queue, itemId, { sessionId, runId: _runId, reason: 'executing' })
      );
      await options.persist?.();
      options.onChange?.(sessionId);
    }

    async function resume(sessionId) {
      options.setQueue?.(sessionId, Queue.resumeAll(options.getQueue?.(sessionId) || []));
      await options.persist?.();
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
      persist: () => options.save?.(),
      isRunning: () => Boolean(options.getCurrentRun?.()),
      canStart: sessionId => options.canStart?.(sessionId) !== false,
      start: (item, sessionId) => startQueuedInput(item, sessionId),
      onChange: () => render(),
      onDequeued: (item, context) => options.removeGuidance?.(item.id, {
        sessionId: context.sessionId,
        recordId: item.sourceRunId || ''
      }),
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
      options.saveSoon?.();
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
      await options.save?.();
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
        await options.save?.();
      } catch (error) {
        const latest = options.getSession?.(session.id);
        const paused = (latest?.pendingInputs || []).map(entry => entry.id === itemId
          ? { ...entry, status: 'paused', pauseReason: 'steer_delivery_unknown' }
          : entry);
        options.setQueue?.(session.id, Queue.normalizeQueue(paused));
        options.toast?.(error?.message || options.tr?.('queuedInputGuideFailed'), 'warning');
        render();
        await options.save?.();
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
      options.saveSoon?.();
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
      options.applyQueuedInput?.(item);
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
