(function initCodexOverleafRunInputQueue(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CodexOverleafRunInputQueue = factory();
  }
})(typeof window !== 'undefined' ? window : globalThis, function runInputQueueFactory() {
  'use strict';

  const MAX_ITEMS = 20;
  const MAX_TEXT_CHARS = 12000;
  const MAX_QUEUE_BYTES = 128 * 1024;
  const ACTIVE_STATUSES = new Set(['claimed', 'executing', 'steering']);
  const VALID_STATUSES = new Set(['queued', 'paused', ...ACTIVE_STATUSES]);

  function normalizeQueue(items, options = {}) {
    const seen = new Set();
    const normalized = [];
    for (const raw of Array.isArray(items) ? items : []) {
      const text = String(raw?.text || '').trim().slice(0, MAX_TEXT_CHARS);
      const id = String(raw?.id || '').trim();
      if (!id || !text || seen.has(id)) {
        continue;
      }
      seen.add(id);
      let status = VALID_STATUSES.has(raw.status) ? raw.status : 'queued';
      if (options.recoverActive === true && ACTIVE_STATUSES.has(status)) {
        status = 'paused';
      }
      normalized.push({
        id,
        clientUserMessageId: String(raw.clientUserMessageId || id),
        text,
        status,
        createdAt: normalizeTimestamp(raw.createdAt),
        updatedAt: normalizeTimestamp(raw.updatedAt),
        sourceRunId: String(raw.sourceRunId || ''),
        linkedRunId: status === 'executing' ? String(raw.linkedRunId || '') : '',
        claimToken: status === 'claimed' || status === 'executing' ? String(raw.claimToken || '') : '',
        pauseReason: status === 'paused' ? String(raw.pauseReason || '') : '',
        payload: normalizePayload(raw.payload)
      });
      if (normalized.length >= MAX_ITEMS) {
        break;
      }
    }
    return trimToBudget(normalized);
  }

  function enqueue(items, input = {}, deps = {}) {
    const queue = normalizeQueue(items);
    const text = String(input.text || '').trim();
    if (!text) {
      return failure(queue, 'empty_input');
    }
    if (text.length > MAX_TEXT_CHARS) {
      return failure(queue, 'input_too_long');
    }
    if (queue.length >= MAX_ITEMS) {
      return failure(queue, 'queue_full');
    }
    const idFactory = deps.randomUUID || (() => 'pending_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
    const nowFactory = deps.now || (() => new Date().toISOString());
    const id = String(input.id || idFactory());
    const timestamp = String(nowFactory());
    const item = {
      id,
      clientUserMessageId: String(input.clientUserMessageId || id),
      text,
      status: input.status === 'paused' ? 'paused' : 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRunId: String(input.sourceRunId || ''),
      linkedRunId: '',
      claimToken: '',
      pauseReason: input.status === 'paused' ? String(input.pauseReason || '') : '',
      payload: normalizePayload(input.payload)
    };
    const next = [...queue, item];
    if (estimateBytes(next) > MAX_QUEUE_BYTES) {
      return failure(queue, 'queue_too_large');
    }
    return { ok: true, queue: next, item };
  }

  function remove(items, id) {
    return normalizeQueue(items).filter(item => item.id !== id);
  }

  function markSteering(items, id) {
    return update(items, id, item => ({
      ...item,
      status: 'steering',
      updatedAt: new Date().toISOString(),
      pauseReason: ''
    }));
  }

  function returnToQueue(items, id, reason = '') {
    return update(items, id, item => ({
      ...item,
      status: 'queued',
      updatedAt: new Date().toISOString(),
      linkedRunId: '',
      claimToken: '',
      pauseReason: String(reason || '')
    }));
  }

  function claimNext(items, deps = {}) {
    const queue = normalizeQueue(items);
    const index = queue.findIndex(item => item.status === 'queued');
    if (index < 0) {
      return { ok: false, queue, item: null };
    }
    const tokenFactory = deps.randomUUID || (() => 'claim_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
    const item = {
      ...queue[index],
      status: 'claimed',
      claimToken: String(tokenFactory()),
      updatedAt: new Date().toISOString(),
      pauseReason: ''
    };
    queue[index] = item;
    return { ok: true, queue, item };
  }

  function markExecuting(items, id, linkedRunId) {
    return update(items, id, item => ({
      ...item,
      status: 'executing',
      linkedRunId: String(linkedRunId || ''),
      updatedAt: new Date().toISOString()
    }));
  }

  function pauseAll(items, reason = '') {
    return normalizeQueue(items).map(item => ({
      ...item,
      status: 'paused',
      linkedRunId: '',
      claimToken: '',
      pauseReason: String(reason || ''),
      updatedAt: new Date().toISOString()
    }));
  }

  function resumeAll(items) {
    return normalizeQueue(items).map(item => ({
      ...item,
      status: 'queued',
      linkedRunId: '',
      claimToken: '',
      pauseReason: '',
      updatedAt: new Date().toISOString()
    }));
  }

  function update(items, id, updater) {
    return normalizeQueue(items).map(item => item.id === id ? updater(item) : item);
  }

  function normalizePayload(payload = {}) {
    return {
      mode: ['ask', 'confirm', 'auto'].includes(payload.mode) ? payload.mode : 'ask',
      providerId: String(payload.providerId || 'builtin').slice(0, 160),
      providerRevision: String(payload.providerRevision || '').slice(0, 160),
      model: String(payload.model || '').slice(0, 160),
      reasoningEffort: String(payload.reasoningEffort || '').slice(0, 32),
      speedTier: payload.speedTier === 'fast' ? 'fast' : 'standard',
      autoRecompile: payload.autoRecompile !== false,
      requireReviewing: payload.requireReviewing !== false,
      focusFiles: (Array.isArray(payload.focusFiles) ? payload.focusFiles : [])
        .map(path => String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
        .filter(Boolean)
        .slice(0, 100)
    };
  }

  function normalizeTimestamp(value) {
    return typeof value === 'string' && value ? value : new Date().toISOString();
  }

  function trimToBudget(items) {
    const queue = items.slice(-MAX_ITEMS);
    while (queue.length && estimateBytes(queue) > MAX_QUEUE_BYTES) {
      queue.shift();
    }
    return queue;
  }

  function estimateBytes(value) {
    const text = JSON.stringify(value);
    return typeof TextEncoder !== 'undefined'
      ? new TextEncoder().encode(text).length
      : text.length * 2;
  }

  function compactForStorage(items, helpers = {}) {
    const normalizeField = helpers.normalizeField || (value => String(value || ''));
    const normalizeDisplay = helpers.normalizeDisplay || normalizeField;
    const normalizePaths = helpers.normalizePaths || (value => normalizePayload({ focusFiles: value }).focusFiles);
    return (Array.isArray(items) ? items : [])
      .slice(-MAX_ITEMS)
      .map(item => {
        const payload = item?.payload && typeof item.payload === 'object' ? item.payload : {};
        return {
          id: normalizeField(item?.id, 160),
          clientUserMessageId: normalizeField(item?.clientUserMessageId, 160),
          text: normalizeDisplay(item?.text, MAX_TEXT_CHARS),
          status: VALID_STATUSES.has(item?.status) ? item.status : 'queued',
          createdAt: typeof item?.createdAt === 'string' ? item.createdAt : '',
          updatedAt: typeof item?.updatedAt === 'string' ? item.updatedAt : '',
          sourceRunId: normalizeField(item?.sourceRunId, 160),
          linkedRunId: normalizeField(item?.linkedRunId, 160),
          claimToken: normalizeField(item?.claimToken, 160),
          pauseReason: normalizeField(item?.pauseReason, 160),
          payload: {
            mode: typeof payload.mode === 'string' ? payload.mode : 'ask',
            providerId: normalizeField(payload.providerId, 160) || 'builtin',
            providerRevision: normalizeField(payload.providerRevision, 160),
            model: normalizeField(payload.model, 160),
            reasoningEffort: normalizeField(payload.reasoningEffort, 32),
            speedTier: payload.speedTier === 'fast' ? 'fast' : 'standard',
            autoRecompile: payload.autoRecompile !== false,
            requireReviewing: payload.requireReviewing !== false,
            focusFiles: normalizePaths(payload.focusFiles)
          }
        };
      })
      .filter(item => item.id && item.text);
  }

  function failure(queue, code) {
    return { ok: false, queue, item: null, error: { code } };
  }

  return {
    MAX_ITEMS,
    MAX_QUEUE_BYTES,
    MAX_TEXT_CHARS,
    claimNext,
    compactForStorage,
    enqueue,
    markExecuting,
    markSteering,
    normalizeQueue,
    pauseAll,
    remove,
    resumeAll,
    returnToQueue
  };
});
